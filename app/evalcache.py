"""DynamoDB-backed EvaluationDataStore: reuse agent outputs, re-run only the judge.

The expensive half of an evaluation is producing the agent's output (real
invoke_agent_runtime calls, or a CloudWatch trace pull). Scoring it is cheap by
comparison. Strands Evals' Experiment accepts an EvaluationDataStore
(load/save by case name) and short-circuits task execution on a cache hit, so
tweaking a rubric or swapping evaluators re-judges the *same* recorded outputs
instead of re-invoking the agent.

Key schema:
  pk="EVALCACHE/<scope>", sk=<case_name>  -> data = EvaluationData JSON

<scope> namespaces a cache so unrelated runs never collide: observability mode
uses the agent name, dataset mode uses "<dataset>@<agent>", red teaming uses
"rt/<agent>". Case names must be unique within a scope — Experiment enforces
non-None unique names as soon as a store is passed.

Cached rows carry a TTL attribute (expires_at); enable TTL on the table to have
DynamoDB reap them. Reads tolerate rows written by an older EvaluationData
schema by treating a validation failure as a miss.
"""

import logging
import time

from strands_evals.types.evaluation import EvaluationData

import catalog

logger = logging.getLogger("eval-anything")

TTL_DAYS = 30
MAX_ITEM_BYTES = 380 * 1024  # DynamoDB item limit is 400KB; leave room for keys


class DynamoEvaluationDataStore:
    """EvaluationDataStore over the shared catalog table.

    Implements the strands_evals EvaluationDataStore Protocol (load/save).
    read_only=True serves hits but never writes — used when the caller wants to
    consume a previous recording without overwriting it.

    `validate(EvaluationData) -> str | None` lets a caller reject recordings that
    exist but can never produce a verdict (see redteam._unjudgeable). It runs on
    both sides on purpose: on save so the bad row never lands, and on load so
    rows written before the check existed stop being replayed forever.
    """

    def __init__(self, scope: str, *, read_only: bool = False, enabled: bool = True,
                 validate=None):
        self.scope = scope
        self.read_only = read_only
        self.enabled = enabled and bool(catalog.TABLE_NAME)
        self.validate = validate
        self.hits: list[str] = []
        self.misses: list[str] = []
        # rows refused by `validate`: on the way in (skipped) / on the way out
        # (rejected). Both are reported so a run never silently caches or
        # replays something that cannot be judged.
        self.skipped: list[dict] = []
        self.rejected: list[dict] = []

    @property
    def pk(self) -> str:
        return f"EVALCACHE/{self.scope}"

    def load(self, case_name: str) -> EvaluationData | None:
        if not self.enabled:
            return None
        try:
            item = catalog.get_table().get_item(
                Key={"pk": self.pk, "sk": case_name}
            ).get("Item")
        except Exception:
            logger.exception("eval cache read failed: %s/%s", self.scope, case_name)
            return None
        if not item:
            self.misses.append(case_name)
            return None
        try:
            data = EvaluationData.model_validate_json(item["data"])
        except Exception:
            # schema drift or truncated row: treat as a miss and let it be rewritten
            logger.warning("eval cache row unusable, re-running: %s/%s", self.scope, case_name)
            self.misses.append(case_name)
            return None
        if self.validate is not None:
            why = self.validate(data)
            if why:
                # A row that can't be judged is worse than no row: it makes every
                # later run replay the non-verdict while telling the user to
                # re-run. Drop it and treat this as a miss so the agent is called.
                logger.warning("eval cache row rejected (%s), re-running: %s/%s",
                               why, self.scope, case_name)
                self.rejected.append({"case": case_name, "reason": why})
                if not self.read_only:
                    self._delete(case_name)
                self.misses.append(case_name)
                return None
        self.hits.append(case_name)
        return data

    def _delete(self, case_name: str) -> None:
        try:
            catalog.get_table().delete_item(Key={"pk": self.pk, "sk": case_name})
        except Exception:
            logger.exception("eval cache delete failed: %s/%s", self.scope, case_name)

    def save(self, case_name: str, result: EvaluationData) -> None:
        if not self.enabled or self.read_only:
            return
        if self.validate is not None:
            why = self.validate(result)
            if why:
                logger.warning("eval cache skip (%s): %s/%s", why, self.scope, case_name)
                self.skipped.append({"case": case_name, "reason": why})
                return
        try:
            blob = result.model_dump_json()
        except Exception:
            logger.exception("eval cache serialize failed: %s/%s", self.scope, case_name)
            return
        if len(blob.encode()) > MAX_ITEM_BYTES:
            logger.warning("eval cache skip (%d bytes > item limit): %s/%s",
                           len(blob), self.scope, case_name)
            return
        try:
            catalog.get_table().put_item(
                Item={"pk": self.pk, "sk": case_name, "data": blob,
                      "cached_at": int(time.time()),
                      "expires_at": int(time.time()) + TTL_DAYS * 86400}
            )
        except Exception:
            logger.exception("eval cache write failed: %s/%s", self.scope, case_name)

    def stats(self) -> dict:
        s = {"scope": self.scope, "enabled": self.enabled,
             "hits": len(self.hits), "misses": len(self.misses),
             "hit_cases": self.hits[:50]}
        if self.skipped:
            s["skipped"] = self.skipped[:50]
        if self.rejected:
            s["rejected"] = self.rejected[:50]
        return s


def make_store(scope: str, mode: str, validate=None) -> DynamoEvaluationDataStore | None:
    """Resolve a UI cache mode into a store (or None for no caching).

    mode:
      "off"    -> no store: always invoke the agent, record nothing
      "record" -> read+write: reuse what exists, record what doesn't
      "reuse"  -> read-only: reuse recordings, don't overwrite them
                  (a miss still invokes the agent — nothing is skipped)

    validate: optional predicate rejecting unjudgeable recordings, see the class.
    """
    if mode == "record":
        return DynamoEvaluationDataStore(scope, validate=validate)
    if mode == "reuse":
        return DynamoEvaluationDataStore(scope, read_only=True, validate=validate)
    return None


def list_scopes() -> list[dict]:
    """Recorded cache scopes with case counts, for the UI cache panel."""
    if not catalog.TABLE_NAME:
        return []
    from boto3.dynamodb.conditions import Attr

    # pk is part of the key schema, so scopes can only be found by scanning;
    # the cache is small (bounded by dataset sizes) and this is a rare action.
    table = catalog.get_table()
    scopes: dict[str, dict] = {}
    kwargs = {"FilterExpression": Attr("pk").begins_with("EVALCACHE/"),
              "ProjectionExpression": "pk, sk, cached_at"}
    while True:
        resp = table.scan(**kwargs)
        for i in resp.get("Items", []):
            s = scopes.setdefault(i["pk"][len("EVALCACHE/"):],
                                  {"scope": "", "cases": 0, "cached_at": 0})
            s["scope"] = i["pk"][len("EVALCACHE/"):]
            s["cases"] += 1
            s["cached_at"] = max(s["cached_at"], int(i.get("cached_at", 0)))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return sorted(scopes.values(), key=lambda s: s["scope"])


def clear_scope(scope: str) -> int:
    """Delete every cached row in one scope; returns the number removed."""
    if not catalog.TABLE_NAME:
        return 0
    from boto3.dynamodb.conditions import Key

    table = catalog.get_table()
    pk = f"EVALCACHE/{scope}"
    removed = 0
    kwargs = {"KeyConditionExpression": Key("pk").eq(pk), "ProjectionExpression": "pk, sk"}
    while True:
        resp = table.query(**kwargs)
        items = resp.get("Items", [])
        with table.batch_writer() as batch:
            for i in items:
                batch.delete_item(Key={"pk": pk, "sk": i["sk"]})
                removed += 1
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return removed

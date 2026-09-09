"""Size-safe persistence for run records (pk=RTRUN / pk=RUN).

Why this module exists
  Red-team and regression runs are checkpointed to DynamoDB as one item whose
  `data` attribute is the whole run as JSON. That worked while runs were small
  and broke the moment they were not: on 2026-08-24 a 20-attack red-team run
  (10-16 turns each, ~1.3KB per turn) produced a 2.1MB blob, PutItem answered

      ValidationException: Item size has exceeded the maximum allowed size

  and the exception propagated out of the run executor. Everything the run had
  produced — every conversation, every verdict — was thrown away at the last
  step, after the money had been spent. Measured shares of that blob:

      results[].conversation   1110 KB   52%
      live_turns                964 KB   45%
      cases                      58 KB    3%
      everything else            <8 KB

  Both whales are bulk detail, and bulk detail has no business being in a
  400KB key-value item.

The contract
  DynamoDB holds a summary that is *guaranteed* to fit; S3 holds the full
  record. Shedding is progressive (biggest first) and always leaves a trace:
  `detail_truncated`, what was dropped, the original counts, and the S3 key
  where the complete version lives. Nothing is ever dropped silently — a
  reader that cannot see a conversation can always see that it exists and
  where it went.

Ordering rule (no half-written runs)
  S3 first, DynamoDB second, and the S3 key is written into the item only
  after the upload returned. So an item never points at an object that does
  not exist, and a failed upload downgrades to `detail_error` on a record that
  is still marked with its true status — it never turns a finished run into an
  errored one. A run is marked complete only once its detail is durable.

Invariant: **if detail had to be shed, it must have been archived first.**
Shedding therefore forces an archive even on a mid-run checkpoint.
"""

import contextlib
import json
import logging
import os
import time

import boto3

from discovery import REGION

logger = logging.getLogger("eval-anything")

# DynamoDB's hard per-item ceiling. We aim well under it: attribute names, the
# key strings and the pointer/trace fields we add all count toward the same
# budget, and a retry that lands at 399KB is a retry that fails next week.
DDB_ITEM_LIMIT = 400 * 1024
SAFE_BLOB_BYTES = 360 * 1024

# Mid-run, `live_turns` is the only thing that grows without bound and the UI
# only replays the recent window after a refresh. The tail is capped by BYTES,
# not by count: turns hold up to 1500 chars each and CJK costs ~3 bytes a char,
# so a count-based cap of 60 quietly claimed 270KB of a 360KB budget and
# starved the per-result summaries. The complete log is in the S3 archive.
LIVE_TURNS_TAIL = 60
LIVE_TURNS_BUDGET_BYTES = 48 * 1024


def _bucket() -> str:
    return os.environ.get("ARTIFACTS_BUCKET", "")


# 惰性单例（同 catalog.get_table 模式）：save_run 在 emit_turn 的热路径上被
# 逐轮调用，每次新建 client 就是每次新建连接池 + 重做 TLS 握手。
_s3_client = None


def _s3():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3", region_name=REGION)
    return _s3_client


def blob(run: dict) -> str:
    return json.dumps(run, ensure_ascii=False, default=str)


def blob_bytes(run: dict) -> int:
    return len(blob(run).encode())


# ---------- shedding ----------

def _shed_live_turns(run: dict) -> dict | None:
    """Keep the newest turns that fit in LIVE_TURNS_BUDGET_BYTES."""
    turns = run.get("live_turns")
    if not isinstance(turns, list) or not turns:
        return None
    kept: list[dict] = []
    used = 0
    for ev in reversed(turns[-LIVE_TURNS_TAIL:]):
        used += len(json.dumps(ev, ensure_ascii=False, default=str).encode())
        if used > LIVE_TURNS_BUDGET_BYTES and kept:
            break
        kept.append(ev)
    kept.reverse()
    if len(kept) == len(turns):
        return None
    out = dict(run)
    out["live_turns"] = kept
    out["live_turns_total"] = len(turns)
    out["live_turns_kept"] = len(kept)
    return out


def _shed_conversations(run: dict) -> dict | None:
    """Drop per-result transcripts, keeping their turn counts.

    `conversation_turns` is what lets a reader (and the UI) say "13 轮对话已存
    S3" instead of rendering an empty transcript that looks like the attack
    never happened.
    """
    results = run.get("results")
    if not isinstance(results, list):
        return None
    slim, hit = [], False
    for r in results:
        convo = r.get("conversation") if isinstance(r, dict) else None
        if not convo:
            slim.append(r)
            continue
        hit = True
        row = {k: v for k, v in r.items() if k != "conversation"}
        row["conversation_turns"] = len(convo)
        row["conversation_in_s3"] = True
        slim.append(row)
    if not hit:
        return None
    out = dict(run)
    out["results"] = slim
    return out


def _shed_cases(run: dict) -> dict | None:
    """Drop the attack/case definitions (they also live on the plan/dataset)."""
    cases = run.get("cases")
    if not isinstance(cases, list) or not cases:
        return None
    out = dict(run)
    out["cases"] = []
    out["cases_total"] = len(cases)
    return out


def _shed_results(run: dict) -> dict | None:
    """Last resort: drop result rows entirely, keeping the aggregate counts."""
    results = run.get("results")
    if not isinstance(results, list) or not results:
        return None
    out = dict(run)
    out["results"] = []
    out["results_total"] = len(results)
    return out


# Biggest-share-first, cheapest-loss-first: the turn log and the transcripts are
# pure detail with an S3 copy; dropping result rows loses the per-attack summary
# and is only reached by a run far beyond anything observed.
_SHED_STEPS = (
    ("live_turns", _shed_live_turns),
    ("results.conversation", _shed_conversations),
    ("cases", _shed_cases),
    ("results", _shed_results),
)

_DETAIL_KEYS = ("detail_truncated", "detail_dropped", "detail_note",
                "detail_s3_key", "detail_error", "live_turns_total",
                "live_turns_kept", "cases_total", "results_total")


def slim_run(run: dict, limit: int = SAFE_BLOB_BYTES) -> tuple[dict, list[str]]:
    """Return (run that fits in `limit`, names of what was shed).

    Never mutates `run`: the executor keeps the live dict in memory and returns
    it to its caller, so the full report must survive persistence untouched.
    """
    slim, shed, _, _ = _slim_with_blob(run, limit)
    return slim, shed


def _slim_with_blob(run: dict, limit: int) -> tuple[dict, list[str], str, str]:
    """slim_run + the serializations it already paid for.

    Returns (slim, shed, blob_full, blob_slim). Serializing a multi-MB run is
    3-20ms of CPU on the same thread that holds up the attack conversation
    (emit_turn) or the SSE event loop (the 5s tracker), and save_run used to
    serialize the same dict up to three times per checkpoint — once here to
    measure, once for the archive body, once for the DynamoDB item. Measuring
    already produces both strings, so hand them back instead.

    `blob_slim` matches the returned `slim` exactly; it is stale the moment a
    caller mutates `slim` (save_run re-serializes on those paths).
    """
    blob_full = blob(run)
    if len(blob_full.encode()) <= limit:
        return run, [], blob_full, blob_full
    current, cur_blob, shed = run, blob_full, []
    for name, step in _SHED_STEPS:
        reduced = step(current)
        if reduced is None:
            continue
        current = reduced
        shed.append(name)
        cur_blob = blob(current)
        if len(cur_blob.encode()) <= limit:
            break
    return current, shed, blob_full, cur_blob


# ---------- archive ----------

# 每个进行中 run 上一次**成功**归档时的覆盖范围（进程级，key=(pk, run_id)）。
#
# 为什么需要它：run 一旦超过 SAFE_BLOB_BYTES，此前**每次** checkpoint 都会
# shed → 触发整包（多 MB）S3 重传，而 checkpoint 在热路径上——emit_turn 每
# 2-4 轮（同步阻塞攻击对话线程）、tracker 每 5 秒（阻塞 SSE 事件循环）。
# 事故规模实测 220 次 PUT / 409MB 重复上传，每一份都被下一份覆盖。
#
# 为什么可以跳过：live_turns 与 results 都是**只追加**的（executor 只
# append，从不改写已有条目），所以「归档时的长度」就是「归档对象里已有的
# 前缀」。若本次 shed 掉的内容全部落在上次归档的覆盖范围内，重传不会给
# 归档对象增加任何 shed 相关的信息——对象键固定、就地覆盖，指针照样有效。
#
# 为什么不是时间窗：48KB 尾窗只装得下 10-16 条中文轮次，按事故节奏 60s 内
# 会有 20-30 条新轮次滑出窗口——时间窗内被 shed 的新轮次会「既不在 item
# 里、也不在任何归档里」，直到终态归档前都处于不可恢复状态。覆盖度判定
# 让「shed 过的必然已归档」按构造成立，由
# tests/test_run_persist_size.py::TestShedImpliesArchived 钉死。
#
# 终态落库时删除条目；正常时字典最多有「活跃 run 数」个键。异常中断的 run
# 会留下一个小条目直到容器回收——超过上限就整体清空，代价只是多归档一次
# （安全方向）。
_ARCHIVE_COVER: dict[tuple[str, str], dict] = {}
_ARCHIVE_COVER_MAX = 256


def _covers(cover: dict | None, slim: dict, run: dict, shed: list[str]) -> bool:
    """上次归档是否覆盖了本次 shed 的全部内容。拿不准一律 False（去归档）。"""
    if not cover:
        return False
    for name in shed:
        if name == "live_turns":
            # 被丢弃的是最老的 dropped 条（前缀）；归档里有前 cover 条
            dropped = ((slim.get("live_turns_total") or 0)
                       - (slim.get("live_turns_kept") or 0))
            if dropped > cover["live_turns"]:
                return False
        elif name in ("results.conversation", "results"):
            # 保守判定：归档之后新增过 result 行（各带完整 conversation），
            # 这次 shed 会把它们从 item 里删掉 → 必须先归档
            if len(run.get("results") or []) > cover["results"]:
                return False
        # "cases" 自 run 建立起不变，任何一次成功归档都覆盖
    return True


def archive_run(run: dict, s3_prefix: str, run_id: str,
                body: str | None = None, *,
                noun: str = "明细") -> tuple[str | None, str | None]:
    """Upload the complete run to S3. Returns (key, error_message).

    `body` is an already-serialized copy of `run` (save_run measured it moments
    ago); passing it skips re-serializing a multi-MB dict on the hot path.

    `noun` 是返回的错误文案里那个**用户可见**的名词。RUN / RTRUN 归档的是「完整
    明细」（默认，既有文案逐字不变）；planrun 归档的是「完整报告」，它现在自写了
    一遍同样的 S3-first 顺序 + 同一句只差名词的失败文案。名词先参数化是它换用这
    里的前置条件 —— 裸替会把用户读到的「完整报告归档失败」偷偷改成「完整明细归档
    失败」，而当时唯一相关的断言只查「归档失败」三个字，两种拼法都能过（simplify-r1
    两个评审独立警告过这一点）。planrun 的换用属 Track A。
    """
    bucket = _bucket()
    if not bucket:
        return None, f"ARTIFACTS_BUCKET 未配置，完整{noun}无法归档"
    key = f"{s3_prefix.strip('/')}/{run_id}.json"
    try:
        _s3().put_object(Bucket=bucket, Key=key,
                         Body=(body if body is not None else blob(run)).encode(),
                         ContentType="application/json; charset=utf-8")
    except Exception as e:
        logger.exception("run detail archive failed: %s", key)
        return None, f"完整{noun}归档失败：{str(e)[:200]}"
    return key, None


def fetch_detail(key: str) -> dict | None:
    bucket = _bucket()
    if not bucket or not key:
        return None
    try:
        body = _s3().get_object(Bucket=bucket, Key=key)["Body"].read()
        return json.loads(body)
    except Exception:
        logger.exception("run detail fetch failed: %s", key)
        return None


# ---------- save ----------

def save_run(table, pk: str, run: dict, s3_prefix: str,
             terminal: bool = False) -> dict:
    """Persist one run: full copy to S3, guaranteed-to-fit summary to DynamoDB.

    `terminal` archives unconditionally (the run reached a final state and its
    detail must be durable). A non-terminal checkpoint only archives when
    something had to be shed, which keeps the hot turn-by-turn path off S3
    while preserving the "shed implies archived" invariant.

    Returns the item that was written, for callers that want to log or assert
    on the trace.
    """
    run_id = run.get("run_id") or "unknown"
    cover_key = (pk, run_id)
    # 覆盖计数必须在序列化快照**之前**取：emit_turn 跑在别的线程上，dumps
    # 期间可能继续 append，归档体只会比计数多、不会少——覆盖度只许少报
    # （代价是多归档一次），绝不许多报（那会让 shed 掉的内容无处可寻）。
    live_len = len(run.get("live_turns") or [])
    results_len = len(run.get("results") or [])
    slim, shed, blob_full, blob_slim = _slim_with_blob(run, SAFE_BLOB_BYTES)
    s3_key, archive_error = None, None
    if terminal or shed:
        cover = _ARCHIVE_COVER.get(cover_key)
        if terminal or not _covers(cover, slim, run, shed):
            # blob_full is the same snapshot slimming was measured from — reuse
            # it instead of serializing the multi-MB dict a second time.
            s3_key, archive_error = archive_run(run, s3_prefix, run_id,
                                                body=blob_full)
            if s3_key:
                if len(_ARCHIVE_COVER) >= _ARCHIVE_COVER_MAX:
                    _ARCHIVE_COVER.clear()
                _ARCHIVE_COVER[cover_key] = {
                    "key": s3_key, "live_turns": live_len, "results": results_len,
                }
        else:
            # 本次 shed 的内容全部已在上次归档对象里（对象键固定），指针
            # 依旧指向存在且完整的对象——跳过一次多 MB 的整包重传。
            s3_key = cover["key"]
    if terminal:
        _ARCHIVE_COVER.pop(cover_key, None)

    # 任何加标记的分支都会复制并改动 slim → 测量时的缓存串作废（置 None，
    # 下面重新序列化；这时 slim 已 ≤360KB，代价可控）。未改动的快路径——
    # 也就是逐轮 checkpoint 的常态——直接复用测量串，一次 dumps 都不多花。
    if shed:
        # A reader must be able to tell "detail is elsewhere" from "there was
        # no detail". Both the flag and the destination are part of the record.
        slim, blob_slim = dict(slim), None
        slim["detail_truncated"] = True
        slim["detail_dropped"] = shed
        if s3_key:
            slim["detail_s3_key"] = s3_key
            slim["detail_note"] = ("明细体积超过单条记录上限，完整内容已存 S3"
                                   f"（{s3_key}），此处仅保留摘要")
        else:
            slim["detail_error"] = archive_error or "完整明细归档失败"
            slim["detail_note"] = ("明细体积超过单条记录上限且归档失败，"
                                   "此处仅保留摘要")
    elif s3_key:
        slim, blob_slim = dict(slim), None
        slim["detail_s3_key"] = s3_key
    elif archive_error:
        slim, blob_slim = dict(slim), None
        slim["detail_error"] = archive_error

    item = {"pk": pk, "sk": run_id,
            "data": blob_slim if blob_slim is not None else blob(slim),
            "updated_at": int(time.time())}
    if s3_key:
        item["detail_s3_key"] = s3_key
    try:
        table.put_item(Item=item)
    except Exception:
        # Size is handled above, so this is throttling or transport. A run that
        # finished must not read as still running, so fall back to the smallest
        # record that still carries the status and the pointer to the detail.
        logger.exception("run checkpoint put_item failed (%s/%s), retrying minimal",
                         pk, run_id)
        item = _minimal_item(pk, run, s3_key, archive_error)
        table.put_item(Item=item)
    return item


# ---------- live turn feed ----------

def publish_turn(run: dict, ev: dict, *, save, cadence: int,
                 loop=None, queue=None,
                 fail_note: str = "turn checkpoint failed") -> None:
    """把一帧实时对话落进 run 并送上 SSE 队列。回归与红队共用这一套送帧机制。

    调用方只负责**造帧**（两边的帧形不同：回归的 key 是 case@agent 且帧多一个
    `agent` 字段，红队按 attack#N 计数），送帧的三个动作在这里收口：

      1. 追加进 `run["live_turns"]` —— 只 append，从不改写已有条目。归档覆盖度
         判定（_ARCHIVE_COVER）正是建立在这条只追加不变量上：「归档时的长度」
         就是「归档对象里已有的前缀」。
      2. 每 `cadence` 帧 checkpoint 一次（回归 2 = 一次完整问答，红队 4）。
         **一次 checkpoint 失败绝不许打断对话**：这行代码跑在攻击/回归的 worker
         线程上，抛出去就是把一次已经花了钱的对话弄丢。
      3. 有 SSE 队列就 `call_soon_threadsafe` 投递 —— emit 在 worker 线程上，
         队列属事件循环，直接 put_nowait 就是跨线程碰事件循环。

    `fail_note` 只是日志措辞（两个域各自的原话，便于在 CloudWatch 里分辨来源）。

    帧的形态本身是**前端契约**：`web/src/pages/plan/liveTurns.ts` 逐字段消费两种
    帧形，而 `web/tests/live-turns.test.ts` 直接读 `app/testrun.py` /
    `app/redteam.py` 的源码对刑（`ev = {...}` 字面 dict、turn_counters 的 key、
    每个 emit_turn 调用点的 role 实参）。所以造帧留在两个调用点，这里一个字段
    都不碰 —— 帧字节按构造不变。
    """
    run["live_turns"].append(ev)
    if len(run["live_turns"]) % cadence == 0:
        try:
            save()
        except Exception:
            logger.exception(fail_note)
    if queue is not None:
        loop.call_soon_threadsafe(queue.put_nowait, ev)


@contextlib.contextmanager
def final_persist_guard(run: dict, ident: str, noun: str = "结果",
                        field: str = "persist_error"):
    """「终态落库永不 raise」这条口径的唯一定义点。

    结果已经花了钱、也照样会返回给调用方 —— 落库失败该记**在 run 上**，不该带着
    一次已完成的运行一起倒下。raise 出去正是 2026-08-24 那次事故把一次跑完的运行
    变成一条裸 error 的方式。

    三个参数位是为了让三种终态形态共用同一条口径（第三种是 planrun 的打字段摘要项
    + 独立 full_report + 返回 s3_key，实现复用不可行、口径必须一致 —— 它的采用属
    Track A，本批只把守卫立在这里）：
      ident  只进日志，用来指认是哪条记录（如 "RTRUN/rt-2026…"）。
      noun   用户可见文案里的名词（默认「结果」＝ 现有措辞逐字不变）。
      field  留痕字段名。planrun 也用 persist_error，**不许换成 report_error** ——
             后者的语义是「S3 明细缺失但摘要可用」，有 5 处活消费方，装 put_item
             失败会把话说反。

    只吞 Exception：KeyboardInterrupt / SystemExit 这类照旧穿过去，否则容器被回收
    会被静默记成一次「落库失败」。
    """
    try:
        yield
    except Exception as e:
        logger.exception("final persist failed (%s)", ident)
        run[field] = f"{noun}落库失败（本次{noun}未能存档）：{str(e)[:300]}"


def save_final(table, pk: str, run: dict, s3_prefix: str) -> None:
    """Terminal save that must never take a finished run down with it.

    The results are already paid for and are returned to the caller either
    way — a persistence failure is recorded **on the run** (`persist_error`),
    not raised. Raising here is how the 2026-08-24 incident turned a finished
    run into a bare error. See final_persist_guard for that rule's one home.
    """
    with final_persist_guard(run, f"{pk}/{run.get('run_id')}"):
        save_run(table, pk, run, s3_prefix, terminal=True)


def _minimal_item(pk: str, run: dict, s3_key: str | None,
                  archive_error: str | None) -> dict:
    """Status + aggregates only — the last thing we give up before losing a run."""
    keep = ("run_id", "agent", "dataset", "agents", "strategies", "status",
            "started_at", "finished_at", "started_epoch", "finished_epoch",
            "duration_s", "attacks", "completed", "judged", "errored",
            "silenced", "target_unreachable", "attacker_declined", "breached",
            "breach_rate", "verdict", "total_cases", "completed_cases",
            "blank_cases", "error_cases", "actual_cost_usd", "error")
    core = {k: run[k] for k in keep if k in run}
    core["detail_truncated"] = True
    core["detail_dropped"] = ["results", "live_turns", "cases", "analysis"]
    if s3_key:
        core["detail_s3_key"] = s3_key
        core["detail_note"] = f"仅保留状态摘要，完整明细见 S3（{s3_key}）"
    else:
        core["detail_error"] = archive_error or "完整明细归档失败"
        core["detail_note"] = "仅保留状态摘要，完整明细归档失败"
    item = {"pk": pk, "sk": run.get("run_id") or "unknown",
            "data": blob(core), "updated_at": int(time.time())}
    if s3_key:
        item["detail_s3_key"] = s3_key
    return item


def load_run(item: dict, detail: bool = True) -> dict:
    """Rebuild a run from its DynamoDB item, restoring S3 detail when needed.

    The archive holds the complete **prefix** of the same record: it is
    refreshed whenever anything not yet archived is about to be shed, but the
    item's live-turn tail may run a little ahead of it between refreshes
    (see _ARCHIVE_COVER) — so the archive becomes the base, the newer tail
    turns are spliced back on, and the shed markers come off. When the fetch
    fails the markers stay: the caller shows "明细过大，已存 S3" rather than
    an empty transcript.
    """
    run = json.loads(item["data"])
    key = run.get("detail_s3_key") or item.get("detail_s3_key")
    if not (detail and run.get("detail_truncated") and key):
        return run
    full = fetch_detail(key)
    if full is None:
        run["detail_error"] = "完整明细读取失败（摘要仍可用）"
        return run
    # 覆盖度节流允许归档滞后 item 一小段（≤ 尾窗长度）：把 item 尾窗里比
    # 归档新的轮次拼回去，「刷新后回放最近窗口」的语义不因节流而退化。
    # 尾窗覆盖全局索引 [total-len(tail), total)，不变量（dropped ≤ 归档长度）
    # 保证两段必然衔接或重叠；万一数据违背不变量，宁可保留归档原样也不拼错位。
    total = run.get("live_turns_total")
    tail = run.get("live_turns")
    arch = full.get("live_turns")
    if (isinstance(total, int) and isinstance(tail, list) and tail
            and isinstance(arch, list) and len(arch) < total):
        overlap = len(arch) - (total - len(tail))
        if 0 <= overlap <= len(tail):
            full["live_turns"] = arch + tail[overlap:]
    for k in _DETAIL_KEYS:
        full.pop(k, None)
    full["detail_source"] = "s3"
    full["detail_s3_key"] = key
    return full

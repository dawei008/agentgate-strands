"""Drive the deployed red-team flow end to end and print the streamed events."""
import json
import sys
import uuid

import boto3

import coords

REGION = coords.REGION
# 评估 Runtime 与被测 Agent 都从 coords 惰性现取（账号私有 / 每环境不同，
# 见仓库根 .env.example）——写成函数：import 本模块不该要 AWS 凭证。
probe_agent = coords.probe_target_agent

from botocore.config import Config

# Attack runs stream for many minutes; the default 60s read timeout aborts them.
client = boto3.client("bedrock-agentcore", region_name=REGION,
                      config=Config(read_timeout=1800, connect_timeout=30,
                                    retries={"max_attempts": 0}))


def call(payload, show=None, quiet=False):
    """Invoke the eval runtime; return every SSE event as a dict."""
    resp = client.invoke_agent_runtime(
        agentRuntimeArn=coords.eval_runtime_arn(),
        # 'evaltest-' prefix: observability listings filter these out. Without
        # it the probe's own eval-runtime session id shows up as a session of
        # whatever agent it evaluates (see the baggage note in _invoke_agent).
        runtimeSessionId="evaltest-rtprobe-" + uuid.uuid4().hex + uuid.uuid4().hex,
        contentType="application/json",
        accept="application/json, text/event-stream",
        payload=json.dumps(payload, ensure_ascii=False),
    )
    body = b"".join(c for c in resp["response"]).decode("utf-8", "replace")
    events = []
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        events.append(ev)
        name = ev.get("event")
        if quiet and name not in ("error",):
            continue
        if show and name not in show:
            continue
        print("--", name, json.dumps(ev, ensure_ascii=False)[:400])
    return events


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"

    if step in ("all", "gen"):
        print("=== target_spec ===")
        evs = call({"action": "redteam_target_spec", "agent_name": probe_agent()},
                   quiet=True)
        spec = next(e for e in evs if e.get("event") == "redteam_target_spec")
        print("system_prompt chars:", len(spec.get("system_prompt", "")),
              "tools:", len(spec.get("tools", [])),
              "model:", spec.get("model"))

        print("=== generate_redteam_cases ===")
        evs = call({"action": "generate_redteam_cases", "agent_name": probe_agent(),
                    "risk_categories": ["system_prompt_leak", "guideline_bypass"],
                    "per_category": 1}, quiet=True)
        gen = next(e for e in evs if e.get("event") == "redteam_cases_generated")
        cases = gen["cases"]
        json.dump(cases, open("/tmp/rt_cases.json", "w"), ensure_ascii=False)
        for c in cases:
            print(" -", c["name"], "|", c["risk_category"], "|",
                  c["actor_goal"][:90])

    if step in ("all", "run"):
        cases = json.load(open("/tmp/rt_cases.json"))
        print("=== estimate ===")
        evs = call({"action": "estimate_redteam_run", "agent_name": probe_agent(),
                    "cases": cases, "strategies": ["pair"]}, quiet=True)
        est = next(e for e in evs if e.get("event") == "redteam_estimate")
        est.pop("event", None)
        print(json.dumps(est, ensure_ascii=False))

        print("=== start_redteam_run ===")
        evs = call({"action": "start_redteam_run", "agent_name": probe_agent(),
                    "cases": cases, "strategies": ["pair"],
                    "estimate": est},
                   show=("attack_turn", "redteam_progress", "redteam_report",
                         "error"))
        rep = next((e for e in evs if e.get("event") == "redteam_report"), None)
        if rep:
            print("\n=== VERDICT ===")
            print({k: rep.get(k) for k in
                   ("status", "verdict", "attacks", "judged", "errored",
                    "silenced", "breached", "breach_rate", "target_turns",
                    "target_errors", "target_blank_turns")})
            for r in rep.get("results", []):
                print(f"\n--- {r['case_name']} score={r['score']} "
                      f"breached={r['breached']} errored={r['errored']} "
                      f"silenced={r['silenced']}")
                print("   reason:", r["reason"][:300])
                for m in r.get("conversation", []):
                    print(f"   [{m['role']}] {m['content'][:200]}")
            print("\n=== ANALYSIS ===")
            print(rep.get("analysis", "")[:3000])

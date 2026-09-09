#!/usr/bin/env python3
"""Invoke the deployed AgentGate 评估 Runtime directly (bypasses UI/Lambda).

Usage:
  python3 scripts/invoke_runtime.py discover
  python3 scripts/invoke_runtime.py evaluate agent1 [agent2 ...] [--sessions N] [--days N]
"""

import argparse
import json
import os
import sys
import uuid

import boto3

# 与 scripts/coords.py 同形：区域跟 AWS_REGION 走，兜底 us-west-2
REGION = os.environ.get("AWS_REGION", "us-west-2")
STACK = "EvalAnythingRuntime"


def runtime_arn() -> str:
    cfn = boto3.client("cloudformation", region_name=REGION)
    outputs = cfn.describe_stacks(StackName=STACK)["Stacks"][0]["Outputs"]
    return next(o["OutputValue"] for o in outputs if o["OutputKey"] == "RuntimeArn")


def render_report_markdown(report: dict) -> str:
    """Render the fixed report template: 概要 → 汇总表 → 执行明细 → 智能解析 → 原始JSON."""
    meta = report.get("meta", {})
    lines = [f"# 评估报告 — {meta.get('generated_at', '')}", ""]

    lines += ["## 一、评估概要", ""]
    lines.append(f"- 评估对象: {', '.join(meta.get('agents', []))}")
    lines.append(
        f"- 会话范围: 回看 {meta.get('lookback_days', '?')} 天，"
        f"评估 {meta.get('sessions_evaluated', '?')}/{meta.get('sessions_attempted', '?')} 个会话"
    )
    lines.append(f"- 评估器: {', '.join(meta.get('evaluators', []))}")
    if meta.get("metrics"):
        lines.append(f"- 指标: {', '.join(meta['metrics'])}")
    lines.append(f"- Judge 模型: {meta.get('judge_model', '')}")
    if meta.get("total_tokens"):
        cost = f"，预估成本 ${meta['total_cost_usd']}" if meta.get("total_cost_usd") else ""
        lines.append(f"- 总量: {meta['total_tokens']} tokens{cost}")

    evaluators = report.get("evaluators", [])
    has_metrics = bool(report.get("metrics_selected"))
    lines += ["", "## 二、分数汇总", ""]
    metric_heads = " | 总Token | 预估成本$ | 平均延迟s" if has_metrics else ""
    lines.append("| Agent | 会话数 | " + " | ".join(f"{e} 均分/通过率" for e in evaluators)
                 + metric_heads + " |")
    lines.append("|---|---|" + "---|" * (len(evaluators) + (3 if has_metrics else 0)))
    for name, a in report.get("agents", {}).items():
        cells = []
        for e in evaluators:
            s = a.get("summary", {}).get(e)
            cells.append(f"{s['mean_score']} / {s['pass_rate'] * 100:.0f}%" if s else "—")
        if has_metrics:
            m = a.get("metrics") or {}
            cells.append(str(m.get("tokens", {}).get("total", "—")))
            cells.append(str(m.get("cost", {}).get("usd", "—")))
            cells.append(str(m.get("latency", {}).get("avg_s", "—")))
        lines.append(f"| {name} | {a.get('sessions_evaluated', 0)} | " + " | ".join(cells) + " |")

    lines += ["", "## 三、评估执行明细", ""]
    for s in report.get("sessions", []):
        if s.get("error"):
            lines.append(f"- `{s.get('session_id', '?')}` ✗ {s['error']}")
            continue
        lines.append(f"- **{s['agent']}** · `{s['session_id']}`")
        for k, r in (s.get("results") or {}).items():
            mark = "✓" if r.get("passed") else "✗"
            rev = r.get("review")
            rv = ""
            if rev:
                label = "准确" if rev.get("verdict") == "accurate" else "不准确"
                note = f" — {rev['note']}" if rev.get("note") else ""
                rv = f"【人工复核: {label}{note}】"
            lines.append(f"  - {k} = {r.get('score')} {mark} {rv}{str(r.get('reason', ''))[:50]}…")
        m = s.get("metrics")
        if m:
            t, c, l = m.get("tokens", {}), m.get("cost", {}), m.get("latency", {})
            lc, tc = m.get("llm_calls", {}), m.get("tool_calls", {})
            parts = []
            if t: parts.append(f"tokens {t.get('input')}入/{t.get('output')}出")
            if c: parts.append(f"${c.get('usd')}")
            if l and l.get("turns"): parts.append(f"延迟均{l.get('avg_s')}s/峰{l.get('max_s')}s({l.get('turns')}轮)")
            if lc: parts.append(f"LLM×{lc.get('count')}")
            if tc: parts.append(f"工具×{tc.get('count')}")
            if parts: lines.append(f"  - 📊 {' · '.join(parts)}")
        if s.get("warning"):
            lines.append(f"  - ⚠ {s['warning']}")

    if report.get("analysis"):
        lines += ["", "## 四、智能解析", "", report["analysis"]]

    lines += ["", "## 五、原始报告 JSON", "", "```json",
              json.dumps(report, ensure_ascii=False, indent=2), "```"]
    return "\n".join(lines)


def invoke(payload: dict):
    client = boto3.client("bedrock-agentcore", region_name=REGION)
    resp = client.invoke_agent_runtime(
        agentRuntimeArn=runtime_arn(),
        runtimeSessionId=uuid.uuid4().hex + "0",
        contentType="application/json",
        accept="text/event-stream",
        payload=json.dumps(payload),
    )
    import codecs

    decoder = codecs.getincrementaldecoder("utf-8")()
    buffer = ""
    for chunk in resp["response"]:
        buffer += decoder.decode(chunk) if isinstance(chunk, bytes) else str(chunk)
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            for line in frame.splitlines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    try:
                        ev = json.loads(data)
                        if isinstance(ev, str):
                            ev = json.loads(ev)
                    except json.JSONDecodeError:
                        continue
                    if ev.get("event") == "report":
                        print("\n" + render_report_markdown(ev))
                    else:
                        print(json.dumps(ev, ensure_ascii=False)[:600])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["discover", "evaluators", "evaluate"])
    parser.add_argument("agents", nargs="*")
    parser.add_argument("--sessions", type=int, default=5)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--evaluators", nargs="*")
    args = parser.parse_args()

    payload = {"action": args.action}
    if args.action == "evaluate":
        if not args.agents:
            sys.exit("evaluate requires at least one agent name")
        payload.update(
            {
                "agent_names": args.agents,
                "max_sessions": args.sessions,
                "lookback_days": args.days,
            }
        )
        if args.evaluators:
            payload["evaluators"] = args.evaluators
    invoke(payload)


if __name__ == "__main__":
    main()

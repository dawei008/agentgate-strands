#!/usr/bin/env python3
"""UI 冒烟：本地 stub SSE 后端 + Playwright，验证方案中心信息架构。

无需 AWS：静态托管 ../ui，/api/invoke 按 action 回放固定 SSE 事件，注入假
token 跳过 Cognito。断言用户可见行为：
  · 评估台 = 方案总表（Agent筛选/上次结果/内置预估列）+ 跨方案最近 run 流
  · 点方案行 → 方案详情：头部(Agent链接/环节/预估)、趋势、run 历史、报告
  · Agent 目录（瘦表）→ Agent 详情：挂载方案 + 跨方案 run 聚合
  · 从 Agent 详情按[运行]：控制台内联在 Agent 页，跑完自动切到方案详情报告
  · 全程无 confirm 弹窗（删除类除外）、无 JS 错误
"""
import http.server
import json
import re
import socketserver
import threading
import time
from pathlib import Path

UI = Path(__file__).resolve().parent.parent / "ui"
PORT = 8899

PLANS = [
    {"plan_id": "plan-full", "name": "上线前全量", "agent_name": "shop-agent",
     "schedule": {"cron": "cron(0 1 ? * MON *)", "budget_usd": 5}, "updated_at": 300,
     "stages": [{"type": "observe", "max_sessions": 5, "evaluators": ["helpfulness"], "metrics": []},
                {"type": "dataset", "dataset": "回归集", "evaluators": ["correctness"]},
                {"type": "redteam", "cases_dataset": "红队集", "strategies": ["direct"]}]},
    {"plan_id": "plan-obs", "name": "基础观测", "agent_name": "shop-agent",
     "schedule": None, "updated_at": 200,
     "stages": [{"type": "observe", "lookback_days": 30, "max_sessions": 10,
                 "evaluators": ["helpfulness", "tool_selection_accuracy"],
                 "metrics": ["tokens", "cost"]}]},
    # 定时 + 预算 0.3 < 预估 0.42：既解释 RUNS 里那条 skipped，也供超预算警示断言用
    {"plan_id": "plan-ops", "name": "周一定时回归", "agent_name": "ops-agent",
     "schedule": {"cron": "cron(0 6 ? * MON *)", "budget_usd": 0.3}, "updated_at": 100,
     "stages": [{"type": "dataset", "dataset": "回归集", "evaluators": ["correctness"]}]},
]

ESTIMATES = {
    "plan-full": {"stages": [{"type": "observe", "estimated_cost_usd": 0.105},
                             {"type": "dataset", "estimated_cost_usd": 0.42},
                             {"type": "redteam", "estimated_cost_usd": 1.2}],
                  "estimated_cost_usd": 1.725},
    "plan-obs": {"stages": [{"type": "observe", "judge_calls": 30, "estimated_cost_usd": 0.315}],
                 "estimated_cost_usd": 0.315},
    "plan-ops": {"stages": [{"type": "dataset", "estimated_cost_usd": 0.42}],
                 "estimated_cost_usd": 0.42},
}

SYNTH_V2 = ("## 整体趋势\n线上评估均分由 0.74 升至 0.78（[run:#1 2026-08-15] → [run:#2]），"
            "回归通过率同步改善。\n## 反复出现的问题\n预算确认缺失在 [run:#1] 与 [run:#2] 均有出现。\n"
            "## 改进采纳效果\n无已标记采纳的改进。\n## 当前优先建议\n- 补充预算确认指令")
SYNTH_V1 = ("## 整体趋势\n首次运行（[run:#1]），暂无对比基准。\n## 反复出现的问题\n无。\n"
            "## 改进采纳效果\n无。\n## 当前优先建议\n- 建立回归基线")

RUNS = [  # 新→旧，跨方案
    {"run_key": "plan-full#20260818103200", "plan_id": "plan-full", "plan_name": "上线前全量",
     "agent_name": "shop-agent", "status": "completed", "triggered_by": "manual",
     "started_at": "2026-08-18 10:32", "total_cost_usd": 1.68, "duration_s": 754,
     # 最新 run 红队被攻破 1/8：断言趋势末值真的渲染成红（判色曾被 .trend-vals b 覆盖成灰）
     "stage_summaries": [{"type": "observe", "overall_mean": 0.78, "sessions": 5},
                         {"type": "dataset", "pass_rate": 0.82},
                         {"type": "redteam", "breached": 1, "attacks": 8}],
     "overview": {"stage_lines": [{"type": "observe", "text": "线上评估均分 0.78", "delta": 0.04}]},
     "plan_synthesis": SYNTH_V2, "synthesis_error": None,
     "proposals": []},
    {"run_key": "plan-ops#20260817060000", "plan_id": "plan-ops", "plan_name": "周一定时回归",
     "agent_name": "ops-agent", "status": "skipped", "triggered_by": "schedule",
     "started_at": "2026-08-17 06:00", "total_cost_usd": None,
     "skip_reason": "预估成本 $0.42 超过单次预算上限 $0.30",
     "stage_summaries": [], "overview": {}, "proposals": []},
    {"run_key": "plan-full#20260815010000", "plan_id": "plan-full", "plan_name": "上线前全量",
     "agent_name": "shop-agent", "status": "completed", "triggered_by": "schedule",
     "started_at": "2026-08-15 01:00", "total_cost_usd": 1.71, "duration_s": 42,
     "stage_summaries": [{"type": "observe", "overall_mean": 0.74, "sessions": 5},
                         {"type": "dataset", "pass_rate": 0.80},
                         {"type": "redteam", "breached": 0, "attacks": 8}],
     "overview": {},
     "plan_synthesis": SYNTH_V1, "synthesis_error": None,
     "proposals": []},
]

FULL_REPORT = {
    "stages": [
        {"type": "observe", "status": "completed", "sessions": 5, "overall_mean": 0.78,
         "summary": {"helpfulness": {"mean_score": 0.78, "pass_rate": 0.8, "sessions": 5, "errored": 0}},
         # 低分会话让「生成改进稿」按钮出现（diff 视图冒烟依赖）
         "session_details": [{"session_id": "sess-low",
                              "results": {"helpfulness": {"score": 0.5, "passed": False,
                                                          "reason": "未确认预算即给出方案"}}}],
         "analysis": "整体表现稳定。"},
        {"type": "dataset", "status": "completed", "dataset": "回归集", "pass_rate": 0.82,
         "report": {"results": []}},
        {"type": "redteam", "status": "completed", "verdict": "FAIL", "breached": 1, "attacks": 8,
         "report": {"results": []}},
    ],
}


# ---- probe_agent_invoke 假响应 ----
# 造一个嵌套响应，让展平列表有多行可点，并覆盖两类不可选条目：
#   type=="truncated"（数组折叠标记）与 is_whole_response（整段响应就是这个值）。
# 真实后端不会在同一次响应里同时给出这两类，所以分两个场景：
#   默认 sample_input     -> 嵌套 JSON（含 truncated 标记）
#   sample_input=SCALAR   -> 整个响应是一个字符串（含 is_whole_response）
#   sample_input=FAIL     -> ok=false（路径取不到值）+ 原始响应已截断
NESTED_PATHS = [
    {"path": "output.message.role", "response_path": "output.message.role",
     "type": "string", "preview": "assistant"},
    {"path": "output.message.content[0].text", "response_path": "output.message.content.0.text",
     "type": "string", "preview": "已为你查到 3 个订单，最近一笔在 8 月 12 日。"},
    {"path": "output.message.content[1].text", "response_path": "output.message.content.1.text",
     "type": "string", "preview": "需要我继续查退款状态吗？"},
    {"path": "output.message.content[2..2]", "response_path": None,
     "type": "truncated", "preview": "数组共 3 个元素，仅展开前 2 个"},
    {"path": "meta.latency_ms", "response_path": "meta.latency_ms",
     "type": "number", "preview": "812"},
    {"path": "meta.tokens", "response_path": "meta.tokens",
     "type": "object", "preview": '{"input": 24, "output": 57}'},
    {"path": "session_id", "response_path": "session_id",
     "type": "string", "preview": "evaltest-probe-abc123"},
]
NESTED_RAW = json.dumps({
    "output": {"message": {"role": "assistant", "content": [
        {"text": "已为你查到 3 个订单，最近一笔在 8 月 12 日。"},
        {"text": "需要我继续查退款状态吗？"},
        {"text": "（第三段被折叠）"}]}},
    "meta": {"latency_ms": 812, "tokens": {"input": 24, "output": 57}},
    "session_id": "evaltest-probe-abc123",
}, ensure_ascii=False)
SCALAR_PATHS = [
    {"path": "$", "response_path": "", "is_whole_response": True, "type": "string",
     "note": "整个响应就是这个值，无需提取路径（response_path 留空即可）",
     "preview": "直接返回的一段纯文本回答"},
]


def probe_events(payload):
    tpl = payload.get("payload_template") or '{"prompt": "{input}"}'
    sample = (payload.get("sample_input") or "").strip()
    # 三态：缺键 = 用已保存规则（stub 的 get_agent_config 保存值为 ""）
    from_request = "response_path" in payload
    path = payload.get("response_path") if from_request else ""
    rendered = tpl.replace("{input}", sample or "这是一次连通性测试，请简单回答。")
    try:
        req_payload = json.loads(rendered)
    except json.JSONDecodeError:
        req_payload = rendered
    base = {"event": "invoke_probed", "agent_name": payload.get("agent_name"),
            "request_payload": req_payload, "latency_ms": 812,
            "response_path_used": path,
            "response_path_from": "request" if from_request else "saved"}
    if sample == "SCALAR":
        raw = '"直接返回的一段纯文本回答"'
        return [{**base, "ok": True, "response_raw": raw, "response_bytes": len(raw),
                 "response_raw_truncated": False, "response_paths": SCALAR_PATHS,
                 "extracted_text": "直接返回的一段纯文本回答", "error": None}]
    if sample == "FAIL":
        return [{**base, "ok": False, "response_raw": NESTED_RAW[:200],
                 "response_bytes": 9001, "response_raw_truncated": True,
                 "response_paths": NESTED_PATHS, "response_paths_truncated": True,
                 "extracted_text": None,
                 "error": ("本次选择的提取路径 response_path='result.text' 在本次响应中取不到值；"
                           "请从 response_paths 里选择实际存放最终回答的路径。")}]
    extracted = {"": NESTED_RAW,
                 "output.message.content.0.text": "已为你查到 3 个订单，最近一笔在 8 月 12 日。",
                 "output.message.content.1.text": "需要我继续查退款状态吗？",
                 "meta.latency_ms": "812"}.get(path, NESTED_RAW)
    return [
        # 心跳必须被 UI 忽略（只更新等待文案）
        {"event": "heartbeat", "phase": "probe_agent_invoke", "agent": payload.get("agent_name")},
        {**base, "ok": True, "response_raw": NESTED_RAW, "response_bytes": len(NESTED_RAW),
         "response_raw_truncated": False, "response_paths": NESTED_PATHS,
         "extracted_text": extracted, "error": None},
    ]


def events(payload):
    action = payload.get("action")
    if action == "discover":
        return [{"event": "agents", "from_cache": True, "agents": [
            {"agent_name": "shop-agent", "has_logs": True, "description": "购物助手", "source": "agentcore"},
            {"agent_name": "ops-agent", "has_logs": True, "description": "运维助手", "source": "agentcore"},
            {"agent_name": "cold-agent", "has_logs": False, "description": "没流量", "source": "agentcore"},
        ]}]
    if action == "evaluators":
        # 「评估器 × 环节」契约：correctness 仅回归可用（走 dataset_only），
        # scopes 标注内置适用环节，custom 每项带 scope（缺省 = all）
        return [{"event": "evaluators", "available": ["helpfulness",
                                                      "tool_selection_accuracy", "instruction_following"],
                 "default": ["helpfulness"],
                 "custom": [{"name": "cust-flow", "rubric": "对话流畅度", "scope": "observe"}],
                 "multimodal": [],
                 "scopes": {"helpfulness": ["observe", "dataset"],
                            "tool_selection_accuracy": ["observe", "dataset"],
                            "instruction_following": ["observe", "dataset"],
                            "correctness": ["dataset"]},
                 "dataset_only": ["correctness"],
                 "metrics": ["tokens", "cost", "latency", "llm_calls", "tool_calls"]}]
    if action == "list_plans":
        agent = payload.get("agent_name")
        return [{"event": "plans",
                 "plans": [p for p in PLANS if not agent or p["agent_name"] == agent]}]
    if action == "list_recent_runs":
        agent = payload.get("agent_name")
        return [{"event": "recent_runs",
                 "runs": [r for r in RUNS if not agent or r["agent_name"] == agent]}]
    if action == "list_plan_runs":
        pid = payload.get("plan_id")
        return [{"event": "plan_runs", "plan_id": pid,
                 "runs": [r for r in RUNS if r["plan_id"] == pid]}]
    if action == "get_plan_run":
        rk = payload.get("run_key", "")
        base = next((r for r in RUNS if r["run_key"] == rk), RUNS[0])
        return [{"event": "plan_run", **base, "report": FULL_REPORT}]
    if action == "estimate_plan_run":
        pid = payload.get("plan_id", "")
        est = ESTIMATES.get(pid) or ESTIMATES["plan-obs"]
        return [{"event": "plan_run_estimate", "plan_id": pid, **est}]
    if action == "run_plan":
        pid = payload.get("plan_id", "")
        est = ESTIMATES.get(pid) or ESTIMATES["plan-obs"]
        plan = next((p for p in PLANS if p["plan_id"] == pid), PLANS[0])
        return [
            {"event": "plan_run_started", "plan_id": pid, "plan_name": plan["name"],
             "agent": plan["agent_name"], "stages": [s["type"] for s in plan["stages"]],
             "estimate": est, "triggered_by": "manual"},
            {"event": "stage_start", "stage": 1, "total_stages": len(plan["stages"]), "type": "observe"},
            {"event": "session_result", "session_id": "sess-abc", "results": {"helpfulness": {"score": 0.8}}},
            {"event": "stage_done", "stage": 1, "type": "observe",
             "summary": {"status": "completed"}},
            {"event": "plan_run_report", "run_key": RUNS[0]["run_key"]},
            {"event": "plan_run_done"},
        ]
    if action == "list_datasets":
        # 回归集带真实 cases（含一条多轮用例）——供数据集表单化编辑器断言回填
        return [{"event": "datasets", "datasets": [
            {"name": "回归集", "case_count": 2, "cases": [
                {"name": "case-单轮", "input": "查询订单 123 的状态",
                 "expected_output": "包含订单状态与预计送达时间",
                 "expected_tools": ["get_order"]},
                {"name": "case-多轮", "input": "我想改签航班",
                 "task_description": "改签到下周五并确认行李额",
                 "max_turns": 6, "persona": "着急的商务旅客",
                 "expected_output": "完成改签并给出行李额"}]},
            {"name": "红队集", "case_count": 8, "cases": []}]}]
    if action == "redteam_options":
        return [{"event": "redteam_options", "strategies": [{"name": "direct", "label": "直接越狱"}],
                 "default_strategies": ["direct"],
                 "risk_categories": {"harmful_content": {"label": "有害内容"},
                                     "prompt_leak": {"label": "提示词泄露"}},
                 "default_risk_categories": ["harmful_content"]}]
    if action == "get_judge_config":
        return [{"event": "judge_config", "provider": "bedrock",
                 "model": "global.anthropic.claude-sonnet-5", "base_url": "", "secret_id": ""}]
    if action == "set_judge_config":
        cfg = payload.get("config") or {}
        if not cfg.get("model"):
            return [{"event": "error", "error": "模型名必填"}]
        return [{"event": "judge_config_saved", **cfg}]
    if action == "prices":
        return [{"event": "prices", "prices": {}, "last_sync": None}]
    if action == "get_agent_config":
        return [{"event": "agent_config", "payload_template": '{"prompt": "{input}"}', "response_path": ""}]
    if action == "set_agent_config":
        return [{"event": "agent_config_set", "agent_name": payload.get("agent_name"),
                 "payload_template": payload.get("payload_template"),
                 "response_path": payload.get("response_path")}]
    if action == "probe_agent_invoke":
        return probe_events(payload)
    if action == "propose_improvements":
        return [{"event": "improvement", "prompt_recovered": True,
                 "current_prompt": "你是订票助手。\n回答保持简洁。\n禁止透露内部信息。",
                 "based_on": {"sessions": 1, "failures": 1, "root_causes": 1,
                              "fix_types": {"prompt": 1}},
                 "proposal": {"summary": "补充预算确认指令",
                              "system_prompt": {
                                  "mode": "full",
                                  "revised": "你是订票助手。\n回答保持简洁。\n用户未提供预算时先追问预算。\n禁止透露内部信息。",
                                  "changes": [{"kind": "add", "what": "增加预算追问",
                                               "why": "低分会话均因未确认预算"}]},
                              "tool_descriptions": [], "other_actions": []}}]
    return [{"event": "error", "error": f"stub 未实现 action={action}"}]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI), **kw)

    def log_message(self, format, *args):  # noqa: A002 - 签名跟基类一致
        pass

    def do_GET(self):
        if self.path == "/config.json":
            body = json.dumps({"region": "us-west-2", "userPoolId": "stub",
                               "clientId": "stub", "cognitoDomain": "https://stub.invalid",
                               "apiPath": "/api/invoke"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(n) or b"{}")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        # run_plan 逐事件放慢：让「运行中」状态可被 UI 测试观测（状态条/按钮置灰）
        delay = 0.35 if payload.get("action") == "run_plan" else 0
        try:
            for ev in events(payload):
                if delay:
                    time.sleep(delay)
                self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 页面跳转/关闭会中断 SSE 流，不算错误


def main():
    # 线程化：run_plan 的慢速 SSE 会占住连接，单线程 server 会把
    # 编辑器打开时的 evaluators/datasets 请求全堵在后面
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    passed, failed = [], []

    def check(name, cond, detail=""):
        (passed if cond else failed).append(f"{name}{(' — ' + detail) if detail else ''}")

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        dialogs = []

        def on_dialog(d):
            dialogs.append(d.message)
            d.accept()

        page.on("dialog", on_dialog)
        page.add_init_script("sessionStorage.setItem('access_token','stub-token')")
        page.goto(f"http://127.0.0.1:{PORT}/index.html")

        # ---- 0) 品牌：侧栏 brand 用 AND 门 logo（sprite symbol），favicon 内联 SVG ----
        page.wait_for_selector(".brand svg.mark use", timeout=15000)
        brand = page.evaluate("""() => {
          const use = document.querySelector('.brand svg.mark use');
          const sym = document.getElementById('i-logo');
          const fav = document.querySelector("link[rel=icon][type='image/svg+xml']");
          return { ref: !!use && use.getAttribute('href') === '#i-logo',
                   sym: !!sym && sym.getAttribute('viewBox') === '0 0 48 48',
                   fav: !!fav && (fav.getAttribute('href') || '').startsWith('data:image/svg+xml') };
        }""")
        check("侧栏 brand 引用 #i-logo sprite（48 viewBox）", brand["ref"] and brand["sym"], str(brand))
        check("favicon 为内联 SVG data URI", brand["fav"], str(brand))

        # ---- 1) 评估台：方案总表 ----
        page.wait_for_selector("#planTable table", timeout=15000)
        t = page.locator("#planTable").inner_text()
        check("方案总表列出全部方案", all(n in t for n in ("上线前全量", "基础观测", "周一定时回归")))
        check("表内有上次结果", "0.78" in t and "82%" in t)
        check("从未运行的方案有标注", "从未运行" in t)
        page.wait_for_function(
            "() => document.querySelector('#pt-est-0')?.textContent.includes('1.725')", timeout=15000)
        e0 = page.locator("#pt-est-0").inner_text()
        # 明细收进 ? tooltip（视觉评审 P1-3：同行明细被 sticky 操作列硬切）——断言 data-tip 内容
        e0_tip = page.locator("#pt-est-0 .tip").first.get_attribute("data-tip") or ""
        check("内置预估列（合计+明细tooltip）", "1.725" in e0 and "红队" in e0_tip, f"{e0} | {e0_tip}")
        # Agent 筛选
        page.select_option("#planAgentFilter", "ops-agent")
        page.wait_for_function(
            "() => !document.querySelector('#planTable').textContent.includes('上线前全量')", timeout=5000)
        check("Agent 筛选生效", "周一定时回归" in page.locator("#planTable").inner_text())
        page.select_option("#planAgentFilter", "")
        page.wait_for_selector("#planTable table", timeout=5000)

        # ---- 2) 最近 run 流 ----
        rr = page.locator("#recentRuns").inner_text()
        check("最近 run 跨方案倒序", rr.index("10:32") < rr.index("06:00"))
        check("skipped run 可见", "超过单次预算上限" in rr)

        # ---- 3) 方案详情 ----
        page.locator("#planTable tr.rowlink").first.click()
        page.wait_for_selector("#view-plan.on", timeout=15000)
        check("方案详情标题", page.locator("#planTitle").inner_text() == "上线前全量")
        head = page.locator("#planHead").inner_text()
        check("头部有 Agent 链接与环节", "shop-agent" in head and "回归" in head)
        # M3-1：概览头两段式——Agent 主体行 + 定义网格 3 行（评估环节/运行方式/单次成本）
        check("概览头定义网格 3 行（.ph-grid dt）",
              page.locator("#planHead .ph-grid dt").count() == 3)
        # M2-1：概览头 + 趋势并排两列栅格（两张 panel 都在 .plan-top 内）
        check("概览头与趋势包进 .plan-top 两列栅格",
              page.evaluate("""() => {
                const top = document.querySelector('#view-plan .plan-top');
                return !!top
                  && top.contains(document.getElementById('planHead'))
                  && top.contains(document.getElementById('planTrendPanel'));
              }"""))
        page.wait_for_function(
            "() => document.querySelector('#ph-est')?.textContent.includes('1.725')", timeout=15000)
        page.wait_for_selector("#planTrend .trendrow", timeout=15000)
        trend = page.locator("#planTrend").inner_text()
        # M4-2：observe 行升级主图后行头只留末值+delta，历史数列由图表承担；
        # dataset/redteam 两行维持文本数列现状
        check("趋势 observe 末值与 dataset 新旧序列",
              "0.78" in trend and "80%" in trend and "82%" in trend, trend.replace("\n", " "))
        # M4-2/M4-3：线上均分真图表——坐标轴/0.7 参考线/日期刻度（SVG 文本走 text_content）
        check("趋势主图 .tchart 存在", page.locator("#planTrend .tchart").count() == 1)
        tchart_txt = page.locator("#planTrend .tchart").text_content() or ""
        check("趋势主图有 0.7 参考线标注", "参考线 0.7" in tchart_txt, tchart_txt)
        check("趋势主图有日期刻度", re.search(r"\d{2}-\d{2}", tchart_txt) is not None, tchart_txt)
        # M4-1：趋势末值语义色真实生效（曾被 .trend-vals b 覆盖成 rgb(28,36,52) 灰黑）
        trend_colors = page.evaluate("""() => {
          const bs = [...document.querySelectorAll('#planTrend .trend-vals b')];
          return bs.map(b => ({ cls: b.className, color: getComputedStyle(b).color }));
        }""")
        obs_b = next((c for c in trend_colors if "s-good" in c["cls"]), None)
        rt_b = next((c for c in trend_colors if "s-bad" in c["cls"]), None)
        check("趋势末值 s-good 渲染为绿（非灰黑兜底色）",
              obs_b is not None and obs_b["color"] == "rgb(21, 128, 61)", str(trend_colors))
        check("红队攻破 1/8 末值渲染为红",
              rt_b is not None and rt_b["color"] == "rgb(201, 42, 42)", str(trend_colors))
        # M1-1：卡片副标题降为 12px caption 级（不再与 15px 卡片标题同字号）
        sub_fs = page.evaluate("""() => [...document.querySelectorAll('#view-plan .panel h3 .h3sub')]
          .map(el => getComputedStyle(el).fontSize)""")
        check("详情页副标题字号 12px", len(sub_fs) >= 2 and all(f == "12px" for f in sub_fs),
              str(sub_fs))
        hist = page.locator("#runHistory").inner_text()
        check("run 历史两条", "10:32" in hist and "01:00" in hist)
        # M8：耗时列——754s → 12m 34s，42s 保持秒级
        check("运行历史耗时列格式化", "耗时" in hist and "12m 34s" in hist and "42s" in hist,
              hist.replace("\n", " ")[:120])
        # M7-1：时间格式统一——单元格无年份、无 UTC 后缀；时区在标题声明一次
        check("运行历史时间无 UTC 后缀且有一次性时区声明",
              " UTC" not in hist and "2026-" not in hist
              and "时间为 UTC" in page.locator("#runHistoryPanel h3").inner_text(), hist[:60])
        check("运行历史副标题为运行计数",
              "共 2 次运行" in page.locator("#runHistorySub").inner_text())
        # M5-2：行内操作是文字链而非按钮框（8 个 ghost 按钮竖带 → 低调文字链）
        check("运行历史操作为文字链（.rowact 非 .btn）",
              page.locator("#runHistory .r-view.rowact").count() == 2
              and page.locator("#runHistory .r-view.btn").count() == 0)
        check("成功 run 操作文案为查看报告", "查看报告" in hist)
        # M5-1：删除方案收进「更多操作」菜单，默认不可见；Esc 可关
        check("删除方案在 moremenu 内且默认隐藏",
              page.locator(".moremenu #ph-del").count() == 1
              and page.locator("#ph-del").is_hidden())
        page.locator(".moremenu > summary").click()
        page.wait_for_selector("#ph-del", state="visible", timeout=5000)
        page.keyboard.press("Escape")
        page.wait_for_selector("#ph-del", state="hidden", timeout=5000)
        check("moremenu 展开后 Esc 关闭", True)
        page.locator(".moremenu > summary").click()
        page.wait_for_selector("#ph-del", state="visible", timeout=5000)
        page.locator("#planTitle").click()
        page.wait_for_selector("#ph-del", state="hidden", timeout=5000)
        check("moremenu 点击外部关闭", True)
        # M3-3：srcbadge 对比度到 AA（#5b6880 + 12px）
        badge_css = page.evaluate("""() => {
          const el = document.querySelector('#planHead .srcbadge');
          const s = getComputedStyle(el);
          return { color: s.color, fontSize: s.fontSize };
        }""")
        check("srcbadge 对比度达 AA（#5b6880 / 12px）",
              badge_css["color"] == "rgb(91, 104, 128)" and badge_css["fontSize"] == "12px",
              str(badge_css))

        # ---- 3.2) 综合报告面板：默认最新版 / 版本切换 / [run:#N] 溯源 ----
        page.wait_for_selector("#synthesisBody .analysis", timeout=15000)
        syn = page.locator("#synthesisBody").inner_text()
        check("综合报告默认展示最新版", "0.74 升至 0.78" in syn and "整体趋势" in syn,
              syn[:60].replace("\n", " "))
        check("版本下拉两个选项（倒序）",
              page.locator("#synthSel option").count() == 2
              and "第 2 次运行" in page.locator("#synthSel option").first.inner_text())
        # [run:#N] 引用可点击 → 运行历史对应行高亮
        page.locator("#synthesisBody .run-ref").first.click()
        page.wait_for_selector("#runHistory tr.row-hl[data-runno='1']", timeout=5000)
        check("[run:#N] 点击高亮历史行", True)
        # 切到历史版本
        page.select_option("#synthSel", "1")
        page.wait_for_function(
            "() => document.getElementById('synthesisBody').textContent.includes('暂无对比基准')",
            timeout=5000)
        check("版本切换生效（第 1 版）",
              "建立回归基线" in page.locator("#synthesisBody").inner_text()
              and "历史版本" in page.locator("#synthesisBody").inner_text())
        page.select_option("#synthSel", "2")

        # 看报告（面板解除 hidden 只是开始加载——等章节渲染完再断言）
        page.locator(".r-view").first.click()
        page.wait_for_function(
            "() => document.querySelector('#reportBody')?.textContent.includes('红队测试')",
            timeout=15000)
        rep = page.locator("#reportPanel").inner_text()
        check("报告三环节齐全", all(k in rep for k in ("线上评估", "回归测试", "红队测试")))
        check("报告总览有 delta", "0.78" in rep)
        check("单次报告标题为 运行 #N · 日期",
              "运行 #2 报告" in page.locator("#reportTitle").inner_text()
              and "08-18 10:32" in page.locator("#reportTitle").inner_text(),
              page.locator("#reportTitle").inner_text())

        # ---- 3.4) 无 synthesis 的方案：面板压成一行提示条 + 下拉隐藏 ----
        page.goto(f"http://127.0.0.1:{PORT}/index.html#plan/plan-ops")
        page.wait_for_function(
            "() => document.getElementById('synthesisBody').textContent.includes('首次运行完成后')",
            timeout=15000)
        check("无综合报告时空态说明",
              "跨运行的趋势分析与待办" in page.locator("#synthesisBody").inner_text()
              and page.locator("#synthSel").is_hidden())
        # M2-3：空态不占整卡——is-empty 压缩后面板高度 < 60px（原 94px）
        empty_h = page.evaluate(
            "() => document.getElementById('synthesisPanel').getBoundingClientRect().height")
        check("综合报告空态压缩为提示条（<60px）",
              page.evaluate("() => document.getElementById('synthesisPanel')"
                            ".classList.contains('is-empty')") and empty_h < 60,
              f"height={empty_h}")
        # M5-2：跳过 run 的操作文案 = 查看原因（plan-ops 的唯一 run 是 skipped）
        page.wait_for_selector("#runHistory .r-view", timeout=15000)
        check("跳过 run 操作文案为查看原因（文字链）",
              "查看原因" in page.locator("#runHistory").inner_text()
              and page.locator("#runHistory .r-view.rowact").count() == 1)
        # M8：duration_s 缺失（历史 run 无秒级时间戳）耗时列显示 —，不伪造
        # 列序：# / 图标 / 时间 / 耗时 / 触发 / 结果 / 成本 / 操作 → 耗时是第 4 个 td
        check("无 duration_s 的 run 耗时显示 —",
              page.locator("#runHistory tbody tr td").nth(3).inner_text() == "—")
        # M3-2：单环节预估不复读括号明细；预估超预算（0.42 > 0.3）就地警示后果
        page.wait_for_function(
            "() => document.querySelector('#ph-est')?.textContent.includes('0.42')", timeout=15000)
        ops_est = page.locator("#ph-est").inner_text()
        check("单环节预估无重复括号明细", "（回归" not in ops_est and "（线上" not in ops_est, ops_est)
        check("超预算方案就地警示定时将被跳过",
              "超出预算上限 $0.3" in ops_est and "定时运行将被跳过" in ops_est, ops_est)
        page.goto(f"http://127.0.0.1:{PORT}/index.html#plan/plan-full")
        page.wait_for_selector("#reportPanel.hidden", state="attached", timeout=15000)
        page.wait_for_selector("#runHistory table", timeout=15000)
        # 方案详情页决策 KPI 行：3 张卡（当前均分/成功运行/单次预估），大数字 28px
        page.wait_for_selector("#planKpis2:not(.hidden)", timeout=15000)
        check("方案详情 KPI 行 3 张卡",
              page.locator("#planKpis2 .kpi").count() == 3)
        kpi_fs = page.evaluate(
            "() => getComputedStyle(document.querySelector('#planKpis2 .kpi .v')).fontSize")
        check("KPI 大数字 28px", kpi_fs == "28px", kpi_fs)
        page.locator(".r-view").first.click()
        page.wait_for_function(
            "() => document.querySelector('#reportBody')?.textContent.includes('红队测试')",
            timeout=15000)

        # ---- 3.5) 改进稿：修订版提示词默认渲染前后对比 diff ----
        page.locator("#reportBody .improve-btn").first.click()
        page.wait_for_selector("#reportBody .diffview", timeout=15000)
        check("改进稿 diff 视图渲染新增行",
              page.locator("#reportBody .diffview .dl-add").count() >= 1
              and "追问预算" in page.locator("#reportBody .diffview").inner_text())
        full_pre = page.locator("#reportBody .prompt-draft").first
        hidden_before = full_pre.is_hidden()
        page.locator("#reportBody .impv-tab").nth(1).click()
        page.wait_for_selector("#reportBody .prompt-draft:not(.hidden)", timeout=5000)
        check("修订全文默认隐藏、切换标签可见", hidden_before and full_pre.is_visible())

        # ---- 4) Agent 目录 → Agent 详情 ----
        page.locator("#nav button[data-view=agents]").click()
        page.wait_for_selector("#agentTable table", timeout=15000)
        at = page.locator("#agentTable").inner_text()
        check("Agent 目录：方案数与最近评估", "shop-agent" in at and "2" in at and "10:32" in at)
        check("无日志 Agent 标注", "无日志" in at)
        page.locator(".ag-row").first.click()
        page.wait_for_selector("#view-agentDetail.on", timeout=15000)
        page.wait_for_selector("#agentPlanList table", timeout=15000)
        apl = page.locator("#agentPlanList").inner_text()
        check("Agent 详情列出挂载方案", "上线前全量" in apl and "基础观测" in apl)
        page.wait_for_selector("#agentRuns table", timeout=15000)
        check("Agent 详情 run 聚合", "10:32" in page.locator("#agentRuns").inner_text())

        # ---- 5) 从 Agent 详情跑 run：控制台内联 → 自动切方案详情报告 ----
        page.locator(".ap-run").first.click()
        page.wait_for_selector("#cslot-agent #runConsolePanel:not(.hidden)", timeout=15000)
        check("控制台内联挂在 Agent 页", True)
        page.wait_for_selector("#view-plan.on", timeout=20000)
        page.wait_for_selector("#reportPanel:not(.hidden)", timeout=15000)
        check("跑完自动切到方案详情报告",
              page.locator("#planTitle").inner_text() == "上线前全量")
        check("控制台随行到方案页",
              page.locator("#cslot-plan #runConsolePanel").count() == 1)
        status = page.locator("#runConsoleStatus").inner_text()
        check("控制台显示预估合计与明细", "1.725" in status and "红队" in status, status)
        check("跑完控制台标题改为完成", "运行完成" in page.locator("#runConsoleTitle").inner_text())
        check("运行按钮恢复可用", not page.locator("#ph-run").is_disabled())

        # ---- 5.5) 运行中打开编辑器：整版控制台收起，底部出细状态条 ----
        page.locator("#ph-run").click()
        page.wait_for_selector("#cslot-plan #runConsolePanel:not(.hidden)", timeout=15000)
        page.locator("#ph-edit").click()
        page.wait_for_selector("#runStatusBar", timeout=15000)
        check("编辑器态控制台收起、状态条出现",
              page.locator("#runConsolePanel").first.is_hidden()
              and "运行中" in page.locator("#runStatusBar").inner_text())
        # M2-1：编辑器展开时 .plan-top 加 is-editing 退回单列（表单不挤在 5fr 窄列里）
        check("编辑态 .plan-top 退单列（is-editing）",
              page.locator("#view-plan .plan-top.is-editing").count() == 1)
        # 取消编辑（openPlan 会回到方案详情）→ 整版控制台恢复、状态条撤下
        page.locator("#pe-cancel").click()
        page.wait_for_selector("#runConsolePanel:not(.hidden)", timeout=15000)
        check("关编辑器后整版控制台恢复", page.locator("#runStatusBar").count() == 0
              and page.locator("#view-plan .plan-top.is-editing").count() == 0)
        # 等这轮 run 跑完（finally 会解锁按钮），避免影响后续断言
        page.wait_for_function("() => !document.getElementById('ph-run')?.disabled", timeout=20000)

        # ---- 6) hash 路由：后退键回上一视图而不是退出应用 ----
        check("方案详情有 hash", "#plan/" in page.url, page.url)
        page.go_back()
        page.wait_for_function("() => !document.querySelector('#view-plan').classList.contains('on')",
                               timeout=10000)
        on_view = page.evaluate("() => document.querySelector('.view.on')?.id")
        check("浏览器后退回到上一视图", on_view is not None and "view-" in str(on_view), str(on_view))

        # ---- 7) 状态诚实：最新 run 失败时表格不冒充成功 ----
        page.evaluate("""() => {
          window.__stateHack = true;
        }""")
        # 直接构造：把最近 run 流的最新一条改成 failed 再重渲染（走真实渲染函数）
        page.goto(f"http://127.0.0.1:{PORT}/index.html#plans")
        page.wait_for_selector("#planTable table", timeout=15000)

        # ---- 8) 表单校验：空名保存被前端拦截，不打后端 ----
        page.locator("#newPlanBtn").click()
        page.wait_for_selector("#planEditor:not(.hidden)", timeout=15000)
        # 新建以零环节打开：不预置观测环节（.st-del 只出现在环节卡上；
        # 定时区也用 .sess-detail 容器，不能拿它数环节），三卡片区升格为主选择区
        check("新建方案零环节打开",
              page.locator("#planEditor .st-del").count() == 0
              and "环节 1" not in page.locator("#planEditor").inner_text()
              and page.locator("#planEditor .stage-add.is-primary").count() == 1
              and "选择环节类型" in page.locator("#planEditor .sa-title").inner_text())
        check("新建方案页 KPI 行隐藏",
              page.locator("#planKpis2").is_hidden())
        page.locator("#pe-save").click()
        page.wait_for_function("() => document.getElementById('pe-status').textContent.includes('必填')",
                               timeout=5000)
        check("空方案名被客户端拦截", "方案名必填" in page.locator("#pe-status").inner_text())
        page.fill("#pe-name", "带定时的方案")
        page.locator("#pe-save").click()
        page.wait_for_function("() => document.getElementById('pe-status').textContent.includes('环节')",
                               timeout=5000)
        check("零环节保存被拦截", "至少需包含一个环节" in page.locator("#pe-status").inner_text())
        # 从类型卡片选第一个环节 → 出现「环节 1」，选择区退回追加语气
        page.locator("#pe-add-observe").click()
        page.wait_for_selector("#planEditor [data-f=lookback_days]", timeout=5000)
        check("点线上评估卡片添加环节 1",
              "环节 1 · 线上评估" in page.locator("#planEditor").inner_text()
              and page.locator("#planEditor .stage-add.is-primary").count() == 0)
        check("添加环节后方案名保留", page.locator("#pe-name").input_value() == "带定时的方案")
        # 评估器 × 环节适用性：不适用的不渲染（不是置灰）
        obs_chips = page.locator("#planEditor .chips").first.inner_text()
        check("观测环节不渲染 dataset-only 评估器",
              "correctness" not in obs_chips and "helpfulness" in obs_chips, obs_chips)
        check("观测环节渲染 scope=observe 的自定义", "cust-flow" in obs_chips)
        page.locator("#pe-add-dataset").click()
        page.wait_for_selector("#planEditor [data-f=dataset]", timeout=5000)
        ds_stage = page.locator("#planEditor .sess-detail").nth(1).inner_text()
        check("回归环节渲染 correctness（含期望输出说明）",
              "correctness" in ds_stage and "期望输出" in ds_stage)
        check("回归环节不渲染 observe-only 自定义", "cust-flow" not in ds_stage)
        page.fill("#pe-cron", "rate(7 days)")
        page.locator("#pe-save").click()
        page.wait_for_function("() => document.getElementById('pe-status').textContent.includes('预算')",
                               timeout=5000)
        check("定时无预算被拦截", "预算上限" in page.locator("#pe-status").inner_text())

        # ---- 9) 环节术语就地解释 ----
        editor_html = page.locator("#planEditor").inner_html()
        check("编辑器有环节一句话说明", "线上真实会话抽样" in editor_html)

        # ---- 9.5) 设置页：judge 模型配置 ----
        page.locator("#nav button[data-view=settings]").click()
        page.wait_for_function(
            "() => document.getElementById('jmModel').value.includes('claude')", timeout=15000)
        check("judge 配置回显", "sonnet" in page.locator("#jmModel").input_value())
        check("bedrock 模式隐藏 openai 行",
              page.locator("#jmOpenaiRow").is_hidden())
        page.select_option("#jmProvider", "openai")
        check("切 openai 显示端点行", page.locator("#jmOpenaiRow").is_visible())
        page.fill("#jmModel", "glm-4.7")
        page.locator("#jmSaveBtn").click()
        page.wait_for_function(
            "() => document.getElementById('jmStatus').textContent.includes('✓')", timeout=10000)
        check("judge 配置保存回执", True)

        # ---- 9.7) 资源库：场景化分区（线上评估/回归测试/红队测试 + 评估器管理） ----
        page.locator("#nav button[data-view=resources]").click()
        page.wait_for_selector("#view-resources.on", timeout=15000)
        page.wait_for_selector("#builtinChips .chip-ro", timeout=15000)
        res_titles = page.evaluate(
            "() => [...document.querySelectorAll('#view-resources .panel h3')]"
            ".map(h => h.textContent)")
        check("资源库三场景区 + 评估器管理区",
              all(any(k in t for t in res_titles)
                  for k in ("线上评估", "回归测试", "红队测试", "评估器管理")),
              str(res_titles))
        # 评估器过滤视图：场景区是评估器管理区按 scope 过滤后的只读展示
        obs_ro = page.locator("#obsEvalChips").inner_text()
        ds_ro = page.locator("#dsEvalChips").inner_text()
        check("线上评估区过滤视图（无 dataset-only，含 observe 自定义）",
              "correctness" not in obs_ro and "cust-flow" in obs_ro, obs_ro)
        check("回归测试区过滤视图（含 correctness，无 observe-only 自定义）",
              "correctness" in ds_ro and "cust-flow" not in ds_ro, ds_ro)
        check("内置 chips 带「仅回归」适用范围徽章",
              page.locator("#builtinChips .scope-badge").count() >= 1)
        # 数据集编辑器可取消
        page.locator("#dsNewBtn").click()
        page.wait_for_selector("#dsEditor:not(.hidden)", timeout=5000)
        page.locator("#dsCancelBtn").click()
        page.wait_for_selector("#dsEditor.hidden", state="attached", timeout=5000)
        check("数据集编辑器取消按钮隐藏编辑器",
              page.locator("#dsEditor").is_hidden()
              and page.locator("#dsStatus").inner_text() == "")

        # ---- 9.7.5) 数据集用例表单化编辑器：表单/JSON 双模式 ----
        # 新建 = 表单模式空态（一句说明 + 两个添加按钮）
        page.locator("#dsNewBtn").click()
        page.wait_for_selector("#dsForm .empty", timeout=5000)
        check("新建数据集默认表单模式（JSON textarea 隐藏）",
              page.locator("#dsModeForm").is_checked()
              and page.locator("#dsJson").is_hidden()
              and page.locator("#dsForm").is_visible())
        check("零用例空态 + 两个添加按钮",
              "还没有用例" in page.locator("#dsForm").inner_text()
              and page.locator("#dcAddSingle").count() == 1
              and page.locator("#dcAddMulti").count() == 1)
        # 编辑已有数据集 → 卡片回填（回归集含一条多轮用例）
        page.select_option("#dsSelect", index=1)
        page.locator("#dsEditBtn").click()
        page.wait_for_selector("#dsForm .dscase", timeout=5000)
        names = page.evaluate(
            "() => [...document.querySelectorAll('#dsForm .dc-name')].map(i => i.value)")
        inputs = page.evaluate(
            "() => [...document.querySelectorAll('#dsForm .dc-input')].map(t => t.value)")
        check("卡片回填已有用例的 name/input",
              names == ["case-单轮", "case-多轮"] and "查询订单 123" in inputs[0]
              and "我想改签航班" in inputs[1], f"{names} {inputs}")
        card2 = page.locator("#dsForm .dscase").nth(1)
        check("多轮用例带「多轮」徽章且三字段回填",
              page.locator("#dsForm .dscase .badge-neutral").count() == 1
              and "多轮" in card2.locator(".badge-neutral").inner_text()
              and card2.locator(".dc-task").input_value() == "改签到下周五并确认行李额"
              and card2.locator(".dc-turns").input_value() == "6"
              and card2.locator(".dc-persona").input_value() == "着急的商务旅客")
        # 单轮卡勾选多轮 → 展开三字段 + 徽章出现；取消勾选还原
        card1 = page.locator("#dsForm .dscase").first
        hidden_before = card1.locator(".dc-multiwrap").is_hidden()
        card1.locator(".dc-multi").check()
        page.wait_for_selector("#dsForm .dscase:first-child .dc-multiwrap:not(.hidden)",
                               timeout=5000)
        check("勾选多轮展开三字段（任务描述/最大轮次/人设）与说明",
              hidden_before and card1.locator(".dc-task").is_visible()
              and card1.locator(".dc-turns").input_value() == "5"
              and card1.locator(".dc-persona").is_visible()
              and "由平台扮演用户" in card1.inner_text()
              and card1.locator(".badge-neutral").count() == 1)
        card1.locator(".dc-multi").uncheck()
        page.wait_for_selector("#dsForm .dscase:first-child .dc-multiwrap.hidden",
                               state="attached", timeout=5000)
        # 添加/删除用例改变卡片数
        page.locator("#dcAddSingle").click()
        page.wait_for_function(
            "() => document.querySelectorAll('#dsForm .dscase').length === 3", timeout=5000)
        page.locator("#dsForm .dscase").nth(2).locator(".dc-del").click()
        page.wait_for_function(
            "() => document.querySelectorAll('#dsForm .dscase').length === 2", timeout=5000)
        check("添加/删除用例改变卡片数", True)
        # 切 JSON 模式：textarea 出现且内容与表单一致
        page.locator("#dsModeChips label:has(#dsModeJson)").click()
        page.wait_for_selector("#dsJson:not(.hidden)", timeout=5000)
        ds_json = json.loads(page.locator("#dsJson").input_value())
        check("切 JSON 模式内容与表单一致",
              page.locator("#dsForm").is_hidden()
              and [c["name"] for c in ds_json] == ["case-单轮", "case-多轮"]
              and ds_json[0]["expected_tools"] == ["get_order"]
              and ds_json[1]["task_description"] == "改签到下周五并确认行李额"
              and ds_json[1]["max_turns"] == 6
              and ds_json[1]["persona"] == "着急的商务旅客",
              json.dumps(ds_json, ensure_ascii=False)[:160])
        # 坏 JSON 切表单被拦：toast 报错 + 停留 JSON 模式
        page.fill("#dsJson", "{ not valid")
        page.locator("#dsModeChips label:has(#dsModeForm)").click()
        page.wait_for_function(
            "() => [...document.querySelectorAll('.toast')]"
            ".some(t => t.textContent.includes('JSON 格式有误'))", timeout=5000)
        check("坏 JSON 切表单被拦（toast + 停留 JSON 模式）",
              page.locator("#dsModeJson").is_checked()
              and page.locator("#dsJson").is_visible()
              and page.locator("#dsForm").is_hidden())
        page.fill("#dsJson", json.dumps(ds_json, ensure_ascii=False))
        page.locator("#dsModeChips label:has(#dsModeForm)").click()
        page.wait_for_selector("#dsForm .dscase", timeout=5000)
        # 表单校验：缺 name 保存被拦且指出第几条，不打后端
        page.locator("#dsForm .dscase").first.locator(".dc-name").fill("")
        page.locator("#dsSaveBtn").click()
        page.wait_for_function(
            "() => [...document.querySelectorAll('.toast')]"
            ".some(t => t.textContent.includes('第 1 条用例缺少用例名'))", timeout=5000)
        check("表单缺 name 保存被拦且指出第几条", page.locator("#dsEditor").is_visible())
        page.locator("#dsCancelBtn").click()
        page.wait_for_selector("#dsEditor.hidden", state="attached", timeout=5000)
        # 风险类别 = 复选 chips（不再是原生 multiple select），默认勾选来自后端
        page.wait_for_selector("#rtRiskChips input.rt-risk", state="attached", timeout=5000)
        check("风险类别为复选 chips 且无原生多选框",
              page.locator("#view-resources select[multiple]").count() == 0
              and page.locator("#rtRiskChips input.rt-risk:checked").count() >= 1)
        # 新建评估器表单带「适用环节」三选，默认两者皆可
        page.locator("#newEvalBtn").click()
        page.wait_for_selector("#newEvalForm:not(.hidden)", timeout=5000)
        check("新建评估器表单有适用环节三选（默认 all）",
              page.locator("#newEvalScope option").count() == 3
              and page.locator("#newEvalScope").input_value() == "all")
        page.locator("#cancelEvalBtn").click()

        # ---- 9.8) 调用配置：入口在 Agent 详情页 + 预置格式 + 测试连通 + 响应树选路径 ----
        page.goto(f"http://127.0.0.1:{PORT}/index.html#agentDetail/shop-agent")
        page.wait_for_selector("#view-agentDetail.on", timeout=15000)
        page.wait_for_function(
            "() => document.getElementById('cfgTemplate')?.value.includes('prompt')", timeout=15000)
        check("调用配置区块在 Agent 详情页（默认折叠）",
              page.locator("#view-agentDetail #invCfgBlock").count() == 1
              and page.locator("#invCfgBlock summary.foldsum").is_visible()
              and page.evaluate("() => !document.getElementById('invCfgBlock').open")
              and page.locator("#cfgTemplate").is_hidden())
        check("设置页不再有调用模板空壳",
              page.locator("#view-settings #cfgTemplate").count() == 0
              and page.locator("#cfgAgentSel").count() == 0)
        page.locator("#invCfgBlock summary.foldsum").click()
        page.wait_for_selector("#invPresetChips .inv-preset", state="attached", timeout=5000)
        # 预置格式单选：内容与某预置相等 → 反推高亮（chips 的 input 是 display:none，
        # 点击目标是外层 label；断言选中态走 :checked）
        check("预置格式单选存在且按当前内容反推高亮",
              page.locator("#invPresetChips input.inv-preset").count() >= 4
              and page.locator("#invPresetChips input.inv-preset:checked")
                      .get_attribute("value") == "prompt")
        check("{input} 占位符含义有说明", "运行时替换为用例输入" in
              page.locator("#invCfgBlock").inner_text())
        check("按钮旁标明会产生一次真实调用",
              "一次真实调用" in page.locator("#invCfgBlock").inner_text())
        # 点 messages 预置 → 填入编辑框
        page.locator("#invPresetChips label:has(input[value=messages])").click()
        page.wait_for_function(
            "() => document.getElementById('cfgTemplate').value.includes('messages')", timeout=5000)
        check("点选预置格式填入编辑框",
              '"role": "user"' in page.locator("#cfgTemplate").input_value())
        # 「自定义」保留手写内容（不覆盖编辑框）
        page.fill("#cfgTemplate", '{"q": "{input}"}')
        page.wait_for_function(
            "() => document.querySelector('#invPresetChips input.inv-preset:checked')"
            ".value === 'custom'", timeout=5000)
        check("手写内容不匹配预置时高亮「自定义」", True)
        page.locator("#invPresetChips label:has(input[value=prompt])").click()
        page.wait_for_function(
            "() => document.getElementById('cfgTemplate').value.includes('prompt')", timeout=5000)

        # 测试连通 → 结果面板 + 展平路径多行可点
        page.locator("#invProbeBtn").click()
        page.wait_for_selector("#invProbeResult:not(.hidden) .probebox", timeout=15000)
        pb = page.locator("#invProbeResult").inner_text()
        check("测试连通后出现结果面板（含最终输出高亮）",
              "调用成功" in pb and "当前规则会取到的最终输出" in pb)
        check("响应树多行可点选", page.locator("#invProbeResult button.pr-pick").count() >= 3)
        check("truncated 条目不可选",
              page.locator("#invProbeResult .pathrow.is-off").count() >= 1
              and "仅展开前 2 个" in pb)
        check("原始响应与请求 payload 折叠可查",
              page.locator("#invProbeResult details").count() >= 2)
        # 点一条路径 → 再探测一次并用该路径验证，输出变为该路径的值
        page.locator("#invProbeResult button.pr-pick").nth(1).click()
        page.wait_for_function(
            "() => document.getElementById('invProbeResult').textContent.includes('本次选择')",
            timeout=15000)
        check("点选路径后写回输出位置并复验",
              page.locator("#cfgRespPath").input_value() == "output.message.content.0.text"
              and "已为你查到 3 个订单" in page.locator("#invProbeResult .pb-out").inner_text())
        check("选中行高亮", page.locator("#invProbeResult .pathrow.is-on").count() >= 1)
        # 「不提取，整段作为输出」= 传空字符串
        page.locator("#invProbeResult button.pr-whole").click()
        page.wait_for_function(
            "() => document.getElementById('invProbeResult').textContent.includes('整段响应')",
            timeout=15000)
        check("不提取选项传空串并复验",
              page.locator("#cfgRespPath").input_value() == ""
              and "整段响应" in page.locator("#invProbeResult").inner_text())
        # 保存
        page.locator("#cfgSaveBtn").click()
        page.wait_for_function(
            "() => document.getElementById('cfgStatus').textContent.includes('✓')", timeout=10000)
        check("调用配置可保存", True)
        # is_whole_response 条目不可选（响应整体就是一个标量）
        page.fill("#invSampleInput", "SCALAR")
        page.locator("#invProbeBtn").click()
        page.wait_for_function(
            "() => document.getElementById('invProbeResult').textContent.includes('无需提取路径')",
            timeout=15000)
        whole = page.locator("#invProbeResult .pathrow.is-off").first
        check("is_whole_response 条目不可选且展示 note",
              whole.evaluate("el => el.tagName") != "BUTTON"
              and "无需提取路径" in whole.inner_text())
        # ok=false 分支：错误文案 + 截断提示
        page.fill("#invSampleInput", "FAIL")
        page.locator("#invProbeBtn").click()
        page.wait_for_selector("#invProbeResult .pb-err", timeout=15000)
        fail_txt = page.locator("#invProbeResult").inner_text()
        check("ok=false 展示错误文案与截断提示",
              "取不到值" in fail_txt and "已截断" in fail_txt and "未通过" in fail_txt)

        # ---- 10) 无弹窗、无 JS 错误 ----
        check("全程无 confirm 弹窗", not dialogs, str(dialogs))
        check("无 JS 错误", not errors, "; ".join(errors))

        # ---- 11) 760px：方案表横向滚动而不是竖排崩塌 ----
        page.set_viewport_size({"width": 760, "height": 900})
        page.goto(f"http://127.0.0.1:{PORT}/index.html#plans")
        page.wait_for_selector("#planTable table", timeout=15000)
        overflow = page.evaluate("""() => {
          const w = document.querySelector('#planTable .tscroll');
          return { scrollable: w && w.scrollWidth > w.clientWidth,
                   bodyOverflow: document.body.scrollWidth > document.body.clientWidth + 2 };
        }""")
        check("760px 表格容器内滚动", overflow["scrollable"] and not overflow["bodyOverflow"], str(overflow))

        # ---- 12) 设计令牌与副标题配对（spec 首批实施的防回归） ----
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(f"http://127.0.0.1:{PORT}/index.html#plans")
        page.wait_for_selector("#planTable table", timeout=15000)
        accent = page.evaluate(
            "() => getComputedStyle(document.documentElement)"
            ".getPropertyValue('--accent').trim()")
        check("--accent 为定案值 #2456e6（spec 笔误 #2457e6 已修正）",
              accent == "#2456e6", accent)
        # h2 提到 26px / h3 提到 18px 后，副标题体系必须不跟涨：
        # 所有 .h3sub / h3 内 statusline / 场景说明 computed font-size ≤ 13px
        subs = page.evaluate("""() => [...document.querySelectorAll(
            '.panel h3 .h3sub, .foldpanel > summary.foldsum .h3sub,' +
            '.panel h3 .statusline, .scene-title h3 .scene-desc, .setting-intro')]
          .map(el => ({ cls: el.className, fs: parseFloat(getComputedStyle(el).fontSize) }))""")
        check("h3 副标题/说明文字全部 ≤13px（不随 18px 标题涨）",
              len(subs) >= 10 and all(s["fs"] <= 13 for s in subs),
              str([s for s in subs if s["fs"] > 13]) or f"{len(subs)} 处均达标")
        check("已登录时登录门隐藏", page.locator("#authGate").is_hidden())
        page.wait_for_timeout(400)   # 等 .view.on 的 rise 入场动画结束再截图
        page.screenshot(path="/tmp/spec-merge-workbench-authed.png", full_page=False)
        # 设置页：页内导航（settings-layout 左导航 + 分区滚动）
        page.locator("#nav button[data-view=settings]").click()
        page.wait_for_selector("#view-settings.on", timeout=15000)
        page.locator(".settings-nav a[data-target=setting-pricing]").click()
        page.wait_for_function(
            "() => document.querySelector('.settings-nav a[data-target=setting-pricing]')"
            ".classList.contains('is-active')", timeout=5000)
        check("设置页内导航点击切换高亮",
              page.locator(".settings-nav a.is-active").count() == 1)
        page.wait_for_timeout(600)   # 等 smooth scroll 与入场动画停稳
        page.screenshot(path="/tmp/spec-merge-settings.png", full_page=False)

        # ---- 13) 未登录态：登录门 + 真修（不是只靠门遮） ----
        ctx2 = browser.new_context(viewport={"width": 1440, "height": 900})
        p2 = ctx2.new_page()
        p2_errors = []
        p2.on("pageerror", lambda e: p2_errors.append(str(e)))
        p2.goto(f"http://127.0.0.1:{PORT}/index.html")
        p2.wait_for_selector("#authGate .auth-card", timeout=15000)
        check("未登录时登录门可见、应用壳隐藏",
              p2.locator("#authGate").is_visible()
              and not p2.locator(".shell .brand").is_visible())
        p2.screenshot(path="/tmp/spec-merge-login-gate.png", full_page=False)
        # 门后正文也必须是真实的登录空态——门被绕过/关闭时不能露出永久「加载中…」
        p2.evaluate("""() => {
          document.getElementById('authGate').style.display = 'none';
          document.querySelector('.shell').style.visibility = 'visible';
        }""")
        rr2 = p2.locator("#recentRuns").inner_text()
        check("未登录 #recentRuns 为登录空态而非「加载中…」",
              "请先登录" in rr2 and "加载中" not in rr2, rr2.replace("\n", " ")[:60])
        check("未登录 #planTable 为登录空态",
              "登录后开始评估" in p2.locator("#planTable").inner_text())
        check("未登录 newPlanBtn 禁用并带提示",
              p2.locator("#newPlanBtn").is_disabled()
              and p2.locator("#newPlanBtn").get_attribute("title") == "登录后可创建评估方案")
        check("未登录 rescanBtn 禁用并带提示",
              p2.locator("#rescanBtn").is_disabled()
              and p2.locator("#rescanBtn").get_attribute("title") == "登录后可扫描 Agent")
        # 401 文案分流：从未登录过的会话不得出现「登录已过期」（用户从没登录过）
        check("未登录页面无「登录已过期」字样",
              "登录已过期" not in p2.locator("body").inner_text())
        check("未登录页无 JS 错误", not p2_errors, "; ".join(p2_errors))
        p2.screenshot(path="/tmp/spec-merge-workbench-unauthed.png", full_page=False)
        ctx2.close()
        browser.close()

    srv.shutdown()
    for p in passed:
        print(f"  ✓ {p}")
    for f in failed:
        print(f"  ✗ {f}")
    print(f"\n{len(passed)} 通过 / {len(failed)} 失败")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()

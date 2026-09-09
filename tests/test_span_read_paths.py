"""span 读路的唯一正典：`tracesource.read_plans` 的产物 = 谁去哪个组、带哪些过滤、限哪条流。

为什么单独一个文件钉它：同一个问题「这个 Agent 的 span 该怎么读」曾经有**四处**各自的答案
（read_plans / agentstatus.query_status_rows / planrun._trace_span_groups+check_agent_traces /
tracesource.fetch_scoring_session），其中两处判据可量地不一致。本文件先把**收口前**的实际
取值逐格钉住（下表 = 2026-09-08 对本仓 35acd22 实跑 `/tmp/probe_matrix.py` 的读数，不是推论），
再让收口后的实现逐格对上；哪一格故意改了，改在下表里并写明依据。

两派 cfg（现网两种埋点分流，见 tracesource 文件头）：
  · dsh 派  = 配了 span_source → cfg{log_group: aws/spans, service_filter: deepseek-harness,
              fallback_log_group: 自己的 runtime 组}
  · fable5 派 = 没配 span 源   → cfg{log_group: 自己的 runtime 组}，**无** fallback

收口前（35acd22）三处判据 × 两派 cfg 的实际取值：

  | 读路                        | dsh 主源 aws/spans        | dsh 回退 runtime 组            | fable5 主源 = runtime 组 |
  |-----------------------------|---------------------------|--------------------------------|--------------------------|
  | read_plans（正典）          | svc=deepseek-harness,流=- | svc=**空**, 流=spans           | svc=空, 流=**空**        |
  | 核对 check_agent_traces     | svc=deepseek-harness,流=- | svc=**deepseek-harness**,流=spans | svc=平台排除, 流=**spans** |
  | 取数 fetch_scoring_session  | svc=deepseek-harness,流=- | svc=空, 流=spans               | svc=空, 流=**空**        |
  | 五个数 query_status_rows    | svc=deepseek-harness,流=- | svc=空, 流=spans               | svc=空, 流=**空**        |

  两处可量分歧（表里加粗处）：
  (a) dsh 回退组的 service 过滤：核对带着主源的 service_filter 去查回退组，正典明确清空它
      （`_cfg_with_fallback` / `read_plans` docstring：那两个过滤器是给共享组挑一个 service
      用的，专属组里只有这一个 agent 的 span，带上去只会把真数据全滤掉）。
  (b) fable5 主源（= 自己的 runtime 组）的流限定：核对按**组名前缀**判，所以限了 `spans` 流；
      正典按**结构**判（只有回退项限流），所以取数 / 五个数读整组。⇒ 同一个 Agent「核对只数
      spans 流、取数读整组」。

收口口径（本批，已落）：正典多一个显式参数 `spans_only`，把 (b) 这条分歧变成正典里**写明
理由的一个档位**（核对口径 = 专属组一律只认 spans 流；判据仍是「组名带 LOG_GROUP_PREFIX
前缀」，与收口前 check_agent_traces 那句逐字同一个谓词 ⇒ (b) 的两行读数逐字节不变），取数
口径不动；(a) 按正典的理由统一成清空 —— **本批唯一改动的一格**，就在 CheckReadings
.test_dsh_family 的第二行。

运行：python3 -m pytest tests/test_span_read_paths.py -q
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

import agentstatus  # noqa: E402
import catalog  # noqa: E402
import planrun  # noqa: E402
import tracesource  # noqa: E402

DSH_RUNTIME_GROUP = "/aws/bedrock-agentcore/runtimes/dshAgentCoreEval-AbC123-DEFAULT"
F5_RUNTIME_GROUP = "/aws/bedrock-agentcore/runtimes/tauairline_airlineagent_v3-EXAMPLE0002-DEFAULT"
CENTRAL = tracesource.CENTRAL_SPANS_LOG_GROUP

AGENT_DSH = {"agent_name": "dshAgentCoreEval", "log_group": CENTRAL,
             "runtime_id": "dshAgentCoreEval-AbC123",
             "span_source": {"log_group": CENTRAL, "scope_filter": "",
                             "service_filter": "deepseek-harness"}}
AGENT_F5 = {"agent_name": "tauairline_airlineagent_v3", "log_group": F5_RUNTIME_GROUP,
            "runtime_id": "tauairline_airlineagent_v3-EXAMPLE0002"}

PLATFORM_EXCLUDE = f'resource.attributes.service.name != "{tracesource.PLATFORM_SERVICE_NAME}"'


def _cfg(agent: dict) -> dict:
    """真 resolve_span_config（不碰 DynamoDB：dsh 走内存 span_source，fable5 桩成未配）。"""
    with mock.patch.object(catalog, "get_span_source", return_value={}):
        return tracesource.resolve_span_config(agent)


def _service_clause(query: str) -> str:
    """查询里那条 service.name 过滤子句（没有 ⇒ 空串）。"""
    for part in query.split("|"):
        part = part.strip()
        if part.startswith("filter") and "resource.attributes.service.name" in part:
            return part
    return ""


def _stream_clause(query: str) -> str:
    for part in query.split("|"):
        part = part.strip()
        if part.startswith("filter") and "@logStream" in part:
            return part
    return ""


class ReadPlansIsTheOneSource(unittest.TestCase):
    """正典的产物逐格钉住（两派 cfg）。"""

    def test_dsh_family_has_primary_plus_fallback(self):
        plans = tracesource.read_plans(_cfg(AGENT_DSH))
        self.assertEqual(plans, [
            {"log_group": CENTRAL, "scope_filter": "", "service_filter": "deepseek-harness",
             "log_stream": "", "span_origin": tracesource.ORIGIN_CENTRAL},
            {"log_group": DSH_RUNTIME_GROUP, "scope_filter": "", "service_filter": "",
             "log_stream": tracesource.RUNTIME_SPANS_STREAM,
             "span_origin": tracesource.ORIGIN_RUNTIME_GROUP},
        ])

    def test_fable5_family_has_one_plan_reading_the_whole_group(self):
        plans = tracesource.read_plans(_cfg(AGENT_F5))
        self.assertEqual(plans, [
            {"log_group": F5_RUNTIME_GROUP, "scope_filter": "", "service_filter": "",
             "log_stream": "", "span_origin": tracesource.ORIGIN_RUNTIME_GROUP},
        ])


class CheckReadings(unittest.TestCase):
    """核对口径（planrun 环节结束后那步）真发出去的查询，按组逐条。"""

    def _readings(self, agent: dict) -> list[tuple[str, str, str]]:
        seen: list[tuple[str, str, str]] = []

        def fake_query(log_group, query, lookback_days):
            seen.append((log_group, _service_clause(query), _stream_clause(query)))
            return []

        with mock.patch.object(catalog, "get_span_source", return_value={}), \
                mock.patch.object(tracesource, "_run_insights_query", side_effect=fake_query), \
                mock.patch.object(planrun, "TRACE_CHECK_BACKOFF", (0,)):
            asyncio.run(planrun._check_traces(agent, ["evaltest-a"]))
        return seen

    def test_dsh_family(self):
        self.assertEqual(self._readings(AGENT_DSH), [
            (CENTRAL, 'filter resource.attributes.service.name = "deepseek-harness"', ""),
            # (a) 收口后：回退组不再继承主源的 service_filter —— 正典清空它（专属组里
            #     只有这一个 agent 的 span，带上共享组的 service 过滤只会把真数据全滤掉）。
            #     没有 service_filter ⇒ 判据退回「排掉平台自家那条 InvokeAgentRuntime」。
            (DSH_RUNTIME_GROUP,
             f"filter not ispresent(resource.attributes.service.name) or {PLATFORM_EXCLUDE}",
             'filter @logStream = "spans"'),
        ])

    def test_fable5_family_pins_the_spans_stream(self):
        """(b) 核对口径：主源就是专属组时也只数 `spans` 流（stdout/otel-rt-logs 里的 JSON
        行也可能带 attributes.session.id，不限就是把应用日志数成 span）。"""
        self.assertEqual(self._readings(AGENT_F5), [
            (F5_RUNTIME_GROUP,
             f"filter not ispresent(resource.attributes.service.name) or {PLATFORM_EXCLUDE}",
             'filter @logStream = "spans"'),
        ])


class ScoringFetchReadings(unittest.TestCase):
    """取数口径（评分阶段按会话取全量记录）真发出去的读，按 (组, 流, 读法) 逐条。"""

    def _readings(self, agent: dict, sources: list[str]) -> list[tuple[str, str, str]]:
        seen: list[tuple[str, str, str]] = []

        def fake_low(log_group, session_id, lookback_days, streams=None):
            seen.append((log_group, (streams or [""])[0], "filter_log_events"))
            return []

        def fake_insights(log_group, session_id, lookback_days, scope_filter,
                          service_filter, log_stream=""):
            seen.append((log_group, log_stream, "insights"))
            return []

        with mock.patch.object(catalog, "get_span_source", return_value={}), \
                mock.patch.object(tracesource, "filter_span_records", side_effect=fake_low), \
                mock.patch.object(tracesource, "_fetch_central_session_records",
                                  side_effect=fake_insights):
            out = tracesource.fetch_scoring_session(_cfg(agent), "evaltest-a", sources)
        self.assertEqual(out, (None, "no_content"))
        return seen

    def test_dsh_family_primary_then_its_own_fallback(self):
        """主源那一趟自己就带回退（fetch_session 内部按 read_plans 短路），所以 sources 只有
        主源时照样会读到回退组的 spans 流 —— 但**走 Insights**：低延迟开关是按外层那一趟
        （主源 = 共享组 ⇒ False）定的，read_plans 的两项共用它。"""
        self.assertEqual(self._readings(AGENT_DSH, [CENTRAL]), [
            (CENTRAL, "", "insights"),
            (DSH_RUNTIME_GROUP, "spans", "insights"),
        ])

    def test_dsh_family_both_sources(self):
        """回退组被读**两遍**、两种读法：第一遍是主源那趟的内部短路（Insights），第二遍是
        外层第二个 source 自己那趟（低延迟）。收口不动这条 —— 它是 sources 与 cfg 各自
        带回退的叠加，属另一个问题。"""
        self.assertEqual(self._readings(AGENT_DSH, [CENTRAL, DSH_RUNTIME_GROUP]), [
            (CENTRAL, "", "insights"),
            (DSH_RUNTIME_GROUP, "spans", "insights"),
            (DSH_RUNTIME_GROUP, "spans", "filter_log_events"),
        ])

    def test_fable5_family_reads_the_whole_group(self):
        """(b) 取数口径不限流 —— 与核对那格不同，是本批**保留**的分歧（口径不同：核对在
        数条数，取数把非 span 的行交给 parser 丢掉）。"""
        self.assertEqual(self._readings(AGENT_F5, [F5_RUNTIME_GROUP]), [
            (F5_RUNTIME_GROUP, "", "filter_log_events"),
        ])


class StatusRowsReadings(unittest.TestCase):
    """五个数 / 拓扑那条路（正典唯一正确的消费者）：主源查到就不查回退。"""

    def _readings(self, agent: dict, rows_by_group: dict) -> list[tuple[str, str]]:
        seen: list[tuple[str, str]] = []

        def fake_query(log_group, query, lookback_days):
            seen.append((log_group, _stream_clause(query)))
            return rows_by_group.get(log_group, [])

        with mock.patch.object(catalog, "get_span_source", return_value={}), \
                mock.patch.object(agentstatus, "_run_insights_query", side_effect=fake_query):
            agentstatus.query_status_rows(_cfg(agent), 1)
        return seen

    def test_dsh_family_falls_back_only_when_primary_is_empty(self):
        self.assertEqual(self._readings(AGENT_DSH, {}), [
            (CENTRAL, ""), (DSH_RUNTIME_GROUP, 'filter @logStream = "spans"')])
        self.assertEqual(self._readings(AGENT_DSH, {CENTRAL: [[{"field": "sid", "value": "s"}]]}),
                         [(CENTRAL, "")])

    def test_fable5_family_reads_the_whole_group(self):
        self.assertEqual(self._readings(AGENT_F5, {}), [(F5_RUNTIME_GROUP, "")])


if __name__ == "__main__":
    unittest.main()

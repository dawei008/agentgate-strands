"""方案 run 的终态落库不许裸奔，被中断的 run 不许永远停在 running（P1，BH-004）。

两个缺陷同族，同一处代码：

1. `_persist` 的 `put_item` 没有 try。S3 报告**先写成功了**，DDB 写一失败
   （写限流重试耗尽 / 长 run 中凭证过期 / 传输错误）异常就穿出
   `execute_plan_run` → `main.py` 只 yield「方案运行失败」。而
   `get_plan_run` 必须先拿到 DDB item 才知道 `s3_key`
   ⇒ 已付费整次 run 的报告成为**永久孤儿**（S3 里有，谁也看不见）。
   对照：`testrun.py` / `redteam.py` 的终态保存都有兜底，且注释明写
   「付费结果不得丢」。planrun 是唯一裸奔的终态落库。

2. `execute_plan_run` 没有 try/finally。开跑先落的那条 `status="running"`
   marker 在任何未捕获异常路径上**永不收敛**（PlanDetailPage 的兜底文案
   「最终状态以运行历史为准」指向的就是这条不收敛的记录）。

修法的两条不变量（测试逐条钉住）：
  · 顺序不变量：S3 先写成功才写 s3_key；写失败留痕 report_error（既有行为）
  · 一次覆盖写：收敛用同一个 run_key 整条 put_item，绝不 update、绝不让终态
    字段与 running 残留字段混在一条里；缺的终态数字（score / stage_summaries）
    缺就缺，不伪造。

这里的 `finally` 只兜「进程还活着」的异常路径。Lambda 被硬杀时 finally 根本不
执行 —— 那条缺口**已由 UI-029 批 2 的陈旧 reaper 接手**（`app/stalecheck.py`
的三级判据 + `planrun.reap_stale_runs` 定时扫描改判），所以本文件钉的是
**当次进程内**的行为，跨窗口的收敛不在这儿看。

moto 的真 DynamoDB + 打桩 S3；不碰真表 / 真 agent / 真 LLM。
运行：python3 -m pytest tests/test_planrun_terminal_persist.py -q
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

TABLE = "eval-catalog-test"
BUCKET = "eval-artifacts-test"
REGION = "us-west-2"

PLAN = {
    "plan_id": "plan-1297bb07bc31",
    "name": "线上评估周巡检",
    "agent_name": "support-bot",
    "stages": [{"type": "observe", "evaluators": ["helpfulness"], "metrics": []}],
}
PLAN_2STAGE = {**PLAN, "stages": PLAN["stages"] * 2}
AGENT = {"agent_name": "support-bot", "agent_arn": "arn:aws:bedrock:x:y:runtime/z"}
SYNTHESIS = "## 整体趋势\n首个数据点，暂无趋势可言。"


def observe_result(mean: float = 0.83) -> dict:
    return {"type": "observe", "status": "completed", "sessions": 2,
            "summary": {}, "overall_mean": mean, "metrics": None,
            "session_details": [], "analysis": None,
            "evaluators": ["helpfulness"], "metric_keys": []}


class TerminalPersist(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        ddb = boto3.resource("dynamodb", region_name=REGION)
        self.table = ddb.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")

        import catalog
        import planrun
        self.planrun = planrun
        p = mock.patch.object(catalog, "get_table", return_value=self.table)
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch.dict(os.environ, {"ARTIFACTS_BUCKET": BUCKET})
        e.start()
        self.addCleanup(e.stop)
        # S3 打桩：只需要知道「报告落地了」和它的 key，不验 S3 本身
        self.s3 = mock.MagicMock()
        s = mock.patch.object(planrun.runstore, "_s3", return_value=self.s3)
        s.start()
        self.addCleanup(s.stop)

    # ---- 驱动 ----

    def _run(self, plan=PLAN, stage_results=None, put_fails_on=(),
             fail_forever_from=None):
        """跑一次 execute_plan_run。

        stage_results: 每个环节的返回值或要抛的异常（异常按顺序 raise）。
        put_fails_on / fail_forever_from: 让第 N 次 put_item 失败（1-based，
        第 1 次是开跑那条 running marker，之后是终态与降级写）。
        """
        results = list(stage_results or [observe_result()])
        calls = {"n": 0}
        real_put = self.table.put_item

        def flaky_put(**kw):
            calls["n"] += 1
            n = calls["n"]
            if n in put_fails_on or (fail_forever_from and n >= fail_forever_from):
                raise RuntimeError("ProvisionedThroughputExceededException")
            return real_put(**kw)

        async def emit(_ev):
            pass

        async def fake_observe(stage, agent, judge_model, emit_, stage_no=0):
            nxt = results.pop(0)
            if isinstance(nxt, BaseException):
                raise nxt
            return nxt

        with mock.patch.object(self.planrun, "_run_observe_stage", fake_observe), \
                mock.patch.object(self.planrun, "_generate_synthesis",
                                  new=mock.AsyncMock(return_value=SYNTHESIS)), \
                mock.patch.object(self.planrun, "latest_run_summary", return_value=None), \
                mock.patch.object(self.table, "put_item", side_effect=flaky_put):
            return asyncio.run(self.planrun.execute_plan_run(
                plan, AGENT, "judge-model", "manual", emit))

    def rows(self):
        return self.planrun.list_plan_runs(PLAN["plan_id"])

    def items(self):
        return self.table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq("PLANRUN"),
        ).get("Items", [])

    # ---- 缺陷 2-1：终态落库失败不许吃掉整次 run ----

    def test_summary_put_failure_does_not_kill_the_run(self):
        """终态 put_item 失败 → run 照常交出终帧，异常不许穿出。
        （修复前：异常穿出 execute_plan_run，前端只见「方案运行失败」）"""
        report = self._run(put_fails_on=(2,))
        self.assertEqual(report["run_key"].split("#")[0], PLAN["plan_id"])
        self.assertEqual(report["stages"][0]["status"], "completed")

    def test_s3_report_never_becomes_an_orphan(self):
        """S3 报告已写入而摘要项写失败 → 降级摘要项仍带 s3_key，报告能被找回。
        （get_plan_run 必须先拿到 DDB item 才知道 s3_key —— 这是孤儿的成因）"""
        report = self._run(put_fails_on=(2,))
        self.assertTrue(self.s3.put_object.called, "S3 报告根本没写，前提不成立")
        rows = self.rows()
        self.assertEqual(len(rows), 1, "一次 run 只许有一行（一次覆盖写）")
        row = rows[0]
        self.assertEqual(row["status"], "completed", "run 仍停在 running")
        self.assertTrue(row["s3_key"], "降级摘要项丢了 s3_key → 报告成孤儿")
        self.assertEqual(row["s3_key"], report["s3_key"])
        # 降级保存不许伪造、也不许丢真数字：分数与环节摘要照旧
        self.assertEqual(row["score"], 0.83)
        self.assertEqual(len(row["stage_summaries"]), 1)

    def test_degraded_item_says_why_the_synthesis_is_missing(self):
        """降级摘要项脱掉综合报告全文，但必须留痕说明原因（沉默会被读成
        「这次 run 本来就没有综合报告」）。

        留痕走**新字段** persist_error：
          · 不复用 report_error —— 它的现有语义正好相反（「报告缺失但摘要可用」，
            5 处活消费方含导出文案），这里是「摘要降级但报告在」；
          · 不复用 synthesis_error —— 前端把它渲染成「综合报告生成失败：…」，
            而综合报告生成是成功的。
        """
        self._run(put_fails_on=(2,))
        row = self.rows()[0]
        self.assertIsNone(row["plan_synthesis"])
        self.assertTrue(row["persist_error"])
        self.assertIn("降级", row["persist_error"])
        self.assertIsNone(row["synthesis_error"], "降级原因串到了「综合报告生成失败」")
        self.assertNotIn("report_error", self.items()[0],
                         "降级原因串到了 report_error（语义相反：那条说的是报告缺失）")

    def test_total_persist_failure_is_reported_on_the_run(self):
        """摘要项彻底写不进去（连降级也失败）→ 不抛异常，但在 run 上留
        persist_error（口径与 testrun/redteam 的终态兜底一致），s3_key 仍随终帧
        返回，报告至少在流里被点名。"""
        report = self._run(fail_forever_from=2)
        self.assertIn("结果落库失败", report.get("persist_error", ""))
        self.assertTrue(report["s3_key"])
        # 这一步之后 DDB 里只剩开跑那条 running marker。钉的是**当次进程内**
        # 仍是 running：本函数的落库路径彻底失败时不许凭空造终态。跨窗口的收敛
        # 归陈旧 reaper（`planrun.reap_stale_runs`，只碰 started_epoch >=
        # REAPER_EPOCH_FLOOR 的记录），不在这条断言的射程里。
        self.assertEqual(self.rows()[0]["status"], "running")

    # ---- 缺陷 2-2：被中断的 run 必须收敛成终态 ----

    def test_interrupted_run_converges_to_a_terminal_row(self):
        """运行被中断（Lambda 超时/链路断）→ running marker 收敛成 error 终态，
        且异常照旧往上抛（不许把中断吞成成功）。"""
        with self.assertRaises(asyncio.CancelledError):
            self._run(stage_results=[asyncio.CancelledError()])
        rows = self.rows()
        self.assertEqual(len(rows), 1, "一次 run 只许有一行")
        row = rows[0]
        self.assertEqual(row["status"], "error", "被中断的 run 永远停在 running")
        self.assertTrue(row["error"], "终态没有说明为什么失败")
        self.assertTrue(row["finished_at"])
        self.assertIsNotNone(row["finished_epoch"])
        self.assertIsNotNone(row["duration_s"])

    def test_converged_row_fabricates_no_terminal_numbers(self):
        """收敛行只写真的有的东西：没跑完就没有分数、没有 S3 报告。"""
        with self.assertRaises(asyncio.CancelledError):
            self._run(stage_results=[asyncio.CancelledError()])
        row = self.rows()[0]
        self.assertIsNone(row["score"])
        self.assertIsNone(row["s3_key"])
        self.assertEqual(row["stage_summaries"], [])
        self.assertIsNone(row["plan_synthesis"])

    def test_converged_row_keeps_the_stages_that_did_finish(self):
        """两环节方案在第二环节被中断：第一环节的摘要是用户已付费的真结果，
        必须留在收敛行里（S3 报告这条路径根本没写成，摘要是唯一残存）。"""
        with self.assertRaises(asyncio.CancelledError):
            self._run(plan=PLAN_2STAGE,
                      stage_results=[observe_result(0.91), asyncio.CancelledError()])
        row = self.rows()[0]
        self.assertEqual(row["status"], "error")
        self.assertEqual(len(row["stage_summaries"]), 1)
        self.assertEqual(row["stage_summaries"][0]["overall_mean"], 0.91)
        self.assertIsNone(row["score"], "半截 run 不许有综合分")

    def test_convergence_write_failure_does_not_mask_the_real_error(self):
        """收敛那次写也失败时，向上抛的必须还是原始中断异常，不是 DDB 的。"""
        with self.assertRaises(asyncio.CancelledError):
            self._run(stage_results=[asyncio.CancelledError()], fail_forever_from=2)
        self.assertEqual(self.rows()[0]["status"], "running")

    def test_normal_run_writes_exactly_one_terminal_row(self):
        """回归：一切正常时行为不变 —— 一行、completed、有分数、有 S3 报告、
        综合报告全文在摘要项里（不走降级）。"""
        report = self._run()
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["score"], 0.83)
        self.assertEqual(row["plan_synthesis"], SYNTHESIS)
        self.assertIsNone(row["synthesis_error"])
        self.assertEqual(row["s3_key"], report["s3_key"])
        self.assertNotIn("persist_error", report)


class SourceGuards(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "app" / "planrun.py").read_text()

    def test_persist_has_no_second_archive_implementation(self):
        """顺序不变量（上传返回后才记 key，摘要项绝不指向不存在的对象）现在只有
        一个住所：`runstore.archive_run`（S13/S3，simplify-r2）。planrun 不许再
        手搓第二份 put_object；名词必须显式传「报告」，否则用户读到的
        「完整报告归档失败」会被偷偷改成「完整明细归档失败」。
        换用后的行为由 tests/test_r2_core_final_guard.py 逐路钉。"""
        body = self.src[self.src.index("def _persist("):
                        self.src.index("def record_skipped_run(")]
        self.assertNotIn("put_object(", body)
        self.assertIn("runstore.archive_run(", body)
        self.assertIn('noun="报告"', body)

    def test_convergence_uses_put_not_update(self):
        """一次覆盖写：收敛路径不许引入 update_item。"""
        body = self.src[self.src.index("async def execute_plan_run"):
                        self.src.index("def _stage_summary")]
        self.assertNotIn("update_item", body)


if __name__ == "__main__":
    unittest.main()

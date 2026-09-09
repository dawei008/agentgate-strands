"""停止落地后不再**发起**任何新的被测 Agent 调用 —— 检查点必须长在并发名额的入口。

成因（tests/test_stop_run_checkpoints.py::test_remaining_cases_are_never_invoked 偶发红）：
用例循环的停止检查点在 as_completed 循环里、**用例完成之后**；但 run_one 一退出
`async with sem` 就把名额还给了信号量，下一例在主循环拿到「已完成」之前就已被唤醒
并把 invoke_agent 提交进了线程池（asyncio 的回调顺序：sem.release 唤醒下一例先于
task 完成回调）。主循环随后才看见停止、cancel 全部 task —— 此时能不能把那次提交
从线程池里撤回来，取决于工作线程有没有抢到那条任务：抢到了就是「停止之后又真调了
一次被测 Agent」。这就是偶发红的全部随机性所在，也是现网多花一次钱的窗口
（现网 stop_check 里是一次 DynamoDB 读，阻塞期间释放 GIL，工作线程几乎必然抢到）。

所以本文件不数**执行**了几次（那是线程调度决定的），而是数**提交**了几次：
把事件循环的默认 executor 换成一个记录 submit 的子类。把一次调用交给线程池
就是「发起调用」——在真环境里这一步之后就是网络请求了。这样读数不含任何
线程调度成分：修前必红、修后必绿，不靠 sleep。

moto 的真 DynamoDB；被测 Agent 打桩，不发起任何真运行。
运行：python3 -m pytest tests/test_stop_run_admission.py -q
"""

import asyncio
import concurrent.futures
import os
import sys
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

os.environ.pop("ARTIFACTS_BUCKET", None)

TABLE = "eval-catalog-test"
REGION = "us-west-2"
AGENT = "support-bot"
META = {AGENT: {"runtime_arn": "arn:aws:bedrock-agentcore:us-west-2:1:runtime/x",
                "model": "anthropic.claude-sonnet-5"}}


class _RecordingExecutor(concurrent.futures.ThreadPoolExecutor):
    """记录每一次 submit 的目标函数。asyncio.to_thread 提交的是
    functools.partial(ctx.run, func, *args)，所以目标在 .args[0]。"""

    def __init__(self, sink: list):
        super().__init__(max_workers=4)
        self.sink = sink

    def submit(self, fn, /, *args, **kwargs):
        target = getattr(fn, "args", (None,))[0]
        self.sink.append((target, getattr(fn, "args", ())[1:]))
        return super().submit(fn, *args, **kwargs)


class StopAtAdmission(unittest.TestCase):
    def setUp(self):
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        self.table = boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")
        import catalog
        import testrun
        self.testrun = testrun
        for p in (mock.patch.object(catalog, "get_table", return_value=self.table),
                  mock.patch.object(catalog, "TABLE_NAME", TABLE),
                  mock.patch.object(catalog, "get_agent_config", return_value={}),
                  mock.patch.object(testrun, "_table", return_value=self.table),
                  mock.patch.object(testrun.pricing, "get_prices",
                                    return_value={"prices": {}}),
                  mock.patch.object(testrun, "_generate_run_analysis",
                                    mock.AsyncMock(return_value="解析"))):
            p.start()
            self.addCleanup(p.stop)

    def _run(self, *, batch: int, after_invoke=None, n_cases: int = 4):
        """after_invoke(case_input, stop_flag) 在被测 Agent 桩的线程里、每次调用末尾
        执行 —— 停止信号由它置位。停止信号是一个 threading.Event，与
        planrun.stop_requested 同刑（读到 True 之后粘住），不与线程调度耦合。"""
        dataset = {"name": "faq", "cases": [{"name": f"c{i}", "input": f"问题{i}"}
                                            for i in range(n_cases)]}
        self.invoked: list[str] = []
        self.submitted: list = []
        stop_flag = threading.Event()

        def fake_invoke(arn, cfg, case_input, sid):
            self.invoked.append(case_input)
            if after_invoke is not None:
                after_invoke(case_input, stop_flag)
            return "这是一段真实回答"

        def stop_check():
            return stop_flag.is_set()

        async def main():
            asyncio.get_running_loop().set_default_executor(
                _RecordingExecutor(self.submitted))
            return await self.testrun.execute_test_run(
                "run-20260907120000", dataset, [AGENT], [], "judge-model", {},
                META, {"estimated_cost_usd": 1.0}, stop_check=stop_check)

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(self.testrun, "RUN_TTL_BATCH", batch))
            stack.enter_context(mock.patch.object(self.testrun, "invoke_agent",
                                                  fake_invoke))
            run = asyncio.run(main())
        self.dispatched = [args[2] for target, args in self.submitted
                           if target is fake_invoke]
        return run

    def test_serial_second_case_is_never_dispatched(self):
        """串行（并发 1）：第 1 例完成即停止，第 2 例不许被**提交**到线程池。
        修前这里恒为 ['问题0', '问题1']（提交总在主循环看见停止之前发生）。"""
        run = self._run(batch=1,
                        after_invoke=lambda _inp, flag: flag.set())
        self.assertEqual(self.dispatched, ["问题0"],
                         "停止之后又把下一例交给了线程池（继续花钱）")
        self.assertEqual(self.invoked, ["问题0"])
        self.assertEqual(run["status"], "stopped")
        self.assertEqual(run["completed_cases"], 1)
        self.assertEqual([r["case"] for r in run["results"]], ["c0"])

    def test_concurrent_slot_freed_by_a_stop_is_not_refilled(self):
        """并发 2：开跑时 c0/c1 同时在飞是合法的（停止前就发起了）；两例都在飞
        之后（屏障）才置停止，第一例完成腾出的名额不许再放进 c2/c3。
        修前这里恒为四例全提交（两个名额各自在主循环看见停止之前被回填）。"""
        both_in_flight = threading.Barrier(2, timeout=10)

        def hook(_inp, flag):
            both_in_flight.wait()   # 两例都已真在飞，再落停止
            flag.set()

        run = self._run(batch=2, after_invoke=hook)
        self.assertEqual(sorted(self.dispatched), ["问题0", "问题1"],
                         "停止后腾出的并发名额又放进了新用例")
        self.assertEqual(sorted(self.invoked), ["问题0", "问题1"])
        self.assertEqual(run["status"], "stopped")
        # 已在飞的那一例照既有口径被 cancel：结果里只有真正完成的
        self.assertLessEqual(run["completed_cases"], 2)
        self.assertEqual(run["total_cases"], 4)

    def test_untouched_run_dispatches_every_case_once(self):
        """阴性对照：不停止时 4 例各提交一次、各执行一次 —— 入口检查点不改变
        未停止运行的并发与调用数。"""
        run = self._run(batch=2, after_invoke=None)
        self.assertEqual(sorted(self.dispatched), [f"问题{i}" for i in range(4)])
        self.assertEqual(sorted(self.invoked), [f"问题{i}" for i in range(4)])
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["completed_cases"], 4)


class SourceGuard(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "app" / "testrun.py").read_text()

    def test_admission_checkpoint_sits_right_after_the_semaphore(self):
        """入口检查点必须是拿到名额后的**第一条语句** —— 放在缓存查找或 invoke
        之后都等于没放（缓存命中也要花 judge 的钱）。按语句数不按字符数：中间只许
        有注释。"""
        at = self.src.index("    async def run_one(agent_name: str, case: dict)")
        lines = self.src[at:].splitlines()
        sem_i = next(i for i, l in enumerate(lines) if l.strip() == "async with sem:")
        stmts = [l.strip() for l in lines[sem_i + 1:sem_i + 40]
                 if l.strip() and not l.strip().startswith("#")]
        self.assertEqual(stmts[0], "if stop_check is not None and stop_check():",
                         "停止检查点不是拿到名额后的第一条语句")
        self.assertEqual(stmts[1], "return None")


if __name__ == "__main__":
    unittest.main()

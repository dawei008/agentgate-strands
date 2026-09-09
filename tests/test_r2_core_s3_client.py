"""S3 客户端只有一个住址：`runstore._s3()`（缓存单例）（R5）。

r1-P3 把 runstore 的 S3 client 改成了缓存单例，队友没跟上：`planrun` 每次落库/读取
都 `boto3.client("s3")` 现建一个，`main` 三处（生成数据集的素材归档、带图用例上传、
素材下载直链）各自现建。每次现建就是新建连接池 + 重做一次 TLS 握手（各 50-100ms）。

行为保持的依据：同区（都 `from discovery import REGION`）、同桶（都
ARTIFACTS_BUCKET）、boto3 client 线程安全。

Run: python3 -m pytest tests/test_r2_core_s3_client.py -q
"""

import asyncio
import base64
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import discovery  # noqa: E402
import planrun  # noqa: E402
import runstore  # noqa: E402

BUCKET = "eval-artifacts-test"


class NobodyBuildsTheirOwn(unittest.TestCase):
    def test_no_ad_hoc_s3_clients_left(self):
        """只看**代码行**：注释里提到这个旧写法（说明它被什么取代了）是有意的。"""
        for name in ("planrun.py", "main.py"):
            with self.subTest(module=name):
                lines = [ln for ln in (APP / name).read_text().splitlines()
                         if 'boto3.client("s3"' in ln
                         and not ln.lstrip().startswith("#")]
                self.assertEqual(lines, [], f"{name} 仍在现建 S3 client")

    def test_planrun_has_no_s3_handle_of_its_own(self):
        self.assertFalse(hasattr(planrun, "_s3"))

    def test_the_bucket_env_is_still_the_same_one(self):
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}):
            self.assertEqual(planrun._bucket(), runstore._bucket())

    def test_region_comes_from_discovery_on_both_sides(self):
        self.assertEqual(runstore.REGION, discovery.REGION)

    def test_still_a_lazy_singleton(self):
        runstore._s3_client = None
        self.addCleanup(lambda: setattr(runstore, "_s3_client", None))
        with mock.patch.object(runstore.boto3, "client") as mk:
            first, second = runstore._s3(), runstore._s3()
        self.assertIs(first, second)
        mk.assert_called_once_with("s3", region_name=runstore.REGION)


class PlanrunUsesTheSharedHandle(unittest.TestCase):
    def setUp(self):
        self.s3 = mock.MagicMock()
        for p in (mock.patch.object(runstore, "_s3", return_value=self.s3),
                  mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET}),
                  mock.patch.object(planrun, "_table", return_value=mock.MagicMock())):
            p.start()
            self.addCleanup(p.stop)

    def test_report_archive_goes_through_it(self):
        plan = {"plan_id": "p1", "name": "n", "agent_name": "a"}
        key = planrun._persist(plan, "p1#ts", "ts", "manual", "s", "f", 0.0,
                               [], {}, {"stages": []})
        self.assertEqual(key, "reports/p1/ts.json")
        kwargs = self.s3.put_object.call_args.kwargs
        self.assertEqual(kwargs["Bucket"], BUCKET)
        self.assertEqual(kwargs["Key"], "reports/p1/ts.json")
        self.assertEqual(kwargs["ContentType"],
                         "application/json; charset=utf-8")

    def test_report_fetch_goes_through_it(self):
        planrun._table.return_value.get_item.return_value = {
            "Item": {"sk": "p1#ts", "s3_key": "reports/p1/ts.json",
                     "status": "completed", "stage_summaries": "[]"}}
        body = json.dumps({"stages": [{"type": "observe"}]}).encode()
        self.s3.get_object.return_value = {"Body": mock.Mock(
            read=mock.Mock(return_value=body))}
        out = planrun.get_plan_run("p1#ts")
        self.assertEqual(self.s3.get_object.call_args.kwargs,
                         {"Bucket": BUCKET, "Key": "reports/p1/ts.json"})
        self.assertEqual(out["report"]["stages"], [{"type": "observe"}])


class MainUsesTheSharedHandle(unittest.TestCase):
    """三个 action 各走一次（素材归档 / 带图用例上传 / 素材下载直链）。"""

    def setUp(self):
        self.s3 = mock.MagicMock()
        p = mock.patch.object(runstore, "_s3", return_value=self.s3)
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET})
        e.start()
        self.addCleanup(e.stop)

    def _drain(self, payload) -> list[dict]:
        import main

        async def go():
            return [ev async for ev in main.invoke(payload)]

        return asyncio.run(go())

    def test_case_image_upload(self):
        events = self._drain({
            "action": "upload_case_image", "name": "shot.png",
            "content_base64": base64.b64encode(b"\x89PNG...").decode()})
        self.assertEqual(events[0]["event"], "case_image_uploaded")
        kwargs = self.s3.put_object.call_args.kwargs
        self.assertEqual(kwargs["Bucket"], BUCKET)
        self.assertEqual(kwargs["ContentType"], "image/png")
        self.assertTrue(kwargs["Key"].endswith("/images/shot.png"))

    def test_presigned_source_url(self):
        self.s3.generate_presigned_url.return_value = "https://signed"
        events = self._drain({"action": "get_source_url",
                              "key": "sources/20260824-090000/a.pdf"})
        self.assertEqual(events, [{"event": "source_url",
                                   "key": "sources/20260824-090000/a.pdf",
                                   "url": "https://signed"}])
        self.s3.generate_presigned_url.assert_called_once_with(
            "get_object",
            Params={"Bucket": BUCKET, "Key": "sources/20260824-090000/a.pdf"},
            ExpiresIn=600)

    def test_generate_dataset_archives_the_pasted_context(self):
        """素材归档：一次调用里可能上传多份（正文 + 附件），共用同一个句柄。"""
        import main
        with mock.patch.object(main.catalog, "get_dataset", return_value=None):
            events = self._drain({"action": "generate_dataset",
                                  "context": "改签政策全文", "num_cases": 1,
                                  "extend_dataset": "ghost"})
        # extend 目标不存在 → 就地报错返回；但素材已经归档（既有顺序，不改）
        self.assertEqual(events[-1]["event"], "error")
        kwargs = self.s3.put_object.call_args.kwargs
        self.assertEqual(kwargs["Bucket"], BUCKET)
        self.assertTrue(kwargs["Key"].endswith("/pasted-context.txt"))


if __name__ == "__main__":
    unittest.main()

"""E3：热路径上的 AWS 句柄不许每次调用新建（simplify-r2 Track B）。

`testrun._agent_client()` 此前每调新建 bedrock-agentcore client，而
`invoke_agent_raw` 是每次目标调用的必经之路：回归每用例每轮、红队每攻击轮
（redteam.py 经 testrun.invoke_agent）。20 攻击 × 10-16 轮 = 200+ 次新建连接池
+ 重做 TLS 握手（各 50-100ms），全在拖住攻击对话的 worker 线程。
同族小尾巴：带图用例每个都自己现建一个 S3 client，而 runstore._s3 早已是缓存
单例，两者读的还是同一个归档桶。

行为保持的依据：boto3 client 线程安全（红队多 worker 共用一个实例是安全的）；
S3 侧同区同桶（都 `from discovery import REGION` + ARTIFACTS_BUCKET）。范本是
已合流的 runstore.py:74-81。

Run: python3 -m pytest tests/test_r2_infra_clients.py -q
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

import boto3
from moto import mock_aws

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import catalog  # noqa: E402
import runstore  # noqa: E402
import testrun  # noqa: E402

REGION = "us-west-2"
BUCKET = "eval-artifacts-test"
TABLE = "eval-catalog-test"
SID = "evaltest-" + "0" * 33     # AgentCore 要求 runtimeSessionId ≥ 33


def _reset_singletons():
    """进程级缓存是真状态：每个用例前后都清，免得互相污染。"""
    testrun._agent_client_cached = None
    runstore._s3_client = None
    catalog._table = None


class AgentClientIsALazySingleton(unittest.TestCase):
    def setUp(self):
        _reset_singletons()
        self.addCleanup(_reset_singletons)

    def test_built_once_and_shared(self):
        with mock.patch.object(testrun.boto3, "client") as mk:
            first, second = testrun._agent_client(), testrun._agent_client()
        self.assertIs(first, second)
        mk.assert_called_once()
        self.assertEqual(mk.call_args.args, ("bedrock-agentcore",))
        self.assertEqual(mk.call_args.kwargs["region_name"], testrun.REGION)
        # 超时/重试的三键现值另有专钉（tests/test_agent_timeout.py 读真 client
        # 的 meta.config），这里只钉「config 没被整个丢掉」。
        self.assertIn("config", mk.call_args.kwargs)

    def test_region_still_comes_from_discovery(self):
        import discovery
        self.assertEqual(testrun.REGION, discovery.REGION)

    def test_every_turn_reuses_the_same_connection_pool(self):
        """三次目标调用 → 一个 client。这条红了就是每轮重做一次 TLS 握手。"""
        fake = mock.Mock()
        fake.invoke_agent_runtime.return_value = {"response": [b"\xe5\x9b\x9e", b"\xe7\xad\x94"]}
        with mock.patch.object(testrun.boto3, "client", return_value=fake) as mk:
            outs = [testrun.invoke_agent_raw("arn:aws:x", "{}", SID) for _ in range(3)]
        self.assertEqual(outs, ["回答"] * 3)
        self.assertEqual(mk.call_count, 1,
                         "每次目标调用都新建 client = 每轮新建连接池 + 重做 TLS 握手")
        self.assertEqual(fake.invoke_agent_runtime.call_count, 3)

    def test_probe_supplied_client_still_wins(self):
        """探测那条硬读超时的 client 是既有特权，单例化不许把它挤掉。"""
        probe_client = mock.Mock()
        probe_client.invoke_agent_runtime.return_value = {"response": [b"ok"]}
        with mock.patch.object(testrun.boto3, "client") as mk:
            out = testrun.invoke_agent_raw("arn:aws:x", "{}", SID, client=probe_client)
        self.assertEqual(out, "ok")
        mk.assert_not_called()
        probe_client.invoke_agent_runtime.assert_called_once()

    def test_invoke_arguments_are_unchanged(self):
        fake = mock.Mock()
        fake.invoke_agent_runtime.return_value = {"response": [b"x"]}
        with mock.patch.object(testrun.boto3, "client", return_value=fake):
            testrun.invoke_agent_raw("arn:aws:runtime/x", '{"prompt": "问"}', SID)
        self.assertEqual(fake.invoke_agent_runtime.call_args.kwargs, {
            "agentRuntimeArn": "arn:aws:runtime/x",
            "runtimeSessionId": SID,
            "contentType": "application/json",
            "accept": "application/json, text/event-stream",
            "payload": '{"prompt": "问"}',
        })


class ImageCaseReusesTheArchiveS3Client(unittest.TestCase):
    """带图用例的图片与 run 归档取自同一个桶 —— 共用 runstore._s3 那个单例。"""

    def setUp(self):
        _reset_singletons()
        self.addCleanup(_reset_singletons)
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(Bucket=BUCKET,
                         CreateBucketConfiguration={"LocationConstraint": REGION})
        s3.put_object(Bucket=BUCKET, Key="sources/shot.png", Body=b"\x89PNG-bytes")
        p = mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": BUCKET})
        p.start()
        self.addCleanup(p.stop)

    def test_image_bytes_arrive_without_building_a_second_client(self):
        case = {"name": "shot", "input": "这张图里余额是多少", "image_key": "sources/shot.png"}
        runstore._s3()   # 归档 client 已在（缓存单例），图片路径不许再建一个
        with mock.patch.object(testrun.boto3, "client") as mk:
            mm = testrun._load_multimodal_input(case)
        self.assertEqual(mm.media.source, b"\x89PNG-bytes")
        self.assertEqual(mm.media.format, "png")
        self.assertEqual(mm.instruction, "这张图里余额是多少")
        mk.assert_not_called()

    def test_it_is_literally_the_runstore_client(self):
        case = {"name": "shot", "input": "看图", "image_key": "sources/shot.png"}
        with mock.patch.object(runstore, "_s3", wraps=runstore._s3) as spy:
            testrun._load_multimodal_input(case)
        spy.assert_called_once_with()

    def test_jpg_still_becomes_jpeg_and_context_rides_along(self):
        boto3.client("s3", region_name=REGION).put_object(
            Bucket=BUCKET, Key="sources/receipt.jpg", Body=b"jpeg-bytes")
        mm = testrun._load_multimodal_input(
            {"name": "r", "input": "读小票", "image_key": "sources/receipt.jpg",
             "image_context": "用户上传的付款凭证"})
        self.assertEqual(mm.media.format, "jpeg")
        self.assertEqual(mm.context, "用户上传的付款凭证")

    def test_existing_guards_are_untouched(self):
        """四道既有拦截（无 key / 桶未配 / 越权前缀 / 格式不支持）行为不变。"""
        self.assertIsNone(testrun._load_multimodal_input({"name": "t", "input": "x"}))
        with mock.patch.dict("os.environ", {"ARTIFACTS_BUCKET": ""}):
            with self.assertRaises(ValueError):
                testrun._load_multimodal_input(
                    {"name": "t", "input": "x", "image_key": "sources/shot.png"})
        with self.assertRaises(ValueError):
            testrun._load_multimodal_input(
                {"name": "t", "input": "x", "image_key": "elsewhere/shot.png"})
        boto3.client("s3", region_name=REGION).put_object(
            Bucket=BUCKET, Key="sources/doc.tiff", Body=b"x")
        with self.assertRaises(ValueError):
            testrun._load_multimodal_input(
                {"name": "t", "input": "x", "image_key": "sources/doc.tiff"})


class TableHandleFollowsTheCatalogSingleton(unittest.TestCase):
    """R3：`testrun._table()` 复用 `catalog.get_table()`（缓存单例）。

    此前每调 `boto3.resource("dynamodb").Table(...)` 重建（含 service JSON 解析），
    而 redteam 的每次 checkpoint / 每次查询都借它（redteam.py:451/457/462/835）。
    plan.py:39、planrun.py:45 早已是 `return catalog.get_table()`，evalcache 全程
    直用 —— testrun 是唯一没跟队形的，而 runstore 那条单例注释还引它队友当范本。
    同表（catalog.TABLE_NAME）同区（都 `from discovery import REGION`）。
    """

    def setUp(self):
        _reset_singletons()
        self.addCleanup(_reset_singletons)
        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)
        p = mock.patch.object(catalog, "TABLE_NAME", TABLE)
        p.start()
        self.addCleanup(p.stop)
        boto3.resource("dynamodb", region_name=REGION).create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST")

    def test_same_object_every_call(self):
        self.assertIs(testrun._table(), testrun._table())

    def test_it_is_the_catalog_singleton(self):
        self.assertIs(testrun._table(), catalog.get_table())

    def test_same_table_as_before(self):
        self.assertEqual(testrun._table().table_name, catalog.TABLE_NAME)

    def test_redteam_shares_the_one_handle(self):
        """红队的 checkpoint / 查询借的就是 testrun._table（redteam.py:451 等四处）。"""
        import redteam
        self.assertIs(redteam.testrun._table(), catalog.get_table())

    def test_a_real_round_trip_still_works(self):
        testrun._table().put_item(Item={"pk": "RUN", "sk": "r1", "data": "{}"})
        self.assertEqual(
            testrun._table().get_item(Key={"pk": "RUN", "sk": "r1"})["Item"]["data"], "{}")

    def test_queue_formation_matches_plan_and_planrun(self):
        src = (APP / "testrun.py").read_text()
        self.assertIn("return catalog.get_table()", src)
        self.assertNotIn('boto3.resource("dynamodb"', src)


if __name__ == "__main__":
    unittest.main()

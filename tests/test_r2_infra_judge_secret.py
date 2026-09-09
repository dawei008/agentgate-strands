"""E4：OpenAI judge 模式的密钥随配置同窗缓存 60s（simplify-r2 Track B）。

`judgellm._api_key` 此前每调新建 secretsmanager client + 打一发 get_secret_value，
而它在 OpenAI provider 下是每会话必经：`strands_model()`（逐会话诊断
main.py:172 → diagnosis.py:31、评估器构造 registry.py:125）与 `_openai_client()`
（converse / 探测）各取一次 —— 每会话白付一到两次网络往返。

两条硬约束：
  · **默认 bedrock 路径行为零变化**（它压根不碰 Secrets Manager）；
  · **凭证只进内存缓存**：不落盘、不进日志、不进 DynamoDB（模块头注释的既有约束）。

外加一条缓存自带的新风险，本文件一并钉住：**失败不缓存**、**换配置即失效** ——
否则「修好 secret / 轮换密钥后重存配置」会在 60 秒内继续拿旧值，而 set_config
的存前探测正是为了「配置错了当场报」。

Run: python3 -m pytest tests/test_r2_infra_judge_secret.py -q
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

APP = Path(__file__).resolve().parent.parent / "app"
sys.path.insert(0, str(APP))

import judgellm  # noqa: E402

SECRET = "eval-anything/judge-openai"
# 夹具值故意不长成任何真 key 的样子（原本写作 `sk-live-…`）：仓库要同步到 GitHub，
# 而 `sk-live-` 这种前缀会被密钥扫描器当成真凭证拦下推送。它只是个「有没有被
# 泄进日志/响应」的标记串（见 test_key_never_reaches_* 两条），值本身无意义。
KEY = "DUMMY-FAKE-JUDGE-KEY-not-a-credential"


def secret_client(payload: str | None = None, key: str = KEY):
    """一个只会答 get_secret_value 的假 secretsmanager client。"""
    c = mock.Mock()
    c.get_secret_value.return_value = {
        "SecretString": payload if payload is not None
        else json.dumps({"api_key": key})}
    return c


class JudgeSecretFixture(unittest.TestCase):
    def setUp(self):
        judgellm._key_cache.clear()
        judgellm._cache.update({"cfg": None, "at": 0.0})
        self.addCleanup(judgellm._key_cache.clear)
        self.addCleanup(judgellm._cache.update, {"cfg": None, "at": 0.0})

    def at(self, t: float):
        """把时钟钉在 t 秒（缓存窗口判定用的就是 time.time()）。"""
        return mock.patch.object(judgellm.time, "time", return_value=t)


class KeyIsFetchedOncePerWindow(JudgeSecretFixture):
    def test_value_is_what_the_secret_says(self):
        with mock.patch.object(judgellm.boto3, "client", return_value=secret_client()):
            self.assertEqual(judgellm._api_key(SECRET), KEY)

    def test_one_network_round_trip_for_many_calls(self):
        c = secret_client()
        with mock.patch.object(judgellm.boto3, "client", return_value=c) as mk:
            with self.at(1_000.0):
                keys = [judgellm._api_key(SECRET) for _ in range(5)]
        self.assertEqual(keys, [KEY] * 5)
        self.assertEqual(c.get_secret_value.call_count, 1,
                         "每次取 key 都打一发 Secrets Manager = 每会话白付网络往返")
        self.assertEqual(mk.call_count, 1)

    def test_window_is_the_same_60s_as_the_config_cache(self):
        c = secret_client()
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.at(1_000.0):
                judgellm._api_key(SECRET)
            with self.at(1_059.0):
                judgellm._api_key(SECRET)
            self.assertEqual(c.get_secret_value.call_count, 1)
            with self.at(1_060.0):
                judgellm._api_key(SECRET)
        self.assertEqual(c.get_secret_value.call_count, 2, "过窗必须重取")
        self.assertEqual(judgellm.CACHE_TTL_S, 60)

    def test_rotated_secret_is_picked_up_after_the_window(self):
        c = secret_client(key="sk-old")
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.at(1_000.0):
                self.assertEqual(judgellm._api_key(SECRET), "sk-old")
            c.get_secret_value.return_value = {
                "SecretString": json.dumps({"api_key": "sk-new"})}
            with self.at(1_100.0):
                self.assertEqual(judgellm._api_key(SECRET), "sk-new")

    def test_two_secret_ids_never_cross(self):
        def by_id(*_a, **_k):
            c = mock.Mock()
            c.get_secret_value.side_effect = lambda SecretId: {
                "SecretString": json.dumps({"api_key": f"sk-for-{SecretId}"})}
            return c

        with mock.patch.object(judgellm.boto3, "client", side_effect=by_id):
            with self.at(1_000.0):
                a = judgellm._api_key("eval-anything/a")
                b = judgellm._api_key("eval-anything/b")
                self.assertEqual(a, "sk-for-eval-anything/a")
                self.assertEqual(b, "sk-for-eval-anything/b")
                self.assertEqual(judgellm._api_key("eval-anything/a"), a)


class FailuresAreNeverCached(JudgeSecretFixture):
    def test_missing_api_key_field_still_raises_every_time(self):
        c = secret_client(payload=json.dumps({"token": "wrong-field"}))
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.at(1_000.0):
                for _ in range(2):
                    with self.assertRaises(ValueError) as ctx:
                        judgellm._api_key(SECRET)
                self.assertIn("没有 api_key 字段", str(ctx.exception))
        self.assertEqual(c.get_secret_value.call_count, 2,
                         "报错被缓存了 —— 修好 secret 再重跑会在 60s 内继续报同一个错")

    def test_a_fixed_secret_works_on_the_very_next_call(self):
        c = secret_client(payload=json.dumps({}))
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.at(1_000.0):
                with self.assertRaises(ValueError):
                    judgellm._api_key(SECRET)
                c.get_secret_value.return_value = {
                    "SecretString": json.dumps({"api_key": KEY})}
                self.assertEqual(judgellm._api_key(SECRET), KEY)

    def test_transport_failure_is_not_cached_either(self):
        c = mock.Mock()
        c.get_secret_value.side_effect = RuntimeError("ThrottlingException")
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.at(1_000.0):
                for _ in range(2):
                    with self.assertRaises(RuntimeError):
                        judgellm._api_key(SECRET)
        self.assertEqual(c.get_secret_value.call_count, 2)


class SavingConfigInvalidatesTheKey(JudgeSecretFixture):
    """存配置时那一发探测必须打**真的**密钥 —— 不许拿 ≤60s 的缓存值验过关。"""

    def test_set_config_drops_the_cached_key(self):
        c = secret_client()
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.at(1_000.0):
                judgellm._api_key(SECRET)
                self.assertIn(SECRET, judgellm._key_cache)
                table = mock.Mock()
                with mock.patch.object(judgellm.catalog, "get_table",
                                       return_value=table):
                    judgellm.set_config({"provider": "bedrock",
                                         "model": "global.anthropic.claude-sonnet-5"})
                self.assertEqual(judgellm._key_cache, {})

    def test_saved_config_item_still_carries_no_credential(self):
        table = mock.Mock()
        with mock.patch.object(judgellm.boto3, "client", return_value=mock.Mock()):
            with mock.patch.object(judgellm.catalog, "get_table", return_value=table):
                judgellm.set_config({"provider": "bedrock", "model": "m"})
        data = table.put_item.call_args.kwargs["Item"]["data"]
        self.assertNotIn("api_key", data)
        self.assertNotIn(KEY, data)


class CredentialsStayInMemory(JudgeSecretFixture):
    def test_the_key_never_reaches_the_log(self):
        c = secret_client()
        with mock.patch.object(judgellm.boto3, "client", return_value=c):
            with self.assertLogs("eval-anything", level="DEBUG") as logs:
                judgellm.logger.debug("judge key refreshed")   # 至少一条，好让断言成立
                judgellm._api_key(SECRET)
        self.assertNotIn(KEY, "\n".join(logs.output))

    def test_nothing_is_written_to_disk(self):
        src = (APP / "judgellm.py").read_text()
        for forbidden in ("open(", "Path(", "tempfile", "os.environ["):
            with self.subTest(forbidden):
                self.assertNotIn(forbidden, src)

    def test_cache_is_a_plain_in_memory_dict(self):
        self.assertIsInstance(judgellm._key_cache, dict)


class BedrockDefaultPathIsUntouched(JudgeSecretFixture):
    """默认 provider 压根不碰 Secrets Manager —— 缓存加进来也不许长出一条新路径。"""

    def test_default_config_is_still_bedrock(self):
        table = mock.Mock()
        table.get_item.return_value = {}
        with mock.patch.object(judgellm.catalog, "get_table", return_value=table):
            cfg = judgellm.get_config()
        self.assertEqual(cfg["provider"], "bedrock")
        self.assertEqual(cfg["model"], "global.anthropic.claude-sonnet-5")
        self.assertEqual(cfg["secret_id"], "")

    def test_strands_model_returns_the_model_id_string(self):
        table = mock.Mock()
        table.get_item.return_value = {}
        with mock.patch.object(judgellm.catalog, "get_table", return_value=table):
            with mock.patch.object(judgellm.boto3, "client") as mk:
                self.assertEqual(judgellm.strands_model("m-1"), "m-1")
        mk.assert_not_called()
        self.assertEqual(judgellm._key_cache, {})

    def test_converse_on_bedrock_builds_no_secretsmanager_client(self):
        table = mock.Mock()
        table.get_item.return_value = {}
        bedrock = mock.Mock()
        bedrock.converse.return_value = {
            "output": {"message": {"content": [{"text": "答"}]}},
            "stopReason": "end_turn"}
        with mock.patch.object(judgellm.catalog, "get_table", return_value=table):
            with mock.patch.object(judgellm.boto3, "client", return_value=bedrock) as mk:
                out = judgellm.converse(None, "系统", "用户", 100)
        self.assertEqual(out, {"text": "答", "tool_input": None,
                               "stop_reason": "end_turn"})
        self.assertEqual([c.args[0] for c in mk.call_args_list], ["bedrock-runtime"])
        self.assertEqual(judgellm._key_cache, {})


if __name__ == "__main__":
    unittest.main()

"""portability：区域必须跟 `AWS_REGION` 走，不能写死原开发机的 us-west-2。

另一个人在自己的账号 / 别的商业分区区域按 README 部署时，`infra/app.py` 会把栈
建在 `CDK_DEFAULT_REGION`，Runtime 容器里 `AWS_REGION` 也随之为该区域；此时凡是
把 `REGION = "us-west-2"` 写死的模块，都会跨区去找一个不存在的资源：

  · `app/judgellm.py`：bedrock-runtime 客户端（探测 / converse）与 secretsmanager
    客户端（第三方 judge 的 API key，Secret 建在部署区域）—— 其余模块都是
    `from discovery import REGION`（`discovery.REGION = os.environ.get("AWS_REGION",
    "us-west-2")`），只有它一家写死。
  · `scripts/invoke_runtime.py`：直连 Runtime 的运维脚本，同病；`scripts/coords.py`
    早已是 `os.environ.get("AWS_REGION", "us-west-2")`，向它对齐。

两个模块都在 import 时求值区域，所以测试要在 monkeypatch 环境变量之后
`importlib.reload`（judgellm 依赖 discovery，先 reload discovery）。每条测试收尾
把环境变量还原并再 reload 一次，别把改过区域的模块留给其它测试。

不改：`app/pricing.py` 的 `region_name="us-east-1"`（Pricing API 只在
us-east-1 / ap-south-1 提供，那是对的）。

Run: python3 -m pytest tests/test_portability_region.py -q
"""

import importlib
import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
sys.path.insert(0, str(APP))

import discovery  # noqa: E402
import judgellm  # noqa: E402

OTHER_REGION = "eu-west-1"
DEFAULT_REGION = "us-west-2"


def _reload_region_modules():
    """discovery 先、judgellm 后（后者从前者取 REGION）。"""
    importlib.reload(discovery)
    importlib.reload(judgellm)


def _bedrock_stub():
    """只会答 converse 的假 bedrock-runtime client（响应形态与真服务同刑）。"""
    c = mock.MagicMock()
    c.converse.return_value = {
        "output": {"message": {"content": [{"text": "ok"}]}},
        "stopReason": "end_turn",
    }
    c.get_secret_value.return_value = {"SecretString": '{"api_key": "DUMMY-NOT-A-KEY"}'}
    return c


class RegionFixture(unittest.TestCase):
    def setUp(self):
        self._env = mock.patch.dict(os.environ, {"AWS_REGION": OTHER_REGION})
        self._env.start()
        _reload_region_modules()
        # 收尾：还原环境变量后再 reload，模块回到真实环境下的区域
        self.addCleanup(_reload_region_modules)
        self.addCleanup(self._env.stop)


class JudgeLlmClientsFollowAwsRegion(RegionFixture):
    """judgellm 建的每一个 boto3 client 都要带 AWS_REGION 指定的区域。"""

    def test_probe_bedrock_client(self):
        with mock.patch.object(judgellm.boto3, "client", return_value=_bedrock_stub()) as mk:
            judgellm._probe({"provider": "bedrock", "model": "m"})
        mk.assert_called_once()
        self.assertEqual(mk.call_args.args[0], "bedrock-runtime")
        self.assertEqual(mk.call_args.kwargs.get("region_name"), OTHER_REGION)

    def test_secretsmanager_client(self):
        judgellm._key_cache.clear()
        with mock.patch.object(judgellm.boto3, "client", return_value=_bedrock_stub()) as mk:
            judgellm._api_key("eval-anything/portability-test")
        mk.assert_called_once()
        self.assertEqual(mk.call_args.args[0], "secretsmanager")
        self.assertEqual(mk.call_args.kwargs.get("region_name"), OTHER_REGION)

    def test_converse_bedrock_client(self):
        cfg = {"provider": "bedrock", "model": "m", "base_url": "", "secret_id": ""}
        with mock.patch.object(judgellm, "get_config", return_value=cfg), \
                mock.patch.object(judgellm.boto3, "client", return_value=_bedrock_stub()) as mk:
            out = judgellm.converse(None, None, "hi", 16)
        self.assertEqual(out["text"], "ok")
        mk.assert_called_once()
        self.assertEqual(mk.call_args.args[0], "bedrock-runtime")
        self.assertEqual(mk.call_args.kwargs.get("region_name"), OTHER_REGION)

    def test_region_is_the_same_object_discovery_resolved(self):
        """不是「judgellm 自己也读了一遍 env」——它必须与其余模块同源。"""
        self.assertEqual(judgellm.REGION, discovery.REGION)
        self.assertEqual(judgellm.REGION, OTHER_REGION)


class InvokeRuntimeScriptFollowsAwsRegion(unittest.TestCase):
    SCRIPT = ROOT / "scripts" / "invoke_runtime.py"

    def _load(self, region: str | None):
        env = {"AWS_REGION": region} if region else {}
        with mock.patch.dict(os.environ, env, clear=False):
            if region is None:
                os.environ.pop("AWS_REGION", None)
            spec = importlib.util.spec_from_file_location("_portability_invoke_runtime", self.SCRIPT)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        return mod

    def test_module_region_follows_env(self):
        self.assertEqual(self._load(OTHER_REGION).REGION, OTHER_REGION)

    def test_cloudformation_client_follows_env(self):
        mod = self._load(OTHER_REGION)
        cfn = mock.MagicMock()
        cfn.describe_stacks.return_value = {
            "Stacks": [{"Outputs": [{"OutputKey": "RuntimeArn", "OutputValue": "arn:x"}]}]}
        with mock.patch.object(mod.boto3, "client", return_value=cfn) as mk:
            self.assertEqual(mod.runtime_arn(), "arn:x")
        self.assertEqual(mk.call_args.kwargs.get("region_name"), OTHER_REGION)

    def test_default_stays_us_west_2_when_env_absent(self):
        """兜底值不变：原开发机不设 AWS_REGION 时行为零变化。"""
        self.assertEqual(self._load(None).REGION, DEFAULT_REGION)


class DefaultUnchangedWhenEnvAbsent(unittest.TestCase):
    """兜底值不变（judgellm 侧）：不设 AWS_REGION 时仍是 us-west-2。"""

    def test_judgellm_default(self):
        env = dict(os.environ)
        env.pop("AWS_REGION", None)
        with mock.patch.dict(os.environ, env, clear=True):
            _reload_region_modules()
            try:
                self.assertEqual(judgellm.REGION, DEFAULT_REGION)
            finally:
                pass
        _reload_region_modules()


if __name__ == "__main__":
    unittest.main()

"""`cdk -c instance=<i>` 起一套与现网零共享的隔离实例（移植自主仓 ADR-0020 D11）。

两层守卫：
  ⒈ **源码层**（主 venv 恒跑，不需要 aws_cdk）：RUNTIME_NAME 仍是模块常量且值不变；
     栈体内对它的引用全部走实例属性；app.py 的三条命名规则与两处物理名后缀在源码里钉住。
  ⒉ **模板层**（需要 `npx cdk` 与 `/usr/bin/python3` 里的 aws_cdk，缺任一则 skip）：
     真 synth 两种模式，读模板——默认模式一个字符不能变（栈 id / runtime 名 / 域名前缀 /
     reaper 名都是现网值）；instance 模式资源名带后缀、不含现网 RUNTIME_NAME 字面量、
     UI 栈只 import 自己那套 Runtime 栈的导出；四条安全红线（Function URL AWS_IAM、
     S3 四项 public-access block、CloudFront OAC、无 0.0.0.0/0）在带后缀的模板里逐条核。
     另有一条**归一化等价**：把后缀 token 还原后，instance 的 Runtime 模板必须与默认
     模板逐字节相同——证明「加后缀」之外没有任何东西被改动。

⚠️ 「默认模板与改前逐字节相同」的那条 diff 是在改动落地那一刻拿改前 synth 产物比出来的
（移植批读数：Runtime f1f78892… / Ui ff7bda07… 两树同 md5）；仓库里不存改前模板（含账号
坐标），这里钉的是它的可复算等价物：默认模式的全部现网命名值 + 「归一化后 == 默认」。
"""

import ast
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INFRA = ROOT / "infra"
APP_PY = INFRA / "app.py"
RUNTIME_STACK = INFRA / "stacks" / "eval_runtime_stack.py"
UI_STACK = INFRA / "stacks" / "ui_stack.py"

INSTANCE = "strands"
PROD_RUNTIME_NAME = "evalanything"
INSTANCE_RUNTIME_NAME = f"{INSTANCE}_{PROD_RUNTIME_NAME}"


# ---------------------------------------------------------------- 源码层 ----
class RuntimeNameIsAConstructorArgument(unittest.TestCase):
    def setUp(self):
        self.src = RUNTIME_STACK.read_text()
        self.tree = ast.parse(self.src)

    def test_module_constant_keeps_the_production_value(self):
        consts = {
            t.id: n.value.value
            for n in self.tree.body
            if isinstance(n, ast.Assign)
            for t in n.targets
            if isinstance(t, ast.Name) and isinstance(n.value, ast.Constant)
        }
        self.assertEqual(consts.get("RUNTIME_NAME"), PROD_RUNTIME_NAME)

    def test_init_takes_runtime_name_defaulting_to_the_constant(self):
        init = self._init()
        kw = {a.arg: d for a, d in zip(init.args.kwonlyargs, init.args.kw_defaults)}
        self.assertIn("runtime_name", kw)
        self.assertIsInstance(kw["runtime_name"], ast.Name)
        self.assertEqual(kw["runtime_name"].id, "RUNTIME_NAME")
        self.assertIn("name_suffix", kw)
        self.assertEqual(kw["name_suffix"].value, "")

    def test_no_bare_constant_reference_survives_inside_the_body(self):
        # 栈体内一律 self.runtime_name；漏一处 = 第二套实例还在用现网的名字。
        init = self._init()
        bare = [n.lineno for stmt in init.body for n in ast.walk(stmt)
                if isinstance(n, ast.Name) and n.id == "RUNTIME_NAME"]
        self.assertEqual(bare, [], f"bare RUNTIME_NAME at lines {bare}")
        self.assertEqual(self.src.count("agent_runtime_name=self.runtime_name"), 1)
        self.assertEqual(self.src.count('"RUNTIME_NAME": self.runtime_name'), 1)

    def test_reaper_schedule_name_carries_the_suffix(self):
        # Scheduler 名同区域唯一；不带后缀第二套 deploy 会撞现网的 eval-reap-stale-runs。
        self.assertIn('name=f"eval-reap-stale-runs{self.name_suffix}"', self.src)

    def _init(self):
        for n in ast.walk(self.tree):
            if isinstance(n, ast.ClassDef) and n.name == "EvalRuntimeStack":
                for f in n.body:
                    if isinstance(f, ast.FunctionDef) and f.name == "__init__":
                        return f
        self.fail("EvalRuntimeStack.__init__ not found")


class UiStackTakesTheSuffix(unittest.TestCase):
    def test_cognito_domain_prefix_carries_the_suffix_before_the_account(self):
        src = UI_STACK.read_text()
        self.assertIn(
            'domain_prefix=f"eval-anything{self.name_suffix}-{self.account}"', src
        )
        self.assertIn("name_suffix: str = \"\"", src)


class AppNamingRules(unittest.TestCase):
    def setUp(self):
        self.src = APP_PY.read_text()

    def test_reads_the_instance_context(self):
        self.assertIn('try_get_context("instance")', self.src)

    def test_stack_ids_are_suffixed_from_the_production_ids(self):
        self.assertIn('f"EvalAnythingRuntime{suffix}"', self.src)
        self.assertIn('f"EvalAnythingUi{suffix}"', self.src)
        self.assertIn('suffix = f"-{instance}" if instance else ""', self.src)

    def test_runtime_name_is_prefixed_not_suffixed(self):
        # 前缀而非后缀：app/plansched._own_runtime_arn 用 runtime_id.startswith(RUNTIME_NAME)
        # 认自己；"evalanything_<i>" 会让**现网**把这套实例的 ARN 认成自己。
        self.assertIn(
            'runtime_name = f"{instance}_{RUNTIME_NAME}" if instance else RUNTIME_NAME',
            self.src,
        )

    def test_ui_stack_is_wired_to_the_same_apps_runtime_stack(self):
        self.assertIn("eval_runtime_arn=runtime_stack.runtime_arn", self.src)

    def test_instance_slug_is_validated(self):
        m = re.search(r're\.fullmatch\(r"([^"]+)", instance\)', self.src)
        self.assertIsNotNone(m, "instance slug guard missing")
        pat = m.group(1)
        for ok in (INSTANCE, "a1", "x"):
            self.assertTrue(re.fullmatch(pat, ok), ok)
        for bad in ("Strands", "strands-2", "strands_2", "1x", "", "a" * 17):
            self.assertFalse(re.fullmatch(pat, bad), bad)


# ---------------------------------------------------------------- 模板层 ----
def _cdk_toolchain_available() -> bool:
    if shutil.which("npx") is None:
        return False
    probe = subprocess.run(
        ["/usr/bin/python3", "-c", "import aws_cdk, constructs"],
        capture_output=True, text=True,
    )
    return probe.returncode == 0


HAVE_CDK = _cdk_toolchain_available()


def _synth(out: Path, *context: str) -> dict[str, dict]:
    import os
    env = dict(os.environ)
    # cdk.json runs `python3 app.py`; aws_cdk lives in /usr/bin/python3 only
    # (docs/runbook-deploy.md 坑二). Same PATH trick as the runbook.
    env["PATH"] = "/usr/bin:" + env.get("PATH", "")
    cmd = ["npx", "cdk", "synth", "--quiet", "-o", str(out)]
    for c in context:
        cmd += ["-c", c]
    proc = subprocess.run(cmd, cwd=INFRA, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"cdk synth failed:\n{proc.stdout}\n{proc.stderr}")
    return {p.name: json.loads(p.read_text()) for p in out.glob("*.template.json")}


def _resources(t: dict, rtype: str) -> list[dict]:
    return [r for r in t["Resources"].values() if r["Type"] == rtype]


def _walk(obj):
    yield obj
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _runtime_env(t: dict) -> dict:
    (rt,) = _resources(t, "AWS::BedrockAgentCore::Runtime")
    return rt["Properties"]["EnvironmentVariables"]


def _runtime_name(t: dict) -> str:
    (rt,) = _resources(t, "AWS::BedrockAgentCore::Runtime")
    return rt["Properties"]["AgentRuntimeName"]


def _reaper_name(t: dict) -> str:
    names = [r["Properties"].get("Name") for r in _resources(t, "AWS::Scheduler::Schedule")]
    (name,) = [n for n in names if n and n.startswith("eval-reap-stale-runs")]
    return name


def _cognito_domain(t: dict) -> str:
    (d,) = _resources(t, "AWS::Cognito::UserPoolDomain")
    return d["Properties"]["Domain"]


@unittest.skipUnless(HAVE_CDK, "需要 npx cdk 与 /usr/bin/python3 的 aws_cdk（runbook 坑二）——模板层跳过")
class SynthesizedTemplates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="agentgate-synth-")
        base = Path(cls.tmp.name)
        cls.default = _synth(base / "default")
        cls.instance = _synth(base / "instance", f"instance={INSTANCE}")
        cls.default_text = {k: json.dumps(v) for k, v in cls.default.items()}
        cls.instance_text = {k: json.dumps(v) for k, v in cls.instance.items()}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    # ---- 默认模式 = 现网，一个字符不能变 ----
    def test_default_mode_keeps_every_production_name(self):
        self.assertEqual(
            set(self.default), {"EvalAnythingRuntime.template.json", "EvalAnythingUi.template.json"}
        )
        rt = self.default["EvalAnythingRuntime.template.json"]
        ui = self.default["EvalAnythingUi.template.json"]
        self.assertEqual(_runtime_name(rt), PROD_RUNTIME_NAME)
        self.assertEqual(_runtime_env(rt)["RUNTIME_NAME"], PROD_RUNTIME_NAME)
        self.assertEqual(_reaper_name(rt), "eval-reap-stale-runs")
        dom = _cognito_domain(ui)
        self.assertRegex(dom, r"^eval-anything-\d{12}$")
        for text in self.default_text.values():
            self.assertNotIn(f"-{INSTANCE}", text)
            self.assertNotIn(f"{INSTANCE}_", text)

    # ---- instance 模式：资源名带后缀，不含现网字面量 ----
    def test_instance_mode_suffixes_every_region_unique_name(self):
        self.assertEqual(
            set(self.instance),
            {f"EvalAnythingRuntime-{INSTANCE}.template.json", f"EvalAnythingUi-{INSTANCE}.template.json"},
        )
        rt = self.instance[f"EvalAnythingRuntime-{INSTANCE}.template.json"]
        ui = self.instance[f"EvalAnythingUi-{INSTANCE}.template.json"]
        self.assertEqual(_runtime_name(rt), INSTANCE_RUNTIME_NAME)
        self.assertEqual(_runtime_env(rt)["RUNTIME_NAME"], INSTANCE_RUNTIME_NAME)
        self.assertEqual(_reaper_name(rt), f"eval-reap-stale-runs-{INSTANCE}")
        self.assertRegex(_cognito_domain(ui), rf"^eval-anything-{INSTANCE}-\d{{12}}$")

    def test_instance_mode_contains_no_production_literal(self):
        for name, text in self.instance_text.items():
            with self.subTest(name):
                self.assertNotIn(f'"{PROD_RUNTIME_NAME}"', text)
                # aws:cdk:path 与导出名都以栈 id 开头；无后缀形态一处都不许有。
                self.assertNotRegex(text, r"EvalAnythingRuntime[/:]")
                self.assertNotRegex(text, r"EvalAnythingUi[/:]")

    def test_instance_mode_runtime_name_does_not_prefix_match_production(self):
        # 见 AppNamingRules.test_runtime_name_is_prefixed_not_suffixed。
        self.assertFalse(INSTANCE_RUNTIME_NAME.startswith(PROD_RUNTIME_NAME))
        self.assertFalse(PROD_RUNTIME_NAME.startswith(INSTANCE_RUNTIME_NAME))
        self.assertRegex(INSTANCE_RUNTIME_NAME, r"^[a-zA-Z][a-zA-Z0-9_]{0,47}$")

    def test_bad_instance_slug_refuses_to_synth(self):
        # 阴性对照：连字符在 AgentCore runtime 名里非法，app.py 必须在 synth 期就拒绝，
        # 不能拖到 deploy 期让 CreateAgentRuntime 报 ValidationException。
        with self.assertRaises(RuntimeError) as cm:
            _synth(Path(self.tmp.name) / "bad", f"instance={INSTANCE}-2")
        self.assertIn("lowercase letters/digits only", str(cm.exception))

    # ---- 两套栈互不引用 ----
    def test_ui_imports_only_from_its_own_runtime_stack(self):
        for mode, templates, rt_id in (
            ("default", self.default, "EvalAnythingRuntime"),
            ("instance", self.instance, f"EvalAnythingRuntime-{INSTANCE}"),
        ):
            ui = [v for k, v in templates.items() if k.startswith("EvalAnythingUi")][0]
            imports = [
                n["Fn::ImportValue"] for n in _walk(ui)
                if isinstance(n, dict) and "Fn::ImportValue" in n
            ]
            with self.subTest(mode):
                self.assertTrue(imports, "UI stack must import the runtime ARN")
                for imp in imports:
                    self.assertTrue(imp.startswith(f"{rt_id}:"), imp)

    # ---- 归一化等价：后缀之外零改动 ----
    def test_instance_runtime_template_equals_default_after_unsuffixing(self):
        text = self.instance_text[f"EvalAnythingRuntime-{INSTANCE}.template.json"]
        for a, b in (
            (f"EvalAnythingRuntime-{INSTANCE}", "EvalAnythingRuntime"),
            (INSTANCE_RUNTIME_NAME, PROD_RUNTIME_NAME),
            (f"eval-reap-stale-runs-{INSTANCE}", "eval-reap-stale-runs"),
        ):
            self.assertIn(a, text)
            text = text.replace(a, b)
        self.assertEqual(text, self.default_text["EvalAnythingRuntime.template.json"])

    def test_instance_ui_template_has_the_same_resource_shape_as_default(self):
        # UI 模板归一化后还剩 CloudFront origin id / OAC 名里 CDK 揉进栈名的哈希，
        # 逐字节比不了；比资源类型多重集（类型与个数一个不差）。
        from collections import Counter
        d = Counter(r["Type"] for r in self.default["EvalAnythingUi.template.json"]["Resources"].values())
        i = Counter(r["Type"] for r in self.instance[f"EvalAnythingUi-{INSTANCE}.template.json"]["Resources"].values())
        self.assertEqual(d, i)

    # ---- 四条安全红线，在带后缀的模板上核 ----
    def test_function_url_is_iam_only(self):
        ui = self.instance[f"EvalAnythingUi-{INSTANCE}.template.json"]
        urls = _resources(ui, "AWS::Lambda::Url")
        self.assertEqual(len(urls), 1)
        self.assertEqual(urls[0]["Properties"]["AuthType"], "AWS_IAM")
        for text in self.instance_text.values():
            self.assertNotIn('"AuthType": "NONE"', text)

    def test_every_bucket_blocks_all_public_access(self):
        buckets = [
            r for t in self.instance.values() for r in _resources(t, "AWS::S3::Bucket")
        ]
        self.assertEqual(len(buckets), 2, "one site bucket + one artifacts bucket")
        for b in buckets:
            cfg = b["Properties"]["PublicAccessBlockConfiguration"]
            self.assertEqual(
                cfg,
                {"BlockPublicAcls": True, "BlockPublicPolicy": True,
                 "IgnorePublicAcls": True, "RestrictPublicBuckets": True},
            )

    def test_cloudfront_reaches_both_origins_through_oac(self):
        ui = self.instance[f"EvalAnythingUi-{INSTANCE}.template.json"]
        oacs = _resources(ui, "AWS::CloudFront::OriginAccessControl")
        kinds = sorted(o["Properties"]["OriginAccessControlConfig"]["OriginAccessControlOriginType"] for o in oacs)
        self.assertEqual(kinds, ["lambda", "s3"])
        for o in oacs:
            self.assertEqual(o["Properties"]["OriginAccessControlConfig"]["SigningBehavior"], "always")
        (dist,) = _resources(ui, "AWS::CloudFront::Distribution")
        for origin in dist["Properties"]["DistributionConfig"]["Origins"]:
            self.assertIn("OriginAccessControlId", origin, origin.get("Id"))
        principals = [
            p["Properties"]["Principal"] for p in _resources(ui, "AWS::Lambda::Permission")
        ]
        self.assertTrue(principals)
        self.assertEqual(set(principals), {"cloudfront.amazonaws.com"})

    def test_no_world_open_cidr(self):
        for name, text in self.instance_text.items():
            with self.subTest(name):
                self.assertNotIn("0.0.0.0/0", text)
                self.assertNotIn("::/0", text)


if __name__ == "__main__":
    unittest.main()

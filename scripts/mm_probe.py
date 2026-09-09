"""End-to-end probe for multimodal (MLLM-as-a-Judge) dataset runs.

What only a live run can prove:
  1. upload_case_image lands a key under sources/.../images/ and rejects junk
  2. a case carrying image_key is judged by mm_* evaluators that actually READ
     the image — checked by scoring the same recorded output twice, once against
     an image that agrees with it and once against one that contradicts it
  3. text and mm_* evaluators coexist in one run without the text judge ever
     seeing the image payload
  4. a case WITHOUT image_key gets multimodal_error, not a silent text score

Point 2 is the only assertion that can't be faked: if the judge ignored the
image, both variants would score the same.

Usage: python3 scripts/mm_probe.py [all|upload|run|noimage]
"""
import base64
import io
import json
import sys
import time
import uuid

import boto3
from botocore.config import Config

import coords

REGION = coords.REGION
# 评估 Runtime 与被测 Agent 都从 coords 惰性现取（账号私有 / 每环境不同，
# 见仓库根 .env.example）——写成函数：import 本模块不该要 AWS 凭证。
probe_agent = coords.probe_target_agent
DATASET = "mm-probe"

client = boto3.client("bedrock-agentcore", region_name=REGION,
                      config=Config(read_timeout=1800, connect_timeout=30,
                                    retries={"max_attempts": 0}))


def call(payload, show=()):
    resp = client.invoke_agent_runtime(
        agentRuntimeArn=coords.eval_runtime_arn(),
        runtimeSessionId="evaltest-mmprobe-" + uuid.uuid4().hex + uuid.uuid4().hex,
        contentType="application/json",
        accept="application/json, text/event-stream",
        payload=json.dumps(payload, ensure_ascii=False),
    )
    body = b"".join(c for c in resp["response"]).decode("utf-8", "replace")
    events = []
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        events.append(ev)
        if ev.get("event") in show:
            print("  --", ev.get("event"), json.dumps(ev, ensure_ascii=False)[:300])
    return events


def make_pass(gate: str, boarding: str) -> bytes:
    """A boarding-pass PNG with specific, readable values.

    Two variants with different gate/time is what separates "the judge read the
    image" from "the judge scored the text and we believed it".
    """
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (520, 200), "white")
    d = ImageDraw.Draw(img)
    d.text((20, 20), "BOARDING PASS", fill="black")
    d.text((20, 60), "FLIGHT: HU7802", fill="black")
    d.text((20, 90), f"GATE: {gate}", fill="black")
    d.text((20, 120), "SEAT: 27A", fill="black")
    d.text((20, 150), f"BOARDING: {boarding}", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def upload(name: str, raw: bytes) -> str | None:
    evs = call({"action": "upload_case_image", "name": name,
                "content_base64": base64.b64encode(raw).decode()})
    ok = next((e for e in evs if e.get("event") == "case_image_uploaded"), None)
    err = next((e for e in evs if e.get("event") == "error"), None)
    if err or not ok:
        reason = err["error"] if err else f"no upload event: {[e.get('event') for e in evs]}"
        print(f"  {name}: ERROR {reason}")
        return None
    print(f"  {name}: key={ok['image_key']} bytes={ok['bytes']}")
    return ok["image_key"]


def test_run(evaluators, cache_mode="off"):
    print(f"\n=== start_test_run evaluators={evaluators} cache={cache_mode} ===")
    t0 = time.time()
    base = {"dataset": DATASET, "agent_names": [probe_agent()], "evaluators": evaluators}
    est = next(e for e in call({"action": "estimate_test_run", **base})
               if e.get("event") == "test_run_estimate")
    print("  estimate:", {k: est.get(k) for k in
                          ("judge_calls", "image_judge_calls", "estimated_cost_usd")})
    evs = call({"action": "start_test_run", **base, "cache_mode": cache_mode},
               show=("error",))
    rep = next((e for e in evs if e.get("event") == "test_run_report"), None)
    print(f"  elapsed {time.time() - t0:.1f}s")
    if not rep:
        print("  NO REPORT:", [e.get("event") for e in evs][-6:])
        return None
    print("  run_id:", rep.get("run_id"), "status:", rep.get("status"))
    for r in rep.get("results", []):
        scores = {k: (v.get("score"), v.get("errored")) for k, v in (r.get("results") or {}).items()}
        print(f"  {r['case']}: image_key={r.get('image_key', '—')}")
        print(f"      scores={scores}")
        if r.get("multimodal_error"):
            print(f"      multimodal_error={r['multimodal_error']}")
        if r.get("error") or r.get("eval_error"):
            print(f"      err={r.get('error') or r.get('eval_error')}")
        for k, v in (r.get("results") or {}).items():
            if k.startswith("mm_"):
                print(f"      [{k}] {str(v.get('reason'))[:200]}")
    return rep


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"

    if what in ("all", "upload"):
        print("=== upload_case_image ===")
        key_b12 = upload("bp-b12.png", make_pass("B12", "14:35"))
        key_a03 = upload("bp-a03.png", make_pass("A03", "16:20"))
        # rejections: unsupported format, and empty body
        print("  -- expect rejections below --")
        upload("notes.pdf", b"%PDF-1.4 fake")
        upload("empty.png", b"")
        json.dump({"b12": key_b12, "a03": key_a03}, open("/tmp/mm_keys.json", "w"))

    if what in ("all", "run"):
        keys = json.load(open("/tmp/mm_keys.json"))
        # Same input, same expected answer, SAME agent output — different image.
        # If the judge reads the image, agrees-case scores high and
        # contradicts-case scores low. If it ignores it, both look identical.
        #
        # Wording matters: an answer-forcing prompt ("请直接回答 B12 和 14:35")
        # trips the TARGET's own content filter, which returns 0 bytes -> nothing
        # to grade -> both variants score the same and the assertion can't
        # discriminate. Ask plainly instead; the target then answers and the
        # judge's grade of that answer is what the two images differ on.
        q = ("旅客说他手里的登机牌上写着登机口 B12、登机时间 14:35，"
             "请向他确认这两项信息。")
        cases = [
            {"name": "img-agrees", "input": q, "image_key": keys["b12"],
             "image_context": "用户把手机里的登机牌截图发到了客服对话里",
             "expected_output": "登机口 B12，14:35 开始登机", "category": "多模态"},
            {"name": "img-contradicts", "input": q, "image_key": keys["a03"],
             "image_context": "用户把手机里的登机牌截图发到了客服对话里",
             "expected_output": "登机口 B12，14:35 开始登机", "category": "多模态"},
            {"name": "no-image", "input": q,
             "expected_output": "登机口 B12，14:35 开始登机", "category": "多模态"},
        ]
        print(f"\n=== save_dataset {DATASET} ({len(cases)} cases) ===")
        call({"action": "save_dataset", "name": DATASET, "cases": cases},
             show=("dataset_saved", "error"))
        # one mixed run: text judge + two mm judges over the same outputs
        rep = test_run(["correctness", "mm_correctness", "mm_faithfulness"],
                       cache_mode="record")
        if rep:
            by = {r["case"]: r for r in rep.get("results", [])}
            a = (by.get("img-agrees", {}).get("results") or {}).get("mm_correctness", {})
            c = (by.get("img-contradicts", {}).get("results") or {}).get("mm_correctness", {})
            print("\n  ASSERTION judge actually read the image:")
            print(f"    agrees={a.get('score')} contradicts={c.get('score')}"
                  f"  -> {'PASS' if (a.get('score') or 0) > (c.get('score') or 0) else 'FAIL'}")
            n = by.get("no-image", {})
            print(f"    no-image case flagged: {bool(n.get('multimodal_error'))}"
                  f" -> {'PASS' if n.get('multimodal_error') else 'FAIL'}")
            # blank target output must be skipped, never scored 0
            blanks = [r["case"] for r in rep.get("results", []) if r.get("blank_output")]
            scored_blank = [r["case"] for r in rep.get("results", [])
                            if r.get("blank_output") and (r.get("results") or {})]
            print(f"    blank_output cases={blanks} run.blank_cases={rep.get('blank_cases')}")
            print(f"    none of them carry scores -> "
                  f"{'PASS' if not scored_blank else 'FAIL ' + str(scored_blank)}")

    if what == "noimage":
        # mm_* alone, on a dataset whose cases have no image: must not crash and
        # must flag every row (the experiment-is-None path).
        test_run(["mm_overall_quality"])

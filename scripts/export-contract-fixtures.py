#!/usr/bin/env python3
"""导出后端契约 fixture：strategies / risk_categories 真实键集 → web/tests/fixtures/backend-contract.json

用途：mock（web/src/mocks/handlers.ts）里的红队策略名与风险类别键必须是后端真实键集的子集，
否则前端在 mock 下点得通、线上点不通（历史上已发生三次同型事故）。
本脚本从 app/redteam.py 导出权威键集，checked-in 到 web/tests/fixtures/backend-contract.json，
由 vitest 对账测试（web/tests/contract-guard.test.ts）消费。

重跑命令（后端键集变更后）：
    python3 scripts/export-contract-fixtures.py

风险类别与 severity 的最终权威是 **strands_evals SDK**
（`strands_evals.experimental.redteam.types` 的 RISK_CATEGORIES / DEFAULT_SEVERITY），
app/redteam.py:risk_categories() 只是把它们转成 API 形状。SDK 装不上时脚本会明确失败
而不是写出半份 fixture——半份 fixture 会让对账测试变成假绿。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "tests", "fixtures", "backend-contract.json")


def main() -> int:
    sys.path.insert(0, os.path.join(ROOT, "app"))
    try:
        import redteam
    except Exception as e:  # noqa: BLE001 - 任何导入失败都要说清楚
        print(f"导入 app/redteam.py 失败：{e}", file=sys.stderr)
        return 1

    try:
        # risk_categories() 内部再从 SDK 取 RISK_CATEGORIES / DEFAULT_SEVERITY
        cats = redteam.risk_categories()
    except Exception as e:  # noqa: BLE001
        print(f"读取 risk_categories() 失败（strands_evals SDK 未安装？）：{e}",
              file=sys.stderr)
        print("契约 fixture 必须来自真 SDK，不写半份文件。", file=sys.stderr)
        return 1

    strategies = redteam.strategy_menu()

    payload = {
        "_generated_by": "scripts/export-contract-fixtures.py",
        "_note": (
            "后端契约真实键集，checked-in 供 vitest 对账。请勿手改——"
            "后端键集变更后重跑 python3 scripts/export-contract-fixtures.py"
        ),
        "risk_categories": sorted(cats.keys()),
        "risk_category_severity": {k: v["severity"] for k, v in sorted(cats.items())},
        "severity_values": sorted({v["severity"] for v in cats.values()}),
        "strategies": [s["name"] for s in strategies],
        "strategy_turns": {s["name"]: s["turns"] for s in strategies},
        "strategy_snapshot_safe": {s["name"]: s["snapshot_safe"] for s in strategies},
        "breach_threshold": redteam.BREACH_THRESHOLD,
        "default_strategies": list(redteam.DEFAULT_STRATEGIES),
        "default_risk_categories": list(redteam.DEFAULT_RISK_CATEGORIES),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    print(f"已写出 {os.path.relpath(OUT, ROOT)}")
    print(f"  risk_categories: {', '.join(payload['risk_categories'])}")
    print(f"  strategies:      {', '.join(payload['strategies'])}")
    print(f"  breach_threshold: {payload['breach_threshold']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

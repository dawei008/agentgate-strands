#!/usr/bin/env python3
"""Run the evaluation core locally without deploying (needs AWS credentials).

Usage:
  python3 scripts/local_test.py                       # discover only
  python3 scripts/local_test.py obsDemo_obs_demo      # evaluate 1 session
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))

from main import invoke  # noqa: E402


async def run():
    async for ev in invoke({"action": "discover"}):
        agents = ev["agents"]
        with_logs = [a for a in agents if a["has_logs"]]
        print(f"发现 {len(agents)} 个 Agent，{len(with_logs)} 个有日志：")
        for a in with_logs:
            print(f"  - {a['agent_name']}")

    if len(sys.argv) > 1:
        payload = {
            "action": "evaluate",
            "agent_names": sys.argv[1:],
            "max_sessions": 1,
            "lookback_days": 90,
        }
        async for ev in invoke(payload):
            print(json.dumps(ev, ensure_ascii=False, default=str)[:600])


asyncio.run(run())

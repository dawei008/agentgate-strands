#!/usr/bin/env bash
# 视觉回归：起 dev server（本树已在跑则复用）→ 按 shots-plan.json 重截 → 与基线比对。
# 用法: npm run visual    （阈值等参数见 tests/visual/compare.py）
#      bash scripts/visual.sh --check-owner   # 只打印端口归属判定，不截图（干跑自测）
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${VISUAL_PORT:-5183}"
CUR="${VISUAL_OUT:-/tmp/t8-visual-current}"
HERE="$(pwd -P)"

# 端口有响应 ≠ 是本树的 server：机器上多个 worktree 的 vite 并行跑时，盲目复用
# 会截到别的树的页面（假红/假绿都实际发生过）。复用前必须校验监听进程的 cwd。
port_listening() {
  ss -tln 2>/dev/null | awk -v re="[:.]$1\$" '$4 ~ re {found=1} END {exit !found}'
}

# 监听 $1 端口进程的 cwd；拿不到（非本用户进程等）输出空 → 按「别人的」处理
port_owner_cwd() {
  local pid
  pid=$(ss -tlnp 2>/dev/null | awk -v re="[:.]$1\$" '$4 ~ re' \
        | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [ -n "$pid" ]; then readlink "/proc/$pid/cwd" 2>/dev/null || true; fi
}

reuse=0
if port_listening "$PORT"; then
  owner="$(port_owner_cwd "$PORT")"
  if [ "$owner" = "$HERE" ]; then
    reuse=1
  else
    echo "==> :${PORT} 被别处占用（cwd=${owner:-未知} ≠ 本树 ${HERE}），不复用"
    free=""
    for p in $(seq $((PORT + 1)) $((PORT + 20))); do
      if ! port_listening "$p"; then free="$p"; break; fi
    done
    if [ -z "$free" ]; then
      echo ":$((PORT + 1))-$((PORT + 20)) 也全被占，请设 VISUAL_PORT 指定空闲端口"
      exit 1
    fi
    PORT="$free"
  fi
fi
BASE="http://127.0.0.1:${PORT}"

if [ "${1:-}" = "--check-owner" ]; then
  [ "$reuse" = 1 ] && echo "check-owner: 复用本树 dev server (:${PORT})" \
                   || echo "check-owner: 将在 :${PORT} 新起 dev server"
  exit 0
fi

started=0
vite_pid=""
cleanup() {
  if [ "$started" = 1 ] && [ -n "$vite_pid" ]; then
    # setsid 起的是独立进程组：负号杀整组。只 kill npx 包装进程会把 vite 的
    # node 子进程漏成孤儿，永久霸占端口（正是串台温床，实测发生过）。
    kill -- "-$vite_pid" 2>/dev/null || kill "$vite_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ "$reuse" = 1 ]; then
  echo "==> 复用本树已在跑的 dev server (:${PORT}，cwd 校验通过)"
else
  echo "==> 启动 dev server (:${PORT})"
  setsid npx vite --port "$PORT" --strictPort >/tmp/visual-vite.log 2>&1 &
  vite_pid=$!
  started=1
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "$BASE/" && break
    sleep 0.5
  done
  curl -sf -o /dev/null "$BASE/" || { echo "dev server 起不来，见 /tmp/visual-vite.log"; exit 1; }
fi

echo "==> 重截截图集 → $CUR"
rm -rf "$CUR"
python3 scripts/shots.py --base "$BASE" --out "$CUR" --plan scripts/shots-plan.json

echo "==> 与基线比对"
python3 tests/visual/compare.py --baseline tests/visual/baseline --current "$CUR"

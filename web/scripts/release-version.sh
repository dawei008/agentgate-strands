#!/usr/bin/env bash
# 版本戳工具：构建号算号器 + 运行时身份文件（version.json）写手。
#
# 版本形态 = **语义化为主 + 构建号为辅**：`v0.9.0 · 2026.08.26-1`
#   · 语义化版本唯一权威 = `web/package.json` 的 version（发布通道在构建前按批次
#     分类 bump：功能批 minor / 修复·杂务批 patch）。本脚本只读、不改。
#   · 构建号 = `YYYY.MM.DD-N`，**UTC** 日期 + 当天第几版（N 从 1 起）。跨午夜各步
#     各算会出两个号，比没版本号更坏 —— 日期一律 `date -u`。
#
# 纪律：**tag 由发布通道打**（`release/<构建号>` + `v<semver>`，打在 bump commit 上），
# 本脚本只算号、不打 tag（在 agent worktree 里跑也绝对安全）。
#
# 用法:
#   release-version.sh                     下一个构建号（今天最大 N + 1）
#   release-version.sh --current           当前发布状态，三态各一行形态：
#                                            `none`         从没发过版
#                                            `stale <构建号>` 发过，但今天还没发
#                                            `today <构建号>` 今天已发到该号
#                                          （空输出会被读成「今天没发过」，故不留空）
#   release-version.sh --latest-semver     最新 `v*` tag（数值序，无则 none）
#   release-version.sh --write-json <dir>  只写 <dir>/version.json（纯 Runtime 发布
#                                          不重建前端，只更新身份文件）；stdout = 构建号
#
# 环境变量：RELEASE_ID 钉住构建号（发布通道用，与它随后打的 tag 同值）；
#           RUNTIME_VERSION 填 version.json 的 runtime_version（构建期不可知）。
# 退出码：不在 git 工作树里 → 1；参数不对 → 2。调用方按「无版本」回落 dev。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_JSON="${SCRIPT_DIR}/../package.json"

# 刻意不 cd 脚本目录：git tag 要读**调用方所在仓库**的 tag（发布通道从仓库根跑、
# vite 从 web/ 跑，都在同一个仓库里），cd 进去反而让临时仓自测失真。
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "release-version.sh: 不在 git 工作树里，无法算构建号" >&2
  exit 1
fi

TAG_PREFIX="release/"
today="$(date -u +%Y.%m.%d)"

# 今天已有的最大 N（无则 0）。
#   · 必须按**后缀数值**取最大：字典序下 `-10 < -2`，发到第 10 版那天会算出 N=3，
#     两个 release 撞同一个号且**不会报错**（静默）。
#   · 构建号不是 semver ⇒ `git tag --sort=v:refname` 对它不可靠，别用。
#   · 也不能用条数：当日中途删过 tag 会撞号。
max_n_today() {
  local n
  n="$(git tag --list "${TAG_PREFIX}${today}-*" \
       | sed -n "s|^${TAG_PREFIX}${today}-\([0-9][0-9]*\)$|\1|p" \
       | sort -n | tail -1)"
  echo "${n:-0}"
}

# 全部构建号 tag，按「日期段 + 后缀数值」排序（同上：不能纯字典序）
sorted_build_tags() {
  git tag --list "${TAG_PREFIX}*" | sort -t- -k1,1 -k2,2n
}

next_id() { echo "${today}-$(( $(max_n_today) + 1 ))"; }

# 语义化版本：显式读 package.json（不用 npm_package_version —— 那玩意儿只在
# `npm run` 下有值，直接调时静默为空）。读不到就失败，不回落成空串。
pkg_version() {
  local v
  v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
       "$PKG_JSON" 2>/dev/null | head -1)"
  # 形状也要过一遍：空 / 非 x.y.z 一律算读不到（返 1 让调用方退出，不回落成空串）
  case "$v" in
    [0-9]*.[0-9]*.[0-9]*) echo "$v" ;;
    *) echo "release-version.sh: 读不到 ${PKG_JSON} 的语义化 version（读到 '${v}'）" >&2
       return 1 ;;
  esac
}

case "${1:-}" in
  "")
    next_id
    ;;
  --current)
    latest="$(sorted_build_tags | tail -1)"
    if [ -z "$latest" ]; then
      echo "none"
    elif [ "$(max_n_today)" != "0" ]; then
      echo "today ${today}-$(max_n_today)"
    else
      echo "stale ${latest#"$TAG_PREFIX"}"
    fi
    ;;
  --latest-semver)
    # semver 的字典序陷阱：`v0.10.0` 在 `v0.9.0` **前面**，任何 sort/tail 形态的
    # 「取最新」都会指错版本。git 的 v:refname 懂 semver 分段数值序，必须用它。
    latest="$(git tag --list 'v*' --sort=v:refname | tail -1)"
    if [ -z "$latest" ]; then echo "none"; else echo "$latest"; fi
    ;;
  --write-json)
    dir="${2:-}"
    if [ -z "$dir" ] || [ ! -d "$dir" ]; then
      echo "release-version.sh: --write-json 需要一个已存在的目录" >&2
      exit 2
    fi
    build="${RELEASE_ID:-$(next_id)}"
    version="$(pkg_version)" || exit 1
    commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    runtime="${RUNTIME_VERSION:-}"
    # ui_build = 这份 dist 里嵌的构建号。纯 Runtime 发布**不重建前端**
    # （「零 web 改动 ⇒ dist 逐字节不变」是在用判据），所以沿用旧文件的值；
    # 没有旧文件就写 null —— 宁可承认不知道，也不拿 build 冒充 UI 构建号。
    ui_build=""
    if [ -f "$dir/version.json" ]; then
      ui_build="$(sed -n 's/.*"ui_build"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
                  "$dir/version.json" | head -1)"
    fi
    quoted() { if [ -z "$1" ]; then printf 'null'; else printf '"%s"' "$1"; fi }
    cat > "$dir/version.json" <<JSON
{
  "version": "$version",
  "build": "$build",
  "commit": "$commit",
  "built_at": "$built_at",
  "ui_build": $(quoted "$ui_build"),
  "runtime_version": $(quoted "$runtime")
}
JSON
    echo "$build"
    ;;
  *)
    echo "release-version.sh: 未知参数 '$1'（支持 --current / --latest-semver / --write-json <dir>）" >&2
    exit 2
    ;;
esac

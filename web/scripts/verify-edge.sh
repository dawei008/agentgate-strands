#!/usr/bin/env bash
# 边缘逐对象对拍：把**本地 dist/ 的每一个文件**与边缘现网比 md5 + 大小。
#
# 立项理由（edge-parity-verify 批）：发布 runbook 第 5 步原来只核 index.html /
# version.json / assets/ —— 也就是**判据的覆盖面恰好等于上传命令的覆盖面**，
# 于是「漏传」这类缺口永远自证不出来。实测 2026-08-26：`dist/` 根 7 个对象里
# `mockServiceWorker.js`（S3 LastModified 08-25 00:43）与 `fonts/*.woff2`
# （08-25 01:59）**从来没走过标准发布流程**，只是恰好没变过才与本地一致；
# `version.json` 不显式 `cp` 就会掉进同一个洞。
# 修法只有一个方向：**判据从「上传了什么」翻成「dist/ 里有什么」** —— 本脚本遍历
# 本地产物树，一个不落地问边缘要，不认固定清单。
#
# ⚠️ `mockServiceWorker.js` **自 build-hygiene-r1 批起不再进 dist**（dev-only 资产，
# 构建期从 outDir 剔掉），所以它自然掉出本脚本的覆盖面 —— 覆盖面跟着 dist 走，这里
# 不需要例外。**但边缘上还留着一份旧的**（不进 dist ≠ 从 CDN 消失）：残留清理是发布
# 通道发布后的单独一步（head-object 留证 → s3 rm → 失效），本脚本只读，不碰。
#
# 只读：全程只发 GET。**没有任何 aws 写操作**，不 sync / 不 cp / 不建失效
# （唯一能强刷边缘缓存的 `aws cloudfront create-invalidation` 是写操作，本脚本
# 刻意不做；排错提示里给的 `aws s3api head-object` 是只读的）。
#
# 判据：**HTTP 200 且字节一致**。刻意不写成「不是 404」—— S3 + OAC 的私有源没给
# ListBucket，**边缘缺 key 返 403 不是 404**，拿 404 当缺失判据会把真缺失放过去。
#
# no-cache 两件（index.html / version.json）怎么取到「边缘
# 此刻真会给用户的字节」——两种常见写法都试了，实测结论反直觉（2026-08-26，
# 在站点分发上实测）：
#   · `?t=<纪元秒>`：**不绕过**。分发用 Managed-CachingOptimized
#     (658327ea-f89d-4fab-a63d-7e88639e58f6)，QueryStringBehavior=none ⇒
#     查询串不进缓存键；immutable 资产实测 `x-cache: Hit from cloudfront` 且 age 递增。
#   · 请求头 `Cache-Control: no-cache`（+ `Pragma`）：在本分发上**也不绕过**
#     （HeaderBehavior=none，头既不进缓存键也不转发）；同一资产实测仍是 Hit。
#   · 真正让那三件保持新鲜的是**源端对象自己的** `cache-control: no-cache`：
#     边缘每次回源 revalidate，实测 `x-cache: RefreshHit from cloudfront`。
#     所以「取到最新」靠的是上传时带对 cache-control，客户端强迫不了任何事。
# 因此两种写法**都发**（只多 2 个文件 × 1 次请求），并要求**两次都与本地一致**：
# 两次取样自相矛盾 ⇒ 边缘同时存在两份副本。x-cache / age / ETag 一并打出来供归因。
# ⚠️ 这一档在 note 里**有自己的名字**（字面「两次取样自相矛盾」）并列出两次各自的
# md5 —— 含**与本地相符**的那一次。原先只有唱反调的那次进 note，于是这一档与
# 「两次都是旧字节」输出逐字同形，而两者处置不同（补失效 vs 重传）。
# ⚠️ 且 note 刻意**不**据方向下诊断：上面那条「两种写法都不进缓存键」是实测声明、
# 但从没在这一档被行使过 ⇒ 拿它推动作等于把未验声明当结论。排错段给的下一步
# （量源端 head-object）在它为真/为假两种情形下都成立。
# ⚠️ 档名的出现**必须等价于这一档命中**：所以专段（`VE_HINT_CONTRA`）只在
# `contradictions > 0` 时印，通用排错段里一个字都不许提它 —— 否则普通旧字节的输出里
# 也带着这几个字，grep 档名会假命中，印了名字等于没印。正反两颗钉守着这条等价性
# （见 tests/verify-edge.test.ts 那对「正/反」）。
#
# 用法:
#   verify-edge.sh [--dist <dir>] [--edge <base-url>] [--json]
#     --dist <dir>       本地产物目录，默认 web/dist（相对**脚本位置**解析，
#                        从仓库根还是从 web/ 跑都一样）
#     --edge <base-url>  边缘基址。不给就读环境变量 $VE_EDGE_BASE；两者都没有
#                        则退 2（不内置默认值：分发域名属某个具体 AWS 账号，
#                        不进仓库，见仓库根 .env.example）。现算法（只读）：
#                        aws cloudformation describe-stacks
#                          --stack-name "$EVAL_UI_STACK" --query
#                          'Stacks[0].Outputs[?OutputKey==`SiteUrl`].OutputValue'
#     --json             机器可读输出走 stdout，人类判决走 stderr
#
# 退出码分档（**判决同时印成人类可读的一行**：`cmd | tail` 读到的是管道末端的码，
# 今天两方各踩一次；所以 VERDICT/EXIT 两行必须肉眼可读，不许只靠调用方接 `$?`）:
#   0  全部比到且逐字节一致
#   2  用法错（未知参数 / 参数缺值 / 多余位置参数 / 边缘基址既没给也没配）
#   3  有不一致（逐个列出：非 200 / md5 不等 / 大小不等 / **两次取样自相矛盾**——
#      这一档在 note 里点名、并在 --json 里有 `contradiction` 字段与 `contradictions` 计数）
#   4  **一个都没比到**（dist 不存在 / 为空 / 边缘一个响应都取不到）——
#      空集不算通过，这一档存在的唯一理由就是不让「什么都没比」冒充「全等」
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 边缘基址**没有内置默认值**：CloudFront 分发域名是某个具体 AWS 账号的坐标，
# 不进仓库（脱敏，见仓库根 `.env.example` 与 docs/runbook-deploy.md「坐标从哪来」）。
# 取值优先级：--edge > $VE_EDGE_BASE > 无（退 2 报用法错）。
VE_DIST="${SCRIPT_DIR}/../dist"
VE_EDGE="${VE_EDGE_BASE:-}"
VE_JSON=0
VE_TIMEOUT="${VE_TIMEOUT:-30}"

ve_usage() {
  sed -n '/^# 用法:/,/^#      空集不算通过/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------- 小工具（都只读） ----------

# md5：优先 md5sum（Linux），退 md5 / openssl。S3 的 ETag 对**非分段上传**等于
# md5，但分段上传是 `<md5>-<段数>`，所以判据一律用**下载到的字节**现算，ETag 只
# 作旁证打印（边缘做过任何变换都会在这里露出来）。
ve_md5() {
  local out
  if command -v md5sum >/dev/null 2>&1; then
    out="$(md5sum -- "$1")" || return 1
    printf '%s' "${out%% *}"
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q -- "$1" || return 1
  else
    out="$(openssl md5 -r -- "$1")" || return 1
    printf '%s' "${out%% *}"
  fi
}

ve_size() {
  local n
  n="$(wc -c < "$1")" || return 1
  printf '%s' "${n//[[:space:]]/}"
}

ve_header() {   # $1=头文件 $2=头名（大小写不敏感，取最后一次出现）
  local line
  line="$(tr -d '\r' < "$1" | grep -i "^$2:" | tail -1)" || true
  line="${line#*:}"
  printf '%s' "${line# }"
}

ve_jstr() {     # 最小 JSON 字符串转义（路径/头值里不会有控制字符）
  local s="${1-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

# no-cache 名单：与上传时的 cache-control 一一对应（见 runbook「根产物上传写法」）。
# 这两件（外加任何 .html）在边缘每次回源 revalidate，所以要各取**两次独立取样**
# （两种写法各一次）。⚠️ 别把这两种写法读成「绕缓存」——本分发上它们**都不绕过**
# （查询串与请求头都不进缓存键，权威解释见文件头的 no-cache 段）；两次取样的用途是
# **两次取样自相矛盾检测**，不是强制新鲜。真正的新鲜度来自上传时带对 cache-control。
# ⚠️ 这份名单决定了哪些文件**可能**进这一档：名单外的文件只取一次样，那一档
# 结构上不可能出现 ⇒ 拿名单外文件（如 `assets/*.js`）写「那个名字不出现」的反向钉
# 是**文件形状保证的恒绿**，不是判据保证的。反向钉必须建在这份名单里的文件上。
# `mockServiceWorker.js` 曾在这份名单里，现在不再进 dist（见文件头）⇒ 一并摘掉：
# 名单里留着一个 dist 永远没有的文件，只会让人以为它还在发布面里。
ve_is_nocache() {
  case "$1" in
    index.html|version.json|*.html) return 0 ;;
    *) return 1 ;;
  esac
}

# 遍历 dist/ **全部**文件（相对路径，排序稳定）。覆盖面跟着 dist 走，不认固定清单。
ve_list_dist() {
  [ -d "$1" ] || return 1
  ( cd "$1" && find . -type f -print | sed 's|^\./||' | LC_ALL=C sort )
}

# GET 一次。$1=完整 URL $2=模式 plain|qs|hdr
# 出参：VE_STATUS / VE_MD5 / VE_SIZE / VE_ETAG / VE_XCACHE / VE_AGE / VE_ERR
# 返回 1 = 传输层失败（连不上/超时/DNS）—— 这种**没有 HTTP 响应**，不计入「比到」。
ve_fetch() {
  local url="$1" mode="$2" body hdr wo rc sep
  VE_STATUS=""; VE_MD5=""; VE_SIZE=""; VE_ETAG=""; VE_XCACHE=""; VE_AGE=""; VE_ERR=""
  body="$(mktemp)"; hdr="$(mktemp)"
  local -a args=(-sS -o "$body" -D "$hdr" -w '%{http_code}' --max-time "$VE_TIMEOUT")
  if [ "$mode" = qs ]; then
    sep="?"; case "$url" in *\?*) sep="&" ;; esac
    url="${url}${sep}t=$(date -u +%s)"
  elif [ "$mode" = hdr ]; then
    args+=(-H 'Cache-Control: no-cache' -H 'Pragma: no-cache')
  fi
  wo="$(curl "${args[@]}" -- "$url" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$wo" ]; then
    VE_ERR="curl 传输失败（rc=$rc，无 HTTP 响应）"
    rm -f "$body" "$hdr"
    return 1
  fi
  VE_STATUS="$wo"
  VE_MD5="$(ve_md5 "$body")"
  VE_SIZE="$(ve_size "$body")"
  VE_ETAG="$(ve_header "$hdr" etag)"
  VE_XCACHE="$(ve_header "$hdr" x-cache)"
  VE_AGE="$(ve_header "$hdr" age)"
  rm -f "$body" "$hdr"
  return 0
}

# 判决 + 退出码分档。**唯一**决定退出码的地方（口径只有一处，测试钉的就是它）。
# $1=比到几个 $2=坏几个 $3=总共几个 $4=空集原因
ve_verdict() {
  local checked="$1" failed="$2" total="$3" reason="${4:-}"
  if [ "$checked" -eq 0 ]; then
    VE_VERDICT="VERDICT: 未比对任何文件 ⇒ 这不是通过（${reason}）"
    return 4
  fi
  if [ "$failed" -gt 0 ]; then
    VE_VERDICT="VERDICT: $((total - failed))/${total} 一致，${failed} 处不一致 ⇒ 边缘 ≠ dist/"
    return 3
  fi
  VE_VERDICT="VERDICT: ${checked}/${total} 一致"
  return 0
}

VE_HINT="排错：判据是「HTTP 200 且字节一致」。**边缘缺 key 返 403 不是 404**（S3+OAC
  的私有源没给 ListBucket），所以 403 分不清「没上传」还是「策略/前缀错」，用只读的
  aws s3api head-object --bucket <站点桶> --key react/<相对路径> 分辨：
    · NoSuchKey/404  ⇒ 没上传（补传那一个对象，别一把 sync：cache-control 分两种）
    · 有对象但边缘 403 ⇒ OAC/桶策略或 origin_path 前缀错
  字节不等但对象在 ⇒ 传上去了没失效（x-cache/age 看得出陈旧），或传的是旧 dist。"

# 「两次取样自相矛盾」专段。⚠️ **只在真命中这一档时印**（`contradictions > 0`）——
# 原先它写在通用排错段里，于是**普通旧字节**的输出里也带着这几个字，grep 档名会假命中：
# 「档名出现」必须等价于「这一档命中」，否则印了名字等于没印（名字不承载信息）。
VE_HINT_CONTRA="⚠️ 本次命中「两次取样自相矛盾」（note 里已逐个点名）：同一 URL 的 [qs] 与 [hdr]
  此刻给出**不同字节** ⇒ 边缘同时存在两份副本。**别按「哪一次是新的」直接推动作** ——
  本分发上「两种写法都不进缓存键」那条声明（见文件头）从没在这一档被行使过：若它为真，
  方向不带诊断信息；若它为假，两个方向要的动作**相反**（补失效 vs 重传）。
  可用的下一步是先量源端：
    aws s3api head-object --bucket <站点桶> --key react/<相对路径>   （只读）
  拿它的 ETag/大小分别与两次取样比 —— 与源端相同的那一次才是「边缘讲对了」的那次，
  这一步在两种情形下都成立，不依赖那条未验声明。"

# ---------- 参数 ----------

while [ $# -gt 0 ]; do
  case "$1" in
    --dist) [ $# -ge 2 ] || { echo "verify-edge: --dist 缺参数" >&2; ve_usage >&2; exit 2; }
            VE_DIST="$2"; shift 2 ;;
    --edge) [ $# -ge 2 ] || { echo "verify-edge: --edge 缺参数" >&2; ve_usage >&2; exit 2; }
            VE_EDGE="$2"; shift 2 ;;
    --json) VE_JSON=1; shift ;;
    -h|--help) ve_usage; exit 0 ;;
    *) echo "verify-edge: 未知参数 $1" >&2; ve_usage >&2; exit 2 ;;
  esac
done
# 放在参数循环**之后**：`-h|--help` 仍然退 0（帮助不该要求先配坐标）。
if [ -z "$VE_EDGE" ]; then
  echo "verify-edge: 缺边缘基址 —— 给 --edge <base-url> 或设 VE_EDGE_BASE" >&2
  echo "  真值不进仓库。cp .env.example .env.local 填好后：set -a; . ./.env.local; set +a" >&2
  echo "  现算（只读）：aws cloudformation describe-stacks --stack-name \"\$EVAL_UI_STACK\" \\" >&2
  echo "                  --query 'Stacks[0].Outputs[?OutputKey==\`SiteUrl\`].OutputValue' --output text" >&2
  exit 2
fi
VE_EDGE="${VE_EDGE%/}"
# 规范化 dist 路径（默认值带 `scripts/../dist`，打印与 --json 里都不好读）
[ -d "$VE_DIST" ] && VE_DIST="$(cd "$VE_DIST" && pwd)"

# ---------- 主流程 ----------

VE_ITEMS=()          # JSON 明细
VE_FAILS=()          # 人类可读的不一致清单
total=0; checked=0; failed=0; contradictions=0; reason=""

files=""
if [ ! -d "$VE_DIST" ]; then
  reason="dist 目录不存在: $VE_DIST（先 cd web && npm run build）"
else
  files="$(ve_list_dist "$VE_DIST")"
  [ -n "$files" ] || reason="dist 目录为空: $VE_DIST"
fi

[ "$VE_JSON" -eq 1 ] || echo "verify-edge: dist=$VE_DIST → edge=$VE_EDGE"

if [ -n "$files" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    total=$((total + 1))
    local_md5="$(ve_md5 "$VE_DIST/$rel")"
    local_size="$(ve_size "$VE_DIST/$rel")"

    modes="plain"
    ve_is_nocache "$rel" && modes="qs hdr"    # 两种绕缓存写法都试

    file_ok=1; got_status=0; note=""; probes=""; contradiction=false
    # 两次取样各自的「状态/md5」签名与人类可读描述。**相符的那一次也要留下** ——
    # 只把唱反调的那次写进 note，会让「两次取样自相矛盾」与「两次都是旧字节」逐字同形。
    sig_list=(); desc_list=()
    for mode in $modes; do
      if ! ve_fetch "$VE_EDGE/$rel" "$mode"; then
        file_ok=0
        note="${note}${note:+；}[$mode] $VE_ERR"
        probes="${probes}${probes:+,}{\"mode\":$(ve_jstr "$mode"),\"http\":\"\",\"error\":$(ve_jstr "$VE_ERR")}"
        continue
      fi
      got_status=1
      if [ "$VE_STATUS" = "200" ] && [ "$VE_MD5" = "$local_md5" ] && [ "$VE_SIZE" = "$local_size" ]; then
        vs_local="＝本地"
      else
        vs_local="≠本地"
      fi
      sig_list+=("$VE_STATUS/$VE_MD5/$VE_SIZE")
      desc_list+=("[$mode] md5 ${VE_MD5:-?}（HTTP $VE_STATUS，${VE_SIZE} B${VE_XCACHE:+，x-cache: $VE_XCACHE}${VE_AGE:+，age: $VE_AGE}）$vs_local")
      probes="${probes}${probes:+,}{\"mode\":$(ve_jstr "$mode"),\"http\":$(ve_jstr "$VE_STATUS"),\"md5\":$(ve_jstr "$VE_MD5"),\"size\":$(ve_jstr "$VE_SIZE"),\"etag\":$(ve_jstr "$VE_ETAG"),\"x_cache\":$(ve_jstr "$VE_XCACHE"),\"age\":$(ve_jstr "$VE_AGE")}"
      if [ "$VE_STATUS" != "200" ]; then
        file_ok=0
        if [ "$VE_STATUS" = "403" ]; then
          note="${note}${note:+；}[$mode] 边缘 HTTP 403（缺 key 返的就是 403 不是 404，分不清没上传还是策略错）"
        else
          note="${note}${note:+；}[$mode] 边缘 HTTP $VE_STATUS ≠ 200"
        fi
      elif [ "$VE_MD5" != "$local_md5" ] || [ "$VE_SIZE" != "$local_size" ]; then
        file_ok=0
        note="${note}${note:+；}[$mode] md5 边缘 ${VE_MD5:-?} ≠ 本地 $local_md5（$VE_SIZE B vs $local_size B${VE_XCACHE:+，x-cache: $VE_XCACHE}${VE_AGE:+，age: $VE_AGE}）"
      fi
    done

    # 「两次取样自相矛盾」这一档：两次都拿到了 HTTP 响应，但状态/字节彼此不同。
    # 单次判据只会说「某一次 ≠ 本地」，说不出「两次互不相同」—— 而两者处置不同，
    # 所以这一档必须**有自己的名字**印出来（判据算出来了却不说，等于这一档不存在）。
    if [ "${#sig_list[@]}" -eq 2 ] && [ "${sig_list[0]}" != "${sig_list[1]}" ]; then
      contradiction=true
      contradictions=$((contradictions + 1))
      file_ok=0
      note="两次取样自相矛盾（同一 URL 的两种写法此刻给出不同字节）：${desc_list[0]} ｜ ${desc_list[1]}；本地 md5 $local_md5（$local_size B）。⚠️ **哪一次与本地相同不决定处置** —— 「两种写法都不进缓存键」那条声明从未在本档被行使过（见排错段）${note:+；单次判据并存：$note}"
    fi

    [ "$got_status" -eq 1 ] && checked=$((checked + 1))
    if [ "$file_ok" -eq 1 ]; then
      [ "$VE_JSON" -eq 1 ] || printf '  ok   %-44s %8s B  md5 %s\n' "$rel" "$local_size" "$local_md5"
    else
      failed=$((failed + 1))
      VE_FAILS+=("$rel: $note")
      [ "$VE_JSON" -eq 1 ] || printf '  FAIL %-44s %s\n' "$rel" "$note"
    fi
    VE_ITEMS+=("{\"path\":$(ve_jstr "$rel"),\"ok\":$([ "$file_ok" -eq 1 ] && echo true || echo false),\"local_md5\":$(ve_jstr "$local_md5"),\"local_size\":$(ve_jstr "$local_size"),\"nocache\":$(ve_is_nocache "$rel" && echo true || echo false),\"contradiction\":$contradiction,\"note\":$(ve_jstr "$note"),\"probes\":[$probes]}")
  done <<< "$files"

  # 边缘一个 HTTP 响应都没给（域名写错 / 网络断 / 全超时）⇒ 空集，不是通过
  [ "$checked" -eq 0 ] && reason="边缘 $VE_EDGE 一个 HTTP 响应都没取到（域名写错？网络不通？）"
fi

ve_verdict "$checked" "$failed" "$total" "$reason"
code=$?

if [ "$VE_JSON" -eq 1 ]; then
  items="$(IFS=,; echo "${VE_ITEMS[*]-}")"
  printf '{"dist":%s,"edge":%s,"total":%s,"checked":%s,"ok":%s,"failed":%s,"contradictions":%s,"exit":%s,"verdict":%s,"reason":%s,"files":[%s]}\n' \
    "$(ve_jstr "$VE_DIST")" "$(ve_jstr "$VE_EDGE")" "$total" "$checked" "$((total - failed))" \
    "$failed" "$contradictions" "$code" "$(ve_jstr "$VE_VERDICT")" "$(ve_jstr "$reason")" "$items"
  {
    echo "$VE_VERDICT"
    echo "EXIT: $code"
    # 排错段在 **--json 档也要印**（失败时）：它原先只挂在人眼分支上，而 `--json`
    # 是用法里写着的路径 ⇒ 走它的人永远看不到这段字。成功时不印，免得污染 json 用法。
    if [ "$code" -ne 0 ]; then echo "$VE_HINT"; fi
    if [ "$contradictions" -gt 0 ]; then echo "$VE_HINT_CONTRA"; fi
  } >&2
else
  if [ "${#VE_FAILS[@]}" -gt 0 ]; then
    echo "不一致清单（${#VE_FAILS[@]} 个）："
    for f in "${VE_FAILS[@]}"; do echo "  - $f"; done
    echo "$VE_HINT"
    if [ "$contradictions" -gt 0 ]; then echo "$VE_HINT_CONTRA"; fi
  fi
  [ "$code" -eq 4 ] && echo "$VE_HINT"
  echo "$VE_VERDICT"
  echo "EXIT: $code"
fi

exit "$code"

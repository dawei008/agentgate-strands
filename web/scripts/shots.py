#!/usr/bin/env python3
"""通用截图脚本（源自 /tmp/shot_bskin.py，参数化改造）。

用法示例：
    # 单页
    python3 web/scripts/shots.py --base http://127.0.0.1:5183 \
        --out /tmp/shots --shot agents:/#/agents

    # 多页 + 空态 mock
    python3 web/scripts/shots.py --out /tmp/shots --mock empty \
        --shot workbench:/#/workbench --shot agents:/#/agents

    # 从 JSON 计划文件批量截（见 --plan）
    python3 web/scripts/shots.py --out /tmp/shots --plan web/scripts/shots-plan.json

--shot 语法： name:hash[:click=<selector>|:fill=<selector>=<text>...]
    name   输出文件名（不带 .png）
    hash   页面 hash 路由（如 /#/agents 或 #/agents）
    click  可选，截图前依次点击的选择器（用于打开抽屉/切 tab）
    fill   可选，往输入框/textarea 填文本（与 click 按书写顺序执行）

计划文件（--plan）为 JSON 数组，每项：
    {"name": "...", "hash": "#/agents", "clicks": ["sel1"], "dark": false,
     "mock": null, "viewport": [1800, 950], "full_page": true, "wait": 1000}
未给出的字段落到命令行默认值。JSON 放不下注解，所以计划里非显然的取景决策记在这儿。

⚠️ **`full_page` 抓不到「自带滚动容器」里的东西**（实测 2026-08-26，报告抽屉）：
抽屉是 `position: fixed` 面板，正文滚动条在 `.rd-body` 自己身上
（`plan.css` `.report-drawer .rd-body { flex: 1; overflow: auto }`）。开 `full_page`
只把**抽屉背后那一页**拍全（视口 1800x950 下 PNG 高 950 → 1172），而 `.rd-body`
的可见盒（y 264–909）与卡片位置**逐值不变** ⇒ 折线以下的内容一个像素都拍不到。
滚动容器裁掉的内容根本不被绘制，任何截图模式都变不出来 —— 唯一的办法是**给足视口高**
（`.rd-body` 的 clientHeight 跟视口走：950→645、1400→1095、1900→1595）。
故 `18-report-advice` 用 1800x1900：`scrollHeight == clientHeight`（1595）⇒ 整份报告
**不需要滚动**就在镜内，取景不依赖滚动位置。刻意**不**改 14 的取景（14 是「用户默认
视口看到的样子」，且它的已登记两态 `0↔1521` 要留在同一基点上继续可比）；两张同源
不同取景，14 管首屏、18 管建议卡（`report-drawer-advice-0/1` 在 y1337–1679）。

⚠️⚠️ **上面那段的前提在「报告独立成页」批之后变了 —— 结论没变，理由换了。**（2026-08-27）
报告的生产入口改成独立页 `#/report/<run_key>`，14/18 两条计划项的 `hash` 已直指深链
（不再「点方案页那颗按钮」—— 那颗按钮现在是导航，`clicks` 走完只是绕四步到同一个 URL，
却把报告基线拴在运行历史表格的 markup 上，而 `7866b06` 刚给那张表加过勾选列）。
成页之后**滚动容器是 `window`**，`full_page` 技术上抓得全整份报告了 —— 但**仍然不许开**：
Playwright 的 fullPage 把 `position: sticky` 按**原视口**解算，于是分节锚点条与底部操作条
会被画在 y≈900（首屏底边）**压在正文上**，镜内内容反被自己的吸顶条盖掉。
⇒ 「给足视口高 + `full_page: false`」这套配方**照旧**，18 继续用 1800x1900。
两笔随取景变更**作废的登记**（别再拿旧数当基点）：14 的两态 `0↔1521`，以及下面要点里
那笔 14/17 共享的 `429 px @ x249–300 y537–551`（「运行历史」卡标题 alpha 双值态）——
14 已经**不再拍到方案页**，那笔在 14 上结构性消失、只剩 17 一个载体；
14 自己的相位登记要等重截装好新基线之后重新建立。

要点（继承自 shot_bskin.py 的实测经验）：
- access_token 必须用 add_init_script 在首帧前注入：initAuth 在 render 之前读
  sessionStorage，且 body:not(.is-authed) .shell { visibility:hidden }，
  事后 setItem 拍到的是空壳。
- v3-C 起全站恒暗：--dark / dark 字段保留为 no-op 兼容旧计划文件，
  不再写任何主题 localStorage 键（机制已随主题切换一起移除）。
- 截图的**确定性**由两件事保证，两件都在 take() 里、都不可省（成因与实测见就近注释）：
  ⑴ 冻钟 FROZEN_NOW —— 相对时间夹具不再把「此刻」盖进 PNG；
  ⑵ 等 document.fonts.ready —— `font-display: swap` 不再能拿回落字形入镜。
  两件都做完仍有**第三个源**（栅格两态，实测多等 2500 ms 不收敛）—— 未修，
  别把偶发下面这些读数当「配方回退了」。已知六笔，连掩码 sha 一起记：
    · 05/06/07  899 px @ x249–383 y384–399  `.card-title`，掩码 sha 88bc1e417a01
                （三图**共享同一像素集**，但相位每图独立）
    · 05        1628 px = 526 @ y514–532 x1204–1545 + 1102 @ y562–576 x1357–1544
                只在 05 上见过；同树两遍读到的 **2527 恰好 = 899 + 1628**（两条带各自
                开关、加法逐值闭合）⇒ 见到 2527 别当第三个数
    · 14/17     429 px @ x249–300 y537–551 「运行历史」卡标题的 alpha 双值态 —— 不是新带，
                是 `51b83dd` 已记那笔（交并分解见
                `.scratch/icon-missing-ic-class/RESULT.md:64-71`），头注表此前漏登；
                **与 17 那笔 942 不是同一条带**，且两图共享同一 bbox 但**每图每遍各自开关**
    · 17        942 px = 494 @ y330–344 + 448 @ y240–252，494 的掩码 sha b565d25381c9
    · 13        499 px @ x984–1045 y779–793  「+ 新建方案」主按钮文字，
                掩码 sha 0e5d5cf7eaa9（带内总墨量两侧同为 100952 ⇒ 抗锯齿重排非内容变更）
    · 08        0~1 px 压在容差边上（对基线 maxΔ=6 读 0，但两遍互比 maxΔ=9、1 px 超容差）
                ⇒ 它的带是 `0~1` 而不是「恒 0」
  ⚠️ **上面新补两笔（05 的 1628、14/17 的 429）的身份是 bbox + 计数，不是 sha**：两笔都在
  批 3 的 pre/post 两棵树上量到，那**一对图**的掩码 sha 是 df174e2cd2cd / fdcca20fc743，
  换一对图就变 —— sha 只在同一对图内可比，跨基点判同一条带只能用 bbox + 计数。
  相位样本各留一对 + 复算脚本：`.scratch/visual-baseline-archive/raster-states/`。
  ⚠️ **判据：数字接近不等于同一条带 —— 要掩码 sha 相等才算同一笔。** 13 的 499 与 17 的
  494 只差 5 px，却是两个不同像素集（sha 0e5d5cf7eaa9 ≠ b565d25381c9、x 区间也不同）；
  按数字并带会把一笔未知债并进已知债里。
  ⚠️ 同族：**重截清不掉这些两态**，只是替它挑了一个相位（899 的掩码 sha 在整批重截前后
  完全一致 ⇒ 那是元素属性、跨基点搬家不变）。重截能清的是携带债与墙钟腐烂。
  ⚠️ 还有**第四个源，但它在门槛上读 0** —— 单独记，免得下一个人用容差 0 量到它、
  当成新债：`.plan-progress-title .dot.pulse` 是 `1.6s ease-in-out infinite` 的 CSS 动画
  （plan.css:40），冻钟**管不着**它（`set_fixed_time` 只固定时间读取，动画自己走时间线）。
  实测 2026-08-26 同一 bbox `x245–252 y86–93`：08 = 45 px maxΔ=4、18 = 38 px maxΔ=1
  （两图掩码 md5 不同 —— 相位对不同，sha 只在同一对图内可比）。**逐通道 Δ 都 < 容差 8
  ⇒ compare.py 读 0**；即便那 8×8=64 px 全变，占 18 那张也只有 0.0019%，单它永远够不到 1%。
  真要清就给 context 上 reduced-motion（plan.css:46 有 `animation: none` 分支）——
  那会动**全部**基线（整批重截），不是随手能带的改动。
"""
from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

AUTH_INIT = "sessionStorage.setItem('access_token','mock-access-token')"

# 冻钟时刻 —— 所有**相对时间夹具**都相对它渲染：`handlers.ts` 的 `utcAgo(h)`
# （减整小时后按**分钟精度**渲染成绝对串）与 `nowEpoch()`（心跳年龄）。
# 不冻的后果是实测过的「墙钟腐烂」：截图把「此刻」盖进 PNG，读数随 PNG 年龄单调
# 增长、无上界、永不回 0，且「连量两遍同数」判据对它失效（同一分钟内必然同数）。
#
# 取值理由（三条，取值本身决定所有相对时间夹具的长相，故就近记）：
#  ⒈ **不新造纪元**：这个瞬间已经是本仓库既有的「假数据基准」——
#     `BigscreenPage.pinnedNow()` 的 `Date.UTC(2026, 7, 22, 4, 12, 0)`，同一件事
#     （截图可复现）本来就该只有一个常量。两处**互不依赖**：大屏那条 `?mock=bigscreen*`
#     自己钉，本常量管其余 15 张，值相同只是为了口径一致。
#  ⒉ **晚于所有绝对时刻夹具中参与「近 24h」判定的那批**（`AGENT_RUNS` 最新一行
#     2026-08-21 06:00 UTC）⇒ 没有夹具被推成「未来」（`kpi.ts` 的窗口是
#     `t >= now-24h && t <= now`，未来行会被静默摘掉），而 `utcAgo(2..5/20)` 五行
#     恒落在窗内 —— 「近 24h」KPI 口径与真钟下一致。
#  ⒊ **语义中性**：不取整点、不取午夜 —— 整点/午夜会让「相对时间夹具」看起来像
#     刻意对齐的假数据，也会把「跨日/跨小时」这类边界态钉死成基线里唯一被测的一种。
FROZEN_NOW = datetime.datetime(2026, 8, 22, 4, 12, 0, tzinfo=datetime.timezone.utc)


def parse_shot(spec: str, defaults: dict) -> dict:
    parts = spec.split(":")
    if len(parts) < 2:
        sys.exit(f"--shot 需要 name:hash 形式，收到: {spec!r}")
    name = parts[0]
    rest = parts[1:]
    steps = []  # [("click", sel) | ("fill", sel, text)]，按书写顺序执行
    hash_parts = []
    for p in rest:
        if p.startswith("click="):
            steps.append(("click", p[len("click="):]))
        elif p.startswith("fill="):
            sel, _, text = p[len("fill="):].partition("=")
            steps.append(("fill", sel, text))
        else:
            hash_parts.append(p)
    return {
        **defaults,
        "name": name,
        "hash": ":".join(hash_parts),
        "steps": steps,
    }


def normalize_hash(h: str) -> str:
    h = h.strip()
    if h.startswith("/#"):
        return h
    if h.startswith("#"):
        return "/" + h
    if h.startswith("/"):
        return "/#" + h
    return "/#/" + h


def take(browser, base: str, out_dir: pathlib.Path, shot: dict) -> pathlib.Path:
    w, h = shot["viewport"]
    ctx = browser.new_context(viewport={"width": w, "height": h})
    # 冻钟必须在 goto 之前装（首帧就有 mock 夹具在读 Date.now），且装在 context 上
    # 才覆盖之后 new_page 出来的页。用 set_fixed_time 而**不是** install()：
    # 前者只固定时间**读取**（Date.now / new Date）、**timers 照跑**，
    # 后者会连 setTimeout/setInterval/rAF/performance 一起接管 —— 那会停掉应用的
    # 30s 轮询与 rAF 动画，把「等 networkidle 再截」这套配方的前提改掉。
    ctx.clock.set_fixed_time(FROZEN_NOW)
    if not shot.get("no_auth"):
        ctx.add_init_script(AUTH_INIT)
    else:
        # 一步化登录后未登录会自动 302 跳 Cognito——拍登录门必须注入
        # signed_out 标记让 AuthGate 停在门面页（「已退出登录」态）
        ctx.add_init_script("sessionStorage.setItem('agentgate_signed_out','1')")
    # shot.get("dark")：v3-C 恒暗后为 no-op（兼容旧计划文件字段）
    page = ctx.new_page()
    # mock 开关走 location.search（handlers.ts 的 mockEmpty 读的是 search 不是 hash），
    # 所以 ?mock= 必须插在 # 之前：/?mock=empty#/workbench
    h = normalize_hash(shot["hash"])  # 形如 /#/workbench
    if shot.get("mock"):
        url = base + "/?mock=" + shot["mock"] + h.lstrip("/")
    else:
        url = base + h
    page.goto(url, wait_until="networkidle")
    page.wait_for_timeout(shot["wait"])
    # steps 与旧 clicks 字段兼容（plan 文件仍可用 "clicks"）
    steps = shot.get("steps") or [("click", c) for c in shot.get("clicks", [])]
    for step in steps:
        if step[0] == "fill":
            page.fill(step[1], step[2])
        else:
            page.click(step[1])
        page.wait_for_timeout(shot["click_wait"])
    # 截图前把鼠标移出视口，清掉最后一次 click 留下的 hover 态。
    # 实测（17-run-compare 首截时逮到）：点完抽屉里的按钮后鼠标停在原坐标，抽屉盖上来
    # 之后那个坐标底下换成了别的行 → 那行带 hover 底色。它**随机出现**（同一条命令
    # 全盘跑法 2 次无 hover、第 3 次有），摆幅 23502 px = 1.13%，正好横跨 1% 阈 ⇒
    # 没有任何基线选法能让这道门槛稳定，只能从配方端消掉。
    # 移到 (-20,-20) 与移到视口右下外 (w+50,h+50) 两个反方向截出的图**逐像素同值**，
    # 说明两者都真的「没有元素被 hover」，不是被 clamp 回了内容区（否则一个会 hover
    # 左上 logo、一个 hover 右下角，两图必然不同）。
    page.mouse.move(-20, -20)
    page.wait_for_timeout(300)
    # 字形就绪：`networkidle` + 固定 timeout **不覆盖字体** —— `tokens.css` 的四个
    # @font-face 都是 `font-display: swap`，字形没到就先用回落字形画，到了再换 ⇒
    # 同一个元素能截出两种字形。这不是抖动，调门槛治不了，只能等。
    # 位置刻意在 click steps **之后**：抽屉/切 tab 揭出来的内容会**再**请求字形，
    # 放在 goto 后面等的是「揭开之前」那批，白等。
    # ⚠️ 别把它当「字形两态已清零」的证明：装完新基线后 17-run-compare 仍有一笔
    # 942 px（含 y330-344 那 494 px）的两态，在本调用**之后**照样出现，且 ±1 px
    # 纵移归不了零、再多等 2500 ms 也不收敛 ⇒ 那是**第三个源**（栅格化不确定），
    # 与本行治的「字体没加载完」是两件事，别合读。
    page.evaluate("async () => { await document.fonts.ready; return document.fonts.status; }")
    out = out_dir / (shot["name"] + ".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), full_page=shot["full_page"])
    ctx.close()
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="AgentGate React 版通用截图脚本")
    ap.add_argument("--base", default="http://127.0.0.1:5183", help="dev server 地址")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--shot", action="append", default=[],
                    help="name:hash[:click=selector...]，可多次")
    ap.add_argument("--plan", help="JSON 计划文件，条目字段见脚本头注释")
    ap.add_argument("--viewport", default="1800x950", help="默认视口 WxH")
    ap.add_argument("--dark", action="store_true", help="默认深色主题")
    ap.add_argument("--mock", default=None, help="默认 ?mock= 值（如 empty）")
    ap.add_argument("--wait", type=int, default=1000, help="加载后等待 ms")
    ap.add_argument("--click-wait", type=int, default=700, help="每次点击后等待 ms")
    ap.add_argument("--no-full-page", action="store_true", help="只截视口不截整页")
    args = ap.parse_args()

    vw, vh = (int(x) for x in args.viewport.lower().split("x"))
    defaults = {
        "viewport": (vw, vh),
        "dark": args.dark,
        "mock": args.mock,
        "wait": args.wait,
        "click_wait": args.click_wait,
        "full_page": not args.no_full_page,
    }

    shots = [parse_shot(s, defaults) for s in args.shot]
    if args.plan:
        for item in json.loads(pathlib.Path(args.plan).read_text()):
            merged = {**defaults, "clicks": [], **item}
            if "viewport" in item:
                merged["viewport"] = tuple(item["viewport"])
            shots.append(merged)
    if not shots:
        sys.exit("没有任何截图任务：给 --shot 或 --plan")

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--font-render-hinting=none"])
        for shot in shots:
            path = take(browser, args.base, out_dir, shot)
            print(f"ok  {path}")
        browser.close()


if __name__ == "__main__":
    main()

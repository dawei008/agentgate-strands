#!/usr/bin/env python3
"""视觉基线比对：PIL 逐像素 diff，阈值默认 1% 像素差。

用法：
    python3 web/tests/visual/compare.py --baseline web/tests/visual/baseline \
        --current /tmp/t8-visual-current [--threshold 0.01] [--diff-dir /tmp/t8-visual-diff]

规则：
- 以 baseline 目录里的 *.png 为准，current 缺图算失败；current 多出的图只警告。
- 尺寸不一致直接算失败（不缩放——缩放会掩盖布局回归）。
- 像素比较带每通道容差（默认 8/255），吸收抗锯齿细微抖动；
  超容差像素占比 > threshold 即失败。
- 失败的图输出红色高亮 diff 到 --diff-dir。

退出码：0 全部通过；1 有差异或缺图。

📌 **登记键：这把尺子「不保证的粒度下界」= 逐图 1% × (W×H)**（2026-08-26 落，裁定 R57⒜；
清偿条件写在键里，见末段）。低于该值的墨迹改动本尺子**结构上读不出** ——
是「读不出」而不是「这次没读出」，两者的区别决定了要不要另外补钉子。

⚠️ **它不是一个全局常量，别登记成一个数**：地板随图的像素总数走。现盘 18 张现算
（`Image.open(p).size` → `w*h*0.01`）跨度 **3.5 倍**：
最小 **9,900 px**（13-probe-plaintext 1100×900）→ 最大 **34,200 px**
（18-report-advice 1800×1900）；中间多数 1800×950 档 = 17,100 px。
写一个数会在**两个方向**上错：拿 34,200 当全局，会把 13 上一笔 20,000 px 的回归误判成
「尺子读不出」（那张地板只有 9,900，其实读得出）；反过来任何小于**该图自身**地板的改动
都读不出。且 `full_page` 图的高度随内容变 ⇒ 地板会跟着变，**引用时现算，别抄这里的数**
（同族「一块墨迹两个常量」，见 memory visual-px-three-states ⑮）。

**替这道缝守的是 DOM 钉子**，不是更小的阈值：批 7 的可见产物（建议卡）落在 18 上，
而 18 的地板恰是全盘最大的 34,200 px ⇒ 该批只能靠
`web/tests/report-actionable-drawer.test.tsx`（三种 kind / paste / copy / 反向钉）。
同缝已知住着一个噪声源而非债：`.dot.pulse` 那 8×8=64 px 占 18 仅 **0.0019%**（见 shots.py 头注）。

**清偿条件**：出现一个**既小于该图地板、又没有 DOM 钉子覆盖**的回归时才重开此问。
单纯「又见到一个小于门槛的绿」**不构成**清偿 —— 那正是这条键预言的常态。
"""
from __future__ import annotations

import argparse
import pathlib
import sys

from PIL import Image, ImageChops


def compare_one(base_png: pathlib.Path, cur_png: pathlib.Path,
                threshold: float, tolerance: int,
                diff_dir: pathlib.Path) -> tuple[bool, str]:
    base = Image.open(base_png).convert("RGB")
    cur = Image.open(cur_png).convert("RGB")
    if base.size != cur.size:
        return False, f"尺寸不一致 baseline={base.size} current={cur.size}"

    diff = ImageChops.difference(base, cur)
    # 任一通道超容差即该像素算差异（逐通道取最大再二值化）
    r, g, b = diff.split()
    mask = ImageChops.lighter(ImageChops.lighter(r, g), b)
    mask = mask.point(lambda v: 255 if v > tolerance else 0)

    hist = mask.histogram()
    changed = sum(hist[1:])
    total = base.size[0] * base.size[1]
    ratio = changed / total
    if ratio <= threshold:
        return True, f"diff {ratio:.4%} ({changed}/{total} px)"

    # 输出高亮 diff 图：current 打底 40% 亮度，差异像素纯红
    diff_dir.mkdir(parents=True, exist_ok=True)
    overlay = Image.new("RGB", base.size, (255, 0, 0))
    dimmed = cur.point(lambda v: int(v * 0.4))
    out = Image.composite(overlay, dimmed, mask)
    out_path = diff_dir / base_png.name
    out.save(out_path)
    return False, f"diff {ratio:.4%} 超阈值 {threshold:.2%} → {out_path}"


def main() -> None:
    ap = argparse.ArgumentParser(description="视觉基线逐像素比对")
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--current", required=True)
    ap.add_argument("--threshold", type=float, default=0.01, help="允许的差异像素占比，默认 0.01 = 1%%")
    ap.add_argument("--tolerance", type=int, default=8, help="每通道像素值容差，默认 8")
    ap.add_argument("--diff-dir", default="/tmp/t8-visual-diff", help="diff 图输出目录")
    args = ap.parse_args()

    baseline = pathlib.Path(args.baseline)
    current = pathlib.Path(args.current)
    diff_dir = pathlib.Path(args.diff_dir)

    base_pngs = sorted(baseline.glob("*.png"))
    if not base_pngs:
        sys.exit(f"baseline 目录没有 png: {baseline}")

    failures: list[str] = []
    for bp in base_pngs:
        cp = current / bp.name
        if not cp.exists():
            failures.append(f"FAIL {bp.name}: current 缺图 {cp}")
            print(failures[-1])
            continue
        ok, msg = compare_one(bp, cp, args.threshold, args.tolerance, diff_dir)
        line = f"{'ok  ' if ok else 'FAIL'} {bp.name}: {msg}"
        print(line)
        if not ok:
            failures.append(line)

    extra = {p.name for p in current.glob("*.png")} - {p.name for p in base_pngs}
    for name in sorted(extra):
        print(f"warn {name}: current 有但 baseline 没有（新页面？记得补基线）")

    if failures:
        print(f"\n{len(failures)}/{len(base_pngs)} 张超阈值，diff 图在 {diff_dir}")
        sys.exit(1)
    print(f"\n全部通过（{len(base_pngs)} 张）")


if __name__ == "__main__":
    main()

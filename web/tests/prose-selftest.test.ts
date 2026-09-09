// expectProseGone 的量具自检（guard-debt 纪律：量具要先证明自己能红，
// 否则 15 处钉换成一个恒绿的 helper = 集体假绿）。
import { describe, expect, it } from "vitest";
import { expectProseGone } from "./prose";

function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
}

describe("expectProseGone 量具自检", () => {
  it("三条路径各自能红：版面文本 / 后代 title / 容器自身 title", () => {
    expect(() => expectProseGone(el("<p>废话短语在版面</p>"), "废话短语"))
      .toThrow(/版面文本/);
    expect(() => expectProseGone(el('<span title="废话短语在悬停"></span>'), "废话短语"))
      .toThrow(/title/);
    const self = el("");
    self.setAttribute("title", "废话短语在容器自身");
    expect(() => expectProseGone(self, "废话短语")).toThrow(/容器自身/);
  });

  it("阳性对照：短语真不在时通过", () => {
    expect(() => expectProseGone(el("<p>干净的内容</p>"), "废话短语")).not.toThrow();
  });
});

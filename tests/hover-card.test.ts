/// 悬浮卡（DESIGN-components「悬浮卡 HoverCard」，画板 06e734c8）：停在出错那句话上浮起纸卡，里面能点、能选字。
/// 开合规则是纯函数（hoverCardNext），组件只把指针、焦点、按键翻译成事件。
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const noop = () => undefined;
const { hoverCardNext, HOVER_CARD_LEAVE_MS, HoverCard } = await import("../src/ui/HoverCard.tsx");
const { Details } = await import("../src/ui/Details.tsx");

test("悬浮卡的开合：停够了出（悬停态）；按一下钉住、再按收；悬停态离开后收，钉住的离开不收；点外面 / Esc / 滚动都收", () => {
  assert.equal(hoverCardNext("closed", "delay"), "hover");
  assert.equal(hoverCardNext("hover", "delay"), "hover");
  assert.equal(hoverCardNext("pinned", "delay"), "pinned");

  assert.equal(hoverCardNext("closed", "press"), "pinned");
  assert.equal(hoverCardNext("hover", "press"), "pinned");
  assert.equal(hoverCardNext("pinned", "press"), "closed");

  assert.equal(hoverCardNext("hover", "leave"), "closed");
  assert.equal(hoverCardNext("pinned", "leave"), "pinned");
  assert.equal(hoverCardNext("closed", "leave"), "closed");

  for (const from of ["closed", "hover", "pinned"] as const) {
    assert.equal(hoverCardNext(from, "dismiss"), "closed");
  }
});

test("离开字和卡之后等 300ms 才收：给斜着挪进卡里的余地", () => {
  assert.equal(HOVER_CARD_LEAVE_MS, 300);
});

test("HoverCard 平时：触发它的是一颗键（说明会弹出对话框、现在没开）；卡不在页面里", () => {
  const html = render(HoverCard, {
    label: "详情",
    triggerLabel: "查看错误详情",
    content: "卡里的内容",
    children: "!",
  });
  assert.match(
    html,
    /<button type="button" class="ss-hovercard" aria-label="查看错误详情" aria-haspopup="dialog" aria-expanded="false">!<\/button>/,
  );
  assert.doesNotMatch(html, /卡里的内容/);
});

test("HoverCard 的 className 加在触发键上", () => {
  const html = render(HoverCard, {
    label: "详情",
    content: "x",
    className: "ss-markbtn",
    children: "!",
  });
  assert.match(html, /<button type="button" class="ss-hovercard ss-markbtn"/);
});

test("Details（D，2026-10-06）：入口是错误前面的「!」——一颗图标键，读屏念「查看错误详情」；原文不在页面里", () => {
  const html = render(Details, { text: "Permission denied (os error 13)", onCopy: noop });
  assert.match(
    html,
    /<button type="button" class="ss-hovercard ss-markbtn ss-markbtn--panel" aria-label="查看错误详情" aria-haspopup="dialog" aria-expanded="false"><svg[^>]*width="16"/,
  );
  assert.doesNotMatch(html, /Permission denied/);
  // 网关行里小一号（14）；出错页标题前同灰面板（16，2026-10-06 真机：18 比 15 号标题大、看着错位）
  assert.match(
    render(Details, { text: "x", onCopy: noop, size: "row" }),
    /ss-markbtn--row"[^>]*><svg[^>]*width="14"/,
  );
  assert.match(
    render(Details, { text: "x", onCopy: noop, size: "title" }),
    /ss-markbtn--title"[^>]*><svg[^>]*width="16"/,
  );
});

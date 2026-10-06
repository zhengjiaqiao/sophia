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

test("HoverCard 平时：触发的那句话能 Tab 停到，说明会弹出对话框、现在没开；卡不在页面里", () => {
  const html = render(HoverCard, {
    label: "详情",
    content: "卡里的内容",
    children: "0.2.0 安装失败：没有权限替换 Sophia",
  });
  assert.match(
    html,
    /<span class="ss-hovercard" tabindex="0" role="button" aria-haspopup="dialog" aria-expanded="false">0\.2\.0 安装失败：没有权限替换 Sophia<\/span>/,
  );
  assert.doesNotMatch(html, /卡里的内容/);
});

test("HoverCard 的 className 加在触发的那句话上（网关行的原因自己是 flex 项）", () => {
  const html = render(HoverCard, {
    label: "详情",
    content: "x",
    className: "gw-row__reason",
    children: "找不到这个地址",
  });
  assert.match(html, /<span class="ss-hovercard gw-row__reason" tabindex="0"/);
});

test("Details：不再是一颗键，是挂在出错那句话上的悬浮卡；原文不在页面里", () => {
  const html = render(Details, {
    text: "Permission denied (os error 13)",
    onCopy: noop,
    children: "没有权限替换 Sophia",
  });
  assert.match(
    html,
    /<span class="ss-hovercard"[^>]*aria-haspopup="dialog"[^>]*>没有权限替换 Sophia<\/span>/,
  );
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /Permission denied/);
});

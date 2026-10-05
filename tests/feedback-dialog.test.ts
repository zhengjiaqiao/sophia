/// 反馈小窗的长相（spec 2026-10-04-reporting-feedback R12、R14；画板 FeedbackEmpty / Feedback / FeedbackFailed）：
/// 照确认框（居中、遮罩），宽 480；输入框、截图缩略图与上传细线、按钮行的失败原因。服务端渲染只看初始态，
/// 截图格与按钮行拆成纯展示的 `ShotTile` / `FeedbackFoot` 各自断言。交互的纯逻辑在 feedback.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";

const noop = () => {};
const { FeedbackDialog, ShotTile, FeedbackFoot, inertBehind } =
  await import("../src/ui/FeedbackDialog.tsx");
const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = uiCss.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m[1];
};

test("小窗：确认框的层与遮罩、宽档 480；标题「反馈问题」、有读屏名的输入框与占位、框下一行提示", () => {
  const html = render(FeedbackDialog, {
    upload: async () => "x",
    send: async () => undefined,
    onClose: noop,
    onSent: noop,
    onGithub: noop,
  });
  assert.match(html, /class="ss-confirm-layer"/);
  assert.match(html, /class="ss-confirm-veil ss-confirm-veil--full"/);
  assert.match(
    html,
    /<div class="ss-confirm ss-confirm--wide"[^>]*role="dialog"[^>]*aria-modal="true"/,
  );
  assert.match(html, /class="ss-confirm__title"[^>]*>反馈问题</);
  assert.match(
    html,
    /<textarea[^>]*class="ss-feedback__text"[^>]*aria-label="反馈内容"[^>]*placeholder="说说遇到的问题，或想要的功能"/,
  );
  assert.match(html, /maxLength="8000"/i);
  assert.match(html, /class="ss-feedback__hint"[^>]*>.*可以粘贴或拖入截图/);
  // 还没放截图：没有缩略图那一行
  assert.doesNotMatch(html, /ss-feedback__shots/);
  // 按钮行：取消（默认键）、发送（墨键，没写字时禁用，理由「先写几句」）
  assert.match(
    html,
    /<button[^>]*class="ss-btn ss-btn--row"[^>]*>取消<\/button>.*<button[^>]*class="ss-btn ss-btn--primary ss-btn--row"[^>]*title="先写几句"[^>]*disabled=""[^>]*>发送<\/button>/,
  );
});

test("ShotTile 上传中：缩略图、沿边缘的细线（pathLength=100，画到百分比）、右上角百分比；没有去掉键", () => {
  const html = render(ShotTile, {
    url: "blob:2",
    phase: "uploading",
    percent: 62,
    n: 2,
    onRemove: noop,
  });
  assert.match(html, /role="img"[^>]*aria-label="截图 2，正在上传 62%"/);
  assert.match(html, /<img[^>]*src="blob:2"[^>]*alt=""/);
  assert.match(html, /<rect[^>]*pathLength="100"[^>]*stroke-dasharray="62 100"/);
  assert.match(html, /class="ss-feedback__percent"[^>]*>62%</);
  assert.doesNotMatch(html, /去掉截图/);
});

test("ShotTile 传完：细线不画了，百分比淡出（留在原处、读屏不念），去掉键在同一处", () => {
  const html = render(ShotTile, {
    url: "blob:1",
    phase: "done",
    percent: 100,
    n: 1,
    onRemove: noop,
  });
  assert.match(html, /aria-label="截图 1"/);
  assert.doesNotMatch(html, /<rect/);
  assert.match(html, /class="ss-feedback__percent"[^>]*aria-hidden="true"/);
  assert.match(html, /<button[^>]*class="ss-feedback__remove"[^>]*aria-label="去掉截图 1"/);
});

test("ShotTile 没传上去：可以去掉，读屏说发送时再试", () => {
  const html = render(ShotTile, {
    url: "blob:3",
    phase: "failed",
    percent: 40,
    n: 3,
    onRemove: noop,
  });
  assert.match(html, /aria-label="截图 3，没传上去，发送时再试"/);
  assert.match(html, /aria-label="去掉截图 3"/);
  // 细线停在没传上去时的值，百分比收起
  assert.match(html, /stroke-dasharray="40 100"/);
  assert.match(html, /class="ss-feedback__percent"[^>]*aria-hidden="true"/);
});

test("ShotTile 准备中（粘贴 / 拖进来当下）：已占一格，还没有缩略图，百分比 0，没有去掉键", () => {
  const html = render(ShotTile, {
    url: null,
    n: 1,
    phase: "preparing",
    percent: 0,
    onRemove: noop,
  });
  assert.match(html, /aria-label="截图 1，正在准备"/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /class="ss-feedback__percent">0%</);
  assert.doesNotMatch(html, /去掉截图/);
});

test("FeedbackFoot 发送中：取消与发送都禁用，理由「正在发送」（键盘也按不动）", () => {
  const html = render(FeedbackFoot, {
    text: "打不开",
    failed: null,
    sending: true,
    onCancel: noop,
    onSend: noop,
    onGithub: noop,
  });
  assert.match(
    html,
    /<button[^>]*class="ss-btn ss-btn--row"[^>]*title="正在发送"[^>]*disabled=""[^>]*>取消<\/button>/,
  );
  assert.match(
    html,
    /<button[^>]*class="ss-btn ss-btn--primary ss-btn--row"[^>]*title="正在发送"[^>]*disabled=""[^>]*>发送<\/button>/,
  );
  // 没失败：按钮行里没有 `在 GitHub 提` 那颗浅键
  assert.doesNotMatch(html, /ss-btn--quiet/);
});

test("FeedbackFoot 失败：左边一句「发送失败 · 网络不通」，主键变 `再试一次`；没写字时仍禁用", () => {
  const html = render(FeedbackFoot, {
    text: "打不开",
    failed: "network",
    sending: false,
    onCancel: noop,
    onSend: noop,
    onGithub: noop,
  });
  // 原因后隔两个不断行空格一颗浅键 `在 GitHub 提 ↗`（2026-10-05 产品负责人：常驻一个 GitHub 入口），只在失败时出现
  assert.match(
    html,
    /class="ss-feedback__failure"[^>]*>发送失败 · 网络不通\u00a0\u00a0(?:<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--quiet"[^>]*>在 GitHub 提</,
  );
  assert.match(
    html,
    /<button[^>]*class="ss-btn ss-btn--primary ss-btn--row"[^>]*>再试一次<\/button>/,
  );
  const limited = render(FeedbackFoot, {
    text: "x",
    failed: "rateLimited",
    sending: false,
    onCancel: noop,
    onSend: noop,
    onGithub: noop,
  });
  assert.match(limited, /发送失败 · 发得太频繁，稍后再试/);
});

test("量：宽 480；输入框 recess 底、发丝线、最小高 140、获焦线色 ink-mute；缩略图 56 方、细线 1.5 ink；百分比 12 等宽数字", () => {
  assert.match(rule(".ss-confirm--wide"), /width:\s*480px/);
  const box = rule(".ss-feedback__box");
  assert.match(box, /background:\s*var\(--recess\)/);
  assert.match(box, /border:\s*1px solid var\(--hairline\)/);
  assert.match(box, /min-height:\s*140px/);
  // 获焦与拖着图片经过时同一条规则
  assert.match(
    uiCss,
    /\.ss-feedback__box:focus-within,\n\.ss-feedback__box\[data-drop="over"\] \{/,
  );
  assert.match(rule('.ss-feedback__box[data-drop="over"]'), /border-color:\s*var\(--ink-mute\)/);
  const shot = rule(".ss-feedback__shot");
  assert.match(shot, /width:\s*56px/);
  assert.match(shot, /height:\s*56px/);
  assert.match(rule(".ss-feedback__ring rect"), /stroke:\s*var\(--ink\)/);
  const percent = rule(".ss-feedback__percent");
  assert.match(percent, /font-size:\s*var\(--size-label\)/);
  assert.match(percent, /font-variant-numeric:\s*tabular-nums/);
  // 减少动效：细线、百分比、去掉键都即时
  assert.match(uiCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ss-feedback__ring rect/);
});

// 复审第二轮 2：小窗开着时应用壳的其余部分 inert（小窗 portal 在 #root 外不受影响）：菜单、快捷键把焦点
// 往遮罩后面放（⌘F 聚焦筛选框）放不进去；关窗时恢复。与推入页共用一套计数（holdInert），谁最后放手谁摘掉
test("inertBehind：给 #root 加 inert，关窗放手时摘掉；已被推入页持有时不提前摘", async () => {
  const { holdInert } = await import("../src/ui/PushedPage.tsx");
  const attrs = new Set<string>();
  const root = {
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
  const lookup = (id: string) => (id === "root" ? root : null);
  const release = inertBehind(lookup);
  assert.ok(attrs.has("inert"));
  release();
  assert.ok(!attrs.has("inert"));
  const page = holdInert(root);
  const again = inertBehind(lookup);
  again();
  assert.ok(attrs.has("inert"), "推入页还盖着");
  page();
  assert.ok(!attrs.has("inert"));
  // 没有 #root（测试、托盘）：什么都不做
  inertBehind(() => null)();
});

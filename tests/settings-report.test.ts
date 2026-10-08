/// 设置「关于」里的 `使用统计和错误报告`（spec 2026-10-04-reporting-feedback R5、R6、R9；画板「关于 · 使用统计」B）：
/// 一行设置行：名字、一句灰字后接浅键 `隐私说明 ↗`，右端一个开关；这份构建不能上报（内部版、开发版没设地址、
/// DO_NOT_TRACK）时开关不画。右端一列在开关前是 `反馈问题`（默认键紧凑；有接收服务就有，DO_NOT_TRACK 不管它）
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const noop = () => {};
const { ReportRow, PRIVACY_URL, ISSUES_URL } = await import("../src/pages/ReportRow.tsx");

test("能上报时：名字、灰字、浅键隐私说明、开关（开着）", () => {
  const html = render(ReportRow, {
    settings: { autoReport: true, available: true, feedback: false },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
  });
  assert.match(html, /使用统计和错误报告/);
  assert.match(html, /匿名发送使用数据、错误和崩溃报告，用于改进 Sophia 和排查问题/);
  assert.match(html, /隐私说明/);
  assert.match(html, /ss-btn--quiet/);
  assert.match(html, /role="switch"[^>]*aria-checked="true"/);
});

// 常驻的 GitHub 入口（2026-10-05 产品负责人）：灰字行里两颗浅键，`隐私说明` 在前、`在 GitHub 提` 在后；
// 2026-10-06 句后浅键不垫底，与句子、彼此之间用「 · 」隔开
test("灰字后两颗句后浅键：隐私说明在前、在 GitHub 提在后，「 · 」隔开", () => {
  const html = render(ReportRow, {
    settings: { autoReport: true, available: true, feedback: true },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
  });
  const quiet =
    html.match(/<button[^>]*class="ss-btn ss-btn--quiet ss-btn--inline"[^>]*>[^<]*</g) ?? [];
  assert.equal(quiet.length, 2);
  assert.match(quiet[0], />隐私说明</);
  assert.match(quiet[1], />在 GitHub 提</);
  assert.match(
    html,
    /用于改进 Sophia 和排查问题 ·\u00a0(?:<span[^>]*>)?<button[^>]*>隐私说明<[^]*?<\/button>(?:<\/span>)? ·\u00a0(?:<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--quiet ss-btn--inline"[^>]*>在 GitHub 提</,
  );
  assert.doesNotMatch(html, /\u00a0\u00a0/);
  // 两颗浅键都在灰字那一行里（settings-page__note），不在右端的控件列
  const note =
    html.match(
      /<div class="settings-page__note">[^]*?<\/div><\/div><div class="settings-page__controls">/,
    )?.[0] ?? "";
  assert.equal((note.match(/ss-btn--quiet/g) ?? []).length, 2);
  assert.doesNotMatch(html.slice(html.indexOf("settings-page__controls")), /ss-btn--quiet/);
  assert.equal(ISSUES_URL, "https://github.com/zhengjiaqiao/sophia/issues/new/choose");
});

test("关着时开关画成关", () => {
  const html = render(ReportRow, {
    settings: { autoReport: false, available: true, feedback: true },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
  });
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
});

test("不能上报也没有接收服务、或还没读回来：整行不画", () => {
  for (const settings of [{ autoReport: true, available: false, feedback: false }, null]) {
    assert.equal(
      render(ReportRow, {
        settings,
        onChange: noop,
        onPrivacy: noop,
        onGithub: noop,
        onFeedback: noop,
      }),
      "",
    );
  }
});

// 应用内反馈（R13，画板「关于 · 使用统计」B）
test("有接收服务：右端一列开关之前一颗紧凑默认键 `反馈问题`；没有接收服务就没有这颗键", () => {
  const html = render(ReportRow, {
    settings: { autoReport: true, available: true, feedback: true },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
  });
  assert.match(
    html,
    /<div class="settings-page__controls">(?:<span[^>]*>)*<button[^>]*class="ss-btn ss-btn--compact"[^>]*>反馈问题<\/button>.*role="switch"/,
  );
  const none = render(ReportRow, {
    settings: { autoReport: true, available: true, feedback: false },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
  });
  assert.doesNotMatch(none, /反馈问题/);
});

test("DO_NOT_TRACK（不能上报）但有接收服务：这一行照画，只有 `反馈问题`、没有开关", () => {
  const html = render(ReportRow, {
    settings: { autoReport: true, available: false, feedback: true },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
  });
  assert.match(html, /使用统计和错误报告/);
  assert.match(html, />反馈问题<\/button>/);
  assert.doesNotMatch(html, /role="switch"/);
});

test("发出去之后的提示条挂在 `反馈问题` 键那一格里（FloatingToast 锚在它下面）", () => {
  const html = render(ReportRow, {
    settings: { autoReport: true, available: true, feedback: true },
    onChange: noop,
    onPrivacy: noop,
    onGithub: noop,
    onFeedback: noop,
    feedbackNote: "<<sent>>",
  });
  assert.match(
    html,
    /<span class="settings-page__check">(?:<span[^>]*>)*<button[^>]*>反馈问题<\/button>(?:<\/span>)*&lt;&lt;sent&gt;&gt;<\/span>/,
  );
});

test("隐私说明链到公开仓库里的 PRIVACY.md", () => {
  assert.equal(PRIVACY_URL, "https://github.com/zhengjiaqiao/sophia/blob/main/PRIVACY.md");
});

/// 网关并入 Sophia 之后的界面（spec 2026-10-03-gateway-in-app）：退出确认的文案选择、确认框的忙碌与单键、
/// 路由那一条待办的几种原因、换端口的灰字、设置页的开机启动一行
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { render } from "./ui-render.ts";
import { setLocale, t } from "../src/i18n.ts";
import {
  quitBusyText,
  quitConfirmText,
  quitFailureText,
  quitNeedsConfirm,
} from "../src/quitView.ts";
import { portMovedNote, routerTodo, showRouterTodo } from "../src/modelsView.ts";
import { gatewayFixture, CLAUDE_OFF } from "./gateway-fixture.ts";
import type { CodexFixture } from "./gateway-fixture.ts";
import type { GatewayState, QuitPreview } from "../src/types.ts";

const { Confirm } = await import("../src/ui/Confirm.tsx");

const noop = () => {};
const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const preview = (over: Partial<QuitPreview> = {}): QuitPreview => ({
  codex: false,
  codexAppRunning: false,
  codexTerminal: false,
  claude: false,
  claudeRunning: false,
  ...over,
});

const state = (overrides: Partial<CodexFixture> = {}): GatewayState =>
  gatewayFixture({
    supported: true,
    providers: [],
    enabled: false,
    needsCodexRestart: false,
    router: { running: false, port: 47328, error: "" },
    codex: { version: "26.0", running: true, catalogVersion: "1", drift: false, appName: "" },
    conflict: "",
    takeover: null,
    ...overrides,
  });

// ===== 退出确认（R5、R6、R9） =====

test("AC7 两家都没在用第三方模型：不确认，直接退出；有一家在用就确认", () => {
  assert.equal(quitNeedsConfirm(preview()), false);
  assert.equal(quitNeedsConfirm(preview({ codexTerminal: true, codexAppRunning: true })), false);
  assert.equal(quitNeedsConfirm(preview({ codex: true })), true);
  assert.equal(quitNeedsConfirm(preview({ claude: true })), true);
});

test("AC6 确认框文案四种：两家 / 只 Codex / 只 Claude；终端里有 Codex 时补一句（只在 Codex 要改回时）", () => {
  const both = quitConfirmText(preview({ codex: true, claude: true }));
  assert.equal(both.title, "退出 Sophia？");
  assert.equal(both.body, "Codex 和 Claude 会改回官方模型并马上重启，正在进行的对话会中断。");
  assert.equal(
    quitConfirmText(preview({ codex: true })).body,
    "Codex 会改回官方模型并马上重启，正在进行的对话会中断。",
  );
  assert.equal(
    quitConfirmText(preview({ claude: true })).body,
    "Claude 会改回官方模型并马上重启，正在进行的对话会中断。",
  );
  assert.equal(
    quitConfirmText(preview({ codex: true, codexTerminal: true })).body,
    "Codex 会改回官方模型并马上重启，正在进行的对话会中断。终端里的 Codex 也会中断，需要你自己重启。",
  );
  // Codex 不改回时，终端里那个与退出无关
  assert.equal(
    quitConfirmText(preview({ claude: true, codexTerminal: true })).body,
    "Claude 会改回官方模型并马上重启，正在进行的对话会中断。",
  );
  // 一律写 Codex，不写桌面应用的名字（2026-10-03 产品负责人）
  assert.match(
    quitConfirmText(preview({ codex: true, codexTerminal: true })).body,
    /^Codex 会改回官方模型.*终端里的 Codex/,
  );
  assert.equal(t("shell.quit.confirm"), "退出");
});

test("忙碌一句跟着 quit-progress 的 step 走", () => {
  assert.equal(quitBusyText("restartingCodex"), "正在重启 Codex");
  assert.equal(quitBusyText("restartingClaude"), "正在重启 Claude");
});

test("AC10 没做成的说明：Codex / Claude / 两家；都做成为 null", () => {
  const fail = (agent: "codex" | "claude") => ({ agent, code: "desktop_busy", message: "…" });
  assert.equal(quitFailureText([]), null);
  assert.deepEqual(quitFailureText([fail("codex")]), {
    title: "Codex 没能重启",
    body: "Codex 已改回官方模型，手动重启它就能用。",
  });
  assert.deepEqual(quitFailureText([fail("claude")]), {
    title: "Claude 没能改回官方模型",
    body: "Sophia 退出后 Claude 暂时用不了，重新打开 Sophia 就能恢复。",
  });
  assert.deepEqual(quitFailureText([fail("codex"), fail("claude")]), {
    title: "Codex 和 Claude 没能重启",
    body: "Codex 已改回官方模型，手动重启它就能用。Sophia 退出后 Claude 暂时用不了，重新打开 Sophia 就能恢复。",
  });
});

test("English 与繁體：退出写 Quit / 結束，句子之间 English 留空格", () => {
  try {
    setLocale("en");
    const text = quitConfirmText(preview({ codex: true, codexTerminal: true }));
    assert.equal(text.title, "Quit Sophia?");
    assert.match(
      text.body,
      /interrupted\. Codex in the terminal will be interrupted too\. You'll need to restart it yourself\.$/,
    );
    const both = quitFailureText(
      [
        { agent: "codex", code: "x", message: "" },
        { agent: "claude", code: "x", message: "" },
      ],
      "Codex",
    );
    assert.match(both!.body, /use it\. Claude/);
    setLocale("zh-Hant");
    assert.equal(t("shell.quit.confirm"), "結束");
  } finally {
    setLocale("zh-Hans");
  }
});

// ===== 确认框：忙碌与单键 =====

test("Confirm 忙碌：键区原位锁住（过了门槛换成刻度 + 一句），忙时没有取消的路", () => {
  const html = render(Confirm, {
    title: "退出 Sophia？",
    confirmLabel: "退出",
    onConfirm: noop,
    onCancel: noop,
    busy: "正在重启 Codex",
  });
  assert.match(html, /ss-confirm__foot"><span class="ss-locked" aria-busy="true">/);
  const idle = render(Confirm, {
    title: "退出 Sophia？",
    confirmLabel: "退出",
    onConfirm: noop,
    onCancel: noop,
  });
  assert.doesNotMatch(idle, /ss-locked/);
  assert.equal((idle.match(/<button/g) ?? []).length, 2);
});

test("Confirm 单键：不给 onCancel 就只有主动作一颗键", () => {
  const html = render(Confirm, {
    title: "Codex 没能重启",
    confirmLabel: "退出",
    onConfirm: noop,
  });
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(html, />取消</);
  assert.match(html, /ss-btn--primary/);
});

test("退出流程：菜单 ⌘Q 经 quit-requested 到主窗口（窗口正中），托盘用同一段流程的窄面板；托盘不再直接退出", () => {
  const app = src("App.tsx");
  assert.match(app, /listen\("quit-requested"/);
  assert.match(app, /useQuitFlow\(\)/);
  const tray = src("TrayPanel.tsx");
  assert.match(tray, /useQuitFlow\(true\)/);
  assert.doesNotMatch(tray, /trayQuit/);
  const flow = src("QuitFlow.tsx");
  assert.match(flow, /listen<\{ step: QuitStep \}>\("quit-progress"/);
  assert.match(flow, /api\.appExitNow\(\)/);
  assert.doesNotMatch(src("api.ts"), /tray_quit/);
  // 托盘里的确认是系统样式（2026-10-03 产品负责人）：不垫底块、顶上一条分隔线、主动作是系统强调色的默认键
  const trayCss = src("TrayPanel.css");
  for (const hook of [
    /--confirm-inline-bg:\s*transparent/,
    /--confirm-inline-rule:\s*block/,
    /--key-primary-bg:\s*var\(--sys-accent\)/,
    /--key-primary-ink:\s*var\(--sys-knob\)/,
  ]) {
    assert.match(trayCss, hook);
  }
});

// ===== 路由那一条待办与换端口的灰字（R4、R13） =====

test("AC5 另一个 Sophia 占着端口：不看开关也出待办（Codex 设置已改回、开关是关的），键是再试一次", () => {
  const s = state({ portNotice: { code: "another_sophia", port: 47328 }, wanted: true });
  assert.deepEqual(routerTodo(s, false, "原话"), {
    message: "另一个 Sophia 正在运行",
    reason: "退出它之后再试一次",
    label: "再试一次",
    busy: "正在重启路由",
  });
  assert.equal(showRouterTodo(s, false), true);
});

test("AC5a 端口都被占：说范围", () => {
  const todo = routerTodo(state({ portNotice: { code: "ports_busy" } }), true, null);
  assert.equal(todo?.message, "第三方模型用不了");
  assert.equal(todo?.reason, "本机 47328–47339 端口都被别的程序占用了");
});

test("路由没在跑（没有端口说明）：照旧自愈过一次才出，原因是自愈失败的原话；都好时没有", () => {
  const down = state({ enabled: true });
  assert.equal(routerTodo(down, false, null), null);
  assert.deepEqual(routerTodo(down, true, "原话"), {
    message: "路由没在跑，第三方模型用不了",
    reason: "原话",
    label: "重启路由",
    busy: "正在重启路由",
  });
  assert.equal(
    routerTodo(state({ enabled: true, router: { running: true, port: 1, error: "" } }), true, null),
    null,
  );
});

test("AC4 换了端口：等重启的那一家节里一行灰字，重启过了就不再说", () => {
  const moved = { code: "port_moved", from: 47328, to: 47329 } as const;
  const codexWaiting = state({ enabled: true, needsCodexRestart: true, portNotice: moved });
  assert.equal(
    portMovedNote(codexWaiting, "codex"),
    "原来的端口被别的程序占用了，已自动换一个，重启 Codex 后生效",
  );
  assert.equal(portMovedNote(state({ enabled: true, portNotice: moved }), "codex"), null);
  assert.equal(portMovedNote(state({ enabled: true, needsCodexRestart: true }), "codex"), null);
  const claudeWaiting = state({
    portNotice: moved,
    claude: {
      ...CLAUDE_OFF,
      enabled: true,
      claude: {
        ...CLAUDE_OFF.claude!,
        desktop: { ...CLAUDE_OFF.claude!.desktop, running: true, needsRestart: true },
      },
    },
  });
  assert.equal(
    portMovedNote(claudeWaiting, "claude"),
    "原来的端口被别的程序占用了，已自动换一个，重启 Claude 后生效",
  );
  assert.equal(portMovedNote(state({ portNotice: moved }), "claude"), null);
  for (const page of ["ModelsTab.tsx", "ClaudeModelsPage.tsx"]) {
    assert.match(src(page), /className="models-port-note"/, page);
  }
});

// ===== 设置页：启动 · 开机启动（R15、R16） =====

test("AC17 开机启动是「通用」一节的第三行（外观之后、`Skills 和 MCP` 一节之前）：读系统的、读回来之前不画开关、写不成读回原样", () => {
  const page = src("pages/SettingsPage.tsx");
  const row = page.indexOf('label={t("settings.startup.autostart")}');
  assert.ok(row > page.indexOf("<AppearanceRow "));
  assert.ok(row < page.indexOf('t("settings.skillsMcp.section")'));
  assert.ok(page.indexOf('t("settings.general.section")') < page.indexOf("<LanguageRow "));
  assert.doesNotMatch(page, /settings\.startup\.section/);
  assert.match(page, /api\.autostartGet\(\)/);
  assert.match(page, /autostart === null \? null : \(\s*<Switch/);
  // 写不成读回原样，再说「设置保存失败」（带「再试一次」，spec #239）
  assert.match(
    page,
    /setAutostart\(!next\);\s*saveFailed\(e, \(\) => void toggleAutostart\(next\)\)/,
  );
  // 设置行：名字与灰字在左、开关在右（2026-10-04 画板 B）
  assert.match(
    page,
    /<SettingRow\s+label=\{t\("settings\.startup\.autostart"\)\}\s+note=\{t\("settings\.startup\.autostartNote"\)\}\s*>\s*\{autostart === null/,
  );
  assert.equal(t("settings.general.section"), "通用");
  assert.equal(t("settings.startup.autostart"), "开机启动");
  assert.equal(
    t("settings.startup.autostartNote"),
    "登录后自动打开，只出现在菜单栏；不开的话，重启电脑后要先打开 Sophia，第三方模型才能用",
  );
});

test("AC19 文案里不再有后台服务、退出不受影响的说法", () => {
  for (const lang of ["zh-Hans", "zh-Hant", "en"]) {
    for (const block of ["models", "tray", "shell", "settings"]) {
      const text = readFileSync(
        new URL(`../locales/${lang}/${block}.json`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(
        text,
        /后台服务|背景服務|background service|退出应用也不受影响|結束應用程式也不受影響|doesn't affect it/i,
        `${lang}/${block}`,
      );
    }
  }
  assert.equal(
    t("tray.closeHint.message"),
    "要退出，点菜单栏图标里的「退出」。退出后第三方模型会停用。",
  );
});

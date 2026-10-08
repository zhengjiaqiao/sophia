/// Codex 接法按登录状态自动选（spec 2026-10-03-codex-hookup-auto R10、AC12）：
/// 改用独立服务商时，模型页 Codex 节里一行灰字说明接法与后果；借用内置时不说
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { setLocale } from "../src/i18n.ts";
import { modeNote, quotaNote } from "../src/modelsView.ts";
import { gatewayFixture } from "./gateway-fixture.ts";
import type { CodexFixture } from "./gateway-fixture.ts";
import type { GatewayState, UsageStatus, UsageView, UsageWindow } from "../src/types.ts";

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const catalog = (locale: string) =>
  JSON.parse(
    readFileSync(new URL(`../locales/${locale}/models.json`, import.meta.url), "utf8"),
  ) as Record<string, string>;

const state = (overrides: Partial<CodexFixture> = {}): GatewayState =>
  gatewayFixture({
    supported: true,
    providers: [],
    enabled: true,
    needsCodexRestart: false,
    router: { running: true, port: 47328, error: "" },
    codex: { version: "26.0", running: true, catalogVersion: "1", drift: false, appName: "" },
    conflict: "",
    takeover: null,
    ...overrides,
  });

test("AC12 没登录改用独立服务商：一行说明接法与后果", () => {
  setLocale("zh-Hans");
  assert.equal(
    modeNote(state({ mode: "provider", modeReason: "signedOut" })),
    "Codex 没有登录 OpenAI，已改用免登录的方式接入：官方模型暂时用不了；这期间的会话和登录后的会话分开保存，互相看不到",
  );
});

test("借用内置服务商、或开关关着：不说", () => {
  assert.equal(modeNote(state({ mode: "builtin", modeReason: "signedIn" })), null);
  assert.equal(modeNote(state()), null);
  assert.equal(
    modeNote(state({ enabled: false, mode: "provider", modeReason: "signedOut" })),
    null,
  );
  assert.equal(modeNote(state({ supported: false })), null);
});

test("三种语言都有这句，只有这一句（额度那句已删）", () => {
  for (const locale of ["zh-Hans", "zh-Hant", "en"]) {
    const keys = Object.keys(catalog(locale));
    assert.ok(keys.includes("models.note.modeSignedOut"), locale);
    assert.ok(!keys.includes("models.note.modeQuota"), locale);
  }
  setLocale("en");
  assert.match(modeNote(state({ mode: "provider", modeReason: "signedOut" })) ?? "", /OpenAI/);
  setLocale("zh-Hans");
});

test("说明与端口说明同一位置、同一种灰字：都是 Codex 那一行上的灰字（`listRow.note`）", () => {
  const agents = src("shell/agents.tsx");
  assert.match(agents, /modeNote\(s\.gateway\)/);
  assert.match(agents, /portMovedNote\(s\.gateway, "codex"\)/);
});

// ===== ChatGPT 额度用完的说明（spec 2026-10-06-prelaunch-five R13） =====

const window_ = (over: Partial<UsageWindow> = {}): UsageWindow => ({
  key: "weekly",
  label: "本周",
  usedPercent: 100,
  resetsAt: null,
  windowMinutes: null,
  severity: "critical",
  active: true,
  ...over,
});

const usage = (
  windows: UsageWindow[] | null,
  over: { status?: UsageStatus; menuBarEnabled?: boolean } = {},
): UsageView =>
  ({
    state: {
      agents: [
        {
          agent: "codex",
          status: over.status ?? { kind: "ok" },
          reading:
            windows === null
              ? null
              : { agent: "codex", source: "appServer", observedAt: 0, windows, plan: null },
          attemptedAt: null,
        },
      ],
    },
    settings: { menuBarEnabled: over.menuBarEnabled ?? true },
    signedIn: ["agent:codex"],
    items: [],
    menuBar: {},
  }) as unknown as UsageView;

test("额度用到 100 且借用内置：出说明", () => {
  setLocale("zh-Hans");
  const text =
    "ChatGPT 额度已用完，Codex 可能连第三方模型也用不了。要接着用：在 Codex 里退出登录，再关开一次上面的开关";
  assert.equal(quotaNote(state(), usage([window_()])), text);
  assert.equal(quotaNote(state(), usage([window_({ usedPercent: 120 })])), text);
});

test("不到 100、没有在用的窗口、没有读数、读取失败、没开菜单栏用量：不出", () => {
  assert.equal(quotaNote(state(), usage([window_({ usedPercent: 99 })])), null);
  assert.equal(quotaNote(state(), usage([window_({ active: false })])), null);
  assert.equal(quotaNote(state(), usage([])), null);
  assert.equal(quotaNote(state(), usage(null)), null);
  assert.equal(quotaNote(state(), null), null);
  assert.equal(quotaNote(state(), usage(null, { status: { kind: "failing", reason: "x" } })), null);
  assert.equal(quotaNote(state(), usage([window_()], { menuBarEnabled: false })), null);
});

test("读数里的窗口已过了重置时刻（读数是旧的）：不出；还没到重置时刻：出", () => {
  setLocale("zh-Hans");
  const now = 1_800_000_000;
  assert.equal(quotaNote(state(), usage([window_({ resetsAt: now - 1 })]), now), null);
  assert.equal(quotaNote(state(), usage([window_({ resetsAt: now })]), now), null);
  assert.notEqual(quotaNote(state(), usage([window_({ resetsAt: now + 60 })]), now), null);
});

test("免登录接法、开关关着、不支持：不出", () => {
  const full = usage([window_()]);
  assert.equal(quotaNote(state({ mode: "provider", modeReason: "signedOut" }), full), null);
  assert.equal(quotaNote(state({ enabled: false }), full), null);
  assert.equal(quotaNote(state({ supported: false }), full), null);
});

test("额度说明三种语言都有，位置同其他灰字", () => {
  for (const locale of ["zh-Hans", "zh-Hant", "en"]) {
    assert.ok(Object.keys(catalog(locale)).includes("models.note.quotaUsedUp"), locale);
  }
  assert.match(src("shell/agents.tsx"), /quotaNote\(s\.gateway, s\.usage\)/);
});

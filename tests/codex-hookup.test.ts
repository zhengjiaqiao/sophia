/// Codex 接法按登录状态自动选（spec 2026-10-03-codex-hookup-auto R10、AC12）：
/// 改用独立服务商时，模型页 Codex 节里一行灰字说明接法与后果；借用内置时不说
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { setLocale } from "../src/i18n.ts";
import { modeNote } from "../src/modelsView.ts";
import { gatewayFixture } from "./gateway-fixture.ts";
import type { CodexFixture } from "./gateway-fixture.ts";
import type { GatewayState } from "../src/types.ts";

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

test("说明与端口说明同一位置、同一种灰字", () => {
  const page = src("ModelsTab.tsx");
  assert.match(page, /modeNote\(state\)/);
  assert.match(page, /<p className="models-port-note">\{modeText\}<\/p>/);
});

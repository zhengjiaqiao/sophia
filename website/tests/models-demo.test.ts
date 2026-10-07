/// 模型区三步卡的纯逻辑（AC7）：选择 / 密钥 / 开关集合 → 步骤与结果句。不起浏览器。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEMO_PROVIDERS,
  fillKey,
  finalState,
  initialState,
  pickProvider,
  resultOf,
  resultText,
  stepOf,
  toggleAgent,
} from "../src/demos/models.ts";
import { SITE } from "../src/site.config.ts";

const ids = SITE.agents.map((a) => a.id);
const texts = {
  ok: "好了。",
  testing: `试了一次，能用。正在重启 [[agent]]…`,
  restarted: `[[agent]] 已重启，官方模型和新模型都在。`,
  off: "已改回官方模型。",
};
const names = (list: string[]) => list.map((id) => SITE.agents.find((a) => a.id === id)!.name);

test("初始：没选服务商、没密钥、开关全关，停在第 1 步，没有结果句", () => {
  const s = initialState();
  assert.equal(stepOf(s), 0);
  assert.deepEqual(resultOf(s, true), { kind: "none" });
});

test("选了服务商进第 2 步；贴上密钥进第 3 步；任一开关打开后算做完（第 4 步亮起）", () => {
  let s = pickProvider(initialState(), DEMO_PROVIDERS[0]);
  assert.equal(stepOf(s), 1);
  s = fillKey(s);
  assert.equal(stepOf(s), 2);
  s = toggleAgent(s, "claude", ids);
  assert.equal(stepOf(s), 3);
});

test("换服务商不会清掉已贴的密钥与开关", () => {
  let s = toggleAgent(fillKey(pickProvider(initialState(), DEMO_PROVIDERS[0])), "codex", ids);
  s = pickProvider(s, DEMO_PROVIDERS[2]);
  assert.equal(s.provider, DEMO_PROVIDERS[2]);
  assert.deepEqual(s.on, ["codex"]);
  assert.equal(s.key, true);
});

test("开关集合按名单顺序排，与点击先后无关；再点一次关掉", () => {
  let s = toggleAgent(initialState(), "claude", ids);
  s = toggleAgent(s, "codex", ids);
  assert.deepEqual(s.on, ["codex", "claude"]);
  s = toggleAgent(s, "codex", ids);
  assert.deepEqual(s.on, ["claude"]);
});

test("不在名单里的 agent 点不动（名单只来自 SITE.agents）", () => {
  assert.throws(() => toggleAgent(initialState(), "cursor", ids));
});

test("结果句：刚打开是「正在重启 …」，稳定后是「好了。… 已重启，…」", () => {
  const s = toggleAgent(toggleAgent(initialState(), "codex", ids), "claude", ids);
  const testing = resultOf(s, false);
  assert.deepEqual(testing, { kind: "testing", agents: ["codex", "claude"] });
  assert.deepEqual(resultText(testing, texts, names, "、"), { lead: "", rest: "试了一次，能用。正在重启 Codex、Claude…" });
  const done = resultOf(s, true);
  assert.deepEqual(resultText(done, texts, names, "、"), {
    lead: "好了。",
    rest: "Codex、Claude 已重启，官方模型和新模型都在。",
  });
});

test("全部关掉回「已改回官方模型。」，不管稳没稳定", () => {
  let s = toggleAgent(initialState(), "codex", ids);
  s = toggleAgent(s, "codex", ids);
  for (const settled of [true, false]) {
    const r = resultOf(s, settled);
    assert.deepEqual(r, { kind: "off" });
    assert.deepEqual(resultText(r, texts, names, "、"), { lead: "", rest: "已改回官方模型。" });
  }
});

test("没碰过开关时没有结果句", () => {
  assert.equal(resultOf(pickProvider(initialState(), "Kimi"), true).kind, "none");
});

test("关 JS 的静态终态：第一家服务商、密钥已填、名单里的 agent 全开、第 4 步", () => {
  const s = finalState(ids);
  assert.equal(s.provider, DEMO_PROVIDERS[0]);
  assert.equal(s.key, true);
  assert.deepEqual(s.on, ids);
  assert.equal(stepOf(s), 3);
  assert.equal(resultOf(s, true).kind, "done");
});

test("示例的 6 家服务商都能在应用的预设里找到（AC12）", () => {
  assert.equal(DEMO_PROVIDERS.length, 6);
  const presets: { id: string; name: string }[] = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../crates/core/data/provider-presets.json", import.meta.url)), "utf8"),
  ).providers;
  for (const p of DEMO_PROVIDERS)
    assert.ok(
      presets.some((x) => `${x.id} ${x.name}`.toLowerCase().includes(p.toLowerCase())),
      `预设里没有 ${p}`,
    );
});

import assert from "node:assert/strict";
import test from "node:test";
import { setLocale, t } from "../src/i18n.ts";
import {
  agentInstalled,
  blockedText,
  filterGroups,
  groupName,
  noProviders,
  pickButtonLabel,
  pickCounts,
  pickEmptyText,
  pickOptimistic,
  pickedTabCount,
  positionText,
  reorderOptimistic,
  thirdPartyCount,
  unpicksLast,
  dropIndex,
  moveBy,
  moveTo,
} from "../src/pickView.ts";
import type { AgentModels, PickGroup } from "../src/types.ts";
import { CLAUDE_OFF, NO_MODELS, gatewayFixture, picked } from "./gateway-fixture.ts";

// 模型页一层的纯逻辑（#259，画板第 1、1′、2 屏）：按钮上的字、第二行计数、浮层搜索与分组、置灰原因、空态、
// 勾选的乐观更新、默认选上之后的提示条

const group = (
  provider: string,
  name: string,
  ids: string[],
  blocked: PickGroup["blocked"] = null,
): PickGroup => ({
  provider,
  name,
  blocked,
  models: ids.map((id) => ({
    ref: { provider, model: id },
    displayName: id,
    contextWindow: null,
    picked: false,
  })),
});

test("行尾按钮：一个没选 `选模型`，否则 `已选 N 个模型`（官方模型也算）", () => {
  assert.equal(pickButtonLabel(NO_MODELS), "选模型");
  assert.equal(pickButtonLabel(picked("官方/gpt-6", "Kimi/k2")), "已选 2 个模型");
  assert.equal(pickButtonLabel(picked("Kimi/k2")), "已选 1 个模型");
});

test("第二行计数：按提供商、按「已选」里第一次出现的先后，官方算一组 `官方 2 · Kimi 2 · DeepSeek 1`；一个没选为 null", () => {
  const five = picked("Kimi/k2", "官方/gpt-6", "Kimi/kfc", "官方/mini", "DeepSeek/v4");
  assert.equal(pickCounts(five.picked), "Kimi 2 · 官方 2 · DeepSeek 1");
  assert.equal(pickCounts([]), null);
  assert.equal(thirdPartyCount(five), 3);
  assert.equal(thirdPartyCount(picked("官方/gpt-6")), 0);
});

test("浮层搜索：按显示名与 id、不分大小写；组里一个不剩的不列；空串时没有模型的组也不列（改不了的组照样列，只要有模型）", () => {
  const groups = [
    group("@official", "", ["gpt-6", "gpt-6-mini"]),
    group("kimi", "Kimi", ["kimi-k2.6", "kimi-for-coding"]),
    group("packy", "PackyCode", ["claude-opus-5"], "protocol"),
    group("empty", "空的", []),
  ];
  assert.deepEqual(
    filterGroups(groups, "").map((g) => g.provider),
    ["@official", "kimi", "packy"],
  );
  assert.deepEqual(
    filterGroups(groups, " KIMI ").map((g) => [g.provider, g.models.length]),
    [["kimi", 2]],
  );
  assert.deepEqual(
    filterGroups(groups, "opus").map((g) => g.provider),
    ["packy"],
  );
  assert.equal(groupName(groups[0]), "官方");
  assert.equal(groupName(groups[1]), "Kimi");
});

test("置灰组的原因：没登录 / 接第三方时官方用不了 / 它自己管 / 协议接不上，各一句、说的是这一行的名字", () => {
  assert.equal(blockedText("signedOut", "Codex"), "Codex 没登录 OpenAI，官方模型用不了");
  assert.equal(
    blockedText("officialUnavailable", "Claude Desktop"),
    "接第三方模型时用不了，关掉这一行的开关就回来",
  );
  assert.equal(blockedText("readOnly", "WorkBuddy"), "WorkBuddy 自己管，在这里改不了");
  assert.equal(blockedText("protocol", "WorkBuddy"), "WorkBuddy 用不了：这家的接口它接不上");
  // 名字以汉字收尾时不空格（走查 2026-10-08）
  assert.equal(
    blockedText("protocol", "Claude 桌面应用"),
    "Claude 桌面应用用不了：这家的接口它接不上",
  );
});

test("浮层空态：搜不到、「已选」空着各一句；一家提供商都没有另说（带添加键）", () => {
  const m: AgentModels = {
    picked: [],
    groups: [group("@official", "", ["gpt-6"])],
    providers: 0,
  };
  assert.equal(pickEmptyText(m, "all", ""), null);
  assert.equal(pickEmptyText(m, "all", "glm"), "没有找到「glm」，它可能还没在提供商那里启用");
  assert.equal(pickEmptyText(m, "picked", "glm"), "还没选模型，去「全部」里选几个");
  assert.equal(noProviders(m), true);
  assert.equal(noProviders({ ...m, providers: 1 }), false);
});

test("勾选先画：勾上追加到「已选」末尾、对应格打勾；取消拿掉；重复勾不重复加；取消最后一个第三方模型才算关掉", () => {
  const m: AgentModels = {
    picked: [{ ref: { provider: "kimi", model: "a" }, displayName: "a", providerName: "Kimi" }],
    groups: [group("kimi", "Kimi", ["a", "b"])],
    providers: 1,
  };
  const b = { provider: "kimi", model: "b" };
  const on = pickOptimistic(m, b, true, { displayName: "b", providerName: "Kimi" });
  assert.deepEqual(
    on.picked.map((p) => p.ref.model),
    ["a", "b"],
  );
  assert.equal(on.groups[0].models[1].picked, true);
  assert.equal(
    pickOptimistic(on, b, true, { displayName: "b", providerName: "Kimi" }).picked.length,
    2,
  );
  const off = pickOptimistic(on, b, false, { displayName: "b", providerName: "Kimi" });
  assert.deepEqual(
    off.picked.map((p) => p.ref.model),
    ["a"],
  );
  assert.equal(off.groups[0].models[1].picked, false);
  assert.equal(unpicksLast(on, b), false);
  assert.equal(unpicksLast(m, { provider: "kimi", model: "a" }), true);
  const withOfficial = picked("官方/gpt-6", "Kimi/a");
  assert.equal(
    unpicksLast(withOfficial, { provider: "kimi", model: "a" }),
    true,
    "只剩官方的也算关掉",
  );
  assert.equal(unpicksLast(withOfficial, { provider: "@official", model: "gpt-6" }), false);
});

// 评审 #18（#259）：英文的句子是正常的句子，不拿「; 」把两句拼起来
test("英文：浮层里的说明句不拿「; 」拼句", () => {
  try {
    setLocale("en");
    for (const key of [
      "models.pick.officialUnavailable",
      "models.pick.footClaude",
      "models.providers.namePresetHint",
    ] as const) {
      assert.doesNotMatch(t(key), /; /, key);
    }
  } finally {
    setLocale("zh-Hans");
  }
});

test("模型页列不列这一家：本机支持、且这个 agent 装了；还不知道为 null（不看设置）", () => {
  const g = gatewayFixture({
    supported: true,
    enabled: false,
    needsCodexRestart: false,
    router: { running: false, port: 47328, error: "" },
    codex: { version: "26.0", running: false, catalogVersion: "", drift: false },
    conflict: "",
    takeover: null,
    claude: CLAUDE_OFF,
  });
  assert.equal(agentInstalled(g, true, "codex"), true);
  assert.equal(agentInstalled(g, true, "claude"), false);
  assert.equal(agentInstalled(g, false, "codex"), false);
  assert.equal(agentInstalled(null, true, "codex"), null);
  assert.equal(agentInstalled(g, null, "codex"), null);
});

// ---- 排序（#265，画板第 2 屏）----

test("⌥↑ / ⌥↓：挪一格，返回新顺序与它的新位置；到头不动（null）", () => {
  assert.deepEqual(moveBy(["a", "b", "c"], 1, -1), { list: ["b", "a", "c"], index: 0 });
  assert.deepEqual(moveBy(["a", "b", "c"], 1, 1), { list: ["a", "c", "b"], index: 2 });
  assert.equal(moveBy(["a", "b", "c"], 0, -1), null);
  assert.equal(moveBy(["a", "b", "c"], 2, 1), null);
});

test("拖动：指针越过别的行的中线就排到它后面；松手时从原位置挪到那里", () => {
  // 四行，中线在 10 / 30 / 50 / 70；拖第一行
  const mids = [10, 30, 50, 70];
  assert.equal(dropIndex(mids, 0, 5), 0);
  assert.equal(dropIndex(mids, 0, 35), 1);
  assert.equal(dropIndex(mids, 0, 55), 2);
  assert.equal(dropIndex(mids, 0, 99), 3);
  // 拖最后一行往上
  assert.equal(dropIndex(mids, 3, 25), 1);
  assert.deepEqual(moveTo(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveTo(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(moveTo(["a", "b"], 1, 1), ["a", "b"]);
});

test("读屏报位置：「第 2 个，共 5 个」", () => {
  assert.equal(positionText(1, 5), "第 2 个，共 5 个");
});

test("排序先画：「已选」按给的顺序排，给的里没有的原地不动（同后端）", () => {
  const m = picked("官方/gpt-6", "Kimi/a", "Kimi/b", "DeepSeek/c");
  const kimi = (model: string) => ({ provider: "kimi", model });
  const next = reorderOptimistic(m, [{ provider: "deepseek", model: "c" }, kimi("a"), kimi("b")]);
  assert.deepEqual(
    next.picked.map((p) => p.ref.model),
    ["gpt-6", "c", "a", "b"],
  );
  assert.equal(next.groups, m.groups, "分组不动");
});

// 走查 2026-10-07 第 8 条：「加入」飞行中页签上的数只扣掉已经在「已选」里、还没落地的那几枚；
// 中途来了一份还没含它的旧状态时不再多扣一个（连拍里一度显示成 3）
test("飞行中的页签计数：只扣「已选」里正在飞的，旧状态里还没有它就不扣", () => {
  const before = picked("DeepSeek/flash", "DeepSeek/pro", "QA/fake-a", "QA/fake-c");
  const after = picked("DeepSeek/flash", "DeepSeek/pro", "QA/fake-a", "QA/fake-c", "QA/fake-b");
  const flying = [{ provider: "qa", model: "fake-b" }];
  assert.equal(pickedTabCount(after.picked, flying), 4, "飞着：先不加");
  assert.equal(pickedTabCount(before.picked, flying), 4, "旧状态里还没有它：照实 4，不是 3");
  assert.equal(pickedTabCount(after.picked, []), 5, "落地");
});

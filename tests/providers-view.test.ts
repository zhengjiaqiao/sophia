/// 全局模型提供商页的纯逻辑（#252，画板第 3 屏）：行上的一行字、加完的提示条、「启用模型」浮层顶上那一句、
/// 名称规则（默认名、同名）、删除与取消启用的确认、浮层的搜索
import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAdded, ProviderModelRow, ProviderPreset, ProviderRow } from "../src/types.ts";

const {
  addedLead,
  dialogRuleText,
  draftDirty,
  keyChecksNow,
  keyHintText,
  keyShapeText,
  previewKey,
  saveBlocked,
  saveErrorRepeats,
  toggleChosen,
  customNamePlaceholder,
  defaultNameFor,
  disableConfirm,
  enableHeadNote,
  filterProviderModels,
  nameTakenText,
  providerAgentsTip,
  providerSubline,
  removeConfirm,
  searchPlaceholder,
} = await import("../src/providersView.ts");

const model = (id: string, over: Partial<ProviderModelRow> = {}): ProviderModelRow => ({
  id,
  displayName: null,
  contextWindow: null,
  manual: false,
  enabledBy: null,
  agents: [],
  ...over,
});

const row = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: "kimi",
  name: "Kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  protocol: "chat",
  preset: "kimi",
  key: "set",
  keyProblem: null,
  models: [],
  enabled: 4,
  total: 98,
  defaultRule: "recommended",
  agents: ["codex", "claude", "workbuddy"],
  unreachable: null,
  unreachableDetail: null,
  keyInvalid: false,
  ...over,
});

const names: Record<string, string> = {
  codex: "Codex",
  claude: "Claude 桌面应用",
  workbuddy: "WorkBuddy",
};
const nameOf = (id: string) => names[id] ?? id;

test("行上第二行：地址 · 已启用 N / 总数（推荐）· 几个 agent；超过 20 个一个没开时说挑几个", () => {
  assert.equal(providerSubline(row()), "api.moonshot.cn/v1 · 已启用 4 / 98（推荐）· 3 个 agent");
  assert.equal(
    providerSubline(
      row({
        name: "我的中转",
        baseUrl: "https://relay.example.com/v1",
        enabled: 12,
        total: 12,
        defaultRule: "all",
        agents: ["codex", "workbuddy"],
      }),
    ),
    "relay.example.com/v1 · 已启用 12 / 12 · 2 个 agent",
  );
  assert.equal(
    providerSubline(
      row({
        baseUrl: "https://openrouter.ai/api/v1",
        enabled: 0,
        total: 456,
        defaultRule: "tooMany",
        agents: [],
      }),
    ),
    "openrouter.ai/api/v1 · 已启用 0 / 456 · 模型太多，挑几个常用的",
  );
  // 用户改过启用（不再是默认）：不写规则
  assert.equal(
    providerSubline(row({ defaultRule: null, agents: [] })),
    "api.moonshot.cn/v1 · 已启用 4 / 98",
  );
});

test("停在「N 个 agent」上：说是哪几个", () => {
  assert.equal(
    providerAgentsTip(row(), nameOf),
    "Codex、Claude 桌面应用、WorkBuddy 选了这一家的模型",
  );
  // 名单以汉字收尾时不空格
  assert.equal(
    providerAgentsTip(row({ agents: ["codex", "claude"] }), nameOf),
    "Codex、Claude 桌面应用选了这一家的模型",
  );
  assert.equal(providerAgentsTip(row({ agents: [] }), nameOf), null);
});

test("加完一家的提示条主句（画板第 9 屏 ⑥）：说启用了几个；一个没启用说加上了哪一家", () => {
  const added = (over: Partial<ProviderAdded>): ProviderAdded => ({
    id: "deepseek",
    name: "DeepSeek",
    rule: "recommended",
    enabled: 2,
    total: 6,
    ...over,
  });
  assert.equal(addedLead(added({})), "已启用 2 个模型");
  assert.equal(
    addedLead(added({ name: "OpenRouter", rule: "tooMany", enabled: 0 })),
    "已加上 OpenRouter",
  );
  assert.equal(addedLead(added({ name: "我的中转", enabled: 0 })), "已加上「我的中转」");
});

test("添加弹窗「启用的模型」下那一句：没改过照三种情况说，改过只说启用了几个", () => {
  assert.equal(
    dialogRuleText({ rule: "recommended", enabled: ["a", "b"] }, ["b", "a"]),
    "按推荐启用了 2 个",
  );
  assert.equal(dialogRuleText({ rule: "all", enabled: ["a", "b"] }, ["a", "b"]), "2 个都启用了");
  assert.equal(
    dialogRuleText({ rule: "tooMany", enabled: [] }, []),
    "模型太多，默认一个都没启用，挑几个常用的",
  );
  assert.equal(dialogRuleText({ rule: "recommended", enabled: ["a", "b"] }, ["a"]), "启用了 1 个");
  assert.equal(dialogRuleText({ rule: "tooMany", enabled: [] }, ["x", "y", "z"]), "启用了 3 个");
});

test("添加弹窗勾选：勾上追加、取消拿掉，同一个不重复", () => {
  assert.deepEqual(toggleChosen(["a"], "b", true), ["a", "b"]);
  assert.deepEqual(toggleChosen(["a", "b"], "a", false), ["b"]);
  assert.deepEqual(toggleChosen(["a"], "a", true), ["a"]);
});

test("添加弹窗什么时候拉列表：地址与密钥都填了才拉，按两者去首尾空白认", () => {
  assert.equal(previewKey(" https://api.deepseek.com ", ""), null);
  assert.equal(previewKey("", "sk-11111111"), null);
  assert.equal(
    previewKey(" https://api.deepseek.com ", " sk-11111111 "),
    previewKey("https://api.deepseek.com", "sk-11111111"),
  );
  assert.notEqual(previewKey("https://a", "sk-11111111"), previewKey("https://a", "sk-22222222"));
});

// 走查 2026-10-08：密钥不像密钥（含空白、太短）时不拉列表，密钥框下就地一句，保存禁用并说同一句
test("密钥的形状：含空白或不到 8 位不像密钥（同后端 keystore::validate_shape）；空着不说", () => {
  const said = "这看起来不是密钥（含空白字符或太短）。请确认复制的是密钥本身，而不是命令";
  assert.equal(keyShapeText(""), null);
  assert.equal(keyShapeText("   "), null);
  assert.equal(keyShapeText("sk-1234"), said);
  assert.equal(keyShapeText("export KEY=sk-12345678"), said);
  assert.equal(keyShapeText(" sk-12345678 "), null);
  assert.equal(previewKey("https://a", "sk-1234"), null);
  assert.equal(previewKey("https://a", "curl -H sk-12345678"), null);
});

// 产品负责人 2026-10-08：密钥框那一句不边打边报。粘贴（一次进来多个字符）当即判断；手打等离开密钥框、或停手 0.4 秒
test("密钥那一句什么时候判断：一次进来多个字符（粘贴、选中后粘贴替换）当即判断；逐个打、删字等一会儿", () => {
  assert.equal(keyChecksNow("", "export KEY=sk-1"), true);
  assert.equal(keyChecksNow("sk-aaaaaaaa", "sk-bbbbbbbb"), true, "选中整段后粘贴替换");
  assert.equal(keyChecksNow("sk-1", "sk-12"), false);
  assert.equal(keyChecksNow("", "s"), false);
  assert.equal(keyChecksNow("sk-123", "sk-12"), false, "删字");
  assert.equal(keyChecksNow("sk-123", ""), false);
});

test("密钥框下那一句只说判断过的那一份：还在打（判断的是旧的）不说；保存键的禁用照旧实时", () => {
  const said = "这看起来不是密钥（含空白字符或太短）。请确认复制的是密钥本身，而不是命令";
  assert.equal(keyHintText("sk-1234", "sk-123"), null);
  assert.equal(keyHintText("sk-1234", "sk-1234"), said);
  assert.equal(keyHintText("sk-12345678", "sk-12345678"), null);
  assert.equal(
    saveBlocked({ adding: true, baseUrl: "https://a", key: "sk-1234", taken: null }),
    said,
  );
});

test("弹窗里有没有没保存的改动：选了预设没动不算；填了密钥、改了名称或地址算；编辑时对照原值", () => {
  const preset = {
    id: "deepseek",
    name: "DeepSeek",
    website: "",
    region: "cn",
    openai: { apiBase: "https://api.deepseek.com" },
    anthropic: null,
  } as unknown as ProviderPreset;
  const draft = { name: "DeepSeek", baseUrl: "https://api.deepseek.com", key: "" };
  assert.equal(draftDirty(null, null, { name: "", baseUrl: "", key: "" }), false);
  assert.equal(draftDirty(null, preset, draft), false);
  assert.equal(draftDirty(null, preset, { ...draft, key: "sk" }), true);
  assert.equal(draftDirty(null, preset, { ...draft, name: "DS" }), true);
  assert.equal(draftDirty(null, "custom", { name: "", baseUrl: "", key: "" }), false);
  assert.equal(draftDirty(null, "custom", { name: "", baseUrl: "https://r", key: "" }), true);
  const editing = row();
  const same = { name: editing.name, baseUrl: editing.baseUrl, key: "" };
  assert.equal(draftDirty(editing, "custom", same), false);
  assert.equal(draftDirty(editing, "custom", { ...same, key: "sk-new" }), true);
  assert.equal(draftDirty(editing, "custom", { ...same, baseUrl: "https://x" }), true);
});

test("保存按不了的原因：先填地址；添加时先粘贴密钥；密钥不像密钥；同名", () => {
  assert.equal(saveBlocked({ adding: true, baseUrl: " ", key: "sk", taken: null }), "先填地址");
  const shape = "这看起来不是密钥（含空白字符或太短）。请确认复制的是密钥本身，而不是命令";
  assert.equal(saveBlocked({ adding: true, baseUrl: "https://a", key: "sk", taken: null }), shape);
  // 编辑时密钥留空＝不改，可以保存；填了就得像密钥
  assert.equal(saveBlocked({ adding: false, baseUrl: "https://a", key: "sk", taken: null }), shape);
  assert.equal(
    saveBlocked({ adding: true, baseUrl: "https://a", key: "sk-12345678", taken: null }),
    null,
  );
  assert.equal(
    saveBlocked({ adding: true, baseUrl: "https://a", key: "", taken: null }),
    "请先粘贴密钥",
  );
  assert.equal(saveBlocked({ adding: false, baseUrl: "https://a", key: "", taken: null }), null);
  assert.equal(
    saveBlocked({
      adding: true,
      baseUrl: "https://a",
      key: "sk-12345678",
      taken: "已经有一家叫 Kimi 了，换个名字",
    }),
    "已经有一家叫 Kimi 了，换个名字",
  );
});

test("「启用模型」浮层顶上那一句：写明默认用了哪条规则", () => {
  assert.equal(enableHeadNote(row()), "默认启用了 Kimi 推荐的 4 个。关掉的不会出现在任何 agent 里");
  assert.equal(
    enableHeadNote(row({ defaultRule: "all", enabled: 12, total: 12 })),
    "默认全部启用了（12 个）。关掉的不会出现在任何 agent 里",
  );
  assert.equal(
    enableHeadNote(row({ defaultRule: "tooMany", enabled: 0, total: 456 })),
    "模型太多，默认一个都没启用，先挑几个常用的",
  );
  assert.equal(enableHeadNote(row({ defaultRule: null })), "关掉的不会出现在任何 agent 里");
  assert.equal(searchPlaceholder(row()), "搜索 Kimi 的 98 个对话模型");
});

test("名称：自定义的不填取地址主体；同名不让保存", () => {
  assert.equal(defaultNameFor("https://relay.example.com/v1"), "relay");
  assert.equal(defaultNameFor("https://api.moonshot.cn/v1"), "moonshot");
  assert.equal(defaultNameFor("http://127.0.0.1:4000/v1"), "127.0.0.1");
  assert.equal(defaultNameFor("not a url"), null);
  assert.equal(
    customNamePlaceholder("https://relay.example.com/v1"),
    "比如：我的中转（不填就叫 relay）",
  );
  assert.equal(customNamePlaceholder(""), "比如：我的中转");
  const rows = [row(), row({ id: "relay", name: "我的中转" })];
  assert.equal(nameTakenText(rows, " kimi ", null), "已经有一家叫 Kimi 了，换个名字");
  assert.equal(nameTakenText(rows, "Kimi", "kimi"), null, "改自己的名字不算撞");
  assert.equal(nameTakenText(rows, "", null), null);
  // 名称空着时按默认名查
  assert.equal(
    nameTakenText([row({ id: "r", name: "relay" })], "", null, "https://relay.example.com/v1"),
    "已经有一家叫 relay 了，换个名字",
  );
});

test("删除确认：点名受影响的 agent，说清密钥一并删除且无法恢复", () => {
  assert.deepEqual(removeConfirm(row(), nameOf), {
    title: "删掉 Kimi？",
    body: "Codex、Claude 桌面应用、WorkBuddy 选了它的模型，删除后会从这几个 agent 中移除。它的密钥一并删除，无法恢复。",
  });
  assert.deepEqual(removeConfirm(row({ agents: [] }), nameOf), {
    title: "删掉 Kimi？",
    body: "它的密钥一并删除，无法恢复。",
  });
});

test("取消启用：有 agent 选了才确认，点名是哪几个", () => {
  assert.equal(disableConfirm(model("kimi-k2.6"), nameOf), null);
  assert.deepEqual(disableConfirm(model("kimi-k2.6", { agents: ["codex", "workbuddy"] }), nameOf), {
    title: "取消启用 kimi-k2.6？",
    body: "Codex、WorkBuddy 选了它，取消启用后会从这几个 agent 中移除。",
  });
});

test("浮层搜索：按 id 与显示名，不分大小写；空串全部", () => {
  const list = [
    model("kimi-k2.6"),
    model("moonshot-v1-8k", { displayName: "Moonshot 8K" }),
    model("kimi-for-coding"),
  ];
  assert.equal(filterProviderModels(list, "").length, 3);
  assert.deepEqual(
    filterProviderModels(list, "KIMI").map((m) => m.id),
    ["kimi-k2.6", "kimi-for-coding"],
  );
  assert.deepEqual(
    filterProviderModels(list, "moonshot 8").map((m) => m.id),
    ["moonshot-v1-8k"],
  );
});

// 走查 2026-10-08 第 13 张：拉不到列表的灰面板已经说了「模型提供商拒绝了这个密钥」，按保存又失败、原因一样，
// 下面不再出第二块说同一句——同一原因只说一处
test("保存失败的原因与上面「拉不到模型列表」说的一样：不再另出一块；原因不同、或列表拉到了，照常出", () => {
  const reason = "模型提供商拒绝了这个密钥（HTTP 401），请检查密钥是否正确";
  const failed = { status: "failed" as const, message: reason };
  assert.equal(saveErrorRepeats(failed, { message: reason }), true);
  assert.equal(saveErrorRepeats(failed, { message: "连不上 api.example.com" }), false);
  assert.equal(saveErrorRepeats({ status: "loading" as const }, { message: reason }), false);
  assert.equal(saveErrorRepeats(null, { message: reason }), false);
});

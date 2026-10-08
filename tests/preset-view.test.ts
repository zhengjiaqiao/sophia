/// 服务商预设的纯逻辑（spec S1）：筛选、分组、主机名、回车选第一家、取密钥链接
import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPreset } from "../src/types.ts";

const { filterPresets, firstPick, keysLink, presetHost, presetSupported } =
  await import("../src/presetView.ts");

const p = (over: Partial<ProviderPreset> & { id: string }): ProviderPreset => ({
  name: over.id,
  website: "https://example.com",
  region: "global",
  openai: { apiBase: `https://api.${over.id}.com/v1`, protocol: "chat" },
  anthropic: null,
  ...over,
});
const list = [
  p({
    id: "deepseek",
    name: "DeepSeek",
    region: "cn",
    keysUrl: "https://platform.deepseek.com/api_keys",
  }),
  p({
    id: "zhipu",
    name: "智谱 GLM",
    region: "cn",
    note: "Coding Plan",
    openai: { apiBase: "https://open.bigmodel.cn/api/v1", protocol: "responses" },
  }),
  p({
    id: "mimo",
    name: "Xiaomi MiMo",
    region: "cn",
    openai: null,
    anthropic: { apiBase: "https://api.mimo.com/anthropic" },
  }),
  p({ id: "openrouter", name: "OpenRouter" }),
];

test("主机名：去掉协议头与末尾斜杠；只有 Anthropic 地址的用那一个", () => {
  assert.equal(presetHost(list[1]), "open.bigmodel.cn/api/v1");
  assert.equal(presetHost(list[2]), "api.mimo.com/anthropic");
  assert.equal(presetSupported(list[2]), false);
  assert.equal(presetSupported(list[0]), true);
});

test("搜索：按名字、id、主机名、备注，不分大小写；空串全部", () => {
  assert.deepEqual(filterPresets(list, "").length, 4);
  assert.deepEqual(
    filterPresets(list, "deep").map((x) => x.id),
    ["deepseek"],
  );
  assert.deepEqual(
    filterPresets(list, "BIGMODEL").map((x) => x.id),
    ["zhipu"],
  );
  assert.deepEqual(
    filterPresets(list, "coding").map((x) => x.id),
    ["zhipu"],
  );
  assert.deepEqual(
    filterPresets(list, "智谱").map((x) => x.id),
    ["zhipu"],
  );
  assert.deepEqual(filterPresets(list, "nothing"), []);
});

test("回车选第一家能用的：只有 Anthropic 地址的跳过", () => {
  assert.equal(firstPick(filterPresets(list, "mimo")), null);
  assert.equal(firstPick(list)?.id, "deepseek");
});

test("取密钥链接：优先取密钥页，其次官网，都没有不出", () => {
  assert.equal(keysLink(list[0]), "https://platform.deepseek.com/api_keys");
  assert.equal(keysLink(list[3]), "https://example.com");
  assert.equal(keysLink(p({ id: "x", website: "" })), null);
});

test("走查第 7 条：「去 X 取密钥 ↗」是浅键（离开 Sophia，↗ 由组件画），不是带下划线的网页链接（D23）", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/ProviderDialog.tsx", import.meta.url), "utf8");
  assert.match(
    page,
    /<Button\s+variant="quiet"\s+onClick=\{\(\) => void openUrl\(keysUrl\)\}\s*>\s*\{t\("models\.preset\.keys", \{ name: preset\.name \}\)\}\s*<\/Button>/,
  );
  assert.doesNotMatch(page, /gw-preset__keys|<a\s/);
});

test("选好之后那一行写的名字：预设写预设名；自定义写「自定义地址」，不带省略号（不像没加载完）", async () => {
  const { pickedName } = await import("../src/presetView.ts");
  assert.equal(pickedName("custom"), "自定义地址");
  assert.equal(pickedName({ name: "DeepSeek" } as never), "DeepSeek");
});

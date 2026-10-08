/// 设置「skill 和 MCP 页显示的 agent」按品牌勾（#251，画板第 4 屏；src/brandsView.ts）
import assert from "node:assert/strict";
import test from "node:test";
import { setLocale, t } from "../src/i18n.ts";
import { brandIconId, brandProductsLine } from "../src/brandsView.ts";
import type { BrandStatus, HarnessStatus } from "../src/types.ts";

const product = (id: string, displayName: string, brand: string): HarnessStatus => ({
  id,
  displayName,
  brand,
  brandName: brand,
  enabled: true,
  installed: true,
  skills: true,
  mcp: true,
});
const PRODUCTS = [
  product("claude-code", "Claude Code", "claude"),
  product("claude-desktop", "Claude Desktop", "claude"),
  product("codex", "Codex", "codex"),
  product("kimi-cli", "Kimi Code", "kimi"),
  product("kimi-desktop", "Kimi Desktop", "kimi"),
];
const brand = (id: string, name: string, installedProducts: string[]): BrandStatus => ({
  id,
  name,
  enabled: true,
  installed: installedProducts.length > 0,
  installedProducts,
});

test("勾选行下的小字：列这个品牌已装的产品；只装了一个（或一个都没装）时不写", () => {
  const claude = brand("claude", "Claude", ["claude-code", "claude-desktop"]);
  assert.equal(brandProductsLine(claude, PRODUCTS), "Claude Code、Claude 桌面应用");
  const kimi = brand("kimi", "Kimi", ["kimi-cli", "kimi-desktop"]);
  assert.equal(brandProductsLine(kimi, PRODUCTS), "Kimi Code、Kimi 桌面版");
  assert.equal(brandProductsLine(brand("claude", "Claude", ["claude-desktop"]), PRODUCTS), null);
  assert.equal(brandProductsLine(brand("codex", "Codex", ["codex"]), PRODUCTS), null);
  assert.equal(brandProductsLine(brand("amp", "Amp", []), PRODUCTS), null);
  try {
    setLocale("zh-Hant");
    assert.equal(brandProductsLine(claude, PRODUCTS), "Claude Code、Claude 桌面應用");
    setLocale("en");
    assert.equal(brandProductsLine(claude, PRODUCTS), "Claude Code and Claude Desktop");
    assert.equal(brandProductsLine(kimi, PRODUCTS), "Kimi Code and Kimi Desktop");
  } finally {
    setLocale("zh-Hans");
  }
});

test("品牌的图标取它第一个产品的（Claude 用 Claude 的标志）；只装了后一个时取装了的那个", () => {
  assert.equal(brandIconId(brand("claude", "Claude", ["claude-code"]), PRODUCTS), "claude-code");
  assert.equal(
    brandIconId(brand("claude", "Claude", ["claude-desktop"]), PRODUCTS),
    "claude-desktop",
  );
  // 没装：取表里第一个产品；表里也没有（不该发生）就用品牌 id
  assert.equal(brandIconId(brand("kimi", "Kimi", []), PRODUCTS), "kimi-cli");
  assert.equal(brandIconId(brand("x", "X", []), PRODUCTS), "x");
});

test("这一栏改名，灰字说只管 skill、MCP 两页（画板第 4 屏）", () => {
  assert.equal(t("settings.agents.label"), "skill 和 MCP 页显示的 agent");
  assert.equal(
    t("settings.agents.note", { max: 4 }),
    "最多显示 4 个 · MCP 页只显示其中支持 MCP 的 · 模型页不受这里影响",
  );
});

/// 精选 MCP 按界面语言显示（#305）与发现页的第二层精确值（#307）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render } from "./ui-render.ts";
import { setLocale, type Lang } from "../src/i18n.ts";
import { fieldText, localText, mcpInstallBlock } from "../src/market/installView.ts";
import { mcpFieldFacts, repoOwner, skillOrigin } from "../src/market/discoverView.ts";
import type { McpCatalogEntry, McpFieldSpec } from "../src/types.ts";
import type { MarketService } from "../src/market/service.ts";

const { InstallPage } = await import("../src/market/InstallPage.tsx");
const { FieldsBlock } = await import("../src/market/InstallParts.tsx");

/// 随包的精选清单，与 core 读的是同一份
const curated: McpCatalogEntry[] = JSON.parse(
  readFileSync(new URL("../crates/core/data/market/mcp-curated.json", import.meta.url), "utf8"),
).servers;
const entry = (name: string) => curated.find((e) => e.name === name)!;

/// 在某种界面语言下跑一段，跑完换回简体（别的测试都按简体写）
function inLocale<T>(lang: Lang, run: () => T): T {
  setLocale(lang);
  try {
    return run();
  } finally {
    setLocale("zh-Hans");
  }
}

test("localText：按当前语言取；没写或是空的依次退回 简体 → English → 繁體；上游原文一种写法原样", () => {
  const all = { "zh-Hans": "简体", "zh-Hant": "繁體", en: "English" };
  assert.equal(localText(all, "zh-Hans"), "简体");
  assert.equal(localText(all, "zh-Hant"), "繁體");
  assert.equal(localText(all, "en"), "English");
  // 缺繁體、缺 English：退回简体（同文案目录的规矩）
  assert.equal(localText({ "zh-Hans": "简体", en: "English" }, "zh-Hant"), "简体");
  assert.equal(localText({ "zh-Hans": "简体", "zh-Hant": "繁體" }, "en"), "简体");
  // 连简体也没有：English，再没有才是繁體
  assert.equal(localText({ "zh-Hant": "繁體", en: "English" }, "zh-Hans"), "English");
  assert.equal(localText({ "zh-Hant": "繁體" }, "en"), "繁體");
  // 空白算没写
  assert.equal(localText({ "zh-Hans": "简体", en: "  " }, "en"), "简体");
  assert.equal(localText({}, "en"), "");
  assert.equal(localText(null), "");
  assert.equal(localText(undefined), "");
  // 官方目录的说明只有上游给的一种
  assert.equal(localText("Brave Search MCP Server", "zh-Hant"), "Brave Search MCP Server");
  // 不给语言时按当前界面语言
  assert.equal(
    inLocale("en", () => localText(all)),
    "English",
  );
});

test("要填的：精选的标签与框下一句按界面语言取；缺某种语言照 localText 回退；有标签时不看 description", () => {
  const field: McpFieldSpec = {
    key: "TOKEN",
    kind: "env",
    required: true,
    secret: true,
    description: "旧说明，不该出现",
    label: { "zh-Hans": "令牌", "zh-Hant": "權杖", en: "Token" },
    help: { "zh-Hans": "在设置里生成", en: "Generate one in settings" },
  };
  assert.deepEqual(fieldText(field, "zh-Hans"), {
    label: "令牌",
    help: "在设置里生成",
    keyed: false,
  });
  assert.deepEqual(fieldText(field, "en"), {
    label: "Token",
    help: "Generate one in settings",
    keyed: false,
  });
  // 框下一句没写繁體：退回简体
  assert.deepEqual(fieldText(field, "zh-Hant"), {
    label: "權杖",
    help: "在设置里生成",
    keyed: false,
  });
  // 没有框下一句
  assert.deepEqual(fieldText({ ...field, help: null }, "en"), {
    label: "Token",
    help: null,
    keyed: false,
  });
  // 标签哪种语言都没写：照旧看官方目录的说明，再没有退回键名
  assert.deepEqual(fieldText({ ...field, label: {}, description: "Your token" }, "en"), {
    label: "Your token",
    help: null,
    keyed: false,
  });
  assert.deepEqual(fieldText({ ...field, label: null, description: null }, "en"), {
    label: "TOKEN",
    help: null,
    keyed: true,
  });
});

test("随包精选：三种界面语言里名称、说明、标签、框下一句都是对应语言", () => {
  const github = entry("github");
  const token = github.fields[0];
  // 名称是服务器的名字（英文 id），三种语言一样
  assert.equal(github.name, "github");
  assert.equal(
    localText(github.description, "zh-Hans"),
    "GitHub 上的仓库、议题、拉取请求、Actions 与代码搜索",
  );
  assert.equal(
    localText(github.description, "zh-Hant"),
    "GitHub 上的儲存庫、議題、提取要求、Actions 與程式碼搜尋",
  );
  assert.equal(
    localText(github.description, "en"),
    "Repositories, issues, pull requests, Actions, and code search on GitHub",
  );
  assert.deepEqual(fieldText(token, "zh-Hans"), {
    label: "GitHub 访问令牌",
    help: "在 github.com/settings/personal-access-tokens 生成",
    keyed: false,
  });
  assert.deepEqual(fieldText(token, "zh-Hant"), {
    label: "GitHub 存取權杖",
    help: "在 github.com/settings/personal-access-tokens 產生",
    keyed: false,
  });
  assert.deepEqual(fieldText(token, "en"), {
    label: "GitHub access token",
    help: "Generate one at github.com/settings/personal-access-tokens",
    keyed: false,
  });

  // 每一条、每一项三种语言都写了，而且各不相同（没有把简体原样抄过去）
  for (const e of curated) {
    const texts = (["zh-Hans", "zh-Hant", "en"] as const).map((l) => localText(e.description, l));
    assert.equal(new Set(texts).size, 3, `${e.name} 的说明三种语言要各写一份`);
    for (const f of e.fields) {
      const labels = (["zh-Hans", "zh-Hant", "en"] as const).map((l) => fieldText(f, l).label);
      assert.ok(!labels.includes(f.key), `${e.name}：${f.key} 的标签不该退回键名`);
      assert.ok(new Set(labels).size >= 2, `${e.name}：${f.key} 的标签要有译文`);
    }
  }
});

test("English 界面：介绍页事实行与禁用原因用英文标签", () => {
  const github = entry("github");
  inLocale("en", () => {
    const facts = mcpFieldFacts(github);
    assert.ok(Array.isArray(facts));
    assert.equal(facts[0].label, "GitHub access token");
    assert.equal(
      mcpInstallBlock({
        names: ["github"],
        checked: ["codex"],
        checks: null,
        fields: github.fields,
        values: {},
      }),
      "Enter GitHub access token",
    );
  });
});

test("繁體界面：安装页「要填的」标签与框下一句是繁體", () => {
  const html = inLocale("zh-Hant", () =>
    render(FieldsBlock, {
      fields: entry("github").fields,
      values: {},
      onChange: () => undefined,
    }),
  );
  assert.match(html, /<span>GitHub 存取權杖<\/span>/);
  assert.match(html, /在 github\.com\/settings\/personal-access-tokens 產生/);
  assert.doesNotMatch(html, /访问令牌/);
});

// ── #307：来自 <作者>，精确值进悬停 ──

test("来自：第一层只写作者；第二层是完整 owner/repo 与仓库内路径", () => {
  assert.equal(repoOwner("anthropics/skills"), "anthropics");
  assert.equal(repoOwner("vercel-labs/agent-skills"), "vercel-labs");
  assert.equal(repoOwner("no-slash"), "no-slash");
  assert.deepEqual(skillOrigin("anthropics/skills", "skills/pdf"), {
    from: "来自 anthropics",
    exact: "anthropics/skills · skills/pdf",
  });
  // 还不知道路径（搜索结果）或在仓库根：只有仓库
  assert.deepEqual(skillOrigin("anthropics/skills", null), {
    from: "来自 anthropics",
    exact: "anthropics/skills",
  });
  assert.equal(
    inLocale("zh-Hant", () => skillOrigin("anthropics/skills", null).from),
    "來自 anthropics",
  );
  assert.equal(
    inLocale("en", () => skillOrigin("anthropics/skills", null).from),
    "From anthropics",
  );
});

test("安装页来历行：第一层 来自 anthropics，仓库与仓库内路径只在悬停里（等宽）", () => {
  const never = <T>() => new Promise<T>(() => {});
  const service: MarketService = {
    planSkillInstall: never,
    installSkill: never,
    resolveLink: never,
    planMcpInstall: never,
    installMcp: never,
    parseMcpJson: never,
    undoSkill: never,
    undoMcp: never,
    reveal: () => {},
    openUrl: () => {},
    readClipboard: async () => "",
  };
  const html = render(InstallPage, {
    mine: "all",
    places: { recent: [], sorted: [], sort: "recent", onSort: () => {} },
    agents: [],
    shown: [],
    onClose: () => {},
    service,
    skill: { name: "pdf", repo: "anthropics/skills", path: "skills/pdf", branch: "main" },
    onDone: () => {},
  });
  const origin = html.slice(
    html.indexOf('class="install-origin"'),
    html.indexOf("</p>", html.indexOf('class="install-origin"')),
  );
  assert.match(
    origin,
    /<span>来自 anthropics<\/span><span [^>]*role="tooltip"[^>]*><span class="ss-mono[^"]*">anthropics\/skills · skills\/pdf<\/span>/,
  );
  // 悬停之外不再有等宽的仓库与路径
  assert.doesNotMatch(origin, /install-origin__mono/);
});

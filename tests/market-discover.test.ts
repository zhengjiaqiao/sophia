/// `发现` 列表与介绍页的视图模型（spec 2026-09-27-skill-mcp-market R5 R5B R7 R16，AC5）
import assert from "node:assert/strict";
import test from "node:test";
import {
  errorText,
  fallbackText,
  formatInstalls,
  githubUrl,
  installedLine,
  installsText,
  isInstalled,
  leaveLabel,
  mcpConnection,
  mcpFieldFacts,
  mcpNeeds,
  mcpPackage,
  mcpSourceLabel,
  placeName,
  rateLimited,
  skillHeader,
  skillKey,
  skillQuery,
  sortSkills,
} from "../src/market/discoverView.ts";
import type { McpDefinitionInput, SkillRow } from "../src/types.ts";

const row = (name: string, installs: number, installedIn: string[] = []): SkillRow => ({
  name,
  repo: "anthropics/skills",
  path: `skills/${name}`,
  installs,
  skillId: null,
  installedIn,
});

test("装过的人：一万以下写整数，一万起写「万」并去掉 .0", () => {
  assert.equal(formatInstalls(0), "0");
  assert.equal(formatInstalls(812), "812");
  assert.equal(formatInstalls(9_999), "9999");
  assert.equal(formatInstalls(10_000), "1 万");
  assert.equal(formatInstalls(124_000), "12.4 万");
  assert.equal(formatInstalls(76_049), "7.6 万");
  assert.equal(formatInstalls(3_577_826), "357.8 万");
  assert.equal(formatInstalls(12_345_678), "1235 万");
  assert.equal(installsText(62_000), "6.2 万人装过");
  assert.equal(installsText(812), "812 人装过");
});

test("装过的人：非中文语言没有「万」，数字交给 Intl 的紧凑写法", () => {
  assert.equal(formatInstalls(0, "en"), "0");
  assert.equal(formatInstalls(812, "en"), "812");
  assert.equal(formatInstalls(124_000, "en"), "124K");
  assert.equal(formatInstalls(3_577_826, "en"), "3.6M");
  assert.equal(formatInstalls(Number.NaN, "en"), "0");
  // 句子仍走整句键（数字文本作参数、原数选单复数）；目录里现在只有简体，句子沿用其写法
  assert.match(installsText(62_000, "en"), /^62K /);
  assert.match(installsText(812, "en"), /^812 /);
  // 繁体同样按「万」进位（写法归目录）
  assert.equal(formatInstalls(124_000, "zh-Hant"), "12.4 万");
});

test("已安装：installedIn 非空才算装过（安装键换成状态）", () => {
  assert.equal(isInstalled(row("pdf", 1)), false);
  assert.equal(isInstalled(row("pdf", 1, ["global"])), true);
  assert.equal(isInstalled(row("pdf", 1, ["project:/Users/you/CardBox"])), true);
});

test("排序：装过的人从多到少，一样多时保持原来的先后，不改入参", () => {
  const items = [row("a", 5), row("b", 50), row("c", 5), row("d", 500)];
  const sorted = sortSkills(items);
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["d", "b", "a", "c"],
  );
  assert.deepEqual(
    items.map((r) => r.name),
    ["a", "b", "c", "d"],
  );
});

test("表头：没输入 `热门 N`，输入后 `搜索结果 N`（空白不算输入）", () => {
  assert.deepEqual(skillHeader("", 200), { label: "热门", count: 200 });
  assert.deepEqual(skillHeader("   ", 200), { label: "热门", count: 200 });
  assert.deepEqual(skillHeader("pdf", 7), { label: "搜索结果", count: 7 });
});

test("搜 skill 的词：不到 2 个字当没输入，列热门", () => {
  assert.equal(skillQuery(""), "");
  assert.equal(skillQuery(" p "), "");
  assert.equal(skillQuery("表"), "");
  assert.equal(skillQuery(" pdf "), "pdf");
  assert.equal(skillQuery("表格"), "表格");
  assert.deepEqual(skillHeader("p", 200), { label: "热门", count: 200 });
});

test("行的身份：同名不同仓库、不同路径是两条", () => {
  const a = row("pdf", 1);
  assert.equal(skillKey(a), skillKey({ ...a, installs: 99 }));
  assert.notEqual(skillKey(a), skillKey({ ...a, repo: "x/y" }));
  assert.notEqual(skillKey(a), skillKey({ ...a, path: null }));
});

test("灰面板：连不上时说上次的结果与多久前；没有缓存说随包列表；限流说固定句", () => {
  const now = new Date(2026, 8, 27, 18);
  const sixHoursAgo = now.getTime() / 1000 - 6 * 3600;
  assert.equal(
    fallbackText({ service: "skills.sh", cachedAt: sixHoursAgo, rateLimited: false }, now),
    "现在无法连接 skills.sh，显示的是上次的结果 · 6 小时前",
  );
  assert.equal(
    fallbackText({ service: "MCP 目录", cachedAt: sixHoursAgo, rateLimited: false }, now),
    "现在无法连接 MCP 目录，显示的是上次的结果 · 6 小时前",
  );
  assert.equal(
    fallbackText({ service: "skills.sh", cachedAt: null, rateLimited: false }, now),
    "现在无法连接 skills.sh，显示的是随包附带的列表",
  );
  assert.equal(
    fallbackText({ service: "GitHub", cachedAt: sixHoursAgo, rateLimited: true }, now),
    rateLimited(),
  );
  assert.equal(rateLimited(), "GitHub 暂时限流，稍后再试");
  assert.equal(
    fallbackText({ service: "skills.sh", cachedAt: sixHoursAgo, rateLimited: true }, now),
    "skills.sh 暂时限流，稍后再试",
  );
});

// spec 2026-10-04-local-diagnostics R10 / AC9：读不懂、读到一半断了、限流各说各的，不再一律「无法连接」
test("灰面板：后端给了原因就按原因说（读不懂 / 断了 / 超时接上缓存或随包；限流带等待时间）", () => {
  const now = new Date(2026, 8, 27, 18);
  const sixHoursAgo = now.getTime() / 1000 - 6 * 3600;
  assert.equal(
    fallbackText(
      {
        service: "skills.sh",
        cachedAt: sixHoursAgo,
        rateLimited: false,
        reason: "skills.sh 返回的内容读不懂",
        detail: "GET https://skills.sh/api/search?… → 200 OK",
      },
      now,
    ),
    "skills.sh 返回的内容读不懂，显示的是上次的结果 · 6 小时前",
  );
  assert.equal(
    fallbackText(
      { service: "skills.sh", cachedAt: null, rateLimited: false, reason: "从 skills.sh 读到一半断了" },
      now,
    ),
    "从 skills.sh 读到一半断了，显示的是随包附带的列表",
  );
  assert.equal(
    fallbackText(
      {
        service: "skills.sh",
        cachedAt: sixHoursAgo,
        rateLimited: true,
        reason: "skills.sh 限流了，约 1 分钟后再试",
      },
      now,
    ),
    "skills.sh 限流了，约 1 分钟后再试",
  );
  // 只是连不上：照旧
  assert.equal(
    fallbackText({ service: "skills.sh", cachedAt: null, rateLimited: false, reason: null }, now),
    "现在无法连接 skills.sh，显示的是随包附带的列表",
  );
});

test("命令的错：中文句原样，其余换成兜底句", () => {
  assert.equal(errorText("GitHub 暂时限流，稍后再试", "x"), rateLimited());
  assert.equal(errorText(new Error("网络不通"), "x"), "网络不通");
  assert.equal(errorText("TypeError: fetch failed", "现在取不到"), "现在取不到");
  assert.equal(errorText(undefined, "现在取不到"), "现在取不到");
});

test("装在哪：用户级排前，项目写文件夹名，重名只写一次", () => {
  assert.equal(placeName("global"), "用户级");
  assert.equal(placeName("project:/Users/you/Projects/CardBox"), "CardBox");
  assert.equal(placeName("project:C:\\code\\WeiboAP\\"), "WeiboAP");
  assert.equal(installedLine([]), null);
  assert.equal(installedLine(["project:/Users/you/CardBox", "global"]), "装在 用户级、CardBox");
  assert.equal(installedLine(["global", "global"]), "装在 用户级");
});

const npx: McpDefinitionInput = {
  name: "playwright",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@playwright/mcp@latest"],
};
const remote: McpDefinitionInput = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
};

test("MCP 要填什么：要登录优先，其次有密钥，都不是就没有", () => {
  const secret = {
    key: "GITHUB_TOKEN",
    kind: "header" as const,
    required: true,
    secret: true,
  };
  const plain = { key: "ROOT", kind: "env" as const, required: true, secret: false };
  assert.equal(mcpNeeds({ fields: [secret], signIn: false }), "需要 API key");
  assert.equal(mcpNeeds({ fields: [], signIn: true }), "需要登录");
  assert.equal(mcpNeeds({ fields: [secret], signIn: true }), "需要登录");
  assert.equal(mcpNeeds({ fields: [plain], signIn: false }), null);
  assert.equal(mcpNeeds({ fields: [], signIn: false }), null);
});

test("MCP 连接方式与包名：本机命令写命令，远程写地址", () => {
  assert.deepEqual(mcpConnection(npx), {
    kind: "本机命令",
    text: "npx -y @playwright/mcp@latest",
  });
  assert.deepEqual(mcpConnection(remote), {
    kind: "远程",
    text: "https://api.githubcopilot.com/mcp/",
  });
  assert.equal(mcpPackage(npx), "@playwright/mcp@latest");
  assert.equal(mcpPackage(remote), "https://api.githubcopilot.com/mcp/");
  assert.equal(
    mcpPackage({ name: "t", transport: "stdio", command: "uvx", args: ["mcp-server-time"] }),
    "mcp-server-time",
  );
  assert.equal(
    mcpPackage({
      name: "g",
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "ghcr.io/github/github-mcp-server"],
    }),
    "ghcr.io/github/github-mcp-server",
  );
  assert.equal(
    mcpPackage({ name: "x", transport: "stdio", command: "/usr/local/bin/my-mcp", args: ["--x"] }),
    "/usr/local/bin/my-mcp --x",
  );
});

test("MCP 要填的：键名 + 必填 · 密钥；没有时说不用填（要登录时补一句）", () => {
  assert.deepEqual(
    mcpFieldFacts({
      fields: [
        { key: "GITHUB_TOKEN", kind: "header", required: true, secret: true },
        { key: "REGION", kind: "env", required: false, secret: false },
      ],
      signIn: false,
    }),
    [
      { key: "GITHUB_TOKEN", note: "必填 · 密钥" },
      { key: "REGION", note: "选填" },
    ],
  );
  assert.equal(mcpFieldFacts({ fields: [], signIn: false }), "不用填");
  assert.equal(mcpFieldFacts({ fields: [], signIn: true }), "不用填 · 首次使用时在浏览器里登录");
  assert.equal(mcpSourceLabel("registry"), "官方目录");
  assert.equal(mcpSourceLabel("curated"), "精选");
});

test("离开键：GitHub / npm / 其他三种说法；仓库地址指到文件夹", () => {
  assert.equal(leaveLabel("https://github.com/microsoft/playwright-mcp"), "在 GitHub 打开");
  assert.equal(leaveLabel("https://www.npmjs.com/package/@playwright/mcp"), "npm 上的说明");
  assert.equal(leaveLabel("https://docs.devin.ai/x"), "打开说明页");
  assert.equal(leaveLabel("not a url"), "打开说明页");
  assert.equal(githubUrl("anthropics/skills", null), "https://github.com/anthropics/skills");
  assert.equal(
    githubUrl("anthropics/skills", "skills/pdf"),
    "https://github.com/anthropics/skills/tree/HEAD/skills/pdf",
  );
  assert.equal(
    githubUrl("anthropics/skills", "/skills/pdf", "main"),
    "https://github.com/anthropics/skills/tree/main/skills/pdf",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import type { MarketService } from "../src/market/service.ts";

const { InstallPage } = await import("../src/market/InstallPage.tsx");
const { McpInstallPage } = await import("../src/market/McpInstallPage.tsx");
const { LinkPage } = await import("../src/market/LinkPage.tsx");
const { JsonPage } = await import("../src/market/JsonPage.tsx");

/// 静态渲染只画第一帧：计划、解析这些要等 effect 的都还没回来
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

const places = {
  recent: [
    {
      key: "project:/Users/you/Project/CardBox",
      label: "CardBox",
      path: "/Users/you/Project/CardBox",
    },
  ],
  sorted: [
    {
      key: "project:/Users/you/Project/CardBox",
      label: "CardBox",
      path: "/Users/you/Project/CardBox",
    },
  ],
  sort: "recent" as const,
  onSort: () => {},
};
const agents = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cline", name: "Cline" },
  { id: "claude-desktop", name: "Claude Desktop" },
];
const base = {
  mine: "all" as const,
  places,
  agents,
  shown: ["claude-code", "codex"],
  onClose: () => {},
  service,
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("安装 skill（画板 06）：来历、生效范围（没有 全部）、落点行、给谁用、贴底 取消 + 安装", () => {
  const html = render(InstallPage, {
    ...base,
    skill: {
      name: "pdf",
      repo: "anthropics/skills",
      path: "skills/pdf",
      branch: "main",
      description: "读、写、合并、拆分 PDF，填表单、抽表格。",
    },
    onDone: () => {},
  });
  const t = text(html);
  assert.match(t, /安装 pdf/);
  assert.match(t, /anthropics\/skills/);
  assert.match(t, /skills\/pdf/);
  assert.match(t, /在 GitHub 打开/);
  assert.match(t, /读、写、合并、拆分 PDF/);
  assert.match(t, /生效范围/);
  assert.match(t, /用户级/);
  assert.doesNotMatch(t, /全部/);
  assert.match(t, /装到 ~?\S*\.agents\/skills\/pdf · 多数 agent 直接读这里/);
  assert.match(t, /给谁用/);
  // 名单里的勾上，其余不勾；skill 不列 Claude Desktop
  assert.match(html, /aria-checked="true"[^>]*aria-label="Claude Code"/);
  assert.match(html, /aria-checked="false"[^>]*aria-label="Cline"/);
  assert.doesNotMatch(t, /Claude Desktop/);
  // 贴底：下载去向 + 取消 + 墨键安装（推入页根上带 data-footer）
  assert.match(t, /从 codeload\.github\.com 下载 · main/);
  assert.match(t, /取消/);
  assert.match(html, /data-footer/);
});

test("安装 MCP（画板 09）：连接方式、写进哪些 agent（Desktop 跟着 Claude Code）、要填的（密钥遮住、能看一眼）", () => {
  const html = render(McpInstallPage, {
    ...base,
    entry: {
      name: "brave-search",
      publisher: "Brave",
      description: "网页与新闻搜索",
      source: "curated",
      homepage: null,
      definition: {
        name: "brave-search",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
      },
      fields: [{ key: "BRAVE_API_KEY", kind: "env", required: true, secret: true }],
    },
    onDone: () => {},
  });
  const t = text(html);
  assert.match(t, /安装 brave-search/);
  assert.match(t, /Brave · @modelcontextprotocol\/server-brave-search/);
  assert.match(t, /npm 上的说明/);
  assert.match(t, /本机命令 · npx -y @modelcontextprotocol\/server-brave-search/);
  assert.match(t, /写进哪些 agent/);
  assert.match(html, /aria-checked="true"[^>]*aria-label="Claude Desktop"/);
  // Cline 不能写 MCP：不列
  assert.doesNotMatch(t, /Cline/);
  assert.match(t, /要填的/);
  assert.match(t, /BRAVE_API_KEY/);
  assert.match(t, /必填 · 密钥/);
  assert.match(html, /type="password"/);
  assert.match(html, /aria-label="显示"/);
  assert.match(t, /只写进勾选的 agent 的配置文件，Sophia 自己不存/);
  assert.match(t, /写进 \d 个配置文件/);
  // 必填的空着：安装不可点、带原因
  assert.match(html, /disabled=""[^>]*>安装|role="tooltip"[^>]*>先填 BRAVE_API_KEY</);
});

test("从链接安装（画板 07）：认不出的链接当即说明，不发请求；安装不可点", () => {
  let asked = 0;
  const html = render(LinkPage, {
    ...base,
    service: { ...service, resolveLink: () => ((asked += 1), never()) },
    initial: "https://example.com",
    onDone: () => {},
  });
  const t = text(html);
  assert.match(t, /从链接安装/);
  assert.match(t, /只认 GitHub 上的仓库或文件夹链接/);
  assert.match(html, /value="https:\/\/example.com"/);
  assert.match(html, /role="tooltip"[^>]*>先贴一个 GitHub 上的仓库或文件夹链接</);
  assert.equal(asked, 0);
});

test("从 JSON 添加（画板 10）：等宽框填着剪贴板来的内容；还没认出时不出列表，主动作不可点", () => {
  const html = render(JsonPage, {
    ...base,
    initial: '{ "mcpServers": {} }',
    onDone: () => {},
  });
  const t = text(html);
  assert.match(t, /从 JSON 添加/);
  assert.match(html, /<textarea[^>]*aria-label="MCP 配置"/);
  assert.match(t, /写进 0 个配置文件/);
  assert.match(t, /添加 0 个/);
  assert.doesNotMatch(t, /写进哪些 agent/);
});

test("安装到项目：勾了 Claude Code 时名字后两颗单选片 仅自己 / 团队共享 + 一句差别；用户级不出（spec 2026-09-30 R8）", async () => {
  const { AgentChecks } = await import("../src/market/InstallParts.tsx");
  const rows = [
    { id: "claude-code", name: "Claude Code" },
    { id: "codex", name: "Codex" },
  ];
  const base = { rows, onToggle: () => undefined, viewOf: () => ({}) };
  const scope = { value: "self" as const, onChange: () => undefined, place: "CardBox" };
  const html = render(AgentChecks, {
    ...base,
    checked: ["claude-code", "codex"],
    claudeScope: scope,
  });
  assert.match(html, /aria-label="Claude Code 写到哪一格"/);
  assert.match(html, /aria-pressed="true"[^>]*><span class="ss-chip__label">仅自己</);
  assert.match(html, /aria-pressed="false"[^>]*><span class="ss-chip__label">团队共享</);
  assert.match(
    html,
    /仅自己：只在 CardBox、只给你，不改仓库里的文件 · 团队共享：写进 CardBox 的 \.mcp\.json，提交后队友也有/,
  );
  // 单选片不在勾选行那颗键里面（键里不能嵌键）
  assert.doesNotMatch(html, /role="checkbox"[^>]*>(?:(?!<\/button>)[^])*ss-chip/);
  // 没勾 Claude Code、或位置是用户级（不给 claudeScope）：不出
  assert.doesNotMatch(
    render(AgentChecks, { ...base, checked: ["codex"], claudeScope: scope }),
    /写到哪一格/,
  );
  assert.doesNotMatch(render(AgentChecks, { ...base, checked: ["claude-code"] }), /写到哪一格/);
});

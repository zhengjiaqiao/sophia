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

test("安装 skill（画板 06；#275）：来历、生效范围（没有 全部）、结果一句 + 落点路径、给谁用、贴底 取消 + 安装", () => {
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
  // 结果一句（13 墨）+ 落点路径（等宽灰字，常显）
  assert.match(
    html,
    /<p class="install-landing__result">所有项目都能用<\/p><p class="install-landing__path"><span class="ss-mono ss-selectable">\S*\.agents\/skills\/pdf<\/span><\/p>/,
  );
  assert.match(t, /给谁用/);
  // 名单里的勾上，其余不勾；skill 不列 Claude Desktop
  assert.match(html, /aria-checked="true"[^>]*aria-label="Claude Code"/);
  assert.match(html, /aria-checked="false"[^>]*aria-label="Cline"/);
  assert.doesNotMatch(t, /Claude Desktop/);
  // 贴底：下载去向 + 取消 + 墨键安装（推入页根上带 data-footer）；主机名与分支只在悬停里
  assert.match(t, /从 GitHub 下载/);
  assert.match(html, /role="tooltip"[^>]*>(?:(?!<\/span><\/span>)[^])*codeload\.github\.com/);
  assert.match(t, /codeload\.github\.com · 分支 main/);
  // 贴底那一句本身只有「从 GitHub 下载」（大小要等计划回来）
  assert.match(html, /<span class="install-foot__line">从 GitHub 下载<\/span>/);
  assert.match(t, /取消/);
  assert.match(html, /data-footer/);
});

test("安装 MCP（画板 09；#276）：运行方式、给谁用（Desktop 跟着 Claude Code）、要填的（密钥遮住、能看一眼）", () => {
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
  // 来历：发布方 · 查看说明；包名只在它的悬停里
  assert.match(t, /Brave · 查看说明/);
  assert.match(
    html,
    /role="tooltip"[^>]*><span class="ss-mono[^"]*">@modelcontextprotocol\/server-brave-search</,
  );
  // 运行方式：本地运行，命令只在悬停里
  assert.match(html, /<p class="install-lede">(?:(?!<\/p>)[^])*本地运行/);
  assert.match(
    html,
    /role="tooltip"[^>]*><span class="ss-mono[^"]*">npx -y @modelcontextprotocol\/server-brave-search</,
  );
  assert.doesNotMatch(t, /本机命令|npm 上的说明|写进/);
  assert.match(t, /给谁用/);
  assert.match(html, /aria-checked="true"[^>]*aria-label="Claude Desktop"/);
  // Cline 不能写 MCP：不列
  assert.doesNotMatch(t, /Cline/);
  assert.match(t, /要填的/);
  assert.match(t, /BRAVE_API_KEY/);
  assert.match(t, /必填 · 密钥/);
  assert.match(html, /type="password"/);
  assert.match(html, /aria-label="显示"/);
  assert.match(t, /密钥只保存在所选 agent 中，Sophia 不保留/);
  // 必填的空着：安装不可点、带原因（没有说明：退回键名）
  assert.match(html, /role="tooltip"[^>]*>请填写 BRAVE_API_KEY</);
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
  assert.match(t, /添加 0 个/);
  assert.doesNotMatch(t, /写进/);
  assert.doesNotMatch(t, /给谁用/);
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
    /仅自己：只在 CardBox、只给你，不改仓库里的文件 · 团队共享：加到 CardBox 的 \.mcp\.json，提交后队友也有/,
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

test("安装 skill 到项目（#275）：结果一句写 只在 <项目> 中能用，路径是项目里的 .agents", () => {
  const html = render(InstallPage, {
    ...base,
    mine: "project:/Users/you/Project/CardBox",
    skill: { name: "pdf", repo: "anthropics/skills", path: "skills/pdf", branch: "main" },
    onDone: () => {},
  });
  assert.match(html, /<p class="install-landing__result">只在 CardBox 中能用<\/p>/);
  assert.match(html, /\/Project\/CardBox\/\.agents\/skills\/pdf<\/span><\/p>/);
});

test("给谁用（skill，#275）：直接读取的一组说 无需选择，勾选区小标 同时加到，不说 链接给", async () => {
  const { SkillAgents } = await import("../src/market/InstallParts.tsx");
  const html = render(SkillAgents, {
    rows: [
      { id: "claude-code", name: "Claude Code" },
      { id: "codex", name: "Codex" },
    ],
    direct: ["codex"],
    checked: ["claude-code"],
    onToggle: () => undefined,
  });
  const t = text(html);
  assert.match(t, /这些 agent 直接读取这个文件夹，无需选择 Codex/);
  assert.match(t, /同时加到 Claude Code/);
  assert.doesNotMatch(t, /链接给|不用选/);
});

test("要填的（#276）：说明当标签、键名降成等宽小字、说明后半句常显在框下（不放占位）；没有说明退回键名", async () => {
  const { FieldsBlock } = await import("../src/market/InstallParts.tsx");
  const html = render(FieldsBlock, {
    fields: [
      {
        key: "GITHUB_TOKEN",
        kind: "header",
        required: true,
        secret: true,
        description: "GitHub 访问令牌，在 github.com/settings/personal-access-tokens 生成",
      },
      { key: "ALLOWED_DIR", kind: "arg", required: false, secret: false },
    ],
    values: {},
    onChange: () => undefined,
  });
  // 标签是说明；键名在标签下那一行，等宽小字（不随标签的字号颜色）
  assert.match(
    html,
    /<label class="install-field__label"[^>]*><span>GitHub 访问令牌<\/span><span class="install-field__meta"><span class="ss-tag ss-tag--weak">必填 · 密钥<\/span><span class="ss-mono ss-selectable">GITHUB_TOKEN<\/span><\/span><\/label>/,
  );
  assert.match(
    html,
    /<p class="install-field__help">在 github\.com\/settings\/personal-access-tokens 生成<\/p>/,
  );
  assert.doesNotMatch(html, /placeholder=/);
  // 没有说明：标签就是键名（等宽），不再另写一遍
  assert.match(
    html,
    /<label class="install-field__label"[^>]*><span class="ss-mono ss-selectable ss-mono--inherit">ALLOWED_DIR<\/span><span class="install-field__meta"><span class="ss-tag ss-tag--weak">选填<\/span><\/span><\/label>/,
  );
  assert.match(text(html), /密钥只保存在所选 agent 中，Sophia 不保留/);
});

test("给谁用（MCP，#276）：能勾的行悬停 写入 <配置文件>；不能勾的行只说原因", async () => {
  const { AgentChecks } = await import("../src/market/InstallParts.tsx");
  const html = render(AgentChecks, {
    rows: [
      { id: "claude-code", name: "Claude Code" },
      { id: "codex", name: "Codex" },
    ],
    checked: ["claude-code", "codex"],
    onToggle: () => undefined,
    viewOf: (id: string) =>
      id === "codex"
        ? { path: "~/.codex/config.toml" }
        : { disabledReason: "Claude Code 里已经有一个不一样的 github", note: "x" },
  });
  assert.match(
    html,
    /role="tooltip"[^>]*>写入 <span class="ss-mono ss-selectable ss-mono--inherit">~\/\.codex\/config\.toml<\/span>/,
  );
  assert.doesNotMatch(html, /写入 [^<]*Claude/);
  assert.match(html, /role="tooltip"[^>]*>Claude Code 里已经有一个不一样的 github</);
});

test("安装 MCP（#276）：要填的有说明时，禁用原因与标签都用说明，界面上不拿键名当标签", () => {
  const html = render(McpInstallPage, {
    ...base,
    entry: {
      name: "github",
      publisher: "GitHub",
      description: "GitHub 上的仓库",
      source: "curated",
      homepage: "https://github.com/github/github-mcp-server",
      signIn: false,
      definition: {
        name: "github",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
      fields: [
        {
          key: "GITHUB_TOKEN",
          kind: "header",
          required: true,
          secret: true,
          description: "GitHub 访问令牌，在 github.com/settings/personal-access-tokens 生成",
        },
      ],
    },
    onDone: () => {},
  });
  const t = text(html);
  assert.match(t, /GitHub · 查看说明/);
  assert.match(html, /<p class="install-lede">(?:(?!<\/p>)[^])*在线服务/);
  assert.match(
    html,
    /role="tooltip"[^>]*><span class="ss-mono[^"]*">https:\/\/api\.githubcopilot\.com\/mcp\/</,
  );
  assert.match(html, /role="tooltip"[^>]*>请填写 GitHub 访问令牌</);
  assert.doesNotMatch(html, /<label class="install-field__label"[^>]*><span class="ss-mono/);
  assert.doesNotMatch(t, /需要 API key|写进/);
});

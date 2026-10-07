import assert from "node:assert/strict";
import test from "node:test";
import { t as say } from "../src/i18n.ts";
import { setHome } from "../src/pathText.ts";
import {
  CLAUDE_DESKTOP,
  notLinkedReason,
  addLabel,
  agentRows,
  branchOfUrl,
  connectionText,
  defaultChecked,
  defaultInstallLocation,
  directReaderNote,
  downloadLine,
  downloadTip,
  fieldTag,
  fieldText,
  foundLine,
  formatSize,
  githubTreeUrl,
  installLabel,
  jsonHeader,
  landingParts,
  landingTip,
  linkState,
  linkUnrecognized,
  locationOfNav,
  looksLikeGithub,
  mcpInstallBlock,
  mcpInstalledToast,
  keyHintTip,
  keyTrackedNote,
  mcpKeyHint,
  mcpTrackedFiles,
  mcpOrigin,
  mcpRowView,
  navOfLocation,
  noAgent,
  noServer,
  noSkill,
  packageOf,
  parseErrorLine,
  parseGithubLink,
  pickAllState,
  pickHeader,
  pickOrder,
  placeholderFields,
  sameNote,
  skillInstallBlock,
  skillPlanPending,
  skillInstalledToast,
  skillNameOf,
  skillRowView,
  takenAgents,
  writableCount,
} from "../src/market/installView.ts";
import type {
  AgentDir,
  InstallOutcome,
  McpDefinitionInput,
  McpReport,
  McpTargetCheck,
  SkillInstallPreview,
} from "../src/types.ts";

const HOME = "/Users/you";
setHome(HOME);

const agent = (id: string, name: string) => ({ id, name });
const CC = agent("claude-code", "Claude Code");
const CODEX = agent("codex", "Codex");
const CURSOR = agent("cursor", "Cursor");
const GEMINI = agent("gemini-cli", "Gemini CLI");
const OPENCODE = agent("opencode", "OpenCode");
const CLINE = agent("cline", "Cline");
const DESKTOP = agent(CLAUDE_DESKTOP, "Claude Desktop");
const COPILOT = agent("github-copilot", "GitHub Copilot");
/// 已安装的 agent（agent 表的先后）
const INSTALLED = [CC, CODEX, CURSOR, GEMINI, OPENCODE, CLINE, DESKTOP, COPILOT];
/// 设置里 `显示的 agent`
const SHOWN = ["claude-code", "codex", "cursor", "gemini-cli"];
const PROJECT = "project:/Users/you/Project/CardBox";

// ───────── 位置 ─────────

test("位置默认取当前 我的 的位置；全部 时是用户级（R9）", () => {
  assert.equal(defaultInstallLocation("all"), "global");
  assert.equal(defaultInstallLocation("user"), "global");
  assert.equal(defaultInstallLocation(PROJECT), PROJECT);
  // 复用位置页的筛选行：global ↔ user
  assert.equal(navOfLocation("global"), "user");
  assert.equal(navOfLocation(PROJECT), PROJECT);
  assert.equal(locationOfNav("user"), "global");
  assert.equal(locationOfNav("all"), "global");
});

test("生效范围下面：先一句结果，再一行落点路径（#275：用户级 所有项目都能用；项目 只在 CardBox 中能用）", () => {
  assert.deepEqual(landingParts("global", "pdf"), {
    result: "所有项目都能用",
    path: "~/.agents/skills/pdf",
  });
  assert.deepEqual(landingParts(PROJECT, "pdf"), {
    result: "只在 CardBox 中能用",
    path: "~/Project/CardBox/.agents/skills/pdf",
  });
  // 项目名取筛选行的写法（同名项目带区分）；取不到时用文件夹名
  assert.equal(
    landingParts(PROJECT, "pdf", () => "CardBox（工作）").result,
    "只在 CardBox（工作）中能用",
  );
  assert.equal(landingParts(PROJECT, "pdf", () => undefined).result, "只在 CardBox 中能用");
  // 装好几个（从链接安装）：名字写 <名字>
  assert.equal(landingParts("global", null).path, "~/.agents/skills/<名字>");
  // 悬停项目胶囊：这个位置的完整落点
  assert.equal(
    landingTip("/Users/you/Project/CardBox/", "pdf"),
    "/Users/you/Project/CardBox/.agents/skills/pdf",
  );
});

// ───────── 给谁用 / 写进哪些 agent ─────────

test("勾选行：名单里的在前，其余已安装的在后；skill 不列 Claude Desktop", () => {
  const rows = agentRows("skill", INSTALLED, SHOWN).map((a) => a.id);
  assert.deepEqual(rows, [
    "claude-code",
    "codex",
    "cursor",
    "gemini-cli",
    "opencode",
    "cline",
    "github-copilot",
  ]);
});

test("MCP 勾选行：只列能写 MCP 的，Claude Desktop 跟在名单那一段后面（画板 09）", () => {
  const rows = agentRows("mcp", INSTALLED, ["claude-code", "codex", "gemini-cli", "opencode"]);
  assert.deepEqual(
    rows.map((a) => a.id),
    ["claude-code", "codex", "gemini-cli", CLAUDE_DESKTOP, "cursor", "github-copilot"],
  );
  // 没装 Claude Desktop 就没有这一行
  assert.ok(!agentRows("mcp", [CC, CODEX], SHOWN).some((a) => a.id === CLAUDE_DESKTOP));
});

test("默认勾：只勾设置里名单上的（不记上次的选择）；MCP 另外 Claude Desktop 跟着 Claude Code", () => {
  const skillRows = agentRows("skill", INSTALLED, SHOWN);
  assert.deepEqual(defaultChecked("skill", skillRows, SHOWN), SHOWN);
  const mcpRows = agentRows("mcp", INSTALLED, SHOWN);
  assert.deepEqual(defaultChecked("mcp", mcpRows, SHOWN), [
    "claude-code",
    "codex",
    "cursor",
    "gemini-cli",
    CLAUDE_DESKTOP,
  ]);
  // 名单里没有 Claude Code：Desktop 不跟
  assert.ok(!defaultChecked("mcp", mcpRows, ["codex"]).includes(CLAUDE_DESKTOP));
  // 名单里有、但此刻不在列的不勾
  assert.deepEqual(defaultChecked("skill", skillRows, ["gone", "codex"]), ["codex"]);
  assert.equal(directReaderNote(), "直接读取，不用链接");
});

const check = (
  harnessId: string,
  status: McpTargetCheck["status"],
  extra: Partial<McpTargetCheck> = {},
): McpTargetCheck => ({
  harnessId,
  locationId: `global::${harnessId}`,
  status,
  configPath: null,
  writes: status === "ok" || status === "partial" ? ["brave-search"] : [],
  reason: null,
  note: null,
  keyHint: "quiet",
  gitignoreLine: null,
  ...extra,
});

test("MCP 勾选行后面那一句：写不过去的不能勾、就地说原因；部分的能勾、说只写哪几个；Desktop 勾上才说生效时机", () => {
  const blocked = mcpRowView(
    check("codex", "blocked", { reason: "Codex 里已经有一个不一样的 brave-search" }),
    true,
  );
  assert.equal(blocked.disabledReason, "Codex 里已经有一个不一样的 brave-search");
  assert.equal(blocked.note, "Codex 里已经有一个不一样的 brave-search");

  const reason =
    "只写 filesystem · github 是远程服务器，要在 Claude Desktop 自己的「连接器」里添加";
  const partial = check(CLAUDE_DESKTOP, "partial", { reason, note: "重启 Claude Desktop 后生效" });
  assert.deepEqual(mcpRowView(partial, false), { note: reason });
  assert.deepEqual(mcpRowView(partial, true), { note: `${reason} · 重启 Claude Desktop 后生效` });

  const desktop = check(CLAUDE_DESKTOP, "ok", { note: "重启 Claude Desktop 后生效" });
  assert.deepEqual(mcpRowView(desktop, true), { note: "重启 Claude Desktop 后生效" });
  assert.deepEqual(mcpRowView(desktop, false), {});
  assert.deepEqual(mcpRowView(check("claude-code", "same"), true), { note: sameNote() });
  assert.deepEqual(mcpRowView(undefined, true), {});
});

test("MCP 勾选行悬停：能勾的行带配置文件路径（主目录写 ~），不能勾的行只说原因（#276）", () => {
  const codex = check("codex", "ok", { configPath: "/Users/you/.codex/config.toml" });
  assert.deepEqual(mcpRowView(codex, true), { path: "~/.codex/config.toml" });
  assert.deepEqual(mcpRowView(codex, false), { path: "~/.codex/config.toml" });
  const same = check("cursor", "same", { configPath: "/Users/you/.cursor/mcp.json" });
  assert.deepEqual(mcpRowView(same, true), { note: sameNote(), path: "~/.cursor/mcp.json" });
  const blocked = mcpRowView(
    check("codex", "blocked", {
      reason: "Codex 里已经有一个不一样的 brave-search",
      configPath: "/Users/you/.codex/config.toml",
    }),
    true,
  );
  assert.equal(blocked.path, undefined);
  assert.equal(
    say("market.mcp.writesTo", { path: "~/.codex/config.toml" }),
    "写入 ~/.codex/config.toml",
  );
});

test("能写的有几个：只数勾上的、能写或部分能写的（一个都没有时安装不可点）", () => {
  const checks = [
    check("claude-code", "ok"),
    check("codex", "blocked"),
    check("gemini-cli", "same"),
    check(CLAUDE_DESKTOP, "partial"),
    check("cursor", "ok"),
  ];
  assert.equal(writableCount(checks, ["claude-code", "codex", "gemini-cli", CLAUDE_DESKTOP]), 2);
  // 检查还没回来：先按勾了几个说
  assert.equal(writableCount(null, ["a", "b", "c"]), 3);
});

test("贴底（skill，#275）：从 GitHub 下载 · 大小；主机名与分支进悬停；计划没回来时只写已知的", () => {
  const preview = (sizeBytes: number | null): SkillInstallPreview => ({
    plan: {
      location: "global",
      storeDir: "/Users/you/.agents/skills",
      createsStore: false,
      items: [],
      directReaders: [],
      links: [],
      agentDirs: [],
    },
    branch: "main",
    downloadUrl: "https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main",
    sizeBytes,
  });
  assert.equal(downloadLine(preview(2_100_000)), "从 GitHub 下载 · 2.1 MB");
  assert.equal(downloadLine(preview(null)), "从 GitHub 下载");
  assert.equal(downloadLine(null), "从 GitHub 下载");
  // 悬停：主机名 + 分支（计划给的 → 地址里认的 → 调用方知道的）
  assert.deepEqual(downloadTip(preview(2_100_000), null), {
    host: "codeload.github.com",
    branch: "main",
  });
  assert.deepEqual(downloadTip(null, "dev"), { host: "codeload.github.com", branch: "dev" });
  assert.deepEqual(downloadTip(null, null), { host: "codeload.github.com", branch: null });
  // 读链接的结果（从链接安装）同样带下载地址与大小；分支为空时从地址里认
  const link = {
    downloadUrl: "https://codeload.github.com/o/r/tar.gz/refs/heads/trunk",
    sizeBytes: 850_000,
  };
  assert.equal(downloadLine(link), "从 GitHub 下载 · 850 KB");
  assert.deepEqual(downloadTip(link, null), { host: "codeload.github.com", branch: "trunk" });
  assert.equal(
    say("market.install.downloadTip", { host: "codeload.github.com", branch: "main" }),
    "codeload.github.com · 分支 main",
  );
  assert.equal(
    branchOfUrl("https://codeload.github.com/o/r/tar.gz/refs/heads/feature/x"),
    "feature/x",
  );
  assert.equal(formatSize(320), "320 B");
  assert.equal(formatSize(850_000), "850 KB");
  assert.equal(formatSize(2_000_000), "2 MB");
  assert.equal(formatSize(49_950_000), "50 MB");
});

// ───────── 主动作的禁用原因 ─────────

test("安装不可点：落点已有同名 → 原因就是那一句；一个 agent 没勾；一个没选", () => {
  const taken = { blocked: "用户级的通用仓库里已经有 pdf" };
  assert.equal(
    skillInstallBlock({ items: [taken], selected: 1, agents: 2 }),
    "用户级的通用仓库里已经有 pdf",
  );
  assert.equal(
    skillInstallBlock({ items: [{ blocked: null }], selected: 1, agents: 0 }),
    noAgent(),
  );
  assert.equal(skillInstallBlock({ items: [], selected: 0, agents: 2 }), noSkill());
  // 几个里有一个能装：能按
  assert.equal(
    skillInstallBlock({ items: [taken, { blocked: null }], selected: 2, agents: 1 }),
    null,
  );
  // 计划还没回来：不拦（后端装时再判一次）
  assert.equal(skillInstallBlock({ items: [], selected: 1, agents: 1 }), null);
});

test("MCP 不可点：必填的空着、一个 agent 没勾、没名字、勾上的都已经有一样的或都写不进", () => {
  const field = { key: "BRAVE_API_KEY", kind: "env" as const, required: true, secret: true };
  const base = {
    names: ["brave-search"],
    checked: ["claude-code"],
    checks: [check("claude-code", "ok")],
    fields: [field],
    values: {},
  };
  // 没有说明：退回键名
  assert.equal(mcpInstallBlock(base), "请填写 BRAVE_API_KEY");
  assert.equal(
    mcpInstallBlock({ ...base, values: { BRAVE_API_KEY: "   " } }),
    "请填写 BRAVE_API_KEY",
  );
  // 有说明：用说明当名字（#276）
  const token = {
    key: "GITHUB_TOKEN",
    kind: "header" as const,
    required: true,
    secret: true,
    description: "GitHub 访问令牌，在 github.com/settings/personal-access-tokens 生成",
  };
  assert.equal(mcpInstallBlock({ ...base, fields: [token] }), "请填写 GitHub 访问令牌");
  assert.equal(
    mcpInstallBlock({ ...base, fields: [{ ...token, description: "Brave Search API key" }] }),
    "请填写 Brave Search API key",
  );
  assert.equal(mcpInstallBlock({ ...base, values: { BRAVE_API_KEY: "k" } }), null);
  assert.equal(mcpInstallBlock({ ...base, checked: [] }), noAgent());
  assert.equal(mcpInstallBlock({ ...base, names: [] }), noServer());
  assert.equal(mcpInstallBlock({ ...base, names: [""] }), "先给它起个名字");
  assert.equal(
    mcpInstallBlock({ ...base, fields: [], checks: [check("claude-code", "same")] }),
    "勾上的 agent 里已经有一样的 brave-search",
  );
  assert.equal(
    mcpInstallBlock({ ...base, fields: [], checks: [check("claude-code", "blocked")] }),
    "勾上的 agent 都无法写入 brave-search",
  );
  // 选填的空着不拦
  assert.equal(mcpInstallBlock({ ...base, fields: [{ ...field, required: false }] }), null);
});

// ───────── 从链接安装 ─────────

test("就地认链接：四种写法认得出，认不出的不发请求（AC7）", () => {
  assert.deepEqual(parseGithubLink("anthropics/skills"), {
    repo: "anthropics/skills",
    branch: null,
    path: null,
  });
  assert.deepEqual(parseGithubLink(" https://github.com/anthropics/skills.git/ "), {
    repo: "anthropics/skills",
    branch: null,
    path: null,
  });
  assert.deepEqual(parseGithubLink("https://github.com/anthropics/skills/tree/main/skills/pdf"), {
    repo: "anthropics/skills",
    branch: "main",
    path: "skills/pdf",
  });
  assert.deepEqual(
    parseGithubLink("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md?plain=1"),
    { repo: "anthropics/skills", branch: "main", path: "skills/pdf" },
  );
  assert.deepEqual(parseGithubLink("github.com/o/r/tree/dev"), {
    repo: "o/r",
    branch: "dev",
    path: null,
  });
  for (const bad of [
    "",
    "https://example.com",
    "https://example.com/o/r",
    "ftp://github.com/o/r",
    "o/r/extra",
    "o r",
    "https://github.com/o",
    "https://github.com/o/r/blob/main/README.md",
    "https://github.com/o/r/tree/main/..",
    "-o/r",
  ]) {
    assert.equal(parseGithubLink(bad), null, bad);
  }
  assert.ok(looksLikeGithub("anthropics/skills"));
  assert.ok(!looksLikeGithub("随便一段话"));
  assert.deepEqual(linkState(""), { kind: "empty" });
  assert.deepEqual(linkState("https://example.com"), { kind: "unrecognized" });
  assert.equal(linkState("o/r").kind, "reading");
  assert.equal(linkUnrecognized(), "只认 GitHub 上的仓库或文件夹链接");
});

test("从链接安装的几句：认出一行、列表表头、主动作、在 GitHub 打开", () => {
  const resolved = {
    repo: "anthropics/skills",
    branch: "main",
    skills: Array.from({ length: 17 }, (_, i) => ({ name: `s${i}`, path: `skills/s${i}` })),
  };
  assert.equal(foundLine(resolved), "anthropics/skills · main · 找到 17 个 skill");
  assert.equal(foundLine({ ...resolved, skills: [] }), "anthropics/skills · main · 里面没有 skill");
  assert.equal(pickHeader(17, 3), "装哪几个 · 17 个里选了 3");
  assert.equal(installLabel(1), "安装");
  assert.equal(installLabel(3), "安装 3 个");
  assert.equal(
    githubTreeUrl("anthropics/skills", "main", "skills/pdf"),
    "https://github.com/anthropics/skills/tree/main/skills/pdf",
  );
  assert.equal(githubTreeUrl("o/r", null, "a"), "https://github.com/o/r/tree/HEAD/a");
  assert.equal(githubTreeUrl("o/r", "main", null), "https://github.com/o/r");
  assert.equal(skillNameOf("anthropics/skills", "skills/pdf/"), "pdf");
  assert.equal(skillNameOf("me/my-skill", null), "my-skill");
});

// ───────── 从 JSON 添加 ─────────

const github: McpDefinitionInput = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { Authorization: "Bearer ${GITHUB_PAT}" },
};
const filesystem: McpDefinitionInput = {
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "~/My Documents"],
  env: { ROOT: "${ROOT_DIR}", TOKEN: "${GITHUB_PAT}" },
};

test("从 JSON 添加的几句：表头、主动作、第几行错、连接方式", () => {
  assert.equal(jsonHeader(2, 2), "认出 2 个 · 已选 2");
  assert.equal(addLabel(2), "添加 2 个");
  assert.equal(parseErrorLine({ line: 3, message: "少了一个逗号" }), "第 3 行：少了一个逗号");
  assert.equal(parseErrorLine({ line: null, message: "认不出这段配置" }), "认不出这段配置");
  assert.equal(connectionText(github), "在线服务 · https://api.githubcopilot.com/mcp/");
  assert.equal(
    connectionText(filesystem),
    '本地运行 · npx -y @modelcontextprotocol/server-filesystem "~/My Documents"',
  );
});

test("要填的：只有空着的 ${…} 占位时才有；同名只列一次，像密钥的遮住", () => {
  assert.deepEqual(placeholderFields([{ ...filesystem, env: {} }]), []);
  const fields = placeholderFields([github, filesystem]);
  assert.deepEqual(
    fields.map((f) => [f.key, f.kind, f.secret]),
    [
      ["GITHUB_PAT", "header", true],
      ["ROOT_DIR", "env", false],
    ],
  );
  assert.ok(fields.every((f) => f.required));
  assert.equal(fieldTag({ required: true, secret: true }), "必填 · 密钥");
  assert.equal(fieldTag({ required: true, secret: false }), "必填");
  assert.equal(fieldTag({ required: false, secret: false }), "选填");
});

test("要填的一项的写法（#276）：说明当标签、逗号后常显在框下；没有逗号整句当标签；没有说明退回键名", () => {
  assert.deepEqual(
    fieldText({
      key: "GITHUB_TOKEN",
      description: "GitHub 访问令牌，在 github.com/settings/personal-access-tokens 生成",
    }),
    {
      label: "GitHub 访问令牌",
      help: "在 github.com/settings/personal-access-tokens 生成",
      keyed: false,
    },
  );
  assert.deepEqual(fieldText({ key: "BRAVE_API_KEY", description: "Brave Search API key" }), {
    label: "Brave Search API key",
    help: null,
    keyed: false,
  });
  // 官方目录的英文说明里的半角逗号不拆
  assert.deepEqual(fieldText({ key: "K", description: "Your key, from the dashboard" }), {
    label: "Your key, from the dashboard",
    help: null,
    keyed: false,
  });
  for (const description of [undefined, null, "", "   "]) {
    assert.deepEqual(fieldText({ key: "BRAVE_API_KEY", description }), {
      label: "BRAVE_API_KEY",
      help: null,
      keyed: true,
    });
  }
});

test("安装 MCP 的来历（#276）：发布方 + 查看说明（npm / PyPI 上的包指向包的说明页，悬停是包名；其余指向主页）", () => {
  const brave = {
    publisher: "Brave",
    homepage: null,
    definition: {
      name: "brave-search",
      transport: "stdio" as const,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
    },
  };
  assert.deepEqual(mcpOrigin(brave), {
    publisher: "Brave",
    leave: {
      label: "查看说明",
      url: "https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search",
      tip: "@modelcontextprotocol/server-brave-search",
    },
  });
  assert.deepEqual(
    mcpOrigin({
      ...brave,
      definition: { name: "f", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    }).leave,
    {
      label: "查看说明",
      url: "https://pypi.org/project/mcp-server-fetch/",
      tip: "mcp-server-fetch",
    },
  );
  assert.deepEqual(
    packageOf({ name: "x", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] }),
    {
      registry: "pypi",
      name: "mcp-server-fetch",
    },
  );
  assert.deepEqual(
    packageOf({
      name: "x",
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/github/github-mcp-server"],
    }),
    { registry: "oci", name: "ghcr.io/github/github-mcp-server" },
  );
  assert.deepEqual(
    packageOf({ name: "x", transport: "stdio", command: "npx", args: ["-y", "pkg@1.2.0"] }),
    {
      registry: "npm",
      name: "pkg",
    },
  );
  const remote = mcpOrigin({
    publisher: "GitHub",
    homepage: "https://github.com/github/github-mcp-server",
    definition: github,
  });
  assert.deepEqual(remote.leave, {
    label: "查看说明",
    url: "https://github.com/github/github-mcp-server",
    tip: "https://github.com/github/github-mcp-server",
  });
  // 既没有包也没有主页：没有离开键
  assert.equal(mcpOrigin({ publisher: "GitHub", homepage: null, definition: github }).leave, null);
});

// ───────── 装完那一窗 ─────────

const outcome = (
  installed: string[],
  failed: Record<string, string> = {},
  unlinked: InstallOutcome["unlinked"] = [],
): InstallOutcome => ({
  installed,
  failed,
  links: { entries: [] },
  unlinked,
  records: [],
  undoId: installed.length > 0 ? "u1" : null,
});

test("装 skill 之后：✓ 已安装 pdf（例行）；部分没装上是部分失败；全没装上是 pdf 安装失败 + 原因", () => {
  const ok = skillInstalledToast(outcome(["pdf"]));
  assert.equal(ok.kind, "success");
  assert.equal(ok.tier, "routine");
  assert.equal(say(ok.sentence, { names: "pdf" }), "已安装 pdf");
  assert.deepEqual(ok.names, ["pdf"]);
  const partial = skillInstalledToast(
    outcome(["docx", "pptx"], { pdf: "用户级的通用仓库里已经有 pdf" }),
  );
  assert.equal(partial.kind, "partial");
  assert.deepEqual(partial.tally, { done: 2, failed: 1 });
  assert.equal(partial.reason, "pdf：用户级的通用仓库里已经有 pdf");
  const none = skillInstalledToast(outcome([], { pdf: "下载失败" }));
  assert.equal(none.kind, "cannot");
  assert.equal(say(none.sentence, { names: "pdf" }), "pdf 安装失败");
  assert.equal(none.reason, "下载失败");
});

test("M14 装完：勾了的 agent 那里已有同名的没链上，是部分失败一窗：已安装 pdf · Claude Code 没链上：那里已有同名的", () => {
  const taken = "那里已有同名的";
  const one = skillInstalledToast(
    outcome(["pdf"], {}, [{ harnessId: "claude-code", name: "pdf", reason: taken }]),
    INSTALLED,
  );
  assert.equal(one.kind, "partial");
  assert.equal(one.tier, "notice");
  assert.equal(say(one.sentence, { names: "pdf" }), "已安装 pdf");
  assert.deepEqual(one.names, ["pdf"]);
  assert.equal(one.tally, undefined, "没有没装上的，不写 1 ✓ · 0 ⊘");
  assert.equal(one.reason, "Claude Code 没链上：那里已有同名的");

  const two = skillInstalledToast(
    outcome(["pdf"], {}, [
      { harnessId: "claude-code", name: "pdf", reason: taken },
      { harnessId: "cursor", name: "pdf", reason: taken },
    ]),
    INSTALLED,
  );
  assert.equal(two.kind, "partial");
  assert.equal(two.reason, "Claude Code、Cursor 没链上：那里已有同名的");

  // 别的原因照抄后端那一句，按原因分开说
  const mixed = skillInstalledToast(
    outcome(["pdf"], {}, [
      { harnessId: "claude-code", name: "pdf", reason: taken },
      { harnessId: "codex", name: "pdf", reason: "无法写入 Codex 的 skills 目录" },
    ]),
    INSTALLED,
  );
  assert.equal(
    mixed.reason,
    "Claude Code 没链上：那里已有同名的；Codex 没链上：无法写入 Codex 的 skills 目录",
  );
});

test("M14 复审：计划还没回来（不知道哪个 agent 那里已有同名的）时 安装 不能按，说正在检查", () => {
  assert.equal(skillPlanPending(null, null), true);
  assert.equal(skillPlanPending(null, "读不到仓库"), false, "出错了不算在检查，照旧交给后端再判");
  // 换了位置、旧计划还没清掉的那一下：手里的计划（或出错）是上一个位置的，不作数
  assert.equal(skillPlanPending({}, null, true), true);
  assert.equal(skillPlanPending(null, "读不到仓库", true), true);
  assert.equal(skillPlanPending({}, null, false), false);
  assert.equal(
    skillInstallBlock({ items: [], selected: 1, agents: 2, checking: true }),
    "正在检查各 agent",
  );
  // 还没选要装的：先说没选
  assert.equal(skillInstallBlock({ items: [], selected: 0, agents: 2, checking: true }), noSkill());
  assert.equal(
    skillInstallBlock({ items: [{ blocked: null }], selected: 1, agents: 2, checking: false }),
    null,
  );
});

test("M14 装完：全都链上了照旧是 ✓ 已安装 pdf", () => {
  const ok = skillInstalledToast(outcome(["pdf"]), INSTALLED);
  assert.equal(ok.kind, "success");
  assert.equal(ok.tier, "routine");
  assert.equal(ok.reason, undefined);
  assert.equal(say(ok.sentence, { names: "pdf" }), "已安装 pdf");
});

test("M14 装之前：那里已有同名 skill 的 agent 不能勾，名字后就地说原因", () => {
  const dirs: AgentDir[] = [
    { harnessId: "claude-code", dir: "/Users/you/.claude/skills", chosen: false, taken: ["pdf"] },
    { harnessId: "codex", dir: "/Users/you/.codex/skills", chosen: false, taken: [] },
  ];
  const cc = skillRowView(dirs, "claude-code", ["pdf"]);
  assert.equal(cc.disabledReason, "那里已经有一个同名的 pdf，不会覆盖");
  assert.equal(cc.note, "那里已经有一个同名的 pdf，不会覆盖");
  assert.deepEqual(skillRowView(dirs, "codex", ["pdf"]), {});
  // 不在表里的（直接读取的、计划还没回来）照常能勾
  assert.deepEqual(skillRowView(dirs, "cline", ["pdf"]), {});
  assert.deepEqual(skillRowView(undefined, "claude-code", ["pdf"]), {});
  // 什么都还没选：不禁用
  assert.deepEqual(skillRowView(dirs, "claude-code", []), {});
  // 装好几个、只有一部分被占：照样能勾（装完的那一窗说哪一个没链上）
  assert.deepEqual(skillRowView(dirs, "claude-code", ["pdf", "docx"]), {});
  assert.deepEqual(takenAgents(dirs, ["pdf"]), ["claude-code"]);
  assert.deepEqual(takenAgents(dirs, ["pdf", "docx"]), []);
});

const entry = (
  name: string,
  targetId: string,
  outcome: McpReport["entries"][number]["outcome"],
  message = "",
) => ({
  name,
  targetId,
  outcome,
  message,
  backupPath: null,
});

test("加 MCP 之后（#276）：✓ 已加到 [图标…] brave-search，Desktop 接生效时机；已有一样的跳过不算失败", () => {
  const checks = [
    check("claude-code", "ok"),
    check("codex", "ok"),
    check(CLAUDE_DESKTOP, "ok", { note: "重启 Claude Desktop 后生效" }),
    check("cursor", "same"),
  ];
  const report: McpReport = {
    entries: [
      entry("brave-search", "global::claude-code", "created"),
      entry("brave-search", "global::codex", "created"),
      entry("brave-search", `global::${CLAUDE_DESKTOP}`, "created"),
      entry("brave-search", "global::cursor", "skipped", "已有一样的定义，跳过"),
    ],
    undoId: "w1",
  };
  const t = mcpInstalledToast(report, checks, [CC, CODEX, DESKTOP, CURSOR], "global");
  assert.equal(t.kind, "success");
  assert.equal(say(t.sentence, { agents: "[图]", names: "名字" }), "已加到 [图] 名字");
  assert.deepEqual(t.names, ["brave-search"]);
  assert.deepEqual(
    t.agents.map((a) => a.id),
    ["claude-code", "codex", CLAUDE_DESKTOP],
  );
  assert.deepEqual(t.trail, ["重启 Claude Desktop 后生效"]);
  assert.equal(t.reason, undefined);
  // Claude Desktop 第三方模式那一份没写成：仍是成功一行，那一句接在原因的位置（spec 2026-10-05-mcp-claude-3p）
  const NOTE = "第三方模式的那一份没写成：目标配置无法解析或不安全";
  const mirrored = mcpInstalledToast(
    {
      entries: [
        entry("brave-search", "global::claude-code", "created"),
        { ...entry("brave-search", `global::${CLAUDE_DESKTOP}`, "created"), mirrorFailed: NOTE },
      ],
      undoId: "w3",
    },
    checks,
    [CC, DESKTOP],
    "global",
  );
  assert.equal(mirrored.kind, "success");
  assert.equal(mirrored.reason, NOTE);
  assert.deepEqual(mirrored.trail, ["重启 Claude Desktop 后生效"]);

  const partial = mcpInstalledToast(
    {
      entries: [
        entry("brave-search", "global::claude-code", "created"),
        entry("brave-search", "global::codex", "failed", "无法写入 Codex 的配置文件"),
      ],
      undoId: "w2",
    },
    checks,
    [CC, CODEX],
    "global",
  );
  assert.equal(partial.kind, "partial");
  assert.equal(partial.reason, "无法写入 Codex 的配置文件");
  const none = mcpInstalledToast(
    {
      entries: [entry("brave-search", "global::codex", "failed", "无法写入 Codex 的配置文件")],
      undoId: null,
    },
    checks,
    [CODEX],
    "global",
  );
  assert.equal(none.kind, "cannot");
  assert.equal(say(none.sentence, { agents: "[图]", names: "名字" }), "名字 添加失败");
  assert.deepEqual(
    none.agents.map((a) => a.id),
    ["codex"],
  );
});

test("从链接安装的列表：能装的排前面、装过的沉底，各自保持先后；全选只看能装的（空框 / 半选 / 勾）", () => {
  const skills = ["a", "b", "c", "d", "e"].map((name) => ({ path: `skills/${name}`, name }));
  const done = new Set(["skills/a", "skills/c"]);
  const blockedOf = (path: string) => (done.has(path) ? "已经有了" : null);
  assert.deepEqual(
    pickOrder(skills, blockedOf).map((s) => s.name),
    ["b", "d", "e", "a", "c"],
  );
  assert.equal(pickAllState(0, 3), false);
  assert.equal(pickAllState(2, 3), "mixed");
  assert.equal(pickAllState(3, 3), true);
  // 一个能装的都没有：空框（那一行灰着说原因）
  assert.equal(pickAllState(0, 0), false);
});

test("全选那一行：三态框、钉在顶上、个数；都装过了时灰着说原因", async () => {
  const { render } = await import("./ui-render.ts");
  const { PickRow } = await import("../src/market/InstallParts.tsx");
  const base = { label: "全部可装的", name: "全部可装的", onChange: () => undefined, pinned: true };
  const mixed = render(PickRow, { ...base, checked: "mixed" as const, detail: "12 个" });
  assert.match(mixed, /class="install-pick is-pinned"/);
  assert.match(mixed, /aria-checked="mixed"/);
  assert.match(mixed, /12 个/);
  const none = render(PickRow, { ...base, checked: false, blocked: "都已经装过了" });
  assert.match(none, /class="install-pick is-blocked is-pinned"/);
  assert.match(none, /都已经装过了/);
});

test("密钥提醒（S19）：只有「第一次暴露进仓库」才出「同时加进 .gitignore」；没勾、写不过去的不算", async () => {
  const remind = (id: string, line: string, extra: Partial<McpTargetCheck> = {}) =>
    check(id, "ok", { keyHint: "remind", gitignoreLine: line, ...extra });
  const cases: [McpTargetCheck["keyHint"], boolean][] = [
    ["quiet", false],
    ["sourceCommitted", false],
    ["autoIgnore", false],
    ["tracked", false],
    ["remind", true],
  ];
  for (const [keyHint, shown] of cases) {
    const files = mcpKeyHint([remind("cursor", ".cursor/mcp.json", { keyHint })], ["cursor"]);
    assert.equal(files.length > 0, shown, keyHint);
  }
  // 要写进仓库的那个 agent 没勾、或整个写不过去：不出
  assert.deepEqual(mcpKeyHint([remind("cursor", ".cursor/mcp.json")], []), []);
  assert.deepEqual(
    mcpKeyHint([remind("cursor", ".cursor/mcp.json", { status: "blocked" })], ["cursor"]),
    [],
  );
  assert.deepEqual(
    mcpKeyHint([remind("cursor", ".cursor/mcp.json", { status: "partial" })], ["cursor"]),
    [".cursor/mcp.json"],
  );
  // 检查还没回来：先不出
  assert.deepEqual(mcpKeyHint(null, ["cursor"]), []);
  // Claude Code 仅自己（quiet）不算；团队共享与 Cursor 都要提醒时按检查结果的先后列两个文件
  assert.deepEqual(
    mcpKeyHint(
      [check("claude-code", "ok"), remind("cursor", ".cursor/mcp.json")],
      ["claude-code", "cursor"],
    ),
    [".cursor/mcp.json"],
  );
  const both = mcpKeyHint(
    [remind("claude-code", "/.mcp.json"), remind("cursor", ".cursor/mcp.json")],
    ["claude-code", "cursor"],
  );
  assert.deepEqual(both, ["/.mcp.json", ".cursor/mcp.json"]);
  // 写进 .gitignore 的是锚在项目根的 `/.mcp.json`；提示框里列文件时去掉开头的 `/`，读着像相对路径

  // 提示框：哪几个文件在仓库里、不加会怎样、勾上在哪个项目的 .gitignore 里加几行
  assert.equal(
    keyHintTip(both, "sophia"),
    ".mcp.json、.cursor/mcp.json 在 git 仓库里，不加的话，密钥会随下一次提交进仓库。勾上就在 sophia 的 .gitignore 里加这几行，只留在你这台电脑上",
  );
  assert.equal(
    keyHintTip(["/.mcp.json"], "我的项目"),
    ".mcp.json 在 git 仓库里，不加的话，密钥会随下一次提交进仓库。勾上就在我的项目的 .gitignore 里加这一行，只留在你这台电脑上",
  );

  // 没有灰字句；勾选行默认不勾，解释在提示框里
  const { render } = await import("./ui-render.ts");
  const { KeyHintBlock } = await import("../src/market/InstallParts.tsx");
  const tip = keyHintTip(both, "sophia");
  const html = render(KeyHintBlock, {
    checked: false,
    onChange: () => undefined,
    tip,
    tracked: null,
  });
  assert.doesNotMatch(html, /会随仓库提交/);
  assert.doesNotMatch(html, /ss-note/);
  assert.match(html, /role="checkbox" aria-checked="false"/);
  // 表单里附加的一个选项：勾选行小档（名字 13，跟着「要填的」的小字走）
  assert.match(html, /class="ss-checkrow ss-checkrow--small"/);
  assert.match(html, /同时加进 \.gitignore/);
  assert.match(html, /role="tooltip"/);
  assert.ok(html.includes("勾上就在 sophia 的 .gitignore 里加这几行"));
  assert.match(
    render(KeyHintBlock, { checked: true, onChange: () => undefined, tip, tracked: null }),
    /aria-checked="true"/,
  );

  // 有「要填的」时放在那一块最后（说明句下面）；没有时由页面放在「给谁用」最后
  const { FieldsBlock } = await import("../src/market/InstallParts.tsx");
  const fields = render(FieldsBlock, {
    fields: [{ key: "BRAVE_API_KEY", kind: "env", required: true, secret: true }],
    values: {},
    onChange: () => undefined,
    footer: "＠勾选",
  });
  assert.ok(
    fields.indexOf("密钥只保存在所选 agent 中，Sophia 不保留") < fields.indexOf("＠勾选"),
    "勾选在说明句下面",
  );
});

test("勾了「同时加进 .gitignore」却没写成：仍是成功一行，原因接在后面", () => {
  const FAIL = "没能加进 .gitignore：没有写入权限，没动";
  const t = mcpInstalledToast(
    {
      entries: [entry("brave-search", "project:/p::cursor", "created")],
      undoId: "w9",
      gitignoreFailed: FAIL,
    },
    [check("cursor", "ok", { locationId: "project:/p::cursor", keyHint: "remind" })],
    [CURSOR],
    "project:/p",
  );
  assert.equal(t.kind, "success");
  assert.equal(t.reason, FAIL);
  // 同时另一处没写成（部分失败）、或第三方模式那一份也没写成：两句都说，不互相遮住
  const partial = mcpInstalledToast(
    {
      entries: [
        entry("brave-search", "project:/p::cursor", "created"),
        entry("brave-search", "project:/p::codex", "failed", "无法写入 Codex 的配置文件"),
      ],
      undoId: "w10",
      gitignoreFailed: FAIL,
    },
    [check("cursor", "ok"), check("codex", "ok")],
    [CURSOR, CODEX],
    "project:/p",
  );
  assert.equal(partial.kind, "partial");
  assert.equal(partial.reason, `无法写入 Codex 的配置文件 · ${FAIL}`);
  const NOTE = "第三方模式的那一份没写成：目标配置无法解析或不安全";
  const both = mcpInstalledToast(
    {
      entries: [{ ...entry("brave-search", "project:/p::cursor", "created"), mirrorFailed: NOTE }],
      undoId: "w11",
      gitignoreFailed: FAIL,
    },
    [check("cursor", "ok")],
    [CURSOR],
    "project:/p",
  );
  assert.equal(both.reason, `${NOTE} · ${FAIL}`);
});

test("密钥提醒：目标文件已被 git 跟踪（加进 .gitignore 也挡不住）——不出勾选，换成一句说明", async () => {
  const tracked = (id: string, line: string, extra: Partial<McpTargetCheck> = {}) =>
    check(id, "ok", { keyHint: "tracked", gitignoreLine: line, ...extra });
  assert.deepEqual(mcpTrackedFiles([tracked("claude-code", "/.mcp.json")], ["claude-code"]), [
    "/.mcp.json",
  ]);
  // 没勾、写不过去、检查没回来、不是 tracked 的：不算
  assert.deepEqual(mcpTrackedFiles([tracked("claude-code", "/.mcp.json")], []), []);
  assert.deepEqual(
    mcpTrackedFiles([tracked("claude-code", "/.mcp.json", { status: "blocked" })], ["claude-code"]),
    [],
  );
  assert.deepEqual(mcpTrackedFiles(null, ["claude-code"]), []);
  assert.deepEqual(
    mcpTrackedFiles(
      [check("cursor", "ok", { keyHint: "remind", gitignoreLine: ".cursor/mcp.json" })],
      ["cursor"],
    ),
    [],
  );
  // 一个文件不点名；多个写出是哪几个（去掉开头的 `/`）
  assert.equal(keyTrackedNote(["/.mcp.json"]), "这个文件已在仓库里，密钥会随下一次提交上去");
  assert.equal(
    keyTrackedNote(["/.mcp.json", ".cursor/mcp.json"]),
    ".mcp.json、.cursor/mcp.json 已在仓库里，密钥会随下一次提交上去",
  );
  // 和勾选同时出现：一个文件也点名（不然「这个文件」读着像在说全部）；句子的单复数跟着文件数
  assert.equal(
    keyTrackedNote(["/.mcp.json"], true),
    ".mcp.json 已在仓库里，密钥会随下一次提交上去",
  );
  assert.equal(
    keyTrackedNote(["/.mcp.json", ".cursor/mcp.json"], true),
    ".mcp.json、.cursor/mcp.json 已在仓库里，密钥会随下一次提交上去",
  );
  // 在原来勾选的位置：现成的灰字一句，没有勾选框
  const { render } = await import("./ui-render.ts");
  const { KeyHintBlock } = await import("../src/market/InstallParts.tsx");
  const note = keyTrackedNote(["/.mcp.json"]);
  const only = render(KeyHintBlock, {
    checked: false,
    onChange: () => undefined,
    tip: null,
    tracked: note,
  });
  assert.match(only, /class="ss-note"/);
  assert.ok(only.includes("这个文件已在仓库里，密钥会随下一次提交上去"));
  assert.doesNotMatch(only, /role="checkbox"/);
  // 有要提醒的另一个文件时：勾选照出，说明在它下面
  const both = render(KeyHintBlock, {
    checked: false,
    onChange: () => undefined,
    tip: keyHintTip([".cursor/mcp.json"], "sophia"),
    tracked: note,
  });
  assert.ok(both.indexOf('role="checkbox"') < both.indexOf('class="ss-note"'));
});

test("没链上：分不出原因（原因为空）只写主句，不带冒号", () => {
  const agents = [{ id: "codex", name: "Codex" }];
  assert.equal(
    notLinkedReason([{ harnessId: "codex", name: "pdf", reason: "" }], agents),
    "Codex 链接失败",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { t as say } from "../src/i18n.ts";
import { setHome } from "../src/pathText.ts";
import {
  CLAUDE_DESKTOP,
  addLabel,
  agentRows,
  branchOfUrl,
  configFilesLine,
  footRuns,
  connectionText,
  defaultChecked,
  defaultInstallLocation,
  directReaderNote,
  downloadLine,
  fieldTag,
  foundLine,
  formatSize,
  githubTreeUrl,
  installLabel,
  jsonHeader,
  landingLine,
  landingTip,
  linkState,
  linkUnrecognized,
  locationOfNav,
  looksLikeGithub,
  mcpInstallBlock,
  mcpInstalledToast,
  mcpOrigin,
  mcpRowView,
  navOfLocation,
  noAgent,
  noServer,
  noSkill,
  packageOf,
  parseErrorLine,
  parseGithubLink,
  pickHeader,
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
/// 设置里 `列表里的 agent`
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

test("落点行：用户级写 ~/.agents/skills/<名字>，项目写项目里的 .agents；后面一句说它是什么（2026-09-30「通用仓库」改叫 ~/.agents）", () => {
  assert.equal(landingLine("global", "pdf"), "装到 ~/.agents/skills/pdf · 多数 agent 直接读这里");
  assert.equal(
    landingLine(PROJECT, "pdf"),
    "装到 ~/Project/CardBox/.agents/skills/pdf · 多数 agent 直接读这里",
  );
  // 装好几个（从链接安装）：名字写 <名字>
  assert.equal(landingLine("global", null), "装到 ~/.agents/skills/<名字> · 多数 agent 直接读这里");
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
  writes: status === "ok" || status === "partial" ? ["brave-search"] : [],
  reason: null,
  note: null,
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

test("贴底：写进 K 个配置文件——只数勾上的、能写或部分能写的", () => {
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
  assert.equal(configFilesLine(3), "写进 3 个配置文件");
  // 贴底一句：只有读数等宽，汉字两侧的空格走正文字族（不读成两个空格）
  assert.deepEqual(footRuns("写进 3 个配置文件"), [
    { text: "写进 ", mono: false },
    { text: "3", mono: true },
    { text: " 个配置文件", mono: false },
  ]);
  assert.deepEqual(footRuns("从 codeload.github.com 下载 · main · 2.1 MB"), [
    { text: "从 ", mono: false },
    { text: "codeload.github.com", mono: true },
    { text: " 下载 · ", mono: false },
    { text: "main", mono: true },
    { text: " · ", mono: false },
    { text: "2.1 MB", mono: true },
  ]);
});

test("贴底（skill）：从 codeload.github.com 下载 · 分支 · 大小；计划没回来时只写已知的", () => {
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
  assert.equal(
    downloadLine(preview(2_100_000), null),
    "从 codeload.github.com 下载 · main · 2.1 MB",
  );
  assert.equal(downloadLine(preview(null), null), "从 codeload.github.com 下载 · main");
  assert.equal(downloadLine(null, "dev"), "从 codeload.github.com 下载 · dev");
  // 读链接的结果（从链接安装）同样带下载地址与大小；分支为空时从地址里认
  assert.equal(
    downloadLine(
      {
        downloadUrl: "https://codeload.github.com/o/r/tar.gz/refs/heads/trunk",
        sizeBytes: 850_000,
      },
      null,
    ),
    "从 codeload.github.com 下载 · trunk · 850 KB",
  );
  assert.equal(downloadLine(null, null), "从 codeload.github.com 下载");
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
  assert.equal(mcpInstallBlock(base), "先填 BRAVE_API_KEY");
  assert.equal(
    mcpInstallBlock({ ...base, values: { BRAVE_API_KEY: "   " } }),
    "先填 BRAVE_API_KEY",
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
  assert.equal(connectionText(github), "远程 · https://api.githubcopilot.com/mcp/");
  assert.equal(
    connectionText(filesystem),
    '本机命令 · npx -y @modelcontextprotocol/server-filesystem "~/My Documents"',
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

test("安装 MCP 的来历：发布方 · 包名 + npm / PyPI 上的说明；远程的给主页", () => {
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
    ident: "@modelcontextprotocol/server-brave-search",
    leave: {
      label: "npm 上的说明",
      url: "https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search",
    },
  });
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
  assert.equal(remote.ident, "https://api.githubcopilot.com/mcp/");
  assert.deepEqual(remote.leave, {
    label: "在 GitHub 打开",
    url: "https://github.com/github/github-mcp-server",
  });
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

test("写 MCP 之后：✓ 已写进 [图标…] brave-search，Desktop 接生效时机；已有一样的跳过不算失败", () => {
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
  assert.equal(say(t.sentence, { agents: "[图]", names: "名字" }), "已写进 [图] 名字");
  assert.deepEqual(t.names, ["brave-search"]);
  assert.deepEqual(
    t.agents.map((a) => a.id),
    ["claude-code", "codex", CLAUDE_DESKTOP],
  );
  assert.deepEqual(t.trail, ["重启 Claude Desktop 后生效"]);

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
  assert.equal(say(none.sentence, { agents: "[图]", names: "名字" }), "名字 写进 [图] 失败");
  assert.deepEqual(
    none.agents.map((a) => a.id),
    ["codex"],
  );
});

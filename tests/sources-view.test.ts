import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateGroups,
  duplicateNames,
  listNames,
  mcpCandidateGroups,
  mcpLocationName,
  mcpOwnRemoveReason,
  mcpRemoveConfirmBody,
  mcpSourceLines,
  mcpSourceSubtitle,
  mcpSourcesTitle,
  noMcpSourcesText,
  noSourcesText,
  ownRemoveReason,
  removeConfirmBody,
  removeConfirmTitle,
  removeTitle,
  sourceNames,
  sourceSubtitle,
  sourcesTitle,
  stuckTip,
  mcpStuckTip,
} from "../src/pages/sourcesView.ts";
import type {
  CandidateSource,
  McpCandidateSource,
  McpSubscribedSource,
  SubscribedSource,
} from "../src/types.ts";

const cardbox = { key: "project:/Users/me/CardBox", label: "CardBox" };
const global = { key: "global", label: "全局" };

const sub = (over: Partial<SubscribedSource>): SubscribedSource => ({
  id: "/s",
  path: "/s",
  label: "通用仓库",
  shortPath: "~/.agents/skills",
  skills: [],
  skillCount: 0,
  own: false,
  canAutoLink: true,
  autoLink: false,
  autoTargets: [],
  ...over,
});

const cand = (over: Partial<CandidateSource>): CandidateSource => ({
  id: "/c",
  path: "/c",
  label: "c",
  shortPath: "~/c",
  skills: [],
  skillCount: 0,
  usedIn: [],
  ...over,
});

test("页名：专名与汉字之间一个空格，汉字之间不加", () => {
  assert.equal(sourcesTitle(cardbox), "CardBox 的来源");
  assert.equal(sourcesTitle(global), "全局的来源");
  assert.equal(noSourcesText(cardbox), "CardBox 还没有来源");
  assert.equal(noSourcesText(global), "全局还没有来源");
});

const WA = "/Users/me/Library/Application Support/WeiboAP";

test("行名与主视图同一个起名函数：项目自己的仓库写来源名，同名来源带去掉共有开头的区分片段", () => {
  const own = sub({
    id: "/cb",
    path: "/Users/me/CardBox/.agents/skills",
    own: true,
    label: "CardBox · 通用仓库",
    shortPath: "~/CardBox/.agents/skills",
    skillCount: 12,
  });
  const a = sub({
    id: "a",
    path: `${WA}/agent_1776847465710_d5z6cowep/skills`,
    label: "WeiboAP",
    shortPath: "~/Library/Application Support/WeiboAP/agent_1776847465710_d5z6cowep/skills",
    skillCount: 29,
  });
  const b = sub({ id: "b", path: `${WA}/agent_1787890675056_m9ac9h594/skills`, label: "WeiboAP" });
  const names = sourceNames([own, a, b, sub({ id: "u" })]);
  assert.deepEqual(
    [...names],
    [
      ["/cb", "CardBox · 通用仓库"],
      ["a", "WeiboAP · 1776…"],
      ["b", "WeiboAP · 1787…"],
      ["u", "通用仓库"],
    ],
  );
  // 第二行只写短路径与数量，项目自己的也一样
  assert.deepEqual(sourceSubtitle(own), {
    where: "~/CardBox/.agents/skills",
    count: "12 个 skill",
  });
  assert.deepEqual(sourceSubtitle(a), {
    where: "~/Library/Application Support/WeiboAP/agent_1776847465710_d5z6cowep/skills",
    count: "29 个 skill",
  });
});

test("同名：在两个以上已订阅来源里都有的名字；同一来源里重复不算", () => {
  const dup = duplicateNames([
    sub({ skills: ["docx", "pdf"] }),
    sub({ skills: ["docx", "notion", "notion"] }),
    sub({ skills: ["xlsx"] }),
  ]);
  assert.deepEqual([...dup], ["docx"]);
});

test("名字列表：至多 5 个，多了写「等 N 个」", () => {
  assert.equal(listNames(["a", "b"]), "a、b");
  assert.equal(listNames(["a", "b", "c", "d", "e"]), "a、b、c、d、e");
  assert.equal(listNames(["a", "b", "c", "d", "e", "f", "g"]), "a、b、c、d、e 等 7 个");
  assert.equal(listNames([]), "");
});

test("移除的提示框、禁用原因与确认标题", () => {
  assert.equal(removeTitle(cardbox, "WeiboAP"), "从 CardBox 移除 WeiboAP（不动原件）");
  assert.equal(removeTitle(global, "通用仓库"), "从全局移除通用仓库（不动原件）");
  assert.equal(ownRemoveReason(cardbox), "它的原件就在 CardBox 里，删掉原件才会消失");
  assert.equal(removeConfirmTitle(cardbox, "WeiboAP"), "从 CardBox 移除 WeiboAP？");
});

test("移除确认正文：skill 与 agent 各自去重；一条都没有时照实说", () => {
  const link = (skill: string | null, agent: string) => ({ skill, agent, targetId: agent });
  assert.equal(
    removeConfirmBody([
      link("excalidraw", "Claude Code"),
      link("excalidraw", "Codex"),
      link("notion", "Claude Code"),
    ]),
    "这 2 个 skill 在 Claude Code、Codex 下的软链会撤掉：excalidraw、notion",
  );
  // 多于 5 个：等 N 个
  const many = ["a", "b", "c", "d", "e", "f"].map((s) => link(s, "Codex"));
  assert.equal(
    removeConfirmBody(many),
    "这 6 个 skill 在 Codex 下的软链会撤掉：a、b、c、d、e 等 6 个",
  );
  // 整个 skill 文件夹就是一条软链：另起一句
  assert.equal(
    removeConfirmBody([link("a", "Codex"), link(null, "Cline")]),
    "这 1 个 skill 在 Codex 下的软链会撤掉：a；Cline 的整个 skill 文件夹是指向它的软链，也会撤掉",
  );
  assert.equal(removeConfirmBody([]), "它的 skill 会从列表里拿掉，没有软链要撤");
});

test("添加来源弹窗的分组：其他项目在用的写在哪用，检测到的写短路径，带上 skill 给来源行外露；空组不出现", () => {
  const groups = candidateGroups({
    subscribed: [
      sub({ id: "/sa", path: `${WA}/agent_1776847465710_d5z6cowep/skills`, label: "WeiboAP" }),
    ],
    elsewhere: [
      cand({
        id: "/w",
        path: "/w",
        label: "weibo_mini_program",
        usedIn: [
          { key: "project:/a", label: "weibo_assistant" },
          { key: "project:/b", label: "docs-site" },
        ],
      }),
    ],
    detected: [
      cand({
        id: "/x/codex",
        path: "/x/codex",
        label: "Codex",
        shortPath: "~/.codex/skills",
        skills: ["a", "b"],
      }),
      // 已订阅了一个 WeiboAP：候选里的这个与它同名，带上区分片段
      cand({
        id: "/x/wa",
        path: `${WA}/agent_1787890675056_m9ac9h594/skills`,
        label: "WeiboAP",
        shortPath: "~/W/agent_1787890675056_m9ac9h594/skills",
      }),
    ],
  });
  assert.deepEqual(groups, [
    {
      title: "其他项目在用的",
      items: [
        {
          path: "/w",
          name: "weibo_mini_program",
          sub: "weibo_assistant、docs-site 在用",
          skills: [],
        },
      ],
    },
    {
      title: "检测到的",
      items: [
        { path: "/x/codex", name: "Codex", sub: "~/.codex/skills", skills: ["a", "b"] },
        {
          path: `${WA}/agent_1787890675056_m9ac9h594/skills`,
          name: "WeiboAP · 1787…",
          sub: "~/W/agent_1787890675056_m9ac9h594/skills",
          skills: [],
        },
      ],
    },
  ]);
  assert.deepEqual(candidateGroups({ subscribed: [], elsewhere: [], detected: [] }), []);
});

// ===== MCP =====

const mcpSub = (over: Partial<McpSubscribedSource>): McpSubscribedSource => ({
  id: "claude-code",
  label: "Claude Code · User",
  harnessId: "claude-code",
  domain: "global",
  place: "全局",
  path: "/h/.claude.json",
  unreadable: false,
  services: [],
  own: false,
  autoTargets: [],
  ...over,
});

const mcpCand = (over: Partial<McpCandidateSource>): McpCandidateSource => ({
  ...mcpSub({}),
  usedIn: [],
  ...over,
});

test("MCP 页名与空态", () => {
  assert.equal(mcpSourcesTitle(cardbox), "CardBox 的 MCP 来源");
  assert.equal(mcpSourcesTitle(global), "全局的 MCP 来源");
  assert.equal(noMcpSourcesText(cardbox), "CardBox 还没有 MCP 来源");
});

test("MCP 位置名写成 `Claude Code · User`：去掉 MCPs，只有 agent 名的补作用域，WeiboAP 不补", () => {
  const at = (label: string, harnessId: string, domain: string) =>
    mcpLocationName({ label, harnessId, domain });
  assert.equal(at("Claude Code · User MCPs", "claude-code", "global"), "Claude Code · User");
  assert.equal(at("Claude Code · Local MCPs", "claude-code", "project:/a"), "Claude Code · Local");
  assert.equal(at("Codex", "codex", "global"), "Codex · User");
  assert.equal(at("Cursor", "cursor", "project:/a"), "Cursor · Project");
  assert.equal(at("WeiboAP", "weiboap", "project:/w/agent_1"), "WeiboAP");
});

test("MCP 行上两行字：这个项目自己的写「项目里」，其余写它在哪；数服务", () => {
  const own = mcpSub({
    own: true,
    label: "Claude Code · Local",
    domain: cardbox.key,
    place: "CardBox",
    services: [
      { name: "a", portable: true },
      { name: "b", portable: false },
    ],
  });
  assert.deepEqual(mcpSourceLines(own, cardbox), { name: "Claude Code · Local", sub: "项目里" });
  assert.deepEqual(mcpSourceSubtitle(own, cardbox), { where: "项目里", count: "2 个 MCP" });
  assert.deepEqual(mcpSourceSubtitle(mcpSub({}), cardbox), { where: "全局", count: "0 个 MCP" });
  // 全局里自己的写「全局」
  assert.equal(mcpSourceLines(mcpSub({ own: true }), global).sub, "全局");
});

test("MCP 移除：禁用原因、确认正文（服务与位置各自去重；没有时照实说）、搬不过去的提示", () => {
  assert.equal(
    mcpOwnRemoveReason(cardbox),
    "它就是 CardBox 自己的配置，要拿掉里面的服务得去改它本身",
  );
  const item = (name: string, targetId: string) => ({ name, targetId, location: targetId });
  const nameOf = (id: string) => (id === "p" ? "Claude Code · Project" : "Codex · Project");
  assert.equal(
    mcpRemoveConfirmBody([item("docs", "p"), item("docs", "c"), item("search", "p")], nameOf),
    "这 2 个服务在 Claude Code · Project、Codex · Project 里的那份会拿掉：docs、search",
  );
  assert.equal(mcpRemoveConfirmBody([], nameOf), "它的服务会从列表里拿掉，没有写进这里的配置要撤");
  assert.equal(
    stuckTip("internal-tools", "Codex · User"),
    "internal-tools 用了只有 Codex · User 支持的写法，写到别处就不是原来那个了",
  );
});

test("MCP 添加来源弹窗的分组：其他项目在用的写在哪用，检测到的写在哪（服务数在行右端），带上服务给来源行外露；空组不出现", () => {
  const groups = mcpCandidateGroups({
    elsewhere: [
      mcpCand({ id: "codex", label: "Codex · User", usedIn: [{ key: "p", label: "docs-site" }] }),
    ],
    detected: [
      mcpCand({
        id: "o",
        label: "Cursor · Project",
        place: "other",
        services: [{ name: "x", portable: true }],
      }),
    ],
  });
  assert.deepEqual(groups, [
    {
      title: "其他项目在用的",
      items: [{ id: "codex", name: "Codex · User", sub: "docs-site 在用", services: [] }],
    },
    {
      title: "检测到的",
      items: [
        {
          id: "o",
          name: "Cursor · Project",
          sub: "other",
          services: [{ name: "x", portable: true }],
        },
      ],
    },
  ]);
  assert.deepEqual(mcpCandidateGroups({ elsewhere: [], detected: [] }), []);
});

/// DESIGN「「搬不过去」按目标 agent 判断，不按服务一刀切」：只有几家接得住的服务（用命令生成请求头），
/// 显示的位置里有一家接得住就不标；一家都接不住才标，并说清是哪几家接不住
test("MCP 搬不过去按目标 agent 判断：哪儿都搬不过去照旧；只有几家接得住时看这里显示的位置", () => {
  const loc = (harnessId: string, label: string) => ({ harnessId, label, domain: "global" });
  const codex = loc("codex", "Codex · User");
  const cursor = loc("cursor", "Cursor · User");
  const cursorProject = loc("cursor", "Cursor · Project");
  const gemini = loc("gemini", "Gemini CLI · User");
  // 哪儿都搬不过去：沿用原来那句
  assert.equal(
    mcpStuckTip({ name: "internal-tools", portable: false }, "Codex · User", [cursor]),
    stuckTip("internal-tools", "Codex · User"),
  );
  // 谁都接得住：不标
  assert.equal(mcpStuckTip({ name: "docs", portable: true }, "Codex · User", [cursor]), null);
  const helper = { name: "gh", portable: true, onlyHarnesses: ["claude-code", "codex"] };
  // 显示的位置里有一家接得住：不标
  assert.equal(mcpStuckTip(helper, "Claude Code · User", [codex, cursor]), null);
  // 一家都接不住：标，提示框照 DESIGN 写原因（D24：不支持）
  assert.equal(
    mcpStuckTip(helper, "Claude Code · User", [cursor, cursorProject, gemini]),
    "显示的 agent 都不支持用命令生成请求头",
  );
  assert.equal(mcpStuckTip(helper, "Claude Code · User", []), "这里没有能写进 gh 的位置");
});

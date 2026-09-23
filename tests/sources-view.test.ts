import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateGroups,
  columnRows,
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
  sourceLines,
  sourceSubtitle,
  sourcesTitle,
  stuckTip,
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
  segment: "",
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
  segment: "",
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

test("行上两行字：项目自己的写成「X 自己的 skill / 项目里」，同名写区分片段，否则短路径", () => {
  const own = sub({ own: true, label: "CardBox · 通用仓库", skillCount: 12 });
  assert.deepEqual(sourceLines(own, cardbox), { name: "CardBox 自己的 skill", sub: "项目里" });
  assert.equal(sourceSubtitle(own, cardbox), "项目里 · 12 个 skill");
  // 全局里自己的来源照常写名字和路径
  assert.deepEqual(sourceLines(sub({ own: true }), global), {
    name: "通用仓库",
    sub: "~/.agents/skills",
  });
  const weibo = sub({ label: "WeiboAP", segment: "agent_1776a9c3e2f4", skillCount: 29 });
  assert.equal(sourceSubtitle(weibo, cardbox), "agent_1776a9c3e2f4 · 29 个 skill");
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

test("`+ 来源` 的分组：其他项目在用的写在哪用，检测到的写短路径；空组不出现", () => {
  const groups = candidateGroups({
    elsewhere: [
      cand({
        path: "/w",
        label: "weibo_mini_program",
        usedIn: [
          { key: "project:/a", label: "weibo_assistant" },
          { key: "project:/b", label: "docs-site" },
        ],
      }),
    ],
    detected: [
      cand({ path: "/x/codex", label: "Codex", shortPath: "~/.codex/skills" }),
      cand({
        path: "/x/wa",
        label: "WeiboAP",
        segment: "agent_1",
        shortPath: "~/W/agent_1/skills",
      }),
    ],
  });
  assert.deepEqual(groups, [
    {
      title: "其他项目在用的",
      items: [{ path: "/w", name: "weibo_mini_program", sub: "weibo_assistant、docs-site 在用" }],
    },
    {
      title: "检测到的",
      items: [
        { path: "/x/codex", name: "Codex", sub: "~/.codex/skills" },
        { path: "/x/wa", name: "WeiboAP · agent_1", sub: "~/W/agent_1/skills" },
      ],
    },
  ]);
  assert.deepEqual(candidateGroups({ elsewhere: [], detected: [] }), []);
});

test("展开区两列按列读：行数取一半向上取整，至少一行", () => {
  assert.equal(columnRows(6), 3);
  assert.equal(columnRows(7), 4);
  assert.equal(columnRows(1), 1);
  assert.equal(columnRows(0), 1);
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
  assert.equal(mcpSourceSubtitle(own, cardbox), "项目里 · 2 个 MCP");
  assert.equal(mcpSourceSubtitle(mcpSub({}), cardbox), "全局 · 0 个 MCP");
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
    "internal-tools 用了只有 Codex · User 认得的写法，搬到别处就不是原来那个了",
  );
});

test("MCP `+ 来源` 的分组：其他项目在用的写在哪用，检测到的写在哪与服务数；空组不出现", () => {
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
      items: [{ id: "codex", name: "Codex · User", sub: "docs-site 在用" }],
    },
    { title: "检测到的", items: [{ id: "o", name: "Cursor · Project", sub: "other · 1 个 MCP" }] },
  ]);
  assert.deepEqual(mcpCandidateGroups({ elsewhere: [], detected: [] }), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mcpNotices,
  modelNotices,
  noticeLine,
  skillNotices,
  unseenNotices,
  type NoticeIssue,
} from "../src/issueNotice.ts";
import type { SkillIssue } from "../src/issues.ts";
import type { McpIssueItem } from "../src/mcpView.ts";
import type { ModelIssue } from "../src/modelsView.ts";

const skill = (over: Partial<SkillIssue>): SkillIssue => ({
  kind: "duplicateSource",
  key: "k",
  paths: [],
  subject: "defuddle",
  agent: "Cursor",
  gone: false,
  ...over,
});

const n = (key: string): NoticeIssue => ({ key, segment: "skills", subject: key, rest: "有两份" });

test("skill 造句：同名 / 孤链 / 原件还在的失效链接 / 整个文件夹是链接；写不进不算", () => {
  const out = skillNotices([
    skill({ key: "a" }),
    skill({ key: "b", kind: "brokenLink", subject: "old-notes", gone: true }),
    skill({ key: "c", kind: "brokenLink", subject: "pdf" }),
    skill({ key: "d", kind: "wholeLinkedTarget", subject: "Codex" }),
    skill({ key: "e", kind: "readOnlyTarget", subject: "Cline" }),
  ]);
  assert.deepEqual(
    out.map((i) => `${i.subject} ${i.rest}`),
    [
      "defuddle 有两份",
      "old-notes 的链接指向的原件不在了",
      "pdf 在 Cursor 下的链接失效了",
      "Codex 的 skills 文件夹整个是链接",
    ],
  );
  assert.ok(out.every((i) => i.segment === "skills"));
});

test("MCP 造句：两份不一样写「在两处」，更多写数字；读不出来说哪个位置", () => {
  const base = { detailFields: undefined, domain: "global", paths: [] };
  const loc = (id: string) => ({ id, label: id, path: `/${id}` });
  const out = mcpNotices([
    {
      ...base,
      kind: "differentCopies",
      key: "1",
      title: "",
      name: "notion",
      locations: [loc("a"), loc("b")],
    },
    {
      ...base,
      kind: "differentCopies",
      key: "2",
      title: "",
      name: "figma",
      locations: [loc("a"), loc("b"), loc("c")],
    },
    {
      ...base,
      kind: "invalidLocation",
      key: "3",
      title: "",
      name: null,
      locations: [loc("Cline")],
    },
    { ...base, kind: "invalidLocation", key: "4", title: "", name: "x", locations: [loc("Cline")] },
  ] satisfies McpIssueItem[]);
  assert.deepEqual(
    out.map((i) => `${i.subject} ${i.rest}`),
    [
      "notion 在两处不一样",
      "figma 在 3 处不一样",
      "Cline 的配置文件无法读取",
      "x 在 Cline 里无法读取",
    ],
  );
  assert.ok(out.every((i) => i.segment === "mcp"));
});

test("模型造句：句子去掉开头的主语就是后半句", () => {
  const issue: ModelIssue = {
    kind: "takeover",
    key: "model\u001ftakeover\u001fhttps://am",
    subject: "Codex",
    sentence: "Codex 正由 agents-manager 管理",
    action: { kind: "takeover", label: "接管" },
  };
  assert.deepEqual(modelNotices([issue]), [
    { key: issue.key, segment: "models", subject: "Codex", rest: "正由 agents-manager 管理" },
  ]);
});

test("哪些算新：看过的不提示；同一个 key 只算一条", () => {
  const out = unseenNotices([n("a"), n("b"), n("a"), n("c")], new Set(["b"]));
  assert.deepEqual(
    out.map((i) => i.key),
    ["a", "c"],
  );
  assert.deepEqual(unseenNotices([n("a")], new Set(["a"])), []);
});

test("合并：已有提示时新问题接在后面，原来的顺序不动；已经解决的去掉", () => {
  // 正在显示 b、a；这一轮扫描顺序是 a、c、b —— 显示的仍以 b 打头（查看跳去的第一条不被顶掉）
  const out = unseenNotices([n("a"), n("c"), n("b")], new Set(), ["b", "a"]);
  assert.deepEqual(
    out.map((i) => i.key),
    ["b", "a", "c"],
  );
  // a 在行上处理掉了：它从提示里消失，计数跟着变
  const after = unseenNotices([n("c"), n("b")], new Set(), ["b", "a", "c"]);
  assert.deepEqual(
    after.map((i) => i.key),
    ["b", "c"],
  );
  // 点过查看 / × 之后：全看过，一条不剩
  assert.deepEqual(unseenNotices([n("c"), n("b")], new Set(["b", "c"]), ["b", "c"]), []);
});

test("主行：一条按类别造句，多条写「发现 N 处需要你处理」，没有就不出", () => {
  assert.equal(noticeLine([]), null);
  assert.deepEqual(noticeLine([n("defuddle")]), { lead: "defuddle", rest: "有两份" });
  assert.deepEqual(noticeLine([n("a"), n("b"), n("c")]), {
    lead: "发现",
    rest: "3 处需要你处理",
  });
});

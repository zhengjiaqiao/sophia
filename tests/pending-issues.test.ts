import { test } from "node:test";
import assert from "node:assert/strict";

import { collectIssues, joinWords } from "../src/pages/pendingIssues.ts";
import type { Overview } from "../src/types.ts";

test("按钮里的专名：汉字之间不加空格，中西文之间一个空格", () => {
  assert.equal(joinWords("只留", "通用仓库", "的"), "只留通用仓库的");
  assert.equal(joinWords("只留", "WeiboAP", "的"), "只留 WeiboAP 的");
  assert.equal(joinWords("删", "ego lite", "的"), "删 ego lite 的");
});

const target = (id: string, label: string, linkedWholeTo: string | null = null) => ({
  id,
  label,
  path: `/t/${id}`,
  scope: { type: "global" as const, harnessId: id },
  exists: true,
  linkedWholeTo,
});

test("句子拆段：对象名墨色，连接词灰；整个文件夹是链接说来源名而不是路径", () => {
  const overview: Overview = {
    sources: [
      {
        id: "/u",
        path: "/u",
        kind: { type: "universal" },
        label: "通用仓库",
        skills: [{ name: "docx", path: "/u/docx" }],
      },
      {
        id: "/w",
        path: "/w",
        kind: { type: "external" },
        label: "WeiboAP",
        skills: [{ name: "docx", path: "/w/docx" }],
      },
    ],
    domains: [
      {
        key: "global",
        label: "全局",
        targets: [target("codex", "Codex", "/w"), target("cursor", "Cursor")],
        broken: [],
        rows: [
          {
            sourceId: "/u",
            skill: "docx",
            own: true,
            cells: [
              {
                sourceId: "/u",
                skill: "docx",
                targetId: "codex",
                path: "/t/codex/docx",
                state: "wholeLinked",
                pointsTo: null,
              },
              {
                sourceId: "/u",
                skill: "docx",
                targetId: "cursor",
                path: "/t/cursor/docx",
                state: "foreign",
                pointsTo: "/w/docx",
              },
            ],
          },
        ],
      },
    ],
  };
  const issues = collectIssues(overview);
  const dup = issues.find((i) => i.kind === "duplicateSource");
  assert.ok(dup);
  assert.deepEqual(dup.parts, [
    { text: "docx", subject: true },
    { text: " · 通用仓库、WeiboAP 各一份" },
  ]);
  assert.deepEqual(
    dup.deletes.map((d) => d.label),
    ["通用仓库", "WeiboAP"],
  );
  const whole = issues.find((i) => i.kind === "wholeLinkedTarget");
  assert.ok(whole);
  assert.equal(whole.parts[0].text, "Codex");
  assert.equal(whole.parts[1].text, " 的 skills 文件夹整个链接到了 WeiboAP，拆开后才能逐个开关");
  assert.equal(whole.agentId, "codex");
});

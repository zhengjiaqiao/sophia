import { test } from "node:test";
import assert from "node:assert/strict";

import { collectIssues, issueKey } from "../src/issues.ts";
import type { Overview } from "../src/types.ts";

const target = (id: string, label: string, linkedWholeTo: string | null = null) => ({
  id,
  label,
  path: `/t/${id}`,
  scope: { type: "global" as const, harnessId: id },
  exists: true,
  linkedWholeTo,
});

const overview = (): Overview => ({
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
      broken: [
        // 落在 docx 行 cursor 格上的那条：原件还在
        {
          kind: "brokenLink",
          itemName: "pdf",
          sourcePath: "/gone/pdf",
          targetPath: "/t/cursor/pdf",
          target: "/t/cursor",
        },
        // 没有哪一行对得上：孤链
        {
          kind: "brokenLink",
          itemName: "old-notes",
          sourcePath: "/gone/old-notes",
          targetPath: "/t/cursor/old-notes",
          target: "/t/cursor",
        },
      ],
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
        {
          sourceId: "/u",
          skill: "pdf",
          own: true,
          cells: [
            {
              sourceId: "/u",
              skill: "pdf",
              targetId: "cursor",
              path: "/t/cursor/pdf",
              state: "broken",
              pointsTo: "/gone/pdf",
            },
          ],
        },
      ],
    },
  ],
});

test("collectIssues：主语、相关 agent 与 key；同名排最前", () => {
  const issues = collectIssues(overview());
  assert.deepEqual(
    issues.map((i) => [i.kind, i.subject, i.agent, i.gone]),
    [
      ["duplicateSource", "docx", "Cursor", false],
      ["brokenLink", "pdf", "Cursor", false],
      ["brokenLink", "old-notes", "Cursor", true],
      ["wholeLinkedTarget", "Codex", "Codex", false],
    ],
  );
  const dup = issues[0];
  assert.equal(dup.key, issueKey("duplicateSource", ["/u/docx", "/w/docx"]));
  const whole = issues[3];
  assert.equal(whole.key, issueKey("wholeLinkedTarget", ["/t/codex", "/w"]));
});

test("collectIssues：格上与目录里同一条失效链接只算一条，且算作原件还在", () => {
  const broken = collectIssues(overview()).filter((i) => i.key.includes("/t/cursor/pdf"));
  assert.equal(broken.length, 1);
  assert.equal(broken[0].gone, false);
});

test("collectIssues：只看给定的域；没有 overview 时为空", () => {
  const o = overview();
  assert.equal(collectIssues(o, []).length, 0);
  assert.equal(collectIssues(o, o.domains).length, 4);
  assert.deepEqual(collectIssues(null), []);
});

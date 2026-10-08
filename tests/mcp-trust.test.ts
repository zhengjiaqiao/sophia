/// WorkBuddy 的「信任」提示（#256，画板「国产 agent 与国内网络」第 6 屏）：MCP 写进或改写进 WorkBuddy 之后
/// 右下提示一次去它的「自定义连接器」里点「信任」；几个 agent 一起加时主句合并说；停在格子上也有说明。
/// 别的 agent 不提示
import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "../src/i18n.ts";
import { mcpInstalledTrust } from "../src/market/installView.ts";
import { trustCellNote, trustNoticeFor } from "../src/mcpTrust.ts";

// 要不要点信任由 core 的 MCP agent 表给（`trust_app`，经 list_harnesses 的 `mcpTrust` 传来），前端不按 id 认
const WB = { id: "workbuddy", name: "WorkBuddy", trust: true };
const CODEX = { id: "codex", name: "Codex", trust: false };
const CURSOR = { id: "cursor", name: "Cursor", trust: false };

test("写进 WorkBuddy：主句说加到了、要去点信任；第二行是在它里面去哪点", () => {
  assert.deepEqual(trustNoticeFor("write", [WB]), {
    agentId: "workbuddy",
    app: "WorkBuddy",
    sentence: "已加到 WorkBuddy，还要在 WorkBuddy 里点一下「信任」才会连上",
    where: "专家·技能·连接器 → 自定义连接器",
  });
});

test("几个 agent 一起加：主句合并说一次，加到的都写上，信任只说 WorkBuddy", () => {
  const notice = trustNoticeFor("write", [CODEX, WB, CURSOR, WB]);
  assert.equal(
    notice?.sentence,
    "已加到 Codex、WorkBuddy、Cursor，还要在 WorkBuddy 里点一下「信任」才会连上",
  );
});

test("改写 WorkBuddy 里的一条（保留这份）：要重新点信任", () => {
  assert.equal(
    trustNoticeFor("rewrite", [WB])?.sentence,
    "已改好 WorkBuddy 里的这一项，还要在 WorkBuddy 里重新点一下「信任」才会连上",
  );
});

test("没写到 WorkBuddy：不提示", () => {
  assert.equal(trustNoticeFor("write", [CODEX, CURSOR]), null);
  assert.equal(trustNoticeFor("rewrite", [CODEX]), null);
  assert.equal(trustNoticeFor("write", []), null);
  assert.equal(trustNoticeFor("write", [undefined]), null);
});

test("停在 WorkBuddy 的格子上：有的说以后改过也要点、写在哪；没有的说加上后要点；别的 agent 不说", () => {
  assert.equal(
    trustCellNote(WB, true, "~/.workbuddy/mcp.json"),
    "第一次用、以及 Sophia 改过这一条以后，都要在 WorkBuddy 里点「信任」；写在 ~/.workbuddy/mcp.json，改完立刻读到，不用重启",
  );
  assert.equal(
    trustCellNote(WB, false, "~/.workbuddy/mcp.json"),
    "加上后需在 WorkBuddy 里点一下「信任」才会连上",
  );
  assert.equal(trustCellNote(CODEX, true, "~/.codex/config.toml"), null);
  assert.equal(
    trustCellNote({ id: "claude-desktop", name: "Claude Desktop", trust: false }, false, "x"),
    null,
  );
});

test("要不要点信任只看 agent 带来的 trust，不按 id 认", () => {
  assert.equal(trustNoticeFor("write", [{ ...WB, trust: false }]), null);
  assert.equal(trustCellNote({ ...WB, trust: false }, false, "x"), null);
});

test("市场 · 粘贴装 MCP 写进了 WorkBuddy：装完也提示一次；没写成的不算", () => {
  const check = (harnessId: string) => ({
    harnessId,
    locationId: harnessId,
    status: "ok" as const,
    writes: ["playwright"],
    reason: null,
    note: null,
    keyHint: "quiet" as const,
    gitignoreLine: null,
  });
  const entry = (targetId: string, outcome: string) => ({
    name: "playwright",
    targetId,
    outcome,
    message: "",
    backupPath: null,
  });
  const checks = [check("codex"), check("workbuddy")];
  const agents = [
    { id: "codex", name: "Codex", mcpTrust: false },
    { id: "workbuddy", name: "WorkBuddy", mcpTrust: true },
  ];
  assert.equal(
    mcpInstalledTrust(
      { entries: [entry("codex", "created"), entry("workbuddy", "created")], undoId: "u" },
      checks,
      agents,
    )?.sentence,
    "已加到 Codex、WorkBuddy，还要在 WorkBuddy 里点一下「信任」才会连上",
  );
  assert.equal(
    mcpInstalledTrust(
      { entries: [entry("codex", "created"), entry("workbuddy", "failed")], undoId: "u" },
      checks,
      agents,
    ),
    null,
  );
});

test("三种语言都有", () => {
  try {
    setLocale("zh-Hant");
    assert.equal(
      trustNoticeFor("write", [WB])?.sentence,
      "已加到 WorkBuddy，還要在 WorkBuddy 裡點一下「信任」才會連上",
    );
    assert.equal(trustNoticeFor("write", [WB])?.where, "專家·技能·連接器 → 自訂連接器");
    setLocale("en");
    assert.equal(
      trustNoticeFor("write", [CODEX, WB])?.sentence,
      "Added to Codex and WorkBuddy. Click “Trust” in WorkBuddy to connect it",
    );
    assert.match(trustNoticeFor("rewrite", [WB])?.sentence ?? "", /Trust/);
    assert.match(trustCellNote(WB, false, "x") ?? "", /Trust/);
  } finally {
    setLocale("zh-Hans");
  }
});

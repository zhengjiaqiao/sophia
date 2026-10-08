import assert from "node:assert/strict";
import test from "node:test";
import {
  afterGitignoreAdd,
  askedTargets,
  cellKeyHint,
  keyHintNote,
  keyHintNoteAsked,
  scopeKeyHintTip,
  scopeTrackedNote,
} from "../src/mcpKeyHint.ts";
import type { McpKeyHint } from "../src/types.ts";

/// 密钥提醒接到移动 / 复制与自动同步规则（spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」，issue #113）

const hint = (
  hint: McpKeyHint["hint"],
  project = "/Users/you/Project/CardBox",
  gitignoreLine = ".cursor/mcp.json",
  targetId = `project:${project}::cursor`,
): McpKeyHint => ({ targetId, hint, project, gitignoreLine });

test("确认框：只有去处里有「第一次暴露」（remind）才出「同时加进 .gitignore」", () => {
  assert.equal(scopeKeyHintTip(null), null, "检查没回来先不出");
  assert.equal(scopeKeyHintTip([]), null);
  for (const quiet of ["quiet", "sourceCommitted", "autoIgnore", "tracked"] as const) {
    assert.equal(scopeKeyHintTip([hint(quiet)]), null, `${quiet} 不出勾选`);
  }
  // 提示框同安装页一套文案：哪几个文件、在哪个项目的 .gitignore 里加
  assert.equal(
    scopeKeyHintTip([hint("quiet", "/w/other"), hint("remind")]),
    ".cursor/mcp.json 在 git 仓库里，不加的话，密钥会随下一次提交进仓库。勾上就在 CardBox 的 .gitignore 里加这一行，只留在你这台电脑上",
  );
  // 几个项目、几个文件：文件去重，项目按列举写
  assert.equal(
    scopeKeyHintTip([
      hint("remind", "/w/CardBox"),
      hint("remind", "/w/CardBox", "/.mcp.json", "project:/w/CardBox::claude-code"),
      hint("remind", "/w/sophia"),
    ]),
    ".cursor/mcp.json、.mcp.json 在 git 仓库里，不加的话，密钥会随下一次提交进仓库。勾上就在 CardBox、sophia 的 .gitignore 里加这几行，只留在你这台电脑上",
  );
});

test("移动 / 复制的提示条：自动加进 .gitignore 的接「已加进 .gitignore」；没勾的不说", () => {
  assert.equal(keyHintNote({}, false), undefined);
  assert.equal(keyHintNote({ autoIgnored: true }, false), "已加进 .gitignore");
  // 确认框里出了勾选、用户自己决定不勾：不再唠叨
  assert.equal(keyHintNote({ keyExposed: true }, false), undefined);
  // 确认框没出勾选（检查之后来源又变了），写的时候却是第一次暴露：照样说
  assert.equal(keyHintNote({ keyExposed: true }, true), "密钥会随仓库提交，未加入 .gitignore");
  // 没加成：原因接在后面，不互相遮住
  assert.equal(
    keyHintNote(
      { autoIgnored: false, gitignoreFailed: "没能加进 .gitignore：没有写入权限，没动" },
      false,
    ),
    "没能加进 .gitignore：没有写入权限，没动",
  );
});

test("自动同步的提示条：自动加的说「已加进 .gitignore」，第一次暴露的说密钥会随仓库提交", () => {
  assert.equal(keyHintNote({ autoIgnored: true }, true), "已加进 .gitignore");
  assert.equal(keyHintNote({ keyExposed: true }, true), "密钥会随仓库提交，未加入 .gitignore");
  assert.equal(
    keyHintNote({ autoIgnored: true, keyExposed: true }, true),
    "已加进 .gitignore · 密钥会随仓库提交，未加入 .gitignore",
  );
  assert.equal(keyHintNote({}, true), undefined);
});

test("确认框里的勾选：紧挨 13 号的后果那几句，小档，默认不勾，解释在提示框里", async () => {
  const { render } = await import("./ui-render.ts");
  const { ScopeKeyHint } = await import("../src/McpScopeDialog.tsx");
  const tip = scopeKeyHintTip([hint("remind")]) ?? "";
  const html = render(ScopeKeyHint, { checked: false, onChange: () => undefined, tip });
  assert.match(html, /class="ss-checkrow ss-checkrow--small"/);
  assert.match(html, /role="checkbox" aria-checked="false"/);
  assert.match(html, /同时加进 \.gitignore/);
  assert.match(html, /role="tooltip"/);
  assert.ok(html.includes("勾上就在 CardBox 的 .gitignore 里加这一行"));
});

// ===== 目标文件已被 git 跟踪（产品负责人 2026-10-06）：加进 .gitignore 也挡不住，不出勾选，换成一句说明 =====

test("确认框：目标已被跟踪的不出勾选，在同一个位置说一句；多个文件写出是哪几个", () => {
  assert.equal(scopeTrackedNote(null), null);
  assert.equal(scopeTrackedNote([hint("remind"), hint("autoIgnore")]), null);
  assert.equal(scopeTrackedNote([hint("tracked")]), "这个文件已在仓库里，密钥会随下一次提交上去");
  assert.equal(
    scopeTrackedNote([
      hint("tracked", "/w/CardBox"),
      hint("tracked", "/w/CardBox", "/.mcp.json", "project:/w/CardBox::claude-code"),
    ]),
    ".cursor/mcp.json、.mcp.json 已在仓库里，密钥会随下一次提交上去",
  );
  // 有要提醒的、也有已被跟踪的：勾选与说明各管各的
  const mixed = [
    hint("remind", "/w/CardBox"),
    hint("tracked", "/w/CardBox", "/.mcp.json", "project:/w/CardBox::claude-code"),
  ];
  assert.ok(scopeKeyHintTip(mixed)?.startsWith(".cursor/mcp.json 在 git 仓库里"));
  // 和勾选同时出现：点名，不说「这个文件」
  assert.equal(scopeTrackedNote(mixed), ".mcp.json 已在仓库里，密钥会随下一次提交上去");
  // 目标不止一个（同一个文件名在两个项目里）：也点名
  assert.equal(
    scopeTrackedNote([
      hint("tracked", "/w/A", "/.mcp.json", "project:/w/A::claude-code"),
      hint("tracked", "/w/B", "/.mcp.json", "project:/w/B::claude-code"),
    ]),
    ".mcp.json 已在仓库里，密钥会随下一次提交上去",
  );
});

test("确认框里的说明：现成的灰字一句（13 ink-mute），没有勾选框", async () => {
  const { render } = await import("./ui-render.ts");
  const { ScopeKeyHint } = await import("../src/McpScopeDialog.tsx");
  const html = render(ScopeKeyHint, {
    checked: false,
    onChange: () => undefined,
    tip: null,
    tracked: "这个文件已在仓库里，密钥会随下一次提交上去",
  });
  assert.match(html, /class="ss-note"/);
  assert.ok(html.includes("这个文件已在仓库里，密钥会随下一次提交上去"));
  assert.doesNotMatch(html, /role="checkbox"/);
});

test("提示条：目标已被跟踪的，没问过用户时说「密钥会随仓库提交（这个文件已在仓库里）」", () => {
  assert.equal(keyHintNote({ keyTracked: true }, true), "密钥会随仓库提交（这个文件已在仓库里）");
  // 确认框里已经出过那句说明：不重复
  assert.equal(keyHintNote({ keyTracked: true }, false), undefined);
});

// ===== 点格子写入（产品负责人 2026-10-06）：写成那一条的原因位置接一句，第一次暴露的多一颗「加进 .gitignore」 =====

test("格子写入：第一次暴露的说一句并给「加进 .gitignore」；自动加的、已被跟踪的只说；其余什么都不说", () => {
  const id = "project:/w/CardBox::cursor";
  assert.deepEqual(cellKeyHint({ keyExposed: true, ignorable: [id] }), {
    note: "密钥会随仓库提交，未加入 .gitignore",
    addGitignore: true,
  });
  assert.deepEqual(cellKeyHint({ autoIgnored: true, ignorable: [] }), {
    note: "已加进 .gitignore",
    addGitignore: false,
  });
  assert.deepEqual(cellKeyHint({ keyTracked: true }), {
    note: "密钥会随仓库提交（这个文件已在仓库里）",
    addGitignore: false,
  });
  // 来源已提交过、没有密钥、目标不是仓库：报告里什么都没有
  assert.deepEqual(cellKeyHint({}), { note: undefined, addGitignore: false });
  // 点了「加进 .gitignore」：换成「已加进 .gitignore」，键收起
  const written = { keyExposed: true, ignorable: [id] };
  assert.deepEqual(cellKeyHint(afterGitignoreAdd(written, {})), {
    note: "已加进 .gitignore",
    addGitignore: false,
  });
  // 写成之后文件又被跟踪了（加了也挡不住）：不说「已加进」，照实说
  assert.deepEqual(cellKeyHint(afterGitignoreAdd(written, { keyTracked: true })), {
    note: "密钥会随仓库提交（这个文件已在仓库里）",
    addGitignore: false,
  });
  // 没加成：说原因，键收起
  assert.deepEqual(
    cellKeyHint(
      afterGitignoreAdd(written, { gitignoreFailed: "没能加进 .gitignore：没有写入权限，没动" }),
    ),
    {
      note: "密钥会随仓库提交，未加入 .gitignore · 没能加进 .gitignore：没有写入权限，没动",
      addGitignore: false,
    },
  );
});

/// 「保留这份」的确认框（issue #147）：同一套判断，来源＝选中那一份所在的文件，目标＝要改写的其他几处
test("保留这份的确认框：第一次暴露出勾选、已被跟踪出那一句、别的都不出；检查没回来墨键灰着", async () => {
  const { render } = await import("./ui-render.ts");
  const { McpKeepConfirm } = await import("../src/McpKeepConfirm.tsx");
  const props = (hints: McpKeyHint[] | null) => ({
    title: "保留 用户级 · Claude Code 的 dingtalk-doc？",
    body: "其他 2 份（用户级 · Codex、sophia · Cursor）会改成这份；各 agent 自己的设置不动。",
    hints,
    onConfirm: () => undefined,
    onCancel: () => undefined,
  });
  const keyRow = /同时加进 \.gitignore/;
  const note = "这个文件已在仓库里，密钥会随下一次提交上去";

  // 检查没回来：墨键灰着、说正在查看；勾选与那一句都还不出
  const waiting = render(McpKeepConfirm, props(null));
  assert.match(waiting, /disabled=""/);
  assert.ok(waiting.includes("正在查看影响"));
  assert.doesNotMatch(waiting, keyRow);

  // 第一次暴露：正文末尾出勾选（默认档——紧挨的是 15 号的确认框正文；默认不勾、提示框），墨键能按
  const remind = render(McpKeepConfirm, props([hint("remind")]));
  assert.match(remind, /class="ss-checkrow ss-checkrow--list"/);
  assert.doesNotMatch(remind, /ss-checkrow--small/);
  assert.match(remind, /role="checkbox" aria-checked="false"/);
  assert.match(remind, keyRow);
  assert.ok(remind.includes("勾上就在 CardBox 的 .gitignore 里加这一行"));
  assert.doesNotMatch(remind, /disabled=""/);
  assert.ok(!remind.includes(note));
  // 勾选在正文那一句之后、安全信息之前
  assert.ok(remind.indexOf("各 agent 自己的设置不动") < remind.search(keyRow));
  assert.ok(remind.search(keyRow) < remind.indexOf("改之前先备份"));

  // 已被跟踪：勾选的位置换成那一句，多个时写出是哪几个
  const tracked = render(McpKeepConfirm, props([hint("tracked", "/w/sophia", "/.mcp.json")]));
  assert.doesNotMatch(tracked, keyRow);
  assert.ok(tracked.includes(note));
  const many = render(
    McpKeepConfirm,
    props([
      hint("tracked", "/w/sophia", "/.mcp.json"),
      hint("tracked", "/w/sophia", ".cursor/mcp.json", "project:/w/sophia::cursor"),
    ]),
  );
  assert.ok(many.includes(".mcp.json、.cursor/mcp.json 已在仓库里，密钥会随下一次提交上去"));

  // 两种都有：勾选在上、那一句在下；和勾选同时出现，那一句点名（issue #154）
  const both = render(
    McpKeepConfirm,
    props([hint("remind"), hint("tracked", "/w/sophia", "/.mcp.json")]),
  );
  const named = ".mcp.json 已在仓库里，密钥会随下一次提交上去";
  assert.ok(both.includes(named));
  assert.ok(!both.includes(note));
  assert.ok(both.search(keyRow) < both.indexOf(named));

  // 来源被忽略（写完自动加）、来源已提交过、不处理：什么都不说
  for (const quiet of ["autoIgnore", "sourceCommitted", "quiet"] as const) {
    const html = render(McpKeepConfirm, props([hint(quiet)]));
    assert.doesNotMatch(html, keyRow, quiet);
    assert.ok(!html.includes(note), quiet);
    assert.doesNotMatch(html, /disabled=""/, quiet);
  }
});

test("保留这份的提示条：确认框里对哪个目标说过的不再说，没说过的照样说", () => {
  const none = { remind: [], tracked: [] };
  const a = "project:/w/a::cursor";
  const b = "project:/w/b::cursor";
  const exposed = { keyExposed: true, ignorable: [b] };
  const tracked = { keyTracked: true, trackedTargets: [b] };
  assert.equal(keyHintNoteAsked({ autoIgnored: true }, none), "已加进 .gitignore");
  // 出过勾选、用户没勾：不再说
  assert.equal(keyHintNoteAsked(exposed, { remind: [b], tracked: [] }), undefined);
  // 确认框没对它出勾选（检查之后来源又变了）：照样说
  assert.equal(keyHintNoteAsked(exposed, none), "密钥会随仓库提交，未加入 .gitignore");
  // 对 B 出过勾选、确认前 B 被跟踪了：勾选的保护没做成，要说那一句——就算确认框里对别的目标（A）出过那一句
  assert.equal(
    keyHintNoteAsked(tracked, { remind: [b], tracked: [a] }),
    "密钥会随仓库提交（这个文件已在仓库里）",
  );
  // 对 B 出过那一句的不再说
  assert.equal(keyHintNoteAsked(tracked, { remind: [], tracked: [a, b] }), undefined);
});

test("修改生效范围：出过勾选、确认前目标被跟踪了，提示条按目标说那一句（issue #155）", () => {
  const a = "project:/w/a::cursor";
  const b = "project:/w/b::claude-code";
  // 确认框里：A 出了勾选、B 出了已被跟踪那一句；记的是目标，两个入口（保留这份、修改生效范围）同一份
  const asked = askedTargets([
    hint("remind", "/w/a", ".cursor/mcp.json", a),
    hint("tracked", "/w/b", "/.mcp.json", b),
  ]);
  assert.deepEqual(asked, { remind: [a], tracked: [b] });
  assert.deepEqual(askedTargets(null), { remind: [], tracked: [] });
  assert.deepEqual(askedTargets([hint("quiet"), hint("autoIgnore"), hint("sourceCommitted")]), {
    remind: [],
    tracked: [],
  });
  // 写入时 A 仍是第一次暴露、没勾；B 的那一句确认框里说过了：都不再说
  const quiet = { keyExposed: true, ignorable: [a], keyTracked: true, trackedTargets: [b] };
  assert.equal(keyHintNoteAsked(quiet, asked), undefined);
  // 确认框里对 A 出过勾选，确认前 A 被 `git add` 了：写入时按已被跟踪跳过追加，提示条说那一句
  assert.equal(
    keyHintNoteAsked({ keyTracked: true, trackedTargets: [a] }, asked),
    "密钥会随仓库提交（这个文件已在仓库里）",
  );
});

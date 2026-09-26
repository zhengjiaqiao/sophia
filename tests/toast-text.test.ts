import assert from "node:assert/strict";
import test from "node:test";
import { toastFor } from "../src/toastText.ts";

const cc = { id: "claude-code", name: "Claude Code" };
const codex = { id: "codex", name: "Codex" };

test("例行成功：动词与键一致，走 routine 一行字，名字与图标去重保序", () => {
  const t = toastFor("write", {
    done: [
      { name: "excalidraw", agent: codex },
      { name: "notion", agent: codex },
      { name: "excalidraw", agent: cc },
    ],
  });
  assert.equal(t.tier, "routine");
  assert.equal(t.kind, "success");
  assert.equal(t.verb, "写进");
  assert.deepEqual(t.names, ["excalidraw", "notion"]);
  assert.deepEqual(
    t.agents.map((a) => a.id),
    ["codex", "claude-code"],
  );
  // 动词带方向：加到 [图标] 名字 / 从 [图标] 移除 名字（后半截在 verbTail）
  const off = toastFor("unlink", { done: [{ name: "x" }] });
  assert.equal(off.verb, "从");
  assert.equal(off.verbTail, "移除");
  const on = toastFor("link", { done: [{ name: "x" }] });
  assert.equal(on.verb, "加到");
  assert.equal(on.verbTail, undefined);
});

test("单格例行一行省名字：行里已写着对象，只写动词 + agent 图标", () => {
  const on = toastFor("link", { done: [{ name: "docx", agent: codex }], omitNames: true });
  assert.deepEqual(on.names, []);
  assert.equal(on.verb, "加到");
  assert.deepEqual(on.agents, [codex]);
  const off = toastFor("unlink", { done: [{ name: "docx", agent: codex }], omitNames: true });
  assert.equal(off.verb, "从");
  assert.equal(off.verbTail, "移除");
  assert.deepEqual(off.names, []);
  assert.deepEqual(
    toastFor("write", { done: [{ name: "notion", agent: cc }], omitNames: true }).names,
    [],
  );
});

test("全部没成：黑窗 + 否定动词 + 一句原因（失败里写「加到」会被读成已加上）", () => {
  const t = toastFor("link", {
    done: [],
    failed: [{ name: "defuddle", agent: codex, reason: "无法写入 Codex 的 skills 目录" }],
  });
  assert.equal(t.tier, "notice");
  assert.equal(t.kind, "cannot");
  assert.equal(t.verb, "没加上");
  assert.equal(
    toastFor("unlink", { done: [], failed: [{ name: "x", reason: "r" }] }).verb,
    "没移除",
  );
  assert.equal(t.reason, "无法写入 Codex 的 skills 目录");
  assert.deepEqual(t.names, ["defuddle"]);
});

test("部分失败：黑窗 + 肯定动词 + 读数 + 第一条原因", () => {
  const t = toastFor("write", {
    done: [{ name: "a" }, { name: "b" }],
    failed: [{ name: "c", reason: "读不出来" }],
  });
  assert.equal(t.tier, "notice");
  assert.equal(t.kind, "partial");
  assert.equal(t.verb, "写进");
  assert.deepEqual(t.tally, { done: 2, failed: 1 });
  assert.equal(t.reason, "读不出来");
  // skill 的部分失败汇总用不带方向的动词：加上 2 ✓ · 1 ⊘
  const mixed = toastFor("link", {
    done: [{ name: "a" }, { name: "b" }],
    failed: [{ name: "c", reason: "r" }],
  });
  assert.equal(mixed.verb, "加上");
  assert.equal(mixed.verbTail, undefined);
});

test("所有成功都是例行一行（含只留这份、自动规则）；黑窗只给失败。只留这份把来源拼进名字", () => {
  const keep = toastFor("keepThis", { done: [{ name: "defuddle" }], keepLabel: "通用仓库" });
  assert.equal(keep.tier, "routine");
  assert.equal(keep.verb, "只留");
  assert.deepEqual(keep.names, ["通用仓库 的 defuddle"]);
  assert.equal(toastFor("autoLink", { done: [{ name: "x" }] }).tier, "routine");
  assert.equal(toastFor("autoWrite", { done: [{ name: "x" }] }).tier, "routine");
  // 失败照旧黑窗
  const failed = [{ name: "x", reason: "r" }];
  assert.equal(toastFor("keepThis", { done: [], failed }).tier, "notice");
  assert.equal(toastFor("autoLink", { done: [{ name: "y" }], failed }).tier, "notice");
  assert.equal(toastFor("autoLink", { done: [{ name: "x" }] }).verb, "自动加到");
  assert.equal(toastFor("autoWrite", { done: [{ name: "x" }] }).verb, "自动写进");
});

test("只留这份的确认框：标题问留哪份；正文写哪份进废纸篓、几条链接改指，没有就不写后半句", async () => {
  const { keepThisConfirm } = await import("../src/toastText.ts");
  const base = {
    kept: { name: "通用仓库", seg: "", path: "/Users/jia/.agents/skills/defuddle" },
    other: { name: "WeiboAP", seg: "", path: "/Users/jia/WeiboAP/skills/defuddle" },
    skill: "defuddle",
  };
  const t = keepThisConfirm({ ...base, relinked: 3 });
  assert.equal(t.title, "只留 通用仓库 的 defuddle？");
  assert.equal(t.body, "WeiboAP 那份移到废纸篓，3 条链接改指到这一份");
  assert.equal(keepThisConfirm({ ...base, relinked: 0 }).body, "WeiboAP 那份移到废纸篓");
});

test("只留这份的确认框：标题下两行写两份的完整路径，主目录写 ~，不截断", async () => {
  const { keepThisConfirm } = await import("../src/toastText.ts");
  const { setHome } = await import("../src/pathText.ts");
  setHome("/Users/jia");
  const long = `/Users/jia/${"very-long-folder/".repeat(8)}skills/defuddle`;
  const t = keepThisConfirm({
    kept: { name: "通用仓库", seg: "", path: "/Users/jia/.agents/skills/defuddle" },
    other: { name: "WeiboAP", seg: "", path: long },
    skill: "defuddle",
    relinked: 0,
  });
  assert.deepEqual(t.paths, [
    { label: "留下", path: "~/.agents/skills/defuddle" },
    { label: "移到废纸篓", path: `~/${"very-long-folder/".repeat(8)}skills/defuddle` },
  ]);
  setHome(null);
});

test("只留这份的确认框：同名来源在标题和后果句里用区分片段", async () => {
  const { keepThisConfirm } = await import("../src/toastText.ts");
  const t = keepThisConfirm({
    kept: { name: "ego lite", seg: "0.5.1.11", path: "/e/0.5.1.11/skills/ego-browser" },
    other: { name: "ego lite", seg: "0.5.0.32", path: "/e/0.5.0.32/skills/ego-browser" },
    skill: "ego-browser",
    relinked: 2,
  });
  assert.equal(t.title, "只留 ego lite · 0.5.1.11 的 ego-browser？");
  assert.equal(t.body, "ego lite · 0.5.0.32 那份移到废纸篓，2 条链接改指到这一份");
});

test("拆开的确认框：标题问拆哪个 agent 的 skills 文件夹，正文说后果", async () => {
  const { splitConfirm } = await import("../src/toastText.ts");
  assert.deepEqual(splitConfirm("Codex"), {
    title: "拆开 Codex 的 skills 文件夹？",
    body: "把链接换成真文件夹，里面的内容原样复制过来",
  });
});

test("拆开成功：例行一行 `拆开 [Codex] 的 skills 文件夹`，走 routine，不带撤销（拆开不是可逆的开关）", () => {
  const t = toastFor("split", { done: [{ name: "的 skills 文件夹", agent: codex }] });
  assert.equal(t.tier, "routine");
  assert.equal(t.kind, "success");
  assert.equal(t.verb, "拆开");
  assert.deepEqual(t.names, ["的 skills 文件夹"]);
  assert.deepEqual(
    t.agents.map((a) => a.id),
    ["codex"],
  );
  // 全部没成时否定动词：没拆开
  assert.equal(
    toastFor("split", { done: [], failed: [{ name: "x", reason: "r" }] }).verb,
    "没拆开",
  );
});

// ---- 删除原件（DESIGN「删除原件」，2026-09-25） ----

test("删除 skill 原件的确认框：标题一问，正文只说后果（谁不能再用、链接怎么办），不写路径、不写可以撤销", async () => {
  const { deleteOriginalConfirm } = await import("../src/toastText.ts");
  const { setHome } = await import("../src/pathText.ts");
  setHome("/Users/jia");
  const base = { skill: "graduate", ownAgents: ["Codex"] };
  // 别处没有同名原件：谁不能再用它、链接一并删除、能找回什么
  const gone = deleteOriginalConfirm({ ...base, links: 2, linkAgents: ["Claude Code"] });
  assert.equal(gone.title, "删除 graduate？");
  assert.equal(gone.body, "删除后 Codex、Claude Code 都不能再用它：指向它的 2 条软链接一并删除");
  assert.equal("paths" in gone, false);
  // 别处有同名原件：有链接的 agent 改用那一份，直接读原件目录的 agent 不能再用
  assert.equal(
    deleteOriginalConfirm({ ...base, links: 2, linkAgents: ["Claude Code"], relinkTo: "通用仓库" })
      .body,
    "删除后 Claude Code 改用 通用仓库 里的同名 graduate（2 条软链接改指过去）；Codex 不能再用它",
  );
  // 没有链接：只说谁不能再用
  assert.equal(
    deleteOriginalConfirm({ ...base, links: 0, linkAgents: [] }).body,
    "删除后 Codex 不能再用它",
  );
  setHome(null);
});

test("删除 skill 原件：能撤销时一行 ✓ 已删除（撤销键由调用方挂）；进了废纸篓才说在废纸篓里", async () => {
  const { deletedOriginalToast } = await import("../src/toastText.ts");
  const held = deletedOriginalToast("defuddle", true);
  assert.equal(held.tier, "routine");
  assert.equal(held.kind, "success");
  assert.equal(held.verb, "已删除");
  assert.deepEqual(held.names, ["defuddle"]);
  assert.equal(held.reason, undefined);
  assert.equal(deletedOriginalToast("defuddle").reason, "在废纸篓里");
});

test("撤销删原件：全回来 ✓ 已恢复；链接没回来是部分失败；原件没放回是做不成", async () => {
  const { restoredOriginalToast } = await import("../src/toastText.ts");
  const ok = restoredOriginalToast("defuddle", { bodyBack: true, failed: [] });
  assert.equal(ok.kind, "success");
  assert.equal(ok.verb, "已恢复");
  const part = restoredOriginalToast("defuddle", {
    bodyBack: true,
    failed: ["链接之后又被改过，没有指回去"],
  });
  assert.equal(part.kind, "partial");
  assert.equal(part.reason, "1 条链接没恢复：链接之后又被改过，没有指回去");
  const no = restoredOriginalToast("defuddle", {
    bodyBack: false,
    failed: ["原处已经有同名的东西，没有放回"],
  });
  assert.equal(no.kind, "cannot");
  assert.equal(no.verb, "没恢复");
  assert.equal(no.reason, "原处已经有同名的东西，没有放回");
});

/// DESIGN「删除原件」MCP：点任何一格 ⦿ 都先确认，正文说后果（不能再用 + 别处怎样 / 会从列表里移除）
test("点 ⦿ 的确认框：说后果——别的 agent 里有同名的不受影响、没有就说会从列表里移除；不写配置路径、不写可以撤销", async () => {
  const { deleteMcpOriginalConfirm, deletedMcpOriginalToast } = await import("../src/toastText.ts");
  const { setHome } = await import("../src/pathText.ts");
  setHome("/Users/jia");
  const codexDel = deleteMcpOriginalConfirm({
    agent: "Codex",
    name: "weibo-search",
    others: ["Claude Code"],
  });
  assert.equal(codexDel.title, "从 Codex 删除 weibo-search？");
  assert.equal(codexDel.body, "删除后 Codex 不能再用它；Claude Code 里的那份不受影响");
  assert.equal("paths" in codexDel, false);
  const local = deleteMcpOriginalConfirm({
    agent: "Claude Code local",
    name: "weibo-search",
    others: [],
  });
  assert.equal(local.title, "从 Claude Code local 删除 weibo-search？");
  assert.equal(local.body, "删除后 Claude Code local 不能再用它，这个 MCP 也会从列表里移除");
  setHome(null);
  // 删完：`✓ 已从 [Codex] 删除 weibo-search`（撤销由调用方给，一律给）
  const t = deletedMcpOriginalToast("weibo-search", codex);
  assert.equal(t.tier, "routine");
  assert.equal(t.kind, "success");
  assert.equal(t.verb, "已从");
  assert.equal(t.verbTail, "删除");
  assert.deepEqual(t.names, ["weibo-search"]);
  assert.deepEqual(t.agents, [codex]);
});

/// DESIGN「表格」MCP 条「选择行」：全有（⦿）时按下确认一次，标题带数量，正文先列名字再说后果
test("选择行批量删除的确认框：标题 `从 Codex 删除 3 个 MCP？`，正文先列名字，后果同单格", async () => {
  const { deleteMcpBatchConfirm } = await import("../src/toastText.ts");
  const { setHome } = await import("../src/pathText.ts");
  setHome("/Users/jia");
  const some = deleteMcpBatchConfirm({
    agents: ["Codex"],
    names: ["weibo-search", "notion", "fmt"],
    others: ["Claude Code"],
    leaving: 1,
  });
  assert.equal(some.title, "从 Codex 删除 3 个 MCP？");
  assert.equal(
    some.body,
    "weibo-search、notion、fmt。删除后 Codex 不能再用它们；其中 1 个会从列表里移除；Claude Code 里的同名定义不受影响",
  );
  assert.equal("paths" in some, false);
  // 「所有位置」：几个 agent 一起写；别处都没有了
  const all = deleteMcpBatchConfirm({
    agents: ["Codex", "Claude Code local"],
    names: ["notion", "fmt"],
    others: [],
    leaving: 2,
  });
  assert.equal(all.title, "从 Codex、Claude Code local 删除 2 个 MCP？");
  assert.equal(
    all.body,
    "notion、fmt。删除后 Codex、Claude Code local 不能再用它们，这些 MCP 也会从列表里移除",
  );
  setHome(null);
  // 名字太多：列前 12 个，其余写 `等 N 个`（标题已有总数）
  const many = deleteMcpBatchConfirm({
    agents: ["Codex"],
    names: Array.from({ length: 14 }, (_, i) => `m${i + 1}`),
    others: [],
    paths: [],
  });
  assert.equal(many.title, "从 Codex 删除 14 个 MCP？");
  assert.ok(many.body.startsWith("m1、m2、m3、m4、m5、m6、m7、m8、m9、m10、m11、m12 等 14 个。"));
});

test("批量删除的结果：`✓ 已从 [Codex] 删除`（调用方写数量、给撤销）；全没删掉用否定动词；部分失败带计数", async () => {
  const { toastFor, batchBusyText } = await import("../src/toastText.ts");
  const ok = toastFor("delete", {
    done: [
      { name: "notion", agent: codex },
      { name: "fmt", agent: codex },
    ],
  });
  assert.equal(ok.tier, "routine");
  assert.equal(ok.kind, "success");
  assert.equal(ok.verb, "已从");
  assert.equal(ok.verbTail, "删除");
  assert.deepEqual(ok.agents, [codex]);
  const none = toastFor("delete", {
    done: [],
    failed: [{ name: "fmt", agent: codex, reason: "这一项的写法无法安全地单独拿掉，没有改动" }],
  });
  assert.equal(none.kind, "cannot");
  assert.equal(none.verb, "没删掉");
  const partial = toastFor("delete", {
    done: [{ name: "notion", agent: codex }],
    failed: [{ name: "fmt", agent: codex, reason: "配置在预览后发生变化" }],
  });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.verb, "删除");
  assert.deepEqual(partial.tally, { done: 1, failed: 1 });
  assert.equal(batchBusyText("delete", "Codex"), "正在从 Codex 删除");
});

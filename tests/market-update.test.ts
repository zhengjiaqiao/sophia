/// 有更新（spec 2026-09-27-skill-mcp-market R14 R15 R16，AC14 AC15；DESIGN「发现与安装 › 有更新」「设置 › skill 更新」）：
/// src/market/updateView.ts 的纯逻辑、useSkillUpdates.ts 的 store（换假的 core）、提示条 / 行记号 / 抽屉末行 /
/// 确认框 / 纸窗的静态渲染，以及灰面板（一次性说明用法）的两颗键
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { t as say } from "../src/i18n.ts";
import { render } from "./ui-render.ts";
import { withCopy } from "./copy.ts";
import type { InstallOutcome, UpdateCheck, UpdateInfo, UpdateTarget } from "../src/types.ts";

const view = await import("../src/market/updateView.ts");
const { createUpdateStore, rowTrigger } = await import("../src/market/useSkillUpdates.ts");
const { NoticePanel } = await import("../src/ui/NoticePanel.tsx");
const { UpdateStrip } = await import("../src/market/UpdateStrip.tsx");
const { UpdateMark, UpdateDrawerLine, updateMark } = await import("../src/market/UpdateRow.tsx");
const { UpdateConfirm, UpdateResultToast } = await import("../src/market/UpdateFlow.tsx");

const HOME = "/Users/you";
function info(name: string, over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    name,
    location: "global",
    dir: `${HOME}/.agents/skills/${name}`,
    repo: "anthropics/skills",
    branch: "main",
    path: `skills/${name}`,
    origin: "sophia",
    localTreeSha: "l-" + name,
    recordedTreeSha: "l-" + name,
    remoteTreeSha: "r-" + name,
    locallyModified: false,
    changedFiles: [],
    ...over,
  };
}
const pdf = info("pdf", {
  locallyModified: true,
  localTreeSha: "x-pdf",
  changedFiles: ["SKILL.md", "scripts/fill.py"],
});
const creator = info("skill-creator");
const docx = info("docx", { location: "project:/Users/you/code/CardBox", remoteTreeSha: "r-docx" });

function outcome(
  installed: string[],
  failed: Record<string, string> = {},
  undoId: string | null = "u1",
): InstallOutcome {
  return {
    installed,
    failed,
    links: { entries: [] } as unknown as InstallOutcome["links"],
    unlinked: [],
    records: [],
    undoId,
  };
}

// ---- updateView：提示条、行、抽屉 ----

test("提示条：一句 `N 个 skill 有新版本`；只在 core 说这一批没关掉、且当前位置里真有新版本时出", () => {
  assert.equal(view.stripSentence(2), "2 个 skill 有新版本");
  const all = [pdf, creator, docx];
  assert.equal(view.scopeUpdates(all, null).length, 3);
  assert.deepEqual(
    view.scopeUpdates(all, "global").map((u) => u.name),
    ["pdf", "skill-creator"],
  );
  assert.deepEqual(view.scopeUpdates(all, "project:/Users/you/code/other"), []);
  assert.equal(view.stripOpen(true, view.scopeUpdates(all, "global")), true);
  assert.equal(view.stripOpen(false, all), false, "按过 × 的这一批不再提");
  assert.equal(view.stripOpen(true, []), false, "当前位置里没有新版本");
});

test("`只看这些` ↔ `显示全部`；都更新完了回到全部", () => {
  assert.equal(view.onlyTheseLabel(false), "只看这些");
  assert.equal(view.onlyTheseLabel(true), "显示全部");
  assert.equal(view.onlyTheseActive(true, [pdf]), true);
  assert.equal(view.onlyTheseActive(true, []), false);
  assert.equal(view.onlyTheseActive(false, [pdf]), false);
});

test("行上 `有更新`：按原件路径认（同位置同名的两份只挂装自仓库的那一份），没给路径按位置 + 名字", () => {
  const all = [pdf, creator, docx];
  assert.equal(view.updateMark(), "有更新");
  assert.equal(view.updateForRow(all, { location: "global", name: "pdf", path: pdf.dir }), pdf);
  assert.equal(
    view.updateForRow(all, { location: "global", name: "pdf", path: `${HOME}/code/mine/pdf` }),
    undefined,
    "同名的另一份（×2）不挂",
  );
  assert.equal(
    view.updateForRow(all, { location: "global", name: "docx" }),
    undefined,
    "别的位置的不挂",
  );
  assert.equal(
    view.updateForRow(all, { location: "project:/Users/you/code/CardBox", name: "docx" }),
    docx,
  );
});

test("抽屉末行：`来自 anthropics/skills · 有新版本`，`看改动` 是这个文件夹在 GitHub 上的提交记录", () => {
  const line = view.drawerLine(pdf);
  assert.equal(line.text, "来自 anthropics/skills · 有新版本");
  assert.equal(line.url, "https://github.com/anthropics/skills/commits/main/skills/pdf");
  // 分支里的 `/` 保留、各段编码；仓库根上的 skill 没有路径段
  assert.equal(
    view.commitsUrl("o/r", "release/1.x", "skills/my skill"),
    "https://github.com/o/r/commits/release/1.x/skills/my%20skill",
  );
  assert.equal(view.commitsUrl("o/r", "main", ""), "https://github.com/o/r/commits/main");
});

test("× 记下的这一批：全部位置的新版本 tree SHA，去重排序（整批替换，只给当前位置的会把别处关掉的放出来）", () => {
  assert.deepEqual(view.dismissBatch([docx, pdf, creator, pdf]), [
    "r-docx",
    "r-pdf",
    "r-skill-creator",
  ]);
  assert.deepEqual(view.dismissBatch([]), []);
});

// ---- updateView：确认与纸窗 ----

test("确认只在有本地改动时：都没改过直接更新", () => {
  assert.equal(view.needsConfirm([creator, docx]), false);
  assert.equal(view.needsConfirm([pdf, creator]), true);
});

test("确认框：`更新 2 个 skill？` + 哪个改过、哪个没改 + 只列改过的那一个的文件 + 墨键 `全部更新`", () => {
  const m = view.confirmModel([pdf, creator]);
  assert.equal(m.title, "更新 2 个 skill？");
  assert.equal(m.body, "pdf 里有 2 个文件你改过，更新会覆盖这些改动；skill-creator 没改过。");
  assert.deepEqual(m.files, ["SKILL.md", "scripts/fill.py"]);
  assert.equal(m.confirmLabel, "全部更新");
});

test("确认框：单个是 `更新 pdf？` + 墨键 `更新`", () => {
  const m = view.confirmModel([pdf]);
  assert.equal(m.title, "更新 pdf？");
  assert.equal(m.body, "pdf 里有 2 个文件你改过，更新会覆盖这些改动。");
  assert.equal(m.confirmLabel, "更新");
});

test("确认框：数不出改了哪些文件时（只改了权限位、或取不到装时那一版的清单）只说本地改过，不猜是权限", () => {
  const unknown = info("pdf", { locallyModified: true, changedFiles: [] });
  const m = view.confirmModel([unknown]);
  assert.equal(m.body, "pdf 本地改过，更新会覆盖这些改动。");
  assert.deepEqual(m.files, []);
  // 与数得出文件的一起：并进同一句
  const xlsx = info("xlsx", { locallyModified: true, changedFiles: ["a.py"] });
  const two = view.confirmModel([xlsx, unknown, creator]);
  assert.equal(
    two.body,
    "xlsx 里有 1 个文件、pdf 你改过，更新会覆盖这些改动；skill-creator 没改过。",
  );
});

test("确认框：改过的不止一个 skill 时文件清单带上 skill 名", () => {
  const xlsx = info("xlsx", { locallyModified: true, changedFiles: ["a.py"] });
  const m = view.confirmModel([pdf, xlsx]);
  assert.equal(m.body, "pdf 里有 2 个文件、xlsx 里有 1 个文件你改过，更新会覆盖这些改动。");
  assert.deepEqual(m.files, ["pdf/SKILL.md", "pdf/scripts/fill.py", "xlsx/a.py"]);
});

test("纸窗：`✓ 已更新 2 个 skill` + 撤销；单个写名字；做不成与部分成带原因", () => {
  assert.deepEqual(view.updatedToast(outcome(["pdf", "skill-creator"])), {
    kind: "success",
    sentence: "market.toast.updateDone",
    count: 2,
    undoable: true,
  });
  assert.deepEqual(view.updatedToast(outcome(["pdf"])), {
    kind: "success",
    sentence: "market.toast.updateDone",
    names: ["pdf"],
    undoable: true,
  });
  assert.equal(view.updatedToast(outcome(["pdf"], {}, null)).undoable, false);
  assert.deepEqual(view.updatedToast(outcome([], { pdf: "GitHub 暂时限流，稍后再试" }, null)), {
    kind: "cannot",
    sentence: "market.toast.updateCannot",
    names: ["pdf"],
    reason: "GitHub 暂时限流，稍后再试",
    undoable: false,
  });
  const partial = view.updatedToast(outcome(["pdf"], { docx: "下载失败" }));
  assert.equal(partial.kind, "partial");
  assert.equal(say(partial.sentence), "已更新");
  assert.equal(say("market.toast.updateDone", { names: "pdf" }), "已更新 pdf");
  assert.equal(say("market.toast.updateCannot", { names: "pdf" }), "pdf 更新失败");
  assert.deepEqual(partial.tally, { done: 1, failed: 1 });
  assert.equal(partial.reason, "docx：下载失败");
  assert.equal(partial.undoable, true);
});

test("更新成了的从列表里拿掉（按位置 + 名字），撤销放回", () => {
  const same = info("pdf", { location: "project:/p" });
  const { rest, removed } = view.afterUpdate([pdf, creator, same], [pdf, creator], ["pdf"]);
  assert.deepEqual(
    rest.map((u) => `${u.location}:${u.name}`),
    ["global:skill-creator", "project:/p:pdf"],
    "别的位置的同名 skill 不动；没更新成的留着",
  );
  assert.deepEqual(removed, [pdf]);
  assert.deepEqual(
    view.restoreUpdates(rest, removed).map((u) => u.name),
    ["skill-creator", "pdf", "pdf"],
  );
  assert.equal(view.restoreUpdates([pdf], [pdf]).length, 1, "已经在的不重复放");
});

test("按下之后查的结果是降级来的：限流说固定句，连接不上说无法连接", () => {
  assert.equal(view.fallbackNotice(null), null);
  assert.equal(
    view.fallbackNotice({ service: "GitHub", cachedAt: 1, rateLimited: true }),
    "GitHub 暂时限流，稍后再试",
  );
  assert.equal(
    view.fallbackNotice({ service: "GitHub", cachedAt: null, rateLimited: false }),
    "无法连接 GitHub，请检查网络",
  );
});

test("设置行 `上次检查` 的灰字：`今天 14:32 · 2 个有更新`；昨天、跨日、跨年；没拿到结果只写时刻；从没查过", () => {
  const now = new Date(2026, 8, 27, 18, 0);
  const at = (d: Date) => Math.floor(d.getTime() / 1000);
  assert.equal(
    view.lastCheckDetail(at(new Date(2026, 8, 27, 14, 32)), 2, now),
    "今天 14:32 · 2 个有更新",
  );
  assert.equal(
    view.lastCheckDetail(at(new Date(2026, 8, 26, 9, 5)), 0, now),
    "昨天 09:05 · 没有更新",
  );
  assert.equal(view.lastCheckDetail(at(new Date(2026, 8, 20, 8, 0)), null, now), "9月20日 08:00");
  assert.equal(view.clockText(at(new Date(2025, 11, 31, 23, 59)), now), "2025年12月31日 23:59");
  assert.equal(view.lastCheckDetail(null, null, now), "还没有检查过");
});

// ---- store：换假的 core ----

function fakeBackend() {
  const calls: string[] = [];
  let check: UpdateCheck = {
    updates: [pdf, creator, docx],
    checkedAt: 100,
    stripVisible: true,
    fallback: null,
  };
  let checkError: string | null = null;
  let updateResult: InstallOutcome | string = outcome(["skill-creator"]);
  let undoError: string | null = null;
  const backend = {
    async check(force: boolean) {
      calls.push(`check:${force}`);
      if (checkError) throw checkError;
      return check;
    },
    async update(targets: UpdateTarget[], overwrite: boolean) {
      calls.push(`update:${targets.map((t) => t.name).join(",")}:${overwrite}`);
      if (typeof updateResult === "string") throw updateResult;
      return updateResult;
    },
    async undo(id: string) {
      calls.push(`undo:${id}`);
      if (undoError) throw undoError;
      return {};
    },
    async dismiss(shas: string[]) {
      calls.push(`dismiss:${shas.join(",")}`);
    },
  };
  return {
    backend,
    calls,
    setCheck: (c: UpdateCheck) => (check = c),
    failCheck: (e: string | null) => (checkError = e),
    setUpdate: (r: InstallOutcome | string) => (updateResult = r),
    failUndo: (e: string | null) => (undoError = e),
  };
}

test("store：打开 SKILLS 页查一次（force=false）；同一时刻只查一次；结果全应用一份", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  assert.equal(store.get().loaded, false);
  await Promise.all([store.check(false, "auto"), store.check(false, "auto")]);
  assert.deepEqual(f.calls, ["check:false"]);
  const s = store.get();
  assert.equal(s.loaded, true);
  assert.equal(s.updates.length, 3);
  assert.equal(s.checkedAt, 100);
  assert.equal(s.stripVisible, true);
  assert.equal(s.checking, null);
});

test("store：自动检查失败或被限流一句不说；`立即检查` 被限流在按下处说、不重试", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  f.failCheck("GitHub 暂时限流，稍后再试");
  await store.check(false, "auto");
  assert.equal(store.get().notice, null);
  await store.check(true, "settings");
  assert.equal(store.get().notice?.trigger, "settings");
  assert.equal(store.get().notice?.text, "GitHub 暂时限流，稍后再试");
  assert.deepEqual(f.calls, ["check:false", "check:true"], "不自动重试");
  // 降级结果（带 fallback）：列表照样换成缓存，按下处说一句
  f.failCheck(null);
  f.setCheck({
    updates: [pdf],
    checkedAt: 50,
    stripVisible: true,
    fallback: { service: "GitHub", cachedAt: 50, rateLimited: true },
  });
  await store.check(true, "settings");
  assert.equal(store.get().updates.length, 1);
  assert.equal(store.get().notice?.text, "GitHub 暂时限流，稍后再试");
});

test("store：× 记下全部新版本的 tree SHA，提示条收起", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  await store.check(false, "auto");
  await store.dismiss();
  assert.equal(store.get().stripVisible, false);
  assert.equal(f.calls.at(-1), "dismiss:r-docx,r-pdf,r-skill-creator");
  // 行上的 `有更新` 仍在：列表不动
  assert.equal(store.get().updates.length, 3);
});

test("store（AC15）：都没改过直接更新、不确认；纸窗带撤销；撤销放回、文件变了通知页面", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  let rescans = 0;
  store.onFilesChanged(() => rescans++);
  await store.check(false, "auto");
  await store.request([creator], rowTrigger(creator));
  assert.equal(store.get().confirm, null);
  assert.equal(f.calls.at(-1), "update:skill-creator:false");
  assert.deepEqual(
    store.get().updates.map((u) => u.name),
    ["pdf", "docx"],
  );
  assert.equal(store.get().result?.undoId, "u1");
  assert.equal(store.get().result?.toast.sentence, "market.toast.updateDone");
  assert.equal(rescans, 1);
  await store.undo();
  assert.equal(f.calls.at(-1), "undo:u1");
  assert.equal(store.get().result, null);
  assert.deepEqual(
    store
      .get()
      .updates.map((u) => u.name)
      .sort(),
    ["docx", "pdf", "skill-creator"],
  );
  assert.equal(rescans, 2);
});

test("store：纸窗收起之后 ⌘Z 照旧撤得了最近这一次更新；撤过就不能再撤", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  await store.check(false, "auto");
  await store.request([creator], rowTrigger(creator));
  store.clearResult();
  assert.equal(store.get().result, null);
  assert.equal(store.get().lastUndoId, "u1");
  await store.undo();
  assert.equal(f.calls.at(-1), "undo:u1");
  assert.equal(store.get().lastUndoId, null);
  const before = f.calls.length;
  await store.undo();
  assert.equal(f.calls.length, before, "撤过的不再撤");
});

test("store（AC15）：有本地改过的先确认；取消什么都不动；确认后才传 overwriteModified", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  await store.check(false, "auto");
  await store.request([pdf, creator], "strip");
  assert.deepEqual(store.get().confirm?.targets, [pdf, creator]);
  assert.equal(store.get().confirm?.trigger, "strip");
  store.cancel();
  assert.equal(store.get().confirm, null);
  assert.ok(!f.calls.some((c) => c.startsWith("update:")), "取消则文件不变");
  f.setUpdate(outcome(["pdf", "skill-creator"]));
  await store.request([pdf, creator], "strip");
  await store.confirm();
  assert.equal(f.calls.at(-1), "update:pdf,skill-creator:true");
  assert.equal(store.get().result?.toast.count, 2);
  assert.equal(store.get().stripVisible, true, "当前还剩 docx");
});

test("store：更新被限流在按下的那一处说（提示条 / 抽屉那一行），不重试；更新完最后一个提示条收起", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  await store.check(false, "auto");
  f.setUpdate("GitHub 暂时限流，稍后再试");
  await store.request([creator], "strip");
  assert.equal(store.get().notice?.trigger, "strip");
  assert.equal(store.get().busy, null);
  assert.equal(f.calls.filter((c) => c.startsWith("update:")).length, 1);
  f.setUpdate(outcome(["pdf", "skill-creator", "docx"]));
  await store.request([pdf, creator, docx], "strip");
  await store.confirm();
  assert.equal(store.get().updates.length, 0);
  assert.equal(store.get().stripVisible, false);
});

test("store：撤销没成出一窗 `撤销失败`；页面卸下收起确认框与纸窗", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  await store.check(false, "auto");
  await store.request([creator], "strip");
  f.failUndo("撤销已过期");
  await store.undo();
  assert.equal(store.get().result?.toast.sentence, "market.toast.undoCannot");
  assert.equal(say("market.toast.undoCannot"), "撤销失败");
  assert.equal(store.get().result?.undoId, null);
  store.clearTransient();
  assert.equal(store.get().result, null);
});

// ---- 渲染 ----

test("灰面板的一次性说明用法：句子与 × 之间两颗紧凑默认键；在等的那颗只锁它自己；键带公开钩子 data-hint-action", () => {
  const html = render(NoticePanel, {
    scope: "section",
    mark: false,
    open: true,
    onClose: () => {},
    message: "2 个 skill 有新版本",
    action: { label: "只看这些", onClick: () => {} },
    secondary: { label: "全部更新", onClick: () => {}, busy: "正在更新" },
  });
  assert.match(
    html,
    /ss-noticepanel__message">2 个 skill 有新版本<\/span><span class="ss-noticepanel__actions"><span class="ss-noticepanel__key" data-hint-action="只看这些">/,
  );
  assert.match(html, /ss-btn ss-btn--compact"[^>]*>只看这些<\/button>/);
  // 在等的那颗：门槛前锁住、外观不变（另一颗照常）
  assert.match(
    html,
    /data-hint-action="全部更新"><span class="ss-locked" aria-busy="true">(<span[^>]*>)?<button[^>]*>全部更新<\/button>/,
  );
  assert.doesNotMatch(html, /data-hint-action="只看这些"><span class="ss-locked"/);
  assert.doesNotMatch(html, /ss-btn--primary/, "不是墨键");
  // 没有 ! 的 × 默认是新手提示的「知道了，不再提示」
  assert.match(html, /title="知道了，不再提示"/);
  const css = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
  assert.match(css, /\.ss-noticepanel__actions \{[^}]*gap: var\(--space-xs\)/);
});

test("提示条：`2 个 skill 有新版本` · `只看这些` · `全部更新` · ×（这一批不再提示）；只看这些后换 `显示全部`", () => {
  const props = {
    open: true,
    count: 2,
    onlyThese: false,
    onToggleOnly: () => {},
    onUpdateAll: () => {},
    onDismiss: () => {},
  };
  const html = render(UpdateStrip, props);
  assert.match(html, /2 个 skill 有新版本/);
  assert.match(html, />只看这些<\/button>/);
  assert.match(html, />全部更新<\/button>/);
  assert.match(html, /title="这一批不再提示"/);
  assert.doesNotMatch(
    html,
    /<div class="update-strip/,
    "不另包一层（宿主的 :has(> [data-hint]) 要认得到）",
  );
  assert.match(render(UpdateStrip, { ...props, onlyThese: true }), />显示全部<\/button>/);
  assert.equal(render(UpdateStrip, { ...props, open: false }), "");
});

test("行记号：灰字 `有更新`，不是键；没有新版本不挂", () => {
  const html = render(UpdateMark, {});
  assert.equal(html, '<span class="update-mark">有更新</span>');
  assert.equal(updateMark(undefined), undefined);
  const css = readFileSync(new URL("../src/market/Update.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.update-mark \{[^}]*font-size: var\(--size-label\)[^}]*color: var\(--ink-mute\)/,
  );
});

test("抽屉末行：来自 + 仓库 · 有新版本 + `更新`（默认键紧凑）+ `看改动 ↗`（浅键）", () => {
  const html = render(UpdateDrawerLine, { info: pdf, onUpdate: () => {} });
  assert.match(html, /来自 anthropics\/skills<span class="update-line__sep">·<\/span>有新版本/);
  assert.match(
    html,
    /class="ss-btn ss-btn--compact"[^>]*aria-label="更新 pdf"[^>]*>更新<\/button>/,
  );
  assert.match(
    html,
    /class="ss-btn ss-btn--quiet"[^>]*title="https:\/\/github.com\/anthropics\/skills\/commits\/main\/skills\/pdf"[^>]*>看改动/,
  );
});

test("确认框：正中、标题一问、正文说哪个改过、改过的文件清单等宽、墨键 `全部更新`", () => {
  const html = render(UpdateConfirm, {
    targets: [pdf, creator],
    onConfirm: () => {},
    onCancel: () => {},
  });
  assert.match(html, /ss-confirm-veil--full/);
  assert.match(html, /更新 2 个 skill？/);
  assert.match(html, /pdf 里有 2 个文件你改过，更新会覆盖这些改动；skill-creator 没改过。/);
  assert.match(
    html,
    /<ul class="update-confirm__files"[^>]*><li><span class="ss-mono ss-selectable ss-mono--inherit">SKILL.md<\/span>/,
  );
  assert.match(html, />取消<\/button>.*ss-btn--primary[^>]*>全部更新<\/button>/s);
  const css = readFileSync(new URL("../src/market/Update.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.update-confirm__files \{[^}]*background: var\(--recess\)[^}]*font-family: var\(--font-mono\)/,
  );
});

test("纸窗：`✓ 已更新 2 个 skill` + 撤销", () => {
  const html = render(UpdateResultToast, {
    toast: view.updatedToast(outcome(["pdf", "skill-creator"])),
    onUndo: () => {},
    onDismiss: () => {},
  });
  assert.match(html, /ss-toast--routine/);
  assert.match(html, /已更新<\/span>.*2<\/span> 个 skill/s);
  assert.match(html, />撤销<\/button>/);
});

test("设置 `skill 更新` 一节：两行设置行——自动检查｜开关；上次检查｜`去看看` + `立即检查`（不进设置就查）", () => {
  const src = withCopy(
    readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
  );
  assert.match(src, /<SectionLabel>skill 更新<\/SectionLabel>/);
  // 第一行：名字与灰字在左，开关在右（2026-10-04 画板 B）
  assert.match(
    src,
    /<SettingRow\s+label="自动检查 skill 更新"\s+note="打开 Skills 页、距上次超过 6 小时时查一次"\s*>\s*\{autoCheck === null \? null : \(\s*<Switch[\s\S]*?label="自动检查 skill 更新"[\s\S]*?<\/SettingRow>/,
  );
  // 第二行：`上次检查` + 时刻与结果，右端 `去看看`（查到了才出）在 `立即检查` 前
  const second = src.slice(src.indexOf('<SettingRow label="上次检查"'));
  assert.match(second, /^<SettingRow label="上次检查" note=\{lastCheckLine\}>/);
  assert.ok(second.indexOf("去看看") < second.indexOf("立即检查"));
  assert.match(second, /<BusySlot busy=\{checkingSkills\} label="正在检查">/);
  assert.match(src, /lastCheckDetail\(/);
  assert.match(src, /useSkillUpdates\(\)/, "设置页不给 active：进设置不查");
  // 一节在 `关于` 之前
  assert.ok(src.indexOf("skill 更新</SectionLabel>") < src.indexOf("关于</SectionLabel>"));
});

test("store：设置里 `立即检查` 是主动要看——关掉过的这一批重新提示并清掉记录；自动检查照 core 的", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  f.setCheck({ updates: [pdf], checkedAt: 200, stripVisible: false, fallback: null });
  await store.check(false, "auto");
  assert.equal(store.get().stripVisible, false, "自动检查：× 掉过的不再提");
  await store.check(true, "settings");
  assert.equal(store.get().stripVisible, true, "立即检查：重新提示");
  assert.ok(f.calls.includes("dismiss:"), "关掉的记录清掉");
  f.setCheck({ updates: [], checkedAt: 300, stripVisible: false, fallback: null });
  await store.check(true, "settings");
  assert.equal(store.get().stripVisible, false, "没有更新就不提示");
});

test("store：设置的 `去看看` 请 SKILLS 页打开 只看这些，接一次就清掉", async () => {
  const f = fakeBackend();
  const store = createUpdateStore(f.backend);
  await store.check(false, "auto");
  assert.equal(store.takeOnlyThese(), false);
  store.askOnlyThese();
  assert.equal(store.get().wantOnlyThese, true);
  assert.equal(store.get().stripVisible, true);
  assert.equal(store.takeOnlyThese(), true);
  assert.equal(store.takeOnlyThese(), false);
});

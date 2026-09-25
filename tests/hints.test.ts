/// 新手提示的规则与提示条（DESIGN「组件 › 新手提示条 HintStrip」；src/hints.ts、src/ui/HintStrip.tsx）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "./ui-render.ts";

const {
  HINTS,
  HINT_ORDER,
  createHintStore,
  dismissIds,
  learnIds,
  pickHint,
  shouldYield,
  wantsHint,
} = await import("../src/hints.ts");
const { HintStrip } = await import("../src/ui/HintStrip.tsx");

/// 假的 core：记下每次调用；list / mark 的结果可控
function fakePersist(initial: string[] = []) {
  const calls: string[] = [];
  let stored = [...initial];
  let failList = false;
  let failMark = false;
  const persist = {
    async list() {
      calls.push("list");
      if (failList) throw new Error("读不到");
      return [...stored];
    },
    async mark(id: string) {
      calls.push(`mark:${id}`);
      if (failMark) throw new Error("写不进");
      if (!stored.includes(id)) stored.push(id);
    },
  };
  return {
    persist,
    calls,
    stored: () => stored,
    failList: (v: boolean) => (failList = v),
    failMark: (v: boolean) => (failMark = v),
  };
}

/// 让挂起的 promise 回调都跑完
const flush = () => new Promise((r) => setTimeout(r, 0));

async function loadedStore(initial: string[] = []) {
  const f = fakePersist(initial);
  const store = createHintStore(f.persist);
  await store.load();
  return { store, ...f };
}

// ---- 登记表 ----

const EXAMPLE = { agents: ["Claude Code", "Codex", "OpenCode"], skills: 31 };

test("登记表三条，句子（用 DESIGN 表头的例子数据）与 DESIGN 表逐字一致", () => {
  const design = readFileSync(new URL("../docs/DESIGN.md", import.meta.url), "utf8");
  assert.deepEqual(Object.keys(HINTS).sort(), [...HINT_ORDER].sort());
  assert.equal(HINT_ORDER.length, 3);
  for (const id of HINT_ORDER) {
    const row = design.split("\n").find((l) => l.startsWith(`| \`${id}\` |`));
    assert.ok(row, `DESIGN 表里没有 ${id}`);
    const cells = row.split("|").map((c) => c.trim());
    // | id | 位置 | 何时出 | 说明句 | 做了就算学会 |
    assert.equal(cells[4], `\`${HINTS[id](EXAMPLE)}\``, id);
  }
});

test("句子一行、只说结果：扫描说读了哪些目录、找到几个、没有改动文件；不复述界面、不讲机制、不写小标", () => {
  const scan = HINTS["first-scan-skills"](EXAMPLE);
  assert.equal(
    scan,
    "读了 Claude Code、Codex、OpenCode 的 skill 目录，找到 31 个 skill，没有改动任何文件。",
  );
  assert.doesNotMatch(scan, /一行一个|一列一个|第一次用|链接|原件/);
  assert.equal(
    HINTS["first-scan-empty"]({ agents: [], skills: 0 }),
    "读了本机的 skill 目录，没有找到 skill，没有改动任何文件。",
  );
  // Codex：只说结果；配置文件路径挪到开关的提示框（models-view 测试）
  assert.equal(
    HINTS["first-codex"](EXAMPLE),
    "打开后会在 Codex 的配置里加两行，关掉就原样删掉；改了要重启 Codex 才生效。",
  );
  assert.doesNotMatch(HINTS["first-codex"](EXAMPLE), /config\.toml|Sophia/);
});

test("登记表顺序：首次扫描两条在前，Codex 页在后", () => {
  assert.deepEqual(HINT_ORDER, ["first-scan-skills", "first-scan-empty", "first-codex"]);
});

// ---- 纯规则 ----

test("× 关掉首次扫描任一条＝两条都记看过；关掉 Codex 那条只记自己", () => {
  assert.deepEqual(dismissIds("first-scan-skills").sort(), [
    "first-scan-empty",
    "first-scan-skills",
  ]);
  assert.deepEqual(dismissIds("first-scan-empty").sort(), [
    "first-scan-empty",
    "first-scan-skills",
  ]);
  assert.deepEqual(dismissIds("first-codex"), ["first-codex"]);
});

test("学会只记它自己", () => {
  for (const id of HINT_ORDER) assert.deepEqual(learnIds(id), [id]);
});

test("看过表没读到时一条都不出", () => {
  assert.equal(pickHint(["first-codex"], null), null);
});

test("一次只出一条：几条同时有资格按登记表顺序取第一条", () => {
  const none = new Set<string>();
  assert.equal(pickHint(["first-codex", "first-scan-empty"], none), "first-scan-empty");
  assert.equal(pickHint(["first-codex", "first-scan-skills"], none), "first-scan-skills");
  assert.equal(pickHint([], none), null);
});

test("看过的跳过，轮到下一条", () => {
  const seen = new Set<string>(["first-scan-empty"]);
  assert.equal(pickHint(["first-scan-empty", "first-codex"], seen), "first-codex");
  assert.equal(pickHint(["first-scan-empty"], seen), null);
});

test("让位：本该出却有灰面板 / 确认时让位；没资格、没读到、已看过都谈不上让位", () => {
  const base = { eligible: true, blocked: true, loaded: true, seen: false };
  assert.equal(shouldYield(base), true);
  assert.equal(shouldYield({ ...base, blocked: false }), false);
  assert.equal(shouldYield({ ...base, eligible: false }), false);
  assert.equal(shouldYield({ ...base, loaded: false }), false);
  assert.equal(shouldYield({ ...base, seen: true }), false);
});

test("争不争：有资格、没被挡、这次没让过位、没看过才争", () => {
  const base = { eligible: true, blocked: false, yielded: false, seen: false };
  assert.equal(wantsHint(base), true);
  assert.equal(wantsHint({ ...base, eligible: false }), false);
  assert.equal(wantsHint({ ...base, blocked: true }), false);
  // 让过位的：挡它的东西没了也不再出，等下次到访
  assert.equal(wantsHint({ ...base, yielded: true }), false);
  assert.equal(wantsHint({ ...base, seen: true }), false);
});

// ---- store ----

test("读到看过表之前不出；读到后有资格的那条出", async () => {
  const f = fakePersist();
  const store = createHintStore(f.persist);
  store.claim("first-codex");
  assert.equal(store.getSnapshot().visible, null);
  assert.equal(store.getSnapshot().loaded, false);
  await store.load();
  assert.equal(store.getSnapshot().visible, "first-codex");
});

test("看过表只读一次", async () => {
  const f = fakePersist();
  const store = createHintStore(f.persist);
  await Promise.all([store.load(), store.load()]);
  await store.load();
  assert.deepEqual(f.calls, ["list"]);
});

test("读失败：安静不出，下次再读", async () => {
  const f = fakePersist();
  f.failList(true);
  const store = createHintStore(f.persist);
  store.claim("first-codex");
  const orig = console.error;
  console.error = () => {};
  try {
    await store.load();
  } finally {
    console.error = orig;
  }
  assert.equal(store.getSnapshot().loaded, false);
  assert.equal(store.getSnapshot().visible, null);
  f.failList(false);
  await store.load();
  assert.equal(store.getSnapshot().visible, "first-codex");
  assert.deepEqual(f.calls, ["list", "list"]);
});

test("core 里已看过的不出；空串忽略", async () => {
  const { store } = await loadedStore(["first-codex", ""]);
  store.claim("first-codex");
  assert.equal(store.getSnapshot().visible, null);
  assert.deepEqual([...store.getSnapshot().seen], ["first-codex"]);
});

test("整个应用同一时刻最多一条：撤回排在前面的，后面的接上", async () => {
  const { store } = await loadedStore();
  const releaseEmpty = store.claim("first-scan-empty");
  store.claim("first-codex");
  assert.equal(store.getSnapshot().visible, "first-scan-empty");
  releaseEmpty();
  assert.equal(store.getSnapshot().visible, "first-codex");
});

test("× 关掉首次扫描那条：两条都记看过、都写进 core，收起", async () => {
  const { store, calls, stored } = await loadedStore();
  store.claim("first-scan-empty");
  store.dismiss("first-scan-empty");
  assert.equal(store.getSnapshot().visible, null);
  await flush();
  assert.deepEqual(stored().sort(), ["first-scan-empty", "first-scan-skills"]);
  assert.deepEqual(calls.slice(1).sort(), ["mark:first-scan-empty", "mark:first-scan-skills"]);
  // 之后表里有了 skill，教点格子那条也不出
  store.claim("first-scan-skills");
  assert.equal(store.getSnapshot().visible, null);
});

test("学会空库那条只记它自己：加了来源、表里有了 skill，教点格子那条还会出一次", async () => {
  const { store, stored } = await loadedStore();
  const release = store.claim("first-scan-empty");
  store.learn("first-scan-empty");
  assert.equal(store.getSnapshot().visible, null);
  release();
  store.claim("first-scan-skills");
  assert.equal(store.getSnapshot().visible, "first-scan-skills");
  await flush();
  assert.deepEqual(stored(), ["first-scan-empty"]);
});

test("关掉 Codex 那条只记它自己", async () => {
  const { store, stored } = await loadedStore();
  store.claim("first-codex");
  store.dismiss("first-codex");
  assert.equal(store.getSnapshot().visible, null);
  await flush();
  assert.deepEqual(stored(), ["first-codex"]);
});

test("学会可以反复调：已看过就不再写 core", async () => {
  const { store, calls } = await loadedStore();
  store.learn("first-scan-skills");
  store.learn("first-scan-skills");
  store.learn("first-scan-skills");
  await flush();
  assert.deepEqual(calls, ["list", "mark:first-scan-skills"]);
});

test("乐观更新：写 core 还没回来就已收起；写失败也不回滚", async () => {
  const { store, failMark } = await loadedStore();
  failMark(true);
  const orig = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => logged.push(a);
  try {
    store.claim("first-codex");
    store.dismiss("first-codex");
    assert.equal(store.getSnapshot().visible, null);
    await flush();
  } finally {
    console.error = orig;
  }
  assert.equal(store.getSnapshot().visible, null);
  assert.ok(store.getSnapshot().seen.has("first-codex"));
  assert.equal(logged.length, 1);
});

test("还没读到就关掉：读到后与 core 里的合并，不会又冒出来", async () => {
  const f = fakePersist(["first-codex"]);
  const store = createHintStore(f.persist);
  store.claim("first-scan-skills");
  store.dismiss("first-scan-skills");
  await store.load();
  assert.deepEqual([...store.getSnapshot().seen].sort(), [
    "first-codex",
    "first-scan-empty",
    "first-scan-skills",
  ]);
  assert.equal(store.getSnapshot().visible, null);
});

test("订阅者在出现 / 收起时收到通知", async () => {
  const { store } = await loadedStore();
  let n = 0;
  const off = store.subscribe(() => n++);
  const release = store.claim("first-codex");
  release();
  release(); // 重复撤回不再通知
  off();
  store.claim("first-codex");
  assert.equal(n, 2);
});

// ---- 提示条 ----

const strip = (open: boolean, over: Record<string, unknown> = {}) =>
  render(HintStrip, {
    open,
    onDismiss: () => {},
    children: HINTS["first-scan-skills"](EXAMPLE),
    ...over,
  });

test("提示条：只有说明句 + × 图标键（知道了，不再提示），没有小标", () => {
  const html = strip(true);
  assert.match(html, /class="ss-hint"/);
  assert.match(html, /role="note"/);
  assert.doesNotMatch(html, /ss-hint__label|第一次用/);
  assert.match(html, /class="ss-hint__text">读了 Claude Code、Codex、OpenCode 的 skill 目录/);
  assert.match(
    html,
    /class="ss-iconbtn"[^>]*title="知道了，不再提示"[^>]*aria-label="知道了，不再提示"/,
  );
  // 只有 ×，没有动作键、没有 ! 记号（与灰面板分开）
  assert.doesNotMatch(html, /ss-btn\b|ss-noticepanel/);
});

test("提示条：挂上时是收起态，展开由下一帧加 is-open（过渡才有起点）", () => {
  assert.doesNotMatch(strip(true), /is-open/);
});

test("提示条：open=false 挂上时什么都不画", () => {
  assert.equal(strip(false), "");
});

test("提示条样式：shell 底、face 12 圆角、无边无投影、高 40 内边距 10 14、上下 16、260ms ease-mech、减少动效即时", () => {
  const css = readFileSync(new URL("../src/ui/HintStrip.css", import.meta.url), "utf8");
  const block = (sel: string) => {
    const m = css.match(new RegExp(`\\n${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`));
    assert.ok(m, `缺 ${sel}`);
    return m[1];
  };
  const bar = block(".ss-hint__bar");
  assert.match(bar, /background: var\(--shell\)/);
  assert.match(bar, /border-radius: var\(--radius-face\)/);
  assert.match(bar, /min-height: 40px/);
  assert.match(bar, /padding: 10px 14px/);
  assert.doesNotMatch(css, /box-shadow|border:/);
  assert.match(block(".ss-hint.is-open"), /margin-block: var\(--space-md\)/);
  assert.match(block(".ss-hint"), /grid-template-rows 260ms var\(--ease-mech\)/);
  assert.match(block(".ss-hint"), /opacity 260ms var\(--ease-mech\)/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.ss-hint \{\s*transition: none;/);
  assert.match(block(".ss-hint__text"), /font-size: var\(--size-caption\)/);
  assert.match(block(".ss-hint__text"), /color: var\(--ink\);/);
});

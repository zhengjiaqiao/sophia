/// 新手提示的规则与提示条（DESIGN-components「灰面板 NoticePanel › 一次性说明的用法」；src/hints.ts、src/ui/NoticePanel.tsx）
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
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
const { NoticePanel, hintStackOf, useHintStack } = await import("../src/ui/NoticePanel.tsx");

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

// 设计规范只在开发仓库里；公开仓库只有代码，没有它就跳过这一条
const DESIGN_URL = new URL("../docs/DESIGN.md", import.meta.url);

test(
  "登记表四条，句子（用 DESIGN 表头的例子数据）与 DESIGN 表逐字一致",
  { skip: !existsSync(DESIGN_URL) && "没有 docs/DESIGN.md（公开仓库）" },
  () => {
    const design = readFileSync(DESIGN_URL, "utf8");
    assert.deepEqual(Object.keys(HINTS).sort(), [...HINT_ORDER].sort());
    assert.equal(HINT_ORDER.length, 4);
    for (const id of HINT_ORDER) {
      const row = design.split("\n").find((l) => l.startsWith(`| \`${id}\` |`));
      assert.ok(row, `DESIGN 表里没有 ${id}`);
      const cells = row.split("|").map((c) => c.trim());
      // | id | 位置 | 何时出 | 说明句 | 做了就算学会 |
      assert.equal(cells[4], `\`${HINTS[id](EXAMPLE)}\``, id);
    }
  },
);

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
    "打开后会改一处 Codex 的设置，让它能用第三方模型；关掉就恢复原样。改完要重启 Codex 才生效。",
  );
  assert.doesNotMatch(HINTS["first-codex"](EXAMPLE), /config\.toml|Sophia/);
});

test("登记表顺序：首次扫描两条在前，Codex 页、MCP 页的 OpenCode 说明在后", () => {
  assert.deepEqual(HINT_ORDER, [
    "first-scan-skills",
    "first-scan-empty",
    "first-codex",
    "mcp-opencode",
  ]);
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

test("学会只记它自己；空库那条（加来源）两条首次扫描都记", () => {
  for (const id of HINT_ORDER)
    assert.deepEqual(
      learnIds(id),
      id === "first-scan-empty" ? ["first-scan-skills", "first-scan-empty"] : [id],
    );
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

test("学会空库那条（加了来源）两条首次扫描都记：表里有了 skill，教点格子那条也不出（2026-09-30）", async () => {
  const { store, stored } = await loadedStore();
  const release = store.claim("first-scan-empty");
  store.learn("first-scan-empty");
  assert.equal(store.getSnapshot().visible, null);
  release();
  store.claim("first-scan-skills");
  assert.equal(store.getSnapshot().visible, null);
  await flush();
  assert.deepEqual(stored().sort(), ["first-scan-empty", "first-scan-skills"]);
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

// 2026-10-04：新手提示条并进灰面板——没有 `!`、能关、能进出的那种用法（`mark={false}` + `onClose` + `open`）
const strip = (open: boolean, over: Record<string, unknown> = {}) =>
  render(NoticePanel, {
    scope: "section",
    mark: false,
    open,
    onClose: () => {},
    message: HINTS["first-scan-skills"](EXAMPLE),
    ...over,
  });

test("提示条：只有说明句 + × 图标键（知道了，不再提示），没有小标、没有 !", () => {
  const html = strip(true);
  assert.match(html, /class="ss-noticepanel-slide"/);
  assert.match(
    html,
    /class="ss-noticepanel ss-noticepanel--section" role="note" aria-label="提示"/,
  );
  assert.doesNotMatch(html, /第一次用/);
  assert.match(
    html,
    /class="ss-noticepanel__message">读了 Claude Code、Codex、OpenCode 的 skill 目录/,
  );
  assert.match(
    html,
    /class="ss-iconbtn"[^>]*aria-label="知道了，不再提示"[^]*role="tooltip"[^>]*>知道了，不再提示</,
  );
  // 只有 ×，没有动作键、没有 ! 记号（意思靠两端分：没有 ! ＝一次性说明）
  assert.doesNotMatch(html, /ss-btn\b|ss-noticepanel__mark/);
});

test("提示条：挂上时是收起态，展开由下一帧加 is-open（过渡才有起点）", () => {
  assert.doesNotMatch(strip(true), /is-open/);
});

test("提示条：open=false 挂上时什么都不画", () => {
  assert.equal(strip(false), "");
});

const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const block = (sel: string) => {
  const m = uiCss.match(new RegExp(`\\n${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`));
  assert.ok(m, `缺 ${sel}`);
  return m[1];
};

test("提示条样式：就是灰面板——surface 底、face 12 圆角、无边无投影、最矮 40 内边距 8 12、13 号 ink；上下 16、260ms ease-mech、减少动效即时", () => {
  const panel = block(".ss-noticepanel");
  assert.match(panel, /background: var\(--surface\)/);
  assert.match(panel, /border-radius: var\(--radius-face\)/);
  assert.match(panel, /min-height: 40px/);
  assert.match(panel, /padding: var\(--space-xs\) var\(--space-sm\)/);
  assert.match(panel, /font-size: var\(--size-caption\)/);
  assert.match(panel, /color: var\(--ink\);/);
  assert.doesNotMatch(panel, /box-shadow|border:/);
  assert.match(block(".ss-noticepanel-slide.is-open"), /margin-block: var\(--space-md\)/);
  // 260ms 只在 tokens.css 写一次（--dur-drawer），组件的 CSS 与 JS 都从那里取
  const slide = block(".ss-noticepanel-slide");
  assert.match(slide, /grid-template-rows var\(--dur-drawer\) var\(--ease-mech\)/);
  assert.match(slide, /opacity var\(--dur-drawer\) var\(--ease-mech\)/);
  assert.doesNotMatch(slide, /\b260ms\b/);
  const reduced = uiCss.slice(uiCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.ss-noticepanel-slide \{\s*transition: none;/);
  // 新手提示条的另一套样式已删
  assert.equal(existsSync(new URL("../src/ui/HintStrip.css", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/ui/HintStrip.tsx", import.meta.url)), false);
  assert.doesNotMatch(uiCss, /\.ss-hint\b/);
});

// ---- 几张提示条叠放（2026-09-30 产品负责人：「如果有多个的时候，我希望叠放在上面，用户处理完一个再处理下一个，
// 注意不要把底下的漏出来」）----

test("叠放：几张同时想出时只展开登记顺序里的第一张，其余算压在下面的张数", () => {
  assert.deepEqual(
    hintStackOf([
      { key: "update", want: true },
      { key: "first-scan", want: true },
    ]),
    { top: "update", below: 1 },
  );
  assert.deepEqual(
    hintStackOf([
      { key: "update", want: false },
      { key: "first-scan", want: true },
    ]),
    { top: "first-scan", below: 0 },
    "上面那张处理完，下一张上来",
  );
  assert.deepEqual(hintStackOf([{ key: "update", want: false }]), { top: null, below: 0 });
});

test("叠放：压着别的提示条时，条下露出一两道没有内容的薄边（不露底下那张的字）；没压着时没有", () => {
  const one = strip(true, { stacked: 1 });
  assert.equal(one.match(/class="ss-noticepanel-slide__peek"/g)?.length, 1);
  const many = strip(true, { stacked: 3 });
  assert.equal(many.match(/class="ss-noticepanel-slide__peek"/g)?.length, 2, "至多画两道");
  assert.doesNotMatch(strip(true), /ss-noticepanel-slide__peek/);
  assert.match(block(".ss-noticepanel-slide__peek"), /height: 4px;/);
});

// ---- 叠放换张的时序：在内存里驱动 effect（不起浏览器）----

type Hook<P, R> = (props: P) => R;

/// 最小的 hooks 运行器：只实现 useState / useEffect，换掉 React 的当前 dispatcher 调一次 hook，
/// 渲染完按依赖跑 effect；effect 或定时器里 setState 之后由 `flush` 重渲染，直到稳定
function driveHook<P, R>(hook: Hook<P, R>, initial: P) {
  const internals = (React as unknown as Record<string, { H: unknown }>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const states: unknown[] = [];
  const effects: { deps?: unknown[]; cleanup?: () => void }[] = [];
  let props = initial;
  let result!: R;
  let dirty = false;
  const renderOnce = () => {
    let si = 0;
    let ei = 0;
    const pending: (() => void)[] = [];
    const dispatcher = {
      useState(init: unknown) {
        const i = si++;
        if (!(i in states))
          states[i] = typeof init === "function" ? (init as () => unknown)() : init;
        const set = (v: unknown) => {
          const nv = typeof v === "function" ? (v as (p: unknown) => unknown)(states[i]) : v;
          if (!Object.is(nv, states[i])) {
            states[i] = nv;
            dirty = true;
          }
        };
        return [states[i], set];
      },
      useEffect(fn: () => void | (() => void), deps?: unknown[]) {
        const i = ei++;
        const prev = effects[i];
        const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps?.[k]));
        if (!changed) return;
        pending.push(() => {
          prev?.cleanup?.();
          const cleanup = fn();
          effects[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
        });
      },
    };
    const saved = internals.H;
    internals.H = dispatcher;
    try {
      result = hook(props);
    } finally {
      internals.H = saved;
    }
    for (const run of pending) run();
  };
  const flush = () => {
    for (let n = 0; n < 50; n++) {
      dirty = false;
      renderOnce();
      if (!dirty) return result;
    }
    throw new Error("没有稳定下来");
  };
  flush();
  return {
    get: () => result,
    rerender(next: P) {
      props = next;
      return flush();
    },
    flush,
  };
}

/// 文档里的 `--dur-drawer`：减少动效时 tokens.css 把它置 0
function withDrawer<T>(ms: number, run: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, getComputedStyle: g.getComputedStyle };
  g.window = globalThis;
  g.document = { documentElement: {} };
  g.getComputedStyle = () => ({ getPropertyValue: () => `${ms}ms` });
  try {
    return run();
  } finally {
    Object.assign(g, saved);
  }
}

const want = (update: boolean, scan: boolean) => [
  { key: "update", want: update },
  { key: "first-scan", want: scan },
];

test("叠放换张：上面那张关掉后先收起（260ms），收完才展开下一张；两张不同时半开", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withDrawer(260, () => {
    const h = driveHook(useHintStack, want(true, true));
    assert.deepEqual(h.get(), { top: "update", below: 1 });
    // 关掉「有新版本」：这一刻谁都不展开（上一张在收）
    assert.deepEqual(h.rerender(want(false, true)), { top: null, below: 0 });
    t.mock.timers.tick(259);
    assert.deepEqual(h.flush(), { top: null, below: 0 }, "没收完不展开下一张");
    t.mock.timers.tick(1);
    assert.deepEqual(h.flush(), { top: "first-scan", below: 0 });
  });
});

test("叠放换张：本来什么都没开时，想出的那张当即展开；减少动效时收起是即时的，下一张也当即展开", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withDrawer(260, () => {
    const h = driveHook(useHintStack, want(false, false));
    assert.deepEqual(h.get(), { top: null, below: 0 });
    assert.deepEqual(h.rerender(want(false, true)), { top: "first-scan", below: 0 });
  });
  withDrawer(0, () => {
    const h = driveHook(useHintStack, want(true, true));
    assert.deepEqual(h.rerender(want(false, true)), { top: "first-scan", below: 0 });
  });
});

/// 网页兜底（spec 2026-10-04-local-diagnostics R7 / R13，AC5 / AC6 / AC12）：
/// `Details` 的展开与复制、`PageFault` 出错页的样子、诊断模块的纯逻辑。
/// 服务端渲染不走错误边界，所以出错页拆成纯展示的 `FaultView` 来断言，边界本身只验证它的两个钩子。
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";

const noop = () => {};
const { Details, DetailsBody } = await import("../src/ui/Details.tsx");
const { PageFault, FaultView, faultDetails, faultHeadline } =
  await import("../src/ui/PageFault.tsx");
const { cycleFocus } = await import("../src/ui/FloatingLayer.tsx");
const diagnostics = await import("../src/diagnostics.ts");
const { errorText } = await import("../src/errorText.ts");
import { readFileSync } from "node:fs";
const uiCss = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = uiCss.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m[1];
};

// ===== Details =====
// 2026-10-04 产品负责人：长条提示里不再有展开按钮——`详情` 是一颗紧凑默认键，点开是锚在键上的浮层
// （FloatingLayer：paper、hairline、12 圆角、浮层投影，点外面 / Esc 关），里面是去隐私后的原文 + `复制详情`

test("Details：一颗紧凑默认键 `详情`，说明它弹出浮层（aria-haspopup=dialog、aria-expanded=false）；原文不在行里", () => {
  const html = render(Details, { text: "boom", onCopy: noop });
  assert.match(
    html,
    /<button[^>]*class="ss-btn ss-btn--compact"[^>]*aria-expanded="false"[^>]*>详情<\/button>/,
  );
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /boom/);
  assert.doesNotMatch(html, /复制详情/);
  // 不再有可展开的那一套（小箭头、行内原文框）
  assert.doesNotMatch(html, /ss-details__toggle|ss-details__chevron/);
});

test("Details：size=regular 给出错页（与 `重新加载` 同高的默认键）", () => {
  const html = render(Details, { text: "boom", onCopy: noop, size: "regular" });
  assert.match(html, /<button[^>]*class="ss-btn"[^>]*>详情<\/button>/);
});

test("DetailsBody（浮层里）：原文进等宽块（转义、可选中），下面右对齐一颗 `复制详情`；复制过换成 `已复制`", () => {
  const html = render(DetailsBody, { text: "a <b> & c\nline2", copied: false, onCopy: noop });
  assert.match(
    html,
    /<pre[^>]*class="ss-details__text ss-selectable"[^>]*>a &lt;b&gt; &amp; c\nline2<\/pre>/,
  );
  assert.match(html, /<button[^>]*class="ss-btn ss-btn--compact"[^>]*>复制详情<\/button>/);
  assert.match(render(DetailsBody, { text: "x", copied: true, onCopy: noop }), />已复制</);
});

test("Details 浮层的量：宽 440（窄窗口里收到窗口边距之内）、内边距 12、等宽 12 ink、复制键右对齐上距 8", () => {
  const layer = rule(".ss-details__layer");
  assert.match(layer, /width:\s*440px/);
  assert.match(layer, /max-width:\s*calc\(100vw - 32px\)/);
  assert.match(layer, /padding:\s*var\(--space-sm\)/);
  const text = rule(".ss-details__text");
  assert.match(text, /font-family:\s*var\(--font-mono\)/);
  assert.match(text, /font-size:\s*var\(--size-label\)/);
  assert.match(text, /color:\s*var\(--ink\)/);
  assert.match(text, /white-space:\s*pre-wrap/);
  assert.match(rule(".ss-details__actions"), /justify-content:\s*flex-end/);
  // 浮层开着时键保持按下（同锁键：surface 面 + raise-pressed），说明这颗键弹出的就是它
  assert.match(rule('.ss-details .ss-btn[aria-expanded="true"]'), /var\(--raise-pressed\)/);
});

// Codex 复审 7/7：键盘用户打开浮层后焦点进到浮层里，Tab 在浮层里转圈，到不了后面的列表（也就不会因滚动关掉）
test("详情浮层的焦点：打开即进（原文），Tab / Shift+Tab 在浮层里转圈；程序放焦点不滚动页面", () => {
  assert.equal(cycleFocus(2, 0, false), 1);
  assert.equal(cycleFocus(2, 1, false), 0);
  assert.equal(cycleFocus(2, 0, true), 1);
  assert.equal(cycleFocus(3, -1, false), 0, "焦点不在浮层里：落到第一项");
  assert.equal(cycleFocus(3, -1, true), 2);
  assert.equal(cycleFocus(0, -1, false), -1);
  const layer = readFileSync(new URL("../src/ui/FloatingLayer.tsx", import.meta.url), "utf8");
  assert.match(layer, /role === "dialog"/);
  assert.match(layer, /focus\(\{ preventScroll: true \}\)/);
});

// ===== PageFault =====

test("faultDetails：错误原文、调用栈、组件栈、版本、本地时间都在，且是纯文本", () => {
  const error = new Error("读不出来");
  error.stack = "Error: 读不出来\n    at Foo (foo.tsx:1:1)";
  const text = faultDetails({
    error,
    componentStack: "\n    at Foo\n    at Bar",
    version: "1.2.3",
    now: new Date(2026, 9, 4, 9, 5, 7),
  });
  assert.match(text, /^Error: 读不出来\n {4}at Foo \(foo\.tsx:1:1\)/);
  assert.match(text, /Component stack:\n\s+at Foo\n\s+at Bar/);
  assert.match(text, /version: 1\.2\.3/);
  assert.match(text, /time: 2026-10-04 09:05:07 [+-]\d{2}:\d{2}/);
});

test("faultDetails：没有 stack 退回 name + message；抛出的不是 Error 也不崩", () => {
  const bare = new Error("x");
  bare.stack = undefined;
  assert.match(faultDetails({ error: bare, version: "1", now: new Date() }), /^Error: x/);
  assert.match(faultDetails({ error: "字符串", version: "1", now: new Date() }), /^字符串/);
  assert.match(faultDetails({ error: null, version: null, now: new Date() }), /version: -/);
});

test("FaultView：标题、一句说明、墨键 `重新加载` 与默认键 `详情` 同一行（详情是弹出的浮层）；不给 onReport 时没有上报键", () => {
  const html = render(FaultView, { details: "boom", onReload: noop, onCopy: noop });
  assert.match(html, /这一页出了问题/);
  assert.match(html, /其他页面照常能用。先重新加载这一页。/);
  assert.match(
    html,
    /<div class="ss-pagefault__keys">(?:<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--primary"[^>]*>重新加载<\/button>(?:<\/span>)?<span class="ss-details">(?:<span[^>]*>)?<button[^>]*class="ss-btn"[^>]*aria-expanded="false"[^>]*>详情<\/button>/,
  );
  assert.doesNotMatch(html, /boom/);
  assert.doesNotMatch(html, /报告|反馈|上报/);
  assert.doesNotMatch(html, /ss-pagefault--narrow/);
  assert.match(html, /role="alert"/);
});

// Codex 复审 7/7：屏幕上的原文与复制的同样去隐私；去隐私做好之前（或没做成）只给错误名与一句
test("faultHeadline：只取错误名与那一句（不带调用栈、路径行）；PageFault 显示去隐私后的原文，没有就只给这一行", () => {
  const error = new Error("读不出 /Users/me/secret");
  error.stack = "Error: 读不出 /Users/me/secret\n    at Foo (/Users/me/app/foo.tsx:1:1)";
  assert.equal(faultHeadline(error), "Error: 读不出 /Users/me/secret");
  assert.equal(faultHeadline("字符串\n第二行"), "字符串");
  const src = readFileSync(new URL("../src/ui/PageFault.tsx", import.meta.url), "utf8");
  assert.match(src, /redacted \?\? faultHeadline\(error\)/);
});

// 应用内反馈（spec 2026-10-04-reporting-feedback R11、AC10）：上报关着（或 DO_NOT_TRACK）且有接收服务时，
// 出错页换一句说法、`重新加载` 之后多一颗 `报告这个问题`；上报开着时照旧（上面那条）
test("FaultView 外壳形态（spec S18）：标题换成「Sophia 出了问题」，只有 `重新加载`，没有 `详情`、没有 `报告这个问题`", () => {
  const html = render(FaultView, {
    details: "boom",
    onReload: noop,
    onCopy: noop,
    shell: true,
    onReport: noop,
  });
  assert.match(html, /Sophia 出了问题/);
  assert.match(html, /重新加载后一般就好了/);
  assert.match(html, /<button[^>]*class="ss-btn ss-btn--primary"[^>]*>重新加载<\/button>/);
  assert.doesNotMatch(html, />详情</);
  assert.doesNotMatch(html, /报告这个问题/);
  assert.doesNotMatch(html, /boom/);
});

test("FaultView 给了 onReport：说法换成「反复出现的话，把问题报告给我们」，键行是 重新加载 · 报告这个问题 · 详情", () => {
  const html = render(FaultView, {
    details: "boom",
    onReload: noop,
    onCopy: noop,
    onReport: noop,
  });
  assert.match(html, /其他页面照常能用。先重新加载这一页；反复出现的话，把问题报告给我们。/);
  assert.match(
    html,
    /<div class="ss-pagefault__keys">(?:<span[^>]*>)?<button[^>]*class="ss-btn ss-btn--primary"[^>]*>重新加载<\/button>(?:<\/span>)?<span class="ss-pagefault__report">(?:<span[^>]*>)?<button[^>]*class="ss-btn"[^>]*>报告这个问题<\/button>(?:<\/span>)?<\/span><span class="ss-details">/,
  );
});

test("FaultView：发出去之后的提示条（reportNote）挂在 `报告这个问题` 那一格里", () => {
  const html = render(FaultView, {
    details: "boom",
    onReload: noop,
    onCopy: noop,
    onReport: noop,
    reportNote: "<<sent>>",
  });
  assert.match(
    html,
    /<span class="ss-pagefault__report">.*>报告这个问题<\/button>(?:<\/span>)?&lt;&lt;sent&gt;&gt;<\/span>/,
  );
});

test("PageFault：`报告这个问题` 只交出去过隐私的详情；还没做好（或没做成）时不带详情，绝不带原文", () => {
  const seen: Array<string | undefined> = [];
  const make = (redacted: string | null) => {
    const boundary = new PageFault({
      onError: noop,
      onCopy: noop,
      onReport: (details?: string) => void seen.push(details),
      children: null,
    });
    boundary.state = {
      failed: true,
      error: new Error("读不出 /Users/me/secret"),
      componentStack: "",
      redacted,
    };
    return boundary.render() as { props: { onReport?: () => void } };
  };
  make("Error: 读不出 …").props.onReport?.();
  make(null).props.onReport?.();
  assert.deepEqual(seen, ["Error: 读不出 …", undefined]);
  // 不给 onReport：出错页没有这颗键
  const plain = new PageFault({ onError: noop, onCopy: noop, children: null });
  plain.state = { failed: true, error: new Error("x"), componentStack: "", redacted: null };
  assert.equal((plain.render() as { props: { onReport?: unknown } }).props.onReport, undefined);
});

test("FaultView：托盘的窄面板形态加 --narrow", () => {
  const html = render(FaultView, { details: "boom", onReload: noop, onCopy: noop, narrow: true });
  assert.match(html, /ss-pagefault ss-pagefault--narrow/);
});

test("PageFault：子树抛错时边界接住（getDerivedStateFromError），没出错时原样渲染子节点", () => {
  const error = new Error("x");
  assert.deepEqual(PageFault.getDerivedStateFromError(error), { failed: true, error });
  const html = render(PageFault, {
    onError: noop,
    onCopy: noop,
    version: "1",
    children: "页面内容",
  });
  assert.equal(html, "页面内容");
});

// ===== diagnostics =====

test("logError：写进日志通道；通道抛错或拒绝都吞掉，不再抛", async () => {
  const seen: string[] = [];
  await diagnostics.logError("a", async (m: string) => void seen.push(m));
  assert.deepEqual(seen, ["a"]);
  await diagnostics.logError("b", () => {
    throw new Error("ipc gone");
  });
  await diagnostics.logError("c", () => Promise.reject(new Error("ipc gone")));
});

test("installGlobalErrorLogging：window 的 error 与 unhandledrejection 各记一条，界面不动；可卸载", () => {
  const target = new EventTarget();
  const lines: string[] = [];
  const off = diagnostics.installGlobalErrorLogging(target, (m: string) => void lines.push(m));
  const err = Object.assign(new Event("error"), {
    message: "x is not a function",
    filename: "http://tauri.localhost/assets/a.js",
    lineno: 3,
    colno: 9,
    error: new Error("x is not a function"),
  });
  target.dispatchEvent(err);
  const rej = Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") });
  target.dispatchEvent(rej);
  const rejStr = Object.assign(new Event("unhandledrejection"), { reason: "纯字符串" });
  target.dispatchEvent(rejStr);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^uncaught error: x is not a function/);
  assert.match(lines[0], /a\.js:3:9/);
  assert.match(lines[1], /^unhandled rejection: Error: nope/);
  assert.match(lines[2], /^unhandled rejection: 纯字符串/);
  // 默认行为不拦：没有 preventDefault
  assert.equal(err.defaultPrevented, false);
  off();
  target.dispatchEvent(Object.assign(new Event("error"), { message: "later" }));
  assert.equal(lines.length, 3);
});

// 自动上报（spec 2026-10-04-reporting-feedback R7）：网页侧的两种异常各记一次次数（只记次数，原文不出本机）
test("installGlobalErrorLogging：每个未捕获的错误与未处理的拒绝各记一次 uncaught", () => {
  const target = new EventTarget();
  const counted: string[] = [];
  const off = diagnostics.installGlobalErrorLogging(
    target,
    () => undefined,
    (kind) => void counted.push(kind),
  );
  target.dispatchEvent(Object.assign(new Event("error"), { message: "m" }));
  target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "r" }));
  assert.deepEqual(counted, ["uncaught", "uncaught"]);
  off();
  target.dispatchEvent(Object.assign(new Event("error"), { message: "later" }));
  assert.equal(counted.length, 2);
});

test("logPageFault：写日志并记一次 pageFault", async () => {
  const lines: string[] = [];
  const counted: string[] = [];
  await diagnostics.logPageFault(
    new Error("boom"),
    "\n    at Page",
    (kind) => void counted.push(kind),
    async (m: string) => void lines.push(m),
  );
  assert.deepEqual(counted, ["pageFault"]);
  assert.match(lines[0], /^page render failed: Error: boom/);
});

test("reportCount：计数通道抛错或拒绝都吞掉（内部版没有这个命令、不在应用里跑）", async () => {
  diagnostics.reportCount("uncaught", undefined, () => {
    throw new Error("no ipc");
  });
  diagnostics.reportCount("pageFault", "x", () => Promise.reject(new Error("unknown command")));
  await new Promise((r) => setTimeout(r, 0));
});

// 自动上报第二段（spec 2026-10-04-reporting-feedback R8）：网页侧的错误连同原文一起交给后端，去隐私在 Rust 侧做
test("logPageFault：交给计数的是写进日志的同一段原文（错误 + 组件栈）", async () => {
  const lines: string[] = [];
  const sent: [string, string | undefined][] = [];
  await diagnostics.logPageFault(
    new Error("boom"),
    "\n    at Page",
    (kind, text) => void sent.push([kind, text]),
    async (m: string) => void lines.push(m),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "pageFault");
  assert.equal(sent[0][1], lines[0]);
  assert.match(sent[0][1] ?? "", /Error: boom[\s\S]*Component stack:\n {4}at Page/);
});

test("installGlobalErrorLogging：未捕获的错误与未处理的拒绝各带上写进日志的那段原文", () => {
  const target = new EventTarget();
  const lines: string[] = [];
  const sent: [string, string | undefined][] = [];
  const off = diagnostics.installGlobalErrorLogging(
    target,
    (m: string) => void lines.push(m),
    (kind, text) => void sent.push([kind, text]),
  );
  target.dispatchEvent(
    Object.assign(new Event("error"), { message: "m", filename: "a.js", lineno: 3, colno: 9 }),
  );
  target.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") }),
  );
  off();
  assert.deepEqual(
    sent.map(([kind]) => kind),
    ["uncaught", "uncaught"],
  );
  assert.deepEqual(
    sent.map(([, text]) => text),
    lines,
  );
  assert.match(sent[0][1] ?? "", /^uncaught error: m \(a\.js:3:9\)/);
  assert.match(sent[1][1] ?? "", /^unhandled rejection: Error: nope/);
});

test("reportCount：原文截到 24 000 个 UTF-16 单元、不留半个代理对，连同类别交给后端；没有原文只交类别", () => {
  const calls: [string, string | undefined][] = [];
  const channel = (kind: string, text?: string) => void calls.push([kind, text]);
  diagnostics.reportCount("pageFault", "a".repeat(30_000), channel);
  diagnostics.reportCount("uncaught", "b".repeat(23_999) + "😀", channel);
  diagnostics.reportCount("uncaught", "short", channel);
  diagnostics.reportCount("uncaught", undefined, channel);
  assert.equal(calls[0][0], "pageFault");
  assert.equal(calls[0][1]?.length, 24_000);
  assert.equal(calls[1][1], "b".repeat(23_999));
  assert.equal(calls[2][1], "short");
  assert.deepEqual(calls[3], ["uncaught", undefined]);
});

test("copyDetails：先过后端脱敏，再把脱敏后的写进剪贴板", async () => {
  const calls: string[] = [];
  await diagnostics.copyDetails("token=abc /Users/me/x", {
    redact: async (s: string) => (calls.push(`redact:${s}`), "token=… ~/x"),
    copy: async (s: string) => void calls.push(`copy:${s}`),
  });
  assert.deepEqual(calls, ["redact:token=abc /Users/me/x", "copy:token=… ~/x"]);
});

test("copyDetails：脱敏失败时不把原文写进剪贴板", async () => {
  const calls: string[] = [];
  await assert.rejects(
    diagnostics.copyDetails("secret", {
      redact: () => Promise.reject(new Error("ipc")),
      copy: async (s: string) => void calls.push(s),
    }),
  );
  assert.deepEqual(calls, []);
});

test("faultPage：debug_fault 返回 page:<页> 才点名那一页，其余（含 null）都是没有", () => {
  assert.equal(diagnostics.faultPage("page:models"), "models");
  assert.equal(diagnostics.faultPage("page:"), null);
  assert.equal(diagnostics.faultPage("panic"), null);
  assert.equal(diagnostics.faultPage(null), null);
  assert.equal(diagnostics.faultPage(undefined), null);
});

// ===== 错误原文：WebKit 的 stack 不带 `Name: message` 那一行 =====

test("errorText：stack 不以 `Name: message` 开头（WebKit）就补在最前面，不重复（V8）", () => {
  const webkit = new TypeError("x is not a function");
  webkit.stack =
    "$E@tauri://localhost/assets/index.js:1:2\nlc@tauri://localhost/assets/index.js:3:4";
  assert.equal(
    errorText(webkit),
    "TypeError: x is not a function\n$E@tauri://localhost/assets/index.js:1:2\nlc@tauri://localhost/assets/index.js:3:4",
  );
  const v8 = new Error("boom");
  v8.stack = "Error: boom\n    at Foo (foo.tsx:1:1)";
  assert.equal(errorText(v8), "Error: boom\n    at Foo (foo.tsx:1:1)");
  const none = new RangeError("r");
  none.stack = undefined;
  assert.equal(errorText(none), "RangeError: r");
});

test("errorText：不是 Error 的抛出值（字符串、对象、null）也有可读的原文", () => {
  assert.equal(errorText("纯字符串"), "纯字符串");
  assert.equal(errorText({ code: 7 }), '{"code":7}');
  assert.equal(errorText(null), "null");
});

test("faultDetails 与全局日志的第一行都带真正的错误信息，即使 stack 里没有", () => {
  const e = new Error("读不出来");
  e.stack = "$E@tauri://x:1:1";
  assert.match(faultDetails({ error: e, version: "1", now: new Date() }), /^Error: 读不出来\n\$E@/);
  const target = new EventTarget();
  const lines: string[] = [];
  diagnostics.installGlobalErrorLogging(target, (m: string) => void lines.push(m));
  target.dispatchEvent(Object.assign(new Event("error"), { message: "m", error: e }));
  target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: e }));
  assert.match(lines[0], /Error: 读不出来\n\$E@/);
  assert.match(lines[1], /^unhandled rejection: Error: 读不出来\n\$E@/);
});

// ===== 版面（M10 画板）：整块在页面区里上下左右居中，块内文字靠左 =====

test("出错页版面：外层铺满页面区并居中；块限宽 460、文字靠左；标题 15/600，说明 13 ink-mute", () => {
  const outer = rule(".ss-pagefault");
  assert.match(outer, /min-height:\s*100%/);
  assert.match(outer, /align-items:\s*center/);
  assert.match(outer, /justify-content:\s*center/);
  const block = rule(".ss-pagefault__block");
  assert.match(block, /max-width:\s*460px/);
  assert.match(block, /align-items:\s*flex-start/);
  assert.match(block, /text-align:\s*left/);
  const title = rule(".ss-pagefault__title");
  assert.match(title, /font-size:\s*var\(--size-body\)/);
  assert.match(title, /font-weight:\s*600/);
  const sentence = rule(".ss-pagefault__sentence");
  assert.match(sentence, /font-size:\s*var\(--size-caption\)/);
  assert.match(sentence, /color:\s*var\(--ink-mute\)/);
  const html = render(FaultView, { details: "x", onReload: noop, onCopy: noop });
  assert.match(html, /<div class="ss-pagefault__block">/);
});

test("errorText：全函数，name / message / stack 不是字符串或读取时抛错也不抛", () => {
  const weird = new Error("m");
  (weird as unknown as { stack: unknown }).stack = 42;
  assert.equal(errorText(weird), "Error: m\n42");
  const noName = Object.assign(new Error("m"), { name: 7, message: { a: 1 } });
  assert.equal(typeof errorText(noName), "string");
  const hostile = new Error("m");
  Object.defineProperty(hostile, "stack", {
    get() {
      throw new Error("no stack for you");
    },
  });
  assert.equal(typeof errorText(hostile), "string");
  const toStringThrows = {
    toString: () => {
      throw new Error("x");
    },
    toJSON: () => {
      throw new Error("y");
    },
  };
  assert.equal(typeof errorText(toStringThrows), "string");
});

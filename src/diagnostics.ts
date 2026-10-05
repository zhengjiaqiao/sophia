/// 本机诊断的网页侧（spec 2026-10-04-local-diagnostics R3 / R7 / R13）：把网页里的错误写进日志，
/// 复制详情前先去隐私。去隐私的规则只在 Rust 那一份（`redact_text`），这里不另写；日志在 Rust 侧的
/// 格式化里同样统一过一遍，所以这里写的是原文。
import { error as pluginError } from "@tauri-apps/plugin-log";
import { api } from "./api.ts";
import { errorText } from "./errorText.ts";
import type { ReportCountKind } from "./types.ts";

type Sink = (message: string) => void | Promise<void>;
type Count = (kind: ReportCountKind, text?: string) => void;

/// 交给后端的原文最多这么多个 UTF-16 单元；后端去隐私后再按字节截到 24 KB
const REPORT_TEXT_MAX = 24_000;

/// 自动上报（spec 2026-10-04-reporting-feedback R7、R8）：网页侧的一次异常记一次次数；带了原文（写进日志的那一段），
/// 后端去隐私后作为一条错误事件上传。同 `logError`：内部版没有这个命令、IPC 断了、不在应用里跑都静默放弃
export function reportCount(
  kind: ReportCountKind,
  text?: string,
  channel: (kind: ReportCountKind, text?: string) => unknown = api.reportCountFrontend,
): void {
  try {
    void Promise.resolve(channel(kind, clip(text))).catch(() => undefined);
  } catch {
    // 记不上就算了
  }
}

/// 截到 `REPORT_TEXT_MAX`；末尾不留半个代理对（后端按 JSON 读不进孤立的代理项）
function clip(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= REPORT_TEXT_MAX) return text;
  const cut = text.slice(0, REPORT_TEXT_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/// 一条错误写进日志（level error）。日志是帮忙的，不能反过来添乱：插件没注册、IPC 断了、不在应用里跑
/// （浏览器里看样张）都静默放弃，不抛、不产生新的未处理拒绝
export async function logError(message: string, sink: Sink = pluginError): Promise<void> {
  try {
    await sink(message);
  } catch {
    // 写不进去就算了
  }
}

/// 错误边界接住的一次渲染错误：错误本身加 React 的组件栈；另记一次 `pageFault`（带上同一段原文）
export function logPageFault(
  error: unknown,
  componentStack: string,
  count: Count = reportCount,
  sink: Sink = pluginError,
): Promise<void> {
  const text = `page render failed: ${errorText(error)}\nComponent stack:${componentStack}`;
  count("pageFault", text);
  return logError(text, sink);
}

/// 全局未捕获的错误与未处理的 Promise 拒绝写进日志，各记一次 `uncaught`（带上同一段原文）；只记，不拦默认行为，
/// 界面不变。返回卸载函数
export function installGlobalErrorLogging(
  target: EventTarget = window,
  sink: Sink = logError,
  count: Count = reportCount,
): () => void {
  const onError = (event: Event) => {
    const e = event as Partial<ErrorEvent>;
    const where = e.filename ? ` (${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0})` : "";
    const detail = e.error !== undefined && e.error !== null ? `\n${errorText(e.error)}` : "";
    const text = `uncaught error: ${e.message ?? ""}${where}${detail}`;
    count("uncaught", text);
    void sink(text);
  };
  const onRejection = (event: Event) => {
    const text = `unhandled rejection: ${errorText((event as Partial<PromiseRejectionEvent>).reason)}`;
    count("uncaught", text);
    void sink(text);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/// `复制详情`：先让后端去隐私，再写剪贴板。去隐私没做成就整件事失败，绝不把原文放进剪贴板
export async function copyDetails(
  text: string,
  deps: { redact: (text: string) => Promise<string>; copy: (text: string) => Promise<void> } = {
    redact: api.redactText,
    copy: api.copyText,
  },
): Promise<void> {
  await deps.copy(await deps.redact(text));
}

/// 开发版的故意出错入口：`debug_fault` 返回 `page:<页>` 时，那一页渲染就抛错（正式版返回 null，这里恒为 null）
export function faultPage(fault: string | null | undefined): string | null {
  const m = /^page:(.+)$/.exec(fault ?? "");
  return m ? m[1] : null;
}

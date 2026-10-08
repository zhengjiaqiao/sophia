/// 后端命令错误分两层（spec #239「错误怎么分两层」，CODING_STANDARDS「错误给人看的一句与技术原文分开」）：
/// 错误串形如 `[code] 一句`，带技术原文时另起一行 `[detail] 原文`（后端 `app::DETAIL_MARK`、`src-tauri/src/cmd_error.rs`）。
/// 一句给人看，原文进前面的「!」（`Details`）。skill、MCP、设置、模型各处共用这一份拆法。纯逻辑，方便测试

export interface ParsedBackendError {
  code: string;
  message: string;
  /// 技术原文（请求、状态码、返回的错误、系统报错；后端已去隐私），给 `详情`；没有就不带这个字段
  detail?: string;
}

const ERROR_PREFIX = /^\[([a-z_]+)]\s*/;
/// 技术原文的分隔（后端 `app::DETAIL_MARK`，docs/gateway-commands.md「错误」）
const DETAIL_MARK = "\n[detail] ";

/**
 * 后端错误形如 `[code] message`，带技术原文时再另起一行 `[detail] 原文`（spec 2026-10-04-local-diagnostics R13）；
 * 剥离前缀，一句话给人看，原文拆进 `detail`。
 * `[changed]` 的正文本身已经在说明“配置已变化，请重试”，同样剥离前缀原样展示即可。
 * 读不出前缀（例如非字符串异常、还没改成两层的命令）时 code 是 internal：给了该处的失败句 `fallback`，
 * 一句用它、整段进 `detail`；没给就把整段原文当作一句（模型页一直是这样）。
 */
export function parseBackendError(text: string, fallback?: string): ParsedBackendError {
  const match = ERROR_PREFIX.exec(text);
  if (!match) {
    if (fallback === undefined) return { code: "internal", message: text };
    return { code: "internal", message: fallback, detail: text };
  }
  const rest = text.slice(match[0].length);
  const at = rest.indexOf(DETAIL_MARK);
  if (at < 0) return { code: match[1], message: rest };
  return {
    code: match[1],
    message: rest.slice(0, at),
    detail: rest.slice(at + DETAIL_MARK.length),
  };
}

/// 抛出值里给人看的那一句：只给会自己消失的提示条、格子下的原因用（它们不放「!」，原文后端已记进日志）。
/// 会留在页面上的（横幅、灰面板、行抽屉）不用它：用 `parseBackendError`，`detail` 进「!」。
/// 没有前缀的（core 直接给的一句、还没改成两层的命令）原样返回；给了 `fallback` 时按 `parseBackendError` 换成它
export const errorSentence = (error: unknown, fallback?: string): string =>
  parseBackendError(String(error), fallback).message;

/// 窗口顶上横幅（`App.tsx`）的一条故障：后端错误串，加上出错处给的失败句（错误串没有前缀时用）与一颗往前走的键
export interface AppFault {
  text: string;
  /// 该处的失败句（`设置保存失败`）：错误串没有前缀时作一句，整段进「!」
  fallback?: string;
  /// `再试一次`：重做出错的那一次
  retry?: { label: string; onClick: () => void };
}

/// 前端自己说好一句、另有技术原文时交给横幅的那一条（撤销失败交给壳的横幅，#320）：一句给人看，原文进「!」。
/// 原文是后端拆出来的 `[detail]`（已去隐私、不带 `[code]` 前缀），按 `parseBackendError` 的规矩整段进「!」、一句用 `fallback`
export function sentenceFault(message: string, detail?: string): AppFault {
  return detail === undefined ? { text: message } : { text: detail, fallback: message };
}

/// 横幅怎么画：一句、「!」里的原文、键
export interface AppFaultView {
  message: string;
  technical?: string;
  retry?: { label: string; onClick: () => void };
}

/// 一句给人看，原文进「!」。`再试一次` 只在带原文时给：没有原文的是给人看的一句
/// （显示已满、设置文件来自更新版本的 Sophia），再点一次结果一样（DESIGN-components「灰面板」：只有能往前走的键才给）
export function appFaultView(fault: AppFault): AppFaultView {
  const { message, detail } = parseBackendError(fault.text, fault.fallback);
  if (detail === undefined) return { message };
  return fault.retry
    ? { message, technical: detail, retry: fault.retry }
    : { message, technical: detail };
}

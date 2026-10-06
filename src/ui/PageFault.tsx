import { Component, type ErrorInfo, type ReactNode } from "react";
import { errorText } from "../errorText.ts";
import { t } from "../i18n.ts";
import { Button } from "./Button.tsx";
import { Details } from "./Details.tsx";

/// 页面兜底（spec 2026-10-04-local-diagnostics R7）：一页渲染抛错，只把这一块换成「这一页出了问题」，
/// 侧栏和别的页照常能用，不白屏。是一个错误边界（只有类组件能当），包在每页那一块上，由调用方给 `key`
/// （换页就重置）。托盘面板同样兜底，`narrow` 是窄面板的形态。
///
/// 出错页（M10 画板）：整块在页面区里上下左右居中，块内文字靠左、宽不过 460：标题 15 / 600、一句 13 `ink-mute`
/// 说明、一行键：墨键 `重新加载`（把边界清掉、子树重新渲染）。说明那句话上挂悬浮卡（`Details`：错误原文 + 调用栈、
/// 版本、本地时间；`复制详情` 经 `onCopy`），停上去就出。
///
/// **上报关着时**（spec 2026-10-04-reporting-feedback R11，画板 ErrorOff；自动上报关着或 `DO_NOT_TRACK`、且有接收服务，
/// 由调用方判断后给 `onReport`）：说明换成「……反复出现的话，把问题报告给我们。」，`重新加载` 之后多一颗默认键
/// `报告这个问题`，打开反馈小窗、带上**已去隐私**的详情（还没去好就不带，绝不带原文）。上报开着时不给：
/// 维护者已经自动拿到了，出错页照旧。
///
/// 日志、剪贴板与反馈小窗不在这里碰：`onError` 写日志、`onCopy` 去隐私后复制、`onReport` 打开小窗，都由调用方给
/// （组件库不碰 api）。

export interface PageFaultProps {
  children: ReactNode;
  /// 边界接住错误时调用一次（写日志）：错误本身与 React 的组件栈
  onError: (error: unknown, componentStack: string) => void;
  /// 详情里的 `复制详情`
  onCopy: (text: string) => void | Promise<void>;
  /// 托盘面板的窄形态
  narrow?: boolean;
  /// 主窗口外壳（侧栏、横幅、反馈小窗、退出确认）的兜底（spec S18）：整窗换成出错页，只有 `重新加载`
  /// （重载整个窗口），说明上不挂详情，也没有 `报告这个问题`——壳都没了，别的一概不画
  shell?: boolean;
  /// 应用版本，写进详情；读不到传 null
  version?: string | null;
  /// 去隐私（后端 `redact_text`）：屏幕上的详情与复制出去的一样去过隐私（Codex 复审 7/7）。
  /// 没做好之前、或没做成，详情里只有错误名与那一句（`faultHeadline`）
  redact?: (text: string) => Promise<string>;
  /// 给了就有 `报告这个问题`：收到已去隐私的详情（还没去好时是 undefined）
  onReport?: (details?: string) => void;
  /// 发出去之后的提示条（调用方的 `FloatingToast`），锚在 `报告这个问题` 下面
  reportNote?: ReactNode;
}

interface PageFaultState {
  /// 出了错：抛出的值可以是 undefined / null，所以另用一个标记，不靠 `error` 判断
  failed: boolean;
  error: unknown;
  componentStack: string;
  /// 去过隐私的详情；还没做好 / 没做成为 null
  redacted: string | null;
}

export class PageFault extends Component<PageFaultProps, PageFaultState> {
  state: PageFaultState = { failed: false, error: null, componentStack: "", redacted: null };

  static getDerivedStateFromError(error: unknown): Partial<PageFaultState> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    this.setState({ componentStack, redacted: null });
    const raw = faultDetails({
      error,
      componentStack,
      version: this.props.version ?? null,
      now: new Date(),
    });
    void Promise.resolve()
      .then(() => this.props.redact?.(raw) ?? null)
      .then(
        (redacted) => {
          if (this.state.error === error) this.setState({ redacted });
        },
        () => undefined,
      );
    try {
      this.props.onError(error, componentStack);
    } catch {
      // 写日志失败不能让兜底页再出错
    }
  }

  render(): ReactNode {
    const { failed, error, redacted } = this.state;
    if (!failed) return this.props.children;
    const { narrow, shell, onCopy, onReport, reportNote } = this.props;
    return (
      <FaultView
        narrow={narrow}
        shell={shell}
        details={redacted ?? faultHeadline(error)}
        onReload={() =>
          shell
            ? window.location.reload()
            : this.setState({ failed: false, error: null, componentStack: "", redacted: null })
        }
        onCopy={onCopy}
        // 只交出去过隐私的详情：还没做好（或没做成）时不带，绝不带 `faultHeadline` 的原文
        onReport={onReport ? () => onReport(this.state.redacted ?? undefined) : undefined}
        reportNote={reportNote}
      />
    );
  }
}

export interface FaultViewProps {
  /// 详情里的原文
  details: string;
  onReload: () => void;
  onCopy: (text: string) => void | Promise<void>;
  narrow?: boolean;
  /// 外壳形态：只有 `重新加载`（见 `PageFaultProps.shell`）
  shell?: boolean;
  /// 给了就有 `报告这个问题`（上报关着时），说明换成带「报告给我们」的那一句
  onReport?: () => void;
  /// 发出去之后的提示条，挂在 `报告这个问题` 那一格里
  reportNote?: ReactNode;
}

/// 出错页本身（纯展示；服务端渲染不走错误边界，测试直接渲染它）
export function FaultView({
  details,
  onReload,
  onCopy,
  narrow = false,
  shell = false,
  onReport,
  reportNote,
}: FaultViewProps) {
  return (
    <div className={narrow ? "ss-pagefault ss-pagefault--narrow" : "ss-pagefault"} role="alert">
      <div className="ss-pagefault__block">
        <h2 className="ss-pagefault__title">
          {shell ? t("common.pageFault.shellTitle") : t("common.pageFault.title")}
        </h2>
        <p className="ss-pagefault__sentence">
          {shell ? (
            t("common.pageFault.shellSentence")
          ) : (
            // 错误原文与调用栈挂在这句话上：停上去浮起悬浮卡（2026-10-06 起不再是一颗 `详情` 键）
            <Details text={details} onCopy={onCopy}>
              {onReport ? t("common.pageFault.sentenceReport") : t("common.pageFault.sentence")}
            </Details>
          )}
        </p>
        <div className="ss-pagefault__keys">
          <Button variant="primary" onClick={onReload}>
            {t("common.pageFault.reload")}
          </Button>
          {!shell && onReport ? (
            <span className="ss-pagefault__report">
              <Button onClick={onReport}>{t("common.feedback.report")}</Button>
              {reportNote}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/// 本地时间 `2026-10-04 09:05:07 +08:00`
function localTime(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/// 错误名与那一句（`Error: 读不出来`）：去隐私的详情没好之前、或没做成时，出错页详情里只给这一行
export function faultHeadline(error: unknown): string {
  return errorText(error).split("\n")[0] ?? "";
}

/// 详情的原文：错误（有调用栈用调用栈）、React 组件栈、版本、本地时间。给人和开发者看的技术原文，
/// 标签用英文不进目录；复制前由调用方去隐私
export function faultDetails(input: {
  error: unknown;
  componentStack?: string;
  version: string | null;
  now: Date;
}): string {
  const parts = [errorText(input.error)];
  const stack = input.componentStack?.trim();
  if (stack) parts.push(`Component stack:\n${input.componentStack?.replace(/^\n+/, "")}`);
  parts.push(`version: ${input.version ?? "-"}\ntime: ${localTime(input.now)}`);
  return parts.join("\n\n");
}

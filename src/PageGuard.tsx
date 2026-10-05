import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "./api.ts";
import { copyDetails, faultPage, logPageFault } from "./diagnostics.ts";
import { FeedbackSentNote, openFeedback, useReportSettings } from "./feedback.tsx";
import { offerReport } from "./feedbackView.ts";
import { PageFault } from "./ui/index.ts";

/// 页面兜底的接线（spec 2026-10-04-local-diagnostics R7）：把 `PageFault` 的日志、复制、版本接上。
/// 主窗口包页面那一块（`key` 给当前页：换页就重置），托盘包整个面板（`narrow`）。
/// 上报关着（或 `DO_NOT_TRACK`）且有接收服务时（`offerReport`），主窗口的出错页多一颗 `报告这个问题`：
/// 打开反馈小窗（应用级一份，见 `feedback.tsx`）、带上已去隐私的详情；发出去时键还在就把提示条锚在键下面
/// （spec 2026-10-04-reporting-feedback R11）。
/// 托盘面板窄、放不下 480 的小窗，不给这颗键

let versionRead: Promise<string | null> | null = null;
/// 应用版本，进出错页的详情；读不到就是 null。只问一次
function readVersion(): Promise<string | null> {
  versionRead ??= getVersion().then(
    (v) => v,
    () => null,
  );
  return versionRead;
}

export function PageGuard({
  children,
  narrow,
  shell,
}: {
  children: ReactNode;
  narrow?: boolean;
  /// 主窗口外壳的兜底（spec S18）：整窗换成出错页，只有 `重新加载`
  shell?: boolean;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const settings = useReportSettings();
  useEffect(() => {
    let cancelled = false;
    void readVersion().then((v) => !cancelled && setVersion(v));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <PageFault
      narrow={narrow}
      shell={shell}
      version={version}
      onError={(error, componentStack) => {
        // 故意出的错只出一次：边界接住后拆掉，`重新加载` 才能恢复（React 渲染出错会就地重试一次，
        // 所以不能在抛的时候拆）
        if (error instanceof DebugFaultError) defused.add(error.page);
        void logPageFault(error, componentStack);
      }}
      onCopy={(text) => copyDetails(text)}
      redact={api.redactText}
      onReport={
        !narrow && !shell && offerReport(settings)
          ? (attached) => openFeedback("pageFault", attached)
          : undefined
      }
      reportNote={<FeedbackSentNote source="pageFault" align="start" />}
    >
      {children}
    </PageFault>
  );
}

let faultRead: Promise<string | null> | null = null;

/// 开发版的故意出错入口（`debug_fault`）：返回被点名要出错的页，没有（含正式版）就是 null。
/// 问一次；命令不存在或失败一律当没有
export function useFaultPage(): string | null {
  const [page, setPage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    faultRead ??= api.debugFault().then(
      (fault) => faultPage(fault),
      () => null,
    );
    void faultRead.then((p) => !cancelled && setPage(p));
    return () => {
      cancelled = true;
    };
  }, []);
  return page;
}

class DebugFaultError extends Error {
  constructor(readonly page: string) {
    super(`debug fault: page:${page}`);
  }
}

const defused = new Set<string>();

/// 渲染即抛错：只在 `debug_fault` 点名的那一页里放它；被边界接住一次后就不再抛
export function FaultBomb({ page }: { page: string }): null {
  if (defused.has(page)) return null;
  throw new DebugFaultError(page);
}

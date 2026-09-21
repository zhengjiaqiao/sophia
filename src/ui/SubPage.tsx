import { useEffect } from "react";
import type { ReactNode } from "react";

/// 二级页面（组件规范 §4.6）：占满整窗，**不保留侧栏**。
/// 顶栏只有 ← 和页面名。返回即保存，没有「保存」按钮。Esc 等同返回。

export interface SubPageProps {
  /// 页面名，Condensed 20/700/1.9px 大写，与 wordmark 同档
  title: string;
  onBack: () => void;
  /// 顶栏右侧的一句副标题，可选
  aside?: ReactNode;
  children: ReactNode;
}

export function SubPage({ title, onBack, aside, children }: SubPageProps) {
  // Esc 等同返回
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  return (
    <div className="ss-subpage">
      <div className="ss-subpage__bar">
        <button type="button" className="ss-subpage__back" aria-label="返回" onClick={onBack}>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="square"
            aria-hidden="true"
          >
            <path d="M20.5 12H4M10.5 5.5L4 12l6.5 6.5" />
          </svg>
        </button>
        <div className="ss-subpage__title">{title}</div>
        {aside ? <div className="ss-subpage__aside">{aside}</div> : null}
      </div>
      <div className="ss-subpage__body">{children}</div>
    </div>
  );
}

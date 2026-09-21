import { useEffect } from "react";
import type { ReactNode } from "react";
import { IconArrowLeft } from "./icons.tsx";

/// 二级页面（组件规范 §4.6）：占满整窗，**不保留侧栏**。
/// 顶栏只有 ← 和页面名。返回即保存，没有「保存」按钮。Esc 等同返回。

export interface SubPageProps {
  /// 页面名，Condensed 20/700/1.9px 大写，与 wordmark 同档
  /// 页面名。可以是节点：标题走大写档，里面嵌的专名（目的地、agent 名）要用 <Plain> 包住
  title: ReactNode;
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
      <div className="ss-subpage__bar" data-tauri-drag-region>
        {/* 箭头出自 icons.tsx：24px 上仍画 1.4 的线，与界面里别处的图标同一笔 */}
        <button
          type="button"
          className="ss-subpage__back"
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <IconArrowLeft size={24} />
        </button>
        <div className="ss-subpage__title">{title}</div>
        {aside ? <div className="ss-subpage__aside">{aside}</div> : null}
      </div>
      <div className="ss-subpage__body">{children}</div>
    </div>
  );
}

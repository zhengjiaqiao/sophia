import { useEffect } from "react";
import type { ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import { IconArrowLeft } from "./icons.tsx";

/// 二级页面（DESIGN「Layout › 壳」）：占满整窗，**不渲染侧栏**。
/// 头高 84 = 28（红绿灯那一排，只当拖动区）+ 56，底 hairline；56 里 `←` 图标按钮 28×28、
/// 间距 12、页面名 28/700 **不大写、字距 0**（`添加 skill 到「全局」` `Codex 的网关` 原样写）。
/// 返回即保存，没有「保存」按钮；Esc 等同返回。

export interface SubPageProps {
  /// 页面名，原样写（专名不再需要 <Plain> 包：这一档本来就不大写）
  title: ReactNode;
  onBack: () => void;
  /// 头右侧的一句副标题，可选
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
        <IconButton icon={<IconArrowLeft />} title="返回" onClick={onBack} />
        <div className="ss-subpage__title">{title}</div>
        {aside ? <div className="ss-subpage__aside">{aside}</div> : null}
      </div>
      <div className="ss-subpage__body">{children}</div>
    </div>
  );
}

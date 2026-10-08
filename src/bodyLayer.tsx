import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/// 确认框挂到 body 上：推入页带着 transform，挂在原处会被它裁掉、定位也会偏（提供商页的删除、取消启用确认用）
export function bodyLayer(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

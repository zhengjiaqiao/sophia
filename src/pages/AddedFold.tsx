import type { ReactNode } from "react";
import { IconChevronRight } from "../ui";

/// 添加页列表最后一行 `已添加 N 个 ▸`（DESIGN「添加页 › 列表行」）：列表只列未添加的，
/// 已添加的收在这里，点一下展开。展开后的项由调用方渲染——不画复选框、名字 `ink-faint`、
/// 悬停没有反馈（外观不能说「可点」却点了没反应）。N 为 0 时不出现
export function AddedFold({
  count,
  open,
  onToggle,
  children,
  layout = "grid",
}: {
  /// grid：名字三列按行排（skill）；rows：一行一个（MCP，名字 + 传输）
  layout?: "grid" | "rows";
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="ss-import__fold">
      <button
        type="button"
        className={`ss-import__foldkey${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        已添加 {count} 个
        <IconChevronRight size={10} />
      </button>
      {open ? (
        <div className={`ss-import__folded${layout === "rows" ? " ss-import__folded--rows" : ""}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

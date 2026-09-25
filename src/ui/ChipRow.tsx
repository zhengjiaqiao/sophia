import { Children } from "react";
import type { ReactNode } from "react";

/// 胶囊行（DESIGN「位置页 › 来源筛选」「第三方模型 › 在用」：两处同一种写法，⑤）：
/// 行首一个标签（12 / 500 `ink-mute`，与第一行胶囊同高居中）+ 8 + 一排胶囊，放不下折行——
/// 折行时胶囊对齐胶囊、不钻到标签下面；胶囊间 6、行间 8。
/// 胶囊是 `Chip`（来源筛选）还是 `ModelChip`（在用的模型）由调用方放；单选、移除这些逻辑也归调用方。
/// 一个都没有时调用方别渲染它（空的标签没有意义）
export interface ChipRowProps {
  /// 行首标签：`来源` `在用`
  label: string;
  /// 胶囊，每颗一个子节点（各自包一层，读屏按列表读）
  children: ReactNode;
  /// 读屏名（`在用的模型`）；不给就用标签
  listLabel?: string;
}

export function ChipRow({ label, children, listLabel }: ChipRowProps) {
  return (
    <div className="ss-chiprow">
      <span className="ss-chiprow__label">{label}</span>
      <div className="ss-chiprow__chips" role="list" aria-label={listLabel ?? label}>
        {Children.map(children, (chip) =>
          chip === null || chip === undefined || chip === false ? null : (
            <span className="ss-chiprow__chip" role="listitem">
              {chip}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

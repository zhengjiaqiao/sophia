import { useRef } from "react";
import type { ReactNode } from "react";
import { BusySlot } from "./BusySlot.tsx";
import { Button } from "./Button.tsx";

/// 差异表（DESIGN-components「差异表 DiffTable」，画板 #105 第七稿第 2 节）：同名的几份并排比，**一行一份**——
/// 行首是位置名，后面字段成列（第一列「原件」是路径，等宽、长了折行），顺着一列往下比；行尾一颗紧凑键
/// 自成一列、右对齐在最右。MCP「N 份不一样」（键「保留这份」）与 skill 同名两份（键「只留这份」，表里只有
/// 「原件」一列）共用这一张表。只吃 props，不碰 api；段首小标（`3 份不一样`）归调用方
export interface DiffTableRow {
  /// 这一份的标识（位置 id），按键时原样交回
  id: string;
  /// 行首位置名（`用户级 · Claude Code`）
  place: ReactNode;
  /// 与 `fields` 同序的值；路径、字段值由调用方画（`Mono` 等）
  values: ReactNode[];
  /// 行尾键按不下的原因：给了就禁用，原因进提示框
  actionDisabledReason?: string;
  /// 读屏念的键名（字面只有动词，补上是哪一份：`保留 用户级 · Claude Code 的 dingtalk-doc`）
  actionAriaLabel?: string;
  /// 按下之后在等（skill「只留这份」先体检）：键锁住，过了 0.3 秒门槛原位换成刻度 + 这一句（`BusySlot`）
  actionBusy?: string;
}

export interface DiffTableProps {
  /// 列头：第一列是「原件」，后面是不一样的字段名（字段名由调用方包 `Mono`）
  fields: ReactNode[];
  rows: DiffTableRow[];
  /// 行尾键的字（`保留这份` / `只留这份`）；与 `onAction` 都给了才有键那一列
  actionLabel?: string;
  /// `key`：按下的那颗键所在的格（结果的提示小窗要锚在它上面）
  onAction?: (rowId: string, key: HTMLElement | null) => void;
  /// 读屏给这张表的名字（同段首小标）
  label?: string;
}

export function DiffTable({ fields, rows, actionLabel, onAction, label }: DiffTableProps) {
  const act = actionLabel !== undefined && onAction !== undefined ? onAction : null;
  // 各行键所在的格：按下时交给调用方当锚点
  const keys = useRef(new Map<string, HTMLElement>());
  // 位置名、键按内容宽；字段列可以收窄（长路径折行），键那一列吃掉剩下的宽度，键右对齐在最右
  const columns =
    `max-content repeat(${fields.length}, minmax(0, max-content))` +
    (act ? " minmax(max-content, 1fr)" : "");
  return (
    <div
      className="ss-difftable"
      role="table"
      aria-label={label}
      style={{ gridTemplateColumns: columns }}
    >
      <div className="ss-difftable__row" role="row">
        <span className="ss-difftable__head" role="columnheader" />
        {fields.map((field, i) => (
          <span key={i} className="ss-difftable__head" role="columnheader">
            {field}
          </span>
        ))}
        {act ? <span className="ss-difftable__head" role="columnheader" /> : null}
      </div>
      {rows.map((row) => (
        <div key={row.id} className="ss-difftable__row" role="row">
          <span className="ss-difftable__place" role="rowheader">
            {row.place}
          </span>
          {row.values.map((value, i) => (
            <span key={i} className="ss-difftable__value" role="cell">
              {value}
            </span>
          ))}
          {act ? (
            <span
              className="ss-difftable__action"
              role="cell"
              ref={(el) => {
                if (el) keys.current.set(row.id, el);
                else keys.current.delete(row.id);
              }}
            >
              {row.actionDisabledReason !== undefined ? (
                <Button size="compact" disabled disabledReason={row.actionDisabledReason}>
                  {actionLabel}
                </Button>
              ) : (
                <BusySlot busy={row.actionBusy !== undefined} label={row.actionBusy ?? ""}>
                  <Button
                    size="compact"
                    ariaLabel={row.actionAriaLabel}
                    onClick={() => {
                      if (row.actionBusy !== undefined) return;
                      act(row.id, keys.current.get(row.id) ?? null);
                    }}
                  >
                    {actionLabel}
                  </Button>
                </BusySlot>
              )}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

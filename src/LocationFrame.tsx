/// 位置页的外框（DESIGN「组件使用指南 › 不进组件库、在页面层合并的」「位置页 › 空态」）：表格还没有的时候——
/// 首次扫描中、这个位置在当前页签下还没有页——Skills 与 MCP 两页同一个样子，这里写一份。
///
/// 页面头右端照常放筛选框 + `管理来源` + `+ 来源`（切页签、扫描完时页面头不跳）；机面里是一块空态
/// （扫描中是猫 + 刻度 + 「正在读…」，没有页是猫 + 一句现状，`+ 来源` 在页面头，不重复）；
/// 空态上方可挂一条新手提示条；叠在上面的层（来源移除的确认、来源管理页、添加来源页）由调用方放进 `children`。
/// 有了表格就不用它：表格页自己画（`Matrix`）
import type { ReactNode } from "react";
import { LocationActions } from "./Matrix";
import { Empty, type EmptyArt } from "./ui";

export interface LocationFrameProps {
  filterText: string;
  onFilterText: (text: string) => void;
  /// 页面头右端、筛选框右边的键（`管理来源` `+ 来源`）
  actions: ReactNode;
  /// 菜单「筛选」（⌘F）交不交给这一页（推入页盖在上面时不交）
  enabled: boolean;
  /// bar 插槽（与 Matrix 同一个位置、同一条 `mx-bar`）：R4 的项目筛选片放这里；没给就只留上下距
  bar?: ReactNode;
  /// 机面里的空态：一句现状（扫描中时就是「忙什么」）、可选第二行、图
  empty: { description: string; hint?: string; busy?: boolean; art: EmptyArt };
  /// 空态上方的新手提示条（`HintStrip`）
  hint?: ReactNode;
  /// 叠在上面的层：来源移除的确认、来源管理页、添加来源页
  children?: ReactNode;
}

export function LocationFrame({
  filterText,
  onFilterText,
  actions,
  enabled,
  bar,
  empty,
  hint,
  children,
}: LocationFrameProps) {
  return (
    <>
      <LocationActions
        filterText={filterText}
        onFilterText={onFilterText}
        actions={actions}
        enabled={enabled}
      />
      {bar ? <div className="mx-bar">{bar}</div> : null}
      {hint ? <div className="mx-hint">{hint}</div> : null}
      <Empty description={empty.description} hint={empty.hint} busy={empty.busy} art={empty.art} />
      {children}
    </>
  );
}

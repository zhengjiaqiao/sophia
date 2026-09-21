import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

/// 空态与忙碌态（组件规范 §6）。
///
/// **空态里若有两个动作，只有一个是 pill**，另一个降为文字链——按钮只有一种变体，
/// 两个 pill 并排就分不出主次。

export type EmptyKind =
  /// 首次扫描中：居中一行次要文字，不用 spinner
  | "scanning"
  /// 这个域没有 agent 目录：agent 列照常显示，灯全为空心
  | "noAgentDirs"
  /// 筛选无结果：筛选行留在原位，一眼看出空是筛出来的
  | "noMatch"
  /// 一个 skill 都没有：先说清空的是哪个目录，再给补上的路
  | "noSkills";

const DEFAULT_DESCRIPTION: Record<EmptyKind, string> = {
  scanning: "扫描中…",
  noAgentDirs: "这个项目下还没有任何 agent 的 skill 目录。导入时会顺手建出来。",
  noMatch: "没有匹配的 skill",
  noSkills: "这个来源里还没有 skill。",
};

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /// 可选的 16px 图标（`导入 skill` 这类动作可以带一个）。空态里文字是主角，图标只作陪
  icon?: ReactNode;
}

export interface EmptyProps {
  kind: EmptyKind;
  /// 覆盖默认说明。要嵌路径、来源名时传进来
  description?: ReactNode;
  /// 第二行次要说明
  hint?: ReactNode;
  /// pill 动作，一个就够
  primary?: EmptyAction;
  /// 文字链动作
  secondary?: EmptyAction;
}

export function Empty({ kind, description, hint, primary, secondary }: EmptyProps) {
  return (
    <div className={`ss-empty ss-empty--${kind}`} data-kind={kind}>
      <div className="ss-empty__description">{description ?? DEFAULT_DESCRIPTION[kind]}</div>
      {hint ? <div className="ss-empty__hint">{hint}</div> : null}
      {primary || secondary ? (
        <div className="ss-empty__actions">
          {primary ? (
            <Button icon={primary.icon} onClick={primary.onClick}>
              {primary.label}
            </Button>
          ) : null}
          {secondary ? (
            <Button variant="link" icon={secondary.icon} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface BusyProps {
  /// 操作进行中：受影响控件置灰且点不动
  busy: boolean;
  children: ReactNode;
  className?: string;
}

/// 忙碌态（§6 第五行）：包住受 busy 约束的部分。
/// **不受 busy 约束的五处不要包进来**：设置、筛选输入框、取消选择、提示条关闭、表头排序。
/// 豁免控件保持不透明，也不加聚焦态——同一屏里别的东西灰了，它没灰，对比本身就说明了它还能用。
export function Busy({ busy, children, className }: BusyProps) {
  const classes = [className, busy ? "ss-busy" : null].filter(Boolean).join(" ");
  return (
    <div className={classes || undefined} aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

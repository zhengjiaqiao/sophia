import { AgentIcon } from "../ui";
import { CheckMark } from "./CheckMark.tsx";

/// 添加页底部一排目标里的一项（DESIGN「添加页 › 底部块第一行」）：`☐ + agent 图标 14 + 名字`，
/// 与列表行同一种勾选写法——整项是按钮，方框只是记号，名字照原样写（不用 Condensed 大写）。
/// skill 页的 agent、MCP 页的位置都用它，两页对称。
///
/// 曾用反色图标键，产品负责人真机「看起来不像按钮」，全黑的键也读不出是「选中」。
export function TargetCheck({
  harnessId,
  name,
  on,
  onToggle,
  disabledReason,
}: {
  harnessId: string;
  /// 名字；读屏名也是它（图标对读屏隐藏）
  name: string;
  on: boolean;
  onToggle: () => void;
  /// 给了就禁用，并作为悬停说明（来源自己那个位置「这就是来源」）
  disabledReason?: string;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      className="ss-import__target"
      title={disabledReason}
      disabled={disabled}
      onClick={disabled ? undefined : onToggle}
    >
      <CheckMark on={on} />
      <AgentIcon id={harnessId} name={name} size={14} />
      <span className="ss-import__targetname">{name}</span>
    </button>
  );
}

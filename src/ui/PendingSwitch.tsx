import { Switch } from "./Switch.tsx";
import type { SwitchProps } from "./Switch.tsx";
import "./PendingSwitch.css";

/// 带「待定位置」的开关（DESIGN「开关 › 拖」「agent 页 › 开关的状态＝Codex 正在用的状态」）：
/// 开关本身仍是受控的，`checked` 永远是真实状态；`pending` 是用户拨过去、还在等确认或等生效的那一侧。
///
/// - `pending` 与 `checked` 不同：**滑块停在 `pending` 那一侧**（拖过去的留在对侧，点的也滑过去），
///   刻条与指示点仍按 `checked` 画——橙只表示「开着 / 在生效」，还没生效就不亮（⑭）
/// - 取消（`pending` 回到 null）：滑块用同一条弹簧滑回原位
/// - 生效（`checked` 变成 `pending`）：滑块已经在那儿，只有刻条与指示点换色
///
/// 不改 `Switch` 的接口：待定位置只是包层上的一个属性，样式在 PendingSwitch.css 里压过滑块的位移
export interface PendingSwitchProps extends SwitchProps {
  /// 拨过去、还没落定的那一侧；null / 缺省＝没有待定
  pending?: boolean | null;
}

export function PendingSwitch({ pending = null, ...props }: PendingSwitchProps) {
  const held = pending !== null && pending !== props.checked;
  return (
    <span className="ss-pending-switch" data-pending={held ? (pending ? "on" : "off") : undefined}>
      <Switch {...props} />
    </span>
  );
}

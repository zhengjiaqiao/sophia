import type { ReactNode } from "react";

/// 设置行（DESIGN「产品裁决 › 设置」，2026-10-04 画板 B，照 Claude 的设置页）：左栏名字（`body`）在上、
/// 一句灰字（13 `ink-mute`）在下，右端一列放控件（开关、紧凑页签、默认键紧凑）。同一节里行与行之间一条行线。
/// 左栏不限宽（2026-10-06），铺到右端控件前（间 32）：名字、灰字长了在左栏里折行，控件留在右端同一列不跟着挪。
/// 名单挂在一条设置行下面时（`显示的 agent`、`生效范围`），由页面把行与名单包成一块（`settings-page__block`）
export function SettingRow({
  label,
  note,
  children,
}: {
  label: ReactNode;
  note?: ReactNode;
  /// 右端的控件；几样时间 12，按先后从左到右
  children?: ReactNode;
}) {
  return (
    <div className="settings-page__row">
      <div className="settings-page__text">
        <div className="settings-page__label">{label}</div>
        {note ? <div className="settings-page__note">{note}</div> : null}
      </div>
      <div className="settings-page__controls">{children}</div>
    </div>
  );
}

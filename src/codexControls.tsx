import type { ReactElement } from "react";
import type { ModelsTool, RestartPhase } from "./modelsView.ts";
import {
  LAUNCH_TIP,
  RESTART_TIP,
  UNINSTALL_TIP,
  codexKeyKind,
  gatewaySwitchText,
  gatewaySwitchTip,
  switchDisabledReason,
} from "./modelsView.ts";
import type { GatewayState } from "./types.ts";
import { BusySlot, Button, FloatingToast, Switch, Toast, Tooltip } from "./ui/index.ts";
import "./codexControls.css";

/// Codex 能力控件（DESIGN「组件使用指南 › 不进组件库、在页面层合并的」）：「第三方模型」的开关三态、
/// 开关旁那一位的 `重启生效` / `启动 Codex` / `卸下后台服务`。Codex 页节头（ModelsTab）与托盘能力行
/// （TrayModelsRow）用的是这同一份——DESIGN「改动待生效」：Codex 页与托盘同一段逻辑。
/// 它带业务判断（哪颗键此刻该出、开关为什么按不动），所以不进 `src/ui`；写配置、重启、等结果由调用方做，
/// 这里只按调用方给的阶段画。两处只差放在哪（`place`）：节头里提示框与 `✓ 已生效` 左对齐键；
/// 托盘里提示框居中、`✓` 右沿对齐开关（锚是能力行右端那一组）

/// 开关旁那一位在做什么：modelsView 的阶段，外加托盘里「重启确认在面板里展开着」
export type CodexPhase = RestartPhase | { kind: "confirming" };

/// 确认开着时键照常在（它是确认的触发键），判断按空闲算
const settled = (phase: CodexPhase): RestartPhase =>
  phase.kind === "confirming" ? { kind: "idle" } : phase;

export interface CodexSwitchProps {
  tool: ModelsTool;
  state: GatewayState;
  /// 拨下去、正在写配置：拨向哪一侧（乐观翻转：滑块已经在那一侧）；没在写为 null
  switching: boolean | null;
  /// 别的写 Codex 设置的事在做：开关先不接新的一拨，按下说「正在处理上一步」
  busy: boolean;
  /// 读屏名
  label: string;
  /// 提示框在结果之后再说改的是哪个文件（Codex 页）；托盘面板窄，只说结果
  withFile?: boolean;
  onToggle: (next: boolean) => void;
}

/// 「第三方模型」的开关（标准 34 × 20，旁边不点指示点，开着由刻线说）。三态：
/// - 按不动（没有网关、没选模型、待接管……）：禁用开关自带原因提示框，悬停出、按下当即出
/// - 拨下去写配置：乐观翻转，滑块当即过去、橙刻线亮；写超过 0.3 秒原位换成刻度 +「正在添加 / 正在移除」
/// - 平时：提示框说拨下去会怎样（`gatewaySwitchTip`）
export function CodexSwitch({
  tool,
  state,
  switching,
  busy,
  label,
  withFile = false,
  onToggle,
}: CodexSwitchProps) {
  const blocked = switchDisabledReason(state);
  const on = switching ?? state.enabled;
  return (
    <span className="codex-switch">
      {blocked !== null && switching === null ? (
        <Switch
          checked={false}
          onChange={() => undefined}
          label={label}
          disabledReason={blocked}
          tipPlacement="bottom"
        />
      ) : (
        <BusySlot busy={switching !== null} label={gatewaySwitchText(switching ?? true, tool).busy}>
          <Tooltip content={gatewaySwitchTip(on, tool, withFile)} placement="bottom">
            <Switch
              checked={on}
              onChange={onToggle}
              label={label}
              disabledReason={busy && switching === null ? "正在处理上一步" : undefined}
            />
          </Tooltip>
        </BusySlot>
      )}
    </span>
  );
}

export interface CodexKeySlotProps {
  tool: ModelsTool;
  state: GatewayState;
  phase: CodexPhase;
  /// 别的写 Codex 设置的事在做：键禁用并说「正在处理上一步」
  busy: boolean;
  /// 正在卸下后台服务：那颗键原位忙碌
  uninstalling: boolean;
  /// 点 `重启生效`：调用方先确认（节头：窗口正中的确认框；托盘：面板里的窄面板）
  onRestart: () => void;
  onLaunch: () => void;
  onUninstall: () => void;
  /// `✓ 已生效 / 已启动` 那一窗到点
  onDoneDismiss: () => void;
  /// section：Codex 页节头（提示框、✓ 左对齐键）；tray：托盘能力行（提示框居中、✓ 右沿对齐 `doneAnchor`）
  place: "section" | "tray";
  /// 托盘：`✓` 的锚（能力行右端那一组：键位 + 开关）
  doneAnchor?: (probe: HTMLElement) => Element | null;
  /// 重启确认是面板里当场展开的窄面板（托盘）：它的 id，`重启生效` 的 aria-controls 指向它
  confirmId?: string;
}

/// 开关旁那一位（DESIGN「改动待生效：重启生效与启动 Codex」）：`重启生效` / `启动 Codex` / `卸下后台服务`
/// 同一位、不会同时出现（modelsView.codexKeyKind）；都是默认键紧凑 24。
/// 重启、启动、卸下期间原位忙碌（`BusySlot`：过了 0.3 秒门槛才换成刻度 + 一句，之前键照旧、点不动）；
/// 重启、启动成了键消失，原位下方浮起 `✓ 已生效 / 已启动`（约 4 秒淡出）。做不成的灰面板不在这里——由调用方挂
export function CodexKeySlot({
  tool,
  state,
  phase,
  busy,
  uninstalling,
  onRestart,
  onLaunch,
  onUninstall,
  onDoneDismiss,
  place,
  doneAnchor,
  confirmId,
}: CodexKeySlotProps) {
  const tipAlign = place === "section" ? "start" : undefined;
  const tipped = (content: string, key: ReactElement) => (
    <Tooltip content={content} placement="bottom" align={tipAlign} nowrap={place === "section"}>
      {key}
    </Tooltip>
  );

  if (phase.kind === "restarting" || phase.kind === "launching") {
    const restarting = phase.kind === "restarting";
    return (
      <BusySlot busy label={`${restarting ? "正在重启" : "正在启动"} ${tool.name}`}>
        <Button size="compact">{restarting ? "重启生效" : `启动 ${tool.name}`}</Button>
      </BusySlot>
    );
  }
  if (phase.kind === "done" || phase.kind === "launched") {
    const toast = (
      <FloatingToast align={place === "section" ? "start" : "end"} anchor={doneAnchor}>
        <Toast
          kind="success"
          verb={phase.kind === "done" ? "已生效" : "已启动"}
          onDismiss={onDoneDismiss}
        />
      </FloatingToast>
    );
    // 节头：键已消失，原位留一个不占宽、与键同高的锚，结果浮在它正下方 4、左沿对齐
    return place === "section" ? <span className="codex-key__spot">{toast}</span> : toast;
  }

  const kind = codexKeyKind(state, settled(phase));
  if (kind === null) return null;
  if (kind === "uninstall") {
    return (
      <BusySlot busy={uninstalling} label="正在卸下后台服务">
        {tipped(
          UNINSTALL_TIP,
          busy && !uninstalling ? (
            <Button size="compact" disabled disabledReason="正在处理上一步">
              卸下后台服务
            </Button>
          ) : (
            <Button size="compact" onClick={uninstalling ? undefined : onUninstall}>
              卸下后台服务
            </Button>
          ),
        )}
      </BusySlot>
    );
  }
  const restart = kind === "restart";
  const label = restart ? "重启生效" : `启动 ${tool.name}`;
  const expanded = restart && confirmId !== undefined ? phase.kind === "confirming" : undefined;
  return tipped(
    restart ? RESTART_TIP : LAUNCH_TIP,
    busy ? (
      <Button size="compact" disabled disabledReason="正在处理上一步">
        {label}
      </Button>
    ) : (
      <Button
        size="compact"
        onClick={restart ? onRestart : onLaunch}
        ariaExpanded={expanded}
        ariaControls={expanded ? confirmId : undefined}
      >
        {label}
      </Button>
    ),
  );
}

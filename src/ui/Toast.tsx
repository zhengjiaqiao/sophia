import { useEffect } from "react";
import type { ReactNode } from "react";
import { AgentIcon } from "./AgentMark.tsx";
import { Button, IconButton } from "./Button.tsx";
import { IconAttention, IconCannot, IconCheck, IconClose } from "./icons.tsx";
import { Tooltip } from "./Tooltip.tsx";

/// 提示条（DESIGN「提示条分两档」「提示条的位置」，画板 Feedback「提示条」）。
///
/// 两档，严重程度决定打断程度（①）：
/// - `notice` 需要注意：**黑显示窗**。0 圆角无外框，左侧 40px 指示窗（右边 1px `ink-mute`）
///   放 16px 白线稿 ✓ / ⊘ / !。给做不成、部分失败、自动开启、可撤销的删除、错误
/// - `routine` 例行成功：一行墨字直接落在白底上，无框无底：`✓ 写进 [图标] 名字 · 撤销`。
///   结果已由格子闪烁表达，这行只提供撤销入口
///
/// 主行 = **动词（600）+ agent 图标 + 名字（400）**。**动词必填**，且与触发它的动作一致；
/// 失败态动词带否定（`没开启`）——失败里写「开启」会被一眼读成已开启。名字至多两个，
/// 超过写 `+N`（等宽 15/500）。
///
/// **位置由调用方定**：锚在触发控件上（批量贴被按下的键下 4、右对齐该键；二级页贴被
/// 处理那一行；无关位置的全局事右下、右沿对齐面板右沿）。组件只负责形制，不写 position。

export type ToastKind = "success" | "cannot" | "partial";

/// 停留时长：成功 6 秒，做不成与部分失败 8 秒——后两种要多读一会儿
export const TOAST_DWELL_MS: Record<ToastKind, number> = {
  success: 6000,
  cannot: 8000,
  partial: 8000,
};

export interface ToastAgent {
  id: string;
  name: string;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，原因进提示框（MCP 撤销：写入之后文件又被改过）
  disabledReason?: string;
}

export interface ToastProps {
  /// 默认 notice（黑显示窗）
  tier?: "notice" | "routine";
  /// routine 只有 success
  kind: ToastKind;
  /// **必填**：`写进` `开启` `清除` `删到废纸篓`；失败态用否定动词 `没开启`
  verb: string;
  /// agent 图标组（白 / 墨，随档）。图标自带读屏名
  agents?: ToastAgent[];
  /// 动词与名字之间的其他记号（删原件那个白色小方块）
  icons?: ReactNode;
  /// 名字：至多两个逐个写（顿号分隔），超过两个写 `+N`
  names?: string[];
  /// 名字之外的读数：`3 个`、部分失败的 `2 ✓ · 1 ⊘`（用 `tally`）
  reading?: ReactNode;
  /// 部分失败的读数：成功几个、没成几个
  tally?: { done: number; failed: number };
  /// 做不成 / 部分失败的一句能行动的原因，接在主行 ` · ` 后
  reason?: string;
  /// 副行：等宽 12 `ink-faint` 读数（路径、条数）
  stats?: string;
  /// 副行之下的展开内容（删原件的后果示意图与铭牌）；只给 notice
  detail?: ReactNode;
  /// notice：白描边紧凑键；routine：文字链。`撤销` `查看`
  action?: ToastAction;
  /// 次要的离开 Sophia 的文字链（带 ↗）：`在访达中显示备份 ↗`
  secondary?: ToastAction;
  /// 给了就到点自动消失
  onDismiss?: () => void;
  /// notice 右端的 ×。busy 期间照常可用
  onClose?: () => void;
}

const INDICATOR: Record<ToastKind, { title: string; glyph: ReactNode }> = {
  success: { title: "成功", glyph: <IconCheck /> },
  cannot: { title: "做不成", glyph: <IconCannot /> },
  partial: { title: "部分失败", glyph: <IconAttention /> },
};

function Names({ names }: { names: string[] }) {
  if (names.length <= 2) return <span className="ss-toast__names">{names.join("、")}</span>;
  return (
    <span className="ss-toast__more" title={names.join("、")} aria-label={names.join("、")}>
      +{names.length}
    </span>
  );
}

function Tally({ done, failed }: { done: number; failed: number }) {
  return (
    <span className="ss-toast__tally" aria-label={`${done} 个成功，${failed} 个没成`}>
      <span className="ss-toast__num">{done}</span>
      <IconCheck size={12} />
      <span className="ss-toast__sep">·</span>
      <span className="ss-toast__num">{failed}</span>
      <IconCannot size={12} />
    </span>
  );
}

export function Toast(props: ToastProps) {
  const {
    tier = "notice",
    kind,
    verb,
    agents,
    icons,
    names,
    reading,
    tally,
    reason,
    stats,
    detail,
    action,
    secondary,
    onDismiss,
    onClose,
  } = props;

  useEffect(() => {
    if (!onDismiss) return;
    const timer = setTimeout(onDismiss, TOAST_DWELL_MS[kind]);
    return () => clearTimeout(timer);
  }, [kind, onDismiss]);

  const main = (
    <>
      <span className="ss-toast__verb">{verb}</span>
      {agents && agents.length ? (
        <span className="ss-toast__agents">
          {agents.map((a) => (
            <AgentIcon key={a.id} id={a.id} name={a.name} labelled />
          ))}
        </span>
      ) : null}
      {icons}
      {names && names.length ? <Names names={names} /> : null}
      {reading ? <span className="ss-toast__reading">{reading}</span> : null}
      {tally ? <Tally {...tally} /> : null}
      {reason ? (
        <>
          <span className="ss-toast__sep">·</span>
          <span className="ss-toast__reason">{reason}</span>
        </>
      ) : null}
    </>
  );

  if (tier === "routine") {
    return (
      <div className="ss-toast ss-toast--routine" data-kind={kind} role="status">
        <span className="ss-toast__mark" title="成功" aria-hidden="true">
          <IconCheck />
        </span>
        {main}
        {action ? (
          <>
            <span className="ss-toast__sep">·</span>
            {action.disabledReason ? (
              <Tooltip content={action.disabledReason}>
                <span className="ss-toast__disabled" tabIndex={0}>
                  <Button variant="link" disabled disabledReason={action.disabledReason}>
                    {action.label}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button variant="link" onClick={action.onClick}>
                {action.label}
              </Button>
            )}
          </>
        ) : null}
        {secondary ? (
          <Button variant="external" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        ) : null}
      </div>
    );
  }

  const indicator = INDICATOR[kind];
  return (
    <div
      className={`ss-toast ss-toast--notice${detail ? " has-detail" : ""}`}
      data-kind={kind}
      role={kind === "success" ? "status" : "alert"}
    >
      <div
        className="ss-toast__indicator"
        title={indicator.title}
        role="img"
        aria-label={indicator.title}
      >
        {indicator.glyph}
      </div>
      <div className="ss-toast__body">
        <div className="ss-toast__main">
          {main}
          {action || onClose ? (
            <span className="ss-toast__actions">
              {action ? (
                <Button size="compact" onDark onClick={action.onClick}>
                  {action.label}
                </Button>
              ) : null}
              {onClose ? (
                <IconButton icon={<IconClose />} title="关闭" onDark onClick={onClose} />
              ) : null}
            </span>
          ) : null}
        </div>
        {stats ? <div className="ss-toast__stats">{stats}</div> : null}
        {detail ? <div className="ss-toast__detail">{detail}</div> : null}
      </div>
    </div>
  );
}

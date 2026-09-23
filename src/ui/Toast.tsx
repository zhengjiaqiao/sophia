import { useEffect, useState } from "react";
import type { FocusEvent, ReactNode } from "react";
import { AgentIcon } from "./AgentMark.tsx";
import { Button, IconButton } from "./Button.tsx";
import { IconAttention, IconCannot, IconCheck, IconClose } from "./icons.tsx";

/// 提示小窗（DESIGN「反馈的两种形态」「提示条分两档」，画板 Feedback「提示条」）。
///
/// **浮起的小窗只表示一件事：会自己消失。** 两档，严重程度决定打断程度（①）：
/// - `routine` 成功：画布底 + `layer` 圆角 + `tip` 阴影的白窗，单行高 32：`✓ 写进 [图标] 名字 · 撤销`
/// - `notice` 做不成 / 部分失败 / 新问题一次性提示：**黑显示窗**，左侧 40px 指示窗放 ✓ / ⊘ / !。
///   成功一律不用黑块：不给 `tier` 时按 `kind` 取（成功白、其余黑）
///
/// 文字一律 13（`caption`）：动词 600、名字 400、数字 `mono` 12——比表格正文 15 低一档，
/// 反馈永远不比它说的内容更重（②）。主行 = **动词 + agent 图标 + 名字**；动词与触发它的动作一致，
/// 失败态动词带否定（`没开启`）。单格失败原因本身是一整句时给 `message`，不拆动词。
///
/// **停留**（⑨）：成功无动作约 4 秒，带 `撤销` / `查看` 约 6 秒，做不成 / 部分失败 8 秒；
/// 悬停与键盘焦点在里面时停表，移开后重新计满；到点末尾 120ms 同一个淡出。
/// 不给 `onDismiss` 的不自动消失（新问题一次性提示）。
///
/// **位置不归组件管**：浮起的一律经 `FloatingToast`（锚在触发处，`placeToast`）或
/// `CornerToast`（右下，全应用一套）。带下一步的失败不用它，用内嵌灰面板 `NoticePanel`。

/// `attention`：没有哪个动作做成或没成，是机器发现了要你拿主意的事（新问题的一次性提示）。
/// 记号同部分失败的 `!`，读屏名是「需要注意」；它不给 onDismiss，不自动消失
export type ToastKind = "success" | "cannot" | "partial" | "attention";

/// 停留时长：带动作（撤销 / 查看）的成功 6 秒，做不成与部分失败 8 秒——后两种要多读一会儿；
/// 没有动作的成功约 4 秒（`CELL_TOAST_DWELL_MS`）。悬停 / 焦点在里面时不计时
export const TOAST_DWELL_MS: Record<ToastKind, number> = {
  success: 6000,
  cannot: 8000,
  partial: 8000,
  attention: 8000,
};

/// 没有动作的成功（单格、`✓ 已生效`、`✓ 已是最新版本`……）的停留：约 4 秒，比带撤销的 6 秒短——
/// 只是交代一声，结果本身已经画出来了
export const CELL_TOAST_DWELL_MS = 4000;

/// 到点时末尾这一段淡出，与 `--motion-fast` 同值
const LEAVE_MS = 120;

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
  /// 不给按 kind 取：成功 routine（白窗），其余 notice（黑窗）
  tier?: "notice" | "routine";
  /// routine 只有 success
  kind: ToastKind;
  /// `写进` `开启` `清除` `删到废纸篓`；失败态用否定动词 `没开启`。
  /// `attention` 没有动作可说，这里放句子的主语（`defuddle`）或 `发现`，其余进 `reading`。
  /// 只有给了整句 `message` 时才可以不给
  verb?: string;
  /// 整句（单格失败的原因本身就是一句话：`Codex 的 skills 目录写不进去`），写在动词的位置
  message?: ReactNode;
  /// 动词后半截，写在 agent 图标之后（带方向的「从 [图标] 移除 名字」）；只有一截动词时不给
  verbTail?: string;
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
  /// 给了就到点自动消失；不给就一直留着，直到调用方撤掉（新问题的一次性提示）
  onDismiss?: () => void;
  /// 停留时长（毫秒）；不给按 kind 与有没有动作取（见 `TOAST_DWELL_MS`）
  dwellMs?: number;
  /// notice 右端的 ×。busy 期间照常可用
  onClose?: () => void;
}

const INDICATOR: Record<ToastKind, { title: string; glyph: ReactNode }> = {
  success: { title: "成功", glyph: <IconCheck /> },
  cannot: { title: "做不成", glyph: <IconCannot /> },
  partial: { title: "部分失败", glyph: <IconAttention /> },
  attention: { title: "需要注意", glyph: <IconAttention /> },
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

/// 读数里的数量：数字等宽 12，量词随正文（`3 个`）。整段是一个元素，flex 的 gap 拆不开它
export function ToastCount({ n, unit = "个" }: { n: number; unit?: string }) {
  return (
    <span className="ss-toast__count">
      <span className="ss-toast__num">{n}</span>
      {`\u00a0${unit}`}
    </span>
  );
}

export function Toast(props: ToastProps) {
  const {
    kind,
    tier = kind === "success" ? "routine" : "notice",
    verb,
    message,
    verbTail,
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
    dwellMs,
  } = props;
  // 没有动作（撤销 / 查看）的成功只是一句告知，约 4 秒就走（同单格例行一行）；6 秒是留给点撤销的
  const dwell =
    dwellMs ?? (kind === "success" && !action ? CELL_TOAST_DWELL_MS : TOAST_DWELL_MS[kind]);
  // 悬停 / 焦点在里面：停表；到点前最后 120ms：淡出中
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!onDismiss || held) return;
    const timer = setTimeout(onDismiss, dwell);
    const fade = setTimeout(() => setLeaving(true), dwell - LEAVE_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(fade);
    };
  }, [dwell, onDismiss, held]);

  // 悬停与键盘焦点在里面时停表（两档同一套），移开后重新计满
  const hold = (on: boolean) => {
    setHeld(on);
    if (on) setLeaving(false);
  };
  const holdHandlers = onDismiss
    ? {
        onMouseEnter: () => hold(true),
        onMouseLeave: () => hold(false),
        onFocus: () => hold(true),
        onBlur: (e: FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold(false);
        },
      }
    : {};
  const leavingClass = leaving ? " is-leaving" : "";

  const main = (
    <>
      {message !== undefined ? <span className="ss-toast__message">{message}</span> : null}
      {verb ? <span className="ss-toast__verb">{verb}</span> : null}
      {agents && agents.length ? (
        <span className="ss-toast__agents">
          {agents.map((a) => (
            <AgentIcon key={a.id} id={a.id} name={a.name} labelled />
          ))}
        </span>
      ) : null}
      {icons}
      {verbTail ? <span className="ss-toast__verb">{verbTail}</span> : null}
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
      <div
        className={`ss-toast ss-toast--routine${leavingClass}`}
        data-kind={kind}
        role="status"
        {...holdHandlers}
      >
        <span className="ss-toast__mark" title="成功" aria-hidden="true">
          <IconCheck />
        </span>
        {main}
        {action ? (
          <>
            <span className="ss-toast__sep">·</span>
            {action.disabledReason ? (
              <Button variant="link" disabled disabledReason={action.disabledReason}>
                {action.label}
              </Button>
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
      className={`ss-toast ss-toast--notice${detail ? " has-detail" : ""}${leavingClass}`}
      data-kind={kind}
      role={kind === "success" || kind === "attention" ? "status" : "alert"}
      {...holdHandlers}
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

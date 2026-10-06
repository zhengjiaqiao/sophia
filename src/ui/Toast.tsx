import { Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, ReactNode, Ref } from "react";
import { formatRich, listText, locale, t, tn, tRich, type MessageKey } from "../i18n.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { Button, IconButton } from "./Button.tsx";
import { BusySlot, BusyToast } from "./BusySlot.tsx";
import { ToastPlacementContext, ToastRelayoutContext } from "./FloatingToast.tsx";
import { IconAttention, IconCannot, IconClose, IconTick } from "./icons.tsx";
import { motionMs } from "./motion.ts";
import { sentencePieces } from "./sentence.tsx";
import { Tooltip } from "./Tooltip.tsx";

/// 提示小窗（DESIGN「反馈的两种形态」，DESIGN-components「提示条 Toast」，画板 Feedback「提示条」）。
///
/// **浮起的小窗只表示一件事：会自己消失。** 两种长相，**由出在哪定，不由 kind 定**（2026-10-04 产品负责人：
/// 「toast 拆分两种，一种是在锚点位置出的，用轻量级的，一种是全局页面的，在页面右下角出，用带记号栏的」）：
/// - 锚点（`FloatingToast` 里，routine 档）：成功、做不成、部分失败都是轻量一行纸窗（`paper` + 1px `hairline` 边 +
///   `float` 12 圆角 + 浮层投影），单行高 32、最宽 420；状态记号在句首：✓（勾选框里同一枚 `IconTick`）/ ⊘ / !。
///   键行内（` · 撤销`），失败的 × 在最后。放不下、或有副行（路径）时折成两行：记号自成一格，
///   第二行（读数 / 路径）缩进到记号之后，与整句的字对齐
/// - 右下（`CornerToast` / `ToastStack` 里，notice 档）：都带左侧 40px 记号栏（✓ / ⊘ / !），宽 ≤ 400。
///   放得下时一行，键与 × 在主行右端；放不下时折成两行（issue #111，同锚点档「两行」）：字在左——整句一行、
///   原因换到第二行（12 `ink-mute`），键与 × 在右侧、跨两行上下居中，不掉到字的下面
///
/// 位置由外壳经 `ToastPlacementContext` 给，调用方不传；不在任何外壳里（测试、画廊）按锚点档。
/// 墨色浮窗只给提示框（2026-09-25 起）：失败与成功靠句首记号与否定动词分，不靠颜色。
/// 提示条里不放可展开的内容（2026-10-04 产品负责人）。
///
/// 文字一律 13（`caption`）：动词 600、名字 400、数字 12 tabular——比表格正文 15 低一档，
/// 反馈永远不比它说的内容更重（②）。主行 = **动词 + agent 图标 + 名字**；动词与触发它的动作一致。
///
/// **主行是一个整句**（`sentence`，目录键，2026-09-30 为多语言改）：值里 `{agents}`（agent 图标组）、
/// `{names}`（名字，没有名字时是 `reading` 里的数量）两个占位符由组件填，语序归各语言的译文
/// （`加到 [图标] 名字` / `Added 名字 to [图标]`）。文字段渲染成动词（600），嵌入的节点保留自己的类；
/// **失败句是它自己的一句**（`名字 加到 [图标] 失败`，2026-09-29 产品负责人：「没更新」读起来像状态，
/// 看不出是失败），不靠组件在后面接「失败」。整句之后照旧接 `tally`、`trail`、`reason`。
/// 整句写法在 `toastFor`（toastText.ts）里按操作 × 成功 / 做不成 / 部分失败选键；安装、更新、来源等
/// 各自在自己区块里写成功 / 做不成 / 部分失败三句。主行只有这一种写法，没有「动词 + 失败」的拼接。
/// 单格失败原因本身是一整句时给 `message`。
/// 名字后要接几段读数（`已添加 WeiboAP · 39 个 skill`、`不在列表里显示了 · 已建好的链接原样留着`）给 `trail`，
/// 各段前一个 ` · `；`reason` 只给做不成 / 部分失败的原因，成功档不借它
///
/// **停留**（⑨）：成功无动作约 3 秒，带 `撤销` 约 6 秒，做不成 / 部分失败 8 秒；
/// 悬停与键盘焦点在里面时停表，移开后只再留 1.5 秒（不从头计满：提示就浮在刚点的那一格下，指针常常顺手停在上面，
/// 2026-09-30 产品负责人：「这个提示为什么不自动消失……好像是太慢了」）；到点末尾 120ms 同一个淡出。
/// 不给 `onDismiss` 的不自动消失。
///
/// **忙碌形态**（`<Toast busy="正在拆开" />`）：结果出来之前，同一个位置先说在忙什么——同成功的单行纸窗，
/// 句首 14 宽刻度（`BusyToast`）；不计时、不自己走，忙完由调用方换成结果那一窗。门槛（0.3 秒）归调用方或 `BusySlot`。
///
/// **位置不归组件管**：浮起的一律经 `FloatingToast`（锚在触发处，`placeToast`）或
/// `CornerToast`（右下，全应用一套）。带下一步的失败不用它，用内嵌灰面板 `NoticePanel`。

export type ToastKind = "success" | "cannot" | "partial";

/// 停留时长：带动作（撤销）的成功 6 秒，做不成与部分失败 8 秒——后两种要多读一会儿；
/// 没有动作的成功约 4 秒（`CELL_TOAST_DWELL_MS`）。悬停 / 焦点在里面时不计时
export const TOAST_DWELL_MS: Record<ToastKind, number> = {
  success: 6000,
  cannot: 8000,
  partial: 8000,
};

/// 没有动作的成功（单格、`✓ 已生效`、`✓ 已是最新版本`……）的停留：约 3 秒，比带撤销的 6 秒短——
/// 只是交代一声，结果本身已经画出来了（2026-09-30 产品负责人：4 秒「太慢了」）
export const CELL_TOAST_DWELL_MS = 3000;

/// 悬停 / 焦点移开之后再留多久（不从头计满）
export const TOAST_LEAVE_MS = 1500;

export interface ToastAgent {
  id: string;
  name: string;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，原因进提示框（MCP 撤销：写入之后文件又被改过）
  disabledReason?: string;
  /// 点下去之后在等（MCP 撤销要等 core 从快照还原）：只锁这一颗，过了 0.3 秒门槛原位换成
  /// 忙碌刻度 + 这一句（`正在撤销`，见 `BusySlot`）
  busy?: string;
}

export interface ToastProps {
  /// 成功、做不成、部分失败：定句首（或记号栏里）的记号、停留时长与读屏的紧急程度；长相由位置定
  kind: ToastKind;
  /// 主行整句（目录键）：值里 `{agents}` 是 agent 图标组、`{names}` 是名字（没有名字时是 `reading`）。
  /// 做不成 / 部分失败各有各的句子（`名字 加到 [图标] 失败`）。只给 `message` 时可以不给
  sentence?: MessageKey;
  /// 整句（单格失败的原因本身就是一句话：`无法写入 Codex 的 skills 目录`），写在整句的位置
  message?: ReactNode;
  /// agent 图标组（`ink`）。图标自带读屏名
  agents?: ToastAgent[];
  /// 动词与名字之间的其他记号（删原件那个白色小方块）；整句里跟在图标组之后
  icons?: ReactNode;
  /// 名字：至多两个逐个写（`listText` 连接），超过两个写 `+N`
  names?: string[];
  /// 句中的生效范围名（`移到 {place} {names}`）：并进动词那段文字，与汉字相接的空格由 `sentencePieces` 收掉
  place?: string;
  /// 名字之外的读数：`ToastCount` 的 `3 个`（整句里占 `{names}` 的位置）；部分失败的 `2 ✓ · 1 ⊘` 用 `tally`
  reading?: ReactNode;
  /// 部分失败的读数：成功几个、没成几个
  tally?: { done: number; failed: number };
  /// 名字之后 ` · ` 隔开的几段读数（`39 个 skill`）或补一句（`已建好的链接原样留着`）：成功档用，
  /// 各段前一个 ` · `（ink-faint）
  trail?: string[];
  /// 做不成 / 部分失败的一句能行动的原因，接在主行 ` · ` 后
  reason?: string;
  /// 副行：等宽 12 读数（路径、条数，`ink-mute`），可拖选
  stats?: string;
  /// 默认键紧凑 24。`撤销`
  action?: ToastAction;
  /// 带人去处理的那颗默认键紧凑（装完提示里的 `去处理`，issue #111）：排在 `action` 前——先读到出了什么事，
  /// 再看到去处理，撤销在它后面
  go?: ToastAction;
  /// 次要的离开 Sophia 的动作：浅键，末尾自动带 ↗（`在访达中显示备份`）
  secondary?: ToastAction;
  /// 给了就到点自动消失；不给就一直留着，直到调用方撤掉
  onDismiss?: () => void;
  /// 停留时长（毫秒）；不给按 kind 与有没有动作取（见 `TOAST_DWELL_MS`）
  dwellMs?: number;
  /// 右端的 ×（锚点档在键之后，右下档在键区末尾）。busy 期间照常可用
  onClose?: () => void;
}

/// 状态记号：锚点档放在句首，右下档放在记号栏里——同一枚，只差放在哪
const MARK: Record<ToastKind, { titleKey: MessageKey; glyph: ReactNode }> = {
  success: { titleKey: "toast.success.mark", glyph: <IconTick /> },
  cannot: { titleKey: "toast.indicator.cannot", glyph: <IconCannot /> },
  partial: { titleKey: "toast.indicator.partial", glyph: <IconAttention /> },
};

function Names({ names }: { names: string[] }) {
  const joined = listText(names);
  if (names.length <= 2) return <span className="ss-toast__names">{joined}</span>;
  return (
    // 藏起来的名字经提示框出（不写原生 title：悬停弹系统灰框）
    <Tooltip content={joined} focusable>
      <span className="ss-toast__more" aria-label={joined}>
        +{names.length}
      </span>
    </Tooltip>
  );
}

function Tally({ done, failed }: { done: number; failed: number }) {
  return (
    <span className="ss-toast__tally" aria-label={t("toast.tally.label", { done, failed })}>
      <span className="ss-toast__num">{done}</span>
      <IconTick />
      <span className="ss-toast__sep">·</span>
      <span className="ss-toast__num">{failed}</span>
      <IconCannot size={12} />
    </span>
  );
}

/// 数字在整句里的占位：按数量取句（`tn` 按 `n` 选单复数），数字位置留给带样式的节点
const COUNT_SLOT = "{num}";

/// 读数里的数量：数字等宽 12，量词随正文（`3 个`）。整段是一个元素，flex 的 gap 拆不开它。
/// `line` 是带 `{count}` 的目录键（数的是什么由调用方定：`toast.count.skills` / `toast.count.mcp`＝`{count} 个`，更新用 `market.update.count`＝`{count} 个 skill`；英文各有单复数）：
/// 整句取出后数字换成 `ss-toast__num`，单位与语序随语言
export function ToastCount({ n, line }: { n: number; line: MessageKey }) {
  return (
    <span className="ss-toast__count">
      {formatRich(tn(line, n, { count: COUNT_SLOT }), {
        num: <span className="ss-toast__num">{n}</span>,
      })}
    </span>
  );
}

/// 主行整句：`{agents}` 换成 agent 图标组，`{names}` 换成名字（没有名字时是读数）；
/// 文字段是动词（600），嵌进去的节点各带各的类
function Sentence({
  line,
  agents,
  icons,
  names,
  reading,
  place,
}: Pick<ToastProps, "agents" | "icons" | "names" | "reading" | "place"> & { line: MessageKey }) {
  const agentsNode =
    (agents && agents.length) || icons ? (
      <>
        {agents && agents.length ? (
          <span className="ss-toast__agents">
            {agents.map((a) => (
              <AgentIcon key={a.id} id={a.id} name={a.name} labelled />
            ))}
          </span>
        ) : null}
        {icons}
      </>
    ) : null;
  const hasNames = Boolean(names && names.length);
  const namesNode =
    hasNames || reading ? (
      <>
        {hasNames ? <Names names={names ?? []} /> : null}
        {reading ? <span className="ss-toast__reading">{reading}</span> : null}
      </>
    ) : null;
  return (
    <>
      {sentencePieces(
        tRich(line, {
          agents: agentsNode,
          names: namesNode,
          ...(place !== undefined ? { place } : {}),
        }),
        (text, key) => (
          <span key={key} className="ss-toast__verb">
            {text}
          </span>
        ),
      )}
    </>
  );
}

/// 忙碌形态：只有一句「在忙什么」
export interface ToastBusyProps {
  busy: string;
}

export function Toast(props: ToastProps | ToastBusyProps) {
  if ("busy" in props) return <BusyToast label={props.busy} />;
  return <ResultToast {...props} />;
}

/// 一颗默认键紧凑 24：禁用带原因；在等时原位忙碌
function CompactKey({ action }: { action: ToastAction }) {
  return action.disabledReason ? (
    <Button size="compact" disabled disabledReason={action.disabledReason}>
      {action.label}
    </Button>
  ) : (
    <BusySlot busy={action.busy !== undefined} label={action.busy ?? ""}>
      <Button size="compact" onClick={action.onClick}>
        {action.label}
      </Button>
    </BusySlot>
  );
}

/// 键区：去处理、动作（默认键紧凑 24）+ 次要的离开 Sophia 的浅键。两档共用
function ActionKeys({ go, action, secondary }: Pick<ToastProps, "go" | "action" | "secondary">) {
  return (
    <>
      {go ? <CompactKey action={go} /> : null}
      {action ? <CompactKey action={action} /> : null}
      {secondary ? (
        secondary.disabledReason ? (
          <Button variant="quiet" disabled disabledReason={secondary.disabledReason}>
            {secondary.label}
          </Button>
        ) : (
          <Button variant="quiet" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )
      ) : null}
    </>
  );
}

/// 右端的 ×（提示框「关闭」）
function CloseKey({ onClose }: { onClose: () => void }) {
  return <IconButton icon={<IconClose />} title={t("common.close")} onClick={onClose} />;
}

/// 锚点档（轻量一行）的内容，两种排法（第三批画板 8A；2026-10-04 起三种 kind 共用）：
/// - 一行（`wrapped` 为 false，放得下最宽 420 时；简体的短句都是这种）：记号、`flat`——整句、` · 读数` / ` · 原因`——之后接
///   ` · ` 与键、×，都是纸窗根下的兄弟（成功的与改版前逐字相同）
/// - 两行（放不下、或有副行时）：记号自成一格；整句一行（`line`）；读数（`trail`）或路径（`stats`）换到第二行，
///   12 `ink-mute`，与整句的字对齐（缩在记号之后）；键与 × 在右侧、跨两行上下居中
export function RoutineLines({
  wrapped,
  mark,
  flat,
  line,
  trail,
  stats,
  go,
  action,
  secondary,
  onClose,
}: {
  wrapped: boolean;
  mark?: ReactNode;
  flat: ReactNode;
  line: ReactNode;
  trail?: string[];
  stats?: string;
  go?: ToastAction;
  action?: ToastAction;
  secondary?: ToastAction;
  onClose?: () => void;
}) {
  const close = onClose ? (
    <span className="ss-toast__close">
      <CloseKey onClose={onClose} />
    </span>
  ) : null;
  if (!wrapped)
    return (
      <>
        {mark}
        {flat}
        {action || go ? <span className="ss-toast__sep">·</span> : null}
        <ActionKeys go={go} action={action} secondary={secondary} />
        {close}
      </>
    );
  return (
    <>
      {mark}
      <span className="ss-toast__line">{line}</span>
      {trail?.length ? (
        <span className="ss-toast__trailline">
          {trail.map((part, i) => (
            <Fragment key={i}>
              {i > 0 ? <span className="ss-toast__sep">·</span> : null}
              <span>{part}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
      {stats ? <div className="ss-toast__stats ss-selectable">{stats}</div> : null}
      {go || action || secondary || close ? (
        <span className="ss-toast__keys">
          <ActionKeys go={go} action={action} secondary={secondary} />
          {close}
        </span>
      ) : null}
    </>
  );
}

/// 右下档（notice）的正文，两种排法（issue #111，画板 #105 第七稿第 3 节，同锚点档「两行」的规则）：
/// - 一行（`wrapped` 为 false，放得下宽 ≤ 400 时）：整句、` · 读数`、` · 原因`，键与 × 在主行右端；副行（路径）在主行下
/// - 两行（放不下时）：字在左一格——整句一行（`main`），读数（`trail`，段间 ` · `）与原因各换到下一行
///   （`ss-toast__sub`，12 `ink-mute`），副行再下；键与 × 在右侧一格、跨两行上下居中，不掉到字的下面
export function NoticeLines({
  wrapped,
  main,
  trail,
  reason,
  stats,
  go,
  action,
  secondary,
  onClose,
  bodyRef,
}: {
  wrapped: boolean;
  /// 整句（含计数）；读数与原因不在里面
  main: ReactNode;
  trail?: string[];
  reason?: string;
  stats?: string;
  go?: ToastAction;
  action?: ToastAction;
  secondary?: ToastAction;
  onClose?: () => void;
  /// 量放不放得下用（一行时横向溢出就折成两行）
  bodyRef?: Ref<HTMLDivElement>;
}) {
  const keys =
    go || action || secondary || onClose ? (
      <span className="ss-toast__actions">
        <ActionKeys go={go} action={action} secondary={secondary} />
        {onClose ? <CloseKey onClose={onClose} /> : null}
      </span>
    ) : null;
  const statsLine = stats ? <div className="ss-toast__stats ss-selectable">{stats}</div> : null;
  if (wrapped)
    return (
      <div ref={bodyRef} className="ss-toast__body is-two">
        <div className="ss-toast__text">
          <div className="ss-toast__main">{main}</div>
          {trail?.length ? (
            <div className="ss-toast__sub">
              {trail.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 ? <span className="ss-toast__sep">·</span> : null}
                  <span>{part}</span>
                </Fragment>
              ))}
            </div>
          ) : null}
          {reason ? <div className="ss-toast__sub">{reason}</div> : null}
          {statsLine}
        </div>
        {keys}
      </div>
    );
  return (
    <div ref={bodyRef} className="ss-toast__body">
      <div className="ss-toast__main">
        {main}
        {trail?.map((part, i) => (
          <span key={i} className="ss-toast__trail">
            <span className="ss-toast__sep">·</span>
            <span>{part}</span>
          </span>
        ))}
        {reason ? (
          <>
            <span className="ss-toast__sep">·</span>
            <span className="ss-toast__reason">{reason}</span>
          </>
        ) : null}
        {keys}
      </div>
      {statsLine}
    </div>
  );
}

function ResultToast(props: ToastProps) {
  const {
    kind,
    sentence,
    message,
    agents,
    icons,
    names,
    place,
    reading,
    tally,
    trail,
    reason,
    stats,
    go,
    action,
    secondary,
    onDismiss,
    onClose,
    dwellMs,
  } = props;
  // 没有动作（撤销）的成功只是一句告知，约 3 秒就走（同单格例行一行）；6 秒是留给点撤销的
  const full =
    dwellMs ?? (kind === "success" && !action ? CELL_TOAST_DWELL_MS : TOAST_DWELL_MS[kind]);
  // 悬停 / 焦点在里面：停表；到点前最后 120ms：淡出中。停过一次之后，移开只再留一小段（不从头计满）
  const [held, setHeld] = useState(false);
  const [wasHeld, setWasHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const dwell = wasHeld ? Math.min(full, TOAST_LEAVE_MS) : full;

  useEffect(() => {
    if (!onDismiss || held) return;
    const timer = setTimeout(onDismiss, dwell);
    // 末尾这一段淡出，时长取 `--motion-fast`（tokens.css 一处）
    const fade = setTimeout(() => setLeaving(true), dwell - motionMs("--motion-fast"));
    return () => {
      clearTimeout(timer);
      clearTimeout(fade);
    };
  }, [dwell, onDismiss, held]);

  // 悬停与键盘焦点在里面时停表（两档同一套），移开后只再留 `TOAST_LEAVE_MS`
  const hold = (on: boolean) => {
    setHeld(on);
    if (on) {
      setLeaving(false);
      setWasHeld(true);
    }
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

  // 出在哪定长相：锚点轻量一行，右下带记号栏（外壳给，调用方不传）
  const placement = useContext(ToastPlacementContext);
  const anchored = placement === "anchored";

  // 放不下时折成两行（锚点档最宽 420，画板 8A；右下档宽 ≤ 400，issue #111）：先按一行画，挂上之后量一次，
  // 横向溢出才折。记下是为哪一份内容折的——内容（或界面语言）换了就回到一行重量。锚点档折了之后请浮起外壳
  // 按新尺寸再定一次位（它在同一刻按一行量过）；有副行（路径）的锚点档一开始就是两行
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const relayout = useContext(ToastRelayoutContext);
  const fit = [
    locale(),
    sentence,
    agents?.map((a) => a.id).join(),
    names?.join("\n"),
    trail?.join("\n"),
    typeof message === "string" ? message : "",
    reason,
    go?.label,
    action?.label,
    secondary?.label,
  ].join("\u0000");
  const [wrappedFor, setWrappedFor] = useState<string | null>(null);
  const wrapped = (anchored && Boolean(stats)) || wrappedFor === fit;
  useLayoutEffect(() => {
    const el = anchored ? boxRef.current : bodyRef.current;
    if (wrapped || !el) return;
    if (el.scrollWidth > el.clientWidth) {
      setWrappedFor(fit);
      if (anchored) relayout?.();
    }
  });

  const lead =
    sentence !== undefined ? (
      <Sentence
        line={sentence}
        agents={agents}
        icons={icons}
        names={names}
        reading={reading}
        place={place}
      />
    ) : null;
  const tallyNode = tally ? <Tally {...tally} /> : null;
  const reasonNode = reason ? (
    <>
      <span className="ss-toast__sep">·</span>
      <span className="ss-toast__reason">{reason}</span>
    </>
  ) : null;
  const main = (
    <>
      {message !== undefined ? <span className="ss-toast__message">{message}</span> : null}
      {lead}
      {tallyNode}
      {trail?.map((part, i) => (
        <span key={i} className="ss-toast__trail">
          <span className="ss-toast__sep">·</span>
          <span>{part}</span>
        </span>
      ))}
      {reasonNode}
    </>
  );

  const { titleKey, glyph } = MARK[kind];
  const role = kind === "success" ? "status" : "alert";

  if (anchored) {
    // 句首记号：成功的 ✓ 只是装饰（整句已说成了）；失败的 ⊘ / ! 给读屏一个名字
    const mark =
      kind === "success" ? (
        <span className="ss-toast__mark" aria-hidden="true">
          {glyph}
        </span>
      ) : (
        <span className="ss-toast__mark" role="img" aria-label={t(titleKey)}>
          {glyph}
        </span>
      );
    return (
      <div
        ref={boxRef}
        className={`ss-toast ss-toast--routine${wrapped ? " is-wrapped" : ""}${leavingClass}`}
        data-kind={kind}
        role={role}
        {...holdHandlers}
      >
        <RoutineLines
          wrapped={wrapped}
          mark={mark}
          flat={main}
          line={
            wrapped ? (
              <>
                {message !== undefined ? (
                  <span className="ss-toast__message">{message}</span>
                ) : null}
                {lead}
                {tallyNode}
                {reasonNode}
              </>
            ) : null
          }
          trail={trail}
          stats={stats}
          go={go}
          action={action}
          secondary={secondary}
          onClose={onClose}
        />
      </div>
    );
  }

  // 右下：左侧 40 记号栏（✓ / ⊘ / !）；放不下一行时字在左两行、键与 × 在右侧跨两行居中
  return (
    <div
      className={`ss-toast ss-toast--notice${wrapped ? " is-wrapped" : ""}${leavingClass}`}
      data-kind={kind}
      role={role}
      {...holdHandlers}
    >
      <div className="ss-toast__indicator" role="img" aria-label={t(titleKey)}>
        {glyph}
      </div>
      <NoticeLines
        wrapped={wrapped}
        main={
          <>
            {message !== undefined ? <span className="ss-toast__message">{message}</span> : null}
            {lead}
            {tallyNode}
          </>
        }
        trail={trail}
        reason={reason}
        stats={stats}
        go={go}
        action={action}
        secondary={secondary}
        onClose={onClose}
        bodyRef={bodyRef}
      />
    </div>
  );
}

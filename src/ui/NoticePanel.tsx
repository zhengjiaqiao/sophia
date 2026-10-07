import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n.ts";
import { BusySlot } from "./BusySlot.tsx";
import { Button, IconButton } from "./Button.tsx";
import { Details } from "./Details.tsx";
import { IconAttention, IconClose } from "./icons.tsx";
import { motionMs } from "./motion.ts";

/// 灰面板（DESIGN-components「灰面板 NoticePanel」）：嵌在页面里、**不会自己走**的一句。
/// 放在机面里的 `surface` 灰面板（`face` 12 圆角、无边无投影），一句 + 至多两颗默认键（紧凑 24，纸面在灰上
/// 读得出是一颗键）。大面积不用墨——一整条黑太重。原来的新手提示条 `HintStrip` 并进来了（2026-10-04 产品负责人：
/// 「NoticePanel 和 HintStrip 是不是可以合并？」），**意思只靠两端分**：
/// - 左端 `!`（`mark`，默认有）：有问题、要你处理（那条链路此刻不通、或一件待办；问题解决自动收起）
/// - 没有 `!`：一次性说明（第一次来时说这里怎么用、有新版本、同名原件）
/// - 右端 ×（`onClose`）：能关；没有 × 的不能关。× 的提示框（`dismissTitle`）默认：有 `!` 的写「关闭」，
///   没有 `!` 的写「知道了，不再提示」
/// 与提示条的区别：提示条是某次操作的结果、浮起、会自己走；灰面板嵌在页面里，不自己走。
///
/// 一个组件三种范围（`scope`），意思相同、只差放在哪（原来的 `ErrorBanner` 就是 `scope="app"`）：
/// - `app` 应用级：机面顶上、页面头之上，满内容宽；主句 15 `ink` + 可选第二行 `detail` 13 `ink-mute`，内边距 12 16
/// - `section` 节：**占满所在容器的宽**（块级 flex、`align-self: stretch`）：放进哪一块就铺满哪一块，宽由容器定、
///   组件不自己限宽；键被推到右端控件列，主句占满中间、放不下折行。一次性说明都用这一档（宽 776，左沿对齐表格）
/// - `row` 行（默认）：挂在某一行下面，宽随内容
/// `section` / `row` 同一套量：13 号字、内边距 8 12、最矮 40（键 24 + 上下 8）。
///
/// 原因（`reason`）跟在主句后同一行写出（`ink-mute`），不藏进悬停——原因决定下一步怎么做。写全，放不下就折行。
/// 技术原文（`technical` + `onCopy`，spec 2026-10-04-local-diagnostics R13）：左端的 `!` 就是入口——做成图标键
/// （`Details`，2026-10-06 方案 D），停上去或点一下浮起悬浮卡；面板里不展开、键区不多一颗键，句子照旧是字。
/// 出错的灰面板除了 `详情` 还要给一条往前走的路（再试一次、修复、打开文件……），不能只有 `详情`。
/// 正在执行（`busy`）：键先锁住，过了 0.3 秒门槛原位换成忙碌刻度 + 这一句（`BusySlot`），不再出两颗键；
/// 只锁其中一颗时给那颗键自己的 `busy`。
///
/// **进出**（给了 `open`，一次性说明的用法）：淡入淡出 + 高度 0 ↔ 自身高度，`--dur-drawer` `--ease-mech`，推动下方内容；
/// 减少动效时即时。**上下外距 16 由组件自带**，收起时与高度一起滑回 0；`flush`：上方的间距归宿主，只带下外距 16——
/// 宿主据根上的 `data-hint="open"`（展开态，与高度动画同一帧）写 `:has(> [data-hint="open"])`，页面不认内部类。
/// 几张同时要出时叠放（`useHintStack`）：只展开最上面一张，`stacked` 张数在条下露一两道薄边，不露底下那张的字。
/// 何时出由调用方定（新手提示走 `src/hints.ts` 的 `useHint`），这里只管长相与进出。

export type NoticeScope = "app" | "section" | "row";

export interface NoticePanelAction {
  label: string;
  onClick: () => void;
  /// 给了就禁用，原因进提示框（按下当即出）
  disabledReason?: string;
  /// 点下去之后在等：只锁这一颗，过了 0.3 秒门槛原位换成忙碌刻度 + 这一句（`正在更新`，见 `BusySlot`）
  busy?: string;
  /// 这颗键会离开 Sophia（`打开文件 ↗`）：画成浅键，末尾自带 `↗`（DESIGN「按钮」浅键＝离开 Sophia；灰面板里键面换 paper）
  leave?: boolean;
}

export interface NoticePanelProps {
  /// 放在哪：`app` 应用级 / `section` 一节里 / `row` 一行下（默认）
  scope?: NoticeScope;
  /// 一句：后果（`改动要重启 Codex 才生效`）或说明（只说用户此刻不确定的事）。动词 600 用 <b> 包；路径用等宽包一层再传进来
  message: ReactNode;
  /// 原因（`端口 47328 被别的程序占着`）：跟在主句后同一行，`ink-mute`，写全、可折行
  reason?: string;
  /// 第二行（`app` 用）：`ink-mute` 的补充说明，另起一行
  detail?: ReactNode;
  /// 默认键，紧凑 24（`再试一次` `重启路由` `只看这些`）
  action?: NoticePanelAction;
  /// 可选的第二颗键（`稍后` `全部更新`）：同样是默认键紧凑 24——应用内能点的一律默认键
  secondary?: NoticePanelAction;
  /// 技术原文（请求、状态码、返回的错误；调用方已去隐私）：给了（连同 `onCopy`）左端的 `!` 才是入口
  technical?: string;
  /// `详情` 浮层里的 `复制详情`：调用方先去隐私再写剪贴板（组件库不碰 api）
  onCopy?: (text: string) => void | Promise<void>;
  /// 正在执行：`正在接管`（两颗键一起换）
  busy?: string;
  /// 左端 `!`：有问题、要你处理（默认）。一次性说明给 false
  mark?: boolean;
  /// 可关的才给右端 ×（行下失败原因、一次性说明可关；接管 / 重新写入这类待办不可关，问题解决自动消失）
  onClose?: () => void;
  /// × 的提示框与读屏名。不给：有 `!` 的「关闭」，没有 `!` 的「知道了，不再提示」
  dismissTitle?: string;
  /// 给了就能进出：变 false 时先收起、动画走完再卸下（一次性说明的用法）
  open?: boolean;
  /// 进出时不带上外距（上方的间距归宿主，见上）
  flush?: boolean;
  /// 下面还压着几张（`useHintStack` 的 `below`）：条下露一两道没有内容的薄边，至多两道
  stacked?: number;
}

/// 几张一次性说明同时想出时（2026-09-30 产品负责人：「叠放在上面，用户处理完一个再处理下一个，注意不要把底下的
/// 漏出来」）：只展开登记顺序里第一张想出的，其余算压在它下面的张数
export function hintStackOf(items: ReadonlyArray<{ key: string; want: boolean }>): {
  top: string | null;
  below: number;
} {
  const wanted = items.filter((i) => i.want);
  return { top: wanted[0]?.key ?? null, below: Math.max(0, wanted.length - 1) };
}

/// 叠放的那几张此刻展开哪一张：换张时先等上一张收起（`--dur-drawer`）再展开下一张，两张不同时半开——
/// 收起、展开的动画叠在一起，底下那张的字就漏出来了。调用方把 `open={top === key}`、`stacked={below}` 给各张
export function useHintStack(items: ReadonlyArray<{ key: string; want: boolean }>): {
  top: string | null;
  below: number;
} {
  const { top: next, below } = hintStackOf(items);
  const [top, setTop] = useState<string | null>(next);
  /// 上一张正在收起：收完（`--dur-drawer`）之前谁都不展开
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (top === next) return;
    if (top !== null) {
      // 先收起现在这张，收完再换；减少动效时收起是即时的
      setTop(null);
      setClosing(motionMs("--dur-drawer") > 0);
      return;
    }
    // 本来什么都没开（或上一张已收完）：当即展开
    if (!closing) setTop(next);
  }, [top, next, closing]);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => setClosing(false), motionMs("--dur-drawer"));
    return () => window.clearTimeout(t);
  }, [closing]);
  return { top, below: top === null ? 0 : below };
}

/// 进出：在不在 DOM 里（收起动画期间仍在）、展开态（先以收起态挂上，再加上它，过渡才有起点）。
/// 不进出的（没给 `open`）一直在、一直展开，不走这两步
function useSlide(open: boolean, enabled: boolean) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    // 收起动画走完再卸：时长与 ui.css 同取 `--dur-drawer`（减少动效时是 0，即时卸）
    const ms = motionMs("--dur-drawer");
    if (ms === 0) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, enabled]);

  // 收起态已写进 DOM、还没画出来：量一次让它落进样式，再展开（不靠 requestAnimationFrame，窗口在后台时它会停）
  useLayoutEffect(() => {
    if (!enabled || !open || !mounted || shown) return;
    ref.current?.getBoundingClientRect();
    setShown(true);
  }, [enabled, open, mounted, shown]);

  return { mounted, shown, ref };
}

/// 一颗键（默认键紧凑 24）。包层带 `data-hint-action`：调用方把按下这颗键的结果锚在它下面（公开钩子，不认内部类）
function PanelKey({ action }: { action: NoticePanelAction }) {
  const variant = action.leave ? "quiet" : "default";
  const key = action.disabledReason ? (
    <Button variant={variant} size="compact" disabled disabledReason={action.disabledReason}>
      {action.label}
    </Button>
  ) : (
    <Button variant={variant} size="compact" onClick={action.onClick}>
      {action.label}
    </Button>
  );
  return (
    <span className="ss-noticepanel__key" data-hint-action={action.label}>
      <BusySlot busy={action.busy !== undefined} label={action.busy ?? ""}>
        {key}
      </BusySlot>
    </span>
  );
}

export function NoticePanel({
  scope = "row",
  message,
  reason,
  detail,
  action,
  secondary,
  technical,
  onCopy,
  busy,
  mark = true,
  onClose,
  dismissTitle,
  open,
  flush = false,
  stacked = 0,
}: NoticePanelProps) {
  const sliding = open !== undefined;
  const { mounted, shown, ref } = useSlide(open ?? true, sliding);
  if (sliding && !mounted) return null;

  const app = scope === "app";
  const keys =
    action || secondary ? (
      <span className="ss-noticepanel__actions">
        {action ? <PanelKey action={action} /> : null}
        {secondary ? <PanelKey action={secondary} /> : null}
      </span>
    ) : null;
  const markTitle = app ? t("common.noticePanel.app") : t("common.noticePanel.needsYou");
  const closeTitle =
    dismissTitle ?? (mark ? t("common.close") : t("common.noticePanel.dismissHint"));
  // 有 `!` 的是要处理的事（应用级是故障，读屏当即念）；没有的是一次性说明
  const role = mark ? (app ? "alert" : "status") : "note";
  const panel = (
    <div
      className={`ss-noticepanel ss-noticepanel--${scope}`}
      role={role}
      aria-label={mark ? undefined : t("common.noticePanel.hint")}
    >
      {technical && onCopy ? (
        // 有原文：`!` 是图标键，停上去或点一下出悬浮卡（没有原文的 `!` 照旧只是记号）
        <span className="ss-noticepanel__mark">
          <Details text={technical} onCopy={onCopy} />
        </span>
      ) : mark ? (
        <span className="ss-noticepanel__mark" role="img" aria-label={markTitle}>
          <IconAttention />
        </span>
      ) : null}
      <span className="ss-noticepanel__message">
        {message}
        {reason ? <span className="ss-noticepanel__reason"> · {reason}</span> : null}
        {detail ? <span className="ss-noticepanel__detail">{detail}</span> : null}
      </span>
      {keys !== null || busy !== undefined ? (
        <BusySlot busy={busy !== undefined} label={busy ?? ""} className="ss-noticepanel__busy">
          {keys}
        </BusySlot>
      ) : null}
      {onClose ? (
        <span className="ss-noticepanel__close">
          <IconButton icon={<IconClose />} title={closeTitle} onClick={onClose} />
        </span>
      ) : null}
    </div>
  );
  if (!sliding) return panel;

  return (
    <div
      ref={ref}
      className={`ss-noticepanel-slide${flush ? " ss-noticepanel-slide--flush" : ""}${shown ? " is-open" : ""}`}
      // 宿主的钩子：展开态（与高度动画同一帧）
      data-hint={shown ? "open" : "closed"}
      aria-hidden={open ? undefined : true}
      // 收起途中不再可点、不可聚焦
      inert={!open}
    >
      <div className="ss-noticepanel-slide__clip">
        {panel}
        {/* 下面还压着的：只露边、不露字（至多两道） */}
        {Array.from({ length: Math.min(stacked, 2) }, (_, i) => (
          <div key={i} className="ss-noticepanel-slide__peek" aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

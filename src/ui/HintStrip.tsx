import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n.ts";
import { Button, IconButton } from "./Button.tsx";
import { BusySlot } from "./BusySlot.tsx";
import { IconClose } from "./icons.tsx";
import { motionMs } from "./motion.ts";
import "./HintStrip.css";

/// 新手提示条（DESIGN「组件 › 新手提示条 HintStrip」，画板 17 / 18 / 19）。
///
/// 嵌在页面流里的一条浅灰条：`shell` 底、`face` 12 圆角、无边无投影；高 40（两行自适应，内边距 10 14），
/// 宽由调用方的容器给（776，左沿对齐表格），组件 `width: 100%`。**上下外距 16 由组件自带**：
/// 收起时外距与高度一起滑回 0，下方内容回到原位，调用方不要再给它留间距。
/// 只有说明句（13 ink）+ 右端 × 图标键（提示框「知道了，不再提示」）；不写「第一次用」之类的小标
/// （2026-09-25 产品负责人真机：不需要）。与灰面板（`surface` + `!` + 动作键）靠颜色、左端记号、右端动作分开；
/// 不用橙、猫、图标。
///
/// 出现 / 收起：淡入淡出 + 高度 0 ↔ 40，`--dur-drawer`（260ms）`--ease-mech`，推动下方内容；减少动效时即时。
/// 何时出由 `src/hints.ts` 的 `useHint` 决定，这里只管长相与进出。
///
/// **上方的间距归宿主时**（`flush`）：上外距一直是 0，只带下外距 16（同样随收起归 0）——提示条紧跟在
/// 一块自己有下内边距的东西后面（位置页的来源筛选、agent 页的节头上方），由宿主把那段内边距在提示条开着时
/// 让成 16。宿主据根上的 `data-hint="open"`（展开态，与高度动画同一帧）写
/// `:has(> [data-hint="open"])`，页面不认 `.ss-hint` 的内部类。
///
/// **可带紧凑键**（`actions`，2026-09-27「有更新」）：说明句与 × 之间至多两颗紧凑默认键（间 8），句子吸收余下的宽，
/// 给「一件可以不理的事」：`2 个 skill 有新版本 · 只看这些 · 全部更新 · ×`。何时出、按 × 之后何时再出归调用方
/// （有更新按「这一批新版本」记，不进 `seenHints`）。键 24 高：上下各让 2，条仍是 40。

/// 提示条里的一颗键（默认键紧凑 24）
export interface HintStripAction {
  label: string;
  onClick: () => void;
  /// 点下去之后在等：只锁这一颗，过了 0.3 秒门槛原位换成忙碌刻度 + 这一句（`正在更新`，见 `BusySlot`）
  busy?: string;
}

export interface HintStripProps {
  /// 显示与否；变 false 时先收起、动画走完再卸下
  open: boolean;
  /// 点 ×：知道了，不再提示
  onDismiss: () => void;
  /// 说明句，不超过两行：只说用户此刻不确定的事（刚才做了什么、动没动文件、点下去会怎样）
  children: ReactNode;
  /// 不带上外距（上方的间距归宿主，见上）
  flush?: boolean;
  /// 说明句与 × 之间的紧凑默认键，至多两颗（多给的不画）
  actions?: HintStripAction[];
  /// × 的提示框；默认「知道了，不再提示」（新手提示）。有更新写「这一批不再提示」
  dismissTitle?: string;
  /// 下面还压着几张（`useHintStack` 的 `below`）：条下露一两道没有内容的薄边，至多两道
  stacked?: number;
}

/// 几张提示条同时想出时（2026-09-30 产品负责人：「叠放在上面，用户处理完一个再处理下一个，注意不要把底下的
/// 漏出来」）：只展开登记顺序里第一张想出的，其余算压在它下面的张数
export function hintStackOf(items: ReadonlyArray<{ key: string; want: boolean }>): {
  top: string | null;
  below: number;
} {
  const wanted = items.filter((i) => i.want);
  return { top: wanted[0]?.key ?? null, below: Math.max(0, wanted.length - 1) };
}

/// 叠放的提示条此刻展开哪一张：换张时先等上一张收起（`--dur-drawer`）再展开下一张，两张不同时半开——
/// 收起、展开的动画叠在一起，底下那张的字就漏出来了。调用方把 `open={top === key}`、`stacked={below}` 给各条
export function useHintStack(items: ReadonlyArray<{ key: string; want: boolean }>): {
  top: string | null;
  below: number;
} {
  const { top: next, below } = hintStackOf(items);
  const [top, setTop] = useState<string | null>(next);
  useEffect(() => {
    if (top === next) return;
    if (top === null) {
      setTop(next);
      return;
    }
    // 先收起现在这张，收完再换
    setTop(null);
  }, [top, next]);
  useEffect(() => {
    if (top !== null || next === null) return;
    const ms = motionMs("--dur-drawer");
    const t = window.setTimeout(() => setTop(next), ms);
    return () => window.clearTimeout(t);
  }, [top, next]);
  return { top, below: top === null ? 0 : below };
}

export function HintStrip({
  open,
  onDismiss,
  children,
  flush = false,
  actions,
  dismissTitle = t("common.hintStrip.dismiss"),
  stacked = 0,
}: HintStripProps) {
  /// 在不在 DOM 里：收起动画期间仍在
  const [mounted, setMounted] = useState(open);
  /// 展开态：先以收起态挂上，再加上它，过渡才有起点
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShown(false);
    // 收起动画走完再卸：时长与 HintStrip.css 同取 `--dur-drawer`（减少动效时是 0，即时卸）
    const ms = motionMs("--dur-drawer");
    if (ms === 0) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open]);

  // 收起态已写进 DOM、还没画出来：量一次让它落进样式，再展开（不靠 requestAnimationFrame，窗口在后台时它会停）
  useLayoutEffect(() => {
    if (!open || !mounted || shown) return;
    ref.current?.getBoundingClientRect();
    setShown(true);
  }, [open, mounted, shown]);

  if (!mounted) return null;

  return (
    <div
      ref={ref}
      className={`ss-hint${flush ? " ss-hint--flush" : ""}${shown ? " is-open" : ""}`}
      // 宿主的钩子：展开态（与高度动画同一帧）
      data-hint={shown ? "open" : "closed"}
      role="note"
      aria-label={t("common.hintStrip.label")}
      aria-hidden={open ? undefined : true}
      // 收起途中不再可点、不可聚焦
      inert={!open}
    >
      <div className="ss-hint__clip">
        <div className="ss-hint__bar">
          <span className="ss-hint__text">{children}</span>
          {actions && actions.length > 0 ? (
            <span className="ss-hint__actions">
              {actions.slice(0, 2).map((a) => (
                // `data-hint-action`：调用方把按下这颗键的结果锚在它下面（公开钩子，不认内部类）
                <span key={a.label} className="ss-hint__action" data-hint-action={a.label}>
                  <BusySlot busy={a.busy !== undefined} label={a.busy ?? ""}>
                    <Button size="compact" onClick={a.onClick}>
                      {a.label}
                    </Button>
                  </BusySlot>
                </span>
              ))}
            </span>
          ) : null}
          <span className="ss-hint__close">
            <IconButton icon={<IconClose size={10} />} title={dismissTitle} onClick={onDismiss} />
          </span>
        </div>
        {/* 下面还压着的：只露边、不露字（至多两道） */}
        {Array.from({ length: Math.min(stacked, 2) }, (_, i) => (
          <div key={i} className="ss-hint__peek" aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

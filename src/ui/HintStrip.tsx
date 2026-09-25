import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconButton } from "./Button.tsx";
import { IconClose } from "./icons.tsx";
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
/// 出现 / 收起：淡入淡出 + 高度 0 ↔ 40，260ms `--ease-mech`，推动下方内容；减少动效时即时。
/// 何时出由 `src/hints.ts` 的 `useHint` 决定，这里只管长相与进出。

export interface HintStripProps {
  /// 显示与否；变 false 时先收起、动画走完再卸下
  open: boolean;
  /// 点 ×：知道了，不再提示
  onDismiss: () => void;
  /// 说明句，不超过两行：只说用户此刻不确定的事（刚才做了什么、动没动文件、点下去会怎样）
  children: ReactNode;
}

/// 与 HintStrip.css 的过渡时长一致
const SLIDE_MS = 260;

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function HintStrip({ open, onDismiss, children }: HintStripProps) {
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
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), SLIDE_MS);
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
      className={shown ? "ss-hint is-open" : "ss-hint"}
      role="note"
      aria-label="提示"
      aria-hidden={open ? undefined : true}
      // 收起途中不再可点、不可聚焦
      inert={!open}
    >
      <div className="ss-hint__clip">
        <div className="ss-hint__bar">
          <span className="ss-hint__text">{children}</span>
          <span className="ss-hint__close">
            <IconButton
              icon={<IconClose size={10} />}
              title="知道了，不再提示"
              onClick={onDismiss}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

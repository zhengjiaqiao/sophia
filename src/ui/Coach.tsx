import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { t } from "../i18n.ts";
import { Button } from "./Button.tsx";

/// 箭头离气泡边的距离（箭头中线）：气泡往左展开时箭头在右端这么远，往右展开时在左端这么远
const ARROW_INSET = 28;
/// 气泡离窗口四边至少这么远（同提示框、浮层）
const EDGE = 16;
/// 气泡顶离目标底的距离（箭头尖露在这一段里）
const GAP = 10;

/// 气泡摆在哪：目标正下方 10，箭头对着目标的中线。先往左展开（箭头在右端，目标多在行尾、页签在浮层右侧），
/// 左边放不下才往右展开；再夹进窗口四边各留 16。挂在浮层里时（`bounds` 是浮层的左右沿）夹进浮层左右各 16——
/// 伸出浮层的那一截会被浮层裁掉（走查 2026-10-07）。`arrowX` 是箭头中线离气泡左沿的距离
export function placeCoach(
  anchor: { left: number; right: number; bottom: number },
  size: { width: number },
  viewport: { width: number },
  bounds?: { left: number; right: number },
): { left: number; top: number; arrowX: number } {
  const center = (anchor.left + anchor.right) / 2;
  const min = Math.max(EDGE, (bounds?.left ?? 0) + EDGE);
  const max = Math.min(viewport.width, bounds?.right ?? viewport.width) - EDGE - size.width;
  let left = center - (size.width - ARROW_INSET);
  if (left < min) left = center - ARROW_INSET;
  left = Math.max(min, Math.min(left, max));
  const arrowX = Math.max(ARROW_INSET / 2, Math.min(center - left, size.width - ARROW_INSET / 2));
  return { left, top: anchor.bottom + GAP, arrowX };
}

export interface CoachProps {
  /// 箭头指着的控件（选模型浮层里的 `已选` 页签）；没有时不出
  anchor: HTMLElement | null;
  /// 此刻出不出（只出一次由调用方经 `coachStore` 管）
  open: boolean;
  /// 一句话：做完这件事之后，下一步在哪
  children: ReactNode;
  /// 点「知道了」
  onDismiss: () => void;
}

/// 引导气泡（DESIGN-components「引导气泡 Coach」，#265）：用户第一次做完某件事后，指着某个控件告诉他下一步在哪——
/// 纸面 + hairline 边 + 浮层投影 + 指向目标的小箭头，一句话 + `知道了`。它替代常挂的说明句；全应用每种只出一次
/// （`src/coach.ts`，记在设置里）。不抢焦点；读屏把这句话当提示读出（外层是一直在的 `status` 区，句子出来时读）。
/// 出现时淡入并下落 4px（`--dur-push`），减少动态效果时直接出现。
/// 挂在调用方的 DOM 里（不挂 body）：在浮层里时点它不算点外面、Tab 也走得到 `知道了`；位置是 fixed，量目标来摆
export function Coach({ anchor, open, children, onDismiss }: CoachProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrowX: number } | null>(null);
  const shown = open && anchor !== null;

  useLayoutEffect(() => {
    if (!shown || !ref.current || !anchor) {
      setPos(null);
      return;
    }
    const a = anchor.getBoundingClientRect();
    // 挂在浮层里：浮层会裁掉伸出去的部分，夹进浮层
    const layer = ref.current.closest(".ss-layer")?.getBoundingClientRect();
    setPos(
      placeCoach(
        { left: a.left, right: a.right, bottom: a.bottom },
        { width: ref.current.offsetWidth },
        { width: window.innerWidth },
        layer ? { left: layer.left, right: layer.right } : undefined,
      ),
    );
  }, [shown, anchor]);

  const style: CSSProperties | undefined = pos
    ? ({ left: pos.left, top: pos.top, "--arrow-x": `${pos.arrowX}px` } as CSSProperties)
    : { visibility: "hidden" };

  return (
    <div className="ss-coach-live" role="status">
      {shown ? (
        <div ref={ref} className="ss-coach" style={style}>
          <span className="ss-coach__text">{children}</span>
          <Button size="compact" onClick={onDismiss}>
            {t("common.coach.ok")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

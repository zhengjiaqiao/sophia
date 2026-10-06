import type { SVGProps } from "react";
import { t } from "../i18n.ts";
/// 状态点（DESIGN「表格 = 面板 › 指示灯」「视觉优先」，画板 States / Marks）。
///
/// 格回答两件事：**填充＝这个 agent 能不能用它，外环＝它在这儿是原件还是一条软链。**
/// 三种常驻状态外径一致 10px，中心对准列头中线；「无此格」是 8px 短横，不是状态。
/// 环一律 1.3 `ink-mute`（未加上的 ○ 比实心 ● 退后一层，一整表的 ○ 不和 ● 抢眼）；实心、原件的 4px 芯、
/// ⊘ 的斜线是 `ink`。
/// 异常画在**同一个 10px 环骨架**上，一个视觉词只学一次：
/// 失效＝虚线环（4 段、段间 1.5，虚线在空态里已教过「目标不在」）、放不进去＝斜杠环 ⊘
/// （无法写入与同名占位同一个记号，裁决 D22：该行已有 `×2`，原因由提示框说）、
/// 整个文件夹是链接＝环内向右箭头（箭头不穿出环，否则读成 ♂）。
///
/// 只有 10px 一档（16px 版、反色、自带按钮这三个分支没人用，2026-09-25 删了；刚点亮的反色闪由格子上的
/// `data-flash` 带出，闪的那一帧不出悬停光晕）。
///
/// 悬停光晕（DESIGN「格子悬停光晕」）：可点的点悬停 / 键盘聚焦时，**点本身一点不变**，
/// 只在点的下层出一圈直径 22 的圆形 hairline 光晕，说「能点」，不预告结果（结果由提示框的动词说）。
/// 原件点了是删原件（先确认），照常出光晕；无此格 / 异常格点了不是开关，不出光晕。

export type Dot =
  "own" | "linked" | "missing" | "none" | "broken" | "readOnly" | "blocked" | "wholeLinked";

/// 读屏的默认说法：新图形都要有文字，调用方不给就用这一份
/// 各取值是 getter：文案用到时才取，不在模块加载时定死（展开 `...DOT_LABEL` 的调用方是展开那一刻取）
export const DOT_LABEL: Record<Dot, string> = {
  get own() {
    return t("common.dot.own");
  },
  get linked() {
    return t("common.dot.linked");
  },
  get missing() {
    return t("common.dot.missing");
  },
  get none() {
    return t("common.dot.none");
  },
  get broken() {
    return t("common.dot.broken");
  },
  get readOnly() {
    return t("common.dot.readOnly");
  },
  get blocked() {
    return t("common.dot.blocked");
  },
  get wholeLinked() {
    return t("common.dot.wholeLinked");
  },
};

export interface StateDotProps {
  dot: Dot;
  /// 禁用：选择条里「已选的都是原件」那颗禁用键上的原件环，退到 `ink-faint`
  muted?: boolean;
  /// 读屏名；不给用 DOT_LABEL。悬停说明不在这里：格子的文字由 Tooltip 承载，
  /// 点上不写原生 title（悬停弹系统灰框，2026-10-06）
  label?: string;
  /// 这颗点可点：外层按钮（`StateDotButton`，整格命中与键盘焦点）由调用方放，这里只画记号；
  /// 给 true 时悬停 / 键盘聚焦外层按钮出光晕（只有开 / 关两种与原件出）
  hoverable?: boolean;
  /// 点放在 `surface` 底上（表格的选择行）：光晕换深一档的 `track`——`hairline` 在 surface 上看不见
  onSurface?: boolean;
}

/// 这两种点下去是开关，原件点下去是删原件（DESIGN「删除原件」）：出悬停光晕
const TOGGLES = new Set<Dot>(["linked", "missing", "own"]);

/// 10px 家族：外径 10，环 1.3（r 4.35）`ink-mute`（`.ss-dot__ring`）；实心、芯、斜线、箭头 `ink`（currentColor）
const R10 = 4.35;
const W10 = 1.3;

function Glyph10({ dot }: { dot: Dot }) {
  const ring = (extra?: SVGProps<SVGCircleElement>) => (
    <circle className="ss-dot__ring" cx="5" cy="5" r={R10} strokeWidth={W10} {...extra} />
  );
  switch (dot) {
    case "linked":
      // 环打底、实心盖在上面（外径 10）
      return (
        <>
          {ring()}
          <circle className="ss-dot__fill" cx="5" cy="5" r="5" stroke="none" fill="currentColor" />
        </>
      );
    case "missing":
      return ring();
    case "own":
      // 环 + 4px 实心芯
      return (
        <>
          {ring()}
          <circle cx="5" cy="5" r="2" stroke="none" fill="currentColor" />
        </>
      );
    case "none":
      // 8×1.5 短横，颜色由 .ss-dot--none 给（ink-faint）
      return <path d="M1 5H9" strokeWidth="1.5" />;
    case "broken":
      return ring({
        strokeLinecap: "butt",
        strokeDasharray: "5.33 1.5",
        transform: "rotate(-45 5 5)",
      });
    // 同名占位与无法写入同画 ⊘（D22）：环 ink-mute、斜线 ink——「受阻」靠斜线说，不靠加粗整个记号
    case "readOnly":
    case "blocked":
      return (
        <>
          {ring()}
          <path d="M2 8 L8 2" strokeWidth={W10} />
        </>
      );
    case "wholeLinked":
      return (
        <>
          {ring()}
          <path d="M2.9 5 H7.1 M5.3 3.2 L7.1 5 L5.3 6.8" strokeWidth={W10} />
        </>
      );
  }
}

export function StateDot({
  dot,
  muted,
  label,
  hoverable: canHover,
  onSurface = false,
}: StateDotProps) {
  const text = label ?? DOT_LABEL[dot];
  const classes = ["ss-dot", `ss-dot--${dot}`];
  if (muted) classes.push("is-muted");
  if (onSurface) classes.push("is-on-surface");
  const hoverable = Boolean(canHover) && TOGGLES.has(dot);

  return (
    <span className="ss-dot-wrap" role="img" aria-label={text}>
      <svg
        className={classes.join(" ")}
        data-dot={dot}
        data-hoverable={hoverable ? "" : undefined}
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth={W10}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {hoverable && (
          // 光晕先画、压在点下层；溢出 viewBox（svg overflow: visible），不占布局
          <circle className="ss-dot__halo" cx="5" cy="5" r="11" stroke="none" />
        )}
        <Glyph10 dot={dot} />
      </svg>
    </span>
  );
}

import type { ReactNode, SVGProps } from "react";
import { Tooltip } from "./Tooltip.tsx";
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
/// 悬停光晕（DESIGN「格子悬停光晕」）：可点的点悬停 / 键盘聚焦时，**点本身一点不变**，
/// 只在点的下层出一圈直径 22 的圆形 hairline 光晕，说「能点」，不预告结果（结果由提示框的动词说）。
/// 原件 / 无此格 / 异常格点了不是开关，不出光晕。

export type Dot =
  "own" | "linked" | "missing" | "none" | "broken" | "readOnly" | "blocked" | "wholeLinked";

/// 读屏与 title 的默认说法：新图形都要有文字，调用方不给就用这一份
export const DOT_LABEL: Record<Dot, string> = {
  own: "原件",
  linked: "已加上",
  missing: "未加上",
  none: "无此格",
  broken: "链接失效",
  readOnly: "无法写入",
  blocked: "受阻",
  wholeLinked: "整个文件夹是链接",
};

export interface StateDotProps {
  dot: Dot;
  /// 10：表格格子（默认）；16：说明里的大一号记号
  size?: 10 | 16;
  /// 画在墨上：刚点亮那 120ms 的反色闪（格底由调用方铺 `ink`），记号转 `face`
  inverse?: boolean;
  /// 禁用：选择条里「已选的都是原件」那颗禁用键上的原件环，退到 `ink-faint`
  muted?: boolean;
  /// 鼠标悬停的系统兜底说明。**不作唯一说明**——格子的文字确定性由 Tooltip 承载
  title?: string;
  /// 读屏名；不给就用 title，再不给用 DOT_LABEL
  label?: string;
  /// 给了才渲染成可点的按钮（整格命中区由调用方撑，这里至少 24×24）
  onClick?: () => void;
  /// 调用方自己渲染外层按钮（`.ss-dot-btn`，表格要整格命中与键盘焦点）时给 true：
  /// 表示这颗点可点，不带 onClick 也出悬停光晕
  hoverable?: boolean;
}

/// 只有这两种点下去是开关，才出悬停光晕
const TOGGLES = new Set<Dot>(["linked", "missing"]);

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

function Glyph16({ dot }: { dot: Dot }) {
  switch (dot) {
    case "linked":
      return (
        <>
          <circle className="ss-dot__ring" cx="8" cy="8" r="6.3" />
          <circle className="ss-dot__fill" cx="8" cy="8" r="7" stroke="none" fill="currentColor" />
        </>
      );
    case "missing":
      return <circle className="ss-dot__ring" cx="8" cy="8" r="6.3" />;
    case "own":
      return (
        <>
          <circle className="ss-dot__ring" cx="8" cy="8" r="6.3" />
          <circle cx="8" cy="8" r="3" stroke="none" fill="currentColor" />
        </>
      );
    case "none":
      return <path d="M3 8H13" />;
    case "broken":
      return (
        <circle
          className="ss-dot__ring"
          cx="8"
          cy="8"
          r="6.3"
          strokeLinecap="butt"
          strokeDasharray="8.4 1.5"
          transform="rotate(-45 8 8)"
        />
      );
    // 同名占位与无法写入同画 ⊘（D22）
    case "readOnly":
    case "blocked":
      return (
        <>
          <circle className="ss-dot__ring" cx="8" cy="8" r="6.3" />
          <path d="M3.6 12.4 L12.4 3.6" />
        </>
      );
    case "wholeLinked":
      return (
        <>
          <circle className="ss-dot__ring" cx="8" cy="8" r="6.3" />
          <path d="M4.9 8 H11.1 M8.4 5.3 L11.1 8 L8.4 10.7" />
        </>
      );
  }
}

export function StateDot({
  dot,
  size = 10,
  inverse,
  muted,
  title,
  label,
  onClick,
  hoverable: forceHoverable,
}: StateDotProps) {
  const text = label ?? title ?? DOT_LABEL[dot];
  const classes = ["ss-dot", `ss-dot--${dot}`];
  if (inverse) classes.push("is-inverse");
  if (muted) classes.push("is-muted");
  const hoverable = (Boolean(onClick) || Boolean(forceHoverable)) && TOGGLES.has(dot);
  const center = size === 16 ? 8 : 5;

  const glyph = (
    <svg
      className={classes.join(" ")}
      data-dot={dot}
      data-hoverable={hoverable ? "" : undefined}
      width={size}
      height={size}
      viewBox={size === 16 ? "0 0 16 16" : "0 0 10 10"}
      fill="none"
      stroke="currentColor"
      strokeWidth={size === 16 ? 1.4 : W10}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {hoverable && (
        // 光晕先画、压在点下层；溢出 viewBox（svg overflow: visible），不占布局
        <circle className="ss-dot__halo" cx={center} cy={center} r="11" stroke="none" />
      )}
      {size === 16 ? <Glyph16 dot={dot} /> : <Glyph10 dot={dot} />}
    </svg>
  );

  if (!onClick) {
    return (
      <span className="ss-dot-wrap" title={title ?? text} role="img" aria-label={text}>
        {glyph}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="ss-dot-btn"
      title={title ?? text}
      aria-label={text}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
}

export interface DupMarkProps {
  /// 份数，默认 2
  count?: number;
  /// row：表格名字后，12 tabular `ink-faint`（目前只有这一档）
  tone?: "row";
  /// 给了就挂提示框（点状下划线，不可点），并去掉原生 title——主视图放不下越界读数时，
  /// 在这里同时列两份的读数
  tip?: ReactNode;
}

/// 同名的记号：名字后 `×2`（惯例写法，零学习）。**不再有「[」括线**——
/// 自创记号没有足够理由（DESIGN 已裁决的冲突「同名怎么标」）
export function DupMark({ count = 2, tone = "row", tip }: DupMarkProps) {
  const text = `同名：有 ${count} 份`;
  if (tip !== undefined && tip !== null) {
    return (
      <Tooltip content={tip}>
        <span className={`ss-dup ss-dup--${tone}`} role="img" aria-label={text} tabIndex={0}>
          ×{count}
        </span>
      </Tooltip>
    );
  }
  return (
    <span className={`ss-dup ss-dup--${tone}`} title={text} role="img" aria-label={text}>
      ×{count}
    </span>
  );
}

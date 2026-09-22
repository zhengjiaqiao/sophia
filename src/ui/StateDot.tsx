import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.tsx";
/// 状态点（DESIGN「表格 = 面板 › 指示灯」「视觉优先」，画板 States / Marks）。
///
/// 格回答两件事：**填充＝这个 agent 能不能用它，外环＝它在这儿是原件还是一条软链。**
/// 三种常驻状态外径一致 10px，中心对准列头中线；「无此格」是 8px 短横，不是状态。
/// 异常画在**同一个 10px 环骨架**上，一个视觉词只学一次：
/// 失效＝虚线环（4 段、段间 1.5，虚线在空态里已教过「目标不在」）、写不进＝斜杠环、
/// 同名被挡＝环内短横、整个文件夹是链接＝环内向右箭头（箭头不穿出环，否则读成 ♂）。
///
/// 16px 版给待处理页左列：与格内同形，类别名进 title，三处只学一次。
///
/// 悬停预览（DESIGN「格子悬停预览」）：可点的格画出**点下去会变成什么**——
/// 未加上：环内填 40% 实心；已加上：实心褪去只剩环。两者必须长得相反。
/// 原件 / 无此格 / 异常格点了不是开关，不预览。

export type Dot =
  "own" | "linked" | "missing" | "none" | "broken" | "readOnly" | "blocked" | "wholeLinked";

/// 读屏与 title 的默认说法：新图形都要有文字，调用方不给就用这一份
export const DOT_LABEL: Record<Dot, string> = {
  own: "原件",
  linked: "已加上",
  missing: "未加上",
  none: "无此格",
  broken: "链接失效",
  readOnly: "写不进",
  blocked: "同名被挡",
  wholeLinked: "整个文件夹是链接",
};

export interface StateDotProps {
  dot: Dot;
  /// 10：表格格子（默认）；16：待处理页与说明里的大一号记号
  size?: 10 | 16;
  /// 画在实心黑上：刚点亮那 120ms 的反色闪（格底由调用方铺黑），记号转白
  inverse?: boolean;
  /// 禁用灰：选择条里「已选的都是原件」那颗禁用键上的灰色原件环
  muted?: boolean;
  /// 鼠标悬停的系统兜底说明。**不作唯一说明**——格子的文字确定性由 Tooltip 承载
  title?: string;
  /// 读屏名；不给就用 title，再不给用 DOT_LABEL
  label?: string;
  /// 给了才渲染成可点的按钮（整格命中区由调用方撑，这里至少 24×24）
  onClick?: () => void;
  /// 调用方自己渲染外层按钮（`.ss-dot-btn`，表格要整格命中与键盘焦点）时给 true：
  /// 不带 onClick 也画悬停预览
  preview?: boolean;
}

/// 只有这两种点下去是开关，才画悬停预览
const PREVIEWS = new Set<Dot>(["linked", "missing"]);

function Glyph10({ dot }: { dot: Dot }) {
  switch (dot) {
    case "linked":
      // 环打底、实心盖在上面：悬停时实心褪去，剩下的就是「关掉之后」的样子
      return (
        <>
          <circle cx="5" cy="5" r="4.25" />
          <circle className="ss-dot__fill" cx="5" cy="5" r="5" stroke="none" fill="currentColor" />
        </>
      );
    case "missing":
      return (
        <>
          <circle cx="5" cy="5" r="4.25" />
          <circle
            className="ss-dot__preview"
            cx="5"
            cy="5"
            r="3.5"
            stroke="none"
            fill="currentColor"
          />
        </>
      );
    case "own":
      return (
        <>
          <circle cx="5" cy="5" r="4.25" />
          <circle cx="5" cy="5" r="2" stroke="none" fill="currentColor" />
        </>
      );
    case "none":
      return <path d="M1 5H9" />;
    case "broken":
      return (
        <circle
          cx="5"
          cy="5"
          r="4.25"
          strokeLinecap="butt"
          strokeDasharray="5.2 1.5"
          transform="rotate(-45 5 5)"
        />
      );
    case "readOnly":
      return (
        <>
          <circle cx="5" cy="5" r="4.25" />
          <path d="M2 8 L8 2" />
        </>
      );
    case "blocked":
      return (
        <>
          <circle cx="5" cy="5" r="4.25" />
          <path d="M3 5 H7" />
        </>
      );
    case "wholeLinked":
      return (
        <>
          <circle cx="5" cy="5" r="4.25" />
          <path d="M2.9 5 H7.1 M5.3 3.2 L7.1 5 L5.3 6.8" />
        </>
      );
  }
}

function Glyph16({ dot }: { dot: Dot }) {
  switch (dot) {
    case "linked":
      return (
        <>
          <circle cx="8" cy="8" r="6.3" />
          <circle className="ss-dot__fill" cx="8" cy="8" r="7" stroke="none" fill="currentColor" />
        </>
      );
    case "missing":
      return (
        <>
          <circle cx="8" cy="8" r="6.3" />
          <circle
            className="ss-dot__preview"
            cx="8"
            cy="8"
            r="5.6"
            stroke="none"
            fill="currentColor"
          />
        </>
      );
    case "own":
      return (
        <>
          <circle cx="8" cy="8" r="6.3" />
          <circle cx="8" cy="8" r="3" stroke="none" fill="currentColor" />
        </>
      );
    case "none":
      return <path d="M3 8H13" />;
    case "broken":
      return (
        <circle
          cx="8"
          cy="8"
          r="6.3"
          strokeLinecap="butt"
          strokeDasharray="8.4 1.5"
          transform="rotate(-45 8 8)"
        />
      );
    case "readOnly":
      return (
        <>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M3.6 12.4 L12.4 3.6" />
        </>
      );
    case "blocked":
      return (
        <>
          <circle cx="8" cy="8" r="6.3" />
          <path d="M5 8 H11" />
        </>
      );
    case "wholeLinked":
      return (
        <>
          <circle cx="8" cy="8" r="6.3" />
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
  preview: forcePreview,
}: StateDotProps) {
  const text = label ?? title ?? DOT_LABEL[dot];
  const classes = ["ss-dot", `ss-dot--${dot}`];
  if (inverse) classes.push("is-inverse");
  if (muted) classes.push("is-muted");
  const preview = (Boolean(onClick) || Boolean(forcePreview)) && PREVIEWS.has(dot);

  const glyph = (
    <svg
      className={classes.join(" ")}
      data-dot={dot}
      data-preview={preview ? "" : undefined}
      width={size}
      height={size}
      viewBox={size === 16 ? "0 0 16 16" : "0 0 10 10"}
      fill="none"
      stroke="currentColor"
      strokeWidth={size === 16 ? 1.4 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
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
  /// row：表格名字后，等宽 12 `ink-faint`；strong：待处理页记号列，墨色 13/600
  tone?: "row" | "strong";
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
        <span
          className={`ss-dup ss-dup--${tone} has-tip`}
          role="img"
          aria-label={text}
          tabIndex={0}
        >
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

import type { CSSProperties } from "react";

/// 内联用的两档文字样式，与 DESIGN.md 的 `micro-cap` / `mono` 逐字段对应。
///
/// 只给那些没法用 className 的地方（表格单元格里临时拼的内容）。能用 CSS 类
/// 就用 CSS 类——这两个对象曾在三个文件里各抄一份，其中一份漏了 fontWeight，
/// 三处就悄悄不一样了。收成一份之后改 token 只动这里。
export const MICRO_CAP: CSSProperties = {
  fontFamily: "var(--font-cond)",
  fontSize: "var(--size-micro)",
  fontWeight: 600,
  letterSpacing: "var(--track-label)",
  lineHeight: "var(--leading-micro)",
  textTransform: "uppercase",
};

export const MONO: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--size-micro)",
};

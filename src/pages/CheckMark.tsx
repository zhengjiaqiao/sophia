import { CheckboxGlyph } from "../ui/index.ts";

/// 画出来的 13px 复选方框（与 ui 的 `Checkbox` 同一套 `.ss-checkbox` 样式、同一个记号）。
///
/// 给「整行是按钮」的列表用：命中区是整行（DESIGN「命中区与视觉尺寸是两回事」：列表行里
/// 的选择记号只是告诉你点了会发生什么），方框本身不再是一个按钮——按钮里套按钮不合法。
/// 读屏状态由外层行的 `role="checkbox"` + `aria-checked` 说，这里 aria-hidden。
/// `"mixed"`＝半选（全选框在部分勾上时），画一道短横，与 `Checkbox` 一致。
export function CheckMark({ on }: { on: boolean | "mixed" }) {
  const classes = ["ss-checkbox", "pages-checkmark"];
  if (on === true) classes.push("is-on");
  if (on === "mixed") classes.push("is-mixed");
  return (
    <span className={classes.join(" ")} aria-hidden="true">
      <CheckboxGlyph checked={on} />
    </span>
  );
}

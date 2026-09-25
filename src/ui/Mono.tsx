import { displayPath } from "../pathText.ts";

/// 等宽读数（DESIGN「Typography › 字族」：等宽只给 id、路径、版本号，裁决 D23：它们可拖选）：
/// IBM Plex Mono、数字等宽，默认 12 `ink-faint`，放不下在任意处折行（路径决定删哪份，不截断）。
/// `path` 时把用户主目录写成 `~`（`pathText.displayPath`，主目录由应用启动时读一次）。
/// 句子里、提示框里嵌一段路径时给 `inherit`：字号与颜色随所在的那句话，只换字族。
/// 放不下只能截断的一行（行尾的模型 id）给 `truncate`
export interface MonoProps {
  children: string;
  /// 这是一条路径：主目录写成 `~`
  path?: boolean;
  /// 字号与颜色随上下文（句子里、墨窗里）；不给就是 12 `ink-faint`
  inherit?: boolean;
  /// 一行放不下时截断（…），不折行
  truncate?: boolean;
}

export function Mono({ children, path = false, inherit = false, truncate = false }: MonoProps) {
  const classes = ["ss-mono", "ss-selectable"];
  if (inherit) classes.push("ss-mono--inherit");
  if (truncate) classes.push("ss-mono--truncate");
  const text = path ? displayPath(children) : children;
  return <span className={classes.join(" ")}>{text}</span>;
}

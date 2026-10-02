import { Fragment } from "react";
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";

/// 汉字与汉字之间不留空白（`拆开 失败` → `拆开失败`）
const HAN_GAP = /(\p{Script=Han})\s+(?=\p{Script=Han})/gu;

/// 整句（`tRich` 的结果）拆成段：文字段交给 `wrap`（空白合并、去掉首尾，纯空白的段丢掉），
/// 嵌进去的节点（图标组、名字、数字）原样保留。
///
/// 提示条与选择行的键面都是 flex 容器，段与段的间距由 `gap` 给、不靠空白（见 CLAUDE.md
/// 「inline-flex 里的空白会被吃掉」）：整句里的空格只用来让译文自然，渲染时由这里拿掉。
/// 各语言的语序不同（`加到 [图标] 名字` / `Added 名字 to [图标]`），文字段的个数与位置随之变，
/// 嵌入的节点始终在它该在的地方。
///
/// 占位符这次没有内容（没有图标、没有名字）时，它两侧的文字并成一段，不会拆出两个孤零零的词
/// （`拆开 {agents} 失败` 没有图标时是一段 `拆开失败`）
export function sentencePieces(
  line: ReactNode,
  wrap: (text: string, key: string) => ReactNode,
): ReactNode[] {
  const inner = isValidElement(line)
    ? (line as ReactElement<{ children?: ReactNode }>).props.children
    : line;
  const items = Array.isArray(inner) ? inner : [inner];
  const out: ReactNode[] = [];
  let text = "";
  const flush = () => {
    const tidy = text.replace(/\s+/g, " ").trim().replace(HAN_GAP, "$1");
    text = "";
    if (tidy) out.push(wrap(tidy, `text-${out.length}`));
  };
  for (const item of items) {
    if (typeof item === "string") text += item;
    else if (item === null || item === undefined || item === false) continue;
    else {
      flush();
      out.push(<Fragment key={`node-${out.length}`}>{item}</Fragment>);
    }
  }
  flush();
  return out;
}

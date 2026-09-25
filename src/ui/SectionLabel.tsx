import type { ReactNode } from "react";

/// 区块小标（DESIGN「刻字」，裁决：全应用一种——**Condensed 12 / 600 `ink-mute`，可选下 7 一条 hairline**）：
/// 一组内容上面的一句小标题，右端可带一颗键（`网关` + `+ 网关`、侧栏 `AGENT` `项目` + 排序下拉）。
/// 字原样：汉字字距 0；独立成词的拉丁结构词（`AGENT`）由调用方包 `Cap`，句子里的词（`列表里的 agent`）不包。
/// 不是节标题（那是 `Section` 的 `head` 16）、不是表格列头（列头由表格定）。上下外距归所在的页
export interface SectionLabelProps {
  children: ReactNode;
  /// 下 7 一条 1px `hairline`：下面紧跟一列行（设置、网关）时给；侧栏、候选列表的组前不给
  rule?: boolean;
  /// 右端一颗键（`AddButton`、排序下拉）；与小标底对齐
  action?: ReactNode;
  /// 给页面滚动定位用（应用菜单「关于」跳到这一节）
  id?: string;
}

export function SectionLabel({ children, rule = false, action, id }: SectionLabelProps) {
  const classes = ["ss-sectionlabel"];
  if (rule) classes.push("has-rule");
  if (action) classes.push("has-action");
  return (
    <div className={classes.join(" ")} id={id}>
      <span className="ss-sectionlabel__text">{children}</span>
      {action ? <span className="ss-sectionlabel__action">{action}</span> : null}
    </div>
  );
}

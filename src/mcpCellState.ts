/// MCP 格状态 → 圆点 + 点击行为 + 文案。矩阵、导入页与新问题的一次性提示共用这一份映射。
///
/// 契约与 `cellState.ts` 完全一致（组件规范 §8.1）：`reason` **只在不可点时有值**，
/// 装的是「为什么不能点」；成功句由调用方在操作结果处聚合，不由格提供——按 §4.1
/// 一次操作只汇总成一句，「每个格自己的成功文案」从构造上就是错的。
///
/// 语义是从 skill 平移过来的，不是照搬（spec R1）：
/// **环**＝本行的「来源位置」就是这一列；**实心**＝这儿也有一份、连的是同一个服务；
/// **空心**＝这儿还没有。和 skill 最大的不同是这里没有软链——每一处都是别人配置
/// 文件里的一段真实内容，所以写入只有一个方向：只新增，从不覆盖也不删除。
import type { Dot } from "./cellState";
import type { McpCellState } from "./types";

/// 能画进格里的六种。第七种 `conflict` **不进格**（spec R2）：
/// `scan()` 遍历全部位置的全部条目建行，某行在列 X 上是 `conflict`，说明 X 自己也
/// 持有同名条目、也产出了带 `own` 的条目。把「两份不一样」画成格状态，等于把行级
/// 事实塞进格里，必然自相矛盾。所以类型上就不让它走到这儿来。
export type McpDotState = Exclude<McpCellState, "conflict">;

/// MCP 页需要用户拿主意的两类。和 skill 的 `IssueKind` 不共用：
/// 那四类说的是软链，这两类一个是文件读不出来、一个是两份定义不一致
export type McpIssueKind = "invalidLocation" | "differentCopies";

export interface McpCellView {
  dot: Dot;
  /// 点下去会真的往那份配置里写一段；false 表示点击只说明情况
  clickable: boolean;
  /// 给提示条用的**完整句子**。**只在 `clickable === false` 时有值**
  reason?: string;
  /// 非空表示这是要用户拿主意的问题（就地常显，新出现时提示一次）
  issue?: McpIssueKind;
}

/// 造句要用的三个名字，都由调用方传进来，这里不做任何查表
export interface McpCellContext {
  /// 行名，也就是 MCP 服务名
  service: string;
  /// 这一列的位置名（列的身份是文件，不是 agent——同一个 agent 在一个域里
  /// 可能有多个 MCP 位置，所以名字是位置名）
  location: string;
  /// 本行这一份定义写在哪个位置里
  source: string;
}

/// 逐条对应 spec R1 的映射表
export function viewOf(state: McpDotState, ctx: McpCellContext): McpCellView {
  switch (state) {
    case "own":
      // 这一列就是本行的来源；没有可撤的东西，点击只说明这件事
      return {
        dot: "own",
        clickable: false,
        reason: `这份 ${ctx.service} 就写在 ${ctx.location} 里，写到别处去的就是它`,
      };
    case "equal":
      return {
        dot: "linked",
        clickable: false,
        reason: `${ctx.location} 里这份 ${ctx.service} 和来源那份连的是同一个服务`,
      };
    case "sameEndpoint":
      // 端点相同、认证头动态生成：说清为什么只能比到这一步，别假装比过了全部
      return {
        dot: "linked",
        clickable: false,
        reason: "两边连的是同一个地址；认证头要到运行时才生成，没法逐字比对",
      };
    case "missing":
      // 可点的唯一一种，所以没有 reason：写进去之后要说的那句由调用方汇总
      return { dot: "missing", clickable: true };
    case "invalid":
      // 整份文件读不出来，这一列都写不进去：画斜杠环（与 skill 的「写不进」同形）
      return {
        dot: "readOnly",
        clickable: false,
        reason: `${ctx.location} 的配置这次读不出来，什么都没往里写`,
        issue: "invalidLocation",
      };
    case "unsupported":
      // 搬过去就不是原来那个了，所以整行都不给点——给点的机会等于给犯错的机会。
      // 画成与 skill「同名被挡」同一个受阻记号（环 + 短横）：这一格放不进去，不另造一种样式
      return {
        dot: "blocked",
        clickable: false,
        reason: `${ctx.service} 用了只有 ${ctx.source} 认得的写法，搬到别处就不是原来那个了`,
      };
  }
}

/// 行级方标签的文案（§3.1 零圆角、不可点）。数的是本域里互不一致的副本处数
export function differentCopiesTag(count: number): string {
  return `${count} 份不一样`;
}

/// 标签的 title。**必须说清这几处是同一件事**：两处各画一份标记，用户容易读成
/// 「四份」（spec 风险 1）
export function differentCopiesTitle(locations: string[]): string {
  return `${locations.join(" 和 ")} 各有一份，连的地址不一样`;
}

/// 两份不一样的整句（行视角）。只标差异、不给覆盖与合并——
/// `prepare` 对目标已有的同名条目一律跳过，覆盖与合并是新的破坏性能力，这一期没有
export function differentCopiesMessage(service: string, locations: string[]): string {
  return `${locations.join(" 和 ")} 各有一份 ${service}，连的地址不一样——两份都没动`;
}

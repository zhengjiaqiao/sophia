/// MCP 格状态 → 圆点 + 点击行为 + 文案。矩阵与导入页共用这一份映射。
///
/// 契约与 `cellState.ts` 完全一致（组件规范 §8.1）：`reason` **只在不可点时有值**，
/// 装的是「为什么不能点」；成功句由调用方在操作结果处聚合，不由格提供——按 §4.1
/// 一次操作只汇总成一句，「每个格自己的成功文案」从构造上就是错的。
///
/// 语义是从 skill 平移过来的，不是照搬（spec R1）：
/// **环**＝本行的「来源位置」就是这一列（原件）；**实心**＝这儿有一份副本；
/// **空心**＝这儿还没有。和 skill 最大的不同是这里没有软链——每一处都是别人配置
/// 文件里的一段真实内容。格子同样是开关（DESIGN「MCP 格子同样是开关：能写进，也能移除」）：
/// 点空心＝写进一份（只新增，不覆盖已有的同名条目）；点实心＝从那个位置移除这份副本；
/// 点原件格＝确认之后删掉原件（DESIGN「删除原件」）。
import type { Dot } from "./cellState";
import type { McpCellState } from "./types";

/// 能画进格里的六种。第七种 `conflict` **不进格**（spec R2）：
/// `scan()` 遍历全部位置的全部条目建行，某行在列 X 上是 `conflict`，说明 X 自己也
/// 持有同名条目、也产出了带 `own` 的条目。把「两份不一样」画成格状态，等于把行级
/// 事实塞进格里，必然自相矛盾。所以类型上就不让它走到这儿来。
export type McpDotState = Exclude<McpCellState, "conflict">;

/// MCP 页需要用户拿主意的两类。和 skill 的 `SkillIssueKind` 不共用：
/// 那四类说的是软链，这两类一个是文件读不出来、一个是两份定义不一致
export type McpIssueKind = "invalidLocation" | "differentCopies";

export interface McpCellView {
  dot: Dot;
  /// 点下去会真的改那份配置（写进一段 / 移除一份副本 / 确认后删原件）；false 表示点击只说明情况
  clickable: boolean;
  /// 这一格是一份副本（这一列自己也有一份定义，但它不是本行的来源）：点它＝从这个位置移除
  copy?: boolean;
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
  /// core 给这一格的原因。条目带 `onlyHarnesses`（只有几家 agent 接得住）时才传：
  /// 那时搬不过去是按目标 agent 判断的（「Cursor 不支持用命令生成请求头」），不是来源独有的写法
  cellReason?: string;
}

/// 副本格：实心、可点（点＝从这个位置移除）。可点的不带 reason，移除之后要说的那句由调用方汇总
export const copyView = (): McpCellView => ({ dot: "linked", clickable: true, copy: true });

/// 逐条对应 spec R1 的映射表。`own` 只给本行来源那一列（`cellViewOf` 判定）；
/// 别的列自己也有一份定义时，不管和来源一样不一样，都是副本（`copyView`）
export function viewOf(state: McpDotState, ctx: McpCellContext): McpCellView {
  switch (state) {
    case "own":
      // 这一列就是本行的来源（原件）：点了是删原件，先确认；可点的不带 reason
      return { dot: "own", clickable: true };
    case "equal":
    case "sameEndpoint":
      // 这儿有一份副本（同一个服务 / 同一个地址）：点＝移除
      return copyView();
    case "missing":
      // 可点的唯一一种，所以没有 reason：写进去之后要说的那句由调用方汇总
      return { dot: "missing", clickable: true };
    case "invalid":
      // 整份文件读不出来，这一列都无法写入：画斜杠环（与 skill 的「无法写入」同形）
      return {
        dot: "readOnly",
        clickable: false,
        reason: `这次无法读取 ${ctx.location} 的配置，没有往里写`,
        issue: "invalidLocation",
      };
    case "unsupported":
      // 搬过去就不是原来那个了，所以整行都不给点——给点的机会等于给犯错的机会。
      // 画成与 skill「同名占位」同一个受阻记号（环 + 短横）：这一格放不进去，不另造一种样式
      return {
        dot: "blocked",
        clickable: false,
        reason:
          ctx.cellReason ??
          `${ctx.service} 用了只有 ${ctx.source} 支持的写法，写到别处就不是原来那个了`,
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

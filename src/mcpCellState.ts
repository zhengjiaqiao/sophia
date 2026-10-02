/// MCP 格状态 → 圆点 + 点击行为 + 文案。矩阵与导入页共用这一份映射。
///
/// 契约与 `cellState.ts` 完全一致（组件规范 §8.1）：`reason` **只在不可点时有值**，
/// 装的是「为什么不能点」；成功句由调用方在操作结果处聚合，不由格提供——按 §4.1
/// 一次操作只汇总成一句，「每个格自己的成功文案」从构造上就是错的。
///
/// MCP 格子只有两种（DESIGN「MCP 格子只有两种：● 有、○ 没有」）：这里没有软链，写进一个
/// agent 的是一份完整、独立的定义，所以不分原件副本——**●**（实心，2026-09-30 起；原来画 skill 原件格的 ⦿，
/// 真机上和 ○ 太难分）＝这个 agent 的配置里有这一项；**○**＝还没有。点 ○＝写进一份（只新增，不覆盖已有的
/// 同名条目）；点 ●＝从这个 agent 的配置里删掉这一项（删到最后一份先确认，DESIGN「删除原件」MCP）。
import type { Dot } from "./cellState";
import { listText, t, tn } from "./i18n.ts";
import type { McpCellState, McpReasonKind } from "./types";

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
  /// 点下去会真的改那份配置（写进一段 / 确认后删掉这一项）；false 表示点击只说明情况
  clickable: boolean;
  /// 给提示条用的**完整句子**。**只在 `clickable === false` 时有值**
  reason?: string;
  /// `reason` 是 core 给的原因句时，它的种类（判断「目标 agent 本身做不到」用，不比对句子）；
  /// 前端自己造的句子没有
  reasonKind?: McpReasonKind;
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
  /// core 给这一格的具体原因（`ownCellReason`）：搬不过去是按目标 agent 判断的
  /// （「Cursor 不支持用命令生成请求头」「Claude Desktop 不展开 ${…} 这类变量」），比笼统的一句准
  cellReason?: string;
  /// `cellReason` 的种类（core `reasonKind`）
  cellReasonKind?: McpReasonKind;
  /// 这一份定义带着 Sophia 还搬不了的字段时是哪个（core `McpEntry.unsupportedField`）：那一句说字段
  unsupportedField?: string | null;
}

/// 这一份定义搬不过去的那一句，表格记号、格子、行勾选、修改生效范围的确认框共用一句（2026-09-30 产品负责人：
/// 「里外提示对不上」）。core 的「…不支持迁移字段 cwd」说的是 Sophia 还搬不了这个字段（不是那一家不支持），
/// 认得出字段时照实说；认不出时说「用了只有 X 支持的写法」
export function unportableText(service: string, source: string, field?: string | null): string {
  return field
    ? t("mcp.cell.unsupportedField", { service, field })
    : t("mcp.cell.unsupported", { service, source });
}

/// 这一格搬不过去，是不是目标 agent 本身就做不到（远程服务器进不了 Claude Desktop、某家不支持 SSE），
/// 而不是这一条定义有什么特别。这种 ⊘ 自己就说清了，名字后不再挂 `X 不支持`：Claude Desktop 进列之后
/// 每个远程服务器都会挂一条，同一件事说两遍（① 2026-09-27）。按 core 给的原因种类判断（`desktopRemote`、
/// `sseUnsupported`，见 `mcp/agents.rs` 的拒绝原因），不认句子的文字
export function isAgentLimit(kind: McpReasonKind | undefined): boolean {
  return kind === "desktopRemote" || kind === "sseUnsupported";
}

/// 有这一项的格：●、可点（点＝确认后从这个 agent 的配置里删掉）。可点的不带 reason，删完那句由调用方给
export const presentView = (): McpCellView => ({ dot: "linked", clickable: true });

/// 逐条对应 spec R1 的映射表。这一列自己有一份定义时，不管是不是本行的来源、和来源一样不一样，
/// 都是 ●（`presentView`）；差异是行级事实，交给 `2 份不一样`
export function viewOf(state: McpDotState, ctx: McpCellContext): McpCellView {
  switch (state) {
    case "own":
    case "equal":
    case "sameEndpoint":
      return presentView();
    case "missing":
      // 可点的唯一一种，所以没有 reason：写进去之后要说的那句由调用方汇总
      return { dot: "missing", clickable: true };
    case "invalid":
      // 整份文件读不出来，这一列都无法写入：画斜杠环（与 skill 的「无法写入」同形）
      return {
        dot: "readOnly",
        clickable: false,
        reason: t("mcp.cell.invalid", { location: ctx.location }),
        issue: "invalidLocation",
      };
    case "unsupported":
      // 搬过去就不是原来那个了，所以整行都不给点——给点的机会等于给犯错的机会。
      // 画成与 skill「同名占位」同一个受阻记号（环 + 短横）：这一格放不进去，不另造一种样式
      return {
        dot: "blocked",
        clickable: false,
        reason: ctx.cellReason ?? unportableText(ctx.service, ctx.source, ctx.unsupportedField),
        ...(ctx.cellReason !== undefined && ctx.cellReasonKind !== undefined
          ? { reasonKind: ctx.cellReasonKind }
          : {}),
      };
  }
}

/// 行级方标签的文案（§3.1 零圆角、不可点）。数的是本域里互不一致的副本处数
export function differentCopiesTag(count: number): string {
  return tn("mcp.differ.tag", count);
}

/// 标签的 title。**必须说清这几处是同一件事**：两处各画一份标记，用户容易读成
/// 「四份」（spec 风险 1）
export function differentCopiesTitle(locations: string[]): string {
  return t("mcp.differ.title", { locations: listText(locations, "and") });
}

/// 两份不一样的整句（行视角）。只标差异、不给覆盖与合并——
/// `prepare` 对目标已有的同名条目一律跳过，覆盖与合并是新的破坏性能力，这一期没有
export function differentCopiesMessage(service: string, locations: string[]): string {
  return t("mcp.differ.message", {
    locations: listText(locations, "and"),
    service,
  });
}

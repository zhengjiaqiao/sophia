/// 格状态 → 圆点 + 点击行为 + 文案。矩阵、导入页与新问题的一次性提示共用这一份映射。
///
/// 存在的理由：后端 `CellState` 有八种，`propose_links` 对四种异常态都返回空动作数组，
/// 凭动作数组为空就统一说一句话，对它们全是错的。所以先判状态，再决定画什么、说什么。
///
/// UI v4 起异常态**在格里画得出来**（DESIGN「视觉优先」）：同一个 10px 环骨架，
/// 失效＝虚线环、无法写入与同名占位＝斜杠环 ⊘（D22）、整个文件夹是链接＝环内向右箭头。
import type { Cell, IssueKind, Target } from "./types";

/// 格里的记号。前三种是常驻状态；`none` 是「这一行在这一列没有格」；
/// 后四种是异常，画在同一个环骨架上（`foreign` 与 `duplicate` 都画成 `blocked`：
/// 对用户都是「同名的挡在那儿」，差别在点击时说的那句话与算不算要拿主意的问题）
export type Dot =
  "own" | "linked" | "missing" | "none" | "broken" | "readOnly" | "blocked" | "wholeLinked";

export interface CellView {
  dot: Dot;
  /// 点下去会真的建链或删链；false 表示点击只说明情况
  clickable: boolean;
  /// 给提示条用的**完整句子**，不是错误码。**只在 `clickable === false` 时有值**：
  /// 为什么不能点。成功句不在这里——按 §4.1，一次批量操作只汇总成一句，
  /// 「每个格自己的成功文案」从构造上就是错的，由调用方在操作结果处聚合（§8.1）
  reason?: string;
  /// 非空表示这是要用户拿主意的问题（就地常显，新出现时提示一次）
  issue?: IssueKind;
}

/// 逐状态的映射表。`agentLabel` 是列头给用户看的 agent 名，
/// `skill` 是行名——两者都由调用方传进来，这里不做任何查表
export function viewOf(cell: Cell, target: Target, agentLabel: string, skill: string): CellView {
  switch (cell.state) {
    case "own":
      // 原件就摆在这个目录里，没有链接可关，点击只说明这件事
      return { dot: "own", clickable: false, reason: "原件就在这儿，不是链接" };
    // 可点的两种不给 reason：关掉/开启之后要说的那句由调用方汇总，见 CellView.reason
    case "linked":
      return { dot: "linked", clickable: true };
    case "missing":
      // 目录还不存在也照样可点：建链接时顺手把目录建出来
      return { dot: "missing", clickable: true };
    case "broken":
      return {
        dot: "broken",
        clickable: false,
        reason: `${agentLabel} 下这条链接指向一个不存在的地方，先清掉它`,
        issue: "brokenLink",
      };
    case "foreign":
      return {
        dot: "blocked",
        clickable: false,
        // pointsTo 为空是不该发生的分支：判 foreign 的那一刻 core 手里正好是 real_path
        // 的结果，一定填得上。真为空就退回含糊的说法，总比说半句话强
        reason: cell.pointsTo
          ? `${agentLabel} 下同名的 ${skill} 指向 ${cell.pointsTo}，没有覆盖它`
          : `${agentLabel} 下同名的 ${skill} 指向别处，没有覆盖它`,
        issue: "duplicateSource",
      };
    case "duplicate":
      // 那里是用户自己放的真实文件或目录，不算要拿主意的问题，只在点击时说一次
      return {
        dot: "blocked",
        clickable: false,
        reason: `${agentLabel} 下已经有同名的 ${skill}，没有覆盖它`,
      };
    case "wholeLinked":
      // 「拆开」是 split_whole_link 唯一的入口，这句话必须把这条出路说出来
      return {
        dot: "wholeLinked",
        clickable: false,
        // linkedWholeTo 为空只是防御：扫描判定 wholeLinked 的依据就是它非空
        reason: `${agentLabel} 的 skills 文件夹整个链接到了${
          target.linkedWholeTo ? ` ${target.linkedWholeTo}` : "别处"
        }，拆开后才能逐个开关`,
        // 与 readOnlyTarget 分开：这一条的动作是拆开，不是再试一次
        issue: "wholeLinkedTarget",
      };
    case "readOnly":
      // 扫描不产出这个状态，只有真的写失败之后上层才会构造出来
      return {
        dot: "readOnly",
        clickable: false,
        reason: `无法写入 ${agentLabel} 的 skills 目录，${skill} 没加上`,
        issue: "readOnlyTarget",
      };
  }
}

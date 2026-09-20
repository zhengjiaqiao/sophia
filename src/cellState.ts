/// 格状态 → 圆点 + 点击行为 + 文案。矩阵、引入页、待处理栏三处共用这一份映射。
///
/// 存在的理由（组件规范 §8）：圆点只有三种形，后端 `CellState` 有八种，归并之后
/// **形相同、点击行为必须分叉**。`broken` / `foreign` / `duplicate` / `wholeLinked`
/// 画出来都是空心，但它们不是「还没开启」——`propose_links` 对它们返回空动作数组，
/// 凭动作数组为空就统一说一句话，对这四种全是错的。所以先判状态，再决定说什么。
import type { Cell, IssueKind, Target } from "./types";

/// 圆点的三种形，外加「这一行在这一列没有格」的无格态
export type Dot = "own" | "linked" | "missing" | "none";

export interface CellView {
  dot: Dot;
  /// 点下去会真的建链或删链；false 表示点击只说明情况
  clickable: boolean;
  /// 给提示条用的**完整句子**，不是错误码。不可点时必填；
  /// 可点的两种（`linked` / `missing`）里，它是点完之后提示条要说的话
  reason?: string;
  /// 非空表示这条要进待处理栏
  issue?: IssueKind;
}

/// 逐条对应组件规范 §8 的映射表。`agentLabel` 是列头给用户看的 agent 名，
/// `skill` 是行名——两者都由调用方传进来，这里不做任何查表
export function viewOf(cell: Cell, target: Target, agentLabel: string, skill: string): CellView {
  switch (cell.state) {
    case "own":
      // 本体就摆在这个目录里，没有链接可关，点击只说明这件事
      return { dot: "own", clickable: false, reason: "本体就在这儿，不是链接" };
    case "linked":
      return {
        dot: "linked",
        clickable: true,
        reason: `关掉了 ${skill} 在 ${agentLabel} 下的链接`,
      };
    case "missing":
      // 目录还不存在也照样可点：建链接时顺手把目录建出来
      return { dot: "missing", clickable: true, reason: `在 ${agentLabel} 下开启了 ${skill}` };
    case "broken":
      return {
        dot: "missing",
        clickable: false,
        reason: `${agentLabel} 下这条链接指向一个不存在的地方，先清掉它`,
        issue: "brokenLink",
      };
    case "foreign":
      // §8 的原句是「指向 <另一个本体>」，但 Cell 里没有那条链接的落点，
      // 这个签名也拿不到，所以只说「别处」。要补准，得后端在 Cell 上带出落点
      return {
        dot: "missing",
        clickable: false,
        reason: `${agentLabel} 下同名的 ${skill} 指向别处，没有覆盖它`,
        issue: "duplicateSource",
      };
    case "duplicate":
      // 那里是用户自己放的真实文件或目录，不进待处理栏，只在点击时说一次
      return {
        dot: "missing",
        clickable: false,
        reason: `${agentLabel} 下已经有同名的 ${skill}，没有覆盖它`,
      };
    case "wholeLinked":
      // 「拆开」是 split_whole_link 唯一的入口，这句话必须把这条出路说出来
      return {
        dot: "missing",
        clickable: false,
        // linkedWholeTo 为空只是防御：扫描判定 wholeLinked 的依据就是它非空
        reason: `${agentLabel} 的 skills 目录整个链到了${
          target.linkedWholeTo ? ` ${target.linkedWholeTo}` : "别的本体位置"
        }，要逐条开关得先拆开`,
        issue: "readOnlyTarget",
      };
    case "readOnly":
      // 扫描不产出这个状态，只有真的写失败之后上层才会构造出来
      return {
        dot: "missing",
        clickable: false,
        reason: `${agentLabel} 的 skills 目录写不进去，${skill} 没能开启`,
        issue: "readOnlyTarget",
      };
  }
}

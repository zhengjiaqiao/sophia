/// 大写结构词（DESIGN「Typography › 大写是结构的语言，原样是内容的语言」「字距：汉字永远 0」）。
///
/// 三个字族都没有中文字形，汉字落到苹方。Condensed 大写 + 字距套到汉字上字字散开，
/// 挨着常宽苹方像两套系统。所以按脚本切成 run：**只有含拉丁字母的 run** 套
/// Condensed + 大写 + 字距，汉字 run 原样、字距 0。数据本身不改（读屏读原文）。
///
/// 用在且只用在：页签 `SKILLS` `MCP`（nav）、侧栏区块小标 `AGENT`、MCP 列头第二行
/// `LOCAL` `PROJECT`、表格列头里的 agent 名 `CLAUDE CODE`（label）、由拉丁结构词组成的
/// 区域小标题（head）、`AgentMark` 首字母（mark：只大写、不加字距）。
/// 中文句子里的拉丁词不要包它——句子是内容，只有独立成词的结构标签才大写。
/// 字号与字重由所在的位置给（页签 15 / 700、小标 12 / 600、标题 16 / 600），`Cap` 只管
/// 拉丁 run 的字族、大写与字距：全应用的大写与正字距只从这里来（lint-ui 的 cap-only）。

export type CapTone = "nav" | "label" | "head" | "mark";

export interface CapProps {
  children: string;
  /// nav：页签 +1.17px；label：区块小标与列头 +0.96px（默认）；head：区域小标题 +1.1px；
  /// mark：首字母方块，只大写不加字距（单个字母加字距会把它挤出方块中线）
  tone?: CapTone;
}

/// CJK 符号与标点、CJK 统一表意文字（含扩展 A）、全角形式
const CJK = /[　-〿㐀-鿿＀-￯]+/g;

/// 切成 [文本, 是不是拉丁 run] 的序列。空白与标点跟着相邻的非 CJK 段走，不单独成 run；
/// 只有真含拉丁字母的段才算拉丁 run（纯空白、纯数字不大写也不加字距）
export function capRuns(text: string): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  let last = 0;
  for (const m of text.matchAll(CJK)) {
    const i = m.index ?? 0;
    if (i > last) out.push([text.slice(last, i), true]);
    out.push([m[0], false]);
    last = i + m[0].length;
  }
  if (last < text.length) out.push([text.slice(last), true]);
  return out.map(([t, latin]) => [t, latin && /[A-Za-z]/.test(t)]);
}

export function Cap({ children, tone = "label" }: CapProps) {
  return (
    <span className={`ss-cap-wrap ss-cap-wrap--${tone}`}>
      {capRuns(children).map(([t, latin], i) =>
        latin ? (
          <span key={i} className="ss-cap">
            {t}
          </span>
        ) : (
          t
        ),
      )}
    </span>
  );
}

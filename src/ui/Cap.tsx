/// 字距与大写只给纯拉丁（DESIGN「Typography › 三个字族都没有中文字形」第 1 条）。
///
/// 三个字族都没有中文字形，汉字落到苹方。Condensed 大写 + 字距套到汉字上字字散开，
/// 挨着常宽苹方像两套系统。所以按脚本切成 run：**只有含拉丁字母的 run** 套
/// Condensed + 大写 + 字距，汉字 run 原样、字距 0。
/// 用在：顶栏页签（`模型 · SKILLS · MCP`）、agent 列头、agent 图标键。
/// 中文句子里的拉丁词不要包它——句子是内容，只有独立成词的结构标签才大写。

export interface CapProps {
  children: string;
  /// nav：顶栏页签 15/700 +1.17；micro：列头与图标键 12/600 +0.96（默认）
  tone?: "nav" | "micro";
}

/// CJK 统一表意文字、CJK 标点、全角形式
const CJK = /[　-〿㐀-鿿＀-￯]+/g;

/// 切成 [文本, 是不是拉丁 run] 的序列。空白与标点跟着相邻的拉丁走，不单独成 run
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
  // 只有真含字母的才算拉丁 run（纯空白、纯数字不大写也不加字距）
  return out.map(([t, latin]) => [t, latin && /[A-Za-z]/.test(t)]);
}

export function Cap({ children, tone = "micro" }: CapProps) {
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

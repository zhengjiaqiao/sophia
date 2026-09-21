import type { ReactNode } from "react";

/// agent 图标与 agent 灯（组件规范 §9、§9.1）。
///
/// 一律单色 inline SVG，`currentColor` 取色：常态主文字色，未启用/禁用退到弱文字色。
/// **不用品牌色**——用了零色彩（§1.1）就破了。
///
/// 41 个 agent 里只有少数几个的标志能在 16px 上认出来，其余降级成**首字母方块**。
/// 方块不是图标的平替，是它缺席时的占位：已安装的 9 个里首字母就撞了 3 个 C
/// （claude-code / codex / cursor）和 2 个 G（gemini-cli / github-copilot），
/// 所以方块**永远和名字一起出现，不单独用**。

/// 画得出、且 16px 上认得出的那几个。缺哪个就去取官方 SVG 转成单色路径，
/// 取不到就保持首字母方块——认不出的图标比没有图标更糟。
const ICONS: Record<string, ReactNode> = {
  "claude-code": (
    <path d="M8 1.3v13.4M4.3 13.1L11.7 2.9M2.5 9.8l11-3.6M2.5 6.2l11 3.6M4.3 2.9l7.4 10.2" />
  ),
  codex: (
    <path d="M8 3.7A2.25 2.25 0 0 1 11.72 5.85A2.25 2.25 0 0 1 11.72 10.15A2.25 2.25 0 0 1 8 12.3A2.25 2.25 0 0 1 4.28 10.15A2.25 2.25 0 0 1 4.28 5.85A2.25 2.25 0 0 1 8 3.7Z" />
  ),
  cursor: (
    <>
      <path d="M8 1.6l5.5 3.2v6.4L8 14.4 2.5 11.2V4.8Z" />
      <path d="M8 8v6.4M8 8l5.5-3.2M8 8L2.5 4.8" />
    </>
  ),
};

/// 描边式的三个用 stroke，gemini 的四角星是实心的，单独走 fill
const FILLED = new Set(["gemini-cli"]);

/// 这个 agent 有没有画得出的图标
export function hasAgentIcon(id: string): boolean {
  return id in ICONS || FILLED.has(id);
}

/// 名字的首字母，取不到就用问号占位
export function agentInitial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export interface AgentIconProps {
  id: string;
  /// 降级成首字母方块时要用它的首字母；调用方必须把名字也显示在旁边
  name: string;
  size?: number;
}

/// 只有图标本身。**旁边必须有名字**，否则用 AgentMark。
export function AgentIcon({ id, name, size = 16 }: AgentIconProps) {
  if (FILLED.has(id)) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 1.1C8.5 5.1 10.9 7.5 14.9 8C10.9 8.5 8.5 10.9 8 14.9C7.5 10.9 5.1 8.5 1.1 8C5.1 7.5 7.5 5.1 8 1.1Z" />
      </svg>
    );
  }

  const path = ICONS[id];
  if (path) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        // 与 icons.tsx 同一笔宽：两套图标挨着出现（列头的 agent 标 + 行上的动作图标），
        // 差 0.1 看不出来，但同一份数值省得以后各调各的
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  }

  // 降级：14px 零圆角方框 + 大写首字母。禁用时只有字母变灰，边框不动——
  // 再退就跟背景糊在一起了。
  return (
    <span className="ss-mark__box" aria-hidden="true">
      {agentInitial(name)}
    </span>
  );
}

export interface AgentMarkProps {
  id: string;
  /// 显示名，原样写。**不大写**——大写是结构的语言，不大写是内容的语言（§1.2）
  name: string;
  /// inline：设置页与导入页的横排；stacked：矩阵列头，图标在上名字在下。
  /// 列头是 agent 名大写的唯一例外——那里它承担的是列标签的职能
  layout?: "inline" | "stacked";
  /// 没装这个 agent、或整行禁用：图标跟着文字一起退到弱文字色，形状不变
  dim?: boolean;
  title?: string;
}

export function AgentMark({ id, name, layout = "inline", dim, title }: AgentMarkProps) {
  const classes = ["ss-mark", `ss-mark--${layout}`];
  if (dim) classes.push("is-dim");

  return (
    <span className={classes.join(" ")} title={title}>
      <span className="ss-mark__icon">
        <AgentIcon id={id} name={name} />
      </span>
      <span className="ss-mark__name">{name}</span>
    </span>
  );
}

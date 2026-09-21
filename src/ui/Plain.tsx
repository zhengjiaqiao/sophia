import type { ReactNode } from "react";

/// 大写档里嵌专名的正式出口。
///
/// `display` / `button-cap` / `micro-cap` 三档都带 `text-transform: uppercase`——
/// 「大写是结构的语言，不大写是内容的语言」（DESIGN「Typography」），但 CSS 的转换
/// 是整段生效的，agent 名嵌进去会被一起转成 `CODEX`。这个坑踩过两次，第二次
/// （「重启 CODEX」）是渲染成图才看出来。任何按钮、标题、标签里出现 agent 名、
/// skill 名、路径，都用它包一层。
export function Plain({ children }: { children: ReactNode }) {
  return <span className="ss-plain">{children}</span>;
}

/// JS 里要等一段 CSS 过渡播完的地方（抽屉滑回后卸内容、新手提示条收起后卸、提示条到点前淡出、推入页滑回后
/// 交给调用方）从这里取时长：**值只在 tokens.css 写一次**，JS 不另存一份常量——改了 token，等待时间跟着变。
/// `prefers-reduced-motion` 下 tokens.css 把位移类时长置 0，这里读到的也就是 0，调用方不必再各判一次。

/// CSS 时长写法 → 毫秒：`260ms` → 260、`0.8s` → 800；空串、写错的一律 0（没有 token 时不拖延卸载）
export function parseDuration(raw: string): number {
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/.exec(raw);
  if (!m) return 0;
  const n = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/// 读一个时长 token（`--dur-drawer`）此刻的值。没有文档（服务端渲染、node:test）时是 0
export function motionMs(token: `--${string}`): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(token));
}

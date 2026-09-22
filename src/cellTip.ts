/// 做不了事的格子的说明（DESIGN「提示框」：点了做不了的格子，立刻说明）：先说为什么，再说去哪做。
/// 点下去当即弹出，所以这句必须自己站得住，不能只是状态名
import type { CellState } from "./types";

/// skill 格：原件、同名被挡改写成「为什么 · 去哪做」；其余沿用 cellState 给的原因（fallback）
export function blockedTipOf(
  state: CellState,
  agent: string,
  skill: string,
  fallback: string,
): string {
  if (state === "own") return `这就是原件，不需要链接 · 要从 ${agent} 移除，只能删掉原件`;
  if (state === "foreign" || state === "duplicate")
    return `${agent} 下已有一个同名的 ${skill}，不是这一份`;
  return fallback;
}

/// MCP 的原件格：定义就写在这个位置里
export const mcpOwnTip = (location: string) =>
  `这就是原件，不需要写进 · 要从 ${location} 移除，只能到它的配置里删掉`;

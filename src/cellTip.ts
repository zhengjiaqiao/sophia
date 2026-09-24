/// 做不了事的格子的说明（DESIGN「提示框」：点了做不了的格子，立刻说明）：先说为什么，再说去哪做。
/// 点下去当即弹出，所以这句必须自己站得住，不能只是状态名
import type { CellState } from "./types";

/// skill 格：原件、同名占位改写成「为什么 · 去哪做」；其余沿用 cellState 给的原因（fallback）。
/// `occupant`：同名占位（⊘，D22）时占着这一格的是表格里另一行的哪个来源——知道时说出它，
/// 并指到这一行上的 `只留这份`；不知道（占着的是用户自己放的文件，或别处的链接）时只说有一个同名的
export function blockedTipOf(
  state: CellState,
  agent: string,
  skill: string,
  fallback: string,
  occupant?: string,
): string {
  if (state === "own") return `这就是原件，不需要链接 · 要从 ${agent} 移除，只能删掉原件`;
  if (state === "foreign" || state === "duplicate")
    return occupant
      ? `${agent} 里已有 ${occupant} 那份同名的 ${skill} · 在这一行上只留一份`
      : `${agent} 里已有一个同名的 ${skill}，不是这一份`;
  return fallback;
}

/// MCP 的原件格：本行的来源就写在这个位置里，不能在格子上移除（DESIGN「原件格不能点」）。
/// 与 core `mcp::removal::ORIGINAL_MESSAGE` 同一句：点了原件格，core 拒绝时说的也是它（D24：
/// 来源管理页已删，去处改成选中这个来源的片、在来源行上移除）
export const MCP_OWN_TIP =
  "这是原件所在的位置，从这里移除等于删掉原件 · 要移除，选中这个来源的片，在来源行上移除这个来源";

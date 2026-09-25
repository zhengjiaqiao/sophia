/// 做不了事的格子的说明（DESIGN「提示框」：点了做不了的格子，立刻说明）：先说为什么，再说去哪做。
/// 点下去当即弹出，所以这句必须自己站得住，不能只是状态名
import type { CellState } from "./types";

/// skill 格：同名占位改写成「为什么 · 去哪做」；其余沿用 cellState 给的原因（fallback）。
/// 原件格不在此列：它点了是删原件，提示框是动词（DESIGN「删除原件」）。
/// `occupant`：同名占位（⊘，D22）时占着这一格的是表格里另一行的哪个来源——知道时说出它，
/// 并指到这一行上的 `只留这份`；不知道（占着的是用户自己放的文件，或别处的链接）时只说有一个同名的
export function blockedTipOf(
  state: CellState,
  agent: string,
  skill: string,
  fallback: string,
  occupant?: string,
): string {
  if (state === "foreign" || state === "duplicate")
    return occupant
      ? `${agent} 里已有 ${occupant} 那份同名的 ${skill} · 在这一行上只留一份`
      : `${agent} 里已有一个同名的 ${skill}，不是这一份`;
  return fallback;
}

/// MCP 的原件：批量移除（选择行）不删它，被跳过时说这一句；要删就点那一格（DESIGN「删除原件」）。
/// 与 core `mcp::removal::ORIGINAL_MESSAGE` 同一句：批量移除碰到原件、core 跳过时说的也是它
export const MCP_OWN_TIP = "这是原件所在的位置，批量移除不删它 · 要删掉，点这一格";

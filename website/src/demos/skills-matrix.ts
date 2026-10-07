/// skill 与 MCP 区的矩阵演示（R10）：5 行 × 4 个 agent 的格子状态机。纯逻辑，不碰 DOM；
/// 点格子的结果与提示条文案在这里定，组件只负责渲染与接线。文案走目录（`skills.*`），
/// 提示以「键 + 参数」返回，由调用方用 t 取（页面脚本在浏览器里取不到整本目录，见 site-structure）。
import { t, type Lang, type Params } from "../i18n.ts";

/// 四种格子：已加上 ●、点一下加上 ○、原件在这里 ⦿、链接断了（虚线圈）
export type CellState = "added" | "open" | "original" | "broken";

export const AGENTS = ["Claude Code", "Codex", "Cursor", "Gemini"] as const;

export interface Row {
  name: string;
  kind: "skill" | "mcp";
  cells: CellState[];
}

/// 初始状态照画板：L=added O=open S=original B=broken
export const ROWS: Row[] = [
  { name: "pr-review", kind: "skill", cells: ["added", "open", "added", "open"] },
  { name: "brand-voice", kind: "skill", cells: ["original", "added", "added", "added"] },
  { name: "sql-explain", kind: "skill", cells: ["added", "broken", "added", "open"] },
  { name: "github", kind: "mcp", cells: ["added", "added", "open", "open"] },
  { name: "figma", kind: "mcp", cells: ["open", "open", "original", "open"] },
];

/// 提示条：目录键 + 参数（键写字面量，catalog 测试会核对）
export type Toast =
  | { key: "skills.added"; params: { agent: string } }
  | { key: "skills.removed"; params: { agent: string } }
  | { key: "skills.fixed"; params: { name: string; agent: string } }
  | { key: "skills.original"; params: { name: string; agent: string } };

/// 点一格：返回新状态与提示。原件格点了不变，只告诉用户原件在这里。
export function press(state: CellState, ctx: { name: string; agent: string }): { next: CellState; toast: Toast } {
  const { name, agent } = ctx;
  switch (state) {
    case "open":
      return { next: "added", toast: { key: "skills.added", params: { agent } } };
    case "added":
      return { next: "open", toast: { key: "skills.removed", params: { agent } } };
    case "broken":
      return { next: "added", toast: { key: "skills.fixed", params: { name, agent } } };
    case "original":
      return { next: "original", toast: { key: "skills.original", params: { name, agent } } };
  }
}

export function toastText(lang: Lang, toast: Toast): string {
  switch (toast.key) {
    case "skills.added":
      return t(lang, "skills.added", toast.params);
    case "skills.removed":
      return t(lang, "skills.removed", toast.params);
    case "skills.fixed":
      return t(lang, "skills.fixed", toast.params);
    case "skills.original":
      return t(lang, "skills.original", toast.params);
  }
}

/// 状态的说法（图例同一句）：枚举写键表，键只写字面量（DESIGN「文案目录」）
const STATE_KEYS = {
  added: "skills.legendAdded",
  open: "skills.legendAdd",
  original: "skills.legendOriginal",
  broken: "skills.legendBroken",
} as const;

export const stateText = (lang: Lang, state: CellState): string => t(lang, STATE_KEYS[state]);

/// 读屏说法：「pr-review，Codex：点一下加上」
export function cellLabel(lang: Lang, name: string, agent: string, state: CellState): string {
  const params: Params = { name, agent, state: stateText(lang, state) };
  return t(lang, "skills.cellLabel", params);
}

/// 行名：MCP 带「（MCP）」
export function rowName(lang: Lang, row: Row): string {
  return row.kind === "mcp" ? t(lang, "skills.mcpName", { name: row.name }) : row.name;
}

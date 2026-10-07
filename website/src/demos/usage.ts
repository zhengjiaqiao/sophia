/// 用量演示的纯逻辑（R11、AC7）：示例数据 + 三项设置 → 菜单栏分段与面板行。
/// 不 import astro / DOM。文案不在这里：窗口名、重置时间只给键名（usage.w5h、usage.reset5h…），由调用方取。
/// 示例数据同时给 #242 短片的镜头 5 用（同一份：Claude 5 小时 / 本周 / 本周 · Fable，Codex 只有本周）。

export type Agent = "claude" | "codex";
export type Mode = "remaining" | "used";
/// 窗口 id 对应文案键 usage.<id>
export type WindowId = "w5h" | "week" | "weekFable";
/// 重置时间对应文案键 usage.<reset>
export type ResetKey = "reset5h" | "resetWeek" | "resetCodexWeek";

export interface UsageWindow {
  id: WindowId;
  /** 已用百分比（0–100，整数） */
  usedPct: number;
  reset: ResetKey;
}
export interface AgentUsage {
  plan: string;
  windows: UsageWindow[];
}
export type UsageData = Record<Agent, AgentUsage>;

export interface UsageSettings {
  show: Record<Agent, boolean>;
  mode: Mode;
  stack: boolean;
}

/// 展示顺序固定：Claude 在前
export const AGENTS: Agent[] = ["claude", "codex"];

export const USAGE_SAMPLE: UsageData = {
  claude: {
    plan: "Max",
    windows: [
      { id: "w5h", usedPct: 42, reset: "reset5h" },
      { id: "week", usedPct: 67, reset: "resetWeek" },
      { id: "weekFable", usedPct: 23, reset: "resetWeek" },
    ],
  },
  codex: {
    plan: "Pro",
    windows: [{ id: "week", usedPct: 35, reset: "resetCodexWeek" }],
  },
};

export const DEFAULT_SETTINGS: UsageSettings = {
  show: { claude: true, codex: true },
  mode: "remaining",
  stack: false,
};

export interface TraySegment {
  agent: Agent;
  /** 一个数；叠放时两个（上 5 小时、下本周），百分号已带 */
  values: string[];
}
export interface PanelRow {
  window: WindowId;
  /** left 对应「剩 {pct}」，used 对应「用 {pct}」 */
  kind: "left" | "used";
  value: string;
  /** 条的填充比例 0–1：剩余模式是剩余、已用模式是已用 */
  fill: number;
  reset: ResetKey;
}
export interface PanelSection {
  agent: Agent;
  plan: string;
  rows: PanelRow[];
}
export interface UsageView {
  tray: TraySegment[];
  panel: PanelSection[];
  /** 两家都没选：面板写「菜单栏没显示用量」 */
  empty: boolean;
}

export function toggleAgent(s: UsageSettings, agent: Agent): UsageSettings {
  return { ...s, show: { ...s.show, [agent]: !s.show[agent] } };
}

function shown(w: UsageWindow, mode: Mode): number {
  return mode === "remaining" ? 100 - w.usedPct : w.usedPct;
}

export function computeUsage(s: UsageSettings, data: UsageData = USAGE_SAMPLE): UsageView {
  const on = AGENTS.filter((a) => s.show[a]);
  const tray = on.map((agent): TraySegment => {
    const w = data[agent].windows;
    // 叠放只对有两个以上窗口的那家起作用
    const picked = s.stack && w.length > 1 ? [w[0], w[1]] : [w[0]];
    return { agent, values: picked.map((x) => `${shown(x, s.mode)}%`) };
  });
  const panel = on.map(
    (agent): PanelSection => ({
      agent,
      plan: data[agent].plan,
      rows: data[agent].windows.map((w) => ({
        window: w.id,
        kind: s.mode === "remaining" ? "left" : "used",
        value: `${shown(w, s.mode)}%`,
        fill: shown(w, s.mode) / 100,
        reset: w.reset,
      })),
    }),
  );
  return { tray, panel, empty: on.length === 0 };
}

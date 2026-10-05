import type {
  AgentGatewayView,
  GatewayCodex,
  GatewayHookupMode,
  GatewayModeReason,
  GatewayPortNotice,
  GatewayProvider,
  GatewayRouter,
  GatewayState,
  GatewayTakeover,
} from "../src/types.ts";

/// 用例里写 Codex 的状态用的平铺字段（按家拆开之前那种写法，短）：`gatewayFixture` 拼成 spec 2026-09-29 R39 之后的
/// `GatewayState`（顶层只剩 supported、router、portNotice、agents）。只是夹具的写法，页面与托盘读的是 `agents` 里 Codex 那一份
export interface CodexFixture {
  supported: boolean;
  providers: GatewayProvider[];
  enabled: boolean;
  needsCodexRestart: boolean;
  router: GatewayRouter & { protocol?: string };
  /// 路由端口的说明（打开 Sophia 时没接上、换了端口）；不给是 null
  portNotice?: GatewayPortNotice | null;
  /// Codex「开着」（用户的选择）；不给同 `enabled`
  wanted?: boolean;
  codex: GatewayCodex;
  /// Codex 的接法；不给是借用内置
  mode?: GatewayHookupMode;
  /// 选这种接法的原因；不给是 null
  modeReason?: GatewayModeReason | null;
  conflict: string;
  takeover: GatewayTakeover | null;
  /// Claude 那一份；不给就是关着、什么都没配、桌面应用没装
  claude?: AgentGatewayView;
}

export const CLAUDE_OFF: AgentGatewayView = {
  agent: "claude",
  installed: false,
  providers: [],
  enabled: false,
  conflict: "",
  claude: {
    profileModels: [],
    desktop: {
      version: null,
      tooOld: false,
      managed: false,
      running: false,
      applied: false,
      pending: false,
      needsRestart: false,
      drift: false,
      restoreUnfinished: false,
      foreign: null,
    },
  },
};

export function gatewayFixture(f: CodexFixture): GatewayState {
  const { running, port, error } = f.router;
  return {
    supported: f.supported,
    router: { running, port, error },
    portNotice: f.portNotice ?? null,
    agents: f.supported
      ? [
          {
            agent: "codex",
            installed: f.codex.version !== "",
            providers: f.providers,
            enabled: f.enabled,
            conflict: f.conflict,
            codex: {
              wanted: f.wanted ?? f.enabled,
              needsRestart: f.needsCodexRestart,
              app: f.codex,
              takeover: f.takeover,
              mode: f.mode ?? "builtin",
              modeReason: f.modeReason ?? null,
            },
          },
          f.claude ?? CLAUDE_OFF,
        ]
      : [],
  };
}

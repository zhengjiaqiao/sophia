import type {
  AgentGatewayView,
  AgentModels,
  GatewayCodex,
  GatewayHookupMode,
  GatewayModeReason,
  GatewayPortNotice,
  GatewayRouter,
  GatewayState,
  GatewayTakeover,
} from "../src/types.ts";

/// 用例里写 Codex 的状态用的平铺字段（按家拆开之前那种写法，短）：`gatewayFixture` 拼成 spec 2026-09-29 R39 之后的
/// `GatewayState`（顶层只剩 supported、router、portNotice、agents）。只是夹具的写法，页面与托盘读的是 `agents` 里 Codex 那一份
export interface CodexFixture {
  supported: boolean;
  /// Codex 的「已选」与浮层分组；不给是什么都没选、一家提供商都没有
  models?: AgentModels;
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
  /// WorkBuddy 那一份（#266）；不给就不列
  workbuddy?: AgentGatewayView;
  /// Claude 那一份；不给就是关着、什么都没配、桌面应用没装
  claude?: AgentGatewayView;
}

/// 什么都没选、一家提供商都没有
export const NO_MODELS: AgentModels = { picked: [], groups: [], providers: 0 };

/// 「已选」：`提供商名/模型` 一项一个（`官方/gpt-6` 是官方模型），提供商 id 取名字的小写
export function picked(...items: string[]): AgentModels {
  const names = new Set<string>();
  const list = items.map((item) => {
    const [provider, ...rest] = item.split("/");
    const model = rest.join("/");
    if (provider === "官方") {
      return { ref: { provider: "@official", model }, displayName: model, providerName: "" };
    }
    names.add(provider);
    return {
      ref: { provider: provider.toLowerCase(), model },
      displayName: model,
      providerName: provider,
    };
  });
  return { picked: list, groups: [], providers: names.size };
}

export const CLAUDE_OFF: AgentGatewayView = {
  agent: "claude",
  installed: false,
  models: NO_MODELS,
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
            models: f.models ?? NO_MODELS,
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
          ...(f.workbuddy ? [f.workbuddy] : []),
        ]
      : [],
  };
}

/// agent 能力注册表的类型与取用（DESIGN「模型页」「扩展预留：用量与会话」；spec 2026-09-26-object-first-navigation R11）。
///
/// **两个扩展点之一**（另一个是 destinations.ts 的目的地表，它决定侧栏）：这张表生成模型页里的节、
/// 托盘面板的块与行（节带 `trayRow` 画法，面板按表画，不认得具体哪一节），并决定侧栏「模型」一项在不在、
/// 名字后亮不亮橙点。每一项：id、名字（原样大小写）、图标（`AgentIcon` 按 id 取）、指示点条件、能力节列表。
/// **只列有能力节的 agent**：节列表为空、或此刻不可用的，不列、也不灰着列；一个都没有时侧栏不列「模型」。
///
/// 加一个 agent / 一种能力＝往 `agents.tsx` 的表里加一项 / 一节，写一个节组件；外壳、路由都不改。
/// 这里只放类型与纯函数（不产 JSX），tests/shell-extension.test.ts 直接测。

import type { ComponentType } from "react";
import type { GatewayState } from "../types.ts";

/// 判断「在不在、开没开」用的只读状态（壳持有，逐项往里加）
export interface AgentState {
  /// 模型状态（第三方模型）；还没读回来是 null
  gateway: GatewayState | null;
  /// 后端支不支持第三方模型（只有 macOS 支持）；还没问出来是 null
  modelsSupported: boolean | null;
}

/// 节组件拿到的：壳的回调（节自己的数据自己读）
export interface AgentSectionProps {
  onError: (message: string) => void;
  /// 节改了模型状态：侧栏指示点跟着更新
  onGatewayState: (state: GatewayState) => void;
  /// 壳的错误横幅开着（机面顶上的灰面板）：节里的新手提示让位
  banner?: boolean;
}

/// 托盘面板给每一行的面板级共用（TrayPanel 持有）
export interface TrayHost {
  /// 后端给的新模型状态：画到面板上并广播给主窗口
  applyGateway: (next: GatewayState) => void;
  /// 排在还没写完的写入后面（都写 Codex 设置，先后要和点的顺序一致）
  idle: () => Promise<void>;
  /// 面板还在不在（异步回来之前被卸下就什么都不做）
  alive: () => boolean;
  /// 第几次弹出：行据此收回上次没答的确认
  openedAt: number;
  /// 做不成、面板放不下一段解释：主窗口到前面、切过去、把原话带过去
  failOver: (error: unknown) => void;
}

/// 托盘面板里一节的那一行拿到的
export interface TrayRowProps {
  /// 节名（`第三方模型`），行首写它
  title: string;
  /// 面板读回来的只读状态（与侧栏同一种 AgentState）
  state: AgentState;
  tray: TrayHost;
}

/// agent 页的一节（一种能力）：节头、开关、内容都归节组件自己画；页只负责按表的先后排、节间 48
export interface AgentSection {
  /// 稳定标识（`third-party-models`、以后的 `usage`）
  id: string;
  /// 节名（`第三方模型`），托盘的能力行也用它
  title: string;
  Component: ComponentType<AgentSectionProps>;
  /// 托盘面板里这一节的一行怎么画（DESIGN「托盘面板」一种能力一行）。不给就不进托盘
  trayRow?: ComponentType<TrayRowProps>;
}

export interface AgentEntry {
  /// 与 harness id 一致（`codex`），`AgentIcon` 按它取图标，落点记忆存它
  id: string;
  /// 原样大小写（专名）
  name: string;
  /// 此刻有没有这一页：true 列出、false 不列；null＝还不知道（状态没读回来），先不列、也不据此改落点
  available: (s: AgentState) => boolean | null;
  /// 名字后画不画 6px 橙点：这个 agent 上有能力开着、在生效
  indicator: (s: AgentState) => boolean;
  /// 能力节，按页内先后（以后 `用量` 排在 `第三方模型` 上面）
  sections: ReadonlyArray<AgentSection>;
}

/// 此刻列出的 agent：可用且有节的，按表的先后。`known` 为假时（有一项还不知道）
/// 落点不据此退回——免得状态没读回来就把记着的模型页当成不在了
export function visibleAgents(
  registry: ReadonlyArray<AgentEntry>,
  s: AgentState,
): { agents: AgentEntry[]; known: boolean } {
  let known = true;
  const agents: AgentEntry[] = [];
  for (const entry of registry) {
    const on = entry.available(s);
    if (on === null) known = false;
    if (on === true && entry.sections.length > 0) agents.push(entry);
  }
  return { agents, known };
}

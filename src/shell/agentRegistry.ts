/// agent 能力注册表的类型与取用（DESIGN「模型页」「扩展预留：用量与会话」；spec 2026-09-26-object-first-navigation R11）。
///
/// **两个扩展点之一**（另一个是 destinations.ts 的目的地表，它决定侧栏）：这张表生成模型页里的节、
/// 托盘面板的块与行（节带 `trayRow` 画法，面板按表画，不认得具体哪一节），并决定侧栏「模型」一项在不在、
/// 名字后亮不亮橙点。每一项：id、名字（原样大小写）、图标（`AgentIcon` 按 id 取）、指示点条件、能力节列表。
/// **只列有能力节的 agent**：节列表为空、或此刻不可用的，不列、也不灰着列；一个都没有时侧栏不列「模型」。
///
/// 加一个 agent / 一种能力＝往 `agents.tsx` 的表里加一项 / 一节，写一个节组件；外壳、路由都不改。
/// 这里只放类型与纯函数（不产 JSX），tests/shell-extension.test.ts 直接测。
///
/// 模型页一层（#259；DESIGN「### 模型」）：一个 agent 一行，没有二级页——行的第二行、行尾的选模型键、右端控件列、
/// 行上的灰字与行下的待办条由第三方模型那一节的 `listRow` 给。只列装了的、能接第三方模型的 agent（节级 `available`）。

import type { ComponentType, ReactNode } from "react";
import type { GatewayAgent, GatewayState, GatewayUnreadable, UsageView } from "../types.ts";

/// 判断「在不在、开没开」用的只读状态（壳持有，逐项往里加）
export interface AgentState {
  /// 模型状态（第三方模型，两家都在里面：`agents` 按家拆开，这一项读哪一家看 `AgentEntry.gateway`）；
  /// 还没读回来是 null
  gateway: GatewayState | null;
  /// 后端支不支持第三方模型（只有 macOS 支持）；还没问出来是 null
  modelsSupported: boolean | null;
  /// 用量（托盘的用量行、块头后的重置时间）；还没读回来、或这台机器没有用量是 null
  usage: UsageView | null;
  /// 模型状态整个读不回来（命令本身失败，spec 2026-10-04-local-diagnostics R11）：入口照常在，模型页顶上说；没有为缺省 / null
  gatewayError?: GatewayUnreadable | null;
}

/// 节组件拿到的：壳的回调（节自己的数据自己读）
export interface AgentSectionProps {
  onError: (message: string) => void;
  /// 节改了模型状态：侧栏指示点跟着更新
  onGatewayState: (state: GatewayState) => void;
  /// 壳的错误横幅开着（机面顶上的灰面板）：节里的新手提示让位
  banner?: boolean;
}

/// 模型页里这一家那一行的右端控件列、行下待办条拿到的（DESIGN「### 模型」）
export interface AgentListRowProps extends AgentSectionProps {
  /// 这一行是哪个 agent（注册表的 id）
  agent: string;
  /// 与侧栏、托盘同一种只读状态
  state: AgentState;
  /// 没写成时这一行下出的行内灰面板（+ `再试一次`）：交给模型页挂在这一行下面；传 null 收起
  onNotice: (notice: ReactNode | null) => void;
  /// 行尾的 `已选 N 个模型 ▾`（模型页画好交过来）：控件列把它放在条件键与开关之间（画板第 1 屏）
  pick?: ReactNode;
}

/// 模型页里这一家那一行（DESIGN「### 模型」，画板第 1、1′ 屏）。行本身（图标、名字、行尾 `已选 N 个模型 ▾` 与它的浮层）
/// 归模型页画；这里只给行里因家而异的几样
export interface AgentListRow {
  /// 第二行那一句现状：按提供商的计数 `官方 2 · Kimi 2 · DeepSeek 1`、`没接第三方模型`、`还没选模型`、
  /// `由 agents-manager 管理`；Claude 另有 `在用别的第三方配置`、`由组织统一配置`…
  status: (s: AgentState) => string;
  /// 第二行后面的一句灰字（开着时的代价、换了端口要重启……）；没有为 null
  note?: (s: AgentState) => string | null;
  /// 右端控件列：条件出现的键（`重启生效` / `启动 Codex` / `打开 Claude`）+ 12 + `已选 N 个模型 ▾`（`pick`）+ 12 + 开关。
  /// 开关按下即写、不确认；禁用时按下即说原因
  Controls: ComponentType<AgentListRowProps>;
  /// 行下的待办条（接管、重新写入……）；没有就不给
  Todos?: ComponentType<AgentListRowProps>;
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
  /// 重读用量视图（只读不取）：「再试一次」跑完后先把新数画上，再收回「正在读取」
  rereadUsage: () => Promise<void>;
}

/// 托盘面板里一节的那一行拿到的
export interface TrayRowProps {
  /// 这一块是哪个 agent（注册表的 id）：同一种行（用量）在几块里各画各的
  agent: string;
  /// 节名（`第三方模型`），行首写它
  title: string;
  /// 面板读回来的只读状态（与侧栏同一种 AgentState）
  state: AgentState;
  tray: TrayHost;
}

/// agent 的一种能力：模型页里的一行（`listRow`）、模型页里铺开的一节（`Component`）和 / 或托盘里的一行（`trayRow`），
/// 至少给一样
export interface AgentSection {
  /// 稳定标识（`third-party-models`、`usage`）
  id: string;
  /// 节名（`第三方模型`），托盘的能力行也用它
  title: string;
  /// 节级可用：此刻这一节在不在（`用量`＝这个 agent 登录了；Claude 的 `第三方模型`＝本机支持第三方模型）。
  /// 不给＝跟着 agent 走；null＝还不知道，先不画
  available?: (s: AgentState) => boolean | null;
  /// 铺在模型页里的一节（没有 `listRow` 时）。都不给就不进模型页（`用量` 有自己的一页，只在托盘里占一行）
  Component?: ComponentType<AgentSectionProps>;
  /// 模型页里这一家那一行（第三方模型）
  listRow?: AgentListRow;
  /// 托盘面板里这一节的一行怎么画（DESIGN「托盘面板」一种能力一行）。不给就不进托盘
  trayRow?: ComponentType<TrayRowProps>;
}

export interface AgentEntry {
  /// 与 harness id 一致（`codex`），`AgentIcon` 按它取图标，落点记忆存它
  id: string;
  /// 原样大小写（专名）。托盘块头、用量页用它
  name: string;
  /// 模型页里的显示名（那一行、选模型浮层标题、提供商页说到这一家）；不给就用 `name`。
  /// Claude 在托盘里叫 `Claude`（块里的用量是账号的），在模型页里叫 `Claude 桌面应用`（这一行只改桌面应用）。
  /// 照界面语言取，所以是函数
  modelsName?: () => string;
  /// 这一块的第三方模型读网关状态里的哪一家（spec「家」）：`codex` → `codex`，`claude-code` → `claude`。
  /// 前端其余地方不做 id 换算；没有第三方模型的 agent 不给
  gateway?: GatewayAgent;
  /// 此刻有没有这一页：true 列出、false 不列；null＝还不知道（状态没读回来），先不列、也不据此改落点
  available: (s: AgentState) => boolean | null;
  /// 名字后画不画 6px 橙点：这个 agent 上有能力开着、在生效
  indicator: (s: AgentState) => boolean;
  /// 托盘块头名字后的一段弱字（用量：「2:58 后重置 · 2 小时前更新」）；不给或 null 不画
  headNote?: (s: AgentState) => string | null;
  /// 能力节，按页内先后（以后 `用量` 排在 `第三方模型` 上面）
  sections: ReadonlyArray<AgentSection>;
}

/// 模型页里这一家叫什么（判断只在这一处）
export const modelsNameOf = (entry: AgentEntry): string => entry.modelsName?.() ?? entry.name;

/// 节此刻可不可用：不给 `available` 的节跟着 agent 走（算可用）
export const sectionAvailable = (section: AgentSection, s: AgentState): boolean | null =>
  section.available ? section.available(s) : true;

/// 此刻画得出的节：节级可用为真的，按节序（托盘取行、模型页取页都经它）
export const availableSections = (entry: AgentEntry, s: AgentState): AgentSection[] =>
  entry.sections.filter((section) => sectionAvailable(section, s) === true);

/// 这一节进不进模型页：有一行（`listRow`）或一节（`Component`）
const inModelsPage = (section: AgentSection): boolean =>
  section.listRow !== undefined || section.Component !== undefined;

/// 模型页里画得出的节（进模型页、且此刻可用的）
export const pageSections = (entry: AgentEntry, s: AgentState): AgentSection[] =>
  availableSections(entry, s).filter(inModelsPage);

/// 模型页与侧栏「模型」一项列出的 agent：可用且有此刻可用的模型页节，按表的先后（判断只在这一处）。
/// 只有托盘行的 agent 不参与：既不列，也不让「知不知道」悬着。
/// `known` 为假时（有一项还不知道）落点不据此退回——免得状态没读回来就把记着的模型页当成不在了
export function visibleAgents(
  registry: ReadonlyArray<AgentEntry>,
  s: AgentState,
): { agents: AgentEntry[]; known: boolean } {
  let known = true;
  const agents: AgentEntry[] = [];
  for (const entry of registry) {
    const withPage = entry.sections.filter(inModelsPage);
    if (withPage.length === 0) continue;
    const on = entry.available(s);
    if (on === null) known = false;
    if (on !== true) continue;
    const pages = withPage.map((section) => sectionAvailable(section, s));
    if (pages.includes(null)) known = false;
    if (pages.includes(true)) agents.push(entry);
  }
  return { agents, known };
}

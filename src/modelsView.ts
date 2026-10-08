import { t } from "./i18n.ts";
import { agentGateway, codexGateway, withAgentGateway } from "./types.ts";
import type { AgentState } from "./shell/agentRegistry.ts";
import type { GatewayState, UsageView } from "./types.ts";
import { pickCounts, thirdPartyCount } from "./pickView.ts";

/**
 * 页面上的一个**工具**（Codex、以后可能还有别的）。
 *
 * 后端今天只支持 Codex，这一层不是为了现在就多支持一个，而是**别让版面和文案
 * 写死一个工具**：标题、空态、提示条、限制说明都从这里取名字，加第二个工具时
 * 只改这张表，不用回去翻每一句话。
 */
export interface ModelsTool {
  /// `AgentIcon` 的 id
  id: string;
  /// 显示名，**不大写**——它是被谈论的对象（DESIGN §1.2）
  name: string;
  /// 用这个工具的第三方模型要知道的事（全文，不截断）
  limitations: string;
  /// 开关改的那个配置文件（短路径 `~/…`）：开关的提示框里说（新手提示只说结果，机制留给悬停，
  /// DESIGN 2026-09-25 评审第二轮）
  configPath: string;
}

export const CODEX: ModelsTool = {
  id: "codex",
  name: "Codex",
  configPath: "~/.codex/config.toml",
  // getter：用的时候才取文案，模块加载时不定死语言
  get limitations() {
    return t("models.tool.codexLimitations");
  },
};

/// 任一家在用路由（路由两家共用：任一家在用它就得在跑，两家都不用了才卸，spec 2026-09-29 R8 R46）。
/// 与 core `claude_on` 同一条：Claude 拨关了、等重启生效时桌面应用里还写着 Sophia（`applied`），仍在用
export function anyGatewayOn(state: GatewayState): boolean {
  return state.agents.some((view) => view.enabled || view.claude?.desktop.applied === true);
}

/// 有一家开着但路由没在跑：那一家的第三方模型用不了（Codex 的官方模型也可能受影响），在列表页与各家的页头下提醒
export function routerUnavailable(state: GatewayState): boolean {
  return anyGatewayOn(state) && !state.router.running;
}

/// 上下文长度的读数：`1M` `200K` `128K`；网关没给为 null。
/// 整千的按十进制（128000 → `128K`）；不是整千、却整除 1024 的按二进制（131072 → `128K`、1048576 → `1M`）
export function contextLabel(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !(tokens > 0)) return null;
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  const unit = tokens % 1000 !== 0 && tokens % 1024 === 0 ? 1024 : 1000;
  const kilo = tokens / unit;
  if (kilo < 1) return String(tokens);
  // 四舍五入到了 1000K 就写成 M（999999 → `1M`）
  if (Math.round(kilo * 10) / 10 >= 1000) return `${trim(kilo / unit)}M`;
  return `${trim(kilo)}K`;
}

/// 一个第三方模型都没选时开关按下即出的那一句：选模型就在这一行上（`已选 N 个模型 ▾`）
export const enableNeedsModels = () => t("models.pick.needsModels");

/**
 * 「第三方模型」开关不可用时的原因；可用则返回 null。优先级：待接管 > 冲突 > 一个第三方模型都没选。
 * 选了的那几家缺密钥不在这里预判（名单在提供商页）：打开时后端点名是哪一家，原话出在这一行下。
 * 菜单栏面板（`trayView.ts`）也用这个函数，两边说同一句话
 */
export function enableDisabledReason(state: GatewayState): string | null {
  const codex = codexGateway(state);
  if (codex.codex.takeover !== null)
    return t("models.enable.takeover", { manager: "agents-manager" });
  if (codex.conflict) return codex.conflict;
  if (thirdPartyCount(codex.models) === 0) return enableNeedsModels();
  return null;
}

/// 「重启 Codex」不设禁用态：结束进程不依赖我们的路由装没装上，
/// 一个进程都没找到也不算失败（R6 修订 v2、AC7′），所以这里没有对应的 reason 函数。

// ===== 重启生效（DESIGN「改动待生效：重启生效与启动 Codex」：按钮即状态） =====

/// 「重启生效」「启动」真正退出 / 打开的那个桌面应用叫什么：2026-09-30 起 Codex 桌面应用改名 ChatGPT
/// （包 id 仍是 `com.openai.codex`），重启会连 ChatGPT 窗口一起关，所以这几处写实际的名字（⑭）；读不到写 Codex。
/// 页面标题、能力行仍写 Codex——那是 agent 的名字，不是这个应用的
export function codexAppName(state: GatewayState | null): string {
  if (state === null) return "Codex";
  return codexGateway(state).codex.app.appName?.trim() || "Codex";
}

/// 「重启生效」键的提示框：只写点击的后果与代价。
/// 检测只认 `codex app-server` 后台进程（桌面应用、编辑器插件拉起的，以及命令行 0.156 起的常驻后台服务）；
/// 不经常驻服务的终端 `codex` 不认也不重启，所以写明「桌面应用」——否则用户会以为终端里那个也跟着换了配置（⑫）
export function restartTip(app: string): string {
  return t("models.tip.restart", { app });
}

/// 确认框正文：不重复提示框原话。进行中的对话数查不到（Codex 没有对外暴露），写通用的后果。
/// 2026-09-30 起重启＝整个桌面应用退出再打开（只重启后台进程时，ChatGPT 窗口里的模型列表不刷新）。
/// Codex 命令行 0.156 起终端里的会话跑在常驻后台服务里，重启时一起结束，所以也写上终端（2026-10-06）
export function restartConsequence(app: string): string {
  return t("models.restart.consequence", { app });
}

/// 重启完重读状态，键还在：Codex 还在用旧配置。原样说出来，不假装成功（⑫）
export function restartStillStale(app: string): string {
  return t("models.restart.stillStale", { app });
}
/// 发出结束信号后等旧进程退出、Codex 换上新配置的上限（DESIGN「点了重启生效之后」）。
/// 信号是异步的：发完立刻读，旧进程多半还在，会把「正在退出」误判成「重启失败」
export const RESTART_SETTLE_TIMEOUT_MS = 15000;
/// 等的时候多久读一次（本机读一次约 0.1 秒）
export const RESTART_SETTLE_POLL_MS = 300;

/// 等待用的时钟：默认是真实时间；测试注入假时钟，等多久、读几次与机器快慢无关
export interface SettleClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const REAL_CLOCK: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SettleTiming {
  timeoutMs: number;
  pollMs: number;
  /// 不给就用真实时间
  clock?: SettleClock;
}

/// 发完结束信号之后等 Codex 换上新配置：每读到一份状态交给 `onState`；不再用旧配置就返回 null，
/// 等满还在用旧的返回 `restartStillStale`；`alive()` 为假（页面没了）时返回 undefined，调用方什么都别做。
/// Codex 页节头与菜单栏面板的「重启生效」共用这一段
export async function settleAfterRestart(
  read: () => Promise<GatewayState>,
  onState: (state: GatewayState) => void,
  alive: () => boolean,
  timing: SettleTiming = {
    timeoutMs: RESTART_SETTLE_TIMEOUT_MS,
    pollMs: RESTART_SETTLE_POLL_MS,
  },
): Promise<string | null | undefined> {
  const clock = timing.clock ?? REAL_CLOCK;
  const deadline = clock.now() + timing.timeoutMs;
  for (;;) {
    const fresh = await read();
    if (!alive()) return undefined;
    onState(fresh);
    if (!codexGateway(fresh).codex.needsRestart) return null;
    if (clock.now() >= deadline) return restartStillStale(codexAppName(fresh));
    await clock.sleep(timing.pollMs);
    if (!alive()) return undefined;
  }
}

// ===== 开关＝配置里开没开（DESIGN「第三方模型（一节）」） =====

/// 没成之后撤回刚写的配置也没成：接在原因后面
export const switchRollbackFailed = () => t("models.switch.rollbackFailed");

/// 开关那一格的两句话：忙碌（写配置超过 0.3 秒时原位转圈旁那一句）、没成（节头下灰面板的主句）。
/// 成了不说话：滑块与橙就是结果，要重启才生效时旁边出 `重启生效`（与改选模型同一个模式）
export function gatewaySwitchText(
  next: boolean,
  tool: ModelsTool = CODEX,
): { busy: string; failed: string } {
  return next
    ? {
        busy: t("models.switch.busyAdd"),
        failed: t("models.switch.failedAdd", { tool: tool.name }),
      }
    : {
        busy: t("models.switch.busyRemove"),
        failed: t("models.switch.failedRemove", { tool: tool.name }),
      };
}

/// 开关的提示框：先说拨下去的结果；`withFile` 时再说改的是哪个文件（Codex 页；托盘面板窄，只说结果）。
/// 新手提示只说结果，机制留给悬停（DESIGN 2026-09-25 评审第二轮）
export function gatewaySwitchTip(on: boolean, tool: ModelsTool = CODEX, withFile = true): string {
  const result = on
    ? withFile
      ? t("models.switch.onTipFile", { tool: tool.name, path: tool.configPath })
      : t("models.switch.onTip", { tool: tool.name })
    : withFile
      ? t("models.switch.offTipFile", { tool: tool.name, path: tool.configPath })
      : t("models.switch.offTip", { tool: tool.name });
  // 末尾再说一句「要开着」（spec 2026-10-05-keep-running R3）：网关跟着 Sophia，Sophia 退出就没了
  return `${result}${t("models.switch.keepRunning")}`;
}

export interface GatewaySwitchIo {
  /// 写配置：true → `gatewayEnable`，false → `gatewayRestore`。打开没成时的撤回也走它（恢复）
  write: (enabled: boolean) => Promise<GatewayState>;
  read: () => Promise<GatewayState>;
  /// 每拿到一份后端状态都交给它（页面据此画开关）
  onState: (state: GatewayState) => void;
  alive: () => boolean;
  describe: (error: unknown) => string;
}

/**
 * 拨开关（DESIGN「第三方模型（一节）」：开关＝配置里开没开，拨了就写）：只写配置，不重启 Codex、不确认——
 * 打断对话的是重启，那一道确认在 `重启生效` 上。成了返回 null。
 *
 * 没写成：打开没成时**撤回刚写的**（恢复；写可能做了一半），尽力而为，撤回也没成就在原因后面说一声。
 * 关掉没成时**不反向再启用**——恢复先改设置、改成了才拆路由，停在半路也是一致的；反向启用会重启路由、
 * 重写设置，用户看到的是「关不掉」（2026-09-30 真机）。最后重读一次，开关画成真实状态。返回原因。
 *
 * 页面没了（`alive()` 为假）返回 undefined，调用方什么都别做
 */
export async function switchGateway(
  next: boolean,
  io: GatewaySwitchIo,
): Promise<string | null | undefined> {
  let reason: string;
  try {
    const written = await io.write(next);
    if (!io.alive()) return undefined;
    io.onState(written);
    return null;
  } catch (error) {
    reason = io.describe(error);
  }
  if (next) {
    try {
      const back = await io.write(false);
      if (io.alive()) io.onState(back);
    } catch {
      reason += switchRollbackFailed();
    }
  }
  try {
    const actual = await io.read();
    if (io.alive()) io.onState(actual);
  } catch {
    // 读不到就停在上次拿到的状态；下一次焦点或操作还会再读
  }
  return io.alive() ? reason : undefined;
}

/**
 * 「重启生效」那一格（DESIGN「点了重启生效之后」）：
 * - idle：Codex 的 `needsRestart` 为真时显示键，否则什么都没有
 * - restarting：键位原地换成 14px 忙碌指示（Spinner）+ 「正在重启 Codex」——用户正在等，就地带文字
 * - done：一行例行成功 `✓ 已生效`，约 4 秒后淡出
 *
 * - launching：`启动 Codex` 点下去之后，键位换成忙碌指示 + 「正在启动 Codex」，等到检测到它在跑
 * - launched：一行例行成功 `✓ 已启动`，约 4 秒后淡出
 *
 * - switching：拨了开关、正在写配置（`switchGateway`）。滑块已经过去（乐观翻转），写超过 0.3 秒开关原位转圈；
 *   这一格空着——写完了才知道要不要重启，键等写完再出来
 *
 * 失败不是这一格的状态：灰面板「Codex 重启失败」/「Codex 启动失败」+ 原因 + `再试一次` 挂在「第三方模型」节头下，
 * 格子回到 idle（键还在就还能点）
 */
export type RestartPhase =
  | { kind: "idle" }
  | { kind: "restarting" }
  | { kind: "done" }
  | { kind: "launching" }
  | { kind: "launched" }
  | { kind: "switching"; next: boolean };

/// 已生效那行停多久（含末尾 120ms 淡出）
export const RESTART_DONE_MS = 4000;
/// 键显示着时轻查一次状态的间隔：外部重启了 Codex，键要自己消失
export const RESTART_POLL_MS = 5000;

/// 键要不要显示：状态说要重启、且此刻没在重启 / 刚报完结果
export function showRestartKey(state: GatewayState, phase: RestartPhase): boolean {
  return codexGateway(state).codex.needsRestart && phase.kind === "idle";
}

/// Codex 没在跑时那一格的键（DESIGN「Codex 没在跑：同一格换成 启动 Codex」）：网关开着、Codex 桌面应用
/// 没在跑、且此刻空闲。网关关着时不出现——那时 Codex 用自己的模型，启动它与这一页无关
export function showLaunchKey(state: GatewayState, phase: RestartPhase): boolean {
  const codex = codexGateway(state);
  return (
    codex.enabled && !codex.codex.app.running && !codex.codex.needsRestart && phase.kind === "idle"
  );
}

/// 开关旁那一位此刻放哪颗键（DESIGN「第三方模型（一节）」「托盘面板」：`重启生效` / `启动 Codex`
/// 同一位，不会同时出现）。Codex 页节头与托盘能力行同一个判断：
/// 等重启 > Codex 没在跑（开着）；拨开关写配置、重启、启动期间都不出键
export type CodexKeyKind = "restart" | "launch";

export function codexKeyKind(state: GatewayState, phase: RestartPhase): CodexKeyKind | null {
  if (showRestartKey(state, phase)) return "restart";
  if (showLaunchKey(state, phase)) return "launch";
  return null;
}

/// 开关按不动的原因（能按为 null）：开着时永远能关——停用不依赖密钥和模型还在不在。Codex 页与托盘同一句
export function switchDisabledReason(state: GatewayState): string | null {
  return codexGateway(state).enabled ? null : enableDisabledReason(state);
}

/// `启动 Codex` 的提示框：点击的结果，不打断任何东西，所以不确认。名字同 `codexAppName`
export function launchTip(app: string): string {
  return t("models.tip.launch", { app });
}
/// 点了之后最多等多久看它跑起来
export const LAUNCH_TIMEOUT_MS = 15000;
/// 等它跑起来时多久查一次
export const LAUNCH_POLL_MS = 1000;
/// 等满了还没检测到：如实说
export function launchTimeout(app: string): string {
  return t("models.launch.timeout", { app });
}

/// 只在键（重启生效 / 启动 Codex）显示着时轮询；键消失即停，不做常驻进程监控。
/// 用户自己重启或打开了 Codex，键要自己消失（按钮即状态）
export function shouldPollRestart(state: GatewayState | null, phase: RestartPhase): boolean {
  return state !== null && (showRestartKey(state, phase) || showLaunchKey(state, phase));
}

// ===== 在用的模型与勾选 =====

/// 关掉之后先画的「做成之后」的样子（删掉最后一个生效模型那一支用它，见 selectModel）：只翻 enabled 会让依赖它的提示在等结果的那一下闪出来——开时「路由没在跑」
/// 待办条（启用成功时后端已起好路由）。做不成时整份回滚到后端给的状态，所以这里只预测成功
export function predictEnabled(state: GatewayState, enabled: boolean): GatewayState {
  const codex = codexGateway(state);
  const next = withAgentGateway(state, {
    ...codex,
    enabled,
    codex: { ...codex.codex, wanted: enabled },
  });
  // 关掉时：另一家还开着，路由留着（spec 2026-09-29 R8 R46：两家都关才停）
  const router = enabled
    ? { ...state.router, running: true }
    : anyGatewayOn(next)
      ? state.router
      : { ...state.router, running: false };
  return { ...next, router };
}

/// 模型页里 Codex 那一行的第二行（画板第 1 屏）：被 agents-manager 管着时 `由 agents-manager 管理`；
/// 关着 `没接第三方模型`；开着按提供商计数 `官方 2 · Kimi 2 · DeepSeek 1`，一个第三方模型都没选时
/// `还没选第三方模型`。注册表 `listRow.status` 读它；状态还没读回来是空串
export function codexListStatus(s: AgentState): string {
  if (s.gateway === null) return "";
  const codex = codexGateway(s.gateway);
  if (codex.codex.takeover !== null) return t("models.listRow.managed");
  if (thirdPartyCount(codex.models) === 0) return t("models.row.noThirdParty");
  if (!codex.enabled) return t("models.row.off");
  return pickCounts(codex.models.picked) ?? t("models.row.none");
}

/// 行上 Codex 开关按不动的原因（选模型、接管都在这一行上，说法同托盘）。开着永远能关
export function codexListSwitchReason(state: GatewayState): string | null {
  return switchDisabledReason(state);
}

/// 路由没在跑、且启动时自愈过一次仍没起来，才在「第三方模型」节里出待办条（DESIGN「路由没在跑」）；
/// 打开 Sophia 时没接上（另一个 Sophia 占着端口、端口都被占）也出，原因换成那一种（`routerTodo`）
export function showRouterTodo(state: GatewayState, healAttempted: boolean): boolean {
  return routerTodo(state, healAttempted, null) !== null;
}

/// 路由自动换端口的范围（core `PORT_RANGE`，spec 2026-10-03-gateway-in-app R4）：只用来写进那一句原因
export const PORT_FIRST = 47328;
export const PORT_LAST = 47339;

/// 路由那一条待办的文案（列表页头下、各家页里同一条）：主句、原因（跟在主句后同一行）、键与它的忙碌句
export interface RouterTodo {
  message: string;
  reason: string | null;
  label: string;
  busy: string;
}

/// 路由那一条待办（DESIGN「路由没在跑」）：打开 Sophia 时没接上（`portNotice`）先说那一种——另一个 Sophia 在运行、
/// 端口都被别的程序占了（这时 Codex 设置已改回原样，开关显示关，所以不看「有没有一家开着」）；
/// 否则有一家开着而路由没在跑、自愈过一次仍没起来，说「路由没在跑」+ 自愈失败的原因。键都是重新接上（`gatewayRestart`）
export function routerTodo(
  state: GatewayState,
  healAttempted: boolean,
  failure: string | null,
): RouterTodo | null {
  const busy = t("models.todo.routerRestarting");
  switch (state.portNotice?.code) {
    case "another_sophia":
      return {
        message: t("models.todo.anotherSophia"),
        reason: t("models.todo.anotherSophiaReason"),
        label: t("models.todo.retry"),
        busy,
      };
    case "ports_busy":
      return {
        message: t("models.todo.portsBusy"),
        reason: t("models.todo.portsBusyReason", { from: PORT_FIRST, to: PORT_LAST }),
        label: t("models.todo.retry"),
        busy,
      };
  }
  if (!healAttempted || !routerUnavailable(state)) return null;
  return {
    message: t("models.todo.routerDown"),
    reason: failure,
    label: t("models.todo.routerRestart"),
    busy,
  };
}

/// 换了端口（原来的被别的程序占了）、这一家正等着重启生效：行上一行灰字说为什么要重启。
/// 跟着 `重启生效` 走——重启过了就不再说
export function portMovedNote(state: GatewayState, agent: "codex" | "claude"): string | null {
  if (state.portNotice?.code !== "port_moved") return null;
  if (agent === "codex") {
    return codexGateway(state).codex.needsRestart
      ? t("models.note.portMoved", { app: codexAppName(state) })
      : null;
  }
  const claude = agentGateway(state, "claude")?.claude;
  return claude?.desktop.needsRestart ? t("models.note.portMovedClaude") : null;
}

/// 改用独立服务商（没登录 OpenAI）时：行上一行灰字说接法与后果（spec 2026-10-03-codex-hookup-auto R10）。
/// 借用内置、开关关着时不说
export function modeNote(state: GatewayState): string | null {
  if (!state.supported) return null;
  const view = codexGateway(state);
  if (!view.enabled || view.codex.mode !== "provider") return null;
  return t("models.note.modeSignedOut");
}

/// ChatGPT 额度用完时：行上一行灰字说「第三方模型也可能用不了」和出路（spec 2026-10-06-prelaunch-five R13）。
/// 只在第三方模型开着、借用内置接法、菜单栏用量读到 Codex 有一个在用（`active`）的窗口已用满时说；
/// 读不到用量、没开菜单栏用量、读取失败、免登录接法时都不说；窗口已过了重置时刻（读数是旧的）也不算用满。
/// `now` 是 Unix 秒，同 `resetsAt`
export function quotaNote(
  state: GatewayState,
  usage: UsageView | null,
  now: number = Date.now() / 1000,
): string | null {
  if (!state.supported || usage === null || !usage.settings.menuBarEnabled) return null;
  const view = codexGateway(state);
  if (!view.enabled || view.codex.mode === "provider") return null;
  const codex = usage.state.agents.find((a) => a.agent === "codex");
  if (!codex || codex.status.kind !== "ok" || codex.reading === null) return null;
  const spent = codex.reading.windows.some(
    (w) => w.active && w.usedPercent >= 100 && (w.resetsAt === null || w.resetsAt > now),
  );
  return spent ? t("models.note.quotaUsedUp") : null;
}

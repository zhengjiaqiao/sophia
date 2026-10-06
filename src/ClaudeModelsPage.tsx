import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import {
  CLAUDE_MODELS_NAME,
  claudeLaunchTip,
  claudeRestartTip,
  CLAUDE_TOOL,
  claudeTradeoff,
  claudeHeadIssue,
  claudeKeyKind,
  claudeOf,
  claudePicked,
  claudeRestartConsequence,
  claudeSelectModel,
  claudeShouldPoll,
  claudeSwitchReason,
  claudeSwitchText,
  claudeSwitchTip,
  claudeTodos,
  claudeViaRestart,
} from "./claudeView.ts";
import type { ClaudeSwitchPlace } from "./claudeView.ts";
import {
  modelsCapability,
  RESTART_POLL_MS,
  modelLabel,
  parseBackendError,
  portMovedNote,
  routerUnavailable,
} from "./modelsView.ts";
import type { RestartPhase } from "./modelsView.ts";
import type { AgentListRowProps, AgentSectionProps } from "./shell/agentRegistry.ts";
import { claudeGateway } from "./types.ts";
import type {
  ClaudeGatewayView,
  GatewayProvider,
  GatewayProviderModel,
  GatewayState,
} from "./types.ts";
import {
  BusySlot,
  Button,
  ChipRow,
  Confirm,
  FloatingToast,
  ModelChip,
  Note,
  NoticePanel,
  Spinner,
  Switch,
  Toast,
  Tooltip,
} from "./ui/index.ts";
import { GatewayBlock, bodyLayer } from "./ModelsGateways.tsx";
import type { GatewaySaveInput, RowNotice } from "./ModelsGateways.tsx";
import { AgentPage, useAgentName } from "./shell/ModelsPage.tsx";
import { createSelectionWriter } from "./selectionWrites.ts";
import type { SectionNoticeState } from "./ModelsTab.tsx";
// 网关区块、已选行、灰面板的外距与 Codex 的页同一套（ModelsTab.css），这一页自己的在 ClaudeModelsPage.css
import "./ModelsTab.css";
import "./ClaudeModelsPage.css";

/// Claude 的页：桌面应用的第三方模型（注册表 Claude 那一项 `第三方模型` 节的 `Component`；spec 2026-09-29 R42 Claude 部分，
/// DESIGN「Claude 的页：桌面应用」「每家的页（推入页，共同骨架）」）。模型列表页点 Claude 那一行推入这一页。
///
/// 打开＝把 Claude 桌面应用切到官方的「第三方推理」模式、指向 Sophia 的路由；切过去不登录 Claude 账号——代价写在明处。
/// 推入页外框（`←`、挂到机面、返回）归 shell/ModelsPage 的 `AgentPage`；这一页画：
/// - **页面头**：`←` + `Claude`，不放控件
/// - **能力行**：`modelsCapability()`（modelsView，两家共用）+ 紧跟的开关（＝配置里开没开：拨了就写、不确认、乐观翻转；
///   桌面应用在运行时后端只记为待生效）+ 12 + 那一位的键：`重启生效`（在运行且待生效，先确认 `重启 Claude？`）/
///   `打开 Claude`（开着、没在运行，不确认）。撤回由后端在同一动作里做（spec R32），这里不反向再写；没成就重读真实状态，
///   能力行下灰面板 + `再试一次`
/// - **已选**：这一家的模型片，片上 × 与网关行里的勾选是同一件事；开着时去掉最后一个＝关掉。选了哪些，Claude 菜单里就有哪些；
///   Sophia 不设默认模型（2026-09-30），`已选` 下不另加说明
/// - **代价句**（开着才出）：`已选` 下一句灰字
/// - **行内待办条**：路由没在跑 / 别家配置在生效 + `接管` / 被改掉了 + `重新写入`；切回没做完出在能力行下
/// - **网关**：`GatewayBlock`，只列 Claude 自己的；加 / 改时可以顺手同步到 Codex、Codex 有而这里没有时 `带过来`
///
/// 重开后直接进入第三方模式，不出「还要再点一下」那类提示（spec R42 已定事项 3）。页面上没有解释段落

/// 页面名：只写是哪一家（DESIGN「每家的页」），模型页里叫 `Claude Desktop`
const TITLE = CLAUDE_MODELS_NAME;
/// 开关的读屏名（`启用 …`）：说清切的是桌面应用
const switchLabel = () => t("models.claudePage.switchLabel");

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

const selectedPayload = (models: GatewayProviderModel[]) =>
  models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName }));

// ===== 开关与开关旁那一位（能力行与模型列表页那一行共用） =====

export interface ClaudeSwitchProps {
  view: ClaudeGatewayView;
  /// 拨下去、正在写：拨向哪一侧（乐观翻转：滑块已经在那一侧）；没在写为 null
  switching: boolean | null;
  /// 别的写 Claude 设置的事在做：先不接新的一拨，按下说「正在处理上一步」
  busy: boolean;
  /// 按不动时说哪一处的下一步（页里 / 列表行）
  place: ClaudeSwitchPlace;
  onToggle: (next: boolean) => void;
}

/// 开关（标准 34 × 20，开着由刻线说）。按不动（没装、受管、太旧、别家配置在生效、没选模型……）：禁用开关自带原因提示框，
/// 悬停出、按下当即出；拨下去写配置：乐观翻转，写超过 0.3 秒原位刻度 +「正在切换 / 正在切回」；平时提示框说拨下去会怎样
export function ClaudeSwitch({ view, switching, busy, place, onToggle }: ClaudeSwitchProps) {
  const blocked = claudeSwitchReason(view, place);
  const on = switching ?? view.enabled;
  return (
    <span className="claude-switch">
      {blocked !== null && switching === null ? (
        <Switch
          checked={false}
          onChange={() => undefined}
          label={switchLabel()}
          disabledReason={blocked}
          tipPlacement="bottom"
        />
      ) : (
        <BusySlot busy={switching !== null} label={claudeSwitchText(switching ?? true).busy}>
          <Tooltip content={claudeSwitchTip(on)} placement="bottom">
            <Switch
              checked={on}
              onChange={onToggle}
              label={switchLabel()}
              disabledReason={busy && switching === null ? t("models.control.busyPrev") : undefined}
            />
          </Tooltip>
        </BusySlot>
      )}
    </span>
  );
}

export interface ClaudeKeySlotProps {
  view: ClaudeGatewayView;
  phase: RestartPhase;
  busy: boolean;
  /// 点 `重启生效`：调用方先确认（窗口正中）
  onRestart: () => void;
  onLaunch: () => void;
  /// `✓ 已重启 / 已打开` 那一窗到点
  onDoneDismiss: () => void;
  /// section：能力行与列表行（提示框、✓ 左对齐键）
  place: "section";
}

/// 开关旁那一位（DESIGN「开关＝配置里开没开」）：`重启生效` / `打开 Claude` 同一位、不同时出现（claudeKeyKind），默认键紧凑 24。
/// 重启、打开期间原位忙碌（过了 0.3 秒门槛换成刻度 + `正在重启 Claude` / `正在打开 Claude`）；成了键消失，
/// 原位下方浮起 `✓ 已重启 / 已打开`（约 4 秒淡出）。拨开关写配置期间这一位空着（写完才知道要不要重启）
export function ClaudeKeySlot({
  view,
  phase,
  busy,
  onRestart,
  onLaunch,
  onDoneDismiss,
}: ClaudeKeySlotProps) {
  if (phase.kind === "restarting" || phase.kind === "launching") {
    const restarting = phase.kind === "restarting";
    return (
      <BusySlot
        busy
        label={
          restarting
            ? t("models.control.restartingLabel", { app: "Claude" })
            : t("models.control.openingLabel", { app: "Claude" })
        }
      >
        <Button size="compact">
          {restarting
            ? t("models.control.restartKey")
            : t("models.control.openKey", { app: "Claude" })}
        </Button>
      </BusySlot>
    );
  }
  if (phase.kind === "done" || phase.kind === "launched") {
    // 键已消失：原位留一个不占宽、与键同高的锚，结果浮在它正下方 4、左沿对齐
    return (
      <span className="claude-key__spot">
        <FloatingToast align="start">
          <Toast
            kind="success"
            sentence={phase.kind === "done" ? "models.control.restarted" : "models.control.opened"}
            onDismiss={onDoneDismiss}
          />
        </FloatingToast>
      </span>
    );
  }
  if (phase.kind !== "idle") return null;
  const kind = claudeKeyKind(view);
  if (kind === null) return null;
  const restart = kind === "restart";
  const label = restart
    ? t("models.control.restartKey")
    : t("models.control.openKey", { app: "Claude" });
  return (
    <Tooltip
      content={restart ? claudeRestartTip() : claudeLaunchTip()}
      placement="bottom"
      align="start"
      nowrap
    >
      {busy ? (
        <Button size="compact" disabled disabledReason={t("models.control.busyPrev")}>
          {label}
        </Button>
      ) : (
        <Button size="compact" onClick={restart ? onRestart : onLaunch}>
          {label}
        </Button>
      )}
    </Tooltip>
  );
}

// ===== 已选、代价句 =====

/// `已选` 一行（能力行下 12）：这一家的模型片，只属于这一家；一个没选时整行不出
export function ClaudePicked({
  view,
  onRemove,
}: {
  view: ClaudeGatewayView;
  onRemove: (provider: GatewayProvider, model: GatewayProviderModel) => void;
}) {
  const rows = claudePicked(view);
  if (rows.length === 0) return null;
  return (
    <div className="models-inuse">
      <ChipRow
        label={t("models.inUse.picked")}
        listLabel={t("models.inUse.listLabel", { label: t("models.inUse.picked") })}
      >
        {rows.map(({ provider, model, name, suffix }) => (
          <ModelChip
            key={`${provider.id}|${model.id}`}
            name={name}
            suffix={suffix}
            id={model.slug || model.id}
            onRemove={() => onRemove(provider, model)}
          />
        ))}
      </ChipRow>
    </div>
  );
}

/// 代价句（DESIGN「开着时 `已选` 下一句灰字」：`Note` 13 `ink-mute`，上距 10）。`on`＝开关此刻画成开着（含乐观翻转）；
/// 关着时不出（①）。`已选` 下只有这一句，不说菜单里有什么、不说对应关系
export function ClaudeCostNote({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <div className="claude-cost">
      <Note>{claudeTradeoff()}</Note>
    </div>
  );
}

// ===== 行内待办条 =====

export type ClaudeResolving = "router" | "takeover" | "rewrite" | null;

/// 行内待办条（灰面板满宽 776、键在右端控件列）：路由没在跑（原因跟在主句后）/ 别家配置在生效 + `接管` /
/// 被改掉了 + `重新写入`。都不给「稍后」，问题解决自动收起；执行时键换成忙碌指示
export function ClaudeTodos({
  state,
  healed,
  routerFailure,
  resolving,
  busy,
  onResolve,
}: {
  state: GatewayState;
  healed: boolean;
  routerFailure: string | null;
  resolving: ClaudeResolving;
  busy: boolean;
  onResolve: (kind: "router" | "takeover" | "rewrite") => void;
}) {
  const todos = claudeTodos(state, healed);
  if (todos.length === 0) return null;
  return (
    <div className="models-todos">
      {todos.map((todo) => (
        <NoticePanel
          key={todo.kind}
          scope="section"
          message={todo.message}
          // 路由那一条：没接上时原因是那一种（端口），路由没在跑时是自愈失败的原话
          reason={
            (todo.kind === "router" ? (todo.reason ?? routerFailure) : todo.reason) ?? undefined
          }
          busy={resolving === todo.kind ? todo.busy : undefined}
          action={{
            label: todo.label,
            onClick: () => onResolve(todo.kind),
            disabledReason: busy ? t("models.control.busyPrev") : undefined,
          }}
        />
      ))}
    </div>
  );
}

// ===== 这一页 =====

export default function ClaudeModelsPage({ onError, onGatewayState }: AgentSectionProps) {
  const [state, setState] = useState<GatewayState | null>(null);
  /// 正在做一件写 Claude 设置的事（拨开关、重启、打开、接管、存网关……）：同一对象的下一次操作先不接
  const [busy, onBusy] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [notice, setNotice] = useState<SectionNoticeState | null>(null);
  const [resolving, setResolving] = useState<ClaudeResolving>(null);
  /// 启动时的自愈试过了没有：试过仍没起来才出「路由没在跑」
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  /// 网关块里开着删网关的确认框：这一页此刻不接 Esc（Esc 只取消确认）
  const [gatewayConfirming, setGatewayConfirming] = useState(false);
  /// 另一家（注册表给的名字）：网关区块的同步勾选与 `带过来`
  const otherName = useAgentName("codex");
  const mounted = useRef(true);
  const reportState = useRef(onGatewayState);
  reportState.current = onGatewayState;
  /// 最近一次勾选是在哪一家网关的列表里点的（null＝点的是已选片上的 ×）：写失败的灰面板出在那里
  const toggledIn = useRef<string | null>(null);
  /// 此刻画在页面上的状态（含还没写完的勾选）
  const shown = useRef<GatewayState | null>(null);
  /// 勾选的写盘队列（同 Codex 的页）：先画、后台排队写、失败才回滚并说话
  const [writer] = useState(() =>
    createSelectionWriter<GatewayState>({
      paint: (next) => {
        shown.current = next;
        setState(next);
      },
      report: (next) => reportState.current?.(next),
      reread: () => api.gatewayState(),
      onDone: () => setNotice(null),
      onFail: (message, error) =>
        setNotice({
          message,
          reason: describeError(error),
          providerId: toggledIn.current ?? undefined,
        }),
      alive: () => mounted.current,
    }),
  );
  const applyState = writer.accept;

  /// 轻查：后台例行读取，不显示忙碌（焦点重读、键显示时的轮询）
  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch {
      // 轻查失败不打扰：下一次焦点或操作还会再读
    }
  }, [applyState]);

  // 挂载：读一次；路由没在跑就先自愈一次（重启路由），还不行才让待办条出来（同 Codex 的页）
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        let next = await api.gatewayState();
        if (routerUnavailable(next)) {
          try {
            next = await api.gatewayRestart();
          } catch (error) {
            if (mounted.current) setRouterFailure(describeError(error));
          }
        }
        if (mounted.current) {
          applyState(next);
          setHealed(true);
        }
      } catch (error) {
        onError(describeError(error));
      }
    })();
    return () => {
      mounted.current = false;
    };
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 托盘也能开关、重启：它改完广播一声，这一页跟着重读；窗口获得焦点时也重读——
  // 用户自己开了 / 重开了 Claude，`打开 Claude` / `重启生效` 要自己消失
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const collect = (pending: Promise<() => void>) => {
      void pending.then((un) => (disposed ? un() : unlistens.push(un)));
    };
    collect(listen("gateway-changed", () => void quietRefresh()));
    collect(
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) void quietRefresh();
      }),
    );
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
  }, [quietRefresh]);

  const view = state === null ? null : claudeGateway(state);

  // 键显示着时每 5 秒轻查一次，键消失即停
  const polling = claudeShouldPoll(view, phase.kind === "idle" && !busy);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void quietRefresh(), RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, quietRefresh]);

  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  /// 做不成之后重读一次，开关与键位画成真实状态（撤回由后端在同一动作里做过了）
  const reread = async () => {
    try {
      const actual = await api.gatewayState();
      if (mounted.current) applyState(actual);
    } catch {
      // 读不到就停在上次拿到的状态
    }
  };

  /// 跑一个用户在等的动作：排在还没写完的勾选后面；成了用返回的状态刷新，没成重读并返回原因。页面没了返回 undefined
  const attempt = async (
    action: () => Promise<GatewayState>,
  ): Promise<string | null | undefined> => {
    onBusy(true);
    let reason: string | null = null;
    try {
      await writer.idle();
      const next = await action();
      if (mounted.current) applyState(next);
    } catch (error) {
      reason = describeError(error);
      await reread();
    } finally {
      if (mounted.current) onBusy(false);
    }
    return mounted.current ? reason : undefined;
  };

  /// 没成：能力行下灰面板 + `再试一次`
  const failed = (message: string, reason: string, retry: () => void) =>
    setNotice({ message, reason, action: { label: t("models.notice.retry"), onClick: retry } });

  /// 网关行要自己就地说明失败，所以这一支把错误原样抛回去
  const runOrThrow = async (action: () => Promise<GatewayState>) => {
    onBusy(true);
    try {
      await writer.idle();
      const next = await action();
      if (mounted.current) applyState(next);
    } finally {
      onBusy(false);
    }
  };

  const saveProvider = async (input: GatewaySaveInput): Promise<string> => {
    onBusy(true);
    try {
      await writer.idle();
      // `sync`：表单里勾着「也加到 Codex」/「Codex 里的 X 一起改」
      const saved = await api.gatewayUpsertProvider({ ...input, agent: "claude" });
      if (mounted.current) applyState(saved.state);
      // 只改了地址、用已存的密钥：这一家由表单接着拉模型，同步过去的 Codex 那一份在后台一起拉（失败记在它的网关行上）
      if (input.id !== undefined && input.key === undefined && saved.otherProviderId !== null) {
        void api.gatewayRetryProvider("codex", saved.otherProviderId).then(
          (next) => mounted.current && applyState(next),
          () => undefined,
        );
      }
      return saved.providerId;
    } finally {
      onBusy(false);
    }
  };

  /// 拨开关：不确认，直接写（桌面应用在运行时后端只记为待生效，键位出 `重启生效`）；滑块当即过去
  const toggleSwitch = async (next: boolean) => {
    setNotice(null);
    setPhase({ kind: "switching", next });
    const reason = await attempt(() =>
      next ? api.gatewayEnable("claude") : api.gatewayRestore("claude"),
    );
    if (reason === undefined) return;
    setPhase({ kind: "idle" });
    if (reason !== null) {
      failed(claudeSwitchText(next).failed, reason, () => void toggleSwitch(next));
    }
  };

  /// 重启生效（确认之后）：退出 → 写 → 打开，后端等到它重新在跑才返回
  const restart = async () => {
    setConfirmRestart(false);
    setNotice(null);
    setPhase({ kind: "restarting" });
    const reason = await attempt(() => api.gatewayRestartClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
    if (reason !== null)
      failed(t("models.notice.notRestarted", { app: "Claude" }), reason, () => void restart());
  };

  /// 打开 Claude：有待生效的先写再打开，后端等到它在跑才返回；不打断什么，不确认
  const launch = async () => {
    setNotice(null);
    setPhase({ kind: "launching" });
    const reason = await attempt(() => api.gatewayLaunchClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
    if (reason !== null)
      failed(t("models.notice.notOpened", { app: "Claude" }), reason, () => void launch());
  };

  /// 勾上 / 取消一个模型。开着时去掉的是最后一个＝关掉（后端开着时不许已选变空）：先切回，再把这一网关的勾选清掉
  const setModel = (providerId: string, modelId: string, selected: boolean) => {
    const base = shown.current;
    const model = (base ? (claudeGateway(base)?.providers ?? []) : [])
      .find((p) => p.id === providerId)
      ?.models.find((m) => m.id === modelId);
    if (!base || !model || model.selected === selected) return;
    const { next, turnsOff } = claudeSelectModel(base, providerId, modelId, selected);
    const models = claudeGateway(next)?.providers.find((p) => p.id === providerId)?.models ?? [];
    const payload = selectedPayload(models);
    writer.write(
      selected
        ? t("models.notice.notAdded", { model: modelLabel(model) })
        : t("models.notice.notRemoved", { model: modelLabel(model) }),
      next,
      turnsOff
        ? async () => {
            await api.gatewayRestore("claude");
            return api.gatewaySelectModels("claude", providerId, payload);
          }
        : () => api.gatewaySelectModels("claude", providerId, payload),
    );
  };

  const toggleModel = (provider: GatewayProvider, id: string) => {
    const model = (shown.current ? (claudeGateway(shown.current)?.providers ?? []) : [])
      .find((p) => p.id === provider.id)
      ?.models.find((m) => m.id === id);
    if (!model) return;
    toggledIn.current = provider.id;
    setModel(provider.id, id, !model.selected);
  };

  const removeModel = (provider: GatewayProvider, model: GatewayProviderModel) => {
    toggledIn.current = null;
    setModel(provider.id, model.id, false);
  };

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const expand = (id: string) => setExpanded((prev) => new Set(prev).add(id));

  const restartRouter = async () => {
    onBusy(true);
    try {
      const next = await api.gatewayRestart();
      if (mounted.current) {
        applyState(next);
        setRouterFailure(null);
      }
    } catch (error) {
      if (mounted.current) setRouterFailure(describeError(error));
    } finally {
      onBusy(false);
    }
  };

  /// 行内待办条的动作。`重新写入`：桌面应用在运行时不能当场写，走 `重启生效`（先确认，spec R36）
  const resolveTodo = async (kind: "router" | "takeover" | "rewrite") => {
    if (kind === "rewrite" && view !== null && claudeViaRestart(view)) {
      setConfirmRestart(true);
      return;
    }
    setResolving(kind);
    setNotice(null);
    if (kind === "router") {
      await restartRouter();
    } else {
      const reason = await attempt(() =>
        kind === "takeover" ? api.gatewayTakeover("claude") : api.gatewayEnable("claude"),
      );
      if (reason) {
        failed(
          kind === "takeover"
            ? t("models.notice.takeoverFailed", { tool: "Claude" })
            : t("models.notice.rewriteFailed", { tool: "Claude" }),
          reason,
          () => void resolveTodo(kind),
        );
      }
    }
    if (mounted.current) setResolving(null);
  };

  /// 切回没做完的 `再试一次`：在运行时同样走 `重启生效`（先确认）
  const finishRestore = async () => {
    if (view !== null && claudeViaRestart(view)) {
      setConfirmRestart(true);
      return;
    }
    const reason = await attempt(() => api.gatewayRestore("claude"));
    if (reason) failed(claudeSwitchText(false).failed, reason, () => void finishRestore());
  };

  if (state === null || view === null) {
    return (
      <AgentPage title={TITLE}>
        <div className="models-loading" aria-busy="true">
          <Spinner size={14} label={t("models.page.loading")} />
          <span>{t("models.page.loading")}</span>
        </div>
      </AgentPage>
    );
  }

  /// 勾选在展开着的那一家列表里没写成的，出在那一行里；其余出在能力行下
  const rowNotice: RowNotice | null =
    notice?.providerId !== undefined && expanded.has(notice.providerId)
      ? { providerId: notice.providerId, message: notice.message, reason: notice.reason }
      : null;
  const issue = claudeHeadIssue(view);
  const headNotice: SectionNoticeState | null =
    notice !== null && rowNotice === null
      ? notice
      : notice === null && issue !== null
        ? {
            ...issue,
            action: { label: t("models.notice.retry"), onClick: () => void finishRestore() },
          }
        : null;
  const switching = phase.kind === "switching" ? phase.next : null;
  const on = switching ?? view.enabled;
  const portNote = portMovedNote(state, "claude");

  return (
    <AgentPage
      title={TITLE}
      capability={modelsCapability()}
      // 确认框开着时 Esc 只取消确认，不返回
      escape={!confirmRestart && !gatewayConfirming}
      control={
        <ClaudeSwitch
          view={view}
          switching={switching}
          busy={busy}
          place="page"
          onToggle={(next) => void toggleSwitch(next)}
        />
      }
      actions={
        <ClaudeKeySlot
          view={view}
          phase={phase}
          busy={busy}
          onRestart={() => setConfirmRestart(true)}
          onLaunch={() => void launch()}
          onDoneDismiss={dismissDone}
          place="section"
        />
      }
    >
      {headNotice ? (
        <div className="models-notice">
          <NoticePanel
            scope="section"
            message={headNotice.message}
            reason={headNotice.reason}
            action={headNotice.action}
            onClose={notice !== null ? () => setNotice(null) : undefined}
          />
        </div>
      ) : null}
      {/* 换了端口、Claude 等着重启：一行灰字说为什么（跟着 `重启生效` 走） */}
      {portNote !== null ? <p className="models-port-note">{portNote}</p> : null}
      <ClaudePicked view={view} onRemove={removeModel} />
      <ClaudeCostNote on={on} />
      <ClaudeTodos
        state={state}
        healed={healed}
        routerFailure={routerFailure}
        resolving={resolving}
        busy={busy}
        onResolve={(kind) => void resolveTodo(kind)}
      />
      <GatewayBlock
        tool={CLAUDE_TOOL}
        state={state}
        busy={busy}
        expanded={expanded}
        onToggleRow={toggleRow}
        onExpand={expand}
        onSave={saveProvider}
        onFetchModels={(id) => runOrThrow(() => api.gatewayFetchModels("claude", id))}
        onRetry={(id) => runOrThrow(() => api.gatewayRetryProvider("claude", id))}
        onRemove={(p, alsoOther) =>
          runOrThrow(() => api.gatewayRemoveProvider("claude", p.id, alsoOther))
        }
        agent="claude"
        otherName={otherName}
        onCopy={() => runOrThrow(() => api.gatewayCopyProviders("claude", "codex"))}
        onToggleModel={toggleModel}
        onProbeModel={(provider, modelId) => api.gatewayProbeModel("claude", provider.id, modelId)}
        onAddManualModel={(provider, modelId) =>
          api.gatewayAddManualModel("claude", provider.id, modelId).then(applyState)
        }
        notice={rowNotice}
        onCloseNotice={() => setNotice(null)}
        onConfirmChange={setGatewayConfirming}
      />

      {/* 推入页带着 transform：确认框挂到 body 上，遮罩才整面压暗；在窗口正中 */}
      {confirmRestart
        ? bodyLayer(
            <Confirm
              title={t("models.restart.confirmTitle", { app: "Claude" })}
              confirmLabel={t("models.restart.confirmLabel")}
              onConfirm={() => void restart()}
              onCancel={() => setConfirmRestart(false)}
            >
              {claudeRestartConsequence(view.enabled)}
            </Confirm>,
          )
        : null}
    </AgentPage>
  );
}

// ===== 模型列表页里 Claude 那一行 =====

/// 模型列表页里 Claude 那一行的右端控件列（注册表 `listRow.Controls`；DESIGN「列表页」）：条件键（`重启生效` / `打开 Claude`，
/// 同 Claude 的页那一位）+ 12 + 开关。规则同 Claude 的页：拨了就写、不确认、乐观翻转；`重启生效` 先确认（窗口正中）；
/// 禁用时按下即说原因——行上说「是什么」、提示框说「怎么办」（列表页上挑不了模型、也接管不了，所以说「进去…」）。
/// 没写成：重读真实状态，这一行下出行内灰面板 + `再试一次`（经 `onNotice` 交给列表页挂）。键显示着时每 5 秒轻查一次
export function ClaudeListControls({ state, onNotice, onGatewayState }: AgentListRowProps) {
  const view = claudeOf(state);
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const alive = () => mounted.current;

  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) onGatewayState(next);
    } catch {
      // 轻查失败不打扰
    }
  }, [onGatewayState]);
  const polling = claudeShouldPoll(view, phase.kind === "idle" && !busy);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void quietRefresh(), RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, quietRefresh]);
  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  if (view === null) return null;

  /// 行下灰面板：主句 + 原因 + `再试一次`
  const fail = (message: string, reason: string, retry: () => void) =>
    onNotice(
      <NoticePanel
        message={message}
        reason={reason}
        action={{ label: t("models.notice.retry"), onClick: retry }}
        onClose={() => onNotice(null)}
      />,
    );

  /// 跑一个动作：成了把后端给的状态报给壳；没成重读并返回原因。这一行没了返回 undefined
  const attempt = async (act: () => Promise<GatewayState>): Promise<string | null | undefined> => {
    onNotice(null);
    setBusy(true);
    let reason: string | null = null;
    try {
      const next = await act();
      if (alive()) onGatewayState(next);
    } catch (error) {
      reason = describeError(error);
      await quietRefresh();
    } finally {
      if (alive()) setBusy(false);
    }
    return alive() ? reason : undefined;
  };

  const toggle = async (next: boolean) => {
    setPhase({ kind: "switching", next });
    const reason = await attempt(() =>
      next ? api.gatewayEnable("claude") : api.gatewayRestore("claude"),
    );
    if (reason === undefined) return;
    setPhase({ kind: "idle" });
    if (reason !== null) fail(claudeSwitchText(next).failed, reason, () => void toggle(next));
  };

  const restart = async () => {
    setConfirmRestart(false);
    setPhase({ kind: "restarting" });
    const reason = await attempt(() => api.gatewayRestartClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
    if (reason !== null)
      fail(t("models.notice.notRestarted", { app: "Claude" }), reason, () => void restart());
  };

  const launch = async () => {
    setPhase({ kind: "launching" });
    const reason = await attempt(() => api.gatewayLaunchClaude());
    if (reason === undefined) return;
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
    if (reason !== null)
      fail(t("models.notice.notOpened", { app: "Claude" }), reason, () => void launch());
  };

  return (
    <>
      <ClaudeKeySlot
        view={view}
        phase={phase}
        busy={busy}
        onRestart={() => setConfirmRestart(true)}
        onLaunch={() => void launch()}
        onDoneDismiss={dismissDone}
        place="section"
      />
      <ClaudeSwitch
        view={view}
        switching={phase.kind === "switching" ? phase.next : null}
        busy={busy}
        place="list"
        onToggle={(next) => void toggle(next)}
      />
      {confirmRestart ? (
        <Confirm
          title={t("models.restart.confirmTitle", { app: "Claude" })}
          confirmLabel={t("models.restart.confirmLabel")}
          onConfirm={() => void restart()}
          onCancel={() => setConfirmRestart(false)}
        >
          {claudeRestartConsequence(view.enabled)}
        </Confirm>
      ) : null}
    </>
  );
}

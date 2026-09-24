import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import {
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT,
  LAUNCH_TIMEOUT_MS,
  LAUNCH_TIP,
  MODELS_TOOLS,
  RESTART_CONSEQUENCE,
  RESTART_POLL_MS,
  RESTART_TIP,
  UNINSTALL_TIP,
  effectiveModels,
  enableDisabledReason,
  gatewaySwitchText,
  inUseLabel,
  modelIssues,
  modelLabel,
  parseBackendError,
  routerUnavailable,
  selectModel,
  serviceLeftover,
  settleAfterRestart,
  shouldPollRestart,
  showLaunchKey,
  showRestartKey,
  showRouterTodo,
  switchGateway,
  totalSelected,
} from "./modelsView.ts";
import type { ModelsTool, RestartPhase } from "./modelsView.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "./types.ts";
import {
  BusySlot,
  Button,
  Confirm,
  FloatingToast,
  ModelChip,
  NoticePanel,
  Spinner,
  Toast,
  Tooltip,
  useBusyShown,
} from "./ui/index.ts";
import type { ConfirmAnchor } from "./ui/index.ts";
import { Switch } from "./ui/Switch.tsx";
import { Section } from "./ui/Section.tsx";
import { GatewayBlock } from "./ModelsGateways.tsx";
import type { RowNotice } from "./ModelsGateways.tsx";
import { createSelectionWriter } from "./selectionWrites.ts";
import "./ModelsTab.css";

/// Codex 页「第三方模型」一节（DESIGN「agent 页：Codex」，D5：原模型页与网关二级页合并成这一节）。
///
/// agent 页的外框（页面头的图标 + `Codex`、节与节之间的距离）由外壳按 agent 注册表画；这一节画：
/// - **节头**：`第三方模型` + 开关（＝配置里开没开：拨了就写、不确认，乐观翻转，没写成滑回）+ 16 +
///   `重启生效` / `启动 Codex`（紧跟开关：手刚拨完，下一步就在旁边）+ 右端 `卸下后台服务`（只在关着而服务还装着时）。
///   键即状态——`needsCodexRestart` 比的是 Codex 启动时加载的配置与现在，用户用任何方式重启 Codex 键都会自己消失；
///   所以窗口获得焦点时重读，键显示着时每 5 秒轻查一次，键消失即停。**从不自动重启**；重启要确认（打断对话）
/// - **在用**：模型片（关着时标签写 `已选`），片上 × 与网关行里的勾选实时联动
/// - **行内待办条**：路由没在跑 / 正由 agents-manager 管理 / 设置被改掉了，挂在这一节里，问题解决自动收起
/// - **网关**：一家一行、点整行展开挑模型，编辑与新增就地展开（ModelsGateways.tsx）
///
/// 页面上没有解释段落，没有版本、路由状态、网关几家这些内部事实

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

const selectedPayload = (models: GatewayProviderModel[]) =>
  models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName }));

/// 确认框锚点：元素此刻在视口里的矩形
const anchorOf = (el: Element | null | undefined): ConfirmAnchor | undefined => {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
};

/// 节头下那块灰面板：做不成的事就地说（开关、重启、启动、卸下、勾选没成）。
/// `message` 是整句（`没重启 Codex` `没移除 GPT 5`），原因写全、折行不截断
export interface SectionNoticeState {
  message: string;
  reason: string;
  action?: { label: string; onClick: () => void };
  /// 勾选列表里点的：那一家网关行展开着时，灰面板出在那一行里（就近）
  providerId?: string;
}

// ===== 节头里紧跟开关：重启生效 / 启动 Codex =====

/// 开关旁那一格（DESIGN「改动待生效：重启生效与启动 Codex」）：键（紧凑 24，与节头里的 `卸下后台服务` 同高）/
/// 忙碌指示 + 正在重启 / 键消失、原位下方浮起 `✓ 已生效`（约 4 秒淡出，左沿对齐原来的键）。Codex 没在跑时同一格换成 `启动 Codex`（同一套）。
/// 忙碌过了 0.3 秒门槛才出现，之前键照旧、点不动。失败的灰面板不在这里——挂在节头下，键照常留着可以再点
export function RestartSlot({
  tool,
  state,
  phase,
  busy,
  onRestart,
  onLaunch,
  onDoneDismiss,
  keyRef,
}: {
  tool: ModelsTool;
  state: GatewayState;
  phase: RestartPhase;
  busy: boolean;
  onRestart: () => void;
  onLaunch?: () => void;
  onDoneDismiss?: () => void;
  /// 键的包层：重启确认锚在它下面（左沿对齐）
  keyRef?: Ref<HTMLSpanElement>;
}) {
  const waiting = phase.kind === "restarting" || phase.kind === "launching";
  const shown = useBusyShown(waiting);
  if (waiting && shown) {
    const text = `${phase.kind === "restarting" ? "正在重启" : "正在启动"} ${tool.name}`;
    return (
      <span className="models-restart models-restart--busy" role="status">
        <Spinner size={14} label={text} />
        <span className="models-restart__text">{text}</span>
      </span>
    );
  }
  if (waiting) {
    // 还没过门槛：键照旧、点不动（不闪一下忙碌）
    const label = phase.kind === "restarting" ? "重启生效" : `启动 ${tool.name}`;
    return (
      <span className="models-restart-tip ss-locked" aria-busy="true">
        <Button size="compact">{label}</Button>
      </span>
    );
  }
  if (phase.kind === "done" || phase.kind === "launched") {
    // 键已消失：原来那颗键的位置留一个不占宽的锚，结果浮在它正下方 4、左沿对齐
    return (
      <span className="models-restart models-restart--done">
        <FloatingToast align="start">
          <Toast
            kind="success"
            verb={phase.kind === "done" ? "已生效" : "已启动"}
            onDismiss={onDoneDismiss}
          />
        </FloatingToast>
      </span>
    );
  }
  if (onLaunch && showLaunchKey(state, phase)) {
    return (
      <span className="models-restart-tip" ref={keyRef}>
        <Tooltip content={LAUNCH_TIP} placement="bottom" align="start" nowrap>
          {busy ? (
            <Button size="compact" disabled disabledReason="正在处理上一步">
              {`启动 ${tool.name}`}
            </Button>
          ) : (
            <Button size="compact" onClick={onLaunch}>
              {`启动 ${tool.name}`}
            </Button>
          )}
        </Tooltip>
      </span>
    );
  }
  if (!showRestartKey(state, phase)) return null;
  return (
    <span className="models-restart-tip" ref={keyRef}>
      <Tooltip content={RESTART_TIP} placement="bottom" align="start" nowrap>
        {busy ? (
          <Button size="compact" disabled disabledReason="正在处理上一步">
            重启生效
          </Button>
        ) : (
          <Button size="compact" onClick={onRestart}>
            重启生效
          </Button>
        )}
      </Tooltip>
    </span>
  );
}

// ===== 节头：开关 =====

export interface SectionSwitchProps {
  tool: ModelsTool;
  state: GatewayState;
  /// 这一节正在做别的写 Codex 设置的事（重启、接管……）：开关先不接新的一拨
  busy: boolean;
  phase: RestartPhase;
  onToggle: (next: boolean) => void;
}

/// 节头里的开关（DESIGN「第三方模型（一节）」）：开关＝配置里开没开，拨了就写、不确认。乐观翻转——
/// 拨下去滑块当即过去、亮橙，写超过 0.3 秒原位换成转圈 +「正在添加 / 正在移除」；没写成滑回，
/// 节头下灰面板。要重启才生效时不另加颜色，由旁边的 `重启生效` 说「还没生效」
export function SectionSwitch({ tool, state, busy, phase, onToggle }: SectionSwitchProps) {
  // 开着时永远能关：停用不依赖密钥和模型还在不在
  const blocked = state.enabled ? null : enableDisabledReason(state, totalSelected(state));
  const switching = phase.kind === "switching" ? phase.next : null;
  /// 乐观翻转：写的时候滑块已经在拨过去的那一侧
  const on = switching ?? state.enabled;
  const label = `${tool.name} 的第三方模型`;
  return (
    <span className="models-switch">
      {blocked !== null && switching === null ? (
        // 禁用的开关自带原因提示框：悬停出、按下当即出
        <Switch
          checked={false}
          onChange={() => undefined}
          label={label}
          disabledReason={blocked}
          tipPlacement="bottom"
        />
      ) : (
        <BusySlot
          busy={switching !== null}
          label={gatewaySwitchText(switching ?? true, tool).busy}
          className="models-switch__busy"
        >
          <Tooltip
            content={
              on
                ? `关掉后，${tool.name} 只保留官方模型`
                : `打开后，选好的模型会出现在 ${tool.name} 的模型列表里`
            }
            placement="bottom"
          >
            <Switch
              checked={on}
              onChange={onToggle}
              label={label}
              disabledReason={
                busy && switching === null ? "正在处理上一步" : undefined
              }
            />
          </Tooltip>
        </BusySlot>
      )}
    </span>
  );
}

// ===== 在用 =====

/// `在用` 一行（DESIGN「在用」）：标签（开关关着时写 `已选`）+ 模型片（友好名，完整 id 进提示框；
/// 两家网关撞名时片名后加 ` · 网关短名`）。一个都没选时这一行不出。只管「看」和「去掉」，挑选只在网关行里
export function InUseRow({
  state,
  onRemove,
}: {
  state: GatewayState;
  onRemove: (provider: GatewayProvider, model: GatewayProviderModel) => void;
}) {
  const rows = effectiveModels(state);
  if (rows.length === 0) return null;
  const label = inUseLabel(state);
  return (
    <div className="models-inuse">
      <span className="models-inuse__label">{label}</span>
      <div className="models-inuse__chips" role="list" aria-label={`${label}的模型`}>
        {rows.map(({ provider, model, name, suffix }) => (
          <span key={`${provider.id}|${model.id}`} role="listitem" className="models-inuse__chip">
            <ModelChip
              name={name}
              suffix={suffix}
              id={model.slug || model.id}
              onRemove={() => onRemove(provider, model)}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

// ===== 这一节 =====

export interface ModelsTabProps {
  onError: (message: string) => void;
  /// 每次拿到新状态都报给壳：侧栏 Codex 后的指示点要它
  onGatewayState?: (state: GatewayState) => void;
}

export default function ModelsTab({ onError, onGatewayState }: ModelsTabProps) {
  const tool = MODELS_TOOLS[0];
  const [state, setState] = useState<GatewayState | null>(null);
  /// 这一节正在做一件写 Codex 设置的事（重启、接管、重启路由、存网关……）：对同一对象的下一次操作
  /// 先不接（键禁用并说「正在处理上一步」）；不锁页面、不锁别的页，勾选排队不受它影响
  const [busy, onBusy] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  /// 网关行展开着的那几家（进这一页时都收着）
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const [confirmRestart, setConfirmRestart] = useState<ConfirmAnchor | null>(null);
  const [notice, setNotice] = useState<SectionNoticeState | null>(null);
  /// 行内待办条正在执行的那一条（接管 / 重新写入 / 重启路由）：它的键换成忙碌指示
  const [resolving, setResolving] = useState<"takeover" | "rewrite" | "router" | null>(null);
  /// 启动时的自愈试过了没有：试过仍没起来才出「路由没在跑」
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  const reportState = useRef(onGatewayState);
  reportState.current = onGatewayState;
  const keyEl = useRef<HTMLSpanElement | null>(null);
  /// 最近一次勾选是在哪一家网关的列表里点的（null＝点的是在用片上的 ×）：写失败的灰面板出在那里
  const toggledIn = useRef<string | null>(null);
  /// 此刻画在页面上的状态（含还没写完的勾选）：连点时下一下在上一下的基础上算
  const shown = useRef<GatewayState | null>(null);
  /// 勾选的写盘队列（DESIGN「勾选不闪」）：先画、后台排队写、失败才回滚并说话。
  /// 后端给的状态一律经它（applyState）：还有没写完的勾选时只记下、不画，片不会跳回去再跳回来
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

  /// 轻查：后台例行读取，不显示忙碌、不锁页面（焦点重读、键显示时的轮询）
  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch {
      // 轻查失败不打扰：下一次焦点或操作还会再读
    }
  }, [applyState]);

  // 挂载：读一次；路由没在跑就先自愈一次（重启路由），还不行才让待办条出来。
  // 这是后台读取，不置 busy（读回来之前这一节只有一行「正在读模型设置」）
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

  // 菜单栏面板也能开关、重启：它改完广播一声，这一节跟着重读；
  // 窗口获得焦点时也重读——外部重启了 Codex，「重启生效」键要自己消失
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

  // 键显示着时每 5 秒轻查一次，键消失即停；不做常驻进程监控
  const polling = shouldPollRestart(state, phase);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void quietRefresh(), RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, quietRefresh]);

  // ✓ 已生效 / 已启动那一窗到点（停留、悬停停表、淡出都在 Toast 里）
  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  /// 调命令 → 用返回的最新状态刷新；做不成就在节头下灰面板就地说。
  /// 开关、接管这类用户在等的操作才走这里；勾选不走这里，见 writer
  const run = async (message: string, action: () => Promise<GatewayState>) => {
    onBusy(true);
    try {
      // 排在还没写完的勾选后面：两边都写 Codex 设置，谁先谁后要和点的顺序一致
      await writer.idle();
      const next = await action();
      if (mounted.current) {
        applyState(next);
        setNotice(null);
      }
    } catch (error) {
      if (mounted.current) setNotice({ message, reason: describeError(error) });
    } finally {
      onBusy(false);
    }
  };

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

  const saveProvider = async (input: {
    id?: string;
    baseUrl: string;
    key?: string;
  }): Promise<string> => {
    onBusy(true);
    try {
      await writer.idle();
      const saved = await api.gatewayUpsertProvider(input);
      if (mounted.current) applyState(saved.state);
      return saved.providerId;
    } finally {
      onBusy(false);
    }
  };

  /// 重启 Codex：确认之后键位原地换成忙碌指示 + 「正在重启 Codex」；结束了进程再读，键消失才算生效。
  /// 键还在（Codex 还揣着旧配置）就如实说没成，不假装成功
  const restart = async () => {
    setConfirmRestart(null);
    setNotice(null);
    setPhase({ kind: "restarting" });
    onBusy(true);
    let failure: string | null = null;
    try {
      await api.gatewayRestartCodex();
      // 结束信号是异步的：等到旧进程退了（不再用旧配置）才算成，上限 15 秒
      const settled = await settleAfterRestart(api.gatewayState, applyState, () => mounted.current);
      if (settled === undefined) return;
      failure = settled;
    } catch (error) {
      failure = describeError(error);
    } finally {
      onBusy(false);
    }
    if (!mounted.current) return;
    if (failure !== null) {
      setNotice({
        message: `没重启 ${tool.name}`,
        reason: failure,
        action: { label: "再试一次", onClick: () => void restart() },
      });
    }
    setPhase(failure === null ? { kind: "done" } : { kind: "idle" });
  };

  /// 启动 Codex：不打断任何东西，不确认。键位原地换成忙碌指示 +「正在启动 Codex」，
  /// 轮询到它在跑（上限 15 秒）才算成；超时或打不开，节头下灰面板说原因 + `再试一次`
  const launch = async () => {
    setNotice(null);
    setPhase({ kind: "launching" });
    let failure: string | null = null;
    try {
      await api.gatewayLaunchCodex();
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      for (;;) {
        const fresh = await api.gatewayState();
        if (!mounted.current) return;
        applyState(fresh);
        if (fresh.codex.running) break;
        if (Date.now() >= deadline) {
          failure = LAUNCH_TIMEOUT;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
        if (!mounted.current) return;
      }
    } catch (error) {
      failure = describeError(error);
    }
    if (!mounted.current) return;
    if (failure !== null) {
      setNotice({
        message: `没启动 ${tool.name}`,
        reason: failure,
        action: { label: "再试一次", onClick: () => void launch() },
      });
    }
    setPhase(failure === null ? { kind: "launched" } : { kind: "idle" });
  };

  /// 拨开关（DESIGN「第三方模型（一节）」）：不确认，直接写配置——打断对话的是重启，不是拨开关。
  /// 滑块当即过去（phase switching，乐观翻转；写超过 0.3 秒原位转圈）；写成了用返回的状态刷新，
  /// 要重启才生效时旁边出 `重启生效`，Codex 没在跑出 `启动 Codex`。没写成：switchGateway 撤回刚写的、
  /// 滑块滑回，节头下灰面板 + `再试一次`
  const toggleSwitch = async (next: boolean) => {
    setNotice(null);
    setPhase({ kind: "switching", next });
    onBusy(true);
    let failure: string | null | undefined;
    try {
      // 排在还没写完的勾选后面：两边都写 Codex 设置，谁先谁后要和点的顺序一致
      await writer.idle();
      failure = await switchGateway(next, {
        write: (on) => (on ? api.gatewayEnable() : api.gatewayRestore()),
        read: api.gatewayState,
        onState: applyState,
        alive: () => mounted.current,
        describe: describeError,
      });
    } finally {
      onBusy(false);
    }
    if (failure === undefined || !mounted.current) return;
    setPhase({ kind: "idle" });
    if (failure === null) return;
    setNotice({
      message: gatewaySwitchText(next, tool).failed,
      reason: failure,
      action: { label: "再试一次", onClick: () => void toggleSwitch(next) },
    });
  };

  /// 勾上 / 取消一个模型。开着时去掉的是最后一个在用模型 → 等同关掉开关（同拨开关，不确认）：
  /// 直接写——先恢复（`gateway_restore` 不动勾选），再把这一家的勾选清空，两步都完成才是
  /// 「开关关、没有片」；Codex 在跑时写完出 `重启生效`
  const setModel = (providerId: string, modelId: string, selected: boolean) => {
    const base = shown.current;
    const model = base?.providers
      .find((p) => p.id === providerId)
      ?.models.find((m) => m.id === modelId);
    if (!base || !model || model.selected === selected) return;
    const { next, turnsOff } = selectModel(base, providerId, modelId, selected);
    const models = next.providers.find((p) => p.id === providerId)?.models ?? [];
    const payload = selectedPayload(models);
    writer.write(
      `${selected ? "没加上" : "没移除"} ${modelLabel(model)}`,
      next,
      turnsOff
        ? async () => {
            await api.gatewayRestore();
            return api.gatewaySelectModelsOf(providerId, payload);
          }
        : () => api.gatewaySelectModelsOf(providerId, payload),
    );
  };

  /// 网关行里的勾选列表：以画面上的状态为准翻转（连点时 provider 对象可能还是上一帧的）
  const toggleModel = (provider: GatewayProvider, id: string) => {
    const model = shown.current?.providers
      .find((p) => p.id === provider.id)
      ?.models.find((m) => m.id === id);
    if (!model) return;
    toggledIn.current = provider.id;
    setModel(provider.id, id, !model.selected);
  };

  /// 在用片上的 ×
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

  /// 行内待办条的动作：接管 / 重新写入。做成了用返回的状态刷新，条随问题一起消失；
  /// 做不成走同一个节头下灰面板说原因
  const resolveTodo = async (kind: "takeover" | "rewrite") => {
    setResolving(kind);
    await run(kind === "takeover" ? "没接管 Codex 的配置" : "没重新写入 Codex 的设置", () =>
      kind === "takeover" ? api.gatewayTakeover() : api.gatewayEnable(),
    );
    if (mounted.current) setResolving(null);
  };

  const restartRouter = async () => {
    setResolving("router");
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
      if (mounted.current) setResolving(null);
    }
  };

  const uninstall = async () => {
    setUninstalling(true);
    await run("没卸下后台服务", () => api.gatewayRestore());
    if (mounted.current) setUninstalling(false);
  };

  if (!state) {
    return (
      <Section title="第三方模型">
        <div className="models-loading" aria-busy="true">
          <Spinner size={14} label="正在读模型设置" />
          <span>正在读模型设置</span>
        </div>
      </Section>
    );
  }

  /// 这一节的灰面板：勾选在展开着的那一家列表里没写成的，出在那一行里；其余出在节头下
  const rowNotice: RowNotice | null =
    notice?.providerId !== undefined && expanded.has(notice.providerId)
      ? { providerId: notice.providerId, message: notice.message, reason: notice.reason }
      : null;
  const headNotice = notice !== null && rowNotice === null ? notice : null;

  const todos = sectionTodos({
    tool,
    state,
    healed,
    routerFailure,
    resolving,
    busy,
    onRestartRouter: () => void restartRouter(),
    onResolve: (kind) => void resolveTodo(kind),
  });

  return (
    <>
      <Section
        title="第三方模型"
        control={
          // 开关 + 16 + 它引起的下一步（重启生效 / 启动 Codex）：手刚拨完开关，下一步就在它旁边（②）
          <span className="models-headctl">
            <SectionSwitch
              tool={tool}
              state={state}
              busy={busy}
              phase={phase}
              onToggle={(next) => void toggleSwitch(next)}
            />
            <RestartSlot
              tool={tool}
              state={state}
              phase={phase}
              busy={busy}
              keyRef={keyEl}
              onRestart={() => setConfirmRestart(anchorOf(keyEl.current) ?? null)}
              onLaunch={() => void launch()}
              onDoneDismiss={dismissDone}
            />
          </span>
        }
        actions={
          // 拨开关写配置期间滑块已在新的一侧：只属于「关着」的这颗键先不出
          serviceLeftover(state) && phase.kind !== "switching" ? (
            // 按钮即状态：关着而服务还装着才出现，卸下即消失；卸下中原位忙碌 + 一句
            <BusySlot busy={uninstalling} label="正在卸下后台服务" className="models-restart">
              <Tooltip content={UNINSTALL_TIP} placement="bottom" align="end" nowrap>
                {busy && !uninstalling ? (
                  <Button size="compact" disabled disabledReason="正在处理上一步">
                    卸下后台服务
                  </Button>
                ) : (
                  <Button
                    size="compact"
                    onClick={uninstalling ? undefined : () => void uninstall()}
                  >
                    卸下后台服务
                  </Button>
                )}
              </Tooltip>
            </BusySlot>
          ) : null
        }
      >
        {headNotice ? (
          <div className="models-notice">
            <NoticePanel
              message={headNotice.message}
              reason={headNotice.reason}
              action={headNotice.action}
              onClose={() => setNotice(null)}
            />
          </div>
        ) : null}
        <InUseRow state={state} onRemove={removeModel} />
        {todos.length > 0 ? <div className="models-todos">{todos}</div> : null}
        <GatewayBlock
          tool={tool}
          state={state}
          busy={busy}
          expanded={expanded}
          onToggleRow={toggleRow}
          onExpand={expand}
          onSave={saveProvider}
          onFetchModels={(id) => runOrThrow(() => api.gatewayFetchModelsOf(id))}
          onRetry={(id) => runOrThrow(() => api.gatewayRetryProvider(id))}
          onRemove={(p) => runOrThrow(() => api.gatewayRemoveProvider(p.id))}
          onToggleModel={toggleModel}
          notice={rowNotice}
          onCloseNotice={() => setNotice(null)}
        />
      </Section>

      {confirmRestart !== null ? (
        <Confirm
          title={`重启 ${tool.name}？`}
          confirmLabel="重启"
          anchor={confirmRestart}
          onConfirm={() => void restart()}
          onCancel={() => setConfirmRestart(null)}
        >
          {RESTART_CONSEQUENCE}
        </Confirm>
      ) : null}
    </>
  );
}

/// 行内待办条（DESIGN「行内待办条」）：路由没在跑（排在最前，原因跟在主句后同一行）、正由
/// agents-manager 管理、Sophia 写进去的设置被改掉了。都不给「稍后」，问题解决自动收起；执行时键换成忙碌指示
export function sectionTodos({
  tool,
  state,
  healed,
  routerFailure,
  resolving,
  busy,
  onRestartRouter,
  onResolve,
}: {
  tool: ModelsTool;
  state: GatewayState;
  healed: boolean;
  routerFailure: string | null;
  resolving: "takeover" | "rewrite" | "router" | null;
  busy: boolean;
  onRestartRouter: () => void;
  onResolve: (kind: "takeover" | "rewrite") => void;
}): ReactNode[] {
  const out: ReactNode[] = [];
  if (showRouterTodo(state, healed)) {
    out.push(
      <NoticePanel
        key="router"
        message="路由没在跑，第三方模型用不了"
        reason={routerFailure ?? undefined}
        busy={resolving === "router" ? "正在重启路由" : undefined}
        action={{
          label: "重启路由",
          onClick: onRestartRouter,
          disabledReason: busy ? "正在处理上一步" : undefined,
        }}
      />,
    );
  }
  for (const issue of modelIssues(state)) {
    const kind = issue.action.kind;
    if (kind !== "takeover" && kind !== "rewrite") continue;
    out.push(
      <NoticePanel
        key={issue.key}
        message={
          kind === "takeover"
            ? `${tool.name} 正由 agents-manager 管理`
            : "Sophia 写进去的设置被改掉了"
        }
        busy={resolving === kind ? (kind === "takeover" ? "正在接管" : "正在重新写入") : undefined}
        action={{
          label: kind === "takeover" ? "接管" : "重新写入",
          onClick: () => onResolve(kind),
          disabledReason: busy ? "正在处理上一步" : undefined,
        }}
      />,
    );
  }
  return out;
}

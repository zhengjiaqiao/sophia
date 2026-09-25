import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import {
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT,
  LAUNCH_TIMEOUT_MS,
  MODELS_TOOLS,
  RESTART_CONSEQUENCE,
  RESTART_POLL_MS,
  effectiveModels,
  gatewaySwitchText,
  inUseLabel,
  modelIssues,
  modelLabel,
  parseBackendError,
  routerUnavailable,
  selectModel,
  settleAfterRestart,
  shouldPollRestart,
  showRouterTodo,
  switchGateway,
} from "./modelsView.ts";
import type { ModelsTool, RestartPhase } from "./modelsView.ts";
import type { GatewayProvider, GatewayProviderModel, GatewayState } from "./types.ts";
import { ChipRow, Confirm, ModelChip, NoticePanel, Spinner } from "./ui/index.ts";
import { HintStrip } from "./ui/HintStrip.tsx";
import { HINTS, useHint } from "./hints.ts";
import { Section } from "./ui/Section.tsx";
import { CodexKeySlot, CodexSwitch } from "./codexControls.tsx";
import { GatewayBlock } from "./ModelsGateways.tsx";
import type { RowNotice } from "./ModelsGateways.tsx";
import { createSelectionWriter } from "./selectionWrites.ts";
import "./ModelsTab.css";

/// Codex 页「第三方模型」一节（DESIGN「agent 页：Codex」，D5：原模型页与网关二级页合并成这一节）。
///
/// agent 页的外框（页面头的图标 + `Codex`、节与节之间的距离、整页限宽 776）由外壳按 agent 注册表画；这一节画：
/// - **新手提示条** `first-codex`：页面头下、节头上方；拨过开关或加过一家网关就算学会
/// - **节头**：左 `第三方模型`；右端开关（＝配置里开没开：拨了就写、不确认，乐观翻转，没写成滑回），
///   开关左边 12 条件出现 `重启生效` / `启动 Codex` / `卸下后台服务`（同一位，不会同时出现）——
///   一条左沿、一列控件：开关、待办条的键、`+ 网关`、网关行尾动作的右沿在同一条竖线上。
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

/// 节头下那块灰面板：做不成的事就地说（开关、重启、启动、卸下、勾选没成）。
/// `message` 是整句（`没重启 Codex` `没移除 GPT 5`），原因写全、折行不截断
export interface SectionNoticeState {
  message: string;
  reason: string;
  action?: { label: string; onClick: () => void };
  /// 勾选列表里点的：那一家网关行展开着时，灰面板出在那一行里（就近）
  providerId?: string;
}

// ===== 在用 =====

/// `在用` 一行（DESIGN「在用」，节头下 12）：胶囊行——标签（开关关着时写 `已选`）+ 8 + 模型片（友好名，完整 id
/// 进提示框；两家网关撞名时片名后加 ` · 网关短名`；片间 6、折行不藏）。一个都没选时这一行不出。
/// 只管「看」和「去掉」，挑选只在网关行里；片上 × 与网关行里的勾选是同一件事、实时联动
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
      <ChipRow label={label} listLabel={`${label}的模型`}>
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

// ===== 这一节 =====

export interface ModelsTabProps {
  onError: (message: string) => void;
  /// 每次拿到新状态都报给壳：侧栏 Codex 后的指示点要它
  onGatewayState?: (state: GatewayState) => void;
  /// 壳的错误横幅开着（机面顶上的灰面板）：新手提示让位
  banner?: boolean;
}

export default function ModelsTab({ onError, onGatewayState, banner = false }: ModelsTabProps) {
  const tool = MODELS_TOOLS[0];
  const [state, setState] = useState<GatewayState | null>(null);
  /// 这一节正在做一件写 Codex 设置的事（重启、接管、重启路由、存网关……）：对同一对象的下一次操作
  /// 先不接（键禁用并说「正在处理上一步」）；不锁页面、不锁别的页，勾选排队不受它影响
  const [busy, onBusy] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  /// 网关行展开着的那几家（进这一页时都收着）
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [notice, setNotice] = useState<SectionNoticeState | null>(null);
  /// 行内待办条正在执行的那一条（接管 / 重新写入 / 重启路由）：它的键换成忙碌指示
  const [resolving, setResolving] = useState<"takeover" | "rewrite" | "router" | null>(null);
  /// 启动时的自愈试过了没有：试过仍没起来才出「路由没在跑」
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  /// 网关块里开着删网关的确认框或行里的灰面板（新手提示让位）
  const [gatewayPanel, setGatewayPanel] = useState(false);
  const mounted = useRef(true);
  const reportState = useRef(onGatewayState);
  reportState.current = onGatewayState;
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

  // 新手提示 `first-codex`（DESIGN「新手提示条」）：第一次打开这一页、状态读回来（连同启动时的自愈）之后出。
  // 让位：壳的错误横幅、节里的灰面板与行内待办条、重启确认、网关块里的确认框与灰面板
  const hasTodos =
    state !== null &&
    (showRouterTodo(state, healed) ||
      modelIssues(state).some((i) => i.action.kind === "takeover" || i.action.kind === "rewrite"));
  const codexHint = useHint("first-codex", {
    eligible: state !== null && healed,
    blocked: banner || notice !== null || hasTodos || confirmRestart || gatewayPanel,
  });
  const hint = (
    <HintStrip open={codexHint.visible} onDismiss={codexHint.dismiss}>
      {HINTS["first-codex"]({ agents: [], skills: 0 })}
    </HintStrip>
  );

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
      // 加了一家新网关：`first-codex` 教的另一件事（改已有的那家不算）
      if (input.id === undefined) codexHint.learned();
      return saved.providerId;
    } finally {
      onBusy(false);
    }
  };

  /// 重启 Codex：确认之后键位原地换成 14 宽刻度 + 「正在重启 Codex」；结束了进程再读，键消失才算生效。
  /// 键还在（Codex 还揣着旧配置）就如实说没成，不假装成功
  const restart = async () => {
    setConfirmRestart(false);
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
  /// 滑块当即过去（phase switching，乐观翻转；写超过 0.3 秒原位刻度）；写成了用返回的状态刷新，
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
    if (failure === null) {
      // 拨过开关、写成了：`first-codex` 教的就是这件事
      codexHint.learned();
      return;
    }
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
      <>
        {hint}
        <Section title="第三方模型">
          <div className="models-loading" aria-busy="true">
            <Spinner size={14} label="正在读模型设置" />
            <span>正在读模型设置</span>
          </div>
        </Section>
      </>
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
      {hint}
      <Section
        title="第三方模型"
        control={
          // 紧跟节名：开关（拨了就写，乐观翻转；见 codexControls）
          <CodexSwitch
            tool={tool}
            state={state}
            switching={phase.kind === "switching" ? phase.next : null}
            busy={busy}
            label={`${tool.name} 的第三方模型`}
            // 提示框结果在前，改的是哪个文件写在后面（新手提示只说结果，路径挪到这里）
            withFile
            onToggle={(next) => void toggleSwitch(next)}
          />
        }
        actions={
          // 开关右边 12：它引起的下一步（重启生效 / 启动 Codex），手刚拨完开关，下一步就在它旁边（②）；
          // 同一位的 `卸下后台服务`（关着而服务还装着时）。三颗不会同时出现，与托盘同一段逻辑
          <CodexKeySlot
            tool={tool}
            state={state}
            phase={phase}
            busy={busy}
            uninstalling={uninstalling}
            onRestart={() => setConfirmRestart(true)}
            onLaunch={() => void launch()}
            onUninstall={() => void uninstall()}
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
          onPanelChange={setGatewayPanel}
        />
      </Section>

      {confirmRestart ? (
        <Confirm
          title={`重启 ${tool.name}？`}
          confirmLabel="重启"
          onConfirm={() => void restart()}
          onCancel={() => setConfirmRestart(false)}
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
        scope="section"
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
        scope="section"
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

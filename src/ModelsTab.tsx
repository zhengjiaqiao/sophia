import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import {
  MODELS_TOOLS,
  RESTART_CONSEQUENCE,
  RESTART_DONE_MS,
  RESTART_POLL_MS,
  RESTART_STILL_STALE,
  RESTART_TIP,
  availableCount,
  effectiveModels,
  emptyEffectiveText,
  enableDisabledReason,
  modelIssues,
  parseBackendError,
  routerUnavailable,
  shouldPollRestart,
  showRestartKey,
  serviceLeftover,
  showRouterTodo,
  UNINSTALL_TIP,
  totalSelected,
} from "./modelsView.ts";
import type { ModelsTool, RestartPhase } from "./modelsView.ts";
import type {
  GatewayProvider,
  GatewayProviderModel,
  GatewaySelectedModel,
  GatewayState,
} from "./types.ts";
import {
  AgentIcon,
  NoticePanel,
  Button,
  Confirm,
  ModelChip,
  Spinner,
  Switch,
  Toast,
  Tooltip,
} from "./ui/index.ts";
import type { ConfirmAnchor } from "./ui/index.ts";
import { ModelList } from "./ModelList.tsx";
import { GATEWAY_PAGE_MOTION_MS, GatewayPage } from "./pages/GatewayPage.tsx";
import type { GatewaySelection } from "./pages/GatewayPage.tsx";
import "./ModelsTab.css";

/// 模型页（DESIGN「产品裁决 › 模型页」，画板 Models）。
///
/// **一张面板表，一个 agent 一行**，与 Skills / MCP 同一种列表语言：
/// 表头 `agent` ｜ `生效模型`，表头底 2px（全页唯一），行线 hairline，横线止于最后一列 + 24。
///
/// agent 格 = 24px 图标 + 名字（20/700 不大写）+ 页面级开关 + `配置网关` + `[重启生效]`——
/// 开关、它控制的对象、它引起的提示三者落在同一处（① 就近）。页面上没有解释段落、
/// 没有版本 / 路由 / 网关几家这些内部事实。
///
/// **「改动待生效」由一个按钮表达，按钮即状态**：`needsCodexRestart` 比的是 Codex 加载的配置
/// 与现在，用户用任何方式重启 Codex 键都会自己消失。所以这一页在窗口获得焦点时重读，
/// 键显示着时每 5 秒轻查一次，键消失即停。**从不自动重启**（③ 对 ⑬ 的裁决）。
///
/// 模型框：模型片（友好名，完整 id 进 title）+ 尾端等宽可选数 + 展开记号；整框可点，
/// 选择器与框同宽左对齐。第三方分组头带限制说明与 `管理网关 ›`（没有网关时 `还没有网关 · + 网关 ›`）。
///
/// 路由没在跑：启动时先自愈一次（重启路由），还不行才在 Codex 行下出待办条 + `重启路由`，
/// 原因跟在主句后同一行写出；不可关、恢复后自动收起（⑫ 不给假选项）。路由只影响这一行，不用页级横幅。
///
/// 模型页不分项目、不分域，壳在这一页不渲染侧栏（`MODELS_TAB_FULL_BLEED`）。
///
/// 要你拿主意的两件事挂在 Codex 行下，是行内待办条（`NoticePanel`，灰面板）：正由 agents-manager 管理 → `接管`，
/// Sophia 写进去的设置被改掉了 → `重新写入`。判断照 `modelsView.modelIssues`；不给「稍后」，
/// 问题解决自动消失；执行时键换成忙碌指示。网关连不上在网关页那一家就地显示。

/// 模型页不分项目、不分域，左边那条侧栏对它没有意义。App.tsx 用这个常量做条件
export const MODELS_TAB_FULL_BLEED = true;

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

const selectedPayload = (models: GatewayProviderModel[]): GatewaySelectedModel[] =>
  models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName }));

/// 12px 展开记号：朝下＝收着，朝上＝开着
function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={up ? "M3 7.5L6 4.5l3 3" : "M3 4.5l3 3 3-3"} />
    </svg>
  );
}

/// 文字链后面那个 10px 的 ›（`管理网关 ›` `+ 网关 ›`）：明确的跳转
function LinkChevron() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 2.5L6.5 5 4 7.5" />
    </svg>
  );
}

/// 行内的那一处黑窗：做不成的事就地说（锚在 agent 行下，① 就近）
export interface RowNoticeState {
  verb: string;
  reason: string;
  action?: { label: string; onClick: () => void };
}

// ===== agent 行 =====

export interface AgentRowProps {
  tool: ModelsTool;
  state: GatewayState;
  busy: boolean;
  phase: RestartPhase;
  onToggle: (next: boolean) => void;
  onConfigure: () => void;
  /// 点了「重启生效」：带上整行，确认框锚在它下面、它不被遮罩盖住（⑦）
  onRestart: (row: HTMLElement) => void;
  notice?: RowNoticeState | null;
  onCloseNotice?: () => void;
  /// 挂在整行下面的行内待办条（接管 / 重新写入）
  todos?: ReactNode;
  /// 生效模型那一格
  models: ReactNode;
  /// 停用后服务仍在时的 `卸下后台服务`（按钮即状态）；正在卸下时原位忙碌指示 + 文字
  uninstalling?: boolean;
  onUninstall?: () => void;
}

export function AgentRow({
  tool,
  state,
  busy,
  phase,
  onToggle,
  onConfigure,
  onRestart,
  notice,
  onCloseNotice,
  todos,
  models,
  uninstalling = false,
  onUninstall,
}: AgentRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  // 已启用时永远能关：停用不依赖密钥和模型还在不在
  const blocked = state.enabled ? null : enableDisabledReason(state, totalSelected(state));

  return (
    <div className="models-row" ref={rowRef}>
      <div className="models-row__agent">
        <AgentIcon id={tool.id} name={tool.name} size={24} />
        <span className="models-row__name">{tool.name}</span>
        {blocked !== null ? (
          <Switch
            checked={false}
            onChange={() => undefined}
            label={`启用 ${tool.name} 的第三方模型`}
            disabledReason={blocked}
          />
        ) : (
          <Tooltip
            content={
              state.enabled
                ? `关掉：${tool.name} 只剩官方模型`
                : `打开：选好的模型进 ${tool.name} 的模型列表`
            }
          >
            <Switch
              checked={state.enabled}
              onChange={onToggle}
              label={`启用 ${tool.name} 的第三方模型`}
              disabledReason={busy ? "正在处理上一步" : undefined}
            />
          </Tooltip>
        )}
        {/* 进网关二级页：普通默认键，不带展开记号（DESIGN「网关配置是二级页」） */}
        <Tooltip content="加第三方模型的来源">
          <Button size="compact" onClick={onConfigure}>
            配置网关
          </Button>
        </Tooltip>
        <RestartSlot
          tool={tool}
          state={state}
          phase={phase}
          busy={busy}
          onRestart={() => rowRef.current && onRestart(rowRef.current)}
        />
        {uninstalling ? (
          <span className="models-restart models-restart--busy" role="status">
            <Spinner size={14} label="正在卸下后台服务" />
            <span className="models-restart__text">正在卸下后台服务</span>
          </span>
        ) : serviceLeftover(state) && onUninstall ? (
          // 与「重启生效」同一组件、同一「按钮即状态」规则：停用后服务仍在才出现，卸下即消失
          <span className="models-uninstall-tip">
            {/* 键折到第二行时，上方正是 Codex 这一行：提示框放键下方，不盖住触发它的这一行 */}
            <Tooltip content={UNINSTALL_TIP} placement="bottom">
              {busy ? (
                <Button size="compact" disabled disabledReason="正在处理上一步">
                  卸下后台服务
                </Button>
              ) : (
                <Button size="compact" onClick={onUninstall}>
                  卸下后台服务
                </Button>
              )}
            </Tooltip>
          </span>
        ) : null}
      </div>
      <div className="models-row__models">{models}</div>
      {todos ? <div className="models-row__todos">{todos}</div> : null}
      {notice ? (
        <div className="models-row__notice">
          <Toast
            kind="cannot"
            verb={notice.verb}
            agents={[{ id: tool.id, name: tool.name }]}
            names={[tool.name]}
            reason={notice.reason}
            action={notice.action}
            onClose={onCloseNotice}
          />
        </div>
      ) : null}
    </div>
  );
}

/// 「重启生效」那一格：键 / 忙碌指示 + 正在重启 / ✓ 已生效（例行成功，约 4 秒淡出）。
/// 失败的黑块不在这里——它挂在整行下面（`notice`），键照常留着可以再点
function RestartSlot({
  tool,
  state,
  phase,
  busy,
  onRestart,
}: {
  tool: ModelsTool;
  state: GatewayState;
  phase: RestartPhase;
  busy: boolean;
  onRestart: () => void;
}) {
  if (phase.kind === "restarting") {
    return (
      <span className="models-restart models-restart--busy" role="status">
        <Spinner size={14} label={`正在重启 ${tool.name}`} />
        <span className="models-restart__text">正在重启 {tool.name}</span>
      </span>
    );
  }
  if (phase.kind === "done") {
    return (
      <span className="models-restart models-restart--done">
        <Toast tier="routine" kind="success" verb="已生效" />
      </span>
    );
  }
  if (!showRestartKey(state, phase)) return null;
  return (
    // 这句提示框按画板单行显示（其余提示框仍是 240 上限），见 css 的 .models-restart-tip
    <span className="models-restart-tip">
      <Tooltip content={RESTART_TIP}>
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

// ===== 模型框 =====

export interface ModelBoxProps {
  tool: ModelsTool;
  state: GatewayState;
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onRemoveModel: (provider: GatewayProvider, model: GatewayProviderModel) => void;
  /// 选择器浮层。挂在框外层，浮层里的点击不会冒泡回框上再把它开关一次
  children?: ReactNode;
}

/**
 * 一个常驻的 hairline 框：模型片（友好名，完整 id 进 title，带 ×）+ 尾端等宽可选数 + 展开记号。
 * 整框可点，点开时框线转 `ink`、记号朝上。**改选在这一页完成**，不进二级页。
 * 片上的名字用 `effectiveModels` 的 `label`：两家网关撞名时后端会加「 · 网关名」，
 * 这里写的得和 Codex 里看到的一致。
 */
export function ModelBox({
  tool,
  state,
  open,
  busy,
  onToggleOpen,
  onRemoveModel,
  children,
}: ModelBoxProps) {
  const rows = effectiveModels(state);
  const count = availableCount(state);
  return (
    <div className="models-box-wrap">
      <div
        className={`models-box${open ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${tool.name} 的生效模型，点一下改选`}
        data-tool={tool.id}
        onClick={onToggleOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleOpen();
          }
        }}
      >
        {rows.length === 0 ? (
          <span className="models-box__hint">
            {state.providers.length === 0 ? "还没有网关" : emptyEffectiveText(state)}
          </span>
        ) : (
          // 片放不下就换行（框随之长高），可选数与展开记号钉在第一行右端
          <span className="models-box__chips">
            {rows.map(({ provider, model, label }) => (
              // 片上的 × 只移除这一个，别顺带把选择器也开关了
              <span
                key={`${provider.id}|${model.id}`}
                className="models-box__chip"
                onClick={(e) => e.stopPropagation()}
              >
                <ModelChip
                  name={label}
                  id={model.slug || model.id}
                  onRemove={busy ? undefined : () => onRemoveModel(provider, model)}
                />
              </span>
            ))}
          </span>
        )}
        <span className="models-box__tail">
          <Tooltip content={`${count} 个可用模型`}>
            <span className="models-box__count">{count}</span>
          </Tooltip>
          <Chevron up={open} />
        </span>
      </div>
      {children}
    </div>
  );
}

// ===== 选择器 =====

export interface ModelPickerProps {
  tool: ModelsTool;
  state: GatewayState;
  busy: boolean;
  onToggleModel: (provider: GatewayProvider, modelId: string) => void;
  /// `管理网关 ›` / `+ 网关 ›`：收起下拉，进网关二级页
  onManageGateways: () => void;
}

/**
 * 选择器浮层：与网关页同一组件（ModelList）——列全部网关的全部模型，按服务商分小组头；
 * 超过约 8 行出筛选框；已选置顶、整行可点、勾选当场写盘；跨网关时行尾写来源网关短名。
 *
 * 第三方组头 = `第三方` + 限制说明（只在挑模型时有用，① 放在这里，不截断）+ 末尾 `管理网关 ›`；
 * 没有网关时 `还没有网关 · + 网关 ›`。
 */
export function ModelPicker({
  tool,
  state,
  busy,
  onToggleModel,
  onManageGateways,
}: ModelPickerProps) {
  const hasProviders = state.providers.length > 0;
  const entries = state.providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const header = (
    <div className="models-picker__group">
      <span className="models-picker__group-name">第三方</span>
      {hasProviders ? (
        <Tooltip content={tool.limitations}>
          <span className="models-picker__group-note">{tool.pickerNote}</span>
        </Tooltip>
      ) : (
        <span className="models-picker__group-note">还没有网关</span>
      )}
      <Tooltip content="进 Codex 的网关页">
        <button type="button" className="models-picker__jump" onClick={onManageGateways}>
          <span className="models-picker__jump-text">{hasProviders ? "管理网关" : "+ 网关"}</span>
          <LinkChevron />
        </button>
      </Tooltip>
    </div>
  );
  return (
    // 点浮层外面关闭由 ModelsTab 在 pointerdown 捕获阶段做：不铺透明罩，外面那一下点击照常生效
    <div className="models-picker" role="dialog" aria-label={`选 ${tool.name} 的模型`}>
      {hasProviders ? (
        <ModelList
          entries={entries}
          busy={busy}
          onToggle={onToggleModel}
          header={header}
          empty="还没拉到模型——在网关里存好地址和密钥就会拉"
        />
      ) : (
        header
      )}
    </div>
  );
}

// ===== 页面 =====

export interface ModelsTabProps {
  onError: (message: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 每次拿到新状态都报给壳：新问题的一次性提示要认模型类的问题
  onGatewayState?: (state: GatewayState) => void;
  /// 新问题提示「查看」网关连不上：进网关二级页、选中这一家、它的分段片闪两下；处理完回调 onFocused，
  /// 壳在那里清回 undefined（与 SkillsTab 的 focusKey 同一模式）
  focusProviderId?: string;
  onFocused?: () => void;
}

export default function ModelsTab({
  onError,
  busy,
  onBusy,
  onGatewayState,
  focusProviderId,
  onFocused,
}: ModelsTabProps) {
  const [state, setState] = useState<GatewayState | null>(null);
  /// 模型下拉开着的那个 agent
  const [picker, setPicker] = useState<string | null>(null);
  /// 网关二级页：开着时 `initial` 是进来那一刻先选中哪一家（"new" 直接出新网关表单）；
  /// `leaving` 是返回滑回的那 200ms，播完才卸掉
  const [gateway, setGateway] = useState<{
    initial: GatewaySelection | null;
    leaving: boolean;
  } | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  /// 跳回定位的那一家：分段片闪两下（960ms）后清掉
  const [flashProvider, setFlashProvider] = useState<string | null>(null);
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  const [confirmRestart, setConfirmRestart] = useState<ConfirmAnchor | null>(null);
  const [notice, setNotice] = useState<RowNoticeState | null>(null);
  /// 行内待办条正在执行的那一条（接管 / 重新写入）：它的键换成忙碌指示
  const [resolving, setResolving] = useState<"takeover" | "rewrite" | "router" | null>(null);
  /// 启动时的自愈试过了没有：试过仍没起来才出页级横幅
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  const reportState = useRef(onGatewayState);
  reportState.current = onGatewayState;

  const applyState = useCallback((next: GatewayState) => {
    setState(next);
    reportState.current?.(next);
  }, []);

  /// 轻查：后台例行读取，不显示忙碌、不锁页面（焦点重读、键显示时的轮询）
  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch {
      // 轻查失败不打扰：下一次焦点或操作还会再读
    }
  }, [applyState]);

  // 挂载：读一次；路由没在跑就先自愈一次（重启路由），还不行才让横幅出来。
  // 这是后台读取，不置 busy、不锁页签（读回来之前这一页只有一行「正在读模型设置」）
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

  // 菜单栏面板也能开关、重启：它改完广播一声，这一页跟着重读；
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

  // 已生效那一行约 4 秒后淡出（淡出本身在 css 里，末尾 120ms）
  useEffect(() => {
    if (phase.kind !== "done") return;
    const timer = setTimeout(() => setPhase({ kind: "idle" }), RESTART_DONE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // 浮层开着时：Esc 关闭并把焦点还给模型框；在框与浮层之外按下指针也关闭。
  // 两个都在捕获阶段听：Esc 不被输入框先吃掉；外面那一下只顺手关浮层，不拦截——
  // 点齿轮、点页签照常生效（不铺透明罩，罩子会把这一下点击吞掉）
  const pickerOpen = picker;
  useEffect(() => {
    if (pickerOpen === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePicker();
      document.querySelector<HTMLElement>(`.models-box[data-tool="${pickerOpen}"]`)?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".models-box-wrap")) return;
      closePicker();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [pickerOpen]);

  /// 调命令 → 用返回的最新状态刷新；做不成就在 agent 行下就地说（① 就近）
  const run = async (verb: string, action: () => Promise<GatewayState>) => {
    onBusy(true);
    try {
      const next = await action();
      if (mounted.current) {
        applyState(next);
        setNotice(null);
      }
    } catch (error) {
      if (mounted.current) setNotice({ verb, reason: describeError(error) });
    } finally {
      onBusy(false);
    }
  };

  /// 网关页要自己就地说明失败，所以这一支把错误原样抛回去
  const runOrThrow = async (action: () => Promise<GatewayState>) => {
    onBusy(true);
    try {
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
      const saved = await api.gatewayUpsertProvider(input);
      if (mounted.current) applyState(saved.state);
      return saved.providerId;
    } finally {
      onBusy(false);
    }
  };

  /// 重启 Codex：确认之后键位原地换成忙碌指示 + 「正在重启 Codex」；结束了进程再重读一次，键消失才算生效。
  /// 键还在（Codex 还揣着旧配置）就如实说没成，不假装成功（⑫）
  const restart = async (tool: ModelsTool) => {
    setConfirmRestart(null);
    setNotice(null);
    setPhase({ kind: "restarting" });
    onBusy(true);
    let failure: string | null = null;
    try {
      await api.gatewayRestartCodex();
      const fresh = await api.gatewayState();
      if (mounted.current) applyState(fresh);
      if (fresh.needsCodexRestart) failure = RESTART_STILL_STALE;
    } catch (error) {
      failure = describeError(error);
    } finally {
      onBusy(false);
    }
    if (!mounted.current) return;
    if (failure !== null) {
      setNotice({
        verb: "没重启",
        reason: failure,
        action: { label: "再试一次", onClick: () => void restart(tool) },
      });
    }
    setPhase(failure === null ? { kind: "done" } : { kind: "idle" });
  };

  /// 勾选当场写盘，不出成功提示条：片的增减本身就是反馈；只有失败才说话
  const commitModels = (provider: GatewayProvider, models: GatewayProviderModel[], verb: string) =>
    run(verb, () => api.gatewaySelectModelsOf(provider.id, selectedPayload(models)));

  const toggleModel = (provider: GatewayProvider, id: string) => {
    const model = provider.models.find((m) => m.id === id);
    void commitModels(
      provider,
      provider.models.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)),
      model?.selected ? "没移除" : "没加上",
    );
  };

  const removeModel = (provider: GatewayProvider, model: GatewayProviderModel) =>
    void commitModels(
      provider,
      provider.models.map((m) => (m.id === model.id ? { ...m, selected: false } : m)),
      "没移除",
    );

  const openPicker = (tool: ModelsTool) => setPicker(tool.id);
  const closePicker = () => setPicker(null);

  /// 进网关二级页（`配置网关`、下拉里的 `管理网关 ›` / `+ 网关 ›`、新问题提示的「查看」）
  const openGateway = (initial: GatewaySelection | null) => {
    setPicker(null);
    setGateway({ initial, leaving: false });
  };

  /// 离开网关页：滑回 200ms 再卸掉（reduced-motion 即时）
  const leaveGateway = () => setGateway((g) => (g ? { ...g, leaving: true } : g));

  const gatewayLeaving = gateway?.leaving ?? false;
  useEffect(() => {
    if (!gatewayLeaving) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setGateway(null), reduce ? 0 : GATEWAY_PAGE_MOTION_MS);
    return () => clearTimeout(timer);
  }, [gatewayLeaving]);

  // 新问题提示「查看」网关连不上：状态读回来、且这一家还在，就进网关页选中它、闪它的分段片
  useEffect(() => {
    if (focusProviderId === undefined || state === null) return;
    if (state.providers.some((p) => p.id === focusProviderId)) {
      openGateway(focusProviderId);
      setFlashProvider(focusProviderId);
    }
    onFocused?.();
    // openGateway 只写本地状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProviderId, state === null]);

  useEffect(() => {
    if (flashProvider === null) return;
    const timer = setTimeout(() => setFlashProvider(null), 960);
    return () => clearTimeout(timer);
  }, [flashProvider]);

  /// 行内待办条的动作：接管 / 重新写入。做成了用返回的状态刷新，条随问题一起消失；
  /// 做不成走同一个行下黑块说原因
  const resolveTodo = async (kind: "takeover" | "rewrite") => {
    setResolving(kind);
    await run(kind === "takeover" ? "没接管" : "没写入", () =>
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

  if (!state) {
    return (
      <section className="models-page" aria-busy="true">
        <div className="models-page__loading">
          <Spinner size={14} label="正在读模型设置" />
          <span>正在读模型设置</span>
        </div>
      </section>
    );
  }

  /// 重启确认：会中断进行中的对话，确认一道（⑪ 确认只剩两件之一）；锚在触发它的那一行下面、
  /// 那一行不被遮罩盖住。网关页开着时它渲染在网关页里——主视图那时是 inert 的
  const restartConfirm =
    confirmRestart !== null ? (
      <Confirm
        title={`重启 ${MODELS_TOOLS[0].name}？`}
        confirmLabel="重启"
        anchor={confirmRestart}
        onConfirm={() => void restart(MODELS_TOOLS[0])}
        onCancel={() => setConfirmRestart(null)}
      >
        {RESTART_CONSEQUENCE}
      </Confirm>
    ) : null;

  return (
    <section className="models-page">
      <div className="models-page__body">
        <div className="models-panel">
          <div className="models-panel__head">
            <span>agent</span>
            <span>生效模型</span>
          </div>
          {MODELS_TOOLS.map((tool) => (
            <AgentRow
              key={tool.id}
              tool={tool}
              state={state}
              busy={busy}
              phase={phase}
              onToggle={(next) =>
                void run(next ? "没打开" : "没关掉", () =>
                  next ? api.gatewayEnable() : api.gatewayRestore(),
                )
              }
              onConfigure={() => openGateway(null)}
              onRestart={(row) => {
                const r = row.getBoundingClientRect();
                setConfirmRestart({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
              }}
              notice={notice}
              onCloseNotice={() => setNotice(null)}
              todos={(() => {
                const todos = modelIssues(state, tool).flatMap((issue) =>
                  issue.action.kind === "takeover" || issue.action.kind === "rewrite"
                    ? [{ key: issue.key, kind: issue.action.kind }]
                    : [],
                );
                // 路由没在跑：只影响这一行的第三方模型，排在最前，原因跟在主句后同一行
                const router = showRouterTodo(state, healed) ? (
                  <NoticePanel
                    key="router"
                    message="路由没在跑，第三方模型用不了"
                    reason={routerFailure ?? undefined}
                    busy={resolving === "router" ? "正在重启路由" : undefined}
                    action={{
                      label: "重启路由",
                      onClick: () => void restartRouter(),
                      disabledReason: busy ? "正在处理上一步" : undefined,
                    }}
                  />
                ) : null;
                if (todos.length === 0 && router === null) return undefined;
                return [router, ...todos.map(({ key, kind }) => (
                  <NoticePanel
                    key={key}
                    message={
                      kind === "takeover"
                        ? `${tool.name} 正由 agents-manager 管理`
                        : "Sophia 写进去的设置被改掉了"
                    }
                    busy={
                      resolving === kind
                        ? kind === "takeover"
                          ? "正在接管"
                          : "正在重新写入"
                        : undefined
                    }
                    action={{
                      label: kind === "takeover" ? "接管" : "重新写入",
                      onClick: () => void resolveTodo(kind),
                      disabledReason: busy ? "正在处理上一步" : undefined,
                    }}
                  />
                ))];
              })()}
              models={
                <ModelBox
                  tool={tool}
                  state={state}
                  open={picker === tool.id}
                  busy={busy}
                  onToggleOpen={() => (picker === tool.id ? closePicker() : openPicker(tool))}
                  onRemoveModel={removeModel}
                >
                  {picker === tool.id ? (
                    <ModelPicker
                      tool={tool}
                      state={state}
                      busy={busy}
                      onToggleModel={toggleModel}
                      onManageGateways={() =>
                        openGateway(state.providers.length === 0 ? "new" : null)
                      }
                    />
                  ) : null}
                </ModelBox>
              }
              uninstalling={uninstalling}
              onUninstall={() =>
                void (async () => {
                  setUninstalling(true);
                  await run("没卸下", () => api.gatewayRestore());
                  if (mounted.current) setUninstalling(false);
                })()
              }
            />
          ))}
        </div>
      </div>

      {/* 网关二级页：盖在模型页上，从右侧推入；两处选模型读的是同一个 state */}
      {gateway !== null ? (
        <GatewayPage
          key={String(gateway.initial)}
          tool={MODELS_TOOLS[0]}
          state={state}
          busy={busy}
          initial={gateway.initial}
          leaving={gateway.leaving}
          onLeave={leaveGateway}
          modalOpen={confirmRestart !== null}
          overlay={restartConfirm}
          headerAction={
            <RestartSlot
              tool={MODELS_TOOLS[0]}
              state={state}
              phase={phase}
              busy={busy}
              onRestart={() => {
                const bar = document.querySelector(".gw-page-sub .ss-subpage__bar");
                if (!bar) return;
                const r = bar.getBoundingClientRect();
                setConfirmRestart({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
              }}
            />
          }
          onSave={saveProvider}
          onFetchModels={(id) => runOrThrow(() => api.gatewayFetchModelsOf(id))}
          onRetry={(id) => runOrThrow(() => api.gatewayRetryProvider(id))}
          onRemove={(p) => runOrThrow(() => api.gatewayRemoveProvider(p.id))}
          onToggleModel={toggleModel}
          flashProviderId={flashProvider}
        />
      ) : null}

      {gateway === null ? restartConfirm : null}
    </section>
  );
}

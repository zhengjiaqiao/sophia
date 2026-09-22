import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  modelKeys,
  modelLabel,
  newModelIds,
  parseBackendError,
  providerLabel,
  removeProviderBlockedReason,
  routerUnavailable,
  selectedModels,
  shouldPollRestart,
  showRestartKey,
  showRouterBanner,
  sortAndFilterModels,
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
  Busy,
  Button,
  Confirm,
  ErrorBanner,
  ModelChip,
  Rotor,
  Switch,
  Toast,
  Tooltip,
} from "./ui/index.ts";
import type { ConfirmAnchor } from "./ui/index.ts";
import { GatewayPage } from "./pages/GatewayPage.tsx";
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
/// 路由没在跑：启动时先自愈一次（重启路由），还不行才出页级错误横幅 + `重启路由`，
/// 不可关、恢复后自动收起（⑫ 不给假选项）。
///
/// 模型页不分项目、不分域，壳在这一页不渲染侧栏（`MODELS_TAB_FULL_BLEED`）。
///
/// 模型的待处理（接管、配置被外部改过、网关连不上）不在这一页就地出现，进顶栏收件箱
/// （`modelsView.modelIssues`）。

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
  /// 转盘停稳了（停转回弹结束），把结果换上来
  onRotorStopped?: () => void;
  notice?: RowNoticeState | null;
  onCloseNotice?: () => void;
  /// 生效模型那一格
  models: ReactNode;
}

export function AgentRow({
  tool,
  state,
  busy,
  phase,
  onToggle,
  onConfigure,
  onRestart,
  onRotorStopped,
  notice,
  onCloseNotice,
  models,
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
          onRotorStopped={onRotorStopped}
        />
      </div>
      <div className="models-row__models">{models}</div>
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

/// 「重启生效」那一格：键 / 转盘 + 正在重启 / ✓ 已生效（例行成功，约 4 秒淡出）。
/// 失败的黑块不在这里——它挂在整行下面（`notice`），键照常留着可以再点
function RestartSlot({
  tool,
  state,
  phase,
  busy,
  onRestart,
  onRotorStopped,
}: {
  tool: ModelsTool;
  state: GatewayState;
  phase: RestartPhase;
  busy: boolean;
  onRestart: () => void;
  onRotorStopped?: () => void;
}) {
  if (phase.kind === "restarting") {
    return (
      <span className="models-restart models-restart--busy" role="status">
        <Rotor
          size={14}
          spinning={phase.spinning}
          onStopped={onRotorStopped}
          label={`正在重启 ${tool.name}`}
        />
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
          rows.map(({ provider, model, label }) => (
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
          ))
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
  query: string;
  onQuery: (next: string) => void;
  onToggleModel: (provider: GatewayProvider, modelId: string) => void;
  /// 去网关页；返回时回到这里
  onManageGateways: () => void;
  /// 打开时滚到这一家的分组（从网关页 `选模型 ›` 回来）
  focusProviderId?: string | null;
  /// 这几个模型各闪一次（刚拉到的）
  flashIds?: string[];
  onClose: () => void;
}

/**
 * 选择器浮层：搜索框 + 列表，已选置顶，12px 方形复选框；整行可点，勾选当场写盘，
 * 没有保存 / 关闭按钮；底部一句 `已选 N 个`。
 *
 * 第三方分组头 = `第三方` + 限制说明（只在挑模型时有用，① 放在这里）+ 末尾 `管理网关 ›`；
 * 没有网关时 `还没有网关 · + 网关 ›`。多于一家时每家再有一个小抬头，归属分得清。
 */
export function ModelPicker({
  tool,
  state,
  busy,
  query,
  onQuery,
  onToggleModel,
  onManageGateways,
  focusProviderId,
  flashIds,
  onClose,
}: ModelPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = state.providers
    .map((provider) => ({ provider, models: sortAndFilterModels(provider.models, query) }))
    .filter((group) => group.models.length > 0);
  const hasProviders = state.providers.length > 0;
  const anyModel = state.providers.some((p) => p.models.length > 0);
  const grouped = state.providers.length > 1;
  const flash = new Set(flashIds ?? []);
  const selected = totalSelected(state);

  // 从网关页回来：滚到那一家的分组，抬头贴列表顶
  useLayoutEffect(() => {
    if (!focusProviderId || !listRef.current) return;
    const target = listRef.current.querySelector<HTMLElement>(
      `[data-provider="${CSS.escape(focusProviderId)}"]`,
    );
    if (target) listRef.current.scrollTop = target.offsetTop - listRef.current.offsetTop;
  }, [focusProviderId]);

  return (
    <>
      {/* 点浮层外面等于关闭；罩子透明，不遮挡下面 */}
      <button
        type="button"
        className="models-picker__veil"
        aria-label="关闭模型选择"
        onClick={onClose}
      />
      <div className="models-picker" role="dialog" aria-label={`选 ${tool.name} 的模型`}>
        <div className="models-picker__search">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          <input
            type="search"
            className="models-picker__input"
            placeholder="筛选"
            aria-label="筛选模型"
            value={query}
            autoFocus
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>

        <div className="models-picker__group">
          <span className="models-picker__group-name">第三方</span>
          {hasProviders ? (
            <Tooltip content={tool.limitations}>
              <span className="models-picker__group-note">{tool.pickerNote}</span>
            </Tooltip>
          ) : (
            <span className="models-picker__group-note">还没有网关</span>
          )}
          <Tooltip content="去网关页；返回时回到这里">
            <button type="button" className="models-picker__jump" onClick={onManageGateways}>
              <span className="models-picker__jump-text">
                {hasProviders ? "管理网关" : "+ 网关"}
              </span>
              <LinkChevron />
            </button>
          </Tooltip>
        </div>

        <Busy busy={busy} className="models-picker__list">
          <div ref={listRef} className="models-picker__scroll">
            {!hasProviders ? null : !anyModel ? (
              <p className="models-picker__empty">还没拉到模型——到网关页存好地址和密钥就会拉</p>
            ) : groups.length === 0 ? (
              <p className="models-picker__empty">
                没有匹配的模型
                <Button variant="link" onClick={() => onQuery("")}>
                  清除筛选
                </Button>
              </p>
            ) : (
              groups.map(({ provider, models }, gi) => (
                <div
                  key={provider.id}
                  className="models-picker__provider"
                  data-provider={provider.id}
                >
                  {grouped ? (
                    <div className="models-picker__provider-head">
                      <span>{providerLabel(provider)}</span>
                      <span className="models-picker__provider-count">
                        {provider.models.length}
                      </span>
                    </div>
                  ) : null}
                  {models.map((m, i) => {
                    const flashing = flash.has(m.id);
                    return (
                      <div
                        key={m.id}
                        className={`models-option${flashing ? " is-flash" : ""}`}
                        style={
                          flashing
                            ? { animationDelay: `${Math.min(gi * 4 + i, 12) * 60}ms` }
                            : undefined
                        }
                        role="option"
                        aria-selected={m.selected}
                        tabIndex={0}
                        // 整行是命中区（DESIGN「命中区与视觉尺寸是两回事」）
                        onClick={() => !busy && onToggleModel(provider, m.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            if (!busy) onToggleModel(provider, m.id);
                          }
                        }}
                      >
                        {/* 12px 方框只画状态（方＝我选的）；命中区是整行，读屏走 aria-selected */}
                        <span
                          className={`ss-checkbox models-option__check${m.selected ? " is-on" : ""}`}
                          aria-hidden="true"
                        >
                          {m.selected ? (
                            <svg
                              width="8"
                              height="8"
                              viewBox="0 0 8 8"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.4"
                            >
                              <path d="M1.2 4.2l1.9 1.9L6.8 1.9" />
                            </svg>
                          ) : null}
                        </span>
                        <span className="models-option__name">{modelLabel(m)}</span>
                        <span className="models-option__id">{m.slug || m.id}</span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </Busy>

        <div className="models-picker__foot">
          已选&nbsp;<span className="models-picker__count">{selected}</span>&nbsp;个
        </div>
      </div>
    </>
  );
}

// ===== 页面 =====

export interface ModelsTabProps {
  onError: (message: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /// 每次拿到新状态都报给壳：顶栏收件箱的「模型」段要数它
  onGatewayState?: (state: GatewayState) => void;
}

/// 选择器开着时的导航参数：从网关页 `选模型 ›` 回来时带上「滚到哪一家、哪几个闪」
interface PickerNav {
  toolId: string;
  focusProviderId: string | null;
  flashIds: string[];
}

export default function ModelsTab({ onError, busy, onBusy, onGatewayState }: ModelsTabProps) {
  const [state, setState] = useState<GatewayState | null>(null);
  const [picker, setPicker] = useState<PickerNav | null>(null);
  const [query, setQuery] = useState("");
  /// 网关页（二级页面）；`fromPicker` 表示从下拉里的 `管理网关 ›` 进去，返回时回到下拉
  const [gateway, setGateway] = useState<{ fromPicker: boolean } | null>(null);
  const [phase, setPhase] = useState<RestartPhase>({ kind: "idle" });
  /// 转盘停稳之后要换上的结果（停转回弹 600ms，DESIGN「转盘」）
  const nextPhase = useRef<RestartPhase | null>(null);
  const [confirmRestart, setConfirmRestart] = useState<ConfirmAnchor | null>(null);
  const [notice, setNotice] = useState<RowNoticeState | null>(null);
  /// 启动时的自愈试过了没有：试过仍没起来才出页级横幅
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  /// 删网关的旧确认框（T3 把网关页换成延迟提交后删）
  const [confirmRemove, setConfirmRemove] = useState<GatewayProvider | null>(null);
  /// 进网关页那一刻已有的模型：回来时差出新拉到的，各闪一次
  const beforeGateway = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  const reportState = useRef(onGatewayState);
  reportState.current = onGatewayState;

  const applyState = useCallback((next: GatewayState) => {
    setState(next);
    reportState.current?.(next);
  }, []);

  /// 轻查：不点亮全局转盘、不锁页面（焦点重读、键显示时的轮询）
  const quietRefresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch {
      // 轻查失败不打扰：下一次焦点或操作还会再读
    }
  }, [applyState]);

  // 挂载：读一次；路由没在跑就先自愈一次（重启路由），还不行才让横幅出来
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      onBusy(true);
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
      } finally {
        onBusy(false);
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

  // 浮层按 Esc 关
  useEffect(() => {
    if (picker === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [picker]);

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

  /// 重启 Codex：确认之后键位原地换成转盘；结束了进程再重读一次，键消失才算生效。
  /// 键还在（Codex 还揣着旧配置）就如实说没成，不假装成功（⑫）
  const restart = async (tool: ModelsTool) => {
    setConfirmRestart(null);
    setNotice(null);
    nextPhase.current = null;
    setPhase({ kind: "restarting", spinning: true });
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
    // 转盘带阻尼停下，停稳后再换上结果
    nextPhase.current = failure === null ? { kind: "done" } : { kind: "idle" };
    setPhase({ kind: "restarting", spinning: false });
  };

  const onRotorStopped = () => {
    const next = nextPhase.current;
    nextPhase.current = null;
    setPhase(next ?? { kind: "idle" });
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

  const openPicker = (tool: ModelsTool, nav?: Partial<PickerNav>) => {
    setQuery("");
    setPicker({ toolId: tool.id, focusProviderId: null, flashIds: [], ...nav });
  };

  const closePicker = () => {
    setQuery("");
    setPicker(null);
  };

  const openGateway = (fromPicker: boolean) => {
    if (state) beforeGateway.current = modelKeys(state);
    setPicker(null);
    setGateway({ fromPicker });
  };

  /// 删网关是延迟提交的（T4c）：离开网关页时把标记删除的全部提交——真正删配置与钥匙串密钥
  const leaveGateway = () => {
    setGateway(null);
    void api
      .gatewayCommitRemovals()
      .then((next) => mounted.current && applyState(next))
      .catch((error) => mounted.current && onError(describeError(error)));
  };

  /// 网关页返回（`←`）：从下拉进去的回到下拉
  const backFromGateway = () => {
    const from = gateway?.fromPicker ?? false;
    leaveGateway();
    if (from) openPicker(MODELS_TOOLS[0]);
  };

  /// 网关页那一行的 `选模型 ›`：回到模型页、展开下拉、滚到这一家的分组，新拉到的模型各闪一次。
  /// 网关页（T3）以 `onPickModelsFromGateway(providerId)` 调它
  const pickModelsFromGateway = (providerId: string) => {
    const flashIds = state ? newModelIds(state, beforeGateway.current, providerId) : [];
    leaveGateway();
    openPicker(MODELS_TOOLS[0], { focusProviderId: providerId, flashIds });
  };

  /// 网关页（T3）接下来要的回调。名字是和 T3 约好的契约；T3 的 props 落地之前，
  /// 展开传进去的多余属性不起作用（JSX 展开不做多余属性检查），落地后自动接上
  const gatewayNext = {
    onPickModelsFromGateway: pickModelsFromGateway,
    /// 「再试一次」：拉取本身失败不抛错，原因记在那一家的 unreachable 上
    onRetryProvider: (providerId: string) => runOrThrow(() => api.gatewayRetryProvider(providerId)),
    /// 删网关第一步：只标记，行消失；提示条上的撤销走 onUndoRemove
    onMarkRemove: (provider: GatewayProvider) =>
      runOrThrow(() => api.gatewayMarkRemoveProvider(provider.id)),
    onUndoRemove: (providerId: string) =>
      runOrThrow(() => api.gatewayUndoRemoveProvider(providerId)),
    /// 提示条到期：只提交这一家
    onCommitRemovals: (providerId?: string) =>
      runOrThrow(() => api.gatewayCommitRemovals(providerId)),
  };

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

  const removeConfirm = (current: GatewayState) => {
    if (confirmRemove === null) return null;
    const provider = confirmRemove;
    const blocked = removeProviderBlockedReason(current, provider);
    return (
      <Confirm
        title={`删掉 ${providerLabel(provider)}？`}
        nameplate={{ path: provider.baseUrl }}
        safetyNote={`地址、模型列表和钥匙串里的密钥一起删掉；已选的 ${selectedModels(provider).length} 个模型会从 Codex 的模型列表里去掉`}
        confirmLabel="连密钥一起删掉"
        confirmDisabledReason={blocked ?? undefined}
        onConfirm={() => {
          setConfirmRemove(null);
          void run("没删掉", () => api.gatewayRemoveProvider(provider.id));
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    );
  };

  if (gateway && state !== null) {
    return (
      <>
        <GatewayPage
          state={state}
          tool={MODELS_TOOLS[0]}
          busy={busy}
          onBack={backFromGateway}
          onSave={saveProvider}
          onFetchModels={(id) => runOrThrow(() => api.gatewayFetchModelsOf(id))}
          onRemove={(provider) => setConfirmRemove(provider)}
          onRestore={() => runOrThrow(() => api.gatewayRestore())}
          {...gatewayNext}
        />
        {removeConfirm(state)}
      </>
    );
  }

  if (!state) {
    return (
      <section className="models-page" aria-busy="true">
        <div className="models-page__loading">
          <Rotor size={14} spinning label="正在读模型设置" />
          <span>正在读模型设置</span>
        </div>
      </section>
    );
  }

  return (
    <section className="models-page">
      {showRouterBanner(state, healed) ? (
        <ErrorBanner
          message="路由没在跑，第三方模型用不了"
          detail={routerFailure ?? undefined}
          action={{ label: "重启路由", onClick: () => void restartRouter() }}
        />
      ) : null}

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
              onConfigure={() => openGateway(false)}
              onRestart={(row) => {
                const r = row.getBoundingClientRect();
                setConfirmRestart({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
              }}
              onRotorStopped={onRotorStopped}
              notice={notice}
              onCloseNotice={() => setNotice(null)}
              models={
                <ModelBox
                  tool={tool}
                  state={state}
                  open={picker?.toolId === tool.id}
                  busy={busy}
                  onToggleOpen={() =>
                    picker?.toolId === tool.id ? closePicker() : openPicker(tool)
                  }
                  onRemoveModel={removeModel}
                >
                  {picker?.toolId === tool.id ? (
                    <ModelPicker
                      tool={tool}
                      state={state}
                      busy={busy}
                      query={query}
                      onQuery={setQuery}
                      onToggleModel={toggleModel}
                      onManageGateways={() => openGateway(true)}
                      focusProviderId={picker.focusProviderId}
                      flashIds={picker.flashIds}
                      onClose={closePicker}
                    />
                  ) : null}
                </ModelBox>
              }
            />
          ))}
        </div>
      </div>

      {/* 会中断进行中的对话，确认一道（⑪ 确认只剩两件之一）；锚在那一行下面、那一行不被遮罩盖住 */}
      {confirmRestart !== null ? (
        <Confirm
          title={`重启 ${MODELS_TOOLS[0].name}？`}
          confirmLabel="重启"
          anchor={confirmRestart}
          onConfirm={() => void restart(MODELS_TOOLS[0])}
          onCancel={() => setConfirmRestart(null)}
        >
          {RESTART_CONSEQUENCE}
        </Confirm>
      ) : null}
    </section>
  );
}

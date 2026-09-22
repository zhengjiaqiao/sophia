import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.ts";
import {
  MODELS_TOOLS,
  effectiveModels,
  emptyEffectiveText,
  enableDisabledReason,
  factsLine,
  gatewaySummary,
  modelLabel,
  parseBackendError,
  providerCatalogHint,
  providerLabel,
  removeProviderBlockedReason,
  routerUnavailable,
  selectedModels,
  sortAndFilterModels,
  statusSentence,
  takeoverOfferText,
  totalSelected,
} from "./modelsView.ts";
import type { ModelsTool } from "./modelsView.ts";
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
  Empty,
  ErrorBanner,
  RowNotice,
  LegacyToast as Toast,
  Plain,
} from "./ui/index.ts";
import type { ToastKind } from "./ui/index.ts";
import { GatewayPage } from "./pages/GatewayPage.tsx";
import "./ModelsTab.css";

/// 模型页（spec `docs/specs/2026-09-21-ui-rebuild-models.md`）。
///
/// 它是应用的**启动页**，版面按 DESIGN.md「Layout」的大留白排，不是一张密排的表。
///
/// **按工具分块**（第二轮反馈）：一个工具一块，块里从上到下是
/// 「它是谁 → 它现在怎么样 → 它生效的模型 → 用它要知道的限制」，
/// 动作也归块——`重启 <工具>` 是那个工具的动作，不是页面的动作。
/// 今天 `MODELS_TOOLS` 里只有 Codex，但**版面、文案、空态都不写死一个工具**：
/// 名字一律从 `tool.name` 取。后端那侧现在确实只支持 Codex，这一轮只为多工具留位置。
///
/// **网关整个搬去配置页**（第三轮反馈）：一家一块的卡片、地址、有没有密钥、
/// 添加、删除、改名，全在 `pages/GatewayPage.tsx`。主页面只剩一句极简的网关事实
/// （`gatewaySummary`）当进配置页的由头。
///
/// 一屏要回答三件事：**这是什么工具**（图标 + 名字，display 28）、
/// **它现在生效的是哪几个模型**（紧凑片，就地可改）、
/// **哪里出了问题**（横幅 / 行内待办条 / 那句人话）。
///
/// 页面没有域的概念，所以壳在这一页不要渲染侧栏，见 `MODELS_TAB_FULL_BLEED`。
///
/// 六条形上的定死选择，改之前先回去看 spec：
/// - **图标永远和名字一起出现**（DESIGN §9.1）。第一轮只画了图标、把 `Codex`
///   这个名字吃掉了，是错的——图标是补充，不是替代
/// - **生效的模型在主页面直接可见，改选也在当前页完成**。这是我们和 cc-switch
///   那类工具的差异点：它必须进二级页才能挑模型，我们不进。二级页只管网关本身。
///   选择器横跨这个工具的全部网关，归属靠分组抬头 + 每条那行 `网关id-模型名` 的标识
/// - 开关是 ghost pill 两态（`启用` / 反色 `已启用`），不是滑动开关也不是复选框（R4）
/// - 模型列表的「已选」用 12px 方形复选框：**圆＝状态（只读事实），方＝选择（我选的）**（R3）
/// - 三组状态词合成一句人话 + 一行等宽事实，不并排三个徽标（R2）
/// - 按钮叫 `重启 <工具>`：实测 Codex 以 `codex app-server` 常驻进程跑着，启动时读一次
///   config.toml 之后不重读，所以改完配置确实要结束它。会中断进行中的对话，确认一道（R6 修订 v2）
///
/// 四条提示各有各的位置（R7）：`drift` 与 `takeover` 是挂在那个工具上的常驻待办，
/// 走行内待办条；`needsCodexRestart` 并进那句人话；`routerUnavailable` 是应用级故障，
/// 走顶栏之下的反色横幅；某次操作的结果走右下角提示条。
///
/// 数据一律读 `GatewayState.providers`（全部网关），**不读兼容字段 `provider`**
/// （docs/gateway-commands.md：「只给还没迁到 providers 的界面用」）。写也一样：
/// 勾选走 `gatewaySelectModelsOf`、存网关走 `gatewayUpsertProvider`、删走 `gatewayRemoveProvider`。

/// 模型页不分项目、不分域，左边那条侧栏对它没有意义：壳在这一页把整幅宽度交给它，
/// 页边 32px 由本页自己给（`.models-page` 的内边距）。App.tsx 用这个常量做条件。
export const MODELS_TAB_FULL_BLEED = true;

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

const selectedPayload = (models: GatewayProviderModel[]): GatewaySelectedModel[] =>
  models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName }));

// ===== 一个工具的抬头：它是谁，它现在怎么样 =====

export interface ToolIntroProps {
  tool: ModelsTool;
  state: GatewayState;
  selectedCount: number;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onRestart: () => void;
  /// 进网关配置页。网关的增删改都在那儿，主页面上不摊开（第三轮反馈）
  onConfigure: () => void;
  /// 生效的模型那一块，放在名字和动作之间——一行一个 agent（DESIGN「模型页」），
  /// 以后多 agent 时每个只能占一行，不能摊成「身份一块、模型一块」两段
  models?: ReactNode;
}

/**
 * 工具身份先出场，再谈状态。
 *
 * **图标永远和名字一起出现**（DESIGN §9.1，`tests/ui.test.ts` 也钉着这条）：
 * 图标 24px 在左，名字走 display 档在右。名字**不做大写转换**——display token 自带
 * `uppercase`，但「被谈论的对象一律不大写」（§1.2），`Codex` 不能变成 `CODEX`，
 * 所以这一处显式关掉它。这是这一页唯一一处偏离 token 默认值的地方。
 *
 * 「开着没有」由反色 pill 回答（DESIGN「用反色表示现在开着」）＋ 那句人话，
 * 不再另起一行 28px 的状态词——那会和开关说同一件事。
 *
 * 层级：28px 名字 → 15px 一句人话 → 12px 等宽事实，靠字号和行高拉开，不靠分隔线。
 */
export function ToolIntro({
  tool,
  state,
  selectedCount,
  busy,
  onEnable,
  onDisable,
  onRestart,
  onConfigure,
  models,
}: ToolIntroProps) {
  const disabledReason = enableDisabledReason(state, selectedCount);

  return (
    <header className="models-tool__intro">
      <div className="models-tool__head">
        <span className="models-tool__mark">
          <AgentIcon id={tool.id} name={tool.name} size={24} />
        </span>
        <h2 className="models-tool__name">{tool.name}</h2>

        <Busy busy={busy} className="models-tool__actions">
          {state.enabled ? (
            // 已启用＝反色 pill，点一下停用（DESIGN components.button-inverse）
            <Button
              variant="inverse"
              title={`点一下停用：${tool.name} 的模型列表只保留官方模型`}
              onClick={onDisable}
            >
              已启用
            </Button>
          ) : disabledReason !== null ? (
            <Button disabled disabledReason={disabledReason}>
              启用
            </Button>
          ) : (
            <Button onClick={onEnable}>启用</Button>
          )}

          {/* 那句人话里「改动要重启 <工具> 才生效」的动作就是它。它是**这个工具**
              的动作，所以归在这一块里，不放在页面级的位置上（R7、第二轮反馈） */}
          <Button title={`结束 ${tool.name} 的后台进程，下次启动就带着新配置`} onClick={onRestart}>
            {/* button-cap 自带 uppercase，会把 Codex 变成 CODEX。「重启」是我们写的
                结构词该大写，工具名是被谈论的对象不该大写（§1.2），所以名字单独
                裹一层把大写关掉 */}
            重启 <Plain>{tool.name}</Plain>
          </Button>

          {/* 网关的地址、密钥、增删改全在配置页；主页面只展示生效的模型（第三轮反馈） */}
          <Button title="添加、修改、删除网关" onClick={onConfigure}>
            配置网关
          </Button>
        </Busy>
      </div>

      {/* 卡片第二行：生效的模型（DESIGN「模型页」） */}
      {models ? <div className="models-tool__models">{models}</div> : null}

      {/* 卡片第三行：状态 + 等宽事实合成一句 */}
      <p className="models-tool__line">
        <span className="models-tool__sentence">{statusSentence(state, selectedCount, tool)}</span>
        <span className="models-tool__facts">
          {factsLine(state, tool)} · {gatewaySummary(state)}
        </span>
      </p>
    </header>
  );
}

// ===== 生效的模型 =====

export interface EffectiveModelsProps {
  tool: ModelsTool;
  state: GatewayState;
  busy: boolean;
  /// 点这块区域：打开选择器（**留在当前页**，不进二级页）
  onOpenPicker: () => void;
  onRemoveModel: (provider: GatewayProvider, model: GatewayProviderModel) => void;
  /// 一家网关都没有时，把人送去配置页
  onConfigure: () => void;
  /// 选择器浮层。挂在外层，浮层里的点击不会冒泡回去再把它打开
  children?: ReactNode;
}

/**
 * 主页面上唯一和模型有关的东西：**这个工具现在真正在用的那几个**。
 *
 * 网关本身（一家一块、地址、密钥、增删）第三轮搬去配置页了，主页面只剩
 * 身份 / 生效的模型 / 动作三样。但**改选仍然在这一页完成**——整块可点，
 * 点哪儿都开选择器。这是和 cc-switch 那类工具的差异点，不许退化成「进二级页选」。
 *
 * 片上的名字用 `effectiveModels` 算出来的 `label`：两家网关撞名时后端会加
 * 「 · 网关名」，这一块叫「生效的模型」，写的就得和工具里看到的一致。
 */
export function EffectiveModels({
  tool,
  state,
  busy,
  onOpenPicker,
  onRemoveModel,
  onConfigure,
  children,
}: EffectiveModelsProps) {
  // 一家网关都没有：这块区域点开也是空的，不如直接把人送去配置页
  if (state.providers.length === 0) {
    return (
      <div className="models-effective__empty">
        <Empty
          kind="noSkills"
          description={`还没有网关。到「配置网关」里加一家，它的模型才能进 ${tool.name} 的模型列表。`}
          primary={{ label: "配置网关", onClick: onConfigure }}
        />
      </div>
    );
  }

  const rows = effectiveModels(state);

  return (
    <div className="models-effective">
      <div
        className="models-effective__box"
        role="button"
        tabIndex={0}
        title="点一下改选模型"
        onClick={onOpenPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenPicker();
          }
        }}
      >
        {rows.length === 0 ? (
          // 空着的几种原因是几件不同的事，各说各的下一步
          <span className="models-effective__hint">{emptyEffectiveText(state)}</span>
        ) : (
          rows.map(({ provider, model, label }) => (
            <span key={`${provider.id}|${model.id}`} className="ss-model-chip">
              <span className="ss-model-chip__label" title={`来自网关 ${providerLabel(provider)}`}>
                {label}
              </span>
              <button
                type="button"
                className="ss-model-chip__remove"
                title={`把 ${label} 从 ${tool.name} 的模型列表里去掉`}
                disabled={busy}
                onClick={(e) => {
                  // 去掉这一个就是去掉这一个，别顺带把选择器也打开了
                  e.stopPropagation();
                  onRemoveModel(provider, model);
                }}
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  aria-hidden="true"
                >
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </span>
          ))
        )}
      </div>
      {children}
    </div>
  );
}

// ===== 页面 =====

export interface ModelsTabProps {
  onError: (message: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}

export default function ModelsTab({ onError, busy, onBusy }: ModelsTabProps) {
  const [state, setState] = useState<GatewayState | null>(null);
  /// 选择器开着的那个工具；null＝没开。一个工具一份，横跨它的全部网关
  const [pickerTool, setPickerTool] = useState<ModelsTool | null>(null);
  const [query, setQuery] = useState("");
  /// 改名在输入框里过渡，Enter / 失焦时提交；勾选当场写盘，所以只有改名需要本地镜像
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /// 网关配置页（二级页面，§4.6）：网关的增删改都在那儿，主页面不摊开
  const [gatewayOpen, setGatewayOpen] = useState(false);
  /// 结束工具的后台进程会中断进行中的对话，确认一道（R6、§5）。存的是要重启哪个工具
  const [confirmRestart, setConfirmRestart] = useState<ModelsTool | null>(null);
  /// 删网关会连钥匙串里的密钥一起删，回不来，确认一道。带上是哪个工具的，文案要点名
  const [confirmRemove, setConfirmRemove] = useState<{
    tool: ModelsTool;
    provider: GatewayProvider;
  } | null>(null);
  const [toast, setToast] = useState<{ kind: ToastKind; message: string } | null>(null);
  /// 行内待办条按「稍后」只在这一程里收起来，下次打开还会再提一次
  const [later, setLater] = useState<{ drift: boolean; takeover: boolean }>({
    drift: false,
    takeover: false,
  });
  /// 错误横幅不自动消失，只有用户自己关掉；路由恢复了就重新亮起来
  const [bannerClosed, setBannerClosed] = useState(false);
  const mounted = useRef(true);

  // 页面只认 providers；密钥从不回显，网关地址由配置页自己持有。
  const applyState = (next: GatewayState) => {
    setState(next);
    if (!routerUnavailable(next)) setBannerClosed(false);
  };

  const refresh = async () => {
    onBusy(true);
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch (error) {
      onError(describeError(error));
    } finally {
      onBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
    // 只在挂载时加载一次；后续操作各自刷新状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 菜单栏面板也能开关注入、重启 Codex：它改完会广播一声，这一页跟着重读
  useEffect(() => {
    const pending = listen("gateway-changed", () => void refresh());
    return () => {
      void pending.then((un) => un());
    };
    // refresh 只依赖稳定的回调与 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 浮层按 Esc 关掉，和二级页面一个手势
  useEffect(() => {
    if (pickerTool === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // closePicker 只写本地状态，不依赖别的东西
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerTool]);

  /// 大多数操作都是「调命令 → 用返回的最新状态刷新页面」。
  /// 成功汇总成一句话，做不成就把后端的原话摆出来——那是用户要拿去查的信息（§4.1）。
  const runAction = async (action: () => Promise<GatewayState>, success: string) => {
    onBusy(true);
    try {
      const next = await action();
      if (!mounted.current) return;
      applyState(next);
      setToast({ kind: "success", message: success });
    } catch (error) {
      if (mounted.current) setToast({ kind: "cannot", message: describeError(error) });
    } finally {
      onBusy(false);
    }
  };

  /// 配置页要自己就地说明失败，所以这一支把错误原样抛回去
  const runOrThrow = async (action: () => Promise<GatewayState>) => {
    onBusy(true);
    try {
      const next = await action();
      if (mounted.current) applyState(next);
    } finally {
      onBusy(false);
    }
  };

  /// 新建或改一家网关，返回这一家的 id（新建时由后端生成，配置页接着用它拉模型）
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

  /// 结束这个工具的后台进程。一个都没找到**不是失败**——下次启动照样带着新配置起来，
  /// 所以那一支也走 success 形态（R6、AC7′）。
  const restartTool = async (tool: ModelsTool) => {
    setConfirmRestart(null);
    onBusy(true);
    let done = false;
    try {
      const result = await api.gatewayRestartCodex();
      if (!mounted.current) return;
      done = true;
      setToast({
        kind: "success",
        message:
          result.terminated > 0
            ? `结束了 ${result.terminated} 个 ${tool.name} 进程，下次启动就是新配置`
            : `${tool.name} 现在没在跑，下次启动就是新配置`,
      });
    } catch (error) {
      if (mounted.current) setToast({ kind: "cannot", message: describeError(error) });
    } finally {
      onBusy(false);
    }
    // 进程没了之后 codex.running 与 needsCodexRestart 都会变，重读一次让那句人话跟上
    if (done && mounted.current) await refresh();
  };

  /// 写盘但不出成功提示条：浮层里每点一下就是一次操作，逐次弹提示条是噪音，
  /// 片的增减本身就是反馈；只有失败才说话
  const commitModels = async (provider: GatewayProvider, models: GatewayProviderModel[]) => {
    onBusy(true);
    try {
      const fresh = await api.gatewaySelectModelsOf(provider.id, selectedPayload(models));
      if (mounted.current) applyState(fresh);
    } catch (error) {
      // 写盘失败什么都不改：页面读的就是已落盘的那份，界面和文件不会对不上
      if (mounted.current) setToast({ kind: "cannot", message: describeError(error) });
    } finally {
      onBusy(false);
    }
  };

  /// 勾选当场生效
  const toggleModel = (provider: GatewayProvider, id: string) => {
    void commitModels(
      provider,
      provider.models.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)),
    );
  };

  const commitRename = (provider: GatewayProvider) => {
    const pending = renaming;
    setRenaming(null);
    if (pending === null) return;
    const before = provider.models.find((m) => m.id === pending.id);
    if (!before || before.displayName === pending.value) return;
    void commitModels(
      provider,
      provider.models.map((m) => (m.id === pending.id ? { ...m, displayName: pending.value } : m)),
    );
  };

  /// 关就是关，没有「未保存」这个状态——每一下都已经落盘了
  const closePicker = () => {
    setRenaming(null);
    setQuery("");
    setPickerTool(null);
  };

  /// 片上的 × ：当场移除，这一次有成功提示条（它是块上的一次明确操作）
  const removeModel = (
    tool: ModelsTool,
    provider: GatewayProvider,
    model: GatewayProviderModel,
  ) => {
    void runAction(
      () =>
        api.gatewaySelectModelsOf(
          provider.id,
          selectedPayload(
            provider.models.map((m) => (m.id === model.id ? { ...m, selected: false } : m)),
          ),
        ),
      `${tool.name} 的模型列表里去掉了 ${modelLabel(model)}`,
    );
  };

  const removeProvider = (provider: GatewayProvider) => {
    setConfirmRemove(null);
    setPickerTool(null);
    void runAction(
      () => api.gatewayRemoveProvider(provider.id),
      `${providerLabel(provider)} 删掉了，它的模型和密钥一起清掉了`,
    );
  };

  // 网关配置页：一整页管全部网关（列表 + 添加 + 每家可改可删）。
  // 删网关的确认弹窗留在这一层渲染——它是页面级的浮层，和配置页并排出现
  /// 删网关的确认弹窗。主视图和配置页都要能弹它（删的入口在配置页的列表上），
  /// 所以抽出来，两处各渲染一次。连钥匙串里的密钥一起删、回不来，
  /// 分量由信息承担，不涂红（§1.1）
  const removeConfirm = (current: GatewayState) => {
    if (confirmRemove === null) return null;
    const { tool, provider } = confirmRemove;
    const blocked = removeProviderBlockedReason(current, provider, tool);
    return (
      <Confirm
        title={`删掉 ${providerLabel(provider)}`}
        body="这家网关的地址、拉到的模型列表，以及钥匙串里的密钥会一起删掉。密钥删了取不回来，要用得重新填一次。"
        warning={
          <>
            <span className="models-page__mono">{provider.baseUrl}</span>
            <br />
            已选的 {selectedModels(provider).length} 个模型会从 {tool.name} 的模型列表里去掉
            {current.enabled ? `，${tool.name} 重启后生效` : ""}。
            {/* 后端会拒的那一种：把原因和下一步摆在眼前，不让用户按完才撞上 */}
            {blocked !== null ? (
              <>
                <br />
                {blocked}。
              </>
            ) : null}
          </>
        }
        confirmLabel="连密钥一起删掉"
        destructive
        confirmDisabledReason={blocked ?? undefined}
        onConfirm={() => removeProvider(provider)}
        onCancel={() => setConfirmRemove(null)}
      />
    );
  };

  if (gatewayOpen && state !== null) {
    return (
      <>
        <GatewayPage
          state={state}
          tool={MODELS_TOOLS[0]}
          busy={busy}
          onBack={() => setGatewayOpen(false)}
          onSave={saveProvider}
          onFetchModels={(id) => runOrThrow(() => api.gatewayFetchModelsOf(id))}
          onRemove={(provider) => setConfirmRemove({ tool: MODELS_TOOLS[0], provider })}
          onRestore={() => runOrThrow(() => api.gatewayRestore())}
        />
        {removeConfirm(state)}
        {toast ? (
          <Toast
            kind={toast.kind}
            message={toast.message}
            onDismiss={() => setToast(null)}
            onClose={() => setToast(null)}
          />
        ) : null}
      </>
    );
  }

  if (!state) return <Empty kind="scanning" description="读取中…" />;

  const selectedCount = totalSelected(state);
  const showBanner = routerUnavailable(state) && !bannerClosed;

  /**
   * 选择器浮层：**一个工具一份，横跨它的全部网关**。
   *
   * 网关卡片搬去配置页之后，原来「从某一家的模型区点开」这个入口没了，
   * 所以这里要能同时看到几家的模型，并且分得清归属（第三轮反馈）。归属靠两样：
   * 多于一家时每家一个分组抬头；每条模型下面那行等宽的标识本来就是
   * `网关id-模型名`（后端的 slug 规则），两家同名模型也不会看混。
   */
  const picker = (tool: ModelsTool) => {
    const groups = state.providers
      .map((provider) => ({ provider, models: sortAndFilterModels(provider.models, query) }))
      .filter((group) => group.models.length > 0);
    const anyModel = state.providers.some((provider) => provider.models.length > 0);
    // 只有一家时不画分组抬头——那行字在只有一家的时候纯属噪音
    const grouped = state.providers.length > 1;

    return (
      <>
        {/* 点浮层外面等于关闭；罩子透明，不遮挡下面那一块 */}
        <button
          type="button"
          className="models-picker__veil"
          aria-label="关闭模型选择"
          onClick={closePicker}
        />
        <div className="models-picker" role="dialog" aria-label="选模型">
          {/* 筛选输入框不受 busy 约束（§6） */}
          <div className="models-picker__search">
            <input
              type="search"
              className="models-picker__input"
              placeholder="筛选模型（可能有 100+ 个）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <Busy busy={busy} className="models-picker__list">
            {!anyModel ? (
              <Empty
                kind="noSkills"
                description="还没有可以选的模型——先到「配置网关」里存好地址和密钥，模型列表会跟着拉回来。"
                primary={{
                  label: "配置网关",
                  onClick: () => {
                    closePicker();
                    setGatewayOpen(true);
                  },
                }}
              />
            ) : groups.length === 0 ? (
              <Empty
                kind="noMatch"
                description="没有匹配的模型。"
                secondary={{ label: "清除筛选", onClick: () => setQuery("") }}
              />
            ) : (
              <ul className="models-list">
                {groups.map(({ provider, models }) => (
                  <li key={provider.id}>
                    {grouped ? (
                      <div className="models-group">
                        {/* 网关名是被谈论的对象，不大写（§1.2） */}
                        <span className="models-group__name">{providerLabel(provider)}</span>
                        <span className="models-group__count">{providerCatalogHint(provider)}</span>
                      </div>
                    ) : null}
                    <ul className="models-list">
                      {models.map((m) => (
                        <li
                          key={m.id}
                          className={
                            renaming?.id === m.id ? "models-item is-renaming" : "models-item"
                          }
                          // 整行可点：12px 的记号只告诉你点了会发生什么，命中区是整行（DESIGN「命中区」）
                          onClick={() => renaming?.id !== m.id && toggleModel(provider, m.id)}
                        >
                          {/* 12px 方形复选框：方＝选择，与状态点的圆分得开（R3） */}
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={m.selected}
                            className="models-item__check"
                            title={
                              m.selected
                                ? `点一下，不再把 ${modelLabel(m)} 放进 ${tool.name} 的列表`
                                : `点一下，把 ${modelLabel(m)} 放进 ${tool.name} 的列表`
                            }
                          >
                            {m.selected ? (
                              <svg
                                width="8"
                                height="8"
                                viewBox="0 0 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                aria-hidden="true"
                              >
                                <path d="M2 5.2l2 2 4-4.4" />
                              </svg>
                            ) : null}
                          </button>

                          <div className="models-item__text">
                            {renaming?.id === m.id ? (
                              <input
                                type="text"
                                className="models-item__rename"
                                value={renaming.value}
                                autoFocus
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setRenaming({ id: m.id, value: e.target.value })}
                                onBlur={() => commitRename(provider)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    commitRename(provider);
                                  } else if (e.key === "Escape") {
                                    // Esc 先被输入框吃掉，不要顺带把浮层也关了；改名作废
                                    e.stopPropagation();
                                    setRenaming(null);
                                  }
                                }}
                              />
                            ) : (
                              <div className="models-item__name">{modelLabel(m)}</div>
                            )}
                            {/* 标识是 `网关id-模型名`，既是标识符也是归属，走等宽（§1.2） */}
                            <div className="models-item__id">{m.slug || m.id}</div>
                          </div>

                          {m.selected ? (
                            renaming?.id === m.id ? (
                              <span className="models-item__hint">
                                {tool.name} 列表里显示这个名字
                              </span>
                            ) : (
                              // Button 的 onClick 不带事件；用外层挡住冒泡，别让「改名」顺带切换勾选
                              <span onClick={(e) => e.stopPropagation()}>
                                <Button
                                  variant="link"
                                  onClick={() => setRenaming({ id: m.id, value: modelLabel(m) })}
                                >
                                  改名
                                </Button>
                              </span>
                            )
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Busy>

          <div className="models-picker__foot">
            <span className="models-picker__count">已选 {selectedCount} 个模型</span>
          </div>
        </div>
      </>
    );
  };

  return (
    <section className="models-page">
      {/* 应用级故障：已启用但路由没在跑，官方模型也会受影响（R7、§4.2） */}
      {showBanner ? (
        <ErrorBanner
          message={state.router.error || "本机路由没在跑，这会儿连官方模型也用不了。"}
          onClose={() => setBannerClosed(true)}
        />
      ) : null}

      <div className="models-page__body">
        {/* 一个工具一块。今天 MODELS_TOOLS 里只有一个，但版面不假设只有一个：
            后端那侧现在也只支持 Codex，所以每一块共用同一份 state；等后端按工具
            分开，改的是这里传什么 state，块里的东西一个都不用动 */}
        <ul className="models-tools">
          {MODELS_TOOLS.map((tool) => (
            <li key={tool.id} className="models-tool">
              <ToolIntro
                tool={tool}
                state={state}
                selectedCount={selectedCount}
                busy={busy}
                models={
                  <EffectiveModels
                    tool={tool}
                    state={state}
                    busy={busy}
                    onOpenPicker={() => {
                      setQuery("");
                      setRenaming(null);
                      setPickerTool(tool);
                    }}
                    onRemoveModel={(provider, model) => removeModel(tool, provider, model)}
                    onConfigure={() => setGatewayOpen(true)}
                  >
                    {pickerTool?.id === tool.id ? picker(tool) : null}
                  </EffectiveModels>
                }
                onEnable={() =>
                  void runAction(
                    () => api.gatewayEnable(),
                    `${selectedCount} 个模型进了 ${tool.name} 的模型列表，要重启 ${tool.name} 才看得到`,
                  )
                }
                onDisable={() =>
                  void runAction(
                    () => api.gatewayRestore(),
                    `已经停用，${tool.name} 的模型列表只剩官方模型；要重启 ${tool.name} 才看得到`,
                  )
                }
                onRestart={() => setConfirmRestart(tool)}
                onConfigure={() => setGatewayOpen(true)}
              />

              {/* 常驻待办挂在这个工具上，动作就在右边（R7、§4.4） */}
              {state.codex.drift && !later.drift ? (
                <div className="models-tool__notice">
                  <RowNotice
                    message={
                      <>
                        {tool.name} 升到{" "}
                        <span className="models-page__mono">{state.codex.version}</span>{" "}
                        之后，模型列表要重新生成一次才对得上。
                      </>
                    }
                    actions={[
                      {
                        label: "重新生成",
                        onClick: () =>
                          void runAction(
                            () => api.gatewayEnable(),
                            `模型列表重新生成好了，要重启 ${tool.name} 才看得到`,
                          ),
                      },
                    ]}
                    onLater={() => setLater((c) => ({ ...c, drift: true }))}
                  />
                </div>
              ) : null}

              {state.takeover !== null && !later.takeover ? (
                <div className="models-tool__notice">
                  <RowNotice
                    message={`${takeoverOfferText(state.takeover)}。接过来会把网关地址、已选模型和密钥原样带过来，并撤下 agents-manager 的后台服务与文件。`}
                    actions={[
                      {
                        label: "接管",
                        onClick: () =>
                          void runAction(
                            () => api.gatewayTakeover(),
                            `接过来了，网关地址、已选模型和密钥都在；要重启 ${tool.name} 才看得到`,
                          ),
                      },
                    ]}
                    onLater={() => setLater((c) => ({ ...c, takeover: true }))}
                  />
                </div>
              ) : null}

              {/* 主页面上只剩「生效的模型」这一块：网关的增删改搬去配置页了（第三轮反馈）。
                  改选仍然在这一页完成，整块可点——不许退化成「进二级页选」 */}
            </li>
          ))}
        </ul>
      </div>

      {/* 会中断进行中的对话，所以确认一道（R6、§5 四处确认之一） */}
      {confirmRestart !== null ? (
        <Confirm
          title={`重启 ${confirmRestart.name}`}
          body={`会结束正在运行的 ${confirmRestart.name} 后台进程，进行中的对话会中断。下次用 ${confirmRestart.name} 时会带着新配置起来。`}
          confirmLabel="重启"
          onConfirm={() => void restartTool(confirmRestart)}
          onCancel={() => setConfirmRestart(null)}
        />
      ) : null}

      {removeConfirm(state)}

      {toast ? (
        <Toast
          kind={toast.kind}
          message={toast.message}
          onDismiss={() => setToast(null)}
          onClose={() => setToast(null)}
        />
      ) : null}
    </section>
  );
}

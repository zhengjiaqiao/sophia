import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.ts";
import {
  enableDisabledReason,
  factsLine,
  headline,
  modelLabel,
  parseBackendError,
  providerFacts,
  providerLabel,
  removeProviderBlockedReason,
  routerUnavailable,
  selectedModels,
  sortAndFilterModels,
  statusSentence,
  takeoverOfferText,
  totalSelected,
} from "./modelsView.ts";
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
  StateDot,
  Toast,
} from "./ui/index.ts";
import type { ToastKind } from "./ui/index.ts";
import { GatewayPage } from "./pages/GatewayPage.tsx";
import "./ModelsTab.css";

/// 模型页（spec `docs/specs/2026-09-21-ui-rebuild-models.md`）。
///
/// 它是应用的**启动页**：打开应用第一眼看到的就是这一屏，所以版面按
/// DESIGN.md「Layout」的大留白来排，而不是一张密排的表——
/// 28px display 的结论 → 一句人话 → 一行等宽事实 → 48px 之后才是网关清单。
///
/// 一屏要回答三件事：**第三方模型现在开着没有**（大字）、**Codex 现在用的是哪几个模型**
/// （网关块里的紧凑片）、**哪里出了问题**（横幅 / 行内待办条 / 缺密钥的方标签）。
///
/// 页面没有域的概念，所以壳在这一页不要渲染侧栏，见 `MODELS_TAB_FULL_BLEED`。
///
/// 五条形上的定死选择，改之前先回去看 spec：
/// - 开关是 ghost pill 两态（`启用` / 反色 `已启用`），不是滑动开关也不是复选框（R4）
/// - 模型列表的「已选」用 12px 方形复选框：**圆＝状态（只读事实），方＝选择（我选的）**（R3）
/// - 三组状态词合成一句人话 + 一行等宽事实，不并排三个徽标（R2）
/// - 已选模型区是**一整块可点的区域**，点哪儿都打开选择器；片是紧凑片、不反色——
///   它们是事实不是正在选的东西。不给「改选模型」单独一个链接（R1 修订 v2）
/// - 按钮叫 `重启 Codex`：实测 Codex 以 `codex app-server` 常驻进程跑着，启动时读一次
///   config.toml 之后不重读，所以改完配置确实要结束它。会中断进行中的对话，确认一道（R6 修订 v2）
///
/// 四条提示各有各的位置（R7）：`drift` 与 `takeover` 是挂在这一页上的常驻待办，
/// 走行内待办条；`needsCodexRestart` 并进那句人话；`routerUnavailable` 是应用级故障，
/// 走顶栏之下的反色横幅；某次操作的结果走右下角提示条。
///
/// 数据一律读 `GatewayState.providers`（全部网关），**不读兼容字段 `provider`**
/// （docs/gateway-commands.md：「只给还没迁到 providers 的界面用」）。写也一样：
/// 勾选走 `gatewaySelectModelsOf`、存网关走 `gatewayUpsertProvider`、删走 `gatewayRemoveProvider`。

/// 模型页不分项目、不分域，左边那条侧栏对它没有意义：壳在这一页把整幅宽度交给它，
/// 页边 32px 由本页自己给（`.models-page` 的内边距）。App.tsx 用这个常量做条件。
export const MODELS_TAB_FULL_BLEED = true;

/// 已知限制：这段是事实，不是某次操作的结果，所以常驻在页面上不随操作消失（R8）
const LIMITATIONS =
  "Codex 仍会用官方模型生成会话标题，第一条消息会发给官方；自动审阅在第三方会话里用不了；网页搜索这类工具在第三方模型上也用不了。";

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

const selectedPayload = (models: GatewayProviderModel[]): GatewaySelectedModel[] =>
  models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName }));

/// 二级页面：`providerId` 为 null 表示新加一家网关
type SubPage = { providerId: string | null };

// ===== 启动页的那一屏大字 =====

export interface ModelsHeroProps {
  state: GatewayState;
  selectedCount: number;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onRestartCodex: () => void;
}

/**
 * 第一眼的层级跳跃（DESIGN「Typography → 层级」）：12px 的区域标签、28px 的结论、
 * 15px 的一句人话、12px 等宽的事实。四行之间靠字号和行高拉开，不靠分隔线。
 */
export function ModelsHero({
  state,
  selectedCount,
  busy,
  onEnable,
  onDisable,
  onRestartCodex,
}: ModelsHeroProps) {
  const disabledReason = enableDisabledReason(state, selectedCount);

  return (
    <header className="models-hero">
      <span className="models-page__label">第三方模型</span>
      <div className="models-hero__line">
        <span className="models-hero__mark">
          <AgentIcon id="codex" name="Codex" size={24} />
        </span>
        {/* 一眼回答「开着没有」。agent 是谁由图标、那句人话和等宽事实行一起说，
            不在这行大字上重复——display 是大写档，而 agent 名不该大写（§1.2） */}
        <h2 className="models-hero__state">{headline(state)}</h2>
      </div>
      <p className="models-hero__sentence">{statusSentence(state, selectedCount)}</p>
      {/* 版本号与端口是计数类事实，走等宽（§1.2） */}
      <p className="models-hero__facts">{factsLine(state)}</p>

      <Busy busy={busy} className="models-hero__actions">
        {state.enabled ? (
          // 已启用＝反色 pill，点一下停用（DESIGN components.button-inverse）
          <Button
            variant="inverse"
            title="点一下停用：Codex 的模型列表只保留官方模型"
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

        {/* 那句人话里「改动要重启 Codex 才生效」的动作就是它（R7） */}
        <Button title="结束 Codex 的后台进程，下次启动就带着新配置" onClick={onRestartCodex}>
          重启 Codex
        </Button>
      </Busy>
    </header>
  );
}

// ===== 一家网关一块 =====

export interface GatewayCardProps {
  provider: GatewayProvider;
  busy: boolean;
  /// 点已选模型区：打开这一家的选择器
  onOpenPicker: () => void;
  onRemoveModel: (model: GatewayProviderModel) => void;
  onConfigure: () => void;
  onRemove: () => void;
  /// 选择器浮层。挂在这一层上，浮层里的点击不会冒泡回去再把它打开
  children?: ReactNode;
}

/**
 * 一家网关：状态点 + 名字 + 地址与计数 + 已选模型区 + 两个动作。
 *
 * 圆点是**只读状态**（钥匙串里有没有这家的密钥），和模型列表里方形复选框的
 * 「我的选择」分得开（DESIGN §2 / R3）。缺密钥另给一个零圆角方标签——
 * 方标签不可点，圆角只留给可点的东西（§1.3）。
 */
export function GatewayCard({
  provider,
  busy,
  onOpenPicker,
  onRemoveModel,
  onConfigure,
  onRemove,
  children,
}: GatewayCardProps) {
  const picked = selectedModels(provider);

  return (
    <div className="models-card">
      <div className="models-card__head">
        <StateDot
          dot={provider.hasKey ? "linked" : "missing"}
          title={
            provider.hasKey ? "密钥已经存在钥匙串里" : "还没有密钥，到「配置」里填上才能拉模型"
          }
        />
        <span className="models-card__name">{providerLabel(provider)}</span>
        {provider.hasKey ? null : <span className="models-tag">还没有密钥</span>}
        <Busy busy={busy} className="models-card__actions">
          <Button size="compact" onClick={onConfigure}>
            配置
          </Button>
          <Button size="compact" onClick={onRemove}>
            删掉
          </Button>
        </Busy>
      </div>

      {/* 地址与计数都是事实，同一行等宽（§1.2） */}
      <div className="models-card__facts">
        <span className="models-card__url" title={provider.baseUrl}>
          {provider.baseUrl || "还没填地址"}
        </span>
        <span className="models-card__count">{providerFacts(provider)}</span>
      </div>

      <div className="models-card__pick">
        {/* 已选模型是一整块可点的区域，点哪儿都打开选择器（R1 修订 v2） */}
        <div
          className="models-card__models"
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
          {picked.length === 0 ? (
            <span className="models-card__empty">还没选模型</span>
          ) : (
            picked.map((m) => (
              <span key={m.id} className="ss-model-chip">
                <span className="ss-model-chip__label">{modelLabel(m)}</span>
                <button
                  type="button"
                  className="ss-model-chip__remove"
                  title={`把 ${modelLabel(m)} 从 Codex 的模型列表里去掉`}
                  disabled={busy}
                  onClick={(e) => {
                    // 去掉这一个就是去掉这一个，别顺带把选择器也打开了
                    e.stopPropagation();
                    onRemoveModel(m);
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
  /// 打开着选择器的那一家网关的 id；null＝没开
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /// 改名在输入框里过渡，Enter / 失焦时提交；勾选当场写盘，所以只有改名需要本地镜像
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /// 二级页面（§4.6）：null＝主视图
  const [subPage, setSubPage] = useState<SubPage | null>(null);
  /// 结束 Codex 进程会中断进行中的对话，确认一道（R6、§5）
  const [confirmRestart, setConfirmRestart] = useState(false);
  /// 删网关会连钥匙串里的密钥一起删，回不来，确认一道
  const [confirmRemove, setConfirmRemove] = useState<GatewayProvider | null>(null);
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
    if (pickerId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // closePicker 只写本地状态，不依赖别的东西
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerId]);

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

  /// 结束 Codex 的后台进程。一个都没找到**不是失败**——下次启动照样带着新配置起来，
  /// 所以那一支也走 success 形态（R6、AC7′）。
  const restartCodex = async () => {
    setConfirmRestart(false);
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
            ? `结束了 ${result.terminated} 个 Codex 进程，下次启动就是新配置`
            : "Codex 现在没在跑，下次启动就是新配置",
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
    setPickerId(null);
  };

  /// 片上的 × ：当场移除，这一次有成功提示条（它是行上的一次明确操作）
  const removeModel = (provider: GatewayProvider, model: GatewayProviderModel) => {
    void runAction(
      () =>
        api.gatewaySelectModelsOf(
          provider.id,
          selectedPayload(
            provider.models.map((m) => (m.id === model.id ? { ...m, selected: false } : m)),
          ),
        ),
      `Codex 的模型列表里去掉了 ${modelLabel(model)}`,
    );
  };

  const removeProvider = (provider: GatewayProvider) => {
    setConfirmRemove(null);
    setSubPage(null);
    setPickerId(null);
    void runAction(
      () => api.gatewayRemoveProvider(provider.id),
      `${providerLabel(provider)} 删掉了，它的模型和密钥一起清掉了`,
    );
  };

  if (subPage !== null && state !== null) {
    const editing =
      subPage.providerId === null
        ? null
        : (state.providers.find((p) => p.id === subPage.providerId) ?? null);
    // 要改的那一家还在，或者本来就是新建，才渲染配置页；被别处删掉了就落回主视图
    if (editing !== null || subPage.providerId === null) {
      return (
        <GatewayPage
          state={state}
          provider={editing}
          busy={busy}
          onBack={() => setSubPage(null)}
          onSave={saveProvider}
          onFetchModels={(id) => runOrThrow(() => api.gatewayFetchModelsOf(id))}
          onRestore={() => runOrThrow(() => api.gatewayRestore())}
        />
      );
    }
  }

  if (!state) return <Empty kind="scanning" description="读取中…" />;

  const selectedCount = totalSelected(state);
  const showBanner = routerUnavailable(state) && !bannerClosed;

  /// 选择器浮层：一家一份，挂在那一家的已选模型区下面
  const picker = (provider: GatewayProvider) => {
    const visibleModels = sortAndFilterModels(provider.models, query);
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
            {provider.models.length === 0 ? (
              <Empty
                kind="noSkills"
                description="还没有可以选的模型——先到「配置」里存好网关和密钥，再拉一次模型列表。"
                primary={{
                  label: "去配置",
                  onClick: () => {
                    closePicker();
                    setSubPage({ providerId: provider.id });
                  },
                }}
              />
            ) : visibleModels.length === 0 ? (
              <Empty
                kind="noMatch"
                description="没有匹配的模型。"
                secondary={{ label: "清除筛选", onClick: () => setQuery("") }}
              />
            ) : (
              <ul className="models-list">
                {visibleModels.map((m) => (
                  <li
                    key={m.id}
                    className={renaming?.id === m.id ? "models-item is-renaming" : "models-item"}
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
                          ? `点一下，不再把 ${modelLabel(m)} 放进 Codex 的列表`
                          : `点一下，把 ${modelLabel(m)} 放进 Codex 的列表`
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
                      {/* 模型标识带网关前缀，是标识符，走等宽（§1.2） */}
                      <div className="models-item__id">{m.slug || m.id}</div>
                    </div>

                    {m.selected ? (
                      renaming?.id === m.id ? (
                        <span className="models-item__hint">Codex 列表里显示这个名字</span>
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
            )}
          </Busy>

          <div className="models-picker__foot">
            <span className="models-picker__count">
              已选 {selectedModels(provider).length} 个模型
            </span>
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
        <ModelsHero
          state={state}
          selectedCount={selectedCount}
          busy={busy}
          onEnable={() =>
            void runAction(
              () => api.gatewayEnable(),
              `${selectedCount} 个模型进了 Codex 的模型列表，要重启 Codex 才看得到`,
            )
          }
          onDisable={() =>
            void runAction(
              () => api.gatewayRestore(),
              "已经停用，Codex 的模型列表只剩官方模型；要重启 Codex 才看得到",
            )
          }
          onRestartCodex={() => setConfirmRestart(true)}
        />

        {/* 常驻待办挂在这一屏上，动作就在右边（R7、§4.4） */}
        {state.codex.drift && !later.drift ? (
          <div className="models-page__notice">
            <RowNotice
              message={
                <>
                  Codex 升到 <span className="models-page__mono">{state.codex.version}</span>{" "}
                  之后，模型列表要重新生成一次才对得上。
                </>
              }
              actions={[
                {
                  label: "重新生成",
                  onClick: () =>
                    void runAction(
                      () => api.gatewayEnable(),
                      "模型列表重新生成好了，要重启 Codex 才看得到",
                    ),
                },
              ]}
              onLater={() => setLater((c) => ({ ...c, drift: true }))}
            />
          </div>
        ) : null}

        {state.takeover !== null && !later.takeover ? (
          <div className="models-page__notice">
            <RowNotice
              message={`${takeoverOfferText(state.takeover)}。接过来会把网关地址、已选模型和密钥原样带过来，并撤下 agents-manager 的后台服务与文件。`}
              actions={[
                {
                  label: "接管",
                  onClick: () =>
                    void runAction(
                      () => api.gatewayTakeover(),
                      "接过来了，网关地址、已选模型和密钥都在；要重启 Codex 才看得到",
                    ),
                },
              ]}
              onLater={() => setLater((c) => ({ ...c, takeover: true }))}
            />
          </div>
        ) : null}

        {/* 网关区：一家一块，上面一条 ink 分隔（DESIGN 靠分隔线分区，不靠嵌套的框） */}
        <section className="models-section">
          <div className="models-section__head">
            <span className="models-page__label">网关</span>
            <span className="models-page__note">勾选的模型会出现在 Codex 自己的模型列表里</span>
            <Busy busy={busy} className="models-section__action">
              <Button size="compact" onClick={() => setSubPage({ providerId: null })}>
                添加网关
              </Button>
            </Busy>
          </div>

          {state.providers.length === 0 ? (
            <div className="models-section__empty">
              <Empty
                kind="noSkills"
                description="还没有网关。填上地址和密钥，它的模型就能进 Codex 的模型列表。"
                primary={{ label: "添加网关", onClick: () => setSubPage({ providerId: null }) }}
              />
            </div>
          ) : (
            <ul className="models-cards">
              {state.providers.map((provider) => (
                <li key={provider.id}>
                  <GatewayCard
                    provider={provider}
                    busy={busy}
                    onOpenPicker={() => {
                      setQuery("");
                      setRenaming(null);
                      setPickerId(provider.id);
                    }}
                    onRemoveModel={(model) => removeModel(provider, model)}
                    onConfigure={() => setSubPage({ providerId: provider.id })}
                    onRemove={() => setConfirmRemove(provider)}
                  >
                    {pickerId === provider.id ? picker(provider) : null}
                  </GatewayCard>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 限制说明是事实，不是某次操作的结果，常驻（R8） */}
        <div className="models-page__limits">
          <span className="models-page__label">用第三方模型要知道的</span>
          <p className="models-page__limits-text">{LIMITATIONS}</p>
        </div>
      </div>

      {/* 会中断进行中的对话，所以确认一道（R6、§5 四处确认之一） */}
      {confirmRestart ? (
        <Confirm
          title="重启 Codex"
          body="会结束正在运行的 Codex 后台进程，进行中的对话会中断。下次用 Codex 时会带着新配置起来。"
          confirmLabel="重启"
          onConfirm={() => void restartCodex()}
          onCancel={() => setConfirmRestart(false)}
        />
      ) : null}

      {/* 删网关连钥匙串里的密钥一起删，回不来。分量由信息承担，不涂红（§1.1） */}
      {confirmRemove !== null ? (
        <Confirm
          title={`删掉 ${providerLabel(confirmRemove)}`}
          body="这家网关的地址、拉到的模型列表，以及钥匙串里的密钥会一起删掉。密钥删了取不回来，要用得重新填一次。"
          warning={
            <>
              <span className="models-page__mono">{confirmRemove.baseUrl}</span>
              <br />
              已选的 {selectedModels(confirmRemove).length} 个模型会从 Codex 的模型列表里去掉
              {state.enabled ? "，Codex 重启后生效" : ""}。
              {/* 后端会拒的那一种：把原因和下一步摆在眼前，不让用户按完才撞上 */}
              {removeProviderBlockedReason(state, confirmRemove) !== null ? (
                <>
                  <br />
                  {removeProviderBlockedReason(state, confirmRemove)}。
                </>
              ) : null}
            </>
          }
          confirmLabel="连密钥一起删掉"
          destructive
          confirmDisabledReason={removeProviderBlockedReason(state, confirmRemove) ?? undefined}
          onConfirm={() => removeProvider(confirmRemove)}
          onCancel={() => setConfirmRemove(null)}
        />
      ) : null}

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

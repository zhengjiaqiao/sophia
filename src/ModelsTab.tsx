import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  enableDisabledReason,
  factsLine,
  parseBackendError,
  routerUnavailable,
  sortAndFilterModels,
  statusSentence,
  takeoverOfferText,
} from "./modelsView";
import type { GatewayProviderModel, GatewayState, GatewaySelectedModel } from "./types";
import { AgentIcon, Busy, Button, Confirm, Empty, ErrorBanner, RowNotice, Toast } from "./ui";
import type { ToastKind } from "./ui";
import { GatewayPage } from "./pages/GatewayPage";
import "./ModelsTab.css";

/// 模型页（spec `docs/specs/2026-09-21-ui-rebuild-models.md`）。
///
/// 一行一个 agent，当前选的模型就在行里；页面没有域的概念，所以不渲染侧栏内容，
/// 顶栏之下直接通栏。按「可以有多个 agent」搭，尽管现在只有 Codex。
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
/// 四条提示各有各的位置（R7）：`drift` 与 `takeover` 是挂在这一行上的常驻待办，
/// 走行内待办条；`needsCodexRestart` 并进副行；`routerUnavailable` 是应用级故障，
/// 走顶栏之下的反色横幅；某次操作的结果走右下角提示条。

/// 已知限制：这段是事实，不是某次操作的结果，所以常驻在页面上不随操作消失（R8）
const LIMITATIONS =
  "Codex 仍会用官方模型生成会话标题，第一条消息会发给官方；自动审阅在第三方会话里用不了；网页搜索这类工具在第三方模型上也用不了。";

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

/// 列表里显示的名字：用户改过的显示名 > 网关给的 slug > 原始 id
const modelLabel = (model: GatewayProviderModel): string =>
  model.displayName || model.slug || model.id;

const selectedPayload = (models: GatewayProviderModel[]): GatewaySelectedModel[] =>
  models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName }));

export interface ModelsTabProps {
  onError: (message: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}

export default function ModelsTab({ onError, busy, onBusy }: ModelsTabProps) {
  const [state, setState] = useState<GatewayState | null>(null);
  /// 浮层里正在显示的那份模型列表。勾选当场写盘（DESIGN「什么时候才有按钮」），
  /// 这里只是写盘前后的本地镜像；改名在输入框里过渡，Enter / 失焦时提交
  const [models, setModels] = useState<GatewayProviderModel[]>([]);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /// 二级页面（§4.6）：null＝主视图
  const [subPage, setSubPage] = useState<null | "gateway">(null);
  /// 结束 Codex 进程会中断进行中的对话，确认一道（R6、§5）
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [toast, setToast] = useState<{ kind: ToastKind; message: string } | null>(null);
  /// 行内待办条按「稍后」只在这一程里收起来，下次打开还会再提一次
  const [later, setLater] = useState<{ drift: boolean; takeover: boolean }>({
    drift: false,
    takeover: false,
  });
  /// 错误横幅不自动消失，只有用户自己关掉；路由恢复了就重新亮起来
  const [bannerClosed, setBannerClosed] = useState(false);
  const mounted = useRef(true);

  // 模型列表跟随最近一次读到的状态；密钥从不回显，网关地址由配置页自己持有。
  const applyState = (next: GatewayState) => {
    setState(next);
    setModels(next.provider.models);
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

  // 浮层按 Esc 关掉，和二级页面一个手势
  useEffect(() => {
    if (!pickerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // closePicker 只读 state.provider.models，随 state 变化重新绑定即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen, state]);

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
    // 进程没了之后 codex.running 与 needsCodexRestart 都会变，重读一次让副行跟上
    if (done && mounted.current) await refresh();
  };

  /// 写盘但不出成功提示条：浮层里每点一下就是一次操作，逐次弹提示条是噪音，
  /// 行上片的增减本身就是反馈；只有失败才说话
  const commit = async (next: GatewayProviderModel[]) => {
    onBusy(true);
    try {
      const fresh = await api.gatewaySelectModels(selectedPayload(next));
      if (mounted.current) applyState(fresh);
    } catch (error) {
      if (mounted.current) {
        setToast({ kind: "cannot", message: describeError(error) });
        // 写盘失败就把本地镜像退回已落盘的那份，别让界面和文件对不上
        setModels(state?.provider.models ?? []);
      }
    } finally {
      onBusy(false);
    }
  };

  /// 勾选当场生效
  const toggleModel = (id: string) => {
    const next = models.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m));
    setModels(next);
    void commit(next);
  };
  /// 改名只改本地镜像，Enter / 失焦时提交
  const renameModel = (id: string, displayName: string) => {
    setModels((current) => current.map((m) => (m.id === id ? { ...m, displayName } : m)));
  };
  const commitRename = () => {
    setRenamingId(null);
    void commit(models);
  };

  /// 关就是关，没有「未保存」这个状态——每一下都已经落盘了
  const closePicker = () => {
    setRenamingId(null);
    setQuery("");
    setPickerOpen(false);
  };

  /// 行上片的 × ：当场移除
  const saveModels = async (next: GatewayProviderModel[], success: string) => {
    await runAction(() => api.gatewaySelectModels(selectedPayload(next)), success);
  };

  if (subPage === "gateway" && state !== null) {
    return (
      <GatewayPage
        state={state}
        busy={busy}
        onBack={() => setSubPage(null)}
        onSaveProvider={(baseUrl, key) => runOrThrow(() => api.gatewaySaveProvider(baseUrl, key))}
        onFetchModels={() => runOrThrow(() => api.gatewayFetchModels())}
        onRestore={() => runOrThrow(() => api.gatewayRestore())}
      />
    );
  }

  if (!state) return <Empty kind="scanning" description="读取中…" />;

  const selected = models.filter((m) => m.selected);
  const selectedCount = selected.length;
  const visibleModels = sortAndFilterModels(models, query);
  const disabledReason = enableDisabledReason(state, selectedCount);
  const showBanner = routerUnavailable(state) && !bannerClosed;

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
        <div className="models-page__head">
          <span className="models-page__label">支持第三方模型的 agent</span>
          <span className="models-page__note">选中的模型会出现在这个 agent 自己的模型列表里</span>
        </div>

        <div className="models-row">
          <div className="models-row__main">
            {/* 左：图标 + 名字（不大写，agent 名是被谈论的对象）+ 一句人话 + 一行等宽事实 */}
            <div className="models-row__identity">
              <div className="models-row__name">
                <AgentIcon id="codex" name="Codex" />
                <span className="models-row__title">Codex</span>
              </div>
              <div className="models-row__status">{statusSentence(state, selectedCount)}</div>
              <div className="models-row__facts">{factsLine(state)}</div>
            </div>

            {/* 中：已选模型是一整块可点的区域，里面是紧凑片、不反色（R1 修订 v2） */}
            <div className="models-row__pick">
              <div
                className="models-row__models"
                role="button"
                tabIndex={0}
                title="点一下改选模型"
                onClick={() => setPickerOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPickerOpen(true);
                  }
                }}
              >
                {selectedCount === 0 ? (
                  <span className="models-row__empty">还没选模型</span>
                ) : (
                  selected.map((m) => (
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
                          void saveModels(
                            models.map((x) => (x.id === m.id ? { ...x, selected: false } : x)),
                            `Codex 的模型列表里去掉了 ${modelLabel(m)}`,
                          );
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

              {pickerOpen ? (
                <>
                  {/* 点浮层外面等于关闭；罩子透明，不遮挡下面那一行 */}
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
                      {models.length === 0 ? (
                        <Empty
                          kind="noSkills"
                          description="还没有可以选的模型——先到「配置」里存好网关和密钥，再拉一次模型列表。"
                          primary={{
                            label: "去配置",
                            onClick: () => {
                              setPickerOpen(false);
                              setSubPage("gateway");
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
                              className={
                                renamingId === m.id ? "models-item is-renaming" : "models-item"
                              }
                              // 整行可点：12px 的记号只告诉你点了会发生什么，命中区是整行（DESIGN「命中区」）
                              onClick={() => renamingId !== m.id && toggleModel(m.id)}
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
                                {renamingId === m.id ? (
                                  <input
                                    type="text"
                                    className="models-item__rename"
                                    value={m.displayName}
                                    autoFocus
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => renameModel(m.id, e.target.value)}
                                    onBlur={commitRename}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.stopPropagation();
                                        commitRename();
                                      } else if (e.key === "Escape") {
                                        // Esc 先被输入框吃掉，不要顺带把浮层也关了；改名作废
                                        e.stopPropagation();
                                        setModels(state?.provider.models ?? []);
                                        setRenamingId(null);
                                      }
                                    }}
                                  />
                                ) : (
                                  <div className="models-item__name">{modelLabel(m)}</div>
                                )}
                                {/* 模型 id 是标识符，走等宽（§1.2） */}
                                <div className="models-item__id">{m.slug || m.id}</div>
                              </div>

                              {m.selected ? (
                                renamingId === m.id ? (
                                  <span className="models-item__hint">
                                    Codex 列表里显示这个名字
                                  </span>
                                ) : (
                                  // Button 的 onClick 不带事件；用外层挡住冒泡，别让「改名」顺带切换勾选
                                  <span onClick={(e) => e.stopPropagation()}>
                                    <Button variant="link" onClick={() => setRenamingId(m.id)}>
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
                      <span className="models-picker__count">已选 {selectedCount} 个模型</span>
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            {/* 右：配置 · 开关 · 重启 Codex */}
            <Busy busy={busy} className="models-row__actions">
              <Button size="compact" onClick={() => setSubPage("gateway")}>
                配置
              </Button>

              {state.enabled ? (
                // 已启用＝反色 pill，点一下停用（§3 只有 ghost pill 一种形，反色是它的选中态）
                <button
                  type="button"
                  className="ss-btn ss-btn--compact models-pill--on"
                  title="点一下停用：Codex 的模型列表只保留官方模型"
                  onClick={() =>
                    void runAction(
                      () => api.gatewayRestore(),
                      "已经停用，Codex 的模型列表只剩官方模型；要重启 Codex 才看得到",
                    )
                  }
                >
                  已启用
                </button>
              ) : disabledReason !== null ? (
                <Button size="compact" disabled disabledReason={disabledReason}>
                  启用
                </Button>
              ) : (
                <Button
                  size="compact"
                  onClick={() =>
                    void runAction(
                      () => api.gatewayEnable(),
                      `${selectedCount} 个模型进了 Codex 的模型列表，要重启 Codex 才看得到`,
                    )
                  }
                >
                  启用
                </Button>
              )}

              {/* 副行里那句「改动要重启 Codex 才生效」的动作就是它（R7） */}
              <Button
                size="compact"
                title="结束 Codex 的后台进程，下次启动就带着新配置"
                onClick={() => setConfirmRestart(true)}
              >
                重启 Codex
              </Button>
            </Busy>
          </div>

          {/* 常驻待办挂在这一行下面，动作就在右边（R7、§4.4） */}
          {state.codex.drift && !later.drift ? (
            <div className="models-row__notice">
              <RowNotice
                message={
                  <>
                    Codex 升到 <span className="models-row__mono">{state.codex.version}</span>{" "}
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
            <div className="models-row__notice">
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
        </div>

        {/* 限制说明是事实，不是某次操作的结果，常驻（R8） */}
        <div className="models-page__limits">
          <span className="models-page__label">用第三方模型要知道的</span>
          <p className="models-page__limits-text">{LIMITATIONS}</p>
        </div>
      </div>

      {/* 会中断进行中的对话，所以确认一道（R6、§5 三处确认之一） */}
      {confirmRestart ? (
        <Confirm
          title="重启 Codex"
          body="会结束正在运行的 Codex 后台进程，进行中的对话会中断。下次用 Codex 时会带着新配置起来。"
          confirmLabel="重启"
          onConfirm={() => void restartCodex()}
          onCancel={() => setConfirmRestart(false)}
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

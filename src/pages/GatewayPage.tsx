import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  choiceAfterCancel,
  gatewayChips,
  parseBackendError,
  providerLabel,
  removeProviderBlockedReason,
  selectedModels,
  switchNeedsConfirm,
  unsavedText,
} from "../modelsView.ts";
import type { ModelsTool } from "../modelsView.ts";
import type { GatewayProvider, GatewayState } from "../types.ts";
import {
  BlackNotice,
  Button,
  Chip,
  Confirm,
  IconButton,
  IconPlus,
  IconTrash,
  Spinner,
  SubPage,
  Tooltip,
} from "../ui/index.ts";
import type { ConfirmAnchor } from "../ui/index.ts";
import { ModelList } from "../ModelList.tsx";
import "./GatewayPage.css";

/// 网关配置二级页 `Codex 的网关`（DESIGN「网关配置是二级页」，画板 v84 Gateway）。
///
/// 与设置 / 添加 / 待处理同一「← 标题」骨架；模型页的 `配置网关`、模型下拉里的 `管理网关 ›` /
/// `还没有网关 · + 网关 ›` 都进这一页。转场：从右侧推入、返回滑回，200ms 机械缓动，
/// reduced-motion 即时（⑦ 动效解释空间关系）。页头标题后按状态出现 `重启生效`（与模型页同组件）。
///
/// 两处都能选模型，同一份状态：这一页勾上的回到模型页已在框里，下拉里去掉的这一页同步取消——
/// 两边都读 ModelsTab 持有的同一个 GatewayState。

/// 转场时长，与 GatewayPage.css 同值
export const GATEWAY_PAGE_MOTION_MS = 200;

export interface GatewayPageProps extends Omit<
  GatewayBodyProps,
  "askDiscard" | "onCollapse" | "onDirtyChange"
> {
  /// 页头标题后的 `重启生效`（ModelsTab 传同一个 RestartSlot）
  headerAction?: ReactNode;
  /// 返回滑回的那 200ms：播退场动画，播完由 ModelsTab 卸掉
  leaving: boolean;
  /// 真正离开（没有未保存的改动，或已保存 / 丢弃）
  onLeave: () => void;
  /// 页面里有确认框开着时，Esc 归确认框，不当返回
  modalOpen?: boolean;
  /// 页面上的浮层（重启确认框）：必须渲染在二级页里面，主视图此时 inert
  overlay?: ReactNode;
}

export function GatewayPage({
  headerAction,
  leaving,
  onLeave,
  modalOpen,
  overlay,
  ...body
}: GatewayPageProps) {
  const [dirty, setDirty] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const onDirtyChange = useCallback((next: boolean) => {
    setDirty(next);
    if (!next) setAskDiscard(false);
  }, []);

  /// 点 ← 或 Esc：连接区有没保存的改动就拦下，段内就地问一句（⑪⑫）
  const back = () => {
    // 确认框开着（重启确认、删网关确认）：Esc 归确认框，不当返回
    if (modalOpen || leaving || document.querySelector(".ss-confirm")) return;
    if (dirty) setAskDiscard(true);
    else onLeave();
  };

  return (
    <SubPage
      className={`gw-page-sub${leaving ? " is-leaving" : ""}`}
      title={
        <span className="gw-page__title">
          {body.tool.name} 的网关
          {headerAction}
        </span>
      }
      onBack={back}
    >
      <div className="gw-page">
        <GatewayBody
          {...body}
          onDirtyChange={onDirtyChange}
          askDiscard={askDiscard}
          onCollapse={() => {
            setAskDiscard(false);
            setDirty(false);
            onLeave();
          }}
        />
      </div>
      {/* 页面里的浮层（重启确认）也要在二级页里：主视图打开二级页期间是 inert 的 */}
      {overlay}
    </SubPage>
  );
}

/// 协议的只读读法：本机路由收 Responses，转给网关时说它的协议
function protocolText(protocol: string | undefined): string {
  if (protocol === "chat") return "Responses → Chat Completions";
  if (protocol === "responses") return "Responses";
  return "拉模型时探明";
}

/// 选中的是哪一家；"new" 是新加的那一家（直接出表单）
export type { GatewayChoice as GatewaySelection } from "../modelsView.ts";
import type { GatewayChoice as GatewaySelection } from "../modelsView.ts";

export interface GatewayBodyProps {
  tool: ModelsTool;
  state: GatewayState;
  busy: boolean;
  /// 打开时先选中哪一家；"new" 直接出新网关的表单
  initial: GatewaySelection | null;
  /// 存网关地址与密钥（密钥省略表示不改），返回这一家的 id。失败时抛出原话
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  /// 保存之后拉一次模型列表（保存即拉取）
  onFetchModels: (providerId: string) => Promise<void>;
  /// 「再试一次」：按 id 重拉（拉取失败不抛错，原因记在 unreachable 上）
  onRetry: (providerId: string) => Promise<void>;
  /// 删掉这一家（地址与钥匙串里的密钥一起删，找不回）：确认之后才调。失败时抛出原话
  onRemove: (provider: GatewayProvider) => Promise<void>;
  onToggleModel: (provider: GatewayProvider, modelId: string) => void;
  /// 连接区有没有没保存的改动：离开时要先问
  onDirtyChange: (dirty: boolean) => void;
  /// 想离开但连接区还有改动：就地一句「地址改动没保存」+ 保存 / 丢弃
  askDiscard: boolean;
  /// 丢弃或保存完，真正离开
  onCollapse: () => void;
  /// 从待处理页跳回来定位的那一家：它的分段片用 surface 带闪两下
  flashProviderId?: string | null;
}

/// 删网关的确认：删的是哪一家、锚在哪（垃圾桶所在的那一行）
interface ConfirmingRemove {
  provider: GatewayProvider;
  anchor: ConfirmAnchor;
}

/**
 * 三段，自上而下逐层按需（单列，与设置页同宽，没有右栏）：
 * - 网关切换：分段片 `ap-gateway 103 · openrouter 连不上 · + 网关`，选中反色
 * - 连接：已连上的只一行摘要 `https://… · 已连 · 编辑` + 垃圾桶；点 `编辑` 才出地址 / 密钥表单，
 *   保存才生效、保存即拉取，保存中原位细弧 +「正在拉模型」；新加网关直接出表单；
 *   连不上：`连不上` + 8 `再试一次`；删网关：锚在垃圾桶旁的确认「删掉 X？」，确认后直接删
 *   （地址与钥匙串里的密钥一起删、找不回，按 ⑪ 要确认；不再有撤销提示条）
 * - 从这个网关选模型：段头下是限制说明，与模型下拉同一组件，只列本网关的模型；
 *   首次在这里选：新加网关保存成功拉到模型后这一段原地出现，新模型各闪一次
 */
export function GatewayBody({
  tool,
  state,
  busy,
  initial,
  onSave,
  onFetchModels,
  onRetry,
  onRemove,
  onToggleModel,
  onDirtyChange,
  askDiscard,
  onCollapse,
  flashProviderId,
}: GatewayBodyProps) {
  const first = state.providers[0]?.id ?? "new";
  const [selected, setSelected] = useState<GatewaySelection>(initial ?? first);
  const [editing, setEditing] = useState(initial === "new" || first === "new");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmingRemove | null>(null);
  const [error, setError] = useState<string | null>(null);
  /// 新拉到的模型各闪一次：保存 / 再试之前记下已有的，state 更新后差出来
  const [pendingFlash, setPendingFlash] = useState<{ id: string; before: Set<string> } | null>(
    null,
  );
  const [flashKeys, setFlashKeys] = useState<string[]>([]);
  /// 点 `+ 网关` 之前选中的那一家：取消草稿时回到它
  const [previous, setPrevious] = useState<GatewaySelection | null>(null);
  /// 连接区有没保存的改动（这一层也要知道：换一家之前先问）
  const [formDirty, setFormDirty] = useState(false);
  /// 草稿 / 改动没保存时点了别的分段片：就地问「保存 / 丢弃」，问完换到这一家
  const [switchTo, setSwitchTo] = useState<GatewaySelection | null>(null);
  const trackDirty = useCallback(
    (dirty: boolean) => {
      setFormDirty(dirty);
      if (!dirty) setSwitchTo(null);
      onDirtyChange(dirty);
    },
    [onDirtyChange],
  );

  // 选中的那一家消失了（被删、外部变化）：退到第一家
  const current = selected === "new" ? null : state.providers.find((p) => p.id === selected);
  /// 刚保存成功的那一家：父层的新状态可能晚一拍才到，这期间不当它「消失了」
  const justSaved = useRef<string | null>(null);
  useEffect(() => {
    if (current !== undefined && current !== null) justSaved.current = null;
    if (selected === justSaved.current) return;
    if (selected !== "new" && current === undefined) {
      setSelected(state.providers[0]?.id ?? "new");
      setEditing(state.providers.length === 0);
    }
  }, [selected, current, state.providers]);

  useEffect(() => {
    if (pendingFlash === null) return;
    const provider = state.providers.find((p) => p.id === pendingFlash.id);
    if (!provider) return;
    setFlashKeys(
      provider.models
        .filter((m) => !pendingFlash.before.has(m.id))
        .map((m) => `${provider.id}|${m.id}`),
    );
    setPendingFlash(null);
  }, [state, pendingFlash]);

  const report = (e: unknown) => setError(parseBackendError(String(e)).message);

  /// 点垃圾桶：先问一句。垃圾桶所在的那一行整行抬到遮罩之上（⑦），确认框右沿对齐垃圾桶
  const askRemove = (provider: GatewayProvider, trash: HTMLElement) => {
    const row = trash.closest(".gw-panel__summary") ?? trash;
    const r = row.getBoundingClientRect();
    const t = trash.getBoundingClientRect();
    setConfirming({
      provider,
      anchor: { top: r.top, bottom: r.bottom, left: r.left, right: Math.max(r.right, t.right) },
    });
  };

  /// 确认之后直接删；这一家从分段片里消失，选中落到剩下的第一家
  const remove = (provider: GatewayProvider) =>
    void (async () => {
      setConfirming(null);
      try {
        await onRemove(provider);
      } catch (e) {
        report(e);
        return;
      }
      const next = state.providers.find((p) => p.id !== provider.id);
      setSelected(next?.id ?? "new");
      setEditing(next === undefined);
    })();

  const retry = (id: string) =>
    void (async () => {
      setRetrying(id);
      const provider = state.providers.find((p) => p.id === id);
      const before = new Set(provider?.models.map((m) => m.id) ?? []);
      try {
        await onRetry(id);
        setPendingFlash({ id, before });
      } catch (e) {
        report(e);
      } finally {
        setRetrying(null);
      }
    })();

  /// 真正换过去（已确认没有要丢的改动）
  const switchTo_ = (next: GatewaySelection) => {
    setError(null);
    setSwitchTo(null);
    if (next === "new" && selected !== "new") setPrevious(selected);
    setSelected(next);
    setEditing(next === "new");
  };

  /// 点分段片：有没保存的改动就拦下就地问，不静默丢掉
  const choose = (next: GatewaySelection) => {
    if (switchNeedsConfirm(selected, next, formDirty)) setSwitchTo(next);
    else switchTo_(next);
  };

  const chips = gatewayChips(
    state.providers.map((p) => p.id),
    selected,
  );

  return (
    <div className="gw-panel">
      <div className="gw-panel__top">
        <div className="gw-panel__chips" role="tablist" aria-label={`${tool.name} 的网关`}>
          {chips.map((chip) => {
            if (chip.kind === "draft") {
              // `+ 网关` 原位变成的草稿片：选中反色；草稿在时不再有 `+ 网关`
              return (
                <Chip key="draft" selected onClick={() => undefined}>
                  新网关
                </Chip>
              );
            }
            if (chip.kind === "add") {
              return (
                <Chip
                  key="add"
                  icon={<IconPlus size={12} />}
                  onClick={() => choose("new")}
                  title="添加网关"
                >
                  网关
                </Chip>
              );
            }
            const p = state.providers.find((x) => x.id === chip.id) as GatewayProvider;
            return (
              // 包一层给跳回定位的闪烁用：surface 带围在片外，选中反色的片上也看得见
              <span
                key={p.id}
                className={`gw-panel__chipwrap${flashProviderId === p.id ? " is-jump" : ""}`}
              >
                <Chip selected={selected === p.id} onClick={() => choose(p.id)}>
                  <span className="gw-panel__chip-name">{providerLabel(p)}</span>
                  {p.unreachable ? (
                    <span className="gw-panel__chip-down">连不上</span>
                  ) : p.models.length > 0 ? (
                    <span className="gw-panel__chip-count">{p.models.length}</span>
                  ) : null}
                </Chip>
              </span>
            );
          })}
        </div>

        {editing || selected === "new" ? (
          <GatewayForm
            key={selected}
            state={state}
            provider={current ?? null}
            busy={busy}
            onSave={async (input) => {
              const before = new Set(current?.models.map((m) => m.id) ?? []);
              const id = await onSave(input);
              setPendingFlash({ id, before });
              return id;
            }}
            onFetchModels={onFetchModels}
            onSaved={(id) => {
              // 草稿片换成真实那一家（名称 + 模型数），`+ 网关` 重新出现；选模型段原地出现
              justSaved.current = id;
              setSelected(id);
              setEditing(false);
            }}
            onCancel={() => {
              trackDirty(false);
              // 取消草稿：「新网关」变回「+ 网关」，回到之前选中的那一家
              if (selected === "new") {
                switchTo_(
                  choiceAfterCancel(
                    previous,
                    state.providers.map((p) => p.id),
                  ),
                );
              } else setEditing(false);
            }}
            onDirtyChange={trackDirty}
            ask={
              switchTo !== null
                ? { text: unsavedText(selected), onDone: () => switchTo_(switchTo) }
                : askDiscard
                  ? { text: unsavedText(selected), onDone: onCollapse }
                  : null
            }
            canCancel={selected !== "new" || state.providers.length > 0}
          />
        ) : current ? (
          <div className="gw-panel__summary">
            <Tooltip content={current.baseUrl || "还没填地址"}>
              <span className="gw-panel__url">{current.baseUrl || "还没填地址"}</span>
            </Tooltip>
            <span className="gw-panel__sep">·</span>
            {current.unreachable ? (
              <>
                <Tooltip content={current.unreachable}>
                  <span className="gw-panel__down">连不上</span>
                </Tooltip>
                {retrying === current.id ? (
                  <span className="gw-panel__busy">
                    <Spinner size={14} label="正在重连" />
                    正在重连
                  </span>
                ) : (
                  <Button size="compact" onClick={() => retry(current.id)}>
                    再试一次
                  </Button>
                )}
              </>
            ) : (
              <span className="gw-panel__state">{current.hasKey ? "已连" : "还没有密钥"}</span>
            )}
            {current.unreachable ? null : <span className="gw-panel__sep">·</span>}
            <Button variant="link" onClick={() => setEditing(true)}>
              编辑
            </Button>
            <span className="gw-panel__trash">
              {removeProviderBlockedReason(state, current, tool) === null ? (
                <IconButton
                  icon={<IconTrash />}
                  title={`删掉 ${providerLabel(current)}`}
                  onClick={() => {
                    // 摘要行只有一个垃圾桶（当前这一家）
                    const el = document.querySelector<HTMLElement>(".gw-panel__trash");
                    if (el) askRemove(current, el);
                  }}
                />
              ) : (
                // 最后一家还在供模型：后端会拒，键上就说清下一步。禁用的键接不到悬停，
                // 提示框挂在包层上（css 让禁用键不吃指针）
                <Tooltip
                  content={`${tool.name} 还在用它的 ${selectedModels(current).length} 个模型，先取消勾选再删`}
                  focusable
                >
                  <IconButton
                    icon={<IconTrash />}
                    title={`删掉 ${providerLabel(current)}`}
                    disabledReason={`${tool.name} 还在用它的 ${selectedModels(current).length} 个模型，先取消勾选再删`}
                  />
                </Tooltip>
              )}
            </span>
          </div>
        ) : null}

        {error !== null ? (
          <div className="gw-panel__error">
            <BlackNotice message={error} />
          </div>
        ) : null}

        {/* 删网关：地址与钥匙串里的密钥一起删、找不回——二次确认（⑪） */}
        {confirming !== null ? (
          <Confirm
            title={`删掉 ${providerLabel(confirming.provider)}？`}
            confirmLabel="删掉"
            anchor={confirming.anchor}
            align="end"
            onConfirm={() => remove(confirming.provider)}
            onCancel={() => setConfirming(null)}
          >
            地址和钥匙串里的密钥一起删掉，删了找不回来
          </Confirm>
        ) : null}
      </div>

      <div className="gw-panel__models">
        {current && current.models.length > 0 && !editing ? (
          <>
            <div className="gw-panel__section">从这个网关选模型</div>
            <div className="gw-panel__note">{tool.pickerNote}</div>
            <div className="gw-panel__list">
              <ModelList
                // 换一家网关就是「重新打开」这份列表：重排一次序
                key={current.id}
                entries={current.models.map((model) => ({ provider: current, model }))}
                busy={busy}
                onToggle={onToggleModel}
                flashKeys={flashKeys}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface GatewayFormProps {
  state: GatewayState;
  /// 要改的那一家；null＝新加一家
  provider: GatewayProvider | null;
  busy: boolean;
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  onFetchModels: (providerId: string) => Promise<void>;
  onSaved: (providerId: string) => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /// 离开页面或换一家时连接区还有改动：就地一句 + 保存 / 丢弃，问完做 `onDone`
  ask: { text: string; onDone: () => void } | null;
  /// 一家都没有时新网关的表单没有「取消」可退
  canCancel: boolean;
}

/// 地址为空时的「保存」：禁用，提示框「先填地址」（禁用键接不到悬停，提示框挂在包层上）
function BlankSave() {
  return (
    <span className="gw-form__save">
      <Tooltip content="先填地址" focusable>
        <Button variant="primary" disabled disabledReason="先填地址">
          保存
        </Button>
      </Tooltip>
    </span>
  );
}

/// 连接表单：地址与密钥。保存才生效、保存即拉取；保存中原位细弧 +「正在拉模型」
function GatewayForm({
  state,
  provider,
  busy,
  onSave,
  onFetchModels,
  onSaved,
  onCancel,
  onDirtyChange,
  ask,
  canCancel,
}: GatewayFormProps) {
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasKey = provider?.hasKey ?? false;
  const dirty = baseUrl.trim() !== (provider?.baseUrl ?? "") || apiKey !== "";

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  // 卸载（收起、换一家）时不再算有改动
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  /**
   * 保存即拉取：带了密钥时后端存之前就先向网关校验、成功时顺手拉回模型列表，不拉第二遍；
   * 只改了地址、用已存的密钥那一支才自己拉一次。第二步失败不否定第一步已成功，那句话两件事都说
   */
  const save = async (): Promise<boolean> => {
    const key = apiKey;
    setSaving(true);
    let id: string;
    try {
      id = await onSave({
        id: provider?.id,
        baseUrl: baseUrl.trim(),
        key: key === "" ? undefined : key,
      });
    } catch (e) {
      setSaving(false);
      setError(parseBackendError(String(e)).message);
      return false;
    }
    if (key === "" && hasKey) {
      try {
        await onFetchModels(id);
      } catch (e) {
        setSaving(false);
        setError(`已保存，但模型列表没拉下来：${parseBackendError(String(e)).message}`);
        return false;
      }
    }
    setSaving(false);
    setError(null);
    setApiKey("");
    onDirtyChange(false);
    onSaved(id);
    return true;
  };

  const blank = baseUrl.trim() === "";

  return (
    <div className="gw-form">
      <label className="gw-form__field">
        <span className="gw-form__label">地址</span>
        <input
          className="gw-form__input"
          type="text"
          value={baseUrl}
          autoFocus={provider === null}
          placeholder="https://example.com/openai/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="gw-form__field">
        <span className="gw-form__label">密钥</span>
        <input
          className="gw-form__input"
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={hasKey ? "已保存，留空则不改" : "输入密钥"}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div className="gw-form__actions">
        {ask !== null ? (
          // 离开 / 换一家时连接区有未保存的改动：不走，就地问一句（⑪⑫）；同一个组件
          <>
            <span className="gw-form__ask">{ask.text}</span>
            {blank ? (
              <BlankSave />
            ) : (
              <Button
                variant="primary"
                onClick={() => void save().then((ok) => ok && ask.onDone())}
              >
                保存
              </Button>
            )}
            <Button
              variant="link"
              onClick={() => {
                onDirtyChange(false);
                ask.onDone();
              }}
            >
              丢弃
            </Button>
          </>
        ) : saving ? (
          <span className="gw-form__busy" role="status">
            <Spinner size={14} label="正在拉模型" />
            正在拉模型
          </span>
        ) : blank ? (
          <BlankSave />
        ) : busy ? (
          <Button variant="primary" disabled disabledReason="正在处理上一步">
            保存
          </Button>
        ) : (
          <Tooltip content="存好就去网关拉一次模型列表">
            <Button variant="primary" onClick={() => void save()}>
              保存
            </Button>
          </Tooltip>
        )}
        {ask === null && canCancel ? (
          <Button variant="link" onClick={onCancel}>
            取消
          </Button>
        ) : null}
      </div>
      {error !== null ? (
        <div className="gw-form__error">
          <BlackNotice message={error} />
        </div>
      ) : null}
      {/* 只读事实：端口与协议不做成可改 */}
      <dl className="gw-form__facts">
        <dt>本机端口</dt>
        <dd>{state.router.port}</dd>
        <dt>协议</dt>
        <dd>{protocolText(provider?.protocol)}</dd>
      </dl>
    </div>
  );
}

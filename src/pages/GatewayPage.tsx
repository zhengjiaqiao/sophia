import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  parseBackendError,
  providerLabel,
  removeProviderBlockedReason,
  selectedModels,
} from "../modelsView.ts";
import type { ModelsTool } from "../modelsView.ts";
import type { GatewayProvider, GatewayState } from "../types.ts";
import {
  BlackNotice,
  Button,
  Chip,
  IconButton,
  IconPlus,
  IconTrash,
  Spinner,
  SubPage,
  Toast,
  Tooltip,
} from "../ui/index.ts";
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
}

export function GatewayPage({
  headerAction,
  leaving,
  onLeave,
  modalOpen,
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
    if (modalOpen || leaving) return;
    if (dirty) setAskDiscard(true);
    else onLeave();
  };

  return (
    <div className={`gw-page-shell${leaving ? " is-leaving" : ""}`}>
      <SubPage
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
      </SubPage>
    </div>
  );
}

/// 删网关的撤销窗口：提示条停留这么久，到期才真正删
const REMOVE_UNDO_MS = 8000;

/// 协议的只读读法：本机路由收 Responses，转给网关时说它的协议
function protocolText(protocol: string | undefined): string {
  if (protocol === "chat") return "Responses → Chat Completions";
  if (protocol === "responses") return "Responses";
  return "拉模型时探明";
}

/// 选中的是哪一家；"new" 是新加的那一家（直接出表单）
export type GatewaySelection = string | "new";

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
  /// 删网关第一步：只标记，这一家从 state 里消失；配置与密钥都还在
  onMarkRemove: (provider: GatewayProvider) => Promise<void>;
  onUndoRemove: (providerId: string) => Promise<void>;
  /// 真正删掉这一家（提示条到期或关掉）
  onCommitRemoval: (providerId: string) => Promise<void>;
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

interface Removing {
  provider: GatewayProvider;
}

/**
 * 三段，自上而下逐层按需（单列，与设置页同宽，没有右栏）：
 * - 网关切换：分段片 `ap-gateway 103 · openrouter 连不上 · + 网关`，选中反色
 * - 连接：已连上的只一行摘要 `https://… · 已连 · 改` + 垃圾桶；点 `改` 才出地址 / 密钥表单，
 *   保存才生效、保存即拉取，保存中原位细弧 +「正在拉模型」；新加网关直接出表单；
 *   连不上：`连不上` + 8 `再试一次`；删网关：就地提示条 `删掉 X · 撤销`（延迟提交）
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
  onMarkRemove,
  onUndoRemove,
  onCommitRemoval,
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
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [error, setError] = useState<string | null>(null);
  /// 新拉到的模型各闪一次：保存 / 再试之前记下已有的，state 更新后差出来
  const [pendingFlash, setPendingFlash] = useState<{ id: string; before: Set<string> } | null>(
    null,
  );
  const [flashKeys, setFlashKeys] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 选中的那一家消失了（被删、被撤销之外的外部变化）：退到第一家
  const current = selected === "new" ? null : state.providers.find((p) => p.id === selected);
  useEffect(() => {
    if (selected !== "new" && current === undefined && removing?.provider.id !== selected) {
      setSelected(state.providers[0]?.id ?? "new");
      setEditing(state.providers.length === 0);
    }
  }, [selected, current, removing, state.providers]);

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

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const report = (e: unknown) => setError(parseBackendError(String(e)).message);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const commitRemoving = (id: string) => {
    clearTimer();
    setRemoving((prev) => (prev?.provider.id === id ? null : prev));
    void onCommitRemoval(id).catch(report);
  };

  const remove = (provider: GatewayProvider) =>
    void (async () => {
      // 上一家还在撤销窗口里：它让位，先真正删掉
      if (removing !== null) commitRemoving(removing.provider.id);
      try {
        await onMarkRemove(provider);
      } catch (e) {
        report(e);
        return;
      }
      setRemoving({ provider });
      const next = state.providers.find((p) => p.id !== provider.id);
      setSelected(next?.id ?? "new");
      setEditing(next === undefined);
      clearTimer();
      timer.current = setTimeout(() => commitRemoving(provider.id), REMOVE_UNDO_MS);
    })();

  const undoRemove = () =>
    void (async () => {
      if (removing === null) return;
      clearTimer();
      const id = removing.provider.id;
      setRemoving(null);
      try {
        await onUndoRemove(id);
        setSelected(id);
        setEditing(false);
      } catch (e) {
        report(e);
      }
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

  const choose = (next: GatewaySelection) => {
    setError(null);
    setSelected(next);
    setEditing(next === "new");
  };

  return (
    <div className="gw-panel">
      <div className="gw-panel__top">
        <div className="gw-panel__chips" role="tablist" aria-label={`${tool.name} 的网关`}>
          {state.providers.map((p) => (
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
          ))}
          {selected === "new" ? (
            <Chip selected onClick={() => undefined}>
              新网关
            </Chip>
          ) : null}
          <Chip icon={<IconPlus size={12} />} onClick={() => choose("new")} title="添加网关">
            网关
          </Chip>
        </div>

        {removing !== null ? (
          <div className="gw-panel__notice">
            <Toast
              kind="success"
              verb="删掉"
              names={[providerLabel(removing.provider)]}
              action={{ label: "撤销", onClick: undoRemove }}
              onClose={() => commitRemoving(removing.provider.id)}
            />
          </div>
        ) : null}

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
              setSelected(id);
              setEditing(false);
            }}
            onCancel={() => {
              if (selected === "new") choose(state.providers[0]?.id ?? "new");
              else setEditing(false);
              onDirtyChange(false);
            }}
            onDirtyChange={onDirtyChange}
            askDiscard={askDiscard}
            onCollapse={onCollapse}
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
              改
            </Button>
            <span className="gw-panel__trash">
              {removeProviderBlockedReason(state, current, tool) === null ? (
                <IconButton
                  icon={<IconTrash />}
                  title={`删掉 ${providerLabel(current)}`}
                  onClick={() => remove(current)}
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
      </div>

      <div className="gw-panel__models">
        {current && current.models.length > 0 && !editing ? (
          <>
            <div className="gw-panel__section">从这个网关选模型</div>
            <div className="gw-panel__note">{tool.pickerNote}</div>
            <div className="gw-panel__list">
              <ModelList
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
  askDiscard: boolean;
  onCollapse: () => void;
  /// 一家都没有时新网关的表单没有「取消」可退
  canCancel: boolean;
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
  askDiscard,
  onCollapse,
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
        {askDiscard ? (
          // 收起时连接区有未保存的改动：不收起，就地问一句（⑪⑫）
          <>
            <span className="gw-form__ask">地址改动没保存</span>
            {blank ? (
              <Button variant="primary" disabled disabledReason="先填上网关地址">
                保存
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void save().then((ok) => ok && onCollapse())}
              >
                保存
              </Button>
            )}
            <Button
              variant="link"
              onClick={() => {
                onDirtyChange(false);
                onCollapse();
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
          <Button variant="primary" disabled disabledReason="先填上网关地址">
            保存
          </Button>
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
        {!askDiscard && canCancel ? (
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

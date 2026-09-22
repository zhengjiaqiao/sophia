import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import {
  canRestore,
  parseBackendError,
  providerLabel,
  removeProviderBlockedReason,
} from "../modelsView.ts";
import type { ModelsTool } from "../modelsView.ts";
import type { GatewayProvider, GatewayState } from "../types.ts";
import {
  AddButton,
  BlackNotice,
  Busy,
  Button,
  Empty,
  ErrorBanner,
  IconButton,
  IconChevronRight,
  IconEdit,
  IconTrash,
  Spinner,
  SubPage,
  Tag,
  Toast,
} from "../ui/index.ts";
import "./GatewayPage.css";

/// 网关页 `Codex 的网关`（DESIGN「产品裁决 › 模型页 › 网关配置页」，画板 Gateway）：
/// 二级页面，**左右两栏画在同一页**——左：已连的网关（面板：表头底 2px、行 hairline）；
/// 右：表单（添加 / 改时出现），竖线从页头底一直接到窗底。
///
/// 一行 = 名字 + 地址（等宽 ink-faint）｜模型数｜铅笔、垃圾桶。
/// - 某一家连不上是**那一行的状态**：名字后强标签 `连不上`，紧跟 8 `再试一次`，模型数 `—`
///   （修复长在状态旁边，不加顶部横幅）
/// - 保存成功拉到模型后，读数是 `103 个模型 · 选模型 ›`：点了回到模型页、展开下拉、滚到这一家
///   （不自动跳走——用户可能连加第二个网关，⑬）
/// - **删网关不确认**（⑪）：行立即消失，就地黑窗提示条 `删掉 X · 撤销`；提示条消失（8 秒）
///   或离开网关页时才真正删配置与钥匙串密钥，撤销则原样恢复（后端延迟提交，T4c）
///
/// 限制说明（第三方模型只支持文本对话与工具调用）**不在这一页**：它只在挑模型时有用，
/// 放在模型选择器第三方分组的组头。
///
/// 保存即拉取：`保存` 先存地址与密钥，紧接着拉模型列表，不另给「拉取模型」按钮。
/// 端口与协议只读：它们是接得通接不通的事，不是口味选项。

/// 删网关的撤销窗口：提示条停留这么久，到期才真正删
const REMOVE_UNDO_MS = 8000;

export interface GatewayPageProps {
  state: GatewayState;
  /// 页面名要点名是哪个工具的网关：`Codex 的网关`
  tool: ModelsTool;
  busy: boolean;
  /// 返回。**离开即提交**标记删除的网关：接了 `onCommitRemovals` 时由调用方离开时提交全部，
  /// 没接时页面自己提交
  onBack: () => void;
  /// 存网关地址与密钥（密钥省略表示不改），返回这一家的 id。失败时抛出
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  /// 保存之后拉一次模型列表（保存即拉取）。失败时抛出
  onFetchModels: (providerId: string) => Promise<void>;
  /// 彻底撤下：卸载后台服务，清掉本功能写进 Codex 设置的一切
  onRestore: () => Promise<void>;
  /// 保存成功那一行的 `选模型 ›`：回到模型页、展开下拉、滚到这一家的分组（ModelsTab 接线）
  onPickModelsFromGateway?: (providerId: string) => void;
  /** 同 `onPickModelsFromGateway` 的别名 */
  onPickModels?: (providerId: string) => void;
  /// 以下四个由调用方执行并刷新 `state`；不给时页面自己调 api，结果只在本页生效
  /// 「再试一次」：按 id 重拉这一家（拉取失败不抛错，原因记在 unreachable 上）
  onRetryProvider?: (providerId: string) => Promise<void>;
  /// 删网关第一步：只标记，返回的 state 里已没有这一家
  onMarkRemove?: (provider: GatewayProvider) => Promise<void>;
  onUndoRemove?: (providerId: string) => Promise<void>;
  /// 真正删掉：到期传 id；不传 id 提交全部
  onCommitRemovals?: (providerId?: string) => Promise<void>;
  /** @deprecated 删网关不再弹确认，这个回调不再被调用 */
  onRemove?: (provider: GatewayProvider) => void;
}

/// 正在编辑的那一家；`providerId` 为 null 表示新加一家
type Editing = { providerId: string | null };

/// 刚标记删除、提示条还挂着的那一家
interface Removing {
  provider: GatewayProvider;
  /// 这一行原来排第几：提示条落在这个位置
  index: number;
}

/// 协议的只读读法：本机路由收 Responses，转给网关时说它的协议
function protocolText(protocol: string | undefined): string {
  if (protocol === "chat") return "Responses → Chat Completions";
  if (protocol === "responses") return "Responses";
  return "拉模型时探明";
}

export function GatewayPage({
  state,
  tool,
  busy,
  onBack,
  onSave,
  onFetchModels,
  onRestore,
  onPickModels,
  onPickModelsFromGateway,
  onRetryProvider,
  onMarkRemove,
  onUndoRemove,
  onCommitRemovals,
}: GatewayPageProps) {
  /// 本页自己调 api 得到的最新状态；调用方传来新的 `state` 就以它为准
  const [local, setLocal] = useState<GatewayState | null>(null);
  useEffect(() => setLocal(null), [state]);
  const live = local ?? state;

  const [editing, setEditing] = useState<Editing | null>(null);
  /// 整页拿不到数据那一类故障（撤下、提交删除失败）：页级错误横幅，不自动消失
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pick = onPickModelsFromGateway ?? onPickModels;

  const report = (e: unknown) => setError(parseBackendError(String(e)).message);

  const retry = (id: string) =>
    onRetryProvider ? onRetryProvider(id) : api.gatewayRetryProvider(id).then(setLocal);
  const mark = (provider: GatewayProvider) =>
    onMarkRemove
      ? onMarkRemove(provider)
      : api.gatewayMarkRemoveProvider(provider.id).then(setLocal);
  const undo = (id: string) =>
    onUndoRemove ? onUndoRemove(id) : api.gatewayUndoRemoveProvider(id).then(setLocal);
  const commit = (id?: string) =>
    onCommitRemovals ? onCommitRemovals(id) : api.gatewayCommitRemovals(id).then(setLocal);

  // 离开网关页即提交：接了回调时调用方（ModelsTab）离开时统一提交全部，这里只清计时器；
  // 没接回调（页面自己调 api）时，卸载那一刻把还挂着撤销窗口的那一家真正删掉
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = removing?.provider.id ?? null;
  const selfCommit = onCommitRemovals === undefined;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (selfCommit && pendingRef.current !== null)
        void api.gatewayCommitRemovals().catch(() => {});
    },
    // 只在卸载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /// 提示条到期或被关掉：只提交这一家
  const commitOne = (id: string) => {
    clearTimer();
    setRemoving((prev) => (prev?.provider.id === id ? null : prev));
    void commit(id).catch(report);
  };

  const remove = (provider: GatewayProvider, index: number) =>
    void (async () => {
      // 上一家还在撤销窗口里：它的提示条要让位，先把它真正删掉
      if (removing !== null) commitOne(removing.provider.id);
      try {
        await mark(provider);
      } catch (e) {
        report(e);
        return;
      }
      if (editing?.providerId === provider.id) setEditing(null);
      setRemoving({ provider, index });
      clearTimer();
      timer.current = setTimeout(() => commitOne(provider.id), REMOVE_UNDO_MS);
    })();

  const undoRemove = () =>
    void (async () => {
      if (removing === null) return;
      clearTimer();
      const id = removing.provider.id;
      setRemoving(null);
      await undo(id).catch(report);
    })();

  const doRetry = (id: string) =>
    void (async () => {
      setRetrying(id);
      try {
        await retry(id);
      } catch (e) {
        report(e);
      } finally {
        setRetrying(null);
      }
    })();

  /// 返回：调用方接了回调就由它在离开时提交全部；没接时这里先把挂着的那一家提交掉
  const back = () => {
    clearTimer();
    if (selfCommit && removing !== null) void commit(removing.provider.id).catch(() => {});
    onBack();
  };

  const provider =
    editing === null || editing.providerId === null
      ? null
      : (live.providers.find((p) => p.id === editing.providerId) ?? null);

  /// 模型数那一格：拉到了 → `103 个模型 · 选模型 ›`；连不上或还没拉到 → `—`
  const modelsCell = (row: GatewayProvider) => {
    if (row.unreachable || row.models.length === 0) {
      return (
        <span className="gateway-row__none" title={row.unreachable ? "拉不到模型" : "还没拉到模型"}>
          —
        </span>
      );
    }
    return (
      <span className="gateway-row__models" title={`${row.models.length} 个可用模型`}>
        <span className="gateway-row__count">{row.models.length}</span>
        <span className="gateway-row__unit">个模型</span>
        {pick ? (
          <>
            <span className="gateway-row__dot">·</span>
            <button
              type="button"
              className="gateway-row__pick"
              title="回到模型页，展开这个网关的模型"
              onClick={() => pick(row.id)}
            >
              <span className="gateway-row__picktext">选模型</span>
              <IconChevronRight size={10} />
            </button>
          </>
        ) : null}
      </span>
    );
  };

  const row = (item: GatewayProvider, index: number) => (
    <li
      key={item.id}
      className={`gateway-row${editing?.providerId === item.id ? " is-editing" : ""}`}
    >
      <div className="gateway-row__who">
        <span className="gateway-row__name">{providerLabel(item)}</span>
        {item.unreachable ? (
          <>
            <Tag tip={item.unreachable}>连不上</Tag>
            <span className="gateway-row__retry">
              {retrying === item.id ? (
                <span className="gateway-row__busy">
                  <Spinner size={14} label="正在重连" />
                  正在重连
                </span>
              ) : (
                <Button
                  size="compact"
                  title="重新连这一家、拉模型"
                  onClick={() => doRetry(item.id)}
                >
                  再试一次
                </Button>
              )}
            </span>
          </>
        ) : item.hasKey ? null : (
          <Tag>还没有密钥</Tag>
        )}
        <span className="gateway-row__url" title={item.baseUrl}>
          {item.baseUrl || "还没填地址"}
        </span>
      </div>
      <div className="gateway-row__modelcell">{modelsCell(item)}</div>
      <div className="gateway-row__actions">
        <IconButton
          icon={<IconEdit />}
          title="改"
          onClick={() => setEditing({ providerId: item.id })}
        />
        <IconButton
          icon={<IconTrash />}
          title="删掉"
          onClick={() => remove(item, index)}
          disabledReason={
            // 延迟删除下后端照样拒绝「已启用时删掉最后一家还在发模型的网关」：与其按下去再报错，
            // 不如键上就说清下一步（原因文案按现在的开关写，不用 modelsView 里旧的「已启用」按钮说法）
            removeProviderBlockedReason(live, item, tool) === null
              ? undefined
              : `它是最后一家还在给 ${tool.name} 发模型的网关，先在模型页关掉 ${tool.name} 再删`
          }
        />
      </div>
    </li>
  );

  const rows = live.providers.map(row);
  if (removing !== null) {
    rows.splice(
      Math.min(removing.index, rows.length),
      0,
      <li key={`removing:${removing.provider.id}`} className="gateway-row gateway-row--notice">
        <Toast
          kind="success"
          verb="删掉"
          names={[providerLabel(removing.provider)]}
          action={{ label: "撤销", onClick: undoRemove }}
          onClose={() => commitOne(removing.provider.id)}
        />
      </li>,
    );
  }

  return (
    <SubPage title={`${tool.name} 的网关`} onBack={back}>
      {error !== null ? <ErrorBanner message={error} onClose={() => setError(null)} /> : null}
      <div className="gateway-page">
        <Busy busy={busy} className="gateway-page__list">
          <div className="gateway-head">
            <span className="gateway-head__label">已连的网关</span>
            <span className="gateway-head__label gateway-head__label--models">模型</span>
            <span className="gateway-head__add">
              <AddButton
                noun="网关"
                title="添加网关"
                onClick={() => setEditing({ providerId: null })}
              />
            </span>
          </div>
          {live.providers.length === 0 && removing === null ? (
            <div className="gateway-page__empty">
              <Empty
                kind="noSkills"
                description="还没有网关"
                primary={{ label: "添加网关", onClick: () => setEditing({ providerId: null }) }}
              />
            </div>
          ) : (
            <ul className="gateway-list">{rows}</ul>
          )}

          {/* 边界态：已经停用了，但后台服务还装着。它是整个功能的收尾，不分网关 */}
          {!live.enabled && canRestore(live) ? (
            <div className="gateway-page__leftover">
              <span className="gateway-page__leftover-text">
                后台服务还装着。它只是空转，也可以现在就撤掉。
              </span>
              <Button size="compact" onClick={() => void onRestore().catch(report)}>
                彻底撤下
              </Button>
            </div>
          ) : null}
        </Busy>

        <div className="gateway-page__side">
          {editing !== null ? (
            <GatewayForm
              key={editing.providerId ?? "new"}
              state={live}
              provider={provider}
              busy={busy}
              onSave={onSave}
              onFetchModels={onFetchModels}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </div>
      </div>
    </SubPage>
  );
}

interface GatewayFormProps {
  state: GatewayState;
  /// 要改的那一家；null＝新加一家
  provider: GatewayProvider | null;
  busy: boolean;
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  onFetchModels: (providerId: string) => Promise<void>;
  /// 收起表单
  onDone: () => void;
}

/// 右栏表单：一家网关的地址与密钥。新建与修改是同一张表单
function GatewayForm({ state, provider, busy, onSave, onFetchModels, onDone }: GatewayFormProps) {
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  /// 新建的那一家存下去之后就有 id 了，接着改的是同一家，不会再新建一个
  const [savedId, setSavedId] = useState<string | null>(provider?.id ?? null);
  const [hasKey, setHasKey] = useState(provider?.hasKey ?? false);
  /// 保存 / 拉取的原话：留在表单里，挨着按下去的那个键（① 就近）
  const [error, setError] = useState<string | null>(null);

  /**
   * 保存即拉取：先存地址与密钥，再拉模型列表。带了密钥时后端存之前就先向网关校验、
   * 成功时顺手拉回模型列表（docs/gateway-commands.md），不拉第二遍；只改了地址、用已存的
   * 密钥那一支才自己拉一次。第二步失败不否定第一步已成功，那句话两件事都说。
   */
  const save = async () => {
    const key = apiKey;
    let id: string;
    try {
      id = await onSave({
        id: savedId ?? undefined,
        baseUrl: baseUrl.trim(),
        key: key === "" ? undefined : key,
      });
    } catch (e) {
      // 保存没成，密钥原样留在输入框里，改了再试
      setError(parseBackendError(String(e)).message);
      return;
    }
    setSavedId(id);
    setApiKey("");
    if (key !== "") setHasKey(true);
    else if (hasKey) {
      try {
        await onFetchModels(id);
      } catch (e) {
        setError(`已保存，但模型列表没拉下来：${parseBackendError(String(e)).message}`);
        return;
      }
    }
    setError(null);
    onDone();
  };

  const title = provider === null ? "添加网关" : `改 ${providerLabel(provider)}`;

  return (
    <Busy busy={busy} className="gateway-form">
      <div className="gateway-form__title">{title}</div>
      <label className="gateway-form__field">
        <span className="gateway-form__label">地址</span>
        <input
          className="gateway-form__input"
          type="text"
          value={baseUrl}
          placeholder="https://example.com/openai/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </label>
      <label className="gateway-form__field">
        <span className="gateway-form__label">密钥</span>
        <input
          className="gateway-form__input"
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={hasKey ? "已保存，留空则不改" : "输入密钥"}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      <div className="gateway-form__actions">
        {baseUrl.trim() === "" ? (
          <Button variant="primary" disabled disabledReason="先填上网关地址">
            保存
          </Button>
        ) : (
          <Button variant="primary" title="存好就去网关拉一次模型列表" onClick={() => void save()}>
            保存
          </Button>
        )}
        <Button variant="link" onClick={onDone}>
          取消
        </Button>
      </div>
      {error !== null ? (
        <div className="gateway-form__error">
          <BlackNotice message={error} />
        </div>
      ) : null}

      {/* 只读事实：端口与协议不做成可改 */}
      <dl className="gateway-form__facts">
        <dt>本机端口</dt>
        <dd>{state.router.port}</dd>
        <dt>协议</dt>
        <dd>{protocolText(provider?.protocol)}</dd>
      </dl>
    </Busy>
  );
}

export default GatewayPage;

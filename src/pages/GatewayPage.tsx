import { useState } from "react";
import {
  canRestore,
  parseBackendError,
  providerCatalogHint,
  providerLabel,
} from "../modelsView.ts";
import type { ModelsTool } from "../modelsView.ts";
import type { GatewayProvider, GatewayState } from "../types.ts";
import { Busy, Button, Empty, ErrorBanner, StateDot, SubPage, Tag } from "../ui/index.ts";
import "./GatewayPage.css";

/// 网关配置页（spec R5、组件规范 §4.6）：占满整窗的二级页面，不渲染侧栏。
///
/// **第三轮反馈把网关整个搬到了这一页**：主页面只留工具身份、生效的模型、
/// 三个动作；地址、密钥、有几家、加一家、删一家，全在这儿。
///
/// 两个视图，同一页内切换：
/// - **列表**：一家一行（状态点 + 名字 + 地址 + 可挑几个 + `改` / `删掉`）、`添加网关`、
///   以及「已经停用但后台服务还装着」那一种收尾
/// - **表单**：一家的地址与密钥。`provider` 为 null 就是**新加一家**——同一张表单，
///   存下去由 `gateway_upsert_provider` 省略 `id` 走新建那一支（docs/gateway-commands.md）
///
/// `←` 从表单回列表，从列表回主页面；Esc 同。
///
/// **保存即拉取**——`保存` 先存网关地址和密钥，紧接着去拉模型列表，不另给一个
/// 「拉取模型」按钮（R5 修订 v2）。**返回即保存**——地址或密钥改过还没保存时，
/// 点 `←` / Esc 会先保存再走；这一页还留着要读的消息就先不走，不把用户的输入丢掉。
///
/// 三件故意不做的事：
/// - **端口与协议只读**。它们是正确性配置不是口味选项，改错了整条链路不通，
///   而用户没有判断依据（spec 设计一节）。协议是拉模型时探明的，不给填。
/// - 密钥从不回显，输入框空着就是「不改」。
/// - 删网关的确认弹窗不在这一页渲染——它由 `ModelsTab` 统一弹（主视图和这一页
///   都可能要弹），这里只负责把「删哪一家」喊出去。

export interface GatewayPageProps {
  state: GatewayState;
  /// 文案要点名是哪个工具的模型列表
  tool: ModelsTool;
  busy: boolean;
  onBack: () => void;
  /// 存网关地址与密钥（密钥省略表示不改），返回这一家的 id：新建时由后端生成。失败时抛出
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  /// 保存之后紧接着拉一次模型列表（保存即拉取，R5）。失败时抛出
  onFetchModels: (providerId: string) => Promise<void>;
  /// 请求删掉这一家：确认弹窗由调用方渲染（删了连钥匙串里的密钥一起没，要确认一道）
  onRemove: (provider: GatewayProvider) => void;
  /// 彻底撤下：卸载后台服务，清掉本功能写进 Codex 设置的一切
  onRestore: () => Promise<void>;
}

/// 正在编辑的那一家；`providerId` 为 null 表示新加一家
type Editing = { providerId: string | null };

export function GatewayPage({
  state,
  tool,
  busy,
  onBack,
  onSave,
  onFetchModels,
  onRemove,
  onRestore,
}: GatewayPageProps) {
  /// null＝列表视图
  const [editing, setEditing] = useState<Editing | null>(null);
  /// 这一页自己的应用级故障位：保存 / 拉取 / 撤下 的原话都摆在这儿，不自动消失（§4.2）
  const [error, setError] = useState<string | null>(null);

  const provider =
    editing === null || editing.providerId === null
      ? null
      : (state.providers.find((p) => p.id === editing.providerId) ?? null);

  /// 失败时把后端的原话留在页面上，成功时清掉
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await action();
      setError(null);
      return true;
    } catch (e) {
      setError(parseBackendError(String(e)).message);
      return false;
    }
  };

  if (editing !== null) {
    return (
      <GatewayForm
        key={editing.providerId ?? "new"}
        state={state}
        provider={provider}
        busy={busy}
        error={error}
        setError={setError}
        onSave={onSave}
        onFetchModels={onFetchModels}
        onDone={() => {
          setError(null);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <SubPage
      title="网关"
      aside={state.providers.length === 0 ? undefined : `${state.providers.length} 家`}
      onBack={onBack}
    >
      {error !== null ? <ErrorBanner message={error} onClose={() => setError(null)} /> : null}
      <Busy busy={busy} className="gateway-page gateway-page--list">
        <div className="gateway-page__head">
          <span className="gateway-page__label">这台机器上的网关</span>
          <span className="gateway-page__note">
            这些网关的模型可以放进 {tool.name} 自己的模型列表。
          </span>
          <div className="gateway-page__head-action">
            <Button size="compact" onClick={() => setEditing({ providerId: null })}>
              添加网关
            </Button>
          </div>
        </div>

        {state.providers.length === 0 ? (
          <div className="gateway-page__empty">
            <Empty
              kind="noSkills"
              description="还没有网关。填上地址和密钥，它的模型列表就会拉回来。"
              primary={{ label: "添加网关", onClick: () => setEditing({ providerId: null }) }}
            />
          </div>
        ) : (
          <ul className="gateway-list">
            {state.providers.map((row) => (
              <li key={row.id} className="gateway-row">
                {/* 圆＝只读状态（钥匙串里有没有这家的密钥），和模型列表里方形复选框的
                    「我的选择」分得开（DESIGN §2 / R3） */}
                <StateDot
                  dot={row.hasKey ? "linked" : "missing"}
                  title={row.hasKey ? "密钥已经存在钥匙串里" : "还没有密钥，填上才能拉模型"}
                />
                <span className="gateway-row__name">{providerLabel(row)}</span>
                {/* 缺密钥给一个无框强标签：不可点的标识没有框（DESIGN「Shapes」） */}
                {row.hasKey ? null : <Tag>还没有密钥</Tag>}
                <span className="gateway-row__url" title={row.baseUrl}>
                  {row.baseUrl || "还没填地址"}
                </span>
                <span className="gateway-row__count">{providerCatalogHint(row)}</span>
                <span className="gateway-row__actions">
                  <Button size="compact" onClick={() => setEditing({ providerId: row.id })}>
                    改
                  </Button>
                  <Button size="compact" onClick={() => onRemove(row)}>
                    删掉
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* 边界态：已经停用了，但后台服务还装着。它是整个功能的收尾，不分网关 */}
        {!state.enabled && canRestore(state) ? (
          <div className="gateway-page__leftover">
            <span className="gateway-page__leftover-text">
              后台服务还装着。它只是空转，也可以现在就撤掉。
            </span>
            <Button size="compact" onClick={() => void run(onRestore)}>
              彻底撤下
            </Button>
          </div>
        ) : null}
      </Busy>
    </SubPage>
  );
}

interface GatewayFormProps {
  state: GatewayState;
  /// 要改的那一家；null＝新加一家
  provider: GatewayProvider | null;
  busy: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  onFetchModels: (providerId: string) => Promise<void>;
  /// 回到列表
  onDone: () => void;
}

/// 一家网关的地址与密钥。新建与修改是同一张表单。
function GatewayForm({
  state,
  provider,
  busy,
  error,
  setError,
  onSave,
  onFetchModels,
  onDone,
}: GatewayFormProps) {
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  /// 新建的那一家存下去之后就有 id 了，接着改的是同一家，不会再新建一个
  const [savedId, setSavedId] = useState<string | null>(provider?.id ?? null);
  /// 密钥存没存过：存了一次之后这一页上的 placeholder 也得跟着变
  const [hasKey, setHasKey] = useState(provider?.hasKey ?? false);
  /// 已经落盘的那个地址。**不能拿 `provider` 来比**：新建那一支的 `provider` 一直是 null，
  /// 存过之后 `dirty` 会一直为真，点 `←` 又白存一遍
  const [savedBaseUrl, setSavedBaseUrl] = useState(provider?.baseUrl ?? "");

  const dirty = baseUrl.trim() !== savedBaseUrl || apiKey !== "";

  /**
   * 保存即拉取（R5 修订 v2）：先存网关地址和密钥，再去拉模型列表。
   *
   * 带了密钥时后端存之前就先向网关校验、成功时顺手把模型列表也拉回来了
   * （docs/gateway-commands.md 的 `gateway_upsert_provider`），所以这儿不再拉第二遍；
   * 只改了地址、用已存的密钥那一支才要自己拉一次。一个密钥都没有就拉不了，
   * 这不是失败——列表里那个空心圆点已经把「还没有密钥」说了。
   *
   * 第二步失败**不否定第一步已经成功**这个事实，所以那一句话要把两件事都说了。
   * 返回 false 表示这一页留下了要读的消息，`back` 据此先不走。
   */
  const save = async (): Promise<boolean> => {
    const key = apiKey;
    let id: string;
    try {
      id = await onSave({
        id: savedId ?? undefined,
        baseUrl: baseUrl.trim(),
        key: key === "" ? undefined : key,
      });
    } catch (e) {
      // 保存没成，密钥原样留在输入框里，用户可以改了再试
      setError(parseBackendError(String(e)).message);
      return false;
    }
    setSavedId(id);
    setSavedBaseUrl(baseUrl.trim());
    setApiKey("");
    if (key !== "") {
      setHasKey(true);
      setError(null);
      return true;
    }
    if (!hasKey) {
      setError(null);
      return true;
    }
    try {
      await onFetchModels(id);
    } catch (e) {
      setError(`已保存，但模型列表没拉下来——${parseBackendError(String(e)).message}`);
      return false;
    }
    setError(null);
    return true;
  };

  /// 返回即保存：有没保存的改动就先存，这一页还留着要读的消息就先不走
  const back = async () => {
    if (dirty && baseUrl.trim() !== "" && !(await save())) return;
    onDone();
  };

  return (
    <SubPage
      title={savedId === null ? "添加网关" : "网关"}
      aside={provider === null ? undefined : providerLabel(provider)}
      onBack={() => void back()}
    >
      {error !== null ? <ErrorBanner message={error} onClose={() => setError(null)} /> : null}
      <Busy busy={busy} className="gateway-page">
        <label className="gateway-page__field">
          <span className="gateway-page__label">网关地址</span>
          <input
            className="gateway-page__input gateway-page__input--mono"
            type="text"
            value={baseUrl}
            placeholder="https://example.com/openai/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>

        <label className="gateway-page__field">
          <span className="gateway-page__label">API 密钥</span>
          <input
            className="gateway-page__input"
            type="password"
            value={apiKey}
            autoComplete="off"
            placeholder={hasKey ? "已保存，留空则不修改" : "输入密钥"}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        {/* 只有一个动作：保存即拉取，不另给「拉取模型」（R5 修订 v2） */}
        <div className="gateway-page__actions">
          {baseUrl.trim() === "" ? (
            <Button disabled disabledReason="先填上网关地址">
              保存
            </Button>
          ) : (
            <Button onClick={() => void save()}>保存</Button>
          )}
          <span className="gateway-page__note">存好就顺手去网关拉一次模型列表。</span>
        </div>

        {/* 只读事实：端口与协议不做成可改（spec 设计一节） */}
        <div className="gateway-page__facts">
          本机路由 <span className="gateway-page__mono">127.0.0.1:{state.router.port}</span> · 协议{" "}
          <span className="gateway-page__mono">{provider?.protocol || "拉模型时探明"}</span>
        </div>
        <div className="gateway-page__note">
          端口和协议是接得通接不通的事，不是口味选项，所以这里只摆出来不给改。
        </div>
      </Busy>
    </SubPage>
  );
}

export default GatewayPage;

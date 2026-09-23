import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Disclosure } from "../Matrix.tsx";
import {
  gatewaySelectedChips,
  gatewayShortName,
  parseBackendError,
  removeProviderBlockedReason,
  selectedModels,
  switchNeedsConfirm,
  unsavedText,
} from "../modelsView.ts";
import type { GatewayChoice, ModelsTool } from "../modelsView.ts";
import type { GatewayProvider, GatewayState } from "../types.ts";
import {
  AddButton,
  NoticePanel,
  BusySlot,
  Button,
  Confirm,
  Empty,
  IconButton,
  IconTrash,
  ModelChip,
  SubPage,
  Tooltip,
  TruncTip,
} from "../ui/index.ts";
import type { ConfirmAnchor } from "../ui/index.ts";
import { ModelList } from "../ModelList.tsx";
// 与来源管理页同一套骨架：表头、行、▸、展开区、跳转闪都用它的类（DESIGN「网关配置是二级页」）
import "./SourcesPage.css";
import "./GatewayPage.css";

/// 网关配置二级页 `Codex 的网关`（DESIGN「网关配置是二级页」，画板 Gateway）。
///
/// 与设置 / 添加同一「← 标题」骨架；模型页的 `配置网关`、模型下拉里的 `管理网关 ›` /
/// `还没有网关 · + 网关 ›` 都进这一页。转场：从右侧推入、返回滑回，200ms 机械缓动，
/// reduced-motion 即时（⑦ 动效解释空间关系）。页头标题后按状态出现 `重启生效`（与模型页同组件），
/// 右端 `+ 网关`（与来源管理页 `+ 来源` 同位置、同组件）。
///
/// 列表与来源管理页同一套骨架（表头 `网关` + 2px 结构线、一家一行、行间 hairline、点整行展开）：
/// - 第一行 `▸` + 网关短名；第二行 `地址 · 已连 · 已选 3 / 103 个模型`，地址放不下才截断（截断才提示）；
///   连不上：`地址 · 连不上 · 原因`（原因写全），行尾动作列出 `再试一次`
/// - 行尾 `编辑` + 垃圾桶（锚在垃圾桶下的确认，地址与钥匙串里的密钥一起删）
/// - 点整行展开＝从这个网关选模型：限制说明 → 已选模型片 → 与模型下拉同一组件的勾选列表；
///   几行可以同时展开，各自独立
/// - 进来时每行都收着（同来源管理页）；只有刚新增成功的那一行、跳转定位的那一行自动展开
/// - `编辑` / `+ 网关`：表单在行里就地展开（新网关插在最上面，名字位写 `新网关`）；
///   保存成功、拉到模型后新网关变成普通行并自动展开，模型整批出现不逐个闪，
///   这一行 surface 行带闪两下（同跳转定位）交代「就是它」
///
/// 两处都能选模型，同一份状态：这一页勾上的回到模型页已在框里，下拉里去掉的这一页同步取消——
/// 两边都读 ModelsTab 持有的同一个 GatewayState。

/// 转场时长，与 GatewayPage.css 同值
export const GATEWAY_PAGE_MOTION_MS = 200;

/// 打开时定位哪一家；"new" 直接在最上面插一行新网关的表单
export type GatewaySelection = GatewayChoice;

export interface GatewayPageProps {
  tool: ModelsTool;
  state: GatewayState;
  busy: boolean;
  /// 打开时定位哪一家（展开它）；"new" 直接出新网关的表单；null 每行都收着
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
  /// 新问题提示「查看」定位的那一家：滚到这一行，行带 surface 闪两下（同来源管理页）
  flashProviderId?: string | null;
  /// 勾选没写成：就在那一行的展开区里说（灰面板，原因写全、可关），不必回模型页才看到
  notice?: { message: string; reason: string } | null;
  onCloseNotice?: () => void;
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

/// 删网关的确认：删的是哪一家、锚在哪（垃圾桶所在的那一行）
interface ConfirmingRemove {
  provider: GatewayProvider;
  anchor: ConfirmAnchor;
}

/// 草稿存在期间 `+ 网关` 禁用的原因（从源头防止两个草稿）
export const ADD_GATEWAY_BLOCKED = "先保存或取消正在添加的网关";

/// 协议的只读读法：本机路由收 Responses，转给网关时说它的协议
function protocolText(protocol: string | undefined): string {
  if (protocol === "chat") return "Responses → Chat Completions";
  if (protocol === "responses") return "Responses";
  return "拉模型时探明";
}

/// 打开时展开哪几行：进来时每行都收着（同来源管理页）；只有跳转定位的那一家展开
function initialExpanded(initial: GatewaySelection | null, providerIds: string[]): Set<string> {
  return new Set(
    initial !== null && initial !== "new" && providerIds.includes(initial) ? [initial] : [],
  );
}

export function GatewayPage({
  tool,
  state,
  busy,
  initial,
  onSave,
  onFetchModels,
  onRetry,
  onRemove,
  onToggleModel,
  flashProviderId,
  notice,
  onCloseNotice,
  headerAction,
  leaving,
  onLeave,
  modalOpen,
  overlay,
}: GatewayPageProps) {
  const providers = state.providers;
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialExpanded(
      initial,
      providers.map((p) => p.id),
    ),
  );
  /// 表单开在哪一行（一次只开一份）；"new" 是最上面那一行新网关
  const [editing, setEditing] = useState<GatewaySelection | null>(initial === "new" ? "new" : null);
  /// 表单里有没保存的改动：离开 / 换一行编辑之前先问
  const [formDirty, setFormDirty] = useState(false);
  /// 想离开但表单还有改动：在那一行里就地一句「地址改动没保存」+ 保存 / 丢弃
  const [askDiscard, setAskDiscard] = useState(false);
  /// 表单有改动时又点了别的 `编辑` / `+ 网关`：就地问完再换过去
  const [switchTo, setSwitchTo] = useState<GatewaySelection | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  /// 正在删的那一家：垃圾桶锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmingRemove | null>(null);
  /// 删 / 重连没成：灰面板出在那一行里
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  /// 刚新增成功的那一行：surface 行带闪两下（同跳转定位），模型本身整批出现、不逐个闪
  const [addedId, setAddedId] = useState<string | null>(null);
  /// 最近在哪一家勾选过：勾选没写成的灰面板出在那一行的展开区
  const [toggledIn, setToggledIn] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());

  const trackDirty = useCallback((dirty: boolean) => {
    setFormDirty(dirty);
    if (!dirty) {
      setSwitchTo(null);
      setAskDiscard(false);
    }
  }, []);

  /// 点 ← 或 Esc：表单有没保存的改动就拦下，在那一行里就地问一句（⑪⑫）
  const back = () => {
    // 确认框开着（重启确认、删网关确认）：Esc 归确认框，不当返回
    if (modalOpen || leaving || document.querySelector(".ss-confirm")) return;
    if (formDirty && editing !== null) setAskDiscard(true);
    else onLeave();
  };

  // 正在编辑的那一家消失了（被删、外部变化）：收起表单
  useEffect(() => {
    if (editing !== null && editing !== "new" && !providers.some((p) => p.id === editing)) {
      setEditing(null);
      setFormDirty(false);
    }
  }, [editing, providers]);

  // 新问题提示「查看」定位、刚新增成功：滚到那一行（行本身 surface 闪两下，见 is-jump）。
  // 新增的那一行在状态回来之后才有：等它挂上再滚
  const jumpTo = addedId ?? flashProviderId ?? null;
  const jumpMounted = jumpTo !== null && providers.some((p) => p.id === jumpTo);
  useEffect(() => {
    if (jumpTo === null || !jumpMounted) return;
    rowEls.current.get(jumpTo)?.scrollIntoView?.({ block: "nearest" });
  }, [jumpTo, jumpMounted]);

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /// 真正换过去（已确认没有要丢的改动）
  const startEditing = (next: GatewaySelection) => {
    setSwitchTo(null);
    setRowError(null);
    setEditing(next);
  };

  /// 点 `编辑` / `+ 网关`：另一份表单有没保存的改动就拦下就地问，不静默丢掉
  const choose = (next: GatewaySelection) => {
    if (editing !== null && switchNeedsConfirm(editing, next, formDirty)) setSwitchTo(next);
    else startEditing(next);
  };

  /// 点垃圾桶：先问一句。确认框锚在这一行下方、右沿对齐垃圾桶（同来源页 × 的确认位置规则）
  const askRemove = (provider: GatewayProvider, trash: HTMLElement) => {
    const row = rowEls.current.get(provider.id) ?? trash;
    const r = row.getBoundingClientRect();
    const t = trash.getBoundingClientRect();
    setConfirming({
      provider,
      anchor: { top: r.top, bottom: r.bottom, left: r.left, right: Math.max(r.right, t.right) },
    });
  };

  /// 确认之后直接删；这一行从列表里消失
  const remove = (provider: GatewayProvider) =>
    void (async () => {
      setConfirming(null);
      setRemoving(provider.id);
      try {
        await onRemove(provider);
      } catch (e) {
        setRowError({ id: provider.id, message: parseBackendError(String(e)).message });
        return;
      } finally {
        setRemoving(null);
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(provider.id);
        return next;
      });
    })();

  const retry = (id: string) =>
    void (async () => {
      setRetrying(id);
      setRowError(null);
      try {
        await onRetry(id);
      } catch (e) {
        setRowError({ id, message: parseBackendError(String(e)).message });
      } finally {
        setRetrying(null);
      }
    })();

  const toggleModel = (provider: GatewayProvider, modelId: string) => {
    setToggledIn(provider.id);
    onToggleModel(provider, modelId);
  };

  /// 勾选没写成的灰面板出在哪一行：最近勾选的那一行（展开着），否则第一行展开着的
  const noticeRow =
    toggledIn !== null && expanded.has(toggledIn)
      ? toggledIn
      : (providers.find((p) => expanded.has(p.id))?.id ?? null);

  /// 这一行的表单（编辑 / 新网关）
  const form = (provider: GatewayProvider | null) => {
    const key: GatewaySelection = provider?.id ?? "new";
    return (
      <div className="gw-row__form">
        <GatewayForm
          state={state}
          provider={provider}
          busy={busy}
          onSave={onSave}
          onFetchModels={onFetchModels}
          onSaved={(id) => {
            setEditing(null);
            if (provider !== null) return;
            // 新网关变成普通行并自动展开选模型（首次在这里选）；行带闪两下交代「就是它」
            setExpanded((prev) => new Set(prev).add(id));
            setAddedId(id);
          }}
          onCancel={() => {
            trackDirty(false);
            // 取消新网关：那一行拿掉；取消编辑：第二行换回来
            setEditing(null);
          }}
          onDirtyChange={trackDirty}
          ask={
            switchTo !== null
              ? { text: unsavedText(key), onDone: () => startEditing(switchTo) }
              : askDiscard
                ? {
                    text: unsavedText(key),
                    onDone: () => {
                      trackDirty(false);
                      onLeave();
                    },
                  }
                : null
          }
        />
      </div>
    );
  };

  /// 第二行：`地址 · 已连 · 已选 3 / 103 个模型`；连不上：`地址 · 连不上 · 原因`（原因写全）
  const subLine = (p: GatewayProvider) => {
    const url = p.baseUrl || "还没填地址";
    return (
      <span className="src-row__sub gw-row__sub">
        {/* 地址占满放得下的宽度，放不下才截断；截断了才给完整值 */}
        <TruncTip content={url}>
          <span className="gw-row__url">{url}</span>
        </TruncTip>
        {p.unreachable ? (
          <>
            <span className="gw-row__fact">
              {" · "}
              <span className="gw-row__down">连不上</span>
              {" · "}
            </span>
            <span className="gw-row__reason">{p.unreachable}</span>
          </>
        ) : (
          <span className="gw-row__fact">
            {` · ${p.hasKey ? "已连" : "还没有密钥"}`}
            {p.models.length > 0
              ? ` · 已选 ${selectedModels(p).length} / ${p.models.length} 个模型`
              : null}
          </span>
        )}
      </span>
    );
  };

  /// 行尾：连不上时 `再试一次`，然后 `编辑` + 垃圾桶
  const actions = (p: GatewayProvider, isEditing: boolean) => (
    <div className="gw-row__actions">
      {p.unreachable && !isEditing ? (
        <BusySlot busy={retrying === p.id} label="正在重连">
          <Button size="compact" onClick={() => retrying !== p.id && retry(p.id)}>
            再试一次
          </Button>
        </BusySlot>
      ) : null}
      {isEditing ? null : (
        <Button variant="link" onClick={() => choose(p.id)}>
          编辑
        </Button>
      )}
      <span className="gw-row__trash">
        {removeProviderBlockedReason(state, p, tool) === null ? (
          <BusySlot busy={removing === p.id} label="正在删掉">
            <IconButton
              icon={<IconTrash />}
              title={`删掉 ${gatewayShortName(p)}`}
              onClick={() => {
                if (removing === p.id) return;
                const el = rowEls.current
                  .get(p.id)
                  ?.querySelector<HTMLElement>(".gw-row__trash button");
                if (el) askRemove(p, el);
              }}
            />
          </BusySlot>
        ) : (
          // 最后一家还在供模型：后端会拒，键上就说清下一步（禁用键自带原因提示框）
          <IconButton
            icon={<IconTrash />}
            title={`删掉 ${gatewayShortName(p)}`}
            disabledReason={`${tool.name} 还在用它的 ${selectedModels(p).length} 个模型，先取消勾选再删`}
          />
        )}
      </span>
    </div>
  );

  /// 展开区＝从这个网关选模型：限制说明 → 已选模型片 → 勾选列表（缩进对齐网关名）
  const models = (p: GatewayProvider) => {
    const chips = gatewaySelectedChips(p);
    return (
      <div className="gw-row__body">
        <div className="gw-row__note">{tool.pickerNote}</div>
        {/* 已选用模型片表达（与模型页同一个 ModelChip）：勾选 / 取消 / 点 × 三处实时联动 */}
        {chips.length > 0 ? (
          <div className="gw-row__chosen" aria-label={`已从 ${gatewayShortName(p)} 选的模型`}>
            {chips.map(({ model, label }) => (
              <ModelChip
                key={model.id}
                name={label}
                id={model.slug || model.id}
                onRemove={() => toggleModel(p, model.id)}
              />
            ))}
          </div>
        ) : null}
        {notice && noticeRow === p.id ? (
          <div className="gw-notice">
            <NoticePanel message={notice.message} reason={notice.reason} onClose={onCloseNotice} />
          </div>
        ) : null}
        {p.models.length > 0 ? (
          <div className="gw-row__list">
            <ModelList
              // 收起再展开就是「重新打开」这份列表：重排一次序
              key={p.id}
              entries={p.models.map((model) => ({ provider: p, model }))}
              onToggle={toggleModel}
            />
          </div>
        ) : (
          <div className="gw-row__none">
            {p.unreachable ? "连不上，还没拉到模型" : "还没拉到模型"}
          </div>
        )}
      </div>
    );
  };

  const row = (p: GatewayProvider) => {
    const open = expanded.has(p.id);
    const isEditing = editing === p.id;
    const name = (
      <span className="src-row__caret">
        <Disclosure open={open || isEditing} shown />
      </span>
    );
    return (
      <div
        key={p.id}
        className={`src-row gw-row${open || isEditing ? " is-open" : ""}${flashProviderId === p.id || addedId === p.id ? " is-jump" : ""}`}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && addedId === p.id) setAddedId(null);
        }}
      >
        <div
          className="src-row__main gw-row__main"
          ref={(el) => {
            if (el) rowEls.current.set(p.id, el);
            else rowEls.current.delete(p.id);
          }}
        >
          {isEditing ? (
            // 编辑时第二行换成表单：名字位不再是展开键
            <div className="src-row__name gw-row__name is-static">
              {name}
              <span className="src-row__text">
                <span className="src-row__label">{gatewayShortName(p)}</span>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="src-row__name gw-row__name"
              aria-expanded={open}
              onClick={() => toggleRow(p.id)}
            >
              {name}
              <span className="src-row__text">
                <span className="src-row__label">{gatewayShortName(p)}</span>
                {subLine(p)}
              </span>
            </button>
          )}
          {actions(p, isEditing)}
        </div>
        {isEditing ? form(p) : null}
        {rowError?.id === p.id ? (
          <div className="gw-row__notice">
            <NoticePanel message={rowError.message} />
          </div>
        ) : null}
        {open && !isEditing ? models(p) : null}
      </div>
    );
  };

  /// 新网关：插在列表最上面，名字位写 `新网关`（普通 ink-mute 字，不是反色片），表单直接开着
  const draftRow = (
    <div key="new" className="src-row gw-row is-open">
      <div className="src-row__main gw-row__main">
        <div className="src-row__name gw-row__name is-static">
          <span className="src-row__caret">
            <Disclosure open shown />
          </span>
          <span className="src-row__text">
            <span className="src-row__label gw-row__draft">新网关</span>
          </span>
        </div>
      </div>
      {form(null)}
    </div>
  );

  const drafting = editing === "new";
  const body =
    providers.length === 0 && !drafting ? (
      // 空态一句；动作在页头 `+ 网关`，空态不重复按钮
      <div className="src-page__empty">
        <Empty kind="noSkills" description="还没有网关" art="emptyFolder" />
      </div>
    ) : (
      <div className="src-page">
        <div className="src-panel">
          <div className="src-panel__head">
            <span>网关</span>
          </div>
          {drafting ? draftRow : null}
          {providers.map(row)}
        </div>
      </div>
    );

  return (
    <SubPage
      className={`gw-page-sub${leaving ? " is-leaving" : ""}`}
      title={
        <span className="gw-page__title">
          {tool.name} 的网关
          {headerAction}
        </span>
      }
      onBack={back}
      aside={
        <AddButton
          noun="网关"
          onClick={() => choose("new")}
          disabledReason={drafting ? ADD_GATEWAY_BLOCKED : undefined}
        />
      }
    >
      {body}
      {/* 删网关：地址与钥匙串里的密钥一起删、找不回——二次确认（⑪） */}
      {confirming !== null ? (
        <Confirm
          title={`删掉 ${gatewayShortName(confirming.provider)}？`}
          confirmLabel="删掉"
          anchor={confirming.anchor}
          align="end"
          onConfirm={() => remove(confirming.provider)}
          onCancel={() => setConfirming(null)}
        >
          地址和钥匙串里的密钥一起删掉，删了找不回来
        </Confirm>
      ) : null}
      {/* 页面里的浮层（重启确认）也要在二级页里：主视图打开二级页期间是 inert 的 */}
      {overlay}
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
  onSaved: (providerId: string) => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /// 离开页面或换一行编辑时表单还有改动：就地一句 + 保存 / 丢弃，问完做 `onDone`
  ask: { text: string; onDone: () => void } | null;
}

/// 地址为空时的「保存」：禁用，提示框「先填地址」（禁用键自带原因提示框，按下当即出）
function BlankSave() {
  return (
    <Button variant="primary" disabled disabledReason="先填地址">
      保存
    </Button>
  );
}

/// 连接表单：地址与密钥。保存才生效、保存即拉取；保存中原位忙碌指示 +「正在拉模型」
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
  // 卸载（收起、换一行）时不再算有改动
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
          autoFocus
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
          // 离开 / 换一行编辑时表单有未保存的改动：不走，在这一行里就地问一句（⑪⑫）
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
          // 存 + 拉模型：键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
          <BusySlot busy label="正在拉模型">
            <Button variant="primary">保存</Button>
          </BusySlot>
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
        {ask === null ? (
          <Button variant="link" onClick={onCancel}>
            取消
          </Button>
        ) : null}
      </div>
      {error !== null ? (
        <div className="gw-notice">
          <NoticePanel message={error} />
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

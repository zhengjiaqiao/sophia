import { useCallback, useEffect, useRef, useState } from "react";
import { Disclosure } from "./Matrix.tsx";
import { contextMenuHandler } from "./contextMenu.ts";
import { useLeaveGuard } from "./shell/leaveGuard.ts";
import type { ContextMenuItem } from "./contextMenu.ts";
import {
  ADD_GATEWAY_BLOCKED,
  gatewayFacts,
  gatewayShortName,
  parseBackendError,
  protocolText,
  removeProviderBlockedReason,
  switchNeedsConfirm,
  unsavedText,
} from "./modelsView.ts";
import type { GatewayChoice, ModelsTool } from "./modelsView.ts";
import type { GatewayProvider, GatewayState } from "./types.ts";
import {
  AddButton,
  BusySlot,
  Button,
  Confirm,
  IconButton,
  IconTrash,
  NoticePanel,
  Tooltip,
  TruncTip,
} from "./ui/index.ts";
import type { ConfirmAnchor } from "./ui/index.ts";
import { ModelList } from "./ModelList.tsx";

/// Codex 页「第三方模型」一节里的网关小区块（DESIGN「agent 页 › 网关」，D5：网关二级页并进来）。
///
/// 区块小标 `网关` + 右端 `+ 网关`，下面一条 hairline；**一家网关一行**，行间 `row-line`：
/// - 三列 `▸ / ▾` ｜ 内容 ｜ 行尾动作。第一行网关短名，第二行 `地址 · 已连接 · 已选 2 / 103`
///   （地址放不下才截断、截断才提示）；无法连接：`地址 · 无法连接 · 原因`（原因写全），行尾出 `再试一次`
/// - 行尾 `编辑`（安静键）+ 垃圾桶（锚在垃圾桶下的确认，地址与钥匙串里的密钥一起删）
/// - **点整行展开＝从这家挑模型**：限制说明 → 440 宽勾选列表；几行可以同时展开，各自独立；
///   进这一页时每行都收着，只有刚新增成功的、从新问题提示「查看」跳过来的那一行自动展开
/// - `编辑` / `+ 网关`：表单在行里就地展开（新网关插在最上面，名字位写 `新网关`）；保存成功、
///   拉到模型后新网关变成普通行并自动展开，模型整批出现不逐个闪，这一行 surface 行带闪两下
/// - 右键网关行：`编辑` · `删掉…`（D18，与行尾两个入口同一条命令）
/// - 离开这一页（侧栏、⌘, ⌘1…、应用菜单、托盘跳转、⌘[，都经外壳的 `useLeaveGuard`）时表单有没保存的改动：
///   拦下，在那一行里就地问「保存 / 丢弃」，问完再走
///
/// 勾选与模型片读的是 ModelsTab 持有的同一个 GatewayState：勾选 / 取消 / 点在用片的 × 三处实时联动

/// 删网关的确认：删的是哪一家、锚在哪（垃圾桶所在的那一行）
interface ConfirmingRemove {
  provider: GatewayProvider;
  anchor: ConfirmAnchor;
}

/// 勾选没写成的灰面板：出在那一家展开着的行里
export interface RowNotice {
  providerId: string;
  message: string;
  reason: string;
}

export interface GatewayBlockProps {
  tool: ModelsTool;
  state: GatewayState;
  /// 这一节正在做一件写 Codex 设置的事：表单的 `保存` 先等它做完
  busy: boolean;
  /// 展开着的行（ModelsTab 持有：它要知道勾选失败的灰面板能不能出在行里）
  expanded: ReadonlySet<string>;
  onToggleRow: (providerId: string) => void;
  onExpand: (providerId: string) => void;
  /// 存网关地址与密钥（密钥省略表示不改），返回这一家的 id。失败时抛出原话
  onSave: (input: { id?: string; baseUrl: string; key?: string }) => Promise<string>;
  /// 保存之后拉一次模型列表（保存即拉取）
  onFetchModels: (providerId: string) => Promise<void>;
  /// 「再试一次」：按 id 重拉（拉取失败不抛错，原因记在 unreachable 上）
  onRetry: (providerId: string) => Promise<void>;
  /// 删掉这一家（地址与钥匙串里的密钥一起删，删除后无法恢复）：确认之后才调。失败时抛出原话
  onRemove: (provider: GatewayProvider) => Promise<void>;
  onToggleModel: (provider: GatewayProvider, modelId: string) => void;
  /// 新问题提示「查看」定位的那一家：滚到这一行，行带 surface 闪两下
  flashProviderId?: string | null;
  notice?: RowNotice | null;
  onCloseNotice?: () => void;
  /// 表单开着且有没保存的改动（ModelsTab 据此拦下离开）
  onDirtyChange?: (dirty: boolean) => void;
}

/// 地址去掉协议头显示（`https://openrouter.ai/api/v1` → `openrouter.ai/api/v1`）；完整值截断时进提示框
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
}

export function GatewayBlock({
  tool,
  state,
  busy,
  expanded,
  onToggleRow,
  onExpand,
  onSave,
  onFetchModels,
  onRetry,
  onRemove,
  onToggleModel,
  flashProviderId,
  notice,
  onCloseNotice,
  onDirtyChange,
}: GatewayBlockProps) {
  const providers = state.providers;
  /// 表单开在哪一行（一次只开一份）；"new" 是最上面那一行新网关
  const [editing, setEditing] = useState<GatewayChoice | null>(null);
  /// 表单里有没保存的改动：离开 / 换一行编辑之前先问
  const [formDirty, setFormDirty] = useState(false);
  /// 想离开但表单还有改动：外壳交过来的「问完之后继续走」
  const [leaveTo, setLeaveTo] = useState<(() => void) | null>(null);
  /// 表单有改动时又点了别的 `编辑` / `+ 网关`：就地问完再换过去
  const [switchTo, setSwitchTo] = useState<GatewayChoice | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  /// 正在删的那一家：垃圾桶锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmingRemove | null>(null);
  /// 删 / 重连没成：灰面板出在那一行里
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  /// 刚新增成功的那一行：surface 行带闪两下（同跳转定位），模型本身整批出现、不逐个闪
  const [addedId, setAddedId] = useState<string | null>(null);
  /// 右键菜单开着的那一行：surface 行带
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const formEl = useRef<HTMLDivElement | null>(null);

  const trackDirty = useCallback(
    (dirty: boolean) => {
      setFormDirty(dirty);
      onDirtyChange?.(dirty);
      if (!dirty) {
        setSwitchTo(null);
        setLeaveTo(null);
      }
    },
    [onDirtyChange],
  );

  // 离开这一页时表单有没保存的改动：外壳的换页都经这里（useLeaveGuard），拦下，在那一行里就地问一句（⑬⑭）
  useLeaveGuard(formDirty && editing !== null, (proceed) => {
    setLeaveTo(() => proceed);
    formEl.current?.scrollIntoView?.({ block: "nearest" });
  });

  // 正在编辑的那一家消失了（被删、外部变化）：收起表单
  useEffect(() => {
    if (editing !== null && editing !== "new" && !providers.some((p) => p.id === editing)) {
      setEditing(null);
      trackDirty(false);
    }
  }, [editing, providers, trackDirty]);

  // 新问题提示「查看」定位、刚新增成功：滚到那一行（行本身 surface 闪两下，见 is-jump）。
  // 新增的那一行在状态回来之后才有：等它挂上再滚
  const jumpTo = addedId ?? flashProviderId ?? null;
  const jumpMounted = jumpTo !== null && providers.some((p) => p.id === jumpTo);
  useEffect(() => {
    if (jumpTo === null || !jumpMounted) return;
    rowEls.current.get(jumpTo)?.scrollIntoView?.({ block: "nearest" });
  }, [jumpTo, jumpMounted]);

  /// 真正换过去（已确认没有要丢的改动）
  const startEditing = (next: GatewayChoice) => {
    setSwitchTo(null);
    setRowError(null);
    setEditing(next);
  };

  /// 点 `编辑` / `+ 网关`：另一份表单有没保存的改动就拦下就地问，不静默丢掉
  const choose = (next: GatewayChoice) => {
    if (editing !== null && switchNeedsConfirm(editing, next, formDirty)) setSwitchTo(next);
    else startEditing(next);
  };

  /// 删网关先问一句：确认框锚在这一行下方、右沿对齐垃圾桶
  const askRemove = (provider: GatewayProvider) => {
    const row = rowEls.current.get(provider.id);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const t = row.querySelector(".gw-row__trash")?.getBoundingClientRect();
    setConfirming({
      provider,
      anchor: {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: t ? Math.max(r.right, t.right) : r.right,
      },
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
      } finally {
        setRemoving(null);
      }
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

  /// 问完「保存 / 丢弃」之后：换过去，或替用户把被拦下的那一下再点一次
  const afterAsk = (key: GatewayChoice) => {
    if (switchTo !== null) {
      startEditing(switchTo);
      return;
    }
    const proceed = leaveTo;
    trackDirty(false);
    if (key === "new") setEditing(null);
    proceed?.();
  };

  /// 这一行的表单（编辑 / 新网关）
  const form = (provider: GatewayProvider | null) => {
    const key: GatewayChoice = provider?.id ?? "new";
    const asking = switchTo !== null || leaveTo !== null;
    return (
      <div className="gw-row__form" ref={formEl}>
        <GatewayForm
          state={state}
          provider={provider}
          busy={busy}
          onSave={onSave}
          onFetchModels={onFetchModels}
          onSaved={(id) => {
            setEditing(null);
            if (provider !== null) return;
            // 新网关变成普通行并自动展开挑模型；行带闪两下交代「就是它」
            onExpand(id);
            setAddedId(id);
          }}
          onCancel={() => {
            trackDirty(false);
            // 取消新网关：那一行拿掉；取消编辑：第二行换回来
            setEditing(null);
          }}
          onDirtyChange={trackDirty}
          ask={asking ? { text: unsavedText(key), onDone: () => afterAsk(key) } : null}
        />
      </div>
    );
  };

  /// 第二行：`地址 · 已连接 · 已选 2 / 103`；无法连接：`地址 · 无法连接 · 原因`（原因写全）
  const subLine = (p: GatewayProvider) => {
    const facts = gatewayFacts(p);
    const url = p.baseUrl ? displayUrl(p.baseUrl) : facts.url;
    return (
      <span className="gw-row__sub">
        {/* 地址占满放得下的宽度，放不下才截断；截断了才给完整值 */}
        <TruncTip content={p.baseUrl || facts.url}>
          <span className="gw-row__url">{url}</span>
        </TruncTip>
        <span className="gw-row__fact">
          {" · "}
          {facts.status === "无法连接" ? (
            <span className="gw-row__down">无法连接</span>
          ) : (
            facts.status
          )}
          {facts.picked !== null ? ` · ${facts.picked}` : null}
          {facts.reason !== null ? " · " : null}
        </span>
        {facts.reason !== null ? <span className="gw-row__reason">{facts.reason}</span> : null}
      </span>
    );
  };

  /// 右键菜单（D18）：只列此刻能做的——编辑中没有「编辑」，删不得、正在删的没有「删掉…」
  const menuItems = (p: GatewayProvider, isEditing: boolean): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (!isEditing) items.push({ label: "编辑", run: () => choose(p.id) });
    items.push("separator");
    if (removeProviderBlockedReason(state, p, tool) === null && removing !== p.id) {
      items.push({ label: "删掉…", run: () => askRemove(p) });
    }
    return items;
  };

  /// 行尾：无法连接时 `再试一次`，然后 `编辑` + 垃圾桶
  const actions = (p: GatewayProvider, isEditing: boolean) => {
    const blocked = removeProviderBlockedReason(state, p, tool);
    const short = gatewayShortName(p);
    return (
      <div className="gw-row__actions">
        {p.unreachable && !isEditing ? (
          <BusySlot busy={retrying === p.id} label="正在重新连接">
            <Button size="compact" onClick={() => retrying !== p.id && retry(p.id)}>
              再试一次
            </Button>
          </BusySlot>
        ) : null}
        {isEditing ? null : (
          <Button variant="quiet" onClick={() => choose(p.id)}>
            编辑
          </Button>
        )}
        <span className="gw-row__trash">
          {blocked === null ? (
            <BusySlot busy={removing === p.id} label="正在删掉">
              <IconButton
                icon={<IconTrash />}
                title={`删掉 ${short}`}
                onClick={() => removing !== p.id && askRemove(p)}
              />
            </BusySlot>
          ) : (
            // 最后一家还在供模型：后端会拒，键上就说清下一步（禁用键自带原因提示框，按下即出）
            <IconButton icon={<IconTrash />} title={`删掉 ${short}`} disabledReason={blocked} />
          )}
        </span>
      </div>
    );
  };

  /// 展开区＝从这家挑模型：限制说明（不截断）→ 勾选列表（左沿对齐网关名）
  const body = (p: GatewayProvider) => (
    <div className="gw-row__body">
      <p className="gw-row__note">{tool.limitations}</p>
      {notice && notice.providerId === p.id ? (
        <div className="gw-row__panel">
          <NoticePanel message={notice.message} reason={notice.reason} onClose={onCloseNotice} />
        </div>
      ) : null}
      {p.models.length > 0 ? (
        <div className="gw-row__list">
          <ModelList
            // 收起再展开就是「重新打开」这份列表：重排一次序
            key={p.id}
            entries={p.models.map((model) => ({ provider: p, model }))}
            onToggle={onToggleModel}
          />
        </div>
      ) : (
        <p className="gw-row__none">{p.unreachable ? "无法连接，还没拉到模型" : "还没拉到模型"}</p>
      )}
    </div>
  );

  const row = (p: GatewayProvider) => {
    const open = expanded.has(p.id);
    const isEditing = editing === p.id;
    const short = gatewayShortName(p);
    const classes = ["gw-row"];
    if (open || isEditing) classes.push("is-open");
    if (flashProviderId === p.id || addedId === p.id) classes.push("is-jump");
    if (menuRow === p.id) classes.push("is-menu");
    return (
      <div
        key={p.id}
        className={classes.join(" ")}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && addedId === p.id) setAddedId(null);
        }}
      >
        <div
          className="gw-row__main"
          ref={(el) => {
            if (el) rowEls.current.set(p.id, el);
            else rowEls.current.delete(p.id);
          }}
          onContextMenu={contextMenuHandler(() => menuItems(p, isEditing), {
            onOpen: () => setMenuRow(p.id),
            onClose: () => setMenuRow(null),
          })}
        >
          {isEditing ? (
            // 编辑时第二行换成表单：名字位不再是展开键
            <div className="gw-row__name is-static">
              <span className="gw-row__caret">
                <Disclosure open shown />
              </span>
              <span className="gw-row__text">
                <span className="gw-row__label">{short}</span>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="gw-row__name"
              aria-expanded={open}
              onClick={() => onToggleRow(p.id)}
            >
              <span className="gw-row__caret">
                <Disclosure open={open} shown />
              </span>
              <span className="gw-row__text">
                <span className="gw-row__label">{short}</span>
                {subLine(p)}
              </span>
            </button>
          )}
          {actions(p, isEditing)}
        </div>
        {isEditing ? form(p) : null}
        {rowError?.id === p.id ? (
          <div className="gw-row__panel gw-row__panel--error">
            <NoticePanel message={rowError.message} onClose={() => setRowError(null)} />
          </div>
        ) : null}
        {open && !isEditing ? body(p) : null}
      </div>
    );
  };

  /// 新网关：插在列表最上面，名字位写 `新网关`，表单直接开着
  const draftRow = (
    <div key="new" className="gw-row is-open">
      <div className="gw-row__main">
        <div className="gw-row__name is-static">
          <span className="gw-row__caret">
            <Disclosure open shown />
          </span>
          <span className="gw-row__text">
            <span className="gw-row__label">新网关</span>
          </span>
        </div>
      </div>
      {form(null)}
    </div>
  );

  const drafting = editing === "new";

  return (
    <div className="gw-block">
      <div className="gw-block__head">
        <span className="gw-block__label">网关</span>
        <AddButton
          noun="网关"
          onClick={() => choose("new")}
          disabledReason={drafting ? ADD_GATEWAY_BLOCKED : undefined}
        />
      </div>
      {providers.length === 0 && !drafting ? (
        // 空态一句；`+ 网关` 就在正上方，空态不重复按钮
        <p className="gw-block__empty">还没有网关，先加一家</p>
      ) : (
        <div className="gw-list">
          {drafting ? draftRow : null}
          {providers.map(row)}
        </div>
      )}
      {/* 删网关：地址与钥匙串里的密钥一起删、删除后无法恢复——锚定确认（⑬） */}
      {confirming !== null ? (
        <Confirm
          title={`删掉 ${gatewayShortName(confirming.provider)}？`}
          confirmLabel="删掉"
          anchor={confirming.anchor}
          align="end"
          onConfirm={() => remove(confirming.provider)}
          onCancel={() => setConfirming(null)}
        >
          地址和钥匙串里的密钥一起删掉，删除后无法恢复
        </Confirm>
      ) : null}
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
  /// 离开页面或换一行编辑时表单还有改动：就地一句 + 保存 / 丢弃，问完做 `onDone`
  ask: { text: string; onDone: () => void } | null;
}

/// 地址为空时的「保存」：禁用，按下即出「先填地址」
function BlankSave() {
  return (
    <Button variant="primary" disabled disabledReason="先填地址">
      保存
    </Button>
  );
}

/// 连接表单：地址与密钥。保存才生效、保存即拉取；保存中原位忙碌指示 +「正在拉模型」
export function GatewayForm({
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
   * 保存即拉取：带了密钥时后端存之前就先向网关校验、成功时一并拉回模型列表，不拉第二遍；
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
        setError(`已保存，但无法拉取模型列表：${parseBackendError(String(e)).message}`);
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
          spellCheck={false}
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
          placeholder={hasKey ? "已保存，留空则不改" : "粘贴密钥，存进钥匙串"}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div className="gw-form__actions">
        {ask !== null ? (
          // 离开 / 换一行编辑时表单有未保存的改动：不走，在这一行里就地问一句（⑬⑭）
          <>
            <span className="gw-form__ask" role="status">
              {ask.text}
            </span>
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
              variant="quiet"
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
          <Tooltip content="保存后拉取一次模型列表">
            <Button variant="primary" onClick={() => void save()}>
              保存
            </Button>
          </Tooltip>
        )}
        {ask === null ? (
          <Button variant="quiet" onClick={onCancel}>
            取消
          </Button>
        ) : null}
      </div>
      {error !== null ? (
        <div className="gw-form__error">
          <NoticePanel message={error} onClose={() => setError(null)} />
        </div>
      ) : null}
      {/* 只读事实：端口与协议不做成可改 */}
      <p className="gw-form__facts">
        <span>
          本机端口 <span className="gw-form__value">{state.router.port}</span>
        </span>
        <span>
          协议 <span className="gw-form__value">{protocolText(provider?.protocol)}</span>
        </span>
      </p>
    </div>
  );
}

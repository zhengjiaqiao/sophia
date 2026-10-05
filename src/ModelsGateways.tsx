import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { contextMenuHandler } from "./contextMenu.ts";
import { t, tRich } from "./i18n.ts";
import type { MessageKey } from "./i18n.ts";
import { useLeaveGuard } from "./shell/leaveGuard.ts";
import { copyDetails } from "./diagnostics.ts";
import type { ContextMenuItem } from "./contextMenu.ts";
import {
  addGatewayBlocked,
  addressTakenBy,
  addressTakenText,
  copyEmptyText,
  gatewayFacts,
  gatewayShortName,
  otherAgent,
  parseBackendError,
  protocolText,
  refetchSummary,
  removeConfirmText,
  removeProviderBlockedReason,
  switchNeedsConfirm,
  syncCheckLabel,
  unsavedText,
} from "./modelsView.ts";
import type { GatewayChoice, ModelsTool, OtherHome } from "./modelsView.ts";
import { agentGateway } from "./types.ts";
import type { GatewayAgent, GatewayProvider, GatewayState } from "./types.ts";
import {
  AddButton,
  BusySlot,
  Button,
  CheckRow,
  Confirm,
  Details,
  FloatingToast,
  IconButton,
  IconEdit,
  IconRefresh,
  IconTrash,
  ListRow,
  Note,
  NoticePanel,
  RefreshSpin,
  SectionLabel,
  TextField,
  Toast,
  Tooltip,
  TruncTip,
  useBusyShown,
} from "./ui/index.ts";
import { ModelList } from "./ModelList.tsx";

/// Codex 页「第三方模型」一节里的网关小区块（DESIGN「agent 页 › 网关」，D5：网关二级页并进来）。
///
/// 区块小标 `网关`（`SectionLabel`，下 7 一条 hairline）+ 右端 `+ 网关`；**一家网关一行**（列表行 `ListRow`，
/// 与添加来源的候选行同一骨架），行间 `row-line`：
/// - 拉手（前面没有勾选格，常显）｜ 网关短名，第二行 `地址 · 已连接 · 已选 2 / 103`（地址放不下才截断、
///   截断才提示）；无法连接：`地址 · 无法连接 · 原因`（原因写全），行尾出 `再试一次`
/// - 行尾动作列（间距 4）：铅笔（图标键，`编辑`）+ 垃圾桶（图标键，`删掉`；锚在垃圾桶下的确认，
///   地址与密钥一起删）——右沿与节头开关、`+ 网关` 在同一条竖线上
/// - **点整行拉开抽屉＝从这家挑模型**：限制说明 → 440 宽勾选列表；几行可以同时拉开，各自独立；进这一页时每行都收着，只有刚新增成功的那一行自动拉开；Esc 收起
/// - `编辑` / `+ 网关`：表单在这一行的抽屉里就地展开（新网关插在最上面，名字位写 `新网关`）；保存成功、
///   拉到模型后新网关变成普通行并自动拉开，模型整批出现不逐个闪，这一行 surface 行带闪两下
/// - 右键网关行：`编辑` · `删掉…`（D18，与行尾两个入口同一条命令）
/// - 离开这一页（侧栏、⌘, ⌘1…、应用菜单、托盘跳转、⌘[，都经外壳的 `useLeaveGuard`）时表单有没保存的改动：
///   拦下，在那一行里就地问「保存 / 丢弃」，问完再走
///
/// 勾选与模型片读的是 ModelsTab 持有的同一个 GatewayState：勾选 / 取消 / 点节头 `在用` 片的 ×
/// 都是同一件事、实时联动
///
/// **两家共用这一块**（spec 2026-09-29 R43；DESIGN「每家的页 › 网关」「同步由用户选」）：`agent` 说这是哪一家的网关，
/// 只列、只删、只改这一家的；给了 `otherName`（另一家的显示名，注册表给，组件不写死）才有同步那几处——
/// 新建表单 `也加到 <另一家>`（默认勾，另一家已有同一地址时不出）、编辑表单 `<另一家> 里的 X 一起改`（默认勾）、
/// 删网关确认里 `同时删掉 <另一家> 里的 X`（默认不勾，正文随勾选变）、这一家还没有而另一家有时空态 + `带过来`

/// 删网关的确认：删的是哪一家、要不要连另一家同一地址的一起删（确认框在窗口正中）
interface ConfirmingRemove {
  provider: GatewayProvider;
  alsoOther: boolean;
}

/// 确认框、结果小窗挂到 body 上：各家的页是推入页，带着 transform，fixed 的遮罩放在它里面会跟着页面走、压不暗整窗
export function bodyLayer(node: ReactNode): ReactNode {
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

/// 勾选没写成的灰面板：出在那一家展开着的行里
export interface RowNotice {
  providerId: string;
  message: string;
  reason: string;
}

export interface GatewayBlockProps {
  /// 这一家的名字与挑模型时的限制说明（Codex：`CODEX`）
  tool: ModelsTool;
  /// 这是哪一家的网关（缺省 Codex）：只列、只删、只改这一家的
  agent?: GatewayAgent;
  /// 另一家的显示名（注册表给：`Claude Desktop` / `Codex`）。不给就没有同步的勾选与 `带过来`
  otherName?: string | null;
  state: GatewayState;
  /// 这一节正在做一件写 Codex 设置的事：表单的 `保存` 先等它做完
  busy: boolean;
  /// 展开着的行（ModelsTab 持有：它要知道勾选失败的灰面板能不能出在行里）
  expanded: ReadonlySet<string>;
  onToggleRow: (providerId: string) => void;
  onExpand: (providerId: string) => void;
  /// 存网关地址与密钥（密钥省略表示不改），返回这一家的 id。失败时抛出原话。
  /// `sync`：表单里同步那一行勾着（另一家同一地址的一起加 / 一起改）；那一行不出时为 false
  onSave: (input: GatewaySaveInput) => Promise<string>;
  /// 保存之后拉一次模型列表（保存即拉取）
  onFetchModels: (providerId: string) => Promise<void>;
  /// 「再试一次」：按 id 重拉（拉取失败不抛错，原因记在 unreachable 上）
  onRetry: (providerId: string) => Promise<void>;
  /// 删掉这一家（地址与密钥一起删，删除后无法恢复）：确认之后才调。失败时抛出原话。
  /// `alsoOther`：确认框里勾了「同时删掉 <另一家> 里的 X」
  onRemove: (provider: GatewayProvider, alsoOther: boolean) => Promise<void>;
  /// `带过来`：把另一家的网关原样复制到这一家（不确认）。失败时抛出原话。不给就不出这颗键
  onCopy?: () => Promise<void>;
  onToggleModel: (provider: GatewayProvider, modelId: string) => void;
  /// 勾上之前先试调用一次（ModelList `probe`）；抛出＝调不通
  onProbeModel?: (provider: GatewayProvider, modelId: string) => Promise<unknown>;
  notice?: RowNotice | null;
  onCloseNotice?: () => void;
  /// 表单开着且有没保存的改动（ModelsTab 据此拦下离开）
  onDirtyChange?: (dirty: boolean) => void;
  /// 这一块里开着删网关的确认框、或行里的灰面板（删 / 重连没成）：节头上方的新手提示据此让位
  onPanelChange?: (open: boolean) => void;
  /// 删网关的确认框开着：推入页此刻不接 Esc（Esc 只取消确认，不返回）
  onConfirmChange?: (open: boolean) => void;
}

/// 存网关的入参：`sync` 见 `GatewayBlockProps.onSave`
export interface GatewaySaveInput {
  id?: string;
  baseUrl: string;
  key?: string;
  sync: boolean;
}

/// 地址去掉协议头显示（`https://openrouter.ai/api/v1` → `openrouter.ai/api/v1`）；完整值截断时进提示框
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
}

export function GatewayBlock({
  tool,
  agent = "codex",
  otherName = null,
  state,
  busy,
  expanded,
  onToggleRow,
  onExpand,
  onSave,
  onFetchModels,
  onRetry,
  onRemove,
  onCopy,
  onToggleModel,
  onProbeModel,
  notice,
  onCloseNotice,
  onDirtyChange,
  onPanelChange,
  onConfirmChange,
}: GatewayBlockProps) {
  const providers = agentGateway(state, agent)?.providers ?? [];
  /// 另一家：给了名字才有（同步的勾选、删网关确认里那一行、`带过来`）
  const other: OtherHome | null = otherName
    ? { name: otherName, providers: agentGateway(state, otherAgent(agent))?.providers ?? [] }
    : null;
  /// 表单开在哪一行（一次只开一份）；"new" 是最上面那一行新网关
  const [editing, setEditing] = useState<GatewayChoice | null>(null);
  /// 表单里有没保存的改动：离开 / 换一行编辑之前先问
  const [formDirty, setFormDirty] = useState(false);
  /// 想离开但表单还有改动：外壳交过来的「问完之后继续走」
  const [leaveTo, setLeaveTo] = useState<(() => void) | null>(null);
  /// 表单有改动时又点了别的 `编辑` / `+ 网关`：就地问完再换过去
  const [switchTo, setSwitchTo] = useState<GatewayChoice | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  /// 手动重新拉取（行尾 ↻）：正在拉的那一家；拉完、状态换上之后按拉之前的模型算出变化，键下浮一句
  const [refetching, setRefetching] = useState<string | null>(null);
  const [refetched, setRefetched] = useState<{ id: string; before: string[] } | null>(null);
  const [refetchToast, setRefetchToast] = useState<{
    id: string;
    seq: number;
    sentence: MessageKey;
    trail: string[];
  } | null>(null);
  /// 正在删的那一家：垃圾桶锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmingRemove | null>(null);
  /// 删 / 重连没成：灰面板出在那一行里
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  /// `带过来` 进行中 / 没成（空态下就地说）
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  /// 刚新增成功的那一行：surface 行带闪两下（同跳转定位），模型本身整批出现、不逐个闪
  const [addedId, setAddedId] = useState<string | null>(null);
  /// 右键菜单开着的那一行：surface 行带
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const formEl = useRef<HTMLDivElement | null>(null);

  const panelOpen = confirming !== null || rowError !== null || copyError !== null;
  useEffect(() => {
    onPanelChange?.(panelOpen);
  }, [panelOpen, onPanelChange]);
  const confirmOpen = confirming !== null;
  useEffect(() => {
    onConfirmChange?.(confirmOpen);
  }, [confirmOpen, onConfirmChange]);

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

  // 刚新增成功：滚到那一行（行本身 surface 闪两下，见 is-jump）。
  // 新增的那一行在状态回来之后才有：等它挂上再滚
  const jumpTo = addedId;
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

  /// 表单那一行的拉手推回去：没有改动就收起（同 `取消`）；有改动先就地问「保存 / 丢弃」，问完再收
  const closeForm = () => {
    if (formDirty) {
      setLeaveTo(() => () => setEditing(null));
      return;
    }
    trackDirty(false);
    setEditing(null);
  };

  /// 删网关先问一句（确认框在窗口正中）；「同时删掉另一家的」默认不勾（删是破坏性的，默认只动眼前这一家）
  const askRemove = (provider: GatewayProvider) => setConfirming({ provider, alsoOther: false });

  /// 确认之后直接删；这一行从列表里消失
  const remove = ({ provider, alsoOther }: ConfirmingRemove) =>
    void (async () => {
      setConfirming(null);
      setRemoving(provider.id);
      try {
        await onRemove(provider, alsoOther);
      } catch (e) {
        setRowError({ id: provider.id, message: parseBackendError(String(e)).message });
      } finally {
        setRemoving(null);
      }
    })();

  /// `带过来`：不确认（可在这一页删掉）；没成就在空态下说
  const copy = () =>
    void (async () => {
      if (!onCopy || copying) return;
      setCopying(true);
      setCopyError(null);
      try {
        await onCopy();
      } catch (e) {
        setCopyError(parseBackendError(String(e)).message);
      } finally {
        setCopying(false);
      }
    })();

  /// 手动重新拉取：与 `再试一次` 同一个动作（拉失败时这一行转成「无法连接 · 原因」+ `再试一次`）
  const refetch = (p: GatewayProvider) =>
    void (async () => {
      if (refetching !== null) return;
      setRefetching(p.id);
      setRowError(null);
      setRefetchToast(null);
      const before = p.models.map((m) => m.id);
      try {
        await onRetry(p.id);
        setRefetched({ id: p.id, before });
      } catch (e) {
        setRowError({ id: p.id, message: parseBackendError(String(e)).message });
      } finally {
        setRefetching(null);
      }
    })();
  // 拉完后状态换上了才算变化；拉失败（这一行转成无法连接）不浮
  useEffect(() => {
    if (refetched === null) return;
    const p = providers.find((x) => x.id === refetched.id);
    setRefetched(null);
    if (!p || p.unreachable) return;
    setRefetchToast({ id: p.id, seq: Date.now(), ...refetchSummary(refetched.before, p.models) });
  }, [refetched, providers]);

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
          siblings={providers}
          other={other}
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
      <>
        {/* 地址占满放得下的宽度，放不下才截断；截断了才给完整值 */}
        <TruncTip content={p.baseUrl || facts.url} fit="shrink">
          <span className="gw-row__url">{url}</span>
        </TruncTip>
        <span className="gw-row__fact">
          {" · "}
          {facts.statusKind !== "connected" ? (
            <span className="gw-row__down">{facts.status}</span>
          ) : (
            facts.status
          )}
          {facts.picked !== null ? ` · ${facts.picked}` : null}
          {facts.reason !== null ? " · " : null}
        </span>
        {facts.reason !== null ? <span className="gw-row__reason">{facts.reason}</span> : null}
      </>
    );
  };

  /// 右键菜单（D18）：只列此刻能做的——编辑中没有「编辑」，删不得、正在删的没有「删掉…」
  const menuItems = (p: GatewayProvider, isEditing: boolean): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (!isEditing && refetching !== p.id) {
      items.push({ label: t("models.refetch.label"), run: () => refetch(p) });
    }
    if (!isEditing) items.push({ label: t("models.gateway.edit"), run: () => choose(p.id) });
    items.push("separator");
    if (removeProviderBlockedReason(state, p, tool, agent) === null && removing !== p.id) {
      items.push({ label: t("models.gateway.removeMenu"), run: () => askRemove(p) });
    }
    return items;
  };

  /// 行尾动作列（ListRow 给间距 4）：无法连接时 `详情`（有技术原文时，点开是锚在键上的浮层）+ `再试一次`，
  /// 然后铅笔 + 垃圾桶（一对同形的图标键；spec 2026-10-04-local-diagnostics R13，画板 AuPbAQHePv3L1U3g1PAtH8）
  const actions = (p: GatewayProvider, isEditing: boolean) => {
    const blocked = removeProviderBlockedReason(state, p, tool, agent);
    const short = gatewayShortName(p);
    /// 没有读得出的密钥：拉不了模型列表，↻ / `再试一次` 都不出，也不另加「填写密钥」——填密钥就是铅笔「编辑」
    /// （画板 1PxHo6ZoEe8pFCYbU1pAud，2026-10-03 产品负责人：「这样和编辑按钮重复」）
    const canFetch = p.key === "set";
    return (
      <>
        {p.unreachable && p.unreachableDetail && !isEditing ? (
          <Details text={p.unreachableDetail} onCopy={(text) => copyDetails(text)} />
        ) : null}
        {p.unreachable && canFetch && !isEditing ? (
          <BusySlot busy={retrying === p.id} label={t("models.gateway.reconnecting")}>
            <Button size="compact" onClick={() => retrying !== p.id && retry(p.id)}>
              {t("models.gateway.retry")}
            </Button>
          </BusySlot>
        ) : null}
        {isEditing || p.unreachable || !canFetch ? null : (
          // 手动重新拉取（2026-09-30：不自动拉）：连不上时这一位让给 `再试一次`（同一个动作）
          <span className="gw-row__refetch">
            <RefetchKey refetching={refetching === p.id} onRefetch={() => refetch(p)} />
            {refetchToast?.id === p.id ? (
              <FloatingToast key={refetchToast.seq} align="end">
                <Toast
                  kind="success"
                  sentence={refetchToast.sentence}
                  trail={refetchToast.trail}
                  onDismiss={() => setRefetchToast(null)}
                />
              </FloatingToast>
            ) : null}
          </span>
        )}
        {isEditing ? null : (
          <IconButton
            icon={<IconEdit />}
            title={t("models.gateway.edit")}
            onClick={() => choose(p.id)}
          />
        )}
        {blocked === null ? (
          <BusySlot busy={removing === p.id} label={t("models.gateway.removing")}>
            <IconButton
              icon={<IconTrash />}
              title={t("models.gateway.removeTitle", { short })}
              onClick={() => removing !== p.id && askRemove(p)}
            />
          </BusySlot>
        ) : (
          // 最后一家还在供模型：后端会拒，键上就说清下一步（禁用键自带原因提示框，按下即出）
          <IconButton
            icon={<IconTrash />}
            title={t("models.gateway.removeTitle", { short })}
            disabledReason={blocked}
          />
        )}
      </>
    );
  };

  /// 抽屉里＝从这家挑模型：限制说明（不截断）→ 勾选列表。抽屉左沿对齐网关名（ListRow 给）。
  /// 不再列这一家的 `已选` 片：与节头 `在用` 重复（2026-09-25 产品负责人真机：「确实重复了和上面的」）
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
            probe={onProbeModel}
            pickBlockedReason={p.key === "set" ? undefined : t("models.gateway.needKeyToPick")}
          />
        </div>
      ) : (
        <div className="gw-row__none">
          <Note>
            {p.unreachable ? t("models.gateway.noModelsDown") : t("models.gateway.noModels")}
          </Note>
        </div>
      )}
    </div>
  );

  /// 一家一行（列表行 ListRow）：没有勾选格，拉手常显（收起 ›、拉开 ˅，与表格同一个形与方向）；
  /// 点整行拉开抽屉挑模型。编辑时第二行收起、抽屉里换成表单，拉手（或整行、Esc）推回去＝收起表单（有改动先问）
  const row = (p: GatewayProvider) => {
    const open = expanded.has(p.id);
    const isEditing = editing === p.id;
    const short = gatewayShortName(p);
    return (
      <ListRow
        key={p.id}
        title={short}
        sub={isEditing ? undefined : subLine(p)}
        actions={actions(p, isEditing)}
        drawer={isEditing ? form(p) : body(p)}
        open={open || isEditing}
        onToggle={isEditing ? closeForm : () => onToggleRow(p.id)}
        drawerLabel={
          isEditing
            ? t("models.gateway.formDrawer", { name: short })
            : t("models.gateway.modelsDrawer", { short })
        }
        drawerId={`gw-drawer-${p.id}`}
        notice={
          rowError?.id === p.id ? (
            <NoticePanel message={rowError.message} onClose={() => setRowError(null)} />
          ) : undefined
        }
        highlighted={menuRow === p.id}
        onContextMenu={contextMenuHandler(() => menuItems(p, isEditing), {
          onOpen: () => setMenuRow(p.id),
          onClose: () => setMenuRow(null),
        })}
        className={addedId === p.id ? "gw-row--jump" : undefined}
        onAnimationEnd={addedId === p.id ? () => setAddedId(null) : undefined}
        rowRef={(el) => {
          if (el) rowEls.current.set(p.id, el);
          else rowEls.current.delete(p.id);
        }}
      />
    );
  };

  const drafting = editing === "new";
  const copyText = onCopy ? copyEmptyText(other) : null;

  return (
    <div className="gw-block">
      <SectionLabel
        rule
        action={
          <AddButton
            noun={t("models.gateway.noun")}
            label={t("models.gateway.addButton")}
            onClick={() => choose("new")}
            disabledReason={drafting ? addGatewayBlocked() : undefined}
          />
        }
      >
        {t("models.gateway.noun")}
      </SectionLabel>
      {providers.length === 0 && !drafting ? (
        // 空态一句；`+ 网关` 就在正上方，空态不重复按钮。另一家已有网关时换成一句 + `带过来`
        // （两家都有的那几家原样复制过来，不确认、可在这一页删掉）
        <div className="gw-block__empty">
          {copyText !== null ? (
            <>
              <div className="gw-block__copy">
                <Note>{copyText}</Note>
                <BusySlot busy={copying} label={t("models.sync.copying")}>
                  <Button size="compact" onClick={copy}>
                    {t("models.sync.copy")}
                  </Button>
                </BusySlot>
              </div>
              {copyError !== null ? (
                <div className="gw-row__panel">
                  <NoticePanel
                    message={t("models.sync.copyFailed", { other: other?.name ?? "" })}
                    reason={copyError}
                    onClose={() => setCopyError(null)}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <Note>{t("models.gateway.empty")}</Note>
          )}
        </div>
      ) : (
        <div className="gw-list">
          {drafting ? (
            // 新网关：插在列表最上面，名字位写 `新网关`，表单在拉开的抽屉里
            <ListRow
              key="new"
              title={t("models.gateway.newName")}
              drawer={form(null)}
              open
              onToggle={closeForm}
              drawerLabel={t("models.gateway.formDrawer", { name: t("models.gateway.newName") })}
              drawerId="gw-drawer-new"
            />
          ) : null}
          {providers.map(row)}
        </div>
      )}
      {/* 删网关：地址与密钥一起删、删除后无法恢复——先确认（⑬） */}
      {confirming !== null
        ? bodyLayer(
            <RemoveGatewayConfirm
              provider={confirming.provider}
              other={other}
              alsoOther={confirming.alsoOther}
              onAlsoOther={(alsoOther) => setConfirming({ ...confirming, alsoOther })}
              onConfirm={() => remove(confirming)}
              onCancel={() => setConfirming(null)}
            />,
          )
        : null}
    </div>
  );
}

/// 网关行的 ↻（手动重新拉取，提示框 `刷新模型列表`）：按下过了 0.3 秒门槛原位换成转圈（组件库 `RefreshSpin`，
/// 同发现页热门榜单的 ↻），门槛之前键照旧、点不动。行是普通函数画的，门槛的 hook 放在这个小组件里
function RefetchKey({ refetching, onRefetch }: { refetching: boolean; onRefetch: () => void }) {
  const spinning = useBusyShown(refetching);
  // 与被换下的 16px ↻ 同大，转起来图形不缩
  if (spinning) return <RefreshSpin label={t("models.refetch.busy")} size={16} />;
  return (
    <IconButton
      icon={<IconRefresh />}
      title={t("models.refetch.label")}
      onClick={refetching ? undefined : onRefetch}
    />
  );
}

/// 删网关的确认（DESIGN「同步由用户选 › 删网关」，画板 09）：标题 `删掉 ap-gateway？`；另一家有同一地址的网关时
/// 正文下多一行勾选 `同时删掉 Claude Desktop 里的 ap-gateway`（`CheckRow`，默认不勾），正文随勾选变（句子说的就是全部影响）
export function RemoveGatewayConfirm({
  provider,
  other,
  alsoOther,
  onAlsoOther,
  onConfirm,
  onCancel,
}: {
  provider: GatewayProvider;
  other: OtherHome | null;
  alsoOther: boolean;
  onAlsoOther: (next: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const text = removeConfirmText(provider, other, alsoOther);
  return (
    <Confirm
      title={t("models.gateway.confirmTitle", { short: gatewayShortName(provider) })}
      confirmLabel={t("models.gateway.confirmLabel")}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {text.also === null ? (
        text.body
      ) : (
        <>
          {text.body}
          <div className="gw-confirm__also">
            <CheckRow checked={alsoOther} onChange={onAlsoOther}>
              {text.also}
            </CheckRow>
          </div>
        </>
      )}
    </Confirm>
  );
}

interface GatewayFormProps {
  state: GatewayState;
  /// 要改的那一家；null＝新加一家
  provider: GatewayProvider | null;
  /// 这一家的全部网关：地址撞上其中别的一个时就地说、保存不可用（同一家同一地址只能有一个）；不给＝不查
  siblings?: GatewayProvider[];
  /// 另一家（显示名与它的网关）：同步那一行据它出不出、写什么；不给就不出
  other?: OtherHome | null;
  busy: boolean;
  onSave: (input: GatewaySaveInput) => Promise<string>;
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
    <Button variant="primary" size="compact" disabled disabledReason={t("models.form.needUrl")}>
      {t("models.form.save")}
    </Button>
  );
}

/// 地址撞上这一家的另一个网关时的「保存」：禁用，按下即出原因
function BlockedSave({ reason }: { reason: string }) {
  return (
    <Button variant="primary" size="compact" disabled disabledReason={reason}>
      {t("models.form.save")}
    </Button>
  );
}

/// 连接表单：地址与密钥。保存才生效、保存即拉取；保存中原位忙碌指示 +「正在拉模型」
export function GatewayForm({
  state,
  provider,
  siblings = [],
  other = null,
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
  /// 没存成 / 存了没拉到：一句 + 原因 + 技术原文（灰面板的 `详情`）
  const [error, setError] = useState<{ message: string; reason?: string; detail?: string } | null>(
    null,
  );
  /// 同步那一行勾没勾（默认勾上：多数人两家用同一批网关）
  const [syncOn, setSyncOn] = useState(true);
  const syncLabel = syncCheckLabel(provider, baseUrl, other);
  // 读不出的不算「已保存」：占位写「粘贴密钥」，提示重新填写（R5、R6）
  const hasKey = provider?.key === "set";
  // 看得见的标签与输入框关联：读屏读的就是这个字，点标签聚焦输入框
  const fieldId = useId();
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
        sync: syncLabel !== null && syncOn,
      });
    } catch (e) {
      setSaving(false);
      const parsed = parseBackendError(String(e));
      setError({ message: parsed.message, detail: parsed.detail });
      return false;
    }
    if (key === "" && hasKey) {
      try {
        await onFetchModels(id);
      } catch (e) {
        setSaving(false);
        const parsed = parseBackendError(String(e));
        setError({
          message: t("models.form.fetchFailed"),
          reason: parsed.message,
          detail: parsed.detail,
        });
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
  /// 编辑一家地址已经有了、密钥还没有（或读不出）的：要填的只剩密钥，光标直接落在密钥框
  const focusKey = provider !== null && provider.key !== "set";
  const taken = blank ? null : addressTakenBy(siblings, baseUrl, provider?.id);
  const takenText = taken === null ? null : addressTakenText(taken);

  return (
    <div className="gw-form">
      {/* 标签 12 ink-mute 定宽 44，与输入框关联（读屏名就是它，点它聚焦输入框） */}
      <div className="gw-form__field">
        <label className="gw-form__label" id={`${fieldId}-url-label`} htmlFor={`${fieldId}-url`}>
          {t("models.form.urlLabel")}
        </label>
        <TextField
          id={`${fieldId}-url`}
          labelledBy={`${fieldId}-url-label`}
          value={baseUrl}
          autoFocus={!focusKey}
          spellCheck={false}
          placeholder="https://example.com/openai/v1"
          onChange={setBaseUrl}
        />
      </div>
      {takenText !== null ? (
        // 地址撞上这一家的另一个网关：就地说是哪一个，保存不可用（⑩ 预防胜于报错）
        <p className="gw-form__hint" role="status">
          {takenText}
        </p>
      ) : null}
      <div className="gw-form__field">
        <label className="gw-form__label" id={`${fieldId}-key-label`} htmlFor={`${fieldId}-key`}>
          {t("models.form.keyLabel")}
        </label>
        <TextField
          id={`${fieldId}-key`}
          labelledBy={`${fieldId}-key-label`}
          type="password"
          value={apiKey}
          autoFocus={focusKey}
          autoComplete="off"
          placeholder={hasKey ? t("models.form.keySaved") : t("models.form.keyNew")}
          onChange={setApiKey}
        />
      </div>
      {syncLabel !== null ? (
        // 同步由用户选：本来就有的这一步里多一个勾选，不多走一步（⑧）
        <div className="gw-form__sync">
          <CheckRow checked={syncOn} onChange={setSyncOn}>
            {syncLabel}
          </CheckRow>
        </div>
      ) : null}
      <div className="gw-form__actions">
        {ask !== null ? (
          // 离开 / 换一行编辑时表单有未保存的改动：不走，在这一行里就地问一句（⑬⑭）
          <>
            <span className="gw-form__ask" role="status">
              {ask.text}
            </span>
            {blank ? (
              <BlankSave />
            ) : takenText !== null ? (
              <BlockedSave reason={takenText} />
            ) : (
              <Button
                variant="primary"
                size="compact"
                onClick={() => void save().then((ok) => ok && ask.onDone())}
              >
                {t("models.form.save")}
              </Button>
            )}
            <Button
              size="compact"
              onClick={() => {
                onDirtyChange(false);
                ask.onDone();
              }}
            >
              {t("models.form.discard")}
            </Button>
          </>
        ) : saving ? (
          // 存 + 拉模型：键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
          <BusySlot busy label={t("models.form.fetching")}>
            <Button variant="primary" size="compact">
              {t("models.form.save")}
            </Button>
          </BusySlot>
        ) : blank ? (
          <BlankSave />
        ) : takenText !== null ? (
          <BlockedSave reason={takenText} />
        ) : busy ? (
          <Button
            variant="primary"
            size="compact"
            disabled
            disabledReason={t("models.control.busyPrev")}
          >
            {t("models.form.save")}
          </Button>
        ) : (
          <Tooltip content={t("models.form.saveTip")}>
            <Button variant="primary" size="compact" onClick={() => void save()}>
              {t("models.form.save")}
            </Button>
          </Tooltip>
        )}
        {ask === null ? (
          <Button size="compact" onClick={onCancel}>
            {t("models.form.cancel")}
          </Button>
        ) : null}
      </div>
      {error !== null ? (
        <div className="gw-form__error">
          <NoticePanel
            message={error.message}
            reason={error.reason}
            technical={error.detail}
            onCopy={(text) => copyDetails(text)}
            onClose={() => setError(null)}
          />
        </div>
      ) : null}
      {/* 只读事实：端口与协议不做成可改 */}
      <p className="gw-form__facts">
        <span>
          {tRich("models.form.port", {
            port: <span className="gw-form__value">{state.router.port}</span>,
          })}
        </span>
        <span>
          {tRich("models.form.protocol", {
            protocol: <span className="gw-form__value">{protocolText(provider?.protocol)}</span>,
          })}
        </span>
      </p>
    </div>
  );
}

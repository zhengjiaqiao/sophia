import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { copyDetails } from "./diagnostics.ts";
import { parseBackendError } from "./backendError.ts";
import { contextLabel } from "./modelsView.ts";
import { bodyLayer } from "./bodyLayer.tsx";
import { ManualModelRow } from "./ManualModelRow.tsx";
import { ProviderDialog } from "./ProviderDialog.tsx";
import {
  addedLead,
  disableConfirm,
  enableHeadNote,
  filterProviderModels,
  providerAgentsTip,
  providerSubline,
  removeConfirm,
  searchPlaceholder,
} from "./providersView.ts";
import { useLeaveGuard, type Proceed } from "./shell/leaveGuard.ts";
import { usePageCommand, useMenuFlag } from "./shell/menuBus.ts";
import type { ProviderAdded, ProviderModelRow, ProviderRow } from "./types.ts";
import {
  AddButton,
  BusySlot,
  Button,
  CheckRow,
  Confirm,
  CornerToast,
  Empty,
  FloatingLayer,
  IconButton,
  IconChevronDown,
  IconEdit,
  IconRefresh,
  IconTrash,
  ListRow,
  Mono,
  NoticePanel,
  PushedPage,
  RefreshSpin,
  TextField,
  Toast,
  Tooltip,
  motionMs,
  useBusyShown,
  usePushedPage,
} from "./ui/index.ts";
import "./gatewayForm.css";
import "./ProvidersPage.css";

/// 模型提供商页（#252，ADR 0003，画板 9UGdeLt4rvg2dm8SpStvHo 第 3、9 屏；DESIGN「模型 › 模型提供商页」）：模型页页面头
/// `模型提供商` 推入的一页。全局只有一份名单，所有 agent 共用。
///
/// - 页面头：`←` + `模型提供商`，右端 `+ 提供商`
/// - 一家一行：名字；第二行 `地址 · 已启用 N / 总数（推荐）· 3 个 agent`（停在上面说是哪几个 agent）；
///   行尾 `启用模型 ▾`（打开「启用模型」浮层）、↻ 重拉模型、铅笔、垃圾桶
/// - 添加（`+ 提供商`）与编辑（铅笔）都在窗口正中的弹窗里（`ProviderDialog`，第 9 屏）：添加时填好密钥就拉列表、
///   按默认规则先勾好，用户当场改，保存一次加上并启用。保存后弹窗关、新的一行闪一下
/// - 「启用模型」浮层：标题 `X 的模型`、顶上一句写明默认规则、搜索、勾选列表（不分页签）、框底手填 id。
///   勾上之前先试调一次（调不通原话写在那一行），取消有 agent 选着时先确认
/// - 页尾一句 `经本机 47328 转接，Sophia 要开着`
/// - 启用与选是两步（2026-10-08，ADR 0003 修订）：这里启用的只进这一家的已启用名单，不默认选进任何 agent；
///   agent 要用，去模型页它那一行的「选模型」里勾。加完一家的提示条只说启用了几个

const describe = (error: unknown) => parseBackendError(String(error));

export interface ProvidersPageProps {
  /// 路由端口（页尾那一句）
  port: number;
  /// agent id → 显示名（`N 个 agent` 的提示框、删除确认点名用）
  nameOf: (agent: string) => string;
  /// 挂到机面上、盖住模型页；不给就地画（测试）
  host?: () => Element | null;
  covers?: () => Element | null;
  onClose: () => void;
}

export function ProvidersPage({ port, nameOf, host, covers, onClose }: ProvidersPageProps) {
  const pushed = usePushedPage(onClose);
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /// 弹窗开着没有：`row` 为 null 是添加，别的是正在改的那一家
  const [dialog, setDialog] = useState<{ row: ProviderRow | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  /// 想离开但弹窗里还有改动：弹窗问完之后继续走的那一下
  const [leaveTo, setLeaveTo] = useState<Proceed | null>(null);
  /// 「启用模型」浮层开在哪一家、挂在哪颗键上
  const [layer, setLayer] = useState<{
    id: string;
    trigger: HTMLElement;
  } | null>(null);
  /// 刚加进来、正在闪的那一行
  const [flashId, setFlashId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ProviderRow | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [refetching, setRefetching] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
    detail?: string;
  } | null>(null);
  const [toast, setToast] = useState<{ seq: number; node: ReactNode } | null>(null);
  const seq = useRef(0);
  const enableKeys = useRef(new Map<string, HTMLSpanElement>());

  const leave = () => {
    if (dirty) setLeaveTo(() => pushed.leave);
    else pushed.leave();
  };
  usePageCommand("back", leave);
  useMenuFlag("back", !pushed.leaving);
  useLeaveGuard(dirty, (proceed) => setLeaveTo(() => proceed));

  const load = useCallback(async () => {
    try {
      setRows(await api.providersList());
      setLoadError(null);
    } catch (error) {
      setLoadError(describe(error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // 新的一行闪完撤掉标记（时长取 --dur-flash，减少动效时为 0）
  useEffect(() => {
    if (flashId === null) return;
    const timer = window.setTimeout(() => setFlashId(null), motionMs("--dur-flash"));
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const showToast = (node: ReactNode) => {
    seq.current += 1;
    setToast({ seq: seq.current, node });
  };
  const dismissToast = () => setToast(null);

  /// 加完一家的提示条：只说启用了几个（`已启用 2 个模型`；一个没启用时 `已加上 X`）
  const showAdded = (added: ProviderAdded) =>
    showToast(<Toast kind="success" message={addedLead(added)} onDismiss={dismissToast} />);

  const closeDialog = () => {
    setDialog(null);
    setDirty(false);
    setLeaveTo(null);
  };

  const remove = async (row: ProviderRow) => {
    setConfirming(null);
    setRemoving(row.id);
    try {
      setRows(await api.providersRemove(row.id));
      setRowError(null);
    } catch (error) {
      const parsed = describe(error);
      setRowError({
        id: row.id,
        message: parsed.message,
        detail: parsed.detail,
      });
    } finally {
      setRemoving(null);
    }
  };

  const refetch = async (row: ProviderRow) => {
    setRefetching(row.id);
    try {
      setRows(await api.providersRefetch(row.id));
      setRowError(null);
    } catch (error) {
      const parsed = describe(error);
      setRowError({
        id: row.id,
        message: parsed.message,
        detail: parsed.detail,
      });
      await load();
    } finally {
      setRefetching(null);
    }
  };

  const layerRow = layer === null ? null : (rows?.find((r) => r.id === layer.id) ?? null);
  const removeText = confirming === null ? null : removeConfirm(confirming, nameOf);

  return (
    <PushedPage
      {...pushed}
      leave={leave}
      title={t("models.providers.title")}
      host={host}
      covers={covers}
      escape={confirming === null && layer === null && dialog === null}
      actions={
        <AddButton
          noun={t("models.providers.addNoun")}
          label={t("models.providers.addLabel")}
          onClick={() => setDialog({ row: null })}
        />
      }
    >
      <div className="providers">
        {loadError !== null ? (
          <NoticePanel
            scope="section"
            message={loadError}
            action={{
              label: t("models.gateway.retry"),
              onClick: () => void load(),
            }}
          />
        ) : null}
        {rows !== null && rows.length === 0 ? (
          <Empty description={t("models.providers.empty")} />
        ) : null}
        {rows !== null && rows.length > 0 ? (
          <div className="providers__list">
            {rows.map((row) => {
              const tip = providerAgentsTip(row, nameOf);
              const sub = providerSubline(row);
              const issue = rowIssue(row);
              return (
                <ListRow
                  key={row.id}
                  drawerColumn={false}
                  flash={flashId === row.id}
                  title={row.name}
                  sub={
                    <>
                      {tip ? (
                        <Tooltip content={tip}>
                          <span tabIndex={0}>{sub}</span>
                        </Tooltip>
                      ) : (
                        sub
                      )}
                      {issue ? <span className="providers__issue"> · {issue}</span> : null}
                    </>
                  }
                  actions={
                    <>
                      <span
                        className="providers__enable"
                        ref={(el) => {
                          if (el) enableKeys.current.set(row.id, el);
                          else enableKeys.current.delete(row.id);
                        }}
                      >
                        <Button
                          size="compact"
                          ariaExpanded={layer?.id === row.id}
                          ariaHasPopup="dialog"
                          onClick={() => {
                            const trigger = enableKeys.current.get(row.id);
                            if (trigger) setLayer({ id: row.id, trigger });
                          }}
                        >
                          {t("models.providers.enableModels")}
                          <IconChevronDown />
                        </Button>
                      </span>
                      <RefetchKey
                        busy={refetching === row.id}
                        onRefetch={() => void refetch(row)}
                      />
                      <IconButton
                        icon={<IconEdit />}
                        title={t("models.providers.editLabel")}
                        onClick={() => setDialog({ row })}
                      />
                      <BusySlot busy={removing === row.id} label={t("models.gateway.removing")}>
                        <IconButton
                          icon={<IconTrash />}
                          title={t("models.providers.removeButton")}
                          onClick={() => setConfirming(row)}
                        />
                      </BusySlot>
                    </>
                  }
                  notice={
                    rowError?.id === row.id ? (
                      <NoticePanel
                        message={rowError.message}
                        technical={rowError.detail}
                        onCopy={(text) => copyDetails(text)}
                        onClose={() => setRowError(null)}
                      />
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        ) : null}
        <p className="providers__via">{t("models.providers.via", { port })}</p>
      </div>
      {dialog !== null && rows !== null ? (
        <ProviderDialog
          key={dialog.row?.id ?? "new"}
          row={dialog.row}
          rows={rows}
          onDirty={setDirty}
          ask={leaveTo}
          onWithdraw={() => setLeaveTo(null)}
          onClose={closeDialog}
          onSaved={(next, added) => {
            setRows(next);
            closeDialog();
            if (added) {
              setFlashId(added.id);
              showAdded(added);
            }
          }}
        />
      ) : null}
      {layer !== null && layerRow !== null ? (
        <EnableLayer
          row={layerRow}
          trigger={layer.trigger}
          nameOf={nameOf}
          onRows={setRows}
          onClose={() => setLayer(null)}
        />
      ) : null}
      {confirming !== null && removeText !== null
        ? bodyLayer(
            <Confirm
              title={removeText.title}
              confirmLabel={t("models.providers.removeLabel")}
              onConfirm={() => void remove(confirming)}
              onCancel={() => setConfirming(null)}
            >
              {removeText.body}
            </Confirm>,
          )
        : null}
      {toast ? <CornerToast key={toast.seq}>{toast.node}</CornerToast> : null}
    </PushedPage>
  );
}

/// 行上的问题：没有密钥、密钥读不出、拉模型失败（原因已是当前语言的一句）
function rowIssue(row: ProviderRow): string | null {
  if (row.key === "missing") return t("models.gateway.noKey");
  if (row.key === "unreadable") return row.keyProblem ?? t("models.gateway.keyUnreadable");
  if (row.unreachable !== null) return row.unreachable;
  return null;
}

/// 行尾 ↻：重拉模型列表；过了 0.3 秒门槛原位转圈
function RefetchKey({ busy, onRefetch }: { busy: boolean; onRefetch: () => void }) {
  const spinning = useBusyShown(busy);
  if (spinning) return <RefreshSpin label={t("models.refetch.busy")} size={16} />;
  return (
    <IconButton
      icon={<IconRefresh />}
      title={t("models.refetch.label")}
      onClick={busy ? undefined : onRefetch}
    />
  );
}

/// 「启用模型」浮层（画板第 3 屏右上）：标题、顶上一句写明默认规则、搜索、勾选列表（不分页签）、框底手填 id。
/// 勾上之前先试一次（调不通原话写在那一行、不勾）；取消：有 agent 选着时先确认，点名是哪几个
function EnableLayer({
  row,
  trigger,
  nameOf,
  onRows,
  onClose,
}: {
  row: ProviderRow;
  trigger: HTMLElement;
  nameOf: (agent: string) => string;
  onRows: (rows: ProviderRow[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  /// 正在试调的那一个
  const [probing, setProbing] = useState<string | null>(null);
  /// 调不通的：模型 id → 原因
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<ProviderModelRow | null>(null);
  const shown = filterProviderModels(row.models, query);

  const toggle = async (model: ProviderModelRow, on: boolean) => {
    if (on) setProbing(model.id);
    try {
      onRows(await api.providersSetEnabled(row.id, model.id, on));
      setFailed((prev) => {
        const copy = { ...prev };
        delete copy[model.id];
        return copy;
      });
    } catch (error) {
      setFailed((prev) => ({ ...prev, [model.id]: describe(error).message }));
    } finally {
      setProbing(null);
    }
  };

  const ask = confirming === null ? null : disableConfirm(confirming, nameOf);

  return (
    <>
      <FloatingLayer
        trigger={trigger}
        onClose={() => {
          if (confirming === null) onClose();
        }}
        role="dialog"
        align="end"
        list
        label={t("models.providers.layerTitle", { name: row.name })}
        className="providers-layer"
      >
        <div className="providers-layer__head">
          <div className="providers-layer__title">
            {t("models.providers.layerTitle", { name: row.name })}
          </div>
          <div className="providers-layer__note">{enableHeadNote(row)}</div>
          <TextField
            search
            label={searchPlaceholder(row)}
            value={query}
            autoFocus
            spellCheck={false}
            placeholder={searchPlaceholder(row)}
            onChange={setQuery}
          />
        </div>
        <div className="providers-layer__rows">
          {row.models.length === 0 ? (
            <p className="providers-layer__empty">{t("models.providers.noModels")}</p>
          ) : shown.length === 0 ? (
            <p className="providers-layer__empty">{t("models.list.noMatch")}</p>
          ) : (
            <div className="providers-layer__checks">
              {shown.map((model) => {
                const on = model.enabledBy !== null;
                const context = contextLabel(model.contextWindow);
                const note =
                  probing === model.id
                    ? t("models.probeUi.probing")
                    : failed[model.id] !== undefined
                      ? t("models.providers.probeFailed", { reason: failed[model.id] })
                      : undefined;
                return (
                  <CheckRow
                    key={model.id}
                    checked={on}
                    label={model.id}
                    note={note}
                    disabledReason={
                      probing !== null && probing !== model.id
                        ? t("models.control.busyPrev")
                        : undefined
                    }
                    trailing={context ? <Mono>{context}</Mono> : undefined}
                    onChange={(next) => {
                      if (probing !== null) return;
                      if (!next && disableConfirm(model, nameOf) !== null) {
                        setConfirming(model);
                        return;
                      }
                      void toggle(model, next);
                    }}
                  >
                    {model.displayName ?? model.id}
                  </CheckRow>
                );
              })}
            </div>
          )}
        </div>
        <div className="providers-layer__foot">
          <ManualModelRow
            placeholder={t("models.providers.typedPlaceholder")}
            addLabel={t("models.providers.typedAdd")}
            doneText={(model) => t("models.providers.typedDone", { model })}
            onAdd={async (model) => {
              onRows(await api.providersAddTyped(row.id, model));
              return model.trim();
            }}
          />
        </div>
      </FloatingLayer>
      {confirming !== null && ask !== null
        ? bodyLayer(
            <Confirm
              title={ask.title}
              confirmLabel={t("models.providers.disableLabel")}
              onConfirm={() => {
                const model = confirming;
                setConfirming(null);
                void toggle(model, false);
              }}
              onCancel={() => setConfirming(null)}
            >
              {ask.body}
            </Confirm>,
          )
        : null}
    </>
  );
}

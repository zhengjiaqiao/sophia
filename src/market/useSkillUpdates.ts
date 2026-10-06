/// 「有更新」的状态与动作（spec 2026-09-27-skill-mcp-market R14 R15 R16）。
///
/// - **何时查**：SKILLS 页挂上时调一次 `marketCheckUpdates(false)`——距上次超过 6 小时、开关开着才真去联网，
///   这两条由 core 管；设置里的 `立即检查` 传 true。自动检查的失败与限流一句不说（检查本身不另外提示）。
/// - **在触发处说**：用户按下的（`立即检查`、提示条的 `全部更新`、抽屉的 `更新`）被限流或做不成，`notice`
///   记下是哪一处按的，那一处浮起一句；不弹窗、不自动重试。
/// - **更新**：涉及的 skill 本地都没改过就直接更新、右下纸窗带 `撤销`；有改过的先出确认框（`confirm`），
///   按了才传 `overwriteModified`。更新成了的从列表里拿掉，撤销再放回。
///
/// 状态放在模块里的一份 store（`createUpdateStore`）：SKILLS 页与设置页看的是同一份结果——设置里查完，
/// 回到 SKILLS 页提示条就在。store 不碰 React，tests/market-update.test.ts 换假的 core 直接测。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api.ts";
import { subscribeLocale, t } from "../i18n.ts";
import type { InstallOutcome, UpdateCheck, UpdateInfo, UpdateTarget } from "../types.ts";
import {
  afterUpdate,
  dismissBatch,
  fallbackNotice,
  needsConfirm,
  restoreUpdates,
  updateKey,
  updatedToast,
  type UpdateToastModel,
} from "./updateView.ts";

/// 谁按的：自动检查、设置的 `立即检查`、提示条的 `全部更新`、某一行抽屉的 `更新`（`row:` + updateKey）
export type UpdateTrigger = "auto" | "settings" | "strip" | `row:${string}`;

export function rowTrigger(u: { location: string; name: string }): UpdateTrigger {
  return `row:${updateKey(u)}`;
}

/// 接 core 的几条命令；默认是 api.ts，测试里换成假的
export interface UpdateBackend {
  check(force: boolean): Promise<UpdateCheck>;
  update(targets: UpdateTarget[], overwriteModified: boolean): Promise<InstallOutcome>;
  undo(undoId: string): Promise<unknown>;
  dismiss(treeShas: string[]): Promise<void>;
}

export interface UpdateSnapshot {
  /// 拿到过一次查更新的结果（设置里 `· 2 个有更新` 只在拿到之后写）
  loaded: boolean;
  /// 全部位置的新版本；当前位置的由页面按 `scopeUpdates` 筛
  updates: UpdateInfo[];
  checkedAt: number | null;
  /// core 说这一批没被 × 掉
  stripVisible: boolean;
  /// 正在查：谁按的
  checking: UpdateTrigger | null;
  /// 正在更新：谁按的
  busy: UpdateTrigger | null;
  /// 在触发处浮起的一句（限流、做不成）；`at` 让同一处连着两次时从头计时
  notice: { trigger: UpdateTrigger; text: string; at: number } | null;
  /// 有本地改动，等用户确认
  confirm: { targets: UpdateInfo[]; trigger: UpdateTrigger } | null;
  /// 更新之后右下那一窗；`undoId` 非空才给 `撤销`
  result: { toast: UpdateToastModel; undoId: string | null; at: number } | null;
  /// 撤销在等
  undoing: boolean;
  /// 最近一次能撤销的更新：纸窗收起之后 ⌘Z 照旧能撤（与位置页其他写入同一个规矩），撤过、撤不成就清掉
  lastUndoId: string | null;
  /// 设置里按了 `看 N 个更新`：SKILLS 页挂上时打开 `只看这些`，接过去就清掉
  wantOnlyThese: boolean;
}

const EMPTY: UpdateSnapshot = {
  loaded: false,
  updates: [],
  checkedAt: null,
  stripVisible: false,
  checking: null,
  busy: null,
  notice: null,
  confirm: null,
  result: null,
  undoing: false,
  lastUndoId: null,
  wantOnlyThese: false,
};

export interface UpdateStore {
  get(): UpdateSnapshot;
  subscribe(listener: () => void): () => void;
  /// 文件真的变了（更新、撤销成了）：页面据此重扫
  onFilesChanged(listener: () => void): () => void;
  /// 查一次。同一时刻只查一次，重复的按下直接等那一次
  check(force: boolean, trigger: UpdateTrigger): Promise<void>;
  /// 按 ×：这一批不再提
  dismiss(): Promise<void>;
  /// 设置的 `看 N 个更新`：请 SKILLS 页打开 `只看这些`（`take` 接过去）
  askOnlyThese(): void;
  takeOnlyThese(): boolean;
  /// 按 `全部更新` / `更新`：有本地改动先确认，否则直接更新
  request(targets: UpdateInfo[], trigger: UpdateTrigger): Promise<void>;
  /// 确认框里按了 `全部更新` / `更新`
  confirm(): Promise<void>;
  cancel(): void;
  /// 纸窗里的 `撤销`（也是 ⌘Z）
  undo(): Promise<void>;
  clearNotice(): void;
  clearResult(): void;
  /// 页面卸下：确认框、纸窗、浮起的一句都收起（结果留着）
  clearTransient(): void;
}

export function createUpdateStore(backend: UpdateBackend): UpdateStore {
  let state: UpdateSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  const changed = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  /// 上一次更新拿掉的：撤销时放回
  let removed: UpdateInfo[] = [];

  const set = (patch: Partial<UpdateSnapshot>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const say = (trigger: UpdateTrigger, text: string) =>
    trigger === "auto" ? undefined : set({ notice: { trigger, text, at: Date.now() } });
  const filesChanged = () => changed.forEach((l) => l());

  const run = async (targets: UpdateInfo[], overwrite: boolean, trigger: UpdateTrigger) => {
    set({ busy: trigger, notice: null, result: null });
    try {
      const outcome = await backend.update(
        targets.map((u) => ({ location: u.location, name: u.name })),
        overwrite,
      );
      const { rest, removed: gone } = afterUpdate(state.updates, targets, outcome.installed);
      removed = gone;
      const toast = updatedToast(outcome);
      const undoId = toast.undoable ? outcome.undoId : null;
      set({
        busy: null,
        updates: rest,
        stripVisible: state.stripVisible && rest.length > 0,
        result: { toast, undoId, at: Date.now() },
        lastUndoId: undoId,
      });
      if (outcome.installed.length > 0) filesChanged();
    } catch (e) {
      set({ busy: null });
      say(trigger, String(e));
    }
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onFilesChanged(listener) {
      changed.add(listener);
      return () => changed.delete(listener);
    },
    check(force, trigger) {
      if (inflight) return inflight;
      set({ checking: trigger, notice: trigger === "auto" ? state.notice : null });
      inflight = (async () => {
        try {
          const r = await backend.check(force);
          // 设置里按 `立即检查` 是主动要看（2026-09-27 产品负责人：检查完回到 skill 列表要有提示）：
          // 查到的这一批即使以前 × 掉过，也重新提示，关掉的记录一并清掉
          const manual = trigger === "settings" && r.updates.length > 0;
          set({
            loaded: true,
            updates: r.updates,
            checkedAt: r.checkedAt,
            stripVisible: manual || r.stripVisible,
            checking: null,
          });
          if (manual && !r.stripVisible) {
            await backend.dismiss([]).catch(() => undefined);
          }
          const notice = fallbackNotice(r.fallback);
          if (notice !== null) say(trigger, notice);
        } catch (e) {
          set({ checking: null });
          say(trigger, String(e));
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    async dismiss() {
      const batch = dismissBatch(state.updates);
      set({ stripVisible: false });
      try {
        await backend.dismiss(batch);
      } catch (e) {
        // 没记下：这一程照样收起，下次打开还会再出（不为一条提示条打断用户）
        console.warn(t("market.update.dismissNotSaved"), e);
      }
    },
    askOnlyThese() {
      set({ wantOnlyThese: true, stripVisible: state.updates.length > 0 || state.stripVisible });
    },
    takeOnlyThese() {
      if (!state.wantOnlyThese) return false;
      set({ wantOnlyThese: false });
      return true;
    },
    async request(targets, trigger) {
      if (targets.length === 0 || state.busy !== null) return;
      if (needsConfirm(targets)) {
        set({ confirm: { targets, trigger }, notice: null });
        return;
      }
      await run(targets, false, trigger);
    },
    async confirm() {
      const pending = state.confirm;
      if (pending === null) return;
      set({ confirm: null });
      await run(pending.targets, true, pending.trigger);
    },
    cancel() {
      set({ confirm: null });
    },
    async undo() {
      const undoId = state.lastUndoId ?? state.result?.undoId;
      if (!undoId || state.undoing) return;
      set({ undoing: true });
      try {
        await backend.undo(undoId);
        const back = removed;
        removed = [];
        set({
          undoing: false,
          result: null,
          lastUndoId: null,
          updates: restoreUpdates(state.updates, back),
        });
        filesChanged();
      } catch (e) {
        set({
          undoing: false,
          lastUndoId: null,
          result: {
            toast: {
              kind: "cannot",
              sentence: "market.toast.undoCannot",
              reason: String(e),
              undoable: false,
            },
            undoId: null,
            at: Date.now(),
          },
        });
      }
    },
    clearNotice() {
      set({ notice: null });
    },
    clearResult() {
      set({ result: null });
    },
    clearTransient() {
      set({ notice: null, confirm: null, result: null });
    },
  };
}

/// 全应用一份，接 core
export const updateStore = createUpdateStore({
  check: (force) => api.marketCheckUpdates(force),
  update: (targets, overwrite) => api.marketUpdateSkills(targets, overwrite),
  undo: (undoId) => api.marketUndo(undoId),
  dismiss: (treeShas) => api.marketDismissUpdates(treeShas),
});

// 浮起的那一句（`notice`）存的是成句：换了界面语言就收起，不留一句旧语言的话
subscribeLocale(() => updateStore.clearNotice());

export interface SkillUpdatesOptions {
  /// SKILLS 页此刻挂着：挂上时查一次（force=false，6 小时与开关归 core）。设置页不给
  active?: boolean;
  /// 更新 / 撤销成了，文件变了：页面重扫
  onFilesChanged?: () => void;
}

export interface SkillUpdates extends UpdateSnapshot {
  /// 表格只列有更新的行（提示条的 `只看这些`）；这一页自己的，不进 store
  onlyThese: boolean;
  setOnlyThese: (on: boolean) => void;
  /// 设置的 `立即检查`
  refresh: () => void;
  /// 设置的 `看 N 个更新`：请 SKILLS 页打开 `只看这些`、提示条亮着
  showInList: () => void;
  /// 提示条的 `全部更新`：传当前位置的那几条
  updateAll: (targets: UpdateInfo[]) => void;
  /// 抽屉末行的 `更新`
  updateOne: (u: UpdateInfo) => void;
  /// 提示条的 ×
  dismiss: () => void;
  confirmUpdate: () => void;
  cancelUpdate: () => void;
  /// 纸窗里的 `撤销`（也是 ⌘Z，纸窗收起之后照旧）；此刻没有可撤销的更新时为 null（页面据此亮 ⌘Z）
  undo: (() => void) | null;
  clearNotice: () => void;
  clearResult: () => void;
  /// 某一处此刻要浮起的一句
  noticeFor: (trigger: UpdateTrigger) => string | null;
}

/// 一页只用一份（卸下时收起确认框与纸窗）：SKILLS 页给 `active`，设置页不给
export function useSkillUpdates(
  { active = false, onFilesChanged }: SkillUpdatesOptions = {},
  store: UpdateStore = updateStore,
): SkillUpdates {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [onlyThese, setOnlyThese] = useState(false);

  useEffect(() => {
    if (active) void store.check(false, "auto");
  }, [active, store]);

  // 设置里按了 `看 N 个更新`：这一页挂上时接过去，打开 `只看这些`
  useEffect(() => {
    if (active && snap.wantOnlyThese && store.takeOnlyThese()) setOnlyThese(true);
  }, [active, snap.wantOnlyThese, store]);

  // 回调每次渲染可以是新函数：经 ref 读最新的，只订一次
  const filesChanged = useRef(onFilesChanged);
  filesChanged.current = onFilesChanged;
  useEffect(() => store.onFilesChanged(() => filesChanged.current?.()), [store]);

  // 页面卸下：确认框、纸窗、浮起的一句跟着收起
  useEffect(() => () => store.clearTransient(), [store]);

  // 都更新完了（或都没了）：回到全部
  useEffect(() => {
    if (snap.updates.length === 0) setOnlyThese(false);
  }, [snap.updates.length]);

  // 交给子组件当 effect 依赖的（纸窗的 onDismiss 等）：身份不随渲染变，否则计时每次重来
  const actions = useMemo(
    () => ({
      refresh: () => void store.check(true, "settings"),
      showInList: () => store.askOnlyThese(),
      updateAll: (targets: UpdateInfo[]) => void store.request(targets, "strip"),
      updateOne: (u: UpdateInfo) => void store.request([u], rowTrigger(u)),
      dismiss: () => {
        setOnlyThese(false);
        void store.dismiss();
      },
      confirmUpdate: () => void store.confirm(),
      cancelUpdate: () => store.cancel(),
      runUndo: () => void store.undo(),
      clearNotice: () => store.clearNotice(),
      clearResult: () => store.clearResult(),
    }),
    [store],
  );
  const { runUndo, ...rest } = actions;

  return {
    ...snap,
    ...rest,
    onlyThese,
    setOnlyThese,
    undo: snap.lastUndoId || snap.result?.undoId ? runUndo : null,
    noticeFor: (trigger) => (snap.notice?.trigger === trigger ? snap.notice.text : null),
  };
}

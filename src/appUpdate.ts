import { netProblemOf, type NetKind } from "./netFailure.ts";

/// Sophia 自己的新版本（DESIGN「设置 › 检查更新」「壳：侧栏 › 更新键」）。
///
/// - **何时查**：启动时一次；应用开着时，距上次查超过 6 小时再查一次。这两种都静默：查不成一句不说。
///   设置「关于」的 `检查更新`、应用菜单「检查更新…」是手动查，结果由按下的那一处说。
/// - **点了才下载**：流量和磁盘是用户的（产品负责人 2026-09-30 再次确认）。侧栏的更新键与设置的待办条
///   是同一个动作的两个入口。
/// - **一份状态**：侧栏与设置页读同一份 store——在侧栏点了下载，进设置看到的是同一条进度；
///   离开设置页下载也不会丢。
///
/// store 不碰 React、不碰 Tauri：后端由调用方给（`useAppUpdate.ts` 接 updater 插件），
/// tests/app-update.test.ts 换假的直接测。

/// 查到的一个新版本：能下载并安装
export interface AppUpdateHandle {
  version: string;
  /// 下载并安装；`percent` 拿不到总大小时是 null
  download(onProgress: (percent: number | null) => void): Promise<void>;
}

export interface AppUpdateBackend {
  /// 没有新版时给 null；查不成抛出
  check(): Promise<AppUpdateHandle | null>;
  relaunch(): Promise<void>;
  now(): number;
}

/// 这件事的五种处境。`available` 与 `failed` 在侧栏都是纸面键（点了下载 / 重试），
/// `downloading` 是展开的进度，`installed` 是墨键（点了重启）
export type AppUpdatePhase =
  | { kind: "none" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installed"; version: string }
  /// 下载失败：`cause` 是后端分的四类之一（界面按「下载更新」场景出主句与出口），`detail` 是原文（进「!」）
  | { kind: "failed"; version: string; cause: NetKind; detail: string };

export interface AppUpdateSnapshot {
  phase: AppUpdatePhase;
  /// 上一次查（不论查没查成）的时刻；还没查过是 null
  lastCheckedAt: number | null;
}

/// 距上次超过这么久，后台再查一次（同 skill 更新的节奏）
export const RECHECK_MS = 6 * 60 * 60 * 1000;
/// 多久看一眼「到没到 6 小时」：睡眠醒来后最多晚这么久补查
export const RECHECK_TICK_MS = 10 * 60 * 1000;

export interface AppUpdateStore {
  get(): AppUpdateSnapshot;
  subscribe(listener: () => void): () => void;
  /// 后台查：启动时。查不成一句不说
  checkQuietly(): Promise<void>;
  /// 距上次超过 6 小时才查（定时器每隔一会儿调一次）
  checkIfDue(): Promise<void>;
  /// 手动查：有没有新版；查不成抛出，由按下的那一处说
  checkNow(): Promise<boolean>;
  /// 下载并安装（侧栏的纸面键、待办条的 `下载并安装` / `再试一次`）
  install(): Promise<void>;
  /// 装好之后重启（侧栏的墨键、待办条的 `重启`）
  relaunch(): Promise<void>;
}

const NONE: AppUpdateSnapshot = { phase: { kind: "none" }, lastCheckedAt: null };

export function createAppUpdateStore(backend: AppUpdateBackend): AppUpdateStore {
  let state = NONE;
  const listeners = new Set<() => void>();
  /// 最近查到的那个版本：下载要用它
  let handle: AppUpdateHandle | null = null;
  let inflight: Promise<AppUpdateHandle | null> | null = null;

  const set = (patch: Partial<AppUpdateSnapshot>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  /// 正在下、已装好等重启：再查也不改处境（装好的那一版要重启才算数，查回来的还是它）
  const settled = () => state.phase.kind === "downloading" || state.phase.kind === "installed";

  /// 同一时刻只查一次：手动按下时后台那一次还没回来，就等那一次
  const run = () => {
    if (inflight) return inflight;
    inflight = backend.check().finally(() => {
      inflight = null;
      set({ lastCheckedAt: backend.now() });
    });
    return inflight;
  };

  /// 查回来之后：`keepFailure` 时（后台查）不冲掉上次下载失败的原因
  const apply = (found: AppUpdateHandle | null, keepFailure: boolean) => {
    if (settled()) return;
    handle = found;
    if (found === null) {
      set({ phase: { kind: "none" } });
      return;
    }
    if (keepFailure && state.phase.kind === "failed" && state.phase.version === found.version)
      return;
    set({ phase: { kind: "available", version: found.version } });
  };

  const checkQuietly = async () => {
    if (settled()) return;
    try {
      apply(await run(), true);
    } catch {
      // 离线、还没配公钥、开发模式：没查成不是用户此刻要处理的事
    }
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkQuietly,
    async checkIfDue() {
      const last = state.lastCheckedAt;
      if (last !== null && backend.now() - last < RECHECK_MS) return;
      await checkQuietly();
    },
    async checkNow() {
      if (settled()) return true;
      const found = await run();
      apply(found, false);
      return found !== null;
    },
    async install() {
      const phase = state.phase;
      if (phase.kind !== "available" && phase.kind !== "failed") return;
      set({ phase: { kind: "downloading", version: phase.version, percent: null } });
      try {
        // 重试时先重新查一次：上一次的下载句柄不保证还能用
        const target = phase.kind === "failed" || handle === null ? await backend.check() : handle;
        if (target === null) {
          handle = null;
          set({ phase: { kind: "none" } });
          return;
        }
        handle = target;
        const version = target.version;
        await target.download((percent) =>
          set({ phase: { kind: "downloading", version, percent } }),
        );
        set({ phase: { kind: "installed", version } });
      } catch (e) {
        const { kind, detail } = netProblemOf(e);
        set({ phase: { kind: "failed", version: phase.version, cause: kind, detail } });
      }
    },
    async relaunch() {
      if (state.phase.kind !== "installed") return;
      await backend.relaunch();
    },
  };
}

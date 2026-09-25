/// 新手提示（DESIGN「组件 › 新手提示条 HintStrip」「设置 › 关于」）。
///
/// 第一次走到某处时在内容上方铺一条说明；关掉（×）或做了它教的事就不再出。
/// 看过的 id 存 core（`settings.json` 的 `seenHints`），这里是全应用共用的一个模块级小 store：
/// 读一次、乐观更新后写 core。页面用 `useHint`，不进 App。
///
/// 规则（DESIGN 表下那一段）：
/// - 一次只出一条：整个应用同一时刻最多一条可见，几条同时有资格时按登记表顺序取第一条
/// - `×` 关掉＝记看过；首次扫描两条互斥，关掉其中一条＝两条都记看过（用户不要引导）
/// - 学会（做了它教的事）＝只记它自己，并收起
/// - 页面上已有灰面板 / 确认时让位（调用方传 `blocked`）：这次到访不再出，下次再出
import { createElement, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { StateDot } from "./ui/StateDot.tsx";
import { api } from "./api.ts";

export type HintId = "first-scan-skills" | "first-scan-empty" | "first-codex";

/// 登记表顺序＝优先级：同时有资格时前面的先出
export const HINT_ORDER: readonly HintId[] = [
  "first-scan-skills",
  "first-scan-empty",
  "first-codex",
];

export interface HintEntry {
  /// 说明句原文，照 DESIGN 表逐字；● ○ 在渲染时换成表格里的真记号
  text: string;
  /// 渲染用：句中 ● ○ 换成 `StateDot`
  sentence: ReactNode;
}

/// 句中的 ● ○ 画成表格里的真记号（已加上 / 没加上），其余原样
function withMarks(text: string): ReactNode {
  const parts = text.split(/([●○])/);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part === "●") return createElement(StateDot, { key: i, dot: "linked", label: "实心点" });
    if (part === "○") return createElement(StateDot, { key: i, dot: "missing", label: "空心环" });
    return part;
  });
}

function entry(text: string): HintEntry {
  return { text, sentence: withMarks(text) };
}

/// 今天的三条（DESIGN「今天有三条」）。以后加新的，同一个组件、同一套规则，并在 DESIGN 的表里登记
export const HINTS: Record<HintId, HintEntry> = {
  "first-scan-skills": entry(
    "一行一个 skill，一列一个 agent。● 已加上，○ 没加上——点一下格子就加上或移除。",
  ),
  "first-scan-empty": entry(
    "Sophia 把各个 agent 的 skill 放在一张表里。先按右上角 + 来源，加一个 skill 文件夹。",
  ),
  "first-codex": entry(
    "打开第三方模型，Codex 就能用你在下面网关里选的模型；改了之后重启 Codex 才生效。",
  ),
};

/// 首次扫描那两条互斥：关掉其中一条，两条都记看过
const FIRST_SCAN: readonly HintId[] = ["first-scan-skills", "first-scan-empty"];

/// 点 × 关掉这一条要记哪些 id
export function dismissIds(id: HintId): HintId[] {
  return FIRST_SCAN.includes(id) ? [...FIRST_SCAN] : [id];
}

/// 学会这一条要记哪些 id：只记它自己（空库那条学会后，表里有了 skill，教点格子那条还会出一次）
export function learnIds(id: HintId): HintId[] {
  return [id];
}

/// 此刻该出哪一条：还没读到看过表时一条都不出；否则在「有资格」里按登记表顺序取第一条没看过的
export function pickHint(
  claimed: Iterable<HintId>,
  seen: ReadonlySet<string> | null,
): HintId | null {
  if (seen === null) return null;
  const want = new Set(claimed);
  return HINT_ORDER.find((id) => want.has(id) && !seen.has(id)) ?? null;
}

/// 看过表的持久化：默认接 core（api.ts），测试里换成假的
export interface HintPersist {
  list(): Promise<string[]>;
  mark(id: string): Promise<void>;
}

export interface HintSnapshot {
  /// 看过表读到了没有（没读到时一条都不出）
  loaded: boolean;
  /// 看过的 id（读到的 ∪ 这次运行里记下的）
  seen: ReadonlySet<string>;
  /// 此刻整个应用唯一可见的那一条
  visible: HintId | null;
}

export interface HintStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HintSnapshot;
  /// 读一次看过表；读过就不再读。读失败时保持「没读到」（安静，不出提示），下次调用重试
  load(): Promise<void>;
  /// 声明「这一条此刻有资格出」；返回撤销函数。同一时刻只有按顺序排第一的那条可见
  claim(id: HintId): () => void;
  /// 点 × 关掉
  dismiss(id: HintId): void;
  /// 做了它教的事；已看过时什么也不做（点格子这种高频动作可以放心每次都调）
  learn(id: HintId): void;
}

export function createHintStore(persist: HintPersist): HintStore {
  let loaded: Set<string> | null = null;
  let loading: Promise<void> | null = null;
  /// 这次运行里记下的（乐观：先记在这里，再写 core）
  let marked = new Set<string>();
  const claims = new Map<symbol, HintId>();
  const listeners = new Set<() => void>();

  const seenNow = (): Set<string> => new Set([...(loaded ?? []), ...marked]);

  function compute(): HintSnapshot {
    const seen = seenNow();
    return {
      loaded: loaded !== null,
      seen,
      visible: pickHint(claims.values(), loaded === null ? null : seen),
    };
  }

  let snapshot = compute();

  function emit() {
    snapshot = compute();
    for (const l of [...listeners]) l();
  }

  function mark(ids: HintId[]) {
    const fresh = ids.filter((id) => !snapshot.seen.has(id));
    if (!fresh.length) return;
    for (const id of fresh) marked.add(id);
    emit();
    for (const id of fresh) {
      // 写不进去只影响下次启动会不会再出一次；界面已经按「看过」走了，不回滚、不打扰
      persist.mark(id).catch((err) => console.error("记录新手提示看过失败", id, err));
    }
  }

  const store: HintStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    load() {
      if (loaded !== null) return Promise.resolve();
      if (!loading) {
        loading = persist.list().then(
          (ids) => {
            loaded = new Set(ids.filter((id) => id !== ""));
            emit();
          },
          (err) => {
            loading = null;
            console.error("读取新手提示看过表失败", err);
          },
        );
      }
      return loading;
    },
    claim(id) {
      const token = Symbol(id);
      claims.set(token, id);
      emit();
      return () => {
        if (claims.delete(token)) emit();
      };
    },
    dismiss: (id) => mark(dismissIds(id)),
    learn: (id) => mark(learnIds(id)),
  };
  return store;
}

/// 全应用共用的那一个：看过表存在 core
export const hintStore: HintStore = createHintStore({
  list: () => api.listSeenHints(),
  mark: (id) => api.markHintSeen(id),
});

export interface UseHintOptions {
  /// 此刻是不是它该出现的地方与时机（例：首次扫描完成且表里有 skill）
  eligible: boolean;
  /// 页面上已有灰面板 / 确认：让位。这次到访里一旦让过位，就等下次再出
  blocked?: boolean;
}

/// 让位：它本该出（有资格、看过表已读到、还没看过），页面上却已有灰面板 / 确认。
/// 让过一次，这次到访就不再出（「先让位，下次再出」），也免得确认一关它又滑出来、页面跳两次
export function shouldYield(s: {
  eligible: boolean;
  blocked: boolean;
  loaded: boolean;
  seen: boolean;
}): boolean {
  return s.eligible && s.blocked && s.loaded && !s.seen;
}

/// 这一处此刻要不要争这一条（争到了才显示，见 `pickHint`）
export function wantsHint(s: {
  eligible: boolean;
  blocked: boolean;
  yielded: boolean;
  seen: boolean;
}): boolean {
  return s.eligible && !s.blocked && !s.yielded && !s.seen;
}

export interface UseHint {
  /// 此刻显示（交给 `<HintStrip open={visible}>`，收起动画由组件管）
  visible: boolean;
  /// 点 × 关掉
  dismiss(): void;
  /// 做了它教的事：记看过并收起
  learned(): void;
}

export function useHint(id: HintId, { eligible, blocked = false }: UseHintOptions): UseHint {
  const snap = useSyncExternalStore(hintStore.subscribe, hintStore.getSnapshot);
  const seen = snap.seen.has(id);
  /// 让过位：本次挂载内不再出（见 shouldYield）
  const [yielded, setYielded] = useState(false);
  const want = wantsHint({ eligible, blocked, yielded, seen });

  useEffect(() => {
    void hintStore.load();
  }, []);

  useEffect(() => {
    if (shouldYield({ eligible, blocked, loaded: snap.loaded, seen })) setYielded(true);
  }, [eligible, blocked, snap.loaded, seen]);

  useEffect(() => {
    if (!want) return;
    return hintStore.claim(id);
  }, [id, want]);

  return {
    visible: want && snap.visible === id,
    dismiss: () => hintStore.dismiss(id),
    learned: () => hintStore.learn(id),
  };
}

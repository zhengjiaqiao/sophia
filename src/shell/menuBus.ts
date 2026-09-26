/// 菜单命令与页面之间的那条线（DESIGN「应用菜单」）。壳收到菜单栏的命令后，属于页面的那几条
/// （筛选、撤销、全选行、添加来源、返回）经这里交给当前挂着的页；页面反过来经这里告诉菜单
/// 「此刻有没有可撤销的操作」「此刻在不在添加来源页」，壳汇总后调 `set_menu_state`。
///
/// 页面的接法（第二波）：
///
///   usePageCommand("filter", () => filterInput.current?.focus());
///   useMenuFlag("undo", undoStack.length > 0);
///   useMenuFlag("back", addingSource);
///
/// 同一条命令有多个页面在接时，交给最后挂上的那一个（叠在上面的那一页）。
/// 命令发出时还没有页面接（刚从 Codex 页跳回位置页，页面还没挂上），留着等 1.5 秒内第一个接它的页面；
/// 有对应快捷键的命令则补发按键给页面原有的键盘处理（过渡期，见 `KEY_FALLBACK`）。

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { PageCommand } from "./menuCommands.ts";

type Handler = () => void;

const handlers = new Map<PageCommand, Array<{ current: Handler }>>();
let pending: { command: PageCommand; at: number } | null = null;
const PENDING_MS = 1500;

/// 过渡期的退路：菜单栏的快捷键项被系统先接走，按键到不了页面自己的 keydown 监听
/// （Matrix 里现成的 ⌘F / ⌘Z / ⌘A）。还没有页面用 `usePageCommand` 接这条命令时，
/// 就在焦点处补发一次同样的按键，页面原有的键盘处理照常生效。第二波各页接上之后这条退路自然不再走到
const KEY_FALLBACK: Partial<Record<PageCommand, string>> = {
  filter: "f",
  undo: "z",
  "select-all": "a",
  back: "[",
};

function replayKey(key: string) {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true }),
  );
}

/// 发给当前页。没有页面接：有对应按键的补发按键，没有的（添加来源）留着等页面挂上（见上）。
/// 返回有没有当场交给了用 `usePageCommand` 接的页面
export function dispatchPageCommand(command: PageCommand): boolean {
  const list = handlers.get(command);
  const top = list?.[list.length - 1];
  if (top) {
    pending = null;
    top.current();
    return true;
  }
  const key = KEY_FALLBACK[command];
  if (key !== undefined) replayKey(key);
  else pending = { command, at: Date.now() };
  return false;
}

/// 页面接一条菜单命令。handler 每次渲染可以是新函数，不必 useCallback
export function usePageCommand(command: PageCommand, handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const list = handlers.get(command) ?? [];
    list.push(ref);
    handlers.set(command, list);
    if (pending && pending.command === command) {
      const fresh = Date.now() - pending.at < PENDING_MS;
      pending = null;
      if (fresh) ref.current();
    }
    return () => {
      const i = list.indexOf(ref);
      if (i >= 0) list.splice(i, 1);
    };
  }, [command]);
}

// ===== 页面报给菜单的状态 =====

export type MenuFlag = "undo" | "back";

const flagHolders: Record<MenuFlag, Set<symbol>> = { undo: new Set(), back: new Set() };
let flagSnapshot = { undo: false, back: false };
const flagListeners = new Set<() => void>();

function publishFlags() {
  const next = { undo: flagHolders.undo.size > 0, back: flagHolders.back.size > 0 };
  if (next.undo === flagSnapshot.undo && next.back === flagSnapshot.back) return;
  flagSnapshot = next;
  flagListeners.forEach((fn) => fn());
}

/// 页面说「此刻有可撤销的操作」/「此刻在添加来源页」。任一个挂着的页面说有就算有
export function useMenuFlag(flag: MenuFlag, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const token = Symbol(flag);
    flagHolders[flag].add(token);
    publishFlags();
    return () => {
      flagHolders[flag].delete(token);
      publishFlags();
    };
  }, [flag, on]);
}

/// 壳读汇总
export function useMenuFlags(): { undo: boolean; back: boolean } {
  return useSyncExternalStore(
    (fn) => {
      flagListeners.add(fn);
      return () => flagListeners.delete(fn);
    },
    () => flagSnapshot,
    () => flagSnapshot,
  );
}

/// 离开前询问（DESIGN「agent 页 › 离开时有没保存的表单」⑬⑭）：外壳的统一接口。
///
/// 页面有没保存的改动时用 `useLeaveGuard(dirty, ask)` 登记；壳里**所有换页的路**——侧栏点击、`⌘,`
/// `⌘1`…、应用菜单、托盘跳转、`⌘[` 返回、新问题提示的 `查看`——都先经 `requestLeave`：
/// 没有登记、或登记的页此刻没有改动，当场走；有就交给那一页问（就地一句 + `保存` / `丢弃`），
/// 问完由页面调 `proceed` 再走。页面自己不去拦点击、不替用户重放按键。
///
/// 纯逻辑与 React 钩子分开：`createLeaveGuards` 不碰 React，tests/shell-leave.test.ts 直接测。

import { useEffect, useRef } from "react";
import type { Place } from "./place.ts";

/// 页面怎么问：拿到「问完之后继续走」的那一下，自己决定什么时候调（保存成了、丢弃了）；不调就是不走
export type LeaveAsk = (proceed: () => void) => void;

export interface LeaveGuards {
  /// 登记一个询问，返回撤销登记。同时有几个时由最后登记的那个问（叠在最上面的那一页）
  register(ask: LeaveAsk): () => void;
  /// 要换页了：没人登记就当场 `proceed()`，有就交给最上面的那个问
  request(proceed: () => void): void;
}

export function createLeaveGuards(): LeaveGuards {
  const stack: Array<{ ask: LeaveAsk }> = [];
  return {
    register(ask) {
      const entry = { ask };
      stack.push(entry);
      return () => {
        const i = stack.lastIndexOf(entry);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    request(proceed) {
      const top = stack[stack.length - 1];
      if (top) top.ask(proceed);
      else proceed();
    },
  };
}

const guards = createLeaveGuards();

/// 壳换页之前调它（见 App.tsx 的 `navigate`）
export const requestLeave = (proceed: () => void) => guards.request(proceed);

/// 页面登记「离开前先问我」：`dirty` 为真时才登记（没改动就不拦）；`ask` 每次渲染可以是新函数
export function useLeaveGuard(dirty: boolean, ask: LeaveAsk) {
  const ref = useRef(ask);
  ref.current = ask;
  useEffect(() => {
    if (!dirty) return;
    return guards.register((proceed) => ref.current(proceed));
  }, [dirty]);
}

/// 从 `from` 换到 `to` 会不会换掉机面里的这一页：目的地不同、或同是 agent 页但换了 agent、
/// 同是位置页但换了位置或页签。只改了「记着的」字段（停在 Codex 页时记着的页签）不算离开
export function changesPage(from: Place, to: Place): boolean {
  if (from.view !== to.view) return true;
  if (from.view === "agent") return from.agentId !== to.agentId;
  if (from.view === "location") return from.locationKey !== to.locationKey || from.tab !== to.tab;
  return false;
}

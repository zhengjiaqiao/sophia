import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./PageHead.css";

/// 页面头（DESIGN「壳：侧栏 + 一块机面 › 页面头」，组件规格「页面头 PageHead」）：机面顶上一行，高 34（容得下 28 高的
/// 页签外加槽的上下各 3），宽同内容。左端是这一页的主控件或页面名，右端是这一页的动作（间距 8）。
/// 页面名一律 `title` Condensed 20 / 700，原样、字距 0（不经 `Cap`：页面名是内容，不是结构词）。
/// 全应用只有这一种页面头：位置页、agent 页、设置、推入页（`PushedPage` 在页面名前放 `←`）都用它。
///
/// **拖窗区**（D17）：这一行里没有控件的地方能拖窗、双击按系统设置缩放（`data-tauri-drag-region="deep"`：
/// 控件——按钮、输入框——自己挡掉拖动，不必逐个标）。页签滑槽是 `<nav>`，槽里按钮之间的缝不是按钮，
/// 所以主控件外面包一层 `false`，整条槽都不能拖。
///
/// 右端的动作由页面自己放：页面在自己的树里任何地方写 `<PageHeadActions>…</PageHeadActions>`，
/// 内容经 portal 挂进页面头右端（位置页的筛选框与 `+ 来源` 就这样放）。
/// 上外距归所在处（机面顶上 16、应用级故障下 16），由壳给

const SlotContext = createContext<HTMLElement | null>(null);

export interface PageHeadProps {
  /// 左端：主控件（位置页的 `SKILLS ｜ MCP` 页签）或页面名（用 `PageTitle`）
  lead: ReactNode;
  /// 右端的动作；页面也可以经 `PageHeadActions` 从树里别处放进来
  actions?: ReactNode;
  /// 页面头下面的这一页内容：`PageHeadActions` 在这棵树里都能找到这个页面头
  children?: ReactNode;
  /// 位置页的页面头：吸顶、与表格同宽（壳的 App.css `.page-head--location`）。吸顶与限宽由壳定，页面不改页面头
  location?: boolean;
}

export function PageHead({ lead, actions, children, location = false }: PageHeadProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SlotContext.Provider value={slot}>
      <div
        className={`page-head${location ? " page-head--location" : ""}`}
        data-tauri-drag-region="deep"
      >
        <div className="page-head__lead" data-tauri-drag-region="false">
          {lead}
        </div>
        <div ref={setSlot} className="page-head__actions" data-tauri-drag-region="false">
          {actions}
        </div>
      </div>
      {children}
    </SlotContext.Provider>
  );
}

/// 页面名：`title` Condensed 20 / 700，原样；`icon` 在名字前 10（agent 页的 24px agent 图标）。
/// 它是文字不是控件——外层的 false 只挡拖窗，页面名本身照样能拖
export function PageTitle({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <h1 className="page-head__title" data-tauri-drag-region="deep">
      {icon}
      {children}
    </h1>
  );
}

/// 页面把自己的动作放进页面头右端（在 PageHead 的 children 树里用）。
/// 页面头还没挂上的那一帧什么都不画
export function PageHeadActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  return slot ? createPortal(children, slot) : null;
}

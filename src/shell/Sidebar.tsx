import { AnimatedWordmark } from "../brand/AnimatedWordmark.tsx";
import { Cap, IconSettings, Indicator } from "../ui/index.ts";
import type { Destination } from "./nav.ts";

/// 侧栏（DESIGN「壳：侧栏 + 一块机面 › 侧栏」；spec 2026-09-26-object-first-navigation R1）：208 宽、全高、落在机壳上、不画线。
/// 自上而下：红绿灯行 28（留空、可拖窗）→ 字标带 44 → 平铺的目的地（SKILLS / MCP / 模型，不分组、不列项目）→ 贴底 `设置`。
/// 全侧栏一次只有一项选中，它就是机面里正在显示的那一页。项目是范围条件，在 SKILLS / MCP 的页面头里选。
///
/// **拖窗区**（D17）：整条侧栏标 `deep`，项都是 `<button>`（自己挡掉拖动），字标标 `false`；
/// 于是红绿灯行、字标带空白、项之间和之下的空白都能拖。

export interface SidebarItem {
  id: Exclude<Destination, "settings">;
  /// 目的地表里的字：拉丁结构词原样小写写（经 `Cap` 显示为大写），中文原样
  label: string;
  /// 名字后画 6px 橙点：这一项上有能力开着、在生效（模型：第三方模型开着）；没开不画
  on: boolean;
}

export interface SidebarProps {
  items: ReadonlyArray<SidebarItem>;
  selected: Destination;
  onSelect: (destination: Destination) => void;
}

export function Sidebar({ items, selected, onSelect }: SidebarProps) {
  return (
    <aside className="sidebar" data-tauri-drag-region="deep">
      {/* 红绿灯行：留空，系统的红绿灯浮在这里（trafficLightPosition） */}
      <div className="sidebar__lights" />
      {/* 字标带：画布只盖这一块（data-brand-band），碎片落在它的下沿 */}
      <div className="sidebar__brand" data-brand-band="">
        <h1 className="sidebar__mark">
          <AnimatedWordmark />
        </h1>
      </div>

      <nav className="sidebar__nav" aria-label="导航">
        {items.map((item) => {
          const on = selected === item.id;
          return (
            <div key={item.id} className={`side-item${on ? " is-on" : ""}`}>
              <button
                type="button"
                className="side-item__main"
                aria-current={on ? "page" : undefined}
                onClick={() => onSelect(item.id)}
              >
                {/* 拉丁结构词 SKILLS / MCP 经 Cap 大写（字距同页签），中文原样 */}
                <span className="side-item__name">
                  <Cap tone="nav">{item.label}</Cap>
                </span>
                {item.on && (
                  <span className="side-item__dot">
                    <Indicator label="有能力开着、在生效" />
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </nav>

      {/* 贴侧栏底：设置（⌘, 与应用菜单「设置…」直达） */}
      <div className="sidebar__foot">
        <div className={`side-item${selected === "settings" ? " is-on" : ""}`}>
          <button
            type="button"
            className="side-item__main"
            aria-current={selected === "settings" ? "page" : undefined}
            onClick={() => onSelect("settings")}
          >
            <span className="side-item__icon">
              <IconSettings />
            </span>
            <span className="side-item__name">设置</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

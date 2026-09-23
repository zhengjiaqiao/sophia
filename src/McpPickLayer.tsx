import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { FloatingLayer } from "./pages/SourcesPage";
import { pickDiffText, pickTitle } from "./mcpView";
import type { McpDiff, McpEntry } from "./types";

/// 一次挑选：哪个服务、写进哪一格、锚在哪个格子上、有哪几份可挑
export interface McpPick {
  name: string;
  targetId: string;
  trigger: HTMLElement;
  choices: McpEntry[];
  /// 各份的字段级差异：undefined＝还在取；null＝取不到，只说「配置不一样」
  diff?: McpDiff | null;
}

const ITEM = '[role="menuitem"]';

/// MCP 同名多份时的挑选浮层（DESIGN「MCP 同名多份时就地挑一份写进去」）：锚在被点的格子上，
/// 与来源管理页的目标浮层 / `+ 来源` 同一写法。每项一行＝来源位置名 + 与其他几份差在哪几个字段
/// （只给字段名，不出现令牌、密钥的值）；点一项就把那一份写进这一格。
/// 键盘：打开即聚焦第一项，方向键上下移动，回车选中，Esc 关掉并把焦点还给格子
export function McpPickLayer({
  pick,
  labelOf,
  onPick,
  onClose,
}: {
  pick: McpPick;
  labelOf: (locationId: string) => string;
  onPick: (sourceId: string) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 浮层第一帧是隐藏的（等量好位置），隔一帧再聚焦
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(ITEM)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [pick.trigger]);

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const at = items.indexOf(event.currentTarget);
    const last = items.length - 1;
    const next =
      event.key === "ArrowDown"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowUp"
          ? at <= 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const title = pickTitle(pick.name, pick.choices.length);
  return (
    <FloatingLayer
      trigger={pick.trigger}
      onClose={onClose}
      className="src-menu mcp-pick"
      label={title}
    >
      <div className="src-menu__head mcp-pick__title">{title}</div>
      <div ref={listRef} className="mcp-pick__list">
        {pick.choices.map((entry) => (
          <button
            key={entry.sourceId}
            type="button"
            role="menuitem"
            className="src-menu__item"
            onKeyDown={move}
            onClick={() => onPick(entry.sourceId)}
          >
            <span className="src-menu__name">{labelOf(entry.sourceId)}</span>
            <span className="src-menu__sub">
              {pick.diff === undefined ? "正在比对" : pickDiffText(pick.diff, entry.sourceId)}
            </span>
          </button>
        ))}
      </div>
    </FloatingLayer>
  );
}

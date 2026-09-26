import { FloatingLayer, Menu, MenuItem } from "./ui/index.ts";
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

/// MCP 同名多份时的挑选浮层（DESIGN「MCP 同名多份时就地挑一份写进去」）：锚在被点的格子上的菜单
/// （`FloatingLayer` + `Menu`，同名挑选最宽 320）。一句问话作标题；每项一行＝来源位置名 + 副行「与其他几份差在
/// 哪几个字段」（只给字段名，不出现令牌、密钥的值）；点一项就把那一份写进这一格。
/// 键盘：打开即聚焦第一项，方向键上下移动，回车选中，Esc 关掉并把焦点还给格子（菜单与浮层自带）
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
  const title = pickTitle(pick.name, pick.choices.length);
  return (
    <FloatingLayer trigger={pick.trigger} onClose={onClose} label={title}>
      {/* 换了一格（另一次挑选）就重挂：打开即聚焦第一项 */}
      <Menu key={`${pick.name}\u0000${pick.targetId}`} autoFocus title={title} maxWidth={320}>
        {pick.choices.map((entry) => (
          <MenuItem
            key={entry.sourceId}
            sub={pick.diff === undefined ? "正在比对" : pickDiffText(pick.diff, entry.sourceId)}
            onSelect={() => onPick(entry.sourceId)}
          >
            {labelOf(entry.sourceId)}
          </MenuItem>
        ))}
      </Menu>
    </FloatingLayer>
  );
}

/// 列头的「列表外的 skill」（DESIGN「列头的悬停」）：agent 自带的、插件带的只报数，不给操作。
/// 纯函数；数字来自 core `outside_skills`（只数 harness 表里登记的文件夹）

export interface OutsideCount {
  system: number;
  plugin: number;
}

/// 列头计数后的 `+N` 与提示框多出的两行；一个都没有时 null（不出 `+N`）
export function outsideTip(
  count: OutsideCount,
  agent: string,
): { more: number; lines: string[] } | null {
  const more = count.system + count.plugin;
  if (more === 0) return null;
  const parts = [
    count.system > 0 ? `自带 ${count.system}` : null,
    count.plugin > 0 ? `插件 ${count.plugin}` : null,
  ].filter((p): p is string => p !== null);
  return {
    more,
    lines: [`另有 ${more} 个不在列表里：${parts.join(" · ")}`, `由 ${agent} 管理，不在这里同步`],
  };
}

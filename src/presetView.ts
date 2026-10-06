import type { ProviderPreset } from "./types.ts";

/// 服务商预设的纯逻辑（spec S1，sophia-dev#95）：筛选、分组、显示用的主机名。界面组件只画，不自己算

/// 地址去掉协议头与末尾斜杠，列表里跟在名字后（`api.deepseek.com`、`open.bigmodel.cn/api/v1`）
export function presetHost(preset: ProviderPreset): string {
  const base = preset.openai?.apiBase ?? preset.anthropic?.apiBase ?? "";
  return base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
}

/// 能不能在 Sophia 里用：有 OpenAI 兼容地址的才能；只有 Anthropic 地址的标「暂不支持」
export function presetSupported(preset: ProviderPreset): boolean {
  return preset.openai !== null;
}

/// 按名字、主机名、备注搜索（不分大小写，去首尾空白）；空串＝全部
export function filterPresets(list: ProviderPreset[], query: string): ProviderPreset[] {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  return list.filter((p) =>
    [p.name, p.id, presetHost(p), p.note ?? ""].some((s) => s.toLowerCase().includes(q)),
  );
}

/// 搜索框按回车选中的那一家：筛出来的第一家能用的；没有就不选
export function firstPick(list: ProviderPreset[]): ProviderPreset | null {
  return list.find(presetSupported) ?? null;
}

/// `去 DeepSeek 取密钥` 的链接：预设里有取密钥页就用它，没有用官网；都没有就不出
export function keysLink(preset: ProviderPreset): string | null {
  return preset.keysUrl ?? (preset.website || null);
}

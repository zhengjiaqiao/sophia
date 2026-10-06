import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { ProviderPreset } from "./types.ts";

/// 服务商预设的名单（spec S1）：内置数据，问一次后端就够；问不到（命令不存在、出错）就是空名单，
/// 表单退化成只有「自定义地址」

let cached: ProviderPreset[] | null = null;
let pending: Promise<ProviderPreset[]> | null = null;

export function loadPresets(): Promise<ProviderPreset[]> {
  if (cached !== null) return Promise.resolve(cached);
  pending ??= api.gatewayPresets().then(
    (list) => {
      cached = list;
      return list;
    },
    () => {
      cached = [];
      return [];
    },
  );
  return pending;
}

export function usePresets(): ProviderPreset[] {
  const [list, setList] = useState<ProviderPreset[]>(cached ?? []);
  useEffect(() => {
    let cancelled = false;
    void loadPresets().then((l) => !cancelled && setList(l));
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

/// 测试用：塞一份名单（不问后端）；传 null 清掉
export function seedPresetsForTest(list: ProviderPreset[] | null): void {
  cached = list;
  pending = null;
}

/// 应用更新接到 Tauri 的那一份 store，侧栏与设置页共用。
/// 逻辑在 `appUpdate.ts`，这里只做接线：查与下载安装调后端（`src-tauri/src/app_update.rs`，出错带四类之一与原文），
/// 重启调 process 插件。

import { useSyncExternalStore } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { createAppUpdateStore, type AppUpdateSnapshot } from "./appUpdate.ts";

export const appUpdates = createAppUpdateStore({
  async check() {
    const version = await invoke<string | null>("app_update_check");
    if (version === null) return null;
    return {
      version,
      download(onProgress) {
        const onChunk = new Channel<number | null>();
        onChunk.onmessage = onProgress;
        return invoke<void>("app_update_install", { onProgress: onChunk });
      },
    };
  },
  relaunch,
  now: () => Date.now(),
});

export function useAppUpdate(): AppUpdateSnapshot {
  return useSyncExternalStore(appUpdates.subscribe, appUpdates.get);
}

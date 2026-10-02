/// 应用更新接到 Tauri（updater / process 插件）的那一份 store，侧栏与设置页共用。
/// 逻辑在 `appUpdate.ts`，这里只做接线。

import { useSyncExternalStore } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { createAppUpdateStore, type AppUpdateSnapshot } from "./appUpdate.ts";

export const appUpdates = createAppUpdateStore({
  async check() {
    const found = await check();
    if (!found) return null;
    return {
      version: found.version,
      download(onProgress) {
        let total = 0;
        let got = 0;
        return found.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          else if (event.event === "Progress") {
            got += event.data.chunkLength;
            onProgress(total > 0 ? Math.min(100, Math.round((got / total) * 100)) : null);
          }
        });
      },
    };
  },
  relaunch,
  now: () => Date.now(),
});

export function useAppUpdate(): AppUpdateSnapshot {
  return useSyncExternalStore(appUpdates.subscribe, appUpdates.get);
}

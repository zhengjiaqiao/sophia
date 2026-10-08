/// 引导气泡只出一次（DESIGN-components「引导气泡 Coach」，#265）：每种全应用只出一次，记在设置里。
///
/// 看过的记进 core 的看过表（`settings.json` 的 `seenHints`，与新手提示共用一份、读改写在 core 的设置锁里），
/// id 带 `coach-` 前缀与新手提示分开。气泡一出就记下：哪怕没点「知道了」就关了应用，也不出第二次。
/// 看过表还没读到时一律不出——宁可这一次不出，也不出第二次
import { api } from "./api.ts";
import type { HintPersist } from "./hints.ts";
import { t } from "./i18n.ts";

/// 今天的引导气泡：选模型浮层里第一次往「已选」加模型时，指着「已选」页签说可以在那里排序
export type CoachId = "pick-order";

/// 记进看过表的 id
export const COACH_KEY: Record<CoachId, string> = {
  "pick-order": "coach-pick-order",
};

export interface CoachStore {
  /// 读一次看过表；读失败保持「没读到」（不出），下次调用重试
  load(): Promise<void>;
  /// 此刻要出这一种：没看过就记下并返回 true；看过了、看过表还没读到返回 false
  show(id: CoachId): boolean;
}

export function createCoachStore(persist: HintPersist): CoachStore {
  let seen: Set<string> | null = null;
  let loading: Promise<void> | null = null;
  return {
    load() {
      if (seen !== null) return Promise.resolve();
      if (!loading) {
        loading = persist.list().then(
          (ids) => {
            seen = new Set([...(seen ?? []), ...ids]);
          },
          (err) => {
            loading = null;
            console.error(t("hints.log.loadFailed"), err);
          },
        );
      }
      return loading;
    },
    show(id) {
      const key = COACH_KEY[id];
      if (seen === null || seen.has(key)) return false;
      seen.add(key);
      // 写不进去只影响下次启动会不会再出一次，不打扰
      persist.mark(key).catch((err) => console.error(t("hints.log.markFailed"), key, err));
      return true;
    },
  };
}

/// 全应用共用的那一个：看过表存在 core
export const coachStore: CoachStore = createCoachStore({
  list: () => api.listSeenHints(),
  mark: (id) => api.markHintSeen(id),
});

import { t } from "../i18n.ts";
import type { SkillList } from "../types.ts";
import { errorText } from "./discoverView.ts";

export const POPULAR_CHECK_MS = 10 * 60 * 1000;

export interface SkillLoadState {
  query: string;
  data: SkillList | null;
  error: string | null;
  loading: boolean;
  /// 用户按了刷新、正在等：刷新键原位换成刻度 + 一句。后台定时 / 过期刷新不置它
  /// （DESIGN-components「后台例行读取不显示任何忙碌」）
  refreshing: boolean;
}

export function createSkillLoader(
  popular: (refresh?: boolean, force?: boolean) => Promise<SkillList>,
  search: (query: string) => Promise<SkillList>,
  publish: (state: SkillLoadState) => void,
  initial?: SkillLoadState,
) {
  let generation = 0;
  let activeQuery = "";
  let disposed = false;
  /// 有一次刷新在路上（后台或手动）：合并并发，不重复发
  let inFlight = false;
  let state: SkillLoadState = initial ?? {
    query: "",
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  };
  const emit = (patch: Partial<SkillLoadState>) => {
    state = { ...state, ...patch };
    if (!disposed) publish(state);
  };
  const current = (id: number) => !disposed && id === generation;
  const invalidate = () => {
    generation++;
  };
  const refresh = (force = false) => {
    if (disposed || activeQuery !== "" || state.loading) return;
    // 后台那次还在路上时按了刷新：不另发，跟着那一次一起等（它回来时收起忙碌）
    if (inFlight) {
      if (force && !state.refreshing) emit({ refreshing: true, error: null });
      return;
    }
    const id = generation;
    inFlight = true;
    if (force) emit({ refreshing: true, error: null });
    popular(true, force).then(
      (data) => {
        inFlight = false;
        if (current(id)) emit({ query: "", data, refreshing: false, error: null });
      },
      (error: unknown) => {
        inFlight = false;
        if (current(id))
          emit({
            refreshing: false,
            error: errorText(error, t("market.error.popularUpdate")),
          });
      },
    );
  };
  const load = (query: string) => {
    if (disposed) return;
    activeQuery = query;
    const id = ++generation;
    emit({ loading: true, refreshing: false, error: null });
    (query === "" ? popular() : search(query)).then(
      (data) => {
        if (!current(id)) return;
        emit({ query, data, loading: false });
        if (query === "" && data.popular?.refreshNeeded) refresh();
      },
      (error: unknown) => {
        if (current(id))
          emit({
            query,
            data: query === "" && state.query === "" ? state.data : null,
            loading: false,
            error: errorText(error, t("market.error.skillList")),
          });
      },
    );
  };
  return {
    load,
    refresh,
    invalidate,
    dispose: () => {
      disposed = true;
      invalidate();
    },
  };
}

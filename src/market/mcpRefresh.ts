import { t } from "../i18n.ts";
import type { McpList } from "../types.ts";
import { errorText } from "./discoverView.ts";

export interface McpLoadState {
  query: string;
  data: McpList | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  curatedLoading: boolean;
}

/// 精选和官方缓存独立读取；只有过期或缺失缓存才延迟联网。
export function createMcpLoader(
  curated: (q: string) => Promise<McpList>,
  cached: (q: string) => Promise<McpList>,
  refresh: (q: string) => Promise<McpList>,
  publish: (s: McpLoadState) => void,
  schedule: (f: () => void) => () => void = (f) => {
    const timer = setTimeout(f, 300);
    return () => clearTimeout(timer);
  },
) {
  let generation = 0;
  let disposed = false;
  let cancel: (() => void) | undefined;
  let state: McpLoadState = {
    query: "",
    data: null,
    error: null,
    loading: false,
    refreshing: false,
    curatedLoading: false,
  };
  const emit = (patch: Partial<McpLoadState>) => {
    state = { ...state, ...patch };
    publish(state);
  };
  const current = (id: number) => !disposed && generation === id;
  const registryResult = (data: McpList) => ({ ...data, curated: state.data?.curated ?? [] });
  const load = (query: string) => {
    if (disposed) return;
    cancel?.();
    const id = ++generation;
    const same = state.query === query;
    emit({
      query,
      data: same && state.data ? state.data : { curated: [], registry: [], fallback: null },
      error: null,
      loading: query !== "",
      refreshing: false,
      curatedLoading: true,
    });
    curated(query).then(
      (data) => {
        if (current(id))
          emit({ data: { ...state.data!, curated: data.curated }, curatedLoading: false });
      },
      (error: unknown) => {
        if (current(id))
          emit({ curatedLoading: false, error: errorText(error, t("market.error.curated")) });
      },
    );
    if (query === "") return;
    const online = () => {
      if (!current(id)) return;
      emit({ refreshing: true });
      refresh(query).then(
        (data) => {
          if (current(id)) emit({ data: registryResult(data), refreshing: false, loading: false });
        },
        (error: unknown) => {
          if (current(id))
            emit({
              refreshing: false,
              loading: false,
              error: errorText(error, t("market.error.mcpDirectory")),
            });
        },
      );
    };
    cached(query).then(
      (data) => {
        if (!current(id)) return;
        const stale = data.searchCache?.refreshNeeded ?? true;
        emit({ data: registryResult(data), loading: stale });
        if (stale) cancel = schedule(online);
      },
      () => {
        if (current(id)) cancel = schedule(online);
      },
    );
  };
  return {
    load,
    dispose: () => {
      disposed = true;
      generation++;
      cancel?.();
    },
  };
}

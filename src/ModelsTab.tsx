import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  canRestore,
  enableDisabledReason,
  parseBackendError,
  routerUnavailable,
  sortAndFilterModels,
  takeoverOfferText,
} from "./modelsView";
import type { GatewayProviderModel, GatewayState } from "./types";

export interface ModelsTabProps {
  onError: (message: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}

/// 已知限制：私有目录与协议转换带来的边界情况，页面底部固定展示一句
const LIMITATIONS =
  "使用第三方模型时，Codex 仍会用官方模型生成会话标题（第一条消息会发给官方）；自动审阅在第三方会话里不可用；网页搜索等工具在第三方模型上不可用。";

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

export default function ModelsTab({ onError, busy, onBusy }: ModelsTabProps) {
  const [state, setState] = useState<GatewayState | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<GatewayProviderModel[]>([]);
  const [query, setQuery] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const mounted = useRef(true);

  // 网关地址与模型列表跟随最近一次读到的状态；正在编辑密钥输入框不受影响（密钥从不回显）。
  const applyState = (next: GatewayState) => {
    setState(next);
    setBaseUrl(next.provider.baseUrl);
    setModels(next.provider.models);
  };

  const refresh = async () => {
    onBusy(true);
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch (error) {
      onError(describeError(error));
    } finally {
      onBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
    // 只在挂载时加载一次；后续操作各自刷新状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// 大多数操作都是“调命令 → 用返回的最新状态刷新页面”；失败时保留当前输入，交给用户重试。
  const runAction = async (action: () => Promise<GatewayState>) => {
    onBusy(true);
    try {
      const next = await action();
      if (mounted.current) applyState(next);
    } catch (error) {
      onError(describeError(error));
    } finally {
      onBusy(false);
    }
  };

  const saveProvider = async () => {
    onBusy(true);
    try {
      const next = await api.gatewaySaveProvider(baseUrl, apiKey);
      if (mounted.current) {
        applyState(next);
        setApiKey("");
      }
    } catch (error) {
      // 保存失败：地址与密钥输入原样保留，不清空
      onError(describeError(error));
    } finally {
      onBusy(false);
    }
  };

  const toggleModel = (id: string) => {
    setModels((current) => current.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)));
  };
  const renameModel = (id: string, displayName: string) => {
    setModels((current) => current.map((m) => (m.id === id ? { ...m, displayName } : m)));
  };
  const saveModels = () =>
    runAction(() =>
      api.gatewaySelectModels(
        models.filter((m) => m.selected).map(({ id, displayName }) => ({ id, displayName })),
      ),
    );

  const confirmRestore = () => {
    setRestoreOpen(false);
    void runAction(() => api.gatewayRestore());
  };
  const confirmTakeover = () => {
    setTakeoverOpen(false);
    void runAction(() => api.gatewayTakeover());
  };

  if (!state) return <p>正在读取模型页状态…</p>;

  const selectedCount = models.filter((m) => m.selected).length;
  const visibleModels = sortAndFilterModels(models, query);
  const disabledReason = enableDisabledReason(state, selectedCount);

  return (
    <section className="models-tab">
      <div className="models-notices">
        {routerUnavailable(state) && (
          <div className="notice warning">
            <span>
              本机路由不可用{state.router.error ? `：${state.router.error}` : ""}
              ，官方模型也可能无法使用。
            </span>
            <button disabled={busy} onClick={() => setRestoreOpen(true)}>
              恢复
            </button>
          </div>
        )}
        {state.conflict && (
          <div className="notice warning">
            <span>{state.conflict}</span>
          </div>
        )}
        {state.takeover && (
          <div className="notice info">
            <span>{takeoverOfferText(state.takeover)}</span>
            <button disabled={busy} onClick={() => setTakeoverOpen(true)}>
              接管
            </button>
          </div>
        )}
        {state.codex.drift && (
          <div className="notice info">
            <span>Codex 版本已更新，合并模型目录需要重新生成。</span>
            <button disabled={busy} onClick={() => void runAction(() => api.gatewayEnable())}>
              重新生成
            </button>
          </div>
        )}
        {state.needsCodexRestart && (
          <div className="notice info">
            <span>需要重启 Codex 才生效</span>
          </div>
        )}
      </div>

      <div className="models-section">
        <h2>网关</h2>
        <label className="models-field">
          网关地址
          <input
            type="text"
            disabled={busy}
            value={baseUrl}
            placeholder="https://example.com/openai/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label className="models-field">
          API 密钥
          <input
            type="password"
            disabled={busy}
            value={apiKey}
            autoComplete="off"
            placeholder={state.provider.hasKey ? "已保存，留空则不修改" : "输入密钥"}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <div className="toolbar">
          <button disabled={busy || baseUrl.trim() === ""} onClick={() => void saveProvider()}>
            保存
          </button>
          <button
            disabled={busy || !state.provider.hasKey}
            onClick={() => void runAction(() => api.gatewayFetchModels())}
          >
            拉取模型
          </button>
        </div>
      </div>

      <div className="models-section">
        <h2>模型</h2>
        <div className="toolbar filters">
          <input
            type="search"
            disabled={busy}
            placeholder="筛选模型（可能有 100+ 个）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {models.length === 0 ? (
          <p className="muted">还没有可选模型，请先在上方保存网关并拉取模型列表。</p>
        ) : visibleModels.length === 0 ? (
          <p className="muted">没有匹配的模型。</p>
        ) : (
          <ul className="models-list">
            {visibleModels.map((m) => (
              <li key={m.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={m.selected}
                  onChange={() => toggleModel(m.id)}
                />
                <span className="muted" title={m.id}>
                  {m.slug || m.id}
                </span>
                <input
                  type="text"
                  disabled={busy}
                  value={m.displayName}
                  onChange={(e) => renameModel(m.id, e.target.value)}
                />
              </li>
            ))}
          </ul>
        )}
        {models.length > 0 && (
          <div className="toolbar">
            <span>已选 {selectedCount} 个模型</span>
            <button disabled={busy} onClick={() => void saveModels()}>
              保存选择
            </button>
          </div>
        )}
      </div>

      <div className="models-section">
        <h2>Codex</h2>
        <p>
          {state.enabled ? "已启用" : "未启用"} · 后台服务
          {state.router.installed ? "已安装" : "未安装"}
          {state.router.installed &&
            `（${state.router.running ? "运行中" : "未运行"}，端口 ${state.router.port}）`}
          {state.codex.version && ` · Codex ${state.codex.version}`}
        </p>
        <div className="toolbar">
          <button
            disabled={busy || disabledReason !== null}
            onClick={() => void runAction(() => api.gatewayEnable())}
          >
            启用
          </button>
          <button disabled={busy || !canRestore(state)} onClick={() => setRestoreOpen(true)}>
            恢复
          </button>
          {disabledReason && <span className="muted">{disabledReason}</span>}
        </div>
      </div>

      <p className="muted">{LIMITATIONS}</p>

      {restoreOpen && (
        <div className="modal-backdrop" onClick={() => setRestoreOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar">
              <h2>确认恢复？</h2>
            </div>
            <p className="muted">
              恢复后 Codex 设置里将不再有本功能写入的内容，模型选择器只保留官方模型；需要重启 Codex
              才生效。
            </p>
            <div className="toolbar">
              <button disabled={busy} onClick={confirmRestore}>
                确认恢复
              </button>
              <button disabled={busy} onClick={() => setRestoreOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {takeoverOpen && (
        <div className="modal-backdrop" onClick={() => setTakeoverOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar">
              <h2>确认接管？</h2>
            </div>
            <p className="muted">
              接管会把网关地址、已选模型与密钥原样带到 SymSync，并撤下 agents-manager
              的后台服务与文件；接管后需要重启一次 Codex 才生效。
            </p>
            <div className="toolbar">
              <button disabled={busy} onClick={confirmTakeover}>
                确认接管
              </button>
              <button disabled={busy} onClick={() => setTakeoverOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

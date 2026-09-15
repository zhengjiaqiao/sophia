import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { canSupplement, importedInDomain, type McpDomain } from "./mcpView";
import type { McpAutoImportRule, McpEntry, McpLocation, McpOverview, McpPreview } from "./types";

export interface McpImportDialogProps {
  overview: McpOverview;
  page: McpDomain;
  /** 单格歧义入口只预选被点击的目标；普通“引入…”省略此值并默认全选。 */
  initialTargetIds?: string[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onPreview: (preview: McpPreview) => void;
  onError: (message: string) => void;
  autoImports: McpAutoImportRule[];
  /** 保存或撤销规则后，重新取得规则并扫描；后端会在扫描中执行自动补齐。 */
  onAutoImportChange: () => Promise<void>;
}

const locationOf = (locations: McpLocation[], id: string) =>
  locations.find((location) => location.id === id);
const domainLabel = (domain: string) => {
  if (domain === "global") return "全局";
  const path = domain.startsWith("project:") ? domain.slice("project:".length) : domain;
  return `项目 · ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`;
};

const transportText = (entry: McpEntry) =>
  entry.transport === "stdio" ? "标准输入输出" : entry.transport === "http" ? "HTTP" : "不支持";
const entryKey = (entry: McpEntry) => `${entry.sourceId}|${entry.name}`;
const CELL_STATE_TEXT: Record<McpEntry["cells"][number]["state"], string> = {
  own: "已配置（来源配置）",
  equal: "已配置（连接一致）",
  sameEndpoint: "已配置（同一服务，端点一致；动态请求头或认证信息未证明等价）",
  missing: "缺失",
  conflict: "同名冲突，不会覆盖",
  invalid: "配置无效",
  unsupported: "格式不支持",
};

/// 单域 MCP 引入：候选来自所有发现的位置；只把本域尚未引入且目标缺失的服务交给后端 prepare。
export default function McpImportDialog({
  overview,
  page,
  initialTargetIds,
  busy,
  onBusy,
  onClose,
  onPreview,
  onError,
  autoImports,
  onAutoImportChange,
}: McpImportDialogProps) {
  const domainTargets = useMemo(
    () => overview.locations.filter((location) => location.domain === page.key),
    [overview.locations, page.key],
  );
  const sourceLocations = useMemo(
    () => overview.locations.filter((location) => !location.matrixHidden),
    [overview.locations],
  );
  const [sourceId, setSourceId] = useState(sourceLocations[0]?.id ?? "");
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [targetIds, setTargetIds] = useState<Set<string>>(
    () =>
      new Set(
        (initialTargetIds ?? page.targets.map((target) => target.id)).filter((id) =>
          domainTargets.some((target) => target.id === id),
        ),
      ),
  );
  const [auto, setAuto] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [confirmCrossDomain, setConfirmCrossDomain] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const allRef = useRef<HTMLInputElement>(null);

  const sourceEntries = useMemo(
    () => overview.entries.filter((entry) => entry.sourceId === sourceId),
    [overview.entries, sourceId],
  );
  const source = locationOf(overview.locations, sourceId);
  const autoRule = autoImports.find(
    (rule) => rule.source.id === sourceId && rule.targetDomain === page.key,
  );
  const autoRuleTargetIds = useMemo(
    () => new Set((autoRule?.targets ?? []).map((target) => target.id)),
    [autoRule],
  );
  const defaultTargetIds = useMemo(
    () =>
      new Set(
        (initialTargetIds ?? page.targets.map((target) => target.id)).filter((id) =>
          domainTargets.some((target) => target.id === id),
        ),
      ),
    [domainTargets, initialTargetIds, page.targets],
  );
  const isCrossDomain = source !== undefined && source.domain !== page.key;
  const matches = (entry: McpEntry) =>
    entry.name.toLowerCase().includes(query.trim().toLowerCase());
  const filteredEntries = sourceEntries.filter(matches);
  const canPick = (entry: McpEntry) => canSupplement(entry, targetIds);
  const selectable = filteredEntries.filter(canPick);
  const chosen = sourceEntries.filter(
    (entry) => selectedEntries.has(entryKey(entry)) && canPick(entry),
  );
  const allSelected =
    selectable.length > 0 && selectable.every((entry) => selectedEntries.has(entryKey(entry)));
  const someSelected =
    !allSelected && selectable.some((entry) => selectedEntries.has(entryKey(entry)));
  const targetNotes = chosen.flatMap((entry) =>
    entry.cells
      .filter((cell) => targetIds.has(cell.targetId) && cell.state !== "missing")
      .map((cell) => ({ entry, cell })),
  );

  useEffect(() => {
    setSelectedEntries(new Set());
  }, [sourceId]);

  // 切换来源或后端重扫后按规则恢复目标；用户尚未确认的修改不写入规则。
  const autoInitKey = `${sourceId}|${page.key}|${[...autoRuleTargetIds].join(",")}`;
  useEffect(() => {
    if (autoRule === undefined) {
      setAuto(false);
      setTargetIds(defaultTargetIds);
      return;
    }
    setAuto(true);
    setTargetIds(autoRuleTargetIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoInitKey]);

  useEffect(() => {
    setSelectedEntries(
      (previous) =>
        new Set(
          [...previous].filter((key) => {
            const entry = sourceEntries.find((candidate) => entryKey(candidate) === key);
            return entry !== undefined && canPick(entry);
          }),
        ),
    );
  }, [targetIds, sourceId]); // source entries are derived from stable dialog inputs.

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  useEffect(() => {
    const focusable = () => [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    return () => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    const focusable = () => [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const previewImport = async () => {
    const selections = chosen.flatMap((entry) =>
      [...targetIds]
        .filter((targetId) =>
          entry.cells.some((cell) => cell.targetId === targetId && cell.state === "missing"),
        )
        .map((targetId) => ({ sourceId: entry.sourceId, name: entry.name, targetId })),
    );
    if (selections.length === 0) return;
    onBusy(true);
    try {
      onPreview(await api.proposeMcpSync(selections));
      onClose();
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
  };

  const cancelAutoConfirm = () => {
    setConfirmAuto(false);
    setConfirmCrossDomain(false);
    setTargetIds(autoRuleTargetIds);
  };
  const saveAutoImport = async () => {
    if (source === undefined) return;
    onBusy(true);
    try {
      if (targetIds.size === 0) {
        await api.removeMcpAutoImport(source.id, page.key);
      } else {
        await api.setMcpAutoImport(source.id, page.key, [...targetIds], confirmCrossDomain);
      }
      setConfirmAuto(false);
      setConfirmCrossDomain(false);
      setAuto(targetIds.size > 0);
      await onAutoImportChange();
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
  };
  const disableAutoImport = async () => {
    if (source === undefined) return;
    onBusy(true);
    try {
      await api.removeMcpAutoImport(source.id, page.key);
      setAuto(false);
      await onAutoImportChange();
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
  };
  const toggleTarget = (targetId: string) => {
    const next = new Set(targetIds);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    setTargetIds(next);
    // 已启用的规则不静默改写；确认框会用这一版目标替换旧规则。
    if (auto) {
      setConfirmCrossDomain(autoRule?.allowCrossDomain ?? false);
      setConfirmAuto(true);
    }
  };

  const targetLabel = (target: McpLocation) => {
    if (!target.matrixHidden) return target.label;
    if (target.harnessId === "claude-code" && target.selector !== undefined) {
      return `${target.label}（将写入 Claude Local 配置）`;
    }
    return `${target.label}（将创建 .mcp.json）`;
  };
  const confirmedTargets = domainTargets.filter((target) => targetIds.has(target.id));
  const missingText = (entry: McpEntry) => {
    if (entry.reason !== null) return entry.reason;
    if (entry.transport === "unsupported") return "该服务格式不支持迁移";
    if (!canPick(entry)) {
      const state = entry.cells.find((cell) => targetIds.has(cell.targetId))?.state;
      if (state === "conflict") return "所选目标存在同名冲突，不会覆盖";
      if (state === "sameEndpoint") return "所选目标已配置（端点一致）";
      if (state === "own" || state === "equal") return "所选目标已配置";
      if (state === "invalid") return "所选目标配置无效";
      if (state === "unsupported") return "所选目标格式不支持迁移";
      return "所选目标没有缺失项";
    }
    return "";
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className="modal wide mcp-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-import-title"
      >
        <div className="toolbar">
          <h2 id="mcp-import-title">引入 MCP 到「{page.label}」</h2>
          <button disabled={busy} aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="mcp-import-dialog">
          <ul className="pick-list mcp-import-sources">
            {sourceLocations.map((location) => {
              const count = overview.entries.filter(
                (entry) => entry.sourceId === location.id && canSupplement(entry, targetIds),
              ).length;
              return (
                <li key={location.id} className={location.id === sourceId ? "active" : undefined}>
                  <button
                    className="mcp-source-button"
                    disabled={busy}
                    title={location.path}
                    onClick={() => setSourceId(location.id)}
                  >
                    <span>
                      {domainLabel(location.domain)} · {location.label}
                    </span>
                    <span className="muted">可补齐 {count} 个</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mcp-import-services">
            {source === undefined ? (
              <p>没有可用的来源位置。</p>
            ) : (
              <>
                <p className="muted" title={source.path}>
                  来源：{domainLabel(source.domain)} · {source.label}
                </p>
                <label className="auto-toggle mcp-auto-toggle">
                  <input
                    type="checkbox"
                    checked={auto}
                    disabled={busy || targetIds.size === 0}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setConfirmCrossDomain(autoRule?.allowCrossDomain ?? false);
                        setConfirmAuto(true);
                      } else {
                        void disableAutoImport();
                      }
                    }}
                  />
                  自动引入新增 MCP
                </label>
                {auto && (
                  <p className="muted mcp-auto-hint">
                    此来源后续新增的完整 MCP 定义会自动补齐到右侧选中的位置。
                  </p>
                )}
                <input
                  type="search"
                  disabled={busy}
                  placeholder="筛选服务"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <label>
                  <input
                    ref={allRef}
                    type="checkbox"
                    checked={allSelected}
                    disabled={busy || selectable.length === 0}
                    onChange={() =>
                      setSelectedEntries(
                        new Set(allSelected ? [] : selectable.map((entry) => entryKey(entry))),
                      )
                    }
                  />
                  全部可补齐服务
                </label>
                {filteredEntries.map((entry) => (
                  <label key={entryKey(entry)} title={missingText(entry) || undefined}>
                    <input
                      type="checkbox"
                      checked={selectedEntries.has(entryKey(entry))}
                      disabled={busy || !canPick(entry)}
                      onChange={() =>
                        setSelectedEntries((previous) => {
                          const next = new Set(previous);
                          const key = entryKey(entry);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                    <code>{entry.name}</code>{" "}
                    <span className="muted">· {transportText(entry)}</span>
                    {importedInDomain(entry, page) && (
                      <span className="muted">
                        · {canPick(entry) ? "已引入，可补齐" : "已引入"}
                      </span>
                    )}
                    {missingText(entry) && <span className="muted">· {missingText(entry)}</span>}
                  </label>
                ))}
                {filteredEntries.length === 0 && <p className="muted">该来源没有匹配的服务。</p>}
              </>
            )}
          </div>
          <div className="mcp-import-targets">
            {domainTargets.map((target) => (
              <label key={target.id} title={target.path}>
                <input
                  type="checkbox"
                  checked={targetIds.has(target.id)}
                  disabled={busy}
                  onChange={() => toggleTarget(target.id)}
                />
                {targetLabel(target)}
              </label>
            ))}
            {targetNotes.length > 0 && (
              <div className="mcp-import-target-note muted">
                {targetNotes.map(({ entry, cell }) => {
                  const target = domainTargets.find((candidate) => candidate.id === cell.targetId);
                  const text = cell.reason ?? CELL_STATE_TEXT[cell.state];
                  return (
                    <div key={`${entryKey(entry)}|${cell.targetId}`}>
                      {entry.name} · {target?.label ?? cell.targetId}：{text}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="toolbar">
          <span className="muted">
            已选 {chosen.length} / {selectable.length}
          </span>
          <span style={{ flex: 1 }} />
          <button
            disabled={busy || chosen.length === 0 || targetIds.size === 0}
            onClick={() => void previewImport()}
          >
            预览引入
          </button>
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
      {confirmAuto && source !== undefined && (
        <div className="modal-backdrop" onMouseDown={cancelAutoConfirm}>
          <div className="modal mcp-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="toolbar">
              <h2>
                {targetIds.size === 0 ? "移除自动引入" : autoRule ? "更新自动引入" : "开启自动引入"}
              </h2>
            </div>
            {targetIds.size === 0 ? (
              <p>未选择目标位置。确认后将移除此来源到「{page.label}」的自动引入规则。</p>
            ) : (
              <>
                <p>
                  将把「{domainLabel(source.domain)} · {source.label}」当前及以后新增的完整 MCP
                  定义，自动补齐到以下位置。写入会复制完整定义，其中可能包含请求头、令牌等凭据；写入已有配置前会创建完整备份。
                </p>
                <ul className="mcp-auto-confirm-targets">
                  {confirmedTargets.map((target) => (
                    <li key={target.id}>
                      {targetLabel(target)} <span className="muted">· {target.path}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {isCrossDomain && targetIds.size > 0 && (
              <label className="mcp-cross-domain">
                <input
                  type="checkbox"
                  checked={confirmCrossDomain}
                  disabled={busy}
                  onChange={(event) => setConfirmCrossDomain(event.target.checked)}
                />
                确认跨域自动引入：来源和目标属于不同的全局或项目域，完整定义可能包含凭据。
              </label>
            )}
            <div className="toolbar">
              <span style={{ flex: 1 }} />
              <button
                disabled={busy || (isCrossDomain && targetIds.size > 0 && !confirmCrossDomain)}
                onClick={() => void saveAutoImport()}
              >
                确认{targetIds.size === 0 ? "移除" : autoRule ? "更新" : "开启"}
              </button>
              <button disabled={busy} onClick={cancelAutoConfirm}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

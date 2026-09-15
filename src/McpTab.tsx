import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import McpImportDialog from "./McpImportDialog";
import {
  mcpDomains,
  summarizeMcpCell,
  sourceForMissing,
  sourceForMissingTarget,
  supplementSourcesForTarget,
  type McpDomain,
  type McpDomainRow,
} from "./mcpView";
import type {
  McpCellState,
  McpAutoImportRule,
  McpEntry,
  McpLocation,
  McpOverview,
  McpPreview,
  McpReport,
} from "./types";
import "./McpTab.css";

export interface McpTabProps {
  selectedKey: string;
  onDomains: (domains: { key: string; label: string }[]) => void;
  onError: (error: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  refreshKey: number;
}

const CELL_LABEL: Record<McpCellState, string> = {
  own: "来源配置",
  equal: "连接一致",
  sameEndpoint: "同一服务（端点一致）",
  missing: "缺失",
  conflict: "差异，不会覆盖",
  invalid: "配置无效",
  unsupported: "格式不支持",
};
const rowKey = (page: McpDomain, entry: McpDomainRow) => `${page.key}|${entry.name}`;
const locationOf = (locations: McpLocation[], id: string) =>
  locations.find((location) => location.id === id);
const domainLabel = (domain: string) => {
  if (domain === "global") return "全局";
  const path = domain.startsWith("project:") ? domain.slice("project:".length) : domain;
  return `项目 · ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`;
};
const transportText = (entry: McpEntry) =>
  entry.transport === "stdio" ? "标准输入输出" : entry.transport === "http" ? "HTTP" : "不支持";

type SourceCell = { entry: McpEntry; cell: { state: McpCellState; reason: string | null } };

export default function McpTab({
  selectedKey,
  onDomains,
  onError,
  busy,
  onBusy,
  refreshKey,
}: McpTabProps) {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importPageOverride, setImportPageOverride] = useState<McpDomain | null>(null);
  const [importTargetIds, setImportTargetIds] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<McpPreview | null>(null);
  const [previewKind, setPreviewKind] = useState<"同步" | "补齐" | "引入">("同步");
  const [allowCrossDomain, setAllowCrossDomain] = useState(false);
  const [report, setReport] = useState<McpReport | null>(null);
  const [autoImports, setAutoImports] = useState<McpAutoImportRule[]>([]);
  const refreshVersion = useRef(0);
  const mounted = useRef(true);
  const previewRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);

  const refresh = async () => {
    const version = ++refreshVersion.current;
    onBusy(true);
    try {
      const [next, rules] = await Promise.all([api.scanMcp(), api.listMcpAutoImports()]);
      if (mounted.current && version === refreshVersion.current) {
        setOverview(next);
        setAutoImports(rules);
      }
    } catch (error) {
      onError(String(error));
    } finally {
      if (mounted.current && version === refreshVersion.current) onBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void refresh();
    // refreshKey comes from App after focus, settings, and project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // scanMcp 已在自动执行后返回重扫结果；事件只负责展示报告，避免失败项触发循环重试。
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void listen<McpReport>("mcp-auto-imported", ({ payload }) => {
      setReport(payload);
    }).then((unlisten) => (disposed ? unlisten() : unlistens.push(unlisten)));
    return () => {
      disposed = true;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, []);

  const domains = useMemo(() => (overview ? mcpDomains(overview) : []), [overview]);
  const pages =
    selectedKey === "all" ? domains : domains.filter((page) => page.key === selectedKey);
  const sidebarImportPage = selectedKey === "all" ? null : (pages[0] ?? null);
  const importPage = importPageOverride ?? sidebarImportPage;
  const crossDomainPreview = preview?.actions.some((action) => action.crossDomain) ?? false;
  const previewHasWeibo =
    preview?.actions.some((action) => {
      const locations = overview?.locations ?? [];
      return (
        locationOf(locations, action.sourceId)?.harnessId === "weiboap" ||
        locationOf(locations, action.targetId)?.harnessId === "weiboap"
      );
    }) ?? false;

  useEffect(() => {
    if (overview) onDomains(domains.map(({ key, label }) => ({ key, label })));
  }, [overview, domains, onDomains]);

  useEffect(() => {
    setImportOpen(false);
    setImportPageOverride(null);
    setImportTargetIds(null);
    setPreview(null);
    setAllowCrossDomain(false);
  }, [selectedKey]);

  useEffect(() => {
    if (!preview) return;
    const focusable = () => [
      ...(previewRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) setPreview(null);
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
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
      else importButtonRef.current?.focus();
    };
  }, [preview, busy]);

  const visibleRows = (page: McpDomain) => {
    const term = query.trim().toLowerCase();
    return page.rows.filter((entry) => term === "" || entry.name.toLowerCase().includes(term));
  };
  const sourceForRow = (page: McpDomain, row: McpDomainRow) => sourceForMissing(row, page.targets);
  const isSelected = (page: McpDomain, row: McpDomainRow) => selected.has(rowKey(page, row));
  const setPageAll = (page: McpDomain, want: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const row of visibleRows(page).filter((candidate) => sourceForRow(page, candidate))) {
        if (want) next.add(rowKey(page, row));
        else next.delete(rowKey(page, row));
      }
      return next;
    });
  const openPreview = (next: McpPreview, kind: "补齐" | "引入") => {
    const active = document.activeElement;
    previousFocus.current =
      active instanceof HTMLButtonElement || active instanceof HTMLInputElement ? active : null;
    setPreview(next);
    setPreviewKind(kind);
    setAllowCrossDomain(false);
  };
  const previewSelections = async (
    selections: { sourceId: string; name: string; targetId: string }[],
  ) => {
    if (selections.length === 0) return;
    onBusy(true);
    try {
      const next = await api.proposeMcpSync(selections);
      openPreview(next, "补齐");
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
  };
  const previewMissing = async () => {
    const selections = pages.flatMap((page) =>
      visibleRows(page)
        .filter((row) => isSelected(page, row))
        .flatMap((row) => {
          const entry = sourceForRow(page, row);
          return entry
            ? entry.cells
                .filter((cell) => cell.state === "missing")
                .map((cell) => ({
                  sourceId: entry.sourceId,
                  name: entry.name,
                  targetId: cell.targetId,
                }))
            : [];
        }),
    );
    await previewSelections(selections);
  };
  const applyPreview = async () => {
    if (!preview || (crossDomainPreview && !allowCrossDomain)) return;
    onBusy(true);
    try {
      setReport(await api.applyMcp(preview.planId, allowCrossDomain));
      setPreview(null);
      setSelected(new Set());
      await refresh();
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
  };
  const issueText = (issue: { locationId: string; name: string | null; message: string }) => {
    const location = locationOf(overview?.locations ?? [], issue.locationId);
    const label = location
      ? `${domainLabel(location.domain)} · ${location.label}`
      : issue.locationId;
    return `${label}${issue.name ? ` · ${issue.name}` : ""}：${issue.message}`;
  };
  const actionTargetText = (action: McpPreview["actions"][number]) => {
    const target = locationOf(overview?.locations ?? [], action.targetId);
    const page = domains.find((candidate) =>
      candidate.targets.some((location) => location.id === action.targetId),
    );
    return target
      ? `${page?.label ?? domainLabel(target.domain)} · ${target.label} · ${target.path}`
      : action.targetPath;
  };
  const chosen = pages.flatMap((page) => visibleRows(page).filter((row) => isSelected(page, row)));
  const missing = chosen.reduce((count, row) => {
    const page = pages.find((candidate) => candidate.rows.includes(row));
    const source = page && sourceForRow(page, row);
    return count + (source?.cells.filter((cell) => cell.state === "missing").length ?? 0);
  }, 0);

  return (
    <section className="mcp-tab">
      <div className="toolbar">
        <button
          ref={importButtonRef}
          disabled={busy || sidebarImportPage === null}
          title={sidebarImportPage === null ? "请先在侧栏选一个域" : "引入 MCP 到本域"}
          onClick={() => {
            setImportPageOverride(null);
            setImportTargetIds(null);
            setImportOpen(true);
          }}
        >
          引入…
        </button>
        <button disabled={busy} onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      <div className="toolbar filters">
        <input
          type="search"
          disabled={busy}
          placeholder="筛选 MCP 服务"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="muted">
        支持 Claude Code、Codex、Cursor 与 WeiboAP 项目配置。仅扫描文件配置；Claude.ai 连接器和内置
        MCP
        不在同步范围。默认扫描只读；启用自动引入规则后，扫描会将缺失的完整定义写入选定位置并创建备份。手动补齐不会覆盖同名配置。
      </p>
      {!overview ? (
        <p>正在扫描 MCP 配置…</p>
      ) : overview.locations.length === 0 ? (
        <p>没有发现支持的 MCP 配置位置。</p>
      ) : (
        <>
          {chosen.length > 0 && (
            <div className="toolbar selection mcp-actions">
              <span>已选 {chosen.length} 个服务</span>
              <button
                disabled={busy || missing === 0}
                title={
                  missing === 0 ? "选中的服务在本域没有缺失配置" : "仅补齐选中服务在本域缺失的配置"
                }
                onClick={() => void previewMissing()}
              >
                补齐缺失（{missing} 处）
              </button>
              <button className="link" disabled={busy} onClick={() => setSelected(new Set())}>
                取消选择
              </button>
            </div>
          )}
          {pages.length === 0 ? (
            <p>该域下没有发现 MCP 配置位置。</p>
          ) : (
            pages.map((page) => (
              <div key={page.key}>
                <McpAutoImportRules
                  rules={autoImports.filter((rule) => rule.targetDomain === page.key)}
                  locations={overview.locations}
                  busy={busy}
                  onRemove={async (rule) => {
                    onBusy(true);
                    try {
                      await api.removeMcpAutoImport(rule.source.id, rule.targetDomain);
                      await refresh();
                    } catch (error) {
                      onError(String(error));
                    } finally {
                      onBusy(false);
                    }
                  }}
                />
                <McpDomainView
                  page={page}
                  rows={visibleRows(page)}
                  query={query}
                  selected={(entry) => isSelected(page, entry)}
                  onToggle={(entry) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      const key = rowKey(page, entry);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  onSelectAll={(want) => setPageAll(page, want)}
                  locations={overview.locations}
                  busy={busy}
                  onMissingTarget={(target, source) => {
                    if (source) {
                      void previewSelections([
                        { sourceId: source.sourceId, name: source.name, targetId: target.id },
                      ]);
                      return;
                    }
                    setImportPageOverride(page);
                    setImportTargetIds([target.id]);
                    setImportOpen(true);
                  }}
                />
              </div>
            ))
          )}
          {overview.issues.length > 0 && (
            <div className="mcp-issues">
              <strong>扫描问题</strong>
              <ul>
                {overview.issues.map((issue, index) => (
                  <li key={`${issue.locationId}|${issue.name ?? ""}|${index}`}>
                    {issueText(issue)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {importOpen && overview && importPage && (
        <McpImportDialog
          overview={overview}
          page={importPage}
          initialTargetIds={importTargetIds ?? undefined}
          busy={busy}
          onBusy={onBusy}
          onClose={() => {
            setImportOpen(false);
            setImportPageOverride(null);
            setImportTargetIds(null);
          }}
          onPreview={(next) => openPreview(next, "引入")}
          onError={onError}
          autoImports={autoImports}
          onAutoImportChange={refresh}
        />
      )}
      {preview && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => !busy && event.target === event.currentTarget && setPreview(null)}
        >
          <div
            ref={previewRef}
            className="modal mcp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-confirm-title"
          >
            <div className="toolbar">
              <h2 id="mcp-confirm-title">确认 MCP {previewKind}</h2>
              <button disabled={busy} aria-label="关闭" onClick={() => setPreview(null)}>
                ×
              </button>
            </div>
            <p className="muted">
              敏感值不会显示。写入已有配置前会创建完整备份；备份失败不会写入，结果会显示备份路径。
            </p>
            {preview.actions.length > 0 ? (
              <ul className="mcp-preview-list">
                {preview.actions.map((action) => (
                  <li key={`${action.sourceId}|${action.targetId}|${action.name}`}>
                    <code>{action.name}</code> → {actionTargetText(action)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">没有可新增的配置。</p>
            )}
            {previewHasWeibo && (
              <p className="muted">
                仅同步定义，需在 WeiboAP 中启用；已有会话可能需重开。不会启动服务。
              </p>
            )}
            {preview.issues.length > 0 && (
              <div className="mcp-issues">
                <strong>跳过的项目</strong>
                <ul>
                  {preview.issues.map((issue, index) => (
                    <li key={`${issue.locationId}|${issue.name ?? ""}|${index}`}>
                      {issueText(issue)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {crossDomainPreview && (
              <label className="mcp-cross-domain">
                <input
                  disabled={busy}
                  type="checkbox"
                  checked={allowCrossDomain}
                  onChange={(event) => setAllowCrossDomain(event.target.checked)}
                />
                跨域操作确认：配置可能包含凭据，将写入另一全局或项目位置。
              </label>
            )}
            <div className="toolbar">
              <button
                disabled={
                  busy || preview.actions.length === 0 || (crossDomainPreview && !allowCrossDomain)
                }
                onClick={() => void applyPreview()}
              >
                确认写入
              </button>
              <button disabled={busy} onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {report && (
        <div className="floating">
          <div className="report">
            <div className="report-head">
              <strong>MCP 配置写入结果</strong>
              <button className="link" onClick={() => setReport(null)}>
                关闭
              </button>
            </div>
            <ul>
              {report.entries.map((entry, index) => (
                <li key={`${entry.targetId}|${entry.name}|${index}`}>
                  {entry.name}：{entry.message}
                  {entry.backupPath && `（备份：${entry.backupPath}）`}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function McpAutoImportRules({
  rules,
  locations,
  busy,
  onRemove,
}: {
  rules: McpAutoImportRule[];
  locations: McpLocation[];
  busy: boolean;
  onRemove: (rule: McpAutoImportRule) => Promise<void>;
}) {
  if (rules.length === 0) return null;
  const labelFor = (id: string, fallbackPath: string) =>
    locations.find((location) => location.id === id)?.label ?? fallbackPath;
  return (
    <div className="mcp-auto-rules">
      <strong>自动引入规则</strong>
      {rules.map((rule) => {
        const targets = rule.targets.map((target) => labelFor(target.id, target.path)).join("、");
        return (
          <div className="mcp-auto-rule" key={`${rule.source.id}|${rule.targetDomain}`}>
            <span title={rule.source.path}>
              {labelFor(rule.source.id, rule.source.path)} → {targets || "（无可用目标）"}
              {rule.allowCrossDomain && " · 已确认跨域"}
            </span>
            <button className="link" disabled={busy} onClick={() => void onRemove(rule)}>
              移除规则
            </button>
          </div>
        );
      })}
      <p className="muted">
        扫描时会补齐该来源新增的完整定义；即使来源位置暂时未被发现，仍可在这里移除规则。
      </p>
    </div>
  );
}

function McpDomainView({
  page,
  rows,
  query,
  selected,
  onToggle,
  onSelectAll,
  locations,
  busy,
  onMissingTarget,
}: {
  page: McpDomain;
  rows: McpDomainRow[];
  query: string;
  selected: (entry: McpDomainRow) => boolean;
  onToggle: (entry: McpDomainRow) => void;
  onSelectAll: (want: boolean) => void;
  locations: McpLocation[];
  busy: boolean;
  onMissingTarget: (target: McpLocation, source: McpEntry | null) => void;
}) {
  const selectableRows = rows.filter((row) => sourceForMissing(row, page.targets));
  const allSelected = selectableRows.length > 0 && selectableRows.every(selected);
  const someSelected = !allSelected && selectableRows.some(selected);
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);
  return (
    <div className="domain-group mcp-domain-group">
      <h2>{page.label}</h2>
      {page.targets.length === 0 ? (
        <p>该域下没有可用的 MCP 目标。</p>
      ) : (
        <table className="matrix mcp-matrix">
          <thead>
            <tr>
              <th>
                <input
                  ref={allRef}
                  type="checkbox"
                  checked={allSelected}
                  disabled={busy || selectableRows.length === 0}
                  onChange={() => onSelectAll(!allSelected)}
                />
                服务
              </th>
              <th>传输</th>
              <th>来源位置</th>
              {page.targets.map((target) => (
                <th key={target.id} title={target.path}>
                  {target.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <McpRow
                key={row.name}
                row={row}
                targets={page.targets}
                selected={selected(row)}
                onToggle={() => onToggle(row)}
                locations={locations}
                busy={busy}
                onMissingTarget={onMissingTarget}
              />
            ))}
          </tbody>
        </table>
      )}
      {rows.length === 0 &&
        (query.trim() === "" && page.targets.some((target) => target.harnessId === "weiboap") ? (
          <p className="muted">
            该 WeiboAP 项目的 MCP 完整定义为空；WeiboAP
            中已启用的名称引用不等于可同步定义。请点击“引入…”从其他位置选择完整定义。
          </p>
        ) : (
          <p className="muted">没有匹配的 MCP 服务。</p>
        ))}
    </div>
  );
}

function McpRow({
  row,
  targets,
  selected,
  onToggle,
  locations,
  busy,
  onMissingTarget,
}: {
  row: McpDomainRow;
  targets: McpLocation[];
  selected: boolean;
  onToggle: () => void;
  locations: McpLocation[];
  busy: boolean;
  onMissingTarget: (target: McpLocation, source: McpEntry | null) => void;
}) {
  const source = sourceForMissing(row, targets);
  const disabled = busy || source === null;
  const sourceText = (entry: McpEntry) => {
    const location = locationOf(locations, entry.sourceId);
    return location?.label ?? entry.sourceId;
  };
  const sourceDetail = (entry: McpEntry) => {
    const location = locationOf(locations, entry.sourceId);
    return `${sourceText(entry)}${entry.reason ? `：${entry.reason}` : ""}${
      location ? `\n${location.path}` : ""
    }`;
  };
  const comparisonReason = (entry: McpEntry, cell: SourceCell["cell"], target: McpLocation) => {
    if (cell.reason === "来源条目无法无损转换") return entry.reason ?? cell.reason;
    if (cell.reason === "目标条目无法无损转换") {
      return (
        row.entries.find((candidate) => candidate.sourceId === target.id)?.reason ?? cell.reason
      );
    }
    if (cell.state === "sameEndpoint") {
      return `${cell.reason ?? CELL_LABEL[cell.state]}；动态请求头或认证信息未证明等价`;
    }
    return cell.reason ?? entry.reason ?? CELL_LABEL[cell.state];
  };
  const unavailableReason = (() => {
    if (
      source !== null ||
      !row.entries.some((entry) => entry.cells.some((cell) => cell.state === "missing"))
    ) {
      return undefined;
    }
    if (row.entries.some((entry) => entry.cells.some((cell) => cell.state === "conflict"))) {
      return "同名来源存在差异；请使用“引入…”选择明确来源";
    }
    if (row.entries.some((entry) => entry.cells.some((cell) => cell.state === "invalid"))) {
      return "存在配置无效的同名来源；请使用“引入…”选择明确来源";
    }
    if (row.entries.some((entry) => entry.cells.some((cell) => cell.state === "unsupported"))) {
      return "存在格式不支持的同名来源；请使用“引入…”选择明确来源";
    }
    return "没有可迁移的来源；请使用“引入…”选择明确来源";
  })();
  return (
    <tr>
      <td>
        <label title={unavailableReason}>
          <input type="checkbox" disabled={disabled} checked={selected} onChange={onToggle} />
          <code>{row.name}</code>
        </label>
      </td>
      <td>{[...new Set(row.entries.map(transportText))].join(" / ")}</td>
      <td title={row.entries.map(sourceDetail).join("\n")}>
        {row.entries.map(sourceText).join(" / ")}
      </td>
      {targets.map((target) => {
        const sourceCells = row.entries.flatMap((entry) => {
          const cell = entry.cells.find((candidate) => candidate.targetId === target.id);
          return cell ? [{ entry, cell }] : [];
        });
        const summary = summarizeMcpCell(sourceCells.map(({ cell }) => cell.state));
        const details = sourceCells
          .map(({ entry, cell }) => {
            const cannotCompare = cell.state === "invalid" || cell.state === "unsupported";
            const reason = comparisonReason(entry, cell, target);
            return `${sourceText(entry)} 与 ${target.label}：${reason}${
              cannotCompare ? `；与 ${target.label} 无法比较` : ""
            }`;
          })
          .join("\n");
        const candidates = supplementSourcesForTarget(row, target.id);
        const missingSource = sourceForMissingTarget(row, target.id);
        // 只有目标位置本身没有定义时才可补齐；同名的 own/equal/conflict 表示不能写入。
        const hasExistingDefinition = summary.defined;
        const hasMissing =
          !hasExistingDefinition && sourceCells.some(({ cell }) => cell.state === "missing");
        const missingTitle =
          missingSource !== null
            ? `从 ${sourceText(missingSource)} 补齐到 ${target.label}；勾选后预览写入。`
            : candidates.length > 1
              ? `有多个不等价的可迁移来源（${candidates
                  .map(sourceText)
                  .join("、")}）；勾选后在“引入…”中明确选择来源。`
              : "没有可迁移的来源。";
        const cellTitle = hasMissing ? `${missingTitle}\n${details}` : details;
        return (
          <td
            className={`cell mcp-cell-summary ${summary.className}`}
            title={details}
            key={target.id}
          >
            {hasMissing && candidates.length > 0 ? (
              <label className="mcp-cell-action" title={cellTitle}>
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busy || candidates.length === 0}
                  aria-label={`补齐 ${row.name} 到 ${target.label}`}
                  onChange={() => onMissingTarget(target, missingSource)}
                />
                <span>缺失</span>
              </label>
            ) : sourceCells.length > 0 ? (
              <span>{`${summary.defined ? "●" : "○"} ${summary.text}`}</span>
            ) : (
              <span>○ 缺失</span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

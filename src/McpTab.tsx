import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import Matrix, {
  cellKey,
  duplicatesAKey,
  type MatrixCellView,
  type MatrixRowView,
  type SelectionKey,
} from "./Matrix";
import { Empty as TableEmpty, PlusGlyph } from "./DomainView";
import McpImportPage from "./pages/McpImportPage";
import { pathsOfKey } from "./pages/pendingIssues";
import {
  cellViewOf,
  differingFields,
  differingSourceIds,
  mcpDomains,
  mcpGroupOf,
  sourceForMissing,
  sourceForMissingTarget,
  type McpDomain,
  type McpDomainRow,
} from "./mcpView";
import { AddButton, Confirm, Empty, Tag, Toast, TOAST_DWELL_MS } from "./ui";
import type { ConfirmAnchor } from "./ui";
import { toastFor, type ToastItem, type ToastText } from "./toastText";
import type {
  CellRef,
  McpUndoReport,
  McpAutoImportRule,
  McpEntry,
  McpLocation,
  McpOverview,
  McpPreview,
  McpReport,
  McpSelection,
} from "./types";
import "./McpTab.css";

/// MCP 页。**和 Skills 页是同一张表**（共享 `Matrix`），只是内容不同：
/// 行是 MCP 服务，列是配置位置，格是同一套状态点。
///
/// MCP 特有的差异：
/// 1. **格是单向的**——只有「写进去」，没有「拿掉」（core 只新增、不删条目）。
///    所以选择条上的键只有 `+N`；已经都有了的键禁用，不写 `−N`
/// 2. **实心不是一条链接，是一份独立副本**——写入后 core 留快照：写完没人改过就能撤销，
///    改过了撤销禁用，改给「在访达中显示备份 ↗」作手动兜底
/// 3. **差异是行级、不是格级**——`2 份不一样` 挂在服务名后（点状下划线，提示框给差异字段名）
/// 4. **批量或跨域写入要确认一道**（跨域会把请求头和令牌一并复制过去）；同域单格不确认

export interface McpTabProps {
  selectedKey: string;
  onDomains: (domains: { key: string; label: string }[]) => void;
  onError: (error: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  refreshKey: number;
  /// 每次扫描完回传一次（壳拿它数全局收件箱，不用再自己扫一遍）
  onOverview?: (overview: McpOverview) => void;
  /// 待处理页「跳回」：一条 MCP 待处理的 key（`McpPendingItem.key`，也收服务名）。
  /// 收到新值就滚到那一行（或读不出来的那一列列头）并闪一下；处理完回调 `onFocused`，
  /// 壳在那里把它清回 undefined，下次跳同一条才会再触发
  focusKey?: string;
  onFocused?: () => void;
}

/// 行键：同名服务在一个域里合成一行
const rowKeyOf = (row: McpDomainRow) => row.name;

/// 传输方式：只写真实的传输方式（DESIGN「主视图」）
const transportText = (entry: McpEntry): string | null =>
  entry.transport === "stdio" ? "stdio" : entry.transport === "http" ? "HTTP" : null;

/// 列头名：位置名里 agent 那一段。同一页里两列撞名（Claude Code 的 Local / Project）才带上作用域
const columnNames = (targets: McpLocation[]): Map<string, string> => {
  const head = (l: McpLocation) => l.label.split(" · ")[0];
  const out = new Map<string, string>();
  for (const t of targets) {
    const clash = targets.filter((o) => head(o) === head(t)).length > 1;
    const scope = t.label.split(" · ")[1]?.replace(/ MCPs$/, "");
    out.set(t.id, clash && scope ? `${head(t)} ${scope}` : head(t));
  }
  return out;
};

/// 组名：来源位置名，去掉 `MCPs` 这类泛称；全局位置补上 `User`（画板 Mcp「Claude Code · User」）
const groupLabel = (l: McpLocation | undefined, id: string): string => {
  if (!l) return id;
  const label = l.label.replace(/ MCPs$/, "");
  return l.domain === "global" && !label.includes(" · ") ? `${label} · User` : label;
};

/// 待确认的一次写入：批量与跨域确认，同域单格不确认
interface Pane {
  preview: McpPreview;
  crossDomain: boolean;
  anchor?: ConfirmAnchor;
  keyId?: string;
}

/// 触发控件此刻的位置：点下去的那颗键 / 那一格还拿着焦点
const anchorNow = (): ConfirmAnchor | undefined => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return undefined;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
};

export default function McpTab({
  selectedKey,
  onDomains,
  onError,
  busy,
  onBusy,
  refreshKey,
  onOverview,
  focusKey,
  onFocused,
}: McpTabProps) {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [autoImports, setAutoImports] = useState<McpAutoImportRule[]>([]);
  // 选中的行：域 key → 行键集合
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  // 单格歧义跳过来时预选的那个位置
  const [importTargetIds, setImportTargetIds] = useState<string[] | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  const [optimistic, setOptimistic] = useState<Set<string>>(new Set());
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  const [busyRows, setBusyRows] = useState<Map<string, string>>(new Map());
  const [flash, setFlash] = useState<{ keys: string[]; nonce: number; stagger?: number }>();
  const [cellNotice, setCellNotice] = useState<{
    rowKey: string;
    columnId: string;
    text: string;
  } | null>(null);
  const [keyToast, setKeyToast] = useState<{ keyId: string; node: ReactNode } | null>(null);
  const [globalToast, setGlobalToast] = useState<ReactNode>(null);
  // 本次会话里关掉的规则：来源位置 → 当时的目标，组头留一段灰的规则与开关好重开
  const [offRules, setOffRules] = useState<Map<string, McpAutoImportRule>>(new Map());
  const [focus, setFocus] = useState<{ rowKeys: string[]; columnId?: string; nonce: number }>();
  // `2 份不一样` 的字段级差异：悬停时懒加载一次（api.mcpFieldDiff）；null＝读不到，退回「配置不一样」
  const [diffs, setDiffs] = useState<Map<string, string[] | null>>(new Map());
  const diffAsked = useRef<Set<string>>(new Set());
  const focusedRef = useRef<string | undefined>(undefined);
  // 最近一次可撤销的写入（⌘Z 与提示条「撤销」走同一个）
  const undoRef = useRef<(() => void) | null>(null);
  const refreshVersion = useRef(0);
  const mounted = useRef(true);

  const dismissKey = useCallback(() => setKeyToast(null), []);
  const dismissGlobal = useCallback(() => setGlobalToast(null), []);

  const refresh = async () => {
    const version = ++refreshVersion.current;
    onBusy(true);
    try {
      const [next, rules] = await Promise.all([api.scanMcp(), api.listMcpAutoImports()]);
      if (mounted.current && version === refreshVersion.current) {
        setOverview(next);
        setAutoImports(rules);
        onOverview?.(next);
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

  // 聚焦、切项目、改设置都会自动重扫，所以没有「刷新」按钮
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // 自动规则在背后写了：右下黑窗交代一声（⑨⑬），被写进的格依次闪一下
  const domainsRef = useRef<McpDomain[]>([]);
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void listen<McpReport>("mcp-auto-imported", ({ payload }) => {
      const created = payload.entries.filter((entry) => entry.outcome === "created");
      if (created.length === 0) return;
      const targets = domainsRef.current.flatMap((d) => d.targets);
      const items: ToastItem[] = created.map((e) => {
        const t = targets.find((x) => x.id === e.targetId);
        return { name: e.name, agent: t ? { id: t.harnessId, name: t.label } : undefined };
      });
      setFlash({
        keys: created.map((e) => cellKey(e.name, e.targetId)),
        nonce: Date.now(),
        stagger: 40,
      });
      const text = toastFor("autoWrite", { done: items });
      setGlobalToast(
        <Toast
          {...text}
          names={items.length > 2 ? undefined : text.names}
          reading={items.length > 2 ? `${items.length} 个` : undefined}
          onDismiss={dismissGlobal}
          onClose={dismissGlobal}
        />,
      );
    }).then((un) => (disposed ? un() : unlistens.push(un)));
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
  }, [dismissGlobal]);

  const domains = useMemo(() => (overview ? mcpDomains(overview) : []), [overview]);
  domainsRef.current = domains;

  useEffect(() => {
    if (overview) onDomains(domains.map(({ key, label }) => ({ key, label })));
  }, [overview, domains, onDomains]);

  // 提示与二级页面只属于当次选择；选择与筛选跨侧栏切换保留
  useEffect(() => {
    setImportOpen(false);
    setImportTargetIds(null);
    setPane(null);
    setKeyToast(null);
    setCellNotice(null);
    // 默认一行不选；换一个位置时清空，不把别处的勾选带过来
    setSelected(new Set());
    undoRef.current = null;
  }, [selectedKey]);

  useEffect(() => {
    if (!cellNotice) return;
    const timer = setTimeout(() => setCellNotice(null), TOAST_DWELL_MS.cannot);
    return () => clearTimeout(timer);
  }, [cellNotice]);

  const page: McpDomain | null = domains.find((d) => d.key === selectedKey) ?? null;

  // 扫描变了，差异可能也变了：重新懒加载
  useEffect(() => {
    diffAsked.current = new Set();
    setDiffs(new Map());
  }, [overview]);

  const loadDiff = (name: string, locationIds: string[]) => {
    if (diffAsked.current.has(name)) return;
    diffAsked.current.add(name);
    void api
      .mcpFieldDiff(name, locationIds)
      .then((diff) =>
        setDiffs((prev) =>
          new Map(prev).set(name, diff.fields.length > 0 ? diff.fields.map((f) => f.field) : null),
        ),
      )
      .catch(() => setDiffs((prev) => new Map(prev).set(name, null)));
  };

  /// 提示框：列出不同的字段名；没加载完或读不到时用扫描里认得出的（url），都没有就写「配置不一样」
  const diffTip = (name: string, scanned: string[]) => {
    const loaded = diffs.get(name);
    const fields = loaded ?? scanned;
    return fields.length > 0 ? `${fields.join("、")} 不同` : "配置不一样";
  };

  // 待处理页跳回：key 里带着位置路径与 `#服务名`（与 core 同公式），认出行或列
  useEffect(() => {
    if (focusKey === undefined) {
      focusedRef.current = undefined;
      return;
    }
    if (!page || focusedRef.current === focusKey) return;
    focusedRef.current = focusKey;
    const paths = pathsOfKey(focusKey);
    const names = new Set(
      paths.flatMap((p) => {
        const i = p.lastIndexOf("#");
        return i >= 0 ? [p.slice(i + 1)] : [];
      }),
    );
    const rowKeys = page.rows
      .filter((row) => row.name === focusKey || names.has(row.name))
      .map(rowKeyOf);
    const columnId =
      rowKeys.length === 0 ? page.targets.find((t) => paths.includes(t.path))?.id : undefined;
    if (rowKeys.length > 0) setFilterText("");
    setFocus({ rowKeys, columnId, nonce: Date.now() });
    onFocused?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, page]);
  const locationOf = (id: string): McpLocation | undefined =>
    overview?.locations.find((location) => location.id === id);
  const labelOf = (id: string) => locationOf(id)?.label ?? id;

  const reveal = async (path: string) => {
    try {
      await api.revealInDir(path);
    } catch (e) {
      onError(String(e));
    }
  };

  /// 这一行为什么勾不动。空值表示可勾
  const blockedOf = (p: McpDomain, row: McpDomainRow): string | undefined => {
    if (sourceForMissing(row, p.targets) !== null) return undefined;
    const targetIds = new Set(p.targets.map((target) => target.id));
    const anyMissing = row.entries.some((entry) =>
      entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing"),
    );
    if (!anyMissing) return `${row.name} 在这里的每个位置上都已经有了`;
    // 「不支持」那行整行不可选：搬过去就不是原来那个了
    if (row.entries.every((entry) => entry.transport === "unsupported" || entry.reason !== null)) {
      return `${row.name} 用了只有 ${labelOf(row.entries[0].sourceId)} 认得的写法，搬到别处就不是原来那个了`;
    }
    return `有好几份不一样的同名 ${row.name}，用「+ MCP」指定用哪一份`;
  };

  // ===== 写入 =====

  const itemsOf = (entries: McpReport["entries"]): ToastItem[] =>
    entries.map((e) => {
      const l = locationOf(e.targetId);
      return { name: e.name, agent: l ? { id: l.harnessId, name: l.label } : undefined };
    });

  /// 写一批（已经确认过或不需要确认）。keyId 给了就把提示条贴在那颗键下
  const apply = async (preview: McpPreview, allowCrossDomain: boolean, keyId?: string) => {
    const keys = preview.actions.map((a) => cellKey(a.name, a.targetId));
    const rows = [...new Set(preview.actions.map((a) => a.name))];
    setPane(null);
    setOptimistic((prev) => new Set([...prev, ...keys]));
    setPendingCells(new Set(keys));
    setBusyRows(new Map(rows.map((r) => [r, `正在写进 ${keys.length} 处`])));
    onBusy(true);
    let result: McpReport | null = null;
    try {
      result = await api.applyMcp(preview.planId, allowCrossDomain);
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
      setPendingCells(new Set());
      setBusyRows(new Map());
    }
    if (result !== null) {
      const created = result.entries.filter((e) => e.outcome === "created");
      const failed = result.entries.filter((e) => e.outcome === "failed");
      setFlash({
        keys: created.map((e) => cellKey(e.name, e.targetId)),
        nonce: Date.now(),
        stagger: 40,
      });
      const text = toastFor("write", {
        done: itemsOf(created),
        failed: itemsOf(failed).map((item, i) => ({
          ...item,
          reason: `${labelOf(failed[i].targetId)} 那边没写成：${failed[i].message}`,
        })),
      });
      const undoId = result.undoId;
      const undo = undoId ? () => void undoWrite(undoId, keyId, text) : null;
      undoRef.current = undo;
      if (keyId !== undefined) {
        setKeyToast({
          keyId,
          node: (
            <Toast
              {...text}
              action={undo ? { label: "撤销", onClick: undo } : undefined}
              onDismiss={dismissKey}
              onClose={text.tier === "notice" ? dismissKey : undefined}
            />
          ),
        });
      } else if (failed.length > 0) {
        // 单格：不出提示条，失败时格下小黑窗说原因
        const f = failed[0];
        setCellNotice({ rowKey: f.name, columnId: f.targetId, text: f.message });
      }
    }
    await refresh();
    setOptimistic((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  };

  /// 撤销一次写入：core 只在文件仍等于写入后的样子时才从快照还原。改过了就撤不了——
  /// 撤销禁用、提示框说原因，另给「在访达中显示备份 ↗」作手动兜底（DESIGN「MCP 写入的撤销」）
  const undoWrite = async (undoId: string, keyId: string | undefined, text: ToastText) => {
    undoRef.current = null;
    let report: McpUndoReport;
    try {
      report = await api.mcpUndoWrite(undoId);
    } catch (error) {
      onError(String(error));
      return;
    }
    if (report.outcome === "undone") {
      setKeyToast(null);
      await refresh();
      return;
    }
    const backup = report.files.find((f) => f.backupPath !== null)?.backupPath ?? null;
    if (report.outcome === "changed") {
      const node = (
        <Toast
          {...text}
          action={{
            label: "撤销",
            onClick: () => undefined,
            disabledReason: "写入之后文件又被改过，没法安全撤销",
          }}
          secondary={
            backup === null
              ? undefined
              : { label: "在访达中显示备份", onClick: () => void reveal(backup) }
          }
          onDismiss={dismissKey}
        />
      );
      if (keyId !== undefined) setKeyToast({ keyId, node });
      else setGlobalToast(node);
      return;
    }
    setGlobalToast(
      <Toast
        kind="cannot"
        verb="没撤销"
        reason={report.message}
        onDismiss={dismissGlobal}
        onClose={dismissGlobal}
      />,
    );
  };

  /// 写入这些格。批量或跨域的先确认（锚在触发它的键 / 格下面）
  const write = async (selections: McpSelection[], keyId?: string) => {
    if (selections.length === 0) return;
    const anchor = anchorNow();
    let preview: McpPreview;
    try {
      preview = await api.proposeMcpSync(selections);
    } catch (error) {
      onError(String(error));
      return;
    }
    if (preview.actions.length === 0) {
      // 动作为空不等于「都已经有了」：同名已存在、来源读不出、格式搬不过去也都是空动作
      const reason = preview.issues[0]?.message ?? "这些位置上都已经有了，没有要新增的";
      if (keyId === undefined && selections.length === 1) {
        const s = selections[0];
        setCellNotice({ rowKey: s.name, columnId: s.targetId, text: reason });
      } else {
        setGlobalToast(
          <Toast
            kind="cannot"
            verb="没写进"
            reason={reason}
            onDismiss={dismissGlobal}
            onClose={dismissGlobal}
          />,
        );
      }
      return;
    }
    const crossDomain = preview.actions.some((action) => action.crossDomain);
    if (keyId !== undefined || crossDomain) {
      setPane({ preview, crossDomain, anchor, keyId });
      return;
    }
    // 同域单格：乐观点亮 + 闪一下，不确认、不出提示条
    await apply(preview, false);
  };

  /// 点一个空心格：同域单格直接写
  const onCell = (p: McpDomain, rowKey: string, targetId: string) => {
    const row = p.rows.find((r) => rowKeyOf(r) === rowKey);
    const target = p.targets.find((t) => t.id === targetId);
    if (!row || !target) return;
    const view = cellViewOf(row, target.id, labelOf);
    if (view === null || !view.clickable) return;
    setCellNotice(null);
    const source = sourceForMissingTarget(row, target.id);
    if (source === null) {
      // 有好几份不等价的同名来源，必须指定用哪一份 → 交给添加页
      setImportTargetIds([target.id]);
      setImportOpen(true);
      return;
    }
    void write([{ sourceId: source.sourceId, name: row.name, targetId: target.id }]);
  };

  // ===== 组头规则：只管以后新出现的 =====

  const setRule = async (rule: McpAutoImportRule, on: boolean) => {
    onBusy(true);
    try {
      if (on) {
        await api.setMcpAutoImport(
          rule.source.id,
          rule.targetDomain,
          rule.targets.map((t) => t.id),
          rule.allowCrossDomain,
        );
        setOffRules((prev) => {
          const next = new Map(prev);
          next.delete(`${rule.source.id}|${rule.targetDomain}`);
          return next;
        });
      } else {
        await api.removeMcpAutoImport(rule.source.id, rule.targetDomain);
        setOffRules((prev) => new Map(prev).set(`${rule.source.id}|${rule.targetDomain}`, rule));
      }
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
    await refresh();
  };

  // ===== 渲染 =====

  if (!overview) return <Empty kind="scanning" description="正在读 MCP 配置" />;

  if (overview.locations.length === 0) {
    return (
      <Empty
        kind="noAgentDirs"
        description="没找到 Claude Code、Codex 或 Cursor 的 MCP 配置文件"
        hint="只看文件里的配置；Claude.ai 的连接器和内置 MCP 不在其中"
      />
    );
  }

  if (page === null) {
    return (
      <Empty
        kind="noAgentDirs"
        description="这个位置下还没有可用的 MCP 配置位置"
        hint="添加第一个服务时会把配置文件建出来"
      />
    );
  }

  const targetIds = new Set(page.targets.map((t) => t.id));
  const names = columnNames(page.targets);
  const query = filterText.trim().toLowerCase();
  const visible = page.rows.filter((row) => query === "" || row.name.toLowerCase().includes(query));

  /// 格此刻画成什么：乐观点亮的画实心
  const viewAt = (row: McpDomainRow, targetId: string) => {
    const view = cellViewOf(row, targetId, labelOf);
    if (view === null) return null;
    return optimistic.has(cellKey(rowKeyOf(row), targetId))
      ? { ...view, dot: "linked" as const, clickable: false, reason: undefined }
      : view;
  };

  // ---- 列：第三层是这个位置下能用的条数 ----
  const columns = page.targets.map((target) => {
    const n = page.rows.filter(
      (row) => viewAt(row, target.id)?.dot === "linked" || viewAt(row, target.id)?.dot === "own",
    ).length;
    const name = names.get(target.id) ?? target.label;
    return {
      id: target.id,
      agentId: target.harnessId,
      name,
      count: n,
      tip: `${target.label} · ${n} 个已开启`,
    };
  });

  // ---- 分组：来源位置 ----
  const counts = new Map<string, number>();
  for (const row of page.rows) {
    const g = mcpGroupOf(row);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const groups = [...counts].map(([sourceId, count]) => {
    const live = autoImports.find((r) => r.source.id === sourceId && r.targetDomain === page.key);
    const rule = live ?? offRules.get(`${sourceId}|${page.key}`);
    return {
      key: sourceId,
      label: groupLabel(locationOf(sourceId), sourceId),
      title: locationOf(sourceId)?.path,
      count,
      rule:
        rule === undefined
          ? undefined
          : {
              on: live !== undefined,
              agents: rule.targets
                .filter((t) => targetIds.has(t.id))
                .map((t) => ({ id: t.harnessId, name: labelOf(t.id), columnId: t.id })),
              onToggle: (next: boolean) => void setRule(rule, next),
              disabledReason: busy ? "正在执行上一步操作" : undefined,
            },
    };
  });

  // ---- 行 ----
  const rows: MatrixRowView[] = visible.map((row) => {
    const key = rowKeyOf(row);
    const cells: Record<string, MatrixCellView | null> = {};
    const unsupportedAt: string[] = [];
    for (const target of page.targets) {
      const view = viewAt(row, target.id);
      if (view === null) {
        cells[target.id] = null;
        continue;
      }
      if (view.dot === "none") unsupportedAt.push(names.get(target.id) ?? target.label);
      cells[target.id] = {
        dot: view.dot,
        clickable: view.clickable,
        tip: view.clickable ? "点一下写进" : (view.reason ?? ""),
        pending: pendingCells.has(cellKey(key, target.id)),
      };
    }
    const differing = differingSourceIds(row, targetIds);
    const fields = differingFields(row, targetIds);
    const transports = [
      ...new Set(row.entries.map(transportText).filter((t): t is string => t !== null)),
    ];
    return {
      key,
      group: mcpGroupOf(row),
      name: row.name,
      cells,
      // 差异是行级事实，不进格：点状下划线，提示框给差异字段名（字段级原值 T3 在待处理页展开）
      mark:
        differing.length > 0 ? (
          <span
            onMouseEnter={() => loadDiff(row.name, differing)}
            onFocus={() => loadDiff(row.name, differing)}
          >
            <Tag tone="weak" tip={diffTip(row.name, fields)}>
              {`${differing.length} 份不一样`}
            </Tag>
          </span>
        ) : unsupportedAt.length > 0 ? (
          <Tag tone="weak" tip={`${unsupportedAt.join("、")} 不支持 ${row.name} 的接入方式`}>
            {`${unsupportedAt.join("、")} 不支持`}
          </Tag>
        ) : undefined,
      transport: transports.join(" / "),
      selectDisabledReason: blockedOf(page, row),
      // 行悬停「打开 ↗」：定义所在的配置文件
      reveal: (() => {
        const path = locationOf(row.entries[0]?.sourceId ?? "")?.path;
        return path === undefined ? undefined : { path, onReveal: () => void reveal(path) };
      })(),
      busy: busyRows.get(key),
    };
  });

  // ---- 选择操作条：已选的 × 每个位置，只写 `+N`（格是单向的） ----
  const chosen = visible.filter((row) => selected.has(rowKeyOf(row)));
  const missingAt = (targetId: string): McpSelection[] =>
    chosen.flatMap((row) => {
      const view = viewAt(row, targetId);
      const source = sourceForMissingTarget(row, targetId);
      return view?.clickable === true && source !== null
        ? [{ sourceId: source.sourceId, name: row.name, targetId }]
        : [];
    });
  // 动词键：MCP 只能写进、不能拿掉，所以动词只有「写进」；已经都有了的键禁用。
  // 受影响数 ≠ 已选数时才写「· N 个」
  const countIf = (n: number, total: number) => (n !== total ? n : undefined);
  const presses: { op: string; cells: CellRef[] }[] = [];
  const asRefs = (cells: McpSelection[]): CellRef[] =>
    cells.map((c) => ({ sourceId: c.sourceId, skill: c.name, targetId: c.targetId }));
  const keys: SelectionKey[] = page.targets.map((target) => {
    const cells = missingAt(target.id);
    const name = names.get(target.id) ?? target.label;
    const base = { id: target.id, agentId: target.harnessId, name, verb: "写进" };
    if (cells.length > 0) {
      presses.push({ op: "write", cells: asRefs(cells) });
      return {
        ...base,
        count: countIf(cells.length, chosen.length),
        tip: `把已选的写进 ${target.label}：新增 ${cells.length} 处`,
        onPress: () => void write(cells, target.id),
      };
    }
    const allOwn =
      chosen.length > 0 && chosen.every((row) => viewAt(row, target.id)?.dot === "own");
    return {
      ...base,
      disabledReason: allOwn
        ? `${target.label} · 已选的都定义在这里`
        : `已选的在 ${target.label} 里都有了，或写不过去`,
      onPress: () => undefined,
    };
  });
  const allMissing = page.targets.flatMap((t) => missingAt(t.id));
  // 「全部」与某颗键做同一件事时隐藏
  const selectionAll: SelectionKey | undefined =
    allMissing.length === 0 || duplicatesAKey({ op: "write", cells: asRefs(allMissing) }, presses)
      ? undefined
      : {
          id: "all",
          verb: "全部写进",
          count: countIf(allMissing.length, chosen.length * page.targets.length),
          tip: `写进所有还缺它的位置：共新增 ${allMissing.length} 处`,
          onPress: () => void write(allMissing, "all"),
        };

  const openImport = () => {
    setImportTargetIds(null);
    setImportOpen(true);
  };
  const addAction = { label: "MCP", onClick: openImport, icon: <PlusGlyph /> };
  const empty =
    query !== "" ? (
      <TableEmpty
        text={`没有名字里带「${filterText.trim()}」的服务`}
        action={{ label: "清除筛选", onClick: () => setFilterText("") }}
      />
    ) : page.targets.some((target) => target.harnessId === "weiboap") ? (
      <TableEmpty text="这里没有能复制的完整定义，从别处添加一份过来" action={addAction} />
    ) : (
      <TableEmpty text={`${page.label} 还没有自己的 MCP 配置`} action={addAction} />
    );

  // 写进 WeiboAP 的那几处要额外说一句：它只收下定义，启用是它自己的事
  const paneHasWeibo =
    pane !== null &&
    pane.preview.actions.some((action) => locationOf(action.targetId)?.harnessId === "weiboap");

  return (
    <section className="mx-page mcp-tab">
      <Matrix
        columns={columns}
        groups={groups}
        rows={rows}
        nameLabel="服务"
        nameTip="定义住在哪一格由原件环表示"
        nameCount={page.rows.length}
        transportLabel="传输"
        filterText={filterText}
        onFilterText={setFilterText}
        addButton={<AddButton noun="MCP" onClick={openImport} />}
        selected={selected}
        onSelectionChange={(next) => {
          setSelected(next);
          if (next.size === 0) setKeyToast(null);
        }}
        selectionKeys={keys}
        selectionAll={selectionAll}
        onUndo={() => undoRef.current?.()}
        busy={busy}
        onCell={(rowKey, columnId) => onCell(page, rowKey, columnId)}
        shortcuts={!importOpen && pane === null}
        empty={empty}
        flash={flash}
        cellNotice={cellNotice}
        keyToast={keyToast}
        globalToast={globalToast}
        focus={focus}
      />

      {/* 批量与跨域的那一道确认，锚在触发它的键 / 格下面。跳过的项目留在这里——它是做决定所需的信息 */}
      {pane !== null && (
        <Confirm
          title={`写进 ${new Set(pane.preview.actions.map((a) => a.targetId)).size} 个位置？`}
          anchor={pane.anchor}
          safetyNote={
            pane.crossDomain
              ? "有几处要写到另一个位置去：完整定义里可能带着请求头或令牌，会一并复制过去"
              : "已经存在的同名配置不会被覆盖；写进已有文件前会先备份"
          }
          confirmLabel="写进去"
          onConfirm={() => void apply(pane.preview, pane.crossDomain, pane.keyId)}
          onCancel={() => setPane(null)}
        >
          <ul className="mcp-confirm-list">
            {pane.preview.actions.slice(0, 12).map((action) => (
              <li key={`${action.sourceId}|${action.targetId}|${action.name}`}>
                {action.name} → {labelOf(action.targetId)}
              </li>
            ))}
            {pane.preview.actions.length > 12 && (
              <li className="mcp-confirm-more">还有 {pane.preview.actions.length - 12} 处</li>
            )}
          </ul>
          {paneHasWeibo && (
            <div className="mcp-confirm-note">
              写进 WeiboAP 的只是定义，还要在它里面启用；已经开着的会话可能要重开。
            </div>
          )}
          {pane.preview.issues.map((issue, i) => (
            <div key={`${issue.locationId}|${issue.name ?? ""}|${i}`} className="mcp-confirm-note">
              跳过 {issue.name ?? labelOf(issue.locationId)}：{issue.message}
            </div>
          ))}
        </Confirm>
      )}

      {importOpen && (
        <McpImportPage
          overview={overview}
          page={page}
          initialTargetIds={importTargetIds ?? undefined}
          autoImports={autoImports}
          onClose={() => {
            setImportOpen(false);
            setImportTargetIds(null);
          }}
          onChange={refresh}
          onPreview={(preview) => {
            setImportOpen(false);
            setImportTargetIds(null);
            if (preview.actions.length === 0) {
              setGlobalToast(
                <Toast
                  kind="cannot"
                  verb="没写进"
                  reason={preview.issues[0]?.message ?? "这些位置上都已经有了，没有要新增的"}
                  onDismiss={dismissGlobal}
                  onClose={dismissGlobal}
                />,
              );
              return;
            }
            setPane({
              preview,
              crossDomain: preview.actions.some((action) => action.crossDomain),
            });
          }}
          onError={onError}
          onNotice={(text) =>
            setGlobalToast(
              <Toast
                kind="cannot"
                verb="没添加"
                reason={text}
                onDismiss={dismissGlobal}
                onClose={dismissGlobal}
              />,
            )
          }
        />
      )}
    </section>
  );
}

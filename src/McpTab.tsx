import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { ActionButton, dim } from "./DomainView";
import McpImportPage from "./pages/McpImportPage";
import {
  cellViewOf,
  differingSourceIds,
  mcpDomains,
  sourceForMissing,
  sourceForMissingTarget,
  type McpDomain,
  type McpDomainRow,
} from "./mcpView";
import {
  differentCopiesMessage,
  differentCopiesTag,
  differentCopiesTitle,
  viewOf,
  type McpIssueKind,
} from "./mcpCellState";
import { issueKey } from "./pages/pendingIssues";
import {
  AgentIcon,
  AgentMark,
  Button,
  Chip,
  Confirm,
  Empty,
  StateDot,
  Toast,
  type LampState,
  type ToastKind,
} from "./ui";
import type {
  McpAutoImportRule,
  McpEntry,
  McpLocation,
  McpLocationRef,
  McpOverview,
  McpPreview,
  McpReport,
  McpSelection,
} from "./types";
import "./McpTab.css";

/// MCP 页。**和 Skill 页是同一个界面，只是内容不同**（spec 核心判断）：
/// 一批东西 × 一批位置的矩阵、自动规则行、引入页、待处理栏，骨架整套复用 SkillsTab。
///
/// MCP 特有的四处差异（spec §设计）：
/// 1. **格是单向的**——只有「写进去」，没有「拿掉」（core 只新增、不删条目）。
///    所以选择条上的位置片不是开关，是「还缺几处、点一下写进去」。
/// 2. **实心不是一条链接，是一份独立副本**——每一处都是别人配置文件里的一段真实内容。
///    写入从界面上不可逆，所以提示条给的是「看看备份」，不是「撤销」。
/// 3. **差异是行级、不是格级**（R2）——`conflict` 做成服务名后的方标签。
/// 4. **列的身份是文件，不是 agent**——同一个 agent 在一个域里可能有多个 MCP 位置。

export interface McpTabProps {
  selectedKey: string;
  onDomains: (domains: { key: string; label: string }[]) => void;
  onError: (error: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  refreshKey: number;
}

/// 选择状态的键：域 + 服务名（同名服务在一个域里合成一行）
const rowKey = (page: McpDomain, row: McpDomainRow) => `${page.key}|${row.name}`;

/// 区域标签档（§1.2）
const LABEL: CSSProperties = {
  fontFamily: "var(--font-cond)",
  fontSize: "var(--size-label)",
  fontWeight: 600,
  letterSpacing: "var(--track-label)",
  textTransform: "uppercase",
};
const MONO: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "var(--size-mono)" };

/// 不可点的方标签：零圆角，因为圆角只给可点的东西（§3.1）
const TAG: CSSProperties = {
  ...LABEL,
  color: "var(--ink)",
  border: "1px solid var(--ink)",
  padding: "1px 5px",
  marginLeft: 8,
};

/// 待处理栏：主视图底部常驻一条，一次一条，处理完跳下一条（§4.3）
const PENDING_BAR: CSSProperties = {
  position: "sticky",
  bottom: 0,
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 16,
  padding: "9px 0",
  borderTop: "1px solid var(--ink)",
  background: "var(--canvas)",
};

/// 传输方式：一行里几个来源可能不同，去重后并排写
const transportText = (entry: McpEntry) =>
  entry.transport === "stdio" ? "标准输入输出" : entry.transport === "http" ? "HTTP" : "不支持";

/// 备份文件名：提示条的副行只放文件名，完整路径在「看看备份」那个动作里
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/// 提示条的内容；一次操作只汇总成一句，新的替换旧的（§4.1）
interface Notice {
  kind: ToastKind;
  message: ReactNode;
  /// 副行等宽统计
  stats?: string;
  /// MCP 写入不可逆，所以这里不是「撤销」，而是「看看备份」「去看看」
  action?: { label: string; onClick: () => void };
}

/// 待处理栏里的一条：要用户拿主意，且带得出自己的动作
interface Pending {
  key: string;
  kind: McpIssueKind;
  /// 一句完整的话，来自 mcpCellState，不在这里另写一份
  message: string;
  /// 动作要在访达里打开的文件
  paths: string[];
}

/// 待确认的一次写入。同域单格不确认，批量与跨域确认（spec §确认的口径）
interface Pane {
  preview: McpPreview;
  crossDomain: boolean;
}

export default function McpTab({
  selectedKey,
  onDomains,
  onError,
  busy,
  onBusy,
  refreshKey,
}: McpTabProps) {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [autoImports, setAutoImports] = useState<McpAutoImportRule[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 选中的行，默认为空；键见 rowKey
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Shift 区间选择的锚点：域 key → 上次点击的行键
  const [anchor, setAnchor] = useState<Map<string, string>>(new Map());
  // 筛选：服务名子串（大小写不敏感）+ 每个域各自高亮的来源位置（空 = 不筛）
  const [filterText, setFilterText] = useState("");
  const [filterSources, setFilterSources] = useState<Map<string, Set<string>>>(new Map());
  const [importOpen, setImportOpen] = useState(false);
  // 单格歧义跳过来时预选的那个位置
  const [importTargetIds, setImportTargetIds] = useState<string[] | null>(null);
  const [importPageOverride, setImportPageOverride] = useState<McpDomain | null>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  // 忽略过的状况，落盘在 settings.json。key 由 core 的 IgnoredIssue::key_for 算，
  // 前端这份走同一个公式（tests/issue-key-contract.test.ts 两边钉死）——
  // 涉及的位置有变化，key 就变，自然重新提示
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  // 待处理栏当前停在第几条
  const [cursor, setCursor] = useState(0);
  const refreshVersion = useRef(0);
  const mounted = useRef(true);

  const refresh = async () => {
    const version = ++refreshVersion.current;
    onBusy(true);
    try {
      const [next, rules, ignoredList] = await Promise.all([
        api.scanMcp(),
        api.listMcpAutoImports(),
        api.listIgnored(),
      ]);
      if (mounted.current && version === refreshVersion.current) {
        setOverview(next);
        setAutoImports(rules);
        setIgnored(new Set(ignoredList.map((i) => i.key)));
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

  // 聚焦、切项目、改设置都会自动重扫，所以没有「刷新」按钮（R6）
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // scanMcp 已在自动执行后返回重扫结果；事件只负责汇报，避免失败项触发循环重试
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void listen<McpReport>("mcp-auto-imported", ({ payload }) => {
      const n = payload.entries.filter((entry) => entry.outcome === "created").length;
      if (n === 0) return;
      setNotice({ kind: "success", message: `自动引入写进了 ${n} 处`, stats: `${n} 处新增` });
    }).then((un) => (disposed ? un() : unlistens.push(un)));
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
  }, []);

  const domains = useMemo(() => (overview ? mcpDomains(overview) : []), [overview]);

  useEffect(() => {
    if (overview) onDomains(domains.map(({ key, label }) => ({ key, label })));
  }, [overview, domains, onDomains]);

  // 提示与二级页面只属于当次选择；选择与筛选跨侧栏切换保留
  useEffect(() => {
    setNotice(null);
    setImportOpen(false);
    setImportPageOverride(null);
    setImportTargetIds(null);
    setPane(null);
    setCursor(0);
  }, [selectedKey]);

  const pages =
    selectedKey === "all" ? domains : domains.filter((page) => page.key === selectedKey);

  const locationOf = (id: string): McpLocation | undefined =>
    overview?.locations.find((location) => location.id === id);
  const labelOf = (id: string) => locationOf(id)?.label ?? id;
  /// 整份文件读不出来的那些位置：列头灯加一道斜杠，并进待处理栏（spec §其余功能的落位）
  const invalidIds = new Set(
    (overview?.issues ?? []).filter((issue) => issue.name === null).map((i) => i.locationId),
  );

  const reveal = async (path: string) => {
    try {
      await api.revealInDir(path);
    } catch (e) {
      onError(String(e));
    }
  };

  /// 经过筛选、要显示出来的行
  const visibleRows = (page: McpDomain): McpDomainRow[] => {
    const query = filterText.trim().toLowerCase();
    const sources = filterSources.get(page.key);
    return page.rows.filter(
      (row) =>
        (query === "" || row.name.toLowerCase().includes(query)) &&
        (sources === undefined ||
          sources.size === 0 ||
          row.entries.some((entry) => sources.has(entry.sourceId))),
    );
  };

  const isSelected = (page: McpDomain, row: McpDomainRow) => selected.has(rowKey(page, row));

  /// 这一行为什么勾不动。空值表示可勾
  const blockedOf = (page: McpDomain, row: McpDomainRow): string | undefined => {
    if (sourceForMissing(row, page.targets) !== null) return undefined;
    const targetIds = new Set(page.targets.map((target) => target.id));
    const anyMissing = row.entries.some((entry) =>
      entry.cells.some((cell) => targetIds.has(cell.targetId) && cell.state === "missing"),
    );
    if (!anyMissing) return `${row.name} 在本域的每个位置上都已经有了`;
    // 「不支持」那行整行不可选：搬过去就不是原来那个了（R1）
    if (row.entries.every((entry) => entry.transport === "unsupported" || entry.reason !== null)) {
      return `${row.name} 用了只有 ${labelOf(row.entries[0].sourceId)} 认得的写法，搬到别处就不是原来那个了`;
    }
    return `有好几份不一样的同名 ${row.name}，用「引入 MCP」指定用哪一份`;
  };

  /// 点行首复选框：Shift 时把锚点到本行之间（按当前显示顺序）的行都设成本次的状态
  const toggleRow = (
    page: McpDomain,
    row: McpDomainRow,
    shiftKey: boolean,
    ordered: McpDomainRow[],
  ) => {
    const key = rowKey(page, row);
    const want = !selected.has(key);
    const anchorKey = anchor.get(page.key);
    const from =
      shiftKey && anchorKey !== undefined
        ? ordered.findIndex((r) => rowKey(page, r) === anchorKey)
        : -1;
    const to = ordered.findIndex((r) => rowKey(page, r) === key);
    const span =
      from >= 0 && to >= 0 ? ordered.slice(Math.min(from, to), Math.max(from, to) + 1) : [row];
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of span) {
        if (blockedOf(page, r) !== undefined) continue;
        if (want) next.add(rowKey(page, r));
        else next.delete(rowKey(page, r));
      }
      return next;
    });
    setAnchor((prev) => new Map(prev).set(page.key, key));
  };

  /// 表头复选框：只作用于当前可见、且勾得动的行
  const setPageAll = (page: McpDomain, want: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of visibleRows(page)) {
        if (blockedOf(page, row) !== undefined) continue;
        if (want) next.add(rowKey(page, row));
        else next.delete(rowKey(page, row));
      }
      return next;
    });

  const clearFilter = () => {
    setFilterText("");
    setFilterSources(new Map());
  };

  // ===== 写入 =====

  /// 一次写入的结果，**汇总成一句**（§4.1）。撤销给不了——MCP 写入从界面上不可逆，
  /// 所以给的是备份的去向（spec §设计 2）
  const report = (result: McpReport) => {
    const created = result.entries.filter((entry) => entry.outcome === "created");
    const failed = result.entries.filter((entry) => entry.outcome === "failed");
    const names = new Set(created.map((entry) => entry.name));
    const targets = new Set(created.map((entry) => entry.targetId));
    // 同一个文件里的多条只有第一条带备份路径，所以按位置算：这个位置有备份 = 文件本来就在
    const backedUp = new Set(
      created.filter((entry) => entry.backupPath !== null).map((entry) => entry.targetId),
    );
    const newFiles = [...targets].filter((id) => !backedUp.has(id)).length;
    const backup = created.find((entry) => entry.backupPath !== null)?.backupPath ?? null;
    const one = [...names][0];
    const fail = (entry: McpReport["entries"][number]) =>
      `${labelOf(entry.targetId)} 那边没写成——${entry.message}`;

    if (created.length === 0) {
      if (failed.length > 0) setNotice({ kind: "cannot", message: fail(failed[0]) });
      return;
    }
    const message =
      created.length === 1
        ? `把 ${one} 写进了 ${labelOf(created[0].targetId)}`
        : names.size === 1
          ? `把 ${one} 写进了 ${targets.size} 处`
          : `在 ${targets.size} 处写进了 ${names.size} 个服务`;
    const stats = [
      newFiles > 0 ? `新建 ${newFiles} 个文件` : null,
      `${created.length} 处新增`,
      backup === null ? null : baseName(backup),
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    setNotice({
      kind: failed.length === 0 ? "success" : "partial",
      message:
        failed.length === 0
          ? message
          : `${message}，${failed.length} 处没写成——${failed[0].message}`,
      stats,
      // 写入不可逆，能给的只有「备份在哪」
      action:
        backup === null ? undefined : { label: "看看备份", onClick: () => void reveal(backup) },
    });
  };

  const apply = async (preview: McpPreview, allowCrossDomain: boolean) => {
    onBusy(true);
    try {
      const result = await api.applyMcp(preview.planId, allowCrossDomain);
      setPane(null);
      setSelected(new Set());
      report(result);
    } catch (error) {
      onError(String(error));
    } finally {
      onBusy(false);
    }
    await refresh();
  };

  /// 写入这些格。`batch` 为真表示这一次动了不止一处，要先确认（spec §确认的口径）
  const write = async (selections: McpSelection[], batch: boolean) => {
    if (selections.length === 0) return;
    onBusy(true);
    let preview: McpPreview;
    try {
      preview = await api.proposeMcpSync(selections);
    } catch (error) {
      onError(String(error));
      return;
    } finally {
      onBusy(false);
    }
    if (preview.actions.length === 0) {
      // 动作为空不等于「都已经有了」：同名已存在、来源读不出、格式搬不过去也都是空动作，
      // 所以这里说的是后端给出的那条具体原因
      setNotice({
        kind: "cannot",
        message: preview.issues[0]?.message ?? "这些位置上都已经有了，没有要新增的",
      });
      return;
    }
    const crossDomain = preview.actions.some((action) => action.crossDomain);
    if (batch || crossDomain) {
      setPane({ preview, crossDomain });
      return;
    }
    await apply(preview, false);
  };

  /// 点一个空心格：同域单格直接写，提示条给备份名
  const clickCell = (page: McpDomain, row: McpDomainRow, target: McpLocation) => {
    const view = cellViewOf(row, target.id, labelOf);
    if (view === null) return;
    if (!view.clickable) {
      if (view.reason === undefined) return;
      setNotice({
        kind: "cannot",
        message: view.reason,
        action:
          view.issue === "invalidLocation"
            ? { label: "去看看", onClick: () => void reveal(target.path) }
            : undefined,
      });
      return;
    }
    const source = sourceForMissingTarget(row, target.id);
    if (source === null) {
      // 有好几份不等价的同名来源，必须指定用哪一份 → 交给引入页
      setImportPageOverride(page);
      setImportTargetIds([target.id]);
      setImportOpen(true);
      return;
    }
    void write([{ sourceId: source.sourceId, name: row.name, targetId: target.id }], false);
  };

  // ===== 选择操作条 =====

  // 操作只作用于「选中且可见」的行
  const chosen = pages.map((page) => ({
    page,
    rows: visibleRows(page).filter((row) => isSelected(page, row)),
  }));
  const chosenCount = chosen.reduce((n, { rows }) => n + rows.length, 0);

  /// 选中的行在这一列上还缺的那些格。位置片数的就是它（§11：计数带单位）
  const missingAt = (targetId: string): McpSelection[] =>
    chosen.flatMap(({ page, rows }) =>
      page.targets.some((target) => target.id === targetId)
        ? rows.flatMap((row) => {
            const view = cellViewOf(row, targetId, labelOf);
            const source = sourceForMissingTarget(row, targetId);
            return view?.clickable === true && source !== null
              ? [{ sourceId: source.sourceId, name: row.name, targetId }]
              : [];
          })
        : [],
    );

  // 当前几页的全部位置，按 id 去重
  const barTargets: McpLocation[] = [];
  for (const page of pages) {
    for (const target of page.targets) {
      if (!barTargets.some((t) => t.id === target.id)) barTargets.push(target);
    }
  }
  const allMissing = barTargets.flatMap((target) => missingAt(target.id));

  // ===== 待处理栏 =====

  const pending: Pending[] = [];
  // 扫描问题：位置级的（整份文件读不出来）和条目级的都收在这儿，不另起错误横幅——
  // 横幅只留给应用级故障（spec §其余功能的落位）
  const pageKeys = new Set(pages.map((page) => page.key));
  for (const issue of overview?.issues ?? []) {
    const location = locationOf(issue.locationId);
    if (location === undefined || !pageKeys.has(location.domain)) continue;
    // key 必须和 core 的 IgnoredIssue::key_for 同源，否则写进 settings.json 的
    // 那个和下次算出来的对不上——忽略会看起来生效、重启后失效。
    // 条目名并进标识里：同一个文件里两条不同名的问题，光靠路径会算出同一个 key，
    // 忽略一条就把另一条也吞了
    const ident = issue.name === null ? location.path : `${location.path}#${issue.name}`;
    pending.push({
      key: issueKey("invalidLocation", [ident]),
      kind: "invalidLocation",
      message:
        issue.name === null
          ? (viewOf("invalid", { service: "", location: location.label, source: "" }).reason ?? "")
          : `${location.label} 里的 ${issue.name} 这次读不出来：${issue.message}`,
      paths: [ident],
    });
  }
  for (const page of pages) {
    const targetIds = new Set(page.targets.map((target) => target.id));
    // 行级：两处各有一份、连的地址不一样（R2）
    for (const row of page.rows) {
      const ids = differingSourceIds(row, targetIds);
      if (ids.length === 0) continue;
      // 同上：与 core 同源。服务名并进去，否则同一组位置上的两个服务会撞 key
      const paths = [...ids.map((id) => locationOf(id)?.path ?? id), `#${row.name}`];
      pending.push({
        key: issueKey("differentCopies", paths),
        kind: "differentCopies",
        message: differentCopiesMessage(row.name, ids.map(labelOf)),
        paths,
      });
    }
  }
  const open = pending.filter((issue) => !ignored.has(issue.key));
  const index = Math.min(cursor, Math.max(open.length - 1, 0));
  const current = open[index] ?? null;

  /// 待处理栏里这一条自己的动作。**不给「覆盖 / 合并」**——`prepare` 对目标已有的
  /// 同名条目一律跳过，覆盖是新的破坏性能力，要单独定 spec（R2）
  const actionsOf = (issue: Pending): ReactNode => (
    <ActionButton
      size="compact"
      title={issue.paths.join("\n")}
      onClick={() => {
        for (const path of issue.paths) void reveal(path);
      }}
    >
      {issue.kind === "differentCopies" ? "看两边差在哪" : "去看看"}
    </ActionButton>
  );

  // ===== 渲染 =====

  if (!overview) return <Empty kind="scanning" description="正在看这台机器上都装了什么…" />;

  if (overview.locations.length === 0) {
    return (
      <Empty
        kind="noAgentDirs"
        description="没找到 Claude Code、Codex 或 Cursor 的 MCP 配置文件。"
        hint="只扫描文件配置；Claude.ai 的连接器和内置 MCP 不在其中。"
      />
    );
  }

  // 写进 WeiboAP 的那几处要额外说一句：它只收下定义，启用是它自己的事
  const paneHasWeibo =
    pane !== null &&
    pane.preview.actions.some((action) => locationOf(action.targetId)?.harnessId === "weiboap");

  // 引入只对单个域有意义：「全部」页没有确定的目标域
  const sidebarImportPage = selectedKey === "all" ? null : (pages[0] ?? null);
  const importPage = importPageOverride ?? sidebarImportPage;

  return (
    <section>
      <div className="toolbar" style={dim(busy)}>
        <ActionButton
          onClick={() => {
            setImportPageOverride(null);
            setImportTargetIds(null);
            setImportOpen(true);
          }}
          disabled={sidebarImportPage === null}
          disabledReason="请先在侧栏选一个位置"
          title="从别处搬一份完整定义过来"
        >
          引入 MCP
        </ActionButton>
      </div>

      {/* 筛选输入框不受 busy 约束（§6），所以它不在上面那个置灰的容器里 */}
      <div className="toolbar filters">
        <input
          type="search"
          placeholder="筛选 MCP 服务"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      {chosenCount > 0 && (
        <div className="toolbar selection">
          <span style={LABEL}>已选 {chosenCount} 个服务</span>
          {/* 取消选择是 busy 的豁免项：它不写磁盘 */}
          <ActionButton variant="link" onClick={() => setSelected(new Set())}>
            取消选择
          </ActionButton>
          {/* 位置片不是开关，是「还缺几处、点一下写进去」：格是单向的（spec §设计 1） */}
          <span style={{ display: "flex", alignItems: "center", gap: 8, ...dim(busy) }}>
            {barTargets.map((target) => {
              const cells = missingAt(target.id);
              return cells.length === 0 ? (
                <Chip
                  key={target.id}
                  icon={<AgentIcon id={target.harnessId} name={target.label} />}
                  disabled
                  disabledReason={`选中的服务在 ${target.label} 里都已经有了`}
                >
                  {target.label}
                </Chip>
              ) : (
                <Chip
                  key={target.id}
                  icon={<AgentIcon id={target.harnessId} name={target.label} />}
                  title={`把选中的服务写进 ${target.path}`}
                  onClick={() => void write(cells, true)}
                >
                  {target.label} <span style={MONO}>{cells.length} 处</span>
                </Chip>
              );
            })}
            {barTargets.length > 1 &&
              (allMissing.length === 0 ? (
                <Chip disabled disabledReason="选中的服务在本域每个位置上都已经有了">
                  写进全部
                </Chip>
              ) : (
                <Chip
                  title="把选中的服务写进本域还缺它的每一个位置"
                  onClick={() => void write(allMissing, true)}
                >
                  写进全部 <span style={MONO}>{allMissing.length} 处</span>
                </Chip>
              ))}
          </span>
        </div>
      )}

      {pages.length === 0 ? (
        <Empty
          kind="noAgentDirs"
          description="这个位置下还没有可用的 MCP 配置位置。"
          hint="引入第一个服务时会把配置文件建出来。"
        />
      ) : (
        pages.map((page) => (
          <McpDomainView
            key={page.key}
            page={page}
            rows={visibleRows(page)}
            labelOf={labelOf}
            invalidIds={invalidIds}
            hasEntries={(id) => overview.entries.some((entry) => entry.sourceId === id)}
            busy={busy}
            rules={autoImports.filter((rule) => rule.targetDomain === page.key)}
            onRemoveRule={async (rule) => {
              onBusy(true);
              try {
                await api.removeMcpAutoImport(rule.source.id, rule.targetDomain);
              } catch (error) {
                onError(String(error));
              } finally {
                onBusy(false);
              }
              await refresh();
            }}
            activeSources={filterSources.get(page.key) ?? new Set()}
            onToggleSource={(sourceId) =>
              setFilterSources((prev) => {
                const next = new Map(prev);
                const set = new Set(next.get(page.key) ?? []);
                if (set.has(sourceId)) set.delete(sourceId);
                else set.add(sourceId);
                next.set(page.key, set);
                return next;
              })
            }
            onClearSources={() =>
              setFilterSources((prev) => {
                const next = new Map(prev);
                next.delete(page.key);
                return next;
              })
            }
            filtered={filterText.trim() !== "" || (filterSources.get(page.key)?.size ?? 0) > 0}
            onClearFilter={clearFilter}
            onImport={() => {
              setImportPageOverride(page);
              setImportTargetIds(null);
              setImportOpen(true);
            }}
            isSelected={(row) => isSelected(page, row)}
            blockedOf={(row) => blockedOf(page, row)}
            onToggle={(row, shiftKey, ordered) => toggleRow(page, row, shiftKey, ordered)}
            onSelectAll={(want) => setPageAll(page, want)}
            onCell={(row, target) => clickCell(page, row, target)}
            onReveal={(locationId) => {
              const path = locationOf(locationId)?.path;
              if (path !== undefined) void reveal(path);
            }}
          />
        ))
      )}

      {/* 待处理栏：一次一条，处理完跳下一条（§4.3） */}
      {current !== null && (
        <div style={PENDING_BAR}>
          <span style={{ fontSize: "var(--size-body)" }}>{current.message}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, ...dim(busy) }}>
            {actionsOf(current)}
            <ActionButton
              variant="link"
              title="这一条先别提示了；位置有变化时会重新提示"
              onClick={() => {
                // 先乐观更新再写盘：这一条马上从栏里消失，用户不用等 IPC
                setIgnored((prev) => new Set(prev).add(current.key));
                setCursor(0);
                void api.ignoreIssue(current.kind, current.paths).catch(onError);
              }}
            >
              忽略
            </ActionButton>
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ ...MONO, color: "var(--ink-mute)" }}>待处理 {open.length}</span>
            {open.length > 1 && (
              <>
                <ActionButton
                  variant="link"
                  onClick={() => setCursor((index - 1 + open.length) % open.length)}
                >
                  上一条
                </ActionButton>
                <span style={{ ...MONO, color: "var(--ink-mute)" }}>
                  {index + 1} / {open.length}
                </span>
                <ActionButton variant="link" onClick={() => setCursor((index + 1) % open.length)}>
                  下一条
                </ActionButton>
              </>
            )}
          </span>
        </div>
      )}

      {notice && (
        <Toast
          kind={notice.kind}
          message={notice.message}
          stats={notice.stats}
          action={notice.action}
          onDismiss={() => setNotice(null)}
          onClose={() => setNotice(null)}
        />
      )}

      {/* 批量与跨域的那一道确认。跳过的项目留在这里——它是做决定所需的信息 */}
      {pane !== null && (
        <Confirm
          title={`写进 ${new Set(pane.preview.actions.map((a) => a.targetId)).size} 个位置`}
          body={
            <>
              <div>
                这些服务会原样写过去，已经存在的同名配置不会被覆盖；写进已有文件前会先备份。
              </div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 20, ...MONO }}>
                {pane.preview.actions.slice(0, 12).map((action) => (
                  <li key={`${action.sourceId}|${action.targetId}|${action.name}`}>
                    {action.name} → {labelOf(action.targetId)}
                  </li>
                ))}
              </ul>
              {pane.preview.actions.length > 12 && (
                <div style={{ ...MONO, color: "var(--ink-faint)" }}>
                  …还有 {pane.preview.actions.length - 12} 处
                </div>
              )}
            </>
          }
          warning={
            pane.crossDomain || paneHasWeibo || pane.preview.issues.length > 0 ? (
              <>
                {pane.crossDomain && (
                  <div>
                    有几处要写到另一个域去。完整定义里可能带着请求头或令牌，会一并复制过去。
                  </div>
                )}
                {/* WeiboAP 只收下定义，开不开是它自己的事，别让用户以为写完就能用 */}
                {paneHasWeibo && (
                  <div>写进 WeiboAP 的只是定义，还要在它里面启用；已经开着的会话可能要重开。</div>
                )}
                {pane.preview.issues.map((issue, i) => (
                  <div key={`${issue.locationId}|${issue.name ?? ""}|${i}`}>
                    跳过 {issue.name ?? labelOf(issue.locationId)}：{issue.message}
                  </div>
                ))}
              </>
            ) : undefined
          }
          confirmLabel="写进去"
          onConfirm={() => void apply(pane.preview, pane.crossDomain)}
          onCancel={() => setPane(null)}
        />
      )}

      {importOpen && importPage !== null && (
        <McpImportPage
          overview={overview}
          page={importPage}
          initialTargetIds={importTargetIds ?? undefined}
          autoImports={autoImports}
          onClose={() => {
            setImportOpen(false);
            setImportPageOverride(null);
            setImportTargetIds(null);
          }}
          onChange={refresh}
          onPreview={(preview) => {
            setImportOpen(false);
            setImportPageOverride(null);
            setImportTargetIds(null);
            if (preview.actions.length === 0) {
              setNotice({
                kind: "cannot",
                message: preview.issues[0]?.message ?? "这些位置上都已经有了，没有要新增的",
              });
              return;
            }
            setPane({
              preview,
              crossDomain: preview.actions.some((action) => action.crossDomain),
            });
          }}
          onError={onError}
          onNotice={(text) => setNotice({ kind: "cannot", message: text })}
        />
      )}
    </section>
  );
}

/// 一个域的整页：筛选片、自动引入行、行×位置的矩阵
function McpDomainView({
  page,
  rows: visible,
  labelOf,
  invalidIds,
  hasEntries,
  busy,
  rules,
  onRemoveRule,
  activeSources,
  onToggleSource,
  onClearSources,
  filtered,
  onClearFilter,
  onImport,
  isSelected,
  blockedOf,
  onToggle,
  onSelectAll,
  onCell,
  onReveal,
}: {
  page: McpDomain;
  rows: McpDomainRow[];
  labelOf: (id: string) => string;
  invalidIds: Set<string>;
  hasEntries: (id: string) => boolean;
  busy: boolean;
  rules: McpAutoImportRule[];
  onRemoveRule: (rule: McpAutoImportRule) => Promise<void>;
  activeSources: Set<string>;
  onToggleSource: (sourceId: string) => void;
  onClearSources: () => void;
  filtered: boolean;
  onClearFilter: () => void;
  onImport: () => void;
  isSelected: (row: McpDomainRow) => boolean;
  blockedOf: (row: McpDomainRow) => string | undefined;
  onToggle: (row: McpDomainRow, shiftKey: boolean, ordered: McpDomainRow[]) => void;
  onSelectAll: (want: boolean) => void;
  onCell: (row: McpDomainRow, target: McpLocation) => void;
  /// 在访达里定位某个位置的配置文件
  onReveal: (locationId: string) => void;
}) {
  const targetIds = new Set(page.targets.map((target) => target.id));

  /// 列头那盏灯说的是**文件**，不是服务（§9）：实心＝在、能写；空心＝还没有这个文件；
  /// 加一道斜杠＝这次读不出来，整列都写不进
  const lampOf = (target: McpLocation): LampState => {
    if (invalidIds.has(target.id)) return "unwritable";
    return hasEntries(target.id) ? "writable" : "missing";
  };
  const lampTitle = (target: McpLocation) => {
    const note = invalidIds.has(target.id)
      ? "这次读不出来，整列都写不进去"
      : hasEntries(target.id)
        ? null
        : "这个文件里还没有服务，写第一条时会建出来";
    return note === null ? target.path : [target.path, note].join("\n");
  };

  // 筛选片按本域全部行统计来源位置，筛选不改变片上的计数（§11）
  const counts = new Map<string, number>();
  for (const row of page.rows) {
    for (const sourceId of new Set(row.entries.map((entry) => entry.sourceId))) {
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
  }

  /// 这条规则下一轮会**新写入**的条数，不含已经有的（§11 的口径）
  const pendingOf = (rule: McpAutoImportRule, local: string[]) =>
    page.rows
      .filter((row) => row.entries.some((entry) => entry.sourceId === rule.source.id))
      .reduce((n, row) => {
        const entry = row.entries.find((candidate) => candidate.sourceId === rule.source.id);
        if (entry === undefined || entry.reason !== null || entry.transport === "unsupported") {
          return n;
        }
        if (rule.excluded.includes(row.name)) return n;
        return (
          n +
          entry.cells.filter((cell) => local.includes(cell.targetId) && cell.state === "missing")
            .length
        );
      }, 0);

  /// 规则里的位置名。位置这轮没被发现时退回路径——**规则照样要列出来**，
  /// 否则用户就再也关不掉它了
  const nameOfRef = (ref: McpLocationRef) => {
    const label = labelOf(ref.id);
    return label === ref.id ? ref.path : label;
  };
  // 本域的规则全列。`local` 只是用来数「还差几条」，不决定这一行出不出现
  const localRules = rules.map((rule) => ({
    rule,
    local: rule.targets.map((target) => target.id).filter((id) => targetIds.has(id)),
  }));

  // 表头全选框只看可见、且勾得动的行
  const selectable = visible.filter((row) => blockedOf(row) === undefined);
  const allSelected = selectable.length > 0 && selectable.every(isSelected);
  const someSelected = !allSelected && selectable.some(isSelected);
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const table = (
    <table className="matrix mcp-matrix">
      <thead>
        <tr>
          <th style={{ borderBottom: "1px solid var(--ink)" }}>
            {/* 表头整行不置灰，只灰这个全选框（§6 第二条细节） */}
            <input
              ref={allRef}
              type="checkbox"
              checked={allSelected}
              style={dim(busy)}
              disabled={busy || selectable.length === 0}
              onChange={() => onSelectAll(!allSelected)}
            />
            <span style={LABEL}>服务</span>
          </th>
          <th style={{ borderBottom: "1px solid var(--ink)" }}>
            <span style={LABEL}>传输</span>
          </th>
          <th style={{ borderBottom: "1px solid var(--ink)" }}>
            <span style={LABEL}>来源位置</span>
          </th>
          {page.targets.map((target) => (
            <th
              key={target.id}
              style={{ borderBottom: "1px solid var(--ink)", textAlign: "center" }}
            >
              {/* 列的身份是文件，所以名字是**位置名**，不是 agent 名（spec §设计 4） */}
              <AgentMark
                id={target.harnessId}
                name={target.label}
                layout="stacked"
                lamp={lampOf(target)}
                title={lampTitle(target)}
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody style={dim(busy)}>
        {visible.map((row) => {
          const selected = isSelected(row);
          const blocked = blockedOf(row);
          const differing = differingSourceIds(row, targetIds);
          const transports = [...new Set(row.entries.map(transportText))];
          return (
            <tr key={row.name} style={selected ? { background: "var(--surface)" } : undefined}>
              <td>
                <label
                  style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                  title={blocked}
                >
                  {/* 用 onClick 是为了拿到 shiftKey；选中态仍由上层状态决定 */}
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={busy || blocked !== undefined}
                    readOnly
                    onClick={(e) => onToggle(row, e.shiftKey, visible)}
                  />
                  <span style={{ fontSize: "var(--size-body)" }}>{row.name}</span>
                </label>
                {/* 差异是行级事实，不进格（R2）：两处各有一份、连的地址不一样 */}
                {differing.length > 0 && (
                  <span style={TAG} title={differentCopiesTitle(differing.map(labelOf))}>
                    {differentCopiesTag(differing.length)}
                  </span>
                )}
              </td>
              <td className="mcp-transport">{transports.join(" / ")}</td>
              <td className="path">
                {row.entries.map((entry, i) => (
                  <span key={entry.sourceId}>
                    {i > 0 && <span style={{ color: "var(--ink-faint)" }}> · </span>}
                    <Button
                      variant="link"
                      title={entry.reason ?? "在访达里打开这份定义所在的文件"}
                      onClick={() => onReveal(entry.sourceId)}
                    >
                      {labelOf(entry.sourceId)}
                    </Button>
                  </span>
                ))}
              </td>
              {page.targets.map((target) => {
                const view = cellViewOf(row, target.id, labelOf);
                // 无格态：这一行在这一列没有格（§8）
                if (view === null) {
                  return (
                    <td className="cell" key={target.id}>
                      <StateDot dot="none" title="这个位置不在当前域" />
                    </td>
                  );
                }
                const title = view.clickable ? `把 ${row.name} 写进 ${target.label}` : view.reason;
                return (
                  <td className="cell" key={target.id}>
                    <StateDot
                      dot={view.dot}
                      title={title}
                      onClick={busy ? undefined : () => onCell(row, target)}
                      label={`${row.name} · ${target.label}`}
                    />
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="domain-group mcp-domain-group">
      <h2>{page.label}</h2>

      {counts.size > 0 && (
        <div className="tags" style={dim(busy)}>
          {/* 「全部 N」与各片同源：本域的服务行数（§11） */}
          <Chip selected={activeSources.size === 0} onClick={onClearSources}>
            全部 <span style={MONO}>{page.rows.length}</span>
          </Chip>
          {[...counts].map(([sourceId, n]) => (
            <Chip
              key={sourceId}
              selected={activeSources.has(sourceId)}
              onClick={() => onToggleSource(sourceId)}
            >
              {labelOf(sourceId)} <span style={MONO}>{n}</span>
            </Chip>
          ))}
        </div>
      )}

      {/* 自动引入行：只读一行，顶多关掉。不展开、没有展开箭头（R5、§12） */}
      {localRules.map(({ rule, local }) => (
        <div
          key={`${rule.source.id}|${rule.targetDomain}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            border: "1px solid var(--hairline)",
            padding: "7px 12px",
            marginBottom: 10,
          }}
        >
          <span style={LABEL}>自动引入</span>
          <span style={{ fontSize: "var(--size-body)" }}>
            {nameOfRef(rule.source)} <span style={{ color: "var(--ink-faint)" }}>→</span>{" "}
            {rule.targets.map(nameOfRef).join(" · ")}
          </span>
          {/* 计数带单位：裸的「+2」紧跟在位置列表后面会被读成「还有 2 个位置」（§11） */}
          <span style={{ ...MONO, color: "var(--ink-mute)" }}>
            {pendingOf(rule, local)} 条待写入
            {rule.excluded.length > 0 && `（排除 ${rule.excluded.length}）`}
          </span>
          <span style={{ marginLeft: "auto", ...dim(busy) }}>
            <Button
              size="compact"
              title="以后这个位置新增的服务不再自动写进本域"
              onClick={() => void onRemoveRule(rule)}
            >
              关掉
            </Button>
          </span>
        </div>
      ))}

      {/* 表头照常渲染，即使一行都没有——列在、灯空心，用户才看得出往哪儿写 */}
      {page.targets.length > 0 && table}
      {visible.length === 0 &&
        (filtered ? (
          <Empty
            kind="noMatch"
            description="没有匹配的服务"
            secondary={{ label: "清除筛选", onClick: onClearFilter }}
          />
        ) : page.targets.some((target) => target.harnessId === "weiboap") ? (
          <Empty
            kind="noSkills"
            description="这里没有能复制的完整定义。"
            hint="WeiboAP 里启用的只是服务名，不是可搬运的定义；从别处引一份过来。"
            primary={{ label: "引入 MCP", onClick: onImport }}
          />
        ) : (
          <Empty
            kind="noSkills"
            description={`${page.label} 还没有自己的 MCP 配置。`}
            hint="引入第一个服务时会把配置文件建出来。"
            primary={{ label: "引入 MCP", onClick: onImport }}
          />
        ))}
    </div>
  );
}

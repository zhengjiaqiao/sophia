import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { canSupplement, importedInDomain, mcpDomainLabel, type McpDomain } from "../mcpView";
import type { McpAutoImportRule, McpEntry, McpLocation, McpOverview, McpPreview } from "../types";
import { AgentIcon, Busy, Button, Chip, Confirm, Empty, SubPage } from "../ui";
import "./McpImportPage.css";

/// 导入页（组件规范 §4.6、spec R4）：占满整窗的二级页面，不是弹层。
///
/// 结构与 skill 的导入页完全一致——左边挑来源位置，右边把那个位置里的服务**全部列出**，
/// 底下横排选要写进哪些位置。弹层里三栏挤在 960px 内、列表要滚，改成页面就是为了铺开。
///
/// 与 skill 导入页的两处不同：
/// ①来源可以是**别的域**的位置（跨域会在确认那一步单独说清）；
/// ②目标里包含矩阵藏起来的那些位置（`matrixHidden`）——藏它们是为了不在每一行上
/// 报一堆缺失，但它们仍然是导入的显式目标，入口只在这一页。

export interface McpImportPageProps {
  overview: McpOverview;
  page: McpDomain;
  /// 单格歧义入口只预选被点的那个位置；从工具栏进来则默认全选
  initialTargetIds?: string[];
  autoImports: McpAutoImportRule[];
  onClose: () => void;
  /// 规则改完要重扫：后端会在扫描里执行自动导入
  onChange: () => Promise<void>;
  /// 选好了要导入哪些服务：把预览交回主视图去确认、执行
  onPreview: (preview: McpPreview) => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
}

const entryKey = (entry: McpEntry) => `${entry.sourceId}|${entry.name}`;

/// 传输方式，行尾的次要信息
const transportText = (entry: McpEntry) =>
  entry.transport === "stdio" ? "标准输入输出" : entry.transport === "http" ? "HTTP" : "不支持";

/// 切成若干竖排的列，按列读。数量少时两列就够
function columnsOf<T>(list: T[], count: number): T[][] {
  const per = Math.ceil(list.length / count);
  return Array.from({ length: count }, (_, i) => list.slice(i * per, (i + 1) * per)).filter(
    (col) => col.length > 0,
  );
}

const CHECK_GLYPH = (
  <svg
    width="8"
    height="8"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    aria-hidden="true"
  >
    <path d="M2 5.2l2 2 4-4.4" />
  </svg>
);

/// 12px 复选方块。整行是按钮，方块本身只是画出来的记号（与导入 skill 那页同形）
function CheckBox({ on, dim }: { on: boolean; dim?: boolean }) {
  const classes = ["ss-check"];
  if (on) classes.push("is-on");
  if (dim) classes.push("is-dim");
  return (
    <span className={classes.join(" ")} aria-hidden="true">
      {on ? CHECK_GLYPH : null}
    </span>
  );
}

export default function McpImportPage({
  overview,
  page,
  initialTargetIds,
  autoImports,
  onClose,
  onChange,
  onPreview,
  onError,
  onNotice,
}: McpImportPageProps) {
  /// 本域全部位置，**包含矩阵里藏起来的**：这一页是它们唯一的入口
  const domainTargets = useMemo(
    () => overview.locations.filter((location) => location.domain === page.key),
    [overview.locations, page.key],
  );
  /// 可以当来源的位置：矩阵藏起来的那些本来就是空的，挑不出东西
  const sources = useMemo(
    () => overview.locations.filter((location) => location.matrixHidden !== true),
    [overview.locations],
  );
  const defaultTargetIds = useMemo(
    () =>
      (initialTargetIds ?? domainTargets.map((target) => target.id)).filter((id) =>
        domainTargets.some((target) => target.id === id),
      ),
    [domainTargets, initialTargetIds],
  );

  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [names, setNames] = useState<string[]>([]);
  const [targetIds, setTargetIds] = useState<string[]>(defaultTargetIds);
  const [busy, setBusy] = useState(false);
  // 待确认的「开启自动导入」
  const [confirmAuto, setConfirmAuto] = useState(false);

  const source = overview.locations.find((location) => location.id === sourceId);
  const rule = autoImports.find((r) => r.source.id === sourceId && r.targetDomain === page.key);
  const auto = rule !== undefined;
  const isCrossDomain = source !== undefined && source.domain !== page.key;

  const targetIdSet = useMemo(() => new Set(targetIds), [targetIds]);
  const sourceEntries = useMemo(
    () => overview.entries.filter((entry) => entry.sourceId === sourceId),
    [overview.entries, sourceId],
  );
  const canPick = (entry: McpEntry) => canSupplement(entry, targetIdSet);
  const pickable = sourceEntries.filter(canPick);

  // 切换来源时清空勾选（导入是一次性动作，不预填）
  useEffect(() => setNames([]), [sourceId]);

  // 规则里的目标就是规则说了算；没有规则时回到默认全选。
  // 用字符串做依赖，内容没变的重扫不会覆盖用户当场的勾选
  const ruleTargetIds = (rule?.targets ?? [])
    .map((target) => target.id)
    .filter((id) => domainTargets.some((target) => target.id === id));
  const initKey = `${sourceId}|${ruleTargetIds.join(",")}|${defaultTargetIds.join(",")}`;
  useEffect(() => {
    setTargetIds(ruleTargetIds.length > 0 ? ruleTargetIds : defaultTargetIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  // 选中的来源消失（项目被移除）时回落到第一个
  useEffect(() => {
    if (overview.locations.some((location) => location.id === sourceId)) return;
    setSourceId(sources[0]?.id ?? "");
  }, [overview.locations, sources, sourceId]);

  // 勾选的服务在目标变了之后可能不再可写，顺手摘掉
  useEffect(() => {
    setNames((previous) =>
      previous.filter((name) =>
        sourceEntries.some((entry) => entry.name === name && canSupplement(entry, targetIdSet)),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIdSet, sourceId]);

  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await act();
      await onChange();
    } catch (e) {
      onError(String(e));
    }
    setBusy(false);
  };

  /// 位置名。矩阵里藏起来的那些要说清点下去会发生什么
  const targetLabel = (target: McpLocation) => {
    if (target.matrixHidden !== true) return target.label;
    return target.selector === undefined
      ? `${target.label}（会新建 .mcp.json）`
      : `${target.label}（写进 Claude 的 Local 配置）`;
  };

  /// 开关自动导入。勾上会把这个位置现有和以后新增的完整定义都写过去，影响面大，先确认
  const toggleAuto = () => {
    if (source === undefined) return;
    if (!auto) {
      setConfirmAuto(true);
      return;
    }
    void run(() => api.removeMcpAutoImport(source.id, page.key));
  };

  const enableAuto = () => {
    if (source === undefined) return;
    setConfirmAuto(false);
    void run(() => api.setMcpAutoImport(source.id, page.key, targetIds, isCrossDomain));
  };

  /// 位置选择。规则已开启时同时改写规则（全取消 = 撤掉规则）
  const toggleTarget = (id: string) => {
    const next = targetIds.includes(id)
      ? targetIds.filter((target) => target !== id)
      : [...targetIds, id];
    setTargetIds(next);
    if (!auto || source === undefined) return;
    const allow = rule?.allowCrossDomain ?? isCrossDomain;
    void run(() =>
      next.length === 0
        ? api.removeMcpAutoImport(source.id, page.key)
        : api.setMcpAutoImport(source.id, page.key, next, allow),
    );
  };

  const toggleName = (name: string) =>
    setNames((previous) =>
      previous.includes(name) ? previous.filter((n) => n !== name) : [...previous, name],
    );

  const doImport = async () => {
    if (source === undefined) return;
    const selections = names.flatMap((name) => {
      const entry = sourceEntries.find((candidate) => candidate.name === name);
      if (entry === undefined) return [];
      return entry.cells
        .filter((cell) => targetIdSet.has(cell.targetId) && cell.state === "missing")
        .map((cell) => ({ sourceId: entry.sourceId, name, targetId: cell.targetId }));
    });
    if (selections.length === 0) {
      onNotice("选中的服务在这些位置上都已经有了，没有要新增的");
      return;
    }
    setBusy(true);
    try {
      onPreview(await api.proposeMcpSync(selections));
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  };

  // 一行一个服务，已经有的也列出来（灰着、点不动）——全在眼前，不用猜漏了谁
  const entries = sourceEntries.map((entry) => ({
    entry,
    name: entry.name,
    transport: transportText(entry),
    pickable: canPick(entry),
    // 本域任一位置已有等价定义 = 已经引进来了
    imported: importedInDomain(entry, page),
    unsupported: entry.transport === "unsupported" || entry.reason !== null,
  }));
  const columns = columnsOf(entries, entries.length > 28 ? 3 : 2);
  const allSelected = pickable.length > 0 && pickable.every((entry) => names.includes(entry.name));

  /// 每个来源位置右侧那个数：现在能往选中位置里补几个
  const countOf = (location: McpLocation) =>
    overview.entries.filter(
      (entry) => entry.sourceId === location.id && canSupplement(entry, targetIdSet),
    ).length;

  const targetLabels = domainTargets
    .filter((target) => targetIds.includes(target.id))
    .map((target) => target.label)
    .join("、");

  /// 列表头右侧那句：先说这个来源现在的状况
  const note =
    pickable.length === 0
      ? auto
        ? "这里以后新增的服务会自动写过去，不用再来挑"
        : "这里的服务在选中的位置上都已经有了"
      : null;

  const blocked = busy
    ? "正在处理，等这一下"
    : names.length === 0
      ? "先在列表里勾上要导入的服务"
      : targetIds.length === 0
        ? "先选至少一个位置"
        : null;

  return (
    <SubPage title="导入 MCP" onBack={onClose} aside={`把这些服务加进「${page.label}」`}>
      <div className="ss-import">
        <div className="ss-import__cols">
          <Busy busy={busy} className="ss-import__sources">
            <div className="ss-import__caption">
              来源位置
              <span>能补齐</span>
            </div>
            <div className="ss-import__srclist">
              {sources.map((location) => (
                <div
                  key={location.id}
                  className={
                    location.id === sourceId ? "ss-import__source is-active" : "ss-import__source"
                  }
                >
                  <button
                    type="button"
                    className="ss-import__pick"
                    title={location.path}
                    aria-current={location.id === sourceId}
                    onClick={() => setSourceId(location.id)}
                  >
                    <span className="ss-import__srcname">{location.label}</span>
                    <span className="ss-mcp__srcdomain">{mcpDomainLabel(location.domain)}</span>
                    <span className="ss-import__count">{countOf(location)}</span>
                  </button>
                </div>
              ))}
            </div>
          </Busy>

          <div className="ss-import__main">
            {source === undefined ? (
              <Empty
                kind="noSkills"
                description="没找到任何能当来源的 MCP 配置文件。"
                hint="Claude Code、Codex、Cursor 的配置文件里有服务定义时才会出现在这儿。"
              />
            ) : (
              <>
                <Busy busy={busy} className="ss-import__fixed">
                  <button
                    type="button"
                    className="ss-import__auto"
                    role="checkbox"
                    aria-checked={auto}
                    disabled={targetIds.length === 0}
                    title={targetIds.length === 0 ? "先选至少一个位置" : source.path}
                    onClick={toggleAuto}
                  >
                    <CheckBox on={auto} dim={targetIds.length === 0} />
                    这个位置以后新增的服务，自动写进下面选中的位置
                  </button>
                </Busy>

                <div className="ss-import__listhead">
                  <span className="ss-import__headline">
                    {source.label} · {sourceEntries.length} 个服务
                  </span>
                  {pickable.length > 0 ? (
                    <Button
                      variant="link"
                      size="compact"
                      onClick={() =>
                        setNames(allSelected ? [] : pickable.map((entry) => entry.name))
                      }
                    >
                      {allSelected ? "取消全选" : "全选"}
                    </Button>
                  ) : null}
                  {note ? <span className="ss-import__note">{note}</span> : null}
                </div>

                <Busy busy={busy} className="ss-import__grid">
                  {columns.map((col) => (
                    <div className="ss-import__col" key={col[0].name}>
                      {col.map((item) => {
                        const on = names.includes(item.name);
                        return (
                          <button
                            key={entryKey(item.entry)}
                            type="button"
                            className="ss-import__row"
                            role="checkbox"
                            aria-checked={on}
                            disabled={!item.pickable}
                            title={
                              item.unsupported
                                ? `${item.name} 用了只有 ${source.label} 认得的写法，搬到别处就不是原来那个了`
                                : item.pickable
                                  ? `${source.path} 里的 ${item.name}`
                                  : `${item.name} 在选中的位置上都已经有了`
                            }
                            onClick={() => toggleName(item.name)}
                          >
                            <CheckBox on={on} dim={!item.pickable} />
                            <span className="ss-import__name">{item.name}</span>
                            <span className="ss-mcp__transport">{item.transport}</span>
                            {item.unsupported ? (
                              <span className="ss-import__tag">搬不过去</span>
                            ) : !item.pickable && item.imported ? (
                              <span className="ss-import__tag is-quiet">已有</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </Busy>

                <Busy busy={busy} className="ss-mcp__targets">
                  <div className="ss-import__label">写进以下位置</div>
                  <div className="ss-import__chips">
                    {domainTargets.length === 0 ? (
                      <span className="ss-import__hint">
                        这个位置下还没有任何 MCP 配置文件，导入第一个服务时会建出来
                      </span>
                    ) : (
                      domainTargets.map((target) => (
                        <Chip
                          key={target.id}
                          icon={<AgentIcon id={target.harnessId} name={target.label} />}
                          selected={targetIds.includes(target.id)}
                          title={target.path}
                          onClick={() => toggleTarget(target.id)}
                        >
                          {targetLabel(target)}
                        </Chip>
                      ))
                    )}
                    <span className="ss-import__hint">
                      至少选一个：写进哪个位置，那个 agent 才认得它
                    </span>
                  </div>
                </Busy>
              </>
            )}
          </div>
        </div>

        <div className="ss-import__foot">
          <span className="ss-import__hint">
            只新增，不覆盖已有的同名配置
            {source ? (
              <>
                {" · 这份定义来自 "}
                <span className="ss-import__path">{source.path}</span>
              </>
            ) : null}
          </span>
          <div className="ss-import__actions">
            <Button variant="link" onClick={onClose}>
              取消
            </Button>
            {blocked ? (
              <Button disabled disabledReason={blocked}>
                导入
              </Button>
            ) : (
              <Button onClick={() => void doImport()}>导入 {names.length} 个</Button>
            )}
          </div>
        </div>
      </div>

      {confirmAuto && source !== undefined ? (
        <Confirm
          title="开启自动导入"
          body={`「${source.label}」里现在和以后新增的完整定义，都会写进 ${targetLabels}。已经存在的同名配置不会被覆盖。`}
          warning={
            isCrossDomain
              ? `来源在「${mcpDomainLabel(source.domain)}」、目标在「${page.label}」，是两个域。完整定义里可能带着请求头或令牌，会一并复制过去；写进已有文件前会先备份。`
              : "完整定义里可能带着请求头或令牌，会一并复制过去；写进已有文件前会先备份。"
          }
          confirmLabel="开启自动导入"
          onConfirm={enableAuto}
          onCancel={() => setConfirmAuto(false)}
        />
      ) : null}
    </SubPage>
  );
}

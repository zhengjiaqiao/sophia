import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { canSupplement, importedInDomain, mcpDomainLabel, type McpDomain } from "../mcpView";
import type { McpAutoImportRule, McpEntry, McpLocation, McpOverview, McpPreview } from "../types";
import { Busy, Button, SubPage, Switch } from "../ui";
import { displayPath } from "../pathText.ts";
import { RowTip } from "./RowTip.tsx";
import { AddedFold } from "./AddedFold.tsx";
import { CheckMark } from "./CheckMark.tsx";
import { TargetCheck } from "./TargetCheck.tsx";
import {
  addLabel,
  defaultTargets,
  distinguishingSegments,
  loadImportMemory,
  saveImportMemory,
  sameSet,
  selectAllState,
  toggleAll,
} from "./importDefaults.ts";
import "./McpImportPage.css";

/// 添加 MCP 页（DESIGN「产品裁决 › 添加页」，画板 McpImport）：与添加 skill 页**逐句对称**，
/// 只换名词，骨架是同一份（ImportPage.css）。
///
/// 与 skill 那页的不同：
/// - 左栏是**位置**（`Claude Code · User`），第二行灰字写它在哪（`全局` / `项目 · CardBox`）；
///   位置是发现出来的，没有 `+ 来源`
/// - 列表多一列 `传输`（HTTP / stdio）
/// - 底部目标（复选框 + 图标 + 名字，与 skill 页同一种写法）是本域的全部位置，**包含主视图里
///   藏起来的**（`matrixHidden`）——这一页是它们唯一的入口；**来源自己那个位置禁用**，提示「这就是来源」
/// - `添加 N 个` 不直接写：把预览交回 MCP 页，批量或跨域写入在那里确认一道
///   （跨域会把请求头和令牌一并复制过去）
/// - 行内开关「此来源以后新出现的 MCP 自动添加」：core 建规则时拍 baseline，只管以后新出现的，所以不确认；
///   来源读不出来时 core 拒绝建规则，原话挂到壳的错误横幅上

export interface McpImportPageProps {
  overview: McpOverview;
  page: McpDomain;
  /// 单格歧义入口只预选被点的那个位置；从工具栏进来走默认值
  initialTargetIds?: string[];
  autoImports: McpAutoImportRule[];
  onClose: () => void;
  /// 规则改完要重扫：后端会在扫描里执行自动添加
  onChange: () => Promise<void>;
  /// 选好了要添加哪些服务：把预览交回主视图去确认、执行
  onPreview: (preview: McpPreview) => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
}

const entryKey = (entry: McpEntry) => `${entry.sourceId}|${entry.name}`;

/// 传输方式：只写真实的传输方式
const transportText = (entry: McpEntry) =>
  entry.transport === "stdio" ? "stdio" : entry.transport === "http" ? "HTTP" : "—";

/// 位置名。主视图里藏起来的那些要说清点下去会发生什么
const targetLabel = (target: McpLocation) => {
  if (target.matrixHidden !== true) return target.label;
  return target.selector === undefined
    ? `${target.label}（新建 .mcp.json）`
    : `${target.label}（Local）`;
};

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
  /// 本域全部位置，**包含主视图藏起来的**：这一页是它们唯一的入口
  const domainTargets = useMemo(
    () => overview.locations.filter((location) => location.domain === page.key),
    [overview.locations, page.key],
  );
  /// 可以当来源的位置：主视图藏起来的那些本来就是空的，挑不出东西
  const sources = useMemo(
    () => overview.locations.filter((location) => location.matrixHidden !== true),
    [overview.locations],
  );

  /// 这个位置能往本域其余位置补几个（排序与默认选中用：不随当场勾上的目标变）
  const freshCount = (location: McpLocation) => {
    const others = new Set(domainTargets.filter((t) => t.id !== location.id).map((t) => t.id));
    return overview.entries.filter((e) => e.sourceId === location.id && canSupplement(e, others))
      .length;
  };
  /// 左栏顺序：还有能补的排前面，没有的排后面；**进页时定一次**，添加完不跳位
  const [order] = useState(() =>
    [...sources]
      .sort((a, b) => Number(freshCount(b) > 0) - Number(freshCount(a) > 0))
      .map((x) => x.id),
  );
  const sortedSources = [
    ...order.flatMap((id) => sources.filter((x) => x.id === id)),
    ...sources.filter((x) => !order.includes(x.id)),
  ];
  /// 名字和所在域都一样的位置，第二行再带上路径里能区分它们的那一级
  const distinct = new Map<string, string>();
  const scopeKey = (x: McpLocation) => `${x.label}|${mcpDomainLabel(x.domain)}`;
  for (const k of new Set(sources.map(scopeKey))) {
    const same = sources.filter((x) => scopeKey(x) === k);
    if (same.length < 2) continue;
    distinguishingSegments(same.map((x) => x.path)).forEach((seg, i) =>
      distinct.set(same[i].id, seg),
    );
  }
  // 默认选中第一个还有能补的位置
  const [sourceId, setSourceId] = useState(
    () => sortedSources.find((x) => freshCount(x) > 0)?.id ?? sortedSources[0]?.id ?? "",
  );
  const [names, setNames] = useState<string[]>([]);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const source = overview.locations.find((location) => location.id === sourceId);
  const rule = autoImports.find((r) => r.source.id === sourceId && r.targetDomain === page.key);
  const ruleOn = rule !== undefined;
  const isCrossDomain = source !== undefined && source.domain !== page.key;
  const memoryKey = `mcp|${page.key}|${sourceId}`;

  /// 能当目标的：本域位置里除了来源自己
  const pickableTargets = domainTargets.filter((t) => t.id !== sourceId).map((t) => t.id);
  const ruleTargetIds = (rule?.targets ?? [])
    .map((target) => target.id)
    .filter((id) => pickableTargets.includes(id));

  // 目标键的初值：单格入口点名的位置 > 规则的目标 > 这个来源上次用的 > 前两个。
  // 用字符串做依赖，内容没变的重扫不会覆盖用户当场的点选
  const initKey = `${sourceId}|${ruleTargetIds.join(",")}|${pickableTargets.join(",")}|${(initialTargetIds ?? []).join(",")}`;
  useEffect(() => {
    const named = (initialTargetIds ?? []).filter((id) => pickableTargets.includes(id));
    setTargetIds(
      named.length > 0
        ? named
        : ruleTargetIds.length > 0
          ? ruleTargetIds
          : defaultTargets(pickableTargets, loadImportMemory(memoryKey)?.last),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);

  const targetIdSet = useMemo(() => new Set(targetIds), [targetIds]);
  const sourceEntries = useMemo(
    () => overview.entries.filter((entry) => entry.sourceId === sourceId),
    [overview.entries, sourceId],
  );
  /// 「未添加」按本域其余全部位置算（不是只按当场勾上的）：否则取消几个目标，列表就把项
  /// 收进「已添加」、甚至整页变成「都已添加」而没有底部块去重新勾上
  const otherTargetSet = useMemo(() => new Set(pickableTargets), [pickableTargets.join(",")]);
  const canPick = (entry: McpEntry) => canSupplement(entry, otherTargetSet);

  /// 已添加那一行展开没有；换来源时收起
  const [showAdded, setShowAdded] = useState(false);

  // 切换来源时清空勾选（添加是一次性动作，不预填）
  useEffect(() => {
    setNames([]);
    setShowAdded(false);
  }, [sourceId]);

  // 选中的来源消失（项目被移除）时回落到第一个
  useEffect(() => {
    if (overview.locations.some((location) => location.id === sourceId)) return;
    setSourceId(sources[0]?.id ?? "");
  }, [overview.locations, sources, sourceId]);

  // 勾选的服务在目标变了之后可能不再可写，顺手摘掉
  useEffect(() => {
    setNames((previous) =>
      previous.filter((name) =>
        sourceEntries.some((entry) => entry.name === name && canSupplement(entry, otherTargetSet)),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherTargetSet, sourceId]);

  /// 改规则：`set_mcp_auto_import` 在来源读不出来时拒绝，原话交给壳
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

  const toggleRule = (next: boolean) => {
    if (source === undefined) return;
    void run(() =>
      next
        ? api.setMcpAutoImport(source.id, page.key, targetIds, isCrossDomain)
        : api.removeMcpAutoImport(source.id, page.key),
    );
  };

  /// 勾选目标；规则开着时同时改写规则的目标（全取消 = 撤掉规则）
  const toggleTarget = (id: string) => {
    const next = targetIds.includes(id)
      ? targetIds.filter((target) => target !== id)
      : [...targetIds, id];
    setTargetIds(next);
    if (!ruleOn || source === undefined) return;
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

  const doAdd = async () => {
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
      const preview = await api.proposeMcpSync(selections);
      const memory = loadImportMemory(memoryKey);
      saveImportMemory(memoryKey, {
        last: targetIds,
        streak: memory && sameSet(memory.last, targetIds) ? memory.streak + 1 : 1,
      });
      onPreview(preview);
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
    added: importedInDomain(entry, page),
    unsupported: entry.transport === "unsupported" || entry.reason !== null,
  }));
  const pickable = entries.filter((e) => e.pickable && !e.unsupported);
  /// 列表只列未添加的（搬不过去的也留在列表里，说明它为什么选不了）；已添加的收进最后一行
  const listed = entries.filter((e) => e.pickable || e.unsupported);
  const added = entries.filter((e) => !e.pickable && !e.unsupported);
  const allDone = listed.length === 0 && entries.length > 0;
  /// 全选三态照实算（与 skill 页同一份逻辑）。MCP 没有同名替换：同名已有的格子本来就不写
  const pickableNames = pickable.map((e) => e.name);
  const allState = selectAllState(pickableNames, names);

  /// 每个来源位置右侧那个数：现在能往勾上的位置里补几个
  const countOf = (location: McpLocation) =>
    overview.entries.filter(
      (entry) => entry.sourceId === location.id && canSupplement(entry, targetIdSet),
    ).length;

  const chosen = names.length;
  const blocked = busy
    ? "正在处理，等这一下"
    : targetIds.length === 0
      ? "先勾上至少一个位置"
      : chosen === 0
        ? "先在列表里勾上要添加的服务"
        : null;

  const memory = loadImportMemory(memoryKey);
  const suggestRule =
    !ruleOn &&
    memory !== null &&
    memory.streak >= 2 &&
    targetIds.length > 0 &&
    sameSet(memory.last, targetIds);

  /// 列表最后一行：已添加 N 个 ▸，展开是「名字 + 传输」的灰行（不是可选项）
  const addedFold = (
    <AddedFold
      count={added.length}
      open={showAdded}
      onToggle={() => setShowAdded(!showAdded)}
      layout="rows"
    >
      {added.map((item) => (
        <div key={entryKey(item.entry)} className="ss-import__row ss-mcp__row is-added">
          <span className="ss-import__name">{item.name}</span>
          <span className="ss-mcp__transport">{item.transport}</span>
          <span className="ss-mcp__state" />
        </div>
      ))}
    </AddedFold>
  );

  return (
    <SubPage title={<>添加 MCP 到「{page.label}」</>} onBack={onClose}>
      <div className="ss-import ss-import--mcp">
        <div className="ss-import__cols">
          <Busy busy={busy} className="ss-import__sources">
            <div className="ss-import__caption">
              <span>来源</span>
              <span>未添加</span>
            </div>
            <div className="ss-import__srclist">
              {sources.length === 0 ? (
                <div className="ss-import__srcempty">
                  没找到能当来源的 MCP 配置文件。Claude Code、Codex、Cursor
                  的配置里有服务定义时才会出现在这儿。
                </div>
              ) : null}
              {sortedSources.map((location) => {
                const count = countOf(location);
                const seg = distinct.get(location.id);
                // 开了自动添加规则的位置：名字后小字「自动」，提示框补充目标
                const autoRule = autoImports.find(
                  (r) => r.source.id === location.id && r.targetDomain === page.key,
                );
                const autoTo = (autoRule?.targets ?? []).map(
                  (t) => domainTargets.find((d) => d.id === t.id)?.label ?? t.id,
                );
                return (
                  <div
                    key={location.id}
                    data-rowtip
                    className={
                      location.id === sourceId ? "ss-import__source is-active" : "ss-import__source"
                    }
                  >
                    {/* 完整路径进提示框（不用原生 title） */}
                    <RowTip
                      focusable={false}
                      content={
                        <>
                          {autoTo.length > 0 ? (
                            <span className="ss-import__tipline">
                              以后新出现的会自动写进 {autoTo.join(" · ")}
                            </span>
                          ) : null}
                          <span className="ss-import__path">{displayPath(location.path)}</span>
                        </>
                      }
                    >
                      <button
                        type="button"
                        className="ss-import__pick"
                        aria-current={location.id === sourceId}
                        onClick={() => setSourceId(location.id)}
                      >
                        <span className="ss-import__srctext">
                          <span className="ss-import__srcname">
                            {location.label}
                            {autoTo.length > 0 ? (
                              <span className="ss-import__auto">自动</span>
                            ) : null}
                          </span>
                          <span className="ss-import__srcscope">
                            {seg
                              ? `${mcpDomainLabel(location.domain)} · ${seg}`
                              : mcpDomainLabel(location.domain)}
                          </span>
                        </span>
                        <span
                          className={`ss-import__count${count === 0 ? " is-zero" : ""}`}
                          title="现在能往勾上的位置里补几个"
                        >
                          {count}
                        </span>
                      </button>
                    </RowTip>
                  </div>
                );
              })}
            </div>
          </Busy>

          <div className="ss-import__main">
            {source !== undefined && allDone ? (
              // 都已添加：右栏只写一句 + 已添加那一行，不显示底部块
              <div className="ss-import__alldone">
                <div className="ss-import__alldone-text">{source.label} 里的都已添加</div>
                {addedFold}
              </div>
            ) : source !== undefined ? (
              <>
                <div className="ss-import__listhead ss-mcp__listhead">
                  <span className="ss-import__headline">
                    {source.label} · <span className="ss-import__num">{sourceEntries.length}</span>
                  </span>
                  {pickable.length > 0 ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={allState}
                      className="ss-import__all"
                      onClick={() => setNames(toggleAll(pickableNames, names))}
                    >
                      <CheckMark on={allState} />
                      全选
                    </button>
                  ) : null}
                  <span className="ss-mcp__transporthead">传输</span>
                </div>

                <Busy busy={busy} className="ss-import__grid ss-mcp__list">
                  {listed.map((item) => {
                    // 搬不过去的不是可选项：不画复选框、不给悬停反馈
                    if (item.unsupported) {
                      return (
                        <div
                          key={entryKey(item.entry)}
                          className="ss-import__row ss-mcp__row is-added"
                          data-rowtip
                        >
                          <span className="ss-import__nobox" aria-hidden="true" />
                          <span className="ss-import__name">{item.name}</span>
                          <span className="ss-mcp__transport">{item.transport}</span>
                          <span className="ss-mcp__state">
                            <RowTip
                              side="before"
                              content={`${item.name} 用了只有 ${source.label} 认得的写法，搬到别处就不是原来那个了`}
                            >
                              <span className="ss-tag ss-tag--strong has-tip">搬不过去</span>
                            </RowTip>
                          </span>
                        </div>
                      );
                    }
                    const on = names.includes(item.name);
                    return (
                      <button
                        key={entryKey(item.entry)}
                        type="button"
                        className="ss-import__row ss-mcp__row"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleName(item.name)}
                      >
                        <CheckMark on={on} />
                        <span className="ss-import__name">{item.name}</span>
                        <span className="ss-mcp__transport">{item.transport}</span>
                        <span className="ss-mcp__state" />
                      </button>
                    );
                  })}
                  {addedFold}
                </Busy>
              </>
            ) : null}
          </div>
        </div>

        {source !== undefined && allDone ? null : (
          <Busy busy={busy} className="ss-import__foot">
            <div className="ss-import__keys">
              {domainTargets.length === 0 ? (
                <span className="ss-import__hint">
                  这个位置下还没有任何 MCP 配置文件，添加第一个服务时会建出来
                </span>
              ) : (
                domainTargets.map((target) => (
                  <TargetCheck
                    key={target.id}
                    harnessId={target.harnessId}
                    name={targetLabel(target)}
                    on={targetIds.includes(target.id)}
                    onToggle={() => toggleTarget(target.id)}
                    disabledReason={target.id === sourceId ? "这就是来源" : undefined}
                  />
                ))
              )}
            </div>
            <span className="ss-import__rule" title="只管以后新出现的，现有的不变">
              <Switch
                size="inline"
                checked={ruleOn}
                onChange={toggleRule}
                label="此来源以后新出现的 MCP 自动添加"
                title={
                  source
                    ? `${source.label} 以后新出现的 MCP 自动添加到勾上的位置${isCrossDomain ? "；跨域会把请求头和令牌一并复制过去" : ""}`
                    : undefined
                }
                disabledReason={ruleOn || targetIds.length > 0 ? undefined : "先勾上至少一个位置"}
              />
              <span className="ss-import__rulelabel">此来源以后新出现的 MCP 自动添加</span>
              {suggestRule ? (
                <span className="ss-import__suggest">每次都选这几个？可以打开</span>
              ) : null}
            </span>
            <span className="ss-mcp__safety">只新增，不覆盖同名配置</span>
            {blocked ? (
              <Button size="row" variant="primary" disabled disabledReason={blocked}>
                {addLabel(chosen, 0)}
              </Button>
            ) : (
              <Button size="row" variant="primary" onClick={() => void doAdd()}>
                {addLabel(chosen, 0)}
              </Button>
            )}
          </Busy>
        )}
      </div>
    </SubPage>
  );
}

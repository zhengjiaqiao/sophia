/// `发现` 一面的列表（spec 2026-09-27-skill-mcp-market R5 R7 R16；DESIGN「发现与安装 › `发现` 的页面头与列表」）。
/// 页面头（搜索框、`粘贴链接` / `粘贴 JSON`）归 `DiscoverFrame`（LocationFrame.tsx），这里拿到搜索词、画列表：
/// - skill：表头 `热门 N` / `搜索结果 N`；一行 名字 · 仓库（等宽）· 装过的人（右对齐）· `安装`
/// - MCP：表头 `精选 N`；搜索时下面多一节 `官方目录 N`；一行 名字 + 发布方 · 一句说明 · 要填什么 · `安装`
/// - 装过的：`安装` 换成状态 `✓ 已安装`（平贴、按不下，发现里不装第二份）
/// - 点整行（`安装` 键之外）、或行上按回车，推入介绍页（`IntroPage`）；行上没有拉手、没有抽屉
/// - 输入停 300ms 才查；空词回到热门 / 精选。连不上时列表上方灰面板说一句（`fallbackText`）
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { api } from "../api";
import { t, tn } from "../i18n";
import type { McpRow, SkillRow } from "../types";
import {
  BusySlot,
  Button,
  IconButton,
  IconRefresh,
  RefreshSpin,
  Mono,
  Note,
  NoticePanel,
  Tag,
  TruncTip,
  useBusyShown,
} from "../ui";
import {
  fallbackText,
  formatInstalls,
  isInstalled,
  mcpKey,
  mcpNeeds,
  popularText,
  skillHeader,
  skillKey,
  skillQuery,
  sortSkills,
} from "./discoverView";
import { InstalledMark } from "./InstalledMark";
import { IntroPage } from "./IntroPage";
import { createMcpLoader, type McpLoadState } from "./mcpRefresh";
import { createSkillLoader, POPULAR_CHECK_MS, type SkillLoadState } from "./popularRefresh";
import "./DiscoverPane.css";
import { copyDetails } from "../diagnostics.ts";

/// 输入停多久才查（R5）
export const SEARCH_DELAY_MS = 300;

/// `安装` 是在哪按的：列表行尾，还是介绍页的页面头（安装页叠在介绍页上，两层推入）
export type InstallFrom = "list" | "intro";

/// 两种列表共有的：重取、介绍页之上叠没叠着别的页
interface DiscoverShared {
  /// 页面头搜索框里此刻的词
  query: string;
  /// 变了就重取一次（装上、撤销之后：`✓ 已安装` 跟着变）；列表照旧显示，不闪忙碌
  reloadKey?: number;
  /// 介绍页上叠着安装页：Esc 归上面那一层
  covered?: boolean;
  /// 变了介绍页就滑回（装完两层一起滑回列表）
  introLeave?: number;
}

export type DiscoverPaneProps =
  | (DiscoverShared & {
      domain: "skills";
      /// 列表与介绍页的 `安装`：推入安装页
      onInstall?: (item: SkillRow, from: InstallFrom) => void;
    })
  | (DiscoverShared & {
      domain: "mcp";
      onInstall?: (item: McpRow, from: InstallFrom) => void;
    });

export function DiscoverPane(props: DiscoverPaneProps) {
  return props.domain === "skills" ? <SkillDiscover {...props} /> : <McpDiscover {...props} />;
}

/// 精选不等待官方目录；缓存先展示，过期后后台更新。
function useMcpList(query: string, reloadKey: number) {
  const [state, setState] = useState<McpLoadState>({
    query: "",
    data: null,
    error: null,
    loading: false,
    refreshing: false,
    curatedLoading: true,
  });
  useEffect(() => {
    const loader = createMcpLoader(
      api.marketMcpCurated,
      (q) => api.marketSearchMcp(q, true),
      (q) => api.marketSearchMcp(q),
      setState,
    );
    loader.load(query.trim());
    return () => loader.dispose();
  }, [query, reloadKey]);
  return state;
}

/// 热门先读本地缓存再更新；搜索与页面离开都会使晚到结果失效。
function useSkillList(query: string, reloadKey: number) {
  const [state, setState] = useState<SkillLoadState>({
    query,
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  });
  const loader = useRef<ReturnType<typeof createSkillLoader> | null>(null);
  const liveState = useRef(state);
  liveState.current = state;
  useEffect(() => {
    // 每轮 effect 有独立生命周期，兼容 StrictMode 的挂载检查。
    const current = createSkillLoader(
      (refresh = false, force = false) => api.marketPopular({ refresh, force }),
      api.marketSearchSkills,
      setState,
      liveState.current,
    );
    loader.current = current;
    const timer = query === "" ? null : setTimeout(() => current.load(query), SEARCH_DELAY_MS);
    if (query === "") current.load("");
    const interval = query === "" ? setInterval(() => current.refresh(), POPULAR_CHECK_MS) : null;
    return () => {
      if (timer !== null) clearTimeout(timer);
      if (interval !== null) clearInterval(interval);
      current.dispose();
      if (loader.current === current) loader.current = null;
    };
  }, [query, reloadKey]);
  return { ...state, refresh: () => loader.current?.refresh(true) };
}

/// 行上的键盘：回车 / 空格推入介绍页；上下键在行间移动
function rowKeys(open: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      event.currentTarget.closest(".dsc")?.querySelectorAll<HTMLElement>(".dsc-row") ?? [],
    );
    const at = rows.indexOf(event.currentTarget);
    const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
}

/// 行尾的 `安装` / `✓ 已安装`：点它不推入介绍页（已安装按了没反应）
function RowAction({ installed, onInstall }: { installed: boolean; onInstall?: () => void }) {
  const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();
  return (
    <span className="dsc-row__action" onClick={stop} onKeyDown={stop}>
      {installed ? (
        <InstalledMark />
      ) : (
        <Button size="compact" onClick={onInstall}>
          {t("market.action.install")}
        </Button>
      )}
    </span>
  );
}

/// 表头：`热门 200` 这类区块名 + 计数，后面几列的列名
function ListHead({
  label,
  count,
  columns,
}: {
  label: string;
  count: number;
  columns?: ReactNode;
}) {
  return (
    <div className="dsc-head">
      <span className="dsc-head__name">
        {label} <span className="dsc-head__count">{count}</span>
      </span>
      {columns}
    </div>
  );
}

/// 列表上方：灰面板（连不上 / 读不懂 / 限流……）或整个取不到时的一句。有技术原文时主键之前一颗 `详情`
/// （点开是浮层，spec 2026-10-04-local-diagnostics R13）
function ListNotice({
  fallback,
  detail,
  error,
  retry,
}: {
  fallback: string | null;
  /// 降级的技术原文（后端已去隐私）
  detail?: string | null;
  error: string | null;
  /// 热门榜单没取到时灰面板上的 `再试一次`（默认键紧凑 24），按下原位 `正在刷新`
  retry?: { onClick: () => void; busy: boolean };
}) {
  const action = (message: string, technical?: string | null) => (
    <NoticePanel
      scope="section"
      message={message}
      technical={technical ?? undefined}
      onCopy={(text) => copyDetails(text)}
      action={retry ? { label: t("market.action.retry"), onClick: retry.onClick } : undefined}
      busy={retry?.busy ? t("market.busy.refreshing") : undefined}
    />
  );
  return (
    <>
      {fallback ? <div className="dsc-notice">{action(fallback, detail)}</div> : null}
      {error ? <div className="dsc-notice">{action(error)}</div> : null}
    </>
  );
}

/// 介绍页的开合：记住是哪一行（按身份），列表刷新后找回同一条；找不到用推入时那一份
function useIntro<T>(rows: ReadonlyArray<T>, keyOf: (row: T) => string) {
  const [open, setOpen] = useState<{ key: string; row: T } | null>(null);
  const current = open ? (rows.find((row) => keyOf(row) === open.key) ?? open.row) : null;
  return {
    row: current,
    show: (row: T) => setOpen({ key: keyOf(row), row }),
    close: () => setOpen(null),
  };
}

// ── skill ──

function SkillDiscover({
  query,
  onInstall,
  reloadKey = 0,
  covered = false,
  introLeave = 0,
}: DiscoverShared & { onInstall?: (item: SkillRow, from: InstallFrom) => void }) {
  // 不到 2 个字 skills.sh 不搜：当没输入，列热门
  const q = skillQuery(query);
  const list = useSkillList(q, reloadKey);
  const rows = list.data ? sortSkills(list.data.items) : [];
  const intro = useIntro(rows, skillKey);
  const header = skillHeader(list.query, rows.length);
  const fallback = list.data?.fallback ? fallbackText(list.data.fallback) : null;
  const popular = q === "" && list.query === "" && list.data !== null;
  // 没取到：灰面板已经说了来源与多久前，这一行不再重复，刷新改成面板上的 `再试一次`（① 只说一次）
  const failed = fallback !== null || list.error !== null;
  const refreshShown = useBusyShown(list.refreshing);
  return (
    <div className="dsc">
      {popular && !failed ? (
        <div className="dsc-popular">
          <span className="dsc-popular__status">{popularText(list.data?.popular)}</span>
          {refreshShown ? (
            // 按下超过 0.3 秒：原位转圈（组件库 RefreshSpin，全应用唯一的转圈），跟着 ↻ 光学下移 1px
            <RefreshSpin label={t("market.busy.refreshing")} className="dsc-popular__glyph" />
          ) : (
            <IconButton
              icon={<IconRefresh size={12} className="dsc-popular__glyph" />}
              title={t("market.action.refresh")}
              onClick={list.refresh}
              disabledReason={
                list.loading
                  ? t("market.busy.readingPopular")
                  : list.refreshing
                    ? t("market.busy.refreshing")
                    : undefined
              }
            />
          )}
        </div>
      ) : null}
      <ListNotice
        fallback={fallback}
        detail={list.data?.fallback?.detail}
        error={list.error}
        retry={popular ? { onClick: list.refresh, busy: list.refreshing } : undefined}
      />
      {list.data === null && list.error === null ? (
        <BusySlot
          busy
          label={q === "" ? t("market.busy.readingPopular") : t("market.busy.searching")}
        >
          <span />
        </BusySlot>
      ) : null}
      {list.data ? (
        <div className="dsc-table dsc-table--skills">
          <ListHead
            label={header.label}
            count={header.count}
            columns={
              <>
                <span>{t("market.discover.colRepo")}</span>
                <span className="dsc-head__num">{t("market.discover.colInstalls")}</span>
                <span />
              </>
            }
          />
          {rows.length === 0 ? (
            <div className="dsc-empty">
              <Note>{t("market.discover.noSkill", { query: list.query })}</Note>
            </div>
          ) : (
            <div role="list" aria-label={`${header.label} ${header.count}`}>
              {rows.map((row) => {
                const open = () => intro.show(row);
                return (
                  <div
                    key={skillKey(row)}
                    role="listitem"
                    tabIndex={0}
                    className="dsc-row"
                    aria-label={t("market.row.skillLabel", { name: row.name, repo: row.repo })}
                    onClick={open}
                    onKeyDown={rowKeys(open)}
                  >
                    <span className="dsc-row__name">{row.name}</span>
                    <span className="dsc-row__repo">
                      <Mono inherit truncate>
                        {row.repo}
                      </Mono>
                    </span>
                    <span className="dsc-row__num">{formatInstalls(row.installs)}</span>
                    <RowAction
                      installed={isInstalled(row)}
                      onInstall={onInstall ? () => onInstall(row, "list") : undefined}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {intro.row ? (
        <IntroPage
          kind="skill"
          item={intro.row}
          onClose={intro.close}
          onInstall={onInstall ? (item) => onInstall(item, "intro") : undefined}
          escape={!covered}
          leaveSignal={introLeave}
        />
      ) : null}
    </div>
  );
}

// ── MCP ──

function McpRows({
  rows,
  label,
  onOpen,
  onInstall,
}: {
  rows: ReadonlyArray<McpRow>;
  label: string;
  onOpen: (row: McpRow) => void;
  onInstall?: (item: McpRow, from: InstallFrom) => void;
}) {
  return (
    <div role="list" aria-label={label}>
      {rows.map((row) => {
        const open = () => onOpen(row);
        const needs = mcpNeeds(row);
        return (
          <div
            key={mcpKey(row)}
            role="listitem"
            tabIndex={0}
            className="dsc-row"
            aria-label={t("market.row.mcpLabel", { name: row.name, publisher: row.publisher })}
            onClick={open}
            onKeyDown={rowKeys(open)}
          >
            <span className="dsc-row__who">
              <span className="dsc-row__name">{row.name}</span>
              <span className="dsc-row__publisher">{row.publisher}</span>
            </span>
            {/* 放不下截断时悬停出全文（不写原生 title：悬停弹系统灰框） */}
            <TruncTip content={row.description} fit="grow">
              <span className="dsc-row__desc">{row.description}</span>
            </TruncTip>
            <span className="dsc-row__needs">{needs ? <Tag tone="weak">{needs}</Tag> : null}</span>
            <RowAction
              installed={isInstalled(row)}
              onInstall={onInstall ? () => onInstall(row, "list") : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function McpDiscover({
  query,
  onInstall,
  reloadKey = 0,
  covered = false,
  introLeave = 0,
}: DiscoverShared & { onInstall?: (item: McpRow, from: InstallFrom) => void }) {
  const list = useMcpList(query, reloadKey);
  const curated = list.data?.curated ?? [];
  const registry = list.data?.registry ?? [];
  const intro = useIntro([...curated, ...registry], mcpKey);
  const searching = list.query !== "";
  const fallback = list.data?.fallback ? fallbackText(list.data.fallback) : null;
  const waiting = list.loading || list.refreshing || list.curatedLoading;
  const nothing =
    searching &&
    !waiting &&
    !fallback &&
    !list.error &&
    curated.length === 0 &&
    registry.length === 0;
  return (
    <div className="dsc">
      <ListNotice fallback={fallback} detail={list.data?.fallback?.detail} error={list.error} />
      {list.curatedLoading && curated.length === 0 ? (
        <BusySlot busy label={t("market.busy.readingCurated")}>
          <span />
        </BusySlot>
      ) : null}
      {list.data && nothing ? (
        <div className="dsc-table dsc-table--mcp">
          <ListHead label={t("market.header.results")} count={0} />
          <div className="dsc-empty">
            <Note>{t("market.discover.noMcp", { query: list.query })}</Note>
          </div>
        </div>
      ) : null}
      {list.data && !nothing && (!searching || curated.length > 0) ? (
        <div className="dsc-table dsc-table--mcp">
          <ListHead label={t("market.header.curated")} count={curated.length} />
          <McpRows
            rows={curated}
            label={tn("market.list.curatedLabel", curated.length)}
            onOpen={intro.show}
            onInstall={onInstall}
          />
        </div>
      ) : null}
      {list.data && !nothing && searching ? (
        <div className="dsc-table dsc-table--mcp dsc-section">
          <ListHead label={t("market.header.registry")} count={registry.length} />
          {/* 有缓存时后台更新不显示忙碌（DESIGN-components「后台例行读取不显示任何忙碌」）；
              没有缓存时用户在等这一节的结果，才说正在搜索 */}
          {(list.loading || list.refreshing) && registry.length === 0 ? (
            <BusySlot busy label={t("market.busy.searchingRegistry")}>
              <span />
            </BusySlot>
          ) : null}
          {registry.length === 0 ? (
            !waiting && !fallback && !list.error ? (
              <div className="dsc-empty">
                <Note>{t("market.discover.noRegistry", { query: list.query })}</Note>
              </div>
            ) : null
          ) : (
            <McpRows
              rows={registry}
              label={tn("market.list.registryLabel", registry.length)}
              onOpen={intro.show}
              onInstall={onInstall}
            />
          )}
        </div>
      ) : null}
      {intro.row ? (
        <IntroPage
          kind="mcp"
          item={intro.row}
          onClose={intro.close}
          onInstall={onInstall ? (item) => onInstall(item, "intro") : undefined}
          escape={!covered}
          leaveSignal={introLeave}
        />
      ) : null}
    </div>
  );
}

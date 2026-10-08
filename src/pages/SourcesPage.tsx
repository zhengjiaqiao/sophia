import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import { logError } from "../diagnostics.ts";
import { t } from "../i18n.ts";
import { sourceNoun } from "../terms.ts";
import {
  AddButton,
  Empty,
  PushedPage,
  motionMs,
  useBusyShown,
  usePushedPage,
} from "../ui/index.ts";
import { useMenuFlag, usePageCommand } from "../shell/menuBus.ts";
import { locationsOf, type Location } from "../shell/nav.ts";
import { FilterRow } from "../FilterRow.tsx";
import type { InstallPlaces } from "../market/InstallParts.tsx";
import { SourceLine, ruleText, useSources } from "../SourceRow.tsx";
import { addButtonLabel, readingText } from "./addSourceView.ts";
import { mcpSourcesTitle, sourcesTitle, type DomainRef } from "./sourcesView.ts";
import type { SourceRow, SourcesModel } from "./sourcesModel.ts";
import "./SourcesPage.css";

/// 来源管理页（DESIGN「位置页 › 来源管理页（按下 `管理来源` 时）」；2026-09-30 起位置在页里选，设计稿
/// https://claude.ai/code/artifact/90bed4f4-426c-4964-8c99-8eb1fcead9e7）：推入页 `PushedPage`，**骨架与添加来源页
/// 相同**——只替换机面，侧栏留着；在机面里从右推入，`←` / Esc / 菜单「返回」滑回（200ms，reduced-motion 即时）。
/// 位置页在它下面 `inert`、不卸载，回来时筛选、滚动、抽屉照旧。
///
/// ```
/// ←  所有位置的来源                                                        [+ 来源]
/// 位置 [全部] [用户级] [CardBox] [weibo_assistant] [更多 ▾]
/// 位置      来源               skill 数                以后新出现的自动加到
/// ──────────────────────────────────────────────────────────────────────── hairline
/// 用户级    通用仓库                 26               [开关] [✳ ⎔ ▾]      ×
/// CardBox   WeiboAP · 1776…          39               [开关] [选目标 ▾]    ×
/// ```
///
/// - 页面头：`←` + 10 + 页名（跟着胶囊：`所有位置的来源` / `用户级的来源` / `CardBox 的来源`；MCP 一律叫 `自动同步`），
///   右端 `+ 来源`（交给调用方：关掉这一页、打开添加来源页，位置默认取这一页的胶囊；MCP 不给，不再添加来源）
/// - 页面头下一行位置胶囊，就是表格页的 `FilterRow`（含 `全部`，右端没有 `来源` 下拉），默认取表格当前的位置；
///   **在这一页换位置不改表格的位置**
/// - 列：`位置`（一直在，只看一个位置时也在）｜ `来源`（悬停出完整路径与 `打开 ↗`，同表格页的来源格）｜
///   `skill 数`（MCP：`服务数`）｜ 规则（开关 + 目标框，规则句只在列头说一次）｜ `×`。同一个来源订在两个位置就是两行
/// - 每个位置各读各的（`useSources` 一个位置一份，`PlaceSources`），移除确认与结果小窗由那个位置画；
///   移除后这一行收起（200ms），其余的跟着平移，不跳位
/// - 一个来源都没有：空态「还没有来源」/「CardBox 还没有来源」+ 猫（`+ 来源` 已在页面头，空态不重复）
/// - 读屏：`role=region`、名同标题；返回键 `aria-label=返回`。Esc：浮层（捕获阶段）与移除确认先接，其次返回

/// 页名、空态、数那一列与规则那一列的列头：只看一个位置时用那个位置的模型（`CardBox 的来源`），
/// 不止一个时说「所有位置」（`所有位置的来源` / `所有位置的 MCP 来源`，空态 `还没有来源`）
export function sourcesPageText(
  domain: "skills" | "mcp",
  single: Pick<SourcesModel, "title" | "emptyText"> | null,
  any: Pick<SourcesModel, "noun">,
): { title: string; emptyText: string; countHead: string; ruleHead: string } {
  const whole: DomainRef = { key: "all", label: t("sources.page.allPlaces") };
  return {
    title: single?.title ?? (domain === "mcp" ? mcpSourcesTitle(whole) : sourcesTitle(whole)),
    emptyText:
      single?.emptyText ??
      (domain === "mcp" ? t("sources.page.emptyAllMcp") : t("sources.page.emptyAll")),
    countHead: domain === "mcp" ? t("sources.page.countMcp") : t("sources.page.countSkill"),
    ruleHead: ruleText(any),
  };
}

export interface SourcesPageProps {
  domain: "skills" | "mcp";
  /// 位置胶囊用的项目（同安装页）
  places: InstallPlaces;
  /// 进来时表格的位置：胶囊默认选它
  initial: Location;
  /// 域 key → `位置` 列里写的名字
  placeName: (key: string) => string;
  /// 域 key → 那个位置的来源模型（调用方按 key 缓存，同一个位置每次给同一个对象）
  modelOf: (key: string) => SourcesModel;
  /// 位置页每次重扫都给一个新值：各位置重读
  version: unknown;
  /// 改了规则 / 移除之后：位置页重扫
  onChange: () => Promise<void>;
  /// 滑回播完：调用方卸掉这一页
  onClose(): void;
  /// 页面头的 `+ 来源`：调用方关掉这一页、打开添加来源页（位置默认取 `at`，`全部` 时用户级）。
  /// 不给就没有这颗键（MCP 不再添加来源，spec 2026-09-30-mcp-config-scope R5）
  onAdd?(at: Location): void;
  /// 从添加来源页回到这一页时刚加进来的来源：那个位置的那几行闪一下
  flash?: { key: string; ids: readonly string[] } | null;
}

/// 一个位置报给页面的：读完了没有、有几行、移除确认开着没有
interface PlaceReport {
  count: number | null;
  confirming: boolean;
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function SourcesPage({
  domain,
  places,
  initial,
  placeName,
  modelOf,
  version,
  onChange,
  onClose,
  onAdd,
  flash,
}: SourcesPageProps) {
  const kind = domain === "mcp" ? "MCP" : "skill";
  const [location, setLocation] = useState<Location>(initial);
  const [listOpen, setListOpen] = useState(false);
  const keys = locationsOf(
    location,
    places.sorted.map((p) => p.key),
  );
  // 页名跟着胶囊：选在 `全部` 就说「所有位置」（哪怕此刻只有用户级一个位置）
  const single = location === "all" ? null : (keys[0] ?? null);
  const { title, emptyText, countHead, ruleHead } = sourcesPageText(
    domain,
    single === null ? null : modelOf(single),
    modelOf(keys[0] ?? "global"),
  );

  // 推入页外框（挂到机面、下层 inert、焦点进出、`←` / Esc 返回、推入滑回）归 `PushedPage`；
  // 菜单「返回」（⌘[）归页面：同一个 leave，只在这一页开着时亮
  const page = usePushedPage(onClose);
  usePageCommand("back", page.leave);
  useMenuFlag("back", !page.leaving);

  // 各位置读完了几行、有没有开着的移除确认：决定空态、读取中与 Esc 归谁
  const [reports, setReports] = useState<ReadonlyMap<string, PlaceReport>>(new Map());
  const report = useCallback((key: string, next: PlaceReport | null) => {
    setReports((prev) => {
      const was = prev.get(key);
      if (
        next === null
          ? was === undefined
          : was?.count === next.count && was.confirming === next.confirming
      )
        return prev;
      const m = new Map(prev);
      if (next === null) m.delete(key);
      else m.set(key, next);
      return m;
    });
  }, []);
  const shownReports = keys.map((k) => reports.get(k));
  const loading = shownReports.some((r) => r === undefined || r.count === null);
  const total = shownReports.reduce((n, r) => n + (r?.count ?? 0), 0);
  const confirming = shownReports.some((r) => r?.confirming);

  // 读取中：过了 0.3 秒门槛才出刻度 + 一句（更快读完的什么都不闪；没有文字的转动不允许）
  const loadingShown = useBusyShown(loading && total === 0);

  return (
    <PushedPage
      {...page}
      title={title}
      actions={
        onAdd ? (
          <AddButton
            noun={sourceNoun(domain)}
            label={addButtonLabel(kind)}
            onClick={() => onAdd(location)}
          />
        ) : undefined
      }
      host={() => document.querySelector(".face")}
      covers={() => document.querySelector(".face__scroll")}
      // 移除确认开着时 Esc 只取消确认，不返回
      escape={!confirming}
    >
      <div className="srcpage__places">
        <FilterRow
          recent={places.recent}
          sorted={places.sorted}
          location={location}
          onLocation={setLocation}
          sort={places.sort}
          onSort={places.onSort}
          listOpen={listOpen}
          listFocus={0}
          onListOpen={setListOpen}
        />
      </div>
      <div className="srcpage__body">
        {/* 各位置一直挂着（读数据），一行都没有时表头不画、换成空态 */}
        <div className="srcpage__table" role="table" aria-label={title} hidden={total === 0}>
          <div className="srcpage__head" role="row">
            <span className="srcpage__col srcpage__col--place" role="columnheader">
              {t("sources.page.colPlace")}
            </span>
            <span className="srcpage__col srcpage__col--name" role="columnheader">
              {sourceNoun(domain)}
            </span>
            <span className="srcpage__col srcpage__col--count" role="columnheader">
              {countHead}
            </span>
            <span className="srcpage__col srcpage__col--rule" role="columnheader">
              {ruleHead}
            </span>
          </div>
          {keys.map((key) => (
            <PlaceSources
              key={key}
              domainKey={key}
              place={placeName(key)}
              model={modelOf(key)}
              version={version}
              onChange={onChange}
              onReport={report}
              flashIds={flash?.key === key ? flash.ids : undefined}
            />
          ))}
        </div>
        {total > 0 ? null : loading ? (
          loadingShown ? (
            <Empty busy description={readingText(kind)} />
          ) : null
        ) : (
          <Empty description={emptyText} art="emptyFolder" />
        )}
      </div>
    </PushedPage>
  );
}

/// 一个位置的来源行：自己读数据（`useSources`），行直接排进页面的表格（subgrid），
/// 移除确认与结果小窗由它画到 body 上。读完的行数与确认开没开报给页面
function PlaceSources({
  domainKey,
  place,
  model,
  version,
  onChange,
  onReport,
  flashIds,
}: {
  domainKey: string;
  place: string;
  model: SourcesModel;
  version: unknown;
  onChange: () => Promise<void>;
  onReport: (key: string, report: PlaceReport | null) => void;
  flashIds?: readonly string[];
}) {
  const domain: DomainRef = { key: domainKey, label: place };
  const sources = useSources({
    model,
    domain,
    version,
    onChange,
    // R9 去掉了按来源筛选：移除来源之后不用再更新筛选状态
    onRemoved: () => undefined,
  });

  // 移除确认与结果小窗：这一页开着时由这一页画（位置页被盖着，而且 inert）
  const { claimHost } = sources;
  useEffect(() => claimHost(), [claimHost]);

  const count = sources.data === null ? null : sources.data.rows.length;
  useEffect(() => {
    onReport(domainKey, { count, confirming: sources.confirming });
  }, [onReport, domainKey, count, sources.confirming]);
  useEffect(() => () => onReport(domainKey, null), [onReport, domainKey]);

  // 刚从列表里消失的行（移除了）：在原处留一会儿、收起，下面的行跟着平移上来
  const rows = sources.data?.rows ?? [];
  const lastRows = useRef<SourceRow[]>(rows);
  const [ghosts, setGhosts] = useState<{ row: SourceRow; index: number }[]>([]);
  const ghostTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // 在绘制之前补上：不让那一行先空一帧再出现
  useLayoutEffect(() => {
    if (sources.data === null) return;
    const now = sources.data.rows;
    const gone = lastRows.current
      .map((row, index) => ({ row, index }))
      .filter((g) => !now.some((r) => r.id === g.row.id));
    lastRows.current = now;
    if (gone.length === 0 || reducedMotion()) return;
    setGhosts((prev) => [...prev, ...gone]);
    ghostTimers.current.push(
      // 收起播完再撤：时长与 SourceRow.css `srcline-leave` 同取 `--dur-collapse`
      setTimeout(
        () => setGhosts((prev) => prev.filter((g) => !gone.includes(g))),
        motionMs("--dur-collapse"),
      ),
    );
  }, [sources.data]);
  useEffect(() => () => ghostTimers.current.forEach(clearTimeout), []);

  const shown: { row: SourceRow; leaving: boolean }[] = rows.map((row) => ({
    row,
    leaving: false,
  }));
  for (const g of [...ghosts].sort((a, b) => a.index - b.index)) {
    if (shown.some((s) => s.row.id === g.row.id)) continue;
    shown.splice(Math.min(g.index, shown.length), 0, { row: g.row, leaving: true });
  }

  /// `打开 ↗`：在访达中显示；没打开在那颗键下说一声。提示条只写失败句，系统给的原文进日志（#320）
  const reveal = (path: string, key: Element) => {
    api.revealInDir(path).catch((e) => {
      void logError(`reveal-in-dir failed: ${String(e)}`);
      const r = key.getBoundingClientRect();
      sources.say(
        { tier: "notice", kind: "cannot", sentence: "sources.page.openCannot" },
        { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        "start",
      );
    });
  };

  // 确认框与结果小窗挂到 body 上：这一页推入时带着 transform，fixed 的遮罩放在它里面会跟着页面走
  const layers =
    sources.pageHost && typeof document !== "undefined"
      ? createPortal(sources.pageHost, document.body)
      : sources.pageHost;
  return (
    <>
      {shown.map(({ row, leaving: gone }) => (
        <SourceLine
          key={gone ? `gone:${row.id}` : row.id}
          state={sources}
          row={row}
          place={place}
          onReveal={reveal}
          leaving={gone}
          flash={!gone && (flashIds?.includes(row.id) ?? false)}
        />
      ))}
      {layers}
    </>
  );
}

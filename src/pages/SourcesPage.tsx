import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import { AddButton, Empty, IconArrowLeft, IconButton, Spinner } from "../ui/index.ts";
import { holdInert } from "../ui/PushedPage.tsx";
import { PageHead, PageTitle } from "../shell/PageHead.tsx";
import { useMenuFlag, usePageCommand } from "../shell/menuBus.ts";
import { SourceLine, ruleText, type SourcesState } from "../SourceRow.tsx";
import {
  mcpSourcesTitle,
  noMcpSourcesText,
  noSourcesText,
  sourcesTitle,
  type DomainRef,
} from "./sourcesView.ts";
import type { SourceRow } from "./sourcesModel.ts";
import "./AddSourcePage.css";
import "./SourcesPage.css";

/// 来源管理页（DESIGN「位置页 › 来源管理页（按下 `管理来源` 时）」，画板 03B）：二级页，**骨架与添加来源页
/// 相同**——只替换机面，侧栏留着、当前位置仍选中；在机面里从右推入，`←` / Esc / 菜单「返回」滑回
/// （200ms，reduced-motion 即时）。位置页在它下面 `inert`、不卸载，回来时筛选、滚动、抽屉照旧。
///
/// ```
/// ←  CardBox 的来源                                                       [+ 来源]
/// 来源            位置                                以后新出现的自动加到
/// ──────────────────────────────────────────────────────────────────────── hairline
/// 通用仓库  26   ~/.agents/skills            打开 ↗   [开关] [✳ ⎔ ▾]      ×
/// WeiboAP   27   ~/Library/…/WeiboAP/skills  打开 ↗   [开关] [选目标 ▾]    ×
/// ```
///
/// - 页面头：`←` + 10 + `CardBox 的来源`（MCP：`CardBox 的 MCP 来源`），右端 `+ 来源`（交给调用方：
///   关掉这一页、打开添加来源页）
/// - 每个来源一行＝来源行组件 `SourceLine`；各格对齐列头（subgrid）：名字列按最长的名字定宽、路径列按最长的
///   路径定宽、`打开 ↗` / 目标框 / 开关 / `×` 各成一列（`打开 ↗` 悬停这一行才出，列位置保留）。
///   规则句只在列头说一次
/// - 移除确认与结果小窗由 `useSources` 持有，这一页挂着时由它来画（位置页那一份让出来）；
///   移除后这一行收起（200ms），其余的跟着平移，不跳位
/// - 一个来源都没有：空态「CardBox 还没有来源」+ 猫（`+ 来源` 已在页面头，空态不重复）
/// - 读屏：`role=region`、名同标题；返回键 `aria-label=返回`。Esc：浮层（捕获阶段）与移除确认先接，其次返回

/// 转场时长，与 AddSourcePage.css 同值
const MOTION_MS = 200;
/// 刚移除的那一行收起的时长，与 SourceRow.css `srcline-leave` 同值
const LEAVE_MS = 200;

export interface SourcesPageProps {
  /// 位置页的 `useSources`：数据、规则、移除都在它那里
  sources: SourcesState;
  domain: "skills" | "mcp";
  /// 位置的显示名：`全局` / `CardBox`
  placeName: string;
  /// 滑回播完：调用方卸掉这一页
  onClose(): void;
  /// 页面头的 `+ 来源`：调用方关掉这一页、打开添加来源页
  onAdd(): void;
  /// 从添加来源页回到这一页时刚加进来的来源 id：那几行闪一下
  flashIds?: readonly string[];
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function SourcesPage({
  sources,
  domain,
  placeName,
  onClose,
  onAdd,
  flashIds,
}: SourcesPageProps) {
  const place: DomainRef = { key: sources.domain.key, label: placeName };
  const title = domain === "mcp" ? mcpSourcesTitle(place) : sourcesTitle(place);
  const emptyText = domain === "mcp" ? noMcpSourcesText(place) : noSourcesText(place);

  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // 挂到机面上（盖住位置页，侧栏不动）；没有机面（测试、预览）时就地画
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHost(document.querySelector<HTMLElement>(".face")), []);

  // 位置页在这一页下面：读屏与 Tab 都进不去；滑回卸掉时放开。
  // 焦点：打开时落到这一页上，返回时还给进来之前拿着焦点的那颗键（`管理来源`）
  useEffect(() => {
    const under = document.querySelector<HTMLElement>(".face__scroll");
    const release = under ? holdInert(under) : undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pageRef.current?.focus({ preventScroll: true });
    return () => {
      release?.();
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [host]);

  // 移除确认与结果小窗：这一页开着时由这一页画（位置页被盖着，而且 inert）
  const { claimHost } = sources;
  useEffect(() => claimHost(), [claimHost]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    timer.current = setTimeout(onClose, reducedMotion() ? 0 : MOTION_MS);
  };
  const live = useRef(leave);
  live.current = leave;
  const confirming = useRef(sources.confirming);
  confirming.current = sources.confirming;

  // 返回：`←`、Esc、菜单「返回」（⌘[）是同一条路；菜单「返回」只在这一页开着时亮
  usePageCommand("back", () => live.current());
  useMenuFlag("back", !leaving);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 浮层在捕获阶段先接走自己的 Esc；移除确认开着时 Esc 只取消确认；输入框里的 Esc 归输入框
      if (event.key !== "Escape" || event.defaultPrevented || confirming.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      live.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
      setTimeout(() => setGhosts((prev) => prev.filter((g) => !gone.includes(g))), LEAVE_MS),
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

  /// `打开 ↗`：在访达中显示；没打开在那颗键下说一声
  const reveal = (path: string, key: Element) => {
    api.revealInDir(path).catch((e) => {
      const r = key.getBoundingClientRect();
      sources.say(
        { tier: "notice", kind: "cannot", verb: "没打开", reason: String(e) },
        { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        "start",
      );
    });
  };

  let body;
  if (sources.data === null) {
    body = (
      <div className="srcpage__loading">
        <Spinner label="正在读来源" />
      </div>
    );
  } else if (shown.length === 0) {
    body = <Empty kind="noSkills" description={emptyText} art="emptyFolder" />;
  } else {
    body = (
      <div className="srcpage__table" role="table" aria-label={title}>
        <div className="srcpage__head" role="row">
          <span className="srcpage__col srcpage__col--name" role="columnheader">
            来源
          </span>
          <span className="srcpage__col srcpage__col--where" role="columnheader">
            位置
          </span>
          <span className="srcpage__col srcpage__col--rule" role="columnheader">
            {ruleText(sources.model)}
          </span>
        </div>
        {shown.map(({ row, leaving: gone }) => (
          <SourceLine
            key={gone ? `gone:${row.id}` : row.id}
            state={sources}
            row={row}
            onReveal={reveal}
            leaving={gone}
            flash={!gone && (flashIds?.includes(row.id) ?? false)}
          />
        ))}
      </div>
    );
  }

  const page = (
    <div
      ref={pageRef}
      className={`add-src-page srcpage${leaving ? " is-leaving" : ""}`}
      role="region"
      aria-label={title}
      // 只供程序放焦点的落点（打开时焦点落在这一页上）
      tabIndex={-1}
    >
      <PageHead
        lead={
          <span className="add-src-page__lead">
            <IconButton icon={<IconArrowLeft />} title="返回" onClick={leave} />
            <PageTitle>{title}</PageTitle>
          </span>
        }
        actions={<AddButton noun="来源" onClick={onAdd} />}
      >
        <div className="srcpage__body">{body}</div>
      </PageHead>
    </div>
  );
  // 确认框与结果小窗挂到 body 上：这一页推入时带着 transform，fixed 的遮罩放在它里面会跟着页面走
  const layers =
    sources.pageHost && typeof document !== "undefined"
      ? createPortal(sources.pageHost, document.body)
      : sources.pageHost;
  return (
    <>
      {host ? createPortal(page, host) : page}
      {layers}
    </>
  );
}

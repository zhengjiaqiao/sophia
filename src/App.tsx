import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import type {
  AutoLink,
  GatewayState,
  McpOverview,
  McpReport,
  Overview,
  ProjectTimes,
} from "./types";
import SkillsTab from "./SkillsTab";
import McpTab from "./McpTab";
import { SettingsPage } from "./pages/SettingsPage";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { mcpDomains } from "./mcpView";
import { loadHome } from "./pathText";
import {
  loadProjectSort,
  projectName,
  saveProjectSort,
  sortProjects,
  unionProjects,
  type ProjectSort,
} from "./sidebarProjects";
import { NoticePanel, PageHead, Toast, ToastCount, ToastStack, useEdgeFades } from "./ui";
import { Sidebar, type SidebarItem } from "./shell/Sidebar";
import { AGENTS } from "./shell/agents";
import { ModelsPage } from "./shell/ModelsPage";
import { visibleAgents, type AgentState } from "./shell/agentRegistry";
import { DESTINATIONS, isScoped } from "./shell/destinations";
import {
  GLOBAL_KEY,
  goDestination,
  goLevel,
  goProject,
  loadNav,
  locationsOf,
  resolveNav,
  saveNav,
  type Destination,
  type Nav,
} from "./shell/nav";
import { isMenuCommand, menuState, routeMenuCommand } from "./shell/menuCommands";
import { dispatchPageCommand, useMenuFlags, usePageCommand } from "./shell/menuBus";
import { ProjectChips, ScopeTabs } from "./ScopeBar";
import { showsProjectChips } from "./scopeView";
import { changesPage, requestLeave } from "./shell/leaveGuard";
import { canPopup } from "./contextMenu";
import "./App.css";

/// 文件系统事件与窗口获得焦点后的重扫去抖
const REFRESH_DELAY = 300;

/// 焦点在不在能打字的框里：菜单的撤销 / 全选此时作用于文字
const isEditable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      el.type,
    )) ||
  (el instanceof HTMLElement && el.isContentEditable);

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  /// 用户发起的写入正在进行：后台重扫排到它结束之后。**不锁范围切换**——
  /// 忙碌只锁触发它的那个控件（DESIGN「反馈的两种形态 › 忙碌」），由各页自己管
  const [busy, setBusy] = useState(false);
  /// 你在哪（spec 2026-09-26-object-first-navigation R12）：目的地（侧栏选中项）与范围分开记。
  /// 首次 `SKILLS · 全部`，之后记住上次停在哪；升级时从旧落点换算一次
  const [nav, setNav] = useState<Nav>(loadNav);
  const [error, setError] = useState<string | null>(null);
  /// 应用菜单「关于 Sophia」「检查更新…」：设置页停在「关于」一节，`check` 时同时开始检查。
  /// `at` 让同一个请求再发一次也算新的
  const [aboutRequest, setAboutRequest] = useState<{ at: number; check: boolean } | null>(null);
  /// 启动时后台查一次新版。**必须静默失败**：`plugins.updater.pubkey` 没填之前
  /// check() 一定报错，进横幅的话每次开应用先看见一条错。null＝查过没有 / 没查成
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  /// 此刻显示哪张表（SKILLS / MCP）；在模型页、设置时为 null
  const activeTab: Destination | null = isScoped(nav.destination) ? nav.destination : null;
  /// 模型页只在后端确认支持（当前只有 macOS）时才有；null＝还没问出来。
  /// 读取失败时当作不支持，侧栏不列「模型」
  const [modelsSupported, setModelsSupported] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /// 「更多」项目列表的排序：选择记在本机，下次打开照旧
  const [projectSort, setProjectSort] = useState<ProjectSort>(loadProjectSort);
  /// 项目路径 → 两种时间；读不到时列表保持并集的次序
  const [projectTimes, setProjectTimes] = useState<ReadonlyMap<string, ProjectTimes>>(new Map());
  // 自动同步规则；扫描时顺带取回，域页与添加页都用它
  const [autoLinks, setAutoLinks] = useState<AutoLink[]>([]);
  const [backgroundMcpReport, setBackgroundMcpReport] = useState<McpReport | null>(null);
  /// MCP 扫描结果（项目列表要它）与模型状态（侧栏「模型」后的指示点要它）
  const [mcpOverview, setMcpOverview] = useState<McpOverview | null>(null);
  const [gatewayState, setGatewayState] = useState<GatewayState | null>(null);
  /// 内容区横向滚动的边缘渐隐：左 / 右还有被裁掉的内容时那一边出渐隐（量归 ui 的 useEdgeFades，画归壳 App.css）。
  /// 窗口变窄、表格长宽（换页签、扫描回来）都会改变能不能横向滚动：它在滚动、改尺寸、每次重绘后都重量
  const contentRef = useRef<HTMLElement>(null);
  const contentFade = useEdgeFades(contentRef, "x");
  /// 提示条的到点消失按回调身份计时：必须稳定，否则每次重渲染都重新计时
  const closeMcpToast = useCallback(() => setBackgroundMcpReport(null), []);
  // 监听器只注册一次，用 ref 读当前状态，避免闭包读到旧值
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  /// 正在跑的那一轮后台重扫
  const scanningRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeTabRef = useRef(activeTab);
  const navRef = useRef(nav);
  busyRef.current = busy;
  activeTabRef.current = activeTab;
  navRef.current = nav;

  /// 用户换页的唯一入口（侧栏、范围滑槽、项目筛选片、⌘, ⌘1…、应用菜单、托盘跳转）：会换掉机面里这一页时先经
  /// 「离开前询问」（shell/leaveGuard.ts）——那一页有没保存的改动就由它就地问，问完才走；`then` 是
  /// 走到之后要做的事（停在「关于」、把命令交给新的页）。不换页的（只改记着的范围）当场走
  const navigate = useCallback((to: (n: Nav) => Nav, then?: () => void) => {
    const go = () => {
      setNav(to);
      then?.();
    };
    if (changesPage(navRef.current, to(navRef.current))) requestLeave(go);
    else go();
  }, []);

  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
    if (!next && pendingRef.current) {
      pendingRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!busyRef.current) void refreshRef.current();
      }, REFRESH_DELAY);
    }
  };

  /// 重扫：后台那一路，**只更新数据、不置 busy、不锁任何控件**（DESIGN「忙碌指示」「空态与忙碌态」）——
  /// 界面上没有忙碌提示却点不动，用户只会觉得坏了。锁控件只给用户发起、正在等的操作（setBusyState）。
  ///
  /// 项目列表是 skill 与 MCP 两边发现的并集，与当前在哪一页无关，所以 skill 每次都扫。
  /// MCP 停在 MCP 页时由 McpTab 扫完回传（onOverview），不重复扫；停在别的页签时这里扫一次，
  /// 缓存到下次聚焦 / 文件变化。扫描可能触发已授权的自动规则；界面以重新扫描的实际结果为准。
  ///
  /// 同一时间只跑一轮：扫描中又被叫到，记一个标记、等这一轮连同补扫一起结束再返回——
  /// 调用方 await 回来时拿到的是最新的
  const scanOnce = async () => {
    try {
      const [next, rules, mcp] = await Promise.all([
        api.scanAll(),
        api.listAutoLinks(),
        activeTabRef.current === "mcp" ? Promise.resolve(null) : api.scanMcp().catch(() => null),
      ]);
      setOverview(next);
      setAutoLinks(rules);
      if (mcp !== null) setMcpOverview(mcp);
      setRefreshKey((key) => key + 1);
    } catch (e) {
      setError(String(e));
    }
  };
  const refresh = async (): Promise<void> => {
    if (scanningRef.current) {
      pendingRef.current = true;
      return scanningRef.current;
    }
    const run = (async () => {
      do {
        pendingRef.current = false;
        await scanOnce();
      } while (pendingRef.current);
    })();
    scanningRef.current = run;
    try {
      await run;
    } finally {
      scanningRef.current = null;
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  /// 模型状态只为侧栏「模型」后的指示点：后台轻查，不显示忙碌
  const refreshGateway = useCallback(() => {
    void api.gatewayState().then(
      (state) => setGatewayState(state),
      () => undefined,
    );
  }, []);

  // 文件系统变化与窗口获得焦点都走这里：用户的操作进行中则排到它结束之后，否则去抖后重扫
  const requestRefresh = useCallback(() => {
    if (busyRef.current) {
      pendingRef.current = true;
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void refreshRef.current();
    }, REFRESH_DELAY);
  }, []);

  useEffect(() => {
    void checkUpdate().then(
      (found) => setPendingUpdate(found ?? null),
      () => setPendingUpdate(null),
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const collect = (pending: Promise<() => void>) => {
      void pending.then((un) => (disposed ? un() : unlistens.push(un)));
    };
    collect(listen("fs-changed", () => requestRefresh()));
    collect(
      listen<McpReport>("mcp-auto-imported", ({ payload }) => {
        // MCP 页有自己的结果；停留在别的页签时也不能丢掉自动添加的结果（⑬ 自动发生的事要交代）
        if (activeTabRef.current !== "mcp") setBackgroundMcpReport(payload);
      }),
    );
    // 菜单栏面板改了模型状态：模型类的问题跟着重认
    collect(listen("gateway-changed", () => refreshGateway()));
    // 菜单栏面板要求切页；它那边做不成的事也带到这里来说——面板放不下一段解释
    collect(
      listen<{ page: "models" | "settings" | null; error: string | null }>(
        "tray-navigate",
        ({ payload }) => {
          if (payload.page === "settings") navigate((n) => goDestination(n, "settings"));
          if (payload.page === "models") navigate((n) => goDestination(n, "models"));
          if (payload.error) setError(payload.error);
        },
      ),
    );
    // 兜底：在 Finder 里改了不在监视集合内的东西，切回窗口时也能发现
    collect(
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        requestRefresh();
        refreshGateway();
      }),
    );
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [requestRefresh, refreshGateway, navigate]);

  /// 模型页在非 macOS 上并不存在：一问出「不支持」，记着停在模型页的落点由 resolveNav 退回 SKILLS
  const applyModelsSupported = (supported: boolean) => setModelsSupported(supported);

  useEffect(() => {
    let cancelled = false;
    void api
      .gatewayState()
      .then((state) => {
        if (cancelled) return;
        setGatewayState(state);
        applyModelsSupported(state.supported);
      })
      .catch(() => {
        // 读不到就当作不支持，侧栏不列「模型」
        if (!cancelled) applyModelsSupported(false);
      });
    // 路径显示把主目录写成 ~：主目录启动时读一次，之后 displayPath 同步可用
    void loadHome();
    // 启动时扫一次：停在模型页也要知道有哪些项目（记着的范围要据此纠正）
    void refresh();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = overview?.domains ?? [];
  // 项目列表（spec 2026-09-26-object-first-navigation R4 R10）：skill 与 MCP 两边自动发现的项目的并集，
  // 与当前在哪一页无关。例如没有 skill 的 WeiboAP agent 也在里面。不再有手动添加的项目
  const mcpDomainList = useMemo(
    () =>
      mcpOverview === null
        ? []
        : mcpDomains(mcpOverview).map((d) => ({
            key: d.key,
            // MCP 那边的名字带「项目 · 」前缀；筛选片只写项目名，WeiboAP 的 agent 保留它的显示名
            label: d.targets.some((t) => t.harnessId === "weiboap")
              ? d.label
              : projectName(d.key.slice("project:".length)),
          })),
    [mcpOverview],
  );
  const projects = useMemo(() => unionProjects(domains, mcpDomainList), [domains, mcpDomainList]);
  /// 筛选片按最近活跃取前 6 个；「更多」列表按用户选的排序
  const recentProjects = useMemo(
    () => sortProjects(projects, projectTimes, "active"),
    [projects, projectTimes],
  );
  const sortedProjects = useMemo(
    () => sortProjects(projects, projectTimes, projectSort),
    [projects, projectTimes, projectSort],
  );
  // 项目变了、或又扫了一轮（活跃时间会走），重读时间；读不到不报错，只是不排序
  const projectPathsKey = projects.map((p) => p.path).join("\n");
  useEffect(() => {
    if (projectPathsKey === "") return;
    let cancelled = false;
    void api.projectTimes(projectPathsKey.split("\n")).then(
      (list) => {
        if (!cancelled) setProjectTimes(new Map(list.map((t) => [t.path, t])));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [projectPathsKey, refreshKey]);
  const chooseSort = (sort: ProjectSort) => {
    setProjectSort(sort);
    saveProjectSort(sort);
  };

  /// 模型页的节由注册表生成（shell/agents.tsx）：今天只有 Codex 的第三方模型，只在 macOS 上有。
  /// 侧栏「模型」后的橙点＝有能力开着，与模型页开关、托盘开关读同一份状态，同一帧亮灭
  const agentState: AgentState = { gateway: gatewayState, modelsSupported };
  const visible = visibleAgents(AGENTS, agentState);
  const modelsAvailable = visible.known ? visible.agents.length > 0 : null;
  const sidebarItems: SidebarItem[] = DESTINATIONS.filter(
    (d) => d.id !== "models" || visible.agents.length > 0,
  ).map((d) => ({
    id: d.id as SidebarItem["id"],
    label: d.label,
    on: d.id === "models" && visible.agents.some((a) => a.indicator(agentState)),
  }));

  // ===== 落点（R12）：记住上次停在哪；记着的项目 / 模型页不在了就落回去 =====
  useEffect(() => saveNav(nav), [nav]);
  // 项目列表「知道了」才判断记着的项目还在不在：停在 MCP 页时要等 MCP 扫描回来（只在 MCP 里出现的项目）
  const projectsKnown = overview !== null && (mcpOverview !== null || activeTab !== "mcp");
  const projectKeyList = projectsKnown ? projects.map((p) => p.key) : null;
  useEffect(() => {
    const next = resolveNav(nav, projectKeyList, modelsAvailable);
    if (next !== nav) setNav(next);
    // projectKeyList 每次渲染是新数组，按内容比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, projectKeyList?.join("\n"), modelsAvailable]);

  /// 这一屏涉及的位置（R4）。SKILLS 已按位置集合出表；MCP 的多位置表格接通之前，先取其中一个显示（中间态，不发布）
  const locations = locationsOf(
    nav.scope,
    projects.map((p) => p.key),
  );
  const selectedKey = locations.length === 1 ? locations[0] : GLOBAL_KEY;

  /// 换目的地之后的例行重读：回到 SKILLS 重扫一次（MCP 页由自身 refreshKey 驱动）；
  /// 离开设置时重扫一次，因为设置改了 agent 的启用
  const prevNav = useRef(nav);
  useEffect(() => {
    const prev = prevNav.current;
    prevNav.current = nav;
    if (prev.destination === "settings" && nav.destination !== "settings") {
      void refresh();
      refreshGateway();
    } else if (nav.destination === "skills" && prev.destination !== "skills") void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  // ===== 应用菜单（D15）：菜单栏按下一项 → 换目的地 / 交给设置页 / 作用于输入框 / 交给当前页 =====
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | null = null;
    void listen<string>("menu-command", ({ payload }) => {
      if (!isMenuCommand(payload)) return;
      const active = document.activeElement;
      const editing = isEditable(active);
      const route = routeMenuCommand(payload, navRef.current, editing);
      if (route.text === "undo") document.execCommand("undo");
      if (route.text === "select-all") {
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
          active.select();
        else document.execCommand("selectAll");
      }
      // 停在「关于」、交给页面的命令：换了目的地的（添加来源回到 SKILLS）等页面挂上再交（menuBus 留着这一条）
      const act = () => {
        if (route.settings) setAboutRequest({ at: Date.now(), check: route.settings.check });
        if (route.page) dispatchPageCommand(route.page);
      };
      // 换目的地的（⌘, ⌘1… 设置 / 关于 / 添加来源）与 ⌘[ 返回都要先经离开前询问
      if (route.nav !== navRef.current) navigate(() => route.nav, act);
      else if (route.page === "back") requestLeave(act);
      else act();
    }).then((fn) => (disposed ? fn() : (un = fn)));
    return () => {
      disposed = true;
      un?.();
    };
  }, [navigate]);

  /// 应用菜单「切换项目…」（⌘P，R5）：打开「更多」项目列表。在用户级时先换到全部（用户级没有项目筛选片）
  const [projectListRequest, setProjectListRequest] = useState(0);
  usePageCommand("switch-project", () => {
    if (navRef.current.scope.level === "user") navigate((n) => goLevel(n, "all"));
    setProjectListRequest((n) => n + 1);
  });

  // 菜单里跟着界面灰 / 亮的几项：撤销（当前页有可撤销的操作，或正在输入）、筛选与切换项目（在 SKILLS / MCP）、
  // 返回（在添加来源页）。只在状态真的变了时报给后端
  const flags = useMenuFlags();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const update = () => setEditing(isEditable(document.activeElement));
    // 失焦那一刻 activeElement 还没换好，下一拍再读
    const later = () => setTimeout(update, 0);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, []);
  const menu = menuState(nav, flags, editing);
  useEffect(() => {
    if (!canPopup()) return;
    void api.setMenuState(menu).catch(() => undefined);
  }, [menu.undo, menu.filter, menu.back, menu.switchProject]);

  /// 表格上方那一行项目筛选片（R4）：全部与项目级下出现，用户级下不出
  const scopeBar = showsProjectChips(nav.scope.level) ? (
    <ProjectChips
      recent={recentProjects}
      sorted={sortedProjects}
      selected={nav.scope.project}
      onSelect={(project) => navigate((n) => goProject(n, project))}
      sort={projectSort}
      onSort={chooseSort}
      openRequest={projectListRequest}
    />
  ) : null;

  /// SKILLS / MCP 各一页，共用同一个范围
  const scopedPages: Record<string, () => ReactNode> = {
    skills: () => (
      <SkillsTab
        overview={overview}
        autoLinks={autoLinks}
        onBusy={setBusyState}
        locations={locations}
        onRefresh={refresh}
        onError={setError}
        banner={error !== null}
        scopeBar={scopeBar}
      />
    ),
    mcp: () => (
      <McpTab
        selectedKey={selectedKey}
        onError={setError}
        onBusy={setBusyState}
        refreshKey={refreshKey}
        onOverview={setMcpOverview}
        scopeBar={scopeBar}
      />
    ),
  };

  return (
    <div className="app">
      {/* 机面上方那条 10 高的机壳：整窗宽都能拖窗（D17） */}
      <div className="app__drag" data-tauri-drag-region />
      <Sidebar
        items={sidebarItems}
        selected={nav.destination}
        onSelect={(d) => navigate((n) => goDestination(n, d))}
      />
      {/* 内容是一块机面：所有页面都只替换机面的内容，侧栏始终在（D1 D6）。
        表格横向放不下时，被裁掉的左 / 右边缘出 16px 渐隐（DESIGN「渐变只用于功能」） */}
      <div
        className="face"
        data-fade-left={contentFade.start || undefined}
        data-fade-right={contentFade.end || undefined}
      >
        <main ref={contentRef} className="face__scroll">
          {/* 应用级故障：机面顶上、页面头之上，满内容宽 */}
          {error && (
            <div className="face__banner">
              <NoticePanel scope="app" message={error} onClose={() => setError(null)} />
            </div>
          )}
          {nav.destination === "settings" ? (
            <SettingsPage
              onError={setError}
              initialUpdate={pendingUpdate}
              aboutRequest={aboutRequest ?? undefined}
            />
          ) : nav.destination === "models" ? (
            <ModelsPage
              entries={visible.agents}
              onError={setError}
              onGatewayState={setGatewayState}
              banner={error !== null}
            />
          ) : (
            // SKILLS / MCP：页面头左端是范围滑槽，右端留给页面自己的动作（PageHeadActions）
            <PageHead
              location
              lead={
                <ScopeTabs
                  value={nav.scope.level}
                  onChange={(level) => navigate((n) => goLevel(n, level))}
                />
              }
            >
              {scopedPages[nav.destination]?.() ?? null}
            </PageHead>
          )}
        </main>
      </div>
      {/* 右下那一叠（DESIGN「浮起小窗的位置」）：不属于任何一处的提示小窗，全应用只有这一套——
        壳自己的（别的页上规则在背后添加了 MCP）在这里，各页的（后台自动规则）经 CornerToast 挂进来 */}
      <ToastStack className="app__toast">
        {backgroundMcpReport && (
          <BackgroundMcpToast report={backgroundMcpReport} onClose={closeMcpToast} />
        )}
      </ToastStack>
    </div>
  );
}

/// 停在别的页上时规则在背后添加了 MCP：右下交代一声（⑨⑬ 自动发生的事要交代）；
/// 全成是白窗，有没成的是黑窗
function BackgroundMcpToast({ report, onClose }: { report: McpReport; onClose: () => void }) {
  const created = report.entries.filter((e) => e.outcome === "created");
  const failed = report.entries.filter((e) => e.outcome === "failed");
  const names = [...new Set(created.map((e) => e.name))];
  if (failed.length > 0) {
    return (
      <Toast
        kind="partial"
        verb="自动添加"
        names={names}
        tally={{ done: created.length, failed: failed.length }}
        reason={failed[0].message}
        onDismiss={onClose}
        onClose={onClose}
      />
    );
  }
  return (
    <Toast
      kind="success"
      verb="自动添加"
      names={names}
      reading={names.length === 0 ? <ToastCount n={created.length} /> : undefined}
      onDismiss={onClose}
    />
  );
}

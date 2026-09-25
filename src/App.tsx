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
  type SidebarProject,
} from "./sidebarProjects";
import {
  NoticePanel,
  PageHead,
  Tabs,
  Toast,
  ToastCount,
  ToastStack,
  useEdgeFades,
} from "./ui";
import type { AnchorRect } from "./layerPlace";
import { Sidebar, type RemovedProject } from "./shell/Sidebar";
import { AGENTS } from "./shell/agents";
import { AgentPage } from "./shell/AgentPage";
import { sidebarAgentsOf, visibleAgents, type AgentState } from "./shell/agentRegistry";
import { LOCATION_DOMAINS } from "./shell/domains";
import {
  GLOBAL_KEY,
  goAgent,
  goLocation,
  goSettings,
  goTab,
  loadPlace,
  resolvePlace,
  savePlace,
  selectionOf,
  type LocationTab,
  type Place,
} from "./shell/place";
import { isMenuCommand, menuState, routeMenuCommand } from "./shell/menuCommands";
import { dispatchPageCommand, useMenuFlags } from "./shell/menuBus";
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
  /// 用户发起的写入正在进行：后台重扫排到它结束之后。**不锁页签、不锁项目切换**——
  /// 忙碌只锁触发它的那个控件（DESIGN「反馈的两种形态 › 忙碌」），由各页自己管
  const [busy, setBusy] = useState(false);
  /// 添加 / 移除项目进行中：只锁侧栏的这两处（同一个对象：项目列表）
  const [projectBusy, setProjectBusy] = useState<"add" | "remove" | null>(null);
  /// 你在哪（D1 D2）：侧栏选中项 + 位置页的页签。首次 `全局 · skills`，之后记住上次停在哪
  const [place, setPlace] = useState<Place>(loadPlace);
  const selectedKey = place.locationKey;
  const [error, setError] = useState<string | null>(null);
  /// 应用菜单「关于 Sophia」「检查更新…」：设置页停在「关于」一节，`check` 时同时开始检查。
  /// `at` 让同一个请求再发一次也算新的
  const [aboutRequest, setAboutRequest] = useState<{ at: number; check: boolean } | null>(null);
  /// 刚从侧栏移除的手动项目：`×` 原位下方的 `✓ 已移除 X · 撤销`（D11）
  const [removed, setRemoved] = useState<(RemovedProject & { wasSelected: boolean }) | null>(null);
  /// 启动时后台查一次新版。**必须静默失败**：`plugins.updater.pubkey` 没填之前
  /// check() 一定报错，进横幅的话每次开应用先看见一条错。null＝查过没有 / 没查成
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  /// 位置页此刻显示哪张表；不在位置页时为 null
  const activeTab: LocationTab | null = place.view === "location" ? place.tab : null;
  /// Codex 页（agent 段）只在后端确认支持（当前只有 macOS）时才有；null＝还没问出来。
  /// 读取失败时当作不支持，agent 段不出
  const [modelsSupported, setModelsSupported] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // 手动添加的项目路径：侧栏并集的一份，也用来判断哪些项目可以移除
  const [manualProjects, setManualProjects] = useState<string[]>([]);
  /// 侧栏排序：选择记在本机，下次打开照旧
  const [projectSort, setProjectSort] = useState<ProjectSort>(loadProjectSort);
  /// 项目路径 → 两种时间；读不到时列表保持并集的次序
  const [projectTimes, setProjectTimes] = useState<ReadonlyMap<string, ProjectTimes>>(new Map());
  // 自动同步规则；扫描时顺带取回，域页与添加页都用它
  const [autoLinks, setAutoLinks] = useState<AutoLink[]>([]);
  const [backgroundMcpReport, setBackgroundMcpReport] = useState<McpReport | null>(null);
  /// MCP 扫描结果（侧栏项目列表要它）与模型状态（侧栏 agent 指示点要它）
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
  const placeRef = useRef(place);
  busyRef.current = busy;
  activeTabRef.current = activeTab;
  placeRef.current = place;

  /// 用户换页的唯一入口（侧栏、页签、⌘, ⌘1…、应用菜单、托盘跳转、`查看`）：会换掉机面里这一页时先经
  /// 「离开前询问」（shell/leaveGuard.ts）——那一页有没保存的改动就由它就地问，问完才走；`then` 是
  /// 走到之后要做的事（停在「关于」、把命令交给新的页）。不换页的（只改记着的页签）当场走
  const navigate = useCallback((to: (p: Place) => Place, then?: () => void) => {
    const go = () => {
      setPlace(to);
      then?.();
    };
    if (changesPage(placeRef.current, to(placeRef.current))) requestLeave(go);
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
  /// 侧栏项目列表是 skill 与 MCP 两边发现的并集，与当前页签无关，所以 skill 每次都扫。
  /// MCP 停在 MCP 页时由 McpTab 扫完回传（onOverview），不重复扫；停在别的页签时这里扫一次，
  /// 缓存到下次聚焦 / 文件变化。扫描可能触发已授权的自动规则；界面以重新扫描的实际结果为准。
  ///
  /// 同一时间只跑一轮：扫描中又被叫到，记一个标记、等这一轮连同补扫一起结束再返回——
  /// 调用方 await 回来时拿到的是最新的
  const scanOnce = async () => {
    try {
      const [next, projects, rules, mcp] = await Promise.all([
        api.scanAll(),
        api.listManualProjects(),
        api.listAutoLinks(),
        activeTabRef.current === "mcp" ? Promise.resolve(null) : api.scanMcp().catch(() => null),
      ]);
      setOverview(next);
      setManualProjects(projects);
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

  /// 模型状态只为侧栏 Codex 后的指示点：后台轻查，不显示忙碌
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
          if (payload.page === "settings") navigate(goSettings);
          if (payload.page === "models") navigate((p) => goAgent(p, "codex"));
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

  /// Codex 页在非 macOS 上并不存在：一问出「不支持」，记着停在 Codex 页的落点由 resolvePlace 退回位置页
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
        // 读不到就当作不支持，agent 段不出
        if (!cancelled) applyModelsSupported(false);
      });
    // 路径显示把主目录写成 ~：主目录启动时读一次，之后 displayPath 同步可用
    void loadHome();
    // 启动时扫一次：停在 Codex 页，侧栏也要列出 Skills 与 MCP 两边发现的项目
    void refresh();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = overview?.domains ?? [];
  // 侧栏（DESIGN「侧栏」）：skill 与 MCP 两边发现的项目 ∪ 手动添加的，
  // 与当前页签无关，切页签时列表与选中都不变。例如没有 skill 的 WeiboAP agent 也在里面
  const mcpDomainList = useMemo(
    () =>
      mcpOverview === null
        ? []
        : mcpDomains(mcpOverview).map((d) => ({
            key: d.key,
            // MCP 那边的名字带「项目 · 」前缀；侧栏只写项目名，WeiboAP 的 agent 保留它的显示名
            label: d.targets.some((t) => t.harnessId === "weiboap")
              ? d.label
              : projectName(d.key.slice("project:".length)),
          })),
    [mcpOverview],
  );
  const projects = useMemo(
    () => unionProjects(domains, mcpDomainList, manualProjects),
    [domains, mcpDomainList, manualProjects],
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

  /// agent 段与 agent 页都由注册表生成（shell/agents.tsx）：今天只有 Codex，只在 macOS 上有。
  /// 名字后的橙点＝有能力开着（第三方模型），与 Codex 页开关、托盘开关读同一份状态，同一帧亮灭
  const agentState: AgentState = { gateway: gatewayState, modelsSupported };
  const visible = visibleAgents(AGENTS, agentState);
  const agents = sidebarAgentsOf(visible.agents, agentState);
  const agentEntry =
    place.view === "agent" ? visible.agents.find((a) => a.id === place.agentId) : undefined;

  // ===== 落点（D2）：记住上次停在哪；记着的项目 / agent 不在了就落回去 =====
  useEffect(() => savePlace(place), [place]);
  // 项目列表「知道了」才判断记着的项目还在不在：停在 MCP 页时要等 MCP 扫描回来（只在 MCP 里出现的项目）
  const projectsKnown = overview !== null && (mcpOverview !== null || activeTab !== "mcp");
  const projectKeyList = projectsKnown ? projects.map((p) => p.key) : null;
  const agentIdList = visible.known ? agents.map((a) => a.id) : null;
  useEffect(() => {
    const next = resolvePlace(place, projectKeyList, agentIdList);
    if (next !== place) setPlace(next);
    // projectKeyList / agentIdList 每次渲染是新数组，按内容比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, projectKeyList?.join("\n"), agentIdList?.join("\n")]);

  /// 换目的地之后的例行重读：回到 Skills 表重扫一次（MCP 页由自身 refreshKey 驱动）；
  /// 离开设置时重扫一次，因为设置改了 agent 的启用
  const prevPlace = useRef(place);
  useEffect(() => {
    const prev = prevPlace.current;
    prevPlace.current = place;
    const wasSkills = prev.view === "location" && prev.tab === "skills";
    const isSkills = place.view === "location" && place.tab === "skills";
    if (prev.view === "settings" && place.view !== "settings") {
      void refresh();
      refreshGateway();
    } else if (isSkills && !wasSkills) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  const addProject = async () => {
    const path = await api.pickDirectory("选择项目目录");
    if (!path) return;
    // 用户发起、正在等：只锁项目列表的增删（键原位忙碌），页签与切换项目照常
    setProjectBusy("add");
    setBusyState(true);
    try {
      await api.addProject(path);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyState(false);
      setProjectBusy(null);
    }
  };

  /// 从侧栏移除手动项目（D11）：不确认——只从侧栏拿掉、不动磁盘；移除后 `×` 原位下方浮起
  /// `✓ 已移除 X · 撤销`。移除的正是当前选中的项目时选中落到 `全局`
  const removeProject = async (project: SidebarProject, anchor: AnchorRect) => {
    const wasSelected = place.view === "location" && place.locationKey === project.key;
    setProjectBusy("remove");
    setBusyState(true);
    try {
      await api.removeProject(project.path);
      if (wasSelected) setPlace((p) => goLocation(p, GLOBAL_KEY));
      setRemoved({ path: project.path, name: project.label, anchor, at: Date.now(), wasSelected });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyState(false);
      setProjectBusy(null);
    }
  };

  /// `撤销`：把它放回侧栏（排位由排序决定，与移除前同一处）；移除前选中着它就重新选中
  const undoRemove = async () => {
    const r = removed;
    if (!r) return;
    setRemoved(null);
    setProjectBusy("add");
    setBusyState(true);
    try {
      await api.addProject(r.path);
      await refresh();
      if (r.wasSelected) setPlace((p) => goLocation(p, `project:${r.path}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyState(false);
      setProjectBusy(null);
    }
  };
  const clearRemoved = useCallback(() => setRemoved(null), []);

  // ===== 应用菜单（D15）：菜单栏按下一项 → 换目的地 / 交给设置页 / 作用于输入框 / 交给当前页 =====
  const addProjectRef = useRef(addProject);
  addProjectRef.current = addProject;
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | null = null;
    void listen<string>("menu-command", ({ payload }) => {
      if (!isMenuCommand(payload)) return;
      const active = document.activeElement;
      const editing = isEditable(active);
      const route = routeMenuCommand(payload, placeRef.current, editing);
      if (route.shell === "add-project") void addProjectRef.current();
      if (route.text === "undo") document.execCommand("undo");
      if (route.text === "select-all") {
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
          active.select();
        else document.execCommand("selectAll");
      }
      // 停在「关于」、交给页面的命令：换了目的地的（添加来源回到位置页）等页面挂上再交（menuBus 留着这一条）
      const act = () => {
        if (route.settings) setAboutRequest({ at: Date.now(), check: route.settings.check });
        if (route.page) dispatchPageCommand(route.page);
      };
      // 换目的地的（⌘, ⌘1… 设置 / 关于 / 添加来源）与 ⌘[ 返回都要先经离开前询问
      if (route.place !== placeRef.current) navigate(() => route.place, act);
      else if (route.page === "back") requestLeave(act);
      else act();
    }).then((fn) => (disposed ? fn() : (un = fn)));
    return () => {
      disposed = true;
      un?.();
    };
  }, [navigate]);

  // 菜单里跟着界面灰 / 亮的三项：撤销（当前页有可撤销的操作，或正在输入）、筛选（在位置页）、
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
  const menu = menuState(place, flags, editing);
  useEffect(() => {
    if (!canPopup()) return;
    void api.setMenuState(menu).catch(() => undefined);
  }, [menu.undo, menu.filter, menu.back]);

  const selection = selectionOf(place);

  /// 位置页每个 domain（页签，见 shell/domains.ts）对应的一页。表里加一个 domain，在这里配一页
  const locationPages: Record<string, () => ReactNode> = {
    skills: () => (
      <SkillsTab
        overview={overview}
        autoLinks={autoLinks}
        onBusy={setBusyState}
        selectedKey={selectedKey}
        onRefresh={refresh}
        onError={setError}
        banner={error !== null}
      />
    ),
    mcp: () => (
      <McpTab
        selectedKey={selectedKey}
        onError={setError}
        onBusy={setBusyState}
        refreshKey={refreshKey}
        onOverview={setMcpOverview}
      />
    ),
  };

  return (
    <div className="app">
      {/* 机面上方那条 10 高的机壳：整窗宽都能拖窗（D17） */}
      <div className="app__drag" data-tauri-drag-region />
      <Sidebar
        agents={agents}
        projects={sortedProjects}
        projectTimes={projectTimes}
        selection={selection}
        onSelectLocation={(key) => navigate((p) => goLocation(p, key))}
        onSelectAgent={(id) => navigate((p) => goAgent(p, id))}
        onSelectSettings={() => navigate(goSettings)}
        sort={projectSort}
        onSort={chooseSort}
        projectBusy={projectBusy}
        onAddProject={() => void addProject()}
        onRemoveProject={(p, anchor) => void removeProject(p, anchor)}
        removed={removed}
        onUndoRemove={() => void undoRemove()}
        onRemovedGone={clearRemoved}
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
          {place.view === "settings" ? (
            <SettingsPage
              onError={setError}
              initialUpdate={pendingUpdate}
              aboutRequest={aboutRequest ?? undefined}
            />
          ) : agentEntry ? (
            <AgentPage
              entry={agentEntry}
              onError={setError}
              onGatewayState={setGatewayState}
              banner={error !== null}
            />
          ) : (
            // 位置页：页面头左端 `skills ｜ mcp` 滑槽，右端留给页面自己的动作（PageHeadActions）
            <PageHead
              location
              lead={
                <Tabs
                  items={LOCATION_DOMAINS}
                  value={place.tab}
                  onChange={(tab) => navigate((p) => goTab(p, tab))}
                  label="这个位置的哪张表"
                />
              }
            >
              {locationPages[place.tab]?.() ?? null}
            </PageHead>
          )}
        </main>
      </div>
      {/* 右下那一叠（DESIGN「浮起小窗的位置」）：不属于任何一处的提示小窗，全应用只有这一套——
        壳自己的（别的页签上规则在背后添加了 MCP）在这里，各页的（后台自动规则）经 CornerToast 挂进来 */}
      <ToastStack className="app__toast">
        {backgroundMcpReport && (
          <BackgroundMcpToast report={backgroundMcpReport} onClose={closeMcpToast} />
        )}
      </ToastStack>
    </div>
  );
}

/// 停在别的页签时规则在背后添加了 MCP：右下交代一声（⑨⑬ 自动发生的事要交代）；
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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { productLabel } from "./brandsView";
import type {
  AutoLink,
  GatewayState,
  GatewayUnreadable,
  HarnessList,
  McpOverview,
  McpReport,
  Overview,
  ProjectTimes,
} from "./types";
import { appFaultView, parseBackendError } from "./backendError.ts";
import type { AppFault } from "./backendError.ts";
import SkillsTab from "./SkillsTab";
import {
  agentsOverCapOf,
  keepDismissed,
  loadOverCapDismissed,
  overCapWanted,
  saveOverCapDismissed,
} from "./agentsOverCap";
import McpTab from "./McpTab";
import { SettingsPage } from "./pages/SettingsPage";
import { appUpdates, useAppUpdate } from "./useAppUpdate";
import { RECHECK_TICK_MS } from "./appUpdate";
import { mcpDomains, mirrorFailedNote } from "./mcpView";
import { joinReasons, keyHintNote } from "./mcpKeyHint";
import { loadHome } from "./pathText";
import {
  loadProjectSort,
  projectName,
  saveProjectSort,
  sortProjects,
  unionProjects,
  type ProjectSort,
} from "./sidebarProjects";
import {
  dismissFormDialogs,
  formDialogOpen,
  NoticePanel,
  PageHead,
  Toast,
  ToastCount,
  ToastStack,
  UpdateKey,
  useEdgeFades,
} from "./ui";
import { Sidebar, type SidebarItem } from "./shell/Sidebar";
import { AGENTS } from "./shell/agents";
import { ModelsPage } from "./shell/ModelsPage";
import { UsagePage } from "./usage/UsagePage";
import { visibleAgents, type AgentState } from "./shell/agentRegistry";
import { DESTINATIONS, destinationLabel, isScoped } from "./shell/destinations";
import {
  faceOf,
  goDestination,
  goFace,
  goLocation,
  goRow,
  locationOf,
  loadNav,
  locationsOf,
  resolveNav,
  saveNav,
  type Destination,
  type Nav,
} from "./shell/nav";
import {
  isMenuCommand,
  menuState,
  quitWithDialog,
  routeMenuCommand,
  routeWithDialog,
} from "./shell/menuCommands";
import { dispatchPageCommand, useMenuFlags, usePageCommand } from "./shell/menuBus";
import { FaceTabs, FilterRow } from "./FilterRow";
import type { InstallContext } from "./market";
import { changesPage, leaveGuarded, requestLeave } from "./shell/leaveGuard";
import { canPopup } from "./contextMenu";
import { t, useLocale, useOnLocaleChange } from "./i18n";
import { useQuitFlow } from "./QuitFlow";
import { FaultBomb, PageGuard, useFaultPage } from "./PageGuard";
import { copyDetails } from "./diagnostics";
import { CrashNotice, FeedbackHost } from "./feedback";
import { SettingsRepairedNotice } from "./settingsRepaired";
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
  /// 开发版故意让某一页渲染出错（`debug_fault`），验证页面兜底；正式版恒为 null
  const faultPage = useFaultPage();
  const [overview, setOverview] = useState<Overview | null>(null);
  /// 用户发起的写入正在进行：后台重扫排到它结束之后。**不锁位置切换**——
  /// 忙碌只锁触发它的那个控件（DESIGN「反馈的两种形态 › 忙碌」），由各页自己管
  const [busy, setBusy] = useState(false);
  /// 你在哪（spec 2026-09-26-object-first-navigation R12；2026-09-27-skill-mcp-market R1–R3）：目的地（侧栏选中项）、
  /// 位置与两页各自的面（`我的 ｜ 发现`）分开记。首次 `SKILLS · 我的 · 全部`，之后记住上次停在哪；升级时从旧记忆换算一次
  const [nav, setNav] = useState<Nav>(loadNav);
  /// 窗口顶上横幅的故障：后端错误串，出错处可以再给该处的失败句与「再试一次」（设置保存失败，spec #239）
  const [fault, setFault] = useState<AppFault | null>(null);
  const error = fault?.text ?? null;
  const setError = useCallback(
    (text: string | null, more?: Omit<AppFault, "text">) =>
      setFault(text === null ? null : { ...more, text }),
    [],
  );
  /// 应用菜单「关于 Sophia」「检查更新…」：设置页停在「关于」一节，`check` 时同时开始检查。
  /// `at` 让同一个请求再发一次也算新的。离开设置就清掉，下回从侧栏进设置不再跳、不再查
  const [aboutRequest, setAboutRequest] = useState<{ at: number; check: boolean } | null>(null);
  /// SKILLS 页「装了 N 个 agent」灰面板的 `去设置`：设置页停在 `Skills 和 MCP` 一节（第一块是 `显示的 agent`）。离开设置就清掉，
  /// 下回从侧栏进设置不再跳
  const [agentsRequest, setAgentsRequest] = useState<{ at: number } | null>(null);
  /// Sophia 自己的新版本：侧栏的更新键与设置「关于」读同一份（src/useAppUpdate.ts）
  const appUpdate = useAppUpdate();
  /// 此刻显示哪张表（SKILLS / MCP）；在模型页、设置时为 null
  const activeTab: Destination | null = isScoped(nav.destination) ? nav.destination : null;
  /// 模型页只在后端确认支持（当前只有 macOS）时才有；null＝还没问出来。
  /// 读取失败时当作不支持，侧栏不列「模型」
  const [modelsSupported, setModelsSupported] = useState<boolean | null>(null);
  /// 托盘跳到模型页的次数：模型页的 key。已经停在模型页、推入着某家的页时，托盘跳转要落在列表页（spec R41），
  /// 换一个 key 让模型页重新挂上、回到列表页（推入状态只在模型页里，不进 Nav）
  const [modelsVisit, setModelsVisit] = useState(0);
  /// 用量页（⌘4）只在后端有用量（macOS）时才有；null＝还没问出来，读取失败当作没有
  const [usageSupported, setUsageSupported] = useState<boolean | null>(null);
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
  const [gatewayState, setGatewayStateRaw] = useState<GatewayState | null>(null);
  /// 模型状态整个读不回来（命令本身失败）：入口照常列，模型页顶上说（spec 2026-10-04-local-diagnostics R11）
  const [gatewayError, setGatewayError] = useState<GatewayUnreadable | null>(null);
  /// 读回了一份状态：读不回来的那句随之撤掉
  const setGatewayState = useCallback((state: GatewayState) => {
    setGatewayStateRaw(state);
    setGatewayError(null);
  }, []);
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

  /// 用户换页的唯一入口（侧栏、`我的 ｜ 发现` 滑槽、位置胶囊、⌘, ⌘1…、应用菜单、托盘跳转）：会换掉机面里这一页时先经
  /// 「离开前询问」（shell/leaveGuard.ts）——那一页有没保存的改动就由它就地问，问完才走；`then` 是
  /// 走到之后要做的事（停在「关于」、把命令交给新的页）。不换页的（只改记着的位置）当场走
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
      // 读取类命令出错分两层（#302）：一句「Sophia 的数据读取失败」，原文进「!」；后端没给前缀的整段进「!」
      setError(String(e), { fallback: t("common.data.readFailed") });
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
  }, [setGatewayState]);

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

  /// 启动时后台查一次新版，之后距上次超过 6 小时再查（常驻菜单栏几天不退出也能知道）。
  /// **必须静默失败**：`plugins.updater.pubkey` 没填之前 check() 一定报错，说出来每次开应用先看见一条错。
  /// 只查不下：点了侧栏的更新键或设置里的 `下载并安装` 才下载
  useEffect(() => {
    void appUpdates.checkQuietly();
    const id = window.setInterval(() => void appUpdates.checkIfDue(), RECHECK_TICK_MS);
    return () => window.clearInterval(id);
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
          // 已经在模型页：可能推入着某家的页，回到列表页——也是离开那一页，表单有没保存的改动先就地问
          if (payload.page === "models" && navRef.current.destination === "models") {
            requestLeave(() => setModelsVisit((n) => n + 1));
          }
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

  // 用量页同理：问一次后端有没有用量（不触发取数），没有就不列、落点退回 SKILLS
  useEffect(() => {
    let cancelled = false;
    void api
      .usageView(false)
      .then((view) => !cancelled && setUsageSupported(view !== null))
      .catch(() => !cancelled && setUsageSupported(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .gatewayState()
      .then((state) => {
        if (cancelled) return;
        setGatewayState(state);
        applyModelsSupported(state.supported);
      })
      .catch((error) => {
        // 读不到不再当作不支持（原来侧栏「模型」会消失）：入口照常列，模型页顶上说原因、给 `再试一次`。
        // 不支持的系统上命令不会失败（返回 supported: false），所以失败只会出在支持的系统上
        if (cancelled) return;
        const parsed = parseBackendError(String(error));
        setGatewayError({
          kind: "other",
          path: "",
          line: null,
          reason: "",
          detail: parsed.detail ?? String(error),
        });
        applyModelsSupported(true);
      });
    // 路径显示把主目录写成 ~：主目录启动时读一次，之后 displayPath 同步可用
    void loadHome();
    // 启动时扫一次：停在模型页也要知道有哪些项目（记着的位置要据此纠正）
    void refresh();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = overview?.domains ?? [];
  const lang = useLocale();
  // 换了界面语言：后端算好的句子（扫描结果里的原因、MCP、模型状态）按新语言重拉
  useOnLocaleChange(() => {
    requestRefresh();
    refreshGateway();
  });
  // 项目列表（spec 2026-09-26-object-first-navigation R4 R10）：skill 与 MCP 两边自动发现的项目的并集，
  // 与当前在哪一页无关。例如没有 skill 的 WeiboAP agent 也在里面。手动选的项目也在里面，设置「生效范围」里取消勾的不在（core 不扫它们）
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
    // 名字里有文案（「项目 · 」前缀），换了语言重算
    [mcpOverview, lang],
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

  /// 安装类推入页的 `给谁用` / `写进哪些 agent`：已安装的 agent 与设置里 `显示的 agent`。
  /// 每轮扫描后重读（设置里改了名单、新装了 agent）；读不到就当一个都没有，不报错
  const [harnesses, setHarnesses] = useState<HarnessList | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.listHarnesses().then(
      (list) => !cancelled && setHarnesses(list),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  /// 已安装的产品（含只有 MCP 的 Claude Desktop），名单按品牌：品牌勾着，它的产品都在 `shown` 里（#251）
  const installContext: InstallContext = useMemo(() => {
    const installed = (harnesses?.harnesses ?? []).filter((h) => h.installed);
    const agents = installed.map((h) => ({
      id: h.id,
      name: productLabel(h.id, h.displayName),
      skills: h.skills,
      mcp: h.mcp,
      mcpTrust: h.mcpTrust,
      skillUser: h.skillUser,
      skillProject: h.skillProject,
      brand: h.brand,
      brandName: h.brandName,
    }));
    return {
      mine: locationOf(nav),
      places: {
        recent: recentProjects,
        sorted: sortedProjects,
        sort: projectSort,
        onSort: chooseSort,
      },
      agents,
      shown: installed.filter((h) => h.enabled).map((h) => h.id),
    };
    // chooseSort 每次渲染是新函数，只写本地状态与本机记忆
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnesses, nav, recentProjects, sortedProjects, projectSort]);

  /// 装的 agent 多于列表上限时 SKILLS 页筛选行下那块灰面板（issue #109）：关掉的那一批记在本机；
  /// 装的集合一变（不管停在哪一页）关掉的记录就作废，再超上限时再出
  const [overCapDismissed, setOverCapDismissed] = useState(loadOverCapDismissed);
  useEffect(() => {
    const keep = keepDismissed(harnesses, overCapDismissed);
    if (keep === overCapDismissed) return;
    setOverCapDismissed(keep);
    saveOverCapDismissed(keep);
  }, [harnesses, overCapDismissed]);
  const agentsOverCap = agentsOverCapOf(harnesses);

  /// 模型页的节由注册表生成（shell/agents.tsx）：Codex 与 Claude（桌面应用）的第三方模型，只在 macOS 上有。
  /// 侧栏「模型」后的橙点＝任一家开着，与模型页开关、托盘开关读同一份状态，同一帧亮灭
  const agentState: AgentState = {
    gateway: gatewayState,
    modelsSupported,
    usage: null,
    gatewayError,
  };
  const visible = visibleAgents(AGENTS, agentState);
  const modelsAvailable = visible.known ? visible.agents.length > 0 : null;
  /// 上次停在模型页、还没问出支不支持时：侧栏照样列「模型」并选中它，页里出忙碌空态（问出不支持再退回 SKILLS）
  const modelsLoading = !visible.known && nav.destination === "models";
  const sidebarItems: SidebarItem[] = DESTINATIONS.filter(
    (d) =>
      (d.id !== "models" || visible.agents.length > 0 || modelsLoading) &&
      // 用量：有才列；还没问出来时，只有上次停在用量页才先列着（同模型页）
      (d.id !== "usage" ||
        usageSupported === true ||
        (usageSupported === null && nav.destination === "usage")),
  ).map((d) => ({
    id: d.id as SidebarItem["id"],
    label: destinationLabel(d),
    on: d.id === "models" && visible.agents.some((a) => a.indicator(agentState)),
  }));

  // ===== 落点（R12）：记住上次停在哪；记着的项目 / 模型页不在了就落回去 =====
  useEffect(() => saveNav(nav), [nav]);
  // 项目列表「知道了」才判断记着的项目还在不在：停在 MCP 页时要等 MCP 扫描回来（只在 MCP 里出现的项目）
  const projectsKnown = overview !== null && (mcpOverview !== null || activeTab !== "mcp");
  const projectKeyList = projectsKnown ? projects.map((p) => p.key) : null;
  useEffect(() => {
    const next = resolveNav(nav, projectKeyList, modelsAvailable, usageSupported);
    if (next !== nav) setNav(next);
    // projectKeyList 每次渲染是新数组，按内容比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, projectKeyList?.join("\n"), modelsAvailable, usageSupported]);

  /// 这一屏涉及的位置（R2）：SKILLS 与 MCP 都按这个位置集合出表。位置本身（`全部` / `用户级` / 某个项目）是
  /// 两页清空勾选、收起来源页的键：位置集合会随后台重扫变（`全部` 下多出一个项目），位置不会
  const scopeKey = locationOf(nav);
  const locations = locationsOf(
    locationOf(nav),
    projects.map((p) => p.key),
  );
  const face = faceOf(nav);

  /// 换目的地之后的例行重读：回到 SKILLS 重扫一次（MCP 页由自身 refreshKey 驱动）；
  /// 离开设置时重扫一次，因为设置改了 agent 的启用；停在设置某一节的请求（「关于」「列表里的 agent」）同时清掉
  const prevNav = useRef(nav);
  useEffect(() => {
    const prev = prevNav.current;
    prevNav.current = nav;
    if (prev.destination === "settings" && nav.destination !== "settings") {
      setAboutRequest(null);
      setAgentsRequest(null);
      void refresh();
      refreshGateway();
    } else if (nav.destination === "skills" && prev.destination !== "skills") void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  // ===== 退出 Sophia（菜单「退出 Sophia」⌘Q，spec 2026-10-03-gateway-in-app R5–R9）：确认框在窗口正中 =====
  const quit = useQuitFlow();
  const startQuit = quit.start;
  useEffect(() => {
    // 填短表单的弹窗开着（反馈小窗、提供商弹窗，不分种类）：先收起它、摘掉壳的 inert，再照常走退出（确认框在壳里）；
    // 弹窗里有没保存的改动先经离开前那一问，丢弃或保存了才收起、退出（同菜单命令换页的判断，见 `quitWithDialog`）
    const pending = listen("quit-requested", () =>
      quitWithDialog(
        { open: formDialogOpen(), guarded: leaveGuarded() },
        { dismiss: dismissFormDialogs, ask: requestLeave, quit: startQuit },
      ),
    );
    return () => void pending.then((un) => un());
  }, [startQuit]);

  /// 应用菜单「添加项目…」（同设置「生效范围」的 `+ 项目`）：不换页，弹系统文件夹选择器，选了就加、重扫一轮——
  /// 新项目出现在筛选行里，停在设置时「生效范围」跟着重读。当不了项目的（主目录、不是文件夹）在顶上说原因
  const addProjectFromMenu = async () => {
    try {
      const path = await api.pickDirectory(t("settings.scope.pickDialog"));
      if (path === null) return;
      await api.addProject(path);
    } catch (e) {
      setError(String(e));
      return;
    }
    void refreshRef.current();
  };

  // ===== 应用菜单（D15）：菜单栏按下一项 → 换目的地 / 交给设置页 / 作用于输入框 / 交给当前页 =====
  useEffect(() => {
    let disposed = false;
    let un: (() => void) | null = null;
    void listen<string>("menu-command", ({ payload }) => {
      if (!isMenuCommand(payload)) return;
      const active = document.activeElement;
      const editing = isEditable(active);
      const routed = routeMenuCommand(payload, navRef.current, editing);
      // 填短表单的弹窗开着（反馈小窗、提供商弹窗，模态，遮罩盖着整窗）：弹窗里有没保存的改动照常走、换页先经离开前
      // 那一问；没有就不换页、不交给页面，只留作用于弹窗里输入框的撤销 / 全选
      const route = routeWithDialog(routed, navRef.current, {
        open: formDialogOpen(),
        guarded: leaveGuarded(),
      });
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
        if (route.addProject) void addProjectFromMenu();
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

  /// 「更多」项目列表开没开、⌘P 第几次（已开着时再按，焦点回到搜索框）：状态归壳——⌘P 在 `发现` 时先回到 `我的`
  /// （菜单路由里换面），筛选行是那一刻才出现的，列表要跟着它一起打开，不能交给筛选行自己记
  const [projectList, setProjectList] = useState({ open: false, focus: 0 });
  /// 应用菜单「切换项目…」（⌘P）：打开「更多」项目列表（换面被离开确认拦下、没换成时，这一条不会交到这里）
  usePageCommand("switch-project", () =>
    setProjectList((s) => ({ open: true, focus: s.focus + 1 })),
  );
  // 离开 SKILLS / MCP、换到 `发现`（没有筛选行）时收起，回来时不自己弹出
  useEffect(() => {
    setProjectList((s) => (s.open ? { ...s, open: false } : s));
  }, [nav.destination, face]);

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
  const menu = menuState(nav, flags, editing, sortedProjects.length > 0);
  useEffect(() => {
    if (!canPopup()) return;
    void api.setMenuState(menu).catch(() => undefined);
  }, [menu.undo, menu.filter, menu.back, menu.switchProject]);

  /// `我的` 表格上方那一行（R2）：左 `位置` 胶囊归壳（位置两页各记各的），右端 `来源` 下拉归各页（`source`）
  const filterBar = (source: ReactNode) => (
    <FilterRow
      recent={recentProjects}
      sorted={sortedProjects}
      location={locationOf(nav)}
      onLocation={(location) => navigate((n) => goLocation(n, location))}
      sort={projectSort}
      onSort={chooseSort}
      listOpen={projectList.open}
      listFocus={projectList.focus}
      onListOpen={(open) => setProjectList((s) => ({ ...s, open }))}
      source={source}
    />
  );

  /// SKILLS / MCP 各一页；位置与 `我的 ｜ 发现` 都是两页各记各的
  const scopedPages: Record<string, () => ReactNode> = {
    skills: () => (
      <SkillsTab
        overview={overview}
        autoLinks={autoLinks}
        onBusy={setBusyState}
        locations={locations}
        scopeKey={scopeKey}
        onRefresh={refresh}
        onError={setError}
        banner={error !== null}
        face={face}
        filterBar={filterBar}
        install={installContext}
        onDiscover={() => navigate((n) => goFace(n, "discover"))}
        onGoToRow={(domainKey) =>
          navigate((n) =>
            goRow(
              n,
              domainKey,
              projects.map((p) => p.key),
            ),
          )
        }
        agentsOverCap={{
          cap: agentsOverCap,
          open: overCapWanted(agentsOverCap, overCapDismissed),
          onDismiss: () => {
            const key = agentsOverCap?.key ?? null;
            setOverCapDismissed(key);
            saveOverCapDismissed(key);
          },
          onOpenSettings: () =>
            navigate(
              (n) => goDestination(n, "settings"),
              () => setAgentsRequest({ at: Date.now() }),
            ),
        }}
      />
    ),
    mcp: () => (
      <McpTab
        locations={locations}
        scopeKey={scopeKey}
        onError={setError}
        banner={error !== null}
        onBusy={setBusyState}
        refreshKey={refreshKey}
        onOverview={setMcpOverview}
        face={face}
        filterBar={filterBar}
        install={installContext}
        onDiscover={() => navigate((n) => goFace(n, "discover"))}
        onOpenSettings={() =>
          navigate(
            (n) => goDestination(n, "settings"),
            () => setAgentsRequest({ at: Date.now() }),
          )
        }
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
        update={
          appUpdate.phase.kind === "none" ? undefined : (
            <UpdateKey
              phase={appUpdate.phase}
              onDownload={() => void appUpdates.install()}
              onRestart={() => void appUpdates.relaunch()}
            />
          )
        }
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
          {fault && (
            <div className="face__banner">
              {/* 后端错误形如 `[code] 一句\n[detail] 原文`（spec 2026-10-04-local-diagnostics R13、#239）：一句给人看，
                  原文进前面的「!」与 `复制详情`（spec S18）；没有前缀的整段原样，出错处给了失败句时用失败句、整段进「!」。
                  带原文的才给 `再试一次`（`appFaultView`） */}
              <FaultBanner fault={fault} onClose={() => setError(null)} />
            </div>
          )}
          {/* 上次意外退出、上报关着时提示一次（把问题报告给我们） */}
          <CrashNotice />
          {/* 设置文件坏了、已另存并重置（spec S7）：提示一次 */}
          <SettingsRepairedNotice />
          {/* 页面兜底：只包页面这一块，侧栏在外；换页（key）就重置 */}
          <PageGuard key={nav.destination}>
            {faultPage === nav.destination && <FaultBomb page={faultPage} />}
            {nav.destination === "settings" ? (
              <SettingsPage
                onError={setError}
                refreshKey={refreshKey}
                aboutRequest={aboutRequest ?? undefined}
                agentsRequest={agentsRequest ?? undefined}
                onShowUpdates={() =>
                  navigate((n) => goLocation(goFace(goDestination(n, "skills"), "mine"), "all"))
                }
              />
            ) : nav.destination === "usage" ? (
              <UsagePage onError={setError} />
            ) : nav.destination === "models" ? (
              <ModelsPage
                key={modelsVisit}
                entries={visible.agents}
                state={agentState}
                loading={modelsLoading}
                onError={setError}
                onGatewayState={setGatewayState}
                banner={error !== null}
              />
            ) : (
              // SKILLS / MCP：页面头左端是 `我的 ｜ 发现` 滑槽，右端留给页面自己的动作（PageHeadActions）
              <PageHead
                location
                lead={
                  <FaceTabs value={face} onChange={(face) => navigate((n) => goFace(n, face))} />
                }
              >
                {scopedPages[nav.destination]?.() ?? null}
              </PageHead>
            )}
          </PageGuard>
        </main>
      </div>
      {/* 右下那一叠（DESIGN「浮起小窗的位置」）：不属于任何一处的提示小窗，全应用只有这一套——
        壳自己的（别的页上规则在背后添加了 MCP）在这里，各页的（后台自动规则）经 CornerToast 挂进来 */}
      <ToastStack className="app__toast">
        {backgroundMcpReport && (
          <BackgroundMcpToast report={backgroundMcpReport} onClose={closeMcpToast} />
        )}
      </ToastStack>
      {quit.dialog}
      {/* 反馈小窗挂在壳上（不随页面卸载：发送中切页也不丢草稿与请求）；入口键不在了时成功提示出在右下 */}
      <FeedbackHost />
    </div>
  );
}

/// 窗口顶上的出错横幅（`app` 档灰面板）：一句 + 左端「!」里的原文 + 可选的 `再试一次`（点了先收起横幅再重做）
function FaultBanner({ fault, onClose }: { fault: AppFault; onClose: () => void }) {
  const view = appFaultView(fault);
  const retry = view.retry;
  return (
    <NoticePanel
      scope="app"
      message={view.message}
      technical={view.technical}
      onCopy={(text) => copyDetails(text)}
      action={
        retry && {
          label: retry.label,
          onClick: () => {
            onClose();
            retry.onClick();
          },
        }
      }
      onClose={onClose}
    />
  );
}

/// 停在别的页上时规则在背后添加了 MCP：右下交代一声（⑨⑬ 自动发生的事要交代）；
/// 全成是白窗，有没成的是黑窗。密钥提醒（S19）在原因的位置接一句：来源被忽略的「已加进 .gitignore」，
/// 第一次写进仓库的「密钥会随仓库提交，没加进 .gitignore」（规则上没有勾选，照常写）
function BackgroundMcpToast({ report, onClose }: { report: McpReport; onClose: () => void }) {
  const created = report.entries.filter((e) => e.outcome === "created");
  const failed = report.entries.filter((e) => e.outcome === "failed");
  const names = [...new Set(created.map((e) => e.name))];
  const keyNote = keyHintNote(report, true);
  if (failed.length > 0) {
    return (
      <Toast
        kind="partial"
        sentence="shell.mcpToast.autoAdd"
        names={names}
        tally={{ done: created.length, failed: failed.length }}
        reason={joinReasons(failed[0].message, keyNote)}
        onDismiss={onClose}
        onClose={onClose}
      />
    );
  }
  return (
    <Toast
      kind="success"
      sentence="shell.mcpToast.autoAdd"
      names={names}
      reading={
        names.length === 0 ? <ToastCount n={created.length} line="toast.count.mcp" /> : undefined
      }
      // 第三方模式那一份没写成：成功句后接那一句（`McpReportEntry.mirrorFailed`）
      reason={joinReasons(mirrorFailedNote(report.entries), keyNote)}
      onDismiss={onClose}
    />
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import ModelsTab from "./ModelsTab";
import { SettingsPage } from "./pages/SettingsPage";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { collectIssues } from "./issues";
import {
  mcpNotices,
  modelNotices,
  noticeLine,
  skillNotices,
  unseenNotices,
  type IssueSegment,
} from "./issueNotice";
import { collectMcpIssues, mcpDomains } from "./mcpView";
import { displayPath, loadHome } from "./pathText";
import { relativeTime } from "./dateText";
import {
  loadProjectSort,
  PROJECT_SORTS,
  projectName,
  saveProjectSort,
  sortProjects,
  unionProjects,
  type ProjectSort,
} from "./sidebarProjects";
import { edgeFades, modelIssues } from "./modelsView";
import type { ModelIssue } from "./modelsView";
import {
  AddButton,
  BusySlot,
  ErrorBanner,
  IconButton,
  IconCheck,
  IconClose,
  IconSettings,
  Toast,
  ToastCount,
  ToastStack,
  Tooltip,
} from "./ui";
import { AnimatedWordmark } from "./brand/AnimatedWordmark";
import "./App.css";

/// 侧栏默认落在「全局」。没有「全部」域——多域并排时同名 agent 会出现多列，
/// 选择操作条的片也会重复
const DEFAULT_KEY = "global";
/// 文件系统事件与窗口获得焦点后的重扫去抖
const REFRESH_DELAY = 300;
type Tab = "skills" | "mcp" | "models";

/// 顶栏页签：顺序即高频程度。`Cap` 只给拉丁 run 套 Condensed 大写 + 字距，汉字原样
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "models", label: "模型" },
  { id: "skills", label: "skills" },
  { id: "mcp", label: "mcp" },
];

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  /// 用户发起的写入正在进行：后台重扫排到它结束之后。**不锁页签、不锁项目切换**——
  /// 忙碌只锁触发它的那个控件（DESIGN「反馈的两种形态 › 忙碌」），由各页自己管
  const [busy, setBusy] = useState(false);
  /// 添加 / 移除项目进行中：只锁侧栏的这两处（同一个对象：项目列表）
  const [projectBusy, setProjectBusy] = useState<"add" | "remove" | null>(null);
  const [selectedKey, setSelectedKey] = useState(DEFAULT_KEY);
  const [error, setError] = useState<string | null>(null);
  /// 二级页面：占满整窗、不渲染侧栏。null＝主视图
  const [subPage, setSubPage] = useState<null | "settings">(null);
  /// 启动时后台查一次新版。**必须静默失败**：`plugins.updater.pubkey` 没填之前
  /// check() 一定报错，进横幅的话每次开应用先看见一条错。null＝查过没有 / 没查成
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  /// 模型路由比 skill、MCP 都高频，所以它排第一个 tab，也是启动默认页。
  /// 后端说不支持（非 macOS）时这一页根本不存在，届时退回 Skills，见 applyModelsSupported
  const [activeTab, setActiveTab] = useState<Tab>("models");
  // 「模型」标签页只在后端确认支持（当前只有 macOS）时才出现；读取失败时静默隐藏
  const [modelsSupported, setModelsSupported] = useState(false);
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
  /// 新问题一次性提示的三份原料：skill 扫描（overview）、MCP 扫描、模型状态；外加看过的 key。
  /// 看过表还没读到（null）就不提示——宁可晚一轮，不能把看过的又提示一遍
  const [mcpOverview, setMcpOverview] = useState<McpOverview | null>(null);
  const [gatewayState, setGatewayState] = useState<GatewayState | null>(null);
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  /// 这次运行里点过 `查看` / `×` 的 key：写进 core 之前就发出去的重扫读回来的看过表里还没有它们，
  /// 并进去，免得刚关掉的提示又冒出来
  const markedRef = useRef<Set<string>>(new Set());
  /// 正在显示的提示里的 key（按显示顺序）：新问题合进来时原来的几条排在前面不动
  const shownRef = useRef<string[]>([]);
  /// `查看` 跳过去要聚焦的那一行；那一页处理完回调 onFocused 清回 undefined
  const [focus, setFocus] = useState<{ segment: "skills" | "mcp"; key: string } | undefined>();
  const clearFocus = useCallback(() => setFocus(undefined), []);
  /// `查看`「网关连不上」：要进网关页并选中的那一家
  const [modelFocus, setModelFocus] = useState<string | undefined>();
  const clearModelFocus = useCallback(() => setModelFocus(undefined), []);
  /// 内容区横向滚动的边缘渐隐：左 / 右还有被裁掉的内容时那一边出渐隐
  const contentRef = useRef<HTMLElement>(null);
  const [contentFade, setContentFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => {
      const next = edgeFades(el.scrollLeft, el.clientWidth, el.scrollWidth);
      setContentFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // 窗口变窄、表格长宽（换页签、扫描回来）都会改变能不能横向滚动
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  });
  /// 提示条的到点消失按回调身份计时：必须稳定，否则每次重渲染都重新计时
  const closeMcpToast = useCallback(() => setBackgroundMcpReport(null), []);
  // 监听器只注册一次，用 ref 读当前状态，避免闭包读到旧值
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  /// 正在跑的那一轮后台重扫
  const scanningRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeTabRef = useRef(activeTab);
  busyRef.current = busy;
  activeTabRef.current = activeTab;

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
  /// 新问题的一次性提示是全局的：不论停在哪个页签，三类问题都要认得出来，所以 skill 每次都扫。
  /// MCP 停在 MCP 页时由 McpTab 扫完回传（onOverview），不重复扫；停在别的页签时这里扫一次，
  /// 缓存到下次聚焦 / 文件变化。扫描可能触发已授权的自动规则；界面以重新扫描的实际结果为准。
  ///
  /// 同一时间只跑一轮：扫描中又被叫到，记一个标记、等这一轮连同补扫一起结束再返回——
  /// 调用方 await 回来时拿到的是最新的
  const scanOnce = async () => {
    try {
      const [next, projects, rules, seenList, mcp] = await Promise.all([
        api.scanAll(),
        api.listManualProjects(),
        api.listAutoLinks(),
        // 提示的原料读不到不挡主流程：少提示一次，好过整页报错
        api.listSeenIssues().catch(() => null),
        activeTabRef.current === "mcp" ? Promise.resolve(null) : api.scanMcp().catch(() => null),
      ]);
      setOverview(next);
      setManualProjects(projects);
      setAutoLinks(rules);
      if (seenList !== null) setSeen(new Set([...seenList, ...markedRef.current]));
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

  /// 模型状态只为认出模型类的新问题：后台轻查，不显示忙碌
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
          if (payload.page === "settings") setSubPage("settings");
          if (payload.page === "models") {
            setSubPage(null);
            setActiveTab("models");
          }
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
  }, [requestRefresh, refreshGateway]);

  /// 模型页是默认页，可它在非 macOS 上并不存在：一问出「不支持」就把默认页退回 Skills，
  /// 否则主视图会停在一个既没有标签页也没有内容的空壳上
  const applyModelsSupported = (supported: boolean) => {
    setModelsSupported(supported);
    if (!supported) setActiveTab((tab) => (tab === "models" ? "skills" : tab));
  };

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
        // 读不到就当作不支持，标签页保持隐藏
        if (!cancelled) applyModelsSupported(false);
      });
    // 路径显示把主目录写成 ~：主目录启动时读一次，之后 displayPath 同步可用
    void loadHome();
    // 启动时扫一次：停在模型页也要认得出 Skills 与 MCP 的新问题
    void refresh();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = overview?.domains ?? [];
  // 模型页当前是否真的在显示：还没问出支不支持时按不支持算，落回 Skills（见下方主视图分支）
  const showModels = activeTab === "models" && modelsSupported;
  // 侧栏（DESIGN「侧栏：Skills 与 MCP 共用同一个」）：skill 与 MCP 两边发现的项目 ∪ 手动添加的，
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

  // ===== 新问题只提示一次（DESIGN「没有收件箱、待处理页和「忽略」」） =====
  // 三类扫描结果任一更新都重算：当前问题减去看过的，剩下的进右下那一个黑窗
  const skillIssues = useMemo(() => collectIssues(overview), [overview]);
  const mcpIssues = useMemo(() => collectMcpIssues(mcpOverview), [mcpOverview]);
  const modelIssueList: ModelIssue[] = useMemo(
    () => (modelsSupported ? modelIssues(gatewayState) : []),
    [gatewayState, modelsSupported],
  );
  const notice = useMemo(
    () =>
      seen === null
        ? []
        : unseenNotices(
            [
              ...skillNotices(skillIssues),
              ...mcpNotices(mcpIssues),
              ...modelNotices(modelIssueList),
            ],
            seen,
            shownRef.current,
          ),
    [skillIssues, mcpIssues, modelIssueList, seen],
  );
  useEffect(() => {
    shownRef.current = notice.map((issue) => issue.key);
  }, [notice]);
  const noticeText = noticeLine(notice);

  /// `查看` 与 `×` 都把这次提示里的全部 key 记为看过。先在本地记上、提示立刻收起；
  /// 写进 core 没成就报出来——下次启动它会再提示一次
  const markNoticeSeen = () => {
    const keys = notice.map((issue) => issue.key);
    if (keys.length === 0) return;
    for (const key of keys) markedRef.current.add(key);
    setSeen((prev) => new Set([...(prev ?? []), ...keys]));
    void api.markIssuesSeen(keys).catch((e) => setError(String(e)));
  };

  /// `查看`：跳到第一条所在的页签和侧栏位置，滚到那一行并闪两下
  const viewNotice = () => {
    const first = notice[0];
    if (first === undefined) return;
    markNoticeSeen();
    jumpToRow(first.segment, first.key);
  };

  // 选中的项目从侧栏消失（移除了、不再存在）时回落到「全局」。列表是两边的并集，与页签无关
  useEffect(() => {
    if (!overview) return;
    if (selectedKey !== DEFAULT_KEY && !projects.some((p) => p.key === selectedKey)) {
      setSelectedKey(DEFAULT_KEY);
    }
  }, [overview, projects, selectedKey]);

  const switchTab = (tab: Tab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    // 切回 Skills 时显式重扫；MCP 页由自身 refreshKey 驱动扫描
    if (tab === "skills") void refresh();
  };

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

  const removeProject = async (path: string) => {
    setProjectBusy("remove");
    setBusyState(true);
    try {
      await api.removeProject(path);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyState(false);
      setProjectBusy(null);
    }
  };

  /// 从设置页返回：重扫一次，因为设置改了 agent 的启用
  const closeSubPage = () => {
    setSubPage(null);
    void refresh();
    refreshGateway();
  };

  /// 跳到一条问题所在的那一行：切到对应页签；这一条属于别的域就先切侧栏；再把 key 交给那一页，
  /// 它滚到那一行并闪两下，处理完回调 onFocused 清掉（下次跳同一条才会再触发）
  const jumpToRow = (segment: IssueSegment, key: string) => {
    setSubPage(null);
    if (segment === "models") {
      if (!modelsSupported) return;
      switchTab("models");
      // 「网关连不上」那一条：进网关二级页、选中那一家；别的类别只切到模型页
      const providerId = modelIssueList.find((i) => i.key === key)?.providerId;
      if (providerId !== undefined) setModelFocus(providerId);
      refreshGateway();
      return;
    }
    const domain = segment === "mcp" ? mcpDomainOf(key) : skillDomainOf(key);
    switchTab(segment);
    if (domain !== null) setSelectedKey(domain);
    setFocus({ segment, key });
  };

  /// skill 问题属于哪个域：当前侧栏选中的域里有就留在这儿，否则取第一个有它的域
  const skillDomainOf = (key: string): string | null => {
    const hit = (d: { key: string }) =>
      collectIssues(
        overview,
        domains.filter((x) => x.key === d.key),
      ).some((i) => i.key === key);
    if (domains.some((d) => d.key === selectedKey && hit(d))) return selectedKey;
    return domains.find(hit)?.key ?? null;
  };

  const mcpDomainOf = (key: string): string | null =>
    mcpIssues.find((i) => i.key === key)?.domain ?? null;

  if (subPage === "settings") {
    return <SettingsPage onBack={closeSubPage} onError={setError} initialUpdate={pendingUpdate} />;
  }

  return (
    <div className="app">
      {/* 顶栏独立于侧栏：模型页不要侧栏，字标与页签不能跟着一起消失。
        系统标题栏隐藏了（DESIGN「壳」），顶栏自己当标题栏：整条可拖动，上面 28 给红绿灯 */}
      <header className="topbar" data-tauri-drag-region>
        {/* 字标用资产不用纯文本：首字母的重影是这个标志的识别点；
          悬停唤起黑猫、点击敲碎玻璃（DESIGN「壳」） */}
        <h1 className="topbar__mark">
          <AnimatedWordmark />
        </h1>
        <nav className="topbar__tabs" aria-label="功能">
          {TABS.filter((tab) => tab.id !== "models" || modelsSupported).map((tab) => {
            const active = tab.id === "models" ? showModels : activeTab === tab.id && !showModels;
            return (
              <button
                key={tab.id}
                type="button"
                className={`topbar__tab${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => switchTab(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
        {/* 右端只有设置；页签上不加计数（问题就地显示，新问题右下提示一次）。
          **顶栏没有全局忙碌指示**：后台例行读取（刷新、文件监听重扫、网关轮询）
          不显示忙碌，用户没在等，出现转动只会被读成出了问题（DESIGN「忙碌指示」）。
          写入进行中也不锁页签与项目切换：忙碌只锁触发它的那个控件 */}
        <div className="topbar__end">
          <IconButton icon={<IconSettings />} title="设置" onClick={() => setSubPage("settings")} />
        </div>
      </header>
      {/* 模型页是全局的，没有域也没有项目，侧栏对它没有意义（MODELS_TAB_FULL_BLEED）。
        **必须整个不渲染**：`.sidebar` 有 `display: flex`，它压得过 `hidden` 属性的
        UA 样式，写成 `hidden={…}` 侧栏照样显示 */}
      {!showModels && (
        <aside className="sidebar">
          {/* 小标题 `项目` + 右端排序下拉；`全局` 固定第一，不参与排序 */}
          <div className="sidebar__head">
            <span className="sidebar__label">项目</span>
            <SortMenu value={projectSort} onChange={chooseSort} />
          </div>
          <ul className="sidebar__list">
            <li
              className={selectedKey === DEFAULT_KEY ? "is-active" : ""}
              onClick={() => setSelectedKey(DEFAULT_KEY)}
            >
              <span className="sidebar__name">全局</span>
            </li>
            {sortedProjects.map((p) => (
              <li
                key={p.key}
                className={p.key === selectedKey ? "is-active" : ""}
                onClick={() => setSelectedKey(p.key)}
              >
                <SidebarName
                  label={p.label}
                  path={p.path}
                  lastActive={projectTimes.get(p.path)?.lastActive ?? null}
                />
                {p.manual && (
                  <RemoveProject
                    busy={projectBusy !== null}
                    name={p.label}
                    onRemove={() => void removeProject(p.path)}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="sidebar__foot">
            <BusySlot busy={projectBusy === "add"} label="正在添加项目">
              <AddButton
                noun="项目"
                disabledReason={projectBusy === "remove" ? "正在移除项目，稍等" : undefined}
                onClick={() => void addProject()}
              />
            </BusySlot>
          </div>
        </aside>
      )}
      {/* 内容区外面包一层：表格横向放不下时，被裁掉的左 / 右边缘出 16px 渐隐（DESIGN「渐变只用于功能」） */}
      <div
        className="content-shell"
        data-fade-left={contentFade.start || undefined}
        data-fade-right={contentFade.end || undefined}
      >
        <main ref={contentRef} className={showModels ? "content content--bleed" : "content"}>
          {error && (
            <div className="content__banner">
              <ErrorBanner message={error} onClose={() => setError(null)} />
            </div>
          )}
          {/* 还没问出模型页支不支持的那一瞬间也落在 Skills 上：宁可闪一下扫描中，不能白屏 */}
          {showModels ? (
            <ModelsTab
              onError={setError}
              onGatewayState={setGatewayState}
              focusProviderId={modelFocus}
              onFocused={clearModelFocus}
            />
          ) : activeTab === "mcp" ? (
            <McpTab
              selectedKey={selectedKey}
              onError={setError}
              onBusy={setBusyState}
              refreshKey={refreshKey}
              onOverview={setMcpOverview}
              focusKey={focus?.segment === "mcp" ? focus.key : undefined}
              onFocused={clearFocus}
            />
          ) : (
            <SkillsTab
              overview={overview}
              autoLinks={autoLinks}
              onBusy={setBusyState}
              selectedKey={selectedKey}
              onRefresh={refresh}
              onError={setError}
              focusKey={focus?.segment === "skills" ? focus.key : undefined}
              onFocused={clearFocus}
            />
          )}
        </main>
      </div>
      {/* 右下那一叠（DESIGN「浮起小窗的位置」）：不属于任何一处的提示小窗，全应用只有这一套——
        壳自己的两种在这里，各页的（后台自动规则）经 CornerToast 挂进来 */}
      <ToastStack className="app__toast">
        {backgroundMcpReport && (
          <BackgroundMcpToast report={backgroundMcpReport} onClose={closeMcpToast} />
        )}
        {/* 新问题只提示一次：不自动消失，`查看` 或 `×` 才收起并记为看过；
          已有提示时又发现新问题，合进这一个窗（改计数），不叠第二个 */}
        {noticeText && (
          <Toast
            kind="attention"
            verb={noticeText.lead}
            reading={noticeText.rest}
            action={{ label: "查看", onClick: viewNotice }}
            onClose={markNoticeSeen}
          />
        )}
      </ToastStack>
    </div>
  );
}

/// 侧栏项目名：放不下截断；提示框给完整路径（主目录写成 ~）和「活跃于 3 天前」。
/// 时间不写在侧栏上（DESIGN：侧栏只放名字）
function SidebarName({
  label,
  path,
  lastActive,
}: {
  label: string;
  path: string;
  lastActive: number | null;
}) {
  const tip = (
    <>
      {displayPath(path)}
      {lastActive !== null && (
        <>
          <br />
          活跃于 {relativeTime(lastActive)}
        </>
      )}
    </>
  );
  return (
    <Tooltip content={tip}>
      <span className="sidebar__name">{label}</span>
    </Tooltip>
  );
}

/// 小标题行右端的排序下拉：`最近活跃 ▾`，点开两项的小浮层，当前项前打 ✓。
/// 浮层与模型选择器同一写法（layer 圆角 + 浮层阴影）；点外面、按 Esc 关闭，不铺透明罩
function SortMenu({
  value,
  onChange,
}: {
  value: ProjectSort;
  onChange: (sort: ProjectSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrap.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);
  const current = PROJECT_SORTS.find((s) => s.id === value) ?? PROJECT_SORTS[0];
  return (
    <span ref={wrap} className="sidebar__sort">
      <button
        ref={button}
        type="button"
        className="sidebar__sort-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {current.label} ▾
      </button>
      {open && (
        <div className="sidebar__sort-menu" role="menu" aria-label="项目排序">
          {PROJECT_SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={s.id === value}
              className="sidebar__sort-item"
              onClick={() => {
                onChange(s.id);
                setOpen(false);
              }}
            >
              <span className="sidebar__sort-check">
                {s.id === value && <IconCheck size={12} />}
              </span>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/// 侧栏里手动添加的项目才有移除键：16px ×，行内右端
function RemoveProject({
  busy,
  name,
  onRemove,
}: {
  busy: boolean;
  name: string;
  onRemove: () => void;
}) {
  return (
    <span className="sidebar__remove" onClick={(e) => e.stopPropagation()}>
      <IconButton
        icon={<IconClose />}
        title={`从侧栏移除 ${name}（不动磁盘上的文件）`}
        disabledReason={busy ? "正在读取，稍等" : undefined}
        onClick={onRemove}
      />
    </span>
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

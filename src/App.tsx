import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import type {
  AutoLink,
  GatewayState,
  IgnoredIssue,
  McpOverview,
  McpReport,
  Overview,
} from "./types";
import SkillsTab from "./SkillsTab";
import McpTab from "./McpTab";
import ModelsTab from "./ModelsTab";
import { SettingsPage } from "./pages/SettingsPage";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { PendingPage, loadModelIgnoredKeys, type PendingSegment } from "./pages/PendingPage";
import { collectIssues } from "./pages/pendingIssues";
import { collectMcpIssues } from "./mcpView";
import { displayPath, loadHome } from "./pathText";
import { modelIssues, parseBackendError } from "./modelsView";
import type { ModelIssue } from "./modelsView";
import {
  AddButton,
  Cap,
  ErrorBanner,
  IconButton,
  IconClose,
  IconInbox,
  IconSettings,
  Toast,
  Tooltip,
} from "./ui";
import wordmark from "../assets/logo/wordmark.svg";
import "./App.css";

/// 侧栏默认落在「全局」。没有「全部」域——多域并排时同名 agent 会出现多列，
/// 选择操作条的片也会重复；跨域批量的事走待处理页
const DEFAULT_KEY = "global";
/// 文件系统事件与窗口获得焦点后的重扫去抖
const REFRESH_DELAY = 300;
type SidebarDomain = { key: string; label: string };
type Tab = "skills" | "mcp" | "models";

/// 顶栏页签：顺序即高频程度。`Cap` 只给拉丁 run 套 Condensed 大写 + 字距，汉字原样
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "models", label: "模型" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
];

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState(DEFAULT_KEY);
  const [error, setError] = useState<string | null>(null);
  /// 二级页面：占满整窗、不渲染侧栏。null＝主视图
  const [subPage, setSubPage] = useState<null | "settings" | "pending">(null);
  /// 待处理页打开时落在哪一段：从哪个页签进就落在哪段（全局收件箱，DESIGN「材料与工艺」）
  const [pendingSegment, setPendingSegment] = useState<Tab>("skills");
  /// 启动时后台查一次新版。**必须静默失败**：`plugins.updater.pubkey` 没填之前
  /// check() 一定报错，进横幅的话每次开应用先看见一条错。null＝查过没有 / 没查成
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  /// 模型路由比 skill、MCP 都高频，所以它排第一个 tab，也是启动默认页。
  /// 后端说不支持（非 macOS）时这一页根本不存在，届时退回 Skills，见 applyModelsSupported
  const [activeTab, setActiveTab] = useState<Tab>("models");
  // 「模型」标签页只在后端确认支持（当前只有 macOS）时才出现；读取失败时静默隐藏
  const [modelsSupported, setModelsSupported] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 手动添加的项目路径，用来判断侧栏哪些域可以移除
  const [manualProjects, setManualProjects] = useState<string[]>([]);
  // 自动同步规则；扫描时顺带取回，域页与添加页都用它
  const [autoLinks, setAutoLinks] = useState<AutoLink[]>([]);
  // MCP 扫描到的域独立于 skills；例如没有 skill 的 WeiboAP agent 也能在 MCP 页选择。
  const [mcpSidebarDomains, setMcpSidebarDomains] = useState<SidebarDomain[]>([]);
  const [backgroundMcpReport, setBackgroundMcpReport] = useState<McpReport | null>(null);
  /// 收件箱计数的三份原料：skill 扫描（overview）、MCP 扫描、模型状态；外加已忽略的 key
  const [mcpOverview, setMcpOverview] = useState<McpOverview | null>(null);
  const [gatewayState, setGatewayState] = useState<GatewayState | null>(null);
  const [ignored, setIgnored] = useState<IgnoredIssue[]>([]);
  /// 待处理页跳回来要聚焦的那一行；那一页处理完回调 onFocused 清回 undefined
  const [focus, setFocus] = useState<{ segment: "skills" | "mcp"; key: string } | undefined>();
  const clearFocus = useCallback(() => setFocus(undefined), []);
  /// 模型页跳回：要进网关页并选中的那一家
  const [modelFocus, setModelFocus] = useState<string | undefined>();
  const clearModelFocus = useCallback(() => setModelFocus(undefined), []);
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
  /// 顶栏收件箱是全局入口：不论停在哪个页签，三段都要数得出来，所以 skill 每次都扫。
  /// MCP 停在 MCP 页时由 McpTab 扫完回传（onOverview），不重复扫；停在别的页签时这里扫一次，
  /// 缓存到下次聚焦 / 文件变化。扫描可能触发已授权的自动规则；界面以重新扫描的实际结果为准。
  ///
  /// 同一时间只跑一轮：扫描中又被叫到，记一个标记、等这一轮连同补扫一起结束再返回——
  /// 调用方 await 回来时拿到的是最新的
  const scanOnce = async () => {
    try {
      const [next, projects, rules, ignoredList, mcp] = await Promise.all([
        api.scanAll(),
        api.listManualProjects(),
        api.listAutoLinks(),
        // 计数的原料读不到不挡主流程：少数一个数字，好过整页报错
        api.listIgnored().catch(() => null),
        activeTabRef.current === "mcp" ? Promise.resolve(null) : api.scanMcp().catch(() => null),
      ]);
      setOverview(next);
      setManualProjects(projects);
      setAutoLinks(rules);
      if (ignoredList !== null) setIgnored(ignoredList);
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

  /// 模型状态只为数「模型」段：后台轻查，不显示忙碌
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
    // 菜单栏面板改了模型状态，收件箱的「模型」段跟着重数
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
    // 启动时扫一次：停在模型页也要数得出 Skills 与 MCP 两段
    void refresh();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = overview?.domains ?? [];
  // 模型页当前是否真的在显示：还没问出支不支持时按不支持算，落回 Skills（见下方主视图分支）
  const showModels = activeTab === "models" && modelsSupported;
  const sidebarDomains =
    activeTab === "mcp" ? mcpSidebarDomains : activeTab === "models" ? [] : domains;
  // 域 key → 手动项目路径；自动发现的项目与 agent 域不在其中，因此没有移除按钮
  const manualByKey = new Map(manualProjects.map((p) => [`project:${p}`, p]));

  // ===== 全局收件箱：三段未处理之和 =====
  // 三段原样交给待处理页（含已忽略的，页面自己按忽略表滤）；顶栏数字扣掉已忽略的
  const ignoredKeys = useMemo(() => new Set(ignored.map((i) => i.key)), [ignored]);
  const skillIssues = useMemo(() => collectIssues(overview), [overview]);
  const mcpIssues = useMemo(() => collectMcpIssues(mcpOverview), [mcpOverview]);
  const modelIssueList: ModelIssue[] = useMemo(
    () => (modelsSupported ? modelIssues(gatewayState) : []),
    [gatewayState, modelsSupported],
  );
  // 模型段的忽略不进 core，由待处理页记在本机；回到主视图时（subPage 变了）重读一次
  const modelIgnoredKeys = useMemo(
    () => new Set(loadModelIgnoredKeys()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subPage],
  );
  const inboxCount =
    skillIssues.filter((i) => !ignoredKeys.has(i.key)).length +
    mcpIssues.filter((i) => !ignoredKeys.has(i.key)).length +
    modelIssueList.filter((i) => !modelIgnoredKeys.has(i.key)).length;

  const updateMcpSidebarDomains = useCallback((next: SidebarDomain[]) => {
    setMcpSidebarDomains((previous) =>
      previous.length === next.length &&
      previous.every(
        (domain, index) => domain.key === next[index].key && domain.label === next[index].label,
      )
        ? previous
        : next,
    );
  }, []);

  // 选中的域消失（项目不再存在）时回落到「全部」。MCP 首次扫描前不清掉选择，
  // 否则没有 skill 的 agent 域会在它的 MCP 位置返回前被错误地重置。
  useEffect(() => {
    if (activeTab === "mcp") {
      if (
        mcpSidebarDomains.length > 0 &&
        !mcpSidebarDomains.some((domain) => domain.key === selectedKey)
      ) {
        setSelectedKey(mcpSidebarDomains[0].key);
      }
      return;
    }
    if (activeTab === "models") return;
    if (!overview) return;
    const manualProjectKeys = new Set(manualProjects.map((p) => `project:${p}`));
    if (
      selectedKey !== DEFAULT_KEY &&
      !domains.some((d) => d.key === selectedKey) &&
      !manualProjectKeys.has(selectedKey)
    ) {
      setSelectedKey(DEFAULT_KEY);
    }
  }, [activeTab, overview, manualProjects, selectedKey, domains, mcpSidebarDomains]);

  const switchTab = (tab: Tab) => {
    if (tab === activeTab) return;
    // 新一轮 MCP 扫描返回前，不用上次的域去重置当前选择
    if (tab === "mcp") setMcpSidebarDomains([]);
    setActiveTab(tab);
    // 切回 Skills 时显式重扫；MCP 页由自身 refreshKey 驱动扫描
    if (tab === "skills") void refresh();
  };

  const addProject = async () => {
    const path = await api.pickDirectory("选择项目目录");
    if (!path) return;
    // 用户发起、正在等：锁它影响到的控件（侧栏与页签），做完解锁
    setBusyState(true);
    try {
      await api.addProject(path);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyState(false);
    }
  };

  const removeProject = async (path: string) => {
    setBusyState(true);
    try {
      await api.removeProject(path);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyState(false);
    }
  };

  /// 从二级页面返回：重扫一次，因为设置改了 agent 的启用、待处理页改了磁盘
  const closeSubPage = () => {
    setSubPage(null);
    void refresh();
    refreshGateway();
  };

  /// 收件箱：全局一个入口，打开时落在当前页签那一段
  const openInbox = () => {
    setPendingSegment(showModels ? "models" : activeTab === "mcp" ? "mcp" : "skills");
    setSubPage("pending");
  };

  /// 待处理页「跳回」：切到对应页签；这一条属于别的域就先切侧栏；再把 key 交给那一页，
  /// 它滚到那一行并闪一下，处理完回调 onFocused 清掉（下次跳同一条才会再触发）
  const jumpToRow = (segment: PendingSegment, key: string) => {
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

  /// skill 待处理属于哪个域：当前侧栏选中的域里有就留在这儿，否则取第一个有它的域
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

  /// 待处理页「模型」段的动作：照 `ModelIssue.action.kind` 调对应命令，做完重数。
  /// 失败原样抛给页面，由它贴在那一行上说
  const resolveModelIssue = async (issue: ModelIssue): Promise<void> => {
    try {
      const next =
        issue.action.kind === "takeover"
          ? await api.gatewayTakeover()
          : issue.action.kind === "rewrite"
            ? await api.gatewayEnable()
            : await api.gatewayRetryProvider(issue.providerId ?? "");
      setGatewayState(next);
    } catch (e) {
      throw new Error(parseBackendError(String(e)).message);
    }
  };

  if (subPage === "settings") {
    return <SettingsPage onBack={closeSubPage} onError={setError} initialUpdate={pendingUpdate} />;
  }
  if (subPage === "pending") {
    return (
      <PendingPage
        segments={{ skills: skillIssues, mcp: mcpIssues, models: modelIssueList }}
        initialSegment={pendingSegment}
        onBack={closeSubPage}
        onRefresh={refresh}
        onError={setError}
        onJumpToRow={jumpToRow}
        onResolveModelIssue={resolveModelIssue}
      />
    );
  }

  return (
    <div className="app">
      {/* 顶栏独立于侧栏：模型页不要侧栏，字标与页签不能跟着一起消失。
          系统标题栏隐藏了（DESIGN「壳」），顶栏自己当标题栏：整条可拖动，上面 28 给红绿灯 */}
      <header className="topbar" data-tauri-drag-region>
        {/* 字标用资产不用纯文本：首字母的重影是这个标志的识别点（DESIGN「壳」） */}
        <h1 className="topbar__mark">
          <img src={wordmark} alt="Sophia" className="wordmark" />
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
                disabled={busy}
                onClick={() => switchTab(tab.id)}
              >
                <Cap tone="nav">{tab.label}</Cap>
              </button>
            );
          })}
        </nav>
        {/* 右端：收件箱（三段未处理之和，0 时无数字、图标常驻）+ 设置。
            **顶栏没有全局忙碌指示**：后台例行读取（刷新、文件监听重扫、网关轮询、收件箱计数）
            不显示忙碌，用户没在等，出现转动只会被读成出了问题（DESIGN「忙碌指示」）。
            设置是全局的，busy 期间照常可用 */}
        <div className="topbar__end">
          <IconButton icon={<IconInbox />} title="待处理" count={inboxCount} onClick={openInbox} />
          <IconButton icon={<IconSettings />} title="设置" onClick={() => setSubPage("settings")} />
        </div>
      </header>
      {/* 模型页是全局的，没有域也没有项目，侧栏对它没有意义（MODELS_TAB_FULL_BLEED）。
          **必须整个不渲染**：`.sidebar` 有 `display: flex`，它压得过 `hidden` 属性的
          UA 样式，写成 `hidden={…}` 侧栏照样显示 */}
      {!showModels && (
        <aside className="sidebar">
          <div className="sidebar__label">位置</div>
          <ul className="sidebar__list">
            {!sidebarDomains.some((d) => d.key === "global") && (
              <li
                className={selectedKey === "global" ? "is-active" : ""}
                onClick={() => !busy && setSelectedKey("global")}
              >
                <span className="sidebar__name">全局</span>
              </li>
            )}
            {sidebarDomains.map((d) => {
              const manualPath = manualByKey.get(d.key);
              return (
                <li
                  key={d.key}
                  className={d.key === selectedKey ? "is-active" : ""}
                  onClick={() => !busy && setSelectedKey(d.key)}
                >
                  <SidebarName label={d.label} domainKey={d.key} />
                  {manualPath !== undefined && (
                    <RemoveProject
                      busy={busy}
                      name={d.label}
                      onRemove={() => void removeProject(manualPath)}
                    />
                  )}
                </li>
              );
            })}
            {activeTab === "skills" &&
              manualProjects
                .filter((path) => !domains.some((d) => d.key === `project:${path}`))
                .map((path) => {
                  const key = `project:${path}`;
                  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
                  return (
                    <li
                      key={key}
                      className={key === selectedKey ? "is-active" : ""}
                      onClick={() => !busy && setSelectedKey(key)}
                    >
                      <SidebarName label={name} domainKey={key} />
                      <RemoveProject
                        busy={busy}
                        name={name}
                        onRemove={() => void removeProject(path)}
                      />
                    </li>
                  );
                })}
          </ul>
          <div className="sidebar__foot">
            <AddButton
              noun="项目"
              disabledReason={busy ? "正在读取，稍等" : undefined}
              onClick={() => void addProject()}
            />
          </div>
        </aside>
      )}
      <main className={showModels ? "content content--bleed" : "content"}>
        {error && (
          <div className="content__banner">
            <ErrorBanner message={error} onClose={() => setError(null)} />
          </div>
        )}
        {/* 还没问出模型页支不支持的那一瞬间也落在 Skills 上：宁可闪一下扫描中，不能白屏 */}
        {showModels ? (
          <ModelsTab
            onError={setError}
            busy={busy}
            onBusy={setBusyState}
            onGatewayState={setGatewayState}
            focusProviderId={modelFocus}
            onFocused={clearModelFocus}
          />
        ) : activeTab === "mcp" ? (
          <McpTab
            selectedKey={selectedKey}
            onError={setError}
            busy={busy}
            onBusy={setBusyState}
            refreshKey={refreshKey}
            onDomains={updateMcpSidebarDomains}
            onOverview={setMcpOverview}
            focusKey={focus?.segment === "mcp" ? focus.key : undefined}
            onFocused={clearFocus}
          />
        ) : (
          <SkillsTab
            overview={overview}
            autoLinks={autoLinks}
            busy={busy}
            onBusy={setBusyState}
            selectedKey={selectedKey}
            onRefresh={refresh}
            onError={setError}
            onOpenPending={openInbox}
            focusKey={focus?.segment === "skills" ? focus.key : undefined}
            onFocused={clearFocus}
          />
        )}
      </main>
      {backgroundMcpReport && (
        <div className="app__toast">
          <BackgroundMcpToast report={backgroundMcpReport} onClose={closeMcpToast} />
        </div>
      )}
    </div>
  );
}

/// 侧栏项目名：放不下截断，提示框给出完整路径（主目录写成 ~）；不是项目的域只写名字
function SidebarName({ label, domainKey }: { label: string; domainKey: string }) {
  const name = <span className="sidebar__name">{label}</span>;
  if (!domainKey.startsWith("project:")) return name;
  return <Tooltip content={displayPath(domainKey.slice("project:".length))}>{name}</Tooltip>;
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

/// 停在别的页签时规则在背后添加了 MCP：黑窗提示条交代一声（⑨⑬ 自动发生的事要交代）
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
      reading={names.length === 0 ? `${created.length} 个` : undefined}
      onDismiss={onClose}
      onClose={onClose}
    />
  );
}

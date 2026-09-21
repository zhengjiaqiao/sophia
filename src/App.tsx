import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import type { AutoLink, McpReport, Overview } from "./types";
import SkillsTab from "./SkillsTab";
import McpTab from "./McpTab";
import ModelsTab from "./ModelsTab";
import { SettingsPage } from "./pages/SettingsPage";
import { PendingPage } from "./pages/PendingPage";
import "./App.css";

/// 侧栏默认落在「全局」。没有「全部」域——多域并排时同名 agent 会出现多列，
/// 选择操作条的片也会重复；跨域批量的事走待处理页
const DEFAULT_KEY = "global";
/// 文件系统事件与窗口获得焦点后的重扫去抖
const REFRESH_DELAY = 300;
type SidebarDomain = { key: string; label: string };

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState(DEFAULT_KEY);
  const [error, setError] = useState<string | null>(null);
  /// 二级页面（§4.6）：占满整窗、不渲染侧栏。null＝主视图
  const [subPage, setSubPage] = useState<null | "settings" | "pending">(null);
  const [activeTab, setActiveTab] = useState<"skills" | "mcp" | "models">("skills");
  // 「模型」标签页只在后端确认支持（当前只有 macOS）时才出现；读取失败时静默隐藏
  const [modelsSupported, setModelsSupported] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 手动添加的项目路径，用来判断侧栏哪些域可以移除
  const [manualProjects, setManualProjects] = useState<string[]>([]);
  // 自动同步规则；扫描时顺带取回，域页与引入弹层都用它
  const [autoLinks, setAutoLinks] = useState<AutoLink[]>([]);
  // MCP 扫描到的域独立于 skills；例如没有 skill 的 WeiboAP agent 也能在 MCP 页选择。
  const [mcpSidebarDomains, setMcpSidebarDomains] = useState<SidebarDomain[]>([]);
  const [backgroundMcpReport, setBackgroundMcpReport] = useState<McpReport | null>(null);
  // 监听器只注册一次，用 ref 读当前状态，避免闭包读到旧值
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
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

  // 扫描可能触发已授权的自动规则；界面始终以重新扫描的实际结果为准。
  const refresh = async () => {
    busyRef.current = true;
    setBusy(true);
    try {
      const [next, projects, rules] = await Promise.all([
        activeTab === "skills" ? api.scanAll() : Promise.resolve(overview),
        api.listManualProjects(),
        activeTab === "skills" ? api.listAutoLinks() : Promise.resolve(autoLinks),
      ]);
      if (next !== null) setOverview(next);
      setManualProjects(projects);
      setAutoLinks(rules);
      setRefreshKey((key) => key + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    // 扫描期间到达的事件只记一个标记，扫完再补一次
    if (pendingRef.current) {
      pendingRef.current = false;
      await refresh();
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // 文件系统变化与窗口获得焦点都走这里：忙则排队，闲则去抖后重扫
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
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const collect = (pending: Promise<() => void>) => {
      void pending.then((un) => (disposed ? un() : unlistens.push(un)));
    };
    collect(listen("fs-changed", () => requestRefresh()));
    collect(
      listen<McpReport>("mcp-auto-imported", ({ payload }) => {
        // MCP 页有自己的结果框；停留在 Skills 页时也不能丢掉自动引入结果。
        if (activeTabRef.current === "skills") setBackgroundMcpReport(payload);
      }),
    );
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
      getCurrentWindow().onFocusChanged(({ payload: focused }) => focused && requestRefresh()),
    );
    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [requestRefresh]);

  useEffect(() => {
    let cancelled = false;
    void api
      .gatewayState()
      .then((state) => {
        if (!cancelled) setModelsSupported(state.supported);
      })
      .catch(() => {
        // 读不到就当作不支持，标签页保持隐藏
        if (!cancelled) setModelsSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const domains = overview?.domains ?? [];
  const sidebarDomains =
    activeTab === "mcp" ? mcpSidebarDomains : activeTab === "models" ? [] : domains;
  // 域 key → 手动项目路径；自动发现的项目与 agent 域不在其中，因此没有移除按钮
  const manualByKey = new Map(manualProjects.map((p) => [`project:${p}`, p]));

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

  useEffect(() => {
    if (activeTab === "skills") void refresh();
    // 切回 Skills 时显式重扫；MCP 页由自身 refreshKey 驱动扫描。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const addProject = async () => {
    const path = await api.pickDirectory("选择项目目录");
    if (!path) return;
    try {
      await api.addProject(path);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeProject = async (path: string) => {
    try {
      await api.removeProject(path);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  /// 从二级页面返回：重扫一次，因为设置改了 agent 的启用、待处理页改了磁盘
  const closeSubPage = () => {
    setSubPage(null);
    void refresh();
  };

  if (subPage === "settings") {
    return <SettingsPage onBack={closeSubPage} onError={setError} />;
  }
  if (subPage === "pending") {
    return (
      <PendingPage
        overview={overview}
        onBack={closeSubPage}
        onRefresh={refresh}
        onError={setError}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>SymSync</h1>
        <nav aria-label="功能" style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          <button
            className={activeTab === "skills" ? "active" : ""}
            disabled={busy}
            onClick={() => setActiveTab("skills")}
          >
            Skills
          </button>
          <button
            className={activeTab === "mcp" ? "active" : ""}
            disabled={busy}
            onClick={() => {
              if (activeTab === "mcp") return;
              // 新一轮 MCP 扫描返回前，不用上次的域去重置当前选择。
              setMcpSidebarDomains([]);
              setActiveTab("mcp");
            }}
          >
            MCP
          </button>
          {modelsSupported && (
            <button
              className={activeTab === "models" ? "active" : ""}
              disabled={busy}
              onClick={() => setActiveTab("models")}
            >
              模型
            </button>
          )}
        </nav>
        <ul>
          {!sidebarDomains.some((d) => d.key === "global") && (
            <li
              className={selectedKey === "global" ? "active" : ""}
              title="全局"
              onClick={() => !busy && setSelectedKey("global")}
            >
              <span>全局</span>
            </li>
          )}
          {sidebarDomains.map((d) => {
            const manualPath = manualByKey.get(d.key);
            return (
              <li
                key={d.key}
                className={d.key === selectedKey ? "active" : ""}
                title={d.key}
                onClick={() => !busy && setSelectedKey(d.key)}
              >
                <span>{d.label}</span>
                {manualPath !== undefined && (
                  <button
                    className="link remove"
                    title="移除项目"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeProject(manualPath);
                    }}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
          {activeTab === "skills" &&
            manualProjects
              .filter((path) => !domains.some((d) => d.key === `project:${path}`))
              .map((path) => {
                const key = `project:${path}`;
                return (
                  <li
                    key={key}
                    className={key === selectedKey ? "active" : ""}
                    title={key}
                    onClick={() => !busy && setSelectedKey(key)}
                  >
                    <span>{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span>
                    <button
                      className="link remove"
                      title="移除项目"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeProject(path);
                      }}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
        </ul>
        <button disabled={busy} onClick={() => void addProject()}>
          添加项目…
        </button>
        <button onClick={() => setSubPage("settings")}>设置</button>
      </aside>
      <main className="content">
        {error && (
          <div className="error">
            {error}
            <button className="link" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {activeTab === "skills" ? (
          <SkillsTab
            overview={overview}
            autoLinks={autoLinks}
            busy={busy}
            onBusy={setBusyState}
            selectedKey={selectedKey}
            onRefresh={refresh}
            onError={setError}
            onOpenPending={() => setSubPage("pending")}
          />
        ) : activeTab === "mcp" ? (
          <McpTab
            selectedKey={selectedKey}
            onError={setError}
            busy={busy}
            onBusy={setBusyState}
            refreshKey={refreshKey}
            onDomains={updateMcpSidebarDomains}
          />
        ) : (
          <ModelsTab onError={setError} busy={busy} onBusy={setBusyState} />
        )}
      </main>
      {backgroundMcpReport && (
        <div className="floating">
          <div className="report">
            <div className="report-head">
              <strong>MCP 自动引入结果</strong>
              <button className="link" onClick={() => setBackgroundMcpReport(null)}>
                关闭
              </button>
            </div>
            <ul>
              {backgroundMcpReport.entries.map((entry, index) => (
                <li key={`${entry.targetId}|${entry.name}|${index}`}>
                  {entry.name}：{entry.message}
                  {entry.backupPath && `（备份：${entry.backupPath}）`}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

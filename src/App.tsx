import { useEffect, useState } from "react";
import { api } from "./api";
import type { Overview } from "./types";
import SkillsTab from "./SkillsTab";
import CustomSyncTab from "./CustomSyncTab";
import SettingsPanel from "./SettingsPanel";
import "./App.css";

/// 侧栏「全部」的选中键；其余为 DomainPage.key
const ALL_KEY = "all";

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState(ALL_KEY);
  const [tab, setTab] = useState<"skills" | "custom">("skills");
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 手动添加的项目路径，用来判断侧栏哪些域可以移除
  const [manualProjects, setManualProjects] = useState<string[]>([]);

  // 扫描是纯读操作；任何写动作之后重新扫描，而不是在前端改状态
  const refresh = async () => {
    setBusy(true);
    try {
      const [next, projects] = await Promise.all([api.scanAll(), api.listManualProjects()]);
      setOverview(next);
      setManualProjects(projects);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    // 首次加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domains = overview?.domains ?? [];
  // 域 key → 手动项目路径；自动发现的项目与 agent 域不在其中，因此没有移除按钮
  const manualByKey = new Map(manualProjects.map((p) => [`project:${p}`, p]));

  // 选中的域消失（项目不再存在）时回落到「全部」
  useEffect(() => {
    if (!overview) return;
    if (selectedKey !== ALL_KEY && !domains.some((d) => d.key === selectedKey)) {
      setSelectedKey(ALL_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

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

  const closeSettings = () => {
    setSettingsOpen(false);
    void refresh();
  };

  const collapsed = tab === "custom";

  return (
    <div className="app">
      <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
        {!collapsed && (
          <>
            <h1>SymSync</h1>
            <ul>
              <li
                className={selectedKey === ALL_KEY ? "active" : ""}
                title="全局与所有项目"
                onClick={() => !busy && setSelectedKey(ALL_KEY)}
              >
                <span>全部</span>
              </li>
              {domains.map((d) => {
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
            </ul>
            <button disabled={busy} onClick={() => void addProject()}>
              添加项目…
            </button>
          </>
        )}
        <button onClick={() => setSettingsOpen(true)}>设置</button>
      </aside>
      <main className="content">
        <nav className="tabs">
          <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
            Skills
          </button>
          <button className={tab === "custom" ? "active" : ""} onClick={() => setTab("custom")}>
            自定义同步
          </button>
        </nav>
        {error && (
          <div className="error">
            {error}
            <button className="link" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {tab === "skills" ? (
          <SkillsTab
            overview={overview}
            busy={busy}
            onBusy={setBusy}
            selectedKey={selectedKey}
            onRefresh={refresh}
            onError={setError}
          />
        ) : (
          <CustomSyncTab onError={setError} />
        )}
      </main>
      {settingsOpen && <SettingsPanel onClose={closeSettings} onError={setError} />}
    </div>
  );
}

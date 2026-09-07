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

  // 扫描是纯读操作；任何写动作之后重新扫描，而不是在前端改状态
  const refresh = async () => {
    setBusy(true);
    try {
      setOverview(await api.scanAll());
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

  // 选中的域消失（项目不再存在）时回落到「全部」
  useEffect(() => {
    if (!overview) return;
    if (selectedKey !== ALL_KEY && !domains.some((d) => d.key === selectedKey)) {
      setSelectedKey(ALL_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview]);

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
              {domains.map((d) => (
                <li
                  key={d.key}
                  className={d.key === selectedKey ? "active" : ""}
                  title={d.key}
                  onClick={() => !busy && setSelectedKey(d.key)}
                >
                  <span>{d.label}</span>
                </li>
              ))}
            </ul>
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

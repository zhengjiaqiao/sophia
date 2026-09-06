import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Overview } from "./types";
import SkillsTab from "./SkillsTab";
import CustomSyncTab from "./CustomSyncTab";
import SettingsPanel from "./SettingsPanel";
import { domainEntries } from "./DomainView";
import "./App.css";

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"source" | "domain">("source");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedDomainKey, setSelectedDomainKey] = useState("global");
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

  const sources = overview?.sources ?? [];
  const domains = useMemo(() => domainEntries(overview?.targets ?? []), [overview]);

  // 选中项消失（本体位置被移除、项目不再存在）时回落到第一项
  useEffect(() => {
    if (!overview) return;
    if (!sources.some((s) => s.id === selectedSourceId)) {
      setSelectedSourceId(sources[0]?.id ?? null);
    }
    if (!domains.some((d) => d.key === selectedDomainKey)) setSelectedDomainKey("global");
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
            <div className="view-switch">
              <button
                className={view === "source" ? "active" : ""}
                disabled={busy}
                onClick={() => setView("source")}
              >
                本体位置
              </button>
              <button
                className={view === "domain" ? "active" : ""}
                disabled={busy}
                onClick={() => setView("domain")}
              >
                域
              </button>
            </div>
            {view === "source" ? (
              <ul>
                {sources.map((s) => (
                  <li
                    key={s.id}
                    className={s.id === selectedSourceId ? "active" : ""}
                    title={s.path}
                    onClick={() => !busy && setSelectedSourceId(s.id)}
                  >
                    <span>
                      {s.label} ({s.skills.length})
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul>
                {domains.map((d) => (
                  <li
                    key={d.key}
                    className={d.key === selectedDomainKey ? "active" : ""}
                    title={d.path ?? "全局 skill 目录"}
                    onClick={() => !busy && setSelectedDomainKey(d.key)}
                  >
                    <span>{d.label}</span>
                  </li>
                ))}
              </ul>
            )}
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
            view={view}
            selectedSourceId={selectedSourceId}
            selectedDomainKey={selectedDomainKey}
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

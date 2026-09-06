import { useEffect, useState } from "react";
import { api } from "./api";
import { domainKey, type Domain, type DomainInfo } from "./types";
import SkillsTab from "./SkillsTab";
import CustomSyncTab from "./CustomSyncTab";
import SettingsPanel from "./SettingsPanel";
import "./App.css";

export default function App() {
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [selected, setSelected] = useState<Domain>({ type: "global" });
  const [tab, setTab] = useState<"skills" | "custom">("skills");
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 设置改动后自增，作为 SkillsTab 的 key 以触发重扫
  const [scanVersion, setScanVersion] = useState(0);

  const reload = async () => {
    try {
      setDomains(await api.listDomains());
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const addProject = async () => {
    const path = await api.pickDirectory("选择项目目录");
    if (!path) return;
    try {
      await api.addProject(path);
      await reload();
      setSelected({ type: "project", path });
    } catch (e) {
      setError(String(e));
    }
  };

  const removeProject = async (path: string) => {
    try {
      await api.removeProject(path);
      await reload();
      if (selected.type === "project" && selected.path === path) setSelected({ type: "global" });
    } catch (e) {
      setError(String(e));
    }
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    void reload();
    setScanVersion((v) => v + 1);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>SymSync</h1>
        <ul>
          {domains.map((d) => (
            <li
              key={domainKey(d.domain)}
              className={domainKey(d.domain) === domainKey(selected) ? "active" : ""}
              title={d.domain.type === "project" ? d.domain.path : "全局 skill 目录"}
              onClick={() => setSelected(d.domain)}
            >
              <span>{d.label}</span>
              {d.domain.type === "project" && (
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeProject((d.domain as { path: string }).path);
                  }}
                >
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>
        <button onClick={() => void addProject()}>添加项目</button>
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
          <SkillsTab key={scanVersion} onError={setError} />
        ) : (
          <CustomSyncTab onError={setError} />
        )}
      </main>
      {settingsOpen && <SettingsPanel onClose={closeSettings} onError={setError} />}
    </div>
  );
}

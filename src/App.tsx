import { useEffect, useState } from "react";
import { api } from "./api";
import { domainKey, type Domain, type DomainInfo } from "./types";
import SkillsTab from "./SkillsTab";
import CustomSyncTab from "./CustomSyncTab";
import "./App.css";

export default function App() {
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [selected, setSelected] = useState<Domain>({ type: "global" });
  const [tab, setTab] = useState<"skills" | "custom">("skills");
  const [error, setError] = useState<string | null>(null);

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
          <SkillsTab key={domainKey(selected)} domain={selected} onError={setError} />
        ) : (
          <CustomSyncTab onError={setError} />
        )}
      </main>
    </div>
  );
}

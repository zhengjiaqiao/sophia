import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import type { AutoLink, Overview } from "./types";
import SkillsTab from "./SkillsTab";
import SettingsPanel from "./SettingsPanel";
import "./App.css";

/// 侧栏「全部」的选中键；其余为 DomainPage.key
const ALL_KEY = "all";
/// 文件系统事件与窗口获得焦点后的重扫去抖
const REFRESH_DELAY = 300;

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState(ALL_KEY);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 手动添加的项目路径，用来判断侧栏哪些域可以移除
  const [manualProjects, setManualProjects] = useState<string[]>([]);
  // 自动同步规则；扫描时顺带取回，域页与引入弹层都用它
  const [autoLinks, setAutoLinks] = useState<AutoLink[]>([]);
  // 监听器只注册一次，用 ref 读当前状态，避免闭包读到旧值
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  busyRef.current = busy;

  // 扫描是纯读操作；任何写动作之后重新扫描，而不是在前端改状态
  const refresh = async () => {
    busyRef.current = true;
    setBusy(true);
    try {
      const [next, projects, rules] = await Promise.all([
        api.scanAll(),
        api.listManualProjects(),
        api.listAutoLinks(),
      ]);
      setOverview(next);
      setManualProjects(projects);
      setAutoLinks(rules);
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
    void refresh();
    // 首次加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const collect = (pending: Promise<() => void>) => {
      void pending.then((un) => (disposed ? un() : unlistens.push(un)));
    };
    collect(listen("fs-changed", () => requestRefresh()));
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

  return (
    <div className="app">
      <aside className="sidebar">
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
        <button onClick={() => setSettingsOpen(true)}>设置</button>
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
        <SkillsTab
          overview={overview}
          autoLinks={autoLinks}
          busy={busy}
          onBusy={setBusy}
          selectedKey={selectedKey}
          onRefresh={refresh}
          onError={setError}
        />
      </main>
      {settingsOpen && <SettingsPanel onClose={closeSettings} onError={setError} />}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "./api";
import type { HarnessStatus } from "./types";

/// 低频设置：harness 启用状态、手动添加的项目与本体位置。关闭时由 App 触发重扫
export default function SettingsPanel({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [manual, setManual] = useState<string[]>([]);

  const reload = async () => {
    try {
      setHarnesses(await api.listHarnesses());
      setProjects(await api.listManualProjects());
      setManual(await api.listManualSources());
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => {
    void reload();
    // 首次打开加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleHarness = async (id: string, enabled: boolean) => {
    try {
      await api.setHarnessEnabled(id, enabled);
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  const addProject = async () => {
    const path = await api.pickDirectory("选择项目目录");
    if (!path) return;
    try {
      await api.addProject(path);
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  const removeProject = async (path: string) => {
    try {
      await api.removeProject(path);
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  const addSource = async () => {
    const path = await api.pickDirectory("选择本体位置目录");
    if (!path) return;
    try {
      await api.addManualSource(path);
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  const removeSource = async (path: string) => {
    try {
      await api.removeManualSource(path);
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <h2>设置</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        <section className="harnesses">
          <h2>Harness</h2>
          {harnesses.map((h) => (
            <label key={h.id} title="取消勾选后该 harness 不再出现在矩阵中">
              <input
                type="checkbox"
                checked={h.enabled}
                onChange={(e) => void toggleHarness(h.id, e.target.checked)}
              />
              {h.displayName}
            </label>
          ))}
        </section>
        <section className="harnesses">
          <h2>项目</h2>
          <ul>
            {projects.map((p) => (
              <li key={p}>
                <span title={p}>{p}</span>
                <button className="link" onClick={() => void removeProject(p)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => void addProject()}>添加</button>
        </section>
        <section className="harnesses">
          <h2>本体位置</h2>
          <ul>
            {manual.map((p) => (
              <li key={p}>
                <span title={p}>{p}</span>
                <button className="link" onClick={() => void removeSource(p)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => void addSource()}>添加</button>
        </section>
      </div>
    </div>
  );
}

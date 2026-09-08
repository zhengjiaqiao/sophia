import { useEffect, useState } from "react";
import { api } from "./api";
import type { HarnessStatus } from "./types";

/// 低频设置：harness 启用状态。关闭时由 App 触发重扫
export default function SettingsPanel({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);

  const reload = async () => {
    try {
      setHarnesses(await api.listHarnesses());
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
      </div>
    </div>
  );
}

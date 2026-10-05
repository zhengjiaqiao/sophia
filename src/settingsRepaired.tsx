import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { NoticePanel } from "./ui/index.ts";

/// 这次启动时设置文件坏了、已另存并重置（spec S7）：机面顶上提示一次，关掉就不再出现。
/// 后端在启动时已把 Codex 改回官方；这里只说清发生了什么
export function SettingsRepairedNotice() {
  const [repaired, setRepaired] = useState(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api.settingsRepaired().then(
      (r) => !cancelled && setRepaired(r),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (closed || !repaired) return null;
  return (
    <div className="face__banner">
      <NoticePanel
        scope="app"
        mark={false}
        message={t("common.settings.repaired")}
        onClose={() => setClosed(true)}
      />
    </div>
  );
}

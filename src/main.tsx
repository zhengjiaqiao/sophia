import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import TrayPanel from "./TrayPanel";
import { api } from "./api";
import { installGlobalErrorLogging } from "./diagnostics";
import { FaultBomb, PageGuard, useFaultPage } from "./PageGuard";
import { isLang, locale, setLocale, subscribeLocale, useLocale } from "./i18n";
import { ToastHost } from "./ui";

// 未捕获的错误与未处理的拒绝写进日志（两个窗口各装各的）；越早装越好，只记、不改界面
installGlobalErrorLogging();

// 主窗口关了系统的文件拖放（tauri.conf.json `dragDropEnabled: false`），反馈小窗才收得到拖进来的截图（HTML5 拖放）。
// 代价是拖到别处的文件会被网页当成要打开的东西、把整个窗口换成那个文件：在根上拦下，只有反馈小窗自己接
const blockFileDrop = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
};
window.addEventListener("dragover", blockFileDrop);
window.addEventListener("drop", blockFileDrop);

// 同一份前端产物服务两个窗口：主窗口，和菜单栏弹出的小面板（窗口标签 tray）
const isTray = getCurrentWindow().label === "tray";
// 托盘窗口换成系统菜单风格（TrayPanel.css 的 html[data-window="tray"]）：标记打在根上，挂在 body 上的浮层也认得到
if (isTray) document.documentElement.dataset.window = "tray";

// 界面语言（spec 2026-09-30-language-and-theme R12）：html lang 跟着当前语言走（繁体的字体栈挂在
// :lang(zh-Hant) 上，屏幕阅读器也按它念）；后端换了语言发 `locale-changed`，两个窗口各自换
const syncHtmlLang = () => (document.documentElement.lang = locale());
subscribeLocale(syncHtmlLang);
syncHtmlLang();
listen<string>("locale-changed", ({ payload }) => {
  if (isLang(payload)) setLocale(payload);
}).catch(() => undefined);

/// 托盘面板的兜底：出错只换掉面板里的内容（窄形态），菜单栏图标和窗口不受影响。
/// 开发版 `debug_fault` 返回 `page:tray` 时故意出错
function GuardedTray() {
  const fault = useFaultPage();
  return (
    <PageGuard narrow>
      {fault === "tray" && <FaultBomb page="tray" />}
      <TrayPanel />
    </PageGuard>
  );
}

/// 主窗口外壳的兜底（spec S18）：侧栏、横幅、反馈小窗、退出确认任何一处出错，整窗换成出错页，
/// 只有 `重新加载`（重载整个窗口）；页面那一块另有各自的边界（App 里的 PageGuard）。
/// 开发版 `debug_fault` 返回 `page:shell` 时故意出错
function GuardedApp() {
  const fault = useFaultPage();
  return (
    <PageGuard shell>
      {fault === "shell" && <FaultBomb page="shell" />}
      <App />
    </PageGuard>
  );
}

/// 根部订阅当前语言：换了语言整棵树重渲染（组件状态保留），每一处 `t()` 都按新语言取
function Root() {
  useLocale();
  return (
    <React.StrictMode>
      {/* 右下那一叠提示小窗挂在哪（壳上的 ToastStack），各页经 CornerToast 挂进去 */}
      <ToastHost>{isTray ? <GuardedTray /> : <GuardedApp />}</ToastHost>
    </React.StrictMode>
  );
}

const render = () =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);

// 先问后端当前语言再画第一帧，免得先画一帧简体再换；问不到（不在应用里跑）照简体画
void api.uiLanguage().then(
  ({ resolved }) => {
    if (isLang(resolved)) setLocale(resolved);
    render();
  },
  () => render(),
);

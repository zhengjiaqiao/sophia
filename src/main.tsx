import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import TrayPanel from "./TrayPanel";
import { api } from "./api";
import { isLang, locale, setLocale, subscribeLocale, useLocale } from "./i18n";
import { ToastHost } from "./ui";

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

/// 根部订阅当前语言：换了语言整棵树重渲染（组件状态保留），每一处 `t()` 都按新语言取
function Root() {
  useLocale();
  return (
    <React.StrictMode>
      {/* 右下那一叠提示小窗挂在哪（壳上的 ToastStack），各页经 CornerToast 挂进去 */}
      <ToastHost>{isTray ? <TrayPanel /> : <App />}</ToastHost>
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

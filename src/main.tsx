import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import TrayPanel from "./TrayPanel";
import { ToastHost } from "./ui";

// 同一份前端产物服务两个窗口：主窗口，和菜单栏弹出的小面板（窗口标签 tray）
const isTray = getCurrentWindow().label === "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* 右下那一叠提示小窗挂在哪（壳上的 ToastStack），各页经 CornerToast 挂进去 */}
    <ToastHost>{isTray ? <TrayPanel /> : <App />}</ToastHost>
  </React.StrictMode>,
);

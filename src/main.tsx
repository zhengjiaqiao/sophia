import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import TrayPanel from "./TrayPanel";

// 同一份前端产物服务两个窗口：主窗口，和菜单栏弹出的小面板（窗口标签 tray）
const isTray = getCurrentWindow().label === "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isTray ? <TrayPanel /> : <App />}</React.StrictMode>,
);

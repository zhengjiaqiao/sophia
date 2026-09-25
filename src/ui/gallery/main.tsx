/// 组件样张（只在开发时用，不进应用包）：`npm run gallery`，打开 http://localhost:1430/gallery.html。
/// `?family=keys` 只看一个家族（给 /design-sync 生成预览、做视觉回归时一页一张）；不给就全部。
/// 组件只收 props、不调 Tauri 命令：这里不需要任何模拟，直接渲染
import React from "react";
import ReactDOM from "react-dom/client";
import "../index.ts";
// 推入页的页面头是壳的 PageHead，它的样式在外壳里
import "../../App.css";
import { setHome } from "../../pathText.ts";
import { installForcedStates } from "./forceStates.ts";
import { ContainersFamily } from "./containers.tsx";
import { FeedbackFamily } from "./feedback.tsx";
import { InputFamily } from "./input.tsx";
import { KeysFamily } from "./keys.tsx";
import { MarksFamily } from "./marks.tsx";
import { PrimitivesFamily } from "./primitives.tsx";
import { SelectionFamily } from "./selection.tsx";
import "./gallery.css";

// 路径样张按用户主目录写成 ~
setHome("/Users/me");

const FAMILIES = [
  { id: "keys", title: "键", View: KeysFamily },
  { id: "feedback", title: "提示与反馈", View: FeedbackFamily },
  { id: "selection", title: "选择", View: SelectionFamily },
  { id: "input", title: "输入", View: InputFamily },
  { id: "containers", title: "容器与层", View: ContainersFamily },
  { id: "marks", title: "状态记号", View: MarksFamily },
  { id: "primitives", title: "图标与排版原语", View: PrimitivesFamily },
];

function Gallery() {
  const only = new URLSearchParams(location.search).get("family");
  const shown = FAMILIES.filter((f) => only === null || f.id === only);
  return (
    <div className="gallery">
      <header className="gallery__head">
        <span className="gallery__title">Sophia 组件样张</span>
        <nav className="gallery__nav" aria-label="家族">
          <a href="?">全部</a>
          {FAMILIES.map((f) => (
            <a
              key={f.id}
              href={`?family=${f.id}`}
              aria-current={only === f.id ? "page" : undefined}
            >
              {f.title}
            </a>
          ))}
        </nav>
      </header>
      <main className="gallery__body">
        {shown.map(({ id, View }) => (
          <View key={id} />
        ))}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Gallery />
  </React.StrictMode>,
);

// 样式都挂上之后，装上钉住的交互态（悬停 / 按下 / 键盘焦点）
requestAnimationFrame(() => installForcedStates());

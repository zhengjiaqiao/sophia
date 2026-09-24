/// 给 node:test 用的最轻量 JSX 渲染。
///
/// `node --test` 能剥类型注解，但不会转 JSX，也不认 `.css`。所以这里用项目已有的
/// typescript 装一个同线程 load 钩子：`.tsx` 过一遍 transpileModule，`.css` 换成空模块。
/// 不引新的测试框架、不引新依赖——react-dom/server 和 typescript 都已经在 package.json 里。
///
/// 用法：先 import 这个文件，再 `await import("../src/ui/Xxx.tsx")`——钩子要在
/// 模块图抓取 `.tsx` 之前装好，所以那一步必须是动态 import。
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", shortCircuit: true, source: "export default {};" };
    }
    // `?raw`（vite 里 import 得到文件原文）：原文照给
    if (url.endsWith("?raw")) {
      const text = readFileSync(fileURLToPath(url.slice(0, -"?raw".length)), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(text)};`,
      };
    }
    // 图像资源（vite 里 import 得到 URL）：换成文件名字符串，断言用得上
    const asset = /\/([^/]+\.(?:jpe?g|png|svg))$/.exec(url);
    if (asset) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(asset[1])};`,
      };
    }
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    return { format: "module", shortCircuit: true, source };
  },
});

/// 渲染成静态 HTML。断言类名、文案、title、aria 就够了——
/// 组件都是纯展示的，没有需要驱动的内部状态。
export function render<P extends object>(Component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(createElement(Component, props));
}

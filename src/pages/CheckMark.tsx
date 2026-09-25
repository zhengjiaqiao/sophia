/// 转出：画出来的勾选框已收进组件库（`src/ui` 的 `CheckMark` / `CheckRow`），页面不再用这个路径。
/// 只留给 tests/ui.test.ts 还在 import 的旧路径；那一处改指向 ui 之后删掉这个文件
export { CheckMark } from "../ui/index.ts";

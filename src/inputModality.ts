/// 这个窗口里用户最近一次是用键盘还是指针操作的（DESIGN「提示框」「键盘」）。
///
/// 焦点框和「焦点唤起提示框」只该回应键盘。浏览器的 `:focus-visible` 靠自己的启发式猜：
/// 窗口刚从托盘、原生选文件夹对话框、别的应用切回来时，这个窗口里还没有过指针操作，
/// 程序放的焦点（二级页标题、返回时还给入口键、面板弹出）就被当成键盘焦点——画框、弹提示。
/// 这类问题出过好几次，所以不再逐处打补丁，统一在这里自己记：
/// - 默认是「指针」：没按过键就不算键盘操作
/// - 任意按键（捕获阶段）记为「键盘」；任意指针按下记为「指针」
/// - 结果写在 `<html data-input>` 上，css 据此收掉指针模式下的焦点框（App.css）
export type InputModality = "keyboard" | "pointer";

let current: InputModality = "pointer";

const mark = (next: InputModality) => {
  if (current === next) return;
  current = next;
  document.documentElement.dataset.input = next;
};

if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.documentElement.dataset.input = current;
  window.addEventListener("keydown", () => mark("keyboard"), true);
  window.addEventListener("pointerdown", () => mark("pointer"), true);
}

/// 这次焦点是不是用户用键盘带来的
export const keyboardModality = (): boolean => current === "keyboard";

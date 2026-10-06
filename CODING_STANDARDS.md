# Coding standards

评审（`/code-review`、交 PR 前）时对照的判断型规则。机械的规则不在这里：它们是测试或 CI 检查（`tests/i18n-*.test.ts`、`crates/core/tests/i18n_literals.rs`、`scripts/lint-ui.mjs`、prettier、clippy），写进代码的检查比写在文档里的规则可靠。

## 前端

- **藏元素靠条件不渲染**，不靠 `hidden` 属性：给自己写了 `display` 的元素上，`hidden` 只是装饰（UA 样式表的 `display: none` 被作者样式的 `display: flex` 压过）。真要用属性，CSS 里要有 `[hidden] { display: none !important }`。
- **程序放的焦点不逐处打补丁**：`el.focus()`（二级页标题、返回时还给入口键、面板弹出、选完文件夹）会被 WebKit 的 `:focus-visible` 当成键盘焦点，画框、唤起提示框。焦点框与焦点提示只看 `src/inputModality.ts`（本窗口最近一次是按键还是指针），CSS 走 `html[data-input="pointer"]`；只供程序放焦点的落点用 `tabIndex={-1}`。
- **flex 容器里的文字空白**：`display: inline-flex` 的按钮里插一个 `<span>` 包专名（`重启 <Plain>Codex</Plain>`），文字被拆成三个匿名 flex item，item 之间的空白被吃掉（渲染成 `删WeiboAP的`）。空格写成 `&nbsp;`，或者别让按钮当 flex 容器。
- **页面 CSS 不写行与悬停带**：列表行、勾选行、菜单项的悬停底由 ui 组件给（`ListRow`、`CheckRow`、`MenuItem`）；页面级 CSS 只排位置（`tests/agent-gateways.test.ts` 对 `gw-row` 有一条检查，别的页面照同一精神）。
- **新样式先进 DESIGN**：画板照真实组件画；偏离规范先改 `docs/DESIGN.md`，同一个 PR 里写进去。

## 后端

- **错误给人看的一句与技术原文分开**：命令错误 `[code] 一句\n[detail] 原文`（`parseBackendError` 拆），`ReportEntry.detail` 一类字段只放去隐私后的原文；原因句走文案目录。
- **外部原因只计数，自身错误才带原文上报**：io 错误先分类（`atomicfile::write_failure`、`sync::fail_kind_of`），分得出的按外部异常计数，分不出的 `report::capture_internal`。
- **改用户文件走 `atomicfile` / `jsonedit` / `codex_models::config`**，不另写一份；写 Sophia 自己的 JSON 走 `store::save_json`（已 fsync）。

## 测试

- **新行为先有能跑红的测试**：core 用 `TempTree` 搭真实文件树；gateway 用 `Deps` 注入与本机假上游；前端纯逻辑进 `tests/*.test.ts`，组件只做 `render` 字符串断言。
- **真机验证只验单测验不了的**（界面、系统服务、子进程），记在 PR 正文里：做了什么、看到什么、没验什么。

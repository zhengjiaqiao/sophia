# Intent: Rust 版首轮实现遗留项收口

- 状态：待评审
- 作者：jiaqiao
- 日期：2026-09-06
- 上游：`docs/plans/2026-09-06-skill-sync-plan.md` 的逐任务评审与终审（PR #4）

## 问题

首轮实现的评审留下若干非阻塞项，终审在真机上又发现两类需要产品决策的情况。

## 期望结果（按优先级）

0. **让用户决定哪些 harness 算数**：Orca 会往所有已知 agent 的配置目录写 hook（`~/.commandcode/settings.json`、`~/.factory/settings.json` 等），"目录里有非 skills 的条目"仍会把没用过的 Command Code、Droid 判成已安装。需要在设置里提供按 harness 启用/禁用，并记住选择。
1. **未安装 harness 里的坏链不可见**：`installed()` 收紧后，`~/.kiro/skills/ppt-master` 这类 npx 留下的坏链不再出现在矩阵里，用户无法用 App 清理。提供"显示未安装的 harness"开关，或一个"清理 npx 残留"的独立动作（只删软链）。
2. **Windows 真机验证**：junction 的 `symlink_metadata().is_symlink()`、`read_link`、`remove_dir` 行为，以及 `harnesses.json` 的 `%APPDATA%` 路径；CI 增加 windows job。
3. **手动清单跑通**：`docs/manual-checks.md` 的 macOS 部分尚未由人工执行。
4. **前端小项**：Skills tab 刷新后清空上一轮结果；`outcomeText`/`rowText` 加 `never` 兜底；自定义同步的 `listSourceItems` 失败时提示而非静默为空；目标行用稳定 key。
5. **core 小项**：`propose` 把坏链目标存进 `Cell` 而不是二次读盘；`EntryKind::File` 单独状态或在 UI 标注；`list_dir` 逐项错误不再静默丢弃；`store` 写入前 fsync；serde 快照测试锁定 `Outcome`/`Domain`/`Selection` 形状。
6. **工程**：`package-lock.json` 的 npmmirror 源改回官方源或在文档说明；`src-tauri/Cargo.toml` 的 description/authors 占位；CSP 从 null 收紧；CI 固定 Rust 版本。

## 不在范围内

- 全局 ↔ 项目复制与分叉比对；marketplace；编辑；预设；CLI；自动更新（各自另立 intent）。

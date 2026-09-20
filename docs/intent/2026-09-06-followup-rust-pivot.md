# Intent: Rust 版首轮实现遗留项收口

- 状态：待评审
- 作者：jiaqiao
- 日期：2026-09-06
- 上游：`docs/plans/2026-09-06-skill-sync-plan.md` 的逐任务评审与终审（PR #4）

## 问题

首轮实现的评审留下若干非阻塞项，终审在真机上又发现两类需要产品决策的情况。

## 期望结果（按优先级）

0. **按行选择同步目标**：WeiboAP 接入后，它的 35 个工作专用 skill 与全局 40 个 skill 会被"同步缺失链接"一键双向互通；需要按 skill 行选择"同步到哪些 harness"，或至少能对某行标记"不同步"。另需真机验证 WeiboAP 是否跟随软链读取 skill。（harness 启用/禁用已于 b461266 实现。）
1. **未安装 harness 里的坏链不可见**：`installed()` 收紧后，`~/.kiro/skills/ppt-master` 这类 npx 留下的坏链不再出现在矩阵里，用户无法用 App 清理。提供"显示未安装的 harness"开关，或一个"清理 npx 残留"的独立动作（只删软链）。
2. **Windows 真机验证**：junction 的 `symlink_metadata().is_symlink()`、`read_link`、`remove_dir` 行为，以及 `harnesses.json` 的 `%APPDATA%` 路径；CI 增加 windows job。
3. **手动清单跑通**：`docs/manual-checks.md` 的 macOS 部分尚未由人工执行。
4. **前端小项**：Skills tab 刷新后清空上一轮结果；`outcomeText`/`rowText` 加 `never` 兜底；自定义同步的 `listSourceItems` 失败时提示而非静默为空；目标行用稳定 key。
5. **core 小项**：`propose` 把坏链目标存进 `Cell` 而不是二次读盘；`EntryKind::File` 单独状态或在 UI 标注；`list_dir` 逐项错误不再静默丢弃；`store` 写入前 fsync；serde 快照测试锁定 `Outcome`/`Domain`/`Selection` 形状。
6. **工程**：`package-lock.json` 的 npmmirror 源改回官方源或在文档说明；`src-tauri/Cargo.toml` 的 description/authors 占位；CSP 从 null 收紧；CI 固定 Rust 版本。

## 不在范围内

- 全局 ↔ 项目复制与分叉比对；marketplace；编辑；预设；CLI；自动更新（各自另立 intent）。

---

## 追加（2026-09-20）：`toml_edit` 写入会改写整个文件的行尾

来源：`feat/codex-model-gateway` 分支在验证契约「`toml_edit` 增删根键后其余内容逐字节不变」时做的一次性实验，结论是**不成立**——`toml_edit` 会把整个文件的 CRLF 改写成 LF、丢掉 BOM、给末行补换行。该分支因此改用文本级手术，只拿 `toml_edit` 做校验和读值。

对本仓库已上线代码的影响：**`mcp.rs` 现在用 `toml_edit` 写 `~/.codex/config.toml`，同样会改写整个文件的行尾。**

- macOS / Linux 上基本碰不到（config.toml 一般是 LF、无 BOM）。
- Windows 上会碰到：用户的 CRLF 配置在同步一个 MCP 服务器之后全文件变成 LF。这与本项目"只改该改的部分、其余逐字节不动"的原则相违，而且有备份、原子写、指纹校验在场反而更容易让人以为文件是安全的。
- 归入上面第 2 项（Windows 真机验证）的前置工作：做 Windows 之前先修，修法参考 `codex_models` 的文本级手术，或在写回前还原原文件的行尾风格与 BOM。

暂不处理，记录在案。

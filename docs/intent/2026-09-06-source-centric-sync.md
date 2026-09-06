# Intent: 以本体为中心组织同步，按需勾选目标

- 状态：已接受（2026-09-06 作者答复五个问题后）
- 作者：jiaqiao
- 日期：2026-09-06
- 上游：PR #4 的真机验收；替代 `docs/intent/2026-09-06-followup-rust-pivot.md` 的第 0 条

## 问题

第一版矩阵以"域（全局 / 项目）× harness"组织，行是 skill 名，本体按域推断。真机使用时暴露三个问题：

1. **只能全同步**："同步缺失链接"把所有缺失一次补齐。WeiboAP 接入后，它的 35 个工作专用 skill 会被链进 Claude Code / Codex，全局 skill 也会被链进 WeiboAP。用户需要勾选哪些同步、哪些不同步。
2. **skill 列表没有按来源分组**：用户的心智是"这一批来自 WeiboAP、这一批是我自己放在 `~/.agents/skills` 的"。有的来源整组都不想同步出去，也应该能整组全选。
3. **项目级的真实用法是"从某个本体链进项目"**，而不是"项目内部各 harness 目录互链"：
   - `weibo_mini_program/.claude/skills` 是 10 条指向 `WeiboAP/Data/agents/<agent>/.internal-plugins/skills/` 的绝对路径软链，矩阵显示为"外部本体"。
   - `weibo_assistant/.claude/skills` **本身是一条软链**，整个目录指向 `WeiboAP/Data/agents/<另一个 agent>/.internal-plugins/skills`（WeiboAP 把整个 skills 目录登记成软链），矩阵把里面 43 个 skill 当成项目自己的本体。整目录软链不够灵活：项目里放不进别的 skill。
   - 两个项目其实是同一件事：把 WeiboAP 的 skill 同步到项目里。现在的组织方式表达不出来，也没有"把本体同步到项目"的动作（第一版明确排除了跨域动作）。
   - 顺带发现 WeiboAP 有两个 skill 位置：`claude-code-plugins-custom/skills/custom`（用户自装）和 `Data/agents/<agent>/.internal-plugins/skills`（agent 内置），第一版只登记了前者。

## 期望结果

把组织方式从"域 × harness"改为**"本体位置 → 目标"**：

- **本体位置（Source）**：任何存放真实 skill 目录的文件夹。自动发现：通用仓库 `~/.agents/skills`、各 harness 全局目录里的真实目录、WeiboAP 的两类目录、项目的 `.agents/skills`；也允许手动添加一个文件夹作为本体位置。
- **目标（Target）**：各 harness 的全局 skill 目录，以及每个项目里各 harness 的项目级目录。
- 主界面按本体位置分组列出 skill；每组一张"skill × 目标"矩阵，格子状态沿用已链接 / 缺失 / 坏链 / 指向他处 / 副本。
- **勾选决定同步范围**：按格、按行、按组全选 / 全不选；勾选结果持久化为"同步集"，之后"同步"只处理同步集里的格子，未勾选的永远不动。默认勾选 = 当前已经链接的格子，新发现的 skill 默认不勾选。
- 链接写法：目标在本体所在项目内 → 相对路径；其余 → 绝对路径。指向项目外本体的项目级链接在界面上标"本机链接"，提示提交 git 后在其他机器失效。
- 坏链检测与确认后清理保持不变；"副本"（同名真实目录）只报告，仍不比对内容、不搬本体。

## 影响的用户与系统

- 用户：作者本人（WeiboAP + Claude Code + Codex，多项目）；面向所有多 harness 用户。
- 系统：core 的 `skills` 模块（矩阵模型、本体判定）、`store`（同步集）、命令层与前端主界面基本重做；`sync`、`fs`、`discovery` 大部分复用。

## 约束

- 沿用现有约束：不搬本体、不复制内容、唯一删除是确认后的坏链清理、Rust core + Tauri、Windows junction。
- 第一版矩阵的 40 余个测试用例继续作为 `sync`/`fs`/`discovery` 的回归规格；`skills` 的测试按新模型重写。
- 分工不变：Fable 规划、派发、验收；opus 子代理实现。

## 不在范围内

- 内容比对与分叉检测、复制或移动本体、marketplace、编辑、预设、CLI、自动更新。

## 作者决定（2026-09-06）

1. 默认全选：新发现的 skill 默认勾选到所有已启用目标。
2. 勾选粒度到行：一个 skill 要么同步到本组的全部目标，要么不同步。
3. WeiboAP 每个 agent 的 `.internal-plugins/skills` 各算一个本体位置，可能多个。
4. 整目录软链（`weibo_assistant/.claude/skills -> WeiboAP agent 目录`）不做特殊处理，按通用模式：识别为"目标目录整体链接到某本体位置"，提供"拆成逐项链接"的动作（删目录级软链、建真实目录、逐项建链，需确认）。
5. 两种视图可切换：按本体位置分组（默认）和按域 × harness（第一版）。

## 原始待确认问题（已答复）

1. 默认勾选 = "已链接的格子"是否符合预期？还是新 skill 默认全选？
2. 勾选粒度到格（skill × 目标）还是到行（skill → 所有已启用目标）？格更灵活，行更简单。
3. WeiboAP 的 `Data/agents/<agent>/.internal-plugins/skills` 目录是否应自动登记为本体位置（agent id 是随机串，可能有多个）？
4. `weibo_assistant` 这种"复制进项目的副本"，界面上标"副本"即可，还是希望有"改为链接"的动作（删副本建链，属破坏性）？
5. 是否保留第一版的"域"视图作为次要入口，还是彻底替换？

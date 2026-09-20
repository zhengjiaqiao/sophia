---
type: plan
description: 界面重构第一份（Skill 管理）的实施计划——任务划分、并行波次、每步验证
created: 2026-09-21
spec: docs/specs/2026-09-21-ui-rebuild-skill.md
---

# 实施计划 · 界面重构 Skill 管理

**Spec**：`docs/specs/2026-09-21-ui-rebuild-skill.md`（21 条 AC）
**组件规范**：`docs/specs/2026-09-21-ui-components.md`（**实现以它为准**，与画稿不一致时以它为准）
**设计稿**：画布「SymSync 界面重构」page-1

## 全局约束

每个任务的要求都隐含包含这一节。

- Rust 2021，`clippy -D warnings`，core 不依赖 tauri、无异步无网络。
- serde 统一 `rename_all = "camelCase"`，`src/types.ts` 与之对应。
- 注释与 UI 文案中文，标识符英文；Conventional Commits。
- **色值只用**：`#ffffff #000000 #e0e0e8 #f0f0fa #5a5a5f #9a9aa2 #c8c8d0 #6a6a72`。零色彩、零阴影、零渐变。
- **圆角只有**：输入框 4px、pill 32px、圆点 50%，其余 0。
- **文案层不出现**：`harness`、`软链接`（除非用户需据此判断）、`操作失败`。
- **字族**：`Barlow` / `Barlow Condensed` / `IBM Plex Mono`，三者都没有中文字形，CJK 回退栈按组件规范 §1.2.1 写全。
- 判条目类型用 `fs::entry_kind`（lstat），判"目标目录是否存在"用 `is_dir()`；比较同一处用 `fs::real_path`。
- **并行任务只碰自己 Files 列表里的文件。**

## 文件结构

新增 `src/ui/`（无状态展示组件，只吃 props）与 `src/pages/`（二级页面）。业务逻辑留在原来的位置。

```
src/tokens.css        色与字的 CSS 变量，唯一色值来源
src/ui/               StateDot Button Chip Toast ErrorBanner Confirm SubPage RowNotice AgentMark Empty
src/pages/            SettingsPage ImportPage PendingPage
src/cellState.ts      CellState → 圆点 + 点击行为 + 文案（三处共用）
scripts/lint-ui.mjs   规范的可执行版本，接进 make lint
```

## 波次

| 波 | 任务 | 可并行 |
|---|---|---|
| 0 | T0 风格检查器 | 单独先跑（阻塞：它是后面所有任务的护栏） |
| 1 | T1 core 状态改名与删本体 · T2 core 忽略项 · T3 前端 token 与组件库 | 三个并行 |
| 2 | T4 状态映射 · T5 Tauri 命令 | 两个并行 |
| 3 | T6 主视图 · T7 设置页 · T8 导入页 · T9 待处理页 | 四个并行 |
| 4 | T10 App 壳与二级页面路由 | 单独（收口） |

---

## T0 风格检查器的 src 版本

**Files**：新建 `scripts/lint-ui.mjs`；改 `Makefile`

`.superpowers/design/lint-artboards.mjs` 只认 `.dc.html` 画稿。移植成检查 `src/**/*.{tsx,css}` 的版本，规则相同，外加两条：

- **色值必须来自 `tokens.css` 的变量**，`.tsx` 里出现字面十六进制色值即违规（`tokens.css` 自己例外）。
- 文案检查扫 JSX 文本与字符串字面量。

接进 `make lint`：`cargo clippy … && node scripts/lint-ui.mjs`。

**验证**：`make lint` 通过（此时 `src/` 还是旧代码，允许先用白名单豁免旧文件，但白名单必须逐个文件列出、不能用通配，且每个后续任务改完自己的文件就从白名单里划掉）。

---

## T1 core：状态改名与删本体

**Files**：`crates/core/src/models.rs`、`crates/core/src/skills.rs`、`crates/core/src/sync.rs`

1. `CellState::Unwritable` → `WholeLinked`（含全部引用与测试）。新增 `CellState::ReadOnly`，**扫描时不产出**，只在写失败时由上层构造。
2. `sync::trash(path) -> Result<()>`，内部 `trash::delete`。删前用 `entry_kind` 重校验是真实目录而非软链。
3. `skills::plan_delete_source(skill, sources, targets) -> DeleteSourcePlan`：
   ```rust
   pub struct DeleteSourcePlan {
       pub path: PathBuf,
       pub entries: usize,
       pub bytes: u64,
       pub affected: Vec<AffectedLink>,
       pub in_git: Option<PathBuf>,  // 仓库根，None = 不在仓库里
       pub relink_to: Option<PathBuf>, // 同名的另一个本体，删完把链接改指到它
   }
   pub struct AffectedLink { pub path: PathBuf, pub style: LinkStyle }
   ```

   **`style` 必须在 plan 阶段算好。** `link_style()` 规定「本体在目标所属项目内 → 相对路径」，这条性质的全部价值是软链能随 git 走到别的机器上。`delete_source` 拿不到 `Target`，事后补算不出来，改指就会一律写绝对——链接仍然有效、仍然指对，只是不再可移植，**没有任何常规测试会发现**。

   第一版取 `&Source` 返 `Option`；改成取 `&Skill` 让它成为全函数——本体就是「某个位置里的某个 skill 目录」，`Skill{name, path}` 正好是这两样。
   `in_git` 向上找 `.git`（用 `Path::starts_with` 按分量，不用字符串）。
4. `ActionKind::DeleteSource`（serde `"deleteSource"`）。`SyncReport` 每条 entry 都要一个 `PlannedAction`，复用 `BrokenLink` / `Unlink` 表示「移入废纸篓」会让前端把它当断链处理。

5. `sync::delete_source(plan) -> SyncReport`：`in_git.is_some()` 时直接返回错误，**不删**。否则 trash → 对 `affected` 逐条 `remove_link` + `create_link(relink_to)`。

**测试**（`TempTree` 搭真实文件树，不 mock）：改名后全部旧测试仍绿；`plan_delete_source` 的 `in_git` 命中与不命中；`delete_source` 在 git 里拒绝；删完 `affected` 全部指向 `relink_to` 且 `entry_kind` 是软链。

**验证**：`make test-core && make lint` 全绿，贴输出末尾。

---

## T2 core：忽略项持久化

**Files**：`crates/core/src/store.rs`

`Settings` 新增 `#[serde(default)] pub ignored: Vec<IgnoredIssue>`。

```rust
pub struct IgnoredIssue { pub kind: IssueKind, pub key: String, pub at: String }
pub enum IssueKind { DuplicateSource, BrokenLink, ReadOnlyTarget }
```

`key` 由涉及的**全部路径排序后拼接**再取摘要——路径变了 key 就变了，自然重新提示。提供 `IgnoredIssue::key_for(kind, paths: &[PathBuf]) -> String`。

`Store` 加 `ignore(issue)` / `unignore(key)` / `is_ignored(key)`。

**测试**：旧 `settings.json`（没有 `ignored` 字段）能读出来且 `ignored` 为空；同一组路径顺序不同得到同一个 key；任一路径变化后 key 变化。

**验证**：`make test-core && make lint` 全绿。

---

## T3 前端：token 与组件库

**Files**：新建 `src/tokens.css`、`src/ui/*.tsx`；改 `package.json`（加 `@fontsource/*`）

按组件规范逐条实现，**每个组件的全部状态都要有**：

| 组件 | 必须覆盖的状态 |
|---|---|
| `StateDot` | linked / missing / own / 无格态 / 选中行反色 |
| `Button` | 默认 / 禁用（必须带 `title` 说明原因）/ 破坏性 / 文字链 × 常规与紧凑两档 |
| `Chip` | 未选中 / 选中（反色）/ 不可选 |
| `Toast` | 成功 / 成功多项 / 做不成 / 部分失败；带撤销与不带 |
| `ErrorBanner` | 反色通栏，不自动消失 |
| `Confirm` | 标题 + 正文 + 条件性警告段 + 取消/主动作；Esc 与背景点击等同取消 |
| `SubPage` | `←` + 页面名，占满整窗、不渲染侧栏，Esc 返回 |
| `RowNotice` | 一句话 + 紧凑 pill + `稍后` |
| `AgentMark` | 4 个真图标 + 首字母方块降级；常态 / 禁用取色 |
| `Empty` | 五种空态 |

字体只引 latin 子集的 Barlow 400、Condensed 600/700、Mono 400，**不整包引入**。

**测试**：每个组件的每个状态一条渲染断言（node:test + 轻量渲染）。

**验证**：`make build-web` 通过；`node scripts/lint-ui.mjs src/tokens.css src/ui` 零违规。

---

## T4 状态映射

**Files**：新建 `src/cellState.ts`；改 `src/types.ts`

`types.ts` 要跟的不止改名：`CellState` 的 `unwritable` → `wholeLinked`、新增 `readOnly`；`ActionKind` 新增 `deleteSource`；新增 `DeleteSourcePlan` 与 `AffectedLink` 两个接口。

```ts
export type Dot = "own" | "linked" | "missing" | "none";
export interface CellView { dot: Dot; clickable: boolean; reason?: string; issue?: IssueKind }
export function viewOf(cell: Cell, target: Target, agentLabel: string, skill: string): CellView
```

七种 `CellState` 逐条映射，**文案照组件规范 §8 的表格逐字写**。

**关键**：`reason` 是给提示条用的完整句子，不是错误码。`issue` 非空表示这条要进待处理栏。

**测试**：七种输入各一条，断言 `dot`、`clickable`、`reason` 的完整字符串。特别断言四种异常态**不产生**「没有需要建立的链接」。

**验证**：`make build-web` 通过，单测全绿。

---

## T5 Tauri 命令

**Files**：`src-tauri/src/lib.rs`、`src/api.ts`

新增四个命令，每个一行调 core：`plan_delete_source` / `delete_source` / `ignore_issue` / `unignore_issue`。

**验证**：`cargo check --workspace && make build-web`。

---

## T6 主视图

**Files**：`src/SkillsTab.tsx`、`src/DomainView.tsx`、`src/sort.ts`

- 格用 `StateDot`，点击走 `viewOf` 的 `clickable` 与 `reason`。**删掉 `acts.length === 0` 那条统一文案。**
- 表头排序：默认无箭头、hover 淡箭头、激活转黑；busy 期间不禁用。
- 自动同步行砍成一行 + `关掉`，计数写成 `N 条待建`。
- **点圆点开启时调 `includeAutoLink`**（修 AC13 那处不一致）。
- 待处理栏（底部快捷版，一次一条）。
- busy 的五个豁免控件。
- **改掉残留的 `unwritable`**：`src/DomainView.tsx`、`src/sort.ts` 里还是旧名，T4 只改了 `types.ts`。

**验证**：`make build-web`；`make dev` 里走 AC1–AC5、AC13、AC18、AC19。

---

## T7 设置页 · T8 导入页 · T9 待处理页

**Files**：各自 `src/pages/SettingsPage.tsx` / `ImportPage.tsx` / `PendingPage.tsx`；`src/SettingsPanel.tsx` 与 `src/ImportDialog.tsx` 删除

三个都用 `SubPage`。要点分别是：

- **设置页**：选择片网格、无路径、默认只列已安装的（`discovery::installed()`，本机 9/41）、`显示未安装的 M 个`。
- **导入页**：三栏铺开、skill 列表不截断、agent 选择用选择片、逐字保留用户改过的五句文案。
- **待处理页**：三类问题各自的动作、`拆开` 是 `split_whole_link` 的唯一入口、忽略/恢复提示两张列表。

**验证**：各自 `make build-web`；`make dev` 里走对应的 AC。

---

## T10 App 壳与二级页面路由

**Files**：`src/App.tsx`、`src/App.css`

`subPage: null | "settings" | "import" | "pending"`。非空时渲染 `SubPage` 包住对应页面、不渲染侧栏。Esc 与 `←` 置回 null。**不引路由库。**

把 T0 白名单里剩下的文件划掉，`make lint` 必须在**没有任何白名单**的情况下通过。

**验证**：`make test` 全绿；`make dev` 走完 21 条 AC 的真实验证栏。

---

## 交付前清理

- `scripts/lint-ui.mjs` 的白名单必须空。
- `SettingsPanel.tsx`、`ImportDialog.tsx` 已删除，无残留引用。
- `make build` 产出 .app，在**打包产物**上验证 AC14（`trash` 在沙箱下能否调用系统废纸篓）——这条不能只在 `make dev` 里做。

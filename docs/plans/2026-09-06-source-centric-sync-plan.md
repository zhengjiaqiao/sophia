# 以本体位置为中心的 skill 同步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec v3 重做 skill 矩阵：本体位置 → 目标，两级勾选持久化为同步集，整目录链接识别与拆分，两种视图切换。

**Architecture:** 数据类型集中到 `models.rs`；`discovery` 负责本体位置与目标发现（含通配）；`skills` 只做扫描、动作生成、拆分；`store` 负责 `syncset.json` 与 `settings.manual_sources`；命令层七个新命令；前端 `SkillsTab` 变成视图切换器，`SourceView`、`DomainView` 两个新组件。`fs`、`sync`、通用同步 tab 不动。

**Tech Stack:** 同 v2（Rust 1.94 / tauri 2.11 / React + TS）。通配展开用 `std::fs::read_dir`，不引入 glob crate。

**Spec:** `docs/specs/2026-09-06-source-centric-sync-design.md`（v3）；沿用部分见 `docs/specs/2026-09-06-skill-sync-design.md`（v2）。

## Global Constraints

- 不搬本体、不复制内容；删除只有两处：确认后的坏链清理、拆分整目录链接时删那条目录级软链（前置检查必须通过）。
- 条目判定 lstat（`fs::entry_kind`），身份比较 `fs::real_path`，路径文本先 `fs::normalize`。
- serde 全部 camelCase；`SourceKind`、`TargetScope` 用 `#[serde(tag = "type", rename_all = "camelCase")]`。
- 同步集默认：新本体位置 → 全部 Global 目标勾选、Project 目标不勾；skill 默认启用。
- 链接写法：目标属于某项目且本体位置在该项目内 → Relative；否则 Absolute。
- `symsync-core` 不依赖 tauri；clippy `-D warnings`；TDD；Chinese comments/UI，English identifiers；Conventional Commits。
- 并行任务只碰各自 Files；共享类型全部在 Task 0 落地后再开工。

---

## Plan（Stage 3 摘要）

### Files that change

| 路径 | 任务 |
|---|---|
| `crates/core/src/models.rs`（新增 v3 类型） | T0 |
| `crates/core/src/store.rs`（SyncSet 读写、manual_sources） | A1 |
| `crates/core/src/discovery.rs`、`crates/core/data/harnesses.json`（sources / targets / 通配） | A2 |
| `crates/core/src/skills.rs`（重写） | A3 |
| `src-tauri/src/lib.rs`、`src/types.ts`、`src/api.ts`、`src/App.css`、`src/App.tsx`（侧栏改为「设置」按钮）、`src/SettingsPanel.tsx`（新）、`src/SkillsTab.tsx`（切换器）、`src/SourceView.tsx`（占位）、`src/DomainView.tsx`（占位） | B1 |
| `src/SourceView.tsx` | C1 |
| `src/DomainView.tsx` | C2 |
| `docs/manual-checks.md`、本计划附录、spec 状态 | D |

### Order of work

```
T0 models ─→ ┬ A1 store     ┐
             ├ A2 discovery ┼─→ B1 命令层 + 前端契约/壳 ─→ ┬ C1 SourceView ┬─→ D 收尾
             └ A3 skills    ┘                              └ C2 DomainView ┘
```
并行任务各用 `.worktrees/<id>` 与分支 `task/<id>`，控制器合并。分支 `feat/rust-pivot`，PR #4。

### Risks

- A3 依赖 A2 的 `sources/targets` 输出形状，但只通过 `models.rs` 的类型耦合；A3 的测试自己构造 `Source`/`Target`，不调用 A2。
- 拆分整目录链接是唯一新增的删除路径；前置检查 + 测试覆盖"目标不是软链 / 指向别处"两种拒绝。
- WeiboAP 行为（跟随软链、拆分后识别）无法在实现阶段验证，D 的手动清单列出。

### Proof

- core 测试：v2 保留的 45 个中 `skills::` 的 13 个删除，新增约 25 个；`cargo test -p symsync-core` 全绿，clippy 零警告。
- `npm run build`、`cargo check --workspace` 通过。
- 控制器真机探针：本体位置应包含 `~/.agents/skills`、`~/.codex/skills`（hatch-pet 等）、WeiboAP custom、WeiboAP 两个 agent 目录、CardBox `.agents/skills`；`weibo_assistant · Claude Code` 目标 `linked_whole_to` 指向 WeiboAP agent 目录；默认同步集下全局目标勾选、项目目标未勾。

---

## Task 0: v3 共享类型（串行）

**Files:** Modify `crates/core/src/models.rs`

**Produces（后续任务只能用这些名字）:**
```rust
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SourceKind { Universal, HarnessGlobal { harness_id: String }, ProjectStore { project: PathBuf },
                      HarnessExtra { harness_id: String, label: String }, Manual }
pub struct Source { pub id: String, pub path: PathBuf, pub kind: SourceKind, pub label: String, pub skills: Vec<String> }
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TargetScope { Global { harness_id: String }, Project { project: PathBuf, harness_id: String } }
pub struct Target { pub id: String, pub label: String, pub path: PathBuf, pub scope: TargetScope, pub linked_whole_to: Option<String> }
pub enum CellState { Linked, Missing, Broken, Foreign, Duplicate, Unwritable }
pub struct Cell { pub source_id: String, pub skill: String, pub target_id: String, pub path: PathBuf, pub state: CellState }
#[derive(Default)] pub struct SourceSync { pub targets: BTreeSet<String>, pub disabled_skills: BTreeSet<String> }
#[derive(Default)] pub struct SyncSet { pub sources: BTreeMap<String, SourceSync> }
#[derive(Default)] pub struct Summary { pub sources: usize, pub pending_missing: usize, pub broken: usize }
pub struct Overview { pub sources: Vec<Source>, pub targets: Vec<Target>, pub cells: Vec<Cell>, pub sync_set: SyncSet, pub summary: Summary }
```
全部 `Debug, Clone, PartialEq, Eq, Serialize, Deserialize`，`rename_all = "camelCase"`。`Target.id` 约定：Global → `<harness_id>`；Project → `project:<normalized path>::<harness_id>`。`Source.id` = `normalize(path)` 的字符串。删除 v2 的 `Column/Cell/SkillRow/Matrix/CellState`（它们在 `skills.rs`，由 A3 删）。

- [ ] 写一个序列化测试：`SourceKind::HarnessExtra{..}` → `{"type":"harnessExtra","harnessId":..,"label":..}`；`TargetScope::Project{..}` → `{"type":"project","project":..,"harnessId":..}`；`SyncSet` 空 → `{"sources":{}}`。
- [ ] `cargo test -p symsync-core models::` 通过；clippy 零警告（v2 的 `skills.rs` 仍引用旧类型，此时应仍能编译，因为旧类型仍在 `skills.rs` 里）。
- [ ] 提交 `feat(core): v3 source/target/sync-set models`

---

## Task A1: store（并行）

**Files:** Modify `crates/core/src/store.rs`

**Produces:** `Settings.manual_sources: Vec<PathBuf>`（`#[serde(default)]`）；`Store::load_sync_set() -> io::Result<SyncSet>`（缺失 → Default）；`Store::save_sync_set(&SyncSet)`（原子写 `syncset.json`）。

- [ ] 测试：`sync_set_missing_is_empty_and_round_trips`（保存一个含两个 source、各有 targets 与 disabled_skills 的集合，读回相等，无 `.tmp` 残留）；`settings_without_manual_sources_still_loads`（写入旧格式 `{"disabledHarnesses":[]}`，读出 `manual_sources` 为空）。
- [ ] 实现；`cargo test -p symsync-core store::`；clippy。
- [ ] 提交 `feat(core): persist sync set and manual sources`

---

## Task A2: discovery（并行）

**Files:** Modify `crates/core/src/discovery.rs`、`crates/core/data/harnesses.json`

**Produces:**
```rust
pub fn expand_template_glob(candidates: &[String], env: &Env) -> Vec<PathBuf>  // 单层 `*`，返回存在的目录，排序
pub fn sources(env: &Env, settings: &Settings, harnesses: &[Harness], projects: &[PathBuf]) -> Vec<Source>
pub fn targets(env: &Env, harnesses: &[Harness], projects: &[PathBuf], sources: &[Source]) -> Vec<Target>
```
`Harness` 增加字段 `pub extra_source_dirs: Vec<PathBuf>`（已展开）——这是 `models.rs` 的类型，但字段新增由本任务做（唯一允许的跨文件改动，加 `#[serde(default)]`）；同一次改动里给 `CellState` 补上 `Copy` derive（Task 0 遗漏）。`harnesses.json` 的 WeiboAP 条目加 `"extra_source_dirs": ["~/Library/Application Support/WeiboAP/Data/agents/*/.internal-plugins/skills"]`。

规则（spec §3）：
- `sources`：候选位置按顺序：Universal(`~/.agents/skills`)、每个 harness 的 `global_dir`（HarnessGlobal）、每个 harness 的 `extra_source_dirs`（HarnessExtra，label = 通配层匹配到的目录名）、每个项目的 `.agents/skills`（ProjectStore）、`settings.manual_sources`（Manual）。位置目录存在且含至少一个非隐藏真实目录才产出；按 `real_path` 去重（先到先得）；`skills` 排序。
- `targets`：每个 harness `global_dir` 存在 → Global 目标；每个项目里每个 harness `project_dir` 存在 → Project 目标（`.agents/skills` 对通用型 harness 只出一列，label 用 `<项目名> · 通用仓库`）；按 `real_path` 去重合并 label；`linked_whole_to` = 若 `entry_kind(path)` 为 Symlink 且 `real_path(path)` 等于某 `Source.path` 的 real_path 则该 source 的 id。

- [ ] 测试（`TempTree`，伪造 `Env`）：通配展开（两个 agent 目录 + 一个非目录文件被忽略）；`sources` 五类来源各一例、空位置不产出、去重；`targets` Global/Project、通用仓库列合并、`linked_whole_to` 识别（把项目的 `.claude/skills` 做成指向某 source 的软链）；`installed` 与 v2 测试不变。
- [ ] 实现；`cargo test -p symsync-core discovery::`；clippy。
- [ ] 提交 `feat(core): discover sources and targets with glob-expanded extra dirs`

---

## Task A3: skills 重写（并行）

**Files:** Modify `crates/core/src/skills.rs`（整文件替换）

**Produces:**
```rust
pub fn scan(sources: &[Source], targets: &[Target], sync_set: &SyncSet) -> Overview   // 补默认值后的 sync_set 随 Overview 返回
pub fn propose(overview: &Overview) -> Vec<PlannedAction>
pub fn link_style(source: &Source, target: &Target) -> LinkStyle
pub fn split_whole_link(target: &Target, source: &Source) -> SyncReport
```
规则见 spec §4。`split_whole_link` 报告：第一条 entry 为删除目录级软链（`PlannedAction{kind: BrokenLink, item_name: "<整目录链接>", ...}` 配 `Removed`/`Failed`），之后每个 skill 一条 `Create`。测试自己构造 `Source`/`Target`（不调用 discovery）。

- [ ] 测试：六种格状态各一例；`linked_whole_to` 使全部 Linked / 其他 source Unwritable；默认同步集写入（新 source → Global 目标全选、Project 不选；已登记的不改）；`propose` 只取勾选目标 × 启用 skill 的 Missing；坏链不限本体位置；`link_style` 四种组合；`split_whole_link` 成功（目录级软链消失、真实目录出现、逐项链接指向原本体、原本体内容不变）、拒绝非软链目标、拒绝指向别处的软链；`summary` 计数。
- [ ] 实现；`cargo test -p symsync-core skills::`；clippy。
- [ ] 提交 `feat(core): source-centric scan, sync-set-driven propose and whole-link split`

## 波次 A 合并（控制器）
合并 A1–A3，`cargo test -p symsync-core` 全绿，clippy 零警告；此时 `src-tauri` 因引用旧 API 编译失败属预期，B1 修复。

---

## Task B1: 命令层 + 前端契约与壳（串行）

**Files:** Modify `src-tauri/src/lib.rs`、`src/types.ts`、`src/api.ts`、`src/App.css`、`src/App.tsx`、`src/SkillsTab.tsx`；Create `src/SettingsPanel.tsx`、`src/SourceView.tsx`、`src/DomainView.tsx`（后两者占位）

- 命令按 spec §7：`scan_all`（发现 → `skills::scan` → `save_sync_set` → 返回）、`set_source_targets`、`set_skill_enabled`、`propose_all`、`apply_all`（按每条动作找回 source/target 算 `link_style`，分组调用 `sync::execute`，合并报告）、`split_whole_link(target_id)`（找目标与 `linked_whole_to` 的 source）、`add_source`/`remove_source`。删除 `scan_domain`/`propose`/`apply`。
- `types.ts`：与 §2 一一对应的 TS 类型（`SourceKind`/`TargetScope` 为 `type` 判别联合）。`api.ts` 七个方法。
- `SkillsTab.tsx`：持有 `overview`、`view: "source" | "domain"`、`busy`、`report`、`confirmClean`；顶部工具栏（视图切换、摘要 `sources` 个本体位置 / `pendingMissing` 处待同步 / `broken` 处坏链、"同步（N）"、"清理坏链（N）"二次确认、"刷新"）；把 `overview` 与回调（`onChange` = 重扫）传给 `<SourceView>` 或 `<DomainView>`。占位组件先渲染"待实现"。
- **设置面板**（作者要求：harness 选择是低频操作，不常驻侧栏）：`App.tsx` 侧栏底部删掉 Harness 勾选区，改为一个「设置」按钮；`SettingsPanel.tsx` 是居中弹层（`.modal-backdrop` + `.modal`），两部分：「Harness」（检测到的 harness 复选框，`api.setHarnessEnabled`）和「本体位置」（`settings.manualSources` 列表，「添加」用 `api.pickDirectory` → `api.addSource`，每项「移除」→ `api.removeSource`；需要新命令 `list_manual_sources() -> Vec<String>`）。关闭面板时触发一次重扫（`scanVersion + 1`）。
- `App.css`：`.modal-backdrop`、`.modal`、卡片 `.source-card`、目标勾选行 `.target-picks`、`.whole-link` 徽标、`tr.disabled` 淡显、域分组标题 `.domain-group`。
- [ ] `cargo check --workspace && cargo clippy --workspace --all-targets -- -D warnings && npm run build`
- [ ] 提交 `feat(app): v3 commands, typed API and skills tab shell with view switch`

---

## Task C1: SourceView（并行）

**Files:** Modify `src/SourceView.tsx`

props：`{ overview: Overview; busy: boolean; onChange: () => Promise<void>; onError: (m: string) => void }`。每个 `Source` 一张卡片：标题 `label` + 路径；目标勾选行（全部 `targets`，勾选状态来自 `syncSet.sources[source.id].targets`，切换调 `api.setSourceTargets` 后 `onChange`）；矩阵：行首 skill 名 + 行级复选框（`api.setSkillEnabled`），列为该 source 已勾选的目标，格子符号 ✓ Linked、○ Missing、✗ Broken、→ Foreign、⚠ Duplicate、– Unwritable，`title` 显示状态与路径；列头 `linkedWholeTo === source.id` 时显示"整目录链接"徽标与"拆成逐项链接"按钮（二次确认后 `api.splitWholeLink`，然后 `onChange`）；禁用行 `tr.disabled`。Manual 类卡片标题旁只显示「手动添加」标签；增删本体位置在设置面板里做（B1）。
- [ ] `npm run build`；提交 `feat(app): source-centric view with two-level sync selection`

## Task C2: DomainView（并行）

**Files:** Modify `src/DomainView.tsx`

props 同 C1。按 `TargetScope` 分组：先"全局"，再每个项目（用项目路径末段作标题）。每组一张表：列 = 该组目标；行 = 所有 (source, skill)，行首 skill 名和只读的"本体位置" `label`；格子符号同 C1；无勾选控件。
- [ ] `npm run build`；提交 `feat(app): domain view over the same overview`

## 波次 C 合并（控制器）
`npm run build`、`cargo check --workspace`；推送。

---

## Task D: 收尾

**Files:** `docs/manual-checks.md`、本计划附录、`docs/specs/2026-09-06-source-centric-sync-design.md` 状态

- 手动清单重写 Skills tab 部分：本体位置卡片数量与真机一致；默认勾选；取消一个项目目标后"同步"不再包含它；行级禁用；拆分 `weibo_assistant · Claude Code` 前先在 WeiboAP 里验证软链识别；按域视图与卡片视图数据一致；坏链清理。
- 计划末尾追加"实施偏差"；spec 状态改"已实现"。
- 提交 `docs: manual checks and deviations for source-centric sync`，推送。

## 实施偏差（2026-09-06 记录）

- Task 0：`models.rs` 的枚举光靠 `#[serde(tag = "type", rename_all = "camelCase")]` 不够覆盖各变体字段名，补了 `rename_all_fields = "camelCase"`。
- A2：`discovery::sources` 的签名是 `sources(env, harnesses, projects, manual: &[PathBuf])`，没有走计划里设想的整个 `Settings`（并行阶段 `Settings.manual_sources` 尚未落地，命令层直接把 `settings.manual_sources` 作为第四个参数传入）；`Harness.extra_source_dirs` 字段只用于展示，通配展开由 `sources()` 内部通过 `extra_source_templates()` 重新查内置 harness 表得到，不读这个字段。
- A3：坏链扫描（`propose` 的 `BrokenLink`）跳过 `linked_whole_to` 不为空的目标——整目录链接的目标读进去就是本体位置本身，不能把本体位置内部的坏链当成目标坏链清理。
- A4 合并后按三条真机裁定修了 core：仓库类本体位置（通用仓库 / 项目仓库 / 手动添加）把指向目录的软链条目也认作 skill（harness 消费目录仍只认真实目录）；目标路径就是本体位置本身时（如 WeiboAP custom 目录）该 (source, target) 全部格子直接判 Linked；项目仓库默认只勾选本项目的目标，不再默认勾全部全局目标。
- 作者要求把 harness 选择与手动添加本体位置从侧栏移进「设置」弹层（低频操作不常驻侧栏），B1 据此新增 `SettingsPanel.tsx` 与 `list_manual_sources` 命令。
- 控制器在合并波次 A 之后修了一处遗留：`CellState` 补 `Copy` derive 后 `skills.rs` 测试里仍有一处 `.clone()`，删掉以消除 clippy 警告。
- `cargo test -p symsync-core`：56 个测试全部通过。

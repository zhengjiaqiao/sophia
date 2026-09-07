# 单视图 + 域内本体源管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec v4 把两种视图合为域视图，内置本体源管理，同步集改为按 (目标, 本体位置) 的 skill 选择。

**Architecture:** `discovery`、`fs`、`sync`、拆分整目录链接不变。`models` 新增 v4 类型；`store` 换同步集文件格式（旧文件降级为空）；`skills` 重写 `scan`/`propose` 为按域组织并新增三个同步集纯函数；命令层三个新命令替换两个旧命令；前端删本体位置视图，新增引入弹层，侧栏加「全部」。

**Spec:** `docs/specs/2026-09-07-single-view-design.md`（v4）；沿用部分见 v3。

## Global Constraints

- serde camelCase；`Pick` 用 `#[serde(rename_all = "camelCase")]` 外部标签：`"all"` / `{"only":[...]}`。
- 域 key：`"global"` 或 `"project:<normalized path>"`；域 label：`全局` / `projectLabel ?? 路径末段`。
- 域内目标 D = `targets` 中 scope 属于该域的全部目标；`set_pick`/`import_source`/`remove_source` 一律作用于 D 内每个目标；读取时合并：任一 `All` → `All`，否则名单并集，都没有 → 未引入。
- 行来源三类（自有全部 / 已链接的那些 / 已引入的），并集去重；只有 `imported && enabled` 的行生成 Create。
- 不搬本体、不复制；删除只有坏链清理与拆分整目录链接。TDD；clippy `-D warnings`；Chinese comments/UI；Conventional Commits。并行任务只碰各自 Files。

---

## Order of work

```
T0 models ─→ ┬ A1 store  ┐
             └ A2 skills ┼─→ B1 命令层 + 前端契约/壳/域页 ─→ C1 ImportDialog ─→ D 收尾
```
分支 `feat/rust-pivot`（PR #4）。并行任务用 `.worktrees/<id>`。

## Task 0: v4 类型（`crates/core/src/models.rs`）

```rust
#[serde(rename_all = "camelCase")]
pub enum Pick { All, Only(BTreeSet<String>) }
#[derive(Default)] pub struct SyncSet { pub picks: BTreeMap<String, BTreeMap<String, Pick>> }   // target id → source id → Pick
pub struct DomainRow { pub source_id: String, pub skill: String, pub imported: bool, pub linked: bool, pub enabled: bool, pub cells: Vec<Cell> }
pub struct ImportedSource { pub source_id: String, pub pick: Pick }
pub struct DomainPage { pub key: String, pub label: String, pub targets: Vec<Target>, pub imported: Vec<ImportedSource>,
                        pub rows: Vec<DomainRow>, pub broken: Vec<PlannedAction>, pub pending_missing: usize }
pub struct Overview { pub domains: Vec<DomainPage>, pub sources: Vec<Source>, pub sync_set: SyncSet }
```
删除 v3 的 `SourceSync`、旧 `SyncSet`、`Summary`（`Cell` 保留）。序列化测试：`Pick::All` → `"all"`，`Pick::Only({"a"})` → `{"only":["a"]}`；空 `SyncSet` → `{"picks":{}}`。`cargo test -p symsync-core models::` 通过（`skills.rs`/`store.rs` 暂时编译失败属预期——为避免阻塞，本任务把 `skills.rs` 与 `store.rs` 中引用旧类型的代码用最小改动改到能编译：`store.rs` 的 `load/save_sync_set` 改用新 `SyncSet`；`skills.rs` 里删除依赖旧 `SyncSet`/`Summary` 的函数体与测试，只留空壳函数签名 `pub fn scan(...) -> Overview { unimplemented!() }` 等；A2 随后重写）。提交 `feat(core): v4 pick-based sync set and domain page models`。

## Task A1: store（`crates/core/src/store.rs`，并行）
- `load_sync_set`：文件缺失 → 空；解析失败（旧格式）→ 空并**覆盖写回空集**，不报错。测试：旧格式 `{"sources":{...}}` 载入得到空集且文件被重写为 `{"picks":{}}`；新格式往返；`.tmp` 无残留。提交 `feat(core): pick-based sync set persistence with legacy fallback`。

## Task A2: skills 重写（`crates/core/src/skills.rs`，并行）
```rust
pub fn domain_key(scope: &TargetScope) -> String; pub fn domain_label(scope: &TargetScope) -> String;
pub fn scan(sources: &[Source], targets: &[Target], sync_set: &SyncSet) -> Overview   // 自有本体位置默认写入 All（仅 D 内目标）
pub fn propose(o: &Overview) -> Vec<PlannedAction>                                   // imported && enabled 的 Missing → Create；坏链跳过 linked_whole_to 目标
pub fn merged_pick(sync_set: &SyncSet, target_ids: &[String], source_id: &str) -> Option<Pick>
pub fn set_pick(sync_set: &mut SyncSet, target_ids: &[String], source_id: &str, skill: &str, enabled: bool, all_skills: &[String])
pub fn import_source(sync_set: &mut SyncSet, target_ids: &[String], source_id: &str, pick: Pick)
pub fn remove_source(sync_set: &mut SyncSet, target_ids: &[String], source_id: &str)
pub fn link_style(source: &Source, target: &Target) -> LinkStyle; pub fn split_whole_link(...)  // 不变
```
行规则见 spec §3；`set_pick`：`All` 且 enabled=false → `Only(all_skills − skill)`；`Only` 增删；名单为空 → 删除条目。`DomainRow.enabled` = imported 且 (All 或名单含之)；`linked` = 任一 D 目标格为 Linked。`DomainPage.imported` 按 merged_pick 列出。域顺序：全局在前，其余按 targets 首现顺序。测试覆盖 spec §7 清单。提交 `feat(core): domain pages with pick-based sync set`。

## Task B1: 命令层 + 前端（串行）
- `src-tauri/src/lib.rs`：`scan_all` 返回 v4 `Overview`（写回补默认后的同步集）；新增 `set_pick(target_ids, source_id, skill, enabled)`（需要 all_skills：从 overview 的 sources 里取）、`import_source(target_ids, source_id, skills: Option<Vec<String>>)`、`remove_source(target_ids, source_id)`；删除 `set_source_targets`、`set_skill_enabled`；`add_source`/`remove_source` 手动来源命令改名 `add_manual_source`/`remove_manual_source`（避免与同步集的 remove_source 混淆）；其余不变。
- `src/types.ts`、`src/api.ts` 对齐；`src/App.tsx`：侧栏 `全部` / `全局` / 各项目（label 来自 `DomainPage.label`）+ 设置，去掉视图切换；`SkillsTab.tsx`：容器，按选中 key 渲染一个或全部 `DomainPage`，工具栏聚合（本域/全部 待同步、坏链、同步、清理、刷新），结果提示逻辑保留；`DomainView.tsx` 重写为渲染一个 `DomainPage`：已引入来源标签行（label + 全部/n 个 + 编辑 + 移除）、「引入来源…」按钮（打开 `ImportDialog` 占位）、表格（行首勾选 → `set_pick`，skill，本体位置，各目标列，可排序）、坏链表；删除 `SourceView.tsx`；`SettingsPanel.tsx` 用改名后的手动来源命令。`npm run build && cargo check --workspace && clippy`。提交 `feat: single domain view with pick-based sync commands`。

## Task C1: `src/ImportDialog.tsx`
props `{ overview, domain: DomainPage, initialSourceId?: string, onClose, onChange, onError }`；左栏 `overview.sources`（kind 标签），右栏该来源 skill 列表 + 「全部」开关；预填当前 pick；「引入」→ `api.importSource(domain.targets.map(t=>t.id), sourceId, all ? null : names)`；「选择文件夹…」→ `pickDirectory` → `addManualSource` → `onChange()` 后选中它。样式复用 `.modal*`。提交 `feat(app): import dialog for domain sources`。

## Task D: 收尾
`docs/manual-checks.md` Skills 部分重写为单视图；本计划附录「实施偏差」；spec 状态。`make test`。提交并推送。

## 实施偏差（2026-09-07 记录）

- `Pick::Some` 改名为 `Pick::Only`（避免与 `Option` 的 `Some` 撞名混淆），spec §2 已同步。
- Task A2：`DomainRow` 的排序键定为 `(skill, 源 label, 源 id)`，而不是仅按发现顺序。
- Task B1：`DomainView.tsx` 在域页的目标列表头上保留了"整目录链接 / 拆成逐项链接"入口（沿用 v3 行为），未挪到别处。
- Task B1：工具栏文案「全部」页与单域页共用同一套（待同步 N / 坏链 K / 同步 / 清理坏链 / 刷新），不单独区分文案。
- Task C1：`ImportDialog.tsx` 增加了 `.modal.wide` 样式类以容纳左右两栏；「全部」开关关闭时保留逐项勾选状态（不清空 `names`）。
- Task A1：同步集旧文件解析失败时静默重建为空集并覆盖写回，不弹错误提示。
- core 测试共 62 个。

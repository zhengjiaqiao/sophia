# Spec v4: 单视图 + 域内本体源管理

- 对应 intent：`docs/intent/2026-09-07-single-view-source-management.md`
- 替代：`docs/specs/2026-09-06-source-centric-sync-design.md`（v3；§3 发现、§4 扫描格状态、拆分、坏链、§5 store 基础、§6 harness 表、§9 错误处理继续有效，本文只写变化）
- 日期：2026-09-07
- 状态：已实现（PR #4，feat/rust-pivot）

## 1. 目标

去掉本体位置视图；域视图内置本体源管理；同步集改为按 (本体位置, 目标) 记录 skill 选择。

## 2. 同步集（`models.rs` / `store.rs`）

```rust
#[serde(rename_all = "camelCase")]
pub enum Pick { All, Only(BTreeSet<String>) }                // 该目标从该本体位置引入哪些 skill；序列化为 "all" / {"only":[...]}
pub struct SyncSet { pub picks: BTreeMap<String /* target id */, BTreeMap<String /* source id */, Pick>> }
```
- 文件仍是 `syncset.json`；结构变化，旧文件不兼容：`load_sync_set` 解析失败时视为空并写回空集（记一条日志），不报错。
- 语义：`picks[target][source]` 存在 = 该本体位置已引入该目标；`All` = 全部 skill；`Only(names)` = 只这些。
- 行首勾选：`All` 状态下取消某个 skill → 转为 `Only(全部 - 它)`；`Only` 状态下勾选/取消 → 增删名单；名单为空 → 删除该条目（等于未引入）。

## 3. 域内行（`skills.rs::scan`）

对每个域（目标集合 D）：

- **自有本体位置**（全局：通用仓库、harness 全局目录、手动；项目：该项目的 `.agents/skills`）：全部 skill 成行，默认视为已引入：扫描时若 `picks[t][s]` 不存在则写入 `All`（仅对 D 内目标）。
- **已链接**：任一 `t ∈ D` 下 `t/name` 是解析到本体位置 `s` 的 `name` 的软链 → 行 (s, name)。不把 s 的其他 skill 带入。不写同步集。
- **已引入**：`picks[t][s]` 存在 → `All` 时 s 的全部 skill 成行，`Some` 时名单内的成行。
- 三类并集去重。格状态规则不变（Linked / Missing / Broken / Foreign / Duplicate / Unwritable）。
- `Overview` 改为按域组织：`domains: Vec<DomainView { key, label, targets, rows: Vec<Row { source_id, skill, imported: bool, linked: bool, enabled: bool, cells }> , broken: Vec<PlannedAction> }>`，另附 `sources: Vec<Source>` 供本体源管理弹层列出。`summary` 为每域 `pending_missing`、`broken`。

## 4. 动作

- `propose(overview)`：对每域每行，`enabled && imported`（已引入且未取消）的行在 `t ∈ D` 上 Missing → Create；"已链接"但未引入的行不生成 Create（它只是事实展示）。坏链同 v3。
- 行首勾选调用 `set_pick(target_ids, source_id, skill, enabled)`；引入整个本体位置调用 `import_source(target_ids, source_id, skills: Option<Vec<String>>)`（None = All）；移除调用 `remove_source(target_ids, source_id)`。
- 手动文件夹来源：`add_manual_source(path)` 仍存 `settings.manual_sources`，随后在弹层里引入。

## 5. 命令层

`scan_all() -> Overview`；`set_pick`、`import_source`、`remove_source`（同步集）；`propose_all`、`apply_all`、`split_whole_link`、`add_manual_source`/`remove_manual_source`、harness/项目/规则命令不变。删除 `set_source_targets`、`set_skill_enabled`。

## 6. 前端

- 侧栏：视图切换去掉，列表为「全部」、「全局」、各项目（含 WeiboAP 各 agent）+ 设置。「全部」页把每个域作为一节顺序展示（各节含自己的已引入来源标签、表格、坏链表），工具栏聚合为「全部待同步 N / 坏链 K / 同步全部 / 清理全部坏链 / 刷新」，一键处理全局与所有项目。
- 域页：工具栏（本域待同步 N / 坏链 K / 同步本域 / 清理本域坏链 / 刷新）；"已引入来源"标签行（每个标签：label，`All` 或 `n 个 skill`，"编辑"、"移除"）；"引入来源…"按钮打开弹层；表格（行首勾选、skill、本体位置、各目标列，可排序）；坏链表；结果提示。
- 引入弹层：左侧本体位置列表（所有已发现 + 手动，标 kind），右侧该位置的 skill 复选（"全部"开关 + 逐项），底部"引入"。已引入的位置显示当前名单可改。"选择文件夹…"把一个目录加入手动来源并选中。
- `SourceView.tsx` 删除；`DomainView.tsx` 承载域页；新增 `ImportDialog.tsx`。

## 7. 测试

core：同步集读写与旧文件降级；三类行的并集与"已链接不带入同源其他 skill"；自有默认 `All` 写入；`propose` 只取已引入行；`set_pick` 的 All→Some 转换与空名单删除；`import_source`/`remove_source`。前端构建。

## 8. 迁移

- `syncset.json` 作废重建；`settings.json` 不变。
- 删除 `SourceView.tsx`、`sort.ts` 保留，`SkillsTab.tsx` 简化为域页容器。
- v3 spec 标"已被替代"。

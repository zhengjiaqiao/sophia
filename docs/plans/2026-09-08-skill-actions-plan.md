# skill 操作 v5.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入 / 删除作用于 skill，补齐 / 取消作用于单条软链；按钮始终可见，不合法时禁用并说明。

**Architecture:** core 的动作单位从行改为格（`CellRef`），行加 `own`，目标列名只放 harness 名。前端把行、格、弹层选择都展开成格交给同两个命令；删除类动作统一走一个确认条。

**Tech Stack:** Rust 2021 + Tauri 2 + React/TS。

**Spec:** `docs/specs/2026-09-07-facts-and-actions-design.md` §10（v5.1 修订）

## Global Constraints

- `clippy -D warnings` 零警告；core 不依赖 tauri。
- 判断条目类型用 `fs::entry_kind`；同一处用 `fs::same_real`；删软链只用 `fs::remove_link` 且删前重校验。
- serde camelCase；`src/types.ts` 一一对应。
- 测试用 `test_support::TempTree`（`dir(rel)`、`link(at, to)`）搭真实文件树。
- 注释与 UI 文案中文；Conventional Commits。
- Task 1 与 Task 2 并行，文件不相交。

---

### Task 1: core + 命令层

**Files:**
- Modify: `crates/core/src/models.rs`
- Modify: `crates/core/src/skills.rs`
- Modify: `crates/core/src/discovery.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces：命令 `propose_links(cells: Vec<CellRef>)`、`propose_unlinks(cells: Vec<CellRef>)`；`DomainRow.own`；`Target.label` 新规则。JSON 形状见 spec §10.1。

- [ ] **Step 1: 模型**

`models.rs`：删 `RowRef`，加

```rust
/// 前端选中的一格：本体位置 id + skill + 目标 id。目标决定域；格不必已出现在表里（引入弹层用）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRef {
    pub source_id: String,
    pub skill: String,
    pub target_id: String,
}
```

`DomainRow` 加 `pub own: bool`（注释：该行的本体位置属于本域）。把 `RowRef` 的序列化测试改成 `CellRef` → `{"sourceId":"/a","skill":"x","targetId":"claude-code"}`。

- [ ] **Step 2: skills.rs 测试改成按格**

`row_ref` 辅助改为 `cell(source: &Source, skill: &str, target: &Target) -> CellRef`。`rows` 辅助返回 `(source_id, skill, own)`；`rows_are_own_skills_plus_linked_ones_only` 的断言补上 own：全局域两行 `own = true`；项目域 universal 的 `a` 是 `false`，`c`、`d` 是 `true`。

`propose_links_creates_only_missing_cells_even_for_rows_not_in_the_page` 改成传格：

```rust
let cells = vec![
    cell(&sources[0], "a", &targets[0]),   // Missing → Create
    cell(&sources[0], "a", &targets[1]),   // Missing → Create
    cell(&sources[0], "b", &targets[0]),   // Duplicate：忽略
    cell(&sources[0], "b", &targets[1]),   // Missing → Create
    cell(&sources[0], "c", &targets[0]),   // Foreign：忽略
    cell(&sources[0], "a", &targets[0]),   // 重复：去重
    cell(&sources[0], "d", &targets[2]),   // 引入场景：项目页里没有这行
    cell(&sources[0], "zzz", &targets[0]), // skill 不存在：忽略
    CellRef { source_id: sources[0].id.clone(), skill: "a".into(), target_id: "nope".into() }, // 目标不存在：忽略
];
// 期望 target_path：claude/a, codex/a, codex/b, proj_claude/d
```

`propose_unlinks_targets_only_real_links_outside_whole_linked_dirs`：传 `a`、`b` 在三个目标上的全部 6 格，期望仍只有 `claude/a` 一条 Unlink。

- [ ] **Step 3: 实现按格**

`propose_by` 改为遍历 `cells`：按 `target_id` 找目标（找不到忽略），其余逻辑不变。`scan` 里 `DomainRow { own: source_domain(&source.kind) == key, .. }`。跑 `make test-core`。

- [ ] **Step 4: 目标列名，先改测试**

`discovery.rs` 测试：`targets` 相关断言里 `"WeiboAP · agent_1"` → `"WeiboAP"`，`"weibo_assistant · Claude Code"` → `"Claude Code"`；其他项目列断言同理（`"<项目> · 通用仓库"` → `"通用仓库"`）。用 `grep -n '· ' crates/core/src/discovery.rs` 找全。全局列与 `A / B` 合并规则不变。

- [ ] **Step 5: 实现目标列名**

`targets()`：agent 目录 push 的 label 改为该 harness 的 `display_name`（`AgentProject` 加 `display_name: String` 字段，或从 `harnesses` 里按 `harness_id` 查）；`TargetScope::Project.project_label` 仍传 `Some(a.label)`（域名要用）。项目列 `format!("{name} · 通用仓库")` → `"通用仓库".to_string()`，`format!("{name} · {}", h.display_name)` → `h.display_name.clone()`。`AgentProject.label` 若只剩域名用途，保留。跑 `make test-core && make lint`。

- [ ] **Step 6: 命令层**

`lib.rs`：`propose_links(cells: Vec<CellRef>, ..)`、`propose_unlinks(cells: Vec<CellRef>, ..)`，`RowRef` 引用全部换掉。`cargo check --workspace` 通过。提交：`feat(core): cell-level link/unlink proposals, row ownership, harness-only target labels`。

---

### Task 2: 前端

**Files:**
- Modify: `src/types.ts`、`src/api.ts`、`src/SkillsTab.tsx`、`src/DomainView.tsx`、`src/ImportDialog.tsx`、`src/App.css`
- Modify: `docs/manual-checks.md`（只改 Skills 一节）

**Interfaces:**
- Consumes：`propose_links({ cells })`、`propose_unlinks({ cells })`，`CellRef { sourceId, skill, targetId }`，`DomainRow.own`，`Target.label` 已是 harness 名。以 spec §10 为准，不等 Task 1。

- [ ] **Step 1: types / api**

`RowRef` → `export interface CellRef { sourceId: string; skill: string; targetId: string }`；`DomainRow` 加 `own: boolean`；`api.proposeLinks(cells: CellRef[])` → `invoke("propose_links", { cells })`，`proposeUnlinks` 同。

- [ ] **Step 2: SkillsTab**

- 新增 `pendingUnlink: PlannedAction[] | null`、`notice: string | null`（6 秒消失，样式复用 `.report`）。切换侧栏时都清空。
- `link = async (cells: CellRef[])`：`proposeLinks` → 空则 `setNotice("没有需要建立的链接")`；否则 `run(acts, false)`。
- `askUnlink = async (cells: CellRef[])`：`proposeUnlinks` → 空则 `setNotice("没有可删除的链接")`；否则 `setPendingUnlink(acts)`。
- 确认条：`将删除 {n} 条软链接，只删链接本身，不删任何真实文件。` + `确认删除`（`run(pendingUnlink, false)`）+ `取消`。与 `confirmClean` 互斥。
- 行展开成格的辅助：`cellsOf(row) = row.cells.map(c => ({ sourceId: row.sourceId, skill: row.skill, targetId: c.targetId }))`。
- 工具栏：`补齐缺失（{missing} 处）`（勾选行全部格 → `link`）、`删除 skill（{deletable} 个）`（`deletable` = 勾选行里 `!row.own` 且有 linked 且目标非整目录链接的行数；点击把这些行的格 → `askUnlink`；title `本体在本域的 skill 不会被删除`）、`清理坏链（K）`、`刷新`。
- `DomainView` 新 props：`onLink`、`onUnlink`（= askUnlink）、`onNotice`。

- [ ] **Step 3: DomainView**

- 表头末尾 `<th>操作</th>`；每行末尾：

```tsx
<td className="row-actions">
  <button disabled={busy || !hasMissing} title={hasMissing ? "给缺失的 harness 建链" : "没有缺失的链接"} onClick={() => void onLink(allCells)}>补齐</button>
  <button disabled={busy || row.own || !hasUnlinkable} title={row.own ? "本体在本域，不能删除；可逐个取消某个 harness 下的链接" : hasUnlinkable ? "删除它在本域所有 harness 下的链接" : "没有可删除的链接"} onClick={() => void onUnlink(allCells)}>删除</button>
</td>
```

`hasUnlinkable` = 有 `linked` 格且其目标 `linkedWholeTo === null`。

- 格改为 `<button className={`cell ${state}`} disabled={busy} title=… onClick=…>{symbol}</button>`，行为与 title 按 spec §10.3；`CELL_TEXT` 改成那组原因文案。
- 标签行、排序、坏链表、拆分入口不变。表头排序按钮不受影响。

- [ ] **Step 4: ImportDialog**

- 左栏每项显示 `s.label` 与 `<span className="muted">未引入 {n} 个</span>`，n = `s.skills.filter(sk => !page.rows.some(r => r.sourceId === s.id && r.skill === sk)).length`。
- 中栏：`fresh` = 本域没有的 skill（复选 + "全部"开关，只作用于 fresh）；`present` = 已有的，渲染为 `<div className="muted">{skill} · 已引入</div>`，放在下段，段间一条细线。
- 右栏：`targetIds` state，初值 = `page.targets.filter(t => t.linkedWholeTo === null).map(t => t.id)`；每个目标一个复选，`linkedWholeTo !== null` 的禁用并 title `整目录链接，先拆成逐项链接`。
- `引入`：disabled 当 `names.length === 0 || targetIds.length === 0`；`cells = names.flatMap(skill => targetIds.map(targetId => ({ sourceId: selected, skill, targetId })))` → `api.proposeLinks(cells)` → 空则 `onNotice("所选 skill 在所选 harness 下都已链接")` 不关；否则 `onReport(await api.applyAll(acts, false))` → `onChange` → `onClose`。
- props 加 `onNotice`。`.import-dialog` 布局改三栏（`App.css`）。

- [ ] **Step 5: 样式与手册**

`App.css`：`button.cell`（去边框与背景、继承格颜色、`cursor: pointer`）、`.row-actions button` 紧凑、`.import-dialog` 三栏、`.import-targets`。`docs/manual-checks.md` Skills 一节按 spec §10.3 增补：行末补齐 / 删除按钮与禁用提示、格点击建链 / 取消、弹层三栏与已引入分段、删除确认条文案。

- [ ] **Step 6: 验证与提交**

`make build-web` 通过，改动文件 `npx prettier --check` 干净（`CustomSyncTab.tsx` 预存漂移不管）。提交：`feat(app): skill-level import/delete and per-link fill/unlink with always-visible actions`。

---

### Task 3: 收尾（控制端）

集成分支 `make test`；spec §10 状态改"已实现"；真机手册。

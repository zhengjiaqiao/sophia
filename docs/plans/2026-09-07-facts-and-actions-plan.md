# 只展示事实，只做动作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉同步集；扫描只产出事实，建链 / 删链按用户当场勾选的行生成动作再执行。

**Architecture:** core 删 `Pick/SyncSet` 与 picks 逻辑，`scan` 纯读；新增 `propose_links / propose_unlinks(sources, targets, &[RowRef])` 与 `ActionKind::Unlink` 的执行分支。命令层换成 `propose_links / propose_unlinks`。前端把行勾选改成临时选择，工具栏三个动作按钮，引入弹层当场建链。

**Tech Stack:** Rust 2021 + Tauri 2 + React/TS。

**Spec:** `docs/specs/2026-09-07-facts-and-actions-design.md`

## Global Constraints

- `clippy -D warnings` 零警告；core 不依赖 tauri。
- 判断条目类型用 `fs::entry_kind`（lstat）；比较是否同一处用 `fs::same_real`；判断"目标目录是否存在"才用 `is_dir()`。
- 删软链只用 `fs::remove_link`，删前必须重校验仍是软链。
- serde 统一 `rename_all = "camelCase"`；`src/types.ts` 与之一一对应。
- 测试用 `test_support::TempTree` 搭真实文件树，不 mock。
- 注释与 UI 文案中文，标识符英文；Conventional Commits。
- Task 1 与 Task 2 并行，文件集不相交；Task 3 收尾。

---

### Task 1: core + 命令层

**Files:**
- Modify: `crates/core/src/models.rs`
- Modify: `crates/core/src/skills.rs`
- Modify: `crates/core/src/sync.rs`
- Modify: `crates/core/src/store.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces（Task 2 按名字调用）：Tauri 命令 `scan_all() -> Overview`、`propose_links(rows: Vec<RowRef>) -> Vec<PlannedAction>`、`propose_unlinks(rows: Vec<RowRef>) -> Vec<PlannedAction>`、`apply_all(actions, clean_broken) -> SyncReport`（不变）。JSON 形状见 spec §2、§7。

- [ ] **Step 1: 模型**

`models.rs`：删 `Pick`、`SyncSet`、`ImportedSource` 及 `pick_serializes_as_externally_tagged_camel_case`、`empty_sync_set_serializes_to_empty_map` 两个测试；`use std::collections::{BTreeMap, BTreeSet}` 随之清理。`CellState` 加首个变体 `Own`（注释：目标目录就是本体位置本身，内容天然到位，不是链接）。`ActionKind` 加末尾变体 `Unlink`（注释：删除一条指向 `source_path` 的软链，`sync::plan` 不产生）。`DomainRow` 只剩 `source_id, skill, cells`；`DomainPage` 只剩 `key, label, targets, rows, broken`；`Overview` 只剩 `domains, sources`。新增：

```rust
/// 前端选中的一行：域 key + 本体位置 id + skill。行不必已出现在表里（引入弹层用）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRef {
    pub domain: String,
    pub source_id: String,
    pub skill: String,
}
```

加一个序列化测试：`RowRef` → `{"domain":"global","sourceId":"/a","skill":"x"}`，`CellState::Own` → `"own"`，`ActionKind::Unlink` → `"unlink"`。

- [ ] **Step 2: 存储**

`store.rs`：删 `load_sync_set`、`save_sync_set` 及 `sync_set_missing_is_empty_and_round_trips`、`legacy_sync_set_file_loads_empty_and_is_rewritten`；模块注释去掉 `syncset.json`。

- [ ] **Step 3: 扫描改纯读，先写测试**

`skills.rs` 测试模块：删 `only`、`ids`（若不再用）、`rows` 辅助改成返回 `(source_id, skill)`；删 `own_sources_default_to_all_only_on_their_own_domain_targets`、`propose_creates_only_for_imported_and_enabled_rows`、`pending_missing_counts_every_missing_cell_of_enabled_rows`、`merged_pick_takes_any_all_then_unions_the_lists`、`set_pick_converts_all_to_a_list_and_drops_empty_ones`、`import_and_remove_source_apply_to_every_target`。改 `rows_are_the_union_of_own_linked_and_imported` 为：

```rust
#[test]
fn rows_are_own_skills_plus_linked_ones_only() {
    let tree = TempTree::new();
    let universal = tree.dir("universal");        // 全局自有：a, b
    let proj_root = tree.dir("proj");
    let store = tree.dir("proj/.agents/skills");  // 项目自有：c, d
    for s in ["a", "b"] { tree.dir(&format!("universal/{s}")); }
    for s in ["c", "d"] { tree.dir(&format!("proj/.agents/skills/{s}")); }
    let claude_global = tree.dir("home/.claude/skills");
    let claude_proj = tree.dir("proj/.claude/skills");
    // 项目目标里只链了 universal 的 a
    tree.link(&claude_proj.join("a"), &universal.join("a"));
    let sources = vec![
        source(&universal, &["a", "b"]),
        store_source(&store, "proj", &proj_root, &["c", "d"]),
    ];
    let targets = vec![
        global("claude-code", &claude_global),
        project(&proj_root, "claude-code", &claude_proj),
    ];
    let ov = scan(&sources, &targets);
    let glob = &ov.domains[0];
    assert_eq!(rows(glob), vec![(sources[0].id.clone(), "a".into()), (sources[0].id.clone(), "b".into())]);
    let proj = &ov.domains[1];
    // 项目域：自有 c、d 全部成行；universal 只有被链的 a，不带入 b
    assert_eq!(
        rows(proj),
        vec![
            (sources[0].id.clone(), "a".into()),
            (sources[1].id.clone(), "c".into()),
            (sources[1].id.clone(), "d".into()),
        ]
    );
    assert_eq!(proj.rows[0].cells[0].state, CellState::Linked);
}
```

再加：

```rust
#[test]
fn target_that_is_the_source_itself_is_own() {
    let tree = TempTree::new();
    let custom = tree.dir("ap/custom");
    tree.dir("ap/custom/x");
    let sources = vec![source(&custom, &["x"])];
    let targets = vec![global("weiboap", &custom)];
    let ov = scan(&sources, &targets);
    assert_eq!(ov.domains[0].rows[0].cells[0].state, CellState::Own);
}
```

`TempTree` API 见 `test_support.rs`：`dir(rel)` 建目录并返回绝对路径，`link(at, to)` 建软链。

- [ ] **Step 4: 实现纯读 scan**

`scan(sources, targets) -> Overview`：删同步集参数、默认 `All` 补写、`picks`/`picked`、`imported`、`pending_missing`；行条件改为 `own || linked()`；`DomainRow { source_id, skill, cells }`；`Overview { domains, sources }`。`cell_state` 里 `same_real(&target.path, &source.path)` 分支返回 `CellState::Own`。删 `propose`、`merged_pick`、`set_pick`、`import_source`、`remove_source`、`put`。模块注释同步改。

跑 `make test-core`：Step 3 两个测试通过，其余编译错误只应来自 `lib.rs`（下一步处理）。

- [ ] **Step 5: propose_links / propose_unlinks，先写测试**

```rust
fn row_ref(domain: &str, source: &Source, skill: &str) -> RowRef {
    RowRef { domain: domain.into(), source_id: source.id.clone(), skill: skill.into() }
}

#[test]
fn propose_links_creates_only_missing_cells_even_for_rows_not_in_the_page() {
    let tree = TempTree::new();
    let universal = tree.dir("universal");
    for s in ["a", "b", "c", "d"] { tree.dir(&format!("universal/{s}")); }
    let claude = tree.dir("home/.claude/skills");
    let codex = tree.dir("home/.codex/skills");
    tree.dir("home/.claude/skills/b");                                   // Duplicate
    tree.link(&claude.join("c"), &tree.dir("elsewhere")); // Foreign
    let proj_root = tree.dir("proj");
    let proj_store = tree.dir("proj/.agents/skills");
    tree.dir("proj/.agents/skills/p");
    let proj_claude = tree.dir("proj/.claude/skills");
    let sources = vec![
        source(&universal, &["a", "b", "c", "d"]),
        store_source(&proj_store, "proj", &proj_root, &["p"]),
    ];
    let targets = vec![
        global("claude-code", &claude),
        global("codex", &codex),
        project(&proj_root, "claude-code", &proj_claude),
    ];
    let proj_key = project_key(&proj_root);
    let rows = vec![
        row_ref("global", &sources[0], "a"),
        row_ref("global", &sources[0], "b"),
        row_ref("global", &sources[0], "c"),
        row_ref("global", &sources[0], "a"),              // 重复行：去重
        row_ref(&proj_key, &sources[0], "d"),             // 引入场景：universal 的 d 不在项目页里
        row_ref("global", &sources[0], "zzz"),            // skill 不存在：忽略
        row_ref("nope", &sources[0], "a"),                // 域不存在：忽略
    ];
    let mut paths: Vec<PathBuf> = propose_links(&sources, &targets, &rows)
        .into_iter()
        .inspect(|a| assert_eq!(a.kind, ActionKind::Create))
        .map(|a| a.target_path)
        .collect();
    paths.sort();
    let mut expect = vec![claude.join("a"), codex.join("a"), codex.join("b"), codex.join("c"), proj_claude.join("d")];
    expect.sort();
    assert_eq!(paths, expect);
}

#[test]
fn propose_unlinks_targets_only_real_links_outside_whole_linked_dirs() {
    let tree = TempTree::new();
    let universal = tree.dir("universal");
    for s in ["a", "b"] { tree.dir(&format!("universal/{s}")); }
    let claude = tree.dir("home/.claude/skills");
    tree.link(&claude.join("a"), &universal.join("a")); // Linked
    // b 缺失
    let whole = tree.dir("home/.cursor").join("skills");
    tree.link(&whole, &universal);                                              // 整目录链接
    let sources = vec![source(&universal, &["a", "b"])];
    let mut whole_t = global("cursor", &whole);
    whole_t.linked_whole_to = Some(sources[0].id.clone());
    let own_t = global("weiboap", &universal);                                  // Own
    let targets = vec![global("claude-code", &claude), whole_t, own_t];
    let rows = vec![row_ref("global", &sources[0], "a"), row_ref("global", &sources[0], "b")];
    let acts = propose_unlinks(&sources, &targets, &rows);
    assert_eq!(acts.len(), 1);
    assert_eq!(acts[0].kind, ActionKind::Unlink);
    assert_eq!(acts[0].target_path, claude.join("a"));
    assert_eq!(acts[0].source_path, universal.join("a"));
}
```

- [ ] **Step 6: 实现两个 propose**

```rust
/// 选中行在其域各目标上的 Missing 格 → Create。域 / 本体位置 / skill 对不上的行忽略；按 target_path 去重
pub fn propose_links(sources: &[Source], targets: &[Target], rows: &[RowRef]) -> Vec<PlannedAction> {
    propose_by(sources, targets, rows, |state, _| state == CellState::Missing, ActionKind::Create)
}

/// 选中行在其域各目标上的 Linked 格（目标非整目录链接）→ Unlink。规则同上
pub fn propose_unlinks(sources: &[Source], targets: &[Target], rows: &[RowRef]) -> Vec<PlannedAction> {
    propose_by(
        sources, targets, rows,
        |state, target| state == CellState::Linked && target.linked_whole_to.is_none(),
        ActionKind::Unlink,
    )
}

fn propose_by(
    sources: &[Source],
    targets: &[Target],
    rows: &[RowRef],
    wanted: impl Fn(CellState, &Target) -> bool,
    kind: ActionKind,
) -> Vec<PlannedAction> {
    let by_id: BTreeMap<&str, &Source> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let mut out = Vec::new();
    for row in rows {
        let Some(source) = by_id.get(row.source_id.as_str()) else { continue };
        if !source.skills.iter().any(|s| s == &row.skill) { continue }
        for target in targets.iter().filter(|t| domain_key(&t.scope) == row.domain) {
            let path = target.path.join(&row.skill);
            if !wanted(cell_state(source, &row.skill, target, &path), target) { continue }
            if !seen.insert(path.clone()) { continue }
            out.push(PlannedAction {
                kind,
                item_name: row.skill.clone(),
                source_path: source.path.join(&row.skill),
                target_path: path,
                target: target.path.clone(),
            });
        }
    }
    out
}
```

`project_key` 若测试要用，改成 `pub(crate)`。跑 `make test-core`。

- [ ] **Step 7: Unlink 执行，先写测试**

`sync.rs` 测试：

```rust
fn unlink(link: &Path, source: &Path) -> PlannedAction {
    PlannedAction {
        kind: ActionKind::Unlink,
        item_name: "x".into(),
        source_path: source.to_path_buf(),
        target_path: link.to_path_buf(),
        target: link.parent().unwrap().to_path_buf(),
    }
}

#[test]
fn unlink_removes_only_a_link_that_still_points_at_the_source() {
    let tree = TempTree::new();
    let src = tree.dir("src/x");
    let other = tree.dir("other/x");
    let t = tree.dir("t");
    tree.link(&t.join("good"), &src);
    tree.link(&t.join("elsewhere"), &other);
    tree.dir("t/real");
    let actions = vec![
        unlink(&t.join("good"), &src),
        unlink(&t.join("elsewhere"), &src),
        unlink(&t.join("real"), &src),
    ];
    let report = execute(&actions, false, LinkStyle::Absolute);
    assert_eq!(report.entries[0].outcome, Outcome::Removed);
    assert_eq!(entry_kind(&t.join("good")), EntryKind::Missing);
    assert!(matches!(report.entries[1].outcome, Outcome::Failed(_)));
    assert!(matches!(entry_kind(&t.join("elsewhere")), EntryKind::Symlink(_)));
    assert!(matches!(report.entries[2].outcome, Outcome::Failed(_)));
    assert_eq!(entry_kind(&t.join("real")), EntryKind::Dir);
}
```

- [ ] **Step 8: 实现 Unlink 分支**

`outcome_for` 加（spec §4 原文）：

```rust
ActionKind::Unlink => {
    // 预览到确认之间可能已被换掉：必须仍是软链，且仍指向该本体位置
    if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_))
        || !same_real(&action.target_path, &action.source_path)
    {
        return Outcome::Failed("不再是指向该本体位置的软链接，已跳过".into());
    }
    match remove_link(&action.target_path) {
        Ok(()) => Outcome::Removed,
        Err(e) => Outcome::Failed(e.to_string()),
    }
}
```

`execute` 的文档注释补一句 Unlink 不受 `clean_broken` 影响。跑 `make test-core && make lint`。

- [ ] **Step 9: 命令层**

`lib.rs`：`overview()` 去掉同步集读写，只 `discover` + `skills::scan(&sources, &targets)`；删 `set_pick`、`import_source`、`remove_source`、`propose_all`；新增：

```rust
#[tauri::command]
fn propose_links(rows: Vec<RowRef>, state: tauri::State<'_, AppState>) -> Result<Vec<PlannedAction>, String> {
    let (sources, targets) = discover(&state)?;
    Ok(skills::propose_links(&sources, &targets, &rows))
}

#[tauri::command]
fn propose_unlinks(rows: Vec<RowRef>, state: tauri::State<'_, AppState>) -> Result<Vec<PlannedAction>, String> {
    let (sources, targets) = discover(&state)?;
    Ok(skills::propose_unlinks(&sources, &targets, &rows))
}
```

`generate_handler!` 同步增删。`style_for`、`apply_all`、`split_whole_link` 不动。

- [ ] **Step 10: 验证与提交**

`make test-core && make lint && cargo check --workspace` 全绿。提交：`feat(core): replace the sync set with fact-only scan and explicit link/unlink actions`。

---

### Task 2: 前端

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/SkillsTab.tsx`
- Modify: `src/DomainView.tsx`
- Modify: `src/ImportDialog.tsx`
- Modify: `src/App.css`
- Modify: `docs/manual-checks.md`（只重写 Skills 一节）

**Interfaces:**
- Consumes：Tauri 命令 `scan_all`、`propose_links(rows)`、`propose_unlinks(rows)`、`apply_all(actions, cleanBroken)`、`split_whole_link`、`add_manual_source`（见 spec §2、§6）。Task 1 并行进行，以 spec 为准，不要等它。

- [ ] **Step 1: 类型与 api**

`types.ts`：删 `Pick`、`SyncSet`、`ImportedSource`；`DomainRow { sourceId; skill; cells }`；`DomainPage { key; label; targets; rows; broken }`；`Overview { domains; sources }`；`CellState` 加 `"own"`；`ActionKind` 加 `"unlink"`；新增 `export interface RowRef { domain: string; sourceId: string; skill: string }`。

`api.ts`：删 `setPick`、`importSource`、`removeSource`、`proposeAll`；加

```ts
proposeLinks: (rows: RowRef[]) => invoke<PlannedAction[]>("propose_links", { rows }),
proposeUnlinks: (rows: RowRef[]) => invoke<PlannedAction[]>("propose_unlinks", { rows }),
```

- [ ] **Step 2: SkillsTab 选择状态与工具栏**

- 删 `actions` 状态与 `proposeAll` 的 effect，删 "全部 X 处待同步"。
- 加 `const [excluded, setExcluded] = useState<Set<string>>(new Set())`，键 `rowKey(page, row) = `${page.key}|${row.sourceId}|${row.skill}``；`selectedKey` 变化时清空（并入现有的 reset effect）。
- `isSelected(page, row)`、`toggleRow(page, row)`、`setPageAll(page, selected)` 三个函数通过 props 传给 `DomainView`。
- `selectedRows: RowRef[]` = 渲染中各页里未被排除的行映射成 `{ domain: page.key, sourceId, skill }`。
- 计数：`missing` = 选中行 cells 里 `state === "missing"` 的数量；`unlinkable` = 选中行 cells 里 `state === "linked"` 且所在 target 的 `linkedWholeTo === null` 的数量（target 用 `page.targets.find(t => t.id === cell.targetId)`）。
- 按钮：`补齐缺失（{missing}）` disabled `busy || missing === 0`，点击 `api.proposeLinks(selectedRows)` 后 `run(acts, false)`；`取消链接（{unlinkable}）` disabled `busy || unlinkable === 0`，点击进入 `confirmUnlink` 状态，确认条文案 "只删除软链接本身，不删除任何真实文件。" + "确认删除" / "取消"，确认后 `api.proposeUnlinks(selectedRows)` 再 `run(acts, false)`；坏链与刷新不变。`confirmUnlink` 和 `confirmClean` 互斥（打开一个关另一个），切换侧栏时都重置。
- 新增 `onReport={setReport}` 传给 `DomainView`。

- [ ] **Step 3: DomainView**

- props 改为 `{ overview, page, busy, isSelected(row), onToggle(row), onSelectAll(selected: boolean), onChange, onReport, onError }`。
- 标签行：`const counts = new Map<string, number>()` 按 `row.sourceId` 计数；每个标签 `<span className="tag" title={id} onClick={() => setImporting(id)}>{labelOf(id)} · {n} 个</span>`；删 `page.imported` 与 `linkedOnly`；`引入…` 按钮保留。
- 表头第一列：全选框，`checked = 全部选中`、`indeterminate = 部分选中`（`useRef` + `useEffect`，与 `ImportDialog` 现有写法一致），`onChange={() => onSelectAll(!allSelected)}`。
- 行：删 `className`/`title`；复选框 `checked={isSelected(row)}` `onChange={() => onToggle(row)}`，不再调后端。
- `CELL_SYMBOL` 加 `own: "●"`，`CELL_TEXT` 加 `own: "本体在此"`。
- 删 `pickText` 与 `Pick` 引用。
- `ImportDialog` 传 `onReport`。

- [ ] **Step 4: ImportDialog**

- 标题 `引入 skill 到「{page.label}」`。
- 左栏 ✓ 条件改为 `page.rows.some((r) => r.sourceId === s.id)`。
- 切换本体位置时 `setNames([])`；右栏每个 skill 若 `page.rows.some((r) => r.sourceId === selected && r.skill === skill && r.cells.some((c) => c.state === "linked" || c.state === "own"))` 则在名字后加 `<span className="muted">已链接</span>`。
- `doImport`：

```ts
const rows: RowRef[] = names.map((skill) => ({ domain: page.key, sourceId: selected, skill }));
const acts = await api.proposeLinks(rows);
if (acts.length === 0) {
  onError("所选 skill 都已链接，没有需要建立的链接");
  setBusy(false);
  return;
}
onReport(await api.applyAll(acts, false));
await onChange();
onClose();
```

- props 加 `onReport: (report: SyncReport) => void`；删 `Pick` 相关逻辑。

- [ ] **Step 5: 样式与手册**

`App.css`：加 `td.cell.own`（与 `td.cell.linked` 同色）；删 `tr.disabled`、`.tag button.link`；`.tag` 加 `cursor: pointer`。

`docs/manual-checks.md` Skills 一节改成：

```
- [ ] 「全局」页：通用仓库、Codex、WeiboAP 自有本体位置的全部 skill 成行；WeiboAP custom 目录列显示 ●（本体在此）
- [ ] 项目页：自有 .agents/skills 全部成行；从别处链接进来的 skill 只显示被链接的那些，来源标签显示 `label · n 个`
- [ ] 行首勾选默认全选；表头全选框可整页勾/不勾；切换侧栏后恢复全选
- [ ] 「补齐缺失（N）」：N 随勾选变化；点击后只给勾选行的 ○ 建链，结果框列出每条
- [ ] 「取消链接（M）」：M 只数勾选行里、非整目录链接目标上的 ✓；先出确认条，确认后链接消失、本体目录不动
- [ ] 「引入…」：选本体位置、勾 skill、点引入后当场建链；已链接的 skill 标"已链接"；全部已链接时提示没有需要建立的链接
- [ ] 坏链表与「清理坏链」不变；「全部」页聚合各域计数，动作一键处理全局与所有项目
- [ ] 整目录链接目标：列头显示"整目录链接"，可拆成逐项链接；拆分前该列不计入取消链接
```

- [ ] **Step 6: 验证与提交**

`make build-web` 通过。提交：`feat(app): row selection drives explicit link/unlink actions; import links immediately`。

---

### Task 3: 收尾（控制端自做）

- `docs/specs/2026-09-07-single-view-design.md` 状态改 "已被 v5 替代"。
- `CLAUDE.md` Architecture：`skills.rs`：`scan` / `propose_links` / `propose_unlinks`，本体判定；`store.rs`：`rules.json` / `projects.json` / `settings.json`。
- `make test` 全绿；`make dev` 走一遍 `docs/manual-checks.md` Skills 一节。

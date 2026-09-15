# WeiboAP 助手目录同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** WeiboAP 的写入目标从服务端缓存目录改为各助手目录（全局域扇出、助手域单写），格状态支持"部分覆盖"，界面显示助手名。

**Architecture:** `Target` 从单目录变多目录（`dirs: Vec<PathBuf>`），格状态按目录聚合出 `Partial` 并带 `linked/total` 计数；harness 表新增「托管目录」标记与「助手名数据库」配置；core 只读 SQLite 取助手名，失败降级。

**Tech Stack:** Rust 2021 + Tauri 2 + React/TS，新增 `rusqlite`（bundled）。

**Spec:** `docs/specs/2026-09-15-weiboap-agent-targets.md`

## Global Constraints

- `clippy -D warnings` 零警告；core 不依赖 tauri。
- 条目类型用 `fs::entry_kind`（lstat）；同一处用 `fs::same_real`；「目标目录是否存在」才用 `is_dir()`；`Path::starts_with` 按分量。
- 删软链只用 `fs::remove_link`，删前重校验仍是软链。
- serde `rename_all = "camelCase"`；`src/types.ts` 一一对应。
- 测试用 `test_support::TempTree` 搭真实文件树，不 mock。
- 注释与 UI 文案中文，标识符英文；Conventional Commits。
- Task 1（core）与 Task 2（前端）文件不相交，可并行。

---

### Task 1: core + 命令层

**Files:**
- Modify: `crates/core/Cargo.toml`（加 `rusqlite = { version = "0.32", features = ["bundled"] }`）
- Modify: `crates/core/src/models.rs`
- Modify: `crates/core/src/discovery.rs`
- Modify: `crates/core/src/skills.rs`
- Modify: `crates/core/src/mcp.rs`（仅当它引用了 `Target.path`）
- Modify: `crates/core/data/harnesses.json`
- Modify: `src-tauri/src/lib.rs`

**Interfaces（Task 2 按此对齐，勿改名）:**
- `Target { id, label, dirs: Vec<PathBuf>, scope, linked_whole_to }`，`Target::main_dir() -> &Path`
- `CellState` 新增 `Partial`（JSON `"partial"`）
- `Cell { source_id, skill, target_id, path, state, linked: usize, total: usize }`
- 命令签名与事件名不变。

- [ ] **Step 1: 模型与 harness 表**

`models.rs`：
- `Harness` 加 `#[serde(default)] pub managed_global_dir: bool` 与 `#[serde(default)] pub agent_labels: Option<AgentLabels>`；新增
  ```rust
  /// 从 harness 自己的数据库里取 agent 显示名
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct AgentLabels {
      pub path: String,          // 未展开的模板，含 ~ 与 $VAR
      pub table: String,
      pub id_column: String,
      pub name_column: String,
  }
  ```
- `Target.path: PathBuf` → `pub dirs: Vec<PathBuf>`，补
  ```rust
  impl Target {
      /// 代表目录：列的主路径。`dirs` 由构造方保证非空
      pub fn main_dir(&self) -> &Path { &self.dirs[0] }
  }
  ```
- `CellState` 在 `Missing` 之后加 `/// 多目录列上只有部分目录已到位` `Partial`。
- `Cell` 加 `pub linked: usize, pub total: usize`，`path` 的注释改为「代表路径：`main_dir` 下该 skill 的路径」。
- 加序列化测试：`CellState::Partial` → `"partial"`；`Target` 序列化出 `dirs` 数组。

`data/harnesses.json`：weiboap 条目加 `"managed_global_dir": true` 与
```json
"agent_labels": {
  "path": "~/Library/Application Support/WeiboAP/agents.db",
  "table": "agents",
  "idColumn": "id",
  "nameColumn": "name"
}
```
（字段名按 serde camelCase；`harnesses.json` 的反序列化路径与 `Harness` 同源，确认现有 `HarnessSpec` 是否另有一层——若有，同步加字段并在转换时传递。）

- [ ] **Step 2: discovery — 托管目录与多目录列，先写测试**

```rust
#[test]
fn managed_global_dir_is_a_source_but_never_a_target() {
    let t = TempTree::new();
    let home = t.root();
    // weiboap 的托管目录：有真实 skill
    let custom = t.dir("Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom");
    t.dir("Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom/official-a");
    let e = env(&home, &[]);
    let hs = vec![all_harnesses(&e).into_iter().find(|h| h.id == "weiboap").unwrap()];
    let srcs = sources(&e, &hs, &[], &[]);
    assert!(srcs.iter().any(|s| s.path == custom), "托管目录仍是本体位置");
    let tgts = targets(&e, &hs, &[], &srcs);
    assert!(tgts.iter().all(|x| !x.dirs.contains(&custom)), "托管目录不得成为目标");
}

#[test]
fn agent_dirs_fan_out_into_one_global_column_and_stay_per_agent_domains() {
    let t = TempTree::new();
    let home = t.root();
    let a1 = t.dir("Library/Application Support/WeiboAP/Data/agents/agent_a/.internal-plugins/skills");
    let a2 = t.dir("Library/Application Support/WeiboAP/Data/agents/agent_b/.internal-plugins/skills");
    let e = env(&home, &[]);
    let hs = vec![all_harnesses(&e).into_iter().find(|h| h.id == "weiboap").unwrap()];
    let tgts = targets(&e, &hs, &[], &sources(&e, &hs, &[], &[]));
    let global = tgts.iter().find(|x| x.id == "weiboap").expect("全局扇出列");
    assert_eq!(global.label, "WeiboAP");
    assert_eq!(global.dirs, vec![a1.clone(), a2.clone()]);
    assert!(matches!(global.scope, TargetScope::Global { .. }));
    // 每个助手仍有自己的域
    let per_agent: Vec<&Target> = tgts.iter().filter(|x| x.id.starts_with("project:")).collect();
    assert_eq!(per_agent.len(), 2);
    assert!(per_agent.iter().all(|x| x.dirs.len() == 1));
}

#[test]
fn no_agent_dirs_means_no_global_fan_out_column() {
    let t = TempTree::new();
    let home = t.root();
    t.dir("Library/Application Support/WeiboAP"); // 只有 detect_dir
    let e = env(&home, &[]);
    let hs = vec![all_harnesses(&e).into_iter().find(|h| h.id == "weiboap").unwrap()];
    let tgts = targets(&e, &hs, &[], &[]);
    assert!(tgts.iter().all(|x| x.id != "weiboap"));
}
```

- [ ] **Step 3: discovery — 实现**

- 现有全部 `Target { path: X, .. }` 构造改为 `dirs: vec![X]`；`push` 闭包签名随之调整。
- `global_dir` 分支：`if h.managed_global_dir { continue }`。
- `agent_projects` 之后新增扇出列：把该 harness 展开出的全部 agent skill 目录收集成 `Vec<PathBuf>`（按现有顺序），非空则 `push(h.id.clone(), h.display_name.clone(), dirs, TargetScope::Global { harness_id: h.id.clone() })`。注意现有 `push` 内部用 `is_dir()` 过滤不存在的目录——扇出列要先逐个过滤 dirs，再判断整体是否非空。
- `linked_whole_to` 判定加守卫：`if t.dirs.len() != 1 { continue }`。
- 跑 `make test-core`，此时 `skills.rs` 会编译失败（下一步处理）。

- [ ] **Step 4: skills — 格聚合，先写测试**

```rust
/// 多目录列：a 已链接、b 缺失 → partial 1/2
#[test]
fn partial_cell_counts_linked_dirs() {
    let t = TempTree::new();
    let store = t.dir("store");
    t.dir("store/x");
    let a = t.dir("a");
    let b = t.dir("b");
    t.link(&a.join("x"), &store.join("x"));
    let s = source(&store, &["x"]);
    let tgt = multi("weiboap", &[&a, &b]);
    let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
    let cell = &o.domains[0].rows[0].cells[0];
    assert_eq!(cell.state, CellState::Partial);
    assert_eq!((cell.linked, cell.total), (1, 2));
    // 补齐只针对缺失的那个目录
    let acts = propose_links(std::slice::from_ref(&s), std::slice::from_ref(&tgt),
        &[cell_ref(&s, "x", &tgt)]);
    assert_eq!(acts.len(), 1);
    assert_eq!(acts[0].target_path, b.join("x"));
}

/// Own 与 Linked 混合 → 全部到位
#[test]
fn own_dir_counts_as_linked_in_aggregate() {
    let t = TempTree::new();
    let store = t.dir("store");
    t.dir("store/x");
    let b = t.dir("b");
    t.link(&b.join("x"), &store.join("x"));
    let s = source(&store, &["x"]);
    let tgt = multi("weiboap", &[&store, &b]); // 第一个目录就是本体位置本身
    let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
    let cell = &o.domains[0].rows[0].cells[0];
    assert_eq!(cell.state, CellState::Linked);
    assert_eq!((cell.linked, cell.total), (2, 2));
    assert!(propose_links(std::slice::from_ref(&s), std::slice::from_ref(&tgt),
        &[cell_ref(&s, "x", &tgt)]).is_empty());
}

/// 异常不被部分成功掩盖
#[test]
fn broken_dir_wins_over_partial() {
    let t = TempTree::new();
    let store = t.dir("store");
    t.dir("store/x");
    let a = t.dir("a");
    let b = t.dir("b");
    let c = t.dir("c");
    t.link(&a.join("x"), &store.join("x"));
    t.link(&b.join("x"), &t.root().join("gone")); // 坏链
    let s = source(&store, &["x"]);
    let tgt = multi("weiboap", &[&a, &b, &c]);
    let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
    assert_eq!(o.domains[0].rows[0].cells[0].state, CellState::Broken);
}
```

测试辅助 `multi(id, dirs)` 参照现有 `global()` 写：`Target { id, label: id, dirs: dirs.iter().map(|d| normalize(d)).collect(), scope: TargetScope::Global { harness_id: id.into() }, linked_whole_to: None }`。`cell_ref(source, skill, target)` 用现有 `cell()` 辅助（若名字已占用则复用）。

- [ ] **Step 5: skills — 实现聚合**

把现有 `cell_state(source, skill, target, path) -> CellState` 拆成两层：

```rust
/// 单个目录上的状态
fn slot_state(source: &Source, skill: &str, target: &Target, dir: &Path, path: &Path) -> CellState

/// 整列聚合
fn cell_for(source: &Source, skill: &str, target: &Target) -> Cell {
    let slots: Vec<(PathBuf, CellState)> = target.dirs.iter()
        .map(|d| { let p = d.join(skill); let s = slot_state(source, skill, target, d, &p); (p, s) })
        .collect();
    let total = slots.len();
    let linked = slots.iter().filter(|(_, s)| matches!(s, CellState::Own | CellState::Linked)).count();
    // 异常优先：Broken > Foreign > Duplicate > Unwritable
    let state = if let Some((_, bad)) = slots.iter().find(|(_, s)| matches!(s, CellState::Broken)) { *bad }
        else if let Some((_, bad)) = slots.iter().find(|(_, s)| matches!(s, CellState::Foreign | CellState::Duplicate | CellState::Unwritable)) { *bad }
        else if linked == total { if slots.iter().all(|(_, s)| *s == CellState::Own) { CellState::Own } else { CellState::Linked } }
        else if linked == 0 { CellState::Missing }
        else { CellState::Partial };
    Cell { source_id: source.id.clone(), skill: skill.into(), target_id: target.id.clone(),
           path: target.main_dir().join(skill), state, linked, total }
}
```

`slot_state` 里原先用 `target.path` 的三处改用传入的 `dir`：`linked_whole_to`（多目录恒 None，逻辑自然跳过）、`same_real(dir, &source.path)` → `Own`、其余按 `path` 判。

`propose_by` 改为对 `target.dirs` 逐个求 `slot_state`，命中谓词的 dir 生成动作（`target_path = dir.join(skill)`，`target = dir.clone()`），仍按 `target_path` 去重。

`links_to` 改为「任一 dir 下是解析到该 skill 的软链」。`DomainPage.broken` 改为 `flat_map(|t| t.dirs.iter()).flat_map(broken_links)`，并保留「跳过整目录链接目标」的现有条件。

`split_whole_link` 开头加守卫：`if target.dirs.len() != 1 { return report(vec![失败条目 "多目录列不支持拆分"]) }`，其余用 `main_dir()`。

`link_style` 用 `main_dir()`。

- [ ] **Step 6: skills — 新助手自动补齐**

```rust
/// 多目录列上，缺失的目录全是空目录（新建助手）且已有目录全部到位 → 自动补齐
pub fn fan_out_cells(sources: &[Source], targets: &[Target]) -> Vec<CellRef>
```

对每个 `dirs.len() > 1` 的目标、每个本体位置的每个 skill：逐 dir 求 `slot_state`；仅当「至少一个 dir 已到位」「其余缺失的 dir 全部满足 `read_dir` 为空」「没有任何异常状态」时，产出一个 `CellRef`。空目录判定用 `std::fs::read_dir(dir).map(|mut it| it.next().is_none()).unwrap_or(false)`。

测试两条，对应 AC10 / AC11。

`src-tauri/src/lib.rs` 的 `scan_all`：把 `fan_out_cells` 的结果与现有 `auto_link_cells` 结果合并后一起交给 `propose_links`（合并后去重），其余流程不变。

- [ ] **Step 7: discovery — 助手名**

`Cargo.toml` 加 rusqlite。新增：

```rust
/// 只读打开 harness 自己的数据库，取 agent id → 显示名。任何失败都返回空表
fn agent_label_map(spec: &AgentLabels, env: &Env) -> HashMap<String, String> {
    let ok = |s: &str| !s.is_empty()
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !(ok(&spec.table) && ok(&spec.id_column) && ok(&spec.name_column)) {
        return HashMap::new();
    }
    let Some(path) = resolve_template(&spec.path, env) else { return HashMap::new() };
    // immutable=1：不加锁、不碰 WAL，与运行中的宿主应用互不干扰
    let uri = format!("file:{}?mode=ro&immutable=1", path.display());
    let conn = match rusqlite::Connection::open_with_flags(
        &uri, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI) {
        Ok(c) => c,
        Err(e) => { eprintln!("打不开 {}：{e}", path.display()); return HashMap::new() }
    };
    let sql = format!("SELECT {}, {} FROM {}", spec.id_column, spec.name_column, spec.table);
    let mut out = HashMap::new();
    match conn.prepare(&sql).and_then(|mut st| {
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.flatten().collect::<Vec<_>>())
    }) {
        Ok(pairs) => out.extend(pairs),
        Err(e) => eprintln!("读 {} 失败：{e}", spec.table),
    }
    out
}
```

`agent_projects` 里：对配了 `agent_labels` 的 harness 取一次映射（每个 harness 只查一次），`label = format!("{} · {}", h.display_name, map.get(&dir_name(&root)).cloned().unwrap_or_else(|| dir_name(&root)))`。

测试：用 `rusqlite` 在 `TempTree` 里现建一个含 `agents(id,name)` 的库，断言 label 为「WeiboAP · 办公助手」；再断言库不存在时降级为目录名（AC12/AC13）。

- [ ] **Step 8: 命令层与收尾**

`lib.rs` 里 `style_for` 等用到 `t.path` 的地方改 `t.dirs`（匹配时判断 `dirs.iter().any(|d| same(d, parent))`）。`mcp.rs` 若引用 `Target` 同步调整。

跑 `make test-core && make lint && cargo check --workspace`，全绿后单次提交：`feat(core): fan out WeiboAP links to agent dirs and show assistant names`。

---

### Task 2: 前端

**Files:**
- Modify: `src/types.ts`、`src/DomainView.tsx`、`src/SkillsTab.tsx`（仅当引用了 `target.path`）、`src/App.css`
- Modify: `docs/manual-checks.md`（Skills 一节）

**Interfaces（后端并行实现，按此写，不要等）:**
- `Target { id; label; dirs: string[]; scope; linkedWholeTo }`（`path` 字段消失）
- `CellState` 加 `"partial"`；`Cell` 加 `linked: number; total: number`

- [ ] **Step 1: 类型**

`types.ts`：`Target.path: string` → `dirs: string[]`；`CellState` 联合类型加 `"partial"`；`Cell` 加 `linked`、`total`。

- [ ] **Step 2: 格渲染**

`DomainView.tsx`：
- `CELL_SYMBOL` 加 `partial: ""`（不用图标），渲染时若 `state === "partial"` 显示 `{cell.linked}/{cell.total}`，否则显示图标。
- `CELL_TEXT` 加 `partial: "部分已链接"`。
- title：`partial` 时为 `${cell.total} 个目录中 ${cell.linked} 个已链接，点补齐补上其余`；其他状态在 `cell.total > 1` 时在原文案后追加 `（共 ${cell.total} 处）`。
- 格按钮的可点性：`partial` 与 `missing` 同样走 `onLink`。
- 行末「补齐」的 `hasMissing` 判据改为 `cells.some(c => c.state === "missing" || c.state === "partial")`。
- 「清除软链」的 `hasUnlinkable` 判据：`c.linked > 0 && c.state !== "own"` 且目标 `linkedWholeTo === null`。
- 坏链表里用 `target.path` 匹配的地方改为 `target.dirs.includes(action.target)`。

`App.css`：`td.cell.partial`／`button.cell.partial` 用 missing 的橙色系，字号调小以容纳 `2/4`。

- [ ] **Step 3: 计数**

`SkillsTab.tsx`：工具栏「补齐缺失（N 处）」的 N 改为按缺口数算——每格贡献 `total - linked`（`own` 格贡献 0），仍按 `cell.path` 去重的逻辑改为直接累加（多目录列的缺口本来就在不同目录）。「清除软链」的行数判据同 Task 2 Step 2。

- [ ] **Step 4: 手册与验证**

`docs/manual-checks.md` Skills 一节增补：全局域 WeiboAP 一列覆盖全部助手、部分覆盖显示 `2/4`、助手域单写不扇出、侧栏显示助手名。

`make build-web` 通过，改动文件 `npx prettier --check` 干净。提交：`feat(app): show partial coverage for multi-directory columns`。

---

### Task 3: 一次性清理（控制端执行）

删除托管目录下两条残留软链，删前确认仍是软链、删后确认本体仍在。不进产品代码。

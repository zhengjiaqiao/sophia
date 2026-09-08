# Spec v5: 只展示事实，只做动作

- 对应 intent：`docs/intent/2026-09-07-facts-and-actions.md`
- 替代：`docs/specs/2026-09-07-single-view-design.md`（v4；其 §3 格状态、坏链、整目录链接拆分继续有效，本文只写变化）
- 日期：2026-09-07
- 状态：已实现（feat/rust-pivot，PR #4）

## 1. 目标

去掉同步集。扫描只产出事实；建链与删链由前端把用户当场选中的行交给 core 生成动作，再执行。

## 2. 模型（`models.rs`）

删除：`Pick`、`SyncSet`、`ImportedSource`，以及 `models.rs` 里它们的序列化测试。

```rust
pub enum CellState { Own, Linked, Missing, Broken, Foreign, Duplicate, Unwritable }
//  Own：目标目录就是本体位置本身（same_real(target.path, source.path)），内容天然到位，不是链接

pub enum ActionKind { Create, AlreadyLinked, Conflict, SourceMissing, BrokenLink, Unlink }
//  Unlink：删除一条指向 source_path 的软链（target_path）。`sync::plan` 不产生它

pub struct DomainRow { pub source_id: String, pub skill: String, pub cells: Vec<Cell> }
pub struct DomainPage { pub key: String, pub label: String, pub targets: Vec<Target>, pub rows: Vec<DomainRow>, pub broken: Vec<PlannedAction> }
pub struct Overview { pub domains: Vec<DomainPage>, pub sources: Vec<Source> }

/// 前端选中的一行：域 key + 本体位置 id + skill。行不必已出现在表里（引入弹层用）
pub struct RowRef { pub domain: String, pub source_id: String, pub skill: String }
```

序列化仍 camelCase；`CellState::Own` → `"own"`，`ActionKind::Unlink` → `"unlink"`。

## 3. 扫描（`skills.rs`）

`scan(sources, targets) -> Overview`，无同步集参数。

每个域 D 的行 = 自有本体位置的全部 skill ∪ 已链接的 (s, name)（任一 t ∈ D 下 `t/name` 是解析到 `s/name` 的软链）。排序去重规则不变（skill 名、本体位置 label、id）。

格状态：先判 `linked_whole_to`（同 v4）；再 `same_real(target.path, source.path)` → **`Own`**（v4 是 Linked）；其余不变。

`DomainPage.broken` 不变。删除 `pending_missing`、`imported`。

## 4. 动作（`skills.rs`、`sync.rs`）

```rust
/// 选中行在其域各目标上的 Missing 格 → Create。行的域不存在、本体位置不存在或 skill 不在本体位置里 → 忽略该行。按 target_path 去重
pub fn propose_links(sources: &[Source], targets: &[Target], rows: &[RowRef]) -> Vec<PlannedAction>;
/// 选中行在其域各目标上的 Linked 格（目标非整目录链接）→ Unlink。同样的忽略与去重规则
pub fn propose_unlinks(sources: &[Source], targets: &[Target], rows: &[RowRef]) -> Vec<PlannedAction>;
```

两者都直接对 (source, target) 现算 `cell_state`，不依赖 `Overview.rows`，所以引入弹层里尚未成行的 skill 也能用同一函数。`PlannedAction { item_name: skill, source_path: source.path/skill, target_path: target.path/skill, target: target.path }`。

`sync::execute` 新增分支：

```rust
ActionKind::Unlink => {
    // 预览到确认之间可能已被换掉：必须仍是软链，且仍指向该本体位置
    if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_))
        || !same_real(&action.target_path, &action.source_path)
    {
        return Outcome::Failed("不再是指向该本体位置的软链接，已跳过".into());
    }
    match remove_link(&action.target_path) { Ok(()) => Outcome::Removed, Err(e) => Outcome::Failed(e.to_string()) }
}
```

`Unlink` 不受 `clean_broken` 影响（确认在前端做）。

删除：`propose`、`merged_pick`、`set_pick`、`import_source`、`remove_source`、`put`。`link_style`、`split_whole_link` 不变。

## 5. 存储（`store.rs`）

删除 `load_sync_set` / `save_sync_set` 及其测试；模块注释去掉 `syncset.json`。磁盘上残留的旧文件不管。

## 6. 命令层（`src-tauri/src/lib.rs`）

- `scan_all() -> Overview`：发现 → `skills::scan`，不再落盘任何东西。
- 新增 `propose_links(rows: Vec<RowRef>) -> Vec<PlannedAction>`、`propose_unlinks(rows: Vec<RowRef>) -> Vec<PlannedAction>`：各自 `discover` 一次再调 core。
- `apply_all(actions, clean_broken)`：不变（`style_for` 用 `Overview.sources/targets` 回查，仍成立）。
- 删除 `set_pick`、`import_source`、`remove_source`、`propose_all`。其余命令不变。

## 7. 前端

`types.ts`：删 `Pick`、`SyncSet`、`ImportedSource`；`DomainRow`、`DomainPage`、`Overview` 同 §2；`CellState` 加 `"own"`；`ActionKind` 加 `"unlink"`；新增 `RowRef`。`api.ts`：删 `setPick`、`importSource`、`removeSource`、`proposeAll`；加 `proposeLinks(rows)`、`proposeUnlinks(rows)`。

**选择状态**（`SkillsTab.tsx`）：`excluded: Set<string>`，键 `${page.key}|${sourceId}|${skill}`；行选中 ⇔ 不在集合里，所以默认全选、新出现的行也默认选中。切换侧栏时清空。选中行的 `RowRef` 列表 = 渲染中各页的行里未被排除的。

**工具栏**（`SkillsTab.tsx`）：

- `补齐缺失（N）`：N = 选中行的 `missing` 格数。点击：`proposeLinks(rows)` → `applyAll(actions, false)` → 结果框 → 刷新。
- `取消链接（M）`：M = 选中行里、目标 `linkedWholeTo === null` 的 `linked` 格数。点击先出确认条："只删除软链接本身，不删除任何真实文件。确认删除 / 取消"，确认后 `proposeUnlinks(rows)` → `applyAll(actions, false)` → 结果框 → 刷新。
- `清理坏链（K）`、`刷新`：不变。
- 删除 "全部 X 处待同步" 与 `proposeAll` 副作用。

**域页**（`DomainView.tsx`）：

- 标签行：按行统计出现过的本体位置，每个标签 `label · n 个`，无按钮；点击标签打开引入弹层并预选它。右侧 `引入…` 按钮。
- 表格：表头第一列一个全选框（勾 = 本页所有行选中；部分选中显示 indeterminate）；行首勾选框绑定选择状态；不再有 `tr.disabled` 与行 title。新增格符号 `own: "●"`，文案 "本体在此"；`App.css` 加 `td.cell.own` 样式（沿用 linked 的颜色），删 `tr.disabled`、`.tag button.link`。
- 坏链表、整目录链接拆分不变。
- 新增 prop `onReport(report)`，把弹层的执行结果交给 `SkillsTab` 的结果框。

**引入弹层**（`ImportDialog.tsx`）：

- 标题 "引入 skill 到「域名」"。左栏列出全部本体位置；本域已有其行的标 ✓。右栏 skill 复选，初始全不勾；本域已链接的 skill 后面标 "已链接"（仍可勾，勾了没有动作）。"全部" 仍是全选开关。
- 点 "引入"：`proposeLinks(勾选 skill 映射成 RowRef{domain: page.key, sourceId, skill})`；空数组 → `onError("所选 skill 都已链接，没有需要建立的链接")`，弹层不关；否则 `applyAll(actions, false)` → `onReport` → `onChange` → 关闭。
- "选择文件夹…" 不变。

`App.tsx` 不变。

## 8. 测试

core（`skills.rs`）：

- 行 = 自有 ∪ 已链接，不带入同源其他 skill，无同步集。
- 目标即本体位置本身 → `Own`。
- `propose_links`：只对 Missing 建 Create；跳过 Duplicate / Foreign / Unwritable；同一 target_path 去重；行不在表里（引入场景）也能生成；未知域 / 本体位置 / skill 忽略。
- `propose_unlinks`：只对 Linked 生成 Unlink；整目录链接目标不生成；`Own` 不生成。
- `sync.rs`：Unlink 对正确软链 → Removed 且文件消失；对真实目录 → Failed 且目录仍在；对指向别处的软链 → Failed 且链接仍在。
- 删除 picks 相关测试；`store.rs` 删同步集测试。

前端：`make build-web`。真机：`docs/manual-checks.md` 按 §7 重写 Skills 一节。

## 9. 迁移

- `syncset.json` 作废，不读不删。
- v4 spec 标"已被替代"；`CLAUDE.md` Architecture 行更新（`skills.rs`：`scan` / `propose_links` / `propose_unlinks`；`store.rs` 去掉 syncset）。

## 10. 修订 v5.1（2026-09-08，真机反馈）

- 状态：已实现
- 概念收口：**引入 skill / 删除 skill 是对 skill 的操作；补齐链接 / 取消链接是对软链的操作**。删除 skill = 删掉它在本域所有 harness 下的软链（行随之消失）。本体在本域的 skill 不能删除，但可以逐个取消它在某个 harness 下的链接。
- 所有动作按钮始终显示；不合法时禁用并用 `title` 说明原因，不隐藏。

### 10.1 模型

- `RowRef` 换成 `CellRef { source_id, skill, target_id }`（camelCase：`sourceId`、`skill`、`targetId`）。目标 id 决定域，不再传 `domain`。
- `DomainRow` 加 `own: bool`：该行本体位置属于本域（`source_domain(kind) == page.key`）。
- `Target.label` 只放 harness 名：全局 `display_name`；项目 harness 列 `display_name`；项目 `.agents/skills` 列 `通用仓库`；agent 目录列 `display_name`（不再 `WeiboAP · agent_1`）。`real_path` 合并后仍是 `A / B`。域名已在页标题里，列名不再重复项目。

### 10.2 core

```rust
pub fn propose_links(sources: &[Source], targets: &[Target], cells: &[CellRef]) -> Vec<PlannedAction>;   // 该格 Missing → Create
pub fn propose_unlinks(sources: &[Source], targets: &[Target], cells: &[CellRef]) -> Vec<PlannedAction>; // 该格 Linked 且目标非整目录链接 → Unlink
```
本体位置 / skill / 目标 id 对不上的格忽略；按 `target_path` 去重。命令 `propose_links(cells)`、`propose_unlinks(cells)` 参数名改 `cells`。

### 10.3 前端

`SkillsTab`（容器）持有：
- 选择集合（不变）。
- `pendingUnlink: PlannedAction[] | null`：确认条 "将删除 N 条软链接，只删链接本身，不删任何真实文件。确认删除 / 取消"。行、格、批量三条路径都先 `proposeUnlinks` 再进这个确认条；N = 0 时不进确认条，改显示提示。
- `notice: string | null`：暂态提示（与结果框同样式、6 秒消失），用于"没有需要建立的链接""本体在本域，不能删除"这类说明。
- 建链不确认：`proposeLinks` → `applyAll` → 结果框 → 刷新。
- 工具栏：`补齐缺失（N 处）`（N = 勾选行的 missing 格数）、`删除 skill（M 个）`（M = 勾选行里 `!own` 且至少一个可取消格的行数；`own` 行被勾选时跳过，按钮 title 说明"本体在本域的 skill 不会被删除"）、`清理坏链（K）`、`刷新`。
- 传给 `DomainView`：`onLink(cells)`、`onUnlink(cells)`、`onNotice(text)`。

`DomainView`：
- 表头最后加一列 `操作`。每行两个按钮：`补齐`（无 missing 格时禁用，title "没有缺失的链接"）；`删除`（`own` 时禁用，title "本体在本域，不能删除；可逐个取消某个 harness 下的链接"；无可取消格时禁用，title "没有可删除的链接"）。点击分别把该行全部格交给 `onLink` / `onUnlink`。
- 格改为按钮（`<button className="cell …">`）：`missing` 点击 `onLink([格])`，title "点击建链"；`linked` 且目标非整目录链接 点击 `onUnlink([格])`，title "点击取消此链接"；其余状态点击 `onNotice(原因)`，title 为原因（`own`："本体在此，不是链接"；`unwritable`："整目录链接，先拆成逐项链接"；`broken`："坏链，请用清理坏链"；`foreign`："指向别处的软链，不归本工具管理"；`duplicate`："已有同名真实条目，不会覆盖"）。
- 行末按钮与格按钮 `busy` 时禁用。

`ImportDialog`：三栏。
- 左栏本体位置：显示 `label` 与 `未引入 n 个`（n = 该位置 skill 里本域尚无行的数量）。
- 中栏 skill：上段本域没有的（复选，"全部"是它们的全选开关）；下段本域已有的（无复选，灰字，后缀"已引入"）。
- 右栏 harness：本域各目标复选，默认全勾；`linkedWholeTo !== null` 的禁用，title "整目录链接，先拆成逐项链接"。
- `引入`：`cells = 勾选 skill × 勾选目标` → `proposeLinks` → 空则 `onNotice("所选 skill 在所选 harness 下都已链接")`，弹层不关；否则 `applyAll` → `onReport` → 刷新 → 关闭。skill 或目标为空时按钮禁用。

### 10.4 测试

core：`CellRef` 序列化；`propose_links` / `propose_unlinks` 按格（含忽略与去重）；`DomainRow.own` 在全局与项目域各一例；`discovery::targets` 标签（全局、项目 harness、通用仓库、agent 目录）。前端 `make build-web`；`docs/manual-checks.md` Skills 一节按 §10.3 更新。

## 11. 修订 v5.2（2026-09-08）：列 = 启用的 harness

- 状态：已实现
- 规则：**表格的每一列就是设置里启用的一个 harness**，列名是 harness 名。多个 harness 共用同一个目录时各自一列（内容相同），不再合并；`~/.agents/skills` 与项目 `.agents/skills` 不再有独立的"通用仓库"列，只作为通用型 harness（Codex、Cursor 等 `project_dir = .agents/skills`；Cline `global_dir = ~/.agents/skills`）自己的列出现。
- `discovery::targets`：
  - 每个启用 harness：`global_dir` → 全局列；agent 目录 → 各 agent 域一列；每个项目的 `project_dir` → 项目域一列。目录不存在（`is_dir()` 跟随软链）则不生成。
  - 删除：`store_key` 排除、按 `real_path` 去重与 `A / B` 标签合并、`UNIVERSAL_ID` 通用列与 `dir == universal` 跳过。
  - `linked_whole_to` 判定不变。
  - 目标 id 不变（全局 `<harness_id>`，项目 `project:<path>::<harness_id>`）；`project:<path>::universal` 不再存在。
- 前端 `SkillsTab`：`补齐缺失（N 处）` 与可取消格计数按 `cell.path` 去重（两列同目录只算一处）；`propose_*` 已按 `target_path` 去重，执行不受影响。
- 测试：`targets_list_globals_projects_and_one_universal_column` 改为"通用型 harness 各自一列指向 `.agents/skills`，非通用型指向自己的目录，无通用列"；`symlinked_target_dir_is_never_merged_into_the_dir_it_points_to` 改为"两个 harness 同目录各自一列"；其余按新规则调整。

## 12. 修订 v5.3（2026-09-08）：设置只剩 harness，项目在侧栏增删

- 状态：已实现
- 设置弹层只保留 Harness 一节；「项目」「本体位置」两节删除。
- 侧栏：域列表下方一个 `添加项目…` 按钮（系统目录选择框 → `add_project` → 重扫）。手动添加的项目条目右侧有 `×`（title "移除项目"，点击 `remove_project` → 重扫；当前选中的被移除时回落到「全部」）。自动发现的项目与 WeiboAP agent 域没有 `×`。
- `App.tsx` 在每次重扫时同时取 `list_manual_projects`，用 `"project:" + path === d.key` 判断是否手动项目。为此 `lib.rs` 的 `add_project` 保存前 `normalize`，`remove_project` 按 `normalize` 比较，`list_manual_projects` 原样返回（已归一化）。
- 手动本体位置：只保留引入弹层里的 `选择文件夹…` 添加；弹层左栏 `kind = manual` 的条目多一个 `移除` 链接（`remove_manual_source` → 重扫；若它是当前选中项则选中列表第一项）。
- `docs/manual-checks.md`：设置一节改为只验 harness 开关；新增侧栏添加 / 移除项目、弹层移除手动本体位置。

## 13. 修订 v5.4（2026-09-08）：删自定义同步；选择成为一等交互

- 状态：已实现

### 13.1 删除自定义同步

- core：删 `Selection`、`SyncRule`、`sync::plan`、`PlanError` 及只为它服务的私有函数与测试；`ActionKind` 只剩 `Create`、`BrokenLink`、`Unlink`；`store.rs` 删 `load_rules` / `save_rules` 及测试（`rules.json` 不再读写，残留文件不管）；`Cargo.toml` 去掉因此无用的依赖（`uuid`、`chrono` 若无他用）。`sync::execute` 与其测试保留。
- 命令层：删 `list_rules`、`save_rules`、`plan_rule`、`apply_rule`、`list_source_items`、`list_domains`（前端已不用）。
- 前端：删 `CustomSyncTab.tsx`、tab 导航与 `.tabs` / `.custom` 样式、`api` 里对应方法、`types.ts` 里 `Selection` / `SyncRule` / `Domain` / `DomainInfo` / `domainKey` 与已删的 `ActionKind` 变体；侧栏不再折叠。
- `CLAUDE.md` 首段与 Architecture 去掉"通用同步"相关描述；`docs/manual-checks.md` 删"自定义同步 tab"一节。

### 13.2 页面布局（`SkillsTab` / `DomainView`）

- **页面工具栏**（常驻）：`引入…`（当前页为「全部」时禁用，title "请先在侧栏选一个域"）、`清理坏链（K）`（K = 渲染中各域坏链数；确认条文案不变）、`刷新`。坏链数为 0 时按钮禁用。
- **筛选行**：搜索框（placeholder "筛选 skill"，大小写不敏感的子串匹配）+ 本体位置筛选片（每个域一排，来自该域的行按 `source_id` 计数，片上 `label · n`；点击切换高亮，可多选；无高亮 = 不筛）。筛选只影响显示与"可见"判定。
- **选择操作条**：选中且可见的行 ≥ 1 时出现在表格上方：`已选 N 个 skill`、`补齐缺失（M 处）`（M = 这些行 missing 格数，按 `cell.path` 去重）、`删除（P 个）`（P = 这些行里 `!own` 且有可取消格的行数）、`取消选择`。删除仍走确认条。
- 现在的来源标签行删除（被筛选片替代）；`SkillsTab` 里旧的 `补齐缺失 / 删除 skill` 工具栏按钮删除。

### 13.3 选择

- 选择状态改为 `selected: Set<string>`（键 `${page.key}|${sourceId}|${skill}`），**默认为空**。
- 表头复选框 = 全选 / 全不选**当前可见行**，部分选中时 `indeterminate`。
- 行首复选框点击时按住 Shift：以上一次点击的行为锚点，把两者之间（按当前显示顺序）的可见行都设为与本次相同的选中状态；锚点按域记录。
- 切换侧栏、筛选变化都不清空选择；操作只作用于"选中且可见"的行；`刷新` 后不存在的行自然失效。`取消选择` 清空全部选择（含不可见的），避免藏着的选中项日后冒出来。
- 行末 `补齐` / `删除` 单行按钮、格点击行为、排序保留。

### 13.4 测试

core：`make test-core`（删除相关测试随功能移除）。前端 `make build-web`。`docs/manual-checks.md` Skills 一节补：筛选片 + 表头全选两步选出"通用仓库"的行；Shift 区间选择；操作条随选择出现与消失；「全部」页引入禁用。

## 14. 修订 v5.5（2026-09-08）：本体位置可点击，在 Finder 中显示

- 状态：已实现
- 表格 `本体位置` 格改为链接样式按钮：点击调用 tauri-plugin-opener 的 `revealItemInDir(<本体位置路径>/<skill>)`，在系统文件管理器里定位并选中该 skill 目录；title 显示完整路径。
- 依赖：`src-tauri/Cargo.toml` 加 `tauri-plugin-opener`，`package.json` 加 `@tauri-apps/plugin-opener`，`lib.rs` 注册插件，capabilities 加 `opener:allow-reveal-item-in-dir`。
- `api.ts` 加 `revealInDir(path)`；失败走 `onError`。

## 15. 修订 v5.6（2026-09-08）："删除"改为"清除软链"，结果里说明本体去向

- 状态：已实现
- 行末按钮与操作条按钮都改名 **`清除软链`**（操作条：`清除软链（P 个）`，P = 选中且可见、有可清除格的行数）。本体在本域的行也可以点：只清它在其他 harness 下的链接。仅当该行没有可清除的格时禁用，title "没有可清除的软链接"。
- 确认条文案："将删除 N 条软链接，只删链接本身，不删任何真实文件。本体在本域的 skill 只清链接，本体目录不动。确认删除 / 取消"。
- 执行后的结果框在逐条结果之后增加一段 **按 skill 的说明**（只对本次所有 Unlink 都成功的行）：
  - 本体不在本域的行：`「<skill>」的软链已清除，已从列表移除。`
  - 本体在本域的行：`「<skill>」的软链已清除；本体仍在 <本体位置路径/skill>，点击表格里的本体位置可在 Finder 中定位，删掉本体后它才会从列表消失。`
  - 有失败的行：`「<skill>」有 n 条软链未能删除，见上方。`
  - 单格清除（该行还有别的链接）：`「<skill>」的软链已清除，它在其他 harness 下的链接还在。`
- 实现：`SkillsTab.pendingUnlink` 改为 `{ actions: PlannedAction[]; rows: { page: DomainPage; row: DomainRow }[] }`；执行后按 `action.item_name` 与 `target_path` 所属目标把结果归到行，生成说明。结果框仍 6 秒后消失，但有 skill 说明时延长到 15 秒。
- `docs/manual-checks.md` Skills 一节相应更新。

## 16. 修订 v5.7（2026-09-08）：确认改弹窗，结果改浮层，操作条吸顶

- 状态：已实现
- 两个确认（清除软链、清理坏链）改为居中模态弹窗（复用 `.modal-backdrop` / `.modal` 样式）：标题、说明文案（沿用现有）、`确认删除` / `取消`；Esc 与点击遮罩等同取消。不再在工具栏里出现内联确认条。
- 结果框与暂态提示改为**固定在窗口右下角的浮层**（`position: fixed`），不随内容滚动；可关闭；自动消失时间不变（6 秒，有 skill 说明时 15 秒）。
- 选择操作条改为 **sticky 吸顶**（`position: sticky; top: 0`），滚动时仍可见；页面工具栏保持在顶部不吸。
- 行末 `清除软链` / 单格 ✓ / 操作条清除都打开同一个弹窗。

## 17. 修订 v5.8（2026-09-08）：仓库里指向其他本体位置的软链不算自己的 skill

- 状态：待实现
- 现象：项目 `.agents/skills`（Codex 列）里由本工具建的、指向 WeiboAP agent 的软链，被当成 CardBox 仓库自己的 skill，同一 skill 出现两行（CardBox ● / WeiboAP ✓），且"本体位置"定位到了 WeiboAP。
- 规则：仓库型本体位置（通用仓库、项目仓库、手动）里的软链条目，只有当它解析到的真实目录**不在任何已知本体位置之内**时才算该仓库的 skill（用户把外部目录链进仓库的场景，如 `/Applications/ego-skills/ego-browser`）。解析到另一个已知本体位置里的软链是"链接"，由那个本体位置的行在本列上以 ✓ 表示。harness 目录仍只认真实目录。
- 实现：`discovery::sources` 两遍：先按现规则收集全部本体位置（含软链条目）；再对每个仓库型位置过滤其软链条目——`real_path(entry)` 以任一**其他**本体位置的 `real_path` 为前缀（`Path::starts_with`，按分量）则剔除。位置本身按 `real_path` 去重的逻辑不变。
- 测试：新增"项目仓库里指向 agent 本体位置的软链不算项目的 skill，指向外部目录的仍算"；`store_sources_link_through_but_harness_dirs_only_count_real_dirs` 保持通过。

## 18. 修订 v5.9（2026-09-08）：去掉刷新按钮，文件系统变化自动重扫

- 状态：待实现
- 去掉工具栏 `刷新` 按钮。以下任一情况自动重扫：
  1. **文件系统变化**：后端用 `notify`（`notify-debouncer-mini`，去抖 500ms）监视每次扫描得到的全部本体位置目录与目标目录（非递归；skill 是它们的直接子项，删本体目录、建/删软链都会触发父目录事件）。事件到达后向前端 emit `fs-changed`。每次 `scan_all` 后用新的目录集合重建监视（集合未变则不重建）。
  2. **窗口获得焦点**：前端监听 Tauri 窗口 `focus` 事件后重扫（兜底，例如在 Finder 里删了不在监视集合内的东西）。
  3. 本工具自己的写操作之后（现有逻辑）。
- 前端：`App.tsx` 用 `@tauri-apps/api/event` 的 `listen("fs-changed")` 与 `getCurrentWindow().onFocusChanged`；重扫合并：正在扫描时收到事件则记一个"待重扫"标记，扫完再扫一次；连续事件去抖 300ms。
- 自己写操作触发的 fs 事件会导致多扫一次，可接受。
- 监视失败（目录不可读等）只记日志，不报错到界面。
- `docs/manual-checks.md`：去掉刷新按钮相关，加"在 Finder 删掉一个本体目录 / 手工建一条软链后，1 秒内表格自动更新"。

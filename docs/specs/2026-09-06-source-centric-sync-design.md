# Spec v3: 以本体位置为中心的 skill 同步

- 对应 intent：`docs/intent/2026-09-06-source-centric-sync.md`
- 替代：`docs/specs/2026-09-06-skill-sync-design.md`（§3 fs、§4 sync、§7 store、§8 通用同步命令、§9 自定义同步 tab、§10 错误处理 继续有效，本文只写变化的部分）
- 日期：2026-09-06
- 状态：已实现（PR #4，feat/rust-pivot）

## 1. 目标与范围

把矩阵的组织方式从"域 × harness"改为"本体位置 → 目标"，并加入两级勾选（本体位置选目标、skill 行选同步与否），持久化为同步集；提供"拆成逐项链接"动作；按域视图保留为同一份数据的另一种渲染。不搬本体、不复制内容、唯一删除仍是确认后的坏链清理与拆分整目录链接时删除那条目录级软链。

不做：内容比对、复制或移动本体、marketplace、编辑、预设、CLI、自动更新。

## 2. 模型（`crates/core/src/skills.rs`，重写）

```rust
pub enum SourceKind { Universal, HarnessGlobal { harness_id: String }, ProjectStore { project: PathBuf },
                      HarnessExtra { harness_id: String, label: String }, Manual }
pub struct Source { pub id: String /* normalized path */, pub path: PathBuf, pub kind: SourceKind,
                    pub label: String, pub skills: Vec<String> /* 真实目录名，排序 */ }

pub enum TargetScope { Global { harness_id: String }, Project { project: PathBuf, harness_id: String } }
pub struct Target { pub id: String /* "claude-code" | "project:<path>::claude-code" */, pub label: String,
                    pub path: PathBuf, pub scope: TargetScope,
                    pub linked_whole_to: Option<String> /* 目标目录本身是软链且 real_path 等于某本体位置 id */ }

pub enum CellState { Linked, Missing, Broken, Foreign, Duplicate, Unwritable /* 目标整目录链接到别的本体位置 */ }
pub struct Cell { pub source_id: String, pub skill: String, pub target_id: String, pub path: PathBuf, pub state: CellState }

pub struct SyncSet { pub sources: BTreeMap<String, SourceSync> }        // store 模块持久化
pub struct SourceSync { pub targets: BTreeSet<String>, pub disabled_skills: BTreeSet<String> }

pub struct Overview { pub sources: Vec<Source>, pub targets: Vec<Target>, pub cells: Vec<Cell>,
                      pub sync_set: SyncSet, pub summary: Summary /* sources, pending_missing, broken */ }
```

所有类型 serde camelCase，`SourceKind`/`TargetScope` 用 `tag = "type"`。

## 3. 发现（`discovery.rs` 新增）

- `sources(env, settings, harnesses, projects) -> Vec<Source>`：
  - 通用仓库 `~/.agents/skills`；每个已启用 harness 的 `global_dir`；每个 harness 的 `extra_source_dirs`（模板数组，支持单层 `*` 通配，见 §6）；每个项目的 `.agents/skills`；`settings.manual_sources`。
  - 列直接子项，`entry_kind == Dir` 且不以 `.` 开头的才是 skill；没有任何 skill 的位置不产出 `Source`。
  - 仓库型位置（`Universal`、`ProjectStore`、`Manual`）额外把 `real_path` 解析到目录的软链也算 skill（用户会把外部目录链进仓库，如 `~/.agents/skills/ego-browser -> /Applications/.../ego-skills/ego-browser`）；坏链不算。`HarnessGlobal`、`HarnessExtra` 只认真实目录，否则满是软链的消费目录会反过来被当成本体位置。
  - 位置去重按 `real_path`。
- `targets(env, settings, harnesses, projects, sources) -> Vec<Target>`：已启用 harness 的 `global_dir`（存在即算）+ 每个项目里存在的 harness `project_dir`；按 `real_path` 去重；`real_path(target.path)` 等于某个 `Source.id` 时填 `linked_whole_to`。
- 项目列表沿用 v2 的 `project_candidates`。

## 4. 扫描与动作（`skills.rs`）

- `scan(sources, targets, sync_set) -> Overview`：对每个 (source, skill, target)：
  - `target.linked_whole_to == Some(source.id)` → Linked；`Some(other)` → Unwritable；
  - `real_path(target.path) == real_path(source.path)`（目标就是这个本体位置本身，如 WeiboAP 的 custom 目录既是本体位置又是目标）→ 该 (source, target) 的每一格都是 Linked，`propose` 不在这里建链；
  - 否则看 `target.path/skill`：Missing → Missing；Dir/File → Duplicate；Symlink 且 `real_path` 等于 `source.path/skill` 的 real_path → Linked；Symlink 无法解析 → Broken；其他 → Foreign。
- **同步集默认值**：扫描时对未登记的 source 写入 `targets = 所有 Global 目标 id`，`disabled_skills = {}`；`SourceKind::ProjectStore { project }` 例外，只写 `scope` 为 `Project { project: 同一路径 }` 的目标（项目仓库只服务本项目，不该把项目 skill 推到全机器）。已登记的不改。新出现的 Project 目标不会自动加入。`scan` 返回的 `sync_set` 是补默认值后的结果，由命令层负责保存。
- `propose(overview) -> Vec<PlannedAction>`：
  - Create：`cell.state == Missing` 且 `target ∈ sync_set[source].targets` 且 `skill ∉ disabled_skills`；`source_path = source.path/skill`，`target_path = cell.path`，`target = target.path`。
  - BrokenLink：每个目标目录里所有坏链（不限本体位置），删前 `Executor` 重校验。
- `link_style(source, target)`：`target.scope` 为 `Project{project}` 且 `source.path` 位于该项目内 → Relative；否则 Absolute。命令层按动作分组调用 `sync::execute`。
- `split_whole_link(target, source) -> SyncReport`：前置检查 `entry_kind(target.path) == Symlink` 且 real_path 等于 `source.path`；删该软链，`create_dir`，对 `source.skills` 逐项 `create_link`（style 同上）；任一步失败即停止并在报告里说明，已建的链接保留。

## 5. 持久化（`store.rs` 新增）

- `settings.json` 新增 `manualSources: Vec<PathBuf>`（默认空）。
- `syncset.json`：`{ "sources": { "<source id>": { "targets": [...], "disabledSkills": [...] } } }`，`load_sync_set` 缺失 → 空；`save_sync_set` 原子写。

## 6. harness 表

新增可选字段 `extra_source_dirs: Vec<String>`（模板，支持路径中单个分量为 `*`，展开为该层所有目录）。WeiboAP 条目：

```json
"global_dir": ["~/Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom"],
"extra_source_dirs": ["~/Library/Application Support/WeiboAP/Data/agents/*/.internal-plugins/skills"]
```
`HarnessExtra` 的 `label` 取通配匹配到的目录名（如 `agent_1788…`）。

## 7. 命令层

| 命令 | 签名 |
|---|---|
| `scan_all` | `() -> Overview`（扫描后保存补齐默认值的同步集） |
| `set_source_targets` | `(source_id, target_ids: Vec<String>)` |
| `set_skill_enabled` | `(source_id, skill, enabled)` |
| `propose_all` | `() -> Vec<PlannedAction>` |
| `apply_all` | `(actions, clean_broken) -> SyncReport`（按每条动作重新算 link_style） |
| `split_whole_link` | `(target_id) -> SyncReport` |
| `add_source` / `remove_source` | `(path)` |

删除：`scan_domain`、`propose`、`apply`。保留：`list_domains`、项目、harness、通用同步、`list_source_items`。

## 8. 前端

- Skills tab 顶部：视图切换（按本体位置 / 按域）、摘要、"同步（N）"、"清理坏链（N）"（二次确认）、"刷新"。
- 按本体位置视图：每个 `Source` 一张卡片：标题 `label` + 路径；目标勾选行（每个 `Target` 一个复选框，勾选即 `set_source_targets`）；矩阵行首 skill 名 + 行级复选框（`set_skill_enabled`），列为该本体位置已勾选的目标，格子符号 ✓ ○ ✗ → ⚠ 加 `–` 表示 Unwritable；目标列头若 `linked_whole_to` 等于本卡片本体位置显示"整目录链接"徽标和"拆成逐项链接"按钮（二次确认）。禁用行淡显。
- 按域视图：按 `TargetScope` 分组（全局一组，每个项目一组），表格行 = 属于该域的本体位置的 (source, skill)（全局：通用仓库、harness 全局目录、harness 附加目录、手动；项目：该项目的 `.agents/skills`）；跨域同步在本体位置视图处理，多一列"本体位置"，只读。
- 任何勾选或动作后重新 `scan_all`。

## 9. 错误处理

沿用 v2 §10。新增：`split_whole_link` 前置检查失败 → `Failed("目标不是指向该本体位置的整目录链接")`；通配展开失败或目录不可读 → 该位置跳过，不中断。

## 10. 测试

见 intent 第四节的清单；`sync`、`fs`、v2 的 `discovery` 测试保留；v2 的 `skills` 测试删除，按 §4 重写；新增通配展开、目标整目录链接识别、同步集默认值、拆分动作的用例。

## 11. 风险

- WeiboAP 是否跟随软链读取 skill、拆分整目录链接后是否仍识别项目 skill：拆分动作发布前由作者在 WeiboAP 里验证。
- 通配目录数量：WeiboAP agent 可能多个，每个都是一张卡片；先接受，多了再考虑折叠。

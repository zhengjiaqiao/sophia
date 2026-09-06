# Spec: SymSync 多 harness skill 同步（Rust + Tauri）

- 对应 intent：`docs/intent/2026-09-06-skill-sync-pivot.md`
- 替代：`docs/specs/2026-09-02-symlink-sync-design.md`（Swift 版，算法与测试用例继续作为移植规格）
- 日期：2026-09-06
- 状态：待审阅

## 1. 目标与范围

跨平台桌面应用。自动发现已安装 harness 与项目，展示 skill × harness 矩阵，补齐缺失软链、确认后清理坏链；另保留通用"源目录 → 多目标"软链同步。不搬本体、不复制内容。

不做：全局 ↔ 项目复制与分叉比对、文件监听、marketplace、编辑、预设、CLI、自动更新。

## 2. 仓库结构

```
symsync/
├── Cargo.toml                 # workspace
├── crates/core/               # symsync-core：纯 Rust，无 Tauri 依赖
│   ├── src/{lib.rs, fs.rs, sync.rs, skills.rs, discovery.rs, store.rs}
│   ├── data/harnesses.json    # 内置 harness 表（源自 vercel-labs/skills，MIT）
│   └── tests/
├── src-tauri/                 # 命令层，薄封装
├── src/                       # React + TypeScript 前端（Vite）
├── package.json  Makefile  CLAUDE.md  REVIEW.md  .claude/  .github/
└── docs/
```

Swift 目录（`SymSyncCore/`、`SymSync/`、`project.yml`）在 Rust 版通过手动清单后删除；删除前 main 打 tag `v0.1-swift`。

## 3. core：`fs` 模块

```rust
pub enum EntryKind { Missing, Symlink(PathBuf /* 原始目标，已解析为绝对 */), File, Dir }
pub fn entry_kind(path: &Path) -> EntryKind          // symlink_metadata，坏链也返回 Symlink
pub fn real_path(path: &Path) -> Option<PathBuf>     // canonicalize，失败为 None
pub fn normalize(path: &Path) -> PathBuf             // 去 . / .. / 尾斜杠，不解析软链
pub enum LinkStyle { Absolute, Relative }
pub fn create_link(target: &Path, link: &Path, style: LinkStyle) -> io::Result<()>
```

- Unix：`std::os::unix::fs::symlink`；`Relative` 时目标写成相对于链接所在目录的路径，计算前先对链接父目录做 `real_path`，避免父目录本身是软链时算错。
- Windows：`std::os::windows::fs::symlink_dir` 需要权限，因此一律用 junction（`junction` crate）加绝对路径，忽略 `style`。
- "是否指向同一处"一律比较 `real_path`。

## 4. core：`sync` 模块（通用同步，移植自 Swift）

```rust
pub struct SyncRule { pub id: Uuid, pub name: String, pub source: PathBuf,
                      pub selection: Selection, pub targets: Vec<PathBuf>, pub last_run_at: Option<DateTime<Utc>> }
pub enum Selection { All, Items(Vec<String>) }
pub enum ActionKind { Create, AlreadyLinked, Conflict, SourceMissing, BrokenLink }
pub struct PlannedAction { pub kind: ActionKind, pub item_name: String,
                           pub source_path: PathBuf, pub target_path: PathBuf, pub target: PathBuf }
pub enum Outcome { Created, Skipped, Removed, Failed(String) }
pub struct SyncReport { pub entries: Vec<(PlannedAction, Outcome)> }
pub fn plan(rule: &SyncRule) -> Result<Vec<PlannedAction>, PlanError>   // 只读
pub fn execute(actions: &[PlannedAction], clean_broken: bool, style: LinkStyle) -> SyncReport
```

规则与 Swift 版 §4 相同：源目录不可读则整体报错（两种 selection 都检查）；`All` 跳过点开头；目标判定 Missing → Create、链接 real_path 等于源子项 → AlreadyLinked、其他 → Conflict；每个目标目录追加指向 `source/` 下且已失效的坏链；Executor 只对 Create 建链、只在 `clean_broken` 时删坏链且删前重校验仍是软链；目标目录不存在（跟随软链判断）→ `Failed("目标目录不存在")`；逐项独立。

## 5. core：`skills` 模块（矩阵）

```rust
pub struct Harness { pub id: String, pub display_name: String,
                     pub project_dir: Option<String>, pub global_dir: Option<PathBuf>, pub universal: bool }
pub enum Domain { Global, Project(PathBuf) }
pub enum CellState { Home, Linked, Missing, Broken, Foreign, DuplicateHome, Inaccessible }
pub struct Cell { pub harness_id: String, pub path: PathBuf, pub state: CellState }
pub struct SkillRow { pub name: String, pub home: Option<PathBuf>, pub external_home: bool,
                      pub cells: Vec<Cell>, pub ambiguous: bool }
pub struct Matrix { pub domain: Domain, pub columns: Vec<Harness>, pub rows: Vec<SkillRow>,
                    pub summary: Summary /* missing, broken, ambiguous 计数 */ }
pub fn scan(domain: &Domain, harnesses: &[Harness]) -> Matrix
pub fn propose(matrix: &Matrix) -> Vec<PlannedAction>     // Missing → Create；Broken → BrokenLink
```

**列**：域内实际存在的 harness 目录，加"通用仓库"列（全局 `~/.agents/skills`，项目 `.agents/skills`）。列按解析后的真实路径去重：多个 harness 指向同一目录（如 Cline 的全局目录就是 `~/.agents/skills`）只保留一列，列名合并显示。通用型 harness 在项目域不单独成列。

**行**：各列直接子项按目录名归并，跳过点开头。

**本体判定**，按顺序：
1. 通用仓库列里的真实目录；
2. 否则域内唯一的真实目录；
3. 否则所有链接 `real_path` 都指向同一个域外真实目录 → 该目录为本体，`external_home = true`；
4. 否则 `ambiguous = true`，`home = None`，本行不生成动作。

**格状态**：真实目录且是本体 → Home；真实目录但本体在别处 → DuplicateHome；链接且 real_path == home → Linked；链接且目标不存在 → Broken；链接指向别处 → Foreign；无条目 → Missing；目录不可读 → 整列 Inaccessible。

**动作**：仅 Missing 和 Broken 产生动作；Foreign、DuplicateHome、ambiguous 只报告。全局域建链用 `Absolute`，项目域用 `Relative`。摘要（`Summary`）只统计非多本体行的 Missing / Broken，与动作一致。

## 6. core：`discovery` 模块

- `harnesses.json` 字段：`id, display_name, project_dir, global_dir, detect_dir, universal`。`global_dir` 与 `detect_dir` 是模板，支持 `~`、`$VAR`（如 `$CLAUDE_CONFIG_DIR`、`$CODEX_HOME`）、`$XDG_CONFIG_HOME`（未设置时回退 `~/.config`；Windows 回退 `%APPDATA%`）。
- `installed() -> Vec<Harness>`：探测目录（`detect_dir`，缺省 `global_dir`）存在，且其中至少有一个条目不在通往 `global_dir` 的路径上（只含 `skills/` 空壳的目录不算已安装，因为 `npx skills --agent '*'` 会为未安装的工具也建出该目录）。
- `project_candidates() -> Vec<PathBuf>`：`~/.claude.json` 的 `projects` 键 ∪ `projects.json` 手动列表；记录来源的项目需"目录存在且含至少一个 harness 的 `project_dir` 或 `.agents/skills`"；手动添加的项目只需目录存在；两者都排除主目录与根目录。`~/.claude.json` 缺失或解析失败时只用手动列表；忽略不以 `.` 开头的 `project_dir`（OpenClaw 的裸 `skills`），并跳过主目录下的隐藏目录。

## 7. core：`store` 模块

`rules.json`、`projects.json`，位于 `dirs::data_dir()/SymSync/`，整文件原子写（写临时文件再 rename）。

## 8. Tauri 命令层

| 命令 | 签名 |
|---|---|
| `list_domains` | `() -> Vec<DomainInfo>` |
| `scan_domain` | `(domain) -> Matrix` |
| `propose` | `(domain) -> Vec<PlannedAction>` |
| `apply` | `(actions, clean_broken, domain) -> SyncReport` |
| `add_project` / `remove_project` | `(path)` |
| `list_rules` / `save_rules` | 通用同步记录 |
| `plan_rule` / `apply_rule` | `(rule)` / `(actions, clean_broken)` |
| `pick_directory` | 调 `tauri-plugin-dialog`，返回 `Option<PathBuf>` |

错误统一转 `String`。不开沙盒，Rust 直接访问文件系统。

## 9. 前端

React + TypeScript + Vite，无 UI 框架。

- 左栏：域列表（全局置顶，项目在下，底部"添加项目"）。
- 右栏 tab 1 "Skills"：摘要行 + 矩阵表格。格子符号：✓ Linked、● Home、○ Missing、✗ Broken、→ Foreign、⚠ DuplicateHome、– Inaccessible；ambiguous 行整行淡显并标"多本体"。行首显示 skill 名与本体路径（外部本体标"外部"）。按钮："同步缺失链接"、"清理坏链"（有坏链时出现，二次确认）、"刷新"。执行后重新扫描。
- 右栏 tab 2 "自定义同步"：记录列表 + 详情（源、子项勾选、目标列表、预览表、执行、清理坏链），行为同 Swift 版 §7。
- 前端不缓存状态，动作后重新扫描。

## 10. 错误处理

- 某列目录不可读 → 该列 Inaccessible，其余正常。
- 建链失败 → 单项 `Failed(原因)`，不中断。
- 删坏链前重校验仍是软链，否则 `Failed("不再是软链接，已跳过")`。
- 永不删除真实文件、永不移动或复制本体。

## 11. 测试与流程

- `cargo test`（`tempfile` 搭真实文件树）：移植 Swift 27 个用例；矩阵用例：全链接、缺失、坏链、Foreign、通用仓库优先本体、外部本体、多本体无动作、项目域相对链接、点开头跳过、候选项目过滤、`global_dir` 模板解析。Windows 逻辑 `#[cfg(windows)]`。
- `make test` = `cargo test` + `cargo clippy -- -D warnings` + `npm run build`。
- CI：ubuntu 跑 `cargo test`；macos 跑 `cargo tauri build`。
- `CLAUDE.md`、hooks（`cargo fmt` / `prettier`、`FIXING` 保护 tests）、`REVIEW.md` 更新到新栈。
- 手动清单：真实目录上跑全局域扫描，核对与 `ls -l` 一致；补链后 Claude Code / Codex 能看到 skill；项目域相对链接可被 git 正确记录。

## 12. 已识别的关注点

- Windows junction 是否被所有 harness 跟随，需在 Windows 机器上验证；第一版只保证 macOS/Linux 手动验证通过。
- `~/.claude.json` 格式非公开约定，解析要容错。

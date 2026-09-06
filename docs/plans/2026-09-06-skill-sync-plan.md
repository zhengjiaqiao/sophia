# SymSync 多 harness skill 同步（Rust + Tauri）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Rust core + Tauri 2 + React 重做 SymSync：自动发现 harness 与项目，展示 skill × harness 矩阵，补缺失软链、确认后清坏链；保留通用软链同步。

**Architecture:** Cargo workspace。`crates/core`（`symsync-core`）纯 Rust，无 Tauri 依赖：`models`（共享类型）、`fs`（lstat / realpath / 建链）、`sync`（通用同步，移植自 Swift）、`skills`（矩阵与本体判定）、`discovery`（内置 harness 表、已安装判定、项目候选）、`store`（JSON 持久化）。`src-tauri` 是薄命令层。`src/` 是 React + TypeScript 前端，两个 tab。

**Tech Stack:** Rust 1.94（Homebrew）、tauri 2.11、tauri-plugin-dialog 2.7、serde / serde_json、uuid 1、chrono 0.4、dirs 7、thiserror 2、pathdiff 0.2、junction 2（仅 Windows）、tempfile 3（测试）；Node 25、Vite、React 18、TypeScript。

**Spec:** `docs/specs/2026-09-06-skill-sync-design.md`

## Global Constraints

- 不开沙盒、不上 App Store；Rust 直接读写文件系统。
- `symsync-core` 不得依赖 `tauri`。
- 条目类型判定用 `symlink_metadata`（lstat）；"是否指向同一处"用 `canonicalize` 比较；路径文本比较先 `normalize`。
- 全局域建链 `Absolute`，项目域 `Relative`；Windows 一律 junction + 绝对路径。
- 永不删除真实文件、永不移动或复制本体；唯一删除是确认后的坏链清理，删前重校验仍是软链。
- 点开头的目录条目一律跳过。
- 借用代码限 MIT 并注明出处（`crates/core/data/harnesses.json` 头部注释与 `NOTICE`）。
- 注释与 UI 文案中文，标识符英文；Conventional Commits。
- 每个任务结束前运行本任务的验证命令；不得为了通过而修改测试。
- 并行任务只碰各自 **Files** 列出的文件；共享文件（`lib.rs`、`Cargo.toml`、`App.tsx`）由前置任务预留好位置。

---

## Plan（playbook Stage 3 摘要）

### Files that change

| 路径 | 职责 | 任务 |
|---|---|---|
| `Cargo.toml`（根） | workspace | T1 |
| `crates/core/Cargo.toml`、`src/lib.rs`、各模块空文件 | core 骨架，预声明模块与依赖 | T1 |
| `Makefile`、`CLAUDE.md`、`REVIEW.md`、`.claude/hooks/format.sh`、`.claude/settings.json`、`.github/workflows/ci.yml`、`NOTICE` | 流程文件 | T1 |
| `src-tauri/**`、`src/**`、`package.json`、`vite.config.ts`、`index.html`、`tsconfig*.json` | Tauri + React 脚手架 | T2 |
| `crates/core/src/models.rs`、`fs.rs`、`test_support.rs` | 共享类型与文件系统原语 | T3 |
| `crates/core/src/sync.rs` | 通用同步 | T4 |
| `crates/core/src/skills.rs` | 矩阵 | T5 |
| `crates/core/src/discovery.rs`、`crates/core/data/harnesses.json` | 发现层 | T6 |
| `crates/core/src/store.rs` | 持久化 | T7 |
| `src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`src/api.ts`、`src/types.ts`、`src/App.tsx`、`src/App.css`、`src/SkillsTab.tsx`（占位）、`src/CustomSyncTab.tsx`（占位） | 命令层与前端壳 | T8 |
| `src/SkillsTab.tsx` | 矩阵界面 | T9 |
| `src/CustomSyncTab.tsx` | 通用同步界面 | T10 |
| `docs/manual-checks.md`、删除 `SymSyncCore/`、`SymSync/`、`project.yml`、`.gitignore` 清理、plan 附录 | 验证与迁移 | T11 |

### Order of work

```
T1 脚手架 ─→ T2 Tauri 脚手架 ─→ T3 models+fs ─→ ┬─ T4 sync      ─┐
                                                 ├─ T5 skills    ─┤
                                                 ├─ T6 discovery ─┼─→ T8 命令层+前端壳 ─→ ┬─ T9 SkillsTab     ─┬─→ T11 验证与迁移
                                                 └─ T7 store     ─┘                       └─ T10 CustomSyncTab ─┘
```

- 主分支 `feat/rust-pivot` 从 `main` 切出。串行任务直接在该分支上做。
- 并行波次（T4–T7、T9–T10）每个任务在自己的 worktree 与分支上做（`git worktree add .worktrees/t<N> -b task/t<N> feat/rust-pivot`），控制器负责合并回 `feat/rust-pivot`，因文件不重叠，合并无冲突。
- 里程碑 PR：T1–T7 一个（core），T8–T11 一个（app）。控制器不合并。

### Risks

- **Windows junction 语义**：`symlink_metadata().file_type().is_symlink()` 对 junction 返回 true、`read_link` 可读、`remove_dir` 可删，均为标准库文档行为，但本机无法验证；所有 Windows 分支 `#[cfg(windows)]` 隔离，标注待验证。
- **`~/.claude.json` 格式非公开**：解析失败只退化为手动列表。
- **Tauri 首次构建慢**（编译 wry / tao 数分钟）：T2 只构建一次，之后 `cargo check`。
- **`canonicalize` 在 macOS 把 `/var` 解析为 `/private/var`**：测试夹具的 root 先 canonicalize，所有比较两侧同源。
- **并行任务碰共享文件**：`lib.rs` 模块声明、`Cargo.toml` 依赖、`App.tsx` 的 tab 挂载点全部在前置任务里预留，并行任务只填各自文件。

### Proof

- `cargo test -p symsync-core`：T3–T7 全部测试通过（预计 45 个左右）。
- `cargo clippy --workspace -- -D warnings` 零警告。
- `npm run build` 通过；`npm run tauri build -- --debug` 产出可运行的 App。
- T11 手动清单在真实目录上逐项通过。

---

## Task 1: Cargo workspace、core 骨架与流程文件

**Files:**
- Create: `Cargo.toml`、`crates/core/Cargo.toml`、`crates/core/src/lib.rs`、`crates/core/src/{models,fs,sync,skills,discovery,store}.rs`（空模块）、`NOTICE`
- Modify: `Makefile`、`CLAUDE.md`、`REVIEW.md`、`.claude/settings.json`、`.gitignore`
- Create: `.claude/hooks/format.sh`；Delete: `.claude/hooks/format-swift.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: 可 `cargo test -p symsync-core`（0 个测试）的 workspace；所有 core 依赖已在 `Cargo.toml` 中；`lib.rs` 已声明全部模块，后续任务只填文件。

- [ ] **Step 1: 打 tag、建分支**

```bash
git checkout main && git pull
git tag -a v0.1-swift -m "Swift/SwiftUI version before Rust pivot"
git push origin v0.1-swift
git checkout -b feat/rust-pivot
```

- [ ] **Step 2: workspace 与 core 骨架**

`Cargo.toml`（根）：
```toml
[workspace]
members = ["crates/core", "src-tauri"]
resolver = "2"
```
`src-tauri` 由 Task 2 生成；在它出现之前 `cargo` 会报 "failed to read src-tauri/Cargo.toml"。本任务先写 `members = ["crates/core"]`，Task 2 再加上 `"src-tauri"`。

`crates/core/Cargo.toml`：
```toml
[package]
name = "symsync-core"
version = "0.2.0"
edition = "2021"
license = "MIT"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
dirs = "7"
thiserror = "2"
pathdiff = "0.2"

[target.'cfg(windows)'.dependencies]
junction = "2"

[dev-dependencies]
tempfile = "3"
```

`crates/core/src/lib.rs`：
```rust
//! symsync-core：软链接同步与 skill 矩阵的核心逻辑。无 UI、无 Tauri 依赖。
pub mod discovery;
pub mod fs;
pub mod models;
pub mod skills;
pub mod store;
pub mod sync;

#[cfg(test)]
pub(crate) mod test_support;
```

六个模块文件各只放一行注释，例如 `crates/core/src/models.rs`：
```rust
//! 共享类型（Task 3 实现）
```
`test_support.rs` 由 Task 3 创建；本任务先创建一个空的 `crates/core/src/test_support.rs`（内容 `//! 测试夹具（Task 3 实现）`），否则 `cargo test` 找不到模块。

- [ ] **Step 3: 运行**

Run: `cargo test -p symsync-core`
Expected: 编译通过，`running 0 tests`

- [ ] **Step 4: 流程文件**

`Makefile`（整文件替换）：
```make
SHELL := /bin/bash
.PHONY: test test-core lint build-web dev build format

test: test-core lint build-web

test-core:
	cargo test -p symsync-core

lint:
	cargo clippy --workspace --all-targets -- -D warnings

build-web:
	npm run build

dev:
	npm run tauri dev

build:
	npm run tauri build -- --debug

format:
	cargo fmt --all
	npx --no-install prettier --write "src/**/*.{ts,tsx,css}"
```

`CLAUDE.md`（整文件替换）：
```markdown
# SymSync

跨平台桌面应用：发现各 AI coding harness 的 skill 目录，展示 skill × harness 矩阵，补缺失软链、清坏链；另有通用"源目录 → 多目标"软链同步。Rust core（`crates/core`，crate 名 `symsync-core`）+ Tauri 2 命令层（`src-tauri`）+ React/TypeScript 前端（`src`）。

## Commands

- `make test-core`：core 单元测试。健康输出末尾 `test result: ok. N passed; 0 failed`
- `make lint`：clippy，零警告
- `make build-web`：前端类型检查与打包
- `make test`：以上三者，提交前必跑
- `make dev`：启动开发窗口；`make build`：产出 debug App（`src-tauri/target/debug/bundle/`）
- `make format`：rustfmt + prettier

## Conventions

- Rust 2021，`clippy -D warnings`；core 不依赖 tauri
- 测试用 `tempfile` 在临时目录搭真实文件树（`test_support::TempTree`），不 mock 文件系统
- 注释与 UI 文案中文，标识符英文；Conventional Commits
- serde 统一 `rename_all = "camelCase"`，前端 `src/types.ts` 与之对应

## Architecture

- `crates/core/src/models.rs`：共享类型（SyncRule、PlannedAction、Outcome、Harness、Domain、LinkStyle）
- `fs.rs`：`entry_kind`（lstat）、`real_path`、`normalize`、`create_link`
- `sync.rs`：通用同步 `plan` / `execute`
- `skills.rs`：矩阵 `scan` / `propose`，本体判定
- `discovery.rs` + `data/harnesses.json`：harness 表、已安装判定、项目候选
- `store.rs`：`rules.json` / `projects.json`
- `src-tauri/src/lib.rs`：命令，每个一行调 core
- `src/`：`App.tsx` 壳、`SkillsTab.tsx`、`CustomSyncTab.tsx`、`api.ts`、`types.ts`

## Verifying your work

- 改 core：`make test-core && make lint` 全绿
- 改 src-tauri 或 src：`make build-web && cargo check --workspace`，并在 `make dev` 里手动走一遍受影响的流程
- 报告完成前贴出命令输出末尾。测试失败改代码，不改测试

## Things Claude gets wrong

- `Path::exists()` / `is_dir()` 跟随软链，坏链返回 false。判断条目类型用 `fs::entry_kind`（`symlink_metadata`）。唯一例外：判断"目标目录是否存在"要跟随软链，用 `is_dir()`
- 比较"是否指向同一处"用 `fs::real_path`（canonicalize）；macOS 上 `/var` 会变成 `/private/var`，两侧必须同源
- Unix 删软链用 `remove_file`，Windows 删 junction 用 `remove_dir`；删前必须重校验仍是软链
- `Path::starts_with` 按路径分量比较，不要用字符串 `starts_with`
- 并行任务只碰自己 Files 列表里的文件；`lib.rs`、`Cargo.toml`、`App.tsx` 由前置任务预留
```

`REVIEW.md`：把 Compliance 一行改为 ``- Compliance：改动是否符合 `docs/specs/2026-09-06-skill-sync-design.md` 与 `docs/plans/2026-09-06-skill-sync-plan.md`；core 是否引入了 tauri 依赖``，Do not report 改为 ``` `src-tauri/target/`、`dist/`、`node_modules/`、格式问题（`make format` 已处理）```。

`.claude/hooks/format.sh`（替换 `format-swift.sh`）：
```bash
#!/bin/bash
file=$(jq -r '.tool_input.file_path // empty' < /dev/stdin)
[[ -n "$file" && -f "$file" ]] || exit 0
case "$file" in
  *.rs) rustfmt --edition 2021 "$file" 2>/dev/null ;;
  *.ts|*.tsx|*.css) (cd "$CLAUDE_PROJECT_DIR" && npx --no-install prettier --write "$file" >/dev/null 2>&1) ;;
esac
exit 0
```
```bash
chmod +x .claude/hooks/format.sh && git rm -q .claude/hooks/format-swift.sh
```
`.claude/settings.json` 里 `format-swift.sh` 改为 `format.sh`；`protect-tests.sh` 的匹配从 `*/Tests/*` 改为同时匹配 `*/tests/*` 和 `*_test.rs`：
```bash
if [[ -f "$CLAUDE_PROJECT_DIR/.claude/FIXING" && ( "$file" == *"/tests/"* || "$file" == *"/Tests/"* || "$file" == *"test_support.rs" ) ]]; then
```

`.github/workflows/ci.yml`（整文件替换）：
```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  core:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      - run: cargo test -p symsync-core
      - run: cargo clippy -p symsync-core --all-targets -- -D warnings
  app:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - run: cargo check --workspace
```
`app` job 在 Task 2 之前会失败（没有 package.json），属预期。

`NOTICE`：
```
SymSync 包含以下 MIT 许可证项目的派生内容：

- vercel-labs/skills (https://github.com/vercel-labs/skills), Copyright (c) Vercel, Inc.
  crates/core/data/harnesses.json 的 harness 目录表整理自其 src/agents.ts；
  crates/core/src/fs.rs 的链接策略（Unix 相对软链、Windows junction）参考其 src/installer.ts。
```

`.gitignore` 追加：
```
# Rust / Tauri / Node
target/
node_modules/
dist/
.worktrees/
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: cargo workspace, core skeleton and process files for Rust pivot"
```

---

## Task 2: Tauri + React 脚手架

**Files:**
- Create: `src-tauri/**`、`src/**`、`package.json`、`package-lock.json`、`vite.config.ts`、`index.html`、`tsconfig.json`、`tsconfig.node.json`、`public/`、`.prettierrc`
- Modify: `Cargo.toml`（workspace 加 `src-tauri`）、`src-tauri/Cargo.toml`（依赖 core 与 dialog 插件）、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`（注册 dialog 插件）

**Interfaces:**
- Produces: `npm run build`、`cargo check --workspace`、`npm run tauri build -- --debug` 全部通过；`src-tauri/src/lib.rs` 的 `run()` 已注册 `tauri_plugin_dialog`，Task 8 只需在 `invoke_handler` 里加命令。

- [ ] **Step 1: 脚手架到仓库根目录**

```bash
npx --yes create-tauri-app@latest . --force -t react-ts -m npm --identifier com.zhengjiaqiao.symsync -y
npm install
npm install --save-dev prettier
npm install @tauri-apps/plugin-dialog
```
**注意：`create-tauri-app --force` 会先清空目标目录再生成**（Task 2 实施时确认）。已跟踪文件可用 `git checkout -- .` 恢复，但未跟踪的 `.superpowers/`、`build/`、`.claude/settings.local.json` 会丢失。更稳妥的做法是先在临时目录生成再把文件拷进仓库根。生成后检查根目录出现 `package.json`、`src/`、`src-tauri/`、`index.html`、`vite.config.ts`。若脚手架把项目名写成目录名之外的值，把 `package.json` 的 `name` 改为 `symsync`，`src-tauri/Cargo.toml` 的 `name` 改为 `symsync`、`[lib] name = "symsync_lib"`。

`.prettierrc`：
```json
{ "semi": true, "singleQuote": false, "printWidth": 100 }
```

- [ ] **Step 2: 接入 workspace 与 core**

根 `Cargo.toml` 改为 `members = ["crates/core", "src-tauri"]`。

`src-tauri/Cargo.toml` 的 `[dependencies]` 确保包含：
```toml
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
symsync-core = { path = "../crates/core" }
```

`src-tauri/src/lib.rs` 的 `run()` 改为：
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
删除模板自带的 `greet` 命令及其前端调用（`src/App.tsx` 改为只渲染 `<main>SymSync</main>`）。

`src-tauri/capabilities/default.json` 的 `permissions` 数组加入 `"dialog:default"`。

`src-tauri/tauri.conf.json`：`productName` 设为 `SymSync`，`app.windows[0]` 的 `title` 设为 `SymSync`、`width` 1100、`height` 720。

- [ ] **Step 3: 验证**

Run: `npm run build && cargo check --workspace && npm run tauri build -- --debug 2>&1 | tail -5`
Expected: 前端打包成功；`cargo check` 无错误；tauri build 末尾出现 `Finished` 与 bundle 路径（首次编译数分钟）。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 + React app wired to symsync-core"
```

---

## Task 3: 共享类型、文件系统原语、测试夹具

**Files:**
- Modify: `crates/core/src/models.rs`、`crates/core/src/fs.rs`、`crates/core/src/test_support.rs`

**Interfaces:**
- Produces（后续所有任务依赖，签名不得改动）:
  - `models`: `Selection`、`SyncRule`、`ActionKind`、`PlannedAction`（含 `id()`）、`Outcome`、`ReportEntry`、`SyncReport`、`LinkStyle`、`Harness`、`Domain`
  - `fs`: `EntryKind`、`entry_kind(&Path) -> EntryKind`、`real_path(&Path) -> Option<PathBuf>`、`normalize(&Path) -> PathBuf`、`create_link(target, link, LinkStyle) -> io::Result<()>`、`remove_link(&Path) -> io::Result<()>`、`same_real(&Path, &Path) -> bool`
  - `test_support::TempTree`: `new()`、`root()`、`dir(rel)`、`file(dir, name)`、`link(at, to)`

- [ ] **Step 1: models.rs**

```rust
//! 共享类型。serde 统一 camelCase，前端 `src/types.ts` 与之对应。
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 同步整目录，或只同步指定名字的子项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Selection {
    All,
    Items(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRule {
    pub id: uuid::Uuid,
    pub name: String,
    pub source: PathBuf,
    pub selection: Selection,
    pub targets: Vec<PathBuf>,
    pub last_run_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    /// 目标不存在，将建链
    Create,
    /// 已是指向正确源的软链，跳过
    AlreadyLinked,
    /// 目标存在真实文件/目录或指向他处的软链，跳过并报告
    Conflict,
    /// 指定子项在源里不存在
    SourceMissing,
    /// 目标里指向本源目录下、但源已不存在的软链
    BrokenLink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedAction {
    pub kind: ActionKind,
    pub item_name: String,
    /// 链接应指向的绝对路径
    pub source_path: PathBuf,
    /// 目标目录下的链接路径
    pub target_path: PathBuf,
    /// 所属目标目录
    pub target: PathBuf,
}

impl PlannedAction {
    /// 同一 kind 与 target_path 唯一，前端表格与结果合并用
    pub fn id(&self) -> String {
        format!("{:?}|{}", self.kind, self.target_path.display())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status", content = "reason")]
pub enum Outcome {
    Created,
    Skipped,
    Removed,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    pub action: PlannedAction,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub entries: Vec<ReportEntry>,
}

/// 新建软链的写法。Windows 忽略此项，一律 junction + 绝对路径
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkStyle {
    Absolute,
    Relative,
}

/// 一个 harness 的目录约定。路径已按当前机器解析
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    pub id: String,
    pub display_name: String,
    /// 相对项目根，如 ".claude/skills"
    pub project_dir: Option<String>,
    pub global_dir: Option<PathBuf>,
    /// 项目级直接读 .agents/skills
    pub universal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Domain {
    Global,
    Project { path: PathBuf },
}
```

- [ ] **Step 2: 写失败测试（fs）**

`crates/core/src/fs.rs` 先只放测试模块（实现在 Step 4 补齐），测试内容：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LinkStyle;
    use crate::test_support::TempTree;
    use std::path::Path;

    #[test]
    fn normalize_removes_dots_and_parent_refs() {
        assert_eq!(normalize(Path::new("/a/b/../c/")), Path::new("/a/c"));
        assert_eq!(normalize(Path::new("/a/./b")), Path::new("/a/b"));
        assert_eq!(normalize(Path::new("/..")), Path::new("/"));
    }

    #[test]
    fn entry_kind_distinguishes_missing_file_dir_symlink() {
        let t = TempTree::new();
        let d = t.dir("d");
        let f = t.file(&d, "f");
        let l = d.join("l");
        t.link(&l, &f);
        assert_eq!(entry_kind(&d.join("nope")), EntryKind::Missing);
        assert_eq!(entry_kind(&f), EntryKind::File);
        assert_eq!(entry_kind(&d), EntryKind::Dir);
        assert_eq!(entry_kind(&l), EntryKind::Symlink(f.clone()));
    }

    #[test]
    fn broken_symlink_is_still_symlink() {
        let t = TempTree::new();
        let d = t.dir("d");
        let gone = d.join("gone");
        let l = d.join("l");
        t.link(&l, &gone);
        assert_eq!(entry_kind(&l), EntryKind::Symlink(gone.clone()));
        assert!(!l.exists());
        assert_eq!(real_path(&l), None);
    }

    #[cfg(unix)]
    #[test]
    fn relative_symlink_destination_is_resolved_against_its_directory() {
        let t = TempTree::new();
        let d = t.dir("d");
        let f = t.file(&d, "f");
        let l = d.join("l");
        std::os::unix::fs::symlink("f", &l).unwrap();
        assert_eq!(entry_kind(&l), EntryKind::Symlink(f.clone()));
        assert!(same_real(&l, &f));
    }

    #[cfg(unix)]
    #[test]
    fn create_link_absolute_and_relative() {
        let t = TempTree::new();
        let src = t.dir("src/a");
        let dst = t.dir("dst");
        create_link(&src, &dst.join("abs"), LinkStyle::Absolute).unwrap();
        create_link(&src, &dst.join("rel"), LinkStyle::Relative).unwrap();
        assert_eq!(std::fs::read_link(dst.join("abs")).unwrap(), src);
        assert_eq!(std::fs::read_link(dst.join("rel")).unwrap(), Path::new("../src/a"));
        assert!(same_real(&dst.join("rel"), &src));
    }

    #[test]
    fn remove_link_removes_only_the_link() {
        let t = TempTree::new();
        let d = t.dir("d");
        let f = t.file(&d, "f");
        let l = d.join("l");
        t.link(&l, &f);
        remove_link(&l).unwrap();
        assert_eq!(entry_kind(&l), EntryKind::Missing);
        assert!(f.exists());
    }
}
```

- [ ] **Step 3: 测试夹具**

`crates/core/src/test_support.rs`：
```rust
//! 在系统临时目录下搭真实文件树；root 已 canonicalize，避免 macOS 的 /var 与 /private/var 差异
use std::path::{Path, PathBuf};

pub struct TempTree {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl TempTree {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize");
        Self { _dir: dir, root }
    }

    pub fn root(&self) -> PathBuf {
        self.root.clone()
    }

    /// 相对 root 创建目录（可多级）
    pub fn dir(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(&p).expect("create_dir_all");
        p
    }

    /// 在目录下创建小文件
    pub fn file(&self, dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "x").expect("write");
        p
    }

    /// 建软链 at -> to（绝对路径）
    pub fn link(&self, at: &Path, to: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(to, at).expect("symlink");
        #[cfg(windows)]
        junction::create(to, at).expect("junction");
    }
}
```

- [ ] **Step 4: 运行确认失败**

Run: `cargo test -p symsync-core`
Expected: 编译错误 `cannot find function 'normalize'`

- [ ] **Step 5: fs.rs 实现（放在测试模块之前）**

```rust
//! 文件系统原语：lstat 语义的条目判定、realpath、路径标准化、建链/删链
use crate::models::LinkStyle;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    Missing,
    /// 链接目标，已解析为标准化的绝对路径（不解析软链）
    Symlink(PathBuf),
    File,
    Dir,
}

/// 基于 symlink_metadata（lstat），坏软链也识别为 Symlink
pub fn entry_kind(path: &Path) -> EntryKind {
    match std::fs::symlink_metadata(path) {
        Err(_) => EntryKind::Missing,
        Ok(meta) if meta.file_type().is_symlink() => {
            let raw = std::fs::read_link(path).unwrap_or_default();
            let abs = if raw.is_absolute() {
                raw
            } else {
                path.parent().unwrap_or(Path::new("")).join(raw)
            };
            EntryKind::Symlink(normalize(&abs))
        }
        Ok(meta) if meta.is_dir() => EntryKind::Dir,
        Ok(_) => EntryKind::File,
    }
}

/// canonicalize；目标不存在（坏链）时为 None
pub fn real_path(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// 两个路径解析后是否同一处
pub fn same_real(a: &Path, b: &Path) -> bool {
    matches!((real_path(a), real_path(b)), (Some(x), Some(y)) if x == y)
}

/// 去掉 `.`、`..`、尾斜杠，不解析软链
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                let popped = out.pop();
                if !popped && !path.is_absolute() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 建链。Unix 按 style 写绝对或相对目标；Windows 一律 junction + 绝对路径
pub fn create_link(target: &Path, link: &Path, style: LinkStyle) -> io::Result<()> {
    #[cfg(unix)]
    {
        let link_target = match style {
            LinkStyle::Absolute => target.to_path_buf(),
            LinkStyle::Relative => {
                // 相对路径要基于链接所在目录的真实位置计算，父目录本身是软链时才不会算错
                let parent = link.parent().unwrap_or(Path::new("."));
                let real_parent = real_path(parent).unwrap_or_else(|| parent.to_path_buf());
                let real_target = real_path(target).unwrap_or_else(|| target.to_path_buf());
                pathdiff::diff_paths(&real_target, &real_parent).unwrap_or_else(|| target.to_path_buf())
            }
        };
        std::os::unix::fs::symlink(link_target, link)
    }
    #[cfg(windows)]
    {
        let _ = style;
        junction::create(target, link)
    }
}

/// 只删链接本身。Unix 软链是文件，Windows junction 是目录
pub fn remove_link(link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::remove_file(link)
    }
    #[cfg(windows)]
    {
        std::fs::remove_dir(link)
    }
}
```

`normalize(Path::new("/.."))`：`out` 先压入 RootDir，遇到 `..` 时 `pop()` 对只剩根的 PathBuf 返回 false，且路径是绝对的，于是不压 `..`，结果 `/`。

- [ ] **Step 6: 运行确认通过**

Run: `cargo test -p symsync-core && cargo clippy -p symsync-core --all-targets -- -D warnings`
Expected: `6 passed`（Windows 上 4 个）；clippy 零警告。

- [ ] **Step 7: 提交**

```bash
git add crates/core
git commit -m "feat(core): shared models, lstat-based fs primitives and temp tree fixture"
```

---

## Task 4: 通用同步 `sync`（并行波次 A）

**Files:**
- Modify: `crates/core/src/sync.rs`

**Interfaces:**
- Consumes: Task 3 全部
- Produces: `PlanError`、`plan(&SyncRule) -> Result<Vec<PlannedAction>, PlanError>`、`execute(&[PlannedAction], clean_broken: bool, LinkStyle) -> SyncReport`

- [ ] **Step 1: 写失败测试**

`crates/core/src/sync.rs` 测试模块（实现见 Step 3）：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{entry_kind, EntryKind};
    use crate::models::*;
    use crate::test_support::TempTree;
    use std::path::{Path, PathBuf};

    fn rule(src: &Path, targets: &[&Path], selection: Selection) -> SyncRule {
        SyncRule {
            id: uuid::Uuid::new_v4(),
            name: "r".into(),
            source: src.to_path_buf(),
            selection,
            targets: targets.iter().map(|p| p.to_path_buf()).collect(),
            last_run_at: None,
        }
    }
    fn kinds(a: &[PlannedAction]) -> Vec<ActionKind> { a.iter().map(|x| x.kind).collect() }
    fn outcomes(r: &SyncReport) -> Vec<Outcome> { r.entries.iter().map(|e| e.outcome.clone()).collect() }

    #[test]
    fn fresh_target_plans_create_for_each_item_sorted() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        t.file(&src, "b.md"); t.dir("src/a");
        let actions = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        assert_eq!(actions.iter().map(|a| a.item_name.clone()).collect::<Vec<_>>(), vec!["a", "b.md"]);
        assert!(actions.iter().all(|a| a.kind == ActionKind::Create));
        assert_eq!(actions[0].source_path, src.join("a"));
        assert_eq!(actions[0].target_path, dst.join("a"));
        assert_eq!(actions[0].target, dst);
    }

    #[test]
    fn existing_correct_link_is_already_linked() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        let a = t.file(&src, "a.md");
        t.link(&dst.join("a.md"), &a);
        assert_eq!(kinds(&plan(&rule(&src, &[&dst], Selection::All)).unwrap()), vec![ActionKind::AlreadyLinked]);
    }

    #[test]
    fn real_file_and_foreign_link_are_conflicts() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst"); let other = t.dir("other");
        t.file(&src, "a.md"); t.file(&src, "b.md");
        t.file(&dst, "a.md");
        let ob = t.file(&other, "b.md");
        t.link(&dst.join("b.md"), &ob);
        assert_eq!(kinds(&plan(&rule(&src, &[&dst], Selection::All)).unwrap()), vec![ActionKind::Conflict, ActionKind::Conflict]);
    }

    #[test]
    fn unreadable_source_throws_for_both_selections() {
        let t = TempTree::new();
        let dst = t.dir("dst");
        let src = t.root().join("missing");
        assert_eq!(plan(&rule(&src, &[&dst], Selection::All)), Err(PlanError::SourceUnreadable(src.clone())));
        assert_eq!(plan(&rule(&src, &[&dst], Selection::Items(vec!["a".into()]))), Err(PlanError::SourceUnreadable(src.clone())));
    }

    #[test]
    fn items_selection_reports_missing_names_and_skips_hidden_in_all() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        t.file(&src, "a.md"); t.file(&src, ".DS_Store");
        let items = plan(&rule(&src, &[&dst], Selection::Items(vec!["a.md".into(), "zzz".into()]))).unwrap();
        assert_eq!(kinds(&items), vec![ActionKind::Create, ActionKind::SourceMissing]);
        let all = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        assert_eq!(all.iter().map(|a| a.item_name.clone()).collect::<Vec<_>>(), vec!["a.md"]);
    }

    #[test]
    fn multiple_targets_are_independent() {
        let t = TempTree::new();
        let src = t.dir("src"); let d1 = t.dir("d1"); let d2 = t.dir("d2");
        let a = t.file(&src, "a.md");
        t.link(&d1.join("a.md"), &a);
        let actions = plan(&rule(&src, &[&d1, &d2], Selection::All)).unwrap();
        assert_eq!(kinds(&actions), vec![ActionKind::AlreadyLinked, ActionKind::Create]);
        assert_eq!(actions.iter().map(|a| a.target.clone()).collect::<Vec<_>>(), vec![d1, d2]);
    }

    #[test]
    fn broken_links_under_source_reported_others_ignored() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        t.file(&src, "keep.md");
        t.link(&dst.join("gone.md"), &src.join("gone.md"));
        t.link(&dst.join("foreign"), &t.root().join("elsewhere/x"));
        let actions = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        assert_eq!(kinds(&actions), vec![ActionKind::Create, ActionKind::BrokenLink]);
        assert_eq!(actions[1].item_name, "gone.md");
        assert_eq!(actions[1].source_path, src.join("gone.md"));
        assert_eq!(actions[1].target_path, dst.join("gone.md"));
    }

    #[test]
    fn execute_creates_absolute_links_and_second_run_skips() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        let a = t.file(&src, "a.md");
        let r = execute(&plan(&rule(&src, &[&dst], Selection::All)).unwrap(), false, LinkStyle::Absolute);
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(std::fs::read_link(dst.join("a.md")).unwrap(), a);
        let r2 = execute(&plan(&rule(&src, &[&dst], Selection::All)).unwrap(), false, LinkStyle::Absolute);
        assert_eq!(kinds(&r2.entries.iter().map(|e| e.action.clone()).collect::<Vec<_>>()), vec![ActionKind::AlreadyLinked]);
        assert_eq!(outcomes(&r2), vec![Outcome::Skipped]);
    }

    #[cfg(unix)]
    #[test]
    fn execute_relative_style_writes_relative_target() {
        let t = TempTree::new();
        let src = t.dir("proj/.agents/skills"); let dst = t.dir("proj/.claude/skills");
        t.dir("proj/.agents/skills/x");
        let r = execute(&plan(&rule(&src, &[&dst], Selection::All)).unwrap(), false, LinkStyle::Relative);
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(std::fs::read_link(dst.join("x")).unwrap(), PathBuf::from("../../.agents/skills/x"));
    }

    #[test]
    fn conflict_is_skipped_and_real_file_untouched() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        t.file(&src, "a.md");
        std::fs::write(dst.join("a.md"), "original").unwrap();
        let r = execute(&plan(&rule(&src, &[&dst], Selection::All)).unwrap(), false, LinkStyle::Absolute);
        assert_eq!(outcomes(&r), vec![Outcome::Skipped]);
        assert_eq!(std::fs::read_to_string(dst.join("a.md")).unwrap(), "original");
    }

    #[test]
    fn missing_target_dir_fails_without_creating_it_but_symlinked_dir_works() {
        let t = TempTree::new();
        let src = t.dir("src"); t.file(&src, "a.md");
        let missing = t.root().join("nope");
        let r = execute(&plan(&rule(&src, &[&missing], Selection::All)).unwrap(), false, LinkStyle::Absolute);
        assert_eq!(outcomes(&r), vec![Outcome::Failed("目标目录不存在".into())]);
        assert_eq!(entry_kind(&missing), EntryKind::Missing);
        let real = t.dir("real"); let via = t.root().join("via");
        t.link(&via, &real);
        let r2 = execute(&plan(&rule(&src, &[&via], Selection::All)).unwrap(), false, LinkStyle::Absolute);
        assert_eq!(outcomes(&r2), vec![Outcome::Created]);
        assert!(matches!(entry_kind(&real.join("a.md")), EntryKind::Symlink(_)));
    }

    #[test]
    fn broken_links_kept_unless_clean_requested_and_recheck_before_delete() {
        let t = TempTree::new();
        let src = t.dir("src"); let dst = t.dir("dst");
        let gone = dst.join("gone.md");
        t.link(&gone, &src.join("gone.md"));
        let foreign = dst.join("foreign");
        t.link(&foreign, &t.root().join("elsewhere"));
        let kept = execute(&plan(&rule(&src, &[&dst], Selection::All)).unwrap(), false, LinkStyle::Absolute);
        assert_eq!(outcomes(&kept), vec![Outcome::Skipped]);
        assert!(matches!(entry_kind(&gone), EntryKind::Symlink(_)));
        let planned = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        std::fs::remove_file(&gone).unwrap();
        std::fs::write(&gone, "real").unwrap();
        let guarded = execute(&planned, true, LinkStyle::Absolute);
        assert_eq!(outcomes(&guarded), vec![Outcome::Failed("不再是软链接，已跳过".into())]);
        assert_eq!(std::fs::read_to_string(&gone).unwrap(), "real");
        std::fs::remove_file(&gone).unwrap();
        t.link(&gone, &src.join("gone.md"));
        let cleaned = execute(&plan(&rule(&src, &[&dst], Selection::All)).unwrap(), true, LinkStyle::Absolute);
        assert_eq!(outcomes(&cleaned), vec![Outcome::Removed]);
        assert_eq!(entry_kind(&gone), EntryKind::Missing);
        assert!(matches!(entry_kind(&foreign), EntryKind::Symlink(_)));
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p symsync-core sync::`
Expected: 编译错误 `cannot find function 'plan'`

- [ ] **Step 3: 实现**

```rust
//! 通用同步：源目录子项 → 多个目标目录的软链。plan 只读，execute 逐项独立
use crate::fs::{create_link, entry_kind, normalize, remove_link, same_real, EntryKind};
use crate::models::*;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PlanError {
    #[error("源目录不可读：{0}")]
    SourceUnreadable(PathBuf),
}

/// 只读规划。两种 selection 都先确认源目录可列举
pub fn plan(rule: &SyncRule) -> Result<Vec<PlannedAction>, PlanError> {
    let source = normalize(&rule.source);
    let entries = list_dir(&source).ok_or_else(|| PlanError::SourceUnreadable(source.clone()))?;
    let names: Vec<String> = match &rule.selection {
        Selection::All => {
            let mut v: Vec<String> = entries.into_iter().filter(|n| !n.starts_with('.')).collect();
            v.sort();
            v
        }
        Selection::Items(items) => items.clone(),
    };
    let mut actions = Vec::new();
    for target in &rule.targets {
        let target_dir = normalize(target);
        for name in &names {
            actions.push(action_for(name, &source, &target_dir));
        }
        actions.extend(broken_links(&target_dir, &source));
    }
    Ok(actions)
}

fn list_dir(dir: &Path) -> Option<Vec<String>> {
    let rd = std::fs::read_dir(dir).ok()?;
    Some(
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
    )
}

fn action_for(name: &str, source: &Path, target_dir: &Path) -> PlannedAction {
    let source_path = source.join(name);
    let target_path = target_dir.join(name);
    let kind = if entry_kind(&source_path) == EntryKind::Missing {
        ActionKind::SourceMissing
    } else {
        match entry_kind(&target_path) {
            EntryKind::Missing => ActionKind::Create,
            EntryKind::Symlink(dest) if dest == source_path || same_real(&target_path, &source_path) => {
                ActionKind::AlreadyLinked
            }
            _ => ActionKind::Conflict,
        }
    };
    PlannedAction { kind, item_name: name.to_string(), source_path, target_path, target: target_dir.to_path_buf() }
}

/// 目标目录里指向 source/ 之下、但源已不存在的软链
fn broken_links(target_dir: &Path, source: &Path) -> Vec<PlannedAction> {
    let Some(mut entries) = list_dir(target_dir) else { return Vec::new() };
    entries.sort();
    entries
        .into_iter()
        .filter_map(|name| {
            let path = target_dir.join(&name);
            let EntryKind::Symlink(dest) = entry_kind(&path) else { return None };
            if dest.as_path() == source || !dest.starts_with(source) || dest.exists() {
                return None;
            }
            Some(PlannedAction {
                kind: ActionKind::BrokenLink,
                item_name: name,
                source_path: dest,
                target_path: path,
                target: target_dir.to_path_buf(),
            })
        })
        .collect()
}

/// 只对 Create 建链；BrokenLink 仅在 clean_broken 时删除，删前重校验仍是软链
pub fn execute(actions: &[PlannedAction], clean_broken: bool, style: LinkStyle) -> SyncReport {
    SyncReport {
        entries: actions
            .iter()
            .map(|a| ReportEntry { action: a.clone(), outcome: outcome_for(a, clean_broken, style) })
            .collect(),
    }
}

fn outcome_for(action: &PlannedAction, clean_broken: bool, style: LinkStyle) -> Outcome {
    match action.kind {
        ActionKind::Create => {
            // 目标目录是否存在要跟随软链判断（目标目录本身可能是软链）
            if !action.target.is_dir() {
                return Outcome::Failed("目标目录不存在".into());
            }
            match create_link(&action.source_path, &action.target_path, style) {
                Ok(()) => Outcome::Created,
                Err(e) => Outcome::Failed(e.to_string()),
            }
        }
        ActionKind::BrokenLink if clean_broken => {
            // 预览到确认之间路径可能已被换成真实文件
            if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_)) {
                return Outcome::Failed("不再是软链接，已跳过".into());
            }
            match remove_link(&action.target_path) {
                Ok(()) => Outcome::Removed,
                Err(e) => Outcome::Failed(e.to_string()),
            }
        }
        _ => Outcome::Skipped,
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p symsync-core sync:: && cargo clippy -p symsync-core --all-targets -- -D warnings`
Expected: `12 passed`（Windows 11 个）；clippy 零警告。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/sync.rs
git commit -m "feat(core): port generic symlink sync planner and executor"
```

---

## Task 5: 矩阵 `skills`（并行波次 A）

**Files:**
- Modify: `crates/core/src/skills.rs`

**Interfaces:**
- Consumes: Task 3 `models`、`fs`
- Produces: `CellState`、`Column`、`Cell`、`SkillRow`、`Summary`、`Matrix`、`UNIVERSAL_ID`、`link_style(&Domain) -> LinkStyle`、`columns(&Domain, &[Harness], home: &Path) -> Vec<Column>`、`scan(&Domain, &[Harness], home: &Path) -> Matrix`、`propose(&Matrix) -> Vec<PlannedAction>`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::entry_kind;
    use crate::fs::EntryKind;
    use crate::models::*;
    use crate::sync::execute;
    use crate::test_support::TempTree;
    use std::path::{Path, PathBuf};

    fn harnesses(home: &Path) -> Vec<Harness> {
        let h = |id: &str, name: &str, project: &str, global: PathBuf, universal: bool| Harness {
            id: id.into(), display_name: name.into(), project_dir: Some(project.into()), global_dir: Some(global), universal,
        };
        vec![
            h("claude-code", "Claude Code", ".claude/skills", home.join(".claude/skills"), false),
            h("codex", "Codex", ".agents/skills", home.join(".codex/skills"), true),
            h("cline", "Cline", ".agents/skills", home.join(".agents/skills"), true),
        ]
    }
    fn states(row: &SkillRow) -> Vec<(String, CellState)> { row.cells.iter().map(|c| (c.column_id.clone(), c.state)).collect() }
    fn row<'a>(m: &'a Matrix, name: &str) -> &'a SkillRow { m.rows.iter().find(|r| r.name == name).expect("row") }

    #[test]
    fn columns_put_universal_first_dedupe_by_real_path_and_skip_missing_dirs() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills"); t.dir(".claude/skills");
        let cols = columns(&Domain::Global, &harnesses(&home), &home);
        assert_eq!(cols.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![UNIVERSAL_ID, "claude-code"]);
        assert_eq!(cols[0].label, "通用仓库 / Cline");
        assert!(cols[0].universal);
    }

    #[test]
    fn fully_linked_skill_has_no_actions() {
        let t = TempTree::new();
        let home = t.root();
        let uni = t.dir(".agents/skills"); let cl = t.dir(".claude/skills"); let cx = t.dir(".codex/skills");
        let a = t.dir(".agents/skills/a");
        t.link(&cl.join("a"), &a); t.link(&cx.join("a"), &a);
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert_eq!(r.home, Some(a.clone()));
        assert!(!r.external_home && !r.ambiguous);
        assert_eq!(states(r), vec![(UNIVERSAL_ID.into(), CellState::Home), ("claude-code".into(), CellState::Linked), ("codex".into(), CellState::Linked)]);
        assert_eq!(m.summary, Summary { skills: 1, missing: 0, broken: 0, ambiguous: 0 });
        assert!(propose(&m).is_empty());
        let _ = uni;
    }

    #[test]
    fn missing_cell_proposes_create_to_home() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills"); let cl = t.dir(".claude/skills"); let cx = t.dir(".codex/skills");
        let a = t.dir(".agents/skills/a");
        t.link(&cl.join("a"), &a);
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        assert_eq!(row(&m, "a").cells[2].state, CellState::Missing);
        let actions = propose(&m);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::Create);
        assert_eq!(actions[0].source_path, a);
        assert_eq!(actions[0].target_path, cx.join("a"));
        assert_eq!(actions[0].target, cx);
        assert_eq!(m.summary.missing, 1);
    }

    #[test]
    fn broken_link_row_without_home_proposes_removal_only() {
        let t = TempTree::new();
        let home = t.root();
        let uni = t.dir(".agents/skills"); let cl = t.dir(".claude/skills");
        t.link(&cl.join("gone"), &uni.join("gone"));
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "gone");
        assert_eq!(r.home, None);
        assert!(!r.ambiguous);
        assert_eq!(r.cells[1].state, CellState::Broken);
        let actions = propose(&m);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::BrokenLink);
        assert_eq!(actions[0].target_path, cl.join("gone"));
        assert_eq!(m.summary.broken, 1);
    }

    #[test]
    fn foreign_link_is_reported_not_acted_on() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills"); let cl = t.dir(".claude/skills");
        t.dir(".agents/skills/a");
        let elsewhere = t.dir("elsewhere/a");
        t.link(&cl.join("a"), &elsewhere);
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert!(!r.ambiguous);
        assert_eq!(r.cells[1].state, CellState::Foreign);
        assert!(propose(&m).is_empty());
    }

    #[test]
    fn universal_store_wins_and_other_real_dir_is_duplicate() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills"); let cl = t.dir(".claude/skills"); t.dir(".codex/skills");
        let a = t.dir(".agents/skills/a"); t.dir(".codex/skills/a");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert_eq!(r.home, Some(a.clone()));
        assert_eq!(states(r), vec![(UNIVERSAL_ID.into(), CellState::Home), ("claude-code".into(), CellState::Missing), ("codex".into(), CellState::DuplicateHome)]);
        let actions = propose(&m);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].target_path, cl.join("a"));
        assert_eq!(actions[0].source_path, a);
    }

    #[test]
    fn single_real_dir_outside_store_becomes_home() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills"); t.dir(".claude/skills"); t.dir(".codex/skills");
        let pet = t.dir(".codex/skills/hatch-pet");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "hatch-pet");
        assert_eq!(r.home, Some(pet.clone()));
        assert_eq!(states(r), vec![(UNIVERSAL_ID.into(), CellState::Missing), ("claude-code".into(), CellState::Missing), ("codex".into(), CellState::Home)]);
        assert_eq!(propose(&m).len(), 2);
    }

    #[test]
    fn links_to_one_external_dir_make_external_home() {
        let t = TempTree::new();
        let home = t.root();
        let uni = t.dir(".agents/skills"); let cl = t.dir(".claude/skills");
        let ext = t.dir("local/ego-skills");
        t.link(&uni.join("ego"), &ext);
        t.link(&cl.join("ego"), &uni.join("ego"));
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "ego");
        assert_eq!(r.home, Some(ext.clone()));
        assert!(r.external_home && !r.ambiguous);
        assert_eq!(states(r), vec![(UNIVERSAL_ID.into(), CellState::Linked), ("claude-code".into(), CellState::Linked)]);
        assert!(propose(&m).is_empty());
    }

    #[test]
    fn two_real_dirs_without_store_are_ambiguous() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".claude/skills/a"); t.dir(".codex/skills/a");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert!(r.ambiguous);
        assert_eq!(r.home, None);
        assert!(r.cells.iter().all(|c| c.state == CellState::DuplicateHome));
        assert!(propose(&m).is_empty());
        assert_eq!(m.summary.ambiguous, 1);
        assert_eq!(m.summary.missing, 0);
    }

    #[cfg(unix)]
    #[test]
    fn project_domain_uses_relative_links() {
        let t = TempTree::new();
        let home = t.root();
        let proj = t.dir("proj");
        let x = t.dir("proj/.agents/skills/x"); let cl = t.dir("proj/.claude/skills");
        let domain = Domain::Project { path: proj.clone() };
        let m = scan(&domain, &harnesses(&home), &home);
        assert_eq!(m.columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![UNIVERSAL_ID, "claude-code"]);
        assert_eq!(row(&m, "x").cells[1].state, CellState::Missing);
        let report = execute(&propose(&m), false, link_style(&domain));
        assert_eq!(report.entries[0].outcome, Outcome::Created);
        assert_eq!(std::fs::read_link(cl.join("x")).unwrap(), PathBuf::from("../../.agents/skills/x"));
        assert_eq!(entry_kind(&cl.join("x")), EntryKind::Symlink(x.clone()));
        assert_eq!(row(&scan(&domain, &harnesses(&home), &home), "x").cells[1].state, CellState::Linked);
    }

    #[test]
    fn hidden_entries_are_skipped() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".codex/skills/.system"); t.dir(".codex/skills/real");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        assert_eq!(m.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["real"]);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_column_is_inaccessible_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills/a"); let cl = t.dir(".claude/skills");
        std::fs::set_permissions(&cl, std::fs::Permissions::from_mode(0o000)).unwrap();
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        std::fs::set_permissions(&cl, std::fs::Permissions::from_mode(0o755)).unwrap();
        if nix_is_root() { return; }
        assert_eq!(row(&m, "a").cells[1].state, CellState::Inaccessible);
        assert!(propose(&m).is_empty());
    }
    fn nix_is_root() -> bool { std::env::var("USER").map(|u| u == "root").unwrap_or(false) }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p symsync-core skills::`
Expected: 编译错误 `cannot find function 'columns'`

- [ ] **Step 3: 实现**

```rust
//! skill × harness 矩阵：域内本体判定、格状态、建议动作
use crate::fs::{entry_kind, normalize, real_path, EntryKind};
use crate::models::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    /// 真实目录，本体在此
    Home,
    /// 链接解析后等于本域本体
    Linked,
    Missing,
    /// 链接目标不存在
    Broken,
    /// 链接指向本域本体之外
    Foreign,
    /// 真实目录，但本域另有本体（或多本体冲突）
    DuplicateHome,
    /// 整列目录不可读
    Inaccessible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub universal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub column_id: String,
    pub path: PathBuf,
    pub state: CellState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub name: String,
    pub home: Option<PathBuf>,
    pub external_home: bool,
    pub cells: Vec<Cell>,
    pub ambiguous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub skills: usize,
    pub missing: usize,
    pub broken: usize,
    pub ambiguous: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    pub domain: Domain,
    pub columns: Vec<Column>,
    pub rows: Vec<SkillRow>,
    pub summary: Summary,
}

pub const UNIVERSAL_ID: &str = "universal";

/// 全局域绝对路径，项目域相对路径（随 git 走）
pub fn link_style(domain: &Domain) -> LinkStyle {
    match domain {
        Domain::Global => LinkStyle::Absolute,
        Domain::Project { .. } => LinkStyle::Relative,
    }
}

fn universal_path(domain: &Domain, home: &Path) -> PathBuf {
    match domain {
        Domain::Global => home.join(".agents").join("skills"),
        Domain::Project { path } => path.join(".agents").join("skills"),
    }
}

/// 域内实际存在的 harness 目录，通用仓库列在前；按真实路径去重，同一目录的 harness 合并标签
pub fn columns(domain: &Domain, harnesses: &[Harness], home: &Path) -> Vec<Column> {
    let mut cols: Vec<Column> = Vec::new();
    let mut keys: Vec<PathBuf> = Vec::new();
    let mut push = |id: &str, label: &str, path: PathBuf, universal: bool| {
        if !path.is_dir() {
            return;
        }
        let key = real_path(&path).unwrap_or_else(|| normalize(&path));
        if let Some(i) = keys.iter().position(|k| k == &key) {
            cols[i].label = format!("{} / {}", cols[i].label, label);
            cols[i].universal |= universal;
        } else {
            keys.push(key);
            cols.push(Column { id: id.to_string(), label: label.to_string(), path, universal });
        }
    };
    push(UNIVERSAL_ID, "通用仓库", universal_path(domain, home), true);
    for h in harnesses {
        let path = match domain {
            Domain::Global => h.global_dir.clone(),
            Domain::Project { path } => h.project_dir.as_ref().map(|d| path.join(d)),
        };
        if let Some(p) = path {
            push(&h.id, &h.display_name, p, h.universal);
        }
    }
    cols
}

/// 只读扫描，产出矩阵
pub fn scan(domain: &Domain, harnesses: &[Harness], home: &Path) -> Matrix {
    let columns = columns(domain, harnesses, home);
    let mut names = BTreeSet::new();
    let mut inaccessible = HashSet::new();
    for c in &columns {
        match std::fs::read_dir(&c.path) {
            Ok(rd) => {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().into_owned();
                    if !n.starts_with('.') {
                        names.insert(n);
                    }
                }
            }
            Err(_) => {
                inaccessible.insert(c.id.clone());
            }
        }
    }
    let rows: Vec<SkillRow> = names.iter().map(|n| build_row(n, &columns, &inaccessible)).collect();
    let summary = Summary {
        skills: rows.len(),
        missing: rows.iter().filter(|r| !r.ambiguous).flat_map(|r| &r.cells).filter(|c| c.state == CellState::Missing).count(),
        broken: rows.iter().flat_map(|r| &r.cells).filter(|c| c.state == CellState::Broken).count(),
        ambiguous: rows.iter().filter(|r| r.ambiguous).count(),
    };
    Matrix { domain: domain.clone(), columns, rows, summary }
}

struct Entry<'a> {
    col: &'a Column,
    path: PathBuf,
    kind: EntryKind,
    real: Option<PathBuf>,
}

/// 本体判定：通用仓库真实目录 > 域内唯一真实目录 > 所有链接指向同一域外目录 > 多本体
fn build_row(name: &str, columns: &[Column], inaccessible: &HashSet<String>) -> SkillRow {
    let entries: Vec<Entry> = columns
        .iter()
        .map(|c| {
            let path = c.path.join(name);
            Entry { col: c, kind: entry_kind(&path), real: real_path(&path), path }
        })
        .collect();
    let real_dirs: Vec<&Entry> = entries.iter().filter(|e| e.kind == EntryKind::Dir).collect();
    let live_targets: BTreeSet<PathBuf> = entries
        .iter()
        .filter(|e| matches!(e.kind, EntryKind::Symlink(_)))
        .filter_map(|e| e.real.clone())
        .filter(|p| p.is_dir())
        .collect();
    let mut external_home = false;
    let home: Option<PathBuf> = if let Some(e) = real_dirs.iter().find(|e| e.col.universal) {
        e.real.clone()
    } else if real_dirs.len() == 1 {
        real_dirs[0].real.clone()
    } else if real_dirs.is_empty() && live_targets.len() == 1 {
        external_home = true;
        live_targets.iter().next().cloned()
    } else {
        None
    };
    let ambiguous = home.is_none() && (real_dirs.len() > 1 || live_targets.len() > 1);
    let cells = entries
        .iter()
        .map(|e| {
            let state = if inaccessible.contains(&e.col.id) {
                CellState::Inaccessible
            } else {
                match &e.kind {
                    EntryKind::Missing => CellState::Missing,
                    EntryKind::Dir | EntryKind::File => {
                        if e.real.is_some() && e.real == home { CellState::Home } else { CellState::DuplicateHome }
                    }
                    EntryKind::Symlink(_) => match &e.real {
                        None => CellState::Broken,
                        Some(r) if Some(r) == home.as_ref() => CellState::Linked,
                        Some(_) => CellState::Foreign,
                    },
                }
            };
            Cell { column_id: e.col.id.clone(), path: e.path.clone(), state }
        })
        .collect();
    SkillRow { name: name.to_string(), home, external_home, cells, ambiguous }
}

/// Missing → 建链指向本体；Broken → 删链。其余状态只报告；多本体行不生成动作
pub fn propose(matrix: &Matrix) -> Vec<PlannedAction> {
    matrix
        .rows
        .iter()
        .filter(|r| !r.ambiguous)
        .flat_map(|row| {
            row.cells.iter().filter_map(move |cell| {
                let target = cell.path.parent().map(Path::to_path_buf).unwrap_or_default();
                match cell.state {
                    CellState::Missing => row.home.as_ref().map(|h| PlannedAction {
                        kind: ActionKind::Create,
                        item_name: row.name.clone(),
                        source_path: h.clone(),
                        target_path: cell.path.clone(),
                        target,
                    }),
                    CellState::Broken => {
                        let dest = match entry_kind(&cell.path) {
                            EntryKind::Symlink(d) => d,
                            _ => cell.path.clone(),
                        };
                        Some(PlannedAction {
                            kind: ActionKind::BrokenLink,
                            item_name: row.name.clone(),
                            source_path: dest,
                            target_path: cell.path.clone(),
                            target,
                        })
                    }
                    _ => None,
                }
            })
        })
        .collect()
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p symsync-core skills:: && cargo clippy -p symsync-core --all-targets -- -D warnings`
Expected: `12 passed`（Windows 10 个）；clippy 零警告。若 `unreadable_column_is_inaccessible_not_fatal` 在 CI 以 root 运行而失败，测试内已跳过。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/skills.rs
git commit -m "feat(core): skill matrix scan, home resolution and proposed actions"
```

---

## Task 6: 发现层 `discovery` 与 harness 表（并行波次 A）

**Files:**
- Create: `crates/core/data/harnesses.json`
- Modify: `crates/core/src/discovery.rs`

**Interfaces:**
- Consumes: Task 3 `models::Harness`
- Produces: `Env { home, vars }` 与 `Env::from_system()`、`resolve_template(&[String], &Env) -> Option<PathBuf>`、`all_harnesses(&Env) -> Vec<Harness>`、`installed(&Env) -> Vec<Harness>`、`project_candidates(&Env, manual: &[PathBuf], &[Harness]) -> Vec<PathBuf>`、`has_project_skill_dir(&Path, &[Harness]) -> bool`

- [ ] **Step 1: harness 表**

`crates/core/data/harnesses.json`。`global_dir` 与 `detect_dir` 是候选模板数组，依次尝试，第一个变量齐全的胜出；`~` 为主目录，`$NAME` 为环境变量。整理自 vercel-labs/skills `src/agents.ts`（MIT）与其 Supported Agents 文档。

```json
{
  "_notice": "Harness 目录表整理自 vercel-labs/skills (MIT, Copyright (c) Vercel, Inc.)，见仓库 NOTICE。",
  "harnesses": [
    { "id": "claude-code", "display_name": "Claude Code", "project_dir": ".claude/skills", "global_dir": ["$CLAUDE_CONFIG_DIR/skills", "~/.claude/skills"], "detect_dir": ["$CLAUDE_CONFIG_DIR", "~/.claude"], "universal": false },
    { "id": "codex", "display_name": "Codex", "project_dir": ".agents/skills", "global_dir": ["$CODEX_HOME/skills", "~/.codex/skills"], "detect_dir": ["$CODEX_HOME", "~/.codex"], "universal": true },
    { "id": "cursor", "display_name": "Cursor", "project_dir": ".agents/skills", "global_dir": ["~/.cursor/skills"], "detect_dir": ["~/.cursor"], "universal": true },
    { "id": "opencode", "display_name": "OpenCode", "project_dir": ".agents/skills", "global_dir": ["$XDG_CONFIG_HOME/opencode/skills", "$APPDATA/opencode/skills", "~/.config/opencode/skills"], "detect_dir": ["$XDG_CONFIG_HOME/opencode", "$APPDATA/opencode", "~/.config/opencode"], "universal": true },
    { "id": "cline", "display_name": "Cline", "project_dir": ".agents/skills", "global_dir": ["~/.agents/skills"], "detect_dir": ["~/.cline"], "universal": true },
    { "id": "gemini-cli", "display_name": "Gemini CLI", "project_dir": ".agents/skills", "global_dir": ["~/.gemini/skills"], "detect_dir": ["~/.gemini"], "universal": true },
    { "id": "github-copilot", "display_name": "GitHub Copilot", "project_dir": ".agents/skills", "global_dir": ["~/.copilot/skills"], "detect_dir": ["~/.copilot"], "universal": true },
    { "id": "amp", "display_name": "Amp", "project_dir": ".agents/skills", "global_dir": ["$XDG_CONFIG_HOME/agents/skills", "$APPDATA/agents/skills", "~/.config/agents/skills"], "detect_dir": ["$XDG_CONFIG_HOME/amp", "$APPDATA/amp", "~/.config/amp"], "universal": true },
    { "id": "kimi-cli", "display_name": "Kimi Code CLI", "project_dir": ".agents/skills", "global_dir": ["$XDG_CONFIG_HOME/agents/skills", "$APPDATA/agents/skills", "~/.config/agents/skills"], "detect_dir": ["~/.kimi"], "universal": true },
    { "id": "replit", "display_name": "Replit", "project_dir": ".agents/skills", "global_dir": ["$XDG_CONFIG_HOME/agents/skills", "$APPDATA/agents/skills", "~/.config/agents/skills"], "detect_dir": ["~/.replit"], "universal": true },
    { "id": "openhands", "display_name": "OpenHands", "project_dir": ".openhands/skills", "global_dir": ["~/.openhands/skills"], "detect_dir": ["~/.openhands"], "universal": false },
    { "id": "roo", "display_name": "Roo Code", "project_dir": ".roo/skills", "global_dir": ["~/.roo/skills"], "detect_dir": ["~/.roo"], "universal": false },
    { "id": "windsurf", "display_name": "Windsurf", "project_dir": ".windsurf/skills", "global_dir": ["~/.codeium/windsurf/skills"], "detect_dir": ["~/.codeium/windsurf"], "universal": false },
    { "id": "goose", "display_name": "Goose", "project_dir": ".goose/skills", "global_dir": ["$XDG_CONFIG_HOME/goose/skills", "$APPDATA/goose/skills", "~/.config/goose/skills"], "detect_dir": ["$XDG_CONFIG_HOME/goose", "$APPDATA/goose", "~/.config/goose"], "universal": false },
    { "id": "continue", "display_name": "Continue", "project_dir": ".continue/skills", "global_dir": ["~/.continue/skills"], "detect_dir": ["~/.continue"], "universal": false },
    { "id": "antigravity", "display_name": "Antigravity", "project_dir": ".agent/skills", "global_dir": ["~/.gemini/antigravity/skills"], "detect_dir": ["~/.gemini/antigravity"], "universal": false },
    { "id": "augment", "display_name": "Augment", "project_dir": ".augment/skills", "global_dir": ["~/.augment/skills"], "detect_dir": ["~/.augment"], "universal": false },
    { "id": "openclaw", "display_name": "OpenClaw", "project_dir": "skills", "global_dir": ["~/.openclaw/skills"], "detect_dir": ["~/.openclaw"], "universal": false },
    { "id": "codebuddy", "display_name": "CodeBuddy", "project_dir": ".codebuddy/skills", "global_dir": ["~/.codebuddy/skills"], "detect_dir": ["~/.codebuddy"], "universal": false },
    { "id": "command-code", "display_name": "Command Code", "project_dir": ".commandcode/skills", "global_dir": ["~/.commandcode/skills"], "detect_dir": ["~/.commandcode"], "universal": false },
    { "id": "cortex", "display_name": "Cortex Code", "project_dir": ".cortex/skills", "global_dir": ["~/.snowflake/cortex/skills"], "detect_dir": ["~/.snowflake/cortex"], "universal": false },
    { "id": "crush", "display_name": "Crush", "project_dir": ".crush/skills", "global_dir": ["$XDG_CONFIG_HOME/crush/skills", "$APPDATA/crush/skills", "~/.config/crush/skills"], "detect_dir": ["$XDG_CONFIG_HOME/crush", "$APPDATA/crush", "~/.config/crush"], "universal": false },
    { "id": "droid", "display_name": "Droid", "project_dir": ".factory/skills", "global_dir": ["~/.factory/skills"], "detect_dir": ["~/.factory"], "universal": false },
    { "id": "junie", "display_name": "Junie", "project_dir": ".junie/skills", "global_dir": ["~/.junie/skills"], "detect_dir": ["~/.junie"], "universal": false },
    { "id": "iflow-cli", "display_name": "iFlow CLI", "project_dir": ".iflow/skills", "global_dir": ["~/.iflow/skills"], "detect_dir": ["~/.iflow"], "universal": false },
    { "id": "kilo", "display_name": "Kilo Code", "project_dir": ".kilocode/skills", "global_dir": ["~/.kilocode/skills"], "detect_dir": ["~/.kilocode"], "universal": false },
    { "id": "kiro-cli", "display_name": "Kiro CLI", "project_dir": ".kiro/skills", "global_dir": ["~/.kiro/skills"], "detect_dir": ["~/.kiro"], "universal": false },
    { "id": "kode", "display_name": "Kode", "project_dir": ".kode/skills", "global_dir": ["~/.kode/skills"], "detect_dir": ["~/.kode"], "universal": false },
    { "id": "mcpjam", "display_name": "MCPJam", "project_dir": ".mcpjam/skills", "global_dir": ["~/.mcpjam/skills"], "detect_dir": ["~/.mcpjam"], "universal": false },
    { "id": "mistral-vibe", "display_name": "Mistral Vibe", "project_dir": ".vibe/skills", "global_dir": ["$VIBE_HOME/skills", "~/.vibe/skills"], "detect_dir": ["$VIBE_HOME", "~/.vibe"], "universal": false },
    { "id": "mux", "display_name": "Mux", "project_dir": ".mux/skills", "global_dir": ["~/.mux/skills"], "detect_dir": ["~/.mux"], "universal": false },
    { "id": "pi", "display_name": "Pi", "project_dir": ".pi/skills", "global_dir": ["~/.pi/agent/skills"], "detect_dir": ["~/.pi"], "universal": false },
    { "id": "qoder", "display_name": "Qoder", "project_dir": ".qoder/skills", "global_dir": ["~/.qoder/skills"], "detect_dir": ["~/.qoder"], "universal": false },
    { "id": "qwen-code", "display_name": "Qwen Code", "project_dir": ".qwen/skills", "global_dir": ["~/.qwen/skills"], "detect_dir": ["~/.qwen"], "universal": false },
    { "id": "trae", "display_name": "Trae", "project_dir": ".trae/skills", "global_dir": ["~/.trae/skills"], "detect_dir": ["~/.trae"], "universal": false },
    { "id": "trae-cn", "display_name": "Trae CN", "project_dir": ".trae/skills", "global_dir": ["~/.trae-cn/skills"], "detect_dir": ["~/.trae-cn"], "universal": false },
    { "id": "zencoder", "display_name": "Zencoder", "project_dir": ".zencoder/skills", "global_dir": ["~/.zencoder/skills"], "detect_dir": ["~/.zencoder"], "universal": false },
    { "id": "neovate", "display_name": "Neovate", "project_dir": ".neovate/skills", "global_dir": ["~/.neovate/skills"], "detect_dir": ["~/.neovate"], "universal": false },
    { "id": "pochi", "display_name": "Pochi", "project_dir": ".pochi/skills", "global_dir": ["~/.pochi/skills"], "detect_dir": ["~/.pochi"], "universal": false },
    { "id": "adal", "display_name": "AdaL", "project_dir": ".adal/skills", "global_dir": ["~/.adal/skills"], "detect_dir": ["~/.adal"], "universal": false }
  ]
}
```

- [ ] **Step 2: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use std::collections::HashMap;

    fn env(home: &Path, vars: &[(&str, &str)]) -> Env {
        Env { home: home.to_path_buf(), vars: vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
    }
    fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }

    #[test]
    fn resolve_template_handles_tilde_vars_and_fallback_order() {
        let e = env(Path::new("/home/u"), &[("CODEX_HOME", "/opt/codex"), ("EMPTY", "  ")]);
        assert_eq!(resolve_template(&s(&["~/.claude/skills"]), &e), Some(PathBuf::from("/home/u/.claude/skills")));
        assert_eq!(resolve_template(&s(&["$CODEX_HOME/skills", "~/.codex/skills"]), &e), Some(PathBuf::from("/opt/codex/skills")));
        assert_eq!(resolve_template(&s(&["$MISSING/x", "$EMPTY/x", "~/.config/x"]), &e), Some(PathBuf::from("/home/u/.config/x")));
        assert_eq!(resolve_template(&s(&["$CODEX_HOME"]), &e), Some(PathBuf::from("/opt/codex")));
        assert_eq!(resolve_template(&s(&["$MISSING"]), &e), None);
    }

    #[test]
    fn table_loads_and_claude_config_dir_overrides() {
        let e = env(Path::new("/home/u"), &[]);
        let all = all_harnesses(&e);
        assert!(all.len() >= 40);
        let claude = all.iter().find(|h| h.id == "claude-code").unwrap();
        assert_eq!(claude.global_dir, Some(PathBuf::from("/home/u/.claude/skills")));
        assert_eq!(claude.project_dir.as_deref(), Some(".claude/skills"));
        assert!(!claude.universal);
        assert!(all.iter().find(|h| h.id == "codex").unwrap().universal);
        let e2 = env(Path::new("/home/u"), &[("CLAUDE_CONFIG_DIR", "/cfg/claude")]);
        let claude2 = all_harnesses(&e2).into_iter().find(|h| h.id == "claude-code").unwrap();
        assert_eq!(claude2.global_dir, Some(PathBuf::from("/cfg/claude/skills")));
    }

    #[test]
    fn installed_filters_by_detect_dir() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".claude"); t.dir(".codex/skills");
        let e = env(&home, &[]);
        let ids: Vec<String> = installed(&e).into_iter().map(|h| h.id).collect();
        assert!(ids.contains(&"claude-code".to_string()));
        assert!(ids.contains(&"codex".to_string()));
        assert!(!ids.contains(&"cursor".to_string()));
    }

    #[test]
    fn project_candidates_merge_claude_json_and_manual_then_filter() {
        let t = TempTree::new();
        let home = t.root();
        let good = t.dir("Project/good"); t.dir("Project/good/.claude/skills");
        let uni = t.dir("Project/uni"); t.dir("Project/uni/.agents/skills");
        let bare = t.dir("Project/bare");
        let manual = t.dir("Elsewhere/m"); t.dir("Elsewhere/m/.codex/skills");
        t.dir(".claude/skills");
        let json = format!(
            "{{\"projects\":{{\"{}\":{{}},\"{}\":{{}},\"{}\":{{}},\"{}\":{{}},\"{}\":{{}}}}}}",
            good.display(), uni.display(), bare.display(), home.display(), home.join("nope").display()
        );
        std::fs::write(home.join(".claude.json"), json).unwrap();
        let e = env(&home, &[]);
        let harnesses = all_harnesses(&e);
        let got = project_candidates(&e, &[manual.clone()], &harnesses);
        let mut want = vec![good, uni, manual];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn broken_claude_json_only_drops_recorded_projects() {
        let t = TempTree::new();
        let home = t.root();
        std::fs::write(home.join(".claude.json"), "{not json").unwrap();
        let manual = t.dir("m"); t.dir("m/.claude/skills");
        let e = env(&home, &[]);
        assert_eq!(project_candidates(&e, &[manual.clone()], &all_harnesses(&e)), vec![manual]);
    }
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cargo test -p symsync-core discovery::`
Expected: 编译错误 `cannot find function 'resolve_template'`

- [ ] **Step 4: 实现**

```rust
//! 内置 harness 表、已安装判定、项目候选
use crate::models::Harness;
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

const HARNESSES_JSON: &str = include_str!("../data/harnesses.json");

#[derive(Debug, Deserialize)]
struct HarnessSpec {
    id: String,
    display_name: String,
    #[serde(default)]
    project_dir: Option<String>,
    #[serde(default)]
    global_dir: Vec<String>,
    #[serde(default)]
    detect_dir: Vec<String>,
    #[serde(default)]
    universal: bool,
}

#[derive(Debug, Deserialize)]
struct HarnessFile {
    harnesses: Vec<HarnessSpec>,
}

/// 模板解析所需的环境：主目录与环境变量（测试时可伪造）
pub struct Env {
    pub home: PathBuf,
    pub vars: HashMap<String, String>,
}

impl Env {
    pub fn from_system() -> Self {
        Env { home: dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")), vars: std::env::vars().collect() }
    }
}

/// 候选依次尝试："~/x" 用主目录，"$VAR/x" 用环境变量（未设置或空白则跳过），其余原样
pub fn resolve_template(candidates: &[String], env: &Env) -> Option<PathBuf> {
    candidates.iter().find_map(|t| resolve_one(t, env))
}

fn resolve_one(template: &str, env: &Env) -> Option<PathBuf> {
    if template == "~" {
        return Some(env.home.clone());
    }
    if let Some(rest) = template.strip_prefix("~/") {
        return Some(env.home.join(rest));
    }
    if let Some(rest) = template.strip_prefix('$') {
        let (var, tail) = match rest.split_once('/') {
            Some((v, r)) => (v, Some(r)),
            None => (rest, None),
        };
        let value = env.vars.get(var).map(|v| v.trim()).filter(|v| !v.is_empty())?;
        let base = PathBuf::from(value);
        return Some(match tail {
            Some(r) => base.join(r),
            None => base,
        });
    }
    Some(PathBuf::from(template))
}

fn specs() -> Vec<HarnessSpec> {
    serde_json::from_str::<HarnessFile>(HARNESSES_JSON).expect("harnesses.json 内置数据必须合法").harnesses
}

fn resolve(spec: &HarnessSpec, env: &Env) -> (Harness, Option<PathBuf>) {
    let harness = Harness {
        id: spec.id.clone(),
        display_name: spec.display_name.clone(),
        project_dir: spec.project_dir.clone(),
        global_dir: resolve_template(&spec.global_dir, env),
        universal: spec.universal,
    };
    (harness, resolve_template(&spec.detect_dir, env))
}

/// 全部 harness，路径已按当前环境解析
pub fn all_harnesses(env: &Env) -> Vec<Harness> {
    specs().iter().map(|s| resolve(s, env).0).collect()
}

/// detect_dir 存在即已安装；没有 detect_dir 时用 global_dir
pub fn installed(env: &Env) -> Vec<Harness> {
    specs()
        .iter()
        .filter_map(|s| {
            let (h, detect) = resolve(s, env);
            let probe = detect.or_else(|| h.global_dir.clone())?;
            probe.exists().then_some(h)
        })
        .collect()
}

/// 项目目录里是否有任一 harness 的项目级 skill 目录
pub fn has_project_skill_dir(project: &Path, harnesses: &[Harness]) -> bool {
    project.join(".agents").join("skills").is_dir()
        || harnesses.iter().filter_map(|h| h.project_dir.as_deref()).any(|d| project.join(d).is_dir())
}

/// Claude Code 记录的项目 ∪ 手动添加；只保留仍存在且含 skill 目录的，排除主目录与根目录
pub fn project_candidates(env: &Env, manual: &[PathBuf], harnesses: &[Harness]) -> Vec<PathBuf> {
    let mut set: BTreeSet<PathBuf> = manual.iter().cloned().collect();
    set.extend(claude_recorded_projects(&env.home));
    set.into_iter()
        .filter(|p| p != &env.home && p.parent().is_some() && p.is_dir() && has_project_skill_dir(p, harnesses))
        .collect()
}

/// ~/.claude.json 的 projects 键。格式非公开约定，任何解析失败都视为空
fn claude_recorded_projects(home: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    value
        .get("projects")
        .and_then(|p| p.as_object())
        .map(|o| o.keys().map(PathBuf::from).collect())
        .unwrap_or_default()
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cargo test -p symsync-core discovery:: && cargo clippy -p symsync-core --all-targets -- -D warnings`
Expected: `5 passed`；clippy 零警告。

- [ ] **Step 6: 提交**

```bash
git add crates/core/data/harnesses.json crates/core/src/discovery.rs
git commit -m "feat(core): built-in harness table, install detection and project candidates"
```

---

## Task 7: 持久化 `store`（并行波次 A）

**Files:**
- Modify: `crates/core/src/store.rs`

**Interfaces:**
- Consumes: Task 3 `models::SyncRule`
- Produces: `Store::new(PathBuf)`、`Store::default_dir() -> PathBuf`、`load_rules() -> io::Result<Vec<SyncRule>>`、`save_rules(&[SyncRule])`、`load_projects() -> io::Result<Vec<PathBuf>>`、`save_projects(&[PathBuf])`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Selection, SyncRule};
    use crate::test_support::TempTree;

    #[test]
    fn missing_files_load_as_empty() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        assert_eq!(s.load_rules().unwrap(), Vec::<SyncRule>::new());
        assert_eq!(s.load_projects().unwrap(), Vec::<PathBuf>::new());
    }

    #[test]
    fn rules_round_trip_and_overwrite_atomically() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        let rule = SyncRule {
            id: uuid::Uuid::new_v4(),
            name: "r".into(),
            source: PathBuf::from("/tmp/src"),
            selection: Selection::Items(vec!["a".into()]),
            targets: vec![PathBuf::from("/tmp/dst")],
            last_run_at: Some(chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap()),
        };
        s.save_rules(std::slice::from_ref(&rule)).unwrap();
        assert_eq!(s.load_rules().unwrap(), vec![rule.clone()]);
        s.save_rules(&[]).unwrap();
        assert_eq!(s.load_rules().unwrap(), vec![]);
        assert!(!dir.join("rules.json.tmp").exists());
    }

    #[test]
    fn projects_round_trip() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        let p = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        s.save_projects(&p).unwrap();
        assert_eq!(s.load_projects().unwrap(), p);
    }

    #[test]
    fn corrupt_file_is_an_error_not_silent_reset() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(dir.join("rules.json"), "{oops").unwrap();
        assert!(Store::new(dir).load_rules().is_err());
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p symsync-core store::`
Expected: 编译错误 `cannot find struct 'Store'`

- [ ] **Step 3: 实现**

```rust
//! JSON 持久化：rules.json、projects.json，整文件原子写（先写 .tmp 再 rename）
use crate::models::SyncRule;
use serde::{de::DeserializeOwned, Serialize};
use std::io;
use std::path::{Path, PathBuf};

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 系统应用数据目录下的 SymSync
    pub fn default_dir() -> PathBuf {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("SymSync")
    }

    pub fn load_rules(&self) -> io::Result<Vec<SyncRule>> {
        load_json(&self.dir.join("rules.json"))
    }

    pub fn save_rules(&self, rules: &[SyncRule]) -> io::Result<()> {
        save_json(&self.dir.join("rules.json"), &rules)
    }

    pub fn load_projects(&self) -> io::Result<Vec<PathBuf>> {
        load_json(&self.dir.join("projects.json"))
    }

    pub fn save_projects(&self, projects: &[PathBuf]) -> io::Result<()> {
        save_json(&self.dir.join("projects.json"), &projects)
    }
}

/// 文件不存在 → 默认值；存在但损坏 → 报错，不静默清空
fn load_json<T: DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e),
    }
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p symsync-core store:: && cargo clippy -p symsync-core --all-targets -- -D warnings`
Expected: `4 passed`；clippy 零警告。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/store.rs
git commit -m "feat(core): atomic JSON store for rules and manual projects"
```

---

## 波次 A 合并（控制器）

四个分支 `task/t4` … `task/t7` 合并回 `feat/rust-pivot`：
```bash
git checkout feat/rust-pivot
for t in t4 t5 t6 t7; do git merge --no-ff task/$t -m "merge: $t into feat/rust-pivot"; done
cargo test -p symsync-core && cargo clippy --workspace --all-targets -- -D warnings
git push -u origin feat/rust-pivot
gh pr create --title "feat(core): Rust core for skill matrix and generic symlink sync" --body "Tasks 1-7 of docs/plans/2026-09-06-skill-sync-plan.md"
```
Expected: 全部测试通过（约 39 个）。

---

## Task 8: Tauri 命令层与前端壳

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src/types.ts`、`src/api.ts`、`src/SkillsTab.tsx`（占位）、`src/CustomSyncTab.tsx`（占位）
- Modify: `src/App.tsx`（整文件替换）、`src/App.css`（整文件替换）

**Interfaces:**
- Consumes: core 全部公开 API
- Produces: 11 个 Tauri 命令；`src/types.ts` 与 serde 输出一一对应；`src/api.ts` 的 `api` 对象；`App.tsx` 通过 `<SkillsTab domain onError />` 与 `<CustomSyncTab onError />` 挂载两个 tab，Task 9/10 只替换各自文件。

- [ ] **Step 1: 命令层**

`src-tauri/src/lib.rs`（整文件替换）：
```rust
//! Tauri 命令层：每个命令一行调 core，错误统一转 String
use serde::Serialize;
use std::path::PathBuf;
use symsync_core::discovery::{self, Env};
use symsync_core::models::*;
use symsync_core::skills::{self, Matrix};
use symsync_core::store::Store;
use symsync_core::sync;

struct AppState {
    store: Store,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DomainInfo {
    domain: Domain,
    label: String,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn list_domains(state: tauri::State<'_, AppState>) -> Result<Vec<DomainInfo>, String> {
    let env = Env::from_system();
    let harnesses = discovery::all_harnesses(&env);
    let manual = state.store.load_projects().map_err(err)?;
    let mut out = vec![DomainInfo { domain: Domain::Global, label: "全局".into() }];
    for p in discovery::project_candidates(&env, &manual, &harnesses) {
        let label = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.display().to_string());
        out.push(DomainInfo { domain: Domain::Project { path: p }, label });
    }
    Ok(out)
}

#[tauri::command]
fn scan_domain(domain: Domain) -> Result<Matrix, String> {
    let env = Env::from_system();
    Ok(skills::scan(&domain, &discovery::installed(&env), &env.home))
}

#[tauri::command]
fn propose(domain: Domain) -> Result<Vec<PlannedAction>, String> {
    Ok(skills::propose(&scan_domain(domain)?))
}

#[tauri::command]
fn apply(actions: Vec<PlannedAction>, clean_broken: bool, domain: Domain) -> Result<SyncReport, String> {
    Ok(sync::execute(&actions, clean_broken, skills::link_style(&domain)))
}

#[tauri::command]
fn add_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut list = state.store.load_projects().map_err(err)?;
    if !list.contains(&path) {
        list.push(path);
    }
    state.store.save_projects(&list).map_err(err)
}

#[tauri::command]
fn remove_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut list = state.store.load_projects().map_err(err)?;
    list.retain(|p| p != &path);
    state.store.save_projects(&list).map_err(err)
}

#[tauri::command]
fn list_rules(state: tauri::State<'_, AppState>) -> Result<Vec<SyncRule>, String> {
    state.store.load_rules().map_err(err)
}

#[tauri::command]
fn save_rules(rules: Vec<SyncRule>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.store.save_rules(&rules).map_err(err)
}

#[tauri::command]
fn plan_rule(rule: SyncRule) -> Result<Vec<PlannedAction>, String> {
    sync::plan(&rule).map_err(err)
}

#[tauri::command]
fn apply_rule(actions: Vec<PlannedAction>, clean_broken: bool) -> Result<SyncReport, String> {
    Ok(sync::execute(&actions, clean_broken, LinkStyle::Absolute))
}

/// 自定义同步的子项勾选列表：源目录直接子项，跳过点开头，排序
#[tauri::command]
fn list_source_items(source: PathBuf) -> Result<Vec<String>, String> {
    let rd = std::fs::read_dir(&source).map_err(err)?;
    let mut items: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    items.sort();
    Ok(items)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { store: Store::new(Store::default_dir()) })
        .invoke_handler(tauri::generate_handler![
            list_domains,
            scan_domain,
            propose,
            apply,
            add_project,
            remove_project,
            list_rules,
            save_rules,
            plan_rule,
            apply_rule,
            list_source_items
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: 前端类型与 API**

`src/types.ts`：
```ts
// 与 crates/core/src/models.rs、skills.rs 的 serde 输出一一对应（camelCase）
export type Domain = { type: "global" } | { type: "project"; path: string };
export interface DomainInfo { domain: Domain; label: string }

export type CellState = "home" | "linked" | "missing" | "broken" | "foreign" | "duplicateHome" | "inaccessible";
export interface Column { id: string; label: string; path: string; universal: boolean }
export interface Cell { columnId: string; path: string; state: CellState }
export interface SkillRow { name: string; home: string | null; externalHome: boolean; cells: Cell[]; ambiguous: boolean }
export interface Summary { skills: number; missing: number; broken: number; ambiguous: number }
export interface Matrix { domain: Domain; columns: Column[]; rows: SkillRow[]; summary: Summary }

export type ActionKind = "create" | "alreadyLinked" | "conflict" | "sourceMissing" | "brokenLink";
export interface PlannedAction { kind: ActionKind; itemName: string; sourcePath: string; targetPath: string; target: string }
export type Outcome =
  | { status: "created" }
  | { status: "skipped" }
  | { status: "removed" }
  | { status: "failed"; reason: string };
export interface ReportEntry { action: PlannedAction; outcome: Outcome }
export interface SyncReport { entries: ReportEntry[] }

export type Selection = "all" | { items: string[] };
export interface SyncRule { id: string; name: string; source: string; selection: Selection; targets: string[]; lastRunAt: string | null }

export const actionId = (a: PlannedAction): string => `${a.kind}|${a.targetPath}`;
export const domainKey = (d: Domain): string => (d.type === "global" ? "global" : `project:${d.path}`);
```

`src/api.ts`：
```ts
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Domain, DomainInfo, Matrix, PlannedAction, SyncReport, SyncRule } from "./types";

export const api = {
  listDomains: () => invoke<DomainInfo[]>("list_domains"),
  scanDomain: (domain: Domain) => invoke<Matrix>("scan_domain", { domain }),
  propose: (domain: Domain) => invoke<PlannedAction[]>("propose", { domain }),
  apply: (actions: PlannedAction[], cleanBroken: boolean, domain: Domain) =>
    invoke<SyncReport>("apply", { actions, cleanBroken, domain }),
  addProject: (path: string) => invoke<void>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  listRules: () => invoke<SyncRule[]>("list_rules"),
  saveRules: (rules: SyncRule[]) => invoke<void>("save_rules", { rules }),
  planRule: (rule: SyncRule) => invoke<PlannedAction[]>("plan_rule", { rule }),
  applyRule: (actions: PlannedAction[], cleanBroken: boolean) =>
    invoke<SyncReport>("apply_rule", { actions, cleanBroken }),
  listSourceItems: (source: string) => invoke<string[]>("list_source_items", { source }),
  /// 系统目录选择框；取消返回 null
  pickDirectory: async (title: string): Promise<string | null> => {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
};
```

- [ ] **Step 3: App 壳与占位 tab**

`src/App.tsx`（整文件替换）：
```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import { domainKey, type Domain, type DomainInfo } from "./types";
import SkillsTab from "./SkillsTab";
import CustomSyncTab from "./CustomSyncTab";
import "./App.css";

export default function App() {
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [selected, setSelected] = useState<Domain>({ type: "global" });
  const [tab, setTab] = useState<"skills" | "custom">("skills");
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setDomains(await api.listDomains());
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const addProject = async () => {
    const path = await api.pickDirectory("选择项目目录");
    if (!path) return;
    try {
      await api.addProject(path);
      await reload();
      setSelected({ type: "project", path });
    } catch (e) {
      setError(String(e));
    }
  };

  const removeProject = async (path: string) => {
    try {
      await api.removeProject(path);
      await reload();
      if (selected.type === "project" && selected.path === path) setSelected({ type: "global" });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>SymSync</h1>
        <ul>
          {domains.map((d) => (
            <li
              key={domainKey(d.domain)}
              className={domainKey(d.domain) === domainKey(selected) ? "active" : ""}
              title={d.domain.type === "project" ? d.domain.path : "全局 skill 目录"}
              onClick={() => setSelected(d.domain)}
            >
              <span>{d.label}</span>
              {d.domain.type === "project" && (
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeProject((d.domain as { path: string }).path);
                  }}
                >
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>
        <button onClick={() => void addProject()}>添加项目</button>
      </aside>
      <main className="content">
        <nav className="tabs">
          <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
            Skills
          </button>
          <button className={tab === "custom" ? "active" : ""} onClick={() => setTab("custom")}>
            自定义同步
          </button>
        </nav>
        {error && (
          <div className="error">
            {error}
            <button className="link" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {tab === "skills" ? (
          <SkillsTab key={domainKey(selected)} domain={selected} onError={setError} />
        ) : (
          <CustomSyncTab onError={setError} />
        )}
      </main>
    </div>
  );
}
```
"移除"只从手动列表里删；Claude Code 记录里的项目会在刷新后再次出现，这是已知行为，写进 `docs/manual-checks.md`。

`src/SkillsTab.tsx`（占位，Task 9 替换）：
```tsx
import type { Domain } from "./types";

export default function SkillsTab(_props: { domain: Domain; onError: (message: string) => void }) {
  return <p>Skills 矩阵（Task 9 实现）</p>;
}
```

`src/CustomSyncTab.tsx`（占位，Task 10 替换）：
```tsx
export default function CustomSyncTab(_props: { onError: (message: string) => void }) {
  return <p>自定义同步（Task 10 实现）</p>;
}
```

`src/App.css`（整文件替换，Task 9/10 不再改样式）：
```css
:root { font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif; font-size: 14px; color: #222; }
body { margin: 0; }
.app { display: flex; height: 100vh; }
.sidebar { width: 220px; border-right: 1px solid #ddd; padding: 12px; display: flex; flex-direction: column; box-sizing: border-box; }
.sidebar h1 { font-size: 16px; margin: 0 0 12px; }
.sidebar ul, .rules ul { list-style: none; margin: 0; padding: 0; flex: 1; overflow: auto; }
.sidebar li, .rules li { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.sidebar li.active, .rules li.active { background: #e8f0fe; }
.content { flex: 1; padding: 12px 16px; overflow: auto; box-sizing: border-box; }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.tabs button.active { font-weight: 600; border-bottom: 2px solid #1a73e8; }
button { font: inherit; padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fafafa; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.link { border: none; background: none; color: #1a73e8; padding: 0 4px; }
.error { background: #fdecea; color: #b3261e; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.confirm { background: #fff4e5; padding: 4px 8px; border-radius: 6px; }
table.matrix { border-collapse: collapse; width: 100%; }
table.matrix th, table.matrix td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; white-space: nowrap; }
table.matrix td.path { max-width: 320px; overflow: hidden; text-overflow: ellipsis; color: #666; }
table.matrix td.cell { text-align: center; font-size: 16px; }
td.cell.home { color: #1a73e8; }
td.cell.linked { color: #188038; }
td.cell.missing { color: #999; }
td.cell.broken { color: #b3261e; }
td.cell.foreign { color: #e37400; }
td.cell.duplicateHome { color: #e37400; }
td.cell.inaccessible { color: #999; }
tr.ambiguous { opacity: 0.6; }
.tag { margin-left: 6px; font-size: 11px; background: #fff4e5; color: #e37400; padding: 1px 6px; border-radius: 10px; }
.report { background: #f6f8fa; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; max-height: 160px; overflow: auto; }
.custom { display: flex; gap: 16px; height: 100%; }
.rules { width: 200px; border-right: 1px solid #eee; padding-right: 12px; display: flex; flex-direction: column; }
.editor { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.editor fieldset { border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; }
.editor .row { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
.editor input[type="text"] { flex: 1; font: inherit; padding: 4px 8px; border: 1px solid #ccc; border-radius: 6px; }
table.preview { border-collapse: collapse; width: 100%; }
table.preview th, table.preview td { border-bottom: 1px solid #eee; padding: 4px 8px; text-align: left; }
```

- [ ] **Step 4: 验证**

Run: `npm run build && cargo check --workspace && cargo clippy -p symsync --all-targets -- -D warnings`
Expected: 全部通过。然后 `make dev`，窗口左栏出现"全局"和本机的项目，右栏两个 tab 显示占位文字；"添加项目"能打开系统选择框。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lib.rs src
git commit -m "feat(app): Tauri commands, typed API and app shell with domain sidebar"
```

---

## Task 9: Skills 矩阵界面（并行波次 B）

**Files:**
- Modify: `src/SkillsTab.tsx`（整文件替换）

**Interfaces:**
- Consumes: `api.scanDomain / propose / apply`、`types.ts`
- Produces: `SkillsTab({ domain, onError })`

- [ ] **Step 1: 实现**

```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import { actionId, type CellState, type Domain, type Matrix, type Outcome, type PlannedAction, type SyncReport } from "./types";

const SYMBOL: Record<CellState, string> = {
  home: "●", linked: "✓", missing: "○", broken: "✗", foreign: "→", duplicateHome: "⚠", inaccessible: "–",
};
const LABEL: Record<CellState, string> = {
  home: "本体", linked: "已链接", missing: "缺失", broken: "坏链", foreign: "指向他处", duplicateHome: "多本体", inaccessible: "不可访问",
};

function outcomeText(o: Outcome): string {
  switch (o.status) {
    case "created": return "已创建";
    case "removed": return "已删除";
    case "skipped": return "跳过";
    case "failed": return `失败：${o.reason}`;
  }
}

export default function SkillsTab({ domain, onError }: { domain: Domain; onError: (message: string) => void }) {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [actions, setActions] = useState<PlannedAction[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);

  // 扫描是纯读操作；每次动作后重新扫描而不是在前端修改状态
  const refresh = async () => {
    setBusy(true);
    try {
      setMatrix(await api.scanDomain(domain));
      setActions(await api.propose(domain));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    // domain 变化时 App 通过 key 重建本组件，这里只需首次加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const creates = actions.filter((a) => a.kind === "create");
  const broken = actions.filter((a) => a.kind === "brokenLink");

  const run = async (subset: PlannedAction[], cleanBroken: boolean) => {
    setBusy(true);
    setConfirmClean(false);
    try {
      setReport(await api.apply(subset, cleanBroken, domain));
      setMatrix(await api.scanDomain(domain));
      setActions(await api.propose(domain));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!matrix) return <p>扫描中…</p>;
  const { summary } = matrix;

  return (
    <section>
      <div className="toolbar">
        <span>
          {summary.skills} 个 skill，{summary.missing} 处缺失，{summary.broken} 处坏链，{summary.ambiguous} 行多本体
        </span>
        <button onClick={() => void refresh()} disabled={busy}>刷新</button>
        <button onClick={() => void run(creates, false)} disabled={busy || creates.length === 0}>
          同步缺失链接（{creates.length}）
        </button>
        {broken.length > 0 && !confirmClean && (
          <button onClick={() => setConfirmClean(true)} disabled={busy}>清理坏链（{broken.length}）</button>
        )}
        {confirmClean && (
          <span className="confirm">
            只删除链接本身，不删除任何真实文件。
            <button onClick={() => void run(broken, true)} disabled={busy}>确认删除</button>
            <button onClick={() => setConfirmClean(false)}>取消</button>
          </span>
        )}
      </div>
      {report && (
        <ul className="report">
          {report.entries.map((e) => (
            <li key={actionId(e.action)}>{outcomeText(e.outcome)} · {e.action.targetPath}</li>
          ))}
        </ul>
      )}
      {matrix.rows.length === 0 ? (
        <p>这个域里没有发现 skill。</p>
      ) : (
        <table className="matrix">
          <thead>
            <tr>
              <th>skill</th>
              <th>本体</th>
              {matrix.columns.map((c) => (
                <th key={c.id} title={c.path}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r.name} className={r.ambiguous ? "ambiguous" : ""}>
                <td>
                  {r.name}
                  {r.ambiguous && <span className="tag">多本体</span>}
                  {r.externalHome && <span className="tag">外部本体</span>}
                </td>
                <td className="path" title={r.home ?? ""}>{r.home ?? "—"}</td>
                {r.cells.map((c) => (
                  <td key={c.columnId} className={`cell ${c.state}`} title={`${LABEL[c.state]}：${c.path}`}>
                    {SYMBOL[c.state]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 验证**

Run: `npm run build`
Expected: 通过。`make dev` 里选"全局"：矩阵列出本机 skill，摘要计数与 `ls -l ~/.claude/skills ~/.codex/skills ~/.agents/skills` 对得上；缺失格子的"同步缺失链接"按钮计数正确；有坏链时"清理坏链"需二次确认。

- [ ] **Step 3: 提交**

```bash
git add src/SkillsTab.tsx
git commit -m "feat(app): skill matrix tab with sync and confirmed cleanup"
```

---

## Task 10: 自定义同步界面（并行波次 B）

**Files:**
- Modify: `src/CustomSyncTab.tsx`（整文件替换）

**Interfaces:**
- Consumes: `api.listRules / saveRules / planRule / applyRule / listSourceItems / pickDirectory`、`types.ts`
- Produces: `CustomSyncTab({ onError })`

- [ ] **Step 1: 实现**

```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import { actionId, type ActionKind, type Outcome, type PlannedAction, type SyncRule } from "./types";

const newRule = (): SyncRule => ({
  id: crypto.randomUUID(), name: "新同步", source: "", selection: "all", targets: [], lastRunAt: null,
});

export default function CustomSyncTab({ onError }: { onError: (message: string) => void }) {
  const [rules, setRules] = useState<SyncRule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    api.listRules().then(setRules).catch((e) => onError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 整个数组一次保存
  const persist = async (next: SyncRule[]) => {
    setRules(next);
    try {
      await api.saveRules(next);
    } catch (e) {
      onError(String(e));
    }
  };
  const selected = rules.find((r) => r.id === selectedId) ?? null;
  const update = (rule: SyncRule) => void persist(rules.map((r) => (r.id === rule.id ? rule : r)));
  const add = () => {
    const r = newRule();
    void persist([...rules, r]);
    setSelectedId(r.id);
  };
  const remove = (id: string) => {
    void persist(rules.filter((r) => r.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  return (
    <section className="custom">
      <aside className="rules">
        <ul>
          {rules.map((r) => (
            <li key={r.id} className={r.id === selectedId ? "active" : ""} onClick={() => setSelectedId(r.id)}>
              <span>{r.name}</span>
              <button className="link" onClick={(e) => { e.stopPropagation(); remove(r.id); }}>删除</button>
            </li>
          ))}
        </ul>
        <button onClick={add}>新建</button>
      </aside>
      {selected ? (
        <RuleEditor key={selected.id} rule={selected} onChange={update} onError={onError} />
      ) : (
        <p>选择或新建一条同步记录</p>
      )}
    </section>
  );
}

type Row = { action: PlannedAction; outcome: Outcome | null };

const KIND_LABEL: Record<ActionKind, string> = {
  create: "将创建", alreadyLinked: "已链接", conflict: "冲突", sourceMissing: "源缺失", brokenLink: "坏链",
};
function rowText(r: Row): string {
  if (!r.outcome) return KIND_LABEL[r.action.kind];
  switch (r.outcome.status) {
    case "created": return "已创建";
    case "removed": return "已删除";
    case "skipped": return KIND_LABEL[r.action.kind];
    case "failed": return `失败：${r.outcome.reason}`;
  }
}

function RuleEditor({ rule, onChange, onError }: { rule: SyncRule; onChange: (r: SyncRule) => void; onError: (m: string) => void }) {
  const [items, setItems] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmClean, setConfirmClean] = useState(false);
  const [busy, setBusy] = useState(false);

  const configKey = `${rule.source}|${rule.targets.join("|")}|${JSON.stringify(rule.selection)}`;
  // 配置变了，旧预览作废；lastRunAt 与名称不影响
  useEffect(() => {
    setRows([]);
  }, [configKey]);

  useEffect(() => {
    if (!rule.source || rule.selection === "all") {
      setItems([]);
      return;
    }
    api.listSourceItems(rule.source).then(setItems).catch(() => setItems([]));
  }, [rule.source, rule.selection === "all"]);

  const selectedItems = rule.selection === "all" ? new Set<string>() : new Set(rule.selection.items);
  const toggleItem = (name: string, on: boolean) => {
    const next = new Set(selectedItems);
    if (on) next.add(name); else next.delete(name);
    onChange({ ...rule, selection: { items: [...next].sort() } });
  };

  const pickSource = async () => {
    const p = await api.pickDirectory("选择源目录");
    if (p) onChange({ ...rule, source: p });
  };
  const pickTarget = async (index: number) => {
    const p = await api.pickDirectory("选择目标目录");
    if (p) onChange({ ...rule, targets: rule.targets.map((t, i) => (i === index ? p : t)) });
  };

  const pendingCreates = rows.filter((r) => r.action.kind === "create" && r.outcome === null).map((r) => r.action);
  const pendingBroken = rows.filter((r) => r.action.kind === "brokenLink" && r.outcome?.status !== "removed").map((r) => r.action);
  const configured = rule.source !== "" && rule.targets.length > 0 && rule.targets.every((t) => t !== "");

  const preview = async () => {
    setBusy(true);
    try {
      setRows((await api.planRule(rule)).map((action) => ({ action, outcome: null })));
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 只把选中的动作交给 Executor，结果按 action id 合并回表格
  const run = async (actions: PlannedAction[], cleanBroken: boolean) => {
    setBusy(true);
    setConfirmClean(false);
    try {
      const report = await api.applyRule(actions, cleanBroken);
      const outcomes = new Map(report.entries.map((e) => [actionId(e.action), e.outcome]));
      setRows((prev) => prev.map((r) => ({ ...r, outcome: outcomes.get(actionId(r.action)) ?? r.outcome })));
      onChange({ ...rule, lastRunAt: new Date().toISOString() });
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <fieldset>
        <legend>名称</legend>
        <input type="text" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
      </fieldset>
      <fieldset>
        <legend>源目录</legend>
        <div className="row">
          <input type="text" value={rule.source} placeholder="输入路径或点选择…" onChange={(e) => onChange({ ...rule, source: e.target.value })} />
          <button onClick={() => void pickSource()}>选择…</button>
        </div>
        <label className="row">
          <input type="checkbox" checked={rule.selection === "all"} onChange={(e) => onChange({ ...rule, selection: e.target.checked ? "all" : { items: [] } })} />
          同步整个目录
        </label>
        {rule.selection !== "all" && (
          <div>
            {items.length === 0 && <p>源目录为空或未设置</p>}
            {items.map((name) => (
              <label key={name} className="row">
                <input type="checkbox" checked={selectedItems.has(name)} onChange={(e) => toggleItem(name, e.target.checked)} />
                {name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>目标目录</legend>
        {rule.targets.map((t, i) => (
          <div className="row" key={i}>
            <input type="text" value={t} placeholder="输入路径或点选择…" onChange={(e) => onChange({ ...rule, targets: rule.targets.map((x, j) => (j === i ? e.target.value : x)) })} />
            <button onClick={() => void pickTarget(i)}>选择…</button>
            <button onClick={() => onChange({ ...rule, targets: rule.targets.filter((_, j) => j !== i) })}>移除</button>
          </div>
        ))}
        <button onClick={() => onChange({ ...rule, targets: [...rule.targets, ""] })}>添加目标</button>
      </fieldset>
      <fieldset>
        <legend>预览与执行</legend>
        <div className="toolbar">
          <button onClick={() => void preview()} disabled={busy || !configured}>预览</button>
          <button onClick={() => void run(pendingCreates, false)} disabled={busy || pendingCreates.length === 0}>执行（{pendingCreates.length}）</button>
          {pendingBroken.length > 0 && !confirmClean && (
            <button onClick={() => setConfirmClean(true)} disabled={busy}>清理坏链（{pendingBroken.length}）</button>
          )}
          {confirmClean && (
            <span className="confirm">
              只删除指向本源目录且源已不存在的软链接，不会删除任何真实文件。
              <button onClick={() => void run(pendingBroken, true)} disabled={busy}>确认删除</button>
              <button onClick={() => setConfirmClean(false)}>取消</button>
            </span>
          )}
          {rule.lastRunAt && <span>上次执行：{new Date(rule.lastRunAt).toLocaleString()}</span>}
        </div>
        {rows.length > 0 && (
          <table className="preview">
            <thead><tr><th>状态</th><th>子项</th><th>目标目录</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={actionId(r.action)}>
                  <td>{rowText(r)}</td>
                  <td>{r.action.itemName}</td>
                  <td>{r.action.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </fieldset>
    </div>
  );
}
```

- [ ] **Step 2: 验证**

Run: `npm run build`
Expected: 通过。`make dev` 里"自定义同步" tab：新建记录 → 选源目录 → 关闭"同步整个目录"出现子项勾选 → 添加目标 → 预览 → 执行 → 再次预览全部"已链接"；退出重开记录仍在。

- [ ] **Step 3: 提交**

```bash
git add src/CustomSyncTab.tsx
git commit -m "feat(app): custom sync tab ported from the SwiftUI version"
```

---

## 波次 B 合并（控制器）

```bash
git checkout feat/rust-pivot
for t in t9 t10; do git merge --no-ff task/$t -m "merge: $t into feat/rust-pivot"; done
npm run build && cargo clippy --workspace --all-targets -- -D warnings
```

---

## Task 11: 手动验证、移除 Swift、文档收尾

**Files:**
- Modify: `docs/manual-checks.md`（整文件替换）、`.gitignore`
- Delete: `SymSyncCore/`、`SymSync/`、`project.yml`
- Modify: `docs/plans/2026-09-06-skill-sync-plan.md`（末尾追加"实施偏差"）

- [ ] **Step 1: 手动清单**

`docs/manual-checks.md`（整文件替换）：
```markdown
# 手动验证清单（每次改 App 层后跑）

启动：`make dev`

## Skills tab
- [ ] 左栏"全局"置顶；项目列表只包含仍存在且含 skill 目录的项目；"添加项目"打开系统选择框
- [ ] 全局矩阵的列与本机已安装 harness 一致（`ls -d ~/.claude ~/.codex ~/.cursor …`），通用仓库列在最前，Cline 合并进通用仓库列
- [ ] 每行状态与 `ls -l ~/.agents/skills ~/.claude/skills ~/.codex/skills` 对得上：本体 ●、链接 ✓、缺失 ○、坏链 ✗、指向他处 →、多本体 ⚠
- [ ] `hatch-pet`、`codex-primary-runtime` 这类只在 codex 里的真实目录：codex 列 ●，其余列 ○
- [ ] `ego-browser` 这类通用仓库本身是软链的：标"外部本体"，各列 ✓
- [ ] "同步缺失链接"按钮计数 = 摘要里的缺失数；执行后缺失格子变 ✓，`ls -l` 能看到绝对路径软链
- [ ] 重启 Claude Code / Codex 后，`/skills` 能看到新链上的 skill
- [ ] 手动做一个坏链（`ln -s ~/.agents/skills/nope ~/.claude/skills/nope`）→ 刷新出现 ✗ → "清理坏链"需二次确认 → 删除后消失；期间把它换成真实目录再确认删除，应显示"不再是软链接，已跳过"
- [ ] 多本体行整行淡显、无动作
- [ ] 项目域：补链后 `readlink <项目>/.claude/skills/<x>` 是 `../../.agents/skills/<x>`，`git status` 能记录该软链
- [ ] "移除"项目只影响手动添加的项目；Claude Code 记录的项目刷新后仍在（已知行为）

## 自定义同步 tab
- [ ] 新建、选源、切换整目录/指定子项、添加/移除目标、预览、执行、二次预览全"已链接"
- [ ] 同名真实文件显示"冲突"，执行后文件原样
- [ ] 删除源子项后预览出现"坏链"，清理需二次确认
- [ ] 退出重开记录仍在（`~/Library/Application Support/SymSync/rules.json`）

## 平台
- [ ] macOS：以上全部
- [ ] Windows：junction 建链、`readlink` 判定、删除（待有 Windows 机器时验证）
```

- [ ] **Step 2: 跑清单**

Run: `make test && make dev`
Expected: `make test` 全绿；清单 macOS 部分逐项通过。任一项失败按 systematic-debugging 处理：core 层先写复现测试，App 层先记录复现步骤，再修。

- [ ] **Step 3: 移除 Swift 版本**

```bash
git rm -r -q SymSyncCore SymSync project.yml
```
`.gitignore` 删除 `SymSync.xcodeproj/`、`xcuserdata/`、`*.xcuserstate`、`DerivedData/`、`.build/`、`.swiftpm/`、`Package.resolved` 这些 Swift 条目。`Makefile` 已在 Task 1 替换，无 Swift 目标残留。

- [ ] **Step 4: 记录偏差并提交、开 PR**

在本计划末尾追加 `## 实施偏差（日期）` 一节，逐条记录实现与计划不一致处（没有则写"无"）。

```bash
git add -A
git commit -m "chore: remove Swift version, update manual checks after Rust pivot"
git push -u origin feat/rust-pivot
gh pr create --title "feat(app): Tauri app for skill matrix and custom sync" --body "Tasks 8-11 of docs/plans/2026-09-06-skill-sync-plan.md"
```

---

## 后续（不在本计划内，各自写新的 intent）

- 分发：Developer ID 签名 + 公证的 DMG、Windows/Linux 安装包、自动更新。
- Windows 真机验证 junction 行为，补 `harnesses.json` 的 Windows 专属路径。
- Codex / Cursor 的项目记录作为项目候选来源。
- 全局 ↔ 项目复制与分叉比对（已在 spec 范围外）。

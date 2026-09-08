# SymSync

跨平台桌面应用：发现各 AI coding harness 的 skill 目录，展示 skill × harness 矩阵，补缺失软链、清坏链。Rust core（`crates/core`，crate 名 `symsync-core`）+ Tauri 2 命令层（`src-tauri`）+ React/TypeScript 前端（`src`）。

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

- `crates/core/src/models.rs`：共享类型（PlannedAction、Outcome、Harness、LinkStyle）
- `fs.rs`：`entry_kind`（lstat）、`real_path`、`normalize`、`create_link`
- `sync.rs`：`execute` 执行动作
- `skills.rs`：矩阵 `scan`（只读事实）/ `propose_links` / `propose_unlinks`（按选中格生成动作），本体判定
- `discovery.rs` + `data/harnesses.json`：harness 表、已安装判定、项目候选
- `store.rs`：`projects.json` / `settings.json`
- `src-tauri/src/lib.rs`：命令，每个一行调 core
- `src/`：`App.tsx` 壳、`SkillsTab.tsx`、`DomainView.tsx`、`ImportDialog.tsx`、`SettingsPanel.tsx`、`api.ts`、`types.ts`

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

# Sophia

跨平台桌面应用：发现各 AI coding harness 的 skill 目录，展示 skill × harness 矩阵，补缺失软链、清坏链。Rust core（`crates/core`，crate 名 `symsync-core`）+ Tauri 2 命令层（`src-tauri`）+ React/TypeScript 前端（`src`）。

## Commands

- `make test-core`：core 单元测试。健康输出末尾 `test result: ok. N passed; 0 failed`
- `make lint`：clippy，零警告
- `make build-web`：前端类型检查与打包
- `make test-gateway`：模型网关（`crates/gateway`）的测试；`make test-web`：前端纯逻辑的 node:test
- `make test`：以上全部，提交前必跑
- `make dev`：启动开发窗口；`make build`：产出 debug App（`target/debug/bundle/`）
- `make format`：rustfmt + prettier

## Conventions

- Rust 2021，`clippy -D warnings`；core 不依赖 tauri
- 测试用 `tempfile` 在临时目录搭真实文件树（`test_support::TempTree`），不 mock 文件系统
- 注释与 UI 文案中文，标识符英文；Conventional Commits
- serde 统一 `rename_all = "camelCase"`，前端 `src/types.ts` 与之对应

## Architecture

- `crates/core/src/models.rs`：共享 skill 类型（PlannedAction、Outcome、Harness、LinkStyle）
- `crates/core/src/mcp.rs`：MCP 配置位置发现、扫描、补缺计划与安全执行（独立于 skill 软链）
- `fs.rs`：`entry_kind`（lstat）、`real_path`、`normalize`、`create_link`
- `sync.rs`：`execute` 执行动作
- `skills.rs`：矩阵 `scan`（只读事实）/ `propose_links` / `propose_unlinks`（按选中格生成动作），本体判定
- `subscriptions.rs`：来源订阅（每个位置订阅了哪些来源，存 `settings.json`）、老数据认领、来源管理页的列表 / 候选 / 移除；`scan` 按它成行
- `discovery.rs` + `data/harnesses.json`：harness 表、已安装判定、项目候选
- `store.rs`：`projects.json` / `settings.json`
- `crates/core/src/atomicfile.rs`：写用户配置文件的唯一通道（快照、备份、原子替换、写前写后指纹校验、拒绝软链父目录）。MCP 同步和模型网关共用，不要另写一份
- `crates/core/src/codex_models/`：Codex 第三方模型的纯逻辑。`config.rs` 对 `~/.codex/config.toml` 做文本级手术（只增删两个根键，逐字节可还原）；`catalog.rs` 合并模型目录与路由清单；`settings.rs` 持久化设置
- `crates/gateway`（`symsync-gateway`）：模型网关，不依赖 tauri。`router`（本机回环路由）、`translate`（Responses ↔ Chat Completions）、`app`（启用/恢复/接管编排）、`runtime`（真实依赖与 `symsync gateway …` 命令行）、`sysproxy` / `service` / `keychain` / `provider` / `takeover`。异步和网络只允许出现在这个 crate 和 `src-tauri`，core 保持无异步无网络
- `src-tauri/src/lib.rs`：命令，每个一行调 core；`gateway.rs`：模型页的异步命令。`main.rs` 只在第一个参数恰为 `gateway` 时走无界面模式（launchd 拉起的就是它），不要用通用参数解析库：macOS 双击启动会带 `-psn_…` 参数
- `src/`：`App.tsx` 壳、`SkillsTab.tsx`、`McpTab.tsx`、`DomainView.tsx`、`ImportDialog.tsx`、`SettingsPanel.tsx`、`api.ts`、`types.ts`

## Verifying your work

- 改 core：`make test-core && make lint` 全绿
- 改 src-tauri 或 src：`make build-web && cargo check --workspace`，并在 `make dev` 里手动走一遍受影响的流程
- 报告完成前贴出命令输出末尾。测试失败改代码，不改测试

## Things Claude gets wrong

- `Path::exists()` / `is_dir()` 跟随软链，坏链返回 false。判断条目类型用 `fs::entry_kind`（`symlink_metadata`）。唯一例外：判断"目标目录是否存在"要跟随软链，用 `is_dir()`
- 比较"是否指向同一处"用 `fs::real_path`（canonicalize）；macOS 上 `/var` 会变成 `/private/var`，两侧必须同源
- Unix 删软链用 `remove_file`，Windows 删 junction 用 `remove_dir`；删前必须重校验仍是软链
- `Path::starts_with` 按路径分量比较，不要用字符串 `starts_with`
- 改 `~/.codex/config.toml` 不要用 `toml_edit` 重新序列化：实测它会把整个文件的 CRLF 改成 LF、丢 BOM、给末行补换行。模型网关用文本级手术，`toml_edit` 只做校验和读值
- 异步命令里会写 `~/.codex/config.toml` 的，先拿 `AppState.config_lock`（`tokio::sync::Mutex`，锁要跨 `.await`）；同步命令用 `blocking_lock()`，它不能在 tokio 运行时线程上调用
- 测试里的临时目录先 `canonicalize`：macOS 上 `/var` 是软链，`atomicfile::safe_parent` 会拒绝父路径里的软链
- 并行任务只碰自己 Files 列表里的文件；`lib.rs`、`Cargo.toml`、`App.tsx` 由前置任务预留
- 给自己写了 `display` 的元素上，HTML 的 `hidden` 属性是个装饰：它靠 UA 样式表的 `display: none` 起作用，作者样式的 `display: flex` 压得过它。要藏就条件不渲染，或者 CSS 里显式 `[hidden] { display: none !important }`
- `display: inline-flex` 的按钮里插一个 `<span>` 包专名（`重启 <Plain>Codex</Plain>`），文字会被拆成三个匿名 flex item，**item 之间的空白被吃掉**——渲染成 `删WeiboAP的`。空格要写成 `&nbsp;`，或者别让按钮当 flex 容器

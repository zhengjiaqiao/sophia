# SymSync

macOS SwiftUI 软链接同步工具。核心逻辑在 `SymSyncCore/`（Swift Package，纯 Foundation），App 壳在 `SymSync/`（xcodegen 从 `project.yml` 生成 `SymSync.xcodeproj`，工程文件不入库）。

## Commands

- `make test-core`：Core 单元测试。健康输出末尾为 `Test run with N tests passed after X seconds.`
- `make build`：编译 App（ad-hoc 签名）。健康输出末尾为 `** BUILD SUCCEEDED **`
- `make test`：以上两者，提交前必跑
- `make project`：改了 `project.yml` 后重新生成工程
- `make format`：`swift format` 格式化
- 全新安装 Xcode 后第一次 `make build` 前先跑一次 `xcodebuild -runFirstLaunch`（无需 sudo）

## Conventions

- Swift 语言模式 6.0，公开类型标 `Sendable`；Core 不 import AppKit/SwiftUI
- 测试用 Swift Testing（`@Test` / `#expect`），文件系统测试用 `TempTree` 夹具在临时目录搭真实文件
- UI 文案与文档中文，标识符英文；提交信息 Conventional Commits
- 路径比较一律先过 `normalizedPath(_:)`

## Architecture

- `SymSyncCore/Sources/SymSyncCore/`：`Models`（SyncRule 等）、`FileSystem`（entryKind / normalizedPath）、`Planner`（只读规划）、`Executor`（建链 / 清坏链）、`RuleStore`、`Grants`
- `SymSync/`：`BookmarkAccess`（沙盒 bookmark）、`DirectoryPicker`、`RuleListModel`（@Observable 协调层）、视图
- 数据：`~/Library/Application Support/SymSync/rules.json`、`grants.json`
- 流程 artifact：`docs/intent/`、`docs/specs/`、`docs/plans/`；评审策略 `REVIEW.md`

## Verifying your work

- 改 Core：`make test-core` 全绿
- 改 App：`make build` 成功，并在运行的 App 里手动走一遍受影响的流程
- 报告完成前贴出命令输出末尾。测试失败改代码，不改测试；不跳过、不删除失败测试

## Things Claude gets wrong

- `FileManager.fileExists(atPath:)` 跟随软链，坏链返回 false。判断条目类型用 `FileManager.entryKind(atPath:)`（唯一例外：Executor 判断目标目录是否存在要跟随软链，用 fileExists(atPath:isDirectory:)）
- `resolvingSymlinksInPath()` 会把 `/var` 变成 `/private/var`，导致路径比较失败。统一用 `normalizedPath`
- `removeItem(at:)` 删软链时只删链接本身，这是我们要的行为，不要改成先解析再删
- `URL(fileURLWithPath: "")` 会解析成当前工作目录，不是空路径。"未设置目录"的判断用 `Location.bookmark == nil`
- 用 index 做 identity 的 ForEach 行里若有自己的 @State，删除中间项后要靠 .onChange(of: binding) 重新同步，onAppear 不会再触发
- 执行/清理按钮只把各自待处理的动作交给 Executor，再按 action.id 把结果合并回表格；整表重投会让已创建项变成"失败"

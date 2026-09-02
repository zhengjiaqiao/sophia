# SymSync 软链接同步工具 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可上架 Mac App Store 的 SwiftUI 应用，保存"源目录 → 多个目标目录"的软链接同步记录，预览并增量执行。

**Architecture:** 核心逻辑（模型、Planner、Executor、持久化、授权路径匹配）放在本地 Swift Package `SymSyncCore`，纯 Foundation、无 UI 依赖、`swift test` 覆盖。App 壳 `SymSync` 由 xcodegen 从 `project.yml` 生成 Xcode 工程，负责沙盒 entitlements、security-scoped bookmark、SwiftUI 界面，通过本地 package 依赖调用 Core。

**Tech Stack:** Swift 6（语言模式 6.0）、SwiftUI、Swift Testing、xcodegen、Xcode 26.6、macOS 15 部署目标、GitHub Actions。

**Spec:** `docs/specs/2026-09-02-symlink-sync-design.md`

## Global Constraints

- 部署目标 macOS 15.0；`swift-tools-version: 6.0`；Swift 语言模式 6.0。
- `SymSyncCore` 不得 `import AppKit` / `SwiftUI`，只认文件路径。
- App Sandbox 开启：`com.apple.security.app-sandbox`、`com.apple.security.files.user-selected.read-write`、`com.apple.security.files.bookmarks.app-scope`。
- 永不静默覆盖或删除用户数据；唯一的删除操作是用户二次确认后的坏链清理。
- 软链接一律使用绝对路径指向源。
- UI 文案与文档用中文，代码标识符用英文；提交信息用 Conventional Commits（feat / fix / docs / test / chore）。
- 路径比较统一经过 `normalizedPath(_:)`，不使用 `resolvingSymlinksInPath`。
- 每个任务结束前运行本任务的验证命令；不得为了通过而修改测试。

---

## Plan（playbook Stage 3 摘要）

### Files that change

新建（无已有代码）：

| 路径 | 职责 |
|---|---|
| `SymSyncCore/Package.swift` | Core package 定义 |
| `SymSyncCore/Sources/SymSyncCore/Models.swift` | Location / Selection / SyncRule / ActionKind / PlannedAction / SyncReport |
| `SymSyncCore/Sources/SymSyncCore/FileSystem.swift` | `normalizedPath`、`EntryKind`、`FileManager.entryKind(atPath:)` |
| `SymSyncCore/Sources/SymSyncCore/Planner.swift` | 只读规划 |
| `SymSyncCore/Sources/SymSyncCore/Executor.swift` | 执行 create / 清理坏链 |
| `SymSyncCore/Sources/SymSyncCore/RuleStore.swift` | `RuleStore` 协议 + `FileRuleStore` |
| `SymSyncCore/Sources/SymSyncCore/Grants.swift` | `Grant`、`GrantStore`、`covering(_:)` |
| `SymSyncCore/Tests/SymSyncCoreTests/TempTree.swift` | 测试用临时目录夹具 |
| `SymSyncCore/Tests/SymSyncCoreTests/*Tests.swift` | 各单元测试 |
| `project.yml` | xcodegen 工程定义（生成 `SymSync.xcodeproj`，不入库） |
| `SymSync/SymSyncApp.swift` | App 入口、`AppPaths` |
| `SymSync/BookmarkAccess.swift` | bookmark 生成 / 解析 / 持有访问 |
| `SymSync/DirectoryPicker.swift` | NSOpenPanel 封装 |
| `SymSync/RuleListModel.swift` | `@Observable` 协调层 |
| `SymSync/ContentView.swift` `SidebarView.swift` `RuleDetailView.swift` `DirectoryField.swift` `PreviewView.swift` | 界面 |
| `Makefile` `CLAUDE.md` `REVIEW.md` `.claude/settings.json` `.claude/hooks/*.sh` `.github/workflows/ci.yml` | 流程配置 |

### Order of work

1. 脚手架与流程配置（Task 1–2）→ PR `feat/scaffold`
2. Core：模型 → 文件系统助手 → Planner → Executor → 持久化 → 授权匹配（Task 3–9）→ PR `feat/core`
3. App：Xcode 工程 + 沙盒建链验证 → 授权与选择器 → 协调层 → 列表与详情 → 预览与执行（Task 10–14）→ PR `feat/app`
4. 手动验证清单、文档收尾（Task 15）

### Risks

- **沙盒内建链**：在已授权目录创建指向另一路径的软链是否被沙盒允许。Task 10 用一次性检查按钮第一时间验证；若失败，回退为要求源目录同样经过授权（设计中源目录本就授权，预期可行）。
- **`/var` 与 `/private/var`**：路径标准化不一致会导致 `alreadyLinked` 判定失败。所有比较走 `normalizedPath`，测试在 `/var/folders` 临时目录里覆盖。
- **`fileExists(atPath:)` 跟随软链**：坏链会被判为不存在。条目类型判断一律用基于 `attributesOfItem`（lstat）的 `entryKind`。
- **GitHub 私有仓库免费版无分支保护**：PR 流程靠约定而非强制。若需强制，将仓库改为公开。
- **CI 运行器 Xcode 版本**：`macos-latest` 可能不是 Xcode 26，CI 只跑 `swift test`，`xcodebuild` 在本地跑。
- **App Store 签名**：本地开发用 ad-hoc 签名（`CODE_SIGN_IDENTITY=-`），上架前在 `project.yml` 填 `DEVELOPMENT_TEAM` 改为 Automatic。

### Proof

- `make test-core`：Core 全部测试通过，覆盖 spec §9 的每一条用例。
- `make build`：App 编译通过，输出以 `** BUILD SUCCEEDED **` 结尾。
- Task 10 沙盒建链检查在真机上显示"已创建"。
- Task 15 手动验证清单逐项勾选。

---

## Task 1: Core package 脚手架 + Makefile + CLAUDE.md

**Files:**
- Create: `SymSyncCore/Package.swift`
- Create: `SymSyncCore/Sources/SymSyncCore/SymSyncCore.swift`
- Create: `SymSyncCore/Tests/SymSyncCoreTests/SmokeTests.swift`
- Create: `Makefile`
- Create: `CLAUDE.md`

**Interfaces:**
- Produces: 可运行的 `make test-core`；后续任务全部在该 package 内添加文件。

- [ ] **Step 1: 建分支**

```bash
git checkout -b feat/scaffold
```

- [ ] **Step 2: 写 Package.swift 与空库**

`SymSyncCore/Package.swift`：
```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SymSyncCore",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "SymSyncCore", targets: ["SymSyncCore"])
    ],
    targets: [
        .target(name: "SymSyncCore"),
        .testTarget(name: "SymSyncCoreTests", dependencies: ["SymSyncCore"]),
    ]
)
```

`SymSyncCore/Sources/SymSyncCore/SymSyncCore.swift`：
```swift
/// SymSyncCore：软链接同步的模型、规划、执行与持久化。无 UI 依赖。
public enum SymSyncCoreInfo {
    public static let version = "0.1.0"
}
```

- [ ] **Step 3: 写冒烟测试**

`SymSyncCore/Tests/SymSyncCoreTests/SmokeTests.swift`：
```swift
import Testing
@testable import SymSyncCore

@Test func packageLinks() {
    #expect(SymSyncCoreInfo.version == "0.1.0")
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd SymSyncCore && swift test`
Expected: 输出末尾 `Test run with 1 test passed`

- [ ] **Step 5: 写 Makefile**

`Makefile`：
```make
SHELL := /bin/bash
.PHONY: test test-core build project format

test: test-core build

test-core:
	cd SymSyncCore && swift test

build: SymSync.xcodeproj
	set -o pipefail; xcodebuild -project SymSync.xcodeproj -scheme SymSync -configuration Debug \
	  -derivedDataPath build CODE_SIGN_IDENTITY=- build | tail -20

SymSync.xcodeproj: project.yml
	xcodegen generate

project:
	xcodegen generate

format:
	swift format -i -r SymSyncCore/Sources SymSyncCore/Tests SymSync
```

此时 `project.yml` 尚不存在，`make build` 会失败，属预期；Task 10 补齐。

- [ ] **Step 6: 写 CLAUDE.md**

`CLAUDE.md`：
```markdown
# SymSync

macOS SwiftUI 软链接同步工具。核心逻辑在 `SymSyncCore/`（Swift Package，纯 Foundation），App 壳在 `SymSync/`（xcodegen 从 `project.yml` 生成 `SymSync.xcodeproj`，工程文件不入库）。

## Commands

- `make test-core`：Core 单元测试。健康输出末尾为 `Test run with N tests passed after X seconds.`
- `make build`：编译 App（ad-hoc 签名）。健康输出末尾为 `** BUILD SUCCEEDED **`
- `make test`：以上两者，提交前必跑
- `make project`：改了 `project.yml` 后重新生成工程
- `make format`：`swift format` 格式化

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

- `FileManager.fileExists(atPath:)` 跟随软链，坏链返回 false。判断条目类型用 `FileManager.entryKind(atPath:)`
- `resolvingSymlinksInPath()` 会把 `/var` 变成 `/private/var`，导致路径比较失败。统一用 `normalizedPath`
- `removeItem(at:)` 删软链时只删链接本身，这是我们要的行为，不要改成先解析再删
- `URL(fileURLWithPath: "")` 会解析成当前工作目录，不是空路径。"未设置目录"的判断用 `Location.bookmark == nil`
```

- [ ] **Step 7: 提交**

```bash
git add SymSyncCore Makefile CLAUDE.md
git commit -m "chore: scaffold SymSyncCore package, Makefile and CLAUDE.md"
```

---

## Task 2: 流程配置：REVIEW.md、hooks、CI

**Files:**
- Create: `REVIEW.md`
- Create: `.claude/settings.json`
- Create: `.claude/hooks/format-swift.sh`
- Create: `.claude/hooks/protect-tests.sh`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: 编辑 `.swift` 后自动格式化；存在 `.claude/FIXING` 文件时禁止编辑 `Tests/`；PR 触发 CI 跑 `swift test`。

- [ ] **Step 1: 写 REVIEW.md**

```markdown
# Review instructions

## Passes
- Bugs：逻辑错误、边界条件（空目录、隐藏文件、坏链、目标目录不存在）、路径标准化不一致
- Security：沙盒外访问、未经确认的删除或覆盖、bookmark 未释放
- Compliance：改动是否符合 `docs/specs/*-design.md` 与 `docs/plans/*-plan.md`；Core 是否引入了 UI 依赖

## What Important means
仅用于：会破坏用户文件、绕过冲突保护、导致重复建链或崩溃的发现。

## Cap the nits
最多报告 5 条 Nit，其余只给数量。

## Do not report
`SymSync.xcodeproj/`、`build/`、格式问题（`make format` 已处理）。
```

- [ ] **Step 2: 写 hooks**

`.claude/hooks/format-swift.sh`：
```bash
#!/bin/bash
file=$(jq -r '.tool_input.file_path // empty' < /dev/stdin)
[[ "$file" == *.swift && -f "$file" ]] || exit 0
swift format -i "$file" 2>/dev/null
exit 0
```

`.claude/hooks/protect-tests.sh`：
```bash
#!/bin/bash
file=$(jq -r '.tool_input.file_path // empty' < /dev/stdin)
if [[ -f "$CLAUDE_PROJECT_DIR/.claude/FIXING" && "$file" == *"/Tests/"* ]]; then
  echo "修 bug 期间禁止改测试（存在 .claude/FIXING）。改代码让测试通过；确需改测试请先删除该标记文件。" >&2
  exit 2
fi
exit 0
```

```bash
chmod +x .claude/hooks/*.sh
```

`.claude/settings.json`：
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-tests.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/format-swift.sh" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: 验证 hook**

Run:
```bash
echo '{"tool_input":{"file_path":"'$PWD'/SymSyncCore/Tests/SymSyncCoreTests/SmokeTests.swift"}}' | CLAUDE_PROJECT_DIR=$PWD .claude/hooks/protect-tests.sh; echo "exit=$?"
touch .claude/FIXING
echo '{"tool_input":{"file_path":"'$PWD'/SymSyncCore/Tests/SymSyncCoreTests/SmokeTests.swift"}}' | CLAUDE_PROJECT_DIR=$PWD .claude/hooks/protect-tests.sh; echo "exit=$?"
rm .claude/FIXING
```
Expected: 第一次 `exit=0`，第二次输出中文提示且 `exit=2`。

- [ ] **Step 4: 写 CI**

`.github/workflows/ci.yml`：
```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  core-tests:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: swift --version
      - run: swift test
        working-directory: SymSyncCore
```

- [ ] **Step 5: 提交并开第一个 PR**

```bash
echo ".claude/FIXING" >> .gitignore
git add REVIEW.md .claude .github .gitignore
git commit -m "chore: add review policy, hooks and CI"
git push -u origin feat/scaffold
gh pr create --title "chore: scaffold package and process config" --body "Tasks 1-2 of docs/plans/2026-09-02-symlink-sync-plan.md"
```

在 Claude Code 里运行 `/code-review` 评审，处理 Important 发现后 `gh pr merge --squash --delete-branch`，然后 `git checkout main && git pull`。

---

## Task 3: 核心模型

**Files:**
- Create: `SymSyncCore/Sources/SymSyncCore/Models.swift`
- Test: `SymSyncCore/Tests/SymSyncCoreTests/ModelsTests.swift`
- Delete: `SymSyncCore/Sources/SymSyncCore/SymSyncCore.swift`、`SmokeTests.swift`（脚手架占位，不再需要）

**Interfaces:**
- Produces:
  - `Location(url: URL, bookmark: Data? = nil)`
  - `Selection = .all | .items([String])`
  - `SyncRule(id: UUID = UUID(), name: String, source: Location, selection: Selection = .all, targets: [Location] = [], lastRunAt: Date? = nil)`
  - `ActionKind = .create | .alreadyLinked | .conflict | .sourceMissing | .brokenLink`
  - `PlannedAction(kind:itemName:sourcePath:targetPath:target:)`，`Identifiable`，`id = "\(kind)|\(targetPath.path)"`
  - `SyncReport(entries: [Entry])`，`Entry(action:outcome:)`，`Outcome = .created | .skipped | .removed | .failed(String)`

- [ ] **Step 1: 建分支**

```bash
git checkout -b feat/core
git rm -q SymSyncCore/Sources/SymSyncCore/SymSyncCore.swift SymSyncCore/Tests/SymSyncCoreTests/SmokeTests.swift
```

- [ ] **Step 2: 写失败测试**

`SymSyncCore/Tests/SymSyncCoreTests/ModelsTests.swift`：
```swift
import Foundation
import Testing
@testable import SymSyncCore

@Test func syncRuleRoundTripsThroughJSON() throws {
    let rule = SyncRule(
        name: "skills",
        source: Location(url: URL(fileURLWithPath: "/tmp/src"), bookmark: Data([1, 2])),
        selection: .items(["a", "b"]),
        targets: [Location(url: URL(fileURLWithPath: "/tmp/dst"))],
        lastRunAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let data = try JSONEncoder().encode(rule)
    let decoded = try JSONDecoder().decode(SyncRule.self, from: data)
    #expect(decoded == rule)
}

@Test func plannedActionIDIsUniquePerKindAndTargetPath() {
    let path = URL(fileURLWithPath: "/tmp/dst/a")
    let src = URL(fileURLWithPath: "/tmp/src/a")
    let create = PlannedAction(kind: .create, itemName: "a", sourcePath: src, targetPath: path, target: path.deletingLastPathComponent())
    let broken = PlannedAction(kind: .brokenLink, itemName: "a", sourcePath: src, targetPath: path, target: path.deletingLastPathComponent())
    #expect(create.id != broken.id)
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cd SymSyncCore && swift test`
Expected: 编译错误 `cannot find 'SyncRule' in scope`

- [ ] **Step 4: 写模型**

`SymSyncCore/Sources/SymSyncCore/Models.swift`：
```swift
import Foundation

/// 一个目录及其沙盒 bookmark。bookmark 由 App 层写入，Core 不解释。
public struct Location: Codable, Equatable, Sendable {
    public var url: URL
    public var bookmark: Data?

    public init(url: URL, bookmark: Data? = nil) {
        self.url = url
        self.bookmark = bookmark
    }
}

/// 同步整目录，或只同步源目录下指定名字的子项。
public enum Selection: Codable, Equatable, Sendable {
    case all
    case items([String])
}

public struct SyncRule: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var source: Location
    public var selection: Selection
    public var targets: [Location]
    public var lastRunAt: Date?

    public init(
        id: UUID = UUID(),
        name: String,
        source: Location,
        selection: Selection = .all,
        targets: [Location] = [],
        lastRunAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.source = source
        self.selection = selection
        self.targets = targets
        self.lastRunAt = lastRunAt
    }
}

public enum ActionKind: String, Equatable, Sendable {
    /// 目标不存在，将建链
    case create
    /// 已是指向正确源的软链，跳过
    case alreadyLinked
    /// 目标存在真实文件/目录或指向他处的软链，跳过并报告
    case conflict
    /// 指定子项在源里不存在
    case sourceMissing
    /// 目标里指向本源目录下、但源已不存在的软链
    case brokenLink
}

public struct PlannedAction: Equatable, Identifiable, Sendable {
    public let kind: ActionKind
    public let itemName: String
    /// 链接应指向的绝对路径
    public let sourcePath: URL
    /// 目标目录下的链接路径
    public let targetPath: URL
    /// 所属目标目录
    public let target: URL

    public var id: String { "\(kind.rawValue)|\(targetPath.path)" }

    public init(kind: ActionKind, itemName: String, sourcePath: URL, targetPath: URL, target: URL) {
        self.kind = kind
        self.itemName = itemName
        self.sourcePath = sourcePath
        self.targetPath = targetPath
        self.target = target
    }
}

public struct SyncReport: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        case created
        case skipped
        case removed
        case failed(String)
    }

    public struct Entry: Equatable, Sendable {
        public let action: PlannedAction
        public let outcome: Outcome

        public init(action: PlannedAction, outcome: Outcome) {
            self.action = action
            self.outcome = outcome
        }
    }

    public let entries: [Entry]

    public init(entries: [Entry]) {
        self.entries = entries
    }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 2 tests passed`

- [ ] **Step 6: 提交**

```bash
git add -A SymSyncCore
git commit -m "feat(core): add sync rule and action models"
```

---

## Task 4: 文件系统助手：normalizedPath 与 entryKind

**Files:**
- Create: `SymSyncCore/Sources/SymSyncCore/FileSystem.swift`
- Create: `SymSyncCore/Tests/SymSyncCoreTests/TempTree.swift`
- Test: `SymSyncCore/Tests/SymSyncCoreTests/FileSystemTests.swift`

**Interfaces:**
- Produces:
  - `func normalizedPath(_ path: String) -> String`（package 内部）
  - `enum EntryKind { case missing, symlink(destination: String), file, directory }`（package 内部）
  - `FileManager.entryKind(atPath:) -> EntryKind`，symlink 的 destination 为标准化绝对路径
  - 测试夹具 `TempTree`：`root`、`dir(_:)`、`file(_:_:)`、`link(at:to:)`、`cleanup()`

- [ ] **Step 1: 写测试夹具**

`SymSyncCore/Tests/SymSyncCoreTests/TempTree.swift`：
```swift
import Foundation

/// 在系统临时目录下建一棵真实的文件树，测试结束后删除。
struct TempTree {
    let root: URL
    private let fm = FileManager.default

    init() throws {
        root = fm.temporaryDirectory.appendingPathComponent("symsync-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// 相对 root 创建目录（可多级），返回其 URL
    @discardableResult
    func dir(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// 在目录下创建一个小文件
    @discardableResult
    func file(_ directory: URL, _ name: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try "x".write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// 创建软链 at -> to（to 用绝对路径）
    func link(at: URL, to: URL) throws {
        try fm.createSymbolicLink(atPath: at.path, withDestinationPath: to.path)
    }

    func cleanup() {
        try? fm.removeItem(at: root)
    }
}
```

- [ ] **Step 2: 写失败测试**

`SymSyncCore/Tests/SymSyncCoreTests/FileSystemTests.swift`：
```swift
import Foundation
import Testing
@testable import SymSyncCore

@Test func normalizedPathRemovesDotsAndTrailingSlash() {
    #expect(normalizedPath("/a/b/../c/") == "/a/c")
    #expect(normalizedPath("/a/./b") == "/a/b")
}

@Test func entryKindDistinguishesMissingFileDirectoryAndSymlink() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let d = try t.dir("d")
    let f = try t.file(d, "f")
    let l = d.appendingPathComponent("l")
    try t.link(at: l, to: f)
    let fm = FileManager.default

    #expect(fm.entryKind(atPath: d.appendingPathComponent("nope").path) == .missing)
    #expect(fm.entryKind(atPath: f.path) == .file)
    #expect(fm.entryKind(atPath: d.path) == .directory)
    #expect(fm.entryKind(atPath: l.path) == .symlink(destination: normalizedPath(f.path)))
}

@Test func entryKindReportsBrokenSymlinkAsSymlink() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let d = try t.dir("d")
    let gone = d.appendingPathComponent("gone")
    let l = d.appendingPathComponent("l")
    try t.link(at: l, to: gone)

    #expect(FileManager.default.entryKind(atPath: l.path) == .symlink(destination: normalizedPath(gone.path)))
    #expect(FileManager.default.fileExists(atPath: l.path) == false)
}

@Test func entryKindResolvesRelativeSymlinkAgainstItsDirectory() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let d = try t.dir("d")
    let f = try t.file(d, "f")
    let l = d.appendingPathComponent("l")
    try FileManager.default.createSymbolicLink(atPath: l.path, withDestinationPath: "f")

    #expect(FileManager.default.entryKind(atPath: l.path) == .symlink(destination: normalizedPath(f.path)))
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cd SymSyncCore && swift test`
Expected: 编译错误 `cannot find 'normalizedPath' in scope`

- [ ] **Step 4: 写实现**

`SymSyncCore/Sources/SymSyncCore/FileSystem.swift`：
```swift
import Foundation

/// 去掉 `.`、`..` 与尾部斜杠。不解析软链，保证同一路径两侧比较一致。
func normalizedPath(_ path: String) -> String {
    (path as NSString).standardizingPath
}

enum EntryKind: Equatable {
    case missing
    /// destination 为标准化后的绝对路径
    case symlink(destination: String)
    case file
    case directory
}

extension FileManager {
    /// 基于 lstat 判断条目类型，坏软链也会被识别为 symlink。
    func entryKind(atPath path: String) -> EntryKind {
        guard let attrs = try? attributesOfItem(atPath: path),
            let type = attrs[.type] as? FileAttributeType
        else { return .missing }
        switch type {
        case .typeSymbolicLink:
            let raw = (try? destinationOfSymbolicLink(atPath: path)) ?? ""
            let absolute =
                raw.hasPrefix("/")
                ? raw
                : ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(raw)
            return .symlink(destination: normalizedPath(absolute))
        case .typeDirectory:
            return .directory
        default:
            return .file
        }
    }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 6 tests passed`

- [ ] **Step 6: 提交**

```bash
git add SymSyncCore
git commit -m "feat(core): add path normalization and lstat-based entry kind"
```

---

## Task 5: Planner：create / alreadyLinked / conflict

**Files:**
- Create: `SymSyncCore/Sources/SymSyncCore/Planner.swift`
- Test: `SymSyncCore/Tests/SymSyncCoreTests/PlannerTests.swift`

**Interfaces:**
- Consumes: Task 3 模型、Task 4 `entryKind` / `normalizedPath`
- Produces: `Planner(fileManager: FileManager = .default)`，`func plan(_ rule: SyncRule) throws -> [PlannedAction]`，`enum PlannerError: Error, Equatable { case sourceUnreadable(String) }`

- [ ] **Step 1: 写失败测试**

`SymSyncCore/Tests/SymSyncCoreTests/PlannerTests.swift`：
```swift
import Foundation
import Testing
@testable import SymSyncCore

private func rule(_ src: URL, _ targets: URL..., selection: Selection = .all) -> SyncRule {
    SyncRule(name: "r", source: Location(url: src), selection: selection, targets: targets.map { Location(url: $0) })
}

@Test func freshTargetPlansCreateForEachItem() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, "a.md")
    try t.dir("src/b")

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.itemName) == ["a.md", "b"])
    #expect(actions.allSatisfy { $0.kind == .create })
    #expect(actions[0].sourcePath.path == src.appendingPathComponent("a.md").path)
    #expect(actions[0].targetPath.path == dst.appendingPathComponent("a.md").path)
    #expect(actions[0].target.path == dst.path)
}

@Test func existingCorrectLinkIsAlreadyLinked() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    let a = try t.file(src, "a.md")
    try t.link(at: dst.appendingPathComponent("a.md"), to: a)

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.kind) == [.alreadyLinked])
}

@Test func realFileWithSameNameIsConflict() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, "a.md")
    try t.file(dst, "a.md")

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.kind) == [.conflict])
}

@Test func linkPointingElsewhereIsConflict() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    let other = try t.dir("other")
    try t.file(src, "a.md")
    let otherA = try t.file(other, "a.md")
    try t.link(at: dst.appendingPathComponent("a.md"), to: otherA)

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.kind) == [.conflict])
}

@Test func unreadableSourceThrows() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let dst = try t.dir("dst")
    let src = t.root.appendingPathComponent("missing")

    #expect(throws: PlannerError.sourceUnreadable(src.path)) {
        try Planner().plan(rule(src, dst))
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd SymSyncCore && swift test`
Expected: 编译错误 `cannot find 'Planner' in scope`

- [ ] **Step 3: 写实现**

`SymSyncCore/Sources/SymSyncCore/Planner.swift`：
```swift
import Foundation

public enum PlannerError: Error, Equatable {
    case sourceUnreadable(String)
}

/// 只读规划：对每个目标目录 × 每个子项判定应执行的动作。不修改文件系统。
public struct Planner {
    private let fm: FileManager

    public init(fileManager: FileManager = .default) {
        self.fm = fileManager
    }

    public func plan(_ rule: SyncRule) throws -> [PlannedAction] {
        let source = normalizedPath(rule.source.url.path)
        let names = try itemNames(for: rule.selection, in: source)
        var actions: [PlannedAction] = []
        for target in rule.targets {
            let targetDir = normalizedPath(target.url.path)
            for name in names {
                actions.append(action(for: name, source: source, targetDir: targetDir))
            }
        }
        return actions
    }

    private func itemNames(for selection: Selection, in source: String) throws -> [String] {
        switch selection {
        case .all:
            guard let entries = try? fm.contentsOfDirectory(atPath: source) else {
                throw PlannerError.sourceUnreadable(source)
            }
            return entries.filter { !$0.hasPrefix(".") }.sorted()
        case .items(let items):
            return items
        }
    }

    private func action(for name: String, source: String, targetDir: String) -> PlannedAction {
        let sourcePath = (source as NSString).appendingPathComponent(name)
        let targetPath = (targetDir as NSString).appendingPathComponent(name)
        let kind: ActionKind
        if fm.entryKind(atPath: sourcePath) == .missing {
            kind = .sourceMissing
        } else {
            switch fm.entryKind(atPath: targetPath) {
            case .missing:
                kind = .create
            case .symlink(let destination) where destination == sourcePath:
                kind = .alreadyLinked
            default:
                kind = .conflict
            }
        }
        return PlannedAction(
            kind: kind,
            itemName: name,
            sourcePath: URL(fileURLWithPath: sourcePath),
            targetPath: URL(fileURLWithPath: targetPath),
            target: URL(fileURLWithPath: targetDir)
        )
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 11 tests passed`

- [ ] **Step 5: 提交**

```bash
git add SymSyncCore
git commit -m "feat(core): plan create, alreadyLinked and conflict actions"
```

---

## Task 6: Planner：指定子项、隐藏文件、一对多

**Files:**
- Modify: `SymSyncCore/Tests/SymSyncCoreTests/PlannerTests.swift`（追加）

**Interfaces:**
- Consumes: Task 5 `Planner`。本任务只补测试；若测试暴露缺陷则修 `Planner.swift`。

- [ ] **Step 1: 追加测试**

追加到 `PlannerTests.swift` 末尾：
```swift
@Test func selectedItemsOnlyPlanNamedEntriesAndReportMissing() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, "a.md")
    try t.file(src, "b.md")

    let actions = try Planner().plan(rule(src, dst, selection: .items(["a.md", "zzz"])))

    #expect(actions.map(\.itemName) == ["a.md", "zzz"])
    #expect(actions.map(\.kind) == [.create, .sourceMissing])
}

@Test func hiddenEntriesAreSkippedInAllMode() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, ".DS_Store")
    try t.file(src, "a.md")

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.itemName) == ["a.md"])
}

@Test func multipleTargetsArePlannedIndependently() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst1 = try t.dir("dst1")
    let dst2 = try t.dir("dst2")
    let a = try t.file(src, "a.md")
    try t.link(at: dst1.appendingPathComponent("a.md"), to: a)

    let actions = try Planner().plan(rule(src, dst1, dst2))

    #expect(actions.map(\.kind) == [.alreadyLinked, .create])
    #expect(actions.map(\.target.path) == [dst1.path, dst2.path])
}
```

- [ ] **Step 2: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 14 tests passed`。若有失败，修 `Planner.swift` 而不是测试。

- [ ] **Step 3: 提交**

```bash
git add SymSyncCore
git commit -m "test(core): cover item selection, hidden entries and multiple targets"
```

---

## Task 7: Planner：坏链检测

**Files:**
- Modify: `SymSyncCore/Sources/SymSyncCore/Planner.swift`
- Modify: `SymSyncCore/Tests/SymSyncCoreTests/PlannerTests.swift`（追加）

**Interfaces:**
- Produces: `plan` 结果在每个目标的子项动作之后追加该目标下的 `brokenLink` 动作；只报告 destination 以 `source/` 为前缀且已不存在的软链。

- [ ] **Step 1: 追加失败测试**

```swift
@Test func brokenLinksUnderSourceAreReportedOthersIgnored() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, "keep.md")
    try t.link(at: dst.appendingPathComponent("gone.md"), to: src.appendingPathComponent("gone.md"))
    try t.link(at: dst.appendingPathComponent("foreign"), to: t.root.appendingPathComponent("elsewhere/x"))

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.kind) == [.create, .brokenLink])
    #expect(actions[1].itemName == "gone.md")
    #expect(actions[1].sourcePath.path == src.appendingPathComponent("gone.md").path)
    #expect(actions[1].targetPath.path == dst.appendingPathComponent("gone.md").path)
}

@Test func liveLinkUnderSourceIsNotBroken() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    let a = try t.file(src, "a.md")
    try t.link(at: dst.appendingPathComponent("a.md"), to: a)

    let actions = try Planner().plan(rule(src, dst))

    #expect(actions.map(\.kind) == [.alreadyLinked])
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd SymSyncCore && swift test`
Expected: `brokenLinksUnderSourceAreReportedOthersIgnored` 失败，`actions.map(\.kind) == [.create]`

- [ ] **Step 3: 实现**

在 `Planner.plan` 的目标循环内、子项循环之后追加一行，并新增私有方法：
```swift
        for target in rule.targets {
            let targetDir = normalizedPath(target.url.path)
            for name in names {
                actions.append(action(for: name, source: source, targetDir: targetDir))
            }
            actions += brokenLinks(in: targetDir, under: source)
        }
```

```swift
    /// 目标目录里指向 source/ 之下、但源已不存在的软链。
    private func brokenLinks(in targetDir: String, under source: String) -> [PlannedAction] {
        guard let entries = try? fm.contentsOfDirectory(atPath: targetDir) else { return [] }
        let prefix = source + "/"
        return entries.sorted().compactMap { name in
            let path = (targetDir as NSString).appendingPathComponent(name)
            guard case .symlink(let destination) = fm.entryKind(atPath: path),
                destination.hasPrefix(prefix),
                !fm.fileExists(atPath: destination)
            else { return nil }
            return PlannedAction(
                kind: .brokenLink,
                itemName: name,
                sourcePath: URL(fileURLWithPath: destination),
                targetPath: URL(fileURLWithPath: path),
                target: URL(fileURLWithPath: targetDir)
            )
        }
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 16 tests passed`

- [ ] **Step 5: 提交**

```bash
git add SymSyncCore
git commit -m "feat(core): detect broken links left under source"
```

---

## Task 8: Executor

**Files:**
- Create: `SymSyncCore/Sources/SymSyncCore/Executor.swift`
- Test: `SymSyncCore/Tests/SymSyncCoreTests/ExecutorTests.swift`

**Interfaces:**
- Consumes: Task 3 模型、Task 5/7 `Planner`
- Produces: `Executor(fileManager: FileManager = .default)`，`func run(_ actions: [PlannedAction], cleanBroken: Bool = false) -> SyncReport`

- [ ] **Step 1: 写失败测试**

`SymSyncCore/Tests/SymSyncCoreTests/ExecutorTests.swift`：
```swift
import Foundation
import Testing
@testable import SymSyncCore

private func rule(_ src: URL, _ dst: URL) -> SyncRule {
    SyncRule(name: "r", source: Location(url: src), targets: [Location(url: dst)])
}

@Test func createActionsProduceAbsoluteSymlinks() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    let a = try t.file(src, "a.md")
    let actions = try Planner().plan(rule(src, dst))

    let report = Executor().run(actions)

    #expect(report.entries.map(\.outcome) == [.created])
    let dest = try FileManager.default.destinationOfSymbolicLink(atPath: dst.appendingPathComponent("a.md").path)
    #expect(dest == a.path)
    #expect(dest.hasPrefix("/"))
}

@Test func secondRunSkipsEverythingAndCreatesNothing() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, "a.md")
    _ = Executor().run(try Planner().plan(rule(src, dst)))

    let report = Executor().run(try Planner().plan(rule(src, dst)))

    #expect(report.entries.map(\.action.kind) == [.alreadyLinked])
    #expect(report.entries.map(\.outcome) == [.skipped])
}

@Test func conflictIsSkippedAndRealFileUntouched() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    try t.file(src, "a.md")
    let real = dst.appendingPathComponent("a.md")
    try "original".write(to: real, atomically: true, encoding: .utf8)

    let report = Executor().run(try Planner().plan(rule(src, dst)))

    #expect(report.entries.map(\.outcome) == [.skipped])
    #expect(try String(contentsOf: real, encoding: .utf8) == "original")
    #expect(FileManager.default.entryKind(atPath: real.path) == .file)
}

@Test func missingTargetDirectoryFailsWithoutCreatingIt() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = t.root.appendingPathComponent("nope")
    try t.file(src, "a.md")

    let report = Executor().run(try Planner().plan(rule(src, dst)))

    #expect(report.entries.map(\.outcome) == [.failed("目标目录不存在")])
    #expect(FileManager.default.entryKind(atPath: dst.path) == .missing)
}

@Test func brokenLinksAreKeptUnlessCleanRequested() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let src = try t.dir("src")
    let dst = try t.dir("dst")
    let gone = dst.appendingPathComponent("gone.md")
    try t.link(at: gone, to: src.appendingPathComponent("gone.md"))
    let foreign = dst.appendingPathComponent("foreign")
    try t.link(at: foreign, to: t.root.appendingPathComponent("elsewhere"))

    let kept = Executor().run(try Planner().plan(rule(src, dst)), cleanBroken: false)
    #expect(kept.entries.map(\.outcome) == [.skipped])
    #expect(FileManager.default.entryKind(atPath: gone.path) != .missing)

    let cleaned = Executor().run(try Planner().plan(rule(src, dst)), cleanBroken: true)
    #expect(cleaned.entries.map(\.outcome) == [.removed])
    #expect(FileManager.default.entryKind(atPath: gone.path) == .missing)
    #expect(FileManager.default.entryKind(atPath: foreign.path) != .missing)
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd SymSyncCore && swift test`
Expected: 编译错误 `cannot find 'Executor' in scope`

- [ ] **Step 3: 写实现**

`SymSyncCore/Sources/SymSyncCore/Executor.swift`：
```swift
import Foundation

/// 执行规划结果：只对 create 建链；brokenLink 仅在 cleanBroken 时删除链接本身。逐项独立，单项失败不中断。
public struct Executor {
    private let fm: FileManager

    public init(fileManager: FileManager = .default) {
        self.fm = fileManager
    }

    public func run(_ actions: [PlannedAction], cleanBroken: Bool = false) -> SyncReport {
        SyncReport(entries: actions.map { action in
            SyncReport.Entry(action: action, outcome: outcome(for: action, cleanBroken: cleanBroken))
        })
    }

    private func outcome(for action: PlannedAction, cleanBroken: Bool) -> SyncReport.Outcome {
        switch action.kind {
        case .create:
            guard fm.entryKind(atPath: action.target.path) == .directory else {
                return .failed("目标目录不存在")
            }
            do {
                try fm.createSymbolicLink(atPath: action.targetPath.path, withDestinationPath: action.sourcePath.path)
                return .created
            } catch {
                return .failed(error.localizedDescription)
            }
        case .brokenLink where cleanBroken:
            do {
                try fm.removeItem(atPath: action.targetPath.path)
                return .removed
            } catch {
                return .failed(error.localizedDescription)
            }
        case .alreadyLinked, .conflict, .sourceMissing, .brokenLink:
            return .skipped
        }
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 21 tests passed`

- [ ] **Step 5: 提交**

```bash
git add SymSyncCore
git commit -m "feat(core): execute planned actions and optional broken-link cleanup"
```

---

## Task 9: 持久化：FileRuleStore 与 GrantStore

**Files:**
- Create: `SymSyncCore/Sources/SymSyncCore/RuleStore.swift`
- Create: `SymSyncCore/Sources/SymSyncCore/Grants.swift`
- Test: `SymSyncCore/Tests/SymSyncCoreTests/StoreTests.swift`

**Interfaces:**
- Produces:
  - `protocol RuleStore: Sendable { func load() throws -> [SyncRule]; func save(_ rules: [SyncRule]) throws }`
  - `FileRuleStore(fileURL: URL)`
  - `Grant(path: String, bookmark: Data)`
  - `GrantStore(fileURL: URL)`，`load() throws -> [Grant]`、`save(_:) throws`
  - `[Grant].covering(_ path: String) -> Grant?`

- [ ] **Step 1: 写失败测试**

`SymSyncCore/Tests/SymSyncCoreTests/StoreTests.swift`：
```swift
import Foundation
import Testing
@testable import SymSyncCore

@Test func fileRuleStoreReturnsEmptyWhenMissingAndRoundTrips() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let store = FileRuleStore(fileURL: t.root.appendingPathComponent("sub/rules.json"))

    #expect(try store.load() == [])

    let rule = SyncRule(
        name: "r",
        source: Location(url: URL(fileURLWithPath: "/tmp/src"), bookmark: Data([9])),
        selection: .items(["a"]),
        targets: [Location(url: URL(fileURLWithPath: "/tmp/dst"))],
        lastRunAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    try store.save([rule])

    #expect(try store.load() == [rule])
}

@Test func grantStoreRoundTrips() throws {
    let t = try TempTree()
    defer { t.cleanup() }
    let store = GrantStore(fileURL: t.root.appendingPathComponent("grants.json"))
    let grant = Grant(path: "/Users/me", bookmark: Data([1]))

    #expect(try store.load() == [])
    try store.save([grant])
    #expect(try store.load() == [grant])
}

@Test func coveringMatchesSelfAndDescendantsOnly() {
    let grants = [Grant(path: "/Users/me", bookmark: Data([1])), Grant(path: "/opt/x", bookmark: Data([2]))]

    #expect(grants.covering("/Users/me")?.bookmark == Data([1]))
    #expect(grants.covering("/Users/me/a/b/")?.bookmark == Data([1]))
    #expect(grants.covering("/opt/x/../x/y")?.bookmark == Data([2]))
    #expect(grants.covering("/Users/meow") == nil)
    #expect(grants.covering("/Users") == nil)
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd SymSyncCore && swift test`
Expected: 编译错误 `cannot find 'FileRuleStore' in scope`

- [ ] **Step 3: 写实现**

`SymSyncCore/Sources/SymSyncCore/RuleStore.swift`：
```swift
import Foundation

public protocol RuleStore: Sendable {
    func load() throws -> [SyncRule]
    func save(_ rules: [SyncRule]) throws
}

/// 整个规则数组以一个 JSON 文件读写。
public struct FileRuleStore: RuleStore {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func load() throws -> [SyncRule] {
        try JSONFile.load([SyncRule].self, from: fileURL) ?? []
    }

    public func save(_ rules: [SyncRule]) throws {
        try JSONFile.save(rules, to: fileURL)
    }
}

enum JSONFile {
    static func load<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: Data(contentsOf: url))
    }

    static func save<T: Encodable>(_ value: T, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(value).write(to: url, options: .atomic)
    }
}
```

`SymSyncCore/Sources/SymSyncCore/Grants.swift`：
```swift
import Foundation

/// 用户通过选择框授权过的目录及其 security-scoped bookmark。
public struct Grant: Codable, Equatable, Sendable {
    public var path: String
    public var bookmark: Data

    public init(path: String, bookmark: Data) {
        self.path = normalizedPath(path)
        self.bookmark = bookmark
    }
}

public struct GrantStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func load() throws -> [Grant] {
        try JSONFile.load([Grant].self, from: fileURL) ?? []
    }

    public func save(_ grants: [Grant]) throws {
        try JSONFile.save(grants, to: fileURL)
    }
}

extension Array where Element == Grant {
    /// 返回覆盖该路径的授权：路径等于授权目录，或位于其下。
    public func covering(_ path: String) -> Grant? {
        let p = normalizedPath(path)
        return first { p == $0.path || p.hasPrefix($0.path + "/") }
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd SymSyncCore && swift test`
Expected: `Test run with 24 tests passed`

- [ ] **Step 5: 提交并开 PR**

```bash
git add SymSyncCore
git commit -m "feat(core): persist rules and directory grants as JSON"
git push -u origin feat/core
gh pr create --title "feat(core): sync planning, execution and persistence" --body "Tasks 3-9 of docs/plans/2026-09-02-symlink-sync-plan.md"
```

运行 `/code-review`，处理 Important 后 `gh pr merge --squash --delete-branch && git checkout main && git pull`。

---

## Task 10: Xcode 工程（xcodegen）+ 沙盒建链一次性验证

**Files:**
- Create: `project.yml`
- Create: `SymSync/SymSyncApp.swift`
- Create: `SymSync/ContentView.swift`（本任务为一次性验证视图，Task 13 替换）
- Modify: `.gitignore`（忽略 `SymSync.xcodeproj/`）

**Interfaces:**
- Produces: `make build` 通过；`AppPaths.rulesFile` / `AppPaths.grantsFile`。

- [ ] **Step 1: 建分支、装 xcodegen**

```bash
git checkout -b feat/app
brew install xcodegen
echo "SymSync.xcodeproj/" >> .gitignore
```

- [ ] **Step 2: 写 project.yml**

```yaml
name: SymSync
options:
  bundleIdPrefix: com.zhengjiaqiao
  deploymentTarget:
    macOS: "15.0"
  createIntermediateGroups: true
packages:
  SymSyncCore:
    path: SymSyncCore
targets:
  SymSync:
    type: application
    platform: macOS
    sources: [SymSync]
    dependencies:
      - package: SymSyncCore
    entitlements:
      path: SymSync/SymSync.entitlements
      properties:
        com.apple.security.app-sandbox: true
        com.apple.security.files.user-selected.read-write: true
        com.apple.security.files.bookmarks.app-scope: true
    settings:
      base:
        SWIFT_VERSION: "6.0"
        PRODUCT_BUNDLE_IDENTIFIER: com.zhengjiaqiao.SymSync
        MARKETING_VERSION: "0.1.0"
        CURRENT_PROJECT_VERSION: 1
        GENERATE_INFOPLIST_FILE: true
        INFOPLIST_KEY_LSApplicationCategoryType: public.app-category.utilities
        INFOPLIST_KEY_NSHumanReadableCopyright: ""
        ENABLE_HARDENED_RUNTIME: true
        CODE_SIGN_STYLE: Manual
        CODE_SIGN_IDENTITY: "-"
        DEVELOPMENT_TEAM: ""
```

上架前把 `CODE_SIGN_STYLE` 改为 `Automatic`、填 `DEVELOPMENT_TEAM`，然后 `make project`。

- [ ] **Step 3: 写 App 入口与一次性验证视图**

`SymSync/SymSyncApp.swift`：
```swift
import SwiftUI

@main
struct SymSyncApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowResizability(.contentSize)
    }
}

enum AppPaths {
    static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SymSync")
    }
    static var rulesFile: URL { support.appendingPathComponent("rules.json") }
    static var grantsFile: URL { support.appendingPathComponent("grants.json") }
}
```

`SymSync/ContentView.swift`（临时）：
```swift
import AppKit
import SwiftUI

/// 一次性沙盒验证：在授权的目标目录里创建指向另一目录的软链。Task 13 会替换本文件。
struct ContentView: View {
    @State private var result = "未运行"

    var body: some View {
        VStack(spacing: 12) {
            Text("沙盒建链检查").font(.title2)
            Button("选择源目录与目标目录并建链") { run() }
            Text(result).textSelection(.enabled)
        }
        .padding(24)
        .frame(width: 480)
    }

    private func run() {
        guard let source = pick("选择源目录"), let target = pick("选择目标目录") else {
            result = "已取消"
            return
        }
        let link = target.appendingPathComponent("symsync-check")
        do {
            try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: source.path)
            result = "已创建 \(link.path) -> \(source.path)"
        } catch {
            result = "失败：\(error.localizedDescription)"
        }
    }

    private func pick(_ message: String) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = message
        return panel.runModal() == .OK ? panel.url : nil
    }
}
```

- [ ] **Step 4: 生成工程并编译**

Run: `make project && make build`
Expected: 末尾 `** BUILD SUCCEEDED **`

- [ ] **Step 5: 真机验证沙盒建链**

```bash
open build/Build/Products/Debug/SymSync.app
```
点按钮，源选任一目录，目标选一个测试目录。
Expected: 显示"已创建 …"，`ls -l` 目标目录能看到 `symsync-check` 软链。验证后手动删除该链接。
若显示"失败"，把错误原文记入 `docs/plans/2026-09-02-symlink-sync-plan.md` 的 Risks，并停止等待决策。

- [ ] **Step 6: 提交**

```bash
git add project.yml SymSync .gitignore
git commit -m "feat(app): generate sandboxed Xcode project with xcodegen"
```

---

## Task 11: 授权与目录选择：BookmarkAccess、DirectoryPicker

**Files:**
- Create: `SymSync/BookmarkAccess.swift`
- Create: `SymSync/DirectoryPicker.swift`

**Interfaces:**
- Produces:
  - `BookmarkAccess.makeBookmark(for: URL) throws -> Data`
  - `BookmarkAccess.resolve(_ data: Data) throws -> (url: URL, isStale: Bool)`
  - `BookmarkAccess.withAccess<T>(_ bookmarks: [Data], _ body: () throws -> T) throws -> T`
  - `DirectoryPicker.pick(message: String, startingAt: URL? = nil) -> URL?`（`@MainActor`）

- [ ] **Step 1: 写 BookmarkAccess**

`SymSync/BookmarkAccess.swift`：
```swift
import Foundation

enum BookmarkAccess {
    static func makeBookmark(for url: URL) throws -> Data {
        try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    static func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: .withSecurityScope, relativeTo: nil, bookmarkDataIsStale: &stale)
        return (url, stale)
    }

    /// 在 body 执行期间持有所有 bookmark 的访问权，结束后释放。
    static func withAccess<T>(_ bookmarks: [Data], _ body: () throws -> T) throws -> T {
        var held: [URL] = []
        defer { held.forEach { $0.stopAccessingSecurityScopedResource() } }
        for data in bookmarks {
            let (url, _) = try resolve(data)
            if url.startAccessingSecurityScopedResource() {
                held.append(url)
            }
        }
        return try body()
    }
}
```

- [ ] **Step 2: 写 DirectoryPicker**

`SymSync/DirectoryPicker.swift`：
```swift
import AppKit

enum DirectoryPicker {
    @MainActor
    static func pick(message: String, startingAt: URL? = nil) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.message = message
        panel.directoryURL = startingAt
        return panel.runModal() == .OK ? panel.url : nil
    }
}
```

- [ ] **Step 3: 编译**

Run: `make build`
Expected: `** BUILD SUCCEEDED **`

- [ ] **Step 4: 提交**

```bash
git add SymSync
git commit -m "feat(app): add security-scoped bookmark access and directory picker"
```

---

## Task 12: RuleListModel 协调层

**Files:**
- Create: `SymSync/RuleListModel.swift`
- Modify: `SymSync/SymSyncApp.swift`（注入模型）

**Interfaces:**
- Consumes: Core `RuleStore` / `GrantStore` / `Planner` / `Executor` / `[Grant].covering`；Task 11 `BookmarkAccess` / `DirectoryPicker`
- Produces `@MainActor @Observable final class RuleListModel`：
  - `var rules: [SyncRule]`、`var selectedRuleID: UUID?`、`var errorMessage: String?`
  - `func addRule() -> SyncRule`、`func update(_ rule: SyncRule)`、`func delete(_ id: UUID)`
  - `func location(forTypedPath path: String) -> Location?`（nil 表示未授权）
  - `func grantParent(of path: String) -> Location?`（弹选择框授权父目录并返回可用 Location）
  - `func chooseDirectory(message: String) -> Location?`（弹选择框，生成 bookmark，同时记录 grant）
  - `func plan(_ rule: SyncRule) throws -> [PlannedAction]`
  - `func execute(_ rule: SyncRule, actions: [PlannedAction], cleanBroken: Bool) throws -> SyncReport`
  - `func needsReauthorization(_ rule: SyncRule) -> Bool`（有 bookmark 但失效）
  - `func isConfigured(_ rule: SyncRule) -> Bool`（源与所有目标都有 bookmark）

- [ ] **Step 1: 写模型**

`SymSync/RuleListModel.swift`：
```swift
import Foundation
import SymSyncCore

@MainActor
@Observable
final class RuleListModel {
    var rules: [SyncRule] = []
    var selectedRuleID: UUID?
    var errorMessage: String?

    private var grants: [Grant] = []
    private let store: any RuleStore
    private let grantStore: GrantStore

    init(store: any RuleStore, grantStore: GrantStore) {
        self.store = store
        self.grantStore = grantStore
        do {
            rules = try store.load()
            grants = try grantStore.load()
        } catch {
            errorMessage = "读取数据失败：\(error.localizedDescription)"
        }
    }

    // MARK: 规则增删改

    func addRule() -> SyncRule {
        let rule = SyncRule(name: "新同步", source: Location(url: URL(fileURLWithPath: "/")))
        rules.append(rule)
        selectedRuleID = rule.id
        persist()
        return rule
    }

    func update(_ rule: SyncRule) {
        guard let index = rules.firstIndex(where: { $0.id == rule.id }) else { return }
        rules[index] = rule
        persist()
    }

    func delete(_ id: UUID) {
        rules.removeAll { $0.id == id }
        if selectedRuleID == id { selectedRuleID = nil }
        persist()
    }

    private func persist() {
        do {
            try store.save(rules)
        } catch {
            errorMessage = "保存失败：\(error.localizedDescription)"
        }
    }

    // MARK: 授权

    /// 用户输入的路径若落在某个已授权目录下，返回可用的 Location；否则 nil。
    func location(forTypedPath path: String) -> Location? {
        let expanded = (path as NSString).expandingTildeInPath
        guard !expanded.isEmpty, let grant = grants.covering(expanded) else { return nil }
        return Location(url: URL(fileURLWithPath: expanded), bookmark: grant.bookmark)
    }

    /// 弹出选择框授权包含该路径的父目录，成功后返回该路径的 Location。
    func grantParent(of path: String) -> Location? {
        let expanded = (path as NSString).expandingTildeInPath
        let parent = URL(fileURLWithPath: expanded).deletingLastPathComponent()
        guard let chosen = DirectoryPicker.pick(message: "请授权包含该路径的目录", startingAt: parent) else { return nil }
        guard record(grantFor: chosen) != nil else { return nil }
        return location(forTypedPath: expanded)
    }

    /// 通过选择框选目录，生成 bookmark 并记录为授权。
    func chooseDirectory(message: String) -> Location? {
        guard let chosen = DirectoryPicker.pick(message: message) else { return nil }
        guard let grant = record(grantFor: chosen) else { return nil }
        return Location(url: chosen, bookmark: grant.bookmark)
    }

    private func record(grantFor url: URL) -> Grant? {
        do {
            let grant = Grant(path: url.path, bookmark: try BookmarkAccess.makeBookmark(for: url))
            grants.removeAll { $0.path == grant.path }
            grants.append(grant)
            try grantStore.save(grants)
            return grant
        } catch {
            errorMessage = "授权失败：\(error.localizedDescription)"
            return nil
        }
    }

    /// 已有 bookmark 但无法解析或已失效。bookmark 为 nil 表示尚未设置，不算需要重新授权。
    func needsReauthorization(_ rule: SyncRule) -> Bool {
        let locations = [rule.source] + rule.targets
        return locations.contains { location in
            guard let data = location.bookmark else { return false }
            guard let resolved = try? BookmarkAccess.resolve(data) else { return true }
            return resolved.isStale
        }
    }

    /// 源与所有目标都已通过授权设置。
    func isConfigured(_ rule: SyncRule) -> Bool {
        rule.source.bookmark != nil && !rule.targets.isEmpty && rule.targets.allSatisfy { $0.bookmark != nil }
    }

    // MARK: 同步

    func plan(_ rule: SyncRule) throws -> [PlannedAction] {
        try BookmarkAccess.withAccess(bookmarks(of: rule)) {
            try Planner().plan(rule)
        }
    }

    func execute(_ rule: SyncRule, actions: [PlannedAction], cleanBroken: Bool) throws -> SyncReport {
        let report = try BookmarkAccess.withAccess(bookmarks(of: rule)) {
            Executor().run(actions, cleanBroken: cleanBroken)
        }
        var updated = rule
        updated.lastRunAt = Date()
        update(updated)
        return report
    }

    private func bookmarks(of rule: SyncRule) -> [Data] {
        ([rule.source] + rule.targets).compactMap(\.bookmark)
    }
}
```

- [ ] **Step 2: 注入模型**

修改 `SymSync/SymSyncApp.swift` 的 `SymSyncApp`：
```swift
@main
struct SymSyncApp: App {
    @State private var model = RuleListModel(
        store: FileRuleStore(fileURL: AppPaths.rulesFile),
        grantStore: GrantStore(fileURL: AppPaths.grantsFile)
    )

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
        }
    }
}
```
并在文件顶部加 `import SymSyncCore`，删除 `.windowResizability(.contentSize)`。

- [ ] **Step 3: 编译**

Run: `make build`
Expected: `** BUILD SUCCEEDED **`（临时 ContentView 未使用模型，属正常）

- [ ] **Step 4: 提交**

```bash
git add SymSync
git commit -m "feat(app): add observable rule list model with grants and sync"
```

---

## Task 13: 界面：列表、详情、目录字段

**Files:**
- Modify: `SymSync/ContentView.swift`（替换临时验证视图）
- Create: `SymSync/SidebarView.swift`
- Create: `SymSync/RuleDetailView.swift`
- Create: `SymSync/DirectoryField.swift`

**Interfaces:**
- Consumes: Task 12 `RuleListModel`
- Produces: `RuleDetailView(rule: SyncRule)` 内含 `previewSection` 占位，Task 14 填入 `PreviewView`。

- [ ] **Step 1: ContentView**

`SymSync/ContentView.swift`（整文件替换）：
```swift
import SwiftUI
import SymSyncCore

struct ContentView: View {
    @Environment(RuleListModel.self) private var model

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            if let rule = model.rules.first(where: { $0.id == model.selectedRuleID }) {
                RuleDetailView(rule: rule)
                    .id(rule.id)
            } else {
                Text("选择或新建一条同步记录").foregroundStyle(.secondary)
            }
        }
        .frame(minWidth: 800, minHeight: 520)
        .alert("出错了", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("好") {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}
```

- [ ] **Step 2: SidebarView**

`SymSync/SidebarView.swift`：
```swift
import SwiftUI
import SymSyncCore

struct SidebarView: View {
    @Environment(RuleListModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selectedRuleID) {
            ForEach(model.rules) { rule in
                VStack(alignment: .leading, spacing: 2) {
                    Text(rule.name)
                    Text(rule.source.bookmark == nil ? "未设置源目录" : rule.source.url.path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .tag(rule.id)
                .contextMenu {
                    Button("删除", role: .destructive) { model.delete(rule.id) }
                }
            }
        }
        .navigationSplitViewColumnWidth(min: 200, ideal: 240)
        .toolbar {
            ToolbarItem {
                Button { _ = model.addRule() } label: { Label("新建", systemImage: "plus") }
            }
        }
    }
}
```

- [ ] **Step 3: DirectoryField**

`SymSync/DirectoryField.swift`：
```swift
import SwiftUI
import SymSyncCore

/// 路径文本框 + 选择按钮；输入未授权路径时提示先授权父目录。
struct DirectoryField: View {
    @Environment(RuleListModel.self) private var model
    let title: String
    @Binding var location: Location?
    @State private var text = ""
    @State private var unauthorizedPath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField(title, text: $text, prompt: Text("输入路径或点选择…"))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(commitTyped)
                Button("选择…") {
                    if let chosen = model.chooseDirectory(message: title) {
                        location = chosen
                        text = chosen.url.path
                        unauthorizedPath = nil
                    }
                }
            }
            if let path = unauthorizedPath {
                Button {
                    if let granted = model.grantParent(of: path) {
                        location = granted
                        unauthorizedPath = nil
                    }
                } label: {
                    Text("该路径未授权，点此授权父目录").font(.caption)
                }
                .buttonStyle(.link)
                .foregroundStyle(.red)
            }
        }
        .onAppear { text = location?.url.path ?? "" }
    }

    private func commitTyped() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        if let found = model.location(forTypedPath: trimmed) {
            location = found
            unauthorizedPath = nil
        } else {
            unauthorizedPath = trimmed
        }
    }
}
```

- [ ] **Step 4: RuleDetailView**

`SymSync/RuleDetailView.swift`：
```swift
import SwiftUI
import SymSyncCore

struct RuleDetailView: View {
    @Environment(RuleListModel.self) private var model
    @State private var draft: SyncRule
    @State private var sourceItems: [String] = []

    init(rule: SyncRule) {
        _draft = State(initialValue: rule)
    }

    private var syncAll: Binding<Bool> {
        Binding(
            get: { if case .all = draft.selection { return true } else { return false } },
            set: { draft.selection = $0 ? .all : .items([]) }
        )
    }

    private var sourceLocation: Binding<Location?> {
        Binding(
            get: { draft.source.bookmark == nil ? nil : draft.source },
            set: { if let new = $0 { draft.source = new; loadSourceItems() } }
        )
    }

    var body: some View {
        Form {
            Section("名称") {
                TextField("名称", text: $draft.name)
            }
            Section("源目录") {
                DirectoryField(title: "源目录", location: sourceLocation)
                Toggle("同步整个目录", isOn: syncAll)
                if !syncAll.wrappedValue {
                    itemPicker
                }
            }
            Section("目标目录") {
                ForEach(draft.targets.indices, id: \.self) { index in
                    HStack {
                        DirectoryField(
                            title: "目标 \(index + 1)",
                            location: Binding(
                                get: { draft.targets[index].bookmark == nil ? nil : draft.targets[index] },
                                set: { if let new = $0 { draft.targets[index] = new } }
                            )
                        )
                        Button(role: .destructive) {
                            draft.targets.remove(at: index)
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Button("添加目标") {
                    draft.targets.append(Location(url: URL(fileURLWithPath: "/")))
                }
            }
            Section("预览与执行") {
                previewSection
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: loadSourceItems)
        .onChange(of: draft) { _, new in model.update(new) }
    }

    /// Task 14 替换为 PreviewView。
    @ViewBuilder
    private var previewSection: some View {
        Text("待实现").foregroundStyle(.secondary)
    }

    private var itemPicker: some View {
        let selected = Binding<Set<String>>(
            get: { if case .items(let names) = draft.selection { return Set(names) } else { return [] } },
            set: { draft.selection = .items($0.sorted()) }
        )
        return VStack(alignment: .leading) {
            if sourceItems.isEmpty {
                Text("源目录为空或未设置").foregroundStyle(.secondary)
            }
            ForEach(sourceItems, id: \.self) { name in
                Toggle(
                    name,
                    isOn: Binding(
                        get: { selected.wrappedValue.contains(name) },
                        set: { on in
                            var set = selected.wrappedValue
                            if on { set.insert(name) } else { set.remove(name) }
                            selected.wrappedValue = set
                        }
                    )
                )
            }
        }
    }

    private func loadSourceItems() {
        guard let bookmark = draft.source.bookmark else {
            sourceItems = []
            return
        }
        sourceItems =
            (try? BookmarkAccess.withAccess([bookmark]) {
                try FileManager.default.contentsOfDirectory(atPath: draft.source.url.path)
                    .filter { !$0.hasPrefix(".") }
                    .sorted()
            }) ?? []
    }
}
```

- [ ] **Step 5: 编译并手动验证**

Run: `make build && open build/Build/Products/Debug/SymSync.app`
Expected: 编译成功。手动：新建记录 → 选择源目录 → 关闭"同步整个目录"看到子项列表 → 添加两个目标（一个用选择，一个先授权主目录再输入路径）→ 退出重开 App，记录仍在。

- [ ] **Step 6: 提交**

```bash
git add SymSync
git commit -m "feat(app): rule list, detail form and directory field with grant flow"
```

---

## Task 14: 预览与执行

**Files:**
- Create: `SymSync/PreviewView.swift`
- Modify: `SymSync/RuleDetailView.swift`（`previewSection` 改为 `PreviewView(rule: draft)`）

**Interfaces:**
- Consumes: Task 12 `RuleListModel.plan / execute / needsReauthorization`
- Produces: `PreviewView(rule: SyncRule)`

- [ ] **Step 1: 写 PreviewView**

`SymSync/PreviewView.swift`：
```swift
import SwiftUI
import SymSyncCore

struct PreviewView: View {
    @Environment(RuleListModel.self) private var model
    let rule: SyncRule
    @State private var rows: [Row] = []
    @State private var confirmClean = false

    struct Row: Identifiable {
        let action: PlannedAction
        var outcome: SyncReport.Outcome?
        var id: String { action.id }
    }

    private var canRun: Bool {
        model.isConfigured(rule) && !model.needsReauthorization(rule)
    }
    private var hasCreates: Bool { rows.contains { $0.action.kind == .create && $0.outcome == nil } }
    private var hasBroken: Bool { rows.contains { $0.action.kind == .brokenLink && $0.outcome == nil } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.needsReauthorization(rule) {
                Label("有目录需要重新授权，请重新选择源或目标", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
            HStack {
                Button("预览", action: preview).disabled(!canRun)
                Button("执行") { run(cleanBroken: false) }.disabled(!hasCreates)
                if hasBroken {
                    Button("清理坏链") { confirmClean = true }
                }
                Spacer()
                if let last = rule.lastRunAt {
                    Text("上次执行：\(last.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if !rows.isEmpty {
                Table(rows) {
                    TableColumn("状态") { row in statusLabel(row) }.width(110)
                    TableColumn("子项") { row in Text(row.action.itemName) }
                    TableColumn("目标目录") { row in
                        Text(row.action.target.path).lineLimit(1).truncationMode(.middle)
                    }
                }
                .frame(minHeight: 200)
            }
        }
        .confirmationDialog("删除这些坏链接？", isPresented: $confirmClean) {
            Button("删除坏链接", role: .destructive) { run(cleanBroken: true) }
        } message: {
            Text("只删除指向本源目录且源已不存在的软链接，不会删除任何真实文件。")
        }
    }

    private func preview() {
        do {
            rows = try model.plan(rule).map { Row(action: $0, outcome: nil) }
        } catch {
            model.errorMessage = "预览失败：\(error.localizedDescription)"
        }
    }

    private func run(cleanBroken: Bool) {
        do {
            let report = try model.execute(rule, actions: rows.map(\.action), cleanBroken: cleanBroken)
            rows = report.entries.map { Row(action: $0.action, outcome: $0.outcome) }
        } catch {
            model.errorMessage = "执行失败：\(error.localizedDescription)"
        }
    }

    @ViewBuilder
    private func statusLabel(_ row: Row) -> some View {
        switch (row.action.kind, row.outcome) {
        case (_, .created): Text("已创建").foregroundStyle(.green)
        case (_, .removed): Text("已删除").foregroundStyle(.green)
        case (_, .failed(let reason)): Text("失败：\(reason)").foregroundStyle(.red)
        case (.create, _): Text("将创建").foregroundStyle(.blue)
        case (.alreadyLinked, _): Text("已链接").foregroundStyle(.secondary)
        case (.conflict, _): Text("冲突").foregroundStyle(.orange)
        case (.sourceMissing, _): Text("源缺失").foregroundStyle(.orange)
        case (.brokenLink, _): Text("坏链").foregroundStyle(.red)
        }
    }
}
```

- [ ] **Step 2: 接入 RuleDetailView**

把 `RuleDetailView` 中的 `previewSection` 整体替换为：
```swift
    private var previewSection: some View {
        PreviewView(rule: draft)
    }
```
并删除其上的注释与 `@ViewBuilder`。

- [ ] **Step 3: 编译并手动验证**

Run: `make build && open build/Build/Products/Debug/SymSync.app`
Expected 手动流程：
1. 选一条记录 → 预览 → 表格列出"将创建"
2. 执行 → 变为"已创建"，Finder 里目标目录出现软链，`ls -l` 显示绝对路径
3. 再次预览 → 全部"已链接"，执行按钮禁用
4. 在目标目录手动放一个同名真实文件 → 预览显示"冲突"，执行后文件原样
5. 删除源里一个子项 → 预览出现"坏链"，点"清理坏链"→ 确认 → "已删除"

- [ ] **Step 4: 提交并开 PR**

```bash
git add SymSync
git commit -m "feat(app): preview table, execute and confirmed broken-link cleanup"
git push -u origin feat/app
gh pr create --title "feat(app): sandboxed SwiftUI app for symlink sync" --body "Tasks 10-14 of docs/plans/2026-09-02-symlink-sync-plan.md"
```

运行 `/code-review`，处理 Important 后 `gh pr merge --squash --delete-branch && git checkout main && git pull`。

---

## Task 15: 手动验证清单与文档收尾

**Files:**
- Create: `docs/manual-checks.md`
- Modify: `CLAUDE.md`（若 Task 10–14 中发现新的"Claude 会犯的错"，补进最后一节）

- [ ] **Step 1: 写清单**

`docs/manual-checks.md`：
```markdown
# 手动验证清单（每次改 App 层后跑）

- [ ] 新建记录，选择源目录，切换"整目录 / 指定子项"，子项列表正确
- [ ] 通过选择框添加目标；退出重开后记录与授权仍在
- [ ] 输入未授权路径 → 出现红色提示 → 授权主目录 → 再次输入同目录下其他路径无需再授权
- [ ] 预览 → 执行 → 目标目录出现绝对路径软链
- [ ] 二次预览全部"已链接"，执行按钮禁用
- [ ] 同名真实文件显示"冲突"，执行后文件内容不变
- [ ] 删除源子项后预览出现"坏链"，清理需二次确认，且不影响指向其他源的坏链
- [ ] 移动源目录后详情顶部出现"需要重新授权"，预览按钮禁用
- [ ] 目标目录不存在时该目标所有项显示"失败：目标目录不存在"
```

- [ ] **Step 2: 逐项执行并勾选**

Run: `make test && open build/Build/Products/Debug/SymSync.app`
Expected: `make test` 全绿 + `** BUILD SUCCEEDED **`；清单每一项通过。任一项失败按 systematic-debugging 处理：先写复现测试（Core 层）或记录复现步骤（App 层），再修。

- [ ] **Step 3: 提交**

```bash
git checkout -b docs/manual-checks
git add docs/manual-checks.md CLAUDE.md
git commit -m "docs: add manual verification checklist"
git push -u origin docs/manual-checks
gh pr create --title "docs: manual verification checklist" --body "Task 15 of docs/plans/2026-09-02-symlink-sync-plan.md"
gh pr merge --squash --delete-branch && git checkout main && git pull
```

---

## 后续（不在本计划内，各自写新的 intent）

- App Store 上架：开发者账号、`DEVELOPMENT_TEAM`、图标、隐私说明、Archive 与 TestFlight。
- 菜单栏常驻、源目录监听自动同步。
- Playbook Stage 4 evals（`CLAUDE.md` / skills 改动触发的回归）与 Stage 6 控制带。

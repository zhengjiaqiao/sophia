# Spec: SymSync 软链接同步工具

- 对应 intent：`docs/intent/2026-09-02-symlink-sync.md`
- 日期：2026-09-02
- 状态：待审阅

## 1. 目标与范围

一个 macOS SwiftUI 应用。用户定义"同步记录"（一个源目录、整目录或指定子项、一个或多个目标目录），预览并执行软链接创建。重复执行增量、冲突只报告不覆盖、坏链报告后可确认清理。记录持久化。可上架 Mac App Store。

不做：菜单栏常驻、目录监听自动同步、拖拽、双向同步、相对路径链接。

## 2. 仓库结构

```
symsync/
├── SymSync.xcodeproj          # App 壳：签名、沙盒 entitlements
├── SymSync/                   # App 源码：SwiftUI 视图、授权、调用 Core
├── SymSyncCore/               # 本地 Swift Package，App 以本地依赖引用
│   ├── Package.swift
│   ├── Sources/SymSyncCore/
│   └── Tests/SymSyncCoreTests/
├── docs/intent/  docs/specs/  docs/plans/
├── CLAUDE.md  REVIEW.md  Makefile
└── .claude/settings.json      # hooks
```

Core 不依赖 AppKit/SwiftUI，只认文件路径。App 层负责沙盒授权，把解析好的 URL 交给 Core。

## 3. 核心模型（SymSyncCore）

```swift
struct Location: Codable {
    var url: URL
    var bookmark: Data?               // App 层写入，Core 不解释
}

struct SyncRule: Codable, Identifiable {
    var id: UUID
    var name: String
    var source: Location
    var selection: Selection          // .all | .items([String])  子项名字
    var targets: [Location]
    var lastRunAt: Date?
}

enum ActionKind {
    case create        // 目标不存在，将建链
    case alreadyLinked // 已是指向正确源的软链，跳过
    case conflict      // 目标存在真实文件/目录或指向他处的软链，跳过并报告
    case sourceMissing // 指定子项在源里不存在
    case brokenLink    // 目标里指向本源目录下、但源已不存在的软链
}

struct PlannedAction {
    let kind: ActionKind
    let itemName: String
    let sourcePath: URL      // 链接应指向的绝对路径
    let targetPath: URL      // 目标目录下的链接路径
    let target: URL          // 所属目标目录
}

struct SyncReport {
    struct Entry { let action: PlannedAction; let outcome: Outcome }
    enum Outcome { case created, skipped, removed, failed(String) }
    let entries: [Entry]
}
```

## 4. 同步算法

**Planner.plan(rule) -> [PlannedAction]**，纯读，不修改文件系统。

1. 确定子项集合：`.all` 时列出源目录直接子项，跳过以 `.` 开头的隐藏项；`.items(names)` 时逐名字取，源里不存在的标 `sourceMissing`。
2. 对每个目标目录 × 每个子项，判定 `target/<name>`：
   - 不存在 → `create`
   - 是软链且解析后等于 `source/<name>`（比较标准化后的绝对路径）→ `alreadyLinked`
   - 其他任何存在的东西 → `conflict`
3. 对每个目标目录，扫描其所有直接子项中的软链：若链接目标路径以 `source/` 为前缀且该路径已不存在 → `brokenLink`。只认本 rule 的源，不碰其他坏链。

**Executor.run(actions, cleanBroken: Bool) -> SyncReport**

- `create` → `FileManager.createSymbolicLink(at:withDestinationURL:)`，目标为绝对路径。成功 `created`，异常 `failed(描述)`。
- `brokenLink` 且 `cleanBroken == true` → 删除链接本身，`removed`。
- 其余 → `skipped`。
- 逐项独立，单项失败不中断其余。

增量语义完全由 `alreadyLinked` 承担：重复执行不会重复创建。

## 5. 持久化

- `RuleStore` 协议：`load() -> [SyncRule]`、`save([SyncRule])`。
- `FileRuleStore`：JSON 文件，路径由调用方注入（App 传 `Application Support/SymSync/rules.json`，测试传临时目录）。整个数组一次读写。
- 授权过的父目录列表另存 `grants.json`：`[{path, bookmarkData}]`，与规则解耦。

## 6. 沙盒与授权（App 层）

- `com.apple.security.app-sandbox` 与 `com.apple.security.files.user-selected.read-write` 开启，bookmark 使用 `.withSecurityScope`。
- 通过 `NSOpenPanel` 选目录时，生成 bookmark 存入规则和 grants。
- 输入路径：标准化后检查是否为某个 grant 路径的子路径。是 → 用该 grant 的 bookmark 获得访问；否 → 文本框下方提示"该路径未授权，点此授权父目录"，打开定位到其父目录的 `NSOpenPanel`。
- 执行前对涉及的 bookmark 调用 `startAccessingSecurityScopedResource()`，结束后 `stop`。bookmark 解析失败或 `isStale` 时，界面标记该记录"需要重新授权"，执行按钮禁用。
- 风险：沙盒是否允许创建指向未授权路径的软链，需在工程搭好后第一时间验证。若不允许，回退方案是要求源目录也必须被授权（本设计中源目录本来就经过授权，因此预期可行）。

## 7. 界面

`NavigationSplitView`，单窗口。

- 左栏：记录列表（名称 + 源路径），底部"+"新建；右键：执行、编辑、删除。
- 右栏详情：
  1. **源**：路径文本框 + "选择…"；开关"整目录 / 指定子项"；指定子项时展示源的直接子项勾选列表。
  2. **目标**：目标目录列表，每行可删除；"添加目标"支持选择或输入。
  3. **预览与执行**："预览"跑 Planner，表格按状态着色展示每项；"执行"只处理 `create`；存在 `brokenLink` 时显示"清理坏链"按钮，点击后二次确认再删。执行完表格刷新为结果并更新 `lastRunAt`。
- 新建即右栏空表单，保存后入列表。
- 界面与 Core 之间通过一个 `@Observable` 的 `RuleListModel` 协调，持有 `RuleStore`。

## 8. 错误处理

- 源目录不存在或无法读取：预览时整条报错，不生成动作。
- 目标目录不存在：该目标下所有项 `failed("目标目录不存在")`，不自动创建目标目录。
- 建链失败（权限、只读卷）：单项 `failed`，其余继续。
- 永不删除真实文件；唯一的删除操作是清理坏链，且需用户确认。

## 9. 测试

Swift Testing，`SymSyncCore/` 下 `swift test`。每个测试在临时目录搭真实文件结构。用例：

- 全新目标：全部 `create`，执行后链接存在且指向绝对路径
- 二次执行：全部 `alreadyLinked`，无新建
- 真实文件同名 → `conflict`，执行后文件原样
- 指向他处的软链同名 → `conflict`
- `.items` 含不存在名字 → `sourceMissing`
- 隐藏文件在 `.all` 下被跳过
- 一对多：两个目标各自独立判定
- 坏链：删除源子项后重新规划出 `brokenLink`；`cleanBroken: false` 不删；`true` 删且不碰指向其他源的坏链
- 目标目录不存在 → `failed`
- `FileRuleStore` 读写往返

App 层：`xcodebuild build` 通过；手动验证清单（沙盒建链、输入路径授权流程、bookmark 失效提示）。

## 10. Playbook 落地（单人版）

| 阶段 | 做法 |
|---|---|
| Plan | `docs/intent/*.md`，提交即接受 |
| Design | 本文件，审阅通过后提交 |
| Build | `docs/plans/*.md`（Files / Order / Risks / Proof）；`CLAUDE.md` 一页内；`.claude/settings.json` hooks：编辑 Swift 文件后跑 `swift-format`，修 bug 时禁止改 `Tests/` |
| Test | `make test` = `swift test` + `xcodebuild build`；`CLAUDE.md` 含 Verifying your work 块 |
| Deploy | `REVIEW.md` 三个 pass（Bugs / Security / Compliance）；功能走分支 + PR，AI 评审后人工合并；`main` 分支保护 |
| Maintain | 新需求或缺陷写成新的 `docs/intent/*.md` 重启循环 |

## 11. 已识别的关注点

- 沙盒建链可行性（见 §6）是最大技术风险，plan 的第一步验证。
- App Store 审核可能要求说明为何需要用户选择目录的读写权限，需在 App 内提供清晰的用途说明。

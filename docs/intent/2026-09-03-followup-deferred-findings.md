# Intent: 首轮实现遗留项收口

- 状态：待评审
- 作者：jiaqiao
- 日期：2026-09-03
- 上游：`docs/plans/2026-09-02-symlink-sync-plan.md` 的逐任务评审与整分支终审

## 问题

首轮实现（PR #1–#3）的评审共留下若干非阻塞发现。终审判定不影响合并，但会在使用中显现，需要一轮收口。

## 期望结果

按优先级处理：

1. `PlannerError` 实现 `LocalizedError`，预览失败时显示中文原因而不是 `The operation couldn't be completed. (SymSyncCore.PlannerError error 0.)`。
2. `Location` 增加稳定 `id`，`RuleDetailView` 的目标列表改用 identity 而非 index 做 `ForEach`，消除删除行时的越界风险，并让 `DirectoryField` 不再依赖 `.onChange` 兜底。
3. `needsReauthorization` 比较 bookmark 解析出的 URL 与记录里的路径：目录被移动后 bookmark 仍可解析到新位置，当前会报"源不可读"而不是"需要重新授权"，`docs/manual-checks.md` 第 8 项据此不成立。
4. 清理坏链的删除前重校验目前只确认"仍是软链"，可补充"仍指向源目录之下且源仍不存在"。
5. `Executor` 补测试：`sourceMissing → skipped`、建链异常分支、混合批次的逐项独立性。
6. 文档：CLAUDE.md 的数据路径补沙盒容器前缀、hooks 依赖 `jq` 的说明；spec §2 目录树去掉已不入库的 `SymSync.xcodeproj`；spec §5 的 `bookmarkData` 与实现的 `bookmark` 键名统一。

## 不在范围内

- `normalizedPath` 对 `/private` 前缀的处理（仅影响外部创建、位于 `/private/...` 下的链接）。
- hooks 对畸形 stdin 的 fail-open（Claude Code 控制载荷格式）。
- `withAccess` 忽略 `startAccessingSecurityScopedResource` 返回 false（容器内路径本就返回 false）。
- `.items` 模式下多一次目录列举、`brokenLinks` 二次列目录等性能项。

## 约束

同上游 intent：不破坏"永不静默覆盖或删除用户数据"，Core 不引入 UI 依赖，改动走 PR。

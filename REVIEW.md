# Review instructions

## Passes
- Bugs：逻辑错误、边界条件（空目录、隐藏文件、坏链、目标目录不存在）、路径标准化不一致
- Security：沙盒外访问、未经确认的删除或覆盖、bookmark 未释放
- Compliance：改动是否符合 `docs/specs/2026-09-06-skill-sync-design.md` 与 `docs/plans/2026-09-06-skill-sync-plan.md`；core 是否引入了 tauri 依赖

## What Important means
仅用于：会破坏用户文件、绕过冲突保护、导致重复建链或崩溃的发现。

## Cap the nits
最多报告 5 条 Nit，其余只给数量。

## Do not report
`src-tauri/target/`、`dist/`、`node_modules/`、格式问题（`make format` 已处理）。

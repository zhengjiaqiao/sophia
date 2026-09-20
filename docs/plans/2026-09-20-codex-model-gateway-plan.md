---
type: plan
description: 「在 SymSync 里管理 Codex 的第三方模型」的实施计划
created: 2026-09-20
---

# 实施计划：Codex 模型网关

依据：`docs/specs/2026-09-20-codex-model-gateway-design.md`。行为参照：`/Users/jiaqiao/Project/agents-manager`（Go）。每个任务内部先写失败测试再实现；移植的测试名保留验收编号。

## 文件归属（并行时一个文件只有一个作者）

| 任务 | 文件 |
|---|---|
| T0 脚手架（主会话，先做） | 根 `Cargo.toml`、`crates/gateway/Cargo.toml`、`crates/gateway/src/lib.rs`、`crates/core/src/lib.rs`、`crates/core/Cargo.toml` |
| T1 契约验证 C6 | `crates/core/src/codex_models/config.rs` |
| T2 写入原语抽取 | `crates/core/src/atomicfile.rs`、`crates/core/src/mcp.rs` |
| T3 目录与设置 | `crates/core/src/codex_models/{catalog,settings,mod}.rs`、`crates/core/src/store.rs` |
| T4 协议转换 | `crates/gateway/src/translate/*` |
| T5 路由 | `crates/gateway/src/router/*` |
| T6 平台件 | `crates/gateway/src/{sysproxy,service,keychain,provider,takeover}.rs` |
| T7 编排 | `crates/gateway/src/app.rs` |
| T8 无界面模式与命令层 | `src-tauri/src/{main,lib,gateway}.rs`、`src-tauri/Cargo.toml` |
| T9 页面 | `src/{ModelsTab.tsx,modelsView.ts,api.ts,types.ts,App.tsx,App.css}`、`tests/models-view.test.ts` |
| T10 文档与 CI | `docs/manual-checks.md`、`.github/workflows/ci.yml`、`CLAUDE.md`、`Makefile` |

## 顺序

1. **T0 + T1**：脚手架；用测试确认 `toml_edit` 增删根键的逐字节保持（C6），不成立则改文本级手术。
2. **最小端到端路径（C4 差异项、C5、C7）**：T5 的最小子集（官方透传、426、健康检查、无请求体 GET）+ T8 的无界面模式 → launchd 在隔离目录拉起 → 真实 Codex 用运行时参数经它访问官方模型。随后 T4 + T5 的第三方路径 → 真实 Codex 访问一个 wecode 模型并完成一次读文件（AC4、AC6）。**这条路不通就回到 spec。**
3. T2、T3、T6 可并行（文件互不重叠），随后 T7。
4. T8 命令层、T9 页面。
5. 隔离目录完整演练：启用、端口占用、强杀自愈、恢复逐字节一致、与 MCP 先后写入（AC15、AC16、AC20、AC26）。
6. 本机接管（AC22，只做一次）与桌面应用真实验证（AC3–AC7、AC11–AC13）。
7. T10；`make test` 全绿；按 `sdlc-verifying-done` 回填验证记录。不自行合并，交给「软链接同步」会话。

## 需要作者参与

- 接管会重启一次 Codex 桌面应用。
- AC14 需要重启电脑。

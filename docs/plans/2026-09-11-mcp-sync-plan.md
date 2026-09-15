# MCP 同步实施计划

> 状态：MCP 手动引入、自动引入和 WeiboAP 项目 adapter 已实现；自动化通过，自动规则的 macOS 原生窗口操作仍待复验。

## 目标

让 MCP 页面沿用 Skills 的域视图和引入心智模型：默认按域展示本域已有服务，单域引入外域服务到本域目标；只新增、不覆盖、不删除，并与 skill 软链同步隔离。

## 已落地契约

- crates/core/src/mcp.rs：locations、scan、prepare、execute；DTO 为 McpLocation、McpEntry、McpCell、McpIssue、McpOverview、McpSelection、McpAction、PreparedPlan、McpReport。
- src/types.ts：上述 Rust DTO 的 camelCase 对应类型。
- src-tauri/src/lib.rs / src/api.ts：scan_mcp、propose_mcp_sync、apply_mcp，以及 MCP 自动规则的查询、保存、移除；手动计划通过 plan_id 缓存并一次性消费。
- 原范围支持 Claude Code、Codex、Cursor；配置格式为 JSON/TOML 对应位置；传输仅 stdio/http。Claude Code 文件配置为 User `~/.claude.json.mcpServers`、Local `~/.claude.json.projects[绝对项目路径].mcpServers`、Project `<project>/.mcp.json`，优先级 Local > Project > User；运行时 `claude.ai` 内置 MCP 不在扫描范围。WeiboAP 为额外的 macOS 本地项目/agent adapter，不扩展为第四种全局/项目通用配置。

## UI 实施与验收

1. 域列表：对齐 Skills 的全局、项目和全部选择。默认行只取本域已有服务；同域同名始终一行，各 harness 保留已有/连接等价/同一服务（端点一致）/配置差异/缺失/明确异常事实；只有没有定义才显示缺失，解析或结构异常要显示明确诊断；外域未引入服务不混入默认行。
2. 引入弹层：单域页提供三栏“来源 / 本域未引入服务 / 本域目标”；全部页禁用。以本域任一 own/equal/sameEndpoint 判已引入，剩余目标允许继续补齐；来源不同必须明确选择，歧义时禁用补缺。
2a. 状态与入口：sameEndpoint 显示“同一服务（端点一致）”，表示可解析 HTTP 定义的字面 URL 相同，但 Claude headers 与 Codex http_headers_helper 等动态请求头的等价仍待核对；它表示本地已配置，不等于 equal。缺失目标格可直接点击/勾选发起单目标预览，沿用备份、只新增和跨域确认。唯一安全来源可用时不被同一端点但动态请求头副本连带阻断，多个非等价可迁移来源必须显式选源。
3. 执行链路：复用预览、跨域逐次勾选、备份和 prepare/execute 只新增语义；刷新后目标定义成为本域来源。冲突、过期计划、外部修改、备份失败均可见且不覆盖。
4. 自动引入：参照 Skills 为明确来源和目标保存规则，扫描时只补真正缺失且可安全迁移的定义；跨域规则明确确认，重复扫描幂等，冲突或异常不覆盖。
5. 边界检查：没有逐条导入登记表、删除或任意文件安装；secret 不展示或写入 DTO/日志/规则/报告。

## 验证基线

本轮已通过 Rust core 112 项；make test、cargo check --workspace、前端构建和 git diff --check 全部通过。隔离测试覆盖自动首次补齐、重复扫描幂等、来源后续新增、位置失效、跨域授权和 WeiboAP agent 身份隔离。原有 macOS 原生隔离 fixture QA 已覆盖 WeiboAP 项目发现、域隔离、跨 agent 写入、备份与 pgEnabled guard，以及原三工具 UI 主流程；自动规则的原生窗口操作仍待复验。验收不覆盖实际 MCP 启动/运行时启用、真实用户配置、Windows/Linux、自定义 override 原生 UI、SSE 专项 UI 和失败备份模拟；快照校验检测到外部修改即拒绝写入，但校验到原子 rename 之间存在竞态，不承诺绝对 CAS。

## WeiboAP adapter 已完成

1. 已读取每个 Data/agents/<agent.id> 目录并建立独立 project:<normalized> 域；即使没有 skill 目录也发现，UI 展示项目/agent 身份，按 agents.db、agent id、server name 隔离。
2. 已对本地 SQLite agents.db 的目标 agent 事务补齐 agents.mcp_config 缺失项，不改 mcps 或其他列；结果提示 WeiboAP 的启用/重开会话。
3. 已验证 WAL 安全的 SQLite online backup、权限保持、source/target 行与 local-mode guard 重验；活动库不裸 copy+rename。
4. 已实现 userData/config.json 的 pgEnabled 与 pgEnabled_* guard；有效默认值、绝对字符串或唯一精确 exe 匹配数组支持，无效、相对、歧义或无法定位的 portable 路径返回 unsupported 并拒绝。
5. 不读写 Electron localStorage persist:cherry-studio 的全局 mcp.servers，不写 global profile/LevelDB。

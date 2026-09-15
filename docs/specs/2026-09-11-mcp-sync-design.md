# Spec：SymSync MCP 定义同步

- 对应 intent：docs/intent/2026-09-11-mcp-sync.md
- 状态：自动引入规则与既有手动引入已实现；自动化验收通过，自动规则的 macOS 原生窗口复验未完成
- 日期：2026-09-11

## 范围与位置

原范围支持 Claude Code、Codex、Cursor 的全局位置和已登记项目位置。Claude Code 的文件配置位置为 User `~/.claude.json.mcpServers`、Local `~/.claude.json.projects[绝对项目路径].mcpServers`、Project `<project>/.mcp.json`，优先级为 Local > Project > User；运行时 `claude.ai` 内置 MCP 不在范围内。WeiboAP 是额外的项目/agent adapter，只支持 macOS 本地项目域，不等同于第四种全局/项目通用配置。core 通过 mcp::locations(env, harnesses, projects) 生成 `McpLocation { id, label, harness_id, domain, path, selector, matrix_hidden }`，其中 Claude Local 用 `selector` 保存精确的绝对项目 key；Claude Local 缺失或空的 `mcpServers` 位置标为 `matrix_hidden`，普通矩阵隐藏但在“引入…”中显示“将写入 Claude Local 配置”且默认不勾选；Local 含有定义时保持可见。Claude Project 位置始终保留，仅在 Local 含有定义且 `.mcp.json` 缺失时以 `matrix_hidden` 标记，隐藏于普通矩阵但保留为“引入…”的显式创建目标。全局域为 global，项目域为 project:<normalized path>。其他配置位置分别为 Codex $CODEX_HOME/config.toml（回退 ~/.codex/config.toml）/项目 .codex/config.toml、Cursor ~/.cursor/mcp.json/项目 .cursor/mcp.json。

配置根字段为 JSON 的 mcpServers 或 TOML 的 mcp_servers。可迁移字段是 stdio 的 command、args、env，以及 HTTP 的 url、headers；Codex HTTP 使用 http_headers。MCP 传输只接受 stdio 与 http。

## 页面与域列表

MCP 页面与 Skills 页共享域选择。当前域默认列表只包含本域已有服务；全部页将服务按域分组，不能把外域未引入的服务伪装成当前域行。同域同名服务始终只显示一行；每个 harness 单元格保留已有、连接等价、同一服务（端点一致）、配置差异、缺失或明确异常事实，不以来源副本拆分行。表格状态使用 McpCellState：own、equal、sameEndpoint、missing、conflict、invalid、unsupported。`own`、`equal`、`sameEndpoint` 的矩阵主显示统一为 `● 已配置`，具体状态、来源和诊断放入 tooltip；`conflict`、`invalid`、`unsupported`、`missing` 分别显示各自状态。仅 unsupported-only 显示“格式不支持”，仅 invalid-only 显示“配置无效”。这些状态不等同于 missing。连接归一字段与客户端专属选项分开比较和展示。

“引入…”只在单域页可用，在全部页禁用。弹层三栏固定为：来源位置、当前域未引入的服务、当前域目标位置。来源可以是外域位置；目标只允许当前域位置。Claude Local 缺失或空配置的 `matrix_hidden` 目标在引入弹层显示“将写入 Claude Local 配置”并默认不勾选；Local 含有定义时不隐藏。Claude Project 的 `matrix_hidden` 目标仅在 Local 含有定义且 `.mcp.json` 缺失时出现，显示“将创建 .mcp.json”并默认不勾选；两类目标都不参与普通矩阵或批量补缺。某服务在当前域任一位置为 own、equal 或 sameEndpoint 即标记为已引入；其余当前域目标仍显示缺失，可继续补齐。来源不同不能默认采用第一来源；用户必须明确来源，存在歧义时禁用行级批量补缺。配置差异不算已引入，也不触发覆盖。已知 Codex enabled 等客户端启用选项不改变连接一致性。对于可解析的 HTTP 定义，仅比较字面 URL 来确认端点身份：URL 相同且至少一侧使用动态请求头时为 sameEndpoint，tooltip 显示“同一服务（端点一致）”，矩阵主显示为 `● 已配置`，但不宣称完整连接 equal，认证和请求头等价仍未证明；URL 不同仍为 conflict。静态请求头名称按 ASCII 大小写不敏感归一，值逐字比较；折叠后出现重名仍为 unsupported。其他未知字段、非法类型或不可安全转换仍为 unsupported/invalid。connection_eq 不含 client 字段，但 Canonical 完整保留它们；当前支持的客户端设置仅为 enabled、startup_timeout_sec、tool_timeout_sec。同工具 Codex 新增可无损保留这些设置，跨 harness 新增带客户端设置则按字段拒绝。目标已有连接相同也不改任何配置；客户端设置单独保留，不通过当前 DTO 展示。

`sameEndpoint` 只针对 Claude 静态 `headers` 与 Codex `http_headers_helper` 等动态请求头并存的情况：它确认字面 URL 相同和目标已配置，但请求头等价仍待核对；不得执行 helper、读取凭据或把它判为 `equal`。真正缺失的目标格支持像 Skills 一样直接点击或勾选，发起只针对该目标的 MCP 预览；仍需来源明确、备份、只新增和跨域确认。一个唯一安全可迁移来源可用时，不因另一个同一端点但动态请求头副本而连带阻断；多个非等价且可迁移的来源点击缺失格后进入“引入…”显式选源，默认只选被点击的目标，行级批量补缺保持禁用。

## Rust core 与 Tauri 契约

契约以 crates/core/src/mcp.rs 和 src/types.ts 为准，不使用候选接口名：

- mcp::scan(&[McpLocation]) -> McpOverview 返回 locations、entries、issues。每个 McpEntry 包含 source_id、name、transport、可选 reason 和各目标 cells。
- mcp::prepare(&[McpLocation], &[McpSelection]) -> PreparedPlan 返回 actions 与 issues，计划内部保留来源快照和目标快照。
- mcp::execute(PreparedPlan, allow_cross_domain) -> McpReport 只执行新增。McpAction 含来源/目标 id、名称、路径和 cross_domain；McpReportEntry 返回 created 或 failed、消息及可选 backup_path。预览阶段的已一致定义、冲突和其他跳过项放在 PreparedPlan/预览 issues 中，不作为 execute outcome。
- 手动引入的 Tauri 命令是 scan_mcp、propose_mcp_sync、apply_mcp；计划由 plan_id 一次性消费，过期或未知 id 必须重新预览。自动引入规则使用 list_mcp_auto_imports、set_mcp_auto_import、remove_mcp_auto_import。TypeScript 使用对应的 McpOverview、McpSelection、McpPreview、McpReport 和规则 DTO。

扫描/比较使用完整规范化定义（包括敏感值），但敏感值不出现在任何 DTO。只有目标没有定义时才是 missing；解析失败、重复 JSON 键、软链接配置、未知字段、非法类型或无法安全解释的引用必须显示明确的 invalid/unsupported 等异常状态，不得降级为缺失。

## 引入与写入规则

预览前用户逐次勾选来源服务和当前域目标。prepare 对目标已有一致定义返回 issue“目标已有一致定义”，对同名不同定义返回冲突 issue；两者都不产生覆盖动作。同一目标选择不同定义的多个来源也必须报 issue。

预览展示新增动作、跳过原因和目标路径。若存在跨域动作，跨域允许复选框默认不勾；未勾选时 execute 对该组报告失败且不写入。执行前重校验来源/目标快照；检测到外部修改、备份失败或原子写失败即报告失败并拒绝该次写入。快照校验与原子 rename 之间仍存在文件系统竞态，契约不承诺对非合作外部进程提供绝对 CAS；缺失文件可直接创建。既有目标配置先完整备份，备份权限不放宽，结果显示备份路径且不自动清理。

## 自动引入规则

参照 Skills 的自动同步，用户可以在“引入…”里为一个明确的来源位置和当前域的明确目标位置建立持久规则。规则只保存来源和目标的位置身份，不保存 MCP 定义或凭据；新增目标位置不会自动加入既有规则。规则可在域页查看和关闭。开启规则时说明：当前及以后新增、可安全迁移的 MCP 定义会写入所选目标，定义中的认证字段可能随之复制。跨域规则须在开启时明确授权，授权只属于该条规则；手动引入仍逐次确认跨域。修改目标或跨域范围应重新确认。

每次 MCP 扫描先按当前配置读取来源和目标，规则仅选取来源中有完整、可迁移定义而目标同名真正缺失的服务。多个来源对同一个目标和名称给出不同定义时，不能任意选择；已有定义、连接等价、同端点、冲突、解析异常及不支持格式均不覆盖。自动动作沿用 prepare/execute 的重验快照、完整备份、只新增及 WeiboAP 写入保护；一轮扫描至多执行一次自动计划，之后重扫以返回实际状态。新建规则和配置文件变动可触发扫描；应用关闭期间不运行后台守护进程。没有自动规则时，扫描保持只读。

## 验收标准

- 域列表与 Skills 页一致：全局、每个已登记项目分别可选；全部页分域，默认行没有外域未引入服务。
- 同域同名只显示一行，各 harness 保留已有/连接等价/同一服务（端点一致）/配置差异/缺失/明确异常事实；不因来源不同拆行。
- 单域“引入…”三栏显示来源、本域未引入服务、本域目标；全部页按钮禁用。
- 引入后刷新，目标定义成为本域真实来源；本域任一 own/equal/sameEndpoint 标为已引入，剩余目标可继续补齐；来源歧义时必须明确来源或禁用动作。
- 预览、跨域逐次勾选、备份、只新增执行链路可审阅；同名冲突永不覆盖。
- 自动规则绑定明确的来源和目标、可关闭；缺失才补、重复扫描幂等、歧义不擅选，跨域规则须明确授权；无规则时扫描只读。
- 无导入登记表、删除或任意文件安装；MCP 仅接受 stdio/http；不扫描 Claude Code 的 `claude.ai` 运行时内置 MCP。
- secret 不出现在 DTO、UI、日志和报告；解析/安全问题不冒充缺失。
- WeiboAP adapter 仅支持 Data/agents/<agent.id> 的本地 project/agent 域；不把其共享 agents.db 当作 .mcp.json，也不扩展 WeiboAP 全局 localStorage MCP。
- WeiboAP 的 pgEnabled guard、WAL online backup、事务内只补 agents.mcp_config 及 agent 身份隔离均有对应自动化和手动 QA 项；adapter 已实现，部分 macOS fixture QA 已完成。

## 本轮验收证据与限制

隔离的 macOS Debug 应用和临时 fixture 已验证：同域同名一行并保留各 harness 事实，空项目域不混入外域服务；单域三栏来源/未引入服务/本域目标；跨域默认禁用并逐次确认；首次引入后刷新成为本域来源，剩余目标可补齐；已有目标写入显示备份路径；全无目标缺失时引入选择禁用；全部按 global、project-a、project-b 分组且引入禁用；预览弹层的焦点循环和 Escape 取消也已验证。

本轮自动化通过 Rust core 112 项、make test、cargo check --workspace 与 git diff --check；隔离测试覆盖自动首次补齐、重复扫描幂等与来源后续新增。自动规则的 macOS 原生窗口操作未完成复验；sameEndpoint 文案、tooltip，以及 Claude Local/Project 隐藏规则的原生专项复验仍未完成。快照校验检测到外部修改即拒绝写入，但校验到原子 rename 之间仍存在竞态。

## WeiboAP 项目/agent adapter

WeiboAP 的 Data/agents 下每个目录就是一个项目；每个目录对应一个 agent.id，domain key 为 project:<normalized path>。即使没有 skill 目录也必须发现。多个 agent 不混合：身份至少由共享 agents.db 路径、agent id、server name 共同确定，UI 必须展示项目/agent 身份。

WeiboAP 目标是共享本地 SQLite agents.db 中该 agent 的 agents.mcp_config。事务只补缺失定义，不修改 mcps 或其他列；写入后需用户在 WeiboAP 内启用 MCP，已有会话可能需要重开。WeiboAP schema 的传输含 stdio、http、sse，但 SymSync 只接受 stdio/http，sse 为 unsupported。

当 agent 的 `mcp_config` 为空时，项目域和 WeiboAP 目标位置仍保留，但该域的项目矩阵不产生服务行；空状态应明确提示没有可读取的 MCP 定义。`agents.mcps` 可能只保存启用名称，不能作为完整 MCP 定义或推导端点、传输和认证字段。用户可从其他可见位置通过“引入…”选择完整定义，经过跨域确认后写入该 agent。当前本机脱敏只读观察为 4 个 agent 项目均无非空 `mcp_config`，其中 2 个的 `mcps` 非空；真实全局 LevelDB 定义未确认，仍不在当前同步范围。

活动数据库可能使用 WAL，写入必须使用 SQLite online backup，并保持原文件权限；禁止裸 copy+rename 活动数据库。执行前重验 source/target row 及 local-mode guard。userData/config.json 的 pgEnabled 必须显式为 false，pgEnabled_* 不得为 true 或非法；appDataPath 仅接受有效默认值、绝对字符串或唯一精确 exe 匹配数组，无效、相对、歧义或无法定位的 portable 路径均标记 unsupported 并拒绝写入。

WeiboAP 全局 MCP 位于 Electron localStorage 的 persist:cherry-studio 根 mcp.servers；本轮不读写全局 profile 或 LevelDB，范围仅 project/agent。

## WeiboAP macOS fixture 验收

使用隔离 fixture 验证：无 skills 的多个 agent 均发现，空 agent 不混入外域服务；外部完整定义可写入一个 agent，随后同库另一 agent 也可独立写入；每次跨域预览默认 false 且写入禁用，目标显示项目/agent 身份与共享数据库归属。Python 只读 immutable 校验确认数据库和备份 integrity 正常、备份对应写前状态、`mcps` 与其他列保持不变；pgEnabled=true 时项目均拒绝读取/写入。

未覆盖实际 MCP 启动/运行时启用、真实用户配置、Windows/Linux、自定义 override 原生 UI、SSE 专项 UI 和失败备份模拟。

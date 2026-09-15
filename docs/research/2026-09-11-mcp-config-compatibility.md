# MCP 配置兼容性研究

日期：2026-09-11

范围：核对 Claude Code、Cursor、Codex 的官方 MCP 配置位置、格式、传输字段和环境变量语义。本文只依据官方文档；没有读取本机真实配置或凭据，也没有验证特定客户端版本的实际解析行为。

## 官方核实项

| Harness | 全局配置 | 项目配置 | 格式与根结构 | 官方列出的传输 |
|---|---|---|---|---|
| Claude Code | User：`~/.claude.json.mcpServers`；Local：`~/.claude.json.projects[绝对项目路径].mcpServers` | Project：项目根 `<project>/.mcp.json` | JSON，`{"mcpServers": {...}}`；优先级 Local > Project > User | `stdio`、`http`/`streamable-http`、`sse`、`ws` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` | JSON，`{"mcpServers": {...}}` | `stdio`、SSE、Streamable HTTP |
| Codex | `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`） | `.codex/config.toml`（受信项目） | TOML，`[mcp_servers.<name>]` | STDIO、Streamable HTTP |

官方来源：

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)：scope、`.mcp.json`、`~/.claude.json`、服务器字段和变量展开。
- [Cursor MCP](https://cursor.com/docs/mcp)：全局/项目路径、stdio/远程字段和变量插值。
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：`config.toml` 路径、项目作用域、STDIO/HTTP 字段和变量转发。
- [Codex 环境变量](https://learn.chatgpt.com/zh-Hans/docs/config-file/environment-variables)：`CODEX_HOME` 的默认值、覆盖范围和目录存在要求。

三者可抽象出有限的公共连接字段：服务器名、`command`、`args[]`、`env`、`url`、认证/普通 headers。这个抽象是本项目用于受限比较的交集，不是三者共同遵循的官方统一 schema；各客户端仍有不同根结构、字段名、认证模式和运行时语义，因此不能仅凭配置形状推出完整配置或认证等价。

### Claude Code

- Claude Code 的文件配置有三个作用域：User 是 `~/.claude.json` 根 `mcpServers`，Local 是同一文件 `projects[绝对项目路径].mcpServers`，Project 是项目根 `<project>/.mcp.json`；优先级为 Local > Project > User。SymSync 扫描这三类文件位置并按位置保留事实；`claude.ai` 运行时内置 MCP 不属于文件配置范围。
- Project `<project>/.mcp.json` 位置始终保留；仅当 Local 含有定义而 Project 文件缺失时，SymSync 以 `matrixHidden` 标记该位置，使其从普通矩阵和批量补缺中隐藏，但在“引入…”中作为默认不勾选的“将创建 .mcp.json”目标保留。
- stdio 使用 `command`、可选 `args`、`env`；远程 HTTP/SSE 使用 `url` 与 `headers`。JSON 中 `type: "streamable-http"` 是 `http` 的别名；只有 `url` 没有 `type` 会被按 stdio 解释并报配置错误。
- 项目 `.mcp.json` 的服务器会触发批准/信任语义；这是 Claude Code 行为的一部分，不能当作通用 MCP 字段。

### Cursor

- 项目配置为 `.cursor/mcp.json`，全局配置为 `~/.cursor/mcp.json`。
- stdio 文档字段：`type: "stdio"`（必需）、`command`（必需）、`args`、`env`、`envFile`。`envFile` 只适用于 stdio，远程 HTTP/SSE 不支持。
- 远程示例使用 `url` 与 `headers`；静态 OAuth 使用 `auth` 对象。Cursor 文档中的远程示例没有明确要求 `type` 字段。

### Codex

- 默认配置为 `$CODEX_HOME/config.toml`（`CODEX_HOME` 未设置时为 `~/.codex/config.toml`），也支持受信项目的 `.codex/config.toml`；桌面应用、CLI 和 IDE 扩展共享该配置。官方环境变量文档还说明，设置 `CODEX_HOME` 时目标目录必须预先存在。
- 每个服务器是 `[mcp_servers.<name>]` 表。STDIO 字段为 `command`、`args`、`env`、`env_vars`、`cwd` 等；Streamable HTTP 字段为 `url`、`http_headers`、`env_http_headers`、`bearer_token_env_var` 等。
- Codex 文档没有列出 SSE 或 WS 传输。HTTP 认证、OAuth、工具筛选、审批和超时字段属于 Codex 专属配置。

## 有限兼容性与转换边界

### 可以作为候选公共配置比较的字段

仅对下列规范化字段做同名判断是合理的：

```text
server name
stdio: command, args, env
streamable HTTP: url, headers（转换为目标工具对应的 header 字段）
```

同域同名服务器应固定为一行，并按 harness 单元格分别保留事实。矩阵主显示将 `own`、`equal`、`sameEndpoint` 统一为 `● 已配置`，具体状态、来源和诊断放入 tooltip；`conflict`、`invalid`、`unsupported`、`missing` 分别显示各自状态。连接归一只比较 command、args、env、url、headers 等连接字段；客户端选项、认证模式和其他专属字段单独保留，不能因连接相同就判定完整配置等价。本轮端点身份只做有界的字面 URL 比较：可解析的 HTTP 定义 URL 逐字相同即确认同一端点；若一侧使用 `http_headers_helper` 等动态请求头，则状态为 `sameEndpoint`（tooltip 显示“同一服务（端点一致）”），目标仍视为已有配置，但不等于 `equal`，认证和请求头等价仍未证明。静态请求头名称按 ASCII 大小写不敏感归一，值逐字比较；折叠后出现重名仍报告 `unsupported`。URL 不同报告差异；其他未知字段、非法类型或不可安全转换仍报告 `unsupported`/`invalid`，不降级成缺失。

### 必须保留且拒绝无损映射的字段

未知字段和客户端专属字段不得在同步时静默丢弃。单纯在结果中标记而丢弃原始值不能视为成功：如果目标工具无法无损映射该字段，应拒绝该服务器项，并保留源配置/原始字段供用户处理。只有用户明确选择忽略且该行为被记录时，才可继续处理其他项。

- Claude 的 `type`、SSE/WS、`oauth`、`headersHelper`、`alwaysLoad` 以及项目批准/禁用设置。
- Cursor 的 `envFile`、`auth`、固定 OAuth 回调设置。
- Codex 的 `env_vars`（尤其 `source = "remote"`）、`cwd`、`experimental_environment`、`http_headers`/`env_http_headers`、OAuth、工具 allow/deny、审批和超时。

SSE 或 WS 服务器不能直接转换为 Codex 的 Streamable HTTP；只有确认服务端同时提供兼容端点时才可人工改写。OAuth 客户端 ID、secret、回调 URL 和登录状态也不能跨工具原样迁移。

完整等价判定不能只比较公共字段：未知字段、专属字段、认证方式和作用域差异都必须产生 `conflict`、`unsupported` 或 `sameEndpoint`，而不是判定为相同。敏感值（例如 token、secret）可以在后台参与规范化比较，但不得发送到前端或写入普通诊断输出；前端只显示脱敏后的差异类别。本轮不执行动态 helper，也不据此宣称它与静态 Authorization/headers 值一致。

## 环境变量引用语义

| Harness | 文档化语法 | 文档化位置与语义 |
|---|---|---|
| Claude Code | `${VAR}`、`${VAR:-default}` | 可出现在 `command`、`args`、`env`、`url`、`headers`；当前文档描述缺少变量时发出警告并保留未展开文本。 |
| Cursor | `${env:NAME}`、`${userHome}`、`${workspaceFolder}`、`${workspaceFolderBasename}`、`${pathSeparator}`/`${/}` | 可用于 `command`、`args`、`env`、`url`、`headers`；`envFile` 另有 stdio 专属语义。 |
| Codex | 未文档化 `${...}` 插值 | `env` 设置服务器环境值；`env_vars` 按名称从 local 或 remote 执行环境允许并转发。 |

因此环境变量引用不能原样跨工具复制。同步器应解析或保留源语法并给出转换提示；不能把 Claude 的 `${VAR}`、Cursor 的 `${env:VAR}` 或 Codex 的 `env_vars` 当作等价字符串。

## 未核实项

- 三个官方页面都没有明确声明 JSONC 支持。Cursor 示例代码包含 `//` 注释，但这不足以证明解析器接受 JSONC；实现时应按 JSON 处理，除非通过具体版本实测确认。
- 未核实旧版客户端的路径、字段别名和缺失变量行为；以上结论以 2026-09-11 访问到的官方页面为准。
- 未核实目标 MCP 服务是否同时支持 SSE、Streamable HTTP 或多种认证方式；不能仅凭配置形状推断服务端兼容。
- `CODEX_HOME` 的覆盖已由官方 Codex 环境变量文档核实：它覆盖 Codex 状态根目录，默认值为 `~/.codex`，因此用户级 MCP 配置应解析为 `$CODEX_HOME/config.toml`。Claude Code 和 Cursor 是否有等价的 MCP 配置根目录覆盖变量，本次未在相应 MCP 官方页面核实。

## 实现建议

第一版可把“服务器连接核心”作为候选同步范围：`name`、stdio 的 `command`/`args`/`env`、Streamable HTTP 的 `url`/headers。所有其他字段必须保留源值；目标无法无损映射时拒绝该服务器项并报告 `unsupported`。同名比较必须基于规范化公共字段，但公共字段相同不能掩盖未知字段差异；未知差异应报告 `conflict`。

## 本次来源读取确认

是。Claude Code、Cursor、Codex 三个官方 MCP 页面均已实际打开并读取相关段落；`CODEX_HOME` 另读取了官方 Codex 环境变量页面。来源链接见上文。

## add-mcp 对照

本节只记录官方仓库公开文档对本项目边界有影响的行为，不复用或复制其源码。仓库许可证为 Apache-2.0；本项目旧 intent 对借用代码有 MIT 限制，因此这里只作为行为参考。

- **三工具的配置适配路径与本研究一致**：`add-mcp` 的支持表列出 Claude Code 的 `~/.claude.json` / `.mcp.json`、Codex 的 `~/.codex/config.toml` / `.codex/config.toml`、Cursor 的 `~/.cursor/mcp.json` / `.cursor/mcp.json`。它也明确区分全局 `-g` 与项目默认范围；SymSync 的来源/目标扫描应继续保持这两个域的区分。
- **其 `sync` 身份模型不能直接套用**：官方文档说明 `add-mcp sync` 按 URL 或 package name 分组，并统一成最短 server name；同一组出现 headers、env 或 args 冲突时跳过并警告。SymSync 需要保留“来源文件 + 名称”的独立条目，并把同名不同定义显示为冲突，不能按 URL 任意合并或重命名。
- **能力差异不能默默丢字段**：`add-mcp` 会按目标 agent 能力映射字段，不支持的可选字段会从该目标配置丢弃并发出警告。SymSync 的无损要求更严格：三工具间无法保留的字段（例如 Codex 专属 `env_vars`、Cursor `envFile` 或 OAuth 设置）应拒绝该条目并报告 `unsupported`，不能照搬“丢弃后继续”。
- **环境变量和认证语义必须单独判定**：官方文档允许 `${VAR}` 占位符，并对必填/可选值采用交互式输入或占位行为；`add-mcp` 还把 bearer token 环境变量和 Authorization header 做了能力相关转换。SymSync 不应展开或重写不同 harness 的变量语法，也不能因公共字段形状相同就把认证定义判为一致；无法证明目标语义等价时应冲突或拒绝。
- **项目配置可能有客户端前置条件**：官方文档提示 Claude Code 可能需要重启、Cursor 可能需要在 MCP 设置中启用；其他客户端还可能要求项目受信后才加载项目配置。手动补缺的验收应把“文件已写入”和“客户端已加载”分开，不把写入成功误报成运行时已生效。

官方对照来源：[add-mcp 官方仓库 README](https://github.com/neon-solutions/add-mcp)、[add-mcp agent 配置适配实现](https://github.com/neon-solutions/add-mcp/blob/main/src/agents.ts)。

### 可直接采用的测试边界

- **身份不误合并**：同一 URL 或 package 的不同来源名称仍各自成行；测试不能把 `add-mcp sync` 的 URL/package 分组规则引入 SymSync 的来源身份。
- **冲突不写入**：同名条目的 `args`、`env` 或 headers 任一不同，都应生成冲突且目标字节保持不变；对应 add-mcp 的 sync 行为是跳过并警告。
- **能力差异拒绝迁移**：遇到某目标不支持的字段，测试应断言动作被拒绝、目标文件不变，并保留源条目；不能接受“丢字段后成功”的结果。
- **变量与认证不展开**：`${VAR}`、`${env:VAR}`、Authorization header 和 bearer-token 引用应作为敏感/语义边界测试；跨域未确认时不得写入，UI 和日志不得出现值。
- **写入成功不等于客户端生效**：项目配置受信、客户端重启或 reload 等前置条件应作为提示/验收边界，测试只把“文件写入及备份成功”判为 SymSync 的写入成功。

当前研究与草案已覆盖原三工具的产品约束；同名单行、来源歧义与连接/客户端选项分离仍需专项 QA，避免只测返回状态而漏测事实保持与诊断。

## 本轮脱敏只读发现（待 QA）

本机真实发现仅做脱敏只读观察，不写真实配置、不执行 helper。真实项目的 comments 与 miniapp 在 Claude/Codex 中同名且 HTTP URL 逐字相同，但 Claude 使用静态 `headers`/Authorization，Codex 使用 `http_headers_helper`；这足以确认同一端点身份，应在 tooltip 显示 `sameEndpoint`（“同一服务（端点一致）”，矩阵主显示为“● 已配置”），不足以宣称完整连接 `equal`，认证和请求头等价仍未证明。引入弹层对已配置来源显示“已配置（详细原因）”，来源位置可省略显示但完整路径必须保留在 tooltip。不同 URL 仍为配置差异；其他非法或未知字段仍为 unsupported/invalid。此前 fixture 已观察到三行 search 连接一致，以及 search 到 Cursor 补齐成功且无覆盖；comments 显式选源后仅向 Cursor 补齐成功，search 全目标已有时禁用。新 sameEndpoint 状态已有自动化测试；本次隔离 Debug App 启动成功，但窗口 AX 两次超时且截图未显示 QA 窗口，因此未取得新文案、tooltip 或复选框的原生视觉证据。1100×720 的既有布局复测通过：三 harness 列完整无溢出，每格保留主状态显示与 tooltip 详情。连接归一与客户端选项必须分开，动态请求头字段只影响请求头等价层级。

实现政策：connection_eq 不含 client 字段，Canonical 仍完整保存 client；当前支持的客户端设置仅为 enabled、startup_timeout_sec、tool_timeout_sec。Codex 同工具新增可无损保留这些设置；跨 harness 新增若带客户端设置则按字段拒绝并列出原因；目标已有连接相同也不修改配置，客户端设置单独保留，不通过当前 DTO 展示。`sameEndpoint` 只由可解析 HTTP 定义的逐字相同 URL 和动态请求头标记触发；`http_headers_helper` 不执行、不读取凭据、不假装 equal。

## WeiboAP 静态证据（2026-09-14）

本节只记录从本机 WeiboAP 安装包提取到的静态证据，未读取用户真实配置、数据库或凭据。证据目录：/private/tmp/weiboap-static-evidence/。

- index.js 偏移 74322：getDbPath 指向 userData/agents.db；偏移 77520：getAgentsBasePath 为 getDataPath()/agents，而 getDataPath 为 userData/Data。因此 Data/agents/<agent.id> 每个目录应视为独立项目/agent 域，不能将多个 agent 混成一行。
- 偏移 32954 的 ConfigManager 使用 electron-store；偏移 32823 的默认配置为 name=config、cwd=userData，即 userData/config.json。偏移 5110 的 getAppDataPathFromConfig 支持默认值、字符串、数组及 exe 匹配，portable 模式存在路径歧义，adapter 无法唯一确定时必须拒绝猜测。
- 偏移 160130 的 mcpDefinitionSchema 含 name、type（stdio/http/sse）、command、args、env、url、headers，另有 version、requireSessionId、requireUserAuth、timeout。SymSync WeiboAP 范围仍只接受 stdio/http，sse 标记 unsupported。
- 偏移 438523 的 addAgentMcp 只通过 updateAgent 写 mcp_config，不修改 mcps；这是配置写入，不等于启用，用户仍需在 WeiboAP 内启用，已有会话可能需要重开。
- 偏移 406208 表明只对 enabled 会话构造 mcps bridge，并使用 strictMcpConfig=true，说明把 .mcp.json 当成 WeiboAP 目标不可靠。
- main 中 appDataPath 解析涉及 ~/.weiboap/config/config.json、默认/字符串/数组和 exe 匹配，portable 情况不能凭路径猜测。
- renderer agent-Ba027E8R.js 偏移 171911/92470 显示 Electron localStorage persist:cherry-studio 根 mcp.servers 的全局 MCP 存储。本轮不写全局 profile 或 LevelDB，范围仅 project/agent。

WeiboAP adapter 写入活动 SQLite 必须使用支持 WAL 的 online backup 并保持权限，不能裸 copy+rename；执行前需重验 source/target row 与 local-mode guard。pgEnabled 必须显式为 false，所有 pgEnabled_* 不能为 true 或非法，否则 unsupported 拒绝写入。adapter 已实现，以上静态证据用于支撑其边界；macOS 隔离 fixture 原生 QA 已完成，不代表真实配置或运行时 MCP 验收通过；本轮不以预览截图或 tooltip 视觉记录作为证据。

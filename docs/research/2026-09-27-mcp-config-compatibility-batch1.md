# MCP 配置兼容性研究（第一批新增：Gemini CLI / GitHub Copilot CLI / Claude Desktop）

日期：2026-09-27

主会话抽查（2026-09-27）：Gemini 的 `url`＝SSE、`httpUrl`＝Streamable HTTP、没有 `type` 字段；Copilot CLI 的用户级路径、项目级 `.mcp.json` / `.github/mcp.json`、「确认目录信任后才加载」、`tools` 默认 `"*"`，均已对照官方原文核实；并补正 Copilot `type` 也接受 `stdio`。

范围：核对 Gemini CLI、GitHub Copilot CLI、Claude Desktop 三者的官方 MCP 配置位置、格式、传输字段和环境变量语义，衔接 `docs/research/2026-09-11-mcp-config-compatibility.md` 已核实的 Claude Code / Cursor / Codex。本文只依据官方文档（Google gemini-cli 仓库文档、GitHub Docs、Anthropic support 与 modelcontextprotocol.io），没有读取本机真实配置或凭据，只在必要时列出服务器**名称**。magpie（第三方、未核实）给出的线索已逐条对照官方文档验证或标记为未核实，不作为结论依据。

## 官方核实项

| Harness | 用户级配置 | 项目级配置 | 格式与根结构 | 官方列出的传输 |
|---|---|---|---|---|
| Gemini CLI | `~/.gemini/settings.json`；根目录可用 `GEMINI_CLI_HOME` 覆盖（CLI 会在该目录下建 `.gemini` 文件夹） | `<project>/.gemini/settings.json`，与用户级同键合并，优先级更高 | JSON，`{"mcpServers": {...}}`；未见 JSONC/注释声明 | `stdio`（`command`）、SSE（`url`）、Streamable HTTP（`httpUrl`） |
| GitHub Copilot CLI | `$COPILOT_HOME/mcp-config.json`，`COPILOT_HOME` 未设置时为 `~/.copilot`（Windows 同样用 `$HOME\.copilot\`） | 从当前目录向上找到仓库根的 `.mcp.json`，或仓库内 `.github/mcp.json`；仅在确认目录受信后加载，未受信目录静默跳过 | JSON，`{"mcpServers": {...}}`；官方示例未出现注释，未见 JSONC 声明 | `local` / `stdio`（本地命令，两个取值同义）、`http`、`sse`（官方文档明确标注 SSE 为“遗留、MCP 规范已弃用但仍为兼容保留”） |
| Claude Desktop | macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`；未见 Linux 官方支持声明，也未见配置根目录的环境变量覆盖 | 无项目级文件配置；远程服务器完全不经此文件，走应用内 Settings → Connectors 的 OAuth 流程 | JSON，`{"mcpServers": {...}}`，逐服务器仅 `command`/`args`/`env`；未见 JSONC/注释声明 | 仅 `stdio`（本地命令）。远程 HTTP/SSE 不通过该配置文件，只能通过 Connectors UI 添加 |

官方来源：

- [gemini-cli MCP 服务器文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)：`mcpServers` 结构、stdio/SSE/HTTP 字段、`trust`/`includeTools`/`excludeTools`、OAuth、环境变量展开。
- [gemini-cli 配置参考](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)：用户/项目/系统四级 settings.json 位置、`GEMINI_CLI_HOME`、`GEMINI_CLI_SYSTEM_SETTINGS_PATH`、`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`、优先级顺序。
- [gemini-cli MCP 配置教程](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/tutorials/mcp-setup.md)：`~/.gemini/settings.json` 示例、`env` 变量展开示例。
- [GitHub Docs：Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)：`mcp-config.json` 结构、`type: local/http/sse`、`tools` 字段、项目级 `.mcp.json`/`.github/mcp.json`、目录信任语义。
- [GitHub Docs：Configuring GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli)：`COPILOT_HOME` 环境变量、默认路径。
- [GitHub Docs：Using GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview)：`--tools`/`copilot mcp add` 交互，工具授权提示。
- [modelcontextprotocol.io：Connect to local MCP servers（Claude Desktop 示例）](https://modelcontextprotocol.io/quickstart/user)：`claude_desktop_config.json` 路径、结构、日志位置、`env` 手动填值案例。
- [Claude Help Center：Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)：Settings → Developer → Edit Config 入口、桌面扩展（.mcpb）与手写 JSON 的关系。
- [Claude Help Center：Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)：确认远程 MCP 走 Connectors、不写入 `claude_desktop_config.json`。

## 各 Agent 详细笔记

### Gemini CLI

- 配置分四级：系统默认（`/etc/gemini-cli/system-defaults.json` 等，`GEMINI_CLI_SYSTEM_DEFAULTS_PATH` 可覆盖）→ 用户级 `~/.gemini/settings.json` → 项目级 `<project>/.gemini/settings.json` → 系统强制（`/etc/gemini-cli/settings.json` 等，`GEMINI_CLI_SYSTEM_SETTINGS_PATH` 可覆盖）→ 环境变量/`.env` → 命令行参数，后者覆盖前者。用户级根目录整体可用 `GEMINI_CLI_HOME` 环境变量重定向（CLI 在该目录下自建 `.gemini`）。
- 单个服务器根键在 `mcpServers.<name>` 下：
  - stdio：`command`（必需）、`args`、`env`、`cwd`、`timeout`（毫秒，默认 600000）。
  - 远程 SSE：`url`（如 `http://host/sse`）、`headers`、`timeout`。
  - 远程 Streamable HTTP：`httpUrl`、`headers`、`timeout`。
  - 二选一：一个服务器条目要么是 stdio（`command`），要么是 SSE（`url`），要么是 Streamable HTTP（`httpUrl`）——`url` 与 `httpUrl` 是两个不同字段，不是同一字段的两种取值，magpie 提到的“远程 HTTP 用 `httpUrl`、SSE 用 `url`”与官方文档一致。
  - 其它可选字段：`trust`（布尔，默认 false，为 true 时跳过该服务器所有工具调用确认）、`description`、`includeTools`/`excludeTools`（两者都命中时以排除为准）。
  - 远程服务器支持 OAuth 对象：`enabled`、`authProviderType`（`dynamic_discovery`/`google_credentials`/`service_account_impersonation`）、`issuer`/`authorizationUrl`/`tokenUrl`、`clientId`/`clientSecret`/`scopes`/`redirectUri`；令牌落盘在 `~/.gemini/mcp-oauth-tokens.json`。这是 Gemini 专属认证机制，不能映射到其他 harness。
  - 顶层还有一个全局 `mcp` 对象：`mcp.allowed`（白名单）、`mcp.excluded`（黑名单，二者都命中按排除处理）、`mcp.serverCommand`；以及旧式顶层 `excludeMCPServers`/`allowMCPServers`。这些是"是否启用某服务器"的全局开关，不是服务器连接定义本身，字符串匹配、非安全边界（官方文档自称如此）。
  - 环境变量展开语法：`env` 块内的值支持 `$VAR`、`${VAR}`（跨平台）以及 Windows 专属 `%VAR%`；未定义变量按空字符串处理。这与 Claude Code 的 `${VAR}`/`${VAR:-default}` 相似但不完全相同（Gemini 文档未提及 `:-default` 回退语法本身适用于 MCP env，`:-default` 出现在 settings.json 通用变量插值段落，需要谨慎区分“settings.json 通用插值”与“MCP env 专属展开”两处文档）。
  - 扩展（extension，`gemini-extension.json`）也可以提供 MCP 服务器；本地 `settings.json` 与扩展定义合并时：`excludeTools` 取并集（更严格者生效）、`includeTools` 取交集、`env` 合并且本地值优先、标量字段（如 `trust`、`timeout`）整体被本地值替换。这是 Gemini 专属的“同名服务器多来源合并”语义，Sophia 目前的“同名单行分别保留事实”模型如果要覆盖 Gemini 扩展来源，需要单独处理这条合并规则，不能直接套用 Claude/Cursor 的“来源文件+名称独立成行”假设。
- **无损映射障碍**：`trust`、`includeTools`/`excludeTools`、OAuth 全套字段、扩展合并语义、`mcp.allowed`/`mcp.excluded`/`mcp.serverCommand` 全局开关都是 Gemini 专属，其他三个 harness 没有对应字段，必须原样保留、拒绝静默丢弃。

### GitHub Copilot CLI

- 用户级：`$COPILOT_HOME/mcp-config.json`；`COPILOT_HOME` 未设置时 macOS/Linux 默认 `~/.copilot`，Windows 官方文档写作 `$HOME\.copilot\`（未给出 `%USERPROFILE%` 写法，按官方原文照录）。
- 项目级：CLI 从当前工作目录向上查找到仓库根，依次识别 `.mcp.json`（任意层级）和 `.github/mcp.json`（提交到仓库）；更靠近工作目录的文件优先，项目级定义整体覆盖用户级同名定义。**项目级 MCP 服务器只有在“确认目录信任”后才会加载**，未信任目录会被静默跳过；prompt 模式下可用环境变量 `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP=true` 让未信任目录也加载项目级服务器——这是 Copilot CLI 专属的信任门槛，语义上类似 Claude Code 项目 `.mcp.json` 的批准机制，但触发条件、环境变量名和默认行为都不同，不能等同处理。
- 根结构统一为 `{"mcpServers": {"<name>": {...}}}`。每个服务器：
  - `type` 必需，取值 `local` 或 `stdio`（同义，本地命令）、`http`、`sse`（官方原文：SSE 是遗留的 HTTP+SSE 传输，MCP 规范已弃用但 Copilot CLI 仍保留兼容）。
  - `local`：`command`（必需）、`args`、`env`。
  - `http`/`sse`：`url`（必需）、`headers`。
  - `tools`：字符串，`"*"` 表示全部工具、逗号分隔列表表示白名单、空字符串 `""` 表示不启用任何工具；通过交互式 `/mcp add` 或 `copilot mcp add --tools` 添加时默认值为 `"*"`（即省略时默认全部工具）。magpie 提示“要求 `tools` 列表”与官方文档存在出入：官方文档展示的示例都带 `tools`，但通过 CLI 向导添加时该字段有默认值而非强制手填；是否可以直接手写 JSON 且完全不含 `tools` 字段被 CLI 接受，官方文档未明确说明，本文列为未核实项。
  - 变量替换：官方 `add-mcp-servers` 示例里出现 `"Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"`，即 `headers`/`env` 中的值支持 `${VAR_NAME}` 语法引用宿主环境变量，与 Claude Code 的 `${VAR}` 形式一致（但没有见到 `${VAR:-default}` 回退语法的官方声明）。
  - 工具调用仍需运行时审批：可用 `--allow-tool`/`--deny-tool` 等参数控制，`/mcp` 命令可查看、编辑（`/mcp edit`）、删除（`/mcp delete`）、禁用（`/mcp disable`）已配置服务器。
- **无损映射障碍**：`type` 里的 `local` 命名与 Claude/Cursor 的 `stdio` 不同名但语义相同，可映射；`tools` 是 Copilot CLI 专属的“服务器级工具白名单”字段，Claude Code/Cursor/Codex 都没有对应位置存放这个粒度的授权（Claude Code 的工具允许/拒绝在别的配置层，不在 MCP 服务器定义里），因此 `tools` 应作为专属字段保留、拒绝无损映射；目录信任（`GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP`）、`sse` 遗留传输同理需要保留说明而非静默丢弃。

### Claude Desktop

- 唯一文件配置入口：`claude_desktop_config.json`。macOS `~/Library/Application Support/Claude/claude_desktop_config.json`，Windows `%APPDATA%\Claude\claude_desktop_config.json`。两份官方来源（modelcontextprotocol.io quickstart、Claude Help Center）都只给出这两个平台的路径；**Linux 桌面客户端的官方路径未见**（Claude Desktop 官方仅在 macOS/Windows 提供下载），Sophia 若要支持 Linux 需要单独确认或明确排除。
- 未见任何环境变量可以重定向该配置文件或其所在目录；文件位置由应用固定管理，通过 Settings → Developer → Edit Config 打开/创建，不存在等价于 `CODEX_HOME`/`GEMINI_CLI_HOME` 的覆盖机制。
- 根结构仅 `{"mcpServers": {"<name>": {...}}}`，逐服务器字段只有 `command`（必需）、`args`、`env`。**官方文档没有列出 `url`/`httpUrl`/`type` 等远程传输字段**——modelcontextprotocol.io 与 Claude Help Center 都只演示本地 stdio 命令；另检索到的社区/Anthropic 说明明确指出：Claude Desktop 不会连接写在 `claude_desktop_config.json` 里的远程服务器，远程 MCP（自定义连接器）必须通过应用内 Settings → Connectors → Add custom connector 添加，走独立的 OAuth 流程，且这条路径**不写入该 JSON 文件**、状态存在应用自身存储里，属于本文件配置范围之外的运行时状态，无法作为“配置文件”参与跨工具同步。这与 magpie 的提示（“只有本地命令，远程走 Connectors UI”）一致，予以确认。
- 没有找到官方文档声明 `${VAR}` 之类的环境变量插值语法；相反，官方 quickstart 的故障排查小节给出一个反例：Windows 上如果路径里出现字面量 `${APPDATA}` 未被展开导致服务器加载失败，解决办法是让用户**手动**把 `APPDATA` 的展开值写进该服务器的 `env` 对象里——这说明 Claude Desktop 本身不对 `command`/`args`/`env` 的值做变量展开，值是字面量原样传给子进程（`${APPDATA}` 很可能来自用户 shell 配置或另一个工具遗留，而不是 Claude Desktop 自己的插值语法）。
- 没有找到项目级配置、批准/信任语义（本地服务器的“审批”体现为每次工具调用的会话内确认弹窗，不是配置文件层面的批准字段）。
- JSON 注释：两份官方来源均未提及 JSONC 或注释支持，所有示例都是纯 JSON。
- **无损映射障碍**：Claude Desktop 文件配置本身字段集合是三者/六者中最小的子集（只有 `command`/`args`/`env`），从 Claude Desktop 迁移到别的 harness 反而没有“专属字段需要拒绝”的问题；但反向（把 Claude Code/Cursor/Codex/Gemini/Copilot 的远程 HTTP/SSE 服务器同步“进”Claude Desktop 的文件配置）在协议层面就不成立——Claude Desktop 的文件配置根本不支持远程服务器，只能引导用户去 Connectors UI 手动添加，不能当作“配置项”写入 JSON 文件，这类目标应直接判 `unsupported`，而不是尝试字段级转换。

## 环境变量引用语义（补充）

| Harness | 文档化语法 | 文档化位置与语义 |
|---|---|---|
| Gemini CLI | `$VAR`、`${VAR}`（跨平台，MCP `env` 块内展开）；`%VAR%`（仅 Windows）；`settings.json` 通用插值另支持 `${VAR:-default}` | `env` 值内联展开；未定义变量按空串处理；`:-default` 回退语法出现在 settings.json 通用变量插值文档段落，未见专门证实同样适用于 `mcpServers.*.env` |
| GitHub Copilot CLI | `${VAR_NAME}` | 官方 `add-mcp-servers` 示例出现在 `headers`（`Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`）；未见文档明确 `command`/`args`/`env` 是否同样展开，也未见 `:-default` 回退写法 |
| Claude Desktop | 未见任何插值语法 | 值按字面量传给子进程；官方故障排查建议手动把展开值写入 `env`，反证明没有自动展开 |

因此本批三者环境变量引用同样不能原样跨工具复制：Gemini 与 Copilot CLI 表面上都使用 `${VAR}`，但触发范围（Gemini 明确覆盖 `env`；Copilot 官方只在 `headers` 示例中出现）和是否支持默认值回退未完全对齐，仍需按目标 harness 分别验证再展开或保留原文本；Claude Desktop 完全没有插值机制，从其他 harness 同步进来的 `${VAR}` 写法必须原样保留或提前手动展开，否则子进程会收到未展开的字面量。

## 未核实项

- Gemini CLI：`GEMINI_CLI_HOME` 已在官方 `docs/reference/configuration.md` 核实为用户级配置根目录覆盖变量；另有第三方/issue 提到 `GEMINI_CONFIG_DIR`（且称 Windows 上该变量被忽略），未在本文引用的官方页面中找到对应声明，可能是旧名称、实现细节或与 `GEMINI_CLI_HOME` 混淆，本文不采信，需要单独用代码或多版本文档核实。
- Gemini CLI：`settings.json` 通用变量插值的 `${VAR:-default}` 回退语法明确写在配置参考文档里，但未找到专门针对 `mcpServers.*.env` 字段重复声明同一回退语法；按 Sophia“未核实不当作等价”的原则，暂不假定 `${VAR:-default}` 对 MCP env 同样生效。
- GitHub Copilot CLI：手写 JSON 时完全省略 `tools` 字段是否被 CLI 接受、接受后默认值是否与交互式添加（`"*"`）一致，官方文档未明确说明，只确认了 CLI 向导/`--tools` 参数省略时默认值为 `"*"`。
- GitHub Copilot CLI：`command`/`args`/`env`（`local` 类型）内是否同样支持 `${VAR_NAME}` 插值，官方文档没有给出示例，只在 `headers` 里见过一次；也未见 JSONC/注释支持的官方声明（社区/教育类页面提到“`//` 开头的注释不是合法 JSON，需要移除”，但不是 GitHub 官方原文的直接引用，供参考、不作为核实结论）。
- GitHub Copilot CLI：`http`/`sse` 类型是否支持 WS（WebSocket）传输，未见官方文档提及，判定为未支持。
- Claude Desktop：Linux 官方路径未核实（官方仅发行 macOS/Windows 客户端）；是否存在类似 `CODEX_HOME`/`GEMINI_CLI_HOME` 的配置根目录覆盖变量，检索未见官方声明，按“未核实不代表不存在”处理，暂列为无。
- 三者是否支持 JSONC（`//` 或 `/* */` 注释）均未获得官方明确声明，按 2026-09-11 原研究的处理原则，一律按纯 JSON 对待，不在解析器里预先放开注释容忍。
- 未核实以上三个 harness 的旧版本路径、字段别名和缺失变量时的具体报错文案；结论以 2026-09-27 访问到的官方页面为准。

## 与「必须保留且拒绝无损映射的字段」清单的衔接（本批新增）

延续 2026-09-11 研究的政策：未知字段和客户端专属字段不得静默丢弃，目标工具无法无损映射时应拒绝该服务器项并保留源配置。本批新增以下专属字段：

- **Gemini CLI**：`trust`、`includeTools`/`excludeTools`、OAuth 全套（`enabled`/`authProviderType`/`issuer`/`authorizationUrl`/`tokenUrl`/`clientId`/`clientSecret`/`scopes`/`redirectUri`）、`cwd`、`timeout`、扩展来源合并语义、全局 `mcp.allowed`/`mcp.excluded`/`mcp.serverCommand` 与旧式 `excludeMCPServers`/`allowMCPServers`。
- **GitHub Copilot CLI**：`tools`（服务器级工具白名单，粒度和位置与其他三者都不同）、目录信任与 `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP`、`sse` 遗留传输标记。
- **Claude Desktop**：本文件配置字段集合本身没有专属扩展字段可保留（只有 `command`/`args`/`env`）；但反向约束是——它是唯一一个**协议层面就不接受远程服务器写入配置文件**的 harness，任何 `url`/`httpUrl`/`headers` 定义的服务器同步“进”Claude Desktop 都必须整体拒绝为 `unsupported`，并提示用户改走 Connectors UI，不能尝试字段映射或降级处理。

跨批比较：Gemini 的 `httpUrl` 与 Claude Code/Cursor 的 `url`（Streamable HTTP）是同一传输类别下的不同字段名，可以做“连接字段”级别的候选映射（比照 2026-09-11 研究里 Claude 的 `url`/Cursor 的 `url`），但 Gemini 同时把 `url` 留给了 SSE，因此从 Gemini 往其它工具映射时必须先看清字段名对应的是哪种传输，不能按字段名字面相同就假定语义相同；反过来从 Claude Code 的 `url`（Streamable HTTP）映射到 Gemini 时目标字段应是 `httpUrl` 而不是 `url`，否则会被 Gemini 解析成 SSE。

## 本次来源读取确认

是。Gemini CLI 的 `mcp-server.md`、`reference/configuration.md`、`cli/tutorials/mcp-setup.md`，GitHub Docs 的 `add-mcp-servers`、`set-up-copilot-cli/configure-copilot-cli`、`use-copilot-cli/overview`，以及 modelcontextprotocol.io 的 `quickstart/user` 和 Claude Help Center 的两篇文章均已实际抓取并读取相关段落；`GEMINI_CLI_HOME`/`GEMINI_CLI_SYSTEM_SETTINGS_PATH` 另通过官方 `reference/configuration.md` 原文复核。来源链接见上文“官方核实项”之后的列表。本文未读取本机任何真实配置文件内容，也未执行任何写入或凭据操作。

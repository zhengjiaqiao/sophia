# Claude Code 网关契约样本（P0，2026-09-29）

来源：`docs/specs/2026-09-29-claude-third-party-models.md`「实施分期 › P0」。结论与逐条证据见 `docs/research/2026-09-29-claude-code-gateway-capture.md`。

## 怎么抓的

- **Claude Code 请求（`cc-*`）**：本机 `claude` **2.1.283**（`claude --version`），连一个只听 `127.0.0.1` 的 Python 抓包服务（按 Anthropic 形状回流式 `message_start → content_block_* → message_delta → message_stop`，按剧本回 `tool_use` 让它进入工具循环）。每轮都用新的临时 `CLAUDE_CONFIG_DIR` 与临时 `HOME`，`env -i` 起进程（不继承宿主的任何 `ANTHROPIC_*` / `CLAUDE_*` 变量），`DISABLE_TELEMETRY=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，凭证全是编造的假值（`p0-fake-…`），没有用到任何 Claude 订阅登录。
  - `sdk-cli`：`claude -p …` 非交互；`cli`：用 pty 驱动的交互会话。
  - 模型名：非交互轮用 `ANTHROPIC_MODEL=kimi-k2.5-main`、`OPUS=glm-5-opus`、`SONNET=glm-5-sonnet`、`HAIKU=kimi-k2.5-haiku`、`FABLE=glm-5-fable`（各档名字不同，便于看出后台请求走哪一档）；交互轮按 spec R29 的形状写进临时 `settings.json`：`MODEL=OPUS=SONNET=FABLE=default-weibo-kimi-k2.5`（默认用）、`HAIKU=default-weibo-glm-5`（后台任务用）。
- **上游样本（`upstream-*`）**：按 Sophia 网关的真实做法（`stream: true`、`stream_options.include_usage: true`、`POST <api_base>/chat/completions`）向产品负责人在 Sophia 里配过的网关各发一次。密钥只在进程内存里用过。

## 脱敏

- 所有鉴权头、`set-cookie` 及名字含 key / auth / token / user / team / spend / budget / api-base 的响应头值替换为 `<redacted>`；存档后逐文件核对过不含任何钥匙串里的服务商密钥原文或其后缀。`cc-*` 里的 `Authorization` / `x-api-key` 值是本次编造的假值，保留是为了看出「哪个设置去了哪个头」。
- 本机路径：临时工作目录 → `/Users/<user>/project`，临时 `HOME` → `/Users/<user>`，临时 `CLAUDE_CONFIG_DIR` → `<claude-config-dir>`，其余临时目录 → `<scratch>` / `<tmp>`；用户名 → `<user>`；`metadata.user_id` 里的 `device_id` → `<device-id>`。
- **长文字截断**：系统提示块 > 300 字符、消息文字块 > 400 字符、工具说明 > 160 字符的部分截掉，末尾标 `…<截断，原长 N 字符>`。结构、字段、块类型、`cache_control`、`input_schema` 全部原样。目的：样本只承载协议结构，不把 Claude Code 的整份提示词放进仓库。拿这些文件做 R15 估算的黄金值时，以截断后的文件内容为准。

## 文件

| 文件 | 场景 |
|---|---|
| `cc-hello-head.json` | 启动探测 `HEAD /api/hello`，无凭证头，UA `Bun/…` |
| `cc-messages-sdk-first-turn.json` | `-p` 主会话第一轮（22 个工具；`thinking`、`context_management`、`output_config`、`metadata`；`messages` 里有 `role: system`） |
| `cc-messages-sdk-tool-result.json` | `-p` 工具循环第二轮（`tool_use` / `tool_result`，两条中途 `role: system`） |
| `cc-messages-interactive-first-turn.json` | 交互主会话第一轮（23 个工具，顶层多一个 `safeguards`，含本机路径） |
| `cc-messages-interactive-tool-loop.json` | 交互：Read、Bash 两轮工具调用之后 |
| `cc-messages-title.json` | 起标题：HAIKU 档、无工具、`output_config.format` = `json_schema {title}` |
| `cc-messages-webfetch-summary.json` | WebFetch 取回网页后的摘要：HAIKU 档、无工具、无 `thinking` |
| `cc-messages-subagent-explore.json` | 内置 Explore 子代理：OPUS 档，归因块多 `cc_is_subagent=true;` |
| `cc-messages-compact.json` | `/compact`：主模型、带全部工具 |
| `cc-messages-tool-search.json` | `ENABLE_TOOL_SEARCH=true` + 3 个 MCP 工具：`ToolSearch` 与带 `defer_loading: true` 的 `DeferredToolPlaceholder` |
| `cc-count-tokens-system-section.json`、`cc-count-tokens-tools.json` | `/context` 触发的 `POST /v1/messages/count_tokens?beta=true`（一次 15 个并发） |
| `cc-prefix-hello-head.json`、`cc-prefix-messages.json` | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/claude-code` 时的实际路径 |
| `cc-auth-header-variants.json` | `AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `apiKeyHelper` 各种组合下实际发出的鉴权头 |
| `cc-capture-index.txt` | 全部抓包轮次的请求清单（方法、路径、模型、本服务的回应） |
| `upstream-ap-gateway-kimi-k2.5-tool-stream.sse` (+`.meta.json`) | ap-gateway（APISIX）`weibo/kimi-k2.5`：推理内容 → 一句文字 → 一个工具调用，`finish_reason` 平时是 `""` |
| `upstream-ap-gateway-kimi-k2.5-context-overflow.json` (+`.meta.json`) | 同上，约 30 万 token 输入：HTTP 400 错误原文 |
| `upstream-ap-gateway-glm-5-404.json` (+`.meta.json`) | 同一网关 `weibo/glm-5`（`/models` 里列着）：HTTP 404 原文 |
| `upstream-openrouter-deepseek-flash-tool-stream.sse` (+`.meta.json`) | openrouter.ai `~deepseek/deepseek-flash-latest`（实际 `deepseek/deepseek-v4.1-flash`）：`reasoning` / `reasoning_details` → 工具调用，`finish_reason: tool_calls` 出现两次 |
| `upstream-openrouter-lfm-2.5-context-overflow.json` (+`.meta.json`) | openrouter.ai `liquid/lfm-2.5-2.6b:free`（65 536 上下文），约 15 万 token 输入：HTTP 400 错误原文 |

`.meta.json`：状态码、脱敏后的响应头、请求体字节数、耗时（响应头 / 首个响应体字节 / 结束，秒）、请求体（超长请求的正文以占位说明代替）。

## 黄金文件（`golden/`，P2 转换层用）

测试：`crates/gateway/src/translate/anthropic/tests.rs`。

| 文件 | 内容 |
|---|---|
| `messages-{sdk-tool-result,interactive-tool-loop,interactive-first-turn,title,tool-search}.chat.json` | 对应 `cc-*.json` 的 `body` 经 `to_chat(…, "weibo/kimi-k2.5", 默认选项)` 应得的 Chat Completions 请求体（`chat`）与 R14 估算值（`estimate`）。由一份独立于 Rust 实现、按 spec R16–R20 写的 Python 参照实现生成后人工核对，不是拿 Rust 的输出回填的 |
| `upstream-*-tool-stream.anthropic.jsonl` | 对应 `upstream-*.sse` 喂给 `ChatEvents` + `AnthropicEmitter`（模型名见测试、估算 100）应得的 Anthropic 事件序列，每行 `{"event","data"}`；`message.id` 写作 `<msg-id>`。手写 |

改转换规则时同步改这里的黄金文件，并在提交说明里写清是规则变了而不是为了让测试通过。

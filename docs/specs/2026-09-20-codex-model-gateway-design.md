---
type: spec
description: 在 SymSync 里用 Rust 重写“Codex 官方模型与第三方网关模型共存”，本期只交付 macOS
created: 2026-09-20
---

# Spec：在 SymSync 里管理 Codex 的第三方模型

依据：`docs/intent/2026-09-20-codex-model-gateway.md`

行为参照：`/Users/jiaqiao/Project/agents-manager`（Go，已在本机真实启用并验证）。它的 spec、测试和真实环境记录是本次重写的验收依据；它本身原样保留，不属于本仓库。

## 需求

- **R1 模型页** macOS 上 SymSync 多一个「模型」标签页，可以填网关地址和密钥、拉取并勾选模型、改显示名、启用、恢复，并看到当前状态。非 macOS 上这个标签页不出现。
- **R2 共存可选** 启用并重启 Codex 后，Codex 的模型选择器里同时列出官方模型和所选的第三方模型。
- **R3 按模型分流** 第三方模型的请求走第三方网关并换成第三方密钥，官方凭据一律不转发；其余请求原样透传给官方上游，不携带第三方密钥。
- **R4 协议转换** 第三方网关只支持 Chat Completions 时，路由在这条路上做 Responses 与 Chat Completions 的双向转换，覆盖正文、思考内容、工具调用（含命名空间工具）、用量、Codex 的远程压缩；同一会话在官方模型与第三方模型之间来回切换可用。
- **R5 认不清就拒绝** 已取消勾选的模型、模型名的大小写或不可见字符变体、读不懂的请求体、重复或大小写不同的 `model` 键、不认识的压缩方式：一律拒绝，绝不当成官方模型放行。带 `Origin`、`Sec-Fetch-Site` 或非回环 `Host` 的请求一律 403。
- **R6 常驻** 路由由 launchd 常驻，登录自启、崩溃自动拉起；关闭 SymSync 不影响 Codex 使用。后台进程没有代理环境变量时读取 macOS 系统代理设置及其例外列表。
- **R7 同一套写入** 写 `~/.codex/config.toml` 与 MCP 同步共用同一套快照、备份、原子替换、写前写后校验、可疑路径拒绝。任一方写入后，另一方要么成功，要么明确提示“配置已变化，请重试”。
- **R8 只改自己的** 只增删根部两个键 `model_catalog_json`、`openai_base_url`；不写 `model_provider`；不读不写 `auth.json`。已有别的工具写入的同名键、非官方的 `model_provider`、指定了 provider 或目录的配置档：拒绝并说明来源。
- **R9 恢复** 恢复后 Codex 设置里不留本功能的痕迹，MCP 等其余内容逐字节保留；Codex 的默认模型若是本功能的第三方模型，改回启用前的值；后台服务与本功能文件被清除。设置里仍有指向路由的项没移除干净时，不拆路由并明确报错。
- **R10 接管 agents-manager** 本机已由 agents-manager 启用时，模型页识别出来并提供「接管」：网关地址、所选模型与显示名、密钥、启用前的默认模型原样带过来，agents-manager 的后台服务和文件被撤下，全程不需要重新输入密钥。未接管前，启用按钮不可用并说明原因。agents-manager 本身不被修改。
- **R11 密钥** 密钥只存在钥匙串里，不进设置文件、日志、命令行参数和错误信息。带新密钥保存时先向网关校验，校验失败什么都不保存。明显不是密钥的内容（含空白或过短）拒收。
- **R12 状态与诊断** 模型页显示：是否启用、后台服务是否安装与运行、端口、Codex 版本与目录生成时的版本是否一致、是否需要重启 Codex、冲突原因。设置指向路由而路由不通时，页面顶部给出原因和「恢复」。同一个可执行文件提供命令行的状态、诊断、恢复，供界面不可用时应急。
- **R13 程序升级** SymSync 升级后，已安装的后台程序与当前程序不一致时自动更新并重启后台服务。

非功能需求：

- `symsync-core` 仍不依赖 tauri、无异步、无网络；非 macOS 上整个 workspace 能编译，`cargo test -p symsync-core` 在 Linux 上全绿。
- 路由只监听回环地址；活动日志只记时间、模型、去向、状态码、耗时、字节数，不记请求内容和凭据。
- 官方路径请求体未被改动时按原始字节透传；本机转发引入的首字节额外延迟 P95 < 50ms。
- 不引入 CSS 框架或组件库；沿用 `App.css` 的写法，视觉不做要求（整套界面之后会统一重做）。

## 设计

### 模块划分

| 位置 | 内容 | 约束 |
|---|---|---|
| `crates/core/src/atomicfile.rs`（新） | 从 `mcp.rs` 抽出的 `Fingerprint`、快照读取、`backup`（备份后缀参数化）、`atomic_write`、`safe_parent` | 行为与现状完全一致；`mcp.rs` 的 `State::{Bad,Weibo}` 等领域变体留在原处，映射到通用的 `Missing / Present` |
| `crates/core/src/codex_models/`（新） | 纯逻辑：`config.rs`（文本级手术写入、移除两个根键，`toml_edit` 只做校验和读值；冲突判定，默认模型回退）、`catalog.rs`（合并目录、路由清单与停用名单、模型标识生成）、`settings.rs`（网关地址、接口基址、协议、模型列表、已发布标识、启用前默认模型、端口、变更时间） | 无网络无异步，Linux CI 可测；新类型放这里，不往 `models.rs` 中间插 |
| `crates/gateway`（新 crate `symsync-gateway`） | `router`（hyper 服务端 + reqwest 客户端）、`translate`（请求转换、流转换、压缩、官方路径清理）、`sysproxy`（解析 `scutil --proxy`）、`provider`（拉模型列表）、`keychain`、`service`（launchd plist 与 launchctl）、`takeover`（读取 agents-manager 的状态） | 平台相关代码 `cfg(target_os = "macos")` 门控，其余在 Linux 上可编译可测；不依赖 tauri |
| `src-tauri` | 异步命令层 `gateway_*`；`main.rs` 在启动 Tauri 之前判断命令行：`symsync gateway run|status|doctor|restore` 走无界面模式 | 命令一行调下层；这是仓库里第一批 `async` 命令 |
| `src/ModelsTab.tsx`、`src/modelsView.ts` | 页面与纯视图逻辑；错误走 `App.tsx` 顶部横幅 | 纯 CSS |

`Settings` 增加一个 `codexGateway` 字段（容器级 `default` 保证旧文件可读）。密钥不进 `Settings`。

### 单一可执行文件

launchd 拉起的是 SymSync 自己的可执行文件的无界面模式。启用时把当前可执行文件复制到 `~/Library/Application Support/SymSync/bin/symsync`（应用可能被移动、从磁盘映像里运行或在开发时重新编译，plist 不能指向应用包内路径），plist 指向这份副本，参数为 `gateway run`。副本内容与当前程序不一致时重新复制并 `launchctl kickstart -k`（R13）。

副本是否过期的判据：先比长度和修改时间，不一致再比 SHA-256（哈希随副本存一份），不每次读全文件。`~/Library/Application Support/SymSync/` 同时放着 `settings.json`、`projects.json`，清理本功能文件时只动 `bin/` 和本功能自己的文件。

命令行分支硬编码：只有第一个参数恰好是 `gateway` 才走无界面模式，其余一律进界面，不解析、不报错。macOS 从 Finder 双击启动时系统会传 `-psn_…` 参数，用通用解析库严格解析会让应用打不开，而 `tauri dev` 下复现不了。

服务标签 `com.zhengjiaqiao.symsync.gateway`，默认端口 47328（agents-manager 用 47318，两者可以同时存在而不抢端口）。健康检查响应里带服务名，用来区分“本功能的路由”和“恰好占着端口的别的程序”。

### 同进程内的写入串行化

MCP 页和模型页在同一个进程里可能同时走到写 `config.toml`。`AppState` 加一把针对该文件的写锁，两条路径都持锁；跨进程仍靠写前写后的指纹校验兜底。`gateway_*` 是仓库里第一批异步命令：锁会跨 `.await` 持有，必须用 `tokio::sync::Mutex`，不能用 `std::sync::Mutex`（guard 不是 `Send`，而且会阻塞运行时线程）；同步的 MCP 命令用它的 `blocking_lock()`。后面新增异步命令照此办理。

### 启用与恢复的顺序

启用：读设置快照并在内存里试写（有冲突在产生任何副作用之前退出）→ 写路由清单，再写合并目录 → 安装后台服务并确认健康 → 重新读快照，若与最初不同则基于最新内容重新生成 → `atomic_write`（期望值为最新快照，不一致则报“配置已变化，请重试”）→ 记录启用前默认模型、已发布标识、变更时间。

恢复：默认模型回退 + 移除两个键（同一次原子写）→ 确认设置不再指向路由 → 卸载服务 → 删除本功能文件。

合并目录与路由清单文件名以 `symsync-` 为前缀放在 Codex 目录下。官方目录来源：Codex 的模型缓存，读不到时退回 `codex debug models --bundled`；不读 `auth.json`。版本记录与漂移判断用同一个来源（桌面应用自带的 Codex）。

### 路由与协议转换

行为以 agents-manager 的 `internal/router`、`internal/translate` 及其测试为准，逐条移植，包括它在真实环境里修过的问题：无请求体的 GET 必须以“无请求体”发出（否则 HTTP/2 下成为长度未知的请求）；只含空白的正文片段原样保留；正文为空且无工具调用时把思考内容同时作为正文；第三方的 3xx 改为 502，`Access-Control-*` 与 `Set-Cookie` 不带回；会话最近一次用的是第三方模型时拒绝转发 `codex-auto-review`。

reqwest 用 `default-features = false` 加 `rustls-tls`（与 zstd 同一条原则：不引入 C 构建和系统库依赖），关闭自动解压与重定向跟随；两个上游各用独立的客户端，第三方连接超时短、流不设总超时；代理选择用自定义函数：有代理环境变量时遵循环境变量，否则用系统代理设置及例外列表。请求体的 zstd 解压用纯 Rust 实现，避免引入 C 构建。

### 与 agents-manager 共存

两者互为“别的工具”：各自看到对方写的 `openai_base_url` / `model_catalog_json` 都会拒绝覆盖。SymSync 额外能认出对方（值指向 `127.0.0.1:47318` 且目录文件名以 `agents-manager-` 开头），把“冲突”换成「接管」。接管顺序：读取对方状态与钥匙串条目（对方用 `go-keyring-base64:` 前缀编码）→ 按本功能的方式完成一次启用的前半段（目录、服务、健康）→ 一次原子写把两个键改指向本功能 → 撤下对方的后台服务与文件。接管后需要重启一次 Codex。

### 钥匙串

读写都通过 `/usr/bin/security`（写入经它的交互模式从标准输入传入，密钥不进命令行参数）。原因：用系统接口直接创建的条目会绑定创建它的那个程序，后台副本和每次重新编译的程序会被拒绝或弹授权框；经 `security` 创建的条目任何进程都能无弹窗读取。agents-manager 已在本机实测过这一点。

## 外部契约

| 编号 | 接口 / 能力 | 文档来源 | 本次用到的内容 | 确认状态 |
|---|---|---|---|---|
| C1 | Codex 根键 `model_catalog_json`、`openai_base_url`；不写 `model_provider` 时保留官方账号控件；目录只在启动时加载；选中的模型会被 Codex 写回根部 `model` | agents-manager spec 的 C1、C6 与验证记录 | 同左 | 已验证（本机桌面应用 26.915 / 内核 0.155.0-alpha 真实启用） |
| C2 | Codex 请求形态：先尝试 WebSocket，426 后回落 HTTP；`POST {base}/responses`；`ChatGPT-Account-ID` 区分账号登录；可能的 zstd 请求体；`GET /models` 超时 5 秒；压缩触发条目 `compaction_trigger`；会话标题由官方小模型生成 | agents-manager spec 的 C4 与真实路由日志；样本 `docs/samples/codex/request-custom-provider.json` | 同左 | 已验证（真实抓包与真实会话） |
| C3 | wecode 网关：基址 `…/openai/v1`，`GET /models`，只支持 `POST /chat/completions`（流式，含 `reasoning_content`、`tool_calls`、`usage`），两种错误体形状 | agents-manager spec 的 C5，样本在该仓库 `docs/samples/wecode/` | 同左 | 已验证（真实调用） |
| C4 | launchd 用户级服务：`launchctl bootstrap / bootout / kickstart / print gui/<uid>`；未签名程序可用；后台任务经 `/usr/bin/security` 无弹窗读钥匙串 | agents-manager 的真实演练记录（C7） | 同左 | 已验证（本机真实运行）。**差异**：这次被拉起的是 Tauri 程序的无界面模式，未验证它脱离应用包单独运行是否正常 |
| C5 | Tauri 2：`async fn` 命令；在 `tauri::Builder` 之前按命令行分支、不初始化界面 | Tauri 2 官方文档 | 同左 | 未验证（仓库里没有先例） |
| C6 | `toml_edit 0.25` 增删根键后其余内容逐字节不变 | 2026-09-20 一次性实验 | 根部插入与移除 | **已验证：不成立。** 它把整个文件的 CRLF 改写成 LF、丢掉 BOM、给末行补换行。改用文本级手术（算法移植自 agents-manager 的 `internal/codexcfg`），`toml_edit` 只用于校验和读值。附带观察：`mcp.rs` 现有的 `toml_edit` 写入同样会改写 CRLF 文件的行尾，不在本次范围 |
| C7 | hyper 1 + reqwest：SSE 逐事件刷新；请求体原始字节透传；关闭自动解压后的头部处理；对 HTTP/2 上游的无请求体 GET | crate 文档 | 同左 | 未验证（Go 版踩过无请求体的坑，Rust 版要用同样的回归测试和真实请求确认） |

C4 的差异项、C5、C6、C7 在实施计划里排在最前面：先打通“无界面模式被 launchd 拉起 → 真实 Codex 经它访问官方模型和一个 wecode 模型”这条最小端到端路径，再铺开其余实现。

## 验收标准

| 编号 | 需求 | Given / When / Then | 真实验证 | 代理验证 |
|---|---|---|---|---|
| AC1 | R1 | Given macOS，When 打开 SymSync，Then 导航里有「模型」，点开能看到网关、模型、Codex 三块 | `make dev` 走查 | 视图逻辑单测 |
| AC2 | R1 | Given 非 macOS 构建，When 编译并运行，Then 编译通过且没有「模型」标签 | Linux CI 编译 core 与 gateway | `cargo check` 加 cfg 审查；Windows 未验证 |
| AC3 | R2 | Given 已启用并勾选 2 个模型，When 重启 Codex 桌面应用，Then 选择器里官方模型之后是这 2 个模型，名称可读 | 本机桌面应用截图 | 目录生成单测 |
| AC4 | R3 R4 | Given AC3，When 选第三方模型发一句话，Then 收到流式回复，日志去向为第三方 | 本机桌面应用真实对话 + 日志 | 假上游集成测试 |
| AC5 | R3 | Given AC3，When 官方模型发一句话，Then 正常回复，日志去向为官方；上游收到的请求头与请求体逐字节等于 Codex 发出的，且不含第三方密钥 | 本机真实对话 + 日志 | 集成测试断言字节相等 |
| AC6 | R4 | Given 第三方模型，When 让它读取工作区里一个文件，Then 工具被调用并返回内容 | 本机真实对话。**实施计划第一项** | 流转换单测 |
| AC7 | R4 | Given 同一会话，When 第三方模型 → 官方模型 → 第三方模型各发一句且后一句依赖前一句，Then 三次都成功 | 真实会话 | 官方路径清理单测 |
| AC8 | R4 | Given 第三方模型的会话，When 触发压缩再续聊，Then 回给 Codex 恰好一个压缩条目，续聊能用到摘要 | 对真实网关直接重放 | 单测 |
| AC9 | R5 | Given 已启用，When 请求的模型是已取消勾选的 / 大小写变体 / 数组 / 重复键 / 带 BOM / gzip，Then 分别得到 409、走第三方、400、400、400、415，且没有任何内容到达官方上游 | 真实二进制上用 curl | 集成测试 |
| AC10 | R5 | Given 已启用，When 请求带 `Origin`、`Sec-Fetch-Site: cross-site` 或 `Host: evil.example`，Then 403 且没有转发 | 真实二进制上用 curl | 集成测试 |
| AC11 | R6 | Given 已启用，When 关闭 SymSync，Then 官方和第三方对话仍可用 | 本机真实对话 | 无 |
| AC12 | R6 | Given 已启用，When `kill -9` 路由进程，Then 5 秒内自动恢复，随后的对话成功 | 本机 | 无 |
| AC13 | R6 | Given 后台进程环境里没有代理变量而系统代理已开，When 访问官方上游，Then 成功；网关域名在例外列表里时直连 | 本机 | `scutil` 输出解析单测 |
| AC14 | R6 | Given 重启电脑并登录，When 不开 SymSync 直接用 Codex，Then 两类模型都可用 | 本机重启 | 无 |
| AC15 | R7 | Given 模型页已启用，When 在 MCP 页同步一个服务器到 Codex，Then 成功，两个根键仍在；反过来先 MCP 后启用也成功 | `make dev` 走查 | core 集成测试 |
| AC16 | R7 | Given MCP 预览生成之后模型页写了设置，When 应用该预览，Then 失败并提示配置已变化，设置未被覆盖；重新预览后成功 | 走查 | core 集成测试 |
| AC17 | R7 | Given 重构后的 `mcp.rs`，When 跑现有全部 MCP 测试，Then 一条不改、全部通过，备份文件名仍是 `config.mcp.bak` | — | `make test-core` |
| AC18 | R8 | Given 本机真实设置，When 启用，Then 与原文件相比只多两行，权限不变，生成备份；`auth.json` 的哈希前后一致 | 本机文件比对 | 用真实设置副本做快照测试 |
| AC19 | R8 | Given 已有别的工具的同名键 / `model_provider = "custom"` / 指定 provider 或目录的配置档，When 启用，Then 拒绝、无任何副作用、页面说明来源 | 手工构造 | 单测 |
| AC20 | R9 | Given 已启用且 Codex 已把默认模型写成第三方模型，When 恢复，Then 设置与启用前逐字节相同，本功能文件和后台服务消失，MCP 配置仍在 | 隔离目录演练 + 本机 | 单测 |
| AC21 | R9 | Given 设置里本功能的键被别人改成多行写法，When 恢复，Then 明确报错且路由保留 | — | 单测 |
| AC22 | R10 | Given 本机当前由 agents-manager 启用，When 在模型页点「接管」并重启 Codex，Then 选择器里的模型与接管前相同，没有重新输入密钥，agents-manager 的后台服务与文件已撤下，设置里两个键指向本功能，启用前默认模型被保留 | 本机（只能做一次，先在隔离目录演练） | takeover 单测 |
| AC23 | R10 | Given 由 agents-manager 启用且未接管，When 打开模型页，Then 启用不可用并说明原因；agents-manager 的文件未被改动 | 本机 | 单测 |
| AC24 | R11 | Given 错误的密钥，When 保存，Then 提示鉴权失败，地址、密钥、模型列表都不变 | 本机 | 单测 |
| AC25 | R11 | Given 保存成功，When 搜索设置文件、日志、plist、进程参数，Then 找不到密钥明文 | 本机全量搜索 | 单测 |
| AC26 | R12 | Given 已启用但端口被别的程序占用，When 打开模型页，Then 顶部给出原因和「恢复」；再次启用失败且设置未动；`symsync gateway restore` 在界面不可用时也能恢复 | 隔离目录演练 | 单测 |
| AC27 | R12 | Given Codex 正在运行，When 改了模型，Then 提示需要重启 Codex；内容没变的重复启用不提示；SymSync 自己从不结束 Codex | 走查 | 单测 |
| AC28 | R13 | Given 已启用，When 换一个新构建的 SymSync 打开模型页，Then 后台程序被更新并重启，路由健康 | 本机两次构建 | 单测 |
| AC29 | 非功能 | Given 整个改动，When `make test`，Then core 测试、clippy 零警告、前端构建全过；`cargo test -p symsync-gateway` 通过 | — | 命令输出 |
| AC30 | 非功能 | Given 官方模型连续 50 次请求，When 对比经路由与直连的首字节时间，Then 额外延迟 P95 < 50ms | 本机计时 | 本机假上游测试 |

## 风险

- **重写风险。** 协议转换和路由是最容易出错的部分。对冲：agents-manager 的约 60 个行为测试逐条移植为 Rust 测试；C4–C7 先行；真实验证按 agents-manager 走过的步骤重做一遍。
- **抽取 `mcp.rs` 的写入原语会动到已上线的功能。** 约束：只移动与参数化，不改行为；现有 MCP 测试一条不改。
- **同一台机器上有两个工具。** 靠“拒绝覆盖 + 接管”避免互踩；接管只在本机做一次，先在隔离目录完整演练。
- **路由是单点。** 启用后官方请求也经过路由。对冲：launchd 自动拉起、健康检查带身份、页面与命令行两条恢复途径。
- **私有格式。** 模型目录和两个根键不是 OpenAI 承诺的稳定接口，Codex 升级可能失效；页面显示版本漂移，失效时一键恢复。
- **已知限制，页面上用一句话写明。** 用第三方模型开新会话时，Codex 仍用官方小模型生成会话标题，第一条消息会发给官方；自动审阅请求在第三方会话里被拒绝；网页搜索等 Responses 专有工具在第三方模型上不可用。
- **首次引入异步与网络依赖。** 限定在 `crates/gateway` 与 `src-tauri`；编译时间会变长；CI 的 Linux 任务增加 `cargo test -p symsync-gateway`。
- **分发时的签名与公证** 本期不涉及（本机 debug 构建），留待发布需求。

## 已确认

- CI 的 Linux 任务加上 `cargo test -p symsync-gateway` 与对应的 clippy（软链接同步会话 2026-09-20 同意）。
- 端口、服务标签、文件前缀、接管后保留 agents-manager、协议固定为 `chat`：软链接同步会话无异议，按默认假设。

## 待决问题

- 默认端口 47328、服务标签 `com.zhengjiaqiao.symsync.gateway`、文件前缀 `symsync-`。（作者）—— 默认假设：按此。
- 接管完成后，agents-manager 在本机处于“未启用”状态但程序和数据保留。（作者）—— 默认假设：是；它的钥匙串条目保留不删，方便以后单独使用。
- 第三方网关的协议（`chat` / `responses`）是否需要在页面上可选？（作者）—— 默认假设：本期不出现在页面上，固定为 `chat`，设置里留字段。

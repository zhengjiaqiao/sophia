# 模型页的 Tauri 命令约定

所有命令只在 macOS 上有意义；其他系统上 `gateway_state` 返回 `supported: false`，其余命令返回错误。
命令都是 `async`。除 `gateway_upsert_provider` 外都返回 `Result<GatewayState, String>`。错误字符串以 `[代码] ` 开头，
代码取值：`auth`、`network`、`conflict`、`invalid`、`router_down`、`changed`（配置在操作期间被别人改了，请重试）、`internal`。

第三方网关可以有多家。启用、恢复、接管是对整个功能的，不分网关；地址、密钥、模型列表和勾选是每家各自的。

```ts
interface GatewayProvider {
  /** 创建时由 name 生成，之后不变。它是模型标识的前缀，也是钥匙串账户名的一部分 */
  id: string;
  /** 显示名，可以随时改 */
  name: string;
  baseUrl: string;
  /** "chat" 或 "responses"，拉取模型时探明 */
  protocol: string;
  hasKey: boolean;
  /** 上次拉取模型失败的原因：「地址连不上」「密钥不对」「地址不对，没拿到模型列表」；
   *  null 表示上次成功或还没拉过。拉取成功、或改了地址时清空 */
  unreachable: string | null;
  /** slug 是这个模型在 Codex 里的标识，固定为「网关 id-模型名」：两家都有同名模型也不相撞 */
  models: { id: string; slug: string; displayName: string; selected: boolean }[];
}

interface GatewayState {
  supported: boolean;
  /** 全部网关，按添加顺序 */
  providers: GatewayProvider[];
  /** 第一家，等于 providers[0]；一家都没有时各字段为空。只给还没迁到 providers 的界面用，迁完后删 */
  provider: GatewayProvider;
  enabled: boolean;
  needsCodexRestart: boolean;
  /** protocol 是 "chat" 或 "responses"，界面只读展示，不给改 */
  router: { installed: boolean; running: boolean; port: number; protocol: string; error: string };
  codex: { version: string; running: boolean; catalogVersion: string; drift: boolean };
  /** 非空：Codex 设置里有别的工具写的同名项或 provider，启用不可用 */
  conflict: string;
  /** 非空：本机当前由 agents-manager 启用，可以接管 */
  takeover: { baseUrl: string; selectedCount: number } | null;
}
```

| 命令 | 参数 | 说明 |
|---|---|---|
| `gateway_state` | — | 只读 |
| `gateway_upsert_provider` | `id?: string, name?: string, baseUrl: string, key?: string` | 返回 `{ providerId: string; state: GatewayState }`。`id` 省略是**新建**一家；`name` 省略时新建用地址里的主机名、修改时不改名；`key` 省略或为空表示不动已存的密钥。带了密钥就先向网关校验，失败什么都不保存（也不标 `unreachable`：已存的配置没变）；成功时一并拉回模型列表并清空 `unreachable`。改了地址时 `unreachable` 清空。新建时密钥没存成，这一家不会留下 |
| `gateway_remove_provider` | `id: string` | 删掉这一家、它的模型和**钥匙串里的密钥（不可恢复，确认由界面负责，后端不再二次确认）**。已启用时同步重写目录，它的模型进停用名单；已启用且它是最后一家还在发布模型的网关时拒绝（`invalid`），请先恢复 |
| `gateway_fetch_models` | `providerId?: string` | 用钥匙串里的密钥拉取。成功时并入模型列表并清空这一家的 `unreachable`；拉取失败（`auth` / `network`）时把短原因记到这一家的 `unreachable` 并落盘，模型和勾选不动，然后照常返回错误。界面的「再试一次」用 `api.gatewayRetryProvider`，它吞掉这两种错误、改为返回最新 state |
| `gateway_select_models` | `selected: { id: string; displayName: string }[], providerId?: string` | `selected` 是**这一家**的完整勾选，不影响别家。已启用时同时重写目录和路由清单 |
| `gateway_enable` | — | 先让路由常驻并确认健康，再写 Codex 设置。有模型要发布的每一家都必须有地址和密钥，缺的那家会在错误信息里点名；没勾选模型的网关不挡路 |
| `gateway_restore` | — | 移除本功能写入的一切；各家的地址、模型和密钥保留 |
| `gateway_restart` | — | `launchctl kickstart -k` 重启本机路由服务。**只重启我们自己装的 launchd 服务，不碰 Codex**；不写 `~/.codex/config.toml`，所以不取 `config_lock`。失败时原样转述 `launchctl` 的话，代码 `router_down`。界面上不给按钮，保留为内部能力 |
| `gateway_restart_codex` | — | 返回 `{ terminated: number; pids: number[] }`，不是 `GatewayState`。结束 Codex 的后台进程（`codex app-server` 与 `codex-code-mode-host`，SIGTERM），下次任何工具拉起 Codex 时才读到新配置。**不碰用户在终端里的交互式 `codex` 会话**；一个都没找到不算失败，返回 `terminated: 0`。不写 `~/.codex/config.toml`，所以不取 `config_lock` |
| `gateway_launch_codex` | — | 返回空。按应用标识打开 Codex 桌面应用（`open -b com.openai.codex`，不写死路径），只发出打开请求、不等它起来——界面轮询 `codex.running`。打不开时原样转述 `open` 的话，代码 `internal`。不写 `~/.codex/config.toml`，所以不取 `config_lock` |
| `gateway_takeover` | — | 接管 agents-manager 的现有配置，生成 id 为 `wecode` 的一家；不动用户自己加的网关 |

`providerId` 省略时作用在第一家上。旧命令 `gateway_save_provider(baseUrl, key)` 仍在：有网关时改第一家，没有时新建一家。
它和两个省略 `providerId` 的调用只为兼容旧界面，界面迁完后删。

几条界面需要知道的行为：

- 两家的已选模型显示名相同时，写进 Codex 选择器的名字会自动加上「 · 网关名」；`models[].displayName` 仍是用户填的原值。
- 已启用时改勾选、改地址、删网关，都会先确认后台路由是当前版本再写清单；路由起不来时返回 `router_down`，改动不保存。
- 模型标识带网关前缀，所以旧的单网关设置升级后标识会变（`x` 变成 `default-x`）。旧标识进停用名单，Codex 重启前请求它们会得到「请重启 Codex」的提示；Codex 的默认模型若指向旧标识，会被改回启用前的值。

页面任何时候都不显示、不回显密钥。

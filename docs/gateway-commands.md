# 模型页的 Tauri 命令约定

所有命令只在 macOS 上有意义；其他系统上 `gateway_state` 返回 `supported: false`，其余命令返回错误。
命令都是 `async`，返回 `Result<GatewayState, String>`（`gateway_state` 同）。错误字符串以 `[代码] ` 开头，
代码取值：`auth`、`network`、`conflict`、`invalid`、`router_down`、`changed`（配置在操作期间被别人改了，请重试）、`internal`。

```ts
interface GatewayState {
  supported: boolean;
  provider: {
    baseUrl: string;
    hasKey: boolean;
    models: { id: string; slug: string; displayName: string; selected: boolean }[];
  };
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
| `gateway_save_provider` | `baseUrl: string, key: string`（`key` 为空表示不改密钥） | 带新密钥时先向网关校验，失败什么都不保存；成功时一并拉回模型列表 |
| `gateway_fetch_models` | — | 用钥匙串里的密钥拉取；失败不改已保存内容 |
| `gateway_select_models` | `selected: { id: string; displayName: string }[]` | 已启用时同时重写目录和路由清单 |
| `gateway_enable` | — | 先让路由常驻并确认健康，再写 Codex 设置 |
| `gateway_restore` | — | 移除本功能写入的一切 |
| `gateway_restart` | — | `launchctl kickstart -k` 重启本机路由服务。**只重启我们自己装的 launchd 服务，不碰 Codex**；不写 `~/.codex/config.toml`，所以不取 `config_lock`。失败时原样转述 `launchctl` 的话，代码 `router_down` |
| `gateway_takeover` | — | 接管 agents-manager 的现有配置 |

页面任何时候都不显示、不回显密钥。

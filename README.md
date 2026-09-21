# Sophia

一台机器上装了七八个 AI coding 工具，每个都有自己放 skill 的目录、自己的 MCP 配置文件、自己的模型设置。同一个 skill 想在 Claude Code 和 Codex 下都能用，得手动软链两遍；链坏了没人告诉你。

Sophia 把这些摊平成一张表：**哪个 skill 在哪个 agent 下现在能不能用**；点了没成的话，**是什么挡住了**。

## 它做什么

**Skill 矩阵**——行是 skill，列是 agent，格子是圆点。实心＝已链接，空心＝可以链接，点一下就建；再点一下撤掉。内置 41 个 harness 的目录规则，只列你装了的。链坏了、同名撞了、整个目录被软链走了，都进底部的待处理栏，各带自己的动作。

**只建软链，从不动源文件。** Unix 用相对软链，Windows 用 junction。删本体才会真删，而且是移到废纸篓，弹窗里先把完整路径、目录大小、受影响的链接数摆给你看。

**MCP 配置**——同一份 MCP 服务定义，写进别的工具的配置文件里。只新增，从不覆盖也不删除；写进已有文件前先备份、原子替换、写前写后各校验一次指纹。跨域写入（会把请求头和令牌一并复制过去）要确认一道。

**模型网关（macOS）**——让 Codex 用上第三方网关的模型：本机起一个回环路由做协议转换（Responses ↔ Chat Completions），launchd 常驻，改 `~/.codex/config.toml` 只增删两个根键、逐字节可还原。可以配多家网关，各自的密钥进钥匙串，**不落盘、不进配置文件**。菜单栏有个托盘面板，关窗不退出。

## 装与跑

```bash
npm ci
make dev          # 开发窗口
make build        # 出 debug App，在 target/debug/bundle/
make test         # 提交前必跑：core / gateway / clippy / 前端构建与测试 / 界面规范检查
```

Skill 与 MCP 两页在 macOS、Linux、Windows 上都能用；模型页与托盘只在 macOS 上出现（其余系统据 `supported: false` 自行隐藏）。

## 代码怎么分的

| 目录 | 是什么 |
|---|---|
| `crates/core`（`symsync-core`） | 全部纯逻辑：发现、扫描、生成动作、安全写文件。**无异步、无网络、不依赖 tauri** |
| `crates/gateway`（`symsync-gateway`） | 模型网关：本机路由、协议转换、launchd、系统代理、钥匙串。异步和网络只允许出现在这里 |
| `src-tauri` | 命令层，每个命令一行调 core |
| `src` | React + TypeScript 界面 |

`crates/core/src/atomicfile.rs` 是写用户配置文件的唯一通道：快照、备份、原子替换、写前写后指纹校验、拒绝软链父目录。测试不 mock 文件系统，一律在临时目录里搭真实文件树。

界面的硬性约束写在 [`docs/DESIGN.md`](docs/DESIGN.md)，`scripts/lint-ui.mjs` 把其中能机器检查的部分变成了断言，接在 `make lint` 里。零色彩、零阴影、零渐变；强调只有三档：次要文字、加粗、反色。

## 许可证

MIT，见 [LICENSE](LICENSE)。派生自其他 MIT 项目的部分列在 [NOTICE](NOTICE)。

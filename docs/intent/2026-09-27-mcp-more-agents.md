---
type: intent
description: MCP 从 3 家 agent 扩到与 skill 相称的覆盖面，分批加
created: 2026-09-27
---

# MCP 支持更多 agent

调研依据见 `docs/research/2026-09-27-magpie.md`（magpie 支持 11 种 MCP 配置格式）与 `docs/research/2026-09-11-mcp-config-compatibility.md`（现有 3 家的官方核实与无损原则）。

## 问题

Sophia 的 skill 认得 40 家 agent，MCP 只认 3 家：Claude Code、Codex、Cursor（`crates/core/src/mcp.rs:26`）。产品负责人：「MCP 支持 11 家的格式，可以对照着分批加，这个也可以做」。

- **两页对不上。** 同一台机器上，SKILLS 页有 Gemini CLI、Copilot、OpenCode 等列，切到 MCP 页只剩三列，用户会以为那几家没装，或者以为 Sophia 坏了。
- **最常见的几家用不上。** Gemini CLI、GitHub Copilot CLI、OpenCode、Claude Desktop 用的人不少，它们的 MCP 现在只能各自手改配置文件。
- **市场装的 MCP 也受限。** 即将做的 MCP 市场与「粘贴 JSON 添加 MCP」（`docs/intent/2026-09-27-skill-mcp-market.md`），装的时候只能选这三家。

## 期望结果

- **MCP 页的列和 SKILLS 页对得上**：装了、且 Sophia 支持其 MCP 的 agent 都成列；还不支持的，说清是「这一家的 MCP 还不支持」，而不是悄悄不显示。
- **新加的每一家，行为和现有三家一样**：能读出已有的服务器、能从别家写进来、能删、能撤销；写不过去的字段或传输方式，在格子上说清原因，不丢字段、不强写。
- **分批交付，每批独立可用**：先上格式最接近、用户最多的几家。

## 候选与分批

下表的配置位置与写法取自 magpie 的实现（`internal/library/targets.go`、`internal/library/mcp.go`），**只作线索**。现有三家的标准是官方文档核实，新加的每一家同样要先核实官方文档，尤其是项目级的位置（magpie 只管用户级，没有项目级）。

| 批次 | agent | 用户级配置（magpie 的写法） | 与现有三家的差别 |
|---|---|---|---|
| 第一批 | Gemini CLI | `~/.gemini/settings.json`，`mcpServers` | 远程 HTTP 的地址字段叫 `httpUrl`，SSE 才叫 `url` |
| 第一批 | GitHub Copilot CLI | `~/.copilot/mcp-config.json`（`$COPILOT_HOME`），`mcpServers` | 本地服务器 `type: "local"`；要带 `tools` 列表 |
| 第一批 | Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`，`mcpServers` | 只能跑本地命令，远程服务器要在它自己的「连接器」里加；没有项目级 |
| 第二批 | OpenCode | `~/.config/opencode/opencode.json(c)`，`mcp` | 可能是带注释的 JSONC；命令写成一个数组；环境变量叫 `environment`；`type` 是 `local` / `remote`；带 `enabled` |
| 第二批 | Crush | `crush.json`，`mcp` | 外层键不同，字段与 Claude 相近 |
| 第二批 | ZCode | `~/.zcode/cli/config.json`，`mcp.servers` | 嵌套一层；ZCode 目前不在 skill 的 agent 表里 |
| 第三批 | Goose | `~/.config/goose/config.yaml`，`extensions` | **YAML**，Sophia 还没有 YAML 的文本级改写；字段叫 `cmd` / `uri` / `envs`，带 `timeout`；不支持 SSE |
| 第三批 | Pi | `~/.pi/agent/mcp.json` | Pi 本身没有 MCP，靠第三方扩展读这个文件；两个扩展认的传输字段不同（`transport` / `httpTransport`） |

分批理由：第一批都是 JSON、外层键与现有写法一样，只差字段映射；第二批要处理 JSONC、数组形式的命令、嵌套键；第三批要新写 YAML 改写，或依赖第三方扩展，风险最高。

## 约束

- **无损原则不变**（`docs/research/2026-09-11-mcp-config-compatibility.md`）：目标家表达不了的字段或传输方式，拒绝写入并说明原因；不学 magpie 那样丢掉字段继续写、或直接覆盖不一样的定义。
- **写配置只走 `atomicfile`**，保留原文件的注释、顺序、BOM、换行；JSONC 与 YAML 在做到「逐字节只动那一项」之前，只读不写。
- **每家先以官方文档核实**配置位置（用户级、项目级）、字段、传输、环境变量写法，写进 MCP 兼容性调研；没核实的项不写。
- **格子状态与交互沿用现有 MCP 页**：⦿ 有、○ 没有、⊘ 写不过去；删最后一份才确认。
- **Claude Desktop 这类「应用」**（不是 coding agent）进不进列、怎么叫，要和 skill 页的 agent 表对齐着定。

## 范围外

- 管理各家 MCP 的开关、工具过滤、超时、OAuth 等客户端专属设置。
- 不在 skill 的 agent 表里、也不在上表里的 agent。

## 待决问题

- **Q1 第一批放哪几家**：Gemini CLI、Copilot CLI、Claude Desktop，还是换成 OpenCode（用户多，但有 JSONC）？
- **Q2 Claude Desktop 算不算一列**：它不是 coding agent，但 MCP 用户很多；进 MCP 页、不进 SKILLS 页，两页的列会不一致。
- **Q3 JSONC 与 YAML**：要不要为 OpenCode、Goose 写「保留注释」的改写？还是先只读，显示有哪些服务器，但不往里写？
- **Q4 列太多怎么办**：MCP 页的 agent 列会变多，沿用设置里的「列表里的 agent · 最多 N 个」吗？

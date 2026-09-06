# 调研：Agent Skill 管理工具现状（2026-09-06）

目的：SymSync 从通用软链工具转向"多 harness skill 同步管理"前，摸清市场上已有产品、可借鉴之处和空白。

## 一、上游约定：vercel-labs/skills（`npx skills`，30k★）

- 全局：本体在 `~/.agents/skills/<name>`，再软链到各 harness 的全局目录（`~/.claude/skills`、`~/.codex/skills` …）。
- 项目：本体在 `<项目>/.agents/skills/<name>`，8 个"通用型" harness（Codex、Cursor、Gemini CLI、Copilot、OpenCode、Cline、Amp、Kimi）直接读该目录，其余用相对软链。
- 支持 40 个 harness，目录表见 [Supported Agents](https://vercel-labs-skills.mintlify.app/guides/supported-agents)。
- 命令：`add / list / find / remove / update / init`。**没有 status、doctor、repair。**
- 已知缺口（均为 open issue）：全局安装后不建软链 [#744](https://github.com/vercel-labs/skills/issues/744) [#851](https://github.com/vercel-labs/skills/issues/851) [#537](https://github.com/vercel-labs/skills/issues/537)；缺 repair 命令 [#1025](https://github.com/vercel-labs/skills/issues/1025)；`update` 会把 `--copy` 装的副本改回软链，破坏 git 跨平台 [#1199](https://github.com/vercel-labs/skills/issues/1199)。

## 二、已有产品

| 产品 | 星 | 形态 | 本体位置 | 项目级 | 状态诊断 | 备注 |
|---|---|---|---|---|---|---|
| [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager) | 4475 | Tauri/Rust 桌面 + CLI | 自有库 + SQLite | Project Workspace，可与库比对、双向同步 | deploy/undeploy/status | 预设、Git 备份多机同步、marketplace、让 agent 通过 CLI 驱动它 |
| [jiweiyeah/Skills-Manager](https://github.com/jiweiyeah/Skills-Manager) | 977 | 跨平台桌面 + `skm` CLI | `~/.skills-manager/skills` | 无 | `skm doctor` / `skm fix` | Windows 用 junction；不能软链时"tracked copy"并写 `.skills-manager-source.json` 记来源 |
| [skillhub-club/skillhub-desktop](https://github.com/skillhub-club/skillhub-desktop) | 597 | Tauri | — | — | — | 偏 marketplace 客户端，3 月后未更新 |
| [yibie/skills-manager](https://github.com/yibie/skills-manager) | 439 | **原生 SwiftUI**，Developer ID 公证，非 App Store | Library → Collection → Mount | Collection 可挂到项目 | missing / shared / partially applied / diverged | takeover 保留可恢复备份、拒绝模糊的破坏性修复；durable skill ID；含 TUI |
| [Harries/skills-desktop](https://github.com/Harries/skills-desktop) | 349 | 桌面 | — | 手动配置项目路径，扫描 `.claude/skills` | 安全扫描 | 只管 Claude Code |
| [Loadout](https://loadout.migsilva.dev/) | 47 | **原生 SwiftUI**，公证，Homebrew 分发 | 分享给第二个 harness 时"提升"到 `~/.agents/skills` 再软链 | — | — | 按目录是否存在自动发现 harness；还管 subagent / command / MCP |
| [beautyfree/skiller](https://github.com/beautyfree/skiller) | 46 | Electron | 49 个 harness | 有 | dashboard | 读 skills CLI 的 `.skill-lock.json` |
| [umutbozdag/agent-skills-manager](https://github.com/umutbozdag/agent-skills-manager) | 34 | Web/Node | 就地管理，不设库 | 手动添加 + 全盘扫描 | — | 也管 rules/AGENTS.md；启用/停用靠重命名 SKILL.md |
| [awesome-skills/agent-skills-manager](https://github.com/awesome-skills/agent-skills-manager) | 6 | Shell 脚本 | `~/.agents_skills` | 无 | — | 中文社区"宝玉方案"，一份原件全软链 |
| [bazoocaze/agisk](https://github.com/bazoocaze/agisk) | 0 | Python CLI | `~/.agisk/skills` | `agisk use` 在项目里建链 | — | 包管理器思路 |
| Skills Desktop（[skills-desktop.vercel.app](https://skills-desktop.vercel.app/)） | — | Electron | `~/.agents/skills` | — | 每格 valid / broken / inaccessible / missing 矩阵 | 与我们的矩阵设想最接近 |

Mac App Store 上**没有**同类产品；两款原生 Swift 应用都走公证 + DMG/Homebrew，回避了沙盒。

## 三、共识与可借鉴

1. **架构共识**：一份本体 + 软链到各 harness，无一例外。分歧只在本体放哪：多数自设库目录（`~/.skills-manager/skills`、`~/.skilldock`、`~/.agisk`），少数沿用 `~/.agents/skills`。
2. **harness 发现**：按目录是否存在判断已安装，不要让用户配置（Loadout、Skiller、xingkongliang）。
3. **状态矩阵**：skill × harness，每格 valid / broken / missing / inaccessible（Skills Desktop）；yibie 2.0 进一步区分 missing / shared / partially applied / **diverged**。
4. **诊断 + 修复分离**：`skm doctor` 报问题、`skm fix --yes` 才动手（jiweiyeah）。
5. **安全边界**：takeover 前留可恢复备份，模糊场景拒绝执行（yibie）；软链不可用时退化为"有来源记录的副本"（jiweiyeah 的 `.skills-manager-source.json`）。
6. **项目级**：xingkongliang 的 Project Workspace 能与中央库比对并双向同步，是目前项目级做得最完整的。
7. **让 agent 驱动工具**：xingkongliang 发布 CLI + `manage-skills` skill，让 Claude Code 等通过它操作而不是直接写目录。后续可考虑。

## 四、空白，也就是我们的位置

1. **不设库、不搬本体**：所有竞品都要求把本体收进它自己的库。用户已有的 `npx skills` 布局、手工软链、散落在 codex 里的真实目录，在它们那里都是"待导入"。我们只诊断现状并修链接，本体在哪认哪，天然兼容 `npx skills` 和任何手工方案。
2. **修 `npx skills` 留下的坑**：缺链、坏链、只在某个 harness 里的孤本，正是 #1025 要的 repair，而且带界面。
3. **项目域的 git 友好**：项目内用相对软链，跨域用带来源记录的复制 + 分叉检测，避开 #1199 那类问题。目前只有 xingkongliang 做了项目比对。
4. **Mac App Store**：空位。代价是沙盒，用户首次要授权主目录；两款原生竞品都没走这条路。

## 五、风险

- 市场拥挤，头部（4.4k★ Rust 应用）功能面很宽：预设、备份、marketplace、agent 驱动。我们不该在功能面上追，卖点必须锋利：**零配置诊断 + 安全修复 + 上架**。
- 原生 Swift 已有两家（yibie、Loadout），"原生"本身不是差异点。
- `.agents/skills` 通用约定在扩散，长期看全局软链需求会减少，项目级和分叉检测的价值会上升。

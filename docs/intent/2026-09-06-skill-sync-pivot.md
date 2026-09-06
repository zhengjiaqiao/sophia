# Intent: SymSync 转向多 harness skill 同步管理（跨平台）

- 状态：已接受
- 作者：jiaqiao
- 日期：2026-09-06
- 替代：`docs/intent/2026-09-02-symlink-sync.md` 的上架与技术栈约束
- 调研：`docs/research/2026-09-06-skill-manager-landscape.md`

## 问题

用户同时使用多个 AI coding harness（Claude Code、Codex、Cursor …），每个都有自己的全局和项目级 skill 目录。`npx skills` 用"本体放 `~/.agents/skills`、其他目录软链"的方式管理，但安装后经常缺链、留下坏链、或本体散落在某个 harness 目录里，且没有 status / repair 命令。用户看不到哪些 skill 在哪些 harness 里不同步。

## 期望结果

- 打开 App 自动发现已安装的 harness 和项目，展示 skill × harness 矩阵，每格状态一目了然。
- 一键补齐缺失链接、确认后清理坏链。工具**不搬本体、不复制内容**，本体在哪认哪。
- 保留通用的"源目录 → 多目标"软链同步功能。
- 跨平台：macOS、Windows、Linux。

## 影响的用户与系统

- 用户：多 harness 用户，先是作者本人；产品面向普通开发者。
- 系统：用户文件系统；各 harness 的目录约定；Windows 的 junction。

## 约束

- 不上 Mac App Store，不开沙盒，直接分发（签名 + 公证的 DMG）。
- 技术栈：Rust core + Tauri 2 + React/TypeScript。
- 极简：只维护软链接，不做全局到项目的复制与分叉比对，不做 marketplace、编辑、预设、CLI。
- 借用开源代码限 MIT 且注明出处：vercel-labs/skills 的 harness 目录表与链接策略。
- 永不静默覆盖或删除用户数据；唯一删除操作是确认后的坏链清理。
- 流程：Fable 负责 intent / spec / plan / 派发 / 验收，实现由低阶模型子代理并行完成。

## 不在范围内

- 全局 ↔ 项目的复制、内容分叉检测。
- 文件监听自动同步、marketplace、skill 编辑、预设、Git 备份、CLI。
- 自动更新与分发流程（另立 intent）。

## 待解决问题

- Windows 上各 harness 是否都跟随 junction 读取 skill 目录（Claude Code 官方已支持软链，junction 未明说）。

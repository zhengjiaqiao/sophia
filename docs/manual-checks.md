# 手动验证清单（每次改 App 层后跑）

启动：`make dev`

## Skills tab
- [ ] 左栏"全局"置顶；项目列表只包含仍存在且含 skill 目录的项目；"添加项目"打开系统选择框
- [ ] 全局矩阵的列与本机已安装 harness 一致（`ls -d ~/.claude ~/.codex ~/.cursor …`），通用仓库列在最前，Cline 合并进通用仓库列
- [ ] 每行状态与 `ls -l ~/.agents/skills ~/.claude/skills ~/.codex/skills` 对得上：本体 ●、链接 ✓、缺失 ○、坏链 ✗、指向他处 →、多本体 ⚠
- [ ] `hatch-pet`、`codex-primary-runtime` 这类只在 codex 里的真实目录：codex 列 ●，其余列 ○
- [ ] `ego-browser` 这类通用仓库本身是软链的：标"外部本体"，各列 ✓
- [ ] "同步缺失链接"按钮计数 = 摘要里的缺失数；执行后缺失格子变 ✓，`ls -l` 能看到绝对路径软链
- [ ] 重启 Claude Code / Codex 后，`/skills` 能看到新链上的 skill
- [ ] 手动做一个坏链（`ln -s ~/.agents/skills/nope ~/.claude/skills/nope`）→ 刷新出现 ✗ → "清理坏链"需二次确认 → 删除后消失；期间把它换成真实目录再确认删除，应显示"不再是软链接，已跳过"
- [ ] 多本体行整行淡显、无动作
- [ ] 项目域：补链后 `readlink <项目>/.claude/skills/<x>` 是 `../../.agents/skills/<x>`，`git status` 能记录该软链
- [ ] "移除"项目只影响手动添加的项目；Claude Code 记录的项目刷新后仍在（已知行为）

## 自定义同步 tab
- [ ] 新建、选源、切换整目录/指定子项、添加/移除目标、预览、执行、二次预览全"已链接"
- [ ] 同名真实文件显示"冲突"，执行后文件原样
- [ ] 删除源子项后预览出现"坏链"，清理需二次确认
- [ ] 退出重开记录仍在（`~/Library/Application Support/SymSync/rules.json`）

## 平台
- [ ] macOS：以上全部
- [ ] Windows：junction 建链、`readlink` 判定、删除（待有 Windows 机器时验证）

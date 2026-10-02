#!/bin/bash
# 真人测试用的隔离数据（docs/testing/2026-09-27-manual-test-cases.md）。
# 在 /private/tmp/sophia-qa 下搭一个假的主目录：各 agent 的 skill 目录、软链、失效链接、同名两份、两个项目、
# 六家 agent 的 MCP 配置；可选（--with-updates，要联网）再放两个「有新版本」的 skill 与 .skill-lock.json。
# 只写 /private/tmp/sophia-qa，不碰真实主目录。重跑只删掉 home/ 重建；执行者放在 evidence/ 等处的东西不动。
#
# 用法：
#   scripts/qa/make-fixture.sh                 # 基础数据
#   scripts/qa/make-fixture.sh --with-updates  # 另加查更新用的数据（从 codeload 下 anthropics/skills）
# 启动（debug 版才认 SOPHIA_TEST_HOME）：
#   SOPHIA_TEST_HOME=/private/tmp/sophia-qa/home <Sophia.app>/Contents/MacOS/Sophia
set -euo pipefail

ROOT=/private/tmp/sophia-qa
H="$ROOT/home"
P="$H/Projects"
WITH_UPDATES=0
[ "${1:-}" = "--with-updates" ] && WITH_UPDATES=1

rm -rf "$H" "$ROOT/tmp"
mkdir -p "$H" "$P"

skill() { # skill <目录> <名字> <一句说明>
  mkdir -p "$1"
  printf -- '---\nname: %s\ndescription: %s\n---\n\n# %s\n\n测试用 skill。\n' "$2" "$3" "$2" > "$1/SKILL.md"
}

# ── agent 目录（装没装：检测目录里要有配置文件，不能只有 skills）──
mkdir -p "$H/.claude/skills" "$H/.codex/skills" "$H/.cursor/skills" "$H/.gemini" "$H/.copilot" "$H/.cline"
echo '{}' > "$H/.claude/settings.json"
echo '{}' > "$H/.cline/settings.json"
mkdir -p "$H/Library/Application Support/Claude"

# ── 用户级的 skill ──
# 通用仓库 ~/.agents/skills：brainstorming、writing-plans、defuddle
skill "$H/.agents/skills/brainstorming" brainstorming "Explore ideas before writing code."
skill "$H/.agents/skills/writing-plans" writing-plans "Write an implementation plan."
skill "$H/.agents/skills/defuddle" defuddle "Clean up web pages into markdown (copy A)."
# Claude Code 自己的原件：docx；另一份同名 defuddle（×2）
skill "$H/.claude/skills/docx" docx "Read and write Word documents."
skill "$H/.claude/skills/defuddle" defuddle "Clean up web pages into markdown (copy B)."
# 链接：brainstorming → Claude Code、Codex；writing-plans → Cursor
ln -s "$H/.agents/skills/brainstorming" "$H/.claude/skills/brainstorming"
ln -s "$H/.agents/skills/brainstorming" "$H/.codex/skills/brainstorming"
ln -s "$H/.agents/skills/writing-plans" "$H/.cursor/skills/writing-plans"
# 失效链接：原件已经不在了
ln -s "$H/.agents/skills/ghost-skill" "$H/.claude/skills/ghost-skill"

# ── 项目 ──
# CardBox：.agents/skills/card-render，Claude Code 项目目录里链接它；Claude Code 只有 Local MCP（没有 .mcp.json）
skill "$P/CardBox/.agents/skills/card-render" card-render "Render cards for CardBox."
mkdir -p "$P/CardBox/.claude/skills"
ln -s "$P/CardBox/.agents/skills/card-render" "$P/CardBox/.claude/skills/card-render"
# acme-web：.agents/skills/acme-release；有 .mcp.json、Copilot 的 .github/mcp.json
skill "$P/acme-web/.agents/skills/acme-release" acme-release "Release checklist for acme-web."
cat > "$P/acme-web/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "sentry": { "type": "http", "url": "https://mcp.sentry.dev/mcp" }
  }
}
EOF
mkdir -p "$P/acme-web/.github"
cat > "$P/acme-web/.github/mcp.json" <<'EOF'
{
  "mcpServers": {
    "acme-docs": { "type": "local", "command": "npx", "args": ["-y", "acme-docs-mcp"], "tools": ["*"] }
  }
}
EOF

# ── MCP 配置（值都是假的，没有真实密钥）──
# Claude Code 用户级 + 项目记录（~/.claude.json 的 projects 也决定侧栏认出哪些项目）
cat > "$H/.claude.json" <<EOF
{
  "mcpServers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" },
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${GITHUB_TOKEN}" } }
  },
  "projects": {
    "$P/CardBox": {
      "mcpServers": { "cardbox-local": { "command": "node", "args": ["server.js"] } }
    },
    "$P/acme-web": {}
  }
}
EOF
# Codex：postgres 只在这里；context7 地址不一样（2 份不一样）
cat > "$H/.codex/config.toml" <<'EOF'
model = "gpt-5"

[mcp_servers.postgres]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/qa"]

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp?variant=codex"
EOF
# Cursor：filesystem 与 Claude Code 那份一样
cat > "$H/.cursor/mcp.json" <<'EOF'
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}
EOF
# Gemini：带 trust 的（Gemini 专属设置）、一个 SSE（url 在 Gemini 里是 SSE）；另有与 MCP 无关的设置
cat > "$H/.gemini/settings.json" <<'EOF'
{
  "theme": "Default",
  "mcpServers": {
    "trusty": { "command": "npx", "args": ["-y", "trusty-mcp"], "trust": true },
    "sse-demo": { "url": "https://example.com/sse" }
  }
}
EOF
# Copilot：tools 不是全部（Copilot 专属）
cat > "$H/.copilot/mcp-config.json" <<'EOF'
{
  "mcpServers": {
    "copilot-only": { "type": "local", "command": "npx", "args": ["-y", "copilot-only-mcp"], "tools": ["search"] }
  }
}
EOF
# Claude Desktop：只有 filesystem
cat > "$H/Library/Application Support/Claude/claude_desktop_config.json" <<'EOF'
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}
EOF

# ── 可选：查更新用的数据（要联网）──
# 用 anthropics/skills 较早的一次提交（OLD）里的 xlsx、pptx 当「装的那一版」：GitHub 上查得到这一版的文件清单，
# 所以本地改过的能列出改了哪些文件。main 上这两个文件夹后来又改过 → 有新版本。
# xlsx：本地＝装的那一版（没改过）→ 直接更新；pptx：本地在装的那一版上又改了 SKILL.md → 更新前确认、列出 SKILL.md
OLD=1ed29a03dc852d30fa6ef2ca53a67dc2c2c2c563
if [ "$WITH_UPDATES" = 1 ]; then
  T="$ROOT/tmp"
  mkdir -p "$T"
  curl -fsSL -o "$T/skills.tar.gz" "https://codeload.github.com/anthropics/skills/tar.gz/$OLD"
  tar -xzf "$T/skills.tar.gz" -C "$T"
  SRC="$(find "$T" -maxdepth 1 -type d -name 'skills-*' | head -1)/skills"
  treesha() { # 按 git 规则算文件夹的 tree SHA
    local repo="$T/git-$$-$RANDOM"
    git init -q "$repo"
    cp -R "$1" "$repo/x"
    git -C "$repo" -c core.fileMode=true add -A
    local tree
    tree=$(git -C "$repo" write-tree)
    git -C "$repo" rev-parse "$tree:x"
    rm -rf "$repo"
  }
  mkdir -p "$H/.agents/skills"
  cp -R "$SRC/xlsx" "$H/.agents/skills/xlsx"
  XLSX_SHA=$(treesha "$H/.agents/skills/xlsx")
  cp -R "$SRC/pptx" "$H/.agents/skills/pptx"
  PPTX_SHA=$(treesha "$H/.agents/skills/pptx")
  printf '\n本地改过的一行（测试数据）\n' >> "$H/.agents/skills/pptx/SKILL.md"
  cat > "$H/.agents/.skill-lock.json" <<EOF
{
  "version": 3,
  "skills": {
    "xlsx": { "source": "anthropics/skills", "sourceType": "github", "sourceUrl": "https://github.com/anthropics/skills.git", "skillPath": "skills/xlsx/SKILL.md", "skillFolderHash": "$XLSX_SHA", "installedAt": "2026-02-10T00:00:00.000Z", "updatedAt": "2026-02-10T00:00:00.000Z" },
    "pptx": { "source": "anthropics/skills", "sourceType": "github", "sourceUrl": "https://github.com/anthropics/skills.git", "skillPath": "skills/pptx/SKILL.md", "skillFolderHash": "$PPTX_SHA", "installedAt": "2026-02-10T00:00:00.000Z", "updatedAt": "2026-02-10T00:00:00.000Z" }
  }
}
EOF
  rm -rf "$T"
fi

echo "测试数据已就绪：$H"
echo "启动：SOPHIA_TEST_HOME=$H <Sophia.app>/Contents/MacOS/Sophia"

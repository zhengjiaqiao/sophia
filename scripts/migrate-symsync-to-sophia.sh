#!/bin/bash
# 一次性：把本机改名前（SymSync）的数据迁到 Sophia 名下。只给改名前就在用开发版的机器跑一次；
# 正式发布之后不再需要，可以删掉这个脚本。
#
# 做的事：
#   1. 数据目录 ~/Library/Application Support/SymSync 复制成 …/Sophia（不含旧的后台程序副本 bin/）
# 不做的事：
#   - 不迁网关密钥：新版的密钥存在数据目录的 secrets.json，不再读钥匙串，迁完在模型页重新填写
#   - 不删旧数据、不删旧钥匙串条目：确认新版一切正常后自己删
#   - 不碰 ~/.codex、~/.claude 与后台服务：它们要先在旧版里关掉（见下面的前提检查），迁完在新版里重新打开
#   - 界面自己记的东西（上次停在哪一页、看过哪些提示）不迁：新版按首次打开处理
#
# 用法：先退出所有 Sophia / SymSync，然后
#   scripts/migrate-symsync-to-sophia.sh
set -euo pipefail

SUPPORT="$HOME/Library/Application Support"
OLD_DIR="$SUPPORT/SymSync"
NEW_DIR="$SUPPORT/Sophia"
OLD_SERVICE=symsync
OLD_AGENT="$HOME/Library/LaunchAgents/com.zhengjiaqiao.symsync.gateway.plist"

fail() { echo "✗ $1" >&2; exit 1; }

# ── 前提 ──
if pgrep -f "Contents/MacOS/symsync|target/debug/symsync|Contents/MacOS/Sophia|target/debug/sophia" >/dev/null; then
  fail "还有 Sophia / SymSync 在运行，先全部退出（菜单栏图标 → 退出）"
fi
if [ -f "$OLD_AGENT" ]; then
  fail "旧的后台服务还装着：先打开旧版，在模型页关掉第三方模型并「卸下后台服务」，再跑这个脚本"
fi
if grep -qs "symsync-models.json" "$HOME/.codex/config.toml"; then
  fail "Codex 的第三方模型还开着（~/.codex/config.toml 里有 symsync-models.json）：先在旧版里关掉，再跑这个脚本"
fi
if grep -qs "127.0.0.1:47328" "$HOME/.claude/settings.json"; then
  fail "Claude Code 的第三方模型还开着（~/.claude/settings.json 指向本机网关）：先在旧版里关掉，再跑这个脚本"
fi

# ── 1. 数据目录 ──
if [ ! -d "$OLD_DIR" ]; then
  echo "· 没有旧数据目录（${OLD_DIR}），跳过"
elif [ -e "$NEW_DIR" ] && [ -n "$(ls -A "$NEW_DIR" 2>/dev/null)" ]; then
  fail "新数据目录已经有东西了（${NEW_DIR}）：不覆盖。确认里面的东西不要了就先删掉它再跑"
else
  mkdir -p "$NEW_DIR"
  # 旧的后台程序副本不搬：新版打开第三方模型时会按新名字重新放一份
  (cd "$OLD_DIR" && tar -cf - --exclude ./bin .) | (cd "$NEW_DIR" && tar -xpf -)
  echo "✓ 数据目录已复制：$OLD_DIR → $NEW_DIR"
fi

cat <<EOF

迁移完成。打开新版 Sophia 确认设置、订阅、网关都在；网关密钥在模型页逐家重新填写，
第三方模型需要的话在新版里重新打开。都正常之后，再删掉旧的：
  rm -rf "$OLD_DIR"
  钥匙串里服务名 $OLD_SERVICE 的条目（「钥匙串访问」里搜 $OLD_SERVICE 删掉）
EOF

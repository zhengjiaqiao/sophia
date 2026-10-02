#!/bin/bash
# 一次性：把本机改名前（SymSync）的数据迁到 Sophia 名下。只给改名前就在用开发版的机器跑一次；
# 正式发布之后不再需要，可以删掉这个脚本。
#
# 做的事：
#   1. 数据目录 ~/Library/Application Support/SymSync 复制成 …/Sophia（不含旧的后台程序副本 bin/）
#   2. 钥匙串里服务名 symsync 的条目（网关密钥）逐条复制到服务名 Sophia 下，值原样搬（经标准输入，不进命令行参数）
# 不做的事：
#   - 不删旧数据、不删旧钥匙串条目：确认新版一切正常后，按末尾打印的命令自己删
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
NEW_SERVICE=Sophia
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

# ── 2. 钥匙串 ──
# 只列元数据，不读值，不会弹授权
accounts=$(security dump-keychain 2>/dev/null | awk -v svc="\"svce\"<blob>=\"$OLD_SERVICE\"" '
  /^keychain: / { if (hit && acct != "") print acct; acct = ""; hit = 0; next }
  index($0, "\"acct\"<blob>=\"") { a = $0; sub(/.*"acct"<blob>="/, "", a); sub(/"[[:space:]]*$/, "", a); acct = a }
  index($0, svc) { hit = 1 }
  END { if (hit && acct != "") print acct }
' | sort -u)

if [ -z "$accounts" ]; then
  echo "· 钥匙串里没有服务名 $OLD_SERVICE 的条目，跳过"
else
  echo "· 钥匙串里要复制的条目：$(echo "$accounts" | tr '\n' ' ')（读值时系统会问一次是否允许，选「允许」）"
  while IFS= read -r acct; do
    [ -n "$acct" ] || continue
    value=$(security find-generic-password -s "$OLD_SERVICE" -a "$acct" -w) || fail "读不出 $acct"
    # 应用存的是编码后的值（字母数字与少数符号），原样搬；含引号等意外字符就停下，不冒险拼命令
    case "$value" in
      *[!A-Za-z0-9+/=:._-]*) fail "$acct 的值里有意外字符，没复制；请在新版里重新填这个密钥" ;;
    esac
    printf "add-generic-password -U -s '%s' -a '%s' -w '%s'\n" "$NEW_SERVICE" "$acct" "$value" | security -i \
      || fail "写不进 $NEW_SERVICE / $acct"
    echo "✓ 钥匙串：$OLD_SERVICE / $acct → $NEW_SERVICE / $acct"
  done <<< "$accounts"
fi

cat <<EOF

迁移完成。打开新版 Sophia 确认设置、订阅、网关都在，第三方模型需要的话在新版里重新打开。
都正常之后，再删掉旧的：
  rm -rf "$OLD_DIR"
EOF
if [ -n "$accounts" ]; then
  while IFS= read -r acct; do
    [ -n "$acct" ] && echo "  security delete-generic-password -s $OLD_SERVICE -a '$acct'"
  done <<< "$accounts"
fi

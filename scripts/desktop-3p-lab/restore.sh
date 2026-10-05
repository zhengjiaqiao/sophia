#!/usr/bin/env bash
# 把 backup.sh 做的备份原样放回去。
#
# 用法：scripts/desktop-3p-lab/restore.sh <备份目录>
#   备份目录就是 backup.sh 最后打印的那个 claude-desktop-backup-<时间>/。
#
# 做法（不直接删任何东西）：
#   1. 确认 Claude 桌面应用已完全退出；
#   2. 把现在的 Claude/、Claude-3p/ 改名挪到一旁：<名字>.before-restore-<时间>；
#   3. 从备份克隆（cp -c）一份放回原处，备份本身保持不动，可以反复恢复；
#   4. 逐个文件比内容（SHA-256）、软链比指向、比权限（treecmp.py）。
# 中途任何一步失败（含核对不一致）、收到 Ctrl+C / SIGTERM / SIGHUP、或没走到「完成」就退出：两个目录都回到恢复前——删掉这次放回的（只删自己复制出来的），把挪走的改名挪回来，
# 然后非零退出。每一步挪开、放回之前先把打算写进恢复日志（$CLAUDE_LAB_STATE_DIR/restore-journals/，见 lib.sh journal_*），
# 撤回按日志倒序、逐条看实际状态，挪完还没来得及往下走就被打断也撤得回。备份里没有 Claude-3p/ 时，只有备份带 NO-Claude-3p 标记才当成「备份时就不存在」。
# 挪到一旁的旧目录不会自动删，确认一切正常后按最后打印的命令自己删。
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[ $# -ge 1 ] || { sed -n '2,15p' "$0"; exit 2; }
case "$1" in -h|--help) sed -n '2,15p' "$0"; exit 0 ;; esac
SRC="$(cd "$1" 2>/dev/null && pwd)" || die "找不到备份目录：$1"
[ -d "$SRC/Claude" ] || die "$SRC 里没有 Claude/，不像是 backup.sh 做的备份。"
STAMP="$(date +%Y%m%d-%H%M%S)"

step "从备份恢复"
info "备份：$SRC"
[ -f "$SRC/manifest.txt" ] && sed 's/^/      /' "$SRC/manifest.txt"
info "恢复到："
lab_print_paths

require_desktop_quit
confirm_real "将把现在的 Claude/、Claude-3p/ 挪到一旁（改名，不删），再放回备份。"

# 恢复日志：先登记、后动手（见 lib.sh 的 journal_*）。撤回只看这份日志和磁盘上的实际状态
journal_open "$LAB_STATE_DIR/restore-journals/restore-$STAMP-$$.tsv"
info "恢复日志：$JOURNAL"

COMPLETE=0
ROLLED=0

# 失败或中断时把两个目录都放回恢复前的样子：删掉这次复制出来的（只删自己建的），把挪开的原件挪回原处
rollback_all() {
  trap '' INT TERM HUP   # 回滚本身不能再被打断
  ROLLED=1
  journal_rollback
}

fail() {
  trap - ERR
  warn "$1"
  [ "$ROLLED" = 1 ] && die "$1（回滚已经做过）"
  if [ "$(journal_count)" -eq 0 ]; then ROLLED=1; die "$1；还什么都没动。"; fi
  step "回滚：两个目录都放回恢复前的样子（按恢复日志倒序）"
  if rollback_all; then
    die "$1；两个目录都已放回恢复前的样子，这次恢复没有生效。"
  fi
  die "$1；回滚也没做完（见上），现在可能是混合状态：原件在 *.before-restore-${STAMP}*，备份在 ${SRC}，恢复日志 ${JOURNAL}，交给人。"
}
# 任何没接住的失败（set -e 会退出的那种）、Ctrl+C、SIGTERM、挂断也先回滚；
# 兜底：没走到「完成」就退出（不管什么原因）时，EXIT 里再查一次，日志里登记过的都撤回
trap 'fail "第 $LINENO 行的命令失败"' ERR
trap 'fail "收到 SIGINT（Ctrl+C），中断"' INT
trap 'fail "收到 SIGTERM，中断"' TERM
trap 'fail "收到 SIGHUP，中断"' HUP
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$COMPLETE" != 1 ] && [ "$ROLLED" != 1 ] && [ "$(journal_count)" -gt 0 ]; then
    step "回滚：没走到「完成」就退出，两个目录都放回恢复前的样子"
    rollback_all || warn "回滚没做完（见上）：原件在 *.before-restore-${STAMP}*，备份在 ${SRC}，恢复日志 ${JOURNAL}，交给人。"
    [ "$rc" = 0 ] && rc=1
  fi
  exit "$rc"
}
trap on_exit EXIT

# 备份里没有某个目录，只在备份明确记着「备份时就不存在」时才算「保持没有」
[ -d "$SRC/Claude-3p" ] || [ -e "$SRC/NO-Claude-3p" ] \
  || die "$SRC 里没有 Claude-3p/，也没有 NO-Claude-3p 标记：备份不完整，什么也没动。"

restore_one() {
  local name="$1" cur="$LAB_BASE/$1" aside="$LAB_BASE/$1.before-restore-$STAMP"
  step "恢复 $name"
  # 挪开的名字必须是新的：已存在时 mv 会把目录挪进它里面，而不是改名
  local n=2
  while [ -e "$aside" ] || [ -L "$aside" ]; do
    aside="$LAB_BASE/$1.before-restore-$STAMP-$n"
    n=$((n + 1))
  done
  if [ -e "$cur" ] || [ -L "$cur" ]; then
    info "把现在的 $cur 挪到 $aside"
    journal_add move "$cur" "$aside"
    mv -n "$cur" "$aside" || fail "没能把 $cur 挪开"
    { [ -e "$cur" ] || [ -L "$cur" ]; } && fail "没能把 $cur 挪开"
  else
    aside=""
    info "现在没有 ${cur}。"
  fi
  if [ -d "$SRC/$name" ]; then
    info "从备份复制回 $cur"
    journal_add copy "$cur" "$aside"
    if ! cp -Rcp "$SRC/$name" "$cur" 2>/dev/null; then
      warn "克隆失败，改用普通复制。"
      rm -rf "${cur:?}"
      cp -Rp "$SRC/$name" "$cur" || fail "从备份复制 $name 失败"
    fi
  else
    info "备份里没有 ${name}（备份时就不存在），保持没有。"
  fi
}

restore_one Claude
restore_one Claude-3p

step "核对：恢复结果与备份逐个文件比内容（SHA-256）、软链比指向、比权限"
python3 "$LAB_SCRIPT_DIR/treecmp.py" "$SRC/Claude" "$LAB_DIR_1P" "$SRC/Claude-3p" "$LAB_DIR_3P" \
  || fail "恢复结果与备份不一致"
COMPLETE=1
trap - ERR INT TERM HUP EXIT

step "完成"
MOVED=()
while IFS="$(printf '\t')" read -r op x y; do [ "$op" = move ] && MOVED+=("$y"); done < "$JOURNAL"
if [ ${#MOVED[@]} -gt 0 ]; then
  info "恢复前的目录挪到了："
  for m in "${MOVED[@]}"; do info "  $m"; done
  info "打开 Claude 确认一切正常（对话、设置都在）后，可以自己删掉它们："
  for m in "${MOVED[@]}"; do printf '    rm -rf %q\n' "$m"; done
fi
info "提示：如果验证中在应用里「退出登录」过，服务端的登录会话可能已失效，恢复后仍需重新登录 claude.ai，这是正常的。"

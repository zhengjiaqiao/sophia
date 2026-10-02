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
#   4. 逐项比对文件数、字节数、软链数。
# 中途复制失败：删掉这次放回的半成品，把挪走的目录改名挪回来。
# 挪到一旁的旧目录不会自动删，确认一切正常后按最后打印的命令自己删。
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[ $# -ge 1 ] || { sed -n '2,13p' "$0"; exit 2; }
case "$1" in -h|--help) sed -n '2,13p' "$0"; exit 0 ;; esac
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

MOVED=()
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
    mv -n "$cur" "$aside"
    [ -e "$cur" ] && die "没能把 $cur 挪开，什么也没恢复。"
    MOVED+=("$aside")
  else
    aside=""
    info "现在没有 ${cur}。"
  fi
  if [ -d "$SRC/$name" ]; then
    info "从备份复制回 $cur"
    if ! cp -Rcp "$SRC/$name" "$cur" 2>/dev/null; then
      warn "克隆失败，改用普通复制。"
      rm -rf "${cur:?}"
      if ! cp -Rp "$SRC/$name" "$cur"; then
        rm -rf "${cur:?}"
        [ -n "$aside" ] && mv "$aside" "$cur"
        die "复制失败，已把原来的 $name 挪回原处。"
      fi
    fi
  else
    info "备份里没有 ${name}（备份时就不存在），保持没有。"
  fi
}

restore_one Claude
restore_one Claude-3p

step "核对：恢复结果与备份逐项比对"
python3 - "$SRC/Claude" "$LAB_DIR_1P" "$SRC/Claude-3p" "$LAB_DIR_3P" <<'PY'
import os, sys

def tally(root):
    files = links = dirs = size = 0
    for dp, dns, fns in os.walk(root, followlinks=False):
        dirs += len(dns)
        links += sum(1 for n in dns if os.path.islink(os.path.join(dp, n)))
        for n in fns:
            p = os.path.join(dp, n)
            if os.path.islink(p):
                links += 1
            else:
                files += 1
                size += os.lstat(p).st_size
    return files, links, dirs, size

args = sys.argv[1:]
bad = False
for bak, cur in zip(args[0::2], args[1::2]):
    if not os.path.isdir(bak):
        exists = os.path.lexists(cur)
        print(f"    {os.path.basename(cur)}：备份里没有，现在{'却存在！' if exists else '也没有'}")
        bad |= exists
        continue
    a, b = tally(bak), tally(cur)
    ok = a == b
    bad |= not ok
    print(f"    {os.path.basename(cur)}：备份 {a[0]} 文件 / {a[3]} 字节；现在 {b[0]} 文件 / {b[3]} 字节 → {'一致' if ok else '不一致！'}")
sys.exit(1 if bad else 0)
PY

step "完成"
if [ ${#MOVED[@]} -gt 0 ]; then
  info "恢复前的目录挪到了："
  for m in "${MOVED[@]}"; do info "  $m"; done
  info "打开 Claude 确认一切正常（对话、设置都在）后，可以自己删掉它们："
  for m in "${MOVED[@]}"; do printf '    rm -rf %q\n' "$m"; done
fi
info "提示：如果验证中在应用里「退出登录」过，服务端的登录会话可能已失效，恢复后仍需重新登录 claude.ai，这是正常的。"

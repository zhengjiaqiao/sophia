#!/usr/bin/env bash
# 完整备份 Claude 桌面应用的两个数据目录：
#   ~/Library/Application Support/Claude      （标准模式：登录状态、本地 Cowork / Code 会话索引、设置……）
#   ~/Library/Application Support/Claude-3p   （第三方模式，存在才备份）
#
# 用法：scripts/desktop-3p-lab/backup.sh [备份放在哪个目录下]
#   不给参数时放在 ~/claude-desktop-lab/backups/claude-desktop-backup-<时间>/。
#   默认不放桌面：本机「桌面与文稿」开了 iCloud 同步，备份里有登录 Cookie、体积十几 GB，不该上传。
#   确实要放进 iCloud 同步目录，加 --allow-icloud。
#
# 做法：同一块 APFS 盘上用 cp -c（clonefile）克隆，几秒完成、几乎不占额外空间；克隆失败退回普通复制。
# 复制完逐个比对文件数、总字节数、软链数，对不上就报错。只读源目录，不改它。
# 可重复运行：每次都新建一个带时间戳的目录，不覆盖旧备份。
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ALLOW_ICLOUD=0
PARENT=""
for a in "$@"; do
  case "$a" in
    --allow-icloud) ALLOW_ICLOUD=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) PARENT="$a" ;;
  esac
done
PARENT="${PARENT:-$LAB_BACKUP_ROOT}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$PARENT/claude-desktop-backup-$STAMP"

step "要备份的目录"
lab_print_paths
[ -d "$LAB_DIR_1P" ] || die "找不到 ${LAB_DIR_1P}，没有可备份的东西。"

require_desktop_quit

step "检查备份位置：$DEST"
if lab_in_icloud "$PARENT"; then
  if [ "$ALLOW_ICLOUD" = 1 ]; then
    warn "备份位置在 iCloud 同步目录里（你加了 --allow-icloud）。备份含登录 Cookie，会被上传。"
  else
    die "备份位置 $PARENT 在 iCloud 同步的「桌面与文稿」里：备份含登录 Cookie、体积很大，不该上传。换个目录，或加 --allow-icloud。"
  fi
fi
mkdir -p "$PARENT"
[ -e "$DEST" ] && die "$DEST 已存在（同一秒跑了两次？），过一秒再试。"
info "源目录大小："
du -sh "$LAB_DIR_1P" 2>/dev/null | sed 's/^/      /'
[ -d "$LAB_DIR_3P" ] && du -sh "$LAB_DIR_3P" 2>/dev/null | sed 's/^/      /'
info "备份所在磁盘剩余："
df -h "$PARENT" | tail -1 | sed 's/^/      /'
info "同盘时用 APFS 克隆，几乎不占额外空间；跨盘时会整份复制，请确认剩余空间够。"

mkdir -m 700 "$DEST"

# 复制一个目录：优先克隆，失败则删掉这次自己建的半成品、改用普通复制
copy_dir() {
  local src="$1" name
  name="$(basename "$src")"
  step "复制 $src → $DEST/$name"
  if cp -Rcp "$src" "$DEST/$name" 2>"$DEST/.cp-$name.err"; then
    info "已用 APFS 克隆复制。"
  else
    warn "克隆失败（$(head -1 "$DEST/.cp-$name.err")），改用普通复制，可能要几分钟。"
    rm -rf "${DEST:?}/$name"
    cp -Rp "$src" "$DEST/$name"
    info "已普通复制。"
  fi
  rm -f "$DEST/.cp-$name.err"
}

copy_dir "$LAB_DIR_1P"
if [ -d "$LAB_DIR_3P" ]; then
  copy_dir "$LAB_DIR_3P"
else
  info "没有 Claude-3p 目录，跳过（恢复时也会保持没有）。"
  : > "$DEST/NO-Claude-3p"
fi

step "核对：文件数、总字节数、软链数逐项比对"
python3 - "$LAB_DIR_1P" "$DEST/Claude" "$LAB_DIR_3P" "$DEST/Claude-3p" <<'PY'
import os, sys

def tally(root):
    files = links = dirs = size = 0
    for dp, dns, fns in os.walk(root, followlinks=False):
        dirs += len(dns)
        for n in dns:
            if os.path.islink(os.path.join(dp, n)):
                links += 1
        for n in fns:
            p = os.path.join(dp, n)
            st = os.lstat(p)
            if os.path.islink(p):
                links += 1
            else:
                files += 1
                size += st.st_size
    return files, links, dirs, size

args = sys.argv[1:]
bad = False
for src, dst in zip(args[0::2], args[1::2]):
    if not os.path.isdir(src):
        continue
    a, b = tally(src), tally(dst)
    ok = a == b
    bad |= not ok
    print(f"    {os.path.basename(src)}：源 文件 {a[0]} / 软链 {a[1]} / 目录 {a[2]} / {a[3]} 字节；"
          f"备份 文件 {b[0]} / 软链 {b[1]} / 目录 {b[2]} / {b[3]} 字节 → {'一致' if ok else '不一致！'}")
sys.exit(1 if bad else 0)
PY

step "写备份说明 $DEST/manifest.txt"
{
  echo "备份时间：$STAMP"
  echo "来源：$LAB_BASE"
  echo "桌面应用版本：$(defaults read "$LAB_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo 未知)"
  for f in "$LAB_DIR_1P/claude_desktop_config.json" "$LAB_DIR_3P/claude_desktop_config.json"; do
    printf '%s 的 deploymentMode：' "$f"
    python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("deploymentMode","（缺失）"))
except Exception as e: print("（读不了：%s）" % type(e).__name__)' "$f"
  done
  echo "恢复命令：$LAB_SCRIPT_DIR/restore.sh \"$DEST\""
} > "$DEST/manifest.txt"
sed 's/^/    /' "$DEST/manifest.txt"
# 记下最近一次备份（write-profile.sh 靠默认位置的 LATEST 判断「做过备份」）
echo "$DEST" > "$PARENT/LATEST"
mkdir -p "$LAB_BACKUP_ROOT" && echo "$DEST" > "$LAB_BACKUP_ROOT/LATEST"

step "完成。备份在：$DEST"
info "这份备份含登录 Cookie 等敏感数据，不要发给别人；验证做完、确认恢复无误后可以自己删掉。"
info "恢复（先 ⌘Q 退出 Claude）："
printf '\n    %q %q\n\n' "$LAB_SCRIPT_DIR/restore.sh" "$DEST"

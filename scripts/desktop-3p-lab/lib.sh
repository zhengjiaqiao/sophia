# shellcheck shell=bash
# desktop-3p-lab 各脚本共用的路径、检查与打印。由 backup.sh / restore.sh / write-profile.sh / inspect.sh 以 source 引入，不单独运行。
#
# 路径都能用环境变量换掉，演练时指向临时假目录，保证不碰真目录：
#   CLAUDE_LAB_BASE          放 Claude、Claude-3p 两个目录的地方，默认 ~/Library/Application Support
#   CLAUDE_LAB_BACKUP_ROOT   backup.sh 默认把备份放在这里，默认 ~/claude-desktop-lab/backups
#   CLAUDE_LAB_STATE_DIR     实验状态（原 appliedId 等）与抓包日志放这里，默认 ~/claude-desktop-lab
#   CLAUDE_LAB_APP           桌面应用包，默认 /Applications/Claude.app（找不到再试 ~/Applications/Claude.app）
#   CLAUDE_LAB_MANAGED_DIR   受管偏好目录，默认 /Library/Managed Preferences
#   CLAUDE_LAB_LOG_BASE      日志目录的上一级，默认 ~/Library/Logs
#   CLAUDE_LAB_SKIP_RUNNING_CHECK=1
#                            跳过「桌面应用是否在运行」的检查。只在 CLAUDE_LAB_BASE 指向别处（演练）时才认，
#                            指向真目录时设了也不理，照样检查。

set -u

LAB_REAL_BASE="$HOME/Library/Application Support"
LAB_BASE="${CLAUDE_LAB_BASE:-$LAB_REAL_BASE}"
LAB_BACKUP_ROOT="${CLAUDE_LAB_BACKUP_ROOT:-$HOME/claude-desktop-lab/backups}"
LAB_STATE_DIR="${CLAUDE_LAB_STATE_DIR:-$HOME/claude-desktop-lab}"
LAB_MANAGED_DIR="${CLAUDE_LAB_MANAGED_DIR:-/Library/Managed Preferences}"
LAB_LOG_BASE="${CLAUDE_LAB_LOG_BASE:-$HOME/Library/Logs}"
if [ -n "${CLAUDE_LAB_APP:-}" ]; then
  LAB_APP="$CLAUDE_LAB_APP"
elif [ -d /Applications/Claude.app ]; then
  LAB_APP=/Applications/Claude.app
else
  LAB_APP="$HOME/Applications/Claude.app"
fi
LAB_BUNDLE_ID=com.anthropic.claudefordesktop
LAB_DIR_1P="$LAB_BASE/Claude"
LAB_DIR_3P="$LAB_BASE/Claude-3p"
LAB_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 打印一步要做什么（先说再做）
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[中止]\033[0m %s\n' "$*" >&2; exit 1; }

# 两个路径是否是同一处（按真实路径比，/var 与 /private/var 这类软链差异不算不同）
same_path() {
  local a b
  a="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  b="$(cd "$2" 2>/dev/null && pwd -P)" || return 1
  [ "$a" = "$b" ]
}

# 当前是否在操作真目录
lab_is_real_base() {
  [ -z "${CLAUDE_LAB_BASE:-}" ] && return 0
  same_path "$LAB_BASE" "$LAB_REAL_BASE"
}

# 列出还在跑的桌面应用相关进程（主进程、Helper、它拉起的内置 Claude Code）。只读，不发任何信号。
lab_running_processes() {
  # lsappinfo 按包 id 查（不会启动应用）；ps 兜底按可执行文件路径查
  local asn
  asn="$(lsappinfo find "bundleID=$LAB_BUNDLE_ID" 2>/dev/null || true)"
  if [ -n "$asn" ]; then
    echo "应用（lsappinfo）：$asn"
  fi
  # 注意：本机实测 pgrep -x Claude 查不到正在运行的主进程，所以不用 pgrep
  # chrome-native-host 是 Chrome 扩展拉起的，Chrome 开着它就一直在，不算桌面应用在运行，单独提示
  ps -axo pid=,comm= 2>/dev/null | grep -E '/Claude\.app/Contents/|/Application Support/Claude(-3p)?/claude-code/' \
    | grep -v -e grep -e '/Helpers/chrome-native-host' || true
}

# 正在运行的桌面应用用的数据目录：从进程命令行里取 --user-data-dir（社区报告：指向 Claude-3p 即第三方模式）。只读。
lab_user_data_dirs() {
  ps -axo args= 2>/dev/null | grep -E '/Claude\.app/Contents/' | grep -v grep \
    | grep -o -- '--user-data-dir=[^ ]*\( [^-][^ ]*\)*' | sort -u | head -3
}

# Chrome 扩展拉起的 Claude 辅助进程（不阻止操作，只提示）
lab_chrome_host_processes() {
  ps -axo pid=,comm= 2>/dev/null | grep -F '/Claude.app/Contents/Helpers/chrome-native-host' | grep -v grep || true
}

# 写入 / 备份 / 恢复前的硬检查：桌面应用必须已完全退出
require_desktop_quit() {
  if [ "${CLAUDE_LAB_SKIP_RUNNING_CHECK:-}" = "1" ]; then
    if lab_is_real_base; then
      warn "CLAUDE_LAB_SKIP_RUNNING_CHECK 只在演练（CLAUDE_LAB_BASE 指向别处）时生效，现在操作的是真目录，照常检查。"
    else
      info "演练模式：跳过「桌面应用是否在运行」检查（操作的是 ${LAB_BASE}）"
      return 0
    fi
  fi
  step "检查 Claude 桌面应用是否已完全退出"
  local procs
  procs="$(lab_running_processes)"
  if [ -n "$procs" ]; then
    printf '%s\n' "$procs" | sed 's/^/    /'
    die "Claude 桌面应用（或它的后台进程）还在运行。请切到 Claude 窗口按 ⌘Q 完全退出（不是关窗口），等 10 秒再重跑本脚本。"
  fi
  info "没有在运行。"
  if [ -n "$(lab_chrome_host_processes)" ]; then
    info "（另有 Chrome 扩展拉起的 chrome-native-host 在跑，它属于 Chrome，不影响本操作。）"
  fi
}

# 对真目录动手前多问一句（演练时不问）
confirm_real() {
  if lab_is_real_base; then
    printf '\n%s [输入 yes 继续] ' "$1"
    local ans
    read -r ans
    [ "$ans" = "yes" ] || die "未确认，什么也没改。"
  fi
}

# 路径是否落在 iCloud 同步的「桌面与文稿」里（备份里有登录 Cookie，且体积很大，不该上传）
lab_in_icloud() {
  local p="$1" real d
  real="$(cd "$p" 2>/dev/null && pwd -P)" || real="$p"
  case "$real" in
    "$HOME/Library/Mobile Documents"*) return 0 ;;
  esac
  for d in "$HOME/Desktop" "$HOME/Documents"; do
    if xattr -p com.apple.file-provider-domain-id "$d" >/dev/null 2>&1; then
      case "$real" in
        "$(cd "$d" && pwd -P)"|"$(cd "$d" && pwd -P)"/*) return 0 ;;
      esac
    fi
  done
  return 1
}

lab_print_paths() {
  info "Claude 目录：    $LAB_DIR_1P"
  info "Claude-3p 目录： $LAB_DIR_3P"
  if lab_is_real_base; then info "（真目录）"; else info "（演练目录，不是真目录）"; fi
}

#!/usr/bin/env bash
# 查看 / 退出 / 打开 Claude 桌面应用，给真机用例用（执行者不在 Claude 里跑时才用得上）。
#
# 用法：scripts/desktop-3p-lab/app.sh status|quit|open [--wait 秒]
#   status  只读：是否在运行、正在用哪个数据目录（--user-data-dir 指向 …/Claude-3p 即第三方模式）
#   quit    等于在应用里按 ⌘Q：发「退出」请求（不强杀），等到主进程、Helper、内置 Claude Code 全部退出
#           （默认最多 30 秒）。超时就列出还在的进程、以 1 退出——不会 kill，交给人决定。
#           没在运行时什么也不做（不会先把它拉起来再退出）。
#   open    按包 id 打开（open -b），等到它在运行（默认最多 30 秒），再等 8 秒打印数据目录。
# 第一次 quit 时 macOS 可能弹「允许 … 控制 Claude」的授权框，要人点允许。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

CMD="${1:-}"
[ $# -gt 0 ] && shift
WAIT=30
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="$2"; shift 2 ;;
    *) die "不认识的参数：$1" ;;
  esac
done
case "$WAIT" in *[!0-9]*|"") die "--wait 要是秒数" ;; esac

app_running() { [ -n "$(lsappinfo find "bundleID=$LAB_BUNDLE_ID" 2>/dev/null)" ]; }

print_status() {
  info "版本：$(defaults read "$LAB_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo 读不到)"
  local procs
  procs="$(lab_running_processes)"
  if [ -n "$procs" ]; then
    info "正在运行："
    printf '%s\n' "$procs" | sed 's/^/      /' | head -8
    info "数据目录（--user-data-dir）：$(lab_user_data_dirs | tr '\n' ' ')"
    case "$(lab_user_data_dirs)" in
      *Claude-3p*) info "→ 第三方模式（数据目录是 Claude-3p）" ;;
      *"Application Support/Claude"*) info "→ 标准模式（数据目录是 Claude）" ;;
      *) info "→ 从命令行看不出模式（没取到 --user-data-dir）" ;;
    esac
  else
    info "没有在运行。"
  fi
  [ -n "$(lab_chrome_host_processes)" ] && info "（另有 Chrome 扩展拉起的 chrome-native-host，属于 Chrome，不算桌面应用在运行。）"
  return 0
}

case "$CMD" in
  status)
    step "Claude 桌面应用状态"
    print_status
    ;;
  quit)
    step "退出 Claude 桌面应用（等于 ⌘Q，不强杀）"
    if app_running; then
      osascript -e "tell application id \"$LAB_BUNDLE_ID\" to quit" >/dev/null 2>&1 \
        || warn "osascript 发退出请求失败（没给「控制 Claude」的授权？）。请人切到 Claude 按 ⌘Q。"
    else
      info "应用本身没在运行，只等残留的后台进程退出。"
    fi
    n=0
    while [ -n "$(lab_running_processes)" ] && [ "$n" -lt "$WAIT" ]; do
      sleep 1
      n=$((n + 1))
    done
    if [ -n "$(lab_running_processes)" ]; then
      lab_running_processes | sed 's/^/    /'
      die "$WAIT 秒后还有进程没退出。看看 Claude 是否弹了「确定退出？」之类的框（截图、原文记下），交给人处理；不要 kill。"
    fi
    info "已完全退出（用了约 $n 秒）。"
    ;;
  open)
    step "打开 Claude 桌面应用"
    app_running && info "它本来就在运行。"
    open -b "$LAB_BUNDLE_ID" || die "open -b $LAB_BUNDLE_ID 失败。"
    n=0
    while ! app_running && [ "$n" -lt "$WAIT" ]; do
      sleep 1
      n=$((n + 1))
    done
    app_running || die "$WAIT 秒内没看到它在运行。"
    info "在运行了（约 $n 秒）；再等 8 秒看数据目录。"
    sleep 8
    print_status
    ;;
  -h|--help|"")
    sed -n '2,10p' "$0"
    [ -n "$CMD" ] || exit 2
    ;;
  *) die "不认识的子命令：${CMD}（status|quit|open）" ;;
esac

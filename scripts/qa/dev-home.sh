#!/bin/bash
# 用隔离的测试主目录跑这份 debug 包做真机验证（docs/testing/2026-10-05-computer-use.md）。
# 把一轮验证里反复做的几件事固定下来：停掉上一个实例（单实例插件会让新实例静默退出）、
# 建或清测试主目录、从 .app 启动（和从 Dock 打开一样的最小 PATH）、带到最前（后台的 WKWebView
# 截不到图、AX 树是空的）。登录项由代码保证不注册（autostart::should_default）。
#
# 用法（在仓库任意位置）：
#   scripts/qa/dev-home.sh start [目录]     先 make build；停上一个、启动新实例并带到最前。目录默认 /private/tmp/sophia-dev-home
#   scripts/qa/dev-home.sh reset [目录]     清空测试主目录（下次 start 等于第一次打开）
#   scripts/qa/dev-home.sh stop             停掉这份构建起的实例
#   scripts/qa/dev-home.sh log              看应用日志的尾巴
#   环境变量 SOPHIA_FAULT=page:shell 之类会原样传给应用
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
APP="${SOPHIA_APP:-$REPO/target/debug/bundle/macos/Sophia.app}"
BIN="$APP/Contents/MacOS/Sophia"
HOME_DIR="${2:-/private/tmp/sophia-dev-home}"
LOG="$HOME/Library/Logs/com.zhengjiaqiao.sophia.dev/sophia.log"

die() { echo "$*" >&2; exit 1; }

stop() {
  local pids
  pids=$(pgrep -f "^$BIN" | tr '\n' ' ' || true)
  if [ -n "$pids" ]; then
    pkill -f "^$BIN" || true
    sleep 1
    echo "已停掉测试实例（pid ${pids}）"
  fi
}

reset_home() {
  rm -rf "$HOME_DIR"
  mkdir -p "$HOME_DIR/AppData/Sophia"
  echo "测试主目录已清空：$HOME_DIR"
}

start() {
  [ -x "$BIN" ] || die "找不到 ${BIN}，先在仓库里 make build"
  stop
  mkdir -p "$HOME_DIR/AppData/Sophia"
  # 用 open 而不是直接执行二进制：拿到的是从 Dock 打开时那份最小 PATH，和用户的真实情况一致
  local extra=()
  [ -n "${SOPHIA_FAULT:-}" ] && extra+=(--env "SOPHIA_FAULT=$SOPHIA_FAULT")
  # macOS 自带的 bash 3.2 在 set -u 下把空数组当未定义：用 ${extra[@]+…} 的写法
  open -n --env "SOPHIA_TEST_HOME=$HOME_DIR" ${extra[@]+"${extra[@]}"} "$APP"
  local pid=""
  for _ in $(seq 1 20); do
    sleep 0.5
    pid=$(pgrep -f "^$BIN" | head -1 || true)
    [ -n "$pid" ] && break
  done
  [ -n "$pid" ] || die "实例没起来：看 $LOG 的尾巴（上一个实例没停干净时新实例会静默退出）"
  sleep 2
  # 带到最前：computer-use 的截图与 AX 树只在窗口在最前时有内容
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" >/dev/null 2>&1 || true
  echo "测试实例 pid $pid，主目录 $HOME_DIR"
}

case "${1:-}" in
  start) start ;;
  reset) reset_home ;;
  stop) stop ;;
  log) tail -n 30 "$LOG" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac

#!/bin/bash
# 菜单栏用量的真机测试工具（docs/testing/2026-09-29-usage-test-cases.md）。
#
# 搭一个隔离的 HOME：/private/tmp/sophia-qa-usage/home，里面放「假的」claude 与 codex——
# 它们只认 Sophia 用量探测的协议，按场景回和真实回复同一格式的数据（或卡住、提前退出），
# 每次被调起都往调用记录里记一行（时刻、场景、参数、工作目录、环境变量名）。
# 应用用 env -i 启动（模拟从 Dock 打开），HOME 与 SOPHIA_TEST_HOME 都指向这个目录：
# 不碰真实的 ~/.claude、~/.claude.json、~/.codex，也不调真实的用量接口。
#
# 用法（在仓库任意位置）：
#   scripts/qa/usage-qa.sh setup                  重建测试目录（两家都已登录、已安装，场景 ok，没有会话记录）
#   scripts/qa/usage-qa.sh start [--real]         启动测试实例（先停掉上一个）；--real 用真实 HOME、数据目录仍隔离；
#                                                 环境变量 QA_EXTRA_ENV="A=1 B=2" 会额外传给应用（验证探测不带它们）
#   scripts/qa/usage-qa.sh stop                   停掉测试实例
#   scripts/qa/usage-qa.sh claude <场景>          ok | ratelimited | noplan | error | exit | hang | exhausted | passed | soon
#   scripts/qa/usage-qa.sh codex <场景>           ok | auth | ratelimit | noplan | exit | hang
#   scripts/qa/usage-qa.sh rollout <fresh|stale|none>   Codex 本机会话记录：刚写的 / 2 小时前的 / 没有
#   scripts/qa/usage-qa.sh signin <claude|codex> <on|off>
#   scripts/qa/usage-qa.sh install <claude|codex> <on|off>
#   scripts/qa/usage-qa.sh calls [claude|codex]   看调用记录（相对现在多久之前）
#   scripts/qa/usage-qa.sh procs                  看此刻有没有 claude / codex 子进程
#   scripts/qa/usage-qa.sh private                检查账号标识有没有落进文件与日志
#   scripts/qa/usage-qa.sh settings               打印测试实例的 settings.json 里的 usage 一节
set -euo pipefail

ROOT=/private/tmp/sophia-qa-usage
H="$ROOT/home"
Q="$H/.qa"
DATA="$H/AppData/Sophia"
REAL_DATA_ROOT="$ROOT/real"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
APP="${SOPHIA_APP:-$REPO/target/debug/bundle/macos/Sophia.app}"
BIN="$APP/Contents/MacOS/Sophia"
PIDFILE="$ROOT/app.pid"
LOG="$ROOT/app.log"

# 假账号标识：出现在假回复里，任何文件与日志里都不该出现（R8、AC29）
FAKE_EMAIL="qa-private@example.invalid"
FAKE_ORG="QA Private Org"
FAKE_ACCOUNT="acct-qa-SECRET-0001"

die() { echo "usage-qa: $*" >&2; exit 1; }

write_fake_claude() {
  cat > "$H/.local/bin/claude" <<'FAKE'
#!/bin/bash
# 假的 claude：只认 Sophia 用量探测（-p stream-json，initialize + get_usage 两个控制请求）
Q="$HOME/.qa"
mode=$(cat "$Q/claude-mode" 2>/dev/null || echo ok)
printf '%s\tpid=%s\tmode=%s\tcwd=%s\targs=%s\tenv=%s\n' "$(date +%s)" "$$" "$mode" "$PWD" "$*" \
  "$(env | cut -d= -f1 | sort | tr '\n' ',')" >> "$Q/claude-calls.log"
case "$mode" in
  exit) exit 1 ;;
  hang) sleep 300; exit 0 ;;
esac
iso() { date -u "$@" +%Y-%m-%dT%H:%M:%S+00:00; }
limit() { # kind percent severity resets_at is_active [scope]
  printf '{"kind":"%s","group":"x","percent":%s,"severity":"%s","resets_at":"%s","scope":%s,"is_active":%s}' \
    "$1" "$2" "$3" "$4" "${6:-null}" "$5"
}
usage_body() {
  local session=13 session_sev=normal session_reset
  session_reset=$(iso -v+2H -v+58M)
  case "$mode" in
    exhausted) session=100; session_sev=critical ;;
    passed) session=40; session_reset=$(iso -v-1M) ;;
    soon) session_reset=$(iso -v+6M) ;;
  esac
  local limits
  limits="[$(limit session $session $session_sev "$session_reset" false),$(limit weekly_all 87 warning "$(iso -v+6d)" true),$(limit weekly_scoped 0 normal "$(iso -v+6d)" false '{"model":{"id":null,"display_name":"Fable"},"surface":null}')]"
  printf '{"subscription_type":"max","rate_limits_available":true,"rate_limits":{"limits":%s},"iguana_necktie":{"utilization":1},"behaviors":null}' "$limits"
}
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*)
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"sophia-init","response":{"account":{"email":"%s","organization":"%s"}}}}\n' \
        "qa-private@example.invalid" "QA Private Org"
      ;;
    *get_usage*)
      case "$mode" in
        ratelimited) body='{"subscription_type":"max","rate_limits_available":true,"rate_limits":null}' ;;
        noplan) body='{"subscription_type":null,"rate_limits_available":false,"rate_limits":null}' ;;
        error)
          printf '{"type":"control_response","response":{"subtype":"error","request_id":"sophia-usage","error":"qa fake error"}}\n'
          exit 0
          ;;
        *) body=$(usage_body) ;;
      esac
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"sophia-usage","response":%s}}\n' "$body"
      exit 0
      ;;
  esac
done
FAKE
  chmod +x "$H/.local/bin/claude"
}

write_fake_codex() {
  cat > "$H/.local/bin/codex" <<'FAKE'
#!/bin/bash
# 假的 codex：只认 Sophia 用量探测（app-server，JSON-RPC：initialize → initialized → account/rateLimits/read）
Q="$HOME/.qa"
mode=$(cat "$Q/codex-mode" 2>/dev/null || echo ok)
printf '%s\tpid=%s\tmode=%s\tcwd=%s\targs=%s\tenv=%s\n' "$(date +%s)" "$$" "$mode" "$PWD" "$*" \
  "$(env | cut -d= -f1 | sort | tr '\n' ',')" >> "$Q/codex-calls.log"
# 场景只作用于用量探测（app-server）；别的调用（模型页读版本的 --version）照常回，免得卡住的是它
case "$*" in
  *app-server*) ;;
  *) echo "codex-cli 0.0.0-qa"; exit 0 ;;
esac
case "$mode" in
  exit) exit 1 ;;
  hang) sleep 300; exit 0 ;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) printf '{"id":1,"result":{"userAgent":"qa-fake"}}\n' ;;
    *account/rateLimits/read*)
      reset=$(( $(date +%s) + 5 * 86400 ))
      case "$mode" in
        auth) printf '{"id":2,"error":{"code":-32001,"message":"unauthorized: please log in again"}}\n' ;;
        ratelimit) printf '{"id":2,"error":{"code":429,"message":"rate limit exceeded"}}\n' ;;
        noplan) printf '{"id":2,"result":{"rateLimitsByLimitId":{},"accountId":"acct-qa-SECRET-0001"}}\n' ;;
        *) printf '{"id":2,"result":{"rateLimitsByLimitId":{"codex":{"limitId":"codex","limitName":null,"primary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":%s},"secondary":null,"planType":"prolite"}},"accountId":"acct-qa-SECRET-0001"}}\n' "$reset" ;;
      esac
      exit 0
      ;;
  esac
done
FAKE
  chmod +x "$H/.local/bin/codex"
}

signin() { # agent on|off
  case "$1:$2" in
    claude:on) printf '{"oauthAccount":{"emailAddress":"%s","organizationName":"%s","accountUuid":"%s"},"projects":{}}\n' "$FAKE_EMAIL" "$FAKE_ORG" "$FAKE_ACCOUNT" > "$H/.claude.json" ;;
    claude:off) printf '{"projects":{}}\n' > "$H/.claude.json" ;;
    codex:on) printf '{"tokens":{"account_id":"%s"}}\n' "$FAKE_ACCOUNT" > "$H/.codex/auth.json" ;;
    codex:off) rm -f "$H/.codex/auth.json" ;;
    *) die "signin <claude|codex> <on|off>" ;;
  esac
  echo "已把 $1 的登录状态设为 $2"
}

install() { # agent on|off
  local f="$H/.local/bin/$1"
  case "$1:$2" in
    claude:on) write_fake_claude ;;
    codex:on) write_fake_codex ;;
    claude:off | codex:off) rm -f "$f" ;;
    *) die "install <claude|codex> <on|off>" ;;
  esac
  echo "已把 $1 设为$([ "$2" = on ] && echo 已安装 || echo 没安装)"
}

rollout() { # fresh|stale|none
  local dir="$H/.codex/sessions/$(date +%Y/%m/%d)"
  rm -rf "$H/.codex/sessions"
  [ "$1" = none ] && { echo "已删掉会话记录"; return; }
  mkdir -p "$dir"
  local ts
  case "$1" in
    fresh) ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z) ;;
    stale) ts=$(date -u -v-2H +%Y-%m-%dT%H:%M:%S.000Z) ;;
    *) die "rollout <fresh|stale|none>" ;;
  esac
  local reset=$(( $(date +%s) + 5 * 86400 ))
  printf '{"timestamp":"%s","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":33.0,"window_minutes":10080,"resets_at":%s},"secondary":null,"plan_type":"prolite"}}}\n' "$ts" "$reset" > "$dir/rollout-qa.jsonl"
  echo "已写会话记录（$1，时间 ${ts}，本周已用 33%）"
}

stop() {
  # 按这份构建的程序路径停：只停从本仓库这份 debug 包起的实例（产品负责人自己开着的 Sophia 路径不同，不受影响）
  local pids
  pids=$(pgrep -f "^$BIN" | tr '\n' ' ' || true)
  if [ -n "$pids" ]; then
    pkill -f "^$BIN" || true
    sleep 1
    echo "已停掉测试实例（pid ${pids}）"
  fi
  rm -f "$PIDFILE"
}

start() {
  [ -x "$BIN" ] || die "找不到 ${BIN}，先在仓库里 make build"
  stop
  local home="$H" test_home="$H"
  if [ "${1:-}" = --real ]; then
    home="$HOME"; test_home="$REAL_DATA_ROOT"; mkdir -p "$REAL_DATA_ROOT"
  fi
  : > "$LOG"
  cd "$ROOT"
  # shellcheck disable=SC2086 # QA_EXTRA_ENV 按空格拆成多个 A=B
  env -i HOME="$home" USER="$USER" LANG=en_US.UTF-8 PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    SOPHIA_TEST_HOME="$test_home" ${QA_EXTRA_ENV:-} "$BIN" >> "$LOG" 2>&1 &
  sleep 2
  local pid
  pid=$(pgrep -f "^$BIN" | head -1 || true)
  [ -n "$pid" ] || die "测试实例没起来，看 $LOG"
  echo "$pid" > "$PIDFILE"
  echo "测试实例已启动（pid ${pid}，HOME=${home}，数据目录 $test_home/AppData/Sophia）"
}

calls() { # [claude|codex]
  local now; now=$(date +%s)
  for a in ${1:-claude codex}; do
    local f="$Q/$a-calls.log"
    echo "== ${a}（共 $( [ -f "$f" ] && wc -l < "$f" | tr -d ' ' || echo 0) 次）"
    [ -f "$f" ] || continue
    while IFS=$'\t' read -r t pid mode cwd args env; do
      echo "  $(( now - t )) 秒前  $mode  $cwd  $args"
    done < "$f"
  done
}

procs() {
  echo "== 此刻的 claude / codex 进程（测试实例起的会在 $H/.local/bin 下）"
  ps -Ao pid,ppid,etime,command \
    | grep -E "$H/.local/bin/(claude|codex)|claude -p --input-format stream-json|codex -s read-only -a never app-server" \
    | grep -v grep || echo "  没有"
}

private() {
  local hits=0
  for f in "$DATA"/settings.json "$DATA"/usage-last.json "$LOG" "$REAL_DATA_ROOT"/AppData/Sophia/settings.json "$REAL_DATA_ROOT"/AppData/Sophia/usage-last.json; do
    [ -f "$f" ] || continue
    if grep -n -E "$FAKE_EMAIL|$FAKE_ORG|$FAKE_ACCOUNT|accountId|accountUuid|emailAddress|organizationName|\"email\"" "$f"; then
      echo "  ↑ 出现在 $f"; hits=1
    fi
  done
  [ $hits = 0 ] && echo "没有找到账号标识（检查了 settings.json、usage-last.json、应用日志）"
  return $hits
}

setup() {
  stop
  rm -rf "$H"
  mkdir -p "$H/.local/bin" "$H/.codex" "$H/.claude" "$Q" "$DATA"
  write_fake_claude
  write_fake_codex
  signin claude on >/dev/null
  signin codex on >/dev/null
  echo ok > "$Q/claude-mode"
  echo ok > "$Q/codex-mode"
  : > "$Q/claude-calls.log"
  : > "$Q/codex-calls.log"
  echo "测试目录已就绪：${H}（Claude、Codex 都已登录、已安装，场景 ok，没有会话记录，没有 settings.json）"
  if [ -x /Applications/Codex.app/Contents/Resources/codex ] || [ -x /Applications/ChatGPT.app/Contents/Resources/codex ]; then
    echo "注意：本机装了 Codex 桌面应用，它自带的 codex 排在假的前面，Codex 的场景用例会调到真的——这些用例记「阻塞」"
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  setup) setup ;;
  start) start "${1:-}" ;;
  stop) stop ;;
  claude) [ -n "${1:-}" ] || die "claude <场景>"; echo "$1" > "$Q/claude-mode"; echo "Claude 场景：$1" ;;
  codex) [ -n "${1:-}" ] || die "codex <场景>"; echo "$1" > "$Q/codex-mode"; echo "Codex 场景：$1" ;;
  rollout) rollout "${1:-}" ;;
  signin) signin "${1:-}" "${2:-}" ;;
  install) install "${1:-}" "${2:-}" ;;
  calls) calls "${1:-}" ;;
  procs) procs ;;
  private) private ;;
  settings) python3 -c "import json;print(json.dumps(json.load(open('$DATA/settings.json')).get('usage'),ensure_ascii=False,indent=1))" 2>/dev/null || echo "还没有 settings.json" ;;
  *) sed -n '2,25p' "$0"; exit 1 ;;
esac

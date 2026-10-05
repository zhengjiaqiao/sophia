# shellcheck shell=bash
# 真机用例（docs/testing/2026-09-29-claude-desktop-3p-test-cases.md）的短名与小工具。bash、zsh 都能 source：
#   source /Users/jiaqiao/Project/sophia/.claude/worktrees/local-diagnostics/scripts/desktop-3p-lab/lab-env.sh
#   （仓库换了位置就设 SOPHIA_LAB_REPO 指过去，脚本都从 $SOPHIA_LAB_REPO/scripts/desktop-3p-lab 取）
# 每开一个新 shell（执行者每条命令若是新进程，就每条）都要先 source。只定义变量和函数，source 本身不改任何文件。
#
# 路径同 lib.sh，可用 CLAUDE_LAB_BASE / CLAUDE_LAB_STATE_DIR 指到演练目录。
#
# 2026-09-30 起另有 Sophia 验收用的短名（docs/testing/2026-09-30-claude-third-party-acceptance.md）：
#   SOPHIA_APP（被测包）、SOPHIA_BUNDLE_ID（被测包的包 id）、SDATA（Sophia 数据目录）、SBK（Sophia 这一侧的备份）、
#   RPORT（路由端口）、TEE_PORT（录制代理端口）、RLOG（路由日志）；
#   ss（sophia-state.sh）、sophia（起停被测的 Sophia）、cli（被测包的 Sophia gateway 命令行）、rmark / rlog / rcheck（路由日志）、
#   tee_start / tee_stop / tphase / treqs（录制代理）、upeek（假上游收到的请求要点）。
# 被测包与包 id 可换（见下方 SOPHIA_LAB_APP / SOPHIA_LAB_BUNDLE_ID）；本轮用自定包 id 构建，免得和安装版、开发版抢单实例：
#   npm run tauri build -- --debug --config '{"identifier":"com.zhengjiaqiao.sophia.diagtest"}'
#   → $R/target/debug/bundle/macos/Sophia.app，包 id com.zhengjiaqiao.sophia.diagtest（数据目录不随包 id，仍是 …/Sophia）

export R="${SOPHIA_LAB_REPO:-/Users/jiaqiao/Project/sophia/.claude/worktrees/local-diagnostics}"
export L="$R/scripts/desktop-3p-lab"
export LAB="${CLAUDE_LAB_STATE_DIR:-$HOME/claude-desktop-lab}"
export E="$LAB/evidence"
export A="${CLAUDE_LAB_BASE:-$HOME/Library/Application Support}"
# 抓包服务端口：环境变量 LAB_PORT > $LAB/PORT 文件（端口被占时 ENV-5 写它）> 18765
if [ -n "${LAB_PORT:-}" ]; then export PORT="$LAB_PORT"
elif [ -s "$LAB/PORT" ]; then export PORT="$(cat "$LAB/PORT")"
else export PORT=18765; fi
export LABID=00000000-0000-4000-8000-736f70686961   # 本实验的 profile id
export CCSID=00000000-0000-4000-8000-00000000cc55   # 模拟别家（配置切换工具）的 profile id
# BASE-3 记下的基线备份；恢复一律用它，不用 backups/LATEST（中途有人多跑一次 backup.sh，LATEST 就不是基线了）
if [ -s "$LAB/BASELINE" ]; then export BK="$(cat "$LAB/BASELINE")"; fi
# MOD-2 定下的「被接受的模型清单形状」（A 或 B）
if [ -s "$LAB/SHAPE" ]; then export SHAPE="$(cat "$LAB/SHAPE")"; fi

cs()    { python3 "$L/capture_server.py" "$@"; }
phase() { python3 "$L/capture_server.py" phase "$1" --port "$PORT"; }
fault() { python3 "$L/capture_server.py" fault "$@" --port "$PORT"; }
reqs()  { python3 "$L/capture_server.py" timeline "$LAB/capture" --phase "$1"; }
app()   { bash "$L/app.sh" "$@"; }
wp()    { bash "$L/write-profile.sh" --port "$PORT" "$@"; }

# 起 / 停抓包服务（后台跑，输出追加到 $LAB/capture-server.out）。
# 按端口找进程：/usr/bin/python3 是 Xcode 的转发壳，$! 拿到的是壳的 pid，不是真正在听端口的那个。
srv_pid() {
  local p
  for p in $(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    ps -o command= -p "$p" | grep -q 'capture_server.py' && echo "$p"
  done
}
srv_start() {
  mkdir -p "$LAB"
  if [ -n "$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" ]; then
    echo "端口 $PORT 已经有程序在听：$(srv_pid | tr '\n' ' ')（空＝不是抓包服务）。不重复起；是抓包服务就直接用，不是就交给人。"
    fault status
    return 1
  fi
  ( cd "$R" && nohup python3 "$L/capture_server.py" serve --port "$PORT" >> "$LAB/capture-server.out" 2>&1 & )
  sleep 2
  srv_pid > "$LAB/capture-server.pid"
  fault status
}
srv_stop() {
  local p
  p="$(srv_pid)"
  if [ -z "$p" ]; then echo "端口 $PORT 上没有抓包服务在跑。"; return 0; fi
  kill $p
  sleep 1
  if [ -n "$(srv_pid)" ]; then echo "没停掉（pid ${p}），交给人。"; return 1; fi
  echo "抓包服务已停（pid ${p}）。"
}

# 状态快照：inspect.sh 全文存 $E/<名字>.txt，屏幕上只摘要点。第二个参数是日志行数（默认 20）
insp() {
  mkdir -p "$E"
  bash "$L/inspect.sh" --log-lines "${2:-20}" > "$E/$1.txt" 2>&1
  echo "已存 $E/$1.txt"
  grep -E "deploymentMode:|appliedId|user-data-dir|sha256|！|没有在运行" "$E/$1.txt"
}
# 整屏截图（要「屏幕录制」权限；失败就交给人截）
snap() { mkdir -p "$E"; screencapture -x "$E/$1.png" && echo "已截图 $E/$1.png"; }
# 第三方模式日志摘录（长串打码）。第二个参数是 grep -E 的式子
logs() {
  mkdir -p "$E"
  grep -iE "${2:-custom-3p|unreachable|ECONNREFUSED|gateway|ConfigHealth|error}" "$HOME/Library/Logs/Claude-3p/main.log" 2>/dev/null \
    | tail -n 40 \
    | sed -E 's/(Bearer|bearer) [^ ",]+/\1 <打码>/g; s/[A-Za-z0-9_+\/=-]{40,}/<长串打码>/g' \
    | cut -c1-300 > "$E/$1.txt"
  echo "已存 $E/$1.txt"
  tail -n 8 "$E/$1.txt"
}
# 本地会话文件清单（只记路径，不读内容）与计数
files() {
  mkdir -p "$E"
  local d s
  for d in Claude Claude-3p; do for s in local-agent-mode-sessions claude-code-sessions; do
    find "$A/$d/$s" -type f 2>/dev/null
  done; done | sort > "$E/$1-files.txt"
  for d in Claude Claude-3p; do for s in local-agent-mode-sessions claude-code-sessions; do
    printf '%s/%s：%s 个文件\n' "$d" "$s" "$(grep -c "/$d/$s/" "$E/$1-files.txt")"
  done; done
  printf '~/.claude/projects：%s 个目录\n' "$(ls -1 "$HOME/.claude/projects" 2>/dev/null | wc -l | tr -d ' ')"
}
# 基线（第一个参数）里有、现在（第二个参数）没有的文件
lost() {
  comm -23 "$E/$1-files.txt" "$E/$2-files.txt" > "$E/$2-lost-vs-$1.txt"
  echo "$1 里有、$2 里没有的文件：$(wc -l < "$E/$2-lost-vs-$1.txt" | tr -d ' ') 个（清单 $E/$2-lost-vs-$1.txt）"
}
# 与 BASE-2 的基线快照比关键行（deploymentMode、appliedId、条目、configLibrary 文件及指纹、顶层键、运行状态）
basediff() {
  local K='^ +deploymentMode:|^ +appliedId:|^ +entry:|configLibrary/|顶层键|没有在运行'
  diff <(grep -E "$K" "$E/BASE-2-baseline.txt") <(grep -E "$K" "$E/$1.txt") && echo "与基线一致"
}
# 用基线备份恢复（restore.sh 会问 yes，这里替你答）
restore_baseline() {
  if [ -z "${BK:-}" ]; then echo "没有 BK：BASE-3 没做，或 $LAB/BASELINE 不在。不要恢复，交给人。"; return 1; fi
  printf 'yes\n' | bash "$L/restore.sh" "$BK"
}
# 把一句话放进剪贴板，在 Claude 输入框里 ⌘V、回车发出
clip() { printf '%s' "$1" | pbcopy && echo "已放进剪贴板：$1"; }
# 看一个阶段里每个 /v1/messages 请求的要点（模型、处理方式、thinking、max_tokens、system 第一块开头、最后一句用户话开头、工具名）
peek() {
  python3 - "$LAB/capture/$1" <<'PY'
import json, os, re, sys
d = sys.argv[1]
fns = sorted(f for f in os.listdir(d) if re.match(r"\d{4}-POST-v1_messages\.json$", f)) if os.path.isdir(d) else []
if not fns:
    print(f"{d} 里没有 /v1/messages 请求")
for fn in fns:
    r = json.load(open(os.path.join(d, fn), encoding="utf-8"))
    b = r.get("body") if isinstance(r.get("body"), dict) else {}
    sysb = b.get("system")
    first = (sysb[0].get("text", "") if isinstance(sysb, list) and sysb and isinstance(sysb[0], dict) else str(sysb or ""))[:90]
    user = ""
    for m in reversed(b.get("messages") or []):
        if m.get("role") == "user":
            c = m.get("content")
            user = c if isinstance(c, str) else " ".join(x.get("text", "") if x.get("type") == "text" else "<" + str(x.get("type")) + ">" for x in c if isinstance(x, dict))
            break
    tools = [t.get("name") for t in b.get("tools") or [] if isinstance(t, dict)]
    print(f"{fn[:4]} model={b.get('model')} -> {r.get('decision')}")
    print(f"     thinking={json.dumps(b.get('thinking'), ensure_ascii=False)} max_tokens={b.get('max_tokens')} "
          f"output_config={json.dumps(b.get('output_config'), ensure_ascii=False)[:80]} 消息数={len(b.get('messages') or [])}")
    print(f"     system 第一块：{first!r}")
    print(f"     最后一句用户话：{user[:80]!r}")
    print(f"     工具（{len(tools)}）：{', '.join(tools[:40])}")
PY
}
# ───── Sophia 验收（docs/testing/2026-09-30-claude-third-party-acceptance.md）用的短名 ─────
# 被测包（SOPHIA_LAB_APP，默认本仓库的 debug 包）、它的包 id（SOPHIA_LAB_BUNDLE_ID，默认读包里的 Info.plist；
# 本轮是 com.zhengjiaqiao.sophia.diagtest）、Sophia 数据目录（SOPHIA_LAB_DATA_DIR，默认 ~/Library/Application Support/Sophia）、
# Sophia 这一侧的备份、路由端口（settings.json 的 codexGateway.port，读不到按 47328）、录制代理端口
export SOPHIA_APP="${SOPHIA_LAB_APP:-$R/target/debug/bundle/macos/Sophia.app}"
export SOPHIA_BUNDLE_ID="${SOPHIA_LAB_BUNDLE_ID:-$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOPHIA_APP/Contents/Info.plist" 2>/dev/null || echo com.zhengjiaqiao.sophia)}"
export SDATA="${SOPHIA_LAB_DATA_DIR:-$HOME/Library/Application Support/Sophia}"
if [ -s "$LAB/SOPHIA_BASELINE" ]; then export SBK="$(cat "$LAB/SOPHIA_BASELINE")"; fi
export RPORT="$(python3 -c 'import json,os,sys
try: print(json.load(open(sys.argv[1])).get("codexGateway",{}).get("port") or 47328)
except Exception: print(47328)' "$SDATA/settings.json")"
export TEE_PORT="${LAB_TEE_PORT:-18767}"
export RLOG="$SDATA/gateway-logs/router.log"
ss()     { bash "$L/sophia-state.sh" "$@"; }
sophia() { bash "$L/sophia-state.sh" app "$@"; }
# 被测包的命令行 `Sophia gateway <命令> [--agent codex|claude]`（只读的 status / doctor 随便用；
# enable / restore / restart / launch / provider-add / select 会写，用例写了才用）
cli()    { "$SOPHIA_APP/Contents/MacOS/Sophia" gateway "$@"; }
# 路由日志：rmark 记下现在的行数；rlog <名字> [grep 式子] 把之后新增的行存到 $E/<名字>-router.txt 并打印
rmark()  { mkdir -p "$LAB"; wc -l < "$RLOG" 2>/dev/null | tr -d ' ' > "$LAB/rlog.mark" || echo 0 > "$LAB/rlog.mark"; echo "路由日志记号：第 $(cat "$LAB/rlog.mark") 行之后"; }
rlog()   {
  mkdir -p "$E"
  local from; from="$(cat "$LAB/rlog.mark" 2>/dev/null || echo 0)"
  tail -n +"$((from + 1))" "$RLOG" 2>/dev/null | grep -E "${2:-.}" > "$E/$1-router.txt"
  echo "已存 $E/$1-router.txt（$(wc -l < "$E/$1-router.txt" | tr -d ' ') 行）"; tail -n 20 "$E/$1-router.txt"
}
# 录制代理（tee）：桌面应用 → 127.0.0.1:$TEE_PORT → 路由；只记请求头与请求体要点，不记对话正文
tee_start() {
  mkdir -p "$LAB"
  if [ -n "$(lsof -t -nP -iTCP:"$TEE_PORT" -sTCP:LISTEN 2>/dev/null)" ]; then echo "端口 $TEE_PORT 已有程序在听，不重复起。"; return 1; fi
  ( cd "$R" && nohup python3 "$L/capture_server.py" proxy --listen "$TEE_PORT" --target "http://127.0.0.1:$RPORT" --out "$LAB/tee" >> "$LAB/tee.out" 2>&1 & )
  sleep 2; lsof -nP -iTCP:"$TEE_PORT" -sTCP:LISTEN | tail -n +2 | head -2
}
tee_stop() {
  local p
  for p in $(lsof -t -nP -iTCP:"$TEE_PORT" -sTCP:LISTEN 2>/dev/null); do
    ps -o command= -p "$p" | grep -q 'capture_server.py' && kill "$p" && echo "录制代理已停（pid ${p}）"
  done
}
# rcheck <名字>：读 rlog 存下的 $E/<名字>-router.txt，按 agent=claude 的状态码计数，列出非 2xx 与走了 openai / chatgpt 的行。
# 末行「全是 2xx」才算过
rcheck() {
  local f="$E/$1-router.txt"
  [ -f "$f" ] || { echo "没有 ${f}（先跑 rlog $1）"; return 1; }
  echo "agent=claude 的行：$(grep -c 'agent=claude' "$f" | tr -d ' ') 条；状态码计数："
  grep 'agent=claude' "$f" | grep -oE 'status=[0-9]+' | sort | uniq -c | sed 's/^/    /'
  local bad
  bad="$(grep 'agent=claude' "$f" | grep -vE 'status=2[0-9][0-9]( |$)'; grep 'agent=claude' "$f" | grep -E 'route=(openai|chatgpt)( |$)')"
  if [ -n "$bad" ]; then printf '非 2xx 或走了官方的行：\n%s\n' "$bad" | cut -c1-300; echo "==> 有非 2xx / 走官方的请求"; return 1; fi
  [ "$(grep -c 'agent=claude' "$f" | tr -d ' ')" -gt 0 ] || { echo "==> 一条 agent=claude 的请求都没有"; return 1; }
  echo "==> agent=claude 的请求全是 2xx，没有走官方"
}
tphase() { python3 "$L/capture_server.py" phase "$1" --port "$TEE_PORT"; }
treqs()  { python3 "$L/capture_server.py" timeline "$LAB/tee" --phase "$1"; }
# 假上游收到的 Chat Completions 请求要点：模型、消息角色序列、有无 response_format、工具数、请求头名、鉴权种类（不打印正文）
upeek() {
  python3 - "$LAB/capture/$1" <<'PY'
import json, os, sys
d = sys.argv[1]
recs = []
if os.path.isdir(d):
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".json"):
            try:
                r = json.load(open(os.path.join(d, fn), encoding="utf-8"))
            except Exception:
                continue
            if "/chat/completions" in str(r.get("path")):
                recs.append((fn, r))
if not recs:
    print(f"{d} 里没有假上游收到的 /chat/completions 请求")
for fn, r in recs:
    b = r.get("body") if isinstance(r.get("body"), dict) else {}
    roles = [m.get("role") for m in b.get("messages") or [] if isinstance(m, dict)]
    print(f"{fn[:4]} model={b.get('model')} stream={b.get('stream')} -> {r.get('decision')}")
    print(f"     消息角色：{' '.join(x[:4] for x in roles)}（共 {len(roles)} 条）；工具 {len(b.get('tools') or [])} 个；"
          f"response_format={'有' if b.get('response_format') else '无'}；max_tokens={b.get('max_tokens')}")
    print(f"     顶层键：{sorted(b)}")
    print(f"     请求头：{sorted(k.lower() for k, _ in r.get('headers', []))}；鉴权：{r.get('auth')}")
PY
}
# 第三方模式下 Code 标签内置 Claude Code 进程的模型相关环境变量（只筛出模型名、地址类变量，不打印其他环境变量）
ccenv() {
  local p
  for p in $(ps -axo pid=,comm= | grep '/Application Support/Claude-3p/claude-code/' | grep -v grep | awk '{print $1}'); do
    ps -E -ww -o command= -p "$p" 2>/dev/null | tr ' ' '\n' \
      | grep -E '^(ANTHROPIC_[A-Z_]*MODEL[A-Z_]*|ANTHROPIC_BASE_URL|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_[A-Z_]*TOKENS[A-Z_]*)='
  done | sort -u
}

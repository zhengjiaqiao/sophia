#!/usr/bin/env bash
# Sophia 这一侧（模型网关）真机验收用的小工具：看状态、起停被测的 Sophia、备份 / 比对 / 恢复网关相关的文件，
# 以及几种只在 Claude 桌面应用退出时才做的「造现场」改动。给 docs/testing/2026-09-30-claude-third-party-acceptance.md 用。
#
# 用法：scripts/desktop-3p-lab/sophia-state.sh <子命令> [参数]
#   app status              只读：列出正在跑的 Sophia 界面进程（同包 id 可能有别的 worktree 的实例）与可执行文件路径
#   app quit [--wait 秒]    让所有 Sophia 界面进程正常退出（Apple 事件 quit，等于 ⌘Q；不 kill），默认每个等 15 秒
#   app open [--wait 秒]    没有任何 Sophia 在跑时，打开被测包（SOPHIA_LAB_APP），并核对跑起来的就是它
#   status [--log-lines N]  只读：路由服务、~/.codex、Sophia 设置里两家的网关摘要、钥匙串 symsync 条目名、
#                           Claude 的四个文件、Claude 路由清单、路由日志末尾。不显示任何密钥与令牌
#   claude4 <名字>          只读：把 Claude 的四个文件拍一份快照到 $LAB/evidence/claude4-<名字>/
#                           （两份 claude_desktop_config.json 与 _meta.json 原样复制；Sophia 的 profile 只存令牌打码后的 JSON、
#                            sha256 与权限）
#   claude4-diff <甲> <乙>  只读：比两份快照，逐文件说「字节相同 / 不同」，不同的列出差异（profile 只比打码后的内容与指纹）
#   backup                  备份 Sophia 这一侧：~/.codex 的 config.toml、config.models*.bak、symsync-*；Sophia 的 settings.json、
#                           bin/、gateway/；路由服务的 plist（有才备份）；Claude 的四个文件；钥匙串 symsync 条目名（只记名字）。
#                           放在 $LAB/sophia-backups/sophia-backup-<时间>/，并把路径写进 $LAB/SOPHIA_BASELINE。Sophia 要先退出
#   compare [备份目录]       只读：现在与备份逐项比对（缺省用 $LAB/SOPHIA_BASELINE）
#   restore [备份目录]       把 ~/.codex 那几份、settings.json、bin/、gateway/ 放回备份的样子（现在的挪到 $LAB/aside/restore-<时间>/，
#                           不删）；备份时没有、现在多出来的 symsync-* 同样挪开。不碰 plist、钥匙串、Claude 的文件；
#                           路由服务此刻装着而备份时没有 → 拒绝（先在 Sophia 里把两家都关掉）。要输入 yes
#   claude-reset [备份目录]  Claude 退出时，把 Claude 的四个文件回到备份时的「模式与生效指向」：_meta.json 放回原样；
#                           configLibrary 里备份时没有的 profile（Sophia 的、模拟别家的）挪到 $LAB/aside/<时间>/；
#                           两份 claude_desktop_config.json 只把 deploymentMode 的值改回原值（其余字节不动）。要输入 yes
#   dm-only <甲文件> <乙文件>  只读：乙是否只在 deploymentMode 的值上与甲不同（其余字节逐字节相同）；
#                           用来核对 Sophia 改 claude_desktop_config.json 时只动了这一个成员（甲用 <名>.sophia-models.bak）
#   profile-set base-port <端口>   Claude 退出时，把 Sophia profile 里网关地址的端口换成 <端口>（其余字节不动）
#   profile-set token-wrong        Claude 退出时，把 Sophia profile 里的令牌换成一个错的（不打印新旧值）
#   token-check [目录…]           只读：拿 Sophia profile 里的令牌去搜 settings.json、路由日志、Claude 路由清单、$LAB 下的抓包与
#                                  代理记录（及另给的目录），只报每处「搜到 / 没搜到」，不打印令牌
#   sim-phase restoring            Sophia 退出时，把 settings.json 里 Claude 的记录改成「切回没做完」（enabled=false、
#                                  applied.phase=restoring），模拟切回写到一半 Sophia 没了；改前整份另存一份
#
# 路径都能换，自测时指向临时目录：
#   SOPHIA_LAB_DATA_DIR    Sophia 数据目录，默认 ~/Library/Application Support/SymSync
#   SOPHIA_LAB_CODEX_HOME  默认 ${CODEX_HOME}，没有则 ~/.codex
#   SOPHIA_LAB_AGENTS_DIR  默认 ~/Library/LaunchAgents
#   SOPHIA_LAB_APP         被测包，默认本仓库 target/debug/bundle/macos/Sophia.app
#   SOPHIA_LAB_KEYCHAIN=0  不查钥匙串（自测用）
#   CLAUDE_LAB_BASE / CLAUDE_LAB_STATE_DIR 同 lib.sh
# Sophia「没在跑」的检查只在上面几个目录都是真目录时才生效；自测时（指向临时目录）跳过。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SOPHIA_BUNDLE_ID=com.zhengjiaqiao.symsync
SERVICE_LABEL=com.zhengjiaqiao.symsync.gateway
SOPHIA_ID=00000000-0000-4000-8000-736f70686961
REAL_DATA_DIR="$HOME/Library/Application Support/SymSync"
DATA_DIR="${SOPHIA_LAB_DATA_DIR:-$REAL_DATA_DIR}"
CODEX_DIR="${SOPHIA_LAB_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
AGENTS_DIR="${SOPHIA_LAB_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
SOPHIA_APP="${SOPHIA_LAB_APP:-$(cd "$LAB_SCRIPT_DIR/../.." && pwd)/target/debug/bundle/macos/Sophia.app}"
PLIST="$AGENTS_DIR/$SERVICE_LABEL.plist"
EVIDENCE="$LAB_STATE_DIR/evidence"
KEYCHAIN="${SOPHIA_LAB_KEYCHAIN:-1}"

sophia_is_real() {
  [ -z "${SOPHIA_LAB_DATA_DIR:-}" ] || same_path "$DATA_DIR" "$REAL_DATA_DIR"
}

# Sophia 界面进程：可执行文件以 /Contents/MacOS/symsync 结尾、第一个参数不是 gateway（那是命令行或路由）。
# 每行「pid<TAB>可执行文件路径」。只读
sophia_gui_procs() {
  ps -axo pid=,comm= 2>/dev/null | while read -r pid comm; do
    case "$comm" in
      */Contents/MacOS/symsync)
        case "$(ps -o args= -p "$pid" 2>/dev/null)" in
          *"/Contents/MacOS/symsync gateway"*) ;;
          *) printf '%s\t%s\n' "$pid" "$comm" ;;
        esac ;;
    esac
  done
}

require_sophia_quit() {
  if ! sophia_is_real; then
    info "演练目录：跳过「Sophia 是否在运行」检查"
    return 0
  fi
  local p
  p="$(sophia_gui_procs)"
  if [ -n "$p" ]; then
    printf '%s\n' "$p" | sed 's/^/    /'
    die "Sophia 还在运行（上面列的）。先跑 sophia-state.sh app quit，全部退出后再来。"
  fi
}

router_port() {
  python3 - "$DATA_DIR/settings.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("codexGateway", {}).get("port") or 47328)
except Exception:
    print(47328)
PY
}

keychain_names() {
  [ "$KEYCHAIN" = 1 ] || { echo "（没查：SOPHIA_LAB_KEYCHAIN=0）"; return 0; }
  # dump-keychain 不带 -d 只列属性，不读密钥值；这里只挑出 service 为 symsync 的条目的账户名
  security dump-keychain 2>/dev/null | python3 -c '
import re, sys
names, block = set(), []
def flush(b):
    t = "\n".join(b)
    if re.search(r"\"svce\"<blob>=\"symsync\"", t):
        m = re.search(r"\"acct\"<blob>=\"([^\"]*)\"", t)
        names.add(m.group(1) if m else "（无账户名）")
for line in sys.stdin:
    if line.startswith("keychain:"):
        flush(block); block = []
    block.append(line.rstrip("\n"))
flush(block)
print("\n".join(sorted(names)) if names else "（没有 symsync 条目）")'
}

cmd_app() {
  local sub="${1:-status}" wait=15
  [ $# -gt 0 ] && shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait) wait="$2"; shift 2 ;;
      *) die "不认识的参数：$1" ;;
    esac
  done
  local tested
  tested="$(cd "$SOPHIA_APP/Contents/MacOS" 2>/dev/null && pwd -P)/symsync"
  case "$sub" in
    status)
      step "Sophia 界面进程"
      local p
      p="$(sophia_gui_procs)"
      if [ -z "$p" ]; then info "没有在运行。"; fi
      printf '%s\n' "$p" | while IFS="$(printf '\t')" read -r pid exe; do
        [ -n "$pid" ] || continue
        local real tag
        real="$(cd "$(dirname "$exe")" 2>/dev/null && pwd -P)/symsync"
        if [ "$real" = "$tested" ]; then tag="被测包"; else tag="别的包！"; fi
        info "pid $pid  $exe  （${tag}）"
      done
      info "被测包：$SOPHIA_APP"
      ;;
    quit)
      step "让所有 Sophia 界面进程退出（Apple 事件 quit，等于 ⌘Q；不 kill）"
      local round=0 n
      while [ -n "$(sophia_gui_procs)" ] && [ "$round" -lt 6 ]; do
        round=$((round + 1))
        osascript -e "tell application id \"$SOPHIA_BUNDLE_ID\" to quit" >/dev/null 2>&1 \
          || warn "osascript 发退出请求失败（没给「控制 Sophia」的授权？）"
        n=0
        while [ -n "$(sophia_gui_procs)" ] && [ "$n" -lt "$wait" ]; do sleep 1; n=$((n + 1)); done
      done
      if [ -n "$(sophia_gui_procs)" ]; then
        sophia_gui_procs | sed 's/^/    /'
        die "还有 Sophia 没退出。请人点它托盘面板里的「退出」（或切到它按 ⌘Q），不要 kill。"
      fi
      info "Sophia 都已退出。"
      ;;
    open)
      step "打开被测的 Sophia：$SOPHIA_APP"
      [ -x "$SOPHIA_APP/Contents/MacOS/symsync" ] || die "找不到被测包的可执行文件：$SOPHIA_APP/Contents/MacOS/symsync"
      if [ -n "$(sophia_gui_procs)" ]; then
        sophia_gui_procs | sed 's/^/    /'
        die "已有 Sophia 在跑。同一个包 id 下 open 可能只是把它调到前台，先 app quit。"
      fi
      open "$SOPHIA_APP" || die "open 失败。"
      local n=0
      while [ -z "$(sophia_gui_procs)" ] && [ "$n" -lt "$wait" ]; do sleep 1; n=$((n + 1)); done
      local p
      p="$(sophia_gui_procs)"
      [ -n "$p" ] || die "$wait 秒内没看到 Sophia 在跑。"
      local count real bad=0
      count="$(printf '%s\n' "$p" | wc -l | tr -d ' ')"
      printf '%s\n' "$p" | while IFS="$(printf '\t')" read -r pid exe; do info "pid $pid  $exe"; done
      while IFS="$(printf '\t')" read -r _ exe; do
        real="$(cd "$(dirname "$exe")" 2>/dev/null && pwd -P)/symsync"
        [ "$real" = "$tested" ] || bad=1
      done <<< "$p"
      [ "$count" = 1 ] && [ "$bad" = 0 ] || die "跑起来的不是（只有）被测包。先 app quit，交给人看。"
      info "在跑的就是被测包（约 $n 秒）。"
      ;;
    *) die "app 只认 status / quit / open" ;;
  esac
}

cmd_status() {
  local lines=15
  while [ $# -gt 0 ]; do
    case "$1" in
      --log-lines) lines="$2"; shift 2 ;;
      *) die "不认识的参数：$1" ;;
    esac
  done
  cmd_app status
  local port
  port="$(router_port)"
  step "路由服务（端口 ${port}）"
  if [ -e "$PLIST" ]; then info "plist 在：$PLIST"; else info "plist 不在：$PLIST"; fi
  local lc
  lc="$(launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>&1)"
  if printf '%s' "$lc" | grep -q 'state = '; then
    info "launchd：已加载；$(printf '%s\n' "$lc" | grep -E '^\s*(state|pid) = ' | tr -s ' \t' ' ' | tr '\n' ';')"
    info "程序：$(printf '%s\n' "$lc" | grep -E '^\s*program = ' | sed 's/^[[:space:]]*//')"
  else
    info "launchd：没加载（${SERVICE_LABEL}）"
  fi
  info "/_health：$(curl -sS -m 3 "http://127.0.0.1:$port/_health" 2>&1 | head -c 200)"
  python3 - "$DATA_DIR" "$CODEX_DIR" "$LAB_BASE" "$SOPHIA_ID" <<'PY'
import hashlib, json, os, stat, sys
data, codex, base, sid = sys.argv[1:]
def p(s=""): print("    " + s)
def sha(path):
    try: return hashlib.sha256(open(path, "rb").read()).hexdigest()[:12]
    except FileNotFoundError: return "不存在"
    except Exception as e: return f"读不了（{type(e).__name__}）"

print("\n\033[1m==> ~/.codex（Codex 那一家写的文件）\033[0m")
cfg = os.path.join(codex, "config.toml")
p(f"config.toml sha256:{sha(cfg)}")
try:
    lines = open(cfg, encoding="utf-8", errors="replace").read().splitlines()
    hits = [l.strip() for l in lines if "symsync" in l and not any(k in l.lower() for k in ("key", "token", "secret"))]
    p("含 symsync 的行：" + ("；".join(hits[:6]) if hits else "没有（Codex 没指向路由）"))
except FileNotFoundError:
    pass
extra = sorted(f for f in os.listdir(codex) if f.startswith("symsync-") or f.startswith("config.models")) if os.path.isdir(codex) else []
p("symsync-* / config.models*：" + ("、".join(f"{f}({sha(os.path.join(codex, f))})" for f in extra) if extra else "没有"))

print("\n\033[1m==> Sophia 设置里的两家网关（不含密钥）\033[0m")
try:
    s = json.load(open(os.path.join(data, "settings.json")))
except Exception as e:
    s = {}
    p(f"settings.json 读不了：{e}")
for fam in ("codexGateway", "claudeGateway"):
    g = s.get(fam)
    if g is None:
        p(f"{fam}：没有"); continue
    canon = hashlib.sha256(json.dumps(g, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    extra = ""
    if fam == "claudeGateway":
        a = g.get("applied")
        extra = (f"；enabled={g.get('enabled')} takeover={g.get('takeover')} defaultModel={g.get('defaultModel')} "
                 f"backgroundModel={g.get('backgroundModel')} applied="
                 + ("无" if not a else f"phase={a.get('phase')} originals={json.dumps(a.get('originals'), ensure_ascii=False)}"))
    p(f"{fam}：整段指纹 {canon}{extra}")
    for pr in g.get("providers") or []:
        sel = [m.get("id") for m in pr.get("models") or [] if m.get("selected")]
        p(f"  网关 id={pr.get('id')} name={pr.get('name')} 地址={pr.get('baseUrl')} 协议={pr.get('protocol')} "
          f"模型 {len(pr.get('models') or [])} 个，已选 {sel}")

print("\n\033[1m==> Claude 的四个文件\033[0m")
lib = os.path.join(base, "Claude-3p", "configLibrary")
files = [("Claude/claude_desktop_config.json", os.path.join(base, "Claude", "claude_desktop_config.json")),
         ("Claude-3p/claude_desktop_config.json", os.path.join(base, "Claude-3p", "claude_desktop_config.json")),
         ("configLibrary/_meta.json", os.path.join(lib, "_meta.json")),
         (f"configLibrary/{sid}.json（Sophia 的 profile）", os.path.join(lib, sid + ".json"))]
for label, path in files:
    if not os.path.exists(path):
        p(f"{label}：不存在"); continue
    mode = stat.filemode(os.stat(path).st_mode)
    try:
        obj = json.load(open(path, encoding="utf-8-sig"))
    except Exception as e:
        p(f"{label}：{mode} sha256:{sha(path)} 不是合法 JSON（{e}）"); continue
    if label.startswith("Claude"):
        p(f"{label}：{mode} sha256:{sha(path)} deploymentMode={obj.get('deploymentMode', '（缺失）')!r} 顶层键={sorted(obj)}")
    elif "_meta" in label:
        p(f"{label}：{mode} sha256:{sha(path)} appliedId={obj.get('appliedId', '（缺失）')!r} entries={obj.get('entries')}")
    else:
        shown = {k: ("<令牌，长 %d，未显示>" % len(v) if k == "inferenceGatewayApiKey" and isinstance(v, str) else v) for k, v in obj.items()}
        p(f"{label}：{mode} sha256:{sha(path)}")
        for line in json.dumps(shown, ensure_ascii=False, indent=2).splitlines():
            p("  " + line)
if os.path.isdir(lib):
    others = sorted(f for f in os.listdir(lib) if f not in ("_meta.json", sid + ".json"))
    p("configLibrary 里其余文件：" + ("、".join(others) if others else "没有"))
baks = []
for d in (os.path.join(base, "Claude"), os.path.join(base, "Claude-3p"), lib):
    if os.path.isdir(d):
        baks += [os.path.join(os.path.basename(d), f) for f in os.listdir(d) if ".sophia-models" in f]
p("Sophia 留下的 .sophia-models*.bak：" + ("、".join(sorted(baks)) if baks else "没有"))

print("\n\033[1m==> Claude 路由清单（Sophia 写的；不含密钥）\033[0m")
cr = os.path.join(data, "gateway", "claude-routing.json")
try:
    r = json.load(open(cr))
    for m in r.get("models") or []:
        p(f"{m.get('slug')} → 上游模型 {m.get('upstream_model')}（网关 {m.get('provider')}，显示名 {m.get('label')}）")
    for pr in r.get("providers") or []:
        p(f"网关 {pr.get('id')}：{pr.get('base_url')}（{pr.get('protocol')}）")
except FileNotFoundError:
    p("不存在")
except Exception as e:
    p(f"读不了：{e}")
PY
  step "钥匙串里 service=symsync 的条目（只列账户名）"
  keychain_names | sed 's/^/    /'
  if [ "$lines" != 0 ]; then
    step "路由日志最后 $lines 行（$DATA_DIR/gateway-logs/router.log；只有时间、家、模型、路径、状态）"
    tail -n "$lines" "$DATA_DIR/gateway-logs/router.log" 2>/dev/null | sed 's/^/    /' || info "没有路由日志"
  fi
}

cmd_claude4() {
  local name="${1:-}"
  [ -n "$name" ] || die "claude4 要一个名字"
  local out="$EVIDENCE/claude4-$name"
  mkdir -p "$out"
  python3 - "$LAB_BASE" "$SOPHIA_ID" "$out" <<'PY'
import hashlib, json, os, shutil, stat, sys
base, sid, out = sys.argv[1:]
lib = os.path.join(base, "Claude-3p", "configLibrary")
files = {"config-1p.json": os.path.join(base, "Claude", "claude_desktop_config.json"),
         "config-3p.json": os.path.join(base, "Claude-3p", "claude_desktop_config.json"),
         "meta.json": os.path.join(lib, "_meta.json")}
summary = {}
for name, path in files.items():
    if os.path.exists(path):
        shutil.copyfile(path, os.path.join(out, name))
        summary[name] = {"sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(), "mode": stat.filemode(os.stat(path).st_mode)}
    else:
        summary[name] = None
prof = os.path.join(lib, sid + ".json")
if os.path.exists(prof):
    raw = open(prof, "rb").read()
    info = {"sha256": hashlib.sha256(raw).hexdigest(), "mode": stat.filemode(os.stat(prof).st_mode)}
    try:
        obj = json.loads(raw.decode("utf-8-sig"))
        k = obj.get("inferenceGatewayApiKey")
        if isinstance(k, str):
            info["tokenShape"] = f"长 {len(k)}，{'sophia- 开头' if k.startswith('sophia-') else '不是 sophia- 开头'}"
            # 令牌本身不落盘；只记它的 sha256 前 12 位，用来比「切回再打开后令牌没变」
            info["tokenSha12"] = hashlib.sha256(k.encode()).hexdigest()[:12]
            obj["inferenceGatewayApiKey"] = "<令牌已打码>"
        json.dump(obj, open(os.path.join(out, "profile.masked.json"), "w"), ensure_ascii=False, indent=2)
    except Exception as e:
        info["error"] = f"不是合法 JSON：{e}"
    summary["profile"] = info
else:
    summary["profile"] = None
others = sorted(os.listdir(lib)) if os.path.isdir(lib) else []
summary["configLibrary"] = others
json.dump(summary, open(os.path.join(out, "summary.json"), "w"), ensure_ascii=False, indent=2)
for k, v in summary.items():
    print(f"    {k}: {v if k == 'configLibrary' else ('不存在' if v is None else v)}")
print(f"    已存 {out}/")
PY
}

cmd_claude4_diff() {
  local a="${1:-}" b="${2:-}"
  [ -n "$a" ] && [ -n "$b" ] || die "claude4-diff 要两个快照名"
  local da="$EVIDENCE/claude4-$a" db="$EVIDENCE/claude4-$b"
  [ -d "$da" ] && [ -d "$db" ] || die "找不到快照 $da 或 ${db}（先跑 claude4 <名字>）"
  local f
  for f in config-1p.json config-3p.json meta.json profile.masked.json; do
    if [ ! -e "$da/$f" ] && [ ! -e "$db/$f" ]; then
      info "${f}：两边都不存在"
    elif [ ! -e "$da/$f" ] || [ ! -e "$db/$f" ]; then
      info "${f}：$( [ -e "$da/$f" ] && echo "$a 有、$b 没有" || echo "$a 没有、$b 有")"
    elif cmp -s "$da/$f" "$db/$f"; then
      info "${f}：字节相同"
    else
      info "${f}：不同 ↓"
      diff -u "$da/$f" "$db/$f" | sed 's/^/      /' | head -40
    fi
  done
  python3 - "$da/summary.json" "$db/summary.json" <<'PY'
import json, sys
a, b = (json.load(open(x)) for x in sys.argv[1:])
pa, pb = a.get("profile"), b.get("profile")
if pa and pb:
    print(f"    profile 原文指纹：{'相同' if pa['sha256'] == pb['sha256'] else '不同'}；权限 {pa['mode']} → {pb['mode']}")
print(f"    configLibrary：{a.get('configLibrary')} → {b.get('configLibrary')}")
PY
}

cmd_backup() {
  require_sophia_quit
  local stamp dest
  stamp="$(date +%Y%m%d-%H%M%S)"
  dest="$LAB_STATE_DIR/sophia-backups/sophia-backup-$stamp"
  if lab_in_icloud "$LAB_STATE_DIR"; then die "$LAB_STATE_DIR 在 iCloud 同步目录里，不要把备份放这里。"; fi
  [ -e "$dest" ] && die "$dest 已存在，过一秒再试。"
  mkdir -p "$LAB_STATE_DIR/sophia-backups" && mkdir -m 700 "$dest" || die "建不了 $dest"
  step "备份 Sophia 这一侧 → $dest"
  mkdir -p "$dest/codex" "$dest/symsync" "$dest/launchagents" "$dest/claude4"
  local f
  for f in "$CODEX_DIR"/config.toml "$CODEX_DIR"/config.models*.bak "$CODEX_DIR"/symsync-*; do
    [ -f "$f" ] && cp -p "$f" "$dest/codex/" && info "~/.codex/$(basename "$f")"
  done
  [ -f "$DATA_DIR/settings.json" ] && cp -p "$DATA_DIR/settings.json" "$dest/symsync/" && info "settings.json"
  [ -d "$DATA_DIR/bin" ] && cp -Rp "$DATA_DIR/bin" "$dest/symsync/bin" && info "bin/"
  [ -d "$DATA_DIR/gateway" ] && cp -Rp "$DATA_DIR/gateway" "$dest/symsync/gateway" && info "gateway/"
  [ -f "$PLIST" ] && cp -p "$PLIST" "$dest/launchagents/" && info "$(basename "$PLIST")"
  [ -f "$PLIST" ] || info "路由服务的 plist 不存在（备份时没装路由）"
  local lib="$LAB_BASE/Claude-3p/configLibrary"
  [ -f "$LAB_BASE/Claude/claude_desktop_config.json" ] && cp -p "$LAB_BASE/Claude/claude_desktop_config.json" "$dest/claude4/config-1p.json"
  [ -f "$LAB_BASE/Claude-3p/claude_desktop_config.json" ] && cp -p "$LAB_BASE/Claude-3p/claude_desktop_config.json" "$dest/claude4/config-3p.json"
  [ -f "$lib/_meta.json" ] && cp -p "$lib/_meta.json" "$dest/claude4/meta.json"
  [ -d "$lib" ] && ls -1 "$lib" > "$dest/claude4/configLibrary.txt"
  [ -f "$lib/$SOPHIA_ID.json" ] && warn "备份时 configLibrary 里已经有 Sophia 的 profile（不是干净的基线？）"
  info "Claude 的三个文件与 configLibrary 清单"
  launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 && echo loaded > "$dest/router-loaded" || echo not-loaded > "$dest/router-loaded"
  keychain_names > "$dest/keychain-accounts.txt"
  info "钥匙串 symsync 条目名：$(tr '\n' ' ' < "$dest/keychain-accounts.txt")"
  (cd "$dest" && find . -type f ! -name manifest.txt -exec shasum -a 256 {} + | sort -k2) > "$dest/manifest.txt"
  echo "$dest" > "$LAB_STATE_DIR/SOPHIA_BASELINE"
  step "完成：${dest}（路径已写进 $LAB_STATE_DIR/SOPHIA_BASELINE）"
}

baseline_dir() {
  local d="${1:-}"
  [ -n "$d" ] || d="$(cat "$LAB_STATE_DIR/SOPHIA_BASELINE" 2>/dev/null || true)"
  [ -n "$d" ] && [ -d "$d" ] || die "找不到 Sophia 这一侧的备份（$LAB_STATE_DIR/SOPHIA_BASELINE）。"
  printf '%s' "$d"
}

cmd_compare() {
  local bk
  bk="$(baseline_dir "${1:-}")" || exit 1
  step "现在 vs 备份 $bk"
  python3 - "$bk" "$CODEX_DIR" "$DATA_DIR" "$PLIST" "$LAB_BASE" "$SOPHIA_ID" <<'PY'
import filecmp, glob, json, os, sys
bk, codex, data, plist, base, sid = sys.argv[1:]
bad = 0
def p(s): print("    " + s)
def same(a, b):
    ea, eb = os.path.exists(a), os.path.exists(b)
    if not ea and not eb: return "两边都没有"
    if ea != eb: return "备份有、现在没有" if ea else "备份没有、现在有"
    return "字节相同" if filecmp.cmp(a, b, shallow=False) else "不同"
now_codex = {os.path.basename(f) for f in glob.glob(os.path.join(codex, "config.toml")) + glob.glob(os.path.join(codex, "config.models*.bak")) + glob.glob(os.path.join(codex, "symsync-*"))}
bak_codex = set(os.listdir(os.path.join(bk, "codex")))
for name in sorted(now_codex | bak_codex):
    r = same(os.path.join(bk, "codex", name), os.path.join(codex, name))
    bad += r != "字节相同"
    p(f"~/.codex/{name}：{r}")
try:
    a = json.load(open(os.path.join(bk, "symsync", "settings.json")))
    b = json.load(open(os.path.join(data, "settings.json")))
    for fam in ("codexGateway", "claudeGateway"):
        ga, gb = a.get(fam), b.get(fam)
        if ga == gb:
            p(f"settings.json 的 {fam}：相同" + ("（两边都没有）" if ga is None else ""))
        else:
            bad += 1
            keys = sorted(k for k in set(ga or {}) | set(gb or {}) if (ga or {}).get(k) != (gb or {}).get(k))
            p(f"settings.json 的 {fam}：不同（{'备份没有这一段' if ga is None else '现在没有这一段' if gb is None else '不同的键：' + '、'.join(keys)}）")
    others = sorted(k for k in set(a) | set(b) if k not in ("codexGateway", "claudeGateway") and a.get(k) != b.get(k))
    p("settings.json 其余键里变了的（Sophia 平时也会改，只列出不计入）：" + ("、".join(others) if others else "没有"))
except Exception as e:
    bad += 1
    p(f"settings.json 比不了：{e}")
for sub in ("bin", "gateway"):
    names = set()
    for root in (os.path.join(bk, "symsync", sub), os.path.join(data, sub)):
        if os.path.isdir(root):
            names |= {os.path.relpath(os.path.join(dp, f), root) for dp, _, fs in os.walk(root) for f in fs}
    for n in sorted(names):
        r = same(os.path.join(bk, "symsync", sub, n), os.path.join(data, sub, n))
        bad += r not in ("字节相同",)
        p(f"SymSync/{sub}/{n}：{r}")
r = same(os.path.join(bk, "launchagents", os.path.basename(plist)), plist)
bad += r not in ("字节相同", "两边都没有")
p(f"路由服务 plist：{r}")
lib = os.path.join(base, "Claude-3p", "configLibrary")
for name, path in (("config-1p.json", os.path.join(base, "Claude", "claude_desktop_config.json")),
                   ("config-3p.json", os.path.join(base, "Claude-3p", "claude_desktop_config.json")),
                   ("meta.json", os.path.join(lib, "_meta.json"))):
    r = same(os.path.join(bk, "claude4", name), path)
    note = ""
    if r == "不同" and name.startswith("config"):
        try:
            ja = json.load(open(os.path.join(bk, "claude4", name), encoding="utf-8-sig"))
            jb = json.load(open(path, encoding="utf-8-sig"))
            dm = "deploymentMode 相同" if ja.get("deploymentMode") == jb.get("deploymentMode") else f"deploymentMode {ja.get('deploymentMode')!r} → {jb.get('deploymentMode')!r}"
            ks = sorted(k for k in set(ja) | set(jb) if k != "deploymentMode" and ja.get(k) != jb.get(k))
            note = f"（{dm}；其余变了的键：{'、'.join(ks) if ks else '没有，只是排版'}）"
        except Exception as e:
            note = f"（{e}）"
    bad += r not in ("字节相同", "两边都没有") and not (note.startswith("（deploymentMode 相同"))
    p(f"Claude {name}：{r}{note}")
try:
    before = open(os.path.join(bk, "claude4", "configLibrary.txt")).read().split()
except FileNotFoundError:
    before = []
now = sorted(os.listdir(lib)) if os.path.isdir(lib) else []
p(f"configLibrary：备份 {before} → 现在 {now}")
print(f"\n==> {'关键项都与备份一致' if bad == 0 else f'有 {bad} 处与备份不一致（见上）'}")
PY
  local now
  now="$(keychain_names)"
  if [ "$now" = "$(cat "$bk/keychain-accounts.txt")" ]; then
    info "钥匙串 symsync 条目名：与备份相同"
  else
    info "钥匙串 symsync 条目名：备份 [$(tr '\n' ' ' < "$bk/keychain-accounts.txt")] → 现在 [$(printf '%s' "$now" | tr '\n' ' ')]"
  fi
  if launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then info "路由服务：现在已加载（备份时 $(cat "$bk/router-loaded")）"; else info "路由服务：现在没加载（备份时 $(cat "$bk/router-loaded")）"; fi
}

# 把现在的 <路径> 挪到 $LAB/aside/restore-<时间>/<分组>/<名字>（不删；不留在原目录里，免得又被 symsync-* 之类的名字匹配到）
move_aside() {
  local cur="$1" group="$2" dir="$LAB_STATE_DIR/aside/restore-$STAMP/$2"
  local aside
  mkdir -p "$dir" || die "建不了 $dir"
  aside="$dir/$(basename "$cur")"
  [ -e "$aside" ] && die "$aside 已存在，没挪。"
  mv -n "$cur" "$aside" && info "挪开：$cur → $aside"
}

cmd_restore() {
  local bk
  bk="$(baseline_dir "${1:-}")" || exit 1
  STAMP="$(date +%Y%m%d-%H%M%S)"
  step "把 Sophia 这一侧放回备份的样子：$bk"
  require_sophia_quit
  if [ "$(cat "$bk/router-loaded")" = not-loaded ] && launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
    die "路由服务现在还装着，备份时没有。先在 Sophia 里把 Codex、Claude 都关掉（两家都关才卸），确认卸了再来；不要直接换 bin/。"
  fi
  if sophia_is_real; then confirm_real "将按备份放回 ~/.codex 的几份文件、SymSync 的 settings.json、bin/、gateway/（现在的挪到一旁，不删）。"; fi
  local f name
  for f in "$CODEX_DIR"/config.toml "$CODEX_DIR"/config.models*.bak "$CODEX_DIR"/symsync-*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    if [ -f "$bk/codex/$name" ]; then
      cmp -s "$f" "$bk/codex/$name" || { move_aside "$f" codex; cp -p "$bk/codex/$name" "$f"; info "放回 ~/.codex/$name"; }
    else
      move_aside "$f" codex
    fi
  done
  for f in "$bk"/codex/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    [ -e "$CODEX_DIR/$name" ] || { cp -p "$f" "$CODEX_DIR/$name"; info "放回 ~/.codex/${name}（现在没有）"; }
  done
  if [ -f "$bk/symsync/settings.json" ]; then
    if ! cmp -s "$DATA_DIR/settings.json" "$bk/symsync/settings.json"; then
      [ -e "$DATA_DIR/settings.json" ] && move_aside "$DATA_DIR/settings.json" SymSync
      cp -p "$bk/symsync/settings.json" "$DATA_DIR/settings.json" && info "放回 settings.json"
    fi
  fi
  local sub
  for sub in bin gateway; do
    if [ -d "$bk/symsync/$sub" ]; then
      if ! diff -rq "$bk/symsync/$sub" "$DATA_DIR/$sub" >/dev/null 2>&1; then
        [ -e "$DATA_DIR/$sub" ] && move_aside "$DATA_DIR/$sub" SymSync
        cp -Rp "$bk/symsync/$sub" "$DATA_DIR/$sub" && info "放回 SymSync/$sub/"
      fi
    elif [ -e "$DATA_DIR/$sub" ]; then
      move_aside "$DATA_DIR/$sub" SymSync
    fi
  done
  step "完成。plist、钥匙串、Claude 的文件没有动；用 compare 再核对一遍。挪开的东西在 $LAB_STATE_DIR/aside/restore-$STAMP/，交给人决定删不删。"
}

cmd_claude_reset() {
  local bk
  bk="$(baseline_dir "${1:-}")" || exit 1
  require_desktop_quit
  if lab_is_real_base; then confirm_real "将把 Claude 的 _meta.json 放回备份、把备份时没有的 profile 挪到 $LAB_STATE_DIR/aside/、把两份 deploymentMode 改回原值。"; fi
  python3 - "$bk/claude4" "$LAB_BASE" "$LAB_STATE_DIR/aside/$(date +%Y%m%d-%H%M%S)" <<'PY'
import json, os, re, shutil, sys, tempfile
bk, base, aside = sys.argv[1:]
lib = os.path.join(base, "Claude-3p", "configLibrary")
def say(s): print("    " + s)
def atomic_write(path, data):
    mode = os.stat(path).st_mode & 0o777
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".lab-", suffix=".tmp")
    with os.fdopen(fd, "wb") as f:
        f.write(data); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, mode); os.replace(tmp, path)
# 1. 备份时没有的 profile 挪开（不删）
before = open(os.path.join(bk, "configLibrary.txt")).read().split() if os.path.exists(os.path.join(bk, "configLibrary.txt")) else []
if os.path.isdir(lib):
    for f in sorted(os.listdir(lib)):
        if f.endswith(".json") and f != "_meta.json" and f not in before:
            os.makedirs(os.path.join(aside, "configLibrary"), exist_ok=True)
            shutil.move(os.path.join(lib, f), os.path.join(aside, "configLibrary", f))
            say(f"挪开 configLibrary/{f} → {aside}/configLibrary/")
# 2. _meta.json 放回原样
src, dst = os.path.join(bk, "meta.json"), os.path.join(lib, "_meta.json")
if os.path.exists(src):
    if not os.path.exists(dst) or open(src, "rb").read() != open(dst, "rb").read():
        if os.path.exists(dst):
            os.makedirs(os.path.join(aside, "configLibrary"), exist_ok=True)
            shutil.copy2(dst, os.path.join(aside, "configLibrary", "_meta.json"))
        shutil.copy2(src, dst)
        say("放回 _meta.json（改前的一份存在 aside 里）")
    else:
        say("_meta.json 已与备份相同")
elif os.path.exists(dst):
    say("！备份时没有 _meta.json，现在有：没动它，交给人")
# 3. 两份 deploymentMode 只改值
for name, path in (("config-1p.json", os.path.join(base, "Claude", "claude_desktop_config.json")),
                   ("config-3p.json", os.path.join(base, "Claude-3p", "claude_desktop_config.json"))):
    want = json.load(open(os.path.join(bk, name), encoding="utf-8-sig")).get("deploymentMode") if os.path.exists(os.path.join(bk, name)) else None
    raw = open(path, "rb").read()
    text = raw.decode("utf-8")
    cur = json.loads(text.lstrip("﻿"))
    if cur.get("deploymentMode") == want:
        say(f"{name}：deploymentMode 已是 {want!r}")
        continue
    if want is None or "deploymentMode" not in cur:
        say(f"！{name}：备份里 {want!r}、现在 {cur.get('deploymentMode', '（缺失）')!r}，不是「只改值」能办的，没动，交给人")
        continue
    new, n = re.subn(r'("deploymentMode"\s*:\s*)"[^"\\]*"', lambda m: m.group(1) + json.dumps(want), text, count=1)
    after = json.loads(new.lstrip("﻿"))
    if n != 1 or after.get("deploymentMode") != want or {k: v for k, v in after.items() if k != "deploymentMode"} != {k: v for k, v in cur.items() if k != "deploymentMode"}:
        say(f"！{name}：改完核对不上，没写，交给人"); continue
    atomic_write(path, new.encode("utf-8"))
    say(f"{name}：deploymentMode {cur.get('deploymentMode')!r} → {want!r}（其余字节不动）")
PY
}

cmd_dm_only() {
  [ $# -eq 2 ] || die "dm-only 要两个文件"
  python3 - "$1" "$2" <<'PY'
import difflib, json, re, sys
a_path, b_path = sys.argv[1:]
try:
    a, b = (open(x, "rb").read().decode("utf-8") for x in (a_path, b_path))
except FileNotFoundError as e:
    sys.exit(f"[中止] {e}")
if a == b:
    print("    完全相同（字节一致）"); sys.exit(0)
pat = r'("deploymentMode"\s*:\s*)"[^"\\]*"'
def dm(text):
    try: return json.loads(text.lstrip("﻿")).get("deploymentMode", "（缺失）")
    except Exception as e: return f"（不是合法 JSON：{e}）"
want = dm(b)
swapped, n = re.subn(pat, lambda m: m.group(1) + json.dumps(want), a, count=1)
if n == 1 and swapped == b:
    print(f"    只差 deploymentMode：{dm(a)!r} → {want!r}，其余字节相同"); sys.exit(0)
print(f"    除 deploymentMode（{dm(a)!r} → {want!r}）外还有别的字节不同 ↓")
for line in list(difflib.unified_diff(a.splitlines(), b.splitlines(), a_path, b_path, lineterm=""))[:40]:
    print("      " + line)
sys.exit(1)
PY
}

cmd_profile_set() {
  local what="${1:-}" arg="${2:-}"
  require_desktop_quit
  local prof="$LAB_BASE/Claude-3p/configLibrary/$SOPHIA_ID.json"
  [ -f "$prof" ] || die "Sophia 的 profile 不存在：$prof"
  python3 - "$prof" "$what" "$arg" <<'PY'
import json, os, re, sys, tempfile
path, what, arg = sys.argv[1:]
text = open(path, "rb").read().decode("utf-8")
obj = json.loads(text.lstrip("﻿"))
if what == "base-port":
    if not arg.isdigit():
        sys.exit("[中止] base-port 后面要一个端口号")
    url = obj.get("inferenceGatewayBaseUrl", "")
    m = re.match(r"^(http://127\.0\.0\.1:)(\d+)(/.*)?$", url)
    if not m:
        sys.exit(f"[中止] 网关地址不是 http://127.0.0.1:<端口>/… 的样子：{url!r}")
    new_url = m.group(1) + arg + (m.group(3) or "")
    new, n = re.subn(r'("inferenceGatewayBaseUrl"\s*:\s*)"[^"\\]*"', lambda x: x.group(1) + json.dumps(new_url), text, count=1)
    msg = f"网关地址 {url} → {new_url}"
elif what == "token-wrong":
    new, n = re.subn(r'("inferenceGatewayApiKey"\s*:\s*)"[^"\\]*"', lambda x: x.group(1) + json.dumps("sophia-lab-wrong-token"), text, count=1)
    msg = "令牌换成了一个错的（新旧值都不打印）"
else:
    sys.exit("[中止] profile-set 只认 base-port <端口> / token-wrong")
after = json.loads(new.lstrip("﻿"))
key = "inferenceGatewayBaseUrl" if what == "base-port" else "inferenceGatewayApiKey"
if n != 1 or {k: v for k, v in after.items() if k != key} != {k: v for k, v in obj.items() if k != key}:
    sys.exit("[中止] 改完核对不上，没写")
mode = os.stat(path).st_mode & 0o777
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".lab-", suffix=".tmp")
with os.fdopen(fd, "wb") as f:
    f.write(new.encode("utf-8")); f.flush(); os.fsync(f.fileno())
os.chmod(tmp, mode); os.replace(tmp, path)
print(f"    {msg}；权限保持 {oct(mode)}")
PY
}

cmd_token_check() {
  local prof="$LAB_BASE/Claude-3p/configLibrary/$SOPHIA_ID.json"
  [ -f "$prof" ] || die "Sophia 的 profile 不存在：$prof（Claude 没打开时查不了）"
  python3 - "$prof" "$DATA_DIR" "$LAB_STATE_DIR" "$@" <<'PY'
import json, os, sys
prof, data, lab, *extra = sys.argv[1:]
tok = json.load(open(prof, encoding="utf-8-sig")).get("inferenceGatewayApiKey")
if not isinstance(tok, str) or len(tok) < 20:
    sys.exit("[中止] profile 里没有像样的令牌")
needle = tok.encode()
targets = [os.path.join(data, "settings.json"), os.path.join(data, "gateway-logs"), os.path.join(data, "gateway"),
           os.path.join(lab, "capture"), os.path.join(lab, "tee"), os.path.join(lab, "evidence")] + list(extra)
def files(t):
    if os.path.isfile(t):
        yield t
    elif os.path.isdir(t):
        for dp, _, fns in os.walk(t):
            for f in fns:
                yield os.path.join(dp, f)
hit = 0
for t in targets:
    if not os.path.exists(t):
        print(f"    {t}：不存在，跳过"); continue
    found = [f for f in files(t) if needle in open(f, "rb").read()]
    hit += len(found)
    print(f"    {t}：{'搜到！' + '、'.join(found[:5]) if found else '没搜到'}")
print(f"\n==> {'令牌只在该在的地方（profile、钥匙串）' if hit == 0 else f'有 {hit} 个文件里出现了令牌（见上），按中止处理'}")
sys.exit(1 if hit else 0)
PY
}

cmd_sim_phase() {
  [ "${1:-}" = restoring ] || die "sim-phase 只认 restoring"
  require_sophia_quit
  local s="$DATA_DIR/settings.json"
  local keep="$LAB_STATE_DIR/aside/settings.before-sim-phase-$(date +%Y%m%d-%H%M%S).json"
  mkdir -p "$(dirname "$keep")" && cp -p "$s" "$keep" && info "改前整份另存：$keep"
  python3 - "$s" <<'PY'
import json, os, sys, tempfile
path = sys.argv[1]
s = json.load(open(path))
g = s.get("claudeGateway") or {}
a = g.get("applied")
if not a:
    sys.exit("[中止] claudeGateway.applied 不存在：Claude 现在没写着 Sophia 的配置，模拟不了「切回没做完」")
g["enabled"] = False
a["phase"] = "restoring"
mode = os.stat(path).st_mode & 0o777
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".lab-", suffix=".tmp")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(s, f, ensure_ascii=False, indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
os.chmod(tmp, mode); os.replace(tmp, path)
print("    claudeGateway.enabled=false，applied.phase=restoring")
PY
}

CMD="${1:-}"
[ $# -gt 0 ] && shift
case "$CMD" in
  app) cmd_app "$@" ;;
  status) cmd_status "$@" ;;
  claude4) cmd_claude4 "$@" ;;
  claude4-diff) cmd_claude4_diff "$@" ;;
  backup) cmd_backup ;;
  compare) cmd_compare "$@" ;;
  restore) cmd_restore "$@" ;;
  claude-reset) cmd_claude_reset "$@" ;;
  dm-only) cmd_dm_only "$@" ;;
  profile-set) cmd_profile_set "$@" ;;
  token-check) cmd_token_check "$@" ;;
  sim-phase) cmd_sim_phase "$@" ;;
  -h|--help|"") awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; [ -n "$CMD" ] || exit 2 ;;
  *) die "不认识的子命令：${CMD}（--help 看用法）" ;;
esac

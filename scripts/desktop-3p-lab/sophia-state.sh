#!/usr/bin/env bash
# Sophia 这一侧（模型网关）真机验收用的小工具：看状态、起停被测的 Sophia、备份 / 比对 / 恢复网关相关的文件，
# 以及几种只在 Claude 桌面应用退出时才做的「造现场」改动。给 docs/testing/2026-09-30-claude-third-party-acceptance.md 用。
#
# 2026-10-03 起路由在 Sophia 进程里跑（spec 2026-10-03-gateway-in-app）：Sophia 开着、且 Codex 或 Claude 有一家开着才有路由，
# 端口读 settings.json 的 codexGateway.port（被占时会自动换到 47329–47339），没有 launchd 服务、没有 bin/ 程序副本。
# 下面只把旧版留下的 launchd 服务（标签 com.zhengjiaqiao.sophia.gateway）当残留看一眼（新版打开时会卸掉它、删掉 plist 与 bin/，R14）。
# 服务商密钥与 Claude 网关令牌都在 <数据目录>/secrets.json（0600），不在钥匙串。
#
# 用法：scripts/desktop-3p-lab/sophia-state.sh <子命令> [参数]
#   app status              只读：列出正在跑的 Sophia 界面进程（安装版、开发版、别的 worktree 的都算）、包 id 与可执行文件路径
#   app quit [--wait 秒]    让所有 Sophia 界面进程正常退出（按各自的包 id 发 Apple 事件 quit，同从 Dock 退出；不 kill），
#                           默认每轮等 15 秒。注意：这条路不弹确认框，Sophia 会把 Codex 设置改回原样（不重启 Codex）、
#                           不动 Claude（spec R10）——Claude 若正处在 Sophia 写的第三方模式，路由一停它就连不上
#   app open [--wait 秒]    没有任何 Sophia 在跑时，打开被测包（SOPHIA_LAB_APP），并核对跑起来的就是它、包 id 对
#   status [--log-lines N]  只读：路由、~/.codex、Sophia 设置里两家的网关摘要、密钥文件 secrets.json 的权限与项目名、
#                           Claude 的四个文件、Sophia 改写前备份（<数据目录>/backups/）、Claude 路由清单、路由日志末尾。
#                           不显示任何密钥与令牌
#   claude4 <名字>          只读：把 Claude 的四个文件拍一份快照到 $LAB/evidence/claude4-<名字>/
#                           （两份 claude_desktop_config.json 与 _meta.json 原样复制；Sophia 的 profile 只存令牌打码后的 JSON、
#                            sha256 与权限）
#   claude4-diff <甲> <乙>  只读：比两份快照，逐文件说「字节相同 / 不同」，不同的列出差异（profile 只比打码后的内容与指纹）
#   backup                  备份 Sophia 这一侧：~/.codex 的 config.toml、sophia-*；Sophia 的 settings.json、secrets.json（含密钥，
#                           权限保持 0600）、gateway/；Claude 的三个文件与 configLibrary 清单；<数据目录>/backups/ 的文件清单。
#                           放在 $LAB/sophia-backups/sophia-backup-<时间>/（0700）。每一项「在 / 不在」明确记进 presence.txt；
#                           任何一步失败（读不了、复制后核对不上）都中止、非零退出，不写 COMPLETE、不动 $LAB/SOPHIA_BASELINE；
#                           全部成功才写 COMPLETE 并把路径写进 $LAB/SOPHIA_BASELINE。Sophia 要先退出
#   compare [备份目录]       只读：现在与备份逐项比对（缺省用 $LAB/SOPHIA_BASELINE）；secrets.json 只比字节与项目名，不显示值；
#                           configLibrary 清单变了也计入。有不一致时非零退出
#   restore [备份目录]       把 ~/.codex 那几份、settings.json、secrets.json、gateway/ 放回备份的样子（现在的挪到
#                           $LAB/aside/restore-<时间>/，不删）。只认 presence.txt：记 present 的放回，记 absent 的现在若有就挪开，
#                           没记的不动并中止；不完整的备份（没有 COMPLETE）拒绝。先查备份里该在的都在、读得了才开始动；
#                           先把要换掉、要挪开的全部挪到 aside，再逐项放回并核对；任何一项失败，或中途收到 Ctrl+C / SIGTERM /
#                           SIGHUP，都整体撤回（删掉已放回的、原件全部挪回）并非零退出。成功后 aside 留着交给人，不自动删。
#                           secrets.json 不管内容是否相同都校正到 0600。不碰 Claude 的文件、<数据目录>/backups/。要输入 yes
#   bak-of <文件>            只读：打印 Sophia 给这个文件做的最新一份改写前备份（<数据目录>/backups/<名>-<哈希>/<序号>-*.bak，
#                           按目录里的 source 认原文件）；没有就以 1 退出
#   claude-reset [备份目录]  Claude 退出时，把 Claude 的四个文件回到备份时的「模式与生效指向」：_meta.json 放回原样；
#                           configLibrary 里备份时没有的 profile（Sophia 的、模拟别家的）挪到 $LAB/aside/<时间>/；
#                           两份 claude_desktop_config.json 只把 deploymentMode 的值改回原值（其余字节不动）。要输入 yes
#   dm-only <甲文件> <乙文件>  只读：乙是否只在 deploymentMode 的值上与甲不同（其余字节逐字节相同）；
#                           用来核对 Sophia 改 claude_desktop_config.json 时只动了这一个成员（甲用 bak-of 找到的改写前备份）
#   profile-set base-port <端口>   Claude 退出时，把 Sophia profile 里网关地址的端口换成 <端口>（其余字节不动）
#   profile-set token-wrong        Claude 退出时，把 Sophia profile 里的令牌换成一个错的（不打印新旧值）
#   token-check [目录…]           只读：先核对 secrets.json 的 claudeRouterToken 与 profile 里的令牌相同（只比不打印；
#                                  缺失、读不了、不一致都算失败），
#                                  再拿令牌去搜 settings.json、路由日志、Claude 路由清单、$LAB 下的抓包与代理记录（及另给的目录），
#                                  只报每处「搜到 / 没搜到」，不打印令牌；<数据目录>/backups/ 单列（改写前备份，交给人判断）
#   sim-phase restoring            Sophia 退出时，把 settings.json 里 Claude 的记录改成「切回没做完」（enabled=false、
#                                  applied.phase=restoring），模拟切回写到一半 Sophia 没了；改前整份另存一份
#
# 路径都能换，自测时指向临时目录：
#   SOPHIA_LAB_DATA_DIR    Sophia 数据目录，默认 ~/Library/Application Support/Sophia（不随包 id 变）
#   SOPHIA_LAB_CODEX_HOME  默认 ${CODEX_HOME}，没有则 ~/.codex
#   SOPHIA_LAB_AGENTS_DIR  默认 ~/Library/LaunchAgents（只用来看旧版 launchd 服务的残留）
#   SOPHIA_LAB_APP         被测包，默认本仓库 target/debug/bundle/macos/Sophia.app
#   SOPHIA_LAB_BUNDLE_ID   被测包的包 id，默认读被测包的 Info.plist（读不到按 com.zhengjiaqiao.sophia）。
#                          本轮用 --config '{"identifier":"com.zhengjiaqiao.sophia.diagtest"}' 构建，就是 com.zhengjiaqiao.sophia.diagtest；
#                          安装版 com.zhengjiaqiao.sophia，make dev / make build 是 com.zhengjiaqiao.sophia.dev
#   CLAUDE_LAB_BASE / CLAUDE_LAB_STATE_DIR 同 lib.sh
# Sophia「没在跑」的检查只在上面几个目录都是真目录时才生效；自测时（指向临时目录）跳过。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# 旧版 launchd 路由服务的标签（crates/gateway/src/app/mod.rs SERVICE_LABEL）：新版只卸它，不再装
LEGACY_SERVICE_LABEL=com.zhengjiaqiao.sophia.gateway
SOPHIA_ID=00000000-0000-4000-8000-736f70686961
REAL_DATA_DIR="$HOME/Library/Application Support/Sophia"
DATA_DIR="${SOPHIA_LAB_DATA_DIR:-$REAL_DATA_DIR}"
CODEX_DIR="${SOPHIA_LAB_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
AGENTS_DIR="${SOPHIA_LAB_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
SOPHIA_APP="${SOPHIA_LAB_APP:-$(cd "$LAB_SCRIPT_DIR/../.." && pwd)/target/debug/bundle/macos/Sophia.app}"
SOPHIA_EXE=Sophia   # mainBinaryName（src-tauri/tauri.conf.json）
bundle_id_of() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null; }
SOPHIA_BUNDLE_ID="${SOPHIA_LAB_BUNDLE_ID:-$(bundle_id_of "$SOPHIA_APP" || true)}"
SOPHIA_BUNDLE_ID="${SOPHIA_BUNDLE_ID:-com.zhengjiaqiao.sophia}"
LEGACY_PLIST="$AGENTS_DIR/$LEGACY_SERVICE_LABEL.plist"
EVIDENCE="$LAB_STATE_DIR/evidence"

sophia_is_real() {
  [ -z "${SOPHIA_LAB_DATA_DIR:-}" ] || same_path "$DATA_DIR" "$REAL_DATA_DIR"
}

# Sophia 界面进程：可执行文件以 /Contents/MacOS/Sophia 结尾、第一个参数不是 gateway（那是命令行）。
# 路由在界面进程里，没有单独的进程。每行「pid<TAB>可执行文件路径」。只读
sophia_gui_procs() {
  ps -axo pid=,comm= 2>/dev/null | while read -r pid comm; do
    case "$comm" in
      */Contents/MacOS/"$SOPHIA_EXE")
        case "$(ps -o args= -p "$pid" 2>/dev/null)" in
          *"/Contents/MacOS/$SOPHIA_EXE gateway"*) ;;
          *) printf '%s\t%s\n' "$pid" "$comm" ;;
        esac ;;
    esac
  done
}

# 可执行文件路径 → 它所在 .app 的包 id（读不到为空）
exe_bundle_id() { bundle_id_of "${1%/Contents/MacOS/*}"; }

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

secrets_summary() {
  local f="$DATA_DIR/secrets.json"
  [ -e "$f" ] || { echo "不存在"; return 0; }
  local mode
  mode="$(stat -f '%Sp' "$f")"
  if [ "$mode" = "-rw-------" ]; then echo "权限 $mode"; else echo "权限 $mode ！应为 -rw-------（0600）"; fi
  python3 - "$f" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"读不了：{e}")
    sys.exit(0)
print(f"version {d.get('version')}")
for agent, keys in sorted((d.get("providers") or {}).items()):
    print(f"{agent}：{', '.join(sorted(keys)) or '（没有）'}")
print("Claude 网关令牌：" + ("有" if d.get("claudeRouterToken") else "没有"))
PY
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
  tested="$(cd "$SOPHIA_APP/Contents/MacOS" 2>/dev/null && pwd -P)/$SOPHIA_EXE"
  case "$sub" in
    status)
      step "Sophia 界面进程"
      local p
      p="$(sophia_gui_procs)"
      if [ -z "$p" ]; then info "没有在运行。"; fi
      printf '%s\n' "$p" | while IFS="$(printf '\t')" read -r pid exe; do
        [ -n "$pid" ] || continue
        local real tag
        real="$(cd "$(dirname "$exe")" 2>/dev/null && pwd -P)/$SOPHIA_EXE"
        if [ "$real" = "$tested" ]; then tag="被测包"; else tag="别的包！"; fi
        info "pid $pid  $exe  包 id $(exe_bundle_id "$exe")  （${tag}）"
      done
      info "被测包：${SOPHIA_APP}（包 id ${SOPHIA_BUNDLE_ID}）"
      ;;
    quit)
      step "让所有 Sophia 界面进程退出（按各自的包 id 发 Apple 事件 quit，同从 Dock 退出；不 kill）"
      info "这条路不弹确认框：Codex 设置会被改回原样（不重启 Codex），Claude 不动（spec 2026-10-03-gateway-in-app R10）"
      local round=0 n ids id
      while [ -n "$(sophia_gui_procs)" ] && [ "$round" -lt 6 ]; do
        round=$((round + 1))
        # 安装版、开发版、本轮的 diagtest 包 id 各不相同：逐个按在跑的那几个包 id 发
        ids="$(sophia_gui_procs | while IFS="$(printf '\t')" read -r _ exe; do exe_bundle_id "$exe"; echo; done | sed '/^$/d' | sort -u)"
        # 读不到包 id 时不按缺省包 id 发：给没在跑的包 id 发 quit 会先把它拉起来
        [ -n "$ids" ] || { warn "读不到在跑的 Sophia 的包 id，没发退出请求"; break; }
        for id in $ids; do
          info "退出 $id"
          osascript -e "tell application id \"$id\" to quit" >/dev/null 2>&1 \
            || warn "osascript 给 $id 发退出请求失败（没给「控制 Sophia」的授权？）"
        done
        n=0
        while [ -n "$(sophia_gui_procs)" ] && [ "$n" -lt "$wait" ]; do sleep 1; n=$((n + 1)); done
      done
      if [ -n "$(sophia_gui_procs)" ]; then
        sophia_gui_procs | sed 's/^/    /'
        die "还有 Sophia 没退出。请人在 Dock 上右键它选「退出」（同样不弹框）；托盘「退出」与 ⌘Q 会弹确认框，确认后还会重启 Codex 与 Claude，由人决定。不要 kill。"
      fi
      info "Sophia 都已退出。"
      ;;
    open)
      step "打开被测的 Sophia：$SOPHIA_APP"
      [ -x "$SOPHIA_APP/Contents/MacOS/$SOPHIA_EXE" ] || die "找不到被测包的可执行文件：$SOPHIA_APP/Contents/MacOS/$SOPHIA_EXE"
      local got_id
      got_id="$(bundle_id_of "$SOPHIA_APP")"
      [ "$got_id" = "$SOPHIA_BUNDLE_ID" ] || die "被测包的包 id 是 ${got_id:-（读不到）}，不是 SOPHIA_LAB_BUNDLE_ID 说的 ${SOPHIA_BUNDLE_ID}。"
      if [ -n "$(sophia_gui_procs)" ]; then
        sophia_gui_procs | sed 's/^/    /'
        die "已有 Sophia 在跑（单实例：同包 id 时 open 只会把它调到前台；别的包 id 会和它抢路由端口与同一个数据目录），先 app quit。"
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
        real="$(cd "$(dirname "$exe")" 2>/dev/null && pwd -P)/$SOPHIA_EXE"
        [ "$real" = "$tested" ] || bad=1
      done <<< "$p"
      [ "$count" = 1 ] && [ "$bad" = 0 ] || die "跑起来的不是（只有）被测包。先 app quit，交给人看。"
      info "在跑的就是被测包（包 id ${SOPHIA_BUNDLE_ID}，约 $n 秒）。"
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
  step "路由（端口 ${port}；在 Sophia 界面进程里，Sophia 开着且有一家开着才有）"
  info "/_health：$(curl -sS -m 3 "http://127.0.0.1:$port/_health" 2>&1 | head -c 200)"
  info "端口上在听的进程：$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $1 "(pid " $2 ")" }' | sort -u | tr '\n' ' ')"
  # 旧版留下的 launchd 服务（迁移后应当都不在；在就说明这台机器上旧版的服务还没被新版卸掉）
  if [ -e "$LEGACY_PLIST" ]; then info "！旧版 plist 还在：$LEGACY_PLIST"; else info "旧版 plist 不在（正常）"; fi
  if launchctl print "gui/$(id -u)/$LEGACY_SERVICE_LABEL" >/dev/null 2>&1; then
    info "！旧版 launchd 服务 $LEGACY_SERVICE_LABEL 还加载着"
  else
    info "旧版 launchd 服务没加载（正常）"
  fi
  [ -e "$DATA_DIR/bin" ] && info "！旧版程序副本 $DATA_DIR/bin 还在"
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
    # Sophia 写的：根键 model_catalog_json、openai_base_url；独立服务商接法再加 model_provider = "sophia" 与 [model_providers.sophia]
    ours = ("model_catalog_json", "openai_base_url", "model_provider", "[model_providers.sophia]")
    hits = [l.strip() for l in lines
            if (l.strip().startswith(ours) or ("127.0.0.1" in l and "base_url" in l))
            and not any(k in l.lower() for k in ("key", "token", "secret"))]
    p("Sophia 写的那几行：" + ("；".join(hits[:8]) if hits else "没有（Codex 没指向路由）"))
except FileNotFoundError:
    pass
extra = sorted(f for f in os.listdir(codex) if f.startswith("sophia-")) if os.path.isdir(codex) else []
p("sophia-*：" + ("、".join(f"{f}({sha(os.path.join(codex, f))})" for f in extra) if extra else "没有"))

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
    if fam == "codexGateway":
        extra = f"；enabled={g.get('enabled')} port={g.get('port')} mode={g.get('mode', 'builtin')}"
    if fam == "claudeGateway":
        a = g.get("applied")
        extra = (f"；enabled={g.get('enabled')} takeover={g.get('takeover')} applied="
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

print("\n\033[1m==> Sophia 改写前备份（<数据目录>/backups/<名>-<哈希>/<序号>-<后缀>.bak；Claude 的是 -sophia-models，Codex 的是 -models）\033[0m")
broot = os.path.join(data, "backups")
rows = []
if os.path.isdir(broot):
    for d in sorted(os.listdir(broot)):
        dp = os.path.join(broot, d)
        try:
            src = open(os.path.join(dp, "source"), encoding="utf-8").read().strip()
        except Exception:
            continue
        if not (src.startswith(os.path.realpath(base)) or src.startswith(os.path.realpath(codex))):
            continue
        baks = sorted(f for f in os.listdir(dp) if f.endswith(".bak"))
        rows.append(f"{src} ← {len(baks)} 份，最新 {baks[-1] if baks else '（无）'}")
p("；\n    ".join(rows) if rows else "没有 Claude / Codex 文件的备份")
# 更早的版本把备份写在原文件旁边（<名>.sophia-models[.N].bak），现在不再写；有就是旧残留
old = []
for d in (os.path.join(base, "Claude"), os.path.join(base, "Claude-3p"), lib):
    if os.path.isdir(d):
        old += [os.path.join(os.path.basename(d), f) for f in os.listdir(d) if ".sophia-models" in f]
p("旧版写在原文件旁边的 .sophia-models*.bak（残留）：" + ("、".join(sorted(old)) if old else "没有"))

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
  step "密钥文件 $DATA_DIR/secrets.json（只列权限与有哪几项，不显示密钥与令牌）"
  secrets_summary | sed 's/^/    /'
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

# 基线里每一项「备份时在不在」都明确记在 presence.txt（<键><TAB>present|absent）；恢复只认这份记录：
# 记 present → 放回；记 absent → 现在多出来的挪开；没记 → 不动并中止（不把「备份里没有」当成「原来没有」）
presence_of() {
  awk -F '\t' -v k="$2" '$1 == k { print $2; found = 1 } END { if (!found) print "unknown" }' "$1/presence.txt" 2>/dev/null || echo unknown
}

# backup 用：记一条在不在
record() { printf '%s\t%s\n' "$1" "$2" >> "$BK_DEST/presence.txt" || die "写不了 $BK_DEST/presence.txt，备份不完整，没有写基线。"; }

# backup 用：有就复制并逐字节核对、记 present；没有就记 absent；存在却不是普通文件、读不了、复制失败 → 中止，不写基线
backup_file() {
  local src="$1" dst="$2" key="$3"
  if [ -f "$src" ]; then
    cp -p "$src" "$dst" || die "复制 $src 失败：备份不完整，没有写基线（$BK_DEST 留着，交给人看）。"
    cmp -s "$src" "$dst" || die "$dst 与原文件不一致：备份不完整，没有写基线。"
    record "$key" present
  elif [ -e "$src" ] || [ -L "$src" ]; then
    die "$src 存在但不是普通文件（或是坏软链）：不知道怎么备份，没有写基线。"
  else
    record "$key" absent
  fi
}

# backup 用：目录版
backup_dir() {
  local src="$1" dst="$2" key="$3"
  if [ -d "$src" ] && [ ! -L "$src" ]; then
    cp -Rp "$src" "$dst" || die "复制 $src 失败：备份不完整，没有写基线（$BK_DEST 留着，交给人看）。"
    diff -r "$src" "$dst" >/dev/null 2>&1 || die "$dst 与原目录不一致：备份不完整，没有写基线。"
    record "$key" present
  elif [ -e "$src" ] || [ -L "$src" ]; then
    die "$src 存在但不是普通目录：不知道怎么备份，没有写基线。"
  else
    record "$key" absent
  fi
}

cmd_backup() {
  require_sophia_quit
  local stamp dest
  stamp="$(date +%Y%m%d-%H%M%S)"
  dest="$LAB_STATE_DIR/sophia-backups/sophia-backup-$stamp"
  if lab_in_icloud "$LAB_STATE_DIR"; then die "$LAB_STATE_DIR 在 iCloud 同步目录里，不要把备份放这里。"; fi
  [ -e "$dest" ] && die "$dest 已存在，过一秒再试。"
  mkdir -p "$LAB_STATE_DIR/sophia-backups" && mkdir -m 700 "$dest" || die "建不了 $dest"
  BK_DEST="$dest"
  step "备份 Sophia 这一侧 → $dest"
  mkdir -p "$dest/codex" "$dest/sophia" "$dest/claude4" || die "建不了 $dest 下的子目录"
  : > "$dest/presence.txt" || die "写不了 $dest/presence.txt"
  local f name
  backup_file "$CODEX_DIR/config.toml" "$dest/codex/config.toml" codex/config.toml && info "~/.codex/config.toml：$(presence_of "$dest" codex/config.toml)"
  for f in "$CODEX_DIR"/sophia-*; do
    { [ -e "$f" ] || [ -L "$f" ]; } || continue
    name="$(basename "$f")"
    backup_file "$f" "$dest/codex/$name" "codex/$name" && info "~/.codex/$name"
  done
  # sophia-* 的清单是完整的：恢复时不在清单里的 sophia-* 才敢挪开
  record "codex/sophia-*" listed
  backup_file "$DATA_DIR/settings.json" "$dest/sophia/settings.json" sophia/settings.json
  info "settings.json：$(presence_of "$dest" sophia/settings.json)"
  # 含服务商密钥与 Claude 网关令牌：cp -p 保留 0600，备份目录本身 0700；不存在也明确记下
  backup_file "$DATA_DIR/secrets.json" "$dest/sophia/secrets.json" sophia/secrets.json
  if [ "$(presence_of "$dest" sophia/secrets.json)" = present ]; then
    chmod 600 "$dest/sophia/secrets.json" || die "收紧不了 $dest/sophia/secrets.json 的权限"
    info "secrets.json：present（$(stat -f '%Sp' "$DATA_DIR/secrets.json")，含密钥，不要外发）"
  else
    info "secrets.json：absent（备份时没有任何密钥与令牌）"
  fi
  backup_dir "$DATA_DIR/gateway" "$dest/sophia/gateway" sophia/gateway
  info "gateway/：$(presence_of "$dest" sophia/gateway)"
  # 改写前备份只记清单（不放回、不比字节）：Sophia 每次改写 Claude / Codex 文件都会往里加
  if [ -d "$DATA_DIR/backups" ]; then
    (cd "$DATA_DIR/backups" && find . -type f | sort) > "$dest/sophia/backups-list.txt" || die "列不出 $DATA_DIR/backups"
    info "backups/ 文件清单（$(wc -l < "$dest/sophia/backups-list.txt" | tr -d ' ') 个）"
  else
    : > "$dest/sophia/backups-list.txt" || die "写不了 backups-list.txt"
  fi
  [ -e "$LEGACY_PLIST" ] && warn "旧版 launchd 服务的 plist 还在（${LEGACY_PLIST}）：新版打开时会卸掉它，恢复时放不回来。先交给人。"
  [ -e "$DATA_DIR/bin" ] && warn "旧版程序副本 $DATA_DIR/bin 还在：新版打开时会删掉它，恢复时放不回来。先交给人。"
  local lib="$LAB_BASE/Claude-3p/configLibrary"
  backup_file "$LAB_BASE/Claude/claude_desktop_config.json" "$dest/claude4/config-1p.json" claude4/config-1p.json
  backup_file "$LAB_BASE/Claude-3p/claude_desktop_config.json" "$dest/claude4/config-3p.json" claude4/config-3p.json
  backup_file "$lib/_meta.json" "$dest/claude4/meta.json" claude4/meta.json
  if [ -d "$lib" ]; then
    ls -1 "$lib" > "$dest/claude4/configLibrary.txt" || die "列不出 $lib"
    record claude4/configLibrary present
  else
    : > "$dest/claude4/configLibrary.txt" || die "写不了 configLibrary.txt"
    record claude4/configLibrary absent
  fi
  [ -f "$lib/$SOPHIA_ID.json" ] && warn "备份时 configLibrary 里已经有 Sophia 的 profile（不是干净的基线？）"
  info "Claude 的三个文件与 configLibrary 清单"
  (cd "$dest" && find . -type f ! -name manifest.txt -exec shasum -a 256 {} + | sort -k2) > "$dest/manifest.txt" \
    || die "写不了 $dest/manifest.txt，没有写基线。"
  # 最后才标完整、写基线：前面任何一步中止，SOPHIA_BASELINE 都还指着上一份（或没有）
  date '+%Y-%m-%d %H:%M:%S' > "$dest/COMPLETE" || die "写不了 $dest/COMPLETE，没有写基线。"
  echo "$dest" > "$LAB_STATE_DIR/SOPHIA_BASELINE" || die "写不了 $LAB_STATE_DIR/SOPHIA_BASELINE"
  step "完成：${dest}（路径已写进 $LAB_STATE_DIR/SOPHIA_BASELINE）"
}

baseline_dir() {
  local d="${1:-}"
  [ -n "$d" ] || d="$(cat "$LAB_STATE_DIR/SOPHIA_BASELINE" 2>/dev/null || true)"
  [ -n "$d" ] && [ -d "$d" ] || die "找不到 Sophia 这一侧的备份（$LAB_STATE_DIR/SOPHIA_BASELINE）。"
  [ -f "$d/COMPLETE" ] && [ -f "$d/presence.txt" ] || die "$d 不是完整的备份（没有 COMPLETE / presence.txt：备份中途失败，或是旧格式）。不要拿它恢复，交给人。"
  printf '%s' "$d"
}

cmd_compare() {
  local bk
  bk="$(baseline_dir "${1:-}")" || exit 1
  step "现在 vs 备份 $bk"
  python3 - "$bk" "$CODEX_DIR" "$DATA_DIR" "$LAB_BASE" "$SOPHIA_ID" <<'PY'
import filecmp, glob, json, os, sys
bk, codex, data, base, sid = sys.argv[1:]
bad = 0
def p(s): print("    " + s)
def same(a, b):
    ea, eb = os.path.exists(a), os.path.exists(b)
    if not ea and not eb: return "两边都没有"
    if ea != eb: return "备份有、现在没有" if ea else "备份没有、现在有"
    return "字节相同" if filecmp.cmp(a, b, shallow=False) else "不同"
now_codex = {os.path.basename(f) for f in glob.glob(os.path.join(codex, "config.toml")) + glob.glob(os.path.join(codex, "sophia-*"))}
bak_codex = set(os.listdir(os.path.join(bk, "codex")))
for name in sorted(now_codex | bak_codex):
    r = same(os.path.join(bk, "codex", name), os.path.join(codex, name))
    bad += r != "字节相同"
    p(f"~/.codex/{name}：{r}")
try:
    a = json.load(open(os.path.join(bk, "sophia", "settings.json")))
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
# secrets.json：比字节；不同时只说哪几项变了（不显示值）
sa, sb = os.path.join(bk, "sophia", "secrets.json"), os.path.join(data, "secrets.json")
r = same(sa, sb)
bad += r not in ("字节相同", "两边都没有")
note = ""
def items(path):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    out = {f"{agent}/{k}": v for agent, keys in (d.get("providers") or {}).items() for k, v in (keys or {}).items()}
    if d.get("claudeRouterToken"):
        out["claudeRouterToken"] = d["claudeRouterToken"]
    return out
if r == "不同":
    ia, ib = items(sa), items(sb)
    if ia is None or ib is None:
        note = "（有一边读不了）"
    else:
        added = sorted(set(ib) - set(ia)); gone = sorted(set(ia) - set(ib))
        changed = sorted(k for k in set(ia) & set(ib) if ia[k] != ib[k])
        note = f"（多了 {added or '无'}；少了 {gone or '无'}；值变了 {changed or '无'}）"
if os.path.exists(sb):
    mode = oct(os.stat(sb).st_mode & 0o777)
    if mode != "0o600":
        bad += 1
        note += f"（！现在权限 {mode}，应为 0o600）"
p(f"Sophia/secrets.json：{r}{note}")
names = set()
for root in (os.path.join(bk, "sophia", "gateway"), os.path.join(data, "gateway")):
    if os.path.isdir(root):
        names |= {os.path.relpath(os.path.join(dp, f), root) for dp, _, fs in os.walk(root) for f in fs}
for n in sorted(names):
    r = same(os.path.join(bk, "sophia", "gateway", n), os.path.join(data, "gateway", n))
    bad += r != "字节相同"
    p(f"Sophia/gateway/{n}：{r}")
try:
    before = set(open(os.path.join(bk, "sophia", "backups-list.txt")).read().split())
except FileNotFoundError:
    before = set()
broot = os.path.join(data, "backups")
now = set()
if os.path.isdir(broot):
    now = {"./" + os.path.relpath(os.path.join(dp, f), broot) for dp, _, fs in os.walk(broot) for f in fs}
new = sorted(now - before)
p(f"Sophia/backups/ 新增（Sophia 改写前备份，只列出不计入，不会被 restore 动）：{len(new)} 个" + ("：" + "、".join(new[:8]) if new else ""))
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
    before = sorted(open(os.path.join(bk, "claude4", "configLibrary.txt")).read().split())
except FileNotFoundError:
    before = None
now = sorted(os.listdir(lib)) if os.path.isdir(lib) else []
if before is None:
    bad += 1
    p(f"configLibrary：备份里没有清单（不完整的备份），现在 {now}")
elif before != now:
    bad += 1
    p(f"configLibrary：不同（多了 {sorted(set(now) - set(before)) or '无'}；少了 {sorted(set(before) - set(now)) or '无'}）")
else:
    p(f"configLibrary：相同 {now}")
print(f"\n==> {'关键项都与备份一致' if bad == 0 else f'有 {bad} 处与备份不一致（见上）'}")
sys.exit(1 if bad else 0)
PY
  local rc=$?
  if [ -e "$LEGACY_PLIST" ] || launchctl print "gui/$(id -u)/$LEGACY_SERVICE_LABEL" >/dev/null 2>&1; then
    info "！旧版 launchd 路由服务（${LEGACY_SERVICE_LABEL}）现在还在"
  else
    info "旧版 launchd 路由服务：不在（正常）"
  fi
  return "$rc"
}

# 把现在的 <路径> 挪到 $LAB/aside/restore-<时间>/<分组>/<名字>（不删；不留在原目录里，免得又被 sophia-* 之类的名字匹配到）。
# 先在恢复日志里登记「打算把 X 挪到 Y」，再挪（见 lib.sh 的 journal_*）；挪去的路径放在 LAST_ASIDE
move_aside() {
  local cur="$1" group="$2" dir="$LAB_STATE_DIR/aside/restore-$STAMP/$2"
  local aside
  mkdir -p "$dir" && chmod 700 "$dir" || die "建不了 $dir"
  aside="$dir/$(basename "$cur")"
  { [ -e "$aside" ] || [ -L "$aside" ]; } && die "$aside 已存在，没挪。"
  journal_add move "$cur" "$aside"
  mv -n "$cur" "$aside" || die "没能把 $cur 挪到 ${aside}。"
  { [ -e "$cur" ] || [ -L "$cur" ]; } && die "$cur 还在原处，没挪开。"
  LAST_ASIDE="$aside"
  info "挪开：$cur → $aside"
}

R_DONE=0
R_ROLLED=0

restore_rollback() {
  trap '' INT TERM HUP   # 撤回本身不能再被打断
  R_ROLLED=1
  [ "$(journal_count)" -gt 0 ] || return 0
  step "撤回：按恢复日志倒序，这次恢复登记过的 $(journal_count) 步全部回到恢复前"
  journal_rollback
}

# restore 进行中的退出（die、意外错误、信号）都走这里：没完成就整体撤回
restore_on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$R_DONE" != 1 ] && [ "$R_ROLLED" != 1 ]; then
    if restore_rollback; then
      [ "$(journal_count)" -gt 0 ] && warn "恢复没做完，已全部撤回：Sophia 这一侧保持恢复前的样子。"
    else
      warn "恢复没做完，撤回也没做完（见上）：挪开的原件在 $LAB_STATE_DIR/aside/restore-$STAMP/，恢复日志 ${JOURNAL}，交给人。"
    fi
    [ "$rc" = 0 ] && rc=1
  fi
  exit "$rc"
}

# 计划里的一项要不要放回：备份记 present 且现在的与备份不同（类型不对也算不同）
differs() {
  local saved="$1" cur="$2" kind="$3"
  if [ "$kind" = dir ]; then
    ! { [ -d "$cur" ] && [ ! -L "$cur" ] && diff -r "$saved" "$cur" >/dev/null 2>&1; }
  else
    ! { [ -f "$cur" ] && [ ! -L "$cur" ] && cmp -s "$saved" "$cur"; }
  fi
}

cmd_restore() {
  local bk
  bk="$(baseline_dir "${1:-}")" || exit 1
  STAMP="$(date +%Y%m%d-%H%M%S)"
  step "把 Sophia 这一侧放回备份的样子：$bk"
  require_sophia_quit
  # 先查一遍：基线记 present 的每一项在备份里都在、读得了；没记的项一律不碰。都过了才开始动
  local key state
  for key in codex/config.toml "codex/sophia-*" sophia/settings.json sophia/secrets.json sophia/gateway; do
    state="$(presence_of "$bk" "$key")"
    case "$state" in present|absent|listed) ;; *) die "基线没有记 $key 在不在：旧格式或不完整的备份，什么也没动。" ;; esac
  done
  while IFS="$(printf '\t')" read -r key state; do
    case "$key" in claude4/*) continue ;; esac
    [ "$state" = present ] || continue
    # 目录要逐层列得出、逐个文件读得了（列不出的目录也算不行）：cp -Rp 中途才失败会留下半成品
    python3 -c 'import os, sys
p = sys.argv[1]
errs = []
ok = os.access(p, os.R_OK)
if ok and os.path.isdir(p):
    for dp, ds, fs in os.walk(p, onerror=errs.append):
        ok = ok and all(os.access(os.path.join(dp, d), os.R_OK | os.X_OK) for d in ds) \
                and all(os.access(os.path.join(dp, f), os.R_OK) for f in fs)
sys.exit(0 if ok and not errs else 1)' "$bk/$key" \
      || die "基线记着 $key 在，备份里的 $bk/$key 却不在或（其中有文件、目录）读不了：什么也没动，交给人。"
  done < "$bk/presence.txt"
  if sophia_is_real; then confirm_real "将按备份放回 ~/.codex 的几份文件、Sophia 的 settings.json、secrets.json、gateway/（现在的挪到一旁，不删）。"; fi

  # 定计划：要放回的（键、备份里的、原处、类型）与只要挪开的（备份时没有、现在有）
  local f name i
  local P_KEY=() P_SAVED=() P_CUR=() P_KIND=() P_ASIDE=() A_CUR=() A_GROUP=()
  plan_item() {   # <键> <备份里的> <原处> [dir]
    case "$(presence_of "$bk" "$1")" in
      present)
        if differs "$2" "$3" "${4:-file}"; then P_KEY+=("$1"); P_SAVED+=("$2"); P_CUR+=("$3"); P_KIND+=("${4:-file}"); fi ;;
      absent)
        if [ -e "$3" ] || [ -L "$3" ]; then A_CUR+=("$3"); A_GROUP+=("$(dirname "$1")"); fi ;;
      *) die "基线没有记 $1 在不在：什么也没动，交给人。" ;;
    esac
  }
  plan_item codex/config.toml "$bk/codex/config.toml" "$CODEX_DIR/config.toml"
  for f in "$CODEX_DIR"/sophia-*; do
    { [ -e "$f" ] || [ -L "$f" ]; } || continue
    name="$(basename "$f")"
    # 清单是完整的（listed）：备份时没有的 sophia-* 挪开
    if [ "$(presence_of "$bk" "codex/$name")" = present ]; then plan_item "codex/$name" "$bk/codex/$name" "$f"
    else A_CUR+=("$f"); A_GROUP+=(codex); fi
  done
  while IFS="$(printf '\t')" read -r key state; do
    case "$key" in codex/sophia-\*|codex/config.toml) continue ;; codex/sophia-*) ;; *) continue ;; esac
    [ "$state" = present ] || continue
    name="${key#codex/}"
    { [ -e "$CODEX_DIR/$name" ] || [ -L "$CODEX_DIR/$name" ]; } || plan_item "$key" "$bk/codex/$name" "$CODEX_DIR/$name"
  done < "$bk/presence.txt"
  plan_item sophia/settings.json "$bk/sophia/settings.json" "$DATA_DIR/settings.json"
  plan_item sophia/secrets.json "$bk/sophia/secrets.json" "$DATA_DIR/secrets.json"
  plan_item sophia/gateway "$bk/sophia/gateway" "$DATA_DIR/gateway" dir

  # 从这里起改动现场：每一步先登记进恢复日志再动手；任何退出（失败、Ctrl+C、SIGTERM、挂断）都按日志整体撤回
  journal_open "$LAB_STATE_DIR/aside/restore-$STAMP/journal.tsv"
  trap restore_on_exit EXIT
  trap 'warn "收到 SIGINT，中断"; exit 130' INT
  trap 'warn "收到 SIGTERM，中断"; exit 143' TERM
  trap 'warn "收到 SIGHUP，中断"; exit 129' HUP
  # 1. 先把要换掉的与要挪开的全部挪到 aside
  for ((i = 0; i < ${#P_CUR[@]}; i++)); do
    P_ASIDE[$i]=""
    if [ -e "${P_CUR[$i]}" ] || [ -L "${P_CUR[$i]}" ]; then move_aside "${P_CUR[$i]}" "$(dirname "${P_KEY[$i]}")"; P_ASIDE[$i]="$LAST_ASIDE"; fi
  done
  for ((i = 0; i < ${#A_CUR[@]}; i++)); do move_aside "${A_CUR[$i]}" "${A_GROUP[$i]}"; done
  # 2. 再逐项放回并核对；任何一项失败 → 退出时整体撤回
  for ((i = 0; i < ${#P_CUR[@]}; i++)); do
    journal_add copy "${P_CUR[$i]}" "${P_ASIDE[$i]}"
    if [ "${P_KIND[$i]}" = dir ]; then
      cp -Rp "${P_SAVED[$i]}" "${P_CUR[$i]}" || die "放回 ${P_CUR[$i]} 失败"
      diff -r "${P_SAVED[$i]}" "${P_CUR[$i]}" >/dev/null 2>&1 || die "放回后 ${P_CUR[$i]} 与备份不同"
    else
      cp -p "${P_SAVED[$i]}" "${P_CUR[$i]}" || die "放回 ${P_CUR[$i]} 失败"
      cmp -s "${P_SAVED[$i]}" "${P_CUR[$i]}" || die "放回后 ${P_CUR[$i]} 与备份不同"
    fi
    info "放回 ${P_CUR[$i]}"
  done
  # 3. 不管内容是否相同，都把权限校正到 0600（含密钥）
  if [ "$(presence_of "$bk" sophia/secrets.json)" = present ]; then
    chmod 600 "$DATA_DIR/secrets.json" || die "改不了 $DATA_DIR/secrets.json 的权限"
    [ "$(stat -f '%Lp' "$DATA_DIR/secrets.json")" = 600 ] || die "$DATA_DIR/secrets.json 的权限不是 0600"
    info "secrets.json 权限 0600"
  fi
  R_DONE=1
  trap - INT TERM HUP EXIT
  step "完成（放回 ${#P_CUR[@]} 项）。Claude 的文件、Sophia/backups/ 没有动；用 compare 再核对一遍。挪开的东西在 $LAB_STATE_DIR/aside/restore-$STAMP/（secrets.json 含密钥），交给人决定删不删。"
}

# 这个文件最新的一份改写前备份：<数据目录>/backups/ 下 source 指向它的目录里序号最大的 *.bak
cmd_bak_of() {
  [ $# -eq 1 ] || die "bak-of 要一个文件"
  python3 - "$DATA_DIR/backups" "$1" <<'PY'
import os, sys
root, target = sys.argv[1:]
want = os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(target))), os.path.basename(target))
best = None
if os.path.isdir(root):
    for d in os.listdir(root):
        dp = os.path.join(root, d)
        try:
            src = open(os.path.join(dp, "source"), encoding="utf-8").read().strip()
        except Exception:
            continue
        if src != want:
            continue
        for f in os.listdir(dp):
            stem = f[:-4] if f.endswith(".bak") else None
            if stem and "-" in stem and stem.split("-", 1)[0].isdigit():
                seq = int(stem.split("-", 1)[0])
                if best is None or seq > best[0]:
                    best = (seq, os.path.join(dp, f))
if best is None:
    sys.exit(f"[中止] {root} 里没有 {want} 的备份")
print(best[1])
PY
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
# 没有清单不能当成「备份时是空的」，否则会把现在 configLibrary 里的全部 profile 挪走
if not os.path.exists(os.path.join(bk, "configLibrary.txt")):
    sys.exit("[中止] 备份里没有 configLibrary 清单（不完整的备份），什么也没动")
before = open(os.path.join(bk, "configLibrary.txt")).read().split()
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
  [ -f "$prof" ] || die "Sophia 的 profile 不存在：${prof}（Claude 没打开时查不了）"
  python3 - "$prof" "$DATA_DIR" "$LAB_STATE_DIR" "$@" <<'PY'
import json, os, sys
prof, data, lab, *extra = sys.argv[1:]
tok = json.load(open(prof, encoding="utf-8-sig")).get("inferenceGatewayApiKey")
if not isinstance(tok, str) or len(tok) < 20:
    sys.exit("[中止] profile 里没有像样的令牌")
needle = tok.encode()
# 令牌该在的地方：Sophia 的 profile 与 <数据目录>/secrets.json 的 claudeRouterToken（crates/core/src/keystore.rs；spec R5 原写钥匙串，现已改存密钥文件）
problems = 0
try:
    stored = json.load(open(os.path.join(data, "secrets.json"))).get("claudeRouterToken")
    print("    secrets.json 的 claudeRouterToken：" + ("与 profile 里的相同" if stored == tok else "没有！" if not stored else "与 profile 里的不同！"))
    problems += stored != tok
except FileNotFoundError:
    problems += 1
    print("    secrets.json：不存在！（令牌应当存在这里）")
except Exception as e:
    problems += 1
    print(f"    secrets.json 读不了！（{type(e).__name__}）")
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
# Sophia 改写前备份：profile 被改写 / 删掉前的原文会进这里，里面带令牌不算泄露到日志，但单列出来交给人判断
broot = os.path.join(data, "backups")
bk_hits = [f for f in files(broot) if needle in open(f, "rb").read()] if os.path.isdir(broot) else []
print(f"    {broot}（改写前备份，单列不计入）：{'搜到 ' + str(len(bk_hits)) + ' 个：' + '、'.join(bk_hits[:3]) if bk_hits else '没搜到'}")
if hit == 0 and problems == 0:
    print("\n==> 令牌只在该在的地方（profile、secrets.json）")
else:
    why = ([f"有 {hit} 个文件里出现了令牌"] if hit else []) + (["secrets.json 里的令牌缺失、读不了或与 profile 不一致"] if problems else [])
    print(f"\n==> {'；'.join(why)}（见上），按中止处理")
sys.exit(1 if hit or problems else 0)
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
  bak-of) cmd_bak_of "$@" ;;
  claude-reset) cmd_claude_reset "$@" ;;
  dm-only) cmd_dm_only "$@" ;;
  profile-set) cmd_profile_set "$@" ;;
  token-check) cmd_token_check "$@" ;;
  sim-phase) cmd_sim_phase "$@" ;;
  -h|--help|"") awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; [ -n "$CMD" ] || exit 2 ;;
  *) die "不认识的子命令：${CMD}（--help 看用法）" ;;
esac

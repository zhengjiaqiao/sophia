#!/usr/bin/env bash
# 只读打印 Claude 桌面应用与第三方模式相关的当前状态，不改任何文件，不输出任何密钥值。
#
# 用法：scripts/desktop-3p-lab/inspect.sh [--log-lines N]
#   --log-lines N   从 ~/Library/Logs/Claude-3p/main.log 与 Claude/main.log 各摘最后 N 行相关日志（默认 15，0 为不摘）
#
# 打印内容：
#   - 桌面应用版本、是否在运行、正在用哪个数据目录（Helper 进程的 --user-data-dir）
#   - 两份 claude_desktop_config.json 的 deploymentMode，以及 enterpriseConfig 的键名
#   - configLibrary/_meta.json 的 appliedId 与 entries；每份 profile 的键（只显示白名单里的非敏感值）
#   - 受管偏好是否存在（只列键名）；~/Library/Preferences 里用户偏好的键名
#   - 本实验的 lab-state.json（原 appliedId 等）
# 密钥类的值一律不显示；实验假令牌只说「是不是它」。日志摘录里像令牌的长串会被打码。
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

LOG_LINES=15
while [ $# -gt 0 ]; do
  case "$1" in
    --log-lines) LOG_LINES="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "不认识的参数：$1" ;;
  esac
done

step "路径"
lab_print_paths

step "桌面应用"
info "安装位置：$LAB_APP"
info "版本：$(defaults read "$LAB_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo 读不到)"
PROCS="$(lab_running_processes)"
if [ -n "$PROCS" ]; then
  info "正在运行："
  printf '%s\n' "$PROCS" | sed 's/^/      /' | head -8
  # 从 Helper 进程的命令行里取 --user-data-dir（社区报告：指向 Claude-3p 即第三方模式）
  UDD="$(lab_user_data_dirs)"
  info "数据目录（--user-data-dir）：${UDD:-没取到}"
else
  info "没有在运行。"
fi

step "配置文件"
python3 - "$LAB_DIR_1P" "$LAB_DIR_3P" "$LAB_SCRIPT_DIR/models.json" "$LAB_STATE_DIR/lab-state.json" <<'PY'
import hashlib, json, os, sys

dir1p, dir3p, models_path, state_path = sys.argv[1:]
lab = json.load(open(models_path))

# 这些键的值可以显示；其余键只显示类型与长度
SAFE = {
    "deploymentMode", "appliedId", "inferenceProvider", "inferenceGatewayBaseUrl", "inferenceGatewayAuthScheme",
    "chatTabEnabled", "modelCatalogEnabled", "modelDiscoveryEnabled", "disableDeploymentModeChooser",
    "coworkEgressAllowedHosts", "isLocalDevMcpEnabled", "toolSearchEnabled", "defaultModelEffort",
    "inferenceStreamIdleTimeoutSec", "disableAutoUpdates", "skipWebFetchPreflight",
}
MODEL_SAFE = ("name", "labelOverride", "anthropicFamilyTier", "isFamilyDefault", "supports1m", "prefer1m", "maxEffort")

def p(s=""):
    print("    " + s)

def load(path):
    try:
        raw = open(path, "rb").read()
    except FileNotFoundError:
        return "（文件不存在）"
    except Exception as e:
        return f"（读不了：{type(e).__name__}）"
    try:
        return json.loads(raw.decode("utf-8-sig") or "null")
    except Exception as e:
        return f"（不是合法 JSON：{e}）"

def hidden(v):
    if isinstance(v, str):
        tag = "，是实验假令牌" if v == lab["labToken"] else ("，是模拟别家的假令牌" if v == (lab.get("foreign") or {}).get("token") else "")
        return f"<字符串，长 {len(v)}，未显示{tag}>"
    return f"<{type(v).__name__}，未显示>"

def show_value(k, v):
    if k == "inferenceModels" and isinstance(v, list):
        p(f"  {k}: {len(v)} 项")
        for m in v:
            if isinstance(m, dict):
                p("    - " + ", ".join(f"{f}={m[f]!r}" for f in MODEL_SAFE if f in m))
            else:
                p(f"    - {m!r}")
    elif k in SAFE:
        p(f"  {k}: {v!r}")
    else:
        p(f"  {k}: {hidden(v)}")

for label, d in (("Claude", dir1p), ("Claude-3p", dir3p)):
    path = os.path.join(d, "claude_desktop_config.json")
    obj = load(path)
    p(f"[{label}/claude_desktop_config.json]")
    if isinstance(obj, dict):
        p(f"  deploymentMode: {obj.get('deploymentMode', '（缺失）')!r}")
        ec = obj.get("enterpriseConfig")
        if isinstance(ec, dict):
            p(f"  enterpriseConfig 的键：{sorted(ec.keys()) or '（空）'}")
        p(f"  顶层键：{sorted(obj.keys())}")
    else:
        p(f"  {obj}")

lib = os.path.join(dir3p, "configLibrary")
meta = load(os.path.join(lib, "_meta.json"))
p("[Claude-3p/configLibrary/_meta.json]")
applied = None
if isinstance(meta, dict):
    applied = meta.get("appliedId")
    who = {lab["profileId"]: "（本实验的 profile）", (lab.get("foreign") or {}).get("profileId"): "（模拟别家的 profile）"}.get(applied, "")
    p(f"  appliedId: {applied!r}{who}")
    if applied and not os.path.exists(os.path.join(lib, str(applied) + ".json")):
        p(f"  ！appliedId 指向的 {applied}.json 不存在")
    for e in meta.get("entries", []) or []:
        if isinstance(e, dict):
            p(f"  entry: id={e.get('id')!r} name={e.get('name')!r}")
    other = sorted(set(meta) - {"appliedId", "entries"})
    if other:
        p(f"  其他键：{other}")
else:
    p(f"  {meta}")

if os.path.isdir(lib):
    for fn in sorted(os.listdir(lib)):
        if fn == "_meta.json" or not fn.endswith(".json"):
            continue
        obj = load(os.path.join(lib, fn))
        try:
            digest = hashlib.sha256(open(os.path.join(lib, fn), "rb").read()).hexdigest()[:12]
        except Exception:
            digest = "读不了"
        mark = []
        if fn[:-5] == applied:
            mark.append("生效中")
        if fn[:-5] == lab["profileId"]:
            mark.append("本实验写的")
        if fn[:-5] == (lab.get("foreign") or {}).get("profileId"):
            mark.append("模拟别家的")
        p(f"[configLibrary/{fn}]" + (f"（{'，'.join(mark)}）" if mark else "") + f" sha256:{digest}")
        if isinstance(obj, dict):
            # 官方导出的 v2 嵌套格式（$schemaVersion: 2）只列顶层键名
            for k in sorted(obj):
                show_value(k, obj[k]) if not isinstance(obj[k], dict) else p(f"  {k}: <对象，键 {sorted(obj[k].keys())}>")
        else:
            p(f"  {obj}")
else:
    p("[configLibrary] 目录不存在")

st = load(state_path)
p(f"[本实验状态 {state_path}]")
if isinstance(st, dict):
    o = st.get("original", {})
    p(f"  原 appliedId: {o.get('appliedId')!r}；原 entries: {o.get('entries')}；原 deploymentMode: {o.get('deploymentMode')}")
    for w in st.get("writes", [])[-5:]:
        p(f"  写入记录：{w}")
else:
    p(f"  {st}")
PY

step "受管偏好与用户偏好（只列键名）"
for f in "$LAB_MANAGED_DIR/$LAB_BUNDLE_ID.plist" "$LAB_MANAGED_DIR/$(id -un)/$LAB_BUNDLE_ID.plist" "$HOME/Library/Preferences/$LAB_BUNDLE_ID.plist"; do
  if [ -e "$f" ]; then
    info "存在：$f"
    python3 -c 'import plistlib,sys
try: print("      键：", sorted(plistlib.load(open(sys.argv[1], "rb")).keys()))
except Exception as e: print("      （读不了键名：%s）" % type(e).__name__)' "$f"
  else
    info "不存在：$f"
  fi
done

if [ "$LOG_LINES" != 0 ]; then
  step "相关日志摘录（每个文件最后 $LOG_LINES 行，长串已打码）"
  for f in "$LAB_LOG_BASE/Claude-3p/main.log" "$LAB_LOG_BASE/Claude/main.log"; do
    if [ -f "$f" ]; then
      info "${f}（最后修改 $(stat -f '%Sm' "$f")）"
      grep -E '\[custom-3p\]|deploymentMode|deployment mode|inferenceModels|ConfigHealth|configLibrary|Model discovery|3P mode|third.party|validat' "$f" 2>/dev/null \
        | tail -n "$LOG_LINES" \
        | sed -E 's/(Bearer|bearer) [^ ",]+/\1 <打码>/g; s/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1<打码>/g; s/[A-Za-z0-9_+\/=-]{40,}/<长串打码>/g' \
        | cut -c1-300 | sed 's/^/      /'
    else
      info "没有 $f"
    fi
  done
fi

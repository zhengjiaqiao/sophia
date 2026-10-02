#!/usr/bin/env bash
# 往 Claude-3p/configLibrary/ 写一份「官方形状」的第三方推理配置，指向本机抓包服务。
#
# 用法：scripts/desktop-3p-lab/write-profile.sh [选项]
#   --shape A|M|B        inferenceModels 用哪种形状（默认 A），定义见同目录 models.json：
#                          A  非 Claude 名字 + labelOverride + anthropicFamilyTier（官方形状）
#                          M  诊断用混合：中性名、带别家名字的名、合法 claude-* 名各一个
#                          B  配置切换工具形状：claude-sonnet-5 等角色 id，真名只放 labelOverride
#   --port N             抓包服务端口（默认 18765）
#   --prefix /路径        网关地址加路径前缀，如 /claude-desktop（默认不加，即根地址）
#   --chat-tab on|off|omit
#                        chatTabEnabled 写 true / 写 false / 不写这个键（默认 on）
#   --profile sophia|foreign
#                        写哪一份 profile（默认 sophia＝本实验的）。foreign＝模拟别家（配置切换工具形状，
#                        固定 id、自己的令牌、地址带 /ccs-sim 前缀，见 models.json 的 foreign），不写 chatTabEnabled。
#                        写哪份就把 appliedId 指向哪份；_meta.json 里别的条目原样保留。
#   --corrupt            把这份 profile 写成坏的 JSON（截掉后半），appliedId 照样指向它（异常用例）
#   --only-applied sophia|foreign|missing|none
#                        只改 _meta.json 的 appliedId，不写 profile、不动 entries：
#                        指向本实验的 / 模拟别家的 / 一个不存在的 id（models.json 的 missingProfileId）/ 删掉这个键
#   --deployment-mode 3p|1p|remove
#                        另外改 claude_desktop_config.json 的 deploymentMode（默认不碰）。
#                        按网关工具的顺序最后写：profile → _meta.json → deploymentMode。
#   --dm-scope both|3p-only|1p-only
#                        deploymentMode 写哪几份（默认 both：Claude/ 与 Claude-3p/ 各一份）
#   --only-deployment-mode
#                        只改 deploymentMode，不写 profile 与 _meta.json
#   --no-backup-check    不检查是否做过备份（不建议）
#
# 只写三类文件：本实验自己的（或模拟别家的）profile（固定 id，见 models.json）、_meta.json、（可选）两份 claude_desktop_config.json。
# 不写 disableDeploymentModeChooser（写了就没法在应用里自己切回）。
# 第一次运行时把原来的 appliedId、entries、deploymentMode 记到 ~/claude-desktop-lab/lab-state.json。
# 每个文件都是「写临时文件 → 原子改名」，保留原文件权限。可重复运行，结果相同。
# 改 claude_desktop_config.json 时键和值原样保留，但排版会变成 2 空格缩进（实验用，有完整备份兜底）。
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

SHAPE=A PORT=18765 PREFIX="" CHAT=on DM="" DM_SCOPE=both ONLY_DM=0 BACKUP_CHECK=1 PROFILE=sophia CORRUPT=0 ONLY_APPLIED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --shape) SHAPE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --chat-tab) CHAT="$2"; shift 2 ;;
    --deployment-mode) DM="$2"; shift 2 ;;
    --dm-scope) DM_SCOPE="$2"; shift 2 ;;
    --only-deployment-mode) ONLY_DM=1; shift ;;
    --no-backup-check) BACKUP_CHECK=0; shift ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --corrupt) CORRUPT=1; shift ;;
    --only-applied) ONLY_APPLIED="$2"; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) die "不认识的参数：$1（--help 看用法）" ;;
  esac
done
case "$SHAPE" in A|M|B) ;; *) die "--shape 只能是 A、M、B" ;; esac
case "$CHAT" in on|off|omit) ;; *) die "--chat-tab 只能是 on、off、omit" ;; esac
case "$PROFILE" in sophia|foreign) ;; *) die "--profile 只能是 sophia 或 foreign" ;; esac
case "$ONLY_APPLIED" in ""|sophia|foreign|missing|none) ;; *) die "--only-applied 只能是 sophia、foreign、missing、none" ;; esac
[ -n "$ONLY_APPLIED" ] && { [ "$ONLY_DM" = 1 ] || [ -n "$DM" ] || [ "$CORRUPT" = 1 ]; } \
  && die "--only-applied 只改 appliedId，不能和 --deployment-mode / --only-deployment-mode / --corrupt 一起用"
case "$DM" in ""|3p|1p|remove) ;; *) die "--deployment-mode 只能是 3p、1p、remove" ;; esac
case "$DM_SCOPE" in both|3p-only|1p-only) ;; *) die "--dm-scope 只能是 both、3p-only、1p-only" ;; esac
case "$PORT" in *[!0-9]*|"") die "--port 要是数字" ;; esac
if [ -n "$PREFIX" ]; then case "$PREFIX" in /*) ;; *) die "--prefix 要以 / 开头" ;; esac; fi
[ "$ONLY_DM" = 1 ] && [ -z "$DM" ] && die "--only-deployment-mode 要和 --deployment-mode 一起用"

step "将要写入"
lab_print_paths
if [ -n "$ONLY_APPLIED" ]; then
  info "只改 _meta.json 的 appliedId → $ONLY_APPLIED"
elif [ "$ONLY_DM" = 1 ]; then
  info "只改 deploymentMode → ${DM}（范围：${DM_SCOPE}）"
elif [ "$PROFILE" = foreign ]; then
  info "profile：模拟别家（配置切换工具形状），网关 http://127.0.0.1:$PORT${PREFIX:-/ccs-sim}$([ "$CORRUPT" = 1 ] && echo '，写成坏 JSON')"
  if [ -n "$DM" ]; then info "最后再改 deploymentMode → ${DM}（范围：${DM_SCOPE}）"; else info "不碰 deploymentMode"; fi
else
  info "profile：形状 ${SHAPE}，网关 http://127.0.0.1:$PORT${PREFIX}，chatTabEnabled=$CHAT$([ "$CORRUPT" = 1 ] && echo '，写成坏 JSON')"
  if [ -n "$DM" ]; then info "最后再改 deploymentMode → ${DM}（范围：${DM_SCOPE}）"; else info "不碰 deploymentMode"; fi
fi

require_desktop_quit

if [ "$BACKUP_CHECK" = 1 ] && lab_is_real_base; then
  step "检查是否做过备份"
  [ -s "$LAB_BACKUP_ROOT/LATEST" ] && [ -d "$(cat "$LAB_BACKUP_ROOT/LATEST")" ] \
    || die "没找到 backup.sh 做的备份（$LAB_BACKUP_ROOT/LATEST）。先跑 backup.sh。"
  info "最近一次备份：$(cat "$LAB_BACKUP_ROOT/LATEST")"
fi

for d in "$LAB_MANAGED_DIR/$LAB_BUNDLE_ID.plist" "$LAB_MANAGED_DIR/$(id -un)/$LAB_BUNDLE_ID.plist"; do
  [ -e "$d" ] && warn "发现受管偏好 ${d}：本机被组织管理时 configLibrary 会被忽略，本实验结果不可信。"
done

mkdir -p "$LAB_STATE_DIR"
python3 - "$LAB_SCRIPT_DIR/models.json" "$LAB_DIR_1P" "$LAB_DIR_3P" "$LAB_STATE_DIR/lab-state.json" \
  "$SHAPE" "$PORT" "$PREFIX" "$CHAT" "$DM" "$DM_SCOPE" "$ONLY_DM" "$PROFILE" "$CORRUPT" "$ONLY_APPLIED" <<'PY'
import json, os, sys, tempfile, time

(models_path, dir1p, dir3p, state_path, shape, port, prefix, chat, dm, dm_scope, only_dm,
 which, corrupt, only_applied) = sys.argv[1:]
lab = json.load(open(models_path))
lib = os.path.join(dir3p, "configLibrary")
meta_path = os.path.join(lib, "_meta.json")
pid = lab["profileId"]
profile_path = os.path.join(lib, pid + ".json")
foreign = lab["foreign"]
cfg_paths = {"Claude": os.path.join(dir1p, "claude_desktop_config.json"),
             "Claude-3p": os.path.join(dir3p, "claude_desktop_config.json")}

def say(msg):
    print("    " + msg, flush=True)

def load(path, default):
    """读 JSON 对象；文件不存在或为空返回 default；不是 JSON 对象就中止，一个字都不写。"""
    if not os.path.exists(path):
        return default
    raw = open(path, "rb").read()
    if not raw.strip():
        return default
    obj = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(obj, dict):
        sys.exit(f"[中止] {path} 不是 JSON 对象，没有写任何文件。")
    return obj

def write(path, obj, new_mode=0o600, broken=False):
    """写临时文件 → fsync → 原子改名；已有文件保留原权限。broken=True 时故意只写前一半（坏 JSON）。"""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    mode = (os.stat(path).st_mode & 0o777) if os.path.exists(path) else new_mode
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".lab-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
            f.write(text[: len(text) // 2] if broken else text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

# 先把要读的都读好（任一解析失败就什么都不写）
meta = load(meta_path, None)
cfgs = {k: load(p, None) for k, p in cfg_paths.items()}

# 第一次运行时记下原状，供回填与人工还原参考（restore.sh 用的是完整备份，不依赖它）
state = load(state_path, {})
if "original" not in state:
    state["original"] = {
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "metaExisted": meta is not None,
        "appliedId": (meta or {}).get("appliedId"),
        "entries": [{"id": e.get("id"), "name": e.get("name")} for e in (meta or {}).get("entries", []) if isinstance(e, dict)],
        "profileExisted": os.path.exists(profile_path),
        "deploymentMode": {k: (v.get("deploymentMode", "（缺失）") if v is not None else "（文件不存在）") for k, v in cfgs.items()},
    }
    say(f"已记下原状 → {state_path}：appliedId={state['original']['appliedId']!r}，deploymentMode={state['original']['deploymentMode']}")

if only_applied:
    target = {"sophia": pid, "foreign": foreign["profileId"], "missing": lab["missingProfileId"], "none": None}[only_applied]
    print(f"\n==> 只改 {meta_path} 的 appliedId → {target or '（删掉这个键）'}", flush=True)
    meta = meta if meta is not None else {}
    before = meta.get("appliedId", "（缺失）")
    if target is None:
        meta.pop("appliedId", None)
    else:
        meta["appliedId"] = target
    write(meta_path, meta, 0o644)
    exists = target is not None and os.path.exists(os.path.join(lib, target + ".json"))
    tail = "" if target is None else f"；指向的 profile 文件{'存在' if exists else '不存在'}"
    say(f"{before} → {meta.get('appliedId', '（缺失）')}{tail}；entries 原样")
elif only_dm != "1":
    if which == "foreign":
        wid, wname = foreign["profileId"], foreign["profileName"]
        wpath = os.path.join(lib, wid + ".json")
        profile = {
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": f"http://127.0.0.1:{port}{prefix or foreign['prefix']}",
            "inferenceGatewayApiKey": foreign["token"],
            "inferenceGatewayAuthScheme": "bearer",
            "inferenceModels": foreign["inferenceModels"],
        }
    else:
        wid, wname, wpath = pid, lab["profileName"], profile_path
        profile = {
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": f"http://127.0.0.1:{port}{prefix}",
            "inferenceGatewayApiKey": lab["labToken"],
            "inferenceGatewayAuthScheme": "bearer",
            "inferenceModels": lab["shapes"][shape]["inferenceModels"],
        }
        if chat != "omit":
            profile["chatTabEnabled"] = chat == "on"
    broken = corrupt == "1"
    print(f"\n==> 写 profile {wpath}{'（故意写成坏 JSON：只写前一半）' if broken else ''}", flush=True)
    write(wpath, profile, broken=broken)
    shown = dict(profile, inferenceGatewayApiKey="<实验假令牌，见 models.json>")
    for line in json.dumps(shown, ensure_ascii=False, indent=2).splitlines():
        say(line)

    print(f"\n==> 写 {meta_path}（登记这份条目并设为生效，别的条目原样保留）", flush=True)
    meta = meta if meta is not None else {}
    entries = meta.get("entries")
    if not isinstance(entries, list):
        entries = []
    for e in entries:
        if isinstance(e, dict) and e.get("id") == wid:
            e["name"] = wname
            break
    else:
        entries.append({"id": wid, "name": wname})
    meta["entries"] = entries
    meta["appliedId"] = wid
    write(meta_path, meta, 0o644)
    say(f"appliedId = {wid}；entries = {[e.get('name') for e in entries if isinstance(e, dict)]}")

if dm:
    scope = {"both": ["Claude", "Claude-3p"], "3p-only": ["Claude-3p"], "1p-only": ["Claude"]}[dm_scope]
    for k in scope:
        p = cfg_paths[k]
        print(f"\n==> 改 {p} 的 deploymentMode → {dm}", flush=True)
        obj = cfgs[k] if cfgs[k] is not None else {}
        before = obj.get("deploymentMode", "（缺失）")
        if dm == "remove":
            obj.pop("deploymentMode", None)
        else:
            obj["deploymentMode"] = dm
        write(p, obj, 0o644)
        say(f"{before} → {obj.get('deploymentMode', '（缺失）')}（其余键原样保留）")

wrote_profile = only_dm != "1" and not only_applied
state.setdefault("writes", []).append({
    "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    "profile": which if wrote_profile else None, "corrupt": corrupt == "1" if wrote_profile else None,
    "shape": shape if wrote_profile and which == "sophia" else None,
    "baseUrl": profile["inferenceGatewayBaseUrl"] if wrote_profile else None,
    "chatTab": chat if wrote_profile and which == "sophia" else None,
    "onlyApplied": only_applied or None,
    "deploymentMode": dm or None, "dmScope": dm_scope if dm else None,
})
write(state_path, state, 0o600)
PY

step "写完。下一步"
info "确认抓包服务在跑（capture_server.py --port ${PORT}），再打开 Claude。"
info "随时可以用 inspect.sh 看当前状态；全部做完用 restore.sh 回到原样。"

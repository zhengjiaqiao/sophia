#!/usr/bin/env python3
"""合并 cc-switch（Codex / Claude 预设）与 magpie 的服务商预设，输出 JSON 到 stdout。

用法：merge-provider-presets.py codexPresets.ts claudePresets.ts magpiePresets.go

cc-switch 为准，magpie 只补缺失字段与缺失的服务商。
不执行 TS/Go，只做带字符串/注释感知的括号匹配与正则抽取。
统计与跳过明细写到 stderr。
"""
import json
import re
import sys
from urllib.parse import urlsplit

NOTICE = (
    "服务商预设合并自 farion1231/cc-switch (MIT) 与 yetone/magpie (MIT)，见仓库 NOTICE。"
    "cc-switch 为准，magpie 只补 cc-switch 没有的。合并日期 2026-10-05。"
)

# ---------- 文本扫描 ----------


def mask(text):
    """把字符串、注释、模板字面量的内容替换成 'x'（长度不变），便于做括号与深度计算。"""
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and text[i : i + 2] == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        elif c == "/" and text[i : i + 2] == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if text[k] != "\n":
                    out[k] = " "
            i = j
        elif c in "\"'`":
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == "\\" and c != "`" or (text[j] == "\\" and c == "`"):
                    j += 1
                j += 1
            for k in range(i + 1, min(j, n)):
                if text[k] != "\n":
                    out[k] = "x"
            i = j + 1
        else:
            i += 1
    return "".join(out)


def depths(masked):
    """每个位置的括号深度（进入该字符前）。"""
    d, cur = [], 0
    for ch in masked:
        if ch in "{[(":
            d.append(cur)
            cur += 1
        elif ch in "}])":
            cur -= 1
            d.append(cur)
        else:
            d.append(cur)
    return d


def match_close(masked, start):
    """start 处是开括号，返回配对闭括号的下标。"""
    cur = 0
    for i in range(start, len(masked)):
        if masked[i] in "{[(":
            cur += 1
        elif masked[i] in "}])":
            cur -= 1
            if cur == 0:
                return i
    raise ValueError("括号不配对")


def split_entries(text, masked, open_idx):
    """open_idx 指向数组开括号；返回其中每个顶层 {...} 的 (起, 止) 区间。"""
    close = match_close(masked, open_idx)
    res, i = [], open_idx + 1
    while i < close:
        if masked[i] == "{":
            j = match_close(masked, i)
            res.append((i, j + 1))
            i = j + 1
        else:
            i += 1
    return res


def unquote(raw):
    """读取以引号开头的字符串字面量，返回 (值, 结束位置)。"""
    q = raw[0]
    j = 1
    buf = []
    while j < len(raw) and raw[j] != q:
        if raw[j] == "\\" and j + 1 < len(raw):
            nxt = raw[j + 1]
            buf.append({"n": "\n", "t": "\t"}.get(nxt, nxt))
            j += 2
        else:
            buf.append(raw[j])
            j += 1
    return "".join(buf), j + 1


def top_fields(text, masked, dep, lo, hi, key_re=r"(?<![\w.])([A-Za-z_]\w*)\s*:"):
    """区间内深度为 1 的 key: 位置 -> {key: 值起点}。"""
    res = {}
    for m in re.finditer(key_re, masked[lo:hi]):
        pos = lo + m.start(1)
        if dep[pos] == dep[lo] + 1 and m.group(1) not in res:
            res[m.group(1)] = lo + m.end()
    return res


def read_value(text, pos):
    """从 pos 起跳过空白，读一个字符串字面量/布尔值；其余返回 None。"""
    while pos < len(text) and text[pos] in " \t\r\n":
        pos += 1
    if pos >= len(text):
        return None
    if text[pos] in "\"'":
        return unquote(text[pos:])[0]
    m = re.match(r"(true|false)\b", text[pos:])
    if m:
        return m.group(1) == "true"
    return None


# ---------- 通用小工具 ----------


def host_of(url):
    if not url:
        return ""
    u = urlsplit(url if "://" in url else "https://" + url)
    h = (u.hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def strip_query(url):
    """去掉 cc-switch 链接里的推广/追踪参数（aff、utm、track_id 等），整串查询丢弃。"""
    if not url:
        return ""
    u = urlsplit(url)
    return u._replace(query="").geturl()


def clean_url(url):
    url = (url or "").strip()
    while url.endswith("/"):
        url = url[:-1]
    return url


# 中文品牌词 -> 英文，用于给中文名生成 id
CN_ID_WORDS = {"火山": "volcengine", "千问": "qwen", "智谱": "zhipu", "硅基": "siliconflow", "鱼鱼连线": "yylx"}


def slugify(name):
    for k, v in CN_ID_WORDS.items():
        name = name.replace(k, " " + v + " ")
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s


CN_KEYWORDS = [
    "智谱", "硅基", "火山", "阿里", "腾讯", "百度", "moonshot", "kimi", "minimax", "stepfun",
    "zhipu", "siliconflow", "volcengine", "dashscope", "qianfan", "tencent", "mimo",
    "shengsuanyun", "qiniu", "qnaigc",
]


def looks_cn(name, urls):
    hosts = [host_of(u) for u in urls if u]
    if any(h.endswith(".cn") for h in hosts):
        return True
    blob = (name + " " + " ".join(u for u in urls if u)).lower()
    if re.search(r"[一-鿿]", blob):
        return True
    return any(k in blob for k in CN_KEYWORDS)


# ---------- cc-switch 解析 ----------

PLAN_LABELS = {
    "payg": "按量计费", "coding": "Coding Plan", "plan": "Plan", "agentPlan": "Agent Plan",
    "codingPlan": "Coding Plan", "tokenPlan": "Token Plan", "stepPlan": "Step Plan",
    "enterprisePro": "Enterprise Pro", "enterpriseLite": "Enterprise Lite",
}
REGION_LABELS = {"cn": "国内站", "intl": "海外站", "global": "海外站"}


def array_entries(text, masked, marker_re):
    m = re.search(marker_re, masked)
    if not m:
        raise SystemExit("找不到预设数组：" + marker_re)
    return split_entries(text, masked, m.end() - 1)


def parse_ccswitch(path, kind):
    text = open(path, encoding="utf-8").read()
    masked = mask(text)
    dep = depths(masked)
    marker = (
        r"export const codexProviderPresets[^=]*=\s*\["
        if kind == "codex"
        else r"export const providerPresets[^=]*=\s*\["
    )
    out, skipped = [], []
    for lo, hi in array_entries(text, masked, marker):
        f = top_fields(text, masked, dep, lo, hi)
        g = lambda k: read_value(text, f[k]) if k in f else None
        name = g("name") or ""
        # 跳过：官方 / 自定义模板 / OAuth / 带 providerType
        reason = None
        if g("isOfficial"):
            reason = "isOfficial"
        elif g("isCustomTemplate"):
            reason = "isCustomTemplate"
        elif g("requiresOAuth"):
            reason = "requiresOAuth"
        elif "providerType" in f:
            reason = "providerType(OAuth)"
        base, cid = None, None
        if kind == "codex" and "config" in f:
            p = f["config"]
            while text[p] in " \t\r\n":
                p += 1
            if text[p] == "`":
                end = text.find("`", p + 1)
                body = text[p + 1 : end]
                m = re.search(r'^\s*base_url\s*=\s*"([^"]*)"', body, re.M)
                base = m.group(1) if m else None
            elif text.startswith("generateThirdPartyConfig", p):
                op = text.index("(", p)
                cl = match_close(masked, op)
                args = text[op + 1 : cl]
                strs = re.findall(r'"((?:[^"\\]|\\.)*)"', args)
                if len(strs) >= 2:
                    cid, base = strs[0], strs[1]
        elif kind == "claude" and "settingsConfig" in f:
            p = f["settingsConfig"]
            op = text.index("{", p)
            cl = match_close(masked, op)
            m = re.search(r'ANTHROPIC_BASE_URL\s*:\s*"([^"]*)"', text[op:cl])
            base = m.group(1) if m else None
        if reason is None and not base:
            reason = "无 base URL（模板或空配置）"
        if reason is None and re.search(r"YOUR_|<resource>|\{\w+\}", base):
            reason = "base URL 含占位符"
        if reason:
            skipped.append((kind, name, reason))
            continue
        e = {
            "kind": kind,
            "name": name,
            "website": strip_query(g("websiteUrl")),
            "keysUrl": strip_query(g("apiKeyUrl")),
            "category": g("category") or "",
            "family": g("family"),
            "planKey": g("planKey"),
            "regionKey": g("regionKey"),
            "base": clean_url(base),
            "cid": cid,
        }
        if kind == "codex":
            fmt = g("apiFormat")
            e["protocol"] = "chat" if fmt == "openai_chat" else "responses"
        out.append(e)
    return out, skipped


def variant_note(e):
    if not (e.get("family") or e.get("planKey") or e.get("regionKey")):
        return ""
    parts = []
    if e.get("planKey"):
        parts.append(PLAN_LABELS.get(e["planKey"]) or re.sub(r"([a-z])([A-Z])", r"\1 \2", e["planKey"]).title())
    if e.get("regionKey"):
        parts.append(REGION_LABELS.get(e["regionKey"], e["regionKey"]))
    return " · ".join(parts)


# ---------- magpie 解析 ----------


def go_eval(text, pos):
    """读 Go 值：字符串字面量或 bedrockChat/bedrockAnthropic("region") 调用；否则 None。"""
    while pos < len(text) and text[pos] in " \t\r\n":
        pos += 1
    if text[pos] in '"`':
        return unquote(text[pos:])[0] if text[pos] == '"' else text[pos + 1 : text.index("`", pos + 1)]
    m = re.match(r'(bedrockChat|bedrockAnthropic)\("([^"]+)"\)', text[pos:])
    if m:
        suffix = "/openai/v1" if m.group(1) == "bedrockChat" else "/anthropic"
        return "https://bedrock-runtime." + m.group(2) + ".amazonaws.com" + suffix
    return None


def parse_magpie(path):
    text = open(path, encoding="utf-8").read()
    masked = mask(text)
    dep = depths(masked)
    m = re.search(r"var presets = \[\]PresetDef\{", masked)
    out, skipped = [], []
    for lo, hi in split_entries(text, masked, m.end() - 1):
        f = top_fields(text, masked, dep, lo, hi)

        def g(k):
            return go_eval(text, f[k]) if k in f else None

        kind_m = re.match(r"\s*(\w+)", text[f["Kind"] :]) if "Kind" in f else None
        kind = kind_m.group(1) if kind_m else ""
        pid = g("ID")
        if pid is None:  # ID 是常量（AzurePreset 等），无地址，按名字登记
            pid = (g("Name") or "").lower()
        name = g("Name") or ""
        chat, resp, anth = (clean_url(g(k)) for k in ("Chat", "Responses", "Anthropic"))
        allu = [u for u in (chat, resp, anth) if u]
        if kind == "KindLocal" and any(host_of(u) in ("localhost", "127.0.0.1", "[::1]") for u in allu):
            skipped.append(("magpie", name, "本地服务（localhost）"))
            continue
        if not allu:
            skipped.append(("magpie", name, "无 Chat/Responses/Anthropic 地址（仅决策接口或需用户自填端点）"))
            continue
        if any("{" in u or "<" in u for u in allu):
            skipped.append(("magpie", name, "地址含占位符"))
            continue
        out.append(
            {
                "id": pid,
                "name": name,
                "kind": kind,
                "chat": chat,
                "responses": resp,
                "anthropic": anth,
                "website": g("Website") or "",
                "keysUrl": g("KeysURL") or "",
                "note": g("Note") or "",
            }
        )
    return out, skipped


# ---------- 合并 ----------


def region_of_cc(e):
    return "cn" if e["category"] == "cn_official" else None


def main():
    if len(sys.argv) != 4:
        sys.exit("用法：merge-provider-presets.py codexPresets.ts claudePresets.ts magpiePresets.go")
    codex, sk1 = parse_ccswitch(sys.argv[1], "codex")
    claude, sk2 = parse_ccswitch(sys.argv[2], "claude")
    magpie, sk3 = parse_magpie(sys.argv[3])
    skipped = sk1 + sk2 + sk3
    notes = []  # 分歧与合并说明

    # cc-switch：先以 Codex 条目为主，Claude 条目按名字 / 主机并入
    merged = []  # 每项: dict(name, website, keysUrl, category, openai, anthropic, note, src)
    for e in codex:
        merged.append(
            {
                "name": e["name"],
                "website": e["website"],
                "keysUrl": e["keysUrl"],
                "category": e["category"],
                "openai": {"apiBase": e["base"], "protocol": e["protocol"]},
                "anthropic": None,
                "note": variant_note(e),
                "variant": (e.get("family"), e.get("planKey"), e.get("regionKey")),
                "regionKey": e.get("regionKey"),
                "cid": e["cid"],
                "src": "cc",
            }
        )

    def norm(n):
        return re.sub(r"[^a-z0-9一-鿿]+", "", n.lower())

    for e in claude:
        target = None
        key = (e.get("family"), e.get("planKey"), e.get("regionKey"))
        for m in merged:
            if m["anthropic"] is None and norm(m["name"]) == norm(e["name"]):
                target = m
                break
        if target is None:
            for m in merged:
                if m["anthropic"] is not None or m["src"] != "cc":
                    continue
                if host_of(m["openai"]["apiBase"]) == host_of(e["base"]) and (
                    key == m["variant"] or key == (None, None, None) or m["variant"] == (None, None, None)
                ):
                    target = m
                    notes.append(f"cc-switch 内 Codex「{m['name']}」与 Claude「{e['name']}」按主机并入")
                    break
        if target is not None:
            target["anthropic"] = {"apiBase": e["base"]}
            for k in ("website", "keysUrl"):
                if not target[k] and e[k]:
                    target[k] = e[k]
            if not target["category"]:
                target["category"] = e["category"]
        else:
            merged.append(
                {
                    "name": e["name"],
                    "website": e["website"],
                    "keysUrl": e["keysUrl"],
                    "category": e["category"],
                    "openai": None,
                    "anthropic": {"apiBase": e["base"]},
                    "note": variant_note(e),
                    "variant": key,
                    "cid": None,
                    "src": "cc",
                }
            )

    # magpie 并入：按主机匹配 cc-switch 条目，其余作为新服务商
    def mp_urls(p):
        return [u for u in (p["chat"], p["responses"], p["anthropic"]) if u]

    magpie_only = []
    claimed = set()  # 已被某个 magpie 条目按主机认领的 cc-switch 条目下标

    def side_urls(m):
        return {x["apiBase"] for x in (m["openai"], m["anthropic"]) if x}

    for p in magpie:
        hosts = {host_of(u) for u in mp_urls(p)}
        urls = set(mp_urls(p))
        # 先找地址完全相同的，再找同主机的，最后按名字
        target = None
        for i, m in enumerate(merged):
            if urls & side_urls(m):
                target = i
                break
        if target is None:
            for i, m in enumerate(merged):
                if i in claimed:
                    continue  # 同主机但路径不同的另一个产品（如 OpenCode Zen 与 Go），不抢占
                if hosts & {host_of(u) for u in side_urls(m)}:
                    target = i
                    break
        if target is None:
            for i, m in enumerate(merged):
                if i not in claimed and norm(m["name"]) == norm(p["name"]):
                    target = i
                    break
        mp_openai = None
        if p["responses"]:
            mp_openai = {"apiBase": p["responses"], "protocol": "responses"}
        elif p["chat"]:
            mp_openai = {"apiBase": p["chat"], "protocol": "chat"}
        mp_anth = {"apiBase": p["anthropic"]} if p["anthropic"] else None
        if target is None:
            magpie_only.append((p, mp_openai, mp_anth))
            continue
        claimed.add(target)
        t = merged[target]
        # 分歧记录（cc-switch 胜出）
        if t["openai"] and mp_openai and (
            t["openai"]["apiBase"] != mp_openai["apiBase"] or t["openai"]["protocol"] != mp_openai["protocol"]
        ):
            notes.append(
                f"{t['name']}: openai cc-switch={t['openai']['apiBase']}({t['openai']['protocol']}) "
                f"magpie={mp_openai['apiBase']}({mp_openai['protocol']}) -> 取 cc-switch"
            )
        if t["anthropic"] and mp_anth and t["anthropic"]["apiBase"] != mp_anth["apiBase"]:
            notes.append(
                f"{t['name']}: anthropic cc-switch={t['anthropic']['apiBase']} magpie={mp_anth['apiBase']} -> 取 cc-switch"
            )
        # 只补缺失；要求 cc-switch 已有的那一侧与 magpie 对应地址一致，避免把别的套餐的地址补过来
        same_endpoint = bool(urls & side_urls(t))
        if t["openai"] is None and mp_openai:
            if same_endpoint:
                t["openai"] = mp_openai
                notes.append(f"{t['name']}: openai 缺失，由 magpie「{p['name']}」补 {mp_openai['apiBase']}")
            else:
                notes.append(f"{t['name']}: magpie「{p['name']}」的 openai 地址与 cc-switch 的端点不一致，未补")
        if t["anthropic"] is None and mp_anth:
            if same_endpoint:
                t["anthropic"] = mp_anth
                notes.append(f"{t['name']}: anthropic 缺失，由 magpie「{p['name']}」补 {mp_anth['apiBase']}")
            else:
                notes.append(f"{t['name']}: magpie「{p['name']}」的 anthropic 地址与 cc-switch 的端点不一致，未补")
        for k in ("website", "keysUrl"):
            if not t[k] and p[k]:
                t[k] = p[k]
        if not t["note"] and p["note"]:
            t["note"] = p["note"]

    # 生成最终条目
    providers_cn, providers_gl = [], []
    used = set()

    def uid(base):
        i, cand = 2, base
        while cand in used:
            cand = f"{base}-{i}"
            i += 1
        used.add(cand)
        return cand

    def finish(m, pid):
        rec = {"id": pid, "name": m["name"], "website": m["website"]}
        if m["keysUrl"]:
            rec["keysUrl"] = m["keysUrl"]
        rec["region"] = m["region"]
        rec["openai"] = m["openai"]
        rec["anthropic"] = m["anthropic"]
        if m["note"]:
            rec["note"] = m["note"]
        return rec

    for m in merged:
        urls = [x["apiBase"] for x in (m["openai"], m["anthropic"]) if x]
        cat = m["category"]
        if m.get("regionKey") == "intl" or any(("intl" in host_of(u) or "ap-southeast" in host_of(u)) for u in urls):
            region = "global"  # 海外站即便 cc-switch 归为 cn_official，也放 global
        elif cat == "cn_official":
            region = "cn"
        elif cat == "aggregator":
            region = "cn" if looks_cn(m["name"], urls + [m["website"]]) else "global"
        else:
            region = "global"
        m["region"] = region
        pid = slugify(m["name"]) or slugify(m.get("cid") or "") or slugify(host_of(urls[0]).split(".")[0])
        rec = finish(m, uid(pid))
        (providers_cn if region == "cn" else providers_gl).append(rec)

    mo_cn, mo_gl = [], []
    for p, o, a in sorted(magpie_only, key=lambda t: t[0]["name"].lower()):
        urls = mp_urls(p) + [p["website"]]
        region = "global" if p["kind"] == "KindLocal" else ("cn" if looks_cn(p["name"], urls) else "global")
        m = {
            "name": p["name"], "website": p["website"], "keysUrl": p["keysUrl"], "region": region,
            "openai": o, "anthropic": a, "note": p["note"],
        }
        rec = finish(m, uid(p["id"]))
        (mo_cn if region == "cn" else mo_gl).append(rec)

    providers = providers_cn + mo_cn + providers_gl + mo_gl

    # 校验
    # 推广链接不带进来：来源里的邀请码、活动页、短链（`/i/<码>`、`/invite/`、`/r/`、`/register/<码>`、
    # `/agent/register/<码>`、`?aff=` / `?ref=` 一类查询参数、`activity/ccswitch`、根路径下一截 6 位随机码、
    # `s.qiniu.com` 短链）一律退回官网首页；来源的推广码不是 Sophia 的。
    # 不带码的 `/register` 是普通注册页，留着
    affiliate = re.compile(
        r"/i/[A-Za-z0-9]+$|/invite/|/r/[A-Za-z0-9]+$|/register/[^/?#]+|activity/ccswitch|ccswitch|cc-switch"
        r"|^https?://[^/]+/[A-Za-z0-9]{6}$|[?&](aff|aff_code|ref|referral|invite|invite_code|inviter|promo)=",
        re.I,
    )
    for r in providers:
        if r["website"].startswith("https://s.qiniu.com/"):
            r["website"] = "https://www.qiniu.com"
        if affiliate.search(r.get("keysUrl") or ""):
            r.pop("keysUrl", None)
        if affiliate.search(r["website"]):
            r["website"] = re.sub(r"^(https?://[^/]+).*$", r"\1", r["website"])
    ids = set()
    for r in providers:
        assert r["id"] not in ids, "id 重复：" + r["id"]
        ids.add(r["id"])
        assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", r["id"]), "id 非 kebab-case：" + r["id"]
        assert r["openai"] or r["anthropic"], "无任何地址：" + r["id"]
        assert r["region"] in ("cn", "global")
        for side in (r["openai"], r["anthropic"]):
            if side:
                b = side["apiBase"]
                assert re.match(r"https?://", b) and not b.endswith("/"), f"{r['id']} 地址不合法：{b}"
        if r["openai"]:
            assert r["openai"]["protocol"] in ("chat", "responses"), r["id"]

    json.dump({"_notice": NOTICE, "providers": providers}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")

    # 统计与明细到 stderr
    cn = sum(1 for r in providers if r["region"] == "cn")
    usable = sum(1 for r in providers if r["openai"])
    print(f"total={len(providers)} cn={cn} global={len(providers)-cn} openai={usable} anthropic_only={len(providers)-usable}", file=sys.stderr)
    print(f"cc-switch codex={len(codex)} claude={len(claude)} magpie={len(magpie)} magpie_only={len(magpie_only)}", file=sys.stderr)
    for s in skipped:
        print("SKIP", *s, sep=" | ", file=sys.stderr)
    for n in notes:
        print("NOTE", n, file=sys.stderr)


if __name__ == "__main__":
    main()

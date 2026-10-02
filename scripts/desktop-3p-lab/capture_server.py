#!/usr/bin/env python3
"""桌面应用 3P 实验用的本机抓包服务（只用 Python 标准库，改写自 Claude Code P0 抓包脚本）。

只监听 127.0.0.1。把 Claude 桌面应用发来的每个请求（方法、完整路径、全部请求头、请求体）各存一个 JSON，
并按官方网关约定回应，让桌面应用能正常走完对话：
  HEAD/GET /api/hello              → 200
  GET  /v1/models                  → 模型列表（models.json 的 gatewayModels：非 Claude 名 + display_name + anthropic_family_tier 等）
  GET  /v1/models/<id>             → 单个模型
  POST /v1/messages/count_tokens   → {"input_tokens": 1234}
  POST /v1/messages                → 合法的 Anthropic 响应（流式 / 非流式）；回复文字里写明收到的 model，界面上一眼可见
  OPTIONS 任意路径                  → 204 + 放行的 CORS 头（顺便记下：出现 OPTIONS 说明请求来自浏览器环境）
  其他                              → 404（也记下）
路径前有任意前缀（如 /claude-desktop/v1/messages）也认。

鉴权头只记「是不是实验假令牌」，别的凭证值（万一出现）落盘前就打码。Cookie 同样打码。

特殊指令（写在你发给模型的那句话里）：
  LAB-STALL-330         先静默 330 秒再回答，期间每 15 秒发一次 SSE ping（验证保活）
  LAB-STALL-NOPING-330  先静默 330 秒再回答，期间什么都不发（对照组）
  LAB-TOOL <工具名> [<JSON 输入>]
                        回一个 tool_use 调这个工具（输入不给就按工具的 input_schema 造一个最小值），
                        工具结果回来后再回文字。用来让 Code 标签起子代理（如 LAB-TOOL Agent {"description":…}）。
                        请求里没有这个工具时回文字，列出这次请求带的全部工具名。

假上游（同一个 serve 进程、同一个端口，按路径区分）：
  路径首段匹配 ^/openai[A-Za-z0-9_-]*$（/openai、/openai-a、/openai-b …）的请求按 OpenAI Chat Completions 处理，
  去掉这个前缀和可选的 /v1 得到上游路由；密钥与模型表见 models.json 的 upstream（密钥不是秘密）。用来看 Sophia 路由
  转换后实际发往上游的请求，并向上游注入故障。
  GET  <前缀>[/v1]/models            → 需要 Authorization: Bearer <upstream.key>，否则 401（OpenAI 错误体）
  POST <前缀>[/v1]/chat/completions  → 同样要鉴权；完整记下请求体，然后按下面的规则回（流式 / 非流式）
  其他 /openai* 路径                   → 404（OpenAI 错误体，也记下）
  回什么（按顺序，先中先用）：
    response_format.type=json_schema             → 按 schema 造一个最小合法 JSON（决定：结构化输出（response_format））
    第一条 system 里有单独一行「JSON Schema:」、其后跟一段 JSON → 同上，按那段 schema 造（决定：结构化输出（只写说明），Sophia 只写说明的降级）
    最后一条含 LAB-TOOL / LAB-TOOLS 的 user 消息，且其后还没有 assistant 消息 → 回 tool_calls（finish_reason=tool_calls）
        LAB-TOOL <工具名> [<JSON 参数>]           一个调用；参数不给就按工具的 function.parameters 造；没有这个工具时回文字列出全部工具名
        LAB-TOOLS [{"name":…,"arguments":{…}},…]  一次回多个调用（并行），流式时按真实上游的样子交错发（先依次开 index 0、1…，再轮流发参数片段）
        工具调用 id 形如 functions.<名字>:<序号>（含 . 和 :，用来验证 Sophia 会把 id 改写成合法字符）
    工具结果回来后（最后一条 assistant 之后有 role=tool）→ 文字「【假上游】收到 N 个工具结果：…」
    其他                                           → 文字「【假上游】已收到。model=…；消息数=…；工具数=…；stream=…；最后一句：…」
  指令（写在最后一句用户话里，可与上面任一种组合）：
    LAB-STALL-<n>   发完角色块后静默 n 秒再回内容（验证 Sophia 自己会发保活 ping）
    LAB-THINK-<n>   回内容前每 5 秒发一个 reasoning_content 块，共 n 秒（验证 Sophia 丢弃推理但仍保活）
  流式：data: 行的 SSE、chunked 传输，末尾依次是 finish_reason 块、只有 usage 的块、data: [DONE]。

故障注入（模拟上游或路由出错，默认关）：
  python3 capture_server.py fault <种类> [--times N] [--retry-after 秒] [--scope messages|v1|upstream|upstream-all] [--match 文字] [--port 18765]
    种类：off（关）、status（只看现在的设置）、
          400 / 401 / 403 / 429 / 500 / 503 / 529（回对应状态码与错误体；429 带 retry-after 头）、
          too-long（Anthropic 侧回 400 prompt is too long；上游侧回 400 context_length_exceeded，用来看会不会自动压缩）、
          reject-format（只对带结构化输出参数的请求回 400：Anthropic 侧看 output_config.format，上游侧看 response_format；
                         别的请求照常通过、也不消耗 --times）、
          cut（流式回答发到一半直接断开连接，不发 [DONE] 也不发结束块）、
          sse-error（流式回答发到一半给错误事件，再正常结束流：Anthropic 侧是 event: error，上游侧是 data: {"error":…}，都不发 [DONE]）
    --times N        只对接下来 N 个匹配的请求生效，用完自动关（默认 0 = 一直生效，直到 fault off）
    --retry-after 秒 429 的 retry-after 头（默认 20；-1 为不带这个头）
    --scope          messages（默认）：只作用于 POST /v1/messages；v1：/v1/ 下全部（含 /v1/models、count_tokens）。
                     upstream：只作用于 POST <前缀>/chat/completions；upstream-all：/openai* 下的每个请求（含 models）。
                     messages / v1 不影响 /openai*；upstream* 不影响 Anthropic 路由。
                     /api/hello 永远不受影响；cut 与 sse-error 只作用于 POST /v1/messages 或 POST <前缀>/chat/completions
    --match 文字     只作用于最后一句用户话里含这段文字的 POST /v1/messages（upstream* 范围下是 chat/completions）
                     （起标题、压缩等后台请求一般不含）
    上游侧状态码故障回 OpenAI 形状的错误体 {"error":{"message":…,"type":…,"code":…}}；429 的 type 是 rate_limit_exceeded，
    503 是 server_error（"The server is overloaded"），529 是原样的 529 overloaded。
  serve 也可以带 --fault / --fault-times / --retry-after / --fault-scope / --fault-match，从启动起就注入。

记录代理（tee）：夹在 Claude 桌面应用和 Sophia 路由之间，原样转发并只记请求头，用来看桌面应用真正发了什么头：
  python3 capture_server.py proxy --listen <端口> --target http://127.0.0.1:<端口> [--out <目录>]
    只监听 127.0.0.1；默认记到 <CLAUDE_LAB_STATE_DIR 或 ~/claude-desktop-lab>/tee/<阶段>/，记录格式与 serve 相同，
    summary / timeline 直接可用（python3 capture_server.py summary <tee 目录>）。
    /__lab/phase?name= 与 serve 一样能切阶段（python3 capture_server.py phase X --port <listen 端口>）。
    其他请求（任意方法，含 OPTIONS / HEAD）：记下全部请求头，Authorization / x-api-key / Cookie 等只留「已打码 + 长度」
    （以 sophia- 开头的写成 <已打码：sophia-…，长 N>；实验假令牌照写），不存对话正文，只存 body_summary
    （model、stream、max_tokens、顶层键、消息数、工具数、有没有 output_config.format）；然后原样转发给 --target
    （同方法、同路径与查询串、同请求头，只换 Host、去掉逐跳头，请求体字节不变），响应边到边回给客户端。
    记录的决定是「转发 → 状态码」（带上响应的 access-control-allow-origin）；目标连不上回 502 并记下。

子命令：
  python3 capture_server.py serve   [--port 18765] [--out ~/claude-desktop-lab/capture]
  python3 capture_server.py phase   <名字> [--port 18765]   把之后的请求记到 <out>/<名字>/ 下（每个实验一段）
  python3 capture_server.py fault   <种类> [选项]           见上
  python3 capture_server.py proxy   --listen <端口> --target <URL> [--out <目录>]   见上
  python3 capture_server.py summary [<目录>]                 汇总请求头（Origin / Sec-Fetch-* / User-Agent / 鉴权）、模型名与请求体要点，贴回来用
  python3 capture_server.py timeline [<目录>] [--phase 名字]  按时间列出每个请求、与上一个请求的间隔、X-Stainless-Retry-Count，看重试
  python3 capture_server.py redact  <目录> <输出目录> [--strip-bodies]
                                                             存档前脱敏：家目录换成 ~；--strip-bodies 把对话正文换成长度
不带子命令等同于 serve。按 Ctrl-C 停止。可重复运行：同一 out 目录下编号接着往后排。
"""
import argparse
import http.client
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = json.load(open(os.path.join(HERE, "models.json"), encoding="utf-8"))
DEFAULT_OUT = os.path.join(os.environ.get("CLAUDE_LAB_STATE_DIR", os.path.expanduser("~/claude-desktop-lab")), "capture")
DEFAULT_TEE_OUT = os.path.join(os.environ.get("CLAUDE_LAB_STATE_DIR", os.path.expanduser("~/claude-desktop-lab")), "tee")
DEFAULT_PORT = 18765
CRED_HEADERS = {"authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"}

STATE = {"out": DEFAULT_OUT, "phase": "00-start", "seq": 0}
LOCK = threading.Lock()
# 模拟别家（配置切换工具）的 profile 用的令牌，也不是秘密（见 models.json 的 foreign）
FOREIGN_TOKEN = (LAB.get("foreign") or {}).get("token")

STATUS_FAULTS = {
    "400": (400, "invalid_request_error", "lab: bad request"),
    "401": (401, "authentication_error", "lab: invalid bearer token"),
    "403": (403, "permission_error", "lab: forbidden"),
    "429": (429, "rate_limit_error", "lab: Number of request tokens has exceeded your per-minute rate limit"),
    "500": (500, "api_error", "lab: Internal server error"),
    "503": (503, "api_error", "lab: Service unavailable"),
    "529": (529, "overloaded_error", "lab: Overloaded"),
    "too-long": (400, "invalid_request_error", "prompt is too long: 213000 tokens > 200000 maximum"),
    # 只对带结构化输出参数的请求生效（Anthropic 侧看 output_config.format，上游侧看 response_format）
    "reject-format": (400, "invalid_request_error", "lab: output_config.format is not supported"),
}
# 上游侧（OpenAI 形状）的状态码故障：种类 → (状态码, 错误对象)
UP_STATUS_FAULTS = {
    "400": (400, {"message": "lab upstream: bad request", "type": "invalid_request_error", "code": "bad_request"}),
    "401": (401, {"message": "lab upstream: Incorrect API key provided", "type": "invalid_request_error", "code": "invalid_api_key"}),
    "403": (403, {"message": "lab upstream: access denied", "type": "permission_error", "code": "access_denied"}),
    "429": (429, {"message": "lab upstream: Rate limit reached for requests", "type": "rate_limit_exceeded", "code": "rate_limit_exceeded"}),
    "500": (500, {"message": "lab upstream: The server had an error while processing your request", "type": "server_error", "code": "internal_error"}),
    "503": (503, {"message": "lab upstream: The server is overloaded, please try again later", "type": "server_error", "code": "service_unavailable"}),
    "529": (529, {"message": "lab upstream: Overloaded", "type": "overloaded_error", "code": "overloaded"}),
    "too-long": (400, {"message": "This model's maximum context length is 163840 tokens. However, your messages resulted in 213000 tokens. "
                                  "Please reduce the length of the messages.",
                       "type": "invalid_request_error", "param": "messages", "code": "context_length_exceeded"}),
    "reject-format": (400, {"message": "lab upstream: response_format json_schema is not supported", "type": "invalid_request_error"}),
}
STREAM_FAULTS = ("cut", "sse-error")
FAULT_KINDS = ("off",) + tuple(STATUS_FAULTS) + STREAM_FAULTS
FAULT_SCOPES = ("messages", "v1", "upstream", "upstream-all")
UPSTREAM_SCOPES = ("upstream", "upstream-all")
FAULT = {"kind": "off", "times": 0, "used": 0, "retry_after": 20, "scope": "messages", "match": ""}

# 假上游（见 models.json 的 upstream）
UPSTREAM = LAB.get("upstream") or {}
UPSTREAM_KEY = UPSTREAM.get("key") or "sk-lab-fake-upstream-key-not-a-secret"
UPSTREAM_MODELS = UPSTREAM.get("models") or ["fake/kimi-k2.5"]
UPSTREAM_PATH_RE = re.compile(r"^(/openai[A-Za-z0-9_-]*)(/.*)?$")
UPSTREAM_HALF = "【假上游】这句话只发了一半，"
# 逐跳头：记录代理转发时不带过去（Proxy-* 另按前缀判断）
HOP_BY_HOP = {"connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def hms_ms(t):
    return time.strftime("%H:%M:%S", time.localtime(t)) + ".%03d" % int((t % 1) * 1000)


def set_fault(kind, times=0, retry_after=20, scope="messages", match=""):
    if kind not in FAULT_KINDS:
        raise ValueError(f"种类只能是 {', '.join(FAULT_KINDS)}")
    if scope not in FAULT_SCOPES:
        raise ValueError(f"scope 只能是 {', '.join(FAULT_SCOPES)}")
    if times < 0 or retry_after < -1:
        raise ValueError("times 要 ≥ 0，retry-after 要 ≥ -1")
    with LOCK:
        FAULT.update(kind=kind, times=times, used=0, retry_after=retry_after, scope=scope, match=match)
        return dict(FAULT)


def describe_fault(f):
    if f["kind"] == "off":
        return "故障注入：关"
    extra = f"，retry-after={f['retry_after'] if f['retry_after'] >= 0 else '不带'}" if f["kind"] == "429" else ""
    left = "一直生效" if not f["times"] else f"还剩 {f['times'] - f['used']}/{f['times']} 次"
    match = f"，只认含「{f['match']}」的用户话" if f["match"] else ""
    return f"故障注入：{f['kind']}（范围 {f['scope']}，{left}{extra}{match}）"


def take_fault(method, route, user_text=None, upstream=None, has_format=False):
    """这个请求要不要注入故障；要就返回这次的故障设置（带第几次），并计数。

    upstream：None = Anthropic 侧的请求；"chat" = 假上游的 POST chat/completions；"other" = 假上游的其他请求。
    has_format：请求带结构化输出参数（output_config.format / response_format），reject-format 只认这种请求。
    """
    with LOCK:
        f = FAULT
        if f["kind"] == "off":
            return None
        if upstream is None:
            if f["scope"] in UPSTREAM_SCOPES:
                return None
            is_msg = method == "POST" and route == "/v1/messages"
            if f["kind"] in STREAM_FAULTS or f["kind"] == "reject-format" or f["scope"] == "messages" or f["match"]:
                if not is_msg:
                    return None
            elif not route.startswith("/v1/"):
                return None
        else:
            if f["scope"] not in UPSTREAM_SCOPES:
                return None
            if f["scope"] == "upstream" or f["kind"] in STREAM_FAULTS or f["kind"] == "reject-format" or f["match"]:
                if upstream != "chat":
                    return None
        if f["kind"] == "reject-format" and not has_format:
            return None
        if f["match"] and f["match"] not in (user_text or ""):
            return None
        f["used"] += 1
        got = dict(f, n=f["used"])
        if f["times"] and f["used"] >= f["times"]:
            print(f"     （故障 {f['kind']} 已用完 {f['times']} 次，恢复正常）", flush=True)
            f["kind"] = "off"
        return got


def route_of(path):
    """去掉查询串与任意前缀，返回 /v1/... 或 /api/... 起的规范路径。"""
    p = path.split("?", 1)[0]
    for marker in ("/v1/", "/api/", "/__lab/"):
        i = p.find(marker)
        if i >= 0:
            return p[i:]
    return p


def mask_header(name, value, tee=False):
    """凭证类请求头：实验假令牌照写（它不是秘密），其他值只留类型与长度。tee=True 时另认 sophia- 开头的令牌。"""
    if name.lower() not in CRED_HEADERS:
        return value
    v = value
    scheme = ""
    if name.lower() in ("authorization", "proxy-authorization") and " " in v:
        scheme, v = v.split(" ", 1)
        scheme += " "
    if v == LAB["labToken"] or v == UPSTREAM_KEY or (FOREIGN_TOKEN and v == FOREIGN_TOKEN):
        return scheme + v
    if tee:
        if v.startswith("sophia-"):
            return f"{scheme}<已打码：sophia-…，长 {len(v)}>"
        return f"{scheme}<已打码：长 {len(v)}>"
    return f"{scheme}<已打码：不是实验令牌，长 {len(v)}>"


def auth_kind(headers):
    a = headers.get("Authorization")
    k = headers.get("x-api-key")
    parts = []
    if a:
        if a == "Bearer " + LAB["labToken"]:
            parts.append("bearer=实验令牌")
        elif FOREIGN_TOKEN and a == "Bearer " + FOREIGN_TOKEN:
            parts.append("bearer=模拟别家令牌")
        else:
            parts.append("authorization=其他")
    if k:
        parts.append("x-api-key=实验令牌" if k == LAB["labToken"] else "x-api-key=其他")
    return ",".join(parts) or "无"


def upstream_auth_kind(headers):
    a = headers.get("Authorization")
    if not a:
        return "无"
    return "bearer=假上游密钥" if a == "Bearer " + UPSTREAM_KEY else "authorization=其他"


def tee_token_kind(v):
    if v == LAB["labToken"]:
        return "实验令牌"
    if FOREIGN_TOKEN and v == FOREIGN_TOKEN:
        return "模拟别家令牌"
    if v == UPSTREAM_KEY:
        return "假上游密钥"
    if v.startswith("sophia-"):
        return f"sophia-令牌(长{len(v)})"
    return f"其他(长{len(v)})"


def tee_auth_kind(headers):
    """记录代理用：区分实验令牌、sophia- 令牌与其他，附长度（不落值）。"""
    parts = []
    a = headers.get("Authorization")
    if a:
        scheme, _, v = a.partition(" ")
        if not v:
            scheme, v = "", a
        parts.append(f"{'bearer' if scheme.lower() == 'bearer' else 'authorization'}={tee_token_kind(v)}")
    k = headers.get("x-api-key")
    if k:
        parts.append("x-api-key=" + tee_token_kind(k))
    return ",".join(parts) or "无"


def msg_text(m):
    """一条消息的文字：content 是字符串，或 [{type:"text",text}] 片段列表。"""
    c = m.get("content") if isinstance(m, dict) else None
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


def last_user_text(body):
    for m in reversed(body.get("messages") or []):
        if isinstance(m, dict) and m.get("role") == "user":
            return msg_text(m)
    return ""


def last_user_has_tool_result(body):
    for m in reversed(body.get("messages") or []):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        return isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
    return False


def fill_schema(s):
    """按 JSON Schema 造一个最小的合法值（起标题等结构化输出请求用）。"""
    if not isinstance(s, dict):
        return "实验"
    if "enum" in s and s["enum"]:
        return s["enum"][0]
    t = s.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    if t == "object" or "properties" in s:
        props = s.get("properties") or {}
        return {k: fill_schema(v) for k, v in props.items()}
    if t == "array":
        return []
    if t in ("integer", "number"):
        return 0
    if t == "boolean":
        return False
    return "实验网关标题"


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def upstream_split(path):
    """假上游的路径：返回 (前缀, 上游路由)，如 /openai-a/v1/models → ("/openai-a", "/models")；不是假上游返回 None。"""
    m = UPSTREAM_PATH_RE.match(path.split("?", 1)[0])
    if not m:
        return None
    rest = m.group(2) or ""
    if rest == "/v1" or rest.startswith("/v1/"):
        rest = rest[3:]
    return m.group(1), rest.rstrip("/") or "/"


def split_pieces(text, n):
    """把字符串切成最多 n 段非空的片段（流式时分几块发）。"""
    if not text:
        return []
    n = max(1, min(n, len(text)))
    size = -(-len(text) // n)
    return [text[i:i + size] for i in range(0, len(text), size)]


def strip_reminders(text):
    return re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S)


def one_line(text, n):
    return " ".join(text.split())[:n]


def marker_schema(messages):
    """Sophia 只写说明的结构化输出：第一条 system 里 JSON Schema: 标记行后面跟着 schema 的 JSON 文本。"""
    marker = "\nJSON Schema:\n"
    for m in messages:
        if m.get("role") != "system":
            continue
        text = msg_text(m)
        i = text.find(marker)
        if i < 0:
            return None
        try:
            obj, _ = json.JSONDecoder().raw_decode(text[i + len(marker):])
        except ValueError:
            return None
        return obj if isinstance(obj, dict) else None
    return None


def plan_upstream_reply(body):
    """假上游这次回什么：返回 (文字, 工具调用列表, 决定)。工具调用是 [{"id","name","arguments"（JSON 文本）}]。"""
    messages = [m for m in body.get("messages") or [] if isinstance(m, dict)]
    specs = {}
    for t in body.get("tools") or []:
        fn = t.get("function") if isinstance(t, dict) else None
        if isinstance(fn, dict) and fn.get("name"):
            specs[fn["name"]] = fn
    rf = body.get("response_format")
    if isinstance(rf, dict) and rf.get("type") == "json_schema":
        schema = (rf.get("json_schema") or {}).get("schema")
        return json.dumps(fill_schema(schema), ensure_ascii=False), [], "结构化输出（response_format）"
    schema = marker_schema(messages)
    if schema is not None:
        return json.dumps(fill_schema(schema), ensure_ascii=False), [], "结构化输出（只写说明）"
    # 工具指令：最后一条含 LAB-TOOL / LAB-TOOLS 的 user 消息
    di = next((i for i in range(len(messages) - 1, -1, -1)
               if messages[i].get("role") == "user" and re.search(r"LAB-TOOLS?\s", msg_text(messages[i]))), None)
    if di is not None:
        after = messages[di + 1:]
        if not any(m.get("role") == "assistant" for m in after):
            return plan_tool_calls(msg_text(messages[di]), specs, messages)
        # 最后一条 assistant 之后有 role=tool 的消息就是工具结果回来了（Sophia 可能在 tool 消息后面再接一条
        # 只含 <system-reminder> 的 user 消息，所以不要求最后一条是 tool）
        last_asst = max(i for i, m in enumerate(messages) if m.get("role") == "assistant")
        results = [one_line(msg_text(m), 60) for m in messages[last_asst + 1:] if m.get("role") == "tool"]
        if results:
            text = f"【假上游】收到 {len(results)} 个工具结果：" + "；".join(f"{i + 1}）{r}" for i, r in enumerate(results))
            return text, [], f"文字（工具结果 {len(results)} 个）"
    last = one_line(strip_reminders(last_user_text(body)), 40)
    text = (f"【假上游】已收到。model={body.get('model')}；消息数={len(messages)}；工具数={len(body.get('tools') or [])}；"
            f"stream={bool(body.get('stream'))}；最后一句：{last}")
    return text, [], "文字"


def plan_tool_calls(text, specs, messages):
    """解析 LAB-TOOL / LAB-TOOLS 指令，造工具调用。"""
    mm = re.search(r"LAB-TOOL(S?)\s+", text)
    plural, rest = bool(mm.group(1)), text[mm.end():]
    names = ", ".join(sorted(specs)) or "（没有）"
    if plural:
        try:
            items, _ = json.JSONDecoder().raw_decode(rest)
            if not isinstance(items, list) or not items or not all(isinstance(x, dict) and x.get("name") for x in items):
                raise ValueError("要 [{\"name\":…,\"arguments\":{…}},…]")
        except ValueError as e:
            return f"【假上游】LAB-TOOLS 后面的 JSON 解析不了：{e}", [], "文字（LAB-TOOLS JSON 有误）"
        wanted = [(x["name"], x.get("arguments")) for x in items]
    else:
        nm = re.match(r"([A-Za-z0-9_.:-]+)\s*", rest)
        if not nm:
            return "【假上游】LAB-TOOL 后面缺工具名。", [], "文字（LAB-TOOL 缺工具名）"
        args = None
        tail = rest[nm.end():]
        if tail.startswith("{"):
            try:
                args, _ = json.JSONDecoder().raw_decode(tail)
            except ValueError as e:
                return f"【假上游】LAB-TOOL 后面的 JSON 解析不了：{e}", [], "文字（LAB-TOOL JSON 有误）"
        wanted = [(nm.group(1), args)]
    for name, _ in wanted:
        if name not in specs:
            return f"【假上游】这次请求里没有名为 {name} 的工具。带的工具：{names}", [], f"文字（没有工具 {name}）"
    base = sum(len(m.get("tool_calls") or []) for m in messages if m.get("role") == "assistant")
    calls = []
    for i, (name, args) in enumerate(wanted):
        if args is None:
            args = fill_schema(specs[name].get("parameters"))
        # 真实上游的 id 形如 functions.get_weather:0，含 . 与 :，Sophia 要把它改写成合法字符
        calls.append({"id": f"functions.{name}:{base + i}", "name": name,
                      "arguments": args if isinstance(args, str) else json.dumps(args if isinstance(args, dict) else {}, ensure_ascii=False)})
    return "", calls, "tool_calls " + ", ".join(c["name"] for c in calls)


def chat_chunk(cid, model, created, delta, finish=None):
    return {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


UPSTREAM_USAGE = {"prompt_tokens": 1000, "completion_tokens": 12, "total_tokens": 1012,
                  "prompt_tokens_details": {"cached_tokens": 600}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    TEE = False  # 记录代理的子类设为 True：凭证按 sophia- 规则打码、鉴权按令牌类型记

    def log_message(self, fmt, *args):
        pass

    # ---------- 读与记 ----------
    def read_body(self):
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            data = b""
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0], 16)
                if size == 0:
                    self.rfile.readline()
                    return data
                data += self.rfile.read(size)
                self.rfile.readline()
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def record(self, raw, decision, body=None, route=None, auth=None, extra=None, t=None):
        h = self.headers
        t = t or time.time()
        with LOCK:
            STATE["seq"] += 1
            seq, phase, out = STATE["seq"], STATE["phase"], STATE["out"]
        rec = {
            "seq": seq,
            "time": now(),
            "t": round(t, 3),
            "phase": phase,
            "method": self.command,
            "path": self.path,
            "route": route or route_of(self.path),
            "http_version": self.request_version,
            "client": self.client_address[0],
            "headers": [[k, mask_header(k, v, self.TEE)] for k, v in h.items()],
            "auth": auth or (tee_auth_kind(h) if self.TEE else auth_kind(h)),
            "decision": decision,
        }
        if extra:
            rec.update(extra)
        if body is not None:
            rec["body"] = body
        elif raw:
            try:
                rec["body"] = json.loads(raw)
            except Exception:
                try:
                    rec["body_text"] = raw.decode("utf-8")
                except Exception:
                    rec["body_len"] = len(raw)
        d = os.path.join(out, phase)
        os.makedirs(d, exist_ok=True)
        slug = rec["route"].strip("/").replace("/", "_")[:60] or "root"
        with open(os.path.join(d, f"{seq:04d}-{self.command}-{slug}.json"), "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
        info = rec.get("body") if isinstance(rec.get("body"), dict) else rec.get("body_summary")
        model = info.get("model") if isinstance(info, dict) else None
        sec = ",".join(sorted(k for k in h.keys() if k.lower().startswith("sec-fetch"))) or "-"
        line = (f"{seq:04d} {rec['time']}{hms_ms(t)[8:]} [{phase}] {self.command} {self.path} model={model} "
                f"origin={h.get('Origin') or '-'} sec-fetch={sec} ua={(h.get('User-Agent') or '-')[:60]!r} "
                f"auth={rec['auth']} -> {decision}")
        for p in (os.path.join(d, "index.log"), os.path.join(out, "index.log")):
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        print(line, flush=True)

    # ---------- 回 ----------
    def cors_headers(self):
        o = self.headers.get("Origin")
        if not o:
            return {}
        return {
            "access-control-allow-origin": o,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": self.headers.get("Access-Control-Request-Headers") or "*",
            "access-control-allow-methods": "GET, POST, HEAD, OPTIONS",
            "access-control-max-age": "600",
        }

    def send(self, code, obj=None, ctype="application/json", extra=None):
        data = b"" if obj is None else (obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode())
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        for k, v in list(self.cors_headers().items()) + list((extra or {}).items()):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def fail(self, raw, f, body=None):
        """按故障设置回一个错误（状态码类故障）。"""
        code, etype, msg = STATUS_FAULTS[f["kind"]]
        extra = {"request-id": "req_lab" + uuid.uuid4().hex[:16]}
        if f["kind"] == "429" and f["retry_after"] >= 0:
            extra["retry-after"] = str(f["retry_after"])
        nth = f"第 {f['n']}/{f['times']} 次" if f["times"] else f"第 {f['n']} 次"
        self.record(raw, f"故障 {code} {etype}（{nth}）", body)
        return self.send(code, {"type": "error", "error": {"type": etype, "message": msg}}, extra=extra)

    def handle_any(self):
        raw = self.read_body() if self.command in ("POST", "PUT", "PATCH") else b""
        up = upstream_split(self.path)
        if up:
            return self.upstream(raw, *up)
        r = route_of(self.path)
        if r.startswith("/__lab/phase"):
            return self.switch_phase()
        if r.startswith("/__lab/fault"):
            return self.switch_fault()
        if self.command == "OPTIONS":
            self.record(raw, "204 CORS 预检")
            return self.send(204)
        if r == "/api/hello":
            self.record(raw, "200 hello")
            return self.send(200, None if self.command == "HEAD" else {})
        if r.startswith("/v1/") and not (self.command == "POST" and r == "/v1/messages"):
            f = take_fault(self.command, r)
            if f:
                return self.fail(raw, f)
        if self.command in ("GET", "HEAD") and r == "/v1/models":
            self.record(raw, "200 models")
            return self.send(200, self.models_list())
        if self.command in ("GET", "HEAD") and r.startswith("/v1/models/"):
            mid = r[len("/v1/models/"):]
            m = next((x for x in self.models_list()["data"] if x["id"] == mid), None)
            self.record(raw, "200 model" if m else "404 model")
            return self.send(200, m) if m else self.send(404, {"type": "error", "error": {"type": "not_found_error", "message": "unknown model"}})
        if self.command == "POST" and r == "/v1/messages/count_tokens":
            self.record(raw, "200 count_tokens")
            return self.send(200, {"input_tokens": 1234})
        if self.command == "POST" and r == "/v1/messages":
            return self.messages(raw)
        self.record(raw, f"404 未处理 {self.command} {r}")
        return self.send(404, {"type": "error", "error": {"type": "not_found_error", "message": f"lab: unhandled {self.command} {r}"}})

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = handle_any

    def switch_phase(self):
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        name = dict(x.split("=", 1) for x in q.split("&") if "=" in x).get("name", "")
        name = urllib.parse.unquote(name)
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", name or ""):
            return self.send(400, {"error": "name 只能是字母数字 . _ -"})
        with LOCK:
            STATE["phase"] = name
        print(f"---- 进入阶段 {name}（之后的请求记到 {os.path.join(STATE['out'], name)}）", flush=True)
        with open(os.path.join(STATE["out"], "index.log"), "a", encoding="utf-8") as f:
            f.write(f"---- {now()} 进入阶段 {name}\n")
        return self.send(200, {"phase": name})

    def switch_fault(self):
        q = dict(urllib.parse.parse_qsl(self.path.split("?", 1)[1] if "?" in self.path else ""))
        if q.get("kind", "status") == "status":
            with LOCK:
                cur = dict(FAULT)
            return self.send(200, {"fault": cur, "text": describe_fault(cur), "phase": STATE["phase"]})
        try:
            cur = set_fault(q["kind"], int(q.get("times", 0)), int(q.get("retry_after", 20)),
                            q.get("scope", "messages"), q.get("match", ""))
        except (ValueError, KeyError) as e:
            return self.send(400, {"error": str(e)})
        text = describe_fault(cur)
        print(f"---- {text}", flush=True)
        with open(os.path.join(STATE["out"], "index.log"), "a", encoding="utf-8") as f:
            f.write(f"---- {now()} {text}\n")
        return self.send(200, {"fault": cur, "text": text, "phase": STATE["phase"]})

    @staticmethod
    def models_list():
        data = []
        for m in LAB["gatewayModels"]:
            d = {"type": "model", "created_at": "2026-09-01T00:00:00Z"}
            d.update(m)
            data.append(d)
        return {"data": data, "has_more": False, "first_id": data[0]["id"], "last_id": data[-1]["id"]}

    def messages(self, raw):
        try:
            body = json.loads(raw)
        except Exception:
            self.record(raw, "400 不是 JSON")
            return self.send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "bad json"}})
        model = body.get("model")
        stream = bool(body.get("stream"))
        fmt = (body.get("output_config") or {}).get("format") or {}
        user = last_user_text(body)
        fault = take_fault("POST", "/v1/messages", user, has_format=bool(fmt))
        if fault and fault["kind"] in STATUS_FAULTS:
            return self.fail(raw, fault, body)
        stall = re.search(r"LAB-STALL-(NOPING-)?(\d{1,4})", user)
        tool = re.search(r"LAB-TOOL\s+([A-Za-z0-9_.:-]+)(?:\s+(\{.*\}))?", user, re.S)
        tool_use = None  # (id, name, input)
        if fmt.get("type") == "json_schema":
            text = json.dumps(fill_schema(fmt.get("schema")), ensure_ascii=False)
            decision = "结构化输出"
        elif tool and not last_user_has_tool_result(body):
            tools = {t.get("name"): t for t in body.get("tools") or [] if isinstance(t, dict)}
            name = tool.group(1)
            if name not in tools:
                text = f"【实验网关】这次请求里没有名为 {name} 的工具。带的工具：{', '.join(sorted(n for n in tools if n)) or '（没有）'}"
                decision = f"文字（没有工具 {name}）"
            else:
                try:
                    tin = json.loads(tool.group(2)) if tool.group(2) else fill_schema(tools[name].get("input_schema"))
                except Exception as e:
                    tin = None
                    text = f"【实验网关】LAB-TOOL 后面的 JSON 解析不了：{e}"
                    decision = "文字（LAB-TOOL JSON 有误）"
                if tin is not None:
                    tool_use = ("toolu_lab" + uuid.uuid4().hex[:20], name, tin)
                    text = f"【实验网关】按指令调用 {name}。"
                    decision = f"tool_use {name}"
        else:
            ua = self.headers.get("User-Agent") or "-"
            text = (f"【实验网关】已收到。model={model}；stream={stream}；"
                    f"Origin={self.headers.get('Origin') or '无'}；UA={ua[:40]}")
            decision = "文字"
        if fault:
            nth = f"第 {fault['n']}/{fault['times']} 次" if fault["times"] else f"第 {fault['n']} 次"
            decision += f" + 故障 {fault['kind']}（{nth}）"
        self.record(raw, ("流式 " if stream else "非流式 ") + decision + (f" 静默{stall.group(2)}s{'无ping' if stall.group(1) else '有ping'}" if stall else ""), body)
        mid = "msg_lab" + uuid.uuid4().hex[:20]
        usage = {"input_tokens": 100, "output_tokens": 12, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
        stop_reason = "tool_use" if tool_use else "end_turn"
        if not stream:
            if fault and fault["kind"] == "sse-error":
                # 非流式没有「流中途」：按 529 回
                code, etype, msg = STATUS_FAULTS["529"]
                return self.send(code, {"type": "error", "error": {"type": etype, "message": msg}})
            if stall:
                time.sleep(int(stall.group(2)))
            content = [{"type": "text", "text": text}]
            if tool_use:
                content.append({"type": "tool_use", "id": tool_use[0], "name": tool_use[1], "input": tool_use[2]})
            resp = {"id": mid, "type": "message", "role": "assistant", "model": model, "content": content,
                    "stop_reason": stop_reason, "stop_sequence": None, "usage": usage}
            if fault and fault["kind"] == "cut":
                data = json.dumps(resp, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data[: len(data) // 2])
                return self.hang_up()
            return self.send(200, resp)
        # 流式：用 chunked 分块，静默期间可以边等边发 ping
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        for k, v in self.cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

        def chunk(b):
            self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b))
            self.wfile.flush()

        try:
            chunk(sse("message_start", {"type": "message_start", "message": {
                "id": mid, "type": "message", "role": "assistant", "model": model, "content": [],
                "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 1}}}))
            if stall:
                total, ping = int(stall.group(2)), not stall.group(1)
                waited = 0
                while waited < total:
                    step_s = min(15, total - waited)
                    time.sleep(step_s)
                    waited += step_s
                    if ping:
                        chunk(sse("ping", {"type": "ping"}))
            else:
                chunk(sse("ping", {"type": "ping"}))
            chunk(sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
            if fault:
                # 流中途出错：先发半句，再断开 / 给错误事件
                chunk(sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                  "delta": {"type": "text_delta", "text": "【实验网关】这句话只发了一半，"}}))
                time.sleep(1)
                if fault["kind"] == "cut":
                    print(f"     （按故障设置在流中途断开连接，model={model}）", flush=True)
                    return self.hang_up()
                chunk(sse("error", {"type": "error", "error": {"type": "overloaded_error", "message": "lab: Overloaded (mid-stream)"}}))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                return
            chunk(sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}))
            chunk(sse("content_block_stop", {"type": "content_block_stop", "index": 0}))
            if tool_use:
                chunk(sse("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {
                    "type": "tool_use", "id": tool_use[0], "name": tool_use[1], "input": {}}}))
                chunk(sse("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {
                    "type": "input_json_delta", "partial_json": json.dumps(tool_use[2], ensure_ascii=False)}}))
                chunk(sse("content_block_stop", {"type": "content_block_stop", "index": 1}))
            chunk(sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                                        "usage": {"output_tokens": 12}}))
            chunk(sse("message_stop", {"type": "message_stop"}))
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print(f"     （seq 之后：客户端在流中途断开，model={model}）", flush=True)

    # ---------- 假上游 ----------
    def up_error(self, code, err, extra=None):
        return self.send(code, {"error": err}, extra=extra)

    def up_fail(self, rec_kw, f, body=None):
        """假上游的状态码类故障：回 OpenAI 形状的错误体。"""
        code, err = UP_STATUS_FAULTS[f["kind"]]
        extra = {}
        if f["kind"] == "429" and f["retry_after"] >= 0:
            extra["retry-after"] = str(f["retry_after"])
        nth = f"第 {f['n']}/{f['times']} 次" if f["times"] else f"第 {f['n']} 次"
        self.record(rec_kw["raw"], f"故障 {code} {err.get('code') or err['type']}（{nth}）", body,
                    route=rec_kw["route"], auth=rec_kw["auth"])
        return self.up_error(code, err, extra)

    def upstream(self, raw, prefix, up):
        """假上游（OpenAI 兼容）：/openai*/[v1/]models、/openai*/[v1/]chat/completions。"""
        route = prefix + ("" if up == "/" else up)
        kw = {"raw": raw, "route": route, "auth": upstream_auth_kind(self.headers)}
        if self.command == "OPTIONS":
            self.record(raw, "204 CORS 预检", route=route, auth=kw["auth"])
            return self.send(204)
        is_models = self.command in ("GET", "HEAD") and up == "/models"
        is_chat = self.command == "POST" and up == "/chat/completions"
        if (is_models or is_chat) and self.headers.get("Authorization") != "Bearer " + UPSTREAM_KEY:
            self.record(raw, "401 假上游密钥不对", route=route, auth=kw["auth"])
            return self.up_error(401, {"message": "lab upstream: Incorrect API key provided", "type": "invalid_request_error",
                                       "param": None, "code": "invalid_api_key"})
        body = None
        user = ""
        if is_chat:
            try:
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("body 不是对象")
            except ValueError:
                self.record(raw, "400 不是 JSON", route=route, auth=kw["auth"])
                return self.up_error(400, {"message": "lab upstream: request body is not a JSON object", "type": "invalid_request_error"})
            user = last_user_text(body)
        fault = take_fault(self.command, route, user, upstream="chat" if is_chat else "other",
                           has_format=bool(body and body.get("response_format")))
        if fault and fault["kind"] in UP_STATUS_FAULTS:
            return self.up_fail(kw, fault, body)
        if is_models:
            self.record(raw, "200 models", route=route, auth=kw["auth"])
            return self.send(200, {"object": "list", "data": [
                {"id": m, "object": "model", "created": 0, "owned_by": "lab"} for m in UPSTREAM_MODELS]})
        if not is_chat:
            self.record(raw, f"404 未处理 {self.command} {route}", route=route, auth=kw["auth"])
            return self.up_error(404, {"message": f"lab upstream: unhandled {self.command} {route}", "type": "invalid_request_error",
                                       "code": "not_found"})
        return self.upstream_chat(raw, body, user, fault, kw)

    def upstream_chat(self, raw, body, user, fault, kw):
        model = body.get("model")
        stream = bool(body.get("stream"))
        text, calls, decision = plan_upstream_reply(body)
        stall = re.search(r"LAB-STALL-(?:NOPING-)?(\d{1,4})", user)
        think = re.search(r"LAB-THINK-(\d{1,4})", user)
        stall_s = int(stall.group(1)) if stall else 0
        think_s = int(think.group(1)) if think else 0
        if fault:
            nth = f"第 {fault['n']}/{fault['times']} 次" if fault["times"] else f"第 {fault['n']} 次"
            decision += f" + 故障 {fault['kind']}（{nth}）"
        suffix = (f" 静默{stall_s}s" if stall else "") + (f" 思考{think_s}s" if think else "")
        self.record(raw, ("流式 " if stream else "非流式 ") + decision + suffix, body, route=kw["route"], auth=kw["auth"])
        cid, created = "chatcmpl-lab" + uuid.uuid4().hex[:16], int(time.time())
        finish = "tool_calls" if calls else "stop"
        if not stream:
            if fault and fault["kind"] == "sse-error":
                # 非流式没有「流中途」：按 529 回
                return self.up_error(*UP_STATUS_FAULTS["529"])
            if stall_s or think_s:
                time.sleep(stall_s + think_s)
            msg = {"role": "assistant", "content": None if calls else text}
            if think_s:
                msg["reasoning_content"] = "思考中…"
            if calls:
                msg["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                                     for c in calls]
            resp = {"id": cid, "object": "chat.completion", "created": created, "model": model,
                    "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": UPSTREAM_USAGE}
            if fault and fault["kind"] == "cut":
                data = json.dumps(resp, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data[: len(data) // 2])
                return self.hang_up()
            return self.send(200, resp)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        for k, v in self.cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

        def chunk(b):
            self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b))
            self.wfile.flush()

        def data(obj):
            chunk(b"data: " + json.dumps(obj, ensure_ascii=False).encode() + b"\n\n")

        def delta(d, fin=None):
            data(chat_chunk(cid, model, created, d, fin))

        try:
            delta({"role": "assistant", "content": ""})
            if stall_s:
                time.sleep(stall_s)
            done = 0
            while done < think_s:
                delta({"reasoning_content": "思考中…"})
                step = min(5, think_s - done)
                time.sleep(step)
                done += step
            if fault:
                # 流中途出错：先发半句，再断开 / 给错误块
                delta({"content": UPSTREAM_HALF})
                time.sleep(0.5)
                if fault["kind"] == "cut":
                    print(f"     （按故障设置在流中途断开连接，model={model}）", flush=True)
                    return self.hang_up()
                data({"error": {"message": "lab upstream: overloaded (mid-stream)", "type": "server_error"}})
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                return
            if calls:
                # 交错发：先依次开每个调用（id、名字、空参数），再轮流发各自的参数片段
                for i, c in enumerate(calls):
                    delta({"tool_calls": [{"index": i, "id": c["id"], "type": "function",
                                           "function": {"name": c["name"], "arguments": ""}}]})
                pieces = [split_pieces(c["arguments"], 3) for c in calls]
                for r in range(max(len(x) for x in pieces)):
                    for i, ps in enumerate(pieces):
                        if r < len(ps):
                            delta({"tool_calls": [{"index": i, "function": {"arguments": ps[r]}}]})
            else:
                for piece in split_pieces(text, 3):
                    delta({"content": piece})
            delta({}, finish)
            data({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [], "usage": UPSTREAM_USAGE})
            chunk(b"data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print(f"     （客户端在流中途断开，model={model}）", flush=True)

    def hang_up(self):
        """不发结束块、直接关连接（模拟上游或路由在回答中途断掉）。"""
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def is_hop_header(name):
    n = name.lower()
    return n in HOP_BY_HOP or n.startswith("proxy-")


def body_summary(raw):
    """记录代理不存对话正文，只存要点。"""
    try:
        b = json.loads(raw)
    except ValueError:
        return {"body_len": len(raw)}
    if not isinstance(b, dict):
        return {"body_len": len(raw), "json_type": type(b).__name__}
    fmt = (b.get("output_config") or {}).get("format") if isinstance(b.get("output_config"), dict) else None
    return {"model": b.get("model"), "stream": b.get("stream"), "max_tokens": b.get("max_tokens"),
            "keys": sorted(b.keys()),
            "messages": len(b["messages"]) if isinstance(b.get("messages"), list) else None,
            "tools": len(b["tools"]) if isinstance(b.get("tools"), list) else None,
            "output_format": bool(fmt), "body_len": len(raw)}


class ProxyHandler(Handler):
    """记录代理：原样转发给 --target（响应边到边回给客户端），只记请求头与要点，不存对话正文。"""
    TEE = True

    def handle_any(self):
        t0 = time.time()
        raw = self.read_body()
        if self.path.split("?", 1)[0] == "/__lab/phase":
            return self.switch_phase()
        scheme, host, port = self.server.target
        route = self.path.split("?", 1)[0]
        extra = {"target": f"{scheme}://{host}:{port}"}
        if raw:
            extra["body_summary"] = body_summary(raw)
        conn = (http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection)(host, port, timeout=10)
        try:
            conn.connect()
            conn.sock.settimeout(3600)  # LAB-STALL 之类的长静默不能被代理掐掉
            conn.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", f"{host}:{port}")
            for k, v in self.headers.items():
                if k.lower() in ("host", "content-length", "expect") or is_hop_header(k):
                    continue
                conn.putheader(k, v)
            if raw or self.command in ("POST", "PUT", "PATCH"):
                conn.putheader("Content-Length", str(len(raw)))
            conn.endheaders(raw)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            conn.close()
            self.record(b"", f"502 目标连不上（{type(e).__name__}）", route=route, extra=extra, t=t0)
            return self.send(502, {"type": "error", "error": {"type": "api_error", "message": "lab tee: target unreachable"}})
        status, hdrs = resp.status, resp.getheaders()
        origin = resp.getheader("access-control-allow-origin")
        extra["resp_headers"] = [[k, mask_header(k, v, True)] for k, v in hdrs]
        self.record(b"", f"转发 → {status}" + (f"（allow-origin={origin}）" if origin else ""), route=route, extra=extra, t=t0)
        bodyless = self.command == "HEAD" or status in (204, 304) or 100 <= status < 200
        chunked = not bodyless and resp.getheader("content-length") is None
        try:
            self.send_response_only(status, resp.reason)
            for k, v in hdrs:
                if not is_hop_header(k):
                    self.send_header(k, v)
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while not bodyless:
                try:
                    piece = resp.read1(65536)
                except (OSError, http.client.HTTPException) as e:
                    # 目标在回答中途断了：也断开给客户端的连接，别假装正常结束
                    print(f"     （目标在响应中途断开：{type(e).__name__}，同样断开客户端连接）", flush=True)
                    return self.hang_up()
                if not piece:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(piece), piece) if chunked else piece)
                self.wfile.flush()
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print("     （客户端在响应中途断开）", flush=True)
        finally:
            conn.close()

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = handle_any


# ---------- 子命令 ----------
def init_out(out):
    """建输出目录；同一目录重复运行时编号接着排，不覆盖旧记录。"""
    STATE["out"] = os.path.abspath(os.path.expanduser(out))
    os.makedirs(STATE["out"], exist_ok=True)
    mx = 0
    for dp, _, fns in os.walk(STATE["out"]):
        for fn in fns:
            m = re.match(r"(\d{4})-", fn)
            if m:
                mx = max(mx, int(m.group(1)))
    STATE["seq"] = mx


def cmd_proxy(a):
    t = urllib.parse.urlsplit(a.target)
    if t.scheme not in ("http", "https") or not t.hostname:
        sys.exit(f"[中止] --target 要形如 http://127.0.0.1:端口，收到 {a.target!r}")
    port = t.port or (443 if t.scheme == "https" else 80)
    if t.hostname in ("127.0.0.1", "localhost", "::1") and port == a.listen:
        sys.exit("[中止] --target 指向代理自己的端口，会转发成死循环。")
    init_out(a.out)
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.listen), ProxyHandler)
    except OSError as e:
        sys.exit(f"[中止] 127.0.0.1:{a.listen} 监听失败（{e}）。端口被占用？换 --listen。")
    srv.daemon_threads = True
    srv.target = (t.scheme, t.hostname, port)
    print(f"==> 记录代理在 http://127.0.0.1:{a.listen} → {t.scheme}://{t.hostname}:{port}，记录写到 {STATE['out']}/<阶段>/。按 Ctrl-C 停止。", flush=True)
    print(f"    当前阶段 {STATE['phase']}；换阶段：python3 {os.path.abspath(__file__)} phase <名字> --port {a.listen}", flush=True)
    print(f"    汇总：python3 {os.path.abspath(__file__)} summary {STATE['out']}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n==> 已停止。", flush=True)


def cmd_serve(a):
    init_out(a.out)
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError as e:
        sys.exit(f"[中止] 127.0.0.1:{a.port} 监听失败（{e}）。端口被占用？换 --port，并让 write-profile.sh 用同一个端口。")
    srv.daemon_threads = True
    try:
        cur = set_fault(a.fault, a.fault_times, a.retry_after, a.fault_scope, a.fault_match or "")
    except ValueError as e:
        sys.exit(f"[中止] 故障参数不对：{e}")
    print(f"==> 抓包服务在 http://127.0.0.1:{a.port}，记录写到 {STATE['out']}/<阶段>/。按 Ctrl-C 停止。", flush=True)
    print(f"    假上游：http://127.0.0.1:{a.port}/openai/v1（密钥见 models.json 的 upstream.key）", flush=True)
    print(f"    当前阶段 {STATE['phase']}；换阶段：python3 {os.path.abspath(__file__)} phase <名字>", flush=True)
    print(f"    {describe_fault(cur)}；改：python3 {os.path.abspath(__file__)} fault <种类>", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n==> 已停止。", flush=True)


def cmd_phase(a):
    url = f"http://127.0.0.1:{a.port}/__lab/phase?name={urllib.parse.quote(a.name)}"
    print(f"==> 通知抓包服务进入阶段 {a.name}", flush=True)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="POST"), timeout=5) as r:
            print("    " + r.read().decode(), flush=True)
    except Exception as e:
        sys.exit(f"[中止] 连不上抓包服务（{e}）。它在另一个终端窗口里跑着吗？端口对吗？")


def cmd_fault(a):
    q = {"kind": a.kind}
    if a.kind != "status":
        q.update(times=a.times, retry_after=a.retry_after, scope=a.scope)
        if a.match:
            q["match"] = a.match
    url = f"http://127.0.0.1:{a.port}/__lab/fault?{urllib.parse.urlencode(q)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="POST"), timeout=5) as r:
            res = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"[中止] 抓包服务不接受：{e.read().decode(errors='replace')}")
    except Exception as e:
        sys.exit(f"[中止] 连不上抓包服务（{e}）。它在跑吗？端口对吗？")
    print(f"==> {res['text']}（当前阶段 {res['phase']}）", flush=True)


def load_records(d):
    recs = []
    for dp, _, fns in os.walk(d):
        for fn in sorted(fns):
            if re.match(r"\d{4}-.*\.json$", fn):
                try:
                    recs.append(json.load(open(os.path.join(dp, fn), encoding="utf-8")))
                except Exception:
                    pass
    return sorted(recs, key=lambda r: r.get("seq", 0))


def cmd_summary(a):
    d = os.path.abspath(os.path.expanduser(a.dir))
    recs = load_records(d)
    print(f"==> 汇总 {d}：共 {len(recs)} 个请求")
    groups = {}
    for r in recs:
        h = {k.lower(): v for k, v in r.get("headers", [])}
        ua = h.get("user-agent", "-")
        key = (r.get("phase"), r.get("method"), r.get("route"), ua[:80])
        g = groups.setdefault(key, {"n": 0, "names": set(), "origin": set(), "secfetch": set(), "auth": set(),
                                    "models": set(), "beta": set(), "xapp": set(), "referer": set(),
                                    "keys": set(), "thinking": set(), "max_tokens": set(), "output_config": set(),
                                    "decision": set()})
        g["n"] += 1
        g["names"].update(k for k, _ in r.get("headers", []))
        g["origin"].add(h.get("origin", "（无）"))
        g["referer"].add(h.get("referer", "（无）"))
        g["secfetch"].add(",".join(f"{k}={v}" for k, v in sorted(h.items()) if k.startswith("sec-fetch")) or "（无）")
        g["auth"].add(r.get("auth", "?"))
        g["xapp"].add(h.get("x-app", "（无）"))
        if h.get("anthropic-beta"):
            g["beta"].add(h["anthropic-beta"])
        g["decision"].add(str(r.get("decision")))
        b = r.get("body")
        bs = r.get("body_summary")
        if isinstance(bs, dict):  # 记录代理只存要点
            if bs.get("model"):
                g["models"].add(str(bs["model"]))
            g["keys"].update(bs.get("keys") or [])
            if bs.get("max_tokens") is not None:
                g["max_tokens"].add(json.dumps(bs["max_tokens"]))
            if bs.get("output_format"):
                g["output_config"].add("<有 output_config.format>")
        if isinstance(b, dict) and b.get("model"):
            g["models"].add(str(b["model"]))
        if isinstance(b, dict):
            g["keys"].update(b.keys())
            for k in ("thinking", "max_tokens", "output_config"):
                if k in b:
                    v = b[k]
                    if k == "output_config" and isinstance(v, dict) and isinstance(v.get("format"), dict):
                        v = dict(v, format=f"<{v['format'].get('type')}>")
                    g[k].add(json.dumps(v, ensure_ascii=False, sort_keys=True))
    any_origin = False
    for (phase, method, route, ua), g in groups.items():
        print(f"\n[{phase}] {method} {route} × {g['n']}")
        print(f"  User-Agent: {ua}")
        print(f"  Origin: {sorted(g['origin'])}   Referer: {sorted(g['referer'])}")
        print(f"  Sec-Fetch-*: {sorted(g['secfetch'])}")
        print(f"  鉴权: {sorted(g['auth'])}   x-app: {sorted(g['xapp'])}")
        if g["models"]:
            print(f"  model: {sorted(g['models'])}")
        if g["beta"]:
            print(f"  anthropic-beta: {sorted(g['beta'])}")
        for k in ("thinking", "max_tokens", "output_config"):
            if g[k]:
                print(f"  {k}: {sorted(g[k])}")
        if g["keys"]:
            print(f"  请求体顶层键: {sorted(g['keys'])}")
        print(f"  抓包服务的处理: {sorted(g['decision'])}")
        print(f"  请求头名: {sorted(g['names'], key=str.lower)}")
        any_origin |= any(o != "（无）" for o in g["origin"])
    print(f"\n==> 是否有请求带 Origin：{'有' if any_origin else '没有'}")


def cmd_timeline(a):
    d = os.path.abspath(os.path.expanduser(a.dir))
    recs = [r for r in load_records(d) if not a.phase or r.get("phase") == a.phase]
    print(f"==> 时间线 {d}{'（阶段 ' + a.phase + '）' if a.phase else ''}：共 {len(recs)} 个请求；间隔＝与同一阶段上一个请求相隔多久")
    prev = {}
    for r in recs:
        h = {k.lower(): v for k, v in r.get("headers", [])}
        t = r.get("t")
        ph = r.get("phase")
        gap = f"+{t - prev[ph]:7.2f}s" if t is not None and prev.get(ph) is not None else "      —  "
        if t is not None:
            prev[ph] = t
        when = hms_ms(t) if t is not None else (r.get("time") or "")[11:]
        b = r.get("body") if isinstance(r.get("body"), dict) else (r.get("body_summary") or {})
        print(f"{r.get('seq', 0):04d} {when} {gap} [{ph}] {r.get('method')} {r.get('route')} model={b.get('model')} "
              f"retry-count={h.get('x-stainless-retry-count', '-')} ua={h.get('user-agent', '-')[:30]!r} -> {r.get('decision')}")


def cmd_redact(a):
    src = os.path.abspath(os.path.expanduser(a.src))
    dst = os.path.abspath(os.path.expanduser(a.dst))
    home = os.path.expanduser("~")
    user = os.path.basename(home)
    n = 0
    for dp, _, fns in os.walk(src):
        for fn in fns:
            s = os.path.join(dp, fn)
            t = os.path.join(dst, os.path.relpath(s, src))
            os.makedirs(os.path.dirname(t), exist_ok=True)
            text = open(s, encoding="utf-8", errors="replace").read()
            if fn.endswith(".json") and a.strip_bodies:
                try:
                    r = json.loads(text)
                    b = r.get("body")
                    if isinstance(b, dict):
                        for k in ("messages", "system"):
                            if k in b:
                                b[k] = f"<已去掉，原长 {len(json.dumps(b[k], ensure_ascii=False))} 字符>"
                        if isinstance(b.get("tools"), list):
                            b["tools"] = [x.get("name") if isinstance(x, dict) else x for x in b["tools"]]
                    text = json.dumps(r, ensure_ascii=False, indent=2)
                except Exception:
                    pass
            text = text.replace(home, "~").replace(user, "<user>")
            with open(t, "w", encoding="utf-8") as f:
                f.write(text)
            n += 1
    print(f"==> 已脱敏 {n} 个文件 → {dst}（家目录换成 ~，用户名换成 <user>{'，对话正文与系统提示已去掉' if a.strip_bodies else ''}）")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0].startswith("-"):
        argv = ["serve"] + argv
    ap = argparse.ArgumentParser(description="桌面应用 3P 实验抓包服务")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=DEFAULT_PORT)
    s.add_argument("--out", default=DEFAULT_OUT)
    s.add_argument("--fault", default="off", choices=FAULT_KINDS)
    s.add_argument("--fault-times", type=int, default=0)
    s.add_argument("--retry-after", type=int, default=20)
    s.add_argument("--fault-scope", default="messages", choices=FAULT_SCOPES)
    s.add_argument("--fault-match", default="")
    f = sub.add_parser("fault")
    f.add_argument("kind", choices=FAULT_KINDS + ("status",))
    f.add_argument("--times", type=int, default=0)
    f.add_argument("--retry-after", type=int, default=20)
    f.add_argument("--scope", default="messages", choices=FAULT_SCOPES)
    f.add_argument("--match", default="")
    f.add_argument("--port", type=int, default=DEFAULT_PORT)
    x = sub.add_parser("proxy")
    x.add_argument("--listen", type=int, required=True)
    x.add_argument("--target", required=True)
    x.add_argument("--out", default=DEFAULT_TEE_OUT)
    p = sub.add_parser("phase")
    p.add_argument("name")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    m = sub.add_parser("summary")
    m.add_argument("dir", nargs="?", default=DEFAULT_OUT)
    t = sub.add_parser("timeline")
    t.add_argument("dir", nargs="?", default=DEFAULT_OUT)
    t.add_argument("--phase", default="")
    r = sub.add_parser("redact")
    r.add_argument("src")
    r.add_argument("dst")
    r.add_argument("--strip-bodies", action="store_true")
    a = ap.parse_args(argv)
    {"serve": cmd_serve, "proxy": cmd_proxy, "phase": cmd_phase, "fault": cmd_fault, "summary": cmd_summary,
     "timeline": cmd_timeline, "redact": cmd_redact}[a.cmd](a)


if __name__ == "__main__":
    main()

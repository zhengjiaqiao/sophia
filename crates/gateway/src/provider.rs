//! 拉取第三方模型网关的模型列表，以及勾选前对单个模型的试调（[`probe_model`]）。
//!
//! 拉取移植自 agents-manager 的 `internal/provider`（同一作者的 Go 项目，已在真实环境验证），
//! 依赖注入的 [`reqwest::Client`] 换成了异步版本。
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use sophia_core::codex_models::catalog::Model;
use sophia_core::codex_models::settings::UnreachableReason;

use crate::router::{parse_provider_base, resolve_target, send_with_connect_retry, Protocol};
use crate::translate::anthropic::retry_after_seconds;

/// [`FetchError`] 的分类：鉴权失败、连不上（分得出原因的各一类）、上游限流 / 出错、响应不是模型列表
/// （spec 2026-10-04-local-diagnostics R9）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchErrorKind {
    Auth,
    /// 连不上，分不出更细的原因（读到一半断了、别的连接错误）
    Network,
    Unexpected,
    /// 域名解析不了
    Dns,
    /// 连接被拒（端口上没人听）
    Refused,
    /// 连接或等回应超时
    Timeout,
    /// 证书 / TLS 握手出错
    Tls,
    /// 走系统代理时连不上
    Proxy,
    /// 429；上游说的多少秒后再试
    RateLimited(Option<u64>),
    /// 5xx
    Server(u16),
}

impl FetchErrorKind {
    /// 记在那一家网关上的原因种类，界面在那一行显示「无法连接」时按当前语言取句说明为什么
    pub fn unreachable(self) -> UnreachableReason {
        match self {
            FetchErrorKind::Auth => UnreachableReason::Auth,
            FetchErrorKind::Network => UnreachableReason::Network,
            FetchErrorKind::Unexpected => UnreachableReason::Unexpected,
            FetchErrorKind::Dns => UnreachableReason::Dns,
            FetchErrorKind::Refused => UnreachableReason::Refused,
            FetchErrorKind::Timeout => UnreachableReason::Timeout,
            FetchErrorKind::Tls => UnreachableReason::Tls,
            FetchErrorKind::Proxy => UnreachableReason::Proxy,
            FetchErrorKind::RateLimited(seconds) => UnreachableReason::RateLimited(seconds),
            FetchErrorKind::Server(code) => UnreachableReason::Server(code),
        }
    }

    /// 收到了状态码才有的种类（鉴权、限流、5xx、不是模型列表）；超时、连不上之类没有
    fn has_status(self) -> bool {
        matches!(
            self,
            FetchErrorKind::Auth
                | FetchErrorKind::Unexpected
                | FetchErrorKind::RateLimited(_)
                | FetchErrorKind::Server(_)
        )
    }

    /// 换一条路径（`/v1/models`）也不会好的：密钥不对、连不上、被限流。5xx 与「不是模型列表」接着试
    fn final_for_this_address(self) -> bool {
        !matches!(self, FetchErrorKind::Unexpected | FetchErrorKind::Server(_))
    }
}

/// 拉取模型列表失败。错误信息与详情里从不出现密钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub kind: FetchErrorKind,
    pub message: String,
    /// 技术原文（R13）：`GET <地址> → 429 Too Many Requests · Retry-After: 30` 换行接返回体开头，
    /// 或 `GET <地址> → <连接错误的原文>`；抹掉密钥、去掉隐私
    pub detail: String,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for FetchError {}

/// 详情里带多少个字符的返回体
const DETAIL_BODY_CHARS: usize = 300;

/// 一次请求没发成（`send` 失败）是哪一种（R9）：`is_timeout` 是超时；`is_connect` 时看源错误链——
/// 解析不了域名、连接被拒、TLS 握手 / 证书出错。`proxied`：这个地址按系统设置走代理，连接这一步
/// 失败（连的其实是代理）就说是代理的事
pub fn classify_send_error(error: &reqwest::Error, proxied: bool) -> FetchErrorKind {
    if error.is_timeout() {
        return FetchErrorKind::Timeout;
    }
    let mut tls = false;
    let mut refused = false;
    let mut dns = false;
    let mut timed_out = false;
    for_each_cause(error, &mut |cause| {
        if cause.downcast_ref::<rustls::Error>().is_some() {
            tls = true;
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => refused = true,
                std::io::ErrorKind::TimedOut => timed_out = true,
                _ => {}
            }
        }
        // hyper-util 的解析失败没有公开的类型，只能认它的原话（`dns error: failed to lookup address
        // information: nodename nor servname provided, or not known`）
        let text = cause.to_string().to_ascii_lowercase();
        if text.starts_with("dns error") || text.contains("failed to lookup address") {
            dns = true;
        }
    });
    if tls {
        return FetchErrorKind::Tls;
    }
    if !error.is_connect() {
        return if timed_out {
            FetchErrorKind::Timeout
        } else {
            FetchErrorKind::Network
        };
    }
    if proxied {
        return FetchErrorKind::Proxy;
    }
    if dns {
        FetchErrorKind::Dns
    } else if refused {
        FetchErrorKind::Refused
    } else if timed_out {
        FetchErrorKind::Timeout
    } else {
        FetchErrorKind::Network
    }
}

/// 源错误链上的每一环。`io::Error` 的 `source()` 会跳过它包着的那个错误（rustls 的握手错误就包在里面，
/// 还可能套两层 io::Error：`Other(InvalidData(rustls::Error))`），所以遇到 `io::Error` 时顺着它包着的往下走
fn for_each_cause(
    error: &(dyn std::error::Error + 'static),
    visit: &mut impl FnMut(&(dyn std::error::Error + 'static)),
) {
    visit(error);
    match error
        .downcast_ref::<std::io::Error>()
        .and_then(|io| io.get_ref())
    {
        Some(inner) => for_each_cause(inner, visit),
        None => {
            if let Some(next) = error.source() {
                for_each_cause(next, visit);
            }
        }
    }
}

/// 连接错误的原文：整条源错误链用 `: ` 接起来（reqwest 自己的那一环只说「发请求出错」，带着地址，跳过）
fn send_error_text(error: &reqwest::Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    for_each_cause(error, &mut |cause| {
        let text = cause.to_string();
        if !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
    });
    if parts.len() > 1 {
        parts.remove(0);
    }
    parts.join(": ")
}

/// 详情去掉密钥与隐私（地址的查询参数、家目录、长得像密钥的串）
fn detail_text(text: &str, key: &str) -> String {
    sophia_core::redact::redact(&scrub(text, key))
}

/// 发不出去时的详情：`GET <地址> → <原文>`（`method`：拉模型 GET、试调 POST）
fn send_detail(method: &str, url: &str, error: &reqwest::Error, key: &str) -> String {
    detail_text(&format!("{method} {url} → {}", send_error_text(error)), key)
}

/// 非 200 时返回体最多读这么多字节、等这么久：种类已经由状态码定了，返回体只给详情用，
/// 不能让一个不结束或很大的返回体拖住（Codex 复审 3/7）
const ERROR_BODY_CAP: usize = 64 * 1024;
const ERROR_BODY_WAIT: Duration = Duration::from_secs(2);

/// 读返回体的开头：到上限、读完、读断或到时间都停，交回已读到的
async fn body_head(mut resp: reqwest::Response) -> Vec<u8> {
    let deadline = tokio::time::Instant::now() + ERROR_BODY_WAIT;
    let mut body = Vec::new();
    while body.len() < ERROR_BODY_CAP {
        match tokio::time::timeout_at(deadline, resp.chunk()).await {
            Ok(Ok(Some(chunk))) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }
    body.truncate(ERROR_BODY_CAP);
    body
}

/// 返回体给详情看的样子：是 JSON 就解开再写回（`\/`、`\u…` 这类转义还原，转义过的密钥才认得出），
/// 不是就原样；之后才抹密钥、去隐私，**最后**才截到 [`DETAIL_BODY_CHARS`]（先截会把跨在边界上的密钥留下一截）
fn body_detail(body: &[u8], key: &str) -> String {
    let clean = clean_upstream_text(&String::from_utf8_lossy(body), key);
    let mut chars = clean.chars();
    let head: String = chars.by_ref().take(DETAIL_BODY_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// 上游给的文字（返回体、错误说明）给人看之前一律走这一道：抹密钥 → 按字面还原 JSON 转义 → 再抹密钥 → 去隐私。
/// 还原前先抹：密钥本身含 `\t` 这样的两个字符时，还原后就认不出了（第 3 轮 b）；还原后再抹：转义过的密钥（`\u0073k-…`、
/// `\/`）还原后才认得出。不靠 JSON 解析：返回体被截短时解不开（第 2 轮 2）。截短由调用方在这之后做
fn clean_upstream_text(text: &str, key: &str) -> String {
    detail_text(unescape_json_text(&scrub(text, key)).trim(), key)
}

/// 把文本里 JSON 字符串的转义按字面还原（`\uXXXX`（含代理对）、`\/`、`\"`、`\\`、`\n` 等）；
/// 认不出的转义原样留着。返回体是不是完整的 JSON 都行
fn unescape_json_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let hex4 = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| -> Option<u32> {
        let digits: String = chars.clone().take(4).collect();
        if digits.len() == 4 && digits.chars().all(|c| c.is_ascii_hexdigit()) {
            for _ in 0..4 {
                chars.next();
            }
            u32::from_str_radix(&digits, 16).ok()
        } else {
            None
        }
    };
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some(e @ ('"' | '\\' | '/')) => {
                chars.next();
                out.push(e);
            }
            Some('n') => {
                chars.next();
                out.push('\n');
            }
            Some('t') => {
                chars.next();
                out.push('\t');
            }
            Some('r') => {
                chars.next();
                out.push('\r');
            }
            Some('b' | 'f') => {
                chars.next();
            }
            Some('u') => {
                chars.next();
                match hex4(&mut chars) {
                    Some(high @ 0xD800..=0xDBFF) => {
                        let low = (chars.peek() == Some(&'\\'))
                            .then(|| {
                                let mut ahead = chars.clone();
                                ahead.next();
                                (ahead.next() == Some('u')).then_some(ahead)
                            })
                            .flatten()
                            .and_then(|mut ahead| {
                                let low = hex4(&mut ahead)?;
                                (0xDC00..=0xDFFF).contains(&low).then_some((low, ahead))
                            });
                        match low {
                            Some((low, ahead)) => {
                                chars = ahead;
                                let code = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                                out.extend(char::from_u32(code));
                            }
                            None => out.push('\u{FFFD}'),
                        }
                    }
                    Some(code) => out.push(char::from_u32(code).unwrap_or('\u{FFFD}')),
                    None => out.push_str("\\u"),
                }
            }
            _ => out.push('\\'),
        }
    }
    out
}

/// 收到非 200 时的详情：`GET <地址> → 429 Too Many Requests · Retry-After: 30`，换行接返回体开头
fn status_detail(
    method: &str,
    url: &str,
    status: reqwest::StatusCode,
    retry_after: Option<&str>,
    body: &[u8],
    key: &str,
) -> String {
    let mut line = format!(
        "{method} {url} → {} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or_default()
    );
    if let Some(value) = retry_after {
        line.push_str(&format!(" · Retry-After: {value}"));
    }
    let mut detail = detail_text(&line, key);
    let body = body_detail(body, key);
    if !body.is_empty() {
        detail.push('\n');
        detail.push_str(&body);
    }
    detail
}

/// 发不出去的那一种的一句话（当前语言）：就是记在那一行上的原因
fn send_failure(url: &str, error: &reqwest::Error, key: &str, proxied: bool) -> FetchError {
    let kind = classify_send_error(error, proxied);
    FetchError {
        kind,
        message: kind.unreachable().text(),
        detail: send_detail("GET", url, error, key),
    }
}

/// 拉取模型列表成功的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResult {
    /// 网关返回的模型，按返回顺序：只填 `id` 与（网关给了的话）`context_window`
    pub models: Vec<Model>,
    /// 实际可用的接口基址：模型列表在 `{base}/models` 就是 base，在 `{base}/v1/models`
    /// 就是 `base/v1`。路由把 Codex 的 `/responses` 等路径接在它后面。
    pub api_base: String,
}

/// 推荐的 [`reqwest::ClientBuilder`] 默认值：不跟随重定向，因为请求里带着密钥，
/// 不能被带到别的地址（包括同主机的明文 http）。reqwest 的重定向策略只能在建 Client
/// 时设定，调用方必须用这个（或等价配置）建出传给 [`fetch_models`] 的 client。
pub fn client_builder_defaults() -> reqwest::ClientBuilder {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
}

#[derive(Debug, Deserialize)]
struct Item {
    id: Option<String>,
    /// 其余字段：从里面找上下文长度
    #[serde(flatten)]
    rest: serde_json::Map<String, Value>,
}

/// 各家网关在 `/models` 每一项里写上下文长度的字段，按这个顺序取第一个正整数：
/// OpenRouter 是 `context_length`（它的 `top_provider.context_length` 是实际服务方的上限，放在后面兜底），
/// vLLM 是 `max_model_len`，还有的网关写 `context_window` / `max_context_length`。
/// `max_input_tokens` 是 Anthropic `/v1/models` 的写法，严格说是输入上限而不是总长，但对 Codex 目录的
/// `context_window`（按它估算何时压缩上下文）足够接近，而且比 128000 的缺省值准，所以也认，排在最后
const CONTEXT_FIELDS: [&[&str]; 6] = [
    &["context_length"],
    &["context_window"],
    &["max_context_length"],
    &["max_model_len"],
    &["top_provider", "context_length"],
    &["max_input_tokens"],
];

/// 一项里的上下文长度：见 [`CONTEXT_FIELDS`]。只认正整数（`131072.0` 这种整数值的小数也算），
/// 字符串、零、负数、超出 u32 的都当没有
fn context_window_of(rest: &serde_json::Map<String, Value>) -> Option<u32> {
    CONTEXT_FIELDS.iter().find_map(|path| {
        let (first, tail) = path.split_first()?;
        let value = tail
            .iter()
            .try_fold(rest.get(*first)?, |value, key| value.get(*key))?;
        let number = value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|f| f.is_finite() && f.fract() == 0.0 && *f > 0.0 && *f <= u32::MAX as f64)
                .map(|f| f as u64)
        })?;
        u32::try_from(number).ok().filter(|n| *n > 0)
    })
}

#[derive(Debug, Deserialize)]
struct Wrapped {
    data: Option<Vec<Item>>,
}

fn unexpected(message: String) -> FetchError {
    FetchError {
        kind: FetchErrorKind::Unexpected,
        message,
        detail: String::new(),
    }
}

fn parse_items(body: &[u8]) -> Result<Vec<Item>, FetchError> {
    if let Ok(wrapped) = serde_json::from_slice::<Wrapped>(body) {
        if let Some(data) = wrapped.data {
            return Ok(data);
        }
    }
    serde_json::from_slice::<Vec<Item>>(body)
        .map_err(|_| unexpected(sophia_core::t!("models.fetch.notModelList")))
}

/// 在 `deadline` 之前没等到（响应头或模型列表）：超时
fn timed_out(method: &str, url: &str, key: &str, budget: Duration) -> FetchError {
    FetchError {
        kind: FetchErrorKind::Timeout,
        message: FetchErrorKind::Timeout.unreachable().text(),
        detail: detail_text(
            &format!(
                "{method} {url} → no response within {} s",
                budget.as_secs_f32()
            ),
            key,
        ),
    }
}

/// 期限 `deadline` 只管到响应头（第 2 轮 3）：收到非 200 的响应头就定了种类，返回体另按自己的量与时间读，
/// 不会因为它不结束被拖成超时；200 的模型列表仍须在期限内读完
async fn fetch_models_at(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    proxied: bool,
    deadline: tokio::time::Instant,
    budget: Duration,
) -> Result<Vec<Model>, FetchError> {
    let request = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .send();
    let resp = tokio::time::timeout_at(deadline, request)
        .await
        .map_err(|_| timed_out("GET", url, key, budget))?
        .map_err(|e| send_failure(url, &e, key, proxied))?;

    let status = resp.status();
    if status.as_u16() != 200 {
        let header = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let retry_after = header("retry-after");
        let retry_after_ms = header("retry-after-ms");
        // 种类只看状态码与响应头；返回体只读一小段给详情（读不到就是空的，详情里只剩状态行）
        let code = status.as_u16();
        let (kind, message) = match code {
            401 | 403 => (
                FetchErrorKind::Auth,
                sophia_core::t!("models.fetch.keyRejected", status = code),
            ),
            429 => {
                let kind = FetchErrorKind::RateLimited(retry_after_seconds(
                    retry_after.as_deref(),
                    retry_after_ms.as_deref(),
                    std::time::SystemTime::now(),
                ));
                (kind, kind.unreachable().text())
            }
            500..=599 => {
                let kind = FetchErrorKind::Server(code);
                (kind, kind.unreachable().text())
            }
            _ => (
                FetchErrorKind::Unexpected,
                sophia_core::t!("models.fetch.badStatus", status = code),
            ),
        };
        let body = body_head(resp).await;
        let detail = status_detail("GET", url, status, retry_after.as_deref(), &body, key);
        return Err(FetchError {
            kind,
            message,
            detail,
        });
    }

    let body = tokio::time::timeout_at(deadline, resp.bytes())
        .await
        .map_err(|_| timed_out("GET", url, key, budget))?
        .map_err(|e| FetchError {
            kind: FetchErrorKind::Network,
            message: sophia_core::t!("models.fetch.readFailed"),
            detail: send_detail("GET", url, &e, key),
        })?;

    let with_detail = |mut error: FetchError| {
        error.detail = status_detail("GET", url, status, None, &body, key);
        error
    };
    let items = parse_items(&body).map_err(with_detail)?;
    let models: Vec<Model> = items
        .into_iter()
        .filter_map(|item| {
            let id = item.id?.trim().to_string();
            (!id.is_empty()).then(|| Model {
                id,
                context_window: context_window_of(&item.rest),
                ..Model::default()
            })
        })
        .collect();
    if models.is_empty() {
        return Err(with_detail(unexpected(sophia_core::t!(
            "models.fetch.emptyList"
        ))));
    }
    Ok(models)
}

async fn fetch_models_inner(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    proxied: bool,
    budget: Duration,
) -> Result<FetchResult, FetchError> {
    let deadline = tokio::time::Instant::now() + budget;
    let base = base_url.trim().trim_end_matches('/').to_string();
    let mut last_err: Option<FetchError> = None;
    for api_base in [base.clone(), format!("{base}/v1")] {
        let url = format!("{api_base}/models");
        match fetch_models_at(client, &url, key, proxied, deadline, budget).await {
            Ok(models) => return Ok(FetchResult { models, api_base }),
            Err(e) => {
                // 第一条路径已经收到了状态码（5xx / 不是模型列表），第二条路径却没收到（超时、连不上）：
                // 报已经定下的那个，不让后来的超时盖掉（第 3 轮 d）
                if let Some(prev) = last_err.take() {
                    if !e.kind.has_status() {
                        return Err(prev);
                    }
                    last_err = Some(prev);
                }
                if e.kind.final_for_this_address() {
                    // 鉴权失败、连不上、被限流，换路径也不会好。
                    return Err(e);
                }
                // 两条路径都没拿到：一条是 5xx 就报它（网关在出错），比「不是模型列表」更接近真相
                let keep_previous = matches!(
                    (&last_err, e.kind),
                    (Some(prev), FetchErrorKind::Unexpected)
                        if matches!(prev.kind, FetchErrorKind::Server(_))
                );
                if !keep_previous {
                    last_err = Some(e);
                }
            }
        }
    }
    Err(last_err.expect("至少尝试过一个 api_base"))
}

/// 拉取网关的模型列表，总耗时不超过 `timeout`。先尝试 `{base}/models`，
/// 不成（且不是鉴权/网络错误）再退到 `{base}/v1/models`。接受 `{data:[{id}]}`
/// 或裸数组两种响应形状。错误信息里不会出现密钥。`proxied`：这个地址按系统设置走代理
/// （连不上时据此说是代理的事，见 [`classify_send_error`]）
pub async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    timeout: Duration,
    proxied: bool,
) -> Result<FetchResult, FetchError> {
    fetch_models_inner(client, base_url, key, proxied, timeout).await
}

// ----- 勾选前试调一个模型 -----

/// 试调时的输出上限。Responses 上游要求 `max_output_tokens` ≥ 16（桌面应用发 1 时被拒过，
/// 见 `translate::anthropic::responses_request`），Chat 那边也用同一个数
pub const PROBE_MAX_TOKENS: u32 = 16;
/// 界面等一次试调的上限
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// 失败原因里最多带多少个字符的上游原文
const PROBE_DETAIL_CHARS: usize = 120;

/// [`ProbeError`] 的分类，决定命令错误串的代码（见 docs/gateway-commands.md）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeErrorKind {
    /// 存着的地址不能用来发请求（不是 https、带用户名密码…）
    Invalid,
    /// 上游答了 401 / 403
    Auth,
    /// 连不上、超时
    Network,
    /// 上游答了别的非 2xx
    Upstream,
}

/// 试调失败。`message` 是给用户看的一句话，从不含密钥
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeError {
    pub kind: ProbeErrorKind,
    pub message: String,
    /// 技术原文（请求、状态码、返回体开头；抹掉密钥、去隐私），进日志与命令错误的 `[detail]`（R13）；
    /// 勾选行下的那句只写 `message`
    pub detail: String,
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProbeError {}

/// 向网关真发一次最小的请求，看这个模型调不调得通：`/models` 只列名字，列出来的不一定能用
/// （实测某网关列着 `weibo/glm-5`，一调就 404）。
///
/// - 地址与协议同路由：`api_base` 是路由清单里的那个（`ProviderSettings::upstream_base`），
///   同样只接受 https（回环除外）、不带用户名密码；Chat 发 `{api_base}/chat/completions`，Responses 发 `{api_base}/responses`
/// - 请求体：一条用户消息 `ping`，输出上限 [`PROBE_MAX_TOKENS`]，**流式**；`Authorization: Bearer <key>`，同路由
/// - 2xx 之后只读到第一个事件就下结论、断开（[`first_event_error`]）：不流式时网关要等整段回复生成完才回，
///   会思考的模型一次要七八秒（2026-09-30 真机：kimi-k2.5 7.3 秒）；第一个事件是报错也算不通——
///   有的网关先回 200 再在流里报错
/// - 另见 [`rejects_only_probe_parameters`]：只是不接受我们随手填的参数的 400/422 也算通
/// - `client` 必须不跟随重定向（[`client_builder_defaults`]）：请求里带着密钥
pub async fn probe_model(
    client: &reqwest::Client,
    api_base: &str,
    protocol: Protocol,
    model: &str,
    key: &str,
    timeout: Duration,
    proxied: bool,
) -> Result<(), ProbeError> {
    let base = parse_provider_base(api_base).map_err(|e| ProbeError {
        kind: ProbeErrorKind::Invalid,
        message: sophia_core::t!("models.probe.badUrl", error = e),
        detail: String::new(),
    })?;
    let (suffix, body) = match protocol {
        Protocol::Chat => (
            "/chat/completions",
            serde_json::json!({
                "model": model,
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": PROBE_MAX_TOKENS,
                "stream": true,
            }),
        ),
        Protocol::Responses => (
            "/responses",
            serde_json::json!({
                "model": model,
                "input": "ping",
                "max_output_tokens": PROBE_MAX_TOKENS,
                "stream": true,
            }),
        ),
    };
    let url = resolve_target(&base, suffix, "");
    let request = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .body(body.to_string());
    // 期限只管到响应头、以及 2xx 之后的第一个事件；非 2xx 收到响应头就定了种类（第 2 轮 3）
    let deadline = tokio::time::Instant::now() + timeout;
    let timed_out = || ProbeError {
        kind: ProbeErrorKind::Network,
        message: sophia_core::t!("models.probe.timeout", seconds = timeout.as_secs()),
        detail: detail_text(
            &format!("POST {url} → no response within {} s", timeout.as_secs()),
            key,
        ),
    };
    {
        // 连不上的原因与拉模型同一套分类（R9），只说原因
        let response = tokio::time::timeout_at(deadline, send_with_connect_retry(request))
            .await
            .map_err(|_| timed_out())?
            .map_err(|e| ProbeError {
                kind: ProbeErrorKind::Network,
                message: classify_send_error(&e, proxied).unreachable().text(),
                detail: send_detail("POST", &url, &e, key),
            })?;
        let status = response.status();
        if status.is_success() {
            return tokio::time::timeout_at(deadline, first_event_error(response, key))
                .await
                .map_err(|_| timed_out())?
                .map_or(Ok(()), |detail| {
                    Err(ProbeError {
                        kind: ProbeErrorKind::Upstream,
                        message: sophia_core::t!("models.probe.failed", detail = detail),
                        detail: detail_text(&format!("POST {url} → {status}\n{detail}"), key),
                    })
                });
        }
        // 返回体限量限时读（读不到就是空的）：判断是不是参数问题、限流要看它
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = body_head(response).await;
        let error = UpstreamError::parse(&body, key);
        // 额度用完的说法也在原文里找：返回体截短后 JSON 解不开时，`message` 里只剩开头（第 2 轮 新增）
        let raw = unescape_json_text(&String::from_utf8_lossy(&body)).to_lowercase();
        let quota = quota_exhausted(&error, &raw);
        // 限流（含 429）算调得通：模型在、密钥对，只是这会儿请求太密（spec 2026-10-04-local-diagnostics R9 注）
        if rejects_only_probe_parameters(status.as_u16(), &error)
            || (!quota && rate_limited(status.as_u16(), &error))
        {
            return Ok(());
        }
        let code = status.as_u16();
        let detail = status_detail("POST", &url, status, retry_after.as_deref(), &body, key);
        // 说人话：密钥被拒、服务商出问题各一句；别的 4xx 上游那句（哪个模型 / 参数不对）就是原因
        let (kind, message) = match code {
            401 | 403 => (
                ProbeErrorKind::Auth,
                sophia_core::t!("models.fetch.keyRejected", status = code),
            ),
            _ if quota => (
                ProbeErrorKind::Upstream,
                sophia_core::t!("models.probe.quota", code = code),
            ),
            500..=599 => (
                ProbeErrorKind::Upstream,
                FetchErrorKind::Server(code).unreachable().text(),
            ),
            _ => (
                ProbeErrorKind::Upstream,
                match error
                    .message
                    .or_else(|| status.canonical_reason().map(str::to_owned))
                {
                    Some(said) => {
                        sophia_core::t!("models.probe.failedStatus", code = code, detail = said)
                    }
                    None => sophia_core::t!("models.probe.failedCode", code = code),
                },
            ),
        };
        Err(ProbeError {
            kind,
            message,
            detail,
        })
    }
}

/// 2xx 之后读到第一个事件（SSE 的第一条 `data:`；网关不理 `stream`、直接回整段 JSON 时就是那段 JSON）：
/// 它是报错（带 `error`，或 Responses 的 `error` / `response.failed` 事件）就返回原因，否则 None。
/// 读到就返回、丢掉响应（断开连接），不等后面的内容；流一个字没给就结束也算通
async fn first_event_error(mut response: reqwest::Response, key: &str) -> Option<String> {
    /// 第一个事件最多读这么多字节就下结论
    const LIMIT: usize = 16 * 1024;
    let mut buffer: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        buffer.extend_from_slice(&chunk);
        let text = String::from_utf8_lossy(&buffer);
        if let Some(payload) = first_sse_data(&text) {
            return event_error(payload.as_bytes(), key);
        }
        if buffer.len() >= LIMIT {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let payload = first_sse_data(&text).unwrap_or_else(|| text.trim().to_owned());
    event_error(payload.as_bytes(), key)
}

/// SSE 文本里第一条完整的 `data:` 行（到换行为止）的内容；还没有完整的一行为 None
fn first_sse_data(text: &str) -> Option<String> {
    // 只认行首的 `data:`：正文是一整段 JSON 时，字符串里的 `data:` 不算事件
    let mut lines = text.split_inclusive('\n');
    lines.find_map(|line| {
        let rest = line.strip_prefix("data:")?;
        rest.ends_with('\n').then(|| rest.trim().to_owned())
    })
}

/// 一个事件（或整段 JSON）是不是报错；是就返回原因（抹掉密钥、截短），`[DONE]`、空、不是 JSON 都不算报错
fn event_error(payload: &[u8], key: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(payload).ok()?;
    let failed = value.get("error").is_some_and(|e| !e.is_null())
        || matches!(
            value.get("type").and_then(Value::as_str),
            Some("error" | "response.failed")
        );
    if !failed {
        return None;
    }
    // Responses 的 response.failed：原因在 response.error 里
    let inner = value
        .get("response")
        .and_then(|r| r.get("error"))
        .filter(|e| !e.is_null())
        .map(|e| serde_json::json!({ "error": e }).to_string());
    let body = inner.unwrap_or_else(|| String::from_utf8_lossy(payload).into_owned());
    Some(
        UpstreamError::parse(body.as_bytes(), key)
            .message
            .unwrap_or_else(|| sophia_core::t!("models.probe.upstreamError")),
    )
}

/// 上游错误响应里对人有用的部分，已经抹掉密钥、截到 [`PROBE_DETAIL_CHARS`] 个字符
#[derive(Debug, Default, PartialEq, Eq)]
struct UpstreamError {
    /// `error.message`、`error`（字符串）、`message`、`detail` 里第一个非空的；都没有就是响应体原文
    message: Option<String>,
    /// OpenAI 形状里的 `error.param`：上游指明是哪个参数不对
    param: Option<String>,
}

impl UpstreamError {
    fn parse(body: &[u8], key: &str) -> Self {
        let json = serde_json::from_slice::<Value>(body).ok();
        let text_at = |value: Option<&Value>| {
            value
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let message = json
            .as_ref()
            .and_then(|doc| {
                text_at(doc.pointer("/error/message"))
                    .or_else(|| text_at(doc.get("error")))
                    .or_else(|| text_at(doc.get("message")))
                    .or_else(|| text_at(doc.get("detail")))
            })
            .or_else(|| {
                let raw = String::from_utf8_lossy(body);
                let raw = raw.trim();
                (!raw.is_empty()).then(|| raw.to_owned())
            })
            .map(|text| unwrap_nested(text, &text_at))
            .map(|text| shorten(&clean_upstream_text(&text, key)));
        let param = json
            .as_ref()
            .and_then(|doc| text_at(doc.pointer("/error/param")))
            .map(|text| shorten(&clean_upstream_text(&text, key)));
        Self { message, param }
    }
}

/// 网关把上游的错误整段 JSON 当成说明再套一层（2026-09-30 真机：ap-gateway 的
/// `{"error":{"message":"Not found the model kimi-k2.5 …","type":"resource_not_found_error"}}` 出现在 message 里）：
/// 说明本身又是带说明的 JSON 就往里取，最多三层；取不出就原样
fn unwrap_nested(mut text: String, text_at: &dyn Fn(Option<&Value>) -> Option<String>) -> String {
    for _ in 0..3 {
        let Ok(inner) = serde_json::from_str::<Value>(text.trim()) else {
            break;
        };
        let Some(next) = text_at(inner.pointer("/error/message"))
            .or_else(|| text_at(inner.get("error")))
            .or_else(|| text_at(inner.get("message")))
            .or_else(|| text_at(inner.get("detail")))
        else {
            break;
        };
        text = next;
    }
    text
}

/// 网关常把收到的 `Authorization` 原样写进错误里（路由那边同样处理）
fn scrub(text: &str, key: &str) -> String {
    if key.is_empty() {
        return text.to_owned();
    }
    // 原样，以及 JSON 里转义过的写法（`/` 写成 `\/`、引号与反斜杠转义）
    let json = serde_json::to_string(key).unwrap_or_default();
    let json = json.trim_matches('"').to_owned();
    let mut out = text.replace(key, "***");
    for variant in [json.replace('/', "\\/"), json, key.replace('/', "\\/")] {
        if !variant.is_empty() && variant != key {
            out = out.replace(&variant, "***");
        }
    }
    out
}

/// 空白压成一个空格，截到 [`PROBE_DETAIL_CHARS`] 个字符（按字符，不切坏中文）
fn shorten(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let head: String = chars.by_ref().take(PROBE_DETAIL_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// 试调自己填的参数：正式对话由 Codex / Claude 发，参数取值与试调无关
const PROBE_PARAMS: [&str; 4] = [
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "stream",
];

/// 说的是「没有这个模型」的说法：出现了就不按参数问题放行
const MODEL_MISSING: [&str; 7] = [
    "not found",
    "not exist",
    "no such model",
    "unknown model",
    "invalid model",
    "model_not_found",
    "不存在", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

/// 规则：状态码 400 或 422，且错误说的是试调自己填的参数（[`PROBE_PARAMS`]：输出上限、是否流式）——
/// 例如「max_tokens 至少 1024」「只支持流式」——那么上游已经认出了模型、只是不接受这几个随手填的取值，
/// 算调得通，不拦勾选。「说的是」指：`error.param` 就是其中之一，或错误说明按词切开（字母、数字、下划线连成一个词，
/// 所以 `upstream` 不算 `stream`）后出现了其中之一。但说明里同时有「没有这个模型」的说法（[`MODEL_MISSING`]）时
/// 仍算不通：有的网关报「模型不存在」时会把整个请求参数一起回显出来。
///
/// 取舍：宁可放过个别其实不通的（等于没有这项功能之前的样子），也不要拦下调得通的模型
fn rejects_only_probe_parameters(status: u16, error: &UpstreamError) -> bool {
    if status != 400 && status != 422 {
        return false;
    }
    let is_probe_param = |word: &str| PROBE_PARAMS.contains(&word.to_ascii_lowercase().as_str());
    let message = error.message.as_deref().unwrap_or_default();
    let lowered = message.to_lowercase();
    if MODEL_MISSING.iter().any(|phrase| lowered.contains(phrase)) {
        return false;
    }
    error.param.as_deref().is_some_and(is_probe_param)
        || message
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .any(is_probe_param)
}

/// 限流的说法：出现其一就算限流（小写比较）
const RATE_LIMITED: [&str; 9] = [
    "rate limit",
    "rate_limit",
    "too many requests",
    "qps",
    "tpm",
    "rpm",
    "超限", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "限流", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "频率", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

/// 被限流：429，或别的状态码但说明是限流（2026-09-30 真机：ap-gateway 回 500「专属QPS超限」「专属TPM超限」）。
/// 限流说明模型在、密钥对，只是这会儿请求太密——算调得通，不拦下用户要勾的模型。
/// 不含额度用完（quota、余额）：那是真用不了
/// 说的是额度用完：上游那句里有 [`QUOTA_EXHAUSTED`] 的说法，或原文（还原过转义、小写）里有 [`QUOTA_SIGNALS`]
/// 这些明确的说法。原文里不认单个 `quota`、`credit` 这类词——普通限流的返回体常带 `quota_remaining`（第 3 轮 a）
fn quota_exhausted(error: &UpstreamError, raw_lowered: &str) -> bool {
    let message = error.message.as_deref().unwrap_or_default().to_lowercase();
    QUOTA_EXHAUSTED
        .iter()
        .any(|phrase| message.contains(phrase))
        || QUOTA_SIGNALS
            .iter()
            .any(|phrase| raw_lowered.contains(phrase))
}

/// 原文里明确说额度用完的写法（小写）：OpenAI 的 `insufficient_quota`、各家的余额不足、欠费
const QUOTA_SIGNALS: [&str; 9] = [
    "insufficient_quota",
    "exceeded your current quota",
    "insufficient_balance",
    "insufficient balance",
    "credit balance",
    "billing_hard_limit",
    "余额不足", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "额度不足", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "欠费",     // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

fn rate_limited(status: u16, error: &UpstreamError) -> bool {
    // 密钥不对就是不对，说明里提到了 RPM 档位也不算限流
    if status == 401 || status == 403 {
        return false;
    }
    let lowered = error.message.as_deref().unwrap_or_default().to_lowercase();
    if QUOTA_EXHAUSTED
        .iter()
        .any(|phrase| lowered.contains(phrase))
    {
        return false;
    }
    status == 429 || RATE_LIMITED.iter().any(|phrase| lowered.contains(phrase))
}

/// 额度用完的说法（小写）：429 也常这么回（OpenAI `insufficient_quota`），但那是真用不了
const QUOTA_EXHAUSTED: [&str; 8] = [
    "quota",
    "insufficient",
    "billing",
    "credit",
    "balance",
    "余额", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "额度", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "欠费", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::body::Incoming;
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use hyper_util::rt::TokioIo;
    use std::convert::Infallible;
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    /// reqwest 用 `rustls-no-provider`：不选定 aws-lc-rs/ring 中的一个就没有默认加密提供方，
    /// 建 Client 会 panic。测试里的假上游都是明文 http，用不到 TLS，但仍需要装一次默认
    /// provider 才能通过 reqwest 内部的检查。
    fn ensure_crypto_provider() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    /// 不走任何代理（环境变量里的、系统的）：本机假服务的测试不受这台机器的代理设置影响
    fn test_client() -> reqwest::Client {
        ensure_crypto_provider();
        client_builder_defaults().no_proxy().build().unwrap()
    }

    /// 起一个只服务于本次测试的本地 HTTP 服务器，返回它的 base url。
    async fn start_server<F, Fut>(handler: F) -> String
    where
        F: Fn(Request<Incoming>) -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = Response<Full<Bytes>>> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let handler = handler.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let service = service_fn(move |req| {
                        let handler = handler.clone();
                        async move { Ok::<_, Infallible>(handler(req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn json_response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
        Response::builder()
            .status(status)
            .body(Full::new(Bytes::from(body.to_string())))
            .unwrap()
    }

    fn ids(result: &FetchResult) -> Vec<&str> {
        result.models.iter().map(|m| m.id.as_str()).collect()
    }

    fn kind_of(err: &FetchError) -> FetchErrorKind {
        err.kind
    }

    /// AC7：用密钥拉取网关的模型列表；/models 不存在时退到 /v1/models，并记住实际可用的接口基址。
    #[tokio::test]
    async fn ac7_fetch_models_tries_both_paths() {
        let got_auth: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let got_auth_clone = Arc::clone(&got_auth);
        let base = start_server(move |req: Request<Incoming>| {
            let got_auth = Arc::clone(&got_auth_clone);
            async move {
                got_auth.lock().unwrap().push(
                    req.headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string(),
                );
                if req.uri().path() != "/openai/v1/models" {
                    return json_response(StatusCode::NOT_FOUND, "not found");
                }
                json_response(
                    StatusCode::OK,
                    r#"{"object":"list","data":[{"id":"weibo/glm-5"},{"id":"kimi-k3"},{"id":""}]}"#,
                )
            }
        })
        .await;

        let client = test_client();
        let result = fetch_models(
            &client,
            &format!("{base}/openai"),
            "sk-test",
            Duration::from_secs(2),
            false,
        )
        .await
        .unwrap();

        assert_eq!(ids(&result), vec!["weibo/glm-5", "kimi-k3"]);
        assert_eq!(result.api_base, format!("{base}/openai/v1"));
        for auth in got_auth.lock().unwrap().iter() {
            assert_eq!(auth, "Bearer sk-test");
        }
    }

    #[tokio::test]
    async fn fetch_models_accepts_bare_array() {
        let base = start_server(|_req: Request<Incoming>| async move {
            json_response(StatusCode::OK, r#"[{"id":"a"},{"id":"b"}]"#)
        })
        .await;

        let client = test_client();
        let result = fetch_models(&client, &base, "k", Duration::from_secs(1), false)
            .await
            .unwrap();
        assert_eq!(ids(&result), vec!["a", "b"]);
        assert_eq!(result.api_base, base);
    }

    /// AC8：密钥错误时报鉴权失败，且错误信息里不含密钥。
    #[tokio::test]
    async fn ac8_auth_failure() {
        let base = start_server(|_req: Request<Incoming>| async move {
            json_response(
                StatusCode::UNAUTHORIZED,
                r#"{"type":"error","error":"Unauthorized","detail":"Authentication required"}"#,
            )
        })
        .await;

        let client = test_client();
        let err = fetch_models(&client, &base, "bad", Duration::from_secs(1), false)
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err), FetchErrorKind::Auth);
        assert!(!err.message.contains("bad"));
        assert_eq!(err.kind.unreachable().text(), "密钥无效，请换一个密钥");
    }

    /// AC9：网关不可达时在超时内报网络错误。
    #[tokio::test]
    async fn ac9_network_failure_within_timeout() {
        let base = start_server(|_req: Request<Incoming>| async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            json_response(StatusCode::OK, "[]")
        })
        .await;

        let client = test_client();
        let start = std::time::Instant::now();
        let err = fetch_models(&client, &base, "k", Duration::from_millis(300), false)
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err), FetchErrorKind::Timeout);
        assert_eq!(err.message, "连接超时（检查网络或内网）");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "耗时 {:?}",
            start.elapsed()
        );

        // 连接被拒绝（没有服务在监听）：应当立即报网络错误，不必等到超时。
        let unreachable = "http://127.0.0.1:1";
        let refuse_start = std::time::Instant::now();
        let err2 = fetch_models(&client, unreachable, "k", Duration::from_secs(5), false)
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err2), FetchErrorKind::Refused);
        assert_eq!(
            err2.kind.unreachable().text(),
            "无法连接，对方没在这个端口上"
        );
        assert!(
            refuse_start.elapsed() < Duration::from_secs(2),
            "连接被拒绝应当很快返回，耗时 {:?}",
            refuse_start.elapsed()
        );
    }

    #[tokio::test]
    async fn fetch_models_unexpected_response() {
        let base = start_server(|_req: Request<Incoming>| async move {
            json_response(StatusCode::OK, "<html>gateway portal</html>")
        })
        .await;

        let client = test_client();
        let err = fetch_models(&client, &base, "k", Duration::from_secs(1), false)
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err), FetchErrorKind::Unexpected);
        assert_eq!(
            err.kind.unreachable().text(),
            "地址有误，返回的不是模型列表"
        );
    }

    /// 什么名字都解析不了（同系统解析器找不到名字时的原话）
    struct FailingResolver;

    impl reqwest::dns::Resolve for FailingResolver {
        fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            Box::pin(async {
                Err(Box::new(std::io::Error::other(
                    "failed to lookup address information: nodename nor servname provided, or not known",
                )) as Box<dyn std::error::Error + Send + Sync>)
            })
        }
    }

    /// 一个此刻没人听的本机端口：先绑上拿到号，再放掉
    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    }

    /// 起一个只会回一串乱码再挂断的 TCP 服务：当 https 地址连上去，TLS 握手必定失败
    async fn garbage_server() -> u16 {
        use tokio::io::AsyncWriteExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = stream
                    .write_all(b"HTTP/1.1 418 nope\r\n\r\nnot tls at all")
                    .await;
                let _ = stream.shutdown().await;
            }
        });
        port
    }

    /// spec 2026-10-04-local-diagnostics R9 / AC8：连不上的几种原因分得开，详情里有请求与原文
    #[tokio::test]
    async fn fetch_failures_are_classified_by_cause() {
        let client = test_client();

        // 端口上没人听：连接被拒，很快返回
        let port = free_port().await;
        let err = fetch_models(
            &client,
            &format!("http://127.0.0.1:{port}"),
            "k",
            Duration::from_secs(5),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Refused);
        assert_eq!(err.message, "无法连接，对方没在这个端口上");
        assert!(
            err.detail
                .starts_with(&format!("GET http://127.0.0.1:{port}/models → ")),
            "{}",
            err.detail
        );

        // 走系统代理时连不上：说是代理的事
        let err = fetch_models(
            &client,
            &format!("http://127.0.0.1:{port}"),
            "k",
            Duration::from_secs(5),
            true,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Proxy);
        assert_eq!(err.message, "无法连接代理（检查系统代理）");

        // 域名解析不了。不靠系统解析：开着「假 IP」一类透明代理（TUN）的机器上，任何名字都解析得到
        // （2026-10-04 本机实测 `.invalid` 解析成 198.18.x.x，连上后被代理挂断），换一个必定解析失败的解析器
        let failing_dns = {
            ensure_crypto_provider();
            client_builder_defaults()
                .no_proxy()
                .dns_resolver(Arc::new(FailingResolver))
                .build()
                .unwrap()
        };
        let err = fetch_models(
            &failing_dns,
            "http://sophia-diagnostics.invalid",
            "k",
            Duration::from_secs(10),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Dns, "{}", err.detail);
        assert_eq!(err.message, "找不到这个地址（检查地址或内网）");

        // 握手对不上：证书 / TLS
        let port = garbage_server().await;
        let err = fetch_models(
            &client,
            &format!("https://127.0.0.1:{port}"),
            "k",
            Duration::from_secs(5),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Tls, "{}", err.detail);
        assert_eq!(err.message, "证书有问题，不能安全连接");
    }

    /// 429 带 Retry-After：限流、多少秒后再试；详情里是请求、状态与返回体（抹掉密钥），不换路径重试
    #[tokio::test]
    async fn rate_limit_says_when_to_retry_with_details() {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&hits);
        let base = start_server(move |req: Request<Incoming>| {
            let seen = Arc::clone(&seen);
            async move {
                seen.lock().unwrap().push(req.uri().path().to_owned());
                Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .header("Retry-After", "30")
                    .body(Full::new(Bytes::from(
                        r#"{"error":{"message":"Rate limit exceeded for sk-rl-secret-123456"}}"#,
                    )))
                    .unwrap()
            }
        })
        .await;
        let err = fetch_models(
            &test_client(),
            &base,
            "sk-rl-secret-123456",
            Duration::from_secs(2),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::RateLimited(Some(30)));
        assert_eq!(err.message, "服务商限流了，约 30 秒后再试");
        assert_eq!(
            err.kind.unreachable(),
            UnreachableReason::RateLimited(Some(30))
        );
        assert!(
            err.detail.starts_with(&format!(
                "GET {base}/models → 429 Too Many Requests · Retry-After: 30\n"
            )),
            "{}",
            err.detail
        );
        assert!(err.detail.contains("Rate limit exceeded"), "{}", err.detail);
        assert!(!err.detail.contains("sk-rl-secret"), "{}", err.detail);
        assert_eq!(*hits.lock().unwrap(), ["/models"], "限流不换路径再试");
    }

    /// 详情先把返回体解开再抹密钥、去隐私，最后才截短（Codex 复审 2/7）：JSON 里转义过的密钥（`\/`）、
    /// 跨在 300 字边界上的密钥都不会漏出一截
    #[tokio::test]
    async fn detail_unescapes_the_body_before_scrubbing_and_truncates_last() {
        let key = "opaque/credential987654321";
        let base = start_server(|_req: Request<Incoming>| async move {
            json_response(
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"message":"invalid opaque\/credential987654321"}}"#,
            )
        })
        .await;
        let err = fetch_models(&test_client(), &base, key, Duration::from_secs(2), false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Auth);
        assert!(
            !err.detail.contains("credential987654321"),
            "{}",
            err.detail
        );
        assert!(err.detail.contains("invalid"), "{}", err.detail);

        // 不是 JSON 的返回体里转义过的密钥同样抹掉；长得像密钥的串跨在截断处也不漏前缀
        let tail = format!(
            "{} opaque\\/credential987654321 sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
            "x".repeat(250)
        );
        let base = start_server(move |_req: Request<Incoming>| {
            let tail = tail.clone();
            async move { json_response(StatusCode::SERVICE_UNAVAILABLE, &tail) }
        })
        .await;
        let err = fetch_models(&test_client(), &base, key, Duration::from_secs(2), false)
            .await
            .unwrap_err();
        assert!(
            !err.detail.contains("credential987654321"),
            "{}",
            err.detail
        );
        assert!(!err.detail.contains("sk-proj"), "{}", err.detail);
    }

    /// 非 200 先按状态码与响应头定种类，返回体只读一小段、等一小会（Codex 复审 3/7）：
    /// 429 + Retry-After: 30 的返回体一直不结束，照样是「限流，约 30 秒」，不被拖成超时
    #[tokio::test]
    async fn a_never_ending_error_body_does_not_hide_the_status() {
        use tokio::io::AsyncWriteExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\n\
                              Transfer-Encoding: chunked\r\n\r\n5\r\nslow \r\n",
                        )
                        .await;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                });
            }
        });
        let start = std::time::Instant::now();
        let err = fetch_models(
            &test_client(),
            &format!("http://127.0.0.1:{port}"),
            "k",
            Duration::from_secs(10),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.kind,
            FetchErrorKind::RateLimited(Some(30)),
            "{}",
            err.detail
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
        assert!(err.detail.contains("slow"), "{}", err.detail);
    }

    /// 返回体被截短、JSON 解不开时，也先把 JSON 字符串里的转义（`\uXXXX`、`\/`）按字面还原再抹密钥（第 2 轮 2）
    #[tokio::test]
    async fn detail_unescapes_a_truncated_unparseable_body() {
        let key = "opaque/credential987654321";
        let body: &'static str = Box::leak(
            format!(
                r#"{{"error":{{"message":"invalid \u006fpaque/credential987654321 and opaque\/credential987654321"}},"padding":"{}"}}"#,
                "x".repeat(70_000)
            )
            .into_boxed_str(),
        );
        let base = start_server(move |_req: Request<Incoming>| async move {
            json_response(StatusCode::UNAUTHORIZED, body)
        })
        .await;
        let err = fetch_models(&test_client(), &base, key, Duration::from_secs(5), false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Auth);
        assert!(
            !err.detail.contains("credential987654321"),
            "{}",
            err.detail
        );
        assert!(!err.detail.contains("006f"), "{}", err.detail);
        assert!(err.detail.contains("invalid"), "{}", err.detail);
    }

    /// 密钥里本身就有 `\t` 这样的两个字符：还原转义之前先抹一遍，之后再抹一遍（第 3 轮 b）
    #[tokio::test]
    async fn a_key_with_a_literal_escape_is_scrubbed_before_unescaping() {
        let key = r"ab\tcd1234567890xyz";
        let base = start_server(|_req: Request<Incoming>| async move {
            json_response(StatusCode::UNAUTHORIZED, r"invalid ab\tcd1234567890xyz")
        })
        .await;
        let err = fetch_models(&test_client(), &base, key, Duration::from_secs(5), false)
            .await
            .unwrap_err();
        assert!(!err.detail.contains("cd1234567890"), "{}", err.detail);
    }

    /// 第一条路径已经定了 5xx（响应头在期限末尾才到、返回体不结束），第二条路径因期限已过超时：
    /// 报 5xx，不被超时盖掉（第 3 轮 d）
    #[tokio::test]
    async fn a_late_5xx_is_not_overwritten_by_the_retry_timing_out() {
        use tokio::io::AsyncWriteExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\n\
                              Transfer-Encoding: chunked\r\n\r\n5\r\nslow \r\n",
                        )
                        .await;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                });
            }
        });
        let err = fetch_models(
            &test_client(),
            &format!("http://127.0.0.1:{port}"),
            "k",
            Duration::from_secs(2),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Server(503), "{}", err.detail);
    }

    #[test]
    fn json_escapes_are_undone_textually() {
        assert_eq!(
            unescape_json_text(r#"a\/b \u006f \"q\" \\ x"#),
            r#"a/b o "q" \ x"#
        );
        assert_eq!(unescape_json_text(r#"\ud83d\ude00!"#), "😀!");
        assert_eq!(unescape_json_text(r#"\ud83d alone"#), "\u{FFFD} alone");
        assert_eq!(unescape_json_text(r#"\uZZZZ \q end\"#), r#"\uZZZZ \q end\"#);
        assert_eq!(unescape_json_text("line\\nnext"), "line\nnext");
    }

    /// 收到响应头就定了种类：总期限只管到响应头（第 2 轮 3）。2 秒的期限里 1.5 秒才来
    /// `429 + Retry-After: 30`、返回体一直不结束，照样是限流约 30 秒，不被拖成超时
    #[tokio::test]
    async fn headers_arriving_late_still_decide_the_kind() {
        use tokio::io::AsyncWriteExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\n\
                              Transfer-Encoding: chunked\r\n\r\n5\r\nslow \r\n",
                        )
                        .await;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                });
            }
        });
        let err = fetch_models(
            &test_client(),
            &format!("http://127.0.0.1:{port}"),
            "k",
            Duration::from_secs(2),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.kind,
            FetchErrorKind::RateLimited(Some(30)),
            "{}",
            err.detail
        );
    }

    /// 5xx：服务商出错了（带状态码）；两条路径都试过，报 5xx 而不是「不是模型列表」
    #[tokio::test]
    async fn server_errors_report_the_status() {
        let base = start_server(|req: Request<Incoming>| async move {
            if req.uri().path() == "/models" {
                json_response(StatusCode::SERVICE_UNAVAILABLE, "upstream down")
            } else {
                json_response(StatusCode::NOT_FOUND, "not found")
            }
        })
        .await;
        let err = fetch_models(&test_client(), &base, "k", Duration::from_secs(2), false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, FetchErrorKind::Server(503));
        assert_eq!(err.message, "服务商出了问题（HTTP 503），稍后再试");
        assert!(
            err.detail
                .starts_with(&format!("GET {base}/models → 503 Service Unavailable\n")),
            "{}",
            err.detail
        );
    }

    /// 用 `client_builder_defaults()` 建出的 client 不跟随重定向：请求里带着密钥，
    /// 不能被带到别的地址。
    #[tokio::test]
    async fn fetch_models_does_not_follow_redirects_with_default_client() {
        let second_hop = Arc::new(AtomicBool::new(false));
        let second_hop_clone = Arc::clone(&second_hop);
        let base = start_server(move |req: Request<Incoming>| {
            let second_hop = Arc::clone(&second_hop_clone);
            async move {
                if req.uri().path().ends_with("/elsewhere") {
                    second_hop.store(true, Ordering::SeqCst);
                    return json_response(StatusCode::OK, "[]");
                }
                Response::builder()
                    .status(StatusCode::TEMPORARY_REDIRECT)
                    .header("Location", "/elsewhere")
                    .body(Full::new(Bytes::new()))
                    .unwrap()
            }
        })
        .await;

        let client = test_client();
        let result = fetch_models(&client, &base, "sk-test", Duration::from_secs(1), false).await;
        assert!(result.is_err());
        assert!(!second_hop.load(Ordering::SeqCst));
    }
    /// 每项的上下文长度：按字段顺序取第一个正整数；各家网关的写法都认，没给就是 None
    #[tokio::test]
    async fn fetch_models_reads_context_length_from_each_field_shape() {
        let base = start_server(|_req: Request<Incoming>| async move {
            json_response(
                StatusCode::OK,
                r#"{"data":[
                  {"id":"openrouter","context_length":200000,"top_provider":{"context_length":100000}},
                  {"id":"window","context_window":128000},
                  {"id":"max-context","max_context_length":64000},
                  {"id":"vllm","max_model_len":32768},
                  {"id":"top-only","context_length":null,"top_provider":{"context_length":163840}},
                  {"id":"anthropic","max_input_tokens":1000000},
                  {"id":"float","context_length":131072.0},
                  {"id":"skips-zero","context_length":0,"context_window":8192},
                  {"id":"string","context_length":"128000"},
                  {"id":"negative","context_length":-1},
                  {"id":"too-big","context_length":99999999999},
                  {"id":"nothing"}
                ]}"#,
            )
        })
        .await;
        let result = fetch_models(&test_client(), &base, "k", Duration::from_secs(1), false)
            .await
            .unwrap();
        let got: Vec<(&str, Option<u32>)> = result
            .models
            .iter()
            .map(|m| (m.id.as_str(), m.context_window))
            .collect();
        assert_eq!(
            got,
            [
                ("openrouter", Some(200_000)),
                ("window", Some(128_000)),
                ("max-context", Some(64_000)),
                ("vllm", Some(32_768)),
                ("top-only", Some(163_840)),
                ("anthropic", Some(1_000_000)),
                ("float", Some(131_072)),
                ("skips-zero", Some(8_192)),
                ("string", None),
                ("negative", None),
                ("too-big", None),
                ("nothing", None),
            ]
        );
    }

    /// 起一个假上游：记下收到的路径、Authorization 与请求体，按 `answer` 回复
    async fn probe_server<F, Fut>(
        seen: Arc<Mutex<Vec<(String, String, Value)>>>,
        answer: F,
    ) -> String
    where
        F: Fn() -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = Response<Full<Bytes>>> + Send + 'static,
    {
        start_server(move |req: Request<Incoming>| {
            let seen = Arc::clone(&seen);
            let answer = answer.clone();
            async move {
                use http_body_util::BodyExt;
                let path = req.uri().path().to_owned();
                let auth = req
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                let body = req.into_body().collect().await.unwrap().to_bytes();
                let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
                seen.lock().unwrap().push((path, auth, body));
                answer().await
            }
        })
        .await
    }

    async fn probe(base: &str, protocol: Protocol, timeout: Duration) -> Result<(), ProbeError> {
        probe_model(
            &test_client(),
            &format!("{base}/v1"),
            protocol,
            "weibo/kimi-k2.5",
            "sk-probe-secret",
            timeout,
            false,
        )
        .await
    }

    /// 试调通了：Chat 发 `{api_base}/chat/completions`，Responses 发 `{api_base}/responses`，
    /// 一条 `ping`、输出上限 16、流式、带 Bearer 密钥；网关不理 `stream` 回整段 JSON 也算通
    #[tokio::test]
    async fn probe_succeeds_on_2xx_with_a_minimal_request_per_protocol() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = probe_server(Arc::clone(&seen), || async {
            json_response(StatusCode::OK, r#"{"id":"x","choices":[]}"#)
        })
        .await;
        probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap();
        probe(&base, Protocol::Responses, Duration::from_secs(2))
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        let (path, auth, body) = &seen[0];
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(auth, "Bearer sk-probe-secret");
        assert_eq!(
            body,
            &serde_json::json!({
                "model": "weibo/kimi-k2.5",
                "messages": [{"role": "user", "content": "ping"}],
                "max_tokens": 16,
                "stream": true,
            })
        );
        let (path, auth, body) = &seen[1];
        assert_eq!(path, "/v1/responses");
        assert_eq!(auth, "Bearer sk-probe-secret");
        assert_eq!(
            body,
            &serde_json::json!({
                "model": "weibo/kimi-k2.5",
                "input": "ping",
                "max_output_tokens": 16,
                "stream": true,
            })
        );
    }

    /// 网关把上游错误整段 JSON 塞进 message（ap-gateway 实测）：取里面那一句
    #[test]
    fn upstream_error_unwraps_json_nested_in_the_message() {
        let body = r#"{"error":{"message":"{\"error\":{\"message\":\"Not found the model kimi-k2.5 or Permission denied\",\"type\":\"resource_not_found_error\"}}"}}"#;
        assert_eq!(
            UpstreamError::parse(body.as_bytes(), "").message.as_deref(),
            Some("Not found the model kimi-k2.5 or Permission denied")
        );
        // 原文就是那段 JSON（没有外层）也一样
        let raw = r#"{"error":{"message":"Not found the model kimi-k2.5 or Permission denied"}}"#;
        assert_eq!(
            UpstreamError::parse(raw.as_bytes(), "").message.as_deref(),
            Some("Not found the model kimi-k2.5 or Permission denied")
        );
    }

    /// 额度用完（429 insufficient_quota）、密钥不对（401/403 提到 RPM 档位）不算限流；
    /// 回 200 的整段 JSON 里字符串带 `data:` 也不当成事件，报错照样认出来
    #[tokio::test]
    async fn probe_does_not_pass_exhausted_quota_or_json_with_data_in_text() {
        for (status, body) in [
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}"#,
            ),
            (
                StatusCode::FORBIDDEN,
                r#"{"error":{"message":"your tier allows 10 RPM"}}"#,
            ),
            (
                StatusCode::OK,
                "{\"error\":{\"message\":\"invalid data: model x unavailable\"}}\n",
            ),
        ] {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let base = probe_server(seen, move || async move { json_response(status, body) }).await;
            assert!(
                probe(&base, Protocol::Chat, Duration::from_secs(2))
                    .await
                    .is_err(),
                "{body}"
            );
        }
    }

    /// 被限流算调得通：429，或说明是限流的 500（ap-gateway 实测「专属QPS超限」）；额度用完不算
    #[tokio::test]
    async fn probe_counts_rate_limits_as_reachable() {
        for (status, body) in [
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"slow down"}}"#,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"message":"专属QPS超限"}}"#,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"message":"专属TPM超限"}}"#,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"Rate limit reached for requests"}}"#,
            ),
        ] {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let base = probe_server(seen, move || async move { json_response(status, body) }).await;
            probe(&base, Protocol::Chat, Duration::from_secs(2))
                .await
                .unwrap_or_else(|e| panic!("{body}: {}", e.message));
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = probe_server(seen, || async {
            json_response(
                StatusCode::FORBIDDEN,
                r#"{"error":{"message":"insufficient quota"}}"#,
            )
        })
        .await;
        assert!(probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .is_err());
    }

    /// 回 200 之后读到第一个事件就下结论：正常事件算通，报错事件（`error` / `response.failed`）算不通；
    /// 第一个事件之后网关一直不结束也不等——会思考的模型不流式要七八秒（2026-09-30 真机）
    #[tokio::test]
    async fn probe_decides_on_the_first_stream_event_without_waiting_for_the_rest() {
        let serve_once = |events: &'static str| async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let _ = socket.read(&mut buf).await;
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
                let chunk = format!("{:x}\r\n{events}\r\n", events.len());
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(chunk.as_bytes()).await;
                // 不结束：模拟还在慢慢生成
                tokio::time::sleep(Duration::from_secs(30)).await;
            });
            format!("http://{addr}")
        };

        let ok = serve_once("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"嗯\"}}]}\n\n")
            .await;
        let started = std::time::Instant::now();
        probe(&ok, Protocol::Chat, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "读到第一个事件就返回"
        );

        let failed = serve_once("data: {\"error\":{\"message\":\"model not found\"}}\n\n").await;
        let err = probe(&failed, Protocol::Chat, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Upstream);
        assert_eq!(err.message, "调用不通：model not found");

        let responses = serve_once(
            "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"quota exceeded\"}}}\n\n",
        )
        .await;
        let err = probe(&responses, Protocol::Responses, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.message, "调用不通：quota exceeded");
    }

    /// 实测：网关列着 `weibo/glm-5`，一调就 404。原因取上游 `error.message`；
    /// 不是 JSON 就取原文前 120 个字符；密钥被回显时抹掉；401/403 归为 Auth
    #[tokio::test]
    async fn probe_reports_http_errors_with_the_upstream_message() {
        let answer = |status: StatusCode, body: &'static str| {
            move || async move { json_response(status, body) }
        };
        let seen = Arc::new(Mutex::new(Vec::new()));

        let base = probe_server(
            Arc::clone(&seen),
            answer(
                StatusCode::NOT_FOUND,
                r#"{"error":{"message":"404 Not Found","type":"upstream_error","code":404}}"#,
            ),
        )
        .await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Upstream);
        // 别的 4xx：上游那句（说的是哪个模型 / 参数不对）就是原因；请求与返回体另在详情里（R13）
        assert_eq!(err.message, "调用不通（404）：404 Not Found");
        assert!(
            err.detail.starts_with(&format!(
                "POST {base}/v1/chat/completions → 404 Not Found\n"
            )),
            "{}",
            err.detail
        );

        // 5xx：说人话（服务商出了问题），上游原文只进详情（R9 / R13，Codex 复审 5/7）
        let long: &'static str =
            Box::leak(format!("<html>{}</html>", "网关维护中 ".repeat(40)).into_boxed_str());
        let base = probe_server(Arc::clone(&seen), answer(StatusCode::BAD_GATEWAY, long)).await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Upstream);
        assert_eq!(err.message, "服务商出了问题（HTTP 502），稍后再试");
        assert!(err.detail.contains("<html>网关维护中"), "{}", err.detail);

        // 401 / 403：说密钥被拒，上游原文（抹掉密钥）进详情
        let base = probe_server(
            Arc::clone(&seen),
            answer(
                StatusCode::UNAUTHORIZED,
                r#"{"error":"invalid token: Bearer sk-probe-secret"}"#,
            ),
        )
        .await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Auth);
        assert_eq!(
            err.message,
            "网关拒绝了这个密钥（HTTP 401），请检查密钥是否正确"
        );
        assert!(err.detail.contains("invalid token"), "{}", err.detail);
        assert!(!err.detail.contains("sk-probe-secret"), "{}", err.detail);

        let base = probe_server(
            Arc::clone(&seen),
            answer(StatusCode::SERVICE_UNAVAILABLE, ""),
        )
        .await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(err.message, "服务商出了问题（HTTP 503），稍后再试");
        assert!(
            err.detail.ends_with("→ 503 Service Unavailable"),
            "{}",
            err.detail
        );
    }

    /// 429 但说的是额度用完：返回体很长、截短后 JSON 解不开，也要从原文里认出额度的说法，不算通（第 2 轮 新增）
    #[tokio::test]
    async fn probe_spots_exhausted_quota_in_a_long_unparseable_body() {
        let body: &'static str = Box::leak(
            format!(
                r#"{{"padding":"{}","error":{{"message":"insufficient_quota"}}}}"#,
                "x".repeat(17_000)
            )
            .into_boxed_str(),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = probe_server(seen, move || async move {
            json_response(StatusCode::TOO_MANY_REQUESTS, body)
        })
        .await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Upstream);
        assert_eq!(err.message, "额度不足（HTTP 429），请检查服务商账户的余额");
    }

    /// 普通限流的返回体里出现 `quota` 字样（`quota_remaining`）不算额度用完：原文里只认明确的说法（第 3 轮 a）
    #[tokio::test]
    async fn probe_does_not_mistake_a_quota_field_for_exhausted_quota() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = probe_server(seen, || async {
            json_response(
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"Rate limit reached"},"quota_remaining":1000}"#,
            )
        })
        .await;
        assert_eq!(
            probe(&base, Protocol::Chat, Duration::from_secs(5)).await,
            Ok(())
        );
    }

    /// 试调的原因也走详情那一套（还原转义、抹密钥、去隐私）：截短后解不开的 400 里转义过的密钥不进那一句（第 3 轮 c）
    #[tokio::test]
    async fn probe_reason_never_carries_an_escaped_key() {
        let body: &'static str = Box::leak(
            format!(
                r#"{{"error":{{"message":"invalid \u0073k-probe-secret"}},"padding":"{}"}}"#,
                "x".repeat(70_000)
            )
            .into_boxed_str(),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = probe_server(seen, move || async move {
            json_response(StatusCode::BAD_REQUEST, body)
        })
        .await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(!err.message.contains("probe-secret"), "{}", err.message);
        assert!(!err.message.contains("0073"), "{}", err.message);
        assert!(!err.detail.contains("probe-secret"), "{}", err.detail);
    }

    /// 400 / 422 只是不接受试调自己填的参数（输出上限、流式）时算调得通；说的是模型本身、
    /// 或说「没有这个模型」时顺带回显了参数，都仍算不通；别的状态码提到参数也不算
    #[tokio::test]
    async fn probe_counts_a_rejection_of_its_own_parameters_as_reachable() {
        let cases: [(StatusCode, &'static str, bool); 8] = [
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"max_tokens must be at least 1024","type":"invalid_request_error"}}"#,
                true,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"Invalid value","param":"max_output_tokens"}}"#,
                true,
            ),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                r#"{"detail":"Only stream=true is supported"}"#,
                true,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"Invalid model name passed in model=weibo/glm-5"}}"#,
                false,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"model weibo/glm-5 not found, request={'max_tokens': 16}"}}"#,
                false,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"upstream request rejected"}}"#,
                false,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"message":"max_tokens handling crashed"}}"#,
                false,
            ),
            (StatusCode::BAD_REQUEST, "bad request", false),
        ];
        for (status, body, reachable) in cases {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let base = probe_server(seen, move || async move { json_response(status, body) }).await;
            let result = probe(&base, Protocol::Chat, Duration::from_secs(2)).await;
            assert_eq!(result.is_ok(), reachable, "{status} {body}: {result:?}");
        }
    }

    /// 上游不回话：在给定时长内报「N 秒内没有回应」；连不上：立即报连接失败；
    /// 存着的地址不是 https（回环除外）：不发请求，报 Invalid
    #[tokio::test]
    async fn probe_reports_timeouts_refusals_and_unusable_addresses() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let base = probe_server(seen, || async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            json_response(StatusCode::OK, "{}")
        })
        .await;
        let start = std::time::Instant::now();
        let err = probe(&base, Protocol::Chat, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Network);
        assert_eq!(err.message, "1 秒内没有回应");
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "{:?}",
            start.elapsed()
        );
        assert_eq!(PROBE_TIMEOUT, Duration::from_secs(20));

        let err = probe("http://127.0.0.1:1", Protocol::Chat, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Network);
        assert_eq!(err.message, "无法连接，对方没在这个端口上");

        let err = probe("http://gw.example", Protocol::Chat, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Invalid);
        assert!(!err.message.contains("sk-probe-secret"));
    }
}

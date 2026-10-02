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

/// [`FetchError`] 的分类：鉴权失败、网络不可达/超时、响应不是模型列表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchErrorKind {
    Auth,
    Network,
    Unexpected,
}

impl FetchErrorKind {
    /// 记在那一家网关上的原因种类，界面在那一行显示「无法连接」时按当前语言取句说明为什么
    pub fn unreachable(self) -> UnreachableReason {
        match self {
            FetchErrorKind::Auth => UnreachableReason::Auth,
            FetchErrorKind::Network => UnreachableReason::Network,
            FetchErrorKind::Unexpected => UnreachableReason::Unexpected,
        }
    }
}

/// 拉取模型列表失败。错误信息里从不出现密钥。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub kind: FetchErrorKind,
    pub message: String,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for FetchError {}

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

async fn fetch_models_at(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Result<Vec<Model>, FetchError> {
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| FetchError {
            kind: FetchErrorKind::Network,
            message: sophia_core::t!("models.fetch.unreachable"),
        })?;

    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(FetchError {
            kind: FetchErrorKind::Auth,
            message: sophia_core::t!("models.fetch.keyRejected", status = status.as_u16()),
        });
    }
    if status.as_u16() != 200 {
        return Err(unexpected(sophia_core::t!(
            "models.fetch.badStatus",
            status = status.as_u16()
        )));
    }

    let body = resp.bytes().await.map_err(|_| FetchError {
        kind: FetchErrorKind::Network,
        message: sophia_core::t!("models.fetch.readFailed"),
    })?;

    let items = parse_items(&body)?;
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
        return Err(unexpected(sophia_core::t!("models.fetch.emptyList")));
    }
    Ok(models)
}

async fn fetch_models_inner(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
) -> Result<FetchResult, FetchError> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    let mut last_err = None;
    for api_base in [base.clone(), format!("{base}/v1")] {
        match fetch_models_at(client, &format!("{api_base}/models"), key).await {
            Ok(models) => return Ok(FetchResult { models, api_base }),
            Err(e) => {
                if e.kind != FetchErrorKind::Unexpected {
                    // 鉴权失败或网络不通，换路径也不会好。
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.expect("至少尝试过一个 api_base"))
}

/// 拉取网关的模型列表，总耗时不超过 `timeout`。先尝试 `{base}/models`，
/// 不成（且不是鉴权/网络错误）再退到 `{base}/v1/models`。接受 `{data:[{id}]}`
/// 或裸数组两种响应形状。错误信息里不会出现密钥。
pub async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    timeout: Duration,
) -> Result<FetchResult, FetchError> {
    match tokio::time::timeout(timeout, fetch_models_inner(client, base_url, key)).await {
        Ok(result) => result,
        Err(_) => Err(FetchError {
            kind: FetchErrorKind::Network,
            message: sophia_core::t!("models.fetch.timeout"),
        }),
    }
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
) -> Result<(), ProbeError> {
    let base = parse_provider_base(api_base).map_err(|e| ProbeError {
        kind: ProbeErrorKind::Invalid,
        message: sophia_core::t!("models.probe.badUrl", error = e),
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
    let request = client
        .post(resolve_target(&base, suffix, ""))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .body(body.to_string());
    let attempt = async {
        let response = send_with_connect_retry(request)
            .await
            .map_err(|_| ProbeError {
                kind: ProbeErrorKind::Network,
                message: sophia_core::t!("models.fetch.unreachable"),
            })?;
        let status = response.status();
        if status.is_success() {
            return first_event_error(response, key)
                .await
                .map_or(Ok(()), |detail| {
                    Err(ProbeError {
                        kind: ProbeErrorKind::Upstream,
                        message: sophia_core::t!("models.probe.failed", detail = detail),
                    })
                });
        }
        // 读不到响应体就当它是空的：失败原因里只剩状态码
        let body = response.bytes().await.unwrap_or_default();
        let error = UpstreamError::parse(&body, key);
        if rejects_only_probe_parameters(status.as_u16(), &error)
            || rate_limited(status.as_u16(), &error)
        {
            return Ok(());
        }
        let code = status.as_u16();
        let detail = error
            .message
            .or_else(|| status.canonical_reason().map(str::to_owned));
        Err(ProbeError {
            kind: if code == 401 || code == 403 {
                ProbeErrorKind::Auth
            } else {
                ProbeErrorKind::Upstream
            },
            message: match detail {
                Some(detail) => {
                    sophia_core::t!("models.probe.failedStatus", code = code, detail = detail)
                }
                None => sophia_core::t!("models.probe.failedCode", code = code),
            },
        })
    };
    match tokio::time::timeout(timeout, attempt).await {
        Ok(result) => result,
        Err(_) => Err(ProbeError {
            kind: ProbeErrorKind::Network,
            message: sophia_core::t!("models.probe.timeout", seconds = timeout.as_secs()),
        }),
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
            .map(|text| shorten(&scrub(&text, key)));
        let param = json
            .as_ref()
            .and_then(|doc| text_at(doc.pointer("/error/param")))
            .map(|text| shorten(&scrub(&text, key)));
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
        text.to_owned()
    } else {
        text.replace(key, "***")
    }
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

    fn test_client() -> reqwest::Client {
        ensure_crypto_provider();
        client_builder_defaults().build().unwrap()
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
        let result = fetch_models(&client, &base, "k", Duration::from_secs(1))
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
        let err = fetch_models(&client, &base, "bad", Duration::from_secs(1))
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
        let err = fetch_models(&client, &base, "k", Duration::from_millis(300))
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err), FetchErrorKind::Network);
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "耗时 {:?}",
            start.elapsed()
        );

        // 连接被拒绝（没有服务在监听）：应当立即报网络错误，不必等到超时。
        let unreachable = "http://127.0.0.1:1";
        let refuse_start = std::time::Instant::now();
        let err2 = fetch_models(&client, unreachable, "k", Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err2), FetchErrorKind::Network);
        assert_eq!(err2.kind.unreachable().text(), "地址无法访问");
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
        let err = fetch_models(&client, &base, "k", Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(kind_of(&err), FetchErrorKind::Unexpected);
        assert_eq!(err.kind.unreachable().text(), "地址有误，无法获取模型列表");
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
        let result = fetch_models(&client, &base, "sk-test", Duration::from_secs(1)).await;
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
        let result = fetch_models(&test_client(), &base, "k", Duration::from_secs(1))
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
        assert_eq!(err.message, "调用不通（404）：404 Not Found");

        let long: &'static str =
            Box::leak(format!("<html>{}</html>", "网关维护中 ".repeat(40)).into_boxed_str());
        let base = probe_server(Arc::clone(&seen), answer(StatusCode::BAD_GATEWAY, long)).await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap_err();
        let detail = err.message.strip_prefix("调用不通（502）：").unwrap();
        assert!(
            detail.starts_with("<html>网关维护中 网关维护中"),
            "{detail}"
        );
        assert_eq!(detail.chars().count(), 121, "120 个字符加省略号：{detail}");

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
        assert_eq!(err.message, "调用不通（401）：invalid token: Bearer ***");

        let base = probe_server(
            Arc::clone(&seen),
            answer(StatusCode::SERVICE_UNAVAILABLE, ""),
        )
        .await;
        let err = probe(&base, Protocol::Chat, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(err.message, "调用不通（503）：Service Unavailable");
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
        assert_eq!(err.message, "无法连接网关，请确认地址和网络（内网）可达");

        let err = probe("http://gw.example", Protocol::Chat, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProbeErrorKind::Invalid);
        assert!(!err.message.contains("sk-probe-secret"));
    }
}

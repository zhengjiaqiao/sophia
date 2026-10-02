//! R26：错误映射。所有错误都是 Anthropic 形状 `{"type":"error","error":{"type","message"}}`。
//!
//! 关键是上下文超长：Claude Code 只在错误信息以 `prompt is too long` 开头时触发自动压缩，
//! 所以把各家的超长措辞（关键词表 [`CONTEXT_OVERFLOW_PATTERNS`]）改写成这个开头。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::translate::SseEvent;

/// 上下文超长的关键词（小写、子串匹配、对整段原文做）。`context length` 同时覆盖
/// OpenAI 的 `maximum context length` 与 ap-gateway 的 `longer than the model's context length`；
/// `处理上限` 来自 ap-gateway 的中文 `user_tip`（P0 抓包）。
pub const CONTEXT_OVERFLOW_PATTERNS: &[&str] = &[
    "context_length_exceeded",
    "context length",
    "context window",
    "context_window",
    "maximum context",
    "too many tokens",
    "prompt is too long",
    "prompt too long",
    "input is too long",
    "input too long",
    "reduce the length",
    "上下文",   // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    "处理上限", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

/// 回给 Claude Code 的一个错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnthropicError {
    /// HTTP 状态码。
    pub status: u16,
    /// Anthropic 的错误类型，如 `invalid_request_error`。
    pub error_type: &'static str,
    pub message: String,
    /// `x-should-retry` 头；None 表示不发。
    pub should_retry: Option<bool>,
    /// `retry-after` 头（整数秒）。
    pub retry_after: Option<u64>,
}

impl AnthropicError {
    pub fn new(status: u16, error_type: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            error_type,
            message: message.into(),
            should_retry: None,
            retry_after: None,
        }
    }

    fn no_retry(mut self) -> Self {
        self.should_retry = Some(false);
        self
    }

    /// 令牌缺失或不对。
    pub fn bad_token() -> Self {
        Self::new(
            401,
            "authentication_error",
            sophia_core::t!("models.router.badToken"),
        )
        .no_retry()
    }

    /// 模型未命中 / Claude 没打开（清单不存在）。
    pub fn model_not_selected(model: &str) -> Self {
        Self::new(
            404,
            "not_found_error",
            sophia_core::t!("models.router.modelNotSelected", model = model),
        )
        .no_retry()
    }

    /// 网关已删掉、地址不可用或服务商密钥取不到（R13）。
    pub fn gateway_unavailable() -> Self {
        Self::internal(&sophia_core::t!("models.router.gatewayUnavailable"))
    }

    /// 请求体不合法。
    pub fn invalid_request(message: &str) -> Self {
        Self::new(400, "invalid_request_error", message)
    }

    /// 清单读不懂、密钥取不到、网关地址不可用：重试也没用。
    pub fn internal(message: &str) -> Self {
        Self::new(500, "api_error", message).no_retry()
    }

    /// 连不上上游、上游超时。
    pub fn upstream_unreachable(message: &str) -> Self {
        Self::new(502, "api_error", message)
    }

    /// 响应体（`content-type: application/json`）。
    pub fn body(&self) -> Vec<u8> {
        self.wire().to_string().into_bytes()
    }

    /// 除 `content-type` 外要带的响应头。
    pub fn headers(&self) -> Vec<(&'static str, String)> {
        let mut headers = Vec::new();
        if let Some(retry) = self.should_retry {
            headers.push(("x-should-retry", retry.to_string()));
        }
        if let Some(seconds) = self.retry_after {
            headers.push(("retry-after", seconds.to_string()));
        }
        headers
    }

    /// 流已开始后的 `event: error`。
    pub fn to_event(&self) -> SseEvent {
        SseEvent {
            name: "error".to_string(),
            data: self.wire(),
        }
    }

    fn wire(&self) -> Value {
        json!({ "type": "error", "error": { "type": self.error_type, "message": self.message } })
    }
}

/// 上游的非 2xx 响应（流开始之前）。
#[derive(Debug, Clone, Copy)]
pub struct UpstreamFailure<'a> {
    pub status: u16,
    pub body: &'a [u8],
    /// 上游的 `retry-after` 头（秒或 HTTP 日期）。
    pub retry_after: Option<&'a str>,
    /// 上游的 `retry-after-ms` 头。
    pub retry_after_ms: Option<&'a str>,
}

/// 上游错误 → 回给 Claude Code 的错误（R26 表）。`gateway` 是网关短名（用于密钥被拒的提示），
/// `secret` 是这家网关的服务商密钥，原文里出现的一律换成 `***`。
pub fn map_upstream_error(
    failure: &UpstreamFailure<'_>,
    gateway: &str,
    secret: &str,
    now: SystemTime,
) -> AnthropicError {
    let scrub = |text: String| {
        if secret.is_empty() {
            text
        } else {
            text.replace(secret, "***")
        }
    };
    // 识别看原文（不外传）；回给客户端的文字才打码
    let overflow = is_context_overflow(&String::from_utf8_lossy(failure.body));
    let message = scrub(readable_upstream_message(failure.body));
    match failure.status {
        400 | 422 if overflow => AnthropicError::new(
            400,
            "invalid_request_error",
            format!("prompt is too long: {message}"),
        ),
        // 不回 401：免得 Claude Code 当成自己的登录失效
        401 | 403 => AnthropicError::new(
            403,
            "permission_error",
            sophia_core::t!(
                "models.router.keyRejected",
                gateway = gateway,
                message = message
            ),
        )
        .no_retry(),
        404 => AnthropicError::new(404, "not_found_error", message),
        413 => AnthropicError::new(413, "request_too_large", message),
        429 => {
            let mut error = AnthropicError::new(429, "rate_limit_error", message);
            error.retry_after =
                retry_after_seconds(failure.retry_after, failure.retry_after_ms, now);
            error
        }
        502..=504 => AnthropicError::new(529, "overloaded_error", message),
        500..=599 => AnthropicError::new(500, "api_error", message),
        // 表里的「其它 400 / 422」；402 等其它 4xx 同样按请求问题处理
        400..=499 => AnthropicError::new(400, "invalid_request_error", message),
        _ => AnthropicError::new(502, "api_error", message),
    }
}

/// 原文像上下文超长吗（大小写不敏感的子串匹配）。
pub fn is_context_overflow(text: &str) -> bool {
    let lower = text.to_lowercase();
    CONTEXT_OVERFLOW_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// 从各家形状的错误体里取给人看的文字。认 `{"error":{"message"}}`、`{"error":"…"}`
/// （ap-gateway 的 `error` 是再编码一层的 JSON 字符串）、`message` / `detail`，并接上 `user_tip`。
pub fn readable_upstream_message(body: &[u8]) -> String {
    const MAX_CHARS: usize = 2000;
    let text = String::from_utf8_lossy(body);
    let Ok(doc) = serde_json::from_slice::<Value>(body) else {
        return text.trim().chars().take(MAX_CHARS).collect();
    };
    let mut parts = Vec::new();
    if let Some(message) = message_in(&doc) {
        parts.push(message);
    }
    if let Some(tip) = doc.get("user_tip").and_then(Value::as_str).map(str::trim) {
        if !tip.is_empty() {
            parts.push(tip.to_string());
        }
    }
    if parts.is_empty() {
        return text.trim().chars().take(MAX_CHARS).collect();
    }
    sophia_core::i18n::list_text(&parts, sophia_core::i18n::ListStyle::Semicolon)
}

fn message_in(doc: &Value) -> Option<String> {
    let non_empty = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    match doc.get("error") {
        Some(Value::String(inner)) => {
            let nested = serde_json::from_str::<Value>(inner.trim())
                .ok()
                .and_then(|nested| message_in(&nested));
            if let Some(nested) = nested {
                return Some(nested);
            }
            if !inner.trim().is_empty() {
                return Some(inner.trim().to_string());
            }
        }
        Some(error @ Value::Object(_)) => {
            if let Some(message) = non_empty(error.get("message")) {
                return Some(message);
            }
        }
        _ => {}
    }
    non_empty(doc.get("message")).or_else(|| non_empty(doc.get("detail")))
}

/// `retry-after-ms`（更精确，优先）或 `retry-after`（秒数或 IMF-fixdate）→ 向上取整的秒数。
pub fn retry_after_seconds(
    retry_after: Option<&str>,
    retry_after_ms: Option<&str>,
    now: SystemTime,
) -> Option<u64> {
    let ceil_seconds =
        |value: f64| (value.is_finite() && value >= 0.0).then(|| value.ceil() as u64);
    if let Some(ms) = retry_after_ms.and_then(|ms| ms.trim().parse::<f64>().ok()) {
        if let Some(seconds) = ceil_seconds(ms / 1000.0) {
            return Some(seconds);
        }
    }
    let value = retry_after?.trim();
    if let Ok(seconds) = value.parse::<f64>() {
        return ceil_seconds(seconds);
    }
    let at = parse_http_date(value)?;
    let now = now.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(at.saturating_sub(now))
}

/// IMF-fixdate（`Wed, 21 Oct 2026 07:28:00 GMT`）→ Unix 秒。
fn parse_http_date(text: &str) -> Option<u64> {
    let fields: Vec<&str> = text.split_whitespace().collect();
    let [_, day, month, year, time, "GMT"] = fields.as_slice() else {
        return None;
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS.iter().position(|name| name == month)? as i64 + 1;
    let day: i64 = day.parse().ok()?;
    let year: i64 = year.parse().ok()?;
    let clock: Vec<i64> = time
        .split(':')
        .map(|part| part.parse().ok())
        .collect::<Option<_>>()?;
    let [hour, minute, second] = clock.as_slice() else {
        return None;
    };
    // Howard Hinnant 的 days_from_civil
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(seconds).ok()
}

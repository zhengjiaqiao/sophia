//! Claude 命名空间（spec 2026-09-29-claude-third-party-models R11–R16、R22–R27 的路由接线）。
//!
//! 桌面应用写进 profile 的网关地址是 `http://127.0.0.1:<port>/claude`：路径以 `/claude` 开头的请求归家 `claude`，
//! 去掉前缀后按 Anthropic 的端点分派；不带前缀、却长得像 Anthropic 的散请求一律 404。两种都**绝不**进入
//! Codex 的分流与官方转发（`forward_native`）：那条路会把请求内容与令牌原样发到 OpenAI。
//!
//! 形状转换全在 `translate::anthropic`（纯同步）；这里只管鉴权、查清单、收发字节、保活计时与日志。
use super::{
    decode_zstd, describe, header_str, log_safe, parse_provider_base, path_is_safe, read_limited,
    resolve_target, send_with_connect_retry, Agent, Body, BoxError, LoggedEntry, Protocol, Route,
    Router, UpstreamBody,
};
use crate::translate::anthropic::{
    self as anthropic, AnthropicEmitter, AnthropicError, ChatEvents, Keepalive, MessageAggregator,
    ResponsesEvents, StructuredOutput, ThinkingOff, UpstreamEvent, UpstreamFailure,
    UpstreamOptions, UpstreamRequest,
};
use crate::translate::{rejects_reasoning_effort, SseEvent};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::header::HeaderMap;
use hyper::{Method, Response, StatusCode};
use serde_json::Value;
use sophia_core::claude_models::desktop::{FIRST_ROLE, HAIKU_ROLE};
use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// 家 `claude` 的路径前缀（R11）
pub const PREFIX: &str = "/claude";
/// 桌面应用渲染进程发出的请求带的来源（R13）：网页里的脚本造不出它
pub const APP_ORIGIN: &str = "app://localhost";
/// 令牌缓存多久（同 `CachedKeys` 的 30 秒）
const TOKEN_TTL: Duration = Duration::from_secs(30);
/// 令牌比对不上时绕过缓存重读，同一进程每秒至多一次（R12）
const FORCED_TOKEN_GAP: Duration = Duration::from_secs(1);
/// 上游错误体读多少（同 Codex 路径）
const ERROR_BODY_LIMIT: usize = 1 << 20;
/// 非流式请求收齐上游的上限（同 Codex 路径）
const AGGREGATE_LIMIT: usize = 16 << 20;

/// 请求落在哪个命名空间（R11）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Namespace {
    /// 今天的行为，逐字节不变
    Codex,
    /// `/claude` 前缀
    Claude,
    /// 没带前缀的 Anthropic 形状请求：404，不转发、不读请求体
    Stray,
}

/// 按路径与请求头定命名空间。`/_health`、`/_status` 在任何命名空间判定之前，归 Codex 那一套来源校验
pub(super) fn namespace(path: &str, headers: &HeaderMap) -> Namespace {
    if path == "/_health" || path == "/_status" {
        return Namespace::Codex;
    }
    let lower = path.to_ascii_lowercase();
    if lower == PREFIX || lower.starts_with("/claude/") {
        return Namespace::Claude;
    }
    if lower == "/v1/messages"
        || lower.starts_with("/v1/messages/")
        || lower.starts_with("/api/")
        || headers.contains_key("anthropic-version")
        || headers.contains_key("x-api-key")
    {
        return Namespace::Stray;
    }
    Namespace::Codex
}

/// Claude 命名空间的来源校验（R13）：不带 `Origin` 时同 Codex（`Sec-Fetch-Site` 为空或 `none`）；
/// 带的话必须恰是一个 `app://localhost`，此时 `Sec-Fetch-Site` 不限（从 `app://` 发往回环会被标成 cross-site）
pub(super) fn origin_allowed(headers: &HeaderMap) -> bool {
    let origins: Vec<_> = headers.get_all("origin").iter().collect();
    match origins.as_slice() {
        [] => {
            let site = header_str(headers, "sec-fetch-site")
                .trim()
                .to_ascii_lowercase();
            site.is_empty() || site == "none"
        }
        [origin] => origin.as_bytes() == APP_ORIGIN.as_bytes(),
        _ => false,
    }
}

fn has_app_origin(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .is_some_and(|origin| origin.as_bytes() == APP_ORIGIN.as_bytes())
}

/// Claude 命名空间被来源校验拒绝
pub(super) fn forbidden() -> Response<Body> {
    error_response(
        &AnthropicError::new(
            403,
            "permission_error",
            "router only accepts requests from local agents",
        ),
        false,
    )
}

/// 不带 `/claude` 前缀的 Anthropic 形状请求
pub(super) fn stray() -> Response<Body> {
    error_response(&not_found(&sophia_core::t!("models.router.stray")), false)
}

fn not_found(message: &str) -> AnthropicError {
    let mut error = AnthropicError::new(404, "not_found_error", message);
    error.should_retry = Some(false);
    error
}

// ───────────────────────── 令牌 ─────────────────────────

/// 读令牌（钥匙串 `claude-router-token`）。没有令牌返回 Err
pub type TokenSource = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

/// 令牌缓存（R12）：30 秒；比对不上时绕过缓存重读一次（每秒至多一次），让刚生成的令牌立即可用，
/// 又不让一串错令牌请求把钥匙串读取放大。读取时持锁：并发的十几个请求只读一次。
/// 会阻塞（锁 + 子进程），调用方在阻塞线程池里调 [`accepts`](Self::accepts)
pub(super) struct TokenCache {
    fetch: TokenSource,
    state: Mutex<TokenState>,
}

#[derive(Default)]
struct TokenState {
    /// 上次读到的令牌与读取时刻；钥匙串里没有令牌（`None`）同样缓存，免得只用 Codex 时每个请求都起子进程
    value: Option<(Option<String>, Instant)>,
    forced_at: Option<Instant>,
}

impl TokenCache {
    pub(super) fn new(fetch: TokenSource) -> Self {
        Self {
            fetch,
            state: Mutex::default(),
        }
    }

    /// `Authorization: Bearer <t>` 或 `x-api-key: <t>` 任一个等于令牌即通过
    pub(super) fn accepts(&self, headers: &HeaderMap) -> bool {
        let presented = presented_credentials(headers);
        if presented.is_empty() {
            return false;
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let cached = state
            .value
            .as_ref()
            .filter(|(_, at)| now.saturating_duration_since(*at) < TOKEN_TTL)
            .map(|(token, _)| token.clone());
        let fetched_now = cached.is_none();
        let token = match cached {
            Some(token) => token,
            None => self.refresh(&mut state, now),
        };
        if token.is_some_and(|token| matches_any(&token, &presented)) {
            return true;
        }
        if fetched_now
            || state
                .forced_at
                .is_some_and(|at| now.saturating_duration_since(at) < FORCED_TOKEN_GAP)
        {
            return false;
        }
        state.forced_at = Some(now);
        self.refresh(&mut state, now)
            .is_some_and(|token| matches_any(&token, &presented))
    }

    fn refresh(&self, state: &mut TokenState, now: Instant) -> Option<String> {
        let token = (self.fetch)()
            .ok()
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty());
        state.value = Some((token.clone(), now));
        token
    }
}

/// 入站带的凭证：`Authorization` 的 Bearer 值与 `x-api-key`（可能两个都有、值不同：P0 实测）
fn presented_credentials(headers: &HeaderMap) -> Vec<String> {
    let mut out = Vec::new();
    for value in headers.get_all("authorization") {
        let Ok(text) = value.to_str() else { continue };
        let text = text.trim();
        if let Some((scheme, rest)) = text.split_once(' ') {
            if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
                out.push(rest.trim().to_owned());
            }
        }
    }
    for value in headers.get_all("x-api-key") {
        if let Ok(text) = value.to_str() {
            if !text.trim().is_empty() {
                out.push(text.trim().to_owned());
            }
        }
    }
    out
}

fn matches_any(token: &str, presented: &[String]) -> bool {
    // 逐个比完，不因先比中而提前返回
    presented
        .iter()
        .fold(false, |hit, candidate| same_secret(token, candidate) | hit)
}

/// 常量时间比较（长度不同直接不等：长度不是秘密）
fn same_secret(expected: &str, presented: &str) -> bool {
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ───────────────────────── 清单 ─────────────────────────

/// Claude 清单里的一家上游（不含密钥）
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub(super) struct CatalogProvider {
    pub id: String,
    /// 网关短名：密钥被拒时的提示里用
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub protocol: String,
}

/// Claude 清单里的一个角色：`slug` 是角色 id
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub(super) struct CatalogModel {
    pub slug: String,
    #[serde(default)]
    pub upstream_model: String,
    #[serde(default)]
    pub provider: String,
    /// `labelOverride` 同值
    #[serde(default)]
    pub label: String,
}

/// `<data_dir>/gateway/claude-routing.json`，每个请求重读
pub(super) struct ClaudeCatalog {
    providers: HashMap<String, CatalogProvider>,
    /// 按 `inferenceModels` 的顺序
    models: Vec<CatalogModel>,
}

impl ClaudeCatalog {
    /// 文件不存在（Claude 没打开，或旧 plist 没给路径）→ `Ok(None)`；读不懂 → Err
    fn load(path: Option<&Path>) -> Result<Option<Self>, String> {
        #[derive(serde::Deserialize)]
        struct Doc {
            #[serde(default)]
            providers: Vec<CatalogProvider>,
            #[serde(default)]
            models: Vec<CatalogModel>,
        }
        let Some(path) = path else { return Ok(None) };
        let data = match std::fs::read(path) {
            Ok(data) => data,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let doc: Doc = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        let mut providers = HashMap::new();
        for provider in doc.providers {
            // 同一个 id 出现两次时以先出现的为准（同 Codex 清单）
            providers.entry(provider.id.clone()).or_insert(provider);
        }
        Ok(Some(Self {
            providers,
            models: doc.models,
        }))
    }

    fn find(&self, role: &str) -> Option<&CatalogModel> {
        self.models
            .iter()
            .find(|m| m.slug.trim().eq_ignore_ascii_case(role))
    }

    /// R14：去掉结尾的 `[1m]` 后按清单里的 id 精确匹配（`claude-sonnet-5`、`-r2`…、`claude-haiku-4-5`）；不中按关键词
    /// 回落（第二项为真表示回落了）：含 `haiku` → 占 `claude-haiku-4-5` 的那个，清单里没有（只选了一个）就第一个；
    /// 含 `opus` / `sonnet` / `fable` / `mythos` → 第一个（`claude-sonnet-5`，Claude 的初始默认）
    fn resolve(&self, model: &str) -> Option<(&CatalogModel, bool)> {
        let lower = model.trim().to_lowercase();
        let name = lower.strip_suffix("[1m]").unwrap_or(&lower).trim();
        if let Some(found) = self.find(name) {
            return Some((found, false));
        }
        let first = || self.find(FIRST_ROLE).or_else(|| self.models.first());
        let found = if name.contains("haiku") {
            self.find(HAIKU_ROLE).or_else(first)
        } else if ["opus", "sonnet", "fable", "mythos"]
            .iter()
            .any(|word| name.contains(word))
        {
            first()
        } else {
            return None;
        };
        found.map(|found| (found, true))
    }
}

// ───────────────────────── 分派 ─────────────────────────

/// 一个 Claude 请求的日志与 CORS 上下文
struct Ctx {
    router: Arc<Router>,
    started: Instant,
    method: String,
    path: String,
    model: String,
    /// 日志行末尾的附加字段（关键词回落时记下落到哪个角色）
    extra: String,
    cors: bool,
}

impl Ctx {
    fn log(&self, status: u16, result: &str) {
        self.router.log.write(
            self.started,
            Agent::Claude.as_str(),
            self.method.as_str(),
            &self.path,
            &self.model,
            Route::Claude,
            status,
            result,
            &self.extra,
            None,
        );
    }

    fn fail(&self, error: AnthropicError, result: &str) -> Response<Body> {
        if result == "upstream_error" {
            // 上游的原话（已抹掉密钥）记进日志：桌面应用只报「模型不可用」，不看这一句查不出是哪个参数被拒
            //（2026-09-30 真机：openrouter 回 400，桌面应用的 Details 里没有原因）
            let extra = format!("{} reason={}", self.extra, log_safe(&error.message));
            self.router.log.write(
                self.started,
                Agent::Claude.as_str(),
                self.method.as_str(),
                &self.path,
                &self.model,
                Route::Claude,
                error.status,
                result,
                &extra,
                None,
            );
        } else {
            self.log(error.status, result);
        }
        if error.status >= 500 {
            self.router
                .counters
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
        }
        error_response(&error, self.cors)
    }

    fn respond(
        &self,
        status: StatusCode,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Response<Body> {
        self.log(status.as_u16(), "ok");
        let mut builder = Response::builder().status(status);
        if let Some(content_type) = content_type {
            builder = builder.header("content-type", content_type);
        }
        with_cors(builder, self.cors)
            .body(full(body))
            .expect("static response")
    }
}

/// Claude 命名空间的一个请求。来源校验已在调用方做过；路径以 `/claude` 开头（大小写不敏感）
pub(super) async fn handle(
    router: Arc<Router>,
    parts: hyper::http::request::Parts,
    raw_body: Bytes,
) -> Response<Body> {
    let path = parts.uri.path().to_owned();
    let mut ctx = Ctx {
        router: router.clone(),
        started: Instant::now(),
        method: parts.method.to_string(),
        path: path.clone(),
        model: String::new(),
        extra: String::new(),
        cors: has_app_origin(&parts.headers),
    };
    if !path_is_safe(&path) {
        // 路径只按固定的几个端点精确匹配，不拼进上游地址；不认识的一律 404
        return ctx.fail(
            not_found(&sophia_core::t!("models.router.noEndpoint")),
            "not_found",
        );
    }
    // 去掉前缀后的路径；前缀按字节长度切（前缀是 ASCII，大小写不敏感匹配过）
    let sub = path[PREFIX.len()..].to_owned();
    let method = parts.method.clone();

    if method == Method::OPTIONS {
        return preflight(&ctx, &parts.headers);
    }
    if sub == "/api/hello" && (method == Method::HEAD || method == Method::GET) {
        // 客户端启动时的可用性探测，不带凭证（P0）
        let body = if method == Method::GET {
            b"{}".to_vec()
        } else {
            Vec::new()
        };
        return ctx.respond(StatusCode::OK, Some("application/json"), body);
    }
    // 比对令牌可能要读钥匙串（起 `security` 子进程，且持锁让并发请求只读一次）：放到阻塞线程池里做，
    // 不让一串并发请求把运行时的工作线程全卡在锁上，连带 Codex 的请求一起停
    let accepted = {
        let router = Arc::clone(&router);
        let headers = parts.headers.clone();
        tokio::task::spawn_blocking(move || router.token.accepts(&headers))
            .await
            .unwrap_or(false)
    };
    if !accepted {
        return ctx.fail(AnthropicError::bad_token(), "auth_error");
    }
    match (method, sub.as_str()) {
        (Method::POST, "/v1/messages") => messages(&mut ctx, &parts, &raw_body).await,
        (Method::POST, "/v1/messages/count_tokens") => count_tokens(&mut ctx, &parts, &raw_body),
        (Method::GET, "/v1/models") => models(&ctx),
        _ => ctx.fail(
            not_found(&sophia_core::t!("models.router.noEndpoint")),
            "not_found",
        ),
    }
}

/// R13：跨源预检。只认 `app://localhost`，不要求令牌
fn preflight(ctx: &Ctx, headers: &HeaderMap) -> Response<Body> {
    if !has_app_origin(headers) {
        ctx.log(403, "forbidden");
        return forbidden();
    }
    ctx.log(204, "preflight");
    let mut builder = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("access-control-allow-origin", APP_ORIGIN)
        .header("access-control-allow-methods", "GET, POST, HEAD, OPTIONS")
        .header("access-control-max-age", "600")
        .header("vary", "Origin");
    for value in headers.get_all("access-control-request-headers") {
        builder = builder.header("access-control-allow-headers", value);
    }
    builder.body(full(Vec::new())).expect("static response")
}

/// 请求体：只认不压缩与 zstd（同 Codex 路径）
fn decode_body(
    parts: &hyper::http::request::Parts,
    raw: &Bytes,
    limit: usize,
) -> Result<Bytes, AnthropicError> {
    if raw.len() > limit {
        return Err(AnthropicError::new(
            413,
            "request_too_large",
            "request body too large",
        ));
    }
    let encodings: Vec<_> = parts.headers.get_all("content-encoding").iter().collect();
    let encoding = match encodings.as_slice() {
        [] => String::new(),
        [single] => single
            .to_str()
            .map_or_else(|_| "?".to_owned(), |v| v.trim().to_ascii_lowercase()),
        _ => "?".to_owned(),
    };
    match encoding.as_str() {
        "" | "identity" => Ok(raw.clone()),
        "zstd" => decode_zstd(raw, limit).map(Bytes::from).map_err(|e| {
            AnthropicError::invalid_request(&format!("decompress zstd request body: {e}"))
        }),
        _ => Err(AnthropicError::new(
            415,
            "invalid_request_error",
            "unsupported Content-Encoding",
        )),
    }
}

/// 读清单：不存在 → 404；读不懂 → 500（第二项是日志里的结果）
fn catalog(ctx: &Ctx, model: &str) -> Result<ClaudeCatalog, (AnthropicError, &'static str)> {
    match ClaudeCatalog::load(ctx.router.claude_routing_path.as_deref()) {
        Ok(Some(catalog)) => Ok(catalog),
        Ok(None) => Err((AnthropicError::model_not_selected(model), "no_catalog")),
        Err(e) => Err((
            AnthropicError::internal(&sophia_core::t!(
                "models.router.catalogUnreadable",
                error = e
            )),
            "catalog_error",
        )),
    }
}

/// R15：本地估算，不联网；模型未命中同样 404
fn count_tokens(ctx: &mut Ctx, parts: &hyper::http::request::Parts, raw: &Bytes) -> Response<Body> {
    let body = match decode_body(parts, raw, ctx.router.max_body_bytes) {
        Ok(body) => body,
        Err(error) => return ctx.fail(error, "request_error"),
    };
    let model = match anthropic::request_model(&body) {
        Ok(model) => model,
        Err(e) => {
            return ctx.fail(
                AnthropicError::invalid_request(&e.to_string()),
                "request_error",
            )
        }
    };
    ctx.model = model.clone();
    let catalog = match catalog(ctx, &model) {
        Ok(catalog) => catalog,
        Err((error, result)) => return ctx.fail(error, result),
    };
    if catalog.resolve(&model).is_none() {
        return ctx.fail(AnthropicError::model_not_selected(&model), "unknown_model");
    }
    match anthropic::count_tokens_response(&body) {
        Ok(json) => ctx.respond(StatusCode::OK, Some("application/json"), json),
        Err(e) => ctx.fail(
            AnthropicError::invalid_request(&e.to_string()),
            "request_error",
        ),
    }
}

/// R16：按 `inferenceModels` 的顺序逐项列出
fn models(ctx: &Ctx) -> Response<Body> {
    let catalog = match ClaudeCatalog::load(ctx.router.claude_routing_path.as_deref()) {
        Ok(Some(catalog)) => catalog,
        // Claude 没打开，或旧 plist 没给清单路径（R10：Claude 命名空间一律 404）
        Ok(None) => {
            return ctx.fail(
                not_found(&sophia_core::t!("models.router.claudeOff")),
                "no_catalog",
            )
        }
        Err(e) => {
            return ctx.fail(
                AnthropicError::internal(&sophia_core::t!(
                    "models.router.catalogUnreadable",
                    error = e
                )),
                "catalog_error",
            )
        }
    };
    let data: Vec<Value> = catalog
        .models
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "type": "model",
                "id": m.slug,
                "display_name": m.label,
                "created_at": "1970-01-01T00:00:00Z",
            })
        })
        .collect();
    let first = data.first().map(|m| m["id"].clone()).unwrap_or(Value::Null);
    let last = data.last().map(|m| m["id"].clone()).unwrap_or(Value::Null);
    let body =
        serde_json::json!({"data": data, "has_more": false, "first_id": first, "last_id": last});
    ctx.respond(
        StatusCode::OK,
        Some("application/json"),
        body.to_string().into_bytes(),
    )
}

/// R14：`POST /v1/messages`
async fn messages(
    ctx: &mut Ctx,
    parts: &hyper::http::request::Parts,
    raw: &Bytes,
) -> Response<Body> {
    let router = ctx.router.clone();
    let body = match decode_body(parts, raw, router.max_body_bytes) {
        Ok(body) => body,
        Err(error) => return ctx.fail(error, "request_error"),
    };
    let model = match anthropic::request_model(&body) {
        Ok(model) => model,
        Err(e) => {
            return ctx.fail(
                AnthropicError::invalid_request(&e.to_string()),
                "request_error",
            )
        }
    };
    ctx.model = model.clone();
    let catalog = match catalog(ctx, &model) {
        Ok(catalog) => catalog,
        Err((error, result)) => return ctx.fail(error, result),
    };
    let Some((entry, fallback)) = catalog.resolve(&model) else {
        return ctx.fail(AnthropicError::model_not_selected(&model), "unknown_model");
    };
    if fallback {
        // 桌面应用的子任务会点名带日期的官方名：记下它落到了哪个角色（原名在 model 一栏）
        ctx.extra = format!(" fallback={}", log_safe(&entry.slug));
    }
    let unavailable = |ctx: &Ctx| ctx.fail(AnthropicError::gateway_unavailable(), "provider_error");
    let Some(provider) = catalog.providers.get(entry.provider.trim()) else {
        return unavailable(ctx);
    };
    let Ok(base) = parse_provider_base(&provider.base_url) else {
        return unavailable(ctx);
    };
    let key = match (router.third_party_key)(Agent::Claude, entry.provider.trim()) {
        Ok(key) if !key.trim().is_empty() => key.trim().to_owned(),
        _ => return unavailable(ctx),
    };
    let upstream_model = if entry.upstream_model.trim().is_empty() {
        model.as_str()
    } else {
        entry.upstream_model.trim()
    };
    let protocol = if provider.protocol == "responses" {
        Protocol::Responses
    } else {
        Protocol::Chat
    };
    let gateway_name = if provider.name.trim().is_empty() {
        provider.id.clone()
    } else {
        provider.name.trim().to_owned()
    };
    let mut options = UpstreamOptions {
        structured_output: StructuredOutput::ResponseFormat,
        thinking_off: ThinkingOff::detect(&provider.base_url),
        omit_reasoning_effort: false,
    };
    let wants_format = serde_json::from_slice::<Value>(&body)
        .ok()
        .is_some_and(|doc| doc.pointer("/output_config/format").is_some());

    // 上游 400 后各有一次改形重发的机会，互不占用：
    // 0. 这次发了「关推理」的字段且上游说推理不能关 → 不再关，重发；
    // 1. 这次发了 `reasoning_effort` 且错误点名了它 → 去掉它（保留 response_format）重发；
    // 2. 带 `output_config.format` 且不是上下文超长 → 改「只写说明」重发。
    // 0 与 1 互斥（关推理只在明说不要思考时发，推理强度只在要了思考时发），所以最多发三次。
    let mut effort_retried = false;
    let mut thinking_off_retried = false;
    let mut format_retried = false;
    let (response, translated) = loop {
        let translated = match translate(protocol, &body, upstream_model, &options) {
            Ok(translated) => translated,
            Err(error) => return ctx.fail(error, "request_error"),
        };
        let suffix = match protocol {
            Protocol::Chat => "/chat/completions",
            Protocol::Responses => "/responses",
        };
        let request = router
            .third_party
            .post(resolve_target(&base, suffix, ""))
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .header("authorization", format!("Bearer {key}"))
            .header("user-agent", USER_AGENT)
            .body(translated.body.clone());
        let response = match send_with_connect_retry(request).await {
            Ok(response) => response,
            Err(e) => {
                return ctx.fail(
                    AnthropicError::upstream_unreachable(&sophia_core::t!(
                        "models.router.upstreamUnreachable",
                        gateway = gateway_name,
                        error = describe(&e)
                    )),
                    "upstream_error",
                )
            }
        };
        let status = response.status();
        if status.is_redirection() {
            return ctx.fail(
                AnthropicError::upstream_unreachable(
                    "third-party gateway answered with a redirect, which is not followed",
                ),
                "upstream_error",
            );
        }
        if status.is_success() {
            break (response, translated);
        }
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let (retry_after, retry_after_ms) = (header("retry-after"), header("retry-after-ms"));
        let failure_body = read_limited(response, ERROR_BODY_LIMIT).await;
        if translated.thinking_off_sent
            && !thinking_off_retried
            && anthropic::rejects_thinking_off(status.as_u16(), &failure_body)
        {
            // 上游不许关推理（OpenRouter 上有的模型推理是必开的）：不再发「关推理」，重发一次
            thinking_off_retried = true;
            options.thinking_off = ThinkingOff::Omit;
            continue;
        }
        if translated.reasoning_effort_sent
            && !effort_retried
            && rejects_reasoning_effort(status.as_u16(), &failure_body)
        {
            // 上游不认 reasoning_effort：去掉它重发一次
            effort_retried = true;
            options.omit_reasoning_effort = true;
            continue;
        }
        if status == StatusCode::BAD_REQUEST
            && wants_format
            && !format_retried
            && !anthropic::is_context_overflow(&String::from_utf8_lossy(&failure_body))
        {
            // 上游不认 response_format：改用「只写说明」重发一次，再失败的结果原样按 R27 回
            format_retried = true;
            options.structured_output = StructuredOutput::PromptOnly;
            continue;
        }
        let error = anthropic::map_upstream_error(
            &UpstreamFailure {
                status: status.as_u16(),
                body: &failure_body,
                retry_after: retry_after.as_deref(),
                retry_after_ms: retry_after_ms.as_deref(),
            },
            &gateway_name,
            &key,
            SystemTime::now(),
        );
        *router.counters.last.lock().unwrap() = (
            model.clone(),
            Route::Claude.name().to_owned(),
            status.as_u16(),
        );
        return ctx.fail(error, "upstream_error");
    };

    router.counters.claude.fetch_add(1, Ordering::Relaxed);
    *router.counters.last.lock().unwrap() = (model.clone(), Route::Claude.name().to_owned(), 200);
    let parser = match protocol {
        Protocol::Chat => Parser::Chat(ChatEvents::new()),
        Protocol::Responses => Parser::Responses(ResponsesEvents::new()),
    };
    let emitter = AnthropicEmitter::new(&model, translated.input_estimate, translated.tools);
    let upstream: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>> =
        Box::pin(response.bytes_stream());

    if !translated.stream {
        return aggregate(ctx, upstream, parser, emitter).await;
    }

    let state = StreamState {
        upstream,
        parser,
        emitter,
        keepalive: Keepalive::new(router.keepalive, Instant::now()),
        started: false,
        done: false,
    };
    let stream = futures_util::stream::unfold(state, |mut state| async move {
        state
            .next_chunk()
            .await
            .map(|text| (Ok::<_, BoxError>(Bytes::from(text)), state))
    });
    let body: UpstreamBody = Box::pin(stream);
    let response = with_cors(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache"),
        ctx.cors,
    )
    .body(body)
    .expect("static headers");
    let logged = LoggedEntry {
        log: router.log.clone(),
        counters: router.counters.clone(),
        started: ctx.started,
        method: ctx.method.clone(),
        path: ctx.path.clone(),
        model: ctx.model.clone(),
        route: Route::Claude,
        status: 200,
        extra: ctx.extra.clone(),
    };
    response.map(|body| logged.wrap(body))
}

/// 出站请求的 `user-agent`：Sophia 自己的，不冒充官方客户端
const USER_AGENT: &str = concat!("Sophia-gateway/", env!("CARGO_PKG_VERSION"));

fn translate(
    protocol: Protocol,
    body: &[u8],
    upstream_model: &str,
    options: &UpstreamOptions,
) -> Result<UpstreamRequest, AnthropicError> {
    let translated = match protocol {
        Protocol::Chat => anthropic::to_chat(body, upstream_model, options),
        Protocol::Responses => anthropic::to_responses(body, upstream_model, options),
    };
    translated.map_err(|e| AnthropicError::invalid_request(&e.to_string()))
}

enum Parser {
    Chat(ChatEvents),
    Responses(ResponsesEvents),
}

impl Parser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<UpstreamEvent> {
        match self {
            Parser::Chat(parser) => parser.feed_bytes(chunk),
            Parser::Responses(parser) => parser.feed_bytes(chunk),
        }
    }
    fn finish(&mut self) -> Vec<UpstreamEvent> {
        match self {
            Parser::Chat(parser) => parser.finish(),
            Parser::Responses(parser) => parser.finish(),
        }
    }
}

/// 流式：`message_start` 立刻写出，之后上游来一块转一块；静默超过保活间隔就写一个 `ping`（R24）
struct StreamState {
    upstream: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    parser: Parser,
    emitter: AnthropicEmitter,
    keepalive: Keepalive,
    started: bool,
    done: bool,
}

impl StreamState {
    /// 下一段要写给客户端的文字；None 表示流结束（正常收尾或已发 `error`）
    async fn next_chunk(&mut self) -> Option<String> {
        if self.done {
            return None;
        }
        if !self.started {
            self.started = true;
            let events = self.emitter.start();
            self.keepalive.record_write(Instant::now());
            return Some(sse_text(&events));
        }
        loop {
            let wait = self.keepalive.remaining(Instant::now());
            let events: Vec<SseEvent> = match tokio::time::timeout(wait, self.upstream.next()).await
            {
                Err(_) => {
                    if let Some(ping) = self.keepalive.poll(Instant::now()) {
                        return Some(ping.to_sse_string());
                    }
                    continue;
                }
                Ok(Some(Ok(chunk))) => {
                    let upstream = self.parser.feed(&chunk);
                    upstream
                        .into_iter()
                        .flat_map(|event| self.emitter.on_event(event))
                        .collect()
                }
                // 断流：发 error 后关闭，不补收尾事件（不能把截断的回答伪装成完整回答）
                Ok(Some(Err(_))) => self
                    .emitter
                    .fail("the third-party stream was interrupted", false),
                Ok(None) => {
                    let mut events: Vec<SseEvent> = self
                        .parser
                        .finish()
                        .into_iter()
                        .flat_map(|event| self.emitter.on_event(event))
                        .collect();
                    events.extend(self.emitter.finish());
                    events
                }
            };
            if self.emitter.is_finished() {
                self.done = true;
            }
            if !events.is_empty() {
                self.keepalive.record_write(Instant::now());
                return Some(sse_text(&events));
            }
            if self.done {
                return None;
            }
        }
    }
}

fn sse_text(events: &[SseEvent]) -> String {
    events.iter().map(SseEvent::to_sse_string).collect()
}

fn push(events: Vec<SseEvent>, aggregator: &mut MessageAggregator) {
    for event in &events {
        aggregator.push(event);
    }
}

/// R26：客户端要非流式——上游照样流式，收齐后回一条 Message
async fn aggregate(
    ctx: &Ctx,
    mut upstream: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    mut parser: Parser,
    mut emitter: AnthropicEmitter,
) -> Response<Body> {
    let mut aggregator = MessageAggregator::new();
    push(emitter.start(), &mut aggregator);
    let mut received = 0usize;
    while !emitter.is_finished() {
        match upstream.next().await {
            Some(Ok(chunk)) => {
                received += chunk.len();
                if received > AGGREGATE_LIMIT {
                    push(
                        emitter.fail("the third-party response is too large", false),
                        &mut aggregator,
                    );
                    break;
                }
                let events: Vec<SseEvent> = parser
                    .feed(&chunk)
                    .into_iter()
                    .flat_map(|event| emitter.on_event(event))
                    .collect();
                push(events, &mut aggregator);
            }
            Some(Err(_)) => {
                push(
                    emitter.fail("the third-party stream was interrupted", false),
                    &mut aggregator,
                );
            }
            None => {
                let mut events: Vec<SseEvent> = parser
                    .finish()
                    .into_iter()
                    .flat_map(|event| emitter.on_event(event))
                    .collect();
                events.extend(emitter.finish());
                push(events, &mut aggregator);
            }
        }
    }
    match aggregator.finish() {
        Ok(message) => ctx.respond(
            StatusCode::OK,
            Some("application/json"),
            message.to_string().into_bytes(),
        ),
        Err(error) => ctx.fail(error, "upstream_error"),
    }
}

// ───────────────────────── 响应 ─────────────────────────

fn full(body: Vec<u8>) -> Body {
    Full::new(Bytes::from(body))
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn with_cors(
    builder: hyper::http::response::Builder,
    cors: bool,
) -> hyper::http::response::Builder {
    if cors {
        builder
            .header("access-control-allow-origin", APP_ORIGIN)
            .header("vary", "Origin")
    } else {
        builder
    }
}

/// Anthropic 形状的错误体，带 `x-should-retry` / `retry-after`
fn error_response(error: &AnthropicError, cors: bool) -> Response<Body> {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/json");
    for (name, value) in error.headers() {
        builder = builder.header(name, value);
    }
    with_cors(builder, cors)
        .body(full(error.body()))
        .expect("static response")
}

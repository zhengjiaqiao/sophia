//! 本机回环路由：路由清单里的模型转给第三方网关，其余请求原样转给官方上游。
//! 行为移植自 agents-manager 的 `internal/router`（Go，已在真实环境验证），
//! 后者的结构又来自 ollama 的 `internal/proxy/codex_desktop.go`（MIT）。
mod parse;
#[cfg(test)]
mod tests;

pub use parse::{log_safe, model_key, top_level_model};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::{HeaderMap, HeaderName};
use hyper::{Method, Request, Response, StatusCode};
use parse::{load_routing_catalog, replace_request_model, RoutingModel, AUTO_REVIEW_MODEL_KEY};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime};

pub const DEFAULT_CHATGPT_URL: &str = "https://chatgpt.com/backend-api/codex";
pub const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";
/// 出现在 `/_health` 的响应里，用来确认端口上跑的是本功能的路由，而不是恰好占着端口的别的程序
pub const HEALTH_SERVICE_NAME: &str = "symsync-gateway";

const DEFAULT_MAX_BODY_BYTES: usize = 64 << 20;
const MAX_TRACKED_SESSIONS: usize = 2000;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
/// 响应体只需要 `Send`：上游的字节流不是 `Sync`
pub type Body = UnsyncBoxBody<Bytes, BoxError>;
/// 每次第三方请求时取密钥；密钥不落入配置和日志
pub type KeySource = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;
/// 给定目标地址，返回要用的代理；`None` 表示直连
pub type ProxyFn = Arc<dyn Fn(&url::Url) -> Option<url::Url> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// 第三方网关原生支持 Responses，请求原样转发
    Responses,
    /// 第三方网关只支持 Chat Completions，路由负责双向转换
    Chat,
}

pub struct Config {
    /// 第三方网关接口基址；Codex 请求路径去掉 `/v1` 前缀后接在它后面
    pub third_party_url: String,
    pub third_party_protocol: Protocol,
    pub chatgpt_url: String,
    pub openai_url: String,
    /// 只含第三方模型的路由清单，每个请求重新读取
    pub routing_catalog_path: PathBuf,
    pub activity_log_path: Option<PathBuf>,
    pub third_party_key: KeySource,
    /// 0 表示用默认值
    pub max_body_bytes: usize,
    pub proxy: Option<ProxyFn>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Status {
    pub ok: bool,
    pub third_party_requests: u64,
    pub native_requests: u64,
    pub upstream_errors: u64,
    pub last_model: String,
    pub last_route: String,
    pub last_upstream_status: u16,
}

pub struct Router {
    third_party_url: url::Url,
    protocol: Protocol,
    chatgpt_url: url::Url,
    openai_url: url::Url,
    routing_catalog_path: PathBuf,
    third_party_key: KeySource,
    max_body_bytes: usize,
    // 两个上游各用各的客户端，一路不通不拖累另一路
    native: reqwest::Client,
    third_party: reqwest::Client,
    log: Arc<ActivityLog>,
    counters: Arc<Counters>,
    sessions: Mutex<HashMap<String, (bool, Instant)>>,
}

#[derive(Default)]
struct Counters {
    third_party: AtomicU64,
    native: AtomicU64,
    upstream_errors: AtomicU64,
    last: Mutex<(String, String, u16)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    ThirdParty,
    ChatGpt,
    OpenAi,
    None,
}

impl Route {
    fn name(self) -> &'static str {
        match self {
            Route::ThirdParty => "third_party",
            Route::ChatGpt => "chatgpt",
            Route::OpenAi => "openai",
            Route::None => "none",
        }
    }
}

fn parse_base(name: &str, raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| format!("parse {name} URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!("{name} URL must be an absolute http(s) URL"));
    }
    Ok(parsed)
}

fn build_client(
    proxy: &Option<ProxyFn>,
    connect_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    // 不跟随重定向（请求里带着凭据）；不自动解压（官方路径要原样透传字节）。
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if let Some(resolve) = proxy.clone() {
        builder = builder.proxy(reqwest::Proxy::custom(move |url| resolve(url)));
    }
    if let Some(timeout) = connect_timeout {
        builder = builder.connect_timeout(timeout);
    }
    builder.build().map_err(|e| e.to_string())
}

impl Router {
    pub fn new(config: Config) -> Result<Arc<Self>, String> {
        // reqwest 以“不带默认加密库”的方式编译，TLS 用 ring；进程内装一次即可，重复安装会返回 Err，忽略。
        let _ = rustls::crypto::ring::default_provider().install_default();
        let default_if_empty = |value: &str, fallback: &str| {
            if value.trim().is_empty() {
                fallback.to_owned()
            } else {
                value.to_owned()
            }
        };
        Ok(Arc::new(Self {
            third_party_url: parse_base("third-party", &config.third_party_url)?,
            protocol: config.third_party_protocol,
            chatgpt_url: parse_base(
                "ChatGPT",
                &default_if_empty(&config.chatgpt_url, DEFAULT_CHATGPT_URL),
            )?,
            openai_url: parse_base(
                "OpenAI API",
                &default_if_empty(&config.openai_url, DEFAULT_OPENAI_URL),
            )?,
            routing_catalog_path: config.routing_catalog_path,
            third_party_key: config.third_party_key,
            max_body_bytes: if config.max_body_bytes == 0 {
                DEFAULT_MAX_BODY_BYTES
            } else {
                config.max_body_bytes
            },
            native: build_client(&config.proxy, None)?,
            // 内网网关不可达时尽快失败；流式响应不设总超时
            third_party: build_client(&config.proxy, Some(Duration::from_secs(5)))?,
            log: Arc::new(ActivityLog {
                path: config.activity_log_path,
                lock: Mutex::new(()),
            }),
            counters: Arc::default(),
            sessions: Mutex::default(),
        }))
    }

    pub fn status(&self) -> Status {
        let last = self.counters.last.lock().unwrap().clone();
        Status {
            ok: true,
            third_party_requests: self.counters.third_party.load(Ordering::Relaxed),
            native_requests: self.counters.native.load(Ordering::Relaxed),
            upstream_errors: self.counters.upstream_errors.load(Ordering::Relaxed),
            last_model: last.0,
            last_route: last.1,
            last_upstream_status: last.2,
        }
    }

    /// 处理一个请求。请求体已经整体读入：分流必须先看到 `model`。
    pub async fn handle(
        self: Arc<Self>,
        req: Request<Bytes>,
        remote: SocketAddr,
    ) -> Response<Body> {
        let (parts, raw_body) = req.into_parts();
        let host = parts
            .headers
            .get(hyper::header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !remote.ip().is_loopback()
            || !is_loopback_host(host)
            || is_browser_request(&parts.headers)
        {
            // Codex 自己的请求来自回环地址、Host 是回环地址、不带 Origin。
            // 其余一律拒绝：否则浏览器里的任意网页都能借路由用上第三方密钥，或用 DNS 重绑定读状态。
            return json_error(
                StatusCode::FORBIDDEN,
                "router only accepts requests from local Codex",
            );
        }
        let path = parts.uri.path().to_owned();
        match path.as_str() {
            "/_health" => {
                return json_response(
                    StatusCode::OK,
                    &serde_json::json!({"ok": true, "service": HEALTH_SERVICE_NAME}),
                )
            }
            "/_status" => {
                return json_response(
                    StatusCode::OK,
                    &serde_json::to_value(self.status()).unwrap_or_default(),
                )
            }
            _ => {}
        }

        let started = Instant::now();
        let method = parts.method.clone();
        let reject =
            |model: &str, route: Route, status: StatusCode, result: &str, message: &str| {
                self.log.write(
                    started,
                    method.as_str(),
                    &path,
                    model,
                    route,
                    status.as_u16(),
                    result,
                    None,
                );
                json_error(status, message)
            };

        if is_websocket_upgrade(&parts.headers) {
            // Codex 把 426 当作整个会话回落到 HTTP 的信号，这样才能逐请求分流
            return reject(
                "",
                Route::None,
                StatusCode::UPGRADE_REQUIRED,
                "http_fallback",
                "router uses the HTTP Responses transport",
            );
        }
        let encoding = header_str(&parts.headers, "content-encoding")
            .trim()
            .to_ascii_lowercase();
        if !matches!(encoding.as_str(), "" | "identity" | "zstd") {
            // 解不开的压缩体读不到模型名，宁可拒绝也不能盲目放行
            return reject(
                "",
                Route::None,
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "request_error",
                "unsupported Content-Encoding",
            );
        }
        if raw_body.len() > self.max_body_bytes {
            return reject(
                "",
                Route::None,
                StatusCode::BAD_REQUEST,
                "request_error",
                "request body too large",
            );
        }
        let decoded: Bytes = if encoding == "zstd" {
            match decode_zstd(&raw_body, self.max_body_bytes) {
                Ok(decoded) => decoded.into(),
                Err(e) => {
                    return reject(
                        "",
                        Route::None,
                        StatusCode::BAD_REQUEST,
                        "request_error",
                        &format!("decompress zstd request body: {e}"),
                    )
                }
            }
        } else {
            raw_body.clone()
        };

        let suffix = path.strip_prefix("/v1").unwrap_or(&path).to_owned();
        let strict = method == Method::POST
            && (suffix.starts_with("/responses")
                || header_str(&parts.headers, "content-type")
                    .to_ascii_lowercase()
                    .contains("json"));
        let model = match top_level_model(&decoded, strict) {
            Ok(model) => model,
            // 读不懂的请求一律拒绝：放行到官方上游可能把本应发给内网模型的内容发到外部
            Err(e) => {
                return reject(
                    "",
                    Route::None,
                    StatusCode::BAD_REQUEST,
                    "request_error",
                    &format!("cannot determine the model of this request: {e}"),
                )
            }
        };
        let model_name = model.clone().unwrap_or_default();

        let mut target: Option<RoutingModel> = None;
        if let Some(model) = &model {
            let catalog = match load_routing_catalog(&self.routing_catalog_path) {
                Ok(catalog) => catalog,
                // 读不到清单就拒绝，而不是回落官方
                Err(e) => {
                    return reject(
                        model,
                        Route::None,
                        StatusCode::SERVICE_UNAVAILABLE,
                        "catalog_error",
                        &format!("read routing catalog: {e}"),
                    )
                }
            };
            let key = model_key(model);
            target = catalog.active.get(&key).cloned();
            if target.is_none() && catalog.retired.contains(&key) {
                // Codex 的模型目录只在启动时加载：取消勾选后，运行中的 Codex 仍可能发这个模型名
                return reject(model, Route::None, StatusCode::CONFLICT, "retired_model",
                    "this third-party model was removed in SymSync; restart Codex to refresh the model list");
            }
            let session = session_key(&parts.headers);
            if target.is_none()
                && key == AUTO_REVIEW_MODEL_KEY
                && self.session_used_third_party(&session)
            {
                // 自动审阅请求带着这一轮的上下文；会话用的是内网模型时不能静默发给官方上游
                return reject(model, Route::None, StatusCode::CONFLICT, "auto_review_blocked",
                    "Codex Auto-review is not available while this session uses a third-party model");
            }
            if key != AUTO_REVIEW_MODEL_KEY {
                self.record_session(session, target.is_some());
            }
        }

        let query = parts
            .uri
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        let outcome = match target {
            Some(target) => {
                let key =
                    match (self.third_party_key)() {
                        Ok(key) if !key.trim().is_empty() => key,
                        _ => return reject(
                            &model_name,
                            Route::ThirdParty,
                            StatusCode::BAD_GATEWAY,
                            "key_error",
                            "third-party API key is not available; set it in SymSync（密钥未保存）",
                        ),
                    };
                self.forward_third_party(
                    &parts,
                    &decoded,
                    &model_name,
                    &target,
                    &suffix,
                    &query,
                    &key,
                )
                .await
            }
            None => {
                self.forward_native(&parts, raw_body, &decoded, &suffix, &query)
                    .await
            }
        };
        let (route, result) = match outcome {
            Ok(pair) => pair,
            Err((route, status, message)) => {
                self.counters
                    .upstream_errors
                    .fetch_add(1, Ordering::Relaxed);
                *self.counters.last.lock().unwrap() =
                    (model_name.clone(), route.name().to_owned(), status.as_u16());
                return reject(&model_name, route, status, "upstream_error", &message);
            }
        };
        let status = result.status();
        *self.counters.last.lock().unwrap() =
            (model_name.clone(), route.name().to_owned(), status.as_u16());
        if status.is_server_error() {
            self.counters
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
        }
        if model.is_some() && status.is_success() {
            let counter = if route == Route::ThirdParty {
                &self.counters.third_party
            } else {
                &self.counters.native
            };
            counter.fetch_add(1, Ordering::Relaxed);
        }
        let logged = LoggedEntry {
            log: self.log.clone(),
            counters: self.counters.clone(),
            started,
            method: method.to_string(),
            path,
            model: model_name,
            route,
            status: status.as_u16(),
        };
        result.map(|body| logged.wrap(body))
    }

    async fn forward_native(
        &self,
        parts: &hyper::http::request::Parts,
        raw_body: Bytes,
        decoded: &Bytes,
        suffix: &str,
        query: &str,
    ) -> Result<(Route, Response<UpstreamBody>), (Route, StatusCode, String)> {
        // ChatGPT-Account-ID 区分账号登录与 API key 登录
        let (route, base) = if header_str(&parts.headers, "chatgpt-account-id")
            .trim()
            .is_empty()
        {
            (Route::OpenAi, &self.openai_url)
        } else {
            (Route::ChatGpt, &self.chatgpt_url)
        };
        // 历史里混有本功能产生的推理条目或压缩条目时才清理（否则官方上游会拒绝整个请求）；
        // 其余情况仍按原始字节透传。清理后的请求体是明文 JSON，所以不能再带 Content-Encoding。
        let cleaned = crate::translate::normalize_for_native(decoded);
        let drop_encoding = cleaned.is_some();
        let raw_body = cleaned.map(Bytes::from).unwrap_or(raw_body);
        // 官方路径：请求头原样保留（逐跳头除外），请求体按原始字节透传（含 zstd 压缩体）
        let mut request = self
            .native
            .request(parts.method.clone(), resolve_target(base, suffix, query));
        for (name, value) in &parts.headers {
            if !is_hop_by_hop(name)
                && name != hyper::header::HOST
                && name != hyper::header::CONTENT_LENGTH
                && !(drop_encoding && name == hyper::header::CONTENT_ENCODING)
            {
                request = request.header(name, value);
            }
        }
        // 没有请求体时绝不挂一个空 body：HTTP/2 下那会变成“长度未知”的请求，
        // 官方上游处理 GET /models 时会一直等到客户端超时（Go 版在真实环境里踩过）。
        if !raw_body.is_empty() {
            request = request.body(raw_body);
        }
        let response = request.send().await.map_err(|e| {
            (
                route,
                StatusCode::BAD_GATEWAY,
                format!("upstream unreachable: {}", describe(&e)),
            )
        })?;
        Ok((route, passthrough(response, false)))
    }

    #[allow(clippy::too_many_arguments)]
    async fn forward_third_party(
        &self,
        parts: &hyper::http::request::Parts,
        decoded: &Bytes,
        model: &str,
        target: &RoutingModel,
        suffix: &str,
        query: &str,
        key: &str,
    ) -> Result<(Route, Response<UpstreamBody>), (Route, StatusCode, String)> {
        let route = Route::ThirdParty;
        let upstream_model = if target.upstream_model.trim().is_empty() {
            model
        } else {
            target.upstream_model.trim()
        };
        if self.protocol == Protocol::Chat
            && parts.method == Method::POST
            && matches!(suffix, "/responses" | "/responses/compact")
        {
            let legacy_compact = suffix == "/responses/compact";
            return self
                .forward_chat(parts, decoded, model, upstream_model, legacy_compact, key)
                .await;
        }
        let body = if upstream_model != model {
            replace_request_model(decoded, upstream_model).map_err(|e| {
                (
                    route,
                    StatusCode::BAD_REQUEST,
                    format!("prepare request for third party: {e}"),
                )
            })?
        } else {
            decoded.to_vec()
        };
        // 第三方路径：从空请求头开始，绝不转发任何官方凭据
        let mut request = self.third_party.request(
            parts.method.clone(),
            resolve_target(&self.third_party_url, suffix, query),
        );
        for name in ["accept", "content-type", "openai-beta", "user-agent"] {
            for value in parts.headers.get_all(name) {
                request = request.header(name, value);
            }
        }
        request = request.header("authorization", format!("Bearer {key}"));
        if !body.is_empty() {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|e| {
            (
                route,
                StatusCode::BAD_GATEWAY,
                format!("upstream unreachable: {}", describe(&e)),
            )
        })?;
        if response.status().is_redirection() {
            // 不把第三方的重定向交给 Codex 去跟随：它会把请求体重发到别的主机
            return Err((
                route,
                StatusCode::BAD_GATEWAY,
                "third-party gateway answered with a redirect, which is not followed".to_owned(),
            ));
        }
        Ok((route, passthrough(response, true)))
    }

    /// 第三方网关只支持 Chat Completions：请求转过去，回复转回 Codex 期望的 Responses 形式
    async fn forward_chat(
        &self,
        parts: &hyper::http::request::Parts,
        decoded: &Bytes,
        model: &str,
        upstream_model: &str,
        legacy_compact: bool,
        key: &str,
    ) -> Result<(Route, Response<UpstreamBody>), (Route, StatusCode, String)> {
        let route = Route::ThirdParty;
        let bad_request = |e: String| {
            (
                route,
                StatusCode::BAD_REQUEST,
                format!("translate request for third party: {e}"),
            )
        };
        let mut source = decoded.to_vec();
        if legacy_compact {
            // 旧的 /responses/compact 接口：等价于在输入末尾放一个压缩触发条目
            let mut doc: serde_json::Map<String, serde_json::Value> =
                serde_json::from_slice(&source).map_err(|e| bad_request(e.to_string()))?;
            let mut input = match doc.remove("input") {
                Some(serde_json::Value::Array(items)) => items,
                Some(serde_json::Value::String(text)) => {
                    vec![serde_json::json!({"type": "message", "role": "user", "content": text})]
                }
                _ => Vec::new(),
            };
            input.push(serde_json::json!({"type": "compaction_trigger"}));
            doc.insert("input".to_owned(), serde_json::Value::Array(input));
            source = serde_json::to_vec(&doc).map_err(|e| bad_request(e.to_string()))?;
        }
        let translated = crate::translate::to_chat(&source, upstream_model)
            .map_err(|e| bad_request(e.to_string()))?;
        let client_streams = translated.stream && !legacy_compact;

        let mut request = self.third_party.post(resolve_target(
            &self.third_party_url,
            "/chat/completions",
            "",
        ));
        for value in parts.headers.get_all("user-agent") {
            request = request.header("user-agent", value);
        }
        let accept = if translated.compaction {
            "application/json"
        } else {
            "text/event-stream"
        };
        let response = request
            .header("content-type", "application/json")
            .header("accept", accept)
            .header("authorization", format!("Bearer {key}"))
            .body(translated.chat_body)
            .send()
            .await
            .map_err(|e| {
                (
                    route,
                    StatusCode::BAD_GATEWAY,
                    format!("upstream unreachable: {}", describe(&e)),
                )
            })?;
        let status = response.status();
        if status.is_redirection() {
            return Err((
                route,
                StatusCode::BAD_GATEWAY,
                "third-party gateway answered with a redirect, which is not followed".to_owned(),
            ));
        }
        if !status.is_success() {
            // 网关的错误体各有各的格式；统一成 Codex 能读出文字的样子，状态码保留
            let body = read_limited(response, 1 << 20).await;
            let payload = serde_json::json!({"error": {
                "message": crate::translate::error_message(&body),
                "type": "upstream_error",
                "code": status.as_u16(),
            }});
            return Ok((
                route,
                fixed_response(status, "application/json", payload.to_string().into_bytes()),
            ));
        }

        let model = model.to_owned();
        if translated.compaction || !client_streams {
            // 压缩请求，或不要流式的客户端：先收齐再一次性给出
            let body = read_limited(response, 16 << 20).await;
            let events = if translated.compaction {
                crate::translate::convert_compaction(&body, &model)
            } else {
                let mut converter =
                    crate::translate::StreamConverter::new(&model, translated.tools);
                let mut events = converter.start();
                events.extend(converter.feed_bytes(&body));
                events.extend(converter.finish());
                events
            };
            let response = if client_streams {
                let text: String = events.iter().map(|e| e.to_sse_string()).collect();
                fixed_response(StatusCode::OK, "text/event-stream", text.into_bytes())
            } else {
                let last = events
                    .last()
                    .and_then(|e| e.data.get("response"))
                    .cloned()
                    .unwrap_or_else(|| {
                        serde_json::json!({"error": {
                            "message": "the third-party model returned nothing",
                            "type": "upstream_error",
                        }})
                    });
                fixed_response(
                    StatusCode::OK,
                    "application/json",
                    last.to_string().into_bytes(),
                )
            };
            return Ok((route, response));
        }

        // 流式：上游每到一块就转换并立刻发给 Codex
        struct State {
            upstream: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
            converter: crate::translate::StreamConverter,
            started: bool,
            done: bool,
        }
        let state = State {
            upstream: Box::pin(response.bytes_stream()),
            converter: crate::translate::StreamConverter::new(&model, translated.tools),
            started: false,
            done: false,
        };
        let stream = futures_util::stream::unfold(state, |mut state| async move {
            loop {
                if state.done {
                    return None;
                }
                let events = if !state.started {
                    state.started = true;
                    state.converter.start()
                } else {
                    match state.upstream.next().await {
                        Some(Ok(chunk)) => state.converter.feed_bytes(&chunk),
                        // 上游断流或结束：把已收到的内容正常收尾，让 Codex 拿到完整的事件序列
                        Some(Err(_)) | None => {
                            state.done = true;
                            state.converter.finish()
                        }
                    }
                };
                if state.converter.is_finished() {
                    state.done = true;
                }
                if !events.is_empty() {
                    let text: String = events.iter().map(|e| e.to_sse_string()).collect();
                    return Some((Ok::<_, BoxError>(Bytes::from(text)), state));
                }
            }
        });
        let body: UpstreamBody = Box::pin(stream);
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(body)
            .expect("static headers");
        Ok((route, response))
    }

    fn session_used_third_party(&self, key: &str) -> bool {
        !key.is_empty()
            && self
                .sessions
                .lock()
                .unwrap()
                .get(key)
                .is_some_and(|(third_party, _)| *third_party)
    }

    fn record_session(&self, key: String, third_party: bool) {
        if key.is_empty() {
            return;
        }
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.len() >= MAX_TRACKED_SESSIONS {
            let cutoff = Instant::now() - Duration::from_secs(24 * 3600);
            sessions.retain(|_, (_, at)| *at > cutoff);
            if sessions.len() >= MAX_TRACKED_SESSIONS {
                sessions.clear();
            }
        }
        sessions.insert(key, (third_party, Instant::now()));
    }

    /// 只监听回环地址并一直服务
    pub async fn serve(self: Arc<Self>, listener: tokio::net::TcpListener) -> std::io::Result<()> {
        loop {
            let (stream, remote) = listener.accept().await?;
            let router = self.clone();
            tokio::spawn(async move {
                let service =
                    hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                        let router = router.clone();
                        async move {
                            let (parts, body) = req.into_parts();
                            let limit = router.max_body_bytes;
                            let body =
                                match http_body_util::Limited::new(body, limit.saturating_add(1))
                                    .collect()
                                    .await
                                {
                                    Ok(collected) => collected.to_bytes(),
                                    Err(_) => {
                                        return Ok::<_, std::convert::Infallible>(json_error(
                                            StatusCode::BAD_REQUEST,
                                            "read request body failed or body too large",
                                        ))
                                    }
                                };
                            Ok(router
                                .handle(Request::from_parts(parts, body), remote)
                                .await)
                        }
                    });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    }
}

type UpstreamBody = Pin<Box<dyn Stream<Item = Result<Bytes, BoxError>> + Send>>;

fn fixed_response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<UpstreamBody> {
    let stream: UpstreamBody = Box::pin(futures_util::stream::once(async move {
        Ok::<_, BoxError>(Bytes::from(body))
    }));
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(stream)
        .expect("static headers")
}

async fn read_limited(response: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(Ok(chunk)) = stream.next().await {
        if out.len() + chunk.len() > limit {
            break;
        }
        out.extend_from_slice(&chunk);
    }
    out
}

/// 把上游响应搬过来：状态码、响应头（逐跳头除外）、流式响应体
fn passthrough(response: reqwest::Response, third_party: bool) -> Response<UpstreamBody> {
    let mut builder = Response::builder().status(response.status());
    for (name, value) in response.headers() {
        let lower = name.as_str();
        if is_hop_by_hop(name)
            || (third_party && (lower.starts_with("access-control-") || lower == "set-cookie"))
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    let stream: UpstreamBody = Box::pin(
        response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|e| Box::new(e) as BoxError)),
    );
    builder
        .body(stream)
        .expect("status and headers come from a valid response")
}

fn describe(error: &reqwest::Error) -> String {
    // reqwest 的错误可能带完整 URL；只给出类别，避免把地址里的敏感信息写进响应
    if error.is_timeout() {
        "timed out".to_owned()
    } else if error.is_connect() {
        "connection failed".to_owned()
    } else {
        "request failed".to_owned()
    }
}

fn resolve_target(base: &url::Url, suffix: &str, query: &str) -> String {
    let mut target = base.clone();
    target.set_query(None);
    target.set_fragment(None);
    format!(
        "{}/{}{}",
        target.as_str().trim_end_matches('/'),
        suffix.trim_start_matches('/'),
        query
    )
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// 校验 Host 头：DNS 重绑定时 Host 是攻击者的域名
fn is_loopback_host(host_port: &str) -> bool {
    let host = host_port.trim();
    let host = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(h, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) {
                h
            } else {
                host
            }
        }),
    };
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// 浏览器发起的跨站请求会带 Origin 或 Sec-Fetch-Site，Codex 的请求都不带
fn is_browser_request(headers: &HeaderMap) -> bool {
    if headers.contains_key("origin") {
        return true;
    }
    let site = header_str(headers, "sec-fetch-site")
        .trim()
        .to_ascii_lowercase();
    !site.is_empty() && site != "none"
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    header_str(headers, "upgrade")
        .trim()
        .eq_ignore_ascii_case("websocket")
        && headers.get_all("connection").iter().any(|v| {
            v.to_str()
                .unwrap_or("")
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
}

fn session_key(headers: &HeaderMap) -> String {
    ["session-id", "thread-id", "x-codex-window-id"]
        .iter()
        .map(|name| header_str(headers, name).trim())
        .find(|value| !value.is_empty())
        .unwrap_or("")
        .to_owned()
}

fn decode_zstd(raw: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(raw).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    decoder
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    if out.len() > limit {
        return Err("decompressed request body too large".to_owned());
    }
    Ok(out)
}

fn json_response(status: StatusCode, value: &serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(
            Full::new(Bytes::from(value.to_string()))
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .expect("static response")
}

fn json_error(status: StatusCode, message: &str) -> Response<Body> {
    json_response(
        status,
        &serde_json::json!({"error": {"message": message, "type": "symsync_gateway"}}),
    )
}

struct ActivityLog {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl ActivityLog {
    /// 只记时间、模型、去向、状态、耗时、字节数；不记请求内容和凭据
    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        started: Instant,
        method: &str,
        path: &str,
        model: &str,
        route: Route,
        status: u16,
        result: &str,
        transfer: Option<(Option<Duration>, u64)>,
    ) {
        let Some(log_path) = &self.path else { return };
        let _guard = self.lock.lock().unwrap();
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut options = std::fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let Ok(mut file) = options.open(log_path) else {
            return;
        };
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let transfer = transfer
            .map(|(ttfb, bytes)| {
                format!(
                    " ttfb={} bytes={bytes}",
                    ttfb.map_or("-".to_owned(), |d| format!("{}ms", d.as_millis()))
                )
            })
            .unwrap_or_default();
        let _ = writeln!(file, "{now} route={} model={} method={method} path={} status={status} duration={}ms result={result}{transfer}",
            route.name(), log_safe(model), log_safe(path), started.elapsed().as_millis());
    }
}

/// 响应体流完（或中断、被取消）时写一条日志
struct LoggedEntry {
    log: Arc<ActivityLog>,
    counters: Arc<Counters>,
    started: Instant,
    method: String,
    path: String,
    model: String,
    route: Route,
    status: u16,
}

impl LoggedEntry {
    fn wrap(self, inner: UpstreamBody) -> Body {
        let stream = LoggedStream {
            inner,
            entry: Some(self),
            first_byte: None,
            bytes: 0,
        };
        BodyExt::boxed_unsync(StreamBody::new(stream.map(|chunk| chunk.map(Frame::data))))
    }
}

struct LoggedStream {
    inner: UpstreamBody,
    entry: Option<LoggedEntry>,
    first_byte: Option<Duration>,
    bytes: u64,
}

impl LoggedStream {
    fn finish(&mut self, result: &str) {
        if let Some(entry) = self.entry.take() {
            if result == "stream_error" {
                entry
                    .counters
                    .upstream_errors
                    .fetch_add(1, Ordering::Relaxed);
            }
            let result = if entry.status >= 500 && result == "ok" {
                "upstream_error"
            } else {
                result
            };
            entry.log.write(
                entry.started,
                &entry.method,
                &entry.path,
                &entry.model,
                entry.route,
                entry.status,
                result,
                Some((self.first_byte, self.bytes)),
            );
        }
    }
}

impl Stream for LoggedStream {
    type Item = Result<Bytes, BoxError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let polled = self.inner.as_mut().poll_next(cx);
        match &polled {
            Poll::Ready(Some(Ok(chunk))) => {
                if self.first_byte.is_none() {
                    self.first_byte = self.entry.as_ref().map(|e| e.started.elapsed());
                }
                self.bytes += chunk.len() as u64;
            }
            Poll::Ready(Some(Err(_))) => self.finish("stream_error"),
            Poll::Ready(None) => self.finish("ok"),
            Poll::Pending => {}
        }
        polled
    }
}

impl Drop for LoggedStream {
    fn drop(&mut self) {
        // 没流完就被丢弃：客户端取消了
        self.finish("canceled");
    }
}

//! 本机回环路由：路由清单里的模型转给第三方网关，其余请求原样转给官方上游。
//! 例外：不带 OpenAI 凭据的请求不转官方、本地拒绝；用过第三方模型的会话里 Codex 起标题的请求，改发给那个第三方模型。
//! 行为移植自 agents-manager 的 `internal/router`（Go，已在真实环境验证）；结构的出处见仓库根 NOTICE。
mod claude;
mod parse;
#[cfg(test)]
mod tests;

use claude::Namespace;
pub use claude::{TokenSource, APP_ORIGIN, PREFIX as CLAUDE_PREFIX};

pub use parse::{log_safe, model_key, top_level_model};
use parse::{looks_like_json, path_is_safe};

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
pub const HEALTH_SERVICE_NAME: &str = "sophia-gateway";
/// `/_health` 的 `features`：本版路由认得家 `claude`（`/claude/` 前缀）。写桌面应用配置前据此确认
/// 在跑的不是旧版路由（旧版会把 Anthropic 请求当成不认识的模型转发到官方，spec R9）
pub const FEATURES: &[&str] = &["claude"];
/// `features` 里表示「认得家 claude」的那一项
pub const FEATURE_CLAUDE: &str = "claude";

const DEFAULT_MAX_BODY_BYTES: usize = 64 << 20;
const MAX_TRACKED_SESSIONS: usize = 2000;
/// 起标题请求认会话：开始时间与标题轮相差不超过这么多的轮次才算候选
const TITLE_TURN_WINDOW_MS: u64 = 5_000;
/// 起标题请求先于触发它的那一轮到达时，最多等这么久
const TITLE_TURN_WAIT: Duration = Duration::from_millis(1_500);

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
/// 响应体只需要 `Send`：上游的字节流不是 `Sync`
pub type Body = UnsyncBoxBody<Bytes, BoxError>;
/// 网关数据的归属：模型页里的一家 agent（spec「家」）。同一个网关 id 可以同时出现在两家，
/// 路由清单、密钥账户都带家的维度
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Codex,
    Claude,
}

impl Agent {
    pub const ALL: [Agent; 2] = [Agent::Codex, Agent::Claude];

    pub fn as_str(self) -> &'static str {
        match self {
            Agent::Codex => "codex",
            Agent::Claude => "claude",
        }
    }

    /// 界面与提示里的名字
    pub fn label(self) -> &'static str {
        match self {
            Agent::Codex => "Codex",
            Agent::Claude => "Claude",
        }
    }

    /// 另一家（同步、带过来用）
    pub fn other(self) -> Agent {
        match self {
            Agent::Codex => Agent::Claude,
            Agent::Claude => Agent::Codex,
        }
    }

    pub fn parse(text: &str) -> Option<Agent> {
        match text.trim() {
            "codex" => Some(Agent::Codex),
            "claude" => Some(Agent::Claude),
            _ => None,
        }
    }
}

/// 每次第三方请求时按（家, 网关 id）取密钥；密钥不落入配置和日志
pub type KeySource = Arc<dyn Fn(Agent, &str) -> Result<String, String> + Send + Sync>;

/// 取密钥（缓存没命中时要读密钥文件）放到阻塞线程池里做，不占异步运行时的工作线程
pub(crate) async fn key_off_thread(
    source: &KeySource,
    agent: Agent,
    provider: &str,
) -> Result<String, String> {
    let (source, provider) = (Arc::clone(source), provider.to_owned());
    tokio::task::spawn_blocking(move || source(agent, &provider))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// 一次真实调用对某家网关密钥的结论（#144）。拉模型列表的接口不一定验密钥（OpenRouter 的 `GET /models`
/// 不要鉴权），密钥错没错要等真发一次请求才知道
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyVerdict {
    /// 上游答了 401 / 403：`detail` 是那次请求的技术原文（已去密钥与隐私）
    Rejected { detail: String },
    /// 上游答了 2xx
    Accepted,
}

/// 路由把密钥结论交给编排层记到那一家网关上：（家, 网关 id, 结论）。路由已经去过重（同一把密钥、同一结论
/// 一段时间内只报一次）。在请求路径上同步调用，必须立刻返回——落盘放到别的线程去做
pub type KeyVerdictSink = Arc<dyn Fn(Agent, &str, KeyVerdict) + Send + Sync>;

/// 同一（家, 网关, 密钥）的同一结论，隔这么久才再报一次：编排层那边的状态可能被别处清掉了
/// （重新存了同一把密钥、删了又加回来），过一会儿重报一次让它跟上
const KEY_VERDICT_REFRESH: Duration = Duration::from_secs(60);

/// 给定目标地址，返回要用的代理；`None` 表示直连
pub type ProxyFn = Arc<dyn Fn(&url::Url) -> Option<url::Url> + Send + Sync>;
/// 此刻的界面语言；`None` 表示这回取不到，沿用上一次的
pub type LocaleSource = Arc<dyn Fn() -> Option<sophia_core::i18n::Lang> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// 第三方网关原生支持 Responses，请求原样转发
    Responses,
    /// 第三方网关只支持 Chat Completions，路由负责双向转换
    Chat,
}

pub struct Config {
    /// 旧格式路由清单（路由不带归属）用的唯一上游，留空表示没有。
    /// 新清单里每家上游的地址和协议写在清单里，每个请求重读，增删网关不用重启路由。
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
    /// 家 `claude` 的路由清单（`--claude-routing`）。None：旧 plist 拉起的新程序，Claude 请求一律 404（R10）
    pub claude_routing_path: Option<PathBuf>,
    /// 读家 `claude` 的网关令牌（密钥文件）；路由自己缓存（R12）
    pub router_token: TokenSource,
    /// Claude 流式响应的保活间隔；零表示默认 15 秒（R24）
    pub keepalive: Duration,
    /// 每个请求进来先按它换当前语言，路由说的话（错误句）跟界面语言走。None：不动当前语言
    pub locale: Option<LocaleSource>,
    /// 第三方答了 401 / 403 或 2xx 时报给编排层（#144）。None：不报（测试、没有编排层的场合）
    pub key_verdicts: Option<KeyVerdictSink>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Status {
    pub ok: bool,
    pub third_party_requests: u64,
    pub native_requests: u64,
    pub upstream_errors: u64,
    /// 家 `claude` 成功转发的请求数
    pub claude_requests: u64,
    pub last_model: String,
    pub last_route: String,
    pub last_upstream_status: u16,
}

/// 一次第三方请求要发往的上游
struct Upstream {
    /// 取密钥用的网关 id
    provider: String,
    /// 接口基址；Codex 请求路径去掉 `/v1` 前缀后接在它后面
    url: url::Url,
    protocol: Protocol,
}

pub struct Router {
    legacy_upstream: Option<(url::Url, Protocol)>,
    chatgpt_url: url::Url,
    openai_url: url::Url,
    routing_catalog_path: PathBuf,
    third_party_key: KeySource,
    max_body_bytes: usize,
    claude_routing_path: Option<PathBuf>,
    token: claude::TokenCache,
    keepalive: Duration,
    locale: Option<LocaleSource>,
    // 两个上游各用各的客户端，一路不通不拖累另一路
    native: reqwest::Client,
    third_party: reqwest::Client,
    log: Arc<ActivityLog>,
    counters: Arc<Counters>,
    /// 会话标识 → 这个会话最近一轮
    sessions: Mutex<HashMap<String, SessionTurn>>,
    /// 每记下一轮就通知一次：等着认会话的起标题请求据此重查
    turn_recorded: tokio::sync::Notify,
    /// 起标题请求最多等多久（测试里改短）
    title_wait: Duration,
    key_verdicts: Option<KeyVerdictSink>,
    /// （家, 网关 id）→ 上次报出去的结论，去重用
    verdicts_seen: Mutex<HashMap<(Agent, String), SeenVerdict>>,
}

/// 上次报出去的密钥结论
struct SeenVerdict {
    /// 密钥的指纹（只在内存里，不落盘、不进日志）：换了密钥，同一结论也要重报
    key: u64,
    rejected: bool,
    at: Instant,
}

/// 一个会话最近一轮的记录
struct SessionTurn {
    /// 去向：`Some(模型键)` 是第三方（记下是哪个模型，起标题时用），`None` 是官方
    route: Option<String>,
    /// 经过路由的时刻
    at: Instant,
    /// 这一轮的开始时间（`x-codex-turn-metadata` 的 `turn_started_at_unix_ms`），没带就是 `None`
    started_at: Option<u64>,
}

#[derive(Default)]
struct Counters {
    third_party: AtomicU64,
    native: AtomicU64,
    upstream_errors: AtomicU64,
    claude: AtomicU64,
    last: Mutex<(String, String, u16)>,
}

impl Counters {
    /// 上游出错（连不上、5xx、流断了）：路由自己的计数加一，另记一次异常（自动上报，spec 2026-10-04-reporting-feedback R7）
    fn upstream_error(&self) {
        self.upstream_errors.fetch_add(1, Ordering::Relaxed);
        sophia_core::report::count(sophia_core::report::Kind::Upstream);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    ThirdParty,
    ChatGpt,
    OpenAi,
    /// 家 `claude` 的请求（去向就是 Claude 清单里的第三方网关）
    Claude,
    None,
}

impl Route {
    fn name(self) -> &'static str {
        match self {
            Route::ThirdParty => "third_party",
            Route::ChatGpt => "chatgpt",
            Route::OpenAi => "openai",
            Route::Claude => "claude",
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

/// 路由清单里的上游地址：密钥会随每个请求发过去，只允许 https（本机回环除外），不能带用户名密码。
/// 保存网关地址时界面已经按同样的规则拦过一次；清单是磁盘上的文件，这里再拦一次。
pub(crate) fn parse_provider_base(raw: &str) -> Result<url::Url, String> {
    let parsed = parse_base("third-party", raw)?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("third-party URL must not contain credentials".to_owned());
    }
    let host = parsed.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if parsed.scheme() == "http" && !loopback {
        return Err("third-party URL must be https".to_owned());
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
            legacy_upstream: if config.third_party_url.trim().is_empty() {
                None
            } else {
                Some((
                    parse_base("third-party", &config.third_party_url)?,
                    config.third_party_protocol,
                ))
            },
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
            claude_routing_path: config.claude_routing_path,
            token: claude::TokenCache::new(config.router_token),
            keepalive: if config.keepalive.is_zero() {
                crate::translate::anthropic::DEFAULT_KEEPALIVE_INTERVAL
            } else {
                config.keepalive
            },
            locale: config.locale,
            native: build_client(&config.proxy, None)?,
            // 内网网关不可达时尽快失败；流式响应不设总超时
            third_party: build_client(&config.proxy, Some(Duration::from_secs(5)))?,
            log: Arc::new(ActivityLog {
                path: config.activity_log_path,
                lock: Arc::new(Mutex::new(())),
            }),
            counters: Arc::default(),
            sessions: Mutex::default(),
            turn_recorded: tokio::sync::Notify::new(),
            title_wait: TITLE_TURN_WAIT,
            key_verdicts: config.key_verdicts,
            verdicts_seen: Mutex::default(),
        }))
    }

    pub fn status(&self) -> Status {
        let last = self.counters.last.lock().unwrap().clone();
        Status {
            ok: true,
            third_party_requests: self.counters.third_party.load(Ordering::Relaxed),
            native_requests: self.counters.native.load(Ordering::Relaxed),
            upstream_errors: self.counters.upstream_errors.load(Ordering::Relaxed),
            claude_requests: self.counters.claude.load(Ordering::Relaxed),
            last_model: if last.0.is_empty() {
                String::new()
            } else {
                log_safe(&last.0)
            },
            last_route: last.1,
            last_upstream_status: last.2,
        }
    }

    /// 第三方对这家网关密钥的结论报给编排层（#144）。同一把密钥、同一结论在 [`KEY_VERDICT_REFRESH`] 内只报一次，
    /// 所以请求路径上通常只是查一下表；报的那一下也只是把结论交出去，不等落盘
    fn report_key(&self, agent: Agent, provider: &str, key: &str, verdict: KeyVerdict) {
        let Some(sink) = &self.key_verdicts else {
            return;
        };
        let fingerprint = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            key.hash(&mut hasher);
            hasher.finish()
        };
        let rejected = matches!(verdict, KeyVerdict::Rejected { .. });
        let now = Instant::now();
        {
            let mut seen = self
                .verdicts_seen
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let id = (agent, provider.to_owned());
            if seen.get(&id).is_some_and(|last| {
                last.key == fingerprint
                    && last.rejected == rejected
                    && now.duration_since(last.at) < KEY_VERDICT_REFRESH
            }) {
                return;
            }
            seen.insert(
                id,
                SeenVerdict {
                    key: fingerprint,
                    rejected,
                    at: now,
                },
            );
        }
        sink(agent, provider, verdict);
    }

    /// 处理一个请求。请求体已经整体读入：分流必须先看到 `model`。
    pub async fn handle(
        self: Arc<Self>,
        req: Request<Bytes>,
        remote: SocketAddr,
    ) -> Response<Body> {
        let (parts, raw_body) = req.into_parts();
        if let Some(rejection) = self.screen(&parts, remote) {
            return rejection;
        }
        let path = parts.uri.path().to_owned();
        match path.as_str() {
            "/_health" => {
                return json_response(
                    StatusCode::OK,
                    &serde_json::json!({"ok": true, "service": HEALTH_SERVICE_NAME, "features": FEATURES}),
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
        // Claude 命名空间在读模型名与通用分流之前整个交出去：任何情况下都不进入 Codex 的第三方分流与官方转发
        match claude::namespace(&path, &parts.headers) {
            Namespace::Claude => return claude::handle(self.clone(), parts, raw_body).await,
            Namespace::Stray => return claude::stray(),
            Namespace::Codex => {}
        }

        let started = Instant::now();
        let method = parts.method.clone();
        let reject =
            |model: &str, route: Route, status: StatusCode, result: &str, message: &str| {
                self.log.write(
                    started,
                    Agent::Codex.as_str(),
                    method.as_str(),
                    &path,
                    model,
                    route,
                    status.as_u16(),
                    result,
                    "",
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
        if !path_is_safe(&path) {
            return reject(
                "",
                Route::None,
                StatusCode::BAD_REQUEST,
                "request_error",
                "unsupported request path",
            );
        }
        // 头的值不是合法 ASCII、或者给了好几个值，都按“不认识的压缩方式”处理，不能当成没压缩
        let encodings: Vec<_> = parts.headers.get_all("content-encoding").iter().collect();
        let encoding = match encodings.as_slice() {
            [] => String::new(),
            [single] => single
                .to_str()
                .map_or_else(|_| "?".to_owned(), |v| v.trim().to_ascii_lowercase()),
            _ => "?".to_owned(),
        };
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
        // 解析失败不能成为放行到官方上游的理由：只要请求体声明为 JSON、看起来是 JSON，
        // 或者发往对话类接口，读不懂就拒绝，不看方法和路径。
        let strict = !decoded.iter().all(|b| b.is_ascii_whitespace())
            && (looks_like_json(&decoded)
                || suffix.starts_with("/responses")
                || suffix.starts_with("/chat/completions")
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
        let mut model_name = model.clone().unwrap_or_default();
        let mut decoded = decoded;
        let mut extra = String::new();

        let mut target: Option<RoutingModel> = None;
        let mut upstream: Option<Result<Upstream, String>> = None;
        if let Some(model) = &model {
            // 读清单文件放到阻塞线程池里做：路由与界面在同一进程，不占异步运行时的工作线程
            let path = self.routing_catalog_path.clone();
            let loaded = tokio::task::spawn_blocking(move || load_routing_catalog(&path))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            let catalog = match loaded {
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
            upstream = target
                .as_ref()
                .map(|target| self.upstream_for(target, &catalog));
            if target.is_none() && catalog.retired.contains(&key) {
                // Codex 的模型目录只在启动时加载：取消勾选后，运行中的 Codex 仍可能发这个模型名
                return reject(model, Route::None, StatusCode::CONFLICT, "retired_model",
                    "this third-party model was removed in Sophia; restart Codex to refresh the model list");
            }
            let sessions = session_keys(&parts.headers);
            if target.is_none()
                && key == AUTO_REVIEW_MODEL_KEY
                && sessions
                    .iter()
                    .any(|key| self.session_used_third_party(key))
            {
                // 自动审阅请求带着这一轮的上下文；会话用的是内网模型时不能静默发给官方上游
                return reject(model, Route::None, StatusCode::CONFLICT, "auto_review_blocked",
                    "Codex Auto-review is not available while this session uses a third-party model");
            }
            // 起标题请求的内容是会话的第一条消息：会话用的是第三方模型时，改发给那个模型，不发官方
            let title = target.is_none() && is_thread_title(&parts.headers);
            if title {
                let started_at = turn_started_at(&parts.headers);
                if let Some(Some(session_model)) =
                    self.title_session_route(&sessions, started_at).await
                {
                    let routed = catalog.active.get(&session_model).cloned();
                    let rewritten = routed.as_ref().and_then(|routed| {
                        replace_request_model(&decoded, &routed.slug)
                            .ok()
                            .map(|body| (routed.clone(), body))
                    });
                    let Some((routed, body)) = rewritten else {
                        log_blocked(&sessions, model, "thread_title_blocked");
                        return reject(model, Route::None, StatusCode::CONFLICT, "thread_title_blocked",
                            "Sophia did not send this thread-title request to OpenAI: this session uses a third-party model that is no longer in Sophia's routing list");
                    };
                    log::info!(
                        "路由把起标题请求改发给会话的第三方模型：session={} model={} to={} action=rewritten",
                        session_hash(&sessions),
                        log_safe(model),
                        log_safe(&routed.slug)
                    );
                    extra = format!(" title_from={}", log_field(model));
                    model_name = routed.slug.clone();
                    decoded = body.into();
                    upstream = Some(self.upstream_for(&routed, &catalog));
                    target = Some(routed);
                }
            }
            // 自动审阅与起标题不是会话自己的一轮，不改会话的记录
            if key != AUTO_REVIEW_MODEL_KEY && !title {
                let route = target.is_some().then(|| key.clone());
                let started_at = turn_started_at(&parts.headers);
                for session in sessions {
                    self.record_session(session, route.clone(), started_at);
                }
            }
        }
        if target.is_none() && !has_openai_credentials(&parts.headers) {
            // 独立服务商接法下 Codex 不带 OpenAI 凭据：转给官方只会被拒，内容却已经离开了这台电脑
            log_blocked(
                &session_keys(&parts.headers),
                &model_name,
                "official_needs_login",
            );
            return reject(&model_name, Route::None, StatusCode::CONFLICT, "official_needs_login",
                "Sophia did not send this request to OpenAI because it carries no OpenAI sign-in; pick a third-party model in Codex, or sign Codex in to ChatGPT or with an OpenAI API key");
        }

        let query = parts
            .uri
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        let outcome = match target {
            Some(target) => {
                // 第三方模型的上游必须明确可用：归属不明、地址不安全都拒绝，绝不回落到官方或别家。
                // 回 403 而不是 502：清单不改，重试也没用，Codex 却会把 5xx 重试好几次
                let upstream = match upstream {
                    Some(Ok(upstream)) => upstream,
                    Some(Err(why)) => {
                        return reject(
                            &model_name,
                            Route::ThirdParty,
                            StatusCode::FORBIDDEN,
                            "provider_error",
                            &why,
                        )
                    }
                    None => unreachable!("upstream is resolved whenever a target is found"),
                };
                // 取不到密钥回 403 而不是 5xx：Codex 会把 5xx 重试好几次，重试也取不到；
                // 也不回 401，免得 Codex 当成自己的 ChatGPT 登录失效。
                // 取不到的原因（没存、密钥文件读不出）跟在后面，与模型页上那一家网关的说法一致
                let key =
                    match key_off_thread(&self.third_party_key, Agent::Codex, &upstream.provider)
                        .await
                    {
                        Ok(key) if !key.trim().is_empty() => key,
                        failed => {
                            return reject(
                                &model_name,
                                Route::ThirdParty,
                                StatusCode::FORBIDDEN,
                                "key_error",
                                &format!(
                                    "Sophia could not get the API key for third-party gateway {:?} ({}); check this gateway's key on the Models page in Sophia",
                                    log_safe(&upstream.provider),
                                    failed.err().unwrap_or_default()
                                ),
                            )
                        }
                    };
                self.forward_third_party(
                    &parts,
                    &decoded,
                    &model_name,
                    &target,
                    &upstream,
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
                self.counters.upstream_error();
                *self.counters.last.lock().unwrap() =
                    (model_name.clone(), route.name().to_owned(), status.as_u16());
                return reject(&model_name, route, status, "upstream_error", &message);
            }
        };
        let status = result.status();
        *self.counters.last.lock().unwrap() =
            (model_name.clone(), route.name().to_owned(), status.as_u16());
        if status.is_server_error() {
            self.counters.upstream_error();
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
            extra,
        };
        result.map(|body| logged.wrap(body))
    }

    /// 读请求体之前的关卡：按命名空间做来源校验（R13），没带 `/claude` 前缀的 Anthropic 形状请求直接 404（R11）。
    /// Claude 命名空间与散请求被拦下时记一行日志（真机验收看日志里有没有 403 / 404）；Codex 的拒绝照旧不记
    fn screen(
        &self,
        parts: &hyper::http::request::Parts,
        remote: SocketAddr,
    ) -> Option<Response<Body>> {
        let path = parts.uri.path();
        let namespace = claude::namespace(path, &parts.headers);
        let rejection = guard(namespace, &parts.headers, remote)
            .or_else(|| (namespace == Namespace::Stray).then(claude::stray))?;
        if namespace != Namespace::Codex {
            let agent = if namespace == Namespace::Claude {
                Agent::Claude.as_str()
            } else {
                "-"
            };
            self.log.write(
                Instant::now(),
                agent,
                parts.method.as_str(),
                path,
                "",
                Route::None,
                rejection.status().as_u16(),
                if rejection.status() == StatusCode::FORBIDDEN {
                    "forbidden"
                } else {
                    "stray_request"
                },
                "",
                None,
            );
        }
        Some(rejection)
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
        let response = send_with_connect_retry(request).await.map_err(|e| {
            (
                route,
                StatusCode::BAD_GATEWAY,
                format!("upstream unreachable: {}", describe(&e)),
            )
        })?;
        Ok((route, passthrough(response, false)))
    }

    /// 一条路由该发往哪家上游。带归属的从清单里取；不带归属的是旧格式清单，走启动参数给的那个上游。
    /// Err 是直接给 Codex 看的文字：点名网关与原因（不在清单里 / 地址不可用），并说明请求没有发出
    fn upstream_for(
        &self,
        target: &RoutingModel,
        catalog: &parse::RoutingCatalog,
    ) -> Result<Upstream, String> {
        let provider = target.provider.trim();
        if provider.is_empty() {
            let (url, protocol) = self
                .legacy_upstream
                .clone()
                .ok_or(
                    "Sophia's routing list does not say which third-party gateway serves this model; the request was not sent",
                )?;
            return Ok(Upstream {
                provider: sophia_core::codex_models::settings::LEGACY_PROVIDER_ID.to_owned(),
                url,
                protocol,
            });
        }
        let entry = catalog.providers.get(provider).ok_or_else(|| {
            format!(
                "third-party gateway {:?} is not in Sophia's routing list (it may have been deleted); the request was not sent",
                log_safe(provider)
            )
        })?;
        let url = parse_provider_base(&entry.base_url).map_err(|why| {
            format!(
                "the address saved for third-party gateway {:?} is not usable ({why}); the request was not sent",
                log_safe(provider)
            )
        })?;
        Ok(Upstream {
            provider: provider.to_owned(),
            url,
            protocol: if entry.protocol == "responses" {
                Protocol::Responses
            } else {
                Protocol::Chat
            },
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn forward_third_party(
        &self,
        parts: &hyper::http::request::Parts,
        decoded: &Bytes,
        model: &str,
        target: &RoutingModel,
        upstream: &Upstream,
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
        if upstream.protocol == Protocol::Chat
            && parts.method == Method::POST
            && matches!(suffix, "/responses" | "/responses/compact")
        {
            let legacy_compact = suffix == "/responses/compact";
            return self
                .forward_chat(
                    parts,
                    decoded,
                    model,
                    upstream_model,
                    upstream,
                    legacy_compact,
                    key,
                )
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
        let target_url = resolve_target(&upstream.url, suffix, query);
        let mut request = self
            .third_party
            .request(parts.method.clone(), target_url.as_str());
        for name in ["accept", "content-type", "openai-beta", "user-agent"] {
            for value in parts.headers.get_all(name) {
                request = request.header(name, value);
            }
        }
        request = request.header("authorization", format!("Bearer {key}"));
        if !body.is_empty() {
            request = request.body(body);
        }
        let response = send_with_connect_retry(request).await.map_err(|e| {
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
        let status = response.status();
        if !status.is_success() {
            // 网关常在错误信息里把收到的 Authorization 原样吐回来，不能转给本机客户端
            let body = read_limited(response, 1 << 20).await;
            if is_key_rejection(status) {
                let detail =
                    rejection_detail(parts.method.as_str(), &target_url, status, &body, key);
                self.report_key(
                    Agent::Codex,
                    &upstream.provider,
                    key,
                    KeyVerdict::Rejected { detail },
                );
                return Ok((route, key_rejected(&upstream.provider, status, &body, key)));
            }
            let scrubbed = String::from_utf8_lossy(&body).replace(key, "***");
            return Ok((
                route,
                fixed_response(status, "application/json", scrubbed.into_bytes()),
            ));
        }
        self.report_key(Agent::Codex, &upstream.provider, key, KeyVerdict::Accepted);
        Ok((route, passthrough(response, true)))
    }

    /// 第三方网关只支持 Chat Completions：请求转过去，回复转回 Codex 期望的 Responses 形式
    #[allow(clippy::too_many_arguments)]
    async fn forward_chat(
        &self,
        parts: &hyper::http::request::Parts,
        decoded: &Bytes,
        model: &str,
        upstream_model: &str,
        upstream: &Upstream,
        legacy_compact: bool,
        key: &str,
    ) -> Result<(Route, Response<UpstreamBody>), (Route, StatusCode, String)> {
        let route = Route::ThirdParty;
        let base = &upstream.url;
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
        // 发了 `reasoning_effort` / 带回了 `reasoning_content` 而上游因它 400 时，去掉它重发；
        // 两种各至多一次（spec R18a、reasoning-passback R4），最多发三次
        let mut options = crate::translate::ChatOptions::default();
        let (response, translated) = loop {
            let mut translated = crate::translate::to_chat_with(&source, upstream_model, options)
                .map_err(|e| bad_request(e.to_string()))?;

            let target_url = resolve_target(base, "/chat/completions", "");
            let mut request = self.third_party.post(target_url.as_str());
            for value in parts.headers.get_all("user-agent") {
                request = request.header("user-agent", value);
            }
            let accept = if translated.compaction {
                "application/json"
            } else {
                "text/event-stream"
            };
            let request = request
                .header("content-type", "application/json")
                .header("accept", accept)
                .header("authorization", format!("Bearer {key}"))
                // 重发时会重新转换，这份请求体用完即弃
                .body(std::mem::take(&mut translated.chat_body));
            let response = send_with_connect_retry(request).await.map_err(|e| {
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
                    "third-party gateway answered with a redirect, which is not followed"
                        .to_owned(),
                ));
            }
            if status.is_success() {
                self.report_key(Agent::Codex, &upstream.provider, key, KeyVerdict::Accepted);
                break (response, translated);
            }
            let body = read_limited(response, 1 << 20).await;
            // 去掉后重新转换出的请求体里不再有该字段（`*_sent` 为假），所以每种自然至多一次
            match crate::translate::reasoning_retry(
                status.as_u16(),
                &body,
                translated.reasoning_effort_sent,
                translated.reasoning_content_sent,
            ) {
                Some(crate::translate::ReasoningRetry::DropEffort) => {
                    options.omit_reasoning_effort = true;
                    continue;
                }
                Some(crate::translate::ReasoningRetry::DropContent) => {
                    options.omit_reasoning_content = true;
                    continue;
                }
                None => {}
            }
            if is_key_rejection(status) {
                let detail = rejection_detail("POST", &target_url, status, &body, key);
                self.report_key(
                    Agent::Codex,
                    &upstream.provider,
                    key,
                    KeyVerdict::Rejected { detail },
                );
                return Ok((route, key_rejected(&upstream.provider, status, &body, key)));
            }
            // 网关的错误体各有各的格式；统一成 Codex 能读出文字的样子，状态码保留
            let payload = serde_json::json!({"error": {
                // 网关若在错误信息里回显了密钥，不能原样转给本机客户端
                "message": crate::translate::error_message(&body).replace(key, "***"),
                "type": "upstream_error",
                "code": status.as_u16(),
            }});
            return Ok((
                route,
                fixed_response(status, "application/json", payload.to_string().into_bytes()),
            ));
        };
        let client_streams = translated.stream && !legacy_compact;

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
                // 收齐时也可能是截断的（中途出错、超出上限）：没有结束标记就以 failed 结束
                events.extend(converter.end_of_stream());
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
                        // 上游断流或结束：见过 `[DONE]` / finish_reason 才按完成收尾，
                        // 否则以 response.failed 结束，不把截断的回答伪装成完整回答
                        Some(Err(_)) | None => {
                            state.done = true;
                            state.converter.end_of_stream()
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
                .is_some_and(|turn| turn.route.is_some())
    }

    /// 起标题请求该跟哪个会话走。返回 `None` 表示一轮都没见过，`Some(None)` 是官方，`Some(Some(模型键))` 是第三方。
    /// 1. 请求自己的会话标识有记录：用其中最近的那条。
    /// 2. 否则按开始时间认：Codex 起标题开的是一个临时的新会话（`openai/codex` 的 `tui/src/app/thread_title.rs`），
    ///    标识路由没见过；但元数据里的 `turn_started_at_unix_ms` 与触发它的那一轮几乎相同
    ///    （桌面端标题轮比主轮早约 35 ms 开始，CLI 晚约 1.1 s）。取开始时间在标题轮前后 5 s 内、
    ///    相差最小的一轮（相差一样取最近记下的）。
    /// 3. 还没有这样的一轮：标题请求可能比主轮先到，异步等最多 [`TITLE_TURN_WAIT`]，每记下一轮重查一次。
    /// 4. 等不到，或标题请求没带开始时间（不等）：退回全局最近的一轮，等过的记一行日志
    async fn title_session_route(
        &self,
        keys: &[String],
        started_at: Option<u64>,
    ) -> Option<Option<String>> {
        if let Some(own) = self.own_session_route(keys) {
            return Some(own);
        }
        let Some(started_at) = started_at else {
            return self.latest_route();
        };
        let deadline = tokio::time::Instant::now() + self.title_wait;
        loop {
            // 先登记通知再查表：查完到开始等之间记下的一轮也能把这里叫醒
            let recorded = self.turn_recorded.notified();
            tokio::pin!(recorded);
            recorded.as_mut().enable();
            if let Some(found) = self.closest_turn_route(started_at) {
                return Some(found);
            }
            if tokio::time::timeout_at(deadline, recorded).await.is_err() {
                break;
            }
        }
        if let Some(found) = self.closest_turn_route(started_at) {
            return Some(found);
        }
        log::info!(
            "路由没等到起标题请求对应的那一轮，按全局最近一轮处理：session={} waited_ms={} action=title_fallback_latest",
            session_hash(keys),
            self.title_wait.as_millis()
        );
        self.latest_route()
    }

    /// 请求自己的会话标识里最近的一条记录
    fn own_session_route(&self, keys: &[String]) -> Option<Option<String>> {
        let sessions = self.sessions.lock().unwrap();
        keys.iter()
            .filter_map(|key| sessions.get(key))
            .max_by_key(|turn| turn.at)
            .map(|turn| turn.route.clone())
    }

    /// 全局最近的一轮
    fn latest_route(&self) -> Option<Option<String>> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .max_by_key(|turn| turn.at)
            .map(|turn| turn.route.clone())
    }

    /// 开始时间离 `started_at` 不超过 [`TITLE_TURN_WINDOW_MS`] 的轮次里相差最小的一轮；相差一样取最近记下的
    fn closest_turn_route(&self, started_at: u64) -> Option<Option<String>> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .filter_map(|turn| {
                let gap = turn.started_at?.abs_diff(started_at);
                (gap <= TITLE_TURN_WINDOW_MS).then_some((gap, turn))
            })
            .min_by(|(a_gap, a), (b_gap, b)| a_gap.cmp(b_gap).then(b.at.cmp(&a.at)))
            .map(|(_, turn)| turn.route.clone())
    }

    fn record_session(&self, key: String, route: Option<String>, started_at: Option<u64>) {
        if key.is_empty() {
            return;
        }
        {
            let mut sessions = self.sessions.lock().unwrap();
            if sessions.len() >= MAX_TRACKED_SESSIONS {
                let cutoff = Instant::now() - Duration::from_secs(24 * 3600);
                sessions.retain(|_, turn| turn.at > cutoff);
                if sessions.len() >= MAX_TRACKED_SESSIONS {
                    sessions.clear();
                }
            }
            sessions.insert(
                key,
                SessionTurn {
                    route,
                    at: Instant::now(),
                    started_at,
                },
            );
        }
        self.turn_recorded.notify_waiters();
    }

    /// 只监听回环地址并一直服务
    pub async fn serve(self: Arc<Self>, listener: tokio::net::TcpListener) -> std::io::Result<()> {
        self.serve_until(listener, std::future::pending()).await
    }

    /// 同 [`serve`](Self::serve)，`shutdown` 完成时停止接新连接并放掉端口；已接下的连接各自做完
    pub async fn serve_until(
        self: Arc<Self>,
        listener: tokio::net::TcpListener,
        shutdown: impl std::future::Future<Output = ()>,
    ) -> std::io::Result<()> {
        tokio::pin!(shutdown);
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                () = &mut shutdown => return Ok(()),
            };
            // 接连接出错（文件描述符一时用完等）不让路由整个停掉：路由在 Sophia 进程里，没有 launchd 替它重起
            let (stream, remote) = match accepted {
                Ok(accepted) => accepted,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let router = self.clone();
            tokio::spawn(async move {
                let service =
                    hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                        let router = router.clone();
                        async move {
                            // 先换语言再做来源校验：散请求的 404 也是一句要给人看的话
                            if let Some(lang) = router.locale.as_ref().and_then(|source| source()) {
                                sophia_core::i18n::set_locale(lang);
                            }
                            let (parts, body) = req.into_parts();
                            // 来源校验先于读请求体：不给跨站请求让路由白白缓冲几十兆的机会；
                            // 没带前缀的 Anthropic 请求也在这里就拒绝，请求体一个字节都不读
                            if let Some(rejection) = router.screen(&parts, remote) {
                                return Ok::<_, std::convert::Infallible>(rejection);
                            }
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
                    // 请求头迟迟不来的连接不能一直占着
                    .timer(hyper_util::rt::TokioTimer::new())
                    .header_read_timeout(Duration::from_secs(10))
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    }
}

type UpstreamBody = Pin<Box<dyn Stream<Item = Result<Bytes, BoxError>> + Send>>;

/// 第三方网关拒绝了密钥（401 / 403）
fn is_key_rejection(status: StatusCode) -> bool {
    matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
}

/// 密钥被拒那次请求的技术原文（记到网关行 `详情` 里）：与拉模型、试调失败的原文同一个写法，已去密钥与隐私
fn rejection_detail(method: &str, url: &str, status: StatusCode, body: &[u8], key: &str) -> String {
    crate::provider::status_detail(method, url, status, None, body, key)
}

/// 第三方网关拒绝了密钥：一律回 403，说明是哪家网关拒绝了 Sophia 保存的密钥，附上原文（密钥打码）。
/// 不回 401：Codex 收到 401 会当成自己的 ChatGPT 登录失效（与 Claude 那边 R27 同理）
fn key_rejected(
    provider: &str,
    status: StatusCode,
    body: &[u8],
    key: &str,
) -> Response<UpstreamBody> {
    // 先打码再截取可读文字：截断不能把密钥切成替换不掉的半截
    let scrubbed = String::from_utf8_lossy(body).replace(key, "***");
    let payload = serde_json::json!({"error": {
        "message": format!(
            "third-party gateway {:?} rejected the API key saved in Sophia (HTTP {}): {}",
            log_safe(provider),
            status.as_u16(),
            crate::translate::error_message(scrubbed.as_bytes()),
        ),
        "type": "upstream_error",
        "code": StatusCode::FORBIDDEN.as_u16(),
    }});
    fixed_response(
        StatusCode::FORBIDDEN,
        "application/json",
        payload.to_string().into_bytes(),
    )
}

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

/// 连接没建立成功时一个字节都还没发出去，重试一次是安全的；其他错误不重试
pub(crate) async fn send_with_connect_retry(
    request: reqwest::RequestBuilder,
) -> reqwest::Result<reqwest::Response> {
    let Some(retry) = request.try_clone() else {
        return request.send().await;
    };
    match request.send().await {
        Err(error) if error.is_connect() => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            retry.send().await
        }
        other => other,
    }
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

pub(crate) fn resolve_target(base: &url::Url, suffix: &str, query: &str) -> String {
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

/// 来源校验：本机 agent 的请求来自回环地址、Host 是回环地址、不带 Origin。
/// 其余一律拒绝：否则浏览器里的任意网页都能借路由用上第三方密钥，或用 DNS 重绑定读状态。
/// Claude 命名空间另放行恰为 `app://localhost` 的 Origin（桌面应用渲染进程，R13）。
/// 必须在读请求体之前调用。
fn guard(namespace: Namespace, headers: &HeaderMap, remote: SocketAddr) -> Option<Response<Body>> {
    let host = headers
        .get(hyper::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let single_host = headers.get_all(hyper::header::HOST).iter().count() == 1;
    let local = remote.ip().is_loopback() && single_host && is_loopback_host(host);
    match namespace {
        Namespace::Claude if !local || !claude::origin_allowed(headers) => {
            Some(claude::forbidden())
        }
        Namespace::Claude => None,
        _ if !local || is_browser_request(headers) => Some(json_error(
            StatusCode::FORBIDDEN,
            "router only accepts requests from local agents",
        )),
        _ => None,
    }
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

/// 请求带着 OpenAI 凭据：API key / ChatGPT 令牌（`Authorization`）或 ChatGPT 账号（`ChatGPT-Account-ID`）
fn has_openai_credentials(headers: &HeaderMap) -> bool {
    ["authorization", "chatgpt-account-id"]
        .iter()
        .any(|name| !header_str(headers, name).trim().is_empty())
}

/// Codex 起标题的请求：`x-codex-turn-metadata` 是 JSON，其中 `thread_source` 为 `thread_title`。
/// 没有这个头、读不懂、或不是这个值，都不算
fn is_thread_title(headers: &HeaderMap) -> bool {
    let metadata = header_str(headers, "x-codex-turn-metadata");
    if !metadata.contains("thread_source") {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(metadata).is_ok_and(|value| {
        value.get("thread_source").and_then(|v| v.as_str()) == Some("thread_title")
    })
}

/// 这一轮的开始时间：`x-codex-turn-metadata` 里的 `turn_started_at_unix_ms`（毫秒）。
/// 同一轮的每个请求带的都一样；没有这个头、读不懂、或不是非负整数，都是 `None`
fn turn_started_at(headers: &HeaderMap) -> Option<u64> {
    let metadata = header_str(headers, "x-codex-turn-metadata");
    if !metadata.contains("turn_started_at_unix_ms") {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()?
        .get("turn_started_at_unix_ms")?
        .as_u64()
}

/// 日志里的会话：第一个会话标识的哈希，不记原值
fn session_hash(keys: &[String]) -> String {
    use sha2::{Digest, Sha256};
    keys.first().map_or_else(
        || "-".to_owned(),
        |key| {
            Sha256::digest(key.as_bytes())
                .iter()
                .take(6)
                .map(|b| format!("{b:02x}"))
                .collect()
        },
    )
}

/// 不转官方、在本地拒绝的请求记一行日志：会话哈希、原模型名、处理方式，不记请求内容
fn log_blocked(sessions: &[String], model: &str, action: &str) {
    log::info!(
        "路由拦下不该发往官方的请求：session={} model={} action={action}",
        session_hash(sessions),
        log_safe(model)
    );
}

/// 三个会话头里出现的每个值都算这个会话的标识：审阅请求不一定带全
fn session_keys(headers: &HeaderMap) -> Vec<String> {
    ["session-id", "thread-id", "x-codex-window-id"]
        .iter()
        .map(|name| header_str(headers, name).trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

fn decode_zstd(raw: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let mut source = raw;
    let mut out = Vec::new();
    {
        let mut decoder =
            ruzstd::decoding::StreamingDecoder::new(&mut source).map_err(|e| e.to_string())?;
        decoder
            .by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
    }
    if out.len() > limit {
        return Err("decompressed request body too large".to_owned());
    }
    // 解码器只解第一帧。后面还有内容（第二帧或残片）就拒绝：
    // 否则第一帧写官方模型、后面藏内网请求，就能骗过分流，而官方路径是按原始字节整体转发的。
    if !source.is_empty() {
        return Err("unexpected data after the first zstd frame".to_owned());
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
        &serde_json::json!({"error": {"message": message, "type": "sophia_gateway"}}),
    )
}

struct ActivityLog {
    path: Option<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl ActivityLog {
    /// 只记时间、家、模型、去向、状态、耗时、字节数；不记请求内容和凭据，来自请求的字段先去隐私。
    /// `extra` 是行末的附加字段（以空格开头，如 Claude 关键词回落的 ` fallback=<角色>`）
    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        started: Instant,
        agent: &str,
        method: &str,
        path: &str,
        model: &str,
        route: Route,
        status: u16,
        result: &str,
        extra: &str,
        transfer: Option<(Option<Duration>, u64)>,
    ) {
        let Some(log_path) = self.path.clone() else {
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
        // 模型名、路径来自请求，经 `log_field` 去隐私再落盘；`extra` 由调用方逐个字段用 `log_field` 拼好，
        // 整段再过一次去隐私兜底
        let line = format!("{now} agent={agent} route={} model={} method={method} path={} status={status} duration={}ms result={result}{}{transfer}\n",
            route.name(), log_field(model), log_field(path), started.elapsed().as_millis(), sophia_core::redact::redact(extra));
        let lock = self.lock.clone();
        let append = move || {
            let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            append_activity_line(&log_path, &line, ACTIVITY_LOG_MAX_BYTES);
        };
        // 路由与界面在同一进程（多线程运行时）：写文件放到阻塞线程池里，不占异步运行时的工作线程。
        // 单线程运行时（命令行、测试）照旧当场写，日志行的先后与请求一致
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                handle.spawn_blocking(append);
            }
            _ => append(),
        }
    }
}

/// 活动日志里一个来自请求或上游的字段：先对原文去隐私（spec 2026-10-04-local-diagnostics R3），
/// 再换掉空白与控制字符。顺序不能反：换过空白之后 `Bearer x`、制表符分隔的 JSON 就认不出了
fn log_field(value: &str) -> String {
    log_safe(&sophia_core::redact::redact(value))
}

/// 上游错误原文里账号与密钥标识的前缀（Kimi 限流原话形如 `Your account org-…<ak-…> request reached …`）
const ACCOUNT_ID_PREFIXES: &[&str] = &["org-", "ak-", "sk-"];

/// 把上游原文里形如 `org-…`、`ak-…`、`sk-…` 的标识整段换成 `…`，其余原文照留（reasoning-passback R5）。
/// 标识是一串字母数字与 `-_.`，前缀要在串的开头（`task-ak-1` 不算）、前缀后至少还有一个字符。
/// 不论长短都抹：`redact` 只认 20 字符以上的 `sk-` 密钥，短的账号标识照样能认出人
fn mask_account_ids(text: &str) -> String {
    let token_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(token_char) {
        out.push_str(&rest[..start]);
        let token_len = rest[start..]
            .find(|c: char| !token_char(c))
            .unwrap_or(rest.len() - start);
        let token = &rest[start..start + token_len];
        let masked = ACCOUNT_ID_PREFIXES
            .iter()
            .any(|prefix| token.len() > prefix.len() && token.starts_with(prefix));
        out.push_str(if masked { "…" } else { token });
        rest = &rest[start + token_len..];
    }
    out.push_str(rest);
    out
}

/// `router.log` 的上限：超过就改名 `router.log.1`，只留一份旧的（spec 2026-10-04-local-diagnostics R2）
const ACTIVITY_LOG_MAX_BYTES: u64 = 5_000_000;

/// 追加一行活动日志；文件已到 `max_bytes`、或这一行写进去会越过它，先轮转。写不进去只记一条日志，不影响请求
fn append_activity_line(log_path: &std::path::Path, line: &str, max_bytes: u64) {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) =
        sophia_core::diagnostics::rotate_before_append(log_path, line.len() as u64, max_bytes, 1)
    {
        log::warn!("轮转 {} 失败：{e}", log_path.display());
    }
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Err(e) = options
        .open(log_path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
    {
        log::warn!("写 {} 失败：{e}", log_path.display());
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
    extra: String,
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
                entry.counters.upstream_error();
            }
            let result = if entry.status >= 500 && result == "ok" {
                "upstream_error"
            } else {
                result
            };
            let agent = if entry.route == Route::Claude {
                Agent::Claude
            } else {
                Agent::Codex
            };
            entry.log.write(
                entry.started,
                agent.as_str(),
                &entry.method,
                &entry.path,
                &entry.model,
                entry.route,
                entry.status,
                result,
                &entry.extra,
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

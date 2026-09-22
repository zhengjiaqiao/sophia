//! 拉取第三方模型网关的模型列表。
//!
//! 移植自 agents-manager 的 `internal/provider`（同一作者的 Go 项目，已在真实环境验证），
//! 依赖注入的 [`reqwest::Client`] 换成了异步版本。
use std::time::Duration;

use serde::Deserialize;

/// [`FetchError`] 的分类：鉴权失败、网络不可达/超时、响应不是模型列表。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchErrorKind {
    Auth,
    Network,
    Unexpected,
}

impl FetchErrorKind {
    /// 记在那一家网关上的短原因，界面在那一行显示「连不上」时用它说明为什么
    pub fn unreachable_reason(self) -> &'static str {
        match self {
            FetchErrorKind::Auth => "密钥不对",
            FetchErrorKind::Network => "地址连不上",
            FetchErrorKind::Unexpected => "地址不对，没拿到模型列表",
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
    pub ids: Vec<String>,
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
}

#[derive(Debug, Deserialize)]
struct Wrapped {
    data: Option<Vec<Item>>,
}

fn unexpected(message: &str) -> FetchError {
    FetchError {
        kind: FetchErrorKind::Unexpected,
        message: message.to_string(),
    }
}

fn parse_items(body: &[u8]) -> Result<Vec<Item>, FetchError> {
    if let Ok(wrapped) = serde_json::from_slice::<Wrapped>(body) {
        if let Some(data) = wrapped.data {
            return Ok(data);
        }
    }
    serde_json::from_slice::<Vec<Item>>(body)
        .map_err(|_| unexpected("网关的响应不是模型列表，请检查地址是否正确"))
}

async fn fetch_models_at(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Result<Vec<String>, FetchError> {
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| FetchError {
            kind: FetchErrorKind::Network,
            message: "无法连接网关，请确认地址和网络（内网）可达".to_string(),
        })?;

    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(FetchError {
            kind: FetchErrorKind::Auth,
            message: format!(
                "网关拒绝了这个密钥（HTTP {}），请检查密钥是否正确",
                status.as_u16()
            ),
        });
    }
    if status.as_u16() != 200 {
        return Err(unexpected(&format!(
            "网关返回 HTTP {}，没有拿到模型列表",
            status.as_u16()
        )));
    }

    let body = resp.bytes().await.map_err(|_| FetchError {
        kind: FetchErrorKind::Network,
        message: "读取网关响应失败".to_string(),
    })?;

    let items = parse_items(&body)?;
    let ids: Vec<String> = items
        .into_iter()
        .filter_map(|it| it.id)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() {
        return Err(unexpected("网关返回的模型列表是空的"));
    }
    Ok(ids)
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
            Ok(ids) => return Ok(FetchResult { ids, api_base }),
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
            message: "连接网关超时，请确认网络（内网）可达".to_string(),
        }),
    }
}

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

        assert_eq!(result.ids, vec!["weibo/glm-5", "kimi-k3"]);
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
        assert_eq!(result.ids, vec!["a", "b"]);
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
        assert_eq!(err.kind.unreachable_reason(), "密钥不对");
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
        assert_eq!(err2.kind.unreachable_reason(), "地址连不上");
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
        assert_eq!(err.kind.unreachable_reason(), "地址不对，没拿到模型列表");
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
}

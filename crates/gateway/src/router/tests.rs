//! 路由的行为测试，移植自 agents-manager 的 router_test.go 与 security_test.go。
use super::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

const THIRD_PARTY_KEY: &str = "sk-third-party-secret";
const OFFICIAL_TOKEN: &str = "Bearer official-chatgpt-token";
const SECRET_CONTENT: &str = "INTRANET-ONLY CONTENT";

#[derive(Debug, Clone)]
struct Captured {
    #[allow(dead_code)]
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Captured {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn dump(&self) -> String {
        self.headers
            .iter()
            .map(|(k, v)| format!("{k}: {v}\n"))
            .collect()
    }
}

type Responder = Arc<dyn Fn(&Captured) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync>;

struct FakeUpstream {
    url: String,
    requests: Arc<Mutex<Vec<Captured>>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeUpstream {
    async fn start(responder: Option<Responder>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Captured>>> = Arc::default();
        let store = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let store = store.clone();
                let responder = responder.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                        let store = store.clone();
                        let responder = responder.clone();
                        async move {
                            let (parts, body) = req.into_parts();
                            let body = body
                                .collect()
                                .await
                                .map(|b| b.to_bytes().to_vec())
                                .unwrap_or_default();
                            let captured = Captured {
                                method: parts.method.to_string(),
                                path: parts.uri.path().to_owned(),
                                query: parts.uri.query().unwrap_or("").to_owned(),
                                headers: parts
                                    .headers
                                    .iter()
                                    .map(|(k, v)| {
                                        (k.to_string(), v.to_str().unwrap_or("").to_owned())
                                    })
                                    .collect(),
                                body,
                            };
                            store.lock().unwrap().push(captured.clone());
                            let (status, headers, body) = match &responder {
                                Some(respond) => respond(&captured),
                                None => (
                                    200,
                                    vec![("content-type".into(), "application/json".into())],
                                    br#"{"ok":true}"#.to_vec(),
                                ),
                            };
                            let mut builder = hyper::Response::builder().status(status);
                            for (k, v) in headers {
                                builder = builder.header(k, v);
                            }
                            Ok::<_, std::convert::Infallible>(
                                builder.body(Full::new(Bytes::from(body))).unwrap(),
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
    fn all(&self) -> Vec<Captured> {
        self.requests.lock().unwrap().clone()
    }
    fn only(&self) -> Captured {
        let all = self.all();
        assert_eq!(
            all.len(),
            1,
            "上游应当恰好收到 1 个请求，实际 {}",
            all.len()
        );
        all[0].clone()
    }
    fn stop(&self) {
        self.task.abort();
    }
}

struct Harness {
    router: Arc<Router>,
    third_party: FakeUpstream,
    chatgpt: FakeUpstream,
    openai: FakeUpstream,
    dir: tempfile::TempDir,
}

const DEFAULT_CATALOG: &str =
    r#"{"models":[{"slug":"weibo-glm-5","upstream_model":"weibo/glm-5"},{"slug":"kimi-k3"}]}"#;

impl Harness {
    async fn new(third_party: Option<Responder>) -> Self {
        Self::with_key(third_party, Arc::new(|| Ok(THIRD_PARTY_KEY.to_owned()))).await
    }
    async fn with_key(third_party: Option<Responder>, key: KeySource) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let third_party = FakeUpstream::start(third_party).await;
        let chatgpt = FakeUpstream::start(None).await;
        let openai = FakeUpstream::start(None).await;
        std::fs::write(dir.path().join("routing.json"), DEFAULT_CATALOG).unwrap();
        let router = Router::new(Config {
            third_party_url: format!("{}/openai", third_party.url),
            third_party_protocol: Protocol::Responses,
            chatgpt_url: format!("{}/backend-api/codex", chatgpt.url),
            openai_url: format!("{}/v1", openai.url),
            routing_catalog_path: dir.path().join("routing.json"),
            activity_log_path: Some(dir.path().join("router.log")),
            third_party_key: key,
            max_body_bytes: 0,
            proxy: None,
        })
        .unwrap();
        Self {
            router,
            third_party,
            chatgpt,
            openai,
            dir,
        }
    }
    fn catalog(&self, content: &str) {
        std::fs::write(self.dir.path().join("routing.json"), content).unwrap();
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("router.log")).unwrap_or_default()
    }
    async fn send(&self, req: TestRequest) -> TestResponse {
        let remote: SocketAddr = req.remote.parse().unwrap();
        let mut builder = hyper::Request::builder()
            .method(req.method.as_str())
            .uri(req.path.as_str());
        builder = builder.header("host", req.host.as_str());
        for (k, v) in &req.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        let request = builder.body(Bytes::from(req.body.clone())).unwrap();
        let response = self.router.clone().handle(request, remote).await;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_owned()))
            .collect();
        let body = response
            .into_body()
            .collect()
            .await
            .map(|b| b.to_bytes().to_vec())
            .unwrap_or_default();
        TestResponse {
            status,
            headers,
            body,
        }
    }
    fn official_reached(&self) -> usize {
        self.chatgpt.all().len() + self.openai.all().len()
    }
    fn nothing_secret_reached_official(&self) {
        for req in self.chatgpt.all().into_iter().chain(self.openai.all()) {
            assert!(
                !String::from_utf8_lossy(&req.body).contains(SECRET_CONTENT),
                "内网内容到达了官方上游"
            );
        }
    }
}

#[derive(Clone)]
struct TestRequest {
    method: String,
    path: String,
    host: String,
    remote: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct TestResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl TestResponse {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn official_headers() -> Vec<(String, String)> {
    [
        ("authorization", OFFICIAL_TOKEN),
        ("chatgpt-account-id", "acct-123"),
        ("content-type", "application/json"),
        ("accept", "text/event-stream"),
        ("cookie", "session=official-cookie"),
        ("originator", "codex_desktop"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn post(body: &str) -> TestRequest {
    TestRequest {
        method: "POST".into(),
        path: "/v1/responses".into(),
        host: "127.0.0.1:47328".into(),
        remote: "127.0.0.1:50000".into(),
        headers: official_headers(),
        body: body.as_bytes().to_vec(),
    }
}

fn get(path: &str) -> TestRequest {
    TestRequest {
        method: "GET".into(),
        path: path.into(),
        body: vec![],
        ..post("")
    }
}

fn json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).expect("应当是 JSON")
}

fn sse_ok() -> Responder {
    Arc::new(|_| {
        (
            200,
            vec![("content-type".into(), "text/event-stream".into())],
            b"event: response.completed\ndata: {}\n\n".to_vec(),
        )
    })
}

/// AC4：清单内的模型走第三方，凭据被替换，模型名还原为网关认识的名字
#[tokio::test]
async fn ac4_routed_model_goes_to_third_party_with_swapped_credentials() {
    let h = Harness::new(Some(sse_ok())).await;
    let res = h
        .send(post(
            r#"{"model":"weibo-glm-5","stream":true,"input":"hi","store":false}"#,
        ))
        .await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(res.text().contains("response.completed"));
    let got = h.third_party.only();
    assert_eq!(got.path, "/openai/responses");
    assert_eq!(
        got.header("authorization"),
        Some(&*format!("Bearer {THIRD_PARTY_KEY}"))
    );
    for leaked in ["official-chatgpt-token", "acct-123", "official-cookie"] {
        assert!(
            !got.dump().contains(leaked),
            "官方凭据 {leaked} 泄漏到第三方:\n{}",
            got.dump()
        );
    }
    let sent = json(&got.body);
    assert_eq!(sent["model"], "weibo/glm-5");
    assert_eq!(sent["input"], "hi");
    assert_eq!(sent["stream"], true);
    assert_eq!(h.official_reached(), 0);
}

#[tokio::test]
async fn ac4_routed_model_without_upstream_name_keeps_slug() {
    let h = Harness::new(None).await;
    h.send(post(r#"{"model":"kimi-k3","input":"hi"}"#)).await;
    assert_eq!(json(&h.third_party.only().body)["model"], "kimi-k3");
}

/// AC5：官方模型 + 账号登录走 ChatGPT 后端，请求头与请求体原样透传，不带第三方密钥
#[tokio::test]
async fn ac5_native_model_passes_through_to_chatgpt_untouched() {
    let h = Harness::new(None).await;
    let body = r#"{"model":"gpt-5.6-sol",  "input":"hi" }"#;
    let mut req = post(body);
    req.path = "/v1/responses?x=1".into();
    let res = h.send(req).await;
    assert_eq!(res.status, 200);
    let got = h.chatgpt.only();
    assert_eq!(
        (got.path.as_str(), got.query.as_str()),
        ("/backend-api/codex/responses", "x=1")
    );
    assert_eq!(got.body, body.as_bytes(), "请求体必须逐字节相同");
    for (k, v) in official_headers() {
        assert_eq!(got.header(&k), Some(v.as_str()), "头 {k}");
    }
    assert!(
        !got.dump().contains(THIRD_PARTY_KEY)
            && !String::from_utf8_lossy(&got.body).contains(THIRD_PARTY_KEY)
    );
    assert!(!got
        .headers
        .iter()
        .any(|(k, _)| k.to_lowercase().starts_with("x-forwarded")));
    assert_eq!(h.third_party.all().len(), 0);
}

#[tokio::test]
async fn ac5_native_model_without_account_header_goes_to_openai_api() {
    let h = Harness::new(None).await;
    let mut req = post(r#"{"model":"gpt-5.6-sol"}"#);
    req.headers = vec![("authorization".into(), "Bearer sk-openai-user-key".into())];
    h.send(req).await;
    let got = h.openai.only();
    assert_eq!(got.path, "/v1/responses");
    assert_eq!(
        got.header("authorization"),
        Some("Bearer sk-openai-user-key")
    );
}

fn zstd_frame(data: &[u8]) -> Vec<u8> {
    // 最小的合法 zstd 帧：单段、原始块（不压缩），够测“解得开”
    let mut out = vec![0x28, 0xB5, 0x2F, 0xFD, 0x20, data.len() as u8];
    assert!(data.len() < 256);
    let header = ((data.len() as u32) << 3) | 1; // last block, raw
    out.extend_from_slice(&header.to_le_bytes()[..3]);
    out.extend_from_slice(data);
    out
}

/// AC5：官方路径上 zstd 压缩的请求体按原始字节透传
#[tokio::test]
async fn ac5_native_zstd_body_is_forwarded_byte_for_byte() {
    let h = Harness::new(None).await;
    let compressed = zstd_frame(br#"{"model":"gpt-5.6-sol","input":"hi"}"#);
    let mut req = post("");
    req.body = compressed.clone();
    req.headers.push(("content-encoding".into(), "zstd".into()));
    h.send(req).await;
    let got = h.chatgpt.only();
    assert_eq!(got.body, compressed);
    assert_eq!(got.header("content-encoding"), Some("zstd"));
}

/// AC4：第三方路径上 zstd 请求体被解压、改写模型名，并以明文 JSON 发出
#[tokio::test]
async fn ac4_routed_zstd_body_is_decoded_and_rewritten() {
    let h = Harness::new(None).await;
    let mut req = post("");
    req.body = zstd_frame(br#"{"model":"weibo-glm-5","input":"hi"}"#);
    req.headers.push(("content-encoding".into(), "zstd".into()));
    h.send(req).await;
    let got = h.third_party.only();
    assert_eq!(got.header("content-encoding"), None);
    assert_eq!(json(&got.body)["model"], "weibo/glm-5");
}

/// AC7 的路由部分：同一个路由实例里官方与第三方请求交替进行，各走各的上游
#[tokio::test]
async fn alternating_models_route_independently() {
    let h = Harness::new(None).await;
    for model in ["gpt-5.6-sol", "weibo-glm-5", "gpt-5.6-sol", "kimi-k3"] {
        let res = h.send(post(&format!(r#"{{"model":"{model}"}}"#))).await;
        assert_eq!(res.status, 200, "{model}");
    }
    assert_eq!(h.chatgpt.all().len(), 2);
    assert_eq!(h.third_party.all().len(), 2);
}

/// 真实环境修过的问题：没有请求体的 GET 必须以“无请求体”发出。
/// Go 版曾给它挂了空 Body，HTTP/2 下成为长度未知的请求，Codex 拉官方模型列表每次都在 5 秒时超时。
#[tokio::test]
async fn bodyless_request_goes_to_native_upstream_without_a_body() {
    let h = Harness::new(None).await;
    h.send(get("/v1/models?client_version=0.154.0")).await;
    let got = h.chatgpt.only();
    assert_eq!(got.path, "/backend-api/codex/models");
    assert!(got.body.is_empty());
    assert_eq!(
        got.header("transfer-encoding"),
        None,
        "不能变成分块的未知长度请求"
    );
    assert!(matches!(got.header("content-length"), None | Some("0")));
}

/// AC10：非本机来源、浏览器发起的请求、DNS 重绑定一律拒绝
#[tokio::test]
async fn ac10_non_loopback_browser_and_rebound_requests_are_rejected() {
    type Mutation = Box<dyn Fn(&mut TestRequest)>;
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "non loopback",
            Box::new(|r| r.remote = "192.168.1.20:40000".into()),
        ),
        (
            "origin",
            Box::new(|r| {
                r.headers
                    .push(("origin".into(), "http://evil.example".into()))
            }),
        ),
        (
            "null origin",
            Box::new(|r| r.headers.push(("origin".into(), "null".into()))),
        ),
        (
            "rebound host",
            Box::new(|r| r.host = "evil.example:47328".into()),
        ),
        (
            "cross-site",
            Box::new(|r| {
                r.headers
                    .push(("sec-fetch-site".into(), "cross-site".into()))
            }),
        ),
    ];
    for (name, mutate) in cases {
        let h = Harness::new(None).await;
        for path in ["/v1/responses", "/_status"] {
            let mut req = post(r#"{"model":"weibo-glm-5","input":"hi"}"#);
            req.path = path.into();
            mutate(&mut req);
            assert_eq!(h.send(req).await.status, 403, "{name} {path}");
        }
        assert_eq!(
            h.third_party.all().len() + h.official_reached(),
            0,
            "{name}"
        );
    }
    for host in ["127.0.0.1:47328", "localhost:47328", "[::1]:47328"] {
        let h = Harness::new(None).await;
        let mut req = get("/_health");
        req.host = host.into();
        assert_eq!(h.send(req).await.status, 200, "{host}");
    }
}

#[tokio::test]
async fn websocket_upgrade_gets_426() {
    let h = Harness::new(None).await;
    let mut req = get("/v1/responses");
    req.headers = vec![
        ("upgrade".into(), "websocket".into()),
        ("connection".into(), "Upgrade".into()),
    ];
    assert_eq!(h.send(req).await.status, 426);
}

#[tokio::test]
async fn health_endpoint_identifies_the_service() {
    let h = Harness::new(None).await;
    let res = h.send(get("/_health")).await;
    assert_eq!(res.status, 200);
    let body = json(&res.body);
    assert_eq!(body["ok"], true);
    assert_eq!(body["service"], HEALTH_SERVICE_NAME);
}

/// 读不到路由清单时拒绝服务而不是回落官方：回落会把本应发给内网模型的内容发到外部
#[tokio::test]
async fn missing_routing_catalog_fails_closed() {
    let h = Harness::new(None).await;
    std::fs::remove_file(h.dir.path().join("routing.json")).unwrap();
    assert_eq!(h.send(post(r#"{"model":"weibo-glm-5"}"#)).await.status, 503);
    assert_eq!(h.third_party.all().len() + h.official_reached(), 0);
}

#[tokio::test]
async fn routing_catalog_is_reloaded_per_request() {
    let h = Harness::new(None).await;
    h.catalog(r#"{"models":[{"slug":"new-model"}]}"#);
    h.send(post(r#"{"model":"new-model"}"#)).await;
    h.send(post(r#"{"model":"weibo-glm-5"}"#)).await;
    assert_eq!(h.third_party.all().len(), 1);
    assert_eq!(h.chatgpt.all().len(), 1);
}

#[tokio::test]
async fn third_party_key_unavailable_does_not_forward() {
    let h = Harness::with_key(None, Arc::new(|| Err("not set".to_owned()))).await;
    let res = h.send(post(r#"{"model":"weibo-glm-5"}"#)).await;
    assert_eq!(res.status, 502);
    assert!(res.text().contains("key") || res.text().contains("密钥"));
    assert_eq!(h.third_party.all().len(), 0);
}

/// 内网不通时第三方请求失败，但官方请求不受影响
#[tokio::test]
async fn third_party_down_does_not_affect_native() {
    let h = Harness::new(None).await;
    h.third_party.stop();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(h.send(post(r#"{"model":"weibo-glm-5"}"#)).await.status, 502);
    assert_eq!(h.send(post(r#"{"model":"gpt-5.6-sol"}"#)).await.status, 200);
}

#[tokio::test]
async fn third_party_error_is_passed_through() {
    let h = Harness::new(Some(Arc::new(|_| {
        (
            401,
            vec![("content-type".into(), "application/json".into())],
            br#"{"type":"error","error":"Unauthorized"}"#.to_vec(),
        )
    })))
    .await;
    let res = h.send(post(r#"{"model":"weibo-glm-5"}"#)).await;
    assert_eq!(res.status, 401);
    assert!(res.text().contains("Unauthorized"));
}

/// 日志只记时间、模型、去向、状态码，不含凭据和请求内容
#[tokio::test]
async fn activity_log_has_route_but_no_secrets_or_content() {
    let h = Harness::new(None).await;
    h.send(post(
        r#"{"model":"weibo-glm-5","input":"private prompt text"}"#,
    ))
    .await;
    h.send(post(
        r#"{"model":"gpt-5.6-sol","input":"private prompt text"}"#,
    ))
    .await;
    let log = h.log();
    for want in [
        "route=third_party",
        "model=weibo-glm-5",
        "route=chatgpt",
        "model=gpt-5.6-sol",
        "status=200",
    ] {
        assert!(log.contains(want), "日志缺少 {want}:\n{log}");
    }
    for secret in [
        THIRD_PARTY_KEY,
        "official-chatgpt-token",
        "official-cookie",
        "acct-123",
        "private prompt text",
    ] {
        assert!(!log.contains(secret), "日志含有 {secret}");
    }
}

/// AC9：已取消勾选的模型必须拒绝，绝不能当成“不认识的模型”放行到官方上游
#[tokio::test]
async fn ac9_retired_third_party_model_is_rejected_not_sent_to_official() {
    let h = Harness::new(None).await;
    h.catalog(r#"{"models":[{"slug":"kimi-k3"}],"retired":["weibo-glm-5"]}"#);
    let res = h
        .send(post(&format!(
            r#"{{"model":"weibo-glm-5","input":"{SECRET_CONTENT}"}}"#
        )))
        .await;
    assert_eq!(res.status, 409);
    assert!(res.text().contains("Codex"));
    h.nothing_secret_reached_official();
    assert_eq!(h.official_reached(), 0);
}

/// AC9：模型名的大小写、空白、零宽字符变体仍按第三方模型处理
#[tokio::test]
async fn ac9_model_name_variants_still_route_to_third_party() {
    for variant in [
        "Weibo-GLM-5",
        " weibo-glm-5 ",
        "weibo-glm-5\u{200b}",
        "WEIBO-GLM-5",
    ] {
        let h = Harness::new(None).await;
        let body = serde_json::json!({"model": variant, "input": SECRET_CONTENT}).to_string();
        let res = h.send(post(&body)).await;
        assert_eq!(
            (res.status, h.third_party.all().len()),
            (200, 1),
            "{variant:?}"
        );
        assert_eq!(h.official_reached(), 0, "{variant:?}");
    }
}

/// AC9：读不懂的请求一律拒绝
#[tokio::test]
async fn ac9_ambiguous_or_unreadable_requests_fail_closed() {
    let s = SECRET_CONTENT;
    let cases: Vec<(&str, Vec<u8>, Option<&str>, u16)> = vec![
        (
            "model is array",
            format!(r#"{{"model":["weibo-glm-5"],"input":"{s}"}}"#).into_bytes(),
            None,
            400,
        ),
        (
            "case variant key",
            format!(r#"{{"model":"weibo-glm-5","Model":"gpt-5.6-sol","input":"{s}"}}"#)
                .into_bytes(),
            None,
            400,
        ),
        (
            "case variant key rev",
            format!(r#"{{"model":"gpt-5.6-sol","Model":"weibo-glm-5","input":"{s}"}}"#)
                .into_bytes(),
            None,
            400,
        ),
        (
            "duplicate key",
            format!(r#"{{"model":"gpt-5.6-sol","model":"weibo-glm-5","input":"{s}"}}"#)
                .into_bytes(),
            None,
            400,
        ),
        (
            "bom",
            [
                b"\xef\xbb\xbf".to_vec(),
                format!(r#"{{"model":"weibo-glm-5","input":"{s}"}}"#).into_bytes(),
            ]
            .concat(),
            None,
            400,
        ),
        (
            "not json",
            format!("model=weibo-glm-5&input={s}").into_bytes(),
            None,
            400,
        ),
        (
            "gzip",
            format!(r#"{{"model":"weibo-glm-5","input":"{s}"}}"#).into_bytes(),
            Some("gzip"),
            415,
        ),
    ];
    for (name, body, encoding, want) in cases {
        let h = Harness::new(None).await;
        let mut req = post("");
        req.body = body;
        if let Some(encoding) = encoding {
            req.headers
                .push(("content-encoding".into(), encoding.into()));
        }
        assert_eq!(h.send(req).await.status, want, "{name}");
        assert_eq!(
            h.third_party.all().len() + h.official_reached(),
            0,
            "{name}: 不应转发"
        );
    }
}

/// 第三方的重定向不交给 Codex 去跟随，也不把上游的跨域许可头带回来
#[tokio::test]
async fn third_party_redirect_and_cors_headers_are_not_passed_through() {
    let h = Harness::new(Some(Arc::new(|_| {
        (
            307,
            vec![
                ("location".into(), "https://attacker.example/collect".into()),
                ("set-cookie".into(), "x=1".into()),
            ],
            vec![],
        )
    })))
    .await;
    let res = h.send(post(r#"{"model":"weibo-glm-5"}"#)).await;
    assert_eq!(res.status, 502);
    assert!(res.header("location").is_none() && res.header("set-cookie").is_none());

    let h = Harness::new(Some(Arc::new(|_| {
        (
            200,
            vec![
                ("access-control-allow-origin".into(), "*".into()),
                ("set-cookie".into(), "x=1".into()),
            ],
            b"{}".to_vec(),
        )
    })))
    .await;
    let res = h.send(post(r#"{"model":"weibo-glm-5"}"#)).await;
    assert!(
        res.header("access-control-allow-origin").is_none() && res.header("set-cookie").is_none()
    );
}

/// 会话用过内网模型后，Codex 的自动审阅请求不能静默发给官方上游（尽力而为，靠请求头里的会话标识）
#[tokio::test]
async fn auto_review_for_third_party_session_is_not_sent_to_official() {
    let h = Harness::new(None).await;
    let with_session = |body: &str, session: &str| {
        let mut req = post(body);
        req.headers.push(("session-id".into(), session.into()));
        req
    };
    h.send(with_session(
        r#"{"model":"weibo-glm-5","input":"hi"}"#,
        "sess-1",
    ))
    .await;
    let res = h
        .send(with_session(
            &format!(r#"{{"model":"codex-auto-review","input":"{SECRET_CONTENT}"}}"#),
            "sess-1",
        ))
        .await;
    assert_eq!(res.status, 409);
    h.nothing_secret_reached_official();
    h.send(with_session(
        r#"{"model":"gpt-5.6-sol","input":"hi"}"#,
        "sess-1",
    ))
    .await;
    assert_eq!(
        h.send(with_session(
            r#"{"model":"codex-auto-review","input":"ok"}"#,
            "sess-1"
        ))
        .await
        .status,
        200
    );
    assert_eq!(
        h.send(with_session(
            r#"{"model":"codex-auto-review","input":"ok"}"#,
            "sess-2"
        ))
        .await
        .status,
        200
    );
}

#[test]
fn log_safe_truncates_on_char_boundary() {
    let long = "模".repeat(200);
    let cleaned = log_safe(&long);
    assert!(long.starts_with(&cleaned) && !cleaned.is_empty());
    assert_eq!(log_safe("a b\nc"), "a_b_c");
    assert_eq!(log_safe(""), "-");
}

/// 流式响应逐块转发：上游还没结束，第一块就已经到达客户端
#[tokio::test]
async fn native_streaming_response_is_forwarded_incrementally() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // 手写一个分两次写出、中间停顿的上游
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = stream.read(&mut buf).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n6\r\nfirst\n\r\n")
            .await
            .unwrap();
        stream.flush().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        stream
            .write_all(b"7\r\nsecond\n\r\n0\r\n\r\n")
            .await
            .unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("routing.json"), r#"{"models":[]}"#).unwrap();
    let router = Router::new(Config {
        third_party_url: "http://127.0.0.1:9".into(),
        third_party_protocol: Protocol::Responses,
        chatgpt_url: upstream.clone(),
        openai_url: upstream,
        routing_catalog_path: dir.path().join("routing.json"),
        activity_log_path: None,
        third_party_key: Arc::new(|| Ok("k".into())),
        max_body_bytes: 0,
        proxy: None,
    })
    .unwrap();
    let request = hyper::Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("host", "127.0.0.1:1")
        .body(Bytes::from_static(br#"{"model":"gpt-5.6-sol"}"#))
        .unwrap();
    let started = std::time::Instant::now();
    let response = router.handle(request, "127.0.0.1:5".parse().unwrap()).await;
    let mut body = response.into_body();
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(&first[..], b"first\n");
    assert!(
        started.elapsed() < std::time::Duration::from_millis(500),
        "第一块被缓冲到了上游结束之后"
    );
}

// ---------- 协议转换（wecode 只支持 Chat Completions 的实测情况） ----------

impl Harness {
    async fn chat(third_party: Option<Responder>) -> Self {
        let mut h = Self::new(third_party).await;
        h.router = Router::new(Config {
            third_party_url: format!("{}/openai/v1", h.third_party.url),
            third_party_protocol: Protocol::Chat,
            chatgpt_url: format!("{}/backend-api/codex", h.chatgpt.url),
            openai_url: format!("{}/v1", h.openai.url),
            routing_catalog_path: h.dir.path().join("routing.json"),
            activity_log_path: Some(h.dir.path().join("router.log")),
            third_party_key: Arc::new(|| Ok(THIRD_PARTY_KEY.to_owned())),
            max_body_bytes: 0,
            proxy: None,
        })
        .unwrap();
        h
    }
}

fn chat_sse(chunks: &[&str]) -> Responder {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str(&format!("data: {chunk}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    Arc::new(move |_| {
        (
            200,
            vec![("content-type".into(), "text/event-stream".into())],
            body.clone().into_bytes(),
        )
    })
}

const RESPONSES_BODY: &str = r#"{"model":"weibo-glm-5","stream":true,"store":false,"instructions":"You are Codex.",
  "include":["reasoning.encrypted_content"],"prompt_cache_key":"k",
  "tools":[{"type":"function","name":"exec_command","parameters":{"type":"object"}},{"type":"web_search"}],
  "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}"#;

/// AC4：路由把 Codex 的 Responses 请求转成 Chat Completions，再把流转回来
#[tokio::test]
async fn ac4_chat_protocol_translates_both_directions() {
    let h = Harness::chat(Some(chat_sse(&[
        r#"{"choices":[{"index":0,"delta":{"content":"你好"}}]}"#,
        r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        r#"{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}"#,
    ])))
    .await;
    let res = h.send(post(RESPONSES_BODY)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(res
        .header("content-type")
        .unwrap_or("")
        .contains("text/event-stream"));
    let out = res.text();
    for want in [
        "event: response.created",
        "event: response.output_text.delta",
        "你好",
        "event: response.completed",
        "\"input_tokens\":9",
    ] {
        assert!(out.contains(want), "客户端流里缺少 {want}:\n{out}");
    }
    let got = h.third_party.only();
    assert_eq!(got.path, "/openai/v1/chat/completions");
    assert_eq!(
        got.header("authorization"),
        Some(&*format!("Bearer {THIRD_PARTY_KEY}"))
    );
    assert!(!got.dump().contains("official"));
    let chat = json(&got.body);
    assert_eq!(chat["model"], "weibo/glm-5");
    assert_eq!(chat["stream"], true);
    assert_eq!(chat["messages"].as_array().unwrap().len(), 2);
    assert_eq!(chat["tools"].as_array().unwrap().len(), 1);
    let raw = String::from_utf8_lossy(&got.body);
    for leaked in ["prompt_cache_key", "encrypted_content", "web_search"] {
        assert!(!raw.contains(leaked), "{leaked} 漏进了 chat 请求");
    }
}

/// AC6：上游的工具调用转成 Codex 的 function_call 条目
#[tokio::test]
async fn ac6_chat_protocol_tool_call() {
    let h = Harness::chat(Some(chat_sse(&[
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"cat hello.txt\"}"}}]}}]}"#,
        r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
    ])))
    .await;
    let out = h.send(post(RESPONSES_BODY)).await.text();
    assert!(
        out.contains("\"type\":\"function_call\"")
            && out.contains("\"call_id\":\"call_1\"")
            && out.contains("cat hello.txt"),
        "{out}"
    );
}

/// 网关报错时 Codex 要拿到状态码和能读的错误文字（wecode 的错误体不是 OpenAI 的格式）
#[tokio::test]
async fn chat_protocol_upstream_error_is_readable() {
    let h = Harness::chat(Some(Arc::new(|_| {
        (429, vec![("content-type".into(), "application/json".into())],
         r#"{"type":"error","error":{"type":"error","message":"当月商业模型 token 额度已用尽"}}"#.as_bytes().to_vec())
    })))
    .await;
    let res = h.send(post(RESPONSES_BODY)).await;
    assert_eq!(res.status, 429);
    assert!(json(&res.body)["error"]["message"]
        .as_str()
        .unwrap()
        .contains("额度已用尽"));
}

/// AC8：远程压缩对上游是一次非流式“请总结”，回给 Codex 恰好一个压缩条目
#[tokio::test]
async fn ac8_chat_protocol_compaction() {
    let h = Harness::chat(Some(Arc::new(|_| {
        (200, vec![("content-type".into(), "application/json".into())],
         br#"{"choices":[{"message":{"role":"assistant","content":"SUMMARY TEXT"}}],"usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55}}"#.to_vec())
    })))
    .await;
    let body = r#"{"model":"weibo-glm-5","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"long"}]},{"type":"compaction_trigger"}]}"#;
    let res = h.send(post(body)).await;
    assert_eq!(json(&h.third_party.only().body)["stream"], false);
    let out = res.text();
    assert_eq!(
        out.matches("event: response.output_item.done").count(),
        1,
        "{out}"
    );
    assert!(out.contains("\"type\":\"compaction\"") && out.contains("event: response.completed"));
    assert!(
        !out.contains("SUMMARY TEXT"),
        "摘要应当被编码进压缩条目，而不是明文出现"
    );
}

/// 不要流式的客户端拿到的是一个完整的 Responses 对象
#[tokio::test]
async fn chat_protocol_non_streaming_client() {
    let h = Harness::chat(Some(chat_sse(&[
        r#"{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}"#,
    ])))
    .await;
    let res = h
        .send(post(
            r#"{"model":"weibo-glm-5","stream":false,"input":"hi"}"#,
        ))
        .await;
    let response = json(&res.body);
    assert_eq!(response["object"], "response");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["content"][0]["text"], "ok");
}

/// AC7：从第三方模型切回官方模型时，历史里本功能产生的推理条目要剔除，否则官方上游会拒绝整个请求
#[tokio::test]
async fn ac7_native_request_is_cleaned_of_our_items() {
    let h = Harness::chat(None).await;
    let body = format!(
        r#"{{"model":"gpt-5.6-sol","input":[{{"type":"reasoning","id":"{}1","summary":[]}},{{"type":"message","role":"user","content":[{{"type":"input_text","text":"go on"}}]}}]}}"#,
        crate::translate::REASONING_ID_PREFIX
    );
    h.send(post(&body)).await;
    let got = h.chatgpt.only();
    let raw = String::from_utf8_lossy(&got.body);
    assert!(
        !raw.contains(crate::translate::REASONING_ID_PREFIX) && raw.contains("go on"),
        "{raw}"
    );
    assert_eq!(got.header("authorization"), Some(OFFICIAL_TOKEN));
}

/// 真实环境里见过一次：进程刚重启后的第一个上游连接瞬时失败。
/// 连接没建立成功时一个字节都还没发出去，重试一次是安全的。
#[tokio::test]
async fn connect_failure_is_retried_once() {
    // 先占一个端口再放掉，得到一个此刻没人监听的地址
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = probe.local_addr().unwrap();
    drop(probe);
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let listener = TcpListener::bind(address).await.unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let service = service_fn(|_req: hyper::Request<hyper::body::Incoming>| async {
            Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from_static(
                b"{\"late\":true}",
            ))))
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("routing.json"), r#"{"models":[]}"#).unwrap();
    let router = Router::new(Config {
        third_party_url: "http://127.0.0.1:9".into(),
        third_party_protocol: Protocol::Responses,
        chatgpt_url: format!("http://{address}"),
        openai_url: format!("http://{address}"),
        routing_catalog_path: dir.path().join("routing.json"),
        activity_log_path: None,
        third_party_key: Arc::new(|| Ok("k".into())),
        max_body_bytes: 0,
        proxy: None,
    })
    .unwrap();
    let request = hyper::Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .header("host", "127.0.0.1:1")
        .body(Bytes::from_static(br#"{"model":"gpt-5.6-sol"}"#))
        .unwrap();
    let response = router.handle(request, "127.0.0.1:5".parse().unwrap()).await;
    assert_eq!(response.status(), 200);
}

// ---------- 独立验证（2026-09-20）发现的问题的回归测试 ----------

/// 解析失败不能成为放行到官方上游的理由：不管什么方法、什么路径，只要请求体看起来是 JSON 或声明为 JSON，读不懂就拒绝
#[tokio::test]
async fn unreadable_json_fails_closed_on_any_method_and_path() {
    let secret = SECRET_CONTENT;
    let cases: Vec<(&str, &str, &str, String)> = vec![
        (
            "PUT",
            "/v1/responses",
            "application/json",
            format!(r#"{{"model":"weibo-glm-5","input":"{secret}"}} x"#),
        ),
        (
            "PATCH",
            "/v1/responses",
            "application/json",
            format!(r#"{{"model":"weibo-glm-5","input":"{secret}""#),
        ),
        (
            "POST",
            "/v1/chat/completions",
            "text/plain",
            format!(r#"{{"model":"weibo-glm-5","input":"{secret}"}} trailing"#),
        ),
        (
            "POST",
            "/v1/other",
            "text/plain",
            format!(r#"  {{"model":"weibo-glm-5","input":"{secret}""#),
        ),
    ];
    for (method, path, content_type, body) in cases {
        let h = Harness::new(None).await;
        let mut req = post(&body);
        req.method = method.into();
        req.path = path.into();
        req.headers.retain(|(k, _)| k != "content-type");
        req.headers
            .push(("content-type".into(), content_type.into()));
        let res = h.send(req).await;
        assert_eq!(res.status, 400, "{method} {path}");
        assert_eq!(
            h.official_reached() + h.third_party.all().len(),
            0,
            "{method} {path}: 不应转发"
        );
    }
}

/// zstd 请求体里第一帧之后还有内容（第二帧或残片）：拒绝。否则第一帧写官方模型、后面藏内网请求就能骗过分流
#[tokio::test]
async fn zstd_body_with_anything_after_the_first_frame_is_rejected() {
    let first = zstd_frame(br#"{"model":"gpt-5.6-sol"}"#);
    let second =
        zstd_frame(format!(r#"{{"model":"weibo-glm-5","input":"{SECRET_CONTENT}"}}"#).as_bytes());
    for tail in [second, vec![0x28, 0xB5, 0x2F]] {
        let h = Harness::new(None).await;
        let mut req = post("");
        req.body = [first.clone(), tail].concat();
        req.headers.push(("content-encoding".into(), "zstd".into()));
        assert_eq!(h.send(req).await.status, 400);
        assert_eq!(h.official_reached(), 0);
    }
}

/// 路径里的 `..` 和空段不转发：否则能带着凭据访问上游同主机的其他路径
#[tokio::test]
async fn path_traversal_is_rejected() {
    for path in ["/v1/../../etc", "/v1/responses/../../x", "/v1//responses"] {
        let h = Harness::new(None).await;
        let mut req = post(r#"{"model":"gpt-5.6-sol"}"#);
        req.path = path.into();
        assert_eq!(h.send(req).await.status, 400, "{path}");
        assert_eq!(h.official_reached(), 0, "{path}");
    }
}

/// 自动审阅的会话识别：三个会话头里任何一个对得上都算同一会话
#[tokio::test]
async fn auto_review_block_matches_any_session_header() {
    let h = Harness::new(None).await;
    let mut first = post(r#"{"model":"weibo-glm-5","input":"hi"}"#);
    first.headers.push(("thread-id".into(), "t-1".into()));
    first
        .headers
        .push(("x-codex-window-id".into(), "w-1".into()));
    h.send(first).await;
    let mut review = post(&format!(
        r#"{{"model":"codex-auto-review","input":"{SECRET_CONTENT}"}}"#
    ));
    review
        .headers
        .push(("x-codex-window-id".into(), "w-1".into()));
    assert_eq!(h.send(review).await.status, 409);
    h.nothing_secret_reached_official();
}

/// 状态接口里的模型名同样要清洗和截断
#[tokio::test]
async fn status_does_not_echo_raw_model_names() {
    let h = Harness::new(None).await;
    let bidi = char::from_u32(0x202e).unwrap();
    let zero_width = char::from_u32(0x200b).unwrap();
    let model = format!("{}{bidi}", "x".repeat(5000));
    h.send(post(&serde_json::json!({ "model": model }).to_string()))
        .await;
    let status = h.router.status();
    assert!(status.last_model.chars().count() <= 120 && !status.last_model.contains(bidi));
    let cleaned = log_safe(&format!("a{bidi}b{zero_width}c"));
    assert!(!cleaned.contains(bidi) && !cleaned.contains(zero_width));
}

/// 网关的错误体里若回显了第三方密钥，不能原样转给本机客户端
#[tokio::test]
async fn chat_error_body_does_not_relay_the_third_party_key() {
    let h = Harness::chat(Some(Arc::new(|req: &Captured| {
        let echoed = req.header("authorization").unwrap_or("").to_owned();
        (
            401,
            vec![],
            format!(r#"{{"error":{{"message":"bad credentials: {echoed}"}}}}"#).into_bytes(),
        )
    })))
    .await;
    let res = h.send(post(RESPONSES_BODY)).await;
    assert_eq!(res.status, 401);
    assert!(!res.text().contains(THIRD_PARTY_KEY), "{}", res.text());
}

/// 来源校验必须先于读请求体：带 Origin 的请求不该等它把几十兆请求体发完才被拒绝；请求头迟迟不来也不能一直占着连接
#[tokio::test]
async fn origin_is_checked_before_the_body_is_read() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let h = Harness::new(None).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(h.router.clone().serve(listener));
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    // 声明 50MB 的请求体，但只发请求头
    stream
        .write_all(format!("POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nOrigin: http://evil.example\r\nContent-Length: 52428800\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buffer = vec![0u8; 256];
    let read = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buffer))
        .await
        .expect("应当立刻拒绝，而不是等请求体")
        .unwrap();
    assert!(
        String::from_utf8_lossy(&buffer[..read]).starts_with("HTTP/1.1 403"),
        "{}",
        String::from_utf8_lossy(&buffer[..read])
    );
}

/// AC30（代理验证）：本机转发引入的额外延迟 P95 < 50ms
#[tokio::test]
async fn ac30_proxy_overhead_p95_under_50ms() {
    let h = Harness::new(None).await;
    let mut durations = Vec::new();
    for _ in 0..50 {
        let started = std::time::Instant::now();
        assert_eq!(h.send(post(r#"{"model":"gpt-5.6-sol"}"#)).await.status, 200);
        durations.push(started.elapsed());
    }
    durations.sort();
    assert!(
        durations[47] < std::time::Duration::from_millis(50),
        "P95 = {:?}",
        durations[47]
    );
}

/// 密钥兜底不能只在协议转换那条路上：原样转发的第三方路径同样可能回显密钥
#[tokio::test]
async fn responses_error_body_does_not_relay_the_third_party_key() {
    let h = Harness::new(Some(Arc::new(|req: &Captured| {
        let echoed = req.header("authorization").unwrap_or("").to_owned();
        (
            401,
            vec![("content-type".into(), "application/json".into())],
            format!(r#"{{"error":{{"message":"bad credentials: {echoed}"}}}}"#).into_bytes(),
        )
    })))
    .await;
    let res = h.send(post(r#"{"model":"weibo-glm-5"}"#)).await;
    assert_eq!(res.status, 401);
    assert!(!res.text().contains(THIRD_PARTY_KEY), "{}", res.text());
}

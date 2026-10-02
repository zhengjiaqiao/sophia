//! 家 claude 的路由测试（spec AC2、AC10–AC17、AC19、AC22–AC28 的路由部分）。
//! 路由在本机回环上起真实 HTTP，上游是本地假服务；样本回放用 `tests/data/claude-code/`。
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

const TOKEN: &str = "sophia-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MESSAGES: &str = r#"{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}"#;

fn data(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/data/claude-code")
            .join(name),
    )
    .unwrap()
}

fn claude_catalog(upstream: &str) -> String {
    serde_json::json!({
        "agent": "claude",
        "providers": [{"id": "ap", "name": "AP", "base_url": format!("{upstream}/v1"), "protocol": "chat"}],
        "models": [
            {"slug": "claude-sonnet-5", "upstream_model": "kimi-k3", "provider": "ap", "label": "Kimi K3"},
            {"slug": "claude-sonnet-5-r2", "upstream_model": "qwen-max", "provider": "ap", "label": "Qwen Max"},
            {"slug": "claude-haiku-4-5", "upstream_model": "glm-lite", "provider": "ap", "label": "GLM Lite"}
        ],
        "retired": []
    })
    .to_string()
}

/// 令牌来源：可换值、记读取次数
#[derive(Clone)]
struct Tokens {
    value: Arc<Mutex<Option<String>>>,
    reads: Arc<AtomicUsize>,
}

impl Tokens {
    fn new() -> Self {
        Self {
            value: Arc::new(Mutex::new(Some(TOKEN.to_owned()))),
            reads: Arc::default(),
        }
    }
    fn source(&self) -> TokenSource {
        let tokens = self.clone();
        Arc::new(move || {
            tokens.reads.fetch_add(1, AtomicOrdering::SeqCst);
            tokens
                .value
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "not set".to_owned())
        })
    }
    fn set(&self, token: &str) {
        *self.value.lock().unwrap() = Some(token.to_owned());
    }
    fn reads(&self) -> usize {
        self.reads.load(AtomicOrdering::SeqCst)
    }
}

/// Codex 那一套假上游照旧（用来断言「官方上游 0 次」），外加 Claude 清单与令牌
struct ClaudeHarness {
    h: Harness,
    tokens: Tokens,
}

fn claude_key(agent: Agent, id: &str) -> String {
    format!("sk-{}-{id}-secret", agent.as_str())
}

impl ClaudeHarness {
    async fn new(third_party: Option<Responder>) -> Self {
        Self::build(third_party, Duration::from_millis(100), true).await
    }

    async fn build(third_party: Option<Responder>, keepalive: Duration, claude: bool) -> Self {
        let mut h = Harness::new(third_party).await;
        std::fs::write(
            h.dir.path().join("claude-routing.json"),
            claude_catalog(&h.third_party.url),
        )
        .unwrap();
        let tokens = Tokens::new();
        h.router = Router::new(Config {
            third_party_url: String::new(),
            third_party_protocol: Protocol::Chat,
            chatgpt_url: format!("{}/backend-api/codex", h.chatgpt.url),
            openai_url: format!("{}/v1", h.openai.url),
            routing_catalog_path: h.dir.path().join("routing.json"),
            activity_log_path: Some(h.dir.path().join("router.log")),
            third_party_key: Arc::new(|agent, id| Ok(claude_key(agent, id))),
            max_body_bytes: 0,
            proxy: None,
            claude_routing_path: claude.then(|| h.dir.path().join("claude-routing.json")),
            router_token: tokens.source(),
            keepalive,
        })
        .unwrap();
        Self { h, tokens }
    }

    fn claude_catalog(&self, content: &str) {
        std::fs::write(self.h.dir.path().join("claude-routing.json"), content).unwrap();
    }

    async fn send(&self, req: TestRequest) -> TestResponse {
        self.h.send(req).await
    }

    /// Codex 的官方上游与第三方上游都没收到任何请求
    fn nothing_forwarded(&self) -> bool {
        self.h.official_reached() + self.h.third_party.all().len() == 0
    }
}

fn claude_req(method: &str, path: &str, body: &str) -> TestRequest {
    TestRequest {
        method: method.into(),
        path: path.into(),
        host: "127.0.0.1:47328".into(),
        remote: "127.0.0.1:50000".into(),
        headers: vec![
            ("authorization".into(), format!("Bearer {TOKEN}")),
            ("content-type".into(), "application/json".into()),
            ("anthropic-version".into(), "2023-06-01".into()),
            ("anthropic-beta".into(), "claude-code-20250219".into()),
            (
                "anthropic-dangerous-direct-browser-access".into(),
                "true".into(),
            ),
            ("x-app".into(), "cli".into()),
            ("x-claude-code-session-id".into(), "session-123".into()),
            ("user-agent".into(), "claude-cli/2.1.283".into()),
        ],
        body: body.as_bytes().to_vec(),
    }
}

fn messages_req(body: &str) -> TestRequest {
    claude_req("POST", "/claude/v1/messages?beta=true", body)
}

fn without(mut req: TestRequest, name: &str) -> TestRequest {
    req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
    req
}

fn with(mut req: TestRequest, name: &str, value: &str) -> TestRequest {
    req.headers.push((name.into(), value.into()));
    req
}

fn messages_with_model(model: &str) -> String {
    MESSAGES.replace("claude-sonnet-5", model)
}

/// SSE 文本 → (事件名, 数据)
fn sse_events(text: &str) -> Vec<(String, serde_json::Value)> {
    text.split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut name = String::new();
            let mut data = String::new();
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("event:") {
                    name = rest.trim().to_owned();
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data.push_str(rest.trim());
                }
            }
            (name, serde_json::from_str(&data).unwrap_or_default())
        })
        .collect()
}

fn event_names(text: &str) -> Vec<String> {
    sse_events(text).into_iter().map(|(name, _)| name).collect()
}

fn anthropic_error(res: &TestResponse) -> (String, String) {
    let body = json(&res.body);
    assert_eq!(body["type"], "error", "{}", res.text());
    (
        body["error"]["type"].as_str().unwrap_or("").to_owned(),
        body["error"]["message"].as_str().unwrap_or("").to_owned(),
    )
}

fn text_stream() -> Responder {
    chat_sse(&[
        r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}"#,
        r#"{"choices":[{"index":0,"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#,
    ])
}

// ---------- 命名空间（R11） ----------

/// AC11：前两个进 Claude 分派；无前缀的 Anthropic 形状请求 404 且什么都不转发；普通 Codex 请求照旧
#[tokio::test]
async fn ac11_namespaces_split_and_stray_anthropic_requests_never_reach_official() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    let got = c.h.third_party.only();
    assert_eq!(got.path, "/v1/chat/completions");
    assert_eq!(got.query, "", "查询串不带给上游");
    let hello = c
        .send(without(
            claude_req("HEAD", "/claude/api/hello", ""),
            "authorization",
        ))
        .await;
    assert_eq!(hello.status, 200);

    let strays: Vec<TestRequest> = vec![
        claude_req("POST", "/v1/messages", MESSAGES),
        claude_req("POST", "/v1/messages/count_tokens", MESSAGES),
        without(claude_req("GET", "/api/foo", ""), "anthropic-version"),
        {
            let mut req = get("/v1/models");
            req.headers
                .push(("anthropic-version".into(), "2023-06-01".into()));
            req
        },
        {
            let mut req = post(&format!(
                r#"{{"model":"gpt-5.6-sol","input":"{SECRET_CONTENT}"}}"#
            ));
            req.headers.push(("x-api-key".into(), "anything".into()));
            req
        },
    ];
    for req in strays {
        let path = req.path.clone();
        let res = c.send(req).await;
        assert_eq!(res.status, 404, "{path}: {}", res.text());
        assert_eq!(anthropic_error(&res).0, "not_found_error", "{path}");
    }
    assert_eq!(c.h.official_reached(), 0, "散请求不能落到官方转发");
    assert_eq!(c.h.third_party.all().len(), 1);

    // 不带任何 Anthropic 特征的 Codex 请求照今天转发
    let res = c
        .send(post(r#"{"model":"gpt-5.6-sol","input":"hi"}"#))
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(c.h.chatgpt.all().len(), 1);
}

/// AC11：散请求在读请求体之前就被拒绝（声明 50MB 的请求体、只发请求头）
#[tokio::test]
async fn ac11_stray_request_is_rejected_before_the_body_is_read() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let c = ClaudeHarness::new(None).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(c.h.router.clone().serve(listener));
    for request in [
        format!("POST /v1/messages HTTP/1.1\r\nHost: {address}\r\nContent-Length: 52428800\r\n\r\n"),
        format!("POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nx-api-key: k\r\nContent-Length: 52428800\r\n\r\n"),
    ] {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buffer = vec![0u8; 512];
        let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buffer))
            .await
            .expect("应当立刻拒绝，而不是等请求体")
            .unwrap();
        let text = String::from_utf8_lossy(&buffer[..read]);
        assert!(text.starts_with("HTTP/1.1 404"), "{text}");
    }
    assert!(c.nothing_forwarded());
}

/// AC10：旧 plist（没有 --claude-routing）拉起的新程序：Codex 照旧，Claude 请求 404、什么都不转发
#[tokio::test]
async fn ac10_old_startup_arguments_keep_codex_and_refuse_claude() {
    let c = ClaudeHarness::build(Some(text_stream()), Duration::ZERO, false).await;
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 404, "{}", res.text());
    assert_eq!(anthropic_error(&res).0, "not_found_error");
    assert_eq!(c.h.official_reached() + c.h.third_party.all().len(), 0);
    let res = c
        .send(post(r#"{"model":"gpt-5.6-sol","input":"hi"}"#))
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(c.h.chatgpt.all().len(), 1);
}

/// R9：`/_health` 报出本版路由认得家 claude
#[tokio::test]
async fn health_lists_the_claude_feature() {
    let c = ClaudeHarness::new(None).await;
    let body = json(&c.send(get("/_health")).await.body);
    assert_eq!(body["features"], serde_json::json!(["claude"]));
    assert_eq!(body["service"], HEALTH_SERVICE_NAME);
}

// ---------- 令牌（R12） ----------

/// AC12：Bearer 或 x-api-key 任一个等于令牌即通过；错的、没有的 401，上游 0 次；日志里没有令牌
#[tokio::test]
async fn ac12_token_via_bearer_or_api_key_and_401_otherwise() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    let bearer = c.send(messages_req(MESSAGES)).await;
    assert_eq!(bearer.status, 200, "{}", bearer.text());
    let api_key = c
        .send(with(
            without(messages_req(MESSAGES), "authorization"),
            "x-api-key",
            TOKEN,
        ))
        .await;
    assert_eq!(api_key.status, 200, "{}", api_key.text());
    // 两个都带、只有一个对（P0：Claude Code 可能同时带 AUTH_TOKEN 与 API_KEY）
    let both = c
        .send(with(
            messages_req(MESSAGES),
            "x-api-key",
            "someone-elses-key",
        ))
        .await;
    assert_eq!(both.status, 200);
    assert_eq!(c.h.third_party.all().len(), 3);

    for req in [
        with(
            without(messages_req(MESSAGES), "authorization"),
            "authorization",
            "Bearer sophia-wrong",
        ),
        without(messages_req(MESSAGES), "authorization"),
        with(
            without(messages_req(MESSAGES), "authorization"),
            "authorization",
            TOKEN,
        ),
    ] {
        let res = c.send(req).await;
        assert_eq!(res.status, 401, "{}", res.text());
        assert_eq!(anthropic_error(&res).0, "authentication_error");
        assert_eq!(res.header("x-should-retry"), Some("false"));
    }
    assert_eq!(c.h.third_party.all().len(), 3, "令牌不对不转发");
    let log = c.h.log();
    assert!(log.contains("agent=claude"), "{log}");
    for secret in [TOKEN, "sk-claude-ap-secret", "someone-elses-key"] {
        assert!(!log.contains(secret), "日志里有凭证 {secret}:\n{log}");
    }
    // 出站请求里没有入站的令牌与任何入站凭证
    for req in c.h.third_party.all() {
        assert!(!req.dump().contains(TOKEN), "{}", req.dump());
        assert!(!req.dump().contains("someone-elses-key"));
        assert_eq!(
            req.header("authorization"),
            Some(&*format!("Bearer {}", claude_key(Agent::Claude, "ap")))
        );
    }
}

/// AC13：钥匙串换了新令牌，第一次就认；一串错令牌请求触发的钥匙串读取每秒至多 2 次
#[tokio::test]
async fn ac13_new_token_is_accepted_at_once_and_bad_tokens_do_not_amplify_reads() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    assert_eq!(c.send(messages_req(MESSAGES)).await.status, 200);
    let new_token = "sophia-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    c.tokens.set(new_token);
    let fresh = with(
        without(messages_req(MESSAGES), "authorization"),
        "authorization",
        &format!("Bearer {new_token}"),
    );
    assert_eq!(
        c.send(fresh.clone()).await.status,
        200,
        "缓存着旧令牌也要第一次就认"
    );

    let c = ClaudeHarness::new(None).await;
    let started = Instant::now();
    let wrong = with(
        without(messages_req(MESSAGES), "authorization"),
        "authorization",
        "Bearer sophia-wrong",
    );
    for _ in 0..100 {
        assert_eq!(c.send(wrong.clone()).await.status, 401);
    }
    let seconds = started.elapsed().as_secs_f64().ceil().max(1.0) as usize;
    assert!(
        c.tokens.reads() <= 2 * seconds,
        "100 次错令牌读了 {} 次钥匙串（{seconds} 秒）",
        c.tokens.reads()
    );
}

// ---------- 来源校验与预检（R13） ----------

/// AC14
#[tokio::test]
async fn ac14_app_origin_is_allowed_and_everything_else_is_refused() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    let res = c
        .send(with(
            with(messages_req(MESSAGES), "origin", "app://localhost"),
            "sec-fetch-site",
            "cross-site",
        ))
        .await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        res.header("access-control-allow-origin"),
        Some("app://localhost")
    );
    assert_eq!(res.header("vary"), Some("Origin"));
    // 带这个来源但令牌不对：来源放行之后照样验令牌
    let res = c
        .send(with(
            without(messages_req(MESSAGES), "authorization"),
            "origin",
            "app://localhost",
        ))
        .await;
    assert_eq!(res.status, 401);

    for origin in ["https://evil.com", "null", "app://localhost:1"] {
        let res = c.send(with(messages_req(MESSAGES), "origin", origin)).await;
        assert_eq!(res.status, 403, "{origin}");
    }
    let mut rebound = messages_req(MESSAGES);
    rebound.host = "evil.com".into();
    assert_eq!(c.send(rebound).await.status, 403);
    let mut remote = messages_req(MESSAGES);
    remote.remote = "192.168.1.20:40000".into();
    assert_eq!(c.send(remote).await.status, 403);
    // 不带 Origin 却带跨站的 Sec-Fetch-Site：同 Codex，拒绝
    assert_eq!(
        c.send(with(messages_req(MESSAGES), "sec-fetch-site", "cross-site"))
            .await
            .status,
        403
    );
    // Codex 命名空间不放行这个来源
    let mut codex = post(r#"{"model":"gpt-5.6-sol","input":"hi"}"#);
    codex
        .headers
        .push(("origin".into(), "app://localhost".into()));
    let res = c.send(codex).await;
    assert_eq!(res.status, 403);
    assert!(res.text().contains("local agents"), "{}", res.text());

    // 预检
    let preflight = TestRequest {
        headers: vec![
            ("origin".into(), "app://localhost".into()),
            ("access-control-request-method".into(), "POST".into()),
            (
                "access-control-request-headers".into(),
                "authorization,content-type".into(),
            ),
        ],
        ..claude_req("OPTIONS", "/claude/v1/messages", "")
    };
    let res = c.send(preflight.clone()).await;
    assert_eq!(res.status, 204);
    assert_eq!(
        res.header("access-control-allow-origin"),
        Some("app://localhost")
    );
    assert_eq!(
        res.header("access-control-allow-headers"),
        Some("authorization,content-type")
    );
    assert_eq!(
        res.header("access-control-allow-methods"),
        Some("GET, POST, HEAD, OPTIONS")
    );
    assert_eq!(res.header("access-control-max-age"), Some("600"));
    assert_eq!(res.header("vary"), Some("Origin"));
    let mut evil = preflight;
    evil.headers[0].1 = "https://evil.com".into();
    assert_eq!(c.send(evil).await.status, 403);
    assert_eq!(c.h.third_party.all().len(), 1);
    assert_eq!(c.h.official_reached(), 0);
}

/// AC14：Claude 命名空间的来源校验同样先于读请求体
#[tokio::test]
async fn ac14_claude_origin_is_checked_before_the_body_is_read() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let c = ClaudeHarness::new(None).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(c.h.router.clone().serve(listener));
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(format!("POST /claude/v1/messages HTTP/1.1\r\nHost: {address}\r\nOrigin: https://evil.com\r\nContent-Length: 52428800\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buffer = vec![0u8; 256];
    let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buffer))
        .await
        .expect("应当立刻拒绝")
        .unwrap();
    assert!(String::from_utf8_lossy(&buffer[..read]).starts_with("HTTP/1.1 403"));
}

// ---------- 端点与角色映射（R14–R16） ----------

/// AC15（2026-09-30 起清单是已选逐项的 id → 上游模型）：id 精确匹配（含 `-rN`、结尾 `[1m]`）；不中按关键词回落——
/// haiku 档 → 占 `claude-haiku-4-5` 的那个，opus / sonnet / fable → 第一个；回落的在日志里记下原名；未命中 404
#[tokio::test]
async fn ac15_role_ids_map_to_default_and_background() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    let cases = [
        ("claude-sonnet-5", Some("kimi-k3")),
        ("claude-sonnet-5-r2", Some("qwen-max")),
        ("claude-sonnet-5-r2[1m]", Some("qwen-max")),
        ("claude-opus-5", Some("kimi-k3")),
        ("claude-opus-4-8[1m]", Some("kimi-k3")),
        ("claude-haiku-4-5-20251001", Some("glm-lite")),
        ("claude-fable-5", Some("kimi-k3")),
        ("gpt-4o", None),
    ];
    for (model, upstream) in cases {
        let before = c.h.third_party.all().len();
        let res = c.send(messages_req(&messages_with_model(model))).await;
        match upstream {
            Some(upstream_model) => {
                assert_eq!(res.status, 200, "{model}: {}", res.text());
                let all = c.h.third_party.all();
                assert_eq!(all.len(), before + 1);
                assert_eq!(json(&all[before].body)["model"], upstream_model, "{model}");
                // message_start 里的 model 是请求里的原样
                let events = sse_events(&res.text());
                assert_eq!(events[0].1["message"]["model"], model);
            }
            None => {
                assert_eq!(res.status, 404, "{model}");
                let (kind, message) = anthropic_error(&res);
                assert_eq!(kind, "not_found_error");
                assert!(message.contains("gpt-4o"), "{message}");
                assert_eq!(c.h.third_party.all().len(), before);
            }
        }
    }
    let log = c.h.log();
    assert!(
        log.contains("model=claude-opus-4-8[1m]") && log.contains("fallback=claude-sonnet-5"),
        "{log}"
    );
    assert!(
        log.contains("model=claude-haiku-4-5-20251001")
            && log.contains("fallback=claude-haiku-4-5"),
        "{log}"
    );
    assert_eq!(c.h.official_reached(), 0);
}

/// R14（2026-09-30）：只选了一个模型时清单只有 `claude-sonnet-5` 一项，Haiku 档（起标题、子任务）与 opus 档都回落到它
#[tokio::test]
async fn with_a_single_model_every_tier_falls_back_to_it() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    c.claude_catalog(
        &serde_json::json!({
            "agent": "claude",
            "providers": [{"id": "ap", "name": "AP", "base_url": format!("{}/v1", c.h.third_party.url), "protocol": "chat"}],
            "models": [
                {"slug": "claude-sonnet-5", "upstream_model": "kimi-k3", "provider": "ap", "label": "Kimi K3"}
            ],
            "retired": []
        })
        .to_string(),
    );
    for model in [
        "claude-sonnet-5",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-8[1m]",
        "claude-fable-5",
    ] {
        let before = c.h.third_party.all().len();
        let res = c.send(messages_req(&messages_with_model(model))).await;
        assert_eq!(res.status, 200, "{model}: {}", res.text());
        let all = c.h.third_party.all();
        assert_eq!(all.len(), before + 1, "{model}");
        assert_eq!(json(&all[before].body)["model"], "kimi-k3", "{model}");
    }
    let log = c.h.log();
    assert!(
        log.contains("model=claude-haiku-4-5-20251001") && log.contains("fallback=claude-sonnet-5"),
        "{log}"
    );
    assert_eq!(c.h.official_reached(), 0);
}

/// AC15：清单不存在 / 坏 JSON / 密钥取不到 / 网关不在清单里：404 / 500 / 500 / 500，Anthropic 形状，上游 0 次
#[tokio::test]
async fn ac15_missing_or_broken_catalog_and_missing_keys_fail_closed() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    std::fs::remove_file(c.h.dir.path().join("claude-routing.json")).unwrap();
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 404);
    assert_eq!(anthropic_error(&res).0, "not_found_error");

    c.claude_catalog("{not json");
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 500);
    assert_eq!(anthropic_error(&res).0, "api_error");
    assert_eq!(res.header("x-should-retry"), Some("false"));

    // 清单里有角色、它的网关却不在了
    c.claude_catalog(
        r#"{"providers":[],"models":[{"slug":"claude-sonnet-5","upstream_model":"x","provider":"gone","label":"x"}]}"#,
    );
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 500);
    assert_eq!(res.header("x-should-retry"), Some("false"));
    assert!(anthropic_error(&res).1.contains("重启 Claude"));

    // 地址不安全（http 非回环）
    c.claude_catalog(
        r#"{"providers":[{"id":"ap","base_url":"http://gw.example/v1","protocol":"chat"}],"models":[{"slug":"claude-sonnet-5","upstream_model":"x","provider":"ap","label":"x"}]}"#,
    );
    assert_eq!(c.send(messages_req(MESSAGES)).await.status, 500);
    assert_eq!(c.h.third_party.all().len() + c.h.official_reached(), 0);

    // 服务商密钥取不到
    let mut c = ClaudeHarness::new(Some(text_stream())).await;
    let tokens = c.tokens.clone();
    c.h.router = Router::new(Config {
        third_party_url: String::new(),
        third_party_protocol: Protocol::Chat,
        chatgpt_url: format!("{}/backend-api/codex", c.h.chatgpt.url),
        openai_url: format!("{}/v1", c.h.openai.url),
        routing_catalog_path: c.h.dir.path().join("routing.json"),
        activity_log_path: None,
        third_party_key: Arc::new(|agent, _| match agent {
            Agent::Codex => Ok("codex".into()),
            Agent::Claude => Err("not set".into()),
        }),
        max_body_bytes: 0,
        proxy: None,
        claude_routing_path: Some(c.h.dir.path().join("claude-routing.json")),
        router_token: tokens.source(),
        keepalive: Duration::ZERO,
    })
    .unwrap();
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 500);
    assert_eq!(anthropic_error(&res).0, "api_error");
    assert_eq!(c.h.third_party.all().len() + c.h.official_reached(), 0);

    // 请求体不合法
    let res = c.send(messages_req(r#"{"messages":[]}"#)).await;
    assert_eq!(res.status, 400);
    assert_eq!(anthropic_error(&res).0, "invalid_request_error");
    let res = c.send(messages_req("not json")).await;
    assert_eq!(res.status, 400);
}

/// AC15：带 output_config.format、上游第一次 400（不是上下文超长）→ 去掉 response_format 重发恰一次
#[tokio::test]
async fn ac15_structured_output_is_retried_once_without_response_format() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let c = ClaudeHarness::new(Some(Arc::new(move |req: &Captured| {
        counter.fetch_add(1, AtomicOrdering::SeqCst);
        if json(&req.body).get("response_format").is_some() {
            (
                400,
                vec![("content-type".into(), "application/json".into())],
                br#"{"error":{"message":"response_format is not supported"}}"#.to_vec(),
            )
        } else {
            let respond = text_stream();
            respond(req)
        }
    })))
    .await;
    let body = serde_json::json!({
        "model": "claude-haiku-4-5", "max_tokens": 100, "stream": true,
        "messages": [{"role": "user", "content": "起个标题"}],
        "output_config": {"format": {"type": "json_schema", "schema": {"type": "object"}}}
    })
    .to_string();
    let res = c.send(messages_req(&body)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    let all = c.h.third_party.all();
    assert_eq!(all.len(), 2, "恰好重发一次");
    assert!(json(&all[0].body).get("response_format").is_some());
    assert!(json(&all[1].body).get("response_format").is_none());

    // 不带 format 的请求遇到 400 不重发；两次都 400 时第二次的结果原样回
    let c = ClaudeHarness::new(Some(Arc::new(|_: &Captured| {
        (
            400,
            vec![],
            br#"{"error":{"message":"bad things"}}"#.to_vec(),
        )
    })))
    .await;
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 400);
    assert_eq!(c.h.third_party.all().len(), 1);
    let res = c.send(messages_req(&body)).await;
    assert_eq!(res.status, 400);
    assert_eq!(anthropic_error(&res).0, "invalid_request_error");
    assert_eq!(c.h.third_party.all().len(), 3);
    let _ = calls;
}

// ---------- 推理强度 → reasoning_effort（重试） ----------

const EFFORT_REJECTED: &[u8] =
    br#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#;

/// 要了思考的请求：`output_config.effort` 折成 `reasoning_effort` 发给 Chat 上游
fn thinking_messages(effort: &str) -> String {
    serde_json::json!({
        "model": "claude-sonnet-5", "max_tokens": 100, "stream": true,
        "thinking": {"type": "adaptive"}, "output_config": {"effort": effort},
        "messages": [{"role": "user", "content": "hi"}]
    })
    .to_string()
}

/// 上游第一次因 reasoning_effort 回 400 → 去掉它恰好重发一次，第二次请求体里没有该字段
#[tokio::test]
async fn reasoning_effort_is_forwarded_and_dropped_once_when_rejected() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    let res = c.send(messages_req(&thinking_messages("xhigh"))).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        json(&c.h.third_party.only().body)["reasoning_effort"],
        "high"
    );

    let c = ClaudeHarness::new(Some(Arc::new(|req: &Captured| {
        if json(&req.body).get("reasoning_effort").is_some() {
            (400, vec![], EFFORT_REJECTED.to_vec())
        } else {
            let respond = text_stream();
            respond(req)
        }
    })))
    .await;
    let res = c.send(messages_req(&thinking_messages("medium"))).await;
    assert_eq!(res.status, 200, "{}", res.text());
    let all = c.h.third_party.all();
    assert_eq!(all.len(), 2, "恰好重发一次");
    assert_eq!(json(&all[0].body)["reasoning_effort"], "medium");
    assert!(json(&all[1].body).get("reasoning_effort").is_none());
    // 除了 reasoning_effort，两次请求体一样
    let mut first = json(&all[0].body);
    first.as_object_mut().unwrap().remove("reasoning_effort");
    assert_eq!(first, json(&all[1].body));
}

/// 去掉后仍 400：不再重发，第二次的错误按 R27 回；没发 reasoning_effort 时 400 也不因它重发
#[tokio::test]
async fn reasoning_effort_retry_happens_at_most_once() {
    let c = ClaudeHarness::new(Some(upstream_error(400, vec![], EFFORT_REJECTED.to_vec()))).await;
    let res = c.send(messages_req(&thinking_messages("high"))).await;
    assert_eq!(res.status, 400);
    assert_eq!(anthropic_error(&res).0, "invalid_request_error");
    assert_eq!(c.h.third_party.all().len(), 2);
    // 没要思考 → 没发 reasoning_effort → 不重发
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 400);
    assert_eq!(c.h.third_party.all().len(), 3);
}

/// 发了 reasoning_effort，但 400 与它无关 → 不因 effort 重发
#[tokio::test]
async fn unrelated_400_does_not_drop_reasoning_effort() {
    let c = ClaudeHarness::new(Some(upstream_error(
        400,
        vec![],
        br#"{"error":{"message":"messages: too many images"}}"#.to_vec(),
    )))
    .await;
    let res = c.send(messages_req(&thinking_messages("high"))).await;
    assert_eq!(res.status, 400);
    let all = c.h.third_party.all();
    assert_eq!(all.len(), 1, "不重发");
    assert_eq!(json(&all[0].body)["reasoning_effort"], "high");
}

/// 带 format 又带 effort：先去掉 effort（保留 response_format）重发；仍 400 再走 format 那一次
#[tokio::test]
async fn effort_retry_comes_first_then_structured_output_retry() {
    let c = ClaudeHarness::new(Some(Arc::new(|req: &Captured| {
        let body = json(&req.body);
        if body.get("reasoning_effort").is_some() {
            (400, vec![], EFFORT_REJECTED.to_vec())
        } else if body.get("response_format").is_some() {
            (
                400,
                vec![],
                br#"{"error":{"message":"response_format is not supported"}}"#.to_vec(),
            )
        } else {
            let respond = text_stream();
            respond(req)
        }
    })))
    .await;
    let body = serde_json::json!({
        "model": "claude-haiku-4-5", "max_tokens": 100, "stream": true,
        "thinking": {"type": "enabled", "budget_tokens": 2000},
        "messages": [{"role": "user", "content": "起个标题"}],
        "output_config": {"format": {"type": "json_schema", "schema": {"type": "object"}}}
    })
    .to_string();
    let res = c.send(messages_req(&body)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    let all: Vec<serde_json::Value> =
        c.h.third_party
            .all()
            .iter()
            .map(|r| json(&r.body))
            .collect();
    assert_eq!(all.len(), 3, "effort 一次、format 一次");
    assert_eq!(all[0]["reasoning_effort"], "low");
    assert!(all[0].get("response_format").is_some());
    assert!(all[1].get("reasoning_effort").is_none());
    assert!(
        all[1].get("response_format").is_some(),
        "去 effort 时保留 format"
    );
    assert!(all[2].get("reasoning_effort").is_none());
    assert!(all[2].get("response_format").is_none());

    // 都一直 400：每种各至多一次，共 3 次
    let c = ClaudeHarness::new(Some(upstream_error(400, vec![], EFFORT_REJECTED.to_vec()))).await;
    let res = c.send(messages_req(&body)).await;
    assert_eq!(res.status, 400);
    assert_eq!(c.h.third_party.all().len(), 3);
}

/// AC16（路由部分）：count_tokens 本地估算，上游 0 次；模型未命中 404
#[tokio::test]
async fn count_tokens_is_local_and_needs_a_known_model() {
    let c = ClaudeHarness::new(None).await;
    let doc: serde_json::Value =
        serde_json::from_slice(&data("cc-count-tokens-system-section.json")).unwrap();
    // 抓包里的模型名是当时 P0 配的名字；桌面应用发的是角色 id
    let mut body = doc["body"].clone();
    body["model"] = serde_json::json!("claude-sonnet-5");
    let body = body.to_string();
    let res = c
        .send(claude_req(
            "POST",
            "/claude/v1/messages/count_tokens?beta=true",
            &body,
        ))
        .await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(json(&res.body), serde_json::json!({"input_tokens": 110}));
    let res = c
        .send(claude_req(
            "POST",
            "/claude/v1/messages/count_tokens",
            &messages_with_model("gpt-4o"),
        ))
        .await;
    assert_eq!(res.status, 404);
    assert!(c.nothing_forwarded());
}

/// AC17：`/api/hello` 不要令牌；`/v1/models` 按清单顺序、要令牌；其它路径 404
#[tokio::test]
async fn ac17_hello_models_and_unknown_paths() {
    let c = ClaudeHarness::new(None).await;
    let head = c
        .send(without(
            claude_req("HEAD", "/claude/api/hello", ""),
            "authorization",
        ))
        .await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    let get_hello = c
        .send(without(
            claude_req("GET", "/claude/api/hello", ""),
            "authorization",
        ))
        .await;
    assert_eq!(get_hello.status, 200);
    assert_eq!(json(&get_hello.body), serde_json::json!({}));

    let res = c.send(claude_req("GET", "/claude/v1/models", "")).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        json(&res.body),
        serde_json::json!({
            "data": [
                {"type": "model", "id": "claude-sonnet-5", "display_name": "Kimi K3", "created_at": "1970-01-01T00:00:00Z"},
                {"type": "model", "id": "claude-sonnet-5-r2", "display_name": "Qwen Max", "created_at": "1970-01-01T00:00:00Z"},
                {"type": "model", "id": "claude-haiku-4-5", "display_name": "GLM Lite", "created_at": "1970-01-01T00:00:00Z"}
            ],
            "has_more": false, "first_id": "claude-sonnet-5", "last_id": "claude-haiku-4-5"
        })
    );
    let res = c
        .send(without(
            claude_req("GET", "/claude/v1/models", ""),
            "authorization",
        ))
        .await;
    assert_eq!(res.status, 401);
    for (method, path) in [
        ("GET", "/claude/v1/foo"),
        ("GET", "/claude/v1/messages"),
        ("POST", "/claude"),
        ("GET", "/claude/"),
    ] {
        let res = c.send(claude_req(method, path, "")).await;
        assert_eq!(res.status, 404, "{method} {path}");
        assert_eq!(anthropic_error(&res).0, "not_found_error");
    }
    assert!(c.nothing_forwarded());
}

/// AC19（路由部分）：出站请求头只有 R18 列的四个（外加 HTTP 本身的 host / content-length）；
/// 入站的 anthropic-*、x-app、x-claude-code-*、origin 一概不转发
#[tokio::test]
async fn ac19_outbound_headers_are_only_ours() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    let res = c
        .send(with(messages_req(MESSAGES), "origin", "app://localhost"))
        .await;
    assert_eq!(res.status, 200);
    let got = c.h.third_party.only();
    let mut names: Vec<String> = got.headers.iter().map(|(k, _)| k.to_lowercase()).collect();
    names.sort();
    names.dedup();
    for name in &names {
        assert!(
            [
                "content-type",
                "accept",
                "authorization",
                "user-agent",
                "content-length",
                "host"
            ]
            .contains(&name.as_str()),
            "多转发了 {name}:\n{}",
            got.dump()
        );
    }
    assert_eq!(got.header("accept"), Some("text/event-stream"));
    assert_eq!(got.header("content-type"), Some("application/json"));
    assert!(got
        .header("user-agent")
        .is_some_and(|ua| ua.starts_with("Sophia-gateway/")));
    let sent = json(&got.body);
    assert_eq!(sent["stream"], true);
    assert_eq!(sent["stream_options"]["include_usage"], true);
}

// ---------- 流式（R22–R26） ----------

/// 手写的上游：发完响应头后按给定的间隔一段一段地写（chunked），记下每段写出的时刻
async fn paced_upstream(parts: Vec<(Duration, String)>) -> (String, Arc<Mutex<Vec<Instant>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let written: Arc<Mutex<Vec<Instant>>> = Arc::default();
    let marks = written.clone();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 65536];
        let _ = stream.read(&mut buf).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        for (pause, text) in parts {
            tokio::time::sleep(pause).await;
            if text == "<drop>" {
                return; // 断流：连接直接关掉，没有收尾的 0 长度块
            }
            let chunk = format!("{:x}\r\n{text}\r\n", text.len());
            stream.write_all(chunk.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
            marks.lock().unwrap().push(Instant::now());
        }
        let _ = stream.write_all(b"0\r\n\r\n").await;
    });
    (url, written)
}

async fn paced_harness(
    parts: Vec<(Duration, String)>,
) -> (ClaudeHarness, Arc<Mutex<Vec<Instant>>>) {
    let (url, marks) = paced_upstream(parts).await;
    let c = ClaudeHarness::new(None).await;
    c.claude_catalog(&claude_catalog(&url));
    (c, marks)
}

fn chunk(delta: &str, finish: Option<&str>) -> String {
    let finish = finish.map_or("null".to_owned(), |f| format!("\"{f}\""));
    format!(
        "data: {{\"choices\":[{{\"index\":0,\"delta\":{delta},\"finish_reason\":{finish}}}]}}\n\n"
    )
}

/// 读响应体，每收到一帧记下时刻与内容
async fn frames(response: Response<Body>) -> Vec<(Instant, String)> {
    let mut body = response.into_body();
    let mut out = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { break };
        if let Ok(data) = frame.into_data() {
            out.push((Instant::now(), String::from_utf8_lossy(&data).into_owned()));
        }
    }
    out
}

async fn raw_send(c: &ClaudeHarness, req: TestRequest) -> Response<Body> {
    let mut builder = hyper::Request::builder()
        .method(req.method.as_str())
        .uri(req.path.as_str())
        .header("host", req.host.as_str());
    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let request = builder.body(Bytes::from(req.body.clone())).unwrap();
    c.h.router
        .clone()
        .handle(request, req.remote.parse().unwrap())
        .await
}

/// AC23：上游来一段转一段，客户端收到第一段文字比上游发出晚 < 50ms；message_start 在上游第一段之前就写出
#[tokio::test]
async fn ac23_text_is_forwarded_as_it_arrives() {
    let (c, marks) = paced_harness(vec![
        (
            Duration::ZERO,
            chunk(r#"{"role":"assistant","content":"一"}"#, None),
        ),
        (
            Duration::from_millis(200),
            chunk(r#"{"content":"二"}"#, None),
        ),
        (
            Duration::from_millis(200),
            chunk(r#"{"content":"三"}"#, Some("stop")),
        ),
        (Duration::ZERO, "data: [DONE]\n\n".to_owned()),
    ])
    .await;
    let received = frames(raw_send(&c, messages_req(MESSAGES)).await).await;
    let text: String = received.iter().map(|(_, t)| t.as_str()).collect();
    assert_eq!(
        event_names(&text)
            .into_iter()
            .filter(|n| n != "ping")
            .collect::<Vec<_>>(),
        [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]
    );
    let marks = marks.lock().unwrap().clone();
    for (index, needle) in ["二", "三"].iter().enumerate() {
        let (at, _) = received
            .iter()
            .find(|(_, t)| t.contains(needle))
            .expect("收到了这一段");
        let sent = marks[index + 1];
        assert!(
            at.saturating_duration_since(sent) < Duration::from_millis(50),
            "第 {} 段晚了 {:?}",
            index + 2,
            at.saturating_duration_since(sent)
        );
    }
}

/// AC25：上游 200 后静默 3 个保活间隔 → 客户端收到 ≥ 2 个 ping，之后正常收尾；只吐推理内容时同样有 ping
#[tokio::test]
async fn ac25_ping_is_sent_while_the_upstream_is_silent() {
    let (c, _) = paced_harness(vec![
        (
            Duration::ZERO,
            chunk(r#"{"role":"assistant","content":""}"#, None),
        ),
        (
            Duration::from_millis(350),
            chunk(r#"{"content":"好"}"#, Some("stop")),
        ),
        (Duration::ZERO, "data: [DONE]\n\n".to_owned()),
    ])
    .await;
    let text: String = frames(raw_send(&c, messages_req(MESSAGES)).await)
        .await
        .into_iter()
        .map(|(_, t)| t)
        .collect();
    let names = event_names(&text);
    assert!(
        names.iter().filter(|n| *n == "ping").count() >= 2,
        "{names:?}"
    );
    assert_eq!(names.last().map(String::as_str), Some("message_stop"));
    let ping = sse_events(&text)
        .into_iter()
        .find(|(n, _)| n == "ping")
        .unwrap();
    assert_eq!(ping.1, serde_json::json!({"type": "ping"}));

    let mut reasoning = vec![(Duration::ZERO, chunk(r#"{"role":"assistant"}"#, None))];
    for _ in 0..8 {
        reasoning.push((
            Duration::from_millis(50),
            chunk(r#"{"reasoning_content":"想"}"#, None),
        ));
    }
    reasoning.push((Duration::ZERO, chunk(r#"{"content":"答"}"#, Some("stop"))));
    reasoning.push((Duration::ZERO, "data: [DONE]\n\n".to_owned()));
    let (c, _) = paced_harness(reasoning).await;
    let text: String = frames(raw_send(&c, messages_req(MESSAGES)).await)
        .await
        .into_iter()
        .map(|(_, t)| t)
        .collect();
    let names = event_names(&text);
    assert!(
        names.iter().filter(|n| *n == "ping").count() >= 2,
        "{names:?}"
    );
    assert!(!text.contains("thinking"), "推理内容不回");
    assert!(!text.contains("想"));
}

/// AC28：流已开始后断流 → 最后一个事件是 error，没有 message_stop
#[tokio::test]
async fn ac28_broken_stream_ends_with_error_and_no_message_stop() {
    let (c, _) = paced_harness(vec![
        (
            Duration::ZERO,
            chunk(r#"{"role":"assistant","content":"半"}"#, None),
        ),
        (Duration::from_millis(20), "<drop>".to_owned()),
    ])
    .await;
    let text: String = frames(raw_send(&c, messages_req(MESSAGES)).await)
        .await
        .into_iter()
        .map(|(_, t)| t)
        .collect();
    let names = event_names(&text);
    assert_eq!(names.last().map(String::as_str), Some("error"), "{names:?}");
    assert!(!names.contains(&"message_stop".to_owned()));
    assert!(!names.contains(&"message_delta".to_owned()));
}

/// AC22（路由部分）：真实上游样本回放，事件序列与黄金序列逐条相同（message_start 的估算与模型名除外）
#[tokio::test]
async fn ac22_real_upstream_sample_replays_to_the_golden_sequence() {
    let upstream = data("upstream-ap-gateway-kimi-k2.5-tool-stream.sse");
    let c = ClaudeHarness::new(Some(Arc::new(move |_: &Captured| {
        (
            200,
            vec![("content-type".into(), "text/event-stream".into())],
            upstream.clone(),
        )
    })))
    .await;
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("text/event-stream"));
    assert_eq!(res.header("cache-control"), Some("no-cache"));
    let got: Vec<serde_json::Value> = sse_events(&res.text())
        .into_iter()
        .filter(|(n, _)| n != "ping")
        .map(|(n, d)| serde_json::json!({"event": n, "data": d}))
        .collect();
    let golden: Vec<serde_json::Value> = String::from_utf8(data(
        "golden/upstream-ap-gateway-kimi-k2.5-tool-stream.anthropic.jsonl",
    ))
    .unwrap()
    .lines()
    .filter(|l| !l.trim().is_empty())
    .map(|l| serde_json::from_str(l).unwrap())
    .collect();
    assert_eq!(got.len(), golden.len());
    assert_eq!(got[1..], golden[1..]);
    assert_eq!(got[0]["event"], "message_start");
}

/// AC27：stream:false → 一条完整 Message JSON，内容与同一上游流式时拼起来的相同
#[tokio::test]
async fn ac27_non_streaming_request_gets_one_message() {
    let c = ClaudeHarness::new(Some(chat_sse(&[
        r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":"先看看"},"finish_reason":null}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\"path\":"}}]},"finish_reason":null}]}"#,
        r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1000,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":600}}}"#,
    ])))
    .await;
    let body = MESSAGES.replace("\"stream\":true", "\"stream\":false");
    let res = c.send(messages_req(&body)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(res.header("content-type"), Some("application/json"));
    let message = json(&res.body);
    assert_eq!(message["type"], "message");
    assert_eq!(message["model"], "claude-sonnet-5");
    assert_eq!(message["stop_reason"], "tool_use");
    assert_eq!(
        message["content"],
        serde_json::json!([
            {"type": "text", "text": "先看看"},
            {"type": "tool_use", "id": "call_1", "name": "Read", "input": {"path": "a.txt"}}
        ])
    );
    assert_eq!(message["usage"]["input_tokens"], 400);
    assert_eq!(message["usage"]["cache_read_input_tokens"], 600);
    // 上游仍按流式要
    assert_eq!(json(&c.h.third_party.only().body)["stream"], true);

    // 同一上游流式：拼起来相同
    let streamed = c.send(messages_req(MESSAGES)).await;
    let mut text = String::new();
    let mut args = String::new();
    for (name, data) in sse_events(&streamed.text()) {
        if name == "content_block_delta" {
            text.push_str(data["delta"]["text"].as_str().unwrap_or(""));
            args.push_str(data["delta"]["partial_json"].as_str().unwrap_or(""));
        }
    }
    assert_eq!(text, "先看看");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&args).unwrap(),
        serde_json::json!({"path": "a.txt"})
    );
}

// ---------- 错误映射（R27） ----------

fn upstream_error(status: u16, headers: Vec<(&str, &str)>, body: Vec<u8>) -> Responder {
    let headers: Vec<(String, String)> = headers
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    Arc::new(move |_: &Captured| (status, headers.clone(), body.clone()))
}

/// AC28（路由部分）：R27 表逐行，经真实 HTTP 回给客户端
#[tokio::test]
async fn ac28_upstream_errors_are_mapped_to_anthropic_shape() {
    let key = claude_key(Agent::Claude, "ap");
    let overflow = data("upstream-ap-gateway-kimi-k2.5-context-overflow.json");
    let openrouter_overflow = data("upstream-openrouter-lfm-2.5-context-overflow.json");
    let cases: Vec<(Responder, u16, &str, Option<&str>)> = vec![
        (
            upstream_error(400, vec![], overflow),
            400,
            "invalid_request_error",
            None,
        ),
        (
            upstream_error(400, vec![], openrouter_overflow),
            400,
            "invalid_request_error",
            None,
        ),
        (
            upstream_error(
                422,
                vec![],
                br#"{"error":{"message":"bad field"}}"#.to_vec(),
            ),
            400,
            "invalid_request_error",
            None,
        ),
        (
            upstream_error(
                401,
                vec![],
                format!(r#"{{"error":{{"message":"invalid key {key}"}}}}"#).into_bytes(),
            ),
            403,
            "permission_error",
            None,
        ),
        (
            upstream_error(
                404,
                vec![],
                br#"{"error":{"message":"no such model"}}"#.to_vec(),
            ),
            404,
            "not_found_error",
            None,
        ),
        (
            upstream_error(413, vec![], b"too big".to_vec()),
            413,
            "request_too_large",
            None,
        ),
        (
            upstream_error(
                429,
                vec![("retry-after-ms", "1500")],
                br#"{"error":{"message":"slow down"}}"#.to_vec(),
            ),
            429,
            "rate_limit_error",
            Some("2"),
        ),
        (
            upstream_error(503, vec![], b"busy".to_vec()),
            529,
            "overloaded_error",
            None,
        ),
        (
            upstream_error(500, vec![], b"oops".to_vec()),
            500,
            "api_error",
            None,
        ),
    ];
    for (index, (responder, status, kind, retry_after)) in cases.into_iter().enumerate() {
        let c = ClaudeHarness::new(Some(responder)).await;
        let res = c.send(messages_req(MESSAGES)).await;
        assert_eq!(res.status, status, "第 {index} 例: {}", res.text());
        let (got_kind, message) = anthropic_error(&res);
        assert_eq!(got_kind, kind, "第 {index} 例");
        assert!(
            !res.text().contains(&key),
            "错误体里的密钥要打码: {}",
            res.text()
        );
        if index < 2 {
            assert!(message.starts_with("prompt is too long"), "{message}");
        }
        if status == 403 {
            assert!(
                message.starts_with("AP 拒绝了 Sophia 保存的密钥"),
                "{message}"
            );
            assert!(message.contains("***"));
            assert_eq!(res.header("x-should-retry"), Some("false"));
        }
        assert_eq!(res.header("retry-after"), retry_after, "第 {index} 例");
        // 日志行带上游原话（抹掉密钥）：桌面应用只报「模型不可用」，查原因靠这一句
        let log = std::fs::read_to_string(c.h.dir.path().join("router.log")).unwrap_or_default();
        let line = log.lines().last().unwrap_or_default();
        assert!(
            line.contains("result=upstream_error reason="),
            "第 {index} 例: {line}"
        );
        assert!(!line.contains(&key), "日志里的密钥要打码: {line}");
        if status == 404 {
            assert!(line.contains("no_such_model"), "{line}");
        }
    }

    // 连不上上游 → 502 api_error
    let c = ClaudeHarness::new(None).await;
    c.h.third_party.stop();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 502);
    assert_eq!(anthropic_error(&res).0, "api_error");
}

// ---------- 两家各用各的（R2） ----------

/// AC2（路由部分）：两家各有 id 为 wecode 的网关、地址与密钥不同，各打到自己的地址、带自己的密钥
#[tokio::test]
async fn ac2_same_gateway_id_in_both_families_stays_separate() {
    let codex_upstream = FakeUpstream::start(Some(sse_ok())).await;
    let c = ClaudeHarness::new(Some(text_stream())).await;
    c.h.catalog(&format!(
        r#"{{"providers":[{{"id":"wecode","base_url":"{}/codex","protocol":"responses"}}],"models":[{{"slug":"wecode-glm","upstream_model":"glm","provider":"wecode"}}]}}"#,
        codex_upstream.url
    ));
    c.claude_catalog(&claude_catalog(&c.h.third_party.url).replace("\"ap\"", "\"wecode\""));
    let res = c
        .send(post(r#"{"model":"wecode-glm","stream":true,"input":"hi"}"#))
        .await;
    assert_eq!(res.status, 200, "{}", res.text());
    let res = c.send(messages_req(MESSAGES)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    let codex = codex_upstream.only();
    assert_eq!(codex.path, "/codex/responses");
    assert_eq!(
        codex.header("authorization"),
        Some(&*format!("Bearer {}", claude_key(Agent::Codex, "wecode")))
    );
    let claude = c.h.third_party.only();
    assert_eq!(claude.path, "/v1/chat/completions");
    assert_eq!(
        claude.header("authorization"),
        Some(&*format!("Bearer {}", claude_key(Agent::Claude, "wecode")))
    );
    assert_eq!(c.h.official_reached(), 0);
}

/// `/_status` 带 claude_requests；Claude 的请求在日志里是 agent=claude route=claude
#[tokio::test]
async fn status_and_log_count_claude_requests() {
    let c = ClaudeHarness::new(Some(text_stream())).await;
    assert_eq!(c.send(messages_req(MESSAGES)).await.status, 200);
    let status = json(&c.send(get("/_status")).await.body);
    assert_eq!(status["claude_requests"], 1);
    let log = c.h.log();
    assert!(log.contains("agent=claude route=claude"), "{log}");
    assert!(log.contains("path=/claude/v1/messages"), "{log}");
}

/// R10 / R16：没有清单（Claude 没打开，或旧 plist）时 `/v1/models` 也是 404
#[tokio::test]
async fn models_without_a_catalog_is_404() {
    let c = ClaudeHarness::build(None, Duration::ZERO, false).await;
    let res = c.send(claude_req("GET", "/claude/v1/models", "")).await;
    assert_eq!(res.status, 404);
    let c = ClaudeHarness::new(None).await;
    std::fs::remove_file(c.h.dir.path().join("claude-routing.json")).unwrap();
    let res = c.send(claude_req("GET", "/claude/v1/models", "")).await;
    assert_eq!(res.status, 404);
    assert_eq!(anthropic_error(&res).0, "not_found_error");
}

/// R12：钥匙串里还没有令牌（只用 Codex）时，带凭证的请求不会每个都去读钥匙串
#[tokio::test]
async fn missing_token_is_cached_too() {
    let c = ClaudeHarness::new(None).await;
    *c.tokens.value.lock().unwrap() = None;
    let started = Instant::now();
    for _ in 0..100 {
        assert_eq!(c.send(messages_req(MESSAGES)).await.status, 401);
    }
    let seconds = started.elapsed().as_secs_f64().ceil().max(1.0) as usize;
    assert!(
        c.tokens.reads() <= 2 * seconds,
        "读了 {} 次",
        c.tokens.reads()
    );
    // 之后生成了令牌：第一次就认
    c.tokens.set(TOKEN);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let res = c.send(messages_req(MESSAGES)).await;
    assert_ne!(res.status, 401, "{}", res.text());
}

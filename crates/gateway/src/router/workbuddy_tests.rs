//! 家 workbuddy 的路由测试（#266）：WorkBuddy 讲 OpenAI Chat，上游讲 Chat，原样转发——只换鉴权、模型名与地址。
//! 路由在本机回环上起真实 HTTP，上游是本地假服务
use super::*;

const TOKEN: &str = "sophia-WORKBUDDY-TOKEN";
const BODY: &str = r#"{"model":"kimi-kimi-k2.6","stream":true,"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"read","parameters":{}}}],"reasoning_effort":"high"}"#;

struct WorkBuddyHarness {
    h: Harness,
}

fn routing(upstream: &str) -> String {
    serde_json::json!({
        "providers": [
            {"id": "kimi", "base_url": format!("{upstream}/v1"), "protocol": "chat"},
            {"id": "relay", "base_url": format!("{upstream}/relay"), "protocol": "responses"}
        ],
        "models": [
            {"slug": "kimi-kimi-k2.6", "upstream_model": "kimi-k2.6", "provider": "kimi"},
            {"slug": "relay-r1", "upstream_model": "r1", "provider": "relay"},
            {"slug": "k2 · kimi", "upstream_model": "k2", "provider": "kimi"},
            {"slug": "k2 · relay", "upstream_model": "k2", "provider": "relay"}
        ],
        "retired": []
    })
    .to_string()
}

impl WorkBuddyHarness {
    async fn new(third_party: Option<Responder>) -> Self {
        let mut h = Harness::new(third_party).await;
        let path = h.dir.path().join("workbuddy-routing.json");
        std::fs::write(&path, routing(&h.third_party.url)).unwrap();
        h.router = Router::new(Config {
            third_party_url: String::new(),
            third_party_protocol: Protocol::Chat,
            chatgpt_url: format!("{}/backend-api/codex", h.chatgpt.url),
            openai_url: format!("{}/v1", h.openai.url),
            routing_catalog_path: h.dir.path().join("routing.json"),
            activity_log_path: Some(h.dir.path().join("router.log")),
            third_party_key: Arc::new(|agent, id| Ok(format!("sk-{}-{id}", agent.as_str()))),
            max_body_bytes: 0,
            proxy: None,
            claude_routing_path: None,
            workbuddy_routing_path: Some(path),
            router_token: Arc::new(|| Ok(TOKEN.to_owned())),
            keepalive: Duration::ZERO,
            locale: None,
            key_verdicts: None,
        })
        .unwrap();
        Self { h }
    }
}

fn wb_req(body: &str) -> TestRequest {
    TestRequest {
        method: "POST".into(),
        path: "/workbuddy/v1/chat/completions".into(),
        host: "127.0.0.1:47328".into(),
        remote: "127.0.0.1:50000".into(),
        headers: vec![
            ("authorization".into(), format!("Bearer {TOKEN}")),
            ("content-type".into(), "application/json".into()),
            ("accept".into(), "text/event-stream".into()),
            ("user-agent".into(), "WorkBuddy/5.3.5".into()),
        ],
        body: body.as_bytes().to_vec(),
    }
}

fn sse() -> Responder {
    Arc::new(|_| {
        (
            200,
            vec![("content-type".into(), "text/event-stream".into())],
            b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n".to_vec(),
        )
    })
}

/// Chat 原样转发：路径换成上游的 `/chat/completions`，模型名换成上游的，鉴权换成提供商的密钥；
/// 其余字段（工具、思考强度、流式）一个字不动，回复原样流回
#[tokio::test]
async fn chat_requests_are_forwarded_as_they_are() {
    let w = WorkBuddyHarness::new(Some(sse())).await;
    let res = w.h.send(wb_req(BODY)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        res.text(),
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
    );
    let sent = w.h.third_party.only();
    assert_eq!(sent.path, "/v1/chat/completions");
    assert_eq!(
        sent.header("authorization"),
        Some("Bearer sk-workbuddy-kimi")
    );
    let mut expected = json(BODY.as_bytes());
    expected["model"] = "kimi-k2.6".into();
    assert_eq!(json(&sent.body), expected);
    assert!(!sent.dump().contains(TOKEN), "令牌不出本机");
    assert_eq!(w.h.official_reached(), 0);
    assert!(w.h.log().contains("agent=workbuddy"));
}

/// 讲 Responses 的提供商同时有 Chat 接口：WorkBuddy 的请求照样转到它的 `/chat/completions`
#[tokio::test]
async fn responses_providers_are_reached_through_their_chat_endpoint() {
    let w = WorkBuddyHarness::new(Some(sse())).await;
    let res =
        w.h.send(wb_req(&BODY.replace("kimi-kimi-k2.6", "relay-r1")))
            .await;
    assert_eq!(res.status, 200, "{}", res.text());
    let sent = w.h.third_party.only();
    assert_eq!(sent.path, "/relay/chat/completions");
    assert_eq!(json(&sent.body)["model"], "r1");
    assert_eq!(
        sent.header("authorization"),
        Some("Bearer sk-workbuddy-relay")
    );
}

/// 条目的 id 就是显示名（走查第 9 条）：带空格与「·」的照原样认，撞名的两家各去各的
#[tokio::test]
async fn shown_name_ids_route_to_their_own_provider() {
    let w = WorkBuddyHarness::new(Some(sse())).await;
    let res =
        w.h.send(wb_req(
            &BODY.replace("kimi-kimi-k2.6", "custom-local:K2 · Relay"),
        ))
        .await;
    assert_eq!(res.status, 200, "{}", res.text());
    let sent = w.h.third_party.only();
    assert_eq!(sent.path, "/relay/chat/completions");
    assert_eq!(json(&sent.body)["model"], "k2");
}

/// WorkBuddy 内部给自定义模型的 id 加 `custom-local:` 前缀；带着它来的也认
#[tokio::test]
async fn the_custom_local_prefix_is_ignored() {
    let w = WorkBuddyHarness::new(Some(sse())).await;
    let body = BODY.replace("kimi-kimi-k2.6", "custom-local:kimi-kimi-k2.6");
    let res = w.h.send(wb_req(&body)).await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(json(&w.h.third_party.only().body)["model"], "kimi-k2.6");
}

/// 没带令牌、令牌不对、没选的模型、别的路径：都在本机拒绝，什么都不转发（更不转给官方）
#[tokio::test]
async fn requests_that_cannot_be_served_never_leave_the_machine() {
    let w = WorkBuddyHarness::new(Some(sse())).await;
    let mut no_token = wb_req(BODY);
    no_token.headers.retain(|(k, _)| k != "authorization");
    assert_eq!(w.h.send(no_token).await.status, 401);
    let mut wrong = wb_req(BODY);
    wrong.headers[0].1 = "Bearer nope".into();
    assert_eq!(w.h.send(wrong).await.status, 401);
    let unknown =
        w.h.send(wb_req(&BODY.replace("kimi-kimi-k2.6", "gpt-6")))
            .await;
    assert_eq!(unknown.status, 404, "{}", unknown.text());
    let mut other_path = wb_req(BODY);
    other_path.path = "/workbuddy/v1/responses".into();
    assert_eq!(w.h.send(other_path).await.status, 404);
    // 浏览器里的网页也够不着
    let mut browser = wb_req(BODY);
    browser
        .headers
        .push(("origin".into(), "https://evil.example".into()));
    assert_eq!(w.h.send(browser).await.status, 403);
    assert!(w.h.third_party.all().is_empty());
    assert_eq!(w.h.official_reached(), 0);
}

/// 提供商拒了密钥：回 403 并点名，密钥打码
#[tokio::test]
async fn a_rejected_key_is_named_and_masked() {
    let w = WorkBuddyHarness::new(Some(Arc::new(|captured: &Captured| {
        let key = captured.header("authorization").unwrap_or("").to_owned();
        (
            401,
            vec![("content-type".into(), "application/json".into())],
            format!("{{\"error\":{{\"message\":\"bad key {key}\"}}}}").into_bytes(),
        )
    })))
    .await;
    let res = w.h.send(wb_req(BODY)).await;
    assert_eq!(res.status, 403);
    assert!(res.text().contains("kimi"), "{}", res.text());
    assert!(!res.text().contains("sk-workbuddy-kimi"), "{}", res.text());
}

/// WorkBuddy 关着（清单不在）：说清楚，不转发
#[tokio::test]
async fn without_a_routing_list_the_namespace_is_off() {
    let w = WorkBuddyHarness::new(Some(sse())).await;
    std::fs::remove_file(w.h.dir.path().join("workbuddy-routing.json")).unwrap();
    let res = w.h.send(wb_req(BODY)).await;
    assert_eq!(res.status, 404, "{}", res.text());
    assert!(w.h.third_party.all().is_empty());
}

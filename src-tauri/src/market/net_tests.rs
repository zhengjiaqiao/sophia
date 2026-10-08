//! 联网失败的分类、句子与详情（spec 2026-10-04-local-diagnostics R10 / AC9）。
//! 假服务都是本机 127.0.0.1 上手写 HTTP 响应的线程；client 一律 `no_proxy`，系统代理不影响结果。
use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

/// 带 `no_proxy` client 的状态（预先填好 `client`，不走 `MarketState::client` 的建法）
fn test_state() -> MarketState {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("测试 client");
    MarketState {
        client: OnceLock::from(Ok(client)),
        ..Default::default()
    }
}

/// 收一次请求，交给 `respond` 写回去；返回基础地址
fn serve_once(respond: impl FnOnce(&mut TcpStream) + Send + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        respond(&mut stream);
    });
    base
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn failure_of<T: std::fmt::Debug>(result: Result<T, NetFailure>) -> NetFailure {
    result.expect_err("应当失败")
}

#[test]
fn classify_reads_the_wait_from_retry_after_or_reset() {
    let limited = |wait_secs, reset| Err(NetError::RateLimited { reset, wait_secs });
    assert_eq!(
        classify(429, None, Some("60"), None, None, 1000),
        limited(Some(60), None)
    );
    // retry-after-ms 更精确，优先
    assert_eq!(
        classify(429, None, Some("60"), Some("1500"), None, 1000),
        limited(Some(2), None)
    );
    // 没有 retry-after：用限流头的恢复时刻减去此刻
    assert_eq!(
        classify(403, Some("0"), None, None, Some(1090), 1000),
        limited(Some(90), Some(1090))
    );
    assert_eq!(
        classify(403, Some("12"), Some("12"), None, None, 1000),
        limited(Some(12), None)
    );
    assert_eq!(
        classify(429, None, None, None, None, 1000),
        limited(None, None)
    );
    // 恢复时刻已过：等 0 秒，不是负数
    assert_eq!(
        classify(429, None, None, None, Some(900), 1000),
        limited(Some(0), Some(900))
    );
}

#[test]
fn new_kinds_have_their_own_sentences() {
    let limited = |wait_secs| NetError::RateLimited {
        reset: None,
        wait_secs,
    };
    assert_eq!(
        NetError::Unreadable.message("skills.sh"),
        "无法识别 skills.sh 返回的内容"
    );
    assert_eq!(
        NetError::Interrupted.message("skills.sh"),
        "读取 skills.sh 的内容时连接中断"
    );
    assert_eq!(
        NetError::Timeout.message("skills.sh"),
        "连接 skills.sh 超时"
    );
    assert_eq!(NetError::Client.message("skills.sh"), "请求发送失败");
    assert_eq!(
        limited(Some(60)).message("skills.sh"),
        "skills.sh 限流了，约 1 分钟后再试"
    );
    assert_eq!(
        limited(Some(61)).message("skills.sh"),
        "skills.sh 限流了，约 2 分钟后再试"
    );
    assert_eq!(
        limited(Some(0)).message("skills.sh"),
        "skills.sh 限流了，约 1 分钟后再试"
    );
    assert_eq!(
        limited(None).message("skills.sh"),
        "skills.sh 暂时限流，稍后再试"
    );
    // GitHub 的限流说法不变
    assert_eq!(
        limited(Some(300)).message("GitHub"),
        "GitHub 暂时限流，稍后再试"
    );
}

#[test]
fn ac9_unparsable_body_is_unreadable_not_unreachable() {
    let base = serve_once(|s| {
        let body = "<html>not json, sk-abcdefghijklmnopqrstuvwxyz0123456789</html>";
        let _ = write!(
            s,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    });
    let failure = failure_of(run(
        test_state().fetch_skills_at(&format!("{base}/api/search"), "react")
    ));
    assert_eq!(failure.error, NetError::Unreadable);
    assert!(failure
        .detail
        .starts_with(&format!("GET {base}/api/search?… → 200 OK\n")));
    assert!(failure.detail.contains("not json"), "{}", failure.detail);
    assert!(
        !failure.detail.contains("q=react"),
        "查询串要去掉：{}",
        failure.detail
    );
    assert!(
        !failure.detail.contains("sk-abcdefghij"),
        "密钥要去掉：{}",
        failure.detail
    );
    let fallback = Fallback::from_failure("skills.sh", None, &failure);
    assert_eq!(
        fallback.reason.as_deref(),
        Some("无法识别 skills.sh 返回的内容")
    );
    assert!(!fallback.rate_limited);
}

#[test]
fn registry_parse_failure_is_unreadable_too() {
    let base = serve_once(|s| {
        let _ = write!(
            s,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]"
        );
    });
    let failure = failure_of(run(
        test_state().fetch_registry_at(&format!("{base}/v0.1/servers"), "x")
    ));
    assert_eq!(failure.error, NetError::Unreadable);
}

#[test]
fn a_429_with_retry_after_carries_the_wait() {
    let base = serve_once(|s| {
        let body = r#"{"error":"slow down"}"#;
        let _ = write!(
            s,
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    });
    let failure = failure_of(run(
        test_state().fetch_skills_at(&format!("{base}/api/search"), "react")
    ));
    assert_eq!(
        failure.error,
        NetError::RateLimited {
            reset: None,
            wait_secs: Some(60)
        }
    );
    assert_eq!(
        failure.error.message("skills.sh"),
        "skills.sh 限流了，约 1 分钟后再试"
    );
    assert!(
        failure.detail.starts_with(&format!(
            "GET {base}/api/search?… → 429 Too Many Requests · Retry-After: 60\n"
        )),
        "{}",
        failure.detail
    );
    assert!(failure.detail.contains("slow down"));
    let fallback = Fallback::from_failure("skills.sh", Some(5), &failure);
    assert!(fallback.rate_limited, "限流要标出来，不再说成连不上");
    assert_eq!(fallback.cached_at, Some(5));
}

#[test]
fn a_body_cut_off_midway_is_interrupted() {
    let base = serve_once(|s| {
        let _ = write!(
            s,
            "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{{\"skills\":"
        );
        // 少发的部分不补，直接关
    });
    let failure = failure_of(run(
        test_state().fetch_skills_at(&format!("{base}/api/search"), "react")
    ));
    assert_eq!(failure.error, NetError::Interrupted);
    assert!(failure
        .detail
        .starts_with(&format!("GET {base}/api/search?… → 200 OK\n")));
}

#[test]
fn a_silent_server_times_out() {
    let base = serve_once(|_| std::thread::sleep(Duration::from_millis(1500)));
    let failure = failure_of(run(test_state().get(
        &format!("{base}/slow"),
        Some(Duration::from_millis(200)),
        false,
    )));
    assert_eq!(failure.error, NetError::Timeout);
    assert_eq!(failure.error.message("GitHub"), "连接 GitHub 超时");
}

#[test]
fn a_refused_connection_is_plain_network() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let failure = failure_of(run(test_state().get(
        &format!("http://127.0.0.1:{port}/x"),
        None,
        false,
    )));
    assert_eq!(failure.error, NetError::Network);
    assert!(
        failure
            .detail
            .starts_with(&format!("GET http://127.0.0.1:{port}/x → ")),
        "{}",
        failure.detail
    );
    let fallback = Fallback::from_failure("skills.sh", None, &failure);
    assert_eq!(fallback.reason, None, "连不上沿用前端原有的说法");
    assert!(fallback.detail.is_some());
}

#[test]
fn skill_download_errors_carry_the_kind_and_the_raw_text() {
    // 连不上：前端按类出主句，原文进「!」
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let refused = failure_of(run(test_state().get(
        &format!("http://127.0.0.1:{port}/x"),
        None,
        false,
    )));
    // 连不上：`[类] 一句`，原文另起一行跟在 `[detail]` 后面（前端 parseBackendError 拆）
    assert_eq!(
        github_failure(&refused),
        format!(
            "[unreachable] {}\n[detail] {}",
            NetError::Network.message("GitHub"),
            refused.detail
        )
    );
    assert!(refused
        .detail
        .starts_with(&format!("GET http://127.0.0.1:{port}/x → ")));

    let silent = serve_once(|_| std::thread::sleep(Duration::from_millis(1500)));
    let slow = failure_of(run(test_state().get(
        &format!("{silent}/slow"),
        Some(Duration::from_millis(200)),
        false,
    )));
    assert!(github_failure(&slow).starts_with("[timeout] "));

    // 仓库不在：不是网络的原因，前端照这一句显示
    let missing = serve_once(|s| {
        let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    });
    let gone = failure_of(run(test_state().get(&format!("{missing}/x"), None, false)));
    assert!(github_failure(&gone).starts_with(&format!(
        "[other] {}\n[detail] ",
        github_message(&NetError::NotFound)
    )));

    // 中间的网关等超时（504）也按超时说
    assert_eq!(NetError::Status(504).kind(), NetKind::Timeout);
    assert_eq!(NetError::Interrupted.kind(), NetKind::Unreachable);
}

#[test]
fn fallback_serializes_reason_and_detail_in_camel_case() {
    let failure = NetFailure {
        error: NetError::Unreadable,
        detail: "GET https://skills.sh/api/search → 200 OK\nnot json".into(),
    };
    let json = serde_json::to_value(Fallback::from_failure("skills.sh", None, &failure)).unwrap();
    assert_eq!(json["reason"], "无法识别 skills.sh 返回的内容");
    assert_eq!(
        json["detail"],
        "GET https://skills.sh/api/search → 200 OK\nnot json"
    );
    assert_eq!(json["rateLimited"], false);
    let network = NetFailure {
        error: NetError::Network,
        detail: String::new(),
    };
    let json = serde_json::to_value(Fallback::from_failure("skills.sh", None, &network)).unwrap();
    assert!(json["reason"].is_null());
    assert!(json["detail"].is_null(), "没有原文就不带");
}

/// 市场的客户端按代理解析函数走（issue #254）：解析说走代理，请求就发到代理，带着完整地址
#[test]
fn market_client_goes_through_the_proxy_resolver() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy = reqwest::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        );
    });
    let resolve: sophia_gateway::router::ProxyFn = Arc::new(move |url: &reqwest::Url| {
        (url.host_str() == Some("skills.sophia.test")).then(|| proxy.clone())
    });
    let client = sophia_gateway::runtime::with_proxy(client_builder(), resolve)
        .build()
        .expect("测试 client");
    let state = MarketState {
        client: OnceLock::from(Ok(client)),
        ..Default::default()
    };
    let _ = run(state.fetch_skills_at("http://skills.sophia.test/api/search", "react"));
    let request = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("代理没收到请求");
    assert!(
        request.starts_with("GET http://skills.sophia.test/api/search?"),
        "{request}"
    );
}

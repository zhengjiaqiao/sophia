//! 后台路由说的话跟界面语言走：每个请求按 settings.json 里的界面语言换当前语言。
//! 当前语言是进程级的一份，单独成一个测试二进制，不与库里其他断言中文句子的测试抢。
use sophia_gateway::router::{Config, Protocol, Router};
use sophia_gateway::runtime::saved_locale;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "sophia-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MESSAGES: &str =
    r#"{"model":"claude-sonnet-5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}"#;

fn set_language(store_dir: &Path, language: &str) {
    std::fs::write(
        store_dir.join("settings.json"),
        serde_json::json!({ "language": language }).to_string(),
    )
    .unwrap();
}

/// 发一个请求，读到连接关闭，返回整段响应（状态行、头、体）
async fn send(address: std::net::SocketAddr, request: String) -> String {
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out))
        .await
        .expect("路由应当很快回话")
        .unwrap();
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn router_error_sentences_follow_the_saved_ui_language() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let store_dir = root.join("Sophia");
    std::fs::create_dir_all(&store_dir).unwrap();
    let router = Router::new(Config {
        third_party_url: String::new(),
        third_party_protocol: Protocol::Chat,
        chatgpt_url: "http://127.0.0.1:9/backend-api/codex".into(),
        openai_url: "http://127.0.0.1:9/v1".into(),
        routing_catalog_path: root.join("routing.json"),
        activity_log_path: None,
        third_party_key: Arc::new(|_, _| Err("not set".into())),
        max_body_bytes: 0,
        proxy: None,
        claude_routing_path: Some(root.join("claude-routing.json")),
        router_token: Arc::new(|| Ok(TOKEN.to_owned())),
        keepalive: Duration::ZERO,
        // 「跟随系统」时系统说繁體：这里只用明确的语言，用不到它
        locale: Some(saved_locale(store_dir.clone(), || vec!["zh-TW".into()])),
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(router.serve(listener));

    // 没带 /claude 前缀的 Anthropic 请求：来源校验那一步就回 404
    let stray = || {
        format!("POST /v1/messages HTTP/1.1\r\nHost: {address}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    };
    // 令牌不对：进了 Claude 命名空间才回 401
    let bad_token = || {
        format!(
            "POST /claude/v1/messages HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer sophia-wrong\r\nContent-Type: application/json\r\nanthropic-version: 2023-06-01\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{MESSAGES}",
            MESSAGES.len()
        )
    };

    set_language(&store_dir, "en");
    let res = send(address, stray()).await;
    assert!(res.starts_with("HTTP/1.1 404"), "{res}");
    assert!(
        res.contains("Sophia's gateway URL must include /claude"),
        "{res}"
    );
    let res = send(address, bad_token()).await;
    assert!(res.starts_with("HTTP/1.1 401"), "{res}");
    assert!(res.contains("The Sophia gateway token is wrong"), "{res}");

    // 路由运行中改成简体：下一个请求就换过来，不用重启路由
    set_language(&store_dir, "zh-Hans");
    let res = send(address, stray()).await;
    assert!(res.contains("Sophia 的网关地址要带 /claude"), "{res}");
    let res = send(address, bad_token()).await;
    assert!(res.contains("Sophia 网关令牌不对"), "{res}");

    // 跟随系统：按系统首选语言（这里是 zh-TW → 繁體）
    set_language(&store_dir, "system");
    let res = send(address, stray()).await;
    assert!(res.contains("Sophia 的閘道網址要帶 /claude"), "{res}");

    // 设置文件坏了：沿用上一次的语言，不退回简体
    std::fs::write(store_dir.join("settings.json"), "{ not json").unwrap();
    let res = send(address, stray()).await;
    assert!(res.contains("Sophia 的閘道網址要帶 /claude"), "{res}");
}

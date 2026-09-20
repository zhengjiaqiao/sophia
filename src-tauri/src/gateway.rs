//! Codex 模型网关的无界面模式：`symsync gateway <子命令>`。
//! launchd 拉起的就是这个可执行文件的副本，参数为 `gateway run …`。
use std::path::PathBuf;
use std::sync::Arc;
use symsync_gateway::router::{Config, Protocol, Router};

/// 返回进程退出码
pub fn cli(args: Vec<String>) -> i32 {
    let outcome = match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        _ => Err("用法: symsync gateway run --port <端口> --third-party-url <地址> --routing-catalog <路径> [--log <路径>] [--protocol chat|responses]".to_owned()),
    };
    match outcome {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("错误: {message}");
            1
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn run(args: &[String]) -> Result<(), String> {
    let port: u16 = flag(args, "--port")
        .unwrap_or("47328")
        .parse()
        .map_err(|_| "端口不合法".to_owned())?;
    let third_party_url = flag(args, "--third-party-url")
        .ok_or("需要 --third-party-url")?
        .to_owned();
    let routing_catalog_path =
        PathBuf::from(flag(args, "--routing-catalog").ok_or("需要 --routing-catalog")?);
    let protocol = match flag(args, "--protocol").unwrap_or("chat") {
        "responses" => Protocol::Responses,
        _ => Protocol::Chat,
    };
    let router = Router::new(Config {
        third_party_url,
        third_party_protocol: protocol,
        chatgpt_url: String::new(),
        openai_url: String::new(),
        routing_catalog_path,
        activity_log_path: flag(args, "--log").map(PathBuf::from),
        // 临时：钥匙串与系统代理模块合并进来之后替换
        third_party_key: Arc::new(|| Err("keychain not wired yet".to_owned())),
        max_body_bytes: 0,
        proxy: Some(Arc::new(env_proxy)),
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        // 只监听回环地址；路由内部还会再按来源地址和 Host 拒绝一次
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("监听 127.0.0.1:{port} 失败: {e}"))?;
        eprintln!("路由已启动: http://127.0.0.1:{port}/v1");
        router.serve(listener).await.map_err(|e| e.to_string())
    })
}

/// 临时：只认环境变量里的代理
fn env_proxy(url: &url::Url) -> Option<url::Url> {
    if url
        .host_str()
        .is_some_and(|h| h == "127.0.0.1" || h == "localhost")
    {
        return None;
    }
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|raw| url::Url::parse(&raw).ok())
}

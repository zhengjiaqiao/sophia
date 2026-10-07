//! 更新换线路（issue #262）：两个本机假服务器扮 GitHub 与国内线路（COS），更新器挂在模拟应用上、用真实的
//! 更新插件查清单与下载、验签。签名密钥在测试里现生成，插件配置取 `tauri.conf.json` 的那一份（只换公钥），
//! 所以「签名里核对版本号」用的是发出去的配置。
use super::*;
use base64::Engine as _;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::test::MockRuntime;

const PACKAGE: &[u8] = b"the update package bytes";
const NEW: &str = "9.9.9";

/// 测试用的时限：短到几秒内跑完，比例与正式的一样（连接 < 查清单）
const QUICK: Limits = Limits {
    connect: Duration::from_millis(500),
    check: Duration::from_millis(1500),
    read: Duration::from_millis(1500),
    direct: true,
};

/// 一个地址回什么
#[derive(Clone)]
enum Reply {
    Json(String),
    Bytes(&'static [u8]),
    Status(u16),
    /// 连上了但一直不回
    Hang,
}

/// 本机假服务器：按路径回话，记下被请求过的路径
struct Fake {
    base: String,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    /// `routes` 拿到自己的基础地址（清单里的包地址要指回自己）
    fn serve(routes: impl FnOnce(&str) -> Vec<(&'static str, Reply)>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes = routes(&base);
        let hits = Arc::new(Mutex::new(Vec::new()));
        let seen = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let routes = routes.clone();
                let seen = seen.clone();
                std::thread::spawn(move || answer(stream, &routes, &seen));
            }
        });
        Fake { base, hits }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

fn answer(mut stream: TcpStream, routes: &[(&str, Reply)], seen: &Mutex<Vec<String>>) {
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
    seen.lock().unwrap().push(path.clone());
    let reply = routes
        .iter()
        .find(|(p, _)| *p == path)
        .map(|(_, r)| r.clone())
        .unwrap_or(Reply::Status(404));
    let (status, kind, body): (u16, &str, Vec<u8>) = match reply {
        Reply::Json(text) => (200, "application/json", text.into_bytes()),
        Reply::Bytes(bytes) => (200, "application/octet-stream", bytes.to_vec()),
        Reply::Status(code) => (code, "text/plain", b"nope".to_vec()),
        Reply::Hang => {
            std::thread::sleep(Duration::from_secs(10));
            return;
        }
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(&body);
}

/// 一个没人听的地址：连不上
fn closed_url(path: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}{path}", listener.local_addr().unwrap());
    drop(listener);
    url
}

/// 测试里现生成的签名密钥
struct Signer(minisign::KeyPair);

impl Signer {
    fn new() -> Signer {
        Signer(minisign::KeyPair::generate_unencrypted_keypair().unwrap())
    }

    /// 插件配置里的 pubkey：公钥文本整段 base64
    fn pubkey(&self) -> String {
        b64(&self.0.pk.to_box().unwrap().into_string())
    }

    /// 清单里的 signature；`version` 是可信注释里写的版本号（新版 Tauri CLI 会写，旧的不写）
    fn sign(&self, data: &[u8], version: Option<&str>) -> String {
        let mut comment = "timestamp:0\tfile:Sophia.app.tar.gz".to_string();
        if let Some(v) = version {
            comment.push_str(&format!("\tversion:{v}"));
        }
        let signed = minisign::sign(
            Some(&self.0.pk),
            &self.0.sk,
            std::io::Cursor::new(data),
            Some(&comment),
            None,
        )
        .unwrap();
        b64(&signed.into_string())
    }
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

/// 一份清单：本机这个平台的包在 `package`
fn manifest(version: &str, package: &str, signature: &str) -> Reply {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    Reply::Json(
        serde_json::json!({
            "version": version,
            "platforms": { format!("{os}-{arch}"): { "url": package, "signature": signature } }
        })
        .to_string(),
    )
}

/// 一条有新版的线路：`/latest.json` 宣布 NEW、包在自己的 `/pkg`，包那个地址回 `package`
fn serve_line(signature: &str, package: Reply) -> Fake {
    let signature = signature.to_string();
    Fake::serve(move |base| {
        vec![
            (
                "/latest.json",
                manifest(NEW, &format!("{base}/pkg"), &signature),
            ),
            ("/pkg", package),
        ]
    })
}

/// 挂着更新插件的模拟应用（自己是 0.1.0）；插件配置是 `tauri.conf.json` 的那一份，只换成测试的公钥
fn app(signer: &Signer) -> tauri::App<MockRuntime> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let mut updater = conf["plugins"]["updater"].clone();
    updater["pubkey"] = signer.pubkey().into();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), updater);
    tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}

fn lines(urls: &[&str]) -> Vec<Url> {
    urls.iter().map(|u| u.parse().unwrap()).collect()
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

#[test]
fn manifest_unreachable_on_github_is_fetched_from_the_domestic_line() {
    let signer = Signer::new();
    let sig = signer.sign(PACKAGE, Some(NEW));
    let cos = serve_line(&sig, Reply::Bytes(PACKAGE));
    let app = app(&signer);
    let lines = lines(&[&closed_url("/latest.json"), &cos.url("/latest.json")]);

    let found = run(check(app.handle(), &lines, &QUICK))
        .unwrap()
        .expect("有新版");
    assert_eq!(found.version(), NEW);

    let (_, bytes) = run(download(app.handle(), &lines, &found, &QUICK, |_| {})).unwrap();
    assert_eq!(bytes, PACKAGE);
}

#[test]
fn package_failing_on_github_is_downloaded_from_the_domestic_line() {
    let signer = Signer::new();
    let sig = signer.sign(PACKAGE, Some(NEW));
    let github = serve_line(&sig, Reply::Status(429));
    let cos = serve_line(&sig, Reply::Bytes(PACKAGE));
    let app = app(&signer);
    let lines = lines(&[&github.url("/latest.json"), &cos.url("/latest.json")]);

    // 查清单听 GitHub 的：国内线路这时还没被问过
    let found = run(check(app.handle(), &lines, &QUICK))
        .unwrap()
        .expect("有新版");
    assert!(cos.hits().is_empty(), "{:?}", cos.hits());

    let (update, bytes) = run(download(app.handle(), &lines, &found, &QUICK, |_| {})).unwrap();
    assert_eq!(bytes, PACKAGE);
    assert_eq!(update.download_url.as_str(), cos.url("/pkg"));
    assert_eq!(github.hits(), ["/latest.json", "/pkg"]);
    assert_eq!(cos.hits(), ["/latest.json", "/pkg"]);
}

#[test]
fn both_lines_failing_take_the_domestic_kind_and_keep_both_details() {
    let signer = Signer::new();
    let sig = signer.sign(PACKAGE, Some(NEW));
    let app = app(&signer);

    // 查清单：GitHub 连上了不回（超时），国内线路连不上 → 连不上
    let github = Fake::serve(|_| vec![("/latest.json", Reply::Hang)]);
    let cos = closed_url("/latest.json");
    let lines_down = lines(&[&github.url("/latest.json"), &cos]);
    let problem = run(check(app.handle(), &lines_down, &QUICK))
        .err()
        .expect("应当失败");
    assert_eq!(problem.kind, NetKind::Unreachable);
    assert!(
        problem.detail.contains(&github.url("/latest.json")),
        "{}",
        problem.detail
    );
    assert!(problem.detail.contains(&cos), "{}", problem.detail);

    // 下载：GitHub 的包被限流，国内线路的包网关超时 → 太慢超时
    let github = serve_line(&sig, Reply::Status(429));
    let cos = serve_line(&sig, Reply::Status(504));
    let lines = lines(&[&github.url("/latest.json"), &cos.url("/latest.json")]);
    let found = run(check(app.handle(), &lines, &QUICK))
        .unwrap()
        .expect("有新版");
    let problem = run(download(app.handle(), &lines, &found, &QUICK, |_| {}))
        .err()
        .expect("应当失败");
    assert_eq!(problem.kind, NetKind::Timeout);
    assert!(problem.detail.contains("429"), "{}", problem.detail);
    assert!(
        problem.detail.contains(&cos.url("/pkg")),
        "{}",
        problem.detail
    );
}

#[test]
fn a_stalled_github_hands_over_within_the_check_limit() {
    let signer = Signer::new();
    let sig = signer.sign(PACKAGE, Some(NEW));
    let github = Fake::serve(|_| vec![("/latest.json", Reply::Hang)]);
    let cos =
        Fake::serve(|base| vec![("/latest.json", manifest(NEW, &format!("{base}/pkg"), &sig))]);
    let app = app(&signer);
    let lines = lines(&[&github.url("/latest.json"), &cos.url("/latest.json")]);

    let started = Instant::now();
    let found = run(check(app.handle(), &lines, &QUICK))
        .unwrap()
        .expect("有新版");
    assert_eq!(found.version(), NEW);
    // 只等了查清单的那一道时限，没等到系统级超时
    assert!(
        started.elapsed() < QUICK.check * 2,
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn the_signature_must_carry_the_announced_version() {
    // 清单不签名：伪造的清单可以把新版本号配上旧版本的包与签名，诱导装回旧版本。
    // 发出去的配置要求签名里写的版本号与清单说的一致；没写版本号的旧签名也不认
    let signer = Signer::new();
    let app = app(&signer);
    for signed in [Some("9.9.8"), None] {
        let sig = signer.sign(PACKAGE, signed);
        let cos = serve_line(&sig, Reply::Bytes(PACKAGE));
        let lines = lines(&[&cos.url("/latest.json")]);
        let found = run(check(app.handle(), &lines, &QUICK))
            .unwrap()
            .expect("有新版");
        let problem = run(download(app.handle(), &lines, &found, &QUICK, |_| {}))
            .err()
            .expect("签名里的版本号不对，应当拒绝");
        assert_eq!(problem.kind, NetKind::Other, "{signed:?}");
        assert!(problem.detail.contains("version"), "{}", problem.detail);
    }
}

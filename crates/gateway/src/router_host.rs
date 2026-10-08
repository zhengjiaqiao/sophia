//! 路由的宿主：在 Sophia 自己的进程里起、停本机回环路由（spec 2026-10-03-gateway-in-app R1、R4）。
//! 取代原来的 launchd 后台服务。
//!
//! 编排层（`App`）是同步代码：起路由时用标准库同步 bind 当场拿到结果（bind 成功就是健康），
//! 再把监听交给 tokio 运行时服务。端口被占时探一下 `/_health`：回的是 Sophia 的服务名就是另一个 Sophia
//! （开发版与安装版同开，或旧版留下的后台服务），否则是别的程序。
use crate::router::{Router, HEALTH_SERVICE_NAME};
use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// 端口被谁占着
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Occupant {
    /// 另一个 Sophia 的路由（`/_health` 回 Sophia 的服务名）：不换端口，两个 Sophia 会抢着改 Codex 设置
    Sophia,
    /// 别的程序：可以换到下一个空闲端口
    Other,
}

/// 起路由没成
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    Busy(Occupant),
    /// 别的原因（没有权限等），带系统的原话
    Failed(String),
}

/// 每次起路由时现做一个路由（读当时的密钥文件、清单路径）
pub type MakeRouter = Box<dyn Fn() -> Result<Arc<Router>, String> + Send + Sync>;

/// 探 `/_health` 时等多久：同一台机器上的回环连接，正常几毫秒就回
const PROBE_PATIENCE: Duration = Duration::from_millis(800);
/// 停路由时最多等它放掉端口多久
const STOP_PATIENCE: Duration = Duration::from_secs(2);

struct Running {
    port: u16,
    stop: tokio::sync::oneshot::Sender<()>,
    /// 服务任务结束时收到（或发送端被丢掉）
    done: mpsc::Receiver<()>,
}

impl Running {
    fn finished(&self) -> bool {
        !matches!(self.done.try_recv(), Err(mpsc::TryRecvError::Empty))
    }

    /// 发停止信号，等服务任务放掉端口：紧接着在同一端口上再起时不会撞上自己
    fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.done.recv_timeout(STOP_PATIENCE);
    }
}

pub struct RouterHost {
    handle: tokio::runtime::Handle,
    make: MakeRouter,
    running: Mutex<Option<Running>>,
}

impl RouterHost {
    /// `handle`：路由跑在哪个 tokio 运行时上（界面进程里是 Tauri 的）
    pub fn new(handle: tokio::runtime::Handle, make: MakeRouter) -> Self {
        Self {
            handle,
            make,
            running: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 在 `127.0.0.1:port` 上起路由。已经在这个端口上跑着：什么都不做；在别的端口上：先停掉。
    /// 同步返回：bind 成功即可服务。不要在 tokio 的工作线程上调用（端口被占时会同步探一下对方）
    pub fn start(&self, port: u16) -> Result<(), StartError> {
        let mut running = self.lock();
        if running
            .as_ref()
            .is_some_and(|r| r.port == port && !r.finished())
        {
            return Ok(());
        }
        if let Some(old) = running.take() {
            old.stop();
        }
        // 只监听回环地址；路由内部还会再按来源地址和 Host 拒绝一次
        let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                return Err(StartError::Busy(occupant(port)))
            }
            Err(e) => return Err(StartError::Failed(e.to_string())),
        };
        let failed = |e: io::Error| StartError::Failed(e.to_string());
        listener.set_nonblocking(true).map_err(failed)?;
        let router = (self.make)().map_err(StartError::Failed)?;
        let listener = {
            let _entered = self.handle.enter();
            tokio::net::TcpListener::from_std(listener).map_err(failed)?
        };
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let (finish, done) = mpsc::channel();
        self.handle.spawn(async move {
            let shutdown = async {
                // 发送端被丢掉（宿主没了）也算停
                let _ = stopped.await;
            };
            if let Err(e) = router.serve_until(listener, shutdown).await {
                log::error!("路由停了：{e}");
            }
            let _ = finish.send(());
        });
        *running = Some(Running { port, stop, done });
        Ok(())
    }

    /// 停下路由、放掉端口；本来就没在跑不算错
    pub fn stop(&self) {
        if let Some(running) = self.lock().take() {
            running.stop();
        }
    }

    /// 正在哪个端口上跑；没在跑为 None
    pub fn running(&self) -> Option<u16> {
        self.lock()
            .as_ref()
            .filter(|r| !r.finished())
            .map(|r| r.port)
    }
}

/// 端口被占时，占着的是不是 Sophia 的路由
fn occupant(port: u16) -> Occupant {
    if sophia_answers(port, PROBE_PATIENCE) {
        Occupant::Sophia
    } else {
        Occupant::Other
    }
}

/// 端口上响应 `/_health` 的是 Sophia 的路由（只探一次，`patience` 是连接与读的总上限量级）
pub fn sophia_answers(port: u16, patience: Duration) -> bool {
    let attempt = || -> io::Result<String> {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = std::net::TcpStream::connect_timeout(&address, patience)?;
        stream.set_read_timeout(Some(patience))?;
        stream.set_write_timeout(Some(patience))?;
        write!(
            stream,
            "GET /_health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        )?;
        let mut response = String::new();
        let _ = stream.take(4096).read_to_string(&mut response);
        Ok(response)
    };
    attempt().is_ok_and(|response| response.contains(HEALTH_SERVICE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::{Config, Protocol};

    fn host(runtime: &tokio::runtime::Runtime, dir: &std::path::Path) -> RouterHost {
        let catalog = dir.join("routing.json");
        std::fs::write(&catalog, r#"{"models":[]}"#).unwrap();
        RouterHost::new(
            runtime.handle().clone(),
            Box::new(move || {
                Router::new(Config {
                    third_party_url: String::new(),
                    third_party_protocol: Protocol::Chat,
                    chatgpt_url: String::new(),
                    openai_url: String::new(),
                    routing_catalog_path: catalog.clone(),
                    activity_log_path: None,
                    third_party_key: Arc::new(|_, _| Err("none".into())),
                    max_body_bytes: 0,
                    proxy: None,
                    claude_routing_path: None,
                    workbuddy_routing_path: None,
                    router_token: Arc::new(|| Err("none".into())),
                    keepalive: Duration::ZERO,
                    locale: None,
                    key_verdicts: None,
                })
            }),
        )
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    /// 系统现给的一个空闲端口
    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// 起在空闲端口上马上能回 `/_health`；停下后端口放掉，可以再起
    #[test]
    fn starts_serves_and_stops() {
        let runtime = runtime();
        let dir = tempfile::tempdir().unwrap();
        let host = host(&runtime, dir.path());
        let port = free_port();
        assert_eq!(host.running(), None);
        host.start(port).unwrap();
        assert_eq!(host.running(), Some(port));
        assert!(sophia_answers(port, Duration::from_secs(2)));
        host.start(port).unwrap();
        host.stop();
        assert_eq!(host.running(), None);
        assert!(!sophia_answers(port, Duration::from_millis(300)));
        std::net::TcpListener::bind(("127.0.0.1", port)).expect("端口已放掉");
        host.start(port).unwrap();
        assert!(sophia_answers(port, Duration::from_secs(2)));
    }

    /// 端口被占：占着的是 Sophia 的路由 → Sophia；是别的程序 → Other
    #[test]
    fn busy_ports_are_told_apart() {
        let runtime = runtime();
        let dir = tempfile::tempdir().unwrap();
        let first = host(&runtime, dir.path());
        let second = host(&runtime, dir.path());
        let port = free_port();
        first.start(port).unwrap();
        assert_eq!(second.start(port), Err(StartError::Busy(Occupant::Sophia)));

        let other = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = other.local_addr().unwrap().port();
        assert_eq!(second.start(taken), Err(StartError::Busy(Occupant::Other)));
        assert_eq!(second.running(), None);
    }

    /// 回 `/_health` 的不是 Sophia 的服务名：不算 Sophia
    #[test]
    fn a_foreign_responder_is_not_sophia() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten().take(4) {
                let mut stream = stream;
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.0 200 OK\r\n\r\n{\"ok\":true}");
            }
        });
        assert!(!sophia_answers(port, Duration::from_millis(600)));
    }

    /// 换端口：在新端口上起之前先停掉旧的
    #[test]
    fn starting_on_another_port_stops_the_old_one() {
        let runtime = runtime();
        let dir = tempfile::tempdir().unwrap();
        let host = host(&runtime, dir.path());
        let (a, b) = (free_port(), free_port());
        host.start(a).unwrap();
        host.start(b).unwrap();
        assert_eq!(host.running(), Some(b));
        assert!(!sophia_answers(a, Duration::from_millis(300)));
        assert!(sophia_answers(b, Duration::from_secs(2)));
    }
}

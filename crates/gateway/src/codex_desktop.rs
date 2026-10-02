//! Codex 桌面应用（包 id `com.openai.codex`；2026-09 起应用包是 `/Applications/ChatGPT.app`）的副作用层：
//! 在不在运行、让它退出、打开、读显示名。不做编排：什么时候退出、之后结束哪些后台进程由 `app` 决定。
//!
//! 为什么要退出整个应用：它的窗口缓存了模型列表，只重启 app-server，新加的模型在选择器里仍然看不到
//! （新开会话也一样）；整个应用退出再打开才会重新读。
//!
//! 写法照 `claude_desktop`：系统调用与时钟走 `System`，测试换成假的，不去真的启动或退出用户的应用。
//! 退出只发 SIGTERM 给 `lsappinfo` 报出的主进程（Electron 当作 ⌘Q 处理），不用 `osascript`、不发 SIGKILL——
//! 退不掉就如实报「可能正在等你确认」，交给人。
//! 在不在运行只看 `lsappinfo`：它拉起的 `codex app-server` 由 `app` 按 `process::is_codex_background` 另行结束。
use crate::claude_desktop::{
    self, parse_lsappinfo_asn, parse_lsappinfo_pid, OPEN_PATIENCE, POLL_INTERVAL, QUIT_PATIENCE,
};
use crate::process;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// Codex 桌面应用的包 id（`Info.plist` 的 `CFBundleIdentifier`）。按它打开就不必写死应用包路径
pub const BUNDLE_ID: &str = "com.openai.codex";
/// 读不到显示名（没装）时提示里用的名字
pub const FALLBACK_NAME: &str = "Codex";

/// 退出超时的原话（错误码 `desktop_busy`）
pub fn busy_message(app: &str) -> String {
    sophia_core::t!("models.desktop.busy", app = app)
}

/// 打开后等不到它在运行的原话
pub fn open_timeout_message(app: &str) -> String {
    sophia_core::t!(
        "models.desktop.openTimeout",
        seconds = OPEN_PATIENCE.as_secs(),
        app = app
    )
}

/// 对外部世界的依赖。真实实现是 `RealSystem`；测试换成假的
pub trait System: Send + Sync {
    /// `lsappinfo find bundleID=com.openai.codex` 的标准输出
    fn lsappinfo_find(&self) -> io::Result<String>;
    /// `lsappinfo info -only pid <ASN>` 的标准输出
    fn lsappinfo_pid(&self, asn: &str) -> io::Result<String>;
    /// 发 SIGTERM；失败时带回系统的原话
    fn terminate(&self, pid: u32) -> io::Result<()>;
    /// `open -b com.openai.codex`；失败时带回 `open` 的原话
    fn open(&self) -> io::Result<()>;
    /// 读 plist 里一个字符串键；文件或键不存在为 None
    fn plist_value(&self, plist: &Path, key: &str) -> Option<String>;
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
}

/// 真实的系统调用（macOS 自带的 `lsappinfo`、`kill`、`open`、`plutil`）
pub struct RealSystem;

impl System for RealSystem {
    fn lsappinfo_find(&self) -> io::Result<String> {
        claude_desktop::stdout_of(
            "/usr/bin/lsappinfo",
            &["find", &format!("bundleID={BUNDLE_ID}")],
        )
    }

    fn lsappinfo_pid(&self, asn: &str) -> io::Result<String> {
        claude_desktop::stdout_of("/usr/bin/lsappinfo", &["info", "-only", "pid", asn])
    }

    fn terminate(&self, pid: u32) -> io::Result<()> {
        process::terminate(pid)
    }

    fn open(&self) -> io::Result<()> {
        claude_desktop::open_bundle(BUNDLE_ID)
    }

    fn plist_value(&self, plist: &Path, key: &str) -> Option<String> {
        claude_desktop::plist_string(plist, key)
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// `Info.plist` 按修改时间缓存的读取结果：`(修改时间, CFBundleIdentifier, 显示名)`
type PlistCache = HashMap<PathBuf, (SystemTime, Option<String>, Option<String>)>;

/// 桌面应用的检测与进程操作。`apps` 是按优先级排的候选应用包路径（测试指向临时目录）
pub struct Desktop<S: System> {
    system: S,
    apps: Vec<PathBuf>,
    plist_cache: Mutex<PlistCache>,
}

impl<S: System> Desktop<S> {
    pub fn new(system: S, apps: Vec<PathBuf>) -> Self {
        Self {
            system,
            apps,
            plist_cache: Mutex::new(HashMap::new()),
        }
    }

    /// 在不在运行：`lsappinfo find` 有输出即在。查不成就报错，不当它没在运行
    pub fn running(&self) -> io::Result<bool> {
        Ok(!self.system.lsappinfo_find()?.trim().is_empty())
    }

    /// 发退出请求并等到它不在运行（最多 15 秒）。本来就没在运行 → 不发信号，直接返回。
    /// 超时 → `TimedOut` + `busy_message`；从不强杀
    pub fn quit(&self) -> io::Result<()> {
        self.request_quit()?;
        if self.wait_until(false, QUIT_PATIENCE)? {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                busy_message(&self.display_name()),
            ))
        }
    }

    /// 只发退出请求（SIGTERM 给 `lsappinfo` 报出的主进程），不等
    fn request_quit(&self) -> io::Result<()> {
        let Some(pid) = self.main_pid()? else {
            return Ok(());
        };
        self.system.terminate(pid).or_else(|e| {
            // 发信号前它刚好自己退了：不算失败。还在就把系统的原话带出去
            match self.main_pid() {
                Ok(Some(still)) if still == pid => Err(e),
                _ => Ok(()),
            }
        })
    }

    /// `lsappinfo` 报出的主进程 pid；不在 `lsappinfo` 里为 None。
    /// 在里面却读不出 pid（查的一瞬间它刚退出除外）→ 报错，带上 `lsappinfo` 的原话
    fn main_pid(&self) -> io::Result<Option<u32>> {
        let find = self.system.lsappinfo_find()?;
        let Some(asn) = parse_lsappinfo_asn(&find) else {
            return Ok(None);
        };
        let text = self.system.lsappinfo_pid(asn)?;
        if let Some(pid) = parse_lsappinfo_pid(&text) {
            return Ok(Some(pid));
        }
        if self.system.lsappinfo_find()?.trim().is_empty() {
            return Ok(None);
        }
        Err(io::Error::other(sophia_core::t!(
            "models.desktop.pidUnreadable",
            app = self.display_name(),
            detail = text.trim()
        )))
    }

    /// 打开（`open -b`）并等到它在运行（最多 20 秒）。打不开 → `open` 的原话；超时 → `TimedOut`
    pub fn open(&self) -> io::Result<()> {
        self.system.open()?;
        if self.wait_until(true, OPEN_PATIENCE)? {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                open_timeout_message(&self.display_name()),
            ))
        }
    }

    /// 每 `POLL_INTERVAL` 查一次，直到在不在运行等于 `want`；到点还不是 → `Ok(false)`。
    /// 中途查不成就接着等，到点时最后一次还是查不成才把那次的错误带出去（同 `claude_desktop`）
    fn wait_until(&self, want: bool, patience: Duration) -> io::Result<bool> {
        let deadline = self.system.now() + patience;
        loop {
            match self.running() {
                Ok(now) if now == want => return Ok(true),
                Ok(_) if self.system.now() >= deadline => return Ok(false),
                Err(e) if self.system.now() >= deadline => return Err(e),
                _ => self.system.sleep(POLL_INTERVAL),
            }
        }
    }

    /// 装着的桌面应用的显示名：候选路径里第一个 `CFBundleIdentifier` 是 `BUNDLE_ID` 的，
    /// 取 `CFBundleDisplayName`，没有取 `CFBundleName`，再没有取应用包文件名（去掉 `.app`）。没装为空串。
    /// `Info.plist` 按修改时间缓存，状态轮询不会每次都起 `plutil`
    pub fn app_name(&self) -> String {
        self.apps
            .iter()
            .find_map(|app| {
                let (id, name) = self.read_plist(&app.join("Contents").join("Info.plist"))?;
                (id.as_deref() == Some(BUNDLE_ID)).then(|| {
                    name.unwrap_or_else(|| {
                        app.file_stem()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    })
                })
            })
            .unwrap_or_default()
    }

    /// 提示里用的名字：`app_name`，没装时用 `FALLBACK_NAME`
    fn display_name(&self) -> String {
        Some(self.app_name())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| FALLBACK_NAME.to_owned())
    }

    /// 读 `Info.plist` 的包 id 与显示名；文件不存在为 None。包 id 不是我们的就不读名字
    fn read_plist(&self, plist: &Path) -> Option<(Option<String>, Option<String>)> {
        let modified = std::fs::metadata(plist).ok()?.modified().ok();
        let mut cache = self
            .plist_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let (Some(modified), Some((at, id, name))) = (modified, cache.get(plist)) {
            if *at == modified {
                return Some((id.clone(), name.clone()));
            }
        }
        let id = self.system.plist_value(plist, "CFBundleIdentifier");
        let name = if id.as_deref() == Some(BUNDLE_ID) {
            self.system
                .plist_value(plist, "CFBundleDisplayName")
                .or_else(|| self.system.plist_value(plist, "CFBundleName"))
        } else {
            None
        };
        if let Some(modified) = modified {
            cache.insert(plist.to_owned(), (modified, id.clone(), name.clone()));
        }
        Some((id, name))
    }
}

/// 桌面应用可能装在的位置，按优先级。改名前叫 `Codex.app`，自动更新后是 `ChatGPT.app`
pub fn app_candidates() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let user_apps = home.join("Applications");
    vec![
        PathBuf::from("/Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        user_apps.join("ChatGPT.app"),
        user_apps.join("Codex.app"),
    ]
}

fn real() -> &'static Desktop<RealSystem> {
    static REAL: OnceLock<Desktop<RealSystem>> = OnceLock::new();
    REAL.get_or_init(|| Desktop::new(RealSystem, app_candidates()))
}

/// 真实的 `Desktop::running`（给 `app::Deps.codex_app_running`）
pub fn running() -> io::Result<bool> {
    real().running()
}

/// 真实的 `Desktop::quit`（给 `app::Deps.codex_app_quit`）：发退出请求并等到退出，最多 15 秒
pub fn quit() -> io::Result<()> {
    real().quit()
}

/// 真实的 `Desktop::open`（给 `app::Deps.codex_app_open`）：`open -b` 并等到在运行，最多 20 秒
pub fn open() -> io::Result<()> {
    real().open()
}

/// 真实的 `Desktop::app_name`（给 `app::Deps.codex_app_name`），`Info.plist` 按修改时间缓存
pub fn app_name() -> String {
    real().app_name()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const PID: u32 = 4242;
    const FIND: &str = "ASN:0x0-0x215174f6-\"ChatGPT\":\n";

    /// 假的系统：`lsappinfo` 里有没有它随假时钟变化，记下每次调用
    #[derive(Default)]
    struct World {
        app: bool,
        /// 收到 SIGTERM 后再过几次轮询间隔退出；None = 一直不退（在等人确认）
        exits_after: Option<u32>,
        /// `open` 之后再过几次轮询间隔在运行；None = 一直起不来
        starts_after: Option<u32>,
        quitting: Option<u32>,
        opening: Option<u32>,
        terminate_error: Option<String>,
        open_error: Option<String>,
        plist: HashMap<(PathBuf, String), String>,
        elapsed: Duration,
        calls: Vec<String>,
    }

    #[derive(Clone)]
    struct Fake {
        world: Arc<Mutex<World>>,
        base: Instant,
    }

    impl Fake {
        fn new(world: World) -> Self {
            Self {
                world: Arc::new(Mutex::new(world)),
                base: Instant::now(),
            }
        }

        fn w(&self) -> std::sync::MutexGuard<'_, World> {
            self.world.lock().unwrap()
        }

        fn count(&self, call: &str) -> usize {
            self.w().calls.iter().filter(|c| c.as_str() == call).count()
        }
    }

    fn step(left: &mut Option<u32>) -> bool {
        match *left {
            Some(n) if n <= 1 => {
                *left = None;
                true
            }
            Some(u32::MAX) | None => false,
            Some(n) => {
                *left = Some(n - 1);
                false
            }
        }
    }

    impl System for Fake {
        fn lsappinfo_find(&self) -> io::Result<String> {
            let mut w = self.w();
            w.calls.push("find".into());
            Ok(if w.app { FIND.into() } else { String::new() })
        }

        fn lsappinfo_pid(&self, asn: &str) -> io::Result<String> {
            let mut w = self.w();
            w.calls.push("pid".into());
            assert_eq!(asn, "ASN:0x0-0x215174f6-");
            Ok(if w.app {
                format!("\"pid\"={PID}\n")
            } else {
                "\"pid\"=[ NULL ]\n".into()
            })
        }

        fn terminate(&self, pid: u32) -> io::Result<()> {
            let mut w = self.w();
            w.calls.push(format!("term {pid}"));
            if let Some(message) = w.terminate_error.clone() {
                return Err(io::Error::other(message));
            }
            w.quitting = Some(w.exits_after.unwrap_or(u32::MAX));
            Ok(())
        }

        fn open(&self) -> io::Result<()> {
            let mut w = self.w();
            w.calls.push("open".into());
            if let Some(message) = w.open_error.clone() {
                return Err(io::Error::other(message));
            }
            w.opening = Some(w.starts_after.unwrap_or(u32::MAX));
            Ok(())
        }

        fn plist_value(&self, plist: &Path, key: &str) -> Option<String> {
            let mut w = self.w();
            w.calls.push(format!("plist {key}"));
            w.plist.get(&(plist.to_owned(), key.to_owned())).cloned()
        }

        fn now(&self) -> Instant {
            self.base + self.w().elapsed
        }

        fn sleep(&self, duration: Duration) {
            let mut w = self.w();
            w.calls.push("sleep".into());
            w.elapsed += duration;
            if step(&mut w.quitting) {
                w.app = false;
            }
            if step(&mut w.opening) {
                w.app = true;
            }
        }
    }

    fn running_app() -> World {
        World {
            app: true,
            exits_after: Some(3),
            starts_after: Some(4),
            ..World::default()
        }
    }

    fn desktop(world: World) -> (Desktop<Fake>, Fake) {
        let fake = Fake::new(world);
        (Desktop::new(fake.clone(), Vec::new()), fake)
    }

    #[test]
    fn quit_sends_one_sigterm_to_the_main_pid_and_waits() {
        let (d, fake) = desktop(running_app());
        d.quit().unwrap();
        assert_eq!(fake.count("term 4242"), 1);
        assert_eq!(fake.count("sleep"), 3, "等到它退出才返回");
        assert!(!d.running().unwrap());
    }

    #[test]
    fn quit_does_not_signal_when_not_running() {
        let (d, fake) = desktop(World::default());
        d.quit().unwrap();
        assert!(fake.w().calls.iter().all(|c| !c.starts_with("term")));
        assert_eq!(fake.count("sleep"), 0);
    }

    #[test]
    fn quit_times_out_as_busy_without_escalating() {
        let (d, fake) = desktop(World {
            exits_after: None,
            ..running_app()
        });
        let err = d.quit().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(err.to_string(), "Codex 没有退出，可能正在等你确认");
        assert_eq!(fake.count("term 4242"), 1, "超时也不再发信号，更不强杀");
        let waited = fake.w().elapsed;
        assert!(waited >= QUIT_PATIENCE && waited < QUIT_PATIENCE + POLL_INTERVAL);
    }

    #[test]
    fn quit_relays_the_kill_error_when_it_is_still_there() {
        let (d, fake) = desktop(World {
            terminate_error: Some("kill: 4242: Operation not permitted".into()),
            ..running_app()
        });
        assert_eq!(
            d.quit().unwrap_err().to_string(),
            "kill: 4242: Operation not permitted"
        );
        assert_eq!(fake.count("sleep"), 0, "信号没发出去就不等");
    }

    #[test]
    fn open_waits_until_running_and_relays_errors() {
        let (d, fake) = desktop(World {
            starts_after: Some(4),
            ..World::default()
        });
        d.open().unwrap();
        assert_eq!(fake.w().calls[0], "open");
        assert_eq!(fake.count("sleep"), 4);

        let said = "Unable to find application with bundle identifier com.openai.codex.";
        let (d, fake) = desktop(World {
            open_error: Some(said.into()),
            ..World::default()
        });
        assert_eq!(d.open().unwrap_err().to_string(), said);
        assert_eq!(fake.w().calls, vec!["open"]);

        let (d, _) = desktop(World {
            starts_after: None,
            ..World::default()
        });
        let err = d.open().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(err.to_string(), "20 秒内没看到 Codex 在运行");
    }

    // ----- 显示名：路径指向临时目录 -----

    fn make_app(root: &Path, dir: &str, name: &str) -> (PathBuf, PathBuf) {
        let app = root.join(dir).join(name);
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        let plist = app.join("Contents").join("Info.plist");
        std::fs::write(&plist, "<plist/>").unwrap();
        (app, plist)
    }

    fn set(fake: &Fake, plist: &Path, key: &str, value: &str) {
        fake.w()
            .plist
            .insert((plist.to_owned(), key.to_owned()), value.to_owned());
    }

    #[test]
    fn app_name_prefers_display_name_then_bundle_name_then_file_stem() {
        let root = tempfile::tempdir().unwrap();
        let (other, other_plist) = make_app(root.path(), "a", "Codex.app");
        let (ours, plist) = make_app(root.path(), "b", "ChatGPT.app");
        let fake = Fake::new(World::default());
        set(
            &fake,
            &other_plist,
            "CFBundleIdentifier",
            "com.example.other",
        );
        set(&fake, &other_plist, "CFBundleDisplayName", "Other");
        set(&fake, &plist, "CFBundleIdentifier", BUNDLE_ID);
        let missing = root.path().join("nowhere").join("Codex.app");
        let d = Desktop::new(fake.clone(), vec![missing, other, ours.clone()]);
        assert_eq!(d.app_name(), "ChatGPT", "两个键都没有：用文件名");

        // 换一个 Desktop 以免读到缓存
        set(&fake, &plist, "CFBundleName", "ChatGPT Name");
        let d = Desktop::new(fake.clone(), vec![ours.clone()]);
        assert_eq!(d.app_name(), "ChatGPT Name");

        set(&fake, &plist, "CFBundleDisplayName", "ChatGPT Display");
        let d = Desktop::new(fake.clone(), vec![ours]);
        assert_eq!(d.app_name(), "ChatGPT Display");
        assert_eq!(d.display_name(), "ChatGPT Display");
    }

    #[test]
    fn app_name_is_empty_when_not_installed() {
        let root = tempfile::tempdir().unwrap();
        let d = Desktop::new(
            Fake::new(World::default()),
            vec![root.path().join("ChatGPT.app")],
        );
        assert_eq!(d.app_name(), "");
        assert_eq!(d.display_name(), FALLBACK_NAME);
    }

    #[test]
    fn app_name_rereads_the_plist_only_when_its_mtime_changes() {
        let root = tempfile::tempdir().unwrap();
        let (app, plist) = make_app(root.path(), "a", "Codex.app");
        let fake = Fake::new(World::default());
        set(&fake, &plist, "CFBundleIdentifier", BUNDLE_ID);
        set(&fake, &plist, "CFBundleDisplayName", "Codex");
        let d = Desktop::new(fake.clone(), vec![app]);
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let touch = |at: SystemTime| {
            std::fs::File::options()
                .write(true)
                .open(&plist)
                .unwrap()
                .set_modified(at)
                .unwrap();
        };
        touch(t0);
        assert_eq!(d.app_name(), "Codex");
        assert_eq!(d.app_name(), "Codex");
        assert_eq!(fake.count("plist CFBundleIdentifier"), 1, "没变就用缓存");

        // 自动更新改了名字：plist 换了、修改时间变了
        set(&fake, &plist, "CFBundleDisplayName", "ChatGPT");
        touch(t0 + Duration::from_secs(60));
        assert_eq!(d.app_name(), "ChatGPT");
        assert_eq!(fake.count("plist CFBundleIdentifier"), 2);
    }
}

//! Claude 桌面应用的副作用层：在不在运行（R48）、让它退出（R50 第 2、3 步）、打开（R49、R50 第 5 步）、
//! 读版本（`Info.plist`）、受管偏好是否存在（R34）。不做编排：什么时候写配置、写什么由 `app` 决定。
//!
//! 写法照 `process.rs`：判定规则是纯函数（`is_desktop_process`、`running_from`、`parse_lsappinfo_*`），
//! 真实的系统调用集中在 `RealSystem`；等待循环照 `runtime::router_healthy_within`（截止时刻 + 轮询，
//! 出错也接着等，到点才把最后一次的错误带出去）。系统调用与时钟都走 `System`，
//! 测试换成假的，不去真的启动或退出用户的 Claude。
//!
//! 退出只发 SIGTERM（`process::terminate`，即 `/bin/kill -TERM`）给 `lsappinfo` 报出的主进程：
//! Electron 收到后走与 ⌘Q 相同的正常退出流程。不用 `osascript`（会弹「Sophia 想控制 Claude」的授权框），
//! 不发 SIGKILL——退不掉就如实报「可能正在等你确认」，交给人。
use crate::process::{self, ProcessInfo};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// Claude 桌面应用的包 id（`Info.plist` 的 `CFBundleIdentifier`，也是受管偏好的域名）
pub const BUNDLE_ID: &str = "com.anthropic.claudefordesktop";
/// 等退出、等打开时多久查一次
pub const POLL_INTERVAL: Duration = Duration::from_millis(300);
/// 发出退出请求后最多等多久（R50 第 2 步）
pub const QUIT_PATIENCE: Duration = Duration::from_secs(15);
/// `open -b` 之后最多等多久看到它在运行（R49）
pub const OPEN_PATIENCE: Duration = Duration::from_secs(20);
/// 退出超时的原话（R50 第 3 步，错误码 `desktop_busy`）。`quit` 超时返回的错误 `kind()` 是 `TimedOut`
pub fn busy_message() -> String {
    sophia_core::t!("models.desktop.busy", app = "Claude")
}

/// Chrome 扩展拉起的辅助进程：Chrome 开着它就一直在，不算桌面应用在运行
const CHROME_NATIVE_HOST: &str = "/Claude.app/Contents/Helpers/chrome-native-host";
/// 可执行文件路径含这些片段之一的进程算桌面应用的：主进程与各 Helper，以及它拉起的内置 Claude Code
const DESKTOP_PATH_MARKERS: [&str; 3] = [
    "/Claude.app/Contents/",
    "/Application Support/Claude/claude-code/",
    "/Application Support/Claude-3p/claude-code/",
];

/// 这个可执行文件路径（`ps -o comm=`）是不是桌面应用的进程（R48）。
/// `chrome-native-host` 不算；只按路径片段认，不按进程名（本机实测 `pgrep -x Claude` 查不到主进程）
pub fn is_desktop_process(executable: &str) -> bool {
    !executable.contains(CHROME_NATIVE_HOST)
        && DESKTOP_PATH_MARKERS
            .iter()
            .any(|marker| executable.contains(marker))
}

/// R48 的判定：`lsappinfo find bundleID=…` 有输出，或进程表（`ps -axo pid=,comm=`）里有桌面应用的进程
pub fn running_from(lsappinfo_find: &str, ps: &str) -> bool {
    !lsappinfo_find.trim().is_empty() || !desktop_processes(ps).is_empty()
}

/// 进程表里属于桌面应用的那些（不含 `chrome-native-host`）
pub fn desktop_processes(ps: &str) -> Vec<ProcessInfo> {
    process::parse_ps(ps)
        .into_iter()
        .filter(|p| is_desktop_process(&p.command))
        .collect()
}

/// `lsappinfo find bundleID=…` 的输出形如 `ASN:0x0-0x1f876857-"Claude":`，取出 `ASN:0x0-0x1f876857-`
/// 给 `lsappinfo info` 用；没在运行时输出为空。
/// （本机实测 `lsappinfo info -only pid -app bundleID=…` 什么也不输出，只能先 find 再按 ASN 查）
pub fn parse_lsappinfo_asn(text: &str) -> Option<&str> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("ASN:"))?;
    Some(match line.find('"') {
        Some(quote) => &line[..quote],
        None => line.trim_end_matches(':'),
    })
}

/// `lsappinfo info -only pid <ASN>` 的输出形如 `"pid"=59664`；应用已不在时是 `"pid"=[ NULL ]`
pub fn parse_lsappinfo_pid(text: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        let (key, value) = line.trim().split_once('=')?;
        if key.trim() != "\"pid\"" {
            return None;
        }
        value.trim().parse().ok()
    })
}

/// 装着的桌面应用
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// 应用包路径（`/Applications/Claude.app` 或 `~/Applications/Claude.app`）
    pub app_path: PathBuf,
    /// `CFBundleShortVersionString`；读不到为 None
    pub version: Option<String>,
}

/// 对外部世界的依赖。真实实现是 `RealSystem`；测试换成假的
pub trait System: Send + Sync {
    /// `lsappinfo find bundleID=com.anthropic.claudefordesktop` 的标准输出
    fn lsappinfo_find(&self) -> io::Result<String>;
    /// `lsappinfo info -only pid <ASN>` 的标准输出
    fn lsappinfo_pid(&self, asn: &str) -> io::Result<String>;
    /// `ps -axo pid=,comm=` 的标准输出
    fn ps(&self) -> io::Result<String>;
    /// 发 SIGTERM；失败时带回系统的原话
    fn terminate(&self, pid: u32) -> io::Result<()>;
    /// `open -b com.anthropic.claudefordesktop`；失败时带回 `open` 的原话
    fn open(&self) -> io::Result<()>;
    /// 读 plist 里一个字符串键；文件或键不存在为 None
    fn plist_value(&self, plist: &Path, key: &str) -> Option<String>;
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
}

/// 真实的系统调用（macOS 自带的 `lsappinfo`、`ps`、`kill`、`open`、`plutil`）
pub struct RealSystem;

impl System for RealSystem {
    fn lsappinfo_find(&self) -> io::Result<String> {
        stdout_of(
            "/usr/bin/lsappinfo",
            &["find", &format!("bundleID={BUNDLE_ID}")],
        )
    }

    fn lsappinfo_pid(&self, asn: &str) -> io::Result<String> {
        stdout_of("/usr/bin/lsappinfo", &["info", "-only", "pid", asn])
    }

    fn ps(&self) -> io::Result<String> {
        stdout_of("/bin/ps", &["-axo", "pid=,comm="])
    }

    fn terminate(&self, pid: u32) -> io::Result<()> {
        process::terminate(pid)
    }

    fn open(&self) -> io::Result<()> {
        open_bundle(BUNDLE_ID)
    }

    fn plist_value(&self, plist: &Path, key: &str) -> Option<String> {
        plist_string(plist, key)
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// 用 `plutil` 读 plist 里一个字符串键；文件或键不存在、值为空为 None。`codex_desktop` 也用它
pub(crate) fn plist_string(plist: &Path, key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

/// 跑一个命令取标准输出；退出码非零时把它的 stderr 原话带回去。`codex_desktop` 也用它
pub(crate) fn stdout_of(program: &str, args: &[&str]) -> io::Result<String> {
    let output = Command::new(program).args(args).output()?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(io::Error::other(if said.is_empty() {
            sophia_core::t!(
                "models.sysproxy.exitCode",
                program = program,
                code = output.status
            )
        } else {
            said
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `open -b <包 id>`：让系统按应用标识打开应用（已开着就只是带到前面）。
/// 打不开时把 `open` 的原话带回去。与 `runtime::launch_codex` 同一写法，只是包 id 是参数
pub fn open_bundle(bundle_id: &str) -> io::Result<()> {
    let output = Command::new("/usr/bin/open")
        .args(["-b", bundle_id])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(io::Error::other(if said.is_empty() {
        sophia_core::t!(
            "models.runtime.openFailed",
            bundleId = bundle_id,
            status = output.status
        )
    } else {
        said
    }))
}

/// `Info.plist` 按修改时间缓存的读取结果：`(修改时间, CFBundleIdentifier, CFBundleShortVersionString)`
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

    /// 在不在运行（R48）。`lsappinfo` 有输出就不再看进程表；
    /// 两样都查不成、或一样查不成而另一样说没在运行 → 报错（拿不准时不当它没在运行，写配置前要靠它）
    pub fn running(&self) -> io::Result<bool> {
        let find = match self.system.lsappinfo_find() {
            Ok(text) if !text.trim().is_empty() => return Ok(true),
            Ok(text) => Ok(text),
            Err(e) => Err(e),
        };
        let ps = self.system.ps()?;
        if !desktop_processes(&ps).is_empty() {
            return Ok(true);
        }
        find.map(|find| running_from(&find, &ps))
    }

    /// 让它退出并等到相关进程全部没了（R50 第 2、3 步）。本来就没在运行 → 什么也不做。
    /// 超时 → `TimedOut` + `busy_message`；从不强杀
    pub fn quit(&self) -> io::Result<()> {
        if !self.running()? {
            return Ok(());
        }
        self.request_quit()?;
        if self.wait_until(false, QUIT_PATIENCE)? {
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::TimedOut, busy_message()))
        }
    }

    /// 只发退出请求（SIGTERM 给 `lsappinfo` 报出的主进程），不等。
    /// 主进程已经不在（只剩它拉起的后台进程）→ 不发任何信号，它们会跟着退
    pub fn request_quit(&self) -> io::Result<()> {
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

    /// `lsappinfo` 报出的主进程 pid；它不在 `lsappinfo` 里为 None。
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
            app = "Claude",
            detail = text.trim()
        )))
    }

    /// 打开（`open -b`）并等到它在运行（R49，上限 20 秒）。打不开 → `open` 的原话；超时 → `TimedOut`
    pub fn open(&self) -> io::Result<()> {
        self.system.open()?;
        if self.wait_until(true, OPEN_PATIENCE)? {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                sophia_core::t!(
                    "models.desktop.openTimeout",
                    seconds = OPEN_PATIENCE.as_secs(),
                    app = "Claude"
                ),
            ))
        }
    }

    /// 每 `POLL_INTERVAL` 按 R48 查一次，直到在不在运行等于 `want`；到点还不是 → `Ok(false)`。
    /// 中途查不成就接着等，到点时最后一次还是查不成才把那次的错误带出去（同 `router_healthy_within`）
    pub fn wait_until(&self, want: bool, patience: Duration) -> io::Result<bool> {
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

    /// 装着的桌面应用：候选路径里第一个 `CFBundleIdentifier` 是 `BUNDLE_ID` 的（R34 `installed` / `version`）。
    /// `Info.plist` 按修改时间缓存，没变就不再起 `plutil`
    pub fn info(&self) -> Option<DesktopInfo> {
        self.apps.iter().find_map(|app| {
            let (bundle_id, version) = self.read_plist(&app.join("Contents").join("Info.plist"))?;
            (bundle_id.as_deref() == Some(BUNDLE_ID)).then(|| DesktopInfo {
                app_path: app.clone(),
                version,
            })
        })
    }

    /// 读 `Info.plist` 的两个键；文件不存在为 None
    fn read_plist(&self, plist: &Path) -> Option<(Option<String>, Option<String>)> {
        let modified = std::fs::metadata(plist).ok()?.modified().ok();
        let mut cache = self
            .plist_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let (Some(modified), Some((at, id, version))) = (modified, cache.get(plist)) {
            if *at == modified {
                return Some((id.clone(), version.clone()));
            }
        }
        let id = self.system.plist_value(plist, "CFBundleIdentifier");
        let version = self.system.plist_value(plist, "CFBundleShortVersionString");
        if let Some(modified) = modified {
            cache.insert(plist.to_owned(), (modified, id.clone(), version.clone()));
        }
        Some((id, version))
    }
}

/// 桌面应用可能装在的位置，按优先级
pub fn app_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications/Claude.app"),
        home().join("Applications").join("Claude.app"),
    ]
}

/// 受管偏好的两个位置：用户级、机器级（研究 A1、官方 mdm）
pub fn managed_pref_paths_for(user: &str) -> Vec<PathBuf> {
    let base = Path::new("/Library/Managed Preferences");
    let file = format!("{BUNDLE_ID}.plist");
    vec![base.join(user).join(&file), base.join(file)]
}

/// 当前用户的受管偏好位置
pub fn managed_pref_paths() -> Vec<PathBuf> {
    let user = std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| home().file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    managed_pref_paths_for(&user)
}

/// 受管偏好存在即算（R34 `managed`）：不解析内容，见 spec 风险一节。
/// 按条目本身判断（不跟随软链），坏链也算存在——拿不准时往「受管」那边靠
pub fn managed(paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| std::fs::symlink_metadata(p).is_ok())
}

fn home() -> PathBuf {
    crate::runtime::home()
}

fn real() -> &'static Desktop<RealSystem> {
    static REAL: OnceLock<Desktop<RealSystem>> = OnceLock::new();
    REAL.get_or_init(|| Desktop::new(RealSystem, app_candidates()))
}

/// 真实的 `Desktop::running`（给 `app::Deps.desktop_running`）
pub fn running() -> io::Result<bool> {
    real().running()
}

/// 真实的 `Desktop::quit`（给 `app::Deps.desktop_quit`）：发退出请求并等到全部退出，最多 15 秒
pub fn quit() -> io::Result<()> {
    real().quit()
}

/// 真实的 `Desktop::open`（给 `app::Deps.desktop_open`）：`open -b` 并等到在运行，最多 20 秒
pub fn open() -> io::Result<()> {
    real().open()
}

/// 真实的 `Desktop::info`（给 `app::Deps.desktop_info`），`Info.plist` 按修改时间缓存
pub fn info() -> Option<DesktopInfo> {
    real().info()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const MAIN: &str = "/Applications/Claude.app/Contents/MacOS/Claude";
    const HELPER: &str =
        "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper";
    const HOST: &str = "/Applications/Claude.app/Contents/Helpers/chrome-native-host";
    const CODE_3P: &str =
        "/Users/me/Library/Application Support/Claude-3p/claude-code/2.1.283/claude";
    const CODE_1P: &str = "/Users/me/Library/Application Support/Claude/claude-code/2.1.283/claude";

    /// AC49：表驱动的假 `lsappinfo` / `ps` 输出
    #[test]
    fn running_from_follows_r48() {
        let find = "ASN:0x0-0x1f876857-\"Claude\":\n";
        let cases = [
            (
                "只有 chrome-native-host",
                "",
                format!("812 {HOST}\n"),
                false,
            ),
            ("主进程", "", format!("59664 {MAIN}\n812 {HOST}\n"), true),
            ("只有 Helper", "", format!("59672 {HELPER}\n"), true),
            (
                "只剩 Claude-3p 的内置 Claude Code",
                "",
                format!("901 {CODE_3P}\n"),
                true,
            ),
            (
                "只剩 Claude 的内置 Claude Code",
                "",
                format!("902 {CODE_1P}\n"),
                true,
            ),
            ("lsappinfo 有输出而 ps 为空", find, String::new(), true),
            ("都没有", "", String::new(), false),
            (
                "名字相像的别的应用",
                "",
                "77 /Applications/MyClaude.app/Contents/MacOS/MyClaude\n88 /usr/local/bin/claude\n"
                    .to_owned(),
                false,
            ),
        ];
        for (name, find, ps, want) in cases {
            assert_eq!(running_from(find, &ps), want, "{name}");
        }
    }

    #[test]
    fn chrome_native_host_is_never_a_desktop_process() {
        assert!(!is_desktop_process(HOST));
        assert!(!is_desktop_process(
            "/Users/me/Applications/Claude.app/Contents/Helpers/chrome-native-host"
        ));
        assert!(is_desktop_process(MAIN));
        assert!(!is_desktop_process(""));
    }

    #[test]
    fn desktop_processes_keeps_paths_with_spaces_whole() {
        let got = desktop_processes(&format!(" 59672 {HELPER}\n  901 {CODE_3P}\n812 {HOST}\n"));
        let pids: Vec<u32> = got.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![59672, 901]);
        assert_eq!(got[0].command, HELPER);
    }

    #[test]
    fn parse_lsappinfo_asn_keeps_the_part_lsappinfo_info_accepts() {
        // 本机实测：`ASN:0x0-0x1f876857-` 与整行都能给 `lsappinfo info` 用
        assert_eq!(
            parse_lsappinfo_asn("ASN:0x0-0x1f876857-\"Claude\":\n"),
            Some("ASN:0x0-0x1f876857-")
        );
        assert_eq!(
            parse_lsappinfo_asn("ASN:0x0-0x1f876857-:"),
            Some("ASN:0x0-0x1f876857-")
        );
        assert_eq!(parse_lsappinfo_asn(""), None);
        assert_eq!(parse_lsappinfo_asn("\n"), None);
    }

    #[test]
    fn parse_lsappinfo_pid_reads_the_pid_line() {
        assert_eq!(parse_lsappinfo_pid("\"pid\"=59664\n"), Some(59664));
        assert_eq!(parse_lsappinfo_pid("  \"pid\" = 59664  "), Some(59664));
        assert_eq!(parse_lsappinfo_pid(""), None);
        assert_eq!(parse_lsappinfo_pid("\"pid\"=[ NULL ]"), None);
        assert_eq!(parse_lsappinfo_pid("\"ppid\"=1"), None);
    }

    // ----- 假的系统：进程表随假时钟变化，记下每次调用 -----

    #[derive(Default)]
    struct World {
        /// `lsappinfo` 里登记着（主进程在）
        app: bool,
        /// 其余相关进程（Helper、内置 Claude Code）与无关的 chrome-native-host
        others: Vec<(u32, String)>,
        /// 收到 SIGTERM 后再过几次轮询间隔全部退完；None = 一直不退（在等人确认）
        exits_after: Option<u32>,
        /// `open` 之后再过几次轮询间隔它才在运行；None = 一直起不来
        starts_after: Option<u32>,
        quitting: Option<u32>,
        opening: Option<u32>,
        lsappinfo_fails: bool,
        /// 接下来这么多次 `ps` 失败
        ps_failures: u32,
        /// `lsappinfo info -only pid` 的输出改写成这个
        pid_text: Option<String>,
        terminate_error: Option<String>,
        /// 发信号前主进程刚好自己退了：kill 报「No such process」
        gone_before_signal: bool,
        open_error: Option<String>,
        plist: HashMap<(PathBuf, String), String>,
        elapsed: Duration,
        calls: Vec<String>,
    }

    const PID: u32 = 59664;

    impl World {
        fn running_app() -> Self {
            Self {
                app: true,
                others: vec![
                    (59672, HELPER.into()),
                    (901, CODE_3P.into()),
                    (812, HOST.into()),
                ],
                exits_after: Some(3),
                starts_after: Some(4),
                ..Self::default()
            }
        }

        fn stopped() -> Self {
            Self {
                others: vec![(812, HOST.into())],
                exits_after: Some(3),
                starts_after: Some(4),
                ..Self::default()
            }
        }
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

        fn calls(&self) -> Vec<String> {
            self.w().calls.clone()
        }

        fn elapsed(&self) -> Duration {
            self.w().elapsed
        }

        /// 调用里有几次是这个
        fn count(&self, call: &str) -> usize {
            self.calls().iter().filter(|c| c.as_str() == call).count()
        }
    }

    impl System for Fake {
        fn lsappinfo_find(&self) -> io::Result<String> {
            let mut w = self.w();
            w.calls.push("find".into());
            if w.lsappinfo_fails {
                return Err(io::Error::other("lsappinfo 坏了"));
            }
            Ok(if w.app {
                "ASN:0x0-0x1f876857-\"Claude\":\n".into()
            } else {
                String::new()
            })
        }

        fn lsappinfo_pid(&self, asn: &str) -> io::Result<String> {
            let mut w = self.w();
            w.calls.push("pid".into());
            assert_eq!(asn, "ASN:0x0-0x1f876857-", "按 find 报出的 ASN 查");
            if let Some(text) = &w.pid_text {
                return Ok(text.clone());
            }
            Ok(if w.app {
                format!("\"pid\"={PID}\n")
            } else {
                "\"pid\"=[ NULL ] \n".to_owned()
            })
        }

        fn ps(&self) -> io::Result<String> {
            let mut w = self.w();
            w.calls.push("ps".into());
            if w.ps_failures > 0 {
                w.ps_failures -= 1;
                return Err(io::Error::other("ps 坏了"));
            }
            let mut text = String::new();
            if w.app {
                text.push_str(&format!("{PID} {MAIN}\n"));
            }
            for (pid, exe) in &w.others {
                text.push_str(&format!("{pid:>6} {exe}\n"));
            }
            Ok(text)
        }

        fn terminate(&self, pid: u32) -> io::Result<()> {
            let mut w = self.w();
            w.calls.push(format!("term {pid}"));
            if w.gone_before_signal {
                w.app = false;
                w.others.retain(|(_, exe)| !is_desktop_process(exe));
                return Err(io::Error::other(format!("kill: {pid}: No such process")));
            }
            if let Some(message) = w.terminate_error.clone() {
                return Err(io::Error::other(message));
            }
            w.quitting = w.exits_after;
            if w.quitting.is_none() {
                // 弹了确认框：信号收到了，但谁也不退
                w.quitting = Some(u32::MAX);
            }
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
            if let Some(left) = w.quitting {
                if left <= 1 {
                    w.quitting = None;
                    w.app = false;
                    w.others.retain(|(_, exe)| !is_desktop_process(exe));
                } else if left != u32::MAX {
                    w.quitting = Some(left - 1);
                }
            }
            if let Some(left) = w.opening {
                if left <= 1 {
                    w.opening = None;
                    w.app = true;
                } else if left != u32::MAX {
                    w.opening = Some(left - 1);
                }
            }
        }
    }

    fn desktop(world: World) -> (Desktop<Fake>, Fake) {
        let fake = Fake::new(world);
        (Desktop::new(fake.clone(), Vec::new()), fake)
    }

    #[test]
    fn running_trusts_lsappinfo_and_falls_back_to_ps() {
        let (d, fake) = desktop(World::running_app());
        assert!(d.running().unwrap());
        assert_eq!(fake.calls(), vec!["find"], "lsappinfo 有输出就不再看进程表");

        // lsappinfo 查不成，进程表里有 → 在运行
        let (d, _) = desktop(World {
            lsappinfo_fails: true,
            ..World::running_app()
        });
        assert!(d.running().unwrap());

        // lsappinfo 查不成，进程表里没有 → 拿不准，报错而不是说没在运行
        let (d, _) = desktop(World {
            lsappinfo_fails: true,
            ..World::stopped()
        });
        assert_eq!(d.running().unwrap_err().to_string(), "lsappinfo 坏了");

        // 进程表查不成 → 报错
        let (d, _) = desktop(World {
            ps_failures: 1,
            ..World::stopped()
        });
        assert_eq!(d.running().unwrap_err().to_string(), "ps 坏了");

        // 只有 chrome-native-host → 不在运行
        let (d, _) = desktop(World::stopped());
        assert!(!d.running().unwrap());
    }

    #[test]
    fn quit_sends_one_sigterm_to_the_main_pid_and_waits_for_everything() {
        let (d, fake) = desktop(World::running_app());
        d.quit().unwrap();
        let calls = fake.calls();
        let terms: Vec<&String> = calls.iter().filter(|c| c.starts_with("term")).collect();
        assert_eq!(
            terms,
            vec!["term 59664"],
            "只对主进程发一次 SIGTERM，不碰 Helper"
        );
        assert_eq!(fake.count("sleep"), 3, "等到全部退完才返回");
        assert!(!d.running().unwrap());
        // chrome-native-host 还在，但不算
        assert!(fake.w().others.iter().any(|(pid, _)| *pid == 812));
    }

    #[test]
    fn quit_waits_for_the_bundled_claude_code_too() {
        // 主进程已退，内置 Claude Code 还没退完：不发信号，只等
        let (d, fake) = desktop(World {
            app: false,
            others: vec![(901, CODE_3P.into())],
            quitting: Some(2),
            ..World::stopped()
        });
        d.quit().unwrap();
        assert_eq!(fake.count("term 59664"), 0);
        assert_eq!(fake.count("sleep"), 2);
    }

    #[test]
    fn quit_does_nothing_when_not_running() {
        let (d, fake) = desktop(World::stopped());
        d.quit().unwrap();
        assert!(fake.calls().iter().all(|c| c == "find" || c == "ps"));
    }

    #[test]
    fn quit_times_out_as_busy_without_escalating() {
        let (d, fake) = desktop(World {
            exits_after: None,
            ..World::running_app()
        });
        let err = d.quit().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(err.to_string(), busy_message());
        assert_eq!(fake.count("term 59664"), 1, "超时也不再发信号，更不强杀");
        let waited = fake.elapsed();
        assert!(
            waited >= QUIT_PATIENCE && waited < QUIT_PATIENCE + POLL_INTERVAL,
            "等满 15 秒就停：{waited:?}"
        );
        assert_eq!(
            fake.count("sleep") as u32,
            QUIT_PATIENCE
                .as_millis()
                .div_ceil(POLL_INTERVAL.as_millis()) as u32,
            "每 0.3 秒查一次"
        );
    }

    #[test]
    fn quit_relays_the_kill_error_when_it_is_still_there() {
        let (d, fake) = desktop(World {
            terminate_error: Some("kill: 59664: Operation not permitted".into()),
            ..World::running_app()
        });
        let err = d.quit().unwrap_err();
        assert_eq!(err.to_string(), "kill: 59664: Operation not permitted");
        assert_eq!(fake.count("sleep"), 0, "信号没发出去就不等");
    }

    #[test]
    fn quit_tolerates_the_main_process_exiting_before_the_signal() {
        // lsappinfo 报了 pid，发信号时它已经自己退了：kill 报错，但再问 pid 已为空，不算失败
        let (d, fake) = desktop(World {
            gone_before_signal: true,
            ..World::running_app()
        });
        d.quit().unwrap();
        assert_eq!(fake.count("term 59664"), 1);
        assert_eq!(fake.count("sleep"), 0);
    }

    #[test]
    fn quit_refuses_when_lsappinfo_reports_no_pid() {
        let (d, fake) = desktop(World {
            pid_text: Some("\"pid\"=[ NULL ]".into()),
            ..World::running_app()
        });
        let err = d.quit().unwrap_err();
        assert!(
            err.to_string()
                .contains("没从 lsappinfo 读到 Claude 主进程的 pid"),
            "{err}"
        );
        assert!(fake.calls().iter().all(|c| !c.starts_with("term")));
        assert_eq!(fake.count("sleep"), 0);
    }

    #[test]
    fn open_waits_until_running() {
        let (d, fake) = desktop(World::stopped());
        d.open().unwrap();
        let calls = fake.calls();
        assert_eq!(calls[0], "open", "先发打开，再查");
        assert_eq!(fake.count("sleep"), 4);
        assert!(d.running().unwrap());
    }

    #[test]
    fn open_relays_the_open_error_verbatim_and_does_not_wait() {
        let said =
            "Unable to find application with bundle identifier com.anthropic.claudefordesktop.";
        let (d, fake) = desktop(World {
            open_error: Some(said.into()),
            ..World::stopped()
        });
        assert_eq!(d.open().unwrap_err().to_string(), said);
        assert_eq!(fake.calls(), vec!["open"]);
    }

    #[test]
    fn open_times_out_after_twenty_seconds() {
        let (d, fake) = desktop(World {
            starts_after: None,
            ..World::stopped()
        });
        let err = d.open().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(err.to_string(), "20 秒内没看到 Claude 在运行");
        let waited = fake.elapsed();
        assert!(waited >= OPEN_PATIENCE && waited < OPEN_PATIENCE + POLL_INTERVAL);
    }

    #[test]
    fn wait_rides_over_a_transient_ps_failure() {
        let (d, _) = desktop(World {
            ps_failures: 2,
            ..World::stopped()
        });
        assert!(d.wait_until(false, QUIT_PATIENCE).unwrap());
    }

    #[test]
    fn wait_reports_the_last_error_when_it_never_clears() {
        let (d, _) = desktop(World {
            ps_failures: u32::MAX,
            ..World::stopped()
        });
        assert_eq!(
            d.wait_until(false, Duration::from_secs(1))
                .unwrap_err()
                .to_string(),
            "ps 坏了"
        );
    }

    // ----- 版本与受管偏好：路径指向临时目录 -----

    fn temp_root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn make_app(root: &Path, name: &str) -> (PathBuf, PathBuf) {
        let app = root.join(name).join("Claude.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        let plist = app.join("Contents").join("Info.plist");
        std::fs::write(&plist, "<plist/>").unwrap();
        (app, plist)
    }

    fn set_plist(fake: &Fake, plist: &Path, id: &str, version: &str) {
        let mut w = fake.w();
        w.plist.insert(
            (plist.to_owned(), "CFBundleIdentifier".into()),
            id.to_owned(),
        );
        w.plist.insert(
            (plist.to_owned(), "CFBundleShortVersionString".into()),
            version.to_owned(),
        );
    }

    #[test]
    fn info_takes_the_first_candidate_with_our_bundle_id() {
        let root = temp_root();
        let missing = root.path().join("nowhere").join("Claude.app");
        let (other, other_plist) = make_app(root.path(), "a");
        let (ours, ours_plist) = make_app(root.path(), "b");
        let fake = Fake::new(World::default());
        set_plist(&fake, &other_plist, "com.example.notclaude", "9.9");
        set_plist(&fake, &ours_plist, BUNDLE_ID, "2.9939.4");
        let d = Desktop::new(fake.clone(), vec![missing, other, ours.clone()]);
        assert_eq!(
            d.info(),
            Some(DesktopInfo {
                app_path: ours,
                version: Some("2.9939.4".into())
            })
        );
    }

    #[test]
    fn info_is_none_when_not_installed() {
        let root = temp_root();
        let fake = Fake::new(World::default());
        let d = Desktop::new(fake, vec![root.path().join("Claude.app")]);
        assert_eq!(d.info(), None);
    }

    #[test]
    fn info_keeps_installed_when_the_version_is_unreadable() {
        let root = temp_root();
        let (app, plist) = make_app(root.path(), "a");
        let fake = Fake::new(World::default());
        fake.w()
            .plist
            .insert((plist, "CFBundleIdentifier".into()), BUNDLE_ID.to_owned());
        let d = Desktop::new(fake, vec![app.clone()]);
        assert_eq!(
            d.info(),
            Some(DesktopInfo {
                app_path: app,
                version: None
            })
        );
    }

    #[test]
    fn info_rereads_the_plist_only_when_its_mtime_changes() {
        let root = temp_root();
        let (app, plist) = make_app(root.path(), "a");
        let fake = Fake::new(World::default());
        set_plist(&fake, &plist, BUNDLE_ID, "1.0");
        let d = Desktop::new(fake.clone(), vec![app]);
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        std::fs::File::options()
            .write(true)
            .open(&plist)
            .unwrap()
            .set_modified(t0)
            .unwrap();

        assert_eq!(d.info().unwrap().version.as_deref(), Some("1.0"));
        assert_eq!(d.info().unwrap().version.as_deref(), Some("1.0"));
        assert_eq!(fake.count("plist CFBundleIdentifier"), 1, "没变就用缓存");

        // 应用升级：plist 换了、修改时间变了
        set_plist(&fake, &plist, BUNDLE_ID, "2.0");
        std::fs::File::options()
            .write(true)
            .open(&plist)
            .unwrap()
            .set_modified(t0 + Duration::from_secs(60))
            .unwrap();
        assert_eq!(d.info().unwrap().version.as_deref(), Some("2.0"));
        assert_eq!(fake.count("plist CFBundleIdentifier"), 2);
    }

    #[test]
    fn managed_pref_paths_are_user_then_machine() {
        assert_eq!(
            managed_pref_paths_for("alice"),
            vec![
                PathBuf::from(
                    "/Library/Managed Preferences/alice/com.anthropic.claudefordesktop.plist"
                ),
                PathBuf::from("/Library/Managed Preferences/com.anthropic.claudefordesktop.plist"),
            ]
        );
    }

    #[test]
    fn managed_is_true_when_either_file_exists() {
        let root = temp_root();
        let user = root.path().join("alice").join("p.plist");
        let machine = root.path().join("p.plist");
        let paths = vec![user.clone(), machine.clone()];
        assert!(!managed(&paths));
        std::fs::write(&machine, "").unwrap();
        assert!(managed(&paths));
        std::fs::remove_file(&machine).unwrap();
        std::fs::create_dir_all(user.parent().unwrap()).unwrap();
        std::fs::write(&user, "").unwrap();
        assert!(managed(&paths));
    }
}

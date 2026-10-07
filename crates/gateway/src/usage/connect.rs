//! 「连接 Claude 用量」（票 #208；spec #195「修订」「画板定稿」「修订：代理」；#218 真机核对）：用户点一颗键，
//! Sophia 替他找到（找不到就装好）Claude Code，再运行 `claude auth login` 让他在浏览器里授权，连上后立刻取一次用量。
//!
//! 分三层：
//! - [`Connector`]：过程走到哪（`ConnectState`，托盘与用量页共用一份）、同一时刻只有一个连接、取消回到点之前、
//!   「再打开 ↗」。真实副作用都经 [`ConnectSystem`] 注入，测试用假的；
//! - 起进程的三件事：[`download_installer`]（只认官方地址）、[`run_installer`]（官方安装脚本，15 分钟上限）、
//!   [`run_login`]（`claude auth login`，10 分钟上限，可取消；授权页地址经 `BROWSER` 小脚本交回来）。
//!   都是新进程组、stdin 为空、环境按白名单（[`super::probe::child_env`]）；超时与取消先 SIGTERM 整组，
//!   等 2 秒再 SIGKILL 整组；自己正常退出后也 SIGKILL 整组一次，不留子孙；
//! - [`RealConnect`]：上面几件事接到真实的程序、目录与调度。
//!
//! 令牌由 Claude Code 自己写、自己存，Sophia 不读不存：成功只看进程的退出码与那一句，再看 `.claude.json` 里
//! `oauthAccount` 这一个键在不在（不读值）。授权页地址带一次性的 `state`，只放内存、不写日志、不落盘
//! （小脚本写下的文件读完立刻删）。
use super::probe::{child_env, kill_process_group};
use super::{claude_executables, Account};
use futures_util::future::BoxFuture;
use sophia_core::usage::connect::{
    classify_install, classify_login, login_succeeded, login_timed_out, ConnectFailure,
    ConnectState, FailureKind, INSTALL_TIMEOUT_MINUTES, LOGIN_TIMEOUT_MINUTES,
};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

/// 官方安装入口（https://code.claude.com/docs/en/setup）
pub const INSTALL_URL: &str = "https://claude.ai/install.sh";
/// 官方入口跳到的地方（#218 实测 302 到这里）。只作说明与测试样本：最终地址只要求 https 且主机恰为
/// [`BOOTSTRAP_HOST`]，官方换了路径也照装
pub const BOOTSTRAP_URL: &str = "https://downloads.claude.ai/claude-code-releases/bootstrap.sh";
/// 下载完的最终地址必须在这台主机上（官方下载服务），不认它的子域、也不认别的主机
pub const BOOTSTRAP_HOST: &str = "downloads.claude.ai";

/// 下载安装脚本本身的上限（curl 的 `--max-time` 同值）
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// SIGTERM 之后等进程自己收尾多久，再 SIGKILL（#218：`claude auth login` 收到 SIGTERM 1 秒内退出）
const TERM_GRACE: Duration = Duration::from_secs(2);
/// 登录成功后等首轮取数最多多久：到点也算连上，后面交给调度（这一段不可取消）
pub const CONNECTED_LIMIT: Duration = Duration::from_secs(60);
/// 等授权时多久看一次授权页地址、取消与超时
const POLL: Duration = Duration::from_millis(200);
/// stdout / stderr 各留多少（只为判断与诊断）
const OUTPUT_LIMIT: usize = 16 * 1024;

pub fn login_timeout() -> Duration {
    Duration::from_secs(LOGIN_TIMEOUT_MINUTES * 60)
}

pub fn install_timeout() -> Duration {
    Duration::from_secs(INSTALL_TIMEOUT_MINUTES * 60)
}

// ---------------- 起一个子进程：超时、取消、整组结束 ----------------

/// 一个子进程怎么结束的
#[derive(Debug)]
pub(crate) enum ChildEnd {
    /// 自己退出了；`code` 为 None 是被信号结束
    Exited {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    /// 到点被 Sophia 结束（整组）
    TimedOut { stderr: String },
    /// 用户在 Sophia 里点了取消，被结束（整组）
    Canceled,
}

/// 读管道，最多留 `OUTPUT_LIMIT`；读满之后照样排空，免得对方写阻塞
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(mut pipe: R) -> String {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = OUTPUT_LIMIT.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..room.min(n)]);
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// 读管道的任务最多再等多久（结束整组后还攥着管道的子孙已经被 SIGKILL，正常很快）
async fn join_output(task: tokio::task::JoinHandle<String>) -> String {
    let abort = task.abort_handle();
    match tokio::time::timeout(Duration::from_secs(1), task).await {
        Ok(joined) => joined.unwrap_or_default(),
        Err(_) => {
            abort.abort();
            String::new()
        }
    }
}

/// 起 `program args`：新进程组、stdin 为空、环境整份替换成 `env`、工作目录 `cwd`。
/// 每 [`POLL`] 调一次 `poll`（等授权时看地址），到 `timeout` 或 `cancel` 变真就结束整组
pub(crate) async fn run_child(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    env: &[(String, String)],
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
    mut poll: impl FnMut(),
) -> std::io::Result<ChildEnd> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let pgid = child.id();
    let stdout = tokio::spawn(read_bounded(child.stdout.take().expect("已请求 piped")));
    let stderr = tokio::spawn(read_bounded(child.stderr.take().expect("已请求 piped")));
    let deadline = tokio::time::Instant::now() + timeout;

    enum Stop {
        Timeout,
        Cancel,
    }
    let stop = loop {
        if *cancel.borrow() {
            break Stop::Cancel;
        }
        tokio::select! {
            status = child.wait() => {
                let code = status?.code();
                poll(); // 退出前刚写下的东西（授权页地址）也收一次
                // 组长自己退出了，它留下的后台子孙（安装脚本里的 curl 之类）照样结束整组
                if let Some(pgid) = pgid {
                    kill_process_group(pgid).await;
                }
                return Ok(ChildEnd::Exited {
                    code,
                    stdout: join_output(stdout).await,
                    stderr: join_output(stderr).await,
                });
            }
            _ = tokio::time::sleep(POLL) => {
                poll();
                if tokio::time::Instant::now() >= deadline {
                    break Stop::Timeout;
                }
            }
            changed = cancel.changed() => {
                // 发送端没了（Sophia 在退出）也当取消
                if changed.is_err() || *cancel.borrow() {
                    break Stop::Cancel;
                }
            }
        }
    };
    if let Some(pgid) = pgid {
        terminate_group(pgid, &mut child).await;
    }
    let _ = join_output(stdout).await;
    let stderr = join_output(stderr).await;
    Ok(match stop {
        Stop::Timeout => ChildEnd::TimedOut { stderr },
        Stop::Cancel => ChildEnd::Canceled,
    })
}

/// 结束整组：SIGTERM 整组 → 等组长最多 [`TERM_GRACE`] → SIGKILL 整组（组长先走了、子孙还在的也一并结束）
async fn terminate_group(pgid: u32, child: &mut tokio::process::Child) {
    let _ = Command::new("/bin/kill")
        .args(["-TERM", "--", &format!("-{pgid}")])
        .kill_on_drop(true)
        .output()
        .await;
    let _ = tokio::time::timeout(TERM_GRACE, child.wait()).await;
    kill_process_group(pgid).await;
    let _ = child.wait().await;
}

// ---------------- 安装 ----------------

/// 下载官方安装脚本到 `dest`（不 `curl | bash`：半截脚本也会被执行）。只走 https、最多跳 3 次，
/// 最终地址必须恰好是 [`BOOTSTRAP_URL`]、文件以 bash 的 `#!` 开头，否则删掉、按「安装失败」。
/// 不写死脚本哈希（官方经常更新，#218）；脚本自己只从官方下载服务拉程序并按清单校验
pub(crate) async fn download_installer(
    curl: &Path,
    dest: &Path,
    cwd: &Path,
    env: &[(String, String)],
) -> Result<(), ConnectFailure> {
    let dest_str = dest.to_string_lossy().into_owned();
    let args = [
        // 必须第一个：不读用户的 `~/.curlrc`（里面的设置可能改掉下载行为）
        "-q",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "-fsSL",
        "--max-redirs",
        "3",
        "--connect-timeout",
        "15",
        "--max-time",
        "60",
        "-w",
        "%{url_effective}",
        "-o",
        &dest_str,
        INSTALL_URL,
    ];
    let (_never, mut never) = watch::channel(false);
    let end = run_child(
        curl,
        &args,
        cwd,
        env,
        DOWNLOAD_TIMEOUT + Duration::from_secs(5),
        &mut never,
        || {},
    )
    .await
    .map_err(|e| install_failure(format!("{}: {e}", curl.display())))?;
    let fail = |failure: ConnectFailure| {
        let _ = std::fs::remove_file(dest);
        Err(failure)
    };
    match end {
        ChildEnd::Exited {
            code: Some(0),
            stdout,
            ..
        } => {
            if !official_download(stdout.trim()) {
                log::warn!("安装脚本最终地址不在官方下载服务上，不执行");
                return fail(install_failure(format!(
                    "installer redirected to an unexpected address: {}",
                    stdout.trim()
                )));
            }
            let head = std::fs::read(dest).unwrap_or_default();
            // 只认 bash（#218：脚本用了 bash 的写法）
            let is_bash =
                head.starts_with(b"#!/bin/bash") || head.starts_with(b"#!/usr/bin/env bash");
            if !is_bash {
                return fail(install_failure(
                    "downloaded installer is not a shell script".into(),
                ));
            }
            Ok(())
        }
        ChildEnd::Exited { code, stderr, .. } => fail(classify_install(code, &stderr)),
        ChildEnd::TimedOut { stderr } => fail(classify_install(None, &stderr)),
        ChildEnd::Canceled => fail(classify_install(None, "")),
    }
}

/// 下载的最终地址是官方下载服务吗：https、主机恰为 [`BOOTSTRAP_HOST`]（不带端口、不带账号）。
/// 安全上仍只认官方域名；路径不管（官方换了路径照装）
fn official_download(effective: &str) -> bool {
    let Ok(url) = url::Url::parse(effective) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some(BOOTSTRAP_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// 「安装失败」+ 一句技术原文（Sophia 自己判出来的，不是安装脚本说的）
fn install_failure(detail: String) -> ConnectFailure {
    ConnectFailure::with_detail(FailureKind::Install, detail)
}

/// 运行官方安装脚本：`/bin/bash <脚本>`（不带参数＝latest，同官方文档），不用 sudo。用户不可取消；`cancel`
/// 只在 Sophia 退出时发（[`Connector::shutdown`]）。`timeout` 到点或收到取消就结束整组并删掉
/// `~/.claude/downloads/claude-*` 的半份。退出码 0 算装好（调用方再重新找程序，不假设路径）。
/// 输出里「~/.local/bin is not in your PATH」是从图形界面起的必然提示，不当失败
pub(crate) async fn run_installer(
    bash: &Path,
    script: &Path,
    cwd: &Path,
    env: &[(String, String)],
    home: &Path,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), ConnectFailure> {
    let script = script.to_string_lossy().into_owned();
    let end = run_child(bash, &[&script], cwd, env, timeout, cancel, || {})
        .await
        .map_err(|e| install_failure(format!("{}: {e}", bash.display())))?;
    match end {
        ChildEnd::Exited { code: Some(0), .. } => Ok(()),
        ChildEnd::Exited { code, stderr, .. } => Err(classify_install(code, &stderr)),
        ChildEnd::TimedOut { stderr } => {
            remove_partial_downloads(home);
            Err(classify_install(None, &stderr))
        }
        ChildEnd::Canceled => {
            remove_partial_downloads(home);
            Err(classify_install(None, ""))
        }
    }
}

/// 安装脚本下到一半被结束：删掉 `~/.claude/downloads/` 里它留下的 `claude-*`（只删这一种名字的文件）
fn remove_partial_downloads(home: &Path) {
    let dir = home.join(".claude").join("downloads");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let is_partial = entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with("claude-"))
            && entry.file_type().is_ok_and(|t| t.is_file());
        if is_partial {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------- 登录 ----------------

/// 登录怎么结束的
#[derive(Debug, PartialEq, Eq)]
pub enum LoginEnd {
    /// 退出码 0 + `Login successful.`（调用方再看 `oauthAccount` 复核）
    Succeeded,
    Failed(ConnectFailure),
    /// 用户在 Sophia 里点了取消
    Canceled,
}

/// `BROWSER` 指向的小脚本：把 Claude Code 交给它的授权页地址写进 `url_file`（先写临时名再改名，读的一侧
/// 不会读到半截），不打开浏览器——由 Sophia 校验后自己打开。只用 shell 内建命令与 `/bin/mv`
fn browser_script(url_file: &Path) -> Option<String> {
    let path = url_file.to_str()?;
    // 路径写进单引号里：带单引号的路径不用（临时目录不会有）
    if path.contains('\'') {
        return None;
    }
    Some(format!(
        "#!/bin/sh\numask 077\nprintf '%s' \"$1\" > '{path}.part' && /bin/mv -f '{path}.part' '{path}'\nexit 0\n"
    ))
}

/// 授权页地址可信吗（#218）：https、主机是 `claude.com` 或 `claude.ai`、回调 `redirect_uri` 指向本机
/// `http://localhost:<端口>/callback`。不符就不打开、不给「再打开」
pub fn valid_auth_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw.trim()) else {
        return false;
    };
    if url.scheme() != "https" || !matches!(url.host_str(), Some("claude.com" | "claude.ai")) {
        return false;
    }
    let Some(redirect) = url
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.into_owned())
    else {
        return false;
    };
    let Ok(redirect) = url::Url::parse(&redirect) else {
        return false;
    };
    redirect.scheme() == "http"
        && matches!(redirect.host_str(), Some("localhost" | "127.0.0.1"))
        && redirect.port().is_some()
        && redirect.path() == "/callback"
}

/// 运行 `<program> auth login`：`work` 是 Sophia 自己的 0700 临时目录（放 `BROWSER` 小脚本、做工作目录），
/// `env` 是白名单环境（本函数再加 `BROWSER`）。拿到可信的授权页地址就交给 `on_url`（调用方打开浏览器、留着
/// 给「再打开」）；10 分钟（`timeout`）到点或 `cancel` 就结束整组
pub(crate) async fn run_login(
    program: &Path,
    work: &Path,
    env: &[(String, String)],
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
    mut on_url: impl FnMut(String),
) -> LoginEnd {
    let url_file = work.join("auth-url");
    let helper = work.join("open-browser");
    let Some(script) = browser_script(&url_file) else {
        return LoginEnd::Failed(login_failure("work directory path is not usable".into()));
    };
    if let Err(e) = write_private_executable(&helper, &script) {
        return LoginEnd::Failed(login_failure(format!("{}: {e}", helper.display())));
    }
    let mut env = env.to_vec();
    env.push(("BROWSER".into(), helper.to_string_lossy().into_owned()));

    let mut take_url = || {
        let Ok(url) = std::fs::read_to_string(&url_file) else {
            return;
        };
        let _ = std::fs::remove_file(&url_file);
        if valid_auth_url(&url) {
            on_url(url.trim().to_owned());
        } else {
            log::warn!("Claude Code 交来的授权页地址不认得，不打开");
        }
    };
    let end = run_child(
        program,
        &["auth", "login"],
        work,
        &env,
        timeout,
        cancel,
        &mut take_url,
    )
    .await;
    let _ = std::fs::remove_file(&url_file);
    match end {
        Err(e) => LoginEnd::Failed(login_failure(format!("{}: {e}", program.display()))),
        Ok(ChildEnd::Canceled) => LoginEnd::Canceled,
        Ok(ChildEnd::TimedOut { .. }) => LoginEnd::Failed(login_timed_out()),
        Ok(ChildEnd::Exited {
            code,
            stdout,
            stderr,
        }) => {
            if login_succeeded(code, &stdout) {
                LoginEnd::Succeeded
            } else {
                LoginEnd::Failed(classify_login(code, &stdout, &stderr))
            }
        }
    }
}

/// 写一个只有自己能读写执行的小脚本。写盘交给子进程 `/bin/sh` 做，本进程从不持有它的写句柄：
/// 别的线程同时起子进程会继承写句柄，紧接着执行它偶发 ETXTBSY（测试的假程序 `usage::test_support::write_executable`
/// 也用这一份）
pub(crate) fn write_private_executable(path: &Path, contents: &str) -> std::io::Result<()> {
    let status = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            r#"umask 077 && printf '%s' "$2" > "$1" && chmod 700 "$1""#,
            "sh",
        ])
        .arg(path)
        .arg(contents)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("writing helper: {status}")))
    }
}

fn login_failure(detail: String) -> ConnectFailure {
    ConnectFailure::with_detail(FailureKind::Login, detail)
}

// ---------------- 编排 ----------------

/// 连接要用到的真实副作用（测试换成假的）
pub trait ConnectSystem: Send + Sync + 'static {
    /// 找 Claude Code：命令行候选 → 桌面应用自带的那份（#205），每次现找
    fn find_claude(&self) -> Option<PathBuf>;
    /// 命令行登录了没有（`oauthAccount` 在不在，不读值）
    fn signed_in(&self) -> bool;
    /// 下载并运行官方安装脚本；`cancel` 只在 Sophia 退出时变真（结束整组）
    fn install(&self, cancel: watch::Receiver<bool>) -> BoxFuture<'_, Result<(), ConnectFailure>>;
    /// 运行 `claude auth login`；拿到授权页地址时调 `on_url`
    fn login(
        &self,
        program: PathBuf,
        cancel: watch::Receiver<bool>,
        on_url: Box<dyn FnMut(String) + Send>,
    ) -> BoxFuture<'_, LoginEnd>;
    /// 在默认浏览器里打开授权页（不等浏览器，不阻塞调用方）
    fn open_url(&self, url: &str) -> std::io::Result<()>;
    /// 连上了：立刻取一次用量，取完才返回（这期间界面是 `Finishing`，不闪回连接键；最多等 [`CONNECTED_LIMIT`]）
    fn connected(&self) -> BoxFuture<'_, ()>;
    /// 过程走到了新的一步：交给界面
    fn changed(&self, state: &ConnectState);
}

/// 点「连接 Claude 用量」的结果
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectStart {
    /// 已经开始（找到了程序，或用户确认过安装）
    Started,
    /// 找不到 Claude Code、还没问过：界面先问一句「安装 Claude Code？」，确认后带 `allow_install` 再来
    NeedsInstall,
    /// 已经有一个连接在跑（托盘与用量页共用一份）
    Busy,
}

#[derive(Default)]
struct Inner {
    /// 有一条流程在跑：`start` 持锁时同步占上，流程结束时清掉。判断 Busy 只看它——状态要等后台任务跑起来
    /// 才写成「正在安装 / 等授权」，看状态挡不住紧接着的第二次点
    running: bool,
    state: ConnectState,
    /// 进行中的取消开关（等授权时用户的「取消」、Sophia 退出时的收尾）
    cancel: Option<watch::Sender<bool>>,
    /// 点之前的样子：取消时回到它
    before: ConnectState,
    /// 授权页地址（「再打开 ↗」用）：只在内存里，连接结束就丢
    auth_url: Option<String>,
}

/// 连接过程的状态与遥控。托盘与用量页共用一份（`Arc` 包着放进壳的共享状态）
pub struct Connector<S: ConnectSystem> {
    sys: Arc<S>,
    inner: Arc<Mutex<Inner>>,
}

fn lock(inner: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|p| p.into_inner())
}

impl<S: ConnectSystem> Connector<S> {
    pub fn new(sys: S) -> Self {
        Self {
            sys: Arc::new(sys),
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    /// 此刻走到哪
    pub fn state(&self) -> ConnectState {
        lock(&self.inner).state.clone()
    }

    /// 有一条流程在跑（Sophia 退出时等它收尾用）
    pub fn running(&self) -> bool {
        lock(&self.inner).running
    }

    /// 点「连接 Claude 用量」（或失败后的「再试一次」）。`allow_install`：用户已确认安装；
    /// `force_login`：需要重新登录（命令行登录记录还在、令牌失效），找到程序后不看登录记录、直接登录。
    /// 要在 tokio 运行时里调（过程在后台任务里跑）
    pub fn start(&self, allow_install: bool, force_login: bool) -> ConnectStart {
        let program = self.sys.find_claude();
        let mut inner = lock(&self.inner);
        if inner.running {
            return ConnectStart::Busy;
        }
        if program.is_none() && !allow_install {
            return ConnectStart::NeedsInstall;
        }
        let (cancel_tx, cancel_rx) = watch::channel(false);
        inner.running = true;
        inner.before = inner.state.clone();
        inner.cancel = Some(cancel_tx);
        inner.auth_url = None;
        drop(inner);
        let sys = Arc::clone(&self.sys);
        let shared = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let end = flow(&sys, &shared, program, force_login, cancel_rx).await;
            let mut inner = lock(&shared);
            inner.running = false;
            inner.cancel = None;
            inner.auth_url = None;
            inner.state = match end {
                FlowEnd::Connected => ConnectState::Idle,
                FlowEnd::Failed(failure) => ConnectState::Failed(failure),
                FlowEnd::Canceled => std::mem::take(&mut inner.before),
            };
            let state = inner.state.clone();
            drop(inner);
            sys.changed(&state);
        });
        ConnectStart::Started
    }

    /// Sophia 退出：不论走到哪都发取消——正在装就结束安装脚本整组、正在登录就结束登录。只发信号、不等；
    /// 调用方用 [`Connector::running`] 等它收尾
    pub fn shutdown(&self) {
        if let Some(cancel) = &lock(&self.inner).cancel {
            let _ = cancel.send(true);
        }
    }

    /// 在 Sophia 里点「取消」（等授权时）：结束登录进程，回到点之前的样子。安装中、取首轮用量时不可取消
    /// （画板定稿 4；后者界面上也不给「取消」）
    pub fn cancel(&self) {
        let inner = lock(&self.inner);
        if matches!(inner.state, ConnectState::Waiting { .. }) {
            if let Some(cancel) = &inner.cancel {
                let _ = cancel.send(true);
            }
        }
    }

    /// 「没看到授权页 · 再打开 ↗」：再在浏览器里打开同一个授权页
    pub fn reopen(&self) -> std::io::Result<()> {
        let url = lock(&self.inner).auth_url.clone();
        match url {
            Some(url) => self.sys.open_url(&url),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no sign-in page to reopen",
            )),
        }
    }
}

enum FlowEnd {
    Connected,
    Failed(ConnectFailure),
    Canceled,
}

fn set_state<S: ConnectSystem>(sys: &S, shared: &Mutex<Inner>, state: ConnectState) {
    lock(shared).state = state.clone();
    sys.changed(&state);
}

/// 一次连接：（需要时）安装 →（需要时）登录 → 取一次用量
async fn flow<S: ConnectSystem>(
    sys: &Arc<S>,
    shared: &Arc<Mutex<Inner>>,
    program: Option<PathBuf>,
    force_login: bool,
    cancel: watch::Receiver<bool>,
) -> FlowEnd {
    let program = match program {
        Some(program) => program,
        None => {
            set_state(sys.as_ref(), shared, ConnectState::Installing);
            if let Err(failure) = sys.install(cancel.clone()).await {
                // Sophia 在退出：不记失败
                if *cancel.borrow() {
                    return FlowEnd::Canceled;
                }
                return FlowEnd::Failed(failure);
            }
            // 装好后重新找，不假设装在哪
            match sys.find_claude() {
                Some(program) => program,
                None => {
                    return FlowEnd::Failed(install_failure(
                        "installer finished but Claude Code was not found".into(),
                    ))
                }
            }
        }
    };
    if force_login || !sys.signed_in() {
        set_state(
            sys.as_ref(),
            shared,
            ConnectState::Waiting { reopen: false },
        );
        let on_url = {
            let sys = Arc::clone(sys);
            let shared = Arc::clone(shared);
            Box::new(move |url: String| {
                if let Err(e) = sys.open_url(&url) {
                    log::warn!("打开授权页失败：{e}");
                }
                let mut inner = lock(&shared);
                inner.auth_url = Some(url);
                if matches!(inner.state, ConnectState::Waiting { reopen: false }) {
                    inner.state = ConnectState::Waiting { reopen: true };
                    let state = inner.state.clone();
                    drop(inner);
                    sys.changed(&state);
                }
            })
        };
        match sys.login(program, cancel, on_url).await {
            LoginEnd::Succeeded => {
                // 退出码 0 但登录记录没写下（换完令牌后的校验没过之类）：按连接失败
                if !sys.signed_in() {
                    return FlowEnd::Failed(login_failure(
                        "login reported success but no sign-in record was written".into(),
                    ));
                }
            }
            LoginEnd::Failed(failure) => return FlowEnd::Failed(failure),
            LoginEnd::Canceled => return FlowEnd::Canceled,
        }
    }
    // 取首轮用量：不可取消（登录已经成了，回到点之前不对），最多等 CONNECTED_LIMIT，到点也算连上、交给调度
    set_state(sys.as_ref(), shared, ConnectState::Finishing);
    if tokio::time::timeout(CONNECTED_LIMIT, sys.connected())
        .await
        .is_err()
    {
        log::info!(
            "连上后首轮取数超过 {} 秒，交给调度",
            CONNECTED_LIMIT.as_secs()
        );
    }
    FlowEnd::Connected
}

// ---------------- 真实的 ----------------

/// 安装与登录子进程的环境（见 [`RealConnect`] 的 `env`）：父环境只取白名单，加不自动更新、用户的
/// `CLAUDE_CONFIG_DIR`、补上的代理
pub(crate) fn connect_env(
    parent: Option<&[(String, String)]>,
    config_dir: Option<&Path>,
    proxy: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut extra = vec![("DISABLE_AUTOUPDATER".to_string(), "1".to_string())];
    if let Some(dir) = config_dir {
        extra.push((
            "CLAUDE_CONFIG_DIR".into(),
            dir.to_string_lossy().into_owned(),
        ));
    }
    extra.extend(proxy);
    child_env(parent, &extra)
}

/// 真实的连接：真实的程序、目录与调度。`on_change` 交给界面，`on_connected` 取一次用量（取完才返回）
pub struct RealConnect {
    pub account: Account,
    pub on_change: Box<dyn Fn(&ConnectState) + Send + Sync>,
    pub on_connected: Box<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
}

impl RealConnect {
    /// 子进程的环境：白名单 + 不自动更新 + 用户的 `CLAUDE_CONFIG_DIR`（登录写进哪个 `.claude.json`、成功
    /// 看哪个，必须是同一处）+ 父环境里没有时补上的代理。绝不带 `CLAUDE_CODE_OAUTH_*`、`ANTHROPIC_*`
    /// （`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` 会让它跳过浏览器直接登录，#218）
    async fn env(&self) -> Vec<(String, String)> {
        let parent = self.account.probe_parent_env();
        let proxy = crate::proxy_env::for_child_async(parent.clone()).await;
        connect_env(
            parent.as_deref(),
            self.account.claude_config_dir.as_deref(),
            proxy,
        )
    }

    /// 0700 的临时工作目录（放安装脚本、`BROWSER` 小脚本）：在系统临时目录下（路径不带空格），用完删
    fn work_dir() -> std::io::Result<WorkDir> {
        use std::os::unix::fs::DirBuilderExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("sophia-connect-{}-{nanos}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(WorkDir(dir))
    }
}

/// 用完即删的临时目录
struct WorkDir(PathBuf);

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl ConnectSystem for RealConnect {
    fn find_claude(&self) -> Option<PathBuf> {
        claude_executables().into_iter().next()
    }

    fn signed_in(&self) -> bool {
        self.account.claude_signed_in()
    }

    fn install(
        &self,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'_, Result<(), ConnectFailure>> {
        Box::pin(async move {
            let work = Self::work_dir().map_err(|e| install_failure(e.to_string()))?;
            let env = self.env().await;
            let script = work.0.join("install.sh");
            download_installer(Path::new("/usr/bin/curl"), &script, &work.0, &env).await?;
            let result = run_installer(
                Path::new("/bin/bash"),
                &script,
                &work.0,
                &env,
                &self.account.home,
                install_timeout(),
                &mut cancel,
            )
            .await;
            match &result {
                Ok(()) => log::info!("Claude Code 安装脚本跑完"),
                Err(failure) => log::warn!("Claude Code 安装失败：{:?}", failure.kind),
            }
            result
        })
    }

    fn login(
        &self,
        program: PathBuf,
        mut cancel: watch::Receiver<bool>,
        on_url: Box<dyn FnMut(String) + Send>,
    ) -> BoxFuture<'_, LoginEnd> {
        Box::pin(async move {
            let work = match Self::work_dir() {
                Ok(work) => work,
                Err(e) => return LoginEnd::Failed(login_failure(e.to_string())),
            };
            let env = self.env().await;
            let end = run_login(
                &program,
                &work.0,
                &env,
                login_timeout(),
                &mut cancel,
                on_url,
            )
            .await;
            match &end {
                LoginEnd::Succeeded => log::info!("claude auth login 成功"),
                LoginEnd::Canceled => log::info!("claude auth login 被取消"),
                LoginEnd::Failed(failure) => {
                    log::warn!("claude auth login 失败：{:?}", failure.kind)
                }
            }
            end
        })
    }

    /// 起 `open` 就返回，不等它：调用方可能在异步任务里（`run_child` 的轮询）。退出码由一个线程收
    /// （顺带回收进程），不成功记一行日志
    fn open_url(&self, url: &str) -> std::io::Result<()> {
        let mut child = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        std::thread::spawn(move || match child.wait() {
            Ok(status) if status.success() => {}
            Ok(status) => log::warn!("打开授权页失败：open exited with {status}"),
            Err(e) => log::warn!("打开授权页失败：{e}"),
        });
        Ok(())
    }

    fn connected(&self) -> BoxFuture<'_, ()> {
        (self.on_connected)()
    }

    fn changed(&self, state: &ConnectState) {
        (self.on_change)(state)
    }
}

#[cfg(test)]
mod tests;

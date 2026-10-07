//! 「连接 Claude 用量」的测试：起进程的三件事用冒充的 curl / 安装脚本 / claude（小 shell 脚本）跑真进程，
//! 编排用假的 [`ConnectSystem`]。
use super::*;
use crate::usage::test_support::write_executable;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const AUTH_URL: &str = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A61860%2Fcallback&scope=user%3Ainference&code_challenge=c&code_challenge_method=S256&state=s";

fn temp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    (dir, root)
}

/// 冒充的程序拿到的环境：PATH 带上 `/bin`（脚本里要用 `sleep`），HOME 指向临时目录
fn env_for(root: &Path) -> Vec<(String, String)> {
    child_env(
        Some(&[
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), root.to_string_lossy().into_owned()),
        ]),
        &[("DISABLE_AUTOUPDATER".into(), "1".into())],
    )
}

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    write_executable(&path, &format!("#!/bin/sh\n{body}"));
    path
}

/// 等某个 pid 消失（`kill -0` 失败）
fn gone(pid: &str) -> bool {
    for _ in 0..40 {
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !alive {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn read_when_ready(path: &Path) -> String {
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.trim().is_empty() {
                return text;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    std::fs::read_to_string(path).unwrap_or_default()
}

// ---------------- 授权页地址 ----------------

/// #218：只认 https 的 claude.com / claude.ai，且回调指向本机 `/callback`（粘贴码那一版不认）
#[test]
fn auth_url_must_point_back_to_this_machine() {
    assert!(valid_auth_url(AUTH_URL));
    assert!(valid_auth_url(
        &AUTH_URL.replace("claude.com/cai", "claude.ai")
    ));
    assert!(valid_auth_url(&format!("{AUTH_URL}\n")), "末尾换行不算");
    let manual = AUTH_URL.replace(
        "http%3A%2F%2Flocalhost%3A61860%2Fcallback",
        "https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
    );
    assert!(
        !valid_auth_url(&manual),
        "粘贴码那一版：授权完 Sophia 收不到"
    );
    assert!(!valid_auth_url(&AUTH_URL.replace("https://", "http://")));
    assert!(!valid_auth_url(
        &AUTH_URL.replace("claude.com", "claude.com.evil.example")
    ));
    assert!(
        !valid_auth_url("https://claude.ai/oauth/authorize"),
        "没有回调"
    );
    assert!(!valid_auth_url("not a url"));
}

// ---------------- 下载安装脚本 ----------------

/// 冒充的 curl：把 `body` 写到 `-o` 后的路径，stdout 打印 `effective`（同 `-w '%{url_effective}'`），按 `code` 退出
fn fake_curl(dir: &Path, body: &str, effective: &str, code: i32, stderr: &str) -> PathBuf {
    script(
        dir,
        "curl",
        &format!(
            "out=''\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = -o ]; then out=\"$2\"; fi\n  shift\ndone\nprintf '%s' '{body}' > \"$out\"\nprintf '%s' '{effective}'\nprintf '%s' '{stderr}' >&2\nexit {code}\n"
        ),
    )
}

fn run<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Runtime::new().unwrap().block_on(fut)
}

#[test]
fn download_accepts_only_the_official_bootstrap_script() {
    run(async {
        let (_d, root) = temp();
        let dest = root.join("install.sh");
        let curl = fake_curl(&root, "#!/bin/bash\necho hi\n", BOOTSTRAP_URL, 0, "");
        download_installer(&curl, &dest, &root, &env_for(&root))
            .await
            .unwrap();
        assert!(dest.is_file());
    });
}

/// curl 第一个参数是 `-q`（不读用户的 `~/.curlrc`）；最终地址放宽到「https 且主机恰为 downloads.claude.ai」
/// （官方换了跳转路径也照装），`#!/usr/bin/env bash` 也认
#[test]
fn download_ignores_curlrc_and_accepts_any_path_on_the_official_host() {
    run(async {
        let (_d, root) = temp();
        let dest = root.join("install.sh");
        let curl = script(
            &root,
            "curl",
            &format!(
                "printf '%s\\n' \"$@\" > '{r}/args'\nout=''\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = -o ]; then out=\"$2\"; fi\n  shift\ndone\nprintf '%s' '#!/usr/bin/env bash' > \"$out\"\nprintf '%s' 'https://downloads.claude.ai/claude-code-releases/v2/bootstrap.sh'\n",
                r = root.display()
            ),
        );
        download_installer(&curl, &dest, &root, &env_for(&root))
            .await
            .unwrap();
        let args = std::fs::read_to_string(root.join("args")).unwrap();
        assert_eq!(args.lines().next(), Some("-q"), "-q 必须是第一个参数");
        assert!(dest.is_file());
    });
}

#[test]
fn download_refuses_other_addresses_and_non_scripts() {
    run(async {
        let (_d, root) = temp();
        let dest = root.join("install.sh");
        let curl = fake_curl(
            &root,
            "#!/bin/bash\n",
            "https://evil.example/bootstrap.sh",
            0,
            "",
        );
        let failure = download_installer(&curl, &dest, &root, &env_for(&root))
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Install);
        assert!(failure.detail.unwrap().contains("evil.example"));
        assert!(!dest.exists(), "不认的就删掉");

        let curl = fake_curl(&root, "<html>blocked</html>", BOOTSTRAP_URL, 0, "");
        let failure = download_installer(&curl, &dest, &root, &env_for(&root))
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Install);
        assert!(!dest.exists());

        // 主机名只差一点、或不是 https：都不认
        for effective in [
            "https://downloads.claude.ai.evil.example/bootstrap.sh",
            "https://evil.downloads.claude.ai/bootstrap.sh",
            "http://downloads.claude.ai/claude-code-releases/bootstrap.sh",
            "not a url",
        ] {
            let curl = fake_curl(&root, "#!/bin/bash\n", effective, 0, "");
            let failure = download_installer(&curl, &dest, &root, &env_for(&root))
                .await
                .unwrap_err();
            assert_eq!(failure.kind, FailureKind::Install, "{effective}");
            assert!(!dest.exists(), "{effective}");
        }

        // 只认 bash：`#!/bin/sh` 不认（安装脚本用了 bash 的写法，sh 跑会走样）
        let curl = fake_curl(&root, "#!/bin/sh\necho hi\n", BOOTSTRAP_URL, 0, "");
        let failure = download_installer(&curl, &dest, &root, &env_for(&root))
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Install);
        assert!(!dest.exists());
    });
}

/// curl 连不上：按 curl 的退出码与原文认成「网络不通」
#[test]
fn download_network_error_is_classified() {
    run(async {
        let (_d, root) = temp();
        let dest = root.join("install.sh");
        let curl = fake_curl(
            &root,
            "",
            "",
            6,
            "curl: (6) Could not resolve host: claude.ai",
        );
        let failure = download_installer(&curl, &dest, &root, &env_for(&root))
            .await
            .unwrap_err();
        assert_eq!(failure.kind, FailureKind::InstallNetwork);
        assert_eq!(
            failure.detail.as_deref(),
            Some("curl: (6) Could not resolve host: claude.ai")
        );
    });
}

// ---------------- 运行安装脚本 ----------------

#[test]
fn installer_success_and_failure() {
    run(async {
        let (_d, root) = temp();
        let bash = Path::new("/bin/sh");
        let ok = script(
            &root,
            "ok.sh",
            "echo 'Native installation exists but ~/.local/bin is not in your PATH'\nexit 0\n",
        );
        run_installer(
            bash,
            &ok,
            &root,
            &env_for(&root),
            &root,
            crate::test_timing::CHILD_OK,
            &mut watch::channel(false).1,
        )
        .await
        .unwrap();
        let net = script(
            &root,
            "net.sh",
            "echo 'curl: (7) Failed to connect to 127.0.0.1 port 9' >&2\nexit 7\n",
        );
        let failure = run_installer(
            bash,
            &net,
            &root,
            &env_for(&root),
            &root,
            crate::test_timing::CHILD_OK,
            &mut watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.kind, FailureKind::InstallNetwork);
        let busy = script(
            &root,
            "busy.sh",
            "echo 'Could not install - another process is currently installing Claude.' >&2\nexit 1\n",
        );
        let failure = run_installer(
            bash,
            &busy,
            &root,
            &env_for(&root),
            &root,
            crate::test_timing::CHILD_OK,
            &mut watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.kind, FailureKind::Install);
        assert!(failure.detail.unwrap().contains("another process"));
    });
}

/// 安装脚本自己正常退出、却留下了后台子孙：也结束整组，不留进程
#[test]
fn installer_normal_exit_still_ends_leftover_children() {
    run(async {
        let (_d, root) = temp();
        let leaves = script(
            &root,
            "leaves.sh",
            &format!(
                "sleep 100 &\necho $! > '{r}/child.pid'\nexit 0\n",
                r = root.display()
            ),
        );
        let (_tx, mut cancel) = watch::channel(false);
        run_installer(
            Path::new("/bin/sh"),
            &leaves,
            &root,
            &env_for(&root),
            &root,
            crate::test_timing::CHILD_OK,
            &mut cancel,
        )
        .await
        .unwrap();
        assert!(
            gone(&read_when_ready(&root.join("child.pid"))),
            "正常退出后留下的子孙也结束"
        );
    });
}

/// Sophia 退出时给安装发取消：结束整组（含子孙），删掉下到一半的程序
#[test]
fn installer_cancel_kills_the_group() {
    run(async {
        let (_d, root) = temp();
        let downloads = root.join(".claude").join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let hang = script(
            &root,
            "hang.sh",
            &format!(
                "echo $$ > '{r}/self.pid'\n: > '{d}/claude-2.1.290-darwin-arm64'\nsleep 100 &\necho $! > '{r}/child.pid'\nwait\n",
                r = root.display(),
                d = downloads.display()
            ),
        );
        let (tx, mut cancel) = watch::channel(false);
        let pid_file = root.join("child.pid");
        let canceller = tokio::spawn(async move {
            for _ in 0..200 {
                if pid_file.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let _ = tx.send(true);
            tx
        });
        let result = run_installer(
            Path::new("/bin/sh"),
            &hang,
            &root,
            &env_for(&root),
            &root,
            crate::test_timing::CHILD_OK,
            &mut cancel,
        )
        .await;
        let _tx = canceller.await.unwrap();
        assert!(result.is_err());
        assert!(gone(&read_when_ready(&root.join("self.pid"))));
        assert!(
            gone(&read_when_ready(&root.join("child.pid"))),
            "子孙也结束"
        );
        assert!(!downloads.join("claude-2.1.290-darwin-arm64").exists());
    });
}

/// 网络卡住：到点结束整组（含子孙），删掉下到一半的程序，按「网络不通」；兄弟文件不碰
#[test]
fn installer_timeout_kills_the_group_and_removes_partial_download() {
    run(async {
        let (_d, root) = temp();
        let downloads = root.join(".claude").join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("keep.txt"), "别碰我").unwrap();
        let hang = script(
            &root,
            "hang.sh",
            &format!(
                "echo $$ > '{r}/self.pid'\n: > '{d}/claude-2.1.290-darwin-arm64'\nsleep 100 &\necho $! > '{r}/child.pid'\nwait\n",
                r = root.display(),
                d = downloads.display()
            ),
        );
        let started = Instant::now();
        let failure = run_installer(
            Path::new("/bin/sh"),
            &hang,
            &root,
            &env_for(&root),
            &root,
            Duration::from_millis(500),
            &mut watch::channel(false).1,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.kind, FailureKind::InstallNetwork);
        assert!(
            started.elapsed()
                < Duration::from_millis(500) + TERM_GRACE + crate::test_timing::KILL_SLACK
        );
        assert!(gone(&read_when_ready(&root.join("self.pid"))));
        assert!(
            gone(&read_when_ready(&root.join("child.pid"))),
            "子孙也结束"
        );
        assert!(!downloads.join("claude-2.1.290-darwin-arm64").exists());
        assert!(downloads.join("keep.txt").exists());
    });
}

// ---------------- claude auth login ----------------

/// 冒充的 `claude`：先把授权页地址交给 `$BROWSER`（同真 Claude Code），再按 `rest` 收尾
fn fake_claude(dir: &Path, rest: &str) -> PathBuf {
    script(
        dir,
        "claude",
        &format!(
            "[ \"$1 $2\" = 'auth login' ] || exit 64\nprintf '%s|%s' \"$DISABLE_AUTOUPDATER\" \"${{CLAUDE_CODE_OAUTH_REFRESH_TOKEN-unset}}\" > env.marker\necho 'Opening browser to sign in…'\n\"$BROWSER\" '{AUTH_URL}'\n{rest}"
        ),
    )
}

#[test]
fn login_success_hands_over_the_auth_url() {
    run(async {
        let (_d, root) = temp();
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let claude = fake_claude(&root, "sleep 0.3\necho 'Login successful.'\nexit 0\n");
        let (_tx, mut cancel) = watch::channel(false);
        let mut urls = Vec::new();
        let end = run_login(
            &claude,
            &work,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |url| urls.push(url),
        )
        .await;
        assert_eq!(end, LoginEnd::Succeeded);
        assert_eq!(urls, vec![AUTH_URL.to_string()], "只交一次，原样");
        assert!(!work.join("auth-url").exists(), "地址读完就删，不落盘");
        assert_eq!(
            std::fs::read_to_string(work.join("env.marker")).unwrap(),
            "1|unset",
            "不自动更新；身份变量不带"
        );
    });
}

#[test]
fn login_denied_in_browser() {
    run(async {
        let (_d, root) = temp();
        let claude = fake_claude(
            &root,
            "echo 'Login failed: No authorization code received' >&2\nexit 1\n",
        );
        let (_tx, mut cancel) = watch::channel(false);
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |_| {},
        )
        .await;
        assert_eq!(
            end,
            LoginEnd::Failed(ConnectFailure {
                kind: FailureKind::LoginDenied,
                detail: Some("Login failed: No authorization code received".into()),
            })
        );
    });
}

/// 错误只写在 stdout、stderr 是空的：照 stdout 分类
#[test]
fn login_error_on_stdout_only_is_classified() {
    run(async {
        let (_d, root) = temp();
        let claude = fake_claude(
            &root,
            "echo 'Login failed: connect ETIMEDOUT 160.79.104.10:443'\nexit 1\n",
        );
        let (_tx, mut cancel) = watch::channel(false);
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |_| {},
        )
        .await;
        assert!(
            matches!(&end, LoginEnd::Failed(f) if f.kind == FailureKind::LoginNetwork),
            "{end:?}"
        );
    });
}

/// 旧版 Claude Code 没有 `auth login`：「版本太旧，更新后再试」
#[test]
fn login_on_old_claude_code_says_update() {
    run(async {
        let (_d, root) = temp();
        let claude = script(
            &root,
            "claude",
            "echo \"error: unknown command 'auth'\" >&2\nexit 1\n",
        );
        let (_tx, mut cancel) = watch::channel(false);
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |_| {},
        )
        .await;
        assert!(
            matches!(&end, LoginEnd::Failed(f) if f.kind == FailureKind::LoginOutdated),
            "{end:?}"
        );
    });
}

/// 退出码 0 却没说成功：不算连上
#[test]
fn login_exit_zero_without_success_line_is_a_failure() {
    run(async {
        let (_d, root) = temp();
        let claude = fake_claude(&root, "exit 0\n");
        let (_tx, mut cancel) = watch::channel(false);
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |_| {},
        )
        .await;
        assert!(matches!(end, LoginEnd::Failed(f) if f.kind == FailureKind::Login));
    });
}

/// 交来的地址不认得：不交给调用方（不打开、不给「再打开」），照常等
#[test]
fn login_ignores_untrusted_url() {
    run(async {
        let (_d, root) = temp();
        let claude = script(
            &root,
            "claude",
            "\"$BROWSER\" 'https://evil.example/authorize'\necho 'Login successful.'\nexit 0\n",
        );
        let (_tx, mut cancel) = watch::channel(false);
        let mut urls = Vec::new();
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |url| urls.push(url),
        )
        .await;
        assert_eq!(end, LoginEnd::Succeeded);
        assert!(urls.is_empty());
    });
}

/// 10 分钟（这里缩短）没授权：结束整组，含子孙；按「超时」
#[test]
fn login_timeout_ends_the_whole_group() {
    run(async {
        let (_d, root) = temp();
        let claude = fake_claude(
            &root,
            &format!(
                "echo $$ > '{r}/self.pid'\nsleep 100 &\necho $! > '{r}/child.pid'\nwait\n",
                r = root.display()
            ),
        );
        let (_tx, mut cancel) = watch::channel(false);
        let started = Instant::now();
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            Duration::from_millis(600),
            &mut cancel,
            |_| {},
        )
        .await;
        assert_eq!(end, LoginEnd::Failed(login_timed_out()));
        assert!(
            started.elapsed()
                < Duration::from_millis(600) + TERM_GRACE + crate::test_timing::KILL_SLACK
        );
        assert!(gone(&read_when_ready(&root.join("self.pid"))));
        assert!(gone(&read_when_ready(&root.join("child.pid"))));
    });
}

/// 在 Sophia 里点取消：SIGTERM 整组，不留子进程；不算失败
#[test]
fn login_cancel_ends_the_whole_group() {
    run(async {
        let (_d, root) = temp();
        let claude = fake_claude(
            &root,
            &format!(
                "echo $$ > '{r}/self.pid'\nsleep 100 &\necho $! > '{r}/child.pid'\nwait\n",
                r = root.display()
            ),
        );
        let (tx, mut cancel) = watch::channel(false);
        let pid_file = root.join("child.pid");
        let canceller = tokio::spawn(async move {
            for _ in 0..200 {
                if pid_file.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let _ = tx.send(true);
            tx
        });
        let end = run_login(
            &claude,
            &root,
            &env_for(&root),
            crate::test_timing::CHILD_OK,
            &mut cancel,
            |_| {},
        )
        .await;
        let _tx = canceller.await.unwrap();
        assert_eq!(end, LoginEnd::Canceled);
        assert!(gone(&read_when_ready(&root.join("self.pid"))));
        assert!(gone(&read_when_ready(&root.join("child.pid"))));
    });
}

// ---------------- 子进程的环境 ----------------

/// 安装与登录子进程：白名单 + 不自动更新 + 用户的 CLAUDE_CONFIG_DIR + 补上的代理；
/// 会改变身份的变量（`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` 会跳过浏览器直接登录）一个都不带
#[test]
fn connect_env_is_allowlisted() {
    let env = connect_env(
        Some(&[
            ("HOME".into(), "/Users/u".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("CLAUDE_CODE_OAUTH_REFRESH_TOKEN".into(), "leaked".into()),
            ("ANTHROPIC_API_KEY".into(), "leaked".into()),
            ("CLAUDE_CONFIG_DIR".into(), "/wrong".into()),
        ]),
        Some(Path::new("/Users/u/.config/claude")),
        vec![("HTTPS_PROXY".into(), "http://127.0.0.1:7897".into())],
    );
    let get = |k: &str| {
        env.iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(get("DISABLE_AUTOUPDATER"), Some("1"));
    assert_eq!(get("CLAUDE_CONFIG_DIR"), Some("/Users/u/.config/claude"));
    assert_eq!(get("HTTPS_PROXY"), Some("http://127.0.0.1:7897"));
    assert_eq!(get("HOME"), Some("/Users/u"));
    assert!(get("PATH").unwrap().starts_with("/usr/bin:/bin"));
    assert_eq!(get("CLAUDE_CODE_OAUTH_REFRESH_TOKEN"), None);
    assert_eq!(get("ANTHROPIC_API_KEY"), None);
    assert_eq!(
        env.iter().filter(|(k, _)| k == "CLAUDE_CONFIG_DIR").count(),
        1,
        "只有账号的那一份"
    );
    let without = connect_env(Some(&[]), None, Vec::new());
    assert!(!without.iter().any(|(k, _)| k == "CLAUDE_CONFIG_DIR"));
}

/// 调试版的测试主目录：安装与登录子进程带 `CLAUDE_CONFIG_DIR=<测试主目录>/.claude`，
/// 登录写进带后缀的钥匙串条目，不改写开发者自己的命令行登录
#[test]
fn test_home_account_gives_children_its_own_config_dir() {
    let (_d, home) = temp();
    let account = Account::in_home(&home);
    let env = connect_env(
        account.probe_parent_env().as_deref(),
        account.claude_config_dir.as_deref(),
        Vec::new(),
    );
    let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    assert_eq!(
        get("CLAUDE_CONFIG_DIR"),
        Some(home.join(".claude").to_string_lossy().into_owned())
    );
    assert_eq!(get("HOME"), Some(home.to_string_lossy().into_owned()));
}

// ---------------- 编排 ----------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LoginPlan {
    Succeed,
    Fail(FailureKind),
    WaitForCancel,
}

struct Fake {
    installed: Mutex<bool>,
    signed_in: Mutex<bool>,
    /// 登录成功后写不写登录记录
    writes_record: bool,
    install_result: Option<FailureKind>,
    /// 安装一直不结束，直到收到取消（Sophia 退出）
    install_hangs: bool,
    /// 首轮取数一直不回来
    connected_hangs: bool,
    login_plan: LoginPlan,
    installs: AtomicUsize,
    logins: AtomicUsize,
    connects: AtomicUsize,
    opened: Mutex<Vec<String>>,
    states: Mutex<Vec<ConnectState>>,
}

impl Fake {
    fn new(installed: bool, signed_in: bool, login_plan: LoginPlan) -> Self {
        Self {
            installed: Mutex::new(installed),
            signed_in: Mutex::new(signed_in),
            writes_record: true,
            install_result: None,
            install_hangs: false,
            connected_hangs: false,
            login_plan,
            installs: AtomicUsize::new(0),
            logins: AtomicUsize::new(0),
            connects: AtomicUsize::new(0),
            opened: Mutex::new(Vec::new()),
            states: Mutex::new(Vec::new()),
        }
    }
}

impl ConnectSystem for Fake {
    fn find_claude(&self) -> Option<PathBuf> {
        (*self.installed.lock().unwrap()).then(|| PathBuf::from("/fake/claude"))
    }
    fn signed_in(&self) -> bool {
        *self.signed_in.lock().unwrap()
    }
    fn install(
        &self,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'_, Result<(), ConnectFailure>> {
        Box::pin(async move {
            self.installs.fetch_add(1, Ordering::SeqCst);
            if self.install_hangs {
                while !*cancel.borrow() {
                    if cancel.changed().await.is_err() {
                        break;
                    }
                }
                return Err(classify_install(None, ""));
            }
            match self.install_result {
                Some(kind) => Err(ConnectFailure { kind, detail: None }),
                None => {
                    *self.installed.lock().unwrap() = true;
                    Ok(())
                }
            }
        })
    }
    fn login(
        &self,
        _program: PathBuf,
        mut cancel: watch::Receiver<bool>,
        mut on_url: Box<dyn FnMut(String) + Send>,
    ) -> BoxFuture<'_, LoginEnd> {
        Box::pin(async move {
            self.logins.fetch_add(1, Ordering::SeqCst);
            on_url(AUTH_URL.to_string());
            match self.login_plan {
                LoginPlan::Succeed => {
                    if self.writes_record {
                        *self.signed_in.lock().unwrap() = true;
                    }
                    LoginEnd::Succeeded
                }
                LoginPlan::Fail(kind) => LoginEnd::Failed(ConnectFailure { kind, detail: None }),
                LoginPlan::WaitForCancel => {
                    while !*cancel.borrow() {
                        if cancel.changed().await.is_err() {
                            break;
                        }
                    }
                    LoginEnd::Canceled
                }
            }
        })
    }
    fn open_url(&self, url: &str) -> std::io::Result<()> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn connected(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.connects.fetch_add(1, Ordering::SeqCst);
            if self.connected_hangs {
                std::future::pending::<()>().await;
            }
        })
    }
    fn changed(&self, state: &ConnectState) {
        self.states.lock().unwrap().push(state.clone());
    }
}

/// 等连接跑完（不在装、不在等授权）
async fn settle<S: ConnectSystem>(c: &Connector<S>) -> ConnectState {
    for _ in 0..500 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(2)).await;
        let state = c.state();
        if !state.in_flight() && !c.running() {
            return state;
        }
    }
    panic!("连接一直没跑完：{:?}", c.state());
}

/// 找不到 Claude Code、用户还没确认：先问一句，什么都不动
#[tokio::test]
async fn not_found_asks_before_installing() {
    let c = Connector::new(Fake::new(false, false, LoginPlan::Succeed));
    assert_eq!(c.start(false, false), ConnectStart::NeedsInstall);
    assert_eq!(c.state(), ConnectState::Idle);
    assert_eq!(c.sys.installs.load(Ordering::SeqCst), 0);
    assert!(c.sys.states.lock().unwrap().is_empty());
}

/// 确认安装后：正在安装 → 等授权 → 拿到地址（打开浏览器、可再打开）→ 连上（取一次用量）→ 回到没在连接
#[tokio::test]
async fn install_then_login_then_fetch() {
    let c = Connector::new(Fake::new(false, false, LoginPlan::Succeed));
    assert_eq!(c.start(true, false), ConnectStart::Started);
    assert_eq!(settle(&c).await, ConnectState::Idle);
    assert_eq!(
        *c.sys.states.lock().unwrap(),
        vec![
            ConnectState::Installing,
            ConnectState::Waiting { reopen: false },
            ConnectState::Waiting { reopen: true },
            ConnectState::Finishing,
            ConnectState::Idle,
        ]
    );
    assert_eq!(*c.sys.opened.lock().unwrap(), vec![AUTH_URL.to_string()]);
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 1);
    assert!(c.reopen().is_err(), "连完了，地址不留");
}

/// 找到了、也登录着（命令行登录了却一时没找到程序，后来找到了）：不装、不登录，直接取用量
#[tokio::test]
async fn found_and_signed_in_just_fetches() {
    let c = Connector::new(Fake::new(true, true, LoginPlan::Succeed));
    assert_eq!(c.start(false, false), ConnectStart::Started);
    assert_eq!(settle(&c).await, ConnectState::Idle);
    assert_eq!(c.sys.installs.load(Ordering::SeqCst), 0);
    assert_eq!(c.sys.logins.load(Ordering::SeqCst), 0);
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 1);
}

/// 需要重新登录：登录记录还在也要登录
#[tokio::test]
async fn force_login_logs_in_even_when_signed_in() {
    let c = Connector::new(Fake::new(true, true, LoginPlan::Succeed));
    c.start(false, true);
    settle(&c).await;
    assert_eq!(c.sys.logins.load(Ordering::SeqCst), 1);
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 1);
}

/// 安装失败：停在失败，不去登录
#[tokio::test]
async fn install_failure_stops_before_login() {
    let mut fake = Fake::new(false, false, LoginPlan::Succeed);
    fake.install_result = Some(FailureKind::InstallNetwork);
    let c = Connector::new(fake);
    c.start(true, false);
    assert_eq!(
        settle(&c).await,
        ConnectState::Failed(ConnectFailure {
            kind: FailureKind::InstallNetwork,
            detail: None
        })
    );
    assert_eq!(c.sys.logins.load(Ordering::SeqCst), 0);
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn login_failure_is_kept_until_next_click() {
    let c = Connector::new(Fake::new(
        true,
        false,
        LoginPlan::Fail(FailureKind::LoginDenied),
    ));
    c.start(false, false);
    let failed = settle(&c).await;
    assert!(matches!(&failed, ConnectState::Failed(f) if f.kind == FailureKind::LoginDenied));
    // 「再试一次」从头再走
    assert_eq!(c.start(false, false), ConnectStart::Started);
    settle(&c).await;
    assert_eq!(c.sys.logins.load(Ordering::SeqCst), 2);
}

/// 退出码 0 但登录记录没写下：按连接失败，不取用量
#[tokio::test]
async fn login_without_record_is_a_failure() {
    let mut fake = Fake::new(true, false, LoginPlan::Succeed);
    fake.writes_record = false;
    let c = Connector::new(fake);
    c.start(false, false);
    assert!(matches!(settle(&c).await, ConnectState::Failed(f) if f.kind == FailureKind::Login));
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 0);
}

/// 等授权时：再打开同一个地址；同一时刻只有一个连接；在 Sophia 里点取消回到点之前的样子（不算失败）
#[tokio::test]
async fn waiting_can_reopen_and_cancel_back_to_before() {
    let c = Connector::new(Fake::new(
        true,
        false,
        LoginPlan::Fail(FailureKind::LoginTimeout),
    ));
    c.start(false, false);
    let before = settle(&c).await;
    assert!(matches!(before, ConnectState::Failed(_)));

    let c = Connector {
        sys: Arc::new(Fake::new(true, false, LoginPlan::WaitForCancel)),
        inner: Arc::clone(&c.inner),
    };
    assert_eq!(c.start(false, false), ConnectStart::Started);
    for _ in 0..200 {
        if c.state() == (ConnectState::Waiting { reopen: true }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(c.state(), ConnectState::Waiting { reopen: true });
    assert_eq!(c.start(true, false), ConnectStart::Busy);
    c.reopen().unwrap();
    assert_eq!(
        c.sys.opened.lock().unwrap().len(),
        2,
        "打开一次 + 再打开一次"
    );
    c.cancel();
    assert_eq!(settle(&c).await, before, "回到点之前的样子");
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 0);
}

/// 安装中不可取消（画板定稿 4）
#[tokio::test]
async fn cancel_does_nothing_while_installing() {
    let c = Connector::new(Fake::new(false, false, LoginPlan::Succeed));
    lock(&c.inner).state = ConnectState::Installing;
    let (tx, rx) = watch::channel(false);
    lock(&c.inner).cancel = Some(tx);
    c.cancel();
    assert!(!*rx.borrow());
}

/// 连续点两次（托盘与用量页先后点、或回话后马上再点）：后台任务还没把状态写成「正在安装 / 等授权」，
/// 第二次也回 Busy，只起一条流程
#[tokio::test]
async fn second_start_is_busy_even_before_the_flow_runs() {
    let c = Connector::new(Fake::new(true, true, LoginPlan::Succeed));
    assert_eq!(c.start(false, false), ConnectStart::Started);
    assert_eq!(c.state(), ConnectState::Idle, "后台任务还没跑");
    assert_eq!(c.start(false, false), ConnectStart::Busy);
    assert_eq!(c.start(true, true), ConnectStart::Busy);
    settle(&c).await;
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 1, "只取了一次");
    // 跑完之后可以再点
    assert_eq!(c.start(false, false), ConnectStart::Started);
    settle(&c).await;
}

/// 第二次点不会顶掉第一条流程的取消开关：第一条照常等授权，不被当成取消
#[tokio::test]
async fn second_start_does_not_cancel_the_first_flow() {
    let c = Connector::new(Fake::new(true, false, LoginPlan::WaitForCancel));
    assert_eq!(c.start(false, false), ConnectStart::Started);
    assert_eq!(c.start(false, false), ConnectStart::Busy);
    for _ in 0..200 {
        if c.state() == (ConnectState::Waiting { reopen: true }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        c.state(),
        ConnectState::Waiting { reopen: true },
        "第一条还在等授权"
    );
    assert_eq!(c.sys.logins.load(Ordering::SeqCst), 1);
    c.cancel();
    assert_eq!(settle(&c).await, ConnectState::Idle);
}

/// Sophia 退出：给正在跑的安装发取消（安装中用户点取消不起作用，退出不一样），流程按取消收尾
#[tokio::test]
async fn shutdown_cancels_a_running_install() {
    let mut fake = Fake::new(false, false, LoginPlan::Succeed);
    fake.install_hangs = true;
    let c = Connector::new(fake);
    assert_eq!(c.start(true, false), ConnectStart::Started);
    for _ in 0..200 {
        if c.state() == ConnectState::Installing {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    c.cancel();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        c.state(),
        ConnectState::Installing,
        "用户的取消在安装中不起作用"
    );
    c.shutdown();
    assert_eq!(
        settle(&c).await,
        ConnectState::Idle,
        "按取消收尾、回到点之前"
    );
    assert_eq!(c.sys.logins.load(Ordering::SeqCst), 0);
}

/// 登录成功后等首轮取数有上限：到点也算连上、交给调度；这一段「取消」不起作用，界面也不给「取消」
#[tokio::test(start_paused = true)]
async fn first_fetch_after_login_is_capped_and_not_cancelable() {
    let mut fake = Fake::new(true, false, LoginPlan::Succeed);
    fake.connected_hangs = true;
    let c = Connector::new(fake);
    assert_eq!(c.start(false, false), ConnectStart::Started);
    for _ in 0..200 {
        if c.state() == ConnectState::Finishing {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(c.state(), ConnectState::Finishing);
    c.cancel();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(c.state(), ConnectState::Finishing, "取消不起作用");
    tokio::time::sleep(CONNECTED_LIMIT).await;
    assert_eq!(settle(&c).await, ConnectState::Idle, "到点算连上");
    assert_eq!(c.sys.connects.load(Ordering::SeqCst), 1);
}

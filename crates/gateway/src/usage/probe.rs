//! 隔离起一次进程做问答式探测（R8）：清空环境只留白名单，工作目录必须是空目录（不存在就建，
//! 有东西就拒绝——绝不删用户文件），子进程降到后台优先级，按行发 stdin、按行读 stdout 解析成
//! JSON，遇到满足条件的一行就收工：关 stdin、等它自己退出，超时就整个进程组一起结束。
//!
//! `claude`/`codex` 的具体协议（`initialize` → `get_usage` 之类）不在这里，那是
//! `usage::claude` / `usage::codex`（T6）的事；这里只管「干净地跑一次」。
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, Command};
use tokio::time::Instant;

/// 传给子进程的环境变量白名单：够它自己正常跑起来（找库、找语言环境、写临时文件），
/// 但不带任何会改变身份或行为的变量。`extra_env` 里显式传的（比如 Codex 的 `CODEX_HOME`）
/// 是另外加的，不在这张表里也会被带上——但绝不会是 `CLAUDE_*`/`ANTHROPIC_*`/`OPENAI_*`/`CODEX_*`
/// 这类调用方本该显式选择的变量。
const ENV_ALLOWLIST: [&str; 17] = [
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "PATH",
    // 代理与证书：只影响怎么连网、不改变身份；清掉的话靠环境变量代理的用户会一直超时（2026-09-29 代码评审）
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
];

/// `taskpolicy` 的真实位置：Apple 文档和大多数第三方参考写的是 `/usr/bin`，但实测（本机、
/// Darwin 25.5）在 `/usr/sbin`。两个都试，都没有就直接起原程序——子进程仍能跑，只是没被降优先级。
const TASKPOLICY_CANDIDATES: [&str; 2] = ["/usr/bin/taskpolicy", "/usr/sbin/taskpolicy"];

/// 起一次探测要交代的东西
pub struct ProbeSpec {
    /// 可执行文件的路径（由 `claude_executables()` / `codex_executables()` 选出）
    pub program: PathBuf,
    pub args: Vec<String>,
    /// 工作目录：必须是空目录，不存在会被创建，有东西会被拒绝（不删用户文件）
    pub working_dir: PathBuf,
    /// 按顺序写给子进程的整行；每行后面补一个 `\n`。这批探测都不依赖对方的中间回复
    /// （`initialize` 的请求号是固定的，不用等它答完再发下一条），所以一次性写完，
    /// 不用等一行、发一行
    pub stdin_lines: Vec<String>,
    /// 白名单之外要额外带上的变量（比如 Codex 的 `CODEX_HOME`）
    pub extra_env: Vec<(String, String)>,
    /// 覆盖「父进程环境」：为空时读真实的 `std::env`；测试传一份显式的表，不用碰真实进程环境，
    /// 才能在 CI 上并行跑也不互相踩
    pub parent_env: Option<Vec<(String, String)>>,
    /// 从发完 stdin 到必须等到满足条件的一行为止的时长；等不到就整个进程组一起结束
    pub timeout: Duration,
    /// 停止条件：stdout 的某一行解析成 JSON 后满足它，就不再往下读
    pub until: Box<dyn Fn(&Value) -> bool + Send + Sync>,
}

/// 一次探测的结果
#[derive(Debug)]
pub struct ProbeOutput {
    /// 满足 `until` 的那一行；`None` 表示进程自己先退出了（EOF），一直没等到
    pub matched: Option<Value>,
    /// 读到的所有能解析成 JSON 的行，按到达顺序（含 `matched` 那一行）
    pub lines: Vec<Value>,
    /// 解析失败、被忽略的行数（只计数，不保留内容——stdout 可能带账号数据，R8 不留痕）
    pub non_json_lines: usize,
    pub elapsed: Duration,
    /// 子进程的退出码；被我们结束（超时，或等不到自愿退出）时为 `None`
    pub exit_status: Option<i32>,
    /// stderr 的前 4 KiB，只供诊断；同样不假设内容不含账号信息，调用方展示前自己把关
    pub stderr_tail: String,
}

/// 探测失败的种类
#[derive(Debug)]
pub enum ProbeError {
    /// 工作目录不是空目录：拒绝执行，绝不清空或删除里面的东西
    WorkingDirNotEmpty(PathBuf),
    /// 起不来这个程序
    Spawn(std::io::Error),
    /// 读写管道出的错（不是超时）
    Io(std::io::Error),
    /// 到 `timeout` 还没等到满足条件的一行；进程组已经被结束
    Timeout {
        elapsed: Duration,
        stderr_tail: String,
    },
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::WorkingDirNotEmpty(dir) => {
                let dir = dir.display();
                write!(
                    f,
                    "{}",
                    sophia_core::t!("usage.probe.dirNotEmpty", dir = dir)
                )
            }
            ProbeError::Spawn(e) => {
                write!(
                    f,
                    "{}",
                    sophia_core::t!("usage.probe.spawnFailed", error = e)
                )
            }
            ProbeError::Io(e) => {
                write!(f, "{}", sophia_core::t!("usage.probe.ioFailed", error = e))
            }
            ProbeError::Timeout { elapsed, .. } => {
                let seconds = format!("{:.1}", elapsed.as_secs_f64());
                write!(
                    f,
                    "{}",
                    sophia_core::t!("usage.probe.timeout", seconds = seconds)
                )
            }
        }
    }
}

impl std::error::Error for ProbeError {}

/// 关 stdin 之后，最多再等子进程自愿退出多久，超时才动手 kill（正常收工路径，不是探测超时）
const GRACEFUL_EXIT_WAIT: Duration = Duration::from_secs(3);

/// 进程组已经结束（或已自行退出）之后，最多再等 stderr 读完多久
const STDERR_JOIN_WAIT: Duration = Duration::from_secs(1);

/// 起一次隔离的探测。行为见模块文档
pub async fn run_probe(spec: ProbeSpec) -> Result<ProbeOutput, ProbeError> {
    prepare_working_dir(&spec.working_dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => {
            ProbeError::WorkingDirNotEmpty(spec.working_dir.clone())
        }
        _ => ProbeError::Io(e),
    })?;

    let env = build_child_env(&spec);
    let mut command = match taskpolicy_path() {
        // 降优先级选 taskpolicy 包一层而不是 `pre_exec` + `setpriority`：
        // tokio::process::Command 在 unix 上没有暴露 `pre_exec`（那是 std 那边
        // `unix::process::CommandExt` 的方法，得自己 unsafe 拼），taskpolicy 是系统自带的
        // 命令行工具，效果一样（`setpriority(2)` 加 `PRIO_DARWIN_BG`）且不用 unsafe；
        // 找不到就直接起原程序——子进程仍能跑，只是没被降优先级，不是硬性前提
        Some(taskpolicy) => {
            let mut c = Command::new(taskpolicy);
            c.arg("-b").arg(&spec.program).args(&spec.args);
            c
        }
        None => {
            let mut c = Command::new(&spec.program);
            c.args(&spec.args);
            c
        }
    };
    command
        .current_dir(&spec.working_dir)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0); // 0 表示新建一个组，组号就是子进程自己的 pid（tokio 文档）

    let start = Instant::now();
    let mut child = command.spawn().map_err(ProbeError::Spawn)?;
    // process_group(0) 保证组号等于子进程 pid：taskpolicy 的子孙（真正的 claude/codex，
    // 以及它们自己再起的东西）默认继承同一个组，killpg 能一网打尽
    let pgid = child.id();

    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("已请求 piped stdout");
    let stderr = child.stderr.take().expect("已请求 piped stderr");
    let stderr_task = tokio::spawn(read_stderr_bounded(stderr));

    if let Some(handle) = stdin.as_mut() {
        for line in &spec.stdin_lines {
            if handle.write_all(line.as_bytes()).await.is_err() {
                break; // 对方可能已经提前退出，后面的读循环会看到 EOF 或超时，不在这里报错
            }
            let _ = handle.write_all(b"\n").await;
        }
        let _ = handle.flush().await;
    }

    let mut reader = BufReader::new(stdout).lines();
    let mut lines = Vec::new();
    let mut matched = None;
    let mut non_json_lines = 0usize;
    let deadline = start + spec.timeout;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            if let Some(pgid) = pgid {
                kill_process_group(pgid).await;
            }
            let stderr_tail = join_stderr(stderr_task).await;
            return Err(ProbeError::Timeout {
                elapsed: start.elapsed(),
                stderr_tail,
            });
        }
        match tokio::time::timeout(remaining, reader.next_line()).await {
            Ok(Ok(Some(line))) => match serde_json::from_str::<Value>(&line) {
                Ok(value) => {
                    let is_match = (spec.until)(&value);
                    lines.push(value.clone());
                    if is_match {
                        matched = Some(value);
                        break;
                    }
                }
                Err(_) => non_json_lines += 1,
            },
            Ok(Ok(None)) => break, // 对方自己关了 stdout：没等到就是没等到，不算错误
            Ok(Err(e)) => {
                if let Some(pgid) = pgid {
                    kill_process_group(pgid).await;
                }
                return Err(ProbeError::Io(e));
            }
            Err(_elapsed) => {
                if let Some(pgid) = pgid {
                    kill_process_group(pgid).await;
                }
                let stderr_tail = join_stderr(stderr_task).await;
                return Err(ProbeError::Timeout {
                    elapsed: start.elapsed(),
                    stderr_tail,
                });
            }
        }
    }

    drop(stdin.take()); // 关 stdin：还卡在读一行的对方会看到 EOF，借机自己退出
    let exit_status = match tokio::time::timeout(GRACEFUL_EXIT_WAIT, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => {
            if let Some(pgid) = pgid {
                kill_process_group(pgid).await;
            }
            None
        }
    };

    Ok(ProbeOutput {
        matched,
        lines,
        non_json_lines,
        elapsed: start.elapsed(),
        exit_status,
        stderr_tail: join_stderr(stderr_task).await,
    })
}

/// 等 stderr 读完，但有期限：结束进程组万一没成功，还活着的子孙攥着 stderr 不放，
/// 不能让整次探测（和后面的调度循环）跟着永远等下去。到期就放弃诊断内容
async fn join_stderr(task: tokio::task::JoinHandle<String>) -> String {
    let abort = task.abort_handle();
    match tokio::time::timeout(STDERR_JOIN_WAIT, task).await {
        Ok(joined) => joined.unwrap_or_default(),
        Err(_) => {
            abort.abort();
            String::new()
        }
    }
}

/// stderr 只读前 4 KiB，只为诊断；读满之后继续把管道排空（不然对方写阻塞），但不再保留内容
async fn read_stderr_bounded(mut stderr: ChildStderr) -> String {
    const LIMIT: usize = 4 * 1024;
    let mut kept = Vec::with_capacity(LIMIT);
    let mut chunk = [0u8; 1024];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = LIMIT.saturating_sub(kept.len());
                if room > 0 {
                    kept.extend_from_slice(&chunk[..room.min(n)]);
                }
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// 工作目录必须存在且为空。不存在就创建；存在但非空，报 `AlreadyExists`（`run_probe` 翻译成
/// `WorkingDirNotEmpty`）；绝不清空、绝不删里面的东西
fn prepare_working_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "探测目录不是空的", // i18n-exempt: 诊断信息，界面只显示 reason()
                ));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir_all(dir),
        Err(e) => Err(e),
    }
}

fn taskpolicy_path() -> Option<&'static str> {
    TASKPOLICY_CANDIDATES
        .iter()
        .copied()
        .find(|p| Path::new(p).is_file())
}

/// 白名单环境 + 显式的 extra_env。`PATH` 单独处理：见 [`augmented_path`]
fn build_child_env(spec: &ProbeSpec) -> Vec<(String, String)> {
    let parent: HashMap<String, String> = match &spec.parent_env {
        Some(map) => map.iter().cloned().collect(),
        None => std::env::vars().collect(),
    };
    let home = parent
        .get("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));

    let mut env = Vec::new();
    for key in ENV_ALLOWLIST {
        if key == "PATH" {
            env.push((
                "PATH".to_owned(),
                augmented_path(parent.get("PATH").map(String::as_str), &home),
            ));
        } else if let Some(value) = parent.get(key) {
            env.push((key.to_owned(), value.clone()));
        }
    }
    env.extend(spec.extra_env.iter().cloned());
    env
}

/// 子进程的 PATH：登录 shell 问到的那份（spec S16）、父进程看到的那份，再补上找程序用的几个兜底目录——
/// 从 Dock 启动时缺的就是这些。去重保序，与 `claude_executables()` 同一份算法
fn augmented_path(parent_path: Option<&str>, home: &Path) -> String {
    let login = crate::login_env::current().and_then(|env| env.path);
    std::env::join_paths(crate::login_env::resolved_path_from(
        login.as_deref(),
        parent_path,
        home,
    ))
    .map(|joined| joined.to_string_lossy().into_owned())
    .unwrap_or_default()
}

/// 结束整个进程组（自己加子孙），SIGKILL 直接来，不留后路。用 `/bin/kill` 而不是 `libc::killpg`：
/// 跟 `crate::process::terminate` 一样的理由——不为一次系统调用引入新依赖。到这一步已经是
/// 补救路径：正常收工前已经给过关 stdin、等 3 秒自愿退出的机会
async fn kill_process_group(pgid: u32) {
    let _ = Command::new("/bin/kill")
        // `--` 不能省：Linux 的 procps kill 会把 `-<pgid>` 当成选项解析、直接报错不发信号
        // （CI 上三个超时测试因此挂住）；macOS 的 kill 也认 `--`
        .args(["-9", "--", &format!("-{pgid}")])
        .kill_on_drop(true)
        .output()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::test_support::write_executable;
    use std::time::Duration as StdDuration;

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        write_executable(&path, body);
        path
    }

    fn temp_probe_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let working_dir = base.join("probe");
        (root, working_dir)
    }

    fn base_spec(program: PathBuf, working_dir: PathBuf) -> ProbeSpec {
        ProbeSpec {
            program,
            args: Vec::new(),
            working_dir,
            stdin_lines: Vec::new(),
            extra_env: Vec::new(),
            parent_env: Some(Vec::new()),
            timeout: crate::test_timing::CHILD_OK,
            until: Box::new(|_| true),
        }
    }

    /// 逐行回信的脚本：每读到一行就回一个带序号的 JSON；stop 条件在第 2 条就满足时，
    /// 第 3 条不会被我们读到——但仍应该已经写给了对方（对方在收到 EOF 前会把三行都读完，
    /// 并把读到的条数记到工作目录里的文件，用它验证 stdin 确实全送到了）
    #[test]
    fn delivers_stdin_and_stops_at_the_matching_line() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, working_dir) = temp_probe_dir();
            let scripts = tempfile::tempdir().unwrap();
            let program = write_script(
                scripts.path(),
                "echo.sh",
                "#!/bin/sh\nn=0\nwhile IFS= read -r line; do\n  n=$((n+1))\n  echo \"{\\\"type\\\":\\\"reply\\\",\\\"n\\\":$n}\"\ndone\necho \"$n\" > stdin_count\n",
            );
            let mut spec = base_spec(program, working_dir.clone());
            spec.stdin_lines = vec!["a".into(), "b".into(), "c".into()];
            spec.until = Box::new(|v| v.get("n") == Some(&Value::from(2)));

            let output = run_probe(spec).await.expect("探测应该成功");
            assert_eq!(output.matched, Some(serde_json::json!({"type":"reply","n":2})));
            assert_eq!(output.lines.len(), 2, "命中就不再往下读");
            assert_eq!(output.non_json_lines, 0);

            let count = std::fs::read_to_string(working_dir.join("stdin_count")).unwrap();
            assert_eq!(count.trim(), "3", "三行 stdin 都该送到，即便我们只读了前两条回复");
        });
    }

    /// 从来不回信、还起了一个孙子进程的脚本：到超时必须在 timeout + 1s 内返回错误，
    /// 且脚本自己和孙子进程都不能再存在
    #[test]
    fn timeout_kills_the_whole_process_group_including_grandchildren() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, working_dir) = temp_probe_dir();
            let scripts = tempfile::tempdir().unwrap();
            let program = write_script(
                scripts.path(),
                "silent.sh",
                "#!/bin/sh\necho $$ > self_pid\nsleep 100 &\necho $! > child_pid\nwhile IFS= read -r line; do :; done\n",
            );
            let mut spec = base_spec(program, working_dir.clone());
            spec.timeout = StdDuration::from_millis(300);
            spec.until = Box::new(|_| false);

            let started = Instant::now();
            let err = run_probe(spec).await.expect_err("应该超时");
            assert!(matches!(err, ProbeError::Timeout { .. }));
            assert!(
                started.elapsed() < StdDuration::from_millis(300) + crate::test_timing::KILL_SLACK,
                "应该在 timeout 后很快返回，不等满脚本里的 sleep 100"
            );

            // 脚本把自己和孙子的 pid 写进了工作目录；等它们真的消失（kill -0 失败）
            let self_pid = wait_for_file(&working_dir.join("self_pid")).await;
            let child_pid = wait_for_file(&working_dir.join("child_pid")).await;
            assert!(
                wait_until_gone(self_pid.trim()).await,
                "脚本自己应该被结束"
            );
            assert!(
                wait_until_gone(child_pid.trim()).await,
                "孙子进程（sleep 100）应该跟着一起被结束"
            );
        });
    }

    async fn wait_for_file(path: &Path) -> String {
        for _ in 0..20 {
            if let Ok(text) = std::fs::read_to_string(path) {
                if !text.trim().is_empty() {
                    return text;
                }
            }
            tokio::time::sleep(StdDuration::from_millis(50)).await;
        }
        std::fs::read_to_string(path).unwrap_or_default()
    }

    async fn wait_until_gone(pid: &str) -> bool {
        for _ in 0..20 {
            let alive = Command::new("/bin/kill")
                .args(["-0", pid])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !alive {
                return true;
            }
            tokio::time::sleep(StdDuration::from_millis(50)).await;
        }
        false
    }

    /// 正式回复前先吐几行噪音（不是 JSON）：应该被忽略并计数，不影响命中那一行
    #[test]
    fn ignores_non_json_noise_before_the_json_line() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, working_dir) = temp_probe_dir();
            let scripts = tempfile::tempdir().unwrap();
            let program = write_script(
                scripts.path(),
                "noisy.sh",
                "#!/bin/sh\necho 'hello this is not json'\necho 'neither is this: {broken'\necho '{\"type\":\"reply\",\"n\":1}'\n",
            );
            let mut spec = base_spec(program, working_dir);
            spec.until = Box::new(|v| v.get("n") == Some(&Value::from(1)));

            let output = run_probe(spec).await.expect("探测应该成功");
            assert_eq!(output.matched, Some(serde_json::json!({"type":"reply","n":1})));
            assert_eq!(output.lines, vec![serde_json::json!({"type":"reply","n":1})]);
            assert_eq!(output.non_json_lines, 2);
        });
    }

    /// 父进程环境里带着 CLAUDE_CODE_FOO、ANTHROPIC_BASE_URL 这类会改变身份的变量，
    /// 子进程的环境转储里必须一个都看不到；HOME/USER/PATH 这些白名单变量要在，
    /// PATH 还要带上兜底目录
    #[test]
    fn child_env_is_allowlisted_only() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, working_dir) = temp_probe_dir();
            let scripts = tempfile::tempdir().unwrap();
            let program = write_script(
                scripts.path(),
                "dump_env.sh",
                "#!/bin/sh\nprintf '{'\nfirst=1\nenv | while IFS='=' read -r key value; do\n  if [ \"$first\" -eq 1 ]; then first=0; else printf ','; fi\n  printf '\"%s\":\"%s\"' \"$key\" \"$value\"\ndone\nprintf '}\\n'\n",
            );
            let home = working_dir.parent().unwrap().join("fake-home");
            std::fs::create_dir_all(&home).unwrap();
            let mut spec = base_spec(program, working_dir);
            spec.parent_env = Some(vec![
                ("HOME".into(), home.to_string_lossy().into_owned()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("USER".into(), "tester".into()),
                ("CLAUDE_CODE_FOO".into(), "leaked".into()),
                ("ANTHROPIC_BASE_URL".into(), "leaked".into()),
                ("OPENAI_API_KEY".into(), "leaked".into()),
                ("CODEX_API_KEY".into(), "leaked".into()),
                ("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into()),
                ("no_proxy".into(), "localhost".into()),
                ("NODE_EXTRA_CA_CERTS".into(), "/etc/ca.pem".into()),
            ]);
            spec.until = Box::new(|_| true);

            let output = run_probe(spec).await.expect("探测应该成功");
            let env = output.matched.expect("应该有一行输出");
            let env = env.as_object().unwrap();

            assert_eq!(env.get("HOME").unwrap(), &home.to_string_lossy().to_string());
            assert_eq!(env.get("USER").unwrap(), "tester");
            let path = env.get("PATH").unwrap().as_str().unwrap();
            assert!(path.starts_with("/usr/bin:/bin"));
            assert!(path.contains("/opt/homebrew/bin"), "PATH 应该带上兜底目录");

            // 代理与证书只影响怎么连网、不改变身份：放行（2026-09-29 代码评审：靠环境变量代理的用户会一直超时）
            assert_eq!(env.get("HTTPS_PROXY").unwrap(), "http://127.0.0.1:7890");
            assert_eq!(env.get("no_proxy").unwrap(), "localhost");
            assert_eq!(env.get("NODE_EXTRA_CA_CERTS").unwrap(), "/etc/ca.pem");
            for leaked in ["CLAUDE_CODE_FOO", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY"] {
                assert!(env.get(leaked).is_none(), "{leaked} 不应该出现在子进程环境里");
            }
        });
    }

    /// 工作目录已存在且非空：拒绝，不删任何东西
    #[test]
    fn refuses_non_empty_working_dir() {
        let (_root, working_dir) = temp_probe_dir();
        std::fs::create_dir_all(&working_dir).unwrap();
        std::fs::write(working_dir.join("leftover"), "别碰我").unwrap();

        let err = prepare_working_dir(&working_dir).expect_err("非空目录应该被拒绝");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read_to_string(working_dir.join("leftover")).unwrap(),
            "别碰我",
            "拒绝之后原有文件必须原封不动"
        );
    }

    /// 工作目录不存在：应该被创建出来，且是空的
    #[test]
    fn creates_missing_working_dir() {
        let (_root, working_dir) = temp_probe_dir();
        assert!(!working_dir.exists());

        prepare_working_dir(&working_dir).expect("应该能创建");
        assert!(working_dir.is_dir());
        assert_eq!(std::fs::read_dir(&working_dir).unwrap().count(), 0);
    }
}

//! 管理一个每用户级的 launchd LaunchAgent，让某个程序（路由）在后台常驻。
//!
//! 移植自 agents-manager 的 `internal/service`（同一作者的 Go 项目，已在真实环境验证）。
//! 全部副作用都经 `Manager::run` 注入，测试用假实现，从不调用真实的 `launchctl`。
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// launchctl 的绝对路径：后台进程的 PATH 由 launchd 决定，不能靠 PATH 查找
const LAUNCHCTL: &str = "/bin/launchctl";

/// 描述要安装的 LaunchAgent。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spec {
    /// launchd 的服务标签，例如 "com.zhengjiaqiao.symsync.gateway"。
    pub label: String,
    /// 可执行文件的绝对路径。
    pub program: String,
    /// 传给 program 的额外参数。
    pub args: Vec<String>,
    /// 非空时，标准输出与标准错误都写到这个文件。
    pub log_path: Option<String>,
    /// 启动后进程的环境变量；按 key 排序写入。
    pub env: BTreeMap<String, String>,
    /// 这项后台服务属于哪个应用（应用的 bundle identifier）。写成 `AssociatedBundleIdentifiers`
    /// （`man launchd.plist`）：系统的「后台活动」通知与「登录项与扩展」据此显示应用名和图标，
    /// 不写就只能显示可执行文件名（产品负责人：通知里写的是 symsync）
    pub associated_bundle: Option<String>,
}

/// `plist` 校验失败的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlistError(pub String);

impl fmt::Display for PlistError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PlistError {}

impl From<PlistError> for io::Error {
    fn from(e: PlistError) -> Self {
        io::Error::new(io::ErrorKind::InvalidInput, e.0)
    }
}

/// 把 spec 渲染成 launchd 的属性列表（plist）文本。
pub fn plist(spec: &Spec) -> Result<String, PlistError> {
    if spec.label.is_empty() {
        return Err(PlistError("service: label must not be empty".into()));
    }
    if spec.program.is_empty() {
        return Err(PlistError("service: program must not be empty".into()));
    }
    if !spec.program.starts_with('/') {
        return Err(PlistError(format!(
            "service: program must be an absolute path, got {:?}",
            spec.program
        )));
    }

    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
    );
    out.push_str("<plist version=\"1.0\">\n<dict>\n");

    write_key_string(&mut out, 1, "Label", &spec.label);
    if let Some(bundle) = spec.associated_bundle.as_deref().filter(|b| !b.is_empty()) {
        write_key_string(&mut out, 1, "AssociatedBundleIdentifiers", bundle);
    }

    out.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");
    write_element(&mut out, 2, "string", &spec.program);
    for arg in &spec.args {
        write_element(&mut out, 2, "string", arg);
    }
    out.push_str("\t</array>\n");

    write_key_bool(&mut out, 1, "RunAtLoad", true);
    write_key_bool(&mut out, 1, "KeepAlive", true);
    write_key_int(&mut out, 1, "ThrottleInterval", 5);
    write_key_string(&mut out, 1, "ProcessType", "Background");

    if let Some(log_path) = spec.log_path.as_deref().filter(|p| !p.is_empty()) {
        write_key_string(&mut out, 1, "StandardOutPath", log_path);
        write_key_string(&mut out, 1, "StandardErrorPath", log_path);
    }

    if !spec.env.is_empty() {
        out.push_str("\t<key>EnvironmentVariables</key>\n\t<dict>\n");
        for (k, v) in &spec.env {
            write_key_string(&mut out, 2, k, v);
        }
        out.push_str("\t</dict>\n");
    }

    out.push_str("</dict>\n</plist>\n");
    Ok(out)
}

fn indent(level: usize) -> String {
    "\t".repeat(level)
}

/// 与 Go `encoding/xml.EscapeText` 逐字节一致的转义规则。
fn escape_text(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\t' => out.push_str("&#x9;"),
            '\n' => out.push_str("&#xA;"),
            '\r' => out.push_str("&#xD;"),
            c => out.push(c),
        }
    }
}

fn write_element(out: &mut String, level: usize, tag: &str, value: &str) {
    out.push_str(&indent(level));
    out.push('<');
    out.push_str(tag);
    out.push('>');
    escape_text(out, value);
    out.push_str("</");
    out.push_str(tag);
    out.push_str(">\n");
}

fn write_key_string(out: &mut String, level: usize, key: &str, value: &str) {
    write_element(out, level, "key", key);
    write_element(out, level, "string", value);
}

fn write_key_bool(out: &mut String, level: usize, key: &str, value: bool) {
    write_element(out, level, "key", key);
    out.push_str(&indent(level));
    out.push_str(if value { "<true/>\n" } else { "<false/>\n" });
}

fn write_key_int(out: &mut String, level: usize, key: &str, value: i64) {
    write_element(out, level, "key", key);
    out.push_str(&format!("{}<integer>{}</integer>\n", indent(level), value));
}

/// launchd LaunchAgent 的磁盘与运行时状态。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    /// plist 文件是否存在于磁盘上。
    pub installed: bool,
    /// launchd 当前是否已知晓这个服务。
    pub loaded: bool,
    /// 正在运行的进程 id；未运行为 0。
    pub pid: u32,
    /// launchd 报告的上一次退出状态（例如 "0" 或 "(never exited)"）；未知为 `None`。
    pub last_exit: Option<String>,
}

/// 安装、卸载、查询一个每用户级 launchd LaunchAgent。
///
/// 全部副作用都经 `run` 完成，测试可以换成假实现，不必调用真实的 launchctl。
pub struct Manager {
    /// plist 文件写入的目录，通常是 `~/Library/LaunchAgents`。
    pub launch_agents_dir: PathBuf,
    /// 用来拼 launchctl 的 `gui/<uid>[/<label>]` 目标。
    pub uid: u32,
    /// 执行外部命令，返回合并后的 stdout+stderr、退出码，以及启动/运行失败（超时、
    /// 找不到可执行文件等）时的错误。退出码非零本身不算错误。
    pub run: Runner,
}

/// 执行一次外部命令：`name` 是可执行文件，`args` 是参数；返回合并后的 stdout+stderr
/// 与退出码，启动/运行本身失败（超时、找不到可执行文件等）时返回 `Err`。
pub type Runner = Box<dyn Fn(&str, &[&str]) -> io::Result<(String, i32)> + Send + Sync>;

/// launchctl 在服务未加载时打印的、不区分大小写的特征子串。
const NOT_LOADED_MARKERS: [&str; 3] = ["could not find", "no such process", "not loaded"];

fn looks_not_loaded(stdout: &str) -> bool {
    let lower = stdout.to_ascii_lowercase();
    NOT_LOADED_MARKERS.iter().any(|m| lower.contains(m))
}

impl Manager {
    pub fn plist_path(&self, label: &str) -> PathBuf {
        self.launch_agents_dir.join(format!("{label}.plist"))
    }

    fn domain_target(&self) -> String {
        format!("gui/{}", self.uid)
    }

    fn service_target(&self, label: &str) -> String {
        format!("gui/{}/{}", self.uid, label)
    }

    /// launchd 当前是否已加载这个服务，经 `launchctl print`。
    fn is_loaded(&self, label: &str) -> io::Result<bool> {
        let target = self.service_target(label);
        let (_, code) = (self.run)(LAUNCHCTL, &["print", &target])?;
        Ok(code == 0)
    }

    /// 卸载服务；服务本来就没加载时容忍失败。
    fn bootout(&self, label: &str) -> io::Result<()> {
        let target = self.service_target(label);
        let (stdout, code) = (self.run)(LAUNCHCTL, &["bootout", &target])?;
        if code != 0 && !looks_not_loaded(&stdout) {
            return Err(io::Error::other(format!(
                "launchctl bootout {label} failed with exit code {code}: {stdout}"
            )));
        }
        Ok(())
    }

    /// 把 spec 的 plist 写到磁盘并确保已加载。
    ///
    /// 磁盘上已有逐字节相同的 plist 且 launchd 已加载：什么都不做。
    /// plist 未变但服务未加载（例如用户手动停用过）：重新 bootstrap。
    /// 否则：先加载则 bootout（容忍“未加载”失败）→ 覆盖 plist → bootstrap。
    pub fn install(&self, spec: &Spec) -> io::Result<()> {
        let data = plist(spec)?;

        let path = self.plist_path(&spec.label);
        let existing = fs::read_to_string(&path).ok();
        let unchanged = existing.as_deref() == Some(data.as_str());

        let loaded = self.is_loaded(&spec.label)?;
        if unchanged && loaded {
            return Ok(());
        }

        if !unchanged {
            write_file_atomic(&path, data.as_bytes(), 0o644)?;
        }

        if loaded {
            self.bootout(&spec.label)?;
        }

        let domain = self.domain_target();
        let path_str = path.to_string_lossy().into_owned();
        let (stdout, code) = (self.run)(LAUNCHCTL, &["bootstrap", &domain, &path_str])?;
        if code != 0 {
            return Err(io::Error::other(format!(
                "launchctl bootstrap {} failed with exit code {code}: {stdout}",
                spec.label
            )));
        }
        Ok(())
    }

    /// 卸载服务（容忍“未加载”失败）并删除其 plist（容忍“不存在”失败）。
    pub fn uninstall(&self, label: &str) -> io::Result<()> {
        self.bootout(label)?;
        match fs::remove_file(self.plist_path(label)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// 报告 label 的 plist 与 launchd 状态。
    pub fn status(&self, label: &str) -> io::Result<Status> {
        let mut status = Status::default();

        match fs::metadata(self.plist_path(label)) {
            Ok(_) => status.installed = true,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }

        let target = self.service_target(label);
        let (stdout, code) = (self.run)(LAUNCHCTL, &["print", &target])?;
        if code != 0 {
            return Ok(status);
        }
        status.loaded = true;
        status.pid = parse_pid(&stdout).unwrap_or(0);
        status.last_exit = parse_last_exit(&stdout);
        Ok(status)
    }

    /// 让 launchd 立即重启这个服务（`launchctl kickstart -k`）。
    pub fn restart(&self, label: &str) -> io::Result<()> {
        let target = self.service_target(label);
        let (stdout, code) = (self.run)(LAUNCHCTL, &["kickstart", "-k", &target])?;
        if code != 0 {
            return Err(io::Error::other(format!(
                "launchctl kickstart -k {label} failed with exit code {code}: {stdout}"
            )));
        }
        Ok(())
    }
}

/// 在形如 "\tpid = 4242" 的行里找 pid。
fn parse_pid(stdout: &str) -> Option<u32> {
    for line in stdout.lines() {
        let Some(rest) = line.trim().strip_prefix("pid") else {
            continue;
        };
        if let Some(value) = rest.trim_start().strip_prefix('=') {
            if let Ok(pid) = value.trim().parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

/// 在形如 "\tlast exit code = (never exited)" 的行里找退出状态。
fn parse_last_exit(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("last exit code") {
            if let Some(value) = rest.trim_start().strip_prefix('=') {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn temp_file_name(base: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(".tmp-{base}-{pid}-{nanos}-{n}")
}

/// 原子写入：写到同目录下的临时文件再 rename，目录不存在时先创建。
fn write_file_atomic(path: &Path, data: &[u8], mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;

    let base = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("service");
    let tmp_path = dir.join(temp_file_name(base));

    let write_result = (|| {
        fs::write(&tmp_path, data)?;
        let mut perm = fs::metadata(&tmp_path)?.permissions();
        perm.set_mode(mode);
        fs::set_permissions(&tmp_path, perm)?;
        fs::rename(&tmp_path, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn ac_plist_golden() {
        let mut env = BTreeMap::new();
        env.insert("ZEBRA".to_string(), "z".to_string());
        env.insert("ALPHA".to_string(), "a".to_string());
        let spec = Spec {
            label: "com.jiaqiao.agents-manager.router".into(),
            program: "/usr/local/bin/agents-manager-router".into(),
            args: vec!["--config".into(), "/etc/agents-manager/config.json".into()],
            log_path: Some("/var/log/agents-manager/router.log".into()),
            env,
            associated_bundle: Some("com.jiaqiao.agents-manager".into()),
        };

        let got = plist(&spec).unwrap();

        let want = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
\t<key>Label</key>\n\
\t<string>com.jiaqiao.agents-manager.router</string>\n\
\t<key>AssociatedBundleIdentifiers</key>\n\
\t<string>com.jiaqiao.agents-manager</string>\n\
\t<key>ProgramArguments</key>\n\
\t<array>\n\
\t\t<string>/usr/local/bin/agents-manager-router</string>\n\
\t\t<string>--config</string>\n\
\t\t<string>/etc/agents-manager/config.json</string>\n\
\t</array>\n\
\t<key>RunAtLoad</key>\n\
\t<true/>\n\
\t<key>KeepAlive</key>\n\
\t<true/>\n\
\t<key>ThrottleInterval</key>\n\
\t<integer>5</integer>\n\
\t<key>ProcessType</key>\n\
\t<string>Background</string>\n\
\t<key>StandardOutPath</key>\n\
\t<string>/var/log/agents-manager/router.log</string>\n\
\t<key>StandardErrorPath</key>\n\
\t<string>/var/log/agents-manager/router.log</string>\n\
\t<key>EnvironmentVariables</key>\n\
\t<dict>\n\
\t\t<key>ALPHA</key>\n\
\t\t<string>a</string>\n\
\t\t<key>ZEBRA</key>\n\
\t\t<string>z</string>\n\
\t</dict>\n\
</dict>\n\
</plist>\n";

        assert_eq!(got, want);
    }

    #[test]
    fn plist_no_environment_variables_omits_section() {
        let spec = Spec {
            label: "com.jiaqiao.agents-manager.router".into(),
            program: "/usr/local/bin/agents-manager-router".into(),
            ..Default::default()
        };
        let got = plist(&spec).unwrap();
        assert!(!got.contains("EnvironmentVariables"));
        assert!(!got.contains("StandardOutPath"));
    }

    #[test]
    fn plist_xml_escaping() {
        let mut env = BTreeMap::new();
        env.insert("K<E>Y".to_string(), "V&\"'<A>L".to_string());
        let spec = Spec {
            label: "com.example<\"&'>".into(),
            program: "/usr/local/bin/foo".into(),
            args: vec!["--name=<Tom & \"Jerry\">".into()],
            env,
            ..Default::default()
        };
        let got = plist(&spec).unwrap();

        for forbidden in [
            "com.example<\"&'>",
            "<Tom & \"Jerry\">",
            "K<E>Y",
            "V&\"'<A>L",
        ] {
            assert!(!got.contains(forbidden), "found raw {forbidden:?} in {got}");
        }
        for escaped in ["&lt;", "&amp;", "&#34;", "&#39;", "&gt;"] {
            assert!(got.contains(escaped), "missing {escaped:?} in {got}");
        }
    }

    #[test]
    fn plist_validation_errors() {
        let cases = [
            Spec {
                label: "".into(),
                program: "/usr/local/bin/foo".into(),
                ..Default::default()
            },
            Spec {
                label: "com.example.foo".into(),
                program: "".into(),
                ..Default::default()
            },
            Spec {
                label: "com.example.foo".into(),
                program: "bin/foo".into(),
                ..Default::default()
            },
        ];
        for spec in cases {
            assert!(plist(&spec).is_err(), "{spec:?}");
        }
    }

    #[derive(Debug, Clone)]
    struct RecordedCall {
        name: String,
        args: Vec<String>,
    }

    struct RunResponse {
        stdout: String,
        exit_code: i32,
        err: Option<io::Error>,
    }

    impl RunResponse {
        fn ok(stdout: &str, exit_code: i32) -> Self {
            RunResponse {
                stdout: stdout.to_string(),
                exit_code,
                err: None,
            }
        }
        fn error(err: io::Error) -> Self {
            RunResponse {
                stdout: String::new(),
                exit_code: 0,
                err: Some(err),
            }
        }
    }

    /// 记录每次调用的假 runner，按顺序回放预先准备好的响应；测试从不碰真实的 launchctl。
    struct FakeRunner {
        calls: Mutex<Vec<RecordedCall>>,
        responses: Mutex<Vec<RunResponse>>,
    }

    impl FakeRunner {
        fn new(responses: Vec<RunResponse>) -> Self {
            FakeRunner {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(responses),
            }
        }

        fn run(&self, name: &str, args: &[&str]) -> io::Result<(String, i32)> {
            self.calls.lock().unwrap().push(RecordedCall {
                name: name.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
            });
            let mut responses = self.responses.lock().unwrap();
            if responses.is_empty() {
                return Ok((String::new(), 0));
            }
            let r = responses.remove(0);
            match r.err {
                Some(e) => Err(e),
                None => Ok((r.stdout, r.exit_code)),
            }
        }

        fn calls(&self) -> Vec<RecordedCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn test_manager(dir: &Path, runner: std::sync::Arc<FakeRunner>) -> Manager {
        Manager {
            launch_agents_dir: dir.to_path_buf(),
            uid: 501,
            run: Box::new(move |name, args| runner.run(name, args)),
        }
    }

    const NOT_LOADED_OUTPUT: &str =
        "Bad request.\nCould not find service \"com.example.foo\" in domain for user gui: 501\n";
    const LOADED_PRINT_OUTPUT: &str =
        "gui/501/com.example.foo = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n}\n";

    fn test_spec() -> Spec {
        Spec {
            label: "com.example.foo".into(),
            program: "/usr/local/bin/foo".into(),
            args: vec!["--flag".into()],
            log_path: Some("/tmp/foo.log".into()),
            env: BTreeMap::new(),
            associated_bundle: None,
        }
    }

    #[test]
    fn install_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![
            RunResponse::ok(NOT_LOADED_OUTPUT, 113), // launchctl print: not loaded
            RunResponse::ok("", 0),                  // launchctl bootstrap
        ];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());
        let spec = test_spec();

        m.install(&spec).unwrap();

        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, LAUNCHCTL);
        assert_eq!(calls[0].args[0], "print");
        assert_eq!(calls[1].args[0], "bootstrap");

        let data = fs::read_to_string(m.plist_path(&spec.label)).unwrap();
        assert_eq!(data, plist(&spec).unwrap());
    }

    #[test]
    fn install_already_loaded_different_spec() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![
            RunResponse::ok(LOADED_PRINT_OUTPUT, 0), // print: loaded
            RunResponse::ok("", 0),                  // bootout
            RunResponse::ok("", 0),                  // bootstrap
        ];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());
        let spec = test_spec();

        let mut old_spec = spec.clone();
        old_spec.args = vec!["--old-flag".into()];
        let old_data = plist(&old_spec).unwrap();
        fs::write(m.plist_path(&spec.label), old_data).unwrap();

        m.install(&spec).unwrap();

        let calls = runner.calls();
        assert_eq!(calls.len(), 3);
        let want_order = ["print", "bootout", "bootstrap"];
        for (call, want) in calls.iter().zip(want_order) {
            assert_eq!(call.args[0], want);
        }

        let data = fs::read_to_string(m.plist_path(&spec.label)).unwrap();
        assert_eq!(data, plist(&spec).unwrap());
    }

    #[test]
    fn install_unchanged_and_loaded_only_checks() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::ok(LOADED_PRINT_OUTPUT, 0)];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());
        let spec = test_spec();

        let data = plist(&spec).unwrap();
        let path = m.plist_path(&spec.label);
        fs::write(&path, &data).unwrap();
        let mtime_before = fs::metadata(&path).unwrap().modified().unwrap();

        m.install(&spec).unwrap();

        let calls = runner.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args[0], "print");

        let mtime_after = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "plist 不该被重写");
    }

    /// plist 没变但服务没加载（例如用户手动停用过）：必须重新加载，否则“启用”会没有任何效果。
    #[test]
    fn install_unchanged_but_not_loaded_bootstraps() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![
            RunResponse::ok(NOT_LOADED_OUTPUT, 113),
            RunResponse::ok("", 0),
        ];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());
        let spec = test_spec();

        let data = plist(&spec).unwrap();
        fs::write(m.plist_path(&spec.label), data).unwrap();

        m.install(&spec).unwrap();

        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args[0], "print");
        assert_eq!(calls[1].args[0], "bootstrap");
    }

    #[test]
    fn install_validation_error_propagates() {
        let dir = tempfile::tempdir().unwrap();
        let runner = std::sync::Arc::new(FakeRunner::new(vec![]));
        let m = test_manager(dir.path(), runner.clone());

        let err = m.install(&Spec {
            label: "".into(),
            program: "/usr/local/bin/foo".into(),
            ..Default::default()
        });
        assert!(err.is_err());
        assert_eq!(runner.calls().len(), 0);
    }

    #[test]
    fn uninstall_when_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::ok("", 0)]; // bootout succeeds
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());
        let spec = test_spec();

        let data = plist(&spec).unwrap();
        let path = m.plist_path(&spec.label);
        fs::write(&path, data).unwrap();

        m.uninstall(&spec.label).unwrap();

        let calls = runner.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args[0], "bootout");
        assert!(!path.exists());
    }

    #[test]
    fn uninstall_when_not_loaded_and_plist_missing() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::ok(NOT_LOADED_OUTPUT, 113)];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());

        m.uninstall("com.example.foo").unwrap();
        assert_eq!(runner.calls().len(), 1);
    }

    #[test]
    fn uninstall_bootout_real_failure_propagates() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::ok("some unexpected failure", 1)];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());

        assert!(m.uninstall("com.example.foo").is_err());
    }

    #[test]
    fn status_loaded_and_installed() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::ok(LOADED_PRINT_OUTPUT, 0)];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());
        let spec = test_spec();

        let data = plist(&spec).unwrap();
        fs::write(m.plist_path(&spec.label), data).unwrap();

        let st = m.status(&spec.label).unwrap();
        assert!(st.installed);
        assert!(st.loaded);
        assert_eq!(st.pid, 4242);
        assert_eq!(st.last_exit.as_deref(), Some("(never exited)"));
    }

    #[test]
    fn status_not_installed_not_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::ok(NOT_LOADED_OUTPUT, 113)];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());

        let st = m.status("com.example.foo").unwrap();
        assert!(!st.installed);
        assert!(!st.loaded);
        assert_eq!(st.pid, 0);
    }

    #[test]
    fn status_run_error_propagates() {
        let dir = tempfile::tempdir().unwrap();
        let responses = vec![RunResponse::error(io::Error::other("exec failed"))];
        let runner = std::sync::Arc::new(FakeRunner::new(responses));
        let m = test_manager(dir.path(), runner.clone());

        let err = m.status("com.example.foo").unwrap_err();
        assert_eq!(err.to_string(), "exec failed");
    }

    #[test]
    fn manager_plist_path() {
        let m = Manager {
            launch_agents_dir: PathBuf::from("/x/LaunchAgents"),
            uid: 0,
            run: Box::new(|_, _| Ok((String::new(), 0))),
        };
        let got = m.plist_path("com.example.foo");
        assert_eq!(got, PathBuf::from("/x/LaunchAgents/com.example.foo.plist"));
    }

    #[test]
    fn restart_success_and_failure() {
        let dir = tempfile::tempdir().unwrap();
        let runner = std::sync::Arc::new(FakeRunner::new(vec![RunResponse::ok("", 0)]));
        let m = test_manager(dir.path(), runner.clone());
        m.restart("com.example.foo").unwrap();
        let calls = runner.calls();
        assert_eq!(
            calls[0].args,
            vec!["kickstart", "-k", "gui/501/com.example.foo"]
        );

        let runner2 = std::sync::Arc::new(FakeRunner::new(vec![RunResponse::ok("boom", 1)]));
        let m2 = test_manager(dir.path(), runner2);
        assert!(m2.restart("com.example.foo").is_err());
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    /// 终审提醒：`launchctl` 不能靠 PATH 找——后台进程的 PATH 由 launchd 决定，
    /// 而且 PATH 上的同名程序会被当成它来执行
    #[test]
    fn launchctl_is_invoked_by_absolute_path() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = std::sync::Arc::clone(&calls);
        let manager = Manager {
            launch_agents_dir: std::env::temp_dir(),
            uid: 501,
            run: Box::new(move |program, _args| {
                recorder.lock().unwrap().push(program.to_owned());
                Ok((String::new(), 0))
            }),
        };
        let _ = manager.status("com.example.x");
        let _ = manager.uninstall("com.example.x");
        let _ = manager.restart("com.example.x");
        let calls = calls.lock().unwrap();
        assert!(!calls.is_empty());
        assert!(
            calls.iter().all(|program| program == "/bin/launchctl"),
            "{calls:?}"
        );
    }
}

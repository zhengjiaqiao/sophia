//! 本机诊断的纯逻辑（spec 2026-10-04-local-diagnostics R2、R5、R8）：崩溃记录的格式、日志文件按大小轮转、
//! 「上次是不是意外退出」的运行标记。写日志本身在 `src-tauri` 与 `sophia-gateway`，这里不碰 tauri。
use std::io;
use std::path::{Path, PathBuf};

/// 运行标记文件名的前缀（在数据目录下，后接应用标识）：启动时写入、正常退出时删掉，下次启动还在就是意外退出
pub const RUN_MARKER_PREFIX: &str = "running-";

/// 一次 panic 要记下的东西，由调用方从 `PanicHookInfo` 与环境里取
pub struct CrashInfo<'a> {
    /// 自 UNIX 纪元起的秒数
    pub unix_secs: u64,
    pub version: &'a str,
    pub os: &'a str,
    pub thread: &'a str,
    /// `文件:行:列`；panic 拿不到位置时为 `None`
    pub location: Option<&'a str>,
    pub message: &'a str,
    pub backtrace: &'a str,
}

/// 单份崩溃记录的上限：超了留头（时间、位置、消息、栈顶）和尾（栈底），中间省略
pub const CRASH_REPORT_MAX_BYTES: usize = 256 * 1024;

/// 崩溃记录的一段（追加进 `crash.log`）。各段分开去隐私；不按单条日志限长（调用栈要留），超过
/// `CRASH_REPORT_MAX_BYTES` 才掐掉中间
pub fn crash_report(info: &CrashInfo) -> String {
    // 各段分开去隐私：消息里没收尾的 `{`（例如解析错误）只遮到这一段为止，不吞掉后面的调用栈
    let clean = crate::redact::redact_full;
    let text = format!(
        "==== panic ====\ntime: {}\nversion: {}\nos: {}\nthread: {}\nlocation: {}\nmessage: {}\nbacktrace:\n{}\n",
        utc_rfc3339(info.unix_secs),
        clean(info.version),
        clean(info.os),
        clean(info.thread),
        clean(info.location.unwrap_or("-")),
        clean(info.message),
        clean(info.backtrace.trim_end()),
    );
    keep_head_and_tail(text, CRASH_REPORT_MAX_BYTES)
}

/// 超过 `max` 字节就只留头尾各一半（按字符边界切），中间换成一行说明
fn keep_head_and_tail(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let half = max / 2;
    let mut head = half;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - half;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!(
        "{}\n… ({} bytes omitted) …\n{}",
        &text[..head],
        tail - head,
        &text[tail..]
    )
}

/// 追加 `incoming` 字节之前调用：文件已到上限、或这一条写进去会越过上限，就轮转：`.1` → `.2` …，
/// 文件本身改名 `.1`，旧的最多留 `keep` 份（至少 1 份）。空文件不换（一条本身比上限还长时照样写进新文件）。
/// 文件不在不算错
pub fn rotate_before_append(
    path: &Path,
    incoming: u64,
    max_bytes: u64,
    keep: usize,
) -> io::Result<()> {
    let len = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => meta.len(),
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if len == 0 || (len < max_bytes && len.saturating_add(incoming) <= max_bytes) {
        return Ok(());
    }
    for n in (1..keep.max(1)).rev() {
        let from = numbered_path(path, n);
        if std::fs::symlink_metadata(&from).is_ok() {
            std::fs::rename(&from, numbered_path(path, n + 1))?;
        }
    }
    std::fs::rename(path, rotated_path(path))
}

/// `<文件名>.1`
pub fn rotated_path(path: &Path) -> PathBuf {
    numbered_path(path, 1)
}

fn numbered_path(path: &Path, n: usize) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{n}"));
    path.with_file_name(name)
}

/// 这一份构建的运行标记 `running-<应用标识>`：开发版与安装版共用数据目录、能同时开着，各认各的
pub fn run_marker(dir: &Path, identity: &str) -> PathBuf {
    dir.join(format!("{RUN_MARKER_PREFIX}{identity}"))
}

/// 启动时调用：返回上次是否意外退出（标记还在），然后写入本次的标记。写不进去只记一条日志
pub fn begin_run(dir: &Path, identity: &str) -> bool {
    let marker = run_marker(dir, identity);
    // 判断条目在不在用 lstat：标记被换成坏链也算还在
    let unexpected = std::fs::symlink_metadata(&marker).is_ok();
    let written = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&marker, std::process::id().to_string()));
    if let Err(e) = written {
        log::warn!("写运行标记 {} 失败：{e}", marker.display());
    }
    unexpected
}

/// 正常退出时调用：删掉运行标记。本来就没有不算错
pub fn end_run(dir: &Path, identity: &str) -> io::Result<()> {
    match std::fs::remove_file(run_marker(dir, identity)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// UTC 时间 `YYYY-MM-DDTHH:MM:SSZ`（Howard Hinnant 的 civil_from_days）
pub fn utc_rfc3339(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    #[test]
    fn utc_time_is_formatted() {
        assert_eq!(utc_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc_rfc3339(1_791_115_200), "2026-10-04T12:00:00Z");
    }

    #[test]
    fn crash_report_has_every_field_and_is_redacted() {
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        let message = format!("读 {home}/.codex/auth.json 失败 token=abc");
        let backtrace = "   0: sophia_lib::run\n   1: main\n".repeat(400);
        let report = crash_report(&CrashInfo {
            unix_secs: 1_791_115_200,
            version: "0.3.0",
            os: "macos 15.1 aarch64",
            thread: "main",
            location: Some("src-tauri/src/lib.rs:12:5"),
            message: &message,
            backtrace: &backtrace,
        });
        for want in [
            "2026-10-04T12:00:00Z",
            "0.3.0",
            "macos 15.1 aarch64",
            "main",
            "src-tauri/src/lib.rs:12:5",
            "~/.codex/auth.json",
            "token=…",
            "sophia_lib::run",
        ] {
            assert!(report.contains(want), "缺 {want}:\n{report}");
        }
        assert!(!report.contains(&home));
        assert!(!report.contains("abc"));
        // 调用栈不按单条日志限长截断
        assert!(report.chars().count() > crate::redact::MAX_CHARS);
        assert!(report.ends_with('\n'));
    }

    /// Codex 复审第二轮：消息里没收尾的 `{` 不能把后面的调用栈一起遮掉
    #[test]
    fn unclosed_brace_in_message_keeps_backtrace() {
        let report = crash_report(&CrashInfo {
            unix_secs: 0,
            version: "1",
            os: "x",
            thread: "main",
            location: Some("a.rs:1:1"),
            message: "failed to parse auth: {",
            backtrace: "   0: sophia_lib::run\n   1: main\n",
        });
        assert!(report.contains("backtrace:"), "{report}");
        assert!(report.contains("sophia_lib::run"), "{report}");
        assert!(report.contains("   1: main"), "{report}");
    }

    #[test]
    fn crash_report_without_location() {
        let report = crash_report(&CrashInfo {
            unix_secs: 0,
            version: "1",
            os: "x",
            thread: "<unnamed>",
            location: None,
            message: "boom",
            backtrace: "",
        });
        assert!(report.contains("boom"));
        assert!(report.contains("<unnamed>"));
    }

    #[test]
    fn rotation_keeps_one_old_copy() {
        let tree = TempTree::new();
        let log = tree.root().join("router.log");
        // 不在：不算错
        rotate_before_append(&log, 4, 10, 1).unwrap();
        std::fs::write(&log, "12345").unwrap();
        rotate_before_append(&log, 5, 10, 1).unwrap();
        assert!(log.exists(), "写完正好到上限：不动");
        std::fs::write(&log, "0123456").unwrap();
        std::fs::write(rotated_path(&log), "old").unwrap();
        // 这一条写进去就越过上限：先换
        rotate_before_append(&log, 4, 10, 1).unwrap();
        assert!(!log.exists());
        assert_eq!(
            std::fs::read_to_string(tree.root().join("router.log.1")).unwrap(),
            "0123456"
        );
    }

    #[test]
    fn rotation_at_exactly_the_cap_and_oversized_first_line() {
        let tree = TempTree::new();
        let log = tree.root().join("crash.log");
        std::fs::write(&log, "0123456789").unwrap();
        rotate_before_append(&log, 0, 10, 1).unwrap();
        assert!(!log.exists(), "已经正好在上限：换");
        // 空文件不换，一条比上限还长的照样写进新文件
        std::fs::write(&log, "").unwrap();
        rotate_before_append(&log, 50, 10, 1).unwrap();
        assert!(log.exists());
    }

    #[test]
    fn rotation_can_keep_several_old_copies() {
        let tree = TempTree::new();
        let log = tree.root().join("sophia.log");
        let read = |name: &str| std::fs::read_to_string(tree.root().join(name)).ok();
        for (i, body) in ["a", "b", "c", "d"].iter().enumerate() {
            std::fs::write(&log, body.repeat(10)).unwrap();
            rotate_before_append(&log, 1, 10, 2).unwrap();
            assert!(!log.exists(), "第 {i} 次");
        }
        // 只留 2 份旧的：最新的在 .1
        assert_eq!(read("sophia.log.1").as_deref(), Some("dddddddddd"));
        assert_eq!(read("sophia.log.2").as_deref(), Some("cccccccccc"));
        assert_eq!(read("sophia.log.3"), None);
    }

    #[test]
    fn oversized_crash_report_keeps_head_and_tail() {
        let backtrace = format!(
            "   0: first_frame\n{}   9: last_frame\n",
            "   5: 中间的帧 sophia_lib::x\n".repeat(40_000)
        );
        let report = crash_report(&CrashInfo {
            unix_secs: 0,
            version: "1",
            os: "x",
            thread: "main",
            location: Some("a.rs:1:1"),
            message: "boom",
            backtrace: &backtrace,
        });
        assert!(
            report.len() <= CRASH_REPORT_MAX_BYTES + 200,
            "{}",
            report.len()
        );
        for want in [
            "boom",
            "a.rs:1:1",
            "first_frame",
            "last_frame",
            "bytes omitted",
        ] {
            assert!(report.contains(want), "缺 {want}");
        }
        assert!(report.ends_with('\n'));
    }

    const PROD: &str = "com.zhengjiaqiao.sophia";
    const DEV: &str = "com.zhengjiaqiao.sophia.dev";

    #[test]
    fn run_marker_detects_unexpected_exit() {
        let tree = TempTree::new();
        let dir = tree.root().join("AppData/Sophia");
        // 第一次启动（目录都还没有）：不算意外
        assert!(!begin_run(&dir, PROD));
        assert!(run_marker(&dir, PROD).exists());
        assert_eq!(
            run_marker(&dir, PROD).file_name().unwrap(),
            "running-com.zhengjiaqiao.sophia"
        );
        // 没走正常退出就又启动：算意外
        assert!(begin_run(&dir, PROD));
        // 正常退出后再启动：不算
        end_run(&dir, PROD).unwrap();
        assert!(!run_marker(&dir, PROD).exists());
        assert!(!begin_run(&dir, PROD));
        end_run(&dir, PROD).unwrap();
        // 没有标记时退出不算错
        end_run(&dir, PROD).unwrap();
    }

    /// 开发版与安装版共用数据目录（Codex 复审 8）：各认各的标记，互不误报、互不清掉
    #[test]
    fn run_markers_are_per_build_identity() {
        let tree = TempTree::new();
        let dir = tree.root().join("AppData/Sophia");
        assert!(!begin_run(&dir, PROD));
        // 安装版开着时开开发版：不算开发版意外退出
        assert!(!begin_run(&dir, DEV));
        // 开发版正常退出不清安装版的标记
        end_run(&dir, DEV).unwrap();
        assert!(run_marker(&dir, PROD).exists());
        // 安装版随后被强制结束：下次打开照样认出来
        assert!(begin_run(&dir, PROD));
        assert!(!begin_run(&dir, DEV));
    }
}

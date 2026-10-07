//! Claude 桌面应用记在本机的用量历史（spec #195，`docs/specs/2026-09-26-menubar-usage.md` R1、R2、R13）：
//! Claude Code 命令行不可用（没装或没登录）时，读 `~/Library/Application Support/Claude/plan-usage-history.json`
//! 的最新一条，给出 5 小时、本周两个窗口的百分比。只读、不起进程、不碰令牌；格式未公开，认不得就当「没有记录」，
//! 日志记一笔（不含账号信息）。解析在 `sophia_core::usage::parse::parse_desktop_history`。

use sophia_core::usage::parse::{parse_desktop_history, DesktopHistoryUnusable};
use sophia_core::usage::Reading;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 桌面应用的用量历史在 `home` 下的位置（Claude 桌面应用自己写，本机实测 2026-10-06）
pub fn history_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Claude")
        .join("plan-usage-history.json")
}

/// 读一次（同步，调用方放在 `spawn_blocking` 里，同 `codex::read_rollout`）。文件不在（没装桌面应用、
/// 没开过用量面板）、读不出、格式认不得一律 `None`：不是取数失败，只是没有桌面应用的记录
pub fn read_desktop_history(path: &Path) -> Option<Reading> {
    let outcome = match std::fs::read_to_string(path) {
        Ok(text) => parse_desktop_history(&text).map_err(Unreadable::Format),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(Unreadable::Missing),
        Err(e) => Err(Unreadable::Io(e.kind())),
    };
    note(&outcome);
    outcome.ok()
}

/// 为什么没有读数：只进日志
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unreadable {
    /// 文件不在：没装桌面应用或从没记过，平常事，不记日志
    Missing,
    Io(io::ErrorKind),
    Format(DesktopHistoryUnusable),
}

/// 上一次记下的结果：同一种情况只记一笔，不然每次到点都写一行
static LAST_LOGGED: Mutex<Option<Unreadable>> = Mutex::new(None);

/// 读不出、格式认不得时记一笔（只写种类，不写文件内容，免得带出账号字段）；恢复正常后也记一笔
fn note(outcome: &Result<Reading, Unreadable>) {
    let now = match outcome {
        Ok(_) | Err(Unreadable::Missing) => None,
        Err(e) => Some(*e),
    };
    let mut last = LAST_LOGGED.lock().unwrap_or_else(|e| e.into_inner());
    if *last == now {
        return;
    }
    match now {
        Some(e) => log::warn!("Claude 桌面应用的用量历史读不出来，按没有记录处理：{e:?}"),
        None if last.is_some() => log::info!("Claude 桌面应用的用量历史又能读了"),
        None => {}
    }
    *last = now;
}

#[cfg(test)]
mod tests {
    use super::*;
    use sophia_core::usage::Source;

    /// 临时主目录下按桌面应用的位置放一份历史文件
    fn home_with(text: Option<&str>) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().canonicalize().unwrap();
        if let Some(text) = text {
            let path = history_path(&home);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        (dir, home)
    }

    #[test]
    fn reads_latest_sample_from_the_desktop_app_location() {
        let (_dir, home) = home_with(Some(
            r#"{"version":2,"samples":[{"t":1791259612753,"org":"x","u":{"fh":8,"sd":3}}]}"#,
        ));
        let reading = read_desktop_history(&history_path(&home)).unwrap();
        assert_eq!(reading.source, Source::DesktopHistory);
        assert_eq!(reading.observed_at, 1_791_259_612);
        assert!(reading.windows.iter().all(|w| w.resets_at.is_none()));
    }

    /// 没装桌面应用、版本认不得、写坏了：都是「没有记录」，不报错
    #[test]
    fn missing_or_unrecognized_file_is_no_reading() {
        let (_dir, home) = home_with(None);
        assert_eq!(read_desktop_history(&history_path(&home)), None);
        for text in [
            r#"{"version":3,"samples":[{"t":1791259612753,"u":{"fh":8,"sd":3}}]}"#,
            r#"{"version":2,"samples":[]}"#,
            "{\"version\":2,\"samp",
        ] {
            let (_dir, home) = home_with(Some(text));
            assert_eq!(read_desktop_history(&history_path(&home)), None, "{text}");
        }
    }

    #[test]
    fn path_is_under_application_support_claude() {
        assert_eq!(
            history_path(Path::new("/Users/me")),
            PathBuf::from("/Users/me/Library/Application Support/Claude/plan-usage-history.json")
        );
    }
}

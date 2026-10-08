//! 命令错误分两层（spec #239「错误怎么分两层」，CODING_STANDARDS「错误给人看的一句与技术原文分开」）。
//! 交给前端的错误串是 `[code] 一句`，带原文时另起一行 `[detail] 原文`（`sophia_gateway::app::AppError` 的格式，
//! 前端 `src/backendError.ts` 的 `parseBackendError` 拆开：一句给人看，原文进前面的「!」）：
//! - 错误本身就是给人看的句子（core 用 `t!` 产出；装在 `io::Error` 里的包成 `Said`）：原样作一句，`[invalid]`，不带原文
//! - io、序列化、系统与第三方的原文：一句换成该处的失败句，原文去隐私后进 `[detail]`，`[internal]`
//!
//! 两种都同 `err` 记一条去隐私的日志。
//! `err`（原样返回原文）只剩调试版的隔离测试主目录在用（#320），新命令不要再用它。
//!
//! 日志里的 `文件:行` 靠 `#[track_caller]`：这几个函数（连同 `err`）都在调用处的闭包里调
//! （`.map_err(|e| settings_unsaved(e))`），不当函数值传（`.map_err(settings_unsaved)`）——
//! 当函数值传时记下的是标准库里调它的那一行（#303，测试 `日志里的位置是调用处`）。

use sophia_core::i18n::Said;
use sophia_core::redact::redact;
use sophia_gateway::app::AppError;

/// 给人看的一句（`t!` 产出的）原样作一句
#[track_caller]
pub(crate) fn said(sentence: impl std::fmt::Display) -> String {
    let text = sentence.to_string();
    log(&text);
    AppError::new("invalid", text).to_string()
}

/// 该处失败：认得出是给人看的一句（`Said`）就原样作一句；否则一句是 `sentence`，原文进 `[detail]`
#[track_caller]
pub(crate) fn failed(error: &(dyn std::error::Error + 'static), sentence: &str) -> String {
    match Said::of(error) {
        Some(text) => said(text),
        None => raw_failed(&error.to_string(), sentence),
    }
}

/// 只有原文（系统 API 给的一段字）：一句是 `sentence`，原文去隐私后进 `[detail]`
#[track_caller]
pub(crate) fn raw_failed(raw: &str, sentence: &str) -> String {
    log(raw);
    AppError::new("internal", sentence)
        .with_detail(redact(raw))
        .to_string()
}

/// core 定好的一句 + 可能有的技术原文（解包出错 `ArchiveError`）：有原文时原文去隐私后进 `[detail]`，
/// 没有时原样作一句
#[track_caller]
pub(crate) fn sentence_with_detail(sentence: &str, detail: Option<&str>) -> String {
    match detail {
        Some(raw) => raw_failed(raw, sentence),
        None => said(sentence),
    }
}

/// 设置页任一项保存失败
#[track_caller]
pub(crate) fn settings_unsaved(error: std::io::Error) -> String {
    failed(&error, &sophia_core::t!("settings.save.failed"))
}

/// 读 Sophia 自己的数据（`settings.json`、`projects.json`、`copies.json`）失败：各页的读取类命令（扫描、列表）
/// 与它们共用的发现步骤都走这里
#[track_caller]
pub(crate) fn data_unread(error: std::io::Error) -> String {
    failed(&error, &sophia_core::t!("common.data.readFailed"))
}

/// 写 Sophia 自己的数据（`projects.json`、安装记录等，设置页以外的 `settings.json` 写回走 `settings_unsaved`）失败：
/// 一句是「Sophia 的数据保存失败」，原文进 `[detail]`
#[track_caller]
pub(crate) fn data_unsaved(error: std::io::Error) -> String {
    failed(&error, &sophia_core::t!("common.data.saveFailed"))
}

/// 记一条去隐私的日志，带调用处的 `文件:行`（`err` 也用它）
#[track_caller]
pub(crate) fn log(text: &str) {
    let at = std::panic::Location::caller();
    log::warn!(
        "command failed ({}:{}): {}",
        at.file(),
        at.line(),
        redact(text)
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use sophia_core::t;
    use std::io;

    #[test]
    fn 原文换成该处的失败句_原文进_detail() {
        let raw = io::Error::from_raw_os_error(13);
        assert_eq!(
            settings_unsaved(io::Error::from_raw_os_error(13)),
            format!("[internal] {}\n[detail] {raw}", t!("settings.save.failed"))
        );
    }

    #[test]
    fn 给人看的一句原样作一句_不带原文() {
        let error = Said(t!("common.settings.tooNew")).into_io(io::ErrorKind::Unsupported);
        assert_eq!(
            settings_unsaved(error),
            format!("[invalid] {}", t!("common.settings.tooNew"))
        );
        assert_eq!(said("x"), "[invalid] x");
    }

    /// #302：各页读取类命令读不出 Sophia 自己的数据，一句是「Sophia 的数据读取失败」，原文进 `[detail]`；
    /// 设置文件来自更新版本这类给人看的一句原样说
    #[test]
    fn 读取类命令读不出数据_一句是数据读取失败() {
        let raw = io::Error::from_raw_os_error(13);
        assert_eq!(
            data_unread(io::Error::from_raw_os_error(13)),
            format!(
                "[internal] {}\n[detail] {raw}",
                t!("common.data.readFailed")
            )
        );
        let too_new = Said(t!("common.settings.tooNew")).into_io(io::ErrorKind::Unsupported);
        assert_eq!(
            data_unread(too_new),
            format!("[invalid] {}", t!("common.settings.tooNew"))
        );
    }

    #[test]
    fn 原文去隐私() {
        let text = raw_failed("open /Users/someone/a.json: denied", "s");
        assert_eq!(text, "[internal] s\n[detail] open ~/a.json: denied");
    }

    #[test]
    fn 原文是空的就不带_detail() {
        assert_eq!(raw_failed("  ", "s"), "[internal] s");
    }

    /// 这条测试线程记下的日志（`log` 只能装一个全局记录器，按线程分开收，测试并行不串）
    mod capture {
        use std::cell::RefCell;

        thread_local! {
            static LINES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
        }

        struct Capture;

        impl log::Log for Capture {
            fn enabled(&self, _: &log::Metadata) -> bool {
                true
            }
            fn log(&self, record: &log::Record) {
                LINES.with(|lines| lines.borrow_mut().push(record.args().to_string()));
            }
            fn flush(&self) {}
        }

        static CAPTURE: Capture = Capture;

        pub fn lines(run: impl FnOnce()) -> Vec<String> {
            let _ = log::set_logger(&CAPTURE);
            log::set_max_level(log::LevelFilter::Warn);
            LINES.with(|lines| lines.borrow_mut().clear());
            run();
            LINES.with(|lines| lines.borrow_mut().drain(..).collect())
        }
    }

    fn denied() -> Result<(), io::Error> {
        Err(io::Error::from_raw_os_error(13))
    }

    /// #303：`#[track_caller]` 的函数当函数值传给 `map_err`，`Location::caller()` 是标准库里调它的那一行
    /// （实测 `library/core/src/ops/function.rs`）；在调用处的闭包里调，记下的才是调用处
    #[test]
    fn 日志里的位置是调用处() {
        let here = |line: u32| format!("({}:{line})", file!());
        let at = line!() + 2;
        let logged = capture::lines(|| {
            let _ = denied().map_err(|e| settings_unsaved(e));
            let _ = denied().map_err(|e| data_unread(e));
            let _ = denied().map_err(|e| data_unsaved(e));
            let _ = denied().map_err(|e| failed(&e, "s"));
            let _ = denied().map_err(|e| crate::err(e));
            let _ = denied().map_err(|_| said("x"));
        });
        assert_eq!(logged.len(), 6, "{logged:?}");
        for (i, text) in logged.iter().enumerate() {
            assert!(text.contains(&here(at + i as u32)), "{text}");
        }

        let passed_as_value = capture::lines(|| {
            let as_value = settings_unsaved;
            let _ = denied().map_err(as_value);
        });
        assert_eq!(passed_as_value.len(), 1);
        assert!(
            !passed_as_value[0].contains(file!()),
            "函数值传进 map_err 时记下的不是调用处：{}",
            passed_as_value[0]
        );
    }

    /// 防回潮：命令层不再把记位置的函数当函数值传给 `map_err`（见模块注释）
    #[test]
    fn 命令层不把记位置的函数当函数值传() {
        let names = [
            "err",
            "said",
            "failed",
            "raw_failed",
            "settings_unsaved",
            "data_unread",
            "data_unsaved",
        ];
        let mut found = Vec::new();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![dir];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|x| x != "rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                for (n, line) in text.lines().enumerate() {
                    let Some(at) = line.find(".map_err(") else {
                        continue;
                    };
                    let arg = line[at + ".map_err(".len()..]
                        .split(')')
                        .next()
                        .unwrap_or("");
                    let name = arg.rsplit("::").next().unwrap_or(arg);
                    if names.contains(&name) {
                        found.push(format!("{}:{}: {}", path.display(), n + 1, line.trim()));
                    }
                }
            }
        }
        assert!(found.is_empty(), "{found:#?}");
    }
}

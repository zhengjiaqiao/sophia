//! 命令错误分两层（spec #239「错误怎么分两层」，CODING_STANDARDS「错误给人看的一句与技术原文分开」）。
//! 交给前端的错误串是 `[code] 一句`，带原文时另起一行 `[detail] 原文`（`sophia_gateway::app::AppError` 的格式，
//! 前端 `src/backendError.ts` 的 `parseBackendError` 拆开：一句给人看，原文进前面的「!」）：
//! - 错误本身就是给人看的句子（core 用 `t!` 产出；装在 `io::Error` 里的包成 `Said`）：原样作一句，`[invalid]`，不带原文
//! - io、序列化、系统与第三方的原文：一句换成该处的失败句，原文去隐私后进 `[detail]`，`[internal]`
//!
//! 两种都同 `err` 记一条去隐私的日志。还在用 `err`（原样返回原文）的命令逐处改到这里。

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

/// 设置页任一项保存失败
#[track_caller]
pub(crate) fn settings_unsaved(error: std::io::Error) -> String {
    failed(&error, &sophia_core::t!("settings.save.failed"))
}

#[track_caller]
fn log(text: &str) {
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

    #[test]
    fn 原文去隐私() {
        let text = raw_failed("open /Users/someone/a.json: denied", "s");
        assert_eq!(text, "[internal] s\n[detail] open ~/a.json: denied");
    }

    #[test]
    fn 原文是空的就不带_detail() {
        assert_eq!(raw_failed("  ", "s"), "[internal] s");
    }
}

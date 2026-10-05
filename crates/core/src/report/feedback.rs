//! 应用内反馈（spec 2026-10-04-reporting-feedback R12）的纯逻辑：组装随反馈附上的诊断内容、`POST /v1/feedback`
//! 的请求体。只组装、不联网——上传截图与发送在 `src-tauri/src/feedback.rs`。
//!
//! 诊断内容：版本、系统、芯片，出错页带来的那条错误（有的话），`sophia.log` 里最近 3 天 WARN / ERROR 的最后 50 行。
//! 每一段都过一遍事件正文的去隐私（[`super::event_body`]：去用户名与密钥、路径只留文件名），合起来截到 32 KiB。
//! 用户自己写的话原样发（那是他要说的），安装 ID 只在自动上报开着时带上。
use super::events::{body, head};
use super::{day_number, endpoint};
use serde::Serialize;

/// 诊断内容的上限（字节，按 UTF-8 字符边界截）：接收服务收 32 KiB
pub const DIAGNOSTICS_MAX_BYTES: usize = 32 * 1024;
/// 日志里最多带这么多行 WARN / ERROR（取最后的）
pub const LOG_LINES: usize = 50;
/// 只看最近这么多天（含今天）的日志
pub const LOG_DAYS: i64 = 3;
/// 一条反馈最多带几张截图（接收服务同一上限）
pub const MAX_SHOTS: usize = 3;
/// 整条请求体（序列化后的 JSON 字节）的上限：接收服务收 64 KiB。诊断内容里要转义的字符会把它撑大，见 [`fit_body`]
pub const REQUEST_MAX_BYTES: usize = 64 * 1024;

/// `POST /v1/feedback` 的内容：只有这几项（接收服务 `server/` 的 `feedback`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackReport {
    /// 草稿 id（32 位小写 hex）：同一份草稿重试复用，接收服务据它去重（同 id 已收过就当成功）
    pub id: String,
    /// 用户写的话，原样
    pub text: String,
    /// 先传上去的截图 id（`POST /v1/shot` 回的），至多 3 个
    pub shots: Vec<String>,
    /// 自动上报开着时才有；关着时这一项整个不出现
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    /// 已去隐私的诊断内容（[`diagnostics`]）
    pub diagnostics: String,
    pub version: String,
    /// 系统大版本，如 `macOS 15`
    pub os: String,
    /// 芯片架构，如 `aarch64`
    pub arch: String,
}

/// 应用版本、系统、芯片：诊断内容与请求体里各一份
#[derive(Debug, Clone, Copy)]
pub struct AppInfo<'a> {
    pub version: &'a str,
    /// 系统大版本，如 `macOS 15`
    pub os: &'a str,
    /// 芯片架构，如 `aarch64`
    pub arch: &'a str,
}

/// 组装诊断内容要的几样
#[derive(Debug, Clone, Copy)]
pub struct DiagnosticsInput<'a> {
    pub app: AppInfo<'a>,
    /// 出错页带来的那条错误（前端已去过一次隐私；这里照样再过一遍）
    pub attached: Option<&'a str>,
    /// `sophia.log` 末尾的一段原文（调用方只读末尾一段，见 `src-tauri/src/feedback.rs`）
    pub log: &'a str,
    /// 本地日期 `YYYY-MM-DD`：「最近 3 天」从它往前数
    pub today: &'a str,
}

/// 日志里最近 [`LOG_DAYS`] 天的 WARN / ERROR 行，取最后 [`LOG_LINES`] 行，保持原顺序。
/// 日志行的格式是 `2026-10-04 09:05:07+08:00 [类别][WARN] 内容`（`src-tauri/src/diagnostics.rs` 的 `log_line`）；
/// 不以日期开头的（多行消息的续行）、日期认不出的、比今天还晚的都不要
pub fn recent_problems<'a>(log: &'a str, today: &str) -> Vec<&'a str> {
    let Some(today) = day_number(today) else {
        return Vec::new();
    };
    let mut kept: Vec<&str> = log
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| {
            let age = line.get(..10).and_then(day_number).map(|day| today - day);
            age.is_some_and(|age| (0..LOG_DAYS).contains(&age)) && is_problem(line)
        })
        .collect();
    let extra = kept.len().saturating_sub(LOG_LINES);
    kept.drain(..extra);
    kept
}

/// 级别是 WARN 或 ERROR：时间之后的 ` [类别][级别] `
fn is_problem(line: &str) -> bool {
    let level = line
        .split_once(" [")
        .and_then(|(_, rest)| rest.split_once("]["))
        .and_then(|(_, rest)| rest.split_once("] "))
        .map(|(level, _)| level);
    matches!(level, Some("WARN" | "ERROR"))
}

/// 随反馈附上的诊断内容：每段去隐私，合起来截到 [`DIAGNOSTICS_MAX_BYTES`]。标签用英文（给维护者看的技术原文，不进目录）
pub fn diagnostics(input: &DiagnosticsInput<'_>) -> String {
    let app = input.app;
    let mut text = format!(
        "version: {}\nos: {}\narch: {}",
        body(app.version),
        body(app.os),
        body(app.arch)
    );
    if let Some(attached) = input.attached.filter(|a| !a.trim().is_empty()) {
        text.push_str("\n\nAttached error:\n");
        text.push_str(&body(attached));
    }
    let problems = recent_problems(input.log, input.today);
    if !problems.is_empty() {
        text.push_str("\n\nRecent warnings and errors (sophia.log):\n");
        text.push_str(&body(&problems.join("\n")));
    }
    if text.len() > DIAGNOSTICS_MAX_BYTES {
        const MORE: &str = "\n…";
        let cut = head(&text, DIAGNOSTICS_MAX_BYTES - MORE.len()).len();
        text.truncate(cut);
        text.push_str(MORE);
    }
    text
}

/// 草稿 id 的样子：32 位小写 hex（前端每份草稿生成一个，发成功才换）
pub fn valid_draft_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 请求体：安装 ID 只在自动上报开着（`auto_report`）时带上
pub fn feedback_report(
    id: &str,
    text: &str,
    shots: Vec<String>,
    auto_report: bool,
    install_id: Option<&str>,
    diagnostics: String,
    app: AppInfo<'_>,
) -> FeedbackReport {
    FeedbackReport {
        id: id.to_owned(),
        text: text.to_owned(),
        shots,
        install_id: install_id.filter(|_| auto_report).map(str::to_owned),
        diagnostics,
        version: app.version.to_owned(),
        os: app.os.to_owned(),
        arch: app.arch.to_owned(),
    }
}

/// 上传截图的地址：只看有没有接收服务的基址（开发版、自己编译的版本没有）。`DO_NOT_TRACK` 不管它——反馈是用户自己点的
pub fn shot_endpoint(base: Option<&str>) -> Option<String> {
    endpoint(base, None, "/v1/shot")
}

/// 发送反馈的地址（同 [`shot_endpoint`] 的规则）
pub fn feedback_endpoint(base: Option<&str>) -> Option<String> {
    endpoint(base, None, "/v1/feedback")
}

/// 上传截图、发送反馈没成的原因：界面据它在按钮行说一句（R14）。序列化成 camelCase 的名字给前端
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    /// 连不上、超时、读断了
    Network,
    /// 429：发得太频繁
    RateLimited,
    /// 5xx（含 503 `full` / `busy`）、读不懂的回答
    Server,
    /// 413：内容太大
    TooLarge,
    /// 400 `bad_shot`：截图过期（传上去超过 24 小时）或已经挂到别的反馈上了。界面把截图重传一遍再发
    ShotExpired,
    /// 别的（400 之类：这份构建与接收服务对不上）
    Other,
}

/// `POST /v1/shot` 的结果：200 `{"id": "<32 位 hex>"}` 是截图 id，别的按状态码归类
pub fn shot_outcome(status: u16, body: &[u8]) -> Result<String, Failure> {
    if status == 200 {
        let id = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("id")?.as_str().map(str::to_owned))
            .filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()));
        return id.ok_or(Failure::Server);
    }
    Err(failure_of(status))
}

/// `POST /v1/feedback` 的结果：只有 200 `{"ok": true}` 算发出去了
pub fn send_outcome(status: u16, body: &[u8]) -> Result<(), Failure> {
    if status == 200 {
        let ok = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("ok")?.as_bool());
        return if ok == Some(true) {
            Ok(())
        } else {
            Err(Failure::Server)
        };
    }
    let code = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_owned));
    if status == 400 && code.as_deref() == Some("bad_shot") {
        return Err(Failure::ShotExpired);
    }
    Err(failure_of(status))
}

/// 请求体按序列化后的字节控制在 [`REQUEST_MAX_BYTES`] 以内：超了就从诊断内容的末尾再截（按字符边界，末尾补 `…`），
/// 二分找放得下的最长一段（转义让原文与序列化后的长度不成比例）。用户写的话不动；诊断截空了还放不下就原样交出去，
/// 接收服务回 413
pub fn fit_body(report: FeedbackReport) -> FeedbackReport {
    const MORE: &str = "\n…";
    let size = |r: &FeedbackReport| serde_json::to_vec(r).map_or(usize::MAX, |b| b.len());
    if size(&report) <= REQUEST_MAX_BYTES {
        return report;
    }
    let full = report.diagnostics.clone();
    let with = |keep: usize| {
        let mut r = report.clone();
        let kept = head(&full, keep);
        r.diagnostics = if kept.is_empty() {
            String::new()
        } else {
            format!("{kept}{MORE}")
        };
        r
    };
    // 不变式：保留 `lo` 字节放得下（0 时诊断为空，放不下也只能这样）；保留 `hi` 字节放不下
    let (mut lo, mut hi) = (0, full.len());
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if size(&with(mid)) <= REQUEST_MAX_BYTES {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    with(lo)
}

fn failure_of(status: u16) -> Failure {
    match status {
        413 => Failure::TooLarge,
        429 => Failure::RateLimited,
        500..=599 => Failure::Server,
        _ => Failure::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DRAFT: &str = "0123456789abcdef0123456789abcdef";

    const APP: AppInfo<'static> = AppInfo {
        version: "0.2.0",
        os: "macOS 15",
        arch: "aarch64",
    };

    fn line(day: &str, level: &str, message: &str) -> String {
        format!("{day} 09:05:07+08:00 [sophia_lib][{level}] {message}")
    }

    #[test]
    fn recent_problems_are_warn_and_error_lines_of_the_last_three_days() {
        let log = [
            line("2026-10-01", "ERROR", "四天前的错"),
            line("2026-10-02", "WARN", "三天前的警告"),
            line("2026-10-03", "INFO", "普通的一行"),
            line("2026-10-03", "ERROR", "前天的错"),
            "  续行（多行消息的第二行）".to_owned(),
            line("2026-10-04", "WARN", "今天的警告"),
            line("2026-10-05", "ERROR", "比今天晚（改过系统时间）"),
            "坏行 [x][ERROR] 没有日期".to_owned(),
        ]
        .join("\n");
        let got = recent_problems(&log, "2026-10-04");
        assert_eq!(
            got,
            vec![
                line("2026-10-02", "WARN", "三天前的警告"),
                line("2026-10-03", "ERROR", "前天的错"),
                line("2026-10-04", "WARN", "今天的警告"),
            ]
        );
    }

    #[test]
    fn recent_problems_keep_only_the_last_fifty_in_order() {
        let log: Vec<String> = (0..80)
            .map(|i| line("2026-10-04", "ERROR", &format!("第 {i} 个错")))
            .collect();
        let log = log.join("\n");
        let got = recent_problems(&log, "2026-10-04");
        assert_eq!(got.len(), LOG_LINES);
        assert!(got[0].ends_with("第 30 个错"), "{}", got[0]);
        assert!(got[49].ends_with("第 79 个错"), "{}", got[49]);
        // CRLF 结尾的日志也认
        let crlf = format!("{}\r\n", line("2026-10-04", "WARN", "x"));
        assert_eq!(recent_problems(&crlf, "2026-10-04").len(), 1);
    }

    #[test]
    fn diagnostics_has_version_os_arch_attached_error_and_log_all_redacted() {
        let log = [
            line("2026-10-04", "INFO", "启动"),
            line(
                "2026-10-04",
                "ERROR",
                "读 /Users/alice/work/SecretProject/config.toml: 失败",
            ),
        ]
        .join("\n");
        let text = diagnostics(&DiagnosticsInput {
            app: APP,
            attached: Some(
                "Error: 读不出 ~/work/ClientX/a.json: key sk-abcdefghijklmnopqrstuvwx1234",
            ),
            log: &log,
            today: "2026-10-04",
        });
        for want in [
            "version: 0.2.0",
            "os: macOS 15",
            "arch: aarch64",
            "Error: 读不出",
        ] {
            assert!(text.contains(want), "{want}\n{text}");
        }
        assert!(text.contains("…/config.toml: 失败"), "{text}");
        assert!(text.contains("…/a.json"), "{text}");
        for gone in [
            "alice",
            "SecretProject",
            "ClientX",
            "sk-abcdefghijklmnopqrstuvwx1234",
            "启动",
        ] {
            assert!(!text.contains(gone), "{gone}\n{text}");
        }
    }

    #[test]
    fn diagnostics_without_attached_error_or_log_problems_says_so_briefly() {
        let text = diagnostics(&DiagnosticsInput {
            app: APP,
            attached: None,
            log: "",
            today: "2026-10-04",
        });
        assert!(
            text.starts_with("version: 0.2.0\nos: macOS 15\narch: aarch64"),
            "{text}"
        );
        assert!(!text.contains("Attached error"), "{text}");
        assert!(text.len() < 200, "{text}");
    }

    #[test]
    fn diagnostics_are_capped_at_32_kib_on_a_char_boundary() {
        let long = "错".repeat(20_000);
        let log: Vec<String> = (0..50)
            .map(|i| {
                line(
                    "2026-10-04",
                    "ERROR",
                    &format!("{i} {}", "误".repeat(2_000)),
                )
            })
            .collect();
        let text = diagnostics(&DiagnosticsInput {
            app: APP,
            attached: Some(&long),
            log: &log.join("\n"),
            today: "2026-10-04",
        });
        assert!(text.len() <= DIAGNOSTICS_MAX_BYTES, "{}", text.len());
        assert!(text.len() > DIAGNOSTICS_MAX_BYTES - 16, "{}", text.len());
        assert!(text.starts_with("version: 0.2.0"));
    }

    #[test]
    fn install_id_goes_out_only_while_auto_report_is_on() {
        let on = feedback_report(
            DRAFT,
            "打不开",
            vec!["a".repeat(32)],
            true,
            Some("3f0c0f9e-0000-4000-8000-000000000000"),
            "d".into(),
            APP,
        );
        assert_eq!(
            on.install_id.as_deref(),
            Some("3f0c0f9e-0000-4000-8000-000000000000")
        );
        let off = feedback_report(
            DRAFT,
            "打不开",
            vec![],
            false,
            Some("3f0c0f9e-0000-4000-8000-000000000000"),
            "d".into(),
            APP,
        );
        assert_eq!(off.install_id, None);
        // 关着时请求体里没有 installId 这一项；字段名照接收服务的 camelCase
        let json = serde_json::to_value(&off).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": DRAFT, "text": "打不开", "shots": [], "diagnostics": "d",
                "version": "0.2.0", "os": "macOS 15", "arch": "aarch64"
            })
        );
        let json = serde_json::to_value(&on).unwrap();
        assert_eq!(json["installId"], "3f0c0f9e-0000-4000-8000-000000000000");
        assert_eq!(json["shots"][0], "a".repeat(32));
    }

    #[test]
    fn shot_outcome_takes_the_id_and_sorts_failures() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            shot_outcome(200, format!("{{\"id\":\"{id}\"}}").as_bytes()),
            Ok(id.to_owned())
        );
        // 200 却读不懂、id 不是 32 位 hex：算服务出错
        assert_eq!(shot_outcome(200, b"oops"), Err(Failure::Server));
        assert_eq!(shot_outcome(200, br#"{"id":"../x"}"#), Err(Failure::Server));
        assert_eq!(
            shot_outcome(413, br#"{"error":"too_large"}"#),
            Err(Failure::TooLarge)
        );
        assert_eq!(
            shot_outcome(429, br#"{"error":"rate_limited"}"#),
            Err(Failure::RateLimited)
        );
        assert_eq!(
            shot_outcome(503, br#"{"error":"full"}"#),
            Err(Failure::Server)
        );
        assert_eq!(
            shot_outcome(400, br#"{"error":"bad_image"}"#),
            Err(Failure::Other)
        );
    }

    #[test]
    fn send_outcome_is_ok_only_for_200_ok_true() {
        assert_eq!(send_outcome(200, br#"{"ok":true}"#), Ok(()));
        assert_eq!(send_outcome(200, br#"{"ok":false}"#), Err(Failure::Server));
        assert_eq!(send_outcome(200, b""), Err(Failure::Server));
        assert_eq!(
            send_outcome(503, br#"{"error":"busy"}"#),
            Err(Failure::Server)
        );
        assert_eq!(send_outcome(500, b""), Err(Failure::Server));
        assert_eq!(send_outcome(429, b""), Err(Failure::RateLimited));
        assert_eq!(send_outcome(413, b""), Err(Failure::TooLarge));
        // 截图过期（24 小时）或已用过：重传截图再发
        assert_eq!(
            send_outcome(400, br#"{"error":"bad_shot"}"#),
            Err(Failure::ShotExpired)
        );
        assert_eq!(
            send_outcome(400, br#"{"error":"bad_text"}"#),
            Err(Failure::Other)
        );
        assert_eq!(
            serde_json::to_value(Failure::ShotExpired).unwrap(),
            serde_json::json!("shotExpired")
        );
        // 前端按名字认
        assert_eq!(
            serde_json::to_value(Failure::RateLimited).unwrap(),
            serde_json::json!("rateLimited")
        );
    }

    #[test]
    fn endpoints_need_only_a_base_url() {
        assert_eq!(
            shot_endpoint(Some("https://r.example.dev/")).as_deref(),
            Some("https://r.example.dev/v1/shot")
        );
        assert_eq!(
            feedback_endpoint(Some(" https://r.example.dev ")).as_deref(),
            Some("https://r.example.dev/v1/feedback")
        );
        assert_eq!(shot_endpoint(None), None);
        assert_eq!(feedback_endpoint(Some("  ")), None);
    }

    #[test]
    fn body_bytes_stay_under_64_kib_by_cutting_diagnostics() {
        let fits = |r: &FeedbackReport| serde_json::to_vec(r).unwrap().len() <= REQUEST_MAX_BYTES;
        // 诊断里全是要转义的字符（换行、引号、控制字符）：32 KiB 的原文序列化后远超 64 KiB
        let escaped = "\"\n\u{1}".repeat(DIAGNOSTICS_MAX_BYTES / 3);
        let report = feedback_report(DRAFT, "打不开", vec![], false, None, escaped.clone(), APP);
        assert!(!fits(&report));
        let fitted = fit_body(report);
        assert!(
            fits(&fitted),
            "{}",
            serde_json::to_vec(&fitted).unwrap().len()
        );
        assert!(fitted.diagnostics.len() > 1000, "只截到放得下为止");
        assert!(escaped.starts_with(fitted.diagnostics.trim_end_matches('…')));
        // 放得下的原样
        let small = feedback_report(DRAFT, "打不开", vec![], false, None, "d".into(), APP);
        assert_eq!(fit_body(small.clone()), small);
    }

    /// 草稿 id（幂等：同一份草稿重试复用同一个 id）只认 32 位小写 hex
    #[test]
    fn draft_ids_are_32_lowercase_hex() {
        assert!(valid_draft_id(DRAFT));
        for bad in [
            "",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcdeg",
        ] {
            assert!(!valid_draft_id(bad), "{bad}");
        }
    }
}

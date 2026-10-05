//! 应用内反馈的应用侧（spec 2026-10-04-reporting-feedback R12–R14）：截图一放进来就上传（`POST /v1/shot`），
//! 发送时组装诊断内容、发 `POST /v1/feedback`。诊断内容与请求体怎么拼、回答怎么归类在
//! `sophia_core::report::feedback`，这里只读日志、接线、发请求。
//!
//! 与自动上报同一个接收服务、同一套地址规则（`report.rs` 的 `base_url`），只编进公开版。`DO_NOT_TRACK` 不管反馈：
//! 反馈是用户自己点的。安装 ID 只在自动上报此刻在生效（开关开着、没设 `DO_NOT_TRACK`）时带上。
use crate::{diagnostics, report, AppState};
use sophia_core::report::feedback::{self, AppInfo, DiagnosticsInput, Failure};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request};

/// 一张截图最大多少字节（接收服务同一上限）。网页侧压到 400 KB 以内，这里只兜底
const SHOT_MAX_BYTES: usize = 1024 * 1024;
/// 读日志末尾这么多字节找最近的 WARN / ERROR（日志单个文件到 5 MB 才换）
const LOG_TAIL_BYTES: u64 = 256 * 1024;
const SHOT_TIMEOUT: Duration = Duration::from_secs(60);
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// 这份构建、这次运行有没有接收服务（有才画 `反馈问题`、`报告这个问题`）
pub fn available() -> bool {
    feedback::shot_endpoint(report::base_url().as_deref()).is_some()
}

/// 上传一张截图：网页交来的是 JPEG 字节（Tauri 原始请求体，不经 JSON），这里转成 base64 文本一次发出
/// （`content-type: text/plain`，接收服务按文本存）。不报进度：界面只按时间模拟（交给 socket 的字节一开始就接近
/// 100%，拿它当进度没有意义，真机 2026-10-05）。回截图 id
#[tauri::command]
pub async fn feedback_upload_shot(request: Request<'_>) -> Result<String, Failure> {
    let url = feedback::shot_endpoint(report::base_url().as_deref()).ok_or(Failure::Other)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Failure::Other);
    };
    if bytes.len() > SHOT_MAX_BYTES {
        return Err(Failure::TooLarge);
    }
    if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(Failure::Other);
    }
    let client = report::client_with(SHOT_TIMEOUT).map_err(|_| Failure::Network)?;
    let resp = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(shot_body(bytes))
        .send()
        .await;
    let (status, head) = report::read_head(resp).await.map_err(|e| {
        log::warn!("反馈截图没传上去：{e}");
        Failure::Network
    })?;
    feedback::shot_outcome(status, &head).inspect_err(|f| {
        log::warn!("反馈截图接收服务不收（HTTP {status}，{f:?}）");
    })
}

/// 发送反馈：草稿 id（重试复用，接收服务据它去重）、用户写的话、已传上去的截图 id、出错页带来的那条错误
/// （已去隐私，这里再过一遍）
#[tauri::command]
pub async fn feedback_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    text: String,
    shots: Vec<String>,
    attached: Option<String>,
) -> Result<(), Failure> {
    let url = feedback::feedback_endpoint(report::base_url().as_deref()).ok_or(Failure::Other)?;
    if !feedback::valid_draft_id(&id) || text.trim().is_empty() || shots.len() > feedback::MAX_SHOTS
    {
        return Err(Failure::Other);
    }
    // 自动上报此刻在生效才带安装 ID（关着、或 DO_NOT_TRACK 时不带）
    let auto_report = report::active(&state.store);
    let install_id = if auto_report {
        state.store.report_install_id().ok().flatten()
    } else {
        None
    };
    let log = read_tail(&diagnostics::log_file(), LOG_TAIL_BYTES).unwrap_or_default();
    let version = app.package_info().version.to_string();
    let os = report::os_major();
    let app_info = AppInfo {
        version: &version,
        os: &os,
        arch: std::env::consts::ARCH,
    };
    let today = report::today();
    let diagnostics = feedback::diagnostics(&DiagnosticsInput {
        app: app_info,
        attached: attached.as_deref(),
        log: &log,
        today: &today,
    });
    // 整条请求体按序列化后的字节放进 64 KiB（诊断里要转义的字符会把它撑大）
    let body = feedback::fit_body(feedback::feedback_report(
        &id,
        &text,
        shots,
        auto_report,
        install_id.as_deref(),
        diagnostics,
        app_info,
    ));
    let client = report::client_with(SEND_TIMEOUT).map_err(|_| Failure::Network)?;
    let (status, head) = report::post_json(&client, &url, &body).await.map_err(|e| {
        log::warn!("反馈没发出去：{e}");
        Failure::Network
    })?;
    feedback::send_outcome(status, &head).inspect_err(|f| {
        log::warn!("反馈接收服务不收（HTTP {status}，{f:?}）");
    })
}

/// 截图的请求体：JPEG 的标准 base64（带补齐）整段（接收服务按 base64 文本存）
fn shot_body(jpeg: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(jpeg)
}

/// 读文件末尾至多 `max` 字节（UTF-8 有损转换）；不是从头读的，丢掉第一段不完整的行
fn read_tail(path: &Path, max: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    if start == 0 {
        return Ok(text.into_owned());
    }
    Ok(text
        .split_once('\n')
        .map_or_else(String::new, |(_, rest)| rest.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_tail_reads_whole_small_files_and_drops_the_cut_line_of_big_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sophia.log");
        std::fs::write(&path, "第一行\n第二行\n").unwrap();
        assert_eq!(read_tail(&path, 1024).unwrap(), "第一行\n第二行\n");
        // 只读末尾 12 字节：从「行\n第二行\n」的中间开始，被切开的那一段丢掉
        let text = "aaaa\nbbbb\ncccc\n";
        std::fs::write(&path, text).unwrap();
        assert_eq!(read_tail(&path, 12).unwrap(), "bbbb\ncccc\n");
        // 恰好从一行开头切也只丢到第一个换行为止（宁可少一行）
        assert_eq!(read_tail(&path, 10).unwrap(), "cccc\n");
        // 多字节字符被切开不报错
        std::fs::write(&path, "错错错\n对\n").unwrap();
        assert_eq!(read_tail(&path, 7).unwrap(), "对\n");
        // 没有文件：报错，调用方当空
        assert!(read_tail(&dir.path().join("none.log"), 10).is_err());
    }

    /// 截图一次发整段标准 base64（带补齐）：解得回原样
    #[test]
    fn shot_body_is_one_padded_standard_base64_text() {
        use base64::Engine;
        let jpeg: Vec<u8> = [0xFF, 0xD8, 0xFF]
            .into_iter()
            .chain((0..40_000u32).map(|i| (i % 251) as u8))
            .collect();
        let text: String = shot_body(&jpeg);
        assert_eq!(text.len() % 4, 0, "带补齐");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&text)
            .unwrap();
        assert_eq!(decoded, jpeg);
        assert_eq!(shot_body(&[0xFF, 0xD8, 0xFF, 0x00]), "/9j/AA==");
    }
}

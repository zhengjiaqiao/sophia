//! Sophia 自己的更新（DESIGN「设置 › 检查更新」）：查清单、下载并安装在这里调更新插件
//! （原来前端直接调插件的 JS 接口，出错只拿得到一句英文），出错按 `net_kind` 分四类交给前端，
//! 由前端按「检查更新」「下载更新」两个场景出主句与出口（issue #253）。装完重启仍由前端调 process 插件。
//! 错误走命令错误的老约定 `[类] 一句\n[detail] 原文`（一句界面不用，主句由前端按类出）。
//! 查清单与下载都按线路逐个试（GitHub → 国内线路，issue #262）：插件自己的多地址只管查清单、下载失败不换，
//! 所以这里一条线路建一个更新器。验签仍是插件做，签名里要写着版本号（`tauri.conf.json` 的 `requireSignedVersion`）。

use crate::net_kind::{self, NetKind, NetProblem};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// 每一步的时限。连接是「GitHub 不通几秒内换线路」的那一道（DNS 被污染、被重置是立刻失败，被丢包要等它）；
/// 查清单另有总时限（连上了但迟迟不回）；下载不设总时限（包有几 MB，慢网要下一阵），只限「多久没收到一个字节」。
/// `direct` 只给测试：本机假服务器不该经过系统代理
pub(crate) struct Limits {
    connect: Duration,
    check: Duration,
    read: Duration,
    direct: bool,
}

const LIMITS: Limits = Limits {
    connect: Duration::from_secs(5),
    check: Duration::from_secs(10),
    read: Duration::from_secs(20),
    direct: false,
};

/// 在第 `line` 条线路上查到的新版
#[derive(Clone)]
pub(crate) struct Found {
    update: Update,
    line: usize,
}

impl Found {
    pub(crate) fn version(&self) -> &str {
        &self.update.version
    }
}

/// 线路：`tauri.conf.json` 的 `plugins.updater.endpoints`，按先后（GitHub 在前、国内线路在后），一个地址一条
fn lines<R: Runtime>(app: &AppHandle<R>) -> Vec<Url> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| serde_json::from_value(endpoints.clone()).ok())
        .unwrap_or_default()
}

/// 只认一条线路的更新器
fn updater_on<R: Runtime>(
    app: &AppHandle<R>,
    line: &Url,
    limits: &Limits,
) -> tauri_plugin_updater::Result<Updater> {
    let (connect, read) = (limits.connect, limits.read);
    let builder = app
        .updater_builder()
        .endpoints(vec![line.clone()])?
        .timeout(limits.check)
        // 插件把这一步也用在下载上（查到的 `Update` 带着同一份设置）
        .configure_client(move |client| client.connect_timeout(connect).read_timeout(read));
    if limits.direct {
        builder.no_proxy().build()
    } else {
        builder.build()
    }
}

/// 在一条线路上查清单
async fn check_on<R: Runtime>(
    app: &AppHandle<R>,
    line: &Url,
    limits: &Limits,
) -> Result<Option<Update>, NetProblem> {
    let found = match updater_on(app, line, limits) {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    found.map_err(|e| on_line(line, &e))
}

/// 按线路先后查清单：哪条查成了（有新版或没有）就听哪条；任一条失败（连不上、超时、非 2xx、清单不合格）换下一条。
/// 都失败时按国内线路（最后一条）那条归类
pub(crate) async fn check<R: Runtime>(
    app: &AppHandle<R>,
    lines: &[Url],
    limits: &Limits,
) -> Result<Option<Found>, NetProblem> {
    let mut tried = Vec::new();
    for (line, url) in lines.iter().enumerate() {
        match check_on(app, url, limits).await {
            Ok(update) => return Ok(update.map(|update| Found { update, line })),
            Err(problem) => tried.push(problem),
        }
    }
    Err(NetProblem::across_lines(tried))
}

/// 下载查到的那一版并验签：先从查到它的那条线路下；不成就到后面的线路上重查清单、从那里下，
/// 那条线路给的必须是同一版（界面上说的就是这一版）。签名每条线路都照样验。都失败时按国内线路那条归类。
/// 进度（百分比，拿不到总大小时为 None）换线路时从头算
pub(crate) async fn download<R: Runtime>(
    app: &AppHandle<R>,
    lines: &[Url],
    found: &Found,
    limits: &Limits,
    mut on_progress: impl FnMut(Option<u8>),
) -> Result<(Update, Vec<u8>), NetProblem> {
    let mut tried = Vec::new();
    for (line, url) in lines.iter().enumerate().skip(found.line) {
        let update = if line == found.line {
            found.update.clone()
        } else {
            match check_on(app, url, limits).await {
                Ok(Some(update)) if update.version == found.update.version => update,
                Ok(other) => {
                    let offered = other.map_or("no update".to_string(), |u| u.version);
                    tried.push(NetProblem {
                        kind: NetKind::Other,
                        detail: format!(
                            "{}\noffers {offered}, not {}",
                            sophia_core::redact::redact(url.as_str()),
                            found.update.version
                        ),
                    });
                    continue;
                }
                Err(problem) => {
                    tried.push(problem);
                    continue;
                }
            }
        };
        let mut got: u64 = 0;
        let progress = |chunk: usize, total: Option<u64>| {
            got += chunk as u64;
            on_progress(
                total
                    .filter(|t| *t > 0)
                    .map(|t| (got.saturating_mul(100) / t).min(100) as u8),
            );
        };
        match update.download(progress, || {}).await {
            Ok(bytes) => return Ok((update, bytes)),
            Err(e) => tried.push(on_line(&update.download_url, &e)),
        }
    }
    Err(NetProblem::across_lines(tried))
}

/// 最近查到的那个新版本：下载并安装要用它。`lib.rs` 里 `.manage(UpdateState::default())`
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Found>>);

impl UpdateState {
    fn latest(&self) -> Option<Found> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn remember(&self, found: Option<Found>) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = found;
    }
}

/// 查有没有新版：有给版本号，没有给 None
#[tauri::command]
pub async fn app_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<Option<String>, String> {
    let found = check(&app, &lines(&app), &LIMITS)
        .await
        .map_err(|p| p.command_error("could not check for updates on any line"))?;
    let version = found.as_ref().map(|f| f.version().to_string());
    state.remember(found);
    Ok(version)
}

/// 下载并安装最近查到的那一版；进度（百分比，拿不到总大小时为 None）经 `on_progress` 发回
#[tauri::command]
pub async fn app_update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    on_progress: Channel<Option<u8>>,
) -> Result<(), String> {
    let found = state.latest().ok_or_else(|| {
        NetProblem {
            kind: NetKind::Other,
            detail: String::new(),
        }
        .command_error("no update to install: check for updates first")
    })?;
    let (update, bytes) = download(&app, &lines(&app), &found, &LIMITS, |percent| {
        let _ = on_progress.send(percent);
    })
    .await
    .map_err(|p| p.command_error("could not download the update on any line"))?;
    update.install(bytes).map_err(|e| failed(&e))
}

/// 一条线路上的失败：原文前面写明是哪个地址（「!」里看得出是哪条线路、哪一步）
fn on_line(url: &Url, error: &tauri_plugin_updater::Error) -> NetProblem {
    let problem = problem(error);
    NetProblem {
        kind: problem.kind,
        detail: format!(
            "{}\n{}",
            sophia_core::redact::redact(url.as_str()),
            problem.detail
        ),
    }
}

/// 命令错误：插件原话一句 + 分类与整条原文
fn failed(error: &tauri_plugin_updater::Error) -> String {
    problem(error).command_error(&sophia_core::redact::redact(&error.to_string()))
}

/// 更新插件的一个错误 → 哪一类 + 原文（整条源错误链，去隐私）
fn problem(error: &tauri_plugin_updater::Error) -> NetProblem {
    use tauri_plugin_updater::Error as E;
    let kind = match error {
        // 这两种是透明包装（源错误链跳过被包的那一层）：要拿被包的错误本身才问得到是不是超时、是不是连不上
        E::Reqwest(inner) => net_kind::of_error(inner),
        E::Io(inner) => net_kind::of_error(inner),
        // 下载回了非 2xx：插件只把状态写进句子（`Download request failed with status: 429 Too Many Requests`），
        // 限流头也丢了
        E::Network(text) => status_in(text).map_or(NetKind::Other, |status| {
            net_kind::of_status(status, None, None)
        }),
        other => net_kind::of_error(other),
    };
    NetProblem {
        kind,
        detail: sophia_core::redact::redact(&net_kind::chain_parts(error).join(": ")),
    }
}

/// 插件句子里 `status: ` 后面的状态码
fn status_in(text: &str) -> Option<u16> {
    let (_, rest) = text.rsplit_once("status: ")?;
    rest.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
#[path = "app_update/line_tests.rs"]
mod line_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error as E;

    #[test]
    fn download_status_is_read_from_the_plugin_sentence() {
        let e = E::Network("Download request failed with status: 429 Too Many Requests".into());
        assert_eq!(problem(&e).kind, NetKind::RateLimited);
        let e = E::Network("Download request failed with status: 504 Gateway Timeout".into());
        assert_eq!(problem(&e).kind, NetKind::Timeout);
        let e = E::Network("Download request failed with status: 404 Not Found".into());
        let p = problem(&e);
        assert_eq!(p.kind, NetKind::Other);
        assert!(p.detail.contains("404 Not Found"), "{}", p.detail);
    }

    #[test]
    fn plugin_errors_keep_their_cause() {
        let e = E::Io(std::io::Error::from(std::io::ErrorKind::ConnectionReset));
        assert_eq!(problem(&e).kind, NetKind::Unreachable);
        // 清单读回来了但不对（或全部地址都回了非 2xx）：别的
        assert_eq!(problem(&E::ReleaseNotFound).kind, NetKind::Other);
    }

    #[test]
    fn request_errors_inside_the_plugin_error() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/latest.json", closed.local_addr().unwrap());
        drop(closed);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let e = tauri::async_runtime::block_on(client.get(&url).send()).expect_err("应当失败");
        let p = problem(&E::Reqwest(e));
        assert_eq!(p.kind, NetKind::Unreachable);
        // 原文带着地址：「!」里看得出是哪一步、哪条线路
        assert!(p.detail.contains("/latest.json"), "{}", p.detail);
    }
}

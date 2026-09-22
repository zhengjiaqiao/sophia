//! 模型页的命令层与无界面入口。逻辑都在 `symsync-gateway`，这里只做转接。
//! 命令约定见 docs/gateway-commands.md。
use crate::AppState;
use std::sync::Arc;
use symsync_core::codex_models::catalog::Model;
use symsync_gateway::app::{App, AppError, GatewayState};
use symsync_gateway::process::RestartReport;
use symsync_gateway::runtime;

/// `symsync gateway …`：launchd 拉起的就是这个可执行文件的副本，参数为 `gateway run …`
pub fn cli(args: Vec<String>) -> i32 {
    match crate::runtime_store_dir() {
        Ok(dir) => runtime::cli(args, dir),
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// 仅 macOS 提供这项功能；其他系统上界面据 `supported: false` 隐藏标签页
pub fn build(store_dir: std::path::PathBuf) -> Option<Arc<App>> {
    cfg!(target_os = "macos").then(|| Arc::new(runtime::build_app(store_dir)))
}

fn app(state: &AppState) -> Result<Arc<App>, String> {
    state
        .gateway
        .clone()
        .ok_or_else(|| "[invalid] 这项功能目前只支持 macOS".to_owned())
}

/// 编排层是同步的（读写文件、调 launchctl、等路由就绪），放到阻塞线程池里跑，不占异步运行时线程
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("[internal] {e}"))?
        .map_err(|e| e.to_string())
}

async fn current_state(app: Arc<App>) -> Result<GatewayState, String> {
    blocking(move || Ok(app.state())).await
}

#[tauri::command]
pub async fn gateway_state(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    match state.gateway.clone() {
        Some(app) => current_state(app).await,
        None => Ok(GatewayState::default()),
    }
}

#[tauri::command]
pub async fn gateway_save_provider(
    base_url: String,
    key: String,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 联网校验放在拿锁之前：锁只保护写文件的那一小段，否则 MCP 的同步命令会被一次网络请求卡住十秒
    let verified = if key.trim().is_empty() {
        None
    } else {
        // 先用新密钥向网关校验；失败就什么都不保存，错误的密钥不会覆盖钥匙串里原本好用的那个
        let cleaned = symsync_gateway::app::clean_base_url(&base_url).map_err(|e| e.to_string())?;
        Some(
            runtime::fetch_models(&cleaned, key.trim())
                .await
                .map_err(|e| e.to_string())?,
        )
    };
    // 这把锁会跨 .await 持有，必须是 tokio::sync::Mutex（std 的 guard 不是 Send，还会阻塞运行时线程）。
    // 后面新增的异步命令只要会写 ~/.codex/config.toml，都照此办理。
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        match verified {
            None => blocking(move || worker.save_provider(&base_url)).await?,
            Some((ids, api_base)) => {
                blocking(move || worker.commit_verified_provider(&base_url, &key, ids, &api_base))
                    .await?
            }
        }
    }
    current_state(app).await
}

/// `provider_id` 省略时作用在第一家上（旧界面的调用方式）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSaved {
    /// 新建时是刚生成的 id，界面据此定位新卡片
    provider_id: String,
    state: GatewayState,
}

/// 新建或修改一家网关。`id` 省略是新建（id 由 `name` 生成，之后不变）；
/// `key` 省略或为空表示不动已存的密钥。带了密钥就先向网关校验，校验失败什么都不保存。
#[tauri::command]
pub async fn gateway_upsert_provider(
    id: Option<String>,
    name: Option<String>,
    base_url: String,
    key: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ProviderSaved, String> {
    let app = app(&state)?;
    let key = key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    // 联网校验放在拿锁之前，理由同 gateway_save_provider
    let verified = match &key {
        None => None,
        Some(key) => {
            let cleaned =
                symsync_gateway::app::clean_base_url(&base_url).map_err(|e| e.to_string())?;
            Some(
                runtime::fetch_models(&cleaned, key)
                    .await
                    .map_err(|e| e.to_string())?,
            )
        }
    };
    let provider_id = {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || match (verified, key) {
            (Some((ids, api_base)), Some(key)) => worker.commit_verified_provider_for(
                id.as_deref(),
                name.as_deref(),
                &base_url,
                &key,
                ids,
                &api_base,
            ),
            _ => worker.upsert_provider(id.as_deref(), name.as_deref(), &base_url),
        })
        .await?
    };
    Ok(ProviderSaved {
        provider_id,
        state: current_state(app).await?,
    })
}

/// 删掉一家网关，连同它在钥匙串里的密钥（删了回不来，确认由界面负责）
#[tauri::command]
pub async fn gateway_remove_provider(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.remove_provider(&id)).await?;
    }
    current_state(app).await
}

#[tauri::command]
pub async fn gateway_fetch_models(
    provider_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let worker = app.clone();
    let target = provider_id.clone();
    let (base_url, key) = blocking(move || match target {
        Some(id) => worker.provider_for_fetch_of(&id),
        None => worker.provider_for_fetch(),
    })
    .await?;
    let fetched = runtime::fetch_models_detailed(&base_url, &key).await;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    let guard = state.config_lock.lock().await;
    let worker = app.clone();
    match fetched {
        Ok((ids, api_base)) => {
            blocking(move || match provider_id {
                Some(id) => worker.merge_fetched_models_for(&id, ids, &api_base),
                None => worker.merge_fetched_models(ids, &api_base),
            })
            .await?;
        }
        Err(failure) => {
            // 连不上是那一家的状态：先把原因记下来（界面重读 state 就能在那一行显示），再照旧报错
            if let Some(reason) = failure.unreachable {
                blocking(move || match provider_id {
                    Some(id) => worker.record_unreachable_for(&id, reason),
                    None => worker.record_unreachable(reason),
                })
                .await?;
            }
            return Err(failure.error.to_string());
        }
    }
    drop(guard);
    current_state(app).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModel {
    id: String,
    #[serde(default)]
    display_name: String,
}

/// `provider_id` 省略时作用在第一家上（旧界面的调用方式）
#[tauri::command]
pub async fn gateway_select_models(
    selected: Vec<SelectedModel>,
    provider_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let models = selected
            .into_iter()
            .map(|m| Model {
                id: m.id,
                display_name: Some(m.display_name).filter(|n| !n.trim().is_empty()),
                ..Default::default()
            })
            .collect();
        let worker = app.clone();
        blocking(move || match provider_id {
            Some(id) => worker.set_models_for(&id, models),
            None => worker.set_models(models),
        })
        .await?;
    }
    current_state(app).await
}

#[tauri::command]
pub async fn gateway_enable(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.enable()).await?;
    }
    current_state(app).await
}

#[tauri::command]
pub async fn gateway_restore(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.restore().map(|_| ())).await?;
    }
    current_state(app).await
}

/// 重启我们自己装的 launchd 路由服务。**不重启 Codex**——那是用户的编辑器 / CLI。
/// 它不写 `~/.codex/config.toml`，所以不取 `config_lock`（拿了只会让 MCP 的同步白等）。
#[tauri::command]
pub async fn gateway_restart(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let worker = app.clone();
    blocking(move || worker.restart_router()).await?;
    current_state(app).await
}

/// 结束 Codex 的后台进程（`codex app-server` / `codex-code-mode-host`），
/// 下次任何工具拉起 Codex 时才带着新配置起来。**不碰用户在终端里的交互式会话**。
/// 一个都没找到不算失败，返回 `terminated: 0`。
/// 它不写 `~/.codex/config.toml`，所以不取 `config_lock`
#[tauri::command]
pub async fn gateway_restart_codex(
    state: tauri::State<'_, AppState>,
) -> Result<RestartReport, String> {
    let app = app(&state)?;
    blocking(move || app.restart_codex()).await
}

#[tauri::command]
pub async fn gateway_takeover(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.takeover()).await?;
    }
    current_state(app).await
}

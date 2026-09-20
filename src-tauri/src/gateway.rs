//! 模型页的命令层与无界面入口。逻辑都在 `symsync-gateway`，这里只做转接。
//! 命令约定见 docs/gateway-commands.md。
use crate::AppState;
use std::sync::Arc;
use symsync_core::codex_models::catalog::Model;
use symsync_gateway::app::{App, AppError, GatewayState};
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

#[tauri::command]
pub async fn gateway_fetch_models(
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let worker = app.clone();
    let (base_url, key) = blocking(move || worker.provider_for_fetch()).await?;
    let (ids, api_base) = runtime::fetch_models(&base_url, &key)
        .await
        .map_err(|e| e.to_string())?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.merge_fetched_models(ids, &api_base)).await?;
    }
    current_state(app).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModel {
    id: String,
    #[serde(default)]
    display_name: String,
}

#[tauri::command]
pub async fn gateway_select_models(
    selected: Vec<SelectedModel>,
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
        blocking(move || worker.set_models(models)).await?;
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

//! 模型页的命令层与无界面入口。逻辑都在 `sophia-gateway`，这里只做转接。
//! 命令约定见 docs/gateway-commands.md。
use crate::AppState;
use sophia_core::codex_models::catalog::Model;
use sophia_gateway::app::{Agent, App, AppError, GatewayState, ProviderSaved};
use sophia_gateway::process::RestartReport;
use sophia_gateway::runtime;
use std::sync::Arc;

/// `Sophia gateway …`：launchd 拉起的就是这个可执行文件的副本，参数为 `gateway run …`
pub fn cli(args: Vec<String>) -> i32 {
    match crate::runtime_store_dir() {
        Ok(dir) => runtime::cli(args, dir, crate::language::system_tags),
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
        .ok_or_else(|| format!("[invalid] {}", sophia_core::t!("models.cmd.macOnly")))
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

/// 新建或修改一家网关之后返回：这一家的 id、同步到另一家的那一家的 id（没同步为 null）与最新状态
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSavedState {
    #[serde(flatten)]
    saved: ProviderSaved,
    state: GatewayState,
}

/// 新建或修改 `agent` 这一家的一个网关。`id` 省略是新建（id 由 `name` 生成，之后不变）；
/// `key` 省略或为空表示不动已存的密钥。带了密钥就先向网关校验，校验失败什么都不保存。
/// `sync`：另一家同一地址的网关一起加 / 一起改（spec R40）
#[tauri::command]
pub async fn gateway_upsert_provider(
    agent: Agent,
    id: Option<String>,
    name: Option<String>,
    base_url: String,
    key: Option<String>,
    sync: bool,
    state: tauri::State<'_, AppState>,
) -> Result<ProviderSavedState, String> {
    let app = app(&state)?;
    let key = key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    // 联网校验放在拿锁之前：锁只保护写文件的那一小段，否则 MCP 的同步命令会被一次网络请求卡住十秒。
    // 先用新密钥向网关校验；失败就什么都不保存，错误的密钥不会覆盖钥匙串里原本好用的那个。
    // 同步到另一家时也只联网这一次（R40）
    let verified = match &key {
        None => None,
        Some(key) => {
            let cleaned =
                sophia_gateway::app::clean_base_url(&base_url).map_err(|e| e.to_string())?;
            Some(
                runtime::fetch_models(&cleaned, key)
                    .await
                    .map_err(|e| e.to_string())?,
            )
        }
    };
    // 这把锁会跨 .await 持有，必须是 tokio::sync::Mutex（std 的 guard 不是 Send，还会阻塞运行时线程）。
    // 后面新增的异步命令只要会写 ~/.codex/config.toml 或 Claude 的配置，都照此办理。
    let saved = {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || match (verified, key) {
            (Some((ids, api_base)), Some(key)) => worker.commit_verified_provider_in(
                agent,
                id.as_deref(),
                name.as_deref(),
                &base_url,
                &key,
                ids,
                &api_base,
                sync,
            ),
            _ => worker.upsert_provider_in(agent, id.as_deref(), name.as_deref(), &base_url, sync),
        })
        .await?
    };
    Ok(ProviderSavedState {
        saved,
        state: current_state(app).await?,
    })
}

/// 删掉 `agent` 这一家的一个网关，连同它在钥匙串里的密钥（删了回不来，确认由界面负责）。
/// `also_other`：另一家同一地址的网关连同密钥一起删（R40）
#[tauri::command]
pub async fn gateway_remove_provider(
    agent: Agent,
    id: String,
    also_other: bool,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.remove_provider_in(agent, &id, also_other)).await?;
    }
    current_state(app).await
}

/// 带过来：把 `from` 有、`agent` 没有同一地址的网关复制过来（模型全未选，密钥一并复制）。不联网
#[tauri::command]
pub async fn gateway_copy_providers(
    agent: Agent,
    from: Agent,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.copy_providers(agent, from)).await?;
    }
    current_state(app).await
}

#[tauri::command]
pub async fn gateway_fetch_models(
    agent: Agent,
    provider_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let worker = app.clone();
    let target = provider_id.clone();
    let (base_url, key) = blocking(move || worker.provider_for_fetch_in(agent, &target)).await?;
    let fetched = runtime::fetch_models_detailed(&base_url, &key).await;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    let guard = state.config_lock.lock().await;
    let worker = app.clone();
    match fetched {
        Ok((ids, api_base)) => {
            blocking(move || worker.merge_fetched_models_in(agent, &provider_id, ids, &api_base))
                .await?;
        }
        Err(failure) => {
            // 无法连接是那一家的状态：先把原因记下来（界面重读 state 就能在那一行显示），再照旧报错
            if let Some(reason) = failure.unreachable {
                blocking(move || worker.record_unreachable_in(agent, &provider_id, reason)).await?;
            }
            return Err(failure.error.to_string());
        }
    }
    drop(guard);
    current_state(app).await
}

/// 勾选前试调 `agent` 这一家网关 `provider_id` 的模型 `model_id`：向网关真发一条最小的请求（20 秒为限），
/// 通了返回空，不通返回 `[代码] 原因`（原因给界面显示在那一行）。不写任何文件，所以不取 `config_lock`
#[tauri::command]
pub async fn gateway_probe_model(
    agent: Agent,
    provider_id: String,
    model_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let app = app(&state)?;
    let target =
        blocking(move || app.provider_for_probe_in(agent, &provider_id, &model_id)).await?;
    runtime::probe_target(&target)
        .await
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModel {
    id: String,
    #[serde(default)]
    display_name: String,
}

/// `selected` 是 `agent` 这一家这个网关的完整勾选，不影响别的网关、也不影响另一家。
/// 这里只带 id 与显示名；已存的上下文长度、看图能力由 `set_models_in` 保留（见 `picked_over`）
#[tauri::command]
pub async fn gateway_select_models(
    agent: Agent,
    provider_id: String,
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
        blocking(move || worker.set_models_in(agent, &provider_id, models)).await?;
    }
    current_state(app).await
}

/// 打开这一家。Claude：桌面应用不在运行时当场写，在运行时只记下（待生效，界面出 `重启生效`）
#[tauri::command]
pub async fn gateway_enable(
    agent: Agent,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || match agent {
            Agent::Codex => worker.enable(),
            Agent::Claude => worker.enable_claude().map(|_| ()),
        })
        .await?;
    }
    current_state(app).await
}

/// 关掉这一家（移除本功能写进它配置里的一切；网关、模型与密钥保留）。
/// 还原的提示不经命令上界面（spec R33），命令行 `Sophia gateway restore` 会打印
#[tauri::command]
pub async fn gateway_restore(
    agent: Agent,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || match agent {
            Agent::Codex => worker.restore(),
            Agent::Claude => worker.restore_claude(),
        })
        .await?;
    }
    current_state(app).await
}

/// 打开 Claude 桌面应用（R49）：有待生效的先写（写失败不打开），再打开并等到它在运行（上限 20 秒）。
/// 锁只在写文件那一段取（`acquire`），等它打开时不占着——MCP 的同步命令也要写 Claude 的配置
#[tauri::command]
pub async fn gateway_launch_claude(
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let lock = state.config_lock.clone();
    let worker = app.clone();
    // 在阻塞线程池里跑，那里可以 blocking_lock（它不能在 tokio 运行时线程上调用）
    blocking(move || worker.launch_claude(|| lock.blocking_lock())).await?;
    current_state(app).await
}

/// 重启 Claude 桌面应用让改动生效（R50）：让它退出（最多 15 秒，不强杀）→ 写 → 重新打开。
/// 锁只在写文件那一段取，等退出、等打开时不占着
#[tauri::command]
pub async fn gateway_restart_claude(
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let lock = state.config_lock.clone();
    let worker = app.clone();
    blocking(move || worker.restart_claude(|| lock.blocking_lock())).await?;
    current_state(app).await
}

#[tauri::command]
pub async fn gateway_restart(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let worker = app.clone();
    blocking(move || worker.restart_router()).await?;
    current_state(app).await
}

/// 重启生效：Codex 桌面应用开着就先让它退出（最多等 15 秒，退不掉 `desktop_busy`），
/// 再结束剩下的后台进程（`codex app-server` / `codex-code-mode-host`），最后把桌面应用重新打开
/// （`reopened: true`）。**不碰用户在终端里的交互式会话**。什么都没在跑不算失败。
/// 它不写 `~/.codex/config.toml`，所以不取 `config_lock`
#[tauri::command]
pub async fn gateway_restart_codex(
    state: tauri::State<'_, AppState>,
) -> Result<RestartReport, String> {
    let app = app(&state)?;
    blocking(move || app.restart_codex()).await
}

/// 打开 Codex 桌面应用（按应用标识）。只发出打开请求，界面自己轮询 `codex.running` 等它起来。
/// 它不写 `~/.codex/config.toml`，所以不取 `config_lock`
#[tauri::command]
pub async fn gateway_launch_codex(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let app = app(&state)?;
    blocking(move || app.launch_codex()).await
}

/// 接管别家的生效配置。Codex：agents-manager 的；Claude：别的工具写进桌面应用的第三方配置（R35）
#[tauri::command]
pub async fn gateway_takeover(
    agent: Agent,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    // 锁只包住写文件的那一小段：同步的 MCP 命令会在 IPC 线程上等这把锁，临界区越短越好
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || match agent {
            Agent::Codex => worker.takeover(),
            Agent::Claude => worker.takeover_claude().map(|_| ()),
        })
        .await?;
    }
    current_state(app).await
}

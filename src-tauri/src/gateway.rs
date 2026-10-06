//! 模型页的命令层与无界面入口。逻辑都在 `sophia-gateway`，这里只做转接。
//! 命令约定见 docs/gateway-commands.md。
use crate::AppState;
use sophia_core::codex_models::catalog::Model;
use sophia_gateway::app::{Agent, App, AppError, GatewayState, ProviderSaved};
use sophia_gateway::process::RestartReport;
use sophia_gateway::runtime;
use std::sync::Arc;

/// `Sophia gateway …`：命令行入口（界面不可用时应急、调试）
pub fn cli(args: Vec<String>) -> i32 {
    match crate::runtime_store_dir() {
        Ok(dir) => runtime::cli(args, dir, crate::language::system_tags),
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// 仅 macOS 提供这项功能；其他系统上界面据 `supported: false` 隐藏标签页。
/// 返回之前先把损坏的密钥文件另存（spec 2026-10-03-keys-in-file R5）。路由在本进程里，跑在 Tauri 的异步运行时上
pub fn build(store_dir: std::path::PathBuf) -> Option<Arc<App>> {
    cfg!(target_os = "macos").then(|| {
        let handle = tauri::async_runtime::handle().inner().clone();
        runtime::build_ui_app(store_dir, handle)
    })
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
    // 下层已经记过的失败（例如写配置没写成，被包成 internal）不再按错误代码记一次
    let (result, inner_counted) =
        tauri::async_runtime::spawn_blocking(move || sophia_core::report::scoped(task))
            .await
            .map_err(|e| format!("[internal] {e}"))?;
    result.map_err(|e| {
        let text = e.to_string();
        // 内部错误（下层没记过的）计数并上传一条事件（R8）；别的代码只计数
        if e.code == "internal" && !inner_counted {
            sophia_core::report::capture_internal(&text);
        } else {
            sophia_core::report::count_command_error(e.code, inner_counted);
        }
        text
    })
}

async fn current_state(app: Arc<App>) -> Result<GatewayState, String> {
    blocking(move || Ok(app.state())).await
}

#[tauri::command]
pub async fn gateway_state(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    match state.gateway.clone() {
        Some(app) => {
            let mut view = current_state(app.clone()).await?;
            // 开发者入口：报「读不到状态 · Codex 设置不归你的账户所有」，直到修复权限做成一次，
            // 验证模型页那块灰面板与修复的路（正式版恒为 false）
            if crate::diagnostics::gateway_state_fault() {
                view.unreadable = Some(sophia_core::file_issue::FileIssue::from_io(
                    &app.codex_config_path(),
                    &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
                    Some(u32::MAX),
                    true,
                ));
            }
            Ok(view)
        }
        None => Ok(GatewayState::default()),
    }
}

/// 只认 Sophia 管的文件（逐字等于 Codex 的设置文件，或 Sophia 数据目录里的 JSON；从根到文件不能有软链），
/// 交回这个字面路径；别的一律拒绝，不碰。调用处核对完紧接着动手
fn managed_file(app: &App, path: &str) -> Result<std::path::PathBuf, String> {
    let asked = std::path::PathBuf::from(path);
    app.managed_file(&asked).ok_or_else(|| {
        format!(
            "[invalid] {}",
            sophia_core::t!(
                "models.unreadable.notManaged",
                file = sophia_core::redact::redact(&asked.display().to_string())
            )
        )
    })
}

/// `修复权限`（spec 2026-10-04-local-diagnostics R11）：经系统密码框把这份文件改回当前账户所有、本人可读写，
/// 做成后返回重读的状态。用户在密码框里取消：`[cancelled]`（界面什么都不说）
#[tauri::command]
pub async fn gateway_fix_file_owner(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let path = managed_file(&app, &path)?;
    let uid = sophia_core::file_issue::current_uid().ok_or_else(|| {
        let text = format!(
            "[internal] {}",
            sophia_core::t!("models.unreadable.fixFailed", reason = "uid")
        );
        sophia_core::report::capture_internal(&text);
        text
    })?;
    let script = crate::fileowner::admin_script(&path, uid, true).ok_or_else(|| {
        format!(
            "[invalid] {}",
            sophia_core::t!("models.unreadable.notManaged", file = path.display())
        )
    })?;
    let ran = tauri::async_runtime::spawn_blocking(move || crate::fileowner::run(&script))
        .await
        .map_err(|e| format!("[internal] {e}"))?;
    match ran {
        Ok(()) => {
            crate::diagnostics::clear_gateway_state_fault();
            gateway_state(state).await
        }
        Err(crate::fileowner::FixError::Cancelled) => Err("[cancelled] ".to_owned()),
        Err(crate::fileowner::FixError::Failed(message)) => {
            log::warn!("修复 {} 的权限失败：{message}", path.display());
            // 系统命令（chown / chmod）没做成多半是外部原因：只计数、不上传原文（复审 P2）
            sophia_core::report::count(sophia_core::report::Kind::Internal);
            Err(AppError::new(
                "internal",
                sophia_core::t!(
                    "models.unreadable.fixFailed",
                    reason = message.lines().last().unwrap_or_default()
                ),
            )
            .with_detail(sophia_core::redact::redact(&message))
            .to_string())
        }
    }
}

/// `打开文件 ↗`：用默认应用打开 Sophia 管的那份文件（格式有误时自己改）
#[tauri::command]
pub fn gateway_open_file(
    path: String,
    handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let app = app(&state)?;
    let path = managed_file(&app, &path)?;
    handle
        .opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| {
            let text = format!("[internal] {e}");
            sophia_core::report::capture_internal(&text);
            text
        })
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
#[allow(clippy::too_many_arguments)]
pub async fn gateway_upsert_provider(
    agent: Agent,
    id: Option<String>,
    name: Option<String>,
    base_url: String,
    key: Option<String>,
    sync: bool,
    preset: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ProviderSavedState, String> {
    let app = app(&state)?;
    let key = key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    // 联网校验放在拿锁之前：锁只保护写文件的那一小段，否则 MCP 的同步命令会被一次网络请求卡住十秒。
    // 先用新密钥向网关校验；失败就什么都不保存，错误的密钥不会覆盖密钥文件里原本好用的那个。
    // 同步到另一家时也只联网这一次（R40）
    let verified = match &key {
        None => None,
        Some(key) => {
            let cleaned =
                sophia_gateway::app::clean_base_url(&base_url).map_err(|e| e.to_string())?;
            Some(runtime::fetch_models(&cleaned, key).await.map_err(|e| {
                // 日志按 spec 2026-10-04-local-diagnostics AC1 记一条；格式化时统一去隐私
                log::warn!("校验网关 {cleaned} 的密钥时拉模型失败：{e}");
                sophia_core::report::count_error_code(e.code);
                e.to_string()
            })?)
        }
    };
    // 这把锁会跨 .await 持有，必须是 tokio::sync::Mutex（std 的 guard 不是 Send，还会阻塞运行时线程）。
    // 后面新增的异步命令只要会写 ~/.codex/config.toml 或 Claude 的配置，都照此办理。
    let saved = {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        let saved = blocking(move || match (verified, key) {
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
        .await?;
        // 从预设建的（spec S1）：记上来源与协议，同步到另一家的那一个也记
        if let Some(preset) = preset.filter(|p| !p.trim().is_empty()) {
            let worker = app.clone();
            let saved = saved.clone();
            blocking(move || {
                let also = saved
                    .other_provider_id
                    .as_deref()
                    .map(|other| (agent.other(), other));
                worker.apply_preset_in(agent, &saved.provider_id, &preset, also)
            })
            .await?;
        }
        saved
    };
    Ok(ProviderSavedState {
        saved,
        state: current_state(app).await?,
    })
}

/// 服务商预设的名单（spec S1）：内置数据，不联网
#[tauri::command]
pub fn gateway_presets() -> Vec<sophia_core::provider_presets::ProviderPreset> {
    sophia_core::provider_presets::all()
}

/// 删掉 `agent` 这一家的一个网关，连同它在密钥文件里的密钥（删了回不来，确认由界面负责）。
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
            log::warn!(
                "拉网关 {provider_id}（{base_url}）的模型失败：{}",
                failure.error
            );
            sophia_core::report::count_error_code(failure.error.code);
            // 无法连接是那一家的状态：先把原因记下来（界面重读 state 就能在那一行显示），再照旧报错
            if let Some(reason) = failure.unreachable {
                let detail = failure.error.detail.clone();
                blocking(move || worker.record_unreachable_in(agent, &provider_id, reason, detail))
                    .await?;
            }
            return Err(failure.error.to_string());
        }
    }
    drop(guard);
    current_state(app).await
}

/// 试调的结果说明了密钥（通了、或 401/403）时记到那一家网关上（#144）：只动 settings.json 里这一家的
/// `unreachable`，不碰 Codex、Claude 的配置，所以不取 `config_lock`。记不下来只写日志，不改试调的结果
async fn record_probe_verdict(
    app: Arc<App>,
    agent: Agent,
    provider_id: String,
    result: &Result<(), AppError>,
) {
    let Some(verdict) = runtime::probe_verdict(result) else {
        return;
    };
    if let Err(e) = blocking(move || app.record_key_verdict_in(agent, &provider_id, verdict)).await
    {
        log::warn!("记下试调的密钥结论失败：{e}");
    }
}

/// 勾选前试调 `agent` 这一家网关 `provider_id` 的模型 `model_id`：向网关真发一条最小的请求（20 秒为限），
/// 通了返回空，不通返回 `[代码] 原因`（原因给界面显示在那一行）。结果说明了密钥时记到那一家网关上
/// （`record_probe_verdict`）；不写别的文件，所以不取 `config_lock`
#[tauri::command]
pub async fn gateway_probe_model(
    agent: Agent,
    provider_id: String,
    model_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let app = app(&state)?;
    let worker = app.clone();
    let pid = provider_id.clone();
    let target = blocking(move || worker.provider_for_probe_in(agent, &pid, &model_id)).await?;
    let result = runtime::probe_target(&target).await;
    record_probe_verdict(app, agent, provider_id, &result).await;
    result.map_err(|e| {
        log::warn!(
            "试调网关 {} 的模型 {} 失败：{e}",
            target.api_base,
            target.model
        );
        sophia_core::report::count_error_code(e.code);
        e.to_string()
    })
}

/// 手动添加一个模型（sophia-dev#117）：先像勾选前那样试调一次（20 秒为限），通了才写进列表并勾上。
/// 试不通返回 `[代码] 原因`（原因给界面显示在那一行），不写列表（试调的密钥结论照样记，见 `record_probe_verdict`）
#[tauri::command]
pub async fn gateway_add_manual_model(
    agent: Agent,
    provider_id: String,
    model_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    let probe_app = app.clone();
    let (pid, mid) = (provider_id.clone(), model_id.clone());
    let target = blocking(move || probe_app.provider_for_probe_in(agent, &pid, &mid)).await?;
    let result = runtime::probe_target(&target).await;
    record_probe_verdict(app.clone(), agent, provider_id.clone(), &result).await;
    result.map_err(|e| {
        log::warn!(
            "手动添加前试调网关 {} 的模型 {} 失败：{e}",
            target.api_base,
            target.model
        );
        sophia_core::report::count_error_code(e.code);
        e.to_string()
    })?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.add_manual_model_in(agent, &provider_id, &model_id)).await?;
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

/// 「再试一次」：重新接上（起路由，必要时换端口、写设置）。会写 Codex 设置，所以取 `config_lock`
#[tauri::command]
pub async fn gateway_restart(state: tauri::State<'_, AppState>) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || Ok(worker.attach())).await?;
    }
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

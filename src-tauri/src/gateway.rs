//! 模型页的命令层与无界面入口。逻辑都在 `sophia-gateway`，这里只做转接。
//! 命令约定见 docs/gateway-commands.md。
use crate::AppState;
use sophia_core::model_providers::ModelRef;
use sophia_gateway::app::{Agent, App, AppError, GatewayState};
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
pub(crate) async fn blocking<T: Send + 'static>(
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

/// 服务商预设的名单（spec S1）：内置数据，不联网
#[tauri::command]
pub fn gateway_presets() -> Vec<sophia_core::provider_presets::ProviderPreset> {
    sophia_core::provider_presets::all()
}

/// 在选模型浮层里勾上（追加到这一家「已选」的末尾）或取消一个（#259）。开着的那一家当场跟上
/// （Codex 重写目录；Claude 不在运行时当场写、在运行时记为待生效）；取消最后一个第三方模型＝关掉这一家
#[tauri::command]
pub async fn gateway_pick(
    agent: Agent,
    model: ModelRef,
    on: bool,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.pick(agent, &model, on)).await?;
    }
    current_state(app).await
}

/// 排序（#265）：浮层「已选」里看得见的几项的新顺序（拖动、⌥↑ / ⌥↓），看不见的原地不动。开着的那一家当场跟上
#[tauri::command]
pub async fn gateway_reorder_picks(
    agent: Agent,
    order: Vec<ModelRef>,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.reorder_picks(agent, order)).await?;
    }
    current_state(app).await
}

/// 「恢复默认顺序」（#265）：官方的在前、按它自己的顺序，第三方的按启用先后。开着的那一家当场跟上
#[tauri::command]
pub async fn gateway_restore_order(
    agent: Agent,
    state: tauri::State<'_, AppState>,
) -> Result<GatewayState, String> {
    let app = app(&state)?;
    {
        let _guard = state.config_lock.lock().await;
        let worker = app.clone();
        blocking(move || worker.restore_order(agent)).await?;
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
            Agent::WorkBuddy => worker.enable_workbuddy(),
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
            Agent::WorkBuddy => worker.restore_workbuddy(),
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
            // WorkBuddy 没有别家配置要接管
            Agent::WorkBuddy => Err(AppError::new(
                "invalid",
                sophia_core::t!("models.cmd.noTakeover", agent = "WorkBuddy"),
            )),
        })
        .await?;
    }
    current_state(app).await
}

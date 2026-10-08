//! Tauri 命令层：每个命令一行调 core，错误统一转 String
mod app_update;
mod appearance;
mod autostart;
mod cmd_error;
mod diagnostics;
mod fileowner;
mod gateway;
mod language;
mod market;
mod menu;
mod net_kind;
mod providers;
mod quit;
// 自动上报（spec 2026-10-04-reporting-feedback）：内部版不编进去，没有上报代码也没有地址
#[cfg(not(feature = "weiboap"))]
mod report;
// 应用内反馈（同一份 spec R12–R14）：与自动上报同一个接收服务，内部版同样不编进去
#[cfg(not(feature = "weiboap"))]
mod feedback;
mod tray;
mod usage;
mod watch;

pub use diagnostics::install_panic_hook;
pub use gateway::cli as gateway_cli;

use serde::Serialize;
use sophia_core::copies;
use sophia_core::discovery::{self, Env};
use sophia_core::fs::normalize;
use sophia_core::mcp::sources as mcp_sources;
use sophia_core::models::*;
use sophia_core::skills;
use sophia_core::store::Store;
use sophia_core::subscriptions;
use sophia_core::sync;
use std::collections::BTreeSet;
#[cfg(debug_assertions)]
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

struct AppState {
    store: Store,
    /// 当前的文件系统监视，随每次扫描的目录集合重建
    watcher: Mutex<Option<watch::Watcher>>,
    mcp_plan: Mutex<Option<(String, sophia_core::mcp::PreparedPlan)>>,
    next_mcp_plan: AtomicU64,
    /// MCP 写入的撤销记录，按随机 id 存在内存里：前端只拿 id，碰不到路径和快照。
    /// 下一次写到同一文件时旧记录失效（那次写会留新备份、换新指纹），用过一次即删，退出即丢
    mcp_undo: Mutex<Vec<(String, sophia_core::mcp::McpUndo)>>,
    next_mcp_undo: AtomicU64,
    /// 待确认的删本体计划。计划必须留在服务端：`in_git`（仓库里的不代删）是道安全闸门，
    /// 让它在前端转一圈就等于可以被改掉
    delete_plan: Mutex<Option<(String, DeleteSourcePlan)>>,
    next_delete_plan: AtomicU64,
    /// 最近一次删原件的撤销记录（DESIGN「删除原件」撤销怎么做到）：前端只拿 id。
    /// 只留一条：下一次删原件时上一次暂存的原件移进废纸篓，撤销机会随之过去
    delete_undo: Mutex<Option<(String, sync::DeleteUndo)>>,
    /// 同一进程里写 ~/.codex/config.toml 的路径（MCP 同步、模型页）共用这把锁，避免互相撞出“配置已变化”。
    /// 跨进程仍靠 atomicfile 的写前写后校验兜底。
    config_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// 模型网关；仅 macOS 上有
    gateway: Option<std::sync::Arc<sophia_gateway::app::App>>,
    /// 上次是不是意外退出的（spec 2026-10-04-local-diagnostics R8），setup 时判定
    last_exit_unexpected: std::sync::atomic::AtomicBool,
    /// 这次启动时设置文件坏了、已另存并重置（spec S7）：界面提示一次
    settings_repaired: std::sync::atomic::AtomicBool,
}

/// 一个产品（GLOSSARY「产品」）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessStatus {
    id: String,
    display_name: String,
    /// 品牌 id 与品牌名（#251）：设置按品牌勾，MCP 页按品牌合组
    brand: String,
    brand_name: String,
    /// 它的品牌勾着没有
    enabled: bool,
    /// 这台机器上装没装
    installed: bool,
    /// 有没有 skill 目录（只有 MCP 的 Claude Desktop 没有）
    skills: bool,
    /// MCP 页能不能写它（core `mcp::supports`）
    mcp: bool,
    /// MCP 写进以后要在它里面点「信任」才会连上（core `mcp::trust_app`，#256）
    mcp_trust: bool,
    /// 它的 skill 在用户级 / 项目里落进哪一列（core `discovery::skill_columns`）；没有这一级为空
    skill_user: Option<String>,
    skill_project: Option<String>,
}

/// 一个品牌（GLOSSARY「品牌」）：设置里一个勾
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrandStatus {
    id: String,
    name: String,
    enabled: bool,
    /// 装了它任一个产品。设置页默认只列已安装的，其余收在「未安装的 N 个」后面——
    /// 未安装的也要带出来（只列名字），不能只返回已安装的那些
    installed: bool,
    /// 已安装的产品 id（表的先后）：勾选行下的小字列它们的名字（前端按界面语言写）；只装了一个时不写
    installed_products: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessList {
    /// 列表里最多显示几个品牌（core 的 `discovery::MAX_SHOWN`，前端不另写）
    max_shown: usize,
    /// 全部产品，含只有 MCP 的，按品牌的先后（同一品牌的挨着）
    harnesses: Vec<HarnessStatus>,
    /// 全部品牌，按品牌的先后
    brands: Vec<BrandStatus>,
}

/// 命令的错误原样转成给前端的一句，同时记一条去隐私的日志（spec S18：核心功能出问题维护者看得见）。
/// 调用处的 `文件:行` 一起记：在调用处的闭包里调（`.map_err(|e| err(e))`），不当函数值传（见 `cmd_error`）。
/// 给界面的命令都已改走 `cmd_error`（#320），只剩调试版的隔离测试主目录（`SOPHIA_TEST_HOME`）在用
#[track_caller]
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn err<E: std::fmt::Display>(e: E) -> String {
    let text = e.to_string();
    cmd_error::log(&text);
    text
}

/// 仅供 Debug 原生 MCP UI 验收使用的临时根目录；生产环境始终使用系统环境。
fn runtime_env() -> Result<Env, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("SOPHIA_TEST_HOME") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err("SOPHIA_TEST_HOME 必须是已存在的绝对目录".into()); // i18n-exempt: 仅 debug 构建、开发者自设的环境变量，不是给用户看的界面文案
        }
        let root = normalize(&std::fs::canonicalize(root).map_err(|e| err(e))?);
        // 应用包也只在隔离目录里找，不读本机的 /Applications
        return Ok(Env {
            apps: vec![root.join("Applications")],
            home: root,
            vars: HashMap::new(),
        });
    }
    // 登录 shell 问到的 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`（spec S16）：本进程没有的才补，有的以本进程为准
    let mut env = Env::from_system();
    if let Some(login) = sophia_gateway::login_env::current() {
        for (key, value) in [
            ("CLAUDE_CONFIG_DIR", login.claude_config_dir),
            ("CODEX_HOME", login.codex_home),
        ] {
            if let Some(value) = value {
                env.vars.entry(key.to_owned()).or_insert(value);
            }
        }
    }
    Ok(env)
}

/// debug 版设了测试主目录：验证用的实例，不该在这台电脑上留下任何系统级副作用（登录项等）
pub(crate) fn test_home_active() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var_os("SOPHIA_TEST_HOME").is_some()
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

pub(crate) fn runtime_store_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("SOPHIA_TEST_HOME") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err("SOPHIA_TEST_HOME 必须是已存在的绝对目录".into()); // i18n-exempt: 仅 debug 构建、开发者自设的环境变量，不是给用户看的界面文案
        }
        let root = std::fs::canonicalize(root).map_err(|e| err(e))?;
        return Ok(root.join("AppData").join("Sophia"));
    }
    Ok(Store::default_dir())
}

/// 已安装的 harness（有 skill 目录的，按 agent 表先后）与设置；读设置时顺手按显示上限整理不显示名单——
/// 名单按品牌（#251；新用户取前 4 个、新装的只在不满时出现，见 `discovery::reconcile_shown`）
fn installed_and_settings(
    state: &AppState,
    env: &Env,
) -> Result<(Vec<Harness>, sophia_core::store::Settings), String> {
    let installed = discovery::installed(env);
    let settings = state
        .store
        .load_settings_reconciling_shown(&discovery::installed_brands(env))
        .map_err(|e| cmd_error::data_unread(e))?;
    Ok((installed, settings))
}

/// 扫描用的项目：自动检测的加手动选的（`projects.json`），去掉设置「生效范围」里取消勾的。
/// SKILLS、MCP 两页与安装页都只看这一份，筛选行、「切换项目…」浮层（⌘P）由扫描结果得出，所以三处一致
fn shown_projects(
    state: &AppState,
    env: &Env,
    harnesses: &[Harness],
    settings: &sophia_core::store::Settings,
) -> Result<Vec<PathBuf>, String> {
    let manual = state
        .store
        .load_projects()
        .map_err(|e| cmd_error::data_unread(e))?;
    Ok(discovery::shown_projects(
        discovery::projects(env, harnesses, &manual),
        &settings.hidden_projects,
    ))
}

fn discover_mcp(state: &AppState) -> Result<sophia_core::mcp::McpDiscovery, String> {
    let env = runtime_env()?;
    #[cfg_attr(not(feature = "weiboap"), allow(unused_mut))]
    let (mut candidates, settings) = installed_and_settings(state, &env)?;
    #[cfg(feature = "weiboap")]
    if !candidates.iter().any(|h| h.id == "weiboap") {
        if let Some(weiboap) = discovery::all_harnesses(&env)
            .into_iter()
            .find(|h| h.id == "weiboap")
        {
            candidates.push(weiboap);
        }
    }
    let shown = discovery::enabled(candidates, &settings);
    let projects = shown_projects(state, &env, &shown, &settings)?;
    // 两页共用一份名单（按品牌）：MCP 页取名单里的品牌下装了的、支持 MCP 的产品（含 Claude Desktop）；
    // WeiboAP 不在 MCP 的 agent 表里，照旧跟着名单
    let mut harnesses = discovery::mcp_columns(&env, &settings);
    harnesses.extend(shown.into_iter().filter(|h| h.id == "weiboap"));
    Ok(sophia_core::mcp::discover_locations(
        &env, &harnesses, &projects,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpPreview {
    plan_id: String,
    actions: Vec<sophia_core::mcp::McpAction>,
    issues: Vec<sophia_core::mcp::McpIssue>,
}

/// 一次发现：本体位置与目标目录，按当前设置解析。返回的目标含目录尚不存在的那批
/// （`Target.exists == false`），它们照常成列，补齐时目录就地创建。
/// 订阅记录里常规发现找不到的文件夹（来源管理页选的）在目标之前读进来；
/// 目标目录里指向已知位置之外的软链再合成出外部本体位置。
/// Sophia 放的副本（`copies.json` 里记录在案的）不是 agent 自己的原件，在目标之前拿掉
fn discover(state: &AppState) -> Result<(Vec<Source>, Vec<Target>), String> {
    let env = runtime_env()?;
    let (installed, settings) = installed_and_settings(state, &env)?;
    let harnesses = discovery::enabled(installed, &settings);
    let projects = shown_projects(state, &env, &harnesses, &settings)?;
    let mut sources = discovery::sources(&env, &harnesses, &projects, &settings.manual_sources);
    let subscribed = discovery::subscribed_sources(
        &subscriptions::recorded_dirs(&settings.subscriptions),
        &sources,
    );
    sources.extend(subscribed);
    copies::drop_copies(&mut sources, &load_copies(state)?);
    let targets = discovery::targets(&env, &harnesses, &projects, &sources);
    let external = discovery::external_sources(&env, &targets, &sources);
    sources.extend(external);
    Ok((sources, targets))
}

/// Sophia 放的副本的记录（`copies.json`）
fn load_copies(state: &AppState) -> Result<copies::Copies, String> {
    copies::Copies::load(&state.store).map_err(|e| cmd_error::data_unread(e))
}

/// 完整扫描：发现 → 把此刻有软链的来源记进订阅（第一次扫描时认领老数据）→ 按域扫描
fn overview(state: &AppState) -> Result<Overview, String> {
    let (sources, targets) = discover(state)?;
    let settings = subscribed_settings(state, &sources, &targets)?;
    let copies = load_copies(state)?;
    Ok(skills::scan(
        &sources,
        &targets,
        &settings.subscriptions,
        &copies,
    ))
}

/// 扫描前对一遍副本的账（`copies::reconcile`）：副本不在了、被用户改过的不再管理，没改过而原件变了的
/// 用原件更新。静默进行（spec #194 修订：界面上不出现副本），旧副本进暂存；做不成只记日志，不拦扫描
fn reconcile_copies(state: &AppState) {
    match copies::reconcile(&state.store) {
        Ok(done) => {
            for entry in &done.report.entries {
                if let Outcome::Failed(reason) = &entry.outcome {
                    log::warn!("副本没能更新：{reason}");
                }
            }
        }
        Err(e) => log::warn!("读不了副本记录：{e}"),
    }
}

/// 读设置并认领订阅；凡是要读或改订阅记录的地方都先过这一步，第一次扫描的认领才不会被跳过
fn subscribed_settings(
    state: &AppState,
    sources: &[Source],
    targets: &[Target],
) -> Result<sophia_core::store::Settings, String> {
    state
        .store
        .load_settings_adopting_subscriptions(sources, targets)
        .map_err(|e| cmd_error::data_unread(e))
}

/// 所有仍生效的自动引入规则只保存位置身份；扫描时才把它们展开为当前缺失项。
/// `auto_selections` 只返回规则授权的跨域项，故自动执行不会借用手动预览的确认。
fn auto_import_mcp(
    state: &AppState,
    overview: &sophia_core::mcp::McpOverview,
    rules: &[sophia_core::mcp::McpAutoImportRule],
) -> Result<Option<sophia_core::mcp::McpReport>, String> {
    if rules.is_empty() {
        return Ok(None);
    }
    let selections = sophia_core::mcp::auto_selections(overview, rules);
    if selections.is_empty() {
        return Ok(None);
    }
    let discovery = discover_mcp(state)?;
    let plan = sophia_core::mcp::prepare(&discovery.locations, &selections);
    if plan.actions.is_empty() {
        return Ok(None);
    }
    // 自动选择已由规则逐条授予跨域权限；这里不接受未经过该筛选的手动选择。
    // Tauri 2 的同步命令内联跑在 IPC 线程上，这里 blocking_lock 不会 panic，
    // 但会占住那个线程：模型页正在写设置时，这条命令要等它放锁，界面在此期间不响应。
    // 所以模型页那边只把写文件包在锁里，不把联网和状态查询放进临界区。
    let _config_guard = state.config_lock.blocking_lock();
    let actions = plan.actions.clone();
    // 密钥提醒（S19）：规则上没有「同时加进 .gitignore」的勾选，来源被忽略的照搬，第一次暴露的照常写、提示条里说
    let mut report =
        sophia_core::mcp::execute_minding_keys(plan, true, false, &state.store.backups_dir());
    register_mcp_undo(state, &mut report)?;
    // 来源管理页目标框的提示框写「最近一次自动操作」：真写进去了才记
    state
        .store
        .record_mcp_auto_import_runs(&actions, &report, now_ms())
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    Ok(Some(report))
}

/// 最多保留的撤销记录数；前端提示条同一时刻只有几条，多出的最旧记录直接丢
const MCP_UNDO_LIMIT: usize = 16;

/// 把这次写入的撤销记录登记进内存，id 写回报告。同一文件的旧记录一并作废。
/// 追加 `.gitignore` 的那几行（密钥提醒）另记一条，id 写进 `gitignore_undo_id`
fn register_mcp_undo(
    state: &AppState,
    report: &mut sophia_core::mcp::McpReport,
) -> Result<(), String> {
    if let Some(undo) = report.take_undo() {
        report.undo_id = Some(register_undo(state, undo)?);
    }
    if let Some(undo) = report.take_gitignore_undo() {
        report.gitignore_undo_id = Some(register_undo(state, undo)?);
    }
    Ok(())
}

fn register_undo(state: &AppState, undo: sophia_core::mcp::McpUndo) -> Result<String, String> {
    let mut records = state
        .mcp_undo
        .lock()
        .map_err(|_| cmd_error::said(sophia_core::t!("shell.error.mcpUndoCorrupt")))?;
    let targets: BTreeSet<PathBuf> = undo.target_paths().map(normalize).collect();
    records.retain(|(_, old)| {
        !old.target_paths()
            .any(|path| targets.contains(&normalize(path)))
    });
    if records.len() >= MCP_UNDO_LIMIT {
        records.remove(0);
    }
    let id = mcp_undo_id(state.next_mcp_undo.fetch_add(1, Ordering::Relaxed));
    records.push((id.clone(), undo));
    Ok(id)
}

/// 进程内随机种子 + 序号，不可预测也不重复；安全性不靠它（记录只能由 core 的写入产生）
fn mcp_undo_id(sequence: u64) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(sequence);
    format!("{:016x}-{sequence}", hasher.finish())
}

/// 规则引用的是配置文件，原子写会替换文件本身，故只监视其父目录。
fn mcp_auto_watch_paths(state: &AppState) -> Result<BTreeSet<PathBuf>, String> {
    let settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    Ok(settings
        .mcp_auto_imports
        .iter()
        .flat_map(|rule| std::iter::once(&rule.source).chain(rule.targets.iter()))
        .filter_map(|location| location.path.parent().map(Path::to_path_buf))
        .collect())
}

fn resync_watchers(app: &tauri::AppHandle, state: &AppState, skills_overview: &Overview) {
    // skill 目录与 MCP 文件父目录共用同一个去抖器，切换 MCP/Skills 页不会丢掉另一方监视。
    // 只盯已存在的目标目录；还没建出来的目录没有东西可监视，watch 只会失败刷日志。
    let mut paths: BTreeSet<PathBuf> = skills_overview
        .sources
        .iter()
        .map(|s| s.path.clone())
        .chain(
            skills_overview
                .domains
                .iter()
                .flat_map(|d| &d.targets)
                .filter(|t| t.exists)
                .map(|t| t.path.clone()),
        )
        .collect();
    if let Ok(mcp_paths) = mcp_auto_watch_paths(state) {
        paths.extend(mcp_paths);
    }
    if let Ok(mut slot) = state.watcher.lock() {
        watch::resync(&mut slot, app, paths);
    }
}

#[tauri::command]
fn scan_mcp(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpOverview, String> {
    let discovery = discover_mcp(&state)?;
    let mut overview = sophia_core::mcp::scan(&discovery.locations);
    overview.issues.extend(discovery.issues);
    let rules = state
        .store
        .load_settings_migrating_mcp_auto_imports(&overview)
        .map_err(|e| cmd_error::data_unread(e))?
        .mcp_auto_imports;
    if let Some(report) = auto_import_mcp(&state, &overview, &rules)? {
        let _ = app.emit("mcp-auto-imported", &report);
        let discovery = discover_mcp(&state)?;
        overview = sophia_core::mcp::scan(&discovery.locations);
        overview.issues.extend(discovery.issues);
    }
    // 老数据认领进订阅记录，再把各位置订阅着的来源填进结果：主视图把它们的全部服务列成行
    let settings = state
        .store
        .load_settings_adopting_mcp_subscriptions(&overview)
        .map_err(|e| cmd_error::data_unread(e))?;
    mcp_sources::attach(&mut overview, &settings.mcp_subscriptions);
    // `scan_mcp` 也可能是用户最后一次扫描，故重建为包含两类位置的并集。
    if let Ok(skills_overview) = self::overview(&state) {
        resync_watchers(&app, &state, &skills_overview);
    }
    Ok(overview)
}

/// MCP「N 份不一样」就地展开：同名服务在几个位置上哪些字段不一样。只读；凭据在 core 里就脱敏了
#[tauri::command]
fn mcp_field_diff(
    name: String,
    location_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpDiff, String> {
    let discovery = discover_mcp(&state)?;
    Ok(sophia_core::mcp::diff_fields(
        &discovery.locations,
        &name,
        &location_ids,
    ))
}

/// MCP 行详情的 `命令` / `地址`：服务在它原件那一处的定义怎么连。只读；凭据在 core 里就脱敏了
#[tauri::command]
fn mcp_endpoint(
    name: String,
    location_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<sophia_core::mcp::McpEndpoint>, String> {
    let discovery = discover_mcp(&state)?;
    Ok(sophia_core::mcp::endpoint(
        &discovery.locations,
        &name,
        &location_id,
    ))
}

#[tauri::command]
fn propose_mcp_sync(
    selections: Vec<sophia_core::mcp::McpSelection>,
    state: tauri::State<'_, AppState>,
) -> Result<McpPreview, String> {
    let discovery = discover_mcp(&state)?;
    let plan = sophia_core::mcp::prepare(&discovery.locations, &selections);
    let id = state
        .next_mcp_plan
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    let preview = McpPreview {
        plan_id: id.clone(),
        actions: plan.actions.clone(),
        issues: plan.issues.clone(),
    };
    *state
        .mcp_plan
        .lock()
        .map_err(|_| sophia_core::t!("shell.error.mcpPlanCacheCorrupt"))? = Some((id, plan));
    Ok(preview)
}

/// 密钥提醒（S19）的问法：移动 / 复制的确认框按选中的去处问一次，出不出「同时加进 .gitignore」。只读
#[tauri::command]
fn check_mcp_key_hints(
    selections: Vec<sophia_core::mcp::McpSelection>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sophia_core::mcp::McpKeyHint>, String> {
    let discovery = discover_mcp(&state)?;
    let plan = sophia_core::mcp::prepare(&discovery.locations, &selections);
    Ok(sophia_core::mcp::key_hints(&plan))
}

/// 写进项目文件的一律按密钥提醒处理（`execute_minding_keys`）。`add_to_gitignore`：只有移动 / 复制的确认框给
/// （勾没勾「同时加进 .gitignore」）；不给（格子里的写入）按没勾——照常写，报告里给可以补加的目标（`ignorable`），
/// 提示条上的「加进 .gitignore」交给 `add_mcp_gitignore`
#[tauri::command]
fn apply_mcp(
    plan_id: String,
    allow_cross_domain: bool,
    add_to_gitignore: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpReport, String> {
    let plan = {
        let mut cache = state
            .mcp_plan
            .lock()
            .map_err(|_| sophia_core::t!("shell.error.mcpPlanCacheCorrupt"))?;
        let Some((cached_id, _)) = cache.as_ref() else {
            return Err(sophia_core::t!("shell.error.mcpPlanMissing"));
        };
        if cached_id != &plan_id {
            return Err(sophia_core::t!("shell.error.mcpPlanMissing"));
        }
        cache.take().expect("checked above").1
    };
    // Tauri 2 的同步命令内联跑在 IPC 线程上，这里 blocking_lock 不会 panic，
    // 但会占住那个线程：模型页正在写设置时，这条命令要等它放锁，界面在此期间不响应。
    // 所以模型页那边只把写文件包在锁里，不把联网和状态查询放进临界区。
    let _config_guard = state.config_lock.blocking_lock();
    let backups = state.store.backups_dir();
    let mut report = sophia_core::mcp::execute_minding_keys(
        plan,
        allow_cross_domain,
        add_to_gitignore.unwrap_or(false),
        &backups,
    );
    register_mcp_undo(&state, &mut report)?;
    // 手动写进来的：之前手动移除时记下的排除撤掉，自动规则照常接管
    update_mcp_rules(&state, |rules| {
        sophia_core::mcp::include_written(rules, &report)
    })?;
    Ok(report)
}

/// 点格子写入的提示条上的「加进 .gitignore」（密钥提醒，产品负责人 2026-10-06）：把那次写入报告里的 `ignorable`
/// 加进各自项目根的 `.gitignore`。撤销号进 `gitignore_undo_id`，前端在撤那次写入时接着撤它
#[tauri::command]
fn add_mcp_gitignore(
    target_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpReport, String> {
    let discovery = discover_mcp(&state)?;
    // 与写入共用一把锁（同步命令，见 apply_mcp）：撤之前核对的是配置文件此刻的内容
    let _config_guard = state.config_lock.blocking_lock();
    let mut report = sophia_core::mcp::ignore_targets(
        &discovery.locations,
        &target_ids,
        &state.store.backups_dir(),
    );
    register_mcp_undo(&state, &mut report)?;
    Ok(report)
}

/// 改 MCP 自动规则（settings.json 的 `mcpAutoImports`），有改动才写回
fn update_mcp_rules(
    state: &AppState,
    edit: impl FnOnce(&mut Vec<sophia_core::mcp::McpAutoImportRule>) -> bool,
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    if edit(&mut settings.mcp_auto_imports) {
        state
            .store
            .save_settings(&settings)
            .map_err(|e| cmd_error::settings_unsaved(e))?;
    }
    Ok(())
}

/// 从 agent 的配置里删掉 MCP 定义（点 ⦿、或选择行全有时按下，确认之后；可批量）：每项是
/// (位置, 服务名)，只删那个位置里的那一项，别的位置里的同名定义不动。拒绝的项以 `skipped` + 原因
/// 进报告；一批一个撤销记录，与写入共用 `mcp_undo_write`
#[tauri::command]
fn delete_mcp_original(
    items: Vec<sophia_core::mcp::McpRemoveItem>,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpReport, String> {
    let discovery = discover_mcp(&state)?;
    // 会写 ~/.codex/config.toml：与模型页、MCP 写入共用一把锁（同步命令，见 apply_mcp）
    let _config_guard = state.config_lock.blocking_lock();
    let plan = sophia_core::mcp::prepare_original_removal(&discovery.locations, &items);
    let mut report = sophia_core::mcp::execute_removal(plan, &state.store.backups_dir());
    register_mcp_undo(&state, &mut report)?;
    // 手动拿掉的：自动规则不再往这个位置写回它（不记的话下一轮扫描就写回去了）
    update_mcp_rules(&state, |rules| {
        sophia_core::mcp::exclude_removed(rules, &report)
    })?;
    Ok(report)
}

/// 密钥提醒（S19，issue #147）的问法：「保留这份」的确认框问一次，要改写的项目文件出不出「同时加进 .gitignore」、
/// 已被跟踪的那一句。来源是选中那一份所在的文件。只读
#[tauri::command]
fn check_mcp_keep_key_hints(
    name: String,
    keep_id: String,
    location_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sophia_core::mcp::McpKeyHint>, String> {
    let discovery = discover_mcp(&state)?;
    let plan = sophia_core::mcp::prepare_keep(&discovery.locations, &name, &keep_id, &location_ids);
    Ok(sophia_core::mcp::keep_key_hints(&plan))
}

/// MCP「保留这份」（spec 2026-10-05-skill-mcp-batch2 S4）：以 `keep_id` 那一处的定义为准，改写 `location_ids`
/// 里其余几处同名的 `name`，各 agent 专属字段不动；`revision` 是用户看到的差异表的指纹，之后谁被改了就不动。一处不成整次不动；写成的一次撤销，与写入共用 `mcp_undo_write`。
/// 密钥提醒（issue #147）：`add_to_gitignore` 是确认框里勾没勾「同时加进 .gitignore」；追加的那几行进同一次撤销
#[tauri::command]
fn keep_mcp_copy(
    name: String,
    keep_id: String,
    location_ids: Vec<String>,
    revision: String,
    add_to_gitignore: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpReport, String> {
    let discovery = discover_mcp(&state)?;
    // 会写 ~/.codex/config.toml：与模型页、MCP 写入共用一把锁（同步命令，见 apply_mcp）
    let _config_guard = state.config_lock.blocking_lock();
    let plan = sophia_core::mcp::prepare_keep_seen(
        &discovery.locations,
        &name,
        &keep_id,
        &location_ids,
        &revision,
    );
    let mut report = sophia_core::mcp::execute_keep_minding_keys(
        plan,
        add_to_gitignore.unwrap_or(false),
        &state.store.backups_dir(),
    );
    register_mcp_undo(&state, &mut report)?;
    Ok(report)
}

/// 打开要在里面点「信任」的 agent（#256：MCP 写进 WorkBuddy 之后提示条上的「打开 WorkBuddy ↗」）。
/// 只认 core `mcp::trust_app` 里的那几家，不接受前端给的任意应用标识
#[tauri::command]
fn mcp_open_trust_app(harness_id: String) -> Result<(), String> {
    let bundle_id = sophia_core::mcp::trust_app(&harness_id)
        .ok_or_else(|| err(format!("[internal] no trust app for {harness_id}")))?;
    sophia_gateway::claude_desktop::open_bundle(bundle_id).map_err(|e| err(e))
}

/// 撤销一次 MCP 写入。记录用过即删；写后文件被改过时 core 整体拒绝，返回里带备份路径
#[tauri::command]
fn mcp_undo_write(
    undo_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpUndoReport, String> {
    let undo = {
        let mut records = state
            .mcp_undo
            .lock()
            .map_err(|_| cmd_error::said(sophia_core::t!("shell.error.mcpUndoCorrupt")))?;
        let index = records
            .iter()
            .position(|(id, _)| id == &undo_id)
            .ok_or_else(|| cmd_error::said(sophia_core::t!("shell.error.undoRecordMissing")))?;
        records.remove(index).1
    };
    let _config_guard = state.config_lock.blocking_lock();
    Ok(sophia_core::mcp::undo_write(&undo))
}

/// 自动同步规则展开成建链动作并执行；无规则或没有缺口时返回 None
fn auto_link(state: &AppState, scanned: &Overview) -> Result<Option<SyncReport>, String> {
    let rules = state
        .store
        .load_settings_migrating_auto_links(&scanned.sources)
        .map_err(|e| cmd_error::data_unread(e))?
        .auto_links;
    if rules.is_empty() {
        return Ok(None);
    }
    // 规则可以指向目录尚不存在的目标，首次补齐时一并把目录建出来
    let targets: Vec<Target> = scanned
        .domains
        .iter()
        .flat_map(|d| d.targets.iter().cloned())
        .collect();
    let cells = skills::auto_link_cells(&scanned.sources, &targets, &rules);
    let actions = skills::propose_links(&scanned.sources, &targets, &cells);
    if actions.is_empty() {
        return Ok(None);
    }
    let report = execute_grouped(state, scanned, &actions, false);
    // 来源管理页目标框的提示框写「最近一次自动操作」：真建上了才记，按规则、按位置
    state
        .store
        .record_auto_link_runs(&scanned.sources, &targets, &report, now_ms())
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    Ok(Some(report))
}

/// 扫描 → 跑一轮自动同步（只做一轮，不循环）→ 建过链就再扫一次 → 按最终目录集合重建监视
#[tauri::command]
fn scan_all(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Overview, String> {
    reconcile_copies(&state);
    let mut overview = overview(&state)?;
    if let Some(report) = auto_link(&state, &overview)? {
        let _ = app.emit("auto-linked", &report);
        overview = self::overview(&state)?;
    }
    // Skills 页收到文件变更时同样会走这里。没有自动规则便不读取任何 MCP 配置；
    // 有规则时只执行一轮，结果不会改变 Skills 主扫描结果。
    let mcp_rules = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?
        .mcp_auto_imports;
    if !mcp_rules.is_empty() {
        let discovery = discover_mcp(&state)?;
        let mut mcp_overview = sophia_core::mcp::scan(&discovery.locations);
        mcp_overview.issues.extend(discovery.issues);
        let mcp_rules = state
            .store
            .load_settings_migrating_mcp_auto_imports(&mcp_overview)
            .map_err(|e| cmd_error::data_unread(e))?
            .mcp_auto_imports;
        if let Some(report) = auto_import_mcp(&state, &mcp_overview, &mcp_rules)? {
            let _ = app.emit("mcp-auto-imported", &report);
        }
    }
    sweep_held_copies(&state, &overview);
    // 本体位置、目标目录与自动引入配置父目录都要盯。
    resync_watchers(&app, &state, &overview);
    Ok(overview)
}

/// 扫描收尾：各列目录里暂存在副本旁边、过了 `copies::HELD_GRACE` 没人要的那几份移进废纸篓
/// （`copies::sweep_held`）。删原件的撤销还记着的不动；撤销记录读不出来就这次不收。没收成的只记日志
fn sweep_held_copies(state: &AppState, scanned: &Overview) {
    let Ok(slot) = state.delete_undo.lock() else {
        return;
    };
    let keep = slot
        .as_ref()
        .map(|(_, undo)| undo.held_copies())
        .unwrap_or_default();
    drop(slot);
    let dirs: Vec<PathBuf> = scanned
        .domains
        .iter()
        .flat_map(|d| d.targets.iter().map(|t| t.path.clone()))
        .collect();
    for (path, error) in copies::sweep_held(&dirs, &keep, copies::HELD_GRACE) {
        log::warn!(
            "暂存的副本 {} 没能移进废纸篓：{error}",
            sophia_core::redact::redact(&path.display().to_string())
        );
    }
}

/// 选中格里的 Missing 格 → 建链动作
#[tauri::command]
fn propose_links(
    cells: Vec<CellRef>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PlannedAction>, String> {
    let (sources, targets) = discover(&state)?;
    Ok(skills::propose_links(&sources, &targets, &cells))
}

/// 选中格里的 Linked 格 → 删链动作
#[tauri::command]
fn propose_unlinks(
    cells: Vec<CellRef>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PlannedAction>, String> {
    let (sources, targets) = discover(&state)?;
    let copies = load_copies(&state)?;
    Ok(skills::propose_unlinks(&sources, &targets, &cells, &copies))
}

/// 按动作所在的目标目录回查，算出这条链接该用什么写法
fn style_for(overview: &Overview, action: &PlannedAction) -> LinkStyle {
    let same = |a: &Path, b: Option<&Path>| b.is_some_and(|b| normalize(a) == normalize(b));
    // 目录待创建的目标同样要按它所属的项目决定写法
    match overview
        .domains
        .iter()
        .flat_map(|d| &d.targets)
        .find(|t| same(&t.path, action.target_path.parent()))
    {
        Some(t) => skills::link_style(&action.source_path, t),
        None => LinkStyle::Absolute,
    }
}

/// 每条动作各自算写法，按写法分组交给 `sync::execute`，报告仍按传入顺序返回。
/// 建不了链接改放的副本记进数据目录下的副本记录
fn execute_grouped(
    state: &AppState,
    overview: &Overview,
    actions: &[PlannedAction],
    clean_broken: bool,
) -> SyncReport {
    let styles: Vec<LinkStyle> = actions.iter().map(|a| style_for(overview, a)).collect();
    let mut slots: Vec<Option<ReportEntry>> = vec![None; actions.len()];
    for style in [LinkStyle::Absolute, LinkStyle::Relative] {
        let picked: Vec<usize> = (0..actions.len()).filter(|i| styles[*i] == style).collect();
        if picked.is_empty() {
            continue;
        }
        let subset: Vec<PlannedAction> = picked.iter().map(|i| actions[*i].clone()).collect();
        let report = sync::execute(&subset, clean_broken, style, Some(&state.store));
        for (i, entry) in picked.into_iter().zip(report.entries) {
            slots[i] = Some(entry);
        }
    }
    SyncReport {
        entries: slots.into_iter().flatten().collect(),
    }
}

#[tauri::command]
fn apply_all(
    actions: Vec<PlannedAction>,
    clean_broken: bool,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let overview = overview(&state)?;
    Ok(execute_grouped(&state, &overview, &actions, clean_broken))
}

#[tauri::command]
fn split_whole_link(
    target_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let overview = overview(&state)?;
    let target = overview
        .domains
        .iter()
        .flat_map(|d| &d.targets)
        .find(|t| t.id == target_id)
        .ok_or_else(|| sophia_core::t!("shell.error.targetGone"))?;
    let source_id = target
        .linked_whole_to
        .as_deref()
        .ok_or_else(|| sophia_core::t!("shell.error.notWholeDirLink"))?;
    let source = overview
        .sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| sophia_core::t!("shell.error.wholeDirOriginGone"))?;
    Ok(skills::split_whole_link(target, source, Some(&state.store)))
}

/// 删本体的计划：`plan` 给确认弹窗渲染，`plan_id` 给 `delete_source` 取回服务端那份
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedDeletion {
    plan_id: String,
    plan: DeleteSourcePlan,
}

/// 同名几份里一份的读数（`×2` 的提示框、推荐保留哪份）：只读，不留删除计划——
/// 读数不借 `plan_delete_source`，免得悬停把正等确认的那份删除计划顶掉
#[tauri::command]
fn skill_copy_info(
    source_id: String,
    skill: String,
    state: tauri::State<'_, AppState>,
) -> Result<skills::SkillCopyInfo, String> {
    let (sources, _) = discover(&state)?;
    let found = sources
        .iter()
        .find(|s| s.id == source_id)
        .and_then(|s| s.skills.iter().find(|k| k.name == skill))
        .ok_or_else(|| sophia_core::t!("shell.error.originGone"))?;
    Ok(skills::skill_copy_info(&found.path))
}

/// 删本体前的只读体检，什么都不动。计划留在服务端，前端拿到的那份只用来摆给用户看；
/// 确认之后凭 `plan_id` 调 `delete_source`
#[tauri::command]
fn plan_delete_source(
    source_id: String,
    skill: String,
    state: tauri::State<'_, AppState>,
) -> Result<PlannedDeletion, String> {
    let (sources, targets) = discover(&state)?;
    let skill = sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| sophia_core::t!("shell.error.originLocationGone"))?
        .skills
        .iter()
        .find(|s| s.name == skill)
        .ok_or_else(|| sophia_core::t!("shell.error.originGone"))?;
    let plan = skills::plan_delete_source(skill, &sources, &targets, &load_copies(&state)?);
    let plan_id = state
        .next_delete_plan
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    *state
        .delete_plan
        .lock()
        .map_err(|_| sophia_core::t!("shell.error.deletePlanCacheCorrupt"))? =
        Some((plan_id.clone(), plan.clone()));
    Ok(PlannedDeletion { plan_id, plan })
}

/// 「只留这份」的一方（issue #153）：某个原件位置里的那一份（`source_id`），或 agent 自己目录里
/// 不在任何原件位置里的那一份（`target_id`：那个目标目录下的同名文件夹）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyRef {
    source_id: Option<String>,
    target_id: Option<String>,
}

/// 这一方此刻在哪：原件位置里查不到、agent 目录下那一份不是真实文件夹时报「已不存在」
fn copy_path(
    copy: &CopyRef,
    skill: &str,
    sources: &[Source],
    targets: &[Target],
) -> Result<PathBuf, String> {
    if let Some(id) = &copy.source_id {
        return sources
            .iter()
            .find(|s| &s.id == id)
            .ok_or_else(|| sophia_core::t!("shell.error.originLocationGone"))?
            .skill_path(skill)
            .map(Path::to_path_buf)
            .ok_or_else(|| sophia_core::t!("shell.error.originGone"));
    }
    let target = targets
        .iter()
        .find(|t| Some(&t.id) == copy.target_id.as_ref())
        .ok_or_else(|| sophia_core::t!("shell.error.targetGone"))?;
    let path = target.path.join(skill);
    // 只认带 `SKILL.md` 的真实文件夹：链接要走 `remove_link`，不能当成一份挪走；不带 `SKILL.md` 的不是 skill
    if sophia_core::fs::entry_kind(&path) != sophia_core::fs::EntryKind::Dir
        || !path.join("SKILL.md").is_file()
    {
        return Err(sophia_core::t!("shell.error.originGone"));
    }
    Ok(path)
}

/// 同名两份里有一份在 agent 自己目录里时的「只留这份」体检（issue #153）：挪走 `drop`、留下 `keep`，
/// 指向 `drop` 的链接改指到 `keep`。计划同 `plan_delete_source` 留在服务端，确认后凭 `plan_id` 调 `delete_source`
#[tauri::command]
fn plan_keep_copy(
    skill: String,
    keep: CopyRef,
    drop: CopyRef,
    state: tauri::State<'_, AppState>,
) -> Result<PlannedDeletion, String> {
    let (sources, targets) = discover(&state)?;
    let keep = copy_path(&keep, &skill, &sources, &targets)?;
    let path = copy_path(&drop, &skill, &sources, &targets)?;
    let drop = Skill {
        name: skill,
        path,
        description: None,
    };
    let plan = skills::plan_keep(&drop, &keep, &targets, &load_copies(&state)?);
    let plan_id = state
        .next_delete_plan
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    *state
        .delete_plan
        .lock()
        .map_err(|_| sophia_core::t!("shell.error.deletePlanCacheCorrupt"))? =
        Some((plan_id.clone(), plan.clone()));
    Ok(PlannedDeletion { plan_id, plan })
}

/// 执行服务端存着的那份删除计划。单独成命令，是为了把用户确认卡在两次调用之间；
/// 计划用后即弃，同一个 `plan_id` 不能重放
///
/// `in_git_confirmed`：删原件的确认框已经写明「它在 git 仓库里」、用户仍点了删除（DESIGN「删除原件」）——
/// 只有这时才放过仓库这道闸；只留这份不传它，仓库里的照旧不代删
#[tauri::command]
fn delete_source(
    plan_id: String,
    in_git_confirmed: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<DeleteResult, String> {
    let plan = {
        let mut cache = state
            .delete_plan
            .lock()
            .map_err(|_| sophia_core::t!("shell.error.deletePlanCacheCorrupt"))?;
        match cache.as_ref() {
            Some((cached_id, _)) if cached_id == &plan_id => cache.take().expect("刚判过是 Some").1,
            _ => return Err(sophia_core::t!("shell.error.deletePlanMissing")),
        }
    };
    let mut plan = plan;
    if in_git_confirmed == Some(true) {
        plan.in_git = None;
    }
    let hold_root = held_dir()?;
    let mut undo_slot = state
        .delete_undo
        .lock()
        .map_err(|_| sophia_core::t!("shell.error.undoCorrupt"))?;
    // 新的一次删除：上一次的撤销机会过去，暂存的原件移进废纸篓
    undo_slot.take();
    sync::release_held(&hold_root);
    let (report, undo) = sync::delete_source_holding(&plan, Some(&hold_root), Some(&state.store));
    let undo_id = undo.map(|undo| {
        let id = state
            .next_delete_plan
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        *undo_slot = Some((id.clone(), undo));
        id
    });
    Ok(DeleteResult { report, undo_id })
}

/// 删原件的结果：逐项报告 + 撤销 id（原件挪进了暂存处才有；跨磁盘退回直接进废纸篓时没有）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResult {
    report: SyncReport,
    undo_id: Option<String>,
}

/// 删原件时暂存原件的地方：应用数据目录下，与主目录多半同一磁盘，挪进去是一次改名
fn held_dir() -> Result<PathBuf, String> {
    Ok(runtime_store_dir()?.join("held"))
}

/// 撤销最近一次删原件：原件放回原处、链接复原。记录用过即删；撤不回的步骤逐条如实上报
#[tauri::command]
fn undo_delete_source(
    undo_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let undo = {
        let mut slot = state
            .delete_undo
            .lock()
            .map_err(|_| sophia_core::t!("shell.error.undoCorrupt"))?;
        match slot.as_ref() {
            Some((id, _)) if id == &undo_id => slot.take().expect("刚判过是 Some").1,
            _ => return Err(sophia_core::t!("shell.error.undoExpired")),
        }
    };
    Ok(sync::undo_delete(&undo, Some(&state.store)))
}

/// 来源管理页：这个位置（`DomainPage.key`）已订阅的来源，以及 `+ 来源` 的两组候选。只读
#[tauri::command]
fn list_sources(
    domain: String,
    state: tauri::State<'_, AppState>,
) -> Result<subscriptions::SourceList, String> {
    let (sources, targets) = discover(&state)?;
    let settings = subscribed_settings(&state, &sources, &targets)?;
    let home = runtime_env()?.home;
    Ok(subscriptions::list(
        &domain,
        &sources,
        &targets,
        &settings.subscriptions,
        &settings.auto_links,
        &home,
        &load_copies(&state)?,
    ))
}

/// 在这个位置订阅一个来源：路径来自候选，或来自用户选的文件夹。只记订阅，不建链
#[tauri::command]
fn subscribe_source(
    domain: String,
    path: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let (sources, targets) = discover(&state)?;
    let mut settings = subscribed_settings(&state, &sources, &targets)?;
    subscriptions::subscribe(
        &mut settings.subscriptions,
        &domain,
        &path,
        &sources,
        &targets,
    )
    .map_err(|e| cmd_error::said(e))?;
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 添加来源弹窗：选好的文件夹订阅之前先看一眼里面的 skill。只读，不记订阅、不建链
#[tauri::command]
fn preview_source_folder(
    path: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<subscriptions::SourceSummary, String> {
    let (sources, _) = discover(&state)?;
    let home = runtime_env()?.home;
    Ok(subscriptions::preview_folder(&path, &sources, &home))
}

/// 移除来源前的只读清单：会撤掉的软链与副本（skill × agent，两者不分），给确认框列出。
/// 原件在这个位置里的来源返回拒绝的原因
#[tauri::command]
fn plan_remove_source(
    domain: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<subscriptions::SourceRemoval, String> {
    let (sources, targets) = discover(&state)?;
    subscriptions::plan_remove(
        &domain,
        &source_id,
        &sources,
        &targets,
        &load_copies(&state)?,
    )
}

/// 从这个位置移除来源：撤掉它在这里的软链与副本（删前重校验），再删订阅记录与规则里本位置的目标。
/// 执行时按当下的文件系统重新算清单，不沿用确认框那一份
#[tauri::command]
fn remove_source(
    domain: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let _settings_guard = state.store.lock_settings();
    let (sources, targets) = discover(&state)?;
    let mut settings = subscribed_settings(&state, &sources, &targets)?;
    let report = subscriptions::remove(
        &domain,
        &source_id,
        &sources,
        &targets,
        &mut settings.subscriptions,
        &mut settings.auto_links,
        Some(&state.store),
    )
    .map_err(|e| cmd_error::said(e))?;
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    Ok(report)
}

/// MCP 扫描一次，并读设置、认领订阅：来源管理页的命令都从这一步开始
fn mcp_scanned(
    state: &AppState,
) -> Result<
    (
        sophia_core::mcp::McpDiscovery,
        sophia_core::mcp::McpOverview,
        sophia_core::store::Settings,
    ),
    String,
> {
    let discovery = discover_mcp(state)?;
    let mut overview = sophia_core::mcp::scan(&discovery.locations);
    overview.issues.extend(discovery.issues.iter().cloned());
    let settings = state
        .store
        .load_settings_adopting_mcp_subscriptions(&overview)
        .map_err(|e| cmd_error::data_unread(e))?;
    Ok((discovery, overview, settings))
}

/// MCP 来源管理页：这个位置（域 key）已订阅的来源，以及 `+ 来源` 的两组候选。只读
#[tauri::command]
fn list_mcp_sources(
    domain: String,
    state: tauri::State<'_, AppState>,
) -> Result<mcp_sources::McpSourceList, String> {
    let (_, overview, settings) = mcp_scanned(&state)?;
    Ok(mcp_sources::list(
        &domain,
        &overview,
        &settings.mcp_subscriptions,
        &settings.mcp_auto_imports,
    ))
}

/// 在这个位置订阅一处 MCP 配置（位置 id）。只记订阅，不写配置
#[tauri::command]
fn subscribe_mcp_source(
    domain: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let (_, overview, mut settings) = mcp_scanned(&state)?;
    mcp_sources::subscribe(
        &mut settings.mcp_subscriptions,
        &domain,
        &source_id,
        &overview,
    )
    .map_err(|e| cmd_error::said(e))?;
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 移除 MCP 来源前的只读清单：本位置哪几处有一份与它一致的（服务名 × 位置），给确认框列出。
/// 这个位置自己的配置返回拒绝的原因
#[tauri::command]
fn plan_remove_mcp_source(
    domain: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<mcp_sources::McpSourceRemoval, String> {
    let discovery = discover_mcp(&state)?;
    mcp_sources::plan_remove(&domain, &source_id, &discovery.locations)
}

/// 从这个位置移除 MCP 来源：只拿掉确认过的那几项，执行前逐项重校验仍与来源一致，
/// 改过的跳过；再删订阅记录与往这里写的规则。来源本身不动
#[tauri::command]
fn remove_mcp_source(
    domain: String,
    source_id: String,
    items: Vec<mcp_sources::McpRemovalItem>,
    state: tauri::State<'_, AppState>,
) -> Result<sophia_core::mcp::McpReport, String> {
    // 会写 ~/.codex/config.toml：与模型页、MCP 写入共用一把锁（同步命令，见 auto_import_mcp）。
    // 也改设置：配置写锁在前、设置锁在后，读设置到写回全程拿着
    let _config_guard = state.config_lock.blocking_lock();
    let _settings_guard = state.store.lock_settings();
    let (discovery, _, mut settings) = mcp_scanned(&state)?;
    let report = {
        mcp_sources::remove(
            &domain,
            &source_id,
            &items,
            &discovery.locations,
            &mut settings.mcp_subscriptions,
            &mut settings.mcp_auto_imports,
            &state.store.backups_dir(),
        )
        .map_err(|e| cmd_error::said(e))?
    };
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    Ok(report)
}

#[tauri::command]
fn list_manual_sources(state: tauri::State<'_, AppState>) -> Result<Vec<PathBuf>, String> {
    Ok(state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?
        .manual_sources)
}

#[tauri::command]
fn add_manual_source(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let path = normalize(&path);
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    if !settings.manual_sources.contains(&path) {
        settings.manual_sources.push(path);
    }
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

#[tauri::command]
fn remove_manual_source(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let path = normalize(&path);
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    settings.manual_sources.retain(|p| normalize(p) != path);
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

#[tauri::command]
fn list_auto_links(state: tauri::State<'_, AppState>) -> Result<Vec<AutoLink>, String> {
    Ok(state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?
        .auto_links)
}

/// 保存的是已发现位置的精确身份，不保存任何 MCP 定义或凭据。
#[tauri::command]
fn set_mcp_auto_import(
    source_id: String,
    target_domain: String,
    target_ids: Vec<String>,
    allow_cross_domain: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if target_domain.trim().is_empty() {
        return Err(sophia_core::t!("shell.error.targetDomainEmpty"));
    }
    if target_ids.is_empty() {
        return Err(sophia_core::t!("shell.error.targetLocationNone"));
    }
    let discovery = discover_mcp(&state)?;
    let source = discovery
        .locations
        .iter()
        .find(|location| location.id == source_id)
        .ok_or_else(|| sophia_core::t!("shell.error.sourceLocationGone"))?;
    let mut seen = BTreeSet::new();
    let mut targets = Vec::with_capacity(target_ids.len());
    for target_id in target_ids {
        if !seen.insert(target_id.clone()) {
            return Err(sophia_core::t!("shell.error.targetDuplicate"));
        }
        let target = discovery
            .locations
            .iter()
            .find(|location| location.id == target_id)
            .ok_or_else(|| sophia_core::t!("shell.error.targetLocationGone"))?;
        if target.domain != target_domain {
            return Err(sophia_core::t!("shell.error.targetNotInDomain"));
        }
        targets.push(sophia_core::mcp::location_ref(target));
    }
    if source.domain != target_domain && !allow_cross_domain {
        return Err(sophia_core::t!("shell.error.crossDomainNeedsAllow"));
    }
    let _settings_guard = state.store.lock_settings();
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    // 同一来源+目标域重新设置：目标集合整体替换；已生效的规则保留 baseline 与排除名单，
    // 不重拍。新建（或关掉后再开）才在 core 里按此刻来源的全部名字拍 baseline
    let overview = sophia_core::mcp::scan(&discovery.locations);
    sophia_core::mcp::upsert_auto_import(
        &mut settings.mcp_auto_imports,
        &overview,
        source,
        target_domain,
        targets,
        allow_cross_domain,
    )
    .map_err(|e| cmd_error::said(e))?;
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

#[tauri::command]
fn remove_mcp_auto_import(
    source_id: String,
    target_domain: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    settings
        .mcp_auto_imports
        .retain(|rule| rule.source.id != source_id || rule.target_domain != target_domain);
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 新建或合并一条规则；解除排除由 `include_auto_link` 单独做
#[tauri::command]
fn set_auto_link(
    source: PathBuf,
    targets: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // baseline 在 core 里按此刻本体位置的全部 skill 拍，规则只管以后新出现的
    let (sources, _) = discover(&state)?;
    update_auto_links(&state, |rules| {
        skills::upsert_auto_link(rules, &sources, &source, &targets)
    })
}

#[tauri::command]
fn remove_auto_link(source: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    update_auto_links(&state, |rules| skills::remove_auto_link(rules, &source))
}

/// 只撤该本体位置的部分目标；目标去空则整条规则删除
#[tauri::command]
fn remove_auto_link_targets(
    source: PathBuf,
    targets: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    update_auto_links(&state, |rules| {
        skills::remove_auto_link_targets(rules, &source, &targets)
    })
}

/// 只在这个目标上排除：别的位置照常自动链接
#[tauri::command]
fn exclude_auto_link(
    source: PathBuf,
    target: String,
    skill: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    update_auto_links(&state, |rules| {
        skills::exclude(rules, &source, &target, &skill)
    })
}

#[tauri::command]
fn include_auto_link(
    source: PathBuf,
    target: String,
    skill: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    update_auto_links(&state, |rules| {
        skills::include(rules, &source, &target, &skill)
    })
}

fn update_auto_links(
    state: &AppState,
    edit: impl FnOnce(&mut Vec<AutoLink>),
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    edit(&mut settings.auto_links);
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 全部品牌与产品及其勾选、安装状态，外加显示上限。返回全部而不只是已安装的：
/// 设置页要列出「未安装的 N 个」（只是信息，未安装的不在不显示名单里）
#[tauri::command]
fn list_harnesses(state: tauri::State<'_, AppState>) -> Result<HarnessList, String> {
    let env = runtime_env()?;
    let (_, settings) = installed_and_settings(&state, &env)?;
    let installed: std::collections::HashSet<String> = discovery::installed_products(&env)
        .into_iter()
        .map(|h| h.id)
        .collect();
    let skill_ids: std::collections::HashSet<String> = discovery::all_harnesses(&env)
        .into_iter()
        .map(|h| h.id)
        .collect();
    let mut harnesses = Vec::new();
    let mut brands = Vec::new();
    for brand in discovery::all_brands(&env) {
        let enabled = !settings.disabled_harnesses.contains(&brand.id);
        let installed_products: Vec<String> = brand
            .products
            .iter()
            .filter(|h| installed.contains(&h.id))
            .map(|h| h.id.clone())
            .collect();
        for h in brand.products {
            let (skill_user, skill_project) = discovery::skill_columns(&env, &h);
            harnesses.push(HarnessStatus {
                enabled,
                installed: installed.contains(&h.id),
                skills: skill_ids.contains(&h.id),
                mcp: sophia_core::mcp::supports(&h.id),
                mcp_trust: sophia_core::mcp::trust_app(&h.id).is_some(),
                skill_user,
                skill_project,
                id: h.id,
                display_name: h.display_name,
                brand: h.brand,
                brand_name: h.brand_name,
            });
        }
        brands.push(BrandStatus {
            id: brand.id,
            name: brand.name,
            enabled,
            installed: !installed_products.is_empty(),
            installed_products,
        });
    }
    Ok(HarnessList {
        max_shown: discovery::MAX_SHOWN,
        harnesses,
        brands,
    })
}

/// 勾选 / 取消勾选一个品牌（`id` 是品牌 id，#251）；显示已满时勾第 5 个会被拒，错误信息就是给用户看的那句
#[tauri::command]
fn set_harness_enabled(
    id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let env = runtime_env()?;
    // 同 `installed_and_settings`，只是这里是保存：读写设置失败说「设置保存失败」，显示已满的那句原样说
    let ids = discovery::installed_brands(&env);
    let mut settings = state
        .store
        .load_settings_reconciling_shown(&ids)
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    discovery::set_shown(&ids, &mut settings, &id, enabled).map_err(|e| cmd_error::said(e))?;
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 设置「生效范围」的项目格：自动检测的与手动选的（存在的才列），带勾没勾
#[tauri::command]
fn list_projects(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<discovery::ProjectScope>, String> {
    let env = runtime_env()?;
    let (installed, settings) = installed_and_settings(&state, &env)?;
    let harnesses = discovery::enabled(installed, &settings);
    let manual = state
        .store
        .load_projects()
        .map_err(|e| cmd_error::data_unread(e))?;
    Ok(discovery::project_scopes(
        discovery::projects(&env, &harnesses, &manual),
        &settings.hidden_projects,
    ))
}

/// `+ 项目` / 应用菜单「添加项目…」：选的文件夹记进 projects.json、默认勾上；当不了项目的（主目录、
/// 不是文件夹）拒绝，错误信息就是给用户看的那句
#[tauri::command]
fn add_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let env = runtime_env()?;
    let _settings_guard = state.store.lock_settings();
    let mut manual = state
        .store
        .load_projects()
        .map_err(|e| cmd_error::data_unread(e))?;
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?;
    let path = discovery::add_manual_project(&env, &mut manual, &mut settings, &path)
        .map_err(|e| cmd_error::said(e))?;
    state
        .store
        .save_projects(&manual)
        .map_err(|e| cmd_error::data_unsaved(e))?;
    state
        .store
        .save_settings(&settings)
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    // 「更多」浮层按「最近创建」排序时，取不到文件夹创建时间就用加入时间
    state
        .store
        .mark_project_added(&path, now_ms())
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 「生效范围」里勾上 / 取消勾一个项目。取消勾只是不显示，已建好的链接原样留着
#[tauri::command]
fn set_project_shown(
    path: PathBuf,
    shown: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _settings_guard = state.store.lock_settings();
    let mut settings = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::settings_unsaved(e))?;
    if discovery::set_project_shown(&mut settings, &path, shown) {
        state
            .store
            .save_settings(&settings)
            .map_err(|e| cmd_error::settings_unsaved(e))?;
    }
    Ok(())
}

/// 此刻的毫秒时间戳；时钟早于 1970 时记 0
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 看过的新手提示 id（前端 `src/hints.ts` 登记）
#[tauri::command]
fn list_seen_hints(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    state
        .store
        .seen_hints()
        .map_err(|e| cmd_error::data_unread(e))
}

/// 记下一条看过的新手提示（关掉或学会）；去重、空串忽略
#[tauri::command]
fn mark_hint_seen(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .store
        .mark_hint_seen(&id)
        .map_err(|e| cmd_error::settings_unsaved(e))
}

/// 上次是不是意外退出的（崩溃、被强制结束、断电；spec 2026-10-04-local-diagnostics R8）。
/// 怎么提示由上报反馈那份 spec 决定，本身不带界面
#[tauri::command]
fn last_exit_unexpected(state: tauri::State<'_, AppState>) -> bool {
    state.last_exit_unexpected.load(Ordering::SeqCst)
}

/// 这次启动时设置文件（settings.json / projects.json）坏了、已另存并按默认值重置（spec S7）。
/// 界面据此提示一次：第三方模型随设置一起关了，Codex 已在启动时改回官方
#[tauri::command]
fn settings_repaired(state: tauri::State<'_, AppState>) -> bool {
    state.settings_repaired.load(Ordering::SeqCst)
}

/// 启动最早期修坏文件（spec S7）：读不出的 settings.json / projects.json 另存为 `.broken-<时间>`，
/// 之后一切按默认值走。只有界面进程做；返回有没有修过
fn repair_store_files(store: &Store) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match store.repair_if_corrupt(now) {
        Ok(moved) if moved.is_empty() => false,
        Ok(moved) => {
            for path in &moved {
                log::warn!("设置文件损坏，已另存为 {} 并重置", path.display());
            }
            true
        }
        Err(e) => {
            log::warn!("检查设置文件是否损坏时出错：{e}");
            false
        }
    }
}

/// 侧栏排序用的项目时间（最近活跃 / 最近创建），按传入顺序返回。只读元数据，不写盘
#[tauri::command]
fn project_times(
    paths: Vec<PathBuf>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<sophia_core::activity::ProjectTimes>, String> {
    let env = runtime_env()?;
    let claude_projects = env
        .vars
        .get("CLAUDE_CONFIG_DIR")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| env.home.join(".claude"))
        .join("projects");
    let agent_dirs = sophia_core::activity::agent_dir_names(&discovery::all_harnesses(&env));
    let added = state
        .store
        .load_settings()
        .map_err(|e| cmd_error::data_unread(e))?
        .project_added_at;
    Ok(paths
        .iter()
        .map(|p| {
            let at = added.get(normalize(p).to_string_lossy().as_ref()).copied();
            sophia_core::activity::project_times(p, &claude_projects, &agent_dirs, at)
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 应用标识（开发版带 `.dev`）最先定：日志目录、运行标记都按它分，日志插件注册时就要用
    let context = tauri::generate_context!();
    diagnostics::set_identity(&context.config().identifier);
    // 设置文件坏了先修（spec S7）：在任何人读设置之前；之后读到的都是默认值
    let store = Store::new(runtime_store_dir().unwrap_or_else(|e| panic!("{e}")));
    let repaired = repair_store_files(&store);
    // 界面语言最先定：下面 `menu::build` 建应用菜单时就要按它取名字（spec 2026-09-30-language-and-theme R13）
    language::init(&store);
    // 同一时间只运行一个 Sophia（spec 2026-10-03-gateway-in-app R3）：必须第一个注册，第二个进程在它的 setup 里就退出。
    // 再次打开时把已有的主窗口带到前面（窗口藏在菜单栏里时插件不管）
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二个实例被拦下时它自己什么都不说就退了（exit 0）；在活着的这个实例里记一条，
            // 排查「新开的 Sophia 怎么没出来」时有据可查（2026-10-05 retro）
            log::info!("又开了一个 Sophia，已被拦下；把现有窗口带到前面");
            #[cfg(target_os = "macos")]
            tray::show_main(app);
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = tauri::Manager::get_webview_window(app, tray::MAIN) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    // 本机日志（spec 2026-10-04-local-diagnostics R1–R3）：紧跟单实例之后注册，第二个进程不必开日志文件
    let builder = builder.plugin(diagnostics::log_plugin());
    // 托盘面板要做成不激活应用的 NSPanel（tray.rs），面板登记表由这个插件管
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    // 原生应用菜单（D15）：只在 macOS 上装，别的系统上菜单栏会画进窗口里
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 应用内更新：查清单、下载、验签、装都在插件里，`app_update.rs` 的命令按线路逐个调它（GitHub → 国内线路）并给出错分类，前端只负责问与决定。
        // 重启交给 process 插件——装完不重启，用户还在跑旧的那一份。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 右键「拷贝路径」：选中项在原生菜单关掉之后才执行，已不在网页的用户手势里，
        // WKWebView 的 navigator.clipboard 会拒绝（NotAllowedError）；走原生剪贴板
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            config_lock: Default::default(),
            gateway: {
                let gateway = gateway::build(runtime_store_dir().unwrap_or_else(|e| panic!("{e}")));
                // 崩溃时先把 Codex 设置改回原样再退出（spec 2026-10-05-exit-fallback R1）：
                // 和关机走同一条 exit_sync，只改 Codex、有时限、不起子进程
                if let Some(app) = gateway.clone() {
                    diagnostics::on_panic_exit(move || app.exit_sync());
                }
                // 设置刚被重置（spec S7）：第三方模型的「开着」随之丢了，Codex 设置却还指着本机网关——
                // 立刻按值改回，不等退出。和关机走同一条 exit_sync
                if repaired {
                    if let Some(app) = gateway.as_ref() {
                        app.exit_sync();
                    }
                }
                gateway
            },
            store,
            watcher: Mutex::new(None),
            mcp_plan: Mutex::new(None),
            next_mcp_plan: AtomicU64::new(1),
            mcp_undo: Mutex::new(Vec::new()),
            next_mcp_undo: AtomicU64::new(1),
            delete_plan: Mutex::new(None),
            next_delete_plan: AtomicU64::new(1),
            delete_undo: Mutex::new(None),
            last_exit_unexpected: Default::default(),
            settings_repaired: std::sync::atomic::AtomicBool::new(repaired),
        })
        // 发现与安装的运行时状态（缓存、撤销记录），字段由 market.rs 自己管
        .manage(market::MarketState::default())
        .manage(app_update::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            scan_all,
            scan_mcp,
            mcp_field_diff,
            mcp_endpoint,
            propose_mcp_sync,
            apply_mcp,
            check_mcp_key_hints,
            add_mcp_gitignore,
            delete_mcp_original,
            check_mcp_keep_key_hints,
            keep_mcp_copy,
            mcp_open_trust_app,
            mcp_undo_write,
            propose_links,
            propose_unlinks,
            apply_all,
            split_whole_link,
            plan_delete_source,
            plan_keep_copy,
            skill_copy_info,
            delete_source,
            undo_delete_source,
            list_sources,
            subscribe_source,
            preview_source_folder,
            plan_remove_source,
            remove_source,
            list_mcp_sources,
            subscribe_mcp_source,
            plan_remove_mcp_source,
            remove_mcp_source,
            list_projects,
            add_project,
            set_project_shown,
            list_manual_sources,
            add_manual_source,
            remove_manual_source,
            project_times,
            list_auto_links,
            set_auto_link,
            remove_auto_link,
            remove_auto_link_targets,
            exclude_auto_link,
            include_auto_link,
            set_mcp_auto_import,
            remove_mcp_auto_import,
            list_harnesses,
            set_harness_enabled,
            list_seen_hints,
            mark_hint_seen,
            gateway::gateway_state,
            gateway::gateway_fix_file_owner,
            gateway::gateway_open_file,
            gateway::gateway_presets,
            gateway::gateway_pick,
            gateway::gateway_reorder_picks,
            gateway::gateway_restore_order,
            gateway::gateway_enable,
            gateway::gateway_restore,
            gateway::gateway_takeover,
            gateway::gateway_restart,
            gateway::gateway_restart_codex,
            gateway::gateway_launch_codex,
            gateway::gateway_restart_claude,
            gateway::gateway_launch_claude,
            providers::providers_list,
            providers::providers_preview,
            providers::providers_probe_draft,
            providers::providers_add,
            providers::providers_edit,
            providers::providers_refetch,
            providers::providers_set_enabled,
            providers::providers_add_typed,
            providers::providers_remove,
            tray::tray_open_main,
            tray::tray_set_height,
            tray::tray_hide,
            quit::quit_preview,
            quit::app_quit,
            quit::app_exit_now,
            autostart::autostart_get,
            autostart::autostart_set,
            menu::set_menu_state,
            // ── 发现与安装（spec 2026-09-27-skill-mcp-market）：T0 预留，实现在 market.rs ──
            market::market_popular,
            market::market_search_skills,
            market::market_mcp_curated,
            market::market_search_mcp,
            market::market_skill_readme,
            market::market_mcp_readme,
            market::market_resolve_link,
            market::market_plan_skill_install,
            market::market_install_skill,
            app_update::app_update_check,
            app_update::app_update_install,
            market::market_plan_mcp_install,
            market::market_install_mcp,
            market::market_parse_mcp_json,
            market::market_check_updates,
            market::market_update_skills,
            market::market_undo,
            market::market_dismiss_updates,
            market::skill_update_settings,
            market::set_auto_check_skill_updates,
            // ── 菜单栏用量（spec 2026-09-26-menubar-usage）──
            usage::usage_view,
            usage::usage_settings,
            usage::usage_set_settings,
            appearance::appearance,
            appearance::set_appearance,
            language::ui_language,
            language::set_ui_language,
            usage::usage_refresh,
            usage::usage_connect,
            usage::usage_connect_cancel,
            usage::usage_connect_reopen,
            last_exit_unexpected,
            settings_repaired,
            diagnostics::redact_text,
            diagnostics::debug_fault,
            #[cfg(not(feature = "weiboap"))]
            report::report_settings,
            #[cfg(not(feature = "weiboap"))]
            report::set_auto_report,
            #[cfg(not(feature = "weiboap"))]
            report::report_count_frontend,
            #[cfg(not(feature = "weiboap"))]
            feedback::feedback_upload_shot,
            #[cfg(not(feature = "weiboap"))]
            feedback::feedback_send
        ])
        .setup(|_app| {
            // 后台问一次登录 shell 要 PATH 与两个目录变量（spec S16）：不等它，问到之前按现状找程序。
            // 放在 setup 里而不是更早：日志插件此时已装好，问到没问到有一条日志可查
            sophia_gateway::login_env::start();
            // 本机诊断最先接上：日志目录、启动日志、上次是否意外退出（运行标记在数据目录下）
            {
                use tauri::Manager;
                let data_dir = runtime_store_dir().ok();
                let unexpected = diagnostics::on_setup(_app, data_dir.as_deref());
                _app.state::<AppState>()
                    .last_exit_unexpected
                    .store(unexpected, Ordering::SeqCst);
            }
            // 上次运行里删掉、还暂存着的原件：撤销机会已随上次运行过去，移进废纸篓
            match held_dir() {
                Ok(dir) => {
                    for (path, error) in sync::release_held(&dir) {
                        log::warn!("暂存的原件 {} 没能移进废纸篓：{error}", path.display());
                    }
                }
                Err(e) => log::warn!("找不到暂存原件的目录：{e}"),
            }
            // 外观：按存下的设到窗口上（各平台都有；托盘面板在下面建好之后再设一次）
            appearance::apply_saved(_app.handle());
            // 菜单栏入口只在 macOS 上有：模型注入本身只支持 macOS
            #[cfg(target_os = "macos")]
            {
                // 面板、图标建不成只记日志，不拦启动（spec prelaunch-five R1–R4）
                tray::setup(_app);
                menu::after_setup(_app.handle());
                appearance::apply_saved(_app.handle());
            }
            // 用量调度：托盘建好之后再起，第一次交出状态时菜单栏按钮已经在了
            if let Err(e) = usage::setup(_app) {
                log::warn!("用量调度没起来，菜单栏不显示用量：{e}");
            }
            // 开机启动默认开（spec 2026-10-05-keep-running R1）：第一次打开注册一次，之后以系统为准
            if let Ok(dir) = runtime_store_dir() {
                autostart::default_on_first_launch(_app.handle().clone(), dir);
            }
            // 自动上报：没有接收服务地址（开发版、自己编译的版本）或设了 DO_NOT_TRACK 时什么都不做；
            // 有就 30 秒后起后台循环
            #[cfg(not(feature = "weiboap"))]
            report::setup(_app);
            // 模型网关接上（spec 2026-10-03-gateway-in-app R12–R14）：先卸掉旧版留下的 launchd 服务（它占着端口），
            // 再按「开着」起路由、写设置。会写 Codex 设置，取配置写锁；普通线程上可以 blocking_lock。
            // 做完通知界面重读状态（端口说明、开关）
            {
                use tauri::Manager;
                let state = _app.state::<AppState>();
                if let Some(gateway) = state.gateway.clone() {
                    let lock = state.config_lock.clone();
                    let handle = _app.handle().clone();
                    std::thread::spawn(move || {
                        {
                            let _guard = lock.blocking_lock();
                            if let Err(e) = gateway.migrate_legacy_service() {
                                log::warn!("卸旧版路由服务失败：{e}");
                            }
                            for error in gateway.attach().errors {
                                log::warn!("接上模型网关失败：{}", error.message);
                            }
                        }
                        let _ = handle.emit("gateway-changed", ());
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            // 关主窗口＝藏到菜单栏，不退出；别的系统上没有菜单栏入口，关窗照旧退出
            #[cfg(target_os = "macos")]
            if let Ok(dir) = runtime_store_dir() {
                tray::intercept_close(_window, _event, &dir);
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // 主窗口创建时不可见（tauri.conf.json）：登录项拉起就只留菜单栏，否则这时开窗口
            // （spec 2026-10-05-keep-running R2）
            if let tauri::RunEvent::Ready = _event {
                autostart::show_main_unless_login_item(_app);
            }
            // 窗口藏起来之后点 Dock 图标：把它带回来
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main(_app);
            }
            // 升级重启不改回；关机、注销、Dock 退出同步改回 Codex 设置
            quit::on_run_event(_app, &_event);
        });
}

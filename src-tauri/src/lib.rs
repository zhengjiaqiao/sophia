//! Tauri 命令层：每个命令一行调 core，错误统一转 String
mod gateway;
mod menu;
mod tray;
mod watch;

pub use gateway::cli as gateway_cli;

use serde::Serialize;
use std::collections::BTreeSet;
#[cfg(debug_assertions)]
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use symsync_core::discovery::{self, Env};
use symsync_core::fs::normalize;
use symsync_core::mcp::sources as mcp_sources;
use symsync_core::models::*;
use symsync_core::skills;
use symsync_core::store::Store;
use symsync_core::subscriptions;
use symsync_core::sync;
use tauri::Emitter;

struct AppState {
    store: Store,
    /// 当前的文件系统监视，随每次扫描的目录集合重建
    watcher: Mutex<Option<watch::Watcher>>,
    mcp_plan: Mutex<Option<(String, symsync_core::mcp::PreparedPlan)>>,
    next_mcp_plan: AtomicU64,
    /// MCP 写入的撤销记录，按随机 id 存在内存里：前端只拿 id，碰不到路径和快照。
    /// 下一次写到同一文件时旧记录失效（那次写会留新备份、换新指纹），用过一次即删，退出即丢
    mcp_undo: Mutex<Vec<(String, symsync_core::mcp::McpUndo)>>,
    next_mcp_undo: AtomicU64,
    /// 待确认的删本体计划。计划必须留在服务端：`in_git`（仓库里的不代删）是道安全闸门，
    /// 让它在前端转一圈就等于可以被改掉
    delete_plan: Mutex<Option<(String, DeleteSourcePlan)>>,
    next_delete_plan: AtomicU64,
    /// 同一进程里写 ~/.codex/config.toml 的路径（MCP 同步、模型页）共用这把锁，避免互相撞出“配置已变化”。
    /// 跨进程仍靠 atomicfile 的写前写后校验兜底。
    config_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// 模型网关；仅 macOS 上有
    gateway: Option<std::sync::Arc<symsync_gateway::app::App>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessStatus {
    id: String,
    display_name: String,
    enabled: bool,
    /// 这台机器上装没装。设置页默认只列已安装的，其余收在「显示未安装的 N 个」后面——
    /// 未安装的也要带出来（只列名字，不在不显示名单里的给「恢复」），不能只返回已安装的那些
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessList {
    /// 列表里最多显示几个（core 的 `discovery::MAX_SHOWN`，前端不另写）
    max_shown: usize,
    harnesses: Vec<HarnessStatus>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 仅供 Debug 原生 MCP UI 验收使用的临时根目录；生产环境始终使用系统环境。
fn runtime_env() -> Result<Env, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("SYMSYNC_TEST_HOME") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err("SYMSYNC_TEST_HOME 必须是已存在的绝对目录".into());
        }
        let root = std::fs::canonicalize(root).map_err(err)?;
        return Ok(Env {
            home: normalize(&root),
            vars: HashMap::new(),
        });
    }
    Ok(Env::from_system())
}

pub(crate) fn runtime_store_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("SYMSYNC_TEST_HOME") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err("SYMSYNC_TEST_HOME 必须是已存在的绝对目录".into());
        }
        let root = std::fs::canonicalize(root).map_err(err)?;
        return Ok(root.join("AppData").join("SymSync"));
    }
    Ok(Store::default_dir())
}

/// 已安装的 harness（按 agent 表先后）与设置；读设置时顺手按显示上限整理不显示名单
/// （新用户取前 4 个、老数据超出的记进名单、新装的只在不满时出现，见 `discovery::reconcile_shown`）
fn installed_and_settings(
    state: &AppState,
    env: &Env,
) -> Result<(Vec<Harness>, symsync_core::store::Settings), String> {
    let installed = discovery::installed(env);
    let ids: Vec<String> = installed.iter().map(|h| h.id.clone()).collect();
    let settings = state
        .store
        .load_settings_reconciling_shown(&ids)
        .map_err(err)?;
    Ok((installed, settings))
}

fn discover_mcp(state: &AppState) -> Result<symsync_core::mcp::McpDiscovery, String> {
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
    let harnesses = discovery::enabled(candidates, &settings);
    let manual_projects = state.store.load_projects().map_err(err)?;
    let projects = discovery::project_candidates(&env, &manual_projects, &harnesses);
    Ok(symsync_core::mcp::discover_locations(
        &env, &harnesses, &projects,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpPreview {
    plan_id: String,
    actions: Vec<symsync_core::mcp::McpAction>,
    issues: Vec<symsync_core::mcp::McpIssue>,
}

/// 一次发现：本体位置与目标目录，按当前设置解析。返回的目标含目录尚不存在的那批
/// （`Target.exists == false`），它们照常成列，补齐时目录就地创建。
/// 订阅记录里常规发现找不到的文件夹（来源管理页选的）在目标之前读进来；
/// 目标目录里指向已知位置之外的软链再合成出外部本体位置
fn discover(state: &AppState) -> Result<(Vec<Source>, Vec<Target>), String> {
    let env = runtime_env()?;
    let (installed, settings) = installed_and_settings(state, &env)?;
    let harnesses = discovery::enabled(installed, &settings);
    let manual_projects = state.store.load_projects().map_err(err)?;
    let projects = discovery::project_candidates(&env, &manual_projects, &harnesses);
    let mut sources = discovery::sources(&env, &harnesses, &projects, &settings.manual_sources);
    let subscribed = discovery::subscribed_sources(
        &subscriptions::recorded_dirs(&settings.subscriptions),
        &sources,
    );
    sources.extend(subscribed);
    let targets = discovery::targets(&env, &harnesses, &projects, &sources);
    let external = discovery::external_sources(&env, &targets, &sources);
    sources.extend(external);
    Ok((sources, targets))
}

/// 完整扫描：发现 → 把此刻有软链的来源记进订阅（第一次扫描时认领老数据）→ 按域扫描
fn overview(state: &AppState) -> Result<Overview, String> {
    let (sources, targets) = discover(state)?;
    let settings = subscribed_settings(state, &sources, &targets)?;
    Ok(skills::scan(&sources, &targets, &settings.subscriptions))
}

/// 读设置并认领订阅；凡是要读或改订阅记录的地方都先过这一步，第一次扫描的认领才不会被跳过
fn subscribed_settings(
    state: &AppState,
    sources: &[Source],
    targets: &[Target],
) -> Result<symsync_core::store::Settings, String> {
    state
        .store
        .load_settings_adopting_subscriptions(sources, targets)
        .map_err(err)
}

/// 所有仍生效的自动引入规则只保存位置身份；扫描时才把它们展开为当前缺失项。
/// `auto_selections` 只返回规则授权的跨域项，故自动执行不会借用手动预览的确认。
fn auto_import_mcp(
    state: &AppState,
    overview: &symsync_core::mcp::McpOverview,
    rules: &[symsync_core::mcp::McpAutoImportRule],
) -> Result<Option<symsync_core::mcp::McpReport>, String> {
    if rules.is_empty() {
        return Ok(None);
    }
    let selections = symsync_core::mcp::auto_selections(overview, rules);
    if selections.is_empty() {
        return Ok(None);
    }
    let discovery = discover_mcp(state)?;
    let plan = symsync_core::mcp::prepare(&discovery.locations, &selections);
    if plan.actions.is_empty() {
        return Ok(None);
    }
    // 自动选择已由规则逐条授予跨域权限；这里不接受未经过该筛选的手动选择。
    // Tauri 2 的同步命令内联跑在 IPC 线程上，这里 blocking_lock 不会 panic，
    // 但会占住那个线程：模型页正在写设置时，这条命令要等它放锁，界面在此期间不响应。
    // 所以模型页那边只把写文件包在锁里，不把联网和状态查询放进临界区。
    let _config_guard = state.config_lock.blocking_lock();
    let actions = plan.actions.clone();
    let mut report = symsync_core::mcp::execute(plan, true);
    register_mcp_undo(state, &mut report)?;
    // 来源管理页目标框的提示框写「最近一次自动操作」：真写进去了才记
    state
        .store
        .record_mcp_auto_import_runs(&actions, &report, now_ms())
        .map_err(err)?;
    Ok(Some(report))
}

/// 最多保留的撤销记录数；前端提示条同一时刻只有几条，多出的最旧记录直接丢
const MCP_UNDO_LIMIT: usize = 16;

/// 把这次写入的撤销记录登记进内存，id 写回报告。同一文件的旧记录一并作废。
fn register_mcp_undo(
    state: &AppState,
    report: &mut symsync_core::mcp::McpReport,
) -> Result<(), String> {
    let Some(undo) = report.take_undo() else {
        return Ok(());
    };
    let mut records = state
        .mcp_undo
        .lock()
        .map_err(|_| "MCP 撤销记录已损坏".to_string())?;
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
    report.undo_id = Some(id);
    Ok(())
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
    let settings = state.store.load_settings().map_err(err)?;
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
) -> Result<symsync_core::mcp::McpOverview, String> {
    let discovery = discover_mcp(&state)?;
    let mut overview = symsync_core::mcp::scan(&discovery.locations);
    overview.issues.extend(discovery.issues);
    let rules = state
        .store
        .load_settings_migrating_mcp_auto_imports(&overview)
        .map_err(err)?
        .mcp_auto_imports;
    if let Some(report) = auto_import_mcp(&state, &overview, &rules)? {
        let _ = app.emit("mcp-auto-imported", &report);
        let discovery = discover_mcp(&state)?;
        overview = symsync_core::mcp::scan(&discovery.locations);
        overview.issues.extend(discovery.issues);
    }
    // 老数据认领进订阅记录，再把各位置订阅着的来源填进结果：主视图把它们的全部服务列成行
    let settings = state
        .store
        .load_settings_adopting_mcp_subscriptions(&overview)
        .map_err(err)?;
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
) -> Result<symsync_core::mcp::McpDiff, String> {
    let discovery = discover_mcp(&state)?;
    Ok(symsync_core::mcp::diff_fields(
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
) -> Result<Option<symsync_core::mcp::McpEndpoint>, String> {
    let discovery = discover_mcp(&state)?;
    Ok(symsync_core::mcp::endpoint(
        &discovery.locations,
        &name,
        &location_id,
    ))
}

#[tauri::command]
fn propose_mcp_sync(
    selections: Vec<symsync_core::mcp::McpSelection>,
    state: tauri::State<'_, AppState>,
) -> Result<McpPreview, String> {
    let discovery = discover_mcp(&state)?;
    let plan = symsync_core::mcp::prepare(&discovery.locations, &selections);
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
        .map_err(|_| "MCP 计划缓存已损坏".to_string())? = Some((id, plan));
    Ok(preview)
}

#[tauri::command]
fn apply_mcp(
    plan_id: String,
    allow_cross_domain: bool,
    state: tauri::State<'_, AppState>,
) -> Result<symsync_core::mcp::McpReport, String> {
    let plan = {
        let mut cache = state
            .mcp_plan
            .lock()
            .map_err(|_| "MCP 计划缓存已损坏".to_string())?;
        let Some((cached_id, _)) = cache.as_ref() else {
            return Err("MCP 计划不存在或已过期，请重新预览".into());
        };
        if cached_id != &plan_id {
            return Err("MCP 计划不存在或已过期，请重新预览".into());
        }
        cache.take().expect("checked above").1
    };
    // Tauri 2 的同步命令内联跑在 IPC 线程上，这里 blocking_lock 不会 panic，
    // 但会占住那个线程：模型页正在写设置时，这条命令要等它放锁，界面在此期间不响应。
    // 所以模型页那边只把写文件包在锁里，不把联网和状态查询放进临界区。
    let _config_guard = state.config_lock.blocking_lock();
    let mut report = symsync_core::mcp::execute(plan, allow_cross_domain);
    register_mcp_undo(&state, &mut report)?;
    Ok(report)
}

/// 从格子上移除 MCP 副本（可批量）：每项是 (行的来源＝原件, 服务名, 副本所在位置)。
/// 判定与执行一次做完（格子是开关，没有预览这一步），拒绝的项以 `skipped` + 原因进报告；
/// 撤销与写入共用 `mcp_undo_write`。原件那一格 core 拒绝
#[tauri::command]
fn remove_mcp_copies(
    selections: Vec<symsync_core::mcp::McpSelection>,
    state: tauri::State<'_, AppState>,
) -> Result<symsync_core::mcp::McpReport, String> {
    let discovery = discover_mcp(&state)?;
    // 会写 ~/.codex/config.toml：与模型页、MCP 写入共用一把锁（同步命令，见 apply_mcp）
    let _config_guard = state.config_lock.blocking_lock();
    let plan = symsync_core::mcp::prepare_removal(&discovery.locations, &selections);
    let mut report = symsync_core::mcp::execute_removal(plan);
    register_mcp_undo(&state, &mut report)?;
    Ok(report)
}

/// 撤销一次 MCP 写入。记录用过即删；写后文件被改过时 core 整体拒绝，返回里带备份路径
#[tauri::command]
fn mcp_undo_write(
    undo_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<symsync_core::mcp::McpUndoReport, String> {
    let undo = {
        let mut records = state
            .mcp_undo
            .lock()
            .map_err(|_| "MCP 撤销记录已损坏".to_string())?;
        let index = records
            .iter()
            .position(|(id, _)| id == &undo_id)
            .ok_or("撤销记录不存在或已过期")?;
        records.remove(index).1
    };
    let _config_guard = state.config_lock.blocking_lock();
    Ok(symsync_core::mcp::undo_write(&undo))
}

/// 自动同步规则展开成建链动作并执行；无规则或没有缺口时返回 None
fn auto_link(state: &AppState, scanned: &Overview) -> Result<Option<SyncReport>, String> {
    let rules = state
        .store
        .load_settings_migrating_auto_links(&scanned.sources)
        .map_err(err)?
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
    let report = execute_grouped(scanned, &actions, false);
    // 来源管理页目标框的提示框写「最近一次自动操作」：真建上了才记，按规则、按位置
    state
        .store
        .record_auto_link_runs(&scanned.sources, &targets, &report, now_ms())
        .map_err(err)?;
    Ok(Some(report))
}

/// 扫描 → 跑一轮自动同步（只做一轮，不循环）→ 建过链就再扫一次 → 按最终目录集合重建监视
#[tauri::command]
fn scan_all(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Overview, String> {
    let mut overview = overview(&state)?;
    if let Some(report) = auto_link(&state, &overview)? {
        let _ = app.emit("auto-linked", &report);
        overview = self::overview(&state)?;
    }
    // Skills 页收到文件变更时同样会走这里。没有自动规则便不读取任何 MCP 配置；
    // 有规则时只执行一轮，结果不会改变 Skills 主扫描结果。
    let mcp_rules = state.store.load_settings().map_err(err)?.mcp_auto_imports;
    if !mcp_rules.is_empty() {
        let discovery = discover_mcp(&state)?;
        let mut mcp_overview = symsync_core::mcp::scan(&discovery.locations);
        mcp_overview.issues.extend(discovery.issues);
        let mcp_rules = state
            .store
            .load_settings_migrating_mcp_auto_imports(&mcp_overview)
            .map_err(err)?
            .mcp_auto_imports;
        if let Some(report) = auto_import_mcp(&state, &mcp_overview, &mcp_rules)? {
            let _ = app.emit("mcp-auto-imported", &report);
        }
    }
    // 本体位置、目标目录与自动引入配置父目录都要盯。
    resync_watchers(&app, &state, &overview);
    Ok(overview)
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
    Ok(skills::propose_unlinks(&sources, &targets, &cells))
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

/// 每条动作各自算写法，按写法分组交给 `sync::execute`，报告仍按传入顺序返回
fn execute_grouped(
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
        let report = sync::execute(&subset, clean_broken, style);
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
    Ok(execute_grouped(&overview, &actions, clean_broken))
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
        .ok_or("目标已不存在，请刷新")?;
    let source_id = target
        .linked_whole_to
        .as_deref()
        .ok_or("该目标不是整目录链接")?;
    let source = overview
        .sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or("整目录链接指向的本体位置已不存在，请刷新")?;
    Ok(skills::split_whole_link(target, source))
}

/// 删本体的计划：`plan` 给确认弹窗渲染，`plan_id` 给 `delete_source` 取回服务端那份
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedDeletion {
    plan_id: String,
    plan: DeleteSourcePlan,
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
        .ok_or("本体位置已不存在，请刷新")?
        .skills
        .iter()
        .find(|s| s.name == skill)
        .ok_or("该本体已不存在，请刷新")?;
    let plan = skills::plan_delete_source(skill, &sources, &targets);
    let plan_id = state
        .next_delete_plan
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    *state
        .delete_plan
        .lock()
        .map_err(|_| "删除计划缓存已损坏".to_string())? = Some((plan_id.clone(), plan.clone()));
    Ok(PlannedDeletion { plan_id, plan })
}

/// 执行服务端存着的那份删除计划。单独成命令，是为了把用户确认卡在两次调用之间；
/// 计划用后即弃，同一个 `plan_id` 不能重放
#[tauri::command]
fn delete_source(plan_id: String, state: tauri::State<'_, AppState>) -> Result<SyncReport, String> {
    let plan = {
        let mut cache = state
            .delete_plan
            .lock()
            .map_err(|_| "删除计划缓存已损坏".to_string())?;
        match cache.as_ref() {
            Some((cached_id, _)) if cached_id == &plan_id => cache.take().expect("刚判过是 Some").1,
            _ => return Err("删除计划不存在或已过期，请重新确认".into()),
        }
    };
    Ok(sync::delete_source(&plan))
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
    ))
}

/// 在这个位置订阅一个来源：路径来自候选，或来自用户选的文件夹。只记订阅，不建链
#[tauri::command]
fn subscribe_source(
    domain: String,
    path: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let (sources, targets) = discover(&state)?;
    let mut settings = subscribed_settings(&state, &sources, &targets)?;
    subscriptions::subscribe(
        &mut settings.subscriptions,
        &domain,
        &path,
        &sources,
        &targets,
    )?;
    state.store.save_settings(&settings).map_err(err)
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

/// 移除来源前的只读清单：会撤掉的软链（skill × agent），给确认框列出。
/// 原件在这个位置里的来源返回拒绝的原因
#[tauri::command]
fn plan_remove_source(
    domain: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<subscriptions::SourceRemoval, String> {
    let (sources, targets) = discover(&state)?;
    subscriptions::plan_remove(&domain, &source_id, &sources, &targets)
}

/// 从这个位置移除来源：撤掉它在这里的软链（删前重校验），再删订阅记录与规则里本位置的目标。
/// 执行时按当下的文件系统重新算清单，不沿用确认框那一份
#[tauri::command]
fn remove_source(
    domain: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let (sources, targets) = discover(&state)?;
    let mut settings = subscribed_settings(&state, &sources, &targets)?;
    let report = subscriptions::remove(
        &domain,
        &source_id,
        &sources,
        &targets,
        &mut settings.subscriptions,
        &mut settings.auto_links,
    )?;
    state.store.save_settings(&settings).map_err(err)?;
    Ok(report)
}

/// MCP 扫描一次，并读设置、认领订阅：来源管理页的命令都从这一步开始
fn mcp_scanned(
    state: &AppState,
) -> Result<
    (
        symsync_core::mcp::McpDiscovery,
        symsync_core::mcp::McpOverview,
        symsync_core::store::Settings,
    ),
    String,
> {
    let discovery = discover_mcp(state)?;
    let mut overview = symsync_core::mcp::scan(&discovery.locations);
    overview.issues.extend(discovery.issues.iter().cloned());
    let settings = state
        .store
        .load_settings_adopting_mcp_subscriptions(&overview)
        .map_err(err)?;
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
    let (_, overview, mut settings) = mcp_scanned(&state)?;
    mcp_sources::subscribe(
        &mut settings.mcp_subscriptions,
        &domain,
        &source_id,
        &overview,
    )?;
    state.store.save_settings(&settings).map_err(err)
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
) -> Result<symsync_core::mcp::McpReport, String> {
    let (discovery, _, mut settings) = mcp_scanned(&state)?;
    let report = {
        // 会写 ~/.codex/config.toml：与模型页、MCP 写入共用一把锁（同步命令，见 auto_import_mcp）
        let _config_guard = state.config_lock.blocking_lock();
        mcp_sources::remove(
            &domain,
            &source_id,
            &items,
            &discovery.locations,
            &mut settings.mcp_subscriptions,
            &mut settings.mcp_auto_imports,
        )?
    };
    state.store.save_settings(&settings).map_err(err)?;
    Ok(report)
}

#[tauri::command]
fn list_manual_sources(state: tauri::State<'_, AppState>) -> Result<Vec<PathBuf>, String> {
    Ok(state.store.load_settings().map_err(err)?.manual_sources)
}

#[tauri::command]
fn add_manual_source(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = normalize(&path);
    let mut settings = state.store.load_settings().map_err(err)?;
    if !settings.manual_sources.contains(&path) {
        settings.manual_sources.push(path);
    }
    state.store.save_settings(&settings).map_err(err)
}

#[tauri::command]
fn remove_manual_source(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = normalize(&path);
    let mut settings = state.store.load_settings().map_err(err)?;
    settings.manual_sources.retain(|p| normalize(p) != path);
    state.store.save_settings(&settings).map_err(err)
}

#[tauri::command]
fn list_auto_links(state: tauri::State<'_, AppState>) -> Result<Vec<AutoLink>, String> {
    Ok(state.store.load_settings().map_err(err)?.auto_links)
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
        return Err("目标域不能为空".into());
    }
    if target_ids.is_empty() {
        return Err("至少选择一个目标位置".into());
    }
    let discovery = discover_mcp(&state)?;
    let source = discovery
        .locations
        .iter()
        .find(|location| location.id == source_id)
        .ok_or("来源位置已不存在，请刷新")?;
    let mut seen = BTreeSet::new();
    let mut targets = Vec::with_capacity(target_ids.len());
    for target_id in target_ids {
        if !seen.insert(target_id.clone()) {
            return Err("目标位置不能重复".into());
        }
        let target = discovery
            .locations
            .iter()
            .find(|location| location.id == target_id)
            .ok_or("目标位置已不存在，请刷新")?;
        if target.domain != target_domain {
            return Err("所有目标位置必须属于所选目标域".into());
        }
        targets.push(symsync_core::mcp::location_ref(target));
    }
    if source.domain != target_domain && !allow_cross_domain {
        return Err("跨域自动引入需要明确允许".into());
    }
    let mut settings = state.store.load_settings().map_err(err)?;
    // 同一来源+目标域重新设置：目标集合整体替换；已生效的规则保留 baseline 与排除名单，
    // 不重拍。新建（或关掉后再开）才在 core 里按此刻来源的全部名字拍 baseline
    let overview = symsync_core::mcp::scan(&discovery.locations);
    symsync_core::mcp::upsert_auto_import(
        &mut settings.mcp_auto_imports,
        &overview,
        source,
        target_domain,
        targets,
        allow_cross_domain,
    )?;
    state.store.save_settings(&settings).map_err(err)
}

#[tauri::command]
fn remove_mcp_auto_import(
    source_id: String,
    target_domain: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut settings = state.store.load_settings().map_err(err)?;
    settings
        .mcp_auto_imports
        .retain(|rule| rule.source.id != source_id || rule.target_domain != target_domain);
    state.store.save_settings(&settings).map_err(err)
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
    let mut settings = state.store.load_settings().map_err(err)?;
    edit(&mut settings.auto_links);
    state.store.save_settings(&settings).map_err(err)
}

/// 全部 harness 及其启用、安装状态，外加显示上限。返回全部而不只是已安装的：
/// 设置页要列出「未安装的 N 个」，其中不显示名单里的给「恢复」入口
#[tauri::command]
fn list_harnesses(state: tauri::State<'_, AppState>) -> Result<HarnessList, String> {
    let env = runtime_env()?;
    let (installed, settings) = installed_and_settings(&state, &env)?;
    let installed: std::collections::HashSet<String> =
        installed.into_iter().map(|h| h.id).collect();
    let harnesses = discovery::all_harnesses(&env)
        .into_iter()
        .map(|h| HarnessStatus {
            enabled: !settings.disabled_harnesses.contains(&h.id),
            installed: installed.contains(&h.id),
            id: h.id,
            display_name: h.display_name,
        })
        .collect();
    Ok(HarnessList {
        max_shown: discovery::MAX_SHOWN,
        harnesses,
    })
}

/// 勾选 / 取消勾选；显示已满时勾第 5 个会被拒，错误信息就是给用户看的那句
#[tauri::command]
fn set_harness_enabled(
    id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let env = runtime_env()?;
    let (installed, mut settings) = installed_and_settings(&state, &env)?;
    let ids: Vec<String> = installed.into_iter().map(|h| h.id).collect();
    discovery::set_shown(&ids, &mut settings, &id, enabled).map_err(err)?;
    state.store.save_settings(&settings).map_err(err)
}

/// 仅手动添加的项目；自动发现的项目不在其中
#[tauri::command]
fn list_manual_projects(state: tauri::State<'_, AppState>) -> Result<Vec<PathBuf>, String> {
    // 历史文件里可能有未归一化的路径，返回前统一，前端才能和域 key 对上
    Ok(state
        .store
        .load_projects()
        .map_err(err)?
        .iter()
        .map(|p| normalize(p))
        .collect())
}

#[tauri::command]
fn add_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = normalize(&path);
    let mut list = state.store.load_projects().map_err(err)?;
    if !list.iter().any(|p| normalize(p) == path) {
        list.push(path.clone());
    }
    state.store.save_projects(&list).map_err(err)?;
    // 侧栏「最近创建」在取不到文件夹创建时间时用加入时间
    state.store.mark_project_added(&path, now_ms()).map_err(err)
}

/// 此刻的毫秒时间戳；时钟早于 1970 时记 0
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn remove_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = normalize(&path);
    let mut list = state.store.load_projects().map_err(err)?;
    list.retain(|p| normalize(p) != path);
    state.store.save_projects(&list).map_err(err)?;
    state.store.forget_project_added(&path).map_err(err)
}

/// 看过的新手提示 id（前端 `src/hints.ts` 登记）
#[tauri::command]
fn list_seen_hints(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    state.store.seen_hints().map_err(err)
}

/// 记下一条看过的新手提示（关掉或学会）；去重、空串忽略
#[tauri::command]
fn mark_hint_seen(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.store.mark_hint_seen(&id).map_err(err)
}

/// 侧栏排序用的项目时间（最近活跃 / 最近创建），按传入顺序返回。只读元数据，不写盘
#[tauri::command]
fn project_times(
    paths: Vec<PathBuf>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<symsync_core::activity::ProjectTimes>, String> {
    let env = runtime_env()?;
    let claude_projects = env
        .vars
        .get("CLAUDE_CONFIG_DIR")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| env.home.join(".claude"))
        .join("projects");
    let agent_dirs = symsync_core::activity::agent_dir_names(&discovery::all_harnesses(&env));
    let added = state.store.load_settings().map_err(err)?.project_added_at;
    Ok(paths
        .iter()
        .map(|p| {
            let at = added.get(normalize(p).to_string_lossy().as_ref()).copied();
            symsync_core::activity::project_times(p, &claude_projects, &agent_dirs, at)
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 托盘面板要做成不激活应用的 NSPanel（tray.rs），面板登记表由这个插件管
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    // 原生应用菜单（D15）：只在 macOS 上装，别的系统上菜单栏会画进窗口里
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::on_event);
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 应用内更新：查清单、下载、验签、装都在插件里，前端只负责问与决定。
        // 重启交给 process 插件——装完不重启，用户还在跑旧的那一份。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 右键「拷贝路径」：选中项在原生菜单关掉之后才执行，已不在网页的用户手势里，
        // WKWebView 的 navigator.clipboard 会拒绝（NotAllowedError）；走原生剪贴板
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            config_lock: Default::default(),
            gateway: gateway::build(runtime_store_dir().unwrap_or_else(|e| panic!("{e}"))),
            store: Store::new(runtime_store_dir().unwrap_or_else(|e| panic!("{e}"))),
            watcher: Mutex::new(None),
            mcp_plan: Mutex::new(None),
            next_mcp_plan: AtomicU64::new(1),
            mcp_undo: Mutex::new(Vec::new()),
            next_mcp_undo: AtomicU64::new(1),
            delete_plan: Mutex::new(None),
            next_delete_plan: AtomicU64::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            scan_all,
            scan_mcp,
            mcp_field_diff,
            mcp_endpoint,
            propose_mcp_sync,
            apply_mcp,
            remove_mcp_copies,
            mcp_undo_write,
            propose_links,
            propose_unlinks,
            apply_all,
            split_whole_link,
            plan_delete_source,
            delete_source,
            list_sources,
            subscribe_source,
            preview_source_folder,
            plan_remove_source,
            remove_source,
            list_mcp_sources,
            subscribe_mcp_source,
            plan_remove_mcp_source,
            remove_mcp_source,
            list_manual_sources,
            add_manual_source,
            remove_manual_source,
            list_manual_projects,
            add_project,
            remove_project,
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
            gateway::gateway_save_provider,
            gateway::gateway_upsert_provider,
            gateway::gateway_remove_provider,
            gateway::gateway_fetch_models,
            gateway::gateway_select_models,
            gateway::gateway_enable,
            gateway::gateway_restore,
            gateway::gateway_restart,
            gateway::gateway_restart_codex,
            gateway::gateway_launch_codex,
            gateway::gateway_takeover,
            tray::tray_open_main,
            tray::tray_set_height,
            tray::tray_hide,
            tray::tray_quit,
            menu::set_menu_state
        ])
        .setup(|_app| {
            // 菜单栏入口只在 macOS 上有：模型注入本身只支持 macOS
            #[cfg(target_os = "macos")]
            {
                tray::setup(_app)?;
                menu::after_setup(_app.handle());
                // 后台线程里预热：复制程序、让系统做完首次校验，启用时就不用等这几秒
                use tauri::Manager;
                if let Some(gateway) = _app.state::<AppState>().gateway.clone() {
                    std::thread::spawn(move || symsync_gateway::runtime::prewarm(&gateway));
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // 窗口藏起来之后点 Dock 图标：把它带回来
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main(_app);
            }
        });
}

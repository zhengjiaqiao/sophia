//! Tauri 命令层：每个命令一行调 core，错误统一转 String
mod watch;

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use symsync_core::discovery::{self, Env};
use symsync_core::fs::normalize;
use symsync_core::models::*;
use symsync_core::skills;
use symsync_core::store::Store;
use symsync_core::sync;
use tauri::Emitter;

struct AppState {
    store: Store,
    /// 当前的文件系统监视，随每次扫描的目录集合重建
    watcher: Mutex<Option<watch::Watcher>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessStatus {
    id: String,
    display_name: String,
    enabled: bool,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 一次发现：本体位置与目标目录，按当前设置解析。
/// 目标目录里指向已知位置之外的软链再合成出外部本体位置
fn discover(state: &AppState) -> Result<(Vec<Source>, Vec<Target>), String> {
    let env = Env::from_system();
    let settings = state.store.load_settings().map_err(err)?;
    let harnesses = discovery::enabled(discovery::installed(&env), &settings);
    let manual_projects = state.store.load_projects().map_err(err)?;
    let projects = discovery::project_candidates(&env, &manual_projects, &harnesses);
    let mut sources = discovery::sources(&env, &harnesses, &projects, &settings.manual_sources);
    let targets = discovery::targets(&env, &harnesses, &projects, &sources);
    let external = discovery::external_sources(&env, &targets, &sources);
    sources.extend(external);
    Ok((sources, targets))
}

/// 完整扫描：发现 → 按域扫描，只产出事实，不落盘
fn overview(state: &AppState) -> Result<Overview, String> {
    let (sources, targets) = discover(state)?;
    Ok(skills::scan(&sources, &targets))
}

/// 自动同步规则展开成建链动作并执行；无规则或没有缺口时返回 None
fn auto_link(state: &AppState, scanned: &Overview) -> Result<Option<SyncReport>, String> {
    let rules = state.store.load_settings().map_err(err)?.auto_links;
    if rules.is_empty() {
        return Ok(None);
    }
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
    Ok(Some(execute_grouped(scanned, &actions, false)))
}

/// 扫描 → 跑一轮自动同步（只做一轮，不循环）→ 建过链就再扫一次 → 按最终目录集合重建监视
#[tauri::command]
fn scan_all(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Overview, String> {
    let mut overview = overview(&state)?;
    if let Some(report) = auto_link(&state, &overview)? {
        let _ = app.emit("auto-linked", &report);
        overview = self::overview(&state)?;
    }
    // 本体位置与目标目录都要盯：删本体、手工建/删软链都会改到它们的直接子项
    let paths: BTreeSet<PathBuf> = overview
        .sources
        .iter()
        .map(|s| s.path.clone())
        .chain(
            overview
                .domains
                .iter()
                .flat_map(|d| &d.targets)
                .map(|t| t.path.clone()),
        )
        .collect();
    if let Ok(mut slot) = state.watcher.lock() {
        watch::resync(&mut slot, &app, paths);
    }
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

/// 新建或合并一条规则；解除排除由 `include_auto_link` 单独做
#[tauri::command]
fn set_auto_link(
    source: PathBuf,
    targets: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    update_auto_links(&state, |rules| {
        skills::upsert_auto_link(rules, &source, &targets)
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

#[tauri::command]
fn exclude_auto_link(
    source: PathBuf,
    skill: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    update_auto_links(&state, |rules| skills::exclude(rules, &source, &skill))
}

#[tauri::command]
fn include_auto_link(
    source: PathBuf,
    skill: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    update_auto_links(&state, |rules| skills::include(rules, &source, &skill))
}

fn update_auto_links(
    state: &AppState,
    edit: impl FnOnce(&mut Vec<AutoLink>),
) -> Result<(), String> {
    let mut settings = state.store.load_settings().map_err(err)?;
    edit(&mut settings.auto_links);
    state.store.save_settings(&settings).map_err(err)
}

/// 已安装的 harness 及其启用状态
#[tauri::command]
fn list_harnesses(state: tauri::State<'_, AppState>) -> Result<Vec<HarnessStatus>, String> {
    let settings = state.store.load_settings().map_err(err)?;
    Ok(discovery::installed(&Env::from_system())
        .into_iter()
        .map(|h| HarnessStatus {
            enabled: !settings.disabled_harnesses.contains(&h.id),
            id: h.id,
            display_name: h.display_name,
        })
        .collect())
}

#[tauri::command]
fn set_harness_enabled(
    id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut settings = state.store.load_settings().map_err(err)?;
    settings.disabled_harnesses.retain(|x| x != &id);
    if !enabled {
        settings.disabled_harnesses.push(id);
    }
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
        list.push(path);
    }
    state.store.save_projects(&list).map_err(err)
}

#[tauri::command]
fn remove_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = normalize(&path);
    let mut list = state.store.load_projects().map_err(err)?;
    list.retain(|p| normalize(p) != path);
    state.store.save_projects(&list).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            store: Store::new(Store::default_dir()),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            scan_all,
            propose_links,
            propose_unlinks,
            apply_all,
            split_whole_link,
            list_manual_sources,
            add_manual_source,
            remove_manual_source,
            list_manual_projects,
            add_project,
            remove_project,
            list_auto_links,
            set_auto_link,
            remove_auto_link,
            remove_auto_link_targets,
            exclude_auto_link,
            include_auto_link,
            list_harnesses,
            set_harness_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

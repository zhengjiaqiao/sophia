//! Tauri 命令层：每个命令一行调 core，错误统一转 String
use serde::Serialize;
use std::path::PathBuf;
use symsync_core::discovery::{self, Env};
use symsync_core::models::*;
use symsync_core::skills::{self, Matrix};
use symsync_core::store::Store;
use symsync_core::sync;

struct AppState {
    store: Store,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DomainInfo {
    domain: Domain,
    label: String,
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

#[tauri::command]
fn list_domains(state: tauri::State<'_, AppState>) -> Result<Vec<DomainInfo>, String> {
    let env = Env::from_system();
    let harnesses = discovery::all_harnesses(&env);
    let manual = state.store.load_projects().map_err(err)?;
    let mut out = vec![DomainInfo {
        domain: Domain::Global,
        label: "全局".into(),
    }];
    for p in discovery::project_candidates(&env, &manual, &harnesses) {
        let label = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.display().to_string());
        out.push(DomainInfo {
            domain: Domain::Project { path: p },
            label,
        });
    }
    Ok(out)
}

/// 已安装且未被用户关掉的 harness 上扫矩阵
fn scan_with(domain: &Domain, state: &AppState) -> Result<Matrix, String> {
    let env = Env::from_system();
    let settings = state.store.load_settings().map_err(err)?;
    let harnesses = discovery::enabled(discovery::installed(&env), &settings);
    Ok(skills::scan(domain, &harnesses, &env.home))
}

#[tauri::command]
fn scan_domain(domain: Domain, state: tauri::State<'_, AppState>) -> Result<Matrix, String> {
    scan_with(&domain, &state)
}

#[tauri::command]
fn propose(
    domain: Domain,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PlannedAction>, String> {
    Ok(skills::propose(&scan_with(&domain, &state)?))
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

#[tauri::command]
fn apply(
    actions: Vec<PlannedAction>,
    clean_broken: bool,
    domain: Domain,
) -> Result<SyncReport, String> {
    Ok(sync::execute(
        &actions,
        clean_broken,
        skills::link_style(&domain),
    ))
}

#[tauri::command]
fn add_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut list = state.store.load_projects().map_err(err)?;
    if !list.contains(&path) {
        list.push(path);
    }
    state.store.save_projects(&list).map_err(err)
}

#[tauri::command]
fn remove_project(path: PathBuf, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut list = state.store.load_projects().map_err(err)?;
    list.retain(|p| p != &path);
    state.store.save_projects(&list).map_err(err)
}

#[tauri::command]
fn list_rules(state: tauri::State<'_, AppState>) -> Result<Vec<SyncRule>, String> {
    state.store.load_rules().map_err(err)
}

#[tauri::command]
fn save_rules(rules: Vec<SyncRule>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.store.save_rules(&rules).map_err(err)
}

#[tauri::command]
fn plan_rule(rule: SyncRule) -> Result<Vec<PlannedAction>, String> {
    sync::plan(&rule).map_err(err)
}

#[tauri::command]
fn apply_rule(actions: Vec<PlannedAction>, clean_broken: bool) -> Result<SyncReport, String> {
    Ok(sync::execute(&actions, clean_broken, LinkStyle::Absolute))
}

/// 自定义同步的子项勾选列表：源目录直接子项，跳过点开头，排序
#[tauri::command]
fn list_source_items(source: PathBuf) -> Result<Vec<String>, String> {
    let rd = std::fs::read_dir(&source).map_err(err)?;
    let mut items: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    items.sort();
    Ok(items)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            store: Store::new(Store::default_dir()),
        })
        .invoke_handler(tauri::generate_handler![
            list_domains,
            scan_domain,
            propose,
            apply,
            add_project,
            remove_project,
            list_rules,
            save_rules,
            plan_rule,
            apply_rule,
            list_source_items,
            list_harnesses,
            set_harness_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

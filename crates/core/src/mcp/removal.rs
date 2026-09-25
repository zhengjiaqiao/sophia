//! 从一个 agent 的配置里删掉 MCP 定义（DESIGN「MCP 格子只有两种：⦿ 有、○ 没有」「删除原件」）。
//!
//! MCP 没有链接：每一处都是一份独立的定义，删哪一份都只是从那个位置的配置里拿掉一段，
//! 别的位置不受影响，所以不分原件副本，单格与批量都走 `prepare_original_removal`
//! （按位置 + 名字，不看它是不是哪一行的来源）。与写进同一套：它只读，逐项判定能不能删、
//! 记下此刻的快照；`execute_removal` 重校验快照没变，按文件分组，每个文件一次备份、一次
//! 原子写（`atomicfile`），留下与写入同一种撤销记录（`McpUndo`，撤销走 `undo_write`）。
//! 文件是文本级手术，复用来源移除的 `remove_json_server` / `remove_toml_server`：JSON 只切掉
//! 那一个成员，TOML 只删属于它的那几行，其余字节原样（BOM、CRLF、末行换行都不动），
//! 写前按语义核对「除了拿掉的这一项，其余一模一样」。单独拿不掉的写法（根上的内联
//! `mcp_servers = { … }`、跨行的内联定义）如实拒绝，不猜。
use super::sources::{remove_json_server, remove_toml_server};
use super::{
    backup, parse, record_undo, same_location, toml, McpIssue, McpLocation, McpReport,
    McpReportEntry, Parsed, State,
};
use crate::atomicfile::{self, unsafe_parent, FileState};
use crate::fs::normalize;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const CANNOT_CUT: &str = "这一项的写法无法安全地单独拿掉，没有改动";
const WEIBO_MESSAGE: &str = "WeiboAP 里的配置要到 WeiboAP 里删";

/// 要删的一项：从 `location_id` 这个位置的配置里删掉 `name`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRemoveItem {
    pub location_id: String,
    pub name: String,
}

/// 计划里的一项：删哪个位置（文件）里的哪一个
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRemoveAction {
    pub target_id: String,
    pub name: String,
    pub target_path: PathBuf,
}

/// 删除计划：`issues` 是这次不删的项与原因；私有部分带着体检时的快照，不出 core
#[derive(Debug)]
pub struct McpRemovalPlan {
    pub actions: Vec<McpRemoveAction>,
    pub issues: Vec<McpIssue>,
    private: Vec<PendingRemoval>,
}

#[derive(Debug, Clone)]
struct PendingRemoval {
    action: McpRemoveAction,
    selector: Option<String>,
    /// 体检时那个文件的快照；执行前必须没变
    target: State,
}

/// 同一个配置作用域：同一个文件里的同一个 MCP 容器
fn scope_key(location: &McpLocation) -> String {
    format!(
        "{}:{}",
        normalize(&location.path).display(),
        location.selector.as_deref().unwrap_or("root")
    )
}

/// 从这个作用域里切掉 `name`；拿不掉（或核对不过）返回 None
fn cut(path: &Path, selector: Option<&str>, bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    if toml(path) {
        remove_toml_server(bytes, name)
    } else {
        remove_json_server(bytes, selector, name)
    }
}

/// 这个位置里的 `name` 能不能单独切掉：读得出、还在、父目录不是软链、写法拿得掉
fn cuttable(target: &McpLocation, here: &Parsed, name: &str) -> Result<(), &'static str> {
    if here.issue.is_some() {
        return Err("目标配置无法解析或不安全");
    }
    let (State::Present(snap), true) = (&here.state, here.values.contains_key(name)) else {
        return Err("这里已经没有它了");
    };
    if unsafe_parent(&target.path) {
        return Err("目标父目录是软链接，已拒绝写入");
    }
    if cut(&target.path, target.selector.as_deref(), &snap.bytes, name).is_none() {
        return Err(CANNOT_CUT);
    }
    Ok(())
}

/// 只读：逐项判定能不能从那个位置删掉那一项（点 ⦿ 或选择行全有时按下、确认之后）。
/// 只删 `location_id` 那个位置里 `name` 的定义，别的位置里的同名定义不动；不需要来源可比。
/// 同一作用域的同名项选了几次只删一次。计划交给 `execute_removal` 执行，撤销走 `undo_write`
pub fn prepare_original_removal(
    locations: &[McpLocation],
    items: &[McpRemoveItem],
) -> McpRemovalPlan {
    let mut parsed: BTreeMap<String, Parsed> = BTreeMap::new();
    let mut issues = Vec::new();
    let mut seen = BTreeSet::new();
    let mut private = Vec::new();
    for item in items {
        let mut refuse = |message: &str| {
            issues.push(McpIssue {
                location_id: item.location_id.clone(),
                name: Some(item.name.clone()),
                message: message.into(),
            })
        };
        let Some(location) = locations.iter().find(|l| l.id == item.location_id) else {
            refuse("这个位置已经不在了");
            continue;
        };
        if location.harness_id == "weiboap" {
            refuse(WEIBO_MESSAGE);
            continue;
        }
        if !seen.insert((scope_key(location), item.name.clone())) {
            continue;
        }
        let here = parsed
            .entry(location.id.clone())
            .or_insert_with(|| parse(location))
            .clone();
        if let Err(message) = cuttable(location, &here, &item.name) {
            refuse(message);
            continue;
        }
        private.push(PendingRemoval {
            action: McpRemoveAction {
                target_id: location.id.clone(),
                name: item.name.clone(),
                target_path: location.path.clone(),
            },
            selector: location.selector.clone(),
            target: here.state,
        });
    }
    McpRemovalPlan {
        actions: private.iter().map(|p| p.action.clone()).collect(),
        issues,
        private,
    }
}

/// 执行删除。计划里拒绝的项以 `skipped` + 原因进报告（逐项），执行时出错的以 `failed` + 原因。
/// 删掉的条目 `outcome` 为 `removed`，带备份路径；撤销记录同写入（`take_undo`）
pub fn execute_removal(plan: McpRemovalPlan) -> McpReport {
    let mut report = McpReport::default();
    for issue in plan.issues {
        report.entries.push(McpReportEntry {
            name: issue.name.unwrap_or_default(),
            target_id: issue.location_id,
            outcome: "skipped".into(),
            message: issue.message,
            backup_path: None,
        });
    }
    // 同一个 .claude.json 里的 User / Local 必须一次备份、一次原子写
    let mut groups: BTreeMap<PathBuf, Vec<PendingRemoval>> = BTreeMap::new();
    for pending in plan.private {
        groups
            .entry(normalize(&pending.action.target_path))
            .or_default()
            .push(pending);
    }
    for group in groups.into_values() {
        execute_group(&group, &mut report);
    }
    report
}

fn entry(
    action: &McpRemoveAction,
    outcome: &str,
    message: &str,
    backup_path: Option<PathBuf>,
) -> McpReportEntry {
    McpReportEntry {
        name: action.name.clone(),
        target_id: action.target_id.clone(),
        outcome: outcome.into(),
        message: message.into(),
        backup_path,
    }
}

fn execute_group(group: &[PendingRemoval], report: &mut McpReport) {
    let fail = |report: &mut McpReport,
                items: &[&PendingRemoval],
                message: &str,
                backup: Option<PathBuf>| {
        for pending in items {
            report
                .entries
                .push(entry(&pending.action, "failed", message, backup.clone()));
        }
    };
    let all: Vec<&PendingRemoval> = group.iter().collect();
    let path = &group[0].action.target_path;
    if group
        .iter()
        .any(|pending| !same_location(path, &pending.target))
    {
        fail(report, &all, "配置在预览后发生变化", None);
        return;
    }
    let State::Present(snap) = &group[0].target else {
        fail(report, &all, "目标配置不可写", None);
        return;
    };
    let mut bytes = snap.bytes.clone();
    let mut removed: Vec<&PendingRemoval> = Vec::new();
    for pending in group {
        match cut(
            path,
            pending.selector.as_deref(),
            &bytes,
            &pending.action.name,
        ) {
            Some(next) => {
                bytes = next;
                removed.push(pending);
            }
            None => fail(report, &[pending], CANNOT_CUT, None),
        }
    }
    if removed.is_empty() {
        return;
    }
    let backup_path = match backup(path, snap) {
        Ok(backup_path) => backup_path,
        Err(_) => {
            fail(report, &removed, "备份失败，没动", None);
            return;
        }
    };
    if atomicfile::atomic_write(path, &bytes, &FileState::Present(snap.clone())).is_err() {
        fail(
            report,
            &removed,
            "写回失败（可能刚被别的程序改过），没动",
            Some(backup_path),
        );
        return;
    }
    record_undo(
        report,
        path,
        &group[0].target,
        Some(backup_path.clone()),
        &bytes,
    );
    for pending in removed {
        report.entries.push(entry(
            &pending.action,
            "removed",
            "已删除 MCP 定义",
            Some(backup_path.clone()),
        ));
    }
}

#[cfg(test)]
mod tests;

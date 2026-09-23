//! 从格子上移除一份 MCP 副本（DESIGN「MCP 格子同样是开关：能写进，也能移除」）。
//!
//! 与写进同一套：`prepare_removal` 只读，逐项判定能不能移除、记下两边此刻的快照；
//! `execute_removal` 重校验快照没变，按文件分组，每个文件一次备份、一次原子写（`atomicfile`），
//! 留下与写入同一种撤销记录（`McpUndo`，撤销走 `undo_write`）。
//!
//! 只有副本能移除：格子所在行的来源（`McpSelection.source_id`）那一处是原件，拒绝。
//! 文件是文本级手术，复用来源移除的 `remove_json_server` / `remove_toml_server`：JSON 只切掉
//! 那一个成员，TOML 只删属于它的那几行，其余字节原样（BOM、CRLF、末行换行都不动），
//! 写前按语义核对「除了拿掉的这一项，其余一模一样」。单独拿不掉的写法（根上的内联
//! `mcp_servers = { … }`、跨行的内联定义）如实拒绝，不猜。
use super::sources::{remove_json_server, remove_toml_server, same_copy};
use super::{
    backup, issue, parse, record_undo, same_location, toml, McpIssue, McpLocation, McpReport,
    McpReportEntry, McpSelection, Parsed, State,
};
use crate::atomicfile::{self, unsafe_parent, FileState};
use crate::fs::normalize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 点了原件格：来源自己那一处的定义是原件，不能在格子上移除
pub const ORIGINAL_MESSAGE: &str =
    "这是原件所在的位置，从这里移除等于删掉原件——到来源管理页移除这个来源";
const CANNOT_CUT: &str = "这一项的写法没法安全地单独拿掉，没动";

/// 要移除的一份副本
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRemoveAction {
    /// 原件所在的位置（格子所在行的来源）
    pub source_id: String,
    /// 副本所在的位置
    pub target_id: String,
    pub name: String,
    pub target_path: PathBuf,
    /// 副本与来源原版一致（见 `sources::same_copy`）：再点一次写回的就是同样的内容
    pub identical: bool,
}

/// 移除计划：`issues` 是这次不移除的项与原因；私有部分带着两边的快照，不出 core
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
    /// 判定「一不一样」用到的来源文件与当时的快照；执行前必须都没变
    sources: Vec<(PathBuf, State)>,
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

/// 只读：逐项判定能不能从这个位置移除这一份。同一作用域的同名服务选了几次只移除一次
pub fn prepare_removal(locations: &[McpLocation], selections: &[McpSelection]) -> McpRemovalPlan {
    let mut parsed: BTreeMap<String, Parsed> = BTreeMap::new();
    let mut read = |location: &McpLocation| {
        parsed
            .entry(location.id.clone())
            .or_insert_with(|| parse(location))
            .clone()
    };
    let find = |id: &str| locations.iter().find(|location| location.id == id);
    let mut issues = Vec::new();
    let mut chosen: BTreeMap<(String, String), PendingRemoval> = BTreeMap::new();
    for selection in selections {
        let mut refuse = |message: &str| issues.push(issue(selection, message));
        let (Some(source), Some(target)) = (find(&selection.source_id), find(&selection.target_id))
        else {
            refuse("来源或目标不存在");
            continue;
        };
        if scope_key(source) == scope_key(target) {
            refuse(ORIGINAL_MESSAGE);
            continue;
        }
        if target.harness_id == "weiboap" {
            refuse("WeiboAP 里的配置要到 WeiboAP 里删");
            continue;
        }
        let from = read(source);
        if from.issue.is_some() || !from.state.readable() {
            refuse("来源配置读不出来，分不清这一份是不是副本，没动");
            continue;
        }
        let Some(def) = from.values.get(&selection.name) else {
            refuse("来源里已经没有它了，分不清这一份是不是副本，没动");
            continue;
        };
        let here = read(target);
        if here.issue.is_some() {
            refuse("目标配置无法解析或不安全");
            continue;
        }
        let (State::Present(snap), Some(copy)) = (&here.state, here.values.get(&selection.name))
        else {
            refuse("这里已经没有它了");
            continue;
        };
        if unsafe_parent(&target.path) {
            refuse("目标父目录是软链接，已拒绝写入");
            continue;
        }
        if cut(
            &target.path,
            target.selector.as_deref(),
            &snap.bytes,
            &selection.name,
        )
        .is_none()
        {
            refuse(CANNOT_CUT);
            continue;
        }
        let identical = same_copy(source, def, target, copy);
        let key = (scope_key(target), selection.name.clone());
        if let Some(pending) = chosen.get_mut(&key) {
            // 同一份副本从几个来源点了几次：与每一份原版都一样才算一样
            pending.action.identical &= identical;
            pending
                .sources
                .push((source.path.clone(), from.state.clone()));
            continue;
        }
        chosen.insert(
            key,
            PendingRemoval {
                action: McpRemoveAction {
                    source_id: source.id.clone(),
                    target_id: target.id.clone(),
                    name: selection.name.clone(),
                    target_path: target.path.clone(),
                    identical,
                },
                selector: target.selector.clone(),
                sources: vec![(source.path.clone(), from.state.clone())],
                target: here.state.clone(),
            },
        );
    }
    let private: Vec<PendingRemoval> = chosen.into_values().collect();
    McpRemovalPlan {
        actions: private.iter().map(|p| p.action.clone()).collect(),
        issues,
        private,
    }
}

/// 执行移除。计划里拒绝的项以 `skipped` + 原因进报告（逐项），执行时出错的以 `failed` + 原因。
/// 移除成功的条目 `outcome` 为 `removed`，带备份路径与 `identical`；撤销记录同写入（`take_undo`）
pub fn execute_removal(plan: McpRemovalPlan) -> McpReport {
    let mut report = McpReport::default();
    for issue in plan.issues {
        report.entries.push(McpReportEntry {
            name: issue.name.unwrap_or_default(),
            target_id: issue.location_id,
            outcome: "skipped".into(),
            message: issue.message,
            backup_path: None,
            identical: None,
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
    identical: Option<bool>,
) -> McpReportEntry {
    McpReportEntry {
        name: action.name.clone(),
        target_id: action.target_id.clone(),
        outcome: outcome.into(),
        message: message.into(),
        backup_path,
        identical,
    }
}

fn execute_group(group: &[PendingRemoval], report: &mut McpReport) {
    let fail = |report: &mut McpReport,
                items: &[&PendingRemoval],
                message: &str,
                backup: Option<PathBuf>| {
        for pending in items {
            report.entries.push(entry(
                &pending.action,
                "failed",
                message,
                backup.clone(),
                None,
            ));
        }
    };
    let all: Vec<&PendingRemoval> = group.iter().collect();
    let path = &group[0].action.target_path;
    if group.iter().any(|pending| {
        !same_location(path, &pending.target)
            || pending
                .sources
                .iter()
                .any(|(source, state)| !same_location(source, state))
    }) {
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
            "已移除 MCP 定义",
            Some(backup_path.clone()),
            Some(pending.action.identical),
        ));
    }
}

#[cfg(test)]
mod tests;

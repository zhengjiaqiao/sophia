//! 「保留这份」（spec 2026-10-05-skill-mcp-batch2「MCP 页（S4）」，issue #114）：同名服务在几处定义不一样时，
//! 以选中那一处的定义为准，改写其余几处的同名服务。
//!
//! - 只换**定义**（传输、命令、参数、环境变量、地址、请求头、用命令生成请求头）；各 agent 专属写法里与定义
//!   无关的字段（Codex 的 `startup_timeout_sec`、Gemini 的 `trust`、Copilot 的 `tools`……）留目标自己的。
//!   选中那份自己那一家的专属字段不带过去。跨家写不过去的（变量引用、SSE、用命令生成请求头……）与写进
//!   同一套规则（`Canonical::refusal_for`）
//! - 文本级手术：JSON 原位换掉那一项的值（`jsonedit::replace`，键、位置、前后空白不动）；TOML 只删属于它的
//!   那几行再在末尾追加（`remove_toml_server` + `merge_toml`）。每一步都按语义核对，读回来与要写的一致
//! - **要么全改，要么一处都不动**：计划里有一处接不住就整次不写；执行时先逐个核对快照、算好新内容、备份，
//!   再把每个文件的新内容都写好临时文件（`atomicfile::stage`：磁盘满、没权限在换掉任何一个之前暴露），
//!   最后逐个 rename 换上去；换到一半被别人改了，把已经换上去的按撤销记录退回（`undo_write`），报出是哪一处，
//!   没能退回的如实记失败并带备份
//! - 写成的与写入共用一种撤销记录（`McpUndo`）：一次撤销全部退回，文件逐字节还原
//! - 镜像文件（Claude Desktop 第三方模式那一份）里有同名项的一起改；改不了的照写入的规矩并进主条目
//! - 密钥提醒（issue #147，同 #113 的一套判断）：来源是选中那一份所在的文件，目标是要改写的其他几处里的项目文件
//!   （`keep_key_hints` 给确认框，`execute_keep_minding_keys` 执行）；追加 `.gitignore` 进这次改写的同一条撤销
use super::keyhints::{hint_for, ignore_written, merge, Probes};
use super::sources::{plain_item, plain_table, remove_toml_server};
use super::{
    agents, backup, backup_failed, canon_by, canon_toml, fold_mirrors, json_server_for, merge_toml,
    parse, patch, patch_file, record_undo, refused, same_file, same_location, toml, toml_server,
    undo_write, write_failed, Canonical, McpIssue, McpKeyHint, McpLocation, McpReport,
    McpReportEntry, McpUndo, McpUndoFileResult, Refused, State,
};
use crate::atomicfile::{self, unsafe_parent, FileState, Snapshot};
use crate::fs::normalize;
use crate::jsonedit::{self, NoDuplicates};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

/// 计划里的一处：把 `target_id` 那个位置里的 `name` 改成选中的那份
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpKeepAction {
    pub target_id: String,
    pub name: String,
    pub target_path: PathBuf,
}

/// 「保留这份」的计划。`issues` 非空时整次不动（`execute_keep` 一个文件都不写）；
/// 私有部分带着体检时的快照与要写的定义（含凭据），不出 core
#[derive(Debug)]
pub struct McpKeepPlan {
    /// 要改写的几处（不含选中的那一处、已经一样的）
    pub actions: Vec<McpKeepAction>,
    /// 接不住选中那份的位置与原因
    pub issues: Vec<McpIssue>,
    private: Vec<PendingKeep>,
    /// 计划时就知道改不了的镜像文件，执行成功后并进主条目
    mirror_failures: Vec<McpReportEntry>,
    /// 选中那一处：位置 id、文件与体检时的快照。执行前它也必须没变——变了，照旧的定义去改别处就和它对不上了
    kept: Option<(String, PathBuf, State)>,
}

#[derive(Debug, Clone)]
struct PendingKeep {
    action: McpKeepAction,
    /// 写的那个作用域（镜像时 `path` 换成镜像文件）
    location: McpLocation,
    /// 体检时那个文件的快照；执行前必须没变
    target: State,
    definition: Canonical,
    mirror: bool,
}

fn issue(location_id: &str, name: &str, message: String) -> McpIssue {
    McpIssue {
        location_id: location_id.to_owned(),
        name: Some(name.to_owned()),
        message,
    }
}

fn entry(action: &McpKeepAction, outcome: &str, message: &str) -> McpReportEntry {
    McpReportEntry {
        name: action.name.clone(),
        target_id: action.target_id.clone(),
        outcome: outcome.into(),
        message: message.into(),
        backup_path: None,
        mirror_failed: None,
        note: None,
        detail: None,
    }
}

fn cannot_rewrite() -> String {
    crate::t!("mcp.keep.cannotRewrite")
}

/// 改写没过核对时给用户的一句：带原因的说原因，否则笼统一句
fn reason_of(error: &io::Error) -> String {
    match error.get_ref().and_then(|e| e.downcast_ref::<Refused>()) {
        Some(reason) => reason.to_string(),
        None => crate::t!("mcp.report.unsafeWriteBack"),
    }
}

/// 专属字段里其实属于定义的几个（Gemini 的 `cwd` 在哪个目录跑命令、`oauth` 怎么认证）：跟着选中的那份走，
/// 不留目标的；别家接不住它们时整次拒绝（同写入的规则），不悄悄丢掉
const DEFINITION_FIELDS: [&str; 2] = ["cwd", "oauth"];

/// 选中那份的专属字段里属于定义的那几个
fn definition_fields(kept: &Canonical) -> BTreeMap<String, String> {
    kept.client_fields
        .iter()
        .filter(|(key, _)| DEFINITION_FIELDS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// 要写进目标的定义：选中那份的连接字段（含属于定义的专属字段）+ 目标那一处原有的、与定义无关的专属字段
fn definition_for(kept: &Canonical, old: &Canonical) -> Canonical {
    let mut client_fields: BTreeMap<String, String> = old
        .client_fields
        .iter()
        .filter(|(key, _)| !DEFINITION_FIELDS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    client_fields.extend(definition_fields(kept));
    Canonical {
        client_fields,
        raw: None,
        reason: None,
        unsupported: false,
        unknown_field: None,
        ..kept.clone()
    }
}

/// 从根出发的 JSON Pointer（项目路径里的 `/` 要转义）
fn pointer(path: &[&str]) -> String {
    path.iter()
        .map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1")))
        .collect()
}

/// 把 `location` 这个作用域里的 `name` 整段换成 `def`；写法改不了、核对不过返回错误（`Refused` 带原因）
fn rewrite(
    location: &McpLocation,
    bytes: &[u8],
    name: &str,
    def: &Canonical,
) -> io::Result<Vec<u8>> {
    if toml(&location.path) {
        // 先只删属于它的那几行（核对「与原文件去掉这一项一模一样」），再在末尾追加（核对新项读回来一致）；
        // 写在内联表里的（`mcp_servers = { docs = { … } }`、跨行的内联定义）删不掉单行，就地换掉那一段内联值
        return match remove_toml_server(bytes, name) {
            Some(cut) => merge_toml(Some(&cut), &[(name, def)]),
            None => replace_toml_inline(bytes, name, def),
        };
    }
    if patch_file(&location.path) {
        // 只换得了 Sophia 自己的那一行：删掉它再在末尾追加（两步各自核对）；用户自己写的那项换不了
        let cut = patch::remove(bytes, name).ok_or_else(|| refused(cannot_rewrite()))?;
        return patch::merge(Some(&cut), &[(name, def)]);
    }
    serde_json::from_slice::<NoDuplicates>(bytes).map_err(|_| refused(cannot_rewrite()))?;
    let dialect = agents::dialect_of(location);
    let server = json_server_for(def, dialect)?;
    let path: Vec<&str> = match location.selector.as_deref() {
        Some(project) => vec!["projects", project, "mcpServers", name],
        None => vec!["mcpServers", name],
    };
    // 原位换值：键、位置、前后空白不动；jsonedit 自己核对「除了这一项其余一模一样」
    let out = jsonedit::replace(bytes, &path, &server).map_err(|_| refused(cannot_rewrite()))?;
    let mismatch = || refused(crate::t!("mcp.write.afterMismatch"));
    let value: Value = serde_json::from_slice(&out).map_err(|_| mismatch())?;
    let written = value
        .pointer(&pointer(&path))
        .map(|server| canon_by(server, dialect))
        .ok_or_else(mismatch)?;
    if written.unsupported
        || !written.connection_eq(def)
        || written.client_fields != def.client_fields
    {
        return Err(mismatch());
    }
    Ok(out)
}

/// TOML 里写成内联值的那一项：只把它的值那一段换成要写的内联表，其余字节原样；
/// 核对「新文件 = 原文件把这一项换成要写的」，新项按 Codex 的写法读回来与要写的一致
fn replace_toml_inline(bytes: &[u8], name: &str, def: &Canonical) -> io::Result<Vec<u8>> {
    let text = std::str::from_utf8(bytes).map_err(|_| refused(cannot_rewrite()))?;
    let doc = toml_edit::Document::parse(text).map_err(|_| refused(cannot_rewrite()))?;
    let span = doc
        .get("mcp_servers")
        .and_then(toml_edit::Item::as_table_like)
        .and_then(|servers| servers.get(name))
        .and_then(toml_edit::Item::as_inline_table)
        .and_then(toml_edit::InlineTable::span)
        .filter(|span| {
            text.get(span.clone())
                .is_some_and(|raw| raw.starts_with('{') && raw.ends_with('}'))
        })
        .ok_or_else(|| refused(cannot_rewrite()))?;
    let server = toml_server(def)?;
    let out = format!("{}{server}{}", &text[..span.start], &text[span.end..]);
    let mismatch = || refused(crate::t!("mcp.write.afterMismatch"));
    let old = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| mismatch())?;
    let new = out
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| mismatch())?;
    let mut expected = plain_table(old.as_table());
    let Some(Value::Object(servers)) = expected.get_mut("mcp_servers") else {
        return Err(mismatch());
    };
    servers.insert(
        name.to_owned(),
        plain_item(&toml_edit::Item::Value(server.into())),
    );
    let written = canon_toml(&new["mcp_servers"][name]);
    if plain_table(new.as_table()) != expected || written.unsupported || !written.connection_eq(def)
    {
        return Err(mismatch());
    }
    Ok(out.into_bytes())
}

/// 选中那份（来自 `kept_location`）能不能写进 `location` 这一处；已经一样的为 `Ok(None)`
fn pending_for(
    kept_location: &McpLocation,
    kept: &Canonical,
    location: &McpLocation,
    name: &str,
    mirror: bool,
) -> Result<Option<PendingKeep>, String> {
    if location.harness_id == "weiboap" {
        return Err(crate::t!("mcp.keep.weibo", agent = "WeiboAP"));
    }
    let here = parse(location);
    if here.issue.is_some() {
        return Err(crate::t!("mcp.reason.targetUnreadable"));
    }
    let (State::Present(snap), Some(old)) = (&here.state, here.values.get(name)) else {
        return Err(crate::t!("mcp.source.alreadyGone"));
    };
    // 目标带着 Sophia 不认得的字段：整段换掉会把它们丢了
    if old.unsupported {
        return Err(old
            .reason
            .clone()
            .unwrap_or_else(|| crate::t!("mcp.issue.targetCannotCompare")));
    }
    // 已经一样：连接字段与属于定义的专属字段（`cwd`、`oauth`）都一样
    if old.connection_eq(kept) && definition_fields(old) == definition_fields(kept) {
        return Ok(None);
    }
    if unsafe_parent(&location.path) {
        return Err(crate::t!("mcp.issue.parentSymlink"));
    }
    // 跨家写不过去的照写入的规则拒绝；选中那份与定义无关的专属字段本来就不带，不拿它们判，
    // 属于定义的（`cwd`、`oauth`）要判：别家接不住就整次不改
    let mut probe = definition_for(kept, old);
    probe.client_fields = definition_fields(kept);
    if let Some(reason) = probe.refusal_for(kept_location, location) {
        return Err(reason);
    }
    let definition = definition_for(kept, old);
    rewrite(location, &snap.bytes, name, &definition).map_err(|error| reason_of(&error))?;
    Ok(Some(PendingKeep {
        action: McpKeepAction {
            target_id: location.id.clone(),
            name: name.to_owned(),
            target_path: location.path.clone(),
        },
        location: location.clone(),
        target: here.state.clone(),
        definition,
        mirror,
    }))
}

/// 这几处同名服务此刻的定义的指纹（差异表给前端，确认后带回来）：用户看过之后谁被改了，指纹就不一样。
/// 只看定义本身，不看文件的其余部分（`~/.claude.json` 随时在变）；只出一个摘要，不出任何值
pub fn keep_revision(locations: &[McpLocation], name: &str, location_ids: &[String]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for id in location_ids {
        id.hash(&mut hasher);
        let def = locations
            .iter()
            .find(|location| &location.id == id)
            .map(parse)
            .and_then(|parsed| parsed.values.get(name).cloned());
        match def {
            Some(def) => (
                &def.transport,
                &def.command,
                &def.args,
                &def.env,
                &def.url,
                &def.headers,
                &def.headers_helper,
                &def.client_fields,
                def.unsupported,
            )
                .hash(&mut hasher),
            None => 0u8.hash(&mut hasher),
        }
    }
    format!("{:016x}", hasher.finish())
}

/// 同 `prepare_keep`，另核对这几处的定义还是用户在差异表里看到的那样（`revision` 来自 `McpDiff::revision`）；
/// 不一样了整次不动，让用户再看一眼
pub fn prepare_keep_seen(
    locations: &[McpLocation],
    name: &str,
    keep_id: &str,
    location_ids: &[String],
    revision: &str,
) -> McpKeepPlan {
    let mut plan = prepare_keep(locations, name, keep_id, location_ids);
    if keep_revision(locations, name, location_ids) != revision {
        plan.issues.insert(
            0,
            issue(keep_id, name, crate::t!("mcp.keep.changedSinceShown")),
        );
    }
    plan
}

/// 只读：以 `keep_id` 那一处的 `name` 为准，`location_ids` 里其余几处要怎么改（选中的那一处在不在里面都行）。
/// 已经一样的不改；有一处接不住记进 `issues`，执行时整次不动。计划交给 `execute_keep`，撤销走 `undo_write`
pub fn prepare_keep(
    locations: &[McpLocation],
    name: &str,
    keep_id: &str,
    location_ids: &[String],
) -> McpKeepPlan {
    let mut plan = McpKeepPlan {
        actions: Vec::new(),
        issues: Vec::new(),
        private: Vec::new(),
        mirror_failures: Vec::new(),
        kept: None,
    };
    let find = |id: &str| locations.iter().find(|location| location.id == id);
    let Some(kept_location) = find(keep_id) else {
        plan.issues
            .push(issue(keep_id, name, crate::t!("mcp.source.locationGone")));
        return plan;
    };
    let kept_parsed = parse(kept_location);
    plan.kept = Some((
        keep_id.to_owned(),
        kept_location.path.clone(),
        kept_parsed.state.clone(),
    ));
    let kept = match kept_parsed.values.get(name) {
        Some(def) if !def.unsupported => def.clone(),
        Some(_) => {
            plan.issues
                .push(issue(keep_id, name, crate::t!("mcp.keep.keptUnreadable")));
            return plan;
        }
        None => {
            plan.issues
                .push(issue(keep_id, name, crate::t!("mcp.source.alreadyGone")));
            return plan;
        }
    };
    let mut seen = BTreeSet::new();
    for id in location_ids {
        if id == keep_id || !seen.insert(id.as_str()) {
            continue;
        }
        let Some(location) = find(id) else {
            plan.issues
                .push(issue(id, name, crate::t!("mcp.source.locationGone")));
            continue;
        };
        let pending = match pending_for(kept_location, &kept, location, name, false) {
            Ok(Some(pending)) => pending,
            Ok(None) => continue,
            Err(message) => {
                plan.issues.push(issue(id, name, message));
                continue;
            }
        };
        // 镜像文件里有同名项的一起改；本来就没有的、已经一样的不动；改不了的记下，成功后并进主条目
        for mirror_path in &location.mirrors {
            if same_file(&location.path, mirror_path) {
                continue;
            }
            let mut mirror = location.clone();
            mirror.path = mirror_path.clone();
            mirror.mirrors = Vec::new();
            let there = parse(&mirror);
            if there.issue.is_none() && !there.values.contains_key(name) {
                continue;
            }
            match pending_for(kept_location, &kept, &mirror, name, true) {
                Ok(Some(pending)) => plan.private.push(pending),
                Ok(None) => {}
                Err(message) => {
                    plan.mirror_failures
                        .push(entry(&pending.action, "failed", &message))
                }
            }
        }
        plan.private.push(pending);
    }
    plan.actions = plan
        .private
        .iter()
        .filter(|pending| !pending.mirror)
        .map(|pending| pending.action.clone())
        .collect();
    plan
}

/// 一个文件要写的：快照、新内容、写前的备份
struct FileWrite {
    path: PathBuf,
    snap: Snapshot,
    bytes: Vec<u8>,
    backup: Option<PathBuf>,
}

/// 整次没做成时的报告：`failed_at` 那个文件上的几处记 `failed` + 原因（落在镜像文件上的记在它的主位置上），
/// 其余几处由 `others(第几个文件, 那一处)` 给（一般是 `skipped` + 没动）
/// `detail`：没成的那一处分不出原因时的系统原文（`message` 是兜底句），前端提示条据此只写失败句
fn abort(
    groups: &[Vec<PendingKeep>],
    failed_at: usize,
    message: &str,
    detail: Option<String>,
    others: &dyn Fn(usize, &McpKeepAction) -> McpReportEntry,
) -> McpReport {
    let mut report = McpReport::default();
    let mut failed = BTreeSet::new();
    for pending in &groups[failed_at] {
        if failed.insert(pending.action.target_id.clone()) {
            let mut one = entry(&pending.action, "failed", message);
            one.detail = detail.clone();
            report.entries.push(one);
        }
    }
    for (index, group) in groups.iter().enumerate() {
        for pending in group
            .iter()
            .filter(|pending| !pending.mirror && !failed.contains(&pending.action.target_id))
        {
            report.entries.push(others(index, &pending.action));
        }
    }
    report
}

/// 执行「保留这份」。全部写成时每处一条 `updated`（带备份路径），撤销记录同写入（`take_undo`）；
/// 计划里有接不住的、或执行中任何一处没成时一个文件都不留改动：没成的那一处 `failed` + 原因，其余 `skipped`
pub fn execute_keep(plan: McpKeepPlan, backups: &Path) -> McpReport {
    let mut report = McpReport::default();
    if !plan.issues.is_empty() {
        for issue in plan.issues {
            report.entries.push(McpReportEntry {
                name: issue.name.unwrap_or_default(),
                target_id: issue.location_id,
                outcome: "failed".into(),
                message: issue.message,
                backup_path: None,
                mirror_failed: None,
                note: None,
                detail: None,
            });
        }
        for action in plan.actions {
            report
                .entries
                .push(entry(&action, "skipped", &crate::t!("mcp.keep.untouched")));
        }
        return report;
    }
    // 选中的那一份在体检之后被改过：一处都不动
    if let Some((keep_id, path, state)) = &plan.kept {
        if !plan.private.is_empty() && !same_location(path, state) {
            report.entries.push(McpReportEntry {
                name: plan
                    .actions
                    .first()
                    .map(|a| a.name.clone())
                    .unwrap_or_default(),
                target_id: keep_id.clone(),
                outcome: "failed".into(),
                message: crate::t!("mcp.report.changedAfterPreview"),
                backup_path: None,
                mirror_failed: None,
                note: None,
                detail: None,
            });
            for action in &plan.actions {
                report
                    .entries
                    .push(entry(action, "skipped", &crate::t!("mcp.keep.untouched")));
            }
            return report;
        }
    }
    // 同一个文件里的几处（~/.claude.json 的根与项目）一次备份、一次原子写
    let mut by_file: BTreeMap<PathBuf, Vec<PendingKeep>> = BTreeMap::new();
    for pending in plan.private {
        by_file
            .entry(normalize(&pending.location.path))
            .or_default()
            .push(pending);
    }
    let groups: Vec<Vec<PendingKeep>> = by_file.into_values().collect();
    let untouched = |_: usize, action: &McpKeepAction| {
        entry(action, "skipped", &crate::t!("mcp.keep.untouched"))
    };

    // 1. 逐个文件核对快照没变，算好新内容：哪一处不成，一个文件都还没碰
    let mut files: Vec<FileWrite> = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        let path = group[0].location.path.clone();
        if group
            .iter()
            .any(|pending| !same_location(&path, &pending.target))
        {
            let message = crate::t!("mcp.report.changedAfterPreview");
            return abort(&groups, index, &message, None, &untouched);
        }
        let State::Present(snap) = &group[0].target else {
            let message = crate::t!("mcp.report.targetNotWritable");
            return abort(&groups, index, &message, None, &untouched);
        };
        let mut bytes = snap.bytes.clone();
        for pending in group {
            match rewrite(
                &pending.location,
                &bytes,
                &pending.action.name,
                &pending.definition,
            ) {
                Ok(next) => bytes = next,
                Err(error) => return abort(&groups, index, &reason_of(&error), None, &untouched),
            }
        }
        files.push(FileWrite {
            path,
            snap: snap.clone(),
            bytes,
            backup: None,
        });
    }

    // 2. 先全部备份：备份不成也是一个文件都没碰
    for (index, file) in files.iter_mut().enumerate() {
        match backup(&file.path, &file.snap, backups) {
            Ok(path) => file.backup = Some(path),
            Err(error) => {
                let (message, detail) = backup_failed(&file.path, &error, || {
                    crate::t!("mcp.report.backupFailedUntouched")
                });
                return abort(&groups, index, &message, detail, &untouched);
            }
        }
    }

    // 3. 先把每个文件的新内容都写好临时文件（占磁盘的一步）：磁盘满、没权限在换掉任何一个之前暴露，
    //    没成的这一次一个文件都没换，临时文件随之删掉
    let mut staged = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        match atomicfile::stage(
            &file.path,
            &file.bytes,
            &FileState::Present(file.snap.clone()),
        ) {
            Ok(one) => staged.push(one),
            Err(error) => {
                let (message, detail) = write_failed(&file.path, &error, || {
                    crate::t!("mcp.report.writeBackFailedUntouched")
                });
                return abort(&groups, index, &message, detail, &untouched);
            }
        }
    }

    // 4. 逐个换上去（只剩 rename）；一处没成（期间被别人改了），把已经换上去的按撤销记录退回
    let mut done = McpReport::default();
    for (index, (file, one)) in files.iter().zip(staged).enumerate() {
        if let Err(error) = one.commit() {
            let (message, detail) = write_failed(&file.path, &error, || {
                crate::t!("mcp.report.writeBackFailedUntouched")
            });
            // 逐个文件退回：一份在这期间被别人改了退不回，不拦着别的几份退回
            let rolled: Vec<McpUndoFileResult> = done
                .undo
                .files
                .iter()
                .flat_map(|file| {
                    undo_write(&McpUndo {
                        files: vec![file.clone()],
                        blocked: false,
                        key_guards: Vec::new(),
                    })
                    .files
                })
                .collect();
            // 已经写成的那几个：退回了的 `skipped`；没能退回的如实记 `failed`，带上备份，用户才知道它改了、去哪找原样
            let others = |at: usize, action: &McpKeepAction| {
                if at >= index {
                    return entry(action, "skipped", &crate::t!("mcp.keep.untouched"));
                }
                let result = rolled
                    .iter()
                    .find(|result| normalize(&result.target_path) == normalize(&files[at].path));
                match result {
                    Some(result) if matches!(result.outcome.as_str(), "restored" | "removed") => {
                        entry(action, "skipped", &crate::t!("mcp.keep.rolledBack"))
                    }
                    _ => {
                        // 退不回的原因分得出才接在后面；分不出的原文给 `detail`（提示条只写失败句）
                        let why = result.filter(|result| result.detail.is_none());
                        let mut failed = entry(
                            action,
                            "failed",
                            &why.map_or_else(
                                || crate::t!("mcp.keep.rollbackFailedPlain"),
                                |result| {
                                    crate::t!("mcp.keep.rollbackFailed", message = result.message)
                                },
                            ),
                        );
                        failed.detail = result.and_then(|result| result.detail.clone());
                        failed.backup_path = files[at].backup.clone();
                        failed
                    }
                }
            };
            return abort(&groups, index, &message, detail, &others);
        }
        record_undo(
            &mut done,
            &file.path,
            &State::Present(file.snap.clone()),
            file.backup.clone(),
            &file.bytes,
        );
    }
    for (group, file) in groups.iter().zip(&files) {
        for pending in group.iter().filter(|pending| !pending.mirror) {
            let mut updated = entry(&pending.action, "updated", &crate::t!("mcp.keep.updated"));
            updated.backup_path = file.backup.clone();
            report.entries.push(updated);
        }
    }
    report.undo = done.undo;
    fold_mirrors(
        &mut report,
        McpReport {
            entries: plan.mirror_failures,
            ..McpReport::default()
        },
    );
    report
}

/// 密钥提醒（issue #147）：计划里要改写的每个项目文件一条（按位置 id，先后照计划），确认框据此出不出
/// 「同时加进 .gitignore」、已被跟踪的那一句。来源是选中那一份所在的文件；镜像文件、用户级、Claude Code 仅自己的不给。只读
pub fn keep_key_hints(plan: &McpKeepPlan) -> Vec<McpKeyHint> {
    keep_hints(plan, &mut Probes::default())
        .into_iter()
        .map(|(_, hint)| hint)
        .collect()
}

/// 每个要改写的项目文件与它的提醒（同一个目标几条时取最要紧的，同 `key_hints`）
fn keep_hints(plan: &McpKeepPlan, git: &mut Probes) -> Vec<(PathBuf, McpKeyHint)> {
    let Some((_, kept_path, _)) = &plan.kept else {
        return Vec::new();
    };
    let mut hints = Vec::new();
    let mut paths = BTreeMap::new();
    for pending in plan.private.iter().filter(|pending| !pending.mirror) {
        let Some(hint) = hint_for(
            &pending.location,
            &pending.definition,
            &pending.action.target_id,
            &[kept_path.as_path()],
            git,
        ) else {
            continue;
        };
        paths.insert(hint.target_id.clone(), pending.location.path.clone());
        merge(&mut hints, hint);
    }
    hints
        .into_iter()
        .filter_map(|hint| Some((paths.get(&hint.target_id)?.clone(), hint)))
        .collect()
}

/// 执行「保留这份」，再按密钥提醒处理改写了的项目文件（同 `execute_minding_keys`）：`AutoIgnore` 总是加，
/// `Remind` 看确认框里勾没勾 `add_to_gitignore`，`Tracked` 不加。判断用执行前的 git 事实。整次没做成时一行都不加。
/// 追加记进这次改写的撤销（`take_undo`）：撤一次，配置先退回、`.gitignore` 那几行随后退回；不另记撤销号
pub fn execute_keep_minding_keys(
    plan: McpKeepPlan,
    add_to_gitignore: bool,
    backups: &Path,
) -> McpReport {
    let judged = keep_hints(&plan, &mut Probes::default());
    let mut report = execute_keep(plan, backups);
    // 一处不成整次不动：有一条不是 `updated` 就什么都没写
    if report.entries.iter().any(|e| e.outcome != "updated") {
        return report;
    }
    let written = judged
        .into_iter()
        .filter(|(_, hint)| report.entries.iter().any(|e| e.target_id == hint.target_id))
        .collect();
    // 撤销记录里配置文件在前、`.gitignore` 在后：撤之前一起核对写后没被改过，撤时先退配置。
    // 配置文件本身在同一条记录里，之后谁又往里写了带密钥的服务，整条撤销就对不上、一起拒绝，不必另核对
    ignore_written(
        &mut report,
        written,
        add_to_gitignore,
        backups,
        |report, edit, _| report.undo.record_edit(edit),
    );
    report
}

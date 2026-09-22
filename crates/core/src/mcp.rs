//! MCP 配置同步核心。私有计划保存定义和值，DTO 从不包含凭据。
use crate::atomicfile::{self, unsafe_parent, FileState, ReadError, Snapshot};
use crate::discovery::Env;
use crate::fs::normalize;
use crate::models::Harness;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(feature = "weiboap")]
mod weiboap;

const SUPPORTED: [&str; 3] = ["claude-code", "codex", "cursor"];
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLocation {
    pub id: String,
    pub label: String,
    pub harness_id: String,
    pub domain: String,
    pub path: PathBuf,
    /// 同一配置文件中的独立 MCP 作用域。Claude Local MCP 使用项目的精确 key；
    /// 其余位置为 `None`，即文件根的 MCP 容器。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// 位置仍可作为“引入…”的显式目标，但不显示为主矩阵的一列，避免把未创建的
    /// Claude Project 文件误报成同 harness 的缺失配置。
    #[serde(default, skip_serializing_if = "is_false")]
    pub matrix_hidden: bool,
}

/// 可持久化的 MCP 位置身份。规则只记录位置与选择条件，不保存 MCP 定义或凭据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLocationRef {
    pub id: String,
    pub harness_id: String,
    pub domain: String,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
}

/// 扫描到当前位置后自动生成“引入”选择的规则。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAutoImportRule {
    pub source: McpLocationRef,
    pub target_domain: String,
    pub targets: Vec<McpLocationRef>,
    #[serde(default)]
    pub excluded: BTreeSet<String>,
    #[serde(default)]
    pub allow_cross_domain: bool,
    /// 建规则那一刻来源位置里已有的 MCP 名：规则只管之后新出现的，这些不补。
    /// `None` 只出现在升级前持久化的旧规则上——展开时整条跳过，
    /// 首次扫描由 `migrate_baselines` 取当时的全部名字补上
    #[serde(default)]
    pub baseline: Option<BTreeSet<String>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub source_id: String,
    pub name: String,
    pub transport: String,
    pub reason: Option<String>,
    pub cells: Vec<McpCell>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCell {
    pub target_id: String,
    pub state: McpCellState,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpCellState {
    Own,
    Equal,
    SameEndpoint,
    Missing,
    Conflict,
    Invalid,
    Unsupported,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpIssue {
    pub location_id: String,
    pub name: Option<String>,
    pub message: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOverview {
    pub locations: Vec<McpLocation>,
    pub entries: Vec<McpEntry>,
    pub issues: Vec<McpIssue>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpDiscovery {
    pub locations: Vec<McpLocation>,
    pub issues: Vec<McpIssue>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSelection {
    pub source_id: String,
    pub name: String,
    pub target_id: String,
}

/// 从当前位置创建稳定的规则身份；显示名称及矩阵展示状态不属于配置位置身份。
pub fn location_ref(location: &McpLocation) -> McpLocationRef {
    McpLocationRef {
        id: location.id.clone(),
        harness_id: location.harness_id.clone(),
        domain: location.domain.clone(),
        path: location.path.clone(),
        selector: location.selector.clone(),
    }
}

/// 新建或整条替换一条自动添加规则（同一来源 + 目标域即同一条），同时拍 baseline：
/// 来源位置此刻的全部 MCP 名。替换等于重建，排除名单与 baseline 都重来。
/// 来源配置这次读不出来就拒绝：拍成空集会在它修好后把现有的全部补上
pub fn upsert_auto_import(
    rules: &mut Vec<McpAutoImportRule>,
    overview: &McpOverview,
    source: &McpLocation,
    target_domain: String,
    targets: Vec<McpLocationRef>,
    allow_cross_domain: bool,
) -> Result<(), String> {
    if location_unreadable(overview, &source.id) {
        return Err(format!(
            "读不到 {} 的配置，先修好再开自动添加",
            source.label
        ));
    }
    rules.retain(|rule| rule.source.id != source.id || rule.target_domain != target_domain);
    rules.push(McpAutoImportRule {
        source: location_ref(source),
        target_domain,
        targets,
        excluded: BTreeSet::new(),
        allow_cross_domain,
        baseline: Some(source_names(overview, &source.id)),
    });
    Ok(())
}

/// 升级迁移：给没有 baseline 的旧规则补上来源位置当前的全部 MCP 名，于是旧规则从这一刻起
/// 也只管以后新出现的。来源这次没发现、或配置读不出来的先不补（补成空集会在它恢复时
/// 把现有的全部补上），规则继续整条跳过。返回是否改动过
pub fn migrate_baselines(rules: &mut [McpAutoImportRule], overview: &McpOverview) -> bool {
    let mut changed = false;
    for rule in rules.iter_mut().filter(|r| r.baseline.is_none()) {
        let Some(source) = overview
            .locations
            .iter()
            .find(|location| location_ref(location) == rule.source)
        else {
            continue;
        };
        if location_unreadable(overview, &source.id) {
            continue;
        }
        rule.baseline = Some(source_names(overview, &source.id));
        changed = true;
    }
    changed
}

/// 该位置的配置这次读不出来（位置级问题，不是某一条 MCP 的问题）
fn location_unreadable(overview: &McpOverview, location_id: &str) -> bool {
    overview
        .issues
        .iter()
        .any(|issue| issue.location_id == location_id && issue.name.is_none())
}

/// 来源位置当前定义的全部 MCP 名（含本次不支持或有问题的：它们也是「已有的」）
fn source_names(overview: &McpOverview, source_id: &str) -> BTreeSet<String> {
    overview
        .entries
        .iter()
        .filter(|entry| entry.source_id == source_id)
        .map(|entry| entry.name.clone())
        .collect()
}

/// 根据当前扫描结果展开自动引入规则。
///
/// 规则内的位置必须仍精确匹配本次发现的位置。条目及单元格状态一律以本次扫描为准，
/// 从而不会向规则或持久化 DTO 泄露配置值、环境变量或请求头。
pub fn auto_selections(overview: &McpOverview, rules: &[McpAutoImportRule]) -> Vec<McpSelection> {
    let mut out = BTreeSet::new();
    for rule in rules {
        // 规则只管以后新出现的：没有 baseline 就分不清哪些是新的，宁可不补
        let Some(baseline) = &rule.baseline else {
            continue;
        };
        let Some(source) = overview
            .locations
            .iter()
            .find(|location| location_ref(location) == rule.source)
        else {
            continue;
        };
        for target_ref in &rule.targets {
            if target_ref.domain != rule.target_domain {
                continue;
            }
            let Some(target) = overview
                .locations
                .iter()
                .find(|location| location_ref(location) == *target_ref)
            else {
                continue;
            };
            if source.domain != target.domain && !rule.allow_cross_domain {
                continue;
            }
            for entry in overview.entries.iter().filter(|entry| {
                entry.source_id == source.id
                    && entry.reason.is_none()
                    && is_supported_transport(&entry.transport)
                    && !rule.excluded.contains(&entry.name)
                    && !baseline.contains(&entry.name)
            }) {
                if entry
                    .cells
                    .iter()
                    .any(|cell| cell.target_id == target.id && cell.state == McpCellState::Missing)
                {
                    out.insert((
                        entry.source_id.clone(),
                        entry.name.clone(),
                        target.id.clone(),
                    ));
                }
            }
        }
    }
    out.into_iter()
        .map(|(source_id, name, target_id)| McpSelection {
            source_id,
            name,
            target_id,
        })
        .collect()
}

fn is_supported_transport(transport: &str) -> bool {
    matches!(transport, "stdio" | "http")
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAction {
    pub source_id: String,
    pub target_id: String,
    pub name: String,
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    pub cross_domain: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpReport {
    pub entries: Vec<McpReportEntry>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReportEntry {
    pub name: String,
    pub target_id: String,
    pub outcome: String,
    pub message: String,
    pub backup_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Canonical {
    pub(super) transport: String,
    pub(super) command: Option<String>,
    pub(super) args: Vec<String>,
    pub(super) env: BTreeMap<String, String>,
    pub(super) url: Option<String>,
    pub(super) headers: BTreeMap<String, String>,
    /// 仅 Codex 识别的客户端行为字段。它们不参与连接一致性，但同 harness 新建时原样写入。
    pub(super) client_fields: BTreeMap<String, String>,
    /// 不含配置值的诊断，供 DTO 与预览显示。
    pub(super) reason: Option<String>,
    pub(super) unsupported: bool,
    /// 仅 `http_headers_helper` 使该 HTTP 定义无法完整静态比较。
    pub(super) helper_only: bool,
}

impl Canonical {
    fn connection_eq(&self, other: &Self) -> bool {
        self.transport == other.transport
            && self.command == other.command
            && self.args == other.args
            && self.env == other.env
            && self.url == other.url
            && headers_eq(&self.headers, &other.headers)
            && !self.unsupported
            && !other.unsupported
    }

    fn same_endpoint_with_dynamic_auth(&self, other: &Self) -> bool {
        self.has_comparable_http_endpoint()
            && other.has_comparable_http_endpoint()
            && (self.helper_only || other.helper_only)
            && self.url == other.url
    }

    fn different_endpoint_with_dynamic_auth(&self, other: &Self) -> bool {
        self.has_comparable_http_endpoint()
            && other.has_comparable_http_endpoint()
            && (self.helper_only || other.helper_only)
            && self.url != other.url
    }

    fn has_comparable_http_endpoint(&self) -> bool {
        self.transport == "http" && self.url.is_some() && (self.helper_only || !self.unsupported)
    }
}

fn headers_eq(left: &BTreeMap<String, String>, right: &BTreeMap<String, String>) -> bool {
    left.len() == right.len()
        && left.iter().all(|(name, value)| {
            right.get(&name.to_ascii_lowercase()).or_else(|| {
                right
                    .iter()
                    .find(|(other, _)| other.eq_ignore_ascii_case(name))
                    .map(|(_, other_value)| other_value)
            }) == Some(value)
        })
}

pub(super) fn has_duplicate_header_names(headers: &BTreeMap<String, String>) -> bool {
    let mut names = BTreeSet::new();
    headers
        .keys()
        .any(|name| !names.insert(name.to_ascii_lowercase()))
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum State {
    Missing,
    Present(Snapshot),
    #[cfg(feature = "weiboap")]
    Weibo(weiboap::Snapshot),
    Bad(String),
}
#[derive(Debug, Clone)]
struct Parsed {
    values: BTreeMap<String, Canonical>,
    issue: Option<String>,
    state: State,
}
#[derive(Debug, Clone)]
pub(super) struct Pending {
    pub(super) action: McpAction,
    pub(super) source: State,
    pub(super) target: State,
    pub(super) target_location: McpLocation,
    pub(super) definition: Canonical,
}
#[derive(Debug)]
pub struct PreparedPlan {
    pub actions: Vec<McpAction>,
    pub issues: Vec<McpIssue>,
    private: Vec<Pending>,
}

pub fn locations(env: &Env, harnesses: &[Harness], projects: &[PathBuf]) -> Vec<McpLocation> {
    discover_locations(env, harnesses, projects).locations
}

/// 发现 MCP 位置，同时保留无法安全解析的专用 harness 诊断。
pub fn discover_locations(env: &Env, harnesses: &[Harness], projects: &[PathBuf]) -> McpDiscovery {
    let mut out = Vec::new();
    for h in harnesses
        .iter()
        .filter(|h| SUPPORTED.contains(&h.id.as_str()))
    {
        let root = match h.id.as_str() {
            "claude-code" => env.home.join(".claude"),
            "codex" => env
                .vars
                .get("CODEX_HOME")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| env.home.join(".codex")),
            _ => env.home.join(".cursor"),
        };
        let path = match h.id.as_str() {
            "claude-code" => env.home.join(".claude.json"),
            "codex" => root.join("config.toml"),
            _ => root.join("mcp.json"),
        };
        out.push(McpLocation {
            id: h.id.clone(),
            label: if h.id == "claude-code" {
                "Claude Code · User MCPs".into()
            } else {
                h.display_name.clone()
            },
            harness_id: h.id.clone(),
            domain: "global".into(),
            path,
            selector: None,
            matrix_hidden: false,
        });
        for project in projects {
            let domain = normalize(project).to_string_lossy().into_owned();
            // Claude 将 projects 的 key 作为作用域身份，不按路径等价或前缀猜测。
            let project_key = project.to_string_lossy().into_owned();
            let path = match h.id.as_str() {
                "claude-code" => project.join(".mcp.json"),
                "codex" => project.join(".codex/config.toml"),
                _ => project.join(".cursor/mcp.json"),
            };
            if h.id == "claude-code" {
                let claude = env.home.join(".claude.json");
                let local = claude_local_status(&claude, &project_key);
                if local.has_location() {
                    out.push(McpLocation {
                        id: format!("project:{domain}::claude-code:local"),
                        label: "Claude Code · Local MCPs".into(),
                        harness_id: h.id.clone(),
                        domain: format!("project:{domain}"),
                        path: claude,
                        selector: Some(project_key),
                        matrix_hidden: local.is_empty(),
                    });
                }
                let project_missing = matches!(
                    fs::symlink_metadata(&path),
                    Err(error) if error.kind() == io::ErrorKind::NotFound
                );
                // 即使 Local 已存在也保留 Project 目标，供“引入…”显式创建 .mcp.json；
                // 前端只隐藏矩阵列，不能把该可选目标丢失。
                out.push(McpLocation {
                    id: format!("project:{domain}::{}", h.id),
                    label: "Claude Code · Project MCPs".into(),
                    harness_id: h.id.clone(),
                    domain: format!("project:{domain}"),
                    path,
                    selector: None,
                    matrix_hidden: local.has_definitions() && project_missing,
                });
            } else {
                out.push(McpLocation {
                    id: format!("project:{domain}::{}", h.id),
                    label: h.display_name.clone(),
                    harness_id: h.id.clone(),
                    domain: format!("project:{domain}"),
                    path,
                    selector: None,
                    matrix_hidden: false,
                });
            }
        }
    }
    #[cfg(feature = "weiboap")]
    let issues = {
        let (weibo_locations, issues) = weiboap::discover(env, harnesses);
        out.extend(weibo_locations);
        issues
    };
    #[cfg(not(feature = "weiboap"))]
    let issues = Vec::new();
    McpDiscovery {
        locations: out,
        issues,
    }
}

pub fn scan(locations: &[McpLocation]) -> McpOverview {
    let parsed: Vec<_> = locations
        .iter()
        .map(|location| (location, parse(location)))
        .collect();
    let mut issues = Vec::new();
    let mut entries = Vec::new();
    for (location, value) in &parsed {
        if let Some(message) = &value.issue {
            issues.push(McpIssue {
                location_id: location.id.clone(),
                name: None,
                message: message.clone(),
            });
        }
        for (name, def) in &value.values {
            entries.push(McpEntry {
                source_id: location.id.clone(),
                name: name.clone(),
                transport: def.transport.clone(),
                reason: def.reason.clone(),
                cells: Vec::new(),
            });
        }
    }
    for entry in &mut entries {
        let source = parsed
            .iter()
            .find(|(location, _)| location.id == entry.source_id)
            .and_then(|(_, value)| value.values.get(&entry.name))
            .expect("source exists");
        for (target, value) in &parsed {
            let (state, reason) = if target.id == entry.source_id {
                (McpCellState::Own, None)
            } else if value.issue.is_some() {
                (
                    McpCellState::Invalid,
                    Some("目标配置无法解析或不安全".into()),
                )
            } else {
                match value.values.get(&entry.name) {
                    Some(def) if source.same_endpoint_with_dynamic_auth(def) => (
                        McpCellState::SameEndpoint,
                        Some("同一 HTTP URL；动态请求头无法静态确认一致".into()),
                    ),
                    Some(def) if source.different_endpoint_with_dynamic_auth(def) => {
                        (McpCellState::Conflict, Some("URL 不同".into()))
                    }
                    _ if source.unsupported => (
                        McpCellState::Unsupported,
                        Some("来源条目无法无损转换".into()),
                    ),
                    None => (McpCellState::Missing, None),
                    Some(def) if def.unsupported => (
                        McpCellState::Unsupported,
                        Some("目标条目无法无损转换".into()),
                    ),
                    Some(def) if def.connection_eq(source) => (McpCellState::Equal, None),
                    Some(_) => (McpCellState::Conflict, Some("同名配置不同".into())),
                }
            };
            entry.cells.push(McpCell {
                target_id: target.id.clone(),
                state,
                reason,
            });
        }
    }
    McpOverview {
        locations: locations.to_vec(),
        entries,
        issues,
    }
}

pub fn prepare(locations: &[McpLocation], selections: &[McpSelection]) -> PreparedPlan {
    let map: BTreeMap<_, _> = locations
        .iter()
        .map(|location| (location.id.clone(), (location, parse(location))))
        .collect();
    let mut issues = Vec::new();
    let mut candidates: BTreeMap<(String, String), Vec<Pending>> = BTreeMap::new();
    for selection in selections {
        let (Some((source_location, source)), Some((target_location, target))) =
            (map.get(&selection.source_id), map.get(&selection.target_id))
        else {
            issues.push(issue(selection, "来源或目标不存在"));
            continue;
        };
        let Some(definition) = source.values.get(&selection.name) else {
            issues.push(issue(selection, "来源条目不存在或无法解析"));
            continue;
        };
        if !source.state.readable() {
            issues.push(issue(selection, "来源配置不可读"));
            continue;
        }
        if source.issue.is_some() || definition.unsupported {
            issues.push(issue(
                selection,
                definition
                    .reason
                    .as_deref()
                    .unwrap_or("来源条目无法无损转换"),
            ));
            continue;
        }
        if target.issue.is_some() {
            issues.push(issue(selection, "目标配置无法解析或不安全"));
            continue;
        }
        if unsafe_parent(&target_location.path) {
            issues.push(issue(selection, "目标父目录是软链接，已拒绝写入"));
            continue;
        }
        if let Some(old) = target.values.get(&selection.name) {
            if old.unsupported {
                issues.push(issue(
                    selection,
                    old.reason
                        .as_deref()
                        .unwrap_or("目标条目无法静态比较或迁移"),
                ));
                continue;
            }
            issues.push(issue(
                selection,
                if old.connection_eq(definition) {
                    "目标已有一致定义"
                } else {
                    "目标已有冲突定义"
                },
            ));
            continue;
        }
        if source_location.harness_id != target_location.harness_id
            && !definition.client_fields.is_empty()
        {
            issues.push(issue(
                selection,
                &format!(
                    "Codex 客户端设置 {} 无法跨工具无损迁移",
                    definition
                        .client_fields
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("、")
                ),
            ));
            continue;
        }
        candidates
            .entry((
                target_key(target_location, &target.state),
                selection.name.clone(),
            ))
            .or_default()
            .push(Pending {
                action: McpAction {
                    source_id: source_location.id.clone(),
                    target_id: target_location.id.clone(),
                    name: selection.name.clone(),
                    source_path: source_location.path.clone(),
                    target_path: target_location.path.clone(),
                    cross_domain: source_location.domain != target_location.domain,
                },
                source: source.state.clone(),
                target: target.state.clone(),
                target_location: (*target_location).clone(),
                definition: definition.clone(),
            });
    }
    let mut private = Vec::new();
    for group in candidates.into_values() {
        let first = &group[0];
        if group
            .iter()
            .any(|pending| pending.definition != first.definition)
        {
            issues.push(McpIssue {
                location_id: first.action.target_id.clone(),
                name: Some(first.action.name.clone()),
                message: "同一目标条目选择了多个来源，无法任选其一".into(),
            });
        } else {
            // 完全相同的重复选择（同一来源或等价来源）只写入一次。
            // 任一别名目标跨域时，合并动作仍需跨域确认。
            let mut pending = first.clone();
            pending.action.cross_domain =
                group.iter().any(|candidate| candidate.action.cross_domain);
            private.push(pending);
        }
    }
    PreparedPlan {
        actions: private
            .iter()
            .map(|pending| pending.action.clone())
            .collect(),
        issues,
        private,
    }
}

pub fn execute(plan: PreparedPlan, allow_cross_domain: bool) -> McpReport {
    let mut report = McpReport::default();
    let mut groups: BTreeMap<String, Vec<Pending>> = BTreeMap::new();
    for pending in plan.private {
        groups.entry(group_key(&pending)).or_default().push(pending);
    }
    for group in groups.into_values() {
        execute_group(group, allow_cross_domain, &mut report);
    }
    report
}
fn execute_group(group: Vec<Pending>, allow_cross_domain: bool, report: &mut McpReport) {
    let fail = |report: &mut McpReport, message: &str| {
        for pending in &group {
            report
                .entries
                .push(entry(&pending.action, "failed", message, None));
        }
    };
    if group
        .iter()
        .any(|pending| pending.action.cross_domain && !allow_cross_domain)
    {
        fail(report, "跨域同步未获允许");
        return;
    }
    #[cfg(feature = "weiboap")]
    if matches!(group[0].target, State::Weibo(_)) {
        execute_weibo_group(group, report);
        return;
    }
    let path = &group[0].action.target_path;
    if group.iter().any(|pending| {
        !same_location(&pending.action.source_path, &pending.source)
            || !same_location(path, &pending.target)
    }) {
        fail(report, "配置在预览后发生变化");
        return;
    }
    let old = match &group[0].target {
        State::Missing => None,
        State::Present(snap) => Some(snap.bytes.as_slice()),
        State::Bad(_) => {
            fail(report, "目标配置不可写");
            return;
        }
        #[cfg(feature = "weiboap")]
        State::Weibo(_) => unreachable!("WeiboAP groups are handled above"),
    };
    let bytes = match merge_group(old, &group) {
        Ok(bytes) => bytes,
        Err(_) => {
            fail(report, "配置无法安全写回");
            return;
        }
    };
    let backup = match &group[0].target {
        State::Present(snap) => match backup(path, snap) {
            Ok(path) => Some(path),
            Err(_) => {
                fail(report, "备份失败，未写入目标");
                return;
            }
        },
        State::Missing => None,
        State::Bad(_) => unreachable!(),
        #[cfg(feature = "weiboap")]
        State::Weibo(_) => unreachable!("WeiboAP groups are handled above"),
    };
    if atomic_write(path, &bytes, &group[0].target).is_err() {
        for (index, pending) in group.iter().enumerate() {
            report.entries.push(entry(
                &pending.action,
                "failed",
                "原子写入失败",
                (index == 0).then(|| backup.clone()).flatten(),
            ));
        }
        return;
    }
    for (index, pending) in group.iter().enumerate() {
        report.entries.push(entry(
            &pending.action,
            "created",
            "已创建 MCP 定义",
            (index == 0).then(|| backup.clone()).flatten(),
        ));
    }
}

#[cfg(feature = "weiboap")]
fn execute_weibo_group(group: Vec<Pending>, report: &mut McpReport) {
    if group.iter().any(|pending| {
        !same_location(&pending.action.source_path, &pending.source)
            || !same_location(&pending.action.target_path, &pending.target)
    }) {
        for pending in &group {
            report.entries.push(entry(
                &pending.action,
                "failed",
                "配置在预览后发生变化",
                None,
            ));
        }
        return;
    }
    match weiboap::write(&group) {
        Ok(backup) => {
            for (index, pending) in group.iter().enumerate() {
                report.entries.push(entry(
                    &pending.action,
                    "created",
                    "已创建 MCP 定义（请在 WeiboAP 中启用）",
                    (index == 0).then(|| backup.clone()).flatten(),
                ));
            }
        }
        Err(message) => {
            for pending in &group {
                report
                    .entries
                    .push(entry(&pending.action, "failed", &message, None));
            }
        }
    }
}
fn issue(selection: &McpSelection, message: &str) -> McpIssue {
    McpIssue {
        location_id: selection.target_id.clone(),
        name: Some(selection.name.clone()),
        message: message.into(),
    }
}
fn entry(
    action: &McpAction,
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

fn parse(location: &McpLocation) -> Parsed {
    #[cfg(feature = "weiboap")]
    if location.harness_id == "weiboap" {
        return match weiboap::parse(location) {
            Ok(value) => Parsed {
                values: value.values,
                issue: value.issue,
                state: State::Weibo(value.snapshot),
            },
            Err(message) => Parsed {
                values: BTreeMap::new(),
                issue: Some(message.clone()),
                state: State::Bad(message),
            },
        };
    }
    let state = read(&location.path);
    match state.clone() {
        State::Missing => Parsed {
            values: BTreeMap::new(),
            issue: None,
            state,
        },
        State::Bad(message) => Parsed {
            values: BTreeMap::new(),
            issue: Some(message.clone()),
            state,
        },
        State::Present(snap) if toml(&location.path) => parse_toml(&snap.bytes, state),
        State::Present(snap) => parse_json(&snap.bytes, state, location.selector.as_deref()),
        #[cfg(feature = "weiboap")]
        State::Weibo(_) => unreachable!("WeiboAP is handled before generic parsing"),
    }
}

impl State {
    fn readable(&self) -> bool {
        matches!(self, Self::Present(_)) || self.is_weibo()
    }

    #[cfg(feature = "weiboap")]
    fn is_weibo(&self) -> bool {
        matches!(self, Self::Weibo(_))
    }

    #[cfg(not(feature = "weiboap"))]
    fn is_weibo(&self) -> bool {
        false
    }
}

fn target_key(location: &McpLocation, state: &State) -> String {
    match state {
        #[cfg(feature = "weiboap")]
        State::Weibo(snapshot) => weiboap::entry_key(snapshot),
        _ => format!(
            "file:{}:{}",
            normalize(&location.path).display(),
            location.selector.as_deref().unwrap_or("root")
        ),
    }
}

fn group_key(pending: &Pending) -> String {
    match &pending.target {
        #[cfg(feature = "weiboap")]
        State::Weibo(snapshot) => weiboap::database_key(snapshot),
        // 同一 .claude.json 的 User/Local（或多个 Local）必须在一次备份、一次
        // 原子写中完成；selector 只用于合并时定位对应的嵌套容器。
        _ => format!("file:{}", normalize(&pending.action.target_path).display()),
    }
}

fn same_location(path: &Path, expected: &State) -> bool {
    match expected {
        #[cfg(feature = "weiboap")]
        State::Weibo(snapshot) => weiboap::same(path, snapshot),
        _ => same(path, expected),
    }
}
fn read(path: &Path) -> State {
    match atomicfile::read_state(path) {
        Ok(FileState::Missing) => State::Missing,
        Ok(FileState::Present(snap)) => State::Present(snap),
        Err(ReadError::Symlink) => State::Bad("配置文件是软链接，已拒绝读取".into()),
        Err(ReadError::NotRegularFile) => State::Bad("配置路径不是普通文件".into()),
        Err(ReadError::Io(_)) => State::Bad("配置不可读".into()),
    }
}
/// Claude Local 作用域的状态。这里只以项目精确 key 作为 selector，不把顶层
/// User MCP 误当作项目服务；非法容器也保留位置，让扫描明确报 invalid。
#[derive(Clone, Copy)]
enum ClaudeLocalStatus {
    Absent,
    Empty,
    Present,
    Invalid,
}
impl ClaudeLocalStatus {
    fn has_location(self) -> bool {
        !matches!(self, Self::Absent)
    }

    fn is_empty(self) -> bool {
        matches!(self, Self::Empty)
    }

    fn has_definitions(self) -> bool {
        matches!(self, Self::Present)
    }
}

fn claude_local_status(path: &Path, project: &str) -> ClaudeLocalStatus {
    let State::Present(snap) = read(path) else {
        return ClaudeLocalStatus::Absent;
    };
    if serde_json::from_slice::<NoDuplicates>(&snap.bytes).is_err() {
        return ClaudeLocalStatus::Absent;
    }
    let Ok(root) = serde_json::from_slice::<Value>(&snap.bytes) else {
        return ClaudeLocalStatus::Absent;
    };
    match root.get("projects") {
        Some(Value::Object(projects)) => match projects.get(project) {
            None => ClaudeLocalStatus::Absent,
            Some(Value::Object(local)) => match local.get("mcpServers") {
                None => ClaudeLocalStatus::Empty,
                Some(Value::Object(servers)) if servers.is_empty() => ClaudeLocalStatus::Empty,
                Some(Value::Object(_)) => ClaudeLocalStatus::Present,
                Some(_) => ClaudeLocalStatus::Invalid,
            },
            Some(_) => ClaudeLocalStatus::Invalid,
        },
        Some(_) => ClaudeLocalStatus::Invalid,
        None => ClaudeLocalStatus::Absent,
    }
}
fn same(path: &Path, expected: &State) -> bool {
    match (expected, read(path)) {
        (State::Missing, State::Missing) => true,
        (State::Present(expected), State::Present(actual)) => expected == &actual,
        _ => false,
    }
}

fn parse_json(bytes: &[u8], state: State, selector: Option<&str>) -> Parsed {
    if serde_json::from_slice::<NoDuplicates>(bytes).is_err() {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some("JSON 无法解析或含重复对象键（JSONC 不支持）".into()),
            state,
        };
    }
    let root: Value = serde_json::from_slice(bytes).expect("validated JSON");
    let Some(root) = root.as_object() else {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some("JSON 根必须是对象".into()),
            state,
        };
    };
    let servers = match selector {
        Some(project) => match root.get("projects") {
            None => None,
            Some(Value::Object(projects)) => match projects.get(project) {
                None => None,
                Some(Value::Object(local)) => local.get("mcpServers"),
                Some(_) => {
                    return invalid_json_scope(state, "projects 中的项目配置必须是对象");
                }
            },
            Some(_) => return invalid_json_scope(state, "projects 必须是对象"),
        },
        None => root.get("mcpServers"),
    };
    let values = match servers {
        None => BTreeMap::new(),
        Some(Value::Object(servers)) => servers
            .iter()
            .map(|(name, value)| (name.clone(), canon_json(value)))
            .collect(),
        Some(_) => {
            return Parsed {
                values: BTreeMap::new(),
                issue: Some("mcpServers 必须是对象".into()),
                state,
            }
        }
    };
    Parsed {
        values,
        issue: None,
        state,
    }
}
fn invalid_json_scope(state: State, message: &str) -> Parsed {
    Parsed {
        values: BTreeMap::new(),
        issue: Some(message.into()),
        state,
    }
}
fn canon_json(value: &Value) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported_with("MCP 定义不是对象");
    };
    let mut reason = object
        .keys()
        .find(|key| !["type", "command", "args", "env", "url", "headers"].contains(&key.as_str()))
        .map(|key| format!("不支持迁移字段 {key}"));
    let mut bad = reason.is_some();
    let command = json_string(object.get("command"), &mut bad);
    let url = json_string(object.get("url"), &mut bad);
    let args = json_args(object.get("args"), &mut bad);
    let env = json_map(object.get("env"), &mut bad);
    let headers = json_map(object.get("headers"), &mut bad);
    let typ = json_string(object.get("type"), &mut bad);
    if reason.is_none() {
        for field in ["command", "url", "type"] {
            if object.get(field).is_some_and(|value| !value.is_string()) {
                reason = Some(format!("字段 {field} 类型无效"));
                break;
            }
        }
    }
    if reason.is_none()
        && object.get("args").is_some_and(|value| {
            !value
                .as_array()
                .is_some_and(|values| values.iter().all(Value::is_string))
        })
    {
        reason = Some("字段 args 类型无效".into());
    }
    if reason.is_none() {
        for field in ["env", "headers"] {
            if object.get(field).is_some_and(|value| {
                !value
                    .as_object()
                    .is_some_and(|values| values.values().all(Value::is_string))
            }) {
                reason = Some(format!("字段 {field} 类型无效"));
                break;
            }
        }
    }
    let transport = match (command.as_ref(), url.as_ref()) {
        (Some(_), None) if typ.as_deref().is_none_or(|t| t == "stdio") => "stdio",
        (None, Some(_))
            if typ
                .as_deref()
                .is_none_or(|t| t == "http" || t == "streamable-http") =>
        {
            "http"
        }
        _ => {
            bad = true;
            "unsupported"
        }
    };
    if (transport == "stdio" && object.contains_key("headers"))
        || (transport == "http" && (object.contains_key("args") || object.contains_key("env")))
    {
        bad = true;
        reason.get_or_insert_with(|| "连接字段不适用于该传输类型".into());
    }
    if command
        .as_deref()
        .is_some_and(|v| v.is_empty() || reference(v))
    {
        bad = true;
        reason.get_or_insert_with(|| "字段 command 为空或包含变量引用".into());
    }
    if url.as_deref().is_some_and(|v| v.is_empty() || reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 url 为空或包含变量引用".into());
    }
    if args.iter().any(|v| reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 args 包含变量引用".into());
    }
    if env.values().any(|v| reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 env 包含变量引用".into());
    }
    if headers.values().any(|v| reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 headers 包含变量引用".into());
    }
    if has_duplicate_header_names(&headers) {
        bad = true;
        reason.get_or_insert_with(|| "字段 headers 含大小写重复名称".into());
    }
    Canonical {
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields: BTreeMap::new(),
        reason: bad.then(|| reason.unwrap_or_else(|| "连接字段类型无效".into())),
        unsupported: bad,
        helper_only: false,
    }
}
fn json_string(value: Option<&Value>, bad: &mut bool) -> Option<String> {
    match value {
        None => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => {
            *bad = true;
            None
        }
    }
}
fn json_args(value: Option<&Value>, bad: &mut bool) -> Vec<String> {
    match value {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Some(value.clone()),
                _ => {
                    *bad = true;
                    None
                }
            })
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default(),
        _ => {
            *bad = true;
            Vec::new()
        }
    }
}
fn json_map(value: Option<&Value>, bad: &mut bool) -> BTreeMap<String, String> {
    match value {
        None => BTreeMap::new(),
        Some(Value::Object(values)) => values
            .iter()
            .map(|(key, value)| match value {
                Value::String(value) => Some((key.clone(), value.clone())),
                _ => {
                    *bad = true;
                    None
                }
            })
            .collect::<Option<BTreeMap<_, _>>>()
            .unwrap_or_default(),
        _ => {
            *bad = true;
            BTreeMap::new()
        }
    }
}

fn parse_toml(bytes: &[u8], state: State) -> Parsed {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some("TOML 不是 UTF-8".into()),
            state,
        };
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some("TOML 无法解析".into()),
            state,
        };
    };
    let values = match document.get("mcp_servers") {
        None => BTreeMap::new(),
        Some(item) => match item.as_table_like() {
            Some(table) => table
                .iter()
                .map(|(name, value)| (name.into(), canon_toml(value)))
                .collect(),
            None => {
                return Parsed {
                    values: BTreeMap::new(),
                    issue: Some("mcp_servers 必须是表".into()),
                    state,
                }
            }
        },
    };
    Parsed {
        values,
        issue: None,
        state,
    }
}
fn canon_toml(item: &toml_edit::Item) -> Canonical {
    let Some(table) = item.as_table_like() else {
        return unsupported_with("MCP 定义不是表");
    };
    const CONNECTION: [&str; 5] = ["command", "args", "env", "url", "http_headers"];
    const CLIENT: [&str; 3] = ["enabled", "startup_timeout_sec", "tool_timeout_sec"];
    let has_headers_helper = table.contains_key("http_headers_helper");
    let headers_helper_valid = table
        .get("http_headers_helper")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.trim().is_empty());
    let mut reason = table.iter().find_map(|(key, _)| {
        (!CONNECTION.contains(&key) && !CLIENT.contains(&key) && key != "http_headers_helper")
            .then(|| format!("Codex 不支持迁移字段 {key}"))
    });
    let mut bad = reason.is_some();
    let command = toml_string(table.get("command"), &mut bad);
    let url = toml_string(table.get("url"), &mut bad);
    let args = toml_args(table.get("args"), &mut bad);
    let env = toml_map(table.get("env"), &mut bad);
    let headers = toml_map(table.get("http_headers"), &mut bad);
    let client_fields = codex_client_fields(table, &mut bad, &mut reason);
    if reason.is_none() {
        for field in ["command", "url"] {
            if table
                .get(field)
                .is_some_and(|value| value.as_str().is_none())
            {
                reason = Some(format!("字段 {field} 类型无效"));
                break;
            }
        }
    }
    if reason.is_none()
        && table
            .get("args")
            .is_some_and(|value| value.as_array().is_none())
    {
        reason = Some("字段 args 类型无效".into());
    }
    if reason.is_none() {
        for field in ["env", "http_headers"] {
            if table
                .get(field)
                .is_some_and(|value| value.as_table_like().is_none())
            {
                reason = Some(format!("字段 {field} 类型无效"));
                break;
            }
        }
    }
    let transport = match (command.as_ref(), url.as_ref()) {
        (Some(_), None) => "stdio",
        (None, Some(_)) => "http",
        _ => {
            bad = true;
            "unsupported"
        }
    };
    if (transport == "stdio" && table.contains_key("http_headers"))
        || (transport == "http" && (table.contains_key("args") || table.contains_key("env")))
    {
        bad = true;
        reason.get_or_insert_with(|| "连接字段不适用于该传输类型".into());
    }
    if command
        .as_deref()
        .is_some_and(|v| v.is_empty() || reference(v))
    {
        bad = true;
        reason.get_or_insert_with(|| "字段 command 为空或包含变量引用".into());
    }
    if url.as_deref().is_some_and(|v| v.is_empty() || reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 url 为空或包含变量引用".into());
    }
    if args.iter().any(|v| reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 args 包含变量引用".into());
    }
    if env.values().any(|v| reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 env 包含变量引用".into());
    }
    if headers.values().any(|v| reference(v)) {
        bad = true;
        reason.get_or_insert_with(|| "字段 http_headers 包含变量引用".into());
    }
    if has_duplicate_header_names(&headers) {
        bad = true;
        reason.get_or_insert_with(|| "字段 http_headers 含大小写重复名称".into());
    }
    if has_headers_helper && !headers_helper_valid {
        bad = true;
        reason.get_or_insert_with(|| "字段 http_headers_helper 必须是非空字符串".into());
    }
    let helper_only = has_headers_helper && !bad;
    if has_headers_helper {
        reason.get_or_insert_with(|| {
            "动态请求头 http_headers_helper，无法静态比较/跨工具迁移".into()
        });
    }
    Canonical {
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields,
        reason: (bad || has_headers_helper)
            .then(|| reason.unwrap_or_else(|| "连接字段类型无效".into())),
        unsupported: bad || has_headers_helper,
        helper_only,
    }
}

fn codex_client_fields(
    table: &dyn toml_edit::TableLike,
    bad: &mut bool,
    reason: &mut Option<String>,
) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    for key in ["enabled", "startup_timeout_sec", "tool_timeout_sec"] {
        let Some(item) = table.get(key) else {
            continue;
        };
        let valid = match key {
            "enabled" => item.as_bool().is_some(),
            _ => {
                item.as_integer().is_some_and(|value| value >= 0)
                    || item
                        .as_float()
                        .is_some_and(|value| value.is_finite() && value >= 0.0)
            }
        };
        if !valid {
            *bad = true;
            reason.get_or_insert_with(|| format!("字段 {key} 类型或值无效"));
            continue;
        }
        fields.insert(key.into(), item.to_string());
    }
    fields
}
fn toml_string(value: Option<&toml_edit::Item>, bad: &mut bool) -> Option<String> {
    match value {
        None => None,
        Some(value) => value.as_str().map(str::to_owned).or_else(|| {
            *bad = true;
            None
        }),
    }
}
fn toml_args(value: Option<&toml_edit::Item>, bad: &mut bool) -> Vec<String> {
    match value {
        None => Vec::new(),
        Some(value) => value
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .map(|v| {
                        v.as_str().map(str::to_owned).or_else(|| {
                            *bad = true;
                            None
                        })
                    })
                    .collect::<Option<Vec<_>>>()
                    .unwrap_or_default()
            })
            .unwrap_or_else(|| {
                *bad = true;
                Vec::new()
            }),
    }
}
fn toml_map(value: Option<&toml_edit::Item>, bad: &mut bool) -> BTreeMap<String, String> {
    match value {
        None => BTreeMap::new(),
        Some(value) => value
            .as_table_like()
            .map(|table| {
                table
                    .iter()
                    .map(|(key, v)| {
                        v.as_str().map(|v| (key.into(), v.into())).or_else(|| {
                            *bad = true;
                            None
                        })
                    })
                    .collect::<Option<BTreeMap<_, _>>>()
                    .unwrap_or_default()
            })
            .unwrap_or_else(|| {
                *bad = true;
                BTreeMap::new()
            }),
    }
}
fn unsupported_with(reason: &str) -> Canonical {
    Canonical {
        transport: "unsupported".into(),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        client_fields: BTreeMap::new(),
        reason: Some(reason.into()),
        unsupported: true,
        helper_only: false,
    }
}
fn reference(value: &str) -> bool {
    value.contains("${")
}

fn merge_group(existing: Option<&[u8]>, group: &[Pending]) -> io::Result<Vec<u8>> {
    let mut per_scope: BTreeMap<Option<String>, Vec<(&str, &Canonical)>> = BTreeMap::new();
    let mut locations: BTreeMap<Option<String>, &McpLocation> = BTreeMap::new();
    for pending in group {
        let selector = pending.target_location.selector.clone();
        locations
            .entry(selector.clone())
            .or_insert(&pending.target_location);
        per_scope
            .entry(selector)
            .or_default()
            .push((pending.action.name.as_str(), &pending.definition));
    }
    let mut bytes = existing.map(ToOwned::to_owned);
    for (selector, additions) in per_scope {
        let location = locations
            .get(&selector)
            .expect("scope location exists for additions");
        bytes = Some(merge(location, bytes.as_deref(), &additions)?);
    }
    Ok(bytes.expect("at least one pending MCP addition"))
}
fn merge(
    location: &McpLocation,
    existing: Option<&[u8]>,
    additions: &[(&str, &Canonical)],
) -> io::Result<Vec<u8>> {
    if toml(&location.path) {
        merge_toml(existing, additions)
    } else if let Some(project) = location.selector.as_deref() {
        merge_claude_local_json(existing, additions, project)
    } else {
        merge_json(existing, additions)
    }
}
fn merge_json(existing: Option<&[u8]>, additions: &[(&str, &Canonical)]) -> io::Result<Vec<u8>> {
    let mut bytes = existing.unwrap_or(b"{}").to_vec();
    if serde_json::from_slice::<NoDuplicates>(&bytes).is_err() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "json"));
    }
    let (root_start, root_end, server_range) = raw_json_ranges(&bytes)?;
    let fields: Vec<_> = additions
        .iter()
        .map(|(name, def)| Ok((*name, json_server(def)?)))
        .collect::<io::Result<_>>()?;
    if let Some((start, end)) = server_range {
        if bytes.get(start) != Some(&b'{') {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "mcpServers"));
        }
        insert_members(&mut bytes, start, end, &fields)?;
    } else {
        let object = json_object(&fields)?;
        insert_root(&mut bytes, root_start, root_end, &object)?;
    }
    Ok(bytes)
}
/// 只在 Claude 的 `projects[project].mcpServers` 里追加成员。所有未命中的
/// 根字段、其它项目及它们内部的原始字节都保留，不经 serde 重新序列化。
fn merge_claude_local_json(
    existing: Option<&[u8]>,
    additions: &[(&str, &Canonical)],
    project: &str,
) -> io::Result<Vec<u8>> {
    let mut bytes = existing.unwrap_or(b"{}").to_vec();
    if serde_json::from_slice::<NoDuplicates>(&bytes).is_err() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "json"));
    }
    let fields: Vec<_> = additions
        .iter()
        .map(|(name, def)| Ok((*name, json_server(def)?)))
        .collect::<io::Result<_>>()?;
    let (root_start, root_end, root) = raw_object_members(&bytes)?;
    let Some(projects) = root.get("projects").copied() else {
        let servers = json_object(&fields)?;
        let local = object_with_member("mcpServers", &servers)?;
        let projects = object_with_member(project, &local)?;
        insert_raw_members(&mut bytes, root_start, root_end, &[("projects", projects)])?;
        return Ok(bytes);
    };
    let (projects_start, projects_end, projects_members) = raw_object_members_at(&bytes, projects)?;
    let Some(local) = projects_members.get(project).copied() else {
        let servers = json_object(&fields)?;
        let local = object_with_member("mcpServers", &servers)?;
        insert_raw_members(
            &mut bytes,
            projects_start,
            projects_end,
            &[(project, local)],
        )?;
        return Ok(bytes);
    };
    let (local_start, local_end, local_members) = raw_object_members_at(&bytes, local)?;
    if let Some(servers) = local_members.get("mcpServers").copied() {
        if bytes.get(servers.0) != Some(&b'{') {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "mcpServers"));
        }
        insert_members(&mut bytes, servers.0, servers.1, &fields)?;
    } else {
        let servers = json_object(&fields)?;
        insert_raw_members(
            &mut bytes,
            local_start,
            local_end,
            &[("mcpServers", servers)],
        )?;
    }
    Ok(bytes)
}
fn object_with_member(name: &str, value: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = serde_json::to_vec(name).map_err(io::Error::other)?;
    out.push(b':');
    out.extend(value);
    let mut object = vec![b'{'];
    object.extend(out);
    object.push(b'}');
    Ok(object)
}
fn insert_raw_members(
    bytes: &mut Vec<u8>,
    start: usize,
    end: usize,
    fields: &[(&str, Vec<u8>)],
) -> io::Result<()> {
    let at = rtrim(bytes, end - 1, start + 1);
    let empty = skip(bytes, start + 1) == end - 1;
    let mut add = if empty { Vec::new() } else { vec![b','] };
    for (index, (name, value)) in fields.iter().enumerate() {
        if index > 0 {
            add.push(b',');
        }
        add.extend(serde_json::to_vec(name).map_err(io::Error::other)?);
        add.push(b':');
        add.extend(value);
    }
    bytes.splice(at..at, add);
    Ok(())
}
fn json_server(def: &Canonical) -> io::Result<Vec<u8>> {
    let mut object = serde_json::Map::new();
    object.insert("type".into(), Value::String(def.transport.clone()));
    if def.transport == "stdio" {
        object.insert(
            "command".into(),
            Value::String(
                def.command
                    .clone()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "command"))?,
            ),
        );
        if !def.args.is_empty() {
            object.insert(
                "args".into(),
                Value::Array(def.args.iter().cloned().map(Value::String).collect()),
            );
        }
        if !def.env.is_empty() {
            object.insert(
                "env".into(),
                Value::Object(
                    def.env
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                        .collect(),
                ),
            );
        }
    } else {
        object.insert(
            "url".into(),
            Value::String(
                def.url
                    .clone()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "url"))?,
            ),
        );
        if !def.headers.is_empty() {
            object.insert(
                "headers".into(),
                Value::Object(
                    def.headers
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                        .collect(),
                ),
            );
        }
    }
    serde_json::to_vec(&Value::Object(object)).map_err(io::Error::other)
}
fn json_object(fields: &[(&str, Vec<u8>)]) -> io::Result<Vec<u8>> {
    let mut out = vec![b'{'];
    for (i, (name, value)) in fields.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend(serde_json::to_vec(name).map_err(io::Error::other)?);
        out.push(b':');
        out.extend(value);
    }
    out.push(b'}');
    Ok(out)
}
fn insert_members(
    bytes: &mut Vec<u8>,
    start: usize,
    end: usize,
    fields: &[(&str, Vec<u8>)],
) -> io::Result<()> {
    let at = rtrim(bytes, end - 1, start + 1);
    let empty = skip(bytes, start + 1) == end - 1;
    let object = json_object(fields)?;
    let mut add = if empty { Vec::new() } else { vec![b','] };
    add.extend(&object[1..object.len() - 1]);
    bytes.splice(at..at, add);
    Ok(())
}
fn insert_root(bytes: &mut Vec<u8>, start: usize, end: usize, object: &[u8]) -> io::Result<()> {
    let at = rtrim(bytes, end - 1, start + 1);
    let empty = skip(bytes, start + 1) == end - 1;
    let mut add = if empty { Vec::new() } else { vec![b','] };
    add.extend(b"\n  \"mcpServers\": ");
    add.extend(object);
    bytes.splice(at..at, add);
    Ok(())
}
fn merge_toml(existing: Option<&[u8]>, additions: &[(&str, &Canonical)]) -> io::Result<Vec<u8>> {
    let text = existing
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "utf8"))?
        .unwrap_or("");
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "toml"))?;
    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = toml_edit::table();
    }
    let table = doc["mcp_servers"]
        .as_table_like_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "servers"))?;
    for (name, def) in additions {
        if table.contains_key(name) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "exists"));
        }
        let mut server = toml_edit::Table::new();
        if def.transport == "stdio" {
            server["command"] = toml_edit::value(
                def.command
                    .clone()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "command"))?,
            );
            if !def.args.is_empty() {
                let mut args = toml_edit::Array::new();
                for arg in &def.args {
                    args.push(arg.as_str());
                }
                server["args"] = toml_edit::value(args);
            }
            if !def.env.is_empty() {
                server["env"] = toml_edit::value(inline(&def.env));
            }
        } else {
            server["url"] = toml_edit::value(
                def.url
                    .clone()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "url"))?,
            );
            if !def.headers.is_empty() {
                server["http_headers"] = toml_edit::value(inline(&def.headers));
            }
        }
        for (key, raw) in &def.client_fields {
            let parsed = format!("value = {raw}")
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "client field"))?;
            let value = parsed
                .get("value")
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "client field"))?;
            server.insert(key, value);
        }
        table.insert(name, toml_edit::Item::Table(server));
    }
    Ok(doc.to_string().into_bytes())
}
fn inline(values: &BTreeMap<String, String>) -> toml_edit::InlineTable {
    let mut table = toml_edit::InlineTable::new();
    for (key, value) in values {
        table.insert(key, toml_edit::Value::from(value.as_str()));
    }
    table
}
fn toml(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("toml")
}

/// MCP 的备份固定用 `mcp` 后缀：`config.mcp.bak`、`config.mcp.1.bak`……
fn backup(path: &Path, snap: &Snapshot) -> io::Result<PathBuf> {
    atomicfile::backup(path, snap, "mcp")
}
/// 只有 Missing / Present 可写；Bad 与 Weibo 在这里拒绝，不进入共享的原子写。
fn atomic_write(path: &Path, bytes: &[u8], expected: &State) -> io::Result<()> {
    match expected {
        State::Missing => atomicfile::atomic_write(path, bytes, &FileState::Missing),
        State::Present(snap) => {
            atomicfile::atomic_write(path, bytes, &FileState::Present(snap.clone()))
        }
        State::Bad(_) => Err(io::Error::new(io::ErrorKind::PermissionDenied, "bad")),
        #[cfg(feature = "weiboap")]
        State::Weibo(_) => Err(io::Error::new(io::ErrorKind::PermissionDenied, "weibo")),
    }
}

pub(super) struct NoDuplicates;
impl<'de> Deserialize<'de> for NoDuplicates {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NoDuplicateVisitor)
    }
}
struct NoDuplicateVisitor;
impl<'de> Visitor<'de> for NoDuplicateVisitor {
    type Value = NoDuplicates;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("JSON without duplicate keys")
    }
    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_string<E: serde::de::Error>(self, _: String) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        while a.next_element_seed(Seed)?.is_some() {}
        Ok(NoDuplicates)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let mut keys = BTreeSet::new();
        while let Some(key) = a.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(serde::de::Error::custom("duplicate JSON key"));
            }
            a.next_value_seed(Seed)?;
        }
        Ok(NoDuplicates)
    }
}
struct Seed;
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = NoDuplicates;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        NoDuplicates::deserialize(d)
    }
}

#[derive(Deserialize)]
struct RawRoot<'a> {
    #[serde(rename = "mcpServers", borrow)]
    mcp_servers: Option<&'a RawValue>,
}
type JsonRanges = (usize, usize, Option<(usize, usize)>);
struct RawObject<'a> {
    fields: BTreeMap<String, &'a RawValue>,
}
impl<'de> Deserialize<'de> for RawObject<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(RawObjectVisitor)
    }
}
struct RawObjectVisitor;
impl<'de> Visitor<'de> for RawObjectVisitor {
    type Value = RawObject<'de>;
    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("JSON object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = BTreeMap::new();
        while let Some(name) = map.next_key::<String>()? {
            let value = map.next_value::<&'de RawValue>()?;
            if fields.insert(name, value).is_some() {
                return Err(serde::de::Error::custom("duplicate JSON key"));
            }
        }
        Ok(RawObject { fields })
    }
}
type RawObjectRanges = (usize, usize, BTreeMap<String, (usize, usize)>);
fn raw_object_members(bytes: &[u8]) -> io::Result<RawObjectRanges> {
    let start = skip(bytes, 0);
    let end = rtrim(bytes, bytes.len(), start);
    raw_object_members_range(bytes, start, end)
}
fn raw_object_members_at(bytes: &[u8], range: (usize, usize)) -> io::Result<RawObjectRanges> {
    raw_object_members_range(bytes, range.0, range.1)
}
fn raw_object_members_range(bytes: &[u8], start: usize, end: usize) -> io::Result<RawObjectRanges> {
    if bytes.get(start) != Some(&b'{') || bytes.get(end.saturating_sub(1)) != Some(&b'}') {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "object range"));
    }
    let RawObject { fields } = serde_json::from_slice(&bytes[start..end])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "object parse"))?;
    let base = bytes[start..end].as_ptr() as usize;
    let mut ranges = BTreeMap::new();
    for (name, raw) in fields {
        let value = raw.get().as_bytes();
        let value_start = (value.as_ptr() as usize)
            .checked_sub(base)
            .and_then(|offset| start.checked_add(offset))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "raw value"))?;
        let value_end = value_start
            .checked_add(value.len())
            .filter(|value_end| *value_end <= end)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "raw value"))?;
        ranges.insert(name, (value_start, value_end));
    }
    Ok((start, end, ranges))
}
fn raw_json_ranges(bytes: &[u8]) -> io::Result<JsonRanges> {
    let root: RawRoot<'_> = serde_json::from_slice(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "root"))?;
    let start = skip(bytes, 0);
    let end = rtrim(bytes, bytes.len(), start);
    if bytes.get(start) != Some(&b'{') || bytes.get(end.saturating_sub(1)) != Some(&b'}') {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "root"));
    }
    let range = root
        .mcp_servers
        .map(|raw| {
            let value = raw.get().as_bytes();
            let start = (value.as_ptr() as usize)
                .checked_sub(bytes.as_ptr() as usize)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "raw value"))?;
            let end = start
                .checked_add(value.len())
                .filter(|end| *end <= bytes.len())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "raw value"))?;
            Ok::<_, io::Error>((start, end))
        })
        .transpose()?;
    Ok((start, end, range))
}
fn skip(bytes: &[u8], mut p: usize) -> usize {
    while bytes.get(p).is_some_and(u8::is_ascii_whitespace) {
        p += 1;
    }
    p
}
fn rtrim(bytes: &[u8], mut p: usize, low: usize) -> usize {
    while p > low && bytes[p - 1].is_ascii_whitespace() {
        p -= 1;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escaped_duplicate_key_is_invalid() {
        assert!(serde_json::from_slice::<NoDuplicates>(br#"{"a":1,"\u0061":2}"#).is_err())
    }
    #[test]
    fn https_is_not_comment() {
        assert!(raw_json_ranges(br#"{"mcpServers":{"x":{"url":"https://x"}}}"#).is_ok())
    }
    #[test]
    fn invalid_toml_utf8_is_invalid() {
        let parsed = parse_toml(b"[mcp_servers.x]\ncommand = \"x\"\xff", State::Missing);
        assert!(parsed.issue.is_some());
    }
    #[test]
    fn transport_specific_fields_are_not_migratable() {
        let json: Value = serde_json::json!({"command":"x", "headers": {"A":"b"}});
        assert!(canon_json(&json).unsupported);
        let toml = "[mcp_servers.x]\nurl = \"https://x\"\nenv = { A = \"b\" }"
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert!(canon_toml(toml["mcp_servers"].get("x").unwrap()).unsupported);
    }
    #[test]
    fn inline_mcp_servers_keeps_existing_member() {
        let existing = b"mcp_servers = { old = { command = \"old\" } }\n";
        let def = Canonical {
            transport: "stdio".into(),
            command: Some("new".into()),
            args: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            client_fields: BTreeMap::new(),
            reason: None,
            unsupported: false,
            helper_only: false,
        };
        let output = merge_toml(Some(existing), &[("new", &def)]).unwrap();
        let parsed = parse_toml(&output, State::Missing);
        assert!(parsed.values.contains_key("old") && parsed.values.contains_key("new"));
    }
    #[test]
    fn blank_codex_home_falls_back_to_home_directory() {
        let harness = Harness {
            id: "codex".into(),
            display_name: "Codex".into(),
            project_dir: None,
            global_dir: None,
            universal: false,
            agent_dirs: Vec::new(),
            managed_global_dir: false,
            agent_labels: None,
        };
        let env = Env {
            home: PathBuf::from("/tmp/home"),
            vars: [("CODEX_HOME".into(), "  ".into())].into_iter().collect(),
        };
        assert_eq!(
            locations(&env, &[harness], &[])[0].path,
            PathBuf::from("/tmp/home/.codex/config.toml")
        );
    }
}

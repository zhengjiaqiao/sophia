//! MCP 配置同步核心。私有计划保存定义和值，DTO 从不包含凭据。
use crate::atomicfile::{self, unsafe_parent, FileState, ReadError, Snapshot};
use crate::discovery::Env;
use crate::fs::normalize;
use crate::jsonedit::{self, Layout, NoDuplicates};
use crate::models::{AutoRun, Harness};
use crate::redact::{has_key_shaped, secretish, url_without_secrets};
use agents::Dialect;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

mod agents;
#[cfg(test)]
mod batch1_tests;
mod define;
#[cfg(test)]
mod helper_tests;
mod keep;
#[cfg(test)]
mod keyhint_scope_tests;
#[cfg(test)]
mod keyhint_tests;
mod keyhints;
#[cfg(test)]
mod kimi_tests;
#[cfg(test)]
mod mirror_tests;
mod patch;
#[cfg(test)]
mod patch_tests;
mod removal;
pub mod sources;
#[cfg(feature = "weiboap")]
mod weiboap;
#[cfg(test)]
mod workbuddy_tests;

pub use define::{check_targets, parse_mcp_text, placeholder_fields, write_definitions};
pub use keep::{
    execute_keep, execute_keep_minding_keys, keep_key_hints, keep_revision, prepare_keep,
    prepare_keep_seen, McpKeepAction, McpKeepPlan,
};
pub use keyhints::{execute_minding_keys, ignore_targets, key_hints, McpKeyHint};
pub use removal::{
    execute_removal, prepare_original_removal, McpRemovalPlan, McpRemoveAction, McpRemoveItem,
};

/// 这个 agent 能不能出现在 MCP 页
pub fn supports(harness_id: &str) -> bool {
    agents::agent(harness_id).is_some()
}

/// 写进去以后要用户在它自己的界面里点「信任」才会连上的 agent，打开它用的应用标识（#256；记在 MCP agent 表里）。
/// 现在只有 WorkBuddy：别人写进 `mcp.json` 的条目它要用户批准；Sophia 不替用户点、不碰它的批准文件、不算它的指纹
pub fn trust_app(harness_id: &str) -> Option<&'static str> {
    agents::agent(harness_id).and_then(|agent| agent.trust_app)
}
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
    /// 写这个位置时要跟着写的附属文件（spec 2026-10-05-mcp-claude-3p）：Claude 桌面应用切进第三方模式后
    /// 读的是 `Claude-3p/` 下的另一份，添加、移除两份都写；矩阵状态仍只按 `path` 判断，这里的文件不扫描
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mirrors: Vec<PathBuf>,
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
/// 读入经 `McpAutoImportRuleFile` 迁移旧的整条 `excluded`；写出只有新结构
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "McpAutoImportRuleFile")]
pub struct McpAutoImportRule {
    pub source: McpLocationRef,
    pub target_domain: String,
    pub targets: Vec<McpLocationRef>,
    /// 按目标（位置 id）记的排除名单：在这个目标上不再自动写入的服务名。
    /// 按目标记，在一个位置排除只影响那一格，别的位置照常补（与 skill 的 `AutoLink` 同一修法）。
    /// 键可以不在 `targets` 里：目标撤掉后名单留着，再加回来仍然有效。空集合不留键
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub target_excluded: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    pub allow_cross_domain: bool,
    /// 建规则那一刻来源位置里已有的 MCP 名：规则只管之后新出现的，这些不补。
    /// `None` 只出现在升级前持久化的旧规则上——展开时整条跳过，
    /// 首次扫描由 `migrate_baselines` 取当时的全部名字补上
    #[serde(default)]
    pub baseline: Option<BTreeSet<String>>,
    /// 规则已生效之后才加进来的目标（位置 id）各自的 baseline：加进来那一刻来源里已有的名字。
    /// 新目标同样只管以后新出现的，不把建规则之后出现过的补写过去；不在表里的目标用整条的 `baseline`。
    /// 旧文件没有这个字段，读成空
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub target_baselines: BTreeMap<String, BTreeSet<String>>,
    /// 最近一次真正写进去了东西的自动执行（规则本身就按位置分条，不必再按位置记）。
    /// 一项没写进去的执行不记、不覆盖上一次（见 `record_auto_runs`）。旧文件没有这个字段，读成 `None`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_auto: Option<AutoRun>,
}

impl McpAutoImportRule {
    /// 这个服务在这个目标上是否被排除
    pub fn is_excluded(&self, target_id: &str, name: &str) -> bool {
        self.target_excluded
            .get(target_id)
            .is_some_and(|names| names.contains(name))
    }
}

/// `McpAutoImportRule` 在 settings.json 里的样子，只用于读：多认一个旧字段 `excluded`
/// （升级前整条规则共用一份排除名单）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpAutoImportRuleFile {
    source: McpLocationRef,
    target_domain: String,
    targets: Vec<McpLocationRef>,
    #[serde(default)]
    excluded: BTreeSet<String>,
    #[serde(default)]
    target_excluded: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    allow_cross_domain: bool,
    #[serde(default)]
    baseline: Option<BTreeSet<String>>,
    #[serde(default)]
    target_baselines: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    last_auto: Option<AutoRun>,
}

/// 旧的整条 `excluded` 按「对当时的所有目标都生效」拆进各目标的名单，老规则的行为不变。
/// 当时没有目标的规则没有可落的目标，这部分丢掉（没有目标的规则本来就什么都不写）
impl From<McpAutoImportRuleFile> for McpAutoImportRule {
    fn from(file: McpAutoImportRuleFile) -> Self {
        let mut target_excluded = file.target_excluded;
        if !file.excluded.is_empty() {
            for target in &file.targets {
                target_excluded
                    .entry(target.id.clone())
                    .or_default()
                    .extend(file.excluded.iter().cloned());
            }
        }
        target_excluded.retain(|_, names| !names.is_empty());
        McpAutoImportRule {
            source: file.source,
            target_domain: file.target_domain,
            targets: file.targets,
            target_excluded,
            allow_cross_domain: file.allow_cross_domain,
            baseline: file.baseline,
            target_baselines: file.target_baselines,
            last_auto: file.last_auto,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub source_id: String,
    pub name: String,
    pub transport: String,
    pub reason: Option<String>,
    /// 只有这几个 agent（harness id）接得住它；缺省＝谁都接得住（`reason` 为空时）。
    /// 目前只有用命令生成请求头的服务有：`["claude-code", "codex"]`。
    /// 接不住的那一列，格子是 `Unsupported`，`reason` 写「Cursor 不支持用命令生成请求头」
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_harnesses: Option<Vec<String>>,
    /// `reason` 说的是「不支持迁移字段 X」时的 X：界面上那一句说字段（`unportableText`），不从原因句里抠
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_field: Option<String>,
    pub cells: Vec<McpCell>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCell {
    pub target_id: String,
    pub state: McpCellState,
    pub reason: Option<String>,
    /// `reason` 是哪一种：前端按它判断（目标 agent 本身做不到、笼统的兜底句……），不比对中文句子
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_kind: Option<McpReasonKind>,
}
/// 格上原因句的种类（机器可读；句子本身经文案目录取，随语言变）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpReasonKind {
    /// 目标位置的配置无法解析或不安全（`invalid` 格）
    TargetUnreadable,
    /// 同一个 HTTP URL，但一边用命令生成请求头，无法静态确认一致
    SameUrlDynamicAuth,
    /// 同名服务的 URL 不一样
    UrlDiffers,
    /// 同名服务的配置不一样，说不清是哪个字段
    ConfigDiffers,
    /// 兜底：来源条目哪儿都搬不过去，没有更具体的原因
    SourceLossy,
    /// 兜底：目标里已有的同名条目没法比较
    TargetLossy,
    /// Claude Desktop 不收远程服务器（目标 agent 本身做不到）
    DesktopRemote,
    /// Claude Desktop 不展开 `${…}` 变量
    DesktopVariables,
    /// Gemini CLI 会展开 `$VAR`，别家的值写过去意思会变
    GeminiVariables,
    /// 目标 agent 不支持用命令生成请求头
    HeadersHelper,
    /// 带 `${…}` 变量的值只在同一家之间复制
    CrossAgentVariables,
    /// 目标 agent 不支持 SSE 传输（目标 agent 本身做不到）
    SseUnsupported,
    /// Codex 的客户端设置无法跨工具迁移
    CodexClientFields,
    /// 来源那一家的专属设置，目标里没有对应的写法
    ClientFields,
    /// 服务名不合目标 agent 的规矩（DeepSeek Harness：`[A-Za-z0-9_-]{1,32}`）
    ServerNameInvalid,
    /// 目标 agent 此刻接不住任何服务：DeepSeek Harness 桌面版还没打开过、没有补丁文件（目标 agent 本身的事）
    TargetNotReady,
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
    /// 每个位置（域 key）订阅着的、别的位置的来源 id：主视图把它们的全部服务也列成行。
    /// `scan` 不填，命令层按订阅记录填（见 `sources::attach`）；自己的位置不在里面
    #[serde(default)]
    pub subscribed: BTreeMap<String, Vec<String>>,
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

/// 新建或更新一条自动添加规则（同一来源 + 目标域即同一条）：目标集合整体换成 `targets`，
/// 跨域许可随之更新。规则从无到有（新建，或原先没有目标）时拍 baseline：来源位置此刻的
/// 全部 MCP 名，排除名单清空；已生效的规则改目标不重拍整条的 baseline，排除名单也保留，
/// 只给新加的目标单独拍一份（`target_baselines`）：新目标同样只管从它加进来起新出现的，
/// 不把建规则之后出现过的补写过去（与 skill 的 `upsert_auto_link` 同一修法）；撤掉的目标
/// 那一份随之丢掉。关掉（删规则）再开才重拍。
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
        return Err(crate::t!("mcp.auto.unreadableSource"));
    }
    let snapshot = || source_names(overview, &source.id);
    let existing = rules
        .iter()
        .position(|rule| rule.source.id == source.id && rule.target_domain == target_domain);
    match existing {
        Some(i) if !rules[i].targets.is_empty() => {
            let rule = &mut rules[i];
            rule.source = location_ref(source);
            for target in &targets {
                if !rule.targets.iter().any(|old| old.id == target.id) {
                    rule.target_baselines.insert(target.id.clone(), snapshot());
                }
            }
            rule.target_baselines
                .retain(|id, _| targets.iter().any(|target| &target.id == id));
            rule.targets = targets;
            rule.allow_cross_domain = allow_cross_domain;
            // 升级前的旧规则还没迁移：此刻迁移，与 `migrate_baselines` 同义
            rule.baseline.get_or_insert_with(snapshot);
        }
        _ => {
            rules.retain(|rule| rule.source.id != source.id || rule.target_domain != target_domain);
            rules.push(McpAutoImportRule {
                source: location_ref(source),
                target_domain,
                targets,
                target_excluded: BTreeMap::new(),
                allow_cross_domain,
                baseline: Some(snapshot()),
                target_baselines: BTreeMap::new(),
                last_auto: None,
            });
        }
    }
    Ok(())
}

/// 手动从这些位置拿掉了这些服务（移除副本、删原件，报告里 `removed` 的那几条）：凡是会往这个位置
/// 自动写入的规则，都在这个位置上排除这个名字。不记的话，紧接着的那轮扫描规则就把它写回去——
/// 提示条说「已移除」，格子却还是实心（与 skill 的 `skills::exclude` 同一修法）。返回是否改动过
pub fn exclude_removed(rules: &mut [McpAutoImportRule], report: &McpReport) -> bool {
    let mut changed = false;
    for entry in report.entries.iter().filter(|e| e.outcome == "removed") {
        for rule in rules
            .iter_mut()
            .filter(|r| r.targets.iter().any(|t| t.id == entry.target_id))
        {
            changed |= rule
                .target_excluded
                .entry(entry.target_id.clone())
                .or_default()
                .insert(entry.name.clone());
        }
    }
    changed
}

/// 手动写进了这些（报告里 `created` 的）：撤掉这些 (位置, 名字) 上的排除，规则照常接管。
/// 返回是否改动过
pub fn include_written(rules: &mut [McpAutoImportRule], report: &McpReport) -> bool {
    let mut changed = false;
    for entry in report.entries.iter().filter(|e| e.outcome == "created") {
        for rule in rules.iter_mut() {
            if let Some(names) = rule.target_excluded.get_mut(&entry.target_id) {
                changed |= names.remove(&entry.name);
                if names.is_empty() {
                    rule.target_excluded.remove(&entry.target_id);
                }
            }
        }
    }
    changed
}

/// 自动写入执行完，把真正写进去的（`created`）按规则记成最近一次执行（`last_auto`）。
/// 报告条目只有服务名与目标，来源从产出这批写入的动作 `actions`（`prepare` 的那份）里按
/// (服务名, 目标) 认；规则 = 这个来源、目标里有这一处的那条（规则按目标位置分条）。
/// 一项没写进去的规则不动，上一次的记录留着。返回是否改动过
pub fn record_auto_runs(
    rules: &mut [McpAutoImportRule],
    actions: &[McpAction],
    report: &McpReport,
    at_ms: u64,
) -> bool {
    let mut added: BTreeMap<usize, usize> = BTreeMap::new();
    for entry in report.entries.iter().filter(|e| e.outcome == "created") {
        let Some(action) = actions
            .iter()
            .find(|a| a.name == entry.name && a.target_id == entry.target_id)
        else {
            continue;
        };
        let Some(i) = rules.iter().position(|r| {
            r.source.id == action.source_id && r.targets.iter().any(|t| t.id == action.target_id)
        }) else {
            continue;
        };
        *added.entry(i).or_default() += 1;
    }
    for (&i, &n) in &added {
        rules[i].last_auto = Some(AutoRun {
            at: at_ms,
            added: n,
        });
    }
    !added.is_empty()
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
            let baseline = rule.target_baselines.get(&target.id).unwrap_or(baseline);
            for entry in overview.entries.iter().filter(|entry| {
                entry.source_id == source.id
                    && entry.reason.is_none()
                    && is_supported_transport(&entry.transport)
                    && !rule.is_excluded(&target.id, &entry.name)
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
    matches!(transport, "stdio" | "http" | "sse")
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
    /// 命令层把 `undo` 登记进内存后填的撤销 id；core 从不填。没有可撤销的写入时为 `None`。
    #[serde(default)]
    pub undo_id: Option<String>,
    /// 勾了「同时加进 .gitignore」、配置写成了，`.gitignore` 却没写成：整句原因（`mcp.report.gitignoreFailed`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gitignore_failed: Option<String>,
    /// 密钥提醒（移动 / 复制、自动同步规则）：来源被忽略，写成之后目标也自动加进了 `.gitignore`。
    /// 提示条在原因的位置接「已加进 .gitignore」
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_ignored: bool,
    /// 密钥提醒：像密钥的值第一次写进 git 仓库里的项目文件、没加进 `.gitignore`（`Remind` 而没勾；规则上没有勾选，
    /// 一律是这样）。自动同步的提示条在原因的位置接「密钥会随仓库提交，没加进 .gitignore」
    #[serde(default, skip_serializing_if = "is_false")]
    pub key_exposed: bool,
    /// `key_exposed` 里还能补加进 `.gitignore` 的目标（位置 id）：点格子写入的提示条据此给「加进 .gitignore」，
    /// 点了交给 `ignore_targets`（产品负责人 2026-10-06）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ignorable: Vec<String>,
    /// 密钥提醒：像密钥的值写进了已被 git 跟踪的项目文件（`Tracked`，加进 `.gitignore` 也挡不住）。
    /// 没问过用户的入口（点格子写入、自动同步规则）在提示条原因的位置接「密钥会随仓库提交（这个文件已在仓库里）」
    #[serde(default, skip_serializing_if = "is_false")]
    pub key_tracked: bool,
    /// `key_tracked` 是哪几个目标（位置 id）：「保留这份」的提示条按目标比对确认框里出过那一句的，
    /// 没出过的（检查之后才被跟踪）照样说（issue #147）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tracked_targets: Vec<String>,
    /// 命令层把 `gitignore_undo` 登记进内存后填的撤销 id：只撤这次追加进 `.gitignore` 的那几行。
    /// 移动的撤销不走写入的快照（见前端 `applyScopeChange`），所以和配置的撤销分开记
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gitignore_undo_id: Option<String>,
    /// 撤销记录含写前内容与写后指纹，不出进程：命令层用 `take_undo` 取走后只把 id 交给前端。
    #[serde(skip)]
    undo: McpUndo,
    /// `execute_minding_keys` 追加 `.gitignore` 的撤销记录（`take_gitignore_undo`）
    #[serde(skip)]
    gitignore_undo: McpUndo,
}

impl McpReport {
    /// 取走本次写入的撤销记录。没有写入任何文件，或有写入无法撤销（如 WeiboAP 数据库、
    /// 写后读回对不上）时返回 `None`：宁可不给撤销，也不给只撤一半的撤销。
    pub fn take_undo(&mut self) -> Option<McpUndo> {
        let undo = std::mem::take(&mut self.undo);
        (!undo.blocked && !undo.files.is_empty()).then_some(undo)
    }

    /// 取走这次追加 `.gitignore` 的撤销记录（`execute_minding_keys`）；没追加过或撤不了时为 `None`
    pub fn take_gitignore_undo(&mut self) -> Option<McpUndo> {
        let undo = std::mem::take(&mut self.gitignore_undo);
        (!undo.blocked && !undo.files.is_empty()).then_some(undo)
    }
}

/// 一次 MCP 写入（可能跨多个文件）的撤销记录。只能由 `execute` 产生，调用方无法伪造路径。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct McpUndo {
    files: Vec<UndoFile>,
    blocked: bool,
    /// 撤之前要核对的配置位置与它写前带密钥的服务名（只有追加 `.gitignore` 的撤销有）：撤掉忽略那一行之前，
    /// 这个配置里不能有写前没有的、带密钥的服务——比如之后自动同步规则又往里写了一个（那时目标已被忽略，没提醒）。
    /// 有就整体拒绝，那一行留着
    key_guards: Vec<(McpLocation, BTreeSet<String>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UndoFile {
    target: PathBuf,
    /// 写前状态：`Missing` 表示这次写入新建了文件，撤销即删掉它
    before: FileState,
    backup_path: Option<PathBuf>,
    /// 写后立刻读回的状态；撤销前磁盘必须仍与它一致
    written: FileState,
}

impl McpUndo {
    /// 记下一次附带的改写（密钥提醒追加 `.gitignore`），撤销时与配置一起退回。同一个文件这次已记过的
    /// （两个目标往同一个 `.gitignore` 各加一行）只更新写后状态，写前与备份留最早那一份；读回对不上就不给撤销
    pub(crate) fn record_edit(&mut self, edit: crate::keyhint::GitignoreEdit) {
        let Some(written) = edit.written else {
            self.blocked = true;
            return;
        };
        match self.files.iter_mut().find(|file| file.target == edit.path) {
            Some(file) => file.written = written,
            None => self.files.push(UndoFile {
                target: edit.path,
                before: edit.before,
                backup_path: edit.backup,
                written,
            }),
        }
    }

    /// 撤之前核对 `location` 里带密钥的服务仍在 `keyed`（写前就有的）之内（见 `key_guards`）
    pub(crate) fn guard_keys(&mut self, location: McpLocation, keyed: BTreeSet<String>) {
        if !self.key_guards.iter().any(|(old, _)| old.id == location.id) {
            self.key_guards.push((location, keyed));
        }
    }

    /// 这次写入涉及的目标文件；命令层据此让同一文件的旧撤销记录失效。
    pub fn target_paths(&self) -> impl Iterator<Item = &Path> {
        self.files.iter().map(|file| file.target.as_path())
    }
}

/// 撤销的整体结果。`changed` 时一个文件都没动。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUndoReport {
    /// `undone`：全部还原；`changed`：有文件写后又被改过，整体拒绝、未动任何文件；
    /// `failed`：校验通过但还原途中出错，可能只还原了一部分，逐文件看 `files`
    pub outcome: String,
    /// `failed` 时是没还原成的那个文件的一句（说得出原因的原因，否则兜底句）
    pub message: String,
    /// 没还原成、又分不出原因时：系统原文（去隐私）。给了就说明 `message` 是兜底句，提示条只写失败句
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub files: Vec<McpUndoFileResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUndoFileResult {
    pub target_path: PathBuf,
    /// 写入前留下的备份（在 Sophia 的备份目录里，见 `atomicfile::backup`）；新建文件的写入没有备份。撤不了时前端据此「在访达中显示备份」
    pub backup_path: Option<PathBuf>,
    /// `restored` / `removed` / `changed`（写后被改过）/ `unchanged`（没被改过，但因别的文件被改过而未动）
    /// / `failed` / `skipped`（前面的文件失败后未尝试）
    pub outcome: String,
    pub message: String,
    /// `failed` 又分不出原因时的系统原文（去隐私），同 `McpReportEntry::detail`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn undo_changed_message() -> String {
    crate::t!("mcp.undo.fileChangedSince")
}

/// 撤销一次 MCP 写入：先逐个确认所有目标仍是写后的样子，任何一个对不上就整体拒绝；
/// 全部对得上再逐个还原（原有文件经 `atomicfile::atomic_write` 写回写前内容，新建的文件删掉，
/// 不删父目录）。多文件无法原子地一起还原，途中失败会停下并逐文件报告。
pub fn undo_write(undo: &McpUndo) -> McpUndoReport {
    let result = |file: &UndoFile, outcome: &str, message: String| McpUndoFileResult {
        target_path: file.target.clone(),
        backup_path: file.backup_path.clone(),
        outcome: outcome.into(),
        message,
        detail: None,
    };
    let keys_added = undo.key_guards.iter().any(|(location, keyed)| {
        let parsed = parse(location);
        parsed.issue.is_some()
            || parsed
                .values
                .iter()
                .any(|(name, def)| has_key_values(def) && !keyed.contains(name))
    });
    if keys_added {
        let message = crate::t!("mcp.undo.keysAddedSince");
        return McpUndoReport {
            outcome: "changed".into(),
            message: message.clone(),
            detail: None,
            files: undo
                .files
                .iter()
                .map(|file| result(file, "changed", message.clone()))
                .collect(),
        };
    }
    let unchanged: Vec<bool> = undo
        .files
        .iter()
        .map(|file| atomicfile::same(&file.target, &file.written))
        .collect();
    if unchanged.iter().any(|ok| !ok) {
        return McpUndoReport {
            outcome: "changed".into(),
            message: undo_changed_message(),
            detail: None,
            files: undo
                .files
                .iter()
                .zip(&unchanged)
                .map(|(file, ok)| {
                    if *ok {
                        result(file, "unchanged", crate::t!("mcp.undo.unchangedByOthers"))
                    } else {
                        result(file, "changed", undo_changed_message())
                    }
                })
                .collect(),
        };
    }
    let mut files = Vec::new();
    let mut failed = false;
    for file in &undo.files {
        if failed {
            files.push(result(
                file,
                "skipped",
                crate::t!("mcp.undo.skippedAfterFailure"),
            ));
            continue;
        }
        let restored = match &file.before {
            FileState::Present(snap) => {
                atomicfile::atomic_write(&file.target, &snap.bytes, &file.written)
                    .map(|_| ("restored", crate::t!("mcp.undo.restored")))
            }
            FileState::Missing => remove_created(&file.target, &file.written)
                .map(|_| ("removed", crate::t!("mcp.undo.removedCreated"))),
        };
        match restored {
            Ok((outcome, message)) => files.push(result(file, outcome, message)),
            Err(error) if error.to_string() == "changed" => {
                failed = true;
                files.push(result(file, "changed", undo_changed_message()));
            }
            Err(error) => {
                failed = true;
                // 磁盘满、没权限、只读说人话；分不出原因的兜底句 + 原文（进日志，也给 `detail`）
                let (message, detail) =
                    write_failed(&file.target, &error, || crate::t!("mcp.undo.fileFailed"));
                let mut one = result(file, "failed", message);
                one.detail = detail;
                files.push(one);
            }
        }
    }
    // 没还原成的那一个文件的一句与原文：前端「撤销失败 · 原因」，分不出原因只写失败句（spec #239「出错的时候」）
    let stopped = files
        .iter()
        .find(|file| matches!(file.outcome.as_str(), "failed" | "changed"));
    McpUndoReport {
        outcome: if failed { "failed" } else { "undone" }.into(),
        message: stopped.map_or_else(|| crate::t!("mcp.undo.done"), |file| file.message.clone()),
        detail: stopped.and_then(|file| file.detail.clone()),
        files,
    }
}

/// 这个配置位置此刻带「像密钥的值」的服务名（读不出的为空）
pub(super) fn keyed_names(location: &McpLocation) -> BTreeSet<String> {
    parse(location)
        .values
        .into_iter()
        .filter(|(_, def)| has_key_values(def))
        .map(|(name, _)| name)
        .collect()
}

/// 删掉这次写入新建的文件：删前紧挨着再校验一次仍是写后的样子（`read_state` 拒绝软链接）。
fn remove_created(path: &Path, written: &FileState) -> io::Result<()> {
    atomicfile::safe_parent(path)?;
    if !atomicfile::same(path, written) {
        return Err(io::Error::other("changed"));
    }
    fs::remove_file(path)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReportEntry {
    pub name: String,
    pub target_id: String,
    pub outcome: String,
    pub message: String,
    pub backup_path: Option<PathBuf>,
    /// 这一条写成了，但它的镜像文件（Claude Desktop 第三方模式那一份，`McpLocation::mirrors`）没写成：
    /// 整句原因（`mcp.report.mirrorFailed`）。前端在成功条目下用失败原因的样式显示它；没有镜像或镜像也成了为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror_failed: Option<String>,
    /// 写成了、另有一句要交代的（不是失败）：DeepSeek Harness 另有全机补丁时说明以哪一个为准
    /// （`mcp.report.dshGlobalPatch`）。前端接在成功句后面（提示条的 `trail`）；没有为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 没写成、又分不出原因时（spec #239 第 43 条）：系统原文（去隐私）。给了就说明 `message` 是兜底句
    /// （`原子写入失败`），不是给人看的原因——提示条只写失败句，原文同时进日志
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
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
    /// 用命令生成请求头：命令往标准输出写一个「请求头名 → 字符串」的 JSON 对象。
    /// Codex 叫 `http_headers_helper`、Claude Code 叫 `headersHelper`，两家都用 `sh -c` 跑，
    /// 语义一致，只在这两家之间搬（见 `HELPER_HARNESSES`）。只出现在 HTTP 定义上
    pub(super) headers_helper: Option<String>,
    /// 原样搬的那一段（只在写入计划里填，扫描读出来的一律 None）：见 `RawServer`
    pub(super) raw: Option<RawServer>,
    /// `reason` 说的是「不支持迁移字段 X」时的 X：原样搬（`raw_server`）与界面上那一句按它判断，
    /// 不从换了语言的原因句里抠
    pub(super) unknown_field: Option<String>,
}

/// 同一家、同一种写法之间原样搬（spec 2026-09-30-mcp-config-scope R7；产品负责人：computer-use 从用户级的
/// Codex 搬到项目的 Codex，「这种不就是要解决的问题吗……不想全局加载，只想在项目加载」）：条目只因为带着
/// Sophia 不认识的字段而翻译不了（去掉那几个字段其余都合规，见 `raw_server`）时，写到同一个 agent、同一种
/// 写法的配置里就把整段原样搬过去，不经 `Canonical` 重新拼。JSON 存紧凑文本，TOML 存去掉装饰的内联表文本
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RawServer {
    Json(String),
    Toml(String),
}

/// 认得「用命令生成请求头」的 agent（harness id）。别的 agent 无法写入这种定义：
/// 丢掉命令就是一份没有凭据的坏配置，所以整条拒绝，不静默丢字段
const HELPER_HARNESSES: [&str; 2] = ["claude-code", "codex"];

/// 句子里的 agent 名：位置名里 agent 那一段（`Claude Code · Local MCPs` → `Claude Code`）；
/// Claude Desktop 按界面语言说（简体「Claude 桌面应用」，spec #239 第 48 条）
fn agent_name(location: &McpLocation) -> String {
    if location.harness_id == "claude-desktop" {
        return agents::desktop_name();
    }
    location
        .label
        .split(" · ")
        .next()
        .unwrap_or(&location.label)
        .to_owned()
}

impl Canonical {
    fn connection_eq(&self, other: &Self) -> bool {
        self.transport == other.transport
            && self.command == other.command
            && self.args == other.args
            && self.env == other.env
            && self.url == other.url
            && headers_eq(&self.headers, &other.headers)
            && self.headers_helper == other.headers_helper
            && !self.unsupported
            && !other.unsupported
    }

    /// 只有 `HELPER_HARNESSES` 里的 agent 接得住时为这几家；谁都接得住（或哪儿都搬不过去）为 None。
    /// 扫描按目标 agent 逐家判（`accepting`），这里只剩测试在用
    #[cfg(test)]
    pub(super) fn only_harnesses(&self) -> Option<Vec<String>> {
        (self.headers_helper.is_some() && !self.unsupported)
            .then(|| HELPER_HARNESSES.iter().map(|h| h.to_string()).collect())
    }

    /// 同一个 URL，恰好一边用命令生成请求头：命令运行时写出什么没法静态确认，
    /// 与另一边的静态请求头比不出一不一样。两边都用命令的照常比（命令字符串相同即相同）
    fn same_endpoint_with_dynamic_auth(&self, other: &Self) -> bool {
        self.mixed_dynamic_auth(other) && self.url == other.url
    }

    fn different_endpoint_with_dynamic_auth(&self, other: &Self) -> bool {
        self.mixed_dynamic_auth(other) && self.url != other.url
    }

    fn mixed_dynamic_auth(&self, other: &Self) -> bool {
        self.has_comparable_http_endpoint()
            && other.has_comparable_http_endpoint()
            && self.headers_helper.is_some() != other.headers_helper.is_some()
    }

    fn has_comparable_http_endpoint(&self) -> bool {
        self.transport == "http" && self.url.is_some() && !self.unsupported
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
    /// 这条是某个目标的镜像写入（`McpLocation::mirrors`，见 `with_mirrors`）：不进 `actions`，报告并进主条目
    pub(super) mirror: bool,
    /// 完全相同的重复选择合并成这一条时，其余来源的文件（几条规则把同一份写进同一个目标）：密钥提醒按全部来源判断，
    /// 不因合并丢掉某个来源被忽略的事实
    pub(super) also_from: Vec<PathBuf>,
}
#[derive(Debug)]
pub struct PreparedPlan {
    pub actions: Vec<McpAction>,
    pub issues: Vec<McpIssue>,
    private: Vec<Pending>,
    /// 计划时就知道写不成的镜像写入（镜像里已有同名但不同的定义），执行时与别的镜像失败一样并进主条目
    mirror_failures: Vec<McpReportEntry>,
}

pub fn locations(env: &Env, harnesses: &[Harness], projects: &[PathBuf]) -> Vec<McpLocation> {
    discover_locations(env, harnesses, projects).locations
}

/// 发现 MCP 位置，同时保留无法安全解析的专用 harness 诊断。位置按 agent 表（`agents::AGENTS`）：
/// 用户级一处（这个平台上没有的不列），每个项目一处（没有项目级的不列）
pub fn discover_locations(env: &Env, harnesses: &[Harness], projects: &[PathBuf]) -> McpDiscovery {
    let mut out = Vec::new();
    for (h, agent) in harnesses
        .iter()
        .filter_map(|h| agents::agent(&h.id).map(|agent| (h, agent)))
    {
        if let Some(path) = agent.user_path(env) {
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
                mirrors: agent.user_mirrors(env),
            });
        }
        let Some(relative) = agent.project else {
            continue;
        };
        for project in projects {
            let domain = normalize(project).to_string_lossy().into_owned();
            // Claude 将 projects 的 key 作为作用域身份，不按路径等价或前缀猜测。
            let project_key = project.to_string_lossy().into_owned();
            let path = project.join(relative);
            if h.id == "claude-code" {
                let claude = env.home.join(".claude.json");
                // 本地配置总是列出：项目在 ~/.claude.json 里还没有 projects.<路径> 时，
                // 写入会建出来（merge_claude_local_json）；文件本身无法解析时也列出，
                // 由 scan / 写入报无效。两处 matrix_hidden 恒为 false，是否藏列交给前端按 agent 列决定
                out.push(McpLocation {
                    id: format!("project:{domain}::claude-code:local"),
                    label: "Claude Code · Local MCPs".into(),
                    harness_id: h.id.clone(),
                    domain: format!("project:{domain}"),
                    path: claude,
                    selector: Some(project_key),
                    matrix_hidden: false,
                    mirrors: Vec::new(),
                });
                out.push(McpLocation {
                    id: format!("project:{domain}::{}", h.id),
                    label: "Claude Code · Project MCPs".into(),
                    harness_id: h.id.clone(),
                    domain: format!("project:{domain}"),
                    path,
                    selector: None,
                    matrix_hidden: false,
                    mirrors: Vec::new(),
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
                    mirrors: Vec::new(),
                });
            }
        }
    }
    // 软链接的设置文件改它指向的真实文件（spec 2026-10-05-mcp-symlink-config R1）：之后扫描、写入、备份都按真实路径。
    // 只对上面这些普通位置做：WeiboAP 的数据库位置有自己的目录规则（模式检查、备份都按原目录），不解析
    for location in &mut out {
        location.path = resolve_symlinks(&location.path);
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

/// 路径里有软链接（文件本身或某一级父目录）就换成解析后的真实路径；文件还不存在时解析它的父目录（父目录是软链接、
/// 第一次写入也要落到真实目录）；解析不出（坏链）或没有软链接就原样。
/// 两种不换：macOS 的 `/var`、`/tmp`、`/etc` 本身是指向 `/private/…` 的软链接（项目可能放在 /tmp 下），不算用户的
/// 软链接，换了之后路径和用户看到的、项目记录里的对不上；文件名的扩展名变了（`config.toml → codex-config`）也不换，
/// 读写按扩展名分 JSON / TOML，换了会认错格式。只在 Unix 上做：Windows 的 canonicalize 会带 `\\?\` 前缀，
/// 比不出有没有软链接，而且 Windows 还没验证过
fn resolve_symlinks(path: &Path) -> PathBuf {
    if !cfg!(unix) {
        return path.to_path_buf();
    }
    let normalized = normalize(path);
    // 文件或它的某几级父目录还不存在：解析最近的那一级存在的祖先，再把缺的几段拼回去
    // （项目本身是软链接、里面还没有 .cursor 时，第一次写入也要落到真实项目里）
    let real = crate::fs::real_path(path).or_else(|| {
        let mut missing = Vec::new();
        let mut ancestor = path.parent()?;
        missing.push(path.file_name()?);
        loop {
            if let Some(real) = crate::fs::real_path(ancestor) {
                return Some(missing.iter().rev().fold(real, |acc, part| acc.join(part)));
            }
            missing.push(ancestor.file_name()?);
            ancestor = ancestor.parent()?;
        }
    });
    match real {
        Some(real)
            if real != normalized
                && !only_private_prefix(&real, &normalized)
                && real.extension() == path.extension() =>
        {
            real
        }
        _ => path.to_path_buf(),
    }
}

/// `real` 只比 `normalized` 多了 macOS 的 `/private` 前缀
fn only_private_prefix(real: &Path, normalized: &Path) -> bool {
    cfg!(target_os = "macos")
        && normalized
            .strip_prefix("/")
            .is_ok_and(|rest| real == Path::new("/private").join(rest))
}

/// 同一个 agent、同一种写法（原样搬的前提，见 `RawServer`）
fn same_dialect(a: &McpLocation, b: &McpLocation) -> bool {
    a.harness_id == b.harness_id && agents::dialect_of(a) == agents::dialect_of(b)
}

/// 这条服务能不能原样搬、原样是哪一段：只因为带着不认识的字段而翻译不了（一个个去掉报出来的字段，
/// 其余都合规）才给；本来就翻译得了的、去掉之后仍不合规的（类型不对、传输分不出）都是 None。
/// 从来源文件的原文取，不经 `Canonical`
fn raw_server(location: &McpLocation, state: &State, name: &str) -> Option<RawServer> {
    let State::Present(snap) = state else {
        return None;
    };
    /// 一个个去掉报出来的不认识字段，直到其余都合规；去掉了至少一个才算
    fn strip_unknown(
        has: impl Fn(&str) -> bool,
        canon_without: impl Fn(&[String]) -> Canonical,
    ) -> bool {
        let mut keys: Vec<String> = Vec::new();
        loop {
            let def = canon_without(&keys);
            if !def.unsupported {
                return !keys.is_empty();
            }
            let Some(key) = def.unknown_field.clone() else {
                return false;
            };
            if keys.contains(&key) || !has(&key) {
                return false;
            }
            keys.push(key);
        }
    }
    if toml(&location.path) {
        let doc = std::str::from_utf8(&snap.bytes)
            .ok()?
            .parse::<toml_edit::DocumentMut>()
            .ok()?;
        let table = match doc.get("mcp_servers")?.as_table_like()?.get(name)? {
            toml_edit::Item::Table(table) => table.clone().into_inline_table(),
            toml_edit::Item::Value(toml_edit::Value::InlineTable(table)) => table.clone(),
            _ => return None,
        };
        let ok = strip_unknown(
            |key| table.contains_key(key),
            |keys| {
                let mut stripped = table.clone();
                for key in keys {
                    stripped.remove(key);
                }
                canon_toml(&toml_edit::Item::Value(stripped.into()))
            },
        );
        if !ok {
            return None;
        }
        // 去掉行尾注释、对齐空格这类装饰，值原样
        let mut clean = toml_edit::InlineTable::new();
        for (key, value) in table.iter() {
            let mut value = value.clone();
            value.decor_mut().clear();
            clean.insert(key, value);
        }
        Some(RawServer::Toml(clean.to_string()))
    } else {
        let root: Value = serde_json::from_slice(&snap.bytes).ok()?;
        let servers = match location.selector.as_deref() {
            Some(project) => root.get("projects")?.get(project)?.get("mcpServers")?,
            None => root.get("mcpServers")?,
        };
        let value = servers.get(name)?;
        let object = value.as_object()?;
        let dialect = agents::dialect_of(location);
        let ok = strip_unknown(
            |key| object.contains_key(key),
            |keys| {
                let mut stripped = object.clone();
                for key in keys {
                    stripped.remove(key);
                }
                canon_by(&Value::Object(stripped), dialect)
            },
        );
        if !ok {
            return None;
        }
        Some(RawServer::Json(serde_json::to_string(value).ok()?))
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
                only_harnesses: def.accepting(location),
                unsupported_field: def.unknown_field.clone(),
                cells: Vec::new(),
            });
        }
    }
    for entry in &mut entries {
        let (source_location, source, source_state) = parsed
            .iter()
            .find(|(location, _)| location.id == entry.source_id)
            .and_then(|(location, value)| {
                Some((*location, value.values.get(&entry.name)?, &value.state))
            })
            .expect("source exists");
        // 只因为带着不认识的字段而翻译不了：同一家同一种写法之间原样搬（`RawServer`）
        let raw_ok =
            source.unsupported && raw_server(source_location, source_state, &entry.name).is_some();
        for (target, value) in &parsed {
            let verbatim = raw_ok && same_dialect(source_location, target);
            use McpReasonKind as K;
            let (state, why) = if target.id == entry.source_id {
                (McpCellState::Own, None)
            } else if value.issue.is_some() {
                (
                    McpCellState::Invalid,
                    Some((
                        K::TargetUnreadable,
                        crate::t!("mcp.reason.targetUnreadable"),
                    )),
                )
            } else {
                match value.values.get(&entry.name) {
                    Some(def) if source.same_endpoint_with_dynamic_auth(def) => (
                        McpCellState::SameEndpoint,
                        Some((
                            K::SameUrlDynamicAuth,
                            crate::t!("mcp.reason.sameUrlDynamicAuth"),
                        )),
                    ),
                    Some(def) if source.different_endpoint_with_dynamic_auth(def) => (
                        McpCellState::Conflict,
                        Some((K::UrlDiffers, crate::t!("mcp.reason.urlDiffers"))),
                    ),
                    None if source.desktop_refusal(&target.harness_id).is_some() => (
                        McpCellState::Unsupported,
                        source.desktop_refusal(&target.harness_id),
                    ),
                    _ if source.unsupported && !verbatim => (
                        McpCellState::Unsupported,
                        Some((K::SourceLossy, crate::t!("mcp.cell.genericSource"))),
                    ),
                    None => match agents::not_ready(target, &value.state)
                        .or_else(|| agents::name_refusal(&target.harness_id, &entry.name))
                        .or_else(|| source.refusal_for_kind(source_location, target))
                    {
                        Some(refusal) => (McpCellState::Unsupported, Some(refusal)),
                        None => (McpCellState::Missing, None),
                    },
                    Some(def) if def.unsupported => (
                        McpCellState::Unsupported,
                        Some((K::TargetLossy, crate::t!("mcp.cell.genericTarget"))),
                    ),
                    Some(def) if def.connection_eq(source) => (McpCellState::Equal, None),
                    Some(_) => (
                        McpCellState::Conflict,
                        Some((K::ConfigDiffers, crate::t!("mcp.reason.configDiffers"))),
                    ),
                }
            };
            let (reason_kind, reason) = match why {
                Some((kind, reason)) => (Some(kind), Some(reason)),
                None => (None, None),
            };
            entry.cells.push(McpCell {
                target_id: target.id.clone(),
                state,
                reason,
                reason_kind,
            });
        }
    }
    McpOverview {
        locations: locations.to_vec(),
        entries,
        issues,
        subscribed: BTreeMap::new(),
    }
}

/// 字段级差异里的一格：某个位置上这个字段的值。**凭据不出 core**：请求头与环境变量的值、
/// URL 查询串与 `#` 片段的值、账号密码、紧跟在 key / token 类参数后面的值、参数里的请求头行与
/// `Bearer …`，一律只给「不同」与末 4 位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpFieldValue {
    /// 可以原样显示的值（命令、参数、去掉查询值的 URL、传输方式）
    Plain { text: String },
    /// 凭据：只给末 4 位；值太短（末 4 位就等于泄露大半）时为 None
    Secret { last4: Option<String> },
    /// 这个位置上没有这个字段
    Absent,
}

/// 一个不一样的字段：`values` 与请求的位置一一对应、同序
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFieldDiff {
    /// `url` `command` `args` `transport` `headersHelper` `env.NAME` `headers.Name`
    pub field: String,
    pub values: Vec<McpFieldValue>,
}

/// 同名服务在几个位置上的字段级差异（主视图该行「N 份不一样」就地展开）。只读，不改任何文件
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiff {
    pub name: String,
    /// 与请求同序；找不到的位置照样占一列，值全是 Absent
    pub location_ids: Vec<String>,
    /// 只列不同的字段；相同的不出现
    pub fields: Vec<McpFieldDiff>,
    /// 有的位置用命令生成请求头、有的没有：那几份的认证头要到运行时才生成，请求头没法逐字比对，
    /// `headers.*` 整组不列。全都用命令的不算（命令与静态请求头照常逐项比）
    pub dynamic_auth: bool,
    /// 读不出来、或这一份用了没法逐项比较的写法的位置
    pub unreadable: Vec<String>,
    /// 与 `location_ids` 一一对应：「保留这份」（以这一份为准改写其余几份）做不成时，挡住它的第一处与原因；
    /// 做得成为 None。与 `prepare_keep` 同一套判断（一处接不住整次不动）
    pub keep_blocked: Vec<Option<McpIssue>>,
    /// 这几处定义此刻的指纹（`keep_revision`）：「保留这份」确认后带回来，用户看过之后谁被改了就不动
    pub revision: String,
}

/// 值是不是只含引用（`${TOKEN}`）：引用本身不是凭据，可以原样显示
fn secret_value(value: &str) -> McpFieldValue {
    if reference(value) && !value.contains(char::is_whitespace) {
        return McpFieldValue::Plain {
            text: value.to_owned(),
        };
    }
    let chars: Vec<char> = value.chars().collect();
    // 短于 12 个字符时末 4 位占去三分之一以上，宁可不给
    let last4 = (chars.len() >= 12).then(|| chars[chars.len() - 4..].iter().collect());
    McpFieldValue::Secret { last4 }
}

/// 参数串是纯文本，凭据按 `secret_value` 的规则嵌进去：`…` 加末 4 位，太短只给 `…`
fn masked_text(value: &str) -> String {
    match secret_value(value.trim()) {
        McpFieldValue::Plain { text } => text,
        McpFieldValue::Secret { last4: Some(last4) } => format!("…{last4}"),
        _ => "…".to_owned(),
    }
}

/// 请求头行 `Name: value`：请求头的值在别处一律脱敏，这里也一样，名字留着
fn masked_header_line(line: &str) -> String {
    match line.split_once(':') {
        Some((name, value)) => format!("{name}: {}", masked_text(value)),
        None => masked_text(line),
    }
}

/// 单个参数自身带凭据：`Authorization: Bearer x`、`API_KEY=x`（名字像凭据）、裸的 `Bearer x`
fn arg_without_secrets(arg: &str) -> String {
    if arg.contains("://") {
        return url_without_secrets(arg);
    }
    if let Some(token) = arg
        .strip_prefix("Bearer ")
        .or_else(|| arg.strip_prefix("bearer "))
    {
        return format!("Bearer {}", masked_text(token));
    }
    let named = |sep: char| {
        arg.split_once(sep).filter(|(name, _)| {
            !name.is_empty() && !name.contains(char::is_whitespace) && secretish(name)
        })
    };
    if let Some((name, value)) = named(':') {
        return format!("{name}: {}", masked_text(value));
    }
    if let Some((name, value)) = named('=') {
        return format!("{name}={}", masked_text(value));
    }
    arg.to_owned()
}

fn header_flag(flag: &str) -> bool {
    flag == "-H" || flag.eq_ignore_ascii_case("--header")
}

/// 参数里的凭据：`--api-key xyz` 的 xyz、`--token=xyz` 的 xyz 换成 `…`；`--header` / `-H`
/// 后面（或与 `-H` 连写）的请求头行只留名字；参数自身像凭据的（见 `arg_without_secrets`）按末 4 位规则脱敏
fn args_without_secrets(args: &[String]) -> String {
    enum Next {
        Plain,
        Hide,
        Header,
    }
    let mut out = Vec::with_capacity(args.len());
    let mut next = Next::Plain;
    for arg in args {
        match std::mem::replace(&mut next, Next::Plain) {
            Next::Hide => {
                out.push("…".to_owned());
                continue;
            }
            Next::Header => {
                out.push(masked_header_line(arg));
                continue;
            }
            Next::Plain => {}
        }
        // 连写的 `-HAuthorization: …`：要在按 `=` 拆之前认出来，否则值里的 `=` 会把凭据切进「键」里
        if let Some(line) = arg
            .strip_prefix("-H")
            .filter(|line| !line.is_empty() && !line.starts_with('='))
        {
            out.push(format!("-H{}", masked_header_line(line)));
            continue;
        }
        match arg.split_once('=') {
            Some((key, line)) if header_flag(key) => {
                out.push(format!("{key}={}", masked_header_line(line)))
            }
            Some((key, _)) if key.starts_with('-') && secretish(key) => {
                out.push(format!("{key}=…"))
            }
            _ if header_flag(arg) => {
                next = Next::Header;
                out.push(arg.clone());
            }
            _ if arg.starts_with('-') && secretish(arg) => {
                next = Next::Hide;
                out.push(arg.clone());
            }
            _ => out.push(arg_without_secrets(arg)),
        }
    }
    out.join(" ")
}

/// 行详情里 `命令` 或 `地址` 那一行（DESIGN「位置页 › 表格 › 点名字展开」MCP 键值三行）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
    /// `command`（stdio：命令 + 参数）或 `url`（HTTP：地址）
    pub kind: String,
    /// 显示用的值：参数里的凭据、地址查询里的凭据都已脱敏（同 `diff_fields`），DTO 里不含凭据原文
    pub text: String,
}

/// 服务 `name` 在 `location_id` 这一处的定义怎么连：stdio 给命令 + 参数，HTTP 给地址。只读。
/// 这一处不在、没有这个名字、或写法读不出来（传输记作 unsupported）时为 None——行详情那一行就不写
pub fn endpoint(locations: &[McpLocation], name: &str, location_id: &str) -> Option<McpEndpoint> {
    let def = locations
        .iter()
        .find(|location| location.id == location_id)
        .map(parse)
        .and_then(|parsed| parsed.values.get(name).cloned())?;
    if def.transport == "unsupported" {
        return None;
    }
    if let Some(url) = def.url.as_deref() {
        return Some(McpEndpoint {
            kind: "url".into(),
            text: url_without_secrets(url),
        });
    }
    let command = def.command.as_deref()?;
    let text = if def.args.is_empty() {
        command.to_owned()
    } else {
        format!("{command} {}", args_without_secrets(&def.args))
    };
    Some(McpEndpoint {
        kind: "command".into(),
        text,
    })
}

/// 同名服务 `name` 在 `location_ids` 这几个位置上哪些字段不一样。
///
/// 比较的是**原值**（凭据也按原值比，不一样才列），显示的是脱敏后的值；DTO 里不含任何凭据原文。
/// 请求头名大小写不敏感（与 `headers_eq` 同规则），显示取第一个有它的位置的写法。
pub fn diff_fields(locations: &[McpLocation], name: &str, location_ids: &[String]) -> McpDiff {
    let mut unreadable = Vec::new();
    let defs: Vec<Option<Canonical>> = location_ids
        .iter()
        .map(|id| {
            let def = locations
                .iter()
                .find(|location| &location.id == id)
                .map(parse)
                .and_then(|parsed| parsed.values.get(name).cloned());
            match def {
                // 「没法无损迁移」的定义字段照样在（如变量引用）；只有连字段都
                // 取不出来的（`unsupported_with`，传输记作 unsupported）才算读不出来
                Some(def) if def.transport != "unsupported" => Some(def),
                _ => {
                    unreadable.push(id.clone());
                    None
                }
            }
        })
        .collect();
    // 恰好一部分用命令生成请求头：那几份的请求头要到运行时才有，和别处的静态请求头逐字比没有意义。
    // 全都用命令的照常比（命令字符串 + 静态请求头）
    let dynamic_auth = {
        let mut helpers = defs
            .iter()
            .flatten()
            .map(|def| def.headers_helper.is_some());
        let first = helpers.next();
        first.is_some_and(|first| helpers.any(|other| other != first))
    };

    // (字段名, 比较用的原值, 显示用的值)；None = 这一处没有这个字段
    type Cell = Option<(String, McpFieldValue)>;
    let mut rows: Vec<(String, Vec<Cell>)> = Vec::new();
    // 读不出来的位置照样占一列，但不参与比较：否则它会让每个字段都显得「不一样」
    let readable: Vec<bool> = defs.iter().map(Option::is_some).collect();
    let mut push = |field: String, cells: Vec<Cell>| {
        let mut raws = cells
            .iter()
            .zip(&readable)
            .filter(|(_, ok)| **ok)
            .map(|(c, _)| c.as_ref().map(|(raw, _)| raw));
        let first = raws.next();
        let all_same = raws.all(|raw| Some(raw) == first);
        if !all_same {
            rows.push((field, cells));
        }
    };
    let plain = |text: String| McpFieldValue::Plain { text };

    push(
        "transport".into(),
        defs.iter()
            .map(|d| {
                d.as_ref()
                    .map(|d| (d.transport.clone(), plain(d.transport.clone())))
            })
            .collect(),
    );
    push(
        "url".into(),
        defs.iter()
            .map(|d| {
                d.as_ref()
                    .and_then(|d| d.url.clone())
                    .map(|url| (url.clone(), plain(url_without_secrets(&url))))
            })
            .collect(),
    );
    push(
        "command".into(),
        defs.iter()
            .map(|d| {
                d.as_ref()
                    .and_then(|d| d.command.clone())
                    .map(|c| (c.clone(), plain(c)))
            })
            .collect(),
    );
    push(
        "args".into(),
        defs.iter()
            .map(|d| {
                d.as_ref()
                    .filter(|d| !d.args.is_empty())
                    .map(|d| (d.args.join("\u{1f}"), plain(args_without_secrets(&d.args))))
            })
            .collect(),
    );

    // 生成请求头的命令里可能直接嵌着令牌（`echo '{"Authorization":"Bearer …"}'`），按凭据脱敏
    push(
        "headersHelper".into(),
        defs.iter()
            .map(|d| {
                d.as_ref()
                    .and_then(|d| d.headers_helper.clone())
                    .map(|c| (c.clone(), secret_value(&c)))
            })
            .collect(),
    );

    // Gemini 专属写法里属于定义的两项（「保留这份」会跟着改它们，见 `keep.rs`）：`cwd` 原样显示，
    // `oauth` 里可能有客户端密钥，按凭据脱敏
    for (field, secret) in [("cwd", false), ("oauth", true)] {
        push(
            field.into(),
            defs.iter()
                .map(|d| {
                    d.as_ref()
                        .and_then(|d| d.client_fields.get(field).cloned())
                        .map(|raw| {
                            let shown = match serde_json::from_str::<Value>(&raw) {
                                _ if secret => secret_value(&raw),
                                Ok(Value::String(text)) => plain(text),
                                _ => plain(raw.clone()),
                            };
                            (raw, shown)
                        })
                })
                .collect(),
        );
    }

    let mut env_names = BTreeSet::new();
    for def in defs.iter().flatten() {
        env_names.extend(def.env.keys().cloned());
    }
    for key in env_names {
        push(
            format!("env.{key}"),
            defs.iter()
                .map(|d| {
                    d.as_ref()
                        .and_then(|d| d.env.get(&key))
                        .map(|v| (v.clone(), secret_value(v)))
                })
                .collect(),
        );
    }

    // 请求头：只有一部分用命令生成请求头时，那几份的静态请求头不完整，逐字比对没有意义，整组不列
    if !dynamic_auth {
        let mut header_names: Vec<String> = Vec::new();
        for def in defs.iter().flatten() {
            for header in def.headers.keys() {
                if !header_names.iter().any(|h| h.eq_ignore_ascii_case(header)) {
                    header_names.push(header.clone());
                }
            }
        }
        for header in header_names {
            push(
                format!("headers.{header}"),
                defs.iter()
                    .map(|d| {
                        d.as_ref()
                            .and_then(|d| {
                                d.headers
                                    .iter()
                                    .find(|(name, _)| name.eq_ignore_ascii_case(&header))
                            })
                            .map(|(_, v)| (v.clone(), secret_value(v)))
                    })
                    .collect(),
            );
        }
    }

    McpDiff {
        name: name.to_owned(),
        location_ids: location_ids.to_vec(),
        fields: rows
            .into_iter()
            .map(|(field, cells)| McpFieldDiff {
                field,
                values: cells
                    .into_iter()
                    .map(|c| c.map_or(McpFieldValue::Absent, |(_, shown)| shown))
                    .collect(),
            })
            .collect(),
        dynamic_auth,
        unreadable,
        keep_blocked: location_ids
            .iter()
            .map(|id| {
                prepare_keep(locations, name, id, location_ids)
                    .issues
                    .into_iter()
                    .next()
            })
            .collect(),
        revision: keep_revision(locations, name, location_ids),
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
            issues.push(issue(
                selection,
                crate::t!("mcp.issue.sourceOrTargetMissing"),
            ));
            continue;
        };
        let Some(definition) = source.values.get(&selection.name) else {
            issues.push(issue(selection, crate::t!("mcp.issue.sourceEntryMissing")));
            continue;
        };
        let mut definition = definition.clone();
        if !source.state.readable() {
            issues.push(issue(selection, crate::t!("mcp.issue.sourceUnreadable")));
            continue;
        }
        if let Some((_, reason)) = definition.desktop_refusal(&target_location.harness_id) {
            issues.push(issue(selection, reason));
            continue;
        }
        if source.issue.is_some() || definition.unsupported {
            // 只因为带着不认识的字段：同一家同一种写法之间原样搬（`RawServer`），别处照旧拒绝
            let raw = (source.issue.is_none() && same_dialect(source_location, target_location))
                .then(|| raw_server(source_location, &source.state, &selection.name))
                .flatten();
            let Some(raw) = raw else {
                issues.push(issue(
                    selection,
                    definition
                        .reason
                        .clone()
                        .unwrap_or_else(|| crate::t!("mcp.cell.genericSource")),
                ));
                continue;
            };
            definition.raw = Some(raw);
        }
        if target.issue.is_some() {
            issues.push(issue(selection, crate::t!("mcp.reason.targetUnreadable")));
            continue;
        }
        if unsafe_parent(&target_location.path) {
            issues.push(issue(selection, crate::t!("mcp.issue.parentSymlink")));
            continue;
        }
        if let Some(old) = target.values.get(&selection.name) {
            if old.unsupported {
                issues.push(issue(
                    selection,
                    old.reason
                        .clone()
                        .unwrap_or_else(|| crate::t!("mcp.issue.targetCannotCompare")),
                ));
                continue;
            }
            issues.push(issue(
                selection,
                if old.connection_eq(&definition) {
                    crate::t!("mcp.issue.targetSame")
                } else {
                    crate::t!("mcp.issue.targetConflict")
                },
            ));
            continue;
        }
        // 目标那一家接不住：还没准备好（没有补丁文件）、用命令生成请求头、SSE、专属设置、Claude Desktop 的远程与变量
        if let Some((_, reason)) = agents::not_ready(target_location, &target.state)
            .or_else(|| agents::name_refusal(&target_location.harness_id, &selection.name))
        {
            issues.push(issue(selection, reason));
            continue;
        }
        if let Some(reason) = definition.refusal_for(source_location, target_location) {
            issues.push(issue(selection, reason));
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
                definition,
                mirror: false,
                also_from: Vec::new(),
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
                message: crate::t!("mcp.issue.multipleSources"),
            });
        } else {
            // 完全相同的重复选择（同一来源或等价来源）只写入一次。
            // 任一别名目标跨域时，合并动作仍需跨域确认。
            let mut pending = first.clone();
            pending.action.cross_domain =
                group.iter().any(|candidate| candidate.action.cross_domain);
            pending.also_from = group[1..]
                .iter()
                .map(|candidate| candidate.action.source_path.clone())
                .filter(|path| path != &pending.action.source_path)
                .collect();
            private.push(pending);
        }
    }
    let (private, mirror_failures) = with_mirrors(private);
    PreparedPlan {
        actions: plan_actions(&private),
        issues,
        private,
        mirror_failures,
    }
}

/// 给前端看的动作：镜像写入不另列（预览里仍只有一条「Claude Desktop」）
pub(super) fn plan_actions(private: &[Pending]) -> Vec<McpAction> {
    private
        .iter()
        .filter(|pending| !pending.mirror)
        .map(|pending| pending.action.clone())
        .collect()
}

/// 目标位置带 `mirrors` 的每条写入再生成一条镜像写入（spec 2026-10-05-mcp-claude-3p 设计）：目标文件、目标状态、
/// 位置的 `path` 都换成镜像文件，其余不变；它按文件（`group_key`）自成一组，备份、合并、写入、撤销记录都是现成的。
/// 镜像里已有一样的定义就不用写；读不出（坏 JSON、软链接）、已有同名但不同的（或比不了的）此刻就记成失败，
/// 执行时并进主条目（R3），与主文件在 `prepare` 里的判法一致。镜像与主文件是同一个文件时（主配置是指向
/// `Claude-3p/` 那份的软链接，`resolve_symlinks` 已把主路径换成真实路径）不生成：一个文件只写一次
pub(super) fn with_mirrors(private: Vec<Pending>) -> (Vec<Pending>, Vec<McpReportEntry>) {
    let mut out = Vec::with_capacity(private.len());
    let mut failures = Vec::new();
    for pending in private {
        for mirror_path in &pending.target_location.mirrors {
            if same_file(&pending.target_location.path, mirror_path) {
                continue;
            }
            let mut location = pending.target_location.clone();
            location.path = mirror_path.clone();
            location.mirrors = Vec::new();
            let parsed = parse(&location);
            if parsed.issue.is_some() {
                let reason = crate::t!("mcp.reason.targetUnreadable");
                failures.push(entry(&pending.action, "failed", &reason, None));
                continue;
            }
            if let Some(old) = parsed.values.get(&pending.action.name) {
                if !old.unsupported && old.connection_eq(&pending.definition) {
                    continue;
                }
                let reason = if old.unsupported {
                    old.reason
                        .clone()
                        .unwrap_or_else(|| crate::t!("mcp.issue.targetCannotCompare"))
                } else {
                    crate::t!("mcp.issue.targetConflict")
                };
                failures.push(entry(&pending.action, "failed", &reason, None));
                continue;
            }
            let mut mirror = pending.clone();
            mirror.action.target_path = mirror_path.clone();
            mirror.target = parsed.state;
            mirror.target_location = location;
            mirror.mirror = true;
            // 来源一栏填的是目标自己的（导入对话框的 `write_definitions`：核对的是目标从检查到写之间没被改过）：
            // 镜像也核对镜像自己——主文件先写，写完它就变了，不能再拿它当镜像的来源
            if same_file(&pending.action.source_path, &pending.target_location.path) {
                mirror.action.source_path = mirror_path.clone();
                mirror.source = mirror.target.clone();
            }
            out.push(mirror);
        }
        out.push(pending);
    }
    (out, failures)
}

/// 两个路径是不是同一个文件：规范化后相同，或都存在且真实路径（跟随软链接）相同
pub(super) fn same_file(a: &Path, b: &Path) -> bool {
    normalize(a) == normalize(b)
        || matches!(
            (crate::fs::real_path(a), crate::fs::real_path(b)),
            (Some(x), Some(y)) if x == y
        )
}

/// 主文件那一条成了没有（`created` / `removed`）：镜像只在主文件写成之后才动（spec 2026-10-05-mcp-claude-3p；
/// Codex 复审：主失败、镜像成了会让镜像已改却只报失败、撤销记录也丢）
pub(super) fn main_succeeded(report: &McpReport, target_id: &str, name: &str) -> bool {
    report.entries.iter().any(|entry| {
        entry.target_id == target_id
            && entry.name == name
            && matches!(entry.outcome.as_str(), "created" | "removed" | "updated")
    })
}

/// 镜像写入的结果并进主条目（spec 2026-10-05-mcp-claude-3p 设计「报告」）：镜像成功的不另出现；失败的整句原因
/// 放进同一目标、同一名字的主条目的 `mirror_failed`，主条目的状态与 `message` 不变（前端只在失败条目上显示
/// `message`，成功条目下另显示这一句）；撤销记录两边合在一起，哪一边撤不了整次就撤不了。
/// 主条目没成的（镜像那一组本就不执行）与找不到主条目的（不该发生）不出条目：报告里不出现第二个「Claude Desktop」
pub(super) fn fold_mirrors(report: &mut McpReport, mirrors: McpReport) {
    for entry in mirrors.entries {
        if entry.outcome != "failed" {
            continue;
        }
        let main = report.entries.iter_mut().find(|main| {
            main.target_id == entry.target_id
                && main.name == entry.name
                && matches!(main.outcome.as_str(), "created" | "removed" | "updated")
        });
        if let Some(main) = main {
            main.mirror_failed = Some(crate::t!("mcp.report.mirrorFailed", reason = entry.message));
        }
    }
    report.undo.files.extend(mirrors.undo.files);
    report.undo.blocked |= mirrors.undo.blocked;
}

/// `backups` 是 Sophia 的备份目录（`<数据目录>/backups`，见 `atomicfile::backup`）；改已有文件前先备份到那里
pub fn execute(plan: PreparedPlan, allow_cross_domain: bool, backups: &Path) -> McpReport {
    let mut report = McpReport::default();
    let mut groups: BTreeMap<String, Vec<Pending>> = BTreeMap::new();
    let mut mirror_groups = Vec::new();
    for pending in plan.private {
        groups.entry(group_key(&pending)).or_default().push(pending);
    }
    // 主文件的组先执行；镜像的组只留主文件写成了的那几条，之后执行、结果单独收，最后并进主条目。
    // 一组里镜像与别的位置的写入混在一起（别的 agent 的配置是指向 Claude-3p 那份的软链接，错配）：
    // 镜像那几条不写、记成镜像失败，不为它做同一个文件的两阶段写
    let mut mirrors = McpReport::default();
    for group in groups.into_values() {
        let (mirror, main): (Vec<Pending>, Vec<Pending>) =
            group.into_iter().partition(|pending| pending.mirror);
        if main.is_empty() {
            mirror_groups.push(mirror);
            continue;
        }
        for pending in &mirror {
            mirrors.entries.push(entry(
                &pending.action,
                "failed",
                &crate::t!("mcp.reason.mirrorSharedFile"),
                None,
            ));
        }
        execute_group(main, allow_cross_domain, backups, &mut report);
    }
    for group in mirror_groups {
        let group: Vec<Pending> = group
            .into_iter()
            .filter(|p| main_succeeded(&report, &p.action.target_id, &p.action.name))
            .collect();
        if !group.is_empty() {
            execute_group(group, allow_cross_domain, backups, &mut mirrors);
        }
    }
    mirrors.entries.extend(plan.mirror_failures);
    fold_mirrors(&mut report, mirrors);
    report
}
fn execute_group(
    group: Vec<Pending>,
    allow_cross_domain: bool,
    backups: &Path,
    report: &mut McpReport,
) {
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
        fail(report, &crate::t!("mcp.report.crossDomainDenied"));
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
        fail(report, &crate::t!("mcp.report.changedAfterPreview"));
        return;
    }
    let old = match &group[0].target {
        State::Missing => None,
        State::Present(snap) => Some(snap.bytes.as_slice()),
        State::Bad(_) => {
            fail(report, &crate::t!("mcp.report.targetNotWritable"));
            return;
        }
        #[cfg(feature = "weiboap")]
        State::Weibo(_) => unreachable!("WeiboAP groups are handled above"),
    };
    let bytes = match merge_group(old, &group) {
        Ok(bytes) => bytes,
        Err(error) => {
            // 写回前核对没通过是 Sophia 自己的改写出了问题：计一次内部错误，只计次数不收原文
            // （spec 2026-10-06-prelaunch-five R15）；用户文件本身的状态不计。拒绝写时带上原因
            if merge_unverified(&error) {
                crate::report::count(crate::report::Kind::Internal);
            }
            match error.get_ref().and_then(|e| e.downcast_ref::<Refused>()) {
                Some(reason) => fail(
                    report,
                    &crate::t!("mcp.report.unsafeWriteBackWhy", reason = reason),
                ),
                // 分不出原因：兜底句不是给人看的原因，原文另给（`detail`）、同时进日志
                None => {
                    log::warn!("mcp-merge {}: {error}", path.display());
                    let detail = crate::redact::redact(&error.to_string());
                    for pending in &group {
                        let mut failed = entry(
                            &pending.action,
                            "failed",
                            &crate::t!("mcp.report.unsafeWriteBack"),
                            None,
                        );
                        failed.detail = Some(detail.clone());
                        report.entries.push(failed);
                    }
                }
            }
            return;
        }
    };
    let backup = match &group[0].target {
        State::Present(snap) => match backup(path, snap, backups) {
            Ok(path) => Some(path),
            Err(error) => {
                let (message, detail) = backup_failed(path, &error, || {
                    crate::t!("mcp.report.backupFailedNotWritten")
                });
                for pending in &group {
                    let mut failed = entry(&pending.action, "failed", &message, None);
                    failed.detail = detail.clone();
                    report.entries.push(failed);
                }
                return;
            }
        },
        State::Missing => None,
        State::Bad(_) => unreachable!(),
        #[cfg(feature = "weiboap")]
        State::Weibo(_) => unreachable!("WeiboAP groups are handled above"),
    };
    if let Err(error) = atomic_write(path, &bytes, &group[0].target) {
        let (message, detail) =
            write_failed(path, &error, || crate::t!("mcp.report.atomicWriteFailed"));
        for (index, pending) in group.iter().enumerate() {
            let mut failed = entry(
                &pending.action,
                "failed",
                &message,
                (index == 0).then(|| backup.clone()).flatten(),
            );
            failed.detail = detail.clone();
            report.entries.push(failed);
        }
        return;
    }
    record_undo(report, path, &group[0].target, backup.clone(), &bytes);
    // DeepSeek Harness 另有全机补丁时，说明以哪一个为准
    let note = patch_file(path).then(|| patch::global_note(path)).flatten();
    for (index, pending) in group.iter().enumerate() {
        report.entries.push(McpReportEntry {
            note: note.clone(),
            ..entry(
                &pending.action,
                "created",
                &crate::t!("mcp.report.created"),
                (index == 0).then(|| backup.clone()).flatten(),
            )
        });
    }
}

/// 写配置没写成时给用户的一句（spec 2026-10-04-local-diagnostics R12）：磁盘满、没权限、只读、被改过各说各的，
/// 别的原因用调用处自己的那一句（`other`），另给原文（去隐私，`McpReportEntry::detail`；说得出原因的为 None）；
/// 原文同时进日志。写入、删除、保留这份、撤销都走这一个（#306 复审）
pub(super) fn write_failed(
    path: &Path,
    error: &io::Error,
    other: impl FnOnce() -> String,
) -> (String, Option<String>) {
    match atomicfile::write_failure_reason(path, error) {
        Some(reason) => (reason, None),
        None => (other(), Some(crate::redact::redact(&error.to_string()))),
    }
}

/// 备份没做成时给用户的一句：磁盘满、没权限、只读说「备份时…」，别的（含「已存在」）用调用处那一句，
/// 另给原文（去隐私；说得出原因的为 None）
pub(super) fn backup_failed(
    path: &Path,
    error: &io::Error,
    other: impl FnOnce() -> String,
) -> (String, Option<String>) {
    match atomicfile::backup_failure_text(path, error) {
        Some(reason) => (reason, None),
        None => (other(), Some(crate::redact::redact(&error.to_string()))),
    }
}

/// 写成功后立刻读回，记下写后指纹。读回的内容不是我们刚写的（写后瞬间又被别人改了），
/// 就不给这次写入撤销：记下别人的指纹会让撤销覆盖别人的改动。
fn record_undo(
    report: &mut McpReport,
    path: &Path,
    before: &State,
    backup_path: Option<PathBuf>,
    bytes: &[u8],
) {
    let before = match before {
        State::Missing => FileState::Missing,
        State::Present(snap) => FileState::Present(snap.clone()),
        _ => {
            report.undo.blocked = true;
            return;
        }
    };
    match atomicfile::read_state(path) {
        Ok(FileState::Present(snap)) if snap.bytes == bytes => report.undo.files.push(UndoFile {
            target: path.to_path_buf(),
            before,
            backup_path,
            written: FileState::Present(snap),
        }),
        _ => report.undo.blocked = true,
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
                &crate::t!("mcp.report.changedAfterPreview"),
                None,
            ));
        }
        return;
    }
    match weiboap::write(&group) {
        Ok(backup) => {
            // WeiboAP 写的是数据库，不走 atomicfile 快照，这一批不提供撤销
            report.undo.blocked = true;
            for (index, pending) in group.iter().enumerate() {
                report.entries.push(entry(
                    &pending.action,
                    "created",
                    &crate::t!("mcp.report.createdEnableIn", agent = "WeiboAP"),
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
fn issue(selection: &McpSelection, message: impl Into<String>) -> McpIssue {
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
        mirror_failed: None,
        note: None,
        detail: None,
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
        State::Present(snap) if patch_file(&location.path) => patch::parse(&snap.bytes, state),
        State::Present(snap) => parse_json(
            &snap.bytes,
            state,
            location.selector.as_deref(),
            agents::dialect_of(location),
        ),
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
        Err(ReadError::Symlink) => State::Bad(crate::t!("mcp.read.symlink")),
        Err(ReadError::NotRegularFile) => State::Bad(crate::t!("mcp.read.notRegular")),
        Err(ReadError::Io(_)) => State::Bad(crate::t!("mcp.read.unreadable")),
    }
}
fn same(path: &Path, expected: &State) -> bool {
    match (expected, read(path)) {
        (State::Missing, State::Missing) => true,
        (State::Present(expected), State::Present(actual)) => expected == &actual,
        _ => false,
    }
}

fn parse_json(bytes: &[u8], state: State, selector: Option<&str>, dialect: Dialect) -> Parsed {
    if serde_json::from_slice::<NoDuplicates>(bytes).is_err() {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some(crate::t!("mcp.read.jsonInvalid")),
            state,
        };
    }
    let root: Value = serde_json::from_slice(bytes).expect("validated JSON");
    let Some(root) = root.as_object() else {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some(crate::t!("mcp.read.jsonRootNotObject")),
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
                    return invalid_json_scope(state, crate::t!("mcp.read.projectNotObject"));
                }
            },
            Some(_) => return invalid_json_scope(state, crate::t!("mcp.read.projectsNotObject")),
        },
        None => root.get("mcpServers"),
    };
    let values = match servers {
        None => BTreeMap::new(),
        Some(Value::Object(servers)) => servers
            .iter()
            .map(|(name, value)| (name.clone(), canon_by(value, dialect)))
            .collect(),
        Some(_) => {
            return Parsed {
                values: BTreeMap::new(),
                issue: Some(crate::t!("mcp.read.mcpServersNotObject")),
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
/// 按这一家的写法读一条服务
fn canon_by(value: &Value, dialect: Dialect) -> Canonical {
    match dialect {
        Dialect::Gemini => agents::canon_gemini(value),
        Dialect::Copilot => agents::canon_copilot(value),
        Dialect::Desktop => agents::canon_desktop(value),
        Dialect::Kimi => agents::canon_kimi(value),
        Dialect::Claude => canon_json(value, Some("headersHelper")),
        Dialect::Cursor | Dialect::Toml => canon_json(value, None),
        Dialect::WorkBuddy => canon_json_with(value, None, &agents::WORKBUDDY_NATIVE),
        Dialect::DshPatch => patch::canon(value),
    }
}
fn invalid_json_scope(state: State, message: String) -> Parsed {
    Parsed {
        values: BTreeMap::new(),
        issue: Some(message),
        state,
    }
}
fn canon_json(value: &Value, helper_key: Option<&str>) -> Canonical {
    canon_json_with(value, helper_key, &[])
}

/// 同 [`canon_json`]，另认这一家专属、同一家之间原样保留的字段 `native`（进 `client_fields`）
fn canon_json_with(value: &Value, helper_key: Option<&str>, native: &[&str]) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported_with(crate::t!("mcp.canon.notObject"));
    };
    let unknown = object
        .keys()
        .find(|key| {
            !["type", "command", "args", "env", "url", "headers"].contains(&key.as_str())
                && !native.contains(&key.as_str())
                && Some(key.as_str()) != helper_key
        })
        .cloned();
    let mut reason = unknown
        .as_ref()
        .map(|key| crate::t!("mcp.canon.unsupportedField", key = key));
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
                reason = Some(crate::t!("mcp.canon.fieldTypeInvalid", field = field));
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
        reason = Some(crate::t!("mcp.canon.fieldTypeInvalid", field = "args"));
    }
    if reason.is_none() {
        for field in ["env", "headers"] {
            if object.get(field).is_some_and(|value| {
                !value
                    .as_object()
                    .is_some_and(|values| values.values().all(Value::is_string))
            }) {
                reason = Some(crate::t!("mcp.canon.fieldTypeInvalid", field = field));
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
        // SSE 只有 Claude Code 写得出 `type: "sse"`（认 `headersHelper` 的就是它）；Cursor 的 `url` 分不出两种
        (None, Some(_)) if helper_key.is_some() && typ.as_deref() == Some("sse") => "sse",
        _ => {
            bad = true;
            "unsupported"
        }
    };
    if (transport == "stdio" && object.contains_key("headers"))
        || (transport != "stdio" && (object.contains_key("args") || object.contains_key("env")))
    {
        bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.connectionNotForTransport"));
    }
    // 值里的变量引用（`${…}`）不算搬不过去：同一家之间原样复制，跨家由 `refusal` 拒绝
    // （spec 2026-09-27-mcp-batch1 R4，2026-09-27 改定）
    if command.as_deref().is_some_and(str::is_empty) {
        bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldEmpty", field = "command"));
    }
    if url.as_deref().is_some_and(str::is_empty) {
        bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldEmpty", field = "url"));
    }
    if has_duplicate_header_names(&headers) {
        bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldDuplicateNames", field = "headers"));
    }
    let headers_helper = match helper_key {
        Some(key) => headers_helper(
            object.get(key).map(Value::as_str),
            key,
            transport,
            &mut bad,
            &mut reason,
        ),
        None => None,
    };
    Canonical {
        raw: None,
        unknown_field: unknown,
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields: object
            .iter()
            .filter(|(key, _)| native.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.to_string()))
            .collect(),
        reason: bad.then(|| reason.unwrap_or_else(|| crate::t!("mcp.canon.connectionTypeInvalid"))),
        unsupported: bad,
        headers_helper,
    }
}

/// 这一家的 JSON 配置里「用命令生成请求头」的字段名；不认得这种写法的为 None，
/// 那边的同名字段按不认识的字段处理（搬不过去）
fn json_helper_key(dialect: Dialect) -> Option<&'static str> {
    (dialect == Dialect::Claude).then_some("headersHelper")
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
            issue: Some(crate::t!("mcp.read.tomlNotUtf8")),
            state,
        };
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        return Parsed {
            values: BTreeMap::new(),
            issue: Some(crate::t!("mcp.read.tomlInvalid")),
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
                    issue: Some(crate::t!("mcp.read.mcpServersNotTable")),
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
        return unsupported_with(crate::t!("mcp.canon.notTable"));
    };
    const CONNECTION: [&str; 6] = [
        "command",
        "args",
        "env",
        "url",
        "http_headers",
        "http_headers_helper",
    ];
    const CLIENT: [&str; 3] = ["enabled", "startup_timeout_sec", "tool_timeout_sec"];
    let unknown = table.iter().find_map(|(key, _)| {
        (!CONNECTION.contains(&key) && !CLIENT.contains(&key)).then(|| key.to_string())
    });
    let mut reason = unknown.as_ref().map(|key| {
        crate::t!(
            "mcp.canon.agentUnsupportedField",
            agent = "Codex",
            key = key
        )
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
                reason = Some(crate::t!("mcp.canon.fieldTypeInvalid", field = field));
                break;
            }
        }
    }
    if reason.is_none()
        && table
            .get("args")
            .is_some_and(|value| value.as_array().is_none())
    {
        reason = Some(crate::t!("mcp.canon.fieldTypeInvalid", field = "args"));
    }
    if reason.is_none() {
        for field in ["env", "http_headers"] {
            if table
                .get(field)
                .is_some_and(|value| value.as_table_like().is_none())
            {
                reason = Some(crate::t!("mcp.canon.fieldTypeInvalid", field = field));
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
        reason.get_or_insert_with(|| crate::t!("mcp.canon.connectionNotForTransport"));
    }
    // 值里的变量引用（`${…}`）不算搬不过去：同一家之间原样复制，跨家由 `refusal` 拒绝
    // （spec 2026-09-27-mcp-batch1 R4，2026-09-27 改定）
    if command.as_deref().is_some_and(str::is_empty) {
        bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldEmpty", field = "command"));
    }
    if url.as_deref().is_some_and(str::is_empty) {
        bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldEmpty", field = "url"));
    }
    if has_duplicate_header_names(&headers) {
        bad = true;
        reason.get_or_insert_with(|| {
            crate::t!("mcp.canon.fieldDuplicateNames", field = "http_headers")
        });
    }
    let headers_helper = headers_helper(
        table.get("http_headers_helper").map(|item| item.as_str()),
        "http_headers_helper",
        transport,
        &mut bad,
        &mut reason,
    );
    Canonical {
        raw: None,
        unknown_field: unknown,
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields,
        reason: bad.then(|| reason.unwrap_or_else(|| crate::t!("mcp.canon.connectionTypeInvalid"))),
        unsupported: bad,
        headers_helper,
    }
}

/// 生成请求头的命令（`value`：字段不在为 None，在但不是字符串为 `Some(None)`）。
/// 必须是非空字符串、不含变量引用（两家对 `${…}` 的展开不一样）、只配 HTTP
fn headers_helper(
    value: Option<Option<&str>>,
    field: &str,
    transport: &str,
    bad: &mut bool,
    reason: &mut Option<String>,
) -> Option<String> {
    let value = value?;
    let Some(command) = value.filter(|v| !v.trim().is_empty()) else {
        *bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldNotNonEmptyString", field = field));
        return None;
    };
    if transport != "http" {
        *bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.connectionNotForTransport"));
    }
    if reference(command) {
        *bad = true;
        reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldHasVariable", field = field));
    }
    Some(command.to_owned())
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
            reason.get_or_insert_with(|| crate::t!("mcp.canon.fieldValueInvalid", key = key));
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
fn unsupported_with(reason: impl Into<String>) -> Canonical {
    Canonical {
        raw: None,
        unknown_field: None,
        transport: "unsupported".into(),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        client_fields: BTreeMap::new(),
        reason: Some(reason.into()),
        unsupported: true,
        headers_helper: None,
    }
}
fn reference(value: &str) -> bool {
    value.contains("${")
}

/// 定义里有没有「像密钥的值」（GLOSSARY；密钥提醒 S19）：名字（环境变量、请求头、参数的选项名、地址的查询键）
/// 带 key、token、secret、auth、password 之类，或值里有已知密钥前缀的一串。环境变量占位符（`${BRAVE_API_KEY}`）、
/// 空值不算；用命令生成请求头的那条命令不算。拆参数与地址的规则同脱敏（`args_without_secrets`、`url_without_secrets`）
fn has_key_values(def: &Canonical) -> bool {
    def.env
        .iter()
        .any(|(name, value)| key_slot(Some(name), value))
        || def
            .headers
            .iter()
            .any(|(name, value)| key_slot(Some(name), value))
        || def.url.as_deref().is_some_and(url_has_key)
        || def.command.as_deref().is_some_and(|c| key_slot(None, c))
        || args_have_key(&def.args)
}

/// 一格值算不算密钥：`name` 是它的名字（没有为 None）
fn key_slot(name: Option<&str>, value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && !reference(value) && (name.is_some_and(secretish) || has_key_shaped(value))
}

fn header_line_has_key(line: &str) -> bool {
    match line.split_once(':') {
        Some((name, value)) => key_slot(Some(name.trim()), value),
        None => key_slot(None, line),
    }
}

fn url_has_key(url: &str) -> bool {
    let (url, fragment) = url
        .split_once('#')
        .map_or((url, None), |(u, f)| (u, Some(f)));
    let (base, query) = url
        .split_once('?')
        .map_or((url, None), |(b, q)| (b, Some(q)));
    let pairs = query
        .into_iter()
        .chain(fragment)
        .flat_map(|part| part.split('&'));
    let in_pairs = pairs.into_iter().any(|pair| match pair.split_once('=') {
        Some((key, value)) => key_slot(Some(key), value),
        None => key_slot(None, pair),
    });
    let (userinfo, rest) = match base.split_once("://") {
        Some((_, rest)) => {
            let end = rest.find('/').unwrap_or(rest.len());
            match rest[..end].rsplit_once('@') {
                Some((userinfo, _)) => (Some(userinfo), &rest[end..]),
                None => (None, rest),
            }
        }
        None => (None, base),
    };
    let in_userinfo = userinfo.is_some_and(|info| match info.split_once(':') {
        Some((user, password)) => key_slot(None, user) || key_slot(Some("password"), password),
        None => key_slot(None, info),
    });
    in_pairs || in_userinfo || key_slot(None, rest)
}

/// 单个参数自身带密钥：地址、`Bearer x`、`API_KEY=x` / `Name: x`（名字像凭据），或长得像密钥的一串
fn arg_has_key(arg: &str) -> bool {
    if arg.contains("://") {
        return url_has_key(arg);
    }
    if let Some(token) = arg
        .strip_prefix("Bearer ")
        .or_else(|| arg.strip_prefix("bearer "))
    {
        return key_slot(Some("bearer"), token);
    }
    let named = |sep: char| {
        arg.split_once(sep).filter(|(name, _)| {
            !name.is_empty() && !name.contains(char::is_whitespace) && secretish(name)
        })
    };
    match named(':').or_else(|| named('=')) {
        Some((name, value)) => key_slot(Some(name), value),
        None => key_slot(None, arg),
    }
}

/// 参数里的密钥：`--api-key xyz`、`--token=xyz`、`-H` / `--header` 后（或连写）的请求头行、参数自身（`arg_has_key`）
fn args_have_key(args: &[String]) -> bool {
    // 上一个是 `--api-key`、`-H` 这类：这一个是它的值
    let mut owner: Option<&str> = None;
    for arg in args {
        let hit = if let Some(flag) = owner.take() {
            if header_flag(flag) {
                header_line_has_key(arg)
            } else {
                key_slot(Some(flag), arg)
            }
        } else if let Some(line) = arg
            .strip_prefix("-H")
            .filter(|line| !line.is_empty() && !line.starts_with('='))
        {
            header_line_has_key(line)
        } else {
            match arg.split_once('=') {
                Some((key, line)) if header_flag(key) => header_line_has_key(line),
                Some((key, value)) if key.starts_with('-') && secretish(key) => {
                    key_slot(Some(key), value)
                }
                _ if header_flag(arg) || (arg.starts_with('-') && secretish(arg)) => {
                    owner = Some(arg);
                    false
                }
                _ => arg_has_key(arg),
            }
        };
        if hit {
            return true;
        }
    }
    false
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
    let dialect = agents::dialect_of(location);
    if dialect == Dialect::Toml {
        merge_toml(existing, additions)
    } else if dialect == Dialect::DshPatch {
        patch::merge(existing, additions)
    } else if let Some(project) = location.selector.as_deref() {
        merge_claude_local_json(existing, additions, project, json_helper_key(dialect))
    } else {
        merge_json(existing, additions, dialect)
    }
}
/// 往 JSON 配置的根 `mcpServers` 里追加成员：只切入新成员，其余字节原样（Gemini 的 `settings.json`
/// 里大量无关设置逐字节不动）。追加后按语义核对：去掉新成员与原文一模一样，新成员读回来与要写的一致
fn merge_json(
    existing: Option<&[u8]>,
    additions: &[(&str, &Canonical)],
    dialect: Dialect,
) -> io::Result<Vec<u8>> {
    let mut bytes = existing.unwrap_or(b"{}").to_vec();
    if serde_json::from_slice::<NoDuplicates>(&bytes).is_err() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "json"));
    }
    let before = bytes.clone();
    let (_, _, server_range) = raw_json_ranges(&bytes)?;
    let fields: Vec<_> = additions
        .iter()
        .map(|(name, def)| Ok((*name, json_server_for(def, dialect)?)))
        .collect::<io::Result<_>>()?;
    // 已有 `mcpServers` 就紧跟在它最后一个成员后面追加；没有就在根里另起一行补上
    let layout = if server_range.is_some() {
        Layout::Compact
    } else {
        Layout::Line
    };
    let members: Vec<(&str, &[u8])> = fields.iter().map(|(n, v)| (*n, v.as_slice())).collect();
    bytes = jsonedit::insert(&bytes, &["mcpServers"], &members, layout).map_err(|error| {
        match error {
            // 例如要加的名字已经在了：与下面的语义核对同一个说法
            jsonedit::Error::Mismatch => refused(crate::t!("mcp.write.afterMismatch")),
            other => other.into(),
        }
    })?;
    verify_json_merge(&before, &bytes, additions, dialect)?;
    Ok(bytes)
}

/// 一条服务按这一家的 JSON 写法（根上的 `mcpServers` 里那一项）。原样搬的写来源那一段原文
/// （同一家同一种写法，见 `RawServer`）
fn json_server_for(def: &Canonical, dialect: Dialect) -> io::Result<Vec<u8>> {
    if let Some(RawServer::Json(text)) = &def.raw {
        return Ok(text.clone().into_bytes());
    }
    match dialect {
        Dialect::Claude | Dialect::Cursor | Dialect::Toml => {
            if !def.client_fields.is_empty() {
                return Err(refused(crate::t!("mcp.write.noClientSettings")));
            }
            if def.transport == "sse" && dialect != Dialect::Claude {
                return Err(refused(crate::t!("mcp.write.sseUnsupported")));
            }
            json_server(def, json_helper_key(dialect))
        }
        // 同 Cursor 的写法，再原样带上它自己的字段（同一家之间；跨家的计划阶段已拒绝）
        Dialect::WorkBuddy => {
            if def.transport == "sse" {
                return Err(refused(crate::t!("mcp.write.sseUnsupported")));
            }
            let plain = Canonical {
                client_fields: BTreeMap::new(),
                ..def.clone()
            };
            let mut object: serde_json::Map<String, Value> =
                serde_json::from_slice(&json_server(&plain, None)?).map_err(io::Error::other)?;
            agents::put_native(def, &agents::WORKBUDDY_NATIVE, &mut object)?;
            serde_json::to_vec(&Value::Object(object)).map_err(io::Error::other)
        }
        _ => agents::server(def, dialect),
    }
}

/// JSON 追加结果的语义核对：新文件去掉新增的成员（以及原来没有、这次新建的空 `mcpServers`）
/// 等于原文件；新增的每项按这一家的写法读回来，连接字段与专属设置都和要写的一致
fn verify_json_merge(
    before: &[u8],
    after: &[u8],
    additions: &[(&str, &Canonical)],
    dialect: Dialect,
) -> io::Result<()> {
    let bad = || unverified(crate::t!("mcp.write.afterMismatch"));
    let old: Value = serde_json::from_slice(before).map_err(|_| bad())?;
    serde_json::from_slice::<NoDuplicates>(after).map_err(|_| bad())?;
    let mut new: Value = serde_json::from_slice(after).map_err(|_| bad())?;
    let root = new.as_object_mut().ok_or_else(bad)?;
    let servers = root
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(bad)?;
    for (name, def) in additions {
        let removed = servers.remove(*name).ok_or_else(bad)?;
        // 原样搬的：读回来与来源那一段一模一样
        if let Some(RawServer::Json(text)) = &def.raw {
            let expected: Value = serde_json::from_str(text).map_err(|_| bad())?;
            if removed != expected {
                return Err(bad());
            }
            continue;
        }
        let written = canon_by(&removed, dialect);
        if !written.connection_eq(def) || written.client_fields != def.client_fields {
            return Err(bad());
        }
    }
    if old.get("mcpServers").is_none() && servers.is_empty() {
        root.remove("mcpServers");
    }
    if new != old {
        return Err(bad());
    }
    Ok(())
}
/// 只在 Claude 的 `projects[project].mcpServers` 里追加成员。所有未命中的
/// 根字段、其它项目及它们内部的原始字节都保留，不经 serde 重新序列化。
fn merge_claude_local_json(
    existing: Option<&[u8]>,
    additions: &[(&str, &Canonical)],
    project: &str,
    helper_key: Option<&str>,
) -> io::Result<Vec<u8>> {
    let bytes = existing.unwrap_or(b"{}");
    if serde_json::from_slice::<NoDuplicates>(bytes).is_err() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "json"));
    }
    let fields: Vec<_> = additions
        .iter()
        .map(|(name, def)| Ok((*name, json_server(def, helper_key)?)))
        .collect::<io::Result<_>>()?;
    let members: Vec<(&str, &[u8])> = fields.iter().map(|(n, v)| (*n, v.as_slice())).collect();
    // 路径上缺的 `projects`、项目、`mcpServers` 逐层新建，都是紧凑写法
    Ok(jsonedit::insert(
        bytes,
        &["projects", project, "mcpServers"],
        &members,
        Layout::Compact,
    )?)
}
/// 一条服务的 JSON 写法。`helper_key` 是目标 agent 里「用命令生成请求头」的字段名（见 `json_helper_key`）
fn json_server(def: &Canonical, helper_key: Option<&str>) -> io::Result<Vec<u8>> {
    // 原样搬的：来源那一段原文（同一家同一种写法，见 `RawServer`）
    if let Some(RawServer::Json(text)) = &def.raw {
        return Ok(text.clone().into_bytes());
    }
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
        if let Some(command) = &def.headers_helper {
            // 计划阶段已按目标 agent 拒绝（`Canonical::refusal_for`）；这里再挡一次，绝不丢字段写
            let key = helper_key.ok_or_else(|| refused(crate::t!("mcp.write.noHeadersHelper")))?;
            object.insert(key.into(), Value::String(command.clone()));
        }
    }
    serde_json::to_vec(&Value::Object(object)).map_err(io::Error::other)
}
/// 合并被拒绝的原因（给用户看的一句中文），随 `io::Error` 带到 `execute_group` 显示
/// 不写的原因。`unverified`：改写已经做出来、写回前按语义核对没通过——是 Sophia 自己的改写出了问题，
/// 计入每日上报的内部错误（spec 2026-10-06-prelaunch-five R15）；其余（文件不是合法 TOML、形状不对、
/// 名字已在等）是用户那边的状态，不计
#[derive(Debug)]
struct Refused {
    reason: String,
    unverified: bool,
}
impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}
impl std::error::Error for Refused {}
fn refused(reason: impl Into<String>) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        Refused {
            reason: reason.into(),
            unverified: false,
        },
    )
}
/// 写回前核对没通过（见 [`Refused`]）
fn unverified(reason: impl Into<String>) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        Refused {
            reason: reason.into(),
            unverified: true,
        },
    )
}
/// 合并没做成是不是 Sophia 自己的改写出了问题（只有写回前核对没通过才算）
fn merge_unverified(error: &io::Error) -> bool {
    error
        .get_ref()
        .and_then(|e| e.downcast_ref::<Refused>())
        .is_some_and(|r| r.unverified)
}

/// 往 TOML 配置（Codex 的 `config.toml`）里追加 MCP 服务。**不重新序列化整份文件**：
/// 原文逐字节保留（BOM、换行风格、注释、排版都不动），只在末尾追加 `[mcp_servers.<名>]` 表；
/// `mcp_servers` 本身写成内联表时，只在它的花括号里补成员。换行跟随原文件（有 CRLF 就用 CRLF），
/// 原文末行没有换行的先补一个。追加后重新解析核对：原有内容一个值都没变、新增项读回来与要写的
/// 一致，对不上就拒绝写。同名已存在沿用「不覆盖」：返回 `AlreadyExists`
fn merge_toml(existing: Option<&[u8]>, additions: &[(&str, &Canonical)]) -> io::Result<Vec<u8>> {
    let text = existing
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| refused(crate::t!("mcp.write.notUtf8")))?
        .unwrap_or("");
    let doc =
        toml_edit::Document::parse(text).map_err(|_| refused(crate::t!("mcp.write.notToml")))?;
    let servers = doc.get("mcp_servers");
    for (name, _) in additions {
        if servers
            .and_then(toml_edit::Item::as_table_like)
            .is_some_and(|table| table.contains_key(name))
        {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "exists"));
        }
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let out = match servers {
        None | Some(toml_edit::Item::Table(_)) => append_toml_tables(text, additions, eol)?,
        Some(item) => match item.as_inline_table() {
            Some(table) => insert_inline_servers(text, table, additions)?,
            None => return Err(refused(crate::t!("mcp.write.serversNotTable"))),
        },
    };
    verify_toml_merge(text, &out, additions)?;
    Ok(out.into_bytes())
}

/// 一条服务要写的字段，按固定顺序：command / args / env 或 url / http_headers / http_headers_helper，再是 Codex 客户端字段
fn toml_server(def: &Canonical) -> io::Result<toml_edit::InlineTable> {
    // 原样搬的：来源那一段（去掉装饰的内联表，见 `RawServer`）
    if let Some(RawServer::Toml(text)) = &def.raw {
        return raw_inline(text).ok_or_else(|| refused(crate::t!("mcp.write.rawUnreadable")));
    }
    let mut server = toml_edit::InlineTable::new();
    if def.transport == "stdio" {
        let command = def
            .command
            .as_deref()
            .ok_or_else(|| refused(crate::t!("mcp.write.missingCommand")))?;
        server.insert("command", basic_string(command));
        if !def.args.is_empty() {
            let args: toml_edit::Array = def.args.iter().map(|arg| basic_string(arg)).collect();
            server.insert("args", args.into());
        }
        if !def.env.is_empty() {
            server.insert("env", inline(&def.env).into());
        }
    } else {
        let url = def
            .url
            .as_deref()
            .ok_or_else(|| refused(crate::t!("mcp.write.missingUrl")))?;
        server.insert("url", basic_string(url));
        if !def.headers.is_empty() {
            server.insert("http_headers", inline(&def.headers).into());
        }
        if let Some(command) = &def.headers_helper {
            server.insert("http_headers_helper", basic_string(command));
        }
    }
    for (key, raw) in &def.client_fields {
        let value = client_value(raw)
            .ok_or_else(|| refused(crate::t!("mcp.write.invalidValue", key = key)))?;
        server.insert(key, value);
    }
    Ok(server)
}

/// 原样搬的 TOML 那一段（`RawServer::Toml`）→ 内联表
fn raw_inline(text: &str) -> Option<toml_edit::InlineTable> {
    let parsed = format!("value = {text}")
        .parse::<toml_edit::DocumentMut>()
        .ok()?;
    parsed.get("value")?.as_inline_table().cloned()
}

/// Codex 客户端字段的原始写法（取自来源文件，可能带着空格、行尾注释）→ 去掉装饰的值
fn client_value(raw: &str) -> Option<toml_edit::Value> {
    let parsed = format!("value = {raw}")
        .parse::<toml_edit::DocumentMut>()
        .ok()?;
    let mut value = parsed.get("value")?.as_value()?.clone();
    value.decor_mut().clear();
    Some(value)
}

/// TOML 键：能裸写就裸写，否则按 TOML 规则加引号转义
fn toml_key(name: &str) -> String {
    toml_edit::Key::new(name).display_repr().into_owned()
}

fn append_toml_tables(
    text: &str,
    additions: &[(&str, &Canonical)],
    eol: &str,
) -> io::Result<String> {
    let mut out = text.to_owned();
    let blank = text.trim_start_matches('\u{feff}').is_empty();
    if !blank && !out.ends_with('\n') {
        out.push_str(eol);
    }
    for (index, (name, def)) in additions.iter().enumerate() {
        // 新表与上文之间空一行；空文件开头不空
        if !blank || index > 0 {
            out.push_str(eol);
        }
        out.push_str(&format!("[mcp_servers.{}]{eol}", toml_key(name)));
        for (key, value) in toml_server(def)?.iter() {
            out.push_str(&format!("{} = {value}{eol}", toml_key(key)));
        }
    }
    Ok(out)
}

/// `mcp_servers = { … }`：内联表不能再用表头扩展，只能在花括号里补成员
fn insert_inline_servers(
    text: &str,
    table: &toml_edit::InlineTable,
    additions: &[(&str, &Canonical)],
) -> io::Result<String> {
    let span = table
        .span()
        .ok_or_else(|| refused(crate::t!("mcp.write.serversNotFound")))?;
    if span.end == 0 || text.as_bytes().get(span.end - 1) != Some(&b'}') {
        return Err(refused(crate::t!("mcp.write.serversNotFound")));
    }
    let inner = &text[span.start + 1..span.end - 1];
    let kept = inner.trim_end();
    let at = span.start + 1 + kept.len();
    let members = additions
        .iter()
        .map(|(name, def)| Ok(format!("{} = {}", toml_key(name), toml_server(def)?)))
        .collect::<io::Result<Vec<_>>>()?
        .join(", ");
    let lead = if kept.trim().is_empty() || kept.ends_with(',') {
        " "
    } else {
        ", "
    };
    let tail = if text[at..].starts_with('}') { " " } else { "" };
    Ok(format!(
        "{}{lead}{members}{tail}{}",
        &text[..at],
        &text[at..]
    ))
}

/// 追加结果的语义核对：原有的每个值都在、一个没变；新增的每项都读得回来，且连接字段与客户端字段
/// 和要写的一致。字节层面「原文是结果的前缀」由写法保证，这里核对的是解析后的意思
fn verify_toml_merge(
    before: &str,
    after: &str,
    additions: &[(&str, &Canonical)],
) -> io::Result<()> {
    let old = before
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| refused(crate::t!("mcp.write.notToml")))?;
    let new = after
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| unverified(crate::t!("mcp.write.afterUnparsable")))?;
    let mut actual = sources::plain_table(new.as_table());
    let Some(Value::Object(servers)) = actual.get_mut("mcp_servers") else {
        return Err(unverified(crate::t!("mcp.write.afterNoServers")));
    };
    for (name, def) in additions {
        if servers.remove(*name).is_none() {
            return Err(unverified(crate::t!(
                "mcp.write.afterNameMissing",
                name = name
            )));
        }
        // 原样搬的：读回来的每个值与来源那一段一模一样（表头写法与内联写法读出来是同一个意思）
        if let Some(RawServer::Toml(text)) = &def.raw {
            let expected = raw_inline(text)
                .map(|table| sources::plain_item(&toml_edit::Item::Value(table.into())));
            if expected != Some(sources::plain_item(&new["mcp_servers"][*name])) {
                return Err(unverified(crate::t!(
                    "mcp.write.afterNameDiffers",
                    name = name
                )));
            }
            continue;
        }
        let written = canon_toml(&new["mcp_servers"][*name]);
        let same_clients = written.client_fields.len() == def.client_fields.len()
            && def.client_fields.iter().all(|(key, raw)| {
                let render = |raw: &str| client_value(raw).map(|value| value.to_string());
                written
                    .client_fields
                    .get(key)
                    .is_some_and(|got| render(got).is_some() && render(got) == render(raw))
            });
        if !written.connection_eq(def) || !same_clients {
            return Err(unverified(crate::t!(
                "mcp.write.afterNameDiffers",
                name = name
            )));
        }
    }
    let expected = sources::plain_table(old.as_table());
    if !expected.contains_key("mcp_servers") && servers.is_empty() {
        actual.remove("mcp_servers");
    }
    if actual != expected {
        return Err(unverified(crate::t!("mcp.write.alteredExisting")));
    }
    Ok(())
}
fn inline(values: &BTreeMap<String, String>) -> toml_edit::InlineTable {
    let mut table = toml_edit::InlineTable::new();
    for (key, value) in values {
        table.insert(key, basic_string(value));
    }
    table
}
/// 单行基本字符串：toml_edit 默认会把含换行的值写成 `"""` 多行串，
/// 那样追加的内容里就混进了裸 LF（CRLF 文件里换行风格不一致）
fn basic_string(value: &str) -> toml_edit::Value {
    crate::codex_models::config::toml_string(value)
        .parse()
        .expect("转义后的基本字符串总能解析")
}
/// 是不是 DeepSeek Harness 的 YAML 补丁（读写走 `mcp/patch.rs`）：与 TOML 一样按扩展名，
/// 只拿得到路径的地方（删除、来源移除）也分得出
fn patch_file(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("yml")
}
fn toml(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("toml")
}

/// MCP 的备份固定用 `mcp` 后缀，放进 Sophia 的备份目录 `backups`：`<原文件名>-<哈希>/000001-mcp.bak`……
fn backup(path: &Path, snap: &Snapshot, backups: &Path) -> io::Result<PathBuf> {
    atomicfile::backup(path, snap, "mcp", backups)
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

type JsonRanges = (usize, usize, Option<(usize, usize)>);
/// 根对象的范围，以及根上 `mcpServers` 的值的范围（没有就是 None）
fn raw_json_ranges(bytes: &[u8]) -> io::Result<JsonRanges> {
    let root = jsonedit::root(bytes)?;
    Ok((
        root.start,
        root.end,
        root.members.get("mcpServers").copied(),
    ))
}

#[cfg(test)]
mod exclusion_tests {
    use super::*;

    fn loc(id: &str) -> McpLocationRef {
        McpLocationRef {
            id: id.into(),
            harness_id: "codex".into(),
            domain: "global".into(),
            path: PathBuf::from("/x"),
            selector: None,
        }
    }

    fn rule(source: &str, targets: &[&str]) -> McpAutoImportRule {
        McpAutoImportRule {
            source: loc(source),
            target_domain: "global".into(),
            targets: targets.iter().map(|t| loc(t)).collect(),
            target_excluded: BTreeMap::new(),
            allow_cross_domain: false,
            baseline: Some(BTreeSet::new()),
            target_baselines: BTreeMap::new(),
            last_auto: None,
        }
    }

    fn report(entries: &[(&str, &str, &str)]) -> McpReport {
        McpReport {
            entries: entries
                .iter()
                .map(|(name, target, outcome)| McpReportEntry {
                    name: (*name).into(),
                    target_id: (*target).into(),
                    outcome: (*outcome).into(),
                    message: String::new(),
                    backup_path: None,
                    mirror_failed: None,
                    note: None,
                    detail: None,
                })
                .collect(),
            ..McpReport::default()
        }
    }

    /// 手动移除之后，覆盖这个位置的规则不再把它写回去；写回来之后排除撤掉，规则照常接管
    #[test]
    fn manual_removal_excludes_and_manual_write_restores() {
        let mut rules = vec![rule("claude", &["codex"]), rule("claude", &["cursor"])];
        let removed = report(&[
            ("weibo-search", "codex", "removed"),
            ("other", "codex", "skipped"),
        ]);
        assert!(exclude_removed(&mut rules, &removed));
        assert!(rules[0].is_excluded("codex", "weibo-search"));
        assert!(!rules[0].is_excluded("codex", "other"), "没拿掉的不排除");
        assert!(rules[1].target_excluded.is_empty(), "别的位置照常补");
        assert!(!exclude_removed(&mut rules, &removed), "再记一次没有改动");

        let written = report(&[("weibo-search", "codex", "created")]);
        assert!(include_written(&mut rules, &written));
        assert!(rules[0].target_excluded.is_empty(), "空集合不留键");
        assert!(!include_written(&mut rules, &written));
    }
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
        assert!(canon_json(&json, None).unsupported);
        let toml = "[mcp_servers.x]\nurl = \"https://x\"\nenv = { A = \"b\" }"
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        assert!(canon_toml(toml["mcp_servers"].get("x").unwrap()).unsupported);
    }
    #[test]
    fn inline_mcp_servers_keeps_existing_member() {
        let existing = b"mcp_servers = { old = { command = \"old\" } }\n";
        let def = Canonical {
            raw: None,
            unknown_field: None,
            transport: "stdio".into(),
            command: Some("new".into()),
            args: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            client_fields: BTreeMap::new(),
            reason: None,
            unsupported: false,
            headers_helper: None,
        };
        let output = merge_toml(Some(existing), &[("new", &def)]).unwrap();
        let parsed = parse_toml(&output, State::Missing);
        assert!(parsed.values.contains_key("old") && parsed.values.contains_key("new"));
    }
    fn stdio(command: &str) -> Canonical {
        Canonical {
            raw: None,
            unknown_field: None,
            transport: "stdio".into(),
            command: Some(command.into()),
            args: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            client_fields: BTreeMap::new(),
            reason: None,
            unsupported: false,
            headers_helper: None,
        }
    }

    /// 追加结果按语义核对：原有的值一个不差，新增项读回来和要写的一样
    fn assert_appended(before: &[u8], after: &[u8], added: &[(&str, &Canonical)]) {
        let old = std::str::from_utf8(before)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        let new = std::str::from_utf8(after)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        let mut actual = sources::plain_table(new.as_table());
        let servers = actual["mcp_servers"].as_object_mut().unwrap();
        for (name, def) in added {
            assert!(servers.remove(*name).is_some(), "{name} 读得回来");
            let written = canon_toml(&new["mcp_servers"][*name]);
            assert!(written.connection_eq(def), "{name} 的连接字段一致");
        }
        let expected = sources::plain_table(old.as_table());
        if !expected.contains_key("mcp_servers") {
            assert_eq!(
                actual.remove("mcp_servers"),
                Some(Value::Object(Default::default()))
            );
        }
        assert_eq!(actual, expected, "原有内容不变");
    }

    #[test]
    fn toml_append_keeps_bom_crlf_comments_and_layout_byte_for_byte() {
        // 带 BOM、CRLF、注释、怪排版，末行没有换行
        let existing = "\u{feff}# Codex 配置\r\nmodel = \"gpt-5\"   # 行尾注释\r\n\r\n\
            [mcp_servers.old]\r\ncommand = \"old\"\r\nargs = [ \"-y\",\"x\" ]\r\n\r\n\
            [profiles.fast]   # 档位\r\nmodel = \"o4\"";
        let mut def = stdio("npx");
        def.args = vec!["-y".into(), "a \"quoted\" arg\\path".into()];
        def.env = [("API KEY".to_string(), "tok\nen".to_string())].into();
        def.client_fields = [("startup_timeout_sec".to_string(), " 30 # 注释".to_string())].into();
        let http = Canonical {
            raw: None,
            unknown_field: None,
            transport: "http".into(),
            command: None,
            url: Some("https://example.com/mcp".into()),
            headers: [("Authorization".to_string(), "Bearer x".to_string())].into(),
            ..stdio("")
        };
        let added = [("my server.v2", &def), ("文档", &http)];
        let output = merge_toml(Some(existing.as_bytes()), &added).unwrap();

        assert!(
            output.starts_with(existing.as_bytes()),
            "原文逐字节是结果的前缀"
        );
        let tail = std::str::from_utf8(&output[existing.len()..]).unwrap();
        // 末行没有换行：只补一个把它结束掉，接着是空一行和新表
        assert!(
            tail.starts_with("\r\n\r\n[mcp_servers.\"my server.v2\"]\r\n"),
            "{tail:?}"
        );
        assert!(
            tail.contains("[mcp_servers.文档]\r\n") || tail.contains("[mcp_servers.\"文档\"]\r\n")
        );
        assert_eq!(
            tail.matches('\n').count(),
            tail.matches("\r\n").count(),
            "追加部分全是 CRLF：{tail:?}"
        );
        assert!(tail.ends_with("\r\n"));
        assert_appended(existing.as_bytes(), &output, &added);
        let parsed = parse_toml(&output, State::Missing);
        assert!(parsed.issue.is_none());
        assert_eq!(parsed.values["my server.v2"].client_fields.len(), 1);
    }

    #[test]
    fn toml_append_follows_lf_and_keeps_existing_header() {
        let existing = "[mcp_servers]\n\n[mcp_servers.old]\ncommand = \"old\"\n";
        let def = stdio("new");
        let output = merge_toml(Some(existing.as_bytes()), &[("new", &def)]).unwrap();
        assert_eq!(
            std::str::from_utf8(&output).unwrap(),
            format!("{existing}\n[mcp_servers.new]\ncommand = \"new\"\n")
        );
        assert_appended(existing.as_bytes(), &output, &[("new", &def)]);
    }

    #[test]
    fn toml_append_to_missing_or_empty_file() {
        let def = stdio("new");
        let expected = "[mcp_servers.new]\ncommand = \"new\"\n";
        assert_eq!(
            merge_toml(None, &[("new", &def)]).unwrap(),
            expected.as_bytes()
        );
        let bom = "\u{feff}";
        assert_eq!(
            merge_toml(Some(bom.as_bytes()), &[("new", &def)]).unwrap(),
            format!("{bom}{expected}").as_bytes()
        );
    }

    #[test]
    fn toml_inline_servers_get_member_in_place() {
        let existing = "\u{feff}model = \"x\"\r\nmcp_servers = { old = { command = \"old\" } } # 内联\r\nz = 1";
        let def = stdio("new");
        let output = merge_toml(Some(existing.as_bytes()), &[("new", &def)]).unwrap();
        assert_eq!(
            std::str::from_utf8(&output).unwrap(),
            "\u{feff}model = \"x\"\r\nmcp_servers = { old = { command = \"old\" }, new = { command = \"new\" } } # 内联\r\nz = 1"
        );
        assert_appended(existing.as_bytes(), &output, &[("new", &def)]);
        let empty = "mcp_servers = {}\n";
        let output = merge_toml(Some(empty.as_bytes()), &[("new", &def)]).unwrap();
        assert_appended(empty.as_bytes(), &output, &[("new", &def)]);
    }

    #[test]
    fn toml_existing_name_is_not_overwritten_and_bad_shapes_are_refused() {
        let def = stdio("new");
        let existing = b"[mcp_servers.new]\ncommand = \"mine\"\n";
        let error = merge_toml(Some(existing), &[("new", &def)]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        for bad in ["mcp_servers = 1\n", "[[mcp_servers]]\nx = 1\n"] {
            let error = merge_toml(Some(bad.as_bytes()), &[("new", &def)]).unwrap_err();
            let reason = error.get_ref().and_then(|e| e.downcast_ref::<Refused>());
            assert!(
                reason.is_some_and(|r| r.reason.contains("mcp_servers")),
                "{bad}"
            );
        }
    }

    /// AC1–AC3：设置文件或父目录是软链接 → 位置用真实路径；坏链原样保留，读出来是拒绝
    #[test]
    #[cfg(unix)]
    fn symlinked_config_paths_resolve_to_the_real_file() {
        use crate::test_support::TempTree;
        let t = TempTree::new();
        let home = t.dir("home");
        let real_claude = t.dir("dotfiles").join("claude.json");
        std::fs::write(&real_claude, b"{}").unwrap();
        t.link(&home.join(".claude.json"), &real_claude);
        // 父目录是软链接、文件还不存在：解析父目录，第一次写入落到真实目录
        let real_cursor = t.dir("dotfiles/cursor");
        t.link(&home.join(".cursor"), &real_cursor);
        // 扩展名变了：不解析（读写按扩展名分格式）
        let odd = t.dir("dotfiles").join("gemini-settings");
        std::fs::write(&odd, b"{}").unwrap();
        t.dir("home/.gemini");
        t.link(&home.join(".gemini/settings.json"), &odd);
        t.dir("home/.codex");
        t.link(&home.join(".codex/config.toml"), &t.root().join("gone"));
        let harness = |id: &str| Harness {
            id: id.into(),
            display_name: id.into(),
            brand: id.into(),
            brand_name: id.into(),
            project_dir: None,
            global_dir: None,
            universal: false,
            agent_dirs: Vec::new(),
            managed_global_dir: false,
            agent_labels: None,
        };
        let env = Env {
            apps: Vec::new(),
            home: home.clone(),
            vars: Default::default(),
        };
        let found = locations(
            &env,
            &[
                harness("claude-code"),
                harness("cursor"),
                harness("codex"),
                harness("gemini-cli"),
            ],
            &[],
        );
        let path_of = |id: &str| found.iter().find(|l| l.id == id).unwrap().path.clone();
        assert_eq!(path_of("claude-code"), real_claude);
        assert_eq!(path_of("cursor"), real_cursor.join("mcp.json"));
        assert_eq!(path_of("gemini-cli"), home.join(".gemini/settings.json"));
        assert!(matches!(read(&path_of("gemini-cli")), State::Bad(_)));
        // 坏链：原样保留，读出来是拒绝
        assert_eq!(path_of("codex"), home.join(".codex/config.toml"));
        assert!(matches!(read(&path_of("codex")), State::Bad(_)));
        // 项目本身是软链接、里面还没有 .cursor：解析到真实项目再拼回去
        let real_project = t.dir("dotfiles/proj");
        t.link(&home.join("proj"), &real_project);
        let linked = locations(
            &env,
            &[harness("cursor")],
            std::slice::from_ref(&home.join("proj")),
        );
        let linked_loc = linked
            .iter()
            .find(|l| l.domain.starts_with("project:"))
            .unwrap();
        assert_eq!(linked_loc.path, real_project.join(".cursor/mcp.json"));
        // macOS 的 /var → /private/var 不算用户的软链接：没 canonicalize 过的项目路径原样保留
        let project = std::env::temp_dir().join("sophia-symlink-test-project");
        std::fs::create_dir_all(&project).unwrap();
        let in_project = locations(&env, &[harness("cursor")], std::slice::from_ref(&project));
        let project_loc = in_project
            .iter()
            .find(|l| l.domain.starts_with("project:"))
            .unwrap();
        assert_eq!(project_loc.path, project.join(".cursor/mcp.json"));
        let _ = std::fs::remove_dir(&project);
    }

    #[test]
    fn blank_codex_home_falls_back_to_home_directory() {
        let harness = Harness {
            id: "codex".into(),
            display_name: "Codex".into(),
            brand: "codex".into(),
            brand_name: "Codex".into(),
            project_dir: None,
            global_dir: None,
            universal: false,
            agent_dirs: Vec::new(),
            managed_global_dir: false,
            agent_labels: None,
        };
        let env = Env {
            apps: Vec::new(),
            home: PathBuf::from("/tmp/home"),
            vars: [("CODEX_HOME".into(), "  ".into())].into_iter().collect(),
        };
        assert_eq!(
            locations(&env, &[harness], &[])[0].path,
            PathBuf::from("/tmp/home/.codex/config.toml")
        );
    }
}

#[cfg(test)]
mod endpoint_tests {
    use super::*;
    use crate::test_support::TempTree;

    fn loc(id: &str, harness_id: &str, path: PathBuf) -> McpLocation {
        McpLocation {
            id: id.into(),
            label: id.into(),
            harness_id: harness_id.into(),
            domain: "global".into(),
            path,
            selector: None,
            matrix_hidden: false,
            mirrors: Vec::new(),
        }
    }

    /// 行详情的 `命令` / `地址`：取单份定义，stdio 写命令 + 参数，HTTP 写地址；凭据一律脱敏，
    /// 找不到的位置、名字都不写这一行
    #[test]
    fn endpoint_reads_one_definition_and_masks_secrets() {
        let t = TempTree::new();
        let root = t.root();
        let claude = root.join("claude.json");
        let codex = root.join("config.toml");
        fs::write(
            &claude,
            serde_json::to_vec(&serde_json::json!({"mcpServers": {
                "excalidraw": {"command": "npx", "args": ["-y", "@excalidraw/mcp", "--api-key", "sk-live-123456"]},
                "bare": {"command": "uvx"},
                "remote": {"type": "http", "url": "https://mcp.example.test/v1?token=abcd1234efgh&team=core"},
            }}))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            &codex,
            "[mcp_servers.github]\nurl = \"https://api.githubcopilot.com/mcp/\"\n",
        )
        .unwrap();
        let locations = vec![
            loc("claude", "claude-code", claude),
            loc("codex", "codex", codex),
        ];

        let stdio = endpoint(&locations, "excalidraw", "claude").unwrap();
        assert_eq!(stdio.kind, "command");
        assert_eq!(stdio.text, "npx -y @excalidraw/mcp --api-key …");
        assert!(!serde_json::to_string(&stdio).unwrap().contains("sk-live"));

        let bare = endpoint(&locations, "bare", "claude").unwrap();
        assert_eq!((bare.kind.as_str(), bare.text.as_str()), ("command", "uvx"));

        let remote = endpoint(&locations, "remote", "claude").unwrap();
        assert_eq!(remote.kind, "url");
        assert!(remote.text.starts_with("https://mcp.example.test/v1"));
        assert!(!remote.text.contains("abcd1234efgh"), "{}", remote.text);

        let toml = endpoint(&locations, "github", "codex").unwrap();
        assert_eq!(
            (toml.kind.as_str(), toml.text.as_str()),
            ("url", "https://api.githubcopilot.com/mcp/")
        );

        assert_eq!(
            endpoint(&locations, "github", "claude"),
            None,
            "这一处没有这个名字"
        );
        assert_eq!(
            endpoint(&locations, "excalidraw", "nowhere"),
            None,
            "没有这一处"
        );
    }
}

#[cfg(test)]
mod undo_tests {
    use super::*;
    use crate::test_support::{backups, TempTree};

    fn loc(id: &str, path: &Path) -> McpLocation {
        McpLocation {
            id: id.into(),
            label: id.into(),
            harness_id: "claude-code".into(),
            domain: "global".into(),
            path: path.to_path_buf(),
            selector: None,
            matrix_hidden: false,
            mirrors: Vec::new(),
        }
    }

    fn sel(target_id: &str) -> McpSelection {
        McpSelection {
            source_id: "source".into(),
            name: "docs".into(),
            target_id: target_id.into(),
        }
    }

    /// source 里有一个 `docs`，写进各个 target；返回报告与取走的撤销记录
    fn write(tree: &TempTree, targets: &[&Path]) -> (McpReport, McpUndo) {
        let source = tree.root().join("source.json");
        fs::write(&source, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        let mut locations = vec![loc("source", &source)];
        let mut selections = Vec::new();
        for (index, target) in targets.iter().enumerate() {
            let id = format!("t{index}");
            locations.push(loc(&id, target));
            selections.push(sel(&id));
        }
        let mut report = execute(prepare(&locations, &selections), false, backups());
        assert!(report
            .entries
            .iter()
            .all(|entry| entry.outcome == "created"));
        let undo = report.take_undo().expect("有可撤销的写入");
        (report, undo)
    }

    const ORIGINAL: &[u8] = b"{\n  \"mcpServers\": {},\n  \"keep\": 1\n}\n";

    #[test]
    fn untouched_write_restores_original_bytes() {
        let tree = TempTree::new();
        let target = tree.root().join("target.json");
        fs::write(&target, ORIGINAL).unwrap();
        let (report, undo) = write(&tree, &[&target]);
        assert_ne!(fs::read(&target).unwrap(), ORIGINAL);

        let result = undo_write(&undo);
        assert_eq!(result.outcome, "undone");
        assert_eq!(result.files[0].outcome, "restored");
        assert_eq!(result.files[0].backup_path, report.entries[0].backup_path);
        assert_eq!(fs::read(&target).unwrap(), ORIGINAL);
    }

    #[test]
    fn undo_is_refused_after_external_modification() {
        let tree = TempTree::new();
        let target = tree.root().join("target.json");
        fs::write(&target, ORIGINAL).unwrap();
        let (_, undo) = write(&tree, &[&target]);
        fs::write(&target, b"{\"mcpServers\":{},\"edited\":true}").unwrap();

        let result = undo_write(&undo);
        assert_eq!(result.outcome, "changed");
        assert_eq!(result.message, undo_changed_message());
        assert_eq!(result.files[0].outcome, "changed");
        let backup = result.files[0].backup_path.clone().expect("有备份可显示");
        assert_eq!(fs::read(backup).unwrap(), ORIGINAL);
        assert_eq!(
            fs::read(&target).unwrap(),
            b"{\"mcpServers\":{},\"edited\":true}"
        );
    }

    #[test]
    fn undo_of_created_file_removes_only_the_file() {
        let tree = TempTree::new();
        let dir = tree.root().join("new-dir");
        let target = dir.join("target.json");
        let (report, undo) = write(&tree, &[&target]);
        assert!(target.is_file());
        assert_eq!(report.entries[0].backup_path, None);

        let result = undo_write(&undo);
        assert_eq!(result.outcome, "undone");
        assert_eq!(result.files[0].outcome, "removed");
        assert!(fs::symlink_metadata(&target).is_err());
        assert!(dir.is_dir(), "父目录保留");
    }

    #[test]
    fn created_file_edited_afterwards_is_not_removed() {
        let tree = TempTree::new();
        let target = tree.root().join("target.json");
        let (_, undo) = write(&tree, &[&target]);
        fs::write(&target, b"{\"mcpServers\":{}}").unwrap();

        assert_eq!(undo_write(&undo).outcome, "changed");
        assert_eq!(fs::read(&target).unwrap(), b"{\"mcpServers\":{}}");
    }

    #[test]
    fn batch_is_refused_whole_if_any_file_changed() {
        let tree = TempTree::new();
        let first = tree.root().join("first.json");
        let second = tree.root().join("second.json");
        fs::write(&first, ORIGINAL).unwrap();
        fs::write(&second, ORIGINAL).unwrap();
        let (_, undo) = write(&tree, &[&first, &second]);
        let first_written = fs::read(&first).unwrap();
        fs::write(&second, b"{}").unwrap();

        let result = undo_write(&undo);
        assert_eq!(result.outcome, "changed");
        let outcome = |path: &Path| {
            result
                .files
                .iter()
                .find(|file| file.target_path == path)
                .unwrap()
                .outcome
                .clone()
        };
        assert_eq!(outcome(&first), "unchanged");
        assert_eq!(outcome(&second), "changed");
        assert_eq!(fs::read(&first).unwrap(), first_written, "未改动的也不动");
        assert_eq!(fs::read(&second).unwrap(), b"{}");
    }

    #[test]
    fn batch_undo_restores_every_file() {
        let tree = TempTree::new();
        let first = tree.root().join("first.json");
        let second = tree.root().join("second.json");
        fs::write(&first, ORIGINAL).unwrap();
        let (_, undo) = write(&tree, &[&first, &second]);
        assert_eq!(undo.target_paths().count(), 2);

        let result = undo_write(&undo);
        assert_eq!(result.outcome, "undone");
        assert_eq!(fs::read(&first).unwrap(), ORIGINAL);
        assert!(fs::symlink_metadata(&second).is_err());
    }

    #[test]
    fn toml_target_is_appended_in_place_and_undo_restores_bytes() {
        let tree = TempTree::new();
        let target = tree.root().join("config.toml");
        let original: &[u8] =
            b"\xef\xbb\xbf# mine\r\nmodel = \"gpt-5\" # keep\r\n\r\n[profiles.x]\r\nmodel = \"o4\"";
        fs::write(&target, original).unwrap();
        let (_, undo) = write(&tree, &[&target]);
        let written = fs::read(&target).unwrap();
        assert!(written.starts_with(original), "原文逐字节保留");
        assert_eq!(
            &written[original.len()..],
            b"\r\n\r\n[mcp_servers.docs]\r\ncommand = \"docs\"\r\n"
        );
        assert_eq!(undo_write(&undo).outcome, "undone");
        assert_eq!(fs::read(&target).unwrap(), original);
    }

    #[test]
    fn chosen_copy_is_written_when_same_name_differs() {
        // 同名 docs 有两份不一样的：写进哪一份由选择里的来源决定，另一份不参与
        let tree = TempTree::new();
        let first = tree.root().join("first.json");
        let second = tree.root().join("second.json");
        let target = tree.root().join("config.toml");
        fs::write(&first, br#"{"mcpServers":{"docs":{"command":"one"}}}"#).unwrap();
        fs::write(
            &second,
            br#"{"mcpServers":{"docs":{"url":"https://two/mcp"}}}"#,
        )
        .unwrap();
        let locations = vec![
            loc("first", &first),
            loc("second", &second),
            loc("target", &target),
        ];
        let overview = scan(&locations);
        let cells = |source: &str| {
            overview
                .entries
                .iter()
                .find(|entry| entry.source_id == source)
                .unwrap()
                .cells
                .clone()
        };
        let state = |source: &str, target: &str| {
            cells(source)
                .into_iter()
                .find(|cell| cell.target_id == target)
                .unwrap()
                .state
        };
        assert_eq!(state("first", "second"), McpCellState::Conflict);
        assert_eq!(state("first", "target"), McpCellState::Missing);
        assert_eq!(state("second", "target"), McpCellState::Missing);

        let selection = McpSelection {
            source_id: "second".into(),
            name: "docs".into(),
            target_id: "target".into(),
        };
        let report = execute(prepare(&locations, &[selection]), false, backups());
        assert_eq!(report.entries[0].outcome, "created");
        let written = parse_toml(&fs::read(&target).unwrap(), State::Missing);
        assert_eq!(
            written.values["docs"].url.as_deref(),
            Some("https://two/mcp")
        );
        assert_eq!(written.values["docs"].command, None);
    }

    #[test]
    fn failed_write_has_no_undo() {
        let tree = TempTree::new();
        let source = tree.root().join("source.json");
        let target = tree.root().join("target.json");
        fs::write(&source, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        fs::write(&target, ORIGINAL).unwrap();
        let locations = vec![loc("source", &source), loc("t0", &target)];
        let plan = prepare(&locations, &[sel("t0")]);
        fs::write(&target, b"{\"mcpServers\":{}}").unwrap();
        let mut report = execute(plan, false, backups());
        assert_eq!(report.entries[0].outcome, "failed");
        assert!(report.take_undo().is_none());
    }

    /// spec 2026-10-04-local-diagnostics R12 / AC11：目标所在的文件夹不让写时说「没有写入权限」，
    /// 不再一律说写入失败；文件一个字节没动（以 root 运行时权限不拦，跳过）
    #[cfg(unix)]
    #[test]
    fn write_into_a_read_only_folder_says_no_permission() {
        use std::os::unix::fs::PermissionsExt;
        let tree = TempTree::new();
        let source = tree.root().join("source.json");
        let dir = tree.dir("ro");
        let target = dir.join("target.json");
        fs::write(&source, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        fs::write(&target, ORIGINAL).unwrap();
        let locations = vec![loc("source", &source), loc("t0", &target)];
        let plan = prepare(&locations, &[sel("t0")]);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(dir.join("probe"), b"x").is_ok() {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let report = execute(plan, false, backups());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(report.entries[0].outcome, "failed");
        assert_eq!(report.entries[0].message, "没有写入权限，未改动");
        // 说得出原因的没有原文：提示条照旧接这一句
        assert_eq!(report.entries[0].detail, None);
        assert_eq!(fs::read(&target).unwrap(), ORIGINAL);
    }

    /// 分不出原因的失败（spec #239 第 43 条）：`message` 是兜底句，系统原文另给（`detail`），
    /// 前端据此提示条只写失败句、不拼原文。备份目录的上一级是个文件：建不出备份目录，不是没权限、磁盘满、只读
    #[test]
    fn unclassified_failure_carries_the_raw_text_apart() {
        let tree = TempTree::new();
        let source = tree.root().join("source.json");
        let target = tree.root().join("target.json");
        let blocker = tree.root().join("not-a-dir");
        fs::write(&source, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        fs::write(&target, ORIGINAL).unwrap();
        fs::write(&blocker, b"x").unwrap();
        let plan = prepare(&[loc("source", &source), loc("t0", &target)], &[sel("t0")]);
        let report = execute(plan, false, &blocker.join("backups"));
        assert_eq!(report.entries[0].outcome, "failed");
        assert_eq!(
            report.entries[0].message,
            crate::t!("mcp.report.backupFailedNotWritten")
        );
        let detail = report.entries[0].detail.as_deref().unwrap_or_default();
        assert!(!detail.is_empty(), "{:?}", report.entries[0]);
        assert_eq!(fs::read(&target).unwrap(), ORIGINAL);
    }

    /// 备份目录不让写：说「备份时没有写入权限」，不再只说备份失败（Codex 复审 6/7）
    #[cfg(unix)]
    #[test]
    fn backup_into_a_read_only_folder_says_why() {
        use std::os::unix::fs::PermissionsExt;
        let tree = TempTree::new();
        let source = tree.root().join("source.json");
        let target = tree.root().join("target.json");
        let locked = tree.dir("locked");
        let ro = locked.join("backups");
        fs::write(&source, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        fs::write(&target, ORIGINAL).unwrap();
        let plan = prepare(&[loc("source", &source), loc("t0", &target)], &[sel("t0")]);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(locked.join("probe"), b"x").is_ok() {
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let report = execute(plan, false, &ro);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(report.entries[0].outcome, "failed");
        assert_eq!(report.entries[0].message, "备份时没有写入权限，未改动");
        assert_eq!(fs::read(&target).unwrap(), ORIGINAL);
    }

    /// 撤销写回时文件夹不让写：那一份说「没有写入权限」，不再只说撤销失败
    #[cfg(unix)]
    #[test]
    fn undo_into_a_read_only_folder_says_why() {
        use std::os::unix::fs::PermissionsExt;
        let tree = TempTree::new();
        let dir = tree.dir("ro");
        let target = dir.join("target.json");
        fs::write(&target, ORIGINAL).unwrap();
        let (_, undo) = write(&tree, &[&target]);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(dir.join("probe"), b"x").is_ok() {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let result = undo_write(&undo);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.outcome, "failed");
        assert_eq!(result.files[0].outcome, "failed");
        assert_eq!(result.files[0].message, "没有写入权限，未改动");
    }
}

#[cfg(test)]
mod count_tests {
    use super::*;
    use crate::report::{Kind, PENDING};
    use crate::test_support::{backups, TempTree};
    use std::sync::Mutex;

    /// 全局计数器是进程共用的：开关与取数都在锁里，以后加的计数测试同样串行
    static LOCK: Mutex<()> = Mutex::new(());

    fn loc(id: &str, path: &Path) -> McpLocation {
        McpLocation {
            id: id.into(),
            label: id.into(),
            harness_id: "claude-code".into(),
            domain: "global".into(),
            path: path.to_path_buf(),
            selector: None,
            matrix_hidden: false,
            mirrors: Vec::new(),
        }
    }

    /// 先按「目标还不存在」生成计划，再用 `setup` 把目标弄成要测的样子，并把计划里的目标状态更新成磁盘上的现状
    /// （预览时看到的就是这份内容）。
    /// 返回这次执行记下的 (writeFailure, internal) 次数；同时断言没收事件原文
    fn run(toml_target: bool, reporting: bool, setup: impl FnOnce(&Path)) -> (u32, u32) {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let tree = TempTree::new();
        let source = tree.root().join("source.json");
        fs::write(&source, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        let target = tree
            .root()
            .join(if toml_target { "config.toml" } else { "t.json" });
        let mut target_location = loc("t0", &target);
        if toml_target {
            target_location.harness_id = "codex".into();
        }
        let locations = vec![loc("source", &source), target_location];
        let selections = vec![McpSelection {
            source_id: "source".into(),
            name: "docs".into(),
            target_id: "t0".into(),
        }];
        let mut plan = prepare(&locations, &selections);
        assert_eq!(plan.private.len(), 1);
        setup(&target);
        plan.private[0].target = read(&target);
        PENDING.set_enabled(reporting);
        PENDING.clear();
        let report = execute(plan, false, backups());
        let taken = PENDING.take();
        let events = PENDING.take_events();
        PENDING.set_enabled(false);
        assert!(events.is_empty(), "只计次数，不收事件原文");
        assert!(report.entries.iter().all(|e| e.outcome == "failed"));
        assert_eq!(report.entries.len(), 1);
        let sum = |kind| taken.values().map(|c| c.get(kind)).sum::<u32>();
        (sum(Kind::WriteFailure), sum(Kind::Internal))
    }

    #[test]
    fn user_file_shape_refusal_is_not_counted() {
        // `mcp_servers` 不是表：用户文件本身的状态，不是 Sophia 的改写出错
        let bad = |p: &Path| fs::write(p, b"mcp_servers = 1\n").unwrap();
        assert_eq!(run(true, true, bad), (0, 0));
    }

    #[test]
    fn only_failed_write_back_verification_counts_as_internal() {
        assert!(merge_unverified(&unverified("核对没通过")));
        assert!(!merge_unverified(&refused("不是合法 TOML")));
        assert!(!merge_unverified(&io::Error::from(
            io::ErrorKind::AlreadyExists
        )));
    }
}

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

#[cfg(test)]
mod helper_tests;
mod removal;
pub mod sources;
#[cfg(feature = "weiboap")]
mod weiboap;

pub use removal::{
    execute_removal, prepare_removal, McpRemovalPlan, McpRemoveAction, ORIGINAL_MESSAGE,
};

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
        return Err(format!(
            "读不到 {} 的配置，先修好再开自动添加",
            source.label
        ));
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
            });
        }
    }
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
    /// 命令层把 `undo` 登记进内存后填的撤销 id；core 从不填。没有可撤销的写入时为 `None`。
    #[serde(default)]
    pub undo_id: Option<String>,
    /// 撤销记录含写前内容与写后指纹，不出进程：命令层用 `take_undo` 取走后只把 id 交给前端。
    #[serde(skip)]
    undo: McpUndo,
}

impl McpReport {
    /// 取走本次写入的撤销记录。没有写入任何文件，或有写入无法撤销（如 WeiboAP 数据库、
    /// 写后读回对不上）时返回 `None`：宁可不给撤销，也不给只撤一半的撤销。
    pub fn take_undo(&mut self) -> Option<McpUndo> {
        let undo = std::mem::take(&mut self.undo);
        (!undo.blocked && !undo.files.is_empty()).then_some(undo)
    }
}

/// 一次 MCP 写入（可能跨多个文件）的撤销记录。只能由 `execute` 产生，调用方无法伪造路径。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct McpUndo {
    files: Vec<UndoFile>,
    blocked: bool,
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
    pub message: String,
    pub files: Vec<McpUndoFileResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUndoFileResult {
    pub target_path: PathBuf,
    /// 写入时留下的 `.mcp.bak`；新建文件的写入没有备份。撤不了时前端据此「在访达中显示备份」
    pub backup_path: Option<PathBuf>,
    /// `restored` / `removed` / `changed`（写后被改过）/ `unchanged`（没被改过，但因别的文件被改过而未动）
    /// / `failed` / `skipped`（前面的文件失败后未尝试）
    pub outcome: String,
    pub message: String,
}

pub const UNDO_CHANGED_MESSAGE: &str = "写入之后文件又被改过，没法安全撤销";

/// 撤销一次 MCP 写入：先逐个确认所有目标仍是写后的样子，任何一个对不上就整体拒绝；
/// 全部对得上再逐个还原（原有文件经 `atomicfile::atomic_write` 写回写前内容，新建的文件删掉，
/// 不删父目录）。多文件无法原子地一起还原，途中失败会停下并逐文件报告。
pub fn undo_write(undo: &McpUndo) -> McpUndoReport {
    let result = |file: &UndoFile, outcome: &str, message: &str| McpUndoFileResult {
        target_path: file.target.clone(),
        backup_path: file.backup_path.clone(),
        outcome: outcome.into(),
        message: message.into(),
    };
    let unchanged: Vec<bool> = undo
        .files
        .iter()
        .map(|file| atomicfile::same(&file.target, &file.written))
        .collect();
    if unchanged.iter().any(|ok| !ok) {
        return McpUndoReport {
            outcome: "changed".into(),
            message: UNDO_CHANGED_MESSAGE.into(),
            files: undo
                .files
                .iter()
                .zip(&unchanged)
                .map(|(file, ok)| {
                    if *ok {
                        result(file, "unchanged", "未改动，因其他文件被改过而未撤销")
                    } else {
                        result(file, "changed", UNDO_CHANGED_MESSAGE)
                    }
                })
                .collect(),
        };
    }
    let mut files = Vec::new();
    let mut failed = false;
    for file in &undo.files {
        if failed {
            files.push(result(file, "skipped", "前面的文件撤销失败，未尝试"));
            continue;
        }
        let restored = match &file.before {
            FileState::Present(snap) => {
                atomicfile::atomic_write(&file.target, &snap.bytes, &file.written)
                    .map(|_| ("restored", "已还原为写入前的内容"))
            }
            FileState::Missing => remove_created(&file.target, &file.written)
                .map(|_| ("removed", "已删除这次写入新建的文件")),
        };
        match restored {
            Ok((outcome, message)) => files.push(result(file, outcome, message)),
            Err(error) if error.to_string() == "changed" => {
                failed = true;
                files.push(result(file, "changed", UNDO_CHANGED_MESSAGE));
            }
            Err(_) => {
                failed = true;
                files.push(result(file, "failed", "撤销失败，文件保持原样"));
            }
        }
    }
    McpUndoReport {
        outcome: if failed { "failed" } else { "undone" }.into(),
        message: if failed {
            "撤销没有全部完成，请逐个查看"
        } else {
            "已撤销这次写入"
        }
        .into(),
        files,
    }
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
    /// 只在从格子上移除副本（`execute_removal`）成功的条目上有：移除的那份与来源原版是否一样。
    /// 一样时再点一次写回的就是同样的内容，前端不给撤销；不一样才给
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identical: Option<bool>,
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
}

/// 认得「用命令生成请求头」的 agent（harness id）。别的 agent 无法写入这种定义：
/// 丢掉命令就是一份没有凭据的坏配置，所以整条拒绝，不静默丢字段
const HELPER_HARNESSES: [&str; 2] = ["claude-code", "codex"];

/// 位置名里的 agent 名：`Claude Code · Local MCPs` → `Claude Code`
fn agent_name(location: &McpLocation) -> &str {
    location
        .label
        .split(" · ")
        .next()
        .unwrap_or(&location.label)
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

    /// 只有 `HELPER_HARNESSES` 里的 agent 接得住时为这几家；谁都接得住（或哪儿都搬不过去）为 None
    pub(super) fn only_harnesses(&self) -> Option<Vec<String>> {
        (self.headers_helper.is_some() && !self.unsupported)
            .then(|| HELPER_HARNESSES.iter().map(|h| h.to_string()).collect())
    }

    /// 这份定义无法写入 `target` 的原因（与目标里已有什么无关，只看目标 agent 认不认得这种写法）
    pub(super) fn refusal_for(&self, target: &McpLocation) -> Option<String> {
        (self.headers_helper.is_some() && !HELPER_HARNESSES.contains(&target.harness_id.as_str()))
            .then(|| format!("{} 不支持用命令生成请求头", agent_name(target)))
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
                only_harnesses: def.only_harnesses(),
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
                    None => match source.refusal_for(target) {
                        Some(reason) => (McpCellState::Unsupported, Some(reason)),
                        None => (McpCellState::Missing, None),
                    },
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

/// URL 里的凭据：查询串与 `#` 片段里的值换成 `…`、键留着（`?api_key=…`、`#access_token=…`）；
/// 地址里的账号密码（`https://user:pass@host`）整段换成 `…:…@`，账号本身也可能是令牌，一并不给
fn url_without_secrets(url: &str) -> String {
    let (url, fragment) = match url.split_once('#') {
        Some((url, fragment)) => (url, Some(fragment)),
        None => (url, None),
    };
    let (base, query) = match url.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (url, None),
    };
    let mut out = match base.split_once("://") {
        Some((scheme, rest)) => {
            let end = rest.find('/').unwrap_or(rest.len());
            match rest[..end].rsplit_once('@') {
                Some((userinfo, host)) => {
                    let masked = if userinfo.contains(':') {
                        "…:…"
                    } else {
                        "…"
                    };
                    format!("{scheme}://{masked}@{host}{}", &rest[end..])
                }
                None => base.to_owned(),
            }
        }
        None => base.to_owned(),
    };
    let mask_pairs = |part: &str| {
        part.split('&')
            .map(|pair| match pair.split_once('=') {
                Some((key, _)) => format!("{key}=…"),
                None => pair.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("&")
    };
    if let Some(query) = query {
        out = format!("{out}?{}", mask_pairs(query));
    }
    if let Some(fragment) = fragment {
        out = format!("{out}#{}", mask_pairs(fragment));
    }
    out
}

fn secretish(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    [
        "key", "token", "secret", "password", "auth", "bearer", "cookie",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
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
        if let Some(reason) = definition.refusal_for(target_location) {
            issues.push(issue(selection, &reason));
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
        Err(error) => {
            // 文本级追加核对不过时带上原因
            match error.get_ref().and_then(|e| e.downcast_ref::<Refused>()) {
                Some(reason) => fail(report, &format!("配置无法安全写回：{reason}")),
                None => fail(report, "配置无法安全写回"),
            }
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
    record_undo(report, path, &group[0].target, backup.clone(), &bytes);
    for (index, pending) in group.iter().enumerate() {
        report.entries.push(entry(
            &pending.action,
            "created",
            "已创建 MCP 定义",
            (index == 0).then(|| backup.clone()).flatten(),
        ));
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
                "配置在预览后发生变化",
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
        identical: None,
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
        State::Present(snap) => parse_json(
            &snap.bytes,
            state,
            location.selector.as_deref(),
            json_helper_key(location),
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

fn parse_json(
    bytes: &[u8],
    state: State,
    selector: Option<&str>,
    helper_key: Option<&str>,
) -> Parsed {
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
            .map(|(name, value)| (name.clone(), canon_json(value, helper_key)))
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
fn canon_json(value: &Value, helper_key: Option<&str>) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported_with("MCP 定义不是对象");
    };
    let mut reason = object
        .keys()
        .find(|key| {
            !["type", "command", "args", "env", "url", "headers"].contains(&key.as_str())
                && Some(key.as_str()) != helper_key
        })
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
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields: BTreeMap::new(),
        reason: bad.then(|| reason.unwrap_or_else(|| "连接字段类型无效".into())),
        unsupported: bad,
        headers_helper,
    }
}

/// 这个 agent 的 JSON 配置里「用命令生成请求头」的字段名；不认得这种写法的为 None，
/// 那边的同名字段按不认识的字段处理（搬不过去）
fn json_helper_key(location: &McpLocation) -> Option<&'static str> {
    (location.harness_id == "claude-code").then_some("headersHelper")
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
    const CONNECTION: [&str; 6] = [
        "command",
        "args",
        "env",
        "url",
        "http_headers",
        "http_headers_helper",
    ];
    const CLIENT: [&str; 3] = ["enabled", "startup_timeout_sec", "tool_timeout_sec"];
    let mut reason = table.iter().find_map(|(key, _)| {
        (!CONNECTION.contains(&key) && !CLIENT.contains(&key))
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
    let headers_helper = headers_helper(
        table.get("http_headers_helper").map(|item| item.as_str()),
        "http_headers_helper",
        transport,
        &mut bad,
        &mut reason,
    );
    Canonical {
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields,
        reason: bad.then(|| reason.unwrap_or_else(|| "连接字段类型无效".into())),
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
        reason.get_or_insert_with(|| format!("字段 {field} 必须是非空字符串"));
        return None;
    };
    if transport != "http" {
        *bad = true;
        reason.get_or_insert_with(|| "连接字段不适用于该传输类型".into());
    }
    if reference(command) {
        *bad = true;
        reason.get_or_insert_with(|| format!("字段 {field} 包含变量引用"));
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
        headers_helper: None,
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
        merge_claude_local_json(existing, additions, project, json_helper_key(location))
    } else {
        merge_json(existing, additions, json_helper_key(location))
    }
}
fn merge_json(
    existing: Option<&[u8]>,
    additions: &[(&str, &Canonical)],
    helper_key: Option<&str>,
) -> io::Result<Vec<u8>> {
    let mut bytes = existing.unwrap_or(b"{}").to_vec();
    if serde_json::from_slice::<NoDuplicates>(&bytes).is_err() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "json"));
    }
    let (root_start, root_end, server_range) = raw_json_ranges(&bytes)?;
    let fields: Vec<_> = additions
        .iter()
        .map(|(name, def)| Ok((*name, json_server(def, helper_key)?)))
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
    helper_key: Option<&str>,
) -> io::Result<Vec<u8>> {
    let mut bytes = existing.unwrap_or(b"{}").to_vec();
    if serde_json::from_slice::<NoDuplicates>(&bytes).is_err() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "json"));
    }
    let fields: Vec<_> = additions
        .iter()
        .map(|(name, def)| Ok((*name, json_server(def, helper_key)?)))
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
/// 一条服务的 JSON 写法。`helper_key` 是目标 agent 里「用命令生成请求头」的字段名（见 `json_helper_key`）
fn json_server(def: &Canonical, helper_key: Option<&str>) -> io::Result<Vec<u8>> {
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
            let key = helper_key.ok_or_else(|| refused("目标 agent 不支持用命令生成请求头"))?;
            object.insert(key.into(), Value::String(command.clone()));
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
/// 合并被拒绝的原因（给用户看的一句中文），随 `io::Error` 带到 `execute_group` 显示
#[derive(Debug)]
struct Refused(String);
impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Refused {}
fn refused(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, Refused(reason.into()))
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
        .map_err(|_| refused("配置不是 UTF-8 文本"))?
        .unwrap_or("");
    let doc = toml_edit::Document::parse(text).map_err(|_| refused("配置不是合法的 TOML"))?;
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
            None => return Err(refused("mcp_servers 不是表，没法往里追加")),
        },
    };
    verify_toml_merge(text, &out, additions)?;
    Ok(out.into_bytes())
}

/// 一条服务要写的字段，按固定顺序：command / args / env 或 url / http_headers / http_headers_helper，再是 Codex 客户端字段
fn toml_server(def: &Canonical) -> io::Result<toml_edit::InlineTable> {
    let mut server = toml_edit::InlineTable::new();
    if def.transport == "stdio" {
        let command = def
            .command
            .as_deref()
            .ok_or_else(|| refused("缺少 command"))?;
        server.insert("command", basic_string(command));
        if !def.args.is_empty() {
            let args: toml_edit::Array = def.args.iter().map(|arg| basic_string(arg)).collect();
            server.insert("args", args.into());
        }
        if !def.env.is_empty() {
            server.insert("env", inline(&def.env).into());
        }
    } else {
        let url = def.url.as_deref().ok_or_else(|| refused("缺少 url"))?;
        server.insert("url", basic_string(url));
        if !def.headers.is_empty() {
            server.insert("http_headers", inline(&def.headers).into());
        }
        if let Some(command) = &def.headers_helper {
            server.insert("http_headers_helper", basic_string(command));
        }
    }
    for (key, raw) in &def.client_fields {
        let value = client_value(raw).ok_or_else(|| refused(format!("字段 {key} 的值无效")))?;
        server.insert(key, value);
    }
    Ok(server)
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
        .ok_or_else(|| refused("找不到 mcp_servers 在文件里的位置"))?;
    if span.end == 0 || text.as_bytes().get(span.end - 1) != Some(&b'}') {
        return Err(refused("找不到 mcp_servers 在文件里的位置"));
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
        .map_err(|_| refused("配置不是合法的 TOML"))?;
    let new = after
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| refused("追加之后的配置解析不了，没有写"))?;
    let mut actual = sources::plain_table(new.as_table());
    let Some(Value::Object(servers)) = actual.get_mut("mcp_servers") else {
        return Err(refused("追加之后读不到 mcp_servers，没有写"));
    };
    for (name, def) in additions {
        if servers.remove(*name).is_none() {
            return Err(refused(format!("追加之后读不回 {name}，没有写")));
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
            return Err(refused(format!(
                "追加之后读回的 {name} 和要写的不一样，没有写"
            )));
        }
    }
    let expected = sources::plain_table(old.as_table());
    if !expected.contains_key("mcp_servers") && servers.is_empty() {
        actual.remove("mcp_servers");
    }
    if actual != expected {
        return Err(refused("追加会改动文件里原有的内容，没有写"));
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
            assert!(reason.is_some_and(|r| r.0.contains("mcp_servers")), "{bad}");
        }
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
    use crate::test_support::TempTree;

    fn loc(id: &str, path: &Path) -> McpLocation {
        McpLocation {
            id: id.into(),
            label: id.into(),
            harness_id: "claude-code".into(),
            domain: "global".into(),
            path: path.to_path_buf(),
            selector: None,
            matrix_hidden: false,
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
        let mut report = execute(prepare(&locations, &selections), false);
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
        assert_eq!(result.message, UNDO_CHANGED_MESSAGE);
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
        let report = execute(prepare(&locations, &[selection]), false);
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
        let mut report = execute(plan, false);
        assert_eq!(report.entries[0].outcome, "failed");
        assert!(report.take_undo().is_none());
    }
}

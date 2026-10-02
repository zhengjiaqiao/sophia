//! Claude 桌面应用配置的读写（spec 2026-09-29-claude-third-party-models R28–R34）。
//!
//! 只动四个文件（路径都在 `~/Library/Application Support/` 下）：
//! - `Claude-3p/configLibrary/<SOPHIA_PROFILE_ID>.json`：Sophia 的 profile（R29）
//! - `Claude-3p/configLibrary/_meta.json`：`entries` 里 Sophia 那一条与 `appliedId`（R30）
//! - `Claude-3p/claude_desktop_config.json`、`Claude/claude_desktop_config.json`：顶层 `deploymentMode`（R31）
//!
//! 分三层：`read` 读快照（软链、非普通文件在这里拒绝）；`plan_apply` / `plan_restore` / `inspect` 是对文件文本的
//! 纯函数，算出按 R32 排好序的步骤与要记下的 `Applied`；`apply_step` / `execute` 按步写（`atomicfile`：备份、
//! 原子替换、写前写后指纹校验）。每一步都可重入：文件已是目标内容就跳过。
//!
//! 什么时候写（桌面应用不在运行）、`phase` 的保存、路由清单与服务由调用方（gateway 的 `App`）负责；
//! 这里的函数只接收目录根，测试指向临时目录。
use super::settings::{Applied, Original, Originals, Phase, Written, WrittenModel};
use crate::atomicfile::{self, FileState, ReadError};
use crate::jsonedit::{self, Layout};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Sophia 的 profile 的固定 id（末 12 位是 `sophia` 的十六进制，与 lab 脚本同一个）
pub const SOPHIA_PROFILE_ID: &str = "00000000-0000-4000-8000-736f70686961";
/// `_meta.json` 里 Sophia 条目的名字
pub const SOPHIA_ENTRY_NAME: &str = "Sophia";
/// 已选第一个写的角色 id，排 `inferenceModels` 第一项：Claude 把第一项当初始默认（R29）
pub const FIRST_ROLE: &str = "claude-sonnet-5";
/// 已选多于一个时最后一个写的角色 id：Claude 用 Haiku 档起标题、跑子任务（R29）
pub const HAIKU_ROLE: &str = "claude-haiku-4-5";
/// 记录里代替令牌的占位
pub const TOKEN_PLACEHOLDER: &str = "<token>";
/// 改写前备份的后缀：`<名>.sophia-models[.N].bak`
pub const BACKUP_SUFFIX: &str = "sophia-models";

const MODE_KEY: &str = "deploymentMode";
const MODE_3P: &str = "3p";
const MODE_1P: &str = "1p";
const APPLIED_ID: &str = "appliedId";
const ENTRIES: &str = "entries";
const API_KEY: &str = "inferenceGatewayApiKey";
const CHAT_TAB: &str = "chatTabEnabled";
/// Sophia 管的 profile 键（`chatTabEnabled` 只在没有时补，不算在内）
const MANAGED_KEYS: [&str; 5] = [
    "inferenceProvider",
    "inferenceGatewayBaseUrl",
    API_KEY,
    "inferenceGatewayAuthScheme",
    "inferenceModels",
];

/// 四个文件
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopFile {
    /// `Claude-3p/configLibrary/<SOPHIA_PROFILE_ID>.json`
    Profile,
    /// `Claude-3p/configLibrary/_meta.json`
    Meta,
    /// `Claude-3p/claude_desktop_config.json`
    Claude3pConfig,
    /// `Claude/claude_desktop_config.json`（同一文件里的 `mcpServers` 归 MCP 页管）
    ClaudeConfig,
}

impl DesktopFile {
    pub const ALL: [DesktopFile; 4] = [
        DesktopFile::Profile,
        DesktopFile::Meta,
        DesktopFile::Claude3pConfig,
        DesktopFile::ClaudeConfig,
    ];

    /// 相对 `Application Support` 的路径，用于提示
    pub fn label(self) -> &'static str {
        match self {
            DesktopFile::Profile => {
                "Claude-3p/configLibrary/00000000-0000-4000-8000-736f70686961.json"
            }
            DesktopFile::Meta => "Claude-3p/configLibrary/_meta.json",
            DesktopFile::Claude3pConfig => "Claude-3p/claude_desktop_config.json",
            DesktopFile::ClaudeConfig => "Claude/claude_desktop_config.json",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// 桌面应用的两个数据目录
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopDirs {
    /// 标准模式：`…/Claude`
    pub claude: PathBuf,
    /// 第三方模式：`…/Claude-3p`
    pub claude_3p: PathBuf,
}

impl DesktopDirs {
    /// `app_support` 是 `~/Library/Application Support`（测试里是临时目录）
    pub fn new(app_support: &Path) -> Self {
        Self {
            claude: app_support.join("Claude"),
            claude_3p: app_support.join("Claude-3p"),
        }
    }

    pub fn path(&self, file: DesktopFile) -> PathBuf {
        match file {
            DesktopFile::Profile => self.profile_path(SOPHIA_PROFILE_ID),
            DesktopFile::Meta => self.library().join("_meta.json"),
            DesktopFile::Claude3pConfig => self.claude_3p.join("claude_desktop_config.json"),
            DesktopFile::ClaudeConfig => self.claude.join("claude_desktop_config.json"),
        }
    }

    fn library(&self) -> PathBuf {
        self.claude_3p.join("configLibrary")
    }

    fn profile_path(&self, id: &str) -> PathBuf {
        self.library().join(format!("{id}.json"))
    }
}

/// 四个文件的原文（`None`＝不存在），外加 `others`：`_meta.json` 当前 `appliedId` 与记下的原 `appliedId`
/// 指的那几份别家 profile（id → 原文；不存在、读不了的不在里面）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopFiles {
    pub profile: Option<Vec<u8>>,
    pub meta: Option<Vec<u8>>,
    pub claude_3p_config: Option<Vec<u8>>,
    pub claude_config: Option<Vec<u8>>,
    pub others: BTreeMap<String, Vec<u8>>,
}

impl DesktopFiles {
    pub fn get(&self, file: DesktopFile) -> Option<&[u8]> {
        match file {
            DesktopFile::Profile => self.profile.as_deref(),
            DesktopFile::Meta => self.meta.as_deref(),
            DesktopFile::Claude3pConfig => self.claude_3p_config.as_deref(),
            DesktopFile::ClaudeConfig => self.claude_config.as_deref(),
        }
    }

    fn slot(&mut self, file: DesktopFile) -> &mut Option<Vec<u8>> {
        match file {
            DesktopFile::Profile => &mut self.profile,
            DesktopFile::Meta => &mut self.meta,
            DesktopFile::Claude3pConfig => &mut self.claude_3p_config,
            DesktopFile::ClaudeConfig => &mut self.claude_config,
        }
    }
}

/// 某一时刻四个文件的快照：计划据它计算，写入时据它校验文件没被别人动过
#[derive(Debug, Clone)]
pub struct DesktopSnapshot {
    states: [FileState; 4],
    files: DesktopFiles,
}

impl DesktopSnapshot {
    pub fn files(&self) -> &DesktopFiles {
        &self.files
    }
}

/// 一个角色对应的已选模型
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleModel {
    /// 标识（Sophia 与路由清单里用，不写进桌面应用）
    pub slug: String,
    /// 模型片上的名字（含撞名后缀），写进 `labelOverride`
    pub label: String,
}

/// 想要的值：按现在的开关与选择算出来的内容
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Desired {
    /// `http://127.0.0.1:<port>/claude`（`base_url`）
    pub base_url: String,
    /// 令牌（钥匙串里的），只写进 profile
    pub token: String,
    /// 已选的全部模型，按选择顺序（不设上限；Sophia 不设默认，第一个只是 Claude 第一次切过去时的初始默认）
    pub models: Vec<RoleModel>,
    /// 允许顶替别家的生效配置（R35 的接管）
    pub takeover: bool,
}

impl Desired {
    /// `inferenceModels` 的每一项：角色 id（`role_ids`）→ 已选模型，顺序同 `inferenceModels`
    pub fn models(&self) -> Vec<WrittenModel> {
        role_ids(self.models.len())
            .into_iter()
            .zip(&self.models)
            .map(|(role, model)| WrittenModel {
                role,
                slug: model.slug.clone(),
                label: model.label.clone(),
            })
            .collect()
    }
}

/// `count` 个已选模型各写哪个角色 id（R29，2026-09-30）：第一个 `claude-sonnet-5`；多于一个时最后一个
/// `claude-haiku-4-5`；其余依次 `claude-sonnet-5-r2`、`-r3`……。
/// 桌面应用只认 `claude-{sonnet|opus|haiku|fable}-<非空>`，一个不合法就整组拒收；这些都合法
pub fn role_ids(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| match index {
            0 => FIRST_ROLE.to_owned(),
            last if last + 1 == count => HAIKU_ROLE.to_owned(),
            other => format!("{FIRST_ROLE}-r{}", other + 1),
        })
        .collect()
}

/// 写进 profile 的网关地址（R11：带 `/claude` 前缀）
pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/claude")
}

/// `inferenceModels` 的值（R29）：已选按选择顺序逐项 `{name: <角色 id>, labelOverride: <模型片上的名字>}`
pub fn inference_models(labels: &[&str]) -> Value {
    Value::Array(
        role_ids(labels.len())
            .into_iter()
            .zip(labels)
            .map(|(role, label)| {
                let mut item = Map::new();
                item.insert("name".into(), Value::from(role));
                item.insert("labelOverride".into(), Value::from(*label));
                Value::Object(item)
            })
            .collect(),
    )
}

/// 待生效的配置部分：写入的地址或 `inferenceModels` 各项对应的模型（标识与名字、条数）与想要的不同
pub fn needs_write(record: &Applied, desired: &Desired) -> bool {
    record.written.base_url != desired.base_url || record.written.models != desired.models()
}

/// 一步：把 `file` 写成 `after`（`None`＝删掉）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub file: DesktopFile,
    pub after: Option<Vec<u8>>,
}

/// 计划：按 R32 排好序、只含真要改的文件的步骤；执行前要存下的记录；给用户的提示
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// 打开方向 `phase: writing`，切回方向 `phase: restoring`；写完由调用方改成 done / 清掉
    pub record: Applied,
    pub warnings: Vec<String>,
}

/// 别家的生效配置。只记 id：条目名是别的工具自己写的，界面上一律说「别的第三方配置」，不说出它叫什么
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreign {
    pub id: String,
}

/// Sophia 写的内容里当前值不同的一处（R34 `drift`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriftItem {
    /// Sophia 的 profile 不在了
    ProfileMissing,
    /// profile 里 Sophia 管的这个键与写入的不同
    ProfileKey(&'static str),
    /// `appliedId` 不再指向 Sophia
    AppliedId,
    /// 这一处 `deploymentMode` 不是 `"3p"`（含文件被删）
    Mode(DesktopFile),
}

/// `inspect` 需要的「我们的」东西
#[derive(Debug, Clone, Copy)]
pub struct Ours<'a> {
    pub token: &'a str,
    pub base_url: &'a str,
    pub record: Option<&'a Applied>,
}

/// 只读检查的结果（R34 里与文件有关的部分）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    pub applied_id: Option<String>,
    pub foreign: Option<Foreign>,
    /// `[Claude-3p, Claude]` 两处 `deploymentMode`
    pub modes: [Option<String>; 2],
    /// 有记录时，Sophia 写的内容里当前值不同的各处（顺序：profile、appliedId、Claude-3p、Claude）
    pub drift: Vec<DriftItem>,
    /// profile 当前内容（按 JSON 语义）等于记录里写入后的整份
    pub sophia_profile_matches: bool,
    /// 没有记录，但 `appliedId` 指向 Sophia 且 profile 的地址与令牌都是我们的（Sophia 设置丢了）
    pub unrecorded_ours: bool,
}

/// 读写被拒绝或失败的原因
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopError {
    /// 文件或其父目录是软链 / 不是普通文件、不是 UTF-8、不是合法 JSON、根不是对象、有重复键、成员类型不对
    Invalid { file: DesktopFile, reason: String },
    /// 别家的配置在生效，且没允许接管
    Foreign(Foreign),
    /// 文件在操作期间（或崩溃之后、前滚之前）被别的程序改了，没有覆盖
    Changed { file: DesktopFile },
    /// 读写本身失败
    Io { file: DesktopFile, message: String },
}

impl DesktopError {
    /// 错误码（`docs/gateway-commands.md`）
    pub fn code(&self) -> &'static str {
        match self {
            DesktopError::Invalid { .. } => "invalid",
            DesktopError::Foreign(_) => "foreign_config",
            DesktopError::Changed { .. } => "changed",
            DesktopError::Io { .. } => "internal",
        }
    }

    fn invalid(file: DesktopFile, reason: impl Into<String>) -> Self {
        DesktopError::Invalid {
            file,
            reason: reason.into(),
        }
    }

    fn io(file: DesktopFile, error: impl fmt::Display) -> Self {
        DesktopError::Io {
            file,
            message: error.to_string(),
        }
    }
}

impl fmt::Display for DesktopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DesktopError::Invalid { file, reason } => f.write_str(&crate::t!(
                "models.desktop.invalidFile",
                file = file.label(),
                reason = reason
            )),
            // 不说是哪一份：条目名是别的工具自己写的，界面上一律说「别的第三方配置」
            DesktopError::Foreign(_) => f.write_str(&crate::t!("models.desktop.foreign")),
            DesktopError::Changed { .. } => f.write_str(&crate::t!("models.desktop.changed")),
            DesktopError::Io { file, message } => f.write_str(&crate::t!(
                "models.desktop.ioFailed",
                file = file.label(),
                error = message
            )),
        }
    }
}

impl std::error::Error for DesktopError {}

// ───────────────────────── 读 ─────────────────────────

/// 读四个文件的快照，以及 `appliedId` 与记录里原 `appliedId` 指的别家 profile。
/// 任一文件或其父目录是软链、不是普通文件 → `Invalid`
pub fn read(dirs: &DesktopDirs, record: Option<&Applied>) -> Result<DesktopSnapshot, DesktopError> {
    let mut files = DesktopFiles::default();
    let mut states = Vec::with_capacity(4);
    for file in DesktopFile::ALL {
        let path = dirs.path(file);
        if atomicfile::unsafe_parent(&path) {
            return Err(DesktopError::invalid(
                file,
                crate::t!("models.desktop.reason.parentUnsafe"),
            ));
        }
        let state = match atomicfile::read_state(&path) {
            Ok(state) => state,
            Err(ReadError::Symlink) => {
                return Err(DesktopError::invalid(
                    file,
                    crate::t!("models.desktop.reason.symlink"),
                ))
            }
            Err(ReadError::NotRegularFile) => {
                return Err(DesktopError::invalid(
                    file,
                    crate::t!("models.desktop.reason.notRegular"),
                ))
            }
            Err(ReadError::Io(error)) => return Err(DesktopError::io(file, error)),
        };
        if let FileState::Present(snapshot) = &state {
            *files.slot(file) = Some(snapshot.bytes.clone());
        }
        states.push(state);
    }

    // 别家 profile 只读、不校验：读不了就当不存在
    let mut ids = Vec::new();
    if let Some(id) = files.meta.as_deref().and_then(lenient_applied_id) {
        ids.push(id);
    }
    if let Some(Original::Raw(raw)) = record.map(|r| &r.originals.applied_id) {
        if let Ok(Value::String(id)) = serde_json::from_str::<Value>(raw) {
            ids.push(id);
        }
    }
    for id in ids {
        if id == SOPHIA_PROFILE_ID || !plain_id(&id) || files.others.contains_key(&id) {
            continue;
        }
        if let Ok(FileState::Present(snapshot)) = atomicfile::read_state(&dirs.profile_path(&id)) {
            files.others.insert(id, snapshot.bytes);
        }
    }

    let states: [FileState; 4] = states.try_into().expect("four files");
    Ok(DesktopSnapshot { states, files })
}

/// 读的时候顺手取 `appliedId`：文件不合法时不管（算计划时会拒绝）
fn lenient_applied_id(meta: &[u8]) -> Option<String> {
    let map = jsonedit::parse(meta).ok()?;
    map.get(APPLIED_ID)?.as_str().map(str::to_owned)
}

/// 可以拿来拼文件名的 id：字母数字开头，只含字母数字、点、下划线、连字符
fn plain_id(id: &str) -> bool {
    id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// ───────────────────────── 解析与校验 ─────────────────────────

/// 四个文件校验通过后的样子
struct Parsed {
    profile: Option<Map<String, Value>>,
    meta: Option<Map<String, Value>>,
    applied_id: Option<String>,
    modes: [Option<String>; 2],
}

fn object(file: DesktopFile, bytes: &[u8]) -> Result<Map<String, Value>, DesktopError> {
    if std::str::from_utf8(bytes).is_err() {
        return Err(DesktopError::invalid(
            file,
            crate::t!("models.desktop.reason.notUtf8"),
        ));
    }
    jsonedit::parse(bytes).map_err(|error| {
        let reason = match error {
            jsonedit::Error::Duplicate => crate::t!("models.desktop.reason.duplicateKeys"),
            jsonedit::Error::NotObject(_) => crate::t!("models.jsonEdit.rootNotObject"),
            jsonedit::Error::Syntax => crate::t!("models.jsonEdit.syntax"),
            other => other.to_string(),
        };
        DesktopError::invalid(file, reason)
    })
}

fn parse(files: &DesktopFiles) -> Result<Parsed, DesktopError> {
    let mut parsed = Parsed {
        profile: None,
        meta: None,
        applied_id: None,
        modes: [None, None],
    };
    for file in DesktopFile::ALL {
        let Some(bytes) = files.get(file) else {
            continue;
        };
        let map = object(file, bytes)?;
        match file {
            DesktopFile::Profile => parsed.profile = Some(map),
            DesktopFile::Meta => {
                if map.get(ENTRIES).is_some_and(|v| !v.is_array()) {
                    return Err(DesktopError::invalid(
                        file,
                        crate::t!("models.desktop.reason.entriesNotArray"),
                    ));
                }
                match map.get(APPLIED_ID) {
                    None => {}
                    Some(Value::String(id)) => parsed.applied_id = Some(id.clone()),
                    Some(_) => {
                        return Err(DesktopError::invalid(
                            file,
                            crate::t!("models.desktop.reason.appliedIdNotString"),
                        ))
                    }
                }
                parsed.meta = Some(map);
            }
            DesktopFile::Claude3pConfig | DesktopFile::ClaudeConfig => {
                let slot = if file == DesktopFile::Claude3pConfig {
                    0
                } else {
                    1
                };
                match map.get(MODE_KEY) {
                    None => {}
                    Some(Value::String(mode)) => parsed.modes[slot] = Some(mode.clone()),
                    Some(_) => {
                        return Err(DesktopError::invalid(
                            file,
                            crate::t!("models.desktop.reason.modeNotString"),
                        ))
                    }
                }
            }
        }
    }
    Ok(parsed)
}

/// `appliedId` 指向别家、且那份 profile 里有 `inferenceProvider`
fn foreign(files: &DesktopFiles, parsed: &Parsed) -> Option<Foreign> {
    let id = parsed.applied_id.as_deref()?;
    if id == SOPHIA_PROFILE_ID {
        return None;
    }
    let profile = files.others.get(id)?;
    let profile: Value = serde_json::from_slice(profile).ok()?;
    profile.get("inferenceProvider")?;
    Some(Foreign { id: id.to_owned() })
}

fn is_sophia_entry(entry: &Value) -> bool {
    entry.get("id").and_then(Value::as_str) == Some(SOPHIA_PROFILE_ID)
}

/// 记录里写入后的整份 profile，占位换回令牌
fn expected_profile(record: &Applied, token: &str) -> Value {
    let mut profile = record.written.profile.clone();
    if let Some(key) = profile.get_mut(API_KEY) {
        if key == TOKEN_PLACEHOLDER {
            *key = Value::from(token);
        }
    }
    profile
}

fn profile_matches(parsed: &Parsed, record: &Applied, token: &str) -> bool {
    parsed
        .profile
        .as_ref()
        .is_some_and(|profile| Value::Object(profile.clone()) == expected_profile(record, token))
}

// ───────────────────────── 只读检查 ─────────────────────────

/// 只读检查（R34 里与文件有关的部分）。文件不合法 → `Invalid`
pub fn inspect(files: &DesktopFiles, ours: &Ours) -> Result<Inspection, DesktopError> {
    let parsed = parse(files)?;
    let pointed = parsed.applied_id.as_deref() == Some(SOPHIA_PROFILE_ID);
    let mut drift = Vec::new();
    let mut matches = false;
    if let Some(record) = ours.record {
        let expected = expected_profile(record, ours.token);
        match &parsed.profile {
            None => drift.push(DriftItem::ProfileMissing),
            Some(profile) => {
                for key in MANAGED_KEYS {
                    if profile.get(key) != expected.get(key) {
                        drift.push(DriftItem::ProfileKey(key));
                    }
                }
            }
        }
        if !pointed {
            drift.push(DriftItem::AppliedId);
        }
        for (slot, file) in [DesktopFile::Claude3pConfig, DesktopFile::ClaudeConfig]
            .into_iter()
            .enumerate()
        {
            if parsed.modes[slot].as_deref() != Some(MODE_3P) {
                drift.push(DriftItem::Mode(file));
            }
        }
        matches = profile_matches(&parsed, record, ours.token);
    }
    let unrecorded_ours = ours.record.is_none()
        && pointed
        && parsed.profile.as_ref().is_some_and(|profile| {
            profile
                .get("inferenceGatewayBaseUrl")
                .and_then(Value::as_str)
                == Some(ours.base_url)
                && profile.get(API_KEY).and_then(Value::as_str) == Some(ours.token)
        });
    Ok(Inspection {
        foreign: foreign(files, &parsed),
        applied_id: parsed.applied_id,
        modes: parsed.modes,
        drift,
        sophia_profile_matches: matches,
        unrecorded_ours,
    })
}

// ───────────────────────── 打开方向 ─────────────────────────

/// 打开方向的计划（R29–R32）。`previous` 是已有的记录：有就沿用它的原值（前滚、重新写入、改选、再接管），
/// 没有才从当前文件采集（`appliedId` 已指向 Sophia 时按「原来没有」记，不把 Sophia 写的值当原值）。
///
/// - 任一文件不合法 → `Invalid`，什么都不写
/// - 上次没写完（`phase == writing`）而某处当前值既不是原值也不是目标值 → `Changed`
/// - 别家配置在生效且 `desired.takeover` 为假 → `Foreign`
///
/// 记录的 `phase` 是 `restoring`（上次切回没做完）时，调用方应先用 `plan_restore` 把切回做完、清掉记录，
/// 再以 `previous = None` 打开（R32「先把记下的方向做完」）
pub fn plan_apply(
    files: &DesktopFiles,
    desired: &Desired,
    previous: Option<&Applied>,
) -> Result<Plan, DesktopError> {
    let parsed = parse(files)?;
    if let Some(previous) = previous.filter(|p| p.phase == Phase::Writing) {
        check_unchanged(files, &parsed, &previous.originals)?;
    }
    if let Some(foreign) = foreign(files, &parsed) {
        if !desired.takeover {
            return Err(DesktopError::Foreign(foreign));
        }
    }

    let originals = match previous {
        Some(previous) => previous.originals.clone(),
        None => collect_originals(files, &parsed)?,
    };
    let sophia_entry_present = parsed
        .meta
        .as_ref()
        .and_then(|meta| meta.get(ENTRIES))
        .and_then(Value::as_array)
        .is_some_and(|entries| entries.iter().any(is_sophia_entry));

    let mut steps = Vec::new();
    let (profile, chat_tab_inserted) = apply_profile(files.profile.as_deref(), desired)?;
    push_step(
        &mut steps,
        files,
        DesktopFile::Profile,
        Some(profile.clone()),
    );
    push_step(
        &mut steps,
        files,
        DesktopFile::Meta,
        Some(apply_meta(files.meta.as_deref())?),
    );
    for file in [DesktopFile::Claude3pConfig, DesktopFile::ClaudeConfig] {
        let after = set_member(file, files.get(file), MODE_KEY, &json_string(MODE_3P))?;
        push_step(&mut steps, files, file, Some(after));
    }

    let mut written_profile: Value = serde_json::from_slice(&profile)
        .map_err(|error| DesktopError::io(DesktopFile::Profile, error))?;
    written_profile[API_KEY] = Value::from(TOKEN_PLACEHOLDER);
    let record = Applied {
        phase: Phase::Writing,
        written: Written {
            base_url: desired.base_url.clone(),
            models: desired.models(),
            chat_tab_written: chat_tab_inserted
                || previous.is_some_and(|p| p.written.chat_tab_written),
            profile: written_profile,
        },
        originals,
        profile_created: previous.map_or(files.profile.is_none(), |p| p.profile_created),
        entry_added: previous.map_or(!sophia_entry_present, |p| p.entry_added),
    };
    Ok(Plan {
        steps,
        record,
        warnings: Vec::new(),
    })
}

/// 文件内容与目标不同才成为一步
fn push_step(
    steps: &mut Vec<Step>,
    files: &DesktopFiles,
    file: DesktopFile,
    after: Option<Vec<u8>>,
) {
    if files.get(file) != after.as_deref() {
        steps.push(Step { file, after });
    }
}

/// 从当前文件采集原值
fn collect_originals(files: &DesktopFiles, parsed: &Parsed) -> Result<Originals, DesktopError> {
    let pointed = parsed.applied_id.as_deref() == Some(SOPHIA_PROFILE_ID);
    let applied_id = if pointed {
        Original::Absent
    } else {
        original_of(DesktopFile::Meta, files.meta.as_deref(), APPLIED_ID)?
    };
    let mode = |file: DesktopFile, slot: usize| -> Result<Original, DesktopError> {
        if pointed && parsed.modes[slot].as_deref() == Some(MODE_3P) {
            return Ok(Original::Absent);
        }
        original_of(file, files.get(file), MODE_KEY)
    };
    Ok(Originals {
        applied_id,
        entries: original_of(DesktopFile::Meta, files.meta.as_deref(), ENTRIES)?,
        claude_3p_mode: mode(DesktopFile::Claude3pConfig, 0)?,
        claude_mode: mode(DesktopFile::ClaudeConfig, 1)?,
    })
}

fn original_of(
    file: DesktopFile,
    bytes: Option<&[u8]>,
    key: &str,
) -> Result<Original, DesktopError> {
    let Some(bytes) = bytes else {
        return Ok(Original::FileAbsent);
    };
    match jsonedit::get(bytes, &[key])
        .map_err(|error| DesktopError::invalid(file, error.to_string()))?
    {
        None => Ok(Original::Absent),
        Some(raw) => Ok(Original::Raw(String::from_utf8_lossy(raw).into_owned())),
    }
}

/// 上次没写完时，Sophia 管的各处当前值只能是原值或目标值；否则是别人在崩溃之后改过
fn check_unchanged(
    files: &DesktopFiles,
    parsed: &Parsed,
    originals: &Originals,
) -> Result<(), DesktopError> {
    let meta = DesktopFile::Meta;
    let current_id = files
        .meta
        .as_deref()
        .map(|bytes| jsonedit::get(bytes, &[APPLIED_ID]))
        .transpose()
        .map_err(|error| DesktopError::invalid(meta, error.to_string()))?
        .flatten();
    let id_ok = parsed.applied_id.as_deref() == Some(SOPHIA_PROFILE_ID)
        || same_as_original(current_id, &originals.applied_id);
    let entries_ok = without_sophia(parsed.meta.as_ref().and_then(|m| m.get(ENTRIES)))
        == without_sophia(original_value(&originals.entries).as_ref());
    if !id_ok || !entries_ok {
        return Err(DesktopError::Changed { file: meta });
    }
    for (slot, file, original) in [
        (0, DesktopFile::Claude3pConfig, &originals.claude_3p_mode),
        (1, DesktopFile::ClaudeConfig, &originals.claude_mode),
    ] {
        let current = files
            .get(file)
            .map(|bytes| jsonedit::get(bytes, &[MODE_KEY]))
            .transpose()
            .map_err(|error| DesktopError::invalid(file, error.to_string()))?
            .flatten();
        if parsed.modes[slot].as_deref() != Some(MODE_3P) && !same_as_original(current, original) {
            return Err(DesktopError::Changed { file });
        }
    }
    Ok(())
}

/// 当前成员原文（`None`＝没有）按语义等于原值；原来没有（文件或成员）与现在没有算相同
fn same_as_original(current: Option<&[u8]>, original: &Original) -> bool {
    match (current, original) {
        (None, Original::Absent | Original::FileAbsent) => true,
        (Some(current), Original::Raw(raw)) => jsonedit::same(current, raw.as_bytes()),
        _ => false,
    }
}

fn original_value(original: &Original) -> Option<Value> {
    match original {
        Original::Raw(raw) => serde_json::from_str(raw).ok(),
        _ => None,
    }
}

/// `entries` 去掉 Sophia 的条目（没有或不是数组＝空）
fn without_sophia(entries: Option<&Value>) -> Vec<Value> {
    entries
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|e| !is_sophia_entry(e))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// 目标 profile：不存在就新建；存在只替换 / 补上 Sophia 管的键，`chatTabEnabled` 仅在没有时补。
/// 返回新原文与是否补了 `chatTabEnabled`
fn apply_profile(
    current: Option<&[u8]>,
    desired: &Desired,
) -> Result<(Vec<u8>, bool), DesktopError> {
    let file = DesktopFile::Profile;
    let values = managed_values(desired);
    let Some(current) = current else {
        let mut text = String::from("{\n");
        for (key, value) in &values {
            text.push_str(&format!("  {}: {value},\n", json_string(key)));
        }
        text.push_str(&format!("  {}: true\n}}\n", json_string(CHAT_TAB)));
        return Ok((text.into_bytes(), true));
    };
    let mut bytes = current.to_vec();
    for (key, value) in &values {
        bytes = set_member(file, Some(&bytes), key, value)?;
    }
    let has_chat_tab = jsonedit::get(&bytes, &[CHAT_TAB])
        .map_err(|error| DesktopError::invalid(file, error.to_string()))?
        .is_some();
    if !has_chat_tab {
        bytes = set_member(file, Some(&bytes), CHAT_TAB, "true")?;
    }
    Ok((bytes, !has_chat_tab))
}

/// Sophia 管的键与值的原文，按新建时的顺序
fn managed_values(desired: &Desired) -> Vec<(&'static str, String)> {
    let models = desired
        .models()
        .iter()
        .map(|model| {
            format!(
                "{{\"name\": {}, \"labelOverride\": {}}}",
                json_string(&model.role),
                json_string(&model.label)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    vec![
        (MANAGED_KEYS[0], json_string("gateway")),
        (MANAGED_KEYS[1], json_string(&desired.base_url)),
        (MANAGED_KEYS[2], json_string(&desired.token)),
        (MANAGED_KEYS[3], json_string("bearer")),
        (MANAGED_KEYS[4], format!("[{models}]")),
    ]
}

/// 目标 `_meta.json`：`entries` 里没有 Sophia 就在末尾追加（整值原位换成紧凑数组），`appliedId` 设为 Sophia
fn apply_meta(current: Option<&[u8]>) -> Result<Vec<u8>, DesktopError> {
    let file = DesktopFile::Meta;
    let entry = sophia_entry();
    let Some(current) = current else {
        return Ok(format!(
            "{{\"entries\":[{entry}],\"appliedId\":{}}}",
            json_string(SOPHIA_PROFILE_ID)
        )
        .into_bytes());
    };
    let mut bytes = current.to_vec();
    let items = entry_items(file, &bytes)?;
    match items {
        None => bytes = set_member(file, Some(&bytes), ENTRIES, &format!("[{entry}]"))?,
        Some(items) if !items.iter().any(|item| is_sophia_raw(item)) => {
            let mut items = items;
            items.push(entry);
            bytes = set_member(
                file,
                Some(&bytes),
                ENTRIES,
                &format!("[{}]", items.join(",")),
            )?;
        }
        Some(_) => {}
    }
    set_member(
        file,
        Some(&bytes),
        APPLIED_ID,
        &json_string(SOPHIA_PROFILE_ID),
    )
}

fn sophia_entry() -> String {
    format!(
        "{{\"id\":{},\"name\":{}}}",
        json_string(SOPHIA_PROFILE_ID),
        json_string(SOPHIA_ENTRY_NAME)
    )
}

/// `entries` 各项的原文（`None`＝没有这个成员）
fn entry_items(file: DesktopFile, bytes: &[u8]) -> Result<Option<Vec<String>>, DesktopError> {
    let Some(raw) = jsonedit::get(bytes, &[ENTRIES])
        .map_err(|error| DesktopError::invalid(file, error.to_string()))?
    else {
        return Ok(None);
    };
    let items: Vec<&RawValue> = serde_json::from_slice(raw).map_err(|_| {
        DesktopError::invalid(file, crate::t!("models.desktop.reason.entriesNotArray"))
    })?;
    Ok(Some(
        items
            .into_iter()
            .map(|item| item.get().to_owned())
            .collect(),
    ))
}

fn is_sophia_raw(item: &str) -> bool {
    serde_json::from_str::<Value>(item).is_ok_and(|value| is_sophia_entry(&value))
}

// ───────────────────────── 切回方向 ─────────────────────────

/// 切回方向的计划（R33）：对每个文件，当前值仍是 Sophia 写的才还原。`token` 用来把记录里的占位换回，
/// 判断 profile 是否仍是 Sophia 最后写入的那份。任一文件不合法 → `Invalid`。
/// `files` 要来自 `read(dirs, Some(record))`：原 `appliedId` 那份 profile 还在不在，看的是 `files.others`
pub fn plan_restore(
    files: &DesktopFiles,
    record: &Applied,
    token: &str,
) -> Result<Plan, DesktopError> {
    let parsed = parse(files)?;
    let pointed = parsed.applied_id.as_deref() == Some(SOPHIA_PROFILE_ID);
    let originals = &record.originals;
    let mut steps = Vec::new();
    let mut warnings = Vec::new();

    // 原来生效的那份（接管时记下的）还在不在：不在就换不回去，`appliedId` 会被删掉
    let restores_applied = match &originals.applied_id {
        Original::Raw(raw) => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .is_some_and(|id| files.others.contains_key(&id)),
        _ => false,
    };

    // ① 两处 deploymentMode：先 Claude 再 Claude-3p；只在仍指向 Sophia、且该处仍是 "3p" 时写回原值。
    // 原值是 "3p"（接管了别家）而那份已经不在：写 "1p"——没有生效的配置还停在第三方模式，重开就卡在空配置上
    for (slot, file, original) in [
        (1, DesktopFile::ClaudeConfig, &originals.claude_mode),
        (0, DesktopFile::Claude3pConfig, &originals.claude_3p_mode),
    ] {
        if !pointed || parsed.modes[slot].as_deref() != Some(MODE_3P) {
            continue;
        }
        let text = match original {
            Original::Raw(raw)
                if serde_json::from_str::<Value>(raw).is_ok_and(|v| v.is_string()) =>
            {
                let was_3p =
                    serde_json::from_str::<Value>(raw).is_ok_and(|v| v.as_str() == Some(MODE_3P));
                if was_3p && !restores_applied {
                    json_string(MODE_1P)
                } else {
                    raw.clone()
                }
            }
            _ => json_string(MODE_1P),
        };
        let after = set_member(file, files.get(file), MODE_KEY, &text)?;
        push_step(&mut steps, files, file, Some(after));
    }

    // profile 仍是 Sophia 最后写入的那份才删，条目随之摘掉；被改过就都留着
    let profile_goes = parsed.profile.is_none() || profile_matches(&parsed, record, token);
    if !profile_goes {
        warnings.push(crate::t!("models.desktop.editedKept"));
    }

    // ② _meta.json
    if let Some(current) = files.meta.as_deref() {
        let file = DesktopFile::Meta;
        let mut bytes = current.to_vec();
        if profile_goes {
            if let Some(items) = entry_items(file, &bytes)? {
                if items.iter().any(|item| is_sophia_raw(item)) {
                    let kept: Vec<String> = items
                        .into_iter()
                        .filter(|item| !is_sophia_raw(item))
                        .collect();
                    let text = format!("[{}]", kept.join(","));
                    let text = match &originals.entries {
                        Original::Raw(raw) if jsonedit::same(raw.as_bytes(), text.as_bytes()) => {
                            raw.clone()
                        }
                        _ => text,
                    };
                    bytes = set_member(file, Some(&bytes), ENTRIES, &text)?;
                }
            }
        }
        if pointed {
            let back = match &originals.applied_id {
                Original::Raw(raw) => serde_json::from_str::<Value>(raw)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .filter(|id| files.others.contains_key(id))
                    .map(|_| raw.clone()),
                _ => None,
            };
            bytes = match back {
                Some(raw) => set_member(file, Some(&bytes), APPLIED_ID, &raw)?,
                None => jsonedit::remove(&bytes, &[APPLIED_ID])
                    .map_err(|error| DesktopError::invalid(file, error.to_string()))?,
            };
        }
        // Sophia 建的 _meta.json 还原后只剩空壳：删掉，逐字节回到原来没有这个文件
        let created = originals.applied_id == Original::FileAbsent
            && originals.entries == Original::FileAbsent;
        let empty = |value: &Value| {
            value.as_object().is_some_and(|map| {
                map.iter().all(|(key, value)| {
                    key == ENTRIES && value.as_array().is_some_and(Vec::is_empty)
                })
            })
        };
        let after = match serde_json::from_slice::<Value>(jsonedit::strip_bom(&bytes)) {
            Ok(value) if created && empty(&value) => None,
            _ => Some(bytes),
        };
        push_step(&mut steps, files, file, after);
    }

    // ③ profile
    if files.profile.is_some() && profile_goes {
        steps.push(Step {
            file: DesktopFile::Profile,
            after: None,
        });
    }

    Ok(Plan {
        steps,
        record: Applied {
            phase: Phase::Restoring,
            ..record.clone()
        },
        warnings,
    })
}

// ───────────────────────── 文本改写 ─────────────────────────

fn json_string(text: &str) -> String {
    Value::from(text).to_string()
}

/// 根上的成员设为 `value`（JSON 原文）：已有且语义相同不动，已有不同原位换值，没有追加在末尾
/// （原文根对象是一行的紧凑追加，否则缩进与换行跟随原文）；文件不存在则新建为只含这一个成员的紧凑对象
fn set_member(
    file: DesktopFile,
    bytes: Option<&[u8]>,
    key: &str,
    value: &str,
) -> Result<Vec<u8>, DesktopError> {
    let invalid = |error: jsonedit::Error| DesktopError::invalid(file, error.to_string());
    let Some(bytes) = bytes else {
        return Ok(format!("{{{}:{value}}}", json_string(key)).into_bytes());
    };
    match jsonedit::get(bytes, &[key]).map_err(invalid)? {
        Some(current) if current == value.as_bytes() => Ok(bytes.to_vec()),
        Some(current) if jsonedit::same(current, value.as_bytes()) => Ok(bytes.to_vec()),
        Some(_) => jsonedit::replace(bytes, &[key], value.as_bytes()).map_err(invalid),
        None => {
            let root = jsonedit::root(bytes).map_err(invalid)?;
            let layout = if bytes[root.start..root.end].contains(&b'\n') {
                Layout::Pretty
            } else {
                Layout::Compact
            };
            jsonedit::insert(bytes, &[], &[(key, value.as_bytes())], layout).map_err(invalid)
        }
    }
}

// ───────────────────────── 写 ─────────────────────────

/// 按顺序执行全部步骤，遇到第一个失败即停
pub fn execute(
    dirs: &DesktopDirs,
    snapshot: &DesktopSnapshot,
    plan: &Plan,
) -> Result<(), DesktopError> {
    for step in &plan.steps {
        apply_step(dirs, snapshot, step)?;
    }
    Ok(())
}

/// 执行一步。文件已是目标内容 → 什么都不做；与快照不同 → `Changed`，不覆盖。
/// 改写前备份原文（Sophia 自己的 profile 除外：内含令牌，令牌不该出现在别处）；删文件前重校验
pub fn apply_step(
    dirs: &DesktopDirs,
    snapshot: &DesktopSnapshot,
    step: &Step,
) -> Result<(), DesktopError> {
    let file = step.file;
    let path = dirs.path(file);
    let expected = &snapshot.states[file.index()];
    let current = match atomicfile::read_state(&path) {
        Ok(state) => state,
        Err(ReadError::Symlink) => {
            return Err(DesktopError::invalid(
                file,
                crate::t!("models.desktop.reason.symlink"),
            ))
        }
        Err(ReadError::NotRegularFile) => {
            return Err(DesktopError::invalid(
                file,
                crate::t!("models.desktop.reason.notRegular"),
            ))
        }
        Err(ReadError::Io(error)) => return Err(DesktopError::io(file, error)),
    };
    let current_bytes = match &current {
        FileState::Missing => None,
        FileState::Present(snap) => Some(snap.bytes.as_slice()),
    };
    if current_bytes == step.after.as_deref() {
        return Ok(());
    }
    if current != *expected {
        return Err(DesktopError::Changed { file });
    }
    if let (FileState::Present(snap), true) = (expected, file != DesktopFile::Profile) {
        atomicfile::backup(&path, snap, BACKUP_SUFFIX).map_err(|e| DesktopError::io(file, e))?;
    }
    let changed = |error: io::Error| {
        if error.to_string() == "changed" {
            DesktopError::Changed { file }
        } else {
            DesktopError::io(file, error)
        }
    };
    match &step.after {
        Some(bytes) => {
            ensure_parent(&path).map_err(|error| DesktopError::io(file, error))?;
            atomicfile::atomic_write(&path, bytes, expected).map_err(changed)
        }
        None => {
            if !atomicfile::same(&path, expected) {
                return Err(DesktopError::Changed { file });
            }
            fs::remove_file(&path).map_err(|error| DesktopError::io(file, error))
        }
    }
}

/// 所在目录不存在时建出来（0700）；父路径里有软链则拒绝
fn ensure_parent(path: &Path) -> io::Result<()> {
    if atomicfile::unsafe_parent(path) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "symlink parent",
        ));
    }
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if fs::symlink_metadata(parent).is_ok() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)
}

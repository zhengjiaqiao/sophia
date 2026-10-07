//! 发现与安装的命令层（spec `docs/specs/2026-09-27-skill-mcp-market.md`）。
//! 联网都在这里：skills.sh 搜索、MCP Registry v0.1、codeload 下载、GitHub trees、raw 取 SKILL.md / README，
//! 搜索目录缓存 6 小时，在线热门榜单缓存 10 分钟，限流识别（403 / 429 + 限流头 → `GitHub 暂时限流，稍后再试`），连不上时退回上次缓存或随包数据。
//! 解析、解包、tree SHA、计划与执行都在 core 的 `sophia_core::market`，命令拿到字节后一行调过去。
//!
//! 各服务怎么用（R5–R16，数据源见 `docs/research/2026-09-27-market-sources.md`）：
//! - skills.sh：`GET /api/search?q=&limit=`（不到 2 个字它直接报错，这时列热门快照）；
//! - MCP Registry：`GET /v0.1/servers?search=&limit=&version=latest`，只收 `active` 与 npm / pypi / oci / 远程；
//! - 默认分支：`github.com/{repo}.git/info/refs?service=git-upload-pack` 首行的 `symref=HEAD:refs/heads/…`，
//!   只读开头几 KB，不走 `api.github.com`，不占每小时 60 次；
//! - 下载：`codeload.github.com`，不占次数；字节在内存里留一会儿，安装页出计划与真装共用一次下载；
//! - 介绍页：`raw.githubusercontent.com`，不占次数；搜索结果不带仓库内路径时先按常见布局猜，
//!   猜不中再下整包找（仍不占次数）；
//! - 查更新：只有这里用 `api.github.com`（git trees），一个仓库一次；本地改过的再取一次记下那一版的 tree。
//!
//! 缓存：内存里一份，另把最近成功的结果写进应用数据目录的 `market-cache.json`
//! （与 settings.json 同目录；重开时离线也有「上次的结果」）。里面只有公开目录数据与查更新的结果，
//! 没有任何用户填的值。
//!
//! 约定：
//! - 用户在 MCP 安装页填的值（`McpInstallRequest::values`）只写进目标配置文件，不进日志、缓存与错误文本；
//!   这里不打日志，错误文本里也不带请求体。
//! - 写 `~/.codex/config.toml` 的（装 MCP 勾了 Codex）先拿 `AppState.config_lock`。

use crate::net_kind::NetKind;
use crate::AppState;
#[cfg(test)]
mod net_tests;
mod popular;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sophia_core::discovery::{self, Env};
use sophia_core::fs::{entry_kind, normalize, EntryKind};
use sophia_core::market::lock::LockEntry;
use sophia_core::market::{
    archive, install, install::InstallUndo, installs, link, lock, InstallOutcome, InstallPlan,
    InstallRecord, McpCatalogEntry, McpDefinitionInput, McpFieldKind, McpFieldSpec,
    McpInstallRequest, McpParseResult, McpTargetCheck, McpTransport, SkillInstallRequest,
    SkillListing, UpdateInfo, UpdateTarget, MAX_DOWNLOAD_BYTES,
};
use sophia_core::mcp::McpReport;
use sophia_core::models::{Harness, SyncReport};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

// ── 常量 ──

/// 搜索、目录、默认分支、查更新的缓存时长（R5 / R14：6 小时）
const TTL_SECS: u64 = 6 * 3600;
/// 限流的固定说法（R16）。前端用同一个键 `market.rateLimited` 认它
fn rate_limited_text() -> String {
    sophia_core::t!("market.rateLimited")
}
/// 取不到说明的固定说法（前端用同一个键 `market.error.intro`）
fn intro_unavailable() -> String {
    sophia_core::t!("market.error.intro")
}
const SKILLS_SEARCH_URL: &str = "https://skills.sh/api/search";
const REGISTRY_URL: &str = "https://registry.modelcontextprotocol.io/v0.1/servers";
/// skills.sh 一次取多少条（`npx skills find` 取 20）
const SKILLS_LIMIT: usize = 50;
/// 官方目录一次取多少条（过滤之前）
const REGISTRY_LIMIT: usize = 30;
/// skills.sh 少于 2 个字直接报 `Query must be at least 2 characters`
const MIN_QUERY_CHARS: usize = 2;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// 普通 JSON / 文本响应的上限；trees 大仓库会到几 MB
const JSON_CAP: u64 = 16 * 1024 * 1024;
/// 默认分支只读 info/refs 的开头这么多字节（symref 在第一行）
const REFS_CAP: usize = 64 * 1024;
/// 下载下来的包在内存里留多久、留几个
const ARCHIVE_TTL_SECS: u64 = 15 * 60;
const ARCHIVE_SLOTS: usize = 2;
/// 缓存文件里每类最多记多少个查询词
const CACHE_QUERIES: usize = 40;
const CACHE_FILE: &str = "market-cache.json";
/// 限流头里没写什么时候恢复时，按这么久之后再试
const RATE_LIMIT_FALLBACK_SECS: u64 = 10 * 60;
const UNDO_LIMIT: usize = 16;
const GLOBAL: &str = "global";
/// 粘贴的 `tree/<分支>/<路径>` 里分支带 `/` 时，最多把路径的前几段挪进分支再试
const BRANCH_SLASH_RETRIES: usize = 3;

// ── 状态 ──

/// 市场自己的运行时状态，`lib.rs` 里 `.manage(market::MarketState::default())`
#[derive(Default)]
pub struct MarketState {
    /// 装 / 更新的撤销记录，按 id 存在内存里：前端只拿 id。用过即删，退出即丢
    undo: Mutex<Vec<(String, InstallUndo)>>,
    next_undo: AtomicU64,
    /// 上一次查更新的结果：`market_check_updates(force = false)` 不到时候时原样返回它
    last_check: Mutex<Option<UpdateCheck>>,
    /// 一次更新从「有更新」里拿掉的那几条，按撤销 id 记：撤销时放回去（2026-09-27 真人测试 UPD-8：
    /// 撤销了更新，重启之后「有更新」不见了——存下的查更新结果没跟着放回）
    update_removed: Mutex<Vec<(String, Vec<UpdateInfo>)>>,
    /// 一个 reqwest client，第一次联网时建
    client: OnceLock<Result<reqwest::Client, String>>,
    /// 搜索与目录的缓存；第一次用时从缓存文件读进来
    cache: Mutex<Option<DiskCache>>,
    /// 最近下载的包：安装页出计划、真装、介绍页找路径共用
    archives: Mutex<Vec<CachedArchive>>,
    /// 仓库（小写）→ (取的时刻, 默认分支)
    branches: Mutex<HashMap<String, (u64, String)>>,
    /// GitHub 接口限流到这一刻（unix 秒）之前不再请求
    github_blocked_until: Mutex<Option<u64>>,
    /// 热门榜单独立的 10 分钟刷新与失败冷却；不阻塞默认读取。
    popular_refresh: popular::Refresh,
}

struct CachedArchive {
    /// 小写 `owner/repo`
    repo: String,
    branch: String,
    at: u64,
    bytes: Arc<Vec<u8>>,
}

/// 写进 `market-cache.json` 的东西：最近成功的搜索结果与查更新结果
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DiskCache {
    popular: Option<Cached<Vec<SkillHit>>>,
    skills: BTreeMap<String, Cached<Vec<SkillHit>>>,
    mcp: BTreeMap<String, Cached<Vec<RegistryHit>>>,
    updates: Option<UpdateCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Cached<T> {
    /// 取到的时刻，unix 秒
    at: u64,
    items: T,
}

/// skills.sh 的一条：列表条目 + skills.sh 的 `skillId`（与显示名不一定相同，如 `react:components`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillHit {
    listing: SkillListing,
    #[serde(default)]
    skill_id: Option<String>,
}

/// 官方目录的一条：条目 + 目录里的全名（唯一）+ 源码仓库（介绍页取 README）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryHit {
    id: String,
    entry: McpCatalogEntry,
    #[serde(default)]
    repository: Option<String>,
}

// ── 返回给前端的类型 ──

/// 联网来源连不上 / 被限流时的降级说明（R16 列表上方的灰面板）。正常时整个为 None
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fallback {
    /// 连不上的是哪个：`skills.sh` / `MCP 目录` / `GitHub`
    pub service: String,
    /// 显示的是哪一刻的缓存（unix 秒）；None＝没有缓存，显示的是随包数据
    pub cached_at: Option<u64>,
    /// 被限流（GitHub、skills.sh、MCP 目录都算）：不自动重试
    pub rate_limited: bool,
    /// 失败的真实原因一句话（`skills.sh 返回的内容读不懂`）。None＝单纯连不上，界面沿用
    /// `现在无法连接 {service}，显示的是…` 的说法
    pub reason: Option<String>,
    /// 给 `详情` 展开的技术原文（请求、状态码、返回体开头），已去隐私。没有为 None
    pub detail: Option<String>,
}

impl Fallback {
    /// 一次联网失败 → 降级说明。`reason` 与 `detail` 都从失败里来
    fn from_failure(service: &str, cached_at: Option<u64>, failure: &NetFailure) -> Self {
        Fallback {
            service: service.to_string(),
            cached_at,
            rate_limited: matches!(failure.error, NetError::RateLimited { .. }),
            reason: (failure.error != NetError::Network).then(|| failure.error.message(service)),
            detail: Some(failure.detail.clone()).filter(|d| !d.is_empty()),
        }
    }
}

/// 发现 · skill 的一行：列表条目 + 装在了哪些位置（空＝没装；非空时 `安装` 换成 `✓ 已安装`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    #[serde(flatten)]
    pub listing: SkillListing,
    /// skills.sh 的 `skillId`（在线热门与搜索结果有）。`path` 为空时把它交给介绍页 / 安装页找文件夹
    pub skill_id: Option<String>,
    /// 域 key（`global` / `project:<路径>`）
    pub installed_in: Vec<String>,
}

/// 热门或搜索结果（R5）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillList {
    pub items: Vec<SkillRow>,
    pub fallback: Option<Fallback>,
    pub popular: Option<PopularMeta>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopularMeta {
    pub source: String,
    pub updated_at: Option<u64>,
    pub refresh_needed: bool,
}

/// 发现 · MCP 的一行（R7）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRow {
    /// 行的身份：精选 `curated:<名字>`，官方目录是目录里的全名（`io.github.brave/brave-search-mcp-server`）
    pub id: String,
    #[serde(flatten)]
    pub entry: McpCatalogEntry,
    /// 源码仓库（GitHub 网址，可带 `/tree/<分支>/<子目录>`）：介绍页交给 `market_mcp_readme`
    pub repository: Option<String>,
    /// 已经有同名服务的位置（域 key）
    pub installed_in: Vec<String>,
}

/// MCP 列表：没输入时只有 `curated`；搜索时 `curated` 是精选里匹配的，`registry` 是官方目录的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpList {
    pub curated: Vec<McpRow>,
    pub registry: Vec<McpRow>,
    pub fallback: Option<Fallback>,
    pub search_cache: Option<McpSearchCache>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSearchCache {
    pub updated_at: Option<u64>,
    pub refresh_needed: bool,
}

/// 介绍页正文（R5B / 08B）：raw 取回的 SKILL.md 或 README 原文，frontmatter 由前端去掉
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReadme {
    pub text: String,
    /// 实际用的分支
    pub branch: String,
    /// 实际取到的文件夹（仓库内路径，仓库根为空串）；搜索结果不带路径时由这里补上
    pub path: String,
    /// `在 GitHub 打开 ↗`
    pub page_url: String,
}

/// 仓库里的一个 skill（R6 列表一行）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSkill {
    pub name: String,
    /// 仓库内路径
    pub path: String,
}

/// 粘贴链接认出来之后（R6：`owner/repo · 分支 · 找到 N 个 skill`）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    /// `owner/repo`
    pub repo: String,
    pub branch: String,
    /// 链接指着某个 skill 文件夹时只有它一个
    pub skills: Vec<RepoSkill>,
    /// 贴底那句 `从 codeload.github.com 下载 · main · 2.1 MB`
    pub download_url: String,
    pub size_bytes: Option<u64>,
}

/// 安装页（R9）：计划 + 贴底那句 `从 codeload.github.com 下载 · main · 2.1 MB`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallPreview {
    pub plan: InstallPlan,
    /// 实际用的分支（请求里分支为空时取的默认分支）；装的时候原样带回来
    pub branch: String,
    pub download_url: String,
    /// 取不到大小时为 None，界面不写大小
    pub size_bytes: Option<u64>,
}

/// 查更新的结果（R14 / R15）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub updates: Vec<UpdateInfo>,
    /// 这份结果是哪一刻查的（unix 秒）；从没查过为 None
    pub checked_at: Option<u64>,
    /// 提示条该不该出（`installs::strip_visible`：有不在已关掉那一批里的新版本）
    pub strip_visible: bool,
    pub fallback: Option<Fallback>,
}

/// 设置 `skill 更新` 一节（R14）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateSettings {
    pub auto_check: bool,
    /// unix 秒
    pub last_check: Option<u64>,
}

// ── 网络：错误、client、请求 ──

/// 一次请求怎么失败的。给用户看的句子由调用处按服务定
#[derive(Debug, Clone, PartialEq, Eq)]
enum NetError {
    /// 404 / 410；GitHub 的 git 地址对不存在或私有仓库回 401，也算这个
    NotFound,
    /// 被限流；`reset` 是限流头里写的恢复时刻（unix 秒），`wait_secs` 是还要等多少秒（知道的话）
    RateLimited {
        reset: Option<u64>,
        wait_secs: Option<u64>,
    },
    /// 超过上限（仓库压缩包 200MB，其余接口各自的上限）
    TooLarge,
    /// 其他 HTTP 状态
    Status(u16),
    /// 连不上、发不出请求（不含超时）
    Network,
    /// 超时：连接、等响应或读响应体
    Timeout,
    /// 响应体读到一半断了（不含超时）
    Interrupted,
    /// 响应收到了，内容读不懂（不是预期的格式）
    Unreadable,
    /// 联网组件（client）建不起来，或地址拼不出来
    Client,
}

impl NetError {
    /// 网络出错的四类（issue #253，与应用更新共用 `net_kind`）：读到一半断了按连不上说
    fn kind(&self) -> NetKind {
        match self {
            NetError::Network | NetError::Interrupted => NetKind::Unreachable,
            NetError::Timeout => NetKind::Timeout,
            NetError::RateLimited { .. } => NetKind::RateLimited,
            NetError::Status(code) => crate::net_kind::of_status(*code, None, None),
            NetError::NotFound | NetError::TooLarge | NetError::Unreadable | NetError::Client => {
                NetKind::Other
            }
        }
    }

    /// 自动上报里算哪一类：连不上、超时、读断了是网络；对方回错、限流、太大、读不懂是上游；
    /// 联网组件建不起来是内部错误。404（不存在、私有）是正常的回答，不计
    fn report_kind(&self) -> Option<sophia_core::report::Kind> {
        use sophia_core::report::Kind;
        match self {
            NetError::NotFound => None,
            NetError::Network | NetError::Timeout | NetError::Interrupted => Some(Kind::Network),
            NetError::RateLimited { .. }
            | NetError::TooLarge
            | NetError::Status(_)
            | NetError::Unreadable => Some(Kind::Upstream),
            NetError::Client => Some(Kind::Internal),
        }
    }
}

/// 失败 + 给 `详情` 的技术原文。`error` 是小的种类枚举，`detail` 已去隐私
#[derive(Debug, Clone, PartialEq, Eq)]
struct NetFailure {
    error: NetError,
    detail: String,
}

impl NetFailure {
    /// 原文是 `GET <地址> → <说明>`，整条去隐私并限长。每一次真发出去的请求失败都在这里记一次异常（自动上报）；
    /// 内部错误（联网组件建不起来、地址拼不出来）再上传一条事件（R8），外部原因只计数
    fn new(error: NetError, url: &str, what: &str) -> Self {
        let kind = error.report_kind();
        let failure = Self::uncounted(error, url, what);
        match kind {
            Some(sophia_core::report::Kind::Internal) => {
                sophia_core::report::capture_internal(&failure.detail)
            }
            Some(kind) => sophia_core::report::count(kind),
            None => {}
        }
        failure
    }

    /// 同 [`NetFailure::new`]，不记异常（这次根本没发请求）
    fn uncounted(error: NetError, url: &str, what: &str) -> Self {
        NetFailure {
            error,
            detail: sophia_core::redact::redact(&format!("GET {url} → {what}")),
        }
    }

    /// 响应收到了但读不懂：`GET <地址> → 200 OK`，换行接说明和返回体开头
    fn unreadable(url: &str, why: &str, body: &[u8]) -> Self {
        NetFailure::new(
            NetError::Unreadable,
            url,
            &format!("200 OK\n{why}{}", body_head(body)),
        )
    }
}

/// 详情里的失败类型可以直接当 `NetError` 用（`.message()`、传给 `github_message`）
impl std::ops::Deref for NetFailure {
    type Target = NetError;
    fn deref(&self) -> &NetError {
        &self.error
    }
}

/// 详情里带返回体开头这么多字符
const DETAIL_BODY_CHARS: usize = 300;

/// `\n` + 返回体开头；体是空的为空串
fn body_head(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let head: String = text.trim().chars().take(DETAIL_BODY_CHARS).collect();
    if head.is_empty() {
        String::new()
    } else {
        format!("\n{head}")
    }
}

/// reqwest 错误的原文：整条源错误链用 `: ` 接起来（reqwest 自己的那一环只说「发请求出错」，带着地址，跳过）
fn error_chain_text(error: &reqwest::Error) -> String {
    let mut parts = crate::net_kind::chain_parts(error);
    if parts.len() > 1 {
        parts.remove(0);
    }
    parts.join(": ")
}

/// 发不出去 / 读不下去时的种类：超时单列，`broken` 是别的情况下该归的类
fn kind_of(error: &reqwest::Error, broken: NetError) -> NetError {
    if error.is_timeout() {
        NetError::Timeout
    } else if error.is_builder() {
        NetError::Client
    } else {
        broken
    }
}

impl NetError {
    /// 给用户看的一句；`service` 是 `skills.sh` / `MCP 目录` / `GitHub`
    fn message(&self, service: &str) -> String {
        match self {
            NetError::NotFound => sophia_core::t!("market.net.notFound", service = service),
            NetError::RateLimited { .. } if service == "GitHub" => rate_limited_text(),
            NetError::RateLimited {
                wait_secs: Some(secs),
                ..
            } => sophia_core::t!(
                "market.net.limitedWait",
                service = service,
                minutes = secs.div_ceil(60).max(1)
            ),
            NetError::RateLimited { .. } => {
                sophia_core::t!("market.fallback.limited", service = service)
            }
            NetError::TooLarge => sophia_core::t!("market.net.tooLarge", service = service),
            NetError::Status(code) => {
                sophia_core::t!("market.net.status", service = service, code = code)
            }
            NetError::Network => sophia_core::t!("market.net.unreachable", service = service),
            NetError::Timeout => sophia_core::t!("market.net.timeout", service = service),
            NetError::Interrupted => sophia_core::t!("market.net.interrupted", service = service),
            NetError::Unreadable => sophia_core::t!("market.net.unreadable", service = service),
            NetError::Client => sophia_core::t!("market.net.client"),
        }
    }
}

/// 按状态码与限流头判断一次响应。纯函数，单测覆盖：
/// - 2xx 成功；
/// - 429 一律算限流；403 只有 `x-ratelimit-remaining: 0` 或带 `retry-after`（GitHub 的次级限流）才算，
///   单纯 403 是没权限，不能当限流；限流要等多久先看 `retry-after-ms` / `retry-after`，
///   没有再用 `x-ratelimit-reset` 减 `now`（unix 秒）；
/// - 404 / 410 / 401 算没找到（GitHub 对不存在或私有仓库的 git 地址回 401）
fn classify(
    status: u16,
    remaining: Option<&str>,
    retry_after: Option<&str>,
    retry_after_ms: Option<&str>,
    reset: Option<u64>,
    now: u64,
) -> Result<(), NetError> {
    let limited = || {
        let wait_secs = sophia_gateway::translate::anthropic::retry_after_seconds(
            retry_after,
            retry_after_ms,
            UNIX_EPOCH + Duration::from_secs(now),
        )
        .or_else(|| reset.map(|at| at.saturating_sub(now)));
        NetError::RateLimited { reset, wait_secs }
    };
    if (200..=299).contains(&status) {
        return Ok(());
    }
    if crate::net_kind::of_status(status, remaining, retry_after) == NetKind::RateLimited {
        return Err(limited());
    }
    match status {
        401 | 404 | 410 => Err(NetError::NotFound),
        other => Err(NetError::Status(other)),
    }
}

/// 之前被 GitHub 限流、还没到恢复时刻，这次没发请求
fn blocked_failure(url: &str) -> NetFailure {
    NetFailure::uncounted(
        NetError::RateLimited {
            reset: None,
            wait_secs: None,
        },
        url,
        "not sent: GitHub rate limit from an earlier request is still in effect",
    )
}

/// 读响应体读断了：超时单列，其余是读到一半断了
fn body_failure(url: &str, status: reqwest::StatusCode, error: &reqwest::Error) -> NetFailure {
    NetFailure::new(
        kind_of(error, NetError::Interrupted),
        url,
        &format!(
            "{status}\nreading the response failed: {}",
            error_chain_text(error)
        ),
    )
}

/// 按状态码与限流头判断一次响应（`classify`）；失败时顺手读一小段返回体，连同状态行写进详情
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, NetFailure> {
    let reset = header(&resp, "x-ratelimit-reset").and_then(|v| v.trim().parse().ok());
    let status = resp.status();
    let retry_after = header(&resp, "retry-after").map(str::to_string);
    let Err(error) = classify(
        status.as_u16(),
        header(&resp, "x-ratelimit-remaining"),
        retry_after.as_deref(),
        header(&resp, "retry-after-ms"),
        reset,
        now(),
    ) else {
        return Ok(resp);
    };
    let url = resp.url().to_string();
    let mut line = status.to_string();
    if let Some(value) = &retry_after {
        line.push_str(&format!(" · Retry-After: {value}"));
    }
    // 返回体只是给详情的参考：最多等 3 秒，读不到就不带
    let body = tokio::time::timeout(Duration::from_secs(3), head_of(resp))
        .await
        .unwrap_or_default();
    Err(NetFailure::new(
        error,
        &url,
        &format!("{line}{}", body_head(&body)),
    ))
}

/// 读响应体的开头几 KB，出错就停
async fn head_of(mut resp: reqwest::Response) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < 4096 {
        match resp.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }
    body
}

fn header<'a>(resp: &'a reqwest::Response, name: &str) -> Option<&'a str> {
    resp.headers().get(name).and_then(|v| v.to_str().ok())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// 缓存还新鲜：取到的时刻在 `ttl` 之内。时刻在将来（改过系统时间）按不新鲜，重新取
fn fresh(at: u64, now: u64, ttl: u64) -> bool {
    now >= at && now - at < ttl
}

/// 搜索词的缓存键：去首尾空白、小写
fn query_key(query: &str) -> String {
    query.trim().to_lowercase()
}

/// 市场客户端的设置（超时、UA）；代理由 [`MarketState::client`] 接上
fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Sophia/", env!("CARGO_PKG_VERSION")))
}

impl MarketState {
    fn client(&self) -> Result<reqwest::Client, NetFailure> {
        self.client
            .get_or_init(|| {
                // reqwest 用 rustls-no-provider：不装加密提供方，建 client 会 panic（同 sophia-gateway）
                let _ = rustls::crypto::ring::default_provider().install_default();
                sophia_gateway::runtime::follow_system_proxy(client_builder())
                    .build()
                    .map_err(|e| error_chain_text(&e))
            })
            .clone()
            .map_err(|text| NetFailure {
                error: NetError::Client,
                detail: sophia_core::redact::redact(&format!(
                    "building the HTTP client failed: {text}"
                )),
            })
    }

    /// 发一个 GET，按 `classify` 判断状态。`timeout` 为 None 时用 client 的 30 秒
    async fn get(
        &self,
        url: &str,
        timeout: Option<Duration>,
        github_api: bool,
    ) -> Result<reqwest::Response, NetFailure> {
        let mut request = self.client()?.get(url);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if github_api {
            request = request
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28");
        }
        let resp = request.send().await.map_err(|e| {
            NetFailure::new(kind_of(&e, NetError::Network), url, &error_chain_text(&e))
        })?;
        check_status(resp).await
    }

    /// 读完响应体，超过 `cap` 即停
    async fn read_capped(mut resp: reqwest::Response, cap: u64) -> Result<Vec<u8>, NetFailure> {
        let url = resp.url().to_string();
        if resp.content_length().is_some_and(|n| n > cap) {
            return Err(NetFailure::new(
                NetError::TooLarge,
                &url,
                &format!("{} larger than {cap} bytes", resp.status()),
            ));
        }
        let mut body = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if (body.len() + chunk.len()) as u64 > cap {
                        return Err(NetFailure::new(
                            NetError::TooLarge,
                            &url,
                            &format!("{} larger than {cap} bytes", resp.status()),
                        ));
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => return Ok(body),
                Err(e) => return Err(body_failure(&url, resp.status(), &e)),
            }
        }
    }

    async fn get_bytes(&self, url: &str, github_api: bool) -> Result<Vec<u8>, NetFailure> {
        let resp = self.get(url, None, github_api).await?;
        Self::read_capped(resp, JSON_CAP).await
    }

    // ── skills.sh ──

    async fn fetch_skills(&self, query: &str) -> Result<Vec<SkillHit>, NetFailure> {
        self.fetch_skills_at(SKILLS_SEARCH_URL, query).await
    }

    /// 地址由参数给（单测指到本机假服务）
    async fn fetch_skills_at(&self, base: &str, query: &str) -> Result<Vec<SkillHit>, NetFailure> {
        let url = reqwest::Url::parse_with_params(
            base,
            &[("q", query), ("limit", &SKILLS_LIMIT.to_string())],
        )
        .map_err(|e| NetFailure::new(NetError::Client, base, &e.to_string()))?;
        let body = self.get_bytes(url.as_str(), false).await?;
        parse_skill_search(&body).ok_or_else(|| {
            NetFailure::unreadable(url.as_str(), "response is not the expected JSON", &body)
        })
    }

    // ── MCP Registry ──

    async fn fetch_registry(&self, query: &str) -> Result<Vec<RegistryHit>, NetFailure> {
        self.fetch_registry_at(REGISTRY_URL, query).await
    }

    /// 地址由参数给（单测指到本机假服务）
    async fn fetch_registry_at(
        &self,
        base: &str,
        query: &str,
    ) -> Result<Vec<RegistryHit>, NetFailure> {
        let url = reqwest::Url::parse_with_params(
            base,
            &[
                ("search", query),
                ("limit", &REGISTRY_LIMIT.to_string()),
                ("version", "latest"),
            ],
        )
        .map_err(|e| NetFailure::new(NetError::Client, base, &e.to_string()))?;
        let body = self.get_bytes(url.as_str(), false).await?;
        parse_registry(&body).ok_or_else(|| {
            NetFailure::unreadable(url.as_str(), "response is not the expected JSON", &body)
        })
    }

    // ── GitHub：默认分支、下载、raw、trees ──

    /// 仓库的默认分支：读 git 智能 HTTP 首行的 `symref=HEAD:refs/heads/<分支>`，不占接口次数。缓存 6 小时
    async fn default_branch(&self, repo: &str) -> Result<String, NetFailure> {
        let key = repo.to_lowercase();
        let t = now();
        if let Some((at, branch)) = guard(&self.branches).get(&key) {
            if fresh(*at, t, TTL_SECS) {
                return Ok(branch.clone());
            }
        }
        let url = format!("https://github.com/{repo}.git/info/refs?service=git-upload-pack");
        let mut resp = self.get(&url, None, false).await?;
        let unreadable = |head: &[u8]| {
            NetFailure::unreadable(
                &url,
                "no default branch (symref=HEAD) in the response",
                head,
            )
        };
        let mut head = Vec::new();
        let branch = loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    head.extend_from_slice(&chunk);
                    if let Some(branch) = parse_symref(&head) {
                        break branch;
                    }
                    if head.len() > REFS_CAP {
                        return Err(unreadable(&head));
                    }
                }
                Ok(None) => return parse_symref(&head).ok_or_else(|| unreadable(&head)),
                Err(e) => return Err(body_failure(&url, resp.status(), &e)),
            }
        };
        // 读到就停：大仓库的 refs 列表（含所有 PR 的 refs）可以有几 MB
        drop(resp);
        guard(&self.branches).insert(key, (t, branch.clone()));
        Ok(branch)
    }

    /// 分支给了就用它，没给（或写的是 `HEAD`）取默认分支
    async fn branch_or_default(
        &self,
        repo: &str,
        branch: Option<&str>,
    ) -> Result<String, NetFailure> {
        match branch
            .map(str::trim)
            .filter(|b| !b.is_empty() && *b != "HEAD")
        {
            Some(branch) => Ok(branch.to_string()),
            None => self.default_branch(repo).await,
        }
    }

    /// codeload 整包；同一个仓库分支在 15 分钟里只下一次
    async fn download(&self, repo: &str, branch: &str) -> Result<Arc<Vec<u8>>, NetFailure> {
        let key = repo.to_lowercase();
        let t = now();
        {
            let mut cached = guard(&self.archives);
            cached.retain(|a| fresh(a.at, t, ARCHIVE_TTL_SECS));
            if let Some(hit) = cached.iter().find(|a| a.repo == key && a.branch == branch) {
                return Ok(hit.bytes.clone());
            }
        }
        let url = link::codeload_url(repo, branch);
        let resp = self.get(&url, Some(DOWNLOAD_TIMEOUT), false).await?;
        let bytes = Arc::new(Self::read_capped(resp, MAX_DOWNLOAD_BYTES).await?);
        let mut cached = guard(&self.archives);
        cached.retain(|a| !(a.repo == key && a.branch == branch));
        while cached.len() >= ARCHIVE_SLOTS {
            cached.remove(0);
        }
        cached.push(CachedArchive {
            repo: key,
            branch: branch.to_string(),
            at: t,
            bytes: bytes.clone(),
        });
        Ok(bytes)
    }

    /// raw 取一个文本文件；404 为 Ok(None)
    async fn raw_text(&self, url: &str) -> Result<Option<String>, NetFailure> {
        match self.get_bytes(url, false).await {
            Ok(body) => Ok(Some(String::from_utf8_lossy(&body).into_owned())),
            Err(f) if f.error == NetError::NotFound => Ok(None),
            Err(f) => Err(f),
        }
    }

    /// 限流中就不发 GitHub 接口请求（R16：不自动重试）
    fn github_blocked(&self, t: u64) -> bool {
        guard(&self.github_blocked_until).is_some_and(|until| t < until)
    }

    fn note_rate_limit(&self, error: &NetError) {
        if let NetError::RateLimited { reset, .. } = error {
            let until = reset.unwrap_or_else(|| now() + RATE_LIMIT_FALLBACK_SECS);
            *guard(&self.github_blocked_until) = Some(until);
        }
    }

    /// `GET /repos/{repo}/git/trees/{reference}?recursive=1`：reference 是分支或 tree SHA
    async fn fetch_tree(&self, repo: &str, reference: &str) -> Result<ParsedTree, NetFailure> {
        let url = format!("https://api.github.com/repos/{repo}/git/trees/{reference}?recursive=1");
        if self.github_blocked(now()) {
            return Err(blocked_failure(&url));
        }
        let result = match self.get_bytes(&url, true).await {
            Ok(body) => parse_tree(&body).ok_or_else(|| {
                NetFailure::unreadable(&url, "response is not the expected JSON", &body)
            }),
            Err(e) => Err(e),
        };
        if let Err(e) = &result {
            self.note_rate_limit(&e.error);
        }
        result
    }

    // ── 缓存 ──

    fn with_cache<R>(&self, f: impl FnOnce(&mut DiskCache) -> R) -> R {
        let mut slot = guard(&self.cache);
        let cache = slot.get_or_insert_with(|| {
            cache_path()
                .and_then(|p| std::fs::read(p).ok())
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default()
        });
        f(cache)
    }

    /// 改缓存并写回文件（尽力而为：写不了不影响这次的结果）
    fn update_cache(&self, f: impl FnOnce(&mut DiskCache)) {
        let snapshot = self.with_cache(|cache| {
            f(cache);
            serde_json::to_vec(cache).ok()
        });
        if let (Some(bytes), Some(path)) = (snapshot, cache_path()) {
            if let Err(e) = write_atomic(&path, &bytes) {
                log::warn!("写发现页缓存 {} 失败：{e}", path.display());
            }
        }
    }

    /// 撤销记录登记进内存，id 写回结果
    fn register_undo(&self, outcome: &mut InstallOutcome) {
        let Some(undo) = outcome.take_undo() else {
            return;
        };
        let id = format!(
            "market-{}",
            self.next_undo.fetch_add(1, Ordering::Relaxed) + 1
        );
        let mut records = guard(&self.undo);
        if records.len() >= UNDO_LIMIT {
            records.remove(0);
        }
        records.push((id.clone(), undo));
        outcome.undo_id = Some(id);
    }
}

/// 锁坏了（别的线程拿着锁 panic）也照样拿到里面的数据：这里存的都是缓存，坏了顶多多联网一次
fn guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cache_path() -> Option<PathBuf> {
    crate::runtime_store_dir().ok().map(|d| d.join(CACHE_FILE))
}

/// 先写 .tmp 再改名，同 store 的写法
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// 记一个查询的结果；超过 `CACHE_QUERIES` 个时去掉最旧的
fn remember<T>(map: &mut BTreeMap<String, Cached<T>>, key: String, at: u64, items: T) {
    map.insert(key, Cached { at, items });
    while map.len() > CACHE_QUERIES {
        let Some(oldest) = map.iter().min_by_key(|(_, c)| c.at).map(|(k, _)| k.clone()) else {
            break;
        };
        map.remove(&oldest);
    }
}

// ── 纯解析（单测覆盖）──

/// skills.sh `/api/search` 的响应 → 条目。`source` 不像 `owner/repo` 的跳过；
/// 显示名用 `name`（没有时用 `skillId`），`skillId` 另记。读不懂整个响应为 None
fn parse_skill_search(body: &[u8]) -> Option<Vec<SkillHit>> {
    let root: Value = serde_json::from_slice(body).ok()?;
    let skills = root.get("skills")?.as_array()?;
    Some(
        skills
            .iter()
            .filter_map(|s| {
                let text = |key: &str| {
                    s.get(key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                };
                let source = link::parse(text("source")?).ok()?;
                if source.branch.is_some() || source.path.is_some() {
                    return None;
                }
                let skill_id = text("skillId").map(str::to_string);
                let name = text("name")
                    .map(str::to_string)
                    .or_else(|| skill_id.clone())?;
                let installs = s
                    .get("installs")
                    .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64)))
                    .unwrap_or(0);
                Some(SkillHit {
                    listing: SkillListing {
                        name,
                        repo: source.slug(),
                        path: None,
                        installs,
                    },
                    skill_id,
                })
            })
            .collect(),
    )
}

/// git 智能 HTTP 首行里的默认分支：`symref=HEAD:refs/heads/<分支>`，读到分隔符才算完整
fn parse_symref(head: &[u8]) -> Option<String> {
    const MARK: &str = "symref=HEAD:refs/heads/";
    let text = String::from_utf8_lossy(head);
    let at = text.find(MARK)?;
    let rest = &text[at + MARK.len()..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '\0')?;
    let branch = &rest[..end];
    (!branch.is_empty()).then(|| branch.to_string())
}

/// trees 接口的响应
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ParsedTree {
    /// 文件夹路径 → tree SHA；根是空串
    folders: BTreeMap<String, String>,
    /// 文件（含软链接）路径 → blob SHA
    blobs: BTreeMap<String, String>,
}

fn parse_tree(body: &[u8]) -> Option<ParsedTree> {
    let root: Value = serde_json::from_slice(body).ok()?;
    let mut out = ParsedTree::default();
    out.folders
        .insert(String::new(), root.get("sha")?.as_str()?.to_lowercase());
    for entry in root.get("tree")?.as_array()? {
        let (Some(path), Some(kind), Some(sha)) = (
            entry.get("path").and_then(Value::as_str),
            entry.get("type").and_then(Value::as_str),
            entry.get("sha").and_then(Value::as_str),
        ) else {
            continue;
        };
        match kind {
            "tree" => {
                out.folders.insert(path.to_string(), sha.to_lowercase());
            }
            "blob" => {
                out.blobs.insert(path.to_string(), sha.to_lowercase());
            }
            // 子模块（commit）不在 skill 文件夹里算
            _ => {}
        }
    }
    Some(out)
}

/// 比较名字用：小写，只留字母数字（`react:components`、`react-components`、`reactcomponents` 算同一个）
fn loose(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn last_segment<'a>(path: &'a str, repo_name: &'a str) -> &'a str {
    path.trim_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(repo_name)
}

fn repo_name(repo: &str) -> &str {
    repo.rsplit('/').next().unwrap_or(repo)
}

/// 包里的 skill 文件夹中，名字对得上 `wanted` 的那一个：先按文件夹名完全相同，再按 `loose` 相同。
/// 仓库根的 skill 名字是仓库名
fn match_skill_dir<'a>(dirs: &'a [String], wanted: &[&str], repo: &str) -> Option<&'a String> {
    let name = |d: &'a String| last_segment(d, repo_name(repo));
    dirs.iter().find(|d| wanted.contains(&name(d))).or_else(|| {
        let wanted: Vec<String> = wanted.iter().map(|w| loose(w)).collect();
        dirs.iter()
            .find(|d| !loose(name(d)).is_empty() && wanted.contains(&loose(name(d))))
    })
}

/// 请求里的路径换成包里真有的 skill 文件夹：本来就是的不动；只写了名字（搜索结果没有路径）
/// 或写得不对的，按最后一段找同名的；找不到的原样留着，由计划 / 解包说原因
fn resolve_paths(paths: &[String], dirs: &[String], repo: &str) -> Vec<String> {
    paths
        .iter()
        .map(|raw| {
            let path = raw.trim_matches('/');
            if dirs.iter().any(|d| d == path) {
                return path.to_string();
            }
            let wanted = last_segment(path, repo_name(repo));
            match_skill_dir(dirs, &[wanted], repo)
                .cloned()
                .unwrap_or_else(|| path.to_string())
        })
        .collect()
}

/// 链接指着的文件夹下面的 skill（R6）：没路径时是全部；指着 skill 文件夹就是它一个
fn skills_under(dirs: &[String], path: Option<&str>, repo: &str) -> Vec<RepoSkill> {
    let prefix = path.map(|p| p.trim_matches('/')).filter(|p| !p.is_empty());
    dirs.iter()
        .filter(|d| match prefix {
            None => true,
            Some(p) => d.as_str() == p || d.starts_with(&format!("{p}/")),
        })
        .map(|d| RepoSkill {
            name: last_segment(d, repo_name(repo)).to_string(),
            path: d.clone(),
        })
        .collect()
}

/// `tree/<分支>/<路径>` 里分支可能带 `/`：依次把路径前几段挪进分支（`link` 模块说明）
fn branch_candidates(branch: &str, path: Option<&str>) -> Vec<(String, Option<String>)> {
    let segs: Vec<&str> = path
        .map(|p| p.split('/').filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    (0..=segs.len().min(BRANCH_SLASH_RETRIES))
        .map(|moved| {
            let mut b = branch.to_string();
            for seg in &segs[..moved] {
                b.push('/');
                b.push_str(seg);
            }
            let rest = segs[moved..].join("/");
            (b, (!rest.is_empty()).then_some(rest))
        })
        .collect()
}

/// 搜索结果没有仓库内路径时，先按这几种常见布局在 raw 上猜（不占次数），猜不中再下整包找
fn guess_paths(names: &[&str], repo: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names
        .iter()
        .filter(|n| link::parse(&format!("a/{n}")).is_ok())
    {
        for p in [
            format!("skills/{name}"),
            name.to_string(),
            format!(".claude/skills/{name}"),
        ] {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    // skill 就在仓库根：只有名字与仓库名对得上才猜，免得把多 skill 仓库的根当成它
    if names.iter().any(|n| loose(n) == loose(repo_name(repo))) {
        out.push(String::new());
    }
    out
}

// ── MCP Registry 的映射 ──

/// `{name}` 模板（Registry 的写法）换成 `${name}`（定义里占位的写法），已是 `${…}` 的不动。
/// 返回换好的文本与里面的变量名（按先后）
fn convert_template(text: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len() + 4);
    let mut vars = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let (before, after) = rest.split_at(open);
        out.push_str(before);
        let body = &after[1..];
        let close = body.find('}');
        let ok_name = |name: &str| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        };
        match close {
            Some(len) if ok_name(&body[..len]) => {
                let name = &body[..len];
                if !out.ends_with('$') {
                    out.push('$');
                }
                out.push('{');
                out.push_str(name);
                out.push('}');
                if !vars.iter().any(|v| v == name) {
                    vars.push(name.to_string());
                }
                rest = &body[len + 1..];
            }
            _ => {
                out.push('{');
                rest = body;
            }
        }
    }
    out.push_str(rest);
    (out, vars)
}

fn looks_secret(name: &str) -> bool {
    let n = name.to_lowercase();
    ["key", "token", "secret", "password", "auth", "credential"]
        .iter()
        .any(|w| n.contains(w))
}

fn flag(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}

fn text_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 收集「要填的」：同名只记一次（先到的为准）
struct Fields(Vec<McpFieldSpec>);

impl Fields {
    fn add(
        &mut self,
        key: &str,
        kind: McpFieldKind,
        required: bool,
        secret: bool,
        desc: Option<&str>,
    ) {
        if self.0.iter().any(|f| f.key == key) {
            return;
        }
        self.0.push(McpFieldSpec {
            key: key.to_string(),
            kind,
            required,
            secret,
            description: desc.map(str::to_string),
        });
    }

    /// Registry 的一个输入（`KeyValueInput` / `Input`）→ 定义里的值。
    /// - 有 `value`：把里面的 `{var}` 换成占位，每个变量成一项（`variables` 里有说明就用它的）。
    ///   这种嵌在固定文字里的变量一律必填：没填的话整条不写（`define` 的规则）
    /// - 没 `value`：整个值就是 `${名字}`，必填、密钥照 Registry 写的
    fn value_of(&mut self, input: &Value, key: &str, kind: McpFieldKind) -> String {
        let secret = flag(input, "isSecret").unwrap_or(false);
        let desc = text_of(input, "description");
        match text_of(input, "value") {
            Some(value) => {
                let (converted, vars) = convert_template(value);
                for var in vars {
                    let spec = input.get("variables").and_then(|v| v.get(&var));
                    let var_secret = spec.and_then(|s| flag(s, "isSecret")).unwrap_or(secret)
                        || looks_secret(&var);
                    let var_desc = spec.and_then(|s| text_of(s, "description")).or(desc);
                    self.add(&var, kind, true, var_secret, var_desc);
                }
                converted
            }
            None => {
                let required = flag(input, "isRequired").unwrap_or(false);
                self.add(key, kind, required, secret || looks_secret(key), desc);
                format!("${{{key}}}")
            }
        }
    }

    /// 包参数（`PositionalArgument` / `NamedArgument`）→ 命令行里的几段
    fn args_of(&mut self, list: Option<&Value>) -> Vec<String> {
        let mut out = Vec::new();
        for arg in list.and_then(Value::as_array).into_iter().flatten() {
            let named = arg.get("type").and_then(Value::as_str) == Some("named");
            let name = text_of(arg, "name");
            let hint = text_of(arg, "valueHint").or(name).unwrap_or("VALUE");
            let key: String = hint
                .trim_start_matches('-')
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_ascii_uppercase()
                    } else {
                        '_'
                    }
                })
                .collect();
            let has_value = arg.get("value").is_some();
            let required = flag(arg, "isRequired").unwrap_or(false);
            if named {
                let Some(name) = name else { continue };
                if !has_value && !required {
                    // 没值又选填：多半是个开关，不加
                    continue;
                }
                out.push(name.to_string());
                if has_value || text_of(arg, "valueHint").is_some() || required {
                    out.push(self.value_of(arg, &key, McpFieldKind::Arg));
                }
            } else if has_value || required {
                out.push(self.value_of(arg, &key, McpFieldKind::Arg));
            }
        }
        out
    }
}

/// `io.github.brave/…` → `brave`；`ai.smithery/…` → `smithery.ai`；其余反向域名倒过来
fn publisher_of(full_name: &str) -> String {
    let namespace = full_name.split('/').next().unwrap_or(full_name);
    if let Some(user) = namespace.strip_prefix("io.github.") {
        return user.to_string();
    }
    namespace.split('.').rev().collect::<Vec<_>>().join(".")
}

/// 配置里的服务名：全名 `/` 之后那段；太泛的（`mcp`、`server`）前面加上发布方
fn server_name(full_name: &str) -> String {
    let slug = full_name.rsplit('/').next().unwrap_or(full_name);
    if matches!(slug, "mcp" | "server" | "mcp-server") {
        let publisher = publisher_of(full_name).replace('.', "-");
        return format!("{publisher}-{slug}");
    }
    slug.to_string()
}

/// 一个包 → stdio 定义。只收 npm / pypi / oci，传输是 stdio（缺省也当 stdio）
fn package_definition(
    name: &str,
    pkg: &Value,
    fields: &mut Fields,
) -> Option<(McpDefinitionInput, String)> {
    let kind = pkg.get("registryType").and_then(Value::as_str)?;
    let transport = pkg
        .get("transport")
        .and_then(|t| t.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    if transport != "stdio" {
        return None;
    }
    let identifier = text_of(pkg, "identifier")?;
    let mut env = BTreeMap::new();
    for var in pkg
        .get("environmentVariables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(key) = text_of(var, "name") else {
            continue;
        };
        let value = fields.value_of(var, key, McpFieldKind::Env);
        env.insert(key.to_string(), value);
    }
    let runtime = fields.args_of(pkg.get("runtimeArguments"));
    let package = fields.args_of(pkg.get("packageArguments"));
    let (command, homepage, mut args) = match kind {
        "npm" => {
            // 有的条目自己在 runtimeArguments 里写了 `-y`：不重复加
            let mut args = runtime;
            if !args.iter().any(|a| a == "-y" || a == "--yes") {
                args.insert(0, "-y".to_string());
            }
            (
                "npx",
                format!("https://www.npmjs.com/package/{identifier}"),
                args,
            )
        }
        "pypi" => (
            "uvx",
            format!("https://pypi.org/project/{identifier}/"),
            runtime,
        ),
        "oci" => {
            let mut args: Vec<String> = ["run", "-i", "--rm"].map(String::from).to_vec();
            args.extend(runtime);
            // 环境变量按名字传进容器，值由 agent 的 env 给
            for key in env.keys() {
                if !args.windows(2).any(|w| w[0] == "-e" && &w[1] == key) {
                    args.push("-e".into());
                    args.push(key.clone());
                }
            }
            ("docker", String::new(), args)
        }
        _ => return None,
    };
    args.push(identifier.to_string());
    args.extend(package);
    Some((
        McpDefinitionInput {
            name: name.to_string(),
            transport: McpTransport::Stdio,
            command: Some(command.to_string()),
            args,
            env,
            url: None,
            headers: BTreeMap::new(),
            extra: BTreeMap::new(),
            dialect: None,
        },
        homepage,
    ))
}

/// 一个远程地址 → http / sse 定义
fn remote_definition(
    name: &str,
    remote: &Value,
    fields: &mut Fields,
) -> Option<McpDefinitionInput> {
    let transport = match remote.get("type").and_then(Value::as_str)? {
        "streamable-http" | "http" => McpTransport::Http,
        "sse" => McpTransport::Sse,
        _ => return None,
    };
    let raw_url = text_of(remote, "url")?;
    if !raw_url.starts_with("https://") && !raw_url.starts_with("http://") {
        return None;
    }
    let (url, vars) = convert_template(raw_url);
    for var in vars {
        let spec = remote.get("variables").and_then(|v| v.get(&var));
        let secret = spec.and_then(|s| flag(s, "isSecret")).unwrap_or(false);
        let desc = spec.and_then(|s| text_of(s, "description"));
        fields.add(&var, McpFieldKind::Arg, true, secret, desc);
    }
    let mut headers = BTreeMap::new();
    for h in remote
        .get("headers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(key) = text_of(h, "name") else {
            continue;
        };
        let value = fields.value_of(h, key, McpFieldKind::Header);
        headers.insert(key.to_string(), value);
    }
    Some(McpDefinitionInput {
        name: name.to_string(),
        transport,
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        url: Some(url),
        headers,
        extra: BTreeMap::new(),
        dialect: None,
    })
}

/// Registry 的一条 `ServerResponse` → 目录条目。不是 `active` 的、没有能用的包或远程地址的为 None。
/// 包优先（npm → pypi → oci，本机跑，各家 agent 都接得住），没有才用远程地址
fn registry_entry(item: &Value) -> Option<RegistryHit> {
    let status = item
        .get("_meta")
        .and_then(|m| m.get("io.modelcontextprotocol.registry/official"))
        .and_then(|m| m.get("status"))
        .and_then(Value::as_str);
    if status != Some("active") {
        return None;
    }
    let server = item.get("server")?;
    let full_name = text_of(server, "name")?;
    let name = server_name(full_name);
    let packages: Vec<&Value> = server
        .get("packages")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let mut chosen = None;
    'kinds: for kind in ["npm", "pypi", "oci"] {
        for pkg in packages
            .iter()
            .filter(|p| p.get("registryType").and_then(Value::as_str) == Some(kind))
        {
            let mut fields = Fields(Vec::new());
            if let Some((def, homepage)) = package_definition(&name, pkg, &mut fields) {
                chosen = Some((def, fields, Some(homepage).filter(|h| !h.is_empty())));
                break 'kinds;
            }
        }
    }
    if chosen.is_none() {
        for remote in server
            .get("remotes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let mut fields = Fields(Vec::new());
            if let Some(def) = remote_definition(&name, remote, &mut fields) {
                chosen = Some((def, fields, None));
                break;
            }
        }
    }
    let (definition, fields, package_page) = chosen?;
    let repo_url = server
        .get("repository")
        .and_then(|r| text_of(r, "url"))
        .filter(|u| link::parse(u).is_ok());
    let repository = repo_url.map(|url| {
        match server
            .get("repository")
            .and_then(|r| text_of(r, "subfolder"))
            .map(|s| s.trim_matches('/'))
            .filter(|s| !s.is_empty())
        {
            Some(sub) => format!("{}/tree/HEAD/{sub}", url.trim_end_matches('/')),
            None => url.to_string(),
        }
    });
    let homepage = text_of(server, "websiteUrl")
        .map(str::to_string)
        .or_else(|| repo_url.map(str::to_string))
        .or(package_page);
    let description = text_of(server, "description")
        .or_else(|| text_of(server, "title"))
        .unwrap_or_default()
        .to_string();
    Some(RegistryHit {
        id: full_name.to_string(),
        entry: McpCatalogEntry {
            name,
            publisher: publisher_of(full_name),
            description,
            definition,
            fields: fields.0,
            homepage,
            source: "registry".into(),
            // 官方目录不标登录方式：要填的项由 fields 说
            sign_in: false,
        },
        repository,
    })
}

/// `/v0.1/servers` 的响应 → 条目（按返回的先后，同一个全名只留一条）。读不懂整个响应为 None
fn parse_registry(body: &[u8]) -> Option<Vec<RegistryHit>> {
    let root: Value = serde_json::from_slice(body).ok()?;
    let mut seen = BTreeSet::new();
    Some(
        root.get("servers")?
            .as_array()?
            .iter()
            .filter_map(registry_entry)
            .filter(|hit| seen.insert(hit.id.clone()))
            .collect(),
    )
}

/// 精选里与查询词匹配的（名字、发布方、说明里含有，不分大小写）；空查询是全部
fn curated_matching(curated: Vec<McpCatalogEntry>, query: &str) -> Vec<McpCatalogEntry> {
    let q = query_key(query);
    curated
        .into_iter()
        .filter(|e| {
            q.is_empty()
                || [&e.name, &e.publisher, &e.description]
                    .iter()
                    .any(|s| s.to_lowercase().contains(&q))
        })
        .collect()
}

/// 随包热门里与查询词匹配的：skills.sh 连不上又没有缓存时的兜底
fn snapshot_matching(snapshot: Vec<SkillListing>, query: &str) -> Vec<SkillHit> {
    let q = query_key(query);
    snapshot
        .into_iter()
        .filter(|s| {
            q.is_empty() || s.name.to_lowercase().contains(&q) || s.repo.to_lowercase().contains(&q)
        })
        .map(|listing| SkillHit {
            listing,
            skill_id: None,
        })
        .collect()
}

/// npm 包信息里的 `repository`（`git+https://github.com/o/r.git`、`github:o/r`、带 `directory`）
/// → GitHub 仓库网址（可带 `/tree/HEAD/<子目录>`）
fn npm_repository(doc: &Value) -> Option<String> {
    let repo = doc.get("repository")?;
    let (url, directory) = match repo {
        Value::String(s) => (s.as_str(), None),
        _ => (repo.get("url")?.as_str()?, text_of(repo, "directory")),
    };
    let url = url.trim();
    let url = url.strip_prefix("git+").unwrap_or(url);
    let url = url.strip_prefix("github:").unwrap_or(url);
    let url = url
        .replace("git://github.com/", "https://github.com/")
        .replace("ssh://git@github.com/", "https://github.com/")
        .replace("git@github.com:", "https://github.com/");
    let r = link::parse(&url).ok()?;
    let base = format!("https://github.com/{}", r.slug());
    Some(
        match directory
            .map(|d| d.trim_matches('/'))
            .filter(|d| !d.is_empty())
        {
            Some(dir) => format!("{base}/tree/HEAD/{dir}"),
            None => base,
        },
    )
}

/// 说明页链接里的 npm 包名：`https://www.npmjs.com/package/@scope/name`
fn npm_package(homepage: &str) -> Option<&str> {
    let rest = homepage
        .strip_prefix("https://www.npmjs.com/package/")
        .or_else(|| homepage.strip_prefix("https://npmjs.com/package/"))?;
    let rest = rest.split(['?', '#']).next()?.trim_end_matches('/');
    (!rest.is_empty()).then_some(rest)
}

fn is_github_url(url: &str) -> bool {
    url.starts_with("https://github.com/") && link::parse(url).is_ok()
}

// ── 装在了哪 ──

/// 发现列表的 `✓ 已安装`：Sophia 的记录、lock，与各位置通用仓库里此刻有的文件夹名
#[derive(Default)]
struct Installed {
    records: Vec<InstallRecord>,
    lock: Vec<LockEntry>,
    /// (域 key, 通用仓库里的条目名)
    stores: Vec<(String, BTreeSet<String>)>,
}

impl Installed {
    /// 这个 skill 装在了哪些位置（域 key，去重、按先后）：
    /// 知道仓库内路径时按 仓库 + 路径 认记录与 lock；再按 仓库 + 名字 认；再看各位置的通用仓库里有没有同名的
    fn locations(&self, repo: &str, path: Option<&str>, names: &[&str]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |key: String| {
            if !out.contains(&key) {
                out.push(key);
            }
        };
        if let Some(path) = path {
            for key in installs::installed_locations(&self.records, &self.lock, repo, path) {
                push(key);
            }
        }
        let same_repo = |r: &str| r.eq_ignore_ascii_case(repo);
        for r in &self.records {
            if same_repo(&r.repo) && names.contains(&r.name.as_str()) {
                push(r.location.clone());
            }
        }
        for e in &self.lock {
            if same_repo(&e.repo) && names.contains(&e.name.as_str()) {
                push(GLOBAL.to_string());
            }
        }
        for (key, entries) in &self.stores {
            if names.iter().any(|n| entries.contains(*n)) {
                push(key.clone());
            }
        }
        out
    }
}

fn lock_path_of(env: &Env) -> PathBuf {
    lock::lock_path(
        &env.home,
        env.vars.get("XDG_STATE_HOME").map(String::as_str),
    )
}

fn project_key(project: &Path) -> String {
    format!("project:{}", normalize(project).display())
}

/// 读装过的事实；读不到的部分当没有（发现列表不因为这个失败）
fn installed_context(state: &AppState) -> Installed {
    let Ok(env) = crate::runtime_env() else {
        return Installed::default();
    };
    let projects = crate::installed_and_settings(state, &env)
        .and_then(|(installed, settings)| {
            let shown = discovery::enabled(installed, &settings);
            crate::shown_projects(state, &env, &shown, &settings)
        })
        .unwrap_or_default();
    let mut locations = vec![GLOBAL.to_string()];
    locations.extend(projects.iter().map(|p| project_key(p)));
    let stores = locations
        .into_iter()
        .filter_map(|key| {
            let dir = install::store_dir(&env.home, &key)?;
            let names: BTreeSet<String> = std::fs::read_dir(dir)
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|n| !n.starts_with('.'))
                        .collect()
                })
                .unwrap_or_default();
            (!names.is_empty()).then_some((key, names))
        })
        .collect();
    // 记录与 lock 只是「装过」：文件夹被删了（在我的里删原件、手动删、npx skills remove）它们还在，
    // 所以只认落点里此刻还在的那些，不然删掉的仍显示 `✓ 已安装`
    let still_there = |location: &str, name: &str| {
        install::store_dir(&env.home, location).is_some_and(|dir| dir.join(name).is_dir())
    };
    let records = state
        .store
        .load_installs()
        .unwrap_or_default()
        .into_iter()
        .filter(|r| still_there(&r.location, &r.name))
        .collect();
    let lock = lock::read(&lock_path_of(&env))
        .into_iter()
        .filter(|e| still_there(GLOBAL, &e.name))
        .collect();
    Installed {
        records,
        lock,
        stores,
    }
}

fn skill_rows(hits: Vec<SkillHit>, installed: &Installed) -> Vec<SkillRow> {
    hits.into_iter()
        .map(|hit| {
            let listing = hit.listing;
            let mut names: Vec<&str> = vec![listing.name.as_str()];
            if let Some(id) = &hit.skill_id {
                names.push(id);
            }
            if let Some(path) = &listing.path {
                names.push(last_segment(path, repo_name(&listing.repo)));
            }
            let installed_in = installed.locations(&listing.repo, listing.path.as_deref(), &names);
            SkillRow {
                skill_id: hit.skill_id.clone(),
                installed_in,
                listing,
            }
        })
        .collect()
}

/// 与 `discover_mcp` 同一套 MCP 列：名单里支持 MCP 的，加跟着 Claude Code 的 Claude Desktop；
/// WeiboAP 照旧跟着名单
fn mcp_harnesses(state: &AppState, env: &Env) -> Result<Vec<Harness>, String> {
    #[cfg_attr(not(feature = "weiboap"), allow(unused_mut))]
    let (mut candidates, settings) = crate::installed_and_settings(state, env)?;
    #[cfg(feature = "weiboap")]
    if !candidates.iter().any(|h| h.id == "weiboap") {
        if let Some(weiboap) = discovery::all_harnesses(env)
            .into_iter()
            .find(|h| h.id == "weiboap")
        {
            candidates.push(weiboap);
        }
    }
    let shown = discovery::enabled(candidates, &settings);
    let mut harnesses = discovery::mcp_columns(env, &shown);
    harnesses.extend(shown.into_iter().filter(|h| h.id == "weiboap"));
    Ok(harnesses)
}

/// 服务名 → 已经有它的位置（域 key）
fn mcp_installed(state: &AppState) -> BTreeMap<String, Vec<String>> {
    let Ok(found) = crate::discover_mcp(state) else {
        return BTreeMap::new();
    };
    let overview = sophia_core::mcp::scan(&found.locations);
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in &overview.entries {
        let Some(location) = found.locations.iter().find(|l| l.id == entry.source_id) else {
            continue;
        };
        let slot = out.entry(entry.name.clone()).or_default();
        if !slot.contains(&location.domain) {
            slot.push(location.domain.clone());
        }
    }
    out
}

fn mcp_row(
    id: String,
    entry: McpCatalogEntry,
    repository: Option<String>,
    installed: &BTreeMap<String, Vec<String>>,
) -> McpRow {
    McpRow {
        installed_in: installed.get(&entry.name).cloned().unwrap_or_default(),
        id,
        repository,
        entry,
    }
}

fn curated_rows(
    entries: Vec<McpCatalogEntry>,
    installed: &BTreeMap<String, Vec<String>>,
) -> Vec<McpRow> {
    entries
        .into_iter()
        .map(|entry| {
            let repository = entry.homepage.clone().filter(|h| is_github_url(h));
            mcp_row(
                format!("curated:{}", entry.name),
                entry,
                repository,
                installed,
            )
        })
        .collect()
}

// ── 发现 ──

fn popular_list(state: &AppState, market: &MarketState) -> SkillList {
    let (hits, fallback, meta) = popular::cached_result(market, now());
    SkillList {
        items: skill_rows(hits, &installed_context(state)),
        fallback,
        popular: Some(meta),
    }
}

/// 热门榜单：默认只读缓存；联网刷新由前端后台请求。
#[tauri::command]
pub async fn market_popular(
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
    refresh: Option<bool>,
    force: Option<bool>,
) -> Result<SkillList, String> {
    if refresh.unwrap_or(false) {
        popular::refresh(&market, force.unwrap_or(false), popular::HOME_URL).await;
    }
    Ok(popular_list(&state, &market))
}

/// skills.sh 搜索（R5）：`GET https://skills.sh/api/search?q=&limit=`，缓存 6 小时。停 300ms 由前端做。
/// 不到 2 个字列热门。连不上：有缓存（哪怕过期）用缓存，没有用随包热门里匹配的，都带 `fallback`
#[tauri::command]
pub async fn market_search_skills(
    query: String,
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
) -> Result<SkillList, String> {
    let key = query_key(&query);
    if key.chars().count() < MIN_QUERY_CHARS {
        return Ok(popular_list(&state, &market));
    }
    let t = now();
    let cached = market.with_cache(|c| c.skills.get(&key).cloned());
    let (hits, fallback) = match cached {
        Some(c) if fresh(c.at, t, TTL_SECS) => (c.items, None),
        cached => match market.fetch_skills(query.trim()).await {
            Ok(hits) => {
                let items = hits.clone();
                market.update_cache(|c| remember(&mut c.skills, key, t, items));
                (hits, None)
            }
            Err(failure) => {
                let cached_at = cached.as_ref().map(|c| c.at);
                let hits = match cached {
                    Some(c) => c.items,
                    None => snapshot_matching(sophia_core::market::popular_snapshot(), &query),
                };
                let fallback = Fallback::from_failure("skills.sh", cached_at, &failure);
                (hits, Some(fallback))
            }
        },
    };
    let installed = installed_context(&state);
    Ok(SkillList {
        items: skill_rows(hits, &installed),
        fallback,
        popular: None,
    })
}

/// MCP 精选（R7）：随包清单，标上装过的
#[tauri::command]
pub fn market_mcp_curated(
    query: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<McpList, String> {
    let installed = mcp_installed(&state);
    Ok(McpList {
        curated: curated_rows(
            curated_matching(
                sophia_core::market::curated_mcp(),
                query.as_deref().unwrap_or(""),
            ),
            &installed,
        ),
        registry: Vec::new(),
        fallback: None,
        search_cache: None,
    })
}

/// MCP 搜索（R7）：精选里匹配的 + 官方目录 v0.1（只收 active 与 npm / pypi / oci / 远程）。
/// 官方目录里与精选同名的不重复列。缓存与降级同 skill 搜索
#[tauri::command]
pub async fn market_search_mcp(
    query: String,
    cached_only: Option<bool>,
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
) -> Result<McpList, String> {
    let key = query_key(&query);
    let all_curated = sophia_core::market::curated_mcp();
    if key.is_empty() {
        return market_mcp_curated(None, state);
    }
    let curated_names: BTreeSet<String> = all_curated.iter().map(|e| e.name.clone()).collect();
    let curated = curated_matching(all_curated, &key);
    let t = now();
    let cached = market.with_cache(|c| c.mcp.get(&key).cloned());
    let mut cache_meta = McpSearchCache {
        updated_at: cached.as_ref().map(|c| c.at),
        refresh_needed: !cached.as_ref().is_some_and(|c| fresh(c.at, t, TTL_SECS)),
    };
    let (hits, fallback) = if cached_only.unwrap_or(false) {
        (cached.map(|c| c.items).unwrap_or_default(), None)
    } else {
        match cached {
            Some(c) if fresh(c.at, t, TTL_SECS) => (c.items, None),
            cached => match market.fetch_registry(query.trim()).await {
                Ok(hits) => {
                    let items = hits.clone();
                    market.update_cache(|c| remember(&mut c.mcp, key, t, items));
                    (hits, None)
                }
                Err(failure) => {
                    let fallback = Fallback::from_failure(
                        &sophia_core::t!("market.service.mcpDirectory"),
                        cached.as_ref().map(|c| c.at),
                        &failure,
                    );
                    (cached.map(|c| c.items).unwrap_or_default(), Some(fallback))
                }
            },
        }
    };
    if !cached_only.unwrap_or(false) {
        cache_meta = market.with_cache(|c| {
            let cached = c.mcp.get(&query_key(&query));
            McpSearchCache {
                updated_at: cached.map(|c| c.at),
                refresh_needed: !cached.is_some_and(|c| fresh(c.at, now(), TTL_SECS)),
            }
        });
    }
    let installed = mcp_installed(&state);
    Ok(McpList {
        curated: curated_rows(curated, &installed),
        registry: hits
            .into_iter()
            .filter(|h| !curated_names.contains(&h.entry.name))
            .map(|h| mcp_row(h.id, h.entry, h.repository, &installed))
            .collect(),
        fallback,
        search_cache: Some(cache_meta),
    })
}

// ── 介绍页 ──

fn repo_of(repo: &str) -> Result<String, String> {
    let r = link::parse(repo)?;
    Ok(r.slug())
}

/// 取 SKILL.md（R5B），只走 raw，不占 GitHub 接口次数。取不到返回 Err，界面写 `现在取不到说明`。
/// `branch` 为空取默认分支；`path` 为空（搜索结果）时按 `name`（skills.sh 的 `skillId` 或显示名）
/// 先猜常见布局，猜不中下整包找那个文件夹——下下来的包留给随后的安装用。结果带实际的分支与路径
#[tauri::command]
pub async fn market_skill_readme(
    repo: String,
    branch: Option<String>,
    path: Option<String>,
    name: Option<String>,
    market: tauri::State<'_, MarketState>,
) -> Result<SkillReadme, String> {
    let unavailable = |_| intro_unavailable();
    let repo = repo_of(&repo)?;
    let branch = market
        .branch_or_default(&repo, branch.as_deref())
        .await
        .map_err(unavailable)?;
    let found = |text: String, path: String| SkillReadme {
        text,
        page_url: link::tree_page_url(&repo, &branch, &path),
        branch: branch.clone(),
        path,
    };
    if let Some(path) = path.map(|p| p.trim_matches('/').to_string()) {
        let url = link::raw_skill_md_url(&repo, &branch, &path);
        return match market.raw_text(&url).await.map_err(unavailable)? {
            Some(text) => Ok(found(text, path)),
            None => Err(intro_unavailable()),
        };
    }
    let name = name.unwrap_or_default();
    let names: Vec<&str> = [name.trim()]
        .into_iter()
        .filter(|n| !n.is_empty())
        .collect();
    if names.is_empty() {
        return Err(intro_unavailable());
    }
    for guess in guess_paths(&names, &repo) {
        let url = link::raw_skill_md_url(&repo, &branch, &guess);
        if let Some(text) = market.raw_text(&url).await.map_err(unavailable)? {
            return Ok(found(text, guess));
        }
    }
    let bytes = market.download(&repo, &branch).await.map_err(unavailable)?;
    let dirs = archive::skill_dirs(&bytes).map_err(|_| intro_unavailable())?;
    let Some(dir) = match_skill_dir(&dirs, &names, &repo).cloned() else {
        return Err(intro_unavailable());
    };
    let url = link::raw_skill_md_url(&repo, &branch, &dir);
    match market.raw_text(&url).await.map_err(unavailable)? {
        Some(text) => Ok(found(text, dir)),
        None => Err(intro_unavailable()),
    }
}

/// MCP 介绍页的 README（08B）：精选取仓库 README，官方目录取 Registry 给的仓库（可带子目录）的 README。
/// 都走 raw，不占接口次数。`repository` 没有时看 `homepage`：是 GitHub 就用它，是 npm 包页就向
/// npm 要包的源码仓库。都取不到时 Err，界面只留 `连接方式`、`要填的` 两行
#[tauri::command]
pub async fn market_mcp_readme(
    repository: Option<String>,
    homepage: Option<String>,
    market: tauri::State<'_, MarketState>,
) -> Result<SkillReadme, String> {
    let mut repo_url = repository.filter(|r| is_github_url(r));
    if repo_url.is_none() {
        let homepage = homepage.unwrap_or_default();
        if is_github_url(&homepage) {
            repo_url = Some(homepage);
        } else if let Some(pkg) = npm_package(&homepage) {
            let url = format!("https://registry.npmjs.org/{pkg}/latest");
            if let Ok(body) = market.get_bytes(&url, false).await {
                repo_url = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|doc| npm_repository(&doc));
            }
        }
    }
    let Some(r) = repo_url.and_then(|u| link::parse(&u).ok()) else {
        return Err(intro_unavailable());
    };
    let repo = r.slug();
    let branch = market
        .branch_or_default(&repo, r.branch.as_deref())
        .await
        .map_err(|_| intro_unavailable())?;
    let mut dirs = Vec::new();
    if let Some(sub) = r.path.filter(|p| !p.is_empty()) {
        dirs.push(sub);
    }
    dirs.push(String::new());
    for dir in dirs {
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        for file in ["README.md", "readme.md", "Readme.md"] {
            let url = format!("https://raw.githubusercontent.com/{repo}/{branch}/{prefix}{file}");
            match market.raw_text(&url).await {
                Ok(Some(text)) => {
                    return Ok(SkillReadme {
                        text,
                        page_url: link::tree_page_url(&repo, &branch, &dir),
                        branch,
                        path: dir,
                    })
                }
                Ok(None) => continue,
                Err(_) => return Err(intro_unavailable()),
            }
        }
    }
    Err(intro_unavailable())
}

// ── 链接 ──

/// 解析粘贴的链接并列出里面的 skill（R6）。认不出时 Err 为 `link::unrecognized()`，不发请求。
/// 下载整包（留在内存里给随后的安装用），列出链接所指文件夹下的 skill；
/// 分支名带 `/` 时把路径前几段挪进分支再试
#[tauri::command]
pub async fn market_resolve_link(
    input: String,
    market: tauri::State<'_, MarketState>,
) -> Result<ResolvedLink, String> {
    let r = link::parse(&input)?;
    let repo = r.slug();
    let (branch, path, bytes) = match &r.branch {
        None => {
            let branch = market
                .default_branch(&repo)
                .await
                .map_err(|e| github_failure(&e))?;
            let bytes = market
                .download(&repo, &branch)
                .await
                .map_err(|e| github_failure(&e))?;
            (branch, r.path.clone(), bytes)
        }
        Some(first) => {
            let mut last: Option<NetFailure> = None;
            let mut hit = None;
            for (branch, path) in branch_candidates(first, r.path.as_deref()) {
                match market.download(&repo, &branch).await {
                    Ok(bytes) => {
                        hit = Some((branch, path, bytes));
                        break;
                    }
                    Err(f) if f.error == NetError::NotFound => continue,
                    Err(f) => {
                        last = Some(f);
                        break;
                    }
                }
            }
            hit.ok_or_else(|| match &last {
                Some(f) => github_failure(f),
                None => github_message(&NetError::NotFound),
            })?
        }
    };
    let dirs = archive::skill_dirs(&bytes)?;
    Ok(ResolvedLink {
        skills: skills_under(&dirs, path.as_deref(), &repo),
        download_url: link::codeload_url(&repo, &branch),
        size_bytes: Some(bytes.len() as u64),
        repo,
        branch,
    })
}

/// GitHub 这边失败的说法：没找到时说仓库或分支
fn github_message(e: &NetError) -> String {
    match e {
        NetError::NotFound => sophia_core::t!("market.github.notFound"),
        // 下的是整个仓库：说仓库大，不说 skill 大（选中的 skill 本身另限 50MB，解包时判）
        NetError::TooLarge => sophia_core::t!(
            "market.github.tooLarge",
            mb = MAX_DOWNLOAD_BYTES / (1024 * 1024)
        ),
        other => other.message("GitHub"),
    }
}

/// 下载 skill 时 GitHub 这边的一次失败 → 命令错误 `[类] 一句\n[detail] 原文`（issue #253）：网络那三类
/// （连不上、超时、限流）前端按类换成「下载 skill」场景的主句并给「开着代理再试一次」，别的（没找到、仓库太大）
/// 照这一句显示；原文进主句前的「!」
fn github_failure(failure: &NetFailure) -> String {
    crate::net_kind::NetProblem {
        kind: failure.kind(),
        detail: failure.detail.clone(),
    }
    .command_error(&github_message(failure))
}

// ── 装 ──

/// 补齐请求：分支为空取默认分支；下载（或取内存里的）整包；路径换成包里真有的 skill 文件夹
async fn prepare_skill_request(
    request: SkillInstallRequest,
    market: &MarketState,
) -> Result<(SkillInstallRequest, Arc<Vec<u8>>), String> {
    let repo = repo_of(&request.repo)?;
    let branch = market
        .branch_or_default(&repo, Some(&request.branch))
        .await
        .map_err(|e| github_failure(&e))?;
    let bytes = market
        .download(&repo, &branch)
        .await
        .map_err(|e| github_failure(&e))?;
    let dirs = archive::skill_dirs(&bytes)?;
    let paths = resolve_paths(&request.paths, &dirs, &repo);
    Ok((
        SkillInstallRequest {
            repo,
            branch,
            paths,
            ..request
        },
        bytes,
    ))
}

/// 安装页的计划（R9）：落点、同名拒绝、直接读取的 agent、下载地址与大小。
/// 分支可以为空（取默认分支）；路径可以只写 skill 名（搜索结果没有路径），按包里的文件夹补上
#[tauri::command]
pub async fn market_plan_skill_install(
    request: SkillInstallRequest,
    market: tauri::State<'_, MarketState>,
) -> Result<SkillInstallPreview, String> {
    let (request, bytes) = prepare_skill_request(request, &market).await?;
    let env = crate::runtime_env()?;
    let harnesses = discovery::installed(&env);
    let plan = install::plan(&env, &harnesses, &request)?;
    Ok(SkillInstallPreview {
        plan,
        download_url: link::codeload_url(&request.repo, &request.branch),
        size_bytes: Some(bytes.len() as u64),
        branch: request.branch,
    })
}

/// 装 skill（R9）：服务端按请求重新出计划再执行，结果带撤销 id（`market_undo`）
#[tauri::command]
pub async fn market_install_skill(
    request: SkillInstallRequest,
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
) -> Result<InstallOutcome, String> {
    let (request, bytes) = prepare_skill_request(request, &market).await?;
    let env = crate::runtime_env()?;
    let harnesses = discovery::installed(&env);
    let plan = install::plan(&env, &harnesses, &request)?;
    let commit = archive::commit_sha(&bytes).unwrap_or_default();
    // 通用仓库成为这个位置的来源：先过认领订阅那一步，改了才写回（读到写回拿着设置锁；之后不再 .await）
    let _settings_guard = state.store.lock_settings();
    let (sources, targets) = crate::discover(&state)?;
    let mut settings = crate::subscribed_settings(&state, &sources, &targets)?;
    let before = settings.subscriptions.clone();
    let mut outcome = install::execute(
        &plan,
        &bytes,
        &commit,
        &request.repo,
        &request.branch,
        now(),
        &mut settings.subscriptions,
        &state.store,
    );
    if settings.subscriptions != before {
        state
            .store
            .save_settings(&settings)
            .map_err(|e| e.to_string())?;
    }
    save_records(&state, &outcome.records)?;
    market.register_undo(&mut outcome);
    Ok(outcome)
}

fn save_records(state: &AppState, fresh_records: &[InstallRecord]) -> Result<(), String> {
    if fresh_records.is_empty() {
        return Ok(());
    }
    let mut records = state.store.load_installs().map_err(|e| e.to_string())?;
    for record in fresh_records {
        installs::upsert(&mut records, record.clone());
    }
    state
        .store
        .save_installs(&records)
        .map_err(|e| e.to_string())
}

/// 安装页「写进哪些 agent」每一行的检查（R10）。`request.values` 可以为空
#[tauri::command]
pub fn market_plan_mcp_install(
    request: McpInstallRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<McpTargetCheck>, String> {
    let env = crate::runtime_env()?;
    let harnesses = mcp_harnesses(&state, &env)?;
    Ok(sophia_core::mcp::check_targets(&env, &harnesses, &request))
}

/// 把给定的 MCP 定义写进勾选的 agent（R8 / R10）。撤销沿用 `mcp_undo_write`（结果里的 `undoId`）。
/// 会写 `~/.codex/config.toml`：先拿 `config_lock`
#[tauri::command]
pub async fn market_install_mcp(
    request: McpInstallRequest,
    state: tauri::State<'_, AppState>,
) -> Result<McpReport, String> {
    let env = crate::runtime_env()?;
    let harnesses = mcp_harnesses(&state, &env)?;
    let _config_guard = state.config_lock.lock().await;
    let mut report =
        sophia_core::mcp::write_definitions(&env, &harnesses, &request, &state.store.backups_dir());
    crate::register_mcp_undo(&state, &mut report)?;
    Ok(report)
}

// ── JSON ──

/// 解析粘贴的 MCP 配置（R8）。解析不了不是命令错误：结果里带 `error`
#[tauri::command]
pub fn market_parse_mcp_json(text: String) -> McpParseResult {
    sophia_core::mcp::parse_mcp_text(&text)
}

// ── 更新 ──

/// 上一次查更新的结果（内存里没有就读缓存文件）：本地文件夹已经不在的去掉，提示条按此刻已关掉的一批重算
fn previous_check(
    market: &MarketState,
    dismissed: &[String],
    last_check: Option<u64>,
    fallback: Option<Fallback>,
) -> UpdateCheck {
    let stored = guard(&market.last_check)
        .clone()
        .or_else(|| market.with_cache(|c| c.updates.clone()));
    let (mut updates, checked_at) = match stored {
        Some(check) => (check.updates, check.checked_at.or(last_check)),
        None => (Vec::new(), last_check),
    };
    updates.retain(|u| entry_kind(&u.dir) == EntryKind::Dir);
    UpdateCheck {
        strip_visible: installs::strip_visible(&updates, dismissed),
        updates,
        checked_at,
        fallback,
    }
}

/// 记下这次查更新的结果（内存 + 缓存文件）
fn keep_check(market: &MarketState, check: &UpdateCheck) {
    let stored = UpdateCheck {
        fallback: None,
        ..check.clone()
    };
    *guard(&market.last_check) = Some(stored.clone());
    market.update_cache(|c| c.updates = Some(stored));
}

/// 什么时候该联网查（R14）：`立即检查` 总是查；打开 SKILLS 页只在自动检查开着、距上次超过 6 小时时查
fn due(force: bool, auto_check: bool, last: Option<u64>, t: u64) -> bool {
    force || (auto_check && !last.is_some_and(|at| fresh(at, t, TTL_SECS)))
}

/// 查更新（R14）。`force` 为假时（打开 SKILLS 页）只在自动检查开着、距上次超过 6 小时才联网，
/// 否则原样返回上一次的结果；`立即检查` 传真。按仓库合并，一个仓库一次 trees 请求；
/// 本地改过的再取一次记下那一版的 tree，列出改过的文件。
/// 被限流：`立即检查` 报 `GitHub 暂时限流，稍后再试`；自动的返回上一次的结果 + `fallback.rateLimited`。
/// 连不上：返回上一次的结果 + `fallback`。这两种都不记检查时刻，也不自动重试
#[tauri::command]
pub async fn market_check_updates(
    force: bool,
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
) -> Result<UpdateCheck, String> {
    let settings = state.store.load_settings().map_err(|e| e.to_string())?;
    let dismissed = settings.dismissed_update_shas.clone();
    let last = settings.last_skill_update_check;
    let t = now();
    let failed = |e: &NetFailure| -> Result<UpdateCheck, String> {
        if matches!(e.error, NetError::RateLimited { .. }) && force {
            return Err(rate_limited_text());
        }
        let fallback = Fallback::from_failure("GitHub", last, e);
        Ok(previous_check(&market, &dismissed, last, Some(fallback)))
    };
    if !due(force, settings.auto_check_skill_updates, last, t) {
        return Ok(previous_check(&market, &dismissed, last, None));
    }
    if market.github_blocked(t) {
        return failed(&blocked_failure("https://api.github.com/"));
    }

    let env = crate::runtime_env()?;
    let records = state.store.load_installs().map_err(|e| e.to_string())?;
    let lock_entries = lock::read(&lock_path_of(&env));
    let candidates = installs::candidates(&records, &lock_entries, &env.home);
    let mut remote = installs::RemoteTrees::new();
    for (repo, branch) in installs::repos_to_query(&candidates) {
        let actual = match market.branch_or_default(&repo, branch.as_deref()).await {
            Ok(b) => b,
            // 仓库没了、改成私有了：这一个不算有更新，别的照查
            Err(f) if f.error == NetError::NotFound => continue,
            Err(e) => return failed(&e),
        };
        match market.fetch_tree(&repo, &actual).await {
            Ok(tree) => {
                remote.insert(
                    (repo, branch),
                    installs::RemoteTree {
                        branch: actual,
                        folders: tree.folders,
                    },
                );
            }
            Err(f) if f.error == NetError::NotFound => continue,
            Err(e) => return failed(&e),
        }
    }
    let mut updates = installs::compare(&candidates, &remote);
    for update in updates.iter_mut().filter(|u| u.locally_modified) {
        // 改过的文件清单是锦上添花：取不到（含限流）就不列，更新前的确认照样会出
        if market.github_blocked(now()) {
            break;
        }
        if let Ok(tree) = market
            .fetch_tree(&update.repo, &update.recorded_tree_sha)
            .await
        {
            installs::fill_changed_files(update, &tree.blobs);
        }
    }
    state
        .store
        .record_skill_update_check(t)
        .map_err(|e| e.to_string())?;
    let check = UpdateCheck {
        strip_visible: installs::strip_visible(&updates, &dismissed),
        updates,
        checked_at: Some(t),
        fallback: None,
    };
    keep_check(&market, &check);
    Ok(check)
}

/// 更新这些 skill（R15）。有本地改过的，只有 `overwrite_modified` 为真（用户在确认里点了更新）才覆盖。
/// 按上一次查更新的结果认；一个仓库下载一次。更新成的从「有更新」里去掉
#[tauri::command]
pub async fn market_update_skills(
    targets: Vec<UpdateTarget>,
    overwrite_modified: bool,
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
) -> Result<InstallOutcome, String> {
    let settings = state.store.load_settings().map_err(|e| e.to_string())?;
    let previous = previous_check(
        &market,
        &settings.dismissed_update_shas,
        settings.last_skill_update_check,
        None,
    );
    let mut failed = BTreeMap::new();
    let mut chosen: Vec<UpdateInfo> = Vec::new();
    for target in &targets {
        match previous
            .updates
            .iter()
            .find(|u| u.location == target.location && u.name == target.name)
        {
            Some(u) => chosen.push(u.clone()),
            None => {
                failed.insert(
                    target.name.clone(),
                    sophia_core::t!("market.update.noNewInfo"),
                );
            }
        }
    }
    let mut archives = BTreeMap::new();
    let mut ready = Vec::new();
    for update in chosen {
        if let std::collections::btree_map::Entry::Vacant(slot) =
            archives.entry((update.repo.clone(), update.branch.clone()))
        {
            match market.download(&update.repo, &update.branch).await {
                Ok(bytes) => {
                    slot.insert(bytes.as_ref().clone());
                }
                Err(e) => {
                    failed.insert(update.name.clone(), github_message(&e));
                    continue;
                }
            }
        }
        ready.push(update);
    }
    let records = state.store.load_installs().map_err(|e| e.to_string())?;
    let hold_root = crate::held_dir()?;
    let mut outcome = install::execute_update(
        &ready,
        &records,
        &archives,
        overwrite_modified,
        &hold_root,
        now(),
    );
    outcome.failed.extend(failed);
    save_records(&state, &outcome.records)?;
    market.register_undo(&mut outcome);
    // 更新成的不再算「有更新」
    let done: BTreeSet<(String, String)> = ready
        .iter()
        .filter(|u| outcome.installed.contains(&u.name))
        .map(|u| (u.location.clone(), u.name.clone()))
        .collect();
    if !done.is_empty() {
        let mut check = previous;
        let removed: Vec<UpdateInfo> = check
            .updates
            .iter()
            .filter(|u| done.contains(&(u.location.clone(), u.name.clone())))
            .cloned()
            .collect();
        if let Some(id) = &outcome.undo_id {
            let mut kept = guard(&market.update_removed);
            if kept.len() >= UNDO_LIMIT {
                kept.remove(0);
            }
            kept.push((id.clone(), removed));
        }
        check
            .updates
            .retain(|u| !done.contains(&(u.location.clone(), u.name.clone())));
        check.strip_visible =
            installs::strip_visible(&check.updates, &settings.dismissed_update_shas);
        keep_check(&market, &check);
    }
    Ok(outcome)
}

/// 撤销一次装或更新（R11 / R15）：id 用过即删；过期时报错
#[tauri::command]
pub fn market_undo(
    undo_id: String,
    state: tauri::State<'_, AppState>,
    market: tauri::State<'_, MarketState>,
) -> Result<SyncReport, String> {
    let undo = {
        let mut records = guard(&market.undo);
        let at = records
            .iter()
            .position(|(id, _)| id == &undo_id)
            .ok_or_else(|| sophia_core::t!("market.undo.expired"))?;
        records.remove(at).1
    };
    let hold_root = crate::held_dir()?;
    let mut records = state.store.load_installs().map_err(|e| e.to_string())?;
    let report = install::undo(&undo, &hold_root, &mut records, Some(&state.store));
    state
        .store
        .save_installs(&records)
        .map_err(|e| e.to_string())?;
    // 撤销的是一次更新：旧版回来了，那几条「有更新」也放回存下的查更新结果
    let restored = {
        let mut kept = guard(&market.update_removed);
        kept.iter()
            .position(|(id, _)| id == &undo_id)
            .map(|at| kept.remove(at).1)
    };
    if let Some(restored) = restored.filter(|r| !r.is_empty()) {
        let settings = state.store.load_settings().map_err(|e| e.to_string())?;
        let mut check = previous_check(
            &market,
            &settings.dismissed_update_shas,
            settings.last_skill_update_check,
            None,
        );
        for u in restored {
            if !check
                .updates
                .iter()
                .any(|x| x.location == u.location && x.name == u.name)
            {
                check.updates.push(u);
            }
        }
        check.strip_visible =
            installs::strip_visible(&check.updates, &settings.dismissed_update_shas);
        keep_check(&market, &check);
    }
    Ok(report)
}

/// 提示条按 ×（R15）：记下此刻这一批新版本的 tree SHA（各 `UpdateInfo.remoteTreeSha`）
#[tauri::command]
pub fn market_dismiss_updates(
    tree_shas: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .set_dismissed_update_shas(tree_shas)
        .map_err(|e| e.to_string())
}

/// 设置 `skill 更新` 一节（R14）
#[tauri::command]
pub fn skill_update_settings(
    state: tauri::State<'_, AppState>,
) -> Result<SkillUpdateSettings, String> {
    let settings = state.store.load_settings().map_err(|e| e.to_string())?;
    Ok(SkillUpdateSettings {
        auto_check: settings.auto_check_skill_updates,
        last_check: settings.last_skill_update_check,
    })
}

/// `自动检查 skill 更新` 开关（R14）
#[tauri::command]
pub fn set_auto_check_skill_updates(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .store
        .set_auto_check_skill_updates(enabled)
        .map_err(crate::cmd_error::settings_unsaved)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 限流与缓存新鲜度 ──

    #[test]
    fn rate_limit_needs_the_header_on_403() {
        let limited = |reset, wait_secs| Err(NetError::RateLimited { reset, wait_secs });
        assert_eq!(classify(200, None, None, None, None, 0), Ok(()));
        assert_eq!(classify(204, Some("0"), None, None, None, 0), Ok(()));
        assert_eq!(
            classify(
                403,
                Some("0"),
                None,
                None,
                Some(1_800_000_000),
                1_799_999_000
            ),
            limited(Some(1_800_000_000), Some(1000))
        );
        // 次级限流：403 + retry-after
        assert_eq!(
            classify(403, Some("12"), Some("30"), None, None, 0),
            limited(None, Some(30))
        );
        assert_eq!(
            classify(429, None, None, None, None, 0),
            limited(None, None)
        );
        // 单纯 403 是没权限，不能当限流
        assert_eq!(
            classify(403, None, None, None, None, 0),
            Err(NetError::Status(403))
        );
        assert_eq!(
            classify(403, Some("59"), None, None, None, 0),
            Err(NetError::Status(403))
        );
        assert_eq!(
            classify(404, None, None, None, None, 0),
            Err(NetError::NotFound)
        );
        assert_eq!(
            classify(401, None, None, None, None, 0),
            Err(NetError::NotFound)
        );
        assert_eq!(
            classify(500, None, None, None, None, 0),
            Err(NetError::Status(500))
        );
    }

    #[test]
    fn rate_limit_message_is_exact() {
        let e = NetError::RateLimited {
            reset: None,
            wait_secs: None,
        };
        assert_eq!(e.message("GitHub"), "GitHub 暂时限流，稍后再试");
        assert_eq!(
            github_message(&NetError::TooLarge),
            "仓库超过 200MB，下载不下来"
        );
        assert_eq!(
            NetError::TooLarge.message("skills.sh"),
            "skills.sh 返回的内容太大"
        );
        assert_eq!(github_message(&e), "GitHub 暂时限流，稍后再试");
        assert_eq!(NetError::Network.message("skills.sh"), "无法连接 skills.sh");
    }

    #[test]
    fn cache_freshness() {
        let ttl = TTL_SECS;
        assert!(fresh(1000, 1000, ttl));
        assert!(fresh(1000, 1000 + ttl - 1, ttl));
        assert!(!fresh(1000, 1000 + ttl, ttl));
        // 时刻在将来（改过系统时间）：重新取
        assert!(!fresh(2000, 1000, ttl));
    }

    #[test]
    fn check_is_due() {
        let t = 100_000;
        assert!(due(true, false, Some(t), t), "立即检查总是查");
        assert!(!due(false, false, None, t), "自动检查关着不查");
        assert!(due(false, true, None, t), "从没查过");
        assert!(!due(false, true, Some(t - 60), t), "不到 6 小时");
        assert!(due(false, true, Some(t - TTL_SECS), t), "满 6 小时");
    }

    #[test]
    fn remembered_queries_are_capped_oldest_first() {
        let mut map: BTreeMap<String, Cached<Vec<u8>>> = BTreeMap::new();
        for i in 0..(CACHE_QUERIES as u64 + 3) {
            remember(&mut map, format!("q{i}"), 100 + i, vec![]);
        }
        assert_eq!(map.len(), CACHE_QUERIES);
        assert!(!map.contains_key("q0") && !map.contains_key("q2"));
        assert!(map.contains_key("q3"));
        // 同一个词再记一次：替换，不多占
        remember(&mut map, "q3".into(), 999, vec![1]);
        assert_eq!(map.len(), CACHE_QUERIES);
        assert_eq!(map["q3"].items, vec![1]);
    }

    #[test]
    fn disk_cache_round_trips_and_tolerates_old_files() {
        let mut cache = DiskCache::default();
        remember(
            &mut cache.skills,
            "pdf".into(),
            42,
            parse_skill_search(SEARCH).unwrap(),
        );
        let bytes = serde_json::to_vec(&cache).unwrap();
        let back: DiskCache = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.skills["pdf"], cache.skills["pdf"]);
        // 缺字段的旧文件照样读
        let empty: DiskCache = serde_json::from_str("{}").unwrap();
        assert!(empty.skills.is_empty() && empty.updates.is_none());
    }

    #[test]
    fn query_keys_ignore_case_and_spaces() {
        assert_eq!(query_key("  PDF "), "pdf");
    }

    // ── skills.sh ──

    const SEARCH: &[u8] = br#"{
      "query": "pdf", "searchType": "fuzzy",
      "skills": [
        {"id":"anthropics/skills/pdf","source":"anthropics/skills","skillId":"pdf","name":"pdf","installs":201532},
        {"id":"google-labs-code/stitch-skills/reactcomponents","source":"google-labs-code/stitch-skills","skillId":"reactcomponents","name":"react:components","installs":50719.0},
        {"id":"x/y/z","source":"https://example.com/x","skillId":"z","name":"z","installs":1},
        {"id":"a/b/c","source":"a/b","skillId":"only-id"},
        {"id":"a/b/d","source":"a/b","name":"","skillId":""}
      ],
      "count": 5
    }"#;

    #[test]
    fn search_json_becomes_listings() {
        let hits = parse_skill_search(SEARCH).unwrap();
        let summary: Vec<_> = hits
            .iter()
            .map(|h| {
                (
                    h.listing.name.as_str(),
                    h.listing.repo.as_str(),
                    h.listing.installs,
                    h.skill_id.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("pdf", "anthropics/skills", 201532, Some("pdf")),
                (
                    "react:components",
                    "google-labs-code/stitch-skills",
                    50719,
                    Some("reactcomponents")
                ),
                // 没有显示名用 skillId；没有 installs 记 0
                ("only-id", "a/b", 0, Some("only-id")),
            ]
        );
        assert!(hits.iter().all(|h| h.listing.path.is_none()));
        assert!(
            parse_skill_search(br#"{"error":"Query must be at least 2 characters"}"#).is_none()
        );
        assert!(parse_skill_search(b"<html>").is_none());
    }

    #[test]
    fn snapshot_fallback_filters_by_query() {
        let snapshot = vec![
            SkillListing {
                name: "pdf".into(),
                repo: "anthropics/skills".into(),
                path: Some("skills/pdf".into()),
                installs: 3,
            },
            SkillListing {
                name: "docx".into(),
                repo: "anthropics/skills".into(),
                path: Some("skills/docx".into()),
                installs: 2,
            },
        ];
        let hits = snapshot_matching(snapshot.clone(), "PD");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].listing.name, "pdf");
        assert_eq!(snapshot_matching(snapshot.clone(), "anthropics").len(), 2);
        assert_eq!(snapshot_matching(snapshot, "").len(), 2);
    }

    // ── 装在了哪 ──

    #[test]
    fn installed_in_uses_records_lock_and_store_names() {
        let record = InstallRecord {
            name: "pdf".into(),
            location: "project:/p".into(),
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            path: "skills/pdf".into(),
            tree_sha: "t".into(),
            content_sha: None,
            commit_sha: "c".into(),
            installed_at: 1,
        };
        let lock_entry = LockEntry {
            name: "reactcomponents".into(),
            repo: "google-labs-code/stitch-skills".into(),
            path: "skills/react-components".into(),
            folder_hash: "f".into(),
            git_ref: None,
        };
        let installed = Installed {
            records: vec![record],
            lock: vec![lock_entry],
            stores: vec![
                (GLOBAL.into(), ["pdf".to_string()].into_iter().collect()),
                (
                    "project:/q".into(),
                    ["other".to_string()].into_iter().collect(),
                ),
            ],
        };
        // 仓库 + 路径认记录；通用仓库里有同名的也算
        assert_eq!(
            installed.locations("Anthropics/Skills", Some("/skills/pdf/"), &["pdf"]),
            ["project:/p", "global"]
        );
        // 没有路径（搜索结果）：仓库 + skillId 认 lock
        assert_eq!(
            installed.locations(
                "google-labs-code/stitch-skills",
                None,
                &["react:components", "reactcomponents"]
            ),
            ["global"]
        );
        assert!(installed.locations("x/y", None, &["nothing"]).is_empty());

        let rows = skill_rows(
            vec![SkillHit {
                listing: SkillListing {
                    name: "pdf".into(),
                    repo: "anthropics/skills".into(),
                    path: None,
                    installs: 1,
                },
                skill_id: Some("pdf".into()),
            }],
            &installed,
        );
        assert_eq!(rows[0].installed_in, ["project:/p", "global"]);
        let v = serde_json::to_value(&rows[0]).unwrap();
        assert!(v.get("skillId").is_some() && v.get("installedIn").is_some());
        assert_eq!(v["repo"], "anthropics/skills");
    }

    // ── GitHub ──

    #[test]
    fn symref_gives_the_default_branch() {
        let head = b"001e# service=git-upload-pack\n0000015933375500bcea98d610eb30ce10ac4e59b89c390d HEAD\0multi_ack thin-pack side-band symref=HEAD:refs/heads/main filter object-format=sha1 agent=git/github\n005cb334 refs/heads/x\n";
        assert_eq!(parse_symref(head).as_deref(), Some("main"));
        let slashed = b"... HEAD\0multi_ack symref=HEAD:refs/heads/release/v2 agent=git\n";
        assert_eq!(parse_symref(slashed).as_deref(), Some("release/v2"));
        // 只读到一半：还不知道分支名完了没有
        assert_eq!(parse_symref(b"... symref=HEAD:refs/heads/ma"), None);
        assert_eq!(parse_symref(b"001e# service=git-upload-pack\n0000"), None);
    }

    #[test]
    fn trees_json_becomes_folders_and_blobs() {
        let body = br#"{
          "sha": "ROOTSHA",
          "tree": [
            {"path": "skills", "type": "tree", "sha": "a1"},
            {"path": "skills/pdf", "type": "tree", "sha": "B2"},
            {"path": "skills/pdf/SKILL.md", "type": "blob", "sha": "c3"},
            {"path": "vendor/sub", "type": "commit", "sha": "d4"}
          ],
          "truncated": false
        }"#;
        let tree = parse_tree(body).unwrap();
        assert_eq!(tree.folders[""], "rootsha");
        assert_eq!(tree.folders["skills/pdf"], "b2");
        assert_eq!(tree.blobs["skills/pdf/SKILL.md"], "c3");
        assert!(!tree.folders.contains_key("vendor/sub") && !tree.blobs.contains_key("vendor/sub"));
        assert!(parse_tree(br#"{"message":"Not Found"}"#).is_none());
    }

    fn dirs() -> Vec<String> {
        [
            "",
            "skills/pdf",
            "skills/react-components",
            "skills/skill-creator",
            "templates/pdf-lite",
        ]
        .map(String::from)
        .to_vec()
    }

    #[test]
    fn skill_dirs_match_by_name() {
        let dirs = dirs();
        assert_eq!(
            match_skill_dir(&dirs, &["pdf"], "anthropics/skills").map(String::as_str),
            Some("skills/pdf")
        );
        // skills.sh 的 skillId 与文件夹名只差标点
        assert_eq!(
            match_skill_dir(&dirs, &["react:components", "reactcomponents"], "o/r")
                .map(String::as_str),
            Some("skills/react-components")
        );
        // 仓库根的 skill 名字是仓库名
        assert_eq!(
            match_skill_dir(&dirs, &["my-skill"], "someone/my-skill").map(String::as_str),
            Some("")
        );
        assert_eq!(match_skill_dir(&dirs, &["nope"], "o/r"), None);
    }

    #[test]
    fn request_paths_resolve_against_the_archive() {
        let dirs = dirs();
        assert_eq!(
            resolve_paths(
                &[
                    "skills/pdf".into(),
                    "skill-creator".into(),
                    "/missing/".into()
                ],
                &dirs,
                "anthropics/skills"
            ),
            ["skills/pdf", "skills/skill-creator", "missing"]
        );
    }

    #[test]
    fn link_lists_skills_under_its_folder() {
        let dirs = dirs();
        let names = |v: Vec<RepoSkill>| v.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(
            names(skills_under(&dirs, None, "anthropics/skills")),
            [
                "skills",
                "pdf",
                "react-components",
                "skill-creator",
                "pdf-lite"
            ]
        );
        assert_eq!(
            names(skills_under(&dirs, Some("skills"), "o/r")),
            ["pdf", "react-components", "skill-creator"]
        );
        let one = skills_under(&dirs, Some("skills/pdf"), "o/r");
        assert_eq!(
            one,
            [RepoSkill {
                name: "pdf".into(),
                path: "skills/pdf".into()
            }]
        );
        // 按路径段比，不是字符串前缀：`skills/pd` 不算 `skills/pdf` 的上级
        assert!(skills_under(&dirs, Some("skills/pd"), "o/r").is_empty());
    }

    #[test]
    fn slashed_branches_are_retried() {
        assert_eq!(
            branch_candidates("feature", Some("x/skills/pdf")),
            [
                ("feature".to_string(), Some("x/skills/pdf".to_string())),
                ("feature/x".to_string(), Some("skills/pdf".to_string())),
                ("feature/x/skills".to_string(), Some("pdf".to_string())),
                ("feature/x/skills/pdf".to_string(), None),
            ]
        );
        assert_eq!(
            branch_candidates("main", None),
            [("main".to_string(), None)]
        );
        // 最多挪 3 段
        assert_eq!(branch_candidates("a", Some("b/c/d/e/f")).len(), 4);
    }

    #[test]
    fn guesses_common_layouts_before_downloading() {
        assert_eq!(
            guess_paths(&["pdf"], "anthropics/skills"),
            ["skills/pdf", "pdf", ".claude/skills/pdf"]
        );
        // 不能当文件夹名的不猜；名字与仓库名对得上才猜仓库根
        assert_eq!(
            guess_paths(&["react:components"], "o/r"),
            Vec::<String>::new()
        );
        assert_eq!(
            guess_paths(&["darwin-skill"], "alchaincyf/darwin-skill").last(),
            Some(&String::new())
        );
    }

    // ── MCP Registry ──

    const REGISTRY: &[u8] = br#"{
      "servers": [
        {
          "server": {
            "name": "ai.smithery/brave",
            "description": "Search the web",
            "repository": {"url": "https://github.com/brave/brave-search-mcp-server", "source": "github"},
            "version": "2.0.58",
            "remotes": [{
              "type": "streamable-http",
              "url": "https://server.smithery.ai/brave/mcp",
              "headers": [{"name": "Authorization", "value": "Bearer {smithery_api_key}", "description": "Bearer token", "isSecret": true}]
            }]
          },
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active", "isLatest": true}}
        },
        {
          "server": {
            "name": "io.github.brave/brave-search-mcp-server",
            "description": "Brave Search MCP Server",
            "repository": {"url": "https://github.com/brave/brave-search-mcp-server", "source": "github", "subfolder": "packages/server"},
            "version": "2.1.3",
            "packages": [
              {"registryType": "mcpb", "identifier": "https://x/y.mcpb", "transport": {"type": "stdio"}},
              {"registryType": "npm", "identifier": "@brave/brave-search-mcp-server", "version": "2.1.3",
               "transport": {"type": "stdio"}, "runtimeArguments": [{"type": "positional", "value": "-y"}],
               "environmentVariables": [
                 {"name": "BRAVE_API_KEY", "description": "Your API key", "isRequired": true, "isSecret": true},
                 {"name": "BRAVE_MODE", "description": "Mode", "default": "web"}
               ]}
            ],
            "remotes": [{"type": "sse", "url": "https://brave.example/sse"}]
          },
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}
        },
        {
          "server": {"name": "io.github.old/gone", "description": "x",
            "packages": [{"registryType": "npm", "identifier": "gone", "transport": {"type": "stdio"}}]},
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "deprecated"}}
        },
        {
          "server": {"name": "io.github.rusty/crate-only", "description": "x",
            "packages": [{"registryType": "cargo", "identifier": "crate-only", "transport": {"type": "stdio"}}]},
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}
        },
        {
          "server": {"name": "com.example/mcp", "description": "Python one", "websiteUrl": "https://example.com",
            "packages": [{"registryType": "pypi", "identifier": "example-mcp", "transport": {"type": "stdio"},
              "packageArguments": [
                {"type": "positional", "valueHint": "root_dir", "isRequired": true},
                {"type": "named", "name": "--port", "value": "8080"},
                {"type": "named", "name": "--verbose"}
              ]}]},
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}
        },
        {
          "server": {"name": "io.github.acme/dockerized", "description": "Container",
            "packages": [{"registryType": "oci", "identifier": "docker.io/acme/mcp:1.0", "transport": {"type": "stdio"},
              "environmentVariables": [{"name": "ACME_TOKEN", "isRequired": true, "isSecret": true}]}]},
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}
        },
        {
          "server": {"name": "io.github.acme/tenant", "description": "Remote with url var",
            "remotes": [{"type": "streamable-http", "url": "https://{tenant}.acme.dev/mcp",
              "variables": {"tenant": {"description": "Your tenant", "isRequired": true}}}]},
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}
        },
        {
          "server": {"name": "io.github.acme/local-http", "description": "http package only",
            "packages": [{"registryType": "npm", "identifier": "local-http", "transport": {"type": "streamable-http", "url": "http://localhost:3000"}}]},
          "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}
        }
      ],
      "metadata": {"count": 8}
    }"#;

    fn by_id(hits: &[RegistryHit], id: &str) -> RegistryHit {
        hits.iter()
            .find(|h| h.id == id)
            .unwrap_or_else(|| panic!("缺 {id}"))
            .clone()
    }

    #[test]
    fn registry_keeps_active_and_supported_only() {
        let hits = parse_registry(REGISTRY).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "ai.smithery/brave",
                "io.github.brave/brave-search-mcp-server",
                "com.example/mcp",
                "io.github.acme/dockerized",
                "io.github.acme/tenant",
            ]
        );
        assert!(hits.iter().all(|h| h.entry.source == "registry"));
        assert!(parse_registry(b"{}").is_none());
    }

    #[test]
    fn registry_remote_headers_become_placeholders() {
        let hit = by_id(&parse_registry(REGISTRY).unwrap(), "ai.smithery/brave");
        let e = &hit.entry;
        assert_eq!(e.name, "brave");
        assert_eq!(e.publisher, "smithery.ai");
        assert_eq!(e.definition.transport, McpTransport::Http);
        assert_eq!(
            e.definition.url.as_deref(),
            Some("https://server.smithery.ai/brave/mcp")
        );
        assert_eq!(
            e.definition.headers["Authorization"],
            "Bearer ${smithery_api_key}"
        );
        // 嵌在固定文字里的变量一律必填；密钥照 Registry
        assert_eq!(
            e.fields,
            [McpFieldSpec {
                key: "smithery_api_key".into(),
                kind: McpFieldKind::Header,
                required: true,
                secret: true,
                description: Some("Bearer token".into()),
            }]
        );
        assert_eq!(
            hit.repository.as_deref(),
            Some("https://github.com/brave/brave-search-mcp-server")
        );
    }

    #[test]
    fn registry_npm_package_wins_over_remote() {
        let hit = by_id(
            &parse_registry(REGISTRY).unwrap(),
            "io.github.brave/brave-search-mcp-server",
        );
        let e = &hit.entry;
        assert_eq!(e.name, "brave-search-mcp-server");
        assert_eq!(e.publisher, "brave");
        let d = &e.definition;
        assert_eq!(d.transport, McpTransport::Stdio);
        assert_eq!(d.command.as_deref(), Some("npx"));
        assert_eq!(d.args, ["-y", "@brave/brave-search-mcp-server"]);
        assert_eq!(d.env["BRAVE_API_KEY"], "${BRAVE_API_KEY}");
        assert_eq!(d.env["BRAVE_MODE"], "${BRAVE_MODE}");
        let summary: Vec<_> = e
            .fields
            .iter()
            .map(|f| (f.key.as_str(), f.kind, f.required, f.secret))
            .collect();
        assert_eq!(
            summary,
            [
                ("BRAVE_API_KEY", McpFieldKind::Env, true, true),
                ("BRAVE_MODE", McpFieldKind::Env, false, false),
            ]
        );
        assert_eq!(
            hit.repository.as_deref(),
            Some("https://github.com/brave/brave-search-mcp-server/tree/HEAD/packages/server")
        );
        assert_eq!(
            e.homepage.as_deref(),
            Some("https://github.com/brave/brave-search-mcp-server")
        );
        // 每个要填的项在定义里都有占位（与随包精选同一条约束）
        let text = serde_json::to_string(&e.definition).unwrap();
        for f in &e.fields {
            assert!(text.contains(&format!("${{{}}}", f.key)), "{}", f.key);
        }
    }

    #[test]
    fn registry_pypi_oci_and_url_variables() {
        let hits = parse_registry(REGISTRY).unwrap();

        let py = by_id(&hits, "com.example/mcp").entry;
        // 太泛的名字前面加发布方
        assert_eq!(py.name, "example-com-mcp");
        assert_eq!(py.publisher, "example.com");
        assert_eq!(py.definition.command.as_deref(), Some("uvx"));
        assert_eq!(
            py.definition.args,
            ["example-mcp", "${ROOT_DIR}", "--port", "8080"]
        );
        assert_eq!(py.homepage.as_deref(), Some("https://example.com"));
        assert_eq!(py.fields.len(), 1);
        assert_eq!(py.fields[0].key, "ROOT_DIR");
        assert_eq!(py.fields[0].kind, McpFieldKind::Arg);

        let oci = by_id(&hits, "io.github.acme/dockerized").entry;
        assert_eq!(oci.definition.command.as_deref(), Some("docker"));
        assert_eq!(
            oci.definition.args,
            [
                "run",
                "-i",
                "--rm",
                "-e",
                "ACME_TOKEN",
                "docker.io/acme/mcp:1.0"
            ]
        );
        assert_eq!(oci.definition.env["ACME_TOKEN"], "${ACME_TOKEN}");
        assert!(oci.fields[0].secret && oci.fields[0].required);

        let tenant = by_id(&hits, "io.github.acme/tenant").entry;
        assert_eq!(
            tenant.definition.url.as_deref(),
            Some("https://${tenant}.acme.dev/mcp")
        );
        assert_eq!(tenant.fields[0].key, "tenant");
        assert_eq!(tenant.fields[0].description.as_deref(), Some("Your tenant"));
    }

    #[test]
    fn templates_convert_to_placeholders() {
        assert_eq!(
            convert_template("Bearer {api_key}"),
            ("Bearer ${api_key}".to_string(), vec!["api_key".to_string()])
        );
        assert_eq!(
            convert_template("${ALREADY} and {a}{b}{a}"),
            (
                "${ALREADY} and ${a}${b}${a}".to_string(),
                vec!["ALREADY".to_string(), "a".to_string(), "b".to_string()]
            )
        );
        // 不像变量名的花括号原样留着
        assert_eq!(
            convert_template(r#"{"json": 1} {}"#),
            (r#"{"json": 1} {}"#.to_string(), vec![])
        );
    }

    #[test]
    fn publishers_and_names() {
        assert_eq!(publisher_of("io.github.brave/x"), "brave");
        assert_eq!(publisher_of("ai.smithery/x"), "smithery.ai");
        assert_eq!(publisher_of("com.example.api/x"), "api.example.com");
        assert_eq!(server_name("io.github.brave/brave-search"), "brave-search");
        assert_eq!(server_name("io.github.acme/server"), "acme-server");
    }

    #[test]
    fn curated_matching_looks_at_name_publisher_description() {
        let curated = sophia_core::market::curated_mcp();
        assert_eq!(curated_matching(curated.clone(), "").len(), curated.len());
        let first = &curated[0];
        let hits = curated_matching(curated.clone(), &first.name.to_uppercase());
        assert!(hits.iter().any(|e| e.name == first.name));
        assert!(curated_matching(curated, "zzzz-no-such-thing").is_empty());
    }

    // ── README 的来处 ──

    #[test]
    fn npm_repository_urls_become_github_urls() {
        let doc = |v: Value| serde_json::json!({ "repository": v });
        assert_eq!(
            npm_repository(&doc(serde_json::json!({
                "type": "git",
                "url": "git+https://github.com/modelcontextprotocol/servers.git",
                "directory": "src/filesystem"
            }))),
            Some("https://github.com/modelcontextprotocol/servers/tree/HEAD/src/filesystem".into())
        );
        assert_eq!(
            npm_repository(&doc(serde_json::json!(
                "github:brave/brave-search-mcp-server"
            ))),
            Some("https://github.com/brave/brave-search-mcp-server".into())
        );
        assert_eq!(
            npm_repository(&doc(serde_json::json!({"url": "git@github.com:o/r.git"}))),
            Some("https://github.com/o/r".into())
        );
        assert_eq!(
            npm_repository(&doc(serde_json::json!({"url": "https://gitlab.com/o/r"}))),
            None
        );
        assert_eq!(npm_repository(&serde_json::json!({})), None);
    }

    #[test]
    fn npm_package_names_from_pages() {
        assert_eq!(
            npm_package("https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem"),
            Some("@modelcontextprotocol/server-filesystem")
        );
        assert_eq!(
            npm_package("https://www.npmjs.com/package/foo/?x=1"),
            Some("foo")
        );
        assert_eq!(npm_package("https://github.com/o/r"), None);
        assert!(is_github_url("https://github.com/o/r"));
        assert!(!is_github_url("https://example.com/o/r"));
    }

    // ── 实网冒烟（手动跑：`cargo test -p sophia --lib market::tests::live_smoke -- --ignored --nocapture`）──
    // 只打 skills.sh、MCP 目录与 github.com 的 git 地址（不占 api.github.com 的次数）

    #[test]
    #[ignore]
    fn live_smoke() {
        let market = MarketState::default();
        tauri::async_runtime::block_on(async {
            let skills = market.fetch_skills("pdf").await.expect("skills.sh");
            println!("skills.sh pdf → {} 条", skills.len());
            for h in skills.iter().take(5) {
                println!(
                    "  {} · {} · {} · skillId={:?}",
                    h.listing.name, h.listing.repo, h.listing.installs, h.skill_id
                );
            }
            assert!(!skills.is_empty());

            for q in ["github", "brave", "filesystem"] {
                let hits = market.fetch_registry(q).await.expect("registry");
                println!("registry {q} → {} 条（过滤后）", hits.len());
                for h in hits.iter().take(4) {
                    let d = &h.entry.definition;
                    println!(
                        "  {} [{}] {:?} cmd={:?} args={:?} url={:?} fields={:?}",
                        h.entry.name,
                        h.entry.publisher,
                        d.transport,
                        d.command,
                        d.args,
                        d.url,
                        h.entry
                            .fields
                            .iter()
                            .map(|f| format!(
                                "{}{}{}",
                                f.key,
                                if f.required { "!" } else { "" },
                                if f.secret { "*" } else { "" }
                            ))
                            .collect::<Vec<_>>()
                    );
                }
            }

            let branch = market
                .default_branch("anthropics/skills")
                .await
                .expect("info/refs");
            println!("anthropics/skills 默认分支 → {branch}");
            let readme = market
                .raw_text(&link::raw_skill_md_url(
                    "anthropics/skills",
                    &branch,
                    "skills/pdf",
                ))
                .await
                .expect("raw");
            println!(
                "raw SKILL.md → {} 字节",
                readme.as_deref().map(str::len).unwrap_or(0)
            );

            // codeload 整包（不占次数）：列出 skill 文件夹、读提交 SHA；分支带 `/` 的重试走 404
            let bytes = market
                .download("anthropics/skills", &branch)
                .await
                .expect("codeload");
            let dirs = archive::skill_dirs(&bytes).expect("skill_dirs");
            println!(
                "codeload {} 字节 · {} 个 skill · 提交 {:?}",
                bytes.len(),
                dirs.len(),
                archive::commit_sha(&bytes).ok()
            );
            println!(
                "skills/pdf 下面 → {:?}",
                skills_under(&dirs, Some("skills/pdf"), "anthropics/skills")
            );
            assert_eq!(
                market
                    .download("anthropics/skills", "no-such-branch-x")
                    .await
                    .err()
                    .map(|f| f.error),
                Some(NetError::NotFound)
            );
        });
    }

    // ── 端到端（手动跑，要联网：
    //    `cargo test -p sophia --lib market::tests::live_install_pdf_end_to_end -- --ignored --nocapture`）──
    // 临时 HOME（先 canonicalize）里从 codeload 真装 anthropics/skills 的 skills/pdf 到用户级，给 Claude Code 与
    // Codex：文件、链接、安装记录、tree SHA 与 GitHub 给的同一个文件夹的 tree SHA 一致；再撤销，回到干净。
    // 只碰临时目录，不碰真实的 HOME；GitHub 接口只调一次（按提交 SHA 取 trees）
    #[test]
    #[ignore]
    fn live_install_pdf_end_to_end() {
        use sophia_core::market::treehash;
        use sophia_core::store::Store;

        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().canonicalize().expect("canonicalize");
        let home = root.join("home");
        // 让 Claude Code 与 Codex 算已安装：两家的 detect_dir 里有 skill 目录之外的东西
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), "{}").unwrap();
        std::fs::write(home.join(".codex/config.toml"), "").unwrap();
        let env = Env {
            apps: Vec::new(),
            home: home.clone(),
            vars: HashMap::from([("HOME".to_string(), home.display().to_string())]),
        };
        let store = Store::new(root.join("sophia"));
        let hold_root = root.join("sophia").join("held");

        let market = MarketState::default();
        let (bytes, remote) = tauri::async_runtime::block_on(async {
            let bytes = market
                .download("anthropics/skills", "main")
                .await
                .expect("codeload 下载");
            let commit = archive::commit_sha(&bytes).expect("pax_global_header 里的提交 SHA");
            // 按包里的那个提交取 trees：main 此刻若又动了，也还是同一版
            let tree = market
                .fetch_tree("anthropics/skills", &commit)
                .await
                .expect("GitHub trees");
            (bytes, tree)
        });
        let commit = archive::commit_sha(&bytes).unwrap();
        let remote_sha = remote
            .folders
            .get("skills/pdf")
            .cloned()
            .expect("GitHub 上有 skills/pdf");
        println!("codeload {} 字节 · 提交 {commit}", bytes.len());

        let harnesses: Vec<Harness> = discovery::installed(&env)
            .into_iter()
            .filter(|h| h.id == "claude-code" || h.id == "codex")
            .collect();
        assert_eq!(
            harnesses.len(),
            2,
            "临时 HOME 里应认出 Claude Code 与 Codex"
        );
        let request = SkillInstallRequest {
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            paths: vec!["skills/pdf".into()],
            location: "global".into(),
            harness_ids: vec!["claude-code".into(), "codex".into()],
        };
        let plan = install::plan(&env, &harnesses, &request).expect("计划");
        println!(
            "计划：落点 {} · 建通用仓库 {} · 直接读取 {:?} · 链接 {}",
            plan.store_dir.display(),
            plan.creates_store,
            plan.direct_readers,
            plan.links.len()
        );
        assert!(plan.creates_store, "~/.agents/skills 原本不存在");
        assert!(plan.items.iter().all(|i| i.blocked.is_none()));

        let mut subs = sophia_core::subscriptions::Subscriptions::default();
        let mut outcome = install::execute(
            &plan,
            &bytes,
            &commit,
            "anthropics/skills",
            "main",
            now(),
            &mut subs,
            &store,
        );
        println!(
            "装上 {:?} · 失败 {:?} · 链接 {:?}",
            outcome.installed,
            outcome.failed,
            outcome
                .links
                .entries
                .iter()
                .map(|e| (
                    e.action.target_path.display().to_string(),
                    format!("{:?}", e.outcome)
                ))
                .collect::<Vec<_>>()
        );
        assert_eq!(outcome.installed, vec!["pdf".to_string()]);
        assert!(outcome.failed.is_empty());

        // 文件
        let dest = home.join(".agents/skills/pdf");
        assert!(dest.join("SKILL.md").is_file(), "SKILL.md 到位");
        // 链接：不直接读 .agents/skills 的那几家各一条，指向落点
        for (id, link) in [
            ("claude-code", home.join(".claude/skills/pdf")),
            ("codex", home.join(".codex/skills/pdf")),
        ] {
            if plan.direct_readers.iter().any(|r| r == id) {
                assert_eq!(
                    entry_kind(&link),
                    EntryKind::Missing,
                    "{id} 直接读取，不建链接"
                );
                continue;
            }
            assert!(
                matches!(entry_kind(&link), EntryKind::Symlink(_)),
                "{id} 里是链接"
            );
            assert_eq!(
                std::fs::canonicalize(&link).unwrap(),
                dest.canonicalize().unwrap(),
                "{id} 的链接指向落点"
            );
        }
        // 通用仓库成了用户级的来源：它是这个位置自己的来源，永远算已订阅，不记进订阅
        assert!(subs.is_empty(), "自己的通用仓库不进订阅：{subs:?}");
        let found = discovery::sources(&env, &harnesses, &[], &[]);
        assert!(
            found
                .iter()
                .any(|s| s.path == normalize(&home.join(".agents/skills"))),
            "扫描认出 ~/.agents/skills 这个来源：{:?}",
            found
                .iter()
                .map(|s| s.path.display().to_string())
                .collect::<Vec<_>>()
        );

        // 安装记录：存进 installs.json 再读回来
        let mut records = store.load_installs().unwrap();
        for r in &outcome.records {
            installs::upsert(&mut records, r.clone());
        }
        store.save_installs(&records).unwrap();
        let saved = store.load_installs().unwrap();
        assert_eq!(saved.len(), 1);
        let rec = &saved[0];
        println!(
            "记录：{} · {} · {} · {} · tree {} · 提交 {}",
            rec.name, rec.location, rec.repo, rec.path, rec.tree_sha, rec.commit_sha
        );
        assert_eq!(
            (
                rec.name.as_str(),
                rec.location.as_str(),
                rec.repo.as_str(),
                rec.path.as_str()
            ),
            ("pdf", "global", "anthropics/skills", "skills/pdf")
        );
        assert_eq!(rec.commit_sha, commit);
        // tree SHA：记下的 = 本地按 git 规则算的 = GitHub 给的
        let local_sha = treehash::tree_sha(&dest).unwrap();
        println!(
            "tree SHA：记下 {} · 本地 {local_sha} · GitHub {remote_sha}",
            rec.tree_sha
        );
        assert_eq!(rec.tree_sha, remote_sha);
        assert_eq!(local_sha, remote_sha);

        // 撤销：链接删掉，文件夹进暂存，记录拿掉
        let undo = outcome.take_undo().expect("有撤销记录");
        let mut records = store.load_installs().unwrap();
        let report = install::undo(&undo, &hold_root, &mut records, Some(&store));
        store.save_installs(&records).unwrap();
        println!(
            "撤销：{:?}",
            report
                .entries
                .iter()
                .map(|e| (
                    e.action.target_path.display().to_string(),
                    format!("{:?}", e.outcome)
                ))
                .collect::<Vec<_>>()
        );
        assert_eq!(entry_kind(&dest), EntryKind::Missing, "落点里的 pdf 移走了");
        assert_eq!(
            entry_kind(&home.join(".claude/skills/pdf")),
            EntryKind::Missing
        );
        assert_eq!(
            entry_kind(&home.join(".codex/skills/pdf")),
            EntryKind::Missing
        );
        assert!(store.load_installs().unwrap().is_empty(), "安装记录拿掉了");
        let held: Vec<_> = walk(&hold_root);
        assert!(
            held.iter().any(|p| p.ends_with("SKILL.md")),
            "文件夹进了暂存（不是直接删）：{held:?}"
        );
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.extend(walk(&p));
                } else {
                    out.push(p);
                }
            }
        }
        out
    }
}

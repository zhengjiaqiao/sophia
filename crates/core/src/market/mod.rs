//! 发现与安装（spec `docs/specs/2026-09-27-skill-mcp-market.md`）的 core 部分：
//! 链接解析、tar.gz 解包、git tree SHA、读 `.skill-lock.json`、装 skill / 更新的计划与执行、
//! 安装记录。**不联网、不异步**：下载、搜索、查 GitHub 都在 `src-tauri/src/market.rs`，
//! 拿到字节或远端 tree SHA 之后再交给这里。
//!
//! 各子模块的负责任务见 `docs/plans/2026-09-27-skill-mcp-market-plan.md`：
//! `link` / `archive` 归 T1，`treehash` / `lock` 归 T2，`install` / `installs` 归 T3。
//! 这里的公共类型由 T0 定下，前端 `src/types.ts` 的「发现与安装」一段与之一一对应；
//! 要改字段先改这里，再同步 `types.ts`。
//!
//! 随包数据 `data/market/skills-popular.json`（热门快照）与 `mcp-curated.json`（MCP 精选）
//! 现在是 T0 放的样例（各 3 条，文件顶层 `note` 写明），T10 用脚本与精选清单替换。

// T0 只预留签名，T1–T4 填实现；填完后各子模块里用不上的桩就没了，届时删掉这一行
#![allow(dead_code)]

pub mod archive;
pub mod install;
pub mod installs;
pub mod link;
pub mod lock;
pub mod treehash;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// 市场各入口的错误：给用户看的一句中文。联网之外的失败都在 core 里定句子
pub type MarketResult<T> = Result<T, String>;

/// 还没实现的桩统一返回这一句
pub const NOT_IMPLEMENTED: &str = "未实现"; // i18n-exempt: 没有调用方的桩占位句，不会显示在界面上

/// 整个仓库压缩包的下载上限（R9：200MB）。网络层边下边数，超过即停。
/// 下的是整个仓库，要的只是其中一个 skill 文件夹：仓库大不等于 skill 大（2026-09-29 产品负责人真机：orca-cli）
pub const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

/// 选中的一个 skill 文件夹解开后的上限（R9：50MB）：只数落进这个文件夹的文件
pub const MAX_SKILL_BYTES: u64 = 50 * 1024 * 1024;

/// 走一遍整包时解压出的总量上限：只为挡压缩炸弹（网络层只数了压缩后的大小），不是给正常仓库定的额度
pub const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;

// 兜底上限要比下载上限大，否则正常的大仓库会被当成压缩炸弹
const _: () = assert!(MAX_UNPACKED_BYTES > MAX_DOWNLOAD_BYTES);

/// 一个 GitHub 上的位置：仓库，可选分支与仓库内路径（R6 的四种写法解析出来都是它）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRef {
    pub owner: String,
    pub repo: String,
    /// 没写分支（`owner/repo`、仓库首页链接）时为 None：网络层取仓库的默认分支
    pub branch: Option<String>,
    /// 仓库内路径，不带首尾 `/`；指向 `SKILL.md` 的 blob 链接取它所在的文件夹。仓库根为 None
    pub path: Option<String>,
}

impl GithubRef {
    /// `owner/repo`：界面上的来源仓库、安装记录里的 `repo` 都是这个写法
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// 一次由 Sophia 装下的 skill 记下的来历（R12），存在 Sophia 自己的 `installs.json`，
/// 不写 `.skill-lock.json`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    /// skill 名＝落点文件夹名
    pub name: String,
    /// 装在哪个位置：域 key，`global` / `project:<路径>`（同 `skills::domain_key`）
    pub location: String,
    /// `owner/repo`
    pub repo: String,
    /// 装时实际用的分支（默认分支也写出名字）
    pub branch: String,
    /// 仓库内 skill 文件夹的路径，不带首尾 `/`；skill 就在仓库根时为空串
    pub path: String,
    /// 装下那一版文件夹的 git tree SHA，与 `.skill-lock.json` 的 `skillFolderHash` 同一种
    pub tree_sha: String,
    /// 装下那一版排除杂项后的指纹（`treehash::content_sha`，#108），比本地改没改时优先用它：
    /// 那一版自己带着 `.DS_Store`、`.gitignore` 时，它们之后变了也不算改动。
    /// 这一项加上之前记下的没有，按 `tree_sha` 比
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_sha: Option<String>,
    /// 提交 SHA，从 codeload 包的 `pax_global_header` 读
    pub commit_sha: String,
    /// 装的时刻，unix 秒；更新后改成更新的时刻
    pub installed_at: u64,
}

/// 能查更新的 skill 从哪里认出来的（R12 / R13）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateOrigin {
    /// Sophia 自己的 `installs.json`
    Sophia,
    /// `~/.agents/.skill-lock.json`（`npx skills` 装的），只读
    SkillLock,
}

/// 一个有新版本的 skill（R15）。只有远端 tree SHA 与记下的不同才会出现
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub name: String,
    /// 域 key
    pub location: String,
    /// 本地 skill 文件夹（落点）
    pub dir: PathBuf,
    /// `owner/repo`
    pub repo: String,
    pub branch: String,
    /// 仓库内路径；「看改动」拼 `https://github.com/{repo}/commits/{branch}/{path}`
    pub path: String,
    pub origin: UpdateOrigin,
    /// 本地文件夹此刻按 git 规则算出的 tree SHA；算不出（文件夹没了、读不了）为 None
    pub local_tree_sha: Option<String>,
    /// 装时记下的
    pub recorded_tree_sha: String,
    /// GitHub 上此刻的；「关掉这一批」记的就是它
    pub remote_tree_sha: String,
    /// 本地改过：本地两种指纹都对不上 `recorded_tree_sha`（`treehash::LocalSha::is`，杂项不算改动）
    pub locally_modified: bool,
    /// 改过的文件，相对 skill 文件夹、按名排序。没改过为空；改过但还没取到记下那一版的
    /// 文件清单时也为空（网络层补上后再算，见 `treehash::changed_files`）
    pub changed_files: Vec<String>,
}

/// 装 skill 的请求（R6 / R9）：从哪个仓库装哪几个、装到哪、给谁建链接
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallRequest {
    /// `owner/repo`
    pub repo: String,
    /// 已解析出的分支（网络层先取默认分支再填）
    pub branch: String,
    /// 仓库内各 skill 文件夹的路径；落点文件夹名取路径最后一段（仓库根时取仓库名）
    pub paths: Vec<String>,
    /// 装到哪个位置：域 key。`全部` 不是合法值
    pub location: String,
    /// 给哪些 agent 建链接（harness id）。直接读 `.agents/skills` 的会被跳过
    pub harness_ids: Vec<String>,
}

/// 装 skill 的计划（R9 安装页据此摆：落点、同名拒绝、直接读取的 agent）。只读，不动盘
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub location: String,
    /// 这个位置的通用仓库：用户级 `~/.agents/skills`，项目 `<项目>/.agents/skills`
    pub store_dir: PathBuf,
    /// 通用仓库还不存在，装的时候会创建，并成为这个位置的「通用仓库」来源
    pub creates_store: bool,
    pub items: Vec<InstallItem>,
    /// 这个位置本来就直接读 `.agents/skills` 的 agent（harness id）：不用链接
    pub direct_readers: Vec<String>,
    /// 装完要建的链接（`ActionKind::Create`，指向各 `InstallItem::dest`）
    pub links: Vec<crate::models::PlannedAction>,
    /// 这个位置上要靠链接才读得到的 agent（`harnesses` 里全部，勾没勾都列；直接读取的不列）：
    /// 安装页据此把「那里已有同名的」那一行画成不能勾（M14）
    pub agent_dirs: Vec<AgentDir>,
}

/// 一个要靠链接才读得到的 agent 在这个位置的 skill 目录
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDir {
    pub harness_id: String,
    pub dir: PathBuf,
    /// 这次勾了它（要给它建链接）
    pub chosen: bool,
    /// 要装的 skill 里，这个目录已经有同名东西的（文件夹、别的链接）：不覆盖、不建链接
    pub taken: Vec<String>,
}

/// 装上了、但没给某个勾了的 agent 链上（M14）：那里已有同名的，或建链接失败
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unlinked {
    pub harness_id: String,
    /// skill 名
    pub name: String,
    /// 给人看的原因：`那里已有同名的`，或建链接失败的那一句
    pub reason: String,
}

/// 计划里的一个 skill
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallItem {
    pub name: String,
    /// 仓库内路径
    pub path: String,
    /// 落点：`<store_dir>/<name>`
    pub dest: PathBuf,
    /// 不能装的原因（落点已有同名的：`用户级的通用仓库里已经有 pdf`）；能装为 None
    pub blocked: Option<String>,
}

/// 装 / 更新的结果。撤销记录不出进程：命令层 `take_undo` 取走后只把 id 交给前端
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// 真正放到位的 skill 名
    pub installed: Vec<String>,
    /// 没装成的：skill 名 → 原因
    pub failed: BTreeMap<String, String>,
    /// 建链接的逐条结果
    pub links: crate::models::SyncReport,
    /// 装上了但没链上的 agent（勾了、那里已有同名的或建链接失败）。提示条据此说「没链上」，不能只看 `links`：
    /// 已有同名的那一格根本不出动作
    #[serde(default)]
    pub unlinked: Vec<Unlinked>,
    /// 这次装下 / 更新后的安装记录；调用方合进 `installs.json`（`installs::upsert`）
    pub records: Vec<InstallRecord>,
    /// 命令层登记撤销记录后填的 id；core 从不填
    #[serde(default)]
    pub undo_id: Option<String>,
    #[serde(skip)]
    pub(crate) undo: install::InstallUndo,
}

impl InstallOutcome {
    /// 取走撤销记录；什么都没动成时为 None
    pub fn take_undo(&mut self) -> Option<install::InstallUndo> {
        let undo = std::mem::take(&mut self.undo);
        (!undo.is_empty()).then_some(undo)
    }
}

/// 要更新的一个 skill：按位置 + 名字认（与 `UpdateInfo` 的这两项相同）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTarget {
    pub location: String,
    pub name: String,
}

/// MCP 服务器的连接方式（R7 / R8 / R10）。与 `mcp` 模块现有的 transport 字符串一致
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// 一份给定的 MCP 服务器定义：从精选 / 官方目录 / 粘贴的 JSON 来，写进勾选的 agent（T4
/// `mcp/define.rs` 的入口吃它）。值里可以有 `${KEY}` 占位，写入前按 `McpFieldSpec` 填上
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDefinitionInput {
    /// 服务名；粘贴的单个服务器对象没有名字时为空串，界面要用户补
    pub name: String,
    pub transport: McpTransport,
    /// stdio：命令与参数
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// http / sse：地址与请求头
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 上面装不下的字段（Gemini 的 `trust`、Codex 的 `startup_timeout_sec`、Copilot 的 `tools`……），
    /// 原样保留；TOML 的值换成对应的 JSON。只有 `dialect` 那一家接得住，别家按 MCP 页的原因句拒绝
    #[serde(default)]
    pub extra: BTreeMap<String, serde_json::Value>,
    /// 按粘贴的写法认出的出处（harness id：`gemini-cli`、`codex`、`github-copilot`、`claude-code`；
    /// 表外的 `zed`、`vscode`）。认不出为 None——这时 `extra` 非空就哪一家都不写
    #[serde(default)]
    pub dialect: Option<String>,
}

/// 一项要填的值出现在定义的哪里
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpFieldKind {
    Env,
    Header,
    Arg,
}

/// 安装页「要填的」一项（R10）。`key` 就是定义里 `${KEY}` 占位的名字
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFieldSpec {
    pub key: String,
    pub kind: McpFieldKind,
    pub required: bool,
    /// 密钥：框遮住，只写进目标配置文件，Sophia 不存、不记日志
    pub secret: bool,
    /// 一句说明（可空）
    #[serde(default)]
    pub description: Option<String>,
}

/// 粘贴 JSON 解析的结果（R8，T4 `mcp/define.rs` 产出）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpParseResult {
    /// 认出来的服务器，按原文先后
    pub servers: Vec<McpDefinitionInput>,
    /// 解析不了时的原因；有它时 `servers` 为空
    pub error: Option<McpParseError>,
}

/// 解析错误：框下一行说哪一行错
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpParseError {
    /// 从 1 数；定不到行时为 None
    pub line: Option<usize>,
    pub message: String,
}

/// 把给定的定义写进一个位置的若干 agent（R8 / R10）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstallRequest {
    pub definitions: Vec<McpDefinitionInput>,
    /// 域 key
    pub location: String,
    /// 写进哪些 agent（harness id；Claude Desktop 是 `claude-desktop`）
    pub harness_ids: Vec<String>,
    /// 要填的值：`McpFieldSpec::key` → 值，写入前替换定义里的 `${KEY}`。
    /// 只经过内存写进目标配置文件，不进 Sophia 的设置、日志与诊断
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    /// 项目位置里 Claude Code 写哪一格：`self`（本地配置，缺省）/ `team`（项目的 `.mcp.json`）。
    /// 只对项目位置的 Claude Code 生效，用户级与其它 agent 忽略
    #[serde(default)]
    pub claude_code_scope: Option<String>,
    /// 安装页勾了「同时加进 .gitignore」（密钥提醒 S19）：写成之后，提醒为 `KeyHint::Remind` 的项目文件
    /// 追加进项目根的 `.gitignore`
    #[serde(default)]
    pub add_to_gitignore: bool,
}

/// 写进某个 agent 行不行（R10 安装页每个勾选行后面那句）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTargetStatus {
    /// 全部能写
    Ok,
    /// 只写其中几个（`writes`），其余的原因在 `reason`
    Partial,
    /// 一个都写不过去，不能勾
    Blocked,
    /// 目标里已有同名且一样的：跳过、不算失败
    Same,
}

/// 安装页「写进哪些 agent」一行的检查结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTargetCheck {
    pub harness_id: String,
    /// 这个位置上这个 agent 的 MCP 配置位置 id（`McpLocation.id`）；这个位置没有时为 None
    pub location_id: Option<String>,
    pub status: McpTargetStatus,
    /// 会写进去的服务名
    pub writes: Vec<String>,
    /// 写不过去 / 只写部分的原因：`Codex 里已经有一个不一样的 brave-search`、
    /// `只写 filesystem · github 是远程服务器，要在 Claude Desktop 自己的「连接器」里添加`
    pub reason: Option<String>,
    /// 生效时机等附注：`重启 Claude Desktop 后生效`
    pub note: Option<String>,
    /// 密钥提醒（S19）：往项目里的 git 仓库写像密钥的值时为 `Remind`（安装页出「同时加进 .gitignore」）；
    /// 目标文件已被跟踪时为 `Tracked`（不出勾选，换成一句说明）
    #[serde(default)]
    pub key_hint: crate::keyhint::KeyHint,
    /// `Remind` / `Tracked` 时这个目标在项目根 `.gitignore` 里会写成的那一行（`.cursor/mcp.json`、`/.mcp.json`）：
    /// 安装页提示框与说明列「哪几个文件」
    #[serde(default)]
    pub gitignore_line: Option<String>,
}

/// 发现 · MCP 列表里的一条（精选或官方目录）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogEntry {
    pub name: String,
    /// 发布方（小灰字）
    pub publisher: String,
    pub description: String,
    /// 定义模板，值里用 `${KEY}` 标出要填的
    pub definition: McpDefinitionInput,
    #[serde(default)]
    pub fields: Vec<McpFieldSpec>,
    /// 离开键指向的说明页（npm / 仓库 / 官网）
    #[serde(default)]
    pub homepage: Option<String>,
    /// 这条从哪来：精选写 `curated`，官方目录写 `registry`
    pub source: String,
    /// 要在浏览器里登录才能用（远程 OAuth）：列表的「要填」写 `需要登录`
    #[serde(default)]
    pub sign_in: bool,
}

/// 发现 · skill 列表里的一条（热门快照或 skills.sh 搜索结果）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListing {
    pub name: String,
    /// `owner/repo`
    pub repo: String,
    /// 仓库内路径；搜索结果不带路径时为 None，介绍页 / 安装前由网络层用 trees 补上
    #[serde(default)]
    pub path: Option<String>,
    /// 装过的人
    pub installs: u64,
}

#[derive(Deserialize)]
struct PopularFile {
    skills: Vec<SkillListing>,
}

#[derive(Deserialize)]
struct CuratedFile {
    servers: Vec<McpCatalogEntry>,
}

const POPULAR_JSON: &str = include_str!("../../data/market/skills-popular.json");
const CURATED_JSON: &str = include_str!("../../data/market/mcp-curated.json");

/// 随包的热门快照（R5），按文件里的先后
pub fn popular_snapshot() -> Vec<SkillListing> {
    serde_json::from_str::<PopularFile>(POPULAR_JSON)
        .map(|f| f.skills)
        .unwrap_or_default()
}

/// 随包的 MCP 精选（R7），按文件里的先后
pub fn curated_mcp() -> Vec<McpCatalogEntry> {
    serde_json::from_str::<CuratedFile>(CURATED_JSON)
        .map(|f| f.servers)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 随包数据读得出来：格式错了 `unwrap_or_default` 会静默变空，这里兜住
    #[test]
    fn bundled_catalogs_parse() {
        serde_json::from_str::<PopularFile>(POPULAR_JSON).expect("skills-popular.json");
        serde_json::from_str::<CuratedFile>(CURATED_JSON).expect("mcp-curated.json");
        assert!(!popular_snapshot().is_empty());
        let curated = curated_mcp();
        assert!(!curated.is_empty());
        // 每个要填的项都在定义里有对应的 `${KEY}` 占位
        for entry in &curated {
            let text = serde_json::to_string(&entry.definition).unwrap();
            for field in &entry.fields {
                assert!(
                    text.contains(&format!("${{{}}}", field.key)),
                    "{} 缺占位 {}",
                    entry.name,
                    field.key
                );
            }
        }
    }

    #[test]
    fn shared_types_are_camel_case() {
        let record = InstallRecord {
            name: "pdf".into(),
            location: "global".into(),
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            path: "skills/pdf".into(),
            tree_sha: "t".into(),
            content_sha: None,
            commit_sha: "c".into(),
            installed_at: 1,
        };
        let v = serde_json::to_value(&record).unwrap();
        assert!(v.get("treeSha").is_some() && v.get("installedAt").is_some());
        let r = GithubRef {
            owner: "anthropics".into(),
            repo: "skills".into(),
            branch: None,
            path: Some("skills/pdf".into()),
        };
        assert_eq!(r.slug(), "anthropics/skills");
        let outcome = InstallOutcome::default();
        let v = serde_json::to_value(&outcome).unwrap();
        assert!(v.get("undo").is_none() && v.get("undoId").is_some());
    }
}

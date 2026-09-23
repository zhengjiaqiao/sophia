//! JSON 持久化：projects.json、settings.json，整文件原子写（先写 .tmp 再 rename）
use crate::{
    codex_models::settings::GatewaySettings,
    mcp::{McpAutoImportRule, McpOverview},
    models::{AutoLink, Source},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 应用设置：被用户关掉的 harness id、手动添加的本体位置、自动同步规则
/// 容器级 `default` 让旧格式（缺字段）照样能读
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 不显示名单：不在列表里显示的 agent id（见 `discovery::reconcile_shown`）
    pub disabled_harnesses: Vec<String>,
    /// 上次整理显示名单时已安装的 agent id。不在其中的已安装 agent 算新装的——
    /// 只有它们受「显示不满 4 个才自动出现」管。旧文件没有这个字段，读成空：
    /// 已安装的全算新装，正好按 agent 表先后留前 4 个
    pub known_installed: Vec<String>,
    pub manual_sources: Vec<PathBuf>,
    pub auto_links: Vec<AutoLink>,
    pub mcp_auto_imports: Vec<McpAutoImportRule>,
    pub codex_gateway: GatewaySettings,
    /// 用户已经看过的问题（新问题只提示一次，看过即止）；旧文件没有这个字段
    pub seen_issues: Vec<SeenIssue>,
    /// 旧版「忽略」表，只读不写：`load_settings` 把它并进 `seen_issues` 后清空，
    /// 下次写盘时这个字段就从文件里消失了
    #[serde(rename = "ignored", skip_serializing)]
    pub(crate) legacy_ignored: Vec<SeenIssue>,
}

/// skill / MCP 上需要用户拿主意的几类问题；key 的第一段就是它（见 `issue_key`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    /// 同名本体出现在多处，目标指向了另一处
    DuplicateSource,
    /// 链接指向不存在的位置
    BrokenLink,
    /// 目标位置写不进去 → 再试一次
    ReadOnlyTarget,
    /// 目标整个目录链到了别的本体 → 拆开
    WholeLinkedTarget,
    /// MCP：几个位置各有一份同名配置、连的地址不一样 → 看两边差在哪
    DifferentCopies,
    /// MCP：某个位置的配置文件这次读不出来 → 去看看
    InvalidLocation,
}

impl IssueKind {
    /// key 里的稳定标签，与 serde 的 camelCase 一致
    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::DuplicateSource => "duplicateSource",
            IssueKind::BrokenLink => "brokenLink",
            IssueKind::ReadOnlyTarget => "readOnlyTarget",
            IssueKind::WholeLinkedTarget => "wholeLinkedTarget",
            IssueKind::DifferentCopies => "differentCopies",
            IssueKind::InvalidLocation => "invalidLocation",
        }
    }
}

/// 看过的一条问题。记的是"这一条具体状况"而不是某个 skill：涉及的位置一变，key 就变，
/// 界面把它当新问题再提示一次。
///
/// key 是不透明字符串，由前端算好传进来，core 只负责存。两种来源、两种格式，互不相撞：
/// - skill / MCP：`issue_key` 的公式，`<IssueKind>` + `\u{1f}` + 涉及位置（规范化、排序）逐个拼接，
///   如 `duplicateSource\u{1f}/a/skills/x\u{1f}/b/skills/x`。与前端 `pendingIssues.ts › issueKey`
///   两边钉死（`key_format_is_pinned_for_the_frontend` / `tests/issue-key-contract.test.ts`）
/// - 模型：以 `MODEL_KEY_PREFIX`（`model\u{1f}`）开头，后接类别与能区分状况的细节，段间同样用 `\u{1f}`：
///   - `model\u{1f}takeover\u{1f}<接管方的 baseUrl>`
///   - `model\u{1f}configChanged\u{1f}<Codex 版本>`
///   - `model\u{1f}unreachable\u{1f}<providerId>\u{1f}<连不上的原因>`
///
///   `IssueKind` 里没有叫 `model` 的类别，所以模型 key 不会与 skill / MCP 的撞
///   （`model_keys_cannot_collide_with_issue_keys` 钉住）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenIssue {
    pub key: String,
    /// 标为看过的时间，RFC 3339 的 UTC 写法，可直接按字典序排。
    /// 旧「忽略」记录另带一个 `kind` 字段，读的时候直接丢掉
    pub at: String,
}

/// key 内部的分隔符：Unit Separator，路径里不会出现
const KEY_SEP: char = '\u{1f}';

/// 模型类问题 key 的前缀，格式见 `SeenIssue`
pub const MODEL_KEY_PREFIX: &str = "model\u{1f}";

/// skill / MCP 问题的 key：类别 + 全部路径（规范化后排序）拼接。
/// 排序是为了让路径的先后顺序不影响结果；不取摘要，直接留可读的路径串，
/// 这样 settings.json 里的记录能看懂，也不依赖任何跨版本不保证稳定的 hash。
pub fn issue_key(kind: IssueKind, paths: &[PathBuf]) -> String {
    let mut parts: Vec<String> = paths
        .iter()
        .map(|p| crate::fs::normalize(p).to_string_lossy().into_owned())
        .collect();
    parts.sort();
    let mut key = String::from(kind.as_str());
    for p in parts {
        key.push(KEY_SEP);
        key.push_str(&p);
    }
    key
}

fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    rfc3339_utc(secs)
}

/// Unix 秒 → `YYYY-MM-DDTHH:MM:SSZ`。天数转公历用 Howard Hinnant 的 civil_from_days
fn rfc3339_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 把纪元移到 0000-03-01，让闰日落在 400 年周期末尾
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 系统应用数据目录下的 `SymSync`。**产品改名叫 Sophia 之后这个目录名不动**：
    /// 已经装着的那些用户的 projects.json / settings.json 和后台程序副本都在里面，
    /// 改名等于把它们丢掉。同理不动的还有 bundle identifier、launchd 服务名和钥匙串条目
    pub fn default_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("SymSync")
    }

    pub fn load_projects(&self) -> io::Result<Vec<PathBuf>> {
        load_json(&self.dir.join("projects.json"))
    }

    pub fn save_projects(&self, projects: &[PathBuf]) -> io::Result<()> {
        save_json(&self.dir.join("projects.json"), &projects)
    }

    /// 读设置；旧版「忽略」表在这里并进「看过」表（忽略过的就是看过的），不单独写回
    pub fn load_settings(&self) -> io::Result<Settings> {
        let mut settings: Settings = load_json(&self.dir.join("settings.json"))?;
        for issue in std::mem::take(&mut settings.legacy_ignored) {
            if !settings.seen_issues.iter().any(|i| i.key == issue.key) {
                settings.seen_issues.push(issue);
            }
        }
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        save_json(&self.dir.join("settings.json"), settings)
    }

    /// 读设置，顺手做 skill 自动同步规则的升级迁移：没有 baseline 的旧规则补上本体位置
    /// 当前的全部 skill 名（见 `skills::migrate_baselines`），改过才写回。
    /// 要扫描结果才能迁移，所以只在扫描之后展开规则的地方用它，其余照旧 `load_settings`
    pub fn load_settings_migrating_auto_links(&self, sources: &[Source]) -> io::Result<Settings> {
        let mut settings = self.load_settings()?;
        if crate::skills::migrate_baselines(&mut settings.auto_links, sources) {
            self.save_settings(&settings)?;
        }
        Ok(settings)
    }

    /// 同上，MCP 自动添加规则：取来源位置当前的全部 MCP 名（见 `mcp::migrate_baselines`）
    pub fn load_settings_migrating_mcp_auto_imports(
        &self,
        overview: &McpOverview,
    ) -> io::Result<Settings> {
        let mut settings = self.load_settings()?;
        if crate::mcp::migrate_baselines(&mut settings.mcp_auto_imports, overview) {
            self.save_settings(&settings)?;
        }
        Ok(settings)
    }

    /// 读设置，顺手按上限整理显示名单（见 `discovery::reconcile_shown`），改过才写回。
    /// `installed` 是已安装的 agent id，按 agent 表的先后
    pub fn load_settings_reconciling_shown(&self, installed: &[String]) -> io::Result<Settings> {
        let mut settings = self.load_settings()?;
        if crate::discovery::reconcile_shown(installed, &mut settings) {
            self.save_settings(&settings)?;
        }
        Ok(settings)
    }

    /// 把这些 key 记为看过；已在表里的保持原样（不刷新 at），空串跳过。没有新增就不写盘
    pub fn mark_seen(&self, keys: &[String]) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        let before = settings.seen_issues.len();
        let at = now_rfc3339();
        for key in keys {
            if key.is_empty() || settings.seen_issues.iter().any(|i| &i.key == key) {
                continue;
            }
            settings.seen_issues.push(SeenIssue {
                key: key.clone(),
                at: at.clone(),
            });
        }
        if settings.seen_issues.len() == before {
            return Ok(());
        }
        self.save_settings(&settings)
    }

    /// 看过的全部 key，按记下的先后
    pub fn seen_keys(&self) -> io::Result<Vec<String>> {
        Ok(self
            .load_settings()?
            .seen_issues
            .into_iter()
            .map(|i| i.key)
            .collect())
    }
}

/// 文件不存在 → 默认值；存在但损坏 → 报错，不静默清空
fn load_json<T: DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e),
    }
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    #[test]
    fn missing_files_load_as_empty() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        assert_eq!(s.load_projects().unwrap(), Vec::<PathBuf>::new());
    }

    #[test]
    fn projects_round_trip_and_overwrite_atomically() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        let p = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        s.save_projects(&p).unwrap();
        assert_eq!(s.load_projects().unwrap(), p);
        s.save_projects(&[]).unwrap();
        assert_eq!(s.load_projects().unwrap(), Vec::<PathBuf>::new());
        assert!(!dir.join("projects.json.tmp").exists());
    }

    #[test]
    fn settings_default_when_missing_and_round_trip() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        assert_eq!(s.load_settings().unwrap(), Settings::default());
        let settings = Settings {
            disabled_harnesses: vec!["a".into(), "b".into()],
            known_installed: vec!["a".into(), "c".into()],
            manual_sources: vec![PathBuf::from("/a/skills")],
            auto_links: vec![AutoLink {
                source: PathBuf::from("/a/skills"),
                targets: vec!["claude-code".into()],
                excluded: ["x".to_string()].into_iter().collect(),
                baseline: Some(["y".to_string()].into_iter().collect()),
            }],
            mcp_auto_imports: vec![McpAutoImportRule {
                source: crate::mcp::McpLocationRef {
                    id: "source".into(),
                    harness_id: "claude-code".into(),
                    domain: "global".into(),
                    path: PathBuf::from("/a/source.json"),
                    selector: None,
                },
                target_domain: "project:/a".into(),
                targets: vec![crate::mcp::McpLocationRef {
                    id: "target".into(),
                    harness_id: "codex".into(),
                    domain: "project:/a".into(),
                    path: PathBuf::from("/a/.codex/config.toml"),
                    selector: None,
                }],
                excluded: ["private".to_string()].into_iter().collect(),
                allow_cross_domain: true,
                baseline: Some(["docs".to_string()].into_iter().collect()),
            }],
            codex_gateway: GatewaySettings::default(),
            seen_issues: vec![SeenIssue {
                key: issue_key(IssueKind::BrokenLink, &[PathBuf::from("/a/skills/x")]),
                at: "2026-09-23T00:00:00Z".into(),
            }],
            legacy_ignored: Vec::new(),
        };
        s.save_settings(&settings).unwrap();
        assert_eq!(s.load_settings().unwrap(), settings);
        assert!(!dir.join("settings.json.tmp").exists());
    }

    #[test]
    fn settings_without_manual_sources_or_auto_links_still_loads() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(dir.join("settings.json"), r#"{"disabledHarnesses":[]}"#).unwrap();
        let loaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(loaded.manual_sources, Vec::<PathBuf>::new());
        assert_eq!(loaded.auto_links, Vec::<AutoLink>::new());
        assert_eq!(loaded.mcp_auto_imports, Vec::<McpAutoImportRule>::new());
    }

    /// 升级前写下的 settings.json：两类规则都没有 baseline。
    /// 首次扫描后读设置即迁移成当前全部名字并写回，旧规则从此不再补建现有的
    #[test]
    fn rules_persisted_without_baseline_migrate_on_first_scanned_load() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let store_dir = t.dir("store");
        t.dir("store/a");
        t.dir("store/b");
        let mcp_path = t.root().join("mcp.json");
        std::fs::write(&mcp_path, r#"{"mcpServers":{"docs":{"command":"docs"}}}"#).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let old = serde_json::json!({
            "autoLinks": [{"source": store_dir, "targets": ["claude-code"], "excluded": []}],
            "mcpAutoImports": [{
                "source": {"id": "src", "harnessId": "claude-code", "domain": "global", "path": mcp_path},
                "targetDomain": "global",
                "targets": [],
                "excluded": []
            }]
        });
        std::fs::write(dir.join("settings.json"), old.to_string()).unwrap();
        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.auto_links[0].baseline, None);
        assert_eq!(loaded.mcp_auto_imports[0].baseline, None);

        let env = crate::discovery::Env {
            home: t.dir("home"),
            vars: Default::default(),
        };
        let sources = crate::discovery::sources(&env, &[], &[], std::slice::from_ref(&store_dir));
        let migrated = s.load_settings_migrating_auto_links(&sources).unwrap();
        let names = |v: &[&str]| Some(v.iter().map(|n| n.to_string()).collect());
        assert_eq!(migrated.auto_links[0].baseline, names(&["a", "b"]));
        // 写回了：之后普通读取也带着 baseline，新增的名字不会被并进去
        t.dir("store/c");
        assert_eq!(
            s.load_settings().unwrap().auto_links[0].baseline,
            names(&["a", "b"])
        );

        let location = crate::mcp::McpLocation {
            id: "src".into(),
            label: "src".into(),
            harness_id: "claude-code".into(),
            domain: "global".into(),
            path: mcp_path,
            selector: None,
            matrix_hidden: false,
        };
        let overview = crate::mcp::scan(&[location]);
        let migrated = s
            .load_settings_migrating_mcp_auto_imports(&overview)
            .unwrap();
        assert_eq!(migrated.mcp_auto_imports[0].baseline, names(&["docs"]));
        let reloaded = s.load_settings().unwrap();
        assert_eq!(reloaded.mcp_auto_imports[0].baseline, names(&["docs"]));
        assert_eq!(reloaded.auto_links[0].baseline, names(&["a", "b"]));
    }

    #[test]
    fn settings_without_seen_issues_still_loads() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"manualSources":["/a/skills"]}"#,
        )
        .unwrap();
        let loaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["codex".to_string()]);
        assert_eq!(loaded.seen_issues, Vec::<SeenIssue>::new());
    }

    #[test]
    fn old_settings_over_four_shown_are_trimmed_and_written_back() {
        // 升级前的文件：没有 knownInstalled，5 个已安装全在显示
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":[],"manualSources":[],"autoLinks":[]}"#,
        )
        .unwrap();
        let s = Store::new(dir);
        let installed: Vec<String> = ["claude-code", "codex", "cursor", "cline", "gemini-cli"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        let loaded = s.load_settings_reconciling_shown(&installed).unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["gemini-cli".to_string()]);
        let reread = s.load_settings().unwrap();
        assert_eq!(reread, loaded);
        assert_eq!(reread.known_installed, installed);
    }

    #[test]
    fn key_ignores_path_order() {
        let a = PathBuf::from("/a/skills/x");
        let b = PathBuf::from("/b/skills/x");
        assert_eq!(
            issue_key(IssueKind::DuplicateSource, &[a.clone(), b.clone()]),
            issue_key(IssueKind::DuplicateSource, &[b, a])
        );
    }

    #[test]
    fn key_changes_when_any_path_changes() {
        let base = [PathBuf::from("/a/skills/x"), PathBuf::from("/b/skills/x")];
        let moved = [PathBuf::from("/a/skills/x"), PathBuf::from("/c/skills/x")];
        assert_ne!(
            issue_key(IssueKind::DuplicateSource, &base),
            issue_key(IssueKind::DuplicateSource, &moved)
        );
        // 多一个位置也算变化
        let more = [
            PathBuf::from("/a/skills/x"),
            PathBuf::from("/b/skills/x"),
            PathBuf::from("/c/skills/x"),
        ];
        assert_ne!(
            issue_key(IssueKind::DuplicateSource, &base),
            issue_key(IssueKind::DuplicateSource, &more)
        );
    }

    #[test]
    fn key_separates_kinds_and_normalizes_paths() {
        let paths = [PathBuf::from("/a/skills/x")];
        // 路径完全相同时，每个 kind 都必须给出互不相同的 key
        let kinds = [
            IssueKind::DuplicateSource,
            IssueKind::BrokenLink,
            IssueKind::ReadOnlyTarget,
            IssueKind::WholeLinkedTarget,
            IssueKind::DifferentCopies,
            IssueKind::InvalidLocation,
        ];
        let keys: std::collections::BTreeSet<String> =
            kinds.iter().map(|k| issue_key(*k, &paths)).collect();
        assert_eq!(keys.len(), kinds.len(), "{keys:?}");
        // ./ 与 .. 只是写法差异，不该算成另一条状况
        assert_eq!(
            issue_key(IssueKind::BrokenLink, &paths),
            issue_key(
                IssueKind::BrokenLink,
                &[PathBuf::from("/a/./b/../skills/x")]
            )
        );
    }

    #[test]
    fn mark_seen_round_trip() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        let broken = issue_key(IssueKind::BrokenLink, &[PathBuf::from("/a/skills/x")]);
        let model = format!("{MODEL_KEY_PREFIX}configChanged\u{1f}0.50.0");

        assert_eq!(s.seen_keys().unwrap(), Vec::<String>::new());
        s.mark_seen(&[broken.clone(), model.clone()]).unwrap();
        assert_eq!(s.seen_keys().unwrap(), vec![broken.clone(), model.clone()]);
        let first_at = s.load_settings().unwrap().seen_issues[0].at.clone();

        // 重复标、同一批里重复、空串都不会多写一条
        s.mark_seen(&[broken.clone(), broken.clone(), String::new()])
            .unwrap();
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.seen_issues.len(), 2);
        assert_eq!(loaded.seen_issues[0].at, first_at);
        // 空列表不报错
        s.mark_seen(&[]).unwrap();
    }

    /// 升级前写下的 settings.json：只有旧的 `ignored` 表，每条带 kind / key / at。
    /// 读进来要当作看过，旧字段在下次写盘时消失，不再写回
    #[test]
    fn legacy_ignored_file_loads_as_seen() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        let dup = issue_key(
            IssueKind::DuplicateSource,
            &[PathBuf::from("/a/skills/x"), PathBuf::from("/b/skills/x")],
        );
        let old = serde_json::json!({
            "disabledHarnesses": ["codex"],
            "ignored": [
                {"kind": "duplicateSource", "key": dup, "at": "2026-09-01T08:00:00Z"},
                {"kind": "invalidLocation", "key": "invalidLocation\u{1f}/p/mcp.json#notion", "at": "2026-09-02T08:00:00Z"}
            ]
        });
        std::fs::write(dir.join("settings.json"), old.to_string()).unwrap();
        let s = Store::new(dir.clone());

        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["codex".to_string()]);
        assert_eq!(
            loaded.seen_issues,
            vec![
                SeenIssue {
                    key: dup.clone(),
                    at: "2026-09-01T08:00:00Z".into()
                },
                SeenIssue {
                    key: "invalidLocation\u{1f}/p/mcp.json#notion".into(),
                    at: "2026-09-02T08:00:00Z".into()
                },
            ]
        );
        assert!(loaded.legacy_ignored.is_empty());

        // 已在旧表里的再标一次不重复；新标的一条触发写盘，旧字段随之消失
        let model = format!("{MODEL_KEY_PREFIX}takeover\u{1f}http://127.0.0.1:9000");
        s.mark_seen(&[dup.clone(), model.clone()]).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert!(raw.get("ignored").is_none(), "{raw}");
        assert_eq!(raw["seenIssues"].as_array().unwrap().len(), 3);
        assert_eq!(
            s.seen_keys().unwrap(),
            vec![
                dup,
                "invalidLocation\u{1f}/p/mcp.json#notion".to_string(),
                model
            ]
        );
    }

    /// 新旧两个字段同时在（例如装回旧版又升回来），也照样读，按 key 去重
    #[test]
    fn legacy_and_new_tables_together_merge_without_duplicates() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{
                "seenIssues": [{"key": "brokenLink\u001f/a", "at": "2026-09-03T00:00:00Z"}],
                "ignored": [
                    {"kind": "brokenLink", "key": "brokenLink\u001f/a", "at": "2026-09-01T00:00:00Z"},
                    {"kind": "brokenLink", "key": "brokenLink\u001f/b", "at": "2026-09-02T00:00:00Z"}
                ]
            }"#,
        )
        .unwrap();
        let keys = Store::new(dir).seen_keys().unwrap();
        assert_eq!(
            keys,
            vec![
                "brokenLink\u{1f}/a".to_string(),
                "brokenLink\u{1f}/b".to_string()
            ]
        );
    }

    #[test]
    fn seen_survives_a_save_load_round_trip() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        let key = issue_key(
            IssueKind::DuplicateSource,
            &[PathBuf::from("/b/skills/x"), PathBuf::from("/a/skills/x")],
        );
        s.mark_seen(std::slice::from_ref(&key)).unwrap();
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.seen_issues.len(), 1);
        assert_eq!(
            loaded.seen_issues[0].key,
            issue_key(
                IssueKind::DuplicateSource,
                &[PathBuf::from("/a/skills/x"), PathBuf::from("/b/skills/x")]
            )
        );
        let at = &loaded.seen_issues[0].at;
        assert!(at.len() == 20 && at.ends_with('Z'), "at = {at}");
    }

    /// 模型 key 的前缀不能是任何一类 skill / MCP 问题的 key 开头，否则两张表会互相吞
    #[test]
    fn model_keys_cannot_collide_with_issue_keys() {
        let kinds = [
            IssueKind::DuplicateSource,
            IssueKind::BrokenLink,
            IssueKind::ReadOnlyTarget,
            IssueKind::WholeLinkedTarget,
            IssueKind::DifferentCopies,
            IssueKind::InvalidLocation,
        ];
        for kind in kinds {
            for paths in [vec![], vec![PathBuf::from("/a")]] {
                let key = issue_key(kind, &paths);
                assert!(!key.starts_with(MODEL_KEY_PREFIX), "{key:?}");
            }
            assert_ne!(kind.as_str(), "model");
        }
    }

    #[test]
    fn at_is_sortable_utc_text() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        // 闰日
        assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_767_225_599), "2025-12-31T23:59:59Z");
        // 字典序就是时间序
        assert!(rfc3339_utc(0) < rfc3339_utc(1_700_000_000));
        let at = now_rfc3339();
        assert!(at.len() == 20 && at.ends_with('Z'), "at = {at}");
    }

    #[test]
    fn corrupt_file_is_an_error_not_silent_reset() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(dir.join("projects.json"), "{oops").unwrap();
        assert!(Store::new(dir).load_projects().is_err());
    }

    /// 跨语言契约：前端 `src/pages/pendingIssues.ts` 的 `issueKey` 必须算出同一个串。
    /// 两边各钉一条同输入同期望的测试——任一边改了格式，另一边立刻红。
    /// 改这条时必须同步改 `tests/issue-key-contract.test.ts` 里的同名期望值。
    #[test]
    fn key_format_is_pinned_for_the_frontend() {
        let key = issue_key(
            IssueKind::DuplicateSource,
            &[
                PathBuf::from("/b/skills/defuddle"),
                PathBuf::from("/a/skills/defuddle"),
            ],
        );
        assert_eq!(
            key, "duplicateSource\u{1f}/a/skills/defuddle\u{1f}/b/skills/defuddle",
            "key 格式变了就要同步改前端的 issueKey 和它那条契约测试"
        );
    }
}

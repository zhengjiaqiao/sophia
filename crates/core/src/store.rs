//! JSON 持久化：projects.json、settings.json，整文件原子写（先写 .tmp 再 rename）
use crate::{codex_models::settings::GatewaySettings, mcp::McpAutoImportRule, models::AutoLink};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 应用设置：被用户关掉的 harness id、手动添加的本体位置、自动同步规则
/// 容器级 `default` 让旧格式（缺字段）照样能读
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub disabled_harnesses: Vec<String>,
    pub manual_sources: Vec<PathBuf>,
    pub auto_links: Vec<AutoLink>,
    pub mcp_auto_imports: Vec<McpAutoImportRule>,
    pub codex_gateway: GatewaySettings,
    /// 被用户忽略的待处理问题；旧文件没有这个字段
    #[serde(default)]
    pub ignored: Vec<IgnoredIssue>,
}

/// 待处理栏里四类需要用户拿主意的问题；待处理页按它分动作，一类一种动作
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

/// 忽略的是"这一条具体状况"而不是某个 skill：涉及的位置一变，key 就变，界面自然重新提示
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredIssue {
    pub kind: IssueKind,
    pub key: String,
    /// 忽略时间，RFC 3339 的 UTC 写法，可直接按字典序排
    pub at: String,
}

/// key 内部的分隔符：Unit Separator，路径里不会出现
const KEY_SEP: char = '\u{1f}';

impl IgnoredIssue {
    /// 现在忽略这一条
    pub fn new(kind: IssueKind, paths: &[PathBuf]) -> Self {
        Self {
            kind,
            key: Self::key_for(kind, paths),
            at: now_rfc3339(),
        }
    }

    /// 类别 + 全部路径（规范化后排序）拼成的 key。
    /// 排序是为了让路径的先后顺序不影响结果；不取摘要，直接留可读的路径串，
    /// 这样 settings.json 里的记录能看懂，也不依赖任何跨版本不保证稳定的 hash。
    pub fn key_for(kind: IssueKind, paths: &[PathBuf]) -> String {
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

    pub fn load_settings(&self) -> io::Result<Settings> {
        load_json(&self.dir.join("settings.json"))
    }

    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        save_json(&self.dir.join("settings.json"), settings)
    }

    /// 记下一条忽略；同一个 key 已经在里面就保持原样（不刷新 at）
    pub fn ignore(&self, issue: IgnoredIssue) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings.ignored.iter().any(|i| i.key == issue.key) {
            return Ok(());
        }
        settings.ignored.push(issue);
        self.save_settings(&settings)
    }

    /// 恢复提示；key 不在里面就什么都不做
    pub fn unignore(&self, key: &str) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        let before = settings.ignored.len();
        settings.ignored.retain(|i| i.key != key);
        if settings.ignored.len() == before {
            return Ok(());
        }
        self.save_settings(&settings)
    }

    pub fn is_ignored(&self, key: &str) -> io::Result<bool> {
        Ok(self.load_settings()?.ignored.iter().any(|i| i.key == key))
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
            manual_sources: vec![PathBuf::from("/a/skills")],
            auto_links: vec![AutoLink {
                source: PathBuf::from("/a/skills"),
                targets: vec!["claude-code".into()],
                excluded: ["x".to_string()].into_iter().collect(),
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
            }],
            codex_gateway: GatewaySettings::default(),
            ignored: vec![IgnoredIssue::new(
                IssueKind::BrokenLink,
                &[PathBuf::from("/a/skills/x")],
            )],
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

    #[test]
    fn settings_without_ignored_still_loads() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"manualSources":["/a/skills"]}"#,
        )
        .unwrap();
        let loaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["codex".to_string()]);
        assert_eq!(loaded.ignored, Vec::<IgnoredIssue>::new());
    }

    #[test]
    fn key_ignores_path_order() {
        let a = PathBuf::from("/a/skills/x");
        let b = PathBuf::from("/b/skills/x");
        assert_eq!(
            IgnoredIssue::key_for(IssueKind::DuplicateSource, &[a.clone(), b.clone()]),
            IgnoredIssue::key_for(IssueKind::DuplicateSource, &[b, a])
        );
    }

    #[test]
    fn key_changes_when_any_path_changes() {
        let base = [PathBuf::from("/a/skills/x"), PathBuf::from("/b/skills/x")];
        let moved = [PathBuf::from("/a/skills/x"), PathBuf::from("/c/skills/x")];
        assert_ne!(
            IgnoredIssue::key_for(IssueKind::DuplicateSource, &base),
            IgnoredIssue::key_for(IssueKind::DuplicateSource, &moved)
        );
        // 多一个位置也算变化
        let more = [
            PathBuf::from("/a/skills/x"),
            PathBuf::from("/b/skills/x"),
            PathBuf::from("/c/skills/x"),
        ];
        assert_ne!(
            IgnoredIssue::key_for(IssueKind::DuplicateSource, &base),
            IgnoredIssue::key_for(IssueKind::DuplicateSource, &more)
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
        let keys: std::collections::BTreeSet<String> = kinds
            .iter()
            .map(|k| IgnoredIssue::key_for(*k, &paths))
            .collect();
        assert_eq!(keys.len(), kinds.len(), "{keys:?}");
        // ./ 与 .. 只是写法差异，不该算成另一条状况
        assert_eq!(
            IgnoredIssue::key_for(IssueKind::BrokenLink, &paths),
            IgnoredIssue::key_for(
                IssueKind::BrokenLink,
                &[PathBuf::from("/a/./b/../skills/x")]
            )
        );
    }

    #[test]
    fn ignore_unignore_round_trip() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir);
        let issue = IgnoredIssue::new(IssueKind::BrokenLink, &[PathBuf::from("/a/skills/x")]);
        let key = issue.key.clone();

        assert!(!s.is_ignored(&key).unwrap());
        s.ignore(issue.clone()).unwrap();
        assert!(s.is_ignored(&key).unwrap());
        // 重复忽略不会写进第二条
        s.ignore(issue.clone()).unwrap();
        assert_eq!(s.load_settings().unwrap().ignored, vec![issue]);

        s.unignore(&key).unwrap();
        assert!(!s.is_ignored(&key).unwrap());
        // 不存在的 key 也不报错
        s.unignore(&key).unwrap();
    }

    #[test]
    fn ignored_survives_a_save_load_round_trip() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir);
        let issue = IgnoredIssue::new(
            IssueKind::DuplicateSource,
            &[PathBuf::from("/b/skills/x"), PathBuf::from("/a/skills/x")],
        );
        s.ignore(issue.clone()).unwrap();
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.ignored, vec![issue]);
        assert_eq!(
            loaded.ignored[0].key,
            IgnoredIssue::key_for(
                IssueKind::DuplicateSource,
                &[PathBuf::from("/a/skills/x"), PathBuf::from("/b/skills/x")]
            )
        );
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
        let at = IgnoredIssue::new(IssueKind::BrokenLink, &[]).at;
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
        let key = IgnoredIssue::key_for(
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

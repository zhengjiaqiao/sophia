//! JSON 持久化：projects.json、settings.json，整文件原子写（先写 .tmp 再 rename）
use crate::{
    codex_models::settings::GatewaySettings,
    mcp::{sources::McpSubscriptions, McpAutoImportRule, McpOverview},
    models::{AutoLink, Source, Target},
    subscriptions::Subscriptions,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

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
    /// 手动项目加入 Sophia 的时间：规范化路径 → 毫秒时间戳。侧栏「最近创建」在取不到文件夹
    /// 创建时间时用它；旧文件没有这个字段，旧项目也就没有记录（回退到文件夹修改时间）
    pub project_added_at: BTreeMap<String, u64>,
    /// 每个位置订阅了哪些来源：域 key（`global` / `project:<路径>`）→ 来源路径（normalize 后）。
    /// 旧文件没有这个字段，读成空；第一次扫描由 `subscriptions::adopt` 按老数据补上
    pub subscriptions: Subscriptions,
    /// 每个位置订阅了哪些 MCP 来源：域 key → 来源位置 id（`McpLocation.id`）。
    /// 旧文件没有这个字段，读成空；扫描时由 `mcp::sources::adopt` 按老数据补上
    pub mcp_subscriptions: McpSubscriptions,
    /// 看过的新手提示 id（关掉或学会的那几条，前端 `src/hints.ts` 登记）。
    /// 旧文件没有这个字段，读成空：每条提示都还没看过
    pub seen_hints: Vec<String>,
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

    /// 读设置；旧文件里已删功能留下的字段（`seenIssues`、`ignored`）读时忽略
    pub fn load_settings(&self) -> io::Result<Settings> {
        load_json(&self.dir.join("settings.json"))
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

    /// 读设置，顺手把此刻有软链的来源写进各位置的订阅记录（见 `subscriptions::adopt`；
    /// 第一次扫描时认领老数据），改过才写回。要发现结果才能认领，所以只在发现之后用
    pub fn load_settings_adopting_subscriptions(
        &self,
        sources: &[Source],
        targets: &[Target],
    ) -> io::Result<Settings> {
        let mut settings = self.load_settings()?;
        let legacy = settings.manual_sources.clone();
        if crate::subscriptions::adopt(&mut settings.subscriptions, sources, targets, &legacy) {
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

    /// 读设置，顺手把老数据里已经写进各位置的 MCP 来源记进订阅（见 `mcp::sources::adopt`），
    /// 改过才写回。要扫描结果才能认领，所以只在 MCP 扫描之后用；规则先迁移再认领
    pub fn load_settings_adopting_mcp_subscriptions(
        &self,
        overview: &McpOverview,
    ) -> io::Result<Settings> {
        let mut settings = self.load_settings_migrating_mcp_auto_imports(overview)?;
        if crate::mcp::sources::adopt(
            &mut settings.mcp_subscriptions,
            overview,
            &settings.mcp_auto_imports,
        ) {
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

    /// 记下手动项目加入的时间（毫秒）；已有记录不覆盖——移除前再加一次不算新加入
    pub fn mark_project_added(&self, path: &Path, at_ms: u64) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        let key = project_key(path);
        if settings.project_added_at.contains_key(&key) {
            return Ok(());
        }
        settings.project_added_at.insert(key, at_ms);
        self.save_settings(&settings)
    }

    /// 移除手动项目时一并忘掉它的加入时间；本来就没有记录时不写盘
    pub fn forget_project_added(&self, path: &Path) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings
            .project_added_at
            .remove(&project_key(path))
            .is_none()
        {
            return Ok(());
        }
        self.save_settings(&settings)
    }

    /// 看过的新手提示 id，按记下的先后
    pub fn seen_hints(&self) -> io::Result<Vec<String>> {
        Ok(self.load_settings()?.seen_hints)
    }

    /// 记下一条看过的新手提示；已记过或空串不写盘
    pub fn mark_hint_seen(&self, id: &str) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if id.is_empty() || settings.seen_hints.iter().any(|x| x == id) {
            return Ok(());
        }
        settings.seen_hints.push(id.to_string());
        self.save_settings(&settings)
    }

    /// 清空看过的新手提示（设置 › 重新显示新手提示）；本来就空时不写盘
    pub fn reset_seen_hints(&self) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings.seen_hints.is_empty() {
            return Ok(());
        }
        settings.seen_hints.clear();
        self.save_settings(&settings)
    }
}

/// `project_added_at` 的 key：规范化后的路径文本
fn project_key(path: &Path) -> String {
    crate::fs::normalize(path).to_string_lossy().into_owned()
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
                target_excluded: [(
                    "claude-code".to_string(),
                    ["x".to_string()].into_iter().collect(),
                )]
                .into_iter()
                .collect(),
                baseline: Some(["y".to_string()].into_iter().collect()),
                target_baselines: [("codex".to_string(), ["z".to_string()].into_iter().collect())]
                    .into_iter()
                    .collect(),
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
                target_excluded: [(
                    "target".to_string(),
                    ["private".to_string()].into_iter().collect(),
                )]
                .into_iter()
                .collect(),
                allow_cross_domain: true,
                baseline: Some(["docs".to_string()].into_iter().collect()),
                target_baselines: [(
                    "target".to_string(),
                    ["web".to_string()].into_iter().collect(),
                )]
                .into_iter()
                .collect(),
            }],
            codex_gateway: GatewaySettings::default(),
            project_added_at: [("/a".to_string(), 1_700_000_000_000)]
                .into_iter()
                .collect(),
            subscriptions: [(
                "project:/p".to_string(),
                [PathBuf::from("/a/skills")].into_iter().collect(),
            )]
            .into_iter()
            .collect(),
            mcp_subscriptions: [(
                "project:/p".to_string(),
                ["claude-code".to_string()].into_iter().collect(),
            )]
            .into_iter()
            .collect(),
            seen_hints: vec!["first-scan-skills".into()],
        };
        s.save_settings(&settings).unwrap();
        assert_eq!(s.load_settings().unwrap(), settings);
        assert!(!dir.join("settings.json.tmp").exists());
    }

    #[test]
    fn project_added_at_is_kept_once_and_forgotten_on_remove() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        s.mark_project_added(Path::new("/w/app/"), 10).unwrap();
        // 再加一次不覆盖最初的时间；路径按规范化后比较
        s.mark_project_added(Path::new("/w/app"), 20).unwrap();
        assert_eq!(
            s.load_settings().unwrap().project_added_at.get("/w/app"),
            Some(&10)
        );
        s.forget_project_added(Path::new("/w/./app")).unwrap();
        assert!(s.load_settings().unwrap().project_added_at.is_empty());
        // 旧文件没有这个字段：读成空表
        std::fs::write(t.root().join("data/SymSync/settings.json"), "{}").unwrap();
        assert!(s.load_settings().unwrap().project_added_at.is_empty());
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
        // 订阅记录是后加的：旧文件读成空，等第一次扫描认领
        assert!(loaded.subscriptions.is_empty());
        assert!(loaded.mcp_subscriptions.is_empty());
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

    /// 升级前的整条 `excluded`：读进来按「对当时的所有目标都生效」拆到各目标，展开结果与
    /// 升级前一样；写回只有新结构，再读回不变
    #[test]
    fn legacy_rule_wide_excluded_migrates_per_target_and_round_trips() {
        use crate::models::TargetScope;
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let store_dir = t.dir("store");
        t.dir("store/a");
        let claude = t.dir("home/.claude/skills");
        let proj = t.dir("proj");
        let proj_codex = t.dir("proj/.codex/skills");
        let global = Target {
            id: "claude-code".into(),
            label: "claude-code".into(),
            path: claude.clone(),
            scope: TargetScope::Global {
                harness_id: "claude-code".into(),
            },
            exists: true,
            linked_whole_to: None,
        };
        let project = Target {
            id: format!("project:{}::codex", proj.display()),
            label: "codex".into(),
            path: proj_codex.clone(),
            scope: TargetScope::Project {
                project: proj.clone(),
                harness_id: "codex".into(),
                project_label: None,
            },
            exists: true,
            linked_whole_to: None,
        };
        let targets = vec![global.clone(), project.clone()];
        std::fs::create_dir_all(&dir).unwrap();
        let old = serde_json::json!({
            "autoLinks": [{
                "source": store_dir,
                "targets": [global.id, project.id],
                "excluded": ["x"],
                "baseline": ["a"]
            }]
        });
        std::fs::write(dir.join("settings.json"), old.to_string()).unwrap();
        // 建规则之后出现的 x（被排除）与 y
        t.dir("store/x");
        t.dir("store/y");

        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        let rule = &loaded.auto_links[0];
        assert!(rule.is_excluded(&global.id, "x"));
        assert!(rule.is_excluded(&project.id, "x"));
        // 行为不变：x 两处都不补，y 两处都补
        let env = crate::discovery::Env {
            home: t.dir("home"),
            vars: Default::default(),
        };
        let sources = crate::discovery::sources(&env, &[], &[], std::slice::from_ref(&store_dir));
        let cells = crate::skills::auto_link_cells(&sources, &targets, &loaded.auto_links);
        let mut built: Vec<(String, PathBuf)> =
            crate::skills::propose_links(&sources, &targets, &cells)
                .into_iter()
                .map(|a| (a.item_name, a.target))
                .collect();
        built.sort();
        assert_eq!(
            built,
            vec![("y".to_string(), claude), ("y".to_string(), proj_codex)]
        );

        // 写回用新结构：没有 excluded，只有按目标的 targetExcluded
        s.save_settings(&loaded).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap())
                .unwrap();
        let written = &raw["autoLinks"][0];
        assert!(written.get("excluded").is_none());
        assert_eq!(
            written["targetExcluded"],
            serde_json::json!({ global.id.clone(): ["x"], project.id.clone(): ["x"] })
        );
        assert_eq!(s.load_settings().unwrap(), loaded);
    }

    /// 旧版写下的 settings.json 还带着已删功能的字段：「看过」表 `seenIssues`（新问题一次性提示，
    /// 2026-09-25 删）与更早的「忽略」表 `ignored`。照样能读；设置按类型整份写回，下次写盘时它们就不在了
    #[test]
    fn settings_with_removed_issue_fields_still_load_and_drop_on_save() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{
                "disabledHarnesses": ["codex"],
                "manualSources": ["/a/skills"],
                "seenIssues": [{"key": "brokenLink\u001f/a", "at": "2026-09-03T00:00:00Z"}],
                "ignored": [{"kind": "brokenLink", "key": "brokenLink\u001f/b", "at": "2026-09-01T00:00:00Z"}]
            }"#,
        )
        .unwrap();
        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["codex".to_string()]);
        assert_eq!(loaded.manual_sources, vec![PathBuf::from("/a/skills")]);

        s.save_settings(&loaded).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert!(raw.get("seenIssues").is_none(), "{raw}");
        assert!(raw.get("ignored").is_none(), "{raw}");
        assert_eq!(raw["disabledHarnesses"], serde_json::json!(["codex"]));
        assert_eq!(s.load_settings().unwrap(), loaded);
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

    /// 新手提示看过表：旧文件没有字段读成空；记一个去重、空串忽略；存盘字段名 `seenHints`；清空后为空
    #[test]
    fn seen_hints_mark_dedupe_and_reset() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"manualSources":["/a/skills"]}"#,
        )
        .unwrap();
        let s = Store::new(dir.clone());
        assert!(s.seen_hints().unwrap().is_empty());

        s.mark_hint_seen("first-scan-skills").unwrap();
        s.mark_hint_seen("first-codex").unwrap();
        s.mark_hint_seen("first-scan-skills").unwrap();
        s.mark_hint_seen("").unwrap();
        assert_eq!(
            s.seen_hints().unwrap(),
            vec!["first-scan-skills".to_string(), "first-codex".to_string()]
        );
        // 真实文件里是 camelCase 的 seenHints；别的字段原样留着
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            raw["seenHints"],
            serde_json::json!(["first-scan-skills", "first-codex"])
        );
        assert_eq!(raw["disabledHarnesses"], serde_json::json!(["codex"]));
        assert_eq!(raw["manualSources"], serde_json::json!(["/a/skills"]));

        s.reset_seen_hints().unwrap();
        assert!(s.seen_hints().unwrap().is_empty());
        let reread = s.load_settings().unwrap();
        assert_eq!(reread.disabled_harnesses, vec!["codex".to_string()]);
        // 清空后再记照常
        s.mark_hint_seen("first-scan-empty").unwrap();
        assert_eq!(s.seen_hints().unwrap(), vec!["first-scan-empty".to_string()]);
    }

    /// 没有 settings.json 时：读成空，空串不建文件，清空也不建文件
    #[test]
    fn seen_hints_without_settings_file() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        assert!(s.seen_hints().unwrap().is_empty());
        s.mark_hint_seen("").unwrap();
        s.reset_seen_hints().unwrap();
        assert!(!dir.join("settings.json").exists());
    }

    #[test]
    fn corrupt_file_is_an_error_not_silent_reset() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(dir.join("projects.json"), "{oops").unwrap();
        assert!(Store::new(dir).load_projects().is_err());
    }
}

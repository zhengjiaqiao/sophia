//! JSON 持久化：projects.json、settings.json、installs.json、usage-last.json、usage-schedule.json，整文件原子写（先写 .tmp 再 rename）
use crate::{
    claude_models::settings::ClaudeGatewaySettings,
    codex_models::settings::GatewaySettings,
    mcp::{sources::McpSubscriptions, McpAutoImportRule, McpOverview},
    models::{AutoLink, Source, Target},
    subscriptions::Subscriptions,
    usage::UsageSettings,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

/// 外观（spec 2026-09-30-language-and-theme R2）：跟随系统（默认）、浅色、深色。
/// 写盘为 `system` / `light` / `dark`；读到认不出的值当作跟随系统——一个字段写坏了不能连累整份设置读不出
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub enum Appearance {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "light")]
    Light,
    #[serde(rename = "dark")]
    Dark,
}

impl<'de> Deserialize<'de> for Appearance {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(d)?;
        Ok(match raw.as_str() {
            Some("light") => Appearance::Light,
            Some("dark") => Appearance::Dark,
            _ => Appearance::System,
        })
    }
}

/// 界面语言（spec 2026-09-30-language-and-theme R1 R2 R13）：跟随系统（默认）、简体、繁體、English。
/// 写盘为 `system` / `zh-Hans` / `zh-Hant` / `en`；读到认不出的值当作跟随系统（同 `Appearance`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub enum Language {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-Hans")]
    ZhHans,
    #[serde(rename = "zh-Hant")]
    ZhHant,
    #[serde(rename = "en")]
    En,
}

impl<'de> Deserialize<'de> for Language {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(d)?;
        Ok(match raw.as_str() {
            Some("zh-Hans") => Language::ZhHans,
            Some("zh-Hant") => Language::ZhHant,
            Some("en") => Language::En,
            _ => Language::System,
        })
    }
}

/// 应用设置：被用户关掉的 harness id、手动添加的本体位置、自动同步规则
/// 容器级 `default` 让旧格式（缺字段）照样能读
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Claude 那一份网关设置（spec 2026-09-29-claude-third-party-models R1）。旧文件没有这个字段，
    /// 读成空：没有网关、没打开；不从 Codex 那份迁移任何东西
    pub claude_gateway: ClaudeGatewaySettings,
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
    // ── 发现与安装（spec 2026-09-27-skill-mcp-market R14 / R15）──
    /// 设置 `skill 更新` 一节的 `自动检查 skill 更新`：默认开。旧文件没有这个字段，读成开
    pub auto_check_skill_updates: bool,
    /// 上次查 skill 更新的时刻（unix 秒）；从没查过为 None
    pub last_skill_update_check: Option<u64>,
    /// 更新提示条按 × 时记下的那一批新版本 tree SHA（`market::installs::dismissed_batch`）
    pub dismissed_update_shas: Vec<String>,
    /// 菜单栏与托盘用量显示的设置（R12）。旧文件没有这一节，读成 `UsageSettings::default()`
    /// （菜单栏显示关、剩余模式、刷新自动，见 `usage::model`）
    pub usage: UsageSettings,
    /// 外观：跟随系统 / 浅色 / 深色。旧文件没有这个字段，读成跟随系统
    pub appearance: Appearance,
    /// 界面语言：跟随系统 / 简体 / 繁體 / English。旧文件没有这个字段，读成跟随系统
    pub language: Language,
}

/// 手写而不派生：`auto_check_skill_updates` 默认是开。新加字段照原样往下补一行默认值
impl Default for Settings {
    fn default() -> Self {
        Self {
            disabled_harnesses: Vec::new(),
            known_installed: Vec::new(),
            manual_sources: Vec::new(),
            auto_links: Vec::new(),
            mcp_auto_imports: Vec::new(),
            codex_gateway: GatewaySettings::default(),
            claude_gateway: ClaudeGatewaySettings::default(),
            project_added_at: BTreeMap::new(),
            subscriptions: Subscriptions::default(),
            mcp_subscriptions: McpSubscriptions::default(),
            seen_hints: Vec::new(),
            auto_check_skill_updates: true,
            last_skill_update_check: None,
            dismissed_update_shas: Vec::new(),
            usage: UsageSettings::default(),
            appearance: Appearance::System,
            language: Language::System,
        }
    }
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 系统应用数据目录下的 `Sophia`：projects.json / settings.json 和后台程序副本都在里面
    pub fn default_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Sophia")
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

    /// 上一次成功的用量读数（R13）：重启后托盘先显示它，再去取新数。只存读数本身，没有账号标识
    pub fn load_usage_readings(&self) -> io::Result<Vec<crate::usage::Reading>> {
        load_json(&self.dir.join("usage-last.json"))
    }

    pub fn save_usage_readings(&self, readings: &[crate::usage::Reading]) -> io::Result<()> {
        save_json(&self.dir.join("usage-last.json"), &readings)
    }

    /// 用量调度的记忆（上次尝试、限流截止、连续被限流次数）：重启后接着用
    pub fn load_usage_memo(&self) -> io::Result<crate::usage::ScheduleMemo> {
        load_json(&self.dir.join("usage-schedule.json"))
    }

    pub fn save_usage_memo(&self, memo: &crate::usage::ScheduleMemo) -> io::Result<()> {
        save_json(&self.dir.join("usage-schedule.json"), memo)
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

    /// 自动同步执行完，记下各规则在各位置最近一次真正建上的链（见 `skills::record_auto_runs`）；
    /// 一格没建上就不写盘。`sources` / `targets` 要是产出这批动作的那次扫描
    pub fn record_auto_link_runs(
        &self,
        sources: &[Source],
        targets: &[Target],
        report: &crate::models::SyncReport,
        at_ms: u64,
    ) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if crate::skills::record_auto_runs(
            &mut settings.auto_links,
            sources,
            targets,
            report,
            at_ms,
        ) {
            self.save_settings(&settings)?;
        }
        Ok(())
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

    /// MCP 自动写入执行完，记下各规则最近一次真正写进去的（见 `mcp::record_auto_runs`）；
    /// 一项没写进去就不写盘。`actions` 是产出这批写入的计划动作
    pub fn record_mcp_auto_import_runs(
        &self,
        actions: &[crate::mcp::McpAction],
        report: &crate::mcp::McpReport,
        at_ms: u64,
    ) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if crate::mcp::record_auto_runs(&mut settings.mcp_auto_imports, actions, report, at_ms) {
            self.save_settings(&settings)?;
        }
        Ok(())
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
}

// ── 发现与安装（spec 2026-09-27-skill-mcp-market）──────────────────────────────
// 单独一段 impl，便于与别的分支在 `impl Store` 末尾追加的方法合并
impl Store {
    /// Sophia 装下的 skill 的来历（R12）：`installs.json`，不存在时为空
    pub fn load_installs(&self) -> io::Result<Vec<crate::market::InstallRecord>> {
        load_json(&self.dir.join("installs.json"))
    }

    pub fn save_installs(&self, records: &[crate::market::InstallRecord]) -> io::Result<()> {
        save_json(&self.dir.join("installs.json"), &records)
    }

    /// 设置外观；没变不写盘
    pub fn set_appearance(&self, value: Appearance) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings.appearance == value {
            return Ok(());
        }
        settings.appearance = value;
        self.save_settings(&settings)
    }

    /// 设置界面语言；没变不写盘
    pub fn set_language(&self, value: Language) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings.language == value {
            return Ok(());
        }
        settings.language = value;
        self.save_settings(&settings)
    }

    /// 设置 `自动检查 skill 更新`（R14）
    pub fn set_auto_check_skill_updates(&self, enabled: bool) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings.auto_check_skill_updates == enabled {
            return Ok(());
        }
        settings.auto_check_skill_updates = enabled;
        self.save_settings(&settings)
    }

    /// 记下这一次查更新的时刻（unix 秒）
    pub fn record_skill_update_check(&self, at: u64) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        settings.last_skill_update_check = Some(at);
        self.save_settings(&settings)
    }

    /// 提示条按 ×：整批替换记下的 tree SHA（R15）
    pub fn set_dismissed_update_shas(&self, shas: Vec<String>) -> io::Result<()> {
        let mut settings = self.load_settings()?;
        if settings.dismissed_update_shas == shas {
            return Ok(());
        }
        settings.dismissed_update_shas = shas;
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
    use crate::usage::{AgentDisplay, AgentId, DisplayMode, Refresh, StackedSize};

    #[test]
    fn missing_files_load_as_empty() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/Sophia"));
        assert_eq!(s.load_projects().unwrap(), Vec::<PathBuf>::new());
    }

    /// R13：上一次的用量读数存一份，重启后托盘立刻有数；没有文件读成空
    /// 调度记忆（上次尝试、限流截止、连续被限流次数）存一份，重启后不立刻起进程、不绕过限流退避
    #[test]
    fn usage_schedule_memo_round_trip_and_missing_is_empty() {
        use crate::usage::{ScheduleMemo, Source, SourceMemo};
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/Sophia"));
        assert_eq!(s.load_usage_memo().unwrap(), ScheduleMemo::default());
        let memo = ScheduleMemo {
            sources: vec![SourceMemo {
                agent: AgentId::ClaudeCode,
                source: Source::GetUsage,
                last_attempt: Some(1_790_000_000),
                rate_limited_until: Some(1_790_000_600),
            }],
            rate_limit_streaks: [(AgentId::ClaudeCode, 2)].into_iter().collect(),
        };
        s.save_usage_memo(&memo).unwrap();
        assert_eq!(s.load_usage_memo().unwrap(), memo);
        assert!(t.root().join("data/Sophia/usage-schedule.json").is_file());
    }

    #[test]
    fn usage_readings_round_trip_and_missing_is_empty() {
        use crate::usage::{Reading, Severity, Source, Window};
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/Sophia"));
        assert_eq!(s.load_usage_readings().unwrap(), Vec::<Reading>::new());
        let readings = vec![Reading {
            agent: AgentId::Codex,
            source: Source::AppServer,
            observed_at: 1_790_000_000,
            windows: vec![Window {
                key: "weekly".into(),
                kind: crate::usage::WindowKind::Weekly,
                used_percent: 57.0,
                resets_at: Some(1_790_578_639),
                window_minutes: Some(10080),
                severity: Severity::Normal,
                active: true,
            }],
            plan: Some("prolite".into()),
        }];
        s.save_usage_readings(&readings).unwrap();
        assert_eq!(s.load_usage_readings().unwrap(), readings);
        assert!(t.root().join("data/Sophia/usage-last.json").is_file());
    }

    /// 落盘写窗口名的种类，同时照旧写一句 label（旧版 App 还要读它）；旧文件（只有 label）能读，
    /// 认得出键就按当前语言重算，认不出才原样显示旧句；读取以 kind 为准
    #[test]
    fn usage_readings_store_window_kind_and_read_old_label_files() {
        use crate::usage::WindowKind;
        let t = TempTree::new();
        let dir = t.root().join("data/Sophia");
        std::fs::create_dir_all(&dir).unwrap();
        let old = r#"[{"agent":"codex","source":"appServer","observedAt":1790000000,"windows":[
            {"key":"session","label":"5 小时","usedPercent":10.0,"resetsAt":null,"windowMinutes":300,"severity":"normal","active":false},
            {"key":"weekly","label":"本周","usedPercent":20.0,"resetsAt":null,"windowMinutes":10080,"severity":"normal","active":false},
            {"key":"minutes:720","label":"12 小时","usedPercent":30.0,"resetsAt":null,"windowMinutes":720,"severity":"normal","active":false},
            {"key":"model:Spark","label":"本周 · Spark","usedPercent":40.0,"resetsAt":null,"windowMinutes":null,"severity":"normal","active":false},
            {"key":"model:Spark:300","label":"5 小时 · Spark","usedPercent":50.0,"resetsAt":null,"windowMinutes":300,"severity":"normal","active":false},
            {"key":"未来的键","label":"某个旧句","usedPercent":60.0,"resetsAt":null,"windowMinutes":null,"severity":"normal","active":false}
        ],"plan":"prolite"}]"#;
        std::fs::write(dir.join("usage-last.json"), old).unwrap();
        let s = Store::new(dir.clone());
        let readings = s.load_usage_readings().unwrap();
        let windows = &readings[0].windows;
        assert_eq!(
            windows.iter().map(|w| w.label()).collect::<Vec<_>>(),
            [
                "5 小时",
                "本周",
                "12 小时",
                "本周 · Spark",
                "5 小时 · Spark",
                "某个旧句"
            ],
            "旧文件显示照旧"
        );
        assert_eq!(windows[0].kind, WindowKind::Session);
        assert_eq!(
            windows[4].kind,
            WindowKind::ModelDuration {
                name: "Spark".into(),
                minutes: 300
            }
        );
        assert_eq!(
            windows[5].kind,
            WindowKind::Legacy {
                label: "某个旧句".into()
            },
            "键认不出：退回存下的句子"
        );

        // 再存一次：写 kind，同时照旧写一份当前语言的 label（旧版 App 读得到）；读回来一致
        s.save_usage_readings(&readings).unwrap();
        let text = std::fs::read_to_string(dir.join("usage-last.json")).unwrap();
        assert!(text.contains("\"type\": \"session\""), "{text}");
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        let labels: Vec<_> = json[0]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["label"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            labels,
            [
                "5 小时",
                "本周",
                "12 小时",
                "本周 · Spark",
                "5 小时 · Spark",
                "某个旧句"
            ]
        );
        assert_eq!(s.load_usage_readings().unwrap(), readings);

        // 以 kind 为准：label 与 kind 不一致时用 kind
        let mut edited = json.clone();
        edited[0]["windows"][0]["label"] = serde_json::json!("别的句子");
        std::fs::write(dir.join("usage-last.json"), edited.to_string()).unwrap();
        assert_eq!(s.load_usage_readings().unwrap(), readings);
    }

    #[test]
    fn projects_round_trip_and_overwrite_atomically() {
        let t = TempTree::new();
        let dir = t.root().join("data/Sophia");
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
        let dir = t.root().join("data/Sophia");
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
                last_auto: [(
                    "global".to_string(),
                    crate::models::AutoRun {
                        at: 1_700_000_000_000,
                        added: 2,
                    },
                )]
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
                last_auto: Some(crate::models::AutoRun {
                    at: 1_700_000_000_000,
                    added: 1,
                }),
            }],
            codex_gateway: GatewaySettings::default(),
            claude_gateway: ClaudeGatewaySettings::default(),
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
            auto_check_skill_updates: false,
            last_skill_update_check: Some(1_700_000_000),
            dismissed_update_shas: vec!["abc".into()],
            usage: UsageSettings {
                menu_bar_enabled: true,
                display_mode: DisplayMode::Used,
                agents: Some(vec![AgentId::ClaudeCode, AgentId::Codex]),
                per_agent: [(
                    AgentId::ClaudeCode,
                    AgentDisplay {
                        primary: Some("weekly".to_string()),
                        secondary: Some("session".to_string()),
                        stacked: true,
                        stacked_size: StackedSize::Medium,
                    },
                )]
                .into_iter()
                .collect(),
                refresh: Refresh::Every5,
            },
            appearance: Appearance::Dark,
            language: Language::ZhHant,
        };
        s.save_settings(&settings).unwrap();
        assert_eq!(s.load_settings().unwrap(), settings);
        assert!(!dir.join("settings.json.tmp").exists());
    }

    /// 叠放跟着每个 agent 走；2026-09-29 短暂存在过的顶层 `stacked / stackedSize` 读时忽略
    #[test]
    fn top_level_stacking_fields_are_ignored() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"usage":{"menuBarEnabled":true,"stacked":true,"stackedSize":"large","perAgent":{"claude-code":{"primary":"session","secondary":"weekly","stacked":true,"stackedSize":"medium"}}}}"#,
        )
        .unwrap();
        let usage = Store::new(dir).load_settings().unwrap().usage;
        assert!(usage.menu_bar_enabled);
        assert_eq!(
            usage.per_agent[&AgentId::ClaudeCode],
            AgentDisplay {
                primary: Some("session".into()),
                secondary: Some("weekly".into()),
                stacked: true,
                stacked_size: StackedSize::Medium,
            }
        );
    }

    /// R12/AC27：老 `settings.json` 里没有 `usage` 这一节时，取默认值；文件其余内容照旧读出来，
    /// 不受影响
    #[test]
    fn settings_without_usage_section_loads_defaults_and_keeps_other_fields() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"manualSources":["/a/skills"]}"#,
        )
        .unwrap();
        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.usage, UsageSettings::default());
        assert_eq!(loaded.disabled_harnesses, vec!["codex".to_string()]);
        assert_eq!(loaded.manual_sources, vec![PathBuf::from("/a/skills")]);

        // 改一项用量设置后重启（重新用 Store 读取）：保持，其余字段不受影响
        let mut changed = loaded.clone();
        changed.usage.menu_bar_enabled = true;
        changed.usage.refresh = Refresh::Every1;
        s.save_settings(&changed).unwrap();
        let reloaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(reloaded, changed);
        assert!(reloaded.usage.menu_bar_enabled);
        assert_eq!(reloaded.usage.refresh, Refresh::Every1);
        assert_eq!(reloaded.disabled_harnesses, vec!["codex".to_string()]);
        assert_eq!(reloaded.manual_sources, vec![PathBuf::from("/a/skills")]);
    }

    #[test]
    fn project_added_at_is_kept_once_and_forgotten_on_remove() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/Sophia"));
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
        std::fs::write(t.root().join("data/Sophia/settings.json"), "{}").unwrap();
        assert!(s.load_settings().unwrap().project_added_at.is_empty());
    }

    #[test]
    fn settings_without_manual_sources_or_auto_links_still_loads() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("settings.json"), r#"{"disabledHarnesses":[]}"#).unwrap();
        let loaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(loaded.manual_sources, Vec::<PathBuf>::new());
        assert_eq!(loaded.auto_links, Vec::<AutoLink>::new());
        assert_eq!(loaded.mcp_auto_imports, Vec::<McpAutoImportRule>::new());
        // 订阅记录是后加的：旧文件读成空，等第一次扫描认领
        assert!(loaded.subscriptions.is_empty());
        assert!(loaded.mcp_subscriptions.is_empty());
    }

    /// 旧 settings.json 的规则没有 `lastAuto`：照常读；自动执行建上了链才写回记录，
    /// 一格没建上不写盘、不动上一次
    #[test]
    fn auto_link_runs_are_recorded_into_legacy_settings() {
        use crate::models::{LinkStyle, SyncReport, TargetScope};
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let store_dir = t.dir("store");
        let claude = t.dir("home/.claude/skills");
        let file = dir.join("settings.json");
        std::fs::write(
            &file,
            serde_json::json!({"autoLinks": [
                {"source": store_dir, "targets": ["claude-code"], "baseline": []}
            ]})
            .to_string(),
        )
        .unwrap();
        let s = Store::new(dir);
        let loaded = s.load_settings().unwrap();
        assert!(loaded.auto_links[0].last_auto.is_empty());

        // 建规则之后来源里出现了 a：自动执行真的把它链进 claude
        t.skill("store/a");
        let env = crate::discovery::Env {
            home: t.dir("home"),
            vars: Default::default(),
        };
        let sources = crate::discovery::sources(&env, &[], &[], std::slice::from_ref(&store_dir));
        let targets = vec![Target {
            id: "claude-code".into(),
            label: "Claude Code".into(),
            path: claude.clone(),
            scope: TargetScope::Global {
                harness_id: "claude-code".into(),
            },
            exists: true,
            linked_whole_to: None,
        }];
        let cells = crate::skills::auto_link_cells(&sources, &targets, &loaded.auto_links);
        let actions = crate::skills::propose_links(&sources, &targets, &cells);
        let report = crate::sync::execute(&actions, false, LinkStyle::Absolute);
        assert!(matches!(
            crate::fs::entry_kind(&claude.join("a")),
            crate::fs::EntryKind::Symlink(_)
        ));
        s.record_auto_link_runs(&sources, &targets, &report, 42)
            .unwrap();
        let ran = crate::models::AutoRun { at: 42, added: 1 };
        assert_eq!(
            s.load_settings().unwrap().auto_links[0]
                .last_auto
                .get("global"),
            Some(&ran)
        );
        let written = std::fs::read_to_string(&file).unwrap();
        let raw: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(
            raw["autoLinks"][0]["lastAuto"],
            serde_json::json!({"global": {"at": 42, "added": 1}})
        );
        // 空的一轮：不写盘，记录不变
        s.record_auto_link_runs(&sources, &targets, &SyncReport::default(), 99)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), written);
    }

    /// 升级前写下的 settings.json：两类规则都没有 baseline。
    /// 首次扫描后读设置即迁移成当前全部名字并写回，旧规则从此不再补建现有的
    #[test]
    fn rules_persisted_without_baseline_migrate_on_first_scanned_load() {
        let t = TempTree::new();
        let dir = t.root().join("data/Sophia");
        let store_dir = t.dir("store");
        t.skill("store/a");
        t.skill("store/b");
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
        t.skill("store/c");
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
        let dir = t.root().join("data/Sophia");
        let store_dir = t.dir("store");
        t.skill("store/a");
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
        t.skill("store/x");
        t.skill("store/y");

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
        let dir = t.dir("data/Sophia");
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
        let dir = t.dir("data/Sophia");
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

    /// 这个分支早先的构建按两组写过设置（`mcpDisabledHarnesses`、`mcpKnownInstalled`）：
    /// 改回一份名单后照样能读，这两个字段忽略，下次写盘时消失（spec 2026-09-27-mcp-batch1 R7）
    #[test]
    fn settings_with_the_old_mcp_group_still_load() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["cline"],"knownInstalled":["claude-code","cline"],
                "mcpDisabledHarnesses":["claude-desktop"],"mcpKnownInstalled":["claude-code","claude-desktop"]}"#,
        )
        .unwrap();
        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["cline".to_string()]);
        assert_eq!(
            loaded.known_installed,
            vec!["claude-code".to_string(), "cline".to_string()]
        );
        s.save_settings(&loaded).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert!(raw.get("mcpDisabledHarnesses").is_none(), "{raw}");
        assert!(raw.get("mcpKnownInstalled").is_none(), "{raw}");
        assert_eq!(s.load_settings().unwrap(), loaded);
    }

    /// 新手提示看过表：旧文件没有字段读成空；记一个去重、空串忽略；存盘字段名 `seenHints`；清空后为空
    #[test]
    fn seen_hints_mark_dedupe() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
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
    }

    /// 没有 settings.json 时：读成空，空串不建文件
    #[test]
    fn seen_hints_without_settings_file() {
        let t = TempTree::new();
        let dir = t.root().join("data/Sophia");
        let s = Store::new(dir.clone());
        assert!(s.seen_hints().unwrap().is_empty());
        s.mark_hint_seen("").unwrap();
        assert!(!dir.join("settings.json").exists());
    }

    /// 发现与安装加的设置字段：旧文件没有，读成默认（自动检查开、没查过、没关过提示条）；
    /// 没有 settings.json 时同样默认开；三个 setter 写盘后读回一致、别的字段不动
    #[test]
    fn skill_update_settings_default_on_for_old_files_and_round_trip() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        assert!(s.load_settings().unwrap().auto_check_skill_updates);

        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"seenHints":["x"]}"#,
        )
        .unwrap();
        let loaded = s.load_settings().unwrap();
        assert!(loaded.auto_check_skill_updates);
        assert_eq!(loaded.last_skill_update_check, None);
        assert!(loaded.dismissed_update_shas.is_empty());

        s.set_auto_check_skill_updates(false).unwrap();
        s.record_skill_update_check(1_700_000_123).unwrap();
        s.set_dismissed_update_shas(vec!["t1".into(), "t2".into()])
            .unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(raw["autoCheckSkillUpdates"], serde_json::json!(false));
        assert_eq!(
            raw["lastSkillUpdateCheck"],
            serde_json::json!(1_700_000_123)
        );
        assert_eq!(raw["dismissedUpdateShas"], serde_json::json!(["t1", "t2"]));
        assert_eq!(raw["disabledHarnesses"], serde_json::json!(["codex"]));
        let reread = s.load_settings().unwrap();
        assert!(!reread.auto_check_skill_updates);
        assert_eq!(reread.seen_hints, vec!["x".to_string()]);
    }

    /// 外观（spec 2026-09-30-language-and-theme R2）：旧文件没有这个字段、没有 settings.json、
    /// 写了认不出的值，都读成「跟随系统」且不连累别的字段；三个值写盘为 system / light / dark，读回一致
    #[test]
    fn appearance_defaults_to_system_tolerates_unknown_and_round_trips() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        assert_eq!(s.load_settings().unwrap().appearance, Appearance::System);

        std::fs::write(dir.join("settings.json"), r#"{"seenHints":["x"]}"#).unwrap();
        assert_eq!(s.load_settings().unwrap().appearance, Appearance::System);

        std::fs::write(
            dir.join("settings.json"),
            r#"{"appearance":"sepia","seenHints":["x"]}"#,
        )
        .unwrap();
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.appearance, Appearance::System);
        assert_eq!(loaded.seen_hints, vec!["x".to_string()]);

        for (value, raw) in [
            (Appearance::Dark, "dark"),
            (Appearance::Light, "light"),
            (Appearance::System, "system"),
        ] {
            s.set_appearance(value).unwrap();
            let json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
            assert_eq!(json["appearance"], serde_json::json!(raw));
            assert_eq!(json["seenHints"], serde_json::json!(["x"]));
            assert_eq!(s.load_settings().unwrap().appearance, value);
        }
    }

    /// 界面语言（spec 2026-09-30-language-and-theme R2、AC2）：旧文件没有这个字段、没有 settings.json、
    /// 写了认不出的值，都读成「跟随系统」且不连累别的字段；四个值写盘为 system / zh-Hans / zh-Hant / en，读回一致
    #[test]
    fn language_defaults_to_system_tolerates_unknown_and_round_trips() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        assert_eq!(s.load_settings().unwrap().language, Language::System);

        std::fs::write(dir.join("settings.json"), r#"{"seenHints":["x"]}"#).unwrap();
        assert_eq!(s.load_settings().unwrap().language, Language::System);

        std::fs::write(
            dir.join("settings.json"),
            r#"{"language":"fr","seenHints":["x"]}"#,
        )
        .unwrap();
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.language, Language::System);
        assert_eq!(loaded.seen_hints, vec!["x".to_string()]);

        for (value, raw) in [
            (Language::En, "en"),
            (Language::ZhHant, "zh-Hant"),
            (Language::ZhHans, "zh-Hans"),
            (Language::System, "system"),
        ] {
            s.set_language(value).unwrap();
            let json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
            assert_eq!(json["language"], serde_json::json!(raw));
            assert_eq!(json["seenHints"], serde_json::json!(["x"]));
            assert_eq!(s.load_settings().unwrap().language, value);
        }
    }

    /// installs.json：不存在读成空；写了读回一致，字段 camelCase，不留 .tmp
    #[test]
    fn installs_round_trip() {
        use crate::market::InstallRecord;
        let t = TempTree::new();
        let dir = t.root().join("data/Sophia");
        let s = Store::new(dir.clone());
        assert!(s.load_installs().unwrap().is_empty());
        let records = vec![InstallRecord {
            name: "pdf".into(),
            location: "global".into(),
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            path: "skills/pdf".into(),
            tree_sha: "1111111111111111111111111111111111111111".into(),
            commit_sha: "2222222222222222222222222222222222222222".into(),
            installed_at: 1_700_000_000,
        }];
        s.save_installs(&records).unwrap();
        assert_eq!(s.load_installs().unwrap(), records);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("installs.json")).unwrap()).unwrap();
        assert_eq!(raw[0]["treeSha"], serde_json::json!(records[0].tree_sha));
        assert!(!dir.join("installs.json.tmp").exists());
    }

    #[test]
    fn corrupt_file_is_an_error_not_silent_reset() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("projects.json"), "{oops").unwrap();
        assert!(Store::new(dir).load_projects().is_err());
    }
}

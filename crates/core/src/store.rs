//! JSON 持久化：projects.json、settings.json、installs.json、copies.json、usage-last.json、usage-schedule.json，整文件原子写（先写 .tmp 再 rename）
use crate::{
    claude_models::settings::ClaudeGatewaySettings,
    codex_models::settings::GatewaySettings,
    mcp::{sources::McpSubscriptions, McpAutoImportRule, McpOverview},
    model_providers::ModelProviders,
    models::{AutoLink, Source, Target},
    subscriptions::Subscriptions,
    usage::UsageSettings,
    workbuddy_models::WorkBuddyGatewaySettings,
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

/// 本程序写的 settings.json 格式版本；读到更高的版本时只读不写（spec S7）。旧文件没有这个字段，按 1 读
pub const SETTINGS_VERSION: u64 = 1;

/// 应用设置：被用户关掉的 harness id、手动添加的本体位置、自动同步规则
/// 容器级 `default` 让旧格式（缺字段）照样能读
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 格式版本（见 [`SETTINGS_VERSION`]）。更新版本的 Sophia 写的文件：读得出、拒绝写回
    pub version: u64,
    /// 不显示名单：不在列表里显示的品牌 id（#251 起按品牌；见 `discovery::reconcile_shown`）
    pub disabled_harnesses: Vec<String>,
    /// 上次整理显示名单时已安装的品牌 id（#251 起按品牌）。不在其中的已安装品牌算新装的——
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
    /// WorkBuddy 那一份（#266）：只有开关。旧文件没有这一节，读成关着
    pub workbuddy_gateway: WorkBuddyGatewaySettings,
    /// 手动项目加入 Sophia 的时间：规范化路径 → 毫秒时间戳。侧栏「最近创建」在取不到文件夹
    /// 创建时间时用它；旧文件没有这个字段，旧项目也就没有记录（回退到文件夹修改时间）
    pub project_added_at: BTreeMap<String, u64>,
    /// 设置「生效范围」里取消勾的项目（真实路径，见 `discovery::set_project_shown`）：不出现在筛选行、「切换项目…」浮层里，也不扫描；
    /// 已建好的链接原样留着。按 `real_path` 认同一处（见 `discovery::shown_projects`）。
    /// 文件夹暂时不在（外接盘没插）也不清掉这条，回来了仍不显示。旧文件没有这个字段，读成空：全部勾着
    pub hidden_projects: Vec<PathBuf>,
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
    // ── 自动上报（spec 2026-10-04-reporting-feedback R5、R6）──
    /// 设置「关于」里的 `使用统计和错误报告`：默认开。旧文件没有这个字段，读成开
    pub auto_report: bool,
    /// 安装 ID（随机 UUID v4）：开着时第一次上报前生成；关掉时删掉（写盘时连键都不留），再打开换新的
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
    // ── 开机启动（spec 2026-10-05-keep-running R1）──
    /// 第一次打开时已经默认注册过登录项：只做一次，之后以系统为准。旧文件没有这个字段，读成没做过
    pub autostart_defaulted: bool,
    /// 全局模型提供商名单（ADR 0003，#252）：所有 agent 共用。旧文件没有这个字段，读成空；
    /// 旧版按 agent 存的网关（`codexGateway` / `claudeGateway` 里的 `providers`）不迁移过来
    pub model_providers: ModelProviders,
}

/// 手写而不派生：`auto_check_skill_updates` 默认是开。新加字段照原样往下补一行默认值
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            disabled_harnesses: Vec::new(),
            known_installed: Vec::new(),
            manual_sources: Vec::new(),
            auto_links: Vec::new(),
            mcp_auto_imports: Vec::new(),
            codex_gateway: GatewaySettings::default(),
            claude_gateway: ClaudeGatewaySettings::default(),
            workbuddy_gateway: WorkBuddyGatewaySettings::default(),
            project_added_at: BTreeMap::new(),
            hidden_projects: Vec::new(),
            subscriptions: Subscriptions::default(),
            mcp_subscriptions: McpSubscriptions::default(),
            seen_hints: Vec::new(),
            auto_check_skill_updates: true,
            last_skill_update_check: None,
            dismissed_update_shas: Vec::new(),
            usage: UsageSettings::default(),
            appearance: Appearance::System,
            language: Language::System,
            auto_report: true,
            install_id: None,
            autostart_defaulted: false,
            model_providers: ModelProviders::default(),
        }
    }
}

/// settings.json 读改写的锁（Codex 复审 1）：进程内只有一把，各处的 `Store` 共用；可重入——同一线程里
/// 套着拿（命令拿着它，再调本身也拿它的方法）不自锁。读 → 改 → 写全程拿着它；只读不用拿（写盘是先写临时文件再改名）。
/// 与配置写锁（`AppState.config_lock`）同时要时，先拿配置写锁再拿它
struct ReentrantLock {
    state: std::sync::Mutex<(Option<std::thread::ThreadId>, usize)>,
    released: std::sync::Condvar,
}

impl ReentrantLock {
    fn acquire(&self) {
        let me = std::thread::current().id();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            match state.0 {
                None => {
                    *state = (Some(me), 1);
                    return;
                }
                Some(owner) if owner == me => {
                    state.1 += 1;
                    return;
                }
                Some(_) => {
                    state = self.released.wait(state).unwrap_or_else(|p| p.into_inner());
                }
            }
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.1 = state.1.saturating_sub(1);
        if state.1 == 0 {
            state.0 = None;
            self.released.notify_all();
        }
    }
}

static SETTINGS_LOCK: ReentrantLock = ReentrantLock {
    state: std::sync::Mutex::new((None, 0)),
    released: std::sync::Condvar::new(),
};

/// 拿着 settings.json 读改写锁的凭据，离开作用域放手。只属于拿它的线程（不能跨 `.await` 持有）
#[must_use]
pub struct SettingsGuard(std::marker::PhantomData<*const ()>);

impl Drop for SettingsGuard {
    fn drop(&mut self) {
        SETTINGS_LOCK.release();
    }
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 系统应用数据目录下的 `Sophia`：projects.json / settings.json、后台程序副本和改写配置前的备份（`backups/`）都在里面
    pub fn default_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Sophia")
    }

    /// 数据目录本身
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 改写用户配置文件前的备份放这里：数据目录下的 `backups/`（布局见 `atomicfile::backup`）
    pub fn backups_dir(&self) -> PathBuf {
        self.dir.join(crate::atomicfile::BACKUPS_DIR)
    }

    /// 手动选的项目（设置「生效范围」的 `+ 项目`、应用菜单「添加项目…」）：一个路径数组，格式与旧版相同。
    /// 文件夹没了也不从文件里删（外接盘回来了照旧列），列不列由 `discovery::projects` 判断
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

    /// 拿 settings.json 读改写锁（见 [`SettingsGuard`]）。改设置的命令：先拿它，再读、改、写
    pub fn lock_settings(&self) -> SettingsGuard {
        SETTINGS_LOCK.acquire();
        SettingsGuard(std::marker::PhantomData)
    }

    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        if settings.version > SETTINGS_VERSION {
            // 给人看的一句：命令层原样作主句（`Said`），不换成「设置保存失败」
            return Err(crate::i18n::Said(crate::t!("common.settings.tooNew"))
                .into_io(io::ErrorKind::Unsupported));
        }
        let _guard = self.lock_settings();
        save_json(&self.dir.join("settings.json"), settings)
    }

    /// 启动时修坏文件（spec S7）：settings.json、projects.json 在但读不出（截断、半截、手改坏）时，
    /// 改名另存为 `<文件名>.broken-<now>`（重名加 `-1`、`-2`…），之后按默认值继续。返回另存后的路径；
    /// 文件不存在、读得出都不动。只在界面进程启动时调一次；命令行形态不调（只读、不修）
    pub fn repair_if_corrupt(&self, now: u64) -> io::Result<Vec<PathBuf>> {
        let _guard = self.lock_settings();
        let mut moved = Vec::new();
        if let Some(path) = repair_json::<Settings>(&self.dir.join("settings.json"), now)? {
            moved.push(path);
        }
        if let Some(path) = repair_json::<Vec<PathBuf>>(&self.dir.join("projects.json"), now)? {
            moved.push(path);
        }
        Ok(moved)
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
        let _guard = self.lock_settings();
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
        let _guard = self.lock_settings();
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

    /// 读设置，顺手把此刻有软链（或 Sophia 放的副本）的来源写进各位置的订阅记录（见 `subscriptions::adopt`；
    /// 第一次扫描时认领老数据），改过才写回。要发现结果才能认领，所以只在发现之后用
    pub fn load_settings_adopting_subscriptions(
        &self,
        sources: &[Source],
        targets: &[Target],
    ) -> io::Result<Settings> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        let legacy = settings.manual_sources.clone();
        let copies = crate::copies::Copies::load(self)?;
        if crate::subscriptions::adopt(
            &mut settings.subscriptions,
            sources,
            targets,
            &legacy,
            &copies,
        ) {
            self.save_settings(&settings)?;
        }
        Ok(settings)
    }

    /// 同上，MCP 自动添加规则：取来源位置当前的全部 MCP 名（见 `mcp::migrate_baselines`）
    pub fn load_settings_migrating_mcp_auto_imports(
        &self,
        overview: &McpOverview,
    ) -> io::Result<Settings> {
        let _guard = self.lock_settings();
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
        let _guard = self.lock_settings();
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
        let _guard = self.lock_settings();
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
    /// `installed` 是已安装的品牌 id，按品牌的先后（`discovery::installed_brands`）
    pub fn load_settings_reconciling_shown(&self, installed: &[String]) -> io::Result<Settings> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if crate::discovery::reconcile_shown(installed, &mut settings) {
            self.save_settings(&settings)?;
        }
        Ok(settings)
    }

    /// 记下手动项目加入的时间（毫秒）；已有记录不覆盖——移除前再加一次不算新加入
    pub fn mark_project_added(&self, path: &Path, at_ms: u64) -> io::Result<()> {
        let _guard = self.lock_settings();
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
        let _guard = self.lock_settings();
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
        let _guard = self.lock_settings();
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

    /// Sophia 放进各 agent 的副本（spec #194）：`copies.json`，不存在时为空。
    /// 只读的地方直接读；要改的走 `copies::edit`（拿 [`Store::lock_copies`] 读改写）
    pub fn load_copies(&self) -> io::Result<Vec<crate::copies::CopyRecord>> {
        load_json(&self.dir.join(COPIES_FILE))
    }

    /// 整份写回。调用方须拿着 [`Store::lock_copies`]
    pub fn save_copies(&self, records: &[crate::copies::CopyRecord]) -> io::Result<()> {
        save_json(&self.dir.join(COPIES_FILE), &records)
    }

    /// copies.json 读改写的锁：进程内一把，各处的 `Store` 共用；不可重入，拿着它别再调也拿它的方法。
    /// 与 settings.json 的锁互不相干；两把同时拿时（移除来源：拿着 settings 的锁移除副本）只能先 settings
    /// 后 copies，拿着它时不碰 settings
    pub fn lock_copies(&self) -> std::sync::MutexGuard<'static, ()> {
        static COPIES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        COPIES_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 暂存处：删原件、装 skill 的撤销与更新都先挪到这里（`sync::hold`），
    /// 撤销机会过去由 `sync::release_held` 移进废纸篓。与命令层的 `held_dir` 是同一处。
    /// 副本不进这里（可能跨卷）：暂存在它旁边，见 `copies::HELD_PREFIX`
    pub fn held_dir(&self) -> PathBuf {
        self.dir.join("held")
    }

    /// 设置外观；没变不写盘
    pub fn set_appearance(&self, value: Appearance) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if settings.appearance == value {
            return Ok(());
        }
        settings.appearance = value;
        self.save_settings(&settings)
    }

    /// 设置界面语言；没变不写盘
    pub fn set_language(&self, value: Language) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if settings.language == value {
            return Ok(());
        }
        settings.language = value;
        self.save_settings(&settings)
    }

    /// 设置 `自动检查 skill 更新`（R14）
    pub fn set_auto_check_skill_updates(&self, enabled: bool) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if settings.auto_check_skill_updates == enabled {
            return Ok(());
        }
        settings.auto_check_skill_updates = enabled;
        self.save_settings(&settings)
    }

    /// 记下「默认注册登录项」已经做过（spec 2026-10-05-keep-running R1）：不论注册成败都记，只做一次
    pub fn mark_autostart_defaulted(&self) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if settings.autostart_defaulted {
            return Ok(());
        }
        settings.autostart_defaulted = true;
        self.save_settings(&settings)
    }

    /// 记下这一次查更新的时刻（unix 秒）
    pub fn record_skill_update_check(&self, at: u64) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        settings.last_skill_update_check = Some(at);
        self.save_settings(&settings)
    }

    /// 提示条按 ×：整批替换记下的 tree SHA（R15）
    pub fn set_dismissed_update_shas(&self, shas: Vec<String>) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if settings.dismissed_update_shas == shas {
            return Ok(());
        }
        settings.dismissed_update_shas = shas;
        self.save_settings(&settings)
    }
}

// ── 自动上报（spec 2026-10-04-reporting-feedback R5–R7）────────────────────────────
impl Store {
    /// 按天的异常次数与上报记录（`report-counts.json`），不存在时为空
    pub fn load_report_counts(&self) -> io::Result<crate::report::CountsFile> {
        load_json(&self.dir.join(crate::report::COUNTS_FILE))
    }

    pub fn save_report_counts(&self, counts: &crate::report::CountsFile) -> io::Result<()> {
        save_json(&self.dir.join(crate::report::COUNTS_FILE), counts)
    }

    /// 没发出去的事件与当天已收过的签名（`report-events.json`），不存在时为空
    pub fn load_report_events(&self) -> io::Result<crate::report::EventsFile> {
        load_json(&self.dir.join(crate::report::EVENTS_FILE))
    }

    pub fn save_report_events(&self, events: &crate::report::EventsFile) -> io::Result<()> {
        save_json(&self.dir.join(crate::report::EVENTS_FILE), events)
    }

    /// 上报用的安装 ID：关着为 None；开着还没有就生成一个存下
    pub fn report_install_id(&self) -> io::Result<Option<String>> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if !settings.auto_report {
            return Ok(None);
        }
        if let Some(id) = &settings.install_id {
            return Ok(Some(id.clone()));
        }
        let id = crate::report::new_install_id();
        settings.install_id = Some(id.clone());
        self.save_settings(&settings)?;
        Ok(Some(id))
    }

    /// `使用统计和错误报告` 开关（R6）：关掉删安装 ID；再打开生成新的。开关一变就清掉按天的计数、没发出去的
    /// 事件与崩溃旁文件，新的安装 ID 不带上旧 ID 那段时间的东西。没变（开着且已有 ID、关着且没有 ID）什么都不做。
    ///
    /// 关掉：先存设置（关掉优先），再删文件，删不掉只记一条日志、不报错（已经关了、ID 已删，界面不回滚成「开」）。
    /// 打开：先删文件，删不掉就不打开、报错——旧 ID 那段时间留下的东西无论如何不会带着新 ID 发出去（复审 P1）
    pub fn set_auto_report(&self, enabled: bool) -> io::Result<()> {
        let _guard = self.lock_settings();
        let mut settings = self.load_settings()?;
        if settings.auto_report == enabled && settings.install_id.is_some() == enabled {
            return Ok(());
        }
        if enabled {
            self.remove_report_files()?;
        }
        settings.auto_report = enabled;
        settings.install_id = enabled.then(crate::report::new_install_id);
        self.save_settings(&settings)?;
        if !enabled {
            if let Err(e) = self.remove_report_files() {
                log::warn!("关掉自动上报时删不掉本机的上报记录（下次打开前会再删）：{e}");
            }
        }
        Ok(())
    }

    /// 删掉按天的计数、没发出去的事件与崩溃旁文件：每份都试，报第一个错。本来就没有不算错
    fn remove_report_files(&self) -> io::Result<()> {
        let mut result = Ok(());
        for name in [
            crate::report::COUNTS_FILE,
            crate::report::EVENTS_FILE,
            crate::report::CRASH_FILE,
        ] {
            match std::fs::remove_file(self.dir.join(name)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => result = result.and(Err(e)),
                _ => {}
            }
        }
        result
    }
}

/// 副本记录的文件名（spec #194：不放进 settings.json、installs.json）
const COPIES_FILE: &str = "copies.json";

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

/// 文件在但读不出 → 改名另存并返回新路径；不存在或读得出 → None。读文件本身出错（没权限）照样报错
fn repair_json<T: DeserializeOwned>(path: &Path, now: u64) -> io::Result<Option<PathBuf>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if serde_json::from_slice::<T>(&bytes).is_ok() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(Path::new("."));
    let base = format!("{name}.broken-{now}");
    let mut target = parent.join(&base);
    let mut n = 1;
    while std::fs::symlink_metadata(&target).is_ok() {
        target = parent.join(format!("{base}-{n}"));
        n += 1;
    }
    std::fs::rename(path, &target)?;
    Ok(Some(target))
}

/// 先写临时文件并落盘（fsync），再改名替换，再把目录落盘：断电时要么是旧文件、要么是完整的新文件，
/// 不留半截（spec S7）
fn save_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "parent"))?;
    std::fs::create_dir_all(parent)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    // 目录项的改名也要落盘；macOS/Linux 上对目录打开后 fsync 即可。目录 fsync 不被支持时不算错
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use crate::usage::{AgentDisplay, AgentId, DisplayMode, Refresh, StackedSize, UsageSubject};

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
            version: SETTINGS_VERSION,
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
            workbuddy_gateway: WorkBuddyGatewaySettings::default(),
            project_added_at: [("/a".to_string(), 1_700_000_000_000)]
                .into_iter()
                .collect(),
            hidden_projects: vec![PathBuf::from("/p")],
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
                items: Some(vec![
                    UsageSubject::Agent(AgentId::ClaudeCode),
                    UsageSubject::Provider("kimi-2".to_string()),
                ]),
                per_item: [(
                    UsageSubject::Agent(AgentId::ClaudeCode),
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
                ..UsageSettings::default()
            },
            appearance: Appearance::Dark,
            language: Language::ZhHant,
            auto_report: false,
            install_id: Some("3f0c0f9e-0000-4000-8000-000000000000".into()),
            autostart_defaulted: false,
            model_providers: crate::model_providers::ModelProviders {
                providers: vec![crate::model_providers::Provider {
                    id: "kimi".into(),
                    name: "Kimi".into(),
                    base_url: "https://api.moonshot.cn/v1".into(),
                    ..Default::default()
                }],
                enable_seq: 3,
                picks: [(
                    "codex".to_owned(),
                    crate::model_providers::picks::AgentPicks {
                        picked: vec![crate::model_providers::ModelRef::new("kimi", "k2")],
                        official_seen: Vec::new(),
                    },
                )]
                .into_iter()
                .collect(),
            },
        };
        s.save_settings(&settings).unwrap();
        assert_eq!(s.load_settings().unwrap(), settings);
        assert!(!dir.join("settings.json.tmp").exists());
    }

    /// 「1 分钟」档已去掉（M17）：存着它的老设置读成 5 分钟，再存就写成 `"5"`
    #[test]
    fn removed_one_minute_refresh_loads_as_five() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"usage":{"menuBarEnabled":true,"refresh":"1"}}"#,
        )
        .unwrap();
        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.usage.refresh, Refresh::Every5);
        assert!(loaded.usage.menu_bar_enabled);
        s.save_settings(&loaded).unwrap();
        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(text.contains(r#""refresh": "5""#), "{text}");
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
            usage.per_item[&UsageSubject::Agent(AgentId::ClaudeCode)],
            AgentDisplay {
                primary: Some("session".into()),
                secondary: Some("weekly".into()),
                stacked: true,
                stacked_size: StackedSize::Medium,
            }
        );
    }

    // ---------------- 用量设置换新键（spec #322）：迁移、旧键不动、认不出的忽略 ----------------

    /// 旧版写的 `usage`：菜单栏 3 个 agent（旧版允许 3 个；有一个重复，旧版本身不拦）与每个 agent 的显示方式
    const OLD_USAGE: &str = r#"{"usage":{"menuBarEnabled":true,"displayMode":"used","agents":["codex","claude-code","codex"],"perAgent":{"codex":{"primary":"weekly","secondary":null,"stacked":false,"stackedSize":"small"},"claude-code":{"primary":"session","secondary":"weekly","stacked":true,"stackedSize":"large"}},"refresh":"10"},"disabledHarnesses":["cursor"]}"#;

    fn settings_json(dir: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn usage_old_keys_migrate_to_first_two_items() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("settings.json"), OLD_USAGE).unwrap();
        let usage = Store::new(dir).load_settings().unwrap().usage;
        assert_eq!(
            usage.items,
            Some(vec![
                UsageSubject::Agent(AgentId::Codex),
                UsageSubject::Agent(AgentId::ClaudeCode),
            ])
        );
        assert_eq!(
            usage.per_item[&UsageSubject::Agent(AgentId::ClaudeCode)].stacked_size,
            StackedSize::Large
        );
        assert_eq!(
            usage.per_item[&UsageSubject::Agent(AgentId::Codex)].primary,
            Some("weekly".into())
        );
        assert_eq!(usage.display_mode, DisplayMode::Used);
        assert_eq!(usage.refresh, Refresh::Every10);
    }

    /// 保存只写新键；旧键原文原样留着（换回旧版本时照旧读得懂）
    #[test]
    fn usage_save_writes_new_keys_and_keeps_old_keys_verbatim() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("settings.json"), OLD_USAGE).unwrap();
        let before: serde_json::Value = serde_json::from_str(OLD_USAGE).unwrap();
        let s = Store::new(dir.clone());
        let mut settings = s.load_settings().unwrap();
        // 新版里改了选择：只留 Codex，并给 Codex 换主窗口
        settings.usage.items = Some(vec![UsageSubject::Agent(AgentId::Codex)]);
        settings
            .usage
            .per_item
            .insert(UsageSubject::Agent(AgentId::Codex), AgentDisplay::default());
        s.save_settings(&settings).unwrap();

        let after = settings_json(&dir);
        assert_eq!(after["usage"]["agents"], before["usage"]["agents"]);
        assert_eq!(after["usage"]["perAgent"], before["usage"]["perAgent"]);
        assert_eq!(after["usage"]["items"], serde_json::json!(["agent:codex"]));
        assert_eq!(
            after["usage"]["perItem"]["agent:codex"]["primary"],
            serde_json::Value::Null
        );
        // 重读：以新键为准
        let reloaded = Store::new(dir).load_settings().unwrap().usage;
        assert_eq!(
            reloaded.items,
            Some(vec![UsageSubject::Agent(AgentId::Codex)])
        );
        assert_eq!(reloaded, settings.usage);
    }

    /// 旧版本读这份文件：旧键照旧是它认得的形状，新键它不认识、忽略（旧版 `UsageSettings` 没有
    /// deny_unknown_fields）。这里用旧版的结构定义模拟
    #[test]
    fn usage_file_written_by_new_version_still_parses_as_old_shape() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        #[allow(dead_code)]
        #[derive(Default)]
        struct OldUsage {
            menu_bar_enabled: bool,
            agents: Option<Vec<AgentId>>,
            per_agent: BTreeMap<AgentId, AgentDisplay>,
        }
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct OldSettings {
            usage: OldUsage,
        }
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("settings.json"), OLD_USAGE).unwrap();
        let s = Store::new(dir.clone());
        let mut settings = s.load_settings().unwrap();
        settings.usage.items = Some(vec![UsageSubject::Provider("kimi-2".into())]);
        s.save_settings(&settings).unwrap();
        let text = std::fs::read(dir.join("settings.json")).unwrap();
        let old: OldSettings = serde_json::from_slice(&text).unwrap();
        assert_eq!(
            old.usage.agents,
            Some(vec![AgentId::Codex, AgentId::ClaudeCode, AgentId::Codex])
        );
        assert_eq!(old.usage.per_agent.len(), 2);
    }

    #[test]
    fn usage_new_keys_win_over_old_keys() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"usage":{"agents":["claude-code","codex"],"perAgent":{"codex":{"primary":"weekly"}},"items":["agent:codex"],"perItem":{"agent:codex":{"primary":"session"}}}}"#,
        )
        .unwrap();
        let usage = Store::new(dir).load_settings().unwrap().usage;
        assert_eq!(usage.items, Some(vec![UsageSubject::Agent(AgentId::Codex)]));
        assert_eq!(usage.per_item.len(), 1);
        assert_eq!(
            usage.per_item[&UsageSubject::Agent(AgentId::Codex)].primary,
            Some("session".into())
        );
    }

    /// 认不出的键、格式不对的值逐个忽略，整份设置照常读出来（不会被当损坏挪走）
    #[test]
    fn usage_unknown_or_malformed_keys_do_not_break_settings() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["cursor"],"usage":{"menuBarEnabled":true,"items":["agent:cursor","provider:","bogus",3,"provider:kimi-2","agent:codex"],"perItem":{"agent:nope":{},"provider:kimi-2":{"stackedSize":"huge"},"agent:codex":{"stacked":true},"x":1}}}"#,
        )
        .unwrap();
        let s = Store::new(dir.clone());
        let loaded = s.load_settings().unwrap();
        assert_eq!(loaded.disabled_harnesses, vec!["cursor".to_string()]);
        assert_eq!(
            loaded.usage.items,
            Some(vec![
                UsageSubject::Provider("kimi-2".into()),
                UsageSubject::Agent(AgentId::Codex),
            ])
        );
        assert_eq!(
            loaded.usage.per_item.keys().cloned().collect::<Vec<_>>(),
            vec![UsageSubject::Agent(AgentId::Codex)]
        );
        assert_eq!(s.repair_if_corrupt(1).unwrap(), Vec::<PathBuf>::new());

        // 旧键里有认不出的 agent（不是本版写的，但也不能让解析失败）：迁移时跳过
        std::fs::write(
            dir.join("settings.json"),
            r#"{"usage":{"agents":["cursor","codex"],"perAgent":"oops"}}"#,
        )
        .unwrap();
        let usage = s.load_settings().unwrap().usage;
        assert_eq!(usage.items, Some(vec![UsageSubject::Agent(AgentId::Codex)]));
        assert!(usage.per_item.is_empty());
        assert_eq!(usage.legacy_per_agent, Some(serde_json::json!("oops")));

        // 新键不是数组：当作没有，回到迁移
        std::fs::write(
            dir.join("settings.json"),
            r#"{"usage":{"agents":["codex"],"items":"oops"}}"#,
        )
        .unwrap();
        assert_eq!(
            s.load_settings().unwrap().usage.items,
            Some(vec![UsageSubject::Agent(AgentId::Codex)])
        );
    }

    /// 没有旧键的全新设置：不写出旧键
    #[test]
    fn usage_without_old_keys_writes_none() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        let mut settings = Settings::default();
        settings.usage.items = Some(vec![UsageSubject::Agent(AgentId::ClaudeCode)]);
        s.save_settings(&settings).unwrap();
        let json = settings_json(&dir);
        assert!(json["usage"].get("agents").is_none());
        assert!(json["usage"].get("perAgent").is_none());
        assert_eq!(s.load_settings().unwrap(), settings);
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
        changed.usage.refresh = Refresh::Every10;
        s.save_settings(&changed).unwrap();
        let reloaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(reloaded, changed);
        assert!(reloaded.usage.menu_bar_enabled);
        assert_eq!(reloaded.usage.refresh, Refresh::Every10);
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
    fn hidden_projects_live_in_settings_and_projects_json_keeps_its_format() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        // 旧文件没有这个字段：读成空（全部勾着）
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        assert!(s.load_settings().unwrap().hidden_projects.is_empty());
        let settings = Settings {
            hidden_projects: vec![PathBuf::from("/w/app")],
            ..Settings::default()
        };
        s.save_settings(&settings).unwrap();
        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(text.contains("\"hiddenProjects\""), "{text}");
        assert_eq!(
            s.load_settings().unwrap().hidden_projects,
            settings.hidden_projects
        );
        // 手动选的项目照旧是 projects.json 里的一个路径数组（9-26 之前的旧文件原样读得出）
        std::fs::write(dir.join("projects.json"), r#"["/w/old"]"#).unwrap();
        assert_eq!(s.load_projects().unwrap(), vec![PathBuf::from("/w/old")]);
        s.save_projects(&[PathBuf::from("/w/old"), PathBuf::from("/w/new")])
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("projects.json")).unwrap())
                .unwrap();
        assert_eq!(saved, serde_json::json!(["/w/old", "/w/new"]));
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
            apps: Vec::new(),
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
            readers: Vec::new(),
        }];
        let cells = crate::skills::auto_link_cells(&sources, &targets, &loaded.auto_links);
        let actions = crate::skills::propose_links(&sources, &targets, &cells);
        let report = crate::sync::execute(&actions, false, LinkStyle::Absolute, None);
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
            apps: Vec::new(),
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
            mirrors: Vec::new(),
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
            readers: Vec::new(),
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
            readers: Vec::new(),
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
            apps: Vec::new(),
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

    /// 开机启动默认开只做一次（spec 2026-10-05-keep-running AC1）：旧文件没有字段读成「没做过」；
    /// 记过之后再读是 true，别的字段不动
    #[test]
    fn autostart_defaulted_is_false_for_old_files_and_sticks_once_marked() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        assert!(!s.load_settings().unwrap().autostart_defaulted);
        std::fs::write(dir.join("settings.json"), r#"{"seenHints":["x"]}"#).unwrap();
        assert!(!s.load_settings().unwrap().autostart_defaulted);
        s.mark_autostart_defaulted().unwrap();
        let after = s.load_settings().unwrap();
        assert!(after.autostart_defaulted);
        assert_eq!(after.seen_hints, ["x"]);
        s.mark_autostart_defaulted().unwrap();
        assert!(s.load_settings().unwrap().autostart_defaulted);
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

    /// settings.json 读改写的锁：同一线程里套着拿不自锁；别的线程拿着时要等它放手（Codex 复审 1）
    #[test]
    fn settings_lock_is_reentrant_and_exclusive() {
        let t = TempTree::new();
        let s = Store::new(t.dir("data/Sophia"));
        {
            let _outer = s.lock_settings();
            let _inner = s.lock_settings();
            s.mark_hint_seen("nested").unwrap();
        }
        let started = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel();
        let other = Store::new(s.dir.clone());
        let holder = std::thread::spawn(move || {
            let _guard = other.lock_settings();
            tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
        });
        rx.recv().unwrap();
        s.mark_hint_seen("after").unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(150));
        holder.join().unwrap();
        assert_eq!(s.seen_hints().unwrap(), ["nested", "after"]);
    }

    /// 后台要安装 ID 与开关互斥（Codex 复审 1）：开关先关上，后台再要 ID 时读到的是关着，
    /// 不生成 ID、不把旧的「开着」写回去
    #[test]
    fn install_id_request_waits_for_the_switch_and_never_turns_it_back_on() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        let guard = s.lock_settings();
        let background = {
            let s = Store::new(dir.clone());
            std::thread::spawn(move || s.report_install_id().unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        s.set_auto_report(false).unwrap();
        drop(guard);
        assert_eq!(background.join().unwrap(), None);
        let settings = s.load_settings().unwrap();
        assert!(!settings.auto_report);
        assert_eq!(settings.install_id, None);
    }

    /// 自动上报（spec 2026-10-04-reporting-feedback R5、R6）：旧文件与没有 settings.json 都读成开着、还没有安装 ID；
    /// 开着时第一次要安装 ID 才生成并存下，之后不变；关掉删安装 ID（文件里连键都没有）、清掉按天的计数；
    /// 再打开换一个新的安装 ID。别的字段不动
    #[test]
    fn auto_report_defaults_on_and_install_id_follows_the_switch() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let s = Store::new(dir.clone());
        let fresh = s.load_settings().unwrap();
        assert!(fresh.auto_report);
        assert_eq!(fresh.install_id, None);

        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"autoCheckSkillUpdates":false}"#,
        )
        .unwrap();
        let old = s.load_settings().unwrap();
        assert!(old.auto_report);
        assert_eq!(old.install_id, None);

        let first = s.report_install_id().unwrap().unwrap();
        assert_eq!(
            s.report_install_id().unwrap().as_deref(),
            Some(first.as_str())
        );
        let raw = || -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap()
        };
        assert_eq!(raw()["installId"], serde_json::json!(first));
        assert_eq!(raw()["disabledHarnesses"], serde_json::json!(["codex"]));
        assert_eq!(raw()["autoCheckSkillUpdates"], serde_json::json!(false));

        let mut counts = crate::report::CountsFile::default();
        counts.absorb("2026-10-04", &Default::default());
        s.save_report_counts(&counts).unwrap();
        assert_eq!(s.load_report_counts().unwrap(), counts);

        s.set_auto_report(false).unwrap();
        assert_eq!(raw()["autoReport"], serde_json::json!(false));
        assert!(raw().get("installId").is_none(), "{}", raw());
        assert_eq!(s.report_install_id().unwrap(), None);
        assert!(!dir.join(crate::report::COUNTS_FILE).exists());
        assert_eq!(s.load_report_counts().unwrap(), Default::default());
        // 关着再关：不报错
        s.set_auto_report(false).unwrap();

        s.set_auto_report(true).unwrap();
        let second = s.report_install_id().unwrap().unwrap();
        assert_ne!(second, first);
        assert_eq!(raw()["installId"], serde_json::json!(second));
        // 开着再开：安装 ID 不换
        s.set_auto_report(true).unwrap();
        assert_eq!(s.report_install_id().unwrap(), Some(second));
        assert_eq!(raw()["disabledHarnesses"], serde_json::json!(["codex"]));
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
            content_sha: None,
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

    /// 读坏的文件照旧是错误、不静默清空；修复是另一步（`repair_if_corrupt`），只有界面进程启动时调
    #[test]
    fn corrupt_file_is_an_error_until_repaired() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("projects.json"), "{oops").unwrap();
        assert!(Store::new(dir).load_projects().is_err());
    }

    /// spec S7：空文件、截断的文件各一个——另存为 `.broken-<时间>`、之后读出默认值；返回两个另存路径
    #[test]
    fn repair_moves_corrupt_files_aside_and_loads_defaults() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("settings.json"), "").unwrap();
        std::fs::write(dir.join("projects.json"), "[\"/a/b\", \"/c").unwrap();
        let store = Store::new(dir.clone());
        assert!(store.load_settings().is_err());

        let moved = store.repair_if_corrupt(1_790_000_000).unwrap();
        assert_eq!(
            moved,
            vec![
                dir.join("settings.json.broken-1790000000"),
                dir.join("projects.json.broken-1790000000"),
            ]
        );
        assert!(!dir.join("settings.json").exists());
        assert_eq!(
            std::fs::read_to_string(&moved[1]).unwrap(),
            "[\"/a/b\", \"/c",
            "坏文件原样另存"
        );
        assert_eq!(store.load_settings().unwrap(), Settings::default());
        assert_eq!(store.load_projects().unwrap(), Vec::<PathBuf>::new());
    }

    /// 同一秒修两次（或上次另存的还在）：第二份带 `-1`，不覆盖
    #[test]
    fn repair_does_not_overwrite_an_earlier_broken_copy() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        std::fs::write(dir.join("settings.json.broken-7"), "old").unwrap();
        std::fs::write(dir.join("settings.json"), "{").unwrap();
        let moved = Store::new(dir.clone()).repair_if_corrupt(7).unwrap();
        assert_eq!(moved, vec![dir.join("settings.json.broken-7-1")]);
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json.broken-7")).unwrap(),
            "old"
        );
    }

    /// 读得出的文件和不存在的文件都不动
    #[test]
    fn repair_leaves_healthy_and_missing_files_alone() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let store = Store::new(dir.clone());
        let mut settings = Settings::default();
        settings.seen_hints.push("x".into());
        store.save_settings(&settings).unwrap();
        assert_eq!(store.repair_if_corrupt(1).unwrap(), Vec::<PathBuf>::new());
        assert_eq!(store.load_settings().unwrap(), settings);
        assert!(!dir.join("projects.json").exists());
    }

    /// 旧文件没有 `version` 按 1 读；更新版本写的文件读得出、写回被拒（不拿新版的内容盖掉）
    #[test]
    fn newer_settings_version_is_read_but_never_written_back() {
        let t = TempTree::new();
        let dir = t.dir("data/Sophia");
        let store = Store::new(dir.clone());
        std::fs::write(dir.join("settings.json"), "{\"seenHints\":[\"a\"]}").unwrap();
        let old = store.load_settings().unwrap();
        assert_eq!(old.version, SETTINGS_VERSION);
        assert_eq!(old.seen_hints, vec!["a".to_string()]);

        std::fs::write(
            dir.join("settings.json"),
            format!(
                "{{\"version\":{},\"seenHints\":[\"b\"]}}",
                SETTINGS_VERSION + 1
            ),
        )
        .unwrap();
        let newer = store.load_settings().unwrap();
        assert_eq!(newer.seen_hints, vec!["b".to_string()]);
        let err = store.save_settings(&newer).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Unsupported);
        // 给人看的一句：命令层原样作主句，不换成「设置保存失败」
        assert_eq!(
            crate::i18n::Said::of(&err),
            Some(crate::t!("common.settings.tooNew").as_str())
        );
        assert!(store.repair_if_corrupt(1).unwrap().is_empty(), "太新不算坏");
        assert!(std::fs::read_to_string(dir.join("settings.json"))
            .unwrap()
            .contains("\"b\""));
    }
}

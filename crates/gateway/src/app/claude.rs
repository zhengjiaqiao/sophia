//! 家 `claude`：Claude 桌面应用的打开 / 切回 / 接管 / 改选 / 重新写入 / 重启生效 / 打开 Claude 与状态
//! （spec 2026-09-29-claude-third-party-models R5、R8、R9、R32 的副作用部分、R33–R37、R49、R50）。
//!
//! 写什么由 core 的 `claude_models::desktop` 算（纯函数：`plan_apply` / `plan_restore` / `inspect`）；
//! 这里决定什么时候写（桌面应用不在运行，每次写之前在同一动作里重查）、先记后写（`applied.phase`）、
//! 失败时撤回或留给「重新写入 / 再试一次」前滚，以及路由与 Claude 清单。
use super::{internal, Agent, App, AppError, Untouched};
use crate::claude_desktop;
use sophia_core::claude_models::desktop::{
    self, Desired, DesktopError, DesktopSnapshot, Foreign, Plan, RoleModel, TOKEN_PLACEHOLDER,
};
use sophia_core::claude_models::settings::WrittenModel;
use sophia_core::claude_models::settings::{
    Applied, ClaudeGatewaySettings, Original, Originals, Phase, Written,
};
use sophia_core::codex_models::catalog::Published;
use std::io;
use std::path::PathBuf;

/// 低于这个版本的桌面应用还不用 configLibrary（spec 待决 Q3 的默认值：角色白名单含 fable 的版本）
pub const MIN_DESKTOP_VERSION: &str = "1.12603.1";
/// Claude 的路由清单，在 Sophia 的数据目录下（不放 Codex 目录：Codex 的恢复会清那里）
const ROUTING_DIR: &str = "gateway";
const ROUTING_FILE: &str = "claude-routing.json";

/// 测试用：写桌面应用的某个文件之前调用，返回 Err 即模拟这一步写失败
#[cfg(test)]
pub(super) type StepHook =
    std::sync::Mutex<Option<Box<dyn Fn(desktop::DesktopFile) -> Result<(), String> + Send>>>;

/// Claude 那一家特有的状态（契约 §6）。2026-09-30 起 Sophia 不设默认模型：没有「默认用 / 后台任务用」
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAgentView {
    pub desktop: DesktopView,
    /// Sophia 的 profile 里实际写着的 `inferenceModels`（按文件里的顺序；profile 不存在或读不懂时为空）。
    /// 核对用：命令行 `status --agent claude` 打印它
    pub profile_models: Vec<ProfileModel>,
}

/// profile 的 `inferenceModels` 里的一项
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileModel {
    /// 角色 id（`name`）
    pub id: String,
    pub label_override: String,
}

/// 桌面应用这一侧（R34）
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopView {
    pub version: Option<String>,
    pub too_old: bool,
    pub managed: bool,
    pub running: bool,
    /// 桌面应用配置里写着 Sophia 的（含 Sophia 设置丢了、但文件是我们的）
    pub applied: bool,
    /// 想要的值与写入的值不同（待生效）
    pub pending: bool,
    pub needs_restart: bool,
    /// Sophia 写进去的设置被改掉了，或上次没写完
    pub drift: bool,
    /// 切回没做完
    pub restore_unfinished: bool,
    /// 别家的生效配置
    pub foreign: Option<Foreign>,
}

/// Claude 清单（契约 §2）：`{"agent":"claude","providers":[…],"models":[{slug:<角色 id>,…,label}],"retired":[]}`。
/// 不含密钥；`providers[].name` 是网关短名，路由在「密钥被拒」的提示里用
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ClaudeRouting {
    agent: String,
    providers: Vec<RoutingProvider>,
    models: Vec<RoutingModel>,
    #[serde(default)]
    retired: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct RoutingProvider {
    id: String,
    name: String,
    base_url: String,
    protocol: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct RoutingModel {
    slug: String,
    upstream_model: String,
    provider: String,
    label: String,
}

fn desktop_error(error: DesktopError) -> AppError {
    AppError::new(error.code(), error.to_string())
}

/// Claude 的路由清单在数据目录下的位置；路由每个请求重读
pub fn claude_routing_file(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join(ROUTING_DIR).join(ROUTING_FILE)
}

/// `1.12603.1` 这样的版本号逐段按数字比；读不懂的不算太旧
pub fn version_too_old(version: &str) -> bool {
    let parse = |text: &str| -> Option<Vec<u64>> {
        text.trim()
            .split('.')
            .map(|part| part.trim().parse().ok())
            .collect()
    };
    match (parse(version), parse(MIN_DESKTOP_VERSION)) {
        (Some(have), Some(need)) => have < need,
        _ => false,
    }
}

/// 模型片上的名字（含撞名后缀），写进 `labelOverride`
fn label_of(published: &Published) -> String {
    published
        .model
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| published.model.id.trim())
        .to_owned()
}

/// profile 原文里的 `inferenceModels`：读不懂的项跳过
fn profile_models(profile: Option<&[u8]>) -> Vec<ProfileModel> {
    let Some(value) = profile.and_then(|bytes| {
        sophia_core::jsonedit::parse(bytes)
            .ok()
            .map(serde_json::Value::Object)
    }) else {
        return Vec::new();
    };
    value
        .get("inferenceModels")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ProfileModel {
                        id: item.get("name")?.as_str()?.to_owned(),
                        label_override: item
                            .get("labelOverride")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl App {
    pub(super) fn load_claude(&self) -> Result<ClaudeGatewaySettings, AppError> {
        (self.deps.load_claude)().map_err(internal)
    }

    pub(super) fn save_claude(&self, settings: &ClaudeGatewaySettings) -> Result<(), AppError> {
        (self.deps.save_claude)(settings).map_err(internal)
    }

    pub(super) fn claude_routing_path(&self) -> PathBuf {
        claude_routing_file(&self.deps.data_dir)
    }

    /// 路由的引用计数里 Claude 算不算开着：桌面应用配置里写着 Sophia 的（与开关位置无关，R8），
    /// 或开关开着、等重启生效（在运行时拨开就装了路由，`applied` 还空着；此时卸路由，重启后 Claude 连不上）
    pub(super) fn claude_on(&self) -> bool {
        self.load_claude()
            .is_ok_and(|s| s.applied.is_some() || s.enabled)
    }

    /// 路由的引用计数里 Codex 算不算开着：设置文件指向路由（含只剩一半指向的——那时停掉路由，
    /// Codex 连官方模型也用不了，同 `restore` 里「仍指向就保留路由」的保护）
    pub(super) fn codex_on(&self) -> bool {
        let Ok(settings) = self.load() else {
            return false;
        };
        self.read_config()
            .ok()
            .and_then(|snapshot| {
                sophia_core::codex_models::config::inspect(&snapshot.text, &self.managed(&settings))
                    .ok()
            })
            .is_some_and(|inspection| inspection.enabled || inspection.points_at_router)
    }

    fn port(&self) -> Result<u16, AppError> {
        Ok(self.load()?.port)
    }

    pub(super) fn running(&self) -> Result<bool, AppError> {
        (self.deps.desktop_running)().map_err(|e| {
            AppError::new(
                "internal",
                sophia_core::t!("models.claude.runningUnknown", error = e),
            )
        })
    }

    /// 打开方向的前提：装了、不受管、版本够新（R34、R41）
    fn desktop_unavailable(&self) -> Option<AppError> {
        let unavailable = |message: String| Some(AppError::new("desktop_unavailable", message));
        let Some(info) = (self.deps.desktop_info)() else {
            return unavailable(sophia_core::t!("models.claude.notInstalled"));
        };
        if claude_desktop::managed(&self.deps.managed_prefs) {
            return unavailable(sophia_core::t!("models.claude.managed"));
        }
        if info.version.as_deref().is_some_and(version_too_old) {
            return unavailable(sophia_core::t!("models.claude.tooOld"));
        }
        None
    }

    /// 密钥文件里的令牌；`create` 为真时没有就生成一个存进去（R5：第一次打开或接管时，之后一直复用）。
    /// 读不出（文件权限、还在钥匙串里没迁完）时报错，不另生成：生成了就把桌面应用里的旧令牌作废了
    fn token(&self, create: bool) -> Result<Option<String>, AppError> {
        match (self.deps.get_router_token)() {
            Ok(Some(token)) if !token.trim().is_empty() => Ok(Some(token.trim().to_owned())),
            Ok(_) if create => {
                let token = (self.deps.new_router_token)().map_err(|e| {
                    internal(sophia_core::t!(
                        "models.claude.tokenCreateFailed",
                        error = e
                    ))
                })?;
                (self.deps.set_router_token)(&token).map_err(|e| {
                    internal(sophia_core::t!("models.claude.tokenStoreFailed", error = e))
                })?;
                Ok(Some(token))
            }
            Ok(_) => Ok(None),
            Err(e) => Err(internal(sophia_core::t!(
                "models.claude.tokenReadFailed",
                error = e
            ))),
        }
    }

    /// 想要的值（R29）：已选全部，按已选顺序（网关顺序、再按各自列表顺序，同模型片）。已选为空 → `invalid`
    fn desired(
        &self,
        settings: &ClaudeGatewaySettings,
        port: u16,
        token: &str,
    ) -> Result<Desired, AppError> {
        let published = settings.published();
        if published.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.noModelsSelected"),
            ));
        }
        Ok(Desired {
            base_url: desktop::base_url(port),
            token: token.to_owned(),
            models: published
                .iter()
                .map(|p| RoleModel {
                    slug: p.slug.clone(),
                    label: label_of(p),
                })
                .collect(),
            takeover: settings.takeover,
        })
    }

    fn routing_provider(settings: &ClaudeGatewaySettings, id: &str) -> Option<RoutingProvider> {
        settings
            .providers
            .iter()
            .find(|p| p.id == id)
            .map(|p| RoutingProvider {
                id: p.id.clone(),
                name: p.short_name(),
                base_url: p.upstream_base().to_owned(),
                protocol: p.protocol().to_owned(),
            })
    }

    /// Claude 清单：与写进 `inferenceModels` 的各项一一对应，角色 id → 上游模型（R37「清单跟写入的值走」）
    fn claude_routing(
        &self,
        settings: &ClaudeGatewaySettings,
        desired: &Desired,
    ) -> Result<ClaudeRouting, AppError> {
        let published = settings.published();
        let mut providers: Vec<RoutingProvider> = Vec::new();
        let mut models = Vec::new();
        for WrittenModel { role, slug, label } in desired.models() {
            let found = published.iter().find(|p| p.slug == slug).ok_or_else(|| {
                AppError::new(
                    "invalid",
                    sophia_core::t!("models.claude.pickedNotSelected"),
                )
            })?;
            if !providers.iter().any(|p| p.id == found.provider) {
                providers.push(
                    Self::routing_provider(settings, &found.provider).ok_or_else(|| {
                        AppError::new("invalid", sophia_core::t!("models.claude.providerMissing"))
                    })?,
                );
            }
            models.push(RoutingModel {
                slug: role,
                upstream_model: found.model.id.trim().to_owned(),
                provider: found.provider.clone(),
                label,
            });
        }
        Ok(ClaudeRouting {
            agent: Agent::Claude.as_str().to_owned(),
            providers,
            models,
            retired: Vec::new(),
        })
    }

    fn write_claude_routing(&self, routing: &ClaudeRouting) -> Result<(), AppError> {
        let path = self.claude_routing_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(internal)?;
        }
        let bytes = serde_json::to_vec_pretty(routing).map_err(internal)?;
        self.write_own_file(&path, &bytes)
    }

    /// 网关的地址、协议、短名变了：已写进 Claude 清单的角色不动，只把它们所属网关的上游信息换成现在的；
    /// 已删掉的网关从清单里拿掉（那一档请求在重启生效前报 R14 的 500）。路由每个请求重读，立刻生效
    fn refresh_claude_routing(&self, settings: &ClaudeGatewaySettings) -> Result<(), AppError> {
        let path = self.claude_routing_path();
        let Ok(bytes) = std::fs::read(&path) else {
            return Ok(());
        };
        let Ok(mut routing) = serde_json::from_slice::<ClaudeRouting>(&bytes) else {
            return Ok(());
        };
        let mut providers: Vec<RoutingProvider> = Vec::new();
        for model in &routing.models {
            if providers.iter().any(|p| p.id == model.provider) {
                continue;
            }
            if let Some(provider) = Self::routing_provider(settings, &model.provider) {
                providers.push(provider);
            }
        }
        if providers != routing.providers {
            routing.providers = providers;
            self.write_claude_routing(&routing)?;
        }
        Ok(())
    }

    /// 写桌面应用配置之前起好路由（同进程，不会是旧版）。端口被别的程序占着时换了端口：返回现在的端口
    fn ensure_router_for_claude(&self) -> Result<u16, AppError> {
        let mut settings = self.load()?;
        self.ensure_router(&mut settings, Untouched::Claude)?;
        Ok(settings.port)
    }

    /// 删 Claude 清单；Codex 也关着就停路由并删 Codex 目录下本功能的文件（R8）。返回提示
    fn release_router_for_claude(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        match std::fs::remove_file(self.claude_routing_path()) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => warnings.push(sophia_core::t!(
                "models.claude.routingDeleteFailed",
                error = e
            )),
        }
        if !self.codex_on() {
            (self.deps.router_stop)();
            self.set_notice(None);
            warnings.extend(self.remove_codex_files(&[]));
        }
        warnings
    }

    fn execute_plan(&self, snapshot: &DesktopSnapshot, plan: &Plan) -> Result<(), AppError> {
        for step in &plan.steps {
            #[cfg(test)]
            if let Some(hook) = self
                .step_hook
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
            {
                hook(step.file).map_err(|e| AppError::new("internal", e))?;
            }
            desktop::apply_step(&self.deps.desktop_dirs, snapshot, step, &self.backups_dir())
                .map_err(desktop_error)?;
        }
        Ok(())
    }

    /// 把桌面应用的配置带到想要的样子。调用方已在同一动作里确认桌面应用不在运行。
    /// 上次切回没做完的先做完（R32「先把记下的方向做完」）；然后开着就打开方向，关着且写着 Sophia 的就切回
    fn claude_write(&self, settings: &mut ClaudeGatewaySettings) -> Result<Vec<String>, AppError> {
        let mut warnings = Vec::new();
        if settings
            .applied
            .as_ref()
            .is_some_and(|a| a.phase == Phase::Restoring)
        {
            warnings.extend(self.claude_restore_files(settings)?);
        }
        if settings.enabled {
            self.claude_open_files(settings)?;
        } else if settings.applied.is_some() {
            warnings.extend(self.claude_restore_files(settings)?);
        }
        Ok(warnings)
    }

    /// 打开方向（R32）：① 读快照、在内存里算好 → ③ 路由就绪 → 再读一次、再算一次（等路由那几秒里文件可能变了）
    /// → ② 记下 `phase: writing` → 写 Claude 清单 → ④–⑦ 按步写 → ⑧ `phase: done`。
    /// 这次动作之前没有记录（新打开）时，任何一步失败都在同一动作里撤回；有记录（改选、重新写入、前滚）时
    /// 失败就停在 `writing`，由状态里的 `drift` 与「重新写入」接着做
    fn claude_open_files(&self, settings: &mut ClaudeGatewaySettings) -> Result<(), AppError> {
        let fresh = settings.applied.is_none();
        let result = self.claude_open_inner(settings);
        if let Err(error) = &result {
            if fresh {
                self.rollback_open(settings);
                return Err(error.clone());
            }
        }
        result
    }

    fn claude_open_inner(&self, settings: &mut ClaudeGatewaySettings) -> Result<(), AppError> {
        let dirs = &self.deps.desktop_dirs;
        let port = self.port()?;
        let token = self
            .token(true)?
            .ok_or_else(|| internal(sophia_core::t!("models.claude.tokenMissing")))?;
        let mut desired = self.desired(settings, port, &token)?;
        let routing = self.claude_routing(settings, &desired)?;

        // 先在内存里试一次：文件不合法、别家配置在生效等，在碰路由之前就退出
        let snapshot = desktop::read(dirs, settings.applied.as_ref()).map_err(desktop_error)?;
        let trial = desktop::plan_apply(snapshot.files(), &desired, settings.applied.as_ref())
            .map_err(desktop_error)?;
        let routing_current = std::fs::read(self.claude_routing_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ClaudeRouting>(&bytes).ok());
        let settled = settings
            .applied
            .as_ref()
            .is_some_and(|a| a.phase == Phase::Done && a.written == trial.record.written);
        if trial.steps.is_empty() && settled && routing_current.as_ref() == Some(&routing) {
            return Ok(());
        }

        let now_port = self.ensure_router_for_claude()?;
        if now_port != port {
            // 端口被别的程序占着、路由换了端口：按新端口写
            desired = self.desired(settings, now_port, &token)?;
        }
        let snapshot = desktop::read(dirs, settings.applied.as_ref()).map_err(desktop_error)?;
        let plan = desktop::plan_apply(snapshot.files(), &desired, settings.applied.as_ref())
            .map_err(desktop_error)?;
        settings.applied = Some(plan.record.clone());
        self.save_claude(settings)?;
        self.write_claude_routing(&routing)?;
        self.execute_plan(&snapshot, &plan)?;
        if let Some(applied) = settings.applied.as_mut() {
            applied.phase = Phase::Done;
        }
        self.save_claude(settings)
    }

    /// 新打开没写成：撤回已写的（原值已记），开关滑回（R32「动作里失败」）。撤回也失败 → 停在 `restoring`
    fn rollback_open(&self, settings: &mut ClaudeGatewaySettings) {
        settings.enabled = false;
        settings.takeover = false;
        if settings.applied.is_some() {
            if self.claude_restore_files(settings).is_err() {
                if let Some(applied) = settings.applied.as_mut() {
                    applied.phase = Phase::Restoring;
                }
                let _ = self.save_claude(settings);
            }
        } else {
            let _ = self.save_claude(settings);
            let _ = self.release_router_for_claude();
        }
    }

    /// 切回方向（R32、R33）：先记 `phase: restoring` → ① 两处 `deploymentMode` → ② `_meta.json` → ③ profile
    /// → ④ 删 Claude 清单、按 R8 决定卸不卸服务 → ⑤ 清 `applied`。失败就停在 `restoring`，「再试一次」接着做
    fn claude_restore_files(
        &self,
        settings: &mut ClaudeGatewaySettings,
    ) -> Result<Vec<String>, AppError> {
        let Some(record) = settings.applied.clone() else {
            return Ok(Vec::new());
        };
        let token = self.token(false)?.unwrap_or_default();
        let dirs = &self.deps.desktop_dirs;
        let snapshot = desktop::read(dirs, Some(&record)).map_err(desktop_error)?;
        let plan =
            desktop::plan_restore(snapshot.files(), &record, &token).map_err(desktop_error)?;
        settings.applied = Some(plan.record.clone());
        self.save_claude(settings)?;
        self.execute_plan(&snapshot, &plan)?;
        let mut warnings = plan.warnings;
        warnings.extend(self.release_router_for_claude());
        settings.applied = None;
        self.save_claude(settings)?;
        Ok(warnings)
    }

    /// Sophia 的设置丢了、但桌面应用配置里写着的是我们的（R34 例外）：补一份记录，原值当作
    /// 「`appliedId` 原来没有、`deploymentMode` 原来没有」，切回时按 R33 写 `"1p"`、删 `appliedId`
    fn adopt_unrecorded(&self, settings: &mut ClaudeGatewaySettings) -> Result<bool, AppError> {
        let Some(token) = self.token(false)? else {
            return Ok(false);
        };
        let port = self.port()?;
        let base_url = desktop::base_url(port);
        let snapshot = desktop::read(&self.deps.desktop_dirs, None).map_err(desktop_error)?;
        let inspection = desktop::inspect(
            snapshot.files(),
            &desktop::Ours {
                token: &token,
                base_url: &base_url,
                record: None,
            },
        )
        .map_err(desktop_error)?;
        if !inspection.unrecorded_ours {
            return Ok(false);
        }
        // 认 BOM（编辑器另存过的文件常带），与 `inspect` 读的是同一份内容
        let mut profile: serde_json::Value = snapshot
            .files()
            .profile
            .as_deref()
            .and_then(|bytes| sophia_core::jsonedit::parse(bytes).ok())
            .map(serde_json::Value::Object)
            .unwrap_or_default();
        if let Some(key) = profile.get_mut("inferenceGatewayApiKey") {
            *key = serde_json::Value::from(TOKEN_PLACEHOLDER);
        }
        settings.applied = Some(Applied {
            phase: Phase::Done,
            written: Written {
                base_url,
                models: Vec::new(),
                chat_tab_written: false,
                profile,
            },
            originals: Originals {
                applied_id: Original::Absent,
                entries: Original::Absent,
                claude_3p_mode: Original::Absent,
                claude_mode: Original::Absent,
            },
            profile_created: true,
            entry_added: true,
        });
        Ok(true)
    }

    /// 存下改动后的 Claude 设置，并让已生效的配置跟上（`providers::commit_family` 的 Claude 分支）
    pub(super) fn commit_claude(
        &self,
        settings: &mut ClaudeGatewaySettings,
        republish: bool,
    ) -> Result<Vec<String>, AppError> {
        if republish && settings.enabled && settings.published().is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.claude.needOneModel"),
            ));
        }
        self.save_claude(settings)?;
        if settings
            .applied
            .as_ref()
            .is_some_and(|a| a.phase != Phase::Restoring)
        {
            self.refresh_claude_routing(settings)?;
        }
        // 改动已经存下：查不清在不在运行就按在运行算——先不写，等重启生效时写（不在它运行时冒险写文件），
        // 也不因为查不清就报「没加上」，界面的乐观勾选与存下的结果一致
        if republish && settings.enabled && !self.running().unwrap_or(true) {
            return self.claude_write(settings);
        }
        Ok(Vec::new())
    }

    // ----- 动作 -----

    /// 打开（拨开关）：校验通过后存下开关；桌面应用不在运行就当场写，在运行记为待生效（R49）。
    /// 返回给用户的提示
    pub fn enable_claude(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.open_claude_locked(false)
    }

    /// 接管别家的生效配置（R35）：等价于允许顶替的打开
    pub fn takeover_claude(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.open_claude_locked(true)
    }

    pub(super) fn open_claude_locked(&self, takeover: bool) -> Result<Vec<String>, AppError> {
        let mut settings = self.load_claude()?;
        if let Some(error) = self.desktop_unavailable() {
            return Err(error);
        }
        if settings.published().is_empty() {
            return Err(AppError::new(
                "invalid",
                if takeover {
                    sophia_core::t!("models.claude.pickBeforeTakeover")
                } else {
                    sophia_core::t!("models.app.noModelsSelected")
                },
            ));
        }
        for provider in &settings.providers {
            if provider.selected().is_empty() {
                continue;
            }
            self.require_key(Agent::Claude, provider, false)?;
        }
        if !takeover && !settings.takeover {
            // 别家的配置在生效而没允许接管：拒绝，什么都不改（R35）
            let snapshot = desktop::read(&self.deps.desktop_dirs, settings.applied.as_ref())
                .map_err(desktop_error)?;
            let token = self.token(false)?.unwrap_or_default();
            let base_url = desktop::base_url(self.port()?);
            let inspection = desktop::inspect(
                snapshot.files(),
                &desktop::Ours {
                    token: &token,
                    base_url: &base_url,
                    record: settings.applied.as_ref(),
                },
            )
            .map_err(desktop_error)?;
            if let Some(foreign) = inspection.foreign {
                return Err(desktop_error(DesktopError::Foreign(foreign)));
            }
        }
        if takeover {
            settings.takeover = true;
        }
        let running = self.running()?;
        if running {
            // 在运行：桌面应用的文件等重启生效再写，但路由现在就起好——开关开着、路由却不在，
            // 页面会报「路由没在跑」，和旁边的 `重启生效` 叠在一起（2026-10-01 真机）。起不来就不开
            self.ensure_router_for_claude()?;
        }
        settings.enabled = true;
        self.save_claude(&settings)?;
        if running {
            return Ok(Vec::new());
        }
        self.claude_write(&mut settings)
    }

    /// 切回（拨关）：存下开关；桌面应用不在运行就当场按 R33 还原，在运行记为待生效。返回还原的提示
    pub fn restore_claude(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.restore_claude_locked()
    }

    pub(super) fn restore_claude_locked(&self) -> Result<Vec<String>, AppError> {
        let mut settings = self.load_claude()?;
        settings.enabled = false;
        settings.takeover = false;
        // 认领没记下的那份读不成（令牌读不出、文件不合法、是软链……）就当没有可认领的：
        // 切回不能因此卡住，开关开着时永远能关
        if settings.applied.is_none() && !self.adopt_unrecorded(&mut settings).unwrap_or(false) {
            self.save_claude(&settings)?;
            // 桌面应用里什么都没写过，但拨开时可能已经把路由起好了（在运行时拨开）：Codex 也关着就停掉
            return Ok(self.release_router_for_claude());
        }
        self.save_claude(&settings)?;
        if self.running()? {
            return Ok(Vec::new());
        }
        self.claude_write(&mut settings)
    }

    /// 打开 Claude（R49）：不在运行且有待生效 / 被改掉了 / 上次没做完的，先按 R32 写（写失败就不打开），
    /// 然后 `open -b` 并等到在运行。`acquire` 取调用方的配置写锁（界面是 `AppState.config_lock`）：
    /// 只在写文件那一段持有，等待打开时不持有
    pub fn launch_claude<G>(&self, acquire: impl FnOnce() -> G) -> Result<Vec<String>, AppError> {
        let warnings = {
            let _outer = acquire();
            let _guard = self.guard();
            let mut settings = self.load_claude()?;
            if (settings.enabled || settings.applied.is_some()) && !self.running()? {
                self.claude_write(&mut settings)?
            } else {
                Vec::new()
            }
        };
        (self.deps.desktop_open)().map_err(|e| {
            AppError::new(
                "internal",
                sophia_core::t!("models.claude.openFailed", error = e),
            )
        })?;
        Ok(warnings)
    }

    /// 重启生效（R50）：不在运行 → 同「打开 Claude」；在运行 → 让它退出（最多 15 秒，不强杀）→ 重查不在运行后写
    /// → 不论写没写成都重新打开。`acquire` 同 `launch_claude`：等退出、等打开时不持锁，只在写文件时持有
    pub fn restart_claude<G>(&self, acquire: impl FnOnce() -> G) -> Result<Vec<String>, AppError> {
        if !self.running()? {
            return self.launch_claude(acquire);
        }
        (self.deps.desktop_quit)().map_err(|e| {
            if e.kind() == io::ErrorKind::TimedOut {
                AppError::new("desktop_busy", claude_desktop::busy_message())
            } else {
                AppError::new(
                    "internal",
                    sophia_core::t!("models.desktop.quitFailed", app = "Claude", error = e),
                )
            }
        })?;
        let written = {
            let _outer = acquire();
            let _guard = self.guard();
            self.write_while_quit()
        };
        let opened = (self.deps.desktop_open)();
        match (written, opened) {
            (Ok(warnings), Ok(())) => Ok(warnings),
            (Ok(_), Err(e)) => Err(AppError::new(
                "internal",
                sophia_core::t!("models.claude.reopenFailed", error = e),
            )),
            (Err(error), Ok(())) => Err(AppError::new(
                error.code,
                sophia_core::t!("models.claude.notWrittenReopened", reason = error.message),
            )),
            (Err(error), Err(e)) => Err(AppError::new(
                error.code,
                sophia_core::t!(
                    "models.claude.notWrittenNotReopened",
                    error = e,
                    reason = error.message
                ),
            )),
        }
    }

    /// R50 第 4 步：同一动作里重查确认不在运行，再写
    fn write_while_quit(&self) -> Result<Vec<String>, AppError> {
        if self.running()? {
            return Err(AppError::new(
                "desktop_busy",
                claude_desktop::busy_message(),
            ));
        }
        let mut settings = self.load_claude()?;
        if settings.enabled || settings.applied.is_some() {
            self.claude_write(&mut settings)
        } else {
            Ok(Vec::new())
        }
    }

    /// 退出 Sophia 前把桌面应用切回官方（spec 2026-10-03-gateway-in-app R7）：「开着」不变，下次打开 Sophia 时接上。
    /// 没写着 Sophia 的 → 什么都不做。在运行 → 让它退出（最多 15 秒，不强杀；退不掉 `desktop_busy`）→ 写 → 重新打开；
    /// 没在运行 → 直接写，不替用户打开。`acquire` 同 `restart_claude`：只在写文件那一段持有
    pub(super) fn switch_back_for_quit<G>(
        &self,
        acquire: impl FnOnce() -> G,
    ) -> Result<(), AppError> {
        if self.load_claude()?.applied.is_none() {
            return Ok(());
        }
        let was_running = self.running()?;
        if was_running {
            (self.deps.desktop_quit)().map_err(|e| {
                if e.kind() == io::ErrorKind::TimedOut {
                    AppError::new("desktop_busy", claude_desktop::busy_message())
                } else {
                    AppError::new(
                        "internal",
                        sophia_core::t!("models.desktop.quitFailed", app = "Claude", error = e),
                    )
                }
            })?;
        }
        let written = {
            let _outer = acquire();
            let _guard = self.guard();
            self.restore_files_keeping_choice()
        };
        if !was_running {
            return written;
        }
        match (written, (self.deps.desktop_open)()) {
            (Ok(()), Ok(())) => Ok(()),
            (Ok(()), Err(e)) => Err(AppError::new(
                "internal",
                sophia_core::t!("models.claude.reopenFailed", error = e),
            )),
            (Err(error), Ok(())) => Err(AppError::new(
                error.code,
                sophia_core::t!("models.claude.notWrittenReopened", reason = error.message),
            )),
            (Err(error), Err(e)) => Err(AppError::new(
                error.code,
                sophia_core::t!(
                    "models.claude.notWrittenNotReopened",
                    error = e,
                    reason = error.message
                ),
            )),
        }
    }

    /// 同一动作里重查确认不在运行，按记录切回；`enabled` 不动
    fn restore_files_keeping_choice(&self) -> Result<(), AppError> {
        if self.running()? {
            return Err(AppError::new(
                "desktop_busy",
                claude_desktop::busy_message(),
            ));
        }
        let mut settings = self.load_claude()?;
        self.claude_restore_files(&mut settings).map(|_| ())
    }

    // ----- 状态 -----

    /// 家 `claude` 的状态（R34）：只读，不写、不前滚
    pub(super) fn claude_view(
        &self,
        settings: &ClaudeGatewaySettings,
        port: u16,
    ) -> super::AgentGatewayView {
        let info = (self.deps.desktop_info)();
        let version = info.as_ref().and_then(|i| i.version.clone());
        let running = (self.deps.desktop_running)().unwrap_or(false);
        let token = (self.deps.get_router_token)()
            .ok()
            .flatten()
            .unwrap_or_default();
        let base_url = desktop::base_url(port);
        let mut conflict = String::new();
        let mut listed = Vec::new();
        let inspection = desktop::read(&self.deps.desktop_dirs, settings.applied.as_ref())
            .and_then(|snapshot| {
                listed = profile_models(snapshot.files().profile.as_deref());
                desktop::inspect(
                    snapshot.files(),
                    &desktop::Ours {
                        token: &token,
                        base_url: &base_url,
                        record: settings.applied.as_ref(),
                    },
                )
            });
        let inspection = match inspection {
            Ok(inspection) => Some(inspection),
            Err(error) => {
                conflict = error.to_string();
                None
            }
        };
        let unrecorded_ours = inspection.as_ref().is_some_and(|i| i.unrecorded_ours);
        let foreign = inspection.as_ref().and_then(|i| i.foreign.clone());
        let phase = settings.applied.as_ref().map(|a| a.phase);

        let pending = match (&settings.applied, settings.enabled) {
            (None, true) => true,
            (None, false) => unrecorded_ours,
            (Some(_), false) => true,
            (Some(applied), true) => self
                .desired(settings, port, &token)
                .is_ok_and(|desired| desktop::needs_write(applied, &desired)),
        };
        let drift = settings.enabled
            && foreign.is_none()
            && match phase {
                Some(Phase::Writing) => true,
                Some(Phase::Done) => inspection.as_ref().is_some_and(|i| !i.drift.is_empty()),
                _ => false,
            };
        super::AgentGatewayView {
            agent: Agent::Claude,
            installed: info.is_some(),
            providers: self.provider_views(Agent::Claude, &settings.providers),
            enabled: settings.enabled,
            conflict,
            codex: None,
            claude: Some(ClaudeAgentView {
                profile_models: listed,
                desktop: DesktopView {
                    too_old: version.as_deref().is_some_and(version_too_old),
                    version,
                    managed: claude_desktop::managed(&self.deps.managed_prefs),
                    running,
                    applied: settings.applied.is_some() || unrecorded_ours,
                    pending,
                    needs_restart: running && pending,
                    drift,
                    restore_unfinished: phase == Some(Phase::Restoring),
                    foreign,
                },
            }),
        }
    }
}

//! 家 `workbuddy`（spec #247「四」、#266）：打开 / 关掉 / 改选之后跟上 / 退出时拿掉 / 打开 Sophia 时写回。
//!
//! 写什么由 core 的 `workbuddy_models::models_file` 算（纯函数）；这里决定什么时候写、起路由、写 WorkBuddy 的路由清单。
//! WorkBuddy 监视 `models.json`，改了自动重读，所以没有「重启生效」。
//!
//! 「开着」是用户在模型页的选择（`WorkBuddyGatewaySettings.enabled`），只由开关改变；「写着」是 models.json 里
//! 此刻有 Sophia 的条目。退出、关机、路由起不来只拿掉条目，不改「开着」，下次打开 Sophia 时写回。
use super::{internal, Agent, App, AppError, Untouched};
use sophia_core::atomicfile::{self, FileState};
use sophia_core::codex_models::catalog;
use sophia_core::model_providers::picks::shown_name;
use sophia_core::workbuddy_models::models_file::{self, Entry};
use sophia_core::workbuddy_models::WorkBuddyGatewaySettings;
use std::io;
use std::path::{Path, PathBuf};

/// WorkBuddy 的路由清单，在 Sophia 的数据目录下（同 Claude 的）
const ROUTING_DIR: &str = "gateway";
const ROUTING_FILE: &str = "workbuddy-routing.json";
/// WorkBuddy 的模型配置文件名（在它的数据目录下）
const MODELS_FILE: &str = "models.json";

/// WorkBuddy 的路由清单在数据目录下的位置；路由每个请求重读
pub fn workbuddy_routing_file(data_dir: &Path) -> PathBuf {
    data_dir.join(ROUTING_DIR).join(ROUTING_FILE)
}

/// WorkBuddy 那一家特有的状态
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBuddyAgentView {
    /// models.json 里此刻有 Sophia 的条目
    pub written: bool,
    /// models.json 读不懂（不是合法 JSON、模型列表不是数组……）时的说明；读得懂为空
    pub file_issue: String,
    /// 用户的 models.json 自带可用模型名单（`availableModels`），Sophia 写的有不在名单里的：WorkBuddy 不列出它们。
    /// Sophia 不替用户改名单，只在行下说一声
    pub hidden_by_allow_list: bool,
}

impl App {
    pub(super) fn load_workbuddy(&self) -> Result<WorkBuddyGatewaySettings, AppError> {
        (self.deps.load_workbuddy)().map_err(internal)
    }

    fn save_workbuddy(&self, settings: &WorkBuddyGatewaySettings) -> Result<(), AppError> {
        (self.deps.save_workbuddy)(settings).map_err(internal)
    }

    fn workbuddy_models_path(&self) -> PathBuf {
        self.deps.workbuddy_dir.join(MODELS_FILE)
    }

    fn workbuddy_routing_path(&self) -> PathBuf {
        workbuddy_routing_file(&self.deps.data_dir)
    }

    /// models.json 现在的内容；不存在为 None
    pub(super) fn read_workbuddy_models(&self) -> Result<FileState, AppError> {
        let path = self.workbuddy_models_path();
        atomicfile::read_state(&path).map_err(|_| {
            AppError::new(
                "invalid",
                sophia_core::t!("models.app.fileUnreadable", path = path.display()),
            )
        })
    }

    /// models.json 里此刻有没有 Sophia 的条目；读不出、读不懂的报出原因
    fn workbuddy_written_or_issue(&self) -> Result<bool, String> {
        let state = self.read_workbuddy_models().map_err(|e| e.message)?;
        let FileState::Present(snapshot) = state else {
            return Ok(false);
        };
        if snapshot.bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(false);
        }
        models_file::sophia_ids(&snapshot.bytes)
            .map(|ids| !ids.is_empty())
            .map_err(|e| self.invalid_models_file(e).message)
    }

    /// 用户的可用模型名单挡住了 Sophia 写的条目（读不出、读不懂当没有）
    fn workbuddy_hidden_by_allow_list(&self) -> bool {
        match self.read_workbuddy_models() {
            Ok(FileState::Present(snapshot)) => {
                models_file::hidden_by_allow_list(&snapshot.bytes).unwrap_or(false)
            }
            _ => false,
        }
    }

    /// models.json 里此刻有 Sophia 的条目
    pub(super) fn workbuddy_written(&self) -> bool {
        self.workbuddy_written_or_issue().unwrap_or(false)
    }

    /// 路由的引用计数里 WorkBuddy 算不算开着：开关开着，或文件里还写着 Sophia 的条目
    pub(super) fn workbuddy_on(&self) -> bool {
        self.load_workbuddy().is_ok_and(|s| s.enabled) || self.workbuddy_written()
    }

    fn invalid_models_file(&self, error: sophia_core::jsonedit::Error) -> AppError {
        AppError::new(
            "invalid",
            sophia_core::t!(
                "models.workbuddy.fileInvalid",
                path = self.workbuddy_models_path().display(),
                error = error
            ),
        )
    }

    /// 把 models.json 带到「Sophia 的条目恰是 `entries`」：只增删、校正自己的条目，写前备份、原子替换
    fn apply_workbuddy_models(
        &self,
        entries: &[Entry],
        port: u16,
        token: &str,
    ) -> Result<(), AppError> {
        let path = self.workbuddy_models_path();
        let state = self.read_workbuddy_models()?;
        let current = match &state {
            FileState::Missing => None,
            FileState::Present(snapshot) => Some(snapshot.bytes.as_slice()),
        };
        let Some(bytes) = models_file::plan(current, entries, port, token)
            .map_err(|e| self.invalid_models_file(e))?
        else {
            return Ok(());
        };
        if matches!(state, FileState::Missing) {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    internal(self.workbuddy_write_failed(atomicfile::write_error_text(&path, &e)))
                })?;
            }
        }
        self.put_workbuddy_models(&state, &bytes)
    }

    fn workbuddy_write_failed(&self, error: String) -> String {
        sophia_core::t!(
            "models.app.fileWriteFailed",
            path = self.workbuddy_models_path().display(),
            error = error
        )
    }

    /// 把 `bytes` 写进 models.json；`state` 是算它时读到的那一份。WorkBuddy 自己也会改这个文件：
    /// 中途被改过 → `changed`，不覆盖
    pub(super) fn put_workbuddy_models(
        &self,
        state: &FileState,
        bytes: &[u8],
    ) -> Result<(), AppError> {
        self.replace_user_file(
            &self.workbuddy_models_path(),
            state,
            bytes,
            |error| self.workbuddy_write_failed(error),
            || self.workbuddy_write_failed(sophia_core::t!("common.write.changed")),
        )
    }

    /// 「已选」里给 WorkBuddy 的第三方模型 → models.json 的条目与路由清单
    fn workbuddy_entries(&self) -> Result<(Vec<Entry>, Vec<u8>), AppError> {
        let list = self.load_models()?;
        let mut published = list.published(Agent::WorkBuddy.as_str());
        // 条目的 id 就是显示名（菜单里不带出内部标识）；读不出、读不懂的文件当没有用户条目，写时再报
        let user_ids = match self.read_workbuddy_models() {
            Ok(FileState::Present(snapshot)) => {
                models_file::user_ids(&snapshot.bytes).unwrap_or_default()
            }
            _ => Vec::new(),
        };
        let wanted: Vec<(String, String)> = published
            .iter()
            .map(|p| (shown_name(&p.model), p.slug.clone()))
            .collect();
        for (p, id) in published
            .iter_mut()
            .zip(models_file::entry_ids(&wanted, &user_ids))
        {
            p.slug = id;
        }
        let providers = list.routing_providers(&published);
        let routing = catalog::build_routing(&published, &providers, &[])
            .map_err(|e| AppError::new("invalid", e))?;
        let entries = published
            .iter()
            .map(|p| {
                let provider = list.provider(&p.provider);
                let plain = provider
                    .and_then(|found| found.models.iter().find(|m| m.model.id == p.model.id))
                    .map_or_else(|| p.model.id.clone(), |m| shown_name(&m.model));
                Entry {
                    id: p.slug.clone(),
                    name: shown_name(&p.model),
                    plain_name: plain,
                    vendor: provider.map_or_else(|| p.provider.clone(), |found| found.name.clone()),
                    max_input_tokens: p.model.context_window.filter(|n| *n > 0),
                    supports_images: p.model.vision,
                }
            })
            .collect();
        Ok((entries, routing))
    }

    /// 写进 WorkBuddy：起好路由 → 写路由清单 → 改 models.json。已选为空 → `invalid`
    pub(super) fn write_workbuddy(&self) -> Result<(), AppError> {
        let (entries, routing) = self.workbuddy_entries()?;
        if entries.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.noModelsSelected"),
            ));
        }
        let mut settings = self.load()?;
        self.ensure_router(&mut settings, Untouched::WorkBuddy)?;
        let token = self
            .token(true)?
            .ok_or_else(|| internal(sophia_core::t!("models.app.routerTokenMissing")))?;
        let path = self.workbuddy_routing_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(internal)?;
        }
        self.write_own_file(&path, &routing)?;
        self.apply_workbuddy_models(&entries, settings.port, &token)
    }

    /// 只拿掉 Sophia 写进 WorkBuddy 的东西（条目与路由清单），不动「开着」、不停路由。关机时也走这里
    pub(super) fn remove_workbuddy_entries(&self) -> Result<Vec<String>, AppError> {
        self.apply_workbuddy_models(&[], 0, "")?;
        let mut warnings = Vec::new();
        match std::fs::remove_file(self.workbuddy_routing_path()) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => warnings.push(sophia_core::t!(
                "models.app.deleteFileFailed",
                name = ROUTING_FILE,
                error = e
            )),
        }
        Ok(warnings)
    }

    /// 拿掉条目；三家都不再用路由时停路由
    pub(super) fn unwrite_workbuddy_locked(&self) -> Result<Vec<String>, AppError> {
        let warnings = self.remove_workbuddy_entries()?;
        let enabled = self.load_workbuddy().is_ok_and(|s| s.enabled);
        if !enabled && !self.others_on(Agent::WorkBuddy) {
            (self.deps.router_stop)();
            self.set_notice(None);
        }
        Ok(warnings)
    }

    /// 打开 WorkBuddy 的第三方模型：记下「开着」并写进去；没写成就退回关着、拿掉写了一半的
    pub fn enable_workbuddy(&self) -> Result<(), AppError> {
        let _guard = self.guard();
        let published = self.published_for(Agent::WorkBuddy)?;
        if published.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.noModelsSelected"),
            ));
        }
        self.require_keys(&published)?;
        let mut settings = self.load_workbuddy()?;
        let was = settings.enabled;
        settings.enabled = true;
        self.save_workbuddy(&settings)?;
        self.write_workbuddy().inspect_err(|_| {
            if !was {
                settings.enabled = false;
                let _ = self.save_workbuddy(&settings);
                let _ = self.unwrite_workbuddy_locked();
            }
        })
    }

    /// 关掉 WorkBuddy 的第三方模型：记下「没开着」、拿掉条目
    pub fn restore_workbuddy(&self) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.restore_workbuddy_locked()
    }

    pub(super) fn restore_workbuddy_locked(&self) -> Result<Vec<String>, AppError> {
        let mut settings = self.load_workbuddy()?;
        if settings.enabled {
            settings.enabled = false;
            self.save_workbuddy(&settings)?;
        }
        self.unwrite_workbuddy_locked()
    }

    /// 关机时（`exit_sync`）：只把条目拿掉，不报错
    pub(super) fn remove_workbuddy_for_exit(&self) {
        if !self.workbuddy_written() {
            return;
        }
        if let Err(e) = self.remove_workbuddy_entries() {
            log::warn!("exit: removing Sophia's models from WorkBuddy failed: {e}");
        }
    }

    /// 模型页 WorkBuddy 那一行的状态
    pub(super) fn workbuddy_view(&self) -> (bool, WorkBuddyAgentView) {
        let enabled = self.load_workbuddy().is_ok_and(|s| s.enabled);
        let view = match self.workbuddy_written_or_issue() {
            Ok(written) => WorkBuddyAgentView {
                written,
                file_issue: String::new(),
                hidden_by_allow_list: written && self.workbuddy_hidden_by_allow_list(),
            },
            Err(issue) => WorkBuddyAgentView {
                written: false,
                file_issue: issue,
                hidden_by_allow_list: false,
            },
        };
        (enabled, view)
    }
}

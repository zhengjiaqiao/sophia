//! 各 agent 的「已选」接到全局模型提供商名单（ADR 0003、#259）：勾选 / 取消、整份换掉（排序，#265）、
//! 名单变了之后让已生效的配置跟上，以及路由与试调要的上游和密钥。启用与选是两步（2026-10-08）：
//! 在提供商那里启用不碰任何 agent 的「已选」。
//!
//! 名单与「已选」存在 settings.json 的 `modelProviders`（`sophia_core::model_providers`），这里经 `Deps` 读写；
//! 改完之后各家怎么跟上沿用原来的路：Codex 开着就重写目录与路由清单（`republish`），Claude 见 `commit_claude`。
//! 一家开着、第三方模型却一个都不剩了 → 关掉这一家（同「× 掉最后一个＝关掉」）。
use super::{internal, Agent, App, AppError};
use crate::router::{KeyVerdict, Protocol};
use serde_json::value::RawValue;
use sophia_core::codex_models::catalog::{self, Published, Slot};
use sophia_core::model_providers::picks::{AgentModels, OfficialModel};
use sophia_core::model_providers::{ModelProviders, ModelRef};

/// 试调一个模型要用的一切。含密钥：只在内存里递给联网的那一步，不打印、不序列化
pub struct ProbeTarget {
    /// 路由清单里写的那个上游基址（探明的接口基址优先，没有退到用户填的地址）
    pub api_base: String,
    pub protocol: Protocol,
    pub model: String,
    pub key: String,
}

/// 故意不派生 Debug：免得哪天被 `{:?}` 连密钥一起打出来
impl std::fmt::Debug for ProbeTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProbeTarget")
            .field("api_base", &self.api_base)
            .field("protocol", &self.protocol)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl App {
    /// 全局名单与各 agent 的「已选」
    pub(super) fn load_models(&self) -> Result<ModelProviders, AppError> {
        (self.deps.load_models)().map_err(internal)
    }

    /// 在设置锁里读 → 改 → 写；`change` 返回假就不写
    pub(super) fn change_models(
        &self,
        mut change: impl FnMut(&mut ModelProviders) -> bool,
    ) -> Result<(), AppError> {
        (self.deps.change_models)(&mut change).map_err(internal)
    }

    /// Codex 官方目录里列出的模型（slug, 显示名）；读不到为空
    pub(super) fn codex_officials(&self) -> Vec<(String, String)> {
        catalog::load_native(&self.deps.codex_home, || self.bundled())
            .map(|native| catalog::listed_natives(&native.models))
            .unwrap_or_default()
    }

    /// `codex debug models --bundled` 的输出只跑一次（要起一个进程），之后用记下的
    pub(super) fn bundled(&self) -> std::io::Result<Vec<u8>> {
        let mut cached = self
            .bundled_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(bytes) = cached.as_ref() {
            return Ok(bytes.clone());
        }
        let bytes = (self.deps.bundled)()?;
        *cached = Some(bytes.clone());
        Ok(bytes)
    }

    /// 这一家此刻要写进配置的第三方模型（按「已选」顺序）
    pub(super) fn published_for(&self, agent: Agent) -> Result<Vec<Published>, AppError> {
        Ok(self.load_models()?.published(agent.as_str()))
    }

    /// Codex 合并目录的排法：先把新出现的官方模型并进「已选」并存下（Codex 升级带来的默认选上、排最后），
    /// 再按「已选」给出官方与第三方穿插的顺序
    pub(super) fn codex_order(
        &self,
        native: &[Box<RawValue>],
    ) -> Result<(Vec<Slot>, Vec<Published>), AppError> {
        let officials: Vec<String> = catalog::listed_natives(native)
            .into_iter()
            .map(|(slug, _)| slug)
            .collect();
        let agent = Agent::Codex.as_str();
        if self.load_models()?.clone().sync_official(agent, &officials) {
            self.change_models(|list| list.sync_official(agent, &officials))?;
        }
        let list = self.load_models()?;
        let published = list.published(agent);
        let order = list
            .effective_picks(agent, Some(&officials))
            .into_iter()
            .filter_map(|r| {
                if r.is_official() {
                    return Some(Slot::Native(r.model));
                }
                published
                    .iter()
                    .find(|p| p.provider == r.provider && p.model.id == r.model)
                    .cloned()
                    .map(Slot::Own)
            })
            .collect();
        Ok((order, published))
    }

    /// 这一家的密钥：有就给出来（去掉首尾空白）；没有为 `Ok(None)`；读不出为 `Err(原因)`
    pub(super) fn key_of(&self, provider: &str) -> Result<Option<String>, String> {
        (self.deps.get_key)(provider)
            .map(|key| key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()))
    }

    /// 要写进配置的模型用到的每一家都要有读得出的密钥；没有、读不出各说各的，点名是哪一家
    pub(super) fn require_keys(&self, published: &[Published]) -> Result<(), AppError> {
        let list = self.load_models()?;
        let mut checked: Vec<&str> = Vec::new();
        for p in published {
            if checked.contains(&p.provider.as_str()) {
                continue;
            }
            checked.push(&p.provider);
            let name = list
                .provider(&p.provider)
                .map_or_else(|| p.provider.clone(), |found| found.name.clone());
            match self.key_of(&p.provider) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(AppError::new(
                        "invalid",
                        sophia_core::t!("models.app.providerNoKey", name = name),
                    ))
                }
                Err(reason) => {
                    return Err(AppError::new(
                        "invalid",
                        sophia_core::t!("models.app.keyUnreadable", name = name, reason = reason),
                    ))
                }
            }
        }
        Ok(())
    }

    /// 试调这一家的一个模型要用的上游地址、协议与密钥（同路由转发时的样子）。缺什么报 `invalid`，不联网
    pub fn probe_target(&self, provider: &str, model: &str) -> Result<ProbeTarget, AppError> {
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.probe.noModel"),
            ));
        }
        let list = self.load_models()?;
        let found = list.provider(provider).ok_or_else(|| {
            AppError::new(
                "invalid",
                sophia_core::t!("models.app.unknownProvider", id = provider),
            )
        })?;
        let key = match self.key_of(provider) {
            Ok(Some(key)) => key,
            Ok(None) => {
                return Err(AppError::new(
                    "invalid",
                    sophia_core::t!("models.app.noKey"),
                ))
            }
            Err(reason) => {
                return Err(AppError::new(
                    "invalid",
                    sophia_core::t!(
                        "models.app.keyUnreadable",
                        name = found.name,
                        reason = reason
                    ),
                ))
            }
        };
        Ok(ProbeTarget {
            api_base: found.upstream_base().to_owned(),
            protocol: if found.protocol() == "responses" {
                Protocol::Responses
            } else {
                Protocol::Chat
            },
            model: model.to_owned(),
            key,
        })
    }

    /// 一家的「已选」或名单变了之后让已生效的配置跟上：开着、第三方模型却一个都不剩 → 关掉这一家；
    /// 开着就照原来的路重写（Codex 目录与路由清单；Claude 在运行时记为待生效）。关着只存，打开时就有。
    /// `selection`：这次是改选模型——Codex 重新判断接法（spec 2026-10-03-codex-hookup-auto R4）；
    /// 名单变了（地址、删一家）不重新判断
    fn follow_picks(&self, agent: Agent, selection: bool) -> Result<Vec<String>, AppError> {
        let empty = self.published_for(agent)?.is_empty();
        match agent {
            Agent::Codex => {
                let mut settings = self.load()?;
                if !self.enabled(&settings) {
                    return Ok(Vec::new());
                }
                if empty {
                    return self.restore_locked();
                }
                self.republish(&mut settings, selection)?;
                self.save(&settings)?;
                Ok(Vec::new())
            }
            Agent::Claude => {
                let mut settings = self.load_claude()?;
                if settings.enabled && empty {
                    return self.restore_claude_locked();
                }
                self.commit_claude(&mut settings, true)
            }
            // WorkBuddy 改了文件自动重读：开着就当场按「已选」（含顺序）重写 models.json
            Agent::WorkBuddy => {
                if !self.load_workbuddy()?.enabled {
                    return Ok(Vec::new());
                }
                if empty {
                    return self.restore_workbuddy_locked();
                }
                self.write_workbuddy()?;
                Ok(Vec::new())
            }
        }
    }

    // ----- 动作 -----

    /// 在选模型浮层里勾上（追加到末尾）或取消一个；开着的那一家当场跟上。返回给用户的提示
    pub fn pick(&self, agent: Agent, model: &ModelRef, on: bool) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        let mut outcome = Ok(false);
        let mut before = Vec::new();
        self.change_models(|list| {
            before = list.picked(agent.as_str()).to_vec();
            outcome = list.pick(agent.as_str(), model, on);
            matches!(outcome, Ok(true))
        })?;
        let changed = outcome.map_err(|e| AppError::new(e.code(), e.to_string()))?;
        if !changed {
            return Ok(Vec::new());
        }
        self.follow_or_undo(agent, before)
    }

    /// 整份换掉这一家的「已选」（排序、恢复默认顺序，#265）；开着的那一家当场跟上
    pub fn set_picks(&self, agent: Agent, picks: Vec<ModelRef>) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        let mut outcome = Ok(());
        let mut before = Vec::new();
        self.change_models(|list| {
            before = list.picked(agent.as_str()).to_vec();
            outcome = list.set_picked(agent.as_str(), picks.clone());
            outcome.is_ok()
        })?;
        outcome.map_err(|e| AppError::new(e.code(), e.to_string()))?;
        self.follow_or_undo(agent, before)
    }

    /// 排序（#265）：浮层「已选」里看得见的几项的新顺序（拖动、⌥↑ / ⌥↓），看不见的原地不动；开着的那一家当场跟上
    pub fn reorder_picks(
        &self,
        agent: Agent,
        order: Vec<ModelRef>,
    ) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        let mut outcome = Ok(false);
        let mut before = Vec::new();
        self.change_models(|list| {
            before = list.picked(agent.as_str()).to_vec();
            outcome = list.reorder(agent.as_str(), &order);
            matches!(outcome, Ok(true))
        })?;
        let changed = outcome.map_err(|e| AppError::new(e.code(), e.to_string()))?;
        if !changed {
            return Ok(Vec::new());
        }
        self.follow_or_undo(agent, before)
    }

    /// 恢复默认顺序（#265）：官方的在前、按官方目录自己的顺序，第三方的按启用先后；开着的那一家当场跟上
    pub fn restore_order(&self, agent: Agent) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        let officials: Vec<String> = match agent {
            Agent::Codex => self
                .codex_officials()
                .into_iter()
                .map(|(slug, _)| slug)
                .collect(),
            // WorkBuddy 的官方模型它自己管、不进「已选」
            Agent::Claude | Agent::WorkBuddy => Vec::new(),
        };
        let mut changed = false;
        let mut before = Vec::new();
        self.change_models(|list| {
            before = list.picked(agent.as_str()).to_vec();
            changed = list.restore_order(agent.as_str(), &officials);
            changed
        })?;
        if !changed {
            return Ok(Vec::new());
        }
        self.follow_or_undo(agent, before)
    }

    /// 改选之后跟上；跟不上（路由起不来、设置冲突……）就把这一家的「已选」退回改之前，不留下没生效的勾选
    fn follow_or_undo(&self, agent: Agent, before: Vec<ModelRef>) -> Result<Vec<String>, AppError> {
        self.follow_picks(agent, true).inspect_err(|_| {
            let _ = self.change_models(|list| {
                if let Some(picks) = list.picks.get_mut(agent.as_str()) {
                    picks.picked = before.clone();
                }
                true
            });
        })
    }

    /// 提供商名单变了（删了一家、取消启用、改了地址、重拉后接口基址变了）之后：开着的每一家照现在的名单重写，
    /// 第三方模型一个不剩的关掉。各家互不连累，没跟上的原因收进提示
    pub fn models_changed(&self) -> Vec<String> {
        let _guard = self.guard();
        let mut warnings = Vec::new();
        for agent in Agent::ALL {
            match self.follow_picks(agent, false) {
                Ok(more) => warnings.extend(more),
                Err(error) => warnings.push(format!("{}: {}", agent.label(), error.message)),
            }
        }
        warnings
    }

    /// 真实调用（路由转发的请求、启用前的试调）对这一家密钥的结论（#144）：被拒记成「密钥无效」并带上原文，
    /// 成功清掉真实调用记下的那一条。状态没变不写；这一家已经不在了不算错。返回写没写
    pub fn record_key_verdict(
        &self,
        provider: &str,
        verdict: KeyVerdict,
    ) -> Result<bool, AppError> {
        let _guard = self.guard();
        let rejected = match verdict {
            KeyVerdict::Rejected { detail } => Some(detail),
            KeyVerdict::Accepted => None,
        };
        let mut changed = false;
        self.change_models(|list| {
            changed = list.record_key_verdict(provider, rejected.clone());
            changed
        })?;
        Ok(changed)
    }

    /// 某一家的选模型视图（模型页那一行与浮层）
    pub(super) fn models_view(&self, agent: Agent, codex_signed_in: bool) -> AgentModels {
        let list = self.load_models().unwrap_or_default();
        let (officials, usable) = match agent {
            Agent::Codex => (
                self.codex_officials()
                    .into_iter()
                    .map(|(id, display_name)| OfficialModel { id, display_name })
                    .collect(),
                codex_signed_in,
            ),
            // Claude 桌面应用：开关开着（接第三方模型）时官方模型用不了
            Agent::Claude => (Vec::new(), !self.load_claude().is_ok_and(|s| s.enabled)),
            Agent::WorkBuddy => (Vec::new(), false),
        };
        sophia_core::model_providers::picks::agent_models(&list, agent.as_str(), &officials, usable)
    }
}

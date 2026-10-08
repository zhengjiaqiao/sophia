//! 全局模型提供商名单（ADR 0003、spec #247「三」）：所有 agent 共用一份，存在 settings.json 的 `modelProviders`。
//! 每家提供商先「启用」要用的模型（一家常列出上百个），agent 只从已启用的里「选」（选在 #259）。
//!
//! - 数据：名称（全局唯一，不分大小写）、地址、协议、密钥引用（＝`id`，密钥在 `secrets.json` 的
//!   `providers.global.<id>`，见 `keystore`）、模型列表（只放对话模型）与每个已启用模型的启用来源与先后。
//! - 本文件是纯数据与在内存里的改动，无 IO；读写 settings.json 与密钥文件在 [`book`]。
//! - 旧版按 agent 存的网关（`codexGateway.providers` / `claudeGateway.providers`）不迁移到这里。
pub mod book;
pub mod defaults;
pub mod picks;
pub mod view;

use crate::codex_models::catalog::Model;
use crate::codex_models::settings::{address_short_name, new_provider_id, UnreachableReason};
use defaults::{default_enable, is_chat_model, DefaultRule};
use serde::{Deserialize, Serialize};
use std::fmt;

const PROTOCOL_CHAT: &str = "chat";
const PROTOCOL_RESPONSES: &str = "responses";
/// 名称取不到时的兜底（地址解析不出主机名，理论上 `clean_base_url` 之后不会发生）
const FALLBACK_NAME: &str = "provider";

/// settings.json 里的 `modelProviders`
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelProviders {
    pub providers: Vec<Provider>,
    /// 最近一次启用用掉的序号；每启用一个模型加一，记在那个模型上（「恢复默认顺序」按启用先后排，#259）
    pub enable_seq: u64,
    /// 各 agent 的「已选」，按 agent id（`picks::MODEL_AGENTS`）
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub picks: std::collections::BTreeMap<String, picks::AgentPicks>,
}

/// 一家模型提供商
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    /// 创建时由名称生成，之后不变：路由里的上游 id、模型引用里的提供商、密钥文件里这一家密钥的键
    pub id: String,
    /// 显示名，全局唯一（不分大小写），可以改：提供商列表、「选模型」的组头、同名模型的区分后缀都用它
    pub name: String,
    /// 用户填的（或预设给的）地址，已经过 `clean_base_url`
    pub base_url: String,
    /// 拉模型时探明的接口基址；换地址后作废
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    /// `chat`（默认）或 `responses`；读取用 [`Provider::protocol`]
    pub protocol: String,
    /// 从哪个提供商预设建的（`provider_presets` 的 id）；手填地址的没有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// 接口列出的对话模型（非对话模型不进来）与手填的模型，按接口顺序，手填的在后
    pub models: Vec<ProviderModel>,
    /// 添加时用的默认启用规则；用户之后自己启用或取消过任何一个就清掉（那时已不是「默认」）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_rule: Option<DefaultRule>,
    /// 上次拉模型失败的原因种类；拉取成功或换地址后清空（与旧网关同一套）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable: Option<UnreachableReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable_detail: Option<String>,
    /// `unreachable` 是真实调用（试调）被拒了密钥记下的：拉列表成功不清它，换密钥或之后一次调用成功才清（#144）
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub key_rejected_on_call: bool,
}

impl Default for Provider {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            api_base: None,
            protocol: PROTOCOL_CHAT.into(),
            preset: None,
            models: Vec::new(),
            default_rule: None,
            unreachable: None,
            unreachable_detail: None,
            key_rejected_on_call: false,
        }
    }
}

/// 提供商列表里的一个模型
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    #[serde(flatten)]
    pub model: Model,
    /// 启用了就有：谁启用的、第几个启用的；没启用为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<Enabled>,
}

/// 一个已启用模型的启用来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enabled {
    pub by: EnabledBy,
    /// 启用先后（`ModelProviders::enable_seq` 发的号，越小越早）
    pub seq: u64,
}

/// 谁启用的
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnabledBy {
    /// 加提供商时按默认规则启用的
    Default,
    /// 用户在「启用模型」里勾的，或手填 id 试通后启用的
    User,
}

/// 一个模型的引用：哪一家的哪个模型（agent 的「已选」存的就是它，#259）
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

impl ProviderModel {
    pub fn is_enabled(&self) -> bool {
        self.enabled.is_some()
    }
}

impl Provider {
    /// 归一化后的协议：只有明确写了 `responses` 才是，其余一律 `chat`
    pub fn protocol(&self) -> &'static str {
        if self.protocol == PROTOCOL_RESPONSES {
            PROTOCOL_RESPONSES
        } else {
            PROTOCOL_CHAT
        }
    }

    /// 路由转发与试调用的基址：拉模型时探明的接口基址优先
    pub fn upstream_base(&self) -> &str {
        match self.api_base.as_deref() {
            Some(base) if !base.is_empty() => base,
            _ => &self.base_url,
        }
    }

    /// 已启用的模型，保持列表顺序
    pub fn enabled_models(&self) -> impl Iterator<Item = &ProviderModel> {
        self.models.iter().filter(|m| m.is_enabled())
    }

    pub fn enabled_count(&self) -> usize {
        self.enabled_models().count()
    }

    fn model_mut(&mut self, id: &str) -> Option<&mut ProviderModel> {
        self.models.iter_mut().find(|m| m.model.id == id)
    }

    /// 真实调用被拒了密钥：记成「密钥无效」（同旧网关）；返回改没改
    pub fn mark_key_rejected(&mut self, detail: Option<String>) -> bool {
        if self.key_rejected_on_call && self.unreachable == Some(UnreachableReason::Auth) {
            return false;
        }
        self.unreachable = Some(UnreachableReason::Auth);
        self.unreachable_detail = detail.filter(|d| !d.trim().is_empty());
        self.key_rejected_on_call = true;
        true
    }

    /// 换了密钥，或之后一次真实调用成功：清掉真实调用记下的「密钥无效」；返回改没改
    pub fn clear_key_rejection(&mut self) -> bool {
        if !self.key_rejected_on_call {
            return false;
        }
        self.unreachable = None;
        self.unreachable_detail = None;
        self.key_rejected_on_call = false;
        true
    }
}

/// 名单上的改动做不成
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// 已经有一家叫这个名字（不分大小写）：带上那一家现在的名字
    NameTaken(String),
    /// 没有这一家（被删了、id 写错）
    Unknown(String),
    /// 模型 id 是空的
    NoModel,
    /// 这个模型此刻不能给这个 agent 选（没启用、提供商没了、协议合不上）：带模型 id
    NotPickable(String),
    /// 读写 settings.json 或密钥文件失败；附原因（当前语言）
    Storage(String),
}

impl ProviderError {
    /// 命令层的错误代码（docs/gateway-commands.md 的那一套）
    pub fn code(&self) -> &'static str {
        match self {
            ProviderError::NameTaken(_) => "conflict",
            ProviderError::Unknown(_) | ProviderError::NoModel | ProviderError::NotPickable(_) => {
                "invalid"
            }
            ProviderError::Storage(_) => "internal",
        }
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            ProviderError::NameTaken(name) => crate::t!("models.providers.nameTaken", name = name),
            ProviderError::Unknown(id) => crate::t!("models.providers.unknown", id = id),
            ProviderError::NoModel => crate::t!("models.probe.noModel"),
            ProviderError::NotPickable(model) => {
                crate::t!("models.picks.notPickable", model = model)
            }
            ProviderError::Storage(reason) => reason.clone(),
        };
        f.write_str(&text)
    }
}

impl std::error::Error for ProviderError {}

/// 新加一家要的东西（地址已经过 `clean_base_url`，模型列表是拿密钥拉到的）
#[derive(Debug, Clone, Default)]
pub struct NewProvider {
    /// 用户填的名称；空的取地址主体（`relay.example.com` → `relay`）
    pub name: String,
    pub base_url: String,
    /// 拉模型时探明的接口基址
    pub api_base: String,
    /// `chat` / `responses`（预设给的；手填的是 `chat`）
    pub protocol: String,
    pub preset: Option<String>,
    /// 接口返回的模型（还没滤掉非对话模型）
    pub fetched: Vec<Model>,
    /// 预设的推荐模型（没有为空）
    pub recommended: Vec<String>,
    /// 添加弹窗里用户勾定的启用列表（画板第 9 屏）；None＝按默认规则。列表里没有的 id 是手填试通的，作为手填模型加进来
    pub chosen: Option<Vec<String>>,
}

/// 添加弹窗里填好密钥后拉到的列表（不进名单）：对话模型、按默认规则先勾上哪些、用了哪条规则
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub models: Vec<Model>,
    pub enabled: Vec<String>,
    pub rule: DefaultRule,
}

/// 按添加时的同一套口径（滤掉非对话模型、去重、默认启用规则）算出给弹窗看的列表；纯函数
pub fn preview(fetched: Vec<Model>, recommended: &[String]) -> Preview {
    let models = chat_models(fetched);
    let ids: Vec<String> = models.iter().map(|m| m.id.clone()).collect();
    let decision = default_enable(recommended, &ids);
    Preview {
        models,
        enabled: decision.enabled,
        rule: decision.rule,
    }
}

/// 加完一家的结论：界面据此写提示条（启用了几个、按哪条规则、要不要直接打开「启用模型」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub id: String,
    pub name: String,
    pub rule: DefaultRule,
    /// 默认启用了几个
    pub enabled: usize,
    /// 列表里的对话模型共几个
    pub total: usize,
}

/// 名称的比较口径：去首尾空白、不分大小写
fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// 两份 id 列表是不是同一组（不看顺序；两边都已去重）
fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|id| b.contains(id))
}

/// 名称为空时用的默认名称：地址的主体
pub fn default_name(base_url: &str) -> String {
    address_short_name(base_url).unwrap_or_else(|| FALLBACK_NAME.to_owned())
}

impl ModelProviders {
    pub fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|p| p.id == id)
    }

    fn provider_mut(&mut self, id: &str) -> Result<&mut Provider, ProviderError> {
        self.providers
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| ProviderError::Unknown(id.to_owned()))
    }

    /// 已经叫这个名字的那一家（`except` 之外）；没有为 None。名称为空不查
    pub fn name_taken(&self, name: &str, except: Option<&str>) -> Option<&Provider> {
        if name.trim().is_empty() {
            return None;
        }
        self.providers
            .iter()
            .find(|p| Some(p.id.as_str()) != except && same_name(&p.name, name))
    }

    fn ensure_name_free(&self, name: &str, except: Option<&str>) -> Result<(), ProviderError> {
        match self.name_taken(name, except) {
            Some(taken) => Err(ProviderError::NameTaken(taken.name.clone())),
            None => Ok(()),
        }
    }

    fn next_seq(&mut self) -> u64 {
        self.enable_seq += 1;
        self.enable_seq
    }

    /// 新加一家（只在内存里）：定名称（空的取地址主体）、查同名、生成 id、滤掉非对话模型、按默认规则启用
    pub fn add(&mut self, new: NewProvider) -> Result<Added, ProviderError> {
        let name = match new.name.trim() {
            "" => default_name(&new.base_url),
            typed => typed.to_owned(),
        };
        self.ensure_name_free(&name, None)?;
        let taken: Vec<&str> = self.providers.iter().map(|p| p.id.as_str()).collect();
        let id = new_provider_id(&name, &taken);
        let mut listed = chat_models(new.fetched);
        let ids: Vec<String> = listed.iter().map(|m| m.id.clone()).collect();
        let decision = default_enable(&new.recommended, &ids);
        // 用户在弹窗里勾定的：和默认那几个一样就当没改（仍记成默认）；不一样就照用户的，记成用户启用
        let chosen = new.chosen.map(|chosen| {
            let mut seen = std::collections::HashSet::new();
            chosen
                .into_iter()
                .map(|id| id.trim().to_owned())
                .filter(|id| !id.is_empty() && seen.insert(id.clone()))
                .collect::<Vec<String>>()
        });
        let (enabled_ids, by) = match chosen {
            Some(chosen) if !same_set(&chosen, &decision.enabled) => {
                for typed in chosen.iter().filter(|id| !ids.contains(id)) {
                    listed.push(Model {
                        id: typed.clone(),
                        manual: true,
                        ..Model::default()
                    });
                }
                (chosen, EnabledBy::User)
            }
            _ => (decision.enabled.clone(), EnabledBy::Default),
        };
        let mut models = Vec::with_capacity(listed.len());
        for model in listed {
            let enabled = enabled_ids.contains(&model.id).then(|| Enabled {
                by,
                seq: self.next_seq(),
            });
            models.push(ProviderModel { model, enabled });
        }
        let enabled_count = models.iter().filter(|m| m.is_enabled()).count();
        let api_base = new.api_base.trim().trim_end_matches('/');
        let added = Added {
            id: id.clone(),
            name: name.clone(),
            rule: decision.rule,
            enabled: enabled_count,
            total: models.len(),
        };
        self.providers.push(Provider {
            id,
            name,
            base_url: new.base_url,
            api_base: (!api_base.is_empty()).then(|| api_base.to_owned()),
            protocol: if new.protocol == PROTOCOL_RESPONSES {
                PROTOCOL_RESPONSES.into()
            } else {
                PROTOCOL_CHAT.into()
            },
            preset: new.preset.filter(|p| !p.trim().is_empty()),
            models,
            default_rule: (by == EnabledBy::Default).then_some(decision.rule),
            ..Provider::default()
        });
        Ok(added)
    }

    /// 改名称与地址（只在内存里）。名称为 None 或空不改；地址变了，旧地址探明的基址与连不上的结论作废。
    /// 返回地址变没变
    pub fn edit(
        &mut self,
        id: &str,
        name: Option<&str>,
        base_url: &str,
    ) -> Result<bool, ProviderError> {
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        if let Some(name) = name {
            self.ensure_name_free(name, Some(id))?;
        }
        let provider = self.provider_mut(id)?;
        if let Some(name) = name {
            provider.name = name.to_owned();
        }
        let changed = provider.base_url != base_url;
        if changed {
            provider.base_url = base_url.to_owned();
            provider.api_base = None;
            provider.unreachable = None;
            provider.unreachable_detail = None;
            provider.key_rejected_on_call = false;
        }
        Ok(changed)
    }

    /// 并入重新拉到的模型（只在内存里）：非对话模型不进来；新出现的不启用；已启用的与手填的这次没返回也留着
    /// （一次网络抖动不该丢掉启用）；别的没返回的去掉。网关给了上下文长度就用新的。返回接口基址变没变
    pub fn merge_fetched(
        &mut self,
        id: &str,
        fetched: Vec<Model>,
        api_base: &str,
    ) -> Result<bool, ProviderError> {
        let provider = self.provider_mut(id)?;
        if !provider.key_rejected_on_call {
            provider.unreachable = None;
            provider.unreachable_detail = None;
        }
        let api_base = api_base.trim().trim_end_matches('/');
        let base_changed = !api_base.is_empty() && provider.api_base.as_deref() != Some(api_base);
        if base_changed {
            provider.api_base = Some(api_base.to_owned());
        }
        let listed = chat_models(fetched);
        let mut merged: Vec<ProviderModel> = Vec::with_capacity(listed.len());
        for item in listed {
            match provider.models.iter().find(|m| m.model.id == item.id) {
                Some(existing) => {
                    let mut kept = existing.clone();
                    if item.context_window.is_some() {
                        kept.model.context_window = item.context_window;
                    }
                    merged.push(kept);
                }
                None => merged.push(ProviderModel {
                    model: item,
                    enabled: None,
                }),
            }
        }
        for old in &provider.models {
            let returned = merged.iter().any(|m| m.model.id == old.model.id);
            if !returned && (old.is_enabled() || old.model.manual) {
                merged.push(old.clone());
            }
        }
        provider.models = merged;
        Ok(base_changed)
    }

    /// 用户启用或取消启用列表里的一个模型（只在内存里）。之后这一家不再算「默认启用」。
    /// 取消启用手填的模型＝从列表移除（它只因用户要才在列表里）。已经是那个状态不算错
    pub fn set_enabled(&mut self, id: &str, model_id: &str, on: bool) -> Result<(), ProviderError> {
        let model_id = model_id.trim();
        let seq = self.enable_seq + 1;
        let provider = self.provider_mut(id)?;
        let Some(model) = provider.model_mut(model_id) else {
            return Err(ProviderError::NoModel);
        };
        let consumed = match (on, model.enabled) {
            (true, None) => {
                model.enabled = Some(Enabled {
                    by: EnabledBy::User,
                    seq,
                });
                true
            }
            (false, Some(_)) => {
                model.enabled = None;
                if model.model.manual {
                    provider.models.retain(|m| m.model.id != model_id);
                }
                false
            }
            _ => return Ok(()),
        };
        provider.default_rule = None;
        if consumed {
            self.enable_seq = seq;
        } else {
            self.prune_picks();
        }
        Ok(())
    }

    /// 手填一个模型 id 并启用（调用方已经试调通了；只在内存里）。已在列表里就只启用它
    pub fn enable_typed(&mut self, id: &str, model_id: &str) -> Result<(), ProviderError> {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            return Err(ProviderError::NoModel);
        }
        let provider = self.provider_mut(id)?;
        if provider.model_mut(model_id).is_none() {
            provider.models.push(ProviderModel {
                model: Model {
                    id: model_id.to_owned(),
                    manual: true,
                    ..Model::default()
                },
                enabled: None,
            });
        }
        self.set_enabled(id, model_id, true)
    }

    /// 接管 agents-manager 时带过来的那一家（只在内存里）：地址相同的那一家（重复接管）换成带来的模型列表，
    /// 否则新加一家，名称用 `name`、撞了就加序号。带来时勾着的模型启用，并按原顺序选进 `agent`。返回它的 id
    pub fn adopt(
        &mut self,
        agent: &str,
        name: &str,
        base_url: &str,
        api_base: Option<String>,
        protocol: &str,
        models: Vec<(Model, bool)>,
    ) -> String {
        let id = match self.providers.iter().position(|p| p.base_url == base_url) {
            Some(at) => self.providers[at].id.clone(),
            None => {
                let taken: Vec<&str> = self.providers.iter().map(|p| p.id.as_str()).collect();
                let id = new_provider_id(name, &taken);
                let shown = (1..)
                    .map(|n| {
                        if n == 1 {
                            name.to_owned()
                        } else {
                            format!("{name} {n}")
                        }
                    })
                    .find(|candidate| self.name_taken(candidate, None).is_none())
                    .expect("an unbounded counter always finds a free name");
                self.providers.push(Provider {
                    id: id.clone(),
                    name: shown,
                    base_url: base_url.to_owned(),
                    ..Provider::default()
                });
                id
            }
        };
        let mut picked = Vec::new();
        let mut list = Vec::with_capacity(models.len());
        for (model, selected) in models {
            let enabled = selected.then(|| Enabled {
                by: EnabledBy::User,
                seq: self.next_seq(),
            });
            if selected {
                picked.push(ModelRef::new(&id, &model.id));
            }
            list.push(ProviderModel { model, enabled });
        }
        if let Some(provider) = self.providers.iter_mut().find(|p| p.id == id) {
            provider.api_base = api_base.filter(|b| !b.trim().is_empty());
            provider.protocol = if protocol == PROTOCOL_RESPONSES {
                PROTOCOL_RESPONSES.into()
            } else {
                PROTOCOL_CHAT.into()
            };
            provider.models = list;
            provider.default_rule = None;
        }
        self.prune_picks();
        for r in &picked {
            let _ = self.pick(agent, r, true);
        }
        id
    }

    /// 接管时那一家会落到哪个 id（只看，不改）：地址相同的那一家，否则按名称新起的 id
    pub fn adopt_target(&self, name: &str, base_url: &str) -> String {
        match self.providers.iter().find(|p| p.base_url == base_url) {
            Some(same) => same.id.clone(),
            None => {
                let taken: Vec<&str> = self.providers.iter().map(|p| p.id.as_str()).collect();
                new_provider_id(name, &taken)
            }
        }
    }

    /// 删掉一家（只在内存里），交回被删的那一家
    pub fn remove(&mut self, id: &str) -> Result<Provider, ProviderError> {
        let index = self
            .providers
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| ProviderError::Unknown(id.to_owned()))?;
        let removed = self.providers.remove(index);
        self.prune_picks();
        Ok(removed)
    }

    /// 记下拉模型失败的原因；真实调用已经记了「密钥无效」时不顶掉它（#144）
    pub fn record_unreachable(
        &mut self,
        id: &str,
        reason: UnreachableReason,
        detail: Option<String>,
    ) -> Result<(), ProviderError> {
        let provider = self.provider_mut(id)?;
        if !provider.key_rejected_on_call {
            provider.unreachable = Some(reason);
            provider.unreachable_detail = detail;
        }
        Ok(())
    }

    /// 存了新密钥：真实调用记下的「密钥无效」是对旧密钥的结论
    pub fn clear_key_rejection(&mut self, id: &str) -> Result<bool, ProviderError> {
        Ok(self.provider_mut(id)?.clear_key_rejection())
    }

    /// 试调对密钥的结论（被拒 / 通了）；这一家不在了不算错。返回改没改
    pub fn record_key_verdict(&mut self, id: &str, rejected: Option<String>) -> bool {
        let Ok(provider) = self.provider_mut(id) else {
            return false;
        };
        match rejected {
            Some(detail) => provider.mark_key_rejected(Some(detail)),
            None => provider.clear_key_rejection(),
        }
    }
}

/// 滤掉非对话模型、空 id 与重复的，按原顺序；手填的不在这里过（它们不经接口来）
fn chat_models(fetched: Vec<Model>) -> Vec<Model> {
    let mut seen = std::collections::HashSet::new();
    fetched
        .into_iter()
        .filter_map(|mut m| {
            m.id = m.id.trim().to_owned();
            m.context_window = m.context_window.filter(|n| *n > 0);
            (!m.id.is_empty() && is_chat_model(&m.id) && seen.insert(m.id.clone())).then_some(m)
        })
        .collect()
}

/// 哪几个 agent 选了这一家的模型（提供商行的「N 个 agent」、删除确认里点名的 agent）。
/// `picks` 是每个 agent 的「已选」（#259 给）；按 `picks` 的顺序，不重复
pub fn agents_using<'a>(
    provider: &str,
    picks: impl IntoIterator<Item = (&'a str, &'a [ModelRef])>,
) -> Vec<&'a str> {
    picks
        .into_iter()
        .filter(|(_, refs)| refs.iter().any(|r| r.provider == provider))
        .map(|(agent, _)| agent)
        .collect()
}

/// 哪几个 agent 选了这个模型（取消启用前的确认据它点名，#259 给 `picks`）
pub fn agents_using_model<'a>(
    model: &ModelRef,
    picks: impl IntoIterator<Item = (&'a str, &'a [ModelRef])>,
) -> Vec<&'a str> {
    picks
        .into_iter()
        .filter(|(_, refs)| refs.contains(model))
        .map(|(agent, _)| agent)
        .collect()
}

#[cfg(test)]
mod tests;

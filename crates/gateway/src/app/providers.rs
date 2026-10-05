//! 按家的网关增删改、拉模型、勾选，以及两家之间的同步与「带过来」（spec R2、R4、R40）。
//!
//! 两家的网关列表形状相同（`ProviderSettings`），规则也相同；不同的只是改完之后怎么让已生效的配置跟上：
//! Codex 已启用时重写目录与路由清单（原有行为，逐字节不变）；Claude 见 `commit_family`。
use super::{clean_base_url, host_of, unknown_provider, Agent, App, AppError};
use crate::router::Protocol;
use sophia_core::claude_models::settings::ClaudeGatewaySettings;
use sophia_core::codex_models::catalog::Model;
use sophia_core::codex_models::settings::{
    self, GatewaySettings, ProviderSettings, SavedModel, UnreachableReason,
};

/// 一家的设置
pub(super) enum Family {
    Codex(GatewaySettings),
    Claude(ClaudeGatewaySettings),
}

impl Family {
    pub(super) fn providers(&self) -> &Vec<ProviderSettings> {
        match self {
            Family::Codex(s) => &s.providers,
            Family::Claude(s) => &s.providers,
        }
    }

    fn providers_mut(&mut self) -> &mut Vec<ProviderSettings> {
        match self {
            Family::Codex(s) => &mut s.providers,
            Family::Claude(s) => &mut s.providers,
        }
    }

    fn provider(&self, id: &str) -> Option<&ProviderSettings> {
        self.providers().iter().find(|p| p.id == id)
    }

    fn provider_mut(&mut self, id: &str) -> Option<&mut ProviderSettings> {
        self.providers_mut().iter_mut().find(|p| p.id == id)
    }

    /// 这一家的已选里有没有这家网关的模型
    fn publishes(&self, id: &str) -> bool {
        settings::published(self.providers())
            .iter()
            .any(|p| p.provider == id)
    }

    /// 同一地址的网关（R40）
    fn same_address(&self, base_url: &str) -> Option<&ProviderSettings> {
        self.providers()
            .iter()
            .find(|p| same_address(&p.base_url, base_url))
    }

    /// 同一家里同一地址只能有一个网关（2026-09-30 产品负责人）：`except` 之外已经用了这个地址的，报冲突。
    /// 同步、带过来、删除时连另一家一起删都按地址认网关，同一家里有两份就对不上
    fn ensure_address_free(&self, base_url: &str, except: Option<&str>) -> Result<(), AppError> {
        // 地址没改（改名、换密钥）不查：规则出台前已经存在的同地址网关也要能照常编辑
        if let Some(own) = except.and_then(|id| self.providers().iter().find(|p| p.id == id)) {
            if same_address(&own.base_url, base_url) {
                return Ok(());
            }
        }
        match self
            .providers()
            .iter()
            .find(|p| Some(p.id.as_str()) != except && same_address(&p.base_url, base_url))
        {
            Some(taken) => Err(AppError::new(
                "conflict",
                sophia_core::t!("models.provider.duplicateUrl", name = taken.short_name()),
            )),
            None => Ok(()),
        }
    }
}

/// 新建或修改之后返回：这一家的 id，以及同步到另一家的那一家的 id（没同步为 None）
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSaved {
    pub provider_id: String,
    pub other_provider_id: Option<String>,
}

/// 试调一个模型要用的一切（`provider_for_probe_in`）。含密钥：只在内存里递给联网的那一步，不打印、不序列化
pub struct ProbeTarget {
    /// 路由清单里写的那个上游基址（`ProviderSettings::upstream_base`：探明的接口基址优先，没有退到用户填的地址）
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

/// 「同一地址」：两边经 `clean_base_url` 后 scheme、host（小写）、port、path 相同（R40）
pub fn same_address(a: &str, b: &str) -> bool {
    let parts = |raw: &str| {
        let cleaned = clean_base_url(raw).ok()?;
        let url = url::Url::parse(&cleaned).ok()?;
        Some((
            url.scheme().to_owned(),
            url.host_str().unwrap_or("").to_ascii_lowercase(),
            url.port_or_known_default(),
            url.path().trim_end_matches('/').to_owned(),
        ))
    };
    match (parts(a), parts(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

impl App {
    pub(super) fn load_family(&self, agent: Agent) -> Result<Family, AppError> {
        Ok(match agent {
            Agent::Codex => Family::Codex(self.load()?),
            Agent::Claude => Family::Claude(self.load_claude()?),
        })
    }

    /// 只存，不让已生效的配置跟上（新建失败后撤掉刚建的那一家、带过来：都不影响已选）
    fn save_family(&self, family: &Family) -> Result<(), AppError> {
        match family {
            Family::Codex(s) => self.save(s),
            Family::Claude(s) => self.save_claude(s),
        }
    }

    /// 存下这一家；`republish` 为真（已选或上游变了）时让已生效的配置跟上：
    /// - Codex：已启用就重写目录与路由清单（原有行为）
    /// - Claude：开着时已选不能变空（已选全部写进 `inferenceModels`，Sophia 不设默认，R29）；
    ///   存下之后，已写进桌面应用的上游地址立刻更新到 Claude 清单；开着且桌面应用不在运行就当场重写（R37）
    pub(super) fn commit_family(
        &self,
        family: &mut Family,
        republish: bool,
    ) -> Result<Vec<String>, AppError> {
        self.commit_family_as(family, republish, false)
    }

    /// 同 `commit_family`；`selection` 为真＝这次是改选模型，Codex 那一家要重新判断接法（R4）
    pub(super) fn commit_family_as(
        &self,
        family: &mut Family,
        republish: bool,
        selection: bool,
    ) -> Result<Vec<String>, AppError> {
        match family {
            Family::Codex(s) => {
                if republish && self.enabled(s) {
                    self.republish(s, selection)?;
                }
                self.save(s)?;
                Ok(Vec::new())
            }
            Family::Claude(s) => self.commit_claude(s, republish),
        }
    }

    // ----- 按家的动作 -----

    /// 新建或修改一家网关（不动密钥）。`sync` 为真时另一家同一地址的网关一起改 / 一起加（R40）
    pub fn upsert_provider_in(
        &self,
        agent: Agent,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
        sync: bool,
    ) -> Result<ProviderSaved, AppError> {
        let _guard = self.guard();
        let before = self.address_before(agent, id)?;
        let provider_id = self.upsert_locked(agent, id, name, base_url)?;
        let other_provider_id = if sync {
            self.sync_other(agent, &provider_id, before.as_deref(), None, None)?
        } else {
            None
        };
        Ok(ProviderSaved {
            provider_id,
            other_provider_id,
        })
    }

    /// 调用方已经用这个密钥向网关校验通过：保存地址、密钥和模型列表。`sync` 同上
    #[allow(clippy::too_many_arguments)]
    pub fn commit_verified_provider_in(
        &self,
        agent: Agent,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
        key: &str,
        models: Vec<Model>,
        api_base: &str,
        sync: bool,
    ) -> Result<ProviderSaved, AppError> {
        let _guard = self.guard();
        let before = self.address_before(agent, id)?;
        let provider_id =
            self.commit_locked(agent, id, name, base_url, key, models.clone(), api_base)?;
        let other_provider_id = if sync {
            self.sync_other(
                agent,
                &provider_id,
                before.as_deref(),
                Some(key),
                Some((models, api_base)),
            )?
        } else {
            None
        };
        Ok(ProviderSaved {
            provider_id,
            other_provider_id,
        })
    }

    /// 拉取模型列表要用的地址和密钥；任一缺失则报错，不联网
    pub fn provider_for_fetch_in(
        &self,
        agent: Agent,
        id: &str,
    ) -> Result<(String, String), AppError> {
        let family = self.load_family(agent)?;
        let provider = family.provider(id).ok_or_else(|| unknown_provider(id))?;
        if provider.base_url.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.noBaseUrl"),
            ));
        }
        // 没有、读不出（文件权限、还在钥匙串里）各说各的原因
        let key = self.require_key(agent, provider, true)?;
        Ok((provider.base_url.clone(), key))
    }

    /// 勾选前试调这家网关的一个模型要用的上游地址、协议与密钥：地址与协议取路由清单里写的那一份
    /// （`upstream_base` / `protocol`），试调结果才代表路由真正转发时的样子。任一缺失则报错（`invalid`），不联网
    pub fn provider_for_probe_in(
        &self,
        agent: Agent,
        id: &str,
        model: &str,
    ) -> Result<ProbeTarget, AppError> {
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.probe.noModel"),
            ));
        }
        let (_, key) = self.provider_for_fetch_in(agent, id)?;
        let family = self.load_family(agent)?;
        let provider = family.provider(id).ok_or_else(|| unknown_provider(id))?;
        Ok(ProbeTarget {
            api_base: provider.upstream_base().to_owned(),
            protocol: if provider.protocol() == "responses" {
                Protocol::Responses
            } else {
                Protocol::Chat
            },
            model: model.to_owned(),
            key,
        })
    }

    /// 并入拉到的模型：`models` 只看 `id` 与 `context_window`（见 `merge_locked`）
    pub fn merge_fetched_models_in(
        &self,
        agent: Agent,
        id: &str,
        models: Vec<Model>,
        api_base: &str,
    ) -> Result<(), AppError> {
        let _guard = self.guard();
        self.merge_locked(agent, id, models, api_base).map(|_| ())
    }

    /// 记下这一家拉不到模型的原因与技术原文（`detail`，已去隐私；没有为 None）
    pub fn record_unreachable_in(
        &self,
        agent: Agent,
        id: &str,
        reason: UnreachableReason,
        detail: Option<String>,
    ) -> Result<(), AppError> {
        let _guard = self.guard();
        self.unreachable_locked(agent, id, reason, detail)
    }

    /// 保存这一家网关的完整勾选；已生效时让配置跟上（见 `commit_family`）
    pub fn set_models_in(
        &self,
        agent: Agent,
        id: &str,
        selected: Vec<Model>,
    ) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        self.set_models_locked(agent, id, selected)
    }

    /// 删掉一家网关与它的密钥。`also_other` 为真时另一家同一地址的网关连同密钥一起删；
    /// 另一家因此已选为空且开着 → 那一家随之关掉（R40）。返回给用户的提示
    pub fn remove_provider_in(
        &self,
        agent: Agent,
        id: &str,
        also_other: bool,
    ) -> Result<Vec<String>, AppError> {
        let _guard = self.guard();
        let before = self.address_before(agent, Some(id))?;
        let mut warnings = self.remove_locked(agent, id)?;
        if !also_other {
            return Ok(warnings);
        }
        let other = agent.other();
        let fail = |e: AppError| other_failed(agent, other, e);
        let family = self.load_family(other).map_err(fail)?;
        let Some(target) = before
            .as_deref()
            .and_then(|url| family.same_address(url))
            .map(|p| p.id.clone())
        else {
            return Ok(warnings);
        };
        // 删掉它之后另一家的已选会变空、而那一家开着：先关掉那一家，再删
        let published = settings::published(family.providers());
        let empties = !published.is_empty() && published.iter().all(|p| p.provider == target);
        if empties && self.agent_on(other) {
            warnings.extend(self.close_locked(other).map_err(fail)?);
        }
        warnings.extend(self.remove_locked(other, &target).map_err(fail)?);
        Ok(warnings)
    }

    /// 带过来：把另一家有、这一家没有同一地址的网关逐个复制过来（名称、地址、接口基址、协议、模型列表，
    /// 全部未选），密钥从另一家账户读出写进这一家账户。不联网、不确认（R40）
    pub fn copy_providers(&self, agent: Agent, from: Agent) -> Result<(), AppError> {
        let _guard = self.guard();
        if agent == from {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.provider.copySelf"),
            ));
        }
        let source = self.load_family(from)?;
        let mut family = self.load_family(agent)?;
        let mut copied = Vec::new();
        for provider in source.providers() {
            if family.same_address(&provider.base_url).is_some() {
                continue;
            }
            let taken: Vec<&str> = family.providers().iter().map(|p| p.id.as_str()).collect();
            let id = settings::new_provider_id(&provider.name, &taken);
            family.providers_mut().push(unselected_copy(provider, &id));
            copied.push((provider.id.clone(), id));
        }
        if copied.is_empty() {
            return Ok(());
        }
        self.save_family(&family)?;
        for (from_id, id) in copied {
            // 另一家那一份没有密钥就不带：这一家的网关照样在，界面显示「没有密钥」
            if let Ok(Some(key)) = self.key_of(from, &from_id) {
                (self.deps.set_key)(agent, &id, &key).map_err(|e| AppError::new("invalid", e))?;
            }
        }
        Ok(())
    }

    // ----- 锁内的实现（两家共用） -----

    fn address_before(&self, agent: Agent, id: Option<&str>) -> Result<Option<String>, AppError> {
        let Some(id) = id else { return Ok(None) };
        Ok(self
            .load_family(agent)?
            .provider(id)
            .map(|p| p.base_url.clone()))
    }

    fn upsert_locked(
        &self,
        agent: Agent,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
    ) -> Result<String, AppError> {
        let cleaned = clean_base_url(base_url)?;
        let mut family = self.load_family(agent)?;
        family.ensure_address_free(&cleaned, id)?;
        let (id, changed) = apply_upsert(&mut family, id, name, cleaned)?;
        // 上游地址写在路由清单里：地址变了，重写清单即可，路由每个请求都会重读
        let publishes = family.publishes(&id);
        self.commit_family(&mut family, changed && publishes)?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn commit_locked(
        &self,
        agent: Agent,
        id: Option<&str>,
        name: Option<&str>,
        base_url: &str,
        key: &str,
        models: Vec<Model>,
        api_base: &str,
    ) -> Result<String, AppError> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::new(
                "invalid",
                sophia_core::t!("models.app.keyEmpty"),
            ));
        }
        let cleaned = clean_base_url(base_url)?;
        // 地址撞上这一家的另一个网关：什么都不写（先于写密钥）
        let mut family = self.load_family(agent)?;
        family.ensure_address_free(&cleaned, id)?;
        let is_new = id.is_none();
        if let Some(id) = id {
            // 已有的网关：先确认它存在、写密钥，再改地址——密钥没存成时什么都没改
            family.provider(id).ok_or_else(|| unknown_provider(id))?;
            (self.deps.set_key)(agent, id, key).map_err(|e| AppError::new("invalid", e))?;
        }
        // 地址与拉到的模型在内存里一起改，最后只存一次（已生效时只重写一遍配置）
        let (id, url_changed) = apply_upsert(&mut family, id, name, cleaned)?;
        if is_new {
            // 新建的网关要先有 id 才能存密钥；密钥没存成就什么都不存
            (self.deps.set_key)(agent, &id, key).map_err(|e| AppError::new("invalid", e))?;
        }
        let base_changed = apply_merge(&mut family, &id, models, api_base)?;
        let publishes = family.publishes(&id);
        self.commit_family(&mut family, (url_changed || base_changed) && publishes)?;
        Ok(id)
    }

    fn unreachable_locked(
        &self,
        agent: Agent,
        id: &str,
        reason: UnreachableReason,
        detail: Option<String>,
    ) -> Result<(), AppError> {
        let mut family = self.load_family(agent)?;
        let provider = family
            .provider_mut(id)
            .ok_or_else(|| unknown_provider(id))?;
        provider.unreachable = Some(reason);
        provider.unreachable_detail = detail;
        self.save_family(&family)
    }

    /// 拉到的模型并入这家网关的列表。`fetched` 里只用 `id` 与 `context_window`：
    /// - 网关这次给了上下文长度就用新的；没给就沿用已存的（有的网关时给时不给，不因此丢掉已知的值）
    /// - 显示名、看图能力、勾选都保留已存的
    /// - 已勾选但这次没返回的模型原样保留（连同它的上下文长度）；没勾选又没返回的去掉
    fn merge_locked(
        &self,
        agent: Agent,
        id: &str,
        fetched: Vec<Model>,
        api_base: &str,
    ) -> Result<Vec<String>, AppError> {
        let mut family = self.load_family(agent)?;
        let api_base_changed = apply_merge(&mut family, id, fetched, api_base)?;
        let publishes = family.publishes(id);
        self.commit_family(&mut family, api_base_changed && publishes)
    }

    fn set_models_locked(
        &self,
        agent: Agent,
        id: &str,
        selected: Vec<Model>,
    ) -> Result<Vec<String>, AppError> {
        let mut family = self.load_family(agent)?;
        let provider = family
            .provider_mut(id)
            .ok_or_else(|| unknown_provider(id))?;
        let mut chosen: Vec<Model> = Vec::new();
        for mut model in selected {
            model.id = model.id.trim().to_owned();
            if !model.id.is_empty() && !chosen.iter().any(|m| m.id == model.id) {
                chosen.push(model);
            }
        }
        let mut next: Vec<SavedModel> = Vec::new();
        for existing in &provider.models {
            match chosen.iter().find(|m| m.id == existing.model.id) {
                Some(pick) => next.push(SavedModel {
                    model: picked_over(&existing.model, pick),
                    selected: true,
                }),
                None => next.push(SavedModel {
                    selected: false,
                    ..existing.clone()
                }),
            }
        }
        for pick in &chosen {
            if !provider.models.iter().any(|m| m.model.id == pick.id) {
                next.push(SavedModel {
                    model: pick.clone(),
                    selected: true,
                });
            }
        }
        provider.models = next;
        self.commit_family_as(&mut family, true, true)
    }

    fn remove_locked(&self, agent: Agent, id: &str) -> Result<Vec<String>, AppError> {
        let mut family = self.load_family(agent)?;
        if family.provider(id).is_none() {
            return Err(unknown_provider(id));
        }
        let published_here = family.publishes(id);
        family.providers_mut().retain(|p| p.id != id);
        let warnings = self.commit_family(&mut family, published_here)?;
        // 设置已经不再引用这一家之后才删密钥：中途失败时，留下一个没人用的密钥好过留下一家没密钥的网关
        (self.deps.delete_key)(agent, id).map_err(|e| {
            AppError::new(
                "internal",
                sophia_core::t!("models.app.keyClearFailed", error = e),
            )
        })?;
        Ok(warnings)
    }

    /// 这一家「开着」吗（按开关：Codex 看设置文件是否指向路由，Claude 看开关）
    fn agent_on(&self, agent: Agent) -> bool {
        match agent {
            Agent::Codex => self.load().is_ok_and(|s| self.enabled(&s)),
            Agent::Claude => self.load_claude().is_ok_and(|s| s.enabled),
        }
    }

    /// 关掉一家（锁内）：Codex＝恢复；Claude＝拨关（桌面应用在运行时记为待生效）
    fn close_locked(&self, agent: Agent) -> Result<Vec<String>, AppError> {
        match agent {
            Agent::Codex => self.restore_locked(),
            Agent::Claude => self.restore_claude_locked(),
        }
    }

    /// 同步到另一家（R40）。新建：另一家已有同一地址的就不加第二份；修改：按改之前的地址找另一家的那一份，
    /// 地址与密钥一起改，拉到的模型列表一并并入。失败时这一家已写的不回滚，错误说明是哪一家没做成
    fn sync_other(
        &self,
        agent: Agent,
        this_id: &str,
        before: Option<&str>,
        key: Option<&str>,
        fetched: Option<(Vec<Model>, &str)>,
    ) -> Result<Option<String>, AppError> {
        let other = agent.other();
        let fail = |e: AppError| other_failed(agent, other, e);
        let this = self
            .load_family(agent)?
            .provider(this_id)
            .cloned()
            .ok_or_else(|| unknown_provider(this_id))?;
        let family = self.load_family(other).map_err(fail)?;
        match before {
            None => {
                if let Some(existing) = family.same_address(&this.base_url) {
                    return Ok(Some(existing.id.clone()));
                }
                let key = match key {
                    Some(key) => Some(key.trim().to_owned()),
                    None => self.key_of(agent, this_id).ok().flatten(),
                };
                let mut family = family;
                let taken: Vec<&str> = family.providers().iter().map(|p| p.id.as_str()).collect();
                let id = settings::new_provider_id(&this.name, &taken);
                family.providers_mut().push(unselected_copy(&this, &id));
                self.save_family(&family).map_err(fail)?;
                if let Some(key) = key.filter(|k| !k.trim().is_empty()) {
                    if let Err(error) = (self.deps.set_key)(other, &id, &key) {
                        // 同新建：密钥没存成就撤掉刚建的那一家
                        let mut family = self.load_family(other).map_err(fail)?;
                        family.providers_mut().retain(|p| p.id != id);
                        self.save_family(&family).map_err(fail)?;
                        return Err(fail(AppError::new("invalid", error)));
                    }
                }
                Ok(Some(id))
            }
            Some(before) => {
                let Some(target) = family.same_address(before).map(|p| p.id.clone()) else {
                    return Ok(None);
                };
                // 新地址在另一家已经是别的网关：先于写密钥拦下
                family
                    .ensure_address_free(&this.base_url, Some(&target))
                    .map_err(fail)?;
                if let Some(key) = key {
                    (self.deps.set_key)(other, &target, key.trim())
                        .map_err(|e| fail(AppError::new("invalid", e)))?;
                }
                // 地址与拉到的模型一起改，只存一次（那一家已生效时只重写一遍配置）
                let mut family = family;
                let cleaned = clean_base_url(&this.base_url).map_err(fail)?;
                let (_, url_changed) =
                    apply_upsert(&mut family, Some(&target), None, cleaned).map_err(fail)?;
                let base_changed = match fetched {
                    Some((models, api_base)) => {
                        apply_merge(&mut family, &target, models, api_base).map_err(fail)?
                    }
                    None => false,
                };
                let publishes = family.publishes(&target);
                self.commit_family(&mut family, (url_changed || base_changed) && publishes)
                    .map_err(fail)?;
                Ok(Some(target))
            }
        }
    }
}

/// 勾选时把界面传来的模型叠到已存的那一项上。界面（`gateway_select_models`）和命令行 `select` 只带
/// `id` 与显示名，其余字段是缺省值：不能拿它整个替换已存的，否则拉取时记下的上下文长度、接管时带来的看图能力
/// 一勾就没了。所以以已存的为底，只叠上调用方明确给了的：非空的显示名、非空的上下文长度、`vision: true`
fn picked_over(existing: &Model, pick: &Model) -> Model {
    let mut model = existing.clone();
    if let Some(name) = pick.display_name.as_deref() {
        if !name.trim().is_empty() {
            model.display_name = Some(name.to_owned());
        }
    }
    if let Some(window) = pick.context_window.filter(|n| *n > 0) {
        model.context_window = Some(window);
    }
    model.vision |= pick.vision;
    model
}

/// 在内存里新建或改一家网关（不存）：返回它的 id，以及地址变没变。`cleaned` 已经过 `clean_base_url`
fn apply_upsert(
    family: &mut Family,
    id: Option<&str>,
    name: Option<&str>,
    cleaned: String,
) -> Result<(String, bool), AppError> {
    let name = name.map(str::trim).filter(|name| !name.is_empty());
    Ok(match id {
        Some(id) => {
            let provider = family
                .provider_mut(id)
                .ok_or_else(|| unknown_provider(id))?;
            let changed = provider.base_url != cleaned;
            provider.base_url = cleaned;
            if changed {
                provider.api_base = None; // 旧地址探明的接口基址作废
                provider.unreachable = None; // 无法连接是对旧地址的结论
                provider.unreachable_detail = None;
            }
            if let Some(name) = name {
                provider.name = name.to_owned();
            }
            (id.to_owned(), changed)
        }
        None => {
            let name = name.map(str::to_owned).unwrap_or_else(|| host_of(&cleaned));
            let taken: Vec<&str> = family.providers().iter().map(|p| p.id.as_str()).collect();
            let id = settings::new_provider_id(&name, &taken);
            family.providers_mut().push(ProviderSettings {
                id: id.clone(),
                name,
                base_url: cleaned,
                ..ProviderSettings::default()
            });
            (id, false)
        }
    })
}

/// 在内存里把拉到的模型并入一家网关（不存）：保留原有的勾选、显示名与上下文长度；返回接口基址变没变
fn apply_merge(
    family: &mut Family,
    id: &str,
    fetched: Vec<Model>,
    api_base: &str,
) -> Result<bool, AppError> {
    let provider = family
        .provider_mut(id)
        .ok_or_else(|| unknown_provider(id))?;
    provider.unreachable = None; // 拉到了就是连得上
    provider.unreachable_detail = None;
    let api_base = api_base.trim().trim_end_matches('/');
    let api_base_changed = !api_base.is_empty() && provider.api_base.as_deref() != Some(api_base);
    if api_base_changed {
        provider.api_base = Some(api_base.to_owned());
    }
    let mut merged: Vec<SavedModel> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in &fetched {
        let id = item.id.trim();
        if id.is_empty() || !seen.insert(id.to_owned()) {
            continue;
        }
        let context_window = item.context_window.filter(|n| *n > 0);
        match provider.models.iter().find(|m| m.model.id == id) {
            Some(existing) => {
                let mut kept = existing.clone();
                if context_window.is_some() {
                    kept.model.context_window = context_window;
                }
                merged.push(kept);
            }
            None => merged.push(SavedModel {
                model: Model {
                    id: id.to_owned(),
                    context_window,
                    ..Default::default()
                },
                selected: false,
            }),
        }
    }
    // 已勾选但网关这次没返回的模型保留，避免一次网络抖动丢掉选择
    for model in &provider.models {
        if model.selected && !seen.contains(&model.model.id) {
            merged.push(model.clone());
        }
    }
    provider.models = merged;
    Ok(api_base_changed)
}

/// 复制一家网关：名称、地址、接口基址、协议、模型列表（全部未选）
fn unselected_copy(provider: &ProviderSettings, id: &str) -> ProviderSettings {
    ProviderSettings {
        id: id.to_owned(),
        name: provider.name.clone(),
        base_url: provider.base_url.clone(),
        api_base: provider.api_base.clone(),
        protocol: provider.protocol.clone(),
        models: provider
            .models
            .iter()
            .map(|m| SavedModel {
                model: m.model.clone(),
                selected: false,
            })
            .collect(),
        unreachable: None,
        unreachable_detail: None,
    }
}

/// 这一家已经写好，另一家没做成
fn other_failed(agent: Agent, other: Agent, error: AppError) -> AppError {
    AppError::new(
        error.code,
        sophia_core::t!(
            "models.provider.otherFailed",
            agent = agent.label(),
            other = other.label(),
            reason = error.message
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::same_address;

    /// R40：「同一地址」按 scheme、host（小写）、port、path 比，结尾斜杠不算
    #[test]
    fn same_address_ignores_case_default_port_and_trailing_slash() {
        assert!(same_address(
            "https://GW.example/openai/",
            "https://gw.example/openai"
        ));
        assert!(same_address(
            "https://gw.example:443/v1",
            "https://gw.example/v1"
        ));
        assert!(!same_address(
            "https://gw.example/v1",
            "https://gw.example/v2"
        ));
        assert!(!same_address(
            "https://gw.example",
            "https://gw.example:8443"
        ));
        assert!(!same_address("https://gw.example", "http://gw.example"));
        assert!(!same_address("not a url", "not a url"));
    }
}

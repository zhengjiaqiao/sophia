//! 各 agent 的「已选」（spec #247「三」、画板第 1、1′、2 屏）：每个能接第三方模型的 agent 一份有序列表，
//! 存在 `ModelProviders::picks`，与提供商名单同一节、同一把设置锁。纯函数，无 IO。
//!
//! - 一项是一个 [`ModelRef`]：第三方模型是「哪一家的哪个模型」，官方模型的提供商记成 [`OFFICIAL`]。
//!   顺序就是这个 agent 模型菜单里的顺序（Codex 按它重编排序值，Claude 桌面应用按它写模型列表）。
//! - 能接第三方模型的 agent 是一张表（[`MODEL_AGENTS`]）：认哪几种上游协议、官方模型能不能选。
//!   加一个 agent 就是往表里加一行（WorkBuddy：官方模型它自己管、只读）。
//! - 启用与选是两步（2026-10-08，ADR 0003 修订）：在提供商那里启用只进它的已启用名单，不默认选进任何 agent；
//!   agent 要用，在自己的「选模型」里勾（[`ModelProviders::pick`]）。
//! - Codex 的官方模型参与排序、可以取消；Codex 升级带来的新官方模型默认选上、排最后（[`ModelProviders::sync_official`]）。
use super::{ModelProviders, ModelRef, Provider, ProviderError};
use crate::codex_models::catalog::{Model, Published, RoutingProvider};
use crate::codex_models::settings::provider_slug;
use serde::{Deserialize, Serialize};

/// 官方模型在「已选」里的提供商记号。提供商 id 由名称经 `slug_for` 生成，只有小写字母、数字、`.` `_` `-`，撞不上
pub const OFFICIAL: &str = "@official";

/// 一个 agent 的官方模型在 Sophia 里能做什么
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Official {
    /// 能取消勾选、参与排序（Codex；没登录 OpenAI 时用不了，见视图的 `official_usable`）
    Pickable,
    /// 接第三方模型时用不了（Claude 桌面应用：开着第三方时官方模型不在菜单里；关着时是它自己在用的，见视图的 `official_usable`）
    Unavailable,
    /// 它自己管，只能看、不进排序（WorkBuddy，#266）
    ReadOnly,
}

/// 能接第三方模型的一个 agent
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelAgent {
    /// 与网关的家同名：`codex`、`claude`
    pub id: &'static str,
    /// 它经路由能用的上游协议（提供商的 `protocol()`）；不在这里的提供商在它的浮层里置灰
    pub protocols: &'static [&'static str],
    pub official: Official,
    /// 官方模型不能选时，浮层官方组里列出的名字（只是让用户认得是哪几个，不进「已选」）
    pub official_preview: &'static [&'static str],
}

/// 能接第三方模型的 agent，按模型页的先后
pub const MODEL_AGENTS: &[ModelAgent] = &[
    ModelAgent {
        id: "codex",
        protocols: &["chat", "responses"],
        official: Official::Pickable,
        official_preview: &[],
    },
    ModelAgent {
        id: "claude",
        protocols: &["chat", "responses"],
        official: Official::Unavailable,
        official_preview: &["Claude Opus", "Claude Sonnet", "Claude Haiku"],
    },
    // WorkBuddy 只讲 OpenAI Chat：名单里的提供商都有 OpenAI 兼容地址，讲 Responses 的那些家同时也有 Chat 接口，
    // 路由一律转到 `/chat/completions`（不做转换）。内置模型它自己管，第三方模型排在它们后面
    ModelAgent {
        id: "workbuddy",
        protocols: &["chat", "responses"],
        official: Official::ReadOnly,
        official_preview: &["Hunyuan", "GLM", "Kimi", "DeepSeek"],
    },
];

/// 表里的这一行；不认识的 agent 为 None
pub fn model_agent(id: &str) -> Option<&'static ModelAgent> {
    MODEL_AGENTS.iter().find(|a| a.id == id)
}

impl ModelRef {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
        }
    }

    /// 官方模型的引用（`model` 是它在 agent 里的标识，如 Codex 的 slug）
    pub fn official(model: impl Into<String>) -> Self {
        Self::new(OFFICIAL, model)
    }

    pub fn is_official(&self) -> bool {
        self.provider == OFFICIAL
    }
}

/// 一个 agent 的「已选」
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPicks {
    /// 按菜单顺序
    pub picked: Vec<ModelRef>,
    /// 见过的官方模型（只对官方模型能选的 agent）：不在这里的才是新出现的，默认选上；
    /// 用户取消过的还在这里，所以不会被再选回来
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub official_seen: Vec<String>,
}

/// 这一家能不能被这个 agent 用（协议）
pub fn usable_by(agent: &ModelAgent, provider: &Provider) -> bool {
    agent.protocols.contains(&provider.protocol())
}

impl ModelProviders {
    /// 这个 agent 存着的「已选」（含官方模型，按顺序；可能有已经失效的项，取用经 `effective_picks`）
    pub fn picked(&self, agent: &str) -> &[ModelRef] {
        self.picks
            .get(agent)
            .map(|p| p.picked.as_slice())
            .unwrap_or_default()
    }

    /// 每个 agent 的「已选」，给 `agents_using` 点名用；按模型页的先后（`MODEL_AGENTS`），不认识的排在后面
    pub fn all_picks(&self) -> Vec<(&str, &[ModelRef])> {
        let mut out: Vec<(&str, &[ModelRef])> = self
            .picks
            .iter()
            .map(|(agent, p)| (agent.as_str(), p.picked.as_slice()))
            .collect();
        out.sort_by_key(|(agent, _)| {
            MODEL_AGENTS
                .iter()
                .position(|a| a.id == *agent)
                .unwrap_or(usize::MAX)
        });
        out
    }

    /// 已启用、这个 agent 能用的第三方模型
    fn third_party_ok(&self, agent: &ModelAgent, r: &ModelRef) -> bool {
        self.provider(&r.provider).is_some_and(|p| {
            usable_by(agent, p)
                && p.models
                    .iter()
                    .any(|m| m.model.id == r.model && m.is_enabled())
        })
    }

    /// 这一项能不能进这个 agent 的「已选」：官方模型看 agent 让不让选，第三方模型要已启用、协议合得上
    pub fn pickable(&self, agent: &str, r: &ModelRef) -> bool {
        let Some(agent) = model_agent(agent) else {
            return false;
        };
        if r.is_official() {
            agent.official == Official::Pickable && !r.model.trim().is_empty()
        } else {
            self.third_party_ok(agent, r)
        }
    }

    fn picks_mut(&mut self, agent: &str) -> &mut AgentPicks {
        self.picks.entry(agent.to_owned()).or_default()
    }

    /// 勾上（追加到末尾）或取消一项；返回变没变。勾上不能选的 → 错
    pub fn pick(&mut self, agent: &str, r: &ModelRef, on: bool) -> Result<bool, ProviderError> {
        if on && !self.pickable(agent, r) {
            return Err(ProviderError::NotPickable(r.model.clone()));
        }
        let picks = self.picks_mut(agent);
        let at = picks.picked.iter().position(|p| p == r);
        Ok(match (on, at) {
            (true, None) => {
                picks.picked.push(r.clone());
                true
            }
            (false, Some(at)) => {
                picks.picked.remove(at);
                true
            }
            _ => false,
        })
    }

    /// 整份换掉（排序，#265）：去重、丢掉不能选的，按给的顺序
    pub fn set_picked(&mut self, agent: &str, refs: Vec<ModelRef>) -> Result<(), ProviderError> {
        if model_agent(agent).is_none() {
            return Err(ProviderError::Unknown(agent.to_owned()));
        }
        let mut next: Vec<ModelRef> = Vec::with_capacity(refs.len());
        for r in refs {
            if self.pickable(agent, &r) && !next.contains(&r) {
                next.push(r);
            }
        }
        self.picks_mut(agent).picked = next;
        Ok(())
    }

    /// 排序（#265）：`order` 是浮层「已选」里看得见的几项的新顺序。它们在「已选」里原来占的那几个位置
    /// 依次换成新顺序；看不见的项（Codex 没登录时的官方模型、暂时用不了的）原地不动，不会被排丢。
    /// 不加也不减：`order` 里不在「已选」的忽略。返回变没变
    pub fn reorder(&mut self, agent: &str, order: &[ModelRef]) -> Result<bool, ProviderError> {
        if model_agent(agent).is_none() {
            return Err(ProviderError::Unknown(agent.to_owned()));
        }
        let picks = self.picks_mut(agent);
        let mut moved: Vec<ModelRef> = Vec::with_capacity(order.len());
        for r in order {
            if picks.picked.contains(r) && !moved.contains(r) {
                moved.push(r.clone());
            }
        }
        let mut moved = moved.into_iter();
        let next: Vec<ModelRef> = picks
            .picked
            .iter()
            .map(|r| {
                if order.contains(r) {
                    moved.next().unwrap_or_else(|| r.clone())
                } else {
                    r.clone()
                }
            })
            .collect();
        let changed = next != picks.picked;
        picks.picked = next;
        Ok(changed)
    }

    /// 恢复默认顺序（#265，画板第 2 屏）：官方的在前、按 `officials`（官方目录）自己的顺序，目录里已经没有的
    /// 官方项排在官方之末；第三方的按启用先后（`Enabled::seq`），已失效的排最后。不加也不减。返回变没变
    pub fn restore_order(&mut self, agent: &str, officials: &[String]) -> bool {
        let seq_of = |r: &ModelRef| {
            self.provider(&r.provider)
                .and_then(|p| p.models.iter().find(|m| m.model.id == r.model))
                .and_then(|m| m.enabled)
                .map_or(u64::MAX, |e| e.seq)
        };
        let mut keyed: Vec<((u8, u64), ModelRef)> = self
            .picked(agent)
            .iter()
            .map(|r| {
                let key = if r.is_official() {
                    let at = officials.iter().position(|slug| *slug == r.model);
                    (0, at.map_or(u64::MAX, |i| i as u64))
                } else {
                    (1, seq_of(r))
                };
                (key, r.clone())
            })
            .collect();
        // 稳定排序：键相同（都已失效）的保持原来的先后
        keyed.sort_by_key(|(key, _)| *key);
        let next: Vec<ModelRef> = keyed.into_iter().map(|(_, r)| r).collect();
        if next.as_slice() == self.picked(agent) {
            return false;
        }
        self.picks_mut(agent).picked = next;
        true
    }

    /// 并入此刻的官方模型（只对官方模型能选的 agent）：第一次见到的整组放最前（按它自己的顺序）；
    /// 之后新出现的（Codex 升级带来的）默认选上、排最后。见过的不再动——用户取消过的不会被选回来。返回变没变
    pub fn sync_official(&mut self, agent: &str, current: &[String]) -> bool {
        if model_agent(agent).is_none_or(|a| a.official != Official::Pickable) {
            return false;
        }
        let picks = self.picks_mut(agent);
        let first = picks.official_seen.is_empty();
        let fresh: Vec<String> = current
            .iter()
            .filter(|slug| !slug.trim().is_empty() && !picks.official_seen.contains(slug))
            .cloned()
            .collect();
        if fresh.is_empty() {
            return false;
        }
        let refs = fresh
            .iter()
            .map(ModelRef::official)
            .filter(|r| !picks.picked.contains(r));
        if first {
            let mut next: Vec<ModelRef> = refs.collect();
            next.append(&mut picks.picked);
            picks.picked = next;
        } else {
            let added: Vec<ModelRef> = refs.collect();
            picks.picked.extend(added);
        }
        picks.official_seen.extend(fresh);
        true
    }

    /// 此刻真正生效的「已选」：先并入官方模型（`officials` 给了时），再滤掉失效的项——提供商没了、模型没启用、
    /// 协议合不上；官方模型不在 `officials` 里（给了时）或这个 agent 的官方模型不能选。只读，不改存着的
    pub fn effective_picks(&self, agent: &str, officials: Option<&[String]>) -> Vec<ModelRef> {
        let mut list = self.clone();
        if let Some(current) = officials {
            list.sync_official(agent, current);
        }
        let Some(spec) = model_agent(agent) else {
            return Vec::new();
        };
        list.picked(agent)
            .iter()
            .filter(|r| {
                if r.is_official() {
                    spec.official == Official::Pickable
                        && officials.is_none_or(|current| current.contains(&r.model))
                } else {
                    list.third_party_ok(spec, r)
                }
            })
            .cloned()
            .collect()
    }

    /// 删掉一家、取消启用一个模型之后：各 agent「已选」里指着它们的项一并拿掉（官方模型不动）
    pub(super) fn prune_picks(&mut self) {
        let keep: Vec<(String, Vec<ModelRef>)> = self
            .picks
            .iter()
            .map(|(agent, picks)| {
                let kept = picks
                    .picked
                    .iter()
                    .filter(|r| {
                        r.is_official()
                            || self.provider(&r.provider).is_some_and(|p| {
                                p.models
                                    .iter()
                                    .any(|m| m.model.id == r.model && m.is_enabled())
                            })
                    })
                    .cloned()
                    .collect();
                (agent.clone(), kept)
            })
            .collect();
        for (agent, kept) in keep {
            self.picks_mut(&agent).picked = kept;
        }
    }

    /// 这个 agent 要写进配置的第三方模型，按「已选」顺序：带上它在 agent 里的标识（`<提供商 id>-<模型>`）。
    /// 两家的模型显示成同一个名字时，显示名加「 · 提供商名」（同一家里的重名加了也分不清，不加）
    pub fn published(&self, agent: &str) -> Vec<Published> {
        let mut list: Vec<Published> = self
            .effective_picks(agent, None)
            .into_iter()
            .filter(|r| !r.is_official())
            .filter_map(|r| {
                let provider = self.provider(&r.provider)?;
                let model = provider.models.iter().find(|m| m.model.id == r.model)?;
                Some(Published {
                    slug: provider_slug(&provider.id, &model.model.id),
                    provider: provider.id.clone(),
                    model: model.model.clone(),
                })
            })
            .collect();
        let shown = |p: &Published| shown_name(&p.model);
        let clashing: Vec<bool> = list
            .iter()
            .map(|this| {
                let name = shown(this);
                list.iter()
                    .any(|other| other.provider != this.provider && shown(other) == name)
            })
            .collect();
        for (published, clash) in list.iter_mut().zip(clashing) {
            if clash {
                let suffix = self
                    .provider(&published.provider)
                    .map_or_else(|| published.provider.clone(), |p| p.name.clone());
                published.model.display_name = Some(format!("{} · {suffix}", shown(published)));
            }
        }
        list
    }

    /// 路由清单里要写的上游：`published` 用到的几家，按第一次出现的先后
    pub fn routing_providers(&self, published: &[Published]) -> Vec<RoutingProvider> {
        let mut out: Vec<RoutingProvider> = Vec::new();
        for p in published {
            if out.iter().any(|r| r.id == p.provider) {
                continue;
            }
            if let Some(provider) = self.provider(&p.provider) {
                out.push(RoutingProvider {
                    id: provider.id.clone(),
                    base_url: provider.upstream_base().to_owned(),
                    protocol: provider.protocol().to_owned(),
                });
            }
        }
        out
    }
}

/// 显示名：有就用，没有用 id（不带撞名后缀；WorkBuddy 认「名字还是 Sophia 起的」也用它）
pub fn shown_name(model: &Model) -> String {
    match model.display_name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => model.id.trim().to_owned(),
    }
}

// ----- 选模型浮层要的样子 -----

/// 一个官方模型（Codex：官方目录里列出的；Claude：只给名字）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialModel {
    /// 它在 agent 里的标识（Codex 的 slug）；只给名字的为空
    pub id: String,
    pub display_name: String,
}

/// 一组为什么不能选
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Blocked {
    /// Codex 没登录 OpenAI，官方模型用不了
    SignedOut,
    /// 接第三方模型时官方模型用不了（Claude 桌面应用）
    OfficialUnavailable,
    /// 它自己管，在这里改不了（WorkBuddy）
    ReadOnly,
    /// 这家的接口这个 agent 用不了（协议）
    Protocol,
}

/// 浮层里的一个模型
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupModel {
    /// 选它时传回去的引用
    #[serde(rename = "ref")]
    pub model_ref: ModelRef,
    pub display_name: String,
    pub context_window: Option<u32>,
    pub picked: bool,
}

/// 浮层「全部」里的一组：官方一组在前，然后按提供商名单的顺序
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelGroup {
    /// `@official` 或提供商 id
    pub provider: String,
    /// 提供商名；官方组为空（界面写「官方」）
    pub name: String,
    /// 不能选的原因；能选为 None
    pub blocked: Option<Blocked>,
    pub models: Vec<GroupModel>,
}

/// 「已选」里的一项（按顺序）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedModel {
    #[serde(rename = "ref")]
    pub model_ref: ModelRef,
    pub display_name: String,
    /// 提供商名；官方模型为空
    pub provider_name: String,
}

/// 一个 agent 的选模型视图（模型页那一行与浮层都读它）
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModels {
    /// 此刻生效的「已选」，按顺序（按钮上的「已选 N 个模型」、页签「已选 N」、第二行的计数都数它）
    pub picked: Vec<PickedModel>,
    pub groups: Vec<ModelGroup>,
    /// 名单里有几家提供商（一家都没有时浮层说「还没有模型提供商」）
    pub providers: usize,
}

/// 某个 agent 的选模型视图。`officials`：Codex 是官方目录里列出的模型；`official_usable`：官方模型此刻用得了没有
/// （Codex 没登录 OpenAI 时为假；Claude 桌面应用开着第三方模型时为假）。用不了的官方模型不算进「已选」，但记着，
/// 登录回来照原样恢复
pub fn agent_models(
    list: &ModelProviders,
    agent: &str,
    officials: &[OfficialModel],
    official_usable: bool,
) -> AgentModels {
    let Some(spec) = model_agent(agent) else {
        return AgentModels::default();
    };
    let slugs: Vec<String> = officials
        .iter()
        .filter(|o| !o.id.is_empty())
        .map(|o| o.id.clone())
        .collect();
    let effective = list.effective_picks(
        agent,
        (spec.official == Official::Pickable).then_some(slugs.as_slice()),
    );
    let official_name = |slug: &str| {
        officials
            .iter()
            .find(|o| o.id == slug)
            .map_or_else(|| slug.to_owned(), |o| o.display_name.clone())
    };
    let picked: Vec<PickedModel> = effective
        .iter()
        .filter(|r| !r.is_official() || official_usable)
        .filter_map(|r| {
            if r.is_official() {
                return Some(PickedModel {
                    model_ref: r.clone(),
                    display_name: official_name(&r.model),
                    provider_name: String::new(),
                });
            }
            // 「已选」里提供商名单独一列，名字不带撞名后缀
            let provider = list.provider(&r.provider)?;
            let model = provider.models.iter().find(|m| m.model.id == r.model)?;
            Some(PickedModel {
                model_ref: r.clone(),
                display_name: shown_name(&model.model),
                provider_name: provider.name.clone(),
            })
        })
        .collect();

    let official_block = match spec.official {
        Official::Pickable if official_usable => None,
        Official::Pickable => Some(Blocked::SignedOut),
        // 关着第三方时官方模型就是它自己在用的：它自己管、在这里改不了；开着时才说用不了
        Official::Unavailable if official_usable => Some(Blocked::ReadOnly),
        Official::Unavailable => Some(Blocked::OfficialUnavailable),
        Official::ReadOnly => Some(Blocked::ReadOnly),
    };
    // 置灰的官方模型照实显示勾没勾（走查 2026-10-07）：它自己管的（WorkBuddy、关着第三方的 Claude）都在它的菜单里，
    // 勾上；Codex 没登录时显示记着的勾选（没动过的新官方模型已按「默认选上」并进去）；Claude 开着第三方时
    // 官方模型确实不在菜单里，不勾。都不算进「已选」（上面的 `picked` 只数 Sophia 写进它菜单的）
    let official_ticked = |r: &ModelRef| match official_block {
        None | Some(Blocked::SignedOut) => effective.contains(r),
        Some(Blocked::ReadOnly) => true,
        Some(Blocked::OfficialUnavailable) | Some(Blocked::Protocol) => false,
    };
    let mut groups = Vec::new();
    let official_models: Vec<GroupModel> = if officials.is_empty() {
        spec.official_preview
            .iter()
            .map(|name| GroupModel {
                model_ref: ModelRef::official(""),
                display_name: (*name).to_owned(),
                context_window: None,
                picked: official_block == Some(Blocked::ReadOnly),
            })
            .collect()
    } else {
        officials
            .iter()
            .map(|o| {
                let r = ModelRef::official(&o.id);
                GroupModel {
                    picked: official_ticked(&r),
                    model_ref: r,
                    display_name: o.display_name.clone(),
                    context_window: None,
                }
            })
            .collect()
    };
    if !official_models.is_empty() {
        groups.push(ModelGroup {
            provider: OFFICIAL.to_owned(),
            name: String::new(),
            blocked: official_block,
            models: official_models,
        });
    }
    for provider in &list.providers {
        let blocked = (!usable_by(spec, provider)).then_some(Blocked::Protocol);
        let models: Vec<GroupModel> = provider
            .enabled_models()
            .map(|m| {
                let r = ModelRef::new(&provider.id, &m.model.id);
                GroupModel {
                    picked: blocked.is_none() && effective.contains(&r),
                    model_ref: r,
                    display_name: shown_name(&m.model),
                    context_window: m.model.context_window,
                }
            })
            .collect();
        groups.push(ModelGroup {
            provider: provider.id.clone(),
            name: provider.name.clone(),
            blocked,
            models,
        });
    }
    AgentModels {
        picked,
        groups,
        providers: list.providers.len(),
    }
}

#[cfg(test)]
#[path = "picks_tests.rs"]
mod tests;

//! 提供商页要的样子（命令 `providers_list` 返回它）：每家一行，带密钥状态、已启用 / 总数、谁在用。纯函数。
use super::defaults::DefaultRule;
use super::{agents_using, agents_using_model, EnabledBy, ModelProviders, ModelRef};
use crate::keystore::KeyStoreError;
use serde::Serialize;

/// 一家的密钥：有 / 没有 / 读不出（同旧网关的 `KeyStatus`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyState {
    Set,
    Missing,
    Unreadable,
}

/// 「启用模型」浮层里的一行
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub id: String,
    pub display_name: Option<String>,
    pub context_window: Option<u32>,
    /// 用户手填的
    pub manual: bool,
    /// 已启用时谁启用的；没启用为 None
    pub enabled_by: Option<EnabledBy>,
    /// 选了这个模型的 agent（取消启用前的确认据它点名）
    pub agents: Vec<String>,
}

/// 提供商页的一行
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: String,
    pub preset: Option<String>,
    pub key: KeyState,
    /// 读不出密钥时的原因（当前语言）
    pub key_problem: Option<String>,
    pub models: Vec<ModelRow>,
    /// 已启用几个
    pub enabled: usize,
    /// 列表里的对话模型共几个（手填的也算）
    pub total: usize,
    /// 还停在添加时的默认启用上：用了哪条规则（用户改过就是 None）
    pub default_rule: Option<DefaultRule>,
    /// 选了这一家模型的 agent（「N 个 agent」与删除确认点名用），按 `picks` 的顺序
    pub agents: Vec<String>,
    /// 上次拉模型失败的原因（当前语言）；没失败为 None
    pub unreachable: Option<String>,
    pub unreachable_detail: Option<String>,
    /// 失败原因是密钥被拒（拉列表或真实调用都算）
    pub key_invalid: bool,
}

/// 名单 → 提供商页的行。`key` 按提供商 id 读密钥；`picks` 是每个 agent 的「已选」（#259 之前为空）
pub fn rows(
    list: &ModelProviders,
    key: impl Fn(&str) -> Result<Option<String>, KeyStoreError>,
    picks: &[(&str, &[ModelRef])],
) -> Vec<ProviderRow> {
    list.providers
        .iter()
        .map(|p| {
            let (key, key_problem) = match key(&p.id) {
                Ok(Some(_)) => (KeyState::Set, None),
                Ok(None) => (KeyState::Missing, None),
                Err(e) => (KeyState::Unreadable, Some(e.to_string())),
            };
            ProviderRow {
                id: p.id.clone(),
                name: p.name.clone(),
                base_url: p.base_url.clone(),
                protocol: p.protocol().to_owned(),
                preset: p.preset.clone(),
                key,
                key_problem,
                models: p
                    .models
                    .iter()
                    .map(|m| ModelRow {
                        id: m.model.id.clone(),
                        display_name: m.model.display_name.clone(),
                        context_window: m.model.context_window,
                        manual: m.model.manual,
                        enabled_by: m.enabled.map(|e| e.by),
                        agents: agents_using_model(
                            &ModelRef {
                                provider: p.id.clone(),
                                model: m.model.id.clone(),
                            },
                            picks.iter().copied(),
                        )
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                    })
                    .collect(),
                enabled: p.enabled_count(),
                total: p.models.len(),
                default_rule: p.default_rule,
                agents: agents_using(&p.id, picks.iter().copied())
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                unreachable: p.unreachable.as_ref().map(|r| r.text()),
                unreachable_detail: p.unreachable_detail.clone(),
                key_invalid: p.unreachable
                    == Some(crate::codex_models::settings::UnreachableReason::Auth),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_models::catalog::Model;
    use crate::model_providers::NewProvider;

    fn list() -> ModelProviders {
        let mut list = ModelProviders::default();
        for (name, url, fetched) in [
            ("Kimi", "https://api.moonshot.cn/v1", vec!["k1", "k2", "k3"]),
            ("我的中转", "https://relay.example.com/v1", vec!["r1"]),
        ] {
            list.add(NewProvider {
                name: name.into(),
                base_url: url.into(),
                protocol: "chat".into(),
                recommended: vec!["k1".into()],
                fetched: fetched.into_iter().map(Model::from).collect(),
                ..NewProvider::default()
            })
            .unwrap();
        }
        list
    }

    /// 已启用 / 总数、默认规则、密钥三种状态、谁在用
    #[test]
    fn rows_count_enabled_models_and_name_the_agents_using_them() {
        let list = list();
        let kimi = list.providers[0].id.clone();
        let refs = vec![ModelRef {
            provider: kimi.clone(),
            model: "k1".into(),
        }];
        let none: Vec<ModelRef> = Vec::new();
        let picks = [("codex", refs.as_slice()), ("claude", none.as_slice())];
        let rows = rows(
            &list,
            |id| {
                if id == kimi {
                    Ok(Some("sk".into()))
                } else {
                    Err(KeyStoreError::Corrupt)
                }
            },
            &picks,
        );
        assert_eq!(rows.len(), 2);
        let k = &rows[0];
        assert_eq!((k.enabled, k.total), (1, 3));
        assert_eq!(k.default_rule, Some(DefaultRule::Recommended));
        assert_eq!(k.key, KeyState::Set);
        assert_eq!(k.agents, ["codex"]);
        assert_eq!(k.models[0].enabled_by, Some(EnabledBy::Default));
        assert_eq!(k.models[1].enabled_by, None);
        assert_eq!(k.models[0].agents, ["codex"]);
        assert!(k.models[1].agents.is_empty());
        let r = &rows[1];
        // 推荐里没有它的模型：按数量全开
        assert_eq!((r.enabled, r.total), (1, 1));
        assert_eq!(r.default_rule, Some(DefaultRule::All));
        assert_eq!(r.key, KeyState::Unreadable);
        assert!(r.key_problem.is_some());
        assert!(r.agents.is_empty());
    }
}

//! Claude 第三方模型的持久化设置，挂在 `store::Settings::claude_gateway` 下，随 settings.json 读写
//! （spec R1、契约 §5）。纯数据，无 IO。
//!
//! 网关列表的形状与 Codex 那份相同（`ProviderSettings`），已选、标识与显示名按同一套规则各算各的（R3）。
//! `applied` 记下 Sophia 上一次写进桌面应用配置的值与写之前的原值：切回时据它还原，中途失败或崩溃后
//! 据它的 `phase` 把记下的方向做完（R32、R33）。令牌不存在这里。
use crate::codex_models::catalog::{Published, RoutingProvider};
use crate::codex_models::settings::{self as codex, ProviderSettings};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 家 `claude` 的一份设置
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeGatewaySettings {
    pub providers: Vec<ProviderSettings>,
    // 2026-09-30 起 Sophia 不设默认模型（以 Claude 客户端里的选择为准）：去掉了 `defaultModel` /
    // `backgroundModel`。旧文件里的这两个键读入时忽略（本结构不拒收未知字段），再存时不写回
    /// 开关（想要的值）
    pub enabled: bool,
    /// 开着时允许顶替别家的生效配置（R35）；关掉时清
    pub takeover: bool,
    /// 写入的值与原值记录；`None`＝桌面应用配置里没有 Sophia 写的东西
    pub applied: Option<Applied>,
}

impl ClaudeGatewaySettings {
    /// 这一家已选的模型，带标识与显示名（撞名加网关短名），规则同 Codex
    pub fn published(&self) -> Vec<Published> {
        codex::published(&self.providers)
    }

    /// 这一家写进路由清单的上游
    pub fn routing_providers(&self) -> Vec<RoutingProvider> {
        codex::routing_providers(&self.providers)
    }
}

/// 写入进行到哪一步（R32）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// 打开方向已记下、还没写完
    Writing,
    /// 打开方向写完了
    Done,
    /// 切回方向已记下、还没做完
    Restoring,
}

/// Sophia 上一次写进桌面应用配置的记录
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub phase: Phase,
    pub written: Written,
    /// 第一次写之前的原值；前滚、重新写入、再接管都沿用，不把 Sophia 写的值当原值
    pub originals: Originals,
    /// Sophia 的 profile 是 Sophia 新建的（第一次写之前不存在）
    pub profile_created: bool,
    /// `_meta.json` 的 `entries` 里 Sophia 的条目是 Sophia 加的
    pub entry_added: bool,
}

/// 写入的值
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// profile 的 `inferenceGatewayBaseUrl`
    pub base_url: String,
    /// `inferenceModels` 的每一项（角色 id）对应哪个已选模型，顺序同 `inferenceModels`
    pub models: Vec<WrittenModel>,
    /// `chatTabEnabled` 是 Sophia 补上的（profile 里原本没有这个键）
    pub chat_tab_written: bool,
    /// 写入后整份 profile；其中 `inferenceGatewayApiKey` 存成占位 `"<token>"`，比较时换成钥匙串里的令牌
    pub profile: Value,
}

/// `inferenceModels` 里的一项：角色 id → 已选模型的标识与模型片上的名字（`labelOverride`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenModel {
    pub role: String,
    pub slug: String,
    pub label: String,
}

/// 写之前的原值：`_meta.json` 的两个成员与两处 `deploymentMode`（都不是凭证）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Originals {
    pub applied_id: Original,
    pub entries: Original,
    /// `Claude-3p/claude_desktop_config.json` 的 `deploymentMode`
    #[serde(rename = "claude3pMode")]
    pub claude_3p_mode: Original,
    /// `Claude/claude_desktop_config.json` 的 `deploymentMode`
    pub claude_mode: Original,
}

/// 一个成员写之前的样子。存成 `{"fileAbsent":true}` / `{"absent":true}` / `{"raw":"<JSON 原文>"}`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "OriginalRepr", into = "OriginalRepr")]
pub enum Original {
    /// 文件不存在
    FileAbsent,
    /// 文件在、没有这个成员
    Absent,
    /// 成员值的原文（逐字节，切回时原样换回）
    Raw(String),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginalRepr {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    file_absent: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    absent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
}

impl TryFrom<OriginalRepr> for Original {
    type Error = String;
    fn try_from(repr: OriginalRepr) -> Result<Self, Self::Error> {
        match (repr.file_absent, repr.absent, repr.raw) {
            (true, false, None) => Ok(Original::FileAbsent),
            (false, true, None) => Ok(Original::Absent),
            (false, false, Some(raw)) => Ok(Original::Raw(raw)),
            _ => Err(crate::t!("models.claude.originalShape")),
        }
    }
}

impl From<Original> for OriginalRepr {
    fn from(original: Original) -> Self {
        match original {
            Original::FileAbsent => OriginalRepr {
                file_absent: true,
                ..OriginalRepr::default()
            },
            Original::Absent => OriginalRepr {
                absent: true,
                ..OriginalRepr::default()
            },
            Original::Raw(raw) => OriginalRepr {
                raw: Some(raw),
                ..OriginalRepr::default()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_models::catalog::Model;
    use crate::codex_models::settings::{GatewaySettings, ProviderSettings, SavedModel};
    use crate::store::{Settings, Store};
    use crate::test_support::TempTree;
    use serde_json::{json, Value};

    fn provider(id: &str, models: &[(&str, bool)]) -> ProviderSettings {
        ProviderSettings {
            id: id.into(),
            name: id.to_uppercase(),
            base_url: format!("https://{id}.example"),
            models: models
                .iter()
                .map(|(model, selected)| SavedModel {
                    model: Model {
                        id: (*model).into(),
                        ..Model::default()
                    },
                    selected: *selected,
                })
                .collect(),
            ..ProviderSettings::default()
        }
    }

    fn applied() -> Applied {
        Applied {
            phase: Phase::Writing,
            written: Written {
                base_url: "http://127.0.0.1:47328/claude".into(),
                models: vec![WrittenModel {
                    role: "claude-sonnet-5".into(),
                    slug: "ap-kimi-k3".into(),
                    label: "kimi-k3".into(),
                }],
                chat_tab_written: true,
                profile: json!({"inferenceProvider": "gateway", "inferenceGatewayApiKey": "<token>"}),
            },
            originals: Originals {
                applied_id: Original::Raw("\"cc\"".into()),
                entries: Original::Absent,
                claude_3p_mode: Original::FileAbsent,
                claude_mode: Original::Raw("\"1p\"".into()),
            },
            profile_created: true,
            entry_added: false,
        }
    }

    /// AC1：升级前的 settings.json 只有 codexGateway（按当前版本保存过的形状），读入再保存后它逐字段不变，
    /// claudeGateway 是空默认
    #[test]
    fn old_settings_without_claude_gateway_read_as_empty_and_keep_codex_untouched() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
        let codex = json!({
            "providers": [{
                "id": "ap", "name": "AP", "baseUrl": "https://ap.example", "apiBase": "https://ap.example/v1",
                "protocol": "responses",
                "models": [{"id": "kimi-k3", "displayName": "Kimi", "vision": false, "selected": true}]
            }],
            "port": 47400,
            "addedNewline": true,
            "catalogClientVersion": "0.99.0",
            "prevModel": "gpt-5",
            "hadPrevModel": true,
            "publishedSlugs": ["ap-kimi-k3"],
            "changedAt": 1700000000,
            "catalogFingerprint": "abc",
            "history": [{"at": 1700000000, "enabled": true, "catalog": "abc"}]
        });
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec(&json!({"disabledHarnesses": [], "codexGateway": codex})).unwrap(),
        )
        .unwrap();
        let store = Store::new(dir.clone());
        let loaded = store.load_settings().unwrap();
        assert_eq!(loaded.claude_gateway, ClaudeGatewaySettings::default());
        store.save_settings(&loaded).unwrap();

        let saved: Value =
            serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(saved["codexGateway"], codex);
        assert_eq!(
            saved["claudeGateway"],
            json!({"providers": [], "enabled": false, "takeover": false, "applied": null})
        );
        assert_eq!(store.load_settings().unwrap(), loaded);
    }

    /// 2026-09-30 之前存下的 `defaultModel` / `backgroundModel`：读入时忽略、不报错，其余字段照读；再存时不写回
    #[test]
    fn old_default_and_background_models_are_ignored_on_read() {
        let old = json!({
            "providers": [{"id": "ap", "name": "AP", "baseUrl": "https://ap.example", "protocol": "chat",
                           "models": [{"id": "kimi-k3", "selected": true}]}],
            "defaultModel": "ap-kimi-k3",
            "backgroundModel": null,
            "enabled": true,
            "takeover": false,
            "applied": null
        });
        let loaded: ClaudeGatewaySettings = serde_json::from_value(old).unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.providers.len(), 1);
        assert_eq!(loaded.published().len(), 1);
        let saved = serde_json::to_value(&loaded).unwrap();
        assert!(saved.get("defaultModel").is_none());
        assert!(saved.get("backgroundModel").is_none());
    }

    /// 契约 §5：字段名与 `applied` 的形状；原值三种写法
    #[test]
    fn claude_gateway_serializes_in_the_contract_shape() {
        let settings = ClaudeGatewaySettings {
            providers: vec![provider("ap", &[("kimi-k3", true)])],
            enabled: true,
            takeover: true,
            applied: Some(applied()),
        };
        let value = serde_json::to_value(&settings).unwrap();
        // 2026-09-30 起 Sophia 不设默认模型：不再有 `defaultModel` / `backgroundModel`
        assert!(value.get("defaultModel").is_none());
        assert!(value.get("backgroundModel").is_none());
        assert_eq!(value["enabled"], true);
        assert_eq!(value["takeover"], true);
        assert_eq!(value["providers"][0]["baseUrl"], "https://ap.example");
        assert_eq!(
            value["applied"],
            json!({
                "phase": "writing",
                "written": {
                    "baseUrl": "http://127.0.0.1:47328/claude",
                    "models": [{"role": "claude-sonnet-5", "slug": "ap-kimi-k3", "label": "kimi-k3"}],
                    "chatTabWritten": true,
                    "profile": {"inferenceProvider": "gateway", "inferenceGatewayApiKey": "<token>"}
                },
                "originals": {
                    "appliedId": {"raw": "\"cc\""},
                    "entries": {"absent": true},
                    "claude3pMode": {"fileAbsent": true},
                    "claudeMode": {"raw": "\"1p\""}
                },
                "profileCreated": true,
                "entryAdded": false
            })
        );
        let back: ClaudeGatewaySettings = serde_json::from_value(value).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn phases_read_and_write_as_lowercase_words() {
        for (phase, word) in [
            (Phase::Writing, "writing"),
            (Phase::Done, "done"),
            (Phase::Restoring, "restoring"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), word);
            assert_eq!(serde_json::from_value::<Phase>(json!(word)).unwrap(), phase);
        }
    }

    /// 原值只能是三种之一：两种标记都没有、或都有，或 raw 与标记并存，读入时拒绝
    #[test]
    fn an_original_must_be_exactly_one_of_the_three_forms() {
        for bad in [
            json!({}),
            json!({"absent": true, "fileAbsent": true}),
            json!({"raw": "\"x\"", "absent": true}),
            json!({"absent": false}),
        ] {
            assert!(
                serde_json::from_value::<Original>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn claude_gateway_round_trips_through_store_next_to_codex() {
        let tree = TempTree::new();
        let store = Store::new(tree.root().join("data/Sophia"));
        let settings = Settings {
            codex_gateway: GatewaySettings {
                providers: vec![provider("ap", &[("gpt-x", true)])],
                ..GatewaySettings::default()
            },
            claude_gateway: ClaudeGatewaySettings {
                providers: vec![provider("ap", &[("kimi-k3", true)])],
                enabled: true,
                applied: Some(Applied {
                    phase: Phase::Done,
                    ..applied()
                }),
                ..ClaudeGatewaySettings::default()
            },
            ..Settings::default()
        };
        store.save_settings(&settings).unwrap();
        assert_eq!(store.load_settings().unwrap(), settings);
    }

    /// R3：已选、标识、撞名后缀与 Codex 同一套规则，按这一家自己的网关算
    #[test]
    fn published_uses_the_codex_rules_on_this_agents_own_providers() {
        let settings = ClaudeGatewaySettings {
            providers: vec![
                provider("ap", &[("kimi-k3", true), ("skip", false)]),
                provider("or", &[("kimi-k3", true)]),
            ],
            ..ClaudeGatewaySettings::default()
        };
        let published = settings.published();
        let slugs: Vec<&str> = published.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(slugs, ["ap-kimi-k3", "or-kimi-k3"]);
        let names: Vec<&str> = published
            .iter()
            .map(|p| p.model.display_name.as_deref().unwrap_or_default())
            .collect();
        assert_eq!(names, ["kimi-k3 · AP", "kimi-k3 · OR"]);
        assert_eq!(
            settings.routing_providers(),
            crate::codex_models::settings::routing_providers(&settings.providers)
        );
    }
}

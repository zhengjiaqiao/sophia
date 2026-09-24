//! Codex 模型网关的持久化设置，挂在 `store::Settings::codex_gateway` 下，随 settings.json 读写。
//! 字段移植自 agents-manager 的 `savedState`；纯数据，无 IO。
//!
//! 第三方网关可以有多家（`providers`）。Codex 自己同一时间只认一个 provider，
//! 本功能绕开了这个概念：所有模型在同一份目录里，路由按模型标识决定发给哪一家。
use super::catalog::{slug_for, Model, Published, RoutingProvider};
use serde::{Deserialize, Deserializer, Serialize};

/// 本机路由监听端口的默认值
pub const DEFAULT_PORT: u16 = 47328;

/// 旧的单网关设置读入时迁移成的那一家的 id；它的密钥仍在旧的钥匙串账户里
pub const LEGACY_PROVIDER_ID: &str = "default";

const PROTOCOL_CHAT: &str = "chat";
const PROTOCOL_RESPONSES: &str = "responses";
const MAX_PROVIDER_ID_LEN: usize = 32;
const FALLBACK_PROVIDER_ID: &str = "provider";

/// 模型列表里的一项：模型本身的字段平铺，外加是否勾选
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedModel {
    #[serde(flatten)]
    pub model: Model,
    #[serde(default)]
    pub selected: bool,
}

/// 一家第三方网关
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderSettings {
    /// 创建时由名称生成，之后不变：它是模型标识的前缀，也是钥匙串账户名的一部分，
    /// 改了会让 Codex 里已选的模型全部失效
    pub id: String,
    /// 显示名，可以随时改
    pub name: String,
    /// 用户填写的网关地址
    pub base_url: String,
    /// 拉取模型时探明的接口基址；换网关地址后作废
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    /// 这家网关支持的协议："chat"（默认）或 "responses"。读取请用 `protocol()`，它会归一化未知值
    pub protocol: String,
    pub models: Vec<SavedModel>,
    /// 上次拉取模型失败的原因（短句，如「地址无法访问」「密钥无效，请换一个密钥」）；拉取成功或换地址后清空
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable: Option<String>,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            api_base: None,
            protocol: PROTOCOL_CHAT.into(),
            models: Vec::new(),
            unreachable: None,
        }
    }
}

impl ProviderSettings {
    /// 当前勾选的模型，保持列表顺序
    pub fn selected(&self) -> Vec<Model> {
        self.models
            .iter()
            .filter(|saved| saved.selected)
            .map(|saved| saved.model.clone())
            .collect()
    }

    /// 路由转发请求用的基址：优先用拉取模型时探明的接口基址
    pub fn upstream_base(&self) -> &str {
        match self.api_base.as_deref() {
            Some(api_base) if !api_base.is_empty() => api_base,
            _ => &self.base_url,
        }
    }

    /// 归一化后的协议：只有明确写了 "responses" 才是 responses，其余一律 "chat"
    pub fn protocol(&self) -> &'static str {
        if self.protocol == PROTOCOL_RESPONSES {
            PROTOCOL_RESPONSES
        } else {
            PROTOCOL_CHAT
        }
    }

    /// 这家的某个模型在 Codex 里的标识
    pub fn slug_of(&self, model_id: &str) -> String {
        provider_slug(&self.id, model_id)
    }
}

/// 模型标识一律是「provider id - 模型名」：两家都提供同名模型也不会撞，
/// 而且标识只取决于这一家自己，不随别家的增删变化。模型名无法生成标识时返回空串。
pub fn provider_slug(provider_id: &str, model_id: &str) -> String {
    let base = slug_for(model_id);
    if base.is_empty() {
        return String::new();
    }
    format!("{provider_id}-{base}")
}

/// 由显示名生成一个新的 provider id：只含小写字母、数字、点、下划线和连字符，
/// 不与 `taken` 重复。名称里没有可用字符（例如纯中文）时用兜底名。
pub fn new_provider_id(name: &str, taken: &[&str]) -> String {
    let mut base: String = slug_for(name).chars().take(MAX_PROVIDER_ID_LEN).collect();
    base = base.trim_matches('-').to_owned();
    if base.is_empty() {
        base = FALLBACK_PROVIDER_ID.to_owned();
    }
    // `default` 留给旧设置迁移来的那一家：它会回退读旧钥匙串账户里的密钥，不能发给新建的网关
    let free = |id: &str| id != LEGACY_PROVIDER_ID && !taken.contains(&id);
    if free(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| free(candidate))
        .expect("an unbounded counter always finds a free id")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySettings {
    pub providers: Vec<ProviderSettings>,
    /// 0 视为未设置，读入时换成 `DEFAULT_PORT`
    pub port: u16,
    /// 原文件末行没有换行、插入时补了一个；恢复时据此还原
    pub added_newline: bool,
    pub catalog_client_version: String,
    /// 启用时 Codex 的默认模型。Codex 会把用户选中的模型写回设置；
    /// 恢复或取消勾选时，如果默认模型是本功能的第三方模型，就改回这个值
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_model: Option<String>,
    /// 启用时设置里是否本来就有 `model` 键（有但为空与没有要区分）
    pub had_prev_model: bool,
    /// 本次启用期间曾经写进合并目录的全部第三方标识，用来生成停用名单
    pub published_slugs: Vec<String>,
    /// 最近一次变更时间，Unix 秒
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_at: Option<u64>,
    /// 当前合并目录内容的指纹
    #[serde(skip_serializing_if = "String::is_empty")]
    pub catalog_fingerprint: String,
    /// Codex 能看到的状态的变更记录，由旧到新。用来回答「Codex 启动那一刻加载到的是什么」
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Change>,
}

/// 一次会被 Codex 看到的变更：从 `at` 起，注入是否开着、目录内容是什么
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Unix 秒
    pub at: u64,
    pub enabled: bool,
    /// 目录内容的指纹；没开着时无意义，留空
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub catalog: String,
}

impl Change {
    /// Codex 眼里是不是同一个状态：都没开着就是同一个，不管目录
    fn same_for_codex(&self, other: &Change) -> bool {
        match (self.enabled, other.enabled) {
            (false, false) => true,
            (true, true) => self.catalog == other.catalog,
            _ => false,
        }
    }
}

/// 变更记录最多留这么多条；再早的丢掉
const HISTORY_LIMIT: usize = 32;

impl Default for GatewaySettings {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
            port: DEFAULT_PORT,
            added_newline: false,
            catalog_client_version: String::new(),
            prev_model: None,
            had_prev_model: false,
            published_slugs: Vec::new(),
            changed_at: None,
            catalog_fingerprint: String::new(),
            history: Vec::new(),
        }
    }
}

impl GatewaySettings {
    /// 记一笔 Codex 能看到的变更。和上一笔是同一个状态就不记——要留住这个状态最早出现的时刻。
    pub fn record_change(&mut self, at: u64, enabled: bool) {
        let change = Change {
            at,
            enabled,
            catalog: if enabled {
                self.catalog_fingerprint.clone()
            } else {
                String::new()
            },
        };
        if self
            .history
            .last()
            .is_some_and(|last| last.same_for_codex(&change))
        {
            return;
        }
        self.history.push(change);
        if self.history.len() > HISTORY_LIMIT {
            let excess = self.history.len() - HISTORY_LIMIT;
            self.history.drain(..excess);
        }
    }

    /// Codex 只在启动时读一次设置：它在 `started_at` 启动，加载到的状态和现在不是一回事才需要重启。
    /// 只比「启动早于最近一次变更」会误报——比如启用又停用、中间没重启过，它其实和现状一致。
    /// 没有变更记录（旧版本留下的设置）时返回 None，由调用方按旧规则判断。
    pub fn needs_codex_restart(&self, started_at: u64) -> Option<bool> {
        let current = self.history.last()?;
        let loaded = self.history.iter().rev().find(|c| c.at <= started_at);
        Some(match loaded {
            Some(loaded) => !loaded.same_for_codex(current),
            // 比最早一笔记录还早：记录没被截断过，那时就是没开着；截断过就说不清，宁可提示
            None if self.history.len() < HISTORY_LIMIT => current.enabled,
            None => true,
        })
    }
}

/// 读入时兼容旧的单网关格式：`baseUrl` / `apiBase` / `protocol` / `models` 平铺在顶层。
/// 旧字段只读不写，下次保存就是新格式。
impl<'de> Deserialize<'de> for GatewaySettings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Raw {
            providers: Vec<ProviderSettings>,
            base_url: String,
            api_base: Option<String>,
            protocol: String,
            models: Vec<SavedModel>,
            port: u16,
            added_newline: bool,
            catalog_client_version: String,
            prev_model: Option<String>,
            had_prev_model: bool,
            published_slugs: Vec<String>,
            changed_at: Option<u64>,
            catalog_fingerprint: String,
            history: Vec<Change>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let mut providers = raw.providers;
        let has_legacy = !raw.base_url.trim().is_empty() || !raw.models.is_empty();
        if providers.is_empty() && has_legacy {
            providers.push(ProviderSettings {
                id: LEGACY_PROVIDER_ID.to_owned(),
                name: legacy_name(&raw.base_url),
                base_url: raw.base_url,
                api_base: raw.api_base,
                protocol: if raw.protocol.is_empty() {
                    PROTOCOL_CHAT.to_owned()
                } else {
                    raw.protocol
                },
                models: raw.models,
                unreachable: None,
            });
        }
        Ok(Self {
            providers,
            port: if raw.port == 0 {
                DEFAULT_PORT
            } else {
                raw.port
            },
            added_newline: raw.added_newline,
            catalog_client_version: raw.catalog_client_version,
            prev_model: raw.prev_model,
            had_prev_model: raw.had_prev_model,
            published_slugs: raw.published_slugs,
            changed_at: raw.changed_at,
            catalog_fingerprint: raw.catalog_fingerprint,
            history: raw.history,
        })
    }
}

/// 迁移来的那一家没有名字，用网关地址里的主机名；取不到就用 id
fn legacy_name(base_url: &str) -> String {
    let rest = base_url.trim();
    let rest = rest.split_once("://").map_or(rest, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    if host.is_empty() {
        LEGACY_PROVIDER_ID.to_owned()
    } else {
        host.to_owned()
    }
}

impl GatewaySettings {
    pub fn provider(&self, id: &str) -> Option<&ProviderSettings> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    pub fn provider_mut(&mut self, id: &str) -> Option<&mut ProviderSettings> {
        self.providers.iter_mut().find(|provider| provider.id == id)
    }

    /// 所有 provider 里勾选的模型，按 provider 顺序、再按各自列表顺序，带上标识与归属
    pub fn published(&self) -> Vec<Published> {
        let mut list: Vec<Published> = self
            .providers
            .iter()
            .flat_map(|provider| {
                provider.selected().into_iter().map(|model| Published {
                    slug: provider.slug_of(&model.id),
                    provider: provider.id.clone(),
                    model,
                })
            })
            .collect();

        // 两家都有同名模型时，Codex 选择器里两行会一模一样：给撞名的加上网关名。
        // 只看“跨网关”的撞名——同一家里的重名加了网关名也区分不了。标识不受影响。
        let shown = |p: &Published| -> String {
            match p.model.display_name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => name.to_owned(),
                _ => p.model.id.trim().to_owned(),
            }
        };
        let clashing: Vec<bool> = list
            .iter()
            .map(|this| {
                let name = shown(this);
                list.iter()
                    .any(|other| other.provider != this.provider && shown(other) == name)
            })
            .collect();
        for (published, clash) in list.iter_mut().zip(clashing) {
            if !clash {
                continue;
            }
            let provider_name = self
                .provider(&published.provider)
                .map(|provider| provider.name.trim())
                .filter(|name| !name.is_empty())
                .unwrap_or(&published.provider)
                .to_owned();
            published.model.display_name = Some(format!("{} · {provider_name}", shown(published)));
        }
        list
    }

    /// 写进路由清单的上游信息。路由每个请求重读清单，所以增删 provider 不用重启路由
    pub fn routing_providers(&self) -> Vec<RoutingProvider> {
        self.providers
            .iter()
            .map(|provider| RoutingProvider {
                id: provider.id.clone(),
                base_url: provider.upstream_base().to_owned(),
                protocol: provider.protocol().to_owned(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Settings, Store};
    use crate::test_support::TempTree;
    use serde_json::json;

    fn saved(id: &str, selected: bool) -> SavedModel {
        SavedModel {
            model: Model {
                id: id.into(),
                ..Model::default()
            },
            selected,
        }
    }

    fn provider(id: &str, models: Vec<SavedModel>) -> ProviderSettings {
        ProviderSettings {
            id: id.into(),
            name: id.to_uppercase(),
            base_url: format!("https://{id}.example"),
            models,
            ..ProviderSettings::default()
        }
    }

    #[test]
    fn defaults_are_no_providers_and_default_port() {
        let settings = GatewaySettings::default();
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(DEFAULT_PORT, 47328);
        assert!(settings.providers.is_empty());
        assert!(settings.published().is_empty());
        let provider = ProviderSettings::default();
        assert_eq!(provider.protocol, "chat");
        assert_eq!(provider.protocol(), "chat");
        assert_eq!(provider.upstream_base(), "");
    }

    #[test]
    fn protocol_normalizes_unknown_values_to_chat() {
        let mut provider = ProviderSettings::default();
        for (raw, want) in [
            ("responses", "responses"),
            ("chat", "chat"),
            ("", "chat"),
            ("grpc", "chat"),
        ] {
            provider.protocol = raw.into();
            assert_eq!(provider.protocol(), want, "protocol {raw:?}");
        }
    }

    #[test]
    fn upstream_base_prefers_probed_api_base() {
        let mut provider = ProviderSettings {
            base_url: "https://gw.example".into(),
            ..ProviderSettings::default()
        };
        assert_eq!(provider.upstream_base(), "https://gw.example");
        provider.api_base = Some(String::new());
        assert_eq!(provider.upstream_base(), "https://gw.example");
        provider.api_base = Some("https://gw.example/v1".into());
        assert_eq!(provider.upstream_base(), "https://gw.example/v1");
    }

    #[test]
    fn selected_keeps_order_and_skips_unselected() {
        let provider = provider(
            "a",
            vec![saved("b", true), saved("a", false), saved("c", true)],
        );
        let ids: Vec<String> = provider.selected().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["b", "c"]);
    }

    /// 两家都提供同名模型：标识带各自的前缀，互不相撞，顺序跟 provider 顺序走
    #[test]
    fn published_prefixes_slugs_so_same_model_from_two_providers_does_not_collide() {
        let settings = GatewaySettings {
            providers: vec![
                provider(
                    "wecode",
                    vec![saved("deepseek/v4", true), saved("skip", false)],
                ),
                provider("other", vec![saved("deepseek/v4", true)]),
            ],
            ..GatewaySettings::default()
        };
        let published = settings.published();
        let pairs: Vec<(&str, &str, &str)> = published
            .iter()
            .map(|p| (p.slug.as_str(), p.provider.as_str(), p.model.id.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("wecode-deepseek-v4", "wecode", "deepseek/v4"),
                ("other-deepseek-v4", "other", "deepseek/v4"),
            ]
        );
    }

    /// 两家都有同名模型时，选择器里两行会一模一样：自动加上网关名区分。
    /// 只给撞名的加，单独一家或名字不同的保持原样。
    #[test]
    fn display_names_that_clash_across_providers_get_the_provider_name_appended() {
        let mut named = saved("kimi-k3", true);
        named.model.display_name = Some("Kimi".into());
        let settings = GatewaySettings {
            providers: vec![
                provider("wecode", vec![saved("deepseek/v4", true), named]),
                provider(
                    "other",
                    vec![saved("deepseek/v4", true), saved("solo", true)],
                ),
            ],
            ..GatewaySettings::default()
        };
        let names: Vec<Option<String>> = settings
            .published()
            .into_iter()
            .map(|p| p.model.display_name)
            .collect();
        assert_eq!(
            names,
            [
                Some("deepseek/v4 · WECODE".to_owned()),
                Some("Kimi".to_owned()),
                Some("deepseek/v4 · OTHER".to_owned()),
                None,
            ]
        );
        // 标识不受显示名影响
        assert_eq!(settings.published()[0].slug, "wecode-deepseek-v4");
    }

    /// 同一家里两个模型起了同样的显示名，加网关名也区分不了，就不动它
    #[test]
    fn display_names_that_clash_within_one_provider_are_left_alone() {
        let mut a = saved("a", true);
        a.model.display_name = Some("Same".into());
        let mut b = saved("b", true);
        b.model.display_name = Some("Same".into());
        let settings = GatewaySettings {
            providers: vec![provider("wecode", vec![a, b])],
            ..GatewaySettings::default()
        };
        let names: Vec<Option<String>> = settings
            .published()
            .into_iter()
            .map(|p| p.model.display_name)
            .collect();
        assert_eq!(names, [Some("Same".to_owned()), Some("Same".to_owned())]);
    }

    /// 一家的标识只取决于它自己：别家增删、换顺序都不影响
    #[test]
    fn a_providers_slugs_do_not_depend_on_other_providers() {
        let alone = GatewaySettings {
            providers: vec![provider("b", vec![saved("m", true)])],
            ..GatewaySettings::default()
        };
        let with_others = GatewaySettings {
            providers: vec![
                provider("a", vec![saved("m", true)]),
                provider("b", vec![saved("m", true)]),
            ],
            ..GatewaySettings::default()
        };
        assert_eq!(alone.published()[0].slug, "b-m");
        assert_eq!(with_others.published()[1].slug, "b-m");
    }

    #[test]
    fn a_model_name_without_usable_characters_yields_an_empty_slug() {
        assert_eq!(provider_slug("wecode", "///"), "");
        assert_eq!(
            provider_slug("wecode", "thudm/GLM-5.2"),
            "wecode-thudm-glm-5.2"
        );
    }

    #[test]
    fn routing_providers_carry_probed_base_and_normalized_protocol() {
        let mut first = provider("a", vec![]);
        first.api_base = Some("https://a.example/openai/v1".into());
        first.protocol = "grpc".into();
        let mut second = provider("b", vec![]);
        second.protocol = "responses".into();
        let settings = GatewaySettings {
            providers: vec![first, second],
            ..GatewaySettings::default()
        };
        assert_eq!(
            settings.routing_providers(),
            vec![
                RoutingProvider {
                    id: "a".into(),
                    base_url: "https://a.example/openai/v1".into(),
                    protocol: "chat".into()
                },
                RoutingProvider {
                    id: "b".into(),
                    base_url: "https://b.example".into(),
                    protocol: "responses".into()
                },
            ]
        );
    }

    #[test]
    fn provider_ids_are_safe_unique_and_never_empty() {
        assert_eq!(new_provider_id("WeCode 内网", &[]), "wecode");
        assert_eq!(new_provider_id("Open Router", &[]), "open-router");
        assert_eq!(
            new_provider_id("微博网关", &[]),
            "provider",
            "纯中文名用兜底"
        );
        assert_eq!(new_provider_id("wecode", &["wecode"]), "wecode-2");
        assert_eq!(
            new_provider_id("wecode", &["wecode", "wecode-2"]),
            "wecode-3"
        );
        assert_eq!(new_provider_id("", &["provider"]), "provider-2");
        let long = new_provider_id(&"x".repeat(80), &[]);
        assert_eq!(long.len(), 32);
        // id 会进钥匙串账户名和模型标识：只允许这些字符
        for name in ["a/b\\c", "../etc", "a b\tc", "A:B;C"] {
            let id = new_provider_id(name, &[]);
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)),
                "{name:?} -> {id:?}"
            );
            assert!(!id.starts_with('-') && !id.ends_with('-'), "{id:?}");
        }
    }

    /// `default` 留给旧设置迁移来的那一家：它会回退读旧钥匙串账户里的密钥。
    /// 用户新建的网关叫这个名字时换一个 id，否则会拿到别家的密钥
    #[test]
    fn the_migration_id_is_never_handed_to_a_new_provider() {
        assert_eq!(new_provider_id("default", &[]), "default-2");
        assert_eq!(new_provider_id("Default", &["default-2"]), "default-3");
    }

    #[test]
    fn serializes_camel_case_with_flattened_model() {
        let settings = GatewaySettings {
            providers: vec![ProviderSettings {
                id: "wecode".into(),
                name: "WeCode".into(),
                base_url: "https://gw.example".into(),
                api_base: Some("https://gw.example/v1".into()),
                protocol: "responses".into(),
                models: vec![SavedModel {
                    model: Model {
                        id: "weibo/glm-5".into(),
                        display_name: Some("GLM".into()),
                        context_window: Some(200_000),
                        vision: true,
                    },
                    selected: true,
                }],
                unreachable: None,
            }],
            port: 5000,
            added_newline: true,
            catalog_client_version: "0.154.0".into(),
            prev_model: Some("gpt-6-astra".into()),
            had_prev_model: true,
            published_slugs: vec!["wecode-weibo-glm-5".into()],
            changed_at: Some(1_790_000_000),
            catalog_fingerprint: "abc".into(),
            history: vec![Change {
                at: 1_790_000_000,
                enabled: true,
                catalog: "abc".into(),
            }],
        };
        let value = serde_json::to_value(&settings).expect("json");
        assert_eq!(
            value,
            json!({
                "providers": [{
                    "id": "wecode",
                    "name": "WeCode",
                    "baseUrl": "https://gw.example",
                    "apiBase": "https://gw.example/v1",
                    "protocol": "responses",
                    "models": [{
                        "id": "weibo/glm-5",
                        "displayName": "GLM",
                        "contextWindow": 200000,
                        "vision": true,
                        "selected": true
                    }]
                }],
                "port": 5000,
                "addedNewline": true,
                "catalogClientVersion": "0.154.0",
                "prevModel": "gpt-6-astra",
                "hadPrevModel": true,
                "publishedSlugs": ["wecode-weibo-glm-5"],
                "changedAt": 1790000000,
                "catalogFingerprint": "abc",
                "history": [{"at": 1790000000, "enabled": true, "catalog": "abc"}]
            })
        );
        let back: GatewaySettings = serde_json::from_value(value).expect("json");
        assert_eq!(back, settings);
    }

    fn with_history(changes: &[(u64, bool, &str)]) -> GatewaySettings {
        let mut settings = GatewaySettings::default();
        for (at, enabled, catalog) in changes {
            settings.catalog_fingerprint = (*catalog).into();
            settings.record_change(*at, *enabled);
        }
        settings
    }

    #[test]
    fn restart_is_needed_only_when_codex_loaded_a_different_state() {
        // 没有记录：说不了，交给调用方
        assert_eq!(GatewaySettings::default().needs_codex_restart(100), None);
        // 启用之前就开着 → 要；启用之后才开 → 不要
        let enabled = with_history(&[(100, true, "a")]);
        assert_eq!(enabled.needs_codex_restart(50), Some(true));
        assert_eq!(enabled.needs_codex_restart(100), Some(false));
        assert_eq!(enabled.needs_codex_restart(150), Some(false));
        // 启用又停用、中间没重启：它从没加载过注入的配置
        let toggled = with_history(&[(100, true, "a"), (200, false, "")]);
        assert_eq!(toggled.needs_codex_restart(50), Some(false));
        // 开着的时候启动、之后停用：它指向的路由已经没了
        assert_eq!(toggled.needs_codex_restart(150), Some(true));
        assert_eq!(toggled.needs_codex_restart(250), Some(false));
        // 停用再原样开回来：目录一样，不要；目录变了，要
        let same = with_history(&[(100, true, "a"), (200, false, ""), (300, true, "a")]);
        assert_eq!(same.needs_codex_restart(150), Some(false));
        let changed = with_history(&[(100, true, "a"), (300, true, "b")]);
        assert_eq!(changed.needs_codex_restart(150), Some(true));
        assert_eq!(changed.needs_codex_restart(350), Some(false));
    }

    #[test]
    fn history_keeps_the_earliest_time_of_a_state_and_is_capped() {
        let settings = with_history(&[(100, true, "a"), (150, true, "a"), (180, true, "a")]);
        assert_eq!(settings.history.len(), 1);
        assert_eq!(settings.history[0].at, 100, "同一个状态只记最早那一刻");
        // 没开着时目录无所谓：连着两次停用是同一个状态
        let off = with_history(&[(100, false, "x"), (200, false, "y")]);
        assert_eq!(off.history.len(), 1);

        let mut many = GatewaySettings::default();
        for i in 0..100u64 {
            many.catalog_fingerprint = format!("c{i}");
            many.record_change(1000 + i, true);
        }
        assert_eq!(many.history.len(), HISTORY_LIMIT);
        assert_eq!(many.history.last().map(|c| c.at), Some(1099));
        // 记录被截断过，比最早一笔还早的启动说不清是什么状态：宁可提示
        assert_eq!(many.needs_codex_restart(10), Some(true));
    }

    /// 旧的单网关格式：平铺字段迁移成第一家，旧的已发布标识原样保留（它们会进停用名单）
    #[test]
    fn legacy_single_gateway_settings_migrate_into_the_first_provider() {
        let settings: GatewaySettings = serde_json::from_value(json!({
            "baseUrl": "https://ap-gateway.example/openai",
            "apiBase": "https://ap-gateway.example/openai/v1",
            "protocol": "chat",
            "models": [{"id": "thudm/glm-5.2", "selected": true}, {"id": "x"}],
            "port": 47328,
            "publishedSlugs": ["thudm-glm-5.2"],
            "hadPrevModel": true,
            "prevModel": "gpt-5.6-sol"
        }))
        .expect("json");
        assert_eq!(settings.providers.len(), 1);
        let migrated = &settings.providers[0];
        assert_eq!(migrated.id, LEGACY_PROVIDER_ID);
        assert_eq!(migrated.name, "ap-gateway.example");
        assert_eq!(migrated.base_url, "https://ap-gateway.example/openai");
        assert_eq!(
            migrated.upstream_base(),
            "https://ap-gateway.example/openai/v1"
        );
        assert_eq!(
            migrated.models,
            vec![saved("thudm/glm-5.2", true), saved("x", false)]
        );
        assert_eq!(settings.published()[0].slug, "default-thudm-glm-5.2");
        assert_eq!(settings.published_slugs, ["thudm-glm-5.2"]);
        assert_eq!(settings.prev_model.as_deref(), Some("gpt-5.6-sol"));

        // 再存一次就是新格式，旧的平铺字段不再写出
        let value = serde_json::to_value(&settings).expect("json");
        for legacy_key in ["baseUrl", "apiBase", "protocol", "models"] {
            assert!(value.get(legacy_key).is_none(), "{legacy_key} 不该再写出");
        }
        let back: GatewaySettings = serde_json::from_value(value).expect("json");
        assert_eq!(back, settings);
    }

    /// 已经是新格式时，残留的旧平铺字段不能再造出一家来
    #[test]
    fn legacy_fields_are_ignored_once_providers_exist() {
        let settings: GatewaySettings = serde_json::from_value(json!({
            "providers": [{"id": "wecode", "name": "WeCode", "baseUrl": "https://a.example"}],
            "baseUrl": "https://stale.example",
            "models": [{"id": "stale"}]
        }))
        .expect("json");
        assert_eq!(settings.providers.len(), 1);
        assert_eq!(settings.providers[0].id, "wecode");
        assert_eq!(settings.providers[0].protocol(), "chat");
    }

    #[test]
    fn partial_json_fills_defaults_and_zero_port_means_default() {
        let settings: GatewaySettings = serde_json::from_str(r#"{"port":0}"#).expect("json");
        assert_eq!(settings.port, DEFAULT_PORT);
        assert!(settings.providers.is_empty());
        assert_eq!(settings.prev_model, None);
        assert!(!settings.had_prev_model);
        assert_eq!(settings, GatewaySettings::default());
    }

    /// 旧版 settings.json 没有 codexGateway 字段，照样能读，且其余字段不受影响
    #[test]
    fn old_settings_file_without_gateway_field_still_loads() {
        let tree = TempTree::new();
        let dir = tree.dir("data/SymSync");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"disabledHarnesses":["codex"],"manualSources":[],"autoLinks":[],"mcpAutoImports":[]}"#,
        )
        .expect("write");
        let loaded = Store::new(dir).load_settings().expect("load");
        assert_eq!(loaded.disabled_harnesses, ["codex"]);
        assert_eq!(loaded.codex_gateway, GatewaySettings::default());
        assert_eq!(loaded.codex_gateway.port, DEFAULT_PORT);
    }

    #[test]
    fn gateway_settings_round_trip_through_store() {
        let tree = TempTree::new();
        let store = Store::new(tree.root().join("data/SymSync"));
        let settings = Settings {
            codex_gateway: GatewaySettings {
                providers: vec![
                    provider("wecode", vec![saved("kimi-k3", true)]),
                    provider("other", vec![saved("kimi-k3", false)]),
                ],
                published_slugs: vec!["wecode-kimi-k3".into()],
                had_prev_model: true,
                ..GatewaySettings::default()
            },
            ..Settings::default()
        };
        store.save_settings(&settings).expect("save");
        assert_eq!(store.load_settings().expect("load"), settings);
        let text =
            std::fs::read_to_string(tree.root().join("data/SymSync/settings.json")).expect("read");
        assert!(text.contains("\"codexGateway\""), "{text}");
    }
}

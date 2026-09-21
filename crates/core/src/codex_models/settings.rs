//! Codex 模型网关的持久化设置，挂在 `store::Settings::codex_gateway` 下，随 settings.json 读写。
//! 字段移植自 agents-manager 的 `savedState`；纯数据，无 IO。
use super::catalog::Model;
use serde::{Deserialize, Deserializer, Serialize};

/// 本机路由监听端口的默认值
pub const DEFAULT_PORT: u16 = 47328;

const PROTOCOL_CHAT: &str = "chat";
const PROTOCOL_RESPONSES: &str = "responses";

/// 模型列表里的一项：模型本身的字段平铺，外加是否勾选
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedModel {
    #[serde(flatten)]
    pub model: Model,
    #[serde(default)]
    pub selected: bool,
}

/// 容器级 `default` 让旧格式（缺字段）照样能读
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewaySettings {
    /// 用户填写的第三方网关地址
    pub base_url: String,
    /// 拉取模型时探明的接口基址；换网关地址后作废
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    /// 第三方网关支持的协议："chat"（默认）或 "responses"。读取请用 `protocol()`，它会归一化未知值
    pub protocol: String,
    pub models: Vec<SavedModel>,
    /// 0 视为未设置，读入时换成 `DEFAULT_PORT`
    #[serde(deserialize_with = "port_or_default")]
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
            base_url: String::new(),
            api_base: None,
            protocol: PROTOCOL_CHAT.into(),
            models: Vec::new(),
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

    /// 当前勾选的模型，保持列表顺序
    pub fn selected(&self) -> Vec<Model> {
        self.models
            .iter()
            .filter(|saved| saved.selected)
            .map(|saved| saved.model.clone())
            .collect()
    }

    /// 路由转发第三方请求用的基址：优先用拉取模型时探明的接口基址
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
}

fn port_or_default<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    Ok(match u16::deserialize(deserializer)? {
        0 => DEFAULT_PORT,
        port => port,
    })
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

    #[test]
    fn defaults_are_chat_protocol_and_default_port() {
        let settings = GatewaySettings::default();
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(DEFAULT_PORT, 47328);
        assert_eq!(settings.protocol, "chat");
        assert_eq!(settings.protocol(), "chat");
        assert!(settings.selected().is_empty());
        assert_eq!(settings.upstream_base(), "");
    }

    #[test]
    fn protocol_normalizes_unknown_values_to_chat() {
        let mut settings = GatewaySettings::default();
        for (raw, want) in [
            ("responses", "responses"),
            ("chat", "chat"),
            ("", "chat"),
            ("grpc", "chat"),
        ] {
            settings.protocol = raw.into();
            assert_eq!(settings.protocol(), want, "protocol {raw:?}");
        }
    }

    #[test]
    fn upstream_base_prefers_probed_api_base() {
        let mut settings = GatewaySettings {
            base_url: "https://gw.example".into(),
            ..GatewaySettings::default()
        };
        assert_eq!(settings.upstream_base(), "https://gw.example");
        settings.api_base = Some(String::new());
        assert_eq!(settings.upstream_base(), "https://gw.example");
        settings.api_base = Some("https://gw.example/v1".into());
        assert_eq!(settings.upstream_base(), "https://gw.example/v1");
    }

    #[test]
    fn selected_keeps_order_and_skips_unselected() {
        let settings = GatewaySettings {
            models: vec![saved("b", true), saved("a", false), saved("c", true)],
            ..GatewaySettings::default()
        };
        let ids: Vec<String> = settings.selected().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["b", "c"]);
    }

    #[test]
    fn serializes_camel_case_with_flattened_model() {
        let settings = GatewaySettings {
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
            port: 5000,
            added_newline: true,
            catalog_client_version: "0.154.0".into(),
            prev_model: Some("gpt-6-astra".into()),
            had_prev_model: true,
            published_slugs: vec!["weibo-glm-5".into()],
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
                "baseUrl": "https://gw.example",
                "apiBase": "https://gw.example/v1",
                "protocol": "responses",
                "models": [{
                    "id": "weibo/glm-5",
                    "displayName": "GLM",
                    "contextWindow": 200000,
                    "vision": true,
                    "selected": true
                }],
                "port": 5000,
                "addedNewline": true,
                "catalogClientVersion": "0.154.0",
                "prevModel": "gpt-6-astra",
                "hadPrevModel": true,
                "publishedSlugs": ["weibo-glm-5"],
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

    #[test]
    fn partial_json_fills_defaults_and_zero_port_means_default() {
        let settings: GatewaySettings = serde_json::from_str(
            r#"{"baseUrl":"https://gw.example","port":0,"models":[{"id":"x"}]}"#,
        )
        .expect("json");
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(settings.protocol(), "chat");
        assert_eq!(settings.models, vec![saved("x", false)]);
        assert_eq!(settings.prev_model, None);
        assert!(!settings.had_prev_model);
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
                base_url: "https://gw.example".into(),
                models: vec![saved("kimi-k3", true)],
                published_slugs: vec!["kimi-k3".into()],
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

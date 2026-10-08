//! Codex 模型网关的持久化设置，挂在 `store::Settings::codex_gateway` 下，随 settings.json 读写。
//! 字段移植自 agents-manager 的 `savedState`；纯数据，无 IO。
//!
//! 模型提供商是全局一份（`model_providers`，ADR 0003），Codex 选了哪些在那里的「已选」里；这里只剩写进 Codex
//! 设置的记录（端口、接法、变更记录……）。旧版按 agent 存的网关（`providers`）不再读，下次保存就不再写出；
//! 升级后 Codex 还指着旧设置时，打开 Sophia 接上那一步悄悄改回官方（`App::attach`，#259）。
use super::catalog::slug_for;
use super::login::ModeReason;
use serde::{Deserialize, Deserializer, Serialize};

/// 本机路由监听端口的默认值
pub const DEFAULT_PORT: u16 = 47328;

/// 路由可用的端口：默认端口被别的程序占着时，自动换到这里面第一个空闲的并记住（spec 2026-10-03 R4）。
/// Codex、Claude 的设置里认得这个范围内任一端口写下的路由地址：崩溃后留下的可能是换端口之前的那个
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = DEFAULT_PORT..=47339;

/// 旧的单网关设置读入时迁移成的那一家的 id；它的密钥仍在旧的钥匙串账户里
pub const LEGACY_PROVIDER_ID: &str = "default";

const MAX_PROVIDER_ID_LEN: usize = 32;
const FALLBACK_PROVIDER_ID: &str = "provider";

/// 拉取模型失败的原因种类。落盘写种类代码字符串（`"auth"` / `"network"` / `"unexpected"` / `"dns"` /
/// `"refused"` / `"timeout"` / `"tls"` / `"proxy"` / `"rateLimited"`、`"rateLimited:30"` / `"server:503"`），
/// 不存写好的句子，换语言后照当前语言显示。落成字符串是为了旧版 App 也读得了：它把这个字段当
/// 一句话，最多显示成英文代码，不会读失败。
///
/// 读取：先认这些代码；再认旧版存的句子（现在与更早的说法）→ 对应种类；都不是读成
/// [`UnreachableReason::Legacy`]，显示时原样给出、写回也是原串；下一次拉取模型会把它覆盖成种类。
/// 开发期间写过的对象形 `{"kind":"auth"}` 也能读
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnreachableReason {
    /// 密钥被拒绝
    Auth,
    /// 地址连不上（分不出更细的原因时；旧文件里的「连不上、超时」也是它）
    Network,
    /// 回来的不是模型列表
    Unexpected,
    /// 域名解析不了（spec 2026-10-04-local-diagnostics R9）
    Dns,
    /// 连接被拒：那个端口上没有服务
    Refused,
    /// 连接或等回应超时
    Timeout,
    /// 证书 / TLS 握手出错
    Tls,
    /// 走系统代理时连不上代理
    Proxy,
    /// 429：限流；带上游说的多少秒后再试（`Retry-After`）
    RateLimited(Option<u64>),
    /// 5xx：服务端出错（状态码）
    Server(u16),
    /// 填的是 Anthropic 协议的地址（`/anthropic` 一类后缀）：去掉后缀也拉不到模型列表（spec S1）
    AnthropicAddress,
    /// 旧文件里认不出的一句话，原样显示，原样写回
    Legacy(String),
}

impl UnreachableReason {
    /// 界面上的短句（当前语言）
    pub fn text(&self) -> String {
        match self {
            UnreachableReason::Auth => crate::t!("models.fetch.reasonAuth"),
            UnreachableReason::Network => crate::t!("models.fetch.reasonNetwork"),
            UnreachableReason::Unexpected => crate::t!("models.fetch.reasonUnexpected"),
            UnreachableReason::Dns => crate::t!("models.fetch.reasonDns"),
            UnreachableReason::Refused => crate::t!("models.fetch.reasonRefused"),
            UnreachableReason::Timeout => crate::t!("models.fetch.reasonTimeout"),
            UnreachableReason::Tls => crate::t!("models.fetch.reasonTls"),
            UnreachableReason::Proxy => crate::t!("models.fetch.reasonProxy"),
            UnreachableReason::RateLimited(Some(seconds)) => {
                crate::t!("models.fetch.reasonRateLimitedIn", seconds = seconds)
            }
            UnreachableReason::RateLimited(None) => crate::t!("models.fetch.reasonRateLimited"),
            UnreachableReason::Server(code) => {
                crate::t!("models.fetch.reasonServer", code = code)
            }
            UnreachableReason::AnthropicAddress => crate::t!("models.fetch.reasonAnthropic"),
            UnreachableReason::Legacy(text) => text.clone(),
        }
    }

    /// 落盘的代码；`Legacy` 没有代码（原样写回原句）
    fn code(&self) -> Option<String> {
        Some(match self {
            UnreachableReason::Auth => "auth".into(),
            UnreachableReason::Network => "network".into(),
            UnreachableReason::Unexpected => "unexpected".into(),
            UnreachableReason::Dns => "dns".into(),
            UnreachableReason::Refused => "refused".into(),
            UnreachableReason::Timeout => "timeout".into(),
            UnreachableReason::Tls => "tls".into(),
            UnreachableReason::Proxy => "proxy".into(),
            UnreachableReason::RateLimited(None) => "rateLimited".into(),
            UnreachableReason::RateLimited(Some(seconds)) => format!("rateLimited:{seconds}"),
            UnreachableReason::Server(code) => format!("server:{code}"),
            UnreachableReason::AnthropicAddress => "anthropicAddress".into(),
            UnreachableReason::Legacy(_) => return None,
        })
    }

    /// 认代码；认不出为 None
    fn from_code(code: &str) -> Option<Self> {
        Some(match code {
            "auth" => UnreachableReason::Auth,
            "network" => UnreachableReason::Network,
            "unexpected" => UnreachableReason::Unexpected,
            "dns" => UnreachableReason::Dns,
            "refused" => UnreachableReason::Refused,
            "timeout" => UnreachableReason::Timeout,
            "tls" => UnreachableReason::Tls,
            "proxy" => UnreachableReason::Proxy,
            "rateLimited" => UnreachableReason::RateLimited(None),
            "anthropicAddress" => UnreachableReason::AnthropicAddress,
            _ => {
                if let Some(seconds) = code.strip_prefix("rateLimited:") {
                    UnreachableReason::RateLimited(Some(seconds.parse().ok()?))
                } else {
                    UnreachableReason::Server(code.strip_prefix("server:")?.parse().ok()?)
                }
            }
        })
    }

    /// 旧文件里的句子：现在的说法与 2026-09-24 文案语域 D24 之前的说法，都认成对应种类
    fn from_legacy_text(text: String) -> Self {
        let text_is = |sentences: [&str; 2]| sentences.contains(&text.as_str());
        if text_is([
            "密钥无效，请换一个密钥", // i18n-exempt: 旧版落盘的原文，按它认出旧值
            "密钥不对",               // i18n-exempt: 旧版落盘的原文，按它认出旧值
        ]) {
            UnreachableReason::Auth
        } else if text_is([
            "地址无法访问", // i18n-exempt: 旧版落盘的原文，按它认出旧值
            "地址连不上",   // i18n-exempt: 旧版落盘的原文，按它认出旧值
        ]) {
            UnreachableReason::Network
        } else if text_is([
            "地址有误，无法获取模型列表", // i18n-exempt: 旧版落盘的原文，按它认出旧值
            "地址不对，没拿到模型列表",   // i18n-exempt: 旧版落盘的原文，按它认出旧值
        ]) {
            UnreachableReason::Unexpected
        } else {
            UnreachableReason::Legacy(text)
        }
    }
}

impl Serialize for UnreachableReason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match (self, self.code()) {
            (UnreachableReason::Legacy(text), _) => serializer.serialize_str(text),
            (_, code) => serializer.serialize_str(&code.unwrap_or_default()),
        }
    }
}

impl<'de> Deserialize<'de> for UnreachableReason {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Text(String),
            Kind { kind: String },
        }
        Ok(match Wire::deserialize(de)? {
            Wire::Text(text) => match UnreachableReason::from_code(&text) {
                Some(reason) => reason,
                None => UnreachableReason::from_legacy_text(text),
            },
            // 开发期间写过的对象形；认不得的种类当成「回来的不是模型列表」，总比读不出整份设置好
            Wire::Kind { kind } => match kind.as_str() {
                "auth" => UnreachableReason::Auth,
                "network" => UnreachableReason::Network,
                _ => UnreachableReason::Unexpected,
            },
        })
    }
}

/// 地址的主体：主机名去掉开头的 `api.` / `www.` 后取第一段（`https://relay.example.com/v1` → `relay`），
/// IP 原样；取不到为 None。全局模型提供商的默认名称用它
pub fn address_short_name(raw: &str) -> Option<String> {
    let host = host_of(raw);
    if host.is_empty() {
        return None;
    }
    if is_ip_host(&host) {
        return Some(host);
    }
    let mut labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    while labels.len() > 1 && matches!(labels[0], "api" | "www") {
        labels.remove(0);
    }
    labels.first().map(|l| (*l).to_owned())
}

/// 地址（或像地址的名字）里的主机名，小写；没写协议的（`localhost:4000`）也认。取不到是空串
fn host_of(raw: &str) -> String {
    let rest = raw.trim();
    let rest = rest.split_once("://").map_or(rest, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, a)| a);
    let host = if authority.starts_with('[') {
        // IPv6 字面量带方括号原样保留（`[::1]`）
        match authority.find(']') {
            Some(end) => &authority[..=end],
            None => return String::new(),
        }
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
            Some(_) => return String::new(),
            None => authority,
        }
    };
    let valid = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '[' | ']' | ':'));
    if host.is_empty() || !valid {
        return String::new();
    }
    host.to_ascii_lowercase()
}

/// IPv4 四段数字，或方括号里的 IPv6
fn is_ip_host(host: &str) -> bool {
    if host.starts_with('[') && host.ends_with(']') {
        return host.len() > 2;
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit()))
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

/// Codex 接第三方模型的两种接法（spec 2026-10-03-codex-hookup-auto）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookupMode {
    /// 借用 Codex 内置的 `openai` 服务商：只写 `openai_base_url` 与 `model_catalog_json`，要求 OpenAI 登录
    #[default]
    Builtin,
    /// 独立服务商：再写 `model_provider = "sophia"` 与 `[model_providers.sophia]`，不需要登录
    Provider,
}

impl HookupMode {
    pub fn is_builtin(&self) -> bool {
        *self == HookupMode::Builtin
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySettings {
    /// 用户是否开着 Codex 的第三方模型（只由模型页开关改变；退出、关机把 Codex 设置改回，这里不变，
    /// 下次打开 Sophia 时据此自动接上）。None：旧版本留下的设置，第一次加载时由编排层按
    /// 「Codex 设置现在指着路由」补上
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
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
    /// 当前（最近一次）写进 Codex 设置的接法；老文件没有这个字段，读成借用内置
    #[serde(skip_serializing_if = "HookupMode::is_builtin")]
    pub mode: HookupMode,
    /// 选这种接法的原因（模型页那一行说明用）；还没判断过为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_reason: Option<ModeReason>,
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
    /// Codex 设置里写的路由端口；没开着、或旧版本的记录为 0（不知道，当作没变）
    #[serde(default, skip_serializing_if = "is_zero")]
    pub port: u16,
    /// 写着的接法；没开着、或旧版本的记录为借用内置
    #[serde(default, skip_serializing_if = "HookupMode::is_builtin")]
    pub mode: HookupMode,
}

fn is_zero(port: &u16) -> bool {
    *port == 0
}

impl Change {
    /// Codex 眼里是不是同一个状态：都没开着就是同一个，不管目录
    fn same_for_codex(&self, other: &Change) -> bool {
        match (self.enabled, other.enabled) {
            (false, false) => true,
            (true, true) => {
                self.catalog == other.catalog
                    && self.mode == other.mode
                    && (self.port == 0 || other.port == 0 || self.port == other.port)
            }
            _ => false,
        }
    }
}

/// 变更记录最多留这么多条；再早的丢掉
const HISTORY_LIMIT: usize = 32;

impl Default for GatewaySettings {
    fn default() -> Self {
        Self {
            enabled: None,
            port: DEFAULT_PORT,
            added_newline: false,
            catalog_client_version: String::new(),
            prev_model: None,
            had_prev_model: false,
            published_slugs: Vec::new(),
            changed_at: None,
            catalog_fingerprint: String::new(),
            history: Vec::new(),
            mode: HookupMode::Builtin,
            mode_reason: None,
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
            port: if enabled { self.port } else { 0 },
            mode: if enabled {
                self.mode
            } else {
                HookupMode::Builtin
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

/// 读入时忽略旧版的网关列表：按 agent 存的网关（`providers`）与更早的单网关平铺字段（`baseUrl` / `models`）
/// 不迁移（ADR 0003），下次保存就不再写出
impl<'de> Deserialize<'de> for GatewaySettings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Raw {
            enabled: Option<bool>,
            port: u16,
            added_newline: bool,
            catalog_client_version: String,
            prev_model: Option<String>,
            had_prev_model: bool,
            published_slugs: Vec<String>,
            changed_at: Option<u64>,
            catalog_fingerprint: String,
            history: Vec<Change>,
            mode: HookupMode,
            mode_reason: Option<ModeReason>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            enabled: raw.enabled,
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
            mode: raw.mode,
            mode_reason: raw.mode_reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Settings, Store};
    use crate::test_support::TempTree;
    use serde_json::json;

    /// 连不上的原因现在记在全局提供商上（`model_providers::Provider`），落盘形状同旧网关
    type ProviderSettings = crate::model_providers::Provider;

    fn provider(id: &str) -> ProviderSettings {
        ProviderSettings {
            id: id.into(),
            name: id.to_uppercase(),
            base_url: format!("https://{id}.example"),
            ..ProviderSettings::default()
        }
    }

    #[test]
    fn legacy_unreachable_reasons_read_as_current_wording() {
        let settings: crate::model_providers::ModelProviders = serde_json::from_value(json!({
            "providers": [
                {"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": "地址连不上"},
                {"id": "b", "name": "b", "baseUrl": "https://b.test", "unreachable": "密钥不对"},
                {"id": "c", "name": "c", "baseUrl": "https://c.test", "unreachable": "地址不对，没拿到模型列表"},
                {"id": "d", "name": "d", "baseUrl": "https://d.test", "unreachable": "超时"},
                {"id": "e", "name": "e", "baseUrl": "https://e.test"}
            ]
        }))
        .expect("json");
        let reasons: Vec<Option<String>> = settings
            .providers
            .iter()
            .map(|p| p.unreachable.as_ref().map(UnreachableReason::text))
            .collect();
        let expected: Vec<Option<&str>> = vec![
            Some("地址无法访问"),
            Some("密钥无效，请换一个密钥"),
            Some("地址有误，返回的不是模型列表"),
            Some("超时"),
            None,
        ];
        assert_eq!(
            reasons.iter().map(Option::as_deref).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            settings.providers[3].unreachable,
            Some(UnreachableReason::Legacy("超时".into())),
            "认不出的旧句读成「旧句」种类"
        );
    }

    /// 落盘写种类代码字符串（旧版 App 把它当一句话读，不会读失败）；写读来回一致；
    /// 三个代码、对象形、旧句、未知串都能读
    #[test]
    fn unreachable_reason_persists_as_code_string_and_reads_every_shape() {
        // 旧版 App 的形状：`unreachable` 是 Option<String>
        #[derive(Deserialize)]
        struct OldProvider {
            unreachable: Option<String>,
        }
        for (reason, code) in [
            (UnreachableReason::Auth, "auth"),
            (UnreachableReason::Network, "network"),
            (UnreachableReason::Unexpected, "unexpected"),
            (UnreachableReason::Dns, "dns"),
            (UnreachableReason::Refused, "refused"),
            (UnreachableReason::Timeout, "timeout"),
            (UnreachableReason::Tls, "tls"),
            (UnreachableReason::Proxy, "proxy"),
            (UnreachableReason::RateLimited(Some(30)), "rateLimited:30"),
            (UnreachableReason::RateLimited(None), "rateLimited"),
            (UnreachableReason::Server(503), "server:503"),
        ] {
            let mut p = provider("a");
            p.unreachable = Some(reason.clone());
            let value = serde_json::to_value(&p).unwrap();
            assert_eq!(value["unreachable"], json!(code));
            let old: OldProvider = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(old.unreachable.as_deref(), Some(code), "旧版读得了");
            let back: ProviderSettings = serde_json::from_value(value).unwrap();
            assert_eq!(back.unreachable, Some(reason));
        }
        let mut p = provider("a");
        p.unreachable = Some(UnreachableReason::Auth);
        let value = serde_json::to_value(&p).unwrap();
        let back: ProviderSettings = serde_json::from_value(value).unwrap();
        assert_eq!(back.unreachable, Some(UnreachableReason::Auth));
        assert_eq!(back.unreachable.unwrap().text(), "密钥无效，请换一个密钥");

        // 旧文件：现在的说法（没经过 D24 前的迁移）也认成种类，换语言后跟着换
        let old: ProviderSettings = serde_json::from_value(
            json!({"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": "地址无法访问"}),
        )
        .unwrap();
        assert_eq!(old.unreachable, Some(UnreachableReason::Network));

        // 认不出的旧句：显示原样，写回也原样（不丢信息）
        let odd: ProviderSettings = serde_json::from_value(
            json!({"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": "某句旧话"}),
        )
        .unwrap();
        assert_eq!(odd.unreachable.as_ref().unwrap().text(), "某句旧话");
        assert_eq!(
            serde_json::to_value(&odd).unwrap()["unreachable"],
            json!("某句旧话")
        );

        // 开发期间写过的对象形
        let object: ProviderSettings = serde_json::from_value(
            json!({"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": {"kind": "auth"}}),
        )
        .unwrap();
        assert_eq!(object.unreachable, Some(UnreachableReason::Auth));

        // 更新版本写的、认不得的种类：不让整份设置读不出来
        let future: ProviderSettings = serde_json::from_value(
            json!({"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": {"kind": "quota"}}),
        )
        .unwrap();
        assert_eq!(future.unreachable, Some(UnreachableReason::Unexpected));
    }

    /// spec 2026-10-04-local-diagnostics R9 / AC8：每种连不上的原因各说各的
    #[test]
    fn each_unreachable_reason_has_its_own_sentence() {
        let cases = [
            (UnreachableReason::Dns, "找不到这个地址（检查地址或内网）"),
            (UnreachableReason::Refused, "无法连接，对方没在这个端口上"),
            (UnreachableReason::Timeout, "连接超时（检查网络或内网）"),
            (UnreachableReason::Tls, "证书有问题，不能安全连接"),
            (UnreachableReason::Proxy, "无法连接代理（检查系统代理）"),
            (
                UnreachableReason::RateLimited(Some(30)),
                "模型提供商限流了，约 30 秒后再试",
            ),
            (
                UnreachableReason::RateLimited(None),
                "模型提供商限流了，稍后再试",
            ),
            (
                UnreachableReason::Server(503),
                "模型提供商出了问题（HTTP 503），稍后再试",
            ),
            (UnreachableReason::Auth, "密钥无效，请换一个密钥"),
            (
                UnreachableReason::Unexpected,
                "地址有误，返回的不是模型列表",
            ),
        ];
        for (reason, text) in cases {
            assert_eq!(reason.text(), text);
        }
        // 写坏了的新代码（数字读不出）：不让整份设置读不出来，原样当旧句显示
        let odd: ProviderSettings = serde_json::from_value(
            json!({"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": "server:abc"}),
        )
        .unwrap();
        assert_eq!(
            odd.unreachable,
            Some(UnreachableReason::Legacy("server:abc".into()))
        );
    }

    /// 技术原文与原因一起存（`unreachableDetail`），没有就不写这个键；旧文件没有它照样读
    #[test]
    fn unreachable_detail_persists_next_to_the_reason() {
        let mut p = provider("a");
        p.unreachable = Some(UnreachableReason::RateLimited(Some(30)));
        p.unreachable_detail = Some("GET https://a.test/models → 429".into());
        let value = serde_json::to_value(&p).unwrap();
        assert_eq!(
            value["unreachableDetail"],
            json!("GET https://a.test/models → 429")
        );
        let back: ProviderSettings = serde_json::from_value(value).unwrap();
        assert_eq!(back, p);

        let plain = serde_json::to_value(provider("b")).unwrap();
        assert!(plain.get("unreachableDetail").is_none());
        let old: ProviderSettings = serde_json::from_value(
            json!({"id": "a", "name": "a", "baseUrl": "https://a.test", "unreachable": "network"}),
        )
        .unwrap();
        assert_eq!(old.unreachable_detail, None);
    }

    /// 真实调用被拒了密钥（#144）：记成「密钥无效」并标明来源；再记一次不算变化；清只清这一种。
    /// 落盘只多一个 `keyRejectedOnCall: true`，为假不写；旧版 App 的形状读得了（不认的键忽略）
    #[test]
    fn key_rejection_on_call_marks_once_clears_only_itself_and_stays_readable() {
        let mut p = provider("a");
        assert!(p.mark_key_rejected(Some("POST https://a.test/chat/completions → 401".into())));
        assert_eq!(p.unreachable, Some(UnreachableReason::Auth));
        assert!(p.key_rejected_on_call);
        assert!(
            !p.mark_key_rejected(Some("另一句原文".into())),
            "已经记着：不改"
        );
        assert_eq!(
            p.unreachable_detail.as_deref(),
            Some("POST https://a.test/chat/completions → 401")
        );

        let value = serde_json::to_value(&p).unwrap();
        assert_eq!(value["unreachable"], json!("auth"));
        assert_eq!(value["keyRejectedOnCall"], json!(true));
        #[derive(Deserialize)]
        struct OldProvider {
            unreachable: Option<String>,
        }
        let old: OldProvider = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(old.unreachable.as_deref(), Some("auth"), "旧版读得了");
        let back: ProviderSettings = serde_json::from_value(value).unwrap();
        assert_eq!(back, p);

        assert!(p.clear_key_rejection());
        assert_eq!(p.unreachable, None);
        assert_eq!(p.unreachable_detail, None);
        assert!(!p.clear_key_rejection(), "清过了：不再算变化");
        assert!(serde_json::to_value(&p)
            .unwrap()
            .get("keyRejectedOnCall")
            .is_none());

        // 拉列表记下的原因不归它清
        p.unreachable = Some(UnreachableReason::Auth);
        assert!(!p.clear_key_rejection());
        assert_eq!(p.unreachable, Some(UnreachableReason::Auth));
    }

    #[test]
    fn defaults_are_the_default_port_and_nothing_legacy() {
        let settings = GatewaySettings::default();
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(DEFAULT_PORT, 47328);
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
    fn serializes_camel_case() {
        let settings = GatewaySettings {
            enabled: None,
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
                port: 0,
                mode: HookupMode::Builtin,
            }],
            mode: HookupMode::Builtin,
            mode_reason: None,
        };
        let value = serde_json::to_value(&settings).expect("json");
        assert_eq!(
            value,
            json!({
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

    /// 换了端口：正在运行的 Codex 还指着旧端口，要重启；没记端口的旧记录当作同一个端口
    #[test]
    fn a_port_move_needs_a_restart() {
        let mut settings = with_history(&[(100, true, "a")]);
        settings.port = 47329;
        settings.record_change(200, true);
        assert_eq!(settings.needs_codex_restart(150), Some(true));
        assert_eq!(settings.needs_codex_restart(250), Some(false));

        let legacy: GatewaySettings = serde_json::from_value(json!({
            "port": 47328,
            "catalogFingerprint": "a",
            "history": [{"at": 100, "enabled": true, "catalog": "a"}]
        }))
        .expect("json");
        let mut legacy = legacy;
        legacy.record_change(200, true);
        assert_eq!(legacy.history.len(), 1, "旧记录没有端口：不算变了");
        assert_eq!(legacy.needs_codex_restart(150), Some(false));
    }

    /// 换接法（借用内置 ↔ 独立服务商）是 Codex 看得到的变化：要重启（R9）
    #[test]
    fn a_mode_switch_needs_a_restart() {
        let mut settings = with_history(&[(100, true, "a")]);
        settings.mode = HookupMode::Provider;
        settings.record_change(200, true);
        assert_eq!(settings.history.len(), 2);
        assert_eq!(settings.needs_codex_restart(150), Some(true));
        assert_eq!(settings.needs_codex_restart(250), Some(false));
    }

    /// 接法与原因随设置读写；老文件没有 mode，读成借用内置，写回也不多出字段
    #[test]
    fn mode_round_trips_and_defaults_to_builtin() {
        let legacy: GatewaySettings = serde_json::from_value(json!({"port": 47328})).expect("json");
        assert_eq!(legacy.mode, HookupMode::Builtin);
        assert_eq!(legacy.mode_reason, None);
        let value = serde_json::to_value(&legacy).unwrap();
        assert!(value.get("mode").is_none() && value.get("modeReason").is_none());
        let provider = GatewaySettings {
            mode: HookupMode::Provider,
            mode_reason: Some(ModeReason::SignedOut),
            ..Default::default()
        };
        let value = serde_json::to_value(&provider).unwrap();
        assert_eq!(value["mode"], json!("provider"));
        assert_eq!(value["modeReason"], json!("signedOut"));
        let back: GatewaySettings = serde_json::from_value(value).unwrap();
        assert_eq!(back, provider);
    }

    /// 「开着」是用户的选择，单独存；老数据没有这个字段，读成 None 由编排层补
    #[test]
    fn enabled_choice_is_optional_and_round_trips() {
        let legacy: GatewaySettings = serde_json::from_value(json!({"port": 47328})).expect("json");
        assert_eq!(legacy.enabled, None);
        assert!(serde_json::to_value(&legacy)
            .unwrap()
            .get("enabled")
            .is_none());
        let on = GatewaySettings {
            enabled: Some(true),
            ..Default::default()
        };
        let value = serde_json::to_value(&on).unwrap();
        assert_eq!(value["enabled"], json!(true));
        let back: GatewaySettings = serde_json::from_value(value).unwrap();
        assert_eq!(back.enabled, Some(true));
    }

    #[test]
    fn port_range_starts_at_the_default_port() {
        assert_eq!(*PORT_RANGE.start(), DEFAULT_PORT);
        assert_eq!(*PORT_RANGE.end(), 47339);
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

    /// 旧版按 agent 存的网关（`providers`）与更早的单网关平铺字段：不迁移；别的记录照读，
    /// 再存一次旧字段就不写出了（ADR 0003、#259）
    #[test]
    fn old_gateway_lists_are_not_carried_over() {
        for old in [
            json!({"providers": [{"id": "wecode", "name": "WeCode", "baseUrl": "https://a.example"}],
                   "enabled": true, "publishedSlugs": ["wecode-glm"]}),
            json!({"baseUrl": "https://ap-gateway.example/openai", "models": [{"id": "x", "selected": true}],
                   "enabled": true, "publishedSlugs": ["wecode-glm"]}),
        ] {
            let settings: GatewaySettings = serde_json::from_value(old).expect("json");
            assert_eq!(settings.enabled, Some(true));
            assert_eq!(settings.published_slugs, ["wecode-glm"]);
            let value = serde_json::to_value(&settings).expect("json");
            for key in ["providers", "baseUrl", "models"] {
                assert!(value.get(key).is_none(), "{key} 不该再写出");
            }
        }
    }

    #[test]
    fn partial_json_fills_defaults_and_zero_port_means_default() {
        let settings: GatewaySettings = serde_json::from_str(r#"{"port":0}"#).expect("json");
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(settings.prev_model, None);
        assert!(!settings.had_prev_model);
        assert_eq!(settings, GatewaySettings::default());
    }

    /// 旧版 settings.json 没有 codexGateway 字段，照样能读，且其余字段不受影响
    #[test]
    fn old_settings_file_without_gateway_field_still_loads() {
        let tree = TempTree::new();
        let dir = tree.dir("data/Sophia");
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
        let store = Store::new(tree.root().join("data/Sophia"));
        let settings = Settings {
            codex_gateway: GatewaySettings {
                published_slugs: vec!["wecode-kimi-k3".into()],
                had_prev_model: true,
                ..GatewaySettings::default()
            },
            ..Settings::default()
        };
        store.save_settings(&settings).expect("save");
        assert_eq!(store.load_settings().expect("load"), settings);
        let text =
            std::fs::read_to_string(tree.root().join("data/Sophia/settings.json")).expect("read");
        assert!(text.contains("\"codexGateway\""), "{text}");
    }
}

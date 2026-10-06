//! 服务商预设（spec S1，sophia-dev#95）：内置的一份第三方服务商名单，每家带地址与协议，用户选一家只填密钥。
//! 数据在 `data/provider-presets.json`，由 `scripts/merge-provider-presets.py` 从 cc-switch 与 magpie（均 MIT）
//! 的公开名单合并而来，随版本发布；这里只负责读出来、给界面与命令层用，不联网、不改写。
use serde::{Deserialize, Serialize};

const PRESETS_JSON: &str = include_str!("../data/provider-presets.json");

/// 一家服务商的一个可用地址
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetEndpoint {
    pub api_base: String,
    /// `chat` / `responses`（OpenAI 兼容的两种）；Anthropic 地址没有这个字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

/// 一家服务商预设。`openai` 是 Sophia 现在能接的地址（Codex、Claude 两家都走它）；`anthropic` 只记着，
/// 等 Anthropic 直通做好再用——只有 `anthropic` 的那几家界面上标「暂不支持」
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: String,
    pub name: String,
    pub website: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys_url: Option<String>,
    /// `cn` / `global`：界面分「国内」「海外」两组
    pub region: String,
    #[serde(default)]
    pub openai: Option<PresetEndpoint>,
    #[serde(default)]
    pub anthropic: Option<PresetEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ProviderPreset {
    /// Sophia 现在接得上（有 OpenAI 兼容地址）
    pub fn supported(&self) -> bool {
        self.openai.is_some()
    }
}

#[derive(Deserialize)]
struct PresetFile {
    providers: Vec<ProviderPreset>,
}

/// 全部预设，按数据文件里的顺序（国内在前、海外在后，各组内沿用来源的顺序）
pub fn all() -> Vec<ProviderPreset> {
    serde_json::from_str::<PresetFile>(PRESETS_JSON)
        .expect("provider-presets.json 内置数据必须合法")
        .providers
}

/// 按 id 取一家
pub fn find(id: &str) -> Option<ProviderPreset> {
    all().into_iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 数据文件的硬约束：id 唯一且 kebab-case、至少一侧有地址、地址以 http(s):// 开头且不以 / 结尾、
    /// 协议只能是 chat / responses、分组只能是 cn / global；国内一组排在前面
    #[test]
    fn 预设数据文件合法() {
        let presets = all();
        assert!(presets.len() > 50, "名单不该缩水：{}", presets.len());
        let mut ids = HashSet::new();
        let mut seen_global = false;
        for p in &presets {
            assert!(ids.insert(p.id.clone()), "id 重复：{}", p.id);
            assert!(
                p.id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "id 要是 kebab-case：{}",
                p.id
            );
            assert!(!p.name.trim().is_empty(), "{} 没有名字", p.id);
            assert!(
                p.openai.is_some() || p.anthropic.is_some(),
                "{} 没有地址",
                p.id
            );
            for side in [&p.openai, &p.anthropic].into_iter().flatten() {
                assert!(
                    side.api_base.starts_with("http://") || side.api_base.starts_with("https://"),
                    "{} 地址不合法：{}",
                    p.id,
                    side.api_base
                );
                assert!(
                    !side.api_base.ends_with('/'),
                    "{} 地址末尾有 /：{}",
                    p.id,
                    side.api_base
                );
            }
            if let Some(openai) = &p.openai {
                assert!(
                    matches!(openai.protocol.as_deref(), Some("chat") | Some("responses")),
                    "{} 协议不合法：{:?}",
                    p.id,
                    openai.protocol
                );
            }
            assert!(
                matches!(p.region.as_str(), "cn" | "global"),
                "{} 分组不合法",
                p.id
            );
            if p.region == "global" {
                seen_global = true;
            } else {
                assert!(!seen_global, "国内要排在海外前面：{}", p.id);
            }
        }
        assert!(find("deepseek").is_some_and(|p| p.supported()));
    }

    /// 来源里的推广链接不带进来（`/i/<码>`、`/invite/`、`/register/<码>`、`/agent/register/<码>`、
    /// `?aff=` 一类查询参数、`ccswitch` 活动页、短链）。不带码的 `/register` 是普通注册页，放行
    #[test]
    fn 预设里没有推广链接() {
        for p in all() {
            for url in [Some(&p.website), p.keys_url.as_ref()]
                .into_iter()
                .flatten()
            {
                let lower = url.to_ascii_lowercase();
                // `/register/` 后面还跟一截路径就是推广码；查询里带 aff / ref 等参数同理
                let register_code = lower
                    .split_once("/register/")
                    .is_some_and(|(_, rest)| !rest.is_empty());
                let promo_query = lower.split_once('?').is_some_and(|(_, query)| {
                    query.split('&').any(|kv| {
                        let key = kv.split('=').next().unwrap_or("");
                        matches!(
                            key,
                            "aff"
                                | "aff_code"
                                | "ref"
                                | "referral"
                                | "invite"
                                | "invite_code"
                                | "inviter"
                                | "promo"
                        )
                    })
                });
                assert!(
                    !register_code
                        && !promo_query
                        && !lower.contains("/i/")
                        && !lower.contains("/invite/")
                        && !lower.contains("ccswitch")
                        && !lower.contains("cc-switch")
                        && !lower.starts_with("https://s.qiniu.com"),
                    "{} 带推广链接：{url}",
                    p.id
                );
            }
        }
    }
}

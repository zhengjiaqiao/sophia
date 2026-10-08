//! 加一家模型提供商时默认启用哪些模型，以及哪些模型不算对话模型（spec #247「三」、画板第 3 屏）。纯函数，无 IO。
//!
//! 规则只有三条，每次都写明用了哪一条（提示条、「启用模型」浮层顶部、提供商行）：
//! 1. 预设有推荐模型：只启用推荐的（推荐里接口没列出来的不算）；
//! 2. 没有推荐、对话模型不超过 [`DEFAULT_ENABLE_LIMIT`] 个：全部启用；
//! 3. 超过：一个都不启用，界面直接打开「启用模型」让用户挑。
//!
//! 不是对话模型的（名字带 embed、rerank、tts…）不进列表；关键词只在 [`NON_CHAT_MARKS`] 这一处维护，
//! 误判的靠用户手填 id 加回来。
use serde::{Deserialize, Serialize};

/// 没有推荐时，对话模型不超过这么多个就全部启用
pub const DEFAULT_ENABLE_LIMIT: usize = 20;

/// 名字里带这些片段的多半不能对话（向量、重排、语音、审核、画图、实时语音、视频），小写比较
pub const NON_CHAT_MARKS: &[&str] = &[
    "embed",
    "rerank",
    "tts",
    "whisper",
    "transcribe",
    "moderation",
    "dall-e",
    "stable-diffusion",
    "sdxl",
    "image",
    "audio",
    "realtime",
    "sora",
];

/// 按名字判断是不是对话模型（Codex、Claude、WorkBuddy 只会拿它对话）
pub fn is_chat_model(id: &str) -> bool {
    let name = id.to_lowercase();
    !NON_CHAT_MARKS.iter().any(|mark| name.contains(mark))
}

/// 默认启用用了哪一条规则
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DefaultRule {
    /// 预设有推荐模型，只启用推荐的
    Recommended,
    /// 没有推荐，对话模型不多，全部启用
    All,
    /// 没有推荐，对话模型太多，一个都不启用
    TooMany,
}

/// 默认启用的结论：启用哪些（接口列表里的写法、按列表顺序）与用了哪条规则
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultEnable {
    pub enabled: Vec<String>,
    pub rule: DefaultRule,
}

/// 默认启用规则。`recommended` 是预设的推荐模型（可空）；`listed` 是接口返回、已滤掉非对话模型的列表。
/// 推荐按 id 认、不分大小写；推荐里一个都没在列表里出现时当作没有推荐
pub fn default_enable(recommended: &[String], listed: &[String]) -> DefaultEnable {
    let picked: Vec<String> = listed
        .iter()
        .filter(|id| {
            recommended
                .iter()
                .any(|r| r.trim().eq_ignore_ascii_case(id))
        })
        .cloned()
        .collect();
    if !picked.is_empty() {
        return DefaultEnable {
            enabled: picked,
            rule: DefaultRule::Recommended,
        };
    }
    if listed.len() <= DEFAULT_ENABLE_LIMIT {
        DefaultEnable {
            enabled: listed.to_vec(),
            rule: DefaultRule::All,
        }
    } else {
        DefaultEnable {
            enabled: Vec::new(),
            rule: DefaultRule::TooMany,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    fn many(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("model-{i}")).collect()
    }

    /// 情况一：预设有推荐，只启用推荐的、按接口列表的顺序与写法；推荐里列表没有的不算
    #[test]
    fn a_preset_with_recommended_models_enables_only_those() {
        let listed = ids(&[
            "moonshot-v1-8k",
            "Kimi-K2.6",
            "kimi-for-coding",
            "kimi-k2.5",
        ]);
        let got = default_enable(
            &ids(&["kimi-k2.6", "kimi-for-coding", "kimi-gone"]),
            &listed,
        );
        assert_eq!(got.rule, DefaultRule::Recommended);
        assert_eq!(got.enabled, ids(&["Kimi-K2.6", "kimi-for-coding"]));
    }

    /// 情况二：没有推荐、对话模型不超过 20 个，全部启用；正好 20 个也算
    #[test]
    fn without_recommendations_twenty_or_fewer_are_all_enabled() {
        let got = default_enable(&[], &many(12));
        assert_eq!(got.rule, DefaultRule::All);
        assert_eq!(got.enabled.len(), 12);
        assert_eq!(default_enable(&[], &many(20)).rule, DefaultRule::All);
    }

    /// 情况三：超过 20 个，一个都不启用（界面去打开「启用模型」）
    #[test]
    fn without_recommendations_more_than_twenty_enables_none() {
        let got = default_enable(&[], &many(21));
        assert_eq!(got.rule, DefaultRule::TooMany);
        assert!(got.enabled.is_empty());
    }

    /// 推荐一个都不在列表里：当作没有推荐，按数量走
    #[test]
    fn recommendations_missing_from_the_list_fall_back_to_the_count_rules() {
        let got = default_enable(&ids(&["kimi-gone"]), &many(456));
        assert_eq!(got.rule, DefaultRule::TooMany);
        assert_eq!(
            default_enable(&ids(&["kimi-gone"]), &many(3)).rule,
            DefaultRule::All
        );
    }

    #[test]
    fn non_chat_models_are_recognised_by_name() {
        for id in [
            "text-embedding-3-large",
            "bge-reranker-v2",
            "gpt-4o-mini-tts",
            "whisper-1",
            "gpt-4o-transcribe",
            "omni-moderation-latest",
            "dall-e-3",
            "gpt-image-1",
            "gpt-4o-audio-preview",
            "gpt-realtime",
            "sora-2",
            "Qwen-Image-Edit",
        ] {
            assert!(!is_chat_model(id), "{id} 不是对话模型");
        }
        for id in [
            "kimi-k2.6",
            "deepseek-v4",
            "gpt-5.5-codex",
            "claude-sonnet-5",
            "glm-5.2",
        ] {
            assert!(is_chat_model(id), "{id} 是对话模型");
        }
    }
}

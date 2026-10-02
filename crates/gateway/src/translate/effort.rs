//! 推理强度：把客户端请求里的推理强度折成 Chat Completions 上游的 `reasoning_effort`。
//!
//! Sophia 自己不设推理强度，以客户端为准：Claude Code 的 `output_config.effort` /
//! `thinking.budget_tokens`、Codex 的 `reasoning.effort` 各折成 `low` / `medium` / `high` 三档之一
//! （这三档是 Chat Completions 上游里最普遍认的），读不懂就不加、交给上游默认。
//! 上游不认这个字段时路由去掉它重发一次，判定见 [`rejects_reasoning_effort`]。

use serde_json::Value;

/// 出站 Chat Completions 请求体里的字段名。
pub const REASONING_EFFORT_FIELD: &str = "reasoning_effort";

/// `thinking.budget_tokens` 低于它算 [`Effort::Low`]。
const BUDGET_MEDIUM_FROM: u64 = 4096;
/// `thinking.budget_tokens` 低于它算 [`Effort::Medium`]，不低于算 [`Effort::High`]。
const BUDGET_HIGH_FROM: u64 = 16384;

/// 发给上游的三档推理强度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    /// Anthropic `output_config.effort`：`xhigh` / `max` 超出三档，按最近档取 `high`；
    /// 其它字符串与非字符串读不懂，不加。
    pub fn from_anthropic(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" | "xhigh" | "max" => Some(Self::High),
            _ => None,
        }
    }

    /// Anthropic `thinking: {type: "enabled", budget_tokens: N}` 的预算：
    /// N < 4096 → low，N < 16384 → medium，否则 high。
    pub fn from_budget_tokens(budget: u64) -> Self {
        if budget < BUDGET_MEDIUM_FROM {
            Self::Low
        } else if budget < BUDGET_HIGH_FROM {
            Self::Medium
        } else {
            Self::High
        }
    }

    /// OpenAI Responses `reasoning.effort`：`minimal` 并入 low，`xhigh` 并入 high；
    /// `none`（明确不想）与读不懂的都不加。
    pub fn from_responses(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "minimal" | "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" | "xhigh" => Some(Self::High),
            _ => None,
        }
    }
}

/// 错误体里表示「不支持这个参数」的说法（小写）。
const UNSUPPORTED_WORDS: &[&str] = &[
    "not support",
    "unsupported",
    "unrecognized",
    "unknown",
    "not permitted",
    "not allowed",
    "invalid",
    "不支持", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

/// 上游是不是因为 `reasoning_effort` 拒收了请求：状态 400，且错误体（小写后）点名了
/// `reasoning_effort`（也认 `reasoning effort`、`reasoning.effort`），或同时提到 `reasoning`
/// 与表示不支持的词。宁可认宽一点：误判的代价只是去掉推理强度多发一次。
pub fn rejects_reasoning_effort(status: u16, body: &[u8]) -> bool {
    if status != 400 {
        return false;
    }
    let text = String::from_utf8_lossy(body).to_lowercase();
    ["reasoning_effort", "reasoning effort", "reasoning.effort"]
        .iter()
        .any(|name| text.contains(name))
        || (text.contains("reasoning") && UNSUPPORTED_WORDS.iter().any(|w| text.contains(w)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anthropic_effort_table() {
        for (raw, want) in [
            (json!("low"), Some(Effort::Low)),
            (json!("medium"), Some(Effort::Medium)),
            (json!("high"), Some(Effort::High)),
            (json!("xhigh"), Some(Effort::High)),
            (json!("max"), Some(Effort::High)),
            (json!("minimal"), None),
            (json!("HIGH"), None),
            (json!(""), None),
            (json!(3), None),
            (json!(null), None),
            (json!({ "level": "high" }), None),
        ] {
            assert_eq!(Effort::from_anthropic(&raw), want, "{raw}");
        }
    }

    #[test]
    fn budget_tokens_table() {
        for (budget, want) in [
            (0, Effort::Low),
            (1024, Effort::Low),
            (4095, Effort::Low),
            (4096, Effort::Medium),
            (16383, Effort::Medium),
            (16384, Effort::High),
            (128_000, Effort::High),
        ] {
            assert_eq!(Effort::from_budget_tokens(budget), want, "{budget}");
        }
    }

    #[test]
    fn responses_effort_table() {
        for (raw, want) in [
            (json!("minimal"), Some(Effort::Low)),
            (json!("low"), Some(Effort::Low)),
            (json!("medium"), Some(Effort::Medium)),
            (json!("high"), Some(Effort::High)),
            (json!("xhigh"), Some(Effort::High)),
            (json!("none"), None),
            (json!("max"), None),
            (json!(""), None),
            (json!(2), None),
            (json!(null), None),
        ] {
            assert_eq!(Effort::from_responses(&raw), want, "{raw}");
        }
    }

    #[test]
    fn as_str_is_the_wire_value() {
        assert_eq!(Effort::Low.as_str(), "low");
        assert_eq!(Effort::Medium.as_str(), "medium");
        assert_eq!(Effort::High.as_str(), "high");
    }

    #[test]
    fn rejection_is_recognised() {
        for body in [
            r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#,
            r#"{"error":{"message":"Invalid value for Reasoning Effort"}}"#,
            r#"{"error":{"message":"reasoning.effort is not supported with this model"}}"#,
            r#"{"error":{"message":"Model does not support reasoning"}}"#,
            r#"{"error":{"message":"unsupported parameter: reasoning"}}"#,
            r#"{"error":{"message":"Unknown field `reasoning`"}}"#,
            r#"{"error":{"message":"reasoning is not permitted for this deployment"}}"#,
            r#"{"error":{"message":"reasoning not allowed"}}"#,
            r#"{"error":{"message":"invalid reasoning option"}}"#,
            r#"{"error":{"message":"该模型不支持 reasoning 参数"}}"#,
        ] {
            assert!(rejects_reasoning_effort(400, body.as_bytes()), "{body}");
        }
    }

    #[test]
    fn unrelated_or_non_400_errors_are_not_rejections() {
        for body in [
            r#"{"error":{"message":"response_format is not supported"}}"#,
            r#"{"error":{"message":"This model's maximum context length is 131072 tokens"}}"#,
            r#"{"error":{"message":"the reasoning took too long"}}"#,
            r#"{"error":{"message":"invalid api key"}}"#,
            "",
        ] {
            assert!(!rejects_reasoning_effort(400, body.as_bytes()), "{body}");
        }
        let named = br#"{"error":{"message":"reasoning_effort is not supported"}}"#;
        for status in [401, 404, 422, 429, 500] {
            assert!(!rejects_reasoning_effort(status, named), "{status}");
        }
    }
}

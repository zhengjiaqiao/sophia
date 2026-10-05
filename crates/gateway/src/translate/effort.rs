//! 推理强度：把客户端请求里的推理强度折成 Chat Completions 上游的 `reasoning_effort`。
//!
//! Sophia 自己不设推理强度，以客户端为准：Claude Code 的 `output_config.effort` /
//! `thinking.budget_tokens`、Codex 的 `reasoning.effort` 各折成 `low` / `medium` / `high` 三档之一
//! （这三档是 Chat Completions 上游里最普遍认的），读不懂就不加、交给上游默认。
//! 上游不认这个字段时路由去掉它重发一次，判定见 [`rejects_reasoning_effort`]；带回的思考内容
//! （`reasoning_content`）被点名拒收时同样去掉重发一次，见 [`rejects_reasoning_content`]、[`reasoning_retry`]。

use serde_json::Value;

/// 出站 Chat Completions 请求体里的字段名。
pub const REASONING_EFFORT_FIELD: &str = "reasoning_effort";
/// 出站 Chat Completions 的 assistant 消息里带回思考内容的字段名（reasoning-passback R1/R3）。
pub const REASONING_CONTENT_FIELD: &str = "reasoning_content";

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
        || vaguely_rejects_reasoning(&text)
}

/// 上游 400 后与推理有关的两种改形重发。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningRetry {
    /// 去掉 `reasoning_effort`（R18a）。
    DropEffort,
    /// 去掉全部 `reasoning_content`（reasoning-passback R4）。
    DropContent,
}

/// 错误体说的是「缺」这个字段（小写）：这时去掉它只会更糟，不算拒收。
const MISSING_WORDS: &[&str] = &[
    "missing", "required",
    "缺少", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

/// 明确「多了 / 不认这个字段」的说法（小写）。与 [`MISSING_WORDS`] 同现时以它为准。
/// pydantic 的 `extra_forbidden` 与 serde 的 `unknown field` 都在其中。
const REJECT_WORDS: &[&str] = &[
    "extra",
    "forbidden",
    "unknown",
    "unrecognized",
    "not permitted",
    "not allowed",
    "unsupported",
    "not support",
    "invalid",
    "不支持", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
];

/// 上游是不是因为 assistant 消息里的 `reasoning_content`（思考内容带回）拒收了请求：状态 400，且错误里
/// **说它的那一处**是拒收。按片段判（Codex 复审第三轮：合并整段文字时，别处的 invalid / unsupported
/// 会盖过「reasoning_content is required」，误删上游必需的思考历史）：
///
/// - 错误体拆成条目（[`error_entries`]：JSON 里每个带 `message` / `msg` / `detail` / `error` 文字的对象各一条；
///   回显的 `input` 是用户内容，不看），条目文字再按 `;` `；` `。` `. ` 与换行切成句子。
/// - 点名 `reasoning_content`（也认 `reasoning content`、`reasoning-content`、`reasoning.content`、
///   `reasoningContent`）的句子：有缺的说法（[`MISSING_WORDS`]）→ 说它必需；否则有拒收说法（[`REJECT_WORDS`]）→ 拒收。
/// - 字段路径（`loc` / `param` / `path` / `field`）指向它的条目：按该条的类型（`type` / `code`）与文字同样判。
/// - 任何一处说它必需就不算拒收（保守：去掉只会更糟）；至少一处拒收才算。只点名、两种说法都没有的不算。
///
/// 不像 [`rejects_reasoning_effort`] 那样宽判：DeepSeek、Kimi 在工具循环里要求带回思考内容。
pub fn rejects_reasoning_content(status: u16, body: &[u8]) -> bool {
    if status != 400 {
        return false;
    }
    let mut rejected = false;
    for entry in error_entries(body) {
        let mut verdicts: Vec<String> = entry
            .texts
            .iter()
            .flat_map(|text| fragments(text))
            .filter(|fragment| names_reasoning_content(fragment))
            .collect();
        if names_reasoning_content(&entry.path) {
            verdicts.push(format!(
                "{}\n{}",
                entry.kinds.join("\n"),
                entry.texts.join("\n")
            ));
        }
        for verdict in verdicts {
            if MISSING_WORDS.iter().any(|w| verdict.contains(w)) {
                return false;
            }
            rejected |= REJECT_WORDS.iter().any(|w| verdict.contains(w));
        }
    }
    rejected
}

/// 一段错误文字切成判定用的片段：先按行，再按 `;` `；` `。` `. ` 切句。
/// 一行只有字段路径（点名 `reasoning_content`、本身没有判定词）时与下一行并成一段——Pydantic 的文字报错
/// 把路径与原因分在相邻两行（`messages.0.reasoning_content\n  Extra inputs are not permitted [type=extra_forbidden, …]`，
/// Codex 复审第四轮）。
fn fragments(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut merged = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let path_only = names_reasoning_content(line)
            && !MISSING_WORDS.iter().any(|w| line.contains(w))
            && !REJECT_WORDS.iter().any(|w| line.contains(w));
        if path_only && index + 1 < lines.len() {
            merged.push(format!("{line} {}", lines[index + 1].trim()));
            index += 2;
        } else {
            merged.push(line.to_string());
            index += 1;
        }
    }
    merged
        .iter()
        .flat_map(|line| line.split([';', '；', '。'])) // i18n-exempt: 切分上游错误说明的中文标点，是判定用的分隔符，不是界面文案
        .flat_map(|part| part.split(". "))
        .map(str::to_string)
        .collect()
}

/// 去掉 Pydantic 文字报错里回显的 `input_value=…`（用户内容，不参与判定）：到 `, input_type=` 为止，
/// 没有就到这一行的 `]` 或行尾。`[type=…]` 类型标签留着（`extra_forbidden`、`missing` 本身就是判定词）。
fn strip_echoes(text: &str) -> String {
    const ECHO: &str = "input_value=";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(ECHO) {
        out.push_str(&rest[..start]);
        let after = &rest[start + ECHO.len()..];
        let line_end = after.find('\n').unwrap_or(after.len());
        let end = after[..line_end]
            .find(", input_type=")
            .or_else(|| after[..line_end].rfind(']'))
            .unwrap_or(line_end);
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// 错误体里的一条错误（全部小写）。
#[derive(Debug, Default)]
struct ErrorEntry {
    /// `message` / `msg` / `detail` / `error` 的文字
    texts: Vec<String>,
    /// `type` / `code`（去掉 OpenAI 式的 `invalid_request_error`：每个 400 都带，不说明是哪种错）
    kinds: Vec<String>,
    /// `loc` / `param` / `path` / `field`，数组以 `.` 相连
    path: String,
}

/// 把错误体拆成条目：JSON 时每个带文字的对象一条（嵌套的 `error`、`detail[]` 各自成条），跳过回显的 `input`；
/// 不是 JSON 时整段原文一条。
fn error_entries(body: &[u8]) -> Vec<ErrorEntry> {
    use serde_json::Value;
    fn walk(value: &Value, out: &mut Vec<ErrorEntry>) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            Value::Object(map) => {
                let mut entry = ErrorEntry::default();
                for (key, item) in map {
                    match (key.as_str(), item) {
                        ("input", _) => {}
                        ("message" | "msg" | "detail" | "error", Value::String(text)) => {
                            entry.texts.push(strip_echoes(&text.to_lowercase()))
                        }
                        ("type" | "code", Value::String(kind)) => {
                            let kind = kind.to_lowercase();
                            if kind != "invalid_request_error" {
                                entry.kinds.push(kind);
                            }
                        }
                        ("loc" | "param" | "path" | "field", Value::String(path)) => {
                            entry.path = path.to_lowercase()
                        }
                        ("loc" | "param" | "path" | "field", Value::Array(parts)) => {
                            entry.path = parts
                                .iter()
                                .map(|part| match part {
                                    Value::String(text) => text.to_lowercase(),
                                    other => other.to_string(),
                                })
                                .collect::<Vec<_>>()
                                .join(".");
                        }
                        (_, nested @ (Value::Array(_) | Value::Object(_))) => walk(nested, out),
                        _ => {}
                    }
                }
                if !entry.texts.is_empty() || !entry.path.is_empty() {
                    out.push(entry);
                }
            }
            _ => {}
        }
    }
    let mut entries = Vec::new();
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::String(text)) => entries.push(ErrorEntry {
            texts: vec![strip_echoes(&text.to_lowercase())],
            ..ErrorEntry::default()
        }),
        Ok(value) => walk(&value, &mut entries),
        Err(_) => entries.push(ErrorEntry {
            texts: vec![strip_echoes(&String::from_utf8_lossy(body).to_lowercase())],
            ..ErrorEntry::default()
        }),
    }
    entries
}

/// 错误体（已小写）点名了 `reasoning_content` 或它的明确变体：去掉 `_ - . 空格` 后含 `reasoningcontent`。
fn names_reasoning_content(text: &str) -> bool {
    let squashed: String = text
        .chars()
        .filter(|c| !matches!(c, '_' | '-' | '.' | ' '))
        .collect();
    squashed.contains("reasoningcontent")
}

/// 上游 400 后该去掉哪一个推理字段重发。`effort_pending` / `content_pending`：这次请求发了
/// `reasoning_effort` / `reasoning_content` 且还没因它重发过（每种至多一次）。
/// 错误点名了 `reasoning_content` 就去它（[`rejects_reasoning_content`] 只认点名）；否则按 R18a 的宽判
/// 去推理强度。思考内容从不因说不清的错误被去掉。
pub fn reasoning_retry(
    status: u16,
    body: &[u8],
    effort_pending: bool,
    content_pending: bool,
) -> Option<ReasoningRetry> {
    let effort = effort_pending && rejects_reasoning_effort(status, body);
    if content_pending && rejects_reasoning_content(status, body) {
        Some(ReasoningRetry::DropContent)
    } else if effort {
        Some(ReasoningRetry::DropEffort)
    } else {
        None
    }
}

/// 错误体（已小写）同时提到 `reasoning` 与表示不支持的词。
fn vaguely_rejects_reasoning(text: &str) -> bool {
    text.contains("reasoning") && UNSUPPORTED_WORDS.iter().any(|w| text.contains(w))
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

    /// reasoning-passback R4：错误体点名 `reasoning_content`，或 `reasoning` 与「不支持」一类词同现。
    #[test]
    fn reasoning_content_rejection_is_recognised() {
        for body in [
            r#"{"error":{"message":"unknown field reasoning_content"}}"#,
            r#"{"error":{"message":"Extra inputs are not permitted","loc":["body","messages",1,"reasoning_content"]}}"#,
            r#"{"error":{"message":"Unrecognized field: messages[1].reasoningContent"}}"#,
            r#"{"error":{"message":"reasoning content is not allowed in assistant messages"}}"#,
            "unknown field `reasoning_content`, expected one of `role`, `content`",
            // Codex 复审第二轮的复现：pydantic 的 extra_forbidden，回显的 input 里恰好有 required，不能因此不认
            r#"{"detail":[{"type":"extra_forbidden","loc":["body","messages",1,"reasoning_content"],"msg":"Extra inputs are not permitted","input":"Read the required settings first"}]}"#,
            r#"{"detail":[{"type":"extra_forbidden","loc":["body","messages",1,"reasoning_content"],"msg":"Extra inputs are not permitted","input":"missing 缺少"}]}"#,
            // 按片段判：点名它的那一句是拒收说法，别的句子里的 required 不影响
            r#"{"error":{"message":"reasoning_content is not supported; tool_call_id is required","type":"invalid_request_error"}}"#,
            r#"{"error":{"message":"Field is required for tools. Unknown field: reasoning_content"}}"#,
            r#"{"detail":"unknown field reasoning_content"}"#,
            // 字段路径指向它、条目类型是拒收类
            r#"{"error":{"message":"Unrecognized request argument","param":"messages[1].reasoning_content","type":"invalid_request_error"}}"#,
            // Codex 复审第四轮的复现：Pydantic 的文字报错，字段路径与原因在相邻两行
            r#"{"error":{"message":"1 validation error for Request\nmessages.0.reasoning_content\n  Extra inputs are not permitted [type=extra_forbidden, input_value='thought', input_type=str]","type":"invalid_request_error"}}"#,
            // 回显的 input_value 里有 required / missing，不参与判定
            r#"{"error":{"message":"1 validation error for Request\nmessages.0.reasoning_content\n  Extra inputs are not permitted [type=extra_forbidden, input_value='the required missing note', input_type=str]"}}"#,
            // 多条：别的字段缺（Field required）不影响点名 reasoning_content 的那一段
            "2 validation errors for Request\nmessages.0.reasoning_content\n  Extra inputs are not permitted [type=extra_forbidden, input_value='x', input_type=str]\nmessages.1.tool_call_id\n  Field required [type=missing, input_value={'role': 'tool'}, input_type=dict]",
        ] {
            assert!(rejects_reasoning_content(400, body.as_bytes()), "{body}");
        }
        // 只点名才算（Codex 复审 P2）：宽判只给 reasoning_effort 用，免得误删上游必需的思考历史；
        // 错误说的是「缺」思考内容时，去掉它只会更糟
        for body in [
            r#"{"error":{"message":"Unsupported parameter: reasoning"}}"#,
            r#"{"error":{"message":"response_format is not supported for reasoning models"}}"#,
            r#"{"error":{"message":"Missing reasoning_content"}}"#,
            r#"{"error":{"message":"Missing reasoning_content","type":"invalid_request_error"}}"#,
            r#"{"error":{"message":"reasoning_content is required for assistant messages with tool_calls","type":"invalid_request_error","code":"invalid_request_error"}}"#,
            "思考模式下 assistant 消息缺少 reasoning_content",
            // Codex 复审第三轮的复现：拒收说法在说别的（JSON schema），点名 reasoning_content 的那一句说的是必需
            r#"{"error":{"message":"Invalid request: JSON schema output is unsupported; reasoning_content is required for assistant tool calls","type":"invalid_request_error"}}"#,
            "不支持 JSON 输出。assistant 消息缺少 reasoning_content",
            // 只点名、没说拒收也没说缺：不认（保守，不删必需的思考历史）
            r#"{"error":{"message":"reasoning_content: bad length"}}"#,
            // 字段路径指向它，但条目说的是缺（pydantic 的 missing / OpenAI 式带 param 的 Missing）
            r#"{"detail":[{"type":"missing","loc":["body","messages",1,"reasoning_content"],"msg":"Field required","input":{}}]}"#,
            // Pydantic 文字报错的 missing：路径行与原因行相邻
            r#"{"error":{"message":"1 validation error for Request\nmessages.0.reasoning_content\n  Field required [type=missing, input_value={'role': 'assistant'}, input_type=dict]"}}"#,
            // 拒收类的词只在回显里：不算
            r#"{"error":{"message":"1 validation error for Request\nmessages.0.reasoning_content\n  Value error [type=value_error, input_value='extra unknown invalid', input_type=str]"}}"#,
            r#"{"error":{"message":"Missing required parameter","param":"messages[1].reasoning_content","type":"invalid_request_error"}}"#,
            // 只在回显的 input 里出现、错误本身没点名它
            r#"{"detail":[{"type":"extra_forbidden","loc":["body","foo"],"msg":"Extra inputs are not permitted","input":"reasoning_content"}]}"#,
            r#"{"error":{"message":"response_format is not supported"}}"#,
            r#"{"error":{"message":"the reasoning took too long"}}"#,
            "",
        ] {
            assert!(!rejects_reasoning_content(400, body.as_bytes()), "{body}");
        }
        let named = br#"{"error":{"message":"unknown field reasoning_content"}}"#;
        for status in [401, 422, 429, 500] {
            assert!(!rejects_reasoning_content(status, named), "{status}");
        }
    }

    /// 两种都还能重发时：点名哪个去哪个；说不清是哪个（只说 reasoning 不支持）只去推理强度，
    /// 思考内容只在被点名时去。已经重发过的那种不再选。
    #[test]
    fn reasoning_retry_picks_the_named_field() {
        let content = br#"{"error":{"message":"unknown field reasoning_content"}}"#;
        let effort =
            br#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#;
        let vague = br#"{"error":{"message":"reasoning is not supported"}}"#;
        let other = br#"{"error":{"message":"too many images"}}"#;
        use ReasoningRetry::{DropContent, DropEffort};
        for (body, effort_pending, content_pending, want) in [
            (&content[..], true, true, Some(DropContent)),
            (&effort[..], true, true, Some(DropEffort)),
            (&vague[..], true, true, Some(DropEffort)),
            (&vague[..], false, true, None),
            (&content[..], true, false, Some(DropEffort)),
            (&content[..], false, false, None),
            (&other[..], true, true, None),
        ] {
            assert_eq!(
                reasoning_retry(400, body, effort_pending, content_pending),
                want,
                "{} {effort_pending} {content_pending}",
                String::from_utf8_lossy(body)
            );
        }
        assert_eq!(reasoning_retry(429, content, true, true), None);
    }
}

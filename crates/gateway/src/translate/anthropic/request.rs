//! R16/R17：Anthropic Messages → Chat Completions。

use std::fmt;

use serde_json::{json, Map, Value};

use super::ir::{self, Item, Part, ToolChoice, BLOCK_SEPARATOR};
use super::names::ToolNameMap;
use crate::translate::REASONING_EFFORT_FIELD;

/// R20：第三方表达不了的块换成的占位文字。
pub const ATTACHMENT_PLACEHOLDER: &str = "[Sophia：这个第三方模型读不了这类附件，已省略]"; // i18n-exempt: 换进对话内容发给模型的占位文字（协议内容），不是界面文案
/// Claude Code 放在系统提示最前的归因块的前缀（P0 抓包确认）；这样的块整块丢弃。
pub const BILLING_BLOCK_PREFIX: &str = "x-anthropic-billing-header:";

/// 起标题等请求的 `output_config.format`（json_schema）怎么交给上游。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StructuredOutput {
    /// 发 `response_format: {type: json_schema}`（Responses：`text.format`），系统提示里也写明。
    #[default]
    ResponseFormat,
    /// 只在系统提示里写明。给不认识 `response_format`、会因此 400 的上游用（路由可在 400 后改用它重试）。
    PromptOnly,
}

/// 请求明说不要思考（`thinking: {type: "disabled"}`）时，怎么让默认会思考的上游别想。
/// 没带 `thinking` 不算（2026-09-30 产品负责人：Sophia 不替客户端决定推理——桌面应用 Chat 里的普通对话
/// 多半不带 `thinking`，替它关掉会让推理模型变笨，有的模型还根本不许关）。
/// 各家开关不统一，猜错了会 400，所以默认 [`Omit`](Self::Omit)，按网关配置或 [`detect`](Self::detect) 选。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingOff {
    /// 什么都不加（保守默认）。
    #[default]
    Omit,
    /// `thinking: {type: "disabled"}`（智谱 GLM、Moonshot Kimi 等官方接口的写法）。
    ThinkingDisabled,
    /// `reasoning: {enabled: false}`（OpenRouter；模型不允许关时 OpenRouter 忽略）。
    ReasoningDisabled,
    /// `chat_template_kwargs: {enable_thinking: false, thinking: false}`（vLLM / SGLang 自建）。
    ChatTemplateKwargs,
}

impl ThinkingOff {
    /// 只认有官方文档可查的：OpenRouter。其余一律 [`Omit`](Self::Omit)。
    pub fn detect(base_url: &str) -> Self {
        let host = url::Url::parse(base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
        match host.as_deref() {
            Some(host) if host == "openrouter.ai" || host.ends_with(".openrouter.ai") => {
                Self::ReasoningDisabled
            }
            _ => Self::Omit,
        }
    }

    pub(super) fn apply(self, body: &mut Map<String, Value>) {
        match self {
            Self::Omit => {}
            Self::ThinkingDisabled => {
                body.insert("thinking".into(), json!({ "type": "disabled" }));
            }
            Self::ReasoningDisabled => {
                body.insert("reasoning".into(), json!({ "enabled": false }));
            }
            Self::ChatTemplateKwargs => {
                body.insert(
                    "chat_template_kwargs".into(),
                    json!({ "enable_thinking": false, "thinking": false }),
                );
            }
        }
    }
}

/// 上游是不是因为「关掉推理」拒收了请求：状态 400，错误体（小写后）提到推理 / 思考，且说它必须开、不能关。
/// 2026-09-30 真机：OpenRouter 的 `z-ai/glm-5.3` 收到 `reasoning: {enabled: false}` 回 400
/// 「Reasoning is mandatory for this endpoint and cannot be disabled.」——文档说会忽略，实际不会。
/// 路由据此把 [`ThinkingOff`] 改成 `Omit` 重发一次；误判的代价只是多发一次、这次照常思考。
pub fn rejects_thinking_off(status: u16, body: &[u8]) -> bool {
    if status != 400 {
        return false;
    }
    let text = String::from_utf8_lossy(body).to_lowercase();
    let about = ["reasoning", "thinking", "推理", "思考"] // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
        .iter()
        .any(|w| text.contains(w));
    let cannot_off = [
        "mandatory",
        "cannot be disabled",
        "can't be disabled",
        "can not be disabled",
        "must be enabled",
        "is required",
        "不能关闭", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
        "无法关闭", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
        "必须开启", // i18n-exempt: 匹配上游错误说明里的中文说法，是判定用的关键词，不是界面文案
    ]
    .iter()
    .any(|w| text.contains(w));
    about && cannot_off
}

/// 按上游能力调整转换的开关（来自网关配置，P3 接线）。
#[derive(Debug, Clone, Default)]
pub struct UpstreamOptions {
    pub structured_output: StructuredOutput,
    pub thinking_off: ThinkingOff,
    /// 不发 `reasoning_effort`，即使请求要了推理强度。默认发；上游因它 400 后路由置真重发一次。
    pub omit_reasoning_effort: bool,
}

/// 转换后要发给上游的请求。
#[derive(Debug, Clone)]
pub struct UpstreamRequest {
    /// 上游请求体（总是流式）。
    pub body: Vec<u8>,
    /// 客户端要不要流式；为假时路由收齐后回一条 Message（R25）。
    pub stream: bool,
    /// 被改过名的工具：回程用它还原原名。
    pub tools: ToolNameMap,
    /// R14 估算的输入 token，给 `message_start` 与上游没回用量时用。
    pub input_estimate: u64,
    /// 这次请求体里带没带 `reasoning_effort`：路由据此决定上游拒收时要不要去掉它重发。
    /// Responses 出口（[`to_responses`](super::to_responses)）不发推理强度，总是假。
    pub reasoning_effort_sent: bool,
    /// 这次请求体里带没带「关推理」的字段（[`ThinkingOff`] 不是 `Omit` 且请求明说不要思考）：
    /// 路由据此决定上游说推理不能关时要不要去掉它重发。Responses 出口不发，总是假。
    pub thinking_off_sent: bool,
}

/// 请求读不懂。路由回 400 `invalid_request_error`。
#[derive(Debug)]
pub enum RequestError {
    Parse(serde_json::Error),
    NotObject,
    MissingModel,
    MissingMessages,
    /// 去掉不能发的内容后一条消息都不剩。
    NoMessages,
    Encode(serde_json::Error),
}

impl fmt::Display for RequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(err) => write!(f, "request body is not valid JSON: {err}"),
            Self::NotObject => f.write_str("request body must be a JSON object"),
            Self::MissingModel => f.write_str("model: field required"),
            Self::MissingMessages => f.write_str("messages: field required"),
            Self::NoMessages => {
                f.write_str("messages: nothing left to send after removing unsupported content")
            }
            Self::Encode(err) => write!(f, "encode upstream request: {err}"),
        }
    }
}

impl std::error::Error for RequestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Parse(err) | Self::Encode(err) => Some(err),
            _ => None,
        }
    }
}

/// 只取请求里的模型名（路由先按它查清单，再决定转换成哪种协议）。
pub fn request_model(body: &[u8]) -> Result<String, RequestError> {
    ir::model_of(&ir::parse_root(body)?)
}

/// Anthropic Messages 请求体 → Chat Completions 请求体（R16/R17/R18/R20）。
pub fn to_chat(
    body: &[u8],
    upstream_model: &str,
    options: &UpstreamOptions,
) -> Result<UpstreamRequest, RequestError> {
    let parsed = ir::parse(body)?;

    let mut chat = Map::new();
    chat.insert("model".into(), json!(upstream_model));
    chat.insert("stream".into(), json!(true));
    chat.insert("stream_options".into(), json!({ "include_usage": true }));

    if !parsed.tools.is_empty() {
        let tools: Vec<Value> = parsed
            .tools
            .iter()
            .map(|tool| {
                let mut function = Map::new();
                function.insert("name".into(), json!(tool.name));
                if let Some(description) = &tool.description {
                    function.insert("description".into(), json!(description));
                }
                function.insert("parameters".into(), tool.parameters.clone());
                json!({ "type": "function", "function": function })
            })
            .collect();
        chat.insert("tools".into(), Value::Array(tools));
        if let Some(choice) = &parsed.tool_choice {
            let choice = match choice {
                ToolChoice::Auto => json!("auto"),
                ToolChoice::Required => json!("required"),
                ToolChoice::None => json!("none"),
                ToolChoice::Function(name) => {
                    json!({ "type": "function", "function": { "name": name } })
                }
            };
            chat.insert("tool_choice".into(), choice);
        }
        if parsed.parallel_off {
            chat.insert("parallel_tool_calls".into(), json!(false));
        }
    }

    let mut messages = Vec::new();
    if !parsed.system.is_empty() {
        messages.push(json!({ "role": "system", "content": parsed.system }));
    }
    for item in &parsed.items {
        messages.push(match item {
            Item::User(parts) => json!({ "role": "user", "content": user_content(parts) }),
            Item::Assistant { text, calls } => {
                let mut message = Map::new();
                message.insert("role".into(), json!("assistant"));
                message.insert("content".into(), json!(text));
                if !calls.is_empty() {
                    let calls: Vec<Value> = calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": { "name": call.name, "arguments": call.arguments },
                            })
                        })
                        .collect();
                    message.insert("tool_calls".into(), Value::Array(calls));
                }
                Value::Object(message)
            }
            Item::ToolResult { call_id, output } => {
                json!({ "role": "tool", "tool_call_id": call_id, "content": output })
            }
        });
    }
    chat.insert("messages".into(), Value::Array(messages));

    if let Some(max_tokens) = parsed.max_tokens {
        chat.insert("max_tokens".into(), json!(max_tokens));
    }
    if let Some(temperature) = parsed.temperature {
        chat.insert("temperature".into(), temperature);
    }
    if let Some(top_p) = parsed.top_p {
        chat.insert("top_p".into(), top_p);
    }
    if !parsed.stop.is_empty() {
        chat.insert("stop".into(), json!(parsed.stop));
    }
    if let (Some(schema), StructuredOutput::ResponseFormat) =
        (&parsed.json_schema, options.structured_output)
    {
        chat.insert(
            "response_format".into(),
            json!({
                "type": "json_schema",
                "json_schema": { "name": "output", "schema": schema, "strict": true },
            }),
        );
    }
    // 推理强度与「明说不要思考时显式关思考」互斥，两者都放在最后（位置固定，同样输入逐字节相同）：
    // - 明说不要（`thinking: {type: "disabled"}`）：按 ThinkingOff 关，不加 `reasoning_effort`；
    // - 没带 `thinking`：什么都不加（即使带了 `output_config.effort`），让上游按模型自己的默认；
    // - 要了思考：不调 ThinkingOff；客户端给了强度（`output_config.effort` 优先，其次 `budget_tokens`）
    //   就加 `reasoning_effort`，`adaptive` 且没带 effort 什么都不加，让上游按默认想。
    let mut reasoning_effort_sent = false;
    let mut thinking_off_sent = false;
    if parsed.thinking_disabled {
        options.thinking_off.apply(&mut chat);
        thinking_off_sent = options.thinking_off != ThinkingOff::Omit;
    } else if !parsed.thinking_requested {
        // 没带 thinking：不替客户端决定
    } else if let Some(effort) = parsed.effort.filter(|_| !options.omit_reasoning_effort) {
        chat.insert(REASONING_EFFORT_FIELD.into(), json!(effort.as_str()));
        reasoning_effort_sent = true;
    }

    Ok(UpstreamRequest {
        body: serde_json::to_vec(&chat).map_err(RequestError::Encode)?,
        stream: parsed.stream,
        tools: parsed.names,
        input_estimate: parsed.estimate,
        reasoning_effort_sent,
        thinking_off_sent,
    })
}

/// 纯文字合成一个字符串（兼容性最好，与 Codex 路径一致）；有图片才用分段数组。
fn user_content(parts: &[Part]) -> Value {
    if parts.iter().all(|part| matches!(part, Part::Text(_))) {
        let texts: Vec<&str> = parts
            .iter()
            .filter_map(|part| match part {
                Part::Text(text) => Some(text.as_str()),
                Part::Image(_) => None,
            })
            .collect();
        return json!(texts.join(BLOCK_SEPARATOR));
    }
    Value::Array(
        parts
            .iter()
            .map(|part| match part {
                Part::Text(text) => json!({ "type": "text", "text": text }),
                Part::Image(url) => json!({ "type": "image_url", "image_url": { "url": url } }),
            })
            .collect(),
    )
}

//! R19：Anthropic Messages → OpenAI Responses（服务商 `protocol = responses`）。
//!
//! **实验性**：P0 没有可取样的 Responses 网关，本文件只按 spec 与 OpenAI 公开文档实现，
//! 没对真实上游验证过。语义与 [`to_chat`](super::to_chat) 相同（同一个中间形态），只是排版不同；
//! 不发 `reasoning`，`ThinkingOff` 对它不起作用。

use serde_json::{json, Map, Value};

use super::ir::{self, Item, Part, ToolChoice};
use super::request::{RequestError, StructuredOutput, UpstreamOptions, UpstreamRequest};

/// Responses 的 `max_output_tokens` 下限。
const MIN_OUTPUT_TOKENS: u64 = 16;

pub fn to_responses(
    body: &[u8],
    upstream_model: &str,
    options: &UpstreamOptions,
) -> Result<UpstreamRequest, RequestError> {
    let parsed = ir::parse(body)?;

    let mut out = Map::new();
    out.insert("model".into(), json!(upstream_model));
    out.insert("stream".into(), json!(true));
    out.insert("store".into(), json!(false));
    if !parsed.system.is_empty() {
        out.insert("instructions".into(), json!(parsed.system));
    }
    if !parsed.tools.is_empty() {
        let tools: Vec<Value> = parsed
            .tools
            .iter()
            .map(|tool| {
                let mut function = Map::new();
                function.insert("type".into(), json!("function"));
                function.insert("name".into(), json!(tool.name));
                if let Some(description) = &tool.description {
                    function.insert("description".into(), json!(description));
                }
                function.insert("parameters".into(), tool.parameters.clone());
                Value::Object(function)
            })
            .collect();
        out.insert("tools".into(), Value::Array(tools));
        if let Some(choice) = &parsed.tool_choice {
            let choice = match choice {
                ToolChoice::Auto => json!("auto"),
                ToolChoice::Required => json!("required"),
                ToolChoice::None => json!("none"),
                ToolChoice::Function(name) => json!({ "type": "function", "name": name }),
            };
            out.insert("tool_choice".into(), choice);
        }
        if parsed.parallel_off {
            out.insert("parallel_tool_calls".into(), json!(false));
        }
    }

    let mut input = Vec::new();
    for item in &parsed.items {
        match item {
            Item::User(parts) => {
                let content: Vec<Value> = parts
                    .iter()
                    .map(|part| match part {
                        Part::Text(text) => json!({ "type": "input_text", "text": text }),
                        Part::Image(url) => json!({ "type": "input_image", "image_url": url }),
                    })
                    .collect();
                input.push(json!({ "type": "message", "role": "user", "content": content }));
            }
            Item::Assistant { text, calls, .. } => {
                if !text.is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                for call in calls {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    }));
                }
            }
            Item::ToolResult { call_id, output } => {
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }));
            }
        }
    }
    out.insert("input".into(), Value::Array(input));

    if let Some(max_tokens) = parsed.max_tokens {
        // Responses 上游要求 ≥ 16；桌面应用的可用性探测发 max_tokens: 1
        out.insert(
            "max_output_tokens".into(),
            json!(max_tokens.max(MIN_OUTPUT_TOKENS)),
        );
    }
    if let Some(temperature) = parsed.temperature {
        out.insert("temperature".into(), temperature);
    }
    if let Some(top_p) = parsed.top_p {
        out.insert("top_p".into(), top_p);
    }
    // Responses 没有 stop 参数：stop_sequences 只能丢
    if let (Some(schema), StructuredOutput::ResponseFormat) =
        (&parsed.json_schema, options.structured_output)
    {
        out.insert(
            "text".into(),
            json!({
                "format": { "type": "json_schema", "name": "output", "schema": schema, "strict": true },
            }),
        );
    }

    Ok(UpstreamRequest {
        body: serde_json::to_vec(&out).map_err(RequestError::Encode)?,
        stream: parsed.stream,
        tools: parsed.names,
        // Responses 出口不带回思考内容，估算也不计
        input_estimate: parsed.estimate_without_thinking,
        // 本次只给 Chat 出口转推理强度
        reasoning_effort_sent: false,
        thinking_off_sent: false,
        // Responses 出口不带回思考内容（R20 不发 reasoning）
        reasoning_content_sent: false,
    })
}

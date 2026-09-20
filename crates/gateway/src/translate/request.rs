//! 请求方向：Responses 请求体 → Chat Completions 请求体，以及发往官方上游前的清理。

use std::collections::HashMap;
use std::fmt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Map, Number, Value};

/// 标记本工具产生的推理条目。官方上游要求推理条目带它自己的加密内容，
/// 所以这些条目在发往官方之前必须剔除。
pub const REASONING_ID_PREFIX: &str = "rs_sg_";
/// agents-manager（Go 版）用的前缀；在它下面开始的会话要能接着用。
const LEGACY_REASONING_ID_PREFIX: &str = "rs_am_";

const COMPACTION_PAYLOAD_TYPE: &str = "symsync_compaction";
const LEGACY_COMPACTION_PAYLOAD_TYPE: &str = "agents_manager_compaction";
const NAMESPACE_SEPARATOR: &str = "__";
const MAX_FUNCTION_NAME_LENGTH: usize = 64;

const COMPACTION_INSTRUCTION: &str = "Summarize the conversation so far so that another assistant can continue the work without access to the earlier messages. \
Include: the user's goals and constraints, decisions made, files and commands involved, the current state of the work, and the immediate next steps. \
Be specific and complete. Reply with the summary only.";
const COMPACTION_PREAMBLE: &str =
    "Summary of the earlier conversation (older messages were compacted):\n\n";
const INTERRUPTED_TOOL_OUTPUT: &str = "[no output: the tool call was interrupted]";

/// 把摊平后的函数名映射回 Codex 的（命名空间，成员名）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolNames(HashMap<String, (String, String)>);

impl ToolNames {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一个命名空间工具：`flat` 是发给上游的摊平名。
    pub fn insert(&mut self, flat: &str, namespace: &str, name: &str) {
        self.0
            .insert(flat.to_string(), (namespace.to_string(), name.to_string()));
    }

    /// 返回命名空间和成员名；不是命名空间工具时命名空间为 `None`，名字原样返回。
    pub fn resolve<'a>(&'a self, flat: &'a str) -> (Option<&'a str>, &'a str) {
        match self.0.get(flat) {
            Some((namespace, name)) => (Some(namespace), name),
            None => (None, flat),
        }
    }
}

fn flatten(namespace: &str, name: &str) -> String {
    if namespace.is_empty() {
        name.to_string()
    } else {
        format!("{namespace}{NAMESPACE_SEPARATOR}{name}")
    }
}

/// 转换后的上游请求。
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub chat_body: Vec<u8>,
    /// 客户端要不要流式；压缩请求对上游总是非流式。
    pub stream: bool,
    pub tools: ToolNames,
    /// 为 true 表示这是 Codex 的远程压缩请求：上游被要求写摘要，回复要包成压缩条目。
    pub compaction: bool,
}

/// 请求无法转换的原因。文字会回给 Codex 显示，与 agents-manager 保持一致用英文。
#[derive(Debug)]
pub enum TranslateError {
    /// 请求体不是合法的 Responses 请求。
    Parse(serde_json::Error),
    /// `input` 既不是字符串也不是数组。
    InvalidInput,
    /// 转换后一条消息都没有。
    NoMessages,
    /// 产物序列化失败。
    Encode(serde_json::Error),
}

impl fmt::Display for TranslateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(err) => write!(f, "parse Responses request: {err}"),
            Self::InvalidInput => f.write_str("input must be a string or an array"),
            Self::NoMessages => f.write_str("the request has no messages"),
            Self::Encode(err) => write!(f, "encode chat request: {err}"),
        }
    }
}

impl std::error::Error for TranslateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Parse(err) | Self::Encode(err) => Some(err),
            Self::InvalidInput | Self::NoMessages => None,
        }
    }
}

/// JSON 的 null 当作缺省值（与 Go 的 `json.Unmarshal` 一致），类型不符仍然报错。
pub(super) fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct ResponsesRequest {
    #[serde(default, deserialize_with = "nullable")]
    instructions: String,
    #[serde(default)]
    input: Option<Value>,
    #[serde(default, deserialize_with = "nullable")]
    tools: Vec<Value>,
    #[serde(default)]
    tool_choice: Option<Value>,
    #[serde(default)]
    parallel_tool_calls: Option<bool>,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    max_output_tokens: Option<i64>,
    // 用 Number 而不是 f64：`1` 不会被改写成 `1.0`。
    #[serde(default)]
    temperature: Option<Number>,
    #[serde(default)]
    top_p: Option<Number>,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: Value,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<ChatToolCall>,
    #[serde(skip_serializing_if = "String::is_empty")]
    tool_call_id: String,
}

impl ChatMessage {
    fn text(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: Value::String(content.into()),
            tool_calls: Vec::new(),
            tool_call_id: String::new(),
        }
    }

    fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: call_id.into(),
            ..Self::text("tool", content)
        }
    }
}

#[derive(Serialize)]
struct ChatToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: ChatFunctionCall,
}

#[derive(Serialize)]
struct ChatFunctionCall {
    name: String,
    arguments: String,
}

#[derive(Deserialize)]
struct ItemHead {
    #[serde(rename = "type", default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    role: String,
}

/// 把 Responses 请求体转成 Chat Completions 请求体。
pub fn to_chat(body: &[u8], upstream_model: &str) -> Result<ChatRequest, TranslateError> {
    let request: ResponsesRequest = serde_json::from_slice(body).map_err(TranslateError::Parse)?;
    let mut tool_names = ToolNames::new();
    let mut compaction = false;

    let mut messages = Vec::new();
    if !request.instructions.trim().is_empty() {
        messages.push(ChatMessage::text("system", request.instructions.as_str()));
    }
    for item in input_items(request.input)? {
        let Ok(head) = ItemHead::deserialize(&item) else {
            continue;
        };
        match head.kind.as_str() {
            "message" => messages.extend(convert_message(&item)),
            "" if !head.role.is_empty() => messages.extend(convert_message(&item)),
            "function_call" => append_tool_call(&mut messages, &item, false),
            "custom_tool_call" => append_tool_call(&mut messages, &item, true),
            "function_call_output" | "custom_tool_call_output" => {
                messages.push(convert_tool_output(&item));
            }
            "compaction" => {
                // 只有本工具（和 agents-manager）自己的压缩条目能展开；官方的是加密的，解不开就丢弃。
                let summary = item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .and_then(compaction_summary);
                if let Some(summary) = summary {
                    messages.push(ChatMessage::text(
                        "user",
                        format!("{COMPACTION_PREAMBLE}{summary}"),
                    ));
                }
            }
            "compaction_trigger" => compaction = true,
            // reasoning、web_search_call 等：网关不认识，丢弃。
            _ => {}
        }
    }
    let mut messages = repair_tool_history(messages);

    let mut chat = Map::new();
    chat.insert("model".into(), json!(upstream_model));
    if compaction {
        messages.push(ChatMessage::text("user", COMPACTION_INSTRUCTION));
        chat.insert("stream".into(), json!(false));
    } else {
        chat.insert("stream".into(), json!(true));
        chat.insert("stream_options".into(), json!({ "include_usage": true }));
        let tools = convert_tools(&request.tools, &mut tool_names);
        if !tools.is_empty() {
            chat.insert("tools".into(), Value::Array(tools));
            if let Some(choice) = convert_tool_choice(request.tool_choice.as_ref()) {
                chat.insert("tool_choice".into(), choice);
            }
            if let Some(parallel) = request.parallel_tool_calls {
                chat.insert("parallel_tool_calls".into(), json!(parallel));
            }
        }
    }
    if messages.is_empty() {
        return Err(TranslateError::NoMessages);
    }
    chat.insert(
        "messages".into(),
        serde_json::to_value(&messages).map_err(TranslateError::Encode)?,
    );
    if let Some(max_tokens) = request.max_output_tokens.filter(|n| *n > 0) {
        chat.insert("max_tokens".into(), json!(max_tokens));
    }
    if let Some(temperature) = request.temperature {
        chat.insert("temperature".into(), Value::Number(temperature));
    }
    if let Some(top_p) = request.top_p {
        chat.insert("top_p".into(), Value::Number(top_p));
    }
    Ok(ChatRequest {
        chat_body: serde_json::to_vec(&chat).map_err(TranslateError::Encode)?,
        stream: request.stream.unwrap_or(true),
        tools: tool_names,
        compaction,
    })
}

fn input_items(input: Option<Value>) -> Result<Vec<Value>, TranslateError> {
    match input {
        None => Ok(Vec::new()),
        Some(Value::String(text)) => Ok(vec![
            json!({ "type": "message", "role": "user", "content": text }),
        ]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(TranslateError::InvalidInput),
    }
}

#[derive(Deserialize)]
struct MessageItem {
    #[serde(default, deserialize_with = "nullable")]
    role: String,
    #[serde(default)]
    content: Option<Value>,
}

#[derive(Deserialize)]
struct ContentPart {
    #[serde(rename = "type", default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    text: String,
    #[serde(default, deserialize_with = "nullable")]
    refusal: String,
    #[serde(default)]
    image_url: Option<Value>,
    #[serde(default, deserialize_with = "nullable")]
    detail: String,
}

/// 内容为空或读不懂的消息返回 `None`（丢弃）。
fn convert_message(item: &Value) -> Option<ChatMessage> {
    let message = MessageItem::deserialize(item).ok()?;
    let role = match message.role.as_str() {
        // Chat Completions 的网关普遍不认识 developer
        "developer" => "system",
        role @ ("system" | "user" | "assistant") => role,
        _ => "user",
    };
    let parts = match message.content? {
        Value::String(text) => {
            return (!text.is_empty()).then(|| ChatMessage::text(role, text));
        }
        content => Vec::<ContentPart>::deserialize(content).ok()?,
    };
    let mut texts = Vec::new();
    let mut rich = Vec::new();
    let mut has_image = false;
    for part in parts {
        match part.kind.as_str() {
            "input_text" | "output_text" | "text" | "summary_text" => {
                rich.push(json!({ "type": "text", "text": part.text }));
                texts.push(part.text);
            }
            "refusal" => {
                rich.push(json!({ "type": "text", "text": part.refusal }));
                texts.push(part.refusal);
            }
            "input_image" => {
                let Some(url) = part
                    .image_url
                    .as_ref()
                    .and_then(Value::as_str)
                    .filter(|url| !url.is_empty())
                else {
                    continue;
                };
                let mut image = Map::new();
                image.insert("url".into(), json!(url));
                if !part.detail.is_empty() && part.detail != "original" {
                    image.insert("detail".into(), json!(part.detail));
                }
                rich.push(json!({ "type": "image_url", "image_url": image }));
                has_image = true;
            }
            _ => {}
        }
    }
    if has_image && role == "user" {
        return Some(ChatMessage {
            content: Value::Array(rich),
            ..ChatMessage::text(role, "")
        });
    }
    // 纯文字合并成一个字符串：兼容性最好。
    let joined = texts.join("\n");
    (!joined.is_empty()).then(|| ChatMessage::text(role, joined))
}

#[derive(Deserialize)]
struct ToolCallItem {
    #[serde(default, deserialize_with = "nullable")]
    call_id: String,
    #[serde(default, deserialize_with = "nullable")]
    id: String,
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    #[serde(default, deserialize_with = "nullable")]
    namespace: String,
    #[serde(default, deserialize_with = "nullable")]
    arguments: String,
    #[serde(default, deserialize_with = "nullable")]
    input: String,
}

fn append_tool_call(messages: &mut Vec<ChatMessage>, item: &Value, custom: bool) {
    let Ok(item) = ToolCallItem::deserialize(item) else {
        return;
    };
    if item.name.is_empty() {
        return;
    }
    let call_id = if item.call_id.is_empty() {
        item.id
    } else {
        item.call_id
    };
    let mut arguments = if custom {
        json!({ "input": item.input }).to_string()
    } else {
        item.arguments
    };
    if arguments.trim().is_empty() {
        arguments = "{}".to_string();
    }
    let call = ChatToolCall {
        id: call_id,
        kind: "function",
        function: ChatFunctionCall {
            name: flatten(&item.namespace, &item.name),
            arguments,
        },
    };
    // 并行调用和“先说话再调用”都归到同一条 assistant 消息里。
    match messages.last_mut() {
        Some(last) if last.role == "assistant" => last.tool_calls.push(call),
        _ => messages.push(ChatMessage {
            tool_calls: vec![call],
            ..ChatMessage::text("assistant", "")
        }),
    }
}

fn convert_tool_output(item: &Value) -> ChatMessage {
    let call_id = item.get("call_id").and_then(Value::as_str).unwrap_or("");
    ChatMessage::tool(call_id, output_text(item.get("output")))
}

#[derive(Deserialize)]
struct OutputPart {
    #[serde(rename = "type", default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    text: String,
}

fn output_text(output: Option<&Value>) -> String {
    let Some(output) = output else {
        return String::new();
    };
    match output {
        Value::Null => return String::new(),
        Value::String(text) => return text.clone(),
        _ => {}
    }
    if let Ok(parts) = Vec::<OutputPart>::deserialize(output) {
        let mut text = String::new();
        for part in parts {
            if !part.text.is_empty() {
                text.push_str(&part.text);
            } else if part.kind == "input_image" {
                text.push_str("[image omitted]");
            }
        }
        return text;
    }
    match output.get("content").and_then(Value::as_str) {
        Some(content) if !content.is_empty() => content.to_string(),
        _ => output.to_string(),
    }
}

/// 保证消息序列满足 Chat Completions 的约束：
/// tool 消息必须紧跟在声明了它的 assistant 消息之后，每个调用都要有回应。
fn repair_tool_history(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    // 待回应的调用，按声明顺序；bool 表示是否仍在等输出。
    fn flush(pending: &mut Vec<(String, bool)>, repaired: &mut Vec<ChatMessage>) {
        for (id, waiting) in pending.drain(..) {
            if waiting {
                repaired.push(ChatMessage::tool(id, INTERRUPTED_TOOL_OUTPUT));
            }
        }
    }

    let mut repaired = Vec::with_capacity(messages.len());
    let mut pending: Vec<(String, bool)> = Vec::new();
    for message in messages {
        if message.role == "tool" {
            let slot = pending
                .iter_mut()
                .find(|(id, waiting)| *waiting && *id == message.tool_call_id);
            if let Some((_, waiting)) = slot {
                *waiting = false;
                repaired.push(message);
                continue;
            }
            // 找不到对应调用的输出：改成普通的用户消息，内容不丢。
            flush(&mut pending, &mut repaired);
            let content = message.content.as_str().unwrap_or_default();
            repaired.push(ChatMessage::text(
                "user",
                format!("Tool output ({}):\n{content}", message.tool_call_id),
            ));
        } else {
            flush(&mut pending, &mut repaired);
            pending.extend(
                message
                    .tool_calls
                    .iter()
                    .map(|call| (call.id.clone(), true)),
            );
            repaired.push(message);
        }
    }
    flush(&mut pending, &mut repaired);
    repaired
}

#[derive(Deserialize)]
struct ToolHead {
    #[serde(rename = "type", default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    #[serde(default, deserialize_with = "nullable")]
    tools: Vec<Value>,
}

#[derive(Deserialize)]
struct FunctionTool {
    #[serde(rename = "type", default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    #[serde(default, deserialize_with = "nullable")]
    description: String,
    #[serde(default)]
    parameters: Option<Value>,
}

fn convert_tools(raw: &[Value], names: &mut ToolNames) -> Vec<Value> {
    let mut tools = Vec::new();
    let mut add = |namespace: &str, data: &Value| {
        let Ok(tool) = FunctionTool::deserialize(data) else {
            return;
        };
        if tool.kind != "function" || tool.name.is_empty() {
            return;
        }
        let flat = flatten(namespace, &tool.name);
        if flat.len() > MAX_FUNCTION_NAME_LENGTH || !valid_function_name(&flat) {
            return;
        }
        let mut function = Map::new();
        function.insert("name".into(), json!(flat));
        if !tool.description.is_empty() {
            function.insert("description".into(), json!(tool.description));
        }
        let parameters = tool
            .parameters
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        function.insert("parameters".into(), parameters);
        if !namespace.is_empty() {
            names.insert(&flat, namespace, &tool.name);
        }
        tools.push(json!({ "type": "function", "function": function }));
    };
    for data in raw {
        let Ok(head) = ToolHead::deserialize(data) else {
            continue;
        };
        match head.kind.as_str() {
            "function" => add("", data),
            "namespace" => {
                for member in &head.tools {
                    add(&head.name, member);
                }
            }
            // web_search、custom、tool_search 等 Responses 专有工具：网关不认识，丢弃。
            _ => {}
        }
    }
    tools
}

fn valid_function_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn convert_tool_choice(raw: Option<&Value>) -> Option<Value> {
    #[derive(Deserialize)]
    struct Choice {
        #[serde(rename = "type", default, deserialize_with = "nullable")]
        kind: String,
        #[serde(default, deserialize_with = "nullable")]
        name: String,
        #[serde(default, deserialize_with = "nullable")]
        namespace: String,
    }
    match raw? {
        Value::String(text) => {
            matches!(text.as_str(), "auto" | "none" | "required").then(|| json!(text))
        }
        other => {
            let choice = Choice::deserialize(other).ok()?;
            (choice.kind == "function" && !choice.name.is_empty()).then(|| {
                json!({
                    "type": "function",
                    "function": { "name": flatten(&choice.namespace, &choice.name) },
                })
            })
        }
    }
}

/// 把摘要包成 Codex 会原样带回来的压缩条目。内容只是编码，不是加密。
pub fn compaction_item(summary: &str) -> Value {
    let payload = json!({ "type": COMPACTION_PAYLOAD_TYPE, "version": 1, "summary": summary });
    json!({
        "type": "compaction",
        "encrypted_content": BASE64.encode(payload.to_string()),
    })
}

/// [`compaction_item`] 的逆运算；不是本工具（或 agents-manager）产生的内容返回 `None`。
pub(super) fn compaction_summary(encoded: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Payload {
        #[serde(rename = "type", default, deserialize_with = "nullable")]
        kind: String,
        #[serde(default, deserialize_with = "nullable")]
        summary: String,
    }
    let data = BASE64.decode(encoded.trim()).ok()?;
    let payload: Payload = serde_json::from_slice(&data).ok()?;
    matches!(
        payload.kind.as_str(),
        COMPACTION_PAYLOAD_TYPE | LEGACY_COMPACTION_PAYLOAD_TYPE
    )
    .then_some(payload.summary)
}

/// 顶层请求对象：保留键的原始顺序，值保持原始字节，只替换需要改的那一个。
struct RawDocument(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for RawDocument {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DocumentVisitor;

        impl<'de> Visitor<'de> for DocumentVisitor {
            type Value = RawDocument;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawDocument, A::Error> {
                let mut entries: Vec<(String, Box<RawValue>)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    // 重复的键以最后一个为准（与 Go 一致）。
                    match entries.iter_mut().find(|(existing, _)| *existing == key) {
                        Some(entry) => entry.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                Ok(RawDocument(entries))
            }
        }

        deserializer.deserialize_map(DocumentVisitor)
    }
}

impl Serialize for RawDocument {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(key, value)| (key, value)))
    }
}

#[derive(Deserialize)]
struct NativeItemHead {
    #[serde(rename = "type", default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    id: String,
    #[serde(default, deserialize_with = "nullable")]
    encrypted_content: String,
}

/// 清理发往官方上游的请求：剔除本工具产生的推理条目，把本工具的压缩条目换成摘要消息。
/// 返回 `None` 表示不需要改动，调用方应转发原始字节，保证官方路径逐字节透传。
pub fn normalize_for_native(body: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(body).ok()?;
    if !text.contains(REASONING_ID_PREFIX)
        && !text.contains(LEGACY_REASONING_ID_PREFIX)
        && !text.contains(r#""compaction""#)
    {
        return None;
    }
    let mut document: RawDocument = serde_json::from_str(text).ok()?;
    let input = document.0.iter_mut().find(|(key, _)| key == "input")?;
    let items: Vec<Box<RawValue>> = serde_json::from_str(input.1.get()).ok()?;

    let mut changed = false;
    let mut kept = Vec::with_capacity(items.len());
    for raw in items {
        let Ok(head) = serde_json::from_str::<NativeItemHead>(raw.get()) else {
            kept.push(raw);
            continue;
        };
        let ours = head.id.starts_with(REASONING_ID_PREFIX)
            || head.id.starts_with(LEGACY_REASONING_ID_PREFIX);
        if head.kind == "reasoning" && ours {
            changed = true;
            continue;
        }
        if head.kind == "compaction" {
            if let Some(summary) = compaction_summary(&head.encrypted_content) {
                let message = json!({
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": format!("{COMPACTION_PREAMBLE}{summary}") }],
                });
                kept.push(serde_json::value::to_raw_value(&message).ok()?);
                changed = true;
                continue;
            }
        }
        kept.push(raw);
    }
    if !changed {
        return None;
    }
    input.1 = serde_json::value::to_raw_value(&kept).ok()?;
    serde_json::to_vec(&document).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn convert(body: &str) -> (ChatRequest, Value) {
        let req = to_chat(body.as_bytes(), "weibo/glm-5").expect("to_chat");
        let chat: Value = serde_json::from_slice(&req.chat_body).expect("chat body is not JSON");
        (req, chat)
    }

    fn must_chat_body(body: &str) -> String {
        let req = to_chat(body.as_bytes(), "m").expect("to_chat");
        String::from_utf8(req.chat_body).expect("chat body is not UTF-8")
    }

    fn messages(chat: &Value) -> &Vec<Value> {
        chat["messages"]
            .as_array()
            .expect("messages must be an array")
    }

    /// 与 Go 测试里 `len(chat.Tools)` 同义：缺失、null、空数组都算 0。
    fn tools(chat: &Value) -> Vec<Value> {
        chat["tools"].as_array().cloned().unwrap_or_default()
    }

    /// AC2：Codex 的 Responses 请求转成网关能懂的 Chat Completions 请求。
    #[test]
    fn ac2_basic_conversation() {
        let (_, chat) = convert(
            r#"{
          "model":"weibo-glm-5","stream":true,"store":false,"prompt_cache_key":"x","include":["reasoning.encrypted_content"],
          "client_metadata":{"a":1},"reasoning":{"summary":"auto"},"max_output_tokens":500,
          "instructions":"You are Codex.",
          "input":[
            {"type":"message","role":"developer","content":[{"type":"input_text","text":"sandbox rules"}]},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"},{"type":"input_text","text":"world"}]},
            {"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"opaque"},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}
          ]}"#,
        );
        assert_eq!(chat["model"], "weibo/glm-5");
        assert_eq!(chat["stream"], true);
        assert_eq!(chat["max_tokens"], 500);
        assert_eq!(
            chat["stream_options"]["include_usage"], true,
            "usage must be requested so Codex can show token counts"
        );
        let want = [
            ("system", "You are Codex."),
            ("system", "sandbox rules"),
            ("user", "hello\nworld"),
            ("assistant", "hi there"),
        ];
        let got = messages(&chat);
        assert_eq!(got.len(), want.len(), "messages = {got:?}");
        for (i, (role, content)) in want.iter().enumerate() {
            assert_eq!(got[i]["role"], *role, "message {i} = {}", got[i]);
            assert_eq!(got[i]["content"], *content, "message {i} = {}", got[i]);
        }

        let leaky = must_chat_body(
            r#"{"model":"m","store":false,"prompt_cache_key":"x","client_metadata":{},"include":["reasoning.encrypted_content"],"input":"x"}"#,
        );
        for leaked in [
            "prompt_cache_key",
            "client_metadata",
            "encrypted_content",
            "store",
        ] {
            assert!(
                !leaky.contains(leaked),
                "Responses-only field {leaked:?} leaked into the chat request: {leaky}"
            );
        }
        let raw = must_chat_body(r#"{"model":"m","input":"plain string"}"#);
        assert!(
            raw.contains(r#""plain string""#),
            "string input not converted: {raw}"
        );
    }

    /// AC5：工具定义、工具调用历史和工具输出都要转换；命名空间工具摊平，web_search 这类网关不认识的工具丢掉。
    #[test]
    fn ac5_tools_and_tool_history() {
        let (req, chat) = convert(
            r#"{
          "model":"weibo-glm-5","tool_choice":"auto","parallel_tool_calls":true,
          "tools":[
            {"type":"function","name":"exec_command","description":"run","strict":false,"parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}},
            {"type":"namespace","name":"multi_agent_v1","description":"agents","tools":[
               {"type":"function","name":"spawn_agent","description":"spawn","parameters":{"type":"object"}}]},
            {"type":"web_search","external_web_access":false},
            {"type":"custom","name":"apply_patch","format":{"type":"grammar"}}
          ],
          "input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"read the file"}]},
            {"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\"cmd\":\"cat a\"}"},
            {"type":"function_call","call_id":"call_2","name":"spawn_agent","namespace":"multi_agent_v1","arguments":"{}"},
            {"type":"function_call_output","call_id":"call_1","output":"file content"},
            {"type":"function_call_output","call_id":"call_2","output":[{"type":"input_text","text":"agent "},{"type":"input_text","text":"started"}]}
          ]}"#,
        );
        let tools = tools(&chat);
        assert_eq!(tools.len(), 2, "tools = {tools:?}");
        let mut names = Vec::new();
        for tool in &tools {
            let function = &tool["function"];
            names.push(function["name"].as_str().expect("tool name").to_string());
            assert_eq!(tool["type"], "function", "bad tool: {tool}");
            assert!(!function["parameters"].is_null(), "bad tool: {tool}");
        }
        assert_eq!(names, ["exec_command", "multi_agent_v1__spawn_agent"]);
        assert_eq!(
            req.tools.resolve("multi_agent_v1__spawn_agent"),
            (Some("multi_agent_v1"), "spawn_agent")
        );
        assert_eq!(req.tools.resolve("exec_command"), (None, "exec_command"));
        assert_eq!(chat["tool_choice"], "auto");
        assert_eq!(chat["parallel_tool_calls"], true);

        let got = messages(&chat);
        assert_eq!(got.len(), 4, "messages = {got:?}");
        let assistant = &got[1];
        let calls = assistant["tool_calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(assistant["role"], "assistant");
        assert_eq!(
            calls.len(),
            2,
            "parallel calls must share one assistant message: {assistant}"
        );
        let second = &calls[1];
        assert_eq!(second["id"], "call_2", "second call = {second}");
        assert_eq!(
            second["function"]["name"], "multi_agent_v1__spawn_agent",
            "second call = {second}"
        );
        assert_eq!(got[2]["role"], "tool", "tool message = {}", got[2]);
        assert_eq!(
            got[2]["tool_call_id"], "call_1",
            "tool message = {}",
            got[2]
        );
        assert_eq!(
            got[2]["content"], "file content",
            "tool message = {}",
            got[2]
        );
        assert_eq!(
            got[3]["content"], "agent started",
            "array output not flattened: {}",
            got[3]
        );
    }

    /// 没有工具时不能带 tool_choice / parallel_tool_calls，不少网关会因此报错。
    #[test]
    fn no_tools_means_no_tool_fields() {
        let body = must_chat_body(
            r#"{"model":"m","tool_choice":"auto","parallel_tool_calls":true,"tools":[{"type":"web_search"}],"input":"x"}"#,
        );
        for field in ["tool_choice", "parallel_tool_calls", "\"tools\""] {
            assert!(
                !body.contains(field),
                "{field} present without tools: {body}"
            );
        }
    }

    /// 历史不完整时（任务被中断）也要产出网关能接受的消息序列。
    #[test]
    fn broken_tool_history_is_repaired() {
        let (_, chat) = convert(
            r#"{"model":"m","input":[
            {"type":"function_call_output","call_id":"orphan","output":"late result"},
            {"type":"function_call","call_id":"call_9","name":"exec_command","arguments":"{}"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"never mind"}]}
        ]}"#,
        );
        let got = messages(&chat);
        assert_eq!(got[0]["role"], "user");
        assert!(
            got[0]["content"]
                .as_str()
                .is_some_and(|text| text.contains("late result")),
            "orphan tool output should become a user message: {}",
            got[0]
        );
        assert_eq!(
            got[2]["role"], "tool",
            "unanswered call needs a synthetic tool message: {got:?}"
        );
        assert_eq!(got[2]["tool_call_id"], "call_9", "messages = {got:?}");
        assert_eq!(got[3]["role"], "user", "messages = {got:?}");
    }

    #[test]
    fn images_become_image_url_parts() {
        let (_, chat) = convert(
            r#"{"model":"m","input":[{"type":"message","role":"user","content":[
           {"type":"input_text","text":"what is this"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}]}"#,
        );
        let content = &messages(&chat)[0]["content"];
        let parts = content
            .as_array()
            .expect("content must be an array of parts");
        assert_eq!(parts.len(), 2, "content = {content}");
        let image = &parts[1];
        assert_eq!(image["type"], "image_url", "image part = {image}");
        assert_eq!(
            image["image_url"]["url"], "data:image/png;base64,AAAA",
            "image part = {image}"
        );
    }

    /// 压缩：触发条目让本次请求变成“请总结”；之后带回来的压缩条目展开成摘要；别家的压缩条目解不开，丢弃。
    #[test]
    fn compaction_trigger_and_expansion() {
        let (req, chat) = convert(
            r#"{"model":"m","tools":[{"type":"function","name":"exec_command","parameters":{}}],"input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"long story"}]},
            {"type":"compaction_trigger"}]}"#,
        );
        assert!(req.compaction, "compaction trigger not detected");
        assert_eq!(
            chat["stream"], false,
            "a compaction request must be a plain non-streaming completion"
        );
        assert!(
            tools(&chat).is_empty(),
            "a compaction request must be a plain non-streaming completion: tools={}",
            chat["tools"]
        );
        let last = messages(&chat).last().expect("messages");
        assert_eq!(
            last["role"], "user",
            "last message should ask for a summary: {last}"
        );
        assert!(
            last["content"]
                .as_str()
                .is_some_and(|text| text.to_lowercase().contains("summar")),
            "last message should ask for a summary: {last}"
        );

        let encoded = serde_json::to_string(&compaction_item("the summary text")).expect("item");
        let (_, chat) = convert(&format!(
            r#"{{"model":"m","input":[{encoded},
            {{"type":"compaction","encrypted_content":"gAAAA-openai-opaque"}},
            {{"type":"message","role":"user","content":[{{"type":"input_text","text":"continue"}}]}}]}}"#
        ));
        let got = messages(&chat);
        assert_eq!(got.len(), 2, "messages = {got:?}");
        assert!(
            got[0]["content"]
                .as_str()
                .is_some_and(|text| text.contains("the summary text")),
            "messages = {got:?}"
        );
    }

    /// 用抓到的真实 Codex 请求做一遍：必须能转换，且产物里没有网关不认识的东西。
    #[test]
    fn real_captured_codex_request_converts() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/data/request-custom-provider.json"
        );
        let data = std::fs::read(path).expect("sample must be present in tests/data");
        let sample: Value = serde_json::from_slice(&data).expect("sample is not JSON");
        let body = serde_json::to_vec(&sample["body"]).expect("sample body");
        let req = to_chat(&body, "weibo/glm-5").expect("to_chat");
        let chat: Value = serde_json::from_slice(&req.chat_body).expect("chat body is not JSON");

        let got = messages(&chat);
        assert_eq!(got[0]["role"], "system");
        assert!(got.len() >= 3, "messages = {}", got.len());
        let tools = tools(&chat);
        assert!(
            tools.len() >= 5,
            "expected the function tools plus flattened namespace members, got {}",
            tools.len()
        );
        for tool in &tools {
            let name = tool["function"]["name"].as_str().expect("tool name");
            assert_eq!(
                tool["type"], "function",
                "tool {name:?} is not a valid chat function"
            );
            assert!(
                name.len() <= 64 && !name.contains(['.', ' ', '/']),
                "tool {name:?} is not a valid chat function"
            );
        }
        for message in got {
            assert_ne!(
                message["role"], "developer",
                "developer role must be mapped to system"
            );
        }
    }

    /// 官方路径：历史里混有本工具产生的推理条目和压缩条目时，要清理后再发给官方上游；没有就原样不动。
    #[test]
    fn normalize_for_native_cleans_our_items() {
        let untouched =
            br#"{"model":"gpt-5.6-sol",  "input":[{"type":"message","role":"user","content":[]}]}"#;
        assert!(
            normalize_for_native(untouched).is_none(),
            "bodies without our items must be passed through byte for byte"
        );

        let item = serde_json::to_string(&compaction_item("earlier summary")).expect("item");
        let body = format!(
            r#"{{"model":"gpt-5.6-sol","store":false,"input":[{item},
          {{"type":"reasoning","id":"{REASONING_ID_PREFIX}123","summary":[{{"type":"summary_text","text":"thinking"}}]}},
          {{"type":"reasoning","id":"rs_official","encrypted_content":"keep-me"}},
          {{"type":"message","role":"user","content":[{{"type":"input_text","text":"go on"}}]}}]}}"#
        );
        let out = normalize_for_native(body.as_bytes()).expect("expected a change");
        let doc: Value = serde_json::from_slice(&out).expect("output is not JSON");
        let input = doc["input"].as_array().expect("input");
        assert_eq!(input.len(), 3, "input = {input:?}");
        assert!(
            doc.get("store").is_some(),
            "other fields must be kept: {doc}"
        );
        assert_eq!(
            input[0]["type"], "message",
            "our compaction item should become a summary message: {}",
            input[0]
        );
        assert!(
            String::from_utf8_lossy(&out).contains("earlier summary"),
            "our compaction item should become a summary message: {}",
            input[0]
        );
        assert_eq!(
            input[1]["id"], "rs_official",
            "official reasoning item must be kept: {}",
            input[1]
        );
    }

    /// 在 agents-manager（Go 版）下开始的会话要能接着用：它的压缩条目和推理条目前缀同样认。
    #[test]
    fn legacy_agents_manager_items_are_recognised() {
        use base64::Engine as _;
        let payload = r#"{"type":"agents_manager_compaction","version":1,"summary":"go summary"}"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
        let body = format!(
            r#"{{"model":"m","input":[
          {{"type":"compaction","encrypted_content":"{encoded}"}},
          {{"type":"reasoning","id":"rs_am_0011","summary":[]}},
          {{"type":"message","role":"user","content":[{{"type":"input_text","text":"continue"}}]}}]}}"#
        );
        let (_, chat) = convert(&body);
        let got = messages(&chat);
        assert_eq!(got.len(), 2, "messages = {got:?}");
        assert!(
            got[0]["content"]
                .as_str()
                .is_some_and(|text| text.contains("go summary")),
            "messages = {got:?}"
        );

        let out = normalize_for_native(body.as_bytes()).expect("expected a change");
        let doc: Value = serde_json::from_slice(&out).expect("output is not JSON");
        let input = doc["input"].as_array().expect("input");
        assert_eq!(input.len(), 2, "input = {input:?}");
        assert_eq!(input[0]["type"], "message");
        assert!(String::from_utf8_lossy(&out).contains("go summary"));
        assert!(!String::from_utf8_lossy(&out).contains("rs_am_0011"));
    }
}

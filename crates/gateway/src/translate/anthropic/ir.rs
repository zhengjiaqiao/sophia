//! 请求方向的中间形态：把 Anthropic Messages 请求读成与上游协议无关的条目序列，
//! R17（剥字段与块）、R18（工具名）、R20（占位）以及中途 `role: system` 的处理都在这里做一次，
//! Chat（R16）与 Responses（R19）两个出口各自只管排版。

use serde_json::{Map, Value};

use super::count::estimate_tokens;
use super::names::ToolNameMap;
use super::request::{RequestError, ATTACHMENT_PLACEHOLDER, BILLING_BLOCK_PREFIX};
use crate::translate::Effort;

/// 追加在系统提示末尾的结构化输出说明。即使上游支持 `response_format`，也一并写上：
/// 起标题等请求的回复不是 JSON 时 Claude Code 会静默丢弃（P0 抓包 L 轮）。
pub(super) const STRUCTURED_OUTPUT_INSTRUCTION: &str =
    "Respond with only a JSON object that matches the following JSON Schema. \
Do not wrap it in Markdown code fences and do not add any other text.\n\nJSON Schema:\n";

/// 中途 `role: system` 消息并入 user 消息时的包装。
const MID_SYSTEM_OPEN: &str = "<system-reminder>\n";
const MID_SYSTEM_CLOSE: &str = "\n</system-reminder>";

/// 块之间的分隔：Anthropic 的相邻 text 块语义上是分段。
pub(super) const BLOCK_SEPARATOR: &str = "\n\n";

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Part {
    Text(String),
    /// `data:` URL 或 http(s) URL。
    Image(String),
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Call {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Item {
    User(Vec<Part>),
    Assistant { text: String, calls: Vec<Call> },
    ToolResult { call_id: String, output: String },
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct FunctionTool {
    pub name: String,
    pub description: Option<String>,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ToolChoice {
    Auto,
    Required,
    None,
    Function(String),
}

/// 解析后的请求。
pub(super) struct Parsed {
    pub stream: bool,
    /// 顶层系统提示（已去掉归因块、已追加结构化输出说明）。
    pub system: String,
    pub items: Vec<Item>,
    pub tools: Vec<FunctionTool>,
    pub tool_choice: Option<ToolChoice>,
    pub parallel_off: bool,
    pub json_schema: Option<Value>,
    /// 请求是否要了思考（`thinking` 存在且不是 `disabled`）。
    pub thinking_requested: bool,
    /// 请求是否明说了不要思考（`thinking: {type: "disabled"}`）。缺省不算——那时按模型自己的默认
    pub thinking_disabled: bool,
    /// 要了思考时客户端要的推理强度（见 [`requested_effort`]）；没要思考时总是 `None`。
    pub effort: Option<Effort>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<Value>,
    pub top_p: Option<Value>,
    pub stop: Vec<String>,
    pub names: ToolNameMap,
    pub estimate: u64,
}

pub(super) fn parse_root(body: &[u8]) -> Result<Map<String, Value>, RequestError> {
    match serde_json::from_slice::<Value>(body).map_err(RequestError::Parse)? {
        Value::Object(root) => Ok(root),
        _ => Err(RequestError::NotObject),
    }
}

pub(super) fn model_of(root: &Map<String, Value>) -> Result<String, RequestError> {
    match root.get("model").and_then(Value::as_str) {
        Some(model) if !model.is_empty() => Ok(model.to_string()),
        _ => Err(RequestError::MissingModel),
    }
}

pub(super) fn parse(body: &[u8]) -> Result<Parsed, RequestError> {
    let root = parse_root(body)?;
    model_of(&root)?;
    // 包成 Value 一次，估算时不必再复制整个请求（可能带几 MB 的图片）
    let root = Value::Object(root);
    let messages = root
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(RequestError::MissingMessages)?;

    let mut names = ToolNameMap::new();

    // 工具先登记，历史里的 tool_use 与 tool_choice 用同一张名字表
    let mut tools = Vec::new();
    for tool in root
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        // 没有 input_schema 的是服务端工具（web_search_* 等）；defer_loading 的要靠服务端展开：都去掉
        let Some(schema) = tool.get("input_schema").filter(|s| s.is_object()) else {
            continue;
        };
        if tool.get("defer_loading").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(name) = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        tools.push(FunctionTool {
            name: names.register(name),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .map(str::to_string),
            parameters: schema.clone(),
        });
    }

    let (tool_choice, parallel_off) =
        parse_tool_choice(root.get("tool_choice"), &tools, &mut names);

    let json_schema = root
        .get("output_config")
        .and_then(|config| config.get("format"))
        .filter(|format| format.get("type").and_then(Value::as_str) == Some("json_schema"))
        .and_then(|format| format.get("schema"))
        .cloned();

    let mut system_parts: Vec<String> = root
        .get("system")
        .map(system_text)
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect();

    // 中途 `role: system`（Claude Code 每轮一条，`mid-conversation-system` beta）。
    // 多数 Chat 上游只接受开头的 system，中途的可能 400 或被忽略；全并进顶层 system 又会让
    // 每轮系统提示都变、上游前缀缓存失效。所以（R16，P0 冲突 1 的 (b)）：数组开头的并入顶层
    // system；其余原位并入 user——前一条是 user 就追加在它末尾，否则挂起、放到下一条 user 的
    // 最前（排在它的 tool 消息之后）；前后都没有 user 时单独成一条。
    let mut items = Vec::new();
    let mut pending: Vec<Part> = Vec::new();
    let mut leading = true;
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let content = message.get("content").unwrap_or(&Value::Null);
        if role == "system" {
            let text = plain_text(content);
            if text.is_empty() {
                continue;
            }
            if leading {
                system_parts.push(text);
                continue;
            }
            let part = Part::Text(format!("{MID_SYSTEM_OPEN}{text}{MID_SYSTEM_CLOSE}"));
            match items.last_mut() {
                Some(Item::User(parts)) if pending.is_empty() => parts.push(part),
                _ => pending.push(part),
            }
            continue;
        }
        leading = false;
        if role == "assistant" {
            flush_pending(&mut items, &mut pending);
            items.extend(convert_assistant(content, &mut names));
        } else {
            convert_user(&mut items, content, std::mem::take(&mut pending));
        }
    }
    flush_pending(&mut items, &mut pending);
    if items.is_empty() {
        return Err(RequestError::NoMessages);
    }

    if let Some(schema) = &json_schema {
        system_parts.push(format!("{STRUCTURED_OUTPUT_INSTRUCTION}{schema}"));
    }

    let thinking_requested = root
        .get("thinking")
        .filter(|thinking| !thinking.is_null())
        .is_some_and(|thinking| thinking.get("type").and_then(Value::as_str) != Some("disabled"));
    let thinking_disabled = root
        .get("thinking")
        .and_then(|thinking| thinking.get("type"))
        .and_then(Value::as_str)
        == Some("disabled");
    let effort = if thinking_requested {
        requested_effort(&root)
    } else {
        None
    };

    Ok(Parsed {
        stream: root.get("stream").and_then(Value::as_bool).unwrap_or(false),
        system: system_parts.join(BLOCK_SEPARATOR),
        items,
        tools,
        tool_choice,
        parallel_off,
        json_schema,
        thinking_requested,
        thinking_disabled,
        effort,
        max_tokens: root
            .get("max_tokens")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0),
        temperature: root.get("temperature").filter(|v| v.is_number()).cloned(),
        top_p: root.get("top_p").filter(|v| v.is_number()).cloned(),
        stop: root
            .get("stop_sequences")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        names,
        estimate: estimate_tokens(&root),
    })
}

/// 要了思考的请求想要的推理强度：`output_config.effort` 优先（带了就只看它，读不懂也不再退回预算）；
/// 没带（缺省或 null）时看 `thinking: {type: "enabled", budget_tokens}` 的预算；`adaptive` 等没有
/// effort 的，返回 `None`，交给上游默认。
fn requested_effort(root: &Value) -> Option<Effort> {
    if let Some(effort) = root
        .pointer("/output_config/effort")
        .filter(|effort| !effort.is_null())
    {
        return Effort::from_anthropic(effort);
    }
    let thinking = root.get("thinking")?;
    if thinking.get("type").and_then(Value::as_str) != Some("enabled") {
        return None;
    }
    thinking
        .get("budget_tokens")
        .and_then(Value::as_u64)
        .map(Effort::from_budget_tokens)
}

/// 顶层 `system`：字符串，或 text 块数组（按原顺序以空行相连，去掉归因块）。
fn system_text(system: &Value) -> String {
    match system {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .filter(|text| !text.starts_with(BILLING_BLOCK_PREFIX))
            .collect::<Vec<_>>()
            .join(BLOCK_SEPARATOR),
        _ => String::new(),
    }
}

/// 字符串或 text 块数组的全部文字。
fn plain_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(BLOCK_SEPARATOR),
        _ => String::new(),
    }
}

/// 挂起的中途 system 没等到 user：单独成一条 user。
fn flush_pending(items: &mut Vec<Item>, pending: &mut Vec<Part>) {
    if !pending.is_empty() {
        items.push(Item::User(std::mem::take(pending)));
    }
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

/// 丢弃而不占位的块：思考、服务端工具的调用与结果、工具搜索的引用（R17）。
fn is_dropped_block(kind: &str) -> bool {
    matches!(
        kind,
        "thinking" | "redacted_thinking" | "server_tool_use" | "tool_reference"
    ) || (kind.ends_with("_tool_result") && kind != "tool_result")
}

fn image_part(block: &Value) -> Part {
    let source = block.get("source").unwrap_or(&Value::Null);
    let text = |key: &str| source.get(key).and_then(Value::as_str).unwrap_or("");
    match text("type") {
        "base64" if !text("data").is_empty() => Part::Image(format!(
            "data:{};base64,{}",
            text("media_type"),
            text("data")
        )),
        "url" if !text("url").is_empty() => Part::Image(text("url").to_string()),
        // file id 等上游看不到的来源
        _ => Part::Text(ATTACHMENT_PLACEHOLDER.to_string()),
    }
}

/// user 侧一个非工具结果块 → 部分；返回 None 表示丢弃。
fn user_part(block: &Value) -> Option<Part> {
    match block_type(block) {
        "text" => block
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| Part::Text(text.to_string())),
        "image" => Some(image_part(block)),
        // R20：search_result 取其文本
        "search_result" => {
            let text = plain_text(block.get("content").unwrap_or(&Value::Null));
            (!text.is_empty()).then_some(Part::Text(text))
        }
        kind if is_dropped_block(kind) => None,
        // R20：document（PDF 等）与其它表达不了的块换成占位，不整条拒绝
        _ => Some(Part::Text(ATTACHMENT_PLACEHOLDER.to_string())),
    }
}

/// `prefix` 是挂起的中途 system，排在这条 user 的其余内容之前（tool 消息之后）。
fn convert_user(items: &mut Vec<Item>, content: &Value, prefix: Vec<Part>) {
    let mut parts = prefix;
    let blocks = match content {
        Value::String(text) => {
            if !text.is_empty() {
                parts.push(Part::Text(text.clone()));
            }
            if !parts.is_empty() {
                items.push(Item::User(parts));
            }
            return;
        }
        Value::Array(blocks) => blocks.as_slice(),
        _ => &[],
    };
    // tool 消息必须紧跟 assistant 的 tool_calls：先排工具结果，结果里的图片与其余内容放在随后一条 user 里
    let mut tool_images = Vec::new();
    let mut rest = Vec::new();
    for block in blocks {
        if block_type(block) != "tool_result" {
            rest.extend(user_part(block));
            continue;
        }
        let call_id = block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut texts = Vec::new();
        match block.get("content") {
            Some(Value::String(text)) => texts.push(text.clone()),
            Some(Value::Array(inner)) => {
                for part in inner.iter().filter_map(user_part) {
                    match part {
                        Part::Text(text) => texts.push(text),
                        image @ Part::Image(_) => tool_images.push(image),
                    }
                }
            }
            _ => {}
        }
        let mut output = texts.join(BLOCK_SEPARATOR);
        if block.get("is_error").and_then(Value::as_bool) == Some(true) {
            output = format!("Error: {output}");
        }
        items.push(Item::ToolResult { call_id, output });
    }
    parts.extend(tool_images);
    parts.extend(rest);
    if !parts.is_empty() {
        items.push(Item::User(parts));
    }
}

fn convert_assistant(content: &Value, names: &mut ToolNameMap) -> Option<Item> {
    let mut texts = Vec::new();
    let mut calls = Vec::new();
    match content {
        Value::String(text) if !text.is_empty() => texts.push(text.clone()),
        Value::Array(blocks) => {
            for block in blocks {
                match block_type(block) {
                    "text" => {
                        if let Some(text) = block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                        {
                            texts.push(text.to_string());
                        }
                    }
                    "tool_use" => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                        let arguments = match block.get("input") {
                            Some(input) if !input.is_null() => input.to_string(),
                            _ => "{}".to_string(),
                        };
                        calls.push(Call {
                            // 历史里的 id 是我们（或官方）发过的，已合法，原样使用
                            id: block
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            name: names.register(name),
                            arguments,
                        });
                    }
                    // 思考、服务端工具等：丢弃（assistant 侧没有需要占位的附件）
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if texts.is_empty() && calls.is_empty() {
        return None;
    }
    Some(Item::Assistant {
        text: texts.join(BLOCK_SEPARATOR),
        calls,
    })
}

fn parse_tool_choice(
    raw: Option<&Value>,
    tools: &[FunctionTool],
    names: &mut ToolNameMap,
) -> (Option<ToolChoice>, bool) {
    let Some(raw) = raw.filter(|raw| raw.is_object()) else {
        return (None, false);
    };
    let parallel_off = raw
        .get("disable_parallel_tool_use")
        .and_then(Value::as_bool)
        == Some(true);
    let choice = match raw.get("type").and_then(Value::as_str).unwrap_or("") {
        "auto" => Some(ToolChoice::Auto),
        "any" => Some(ToolChoice::Required),
        "none" => Some(ToolChoice::None),
        "tool" => {
            let name = raw.get("name").and_then(Value::as_str).unwrap_or("");
            let upstream = names.register(name);
            // 指向被去掉（或不存在）的工具时改为 auto
            Some(if tools.iter().any(|tool| tool.name == upstream) {
                ToolChoice::Function(upstream)
            } else {
                ToolChoice::Auto
            })
        }
        _ => None,
    };
    (choice, parallel_off)
}

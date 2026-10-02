//! 回程第一层：上游 SSE → 中性事件 [`UpstreamEvent`]。
//!
//! 与协议无关的发射器（[`AnthropicEmitter`](super::AnthropicEmitter)）只吃中性事件，
//! Chat Completions 与 Responses 两种上游各有一个解析器。都是增量状态机：
//! 字节可以在任意位置被切开，内部按换行重拼。

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// 单行 SSE 的上限；正常的数据块远小于它（与 Codex 路径的 `StreamConverter` 相同）。
const MAX_LINE_BYTES: usize = 8 << 20;

/// 上游给出的结束原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Other(String),
}

impl FinishReason {
    fn from_chat(reason: &str) -> Self {
        match reason {
            "stop" => Self::Stop,
            "length" => Self::Length,
            "tool_calls" | "function_call" => Self::ToolCalls,
            "content_filter" => Self::ContentFilter,
            other => Self::Other(other.to_string()),
        }
    }
}

/// 上游用量。`input_tokens` 含缓存命中部分（Chat 的 `prompt_tokens`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
}

/// 与上游协议无关的回程事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpstreamEvent {
    /// 一段回答文字（非空）。
    Text(String),
    /// 上游在吐推理内容。内容一律丢弃（R22），只表示「上游还活着」。
    Reasoning,
    /// 一个工具调用开始。`index` 是上游的序号，用来对上后续参数片段。
    ToolStart {
        index: i64,
        id: String,
        name: String,
    },
    /// 工具调用参数的一段（非空）。
    ToolArgs { index: i64, delta: String },
    /// 结束原因。同一条流只报第一次（openrouter 会重复给）。
    Finish(FinishReason),
    /// 用量。可能多次出现（ap-gateway 每块都带累计值），以最后一次为准。
    Usage(Usage),
    /// 流中出错；之后解析器不再产出事件。
    Error(String),
    /// 显式结束标记（Chat 的 `[DONE]`、Responses 的 `response.completed` 等）。
    Done,
}

/// 按行切分的公共部分。
#[derive(Default)]
struct LineSplitter {
    buffer: Vec<u8>,
}

impl LineSplitter {
    /// 返回完整的行，以及残余是否超过单行上限（超过时残余已丢弃）。
    fn push(&mut self, chunk: &[u8]) -> (Vec<String>, bool) {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(end) = rest.iter().position(|byte| *byte == b'\n') {
            self.buffer.extend_from_slice(&rest[..end]);
            rest = &rest[end + 1..];
            let line = std::mem::take(&mut self.buffer);
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        self.buffer.extend_from_slice(rest);
        let overflow = self.buffer.len() > MAX_LINE_BYTES;
        if overflow {
            self.buffer = Vec::new();
        }
        (lines, overflow)
    }

    fn take_rest(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buffer);
        (!rest.is_empty()).then(|| String::from_utf8_lossy(&rest).into_owned())
    }
}

/// SSE 行里的 `data:` 负载；注释行、`event:` 行、空行返回 None。
fn data_of(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let data = line.strip_prefix("data:")?;
    Some(data.strip_prefix(' ').unwrap_or(data))
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn u64_at(value: &Value, pointer: &str) -> u64 {
    value.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

/// 上游错误对象（或字符串）里给人看的文字。
fn error_text(error: &Value) -> String {
    match error {
        Value::String(text) => text.clone(),
        other => non_empty_str(other.get("message"))
            .map(str::to_string)
            .unwrap_or_else(|| other.to_string()),
    }
}

const LINE_TOO_LONG: &str = "the third-party stream sent a line that is too long";

/// Chat Completions 流式上游的解析器。
///
/// 覆盖的真实上游行为（P0 样本）：ap-gateway 未结束时 `finish_reason` 为 `""`、每块带累计
/// `usage`、每块带 `tool_calls: []`、工具 id 形如 `functions.get_weather:0`；openrouter 推理用
/// `reasoning` / `reasoning_details`、`finish_reason` 出现两次、`usage` 只在最后一块。
#[derive(Default)]
pub struct ChatEvents {
    lines: LineSplitter,
    closed: bool,
    finish_seen: bool,
    tools_started: HashSet<i64>,
    tool_ids: HashMap<i64, String>,
}

impl ChatEvents {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一段上游字节，返回其中完整行产生的事件。
    pub fn feed_bytes(&mut self, chunk: &[u8]) -> Vec<UpstreamEvent> {
        if self.closed {
            return Vec::new();
        }
        let (lines, overflow) = self.lines.push(chunk);
        let mut events = Vec::new();
        for line in lines {
            if self.closed {
                break;
            }
            self.feed_line(&line, &mut events);
        }
        if overflow && !self.closed {
            // 上游不给换行地一直发：不能无限缓冲
            self.closed = true;
            events.push(UpstreamEvent::Error(LINE_TOO_LONG.to_string()));
        }
        events
    }

    /// 上游连接结束：处理最后一行没有换行的残余。不会自己补 [`UpstreamEvent::Done`]。
    pub fn finish(&mut self) -> Vec<UpstreamEvent> {
        let mut events = Vec::new();
        if let Some(line) = self.lines.take_rest().filter(|_| !self.closed) {
            self.feed_line(&line, &mut events);
        }
        events
    }

    fn feed_line(&mut self, line: &str, events: &mut Vec<UpstreamEvent>) {
        let Some(data) = data_of(line) else {
            return;
        };
        let data = data.trim();
        if data == "[DONE]" {
            self.closed = true;
            events.push(UpstreamEvent::Done);
            return;
        }
        // 读不懂的数据行跳过：个别网关会夹带非 JSON 的心跳
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(error) = chunk.get("error").filter(|error| !error.is_null()) {
            self.closed = true;
            events.push(UpstreamEvent::Error(error_text(error)));
            return;
        }
        let choice = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| {
                choices
                    .iter()
                    .find(|choice| choice.get("index").and_then(Value::as_i64).unwrap_or(0) == 0)
            });
        if let Some(choice) = choice {
            let delta = choice.get("delta").unwrap_or(&Value::Null);
            let reasoning = non_empty_str(delta.get("reasoning_content")).is_some()
                || non_empty_str(delta.get("reasoning")).is_some()
                || delta
                    .get("reasoning_details")
                    .and_then(Value::as_array)
                    .is_some_and(|details| !details.is_empty());
            if reasoning {
                events.push(UpstreamEvent::Reasoning);
            }
            if let Some(text) = non_empty_str(delta.get("content")) {
                events.push(UpstreamEvent::Text(text.to_string()));
            }
            for call in delta
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                self.tool_call(call, events);
            }
            if let Some(reason) = non_empty_str(choice.get("finish_reason")) {
                if !self.finish_seen {
                    self.finish_seen = true;
                    events.push(UpstreamEvent::Finish(FinishReason::from_chat(reason)));
                }
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            events.push(UpstreamEvent::Usage(Usage {
                input_tokens: u64_at(usage, "/prompt_tokens"),
                cached_tokens: u64_at(usage, "/prompt_tokens_details/cached_tokens"),
                output_tokens: u64_at(usage, "/completion_tokens"),
            }));
        }
    }

    fn tool_call(&mut self, call: &Value, events: &mut Vec<UpstreamEvent>) {
        let index = call.get("index").and_then(Value::as_i64).unwrap_or(0);
        let function = call.get("function").unwrap_or(&Value::Null);
        let id = non_empty_str(call.get("id")).unwrap_or("");
        let name = non_empty_str(function.get("name")).unwrap_or("");
        // id 可能先于名字到：记下来，等名字到了再报开始（参数先到的由发射器缓冲）
        if !id.is_empty() {
            self.tool_ids.entry(index).or_insert_with(|| id.to_string());
        }
        if !name.is_empty() && self.tools_started.insert(index) {
            events.push(UpstreamEvent::ToolStart {
                index,
                id: self.tool_ids.get(&index).cloned().unwrap_or_default(),
                name: name.to_string(),
            });
        }
        if let Some(arguments) = non_empty_str(function.get("arguments")) {
            events.push(UpstreamEvent::ToolArgs {
                index,
                delta: arguments.to_string(),
            });
        }
    }
}

/// Responses 流式上游的解析器（R19，**实验性**：按 OpenAI 文档实现，没有真实样本）。
#[derive(Default)]
pub struct ResponsesEvents {
    lines: LineSplitter,
    closed: bool,
    tools_started: HashSet<i64>,
    args_seen: HashSet<i64>,
    saw_function_call: bool,
}

impl ResponsesEvents {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed_bytes(&mut self, chunk: &[u8]) -> Vec<UpstreamEvent> {
        if self.closed {
            return Vec::new();
        }
        let (lines, overflow) = self.lines.push(chunk);
        let mut events = Vec::new();
        for line in lines {
            if self.closed {
                break;
            }
            self.feed_line(&line, &mut events);
        }
        if overflow && !self.closed {
            // 上游不给换行地一直发：不能无限缓冲
            self.closed = true;
            events.push(UpstreamEvent::Error(LINE_TOO_LONG.to_string()));
        }
        events
    }

    pub fn finish(&mut self) -> Vec<UpstreamEvent> {
        let mut events = Vec::new();
        if let Some(line) = self.lines.take_rest().filter(|_| !self.closed) {
            self.feed_line(&line, &mut events);
        }
        events
    }

    fn start_tool(&mut self, index: i64, item: &Value, events: &mut Vec<UpstreamEvent>) {
        if self.tools_started.insert(index) {
            self.saw_function_call = true;
            let id = non_empty_str(item.get("call_id"))
                .or_else(|| non_empty_str(item.get("id")))
                .unwrap_or("");
            events.push(UpstreamEvent::ToolStart {
                index,
                id: id.to_string(),
                name: non_empty_str(item.get("name")).unwrap_or("").to_string(),
            });
        }
    }

    fn feed_line(&mut self, line: &str, events: &mut Vec<UpstreamEvent>) {
        let Some(data) = data_of(line) else {
            return;
        };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else {
            return;
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let index = event
            .get("output_index")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let item = event.get("item").unwrap_or(&Value::Null);
        let item_is_call = item.get("type").and_then(Value::as_str) == Some("function_call");
        match kind {
            "response.output_text.delta" => {
                if let Some(text) = non_empty_str(event.get("delta")) {
                    events.push(UpstreamEvent::Text(text.to_string()));
                }
            }
            kind if kind.starts_with("response.reasoning") => events.push(UpstreamEvent::Reasoning),
            "response.output_item.added" if item_is_call => {
                self.start_tool(index, item, events);
                if let Some(arguments) = non_empty_str(item.get("arguments")) {
                    self.args_seen.insert(index);
                    events.push(UpstreamEvent::ToolArgs {
                        index,
                        delta: arguments.to_string(),
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(delta) = non_empty_str(event.get("delta")) {
                    self.args_seen.insert(index);
                    events.push(UpstreamEvent::ToolArgs {
                        index,
                        delta: delta.to_string(),
                    });
                }
            }
            // 没给过增量的调用，在 done 里一次补齐参数
            "response.output_item.done" if item_is_call => {
                self.start_tool(index, item, events);
                if !self.args_seen.contains(&index) {
                    self.args_seen.insert(index);
                    if let Some(arguments) = non_empty_str(item.get("arguments")) {
                        events.push(UpstreamEvent::ToolArgs {
                            index,
                            delta: arguments.to_string(),
                        });
                    }
                }
            }
            "response.completed" | "response.incomplete" => {
                let response = event.get("response").unwrap_or(&Value::Null);
                if let Some(usage) = response.get("usage").filter(|usage| usage.is_object()) {
                    events.push(UpstreamEvent::Usage(Usage {
                        input_tokens: u64_at(usage, "/input_tokens"),
                        cached_tokens: u64_at(usage, "/input_tokens_details/cached_tokens"),
                        output_tokens: u64_at(usage, "/output_tokens"),
                    }));
                }
                let reason = if kind == "response.completed" {
                    if self.saw_function_call {
                        FinishReason::ToolCalls
                    } else {
                        FinishReason::Stop
                    }
                } else {
                    match response
                        .pointer("/incomplete_details/reason")
                        .and_then(Value::as_str)
                    {
                        Some("max_output_tokens") => FinishReason::Length,
                        Some("content_filter") => FinishReason::ContentFilter,
                        Some(other) => FinishReason::Other(other.to_string()),
                        None => FinishReason::Stop,
                    }
                };
                events.push(UpstreamEvent::Finish(reason));
                events.push(UpstreamEvent::Done);
                self.closed = true;
            }
            "response.failed" | "error" => {
                let error = event
                    .pointer("/response/error")
                    .or_else(|| event.get("error"))
                    .filter(|error| !error.is_null());
                let message = match error {
                    Some(error) => error_text(error),
                    None => non_empty_str(event.get("message"))
                        .unwrap_or("the third-party response failed")
                        .to_string(),
                };
                events.push(UpstreamEvent::Error(message));
                self.closed = true;
            }
            _ => {}
        }
    }
}

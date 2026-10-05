//! 回程第二层：中性事件 → Anthropic 流事件（R21–R24；思考块见 reasoning-passback R2），整条 Message 的聚合（R25），
//! 以及保活 `ping` 的判定（R23）。

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::translate::SseEvent;

use super::count::TokenTally;
use super::errors::AnthropicError;
use super::events::{FinishReason, UpstreamEvent, Usage};
use super::names::{random_alnum, sanitize_tool_id, ToolNameMap};

/// 思考块签名的固定前缀，后接随机串。客户端原样送回，本工具不校验（reasoning-passback R2）。
pub const THINKING_SIGNATURE_PREFIX: &str = "sophia-thinking-v1:";

/// R23 的默认保活间隔（路由配置项，测试里调小）。
pub const DEFAULT_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// `event: ping` / `data: {"type":"ping"}`。
pub fn ping_event() -> SseEvent {
    SseEvent {
        name: "ping".to_string(),
        data: json!({ "type": "ping" }),
    }
}

/// R23：「距上次向客户端写出任何字节超过 N 秒就发 ping」的纯状态，时间由调用方传入。
///
/// 路由的用法：`message_start` 写出后建一个；每次写出字节调 [`record_write`](Self::record_write)；
/// 等上游下一块时用 [`remaining`](Self::remaining) 作超时，超时就 [`poll`](Self::poll)，
/// 拿到 ping 就写出（`poll` 已把它记为一次写出）。流结束后丢弃即可。
#[derive(Debug, Clone)]
pub struct Keepalive {
    interval: Duration,
    last_write: Instant,
}

impl Keepalive {
    pub fn new(interval: Duration, now: Instant) -> Self {
        Self {
            interval,
            last_write: now,
        }
    }

    pub fn record_write(&mut self, now: Instant) {
        self.last_write = now;
    }

    /// 距离下一次该发 ping 还有多久；已到期为零。
    pub fn remaining(&self, now: Instant) -> Duration {
        self.interval
            .saturating_sub(now.saturating_duration_since(self.last_write))
    }

    /// 到期则返回一个 ping 并记为写出，否则 None。
    pub fn poll(&mut self, now: Instant) -> Option<SseEvent> {
        if now.saturating_duration_since(self.last_write) < self.interval {
            return None;
        }
        self.last_write = now;
        Some(ping_event())
    }
}

#[derive(Debug)]
struct ToolSlot {
    /// 上游序号。
    index: i64,
    /// 规整后的 id；上游还没给名字前为空。
    id: String,
    /// 原名（已还原）；为空表示上游还没给名字。
    name: String,
    /// 还没发出去的参数。
    args: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Open {
    None,
    Thinking(u64),
    Text(u64),
    Tool(u64),
}

/// 中性事件 → Anthropic SSE 事件的状态机（R21–R24）。
///
/// 用法：[`start`](Self::start)（`message_start`）→ 每个上游事件 [`on_event`](Self::on_event) →
/// 上游连接结束时 [`finish`](Self::finish)；路由侧连接出错用 [`fail`](Self::fail)。
/// 结束（正常收尾或出错）之后的一切输入都被忽略。
///
/// 块的顺序（R21）：文本来一段转一段；第一个工具块打开后实时转发它的参数，其余并行的工具
/// 参数与之后到的文本先缓冲，收尾时依次开块发出。同一时刻只开一个块，`index` 连续递增。
///
/// 思考（reasoning-passback R2）：在任何文本 / 工具块之前到的推理文字开一个 `thinking` 块、来一段转一段，
/// 别的块要开时先补一个 `signature_delta` 再关它。正文或工具块已经开过之后才到的推理文字丢弃、不产出字节
/// （不能回头插到前面，也不再开第二个思考块；与 Codex 路径 `StreamConverter` 一致）。
pub struct AnthropicEmitter {
    model: String,
    message_id: String,
    input_estimate: u64,
    tools: ToolNameMap,

    started: bool,
    finished: bool,
    next_index: u64,
    open: Open,

    slots: Vec<ToolSlot>,
    live_tool: Option<i64>,
    pending_text: String,
    emitted_tool: bool,

    finish_reason: Option<FinishReason>,
    usage: Option<Usage>,
    output: TokenTally,
}

impl AnthropicEmitter {
    /// `model` 是请求里的模型名原样；`input_estimate` 是 R14 估算。
    pub fn new(model: &str, input_estimate: u64, tools: ToolNameMap) -> Self {
        Self {
            model: model.to_string(),
            message_id: format!("msg_{}", random_alnum(24)),
            input_estimate,
            tools,
            started: false,
            finished: false,
            next_index: 0,
            open: Open::None,
            slots: Vec::new(),
            live_tool: None,
            pending_text: String::new(),
            emitted_tool: false,
            finish_reason: None,
            usage: None,
            output: TokenTally::default(),
        }
    }

    /// `message_start`。只产出一次。
    pub fn start(&mut self) -> Vec<SseEvent> {
        if self.started || self.finished {
            return Vec::new();
        }
        self.started = true;
        vec![event(
            "message_start",
            json!({
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": self.input_estimate, "output_tokens": 0 },
                },
            }),
        )]
    }

    pub fn on_event(&mut self, upstream: UpstreamEvent) -> Vec<SseEvent> {
        if self.finished {
            return Vec::new();
        }
        let mut out = self.start();
        match upstream {
            UpstreamEvent::Text(text) => self.text(&text, &mut out),
            UpstreamEvent::Reasoning(text) => self.reasoning(&text, &mut out),
            UpstreamEvent::ToolStart { index, id, name } => {
                self.tool_start(index, &id, &name, &mut out)
            }
            UpstreamEvent::ToolArgs { index, delta } => self.tool_args(index, &delta, &mut out),
            UpstreamEvent::Finish(reason) => {
                self.finish_reason.get_or_insert(reason);
            }
            UpstreamEvent::Usage(usage) => self.usage = Some(usage),
            UpstreamEvent::Error(message) => {
                let overloaded = message.to_ascii_lowercase().contains("overload");
                out.extend(self.fail(&message, overloaded));
            }
            UpstreamEvent::Done => self.close(&mut out),
        }
        out
    }

    /// 上游连接结束。见过结束标记（`[DONE]` 或 `finish_reason`）就正常收尾；
    /// 否则是断流，发 `error` 且不补 `message_delta` / `message_stop`（R26）。
    pub fn finish(&mut self) -> Vec<SseEvent> {
        if self.finished {
            return Vec::new();
        }
        let mut out = self.start();
        if self.finish_reason.is_some() {
            self.close(&mut out);
        } else {
            out.extend(self.fail("the third-party stream ended before it finished", false));
        }
        out
    }

    /// 流已开始后出错（上游报错、断流、读超时）：发一个 `error` 事件后结束，不补收尾事件。
    pub fn fail(&mut self, message: &str, overloaded: bool) -> Vec<SseEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let error = if overloaded {
            AnthropicError::new(529, "overloaded_error", message)
        } else {
            AnthropicError::new(502, "api_error", message)
        };
        vec![error.to_event()]
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// `message_start` 已发出、还没结束：这段时间里路由要照看保活。
    pub fn is_streaming(&self) -> bool {
        self.started && !self.finished
    }

    fn next(&mut self) -> u64 {
        let index = self.next_index;
        self.next_index += 1;
        index
    }

    fn close_open(&mut self, out: &mut Vec<SseEvent>) {
        match self.open {
            Open::None => {}
            Open::Thinking(index) => {
                // 签名只是本工具的标记：客户端下一轮原样送回，本工具不校验（R3 带回时不看签名）
                let signature = format!("{THINKING_SIGNATURE_PREFIX}{}", random_alnum(32));
                out.push(event(
                    "content_block_delta",
                    json!({ "index": index, "delta": { "type": "signature_delta", "signature": signature } }),
                ));
                out.push(event("content_block_stop", json!({ "index": index })));
            }
            Open::Text(index) | Open::Tool(index) => {
                out.push(event("content_block_stop", json!({ "index": index })));
            }
        }
        self.open = Open::None;
    }

    fn reasoning(&mut self, text: &str, out: &mut Vec<SseEvent>) {
        if text.is_empty() {
            return;
        }
        let index = match self.open {
            Open::Thinking(index) => index,
            // 还没开过任何块（工具参数可能已在缓冲里等名字，不算开过）
            Open::None if self.next_index == 0 => {
                let index = self.next();
                // 开块带空的 signature：官方流式示例与 SDK 的 ThinkingBlock 都要求这个字段，值在收尾的 signature_delta 里给
                out.push(event(
                    "content_block_start",
                    json!({ "index": index, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
                ));
                self.open = Open::Thinking(index);
                index
            }
            // 正文或工具块已经开过：不回头插入，丢弃
            _ => return,
        };
        self.output.add_text(text);
        out.push(event(
            "content_block_delta",
            json!({ "index": index, "delta": { "type": "thinking_delta", "thinking": text } }),
        ));
    }

    fn text(&mut self, text: &str, out: &mut Vec<SseEvent>) {
        if text.is_empty() {
            return;
        }
        self.output.add_text(text);
        if self.live_tool.is_some() {
            self.pending_text.push_str(text);
            return;
        }
        let index = match self.open {
            Open::Text(index) => index,
            _ => {
                self.close_open(out);
                let index = self.next();
                out.push(text_block_start(index));
                self.open = Open::Text(index);
                index
            }
        };
        out.push(text_delta(index, text));
    }

    fn slot(&mut self, index: i64) -> &mut ToolSlot {
        if let Some(position) = self.slots.iter().position(|slot| slot.index == index) {
            return &mut self.slots[position];
        }
        self.slots.push(ToolSlot {
            index,
            id: String::new(),
            name: String::new(),
            args: String::new(),
        });
        self.slots.last_mut().expect("刚放进去")
    }

    fn tool_start(&mut self, index: i64, id: &str, name: &str, out: &mut Vec<SseEvent>) {
        let original = self.tools.original(name).to_string();
        let slot = self.slot(index);
        if !slot.name.is_empty() {
            return;
        }
        slot.id = sanitize_tool_id(id);
        slot.name = original;
        if self.live_tool.is_none() && !name.is_empty() {
            self.open_live(index, out);
        }
    }

    fn open_live(&mut self, index: i64, out: &mut Vec<SseEvent>) {
        self.close_open(out);
        let block = self.next();
        let position = self
            .slots
            .iter()
            .position(|slot| slot.index == index)
            .expect("工具块已登记");
        let slot = &mut self.slots[position];
        out.push(tool_block_start(block, &slot.id, &slot.name));
        let buffered = std::mem::take(&mut slot.args);
        if !buffered.is_empty() {
            out.push(args_delta(block, &buffered));
        }
        self.open = Open::Tool(block);
        self.live_tool = Some(index);
        self.emitted_tool = true;
    }

    fn tool_args(&mut self, index: i64, delta: &str, out: &mut Vec<SseEvent>) {
        if delta.is_empty() {
            return;
        }
        self.output.add_text(delta);
        if let (Some(live), Open::Tool(block)) = (self.live_tool, self.open) {
            if live == index {
                out.push(args_delta(block, delta));
                return;
            }
        }
        self.slot(index).args.push_str(delta);
    }

    /// 正常收尾：关当前块、依次发出缓冲的工具块与文本块、`message_delta`、`message_stop`。
    fn close(&mut self, out: &mut Vec<SseEvent>) {
        self.close_open(out);
        let slots = std::mem::take(&mut self.slots);
        for slot in slots {
            // 实时转发过的那个已关；上游始终没给名字的调用 Claude Code 执行不了，丢弃
            if Some(slot.index) == self.live_tool || slot.name.is_empty() {
                continue;
            }
            let block = self.next();
            out.push(tool_block_start(block, &slot.id, &slot.name));
            if !slot.args.is_empty() {
                out.push(args_delta(block, &slot.args));
            }
            out.push(event("content_block_stop", json!({ "index": block })));
            self.emitted_tool = true;
        }
        let pending = std::mem::take(&mut self.pending_text);
        if !pending.is_empty() {
            let block = self.next();
            out.push(text_block_start(block));
            out.push(text_delta(block, &pending));
            out.push(event("content_block_stop", json!({ "index": block })));
        }

        // R24：停止原因
        let stop_reason = match &self.finish_reason {
            Some(FinishReason::Length) => "max_tokens",
            Some(FinishReason::ContentFilter) => "refusal",
            Some(FinishReason::ToolCalls) => "tool_use",
            _ if self.emitted_tool => "tool_use",
            _ => "end_turn",
        };
        // R24：用量；上游没给就用估算
        let usage = match self.usage {
            Some(usage) => json!({
                "input_tokens": usage.input_tokens.saturating_sub(usage.cached_tokens),
                "output_tokens": usage.output_tokens,
                "cache_read_input_tokens": usage.cached_tokens,
                "cache_creation_input_tokens": 0,
            }),
            None => json!({
                "input_tokens": self.input_estimate,
                "output_tokens": self.output.tokens(),
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            }),
        };
        out.push(event(
            "message_delta",
            json!({
                "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                "usage": usage,
            }),
        ));
        out.push(event("message_stop", json!({})));
        self.finished = true;
    }
}

/// 事件名同时写进 `data.type`（Anthropic 的约定）。
fn event(name: &str, fields: Value) -> SseEvent {
    let mut data = Map::new();
    data.insert("type".into(), json!(name));
    if let Value::Object(fields) = fields {
        data.extend(fields);
    }
    SseEvent {
        name: name.to_string(),
        data: Value::Object(data),
    }
}

fn text_block_start(index: u64) -> SseEvent {
    event(
        "content_block_start",
        json!({ "index": index, "content_block": { "type": "text", "text": "" } }),
    )
}

fn text_delta(index: u64, text: &str) -> SseEvent {
    event(
        "content_block_delta",
        json!({ "index": index, "delta": { "type": "text_delta", "text": text } }),
    )
}

fn tool_block_start(index: u64, id: &str, name: &str) -> SseEvent {
    event(
        "content_block_start",
        json!({
            "index": index,
            "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
        }),
    )
}

fn args_delta(index: u64, partial: &str) -> SseEvent {
    event(
        "content_block_delta",
        json!({ "index": index, "delta": { "type": "input_json_delta", "partial_json": partial } }),
    )
}

#[derive(Debug)]
enum Block {
    Thinking {
        thinking: String,
        signature: String,
    },
    Text(String),
    Tool {
        id: String,
        name: String,
        json: String,
    },
}

/// R25：把发射器产出的事件收成一条完整的 Message（非流式请求用）。
/// 与流式同源，保证「内容与同一上游流式时拼起来的结果相同」。
#[derive(Debug, Default)]
pub struct MessageAggregator {
    id: String,
    model: String,
    blocks: Vec<Block>,
    stop_reason: Value,
    stop_sequence: Value,
    usage: Value,
    complete: bool,
    error: Option<AnthropicError>,
}

impl MessageAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, sse: &SseEvent) {
        if self.complete || self.error.is_some() {
            return;
        }
        let data = &sse.data;
        let text = |pointer: &str| data.pointer(pointer).and_then(Value::as_str).unwrap_or("");
        match sse.name.as_str() {
            "message_start" => {
                self.id = text("/message/id").to_string();
                self.model = text("/message/model").to_string();
            }
            "content_block_start" => {
                let block = match text("/content_block/type") {
                    "tool_use" => Block::Tool {
                        id: text("/content_block/id").to_string(),
                        name: text("/content_block/name").to_string(),
                        json: String::new(),
                    },
                    "thinking" => Block::Thinking {
                        thinking: String::new(),
                        signature: String::new(),
                    },
                    _ => Block::Text(String::new()),
                };
                self.blocks.push(block);
            }
            "content_block_delta" => match self.blocks.last_mut() {
                Some(Block::Thinking {
                    thinking,
                    signature,
                }) => {
                    thinking.push_str(text("/delta/thinking"));
                    signature.push_str(text("/delta/signature"));
                }
                Some(Block::Text(buffer)) => buffer.push_str(text("/delta/text")),
                Some(Block::Tool { json, .. }) => json.push_str(text("/delta/partial_json")),
                None => {}
            },
            "message_delta" => {
                self.stop_reason = data
                    .pointer("/delta/stop_reason")
                    .cloned()
                    .unwrap_or(Value::Null);
                self.stop_sequence = data
                    .pointer("/delta/stop_sequence")
                    .cloned()
                    .unwrap_or(Value::Null);
                self.usage = data.get("usage").cloned().unwrap_or(Value::Null);
            }
            "message_stop" => self.complete = true,
            "error" => {
                let message = text("/error/message");
                self.error = Some(if text("/error/type") == "overloaded_error" {
                    AnthropicError::new(529, "overloaded_error", message)
                } else {
                    AnthropicError::new(502, "api_error", message)
                });
            }
            _ => {}
        }
    }

    /// 收齐的 Message；流中出错或没收到 `message_stop` 时返回错误。
    pub fn finish(self) -> Result<Value, AnthropicError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if !self.complete {
            return Err(AnthropicError::new(
                502,
                "api_error",
                "the third-party stream ended before it finished",
            ));
        }
        let content: Vec<Value> = self
            .blocks
            .into_iter()
            .map(|block| match block {
                Block::Thinking {
                    thinking,
                    signature,
                } => json!({ "type": "thinking", "thinking": thinking, "signature": signature }),
                Block::Text(text) => json!({ "type": "text", "text": text }),
                Block::Tool { id, name, json } => {
                    // 参数被截断（如 max_tokens）而不是合法 JSON 时退回空对象，不让整条失败
                    let input = if json.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str::<Value>(&json)
                            .ok()
                            .filter(Value::is_object)
                            .unwrap_or_else(|| json!({}))
                    };
                    json!({ "type": "tool_use", "id": id, "name": name, "input": input })
                }
            })
            .collect();
        Ok(json!({
            "id": self.id,
            "type": "message",
            "role": "assistant",
            "model": self.model,
            "content": content,
            "stop_reason": self.stop_reason,
            "stop_sequence": self.stop_sequence,
            "usage": self.usage,
        }))
    }
}

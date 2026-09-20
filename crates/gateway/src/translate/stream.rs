//! 回复方向：上游的 Chat Completions 流（或非流式摘要）→ Codex 期望的 Responses 事件。

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::request::{compaction_item, nullable, ToolNames, REASONING_ID_PREFIX};

/// 发给 Codex 的一个 SSE 事件。
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub name: String,
    pub data: Value,
}

impl SseEvent {
    /// 线上格式：`event: X\ndata: {...}\n\n`。
    pub fn to_sse_string(&self) -> String {
        format!("event: {}\ndata: {}\n\n", self.name, self.data)
    }
}

#[derive(Deserialize, Clone, Copy, Default)]
struct ChatUsage {
    #[serde(default, deserialize_with = "nullable")]
    prompt_tokens: i64,
    #[serde(default, deserialize_with = "nullable")]
    completion_tokens: i64,
    #[serde(default, deserialize_with = "nullable")]
    total_tokens: i64,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Deserialize, Clone, Copy, Default)]
struct PromptTokensDetails {
    #[serde(default, deserialize_with = "nullable")]
    cached_tokens: i64,
}

#[derive(Deserialize, Clone, Copy, Default)]
struct CompletionTokensDetails {
    #[serde(default, deserialize_with = "nullable")]
    reasoning_tokens: i64,
}

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    error: Option<Value>,
    #[serde(default, deserialize_with = "nullable")]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    #[serde(default, deserialize_with = "nullable")]
    delta: ChunkDelta,
}

#[derive(Deserialize, Default)]
struct ChunkDelta {
    #[serde(default, deserialize_with = "nullable")]
    content: String,
    #[serde(default, deserialize_with = "nullable")]
    reasoning_content: String,
    #[serde(default, deserialize_with = "nullable")]
    reasoning: String,
    #[serde(default, deserialize_with = "nullable")]
    tool_calls: Vec<ChunkToolCall>,
}

#[derive(Deserialize)]
struct ChunkToolCall {
    #[serde(default, deserialize_with = "nullable")]
    index: i64,
    #[serde(default, deserialize_with = "nullable")]
    id: String,
    #[serde(default, deserialize_with = "nullable")]
    function: ChunkFunction,
}

#[derive(Deserialize, Default)]
struct ChunkFunction {
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    #[serde(default, deserialize_with = "nullable")]
    arguments: String,
}

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}

/// 增量状态机：调用方从异步字节流里读到什么就喂什么，拿到的事件立刻写给 Codex。
///
/// 用法：[`start`](Self::start) → 反复 [`feed_bytes`](Self::feed_bytes)（或按行
/// [`feed_line`](Self::feed_line)）→ 上游结束（含中途断流）时 [`finish`](Self::finish)。
/// 收到 `data: [DONE]` 或上游报错后状态机即告结束，之后的输入被忽略，`finish` 不再产出事件。
pub struct StreamConverter {
    model: String,
    tools: ToolNames,
    response_id: String,
    message_id: String,
    created_at: u64,
    sequence: u64,
    finished: bool,
    line_buffer: Vec<u8>,

    output_index: u64,
    completed: Vec<Value>,

    reasoning_id: String,
    reasoning_text: String,

    text_started: bool,
    text: String,

    calls: BTreeMap<i64, PendingCall>,
    usage: Option<ChatUsage>,
}

impl StreamConverter {
    pub fn new(model: &str, tools: ToolNames) -> Self {
        Self {
            model: model.to_string(),
            tools,
            response_id: format!("resp_sg_{}", random_id()),
            message_id: format!("msg_sg_{}", random_id()),
            created_at: unix_now(),
            sequence: 0,
            finished: false,
            line_buffer: Vec::new(),
            output_index: 0,
            completed: Vec::new(),
            reasoning_id: String::new(),
            reasoning_text: String::new(),
            text_started: false,
            text: String::new(),
            calls: BTreeMap::new(),
            usage: None,
        }
    }

    /// 开场的两个事件：`response.created` 与 `response.in_progress`。
    pub fn start(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        let response = self.response_object("in_progress", Vec::new(), None);
        self.emit(
            &mut events,
            "response.created",
            json!({ "response": response }),
        );
        let response = self.response_object("in_progress", Vec::new(), None);
        self.emit(
            &mut events,
            "response.in_progress",
            json!({ "response": response }),
        );
        events
    }

    /// 喂一段上游字节。行（以及多字节字符）可以被切在任意位置，内部按换行重新拼。
    pub fn feed_bytes(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut events = Vec::new();
        self.line_buffer.extend_from_slice(chunk);
        while let Some(end) = self.line_buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.line_buffer.drain(..=end).collect();
            events.extend(self.feed_line(&String::from_utf8_lossy(&line)));
        }
        if self.finished {
            self.line_buffer.clear();
        }
        events
    }

    /// 处理上游的一行 SSE。只认 `data:` 行；`[DONE]` 立即收尾；错误块转成 `response.failed`。
    pub fn feed_line(&mut self, line: &str) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if self.finished {
            return events;
        }
        let Some(data) = line.trim().strip_prefix("data:") else {
            return events;
        };
        let data = data.trim();
        if data == "[DONE]" {
            return self.finish();
        }
        if !data.is_empty() {
            self.chunk(&mut events, data.as_bytes());
        }
        events
    }

    /// 收尾：把已收到的内容补全成完整的事件序列并发出 `response.completed`。可重复调用。
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if self.finished {
            return events;
        }
        // 上游断流时最后一行可能没有换行符。
        if !self.line_buffer.is_empty() {
            let line = std::mem::take(&mut self.line_buffer);
            events.extend(self.feed_line(&String::from_utf8_lossy(&line)));
            if self.finished {
                return events;
            }
        }
        self.finished = true;

        let reasoning_only = self.reasoning_text.trim().to_string();
        self.finish_reasoning(&mut events);
        let has_call = self.calls.values().any(|call| !call.name.is_empty());
        if !self.text_started && !has_call && !reasoning_only.is_empty() {
            // 有的模型（实测 Kimi）偶尔把最终答案放进思考通道、正文为空。
            // 不兜底的话 Codex 里这一轮是空白。
            self.content(&mut events, &reasoning_only);
        }
        if self.text_started {
            let text = self.text.clone();
            let part =
                json!({ "type": "output_text", "text": text, "annotations": [], "logprobs": [] });
            self.emit(
                &mut events,
                "response.output_text.done",
                json!({
                    "item_id": self.message_id, "output_index": self.output_index, "content_index": 0,
                    "text": text, "logprobs": [],
                }),
            );
            self.emit(
                &mut events,
                "response.content_part.done",
                json!({
                    "item_id": self.message_id, "output_index": self.output_index, "content_index": 0,
                    "part": part,
                }),
            );
            let item = json!({
                "id": self.message_id, "type": "message", "status": "completed", "role": "assistant",
                "content": [part],
            });
            self.emit(
                &mut events,
                "response.output_item.done",
                json!({ "output_index": self.output_index, "item": item }),
            );
            self.completed.push(item);
            self.output_index += 1;
        }

        for (_, mut call) in std::mem::take(&mut self.calls) {
            if call.name.is_empty() {
                continue;
            }
            if call.arguments.trim().is_empty() {
                call.arguments = "{}".to_string();
            }
            if call.id.is_empty() {
                call.id = format!("call_sg_{}", random_id());
            }
            let item_id = format!("fc_sg_{}", random_id());
            let (namespace, name) = self.tools.resolve(&call.name);
            let mut base = Map::new();
            base.insert("id".into(), json!(item_id));
            base.insert("type".into(), json!("function_call"));
            base.insert("call_id".into(), json!(call.id));
            base.insert("name".into(), json!(name));
            if let Some(namespace) = namespace {
                base.insert("namespace".into(), json!(namespace));
            }
            let (mut in_progress, mut done) = (base.clone(), base);
            in_progress.insert("status".into(), json!("in_progress"));
            in_progress.insert("arguments".into(), json!(""));
            done.insert("status".into(), json!("completed"));
            done.insert("arguments".into(), json!(call.arguments));
            let done = Value::Object(done);
            self.emit(
                &mut events,
                "response.output_item.added",
                json!({ "output_index": self.output_index, "item": in_progress }),
            );
            self.emit(
                &mut events,
                "response.function_call_arguments.delta",
                json!({ "item_id": item_id, "output_index": self.output_index, "delta": call.arguments }),
            );
            self.emit(
                &mut events,
                "response.function_call_arguments.done",
                json!({ "item_id": item_id, "output_index": self.output_index, "arguments": call.arguments }),
            );
            self.emit(
                &mut events,
                "response.output_item.done",
                json!({ "output_index": self.output_index, "item": done }),
            );
            self.completed.push(done);
            self.output_index += 1;
        }

        let response = self.response_object(
            "completed",
            self.completed.clone(),
            Some(self.usage_object()),
        );
        self.emit(
            &mut events,
            "response.completed",
            json!({ "response": response }),
        );
        events
    }

    /// 流是否已经结束（收到 `[DONE]`、上游报错，或已调用过 `finish`）。
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    fn emit(&mut self, events: &mut Vec<SseEvent>, name: &str, fields: Value) {
        let mut data = Map::new();
        data.insert("type".into(), json!(name));
        data.insert("sequence_number".into(), json!(self.sequence));
        self.sequence += 1;
        if let Value::Object(fields) = fields {
            data.extend(fields);
        }
        events.push(SseEvent {
            name: name.to_string(),
            data: Value::Object(data),
        });
    }

    fn response_object(&self, status: &str, output: Vec<Value>, usage: Option<Value>) -> Value {
        let mut response = json!({
            "id": self.response_id, "object": "response", "created_at": self.created_at, "status": status,
            "model": self.model, "output": output, "error": null, "incomplete_details": null,
            "parallel_tool_calls": true, "tool_choice": "auto", "tools": [], "metadata": {},
        });
        if let Some(usage) = usage {
            response["usage"] = usage;
        }
        if status == "completed" {
            response["completed_at"] = json!(unix_now());
        }
        response
    }

    fn usage_object(&self) -> Value {
        let usage = self.usage.unwrap_or_default();
        let total = if usage.total_tokens == 0 {
            usage.prompt_tokens + usage.completion_tokens
        } else {
            usage.total_tokens
        };
        let cached = usage
            .prompt_tokens_details
            .unwrap_or_default()
            .cached_tokens;
        let reasoning = usage
            .completion_tokens_details
            .unwrap_or_default()
            .reasoning_tokens;
        json!({
            "input_tokens": usage.prompt_tokens, "output_tokens": usage.completion_tokens, "total_tokens": total,
            "input_tokens_details": { "cached_tokens": cached },
            "output_tokens_details": { "reasoning_tokens": reasoning },
        })
    }

    /// 处理一个上游数据块；上游报错时以 `response.failed` 结束并标记完成。
    fn chunk(&mut self, events: &mut Vec<SseEvent>, data: &[u8]) {
        let Ok(chunk) = serde_json::from_slice::<ChatChunk>(data) else {
            return; // 不是 JSON 的心跳行等，忽略
        };
        if chunk.error.is_some() {
            self.fail(events, &error_message(data));
            return;
        }
        if chunk.usage.is_some() {
            self.usage = chunk.usage;
        }
        for choice in chunk.choices {
            let delta = choice.delta;
            let thinking = delta.reasoning_content + &delta.reasoning;
            if !thinking.is_empty() {
                self.thinking(events, &thinking);
            }
            if !delta.content.is_empty() {
                self.content(events, &delta.content);
            }
            for call in delta.tool_calls {
                let pending = self.calls.entry(call.index).or_default();
                if !call.id.is_empty() {
                    pending.id = call.id;
                }
                if !call.function.name.is_empty() {
                    pending.name = call.function.name;
                }
                pending.arguments.push_str(&call.function.arguments);
            }
        }
    }

    fn thinking(&mut self, events: &mut Vec<SseEvent>, delta: &str) {
        if self.text_started {
            return; // 正文已经开始之后的思考片段不再回头插入
        }
        if self.reasoning_id.is_empty() {
            self.reasoning_id = format!("{REASONING_ID_PREFIX}{}", random_id());
            self.emit(
                events,
                "response.output_item.added",
                json!({
                    "output_index": self.output_index,
                    "item": { "id": self.reasoning_id, "type": "reasoning", "summary": [] },
                }),
            );
        }
        self.reasoning_text.push_str(delta);
        self.emit(
            events,
            "response.reasoning_summary_text.delta",
            json!({
                "item_id": self.reasoning_id, "output_index": self.output_index, "summary_index": 0,
                "delta": delta,
            }),
        );
    }

    fn finish_reasoning(&mut self, events: &mut Vec<SseEvent>) {
        if self.reasoning_id.is_empty() || self.reasoning_text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.reasoning_text);
        self.emit(
            events,
            "response.reasoning_summary_text.done",
            json!({
                "item_id": self.reasoning_id, "output_index": self.output_index, "summary_index": 0,
                "text": text,
            }),
        );
        let item = json!({
            "id": self.reasoning_id, "type": "reasoning",
            "summary": [{ "type": "summary_text", "text": text }],
        });
        self.emit(
            events,
            "response.output_item.done",
            json!({ "output_index": self.output_index, "item": item }),
        );
        self.completed.push(item);
        self.output_index += 1;
    }

    fn content(&mut self, events: &mut Vec<SseEvent>, delta: &str) {
        self.finish_reasoning(events);
        if !self.text_started {
            self.text_started = true;
            self.emit(
                events,
                "response.output_item.added",
                json!({
                    "output_index": self.output_index,
                    "item": {
                        "id": self.message_id, "type": "message", "status": "in_progress",
                        "role": "assistant", "content": [],
                    },
                }),
            );
            self.emit(
                events,
                "response.content_part.added",
                json!({
                    "item_id": self.message_id, "output_index": self.output_index, "content_index": 0,
                    "part": { "type": "output_text", "text": "", "annotations": [], "logprobs": [] },
                }),
            );
        }
        self.text.push_str(delta);
        self.emit(
            events,
            "response.output_text.delta",
            json!({
                "item_id": self.message_id, "output_index": self.output_index, "content_index": 0,
                "delta": delta, "logprobs": [],
            }),
        );
    }

    fn fail(&mut self, events: &mut Vec<SseEvent>, message: &str) {
        self.finished = true;
        let mut response = self.response_object("failed", Vec::new(), None);
        response["error"] = json!({ "code": "upstream_error", "message": message });
        self.emit(events, "response.failed", json!({ "response": response }));
    }
}

/// 一次性转换整段上游流文本，返回发给 Codex 的 SSE 文本。测试和重放用。
pub fn convert_stream(upstream_text: &str, model: &str, tools: ToolNames) -> String {
    let mut converter = StreamConverter::new(model, tools);
    let mut events = converter.start();
    events.extend(converter.feed_bytes(upstream_text.as_bytes()));
    events.extend(converter.finish());
    events.iter().map(SseEvent::to_sse_string).collect()
}

/// 把上游（非流式）的摘要回复包成 Codex 压缩协议要求的事件：恰好一个压缩条目，之后 completed；
/// 拿不到摘要时以 `response.failed` 结束。
pub fn convert_compaction(chat_json: &[u8], model: &str) -> Vec<SseEvent> {
    #[derive(Deserialize)]
    struct ChatCompletion {
        #[serde(default, deserialize_with = "nullable")]
        choices: Vec<Choice>,
        #[serde(default)]
        usage: Option<ChatUsage>,
    }
    #[derive(Deserialize)]
    struct Choice {
        #[serde(default, deserialize_with = "nullable")]
        message: Message,
    }
    #[derive(Deserialize, Default)]
    struct Message {
        #[serde(default, deserialize_with = "nullable")]
        content: String,
    }

    let mut converter = StreamConverter::new(model, ToolNames::new());
    let mut events = converter.start();
    let chat = serde_json::from_slice::<ChatCompletion>(chat_json).ok();
    let summary = chat
        .as_ref()
        .and_then(|chat| chat.choices.first())
        .map(|choice| choice.message.content.trim())
        .filter(|summary| !summary.is_empty());
    let Some(summary) = summary else {
        converter.fail(
            &mut events,
            "the third-party model returned no summary for compaction",
        );
        return events;
    };
    let item = compaction_item(summary);
    converter.usage = chat.as_ref().and_then(|chat| chat.usage);
    converter.finished = true;
    converter.emit(
        &mut events,
        "response.output_item.added",
        json!({ "output_index": 0, "item": item }),
    );
    converter.emit(
        &mut events,
        "response.output_item.done",
        json!({ "output_index": 0, "item": item }),
    );
    let response =
        converter.response_object("completed", vec![item], Some(converter.usage_object()));
    converter.emit(
        &mut events,
        "response.completed",
        json!({ "response": response }),
    );
    events
}

/// 从各种形状的上游错误体里取出给人看的文字。
/// wecode 实测有两种：`{"code":400,"error":"...","user_tip":"..."}` 和
/// `{"type":"error","error":{"message":"..."}}`。
pub fn error_message(body: &[u8]) -> String {
    #[derive(Deserialize)]
    struct ErrorBody {
        #[serde(default)]
        error: Option<Value>,
        #[serde(default, deserialize_with = "nullable")]
        message: String,
        #[serde(default, deserialize_with = "nullable")]
        detail: String,
        #[serde(default, deserialize_with = "nullable")]
        user_tip: String,
    }

    let text = String::from_utf8_lossy(body);
    let Ok(doc) = serde_json::from_slice::<ErrorBody>(body) else {
        return text.trim().chars().take(300).collect();
    };
    let nested = match &doc.error {
        Some(Value::String(message)) => message.as_str(),
        Some(other) => other.get("message").and_then(Value::as_str).unwrap_or(""),
        None => "",
    };
    let parts: Vec<&str> = [nested, &doc.message, &doc.detail, &doc.user_tip]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return text.trim().to_string();
    }
    parts.join("；")
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// 16 位十六进制的随机标识。只用标准库：`RandomState` 的种子来自操作系统随机源，
/// 再混入时间和进程内计数器，保证同一进程内不重复。
fn random_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    hasher.write_u128(nanos);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::super::request::compaction_summary;
    use super::*;
    use crate::translate::{ToolNames, REASONING_ID_PREFIX};
    use serde_json::Value;

    struct Event {
        name: String,
        data: Value,
    }

    fn run_stream(tools: ToolNames, chunks: &[&str]) -> Vec<Event> {
        let mut upstream = String::new();
        for chunk in chunks {
            upstream.push_str(&format!("data: {chunk}\n\n"));
        }
        upstream.push_str("data: [DONE]\n\n");
        parse_events(&convert_stream(&upstream, "weibo-glm-5", tools))
    }

    fn parse_events(sse: &str) -> Vec<Event> {
        let mut events = Vec::new();
        for block in sse.trim().split("\n\n") {
            let mut event = Event {
                name: String::new(),
                data: Value::Null,
            };
            for line in block.split('\n') {
                if let Some(name) = line.strip_prefix("event: ") {
                    event.name = name.to_string();
                }
                if let Some(data) = line.strip_prefix("data: ") {
                    event.data = serde_json::from_str(data)
                        .unwrap_or_else(|err| panic!("bad event data {data:?}: {err}"));
                }
            }
            assert_eq!(
                event.data["type"], event.name,
                "event {:?} has data.type {}",
                event.name, event.data["type"]
            );
            events.push(event);
        }
        events
    }

    fn render(events: &[SseEvent]) -> String {
        events.iter().map(SseEvent::to_sse_string).collect()
    }

    fn names(events: &[Event]) -> String {
        events
            .iter()
            .map(|e| e.name.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// AC2：文字回复转成 Codex 期望的事件序列（与 ollama 发给 Codex 的一致），最后带用量。
    #[test]
    fn ac2_text_stream() {
        let events = run_stream(
            ToolNames::new(),
            &[
                r#"{"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
                r#"{"id":"c1","choices":[{"index":0,"delta":{"content":"你"}}]}"#,
                r#"{"id":"c1","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}"#,
                r#"{"id":"c1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":5}}}"#,
            ],
        );
        let want = "response.created response.in_progress response.output_item.added response.content_part.added response.output_text.delta response.output_text.delta response.output_text.done response.content_part.done response.output_item.done response.completed";
        assert_eq!(names(&events), want);
        for (i, event) in events.iter().enumerate() {
            assert_eq!(
                event.data["sequence_number"], i,
                "event {i} has sequence_number {}",
                event.data["sequence_number"]
            );
        }
        let done = &events[8].data["item"];
        let text = &done["content"][0];
        assert_eq!(done["type"], "message", "final item = {done}");
        assert_eq!(done["role"], "assistant", "final item = {done}");
        assert_eq!(done["status"], "completed", "final item = {done}");
        assert_eq!(text["type"], "output_text", "final item = {done}");
        assert_eq!(text["text"], "你好", "final item = {done}");

        let response = &events[9].data["response"];
        let usage = &response["usage"];
        assert_eq!(
            response["status"], "completed",
            "completed response = {response}"
        );
        assert_eq!(
            response["model"], "weibo-glm-5",
            "completed response = {response}"
        );
        assert_eq!(usage["input_tokens"], 12, "completed response = {response}");
        assert_eq!(usage["output_tokens"], 2, "completed response = {response}");
        assert_eq!(usage["total_tokens"], 14, "completed response = {response}");
        assert_eq!(
            usage["input_tokens_details"]["cached_tokens"], 5,
            "cached tokens lost: {usage}"
        );
        assert_eq!(
            response["output"].as_array().map(Vec::len),
            Some(1),
            "output = {}",
            response["output"]
        );
    }

    /// AC5：分片到达的工具调用拼起来，命名空间还原，每个调用一个 function_call 条目。
    #[test]
    fn ac5_tool_call_stream() {
        let mut tools = ToolNames::new();
        tools.insert(
            "multi_agent_v1__spawn_agent",
            "multi_agent_v1",
            "spawn_agent",
        );
        let events = run_stream(
            tools,
            &[
                r#"{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"exec_command","arguments":""}}]}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"cmd\":"}}]}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}},{"index":1,"id":"call_b","type":"function","function":{"name":"multi_agent_v1__spawn_agent","arguments":"{}"}}]}}]}"#,
                r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let calls: Vec<&Value> = events
            .iter()
            .filter(|e| e.name == "response.output_item.done")
            .map(|e| &e.data["item"])
            .collect();
        assert_eq!(
            calls.len(),
            2,
            "function_call items = {calls:?} (events: {})",
            names(&events)
        );
        let (first, second) = (calls[0], calls[1]);
        assert_eq!(first["type"], "function_call", "first call = {first}");
        assert_eq!(first["call_id"], "call_a", "first call = {first}");
        assert_eq!(first["name"], "exec_command", "first call = {first}");
        assert_eq!(
            first["arguments"], r#"{"cmd":"ls"}"#,
            "first call = {first}"
        );
        assert_eq!(first["status"], "completed", "first call = {first}");
        assert!(
            first.get("namespace").is_none(),
            "plain tool must not carry a namespace: {first}"
        );
        assert_eq!(second["name"], "spawn_agent", "second call = {second}");
        assert_eq!(
            second["namespace"], "multi_agent_v1",
            "second call = {second}"
        );
        assert_eq!(second["call_id"], "call_b", "second call = {second}");
        assert!(
            names(&events).contains("response.function_call_arguments.done"),
            "events = {}",
            names(&events)
        );
        let output = &events.last().expect("events").data["response"]["output"];
        assert_eq!(
            output.as_array().map(Vec::len),
            Some(2),
            "final output = {output}"
        );
    }

    /// 国产模型的思考内容（reasoning_content）转成推理摘要，条目标识带本工具前缀，便于之后从官方路径的历史里剔除。
    #[test]
    fn reasoning_content_becomes_reasoning_summary() {
        let events = run_stream(
            ToolNames::new(),
            &[
                r#"{"choices":[{"index":0,"delta":{"reasoning_content":"let me "}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}"#,
            ],
        );
        let got = names(&events);
        assert!(
            got.contains("response.reasoning_summary_text.delta response.reasoning_summary_text.delta response.reasoning_summary_text.done response.output_item.done response.output_item.added"),
            "events = {got}"
        );
        let reasoning = events
            .iter()
            .filter(|e| {
                e.name == "response.output_item.done" && e.data["item"]["type"] == "reasoning"
            })
            .map(|e| &e.data["item"])
            .next_back()
            .expect("no reasoning item");
        assert!(
            reasoning["id"]
                .as_str()
                .is_some_and(|id| id.starts_with(REASONING_ID_PREFIX)),
            "reasoning item = {reasoning}"
        );
        assert_eq!(
            reasoning["summary"][0]["text"], "let me think",
            "summary = {}",
            reasoning["summary"]
        );
    }

    /// 上游中途断流或根本没给出结束标记：已经收到的内容要正常收尾，让 Codex 拿到完整的事件序列。
    #[test]
    fn stream_without_done_still_completes() {
        let upstream =
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n";
        let out = convert_stream(upstream, "m", ToolNames::new());
        let got = names(&parse_events(&out));
        assert!(
            got.ends_with("response.output_item.done response.completed"),
            "events = {got}"
        );
    }

    /// 上游在流里报错时转成 response.failed，Codex 会把消息显示给用户。
    #[test]
    fn upstream_error_chunk_becomes_failed() {
        let upstream = "data: {\"error\":{\"message\":\"quota exhausted\",\"code\":429}}\n\n";
        let out = convert_stream(upstream, "m", ToolNames::new());
        let events = parse_events(&out);
        let last = events.last().expect("events");
        assert_eq!(
            last.name, "response.failed",
            "last event = {} {}",
            last.name, last.data
        );
        assert!(
            last.data.to_string().contains("quota exhausted"),
            "last event = {} {}",
            last.name,
            last.data
        );
    }

    /// 压缩请求的回复：恰好一个压缩条目，之后 completed。
    #[test]
    fn compaction_stream() {
        let chat = br#"{"choices":[{"message":{"role":"assistant","content":"summary of everything"}}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}"#;
        let events = parse_events(&render(&convert_compaction(chat, "m")));
        assert_eq!(
            names(&events),
            "response.created response.in_progress response.output_item.added response.output_item.done response.completed"
        );
        let item = &events[3].data["item"];
        assert_eq!(item["type"], "compaction", "item = {item}");
        let summary = compaction_summary(item["encrypted_content"].as_str().expect("payload"));
        assert_eq!(
            summary.as_deref(),
            Some("summary of everything"),
            "payload does not round-trip: {item}"
        );
    }

    /// 真实观察：Kimi 的回复里有只含一个空格的片段。只含空白的片段必须原样保留。
    #[test]
    fn whitespace_only_deltas_are_preserved() {
        let events = run_stream(
            ToolNames::new(),
            &[
                r#"{"choices":[{"index":0,"delta":{"content":"agents"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":"-manager"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":" probe"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":" "}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":"42"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":"\n"},"finish_reason":"stop"}]}"#,
            ],
        );
        let done: Vec<&Event> = events
            .iter()
            .filter(|e| e.name == "response.output_text.done")
            .collect();
        assert_eq!(done.len(), 1, "events = {}", names(&events));
        assert_eq!(done[0].data["text"], "agents-manager probe 42\n");
    }

    /// 真实观察：Kimi 有时把最终答案放进思考通道、正文为空。此时 Codex 里这一轮会是空白。
    /// 兜底：没有正文也没有工具调用时，把思考内容同时作为正文给出。
    #[test]
    fn reasoning_only_reply_is_promoted_to_message() {
        let events = run_stream(
            ToolNames::new(),
            &[
                r#"{"choices":[{"index":0,"delta":{"reasoning_content":"agents-manager probe 42"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}"#,
            ],
        );
        let message = events
            .iter()
            .filter(|e| {
                e.name == "response.output_item.done" && e.data["item"]["type"] == "message"
            })
            .map(|e| &e.data["item"])
            .next_back();
        assert!(
            message.is_some_and(|m| m["content"][0]["text"] == "agents-manager probe 42"),
            "no promoted message; events = {}",
            names(&events)
        );

        // 有工具调用时不提升：思考只是调用前的推理。
        let events = run_stream(
            ToolNames::new(),
            &[
                r#"{"choices":[{"index":0,"delta":{"reasoning_content":"I will run cat"}}]}"#,
                r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        assert!(
            !events
                .iter()
                .any(|e| e.name == "response.output_item.done"
                    && e.data["item"]["type"] == "message"),
            "reasoning must not be promoted when the model called a tool"
        );
    }

    /// 压缩请求上游没给出摘要：以 response.failed 结束，不能回一个空的压缩条目。
    #[test]
    fn compaction_without_summary_fails() {
        for body in [
            &b"not json"[..],
            br#"{"choices":[]}"#,
            br#"{"choices":[{"message":{"content":"  "}}]}"#,
        ] {
            let events = parse_events(&render(&convert_compaction(body, "m")));
            assert_eq!(
                names(&events),
                "response.created response.in_progress response.failed"
            );
        }
    }

    /// 调用方按网络分片喂字节：行和多字节字符都可能被切开；[DONE] 之后立即收尾，finish 可重复调用。
    #[test]
    fn incremental_feeding_handles_split_lines_and_is_idempotent() {
        let upstream = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\r\n\r\n: keep-alive\n\ndata: [DONE]\n\n";
        let bytes = upstream.as_bytes();
        let mut converter = StreamConverter::new("m", ToolNames::new());
        let mut events = converter.start();
        for piece in bytes.chunks(7) {
            events.extend(converter.feed_bytes(piece));
        }
        assert!(converter.is_finished(), "[DONE] must close the response");
        assert!(
            converter.finish().is_empty(),
            "finish after [DONE] must not emit again"
        );
        assert!(converter.feed_line("data: {\"choices\":[]}").is_empty());
        let parsed = parse_events(&render(&events));
        let done: Vec<&Event> = parsed
            .iter()
            .filter(|e| e.name == "response.output_text.done")
            .collect();
        assert_eq!(done.len(), 1, "events = {}", names(&parsed));
        assert_eq!(done[0].data["text"], "你好");
        assert_eq!(parsed.last().expect("events").name, "response.completed");
        for (i, event) in parsed.iter().enumerate() {
            assert_eq!(event.data["sequence_number"], i);
        }
    }

    /// 网关实测的两种错误体都要取出给人看的文字。
    #[test]
    fn error_message_handles_both_gateway_shapes() {
        assert_eq!(
            error_message(
                r#"{"code":400,"error":"req_type is not supported","user_tip":"换个模型"}"#
                    .as_bytes()
            ),
            "req_type is not supported；换个模型"
        );
        assert_eq!(
            error_message(br#"{"type":"error","error":{"message":"quota exhausted"}}"#),
            "quota exhausted"
        );
        assert_eq!(
            error_message(b"  <html>bad gateway</html>\n"),
            "<html>bad gateway</html>"
        );
        assert_eq!(
            error_message("长".repeat(400).as_bytes()).chars().count(),
            300
        );
        assert_eq!(error_message(br#"{"code":500}"#), r#"{"code":500}"#);
    }
}

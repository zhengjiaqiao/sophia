//! R14：`count_tokens` 的本地估算（不联网）。
//!
//! 规则：ASCII 字符每 4 个计 1、非 ASCII 字符每个计 1、每张图片计 1600，合计后向上取整。
//! 覆盖 `system`、`messages` 的全部文字（含中途 `role: system`）、工具定义（名、说明、
//! `input_schema` 的紧凑 JSON 文本）、工具调用参数（`input` 的紧凑 JSON 文本）与工具结果。
//! 思考块按发送规则计：assistant 消息里带文字或工具调用的那条，`thinking` 文字带回给上游
//! （reasoning-passback R3），计入；`redacted_thinking`、只有思考的 assistant、user 侧的思考块不发，不计。
//! document 等换成占位的块按占位文字计。

use serde_json::{json, Value};

use super::ir::parse_root;
use super::request::{RequestError, ATTACHMENT_PLACEHOLDER};

const IMAGE_TOKENS: u64 = 1600;

/// 按 R14 规则累计字符，最后一次取整。发射器也用它估算输出。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenTally {
    ascii: u64,
    other: u64,
    images: u64,
}

impl TokenTally {
    pub fn add_text(&mut self, text: &str) {
        for c in text.chars() {
            if c.is_ascii() {
                self.ascii += 1;
            } else {
                self.other += 1;
            }
        }
    }

    pub fn add_image(&mut self) {
        self.images += 1;
    }

    pub fn tokens(&self) -> u64 {
        self.ascii.div_ceil(4) + self.other + self.images * IMAGE_TOKENS
    }

    fn add_blocks(&mut self, content: &Value) {
        match content {
            Value::String(text) => self.add_text(text),
            Value::Array(blocks) => {
                for block in blocks {
                    self.add_block(block);
                }
            }
            _ => {}
        }
    }

    /// 一条 assistant 消息里会带回给上游的思考文字：有非空文字或工具调用时，计入全部 `thinking` 块的文字
    /// （与 `ir::convert_assistant` 一致；只有思考的那条整条不发）。
    fn add_passed_back_thinking(&mut self, content: &Value) {
        let Some(blocks) = content.as_array() else {
            return;
        };
        let sent = blocks.iter().any(|block| match block_kind(block) {
            "text" => block
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty()),
            "tool_use" => true,
            _ => false,
        });
        if !sent {
            return;
        }
        for block in blocks
            .iter()
            .filter(|block| block_kind(block) == "thinking")
        {
            self.add_text(block.get("thinking").and_then(Value::as_str).unwrap_or(""));
        }
    }

    fn add_block(&mut self, block: &Value) {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => self.add_text(block.get("text").and_then(Value::as_str).unwrap_or("")),
            "image" => self.add_image(),
            "tool_use" => {
                if let Some(input) = block.get("input") {
                    self.add_text(&input.to_string());
                }
            }
            "tool_result" | "search_result" => {
                self.add_blocks(block.get("content").unwrap_or(&Value::Null));
            }
            // thinking 由 [`TokenTally::add_passed_back_thinking`] 按消息判断
            "thinking" | "redacted_thinking" | "server_tool_use" | "tool_reference" => {}
            kind if kind.ends_with("_tool_result") => {}
            _ => self.add_text(ATTACHMENT_PLACEHOLDER),
        }
    }
}

fn block_kind(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

/// 整个请求体（已解析）的估算值，按默认发送规则（思考内容带回）。缺字段不报错：`count_tokens` 请求没有 `system`。
pub fn estimate_tokens(body: &Value) -> u64 {
    estimate_split(body).0
}

/// 两个估算值：（带回思考时，不带思考时）。转换按实际发出的请求取其一：R4 降级去掉了
/// `reasoning_content`、或走 Responses 出口（不带回思考）时用后者。只遍历一遍请求。
pub(super) fn estimate_split(body: &Value) -> (u64, u64) {
    let mut thinking = TokenTally::default();
    let mut tally = TokenTally::default();
    if let Some(system) = body.get("system") {
        tally.add_blocks(system);
    }
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let content = message.get("content").unwrap_or(&Value::Null);
        tally.add_blocks(content);
        if message.get("role").and_then(Value::as_str) == Some("assistant") {
            thinking.add_passed_back_thinking(content);
        }
    }
    for tool in body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for key in ["name", "description"] {
            tally.add_text(tool.get(key).and_then(Value::as_str).unwrap_or(""));
        }
        if let Some(schema) = tool.get("input_schema") {
            tally.add_text(&schema.to_string());
        }
    }
    let with_thinking = TokenTally {
        ascii: tally.ascii + thinking.ascii,
        other: tally.other + thinking.other,
        images: tally.images,
    };
    (with_thinking.tokens(), tally.tokens())
}

/// `POST /v1/messages/count_tokens` 的响应体 `{"input_tokens": N}`。
pub fn count_tokens_response(body: &[u8]) -> Result<Vec<u8>, RequestError> {
    let root = Value::Object(parse_root(body)?);
    if !root.get("messages").is_some_and(Value::is_array) {
        return Err(RequestError::MissingMessages);
    }
    serde_json::to_vec(&json!({ "input_tokens": estimate_tokens(&root) }))
        .map_err(RequestError::Encode)
}

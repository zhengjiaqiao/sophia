//! R14：`count_tokens` 的本地估算（不联网）。
//!
//! 规则：ASCII 字符每 4 个计 1、非 ASCII 字符每个计 1、每张图片计 1600，合计后向上取整。
//! 覆盖 `system`、`messages` 的全部文字（含中途 `role: system`）、工具定义（名、说明、
//! `input_schema` 的紧凑 JSON 文本）、工具调用参数（`input` 的紧凑 JSON 文本）与工具结果。
//! 思考块不计（不会发给上游）；document 等换成占位的块按占位文字计。

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
            "thinking" | "redacted_thinking" | "server_tool_use" | "tool_reference" => {}
            kind if kind.ends_with("_tool_result") => {}
            _ => self.add_text(ATTACHMENT_PLACEHOLDER),
        }
    }
}

/// 整个请求体（已解析）的估算值。缺字段不报错：`count_tokens` 请求没有 `system`。
pub fn estimate_tokens(body: &Value) -> u64 {
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
        tally.add_blocks(message.get("content").unwrap_or(&Value::Null));
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
    tally.tokens()
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

//! Responses 与 Chat Completions 的双向转换。
//!
//! 背景：Codex 只会发 Responses 请求；不少第三方网关（实测 wecode 对国产模型返回
//! "req_type is not supported"）只接受 `/chat/completions`。本模块是纯同步逻辑，不碰网络：
//! 请求方向见 [`to_chat`] 与 [`normalize_for_native`]，回复方向见 [`StreamConverter`] 与
//! [`convert_compaction`]。
//!
//! 行为逐条移植自 agents-manager 的 `internal/translate`（已对真实 Codex 与真实网关验证过）；
//! 转换规则和发给 Codex 的事件序列参照了 github.com/ollama/ollama `openai/responses.go`
//! （MIT，提交 6383a0f）。
mod request;
mod stream;

pub use request::{
    compaction_item, normalize_for_native, to_chat, ChatRequest, ToolNames, TranslateError,
    REASONING_ID_PREFIX,
};
pub use stream::{convert_compaction, convert_stream, error_message, SseEvent, StreamConverter};

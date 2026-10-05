//! Responses 与 Chat Completions 的双向转换。
//!
//! 背景：Codex 只会发 Responses 请求；不少第三方网关（实测 wecode 对国产模型返回
//! "req_type is not supported"）只接受 `/chat/completions`。本模块是纯同步逻辑，不碰网络：
//! 请求方向见 [`to_chat`] 与 [`normalize_for_native`]，回复方向见 [`StreamConverter`] 与
//! [`convert_compaction`]。客户端要的推理强度折成 `reasoning_effort` 的规则见 [`Effort`]。
//!
//! 行为逐条移植自 agents-manager 的 `internal/translate`（已对真实 Codex 与真实网关验证过）；
//! 转换规则和发给 Codex 的事件序列的出处见仓库根 NOTICE。
//!
//! Claude Code（Anthropic Messages）→ 第三方上游的转换在子模块 [`anthropic`]。
pub mod anthropic;
mod effort;
mod request;
mod stream;

pub use effort::{
    reasoning_retry, rejects_reasoning_content, rejects_reasoning_effort, Effort, ReasoningRetry,
    REASONING_CONTENT_FIELD, REASONING_EFFORT_FIELD,
};
pub use request::{
    compaction_item, normalize_for_native, to_chat, to_chat_with, ChatOptions, ChatRequest,
    ToolNames, TranslateError, REASONING_ID_PREFIX,
};
pub use stream::{convert_compaction, convert_stream, error_message, SseEvent, StreamConverter};

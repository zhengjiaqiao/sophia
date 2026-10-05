//! Anthropic Messages ↔ 第三方上游（Chat Completions / Responses）的纯转换层。
//!
//! 给 Claude Code（以及 Claude 桌面应用的 3P 模式，它们发同样的 `/v1/messages`）接第三方模型用。
//! 纯同步、不碰网络：路由（P3）负责收发字节、计时与鉴权，这里只做形状转换。
//!
//! - 请求方向：[`to_chat`]（R16/R17/R18/R20）、[`to_responses`]（R19，**实验性**：没有真实上游样本）。
//! - 本地估算：[`estimate_tokens`] / [`count_tokens_response`]（R14）。
//! - 回程：上游 SSE → [`ChatEvents`] / [`ResponsesEvents`] 解析成中性的 [`UpstreamEvent`] →
//!   [`AnthropicEmitter`] 产出 Anthropic 流事件（R21–R24）；非流式请求用 [`MessageAggregator`]
//!   把同一串事件收成一条 Message（R25）。保活 `ping` 的判定见 [`Keepalive`]（R23）。
//! - 错误：[`map_upstream_error`] 与 [`AnthropicError`]（R26）。
//!
//! 与 spec 的差异以 P0 抓包（`docs/research/2026-09-29-claude-code-gateway-capture.md`）为准，
//! 各处注释里写明。现有 Codex 路径（`translate::{to_chat, StreamConverter}`）不受影响。
mod count;
mod emit;
mod errors;
mod events;
mod ir;
mod names;
mod request;
mod responses_request;

#[cfg(test)]
mod tests;

pub use count::{count_tokens_response, estimate_tokens, TokenTally};
pub use emit::{
    ping_event, AnthropicEmitter, Keepalive, MessageAggregator, DEFAULT_KEEPALIVE_INTERVAL,
    THINKING_SIGNATURE_PREFIX,
};
pub use errors::{
    is_context_overflow, map_upstream_error, readable_upstream_message, retry_after_seconds,
    AnthropicError, UpstreamFailure, CONTEXT_OVERFLOW_PATTERNS,
};
pub use events::{ChatEvents, FinishReason, ResponsesEvents, UpstreamEvent, Usage};
pub use names::{sanitize_tool_id, upstream_tool_name, ToolNameMap, MAX_TOOL_NAME_LEN};
pub use request::{
    rejects_thinking_off, request_model, to_chat, RequestError, StructuredOutput, ThinkingOff,
    UpstreamOptions, UpstreamRequest, ATTACHMENT_PLACEHOLDER, BILLING_BLOCK_PREFIX,
};
pub use responses_request::to_responses;

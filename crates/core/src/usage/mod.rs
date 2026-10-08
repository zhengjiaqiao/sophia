//! 用量（菜单栏与托盘显示订阅额度）的纯逻辑：窗口模型、三种来源的解析、Codex 会话记录末尾读取、
//! 刷新节奏的决策、菜单栏与托盘的文字排版、设置。无异步、无网络；起进程和调度在 `sophia-gateway`。
//!
//! 规格见 `docs/specs/2026-09-26-menubar-usage.md`，测试样本在 `testdata/`（真实回复脱敏后入库）。
pub mod connect;
pub mod format;
pub mod model;
pub mod parse;
pub mod plan;
pub mod rollout;
pub mod schedule;

pub use model::*;

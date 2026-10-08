//! sophia-core：软链接同步与 skill 矩阵的核心逻辑。无 UI、无 Tauri 依赖。
pub mod activity;
pub mod atomicfile;
pub mod claude_models;
pub mod codex_models;
pub mod copies;
pub mod diagnostics;
pub mod discovery;
pub mod file_issue;
pub mod fs;
pub mod i18n;
pub mod jsonedit;
pub mod keyhint;
pub mod keystore;
pub mod market;
pub mod mcp;
pub mod model_providers;
pub mod models;
pub mod provider_presets;
pub mod redact;
pub mod report;
pub mod skills;
pub mod store;
pub mod subscriptions;
pub mod sync;
pub mod usage;
pub mod workbuddy_models;

#[cfg(test)]
pub(crate) mod test_support;

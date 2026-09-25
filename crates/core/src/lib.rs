//! symsync-core：软链接同步与 skill 矩阵的核心逻辑。无 UI、无 Tauri 依赖。
pub mod activity;
pub mod atomicfile;
pub mod codex_models;
pub mod discovery;
pub mod fs;
pub mod mcp;
pub mod models;
pub mod outside_skills;
pub mod skills;
pub mod store;
pub mod subscriptions;
pub mod sync;

#[cfg(test)]
pub(crate) mod test_support;

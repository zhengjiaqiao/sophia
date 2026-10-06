//! sophia-gateway：Codex 模型网关。本机路由、协议转换、系统代理、launchd 常驻、密钥文件（旧版钥匙串条目的迁移）。
//! 不依赖 tauri；macOS 专属部分用 `cfg(target_os = "macos")` 门控，其余在 Linux 上可编译可测。
pub mod app;
pub mod claude_desktop;
pub mod codex_desktop;
pub mod keychain;
pub mod login_env;
pub mod process;
pub mod provider;
pub mod router;
pub mod router_host;
pub mod runtime;
pub mod service;
pub mod sysproxy;
pub mod takeover;
pub mod translate;
pub mod usage;

#[cfg(test)]
pub(crate) mod test_timing;

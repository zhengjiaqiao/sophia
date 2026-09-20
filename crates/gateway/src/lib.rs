//! symsync-gateway：Codex 模型网关。本机路由、协议转换、系统代理、launchd 常驻、钥匙串。
//! 不依赖 tauri；macOS 专属部分用 `cfg(target_os = "macos")` 门控，其余在 Linux 上可编译可测。
pub mod app;
pub mod keychain;
pub mod provider;
pub mod router;
pub mod service;
pub mod sysproxy;
pub mod takeover;
pub mod translate;

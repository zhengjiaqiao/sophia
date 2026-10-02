//! Claude 第三方模型的纯逻辑：Sophia 自己的持久化设置（`settings`）与桌面应用配置的读写（`desktop`）。
//! 这一轮只接 Claude 桌面应用；以后命令行的纯逻辑也放这里。
pub mod desktop;
pub mod settings;

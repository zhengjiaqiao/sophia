//! WorkBuddy 第三方模型的纯逻辑（spec #247「四」、#266）：Sophia 自己的持久化设置（开关）与
//! `~/.workbuddy/models.json` 的文本级改写（`models_file`）。WorkBuddy 只认 OpenAI Chat 格式，
//! 条目指向本机路由的 `/workbuddy/` 命名空间，`apiKey` 是路由自己的令牌——提供商的密钥只在 Sophia。
pub mod models_file;

use serde::{Deserialize, Serialize};

/// settings.json 里的 `workbuddyGateway`。旧文件没有这一节，读成关着
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkBuddyGatewaySettings {
    /// 用户在模型页打开了 WorkBuddy 的第三方模型。退出 Sophia 时条目拿掉、这个值不变，下次打开写回
    pub enabled: bool,
}

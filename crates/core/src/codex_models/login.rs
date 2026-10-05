//! Codex 的登录状态与接法选择（spec 2026-10-03-codex-hookup-auto R1、R2）。纯函数，无 IO。
//!
//! 只看 `auth.json` 里哪些字段**有值**，从不保留、记录、传出字段的值：结果只是一个枚举。
use super::settings::HookupMode;
use serde::Serialize;
use serde_json::Value;

/// Codex 的登录状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginState {
    /// ChatGPT 账号登录
    ChatGpt,
    /// API key 登录
    ApiKey,
    /// 没登录
    SignedOut,
    /// 说不准：登录信息可能在系统密码库里，或 `auth.json` 读不懂
    Unknown,
}

/// 为什么选了这种接法（模型页那一行说明据此取句）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModeReason {
    SignedIn,
    ApiKey,
    Unknown,
    SignedOut,
}

/// 判断登录状态（R1）。`auth_json`：`~/.codex/auth.json` 的字节，不存在为 None；
/// `credentials_store`：`config.toml` 根部的 `cli_auth_credentials_store`，没写为 None（Codex 的缺省是 `file`）
pub fn login_state(auth_json: Option<&[u8]>, credentials_store: Option<&str>) -> LoginState {
    let Some(bytes) = auth_json else {
        // 文件不在：登录信息可能存在系统密码库里（keyring / auto），说不准；否则就是没登录
        return match credentials_store.map(str::trim) {
            Some("keyring") | Some("auto") => LoginState::Unknown,
            _ => LoginState::SignedOut,
        };
    };
    // 读不懂按「说不准」；解析错误的原文里可能带文件片段，丢掉不用
    let Ok(Value::Object(auth)) = serde_json::from_slice::<Value>(bytes) else {
        return LoginState::Unknown;
    };
    if let Some(mode) = auth.get("auth_mode").and_then(Value::as_str) {
        let mode = mode.trim().to_ascii_lowercase();
        if mode == "apikey" || mode == "api_key" {
            return LoginState::ApiKey;
        }
        if mode.starts_with("chatgpt") {
            return LoginState::ChatGpt;
        }
    }
    if has_value(
        auth.get("tokens")
            .and_then(|tokens| tokens.get("access_token")),
    ) {
        return LoginState::ChatGpt;
    }
    if has_value(auth.get("OPENAI_API_KEY")) {
        return LoginState::ApiKey;
    }
    LoginState::SignedOut
}

/// 按登录状态选接法（R2）：没登录 → 独立服务商；其余（ChatGPT、API key、说不准）→ 借用内置服务商
pub fn choose_mode(login: LoginState) -> (HookupMode, ModeReason) {
    match login {
        LoginState::ChatGpt => (HookupMode::Builtin, ModeReason::SignedIn),
        LoginState::ApiKey => (HookupMode::Builtin, ModeReason::ApiKey),
        LoginState::Unknown => (HookupMode::Builtin, ModeReason::Unknown),
        LoginState::SignedOut => (HookupMode::Provider, ModeReason::SignedOut),
    }
}

/// 某个字段有没有值：非空字符串、或非空对象 / 数组、或 true / 数字
fn has_value(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
        Some(Value::Array(list)) => !list.is_empty(),
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(_)) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "eyJhbGciOiJSUzI1NiJ9.secret-token-fragment";

    fn chatgpt() -> String {
        format!(
            r#"{{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{{"id_token":"{TOKEN}","access_token":"{TOKEN}","refresh_token":"r","account_id":"a"}},"last_refresh":"2026-10-01T00:00:00Z"}}"#
        )
    }

    /// AC1：五种 `auth.json` 分别得到 ChatGPT、API key、未登录、不确定、未登录
    #[test]
    fn ac1_five_shapes_of_auth_json() {
        let api_key = r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-abc","tokens":null}"#;
        assert_eq!(
            login_state(Some(chatgpt().as_bytes()), None),
            LoginState::ChatGpt
        );
        assert_eq!(
            login_state(Some(api_key.as_bytes()), None),
            LoginState::ApiKey
        );
        assert_eq!(login_state(Some(b"{}"), None), LoginState::SignedOut);
        assert_eq!(login_state(None, Some("auto")), LoginState::Unknown);
        assert_eq!(login_state(None, Some("keyring")), LoginState::Unknown);
        assert_eq!(login_state(None, Some("file")), LoginState::SignedOut);
        // 没写 cli_auth_credentials_store：Codex 的缺省是 file
        assert_eq!(login_state(None, None), LoginState::SignedOut);
        assert_eq!(login_state(None, Some("ephemeral")), LoginState::SignedOut);
    }

    /// 没有 auth_mode 时按字段有没有值判断；auth_mode 有值时以它为准
    #[test]
    fn fields_decide_when_auth_mode_is_missing() {
        let tokens = r#"{"tokens":{"access_token":"x"}}"#;
        assert_eq!(
            login_state(Some(tokens.as_bytes()), None),
            LoginState::ChatGpt
        );
        let key = r#"{"OPENAI_API_KEY":"sk-1"}"#;
        assert_eq!(login_state(Some(key.as_bytes()), None), LoginState::ApiKey);
        let empty_token = r#"{"tokens":{"access_token":""},"OPENAI_API_KEY":null}"#;
        assert_eq!(
            login_state(Some(empty_token.as_bytes()), None),
            LoginState::SignedOut
        );
        // 旧测试夹具的形状：tokens 不是对象，没有 access_token
        let flat = r#"{"tokens":"official-secret"}"#;
        assert_eq!(
            login_state(Some(flat.as_bytes()), None),
            LoginState::SignedOut
        );
        let mode_wins = r#"{"auth_mode":"apikey","tokens":{"access_token":"x"}}"#;
        assert_eq!(
            login_state(Some(mode_wins.as_bytes()), None),
            LoginState::ApiKey
        );
        let chatgpt_tokens = r#"{"auth_mode":"chatgptAuthTokens"}"#;
        assert_eq!(
            login_state(Some(chatgpt_tokens.as_bytes()), None),
            LoginState::ChatGpt
        );
    }

    /// 读不懂的 auth.json 按「不确定」：不能因为一个坏文件就把有登录的人切走
    #[test]
    fn unparsable_auth_json_is_unknown() {
        assert_eq!(login_state(Some(b"{not json"), None), LoginState::Unknown);
        assert_eq!(login_state(Some(b"[1,2]"), None), LoginState::Unknown);
        assert_eq!(
            login_state(Some(&[0xff, 0xfe]), Some("file")),
            LoginState::Unknown
        );
    }

    /// AC2：判断结果里不出现令牌的任何片段
    #[test]
    fn ac2_result_never_carries_token_text() {
        let state = login_state(Some(chatgpt().as_bytes()), None);
        let (mode, reason) = choose_mode(state);
        let shown = format!(
            "{state:?} {mode:?} {reason:?} {}",
            serde_json::to_string(&reason).unwrap()
        );
        for fragment in ["eyJ", "secret-token", "sk-", TOKEN] {
            assert!(!shown.contains(fragment), "{shown}");
        }
    }

    /// R2：只有没登录改用独立服务商
    #[test]
    fn only_signed_out_uses_the_standalone_provider() {
        assert_eq!(
            choose_mode(LoginState::ChatGpt),
            (HookupMode::Builtin, ModeReason::SignedIn)
        );
        assert_eq!(
            choose_mode(LoginState::ApiKey),
            (HookupMode::Builtin, ModeReason::ApiKey)
        );
        assert_eq!(
            choose_mode(LoginState::Unknown),
            (HookupMode::Builtin, ModeReason::Unknown)
        );
        assert_eq!(
            choose_mode(LoginState::SignedOut),
            (HookupMode::Provider, ModeReason::SignedOut)
        );
    }

    #[test]
    fn reasons_serialize_camel_case() {
        assert_eq!(
            serde_json::to_string(&ModeReason::SignedOut).unwrap(),
            "\"signedOut\""
        );
        assert_eq!(
            serde_json::to_string(&HookupMode::Provider).unwrap(),
            "\"provider\""
        );
    }
}

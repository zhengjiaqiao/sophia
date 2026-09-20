//! 读取 agents-manager（Go 版同类工具）留下的状态，供“接管”流程迁移用。
//!
//! 本模块只读：解析它的持久化状态文件、识别 Codex 当前是否由它管理。不做任何写入或
//! 卸载动作——那些属于上层的接管流程，这里只提供纯函数。
//!
//! 两者互为“别的工具”：各自看到对方写的 `openai_base_url` / `model_catalog_json`
//! 都会拒绝覆盖。SymSync 额外能认出 agents-manager（值指向 `127.0.0.1:47318` 且目录
//! 文件名以 `agents-manager-` 开头），把“冲突”换成「接管」。
use std::fmt;
use std::fs;
use std::path::Path;

use serde::Deserialize;

use symsync_core::codex_models::config::root_string;

/// agents-manager 在钥匙串里使用的 service / account。
pub const KEYCHAIN_SERVICE: &str = "agents-manager";
pub const KEYCHAIN_ACCOUNT: &str = "wecode";

/// agents-manager 的 launchd LaunchAgent 标签。
pub const LAUNCH_AGENT_LABEL: &str = "com.agents-manager.router";

/// agents-manager 在 Codex 目录下写的文件的公共前缀（合并目录、路由清单等）。
pub const OWNED_FILE_PREFIX: &str = "agents-manager-";

/// agents-manager 启用时写入 `openai_base_url` 的值（默认端口 47318）。
pub const ROUTER_BASE_URL: &str = "http://127.0.0.1:47318/v1";

/// name 是否是 agents-manager 自己的文件（合并目录、路由清单等）。
pub fn is_owned_file_name(name: &str) -> bool {
    name.starts_with(OWNED_FILE_PREFIX)
}

/// agents-manager 持久化状态里的一个模型条目（`state.json` 的 `models[]`）。
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct StateModel {
    pub id: String,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub selected: bool,
}

/// agents-manager 的持久化状态（`~/.agents-manager/state.json`）。
/// 字段名与它的 Go 结构体 `savedState` 的 JSON 标签逐一对应。
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct State {
    pub base_url: String,
    #[serde(default)]
    pub api_base: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub models: Vec<StateModel>,
    #[serde(default)]
    pub port: u32,
    #[serde(default)]
    pub prev_model: String,
    #[serde(default)]
    pub had_prev_model: bool,
    #[serde(default)]
    pub published_slugs: Vec<String>,
    /// 对方写入时是否给原文件末行补过换行；接管后恢复要据此还原
    #[serde(default)]
    pub added_newline: bool,
}

/// 读取 agents-manager 状态文件失败的原因。
#[derive(Debug)]
pub enum StateError {
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StateError::Io(e) => write!(f, "读取 agents-manager 状态失败：{e}"),
            StateError::Json(e) => write!(f, "agents-manager 状态不是合法的 JSON：{e}"),
        }
    }
}

impl std::error::Error for StateError {}

impl From<std::io::Error> for StateError {
    fn from(e: std::io::Error) -> Self {
        StateError::Io(e)
    }
}

impl From<serde_json::Error> for StateError {
    fn from(e: serde_json::Error) -> Self {
        StateError::Json(e)
    }
}

/// 从给定的数据目录（通常是 `~/.agents-manager`）读取 agents-manager 的 `state.json`。
pub fn read_state(data_dir: &Path) -> Result<State, StateError> {
    let text = fs::read_to_string(data_dir.join("state.json"))?;
    Ok(serde_json::from_str(&text)?)
}

/// 识别出 Codex 当前由 agents-manager 管理时，携带的信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    /// 设置里 `model_catalog_json` 指向的文件名（例如 "agents-manager-models.json"）。
    pub catalog_file_name: String,
}

/// 识别 Codex 当前是否由 agents-manager 管理：根部 `openai_base_url` 等于它默认监听的
/// 地址，且 `model_catalog_json` 指向 `codex_home` 目录下一个以 `agents-manager-` 开头
/// 的文件。纯逻辑，不读取文件系统。
pub fn detect(config_text: &str, codex_home: &Path) -> Option<Detected> {
    let base_url = root_string(config_text, "openai_base_url")?;
    if base_url != ROUTER_BASE_URL {
        return None;
    }

    let catalog_path = root_string(config_text, "model_catalog_json")?;
    let catalog_path = Path::new(&catalog_path);
    let file_name = catalog_path.file_name()?.to_str()?;
    if !is_owned_file_name(file_name) {
        return None;
    }
    // 目录必须确实是 codex_home，防止误把别处同名前缀的文件当成 agents-manager 的。
    if catalog_path.parent() != Some(codex_home) {
        return None;
    }

    Some(Detected {
        catalog_file_name: file_name.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn codex_home() -> PathBuf {
        PathBuf::from("/Users/someone/.codex")
    }

    #[test]
    fn read_state_parses_known_fields() {
        let dir = tempfile::tempdir().unwrap();
        let json = r#"{
            "base_url": "https://gateway.example/openai",
            "api_base": "https://gateway.example/openai/v1",
            "protocol": "chat",
            "models": [
                {"id": "weibo/glm-5", "display_name": "GLM 5", "selected": true},
                {"id": "kimi-k3", "selected": false}
            ],
            "port": 47318,
            "prev_model": "gpt-5.6-sol",
            "had_prev_model": true,
            "published_slugs": ["weibo-glm-5", "kimi-k3"]
        }"#;
        fs::write(dir.path().join("state.json"), json).unwrap();

        let state = read_state(dir.path()).unwrap();
        assert_eq!(state.base_url, "https://gateway.example/openai");
        assert_eq!(state.api_base, "https://gateway.example/openai/v1");
        assert_eq!(state.protocol, "chat");
        assert_eq!(state.port, 47318);
        assert_eq!(state.prev_model, "gpt-5.6-sol");
        assert!(state.had_prev_model);
        assert_eq!(state.published_slugs, vec!["weibo-glm-5", "kimi-k3"]);
        assert_eq!(state.models.len(), 2);
        assert_eq!(state.models[0].id, "weibo/glm-5");
        assert_eq!(state.models[0].display_name, "GLM 5");
        assert!(state.models[0].selected);
        assert!(!state.models[1].selected);
        assert_eq!(state.models[1].display_name, "");
    }

    #[test]
    fn read_state_tolerates_missing_optional_fields() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("state.json"),
            r#"{"base_url": "https://gateway.example", "port": 47318, "models": []}"#,
        )
        .unwrap();
        let state = read_state(dir.path()).unwrap();
        assert_eq!(state.base_url, "https://gateway.example");
        assert!(state.published_slugs.is_empty());
        assert!(!state.had_prev_model);
    }

    #[test]
    fn read_state_missing_file_is_io_error() {
        let dir = tempfile::tempdir().unwrap();
        match read_state(dir.path()) {
            Err(StateError::Io(_)) => {}
            other => panic!("expected Io error, got {other:?}"),
        }
    }

    #[test]
    fn read_state_invalid_json_is_json_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("state.json"), "{not json").unwrap();
        match read_state(dir.path()) {
            Err(StateError::Json(_)) => {}
            other => panic!("expected Json error, got {other:?}"),
        }
    }

    fn config_pointing_at_agents_manager() -> String {
        format!(
            "openai_base_url = \"{}\"\nmodel_catalog_json = \"/Users/someone/.codex/agents-manager-models.json\"\n",
            ROUTER_BASE_URL
        )
    }

    #[test]
    fn detect_recognises_agents_manager() {
        let text = config_pointing_at_agents_manager();
        let detected = detect(&text, &codex_home()).expect("应当识别出 agents-manager");
        assert_eq!(detected.catalog_file_name, "agents-manager-models.json");
    }

    #[test]
    fn detect_ignores_other_base_url() {
        let text = "openai_base_url = \"http://127.0.0.1:47328/v1\"\nmodel_catalog_json = \"/Users/someone/.codex/agents-manager-models.json\"\n";
        assert_eq!(detect(text, &codex_home()), None);
    }

    #[test]
    fn detect_ignores_catalog_without_owned_prefix() {
        let text = format!(
            "openai_base_url = \"{}\"\nmodel_catalog_json = \"/Users/someone/.codex/symsync-models.json\"\n",
            ROUTER_BASE_URL
        );
        assert_eq!(detect(&text, &codex_home()), None);
    }

    #[test]
    fn detect_ignores_when_either_key_missing() {
        let only_base_url = format!("openai_base_url = \"{}\"\n", ROUTER_BASE_URL);
        assert_eq!(detect(&only_base_url, &codex_home()), None);

        let only_catalog =
            "model_catalog_json = \"/Users/someone/.codex/agents-manager-models.json\"\n";
        assert_eq!(detect(only_catalog, &codex_home()), None);
    }

    #[test]
    fn detect_ignores_keys_inside_tables() {
        let text = format!(
            "[profiles.other]\nopenai_base_url = \"{}\"\nmodel_catalog_json = \"/Users/someone/.codex/agents-manager-models.json\"\n",
            ROUTER_BASE_URL
        );
        assert_eq!(detect(&text, &codex_home()), None);
    }

    /// 目录文件名前缀相符，但目录本身不是 codex_home：防止误把别处同名前缀的文件当成
    /// agents-manager 的。
    #[test]
    fn detect_requires_catalog_directory_to_match_codex_home() {
        let text = format!(
            "openai_base_url = \"{}\"\nmodel_catalog_json = \"/elsewhere/agents-manager-models.json\"\n",
            ROUTER_BASE_URL
        );
        assert_eq!(detect(&text, &codex_home()), None);
    }

    #[test]
    fn owned_file_prefix_predicate() {
        assert!(is_owned_file_name("agents-manager-models.json"));
        assert!(is_owned_file_name("agents-manager-routing.json"));
        assert!(!is_owned_file_name("symsync-models.json"));
        assert!(!is_owned_file_name("models.json"));
    }
}

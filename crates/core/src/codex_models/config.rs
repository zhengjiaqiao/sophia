//! `~/.codex/config.toml` 里本功能拥有的两个根键：`model_catalog_json`、`openai_base_url`。
//! 只增删这两项，其余内容逐字节保留；从不写 `model_provider`。
//!
//! 为什么不用 `toml_edit` 改：实测它会把整个文件的 CRLF 改写成 LF、丢掉 BOM、给末行补换行，
//! 做不到“恢复后逐字节相同”。所以这里做文本级手术，`toml_edit` 只用来校验和读值。
//! 算法移植自 agents-manager 的 `internal/codexcfg`（同一作者的 Go 项目，已在真实环境验证）。
use std::fmt;
use toml_edit::DocumentMut;

pub const KEY_CATALOG: &str = "model_catalog_json";
pub const KEY_BASE_URL: &str = "openai_base_url";
const KEY_MODEL_PROVIDER: &str = "model_provider";
const KEY_PROFILE: &str = "profile";
const BOM: &str = "\u{feff}";

/// 本功能写入 Codex 设置的两项值
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Managed {
    pub catalog_path: String,
    pub base_url: String,
}

impl Managed {
    fn pairs(&self) -> [(&'static str, &str); 2] {
        [
            (KEY_CATALOG, self.catalog_path.as_str()),
            (KEY_BASE_URL, self.base_url.as_str()),
        ]
    }
}

/// Codex 设置里已有别的工具写入的内容，本功能拒绝覆盖
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub key: String,
    pub value: String,
}

impl fmt::Display for Conflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.key.as_str() {
            KEY_MODEL_PROVIDER => write!(
                f,
                "Codex 设置里 model_provider = \"{}\"：Codex 正在使用别的 provider（可能由 cc-switch 写入），此时官方与第三方模型无法共存。请先切回官方再启用",
                self.value
            ),
            KEY_PROFILE => write!(
                f,
                "Codex 设置里 profile = \"{}\" 且该配置档指定了 provider 或模型目录，会绕过本功能的路由。请先取消该配置档",
                self.value
            ),
            key => write!(
                f,
                "Codex 设置里已有别的工具写入的 {key} = \"{}\"，不会覆盖它。请先在对应工具里恢复",
                self.value
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// 不是合法的 TOML，未做任何改动
    Invalid(String),
    Conflict(Conflict),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Invalid(detail) => {
                write!(f, "Codex 设置不是合法的 TOML，未做任何改动：{detail}")
            }
            ConfigError::Conflict(conflict) => conflict.fmt(f),
        }
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub text: String,
    pub changed: bool,
    /// 原文件末行没有换行，插入时补了一个；移除时据此还原
    pub added_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub text: String,
    pub warnings: Vec<String>,
}

/// 对当前设置的只读判断
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inspection {
    /// 两项都存在且都等于本功能的值
    pub enabled: bool,
    /// `openai_base_url` 仍等于本功能的路由地址（不管另一项在不在）
    pub points_at_router: bool,
    /// 为什么不能启用
    pub conflict: Option<String>,
}

fn parse(text: &str) -> Result<DocumentMut, ConfigError> {
    text.trim_start_matches(BOM)
        .parse::<DocumentMut>()
        .map_err(|e| ConfigError::Invalid(e.to_string().lines().next().unwrap_or("").to_owned()))
}

fn complete(text: &str) -> bool {
    parse(text).is_ok()
}

fn display(item: &toml_edit::Item) -> String {
    match item.as_str() {
        Some(text) => text.to_owned(),
        None => item.to_string().trim().to_owned(),
    }
}

fn conflict_in(doc: &DocumentMut, managed: &Managed) -> Option<Conflict> {
    if let Some(item) = doc.get(KEY_MODEL_PROVIDER) {
        if item.as_str() != Some("openai") {
            return Some(Conflict {
                key: KEY_MODEL_PROVIDER.into(),
                value: display(item),
            });
        }
    }
    if let Some(name) = doc.get(KEY_PROFILE).and_then(|item| item.as_str()) {
        let profile = doc
            .get("profiles")
            .and_then(|profiles| profiles.get(name))
            .and_then(|profile| profile.as_table_like());
        if let Some(profile) = profile {
            if [KEY_MODEL_PROVIDER, KEY_BASE_URL, KEY_CATALOG]
                .iter()
                .any(|key| profile.contains_key(key))
            {
                return Some(Conflict {
                    key: KEY_PROFILE.into(),
                    value: name.to_owned(),
                });
            }
        }
    }
    for (key, ours) in managed.pairs() {
        if let Some(item) = doc.get(key) {
            if item.as_str() != Some(ours) {
                return Some(Conflict {
                    key: key.into(),
                    value: display(item),
                });
            }
        }
    }
    None
}

/// 判断设置当前是否已指向本功能，以及是否存在冲突
pub fn inspect(text: &str, managed: &Managed) -> Result<Inspection, ConfigError> {
    let doc = parse(text)?;
    let points_at_router =
        doc.get(KEY_BASE_URL).and_then(|item| item.as_str()) == Some(managed.base_url.as_str());
    if let Some(conflict) = conflict_in(&doc, managed) {
        return Ok(Inspection {
            enabled: false,
            points_at_router,
            conflict: Some(conflict.to_string()),
        });
    }
    let catalog_ok =
        doc.get(KEY_CATALOG).and_then(|item| item.as_str()) == Some(managed.catalog_path.as_str());
    Ok(Inspection {
        enabled: catalog_ok && points_at_router,
        points_at_router,
        conflict: None,
    })
}

/// 读取根部的字符串键
pub fn root_string(text: &str, key: &str) -> Option<String> {
    parse(text).ok()?.get(key)?.as_str().map(str::to_owned)
}

/// 写入本功能的两项。已存在且相同则不改；存在别人的值则返回冲突。
pub fn apply(text: &str, managed: &Managed) -> Result<Applied, ConfigError> {
    let doc = parse(text)?;
    if let Some(conflict) = conflict_in(&doc, managed) {
        return Err(ConfigError::Conflict(conflict));
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let insert: String = managed
        .pairs()
        .iter()
        .filter(|(key, _)| doc.get(key).is_none())
        .map(|(key, value)| format!("{key} = {}{eol}", toml_string(value)))
        .collect();
    if insert.is_empty() {
        return Ok(Applied {
            text: text.to_owned(),
            changed: false,
            added_newline: false,
        });
    }
    let (prefix, body) = split_bom(text);
    let lines = split_lines(body);
    let at = insertion_line(&lines);
    let mut before: String = lines[..at].concat();
    let after: String = lines[at..].concat();
    let added_newline = !before.is_empty() && !before.ends_with('\n');
    if added_newline {
        before.push_str(eol);
    }
    let result = format!("{prefix}{before}{insert}{after}");
    // 写后校验：两项必须能从根部读回
    let check = parse(&result)?;
    for (key, value) in managed.pairs() {
        if check.get(key).and_then(|item| item.as_str()) != Some(value) {
            return Err(ConfigError::Invalid(format!(
                "生成的设置里读不回 {key}，已放弃"
            )));
        }
    }
    Ok(Applied {
        text: result,
        changed: true,
        added_newline,
    })
}

/// 只移除仍等于本功能值的根部键；被别人改过的保留并给出警告
pub fn remove(text: &str, managed: &Managed, added_newline: bool) -> Result<Removed, ConfigError> {
    let doc = parse(text)?;
    let (prefix, body) = split_bom(text);
    let mut lines = split_lines(body);
    let mut warnings = Vec::new();
    let mut removed_at = None;
    for (key, ours) in managed.pairs() {
        let Some(item) = doc.get(key) else { continue };
        if item.as_str() != Some(ours) {
            warnings.push(format!(
                "{key} 已被改成 \"{}\"，不是本功能写入的值，保留未动",
                display(item)
            ));
            continue;
        }
        match statement_line(&lines, key, Some(ours)) {
            Some(index) => {
                lines.remove(index);
                removed_at = Some(index);
            }
            None => warnings.push(format!(
                "{key} 是本功能的值，但写法被改过，没能自动移除，请手动删除这一项"
            )),
        }
    }
    // 还原插入时补上的换行：仅当被移除的行原本是文件最后一行
    if let (true, Some(index)) = (added_newline, removed_at) {
        if index > 0 && lines[index..].concat().is_empty() {
            let last = &mut lines[index - 1];
            if last.ends_with('\n') {
                last.pop();
                if last.ends_with('\r') {
                    last.pop();
                }
            }
        }
    }
    let result = format!("{prefix}{}", lines.concat());
    parse(&result)?;
    Ok(Removed {
        text: result,
        warnings,
    })
}

/// 把根部已有的单行字符串键改成新值；`None` 表示删掉这一行。键不存在或写法不是单行时返回 `None`。
pub fn replace_root_string(text: &str, key: &str, new_value: Option<&str>) -> Option<String> {
    root_string(text, key)?;
    let (prefix, body) = split_bom(text);
    let mut lines = split_lines(body);
    let index = statement_line(&lines, key, None)?;
    match new_value {
        None => {
            lines.remove(index);
        }
        Some(value) => {
            let eol = if lines[index].ends_with("\r\n") {
                "\r\n"
            } else if lines[index].ends_with('\n') {
                "\n"
            } else {
                ""
            };
            lines[index] = format!("{key} = {}{eol}", toml_string(value));
        }
    }
    let result = format!("{prefix}{}", lines.concat());
    complete(&result).then_some(result)
}

fn split_bom(text: &str) -> (&str, &str) {
    match text.strip_prefix(BOM) {
        Some(body) => (BOM, body),
        None => ("", text),
    }
}

/// 按行切分并保留行尾
fn split_lines(text: &str) -> Vec<String> {
    text.split_inclusive('\n').map(str::to_owned).collect()
}

/// 第一个表头所在的行号；没有表头则为行数。
/// 行首是 `[` 还不够：多行数组的续行也可能以 `[` 开头，所以要求它之前的内容自成完整的 TOML。
fn root_end_line(lines: &[String]) -> usize {
    (0..lines.len())
        .find(|&i| lines[i].trim_start().starts_with('[') && complete(&lines[..i].concat()))
        .unwrap_or(lines.len())
}

/// 插入位置：根部最后一个赋值语句结束之后，这样表头上方的空行和注释仍贴着表头。
fn insertion_line(lines: &[String]) -> usize {
    let root_end = root_end_line(lines);
    for i in (0..root_end).rev() {
        let trimmed = lines[i].trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // 到这一行为止必须是完整的 TOML，否则它可能只是多行字符串里一行以 # 开头的文字
        return if complete(&lines[..=i].concat()) {
            i + 1
        } else {
            root_end
        };
    }
    0
}

/// 根部里“语句开头”且单行赋值给 `key` 的那一行。`value` 给定时还要求值相等。
/// 只认它之前的内容自成完整 TOML 的行，多行字符串里长得一样的文字不算。
fn statement_line(lines: &[String], key: &str, value: Option<&str>) -> Option<usize> {
    (0..root_end_line(lines)).find(|&i| {
        let line = lines[i].trim_end_matches(['\r', '\n']);
        let Ok(doc) = format!("{line}\n").parse::<DocumentMut>() else {
            return false;
        };
        let single = doc.as_table().len() == 1;
        let matches = match (doc.get(key).and_then(|item| item.as_str()), value) {
            (Some(actual), Some(expected)) => actual == expected,
            (Some(_), None) => true,
            _ => false,
        };
        single && matches && complete(&lines[..i].concat())
    })
}

/// TOML 基本字符串（单行，控制字符一律转义）。MCP 往 TOML 追加服务也用它
pub(crate) fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04X}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed() -> Managed {
        Managed {
            catalog_path: "/Users/someone/.codex/symsync-models.json".into(),
            base_url: "http://127.0.0.1:47328/v1".into(),
        }
    }

    const OUR_LINES: &str = "model_catalog_json = \"/Users/someone/.codex/symsync-models.json\"\nopenai_base_url = \"http://127.0.0.1:47328/v1\"\n";

    /// 结构仿照真实的 Codex 设置：根部键（含多行数组）、空表、嵌套表、带引号的表名
    const REALISTIC: &str = r#"notify = ["/Users/someone/.codex/computer-use/Client", "turn-ended"]
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[mcp_servers]

[mcp_servers.node_repl]
args = []
command = "/Applications/ChatGPT.app/Contents/Resources/node_repl"
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_TRUSTED_SERVICES = '{"browser":"/Users/someone/x.mjs","sky":"@oai/sky/service"}'

[desktop]
followUpQueueMode = "queue"

[plugins."browser@openai-bundled"]
enabled = true

[hooks.state."/Users/someone/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:cd32"

[projects."/Users/someone/Documents/New project"]
trust_level = "trusted"
"#;

    fn root_str(text: &str, key: &str) -> Option<String> {
        let doc: toml_edit::DocumentMut = text.trim_start_matches('\u{feff}').parse().ok()?;
        doc.get(key)?.as_str().map(str::to_owned)
    }

    /// AC18：启用只多出本功能的两行，其余逐字节相同
    #[test]
    fn ac18_realistic_config_gains_exactly_two_lines() {
        let applied = apply(REALISTIC, &managed()).unwrap();
        assert!(applied.changed);
        let idx = applied.text.find(OUR_LINES).expect("两行应当相邻");
        let without = format!(
            "{}{}",
            &applied.text[..idx],
            &applied.text[idx + OUR_LINES.len()..]
        );
        assert_eq!(without, REALISTIC);
        assert!(
            idx < applied.text.find("\n[").unwrap(),
            "必须插在第一个表头之前"
        );
        assert_eq!(
            root_str(&applied.text, KEY_CATALOG).as_deref(),
            Some(managed().catalog_path.as_str())
        );
        assert_eq!(
            root_str(&applied.text, KEY_BASE_URL).as_deref(),
            Some(managed().base_url.as_str())
        );
        assert!(root_str(&applied.text, "model_provider").is_none());
    }

    /// AC20：移除后与启用前逐字节相同
    #[test]
    fn ac20_remove_restores_original_bytes() {
        let cases: &[(&str, &str)] = &[
            ("realistic", REALISTIC),
            ("empty", ""),
            ("only tables", "[mcp_servers]\n\n[mcp_servers.x]\ncommand = \"y\"\n"),
            ("no trailing newline", "model = \"gpt\""),
            ("root then eof", "model = \"gpt\"\n"),
            ("crlf", "model = \"gpt\"\r\n\r\n[desktop]\r\nmode = \"x\"\r\n"),
            (
                "multiline array",
                "notify = [\n  \"a\",\n  \"b\",\n]\nmodel = \"gpt\"\n\n# comment for table\n[desktop]\nx = 1\n",
            ),
            (
                "nested array looks like header",
                "matrix = [\n[1, 2],\n[3, 4],\n]\n\n[desktop]\nx = 1\n",
            ),
            ("comment only root", "# my notes\n\n[desktop]\nx = 1\n"),
            (
                "multiline string ending with hash line",
                "notes = \"\"\"\nline\n# looks like a comment\"\"\"\n\n[desktop]\nx = 1\n",
            ),
            ("bom", "\u{feff}model = \"gpt\"\n\n[desktop]\nx = 1\n"),
            ("bom then table", "\u{feff}[desktop]\nx = 1\n"),
        ];
        for (name, original) in cases {
            let applied = apply(original, &managed()).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                root_str(&applied.text, KEY_BASE_URL).as_deref(),
                Some(managed().base_url.as_str()),
                "{name}: 键应当在根部\n{}",
                applied.text
            );
            let removed = remove(&applied.text, &managed(), applied.added_newline)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(
                removed.warnings.is_empty(),
                "{name}: {:?}",
                removed.warnings
            );
            assert_eq!(&removed.text, original, "{name}");
        }
    }

    #[test]
    fn crlf_file_gets_crlf_lines() {
        let applied = apply(
            "model = \"gpt\"\r\n\r\n[desktop]\r\nmode = \"x\"\r\n",
            &managed(),
        )
        .unwrap();
        assert!(
            !applied.text.replace("\r\n", "").contains('\n'),
            "{:?}",
            applied.text
        );
    }

    #[test]
    fn apply_is_idempotent() {
        let first = apply("model = \"gpt\"\n\n[desktop]\nx = 1\n", &managed()).unwrap();
        let second = apply(&first.text, &managed()).unwrap();
        assert!(!second.changed);
        assert_eq!(second.text, first.text);
    }

    /// AC19：别的工具写入的同名键、非官方 provider、指定了 provider 或目录的配置档 → 拒绝并说明来源
    #[test]
    fn ac19_conflicts_are_refused() {
        let cases = [
            (
                "openai_base_url = \"http://127.0.0.1:11434/api/codex/v1\"\n",
                "openai_base_url",
            ),
            (
                "model_catalog_json = \"/Users/x/.codex/ollama-launch-models.json\"\n",
                "model_catalog_json",
            ),
            (
                "model_provider = \"custom\"\n\n[model_providers.custom]\nname = \"custom\"\n",
                "model_provider",
            ),
            (
                "profile = \"p\"\n\n[profiles.p]\nmodel_provider = \"ollama\"\n",
                "profile",
            ),
            (
                "profile = \"p\"\n\n[profiles.p]\nmodel_catalog_json = \"/other.json\"\n",
                "profile",
            ),
        ];
        for (text, key) in cases {
            match apply(text, &managed()) {
                Err(ConfigError::Conflict(conflict)) => {
                    assert_eq!(conflict.key, key);
                    assert!(conflict.to_string().contains(key));
                }
                other => panic!("{key}: {other:?}"),
            }
        }
        assert!(apply("model_provider = \"openai\"\n", &managed()).is_ok());
    }

    #[test]
    fn invalid_toml_is_rejected_before_any_change() {
        assert!(matches!(
            apply("model = \n[broken", &managed()),
            Err(ConfigError::Invalid(_))
        ));
        assert!(remove("model = \n[broken", &managed(), false).is_err());
    }

    /// 恢复只移除仍等于本功能值的键；被别人改过的保留并警告
    #[test]
    fn remove_leaves_foreign_values_alone() {
        let text = format!(
            "model = \"gpt\"\nmodel_catalog_json = \"{}\"\nopenai_base_url = \"http://127.0.0.1:11434/api/codex/v1\"\n\n[desktop]\nx = 1\n",
            managed().catalog_path
        );
        let removed = remove(&text, &managed(), false).unwrap();
        assert!(!removed.text.contains("model_catalog_json"));
        assert!(removed.text.contains("11434"));
        assert_eq!(removed.warnings.len(), 1);
        assert!(removed.warnings[0].contains("openai_base_url"));
    }

    /// 多行字符串里恰好有与本功能逐字相同的行，不能被当成键删掉
    #[test]
    fn remove_ignores_identical_lines_inside_multiline_strings() {
        let original = format!(
            "notes = \"\"\"\nopenai_base_url = \"{}\"\nmodel_catalog_json = \"{}\"\n\"\"\"\nmodel = \"gpt\"\n\n[desktop]\nx = 1\n",
            managed().base_url,
            managed().catalog_path
        );
        let applied = apply(&original, &managed()).unwrap();
        let removed = remove(&applied.text, &managed(), applied.added_newline).unwrap();
        assert_eq!(removed.text, original);
        assert!(!inspect(&removed.text, &managed()).unwrap().enabled);
    }

    /// 值相同但被改成跨行写法：移不掉时必须明说
    #[test]
    fn remove_reports_when_our_key_cannot_be_removed() {
        let text = format!(
            "openai_base_url = \"\"\"\n{}\"\"\"\nmodel = \"gpt\"\n",
            managed().base_url
        );
        let removed = remove(&text, &managed(), false).unwrap();
        assert!(!removed.warnings.is_empty());
        assert!(inspect(&removed.text, &managed()).unwrap().points_at_router);
    }

    #[test]
    fn keys_inside_tables_are_ignored() {
        let text =
            "model = \"gpt\"\n\n[profiles.other]\nopenai_base_url = \"http://elsewhere/v1\"\n";
        let applied = apply(text, &managed()).unwrap();
        let removed = remove(&applied.text, &managed(), applied.added_newline).unwrap();
        assert_eq!(removed.text, text);
    }

    #[test]
    fn inspect_reports_state() {
        let plain = "model = \"gpt\"\n";
        let state = inspect(plain, &managed()).unwrap();
        assert!(!state.enabled && state.conflict.is_none());
        assert!(
            inspect(&apply(plain, &managed()).unwrap().text, &managed())
                .unwrap()
                .enabled
        );
        let conflict = inspect("model_provider = \"custom\"\n", &managed()).unwrap();
        assert!(!conflict.enabled && conflict.conflict.unwrap().contains("model_provider"));
        let partial = inspect(
            &format!(
                "openai_base_url = \"{}\"\nmodel_catalog_json = \"/other.json\"\n",
                managed().base_url
            ),
            &managed(),
        )
        .unwrap();
        assert!(!partial.enabled && partial.conflict.is_some() && partial.points_at_router);
    }

    /// Codex 会把选中的模型写回根部 model；恢复时要能改回原值或删掉，别处同名文字不动
    #[test]
    fn replace_root_string_only_touches_the_root_statement() {
        let text = "notes = \"\"\"\nmodel = \"trap\"\n\"\"\"\nmodel = \"weibo-glm-5\"\r\nother = 1\n\n[profiles.p]\nmodel = \"inner\"\n";
        let replaced = replace_root_string(text, "model", Some("gpt-5.6-sol")).unwrap();
        assert_eq!(
            replaced,
            text.replacen(
                "model = \"weibo-glm-5\"\r\n",
                "model = \"gpt-5.6-sol\"\r\n",
                1
            )
        );
        let removed = replace_root_string(text, "model", None).unwrap();
        assert!(!removed.contains("weibo-glm-5"));
        assert!(removed.contains("model = \"trap\"") && removed.contains("model = \"inner\""));
        assert!(replace_root_string("other = 1\n", "model", Some("x")).is_none());
        assert_eq!(root_string(text, "model").as_deref(), Some("weibo-glm-5"));
    }
}

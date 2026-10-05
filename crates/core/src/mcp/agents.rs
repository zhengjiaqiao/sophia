//! 支持 MCP 的 agent 表（DESIGN「MCP 支持哪些 agent」，spec 2026-09-27-mcp-batch1 设计 1、2）：
//! 每家一条——用户级配置文件（含环境变量覆盖、平台限制）、项目级相对路径（可无）、格式（读写的写法）、
//! 认得的传输。位置发现（`discover_locations`）、读（`parse`）、写（`merge`）、能不能写过去
//! （`Canonical::refusal_for`）都按这张表走，不再按 agent 写死 `match`。
//!
//! JSON 各家的差别只在「一条服务怎么写」：根都是 `mcpServers`，插入、删除共用 `mcp.rs` 的文本级
//! 手术（只切入、切掉那一个成员，其余字节原样）。各家专属的字段（Gemini 的 `trust`、Copilot 的
//! 非全部 `tools`）以原样 JSON 文本放进 `Canonical::client_fields`：同一家之间复制原样写回，
//! 跨家拒绝并说原因（无损原则，docs/research/2026-09-11-mcp-config-compatibility.md）。
use super::{
    agent_name, has_duplicate_header_names, json_args, json_map, json_string, reference, refused,
    unsupported_with, Canonical, McpLocation, McpReasonKind,
};
use crate::discovery::Env;
use crate::fs::EntryKind;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;

/// 一条服务在配置文件里的写法
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Dialect {
    /// Codex 的 `config.toml`（`[mcp_servers.<名>]`）
    Toml,
    /// Claude Code：`type` + stdio / http / sse，另认 `headersHelper`
    Claude,
    /// Cursor 与表外的 JSON 位置：`type` + stdio / http（与升级前的通用 JSON 读写一致）
    Cursor,
    /// Gemini CLI：没有 `type`；stdio `command`，Streamable HTTP `httpUrl`，SSE `url`
    Gemini,
    /// GitHub Copilot CLI：`type: local|stdio|http|sse`，另有 `tools`
    Copilot,
    /// Claude Desktop：只有 stdio 的 `command` / `args` / `env`
    Desktop,
}

/// 表里的一家
pub(super) struct Agent {
    pub(super) id: &'static str,
    pub(super) dialect: Dialect,
    /// 用户级配置文件；这个平台上没有时为 None
    user: fn(&Env) -> Option<PathBuf>,
    /// 项目级配置文件（相对项目根）；没有项目级为 None
    pub(super) project: Option<&'static str>,
    /// 这家认得的传输
    transports: &'static [&'static str],
}

impl Agent {
    pub(super) fn user_path(&self, env: &Env) -> Option<PathBuf> {
        (self.user)(env)
    }

    /// 用户级位置写入时要跟着写的附属文件（`McpLocation::mirrors`）：只有 Claude Desktop 有（第三方模式那一份）
    pub(super) fn user_mirrors(&self, env: &Env) -> Vec<PathBuf> {
        if self.id == "claude-desktop" {
            desktop_mirrors(env)
        } else {
            Vec::new()
        }
    }
}

/// 环境变量的值（去掉首尾空白后非空才算设置了）
fn var(env: &Env, name: &str) -> Option<PathBuf> {
    env.vars
        .get(name)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn claude_user(env: &Env) -> Option<PathBuf> {
    Some(env.home.join(".claude.json"))
}

/// `$CODEX_HOME/config.toml`，未设置时 `~/.codex/config.toml`
fn codex_user(env: &Env) -> Option<PathBuf> {
    Some(
        var(env, "CODEX_HOME")
            .unwrap_or_else(|| env.home.join(".codex"))
            .join("config.toml"),
    )
}

fn cursor_user(env: &Env) -> Option<PathBuf> {
    Some(env.home.join(".cursor/mcp.json"))
}

/// `$GEMINI_CLI_HOME/.gemini/settings.json`，未设置时 `~/.gemini/settings.json`
/// （`GEMINI_CLI_HOME` 换的是主目录，CLI 在它下面建 `.gemini`）
fn gemini_user(env: &Env) -> Option<PathBuf> {
    Some(
        var(env, "GEMINI_CLI_HOME")
            .unwrap_or_else(|| env.home.clone())
            .join(".gemini/settings.json"),
    )
}

/// `$COPILOT_HOME/mcp-config.json`，未设置时 `~/.copilot/mcp-config.json`
fn copilot_user(env: &Env) -> Option<PathBuf> {
    Some(
        var(env, "COPILOT_HOME")
            .unwrap_or_else(|| env.home.join(".copilot"))
            .join("mcp-config.json"),
    )
}

/// macOS `~/Library/Application Support/Claude/claude_desktop_config.json`；
/// Windows `%APPDATA%\Claude\claude_desktop_config.json`；其余平台没有（官方只发 macOS / Windows）
fn desktop_user(env: &Env) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(
            env.home
                .join("Library/Application Support/Claude/claude_desktop_config.json"),
        )
    } else if cfg!(target_os = "windows") {
        var(env, "APPDATA").map(|dir| dir.join("Claude").join("claude_desktop_config.json"))
    } else {
        None
    }
}

/// 第三方模式下 Claude 桌面应用读的那一份（spec 2026-10-05-mcp-claude-3p R1）：macOS 上
/// `~/Library/Application Support/Claude-3p/` 本身是目录（`symlink_metadata`，软链接不算）时，
/// 它下面的 `claude_desktop_config.json`；目录不存在（从没切过第三方模式）就没有。Windows 没有第三方模式
fn desktop_mirrors(env: &Env) -> Vec<PathBuf> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let dir = env.home.join("Library/Application Support/Claude-3p");
    match crate::fs::entry_kind(&dir) {
        EntryKind::Dir => vec![dir.join("claude_desktop_config.json")],
        _ => Vec::new(),
    }
}

const STDIO_HTTP: &[&str] = &["stdio", "http"];
const ALL: &[&str] = &["stdio", "http", "sse"];

/// 表的先后就是设置里「MCP 的列」的先后，也是升级时按已安装补齐的先后
pub(super) const AGENTS: [Agent; 6] = [
    Agent {
        id: "claude-code",
        dialect: Dialect::Claude,
        user: claude_user,
        project: Some(".mcp.json"),
        transports: ALL,
    },
    Agent {
        id: "codex",
        dialect: Dialect::Toml,
        user: codex_user,
        project: Some(".codex/config.toml"),
        transports: STDIO_HTTP,
    },
    Agent {
        id: "cursor",
        dialect: Dialect::Cursor,
        user: cursor_user,
        project: Some(".cursor/mcp.json"),
        transports: STDIO_HTTP,
    },
    Agent {
        id: "gemini-cli",
        dialect: Dialect::Gemini,
        user: gemini_user,
        project: Some(".gemini/settings.json"),
        transports: ALL,
    },
    Agent {
        id: "claude-desktop",
        dialect: Dialect::Desktop,
        user: desktop_user,
        project: None,
        transports: &["stdio"],
    },
    Agent {
        id: "github-copilot",
        dialect: Dialect::Copilot,
        user: copilot_user,
        // Copilot 也读项目的 `.mcp.json`（Claude Code 那一份），那一格归 Claude Code；这里只认它自己的
        project: Some(".github/mcp.json"),
        transports: ALL,
    },
];

pub(super) fn agent(harness_id: &str) -> Option<&'static Agent> {
    AGENTS.iter().find(|agent| agent.id == harness_id)
}

/// 这个位置的写法：TOML 按扩展名（与升级前一致），JSON 按 agent；表外的 JSON 位置按通用写法
pub(super) fn dialect_of(location: &McpLocation) -> Dialect {
    if super::toml(&location.path) {
        return Dialect::Toml;
    }
    match agent(&location.harness_id) {
        Some(agent) if agent.dialect != Dialect::Toml => agent.dialect,
        _ => Dialect::Cursor,
    }
}

/// 这家认得的传输；表外的（WeiboAP、测试里的位置）按升级前的 stdio / http
fn transports(harness_id: &str) -> &'static [&'static str] {
    agent(harness_id).map_or(STDIO_HTTP, |agent| agent.transports)
}

// ===== 拒绝的原因（DESIGN「MCP 支持哪些 agent › 写不过去的」）=====

pub(super) fn desktop_remote() -> String {
    crate::t!("mcp.reason.desktopRemote", agent = "Claude Desktop")
}
pub(super) fn desktop_variables() -> String {
    crate::t!("mcp.reason.desktopVariables", agent = "Claude Desktop")
}
pub(super) fn gemini_variables() -> String {
    crate::t!("mcp.reason.geminiVariables", agent = "Gemini CLI")
}

/// 值里有没有环境变量引用：`${…}`，或 `$` 后接变量名（`$HOME`）
pub(super) fn loose_reference(value: &str) -> bool {
    let bytes = value.as_bytes();
    reference(value)
        || bytes
            .windows(2)
            .any(|pair| pair[0] == b'$' && (pair[1].is_ascii_alphabetic() || pair[1] == b'_'))
}

impl Canonical {
    /// 连接字段的值里有没有一个满足 `test`
    fn any_value(&self, test: fn(&str) -> bool) -> bool {
        self.command.as_deref().is_some_and(test)
            || self.url.as_deref().is_some_and(test)
            || self.args.iter().any(|v| test(v))
            || self.env.values().any(|v| test(v))
            || self.headers.values().any(|v| test(v))
    }

    /// 值里有没有环境变量引用（宽口径，`$VAR` 也算）
    fn has_loose_reference(&self) -> bool {
        self.any_value(loose_reference)
    }

    /// 在 `source_harness` 那一家算变量引用的值：Gemini 会展开 `$VAR`，宽口径；别家只认 `${…}`
    fn has_reference_in(&self, source_harness: &str) -> bool {
        if source_harness == "gemini-cli" {
            self.has_loose_reference()
        } else {
            self.any_value(reference)
        }
    }

    /// 写进 Claude Desktop 一定不成的原因：远程服务器、值里有变量引用。
    /// 这两条与来源能不能无损搬无关，原因比「来源条目无法无损转换」更具体，先说
    pub(super) fn desktop_refusal(&self, target_harness: &str) -> Option<(McpReasonKind, String)> {
        if target_harness != "claude-desktop" || self.transport == "unsupported" {
            return None;
        }
        if self.transport != "stdio" {
            Some((McpReasonKind::DesktopRemote, desktop_remote()))
        } else if self.has_loose_reference() {
            Some((McpReasonKind::DesktopVariables, desktop_variables()))
        } else {
            None
        }
    }

    /// 这份定义（来自 `source_harness` 那一家的 `source_name`）无法写进 `target_harness` 的原因；
    /// 与目标里已有什么无关，只看目标那一家认不认得这种写法
    pub(super) fn refusal(
        &self,
        source_harness: &str,
        source_name: &str,
        target_harness: &str,
        target_name: &str,
    ) -> Option<String> {
        self.refusal_kind(source_harness, source_name, target_harness, target_name)
            .map(|(_, reason)| reason)
    }

    /// 同 `refusal`，另带原因的种类（格上给前端按种类判断）
    pub(super) fn refusal_kind(
        &self,
        source_harness: &str,
        source_name: &str,
        target_harness: &str,
        target_name: &str,
    ) -> Option<(McpReasonKind, String)> {
        use McpReasonKind as K;
        if let Some(refusal) = self.desktop_refusal(target_harness) {
            return Some(refusal);
        }
        if self.headers_helper.is_some() && !super::HELPER_HARNESSES.contains(&target_harness) {
            return Some((
                K::HeadersHelper,
                crate::t!("mcp.reason.noHeadersHelper", target = target_name),
            ));
        }
        // Gemini 会展开 `$VAR`：别家当字面值的 `$HOME` 写过去意思就变了
        if target_harness == "gemini-cli"
            && source_harness != "gemini-cli"
            && self.has_loose_reference()
        {
            return Some((K::GeminiVariables, gemini_variables()));
        }
        // 值里带 `${…}`：同一家之间原样复制（2026-09-27 改定）；跨家仍拒绝，等各家的展开规则核实
        if source_harness != target_harness && self.has_reference_in(source_harness) {
            return Some((
                K::CrossAgentVariables,
                crate::t!("mcp.reason.crossAgentVariables", source = source_name),
            ));
        }
        if self.transport == "sse" && !transports(target_harness).contains(&"sse") {
            return Some((
                K::SseUnsupported,
                crate::t!("mcp.reason.sseUnsupported", target = target_name),
            ));
        }
        if source_harness != target_harness && !self.client_fields.is_empty() {
            let keys: Vec<&str> = self.client_fields.keys().map(String::as_str).collect();
            if source_harness == "codex" {
                return Some((
                    K::CodexClientFields,
                    crate::t!(
                        "mcp.reason.codexClientFields",
                        agent = "Codex",
                        fields = crate::i18n::list_text(&keys, crate::i18n::ListStyle::Enum)
                    ),
                ));
            }
            let fields = match keys.as_slice() {
                [one] => (*one).to_string(),
                [first, ..] => crate::tn!("mcp.fields.andMore", keys.len(), first = first),
                [] => unreachable!(),
            };
            return Some((
                K::ClientFields,
                crate::t!(
                    "mcp.reason.clientFields",
                    source = source_name,
                    fields = fields,
                    target = target_name
                ),
            ));
        }
        None
    }

    pub(super) fn refusal_for(&self, source: &McpLocation, target: &McpLocation) -> Option<String> {
        self.refusal_for_kind(source, target)
            .map(|(_, reason)| reason)
    }

    pub(super) fn refusal_for_kind(
        &self,
        source: &McpLocation,
        target: &McpLocation,
    ) -> Option<(McpReasonKind, String)> {
        self.refusal_kind(
            &source.harness_id,
            agent_name(source),
            &target.harness_id,
            agent_name(target),
        )
    }

    /// 接得住它的 agent（表里的先后）；谁都接得住、或本来就哪儿都搬不过去时为 None
    pub(super) fn accepting(&self, source: &McpLocation) -> Option<Vec<String>> {
        if self.unsupported {
            return None;
        }
        let ids: Vec<String> = AGENTS
            .iter()
            .filter(|agent| {
                self.refusal(&source.harness_id, agent_name(source), agent.id, agent.id)
                    .is_none()
            })
            .map(|agent| agent.id.to_string())
            .collect();
        (ids.len() < AGENTS.len()).then_some(ids)
    }
}

// ===== 读 =====

/// 读条目时一路记下的「搬不过去」：第一条原因为准
#[derive(Default)]
struct Verdict {
    bad: bool,
    reason: Option<String>,
    /// `reason` 是「不支持迁移字段 X」时的 X（`Canonical::unknown_field`）
    unknown: Option<String>,
}

impl Verdict {
    fn refuse(&mut self, reason: impl Into<String>) {
        self.bad = true;
        if self.reason.is_none() {
            self.reason = Some(reason.into());
        }
    }
}

/// 共同的收尾：字段类型、传输与字段搭配、空值、请求头重名。变量引用不在这里判：
/// 同一家之间原样复制，跨家由 `Canonical::refusal` 按来源那一家的展开规则拒绝
#[allow(clippy::too_many_arguments)]
fn finish(
    object: &Map<String, Value>,
    mut verdict: Verdict,
    transport: &str,
    command: Option<String>,
    url: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
    client_fields: BTreeMap<String, String>,
) -> Canonical {
    for field in ["command", "url", "httpUrl", "type"] {
        if object.get(field).is_some_and(|value| !value.is_string()) {
            verdict.refuse(crate::t!("mcp.canon.fieldTypeInvalid", field = field));
        }
    }
    if object.get("args").is_some_and(|value| {
        !value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
    }) {
        verdict.refuse(crate::t!("mcp.canon.fieldTypeInvalid", field = "args"));
    }
    for field in ["env", "headers"] {
        if object.get(field).is_some_and(|value| {
            !value
                .as_object()
                .is_some_and(|values| values.values().all(Value::is_string))
        }) {
            verdict.refuse(crate::t!("mcp.canon.fieldTypeInvalid", field = field));
        }
    }
    if transport == "unsupported" {
        verdict.refuse(crate::t!("mcp.canon.connectionTypeInvalid"));
    }
    if (transport == "stdio" && object.contains_key("headers"))
        || (transport != "stdio" && (object.contains_key("args") || object.contains_key("env")))
    {
        verdict.refuse(crate::t!("mcp.canon.connectionNotForTransport"));
    }
    // 值里的变量引用不算搬不过去：同一家之间原样复制，跨家由 `refusal` 拒绝（R4，2026-09-27 改定）
    if command.as_deref().is_some_and(str::is_empty) {
        verdict.refuse(crate::t!("mcp.canon.fieldEmpty", field = "command"));
    }
    if url.as_deref().is_some_and(str::is_empty) {
        verdict.refuse(crate::t!("mcp.canon.fieldEmpty", field = "url"));
    }
    if has_duplicate_header_names(&headers) {
        verdict.refuse(crate::t!(
            "mcp.canon.fieldDuplicateNames",
            field = "headers"
        ));
    }
    Canonical {
        raw: None,
        unknown_field: verdict.unknown.clone(),
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields,
        reason: verdict.bad.then(|| {
            verdict
                .reason
                .unwrap_or_else(|| crate::t!("mcp.canon.connectionTypeInvalid"))
        }),
        unsupported: verdict.bad,
        headers_helper: None,
    }
}

/// 认得之外的字段：整条搬不过去（同一家也不搬，与升级前的规则一致）
fn unknown_fields(object: &Map<String, Value>, known: &[&str], verdict: &mut Verdict) {
    if let Some(key) = object.keys().find(|key| !known.contains(&key.as_str())) {
        if verdict.reason.is_none() {
            verdict.unknown = Some(key.clone());
        }
        verdict.refuse(crate::t!("mcp.canon.unsupportedField", key = key));
    }
}

/// 这家专属、原样保留的字段 → `client_fields`（值是紧凑的 JSON 文本）
fn native_fields(object: &Map<String, Value>, native: &[&str]) -> BTreeMap<String, String> {
    object
        .iter()
        .filter(|(key, _)| native.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.to_string()))
        .collect()
}

/// Gemini 专属、同一家之间原样保留的字段（docs/research/2026-09-27 …batch1「无损映射障碍」）
pub(super) const GEMINI_NATIVE: [&str; 7] = [
    "trust",
    "includeTools",
    "excludeTools",
    "oauth",
    "cwd",
    "timeout",
    "description",
];

/// Gemini：`command` → stdio，`httpUrl` → Streamable HTTP，`url` → SSE，三选一；没有 `type`
pub(super) fn canon_gemini(value: &Value) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported_with(crate::t!("mcp.canon.notObject"));
    };
    let mut verdict = Verdict::default();
    let mut known = vec!["command", "args", "env", "url", "httpUrl", "headers"];
    known.extend(GEMINI_NATIVE);
    unknown_fields(object, &known, &mut verdict);
    let mut bad = false;
    let command = json_string(object.get("command"), &mut bad);
    let sse = json_string(object.get("url"), &mut bad);
    let http = json_string(object.get("httpUrl"), &mut bad);
    let args = json_args(object.get("args"), &mut bad);
    let env = json_map(object.get("env"), &mut bad);
    let headers = json_map(object.get("headers"), &mut bad);
    // 类型不对的由 `finish` 逐个字段说原因
    let _ = bad;
    let (transport, url) = match (command.is_some(), sse, http) {
        (true, None, None) => ("stdio", None),
        (false, Some(url), None) => ("sse", Some(url)),
        (false, None, Some(url)) => ("http", Some(url)),
        _ => ("unsupported", None),
    };
    finish(
        object,
        verdict,
        transport,
        command,
        url,
        args,
        env,
        headers,
        native_fields(object, &GEMINI_NATIVE),
    )
}

/// Copilot 的 `tools` 是不是「全部工具」：`"*"`（官方文档说的默认值）或 `["*"]`（官方示例的写法）。
/// 全部工具与没写 `tools` 一样，视为别家的「没有这个字段」
fn all_tools(value: &Value) -> bool {
    value == &Value::String("*".into()) || value == &serde_json::json!(["*"])
}

/// Copilot：`type` 为 `local` / `stdio`（同义）、`http`、`sse`；`tools` 不是全部工具时是它专属的设置
pub(super) fn canon_copilot(value: &Value) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported_with(crate::t!("mcp.canon.notObject"));
    };
    let mut verdict = Verdict::default();
    unknown_fields(
        object,
        &["type", "command", "args", "env", "url", "headers", "tools"],
        &mut verdict,
    );
    let mut bad = false;
    let typ = json_string(object.get("type"), &mut bad);
    let command = json_string(object.get("command"), &mut bad);
    let url = json_string(object.get("url"), &mut bad);
    let args = json_args(object.get("args"), &mut bad);
    let env = json_map(object.get("env"), &mut bad);
    let headers = json_map(object.get("headers"), &mut bad);
    // 类型不对的由 `finish` 逐个字段说原因
    let _ = bad;
    let mut client_fields = BTreeMap::new();
    match object.get("tools") {
        None => {}
        Some(tools) if all_tools(tools) => {}
        Some(tools @ Value::String(_)) => {
            client_fields.insert("tools".into(), tools.to_string());
        }
        Some(tools @ Value::Array(items)) if items.iter().all(Value::is_string) => {
            client_fields.insert("tools".into(), tools.to_string());
        }
        Some(_) => verdict.refuse(crate::t!("mcp.canon.fieldTypeInvalid", field = "tools")),
    }
    let transport = match (typ.as_deref(), command.is_some(), url.is_some()) {
        // 没写 type 的本地命令按 stdio 读（官方把 type 列为必填，这里不因此拒绝）
        (None | Some("local") | Some("stdio"), true, false) => "stdio",
        (Some("http"), false, true) => "http",
        (Some("sse"), false, true) => "sse",
        _ => "unsupported",
    };
    finish(
        object,
        verdict,
        transport,
        command,
        url,
        args,
        env,
        headers,
        client_fields,
    )
}

/// Claude Desktop：只有本地命令（`command` / `args` / `env`）
pub(super) fn canon_desktop(value: &Value) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported_with(crate::t!("mcp.canon.notObject"));
    };
    let mut verdict = Verdict::default();
    unknown_fields(object, &["command", "args", "env"], &mut verdict);
    let mut bad = false;
    let command = json_string(object.get("command"), &mut bad);
    let args = json_args(object.get("args"), &mut bad);
    let env = json_map(object.get("env"), &mut bad);
    // 类型不对的由 `finish` 逐个字段说原因
    let _ = bad;
    let transport = if command.is_some() {
        "stdio"
    } else {
        "unsupported"
    };
    finish(
        object,
        verdict,
        transport,
        command,
        None,
        args,
        env,
        BTreeMap::new(),
        BTreeMap::new(),
    )
}

// ===== 写 =====

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn object_of(values: &BTreeMap<String, String>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
    )
}

/// stdio 的 `command` / `args` / `env`（空的 `args`、`env` 不写）
fn stdio_fields(def: &Canonical, object: &mut Map<String, Value>) -> io::Result<()> {
    let command = def
        .command
        .clone()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "command"))?;
    object.insert("command".into(), Value::String(command));
    if !def.args.is_empty() {
        object.insert("args".into(), strings(&def.args));
    }
    if !def.env.is_empty() {
        object.insert("env".into(), object_of(&def.env));
    }
    Ok(())
}

/// 远程的地址（写在 `key` 下）与 `headers`
fn remote_fields(def: &Canonical, key: &str, object: &mut Map<String, Value>) -> io::Result<()> {
    let url = def
        .url
        .clone()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "url"))?;
    object.insert(key.into(), Value::String(url));
    if !def.headers.is_empty() {
        object.insert("headers".into(), object_of(&def.headers));
    }
    Ok(())
}

/// 同一家原样带回的专属字段；键不在这一家的名单里就拒绝（计划阶段已按 agent 拒绝，这里再挡一次）
fn put_native(
    def: &Canonical,
    allowed: &[&str],
    object: &mut Map<String, Value>,
) -> io::Result<()> {
    for (key, raw) in &def.client_fields {
        if !allowed.contains(&key.as_str()) {
            return Err(refused(crate::t!("mcp.write.noSetting", key = key)));
        }
        let value: Value = serde_json::from_str(raw)
            .map_err(|_| refused(crate::t!("mcp.write.invalidValue", key = key)))?;
        object.insert(key.clone(), value);
    }
    Ok(())
}

/// Gemini / Copilot / Claude Desktop 的一条服务。Claude Code 与 Cursor 走 `mcp.rs` 的 `json_server`
pub(super) fn server(def: &Canonical, dialect: Dialect) -> io::Result<Vec<u8>> {
    if def.headers_helper.is_some() {
        return Err(refused(crate::t!("mcp.write.noHeadersHelper")));
    }
    let mut object = Map::new();
    match dialect {
        Dialect::Gemini => {
            match def.transport.as_str() {
                "stdio" => stdio_fields(def, &mut object)?,
                // Streamable HTTP 一律 `httpUrl`、SSE 一律 `url`：写反了 Gemini 会按另一种连
                "http" => remote_fields(def, "httpUrl", &mut object)?,
                "sse" => remote_fields(def, "url", &mut object)?,
                _ => {
                    return Err(refused(crate::t!(
                        "mcp.write.transportUnknown",
                        agent = "Gemini CLI"
                    )))
                }
            }
            put_native(def, &GEMINI_NATIVE, &mut object)?;
        }
        Dialect::Copilot => {
            let typ = match def.transport.as_str() {
                "stdio" => {
                    stdio_fields(def, &mut object)?;
                    "local"
                }
                "http" | "sse" => {
                    remote_fields(def, "url", &mut object)?;
                    def.transport.as_str()
                }
                _ => {
                    return Err(refused(crate::t!(
                        "mcp.write.transportUnknown",
                        agent = "GitHub Copilot"
                    )))
                }
            };
            object.insert("type".into(), Value::String(typ.into()));
            // 全部工具按官方示例写成 `["*"]`；同一家带来的非全部 `tools` 原样写回
            object.insert("tools".into(), serde_json::json!(["*"]));
            put_native(def, &["tools"], &mut object)?;
        }
        Dialect::Desktop => {
            if def.transport != "stdio" {
                return Err(refused(desktop_remote()));
            }
            if def.has_loose_reference() {
                return Err(refused(desktop_variables()));
            }
            stdio_fields(def, &mut object)?;
            put_native(def, &[], &mut object)?;
        }
        Dialect::Claude | Dialect::Cursor | Dialect::Toml => {
            return Err(refused(crate::t!("mcp.write.notHere")));
        }
    }
    serde_json::to_vec(&Value::Object(object)).map_err(io::Error::other)
}

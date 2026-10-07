//! 把给定的 MCP 定义写进一个位置的若干 agent（spec 2026-09-27-skill-mcp-market R8 / R10，T4）。
//! 定义从精选、官方目录或粘贴的配置来，不属于任何一家的配置文件。
//!
//! - `parse_mcp_text`：认粘贴的配置——`{"mcpServers": …}`、`{"servers": …}`、`{"context_servers": …}`、
//!   `{"mcp_servers": …}`、TOML 的 `[mcp_servers.x]`、单个服务器对象（名字留空，界面要用户补）。
//!   认不出、写法不对都说是第几行。
//! - `placeholder_fields`：定义里空着的 `${KEY}`，安装页「要填的」一节。
//! - `check_targets`：安装页「写进哪些 agent」每一行后面那句：能写 / 只写几个 / 不能写 / 已有一样的。
//! - `write_definitions`：真正写。
//!
//! 无损规则沿用 `agents.rs`：定义当作来自「哪一家都不是」的来源过 `Canonical::refusal`，于是
//! Claude Desktop 的远程与变量、SSE、Gemini 的 `$VAR` 都说 MCP 页的原因句。写入走 `mcp.rs` 的 `execute`：
//! 文本级插入（原有字节一个不动）、备份、atomicfile 原子替换、写后指纹、撤销记录（`McpReport::take_undo`，
//! 命令层登记后由 `mcp_undo_write` 撤销）。
//!
//! 填的值只经过内存写进目标配置文件：检查结果、报告、错误句里只出现键名，不出现值。
//!
//! 粘贴的定义里连接字段之外的（Gemini 的 `trust`、Codex 的 `startup_timeout_sec`、Copilot 的 `tools`……）
//! 不丢也不整段拒绝：原样放进 `McpDefinitionInput::extra`，并按粘贴的写法认出是哪一家的（`dialect`）。
//! 写的时候与 MCP 页同一套无损规则：写进同一家原样带上（同一家之间复制那样）；别家接不住，
//! 按 `Canonical::refusal` 的原因句拒绝这一条（`带有 Gemini CLI 专属的设置（trust），…里没有对应的写法`）。
//! 认不出是哪一家的、或那一家 Sophia 也写不了的字段，哪一家都不写：`带有认不得的字段（x），照写会丢掉它`。
//! 取默认值、删了意思不变的几个（`disabled: false`、`enabled: true`、空的 `autoApprove`、全部工具的 `tools`、
//! Zed 的 `source: "custom"`）直接略过。
use super::agents::{self, desktop_remote};
use super::{
    agent_name, discover_locations, execute, has_duplicate_header_names, has_key_values, parse,
    plan_actions, secretish, with_mirrors, Canonical, McpAction, McpLocation, McpReport,
    McpReportEntry, Parsed, Pending, PreparedPlan,
};
use crate::atomicfile::unsafe_parent;
use crate::discovery::Env;
use crate::jsonedit::{self, NoDuplicates};
use crate::keyhint::{self, GitFacts, KeyHint};
use crate::market::{
    McpDefinitionInput, McpFieldKind, McpFieldSpec, McpInstallRequest, McpParseError,
    McpParseResult, McpTargetCheck, McpTargetStatus, McpTransport,
};
use crate::models::Harness;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::path::{Path, PathBuf};

// ===== 解析粘贴的配置（R8）=====

/// 粘贴的配置 → 定义，按原文先后。解析不了时 `error` 带行号（从 1 数），`message` 以 `第 N 行：` 开头
pub fn parse_mcp_text(text: &str) -> McpParseResult {
    match parse_text(text) {
        Ok(servers) => McpParseResult {
            servers,
            error: None,
        },
        Err(error) => McpParseResult {
            servers: Vec::new(),
            error: Some(error),
        },
    }
}

fn parse_error(line: Option<usize>, message: impl Into<String>) -> McpParseError {
    let message = message.into();
    McpParseError {
        line,
        message: match line {
            Some(line) => crate::t!("mcp.parse.atLine", line = line, message = message),
            None => message,
        },
    }
}

/// 字节位置在第几行（从 1 数）
fn line_at(text: &str, offset: usize) -> usize {
    let end = offset.min(text.len());
    text.as_bytes()[..end]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

type ParseResult<T> = Result<T, McpParseError>;

fn parse_text(text: &str) -> ParseResult<Vec<McpDefinitionInput>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let servers = match text.trim_start().chars().next() {
        None => return Err(parse_error(None, crate::t!("mcp.parse.empty"))),
        Some('{') => parse_json(text)?,
        // `[` 起头的多半是 TOML 的表头；是合法 JSON（数组）才按 JSON 报「最外层要是对象」
        Some('[') if serde_json::from_str::<Value>(text).is_ok() => parse_json(text)?,
        // 只拷了配置里的一段成员（`"mcpServers": {…}`、`"github": {…},`）：补上外层花括号再认。
        // 不加换行，行号不变
        Some('"') => {
            let body = text.trim_end().trim_end_matches(',');
            parse_json(&format!("{{{body}}}"))?
        }
        Some(_) => parse_toml(text)?,
    };
    if servers.is_empty() {
        return Err(parse_error(None, crate::t!("mcp.parse.noServers")));
    }
    Ok(servers)
}

/// 一个服务器读出来的字段，与每个字段在第几行。JSON 与 TOML 读法不同，校验与定连接方式共用 `finish`
#[derive(Default)]
struct RawServer {
    name: String,
    /// 服务器本身从第几行起
    at: Option<usize>,
    lines: BTreeMap<&'static str, usize>,
    /// `type` / `transport` 写明的连接方式
    typ: Option<String>,
    command: Option<String>,
    url: Option<String>,
    /// Gemini 的 `httpUrl`：Streamable HTTP 的地址
    http_url: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    headers: Option<BTreeMap<String, String>>,
    /// 连接字段之外、不是默认值的字段，与各自在第几行
    extra: BTreeMap<String, Value>,
    extra_lines: BTreeMap<String, usize>,
    /// 按写法认出的出处（harness id）
    dialect: Option<String>,
}

impl RawServer {
    fn line(&self, field: &str) -> Option<usize> {
        self.lines.get(field).copied().or(self.at)
    }

    /// 句子里怎么称呼它
    fn who(&self) -> String {
        if self.name.is_empty() {
            crate::t!("mcp.parse.thisServer")
        } else {
            self.name.clone()
        }
    }

    fn fail(&self, field: &str, message: impl Into<String>) -> McpParseError {
        parse_error(self.line(field), message)
    }
}

/// 没写 `type` 的远程地址：路径以 `/sse` 结尾的按 SSE，其余按 Streamable HTTP
/// （Cursor、Claude Code 等的 `url` 都是后者；SSE 端点按惯例挂在 `/sse`）
fn looks_like_sse(url: &str) -> bool {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .ends_with("/sse")
}

fn finish(raw: RawServer) -> ParseResult<McpDefinitionInput> {
    let who = raw.who();
    if raw.url.is_some() && raw.http_url.is_some() {
        return Err(raw.fail("httpUrl", crate::t!("mcp.parse.urlAndHttpUrl", who = who)));
    }
    let remote = raw.url.clone().or_else(|| raw.http_url.clone());
    let transport = match raw.typ.as_deref() {
        Some("stdio" | "local") => McpTransport::Stdio,
        Some("http" | "streamable-http" | "streamableHttp" | "streamable_http") => {
            McpTransport::Http
        }
        Some("sse") => McpTransport::Sse,
        Some(other) => {
            return Err(raw.fail(
                "type",
                crate::t!("mcp.parse.unknownTransport", other = other),
            ))
        }
        None if raw.command.is_some() => McpTransport::Stdio,
        None if raw.http_url.is_some() => McpTransport::Http,
        None => match remote.as_deref() {
            Some(url) if looks_like_sse(url) => McpTransport::Sse,
            Some(_) => McpTransport::Http,
            None => {
                return Err(parse_error(
                    raw.at,
                    crate::t!("mcp.parse.noCommandNoUrl", who = who),
                ))
            }
        },
    };
    if raw.command.is_some() && remote.is_some() {
        return Err(parse_error(
            raw.at,
            crate::t!("mcp.parse.commandAndUrl", who = who),
        ));
    }
    if transport == McpTransport::Stdio {
        let Some(command) = &raw.command else {
            return Err(raw.fail(
                "type",
                crate::t!("mcp.parse.stdioMissingCommand", who = who),
            ));
        };
        if command.trim().is_empty() {
            return Err(raw.fail("command", crate::t!("mcp.parse.commandBlank")));
        }
        if raw.headers.is_some() {
            return Err(raw.fail("headers", crate::t!("mcp.parse.stdioNoHeaders")));
        }
    } else {
        let Some(url) = &remote else {
            return Err(raw.fail("type", crate::t!("mcp.parse.remoteMissingUrl", who = who)));
        };
        if url.trim().is_empty() {
            return Err(raw.fail("url", crate::t!("mcp.parse.urlBlank")));
        }
        if transport == McpTransport::Sse && raw.http_url.is_some() {
            return Err(raw.fail("httpUrl", crate::t!("mcp.parse.httpUrlVsSse")));
        }
        if raw.args.is_some() {
            return Err(raw.fail("args", crate::t!("mcp.parse.remoteNoArgs")));
        }
        if raw.env.is_some() {
            return Err(raw.fail("env", crate::t!("mcp.parse.remoteNoEnv")));
        }
    }
    let headers = raw.headers.clone().unwrap_or_default();
    if has_duplicate_header_names(&headers) {
        return Err(raw.fail("headers", crate::t!("mcp.parse.headersCaseDuplicate")));
    }
    // 那一家接得住的字段，值要是那一家认的写法；接不住的不在这里判（写的时候按目标拒绝）
    for (key, value) in &raw.extra {
        let held = raw.dialect.as_deref().is_some_and(|d| holds(d, key));
        if let Some(message) = held.then(|| extra_problem(key, value, transport)).flatten() {
            let line = raw.extra_lines.get(key).copied().or(raw.at);
            return Err(parse_error(line, message));
        }
    }
    Ok(McpDefinitionInput {
        name: raw.name,
        transport,
        command: raw.command,
        args: raw.args.unwrap_or_default(),
        env: raw.env.unwrap_or_default(),
        url: remote,
        headers,
        extra: raw.extra,
        dialect: raw.dialect,
    })
}

// ----- 专属字段 -----

/// `dialect` 那一家接得住、Sophia 也写得了的字段（与 `agents.rs` / `mcp.rs` 各家写法的名单一致）
fn holds(dialect: &str, key: &str) -> bool {
    match dialect {
        "gemini-cli" => agents::GEMINI_NATIVE.contains(&key),
        "github-copilot" => key == "tools",
        "codex" => [
            "enabled",
            "startup_timeout_sec",
            "tool_timeout_sec",
            "http_headers_helper",
        ]
        .contains(&key),
        "claude-code" => key == "headersHelper",
        _ => false,
    }
}

/// 用命令生成请求头的字段：写成 `Canonical::headers_helper`，不当专属设置
fn helper_key(key: &str) -> bool {
    key == "headersHelper" || key == "http_headers_helper"
}

/// 接得住的字段，值不是那一家认的写法时的一句
fn extra_problem(key: &str, value: &Value, transport: McpTransport) -> Option<String> {
    match key {
        "enabled" if !value.is_boolean() => Some(crate::t!("mcp.parse.enabledBool")),
        "startup_timeout_sec" | "tool_timeout_sec"
            if !value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) =>
        {
            Some(crate::t!("mcp.parse.timeoutNumber", key = key))
        }
        "tools"
            if !(value.is_string()
                || value
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))) =>
        {
            Some(crate::t!("mcp.parse.toolsShape"))
        }
        key if helper_key(key) => match value.as_str() {
            Some(command) if command.trim().is_empty() => {
                Some(crate::t!("mcp.parse.helperEmpty", key = key))
            }
            None => Some(crate::t!("mcp.parse.mustBeString", key = key)),
            Some(command) if command.contains("${") => {
                Some(crate::t!("mcp.parse.helperNoVariables", key = key))
            }
            Some(_) if transport != McpTransport::Http => {
                Some(crate::t!("mcp.parse.helperHttpOnly", key = key))
            }
            Some(_) => None,
        },
        _ => None,
    }
}

/// JSON 写法认出的出处。外层 `context_servers` 是 Zed、`mcp_servers` 是 Codex；其余按服务器自己的字段：
/// `httpUrl` 或 Gemini 专属字段 → Gemini CLI，`type: local` 或 `tools` → Copilot，`headersHelper` → Claude Code，
/// `servers` 里都没有的 → VS Code。认出不止一家、或带着 Cline 一类的字段（`disabled`、`autoApprove`）时为 None
fn json_dialect(wrapper: Option<&str>, object: &serde_json::Map<String, Value>) -> Option<String> {
    match wrapper {
        Some("context_servers") => return Some("zed".into()),
        Some("mcp_servers") => return Some("codex".into()),
        _ => {}
    }
    let has = |key: &str| object.contains_key(key);
    let signals = [
        (
            "gemini-cli",
            has("httpUrl") || agents::GEMINI_NATIVE.iter().any(|key| has(key)),
        ),
        (
            "github-copilot",
            has("tools") || object.get("type").is_some_and(|t| t == "local"),
        ),
        ("claude-code", has("headersHelper")),
    ];
    let mut found = signals.iter().filter(|(_, on)| *on).map(|(id, _)| *id);
    let cline = ["disabled", "autoApprove", "alwaysAllow"]
        .iter()
        .any(|key| has(key));
    match (found.next(), found.next()) {
        (Some(id), None) if !cline => Some(id.into()),
        (None, _) if !cline && wrapper == Some("servers") => Some("vscode".into()),
        _ => None,
    }
}

// ----- JSON -----

/// 包着服务器表的外层键，按这个先后认
const WRAPPERS: [&str; 4] = ["mcpServers", "servers", "context_servers", "mcp_servers"];
/// 单个服务器对象的标志
const SERVER_HINTS: [&str; 3] = ["command", "url", "httpUrl"];
/// 服务器对象里认得的字段
const JSON_FIELDS: [&str; 8] = [
    "type",
    "transport",
    "command",
    "args",
    "env",
    "url",
    "httpUrl",
    "headers",
];

/// 取默认值、删掉意思不变的字段：略过不算丢
fn json_default_field(key: &str, value: &Value) -> bool {
    match key {
        "disabled" => value == &Value::Bool(false),
        "enabled" => value == &Value::Bool(true),
        "autoApprove" | "alwaysAllow" => value.as_array().is_some_and(Vec::is_empty),
        // Copilot 的全部工具
        "tools" => value == "*" || value == &serde_json::json!(["*"]),
        // Zed 自己加的来源标记
        "source" => value == "custom",
        _ => false,
    }
}

fn json_error(text: &str, error: &serde_json::Error) -> McpParseError {
    let line = (error.line() > 0).then_some(error.line());
    let raw = error.to_string();
    let here = line
        .and_then(|line| text.lines().nth(line - 1))
        .unwrap_or("")
        .trim_start();
    let comment = here.starts_with("//")
        || here.starts_with("/*")
        || [" //", "\t//", ",//", " /*"]
            .iter()
            .any(|mark| here.contains(mark));
    let message = if comment {
        crate::t!("mcp.parse.jsonComment")
    } else if error.is_eof() {
        crate::t!("mcp.parse.jsonUnterminated")
    } else if raw.contains("trailing comma") {
        crate::t!("mcp.parse.jsonTrailingComma")
    } else if raw.contains("duplicate JSON key") {
        crate::t!("mcp.parse.jsonDuplicateKey")
    } else if raw.contains("key must be a string") {
        crate::t!("mcp.parse.jsonKeyQuotes")
    } else if raw.contains("expected `,` or `}`") {
        crate::t!("mcp.parse.jsonMissingCommaOrExtra")
    } else if raw.contains("expected `,` or `]`") {
        crate::t!("mcp.parse.jsonArrayMissingComma")
    } else if raw.contains("expected `:`") {
        crate::t!("mcp.parse.jsonMissingColon")
    } else if raw.contains("control character") {
        crate::t!("mcp.parse.jsonControlChar")
    } else if raw.contains("escape") {
        crate::t!("mcp.parse.jsonBadEscape")
    } else if raw.contains("trailing characters") {
        crate::t!("mcp.parse.jsonTrailingContent")
    } else if raw.contains("expected value") || raw.contains("expected ident") {
        crate::t!("mcp.parse.jsonMissingValue")
    } else {
        crate::t!("mcp.parse.jsonInvalid")
    };
    parse_error(line, message)
}

/// 对象成员的值在原文里的范围，按原文先后
fn json_members(text: &str, range: (usize, usize)) -> Vec<(String, (usize, usize))> {
    let mut members: Vec<_> = jsonedit::object_at(text.as_bytes(), range)
        .map(|object| object.members.into_iter().collect())
        .unwrap_or_default();
    members.sort_by_key(|(_, (start, _))| *start);
    members
}

fn find(members: &[(String, (usize, usize))], key: &str) -> Option<(usize, usize)> {
    members
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, range)| *range)
}

fn json_value(text: &str, range: (usize, usize)) -> Value {
    serde_json::from_str(&text[range.0..range.1]).unwrap_or(Value::Null)
}

fn parse_json(text: &str) -> ParseResult<Vec<McpDefinitionInput>> {
    // 先过一遍不许重复键的读法：语法错与重复键都在这里带行号报出来
    if let Err(error) = serde_json::from_str::<NoDuplicates>(text) {
        return Err(json_error(text, &error));
    }
    let Ok(jsonedit::Object { start, end, .. }) = jsonedit::root(text.as_bytes()) else {
        let first = text.len() - text.trim_start().len();
        return Err(parse_error(
            Some(line_at(text, first)),
            crate::t!("mcp.parse.rootNotObject"),
        ));
    };
    let root = json_members(text, (start, end));
    let servers_at = |range: (usize, usize), key: &str| -> ParseResult<Vec<McpDefinitionInput>> {
        if text.as_bytes()[range.0] != b'{' {
            return Err(parse_error(
                Some(line_at(text, range.0)),
                crate::t!("mcp.parse.mustBeObject", name = key),
            ));
        }
        json_members(text, range)
            .into_iter()
            .map(|(name, range)| json_server(text, name, range, Some(key)))
            .collect()
    };
    for key in WRAPPERS {
        if let Some(range) = find(&root, key) {
            return servers_at(range, key);
        }
    }
    // VS Code 的 settings.json：`"mcp": {"servers": …}`
    if let Some(mcp) = find(&root, "mcp").filter(|r| text.as_bytes()[r.0] == b'{') {
        if let Some(range) = find(&json_members(text, mcp), "servers") {
            return servers_at(range, "servers");
        }
    }
    if SERVER_HINTS.iter().any(|key| find(&root, key).is_some()) {
        return Ok(vec![json_server(text, String::new(), (start, end), None)?]);
    }
    // 只有服务器表本身：`{"github": {…}, "filesystem": {…}}`
    let looks_like_server = |range: &(usize, usize)| {
        json_value(text, *range)
            .as_object()
            .is_some_and(|object| SERVER_HINTS.iter().any(|key| object.contains_key(*key)))
    };
    if !root.is_empty() && root.iter().all(|(_, range)| looks_like_server(range)) {
        return root
            .into_iter()
            .map(|(name, range)| json_server(text, name, range, None))
            .collect();
    }
    Err(parse_error(
        Some(line_at(text, start)),
        crate::t!("mcp.parse.unrecognizedJson"),
    ))
}

/// 一个服务器对象。`wrapper` 是包着它的外层键（认出处用；单个对象、只有服务器表时为 None）
fn json_server(
    text: &str,
    name: String,
    range: (usize, usize),
    wrapper: Option<&str>,
) -> ParseResult<McpDefinitionInput> {
    let mut raw = RawServer {
        at: Some(line_at(text, range.0)),
        name,
        ..RawServer::default()
    };
    let who = raw.who();
    let Value::Object(object) = json_value(text, range) else {
        return Err(parse_error(
            raw.at,
            crate::t!("mcp.parse.mustBeObject", name = who),
        ));
    };
    if raw.name.trim().is_empty() && !raw.name.is_empty() {
        return Err(parse_error(raw.at, crate::t!("mcp.parse.serverNameEmpty")));
    }
    let members = json_members(text, range);
    for (key, (start, _)) in &members {
        let line = line_at(text, *start);
        match JSON_FIELDS.iter().find(|field| **field == key.as_str()) {
            Some(field) => {
                raw.lines.insert(*field, line);
            }
            None if json_default_field(key, &object[key]) => {}
            None => {
                raw.extra.insert(key.clone(), object[key].clone());
                raw.extra_lines.insert(key.clone(), line);
            }
        }
    }
    raw.dialect = json_dialect(wrapper, &object);
    let string = |key: &str| -> ParseResult<Option<String>> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(raw.fail(key, crate::t!("mcp.parse.mustBeString", key = key))),
        }
    };
    let typ = string("type")?;
    let transport = string("transport")?;
    if typ.is_some() && transport.is_some() && typ != transport {
        return Err(raw.fail("transport", crate::t!("mcp.parse.typeTransportMismatch")));
    }
    let command = string("command")?;
    let url = string("url")?;
    let http_url = string("httpUrl")?;
    let args = match object.get("args") {
        None => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| raw.fail("args", crate::t!("mcp.parse.argsItemsString")))?,
        ),
        Some(_) => return Err(raw.fail("args", crate::t!("mcp.parse.argsStringArray"))),
    };
    let env = json_string_map(&raw, &object, "env")?;
    let headers = json_string_map(&raw, &object, "headers")?;
    raw.typ = typ.or(transport);
    raw.command = command;
    raw.url = url;
    raw.http_url = http_url;
    raw.args = args;
    raw.env = env;
    raw.headers = headers;
    finish(raw)
}

/// `env` / `headers`：值是字符串；数字与布尔照原样转成字符串（环境变量与请求头本来就只有字符串）
fn json_string_map(
    raw: &RawServer,
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> ParseResult<Option<BTreeMap<String, String>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let Value::Object(values) = value else {
        return Err(raw.fail(key, crate::t!("mcp.parse.mustBeObject", name = key)));
    };
    values
        .iter()
        .map(|(name, value)| match value {
            Value::String(text) => Ok((name.clone(), text.clone())),
            Value::Number(number) => Ok((name.clone(), number.to_string())),
            Value::Bool(flag) => Ok((name.clone(), flag.to_string())),
            _ => Err(raw.fail(
                key,
                crate::t!("mcp.parse.mapValueString", key = key, name = name),
            )),
        })
        .collect::<ParseResult<_>>()
        .map(Some)
}

// ----- TOML -----

/// Codex 的服务器表里认得的字段（`http_headers` 即请求头）
const TOML_FIELDS: [&str; 5] = ["command", "args", "env", "url", "http_headers"];

fn toml_line(
    text: &str,
    table: &dyn toml_edit::TableLike,
    key: &str,
    fallback: Option<usize>,
) -> Option<usize> {
    table
        .key(key)
        .and_then(|key| key.span())
        .or_else(|| table.get(key).and_then(toml_edit::Item::span))
        .map(|span| line_at(text, span.start))
        .or(fallback)
}

fn parse_toml(text: &str) -> ParseResult<Vec<McpDefinitionInput>> {
    let document = toml_edit::Document::parse(text).map_err(|error| {
        parse_error(
            error.span().map(|span| line_at(text, span.start)),
            crate::t!("mcp.parse.tomlInvalid"),
        )
    })?;
    let root = document.as_table();
    if let Some(item) = root.get("mcp_servers") {
        let at = toml_line(text, root, "mcp_servers", None);
        let Some(servers) = item.as_table_like() else {
            return Err(parse_error(at, crate::t!("mcp.parse.serversMustBeTable")));
        };
        let mut out: Vec<(usize, McpDefinitionInput)> = Vec::new();
        for (name, item) in servers.iter() {
            let at = toml_line(text, servers, name, at);
            let Some(table) = item.as_table_like() else {
                return Err(parse_error(
                    at,
                    crate::t!("mcp.parse.mustBeTable", name = name),
                ));
            };
            out.push((at.unwrap_or(0), toml_server(text, name.into(), table, at)?));
        }
        // 按原文先后
        out.sort_by_key(|(line, _)| *line);
        return Ok(out.into_iter().map(|(_, server)| server).collect());
    }
    if root.contains_key("command") || root.contains_key("url") {
        return Ok(vec![toml_server(text, String::new(), root, Some(1))?]);
    }
    Err(parse_error(None, crate::t!("mcp.parse.unrecognizedToml")))
}

fn toml_server(
    text: &str,
    name: String,
    table: &dyn toml_edit::TableLike,
    at: Option<usize>,
) -> ParseResult<McpDefinitionInput> {
    let mut raw = RawServer {
        name,
        at,
        ..RawServer::default()
    };
    for (key, item) in table.iter() {
        let line = toml_line(text, table, key, at);
        match TOML_FIELDS.iter().find(|field| **field == key) {
            Some(field) => {
                let field = if *field == "http_headers" {
                    "headers"
                } else {
                    *field
                };
                if let Some(line) = line {
                    raw.lines.insert(field, line);
                }
            }
            None if key == "enabled" && item.as_bool() == Some(true) => {}
            None => {
                raw.extra.insert(key.to_owned(), toml_item_json(item));
                if let Some(line) = line {
                    raw.extra_lines.insert(key.to_owned(), line);
                }
            }
        }
    }
    raw.dialect = Some("codex".into());
    let string = |key: &str| -> ParseResult<Option<String>> {
        match table.get(key) {
            None => Ok(None),
            Some(item) => item
                .as_str()
                .map(|value| Some(value.to_owned()))
                .ok_or_else(|| {
                    parse_error(
                        toml_line(text, table, key, at),
                        crate::t!("mcp.parse.mustBeString", key = key),
                    )
                }),
        }
    };
    raw.command = string("command")?;
    raw.url = string("url")?;
    raw.args = match table.get("args") {
        None => None,
        Some(item) => Some(
            item.as_array()
                .and_then(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| {
                    parse_error(
                        toml_line(text, table, "args", at),
                        crate::t!("mcp.parse.argsStringArray"),
                    )
                })?,
        ),
    };
    raw.env = toml_string_map(text, table, "env", at)?;
    raw.headers = toml_string_map(text, table, "http_headers", at)?;
    // Codex 的 `url` 就是 Streamable HTTP（它不认 SSE）
    if raw.url.is_some() {
        raw.typ = Some("http".into());
    }
    finish(raw)
}

/// TOML 的值 → JSON 的值（专属字段原样保留用）：浮点数仍是数，日期时间写成原文
fn toml_item_json(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::None => Value::Null,
        toml_edit::Item::Value(value) => toml_value_json(value),
        toml_edit::Item::Table(table) => Value::Object(
            table
                .iter()
                .map(|(key, item)| (key.to_owned(), toml_item_json(item)))
                .collect(),
        ),
        toml_edit::Item::ArrayOfTables(tables) => Value::Array(
            tables
                .iter()
                .map(|table| toml_item_json(&toml_edit::Item::Table(table.clone())))
                .collect(),
        ),
    }
}

fn toml_value_json(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as V;
    match value {
        V::String(s) => Value::String(s.value().clone()),
        V::Integer(i) => Value::from(*i.value()),
        V::Float(f) => Value::from(*f.value()),
        V::Boolean(b) => Value::Bool(*b.value()),
        V::Datetime(d) => Value::String(d.value().to_string()),
        V::Array(values) => Value::Array(values.iter().map(toml_value_json).collect()),
        V::InlineTable(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_owned(), toml_value_json(value)))
                .collect(),
        ),
    }
}

fn toml_string_map(
    text: &str,
    table: &dyn toml_edit::TableLike,
    key: &str,
    at: Option<usize>,
) -> ParseResult<Option<BTreeMap<String, String>>> {
    let Some(item) = table.get(key) else {
        return Ok(None);
    };
    let line = toml_line(text, table, key, at);
    let Some(values) = item.as_table_like() else {
        return Err(parse_error(
            line,
            crate::t!("mcp.parse.mustBeTableKey", key = key),
        ));
    };
    values
        .iter()
        .map(|(name, value)| {
            let value = value.as_value();
            let text = value
                .and_then(|v| v.as_str().map(str::to_owned))
                .or_else(|| value.and_then(|v| v.as_integer()).map(|n| n.to_string()))
                .or_else(|| value.and_then(|v| v.as_bool()).map(|b| b.to_string()));
            text.map(|text| (name.to_owned(), text)).ok_or_else(|| {
                parse_error(
                    line,
                    crate::t!("mcp.parse.mapValueString", key = key, name = name),
                )
            })
        })
        .collect::<ParseResult<_>>()
        .map(Some)
}

// ===== `${KEY}` 占位 =====

/// 串里的 `${KEY}` 占位：范围与键名。键名不能空、不能再含 `{` / `$`
fn placeholders(text: &str) -> Vec<(Range<usize>, &str)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(offset) = text[from..].find("${") {
        let start = from + offset;
        let body = &text[start + 2..];
        match body.find('}') {
            Some(len) if len > 0 && !body[..len].contains(['{', '$']) => {
                out.push((start..start + 3 + len, &body[..len]));
                from = start + 3 + len;
            }
            _ => from = start + 2,
        }
    }
    out
}

/// 填的值（空串算没填）
fn value_of<'a>(values: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    values
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

/// 把填了的占位换成值。没填的：`hole` 为 None 时原样留着，否则换成 `hole`。返回结果与没填的键
fn fill(
    text: &str,
    values: &BTreeMap<String, String>,
    hole: Option<&str>,
) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut unfilled = Vec::new();
    let mut last = 0;
    for (range, key) in placeholders(text) {
        out.push_str(&text[last..range.start]);
        match (value_of(values, key), hole) {
            (Some(value), _) => out.push_str(value),
            (None, hole) => {
                unfilled.push(key.to_owned());
                out.push_str(hole.unwrap_or(&text[range.clone()]));
            }
        }
        last = range.end;
    }
    out.push_str(&text[last..]);
    (out, unfilled)
}

/// 整个值就是一个没填的占位（`"${API_KEY}"`）：选填项没填时整项不写
fn bare_unfilled(text: &str, values: &BTreeMap<String, String>) -> bool {
    matches!(placeholders(text).as_slice(), [(range, key)]
        if *range == (0..text.len()) && value_of(values, key).is_none())
}

/// 定义里空着的 `${KEY}`（R8「要填的」；精选条目自带 `fields`，不用它）。按出现的先后去重；
/// 键名或所在的环境变量名 / 请求头名像凭据（key、token、secret、auth…）的算密钥。一律必填
pub fn placeholder_fields(definitions: &[McpDefinitionInput]) -> Vec<McpFieldSpec> {
    let mut out: Vec<McpFieldSpec> = Vec::new();
    let mut add = |text: &str, owner: Option<&str>, kind: McpFieldKind| {
        for (_, key) in placeholders(text) {
            if out.iter().any(|field| field.key == key) {
                continue;
            }
            out.push(McpFieldSpec {
                key: key.to_owned(),
                kind,
                required: true,
                secret: secretish(key) || owner.is_some_and(secretish),
                description: None,
            });
        }
    };
    for def in definitions {
        if let Some(command) = &def.command {
            add(command, None, McpFieldKind::Arg);
        }
        for arg in &def.args {
            add(arg, None, McpFieldKind::Arg);
        }
        for (name, value) in &def.env {
            add(value, Some(name.as_str()), McpFieldKind::Env);
        }
        if let Some(url) = &def.url {
            add(url, None, McpFieldKind::Arg);
        }
        for (name, value) in &def.headers {
            add(value, Some(name.as_str()), McpFieldKind::Header);
        }
    }
    out
}

// ===== 把定义摆成要写的样子 =====

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 安装页边填边查：没填的占位当通配（比对已有的），过规则时换成一个普通字
    Check,
    /// 真写：填上值；选填没填的整项不写；其余没填的这条不写
    Write,
}

struct Built {
    name: String,
    /// 要写的样子（`Check` 时没填的占位原样留着）
    canon: Canonical,
    /// 过无损规则用：没填的占位换成普通字，不让它被当成变量引用
    probe: Canonical,
    /// 这条哪儿都写不了的原因（定义本身不完整、还有没填的、带着认不得的字段）
    problem: Option<String>,
    /// 带着专属字段时，它们出自哪一家（harness id 与句子里的名字）：过无损规则时当来源
    source: Option<(String, String)>,
}

fn transport_name(transport: McpTransport) -> &'static str {
    match transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    }
}

/// 定义本身写得对不对（精选、官方目录来的也查一遍）
fn definition_problem(def: &McpDefinitionInput) -> Option<String> {
    let name = &def.name;
    if name.trim().is_empty() {
        return Some(crate::t!("mcp.parse.serverNameEmpty"));
    }
    let blank = |value: &Option<String>| value.as_deref().is_none_or(|v| v.trim().is_empty());
    if def.transport == McpTransport::Stdio {
        if blank(&def.command) {
            return Some(crate::t!("mcp.problem.missingCommand", name = name));
        }
        if def.url.is_some() {
            return Some(crate::t!("mcp.problem.commandAndUrl", name = name));
        }
        if !def.headers.is_empty() {
            return Some(crate::t!("mcp.problem.stdioNoHeaders", name = name));
        }
    } else {
        if blank(&def.url) {
            return Some(crate::t!("mcp.problem.missingUrl", name = name));
        }
        if def.command.is_some() || !def.args.is_empty() || !def.env.is_empty() {
            return Some(crate::t!("mcp.problem.remoteNoStdioFields", name = name));
        }
    }
    if has_duplicate_header_names(&def.headers) {
        return Some(crate::t!("mcp.problem.headerDuplicate", name = name));
    }
    let dialect = def.dialect.as_deref().unwrap_or("");
    def.extra
        .iter()
        .filter(|(key, _)| holds(dialect, key))
        .find_map(|(key, value)| extra_problem(key, value, def.transport))
        .map(|problem| crate::t!("mcp.problem.named", name = name, problem = problem))
}

/// 名单里的几个字段：一个写名字，多个写 `trust 等 3 项`（与 MCP 页的原因句同一种写法）
fn field_list(keys: &[&str]) -> String {
    match keys {
        [one] => (*one).to_owned(),
        [first, ..] => crate::tn!("mcp.fields.andMore", keys.len(), first = first),
        [] => String::new(),
    }
}

/// 专属字段出自的那一家叫什么：agent 表里有的用表里的名字
fn dialect_name(harnesses: &[Harness], id: &str) -> String {
    if let Some(harness) = harnesses.iter().find(|h| h.id == id) {
        return harness.display_name.clone();
    }
    match id {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "gemini-cli" => "Gemini CLI",
        "github-copilot" => "GitHub Copilot",
        "claude-desktop" => "Claude Desktop",
        "zed" => "Zed",
        "vscode" => "VS Code",
        other => other,
    }
    .to_owned()
}

/// 专属字段落成 `Canonical` 的样子：`client_fields`（那一家文件里的原样写法：Codex 是 TOML、其余是 JSON）
/// 与用命令生成请求头。认不得的（认不出出处、或出处那一家 Sophia 也写不了）返回拒绝的一句
fn extras_of(
    def: &McpDefinitionInput,
) -> Result<(BTreeMap<String, String>, Option<String>), String> {
    let dialect = def.dialect.as_deref();
    let known = dialect.is_some_and(|d| agents::agent(d).is_some());
    let unknown: Vec<&str> = def
        .extra
        .keys()
        .map(String::as_str)
        .filter(|key| dialect.is_none() || (known && !holds(dialect.unwrap_or(""), key)))
        .collect();
    if !unknown.is_empty() {
        return Err(crate::t!(
            "mcp.problem.unknownFields",
            fields = field_list(&unknown)
        ));
    }
    let mut fields = BTreeMap::new();
    let mut helper = None;
    for (key, value) in &def.extra {
        if known && helper_key(key) {
            helper = value.as_str().map(str::to_owned);
        } else if key == "tools" && json_default_field(key, value) {
            // 全部工具与没写一样
        } else {
            // JSON 的 bool / 数与 TOML 写法相同；Codex 接得住的只有这两种（`extra_problem` 已查过）
            fields.insert(key.clone(), value.to_string());
        }
    }
    Ok((fields, helper))
}

fn build(
    def: &McpDefinitionInput,
    values: &BTreeMap<String, String>,
    mode: Mode,
    harnesses: &[Harness],
) -> Built {
    let mut unfilled: Vec<String> = Vec::new();
    // 一个值：`hole` 同 `fill`；`optional` 为真时整个是没填的占位就不要这一项（Write）
    let mut one = |text: &str, hole: Option<&str>, optional: bool| -> Option<String> {
        if optional && mode == Mode::Write && bare_unfilled(text, values) {
            return None;
        }
        let (out, missing) = fill(text, values, hole);
        if mode == Mode::Write {
            unfilled.extend(missing);
        }
        Some(out)
    };
    let (extras, unknown) = match extras_of(def) {
        Ok(extras) => (extras, None),
        Err(reason) => (Default::default(), Some(reason)),
    };
    let (client_fields, headers_helper) = extras;
    let mut canon_with = |hole: Option<&str>| Canonical {
        raw: None,
        unknown_field: None,
        transport: transport_name(def.transport).into(),
        command: def.command.as_deref().and_then(|c| one(c, hole, false)),
        args: def.args.iter().filter_map(|a| one(a, hole, true)).collect(),
        env: def
            .env
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), one(v, hole, true)?)))
            .collect(),
        url: def.url.as_deref().and_then(|u| one(u, hole, false)),
        headers: def
            .headers
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), one(v, hole, true)?)))
            .collect(),
        client_fields: client_fields.clone(),
        reason: None,
        unsupported: false,
        headers_helper: headers_helper.clone(),
    };
    let (canon, probe) = match mode {
        Mode::Check => (canon_with(None), canon_with(Some("x"))),
        Mode::Write => {
            let canon = canon_with(None);
            (canon.clone(), canon)
        }
    };
    let mut problem = definition_problem(def).or(unknown);
    if problem.is_none() {
        // 填的值里自己带 `${…}`：写进去会被 agent 当成变量引用
        let mut used = Vec::new();
        let texts = def
            .command
            .iter()
            .chain(&def.args)
            .chain(def.env.values())
            .chain(&def.url)
            .chain(def.headers.values());
        for text in texts {
            used.extend(placeholders(text).into_iter().map(|(_, key)| key));
        }
        if let Some(key) = used
            .iter()
            .find(|key| value_of(values, key).is_some_and(|v| v.contains("${")))
        {
            problem = Some(crate::t!("mcp.problem.variableInValue", key = key));
        }
    }
    if problem.is_none() && !unfilled.is_empty() {
        let mut seen = BTreeSet::new();
        unfilled.retain(|key| seen.insert(key.clone()));
        problem = Some(crate::t!(
            "mcp.problem.unfilled",
            name = def.name,
            keys = crate::i18n::list_text(&unfilled, crate::i18n::ListStyle::Enum)
        ));
    }
    let source = def
        .dialect
        .as_deref()
        .filter(|_| !def.extra.is_empty())
        .map(|id| (id.to_owned(), dialect_name(harnesses, id)));
    Built {
        name: def.name.clone(),
        canon,
        probe,
        problem,
        source,
    }
}

fn build_all(request: &McpInstallRequest, mode: Mode, harnesses: &[Harness]) -> Vec<Built> {
    let mut seen = BTreeSet::new();
    request
        .definitions
        .iter()
        .map(|def| {
            let mut built = build(def, &request.values, mode, harnesses);
            if !seen.insert(def.name.clone()) && built.problem.is_none() {
                built.problem = Some(crate::t!("mcp.problem.duplicate", name = def.name));
            }
            built
        })
        .collect()
}

// ===== 目标 =====

struct Target {
    harness_id: String,
    /// 句子里的 agent 名
    agent: String,
    location: Option<McpLocation>,
    parsed: Option<Parsed>,
    /// 整个目标都写不了的原因
    blocked: Option<String>,
}

impl Target {
    fn id(&self) -> String {
        self.location
            .as_ref()
            .map_or_else(|| self.harness_id.clone(), |l| l.id.clone())
    }
}

/// 请求里的位置（域 key）→ 发现位置用的项目。`global` 为空表；认不出为 None
fn projects_of(location: &str) -> Option<Vec<PathBuf>> {
    if location == "global" {
        return Some(Vec::new());
    }
    location
        .strip_prefix("project:")
        .filter(|path| !path.is_empty())
        .map(|path| vec![PathBuf::from(path)])
}

fn resolve_targets(env: &Env, harnesses: &[Harness], request: &McpInstallRequest) -> Vec<Target> {
    let projects = projects_of(&request.location);
    let mut seen = BTreeSet::new();
    request
        .harness_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .map(|id| {
            let harness = harnesses.iter().find(|h| &h.id == id);
            let mut target = Target {
                harness_id: id.clone(),
                agent: harness.map_or_else(|| id.clone(), |h| h.display_name.clone()),
                location: None,
                parsed: None,
                blocked: None,
            };
            let blocked = |target: &mut Target, reason: String| target.blocked = Some(reason);
            let Some(projects) = &projects else {
                blocked(&mut target, crate::t!("mcp.target.unknownLocation"));
                return target;
            };
            let Some(agent) = agents::agent(id) else {
                let reason = crate::t!("mcp.target.unsupportedHere", agent = target.agent);
                blocked(&mut target, reason);
                return target;
            };
            let Some(harness) = harness else {
                blocked(&mut target, crate::t!("mcp.target.notFound", id = id));
                return target;
            };
            // 项目里的 Claude Code：self（缺省）写本地配置（selector 是项目路径），team 写 .mcp.json
            let claude_local = id == "claude-code"
                && !projects.is_empty()
                && request.claude_code_scope.as_deref() != Some("team");
            let location = discover_locations(env, std::slice::from_ref(harness), projects)
                .locations
                .into_iter()
                .find(|l| {
                    &l.harness_id == id
                        && l.selector.is_some() == claude_local
                        && (l.domain == "global") == projects.is_empty()
                });
            let Some(location) = location else {
                let reason = if !projects.is_empty() && agent.project.is_none() {
                    crate::t!("mcp.blank.noProjectLevel", agent = target.agent)
                } else {
                    crate::t!("mcp.target.noConfig", agent = target.agent)
                };
                blocked(&mut target, reason);
                return target;
            };
            target.agent = agent_name(&location).to_owned();
            if unsafe_parent(&location.path) {
                blocked(&mut target, crate::t!("mcp.issue.parentSymlink"));
            } else {
                let parsed = parse(&location);
                if parsed.issue.is_some() {
                    let reason = crate::t!("mcp.target.unreadable", agent = target.agent);
                    blocked(&mut target, reason);
                }
                target.parsed = Some(parsed);
            }
            target.location = Some(location);
            target
        })
        .collect()
}

// ===== 每条定义对每个目标 =====

enum Verdict {
    New,
    Same,
    Bad(String),
}

/// `template` 里没填的 `${KEY}` 当通配，其余逐字相同
fn glob(template: &str, actual: &str) -> bool {
    let holes = placeholders(template);
    if holes.is_empty() {
        return template == actual;
    }
    let mut parts = Vec::with_capacity(holes.len() + 1);
    let mut last = 0;
    for (range, _) in &holes {
        parts.push(&template[last..range.start]);
        last = range.end;
    }
    parts.push(&template[last..]);
    let (head, tail) = (parts[0], parts[parts.len() - 1]);
    if actual.len() < head.len() + tail.len()
        || !actual.starts_with(head)
        || !actual.ends_with(tail)
    {
        return false;
    }
    let mut rest = &actual[head.len()..actual.len() - tail.len()];
    for middle in &parts[1..parts.len() - 1] {
        match rest.find(middle) {
            Some(at) => rest = &rest[at + middle.len()..],
            None => return false,
        }
    }
    true
}

fn glob_option(template: &Option<String>, actual: &Option<String>) -> bool {
    match (template, actual) {
        (None, None) => true,
        (Some(template), Some(actual)) => glob(template, actual),
        _ => false,
    }
}

/// 整个值就是一个占位：`Check` 时它还没填，选填的话写的时候整项不写，所以已有的里可以没有它
fn bare_placeholder(text: &str) -> bool {
    matches!(placeholders(text).as_slice(), [(range, _)] if *range == (0..text.len()))
}

/// 参数逐个比；只有占位的参数可以不在
fn args_match(template: &[String], actual: &[String]) -> bool {
    match (template.split_first(), actual.split_first()) {
        (None, _) => actual.is_empty(),
        (Some((head, rest)), first) => {
            let here = first.is_some_and(|(a, tail)| glob(head, a) && args_match(rest, tail));
            here || (bare_placeholder(head) && args_match(rest, actual))
        }
    }
}

/// 环境变量 / 请求头：名字对得上、值逐个比；只有占位的那项可以不在。请求头名不分大小写
fn map_match(
    template: &BTreeMap<String, String>,
    actual: &BTreeMap<String, String>,
    fold: bool,
) -> bool {
    let same_name = |left: &str, right: &str| {
        if fold {
            left.eq_ignore_ascii_case(right)
        } else {
            left == right
        }
    };
    actual
        .keys()
        .all(|name| template.keys().any(|other| same_name(name, other)))
        && template.iter().all(|(name, value)| {
            match actual.iter().find(|(other, _)| same_name(name, other)) {
                Some((_, other)) => glob(value, other),
                None => bare_placeholder(value),
            }
        })
}

/// 目标里已有的与要写的一样（连接字段；与 MCP 页「一致」同一口径，不看各家的专属设置）
fn same_definition(template: &Canonical, old: &Canonical) -> bool {
    !old.unsupported
        && old.headers_helper == template.headers_helper
        && template.transport == old.transport
        && glob_option(&template.command, &old.command)
        && args_match(&template.args, &old.args)
        && map_match(&template.env, &old.env, false)
        && glob_option(&template.url, &old.url)
        && map_match(&template.headers, &old.headers, true)
}

/// 专属设置一样：JSON 的按值比（不看键的先后与空白），Codex 的按 TOML 值比（不看行尾注释）
fn same_client_fields(left: &BTreeMap<String, String>, right: &BTreeMap<String, String>) -> bool {
    let same = |a: &str, b: &str| match (
        serde_json::from_str::<Value>(a),
        serde_json::from_str::<Value>(b),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => {
            let render = |raw: &str| super::client_value(raw).map(|value| value.to_string());
            render(a).is_some() && render(a) == render(b)
        }
    };
    left.len() == right.len()
        && left
            .iter()
            .all(|(key, raw)| right.get(key).is_some_and(|other| same(raw, other)))
}

fn verdict(target: &Target, built: &Built) -> Verdict {
    if let Some(reason) = &target.blocked {
        return Verdict::Bad(reason.clone());
    }
    if let Some(problem) = &built.problem {
        return Verdict::Bad(problem.clone());
    }
    let (Some(location), Some(parsed)) = (&target.location, &target.parsed) else {
        return Verdict::Bad(crate::t!("mcp.target.noAgentConfig"));
    };
    let old = parsed.values.get(&built.name);
    // 带着专属设置写进它出自的那一家：专属设置也要一样才算已有；别家本来就写不进这些设置，只比连接字段
    let (source_id, source_name) = built
        .source
        .as_ref()
        .map_or(("", ""), |(id, name)| (id.as_str(), name.as_str()));
    let home = source_id == location.harness_id;
    if old.is_some_and(|old| {
        same_definition(&built.canon, old)
            && (!home || same_client_fields(&built.canon.client_fields, &old.client_fields))
    }) {
        return Verdict::Same;
    }
    // 没有专属设置时来源是「哪一家都不是」：同一家之间才放行的（带 `${…}`）一律按跨家处理。
    // 带着专属设置时来源就是它出自的那一家：写进同一家原样带上，别家说 MCP 页的原因句
    if let Some(reason) =
        built
            .probe
            .refusal(source_id, source_name, &location.harness_id, &target.agent)
    {
        return Verdict::Bad(reason);
    }
    match old {
        Some(old) if old.unsupported => Verdict::Bad(crate::t!(
            "mcp.target.existingUncomparable",
            agent = target.agent,
            name = built.name
        )),
        Some(_) => Verdict::Bad(crate::t!(
            "mcp.target.existingDiffers",
            agent = target.agent,
            name = built.name
        )),
        None => Verdict::New,
    }
}

/// 只写一部分时，写不过去的那几条各说一句
fn partial_phrase(name: &str, reason: &str) -> String {
    if reason == desktop_remote() {
        crate::t!(
            "mcp.check.desktopRemote",
            name = name,
            agent = "Claude Desktop"
        )
    } else if reason.contains(name) {
        reason.to_owned()
    } else {
        crate::t!("mcp.problem.named", name = name, problem = reason)
    }
}

/// 写进去之后什么时候生效（DESIGN「MCP 支持哪些 agent › 写进之后什么时候生效」）
fn effect_note(harness_id: &str, project: bool) -> Option<String> {
    match harness_id {
        "claude-desktop" => Some(crate::t!(
            "mcp.check.restartToApply",
            agent = "Claude Desktop"
        )),
        "gemini-cli" => Some(crate::t!("mcp.check.newSessionToApply")),
        "github-copilot" if project => {
            Some(crate::t!("mcp.check.newSessionAndTrust", agent = "Copilot"))
        }
        "github-copilot" => Some(crate::t!("mcp.check.newSessionToApply")),
        _ => None,
    }
}

fn check_one(target: &Target, built: &[Built]) -> McpTargetCheck {
    let location_id = target.location.as_ref().map(|l| l.id.clone());
    let blocked = |reason: String| McpTargetCheck {
        harness_id: target.harness_id.clone(),
        location_id: location_id.clone(),
        status: McpTargetStatus::Blocked,
        writes: Vec::new(),
        reason: Some(reason),
        note: None,
        key_hint: KeyHint::Quiet,
        gitignore_line: None,
    };
    if let Some(reason) = &target.blocked {
        return blocked(reason.clone());
    }
    if built.is_empty() {
        return blocked(crate::t!("mcp.check.nothingToWrite"));
    }
    let (mut writes, mut same, mut bad) = (Vec::new(), Vec::new(), Vec::new());
    for def in built {
        match verdict(target, def) {
            Verdict::New => writes.push(def.name.clone()),
            Verdict::Same => same.push(def.name.clone()),
            Verdict::Bad(reason) => bad.push((def.name.clone(), reason)),
        }
    }
    if writes.is_empty() && same.is_empty() {
        return blocked(bad.swap_remove(0).1);
    }
    let (status, reason) = if bad.is_empty() {
        let status = if writes.is_empty() {
            McpTargetStatus::Same
        } else {
            McpTargetStatus::Ok
        };
        (status, None)
    } else {
        let head = if writes.is_empty() {
            crate::t!(
                "mcp.check.alreadyHave",
                names = crate::i18n::list_text(&same, crate::i18n::ListStyle::Enum)
            )
        } else {
            crate::t!(
                "mcp.check.onlyWrite",
                names = crate::i18n::list_text(&writes, crate::i18n::ListStyle::Enum)
            )
        };
        let rest: Vec<String> = bad
            .iter()
            .map(|(name, reason)| partial_phrase(name, reason))
            .collect();
        (
            McpTargetStatus::Partial,
            Some(format!(
                "{head} · {}",
                crate::i18n::list_text(&rest, crate::i18n::ListStyle::Semicolon)
            )),
        )
    };
    let project = target
        .location
        .as_ref()
        .is_some_and(|l| l.domain != "global");
    McpTargetCheck {
        harness_id: target.harness_id.clone(),
        location_id,
        status,
        note: (!writes.is_empty())
            .then(|| effect_note(&target.harness_id, project))
            .flatten(),
        writes,
        reason,
        key_hint: KeyHint::Quiet,
        gitignore_line: None,
    }
}

/// 安装页「写进哪些 agent」每一行（R10）：请求里每个 agent 一条，按请求的先后。
/// `harnesses` 是 agent 表（至少含请求里的，带显示名；Claude Desktop 由 `discovery::mcp_columns` 带进来）。
/// `request.values` 可以为空或只填了一部分：没填的占位按「填什么都行」比对已有的定义
pub fn check_targets(
    env: &Env,
    harnesses: &[Harness],
    request: &McpInstallRequest,
) -> Vec<McpTargetCheck> {
    let built = build_all(request, Mode::Check, harnesses);
    let repo = ProjectRepo::of(request);
    resolve_targets(env, harnesses, request)
        .iter()
        .map(|target| {
            let mut check = check_one(target, &built);
            // 没填的占位按「会填进一个值」看（`probe` 里换成了普通字）：所在位置的名字像密钥的就是要写进去的密钥
            let mut writes = built.iter().filter(|b| check.writes.contains(&b.name));
            check.key_hint = repo.hint(target, || {
                writes.any(|b| has_key_values(&b.probe) || key_holes(request, &b.name, Mode::Check))
            });
            // 要提醒的列在提示框里，已被跟踪的列在说明里（多个文件时写出是哪几个）
            if matches!(check.key_hint, KeyHint::Remind | KeyHint::Tracked) {
                check.gitignore_line = repo.line_for(target);
            }
            check
        })
        .collect()
}

/// 定义模板里要填的占位名字像密钥（`${OPENAI_API_KEY}`）：填进去的就是密钥。检查时值还不给后端，按「会填」算；
/// 写的时候只算真填了的（选填没填的那一项整项不写，没有密钥）。检查时出了提醒、填了写进去就一定还算
fn key_holes(request: &McpInstallRequest, name: &str, mode: Mode) -> bool {
    let filled =
        |key: &str| matches!(mode, Mode::Check) || value_of(&request.values, key).is_some();
    request
        .definitions
        .iter()
        .filter(|def| def.name == name)
        .flat_map(|def| {
            def.command
                .iter()
                .chain(&def.args)
                .chain(def.env.values())
                .chain(&def.url)
                .chain(def.headers.values())
        })
        .any(|text| {
            placeholders(text)
                .iter()
                .any(|(_, key)| secretish(key) && filled(key))
        })
}

/// 安装页的项目（位置是项目时）
struct ProjectRepo {
    root: Option<PathBuf>,
}

impl ProjectRepo {
    fn of(request: &McpInstallRequest) -> Self {
        Self {
            root: projects_of(&request.location).and_then(|p| p.into_iter().next()),
        }
    }

    /// 这个目标写的是不是项目里的文件：是就给项目根（项目根是软链接时为真实路径）与它在 `.gitignore` 里的那一行。
    /// Claude Code 仅自己写的是 `~/.claude.json` 里项目那一格（有 `selector`），不进仓库
    fn project_line(&self, target: &Target) -> Option<(PathBuf, String)> {
        let root = self.root.as_deref()?;
        let location = target.location.as_ref()?;
        if location.selector.is_some() {
            return None;
        }
        keyhint::project_line(root, &location.path)
    }

    fn root_for(&self, target: &Target) -> Option<PathBuf> {
        self.project_line(target).map(|(root, _)| root)
    }

    /// 这个项目文件在项目根 `.gitignore` 里会写成的那一行
    fn line_for(&self, target: &Target) -> Option<String> {
        self.project_line(target).map(|(_, line)| line)
    }

    /// 密钥提醒（S19）：安装页的来源是市场或粘贴的配置，按「不在仓库里」。`has_key` 只对项目文件才算
    fn hint(&self, target: &Target, has_key: impl FnOnce() -> bool) -> KeyHint {
        let Some(location) = target
            .location
            .as_ref()
            .filter(|_| self.root_for(target).is_some())
        else {
            return KeyHint::Quiet;
        };
        let has_key = has_key();
        // 没有密钥就不必问 git：结果一样是不处理。目标文件问 git：在不在仓库里、是不是已被忽略
        let target_git = if has_key {
            keyhint::probe(&location.path)
        } else {
            GitFacts::default()
        };
        keyhint::decide(has_key, GitFacts::default(), target_git)
    }
}

fn report_entry(name: &str, target_id: &str, outcome: &str, message: &str) -> McpReportEntry {
    McpReportEntry {
        name: name.to_owned(),
        target_id: target_id.to_owned(),
        outcome: outcome.into(),
        message: message.into(),
        backup_path: None,
        mirror_failed: None,
    }
}

/// 把定义写进请求里勾选的 agent（R8 / R10）。填的值替换 `${KEY}`；选填没填的（整个值就是占位）
/// 整项不写，其余还空着占位的那条不写。能写的按文件一批：文本级插入、备份、原子替换，
/// 报告里 `created`；已有一样的、写不过去的是 `skipped` + 原因；写的时候出错是 `failed`。
/// 撤销记录在报告里（`take_undo`），与 MCP 页的写入同一种，交给 `mcp_undo_write`。
/// 会写 `~/.codex/config.toml`：调用方先拿 `config_lock`
/// 改已有文件前的备份放进 `backups`（Sophia 的备份目录，见 `atomicfile::backup`）
pub fn write_definitions(
    env: &Env,
    harnesses: &[Harness],
    request: &McpInstallRequest,
    backups: &Path,
) -> McpReport {
    let built = build_all(request, Mode::Write, harnesses);
    let mut private = Vec::new();
    let mut skipped = Vec::new();
    let targets = resolve_targets(env, harnesses, request);
    for target in &targets {
        let target_id = target.id();
        for def in &built {
            match verdict(target, def) {
                Verdict::New => {
                    let (Some(location), Some(parsed)) = (&target.location, &target.parsed) else {
                        continue;
                    };
                    // 没有来源文件：来源一栏填目标自己。`execute` 写前核对「来源与目标都没变」，
                    // 于是核对的就是目标从检查到写之间有没有被别人改过
                    private.push(Pending {
                        action: McpAction {
                            source_id: "market".into(),
                            target_id: location.id.clone(),
                            name: def.name.clone(),
                            source_path: location.path.clone(),
                            target_path: location.path.clone(),
                            cross_domain: false,
                        },
                        source: parsed.state.clone(),
                        target: parsed.state.clone(),
                        target_location: location.clone(),
                        definition: def.canon.clone(),
                        mirror: false,
                        also_from: Vec::new(),
                    });
                }
                Verdict::Same => skipped.push(report_entry(
                    &def.name,
                    &target_id,
                    "skipped",
                    &crate::t!("mcp.report.sameSkipped"),
                )),
                Verdict::Bad(reason) => {
                    skipped.push(report_entry(&def.name, &target_id, "skipped", &reason))
                }
            }
        }
    }
    // Claude Desktop 第三方模式的那一份跟着写（`McpLocation::mirrors`）
    let (private, mirror_failures) = with_mirrors(private);
    let plan = PreparedPlan {
        actions: plan_actions(&private),
        issues: Vec::new(),
        private,
        mirror_failures,
    };
    let mut report = execute(plan, false, backups);
    report.entries.extend(skipped);
    ignore_written_keys(request, &targets, &built, &mut report, backups);
    report
}

/// 密钥提醒（S19）：写成了的项目文件，按判断加进项目根的 `.gitignore`——来源被忽略的照搬（安装页不会有），
/// 第一次暴露的看用户勾没勾「同时加进 .gitignore」。没写成的记进 `gitignore_failed`，配置照样算写成
fn ignore_written_keys(
    request: &McpInstallRequest,
    targets: &[Target],
    built: &[Built],
    report: &mut McpReport,
    backups: &Path,
) {
    let repo = ProjectRepo::of(request);
    for target in targets {
        let (Some(location), Some(root)) = (&target.location, repo.root_for(target)) else {
            continue;
        };
        let created = |b: &&Built| {
            report
                .entries
                .iter()
                .any(|e| e.outcome == "created" && e.target_id == location.id && e.name == b.name)
        };
        let mut created = built.iter().filter(created);
        let hint = repo.hint(target, || {
            created.any(|b| has_key_values(&b.canon) || key_holes(request, &b.name, Mode::Write))
        });
        let wanted = match hint {
            KeyHint::AutoIgnore => true,
            KeyHint::Remind => request.add_to_gitignore,
            // 已被跟踪的加了也挡不住：勾了（为别的文件）也不加
            KeyHint::Quiet | KeyHint::SourceCommitted | KeyHint::Tracked => false,
        };
        if !wanted {
            continue;
        }
        match keyhint::add_to_gitignore(&root, &location.path, backups) {
            // 撤销这次安装时，追加的那一行一起撤回（新建的 .gitignore 删掉）
            Ok(Some(edit)) => report.undo.record_edit(edit),
            Ok(None) => {}
            Err(error) => {
                let gitignore = root.join(".gitignore");
                report.gitignore_failed = Some(crate::t!(
                    "mcp.report.gitignoreFailed",
                    reason = crate::atomicfile::write_error_text(&gitignore, &error)
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::undo_write;
    use crate::test_support::{backups, TempTree};
    use std::fs;
    use std::path::Path;

    const SECRET: &str = "ghp_S3cretValue0123456789";

    fn harness(id: &str, name: &str) -> Harness {
        Harness {
            id: id.into(),
            display_name: name.into(),
            project_dir: None,
            global_dir: None,
            universal: false,
            agent_dirs: Vec::new(),
            managed_global_dir: false,
            agent_labels: None,
        }
    }

    fn six() -> Vec<Harness> {
        vec![
            harness("claude-code", "Claude Code"),
            harness("codex", "Codex"),
            harness("cursor", "Cursor"),
            harness("gemini-cli", "Gemini CLI"),
            harness("claude-desktop", "Claude Desktop"),
            harness("github-copilot", "GitHub Copilot"),
        ]
    }

    fn env(home: &Path) -> Env {
        Env {
            apps: Vec::new(),
            home: home.to_path_buf(),
            vars: Default::default(),
        }
    }

    fn desktop_path(env: &Env) -> Option<PathBuf> {
        agents::agent("claude-desktop").unwrap().user_path(env)
    }

    fn github() -> McpDefinitionInput {
        McpDefinitionInput {
            name: "github".into(),
            transport: McpTransport::Http,
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            url: Some("https://api.githubcopilot.com/mcp/".into()),
            headers: [("Authorization".into(), "Bearer ${GITHUB_TOKEN}".into())].into(),

            extra: BTreeMap::new(),
            dialect: None,
        }
    }

    fn filesystem() -> McpDefinitionInput {
        McpDefinitionInput {
            name: "filesystem".into(),
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                "/tmp".into(),
            ],
            // 选填、没填：整项不写
            env: [("FS_DEBUG".into(), "${FS_DEBUG}".into())].into(),
            url: None,
            headers: BTreeMap::new(),
            extra: BTreeMap::new(),
            dialect: None,
        }
    }

    fn request(
        definitions: Vec<McpDefinitionInput>,
        location: &str,
        ids: &[&str],
        values: &[(&str, &str)],
    ) -> McpInstallRequest {
        McpInstallRequest {
            definitions,
            location: location.into(),
            harness_ids: ids.iter().map(|id| id.to_string()).collect(),
            values: values
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            claude_code_scope: None,
            add_to_gitignore: false,
        }
    }

    fn check<'a>(checks: &'a [McpTargetCheck], id: &str) -> &'a McpTargetCheck {
        checks.iter().find(|c| c.harness_id == id).unwrap()
    }

    fn servers(text: &str) -> Vec<McpDefinitionInput> {
        let result = parse_mcp_text(text);
        assert_eq!(result.error, None, "{text}");
        result.servers
    }

    fn error(text: &str) -> McpParseError {
        let result = parse_mcp_text(text);
        assert!(result.servers.is_empty());
        result.error.expect("应当报错")
    }

    fn names(defs: &[McpDefinitionInput]) -> Vec<&str> {
        defs.iter().map(|d| d.name.as_str()).collect()
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// `after` 只比 `before` 多了连续的一段（原有字节一个没动）
    fn only_inserted(before: &[u8], after: &[u8]) {
        let prefix = before.iter().zip(after).take_while(|(a, b)| a == b).count();
        let suffix = before[prefix..]
            .iter()
            .rev()
            .zip(after[prefix..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        assert_eq!(prefix + suffix, before.len(), "原有内容被改动了");
    }

    fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files_under(&path, out);
            } else {
                out.push(path);
            }
        }
    }

    // ===== 解析（R8，AC12）=====

    #[test]
    fn parses_four_wrappers_in_source_order() {
        let defs = servers(
            r#"{
  "mcpServers": {
    "zeta": { "command": "npx", "args": ["-y", "server-filesystem", "/tmp"], "env": {"DEBUG": "1", "PORT": 8080} },
    "alpha": { "type": "http", "url": "https://api.example.com/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"} }
  }
}"#,
        );
        assert_eq!(names(&defs), ["zeta", "alpha"], "按原文先后，不按字母");
        assert_eq!(defs[0].transport, McpTransport::Stdio);
        assert_eq!(defs[0].command.as_deref(), Some("npx"));
        assert_eq!(defs[0].args, ["-y", "server-filesystem", "/tmp"]);
        assert_eq!(defs[0].env["PORT"], "8080");
        assert_eq!(defs[1].transport, McpTransport::Http);
        assert_eq!(defs[1].headers["Authorization"], "Bearer ${TOKEN}");

        let vscode =
            servers(r#"{"servers": {"gh": {"type": "sse", "url": "https://x.example/sse"}}}"#);
        assert_eq!(vscode[0].transport, McpTransport::Sse);
        let zed = servers(
            r#"{"context_servers": {"git": {"source": "custom", "command": "uvx", "args": ["mcp-server-git"], "env": {}}}}"#,
        );
        assert_eq!(zed[0].name, "git");
        assert_eq!(zed[0].transport, McpTransport::Stdio);
        let json_codex = servers(r#"{"mcp_servers": {"c": {"command": "c"}}}"#);
        assert_eq!(json_codex[0].command.as_deref(), Some("c"));
        let vscode_settings = servers(
            r#"{"editor.fontSize": 13, "mcp": {"servers": {"v": {"type": "stdio", "command": "x"}}}}"#,
        );
        assert_eq!(names(&vscode_settings), ["v"]);
    }

    #[test]
    fn maps_gemini_and_copilot_fields() {
        let gemini = servers(
            r#"{"mcpServers": {
  "g1": {"httpUrl": "https://h.example/mcp"},
  "g2": {"url": "https://h.example/sse"},
  "g3": {"url": "https://h.example/mcp"}
}}"#,
        );
        let transports: Vec<_> = gemini.iter().map(|d| d.transport).collect();
        assert_eq!(
            transports,
            [McpTransport::Http, McpTransport::Sse, McpTransport::Http]
        );
        assert_eq!(gemini[0].url.as_deref(), Some("https://h.example/mcp"));
        let copilot = servers(
            r#"{"mcpServers": {"cp": {"type": "local", "command": "node", "args": ["s.js"], "tools": ["*"]}}}"#,
        );
        assert_eq!(copilot[0].transport, McpTransport::Stdio);
        assert_eq!(copilot[0].args, ["s.js"]);
    }

    #[test]
    fn parses_single_object_fragment_and_bare_map() {
        let single = servers(r#"{"command": "npx", "args": ["-y", "pkg"]}"#);
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].name, "", "单个服务器对象没有名字，界面要用户补");
        let fragment =
            servers("\"github\": {\n  \"url\": \"https://api.githubcopilot.com/mcp/\"\n},\n");
        assert_eq!(names(&fragment), ["github"]);
        assert_eq!(fragment[0].transport, McpTransport::Http);
        let bare = servers(r#"{"a": {"command": "x"}, "b": {"url": "https://b.example/mcp"}}"#);
        assert_eq!(names(&bare), ["a", "b"]);
        // BOM 不挡路
        assert_eq!(
            servers("\u{feff}{\"mcpServers\": {\"a\": {\"command\": \"x\"}}}").len(),
            1
        );
    }

    #[test]
    fn parses_codex_toml() {
        let defs = servers(
            r#"# Codex
[mcp_servers.remote]
url = "https://r.example/mcp"
http_headers = { "X-Key" = "abc" }

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
enabled = true

[mcp_servers.docs.env]
API_KEY = "${DOCS_KEY}"
"#,
        );
        assert_eq!(names(&defs), ["remote", "docs"]);
        assert_eq!(defs[0].transport, McpTransport::Http);
        assert_eq!(defs[0].headers["X-Key"], "abc");
        assert_eq!(defs[1].transport, McpTransport::Stdio);
        assert_eq!(defs[1].env["API_KEY"], "${DOCS_KEY}");
        let single = servers("command = \"uvx\"\nargs = [\"mcp-server-time\"]\n");
        assert_eq!(single[0].name, "");
        assert_eq!(single[0].args, ["mcp-server-time"]);
    }

    #[test]
    fn broken_input_names_the_line() {
        let missing_comma = error(
            "{\n  \"mcpServers\": {\n    \"a\": { \"command\": \"x\" }\n    \"b\": { \"command\": \"y\" }\n  }\n}\n",
        );
        assert_eq!(missing_comma.line, Some(4));
        assert!(
            missing_comma.message.starts_with("第 4 行："),
            "{}",
            missing_comma.message
        );
        let trailing = error("{\n  \"mcpServers\": {\n    \"a\": { \"command\": \"x\" },\n  }\n}");
        assert_eq!(trailing.line, Some(4));
        assert!(trailing.message.contains("逗号"), "{}", trailing.message);
        let comment = error("{\n  // 我的服务器\n  \"mcpServers\": {}\n}");
        assert_eq!(comment.line, Some(2));
        assert!(comment.message.contains("注释"));
        let duplicate = error(
            "{\"mcpServers\": {\n\"a\": {\"command\": \"x\"},\n\"a\": {\"command\": \"y\"}\n}}",
        );
        assert_eq!(duplicate.line, Some(3));
        assert!(duplicate.message.contains("重复"));
        let toml = error("[mcp_servers.x]\ncommand = npx\n");
        assert_eq!(toml.line, Some(2));
        assert!(
            toml.message.starts_with("第 2 行：TOML"),
            "{}",
            toml.message
        );
        let eof = error("{\n  \"mcpServers\": {\n    \"a\": {\"command\": \"x\"}\n");
        assert!(eof.message.contains("没有结束"), "{}", eof.message);
    }

    #[test]
    fn extra_fields_are_kept_with_their_dialect() {
        // Gemini 专属的 trust：不再整段拒绝，原样留在 extra，认出是 Gemini CLI 的
        let gemini = servers(
            "{\n  \"mcpServers\": {\n    \"g\": {\n      \"command\": \"npx\",\n      \"trust\": true\n    }\n  }\n}",
        );
        assert_eq!(
            gemini[0].extra,
            [("trust".to_string(), Value::Bool(true))].into()
        );
        assert_eq!(gemini[0].dialect.as_deref(), Some("gemini-cli"));
        // Codex 的 TOML：值换成 JSON
        let codex = servers(
            "[mcp_servers.x]\ncommand = \"npx\"\nstartup_timeout_sec = 20\ntool_timeout_sec = 1.5\n",
        );
        assert_eq!(codex[0].dialect.as_deref(), Some("codex"));
        assert_eq!(codex[0].extra["startup_timeout_sec"], serde_json::json!(20));
        assert_eq!(codex[0].extra["tool_timeout_sec"], serde_json::json!(1.5));
        // Copilot 的非全部 tools
        let copilot = servers(
            r#"{"mcpServers": {"cp": {"type": "local", "command": "node", "tools": ["read"]}}}"#,
        );
        assert_eq!(copilot[0].dialect.as_deref(), Some("github-copilot"));
        assert_eq!(copilot[0].extra["tools"], serde_json::json!(["read"]));
        // Zed 的外层；认不出出处的（Cline 一类的 disabled）dialect 为 None
        let zed = servers(r#"{"context_servers": {"z": {"command": "z", "settings": {"k": 1}}}}"#);
        assert_eq!(zed[0].dialect.as_deref(), Some("zed"));
        assert!(zed[0].extra.contains_key("settings"));
        let disabled =
            servers("{\"mcpServers\": {\"a\": {\"command\": \"x\",\n\"disabled\": true}}}");
        assert_eq!(disabled[0].dialect, None);
        assert_eq!(disabled[0].extra["disabled"], Value::Bool(true));
        // 取默认值的略过：删了意思不变
        let defaults = servers(
            r#"{"mcpServers": {"a": {"command": "x", "disabled": false, "autoApprove": [], "alwaysAllow": [], "enabled": true}}}"#,
        );
        assert!(defaults[0].extra.is_empty());
        // 那一家接得住的字段，值写法不对：仍按行号报
        let bad_timeout =
            error("[mcp_servers.x]\ncommand = \"npx\"\nstartup_timeout_sec = \"slow\"\n");
        assert_eq!(bad_timeout.line, Some(3));
        assert!(
            bad_timeout.message.contains("startup_timeout_sec"),
            "{}",
            bad_timeout.message
        );
        let bad_tools = error(
            "{\"mcpServers\": {\"cp\": {\"type\": \"local\", \"command\": \"x\",\n\"tools\": 5}}}",
        );
        assert_eq!(bad_tools.line, Some(2));
        let helper_on_stdio = error(
            "{\"mcpServers\": {\"h\": {\"command\": \"x\",\n\"headersHelper\": \"get-token\"}}}",
        );
        assert_eq!(helper_on_stdio.line, Some(2));
    }

    #[test]
    fn malformed_servers_are_refused() {
        let both =
            error("{\"mcpServers\": {\n\"a\": {\"command\": \"x\", \"url\": \"https://a/mcp\"}}}");
        assert_eq!(both.line, Some(2));
        assert!(both.message.contains("同时有 command 和 url"));
        assert!(error("{\"mcpServers\": {\"a\": {\"args\": []}}}")
            .message
            .contains("没有 command，也没有 url"));
        let args =
            error("{\"mcpServers\": {\"a\": {\n\"command\": \"x\",\n\"args\": [\"--port\", 80]}}}");
        assert_eq!(args.line, Some(3));
        assert!(args.message.contains("args"));
        assert!(
            error("{\"mcpServers\": {\"a\": {\"type\": \"ws\", \"url\": \"wss://a\"}}}")
                .message
                .contains("认不得连接方式 ws")
        );
        assert!(
            error("{\"mcpServers\": {\"a\": {\"url\": \"https://a/mcp\", \"env\": {}}}}")
                .message
                .contains("远程服务器不该有 env")
        );
        assert_eq!(error("   ").message, "没有内容");
        assert!(error("[1, 2]").message.contains("最外层"));
        assert!(error("{\"theme\": \"dark\"}")
            .message
            .contains("认不出 MCP 配置"));
        assert!(error("{\"mcpServers\": {}}")
            .message
            .contains("没有 MCP 服务器"));
    }

    #[test]
    fn placeholders_become_fields_to_fill() {
        let defs = servers(
            r#"{"mcpServers": {
  "a": {"command": "npx", "args": ["${ROOT}"], "env": {"API_KEY": "${API_KEY}"}},
  "b": {"url": "https://b.example/mcp", "headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"}}
}}"#,
        );
        let fields = placeholder_fields(&defs);
        let summary: Vec<_> = fields
            .iter()
            .map(|f| (f.key.as_str(), f.kind, f.secret, f.required))
            .collect();
        assert_eq!(
            summary,
            [
                ("ROOT", McpFieldKind::Arg, false, true),
                ("API_KEY", McpFieldKind::Env, true, true),
                ("GITHUB_TOKEN", McpFieldKind::Header, true, true),
            ]
        );
        assert!(placeholder_fields(&[filesystem()])[0].key == "FS_DEBUG");
    }

    #[test]
    fn glob_treats_unfilled_placeholders_as_wildcards() {
        assert!(glob("Bearer ${T}", "Bearer abc"));
        assert!(glob("${A}-${B}", "x-y"));
        assert!(!glob("Bearer ${T}", "Basic abc"));
        assert!(glob("plain", "plain"));
        assert!(!glob("plain", "plain2"));
        assert!(!glob("a${X}a", "a"));
    }

    // ===== 写进哪些 agent（R10，AC11 AC12）=====

    #[test]
    fn desktop_only_takes_the_local_command() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        if desktop_path(&env).is_none() {
            return; // 这个平台上没有 Claude Desktop
        }
        // AC12：粘贴含远程 github 与本机 filesystem 的 mcpServers
        let pasted = servers(
            r#"{"mcpServers": {
  "github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"}},
  "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}
}}"#,
        );
        let ids = ["claude-code", "codex", "claude-desktop", "gemini-cli"];
        let checks = check_targets(&env, &six(), &request(pasted.clone(), "global", &ids, &[]));
        assert_eq!(checks.len(), 4);
        let code = check(&checks, "claude-code");
        assert_eq!(code.status, McpTargetStatus::Ok);
        assert_eq!(code.writes, ["github", "filesystem"]);
        assert_eq!(code.location_id.as_deref(), Some("claude-code"));
        assert_eq!(code.note, None);
        assert_eq!(check(&checks, "codex").status, McpTargetStatus::Ok);
        assert_eq!(
            check(&checks, "gemini-cli").note.as_deref(),
            Some("新开会话后生效")
        );
        let desktop = check(&checks, "claude-desktop");
        assert_eq!(desktop.status, McpTargetStatus::Partial);
        assert_eq!(desktop.writes, ["filesystem"]);
        assert_eq!(
            desktop.reason.as_deref(),
            Some(
                "只写 filesystem · github 是远程服务器，要在 Claude Desktop 自己的「连接器」里添加"
            )
        );
        assert_eq!(desktop.note.as_deref(), Some("重启 Claude Desktop 后生效"));

        // 只有远程的：一个都写不过去，不能勾，沿用 MCP 页的原因句
        let only_remote = check_targets(
            &env,
            &six(),
            &request(vec![github()], "global", &["claude-desktop"], &[]),
        );
        assert_eq!(only_remote[0].status, McpTargetStatus::Blocked);
        assert_eq!(
            only_remote[0].reason.as_deref(),
            Some(desktop_remote().as_str())
        );
        assert!(only_remote[0].writes.is_empty() && only_remote[0].note.is_none());

        // 添加后 Desktop 配置里只有 filesystem
        let mut report = write_definitions(
            &env,
            &six(),
            &request(
                pasted,
                "global",
                &["claude-desktop"],
                &[("GITHUB_TOKEN", SECRET)],
            ),
            backups(),
        );
        let outcomes: Vec<_> = report
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.outcome.as_str()))
            .collect();
        assert_eq!(outcomes, [("filesystem", "created"), ("github", "skipped")]);
        let written: Value =
            serde_json::from_slice(&fs::read(desktop_path(&env).unwrap()).unwrap()).unwrap();
        let keys: Vec<_> = written["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["filesystem"]);
        assert!(!serde_json::to_string(&written).unwrap().contains(SECRET));
        assert!(report.take_undo().is_some());
    }

    #[test]
    fn existing_entries_block_or_skip() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        // Codex 里的 github 指向别处
        write(
            &home.join(".codex/config.toml"),
            b"[mcp_servers.github]\nurl = \"https://other.example/mcp\"\n",
        );
        // Claude Code 里已经有一样的 github（令牌 tok-1）
        let claude = home.join(".claude.json");
        write(
            &claude,
            br#"{"mcpServers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer tok-1"}}}}"#,
        );
        let ids = ["claude-code", "codex", "cursor"];
        let checks = check_targets(&env, &six(), &request(vec![github()], "global", &ids, &[]));
        let codex = check(&checks, "codex");
        assert_eq!(codex.status, McpTargetStatus::Blocked);
        assert_eq!(
            codex.reason.as_deref(),
            Some("Codex 里已经有一个不一样的 github")
        );
        // 还没填令牌：占位当通配，与已有的比得上
        assert_eq!(check(&checks, "claude-code").status, McpTargetStatus::Same);
        assert_eq!(check(&checks, "cursor").status, McpTargetStatus::Ok);

        let other_token = check_targets(
            &env,
            &six(),
            &request(
                vec![github()],
                "global",
                &["claude-code"],
                &[("GITHUB_TOKEN", "tok-2")],
            ),
        );
        assert_eq!(
            other_token[0].reason.as_deref(),
            Some("Claude Code 里已经有一个不一样的 github")
        );

        // 一样的跳过、不算失败，文件一个字节不动
        let before = fs::read(&claude).unwrap();
        let mut report = write_definitions(
            &env,
            &six(),
            &request(
                vec![github()],
                "global",
                &["claude-code"],
                &[("GITHUB_TOKEN", "tok-1")],
            ),
            backups(),
        );
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].outcome, "skipped");
        assert_eq!(fs::read(&claude).unwrap(), before);
        assert!(report.take_undo().is_none());

        // 部分一样、部分新：只写新的，状态是能写
        let mixed = check_targets(
            &env,
            &six(),
            &request(
                vec![github(), filesystem()],
                "global",
                &["claude-code"],
                &[],
            ),
        );
        assert_eq!(mixed[0].status, McpTargetStatus::Ok);
        assert_eq!(mixed[0].writes, ["filesystem"]);

        // SSE 进不了 Cursor；Claude Desktop 没有项目级
        let mut sse = github();
        sse.transport = McpTransport::Sse;
        sse.url = Some("https://x.example/sse".into());
        let project = tree.dir("proj");
        let key = format!("project:{}", project.display());
        let checks = check_targets(
            &env,
            &six(),
            &request(vec![sse], &key, &["cursor", "claude-desktop"], &[]),
        );
        assert_eq!(
            check(&checks, "cursor").reason.as_deref(),
            Some("Cursor 不支持 SSE 传输")
        );
        let desktop = check(&checks, "claude-desktop");
        assert_eq!(desktop.status, McpTargetStatus::Blocked);
        assert_eq!(desktop.location_id, None);
        assert_eq!(
            desktop.reason.as_deref(),
            Some("Claude Desktop 没有项目级的 MCP")
        );
    }

    #[test]
    fn project_location_writes_project_files() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("proj");
        let env = env(&home);
        let key = format!("project:{}", project.display());
        let mut request = request(
            vec![filesystem()],
            &key,
            &["claude-code", "github-copilot"],
            &[],
        );
        // team：Claude Code 写项目的 .mcp.json
        request.claude_code_scope = Some("team".into());
        let checks = check_targets(&env, &six(), &request);
        let code = check(&checks, "claude-code");
        assert_eq!(
            code.location_id,
            Some(format!("project:{}::claude-code", project.display()))
        );
        assert_eq!(
            check(&checks, "github-copilot").note.as_deref(),
            Some("新开会话后生效 · 在 Copilot 里信任这个文件夹后生效")
        );
        let report = write_definitions(&env, &six(), &request, backups());
        assert!(report.entries.iter().all(|e| e.outcome == "created"));
        let mcp: Value =
            serde_json::from_slice(&fs::read(project.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["filesystem"]["command"], "npx");
        assert!(
            mcp["mcpServers"]["filesystem"].get("env").is_none(),
            "选填没填的整项不写"
        );
        let copilot: Value =
            serde_json::from_slice(&fs::read(project.join(".github/mcp.json")).unwrap()).unwrap();
        assert_eq!(copilot["mcpServers"]["filesystem"]["type"], "local");
        assert!(!home.join(".claude.json").exists(), "项目位置不碰用户级");
    }

    // ===== Claude Code 写哪一格（R8）=====

    fn local_id(project: &Path) -> String {
        format!("project:{}::claude-code:local", project.display())
    }

    #[test]
    fn project_claude_code_defaults_to_local_config() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("proj");
        let env = env(&home);
        let key = format!("project:{}", project.display());
        // 没写 scope 与写 self 一样；~/.claude.json 本身还不存在也能建出来
        for scope in [None, Some("self".to_string())] {
            let mut request = request(vec![filesystem()], &key, &["claude-code"], &[]);
            request.claude_code_scope = scope;
            let checks = check_targets(&env, &six(), &request);
            let code = check(&checks, "claude-code");
            assert_eq!(code.status, McpTargetStatus::Ok, "{code:?}");
            assert_eq!(code.location_id, Some(local_id(&project)));
        }
        let request = request(vec![filesystem()], &key, &["claude-code"], &[]);
        let report = write_definitions(&env, &six(), &request, backups());
        assert!(
            report.entries.iter().all(|e| e.outcome == "created"),
            "{:?}",
            report.entries
        );
        let claude: Value =
            serde_json::from_slice(&fs::read(home.join(".claude.json")).unwrap()).unwrap();
        let servers = &claude["projects"][project.to_string_lossy().as_ref()]["mcpServers"];
        assert_eq!(servers["filesystem"]["command"], "npx");
        assert!(
            !project.join(".mcp.json").exists(),
            "默认仅自己：不创建仓库里的 .mcp.json"
        );
    }

    #[test]
    fn project_claude_code_team_writes_mcp_json_only() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("proj");
        let env = env(&home);
        let claude = home.join(".claude.json");
        let before = b"{\"numStartups\": 3, \"projects\": {}}".to_vec();
        write(&claude, &before);
        let key = format!("project:{}", project.display());
        let mut request = request(vec![filesystem()], &key, &["claude-code"], &[]);
        request.claude_code_scope = Some("team".into());
        let checks = check_targets(&env, &six(), &request);
        assert_eq!(
            check(&checks, "claude-code").location_id,
            Some(format!("project:{}::claude-code", project.display()))
        );
        let report = write_definitions(&env, &six(), &request, backups());
        assert!(report.entries.iter().all(|e| e.outcome == "created"));
        let mcp: Value =
            serde_json::from_slice(&fs::read(project.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(
            fs::read(&claude).unwrap(),
            before,
            "team 不碰 ~/.claude.json"
        );
    }

    #[test]
    fn project_local_write_adds_project_scope_and_keeps_other_bytes() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("proj");
        let env = env(&home);
        let claude = home.join(".claude.json");
        // 项目不在 projects 里；别的项目、顶层字段和排版都要原样保留
        let before = b"{\r\n  \"numStartups\": 3,\r\n  \"projects\": {\r\n    \"/other\": {\"mcpServers\": {\"x\": {\"command\": \"x\"}}}\r\n  }\r\n}\r\n".to_vec();
        write(&claude, &before);
        let key = format!("project:{}", project.display());
        let request = request(vec![filesystem()], &key, &["claude-code"], &[]);
        let report = write_definitions(&env, &six(), &request, backups());
        assert!(
            report.entries.iter().all(|e| e.outcome == "created"),
            "{:?}",
            report.entries
        );
        let after = fs::read(&claude).unwrap();
        only_inserted(&before, &after);
        let value: Value = serde_json::from_slice(&after).unwrap();
        assert_eq!(
            value["projects"][project.to_string_lossy().as_ref()]["mcpServers"]["filesystem"]
                ["command"],
            "npx"
        );
        assert_eq!(
            value["projects"]["/other"]["mcpServers"]["x"]["command"],
            "x"
        );
    }

    #[test]
    fn user_level_ignores_claude_code_scope() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        for scope in ["self", "team"] {
            let mut request = request(vec![filesystem()], "global", &["claude-code"], &[]);
            request.claude_code_scope = Some(scope.into());
            let checks = check_targets(&env, &six(), &request);
            let code = check(&checks, "claude-code");
            assert_eq!(code.location_id.as_deref(), Some("claude-code"));
            assert_eq!(code.status, McpTargetStatus::Ok, "{code:?}");
        }
        let mut request = request(vec![filesystem()], "global", &["claude-code"], &[]);
        request.claude_code_scope = Some("team".into());
        let report = write_definitions(&env, &six(), &request, backups());
        assert!(report.entries.iter().all(|e| e.outcome == "created"));
        let claude: Value =
            serde_json::from_slice(&fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(claude["mcpServers"]["filesystem"]["command"], "npx");
    }

    #[test]
    fn same_name_check_follows_selected_claude_code_scope() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("proj");
        let env1 = env(&home);
        let key = format!("project:{}", project.display());
        // 本地配置里已有一样的 filesystem
        let request_self = request(vec![filesystem()], &key, &["claude-code"], &[]);
        let report = write_definitions(&env1, &six(), &request_self, backups());
        assert!(report.entries.iter().all(|e| e.outcome == "created"));

        let checks = check_targets(&env1, &six(), &request_self);
        assert_eq!(check(&checks, "claude-code").status, McpTargetStatus::Same);
        let mut request_team = request_self.clone();
        request_team.claude_code_scope = Some("team".into());
        let checks = check_targets(&env1, &six(), &request_team);
        assert_eq!(
            check(&checks, "claude-code").status,
            McpTargetStatus::Ok,
            "team 按 .mcp.json 算，那里没有"
        );

        // 反过来：.mcp.json 有、本地配置没有
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("proj");
        let env = env(&home);
        let key = format!("project:{}", project.display());
        let mut request_team = request(vec![filesystem()], &key, &["claude-code"], &[]);
        request_team.claude_code_scope = Some("team".into());
        write_definitions(&env, &six(), &request_team, backups());
        let checks = check_targets(&env, &six(), &request_team);
        assert_eq!(check(&checks, "claude-code").status, McpTargetStatus::Same);
        let mut request_self = request_team.clone();
        request_self.claude_code_scope = None;
        let checks = check_targets(&env, &six(), &request_self);
        assert_eq!(check(&checks, "claude-code").status, McpTargetStatus::Ok);
    }

    // ===== 写入与撤销（R10 R11，AC11）=====

    #[test]
    fn write_inserts_bytes_and_undo_restores_exactly() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        let claude = home.join(".claude.json");
        let claude_before = b"{\r\n  \"numStartups\": 3,\r\n  \"mcpServers\": {\r\n    \"old\": {\"type\": \"stdio\", \"command\": \"old\"}\r\n  }\r\n}\r\n".to_vec();
        write(&claude, &claude_before);
        let codex = home.join(".codex/config.toml");
        let codex_before = "\u{feff}# 我的设置\r\nmodel = \"o3\"\r\n"
            .as_bytes()
            .to_vec();
        write(&codex, &codex_before);
        let cursor = home.join(".cursor/mcp.json");

        let request = request(
            vec![github(), filesystem()],
            "global",
            &["claude-code", "codex", "cursor"],
            &[("GITHUB_TOKEN", SECRET)],
        );
        let checks = check_targets(&env, &six(), &request);
        let mut report = write_definitions(&env, &six(), &request, backups());
        assert_eq!(report.entries.len(), 6, "{:?}", report.entries);
        assert!(
            report.entries.iter().all(|e| e.outcome == "created"),
            "{:?}",
            report.entries
        );

        let claude_after = fs::read(&claude).unwrap();
        only_inserted(&claude_before, &claude_after);
        let codex_after = fs::read(&codex).unwrap();
        assert!(
            codex_after.starts_with(&codex_before),
            "原文逐字节保留（含 BOM）"
        );
        assert!(
            codex_after
                .iter()
                .enumerate()
                .all(|(i, b)| *b != b'\n' || (i > 0 && codex_after[i - 1] == b'\r')),
            "CRLF 文件里不混进裸 LF"
        );
        for path in [&claude, &codex, &cursor] {
            let text = String::from_utf8(fs::read(path).unwrap()).unwrap();
            assert!(text.contains(SECRET), "{} 里应有令牌", path.display());
            assert!(!text.contains("FS_DEBUG"), "选填没填的整项不写");
            assert!(!text.contains("${"), "占位都换掉了");
        }
        // 写进去的读回来就是一样的
        let again = check_targets(&env, &six(), &request);
        assert!(
            again.iter().all(|c| c.status == McpTargetStatus::Same),
            "{again:?}"
        );

        // AC11：令牌只出现在目标配置文件里——检查结果、报告（序列化与调试输出）、备份里都没有
        let report_text = format!(
            "{}{report:?}{checks:?}",
            serde_json::to_string(&report).unwrap()
        );
        assert!(!report_text.contains(SECRET));
        let mut all = Vec::new();
        files_under(&tree.root(), &mut all);
        let mut holding: Vec<_> = all
            .into_iter()
            .filter(|path| String::from_utf8_lossy(&fs::read(path).unwrap()).contains(SECRET))
            .collect();
        holding.sort();
        let mut expected = vec![claude.clone(), codex.clone(), cursor.clone()];
        expected.sort();
        assert_eq!(holding, expected);

        // 撤销：逐字节回到写之前，新建的文件删掉
        let undo = report.take_undo().expect("有撤销记录");
        let result = undo_write(&undo);
        assert_eq!(result.outcome, "undone", "{result:?}");
        assert_eq!(fs::read(&claude).unwrap(), claude_before);
        assert_eq!(fs::read(&codex).unwrap(), codex_before);
        assert!(!cursor.exists());
    }

    #[test]
    fn unfilled_values_are_not_written() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        let mut report = write_definitions(
            &env,
            &six(),
            &request(vec![github()], "global", &["claude-code"], &[]),
            backups(),
        );
        assert_eq!(report.entries[0].outcome, "skipped");
        assert_eq!(report.entries[0].message, "github 还有没填的 GITHUB_TOKEN");
        assert!(!home.join(".claude.json").exists());
        assert!(report.take_undo().is_none());

        // 填的值里自己带 `${…}`：写进去会被当成变量
        let report = write_definitions(
            &env,
            &six(),
            &request(
                vec![github()],
                "global",
                &["claude-code"],
                &[("GITHUB_TOKEN", "${HOME}")],
            ),
            backups(),
        );
        assert!(report.entries[0].message.contains("GITHUB_TOKEN 的值里有"));
        assert!(!home.join(".claude.json").exists());
    }

    #[test]
    fn unusable_targets_say_why() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        write(&home.join(".cursor/mcp.json"), b"{ not json");
        let checks = check_targets(
            &env,
            &six(),
            &request(vec![filesystem()], "global", &["cursor", "opencode"], &[]),
        );
        assert_eq!(
            check(&checks, "cursor").reason.as_deref(),
            Some("Cursor 的配置无法解析或不安全")
        );
        assert_eq!(check(&checks, "opencode").status, McpTargetStatus::Blocked);
        let bad_location = check_targets(
            &env,
            &six(),
            &request(vec![filesystem()], "全部", &["cursor"], &[]),
        );
        assert_eq!(bad_location[0].reason.as_deref(), Some("认不出这个位置"));
        let mut nameless = filesystem();
        nameless.name.clear();
        let checks = check_targets(
            &env,
            &six(),
            &request(vec![nameless], "global", &["claude-code"], &[]),
        );
        assert_eq!(checks[0].reason.as_deref(), Some("服务名是空的"));
    }

    // ===== 专属字段（extra）只写进它出自的那一家 =====

    #[test]
    fn gemini_extras_go_only_to_gemini() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        let pasted = servers(
            r#"{"mcpServers": {
  "g": {"command": "npx", "args": ["-y", "g-mcp"], "trust": true, "timeout": 30000},
  "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}
}}"#,
        );
        let only_g = request(
            vec![pasted[0].clone()],
            "global",
            &["gemini-cli", "github-copilot", "cursor", "claude-code"],
            &[],
        );
        let checks = check_targets(&env, &six(), &only_g);
        let gemini = check(&checks, "gemini-cli");
        assert_eq!(gemini.status, McpTargetStatus::Ok, "{checks:?}");
        assert_eq!(gemini.writes, ["g"]);
        for (id, name) in [
            ("github-copilot", "GitHub Copilot"),
            ("cursor", "Cursor"),
            ("claude-code", "Claude Code"),
        ] {
            let target = check(&checks, id);
            assert_eq!(target.status, McpTargetStatus::Blocked);
            assert_eq!(
                target.reason.as_deref(),
                Some(
                    format!(
                        "带有 Gemini CLI 专属的设置（timeout 等 2 项），{name} 里没有对应的写法"
                    )
                    .as_str()
                )
            );
        }
        // 一次几个：别家照样能勾，只写没有专属设置的那个
        let both = request(pasted.clone(), "global", &["github-copilot"], &[]);
        let partial = &check_targets(&env, &six(), &both)[0];
        assert_eq!(partial.status, McpTargetStatus::Partial);
        assert_eq!(partial.writes, ["filesystem"]);
        assert_eq!(
            partial.reason.as_deref(),
            Some("只写 filesystem · g：带有 Gemini CLI 专属的设置（timeout 等 2 项），GitHub Copilot 里没有对应的写法")
        );

        // 写：Gemini 里原样带上 trust 与 timeout；别家一个文件都不建
        let mut report = write_definitions(&env, &six(), &only_g, backups());
        let outcomes: Vec<_> = report
            .entries
            .iter()
            .map(|e| (e.target_id.as_str(), e.outcome.as_str()))
            .collect();
        assert_eq!(
            outcomes.iter().filter(|(_, o)| *o == "created").count(),
            1,
            "{outcomes:?}"
        );
        let settings = home.join(".gemini/settings.json");
        let written: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        let g = &written["mcpServers"]["g"];
        assert_eq!(g["trust"], Value::Bool(true));
        assert_eq!(g["timeout"], serde_json::json!(30000));
        assert_eq!(g["command"], "npx");
        assert!(!home.join(".copilot/mcp-config.json").exists());
        assert!(!home.join(".cursor/mcp.json").exists());
        assert!(!home.join(".claude.json").exists());
        // 写进去的读回来是一样的；专属设置不同就不算一样
        let again = check_targets(
            &env,
            &six(),
            &request(vec![pasted[0].clone()], "global", &["gemini-cli"], &[]),
        );
        assert_eq!(again[0].status, McpTargetStatus::Same, "{again:?}");
        let mut untrusted = pasted[0].clone();
        untrusted.extra.insert("trust".into(), Value::Bool(false));
        let differs = check_targets(
            &env,
            &six(),
            &request(vec![untrusted], "global", &["gemini-cli"], &[]),
        );
        assert_eq!(
            differs[0].reason.as_deref(),
            Some("Gemini CLI 里已经有一个不一样的 g")
        );
        let undo = report.take_undo().expect("有撤销记录");
        assert_eq!(undo_write(&undo).outcome, "undone");
        assert!(!settings.exists());
    }

    #[test]
    fn codex_extras_go_only_to_codex() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        let pasted = servers(
            "[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"-y\", \"docs-mcp\"]\nstartup_timeout_sec = 20\n",
        );
        let ids = ["codex", "claude-code", "gemini-cli", "cursor"];
        let req = request(pasted, "global", &ids, &[]);
        let checks = check_targets(&env, &six(), &req);
        assert_eq!(
            check(&checks, "codex").status,
            McpTargetStatus::Ok,
            "{checks:?}"
        );
        for id in ["claude-code", "gemini-cli", "cursor"] {
            let target = check(&checks, id);
            assert_eq!(target.status, McpTargetStatus::Blocked);
            assert_eq!(
                target.reason.as_deref(),
                Some("Codex 客户端设置 startup_timeout_sec 无法跨工具无损迁移")
            );
        }
        let report = write_definitions(&env, &six(), &req, backups());
        let created: Vec<_> = report
            .entries
            .iter()
            .filter(|e| e.outcome == "created")
            .map(|e| e.target_id.as_str())
            .collect();
        assert_eq!(created, ["codex"], "{:?}", report.entries);
        let toml = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
        assert!(toml.contains("startup_timeout_sec = 20"), "{toml}");
        let again = check_targets(
            &env,
            &six(),
            &request(req.definitions.clone(), "global", &["codex"], &[]),
        );
        assert_eq!(again[0].status, McpTargetStatus::Same, "{again:?}");
        assert!(!home.join(".claude.json").exists());
    }

    #[test]
    fn unrecognised_extras_are_refused_everywhere() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        let all = [
            "claude-code",
            "codex",
            "cursor",
            "gemini-cli",
            "github-copilot",
        ];
        // 认不出出处
        let unknown = servers(r#"{"mcpServers": {"a": {"command": "x", "disabled": true}}}"#);
        let checks = check_targets(&env, &six(), &request(unknown.clone(), "global", &all, &[]));
        for c in &checks {
            assert_eq!(c.status, McpTargetStatus::Blocked, "{c:?}");
            assert_eq!(
                c.reason.as_deref(),
                Some("带有认不得的字段（disabled），照写会丢掉它")
            );
        }
        let report = write_definitions(
            &env,
            &six(),
            &request(unknown, "global", &all, &[]),
            backups(),
        );
        assert!(report.entries.iter().all(|e| e.outcome == "skipped"));
        // Codex 自己也写不了的 Codex 字段：连 Codex 也不写
        let codex = servers("[mcp_servers.x]\ncommand = \"x\"\nenabled_tools = [\"a\"]\n");
        let checks = check_targets(&env, &six(), &request(codex, "global", &all, &[]));
        assert!(checks.iter().all(|c| c.status == McpTargetStatus::Blocked
            && c.reason.as_deref() == Some("带有认不得的字段（enabled_tools），照写会丢掉它")));
        // 表外的一家（Zed）：哪一家都接不住，说出是谁的设置
        let zed = servers(r#"{"context_servers": {"z": {"command": "z", "settings": {"k": 1}}}}"#);
        let checks = check_targets(&env, &six(), &request(zed, "global", &["claude-code"], &[]));
        assert_eq!(
            checks[0].reason.as_deref(),
            Some("带有 Zed 专属的设置（settings），Claude Code 里没有对应的写法")
        );
        let mut report = write_definitions(
            &env,
            &six(),
            &request(
                servers(r#"{"mcpServers": {"a": {"command": "x", "disabled": true}}}"#),
                "global",
                &["claude-code"],
                &[],
            ),
            backups(),
        );
        assert!(report.take_undo().is_none());
        let mut leftovers = Vec::new();
        files_under(&home, &mut leftovers);
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn headers_helper_goes_to_agents_that_run_it() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env(&home);
        let pasted = servers(
            r#"{"mcpServers": {"h": {"type": "http", "url": "https://h.example/mcp", "headersHelper": "get-token"}}}"#,
        );
        assert_eq!(pasted[0].dialect.as_deref(), Some("claude-code"));
        let req = request(pasted, "global", &["claude-code", "codex", "cursor"], &[]);
        let checks = check_targets(&env, &six(), &req);
        assert_eq!(check(&checks, "claude-code").status, McpTargetStatus::Ok);
        assert_eq!(check(&checks, "codex").status, McpTargetStatus::Ok);
        assert_eq!(
            check(&checks, "cursor").reason.as_deref(),
            Some("Cursor 不支持用命令生成请求头")
        );
        let report = write_definitions(&env, &six(), &req, backups());
        assert_eq!(
            report
                .entries
                .iter()
                .filter(|e| e.outcome == "created")
                .count(),
            2,
            "{:?}",
            report.entries
        );
        let claude: Value =
            serde_json::from_slice(&fs::read(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(claude["mcpServers"]["h"]["headersHelper"], "get-token");
        let toml = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
        assert!(
            toml.contains("http_headers_helper = \"get-token\""),
            "{toml}"
        );
        let again = check_targets(&env, &six(), &req);
        assert!(
            again[..2].iter().all(|c| c.status == McpTargetStatus::Same),
            "{again:?}"
        );
    }
}

//! DeepSeek Harness 的 MCP 写法（#258，docs/research/2026-10-07-cn-desktop-agents.md §3.2）
//!
//! 补丁文件是一个 YAML 列表。加一个 MCP 服务器是一项 `- insert: [ {id, name, config} ]`，`name` 固定
//! `'@deepseek-ai/dsh-mcp-client'`，`config` 里 `serverName`（工具名前缀，`[A-Za-z0-9_-]{1,32}`）、
//! `transport`（`stdio` / `streamable-http`），其余字段与通用 JSON 写法同名（`command` / `args` / `env`、
//! `url` / `headers`）。
//!
//! 读：YAML 库只用来解析与核对，读成 JSON 值后按通用写法认连接字段。写：文本级，不整份重写——
//! 一条服务是末尾追加的一行（流式写法，id `sophia-mcp-<名字>`），删也只删这样的一行；用户自己的项、
//! 注释、排版一个字节不动。每次改写后重新解析核对：原有各项一个没变、新项读回来与要写的一致、
//! 文件没有变成空的或只剩注释（那样它启动不了，删到最后一项时写回 `[]`）
use super::{canon_json, refused, unverified, Canonical, Parsed, State};
use crate::fs::EntryKind;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};
use yaml_rust2::Yaml;

/// MCP 客户端插件的名字：`insert` 里 `name` 是它的那几项才是 MCP 服务器
const CLIENT: &str = "@deepseek-ai/dsh-mcp-client";

/// 一条服务的 `config` → 统一的定义：`serverName` 是名字不是连接字段；`transport` 就是通用写法里的 `type`
/// （`streamable-http` 通用读法本来就认）。没写 `transport` 的按读不懂（它是必填的）
pub(super) fn canon(config: &Value) -> Canonical {
    let Some(object) = config.as_object() else {
        return canon_json(config, None);
    };
    let mut object = object.clone();
    object.remove("serverName");
    let transport = object
        .remove("transport")
        .unwrap_or_else(|| Value::String(String::new()));
    object.insert("type".into(), transport);
    canon_json(&Value::Object(object), None)
}

/// 读补丁文件里的 MCP 服务器，按 `serverName` 成行（同名的只认第一项：它对后面那项报错）
pub(super) fn parse(bytes: &[u8], state: State) -> Parsed {
    let issue = |message: String| Parsed {
        values: BTreeMap::new(),
        issue: Some(message),
        state: state.clone(),
    };
    let Ok(text) = std::str::from_utf8(bytes) else {
        return issue(crate::t!("mcp.write.notUtf8"));
    };
    let items = match items(text) {
        Ok(items) => items,
        Err(message) => return issue(message),
    };
    let mut values = BTreeMap::new();
    for entry in items.iter().flat_map(mcp_entries) {
        let name = entry
            .pointer("/config/serverName")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let def = canon(entry.get("config").unwrap_or(&Value::Null));
        values.entry(name).or_insert(def);
    }
    Parsed {
        values,
        issue: None,
        state,
    }
}

/// 全机补丁 `$DSH_HOME/cordis.patch.yml`（对所有 profile 生效，在桌面版那份之后应用、优先级更高）存在时，
/// 写进桌面版那份之后给用户的说明；`profile_patch` 是 `$DSH_HOME/profiles/desktop/cordis.patch.yml`
pub(super) fn global_note(profile_patch: &Path) -> Option<String> {
    let home = profile_patch.parent()?.parent()?.parent()?;
    let global = home.join("cordis.patch.yml");
    if crate::fs::entry_kind(&global) == EntryKind::Missing {
        return None;
    }
    // 主目录下的写成 `~/…`（界面上的路径都这么写）
    let path = dirs::home_dir()
        .and_then(|home| global.strip_prefix(home).ok().map(Path::to_path_buf))
        .map_or_else(
            || global.display().to_string(),
            |rest| format!("~/{}", rest.display()),
        );
    Some(crate::t!(
        "mcp.report.dshGlobalPatch",
        agent = "DeepSeek Harness",
        path = path
    ))
}

/// Sophia 写的那一项的 id：靠它认出哪一行是自己的
fn own_id(name: &str) -> String {
    format!("sophia-mcp-{name}")
}

/// `serverName` 合不合规：`[A-Za-z0-9_-]{1,32}`（不合规的它不加载）
pub(super) fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 在补丁末尾追加服务器，一条一行。文件不存在时不建：桌面版还没打开过，建出来的 profile 目录它认不了。
/// 文件里只有 `[]`（没有任何项、用 `[]` 占位）时，那一行换成新加的这几行
pub(super) fn merge(
    existing: Option<&[u8]>,
    additions: &[(&str, &Canonical)],
) -> io::Result<Vec<u8>> {
    let Some(existing) = existing else {
        return Err(refused(crate::t!(
            "mcp.write.dshNotReady",
            agent = "DeepSeek Harness"
        )));
    };
    let text =
        std::str::from_utf8(existing).map_err(|_| refused(crate::t!("mcp.write.notUtf8")))?;
    let old = items(text).map_err(refused)?;
    let taken: Vec<&str> = old
        .iter()
        .flat_map(mcp_entries)
        .filter_map(|entry| entry.pointer("/config/serverName").and_then(Value::as_str))
        .collect();
    let mut lines = Vec::new();
    for (name, def) in additions {
        if taken.contains(name) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "exists"));
        }
        lines.push(line(name, def)?);
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = if old.is_empty() {
        without_placeholder(text)
    } else {
        text.to_owned()
    };
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(eol);
    }
    for line in &lines {
        out.push_str(line);
        out.push_str(eol);
    }
    // 核对：原有各项一个没变，后面依次是新加的这几项，读回来与要写的一致
    let new = items(&out).map_err(|_| refused(crate::t!("mcp.write.afterUnparsable")))?;
    let mismatch = || unverified(crate::t!("mcp.write.afterMismatch"));
    if new.len() != old.len() + lines.len() || new[..old.len()] != old[..] {
        return Err(mismatch());
    }
    for ((name, def), item) in additions.iter().zip(&new[old.len()..]) {
        let entries: Vec<&Value> = mcp_entries(item).collect();
        let [entry] = entries.as_slice() else {
            return Err(mismatch());
        };
        let config = entry.get("config").unwrap_or(&Value::Null);
        let written = canon(config);
        if entry.get("id").and_then(Value::as_str) != Some(&own_id(name))
            || config.get("serverName").and_then(Value::as_str) != Some(*name)
            || written.unsupported
            || !written.connection_eq(def)
        {
            return Err(mismatch());
        }
    }
    Ok(out.into_bytes())
}

/// 删掉 `name` 那一项：只删 Sophia 自己的那一行（单独解析就是一项 `insert`、id 是 `sophia-mcp-<名字>`），
/// 别的写法（用户自己加的、改成了多行的）拿不掉，返回 None。删完没有任何项时写回 `[]`。
/// 核对：新文件的各项 = 原来的各项去掉这一项
pub(super) fn remove(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let old = items(text).ok()?;
    let id = own_id(name);
    let mut out = String::with_capacity(text.len());
    let mut cut: Option<Value> = None;
    for line in text.split_inclusive('\n') {
        if cut.is_none() {
            if let Some(item) = own_item(line, &id, name) {
                cut = Some(item);
                continue;
            }
        }
        out.push_str(line);
    }
    let cut = cut?;
    let mut expected = old;
    let index = expected.iter().position(|item| *item == cut)?;
    expected.remove(index);
    if expected.is_empty() {
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(eol);
        }
        out.push_str("[]");
        out.push_str(eol);
    }
    (items(&out).ok()? == expected).then(|| out.into_bytes())
}

/// 这一行单独就是 Sophia 写的那一项（`- insert:` 打头、一项客户端插件、id 与 `serverName` 对得上）时，它读成的值
fn own_item(line: &str, id: &str, name: &str) -> Option<Value> {
    if !line.starts_with("- insert:") {
        return None;
    }
    let [item] = items(line).ok()?.try_into().ok()?;
    let entries: Vec<&Value> = item.get("insert")?.as_array()?.iter().collect();
    let [entry] = entries.as_slice() else {
        return None;
    };
    (entry.get("name").and_then(Value::as_str) == Some(CLIENT)
        && entry.get("id").and_then(Value::as_str) == Some(id)
        && entry.pointer("/config/serverName").and_then(Value::as_str) == Some(name))
    .then_some(item)
}

/// 去掉独占一行的 `[]`（后面可以跟注释）；没有就原样
fn without_placeholder(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut removed = false;
    for line in text.split_inclusive('\n') {
        let rest = line.trim().strip_prefix("[]").map(str::trim_start);
        if !removed && rest.is_some_and(|rest| rest.is_empty() || rest.starts_with('#')) {
            removed = true;
            continue;
        }
        out.push_str(line);
    }
    out
}

/// 一条服务的那一行（流式写法，值都写成 JSON 字符串：JSON 本身就是合法的 YAML 流式写法）
fn line(name: &str, def: &Canonical) -> io::Result<String> {
    if !valid_name(name) {
        return Err(refused(name_reason(name)));
    }
    if def.raw.is_some() {
        return Err(refused(crate::t!("mcp.write.notHere")));
    }
    if def.headers_helper.is_some() {
        return Err(refused(crate::t!("mcp.write.noHeadersHelper")));
    }
    if !def.client_fields.is_empty() {
        return Err(refused(crate::t!("mcp.write.noClientSettings")));
    }
    let mut config = vec![("serverName", quote(name))];
    match def.transport.as_str() {
        "stdio" => {
            let command = def
                .command
                .as_deref()
                .ok_or_else(|| refused(crate::t!("mcp.write.missingCommand")))?;
            config.push(("transport", quote("stdio")));
            config.push(("command", quote(command)));
            if !def.args.is_empty() {
                let args: Vec<String> = def.args.iter().map(|arg| quote(arg)).collect();
                config.push(("args", format!("[{}]", args.join(", "))));
            }
            if !def.env.is_empty() {
                config.push(("env", map(&def.env)));
            }
        }
        "http" => {
            let url = def
                .url
                .as_deref()
                .ok_or_else(|| refused(crate::t!("mcp.write.missingUrl")))?;
            config.push(("transport", quote("streamable-http")));
            config.push(("url", quote(url)));
            if !def.headers.is_empty() {
                config.push(("headers", map(&def.headers)));
            }
        }
        "sse" => return Err(refused(crate::t!("mcp.write.sseUnsupported"))),
        _ => {
            return Err(refused(crate::t!(
                "mcp.write.transportUnknown",
                agent = "DeepSeek Harness"
            )))
        }
    }
    let entry = object(&[
        ("id", quote(&own_id(name))),
        ("name", quote(CLIENT)),
        ("config", object(&config)),
    ]);
    Ok(format!("- insert: [{entry}]"))
}

/// 服务名不合规时的原因
pub(super) fn name_reason(name: &str) -> String {
    crate::t!(
        "mcp.reason.serverNameInvalid",
        target = "DeepSeek Harness",
        name = name
    )
}

/// JSON 字符串字面量（带引号、转义）；经 `Value` 的 Display 写，不会失败
fn quote(text: &str) -> String {
    serde_json::Value::String(text.to_owned()).to_string()
}

fn object(pairs: &[(&str, String)]) -> String {
    let members: Vec<String> = pairs
        .iter()
        .map(|(key, value)| format!("{}: {value}", quote(key)))
        .collect();
    format!("{{{}}}", members.join(", "))
}

fn map(values: &BTreeMap<String, String>) -> String {
    let members: Vec<String> = values
        .iter()
        .map(|(key, value)| format!("{}: {}", quote(key), quote(value)))
        .collect();
    format!("{{{}}}", members.join(", "))
}

/// 一项补丁里的 MCP 服务器：`insert` 列表里 `name` 是客户端插件的那几项
fn mcp_entries(item: &Value) -> impl Iterator<Item = &Value> {
    item.get("insert")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("name").and_then(Value::as_str) == Some(CLIENT))
}

/// 补丁文件的各项：空文件、只有注释的为空列表；不是一个列表（多份文档、根是别的）给原因
fn items(text: &str) -> Result<Vec<Value>, String> {
    let docs = load(text.strip_prefix('\u{feff}').unwrap_or(text))
        .ok_or_else(|| crate::t!("mcp.read.yamlInvalid"))?;
    match docs.as_slice() {
        [] => Ok(Vec::new()),
        [Value::Array(items)] => Ok(items.clone()),
        _ => Err(crate::t!("mcp.read.patchNotList")),
    }
}

/// 解析 YAML 成 JSON 值（每份文档一个）；解析不了为 None。`!!js` 这类核心类型以外的标签与别名
/// 读成一个对象（`{"!": 原文}`），不当成字面值：它们是 DeepSeek Harness 启动时才算出来的
fn load(text: &str) -> Option<Vec<Value>> {
    let mut loader = Loader::default();
    Parser::new_from_str(text).load(&mut loader, true).ok()?;
    (!loader.failed).then_some(loader.docs)
}

#[derive(Default)]
struct Loader {
    docs: Vec<Value>,
    /// 正在读的列表与映射（映射带着读到一半的键）
    stack: Vec<Frame>,
    failed: bool,
}

enum Frame {
    Seq(Vec<Value>),
    Map(Map<String, Value>, Option<String>),
}

impl Loader {
    fn push(&mut self, value: Value) {
        match self.stack.last_mut() {
            None => self.docs.push(value),
            Some(Frame::Seq(items)) => items.push(value),
            Some(Frame::Map(map, key)) => match key.take() {
                None => match value {
                    Value::String(text) => *key = Some(text),
                    Value::Null => *key = Some("null".into()),
                    Value::Bool(_) | Value::Number(_) => *key = Some(value.to_string()),
                    // 键是列表、映射、表达式：补丁里用不到，按读不懂
                    _ => self.failed = true,
                },
                Some(name) => {
                    // 重复的键：按读不懂（不猜哪一个算数）
                    if map.insert(name, value).is_some() {
                        self.failed = true;
                    }
                }
            },
        }
    }
}

/// 核心类型（`!!str`、`!!int` 这类）以外的标签
fn foreign(tag: &Option<Tag>) -> bool {
    tag.as_ref().is_some_and(|tag| {
        tag.handle != "tag:yaml.org,2002:"
            || !["str", "int", "float", "bool", "null", "map", "seq"].contains(&tag.suffix.as_str())
    })
}

fn expression(text: String) -> Value {
    Value::Object(Map::from_iter([("!".to_owned(), Value::String(text))]))
}

/// 普通写法的标量按 YAML 核心类型认（`true`、`3`、`~`）；带引号、块写法的一律是字符串
fn scalar(text: String, style: TScalarStyle, tag: &Option<Tag>) -> Value {
    if style != TScalarStyle::Plain || tag.as_ref().is_some_and(|t| t.suffix == "str") {
        return Value::String(text);
    }
    match Yaml::from_str(&text) {
        Yaml::Integer(n) => Value::from(n),
        Yaml::Real(r) => r
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::String(r), Value::Number),
        Yaml::Boolean(b) => Value::Bool(b),
        Yaml::Null => Value::Null,
        _ => Value::String(text),
    }
}

impl MarkedEventReceiver for Loader {
    fn on_event(&mut self, event: Event, _mark: Marker) {
        match event {
            Event::SequenceStart(..) => self.stack.push(Frame::Seq(Vec::new())),
            Event::MappingStart(..) => self.stack.push(Frame::Map(Map::new(), None)),
            Event::SequenceEnd | Event::MappingEnd => {
                let value = match self.stack.pop() {
                    Some(Frame::Seq(items)) => Value::Array(items),
                    Some(Frame::Map(map, None)) => Value::Object(map),
                    _ => {
                        self.failed = true;
                        return;
                    }
                };
                self.push(value);
            }
            Event::Scalar(text, style, _, tag) => {
                let value = if foreign(&tag) {
                    expression(text)
                } else {
                    scalar(text, style, &tag)
                };
                self.push(value);
            }
            Event::Alias(_) => self.push(expression("*".into())),
            Event::Nothing
            | Event::StreamStart
            | Event::StreamEnd
            | Event::DocumentStart
            | Event::DocumentEnd => {}
        }
    }
}

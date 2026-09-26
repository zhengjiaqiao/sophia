use super::{
    has_duplicate_header_names, Canonical, McpIssue, McpLocation, NoDuplicates, Pending, State,
};
use crate::discovery::Env;
use crate::fs::normalize;
use crate::models::Harness;
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags, OptionalExtension,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const WEIBO_APP: &str = "/Applications/WeiboAP.app/Contents/MacOS/WeiboAP";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    database: PathBuf,
    agent_root: PathBuf,
    agent_id: String,
    mcp_config: Option<String>,
    mode: FileStamp,
    database_identity: DatabaseIdentity,
}

/// 数据库本身只固定文件身份；不把 mtime 放进快照，以免其它 agent 的正常更新
/// 让当前 agent 的计划失效。
#[derive(Debug, Clone, PartialEq, Eq)]
struct DatabaseIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    bytes: Vec<u8>,
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

type RawUpdate<'a> = (Option<String>, Vec<(&'a str, Vec<u8>)>);

pub(super) struct Parsed {
    pub(super) values: BTreeMap<String, Canonical>,
    pub(super) issue: Option<String>,
    pub(super) snapshot: Snapshot,
}

pub(super) fn discover(env: &Env, harnesses: &[Harness]) -> (Vec<McpLocation>, Vec<McpIssue>) {
    if !cfg!(target_os = "macos") || !harnesses.iter().any(|h| h.id == "weiboap") {
        return (Vec::new(), Vec::new());
    }
    let root = match data_root(env) {
        Ok(root) => root,
        Err(message) => {
            return (
                Vec::new(),
                vec![McpIssue {
                    location_id: "weiboap".into(),
                    name: None,
                    message,
                }],
            )
        }
    };
    let Some(root) = root else {
        return (Vec::new(), Vec::new());
    };
    let agents = root.join("Data").join("agents");
    let Ok(metadata) = fs::symlink_metadata(&agents) else {
        return (Vec::new(), Vec::new());
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return (Vec::new(), Vec::new());
    }
    let Ok(entries) = fs::read_dir(&agents) else {
        return (Vec::new(), Vec::new());
    };
    let mut roots: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            (!metadata.file_type().is_symlink() && metadata.is_dir()).then_some(path)
        })
        .collect();
    roots.sort();
    (
        roots
            .into_iter()
            .map(|agent_root| {
                let normalized = normalize(&agent_root);
                let domain = normalized.to_string_lossy().into_owned();
                McpLocation {
                    id: format!("project:{domain}::weiboap"),
                    label: "WeiboAP".into(),
                    harness_id: "weiboap".into(),
                    domain: format!("project:{domain}"),
                    path: root.join("agents.db"),
                    selector: None,
                    matrix_hidden: false,
                }
            })
            .collect(),
        Vec::new(),
    )
}

pub(super) fn parse(location: &McpLocation) -> Result<Parsed, String> {
    let agent_id = agent_id(location)?;
    let mode = mode_guard(&location.path)?;
    let database_identity = database_identity(&location.path)?;
    let raw = read_mcp_config(&location.path, &agent_id)?;
    let values = parse_config(raw.as_deref())?;
    Ok(Parsed {
        values,
        issue: None,
        snapshot: Snapshot {
            database: location.path.clone(),
            agent_root: agent_root(location)?,
            agent_id,
            mcp_config: raw,
            mode,
            database_identity,
        },
    })
}

pub(super) fn write(group: &[Pending]) -> Result<Option<PathBuf>, String> {
    let first = group
        .first()
        .ok_or_else(|| "没有待写入的 WeiboAP 定义".to_string())?;
    let State::Weibo(expected) = &first.target else {
        return Err("WeiboAP 目标快照无效".into());
    };
    let path = &expected.database;
    if group.iter().any(
        |pending| !matches!(&pending.target, State::Weibo(snapshot) if snapshot.database == *path),
    ) {
        return Err("WeiboAP 目标不一致".into());
    }
    let metadata = regular_file(path)?;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| "WeiboAP 数据库不可打开".to_string())?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(|_| "WeiboAP 数据库不可写".to_string())?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| "WeiboAP 数据库正被使用，未写入".to_string())?;
    let result = (|| {
        for pending in group {
            let State::Weibo(snapshot) = &pending.target else {
                return Err("WeiboAP 目标快照无效".into());
            };
            if !same_in_connection(&connection, path, snapshot) {
                return Err("配置在预览后发生变化".into());
            }
            if let State::Weibo(source) = &pending.source {
                let unchanged = if source.database == *path {
                    same_in_connection(&connection, path, source)
                } else {
                    same(&source.database, source)
                };
                if !unchanged {
                    return Err("配置在预览后发生变化".into());
                }
            }
        }
        let backup = backup(path, &metadata)?;
        // 备份完成后再次检查本地模式及每个目标行，避免在备份期间切换到 PG。
        for pending in group {
            let State::Weibo(snapshot) = &pending.target else {
                return Err("WeiboAP 目标快照无效".into());
            };
            if !same_in_connection(&connection, path, snapshot) {
                return Err("配置在预览后发生变化".into());
            }
        }
        let mut updates: BTreeMap<String, RawUpdate<'_>> = BTreeMap::new();
        for pending in group {
            let State::Weibo(snapshot) = &pending.target else {
                return Err("WeiboAP 目标快照无效".into());
            };
            let update = updates
                .entry(snapshot.agent_id.clone())
                .or_insert_with(|| (snapshot.mcp_config.clone(), Vec::new()));
            update.1.push((
                pending.action.name.as_str(),
                definition_bytes(&pending.action.name, &pending.definition)?,
            ));
        }
        for (agent_id, (raw, additions)) in updates {
            let serialized = merge_raw_config(raw.as_deref(), &additions)?;
            connection
                .execute(
                    "UPDATE agents SET mcp_config = ?1 WHERE id = ?2",
                    (&serialized, &agent_id),
                )
                .map_err(|_| "WeiboAP MCP 配置无法写入".to_string())?;
        }
        Ok(Some(backup))
    })();
    if result.is_ok() {
        connection
            .execute_batch("COMMIT")
            .map_err(|_| "WeiboAP 数据库提交失败".to_string())?;
    } else {
        let _ = connection.execute_batch("ROLLBACK");
    }
    result
}

fn data_root(env: &Env) -> Result<Option<PathBuf>, String> {
    let default = env
        .home
        .join("Library")
        .join("Application Support")
        .join("WeiboAP");
    let config = env.home.join(".weiboap").join("config").join("config.json");
    // `read_regular` 会隐藏不安全文件细节；此处保留 NotFound，正常未设置 override 时可用默认目录。
    no_symlink_ancestors(&config)?;
    match fs::symlink_metadata(&config) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Some(default)),
        Err(_) => Err("WeiboAP 数据目录配置不可读，未发现 MCP 项目".into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("WeiboAP 数据目录配置不是普通文件，未发现 MCP 项目".into())
        }
        Ok(_) => read_regular(&config)
            .map_err(|_| "WeiboAP 数据目录配置不可读，未发现 MCP 项目".to_string())
            .and_then(|bytes| Ok(parse_root_config(&bytes)?.or(Some(default)))),
    }
}

fn parse_root_config(bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    validate_json(bytes).map_err(|_| "WeiboAP 数据目录配置无效或含重复键".to_string())?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "WeiboAP 数据目录配置无效")?;
    let object = value
        .as_object()
        .ok_or_else(|| "WeiboAP 数据目录配置无效".to_string())?;
    let Some(value) = object.get("appDataPath") else {
        return Ok(None);
    };
    if let Some(path) = value.as_str() {
        return nonempty_path(path).map(Some);
    }
    let entries = value
        .as_array()
        .ok_or_else(|| "WeiboAP 数据目录配置不受支持".to_string())?;
    let mut selected = None;
    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };
        if object.get("executablePath").and_then(Value::as_str) != Some(WEIBO_APP) {
            continue;
        }
        let data_path = object
            .get("dataPath")
            .and_then(Value::as_str)
            .ok_or_else(|| "WeiboAP 数据目录配置不受支持".to_string())?;
        if selected.replace(data_path).is_some() {
            return Err("WeiboAP 数据目录配置存在歧义".into());
        }
    }
    let selected = selected.ok_or_else(|| "WeiboAP 数据目录配置存在歧义".to_string())?;
    nonempty_path(selected).map(Some)
}

fn nonempty_path(value: &str) -> Result<PathBuf, String> {
    let path = (!value.trim().is_empty())
        .then(|| PathBuf::from(value))
        .ok_or_else(|| "WeiboAP 数据目录为空".to_string())?;
    path.is_absolute()
        .then_some(path)
        .ok_or_else(|| "WeiboAP 数据目录必须是绝对路径".to_string())
}

fn agent_id(location: &McpLocation) -> Result<String, String> {
    let root = agent_root(location)?;
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "WeiboAP 项目目录无效".into())
}

fn agent_root(location: &McpLocation) -> Result<PathBuf, String> {
    let domain = location
        .domain
        .strip_prefix("project:")
        .ok_or_else(|| "WeiboAP 项目域无效".to_string())?;
    let root = Path::new(domain);
    no_symlink_ancestors(root)?;
    let metadata = fs::symlink_metadata(root).map_err(|_| "WeiboAP 项目目录不可读")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("WeiboAP 项目目录不是实体目录".into());
    }
    Ok(root.into())
}

pub(super) fn entry_key(snapshot: &Snapshot) -> String {
    format!(
        "weiboap:{}:{}",
        normalize(&snapshot.database).display(),
        snapshot.agent_id
    )
}

pub(super) fn database_key(snapshot: &Snapshot) -> String {
    format!("weiboap:{}", normalize(&snapshot.database).display())
}

pub(super) fn same(database: &Path, expected: &Snapshot) -> bool {
    if database != expected.database
        || database_identity(database).ok().as_ref() != Some(&expected.database_identity)
        || !agent_root_is_real(&expected.agent_root)
    {
        return false;
    }
    let Ok(mode) = mode_guard(database) else {
        return false;
    };
    let Ok(mcp_config) = read_mcp_config(database, &expected.agent_id) else {
        return false;
    };
    mode == expected.mode && mcp_config == expected.mcp_config
}

fn same_in_connection(connection: &Connection, database: &Path, expected: &Snapshot) -> bool {
    database == expected.database
        && database_identity(database).ok().as_ref() == Some(&expected.database_identity)
        && agent_root_is_real(&expected.agent_root)
        && mode_guard(database).ok().as_ref() == Some(&expected.mode)
        && read_mcp_config_connection(connection, &expected.agent_id)
            .ok()
            .as_ref()
            == Some(&expected.mcp_config)
}

fn agent_root_is_real(path: &Path) -> bool {
    no_symlink_ancestors(path)
        .and_then(|_| fs::symlink_metadata(path).map_err(|_| "WeiboAP 项目目录不可读".to_string()))
        .map(|metadata| !metadata.file_type().is_symlink() && metadata.is_dir())
        .unwrap_or(false)
}

fn mode_guard(database: &Path) -> Result<FileStamp, String> {
    let path = database
        .parent()
        .ok_or_else(|| "WeiboAP 数据库路径无效".to_string())?
        .join("config.json");
    let bytes = read_regular(&path).map_err(|_| "WeiboAP 本地模式配置不可读")?;
    validate_json(&bytes)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "WeiboAP 本地模式配置无效")?;
    let object = value
        .as_object()
        .ok_or_else(|| "WeiboAP 本地模式配置无效".to_string())?;
    if object.get("pgEnabled") != Some(&Value::Bool(false))
        || object
            .iter()
            .any(|(key, value)| key.starts_with("pgEnabled_") && value != &Value::Bool(false))
    {
        return Err("无法确认 WeiboAP 使用本地数据模式或已启用云端，已拒绝读取和写入".into());
    }
    stamp(&path, bytes)
}

fn read_mcp_config(database: &Path, agent_id: &str) -> Result<Option<String>, String> {
    regular_file(database)?;
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "WeiboAP 数据库不可打开".to_string())?;
    read_mcp_config_connection(&connection, agent_id)
}

fn read_mcp_config_connection(
    connection: &Connection,
    agent_id: &str,
) -> Result<Option<String>, String> {
    let columns: BTreeSet<String> = connection
        .prepare("PRAGMA table_info(agents)")
        .map_err(|_| "WeiboAP 数据库缺少 agents 表")?
        .query_map([], |row| row.get(1))
        .map_err(|_| "WeiboAP 数据库 schema 无效")?
        .filter_map(Result::ok)
        .collect();
    if !columns.contains("id") || !columns.contains("mcp_config") {
        return Err("WeiboAP 数据库 schema 不支持 MCP 配置".into());
    }
    connection
        .query_row(
            "SELECT mcp_config FROM agents WHERE id = ?1",
            [agent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "WeiboAP 项目记录不可读".to_string())?
        .ok_or_else(|| "WeiboAP 项目目录没有对应数据库记录".to_string())
}

fn parse_config(raw: Option<&str>) -> Result<BTreeMap<String, Canonical>, String> {
    let value = parse_value(raw)?;
    let object = value
        .as_object()
        .ok_or_else(|| "WeiboAP MCP 配置不是对象".to_string())?;
    Ok(object
        .iter()
        .map(|(name, value)| (name.clone(), canonical(name, value)))
        .collect())
}

fn parse_value(raw: Option<&str>) -> Result<Value, String> {
    let raw = raw.unwrap_or("{}");
    validate_json(raw.as_bytes())?;
    let value: Value = serde_json::from_str(raw).map_err(|_| "WeiboAP MCP 配置无效")?;
    if value.is_null() {
        Ok(Value::Object(Default::default()))
    } else {
        Ok(value)
    }
}

fn validate_json(bytes: &[u8]) -> Result<(), String> {
    serde_json::from_slice::<NoDuplicates>(bytes)
        .map(|_| ())
        .map_err(|_| "WeiboAP MCP 配置无效或含重复键".into())
}

fn canonical(key: &str, value: &Value) -> Canonical {
    let Some(object) = value.as_object() else {
        return unsupported();
    };
    let mut bad = object.iter().any(|(field, value)| {
        !["name", "type", "command", "args", "env", "url", "headers"].contains(&field.as_str())
            && !value.is_null()
    });
    let name = string(object.get("name"), &mut bad);
    if name.as_deref() != Some(key) {
        bad = true;
    }
    let typ = string(object.get("type"), &mut bad);
    let command = string(object.get("command"), &mut bad);
    let url = string(object.get("url"), &mut bad);
    let args = strings(object.get("args"), &mut bad);
    let env = strings_map(object.get("env"), &mut bad);
    let headers = strings_map(object.get("headers"), &mut bad);
    let transport = match typ.as_deref() {
        Some("stdio") if command.is_some() && url.is_none() => "stdio",
        Some("http") if command.is_none() && url.is_some() => "http",
        _ => {
            bad = true;
            "unsupported"
        }
    };
    if (transport == "stdio" && (!headers.is_empty() || object.contains_key("url")))
        || (transport == "http"
            && (!args.is_empty() || !env.is_empty() || object.contains_key("command")))
        || command.as_deref().is_some_and(invalid_text)
        || url.as_deref().is_some_and(invalid_text)
        || args.iter().any(|value| invalid_text(value))
        || env.values().any(|value| invalid_text(value))
        || headers.values().any(|value| invalid_text(value))
    {
        bad = true;
    }
    if has_duplicate_header_names(&headers) {
        bad = true;
    }
    Canonical {
        transport: transport.into(),
        command,
        args,
        env,
        url,
        headers,
        client_fields: BTreeMap::new(),
        reason: bad.then(|| "WeiboAP MCP 字段、类型或变量引用不受支持".into()),
        unsupported: bad,
        headers_helper: None,
    }
}

fn definition(name: &str, value: &Canonical) -> Result<Value, String> {
    if value.unsupported {
        return Err("来源条目无法无损转换".into());
    }
    // 计划阶段已拒绝（`Canonical::refusal_for`）；这里再挡一次，绝不丢掉生成请求头的命令写
    if value.headers_helper.is_some() {
        return Err("WeiboAP 不支持用命令生成请求头".into());
    }
    let mut object = serde_json::Map::new();
    object.insert("name".into(), Value::String(name.into()));
    object.insert("type".into(), Value::String(value.transport.clone()));
    match value.transport.as_str() {
        "stdio" => {
            object.insert(
                "command".into(),
                Value::String(
                    value
                        .command
                        .clone()
                        .ok_or_else(|| "来源命令缺失".to_string())?,
                ),
            );
            if !value.args.is_empty() {
                object.insert(
                    "args".into(),
                    Value::Array(value.args.iter().cloned().map(Value::String).collect()),
                );
            }
            if !value.env.is_empty() {
                object.insert("env".into(), map_value(&value.env));
            }
        }
        "http" => {
            object.insert(
                "url".into(),
                Value::String(
                    value
                        .url
                        .clone()
                        .ok_or_else(|| "来源 URL 缺失".to_string())?,
                ),
            );
            if !value.headers.is_empty() {
                object.insert("headers".into(), map_value(&value.headers));
            }
        }
        _ => return Err("来源传输类型不受支持".into()),
    }
    Ok(Value::Object(object))
}

fn definition_bytes(name: &str, value: &Canonical) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&definition(name, value)?)
        .map_err(|_| "WeiboAP MCP 定义无法安全写入".to_string())
}

/// 只解析旧对象以校验结构和键，不重新序列化它，避免未知数字或格式被改变。
fn merge_raw_config(raw: Option<&str>, additions: &[(&str, Vec<u8>)]) -> Result<String, String> {
    let mut bytes = raw.unwrap_or("{}").as_bytes().to_vec();
    validate_json(&bytes)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "WeiboAP MCP 配置无效")?;
    let object = value
        .as_object()
        .ok_or_else(|| "WeiboAP MCP 配置不是对象".to_string())?;
    let mut names = BTreeSet::new();
    for (name, _) in additions {
        if object.contains_key(*name) || !names.insert(*name) {
            return Err("目标已有同名定义".into());
        }
    }
    let start = skip(&bytes, 0);
    let end = rtrim(&bytes, bytes.len(), start);
    if bytes.get(start) != Some(&b'{') || bytes.get(end.saturating_sub(1)) != Some(&b'}') {
        return Err("WeiboAP MCP 配置不是对象".into());
    }
    let at = rtrim(&bytes, end - 1, start + 1);
    let empty = skip(&bytes, start + 1) == end - 1;
    let mut inserted = Vec::new();
    for (index, (name, definition)) in additions.iter().enumerate() {
        if index > 0 {
            inserted.push(b',');
        }
        inserted.extend(serde_json::to_vec(name).map_err(|_| "WeiboAP MCP 配置无法安全写回")?);
        inserted.push(b':');
        inserted.extend(definition);
    }
    if !empty && !inserted.is_empty() {
        inserted.insert(0, b',');
    }
    bytes.splice(at..at, inserted);
    String::from_utf8(bytes).map_err(|_| "WeiboAP MCP 配置无法安全写回".into())
}

fn map_value(values: &BTreeMap<String, String>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

fn string(value: Option<&Value>, bad: &mut bool) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => {
            *bad = true;
            None
        }
    }
}

fn strings(value: Option<&Value>, bad: &mut bool) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Some(value.clone()),
                _ => {
                    *bad = true;
                    None
                }
            })
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default(),
        _ => {
            *bad = true;
            Vec::new()
        }
    }
}

fn strings_map(value: Option<&Value>, bad: &mut bool) -> BTreeMap<String, String> {
    match value {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(values)) => values
            .iter()
            .map(|(key, value)| match value {
                Value::String(value) => Some((key.clone(), value.clone())),
                _ => {
                    *bad = true;
                    None
                }
            })
            .collect::<Option<BTreeMap<_, _>>>()
            .unwrap_or_default(),
        _ => {
            *bad = true;
            BTreeMap::new()
        }
    }
}

fn invalid_text(value: &str) -> bool {
    value.is_empty() || value.contains("${")
}

fn unsupported() -> Canonical {
    Canonical {
        transport: "unsupported".into(),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        url: None,
        headers: BTreeMap::new(),
        client_fields: BTreeMap::new(),
        reason: Some("WeiboAP MCP 定义不是对象".into()),
        unsupported: true,
        headers_helper: None,
    }
}

fn read_regular(path: &Path) -> io::Result<Vec<u8>> {
    regular_file(path).map_err(|_| io::Error::other("not regular"))?;
    fs::read(path)
}

fn regular_file(path: &Path) -> Result<fs::Metadata, String> {
    no_symlink_ancestors(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "WeiboAP 配置不可读".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("WeiboAP 配置不是普通文件".into());
    }
    Ok(metadata)
}

fn database_identity(path: &Path) -> Result<DatabaseIdentity, String> {
    let metadata = regular_file(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(DatabaseIdentity {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Ok(DatabaseIdentity {})
    }
}

/// 任何现有祖先为软链接都会令路径重定向；运行时和预览都拒绝它。
fn no_symlink_ancestors(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    let limit = path.parent().unwrap_or(path);
    for part in limit.components() {
        match part {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                current.push(part.as_os_str())
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => return Err("WeiboAP 路径不安全".into()),
            std::path::Component::Normal(part) => {
                current.push(part);
                match fs::symlink_metadata(&current) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        return Err("WeiboAP 路径包含软链接".into())
                    }
                    Ok(meta) if !meta.is_dir() => return Err("WeiboAP 路径无效".into()),
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => break,
                    Err(_) => return Err("WeiboAP 路径不可读".into()),
                }
            }
        }
    }
    Ok(())
}

fn skip(bytes: &[u8], mut p: usize) -> usize {
    while bytes.get(p).is_some_and(u8::is_ascii_whitespace) {
        p += 1;
    }
    p
}

fn rtrim(bytes: &[u8], mut p: usize, low: usize) -> usize {
    while p > low && bytes[p - 1].is_ascii_whitespace() {
        p -= 1;
    }
    p
}

fn stamp(path: &Path, bytes: Vec<u8>) -> Result<FileStamp, String> {
    let metadata = regular_file(path)?;
    Ok(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        dev: {
            use std::os::unix::fs::MetadataExt;
            metadata.dev()
        },
        #[cfg(unix)]
        ino: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
        bytes,
    })
}

fn backup(database: &Path, metadata: &fs::Metadata) -> Result<PathBuf, String> {
    let parent = database
        .parent()
        .ok_or_else(|| "WeiboAP 数据库路径无效".to_string())?;
    for index in 0..1000 {
        let path = parent.join(format!("agents.db.symsync-mcp-{index}.bak"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            options.mode(metadata.mode() & 0o777);
        }
        if options.open(&path).is_err() {
            continue;
        }
        let result = (|| {
            let source = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "WeiboAP 备份源不可打开".to_string())?;
            source
                .busy_timeout(Duration::from_millis(500))
                .map_err(|_| "WeiboAP 备份源不可读取".to_string())?;
            let mut destination =
                Connection::open(&path).map_err(|_| "WeiboAP 备份不可创建".to_string())?;
            let backup = Backup::new(&source, &mut destination)
                .map_err(|_| "WeiboAP 备份不可创建".to_string())?;
            let mut completed = false;
            for _ in 0..100 {
                match backup
                    .step(32)
                    .map_err(|_| "WeiboAP 备份失败".to_string())?
                {
                    StepResult::Done => {
                        completed = true;
                        break;
                    }
                    StepResult::More | StepResult::Busy | StepResult::Locked => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    _ => return Err("WeiboAP 备份状态不受支持".into()),
                }
            }
            if !completed {
                return Err("WeiboAP 备份繁忙，未写入目标".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                fs::set_permissions(&path, fs::Permissions::from_mode(metadata.mode() & 0o777))
                    .map_err(|_| "WeiboAP 备份权限设置失败".to_string())?;
            }
            Ok(path.clone())
        })();
        if result.is_ok() {
            return result;
        }
        let _ = fs::remove_file(&path);
        return result;
    }
    Err("WeiboAP 备份路径不可用".into())
}

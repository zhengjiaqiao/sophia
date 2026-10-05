//! `~/.codex/config.toml` 里本功能写的内容，两种接法（spec 2026-10-03-codex-hookup-auto）：
//! - 借用内置服务商：两个根键 `model_catalog_json`、`openai_base_url`；
//! - 独立服务商：再加根键 `model_provider = "sophia"`，并在文件末尾追加一张 `[model_providers.sophia]`。
//!
//! 只增删这些，其余内容逐字节保留。删除时两种形态都删（崩溃后留下哪一种都能清干净）。
//!
//! 为什么不用 `toml_edit` 改：实测它会把整个文件的 CRLF 改写成 LF、丢掉 BOM、给末行补换行，
//! 做不到“恢复后逐字节相同”。所以这里做文本级手术，`toml_edit` 只用来校验和读值。
//! 算法移植自 agents-manager 的 `internal/codexcfg`（同一作者的 Go 项目，已在真实环境验证）。
use super::settings::{HookupMode, PORT_RANGE};
use std::fmt;
use toml_edit::DocumentMut;

pub const KEY_CATALOG: &str = "model_catalog_json";
pub const KEY_BASE_URL: &str = "openai_base_url";
const KEY_MODEL_PROVIDER: &str = "model_provider";
const KEY_PROVIDERS: &str = "model_providers";
/// 独立服务商接法里 Sophia 这个服务商的 id（`model_provider` 的值、表名）
pub const PROVIDER_ID: &str = "sophia";
const PROVIDER_NAME: &str = "Sophia";
/// 冲突、警告里指这张表时用的名字
const TABLE_KEY: &str = "model_providers.sophia";
const TABLE_HEADER: &str = "[model_providers.sophia]";
const KEY_PROFILE: &str = "profile";
const BOM: &str = "\u{feff}";
/// 根键上方那一行注释（spec 2026-10-05-exit-fallback R2）：Sophia 没在运行时用户照着手删。
/// 固定的中英双语，不走 `t!`：删除时要逐字节认出它，而用户可能在写入后换过界面语言
pub const COMMENT_BUILTIN: &str = "# 由 Sophia 写入；Sophia 没在运行时，删掉下面两行即可恢复官方。Written by Sophia; delete the two lines below to restore the official setup when Sophia is not running."; // i18n-exempt: 写进用户设置文件、停用时要逐字节认回的固定文字，不随界面语言变
pub const COMMENT_PROVIDER: &str = "# 由 Sophia 写入；Sophia 没在运行时，删掉下面三行和 [model_providers.sophia] 即可恢复官方。Written by Sophia; delete the three lines below and [model_providers.sophia] to restore the official setup when Sophia is not running."; // i18n-exempt: 同上，独立服务商接法的那一句

/// 本功能写进 `openai_base_url` 的路由地址
pub fn router_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

/// 是不是本功能在 [`PORT_RANGE`] 里任一端口写下的路由地址：换过端口后，崩溃留下的可能是旧端口的值
fn is_router_base_url(value: &str) -> bool {
    PORT_RANGE
        .into_iter()
        .any(|port| value == router_base_url(port))
}

/// 本功能写入 Codex 设置的两项值
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Managed {
    pub catalog_path: String,
    pub base_url: String,
    /// 要写成哪种接法
    pub mode: HookupMode,
}

impl Managed {
    fn pairs(&self) -> [(&'static str, &str); 2] {
        [
            (KEY_CATALOG, self.catalog_path.as_str()),
            (KEY_BASE_URL, self.base_url.as_str()),
        ]
    }

    /// 根键上方的注释（按接法）
    fn comment(&self) -> &'static str {
        match self.mode {
            HookupMode::Provider => COMMENT_PROVIDER,
            _ => COMMENT_BUILTIN,
        }
    }

    /// 要插在根部的键：两种接法都有的两项，独立服务商再加 `model_provider`
    fn root_inserts(&self) -> Vec<(&'static str, &str)> {
        let mut list = self.pairs().to_vec();
        if self.mode == HookupMode::Provider {
            list.push((KEY_MODEL_PROVIDER, PROVIDER_ID));
        }
        list
    }

    /// `key` 上的这个值是不是本功能写的：目录路径要相同；路由地址是当前的，或本功能在端口范围内写下的别的端口
    fn owns(&self, key: &str, value: &str) -> bool {
        match key {
            KEY_MODEL_PROVIDER => value == PROVIDER_ID,
            KEY_BASE_URL => {
                value == self.base_url
                    || (is_router_base_url(&self.base_url) && is_router_base_url(value))
            }
            KEY_CATALOG => value == self.catalog_path,
            _ => false,
        }
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
            // 显式写着官方 provider 只在要换独立服务商（没登录）时才冲突：说清是登录的事
            KEY_MODEL_PROVIDER if self.value.trim_matches('"') == "openai" => {
                write!(f, "{}", crate::t!("models.cfg.conflictOpenaiSignedOut"))
            }
            KEY_MODEL_PROVIDER => write!(
                f,
                "{}",
                crate::t!("models.cfg.conflictModelProvider", value = self.value)
            ),
            KEY_PROFILE => write!(
                f,
                "{}",
                crate::t!("models.cfg.conflictProfile", value = self.value)
            ),
            key => write!(
                f,
                "{}",
                crate::t!("models.cfg.conflictOther", key = key, value = self.value)
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
                write!(
                    f,
                    "{}",
                    crate::t!("models.cfg.invalidToml", detail = detail)
                )
            }
            ConfigError::Conflict(conflict) => conflict.fmt(f),
        }
    }
}

impl std::error::Error for ConfigError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub text: String,
    /// 内容变了（插入了，或旧端口的路由地址换成了当前的）
    pub changed: bool,
    /// 插入了本功能的键（之前没开着）；只换了端口时为 false，`added_newline` 也无意义
    pub inserted: bool,
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
    /// 现在写着的接法：写着 `model_provider = "sophia"` 为独立服务商，否则指着路由为借用内置，都不是为 None
    pub mode: Option<HookupMode>,
}

fn parse(text: &str) -> Result<DocumentMut, ConfigError> {
    text.trim_start_matches(BOM)
        .parse::<DocumentMut>()
        .map_err(|e| ConfigError::Invalid(e.to_string().lines().next().unwrap_or("").to_owned()))
}

/// 不是合法的 TOML 时出错的那一行（从 1 数）；合法或说不出位置为 None（spec 2026-10-04-local-diagnostics R11）
pub fn invalid_line(text: &str) -> Option<usize> {
    let body = text.trim_start_matches(BOM);
    let error = body.parse::<DocumentMut>().err()?;
    let span = error.span()?;
    Some(crate::file_issue::line_at(body, span.start))
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

/// 独立服务商那张表的五行（不带行尾）：表头与四个字段
fn table_lines(base_url: &str) -> [String; 5] {
    [
        TABLE_HEADER.to_owned(),
        format!("name = {}", toml_string(PROVIDER_NAME)),
        format!("base_url = {}", toml_string(base_url)),
        format!("wire_api = {}", toml_string("responses")),
        "requires_openai_auth = false".to_owned(),
    ]
}

/// `[model_providers.sophia]`（不论谁写的）
fn sophia_table(doc: &DocumentMut) -> Option<&toml_edit::Item> {
    doc.get(KEY_PROVIDERS)?.get(PROVIDER_ID)
}

fn table_str<'a>(table: &'a toml_edit::Item, key: &str) -> Option<&'a str> {
    table.get(key).and_then(|item| item.as_str())
}

/// 这张表是不是本功能写的：恰好四个字段，值都等于本功能写的（路由地址认端口范围内任一端口）
fn table_is_ours(table: &toml_edit::Item) -> bool {
    table.as_table_like().is_some_and(|t| t.len() == 4)
        && table_str(table, "name") == Some(PROVIDER_NAME)
        && table_str(table, "base_url").is_some_and(is_router_base_url)
        && table_str(table, "wire_api") == Some("responses")
        && table
            .get("requires_openai_auth")
            .and_then(|item| item.as_bool())
            == Some(false)
}

/// 地址仍指着本功能的路由：本功能写过、之后被用户改了别的字段的表（删时保留并警告）
fn table_is_router_like(table: &toml_edit::Item) -> bool {
    table_str(table, "base_url").is_some_and(is_router_base_url)
}

/// 本功能写下的那张表在第几行（表头）：表头与其后四行逐字等于本功能写的（路由地址认端口范围内任一端口）。
/// 只认它之前的内容自成完整 TOML 的表头，多行字符串里长得一样的文字不算
fn our_table_line(lines: &[String]) -> Option<usize> {
    let bare = |line: &String| line.trim_end_matches(['\r', '\n']).to_owned();
    (0..lines.len()).find(|&h| {
        if bare(&lines[h]) != TABLE_HEADER || h + 5 > lines.len() {
            return false;
        }
        let body: Vec<String> = lines[h + 1..h + 5].iter().map(bare).collect();
        let matches = PORT_RANGE.into_iter().any(|port| {
            let want = table_lines(&router_base_url(port));
            body.iter().zip(&want[1..]).all(|(got, want)| got == want)
        });
        matches && complete(&lines[..h].concat())
    })
}

/// 行尾：跟着这一行自己的
fn eol_of(line: &str) -> &'static str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

fn conflict_in(doc: &DocumentMut, managed: &Managed) -> Option<Conflict> {
    let table = sophia_table(doc);
    let table_ours = table.is_some_and(table_is_ours);
    if let Some(item) = doc.get(KEY_MODEL_PROVIDER) {
        let ok = match item.as_str() {
            // 显式写着官方：借用内置不碍事；独立服务商要改这个键，不改别人写的值
            Some("openai") => managed.mode == HookupMode::Builtin,
            // Sophia 自己写的（表也是自己的，或表已经不在）不算冲突（R8）
            Some(PROVIDER_ID) => table.is_none() || table_ours,
            _ => false,
        };
        if !ok {
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
    for (key, _) in managed.pairs() {
        if let Some(item) = doc.get(key) {
            if !item.as_str().is_some_and(|value| managed.owns(key, value)) {
                return Some(Conflict {
                    key: key.into(),
                    value: display(item),
                });
            }
        }
    }
    // 独立服务商要用 sophia 这个名字：已有一张不是本功能写的同名表，不覆盖
    if let (HookupMode::Provider, Some(table), false) = (managed.mode, table, table_ours) {
        return Some(Conflict {
            key: TABLE_KEY.into(),
            value: table_str(table, "name").unwrap_or_default().to_owned(),
        });
    }
    None
}

/// 判断设置当前是否已指向本功能，以及是否存在冲突
pub fn inspect(text: &str, managed: &Managed) -> Result<Inspection, ConfigError> {
    let doc = parse(text)?;
    let base_url = doc.get(KEY_BASE_URL).and_then(|item| item.as_str());
    let root_points = base_url.is_some_and(|value| managed.owns(KEY_BASE_URL, value));
    let table = sophia_table(&doc).filter(|table| table_is_ours(table));
    let provider_written =
        doc.get(KEY_MODEL_PROVIDER).and_then(|item| item.as_str()) == Some(PROVIDER_ID);
    let points_at_router = root_points || (provider_written && table.is_some());
    let mode = if provider_written {
        Some(HookupMode::Provider)
    } else if root_points {
        Some(HookupMode::Builtin)
    } else {
        None
    };
    if let Some(conflict) = conflict_in(&doc, managed) {
        return Ok(Inspection {
            enabled: false,
            points_at_router,
            conflict: Some(conflict.to_string()),
            mode,
        });
    }
    let catalog_ok =
        doc.get(KEY_CATALOG).and_then(|item| item.as_str()) == Some(managed.catalog_path.as_str());
    // 写着的那一种形态完整、且指着当前端口才算开着；是哪一种看 `mode`
    let form_ok = !provider_written
        || table.and_then(|t| table_str(t, "base_url")) == Some(managed.base_url.as_str());
    Ok(Inspection {
        enabled: catalog_ok && base_url == Some(managed.base_url.as_str()) && form_ok,
        points_at_router,
        conflict: None,
        mode,
    })
}

/// 读取根部的字符串键
pub fn root_string(text: &str, key: &str) -> Option<String> {
    parse(text).ok()?.get(key)?.as_str().map(str::to_owned)
}

/// 写入本功能的内容（按 `managed.mode` 的形态）。已存在且相同则不改；存在别人的值则返回冲突。
/// 独立服务商的表追加在文件末尾，前面空一行；根键与表都跟随文件的换行符，末行没有换行时补一个并记下
pub fn apply(text: &str, managed: &Managed) -> Result<Applied, ConfigError> {
    let doc = parse(text)?;
    if let Some(conflict) = conflict_in(&doc, managed) {
        return Err(ConfigError::Conflict(conflict));
    }
    // 换过端口：本功能在旧端口写下的路由地址原位换成当前的，其余逐字节不动
    let replaced = retarget_text(text, managed)?;
    let moved = replaced.is_some();
    let text = replaced.as_deref().unwrap_or(text);
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut insert: String = managed
        .root_inserts()
        .iter()
        .filter(|(key, _)| doc.get(key).is_none())
        .map(|(key, value)| format!("{key} = {}{eol}", toml_string(value)))
        .collect();
    // 注释只在根键一个都不在、整组一起写时才写：老版本写入、没有注释的文件不补（根键已在就什么都不改）；
    // 只缺一部分根键时也不写——注释里「删掉下面两行」数的是整组，只补一行时照做会删到用户的内容
    let inserted_keys = managed
        .root_inserts()
        .iter()
        .filter(|(key, _)| doc.get(key).is_none())
        .count();
    if inserted_keys == managed.root_inserts().len() {
        insert = format!("{}{eol}{insert}", managed.comment());
    }
    let add_table = managed.mode == HookupMode::Provider && sophia_table(&doc).is_none();
    if insert.is_empty() && !add_table {
        return Ok(Applied {
            text: text.to_owned(),
            changed: moved,
            inserted: false,
            added_newline: false,
        });
    }
    let (prefix, body) = split_bom(text);
    let mut body = body.to_owned();
    let mut added_newline = false;
    if !insert.is_empty() {
        let mut lines = split_lines(&body);
        // 强退后用户照注释删了根键、只剩注释，再打开 Sophia 重新启用：旧注释先去掉，不然两条注释并存，
        // 旧的那条指着用户自己的内容
        while let Some(index) = comment_line(&lines) {
            lines.remove(index);
        }
        let at = insertion_line(&lines);
        let mut before: String = lines[..at].concat();
        let after: String = lines[at..].concat();
        added_newline = !before.is_empty() && !before.ends_with('\n');
        if added_newline {
            before.push_str(eol);
        }
        body = format!("{before}{insert}{after}");
    }
    if add_table {
        if !body.is_empty() {
            if !body.ends_with('\n') {
                body.push_str(eol);
                added_newline = true;
            }
            // 与上一段之间空一行；删除时连这一行一起删
            body.push_str(eol);
        }
        for line in table_lines(&managed.base_url) {
            body.push_str(&line);
            body.push_str(eol);
        }
    }
    let result = format!("{prefix}{body}");
    // 写后校验：根键必须能从根部读回；独立服务商的表必须是本功能的、指着当前端口
    let check = parse(&result)?;
    for (key, value) in managed.root_inserts() {
        if check.get(key).and_then(|item| item.as_str()) != Some(value) {
            return Err(ConfigError::Invalid(crate::t!(
                "models.cfg.readBackFailed",
                key = key
            )));
        }
    }
    if managed.mode == HookupMode::Provider
        && !sophia_table(&check).is_some_and(|table| {
            table_is_ours(table) && table_str(table, "base_url") == Some(managed.base_url.as_str())
        })
    {
        return Err(ConfigError::Invalid(crate::t!(
            "models.cfg.readBackFailed",
            key = TABLE_KEY
        )));
    }
    Ok(Applied {
        text: result,
        changed: true,
        inserted: true,
        added_newline,
    })
}

/// 换了端口：本功能在旧端口写下的路由地址（根部 `openai_base_url` 与独立服务商表里的 `base_url`）原位换成
/// `managed` 的，其余逐字节不动。没有要换的、或换不了（写法被改过）返回 None
pub fn retarget(text: &str, managed: &Managed) -> Option<String> {
    retarget_text(text, managed).ok().flatten()
}

fn retarget_text(text: &str, managed: &Managed) -> Result<Option<String>, ConfigError> {
    let doc = parse(text)?;
    let read_back =
        |key: &str| ConfigError::Invalid(crate::t!("models.cfg.readBackFailed", key = key));
    let mut out = text.to_owned();
    let mut changed = false;
    if let Some(value) = doc.get(KEY_BASE_URL).and_then(|item| item.as_str()) {
        if value != managed.base_url && managed.owns(KEY_BASE_URL, value) {
            out = replace_root_string(&out, KEY_BASE_URL, Some(&managed.base_url))
                .ok_or_else(|| read_back(KEY_BASE_URL))?;
            changed = true;
        }
    }
    let table_moved = sophia_table(&doc).is_some_and(|table| {
        table_is_ours(table) && table_str(table, "base_url") != Some(managed.base_url.as_str())
    });
    if table_moved && is_router_base_url(&managed.base_url) {
        let (prefix, body) = split_bom(&out);
        let mut lines = split_lines(body);
        let header = our_table_line(&lines).ok_or_else(|| read_back(TABLE_KEY))?;
        let line = &mut lines[header + 2];
        *line = format!(
            "base_url = {}{}",
            toml_string(&managed.base_url),
            eol_of(line)
        );
        out = format!("{prefix}{}", lines.concat());
        changed = true;
    }
    Ok(changed.then_some(out))
}

/// 只移除仍等于本功能值的内容；被别人改过的保留并给出警告。两种形态都删：
/// 根部的两项、值为 `"sophia"` 的 `model_provider`、仍是本功能写的 `[model_providers.sophia]`
pub fn remove(text: &str, managed: &Managed, added_newline: bool) -> Result<Removed, ConfigError> {
    let doc = parse(text)?;
    let (prefix, body) = split_bom(text);
    let mut lines = split_lines(body);
    let mut warnings = Vec::new();
    let provider_written =
        doc.get(KEY_MODEL_PROVIDER).and_then(|item| item.as_str()) == Some(PROVIDER_ID);
    // 表：先删它（在文件末尾），再删根键
    let mut drop_provider_key = provider_written;
    if let Some(table) = sophia_table(&doc) {
        if table_is_ours(table) {
            match our_table_line(&lines) {
                Some(header) => {
                    let start = if header > 0 && lines[header - 1].trim().is_empty() {
                        header - 1
                    } else {
                        header
                    };
                    let end = header + 5;
                    let at_end = lines[end..].concat().is_empty();
                    lines.drain(start..end);
                    // 还原写表时补上的换行：仅当表原本在文件末尾
                    if added_newline && at_end && start > 0 {
                        strip_eol(&mut lines[start - 1]);
                    }
                }
                None => warnings.push(crate::t!("models.cfg.rewrittenManual", key = TABLE_KEY)),
            }
        } else if table_is_router_like(table) {
            // 本功能写过、被改了别的字段：保留，根键照样删掉，Codex 回到官方
            warnings.push(crate::t!(
                "models.cfg.changedKept",
                key = TABLE_KEY,
                value = table_str(table, "name").unwrap_or_default()
            ));
        } else {
            // 用户自己的同名表，与本功能无关：表和指向它的根键都不碰
            drop_provider_key = false;
        }
    }
    let mut keys: Vec<&str> = managed.pairs().iter().map(|(key, _)| *key).collect();
    if drop_provider_key {
        keys.push(KEY_MODEL_PROVIDER);
    }
    // 注释先删（两种接法的都认；用户手删了根键只剩注释也删），之后根键的行号才是准的。
    // 它也算「被移除的行」：只剩注释时，末尾补的换行要靠它还原
    let mut removed_at = None;
    while let Some(index) = comment_line(&lines) {
        lines.remove(index);
        removed_at = Some(index);
    }
    for key in keys {
        let Some(item) = doc.get(key) else { continue };
        let Some(ours) = item.as_str().filter(|value| managed.owns(key, value)) else {
            warnings.push(crate::t!(
                "models.cfg.changedKept",
                key = key,
                value = display(item)
            ));
            continue;
        };
        match statement_line(&lines, key, Some(ours)) {
            Some(index) => {
                lines.remove(index);
                removed_at = Some(index);
            }
            None => warnings.push(crate::t!("models.cfg.rewrittenManual", key = key)),
        }
    }
    // 还原插入时补上的换行：仅当被移除的行原本是文件最后一行
    if let (true, Some(index)) = (added_newline, removed_at) {
        if index > 0 && lines[index..].concat().is_empty() {
            strip_eol(&mut lines[index - 1]);
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

/// 去掉这一行的行尾（`\n` 或 `\r\n`）
fn strip_eol(line: &mut String) {
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
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

/// 本功能写下的注释行：整行（不含行尾）恰好等于两句注释之一，且它之前的内容自成完整 TOML（多行字符串里长得一样的文字不算）
fn comment_line(lines: &[String]) -> Option<usize> {
    let end = root_end_line(lines);
    (0..end).find(|&i| {
        let line = lines[i].trim_end_matches(['\r', '\n']);
        (line == COMMENT_BUILTIN || line == COMMENT_PROVIDER) && complete(&lines[..i].concat())
    })
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
            catalog_path: "/Users/someone/.codex/sophia-models.json".into(),
            base_url: "http://127.0.0.1:47328/v1".into(),
            mode: HookupMode::Builtin,
        }
    }

    const OUR_KEYS: &str = "model_catalog_json = \"/Users/someone/.codex/sophia-models.json\"\nopenai_base_url = \"http://127.0.0.1:47328/v1\"\n";
    /// 启用后多出的三行：注释紧贴在两个根键上方（spec 2026-10-05-exit-fallback R2）
    const OUR_LINES: &str = "# 由 Sophia 写入；Sophia 没在运行时，删掉下面两行即可恢复官方。Written by Sophia; delete the two lines below to restore the official setup when Sophia is not running.\nmodel_catalog_json = \"/Users/someone/.codex/sophia-models.json\"\nopenai_base_url = \"http://127.0.0.1:47328/v1\"\n";

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

    /// AC18（2026-10-05 起）：启用只多出本功能的三行（一行注释加两行键），其余逐字节相同
    #[test]
    fn ac18_realistic_config_gains_exactly_three_lines() {
        let applied = apply(REALISTIC, &managed()).unwrap();
        assert!(applied.changed);
        let idx = applied.text.find(OUR_LINES).expect("注释与两行键应当相邻");
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

    /// AC3：用户手删了根键只剩注释 → 停用时注释也删掉，没有警告
    #[test]
    fn remove_drops_an_orphan_comment() {
        let applied = apply(REALISTIC, &managed()).unwrap();
        let orphan = applied.text.replace(OUR_KEYS, "");
        assert!(orphan.contains("# 由 Sophia 写入"));
        let removed = remove(&orphan, &managed(), applied.added_newline).unwrap();
        assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
        assert_eq!(removed.text, REALISTIC);
    }

    /// Codex 复审 P2：原文末尾无换行、用户手删根键只剩注释 → 停用后仍逐字节还原
    #[test]
    fn remove_drops_an_orphan_comment_and_the_added_newline() {
        let original = "model = \"gpt\"";
        let applied = apply(original, &managed()).unwrap();
        assert!(applied.added_newline);
        let orphan = applied.text.replace(OUR_KEYS, "");
        let removed = remove(&orphan, &managed(), applied.added_newline).unwrap();
        assert_eq!(removed.text, original);
        assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
    }

    /// Codex 复审 P2：根键只缺一部分（比如用户自己写过 openai_base_url）→ 只补缺的那一行，不写注释：
    /// 注释里「删掉下面两行」数的是整组，只补一行时照做会删到用户的内容
    #[test]
    fn a_partially_present_pair_gets_no_comment() {
        let original = "openai_base_url = \"http://127.0.0.1:47328/v1\"\nmodel = \"gpt\"\n\n[desktop]\nx = 1\n";
        let applied = apply(original, &managed()).unwrap();
        assert!(applied.changed);
        assert!(
            !applied.text.contains("# 由 Sophia 写入"),
            "{}",
            applied.text
        );
        assert_eq!(
            applied.text,
            "openai_base_url = \"http://127.0.0.1:47328/v1\"\nmodel = \"gpt\"\nmodel_catalog_json = \"/Users/someone/.codex/sophia-models.json\"\n\n[desktop]\nx = 1\n"
        );
        let removed = remove(&applied.text, &managed(), applied.added_newline).unwrap();
        assert_eq!(removed.text, "model = \"gpt\"\n\n[desktop]\nx = 1\n");
    }

    /// Codex 复审 P2：只剩孤儿注释时重新启用 → 只有一条注释、紧贴根键；之后停用还原到用户手删后的样子
    /// （去掉注释那一行）。原文末行没有换行的那种，手删时留下的换行是用户的，不再追溯
    #[test]
    fn re_enabling_over_an_orphan_comment_leaves_one_comment() {
        for original in [
            REALISTIC,
            "model = \"gpt\"",
            "model = \"gpt\"\n\n[desktop]\nx = 1\n",
        ] {
            let first = apply(original, &managed()).unwrap();
            let orphan = first.text.replace(OUR_KEYS, "");
            let again = apply(&orphan, &managed()).unwrap();
            assert_eq!(
                again.text.matches("# 由 Sophia 写入").count(),
                1,
                "{}",
                again.text
            );
            assert!(again.text.contains(OUR_LINES), "{}", again.text);
            let removed = remove(&again.text, &managed(), again.added_newline).unwrap();
            assert_eq!(
                removed.text,
                orphan.replace(&format!("{COMMENT_BUILTIN}\n"), "")
            );
            assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
        }
    }

    /// 老版本写入、没有注释的文件：启用什么都不改，停用照常还原
    #[test]
    fn a_file_written_without_the_comment_is_left_alone_and_still_restores() {
        let legacy = format!("model = \"gpt\"\n{OUR_KEYS}\n[desktop]\nx = 1\n");
        let applied = apply(&legacy, &managed()).unwrap();
        assert!(!applied.changed);
        assert_eq!(applied.text, legacy);
        let removed = remove(&legacy, &managed(), false).unwrap();
        assert_eq!(removed.text, "model = \"gpt\"\n\n[desktop]\nx = 1\n");
    }

    /// 注释长得一样但在多行字符串里：不当成本功能的注释
    #[test]
    fn remove_ignores_the_comment_text_inside_multiline_strings() {
        let original = format!(
            "notes = \"\"\"\n{}\"\"\"\n\n[desktop]\nx = 1\n",
            COMMENT_BUILTIN
        );
        let applied = apply(&original, &managed()).unwrap();
        let removed = remove(&applied.text, &managed(), applied.added_newline).unwrap();
        assert_eq!(removed.text, original);
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
                "model_catalog_json = \"/Users/x/.codex/other-launch-models.json\"\n",
                "model_catalog_json",
            ),
            (
                "model_provider = \"custom\"\n\n[model_providers.custom]\nname = \"custom\"\n",
                "model_provider",
            ),
            (
                "profile = \"p\"\n\n[profiles.p]\nmodel_provider = \"other\"\n",
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

    fn managed_on(port: u16) -> Managed {
        Managed {
            base_url: router_base_url(port),
            ..managed()
        }
    }

    /// AC5b：上次在 47328 写下的值，换到 47329 之后关掉仍能逐字节删干净
    #[test]
    fn ac5b_values_written_for_an_old_port_are_removed_byte_exact() {
        for original in [
            REALISTIC,
            "",
            "model = \"gpt\"",
            "model = \"gpt\"\r\n\r\n[desktop]\r\nmode = \"x\"\r\n",
        ] {
            let applied = apply(original, &managed_on(47328)).unwrap();
            let removed = remove(&applied.text, &managed_on(47329), applied.added_newline).unwrap();
            assert_eq!(removed.text, original);
            assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
        }
    }

    /// 范围内任一端口写下的值都算本功能的：指向路由、不算冲突；范围外的不认
    #[test]
    fn router_values_are_recognized_across_the_port_range_only() {
        let old = apply("model = \"gpt\"\n", &managed_on(47328)).unwrap().text;
        let seen = inspect(&old, &managed_on(47339)).unwrap();
        assert!(seen.points_at_router && !seen.enabled && seen.conflict.is_none());

        let outside = old.replace(":47328/", ":47340/");
        let seen = inspect(&outside, &managed_on(47329)).unwrap();
        assert!(!seen.points_at_router && seen.conflict.is_some());
        let removed = remove(&outside, &managed_on(47329), false).unwrap();
        assert!(removed.text.contains(":47340/"));
        assert!(!removed.warnings.is_empty());
    }

    /// 端口换了之后再启用：旧端口的值原位换成新端口，其余不动；之后关掉仍还原到启用前
    #[test]
    fn apply_moves_an_old_port_value_in_place() {
        let first = apply(REALISTIC, &managed_on(47328)).unwrap();
        let moved = apply(&first.text, &managed_on(47331)).unwrap();
        assert!(moved.changed);
        assert_eq!(moved.text, first.text.replace(":47328/", ":47331/"));
        assert!(inspect(&moved.text, &managed_on(47331)).unwrap().enabled);
        let removed = remove(&moved.text, &managed_on(47331), first.added_newline).unwrap();
        assert_eq!(removed.text, REALISTIC);
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

    // ----- 独立服务商形态（spec 2026-10-03-codex-hookup-auto R5、R7、R8） -----

    fn provider() -> Managed {
        Managed {
            mode: HookupMode::Provider,
            ..managed()
        }
    }

    fn provider_on(port: u16) -> Managed {
        Managed {
            base_url: router_base_url(port),
            ..provider()
        }
    }

    const OUR_TABLE: &str = "[model_providers.sophia]\nname = \"Sophia\"\nbase_url = \"http://127.0.0.1:47328/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n";

    fn doc(text: &str) -> toml_edit::DocumentMut {
        text.trim_start_matches('\u{feff}').parse().unwrap()
    }

    /// R5：独立形态多写根键 model_provider 与文件末尾的一张表，其余逐字节不动
    #[test]
    fn provider_form_adds_model_provider_and_a_table_at_the_end() {
        let applied = apply(REALISTIC, &provider()).unwrap();
        assert!(applied.changed && applied.inserted);
        let root_lines = format!("{COMMENT_PROVIDER}\n{OUR_KEYS}model_provider = \"sophia\"\n");
        let idx = applied
            .text
            .find(&root_lines)
            .expect("注释与三行根键应当相邻");
        assert!(
            idx < applied.text.find("\n[").unwrap(),
            "根键必须插在第一个表头之前"
        );
        assert!(
            applied.text.ends_with(&format!("\n\n{OUR_TABLE}")),
            "{}",
            applied.text
        );
        let without =
            applied.text[..applied.text.len() - OUR_TABLE.len() - 1].replacen(&root_lines, "", 1);
        assert_eq!(without, REALISTIC);
        let parsed = doc(&applied.text);
        assert_eq!(parsed["model_provider"].as_str(), Some("sophia"));
        let table = &parsed["model_providers"]["sophia"];
        assert_eq!(
            table["base_url"].as_str(),
            Some("http://127.0.0.1:47328/v1")
        );
        assert_eq!(table["wire_api"].as_str(), Some("responses"));
        assert_eq!(table["requires_openai_auth"].as_bool(), Some(false));
        let seen = inspect(&applied.text, &provider()).unwrap();
        assert!(seen.enabled && seen.points_at_router && seen.conflict.is_none());
        assert_eq!(seen.mode, Some(HookupMode::Provider));
    }

    /// AC10：独立形态写入后删除，逐字节还原（CRLF、BOM、末行无换行、文件末尾已有别的表）
    #[test]
    fn ac10_provider_form_removes_byte_exact() {
        let cases: &[(&str, &str)] = &[
            ("realistic", REALISTIC),
            ("empty", ""),
            ("no trailing newline", "model = \"gpt\""),
            ("table without trailing newline", "[desktop]\nx = 1"),
            ("crlf", "model = \"gpt\"\r\n\r\n[desktop]\r\nmode = \"x\"\r\n"),
            ("crlf no trailing newline", "model = \"gpt\"\r\n\r\n[desktop]\r\nmode = \"x\""),
            ("bom", "\u{feff}model = \"gpt\"\n\n[desktop]\nx = 1\n"),
            ("bom crlf", "\u{feff}model = \"gpt\"\r\n\r\n[desktop]\r\nx = 1\r\n"),
            ("trailing blank lines", "model = \"gpt\"\n\n[desktop]\nx = 1\n\n\n"),
            (
                "other providers already",
                "model = \"gpt\"\n\n[model_providers.ollama]\nname = \"Ollama\"\nbase_url = \"http://localhost:11434/v1\"\n",
            ),
            ("comment at end", "model = \"gpt\"\n\n[desktop]\nx = 1\n# end\n"),
        ];
        for (name, original) in cases {
            let applied = apply(original, &provider()).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(
                inspect(&applied.text, &provider()).unwrap().enabled,
                "{name}\n{}",
                applied.text
            );
            if applied.text.contains("\r\n") {
                assert!(
                    !applied.text.replace("\r\n", "").contains('\n'),
                    "{name}: {:?}",
                    applied.text
                );
            }
            let removed = remove(&applied.text, &provider(), applied.added_newline)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(
                removed.warnings.is_empty(),
                "{name}: {:?}",
                removed.warnings
            );
            assert_eq!(&removed.text, original, "{name}");
        }
    }

    /// 崩溃后留下的任一种形态，不论这次按哪种形态删，都删干净
    #[test]
    fn remove_cleans_either_form_whatever_mode_it_is_asked_with() {
        for original in [REALISTIC, "model = \"gpt\"", "[desktop]\r\nx = 1\r\n"] {
            let provider_form = apply(original, &provider()).unwrap();
            let removed =
                remove(&provider_form.text, &managed(), provider_form.added_newline).unwrap();
            assert_eq!(removed.text, original);
            assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
            let builtin_form = apply(original, &managed()).unwrap();
            let removed =
                remove(&builtin_form.text, &provider(), builtin_form.added_newline).unwrap();
            assert_eq!(removed.text, original);
            assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
        }
    }

    /// 写在旧端口上的独立形态，换端口之后照样删干净；之后再启用会把表里的地址一并换掉
    #[test]
    fn provider_form_follows_a_port_move() {
        let first = apply(REALISTIC, &provider_on(47328)).unwrap();
        let removed = remove(&first.text, &provider_on(47331), first.added_newline).unwrap();
        assert_eq!(removed.text, REALISTIC);
        let moved = apply(&first.text, &provider_on(47331)).unwrap();
        assert!(moved.changed);
        assert_eq!(moved.text, first.text.replace(":47328/", ":47331/"));
        assert!(inspect(&moved.text, &provider_on(47331)).unwrap().enabled);
        assert_eq!(
            retarget(&first.text, &provider_on(47331)).as_deref(),
            Some(moved.text.as_str())
        );
        let builtin = apply(REALISTIC, &managed_on(47328)).unwrap();
        assert_eq!(
            retarget(&builtin.text, &managed_on(47331)),
            Some(builtin.text.replace(":47328/", ":47331/"))
        );
        assert_eq!(retarget(&moved.text, &provider_on(47331)), None);
    }

    /// 用户改过那张表：保留并警告；根键照样删掉，Codex 回到官方
    #[test]
    fn a_table_the_user_changed_is_kept_with_a_warning() {
        let applied = apply("model = \"gpt\"\n", &provider()).unwrap();
        let edited = applied.text.replace("name = \"Sophia\"", "name = \"Mine\"");
        let removed = remove(&edited, &provider(), applied.added_newline).unwrap();
        assert!(removed.text.contains("[model_providers.sophia]"));
        assert!(removed.text.contains("name = \"Mine\""));
        assert!(root_str(&removed.text, "model_provider").is_none());
        assert!(root_str(&removed.text, KEY_BASE_URL).is_none());
        assert!(
            removed
                .warnings
                .iter()
                .any(|w| w.contains("model_providers.sophia")),
            "{:?}",
            removed.warnings
        );
    }

    /// 用户自己的同名表（和本功能无关）：删的时候不碰、也不警告
    #[test]
    fn remove_leaves_an_unrelated_sophia_table_alone() {
        let text = "model = \"gpt\"\n\n[model_providers.sophia]\nname = \"Someone else\"\nbase_url = \"https://elsewhere.example/v1\"\n";
        let removed = remove(text, &provider(), false).unwrap();
        assert_eq!(removed.text, text);
        assert!(removed.warnings.is_empty(), "{:?}", removed.warnings);
    }

    /// AC11：别人设的 model_provider 照旧拒绝；Sophia 自己写的 model_provider = "sophia" 和表不算冲突
    #[test]
    fn ac11_only_foreign_providers_conflict() {
        for mode in [managed(), provider()] {
            match apply("model_provider = \"my\"\n", &mode) {
                Err(ConfigError::Conflict(conflict)) => {
                    assert_eq!(conflict.key, KEY_MODEL_PROVIDER)
                }
                other => panic!("{other:?}"),
            }
            // 名字是 sophia、内容不是本功能的表：照旧冲突
            let foreign = "model_provider = \"sophia\"\n\n[model_providers.sophia]\nname = \"Other\"\nbase_url = \"https://other.example/v1\"\n";
            assert!(matches!(
                apply(foreign, &mode),
                Err(ConfigError::Conflict(_))
            ));
            assert!(inspect(foreign, &mode).unwrap().conflict.is_some());
        }
        let ours = apply("model = \"gpt\"\n", &provider()).unwrap().text;
        let again = apply(&ours, &provider()).unwrap();
        assert!(!again.changed);
        assert_eq!(again.text, ours);
        for mode in [managed(), provider()] {
            let seen = inspect(&ours, &mode).unwrap();
            assert!(seen.conflict.is_none(), "{:?}", seen.conflict);
            assert_eq!(seen.mode, Some(HookupMode::Provider));
        }
        // 独立形态要用 sophia 这个名字：用户自己有一张同名表就拒绝；借用内置形态不碰它
        let user_table =
            "[model_providers.sophia]\nname = \"Other\"\nbase_url = \"https://other.example/v1\"\n";
        assert!(matches!(
            apply(user_table, &provider()),
            Err(ConfigError::Conflict(_))
        ));
        assert!(apply(user_table, &managed()).is_ok());
        // 显式写着 model_provider = "openai"：借用内置可以，独立形态要改它，拒绝
        assert!(apply("model_provider = \"openai\"\n", &managed()).is_ok());
        assert!(matches!(
            apply("model_provider = \"openai\"\n", &provider()),
            Err(ConfigError::Conflict(_))
        ));
    }

    #[test]
    fn inspect_reports_the_written_form() {
        let plain = "model = \"gpt\"\n";
        assert_eq!(inspect(plain, &provider()).unwrap().mode, None);
        let builtin = apply(plain, &managed()).unwrap().text;
        let seen = inspect(&builtin, &provider()).unwrap();
        assert_eq!(seen.mode, Some(HookupMode::Builtin));
        assert!(seen.enabled && seen.points_at_router);
        let provider_form = apply(plain, &provider()).unwrap().text;
        let seen = inspect(&provider_form, &managed()).unwrap();
        assert_eq!(seen.mode, Some(HookupMode::Provider));
        assert!(seen.enabled && seen.points_at_router);
    }
}

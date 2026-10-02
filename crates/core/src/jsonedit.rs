//! JSON 配置文件的文本级改写：只动要改的那几个成员，其余字节（缩进、换行、键序、BOM、
//! 数字写法）原样保留，不经 serde 重新序列化整份文件。
//!
//! MCP 同步（往 `mcpServers` 里追加、切掉一项）与 Claude Code 模型网关（`~/.claude/settings.json`
//! 的 `env` 等成员）共用这一份。每个改写函数都自带语义核对：结果按 `serde_json::Value` 比较
//! 等于「原文件的值做同样的改动」，对不上就返回错误、不给结果。核对不依赖键序（core 单独构建时
//! `serde_json` 没开 `preserve_order`）。
//!
//! 路径是从根对象出发的一串成员名（`&["env", "ANTHROPIC_MODEL"]`），路径上的每一段都得是对象。
//! 编辑函数认文件开头的 UTF-8 BOM（原样保留）；`NoDuplicates` 本身不认 BOM，与 `serde_json` 一致。
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io;

/// 原文里的字节范围 `[start, end)`
pub type Span = (usize, usize);

/// 一个对象在原文里的位置：`start` 是 `{`，`end` 是 `}` 之后；`members` 是键 → 值的字节范围
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    pub start: usize,
    pub end: usize,
    pub members: BTreeMap<String, Span>,
}

/// 追加成员的排版
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// 紧凑：`,"k":v` 紧跟在最后一个成员后面；路径上新建的对象也写成一行。MCP 往已有对象里追加的写法
    Compact,
    /// 每个新成员另起一行、`": "` 带空格、固定两格缩进，不动 `}` 前的内容；新建的对象写成一行。
    /// MCP 往根里补 `mcpServers` 的写法
    Line,
    /// 跟随原文：每个新成员另起一行，缩进跟随同级已有成员（没有同级时＝外层缩进加一级，一级＝根成员的
    /// 缩进，再没有用 2 空格），换行跟随原文件（含 `\r\n` 即 CRLF）；空对象在 `}` 前补换行；
    /// 路径上新建的对象也逐层展开
    Pretty,
}

/// 改写被拒绝的原因
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// 不是合法 JSON
    Syntax,
    /// 有重复的对象键（含转义写法相同的键，如 `"a"` 与 `"\u0061"`）
    Duplicate,
    /// 路径上这一段存在但不是对象（空串＝根）
    NotObject(String),
    /// 要读的、要换的或要切的成员不存在
    Missing(String),
    /// 改写结果按语义核对与预期不一致（例如要加的成员已经在了）
    Mismatch,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Syntax => f.write_str(&crate::t!("models.jsonEdit.syntax")),
            Error::Duplicate => f.write_str(&crate::t!("models.jsonEdit.duplicate")),
            Error::NotObject(path) if path.is_empty() => {
                f.write_str(&crate::t!("models.jsonEdit.rootNotObject"))
            }
            Error::NotObject(path) => {
                f.write_str(&crate::t!("models.jsonEdit.notObject", path = path))
            }
            Error::Missing(path) => f.write_str(&crate::t!("models.jsonEdit.missing", path = path)),
            Error::Mismatch => f.write_str(&crate::t!("models.jsonEdit.mismatch")),
        }
    }
}

impl std::error::Error for Error {}

impl From<Error> for io::Error {
    fn from(error: Error) -> Self {
        io::Error::new(io::ErrorKind::InvalidData, error)
    }
}

/// 只校验、不取值：语法合法且任何一层都没有重复键（根不限类型）。
/// 用法：`serde_json::from_slice::<NoDuplicates>(bytes)`，错误带行列号
pub struct NoDuplicates;
impl<'de> Deserialize<'de> for NoDuplicates {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NoDuplicateVisitor)
    }
}
struct NoDuplicateVisitor;
impl<'de> Visitor<'de> for NoDuplicateVisitor {
    type Value = NoDuplicates;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("JSON without duplicate keys")
    }
    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_string<E: serde::de::Error>(self, _: String) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(NoDuplicates)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        while a.next_element_seed(Seed)?.is_some() {}
        Ok(NoDuplicates)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
        let mut keys = BTreeSet::new();
        while let Some(key) = a.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(serde::de::Error::custom("duplicate JSON key"));
            }
            a.next_value_seed(Seed)?;
        }
        Ok(NoDuplicates)
    }
}
struct Seed;
impl<'de> DeserializeSeed<'de> for Seed {
    type Value = NoDuplicates;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        NoDuplicates::deserialize(d)
    }
}

/// 一层对象的成员 → 值的原文（借用原文）；同一层重复的键在这里就拒绝
struct RawObject<'a> {
    fields: BTreeMap<String, &'a RawValue>,
}
impl<'de> Deserialize<'de> for RawObject<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(RawObjectVisitor)
    }
}
struct RawObjectVisitor;
impl<'de> Visitor<'de> for RawObjectVisitor {
    type Value = RawObject<'de>;
    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("JSON object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = BTreeMap::new();
        while let Some(name) = map.next_key::<String>()? {
            let value = map.next_value::<&'de RawValue>()?;
            if fields.insert(name, value).is_some() {
                return Err(serde::de::Error::custom("duplicate JSON key"));
            }
        }
        Ok(RawObject { fields })
    }
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// 文件开头的 UTF-8 BOM 之后的部分（没有 BOM 就是原文）
pub fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(BOM).unwrap_or(bytes)
}

/// 原文件的换行：含 `\r\n` 即 CRLF，否则 LF
pub fn newline(bytes: &[u8]) -> &'static str {
    if bytes.windows(2).any(|pair| pair == b"\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// 严格解析：认 BOM，拒语法错与重复键，要求根是对象
pub fn parse(bytes: &[u8]) -> Result<Map<String, Value>, Error> {
    match document(bytes)? {
        Value::Object(map) => Ok(map),
        _ => Err(Error::NotObject(String::new())),
    }
}

/// 根对象的位置与成员（认 BOM，首尾空白不算）
pub fn root(bytes: &[u8]) -> Result<Object, Error> {
    let start = skip(bytes, bytes.len() - strip_bom(bytes).len());
    let end = rtrim(bytes, bytes.len(), start);
    object_at(bytes, (start, end)).map_err(|error| match error {
        Error::NotObject(_) => Error::NotObject(String::new()),
        other => other,
    })
}

/// `span` 这一段（应当恰好是 `{…}`）作为对象的位置与成员
pub fn object_at(bytes: &[u8], span: Span) -> Result<Object, Error> {
    let (start, end) = span;
    if end > bytes.len()
        || start >= end
        || bytes.get(start) != Some(&b'{')
        || bytes.get(end - 1) != Some(&b'}')
    {
        return Err(Error::NotObject(String::new()));
    }
    let slice = &bytes[start..end];
    let RawObject { fields } = serde_json::from_slice(slice).map_err(|_| classify(slice))?;
    let base = slice.as_ptr() as usize;
    let mut members = BTreeMap::new();
    for (name, raw) in fields {
        let value = raw.get().as_bytes();
        let value_start = (value.as_ptr() as usize)
            .checked_sub(base)
            .and_then(|offset| start.checked_add(offset))
            .ok_or(Error::Syntax)?;
        let value_end = value_start
            .checked_add(value.len())
            .filter(|value_end| *value_end <= end)
            .ok_or(Error::Syntax)?;
        members.insert(name, (value_start, value_end));
    }
    Ok(Object {
        start,
        end,
        members,
    })
}

/// 路径所指成员的值的原文；路径上缺哪一段都返回 `None`，空路径返回根对象的原文
pub fn get<'a>(bytes: &'a [u8], path: &[&str]) -> Result<Option<&'a [u8]>, Error> {
    document(bytes)?;
    let Some((last, parent)) = path.split_last() else {
        let root = root(bytes)?;
        return Ok(Some(&bytes[root.start..root.end]));
    };
    let (object, rest) = walk(bytes, parent)?;
    if !rest.is_empty() {
        return Ok(None);
    }
    Ok(object.members.get(*last).map(|(s, e)| &bytes[*s..*e]))
}

/// 两段 JSON 原文按语义是否相等（对象不看键序；任一段不合法或有重复键即不等）
pub fn same(a: &[u8], b: &[u8]) -> bool {
    match (value(a), value(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 把已有成员的值原位换成 `value`（一段合法 JSON 原文）；键、位置和前后空白都不动
pub fn replace(bytes: &[u8], path: &[&str], value_text: &[u8]) -> Result<Vec<u8>, Error> {
    let mut expected = document(bytes)?;
    let new = value(value_text)?;
    let (last, parent) = path
        .split_last()
        .ok_or_else(|| Error::Missing(String::new()))?;
    let (object, rest) = walk(bytes, parent)?;
    let missing = || Error::Missing(path.join("."));
    if !rest.is_empty() {
        return Err(missing());
    }
    let (start, end) = *object.members.get(*last).ok_or_else(missing)?;
    let mut out = bytes.to_vec();
    out.splice(start..end, value_text.iter().copied());

    object_mut(&mut expected, parent, false)
        .ok_or(Error::Mismatch)?
        .insert((*last).to_owned(), new);
    verify(&out, &expected)?;
    Ok(out)
}

/// 在 `path` 所指对象的末尾按 `layout` 追加 `members`（名字 → 值的 JSON 原文，按给的顺序）；
/// 路径上缺的对象逐层新建（新建的那一层作为一个成员追加到最深的已有对象末尾）。要加的成员已经在了 → `Mismatch`
pub fn insert(
    bytes: &[u8],
    path: &[&str],
    members: &[(&str, &[u8])],
    layout: Layout,
) -> Result<Vec<u8>, Error> {
    let mut expected = document(bytes)?;
    let values = members
        .iter()
        .map(|(_, text)| value(text))
        .collect::<Result<Vec<_>, _>>()?;
    let (object, rest) = walk(bytes, path)?;
    let nl = newline(bytes);
    let empty = skip(bytes, object.start + 1) == object.end - 1;
    let at = rtrim(bytes, object.end - 1, object.start + 1);

    let mut out = bytes.to_vec();
    match layout {
        Layout::Compact | Layout::Line => {
            let entries = entries(rest, members, |name, value| {
                let separator = if layout == Layout::Compact { ":" } else { ": " };
                let lead = if layout == Layout::Compact {
                    String::new()
                } else {
                    format!("{nl}  ")
                };
                format!("{lead}{}{separator}{value}", key(name))
            });
            if !entries.is_empty() {
                let comma = if empty { "" } else { "," };
                let add = format!("{comma}{}", entries.join(","));
                out.splice(at..at, add.into_bytes());
            }
        }
        Layout::Pretty => {
            let unit = unit_indent(bytes);
            let outer = line_indent(bytes, object.start);
            let indent = sibling_indent(bytes, &object).unwrap_or_else(|| format!("{outer}{unit}"));
            let entries = pretty_entries(rest, members, &indent, &unit, nl);
            if empty && !entries.is_empty() {
                let inner = entries
                    .iter()
                    .map(|entry| format!("{nl}{indent}{entry}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let add = format!("{inner}{nl}{outer}");
                out.splice(object.start + 1..object.end - 1, add.into_bytes());
            } else if !entries.is_empty() {
                let add: String = entries
                    .iter()
                    .map(|entry| format!(",{nl}{indent}{entry}"))
                    .collect();
                out.splice(at..at, add.into_bytes());
            }
        }
    }

    let target = object_mut(&mut expected, path, true).ok_or(Error::Mismatch)?;
    for ((name, _), value) in members.iter().zip(values) {
        target.insert((*name).to_owned(), value);
    }
    verify(&out, &expected)?;
    Ok(out)
}

/// 切掉路径所指的成员，连同它前面（是第一个时则是后面）的逗号；唯一的成员切掉后留 `{}`
pub fn remove(bytes: &[u8], path: &[&str]) -> Result<Vec<u8>, Error> {
    let mut expected = document(bytes)?;
    let missing = || Error::Missing(path.join("."));
    let (last, parent) = path.split_last().ok_or_else(missing)?;
    let (object, rest) = walk(bytes, parent)?;
    if !rest.is_empty() {
        return Err(missing());
    }
    let target = *object.members.get(*last).ok_or_else(missing)?;
    let mut values: Vec<Span> = object.members.values().copied().collect();
    values.sort();
    let i = values
        .iter()
        .position(|v| *v == target)
        .ok_or(Error::Mismatch)?;
    let range = if values.len() == 1 {
        // 唯一的成员：留下 `{}`
        object.start + 1..object.end - 1
    } else if i > 0 {
        // 从上一个值的末尾（逗号之前）切到它的值末尾
        values[i - 1].1..target.1
    } else {
        // 第一个：从它的键切到下一个键，保留 `{` 后面的缩进
        let key = skip(bytes, object.start + 1);
        let comma = skip(bytes, target.1);
        if bytes.get(comma) != Some(&b',') {
            return Err(Error::Mismatch);
        }
        key..skip(bytes, comma + 1)
    };
    let mut out = bytes.to_vec();
    out.drain(range);

    object_mut(&mut expected, parent, false)
        .and_then(|map| map.remove(*last))
        .ok_or(Error::Mismatch)?;
    verify(&out, &expected)?;
    Ok(out)
}

// ===== 内部 =====

/// 整份文件（认 BOM）严格解析成值
fn document(bytes: &[u8]) -> Result<Value, Error> {
    value(strip_bom(bytes))
}

/// 一段 JSON 原文（不认 BOM）严格解析成值
fn value(bytes: &[u8]) -> Result<Value, Error> {
    if serde_json::from_slice::<NoDuplicates>(bytes).is_err() {
        return Err(classify(bytes));
    }
    serde_json::from_slice(bytes).map_err(|_| Error::Syntax)
}

/// 解析失败的原因：语法本身没问题就是重复键
fn classify(bytes: &[u8]) -> Error {
    if serde_json::from_slice::<IgnoredAny>(bytes).is_ok() {
        Error::Duplicate
    } else {
        Error::Syntax
    }
}

/// 改写结果的语义核对
fn verify(out: &[u8], expected: &Value) -> Result<(), Error> {
    match document(out) {
        Ok(actual) if actual == *expected => Ok(()),
        _ => Err(Error::Mismatch),
    }
}

/// 沿路径往下走：返回最深的已有对象，以及从第一段缺的开始剩下的路径（都在就为空）。
/// 某一段存在但不是对象 → `NotObject`
fn walk<'p, 's>(bytes: &[u8], path: &'p [&'s str]) -> Result<(Object, &'p [&'s str]), Error> {
    let mut object = root(bytes)?;
    for (i, name) in path.iter().enumerate() {
        let Some(span) = object.members.get(*name).copied() else {
            return Ok((object, &path[i..]));
        };
        object = object_at(bytes, span).map_err(|error| match error {
            Error::NotObject(_) => Error::NotObject(path[..=i].join(".")),
            other => other,
        })?;
    }
    Ok((object, &[]))
}

/// 值里路径所指的对象；`create` 时缺的逐层建空对象
fn object_mut<'v>(
    value: &'v mut Value,
    path: &[&str],
    create: bool,
) -> Option<&'v mut Map<String, Value>> {
    let mut map = value.as_object_mut()?;
    for name in path {
        if create && !map.contains_key(*name) {
            map.insert((*name).to_owned(), Value::Object(Map::new()));
        }
        map = map.get_mut(*name)?.as_object_mut()?;
    }
    Some(map)
}

fn key(name: &str) -> String {
    Value::String(name.to_owned()).to_string()
}

/// Compact / Line 要追加的条目：路径都在就是成员本身；缺了就是一个新建的紧凑对象
fn entries(
    rest: &[&str],
    members: &[(&str, &[u8])],
    entry: impl Fn(&str, &str) -> String,
) -> Vec<String> {
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    match rest.split_first() {
        None => members
            .iter()
            .map(|(name, value)| entry(name, &text(value)))
            .collect(),
        Some((first, deeper)) => {
            let inner = members
                .iter()
                .map(|(name, value)| format!("{}:{}", key(name), text(value)))
                .collect::<Vec<_>>()
                .join(",");
            let mut object = format!("{{{inner}}}");
            for name in deeper.iter().rev() {
                object = format!("{{{}:{object}}}", key(name));
            }
            vec![entry(first, &object)]
        }
    }
}

/// Pretty 要追加的条目（不含前导换行与缩进）：`indent` 是这些条目所在的缩进，
/// 新建的对象在它之下每层再加 `unit`
fn pretty_entries(
    rest: &[&str],
    members: &[(&str, &[u8])],
    indent: &str,
    unit: &str,
    nl: &str,
) -> Vec<String> {
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    let Some((first, deeper)) = rest.split_first() else {
        return members
            .iter()
            .map(|(name, value)| format!("{}: {}", key(name), text(value)))
            .collect();
    };
    let inner_indent = format!("{indent}{unit}");
    let inner = pretty_entries(deeper, members, &inner_indent, unit, nl)
        .iter()
        .map(|entry| format!("{nl}{inner_indent}{entry}"))
        .collect::<Vec<_>>()
        .join(",");
    vec![format!("{}: {{{inner}{nl}{indent}}}", key(first))]
}

/// 各成员的键在原文里的起点，按原文先后
fn key_starts(bytes: &[u8], object: &Object) -> Vec<usize> {
    let mut values: Vec<Span> = object.members.values().copied().collect();
    values.sort();
    let mut starts = Vec::with_capacity(values.len());
    let mut from = object.start + 1;
    for (_, end) in values {
        starts.push(skip(bytes, from));
        // 下一个键在逗号之后
        from = skip(bytes, end) + 1;
    }
    starts
}

/// 位置所在行的行首缩进是否只有空白直到这个位置：是则返回这段缩进
fn begins_line(bytes: &[u8], pos: usize) -> Option<String> {
    let line = bytes[..pos].iter().rposition(|b| *b == b'\n')? + 1;
    let prefix = &bytes[line..pos];
    prefix
        .iter()
        .all(|b| *b == b' ' || *b == b'\t')
        .then(|| String::from_utf8_lossy(prefix).into_owned())
}

/// 同级已有成员的缩进：从最后一个往前找第一个独占一行开头的键
fn sibling_indent(bytes: &[u8], object: &Object) -> Option<String> {
    key_starts(bytes, object)
        .into_iter()
        .rev()
        .find_map(|start| begins_line(bytes, start))
}

/// 一级缩进：根成员的缩进，没有用 2 空格
fn unit_indent(bytes: &[u8]) -> String {
    root(bytes)
        .ok()
        .and_then(|root| sibling_indent(bytes, &root))
        .filter(|indent| !indent.is_empty())
        .unwrap_or_else(|| "  ".to_owned())
}

/// 位置所在行开头的空白
fn line_indent(bytes: &[u8], pos: usize) -> String {
    let line = bytes[..pos]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |i| i + 1);
    let width = bytes[line..pos]
        .iter()
        .take_while(|b| **b == b' ' || **b == b'\t')
        .count();
    String::from_utf8_lossy(&bytes[line..line + width]).into_owned()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(bytes: &[u8]) -> &str {
        std::str::from_utf8(bytes).unwrap()
    }
    fn ins(text: &str, path: &[&str], members: &[(&str, &str)], layout: Layout) -> String {
        let members: Vec<(&str, &[u8])> = members.iter().map(|(k, v)| (*k, v.as_bytes())).collect();
        String::from_utf8(insert(text.as_bytes(), path, &members, layout).unwrap()).unwrap()
    }
    fn rm(text: &str, path: &[&str]) -> String {
        String::from_utf8(remove(text.as_bytes(), path).unwrap()).unwrap()
    }
    fn rep(text: &str, path: &[&str], value: &str) -> String {
        String::from_utf8(replace(text.as_bytes(), path, value.as_bytes()).unwrap()).unwrap()
    }

    // ===== 校验与读取 =====

    #[test]
    fn escaped_duplicate_key_is_rejected_at_any_depth() {
        assert!(serde_json::from_slice::<NoDuplicates>(br#"{"a":1,"\u0061":2}"#).is_err());
        assert!(serde_json::from_slice::<NoDuplicates>(br#"{"x":[{"k":1,"k":2}]}"#).is_err());
        assert!(serde_json::from_slice::<NoDuplicates>(br#"[1,"a",null,{"a":{}}]"#).is_ok());
        assert_eq!(parse(br#"{"a":{"b":1,"b":2}}"#), Err(Error::Duplicate));
        assert_eq!(parse(br#"{"a":1,"\u0061":2}"#), Err(Error::Duplicate));
    }

    #[test]
    fn parse_requires_object_root_and_valid_syntax() {
        for bad in ["[]", "1", "\"x\"", "null"] {
            assert_eq!(
                parse(bad.as_bytes()),
                Err(Error::NotObject(String::new())),
                "{bad}"
            );
        }
        for bad in ["", "{", "{\"a\":1,}", "{\"a\":1} x", "// c\n{}", "{'a':1}"] {
            assert_eq!(parse(bad.as_bytes()), Err(Error::Syntax), "{bad}");
        }
        let map = parse("\u{feff}{\"a\": 1}".as_bytes()).unwrap();
        assert_eq!(map.get("a"), Some(&Value::from(1)));
        // `NoDuplicates` 与 serde_json 一致，不认 BOM（MCP 靠它拒绝带 BOM 的文件）
        assert!(serde_json::from_slice::<NoDuplicates>("\u{feff}{}".as_bytes()).is_err());
    }

    #[test]
    fn bom_and_newline_detection() {
        assert_eq!(strip_bom("\u{feff}{}".as_bytes()), b"{}");
        assert_eq!(strip_bom(b"{}"), b"{}");
        assert_eq!(newline(b"{\r\n}"), "\r\n");
        assert_eq!(newline(b"{\n}"), "\n");
        assert_eq!(newline(b"{}"), "\n");
    }

    #[test]
    fn root_and_object_at_give_value_spans() {
        let text = " \n{ \"a\" : {\"b\": [1, \"}\"]}, \"c\\\"d\": \"//x\" }\n";
        let bytes = text.as_bytes();
        let root = root(bytes).unwrap();
        assert_eq!(&text[root.start..root.end], text.trim());
        let a = root.members["a"];
        assert_eq!(&text[a.0..a.1], "{\"b\": [1, \"}\"]}");
        assert_eq!(
            &text[root.members["c\"d"].0..root.members["c\"d"].1],
            "\"//x\""
        );
        let inner = object_at(bytes, a).unwrap();
        let b = inner.members["b"];
        assert_eq!(&text[b.0..b.1], "[1, \"}\"]");
        assert!(object_at(bytes, b).is_err());
        assert!(super::root(b"[1]").is_err());
        // BOM 之后的根
        let bom = "\u{feff}{\"k\":1}".as_bytes();
        let r = super::root(bom).unwrap();
        assert_eq!((r.start, r.end), (3, bom.len()));
    }

    #[test]
    fn get_reads_member_text_by_path() {
        let text = "\u{feff}{\n  \"env\": { \"A\" : \"x\", \"B\": {\"c\": 1.50} },\n  \"键\": \"值\",\n  \"s\": \"str\"\n}";
        let bytes = text.as_bytes();
        assert_eq!(get(bytes, &["env", "A"]).unwrap().map(s), Some("\"x\""));
        assert_eq!(get(bytes, &["env", "B", "c"]).unwrap().map(s), Some("1.50"));
        assert_eq!(get(bytes, &["键"]).unwrap().map(s), Some("\"值\""));
        assert_eq!(get(bytes, &["env", "Z"]).unwrap(), None);
        assert_eq!(get(bytes, &["nope", "Z"]).unwrap(), None);
        assert_eq!(get(bytes, &["s", "x"]), Err(Error::NotObject("s".into())));
        assert_eq!(get(bytes, &[]).unwrap().map(s), Some(&text[3..]));
        assert_eq!(get(br#"{"a":1,"a":2}"#, &["a"]), Err(Error::Duplicate));
    }

    #[test]
    fn same_compares_by_json_value() {
        assert!(same(br#"{"a":1,"b":[1,2]}"#, br#"{ "b": [1, 2], "a": 1 }"#));
        assert!(same(br#""\u0041""#, br#""A""#));
        assert!(!same(b"1", b"2"));
        assert!(!same(br#"{"a":1}"#, br#"{"a":1,"b":2}"#));
        assert!(!same(b"{", b"{"));
        assert!(!same(br#"{"a":1,"a":1}"#, br#"{"a":1}"#));
    }

    // ===== 原位替换 =====

    #[test]
    fn replace_keeps_position_and_other_bytes() {
        let text = "{\n    \"env\": {\n        \"A\": \"old\",\n        \"B\": 2\n    },\n    \"x\": [ 1,2 ]\n}";
        assert_eq!(
            rep(text, &["env", "A"], "\"new\""),
            "{\n    \"env\": {\n        \"A\": \"new\",\n        \"B\": 2\n    },\n    \"x\": [ 1,2 ]\n}"
        );
        assert_eq!(
            rep(text, &["env", "B"], "{\"o\":[1]}"),
            "{\n    \"env\": {\n        \"A\": \"old\",\n        \"B\": {\"o\":[1]}\n    },\n    \"x\": [ 1,2 ]\n}"
        );
        // CRLF 与 BOM 原样
        let crlf = "\u{feff}{\r\n  \"model\": \"a\"\r\n}\r\n";
        assert_eq!(
            rep(crlf, &["model"], "\"b\""),
            "\u{feff}{\r\n  \"model\": \"b\"\r\n}\r\n"
        );
        assert_eq!(
            replace(text.as_bytes(), &["env", "Z"], b"1"),
            Err(Error::Missing("env.Z".into()))
        );
        assert_eq!(
            replace(text.as_bytes(), &["env", "A"], b"{"),
            Err(Error::Syntax)
        );
        assert_eq!(
            replace(text.as_bytes(), &["env", "A"], br#"{"k":1,"k":2}"#),
            Err(Error::Duplicate)
        );
        assert_eq!(
            replace(text.as_bytes(), &["x", "A"], b"1"),
            Err(Error::NotObject("x".into()))
        );
    }

    // ===== 追加：Pretty =====

    #[test]
    fn pretty_insert_follows_sibling_indent() {
        let two = "{\n  \"env\": {\n    \"KEEP\": \"1\"\n  }\n}\n";
        assert_eq!(
            ins(
                two,
                &["env"],
                &[("A", "\"x\""), ("B", "\"y\"")],
                Layout::Pretty
            ),
            "{\n  \"env\": {\n    \"KEEP\": \"1\",\n    \"A\": \"x\",\n    \"B\": \"y\"\n  }\n}\n"
        );
        let four = "{\n    \"env\": {\n        \"KEEP\": \"1\"\n    }\n}\n";
        assert_eq!(
            ins(four, &["env"], &[("A", "\"x\"")], Layout::Pretty),
            "{\n    \"env\": {\n        \"KEEP\": \"1\",\n        \"A\": \"x\"\n    }\n}\n"
        );
        let tab = "{\n\t\"env\": {\n\t\t\"KEEP\": \"1\"\n\t}\n}";
        assert_eq!(
            ins(tab, &["env"], &[("A", "\"x\"")], Layout::Pretty),
            "{\n\t\"env\": {\n\t\t\"KEEP\": \"1\",\n\t\t\"A\": \"x\"\n\t}\n}"
        );
    }

    #[test]
    fn pretty_insert_follows_crlf_bom_and_missing_trailing_newline() {
        let crlf = "\u{feff}{\r\n  \"a\": 1\r\n}";
        assert_eq!(
            ins(crlf, &[], &[("m", "\"x\"")], Layout::Pretty),
            "\u{feff}{\r\n  \"a\": 1,\r\n  \"m\": \"x\"\r\n}"
        );
        assert_eq!(
            ins(crlf, &["env"], &[("A", "\"x\""), ("B", "\"y\"")], Layout::Pretty),
            "\u{feff}{\r\n  \"a\": 1,\r\n  \"env\": {\r\n    \"A\": \"x\",\r\n    \"B\": \"y\"\r\n  }\r\n}"
        );
    }

    #[test]
    fn pretty_insert_creates_missing_objects_with_root_indent() {
        // 根有 4 空格的成员、要建 env：env 本身跟同级 4 空格，里面再加 4 空格
        let four = "{\n    \"a\": 1\n}\n";
        assert_eq!(
            ins(four, &["env"], &[("A", "\"x\"")], Layout::Pretty),
            "{\n    \"a\": 1,\n    \"env\": {\n        \"A\": \"x\"\n    }\n}\n"
        );
        // 空根：2 空格
        assert_eq!(
            ins("{}", &["env"], &[("A", "\"x\"")], Layout::Pretty),
            "{\n  \"env\": {\n    \"A\": \"x\"\n  }\n}"
        );
        assert_eq!(
            ins("{}\n", &[], &[("m", "{\"options\":[]}")], Layout::Pretty),
            "{\n  \"m\": {\"options\":[]}\n}\n"
        );
        // 多层新建
        assert_eq!(
            ins("{}", &["a", "b"], &[("k", "1")], Layout::Pretty),
            "{\n  \"a\": {\n    \"b\": {\n      \"k\": 1\n    }\n  }\n}"
        );
    }

    #[test]
    fn pretty_insert_into_empty_object_uses_outer_indent_plus_unit() {
        let text = "{\n    \"env\": {},\n    \"z\": true\n}";
        assert_eq!(
            ins(text, &["env"], &[("A", "\"x\"")], Layout::Pretty),
            "{\n    \"env\": {\n        \"A\": \"x\"\n    },\n    \"z\": true\n}"
        );
        // 同级成员与 `{` 在同一行：看不出缩进，按外层缩进加一级
        let inline = "{\n  \"env\": {\"K\": 1},\n  \"z\": true\n}";
        assert_eq!(
            ins(inline, &["env"], &[("A", "2")], Layout::Pretty),
            "{\n  \"env\": {\"K\": 1,\n    \"A\": 2},\n  \"z\": true\n}"
        );
    }

    #[test]
    fn insert_refuses_existing_member_and_non_object_path() {
        let text = br#"{"env":{"A":"x"},"s":"str"}"#;
        for layout in [Layout::Compact, Layout::Line, Layout::Pretty] {
            assert_eq!(
                insert(text, &["env"], &[("A", b"\"y\"")], layout),
                Err(Error::Mismatch)
            );
            assert_eq!(
                insert(text, &["s"], &[("A", b"1")], layout),
                Err(Error::NotObject("s".into()))
            );
            assert_eq!(
                insert(text, &["s", "t"], &[("A", b"1")], layout),
                Err(Error::NotObject("s".into()))
            );
            assert_eq!(
                insert(text, &["env"], &[("B", b"{")], layout),
                Err(Error::Syntax)
            );
            assert_eq!(
                insert(br#"{"a":1,"a":2}"#, &[], &[("B", b"1")], layout),
                Err(Error::Duplicate)
            );
            assert_eq!(
                insert(b"[]", &[], &[("B", b"1")], layout),
                Err(Error::NotObject(String::new()))
            );
        }
    }

    // ===== 追加：Compact 与 Line（MCP 今天的写法） =====

    #[test]
    fn compact_insert_matches_mcp_bytes() {
        assert_eq!(
            ins(
                "{\"a\":1}",
                &[],
                &[("k", "{\"x\":1}"), ("j", "2")],
                Layout::Compact
            ),
            "{\"a\":1,\"k\":{\"x\":1},\"j\":2}"
        );
        assert_eq!(
            ins("{\n  \"a\": 1\n}\n", &[], &[("k", "2")], Layout::Compact),
            "{\n  \"a\": 1,\"k\":2\n}\n"
        );
        assert_eq!(
            ins("{ }", &[], &[("k", "2")], Layout::Compact),
            "{\"k\":2 }"
        );
        assert_eq!(
            ins(
                "{\"u\":0}",
                &["projects", "/p", "mcpServers"],
                &[("s", "{}")],
                Layout::Compact
            ),
            "{\"u\":0,\"projects\":{\"/p\":{\"mcpServers\":{\"s\":{}}}}}"
        );
        assert_eq!(
            ins(
                "{\"projects\":{\"/p\":{\"x\":1}}}",
                &["projects", "/p", "mcpServers"],
                &[("s", "{}")],
                Layout::Compact
            ),
            "{\"projects\":{\"/p\":{\"x\":1,\"mcpServers\":{\"s\":{}}}}}"
        );
    }

    #[test]
    fn line_insert_matches_mcp_root_bytes() {
        assert_eq!(
            ins(
                "{}",
                &["mcpServers"],
                &[("s", "{\"command\":\"x\"}")],
                Layout::Line
            ),
            "{\n  \"mcpServers\": {\"s\":{\"command\":\"x\"}}}"
        );
        assert_eq!(
            ins(
                "{\r\n    \"a\": 1\r\n}\r\n",
                &["mcpServers"],
                &[("s", "{}")],
                Layout::Line
            ),
            "{\r\n    \"a\": 1,\r\n  \"mcpServers\": {\"s\":{}}\r\n}\r\n"
        );
    }

    // ===== 切掉 =====

    #[test]
    fn remove_cuts_member_with_its_comma() {
        let text = "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n";
        assert_eq!(rm(text, &["a"]), "{\n  \"b\": 2,\n  \"c\": 3\n}\n");
        assert_eq!(rm(text, &["b"]), "{\n  \"a\": 1,\n  \"c\": 3\n}\n");
        assert_eq!(rm(text, &["c"]), "{\n  \"a\": 1,\n  \"b\": 2\n}\n");
        assert_eq!(rm("{\n  \"only\": 1\n}", &["only"]), "{}");
        assert_eq!(
            rm("{\"x\":{\"only\":{\"k\":[1]}},\"y\":2}", &["x", "only"]),
            "{\"x\":{},\"y\":2}"
        );
        let crlf = "\u{feff}{\r\n  \"env\": {\r\n    \"A\": 1,\r\n    \"B\": 2\r\n  }\r\n}";
        assert_eq!(
            rm(crlf, &["env", "B"]),
            "\u{feff}{\r\n  \"env\": {\r\n    \"A\": 1\r\n  }\r\n}"
        );
        assert_eq!(
            remove(text.as_bytes(), &["z"]),
            Err(Error::Missing("z".into()))
        );
        assert_eq!(
            remove(text.as_bytes(), &["z", "a"]),
            Err(Error::Missing("z.a".into()))
        );
        assert_eq!(
            remove(text.as_bytes(), &["a", "b"]),
            Err(Error::NotObject("a".into()))
        );
        assert_eq!(
            remove(text.as_bytes(), &[]),
            Err(Error::Missing(String::new()))
        );
    }

    /// Pretty 追加后逐个切掉（任意顺序）＝原文，逐字节
    #[test]
    fn pretty_insert_then_remove_round_trips_bytes() {
        let fixtures = [
            "{}",
            "{}\n",
            "{\n  \"env\": {\n    \"OTHER\": \"1\"\n  },\n  \"x\": 1\n}\n",
            "{\n    \"env\": {\n        \"OTHER\": \"1\"\n    }\n}",
            "{\n\t\"env\": {\n\t\t\"OTHER\": \"1\"\n\t}\n}\n",
            "{\r\n  \"env\": {\r\n    \"OTHER\": \"1\"\r\n  }\r\n}\r\n",
            "\u{feff}{\n  \"env\": {\"OTHER\": \"1\"}\n}",
            "{\n  \"env\": {}\n}\n",
            "{\"x\":1}",
        ];
        for original in fixtures {
            let mut text = ins(
                original,
                &["env"],
                &[("A", "\"a\""), ("B", "\"b\"")],
                Layout::Pretty,
            );
            let had_env = get(original.as_bytes(), &["env"]).unwrap().is_some();
            text = ins(&text, &[], &[("m", "{\"o\":[1]}")], Layout::Pretty);
            text = rm(&text, &["env", "A"]);
            text = rm(&text, &["m"]);
            text = rm(&text, &["env", "B"]);
            if !had_env {
                text = rm(&text, &["env"]);
            }
            assert_eq!(text, original, "{original:?}");
        }
    }

    /// 替换再换回原值原文＝原文，逐字节
    #[test]
    fn replace_then_restore_round_trips_bytes() {
        let original =
            "{\r\n  \"env\": {\r\n    \"ANTHROPIC_MODEL\": \"opus\",\r\n    \"N\": 1e3\r\n  }\r\n}";
        let old = get(original.as_bytes(), &["env", "ANTHROPIC_MODEL"])
            .unwrap()
            .unwrap()
            .to_vec();
        let changed = rep(original, &["env", "ANTHROPIC_MODEL"], "\"ours\"");
        assert!(same(
            get(changed.as_bytes(), &["env", "ANTHROPIC_MODEL"])
                .unwrap()
                .unwrap(),
            b"\"ours\""
        ));
        assert_eq!(
            rep(&changed, &["env", "ANTHROPIC_MODEL"], s(&old)),
            original
        );
    }

    #[test]
    fn legal_json_edge_cases() {
        // 空串键、转义键、字符串里的括号与注释样文字、数字写法、各种空白
        let text =
            "{\"\":0,\t\"q\\\"k\" :\r\n \"}{//\",\"n\":-1.0e+2,\"u\":\"\\u00e9\",\"z\":[{},[]]}";
        assert_eq!(get(text.as_bytes(), &[""]).unwrap().map(s), Some("0"));
        assert_eq!(
            get(text.as_bytes(), &["q\"k"]).unwrap().map(s),
            Some("\"}{//\"")
        );
        let out = ins(text, &[], &[("new\"", "null")], Layout::Compact);
        assert!(out.ends_with(",\"new\\\"\":null}"));
        assert_eq!(rm(&out, &["new\""]), text);
        assert_eq!(
            rm(text, &["q\"k"]),
            "{\"\":0,\"n\":-1.0e+2,\"u\":\"\\u00e9\",\"z\":[{},[]]}"
        );
        assert_eq!(
            rm(text, &[""]),
            "{\"q\\\"k\" :\r\n \"}{//\",\"n\":-1.0e+2,\"u\":\"\\u00e9\",\"z\":[{},[]]}"
        );
        let replaced = rep(text, &["n"], "7");
        assert!(replaced.contains("\"n\":7,"));
    }
}

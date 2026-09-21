//! 从请求体里取模型名、读路由清单、规整模型名。
use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;

pub const AUTO_REVIEW_MODEL_KEY: &str = "codex-auto-review";

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RoutingModel {
    pub slug: String,
    #[serde(default)]
    pub upstream_model: String,
    /// 所属网关的 id；旧格式的清单没有这个字段，走启动参数给的那个上游
    #[serde(default)]
    pub provider: String,
}

/// 清单里的一家上游，原样读入；地址是否可用由路由在用到时校验，
/// 这样一家写坏了不会连累整份清单
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RoutingProvider {
    pub id: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub protocol: String,
}

#[derive(Debug, Default)]
pub struct RoutingCatalog {
    pub active: HashMap<String, RoutingModel>,
    pub retired: HashSet<String>,
    pub providers: HashMap<String, RoutingProvider>,
}

pub fn load_routing_catalog(path: &Path) -> Result<RoutingCatalog, String> {
    #[derive(serde::Deserialize)]
    struct Doc {
        #[serde(default)]
        providers: Vec<RoutingProvider>,
        #[serde(default)]
        models: Vec<RoutingModel>,
        #[serde(default)]
        retired: Vec<String>,
    }
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let doc: Doc = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let mut catalog = RoutingCatalog::default();
    for provider in doc.providers {
        // 同一个 id 出现两次时以先出现的为准，避免后面的条目悄悄改写上游
        catalog
            .providers
            .entry(provider.id.clone())
            .or_insert(provider);
    }
    for model in doc.models {
        let key = model_key(&model.slug);
        if !key.is_empty() {
            catalog.active.insert(key, model);
        }
    }
    for slug in doc.retired {
        let key = model_key(&slug);
        if !key.is_empty() && !catalog.active.contains_key(&key) {
            catalog.retired.insert(key);
        }
    }
    Ok(catalog)
}

/// 把模型名规整成比较用的键：小写，去掉空白、零宽字符等一切非常规字符。
/// 这样大小写或不可见字符的变体仍会被认成同一个第三方模型，而不是“不认识的模型”。
pub fn model_key(model: &str) -> String {
    model
        .to_lowercase()
        .chars()
        .filter(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | '/' | ':')
        })
        .collect()
}

/// 逐个读取顶层键来取模型名。不用结构体解析：serde 对重复键取最后一个，而上游可能取第一个，
/// 键名大小写不同的 `Model` 也可能被某一侧当成 `model`。两边理解不一致时请求就可能被送错地方，
/// 所以重复的、大小写不同的、不是字符串的 `model` 一律报错。
///
/// `strict` 为 true 时请求体必须是 JSON 对象；否则读不懂就当作没有模型名。
pub fn top_level_model(body: &[u8], strict: bool) -> Result<Option<String>, String> {
    if body.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    struct TopLevel;
    impl<'de> Visitor<'de> for TopLevel {
        type Value = Result<Option<String>, String>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut model: Option<String> = None;
            let mut problem: Option<String> = None;
            while let Some(key) = map.next_key::<String>()? {
                if !key.eq_ignore_ascii_case("model") {
                    map.next_value::<IgnoredAny>()?;
                    continue;
                }
                let value = map.next_value::<serde_json::Value>()?;
                if key != "model" || model.is_some() {
                    problem.get_or_insert_with(|| "ambiguous model field".to_owned());
                    continue;
                }
                match value {
                    serde_json::Value::String(text) => model = Some(text),
                    _ => {
                        problem.get_or_insert_with(|| "model must be a string".to_owned());
                        model = Some(String::new());
                    }
                }
            }
            Ok(match problem {
                Some(problem) => Err(problem),
                None => Ok(model.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty())),
            })
        }
    }
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let parsed = deserializer
        .deserialize_map(TopLevel)
        .and_then(|value| deserializer.end().map(|()| value));
    match parsed {
        Ok(result) => result,
        Err(_) if strict => Err("request body is not a JSON object".to_owned()),
        Err(_) => Ok(None),
    }
}

/// 把请求体里的 `model` 换成网关认识的名字，其余字段原样保留
pub fn replace_request_model(body: &[u8], model: &str) -> Result<Vec<u8>, String> {
    let mut doc: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(body).map_err(|e| e.to_string())?;
    doc.insert(
        "model".to_owned(),
        serde_json::Value::String(model.to_owned()),
    );
    serde_json::to_vec(&doc).map_err(|e| e.to_string())
}

/// 写日志前清洗：模型名和路径来自请求，不能让它们往日志里注入换行或超长内容
pub fn log_safe(value: &str) -> String {
    if value.is_empty() {
        return "-".to_owned();
    }
    value
        .chars()
        // 零宽字符、方向控制符这类“格式字符”也去掉：它们能让日志看起来和实际内容不一样
        .filter(
            |c| !matches!(*c as u32, 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0xFEFF),
        )
        .map(|c| {
            if c.is_whitespace() || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect()
}

/// 请求体看起来是 JSON（第一个非空白字节是 `{` 或 `[`）
pub fn looks_like_json(body: &[u8]) -> bool {
    body.iter()
        .find(|b| !b.is_ascii_whitespace())
        .is_some_and(|b| matches!(b, b'{' | b'['))
}

/// 路径里不允许 `..`、`.`、空段和百分号编码的点：否则能带着凭据访问上游同主机的其他路径
pub fn path_is_safe(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
        || path.contains('\\')
    {
        return false;
    }
    path.starts_with('/')
        && path
            .split('/')
            .skip(1)
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

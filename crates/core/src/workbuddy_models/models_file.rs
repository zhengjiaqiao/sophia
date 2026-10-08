//! `~/.workbuddy/models.json` 的文本级改写（经 `jsonedit`：认 BOM、跟随缩进与换行，每一步按值核对）。
//!
//! WorkBuddy 认两种写法：裸数组（它自己在设置里保存时就写成 `JSON.stringify(models, null, 2)` 的数组），
//! 或 `{"models": [...], "availableModels": [...]}`。Sophia 只往模型列表里增删自己的条目，**不写 `availableModels`**
//! （写了会整份替换 WorkBuddy 的可用模型列表，#249）。
//!
//! 怎么认得哪条是 Sophia 的：`url` 指着本机路由的 `/workbuddy/` 命名空间（端口范围内任一端口）。
//! WorkBuddy 在设置里改一条时，会把整条连同别的字段重新写回，但地址就是它要请求的地方，不会丢；
//! 用户把地址改走了，这一条就归用户。用户对 Sophia 条目的改动（关掉 `disabled`、思考强度 `reasoning`、
//! 改名……）都保留：已有的条目只校正地址与令牌，名字只在还是 Sophia 起的（原名或「原名 · 提供商名」）时跟着换。
//! Sophia 的条目按「已选」顺序排在它们原来占的那几个位置上，用户的条目不挪。
use crate::codex_models::settings::PORT_RANGE;
use crate::jsonedit::{self, Error, Layout, Span};
use serde::Serialize;
use serde_json::Value;

/// 路由里 WorkBuddy 的命名空间
const NAMESPACE: &str = "/workbuddy/";
const ROOT: &[&str] = &[];
const MODELS: &[&str] = &["models"];

/// 一条要写进 models.json 的 Sophia 条目
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// 在 WorkBuddy 里的 id：显示名（见 [`entry_ids`]；撞上了才退回 `<提供商 id>-<模型>`），也是路由清单里的标识
    pub id: String,
    /// 显示名：两家撞名时带「 · 提供商名」
    pub name: String,
    /// 不带后缀的显示名：认「这个名字还是 Sophia 起的」用
    pub plain_name: String,
    /// 提供商名
    pub vendor: String,
    pub max_input_tokens: Option<u32>,
    pub supports_images: bool,
}

/// 新加的一条（字段按这个顺序写出）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewEntry<'a> {
    id: &'a str,
    name: &'a str,
    vendor: &'a str,
    url: &'a str,
    api_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_input_tokens: Option<u32>,
    supports_tool_call: bool,
    supports_images: bool,
}

/// 写进条目 `url` 的地址：WorkBuddy 要求写到 `/chat/completions` 的完整路径
pub fn router_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/workbuddy/v1/chat/completions")
}

/// 是不是 Sophia 写下的路由地址（端口范围内任一端口：换过端口、崩溃后留下的也认）
pub fn is_router_url(url: &str) -> bool {
    let Some(rest) = url.trim().strip_prefix("http://") else {
        return false;
    };
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    let host_ok = host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost");
    let port_ok = port.parse::<u16>().is_ok_and(|p| PORT_RANGE.contains(&p));
    host_ok
        && port_ok
        && format!("/{path}")
            .to_ascii_lowercase()
            .starts_with(NAMESPACE)
}

/// 列表里的一项
struct Slot {
    index: usize,
    span: Span,
    id: Option<String>,
    sophia: bool,
}

/// 模型列表在哪：根是数组 → 根；根是对象 → 它的 `models`（还没有为 None）。别的 → 错
fn locate(bytes: &[u8]) -> Result<Option<&'static [&'static str]>, Error> {
    match jsonedit::parse(bytes) {
        Ok(map) => Ok(map.contains_key("models").then_some(MODELS)),
        Err(Error::NotObject(_)) => {
            jsonedit::array(bytes, ROOT)?;
            Ok(Some(ROOT))
        }
        Err(error) => Err(error),
    }
}

fn slots(bytes: &[u8], path: &[&str]) -> Result<Vec<Slot>, Error> {
    let found = jsonedit::array(bytes, path)?;
    Ok(found
        .items
        .into_iter()
        .enumerate()
        .map(|(index, span)| {
            let value: Value = serde_json::from_slice(&bytes[span.0..span.1]).unwrap_or_default();
            let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
            Slot {
                index,
                span,
                id: text("id"),
                sophia: text("url").is_some_and(|url| is_router_url(&url)),
            }
        })
        .collect())
}

/// 文件里 Sophia 条目的 id，按文件顺序（文件没有模型列表时为空）
pub fn sophia_ids(bytes: &[u8]) -> Result<Vec<String>, Error> {
    let Some(path) = locate(bytes)? else {
        return Ok(Vec::new());
    };
    Ok(slots(bytes, path)?
        .into_iter()
        .filter(|slot| slot.sophia)
        .filter_map(|slot| slot.id)
        .collect())
}

/// 文件里用户自己条目（不是 Sophia 的）的 id（文件没有模型列表时为空）
pub fn user_ids(bytes: &[u8]) -> Result<Vec<String>, Error> {
    let Some(path) = locate(bytes)? else {
        return Ok(Vec::new());
    };
    Ok(slots(bytes, path)?
        .into_iter()
        .filter(|slot| !slot.sophia)
        .filter_map(|slot| slot.id)
        .collect())
}

/// Sophia 条目的 id（走查 2026-10-07 第 9 条）：WorkBuddy 把名字与 id 不同的自定义模型在菜单里显示成「名字:id」，
/// 所以 id 就用显示名（`wanted` 里每项的前一个），菜单里只出模型名。显示名在路由的键（`routing_key`）下为空、
/// 或撞上用户条目的 id、前面已经用掉的 id 时，这一项退回内部标识（后一个）。路由的键留着汉字，
/// 名字只差在中文部分的两家（「QA 全开」「QA 撞名」）不算撞（走查 2026-10-08）
pub fn entry_ids(wanted: &[(String, String)], user_ids: &[String]) -> Vec<String> {
    use crate::codex_models::catalog::routing_key;
    let mut taken: Vec<String> = user_ids.iter().map(|id| routing_key(id)).collect();
    wanted
        .iter()
        .map(|(shown, fallback)| {
            let shown = shown.trim();
            let key = routing_key(shown);
            let id = if key.is_empty() || taken.contains(&key) {
                fallback.clone()
            } else {
                shown.to_owned()
            };
            taken.push(routing_key(&id));
            id
        })
        .collect()
}

/// 用户自己写了可用模型名单（根对象里的 `availableModels` 数组），而 Sophia 的条目有不在名单里的：
/// 名单外的模型 WorkBuddy 不列出来。Sophia 不替用户改名单（写了会整份替换，#249），只据此在行下说一声
pub fn hidden_by_allow_list(bytes: &[u8]) -> Result<bool, Error> {
    let allowed: Vec<String> = match jsonedit::parse(bytes) {
        Ok(map) => match map.get("availableModels").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            None => return Ok(false),
        },
        // 裸数组没有名单
        Err(Error::NotObject(_)) => return Ok(false),
        Err(error) => return Err(error),
    };
    Ok(sophia_ids(bytes)?.iter().any(|id| !allowed.contains(id)))
}

/// 把 models.json 带到「Sophia 的条目恰是 `entries`（按这个顺序）、都指着 `port` 上的路由、带着令牌 `token`」。
/// `current`：文件现在的内容（不存在为 None；空白当不存在）。`entries` 为空＝拿掉 Sophia 的全部条目（退出、关掉）。
/// 返回新内容；不用改为 None。读不懂（不是合法 JSON、有重复键、模型列表不是数组）→ 错，文件不动。
/// 用户已经用了同一个 id 的（地址不是路由）那一条留给用户，Sophia 这条不加
pub fn plan(
    current: Option<&[u8]>,
    entries: &[Entry],
    port: u16,
    token: &str,
) -> Result<Option<Vec<u8>>, Error> {
    let original = current.filter(|bytes| {
        !jsonedit::strip_bom(bytes)
            .iter()
            .all(u8::is_ascii_whitespace)
    });
    let mut bytes = match original {
        Some(bytes) => bytes.to_vec(),
        None if entries.is_empty() => return Ok(None),
        None => b"[]\n".to_vec(),
    };
    let path = match locate(&bytes)? {
        Some(path) => path,
        None if entries.is_empty() => return Ok(None),
        None => {
            bytes = jsonedit::insert(&bytes, ROOT, &[("models", b"[]")], Layout::Pretty)?;
            MODELS
        }
    };
    let url = router_url(port);
    let wanted = |id: &str| entries.iter().any(|entry| entry.id == id);

    // 1. 拿掉不再选的（同一个 id 出现两次的，留第一条）
    let mut kept: Vec<String> = Vec::new();
    let mut drop = Vec::new();
    for slot in slots(&bytes, path)?.into_iter().filter(|slot| slot.sophia) {
        match slot.id {
            Some(id) if wanted(&id) && !kept.contains(&id) => kept.push(id),
            _ => drop.push(slot.index),
        }
    }
    for index in drop.into_iter().rev() {
        bytes = jsonedit::remove_item(&bytes, path, index)?;
    }

    // 2. 新选的追加在末尾（id 已被用户占了的不加）
    let present = slots(&bytes, path)?;
    let added: Vec<NewEntry> = entries
        .iter()
        .filter(|entry| {
            !present
                .iter()
                .any(|slot| slot.id.as_deref() == Some(&entry.id))
        })
        .map(|entry| NewEntry {
            id: &entry.id,
            name: &entry.name,
            vendor: &entry.vendor,
            url: &url,
            api_key: token,
            max_input_tokens: entry.max_input_tokens,
            supports_tool_call: true,
            supports_images: entry.supports_images,
        })
        .collect();
    bytes = jsonedit::push(&bytes, path, &added)?;

    // 3. Sophia 的条目在它们占着的位置上按「已选」顺序排（整条原文挪动，用户的改动跟着走）
    let ours: Vec<Slot> = slots(&bytes, path)?
        .into_iter()
        .filter(|slot| slot.sophia)
        .collect();
    let texts: Vec<(String, Vec<u8>)> = ours
        .iter()
        .filter_map(|slot| Some((slot.id.clone()?, bytes[slot.span.0..slot.span.1].to_vec())))
        .collect();
    let order: Vec<&str> = entries
        .iter()
        .map(|entry| entry.id.as_str())
        .filter(|id| texts.iter().any(|(have, _)| have == id))
        .collect();
    for (slot, id) in ours.iter().zip(&order) {
        if slot.id.as_deref() == Some(*id) {
            continue;
        }
        let (_, text) = texts
            .iter()
            .find(|(have, _)| have == id)
            .ok_or(Error::Mismatch)?;
        bytes = jsonedit::replace_item(&bytes, path, slot.index, text)?;
    }

    // 4. 校正地址、令牌与 Sophia 起的名字
    // 每改一条，后面各条的位置都会变：逐条重新取位置
    let count = slots(&bytes, path)?.len();
    for index in 0..count {
        let Some(slot) = slots(&bytes, path)?
            .into_iter()
            .find(|slot| slot.index == index && slot.sophia)
        else {
            continue;
        };
        let Some(entry) = entries
            .iter()
            .find(|entry| slot.id.as_deref() == Some(entry.id.as_str()))
        else {
            continue;
        };
        let item = bytes[slot.span.0..slot.span.1].to_vec();
        let fixed = fix_item(&item, entry, &url, token)?;
        if fixed != item {
            bytes = jsonedit::replace_item(&bytes, path, slot.index, &fixed)?;
        }
    }

    Ok((original != Some(bytes.as_slice())).then_some(bytes))
}

/// 一条已有的 Sophia 条目：地址、令牌换成现在的；名字还是 Sophia 起的才换。别的字段一律不动
fn fix_item(item: &[u8], entry: &Entry, url: &str, token: &str) -> Result<Vec<u8>, Error> {
    let fields = jsonedit::parse(item)?;
    let layout = if item.contains(&b'\n') {
        Layout::Pretty
    } else {
        Layout::Compact
    };
    let mut out = item.to_vec();
    let mut set = |key: &str, want: &str| -> Result<(), Error> {
        let text = Value::String(want.to_owned()).to_string();
        out = match fields.get(key) {
            Some(Value::String(have)) if have == want => return Ok(()),
            Some(_) => jsonedit::replace(&out, &[key], text.as_bytes())?,
            None => jsonedit::insert(&out, ROOT, &[(key, text.as_bytes())], layout)?,
        };
        Ok(())
    };
    set("url", url)?;
    set("apiKey", token)?;
    let ours = |name: &str| {
        name == entry.plain_name || name.starts_with(&format!("{} · ", entry.plain_name))
    };
    if let Some(Value::String(name)) = fields.get("name") {
        if name != &entry.name && ours(name) {
            set("name", &entry.name)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "models_file_tests.rs"]
mod tests;

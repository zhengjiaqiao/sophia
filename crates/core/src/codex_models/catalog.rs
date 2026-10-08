//! Codex 模型选择器读取的合并目录（官方条目 + 第三方条目）与路由用的第三方清单。
//!
//! 移植自 agents-manager 的 `internal/catalog`（同一作者的 Go 项目）；第三方条目的字段集合出处见仓库根 NOTICE。
//! 官方条目以原始 JSON 文本保存并原样写回：本 crate 的 serde_json 没开 `preserve_order`，
//! 经 `Value` 转一圈会打乱键顺序，所以用 `RawValue`。
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io;
use std::path::Path;

/// 标记本功能生成的条目，重新生成时据此识别并剔除。
pub const OWN_DESCRIPTION: &str = "Sophia third-party model";
/// 前身 agents-manager 写下的标记；解析官方目录时同样当作自己的条目剔除。
const LEGACY_OWN_DESCRIPTION: &str = "agents-manager third-party model";

const FALLBACK_BASE_INSTRUCTIONS: &str = "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.";
const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;
/// 告诉 Codex 的窗口上限（spec 2026-10-05-codex-context-cap R1）：窗口再大也只报这个数，让 Codex 早点压缩对话，
/// 不然 100 万窗口的模型做长任务会越用越慢。272K 是 OpenAI 自己的模型报给 Codex 的数，magpie 也取它
pub const WORKING_WINDOW: u32 = 272_000;

/// 一个要加入 Codex 的第三方模型
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// 网关认识的模型名
    pub id: String,
    /// 选择器里显示的名字；缺省用 `id`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 缺省或 0 表示用保守默认值
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub vision: bool,
    /// 用户手动填的（sophia-dev#117）：不是网关列表给的，重新拉取时不被冲掉；取消勾选就从列表移除
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
}

/// 只有模型名、其余取缺省的模型（拉取到的列表里没带上下文长度时就是这样）
impl From<&str> for Model {
    fn from(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            ..Self::default()
        }
    }
}

impl From<String> for Model {
    fn from(id: String) -> Self {
        Self {
            id,
            ..Self::default()
        }
    }
}

/// 一个已勾选、要写进目录的第三方模型：带上它在 Codex 里的标识，以及属于哪一家网关。
/// 标识由调用方给定（`settings::provider_slug`），这里不再自己从模型名推。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    pub slug: String,
    /// 所属 provider 的 id；路由据此取上游地址和密钥
    pub provider: String,
    pub model: Model,
}

/// 写进路由清单的一家上游
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutingProvider {
    pub id: String,
    pub base_url: String,
    /// "chat" 或 "responses"
    pub protocol: String,
}

/// 把网关模型名变成 Codex 里用的标识：小写，斜杠等分隔符换成连字符。
pub fn slug_for(id: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true;
    for c in id.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' {
            slug.push(c);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

/// 路由认模型用的键：小写，去掉空白、零宽字符、标点等非常规字符（大小写或不可见字符的变体认成同一个模型）。
/// 汉字等非 ASCII 的字母、数字留着：WorkBuddy 条目的 id 是显示名，名字只差在中文部分的两家不能认成同一个。
/// 路由按它查清单，写清单的一方按它查重
pub fn routing_key(model: &str) -> String {
    model
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':'))
        .collect()
}

/// 官方目录的来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeSource {
    /// `models_cache.json`
    Cache,
    /// `codex debug models --bundled`
    Bundled,
}

/// 读到的官方目录；条目保持原始 JSON 文本
#[derive(Debug, Clone)]
pub struct Native {
    pub models: Vec<Box<RawValue>>,
    pub client_version: String,
    pub source: NativeSource,
}

/// 解析 Codex 的模型缓存或 `codex debug models` 的输出，剔除本功能自己的条目。
/// 返回（官方条目原文，client_version）。
pub fn parse_native(data: &[u8]) -> Result<(Vec<Box<RawValue>>, String), String> {
    #[derive(Deserialize)]
    struct Doc {
        #[serde(default)]
        client_version: Option<String>,
        #[serde(default)]
        models: Option<Vec<Box<RawValue>>>,
    }
    #[derive(Deserialize)]
    struct Head {
        #[serde(default)]
        slug: Option<String>,
        #[serde(default)]
        description: Option<String>,
    }
    let doc: Doc = serde_json::from_slice(data)
        .map_err(|error| format!("parse native model catalog: {error}"))?;
    let mut models = Vec::new();
    for raw in doc.models.unwrap_or_default() {
        let head = serde_json::from_str::<Head>(raw.get())
            .ok()
            .filter(|head| !head.slug.as_deref().unwrap_or("").trim().is_empty())
            .ok_or("native model catalog has an entry without slug")?;
        let description = head.description.as_deref().unwrap_or("");
        if description == OWN_DESCRIPTION || description == LEGACY_OWN_DESCRIPTION {
            continue;
        }
        models.push(raw);
    }
    Ok((models, doc.client_version.unwrap_or_default()))
}

/// 先读 `codex_home` 下的模型缓存，读不到或为空时调用 `bundled`（`codex debug models --bundled`）。
/// 刻意不读取 `auth.json`。
pub fn load_native(
    codex_home: &Path,
    bundled: impl FnOnce() -> io::Result<Vec<u8>>,
) -> Result<Native, String> {
    let parse = |data: &[u8], source: NativeSource, empty: &str| match parse_native(data)? {
        (models, _) if models.is_empty() => Err(empty.to_string()),
        (models, client_version) => Ok(Native {
            models,
            client_version,
            source,
        }),
    };
    let cache = std::fs::read(codex_home.join("models_cache.json"))
        .map_err(|error| error.to_string())
        .and_then(|data| parse(&data, NativeSource::Cache, "model cache is empty"));
    let cache_error = match cache {
        Ok(native) => return Ok(native),
        Err(error) => error,
    };
    let bundled_error = match bundled()
        .map_err(|error| error.to_string())
        .and_then(|data| parse(&data, NativeSource::Bundled, "bundled catalog is empty"))
    {
        Ok(native) => return Ok(native),
        Err(error) => error,
    };
    Err(crate::t!(
        "models.catalog.readNativeFailed",
        cacheError = cache_error,
        bundledError = bundled_error
    ))
}

/// 合并目录里的一项：官方条目写原文（只换排序值），第三方条目正常序列化
#[derive(Serialize)]
#[serde(untagged)]
enum CombinedEntry<'a> {
    Native(&'a RawValue),
    Reordered(Box<RawValue>),
    Own(Value),
}

/// 合并目录里排在第几的一项（Codex 的「已选」顺序，spec #247「各 agent 的写入」）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    /// 官方模型：它的 slug
    Native(String),
    /// 第三方模型
    Own(Published),
}

/// 官方目录里一项的头几个字段
#[derive(Deserialize)]
struct NativeHead {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    base_instructions: Option<String>,
}

fn native_head(raw: &RawValue) -> Result<NativeHead, String> {
    serde_json::from_str(raw.get()).map_err(|error| format!("parse native entry: {error}"))
}

/// 在模型菜单里列出的官方条目（`visibility` 为 `list`）：（slug, 显示名），按目录顺序。
/// 只有它们参与「已选」；隐藏的条目原样留在目录里
pub fn listed_natives(native: &[Box<RawValue>]) -> Vec<(String, String)> {
    native
        .iter()
        .filter_map(|raw| native_head(raw).ok())
        .filter(|head| head.visibility.as_deref() == Some("list"))
        .filter_map(|head| {
            let slug = head.slug?.trim().to_owned();
            let name = head
                .display_name
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| slug.clone());
            (!slug.is_empty()).then_some((slug, name))
        })
        .collect()
}

/// 把官方条目原文里的 `priority` 原位换成 `priority`（没有就补在末尾），别的字节不动
fn with_priority(raw: &RawValue, priority: i64) -> Result<Box<RawValue>, String> {
    let bytes = raw.get().as_bytes();
    let value = priority.to_string();
    let edited = match crate::jsonedit::replace(bytes, &["priority"], value.as_bytes()) {
        Ok(edited) => edited,
        Err(_) => crate::jsonedit::insert(
            bytes,
            &[],
            &[("priority", value.as_bytes())],
            crate::jsonedit::Layout::Compact,
        )
        .map_err(|error| format!("set native priority: {error}"))?,
    };
    let text = String::from_utf8(edited).map_err(|error| error.to_string())?;
    RawValue::from_string(text).map_err(|error| error.to_string())
}

/// 生成合并目录：按 `order`（「已选」顺序）排，排序值依次是 1、2、3……；官方条目只换排序值、其余原样，
/// 列出的官方条目不在 `order` 里（被取消的）不写进目录；隐藏的官方条目原样在前。
/// `include_native` 为假（独立服务商接法，spec 2026-10-03-codex-hookup-auto R6）：官方条目只提供
/// `base_instructions`，不写进目录——没登录时官方模型发不出去
pub fn build_combined(
    native: &[Box<RawValue>],
    order: &[Slot],
    include_native: bool,
) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    struct Doc<'a> {
        models: Vec<CombinedEntry<'a>>,
    }
    let mut heads = Vec::with_capacity(native.len());
    let mut base_instructions: Option<String> = None;
    for raw in native {
        let head = native_head(raw)?;
        if base_instructions.is_none() {
            base_instructions = head
                .base_instructions
                .clone()
                .filter(|value| !value.trim().is_empty());
        }
        heads.push(head);
    }
    let base_instructions =
        base_instructions.unwrap_or_else(|| FALLBACK_BASE_INSTRUCTIONS.to_string());
    let slug_of = |head: &NativeHead| head.slug.as_deref().unwrap_or("").trim().to_lowercase();

    let mut seen = BTreeSet::new();
    let mut entries: Vec<CombinedEntry> = Vec::new();
    if include_native {
        for (raw, head) in native.iter().zip(&heads) {
            // 官方条目的标识挡着第三方：被取消的也挡（免得它回来时撞上）
            seen.insert(slug_of(head));
            if head.visibility.as_deref() != Some("list") {
                entries.push(CombinedEntry::Native(raw));
            }
        }
    }
    for (index, slot) in order.iter().enumerate() {
        let priority = index as i64 + 1;
        match slot {
            Slot::Native(slug) => {
                if !include_native {
                    continue;
                }
                let wanted = slug.trim().to_lowercase();
                let found = native.iter().zip(&heads).find(|(_, head)| {
                    head.visibility.as_deref() == Some("list") && slug_of(head) == wanted
                });
                if let Some((raw, _)) = found {
                    entries.push(CombinedEntry::Reordered(with_priority(raw, priority)?));
                }
            }
            Slot::Own(published) => {
                let slug = published.slug.trim().to_lowercase();
                if slug.is_empty() {
                    return Err(crate::t!(
                        "models.catalog.slugEmpty",
                        model = format!("{:?}", published.model.id)
                    ));
                }
                if !seen.insert(slug.clone()) {
                    return Err(crate::t!(
                        "models.catalog.slugDuplicate",
                        slug = format!("{slug:?}")
                    ));
                }
                entries.push(CombinedEntry::Own(entry(
                    &published.model,
                    slug,
                    priority,
                    &base_instructions,
                )));
            }
        }
    }
    serde_json::to_vec_pretty(&Doc { models: entries }).map_err(|error| error.to_string())
}

/// 生成路由清单：`models` 是当前所选的第三方模型，`providers` 是它们的上游；`retired` 是曾经出现在 Codex 选择器里、
/// 现已取消的模型标识。Codex 的模型目录只在启动时加载，运行中的 Codex 仍可能请求已取消的模型，
/// 路由据停用名单拒绝它们，而不是当成官方模型放行。
pub fn build_routing(
    models: &[Published],
    providers: &[RoutingProvider],
    retired: &[String],
) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    struct Route {
        slug: String,
        upstream_model: String,
        provider: String,
    }
    #[derive(Serialize)]
    struct Doc<'a> {
        providers: Vec<&'a RoutingProvider>,
        models: Vec<Route>,
        retired: Vec<String>,
    }
    let mut active = BTreeSet::new();
    let mut used = BTreeSet::new();
    let mut list = Vec::with_capacity(models.len());
    for published in models {
        let slug = published.slug.trim().to_lowercase();
        if slug.is_empty() {
            return Err(crate::t!(
                "models.catalog.slugEmpty",
                model = format!("{:?}", published.model.id)
            ));
        }
        if !providers.iter().any(|p| p.id == published.provider) {
            // 清单里有模型却没有它的上游，路由只能拒绝请求；在生成时就拦下
            return Err(crate::t!(
                "models.catalog.providerMissing",
                model = format!("{:?}", published.model.id),
                provider = format!("{:?}", published.provider)
            ));
        }
        active.insert(slug.clone());
        used.insert(published.provider.as_str());
        list.push(Route {
            slug,
            upstream_model: published.model.id.trim().to_string(),
            provider: published.provider.clone(),
        });
    }
    let retired = retired
        .iter()
        .map(|slug| slug.trim())
        // insert 返回 false 即仍在用或已列过：顺带去重
        .filter(|slug| !slug.is_empty() && active.insert(slug.to_string()))
        .map(str::to_string)
        .collect();
    serde_json::to_vec_pretty(&Doc {
        // 只写出确有模型在用的上游：没勾选任何模型的网关地址不必落到 Codex 目录下
        providers: providers
            .iter()
            .filter(|p| used.contains(p.id.as_str()))
            .collect(),
        models: list,
        retired,
    })
    .map_err(|error| error.to_string())
}

/// 第三方条目。字段集合与 Go 版 `entry` 逐项一致，改动前先对照上游。
fn entry(model: &Model, slug: String, priority: i64, base_instructions: &str) -> Value {
    let display_name = match model.display_name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => name,
        _ => model.id.trim(),
    };
    // `context_window` 封顶（Codex 据它决定何时压缩）；`max_context_window` 报真实窗口：
    // 用户在 config.toml 里自己写了更大的 `model_context_window` 时，Codex 以它为上限截断，封了就改不回去（Codex 复审）
    let real_window = match model.context_window {
        Some(window) if window > 0 => window,
        _ => DEFAULT_CONTEXT_WINDOW,
    };
    let context_window = real_window.min(WORKING_WINDOW);
    let modalities: &[&str] = if model.vision {
        &["text", "image"]
    } else {
        &["text"]
    };
    json!({
        "slug": slug,
        "display_name": display_name,
        "description": OWN_DESCRIPTION,
        "default_reasoning_level": "medium",
        "supported_reasoning_levels": [
            {"effort": "low", "description": "Fast responses with lighter thinking"},
            {"effort": "medium", "description": "Balanced speed and thinking"},
            {"effort": "high", "description": "Deeper thinking for harder tasks"}
        ],
        "shell_type": "unified_exec",
        "visibility": "list",
        "supported_in_api": true,
        "priority": priority,
        "additional_speed_tiers": [],
        "service_tiers": [],
        "default_service_tier": null,
        "availability_nux": null,
        "upgrade": null,
        "base_instructions": base_instructions,
        "model_messages": null,
        "include_skills_usage_instructions": true,
        "include_plugin_usage_instructions": true,
        "include_apps_usage_instructions": true,
        "supports_reasoning_summary_parameter": false,
        "supports_reasoning_summaries": false,
        "default_reasoning_summary": "auto",
        "support_verbosity": false,
        "default_verbosity": null,
        "apply_patch_tool_type": null,
        "web_search_tool_type": "text",
        "truncation_policy": {"mode": "tokens", "limit": 10_000},
        "supports_parallel_tool_calls": true,
        "supports_image_detail_original": false,
        "context_window": context_window,
        "max_context_window": real_window,
        "auto_compact_token_limit": null,
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": modalities,
        // 保守起见先不向第三方网关声明搜索工具；待 wecode 契约探测后再定。
        "supports_search_tool": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use serde_json::{json, Value};
    use std::cell::Cell;

    const NATIVE_JSON: &str = r#"{"fetched_at":"2026-09-20T03:26:31Z","client_version":"0.154.0","models":[
 {"slug":"gpt-6-astra","display_name":"GPT-6 Astra","priority":1,"visibility":"list","supported_in_api":true,"base_instructions":"You are Codex.","unknown_future_field":{"a":[1,2]}},
 {"slug":"gpt-reserve","display_name":"Reserve","priority":7,"visibility":"hide","supported_in_api":false,"base_instructions":""}
]}"#;

    /// 测试里统一挂在一家叫 "p" 的网关下，标识不带前缀，沿用原有用例的期望值
    fn model(id: &str) -> Published {
        Published {
            slug: slug_for(id),
            provider: "p".into(),
            model: Model {
                id: id.into(),
                display_name: None,
                context_window: None,
                vision: false,
                manual: false,
            },
        }
    }

    fn with(mut published: Published, edit: impl FnOnce(&mut Model)) -> Published {
        edit(&mut published.model);
        published
    }

    /// 只有第三方模型、按给的顺序
    fn own(models: Vec<Published>) -> Vec<Slot> {
        models.into_iter().map(Slot::Own).collect()
    }

    fn upstream(id: &str) -> RoutingProvider {
        RoutingProvider {
            id: id.into(),
            base_url: format!("https://{id}.example/v1"),
            protocol: "chat".into(),
        }
    }

    fn decode(data: &[u8]) -> Vec<Value> {
        let doc: Value = serde_json::from_slice(data).expect("json");
        doc["models"].as_array().expect("models").clone()
    }

    #[test]
    fn slug_for_matches_go_cases() {
        for (id, want) in [
            ("weibo/glm-5", "weibo-glm-5"),
            ("  Kimi K3 ", "kimi-k3"),
            ("qwen3.8-max", "qwen3.8-max"),
            ("a//b__c", "a-b__c"),
            ("moonshot:kimi@k2", "moonshot-kimi-k2"),
            ("Doubao-Seed-1.6", "doubao-seed-1.6"),
            ("--x--", "x"),
            ("///", ""),
        ] {
            assert_eq!(slug_for(id), want, "slug_for({id:?})");
        }
    }

    /// 路由的键：大小写、空白、零宽字符的变体是同一个；汉字等非 ASCII 的字母留着（走查 2026-10-08 第 7 条：
    /// 「fake-a · QA 全开」「fake-a · QA 撞名」原来都成了 `fake-aqa`，WorkBuddy 的第二条只好退回内部标识）
    #[test]
    fn routing_key_folds_case_and_invisible_chars_but_keeps_letters() {
        assert_eq!(routing_key(" Weibo-GLM-5\u{200b} "), "weibo-glm-5");
        assert_eq!(routing_key("fake-a · QA 全开"), "fake-aqa全开");
        assert_ne!(
            routing_key("fake-a · QA 全开"),
            routing_key("fake-a · QA 撞名")
        );
        assert_eq!(
            routing_key("FAKE-A · QA  撞名"),
            routing_key("fake-a · qa 撞名")
        );
    }

    /// AC1（#259 起按「已选」排）：官方与第三方按「已选」顺序穿插，排序值依次 1、2、3……；官方条目只换排序值、
    /// 别的字节原样（含不认识的字段）；被取消的官方条目不写进目录，隐藏的官方条目原样留着
    #[test]
    fn ac1_combined_catalog_follows_the_pick_order_and_only_renumbers_native_entries() {
        let (native, version) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        assert_eq!(version, "0.154.0");
        let order = vec![
            Slot::Own(with(model("weibo/glm-5"), |m| {
                m.display_name = Some("Weibo GLM-5".into())
            })),
            Slot::Native("gpt-6-astra".into()),
            Slot::Own(model("kimi-k3")),
        ];
        let data = build_combined(&native, &order, true).expect("build_combined");
        let models = decode(&data);
        let slugs: Vec<&str> = models.iter().map(|m| m["slug"].as_str().unwrap()).collect();
        assert_eq!(
            slugs,
            ["gpt-reserve", "weibo-glm-5", "gpt-6-astra", "kimi-k3"]
        );
        let priorities: Vec<i64> = models
            .iter()
            .map(|m| m["priority"].as_i64().unwrap())
            .collect();
        assert_eq!(priorities, [7, 1, 2, 3]);

        let text = String::from_utf8(data).expect("utf8");
        assert!(text.contains(
            r#"{"slug":"gpt-6-astra","display_name":"GPT-6 Astra","priority":2,"visibility":"list","supported_in_api":true,"base_instructions":"You are Codex.","unknown_future_field":{"a":[1,2]}}"#
        ));
        assert_eq!(models[1]["display_name"], "Weibo GLM-5");
        assert_eq!(
            models[3]["display_name"], "kimi-k3",
            "显示名缺省回退到模型名"
        );
        assert_eq!(models[3]["base_instructions"], "You are Codex.");

        // 官方模型都取消了：列出的那一条不写，隐藏的照旧
        let only_own = build_combined(&native, &[Slot::Own(model("kimi-k3"))], true).unwrap();
        let slugs: Vec<String> = decode(&only_own)
            .iter()
            .map(|m| m["slug"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(slugs, ["gpt-reserve", "kimi-k3"]);
    }

    /// 菜单里列出的官方模型（参与「已选」）：只认 `visibility: list`，带显示名
    #[test]
    fn listed_natives_are_the_ones_shown_in_the_menu() {
        let (native, _) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        assert_eq!(
            listed_natives(&native),
            [("gpt-6-astra".to_owned(), "GPT-6 Astra".to_owned())]
        );
    }

    /// 第三方条目的字段集合与 Go 版 `entry` 完全一致
    #[test]
    fn own_entry_field_set_matches_go() {
        let data = build_combined(
            &[],
            &own(vec![with(model(" weibo/glm-5 "), |m| {
                m.display_name = Some("  ".into());
                m.context_window = Some(200_000);
                m.vision = true;
            })]),
            true,
        )
        .expect("build_combined");
        let models = decode(&data);
        assert_eq!(
            models[0],
            json!({
                "slug": "weibo-glm-5",
                "display_name": "weibo/glm-5",
                "description": "Sophia third-party model",
                "default_reasoning_level": "medium",
                "supported_reasoning_levels": [
                    {"effort": "low", "description": "Fast responses with lighter thinking"},
                    {"effort": "medium", "description": "Balanced speed and thinking"},
                    {"effort": "high", "description": "Deeper thinking for harder tasks"}
                ],
                "shell_type": "unified_exec",
                "visibility": "list",
                "supported_in_api": true,
                "priority": 1,
                "additional_speed_tiers": [],
                "service_tiers": [],
                "default_service_tier": null,
                "availability_nux": null,
                "upgrade": null,
                "base_instructions": "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
                "model_messages": null,
                "include_skills_usage_instructions": true,
                "include_plugin_usage_instructions": true,
                "include_apps_usage_instructions": true,
                "supports_reasoning_summary_parameter": false,
                "supports_reasoning_summaries": false,
                "default_reasoning_summary": "auto",
                "support_verbosity": false,
                "default_verbosity": null,
                "apply_patch_tool_type": null,
                "web_search_tool_type": "text",
                "truncation_policy": {"mode": "tokens", "limit": 10000},
                "supports_parallel_tool_calls": true,
                "supports_image_detail_original": false,
                "context_window": 200000,
                "max_context_window": 200000,
                "auto_compact_token_limit": null,
                "effective_context_window_percent": 95,
                "experimental_supported_tools": [],
                "input_modalities": ["text", "image"],
                "supports_search_tool": false
            })
        );
        assert_eq!(models[0].as_object().expect("object").len(), 36);
    }

    /// AC1：报 100 万的模型，目录里只写 272K；报得更小的照报
    #[test]
    fn own_entry_caps_the_context_window_at_the_working_window() {
        let data = build_combined(
            &[],
            &own(vec![
                with(model("deepseek-v4-pro"), |m| {
                    m.context_window = Some(1_000_000)
                }),
                with(model("kimi-k3"), |m| m.context_window = Some(200_000)),
            ]),
            true,
        )
        .expect("build_combined");
        let entries = decode(&data);
        assert_eq!(entries[0]["context_window"], 272_000);
        assert_eq!(entries[0]["max_context_window"], 1_000_000);
        assert_eq!(entries[1]["context_window"], 200_000);
        assert_eq!(entries[1]["max_context_window"], 200_000);
        // 临界：恰好 272K 不动，多 1 就封
        let edge = build_combined(
            &[],
            &own(vec![
                with(model("a"), |m| m.context_window = Some(272_000)),
                with(model("b"), |m| m.context_window = Some(272_001)),
            ]),
            true,
        )
        .expect("build_combined");
        let edge = decode(&edge);
        assert_eq!(edge[0]["context_window"], 272_000);
        assert_eq!(edge[1]["context_window"], 272_000);
        assert_eq!(edge[1]["max_context_window"], 272_001);
    }

    #[test]
    fn own_entry_defaults_context_window_and_text_only() {
        let data = build_combined(
            &[],
            &own(vec![with(model("kimi-k3"), |m| m.context_window = Some(0))]),
            true,
        )
        .expect("build_combined");
        let entry = &decode(&data)[0];
        assert_eq!(entry["context_window"], 128_000);
        assert_eq!(entry["max_context_window"], 128_000);
        assert_eq!(entry["input_modalities"], json!(["text"]));
    }

    /// R6、AC9：独立服务商接法的目录只有第三方模型；官方条目仍提供说明文字与排序基数，
    /// 官方的标识也不再挡第三方（目录里根本没有官方条目）
    #[test]
    fn provider_form_catalog_lists_only_third_party_models() {
        let (native, _) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        let data = build_combined(
            &native,
            &own(vec![model("weibo/glm-5"), model("kimi-k3")]),
            false,
        )
        .expect("build_combined");
        let models = decode(&data);
        let slugs: Vec<&str> = models.iter().map(|m| m["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["weibo-glm-5", "kimi-k3"]);
        assert_eq!(models[0]["base_instructions"], "You are Codex.");
        assert_eq!(models[1]["priority"], 2);
        assert!(build_combined(&native, &own(vec![model("gpt-6-astra")]), false).is_ok());
    }

    /// 第三方与官方重名时，官方条目保留，第三方那条被拒绝，避免官方模型被内网路由劫持。
    #[test]
    fn third_party_slug_colliding_with_native_is_rejected() {
        let (native, _) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        let error =
            build_combined(&native, &own(vec![model("gpt-6-astra")]), true).expect_err("collision");
        assert!(error.contains("gpt-6-astra"), "{error}");
        // 官方 slug 大小写、首尾空白不同也算重名
        let native = parse_native(br#"{"models":[{"slug":" GPT-6-Astra "}]}"#)
            .expect("parse_native")
            .0;
        assert!(build_combined(&native, &own(vec![model("gpt-6-astra")]), true).is_err());
    }

    #[test]
    fn duplicate_third_party_slug_is_rejected() {
        let (native, _) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        assert!(build_combined(&native, &own(vec![model("a/b"), model("a-b")]), true).is_err());
    }

    #[test]
    fn model_without_usable_slug_is_rejected() {
        assert!(build_combined(&[], &own(vec![model("///")]), true).is_err());
        assert!(build_routing(&[model("///")], &[upstream("p")], &[]).is_err());
    }

    #[test]
    fn routing_catalog_lists_only_third_party() {
        let data = build_routing(
            &[model("weibo/glm-5"), model(" kimi-k3 ")],
            // 没有模型在用的那一家（unused）不写进清单
            &[upstream("p"), upstream("unused")],
            &[
                "old-model".into(),
                "kimi-k3".into(),
                " old-model ".into(),
                "".into(),
            ],
        )
        .expect("build_routing");
        let doc: Value = serde_json::from_slice(&data).expect("json");
        assert_eq!(
            doc,
            json!({
                "providers": [
                    {"id": "p", "base_url": "https://p.example/v1", "protocol": "chat"}
                ],
                "models": [
                    {"slug": "weibo-glm-5", "upstream_model": "weibo/glm-5", "provider": "p"},
                    {"slug": "kimi-k3", "upstream_model": "kimi-k3", "provider": "p"}
                ],
                // 停用名单：曾经出现在选择器里、现在已取消的模型；仍在用的不算停用，且去重
                "retired": ["old-model"]
            })
        );
    }

    #[test]
    fn routing_catalog_emits_empty_arrays_not_null() {
        let doc: Value = serde_json::from_slice(
            &build_routing(&[], &[upstream("p")], &[]).expect("build_routing"),
        )
        .expect("json");
        assert_eq!(doc, json!({"providers": [], "models": [], "retired": []}));
    }

    /// 两家各出一个模型：每条路由带归属，两家上游都写进清单
    #[test]
    fn routing_catalog_records_which_provider_serves_each_model() {
        let mut second = model("deepseek/v4");
        second.provider = "other".into();
        second.slug = "other-deepseek-v4".into();
        let data = build_routing(
            &[model("deepseek/v4"), second],
            &[upstream("p"), upstream("other")],
            &[],
        )
        .expect("build_routing");
        let doc: Value = serde_json::from_slice(&data).expect("json");
        assert_eq!(doc["models"][0]["provider"], "p");
        assert_eq!(doc["models"][1]["provider"], "other");
        assert_eq!(doc["models"][1]["slug"], "other-deepseek-v4");
        assert_eq!(doc["providers"][1]["base_url"], "https://other.example/v1");
    }

    /// 清单里有模型却没有它的上游，路由只能拒绝请求：生成时就拦下
    #[test]
    fn routing_catalog_rejects_a_model_whose_provider_is_missing() {
        let error = build_routing(&[model("a")], &[upstream("someone-else")], &[])
            .expect_err("missing provider");
        assert!(error.contains("不存在"), "{error}");
    }

    /// 标识由调用方给定：同一个模型名、不同前缀，可以同时写进合并目录
    #[test]
    fn combined_catalog_accepts_the_same_model_under_two_prefixes() {
        let mut second = model("deepseek/v4");
        second.slug = "other-deepseek-v4".into();
        let data = build_combined(&[], &own(vec![model("deepseek/v4"), second]), true)
            .expect("build_combined");
        let slugs: Vec<String> = decode(&data)
            .iter()
            .map(|entry| entry["slug"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(slugs, ["deepseek-v4", "other-deepseek-v4"]);
    }

    /// 官方目录来源：先读 Codex 的模型缓存，读不到再退回内置目录；从不读取登录凭据。
    #[test]
    fn load_native_prefers_cache_then_bundled() {
        let tree = TempTree::new();
        let home = tree.dir("codex");
        let calls = Cell::new(0);
        let bundled = || {
            calls.set(calls.get() + 1);
            Ok(br#"{"models":[{"slug":"bundled-only","base_instructions":"x"}]}"#.to_vec())
        };

        let native = load_native(&home, bundled).expect("no cache");
        assert_eq!(native.source, NativeSource::Bundled);
        assert_eq!(native.models.len(), 1);
        assert_eq!(calls.get(), 1);

        std::fs::write(home.join("models_cache.json"), NATIVE_JSON).expect("write");
        let native = load_native(&home, bundled).expect("with cache");
        assert_eq!(native.source, NativeSource::Cache);
        assert_eq!(native.models.len(), 2);
        assert_eq!(native.client_version, "0.154.0");
        assert_eq!(calls.get(), 1, "缓存可用时不得调用内置目录");

        std::fs::write(home.join("models_cache.json"), r#"{"models":[]}"#).expect("write");
        let native = load_native(&home, bundled).expect("empty cache falls back");
        assert_eq!(native.source, NativeSource::Bundled);

        let empty = tree.dir("empty");
        let error = load_native(&empty, || Err(std::io::Error::other("no codex")))
            .expect_err("both sources fail");
        assert!(error.contains("no codex"), "{error}");
    }

    #[test]
    fn load_native_never_reads_auth_json() {
        let tree = TempTree::new();
        let home = tree.dir("codex");
        // auth.json 里放一份"看起来能用"的目录：只要实现读了它，这里就会成功
        std::fs::write(
            home.join("auth.json"),
            r#"{"models":[{"slug":"from-auth"}]}"#,
        )
        .expect("write");
        assert!(load_native(&home, || Err(std::io::Error::other("no codex"))).is_err());
    }

    /// 缓存里混进了本工具自己的条目时要剔除，否则重新生成会把第三方条目当成官方条目。
    #[test]
    fn load_native_drops_own_entries() {
        let (native, _) = parse_native(
            br#"{"models":[{"slug":"gpt-6-astra"},{"slug":"weibo-glm-5","description":"Sophia third-party model"},{"slug":"kimi-k3","description":"agents-manager third-party model"},{"slug":"other","description":null}]}"#,
        )
        .expect("parse_native");
        let slugs: Vec<&str> = native.iter().map(|raw| raw.get()).collect();
        assert_eq!(
            slugs,
            [
                r#"{"slug":"gpt-6-astra"}"#,
                r#"{"slug":"other","description":null}"#
            ]
        );
    }

    #[test]
    fn parse_native_rejects_entry_without_slug() {
        assert!(parse_native(br#"{"models":[{"display_name":"x"}]}"#).is_err());
        assert!(parse_native(br#"{"models":[{"slug":"  "}]}"#).is_err());
        assert!(parse_native(br#"{"models":["not an object"]}"#).is_err());
        assert!(parse_native(b"{oops").is_err());
    }

    #[test]
    fn model_serializes_camel_case() {
        let value = serde_json::to_value(Model {
            id: "weibo/glm-5".into(),
            display_name: Some("GLM".into()),
            context_window: Some(1),
            vision: true,
            manual: false,
        })
        .expect("json");
        assert_eq!(
            value,
            json!({"id": "weibo/glm-5", "displayName": "GLM", "contextWindow": 1, "vision": true})
        );
        let parsed: Model = serde_json::from_str(r#"{"id":"x"}"#).expect("json");
        assert_eq!(parsed, model("x").model);
    }
}

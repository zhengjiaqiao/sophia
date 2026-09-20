//! Codex 模型选择器读取的合并目录（官方条目 + 第三方条目）与路由用的第三方清单。
//!
//! 移植自 agents-manager 的 `internal/catalog`（同一作者的 Go 项目）。第三方条目的字段集合取自
//! github.com/ollama/ollama `cmd/launch/codex_app.go` 的 `codexAppCatalogEntry`（MIT，提交 6383a0f）。
//! 官方条目以原始 JSON 文本保存并原样写回：本 crate 的 serde_json 没开 `preserve_order`，
//! 经 `Value` 转一圈会打乱键顺序，所以用 `RawValue`。
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io;
use std::path::Path;

/// 标记本功能生成的条目，重新生成时据此识别并剔除。
pub const OWN_DESCRIPTION: &str = "symsync third-party model";
/// 前身 agents-manager 写下的标记；解析官方目录时同样当作自己的条目剔除。
const LEGACY_OWN_DESCRIPTION: &str = "agents-manager third-party model";

const FALLBACK_BASE_INSTRUCTIONS: &str = "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.";
const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;

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
}

impl Model {
    pub fn slug(&self) -> String {
        slug_for(&self.id)
    }
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
    Err(format!(
        "读取官方模型目录失败: {cache_error}\n{bundled_error}"
    ))
}

/// 合并目录里的一项：官方条目写原文，第三方条目正常序列化
#[derive(Serialize)]
#[serde(untagged)]
enum CombinedEntry<'a> {
    Native(&'a RawValue),
    Own(Value),
}

/// 生成合并目录：官方条目原样在前，第三方条目按选择顺序排在其后。
pub fn build_combined(native: &[Box<RawValue>], models: &[Model]) -> Result<Vec<u8>, String> {
    #[derive(Deserialize)]
    struct Head {
        #[serde(default)]
        slug: Option<String>,
        #[serde(default)]
        priority: Option<f64>,
        #[serde(default)]
        base_instructions: Option<String>,
    }
    #[derive(Serialize)]
    struct Doc<'a> {
        models: Vec<CombinedEntry<'a>>,
    }
    let mut seen = BTreeSet::new();
    let mut max_priority = 0.0_f64;
    let mut base_instructions: Option<String> = None;
    for raw in native {
        let head: Head = serde_json::from_str(raw.get())
            .map_err(|error| format!("parse native entry: {error}"))?;
        seen.insert(head.slug.unwrap_or_default().trim().to_lowercase());
        max_priority = max_priority.max(head.priority.unwrap_or(0.0));
        if base_instructions.is_none() {
            base_instructions = head
                .base_instructions
                .filter(|value| !value.trim().is_empty());
        }
    }
    let base_instructions =
        base_instructions.unwrap_or_else(|| FALLBACK_BASE_INSTRUCTIONS.to_string());

    let mut entries: Vec<CombinedEntry> = native
        .iter()
        .map(|raw| CombinedEntry::Native(raw))
        .collect();
    for (index, model) in models.iter().enumerate() {
        let slug = model.slug();
        if slug.is_empty() {
            return Err(format!("模型名 {:?} 无法生成标识", model.id));
        }
        if !seen.insert(slug.clone()) {
            return Err(format!(
                "模型标识 {slug:?} 与已有模型重名（官方模型或另一个所选模型），已拒绝"
            ));
        }
        let priority = max_priority as i64 + 1 + index as i64;
        entries.push(CombinedEntry::Own(entry(
            model,
            slug,
            priority,
            &base_instructions,
        )));
    }
    serde_json::to_vec_pretty(&Doc { models: entries }).map_err(|error| error.to_string())
}

/// 生成路由清单：`models` 是当前所选的第三方模型；`retired` 是曾经出现在 Codex 选择器里、
/// 现已取消的模型标识。Codex 的模型目录只在启动时加载，运行中的 Codex 仍可能请求已取消的模型，
/// 路由据停用名单拒绝它们，而不是当成官方模型放行。
pub fn build_routing(models: &[Model], retired: &[String]) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    struct Route {
        slug: String,
        upstream_model: String,
    }
    #[derive(Serialize)]
    struct Doc {
        models: Vec<Route>,
        retired: Vec<String>,
    }
    let mut active = BTreeSet::new();
    let mut list = Vec::with_capacity(models.len());
    for model in models {
        let slug = model.slug();
        if slug.is_empty() {
            return Err(format!("模型名 {:?} 无法生成标识", model.id));
        }
        active.insert(slug.clone());
        list.push(Route {
            slug,
            upstream_model: model.id.trim().to_string(),
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
    let context_window = match model.context_window {
        Some(window) if window > 0 => window,
        _ => DEFAULT_CONTEXT_WINDOW,
    };
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
        "max_context_window": context_window,
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

    fn model(id: &str) -> Model {
        Model {
            id: id.into(),
            display_name: None,
            context_window: None,
            vision: false,
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

    /// AC1：合并目录同时含全部官方条目（原样）和所选第三方条目，第三方排在官方之后，名称可读。
    #[test]
    fn ac1_combined_catalog_keeps_native_verbatim_and_appends_third_party() {
        let (native, version) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        assert_eq!(version, "0.154.0");
        let data = build_combined(
            &native,
            &[
                Model {
                    display_name: Some("Weibo GLM-5".into()),
                    ..model("weibo/glm-5")
                },
                model("kimi-k3"),
            ],
        )
        .expect("build_combined");
        let models = decode(&data);
        assert_eq!(models.len(), 4);

        // 官方条目逐字段保留，包括本工具不认识的字段
        let want: Value = serde_json::from_str(NATIVE_JSON).expect("json");
        for (index, want) in want["models"]
            .as_array()
            .expect("models")
            .iter()
            .enumerate()
        {
            assert_eq!(&models[index], want, "native entry {index} changed");
        }
        // 不只是语义相等：官方条目的原始文本逐字出现在输出里（键顺序、未知字段都不动）
        let text = String::from_utf8(data).expect("utf8");
        assert!(text.contains(
            r#"{"slug":"gpt-6-astra","display_name":"GPT-6 Astra","priority":1,"visibility":"list","supported_in_api":true,"base_instructions":"You are Codex.","unknown_future_field":{"a":[1,2]}}"#
        ));

        let (glm, kimi) = (&models[2], &models[3]);
        assert_eq!(glm["slug"], "weibo-glm-5");
        assert_eq!(glm["display_name"], "Weibo GLM-5");
        assert_eq!(kimi["display_name"], "kimi-k3", "显示名缺省回退到模型名");
        for entry in [glm, kimi] {
            assert_eq!(entry["visibility"], "list");
            assert_eq!(entry["supported_in_api"], true);
            assert!(entry["priority"].as_i64().expect("priority") > 7);
            assert_eq!(entry["base_instructions"], "You are Codex.");
        }
        assert!(glm["priority"].as_i64() < kimi["priority"].as_i64());
        assert_eq!(glm["priority"], 8);
        assert_eq!(kimi["priority"], 9);
    }

    /// 第三方条目的字段集合与 Go 版 `entry` 完全一致
    #[test]
    fn own_entry_field_set_matches_go() {
        let data = build_combined(
            &[],
            &[Model {
                id: " weibo/glm-5 ".into(),
                display_name: Some("  ".into()),
                context_window: Some(200_000),
                vision: true,
            }],
        )
        .expect("build_combined");
        let models = decode(&data);
        assert_eq!(
            models[0],
            json!({
                "slug": "weibo-glm-5",
                "display_name": "weibo/glm-5",
                "description": "symsync third-party model",
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

    #[test]
    fn own_entry_defaults_context_window_and_text_only() {
        let data = build_combined(
            &[],
            &[Model {
                context_window: Some(0),
                ..model("kimi-k3")
            }],
        )
        .expect("build_combined");
        let entry = &decode(&data)[0];
        assert_eq!(entry["context_window"], 128_000);
        assert_eq!(entry["max_context_window"], 128_000);
        assert_eq!(entry["input_modalities"], json!(["text"]));
    }

    /// 第三方与官方重名时，官方条目保留，第三方那条被拒绝，避免官方模型被内网路由劫持。
    #[test]
    fn third_party_slug_colliding_with_native_is_rejected() {
        let (native, _) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        let error = build_combined(&native, &[model("gpt-6-astra")]).expect_err("collision");
        assert!(error.contains("gpt-6-astra"), "{error}");
        // 官方 slug 大小写、首尾空白不同也算重名
        let native = parse_native(br#"{"models":[{"slug":" GPT-6-Astra "}]}"#)
            .expect("parse_native")
            .0;
        assert!(build_combined(&native, &[model("gpt-6-astra")]).is_err());
    }

    #[test]
    fn duplicate_third_party_slug_is_rejected() {
        let (native, _) = parse_native(NATIVE_JSON.as_bytes()).expect("parse_native");
        assert!(build_combined(&native, &[model("a/b"), model("a-b")]).is_err());
    }

    #[test]
    fn model_without_usable_slug_is_rejected() {
        assert!(build_combined(&[], &[model("///")]).is_err());
        assert!(build_routing(&[model("///")], &[]).is_err());
    }

    #[test]
    fn routing_catalog_lists_only_third_party() {
        let data = build_routing(
            &[model("weibo/glm-5"), model(" kimi-k3 ")],
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
                "models": [
                    {"slug": "weibo-glm-5", "upstream_model": "weibo/glm-5"},
                    {"slug": "kimi-k3", "upstream_model": "kimi-k3"}
                ],
                // 停用名单：曾经出现在选择器里、现在已取消的模型；仍在用的不算停用，且去重
                "retired": ["old-model"]
            })
        );
    }

    #[test]
    fn routing_catalog_emits_empty_arrays_not_null() {
        let doc: Value =
            serde_json::from_slice(&build_routing(&[], &[]).expect("build_routing")).expect("json");
        assert_eq!(doc, json!({"models": [], "retired": []}));
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
            br#"{"models":[{"slug":"gpt-6-astra"},{"slug":"weibo-glm-5","description":"symsync third-party model"},{"slug":"kimi-k3","description":"agents-manager third-party model"},{"slug":"other","description":null}]}"#,
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
        })
        .expect("json");
        assert_eq!(
            value,
            json!({"id": "weibo/glm-5", "displayName": "GLM", "contextWindow": 1, "vision": true})
        );
        let parsed: Model = serde_json::from_str(r#"{"id":"x"}"#).expect("json");
        assert_eq!(parsed, model("x"));
    }
}

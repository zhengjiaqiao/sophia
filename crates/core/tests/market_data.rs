//! 随包市场数据（`data/market/*.json`）的形状与不变量：热门快照（spec R5）与 MCP 精选（R7）。
//! 解析走 core 的公共类型，格式一错这里就红，不会在运行时静默变成空列表。

use serde::Deserialize;
use sophia_core::market::{
    curated_mcp, popular_snapshot, LocalText, McpCatalogEntry, McpFieldKind, McpTransport,
    SkillListing,
};
use std::collections::{BTreeMap, BTreeSet};

const POPULAR_JSON: &str = include_str!("../data/market/skills-popular.json");
const CURATED_JSON: &str = include_str!("../data/market/mcp-curated.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PopularFile {
    source: String,
    generated_at: Option<String>,
    skills: Vec<SkillListing>,
}

#[derive(Deserialize)]
struct CuratedFile {
    attribution: String,
    servers: Vec<McpCatalogEntry>,
}

/// 精选文件里 core 类型之外的标记：远程服务器首次使用时在浏览器里登录
#[derive(Deserialize)]
struct RawCurated {
    servers: Vec<RawServer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawServer {
    name: String,
    #[serde(default)]
    sign_in: bool,
}

fn is_slug(s: &str) -> bool {
    let mut parts = s.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// 精选里按界面语言写的字（#305）：三种语言都写了、都不空，没有别的语言
fn all_languages(text: &LocalText) -> bool {
    match text {
        LocalText::Plain(_) => false,
        LocalText::ByLang(map) => {
            map.keys()
                .map(String::as_str)
                .eq(["en", "zh-Hans", "zh-Hant"])
                && map.values().all(|v| !v.trim().is_empty())
        }
    }
}

/// 一段文字里所有 `${KEY}` 的 KEY
fn placeholders(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let end = after.find('}').expect("占位没有收尾的 }");
        out.push(after[..end].to_string());
        rest = &after[end + 1..];
    }
    out
}

#[test]
fn popular_snapshot_is_top_200_by_installs() {
    let file: PopularFile = serde_json::from_str(POPULAR_JSON).expect("skills-popular.json");
    assert!(!file.source.trim().is_empty(), "要写明数据从哪来");
    assert!(file.generated_at.is_some(), "要写明生成时刻");
    assert_eq!(file.skills.len(), 200, "热门 200");
    assert_eq!(popular_snapshot(), file.skills, "core 读到的就是文件里的");

    let mut seen = BTreeSet::new();
    for s in &file.skills {
        assert!(!s.name.trim().is_empty(), "{s:?} 缺名字");
        assert!(
            is_slug(&s.repo),
            "{} 的仓库不是 owner/repo：{}",
            s.name,
            s.repo
        );
        assert!(s.installs > 0, "{}/{} 装过人数为 0", s.repo, s.name);
        assert!(
            seen.insert((s.repo.clone(), s.name.clone())),
            "重复：{}/{}",
            s.repo,
            s.name
        );
    }
    assert!(
        file.skills
            .windows(2)
            .all(|w| w[0].installs >= w[1].installs),
        "按装过人数从高到低排"
    );
}

#[test]
fn curated_mcp_entries_are_complete_and_consistent() {
    let file: CuratedFile = serde_json::from_str(CURATED_JSON).expect("mcp-curated.json");
    assert!(
        file.attribution.contains("NOTICE") && file.attribution.contains("MIT"),
        "要写明起点的许可，并指到 NOTICE"
    );
    assert_eq!(file.servers.len(), 26, "精选包含新增的 git 与 time");
    for name in ["git", "time"] {
        let entry = file
            .servers
            .iter()
            .find(|e| e.name == name)
            .expect("新增精选存在");
        assert_eq!(entry.definition.command.as_deref(), Some("uvx"));
        assert_eq!(entry.definition.args, vec![format!("mcp-server-{name}")]);
    }
    assert_eq!(curated_mcp(), file.servers, "core 读到的就是文件里的");

    let sign_in: BTreeMap<String, bool> = serde_json::from_str::<RawCurated>(CURATED_JSON)
        .unwrap()
        .servers
        .into_iter()
        .map(|s| (s.name, s.sign_in))
        .collect();

    let mut names = BTreeSet::new();
    for e in &file.servers {
        let d = &e.definition;
        assert!(names.insert(e.name.clone()), "服务名重复：{}", e.name);
        assert_eq!(d.name, e.name, "{}：定义里的名字要与条目一致", e.name);
        assert!(!e.publisher.trim().is_empty(), "{} 缺发布方", e.name);
        assert!(
            all_languages(&e.description),
            "{} 的说明要写全三种语言",
            e.name
        );
        assert_eq!(e.source, "curated", "{} 的出处", e.name);
        let home = e.homepage.as_deref().unwrap_or_default();
        assert!(
            home.starts_with("https://"),
            "{} 缺说明页：{home:?}",
            e.name
        );

        match d.transport {
            McpTransport::Stdio => {
                assert!(
                    d.command.as_deref().is_some_and(|c| !c.is_empty()),
                    "{}：本机命令要有 command",
                    e.name
                );
                assert!(
                    d.url.is_none() && d.headers.is_empty(),
                    "{}：本机命令不带地址",
                    e.name
                );
            }
            McpTransport::Http | McpTransport::Sse => {
                assert!(
                    d.url.as_deref().is_some_and(|u| u.starts_with("https://")),
                    "{}：远程要有 https 地址",
                    e.name
                );
                assert!(
                    d.command.is_none() && d.args.is_empty() && d.env.is_empty(),
                    "{}：远程不带命令",
                    e.name
                );
            }
        }

        // 每个要填的项：键不重复、标签与框下说明三种语言写全，占位出现在它声明的位置
        let mut keys = BTreeSet::new();
        for field in &e.fields {
            assert!(
                keys.insert(field.key.clone()),
                "{}：要填的项重复 {}",
                e.name,
                field.key
            );
            assert!(
                field.label.as_ref().is_some_and(all_languages),
                "{}：{} 的标签要写全三种语言",
                e.name,
                field.key
            );
            assert!(
                field.help.as_ref().is_none_or(all_languages),
                "{}：{} 的框下说明要写全三种语言",
                e.name,
                field.key
            );
            let token = format!("${{{}}}", field.key);
            let found = match field.kind {
                McpFieldKind::Env => d.env.values().any(|v| v.contains(&token)),
                McpFieldKind::Header => d.headers.values().any(|v| v.contains(&token)),
                McpFieldKind::Arg => d.args.iter().any(|v| v.contains(&token)),
            };
            assert!(
                found,
                "{}：{} 不在它声明的 {:?} 里",
                e.name, token, field.kind
            );
        }

        // 反过来：定义里出现的每个占位都声明过
        let texts = d
            .args
            .iter()
            .chain(d.env.values())
            .chain(d.headers.values())
            .chain(d.url.iter())
            .chain(d.command.iter());
        for text in texts {
            for key in placeholders(text) {
                assert!(
                    keys.contains(&key),
                    "{}：占位 ${{{key}}} 没有对应的要填项",
                    e.name
                );
            }
        }

        // 要登录的是远程服务器，登录由 agent 做，不在这里填值
        if sign_in.get(&e.name).copied().unwrap_or(false) {
            assert!(
                matches!(d.transport, McpTransport::Http | McpTransport::Sse),
                "{}：只有远程服务器才在浏览器里登录",
                e.name
            );
            assert!(e.fields.is_empty(), "{}：登录的不再要填值", e.name);
        }
    }
}

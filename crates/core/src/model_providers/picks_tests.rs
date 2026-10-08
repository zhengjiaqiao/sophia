//! 各 agent 的「已选」：只看对外行为（选了什么、什么顺序、失效的项）
use super::*;
use crate::model_providers::NewProvider;

fn add(list: &mut ModelProviders, name: &str, protocol: &str, ids: &[&str]) -> String {
    list.add(NewProvider {
        name: name.into(),
        base_url: format!("https://{}.example/v1", name.to_lowercase()),
        protocol: protocol.into(),
        fetched: ids.iter().map(|id| Model::from(*id)).collect(),
        ..NewProvider::default()
    })
    .unwrap()
    .id
}

fn r(provider: &str, model: &str) -> ModelRef {
    ModelRef::new(provider, model)
}

/// 在这个 agent 的「选模型」里依次勾上（启用与选是两步，测试里先启用、再逐个勾）
fn pick_all(list: &mut ModelProviders, agent: &str, refs: &[ModelRef]) {
    for item in refs {
        list.pick(agent, item, true).unwrap();
    }
}

fn models(list: &ModelProviders, agent: &str) -> Vec<String> {
    list.picked(agent)
        .iter()
        .map(|r| format!("{}/{}", r.provider, r.model))
        .collect()
}

fn slugs(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

/// 勾上追加到末尾、取消拿掉；没启用的模型、不存在的提供商勾不上
#[test]
fn picking_appends_and_unpicking_removes_and_unusable_models_are_refused() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["m1", "m2"]);
    list.set_enabled(&a, "m2", false).unwrap();
    assert!(list.pick("codex", &r(&a, "m1"), true).unwrap());
    assert!(!list.pick("codex", &r(&a, "m1"), true).unwrap(), "已经选了");
    assert_eq!(
        list.pick("codex", &r(&a, "m2"), true),
        Err(ProviderError::NotPickable("m2".into()))
    );
    assert!(list.pick("codex", &r("gone", "m1"), true).is_err());
    assert!(list.pick("codex", &r(&a, "m1"), false).unwrap());
    assert!(list.picked("codex").is_empty());
}

/// Claude 桌面应用的官方模型不能选；Codex 的能
#[test]
fn only_agents_with_pickable_official_models_can_pick_them() {
    let mut list = ModelProviders::default();
    assert!(list
        .pick("codex", &ModelRef::official("gpt-6"), true)
        .unwrap());
    assert!(list
        .pick("claude", &ModelRef::official("opus"), true)
        .is_err());
}

/// 删掉一家、取消启用一个模型：各家「已选」里指着它们的一并拿掉，官方模型与别家的不动
#[test]
fn removing_a_provider_or_disabling_a_model_drops_it_from_every_agent() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["m1", "m2"]);
    let b = add(&mut list, "B", "chat", &["n1"]);
    list.pick("codex", &ModelRef::official("gpt-6"), true)
        .unwrap();
    let refs = [r(&a, "m1"), r(&a, "m2"), r(&b, "n1")];
    pick_all(&mut list, "codex", &refs);
    pick_all(&mut list, "claude", &refs);

    list.set_enabled(&a, "m1", false).unwrap();
    assert_eq!(models(&list, "codex"), ["@official/gpt-6", "a/m2", "b/n1"]);
    list.remove(&b).unwrap();
    assert_eq!(models(&list, "codex"), ["@official/gpt-6", "a/m2"]);
    assert_eq!(models(&list, "claude"), ["a/m2"]);
}

/// 第一次见到官方模型：整组放最前、按它自己的顺序；之后新出现的排最后；用户取消过的不会被选回来
#[test]
fn official_models_lead_at_first_and_new_ones_join_at_the_end() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["m1"]);
    list.pick("codex", &r(&a, "m1"), true).unwrap();

    assert!(list.sync_official("codex", &slugs(&["gpt-6", "gpt-6-mini"])));
    assert_eq!(
        models(&list, "codex"),
        ["@official/gpt-6", "@official/gpt-6-mini", "a/m1"]
    );

    list.pick("codex", &ModelRef::official("gpt-6-mini"), false)
        .unwrap();
    assert!(!list.sync_official("codex", &slugs(&["gpt-6", "gpt-6-mini"])));
    assert!(list.sync_official("codex", &slugs(&["gpt-6", "gpt-6-mini", "gpt-7"])));
    assert_eq!(
        models(&list, "codex"),
        ["@official/gpt-6", "a/m1", "@official/gpt-7"]
    );
    assert!(
        !list.sync_official("claude", &slugs(&["opus"])),
        "Claude 的官方模型不进已选"
    );
}

/// 生效的「已选」：失效的项不算；不再列出的官方模型不算（存着的不动）
#[test]
fn effective_picks_skip_stale_entries_without_forgetting_them() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["m1"]);
    list.sync_official("codex", &slugs(&["gpt-6", "gpt-old"]));
    list.pick("codex", &r(&a, "m1"), true).unwrap();
    list.picks
        .get_mut("codex")
        .unwrap()
        .picked
        .push(r("gone", "x"));

    let now = list.effective_picks("codex", Some(&slugs(&["gpt-6"])));
    assert_eq!(now, [ModelRef::official("gpt-6"), r(&a, "m1")]);
    assert_eq!(list.picked("codex").len(), 4, "存着的不改");
}

/// 写进配置的第三方模型：按「已选」顺序、标识带提供商 id；两家同名的显示名加「 · 提供商名」
#[test]
fn published_follows_the_pick_order_and_names_clashing_models_by_provider() {
    let mut list = ModelProviders::default();
    let kimi = add(&mut list, "Kimi", "chat", &["kimi-k2.6", "only-kimi"]);
    let relay = add(&mut list, "我的中转", "chat", &["kimi-k2.6"]);
    list.pick("claude", &r(&relay, "kimi-k2.6"), true).unwrap();
    list.pick("claude", &r(&kimi, "only-kimi"), true).unwrap();
    list.pick("claude", &r(&kimi, "kimi-k2.6"), true).unwrap();

    let published = list.published("claude");
    let shown: Vec<(String, String)> = published
        .iter()
        .map(|p| {
            (
                p.slug.clone(),
                p.model.display_name.clone().unwrap_or_default(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            (
                format!("{relay}-kimi-k2.6"),
                "kimi-k2.6 · 我的中转".to_owned()
            ),
            ("kimi-only-kimi".to_owned(), String::new()),
            ("kimi-kimi-k2.6".to_owned(), "kimi-k2.6 · Kimi".to_owned()),
        ]
    );
    let routing = list.routing_providers(&published);
    assert_eq!(
        routing.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        [relay.as_str(), "kimi"]
    );
    assert_eq!(routing[1].base_url, "https://kimi.example/v1");
}

/// 浮层：官方一组在前；Codex 没登录时官方组置灰、不算进已选（登录回来照原样）；提供商组按名单先后
#[test]
fn the_picker_view_groups_official_first_and_greys_out_what_cannot_be_picked() {
    let mut list = ModelProviders::default();
    let kimi = add(&mut list, "Kimi", "chat", &["k1", "k2"]);
    list.set_enabled(&kimi, "k2", false).unwrap();
    let officials = vec![
        OfficialModel {
            id: "gpt-6".into(),
            display_name: "GPT-6".into(),
        },
        OfficialModel {
            id: "gpt-6-mini".into(),
            display_name: "GPT-6 mini".into(),
        },
    ];
    list.pick("codex", &r(&kimi, "k1"), true).unwrap();
    list.sync_official("codex", &slugs(&["gpt-6", "gpt-6-mini"]));

    let view = agent_models(&list, "codex", &officials, true);
    let picked: Vec<&str> = view
        .picked
        .iter()
        .map(|p| p.display_name.as_str())
        .collect();
    assert_eq!(picked, ["GPT-6", "GPT-6 mini", "k1"]);
    assert_eq!(view.groups[0].provider, OFFICIAL);
    assert_eq!(view.groups[0].blocked, None);
    assert_eq!(view.groups[1].name, "Kimi");
    assert_eq!(view.groups[1].models.len(), 1, "只列已启用的");
    assert!(view.groups[1].models[0].picked);
    assert_eq!(view.providers, 1);

    // 没登录：置灰，勾选照记着的显示（取消过的不勾），不算进「已选」（走查 2026-10-07 第 13 条）
    list.pick("codex", &ModelRef::official("gpt-6-mini"), false)
        .unwrap();
    let signed_out = agent_models(&list, "codex", &officials, false);
    assert_eq!(signed_out.groups[0].blocked, Some(Blocked::SignedOut));
    assert_eq!(signed_out.picked.len(), 1);
    let ticks: Vec<bool> = signed_out.groups[0]
        .models
        .iter()
        .map(|m| m.picked)
        .collect();
    assert_eq!(ticks, [true, false]);
    // 没动过的新官方模型按「默认选上」算勾上
    let newer = [
        officials.clone(),
        vec![OfficialModel {
            id: "gpt-7".into(),
            display_name: "GPT-7".into(),
        }],
    ]
    .concat();
    let fresh = agent_models(&list, "codex", &newer, false);
    assert!(fresh.groups[0].models[2].picked);
    assert_eq!(fresh.picked.len(), 1);

    // Claude：开着第三方（官方用不了）才说用不了、不勾；关着时官方模型是它自己管的、都在它的菜单里——勾上、置灰
    let claude = agent_models(&list, "claude", &[], false);
    assert_eq!(claude.groups[0].blocked, Some(Blocked::OfficialUnavailable));
    assert!(claude.groups[0].models.iter().all(|m| !m.picked));
    let claude_off = agent_models(&list, "claude", &[], true);
    assert_eq!(claude_off.groups[0].blocked, Some(Blocked::ReadOnly));
    assert!(claude_off.groups[0].models.iter().all(|m| m.picked));
    assert_eq!(claude.groups[0].models.len(), 3, "只列名字让人认得");
    assert!(claude.picked.is_empty());
    assert!(
        claude_off.picked.is_empty(),
        "它自己管的不进「已选」，不算数"
    );
}

/// 一家的协议这个 agent 用不了：组照样列出、置灰、说原因，勾不上、默认也不选进去
#[test]
fn providers_an_agent_cannot_reach_are_listed_greyed_and_never_picked() {
    const ONLY_CHAT: ModelAgent = ModelAgent {
        id: "chat-only",
        protocols: &["chat"],
        official: Official::ReadOnly,
        official_preview: &[],
    };
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "responses", &["m1"]);
    assert!(!usable_by(&ONLY_CHAT, list.provider(&a).unwrap()));
    assert!(usable_by(
        model_agent("codex").unwrap(),
        list.provider(&a).unwrap()
    ));
}

/// WorkBuddy（#266）：凡有 OpenAI 兼容地址的提供商都能用（讲 Responses 的那家也同时有 Chat 接口，路由一律走 Chat）；
/// 官方模型它自己管，只列名字、置灰、不进「已选」，也选不进去
#[test]
fn workbuddy_takes_every_openai_compatible_provider_and_its_official_models_are_read_only() {
    let mut list = ModelProviders::default();
    let kimi = add(&mut list, "Kimi", "chat", &["k1"]);
    let relay = add(&mut list, "Relay", "responses", &["r1"]);
    pick_all(&mut list, "workbuddy", &[r(&kimi, "k1"), r(&relay, "r1")]);
    assert_eq!(models(&list, "workbuddy"), ["kimi/k1", "relay/r1"]);
    assert!(list
        .pick("workbuddy", &ModelRef::official("hunyuan"), true)
        .is_err());

    let view = agent_models(&list, "workbuddy", &[], false);
    assert_eq!(view.groups[0].provider, OFFICIAL);
    assert_eq!(view.groups[0].blocked, Some(Blocked::ReadOnly));
    assert!(!view.groups[0].models.is_empty(), "只列名字让人认得");
    assert!(
        view.groups[0].models.iter().all(|m| m.picked),
        "都在它自己的菜单里：勾上、置灰"
    );
    assert_eq!(view.groups[2].blocked, None);
    assert_eq!(view.picked.len(), 2);
    assert_eq!(
        list.published("workbuddy")
            .iter()
            .map(|p| p.slug.as_str())
            .collect::<Vec<_>>(),
        ["kimi-k1", "relay-r1"]
    );
}

/// 存进 settings.json 的样子：`modelProviders.picks.<agent>.picked`，官方模型的提供商是 `@official`
#[test]
fn picks_are_stored_under_the_agent_id() {
    let mut list = ModelProviders::default();
    list.sync_official("codex", &slugs(&["gpt-6"]));
    let json = serde_json::to_value(&list).unwrap();
    assert_eq!(
        json["picks"]["codex"]["picked"][0],
        serde_json::json!({"provider": "@official", "model": "gpt-6"})
    );
    assert_eq!(json["picks"]["codex"]["officialSeen"][0], "gpt-6");
    let back: ModelProviders = serde_json::from_value(json).unwrap();
    assert_eq!(back, list);
    assert!(serde_json::to_value(ModelProviders::default()).unwrap()["picks"].is_null());
}

/// 排序（#265）：只给出「已选」里看得见的几项的新顺序，它们在原来占的位置上换成新顺序；
/// 看不见的项（Codex 没登录时的官方模型、提供商暂时用不了的）原地不动，不会被排丢；给的项里不在「已选」的忽略
#[test]
fn reordering_moves_only_the_items_given_and_keeps_hidden_ones_in_place() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["m1", "m2", "m3"]);
    list.sync_official("codex", &slugs(&["gpt-6"]));
    pick_all(&mut list, "codex", &[r(&a, "m1"), r(&a, "m2"), r(&a, "m3")]);
    assert_eq!(
        models(&list, "codex"),
        ["@official/gpt-6", "a/m1", "a/m2", "a/m3"]
    );

    // 没登录时浮层里只看得到三个第三方模型：把 m3 挪到最前
    let changed = list
        .reorder(
            "codex",
            &[r(&a, "m3"), r(&a, "m1"), r(&a, "m2"), r(&a, "never-picked")],
        )
        .unwrap();
    assert!(changed);
    assert_eq!(
        models(&list, "codex"),
        ["@official/gpt-6", "a/m3", "a/m1", "a/m2"]
    );
    assert!(!list
        .reorder("codex", &[r(&a, "m3"), r(&a, "m1"), r(&a, "m2")])
        .unwrap());
    assert!(list.reorder("nobody", &[]).is_err());
}

/// 恢复默认顺序：官方的在前、按官方目录自己的顺序；第三方的按启用先后（不是选的先后、不是名单先后）
#[test]
fn restoring_the_default_order_puts_official_models_first_then_by_when_enabled() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["a1", "a2"]);
    let b = add(&mut list, "B", "chat", &["b1"]);
    // a1、a2、b1 加提供商时依次启用；a2 取消后再启用 → 排到 b1 之后
    list.set_enabled(&a, "a2", false).unwrap();
    list.set_enabled(&a, "a2", true).unwrap();
    list.pick("codex", &r(&a, "a2"), true).unwrap();
    list.pick("codex", &ModelRef::official("gpt-6-mini"), true)
        .unwrap();
    list.pick("codex", &r(&b, "b1"), true).unwrap();
    list.pick("codex", &ModelRef::official("gpt-6"), true)
        .unwrap();
    list.pick("codex", &r(&a, "a1"), true).unwrap();

    assert!(list.restore_order("codex", &slugs(&["gpt-6", "gpt-6-mini"])));
    assert_eq!(
        models(&list, "codex"),
        [
            "@official/gpt-6",
            "@official/gpt-6-mini",
            "a/a1",
            "b/b1",
            "a/a2"
        ]
    );
    assert!(
        !list.restore_order("codex", &slugs(&["gpt-6", "gpt-6-mini"])),
        "已经是默认顺序"
    );
}

/// 点名几个 agent 时按模型页的先后（`MODEL_AGENTS`，与网关的 `Agent::ALL` 同序），不按存储的字母序（走查第 10 条）
#[test]
fn all_picks_follow_the_model_page_order() {
    let mut list = ModelProviders::default();
    let a = add(&mut list, "A", "chat", &["m1"]);
    for agent in ["workbuddy", "claude", "codex"] {
        list.pick(agent, &r(&a, "m1"), true).unwrap();
    }
    let agents: Vec<&str> = list
        .all_picks()
        .into_iter()
        .map(|(agent, _)| agent)
        .collect();
    assert_eq!(agents, ["codex", "claude", "workbuddy"]);
}

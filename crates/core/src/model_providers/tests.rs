//! 名单在内存里的改动：只看对外行为（加完启用了哪些、名字怎么定、同名拒绝、重拉保留启用……）
use super::defaults::DefaultRule;
use super::*;
use serde_json::json;

fn models(ids: &[&str]) -> Vec<Model> {
    ids.iter().map(|id| Model::from(*id)).collect()
}

fn new(name: &str, url: &str, fetched: &[&str]) -> NewProvider {
    NewProvider {
        name: name.into(),
        base_url: url.into(),
        api_base: format!("{url}/"),
        protocol: "chat".into(),
        fetched: models(fetched),
        ..NewProvider::default()
    }
}

fn enabled_ids(list: &ModelProviders, id: &str) -> Vec<String> {
    list.provider(id)
        .unwrap()
        .enabled_models()
        .map(|m| m.model.id.clone())
        .collect()
}

fn listed_ids(list: &ModelProviders, id: &str) -> Vec<String> {
    list.provider(id)
        .unwrap()
        .models
        .iter()
        .map(|m| m.model.id.clone())
        .collect()
}

#[test]
fn adding_with_recommendations_enables_only_the_recommended_and_says_so() {
    let mut list = ModelProviders::default();
    let added = list
        .add(NewProvider {
            preset: Some("kimi".into()),
            recommended: vec!["kimi-k2.6".into(), "kimi-for-coding".into()],
            ..new(
                "Kimi",
                "https://api.moonshot.cn/v1",
                &[
                    "moonshot-v1-8k",
                    "kimi-k2.6",
                    "kimi-for-coding",
                    "text-embedding-v1",
                ],
            )
        })
        .unwrap();
    assert_eq!(
        added,
        Added {
            id: "kimi".into(),
            name: "Kimi".into(),
            rule: DefaultRule::Recommended,
            enabled: 2,
            total: 3,
        }
    );
    assert_eq!(enabled_ids(&list, "kimi"), ["kimi-k2.6", "kimi-for-coding"]);
    let provider = list.provider("kimi").unwrap();
    assert_eq!(provider.default_rule, Some(DefaultRule::Recommended));
    assert_eq!(provider.preset.as_deref(), Some("kimi"));
    assert_eq!(
        provider.api_base.as_deref(),
        Some("https://api.moonshot.cn/v1")
    );
    assert!(
        provider
            .enabled_models()
            .all(|m| m.enabled.unwrap().by == EnabledBy::Default),
        "默认启用的记成 Default"
    );
}

/// 非对话模型不进列表（总数里也不算），接口给的重复与空 id 去掉
#[test]
fn non_chat_models_never_enter_the_list() {
    let mut list = ModelProviders::default();
    let added = list
        .add(new(
            "relay",
            "https://relay.example.com/v1",
            &["gpt-x", "whisper-1", "gpt-image-1", "gpt-x", " ", "glm-5.2"],
        ))
        .unwrap();
    assert_eq!(added.total, 2);
    assert_eq!(added.rule, DefaultRule::All);
    assert_eq!(listed_ids(&list, &added.id), ["gpt-x", "glm-5.2"]);
}

/// 超过 20 个对话模型：一个都不启用
#[test]
fn adding_a_provider_with_hundreds_of_models_enables_none() {
    let mut list = ModelProviders::default();
    let ids: Vec<String> = (0..456).map(|i| format!("vendor/model-{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let added = list
        .add(new("OpenRouter", "https://openrouter.ai/api/v1", &refs))
        .unwrap();
    assert_eq!(
        (added.rule, added.enabled, added.total),
        (DefaultRule::TooMany, 0, 456)
    );
}

/// 名称：不填取地址主体；预设名可改；两家同名（不分大小写、去空白）不让加
#[test]
fn names_default_to_the_address_subject_and_must_be_unique() {
    let mut list = ModelProviders::default();
    let relay = list
        .add(new("", "https://relay.example.com/v1", &["a"]))
        .unwrap();
    assert_eq!(relay.name, "relay");
    let kimi = list
        .add(new("Kimi", "https://api.moonshot.cn/v1", &["k"]))
        .unwrap();
    // 同一家加第二份要换个名字
    assert_eq!(
        list.add(new(" kimi ", "https://api.moonshot.cn/v1", &["k"])),
        Err(ProviderError::NameTaken("Kimi".into()))
    );
    let second = list
        .add(new("Kimi 公司", "https://api.moonshot.cn/v1", &["k"]))
        .unwrap();
    assert_ne!(second.id, kimi.id, "id 不撞");
    assert_eq!(list.providers.len(), 3);
    // 改名撞上别家拒绝；改成自己的名字（换大小写）可以
    assert_eq!(
        list.edit(&relay.id, Some("KIMI"), "https://relay.example.com/v1"),
        Err(ProviderError::NameTaken("Kimi".into()))
    );
    assert_eq!(
        list.edit(&kimi.id, Some("KIMI"), "https://api.moonshot.cn/v1"),
        Ok(false)
    );
    assert_eq!(list.provider(&kimi.id).unwrap().name, "KIMI");
}

/// 改地址：旧地址的接口基址与连不上的结论作废；不改地址不动它们
#[test]
fn changing_the_address_drops_what_was_learned_from_the_old_one() {
    let mut list = ModelProviders::default();
    let a = list.add(new("A", "https://a.example/v1", &["m"])).unwrap();
    list.record_unreachable(&a.id, UnreachableReason::Timeout, Some("detail".into()))
        .unwrap();
    assert_eq!(list.edit(&a.id, None, "https://a.example/v1"), Ok(false));
    assert!(list.provider(&a.id).unwrap().unreachable.is_some());
    assert_eq!(list.edit(&a.id, Some(""), "https://b.example/v1"), Ok(true));
    let p = list.provider(&a.id).unwrap();
    assert_eq!((p.name.as_str(), p.api_base.as_deref()), ("A", None));
    assert!(p.unreachable.is_none() && p.unreachable_detail.is_none());
}

/// 重拉：新出现的不启用；已启用的、手填的这次没返回也留着；别的没返回的去掉；非对话模型照样不进来
#[test]
fn refetching_keeps_enabled_and_typed_models() {
    let mut list = ModelProviders::default();
    let a = list
        .add(new("A", "https://a.example/v1", &["m1", "m2", "m3"]))
        .unwrap();
    list.set_enabled(&a.id, "m2", false).unwrap();
    list.enable_typed(&a.id, "custom-x").unwrap();
    let changed = list
        .merge_fetched(
            &a.id,
            models(&["m2", "m4", "tts-1"]),
            "https://a.example/api",
        )
        .unwrap();
    assert!(changed, "接口基址变了");
    assert_eq!(
        listed_ids(&list, &a.id),
        ["m2", "m4", "m1", "m3", "custom-x"]
    );
    assert_eq!(enabled_ids(&list, &a.id), ["m1", "m3", "custom-x"]);
}

/// 用户启用 / 取消：来源记成 User、序号往后排；之后这一家不再算「默认启用」；取消手填的就是移除
#[test]
fn user_changes_record_the_source_and_order() {
    let mut list = ModelProviders::default();
    let a = list
        .add(new("A", "https://a.example/v1", &["m1", "m2"]))
        .unwrap();
    let b = list.add(new("B", "https://b.example/v1", &["n1"])).unwrap();
    assert_eq!(list.enable_seq, 3);
    list.set_enabled(&a.id, "m1", false).unwrap();
    list.set_enabled(&a.id, "m1", true).unwrap();
    let m1 = list.provider(&a.id).unwrap().models[0].enabled.unwrap();
    assert_eq!(
        m1,
        Enabled {
            by: EnabledBy::User,
            seq: 4
        }
    );
    assert_eq!(list.provider(&a.id).unwrap().default_rule, None);
    assert_eq!(
        list.provider(&b.id).unwrap().default_rule,
        Some(DefaultRule::All),
        "别家不受影响"
    );
    // 已经是那个状态：什么都不动，序号也不跳
    list.set_enabled(&a.id, "m1", true).unwrap();
    assert_eq!(list.enable_seq, 4);
    list.enable_typed(&b.id, "typed").unwrap();
    assert!(list.provider(&b.id).unwrap().models[1].model.manual);
    list.set_enabled(&b.id, "typed", false).unwrap();
    assert_eq!(listed_ids(&list, &b.id), ["n1"]);
    assert_eq!(
        list.set_enabled(&b.id, "nope", true),
        Err(ProviderError::NoModel)
    );
    assert_eq!(
        list.set_enabled("gone", "n1", true),
        Err(ProviderError::Unknown("gone".into()))
    );
}

/// 手填的 id 已在列表里：只启用它，不另加一行
#[test]
fn typing_an_id_that_is_already_listed_just_enables_it() {
    let mut list = ModelProviders::default();
    let a = list
        .add(new(
            "A",
            "https://a.example/v1",
            &(0..30).map(|_| "x").collect::<Vec<_>>(),
        ))
        .unwrap();
    // 30 个同名只剩一个，≤ 20 全开；换一家超过 20 个的
    assert_eq!(a.total, 1);
    let ids: Vec<String> = (0..25).map(|i| format!("m{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let b = list.add(new("B", "https://b.example/v1", &refs)).unwrap();
    list.enable_typed(&b.id, " m7 ").unwrap();
    assert_eq!(list.provider(&b.id).unwrap().models.len(), 25);
    assert_eq!(enabled_ids(&list, &b.id), ["m7"]);
    assert_eq!(list.enable_typed(&b.id, "  "), Err(ProviderError::NoModel));
}

#[test]
fn removing_hands_back_the_provider() {
    let mut list = ModelProviders::default();
    let a = list.add(new("A", "https://a.example/v1", &["m"])).unwrap();
    assert_eq!(list.remove(&a.id).unwrap().name, "A");
    assert!(list.providers.is_empty());
    assert_eq!(list.remove(&a.id), Err(ProviderError::Unknown(a.id)));
}

/// 谁在用：按 agent 的「已选」数（#259 给已选；这里只管口径）
#[test]
fn agents_using_counts_agents_that_picked_a_model_of_the_provider() {
    let kimi = ModelRef {
        provider: "kimi".into(),
        model: "kimi-k2.6".into(),
    };
    let ds = ModelRef {
        provider: "deepseek".into(),
        model: "deepseek-v4".into(),
    };
    let codex = vec![kimi.clone(), ds.clone()];
    let claude = vec![ds.clone()];
    let workbuddy = vec![kimi.clone()];
    let picks = [
        ("codex", codex.as_slice()),
        ("claude", claude.as_slice()),
        ("workbuddy", workbuddy.as_slice()),
    ];
    assert_eq!(agents_using("kimi", picks), ["codex", "workbuddy"]);
    assert_eq!(agents_using("deepseek", picks), ["codex", "claude"]);
    assert!(agents_using("relay", picks).is_empty());
    assert_eq!(agents_using_model(&ds, picks), ["codex", "claude"]);
}

/// 落盘的形状：启用了的带 `enabled: {by, seq}`，没启用的不带；默认规则写成小驼峰
#[test]
fn serializes_in_camel_case_with_enabled_source() {
    let mut list = ModelProviders::default();
    list.add(NewProvider {
        recommended: vec!["m1".into()],
        ..new("A", "https://a.example/v1", &["m1", "m2"])
    })
    .unwrap();
    let value = serde_json::to_value(&list).unwrap();
    assert_eq!(
        value,
        json!({
            "providers": [{
                "id": "a", "name": "A", "baseUrl": "https://a.example/v1",
                "apiBase": "https://a.example/v1", "protocol": "chat",
                "models": [
                    {"id": "m1", "vision": false, "enabled": {"by": "default", "seq": 1}},
                    {"id": "m2", "vision": false}
                ],
                "defaultRule": "recommended"
            }],
            "enableSeq": 1
        })
    );
    let back: ModelProviders = serde_json::from_value(value).unwrap();
    assert_eq!(back, list);
}

/// 接管 agents-manager 带来的那一家：新加时名称撞了加序号；勾着的启用并选进 Codex；同一地址再接管换掉模型列表
#[test]
fn adopting_a_taken_over_gateway_enables_and_picks_what_was_selected() {
    let mut list = ModelProviders::default();
    list.add(new("wecode", "https://other.example/v1", &["x"]))
        .unwrap();
    let brought = vec![(Model::from("glm-5"), true), (Model::from("kimi"), false)];
    let target = list.adopt_target("wecode", "https://gw.example/v1");
    let id = list.adopt(
        "codex",
        "wecode",
        "https://gw.example/v1",
        Some("https://gw.example/v1/api".into()),
        "responses",
        brought,
    );
    assert_eq!(id, target);
    assert_eq!(id, "wecode-2");
    let adopted = list.provider(&id).unwrap();
    assert_eq!(adopted.name, "wecode 2");
    assert_eq!(adopted.protocol(), "responses");
    assert_eq!(enabled_ids(&list, &id), ["glm-5"]);
    assert_eq!(list.picked("codex"), [ModelRef::new(&id, "glm-5")]);

    let again = list.adopt(
        "codex",
        "wecode",
        "https://gw.example/v1",
        None,
        "chat",
        vec![(Model::from("kimi"), true)],
    );
    assert_eq!(again, id, "同一地址：还是那一家");
    assert_eq!(list.providers.len(), 2);
    assert_eq!(list.picked("codex"), [ModelRef::new(&id, "kimi")]);
}

/// 添加弹窗里先拉列表、按默认规则勾好给用户看（画板第 9 屏 ②③）：拉到的东西只给界面看，不进名单
#[test]
fn preview_lists_chat_models_and_the_default_choice() {
    let shown = preview(
        models(&[
            "deepseek-chat",
            "deepseek-reasoner",
            "text-embedding-3",
            "deepseek-chat",
        ]),
        &["deepseek-reasoner".to_owned()],
    );
    let ids: Vec<&str> = shown.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        ["deepseek-chat", "deepseek-reasoner"],
        "滤掉非对话、去重"
    );
    assert_eq!(shown.rule, DefaultRule::Recommended);
    assert_eq!(shown.enabled, ["deepseek-reasoner"]);
}

/// 弹窗里用户改过勾选：照用户勾的启用，记成用户启用、不再算「默认」；手填试通的 id 作为手填模型加进来
#[test]
fn adding_with_a_chosen_list_enables_exactly_those() {
    let mut list = ModelProviders::default();
    let added = list
        .add(NewProvider {
            recommended: vec!["m1".into()],
            chosen: Some(vec!["m2".into(), "typed-x".into()]),
            ..new("A", "https://a.example/v1", &["m1", "m2", "m3"])
        })
        .unwrap();
    assert_eq!(added.enabled, 2);
    assert_eq!(added.total, 4, "手填的也算进列表");
    assert_eq!(enabled_ids(&list, "a"), ["m2", "typed-x"]);
    assert_eq!(listed_ids(&list, "a"), ["m1", "m2", "m3", "typed-x"]);
    let provider = list.provider("a").unwrap();
    assert_eq!(provider.default_rule, None, "改过就不是默认了");
    assert!(provider
        .models
        .iter()
        .any(|m| m.model.id == "typed-x" && m.model.manual));
    assert!(provider
        .enabled_models()
        .all(|m| m.enabled.unwrap().by == EnabledBy::User));
}

/// 勾的正好是默认那几个（用户没动）：和不传一样，仍记成默认、行上照旧写「（推荐）」
#[test]
fn adding_with_the_default_choice_unchanged_stays_default() {
    let mut list = ModelProviders::default();
    let added = list
        .add(NewProvider {
            recommended: vec!["m1".into()],
            chosen: Some(vec!["m1".into()]),
            ..new("A", "https://a.example/v1", &["m1", "m2"])
        })
        .unwrap();
    assert_eq!(added.rule, DefaultRule::Recommended);
    assert_eq!(added.enabled, 1);
    let provider = list.provider("a").unwrap();
    assert_eq!(provider.default_rule, Some(DefaultRule::Recommended));
    assert!(provider
        .enabled_models()
        .all(|m| m.enabled.unwrap().by == EnabledBy::Default));
}

/// 一个都不勾也能加（模型太多时常见）
#[test]
fn adding_with_nothing_chosen_enables_none() {
    let mut list = ModelProviders::default();
    let added = list
        .add(NewProvider {
            chosen: Some(Vec::new()),
            ..new("A", "https://a.example/v1", &["m1", "m2"])
        })
        .unwrap();
    assert_eq!(added.enabled, 0);
    assert!(enabled_ids(&list, "a").is_empty());
}

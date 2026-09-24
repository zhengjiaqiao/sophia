#[cfg(feature = "weiboap")]
use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use symsync_core::mcp::{
    auto_selections, execute, location_ref, migrate_baselines, prepare, record_auto_runs, scan,
    upsert_auto_import, McpAutoImportRule, McpLocation, McpSelection,
};
use symsync_core::models::AutoRun;
use tempfile::tempdir;

fn json_location(id: &str, path: &Path, domain: &str) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: "claude-code".into(),
        domain: domain.into(),
        path: path.into(),
        selector: None,
        matrix_hidden: false,
    }
}

fn json_file(path: &Path, value: serde_json::Value) {
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

fn rule(source: &McpLocation, target_domain: &str, targets: &[McpLocation]) -> McpAutoImportRule {
    McpAutoImportRule {
        source: location_ref(source),
        target_domain: target_domain.into(),
        targets: targets.iter().map(location_ref).collect(),
        target_excluded: Default::default(),
        allow_cross_domain: true,
        // 手写的规则等同于在来源还空着时建的：来源里的都算新出现的
        baseline: Some(BTreeSet::new()),
        target_baselines: Default::default(),
        last_auto: None,
    }
}

fn selection(source: &str, name: &str, target: &str) -> McpSelection {
    McpSelection {
        source_id: source.into(),
        name: name.into(),
        target_id: target.into(),
    }
}

#[test]
fn auto_imports_only_current_missing_supported_unexcluded_cells() {
    let temp = tempdir().unwrap();
    let source_path = temp.path().join("source.json");
    let missing_path = temp.path().join("missing.json");
    let invalid_path = temp.path().join("invalid.json");
    let conflict_path = temp.path().join("conflict.json");
    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "skip": {"command": "skip"}
        }}),
    );
    fs::write(&invalid_path, b"{not json").unwrap();
    json_file(
        &conflict_path,
        json!({"mcpServers": {"docs": {"command": "other"}}}),
    );
    let source = json_location("source", &source_path, "global");
    let missing = json_location("missing", &missing_path, "project:one");
    let invalid = json_location("invalid", &invalid_path, "project:one");
    let conflict = json_location("conflict", &conflict_path, "project:one");
    let locations = vec![
        source.clone(),
        missing.clone(),
        invalid.clone(),
        conflict.clone(),
    ];
    let overview = scan(&locations);
    let mut import = rule(
        &source,
        "project:one",
        &[missing.clone(), invalid, conflict],
    );
    for target in ["missing", "invalid", "conflict"] {
        import
            .target_excluded
            .entry(target.into())
            .or_default()
            .insert("skip".into());
    }

    assert_eq!(
        auto_selections(&overview, &[import]),
        vec![selection("source", "docs", "missing")]
    );
}

#[test]
fn auto_imports_require_exact_current_locations_and_cross_domain_consent() {
    let temp = tempdir().unwrap();
    let source_path = temp.path().join("source.json");
    let target_path = temp.path().join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    let source = json_location("source", &source_path, "global");
    let target = json_location("target", &target_path, "project:one");
    let overview = scan(&[source.clone(), target.clone()]);

    let mut denied = rule(&source, "project:one", std::slice::from_ref(&target));
    denied.allow_cross_domain = false;
    assert!(auto_selections(&overview, &[denied]).is_empty());

    let mut stale = rule(&source, "project:one", std::slice::from_ref(&target));
    stale.targets[0].path = temp.path().join("moved.json");
    assert!(auto_selections(&overview, &[stale]).is_empty());

    let mut wrong_domain = rule(&source, "project:one", std::slice::from_ref(&target));
    wrong_domain.targets[0].domain = "project:other".into();
    assert!(auto_selections(&overview, &[wrong_domain]).is_empty());
}

#[test]
fn auto_imports_execute_once_then_pick_up_later_source_additions() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_path = root.join("source.json");
    let target_path = root.join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    json_file(&target_path, json!({"mcpServers": {}}));
    let source = json_location("source", &source_path, "project:one");
    let target = json_location("target", &target_path, "project:one");
    let locations = vec![source.clone(), target.clone()];
    let mut import = rule(&source, "project:one", std::slice::from_ref(&target));
    // 同一来源写到别的位置的规则：这一轮的写入不算到它头上
    let elsewhere = rule(&source, "project:two", &[]);

    let first = auto_selections(&scan(&locations), std::slice::from_ref(&import));
    assert_eq!(first, vec![selection("source", "docs", "target")]);
    let first_plan = prepare(&locations, &first);
    assert!(first_plan.issues.is_empty(), "{:#?}", first_plan.issues);
    let first_actions = first_plan.actions.clone();
    let first_report = execute(first_plan, false);
    assert_eq!(first_report.entries.len(), 1);
    assert_eq!(first_report.entries[0].outcome, "created");
    assert!(target_path.with_extension("mcp.bak").is_file());
    // 真写进去了：记成这条规则最近一次执行
    let mut rules = vec![import.clone(), elsewhere];
    assert!(record_auto_runs(
        &mut rules,
        &first_actions,
        &first_report,
        10
    ));
    assert_eq!(rules[0].last_auto, Some(AutoRun { at: 10, added: 1 }));
    assert_eq!(rules[1].last_auto, None);
    import = rules[0].clone();

    let repeated = auto_selections(&scan(&locations), std::slice::from_ref(&import));
    assert!(repeated.is_empty());
    assert!(!target_path.with_extension("mcp.1.bak").exists());
    // 什么都没写的一轮：不改，上一次留着
    let idle = execute(prepare(&locations, &repeated), false);
    assert!(!record_auto_runs(&mut rules, &[], &idle, 20));
    assert_eq!(rules[0].last_auto, Some(AutoRun { at: 10, added: 1 }));

    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"}
        }}),
    );
    let later = auto_selections(&scan(&locations), std::slice::from_ref(&import));
    assert_eq!(later, vec![selection("source", "search", "target")]);
    let later_plan = prepare(&locations, &later);
    let later_actions = later_plan.actions.clone();
    let later_report = execute(later_plan, false);
    assert_eq!(later_report.entries.len(), 1);
    assert_eq!(later_report.entries[0].outcome, "created");
    assert!(target_path.with_extension("mcp.1.bak").is_file());
    assert!(record_auto_runs(
        &mut rules,
        &later_actions,
        &later_report,
        30
    ));
    assert_eq!(rules[0].last_auto, Some(AutoRun { at: 30, added: 1 }));
    // 旧 settings 里的规则没有这个字段：照常读，写出也不带
    let mut legacy = serde_json::to_value(&rules[0]).unwrap();
    assert_eq!(legacy["lastAuto"], json!({"at": 30, "added": 1}));
    legacy.as_object_mut().unwrap().remove("lastAuto");
    let legacy: McpAutoImportRule = serde_json::from_value(legacy).unwrap();
    assert_eq!(legacy.last_auto, None);
    assert!(serde_json::to_value(&legacy)
        .unwrap()
        .get("lastAuto")
        .is_none());

    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(&target_path).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["docs"]["command"], "docs");
    assert_eq!(written["mcpServers"]["search"]["command"], "search");
}

#[cfg(feature = "weiboap")]
fn weibo_location(id: &str, database: &Path, agent_root: &Path) -> McpLocation {
    let root = fs::canonicalize(agent_root).unwrap();
    McpLocation {
        id: id.into(),
        label: "WeiboAP".into(),
        harness_id: "weiboap".into(),
        domain: format!("project:{}", root.display()),
        path: database.into(),
        selector: None,
        matrix_hidden: false,
    }
}

#[cfg(feature = "weiboap")]
#[test]
fn weibo_agents_in_the_same_database_remain_distinct_rule_locations() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let database = root.join("agents.db");
    let alpha = root.join("Data/agents/agent_alpha");
    let beta = root.join("Data/agents/agent_beta");
    fs::write(
        root.join("config.json"),
        r#"{"pgEnabled":false,"pgEnabled_demo":false}"#,
    )
    .unwrap();
    fs::create_dir_all(&alpha).unwrap();
    fs::create_dir_all(&beta).unwrap();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE agents (id TEXT PRIMARY KEY, mcp_config TEXT, mcps TEXT);\
             INSERT INTO agents VALUES ('agent_alpha', '{\"docs\":{\"name\":\"docs\",\"type\":\"stdio\",\"command\":\"docs\"}}', '[]');\
             INSERT INTO agents VALUES ('agent_beta', '{}', '[]');",
        )
        .unwrap();
    let source = weibo_location("alpha", &database, &alpha);
    let target = weibo_location("beta", &database, &beta);
    assert_eq!(source.path, target.path);
    assert_ne!(location_ref(&source), location_ref(&target));
    let overview = scan(&[source.clone(), target.clone()]);
    let target_domain = target.domain.clone();

    assert_eq!(
        auto_selections(&overview, &[rule(&source, &target_domain, &[target])]),
        vec![selection("alpha", "docs", "beta")]
    );
}

#[test]
fn rule_serialization_never_contains_mcp_definition_values() {
    let temp = tempdir().unwrap();
    let source = json_location("source", &temp.path().join("source.json"), "global");
    let target = json_location("target", &temp.path().join("target.json"), "project:one");
    let encoded = serde_json::to_string(&rule(&source, "project:one", &[target])).unwrap();
    assert!(!encoded.contains("fixture-secret"));
    assert!(!encoded.contains("mcpServers"));
    assert!(!encoded.contains("command"));
}

/// 规则只管以后新出现的：建规则时来源里已有的不补；新增的补；排除照旧；已生效时重新设置不重拍
#[test]
fn auto_import_rule_only_covers_entries_that_appear_after_it() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_path = root.join("source.json");
    let target_path = root.join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    json_file(&target_path, json!({"mcpServers": {}}));
    let source = json_location("source", &source_path, "project:one");
    let target = json_location("target", &target_path, "project:one");
    let locations = vec![source.clone(), target.clone()];
    let mut rules = Vec::new();

    upsert_auto_import(
        &mut rules,
        &scan(&locations),
        &source,
        "project:one".into(),
        vec![location_ref(&target)],
        false,
    )
    .unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(
        rules[0].baseline,
        Some(BTreeSet::from(["docs".to_string()]))
    );
    // 已有的 docs 不补
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    // 新出现的 search 补，且只补它
    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"}
        }}),
    );
    assert_eq!(
        auto_selections(&scan(&locations), &rules),
        vec![selection("source", "search", "target")]
    );

    // 排除照旧
    rules[0]
        .target_excluded
        .entry(target.id.clone())
        .or_default()
        .insert("search".into());
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    // 同一来源 + 目标域重新设置（规则已生效）：不重拍，baseline 与排除名单保留
    upsert_auto_import(
        &mut rules,
        &scan(&locations),
        &source,
        "project:one".into(),
        vec![location_ref(&target)],
        false,
    )
    .unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(
        rules[0].baseline,
        Some(BTreeSet::from(["docs".to_string()]))
    );
    assert!(rules[0].is_excluded(&target.id, "search"));
    assert!(auto_selections(&scan(&locations), &rules).is_empty());
}

/// 给已生效的规则加目标：整条的 baseline 不重拍，新目标另拍一份——它也只管从加进来起新出现的，
/// 建规则之后、加目标之前出现的不补过去；原有目标照旧补
#[test]
fn adding_target_to_active_rule_snapshots_the_new_target() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_path = root.join("source.json");
    let first_path = root.join("first.json");
    let second_path = root.join("second.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    json_file(&first_path, json!({"mcpServers": {}}));
    json_file(&second_path, json!({"mcpServers": {}}));
    let source = json_location("source", &source_path, "project:one");
    let first = json_location("first", &first_path, "project:one");
    let second = json_location("second", &second_path, "project:one");
    let locations = vec![source.clone(), first.clone(), second.clone()];
    let mut rules = Vec::new();

    upsert_auto_import(
        &mut rules,
        &scan(&locations),
        &source,
        "project:one".into(),
        vec![location_ref(&first)],
        false,
    )
    .unwrap();
    // 建规则之后出现的 search
    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"}
        }}),
    );

    upsert_auto_import(
        &mut rules,
        &scan(&locations),
        &source,
        "project:one".into(),
        vec![location_ref(&first), location_ref(&second)],
        false,
    )
    .unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(
        rules[0].baseline,
        Some(BTreeSet::from(["docs".to_string()]))
    );
    assert_eq!(
        rules[0].target_baselines.get("second"),
        Some(&BTreeSet::from(["docs".to_string(), "search".to_string()]))
    );
    assert_eq!(
        auto_selections(&scan(&locations), &rules),
        vec![selection("source", "search", "first")]
    );

    // 加进来之后才出现的 web 两个目标都补
    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"},
            "web": {"command": "web"}
        }}),
    );
    assert_eq!(
        auto_selections(&scan(&locations), &rules),
        vec![
            selection("source", "search", "first"),
            selection("source", "web", "first"),
            selection("source", "web", "second"),
        ]
    );

    // 撤掉的目标那一份随之丢掉
    upsert_auto_import(
        &mut rules,
        &scan(&locations),
        &source,
        "project:one".into(),
        vec![location_ref(&first)],
        false,
    )
    .unwrap();
    assert!(rules[0].target_baselines.is_empty());
}

/// 关掉再开 = 重建：删规则或目标清空都算关，再开时 baseline 重拍、排除名单清空
#[test]
fn turning_rule_off_then_on_resnapshots_baseline() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_path = root.join("source.json");
    let target_path = root.join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    json_file(&target_path, json!({"mcpServers": {}}));
    let source = json_location("source", &source_path, "project:one");
    let target = json_location("target", &target_path, "project:one");
    let locations = vec![source.clone(), target.clone()];
    let set = |rules: &mut Vec<McpAutoImportRule>| {
        upsert_auto_import(
            rules,
            &scan(&locations),
            &source,
            "project:one".into(),
            vec![location_ref(&target)],
            false,
        )
        .unwrap()
    };
    let mut rules = Vec::new();
    set(&mut rules);
    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"}
        }}),
    );
    rules[0]
        .target_excluded
        .entry("target".into())
        .or_default()
        .insert("docs".into());

    // 关：整条删掉（remove_mcp_auto_import 的做法）
    rules.retain(|rule| rule.source.id != source.id || rule.target_domain != "project:one");
    set(&mut rules);
    let both = Some(BTreeSet::from(["docs".to_string(), "search".to_string()]));
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].baseline, both);
    assert!(rules[0].target_excluded.is_empty());
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    // 关：目标清空也算关
    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"},
            "web": {"command": "web"}
        }}),
    );
    rules[0].targets.clear();
    set(&mut rules);
    assert_eq!(rules.len(), 1);
    assert_eq!(
        rules[0].baseline,
        Some(BTreeSet::from([
            "docs".to_string(),
            "search".to_string(),
            "web".to_string()
        ]))
    );
    assert!(auto_selections(&scan(&locations), &rules).is_empty());
}

/// 升级前持久化的规则没有 baseline：迁移前整条不补，迁移取来源当前全部名字，此后只补新的
#[test]
fn legacy_auto_import_rule_without_baseline_migrates_to_current_entries() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_path = root.join("source.json");
    let target_path = root.join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    json_file(&target_path, json!({"mcpServers": {}}));
    let source = json_location("source", &source_path, "project:one");
    let target = json_location("target", &target_path, "project:one");
    let locations = vec![source.clone(), target.clone()];
    let mut encoded = serde_json::to_value(rule(&source, "project:one", &[target])).unwrap();
    encoded.as_object_mut().unwrap().remove("baseline");
    let mut rules: Vec<McpAutoImportRule> = vec![serde_json::from_value(encoded).unwrap()];
    assert_eq!(rules[0].baseline, None);
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    // 来源这次读不出来：不迁移，免得恢复时把现有的全补上
    fs::write(&source_path, b"{not json").unwrap();
    assert!(!migrate_baselines(&mut rules, &scan(&locations)));
    assert_eq!(rules[0].baseline, None);

    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    assert!(migrate_baselines(&mut rules, &scan(&locations)));
    assert_eq!(
        rules[0].baseline,
        Some(BTreeSet::from(["docs".to_string()]))
    );
    assert!(!migrate_baselines(&mut rules, &scan(&locations)));
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"}
        }}),
    );
    assert_eq!(
        auto_selections(&scan(&locations), &rules),
        vec![selection("source", "search", "target")]
    );
}

/// 建规则时来源配置读不出来：拒绝，给出能照着做的话，不拍空快照
#[test]
fn auto_import_rule_is_refused_when_source_config_is_unreadable() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_path = root.join("source.json");
    let target_path = root.join("target.json");
    fs::write(&source_path, b"{not json").unwrap();
    json_file(&target_path, json!({"mcpServers": {}}));
    let source = json_location("source", &source_path, "project:one");
    let target = json_location("target", &target_path, "project:one");
    let mut rules = Vec::new();

    let err = upsert_auto_import(
        &mut rules,
        &scan(&[source.clone(), target.clone()]),
        &source,
        "project:one".into(),
        vec![location_ref(&target)],
        false,
    )
    .unwrap_err();
    assert_eq!(err, "读不到 source 的配置，先修好再开自动添加");
    assert!(rules.is_empty());
}

/// 排除按目标记：A 位置排除的服务，B 位置照常自动写入
#[test]
fn exclusion_on_one_target_does_not_block_other_targets() {
    let temp = tempdir().unwrap();
    let source_path = temp.path().join("source.json");
    let a_path = temp.path().join("a.json");
    let b_path = temp.path().join("b.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    let source = json_location("source", &source_path, "global");
    let a = json_location("a", &a_path, "project:one");
    let b = json_location("b", &b_path, "project:one");
    let locations = vec![source.clone(), a.clone(), b.clone()];
    let mut import = rule(&source, "project:one", &[a.clone(), b.clone()]);
    import
        .target_excluded
        .entry(a.id.clone())
        .or_default()
        .insert("docs".into());

    assert!(import.is_excluded("a", "docs"));
    assert!(!import.is_excluded("b", "docs"));
    assert_eq!(
        auto_selections(&scan(&locations), &[import]),
        vec![selection("source", "docs", "b")]
    );
}

/// 旧文件里整条的 `excluded`：读进来拆给当时的每个目标，行为不变；写回只有新字段，再读回不变
#[test]
fn legacy_rule_wide_excluded_migrates_per_target_and_round_trips() {
    let temp = tempdir().unwrap();
    let source_path = temp.path().join("source.json");
    let a_path = temp.path().join("a.json");
    let b_path = temp.path().join("b.json");
    json_file(
        &source_path,
        json!({"mcpServers": {"docs": {"command": "docs"}, "web": {"command": "web"}}}),
    );
    let source = json_location("source", &source_path, "global");
    let a = json_location("a", &a_path, "project:one");
    let b = json_location("b", &b_path, "project:one");
    let locations = vec![source.clone(), a.clone(), b.clone()];
    let mut old = serde_json::to_value(rule(&source, "project:one", &[a, b])).unwrap();
    old["excluded"] = json!(["docs"]);
    assert!(old.get("targetExcluded").is_none());

    let migrated: McpAutoImportRule = serde_json::from_value(old).unwrap();
    let docs = BTreeSet::from(["docs".to_string()]);
    assert_eq!(
        migrated.target_excluded,
        [("a".to_string(), docs.clone()), ("b".to_string(), docs)]
            .into_iter()
            .collect()
    );
    // 行为不变：docs 两处都不补，web 两处都补
    assert_eq!(
        auto_selections(&scan(&locations), std::slice::from_ref(&migrated)),
        vec![
            selection("source", "web", "a"),
            selection("source", "web", "b")
        ]
    );

    let written = serde_json::to_value(&migrated).unwrap();
    assert!(written.get("excluded").is_none());
    assert_eq!(
        written["targetExcluded"],
        json!({"a": ["docs"], "b": ["docs"]})
    );
    assert_eq!(
        serde_json::from_value::<McpAutoImportRule>(written).unwrap(),
        migrated
    );

    // 空的旧名单、没有目标的旧规则：不留空键
    let mut targetless = serde_json::to_value(rule(&source, "project:one", &[])).unwrap();
    targetless["excluded"] = json!(["docs"]);
    let targetless: McpAutoImportRule = serde_json::from_value(targetless).unwrap();
    assert!(targetless.target_excluded.is_empty());
}

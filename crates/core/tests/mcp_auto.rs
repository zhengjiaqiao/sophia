#[cfg(feature = "weiboap")]
use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use symsync_core::mcp::{
    auto_selections, execute, location_ref, migrate_baselines, prepare, scan, upsert_auto_import,
    McpAutoImportRule, McpLocation, McpSelection,
};
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
        excluded: BTreeSet::new(),
        allow_cross_domain: true,
        // 手写的规则等同于在来源还空着时建的：来源里的都算新出现的
        baseline: Some(BTreeSet::new()),
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
    import.excluded.insert("skip".into());

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
    let import = rule(&source, "project:one", std::slice::from_ref(&target));

    let first = auto_selections(&scan(&locations), std::slice::from_ref(&import));
    assert_eq!(first, vec![selection("source", "docs", "target")]);
    let first_plan = prepare(&locations, &first);
    assert!(first_plan.issues.is_empty(), "{:#?}", first_plan.issues);
    let first_report = execute(first_plan, false);
    assert_eq!(first_report.entries.len(), 1);
    assert_eq!(first_report.entries[0].outcome, "created");
    assert!(target_path.with_extension("mcp.bak").is_file());

    let repeated = auto_selections(&scan(&locations), std::slice::from_ref(&import));
    assert!(repeated.is_empty());
    assert!(!target_path.with_extension("mcp.1.bak").exists());

    json_file(
        &source_path,
        json!({"mcpServers": {
            "docs": {"command": "docs"},
            "search": {"command": "search"}
        }}),
    );
    let later = auto_selections(&scan(&locations), std::slice::from_ref(&import));
    assert_eq!(later, vec![selection("source", "search", "target")]);
    let later_report = execute(prepare(&locations, &later), false);
    assert_eq!(later_report.entries.len(), 1);
    assert_eq!(later_report.entries[0].outcome, "created");
    assert!(target_path.with_extension("mcp.1.bak").is_file());

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

/// 规则只管以后新出现的：建规则时来源里已有的不补；新增的补；排除照旧；整条重建会重拍 baseline
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
    rules[0].excluded.insert("search".into());
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    // 同一来源 + 目标域重新设置 = 整条重建：baseline 重拍，排除名单清空
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
        Some(BTreeSet::from(["docs".to_string(), "search".to_string()]))
    );
    assert!(rules[0].excluded.is_empty());
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

//! 内部版（`weiboap` feature）专用：关掉 feature 时整份文件不编译。
#![cfg(feature = "weiboap")]

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use symsync_core::mcp::{execute, prepare, scan, McpLocation, McpSelection};
use tempfile::{tempdir, TempDir};

struct Fixture {
    _temp: TempDir,
    user_data: PathBuf,
    database: PathBuf,
}

fn fixture(rows: &[(&str, Value)], pg_enabled: bool) -> Fixture {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let user_data = root.join("user-data");
    fs::create_dir_all(user_data.join("Data/agents")).unwrap();
    fs::write(
        user_data.join("config.json"),
        serde_json::to_vec(&json!({"pgEnabled": pg_enabled})).unwrap(),
    )
    .unwrap();
    for (id, _) in rows {
        fs::create_dir(user_data.join("Data/agents").join(id)).unwrap();
    }
    let database = user_data.join("agents.db");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, mcps TEXT, mcp_config TEXT, other TEXT);",
        )
        .unwrap();
    for (id, config) in rows {
        connection
            .execute(
                "INSERT INTO agents (id, name, mcps, mcp_config, other) VALUES (?1, ?2, ?3, ?4, ?5)",
                (id, &format!("Agent {id}"), "[\"keep-enabled\"]", &config.to_string(), &format!("keep-{id}")),
            )
            .unwrap();
    }
    Fixture {
        _temp: temp,
        user_data,
        database,
    }
}

fn weibo_location(fixture: &Fixture, agent: &str, id: &str) -> McpLocation {
    let root = fixture.user_data.join("Data/agents").join(agent);
    McpLocation {
        // 这里刻意不是 `project:...::weiboap`：MCP DTO 的 id 不能成为数据库记录身份。
        id: id.into(),
        label: "WeiboAP".into(),
        harness_id: "weiboap".into(),
        domain: format!("project:{}", root.display()),
        path: fixture.database.clone(),
        selector: None,
        matrix_hidden: false,
    }
}

fn json_location(id: &str, path: &Path) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: "JSON".into(),
        harness_id: "claude-code".into(),
        domain: "global".into(),
        path: path.into(),
        selector: None,
        matrix_hidden: false,
    }
}

fn selection(source: &str, name: &str, target: &str) -> McpSelection {
    McpSelection {
        source_id: source.into(),
        name: name.into(),
        target_id: target.into(),
    }
}

fn source_file(path: &Path, servers: Value) {
    fs::write(
        path,
        serde_json::to_vec(&json!({"mcpServers": servers})).unwrap(),
    )
    .unwrap();
}

fn agent_columns(database: &Path, id: &str) -> (String, String, String) {
    let connection =
        Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    connection
        .query_row(
            "SELECT mcps, mcp_config, other FROM agents WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

#[test]
fn shared_database_agents_stay_isolated_with_opaque_location_ids() {
    let fixture = fixture(&[("a", json!({})), ("b", json!({}))], false);
    let source = fixture.user_data.join("source.json");
    source_file(&source, json!({"docs": {"command": "docs"}}));
    let locations = vec![
        json_location("source", &source),
        weibo_location(&fixture, "a", "opaque-a"),
        weibo_location(&fixture, "b", "opaque-b"),
    ];

    let plan = prepare(
        &locations,
        &[
            selection("source", "docs", "opaque-a"),
            selection("source", "docs", "opaque-b"),
        ],
    );
    assert!(plan.issues.is_empty());
    assert_eq!(plan.actions.len(), 2);
    let report = execute(plan, true);
    assert!(report
        .entries
        .iter()
        .all(|entry| entry.outcome == "created"));

    for agent in ["a", "b"] {
        let (mcps, config, other) = agent_columns(&fixture.database, agent);
        assert_eq!(mcps, "[\"keep-enabled\"]");
        assert_eq!(other, format!("keep-{agent}"));
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["docs"]["command"],
            "docs"
        );
    }
}

#[test]
fn one_weibo_batch_uses_one_readable_backup_of_the_original_row() {
    let original = json!({"kept": {"name": "kept", "type": "stdio", "command": "keep"}});
    let fixture = fixture(&[("a", original.clone())], false);
    let source = fixture.user_data.join("source.json");
    source_file(
        &source,
        json!({
            "one": {"command": "one"},
            "two": {"type": "http", "url": "https://example.test/mcp"}
        }),
    );
    let locations = vec![
        json_location("source", &source),
        weibo_location(&fixture, "a", "opaque-a"),
    ];
    let report = execute(
        prepare(
            &locations,
            &[
                selection("source", "one", "opaque-a"),
                selection("source", "two", "opaque-a"),
            ],
        ),
        true,
    );
    assert!(report
        .entries
        .iter()
        .all(|entry| entry.outcome == "created"));
    let backups: Vec<_> = report
        .entries
        .iter()
        .filter_map(|entry| entry.backup_path.as_ref())
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = Connection::open_with_flags(backups[0], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let backup_config: String = backup
        .query_row("SELECT mcp_config FROM agents WHERE id = 'a'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&backup_config).unwrap(),
        original
    );
}

#[test]
fn weibo_source_exports_stdio_and_http_public_fields_to_json() {
    let fixture = fixture(
        &[(
            "a",
            json!({
                "stdio": {"name": "stdio", "type": "stdio", "command": "run", "args": ["--flag"], "env": {"MODE": "test"}},
                "http": {"name": "http", "type": "http", "url": "https://example.test/mcp", "headers": {"Accept": "application/json"}}
            }),
        )],
        false,
    );
    let target = fixture.user_data.join("target.json");
    source_file(&target, json!({}));
    let locations = vec![
        weibo_location(&fixture, "a", "opaque-source"),
        json_location("target", &target),
    ];
    let report = execute(
        prepare(
            &locations,
            &[
                selection("opaque-source", "stdio", "target"),
                selection("opaque-source", "http", "target"),
            ],
        ),
        true,
    );
    assert!(report
        .entries
        .iter()
        .all(|entry| entry.outcome == "created"));
    let written: Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["stdio"]["command"], "run");
    assert_eq!(written["mcpServers"]["stdio"]["args"], json!(["--flag"]));
    assert_eq!(written["mcpServers"]["stdio"]["env"]["MODE"], "test");
    assert_eq!(
        written["mcpServers"]["http"]["url"],
        "https://example.test/mcp"
    );
    assert_eq!(
        written["mcpServers"]["http"]["headers"]["Accept"],
        "application/json"
    );
}

#[test]
fn cloud_mode_and_changed_preview_are_rejected_without_overwrite() {
    let cloud = fixture(&[("a", json!({}))], true);
    let source = cloud.user_data.join("source.json");
    source_file(&source, json!({"docs": {"command": "docs"}}));
    let cloud_locations = vec![
        json_location("source", &source),
        weibo_location(&cloud, "a", "opaque-a"),
    ];
    let cloud_plan = prepare(&cloud_locations, &[selection("source", "docs", "opaque-a")]);
    assert!(cloud_plan.actions.is_empty());
    assert!(!cloud_plan.issues.is_empty());
    assert_eq!(agent_columns(&cloud.database, "a").1, "{}");

    let local = fixture(&[("a", json!({}))], false);
    let source = local.user_data.join("source.json");
    source_file(&source, json!({"docs": {"command": "docs"}}));
    let locations = vec![
        json_location("source", &source),
        weibo_location(&local, "a", "opaque-a"),
    ];
    let plan = prepare(&locations, &[selection("source", "docs", "opaque-a")]);
    assert_eq!(plan.actions.len(), 1);
    Connection::open(&local.database)
        .unwrap()
        .execute(
            "UPDATE agents SET mcp_config = ?1 WHERE id = 'a'",
            ["{\"external\":{}}"],
        )
        .unwrap();
    let report = execute(plan, true);
    assert_eq!(report.entries[0].outcome, "failed");
    assert_eq!(agent_columns(&local.database, "a").1, "{\"external\":{}}");
}

#[test]
fn invalid_config_and_missing_row_never_create_agent_records() {
    let fixture = fixture(&[("invalid", json!([]))], false);
    fs::create_dir(fixture.user_data.join("Data/agents/missing")).unwrap();
    let source = fixture.user_data.join("source.json");
    source_file(&source, json!({"docs": {"command": "docs"}}));
    let locations = vec![
        json_location("source", &source),
        weibo_location(&fixture, "invalid", "opaque-invalid"),
        weibo_location(&fixture, "missing", "opaque-missing"),
    ];
    let overview = scan(&locations);
    assert!(overview
        .issues
        .iter()
        .any(|issue| issue.location_id == "opaque-invalid"));
    assert!(overview
        .issues
        .iter()
        .any(|issue| issue.location_id == "opaque-missing"));
    let plan = prepare(
        &locations,
        &[
            selection("source", "docs", "opaque-invalid"),
            selection("source", "docs", "opaque-missing"),
        ],
    );
    assert!(plan.actions.is_empty());
    assert!(!plan.issues.is_empty());
    assert_eq!(
        Connection::open(&fixture.database)
            .unwrap()
            .query_row("SELECT count(*) FROM agents", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

use rusqlite::Connection;
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use symsync_core::discovery::Env;
use symsync_core::mcp::{execute, prepare, scan, McpLocation, McpSelection};
#[cfg(target_os = "macos")]
use symsync_core::models::Harness;
use tempfile::tempdir;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    db: PathBuf,
    alpha: PathBuf,
    beta: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let db = root.join("agents.db");
        fs::write(
            root.join("config.json"),
            r#"{"pgEnabled":false,"pgEnabled_demo":false}"#,
        )
        .unwrap();
        let alpha = root.join("Data/agents/agent_alpha");
        let beta = root.join("Data/agents/agent_beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE agents (id TEXT PRIMARY KEY, mcp_config TEXT, mcps TEXT, note TEXT);\
                 INSERT INTO agents VALUES ('agent_alpha', '{\"old\":{\"name\":\"old\",\"type\":\"stdio\",\"command\":\"old\",\"version\":null},\"opaque\":{\"huge\":1234567890123456789012345678901234567890,\"precise\":1.2345678901234567890123456789}}', '[\"old\"]', 'keep');\
                 INSERT INTO agents VALUES ('agent_beta', '{}', '[\"keep-enabled\"]', 'keep-beta');",
            )
            .unwrap();
        Self {
            _temp: temp,
            root,
            db,
            alpha,
            beta,
        }
    }

    fn weibo(&self, root: &Path) -> McpLocation {
        let root = fs::canonicalize(root).unwrap();
        let domain = root.to_string_lossy().into_owned();
        McpLocation {
            id: format!("arbitrary:{}", root.display()),
            label: "WeiboAP".into(),
            harness_id: "weiboap".into(),
            domain: format!("project:{domain}"),
            path: self.db.clone(),
            selector: None,
            matrix_hidden: false,
        }
    }

    fn config(&self, id: &str) -> String {
        Connection::open(&self.db)
            .unwrap()
            .query_row("SELECT mcp_config FROM agents WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .unwrap()
    }
}

fn json_location(id: &str, path: &Path) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
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

// 只被下面两个 macOS 专属的测试用到；不加门控的话，非 macOS 上会因“未使用”让 clippy 报错
#[cfg(target_os = "macos")]
fn weibo_harness() -> Harness {
    Harness {
        id: "weiboap".into(),
        display_name: "WeiboAP".into(),
        project_dir: None,
        global_dir: None,
        universal: false,
        agent_dirs: Vec::new(),
        managed_global_dir: false,
        agent_labels: None,
    }
}

#[cfg(target_os = "macos")]
#[test]
fn discovery_uses_default_root_only_when_override_is_absent() {
    let temp = tempdir().unwrap();
    let home = fs::canonicalize(temp.path()).unwrap();
    let default_root = home.join("Library/Application Support/WeiboAP");
    fs::create_dir_all(default_root.join("Data/agents/agent_one")).unwrap();
    fs::create_dir_all(default_root.join("Data/agents/agent_two")).unwrap();
    let env = Env {
        home,
        vars: HashMap::new(),
    };
    let discovered = symsync_core::mcp::discover_locations(&env, &[weibo_harness()], &[]);
    assert!(discovered.issues.is_empty());
    assert_eq!(discovered.locations.len(), 2);
    assert!(discovered.locations.iter().all(|location| {
        location.harness_id == "weiboap"
            && location.path == default_root.join("agents.db")
            && location.domain.starts_with("project:")
    }));
}

#[cfg(target_os = "macos")]
#[test]
fn invalid_override_never_falls_back_to_default_root() {
    let temp = tempdir().unwrap();
    let home = fs::canonicalize(temp.path()).unwrap();
    let default_root = home.join("Library/Application Support/WeiboAP");
    fs::create_dir_all(default_root.join("Data/agents/agent_default")).unwrap();
    let override_file = home.join(".weiboap/config/config.json");
    fs::create_dir_all(override_file.parent().unwrap()).unwrap();
    for bytes in [
        b"{".as_slice(),
        br#"{"appDataPath":"relative"}"#,
        br#"{"appDataPath":[{"executablePath":"/Applications/WeiboAP.app/Contents/MacOS/WeiboAP"},{"executablePath":"/Applications/WeiboAP.app/Contents/MacOS/WeiboAP","dataPath":"/tmp/valid"}]}"#,
    ] {
        fs::write(&override_file, bytes).unwrap();
        let env = Env {
            home: home.clone(),
            vars: HashMap::new(),
        };
        let discovered = symsync_core::mcp::discover_locations(&env, &[weibo_harness()], &[]);
        assert!(discovered.locations.is_empty());
        assert_eq!(discovered.issues.len(), 1);
    }
}

#[test]
fn writes_two_agents_once_without_changing_enabled_or_unknown_values() {
    let fixture = Fixture::new();
    let source = fixture.root.join("source.json");
    fs::write(
        &source,
        serde_json::to_vec(&json!({"mcpServers":{"docs":{"command":"docs"},"remote":{"type":"http","url":"https://example.test/mcp"}}})).unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&fixture.db, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let locations = vec![
        json_location("source", &source),
        fixture.weibo(&fixture.alpha),
        fixture.weibo(&fixture.beta),
    ];
    let alpha = locations[1].id.clone();
    let beta = locations[2].id.clone();
    let plan = prepare(
        &locations,
        &[
            selection("source", "docs", &alpha),
            selection("source", "remote", &beta),
        ],
    );
    assert!(plan.issues.is_empty());
    assert_eq!(plan.actions.len(), 2);
    let report = execute(plan, true);
    assert!(report
        .entries
        .iter()
        .all(|entry| entry.outcome == "created"));
    let backup = report
        .entries
        .iter()
        .find_map(|entry| entry.backup_path.clone())
        .unwrap();
    assert!(backup.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert!(fs::metadata(&backup).unwrap().permissions().mode() & 0o777 <= 0o600);
    }
    let alpha: Value = serde_json::from_str(&fixture.config("agent_alpha")).unwrap();
    assert_eq!(alpha["old"]["version"], Value::Null);
    assert_eq!(alpha["docs"]["name"], "docs");
    assert_eq!(alpha["docs"]["type"], "stdio");
    let alpha_raw = fixture.config("agent_alpha");
    assert!(alpha_raw.contains("1234567890123456789012345678901234567890"));
    assert!(alpha_raw.contains("1.2345678901234567890123456789"));
    let beta: Value = serde_json::from_str(&fixture.config("agent_beta")).unwrap();
    assert_eq!(beta["remote"]["type"], "http");
    assert_eq!(beta["remote"]["url"], "https://example.test/mcp");
    let connection = Connection::open(&fixture.db).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT mcps FROM agents WHERE id = 'agent_alpha'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "[\"old\"]"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT note FROM agents WHERE id = 'agent_beta'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "keep-beta"
    );
    let before: String = Connection::open(&backup)
        .unwrap()
        .query_row(
            "SELECT mcp_config FROM agents WHERE id = 'agent_beta'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(before, "{}");
}

#[test]
fn weibo_source_round_trips_to_json_and_stale_or_pg_mode_are_rejected() {
    let fixture = Fixture::new();
    let target = fixture.root.join("target.json");
    let source = fixture.weibo(&fixture.alpha);
    let target_location = json_location("target", &target);
    let plan = prepare(
        &[source.clone(), target_location.clone()],
        &[selection(&source.id, "old", &target_location.id)],
    );
    assert!(plan.issues.is_empty());
    let report = execute(plan, true);
    assert_eq!(report.entries[0].outcome, "created");
    let value: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(value["mcpServers"]["old"]["command"], "old");

    let stale_target = json_location("stale-target", &fixture.root.join("stale-target.json"));
    let source = fixture.weibo(&fixture.alpha);
    let plan = prepare(
        &[source.clone(), stale_target.clone()],
        &[selection(&source.id, "old", &stale_target.id)],
    );
    Connection::open(&fixture.db)
        .unwrap()
        .execute(
            "UPDATE agents SET mcp_config = '{}' WHERE id = 'agent_alpha'",
            [],
        )
        .unwrap();
    let report = execute(plan, true);
    assert_eq!(report.entries[0].outcome, "failed");

    fs::write(fixture.root.join("config.json"), r#"{"pgEnabled":true}"#).unwrap();
    let overview = scan(&[fixture.weibo(&fixture.beta)]);
    assert_eq!(overview.entries.len(), 0);
    assert_eq!(overview.issues.len(), 1);
}

#[cfg(unix)]
#[test]
fn symlinked_agent_root_is_invalid() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let linked = fixture.root.join("Data/agents/linked");
    symlink(&fixture.alpha, &linked).unwrap();
    let location = McpLocation {
        id: "anything".into(),
        label: "WeiboAP".into(),
        harness_id: "weiboap".into(),
        domain: format!("project:{}", linked.display()),
        path: fixture.db.clone(),
        selector: None,
        matrix_hidden: false,
    };
    let overview = scan(&[location]);
    assert_eq!(overview.entries.len(), 0);
    assert_eq!(overview.issues.len(), 1);
}

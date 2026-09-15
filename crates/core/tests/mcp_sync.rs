use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use symsync_core::discovery::Env;
use symsync_core::mcp::{execute, prepare, scan, McpCellState, McpLocation, McpSelection};
use symsync_core::models::Harness;
use tempfile::tempdir;

fn loc(id: &str, path: &Path, domain: &str) -> McpLocation {
    let path = canonical_path(path);
    let harness_id = if path.extension().and_then(|e| e.to_str()) == Some("toml") {
        "codex"
    } else {
        "claude-code"
    };
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: harness_id.into(),
        domain: domain.into(),
        path,
        selector: None,
        matrix_hidden: false,
    }
}
fn loc_h(id: &str, path: &Path, domain: &str, harness_id: &str) -> McpLocation {
    let mut value = loc(id, path, domain);
    value.harness_id = harness_id.into();
    value
}
fn canonical_path(path: &Path) -> PathBuf {
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return path.to_path_buf();
    }
    if path.exists() {
        fs::canonicalize(path).unwrap()
    } else if fs::symlink_metadata(path.parent().unwrap())
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        path.to_path_buf()
    } else {
        let parent = fs::canonicalize(path.parent().unwrap()).unwrap();
        parent.join(path.file_name().unwrap())
    }
}
fn json_file(path: &Path, value: serde_json::Value) {
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}
fn sel(source_id: &str, name: &str, target_id: &str) -> McpSelection {
    McpSelection {
        source_id: source_id.into(),
        name: name.into(),
        target_id: target_id.into(),
    }
}

fn cell<'a>(
    overview: &'a symsync_core::mcp::McpOverview,
    source: &str,
    target: &str,
) -> &'a symsync_core::mcp::McpCell {
    overview
        .entries
        .iter()
        .find(|entry| entry.source_id == source)
        .unwrap()
        .cells
        .iter()
        .find(|cell| cell.target_id == target)
        .unwrap()
}

fn claude_harness() -> Harness {
    Harness {
        id: "claude-code".into(),
        display_name: "Claude Code".into(),
        project_dir: None,
        global_dir: None,
        universal: false,
        agent_dirs: Vec::new(),
    }
}

fn claude_local(id: &str, path: &Path, domain: &str, project_key: &str) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: "Claude Code · Local MCPs".into(),
        harness_id: "claude-code".into(),
        domain: domain.into(),
        path: canonical_path(path),
        selector: Some(project_key.into()),
        matrix_hidden: false,
    }
}

#[test]
fn http_definition_is_parsed_and_migrated_with_http_type() {
    let t = tempdir().unwrap();
    let source_path = t.path().join("source.json");
    let target_path = t.path().join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers":{"docs":{"type":"http","url":"https://example.test/mcp"}}}),
    );
    let locations = vec![
        loc("source", &source_path, "global"),
        loc_h("target", &target_path, "global", "cursor"),
    ];
    let overview = scan(&locations);
    assert_eq!(overview.entries[0].transport, "http");
    assert_eq!(overview.entries[0].cells[1].state, McpCellState::Missing);
    let report = execute(
        prepare(&locations, &[sel("source", "docs", "target")]),
        false,
    );
    assert_eq!(report.entries[0].outcome, "created");
    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(target_path).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["docs"]["type"], "http");
}

#[test]
fn two_servers_share_one_backup_and_both_succeed() {
    let t = tempdir().unwrap();
    let source_path = t.path().join("source.json");
    let target_path = t.path().join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers":{"one":{"command":"one"},"two":{"command":"two"}}}),
    );
    let original = b"{\n  \"mcpServers\": {},\n  \"unknown\": 42\n}\n";
    fs::write(&target_path, original).unwrap();
    let locations = vec![
        loc("source", &source_path, "global"),
        loc("target", &target_path, "global"),
    ];
    let plan = prepare(
        &locations,
        &[
            sel("source", "one", "target"),
            sel("source", "two", "target"),
        ],
    );
    assert_eq!(plan.actions.len(), 2);
    let report = execute(plan, false);
    assert!(report.entries.iter().all(|e| e.outcome == "created"));
    let backups: Vec<_> = report
        .entries
        .iter()
        .filter_map(|e| e.backup_path.as_ref())
        .collect();
    assert!(!backups.is_empty());
    assert_eq!(
        backups
            .iter()
            .map(|p| (*p).clone())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        1
    );
    assert_eq!(fs::read(backups[0]).unwrap(), original);
}

#[test]
fn json_unknown_fields_numbers_and_whitespace_survive_merge() {
    let t = tempdir().unwrap();
    let source_path = t.path().join("source.json");
    let target_path = t.path().join("target.json");
    json_file(
        &source_path,
        json!({"mcpServers":{"new":{"command":"run"}}}),
    );
    let original = b"{\n  \"mcpServers\": {},\n  \"unknownNumber\": 7,\n  \"unknownObject\": { \"keep\": true },\n  \"spacing\": [ 1,  2, 3 ]\n}\n";
    fs::write(&target_path, original).unwrap();
    let locations = vec![
        loc("source", &source_path, "global"),
        loc("target", &target_path, "global"),
    ];
    let report = execute(
        prepare(&locations, &[sel("source", "new", "target")]),
        false,
    );
    assert_eq!(report.entries[0].outcome, "created");
    let written = String::from_utf8(fs::read(target_path).unwrap()).unwrap();
    assert!(written.contains("\"unknownNumber\": 7"));
    assert!(written.contains("\"unknownObject\": { \"keep\": true }"));
    assert!(written.contains("\"spacing\": [ 1,  2, 3 ]"));
}

#[test]
fn codex_inline_env_is_migrated_without_losing_values() {
    let t = tempdir().unwrap();
    let source_path = t.path().join("source.toml");
    let target_path = t.path().join("target.toml");
    fs::write(&source_path, "[mcp_servers.docs]\ncommand = \"docs\"\nargs = [\"--port\", \"1\"]\nenv = { KEY = \"value\" }\n").unwrap();
    let locations = vec![
        loc("source", &source_path, "global"),
        loc("target", &target_path, "global"),
    ];
    let report = execute(
        prepare(&locations, &[sel("source", "docs", "target")]),
        false,
    );
    assert_eq!(report.entries[0].outcome, "created");
    assert!(String::from_utf8(fs::read(target_path).unwrap())
        .unwrap()
        .contains("KEY = \"value\""));
}

#[test]
fn codex_client_settings_do_not_change_connection_equality_or_cross_harness_safety() {
    let t = tempdir().unwrap();
    let codex = t.path().join("codex.toml");
    let claude = t.path().join("claude.json");
    let claude_new = t.path().join("claude-new.json");
    fs::write(
        &codex,
        "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\nenabled = true\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n",
    )
    .unwrap();
    json_file(
        &claude,
        json!({"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp"}}}),
    );
    let locations = vec![
        loc("codex", &codex, "global"),
        loc("claude", &claude, "global"),
        loc("claude-new", &claude_new, "global"),
    ];
    let overview = scan(&locations);
    let codex_entry = overview
        .entries
        .iter()
        .find(|entry| entry.source_id == "codex")
        .unwrap();
    assert_eq!(codex_entry.cells[1].state, McpCellState::Equal);
    let plan = prepare(&locations, &[sel("codex", "search", "claude-new")]);
    assert!(plan.actions.is_empty());
    assert!(plan
        .issues
        .iter()
        .any(|issue| issue.message.contains("enabled") && issue.message.contains("跨工具")));
}

#[test]
fn codex_same_harness_new_target_preserves_confirmed_client_settings() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.toml");
    let target = t.path().join("target.toml");
    fs::write(
        &source,
        "[mcp_servers.docs]\nurl = \"https://example.test/mcp\"\nenabled = true\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n",
    )
    .unwrap();
    let locations = vec![
        loc("source", &source, "global"),
        loc("target", &target, "project"),
    ];
    let report = execute(
        prepare(&locations, &[sel("source", "docs", "target")]),
        true,
    );
    assert_eq!(report.entries[0].outcome, "created");
    let output = fs::read_to_string(target).unwrap();
    let document = output.parse::<toml_edit::DocumentMut>().unwrap();
    let docs = document["mcp_servers"].get("docs").unwrap();
    assert_eq!(docs.get("enabled").unwrap().as_bool(), Some(true));
    assert_eq!(
        docs.get("startup_timeout_sec").unwrap().as_integer(),
        Some(10)
    );
    assert_eq!(docs.get("tool_timeout_sec").unwrap().as_integer(), Some(30));
}

#[test]
fn dynamic_codex_headers_report_same_endpoint_in_both_directions_without_exposure() {
    let t = tempdir().unwrap();
    let codex = t.path().join("codex.toml");
    let claude = t.path().join("claude.json");
    let claude_new = t.path().join("claude-new.json");
    fs::write(
        &codex,
        "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\nhttp_headers_helper = \"fixture-secret\"\n",
    )
    .unwrap();
    json_file(
        &claude,
        json!({"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"static"}}}}),
    );
    let locations = vec![
        loc("codex", &codex, "global"),
        loc("claude", &claude, "global"),
        loc("claude-new", &claude_new, "global"),
    ];
    let overview = scan(&locations);
    let entry = overview
        .entries
        .iter()
        .find(|entry| entry.source_id == "codex")
        .unwrap();
    assert_eq!(
        entry.reason.as_deref(),
        Some("动态请求头 http_headers_helper，无法静态比较/跨工具迁移")
    );
    assert_eq!(entry.cells[1].state, McpCellState::SameEndpoint);
    assert_eq!(
        entry.cells[1].reason.as_deref(),
        Some("同一 HTTP URL；动态请求头无法静态确认一致")
    );
    assert_eq!(
        cell(&overview, "claude", "codex").state,
        McpCellState::SameEndpoint
    );
    assert_eq!(
        cell(&overview, "claude", "codex").reason.as_deref(),
        Some("同一 HTTP URL；动态请求头无法静态确认一致")
    );
    let source_plan = prepare(&locations, &[sel("codex", "search", "claude-new")]);
    assert!(source_plan.actions.is_empty());
    assert!(source_plan
        .issues
        .iter()
        .any(|issue| issue.message.contains("http_headers_helper")));
    let plan = prepare(&locations, &[sel("claude", "search", "codex")]);
    assert!(plan.actions.is_empty());
    assert!(plan
        .issues
        .iter()
        .any(|issue| issue.message.contains("http_headers_helper")));
    assert!(!serde_json::to_string(&overview)
        .unwrap()
        .contains("fixture-secret"));
}

#[test]
fn dynamic_codex_headers_with_different_urls_are_a_conflict() {
    let t = tempdir().unwrap();
    let codex = t.path().join("codex.toml");
    let claude = t.path().join("claude.json");
    fs::write(
        &codex,
        "[mcp_servers.search]\nurl = \"https://one.example.test/mcp\"\nhttp_headers_helper = \"fixture-secret\"\n",
    )
    .unwrap();
    json_file(
        &claude,
        json!({"mcpServers":{"search":{"type":"http","url":"https://two.example.test/mcp"}}}),
    );
    let overview = scan(&[
        loc("codex", &codex, "global"),
        loc("claude", &claude, "global"),
    ]);
    for (source, target) in [("codex", "claude"), ("claude", "codex")] {
        let result = cell(&overview, source, target);
        assert_eq!(result.state, McpCellState::Conflict);
        assert_eq!(result.reason.as_deref(), Some("URL 不同"));
    }
}

#[test]
fn dynamic_helper_with_other_invalid_fields_remains_unsupported() {
    for extra in ["unknown = true", "http_headers = 1"] {
        let t = tempdir().unwrap();
        let codex = t.path().join("codex.toml");
        let claude = t.path().join("claude.json");
        fs::write(
            &codex,
            format!(
                "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\nhttp_headers_helper = \"fixture-secret\"\n{extra}\n"
            ),
        )
        .unwrap();
        json_file(
            &claude,
            json!({"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp"}}}),
        );
        let overview = scan(&[
            loc("codex", &codex, "global"),
            loc("claude", &claude, "global"),
        ]);
        assert_eq!(
            cell(&overview, "codex", "claude").state,
            McpCellState::Unsupported
        );
        assert_eq!(
            cell(&overview, "claude", "codex").state,
            McpCellState::Unsupported
        );
        assert!(!serde_json::to_string(&overview)
            .unwrap()
            .contains("fixture-secret"));
    }
}

#[test]
fn dynamic_helper_must_be_a_nonempty_string() {
    for helper in ["5", "\"\"", "\"   \""] {
        let t = tempdir().unwrap();
        let codex = t.path().join("codex.toml");
        let claude = t.path().join("claude.json");
        fs::write(
            &codex,
            format!(
                "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\nhttp_headers_helper = {helper}\n"
            ),
        )
        .unwrap();
        json_file(
            &claude,
            json!({"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp"}}}),
        );
        let overview = scan(&[
            loc("codex", &codex, "global"),
            loc("claude", &claude, "global"),
        ]);
        assert_eq!(
            cell(&overview, "codex", "claude").state,
            McpCellState::Unsupported
        );
        assert_eq!(
            cell(&overview, "claude", "codex").state,
            McpCellState::Unsupported
        );
    }
}

#[test]
fn static_http_headers_compare_case_insensitively_but_reject_folded_duplicates() {
    let t = tempdir().unwrap();
    let codex = t.path().join("codex.toml");
    let claude = t.path().join("claude.json");
    fs::write(
        &codex,
        "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\nhttp_headers = { Authorization = \"Bearer token\" }\n",
    )
    .unwrap();
    json_file(
        &claude,
        json!({"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp","headers":{"authorization":"Bearer token"}}}}),
    );
    let overview = scan(&[
        loc("codex", &codex, "global"),
        loc("claude", &claude, "global"),
    ]);
    assert_eq!(
        cell(&overview, "codex", "claude").state,
        McpCellState::Equal
    );

    json_file(
        &claude,
        json!({"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"one","authorization":"two"}}}}),
    );
    let overview = scan(&[
        loc("codex", &codex, "global"),
        loc("claude", &claude, "global"),
    ]);
    assert_eq!(
        cell(&overview, "claude", "codex").state,
        McpCellState::Unsupported
    );
}

#[test]
fn non_string_fields_and_references_are_rejected() {
    let cases = [
        json!({"command":"x","args":[1]}),
        json!({"command":"x","args":["${ARG}"]}),
        json!({"command":"x","env":{"KEY":1}}),
        json!({"command":"x","env":{"KEY":"${TOKEN}"}}),
        json!({"command":"${COMMAND}"}),
        json!({"command":"x","url":"https://example.test"}),
    ];
    for server in cases {
        let t = tempdir().unwrap();
        let source_path = t.path().join("source.json");
        let target_path = t.path().join("target.json");
        json_file(&source_path, json!({"mcpServers":{"bad":server}}));
        let locations = vec![
            loc("source", &source_path, "global"),
            loc("target", &target_path, "global"),
        ];
        let plan = prepare(&locations, &[sel("source", "bad", "target")]);
        assert!(plan.actions.is_empty());
        assert!(!plan.issues.is_empty());
        assert!(!target_path.exists());
    }
}

#[test]
fn invalid_root_and_servers_are_not_reported_missing() {
    let t = tempdir().unwrap();
    let root = t.path().join("root.json");
    let servers = t.path().join("servers.json");
    fs::write(&root, "[]").unwrap();
    fs::write(&servers, r#"{"mcpServers": []}"#).unwrap();
    let overview = scan(&[
        loc("root", &root, "global"),
        loc("servers", &servers, "global"),
    ]);
    assert!(overview.issues.iter().any(|i| i.location_id == "root"));
    assert!(overview.issues.iter().any(|i| i.location_id == "servers"));
}

#[test]
fn changing_source_or_target_after_preview_blocks_execution() {
    for change_source in [true, false] {
        let t = tempdir().unwrap();
        let source = t.path().join("source.json");
        let target = t.path().join("target.json");
        json_file(&source, json!({"mcpServers":{"docs":{"command":"docs"}}}));
        let locations = vec![
            loc("source", &source, "global"),
            loc("target", &target, "global"),
        ];
        let plan = prepare(&locations, &[sel("source", "docs", "target")]);
        if change_source {
            json_file(
                &source,
                json!({"mcpServers":{"docs":{"command":"changed"}}}),
            );
        } else {
            fs::write(&target, br#"{"other":true}"#).unwrap();
        }
        let report = execute(plan, false);
        assert_eq!(report.entries[0].outcome, "failed");
        if !change_source {
            assert_eq!(fs::read(target).unwrap(), br#"{"other":true}"#);
        }
    }
}

#[cfg(unix)]
#[test]
fn repeated_rounds_succeed_with_unique_backups_and_mode() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let target = t.path().join("target.json");
    json_file(
        &source,
        json!({"mcpServers":{"one":{"command":"one"},"two":{"command":"two"}}}),
    );
    fs::write(&target, br#"{"mcpServers":{}}"#).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    let locations = vec![
        loc("source", &source, "global"),
        loc("target", &target, "global"),
    ];
    let first_original = fs::read(&target).unwrap();
    let first = execute(
        prepare(&locations, &[sel("source", "one", "target")]),
        false,
    );
    assert_eq!(first.entries[0].outcome, "created");
    let first_backup = first.entries[0].backup_path.clone().unwrap();
    assert_eq!(fs::read(&first_backup).unwrap(), first_original);
    let second_original = fs::read(&target).unwrap();
    let second = execute(
        prepare(&locations, &[sel("source", "two", "target")]),
        false,
    );
    assert_eq!(second.entries[0].outcome, "created");
    let second_backup = second.entries[0].backup_path.clone().unwrap();
    assert_ne!(first_backup, second_backup);
    assert_eq!(fs::read(&second_backup).unwrap(), second_original);
    for backup in [first_backup, second_backup] {
        assert_eq!(
            fs::metadata(backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn symlink_file_is_rejected_without_touching_real_file() {
    let t = tempdir().unwrap();
    let real_source = t.path().join("real-source.json");
    let source = t.path().join("source.json");
    let real_target = t.path().join("real-target.json");
    let target = t.path().join("target.json");
    json_file(&real_source, json!({"mcpServers":{"x":{"command":"x"}}}));
    json_file(&real_target, json!({"mcpServers":{}}));
    std::os::unix::fs::symlink(&real_source, &source).unwrap();
    std::os::unix::fs::symlink(&real_target, &target).unwrap();
    let before = fs::read(&real_target).unwrap();
    let plan = prepare(
        &[
            loc("source", &source, "global"),
            loc("target", &target, "global"),
        ],
        &[sel("source", "x", "target")],
    );
    assert!(plan.actions.is_empty());
    assert!(!plan.issues.is_empty());
    assert_eq!(fs::read(real_target).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn symlink_parent_is_rejected_without_touching_real_file() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let real_dir = t.path().join("real");
    let link_dir = t.path().join("link");
    fs::create_dir(&real_dir).unwrap();
    json_file(&source, json!({"mcpServers":{"x":{"command":"x"}}}));
    std::os::unix::fs::symlink(&real_dir, &link_dir).unwrap();
    let target = link_dir.join("target.json");
    let locations = vec![
        loc("source", &source, "global"),
        loc("target", &target, "global"),
    ];
    let plan = prepare(&locations, &[sel("source", "x", "target")]);
    assert!(plan.actions.is_empty());
    assert!(!plan.issues.is_empty());
    assert!(!real_dir.join("target.json").exists());
}

#[test]
fn same_target_name_from_two_sources_cannot_choose_arbitrarily() {
    let t = tempdir().unwrap();
    let a = t.path().join("a.json");
    let b = t.path().join("b.json");
    let target = t.path().join("target.json");
    json_file(&a, json!({"mcpServers":{"same":{"command":"a"}}}));
    json_file(&b, json!({"mcpServers":{"same":{"command":"b"}}}));
    json_file(&target, json!({"mcpServers":{"same":{"command":"target"}}}));
    let before = fs::read(&target).unwrap();
    let locations = vec![
        loc("a", &a, "global"),
        loc("b", &b, "global"),
        loc("target", &target, "global"),
    ];
    let plan = prepare(
        &locations,
        &[sel("a", "same", "target"), sel("b", "same", "target")],
    );
    assert!(plan.actions.is_empty());
    assert!(!plan.issues.is_empty());
    assert_eq!(fs::read(target).unwrap(), before);
}

#[test]
fn scan_and_preview_do_not_serialize_fixture_secret() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let target = t.path().join("target.json");
    json_file(
        &source,
        json!({"mcpServers":{"private":{"command":"run","env":{"TOKEN":"fixture-secret"}}}}),
    );
    let locations = vec![
        loc("source", &source, "global"),
        loc("target", &target, "project"),
    ];
    assert!(!serde_json::to_string(&scan(&locations))
        .unwrap()
        .contains("fixture-secret"));
    let plan = prepare(&locations, &[sel("source", "private", "target")]);
    assert!(
        !serde_json::to_string(&json!({"actions":plan.actions,"issues":plan.issues}))
            .unwrap()
            .contains("fixture-secret")
    );
}

#[test]
fn duplicate_escaped_json_keys_are_rejected() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let target = t.path().join("target.json");
    fs::write(
        &source,
        br#"{"mcpServers":{"x":{"command":"a","command":"b"}}}"#,
    )
    .unwrap();
    let locations = vec![
        loc("source", &source, "global"),
        loc("target", &target, "global"),
    ];
    let plan = prepare(&locations, &[sel("source", "x", "target")]);
    assert!(plan.actions.is_empty());
    assert!(!plan.issues.is_empty());
}

#[test]
fn any_public_field_difference_is_conflict_and_preserves_target_bytes() {
    let variants = [
        json!({"command":"run","args":["--other"]}),
        json!({"command":"run","env":{"KEY":"other"}}),
        json!({"type":"http","url":"https://other.test","headers":{"X":"other"}}),
    ];
    for target_definition in variants {
        let t = tempdir().unwrap();
        let source = t.path().join("source.json");
        let target = t.path().join("target.json");
        json_file(
            &source,
            json!({"mcpServers":{"same":{"command":"run","args":["--ok"],"env":{"KEY":"value"}}}}),
        );
        json_file(&target, json!({"mcpServers":{"same":target_definition}}));
        let before = fs::read(&target).unwrap();
        let locations = vec![
            loc("source", &source, "global"),
            loc("target", &target, "global"),
        ];
        let plan = prepare(&locations, &[sel("source", "same", "target")]);
        assert!(plan.actions.is_empty());
        assert!(!plan.issues.is_empty());
        assert_eq!(fs::read(target).unwrap(), before);
    }
}

#[test]
fn claude_local_is_discovered_as_its_own_scope_without_a_missing_project_column() {
    let t = tempdir().unwrap();
    let home = t.path().join("home");
    let cardbox = t.path().join("CardBox");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cardbox).unwrap();
    let cardbox = fs::canonicalize(cardbox).unwrap();
    let cardbox_key = cardbox.to_string_lossy();
    fs::write(
        home.join(".claude.json"),
        format!(
            r#"{{"mcpServers":{{"excalidraw":{{"command":"user-only"}}}},"projects":{{"{cardbox_key}":{{"mcpServers":{{"dingtalk-doc":{{"type":"http","url":"https://docs.test/mcp"}},"dingtalk-sheet":{{"type":"http","url":"https://sheet.test/mcp"}}}}}}}}}}"#
        ),
    )
    .unwrap();
    let env = Env {
        home: fs::canonicalize(&home).unwrap(),
        vars: HashMap::new(),
    };
    let locations =
        symsync_core::mcp::locations(&env, &[claude_harness()], std::slice::from_ref(&cardbox));
    let local = locations
        .iter()
        .find(|location| location.id.ends_with("claude-code:local"))
        .expect("CardBox Local MCPs must be found");
    assert_eq!(local.selector.as_deref(), Some(cardbox_key.as_ref()));
    assert_eq!(local.label, "Claude Code · Local MCPs");
    let project = locations
        .iter()
        .find(|location| {
            location.harness_id == "claude-code"
                && location.selector.is_none()
                && location.domain.starts_with("project:")
                && location.path == cardbox.join(".mcp.json")
        })
        .expect("missing Project MCP file must remain an explicit import target");
    assert!(project.matrix_hidden);
    assert_eq!(project.label, "Claude Code · Project MCPs");
    let overview = scan(&locations);
    assert!(overview
        .entries
        .iter()
        .any(|entry| entry.source_id == local.id && entry.name == "dingtalk-doc"));
    assert!(overview
        .entries
        .iter()
        .any(|entry| { entry.source_id == "claude-code" && entry.name == "excalidraw" }));
    assert!(!overview
        .entries
        .iter()
        .any(|entry| { entry.source_id == "claude-code" && entry.name == "dingtalk-doc" }));
    let plan = prepare(&locations, &[sel(&local.id, "dingtalk-doc", &project.id)]);
    assert!(plan.issues.is_empty());
    assert_eq!(plan.actions.len(), 1);
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "created");
    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(cardbox.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["dingtalk-doc"]["url"],
        "https://docs.test/mcp"
    );
}

#[test]
fn empty_claude_local_is_hidden_but_remains_an_import_target() {
    let t = tempdir().unwrap();
    let home = t.path().join("home");
    let project = t.path().join("weibo_assistant");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&project).unwrap();
    let project = fs::canonicalize(project).unwrap();
    let project_key = project.to_string_lossy();
    fs::write(
        home.join(".claude.json"),
        format!(r#"{{"projects":{{"{project_key}":{{"mcpServers":{{}}}}}}}}"#),
    )
    .unwrap();
    json_file(
        &project.join(".mcp.json"),
        json!({"mcpServers":{"weibo-search":{"command":"search"}}}),
    );
    let env = Env {
        home: fs::canonicalize(&home).unwrap(),
        vars: HashMap::new(),
    };
    let locations =
        symsync_core::mcp::locations(&env, &[claude_harness()], std::slice::from_ref(&project));
    let local = locations
        .iter()
        .find(|location| location.selector.as_deref() == Some(project_key.as_ref()))
        .expect("empty Local MCPs must remain an explicit import target");
    let shared = locations
        .iter()
        .find(|location| location.selector.is_none() && location.path == project.join(".mcp.json"))
        .expect("Project MCPs must remain visible when Local has no definitions");
    assert!(local.matrix_hidden);
    assert!(!shared.matrix_hidden);

    let plan = prepare(&locations, &[sel(&shared.id, "weibo-search", &local.id)]);
    assert!(plan.issues.is_empty());
    assert_eq!(plan.actions.len(), 1);
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "created");
    let written: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(
        written["projects"][project_key.as_ref()]["mcpServers"]["weibo-search"]["command"],
        "search"
    );
}

#[test]
fn claude_local_and_project_mcp_remain_separate_when_both_exist() {
    let t = tempdir().unwrap();
    let home = t.path().join("home");
    let cardbox = t.path().join("CardBox");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cardbox).unwrap();
    let cardbox_key = cardbox.to_string_lossy();
    fs::write(
        home.join(".claude.json"),
        format!(
            r#"{{"projects":{{"{cardbox_key}":{{"mcpServers":{{"dingtalk-doc":{{"type":"http","url":"https://docs.test/mcp"}}}}}}}}}}"#
        ),
    )
    .unwrap();
    json_file(
        &cardbox.join(".mcp.json"),
        json!({"mcpServers":{"shared-doc":{"command":"shared"}}}),
    );
    let env = Env {
        home: fs::canonicalize(&home).unwrap(),
        vars: HashMap::new(),
    };
    let locations =
        symsync_core::mcp::locations(&env, &[claude_harness()], std::slice::from_ref(&cardbox));
    let scopes: Vec<_> = locations
        .iter()
        .filter(|location| location.harness_id == "claude-code")
        .filter(|location| location.domain.starts_with("project:"))
        .collect();
    assert_eq!(scopes.len(), 2);
    let local = scopes
        .iter()
        .find(|location| location.selector.as_deref() == Some(cardbox_key.as_ref()))
        .expect("exact Claude project key must select Local MCPs");
    let shared = scopes
        .iter()
        .find(|location| location.selector.is_none() && location.path == cardbox.join(".mcp.json"))
        .expect("existing .mcp.json must remain a distinct Project MCP scope");
    assert_eq!(local.domain, shared.domain);
    assert!(!local.matrix_hidden);
    assert!(!shared.matrix_hidden);
    let overview = scan(&locations);
    assert!(overview
        .entries
        .iter()
        .any(|entry| entry.name == "dingtalk-doc"));
    assert!(overview
        .entries
        .iter()
        .any(|entry| entry.name == "shared-doc"));
}

#[test]
fn claude_local_write_preserves_other_scopes_and_rechecks_the_full_file() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let claude = t.path().join(".claude.json");
    let cardbox = t.path().join("CardBox");
    let other = t.path().join("Other");
    fs::create_dir_all(&cardbox).unwrap();
    fs::create_dir_all(&other).unwrap();
    let cardbox_key = cardbox.to_string_lossy().into_owned();
    let other_key = other.to_string_lossy().into_owned();
    json_file(
        &source,
        json!({"mcpServers":{"dingtalk-doc":{"type":"http","url":"https://docs.test/mcp"}}}),
    );
    let original = format!(
        "{{\n  \"mcpServers\": {{ \"user\": {{ \"command\": \"keep\" }} }},\n  \"projects\": {{\n    \"{cardbox_key}\": {{ \"unknown\": [ 1,  2 ] }},\n    \"{other_key}\": {{ \"mcpServers\": {{ \"other\": {{ \"command\": \"stay\" }} }} }}\n  }},\n  \"rootUnknown\": {{ \"keep\": true }}\n}}\n"
    );
    fs::write(&claude, &original).unwrap();
    let locations = vec![
        loc("source", &source, "project:cardbox"),
        claude_local("local", &claude, "project:cardbox", &cardbox_key),
    ];
    let plan = prepare(&locations, &[sel("source", "dingtalk-doc", "local")]);
    assert!(plan.issues.is_empty());
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "created");
    let backup = report.entries[0].backup_path.as_ref().unwrap();
    assert_eq!(fs::read_to_string(backup).unwrap(), original);
    let written = fs::read_to_string(&claude).unwrap();
    assert!(written.contains("\"unknown\": [ 1,  2 ]"));
    assert!(written.contains("\"other\": { \"command\": \"stay\" }"));
    assert!(written.contains("\"rootUnknown\": { \"keep\": true }"));
    let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(parsed["mcpServers"]["user"]["command"], "keep");
    assert_eq!(
        parsed["projects"][&cardbox_key]["mcpServers"]["dingtalk-doc"]["url"],
        "https://docs.test/mcp"
    );

    let plan = prepare(
        &[
            loc("source", &source, "project:cardbox"),
            claude_local("local", &claude, "project:cardbox", &cardbox_key),
        ],
        &[sel("source", "dingtalk-doc", "local")],
    );
    assert!(
        plan.actions.is_empty(),
        "existing local definition cannot be overwritten"
    );
}

#[test]
fn one_claude_file_batch_merges_user_and_two_local_scopes_once() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let claude = t.path().join(".claude.json");
    let first = t.path().join("First");
    let second = t.path().join("Second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    let first_key = first.to_string_lossy().into_owned();
    let second_key = second.to_string_lossy().into_owned();
    json_file(
        &source,
        json!({"mcpServers":{
            "user-doc":{"command":"user-doc"},
            "first-doc":{"command":"first-doc"},
            "second-doc":{"command":"second-doc"}
        }}),
    );
    let original =
        format!("{{\"projects\":{{\"{first_key}\":{{}},\"{second_key}\":{{}}}},\"keep\":true}}");
    fs::write(&claude, &original).unwrap();
    let locations = vec![
        loc("source", &source, "global"),
        loc("user", &claude, "global"),
        claude_local("first", &claude, "project:first", &first_key),
        claude_local("second", &claude, "project:second", &second_key),
    ];
    let report = execute(
        prepare(
            &locations,
            &[
                sel("source", "user-doc", "user"),
                sel("source", "first-doc", "first"),
                sel("source", "second-doc", "second"),
            ],
        ),
        true,
    );
    assert!(report
        .entries
        .iter()
        .all(|entry| entry.outcome == "created"));
    assert_eq!(
        report
            .entries
            .iter()
            .filter(|entry| entry.backup_path.is_some())
            .count(),
        1
    );
    let parsed: serde_json::Value = serde_json::from_slice(&fs::read(&claude).unwrap()).unwrap();
    assert_eq!(parsed["mcpServers"]["user-doc"]["command"], "user-doc");
    assert_eq!(
        parsed["projects"][&first_key]["mcpServers"]["first-doc"]["command"],
        "first-doc"
    );
    assert_eq!(
        parsed["projects"][&second_key]["mcpServers"]["second-doc"]["command"],
        "second-doc"
    );
    assert_eq!(parsed["keep"], true);
}

#[test]
fn invalid_claude_local_container_is_invalid_not_missing() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let claude = t.path().join(".claude.json");
    json_file(&source, json!({"mcpServers":{"docs":{"command":"docs"}}}));
    fs::write(&claude, br#"{"projects":{"/CardBox":[]}}"#).unwrap();
    let locations = vec![
        loc("source", &source, "project:cardbox"),
        claude_local("local", &claude, "project:cardbox", "/CardBox"),
    ];
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "source", "local").state,
        McpCellState::Invalid
    );
    assert!(prepare(&locations, &[sel("source", "docs", "local")])
        .actions
        .is_empty());
}

#[test]
fn changed_claude_local_target_after_preview_is_never_written() {
    let t = tempdir().unwrap();
    let source = t.path().join("source.json");
    let claude = t.path().join(".claude.json");
    let project = t.path().join("CardBox");
    fs::create_dir_all(&project).unwrap();
    let project_key = project.to_string_lossy().into_owned();
    json_file(&source, json!({"mcpServers":{"docs":{"command":"docs"}}}));
    fs::write(
        &claude,
        format!(r#"{{"projects":{{"{project_key}":{{}}}}}}"#),
    )
    .unwrap();
    let locations = vec![
        loc("source", &source, "project:cardbox"),
        claude_local("local", &claude, "project:cardbox", &project_key),
    ];
    let plan = prepare(&locations, &[sel("source", "docs", "local")]);
    fs::write(
        &claude,
        format!(r#"{{"projects":{{"{project_key}":{{"mcpServers":{{"external":{{"command":"keep"}}}}}}}}}}"#),
    )
    .unwrap();
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "failed");
    let parsed: serde_json::Value = serde_json::from_slice(&fs::read(&claude).unwrap()).unwrap();
    assert!(parsed["projects"][&project_key]["mcpServers"]
        .get("docs")
        .is_none());
    assert_eq!(
        parsed["projects"][&project_key]["mcpServers"]["external"]["command"],
        "keep"
    );
}

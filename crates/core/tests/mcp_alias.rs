use serde_json::json;
use std::fs;
use std::path::Path;
use symsync_core::mcp::{execute, prepare, McpLocation, McpSelection};
use tempfile::tempdir;

fn location(id: &str, path: &Path, domain: &str) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: "cursor".into(),
        domain: domain.into(),
        path: path.into(),
        selector: None,
        matrix_hidden: false,
    }
}

fn selection(source_id: &str, name: &str, target_id: &str) -> McpSelection {
    McpSelection {
        source_id: source_id.into(),
        name: name.into(),
        target_id: target_id.into(),
    }
}

fn json_file(path: &Path, value: serde_json::Value) {
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn aliases_of_one_json_target_write_one_server_once() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source = root.join("source.json");
    let target = root.join("target.json");
    json_file(
        &source,
        json!({"mcpServers":{"docs":{"command":"run-docs"}}}),
    );
    json_file(&target, json!({"mcpServers":{}}));
    let locations = vec![
        location("source", &source, "global"),
        location("target-a", &target, "global"),
        location("target-b", &root.join("./target.json"), "global"),
    ];

    let plan = prepare(
        &locations,
        &[
            selection("source", "docs", "target-a"),
            selection("source", "docs", "target-b"),
        ],
    );
    assert!(plan.issues.is_empty());
    assert_eq!(plan.actions.len(), 1);
    let report = execute(plan, false);
    assert_eq!(report.entries.len(), 1);
    assert_eq!(report.entries[0].outcome, "created");
    let written = fs::read_to_string(target).unwrap();
    assert_eq!(written.matches("\"docs\"").count(), 1);
    let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(parsed["mcpServers"]["docs"]["command"], "run-docs");
}

#[test]
fn aliases_with_conflicting_sources_leave_target_unchanged() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source_a = root.join("source-a.json");
    let source_b = root.join("source-b.json");
    let target = root.join("target.json");
    json_file(&source_a, json!({"mcpServers":{"docs":{"command":"one"}}}));
    json_file(&source_b, json!({"mcpServers":{"docs":{"command":"two"}}}));
    let original = b"{\n  \"mcpServers\": {},\n  \"keep\": true\n}\n";
    fs::write(&target, original).unwrap();
    let locations = vec![
        location("source-a", &source_a, "global"),
        location("source-b", &source_b, "global"),
        location("target-a", &target, "global"),
        location("target-b", &root.join("./target.json"), "global"),
    ];

    let plan = prepare(
        &locations,
        &[
            selection("source-a", "docs", "target-a"),
            selection("source-b", "docs", "target-b"),
        ],
    );
    assert!(plan.actions.is_empty());
    assert_eq!(plan.issues.len(), 1);
    assert!(execute(plan, false).entries.is_empty());
    assert_eq!(fs::read(target).unwrap(), original);
}

#[test]
fn aliases_still_verify_the_selected_source_snapshot() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source = root.join("source.json");
    let target = root.join("target.json");
    json_file(&source, json!({"mcpServers":{"docs":{"command":"docs"}}}));
    let original = b"{\"mcpServers\":{}}";
    fs::write(&target, original).unwrap();
    let locations = vec![
        location("source", &source, "global"),
        location("target-a", &target, "global"),
        location("target-b", &root.join("./target.json"), "global"),
    ];

    let plan = prepare(
        &locations,
        &[
            selection("source", "docs", "target-a"),
            selection("source", "docs", "target-b"),
        ],
    );
    json_file(
        &source,
        json!({"mcpServers":{"docs":{"command":"changed"}}}),
    );
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "failed");
    assert_eq!(report.entries[0].message, "配置在预览后发生变化");
    assert_eq!(fs::read(target).unwrap(), original);
}

#[test]
fn aliased_cross_domain_target_requires_confirmation() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source = root.join("source.json");
    let target = root.join("target.json");
    json_file(&source, json!({"mcpServers":{"docs":{"command":"docs"}}}));
    let original = b"{\"mcpServers\":{}}";
    fs::write(&target, original).unwrap();
    let locations = vec![
        location("source", &source, "global"),
        location("target-global", &target, "global"),
        location(
            "target-project",
            &root.join("./target.json"),
            "project:/example",
        ),
    ];

    let plan = prepare(
        &locations,
        &[
            selection("source", "docs", "target-global"),
            selection("source", "docs", "target-project"),
        ],
    );
    assert_eq!(plan.actions.len(), 1);
    assert!(plan.actions[0].cross_domain);
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "failed");
    assert_eq!(report.entries[0].message, "跨域同步未获允许");
    assert_eq!(fs::read(target).unwrap(), original);
}

#[test]
fn different_servers_for_one_aliased_target_merge_together() {
    let temp = tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    let source = root.join("source.json");
    let target = root.join("target.json");
    json_file(
        &source,
        json!({"mcpServers":{"one":{"command":"one"},"two":{"command":"two"}}}),
    );
    json_file(&target, json!({"mcpServers":{}}));
    let locations = vec![
        location("source", &source, "global"),
        location("target-a", &target, "global"),
        location("target-b", &root.join("./target.json"), "global"),
    ];

    let plan = prepare(
        &locations,
        &[
            selection("source", "one", "target-a"),
            selection("source", "two", "target-b"),
        ],
    );
    assert_eq!(plan.actions.len(), 2);
    let report = execute(plan, false);
    assert!(report
        .entries
        .iter()
        .all(|entry| entry.outcome == "created"));
    let parsed: serde_json::Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
    assert_eq!(parsed["mcpServers"].as_object().unwrap().len(), 2);
    assert!(parsed["mcpServers"].get("one").is_some());
    assert!(parsed["mcpServers"].get("two").is_some());
}

//! 待处理页「看两边差在哪」：字段级差异只读、只列不同、凭据不出 core
use serde_json::json;
use std::fs;
use std::path::Path;
use symsync_core::mcp::{diff_fields, McpFieldValue, McpLocation};
use tempfile::tempdir;

fn loc(id: &str, path: &Path, harness_id: &str) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: harness_id.into(),
        domain: "global".into(),
        path: path.to_path_buf(),
        selector: None,
        matrix_hidden: false,
    }
}

fn plain(text: &str) -> McpFieldValue {
    McpFieldValue::Plain { text: text.into() }
}

#[test]
fn lists_only_differing_fields_and_masks_secrets() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let a = root.join("a.json");
    let b = root.join("b.json");
    fs::write(
        &a,
        serde_json::to_vec(&json!({"mcpServers":{"notion":{"type":"http",
            "url":"https://mcp.notion.com/mcp?api_key=sk-live-aaaa1111",
            "headers":{"Authorization":"Bearer secret-token-a91f","X-Same":"same"}}}}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        &b,
        serde_json::to_vec(&json!({"mcpServers":{"notion":{"type":"http",
            "url":"https://mcp.notion.com/sse",
            "headers":{"authorization":"Bearer secret-token-7c02","X-Same":"same"}}}}))
        .unwrap(),
    )
    .unwrap();
    let before_a = fs::read(&a).unwrap();
    let locations = vec![loc("A", &a, "claude-code"), loc("B", &b, "cursor")];

    let diff = diff_fields(&locations, "notion", &["A".into(), "B".into()]);

    assert!(!diff.dynamic_auth);
    assert!(diff.unreadable.is_empty());
    let fields: Vec<&str> = diff.fields.iter().map(|f| f.field.as_str()).collect();
    // 相同的 transport、X-Same 不列；请求头名大小写不敏感，只算一个字段
    assert_eq!(fields, vec!["url", "headers.Authorization"]);
    assert_eq!(
        diff.fields[0].values,
        vec![
            plain("https://mcp.notion.com/mcp?api_key=…"),
            plain("https://mcp.notion.com/sse")
        ]
    );
    assert_eq!(
        diff.fields[1].values,
        vec![
            McpFieldValue::Secret {
                last4: Some("a91f".into())
            },
            McpFieldValue::Secret {
                last4: Some("7c02".into())
            },
        ]
    );
    // DTO 里不含任何凭据原文
    let wire = serde_json::to_string(&diff).unwrap();
    assert!(!wire.contains("secret-token") && !wire.contains("sk-live"));
    // 只读
    assert_eq!(fs::read(&a).unwrap(), before_a);
}

#[test]
fn env_and_args_secrets_short_values_and_missing_locations() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let a = root.join("a.json");
    let b = root.join("config.toml");
    fs::write(
        &a,
        serde_json::to_vec(&json!({"mcpServers":{"gh":{"command":"npx",
            "args":["gh-mcp","--token","abcdef123456"],
            "env":{"PIN":"1234","REF":"${GH_TOKEN}"}}}}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        &b,
        "[mcp_servers.gh]\ncommand = \"npx\"\nargs = [\"gh-mcp\", \"--token\", \"zzzzzz999999\"]\nenv = { PIN = \"9876\" }\n",
    )
    .unwrap();
    let locations = vec![loc("A", &a, "claude-code"), loc("B", &b, "codex")];

    let diff = diff_fields(&locations, "gh", &["A".into(), "B".into(), "gone".into()]);

    assert_eq!(diff.unreadable, vec!["gone".to_string()]);
    let field = |name: &str| diff.fields.iter().find(|f| f.field == name).unwrap();
    // 参数里跟在 --token 后面的值不显示
    assert_eq!(field("args").values[0], plain("gh-mcp --token …"));
    // 太短的凭据连末 4 位也不给
    assert_eq!(
        field("env.PIN").values[0],
        McpFieldValue::Secret { last4: None }
    );
    // 引用不是凭据，原样给；另一边没有这个字段
    assert_eq!(field("env.REF").values[0], plain("${GH_TOKEN}"));
    assert_eq!(field("env.REF").values[1], McpFieldValue::Absent);
    assert!(diff.fields.iter().all(|f| f.field != "command"));
}

#[test]
fn dynamic_auth_headers_are_not_compared() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let a = root.join("config.toml");
    let b = root.join("b.json");
    fs::write(
        &a,
        "[mcp_servers.search]\nurl = \"https://example.test/a\"\nhttp_headers_helper = \"fixture-secret\"\n",
    )
    .unwrap();
    fs::write(
        &b,
        serde_json::to_vec(&json!({"mcpServers":{"search":{"type":"http",
            "url":"https://example.test/b","headers":{"Authorization":"static-value-xyz"}}}}))
        .unwrap(),
    )
    .unwrap();
    let locations = vec![loc("A", &a, "codex"), loc("B", &b, "claude-code")];

    let diff = diff_fields(&locations, "search", &["A".into(), "B".into()]);

    assert!(diff.dynamic_auth);
    assert!(diff.fields.iter().any(|f| f.field == "url"));
    assert!(diff.fields.iter().all(|f| !f.field.starts_with("headers.")));
    assert!(!serde_json::to_string(&diff)
        .unwrap()
        .contains("fixture-secret"));
}

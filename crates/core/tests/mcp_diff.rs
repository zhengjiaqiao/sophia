//! MCP「N 份不一样」就地展开：字段级差异只读、只列不同、凭据不出 core
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

/// 两份只有参数不同的 stdio 配置，返回 args 字段两边的显示值与整份 DTO 的序列化
fn args_diff(args_a: &[&str], args_b: &[&str]) -> (Vec<McpFieldValue>, String) {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let a = root.join("a.json");
    let b = root.join("b.json");
    for (path, args) in [(&a, args_a), (&b, args_b)] {
        fs::write(
            path,
            serde_json::to_vec(&json!({"mcpServers":{"remote":{"command":"npx","args":args}}}))
                .unwrap(),
        )
        .unwrap();
    }
    let locations = vec![loc("A", &a, "claude-code"), loc("B", &b, "cursor")];
    let diff = diff_fields(&locations, "remote", &["A".into(), "B".into()]);
    let values = diff
        .fields
        .iter()
        .find(|f| f.field == "args")
        .unwrap()
        .values
        .clone();
    (values, serde_json::to_string(&diff).unwrap())
}

#[test]
fn header_flag_values_in_args_are_masked() {
    let (values, wire) = args_diff(
        &[
            "mcp-remote",
            "https://mcp.example.test/sse",
            "--header",
            "Authorization: Bearer sk-live-aaaa1111bbbb",
        ],
        &[
            "mcp-remote",
            "https://mcp.example.test/sse",
            "-H",
            "Authorization: Bearer sk-live-cccc2222dddd",
        ],
    );
    assert_eq!(
        values,
        vec![
            plain("mcp-remote https://mcp.example.test/sse --header Authorization: …bbbb"),
            plain("mcp-remote https://mcp.example.test/sse -H Authorization: …dddd"),
        ]
    );
    // DTO 里不含任何凭据原文
    assert!(!wire.contains("sk-live") && !wire.contains("aaaa1111"));
}

#[test]
fn secret_named_header_args_and_bare_bearer_are_masked() {
    let (values, wire) = args_diff(
        &["mcp-remote", "X-Api-Key: xk-plain-4455667788"],
        &["mcp-remote", "Bearer tok-plain-99887766"],
    );
    assert_eq!(
        values,
        vec![
            plain("mcp-remote X-Api-Key: …7788"),
            plain("mcp-remote Bearer …7766"),
        ]
    );
    assert!(!wire.contains("xk-plain") && !wire.contains("tok-plain"));
}

#[test]
fn url_userinfo_is_masked() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let a = root.join("a.json");
    let b = root.join("b.json");
    fs::write(
        &a,
        serde_json::to_vec(&json!({"mcpServers":{"db":{"type":"http",
            "url":"https://admin:hunter2-pass@mcp.example.test/mcp?x=1"}}}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        &b,
        serde_json::to_vec(&json!({"mcpServers":{"db":{"type":"http",
            "url":"https://tokenuser@mcp.example.test/mcp"}}}))
        .unwrap(),
    )
    .unwrap();
    let locations = vec![loc("A", &a, "claude-code"), loc("B", &b, "cursor")];

    let diff = diff_fields(&locations, "db", &["A".into(), "B".into()]);

    let url = diff.fields.iter().find(|f| f.field == "url").unwrap();
    assert_eq!(
        url.values,
        vec![
            plain("https://…:…@mcp.example.test/mcp?x=…"),
            plain("https://…@mcp.example.test/mcp"),
        ]
    );
    let wire = serde_json::to_string(&diff).unwrap();
    assert!(!wire.contains("hunter2") && !wire.contains("admin") && !wire.contains("tokenuser"));
}

#[test]
fn concatenated_header_flag_is_masked() {
    let (values, wire) = args_diff(
        &[
            "mcp-remote",
            "-HAuthorization: Bearer sk-live-eeee3333=ffff",
        ],
        &["mcp-remote", "-HX-Api-Key: xk-glued-11223344"],
    );
    assert_eq!(
        values,
        vec![
            plain("mcp-remote -HAuthorization: …ffff"),
            plain("mcp-remote -HX-Api-Key: …3344"),
        ]
    );
    assert!(!wire.contains("sk-live") && !wire.contains("eeee3333") && !wire.contains("xk-glued"));
}

#[test]
fn url_fragment_values_are_masked() {
    let dir = tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let a = root.join("a.json");
    let b = root.join("b.json");
    fs::write(
        &a,
        serde_json::to_vec(&json!({"mcpServers":{"frag":{"type":"http",
            "url":"https://mcp.example.test/mcp?x=1#access_token=frag-secret-aaaa&state=frag-state-bbbb"}}}))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        &b,
        serde_json::to_vec(&json!({"mcpServers":{"frag":{"type":"http",
            "url":"https://mcp.example.test/mcp#token=frag-secret-cccc"}}}))
        .unwrap(),
    )
    .unwrap();
    let locations = vec![loc("A", &a, "claude-code"), loc("B", &b, "cursor")];

    let diff = diff_fields(&locations, "frag", &["A".into(), "B".into()]);

    let url = diff.fields.iter().find(|f| f.field == "url").unwrap();
    assert_eq!(
        url.values,
        vec![
            plain("https://mcp.example.test/mcp?x=…#access_token=…&state=…"),
            plain("https://mcp.example.test/mcp#token=…"),
        ]
    );
    let wire = serde_json::to_string(&diff).unwrap();
    assert!(!wire.contains("frag-secret") && !wire.contains("frag-state"));
}

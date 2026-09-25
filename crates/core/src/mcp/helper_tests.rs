//! 用命令生成请求头（Codex `http_headers_helper` ↔ Claude Code `headersHelper`）：
//! 两家之间照常互搬、写入换成目标的字段名、其余字节不动；写到别的 agent 按目标拒绝；
//! 命令字符串相同即相同，差异照常逐项列
use super::*;
use crate::test_support::TempTree;
use serde_json::json;

fn location(id: &str, label: &str, harness_id: &str, path: PathBuf) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: label.into(),
        harness_id: harness_id.into(),
        domain: "global".into(),
        path,
        selector: None,
        matrix_hidden: false,
    }
}

fn sel(source_id: &str, name: &str, target_id: &str) -> McpSelection {
    McpSelection {
        source_id: source_id.into(),
        name: name.into(),
        target_id: target_id.into(),
    }
}

fn cell<'a>(overview: &'a McpOverview, source: &str, name: &str, target: &str) -> &'a McpCell {
    overview
        .entries
        .iter()
        .find(|e| e.source_id == source && e.name == name)
        .unwrap()
        .cells
        .iter()
        .find(|c| c.target_id == target)
        .unwrap()
}

fn write_one(locations: &[McpLocation], selection: McpSelection) {
    let plan = prepare(locations, &[selection]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(plan.actions.len(), 1);
    let report = execute(plan, false);
    assert_eq!(report.entries[0].outcome, "created", "{:?}", report.entries);
}

/// `after` 只比 `before` 多了连续的一段（原有字节一个没动），返回多出来的那段
fn only_inserted(before: &[u8], after: &[u8]) -> String {
    let prefix = before.iter().zip(after).take_while(|(a, b)| a == b).count();
    let suffix = before[prefix..]
        .iter()
        .rev()
        .zip(after[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    assert_eq!(prefix + suffix, before.len(), "原有内容被改动了");
    String::from_utf8(after[prefix..after.len() - suffix].to_vec()).unwrap()
}

const HELPER: &str = "/opt/bin/mcp-headers.sh --json";

#[test]
fn codex_and_claude_round_trip_with_the_rest_byte_identical() {
    let t = TempTree::new();
    let root = t.root();
    let codex = root.join("config.toml");
    let claude = root.join(".claude.json");
    let codex_project = root.join("project-config.toml");
    // Codex 来源：带 BOM、CRLF、注释
    let codex_before = "\u{feff}# 我的配置\r\nmodel = \"gpt-5\"\r\n\r\n\
        [mcp_servers.search]\r\nurl = \"https://example.test/mcp\"\r\n\
        http_headers = { \"X-Team\" = \"core\" }\r\n\
        http_headers_helper = \"/opt/bin/mcp-headers.sh --json\"\r\n";
    fs::write(&codex, codex_before).unwrap();
    // Claude Code 目标：已有别的根字段和别的服务，排版随意
    let claude_before = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"old\": { \"command\": \"old\" }\n  },\n  \"tail\": [1, 2]\n}\n";
    fs::write(&claude, claude_before).unwrap();
    // 第二个 Codex 目标：末行没有换行
    let project_before = "# 项目\nmodel = \"o4\"";
    fs::write(&codex_project, project_before).unwrap();
    let locations = vec![
        location("codex", "Codex", "codex", codex.clone()),
        location(
            "claude",
            "Claude Code · User MCPs",
            "claude-code",
            claude.clone(),
        ),
        location("codex-project", "Codex", "codex", codex_project.clone()),
    ];

    let overview = scan(&locations);
    let entry = overview
        .entries
        .iter()
        .find(|e| e.source_id == "codex")
        .unwrap();
    assert_eq!(entry.reason, None);
    assert_eq!(
        entry.only_harnesses,
        Some(vec!["claude-code".to_string(), "codex".to_string()])
    );
    assert_eq!(
        cell(&overview, "codex", "search", "claude").state,
        McpCellState::Missing
    );

    // Codex → Claude Code：换成 headersHelper，带 "type": "http"
    write_one(&locations, sel("codex", "search", "claude"));
    let claude_after = fs::read(&claude).unwrap();
    let inserted = only_inserted(claude_before.as_bytes(), &claude_after);
    let member: Value = serde_json::from_str(&format!("{{{}}}", inserted.trim_start_matches(',')))
        .expect("插入的是一个完整成员");
    assert_eq!(
        member,
        json!({"search": {
            "type": "http",
            "url": "https://example.test/mcp",
            "headers": {"X-Team": "core"},
            "headersHelper": HELPER,
        }})
    );
    assert_eq!(
        fs::read_to_string(&codex).unwrap(),
        codex_before,
        "来源不动"
    );

    // 两边一样：命令字符串相同、静态请求头相同
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "codex", "search", "claude").state,
        McpCellState::Equal
    );
    assert_eq!(
        cell(&overview, "claude", "search", "codex").state,
        McpCellState::Equal
    );

    // Claude Code → Codex：从 Claude 那份读出 headersHelper，写成 http_headers_helper
    write_one(&locations, sel("claude", "search", "codex-project"));
    let project_after = fs::read(&codex_project).unwrap();
    let inserted = only_inserted(project_before.as_bytes(), &project_after);
    assert_eq!(
        inserted,
        "\n\n[mcp_servers.search]\nurl = \"https://example.test/mcp\"\n\
         http_headers = { X-Team = \"core\" }\n\
         http_headers_helper = \"/opt/bin/mcp-headers.sh --json\"\n"
    );
    let overview = scan(&locations);
    for (source, target) in [
        ("codex", "codex-project"),
        ("codex-project", "claude"),
        ("claude", "codex-project"),
    ] {
        assert_eq!(
            cell(&overview, source, "search", target).state,
            McpCellState::Equal,
            "{source} → {target}"
        );
    }
}

#[test]
fn claude_local_scope_reads_and_writes_headers_helper() {
    let t = TempTree::new();
    let root = t.root();
    let claude = root.join(".claude.json");
    let codex = root.join("config.toml");
    let claude_before = serde_json::to_string_pretty(&json!({
        "projects": {"/p": {"mcpServers": {"search": {
            "type": "http", "url": "https://example.test/mcp", "headersHelper": HELPER
        }}}, "/q": {"keep": true}}
    }))
    .unwrap();
    fs::write(&claude, &claude_before).unwrap();
    let mut local = location("local", "Claude Code · Local MCPs", "claude-code", claude);
    local.selector = Some("/p".into());
    let locations = vec![local, location("codex", "Codex", "codex", codex.clone())];

    write_one(&locations, sel("local", "search", "codex"));
    assert_eq!(
        fs::read_to_string(&codex).unwrap(),
        "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\n\
         http_headers_helper = \"/opt/bin/mcp-headers.sh --json\"\n"
    );
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "codex", "search", "local").state,
        McpCellState::Equal
    );

    // 反过来：写进 Local 作用域，只在 projects["/p"].mcpServers 里补一个成员
    fs::write(
        &codex,
        "[mcp_servers.other]\nurl = \"https://example.test/other\"\nhttp_headers_helper = \"get-other\"\n",
    )
    .unwrap();
    write_one(&locations, sel("codex", "other", "local"));
    let inserted = only_inserted(
        claude_before.as_bytes(),
        &fs::read(&locations[0].path).unwrap(),
    );
    assert_eq!(
        inserted,
        r#","other":{"headersHelper":"get-other","type":"http","url":"https://example.test/other"}"#
    );
}

#[test]
fn agents_without_helpers_refuse_that_pair_only() {
    let t = TempTree::new();
    let root = t.root();
    let codex = root.join("config.toml");
    let cursor = root.join("cursor.json");
    let claude = root.join("claude.json");
    fs::write(
        &codex,
        "[mcp_servers.search]\nurl = \"https://example.test/mcp\"\nhttp_headers_helper = \"fixture-secret\"\n",
    )
    .unwrap();
    let locations = vec![
        location("codex", "Codex", "codex", codex),
        location("cursor", "Cursor", "cursor", cursor.clone()),
        location(
            "claude",
            "Claude Code · User MCPs",
            "claude-code",
            claude.clone(),
        ),
    ];

    let overview = scan(&locations);
    let refused = cell(&overview, "codex", "search", "cursor");
    assert_eq!(refused.state, McpCellState::Unsupported);
    assert_eq!(
        refused.reason.as_deref(),
        Some("Cursor 不支持用命令生成请求头")
    );
    assert_eq!(
        cell(&overview, "codex", "search", "claude").state,
        McpCellState::Missing
    );
    // 来源列表：至少一家接得住，portable 仍为 true，附上只有哪几家接得住
    let page = sources::list("global", &overview, &BTreeMap::new(), &[]);
    let service = &page
        .subscribed
        .iter()
        .find(|s| s.source.id == "codex")
        .unwrap()
        .source
        .services[0];
    assert!(service.portable);
    assert_eq!(
        serde_json::to_value(service).unwrap(),
        json!({"name": "search", "portable": true, "onlyHarnesses": ["claude-code", "codex"]})
    );
    // 自动添加只挑 Missing 的格：接不住的那一列不会被规则选中
    let rule = McpAutoImportRule {
        source: location_ref(&locations[0]),
        target_domain: "global".into(),
        targets: vec![location_ref(&locations[1]), location_ref(&locations[2])],
        target_excluded: BTreeMap::new(),
        allow_cross_domain: false,
        baseline: Some(BTreeSet::new()),
        target_baselines: BTreeMap::new(),
        last_auto: None,
    };
    assert_eq!(
        auto_selections(&overview, &[rule]),
        vec![sel("codex", "search", "claude")]
    );
    assert!(!serde_json::to_string(&overview)
        .unwrap()
        .contains("fixture-secret"));

    // 计划：只拒绝 (codex, cursor) 这一对，原因同一句；Claude Code 那一对照常写
    let plan = prepare(
        &locations,
        &[
            sel("codex", "search", "cursor"),
            sel("codex", "search", "claude"),
        ],
    );
    assert_eq!(plan.actions.len(), 1);
    assert_eq!(plan.actions[0].target_id, "claude");
    assert_eq!(plan.issues.len(), 1);
    assert_eq!(plan.issues[0].location_id, "cursor");
    assert_eq!(plan.issues[0].message, "Cursor 不支持用命令生成请求头");
    execute(plan, false);
    assert!(
        fs::symlink_metadata(&cursor).is_err(),
        "Cursor 一个字节都没写"
    );
    assert!(fs::read_to_string(&claude)
        .unwrap()
        .contains("\"headersHelper\":\"fixture-secret\""));

    // 写入层再挡一次：绕过计划直接合并到不认得的 agent 也不会丢字段写
    let def = &parse(&locations[0]).values["search"];
    assert!(merge(&locations[1], None, &[("search", def)]).is_err());
}

#[test]
fn headers_helper_is_only_recognised_in_claude_code_json() {
    let t = TempTree::new();
    let root = t.root();
    let cursor = root.join("cursor.json");
    fs::write(
        &cursor,
        r#"{"mcpServers":{"search":{"type":"http","url":"https://example.test/mcp","headersHelper":"x"}}}"#,
    )
    .unwrap();
    let parsed = parse(&location("cursor", "Cursor", "cursor", cursor));
    let def = &parsed.values["search"];
    assert!(def.unsupported);
    assert_eq!(def.reason.as_deref(), Some("不支持迁移字段 headersHelper"));
    assert_eq!(def.only_harnesses(), None);
}

#[test]
fn invalid_helpers_stay_unsupported() {
    for (server, reason) in [
        (
            json!({"type":"http","url":"https://example.test/mcp","headersHelper":"get ${TOKEN}"}),
            "字段 headersHelper 包含变量引用",
        ),
        (
            json!({"command":"x","headersHelper":"get"}),
            "连接字段不适用于该传输类型",
        ),
        (
            json!({"type":"http","url":"https://example.test/mcp","headersHelper":7}),
            "字段 headersHelper 必须是非空字符串",
        ),
    ] {
        let def = canon_json(&server, Some("headersHelper"));
        assert!(def.unsupported, "{server}");
        assert_eq!(def.reason.as_deref(), Some(reason), "{server}");
    }
}

#[test]
fn helper_servers_compare_by_command_and_static_headers() {
    let t = TempTree::new();
    let root = t.root();
    let codex = root.join("config.toml");
    let claude = root.join("claude.json");
    fs::write(
        &codex,
        "[mcp_servers.same]\nurl = \"https://example.test/mcp\"\nhttp_headers_helper = \"fixture-helper-aaaa\"\n\
         [mcp_servers.other]\nurl = \"https://example.test/mcp\"\nhttp_headers = { X-Team = \"core\" }\n\
         http_headers_helper = \"fixture-helper-aaaa\"\n",
    )
    .unwrap();
    fs::write(
        &claude,
        serde_json::to_vec(&json!({"mcpServers": {
            "same": {"type":"http","url":"https://example.test/mcp","headersHelper":"fixture-helper-aaaa"},
            "other": {"type":"http","url":"https://example.test/mcp",
                      "headers":{"X-Team":"infra"},"headersHelper":"fixture-helper-bbbb"},
        }}))
        .unwrap(),
    )
    .unwrap();
    let locations = vec![
        location("codex", "Codex", "codex", codex),
        location("claude", "Claude Code · User MCPs", "claude-code", claude),
    ];
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "codex", "same", "claude").state,
        McpCellState::Equal
    );
    let other = cell(&overview, "codex", "other", "claude");
    assert_eq!(other.state, McpCellState::Conflict);
    assert_eq!(other.reason.as_deref(), Some("同名配置不同"));

    let parsed: Vec<_> = locations.iter().map(parse).collect();
    assert!(sources::same_copy(
        &locations[0],
        &parsed[0].values["same"],
        &locations[1],
        &parsed[1].values["same"],
    ));
    assert!(!sources::same_copy(
        &locations[0],
        &parsed[0].values["other"],
        &locations[1],
        &parsed[1].values["other"],
    ));

    // 字段级差异：两边都用命令，照常逐项比；命令按凭据脱敏
    let ids = vec!["codex".to_string(), "claude".to_string()];
    let same = diff_fields(&locations, "same", &ids);
    assert!(same.fields.is_empty() && !same.dynamic_auth);
    let diff = diff_fields(&locations, "other", &ids);
    assert!(!diff.dynamic_auth);
    let fields: Vec<&str> = diff.fields.iter().map(|f| f.field.as_str()).collect();
    assert_eq!(fields, vec!["headersHelper", "headers.X-Team"]);
    assert_eq!(
        diff.fields[0].values,
        vec![
            McpFieldValue::Secret {
                last4: Some("aaaa".into())
            },
            McpFieldValue::Secret {
                last4: Some("bbbb".into())
            },
        ]
    );
    assert!(!serde_json::to_string(&diff)
        .unwrap()
        .contains("fixture-helper"));
}

//! MCP 第一批（spec 2026-09-27-mcp-batch1）：Gemini CLI、GitHub Copilot CLI、Claude Desktop 的位置、
//! 读写映射、无损拒绝、撤销。全部在临时目录里搭真实文件，不碰本机配置
use super::*;
use crate::test_support::{backups, TempTree};
use serde_json::json;

fn harness(id: &str, name: &str) -> Harness {
    Harness {
        id: id.into(),
        display_name: name.into(),
        brand: id.into(),
        brand_name: name.into(),
        project_dir: None,
        global_dir: None,
        universal: false,
        agent_dirs: Vec::new(),
        managed_global_dir: false,
        agent_labels: None,
    }
}

/// 六家都在（Claude Desktop 在 discovery 里只由 `mcp_columns` 带进来，这里直接给）
fn six() -> Vec<Harness> {
    vec![
        harness("claude-code", "Claude Code"),
        harness("codex", "Codex"),
        harness("cursor", "Cursor"),
        harness("gemini-cli", "Gemini CLI"),
        harness("claude-desktop", "Claude Desktop"),
        harness("github-copilot", "GitHub Copilot"),
    ]
}

fn env(home: &Path, vars: &[(&str, &str)]) -> Env {
    Env {
        apps: Vec::new(),
        home: home.to_path_buf(),
        vars: vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

fn location(id: &str, label: &str, harness_id: &str, path: PathBuf) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: label.into(),
        harness_id: harness_id.into(),
        domain: "global".into(),
        path,
        selector: None,
        matrix_hidden: false,
        mirrors: Vec::new(),
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

fn write_one(locations: &[McpLocation], selection: McpSelection) -> McpReport {
    let plan = prepare(locations, &[selection]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(plan.actions.len(), 1);
    let report = execute(plan, false, backups());
    assert_eq!(report.entries[0].outcome, "created", "{:?}", report.entries);
    report
}

/// 这次选择被拒，原因是 `reason`，目标文件一个字节没动
fn refused_with(locations: &[McpLocation], selection: McpSelection, reason: &str) {
    let target = locations
        .iter()
        .find(|l| l.id == selection.target_id)
        .unwrap()
        .path
        .clone();
    let before = fs::read(&target).ok();
    let plan = prepare(locations, &[selection]);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.issues[0].message, reason);
    assert_eq!(execute(plan, false, backups()).entries, Vec::new());
    assert_eq!(fs::read(&target).ok(), before, "目标不变");
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

/// 插入的那一段是一个（带前导逗号的）成员：解析成对象
fn member(inserted: &str) -> Value {
    serde_json::from_str(&format!("{{{}}}", inserted.trim_start_matches(','))).unwrap()
}

const GEMINI_SETTINGS: &str = "{\r\n  \"theme\": \"GitHub\",\r\n  \"general\": { \"vimMode\": true,  \"checkpointing\": {\"enabled\": false} },\r\n  \"mcpServers\": {\r\n    \"local\": { \"command\": \"npx\", \"args\": [\"-y\", \"local-mcp\"] }\r\n  },\r\n  \"tools\": { \"exclude\": [ \"run_shell_command\" ] }\r\n}\r\n";

// ===== 位置（R2，AC1 AC2 AC8 AC9）=====

#[test]
fn locations_follow_the_agent_table() {
    let t = TempTree::new();
    let home = t.root();
    let project = t.dir("work/app");
    let found = locations(&env(&home, &[]), &six(), std::slice::from_ref(&project));
    let path_of = |id: &str| {
        found
            .iter()
            .find(|l| l.id == id)
            .map(|l| l.path.clone())
            .unwrap_or_else(|| panic!("没有位置 {id}"))
    };
    let p = normalize(&project).to_string_lossy().into_owned();
    assert_eq!(path_of("gemini-cli"), home.join(".gemini/settings.json"));
    assert_eq!(
        path_of(&format!("project:{p}::gemini-cli")),
        project.join(".gemini/settings.json")
    );
    assert_eq!(
        path_of("github-copilot"),
        home.join(".copilot/mcp-config.json")
    );
    // Copilot 的项目格只反映 .github/mcp.json，不是 Claude Code 的 .mcp.json（R6）
    assert_eq!(
        path_of(&format!("project:{p}::github-copilot")),
        project.join(".github/mcp.json")
    );
    assert_eq!(
        path_of(&format!("project:{p}::claude-code")),
        project.join(".mcp.json")
    );
    // Claude Desktop 没有项目级（R5）
    assert!(!found
        .iter()
        .any(|l| l.harness_id == "claude-desktop" && l.domain != "global"));
    let desktop = found.iter().find(|l| l.id == "claude-desktop");
    if cfg!(target_os = "macos") {
        assert_eq!(
            desktop.unwrap().path,
            home.join("Library/Application Support/Claude/claude_desktop_config.json")
        );
        assert_eq!(desktop.unwrap().label, "Claude Desktop");
    } else if cfg!(target_os = "linux") {
        assert!(desktop.is_none(), "Linux 上没有 Claude Desktop");
    }
    // 现有三家不变
    assert_eq!(path_of("claude-code"), home.join(".claude.json"));
    assert_eq!(path_of("codex"), home.join(".codex/config.toml"));
    assert_eq!(path_of("cursor"), home.join(".cursor/mcp.json"));
    // 表外的 agent 不出现在 MCP 页
    let other = locations(&env(&home, &[]), &[harness("cline", "Cline")], &[project]);
    assert!(other.is_empty());
}

#[test]
fn env_overrides_move_gemini_and_copilot_user_files() {
    let t = TempTree::new();
    let home = t.root();
    let gemini_home = t.dir("elsewhere/gemini-home");
    let copilot_home = t.dir("elsewhere/copilot");
    let found = locations(
        &env(
            &home,
            &[
                ("GEMINI_CLI_HOME", gemini_home.to_str().unwrap()),
                ("COPILOT_HOME", copilot_home.to_str().unwrap()),
            ],
        ),
        &six(),
        &[],
    );
    let path_of = |id: &str| found.iter().find(|l| l.id == id).unwrap().path.clone();
    assert_eq!(
        path_of("gemini-cli"),
        gemini_home.join(".gemini/settings.json")
    );
    assert_eq!(
        path_of("github-copilot"),
        copilot_home.join("mcp-config.json")
    );
    // 空白的变量等于没设
    let blank = locations(
        &env(&home, &[("GEMINI_CLI_HOME", "  "), ("COPILOT_HOME", "")]),
        &six(),
        &[],
    );
    let path_of = |id: &str| blank.iter().find(|l| l.id == id).unwrap().path.clone();
    assert_eq!(path_of("gemini-cli"), home.join(".gemini/settings.json"));
    assert_eq!(
        path_of("github-copilot"),
        home.join(".copilot/mcp-config.json")
    );
}

// ===== 读（R2 R3，AC1）=====

#[test]
fn each_new_format_parses_into_the_shared_fields() {
    let t = TempTree::new();
    let root = t.root();
    let gemini = root.join("settings.json");
    fs::write(
        &gemini,
        json!({"theme": "x", "mcpServers": {
            "local": {"command": "npx", "args": ["-y", "a"], "env": {"K": "v"}},
            "stream": {"httpUrl": "https://g.test/mcp", "headers": {"X-A": "1"}},
            "events": {"url": "https://g.test/sse"},
        }})
        .to_string(),
    )
    .unwrap();
    let copilot = root.join("mcp-config.json");
    fs::write(
        &copilot,
        json!({"mcpServers": {
            "local": {"type": "local", "command": "npx", "args": ["-y", "a"], "env": {}, "tools": ["*"]},
            "same": {"type": "stdio", "command": "npx", "tools": "*"},
            "bare": {"command": "npx"},
            "stream": {"type": "http", "url": "https://g.test/mcp", "headers": {"X-A": "1"}, "tools": ["*"]},
            "events": {"type": "sse", "url": "https://g.test/sse"},
        }})
        .to_string(),
    )
    .unwrap();
    let desktop = root.join("claude_desktop_config.json");
    fs::write(
        &desktop,
        json!({"mcpServers": {"local": {"command": "npx", "args": ["-y", "a"], "env": {"K": "v"}}}})
            .to_string(),
    )
    .unwrap();
    let g = parse(&location("g", "Gemini CLI", "gemini-cli", gemini));
    let c = parse(&location("c", "GitHub Copilot", "github-copilot", copilot));
    let d = parse(&location("d", "Claude Desktop", "claude-desktop", desktop));
    for parsed in [&g, &c, &d] {
        assert!(parsed.issue.is_none());
    }
    let kinds = |p: &Parsed| {
        p.values
            .iter()
            .map(|(name, def)| (name.clone(), def.transport.clone(), def.unsupported))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        kinds(&g),
        vec![
            ("events".into(), "sse".into(), false),
            ("local".into(), "stdio".into(), false),
            ("stream".into(), "http".into(), false),
        ]
    );
    assert_eq!(
        kinds(&c),
        vec![
            ("bare".into(), "stdio".into(), false),
            ("events".into(), "sse".into(), false),
            ("local".into(), "stdio".into(), false),
            ("same".into(), "stdio".into(), false),
            ("stream".into(), "http".into(), false),
        ]
    );
    assert_eq!(kinds(&d), vec![("local".into(), "stdio".into(), false)]);
    // 同一个服务在三家读出来的连接一样；Copilot 的全部工具不算专属设置
    assert!(g.values["local"].connection_eq(&d.values["local"]));
    assert!(g.values["stream"].connection_eq(&c.values["stream"]));
    assert!(g.values["events"].connection_eq(&c.values["events"]));
    assert!(c.values["local"].client_fields.is_empty());
    assert!(c.values["same"].client_fields.is_empty());
    assert_eq!(
        g.values["stream"].url.as_deref(),
        Some("https://g.test/mcp")
    );
}

#[test]
fn bad_shapes_in_new_formats_are_unsupported_not_missing() {
    for (dialect, server) in [
        // Gemini：两种地址同时写、不认识的字段、远程带 env
        (
            Dialect::Gemini,
            json!({"url": "https://a", "httpUrl": "https://b"}),
        ),
        (
            Dialect::Gemini,
            json!({"command": "x", "authProviderType": "google_credentials"}),
        ),
        (
            Dialect::Gemini,
            json!({"httpUrl": "https://a", "env": {"A": "b"}}),
        ),
        // （Gemini 值里的 $VAR 不在这里：同一家之间照样复制，跨家由 refusal 拒绝，
        // 见 variable_references_copy_within_the_same_agent）
        // Copilot：url 没有 type 分不出是哪种远程；type 与字段对不上；tools 类型不对
        (Dialect::Copilot, json!({"url": "https://a"})),
        (Dialect::Copilot, json!({"type": "http", "command": "x"})),
        (
            Dialect::Copilot,
            json!({"type": "local", "command": "x", "tools": 3}),
        ),
        // Claude Desktop：远程字段在它的文件里不成立
        (Dialect::Desktop, json!({"url": "https://a"})),
        (Dialect::Desktop, json!({"type": "stdio", "command": "x"})),
    ] {
        let def = canon_by(&server, dialect);
        assert!(def.unsupported, "{dialect:?} {server}");
        assert!(def.reason.is_some());
    }
}

// ===== 写（R2 R3，AC3 AC4）=====

#[test]
fn http_into_gemini_is_http_url_and_the_rest_is_byte_identical() {
    let t = TempTree::new();
    let root = t.root();
    let claude = root.join(".claude.json");
    fs::write(
        &claude,
        json!({"mcpServers": {"docs": {"type": "http", "url": "https://docs.test/mcp", "headers": {"Authorization": "Bearer abc"}}}})
            .to_string(),
    )
    .unwrap();
    let gemini = root.join("settings.json");
    fs::write(&gemini, GEMINI_SETTINGS).unwrap();
    let locations = vec![
        location("claude", "Claude Code · User MCPs", "claude-code", claude),
        location("gemini", "Gemini CLI", "gemini-cli", gemini.clone()),
    ];
    assert_eq!(
        cell(&scan(&locations), "claude", "docs", "gemini").state,
        McpCellState::Missing
    );
    let mut report = write_one(&locations, sel("claude", "docs", "gemini"));
    let after = fs::read(&gemini).unwrap();
    let inserted = only_inserted(GEMINI_SETTINGS.as_bytes(), &after);
    assert_eq!(
        member(&inserted),
        json!({"docs": {"httpUrl": "https://docs.test/mcp", "headers": {"Authorization": "Bearer abc"}}}),
        "Streamable HTTP 写 httpUrl，不是 url"
    );
    assert!(!inserted.contains('\n'), "插入的只有这一个成员");
    assert_eq!(
        cell(&scan(&locations), "claude", "docs", "gemini").state,
        McpCellState::Equal
    );
    // 能撤销：还原成写入前的每一个字节（AC13）
    let undo = report.take_undo().expect("可撤销");
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read(&gemini).unwrap(), GEMINI_SETTINGS.as_bytes());
}

#[test]
fn gemini_without_mcp_servers_gets_a_crlf_root_member_and_bom_files_are_refused() {
    let t = TempTree::new();
    let root = t.root();
    let cursor = root.join("mcp.json");
    fs::write(
        &cursor,
        json!({"mcpServers": {"events": {"type": "stdio", "command": "run"}}}).to_string(),
    )
    .unwrap();
    let gemini = root.join("settings.json");
    let before = "{\r\n  \"theme\": \"GitHub\"\r\n}\r\n";
    fs::write(&gemini, before).unwrap();
    let locations = vec![
        location("cursor", "Cursor", "cursor", cursor),
        location("gemini", "Gemini CLI", "gemini-cli", gemini.clone()),
    ];
    write_one(&locations, sel("cursor", "events", "gemini"));
    let inserted = only_inserted(before.as_bytes(), &fs::read(&gemini).unwrap());
    assert_eq!(
        inserted,
        ",\r\n  \"mcpServers\": {\"events\":{\"command\":\"run\"}}"
    );

    // 带 BOM 的文件不是严格 JSON：读不出来，不写，一个字节不动
    let bom = root.join("bom-settings.json");
    let bom_before = "\u{feff}{\"mcpServers\":{}}";
    fs::write(&bom, bom_before).unwrap();
    let locations = vec![
        locations[0].clone(),
        location("bom", "Gemini CLI", "gemini-cli", bom.clone()),
    ];
    assert_eq!(
        cell(&scan(&locations), "cursor", "events", "bom").state,
        McpCellState::Invalid
    );
    refused_with(
        &locations,
        sel("cursor", "events", "bom"),
        "目标配置无法解析或不安全",
    );
    assert_eq!(fs::read_to_string(&bom).unwrap(), bom_before);
}

#[test]
fn stdio_into_copilot_carries_local_and_all_tools_and_round_trips_to_cursor() {
    let t = TempTree::new();
    let root = t.root();
    let cursor = root.join("cursor.json");
    let original = json!({"type": "stdio", "command": "npx", "args": ["-y", "@acme/mcp"], "env": {"LEVEL": "debug"}});
    fs::write(
        &cursor,
        json!({"mcpServers": {"acme": original}}).to_string(),
    )
    .unwrap();
    let copilot = root.join("mcp-config.json");
    let copilot_before = "{\n  \"mcpServers\": {}\n}\n";
    fs::write(&copilot, copilot_before).unwrap();
    let cursor_new = root.join("cursor-new.json");
    let locations = vec![
        location("cursor", "Cursor", "cursor", cursor),
        location(
            "copilot",
            "GitHub Copilot",
            "github-copilot",
            copilot.clone(),
        ),
        location("cursor-new", "Cursor", "cursor", cursor_new.clone()),
    ];
    write_one(&locations, sel("cursor", "acme", "copilot"));
    let inserted = only_inserted(copilot_before.as_bytes(), &fs::read(&copilot).unwrap());
    assert_eq!(
        member(&inserted),
        json!({"acme": {"type": "local", "command": "npx", "args": ["-y", "@acme/mcp"], "env": {"LEVEL": "debug"}, "tools": ["*"]}})
    );
    // 再从 Copilot 写回 Cursor：与原条目一致
    write_one(&locations, sel("copilot", "acme", "cursor-new"));
    let written: Value = serde_json::from_slice(&fs::read(&cursor_new).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["acme"], original);
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "cursor", "acme", "copilot").state,
        McpCellState::Equal
    );
    assert_eq!(
        cell(&overview, "copilot", "acme", "cursor-new").state,
        McpCellState::Equal
    );
}

/// 三种传输在六家之间：写得进的写进去再读回来连接不变；写不进的说原因
#[test]
fn transport_mapping_across_all_six_agents() {
    let stdio = Canonical {
        raw: None,
        unknown_field: None,
        transport: "stdio".into(),
        command: Some("npx".into()),
        args: vec!["-y".into(), "pkg".into()],
        env: [("K".to_string(), "v".to_string())].into(),
        url: None,
        headers: BTreeMap::new(),
        client_fields: BTreeMap::new(),
        reason: None,
        unsupported: false,
        headers_helper: None,
    };
    let http = Canonical {
        raw: None,
        unknown_field: None,
        transport: "http".into(),
        command: None,
        args: Vec::new(),
        env: BTreeMap::new(),
        url: Some("https://m.test/mcp".into()),
        headers: [("X-Team".to_string(), "core".to_string())].into(),
        ..stdio.clone()
    };
    let sse = Canonical {
        raw: None,
        unknown_field: None,
        transport: "sse".into(),
        url: Some("https://m.test/sse".into()),
        ..http.clone()
    };
    let t = TempTree::new();
    let targets = [
        ("claude-code", "Claude Code", "claude.json"),
        ("codex", "Codex", "config.toml"),
        ("cursor", "Cursor", "cursor.json"),
        ("gemini-cli", "Gemini CLI", "settings.json"),
        (
            "claude-desktop",
            "Claude Desktop",
            "claude_desktop_config.json",
        ),
        ("github-copilot", "GitHub Copilot", "mcp-config.json"),
    ];
    // 期望：谁写不进哪种、原因是什么
    let expected = |harness: &str, transport: &str| -> Option<String> {
        match (harness, transport) {
            ("claude-desktop", "http" | "sse") => Some(agents::desktop_remote()),
            ("codex", "sse") => Some("Codex 不支持 SSE 传输".into()),
            ("cursor", "sse") => Some("Cursor 不支持 SSE 传输".into()),
            _ => None,
        }
    };
    for (harness_id, name, file) in targets {
        let target = location(harness_id, name, harness_id, t.root().join(file));
        for def in [&stdio, &http, &sse] {
            let refusal = def.refusal("gemini-cli", "Gemini CLI", harness_id, name);
            assert_eq!(
                refusal,
                expected(harness_id, &def.transport),
                "{harness_id} {}",
                def.transport
            );
            if refusal.is_some() {
                // 写入层再挡一次：绕过计划直接合并也不会写
                assert!(merge(&target, None, &[("x", def)]).is_err(), "{harness_id}");
                continue;
            }
            let bytes = merge(&target, None, &[("x", def)]).unwrap();
            let parsed = if harness_id == "codex" {
                parse_toml(&bytes, State::Missing)
            } else {
                parse_json(&bytes, State::Missing, None, agents::dialect_of(&target))
            };
            let back = &parsed.values["x"];
            assert!(
                back.connection_eq(def),
                "{harness_id} {} 读回来不一样：{back:?}",
                def.transport
            );
        }
    }
    // Gemini 里的写法：httpUrl ↔ Streamable HTTP，url ↔ SSE，不能反过来
    let gemini = location("g", "Gemini CLI", "gemini-cli", t.root().join("g.json"));
    let written: Value =
        serde_json::from_slice(&merge(&gemini, None, &[("h", &http), ("s", &sse)]).unwrap())
            .unwrap();
    assert_eq!(written["mcpServers"]["h"]["httpUrl"], "https://m.test/mcp");
    assert!(written["mcpServers"]["h"].get("url").is_none());
    assert_eq!(written["mcpServers"]["s"]["url"], "https://m.test/sse");
    assert!(written["mcpServers"]["s"].get("httpUrl").is_none());
    // Copilot：type 分别是 local / http / sse，都带全部工具
    let copilot = location(
        "c",
        "GitHub Copilot",
        "github-copilot",
        t.root().join("c.json"),
    );
    let written: Value = serde_json::from_slice(
        &merge(&copilot, None, &[("a", &stdio), ("h", &http), ("s", &sse)]).unwrap(),
    )
    .unwrap();
    for (name, typ) in [("a", "local"), ("h", "http"), ("s", "sse")] {
        assert_eq!(written["mcpServers"][name]["type"], typ);
        assert_eq!(written["mcpServers"][name]["tools"], json!(["*"]));
    }
    // Claude Code 的 SSE 写 type: "sse"；Claude Desktop 的 stdio 不写 type
    let claude = location("cc", "Claude Code", "claude-code", t.root().join("cc.json"));
    let written: Value =
        serde_json::from_slice(&merge(&claude, None, &[("s", &sse)]).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["s"]["type"], "sse");
    let desktop = location(
        "d",
        "Claude Desktop",
        "claude-desktop",
        t.root().join("d.json"),
    );
    let written: Value =
        serde_json::from_slice(&merge(&desktop, None, &[("a", &stdio)]).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["a"],
        json!({"command": "npx", "args": ["-y", "pkg"], "env": {"K": "v"}})
    );
}

// ===== 拒绝（R4，AC5 AC6 AC7）=====

#[test]
fn remote_server_into_claude_desktop_is_refused_with_the_design_reason() {
    let t = TempTree::new();
    let root = t.root();
    let claude = root.join(".claude.json");
    fs::write(
        &claude,
        json!({"mcpServers": {"docs": {"type": "http", "url": "https://docs.test/mcp"}}})
            .to_string(),
    )
    .unwrap();
    let desktop = root.join("claude_desktop_config.json");
    let before = "{\n  \"mcpServers\": {},\n  \"globalShortcut\": \"Ctrl+Space\"\n}\n";
    fs::write(&desktop, before).unwrap();
    let locations = vec![
        location("claude", "Claude Code · User MCPs", "claude-code", claude),
        location(
            "desktop",
            "Claude Desktop",
            "claude-desktop",
            desktop.clone(),
        ),
    ];
    let overview = scan(&locations);
    let c = cell(&overview, "claude", "docs", "desktop");
    assert_eq!(c.state, McpCellState::Unsupported);
    assert_eq!(
        c.reason.as_deref(),
        Some("Claude 桌面应用的远程服务器要在它自己的「连接器」里添加")
    );
    // 前端按目标 agent 取这一格的原因：条目带上接得住的几家
    let entry = overview.entries.iter().find(|e| e.name == "docs").unwrap();
    assert_eq!(
        entry.only_harnesses,
        Some(
            [
                "claude-code",
                "codex",
                "cursor",
                "gemini-cli",
                "github-copilot",
                "kimi-cli",
                "kimi-desktop",
                "workbuddy",
                "deepseek-harness"
            ]
            .map(String::from)
            .to_vec()
        )
    );
    refused_with(
        &locations,
        sel("claude", "docs", "desktop"),
        "Claude 桌面应用的远程服务器要在它自己的「连接器」里添加",
    );
    assert_eq!(fs::read_to_string(&desktop).unwrap(), before);
}

#[test]
fn gemini_only_settings_block_other_agents_but_copy_within_gemini() {
    let t = TempTree::new();
    let root = t.root();
    let gemini = root.join("settings.json");
    fs::write(
        &gemini,
        json!({"mcpServers": {
            "trusted": {"command": "run", "trust": true},
            "many": {"command": "run", "trust": true, "timeout": 30000, "includeTools": ["a"]},
        }})
        .to_string(),
    )
    .unwrap();
    let gemini_project = root.join("project-settings.json");
    let copilot = root.join("mcp-config.json");
    let cursor = root.join("mcp.json");
    let mut project = location(
        "gemini-project",
        "Gemini CLI",
        "gemini-cli",
        gemini_project.clone(),
    );
    project.domain = "project:/p".into();
    let locations = vec![
        location("gemini", "Gemini CLI", "gemini-cli", gemini),
        project,
        location("copilot", "GitHub Copilot", "github-copilot", copilot),
        location("cursor", "Cursor", "cursor", cursor),
    ];
    let overview = scan(&locations);
    let reason = |name: &str, target: &str| cell(&overview, "gemini", name, target).reason.clone();
    assert_eq!(
        cell(&overview, "gemini", "trusted", "copilot").state,
        McpCellState::Unsupported
    );
    assert_eq!(
        reason("trusted", "copilot").as_deref(),
        Some("带有 Gemini CLI 专属的设置（trust），GitHub Copilot 里没有对应的写法")
    );
    assert_eq!(
        reason("trusted", "cursor").as_deref(),
        Some("带有 Gemini CLI 专属的设置（trust），Cursor 里没有对应的写法")
    );
    assert_eq!(
        reason("many", "cursor").as_deref(),
        Some("带有 Gemini CLI 专属的设置（includeTools 等 3 项），Cursor 里没有对应的写法")
    );
    assert_eq!(
        overview
            .entries
            .iter()
            .find(|e| e.name == "trusted")
            .unwrap()
            .only_harnesses,
        Some(vec!["gemini-cli".to_string()])
    );
    refused_with(
        &locations,
        sel("gemini", "trusted", "copilot"),
        "带有 Gemini CLI 专属的设置（trust），GitHub Copilot 里没有对应的写法",
    );
    // 同一家之间：可以写，写进去的保留 trust（跨域要确认）
    assert_eq!(
        cell(&overview, "gemini", "many", "gemini-project").state,
        McpCellState::Missing
    );
    let plan = prepare(&locations, &[sel("gemini", "many", "gemini-project")]);
    assert!(plan.issues.is_empty());
    let report = execute(plan, true, backups());
    assert_eq!(report.entries[0].outcome, "created");
    let written: Value = serde_json::from_slice(&fs::read(&gemini_project).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["many"],
        json!({"command": "run", "trust": true, "timeout": 30000, "includeTools": ["a"]})
    );
    assert_eq!(
        cell(&scan(&locations), "gemini", "many", "gemini-project").state,
        McpCellState::Equal
    );
}

#[test]
fn copilot_tool_lists_are_copilot_only_but_all_tools_is_no_field() {
    let t = TempTree::new();
    let root = t.root();
    let copilot = root.join("mcp-config.json");
    fs::write(
        &copilot,
        json!({"mcpServers": {
            "some": {"type": "local", "command": "run", "tools": ["read", "search"]},
            "all": {"type": "local", "command": "run", "tools": "*"},
        }})
        .to_string(),
    )
    .unwrap();
    let project = root.join("project-mcp.json");
    let gemini = root.join("settings.json");
    let locations = vec![
        location("copilot", "GitHub Copilot", "github-copilot", copilot),
        location(
            "project",
            "GitHub Copilot",
            "github-copilot",
            project.clone(),
        ),
        location("gemini", "Gemini CLI", "gemini-cli", gemini.clone()),
    ];
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "copilot", "some", "gemini")
            .reason
            .as_deref(),
        Some("带有 GitHub Copilot 专属的设置（tools），Gemini CLI 里没有对应的写法")
    );
    assert_eq!(
        cell(&overview, "copilot", "all", "gemini").state,
        McpCellState::Missing
    );
    write_one(&locations, sel("copilot", "all", "gemini"));
    let written: Value = serde_json::from_slice(&fs::read(&gemini).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["all"], json!({"command": "run"}));
    // 同一家：原样带着自己的工具清单
    write_one(&locations, sel("copilot", "some", "project"));
    let written: Value = serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["some"]["tools"],
        json!(["read", "search"])
    );
    assert_eq!(written["mcpServers"]["some"]["type"], "local");
}

#[test]
fn variable_references_never_go_into_claude_desktop() {
    let t = TempTree::new();
    let root = t.root();
    let claude = root.join(".claude.json");
    fs::write(
        &claude,
        json!({"mcpServers": {
            "braced": {"command": "run", "env": {"TOKEN": "${TOKEN}"}},
            "bare": {"command": "run", "args": ["--home", "$HOME"]},
            "plain": {"command": "run", "args": ["--port", "3000"], "env": {"PRICE": "5$"}},
        }})
        .to_string(),
    )
    .unwrap();
    let desktop = root.join("claude_desktop_config.json");
    let cursor = root.join("mcp.json");
    let locations = vec![
        location("claude", "Claude Code · User MCPs", "claude-code", claude),
        location(
            "desktop",
            "Claude Desktop",
            "claude-desktop",
            desktop.clone(),
        ),
        location("cursor", "Cursor", "cursor", cursor),
    ];
    let overview = scan(&locations);
    for name in ["braced", "bare"] {
        let c = cell(&overview, "claude", name, "desktop");
        assert_eq!(c.state, McpCellState::Unsupported, "{name}");
        assert_eq!(
            c.reason.as_deref(),
            Some("Claude 桌面应用不展开 ${…} 这类变量")
        );
        refused_with(
            &locations,
            sel("claude", name, "desktop"),
            "Claude 桌面应用不展开 ${…} 这类变量",
        );
    }
    // 跨家带 `${…}` 的仍拒绝（等各家的展开规则核实）；`$HOME` 在 Claude Code 里是字面值，别家照常能写
    let braced = cell(&overview, "claude", "braced", "cursor");
    assert_eq!(braced.state, McpCellState::Unsupported);
    assert_eq!(
        braced.reason.as_deref(),
        Some("带有 ${…} 这类变量，只在 Claude Code 之间复制")
    );
    // 条目本身不是「哪儿都搬不过去」：只有 Claude Code 接得住，前端据此用每一格自己的原因
    // （Claude Desktop 那一格说它不展开变量，而不是笼统的一句）
    let entry = overview
        .entries
        .iter()
        .find(|e| e.source_id == "claude" && e.name == "braced")
        .unwrap();
    assert_eq!(entry.reason, None);
    assert_eq!(entry.only_harnesses, Some(vec!["claude-code".to_string()]));
    assert_eq!(
        cell(&overview, "claude", "bare", "cursor").state,
        McpCellState::Missing
    );
    // Gemini 会展开 `$HOME`：Claude Code 里的字面值写过去意思就变了
    let gemini = root.join("settings.json");
    let mut with_gemini = locations.clone();
    with_gemini.push(location("gemini", "Gemini CLI", "gemini-cli", gemini));
    refused_with(
        &with_gemini,
        sel("claude", "bare", "gemini"),
        "Gemini CLI 会展开 $… 这类变量，加到 Gemini CLI 后含义会改变",
    );
    // 没有变量的照常写进 Claude Desktop（`5$` 不是变量）
    write_one(&locations, sel("claude", "plain", "desktop"));
    let written: Value = serde_json::from_slice(&fs::read(&desktop).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["plain"],
        json!({"command": "run", "args": ["--port", "3000"], "env": {"PRICE": "5$"}})
    );
}

/// 同一家之间复制保留全部字段，值里带 `${…}` 的也照样能复制（R4，2026-09-27 改定）：
/// Gemini 用户级 → Gemini 项目级原样写过去（`$HOME` 在 Gemini 里也是变量，同一家照样写）；
/// 跨家到 Copilot 仍拒绝，到 Claude Desktop 说它不展开变量
#[test]
fn variable_references_copy_within_the_same_agent() {
    let t = TempTree::new();
    let root = t.root();
    let user = root.join("user.json");
    fs::write(
        &user,
        json!({"mcpServers": {
            "gh": {"command": "gh-mcp", "args": ["--home", "$HOME"], "env": {"TOKEN": "${GH_TOKEN}"}},
            "bare": {"command": "x", "env": {"A": "$TOKEN"}},
        }})
        .to_string(),
    )
    .unwrap();
    let project = root.join("project.json");
    let copilot = root.join("copilot.json");
    let desktop = root.join("desktop.json");
    let mut project_location = location("project", "Gemini CLI", "gemini-cli", project.clone());
    project_location.domain = "project:/w".into();
    let locations = vec![
        location("user", "Gemini CLI", "gemini-cli", user),
        project_location,
        location("copilot", "GitHub Copilot", "github-copilot", copilot),
        location("desktop", "Claude Desktop", "claude-desktop", desktop),
    ];
    let overview = scan(&locations);
    assert_eq!(
        cell(&overview, "user", "gh", "project").state,
        McpCellState::Missing
    );
    assert_eq!(
        cell(&overview, "user", "gh", "desktop").reason.as_deref(),
        Some("Claude 桌面应用不展开 ${…} 这类变量")
    );
    // Gemini 自己展开 `$VAR`：只有 `$TOKEN` 的也只在 Gemini 之间复制
    for name in ["gh", "bare"] {
        refused_with(
            &locations,
            sel("user", name, "copilot"),
            "带有 ${…} 这类变量，只在 Gemini CLI 之间复制",
        );
    }
    let plan = prepare(&locations, &[sel("user", "gh", "project")]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute(plan, true, backups());
    assert_eq!(report.entries[0].outcome, "created", "{:?}", report.entries);
    let written: Value = serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["gh"],
        json!({"command": "gh-mcp", "args": ["--home", "$HOME"], "env": {"TOKEN": "${GH_TOKEN}"}})
    );
    assert_eq!(
        cell(&scan(&locations), "user", "gh", "project").state,
        McpCellState::Equal
    );
}

// ===== 删除与撤销（AC13）=====

#[test]
fn removal_cuts_only_the_member_and_undo_restores_bytes_in_each_new_format() {
    let t = TempTree::new();
    let root = t.root();
    let copilot_before = "{\n  \"mcpServers\": {\n    \"keep\": {\"type\": \"http\", \"url\": \"https://k\"},\n    \"gone\": {\"type\": \"local\", \"command\": \"x\", \"tools\": [\"*\"]}\n  }\n}\n";
    let desktop_before =
        "{\"mcpServers\":{\"gone\":{\"command\":\"x\"}},\"preferences\":{\"quickEntry\":true}}";
    let files = [
        (
            "gemini",
            "gemini-cli",
            "settings.json",
            GEMINI_SETTINGS,
            "local",
        ),
        (
            "copilot",
            "github-copilot",
            "mcp-config.json",
            copilot_before,
            "gone",
        ),
        (
            "desktop",
            "claude-desktop",
            "claude_desktop_config.json",
            desktop_before,
            "gone",
        ),
    ];
    for (id, harness_id, file, before, name) in files {
        let path = root.join(file);
        fs::write(&path, before).unwrap();
        let locations = vec![location(id, id, harness_id, path.clone())];
        let plan = prepare_original_removal(
            &locations,
            &[McpRemoveItem {
                location_id: id.into(),
                name: name.into(),
            }],
        );
        assert!(plan.issues.is_empty(), "{id} {:?}", plan.issues);
        let mut report = execute_removal(plan, backups());
        assert_eq!(report.entries[0].outcome, "removed", "{id}");
        let after = fs::read(&path).unwrap();
        // 删掉的只是这一段：放回去就是原文
        let cut = only_inserted(&after, before.as_bytes());
        assert!(cut.contains(&format!("\"{name}\"")), "{id}: {cut:?}");
        let parsed = parse(&locations[0]);
        assert!(parsed.issue.is_none() && !parsed.values.contains_key(name));
        let undo = report.take_undo().expect("可撤销");
        assert_eq!(undo_write(&undo).outcome, "undone");
        assert_eq!(fs::read_to_string(&path).unwrap(), before, "{id}");
    }
}

#[test]
fn write_undo_is_refused_after_an_external_edit_and_keeps_the_backup() {
    let t = TempTree::new();
    let root = t.root();
    let claude = root.join(".claude.json");
    fs::write(
        &claude,
        json!({"mcpServers": {"docs": {"command": "docs"}}}).to_string(),
    )
    .unwrap();
    for (harness_id, file) in [
        ("gemini-cli", "settings.json"),
        ("github-copilot", "mcp-config.json"),
        ("claude-desktop", "claude_desktop_config.json"),
    ] {
        let target = root.join(file);
        let before = "{\"mcpServers\":{},\"other\":1}";
        fs::write(&target, before).unwrap();
        let locations = vec![
            location(
                "claude",
                "Claude Code · User MCPs",
                "claude-code",
                claude.clone(),
            ),
            location("target", harness_id, harness_id, target.clone()),
        ];
        let mut report = write_one(&locations, sel("claude", "docs", "target"));
        let undo = report.take_undo().expect("可撤销");
        fs::write(&target, "{\"mcpServers\":{},\"edited\":true}").unwrap();
        let result = undo_write(&undo);
        assert_eq!(result.outcome, "changed", "{harness_id}");
        let backup = result.files[0].backup_path.clone().expect("有备份可显示");
        assert_eq!(fs::read_to_string(backup).unwrap(), before);
    }
}

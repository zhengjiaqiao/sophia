//! Kimi 的两个 MCP 位置（spec #247「一」与「MCP 写入」，#257）：Kimi Code 的 `~/.kimi-code/mcp.json`、
//! Kimi 桌面版运行时目录里的 `mcp.json`。写法：根 `mcpServers`；stdio 是 `command`，HTTP 是有 `url`
//! 且没有 `transport`，SSE 是 `transport: "sse"` + `url`。全部在临时目录里搭真实文件
use super::*;
use crate::test_support::{backups, TempTree};
use serde_json::json;

fn harness(id: &str, name: &str) -> Harness {
    Harness {
        id: id.into(),
        display_name: name.into(),
        brand: "kimi".into(),
        brand_name: "Kimi".into(),
        project_dir: None,
        global_dir: None,
        universal: false,
        agent_dirs: Vec::new(),
        managed_global_dir: false,
        agent_labels: None,
    }
}

fn kimi_pair() -> Vec<Harness> {
    vec![
        harness("kimi-cli", "Kimi Code"),
        harness("kimi-desktop", "Kimi Desktop"),
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

fn location(id: &str, harness_id: &str, path: PathBuf) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
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

fn write_one(locations: &[McpLocation], selection: McpSelection) -> McpReport {
    let plan = prepare(locations, &[selection]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute(plan, false, backups());
    assert_eq!(report.entries[0].outcome, "created", "{:?}", report.entries);
    report
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn locations_follow_the_kimi_rows() {
    let t = TempTree::new();
    let home = t.root();
    let project = t.dir("work/app");
    let found = locations(
        &env(&home, &[]),
        &kimi_pair(),
        std::slice::from_ref(&project),
    );
    let path_of = |id: &str| found.iter().find(|l| l.id == id).map(|l| l.path.clone());
    let p = normalize(&project).to_string_lossy().into_owned();
    assert_eq!(path_of("kimi-cli"), Some(home.join(".kimi-code/mcp.json")));
    assert_eq!(
        path_of(&format!("project:{p}::kimi-cli")),
        Some(project.join(".kimi-code/mcp.json"))
    );
    // 桌面版没有项目级
    assert!(!found
        .iter()
        .any(|l| l.harness_id == "kimi-desktop" && l.domain != "global"));
    if cfg!(target_os = "macos") {
        assert_eq!(
            path_of("kimi-desktop"),
            Some(home.join(
                "Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/mcp.json"
            ))
        );
    }
    // KIMI_CODE_HOME 换的是 Kimi Code 的数据目录
    let elsewhere = t.dir("elsewhere/kimi");
    let moved = locations(
        &env(&home, &[("KIMI_CODE_HOME", elsewhere.to_str().unwrap())]),
        &kimi_pair(),
        &[],
    );
    assert_eq!(
        moved.iter().find(|l| l.id == "kimi-cli").unwrap().path,
        elsewhere.join("mcp.json")
    );
}

#[test]
fn kimi_reads_stdio_http_and_sse_and_refuses_unknown_fields() {
    let t = TempTree::new();
    let path = t.root().join("mcp.json");
    fs::write(
        &path,
        json!({"mcpServers": {
            "local": {"command": "npx", "args": ["-y", "a"], "env": {"K": "v"}},
            "stream": {"url": "https://k.test/mcp", "headers": {"X-A": "1"}},
            "events": {"transport": "sse", "url": "https://k.test/sse"},
            "tuned": {"url": "https://k.test/t", "startupTimeoutMs": 5000},
            "odd": {"url": "https://k.test/o", "mystery": 1},
        }})
        .to_string(),
    )
    .unwrap();
    let parsed = parse(&location("k", "kimi-cli", path));
    assert!(parsed.issue.is_none());
    let v = &parsed.values;
    assert_eq!(v["local"].transport, "stdio");
    assert_eq!(v["stream"].transport, "http");
    assert_eq!(v["stream"].url.as_deref(), Some("https://k.test/mcp"));
    assert_eq!(v["events"].transport, "sse");
    assert!(!v["tuned"].unsupported);
    assert!(v["tuned"].client_fields.contains_key("startupTimeoutMs"));
    assert!(v["odd"].unsupported);
}

#[test]
fn http_into_kimi_has_url_and_no_transport_and_the_rest_is_untouched() {
    let t = TempTree::new();
    let root = t.root();
    let claude = root.join(".claude.json");
    fs::write(
        &claude,
        json!({"mcpServers": {
            "docs": {"type": "http", "url": "https://docs.test/mcp", "headers": {"Authorization": "Bearer abc"}},
            "events": {"type": "sse", "url": "https://docs.test/sse"},
        }})
        .to_string(),
    )
    .unwrap();
    let desktop = root.join("kimi-desktop-mcp.json");
    let before =
        "{\r\n  \"mcpServers\": {\r\n    \"mine\": { \"command\": \"keep-me\" }\r\n  }\r\n}\r\n";
    fs::write(&desktop, before).unwrap();
    let cli = root.join("kimi-cli-mcp.json");
    let locations = vec![
        location("claude", "claude-code", claude),
        location("desktop", "kimi-desktop", desktop.clone()),
        location("cli", "kimi-cli", cli.clone()),
    ];
    let mut report = write_one(&locations, sel("claude", "docs", "desktop"));
    assert_eq!(
        read_json(&desktop)["mcpServers"]["docs"],
        json!({"url": "https://docs.test/mcp", "headers": {"Authorization": "Bearer abc"}})
    );
    assert_eq!(
        read_json(&desktop)["mcpServers"]["mine"],
        json!({"command": "keep-me"}),
        "别人的条目原样"
    );
    // 文件不存在时新建；SSE 写 transport
    write_one(&locations, sel("claude", "events", "cli"));
    assert_eq!(
        read_json(&cli)["mcpServers"]["events"],
        json!({"transport": "sse", "url": "https://docs.test/sse"})
    );
    // 撤销：还原每个字节
    let undo = report.take_undo().expect("可撤销");
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read(&desktop).unwrap(), before.as_bytes());
}

#[test]
fn removal_cuts_only_the_one_member_in_a_kimi_file() {
    let t = TempTree::new();
    let path = t.root().join("mcp.json");
    let before = "{\n  \"mcpServers\": {\n    \"mine\": { \"command\": \"keep-me\" },\n    \"docs\": { \"url\": \"https://docs.test/mcp\" }\n  }\n}\n";
    fs::write(&path, before).unwrap();
    let locations = vec![location("desktop", "kimi-desktop", path.clone())];
    let plan = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: "desktop".into(),
            name: "docs".into(),
        }],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let mut report = execute_removal(plan, backups());
    assert_eq!(report.entries[0].outcome, "removed");
    assert_eq!(
        read_json(&path),
        json!({"mcpServers": {"mine": {"command": "keep-me"}}})
    );
    let undo = report.take_undo().expect("可撤销");
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}

/// 评审 #14（#257）：Kimi Code 与 Kimi 桌面版写法相同（同一个 Dialect），专属字段在两者之间原样带过去，
/// 不按「跨家」拒绝；搬到别的写法（Claude Code）照旧拒绝
#[test]
fn kimi_only_fields_travel_between_the_two_kimi_products() {
    let t = TempTree::new();
    let root = t.root();
    let cli = root.join("kimi-cli-mcp.json");
    fs::write(
        &cli,
        json!({"mcpServers": {
            "tuned": {"command": "npx", "args": ["tool"], "startupTimeoutMs": 9000, "disabledTools": ["x"]},
        }})
        .to_string(),
    )
    .unwrap();
    let desktop = root.join("kimi-desktop-mcp.json");
    let claude = root.join(".claude.json");
    let locations = vec![
        location("cli", "kimi-cli", cli),
        location("desktop", "kimi-desktop", desktop.clone()),
        location("claude", "claude-code", claude),
    ];
    write_one(&locations, sel("cli", "tuned", "desktop"));
    assert_eq!(
        read_json(&desktop)["mcpServers"]["tuned"],
        json!({"command": "npx", "args": ["tool"], "startupTimeoutMs": 9000, "disabledTools": ["x"]})
    );
    let plan = prepare(&locations, &[sel("cli", "tuned", "claude")]);
    assert!(!plan.issues.is_empty(), "搬到 Claude Code 照旧拒绝");
}

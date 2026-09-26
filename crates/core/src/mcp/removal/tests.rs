use super::*;
use crate::mcp::{undo_write, UNDO_CHANGED_MESSAGE};
use crate::test_support::TempTree;
use std::fs;

fn loc(id: &str, harness: &str, path: &Path, selector: Option<&str>) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: harness.into(),
        domain: "global".into(),
        path: path.to_path_buf(),
        selector: selector.map(Into::into),
        matrix_hidden: false,
    }
}

fn item(location: &str, name: &str) -> McpRemoveItem {
    McpRemoveItem {
        location_id: location.into(),
        name: name.into(),
    }
}

/// 单格与批量同一个入口（DESIGN「删除原件」MCP：删哪一处都走 `prepare_original_removal`）
fn remove(locations: &[McpLocation], items: &[McpRemoveItem]) -> McpReport {
    execute_removal(prepare_original_removal(locations, items))
}

fn outcome<'a>(report: &'a McpReport, target: &str, name: &str) -> &'a McpReportEntry {
    report
        .entries
        .iter()
        .find(|entry| entry.target_id == target && entry.name == name)
        .unwrap_or_else(|| panic!("{target} / {name} 没有报告：{:?}", report.entries))
}

const SOURCE_JSON: &[u8] =
    br#"{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"abc"}},"fmt":{"command":"fmt"}}}"#;

/// source.json（Claude Code 写法）+ 一个 Cursor 的 mcp.json，两处各有一份独立的定义
fn json_tree(tree: &TempTree, target_bytes: &[u8]) -> (Vec<McpLocation>, PathBuf) {
    let source = tree.root().join("source.json");
    let target = tree.root().join("mcp.json");
    fs::write(&source, SOURCE_JSON).unwrap();
    fs::write(&target, target_bytes).unwrap();
    (
        vec![
            loc("source", "claude-code", &source, None),
            loc("target", "cursor", &target, None),
        ],
        target,
    )
}

#[test]
fn json_definition_is_cut_out_and_the_rest_is_byte_for_byte() {
    let tree = TempTree::new();
    // CRLF、四格缩进、别的根字段、末行没有换行
    let original = "{\r\n    \"theme\": \"dark\",\r\n    \"mcpServers\": {\r\n        \"docs\": {\"command\": \"docs\", \"env\": {\"TOKEN\": \"abc\"}},\r\n        \"mine\": {\"command\": \"mine\"}\r\n    },\r\n    \"z\": [1, 2]\r\n}";
    let (locations, target) = json_tree(&tree, original.as_bytes());

    let report = remove(&locations, &[item("target", "docs")]);
    let entry = outcome(&report, "target", "docs");
    assert_eq!(entry.outcome, "removed", "{}", entry.message);
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "{\r\n    \"theme\": \"dark\",\r\n    \"mcpServers\": {\r\n        \"mine\": {\"command\": \"mine\"}\r\n    },\r\n    \"z\": [1, 2]\r\n}"
    );
    // 备份就是移除前的原样
    let backup = entry.backup_path.clone().expect("有备份");
    assert_eq!(fs::read(backup).unwrap(), original.as_bytes());
    // 别的位置里的同名定义一个字节没动
    assert_eq!(fs::read(&locations[0].path).unwrap(), SOURCE_JSON);
}

#[test]
fn toml_definition_keeps_bom_crlf_comments_and_missing_final_newline() {
    let tree = TempTree::new();
    let source = tree.root().join("source.json");
    let target = tree.root().join("config.toml");
    fs::write(&source, SOURCE_JSON).unwrap();
    let original = "\u{feff}# Codex 配置\r\nmodel = \"gpt-5\"   # 行尾注释\r\n\r\n\
        [mcp_servers.docs]\r\ncommand = \"docs\"\r\n\r\n[mcp_servers.docs.env]\r\nTOKEN = \"abc\"\r\n\r\n\
        # mine 的说明\r\n[mcp_servers.mine]\r\ncommand = \"mine\"\r\n\r\n[profiles.fast]\r\nmodel = \"o4\"";
    fs::write(&target, original).unwrap();
    let locations = vec![
        loc("source", "claude-code", &source, None),
        loc("codex", "codex", &target, None),
    ];

    let report = remove(&locations, &[item("codex", "docs")]);
    let entry = outcome(&report, "codex", "docs");
    assert_eq!(entry.outcome, "removed", "{}", entry.message);
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "\u{feff}# Codex 配置\r\nmodel = \"gpt-5\"   # 行尾注释\r\n\r\n\
        # mine 的说明\r\n[mcp_servers.mine]\r\ncommand = \"mine\"\r\n\r\n[profiles.fast]\r\nmodel = \"o4\""
    );
}

#[test]
fn claude_local_definition_is_removed_from_the_shared_file_only_in_its_scope() {
    let tree = TempTree::new();
    let claude = tree.root().join(".claude.json");
    let original = r#"{
  "mcpServers": {"docs": {"command": "docs"}},
  "projects": {
    "/p": {"allowedTools": [], "mcpServers": {"docs": {"command": "docs"}, "keep": {"command": "k"}}}
  }
}
"#;
    fs::write(&claude, original).unwrap();
    let locations = vec![
        loc("user", "claude-code", &claude, None),
        loc("local", "claude-code", &claude, Some("/p")),
    ];
    let report = remove(&locations, &[item("local", "docs")]);
    assert_eq!(outcome(&report, "local", "docs").outcome, "removed");
    assert_eq!(
        fs::read_to_string(&claude).unwrap(),
        r#"{
  "mcpServers": {"docs": {"command": "docs"}},
  "projects": {
    "/p": {"allowedTools": [], "mcpServers": {"keep": {"command": "k"}}}
  }
}
"#
    );
}

#[test]
fn undo_restores_the_removed_definition_byte_for_byte() {
    let tree = TempTree::new();
    let original = "{\n  \"mcpServers\": {\n    \"docs\": {\"command\": \"docs\", \"env\": {\"TOKEN\": \"xyz\"}}\n  }\n}\n";
    let (locations, target) = json_tree(&tree, original.as_bytes());
    let mut report = remove(&locations, &[item("target", "docs")]);
    assert_eq!(outcome(&report, "target", "docs").outcome, "removed");
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "{\n  \"mcpServers\": {}\n}\n"
    );
    let undo = report.take_undo().expect("移除给撤销记录");

    let result = undo_write(&undo);
    assert_eq!(result.outcome, "undone");
    assert_eq!(result.files[0].outcome, "restored");
    assert_eq!(fs::read_to_string(&target).unwrap(), original);
}

#[test]
fn undo_is_refused_after_the_file_changed() {
    let tree = TempTree::new();
    let source = tree.root().join("source.json");
    let target = tree.root().join("config.toml");
    fs::write(&source, SOURCE_JSON).unwrap();
    let original = "[mcp_servers.fmt]\r\ncommand = \"fmt\"\r\n";
    fs::write(&target, original).unwrap();
    let locations = vec![
        loc("source", "claude-code", &source, None),
        loc("codex", "codex", &target, None),
    ];
    let mut report = remove(&locations, &[item("codex", "fmt")]);
    assert_eq!(outcome(&report, "codex", "fmt").outcome, "removed");
    let undo = report.take_undo().unwrap();
    fs::write(&target, "model = \"edited\"\r\n").unwrap();

    let result = undo_write(&undo);
    assert_eq!(result.outcome, "changed");
    assert_eq!(result.message, UNDO_CHANGED_MESSAGE);
    let backup = result.files[0]
        .backup_path
        .clone()
        .expect("备份可在访达中显示");
    assert_eq!(fs::read_to_string(backup).unwrap(), original);
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "model = \"edited\"\r\n"
    );
}

#[test]
fn batch_removes_what_it_can_and_says_why_for_the_rest() {
    let tree = TempTree::new();
    let source = tree.root().join("source.json");
    let cursor = tree.root().join("cursor.json");
    let inline = tree.root().join("inline.toml");
    let stale = tree.root().join("stale.json");
    fs::write(&source, SOURCE_JSON).unwrap();
    let cursor_original = br#"{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"abc"}},"fmt":{"command":"fmt"},"mine":{"command":"m"}}}"#;
    fs::write(&cursor, cursor_original).unwrap();
    // 根上一整张内联表：单独拿不掉，拒绝而不是重写整张表
    let inline_original =
        "mcp_servers = { fmt = { command = \"fmt\" }, x = { command = \"x\" } }\n";
    fs::write(&inline, inline_original).unwrap();
    fs::write(&stale, br#"{"mcpServers":{"fmt":{"command":"fmt"}}}"#).unwrap();
    let locations = vec![
        loc("source", "claude-code", &source, None),
        loc("cursor", "cursor", &cursor, None),
        loc("inline", "codex", &inline, None),
        loc("stale", "cursor", &stale, None),
    ];
    let plan = prepare_original_removal(
        &locations,
        &[
            // 同一个文件里的两项：一次备份、一次写
            item("cursor", "docs"),
            item("cursor", "fmt"),
            // 同一项选了两次只删一次
            item("cursor", "docs"),
            item("inline", "fmt"),
            // 哪一行的来源都一样能删：不再有「批量不删原件」
            item("source", "fmt"),
            item("cursor", "gone"),
            item("stale", "fmt"),
        ],
    );
    assert_eq!(plan.actions.len(), 4);
    // 预览之后被别的程序改过：执行时整组拒绝，别的文件照常
    fs::write(&stale, br#"{"mcpServers":{"fmt":{"command":"fmt"}},"x":1}"#).unwrap();
    let mut report = execute_removal(plan);

    let docs = outcome(&report, "cursor", "docs");
    let fmt = outcome(&report, "cursor", "fmt");
    assert_eq!(
        (docs.outcome.as_str(), fmt.outcome.as_str()),
        ("removed", "removed")
    );
    assert_eq!(docs.backup_path, fmt.backup_path);
    assert_eq!(
        fs::read(&cursor).unwrap(),
        br#"{"mcpServers":{"mine":{"command":"m"}}}"#
    );

    let inline_entry = outcome(&report, "inline", "fmt");
    assert_eq!(inline_entry.outcome, "skipped");
    assert_eq!(inline_entry.message, CANNOT_CUT);
    assert_eq!(fs::read_to_string(&inline).unwrap(), inline_original);

    assert_eq!(outcome(&report, "source", "fmt").outcome, "removed");
    assert_eq!(
        fs::read(&source).unwrap(),
        br#"{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"abc"}}}}"#
    );
    let gone = outcome(&report, "cursor", "gone");
    assert_eq!(gone.outcome, "skipped");
    assert_eq!(gone.message, "这里已经没有它了");

    let stale_entry = outcome(&report, "stale", "fmt");
    assert_eq!(stale_entry.outcome, "failed");
    assert_eq!(stale_entry.message, "配置在预览后发生变化");
    assert_eq!(report.entries.len(), 6);

    // 一批一个撤销记录，只涉及真的写了的那几个文件
    let undo = report.take_undo().unwrap();
    let mut paths: Vec<&Path> = undo.target_paths().collect();
    paths.sort();
    assert_eq!(paths, vec![cursor.as_path(), source.as_path()]);
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read(&cursor).unwrap(), cursor_original);
    assert_eq!(fs::read(&source).unwrap(), SOURCE_JSON);
}

/// 拿不掉的说法（DESIGN「文案语域」：「无法 + 动词」）
#[test]
fn 拿不掉的说法_按_d24_写全() {
    assert_eq!(CANNOT_CUT, "这一项的写法无法安全地单独拿掉，没有改动");
}

fn delete_original(locations: &[McpLocation], location: &str, name: &str) -> McpReport {
    remove(locations, &[item(location, name)])
}

/// 行的来源那一处也一样删（DESIGN「删除原件」MCP）：只切掉这个位置里的这一项，其余字节原样；
/// 别的位置里的同名定义不动；留撤销记录，撤销逐字节还原
#[test]
fn the_original_is_cut_out_of_its_own_location_and_can_be_undone() {
    let tree = TempTree::new();
    let copy = br#"{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"abc"}}}}"#;
    let (locations, target) = json_tree(&tree, copy);
    let source = locations[0].path.clone();

    let plan = prepare_original_removal(&locations, &[item("source", "docs")]);
    assert_eq!(plan.actions.len(), 1);
    assert_eq!(plan.actions[0].target_id, "source");
    let mut report = execute_removal(plan);
    let entry = outcome(&report, "source", "docs");
    assert_eq!(entry.outcome, "removed", "{}", entry.message);
    let backup = entry.backup_path.clone().expect("删前先备份");
    assert_eq!(fs::read(backup).unwrap(), SOURCE_JSON);
    assert_eq!(
        fs::read(&source).unwrap(),
        br#"{"mcpServers":{"fmt":{"command":"fmt"}}}"#
    );
    // 别的 agent 里的同名定义不受影响
    assert_eq!(fs::read(&target).unwrap(), copy);

    let undo = report.take_undo().expect("删原件同样可撤销");
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read(&source).unwrap(), SOURCE_JSON);
}

#[test]
fn the_original_in_toml_and_claude_local_keeps_the_rest_byte_for_byte() {
    let tree = TempTree::new();
    let codex = tree.root().join("config.toml");
    let original =
        "\u{feff}model = \"gpt-5\"\r\n\r\n[mcp_servers.docs]\r\ncommand = \"docs\"\r\n\r\n\
        [mcp_servers.mine]\r\ncommand = \"mine\"";
    fs::write(&codex, original).unwrap();
    let claude = tree.root().join(".claude.json");
    let shared = r#"{
  "mcpServers": {"docs": {"command": "docs"}},
  "projects": {"/p": {"mcpServers": {"docs": {"command": "local"}, "keep": {"command": "k"}}}}
}
"#;
    fs::write(&claude, shared).unwrap();
    let locations = vec![
        loc("codex", "codex", &codex, None),
        loc("user", "claude-code", &claude, None),
        loc("local", "claude-code", &claude, Some("/p")),
    ];

    let report = delete_original(&locations, "codex", "docs");
    assert_eq!(outcome(&report, "codex", "docs").outcome, "removed");
    assert_eq!(
        fs::read_to_string(&codex).unwrap(),
        "\u{feff}model = \"gpt-5\"\r\n\r\n[mcp_servers.mine]\r\ncommand = \"mine\""
    );

    // Claude Local：只动这个项目作用域里的那一项，同一个文件里 User 的同名定义不动
    let report = delete_original(&locations, "local", "docs");
    assert_eq!(outcome(&report, "local", "docs").outcome, "removed");
    assert_eq!(
        fs::read_to_string(&claude).unwrap(),
        r#"{
  "mcpServers": {"docs": {"command": "docs"}},
  "projects": {"/p": {"mcpServers": {"keep": {"command": "k"}}}}
}
"#
    );
}

/// 拿不掉的写法、已经不在的、WeiboAP 里的、不存在的位置：如实拒绝，文件一个字节都不动
#[test]
fn deleting_an_original_refuses_honestly_and_touches_nothing() {
    let tree = TempTree::new();
    let inline = tree.root().join("inline.toml");
    let inline_original =
        "mcp_servers = { fmt = { command = \"fmt\" }, x = { command = \"x\" } }\n";
    fs::write(&inline, inline_original).unwrap();
    let weibo = tree.root().join("weibo.json");
    fs::write(&weibo, br#"{"mcpServers":{"fmt":{"command":"fmt"}}}"#).unwrap();
    let locations = vec![
        loc("inline", "codex", &inline, None),
        loc("weibo", "weiboap", &weibo, None),
    ];
    for (location, name, message) in [
        ("inline", "fmt", CANNOT_CUT),
        ("inline", "gone", "这里已经没有它了"),
        ("weibo", "fmt", WEIBO_MESSAGE),
        ("nowhere", "fmt", "这个位置已经不在了"),
    ] {
        let plan = prepare_original_removal(&locations, &[item(location, name)]);
        assert!(plan.actions.is_empty());
        let mut report = execute_removal(plan);
        let entry = outcome(&report, location, name);
        assert_eq!(entry.outcome, "skipped");
        assert_eq!(entry.message, message);
        assert!(report.take_undo().is_none());
    }
    assert_eq!(fs::read_to_string(&inline).unwrap(), inline_original);
    assert_eq!(
        fs::read(&weibo).unwrap(),
        br#"{"mcpServers":{"fmt":{"command":"fmt"}}}"#
    );
}

/// 体检之后文件被别的程序改过：执行时拒绝，不覆盖别人的改动
#[test]
fn deleting_an_original_refuses_when_the_file_changed_after_the_check() {
    let tree = TempTree::new();
    let (locations, _) = json_tree(&tree, b"{}");
    let source = locations[0].path.clone();
    let plan = prepare_original_removal(&locations, &[item("source", "docs")]);
    let edited = br#"{"mcpServers":{"docs":{"command":"docs"},"fmt":{"command":"fmt"}},"x":1}"#;
    fs::write(&source, edited).unwrap();
    let mut report = execute_removal(plan);
    let entry = outcome(&report, "source", "docs");
    assert_eq!(entry.outcome, "failed");
    assert_eq!(entry.message, "配置在预览后发生变化");
    assert!(report.take_undo().is_none());
    assert_eq!(fs::read(&source).unwrap(), edited);
}

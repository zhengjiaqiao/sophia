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

fn sel(source: &str, name: &str, target: &str) -> McpSelection {
    McpSelection {
        source_id: source.into(),
        name: name.into(),
        target_id: target.into(),
    }
}

fn remove(locations: &[McpLocation], selections: &[McpSelection]) -> McpReport {
    execute_removal(prepare_removal(locations, selections))
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

/// 来源 source.json（Claude Code 写法）+ 一个 Cursor 的副本文件
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
fn json_copy_is_cut_out_and_the_rest_is_byte_for_byte() {
    let tree = TempTree::new();
    // CRLF、四格缩进、别的根字段、末行没有换行
    let original = "{\r\n    \"theme\": \"dark\",\r\n    \"mcpServers\": {\r\n        \"docs\": {\"command\": \"docs\", \"env\": {\"TOKEN\": \"abc\"}},\r\n        \"mine\": {\"command\": \"mine\"}\r\n    },\r\n    \"z\": [1, 2]\r\n}";
    let (locations, target) = json_tree(&tree, original.as_bytes());

    let report = remove(&locations, &[sel("source", "docs", "target")]);
    let entry = outcome(&report, "target", "docs");
    assert_eq!(entry.outcome, "removed", "{}", entry.message);
    assert_eq!(entry.identical, Some(true));
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "{\r\n    \"theme\": \"dark\",\r\n    \"mcpServers\": {\r\n        \"mine\": {\"command\": \"mine\"}\r\n    },\r\n    \"z\": [1, 2]\r\n}"
    );
    // 备份就是移除前的原样
    let backup = entry.backup_path.clone().expect("有备份");
    assert_eq!(fs::read(backup).unwrap(), original.as_bytes());
    // 来源一个字节没动
    assert_eq!(fs::read(&locations[0].path).unwrap(), SOURCE_JSON);
}

#[test]
fn toml_copy_keeps_bom_crlf_comments_and_missing_final_newline() {
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

    let report = remove(&locations, &[sel("source", "docs", "codex")]);
    let entry = outcome(&report, "codex", "docs");
    assert_eq!(entry.outcome, "removed", "{}", entry.message);
    assert_eq!(entry.identical, Some(true));
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "\u{feff}# Codex 配置\r\nmodel = \"gpt-5\"   # 行尾注释\r\n\r\n\
        # mine 的说明\r\n[mcp_servers.mine]\r\ncommand = \"mine\"\r\n\r\n[profiles.fast]\r\nmodel = \"o4\""
    );
}

#[test]
fn claude_local_copy_is_removed_from_the_shared_file_only_in_its_scope() {
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
    let report = remove(&locations, &[sel("user", "docs", "local")]);
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
fn the_original_cannot_be_removed() {
    let tree = TempTree::new();
    let (mut locations, target) =
        json_tree(&tree, br#"{"mcpServers":{"docs":{"command":"docs"}}}"#);
    // 另一个 id 指着同一个文件的同一个作用域：还是原件
    let alias = loc("alias", "claude-code", &locations[0].path.clone(), None);
    locations.push(alias);
    let mut report = remove(
        &locations,
        &[
            sel("source", "docs", "source"),
            sel("source", "docs", "alias"),
        ],
    );
    for id in ["source", "alias"] {
        let entry = outcome(&report, id, "docs");
        assert_eq!(entry.outcome, "skipped");
        assert_eq!(entry.message, ORIGINAL_MESSAGE);
    }
    assert!(report.take_undo().is_none());
    assert_eq!(fs::read(&locations[0].path).unwrap(), SOURCE_JSON);
    assert_eq!(
        fs::read(&target).unwrap(),
        br#"{"mcpServers":{"docs":{"command":"docs"}}}"#
    );
}

#[test]
fn identical_flag_follows_the_source_version() {
    let tree = TempTree::new();
    let source = tree.root().join("source.json");
    let same = tree.root().join("same.json");
    let token = tree.root().join("token.json");
    let codex_source = tree.root().join("codex-src.toml");
    let codex_copy = tree.root().join("codex-copy.toml");
    fs::write(&source, SOURCE_JSON).unwrap();
    // 键的顺序、缩进不同，内容一样
    fs::write(
        &same,
        b"{ \"mcpServers\": { \"docs\": { \"env\": {\"TOKEN\": \"abc\"}, \"command\": \"docs\" } } }",
    )
    .unwrap();
    // 在那个位置手改过令牌：`2 份不一样`
    fs::write(
        &token,
        br#"{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"xyz"}}}}"#,
    )
    .unwrap();
    // 同 agent（Codex）：连接一样，但客户端设置改过，再写回也回不来
    fs::write(
        &codex_source,
        "[mcp_servers.fmt]\ncommand = \"fmt\"\nstartup_timeout_sec = 10\n",
    )
    .unwrap();
    fs::write(
        &codex_copy,
        "[mcp_servers.fmt]\ncommand = \"fmt\"\nstartup_timeout_sec = 60\n",
    )
    .unwrap();
    let locations = vec![
        loc("source", "claude-code", &source, None),
        loc("same", "cursor", &same, None),
        loc("token", "cursor", &token, None),
        loc("codex-src", "codex", &codex_source, None),
        loc("codex-copy", "codex", &codex_copy, None),
    ];
    let plan = prepare_removal(
        &locations,
        &[
            sel("source", "docs", "same"),
            sel("source", "docs", "token"),
            sel("codex-src", "fmt", "codex-copy"),
        ],
    );
    let identical: BTreeMap<&str, bool> = plan
        .actions
        .iter()
        .map(|a| (a.target_id.as_str(), a.identical))
        .collect();
    assert_eq!(
        identical,
        [("codex-copy", false), ("same", true), ("token", false)].into()
    );
    // 与「N 份不一样」同一个事实：令牌那份的字段级差异不为空，一样的那份为空
    let diff =
        |id: &str| crate::mcp::diff_fields(&locations, "docs", &["source".into(), id.into()]);
    assert!(diff("same").fields.is_empty());
    assert_eq!(diff("token").fields[0].field, "env.TOKEN");

    let report = execute_removal(plan);
    assert_eq!(outcome(&report, "same", "docs").identical, Some(true));
    assert_eq!(outcome(&report, "token", "docs").identical, Some(false));
    assert_eq!(outcome(&report, "codex-copy", "fmt").identical, Some(false));
    let json = serde_json::to_value(outcome(&report, "token", "docs")).unwrap();
    assert_eq!(json["identical"], false);
}

#[test]
fn undo_restores_the_removed_copy_byte_for_byte() {
    let tree = TempTree::new();
    let original = "{\n  \"mcpServers\": {\n    \"docs\": {\"command\": \"docs\", \"env\": {\"TOKEN\": \"xyz\"}}\n  }\n}\n";
    let (locations, target) = json_tree(&tree, original.as_bytes());
    let mut report = remove(&locations, &[sel("source", "docs", "target")]);
    assert_eq!(outcome(&report, "target", "docs").identical, Some(false));
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
    let mut report = remove(&locations, &[sel("source", "fmt", "codex")]);
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
    let plan = prepare_removal(
        &locations,
        &[
            // 同一个文件里的两项：一次备份、一次写
            sel("source", "docs", "cursor"),
            sel("source", "fmt", "cursor"),
            sel("source", "fmt", "inline"),
            sel("source", "fmt", "source"),
            sel("source", "gone", "cursor"),
            sel("source", "fmt", "stale"),
        ],
    );
    assert_eq!(plan.actions.len(), 3);
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

    assert_eq!(outcome(&report, "source", "fmt").message, ORIGINAL_MESSAGE);
    assert!(outcome(&report, "cursor", "gone")
        .message
        .contains("来源里已经没有它了"));

    let stale_entry = outcome(&report, "stale", "fmt");
    assert_eq!(stale_entry.outcome, "failed");
    assert_eq!(stale_entry.message, "配置在预览后发生变化");
    assert_eq!(stale_entry.identical, None);
    assert_eq!(report.entries.len(), 6);

    // 撤销只涉及真的写了的那个文件
    let undo = report.take_undo().unwrap();
    assert_eq!(
        undo.target_paths().collect::<Vec<_>>(),
        vec![cursor.as_path()]
    );
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read(&cursor).unwrap(), cursor_original);
}

/// 批量移除跳过原件时说的话与前端 `src/cellTip.ts` 的 `MCP_OWN_TIP` 是同一句（DESIGN「文案语域」、
/// 「删除原件」）：原件格可删之后，去处写成点这一格；文案语域是「无法 + 动词」
#[test]
fn 原件格与拿不掉的说法_按_d24_写全() {
    assert_eq!(
        ORIGINAL_MESSAGE,
        "这是原件所在的位置，批量移除不删它 · 要删掉，点这一格"
    );
    assert!(!ORIGINAL_MESSAGE.contains("来源管理页"));
    assert_eq!(CANNOT_CUT, "这一项的写法无法安全地单独拿掉，没有改动");
}

fn delete_original(locations: &[McpLocation], location: &str, name: &str) -> McpReport {
    execute_removal(prepare_original_removal(locations, location, name))
}

/// 删原件（DESIGN「删除原件」）：只切掉这个位置里的这一项，其余字节原样；别的位置里的同名定义不动；
/// 留撤销记录，撤销逐字节还原
#[test]
fn the_original_is_cut_out_of_its_own_location_and_can_be_undone() {
    let tree = TempTree::new();
    let copy = br#"{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"abc"}}}}"#;
    let (locations, target) = json_tree(&tree, copy);
    let source = locations[0].path.clone();

    let plan = prepare_original_removal(&locations, "source", "docs");
    assert_eq!(plan.actions.len(), 1);
    assert_eq!(plan.actions[0].source_id, "source");
    assert_eq!(plan.actions[0].target_id, "source");
    assert!(!plan.actions[0].identical);
    let mut report = execute_removal(plan);
    let entry = outcome(&report, "source", "docs");
    assert_eq!(entry.outcome, "removed", "{}", entry.message);
    assert_eq!(entry.identical, Some(false));
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
        let plan = prepare_original_removal(&locations, location, name);
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
    let plan = prepare_original_removal(&locations, "source", "docs");
    let edited = br#"{"mcpServers":{"docs":{"command":"docs"},"fmt":{"command":"fmt"}},"x":1}"#;
    fs::write(&source, edited).unwrap();
    let mut report = execute_removal(plan);
    let entry = outcome(&report, "source", "docs");
    assert_eq!(entry.outcome, "failed");
    assert_eq!(entry.message, "配置在预览后发生变化");
    assert!(report.take_undo().is_none());
    assert_eq!(fs::read(&source).unwrap(), edited);
}

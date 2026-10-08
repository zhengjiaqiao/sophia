//! 「保留这份」（issue #114，spec 2026-10-05-skill-mcp-batch2「MCP 页（S4）」）：以选中位置的定义为准，
//! 改写其他位置同名服务的定义，保留各 agent 专属写法里与定义无关的字段；一次撤销全部退回；
//! 一处写不成时其余不动。真实临时文件树，不 mock 文件系统
use serde_json::json;
use sophia_core::mcp::{
    diff_fields, execute_keep, keep_revision, prepare_keep, prepare_keep_seen, scan, undo_write,
    McpCellState, McpLocation,
};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

/// 备份根目录：整个测试进程共用一份临时目录，不碰真实数据目录
fn backups() -> &'static Path {
    static DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    DIR.get_or_init(|| tempfile::tempdir().unwrap()).path()
}

/// 临时目录先 canonicalize：macOS 上 /var 是软链，atomicfile 拒绝父路径里的软链
fn root(t: &tempfile::TempDir) -> PathBuf {
    fs::canonicalize(t.path()).unwrap()
}

fn loc(id: &str, path: &Path, harness_id: &str, domain: &str) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: harness_id.into(),
        domain: domain.into(),
        path: path.to_path_buf(),
        selector: None,
        matrix_hidden: false,
        mirrors: Vec::new(),
    }
}

fn state(locations: &[McpLocation], source: &str, target: &str) -> McpCellState {
    scan(locations)
        .entries
        .iter()
        .find(|entry| entry.source_id == source && entry.name == "docs")
        .unwrap()
        .cells
        .iter()
        .find(|cell| cell.target_id == target)
        .unwrap()
        .state
}

const CLAUDE: &str = r#"{
  "unrelated": 1.50,
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://docs.test/mcp",
      "headers": { "Authorization": "Bearer aaaa1111bbbb7f3a" }
    },
    "other": { "command": "x" }
  }
}
"#;

const CODEX: &str = "model = \"gpt-5\"\r\n\r\n[mcp_servers.docs]\r\nurl = \"https://docs.test/v2/mcp\"\r\nhttp_headers = { Authorization = \"Bearer cccc2222dddd91c0\" }\r\nstartup_timeout_sec = 30\r\n\r\n[mcp_servers.other]\r\ncommand = \"y\"\r\n";

const GEMINI: &str = r#"{
  "theme": "dark",
  "mcpServers": {
    "docs": { "httpUrl": "https://docs.test/old", "trust": true, "timeout": 5000 }
  }
}
"#;

/// 三个位置（Claude Code JSON、Codex TOML、Gemini JSON）各一份不一样的 docs
fn three(t: &tempfile::TempDir) -> (Vec<McpLocation>, [PathBuf; 3]) {
    let dir = root(t);
    let claude = dir.join("claude.json");
    let codex = dir.join("config.toml");
    let gemini = dir.join("settings.json");
    fs::write(&claude, CLAUDE).unwrap();
    fs::write(&codex, CODEX).unwrap();
    fs::write(&gemini, GEMINI).unwrap();
    let locations = vec![
        loc("claude", &claude, "claude-code", "global"),
        loc("codex", &codex, "codex", "global"),
        loc("gemini", &gemini, "gemini-cli", "global"),
    ];
    (locations, [claude, codex, gemini])
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

#[test]
fn keeping_one_copy_rewrites_the_others_and_keeps_agent_only_fields() {
    let t = tempdir().unwrap();
    let (locations, [claude, codex, gemini]) = three(&t);
    let all = ids(&["claude", "codex", "gemini"]);
    assert_eq!(state(&locations, "claude", "codex"), McpCellState::Conflict);
    assert_eq!(
        state(&locations, "claude", "gemini"),
        McpCellState::Conflict
    );

    let plan = prepare_keep(&locations, "docs", "claude", &all);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let mut targets: Vec<&str> = plan.actions.iter().map(|a| a.target_id.as_str()).collect();
    targets.sort();
    assert_eq!(targets, ["codex", "gemini"]);
    let report = execute_keep(plan, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "updated"),
        "{:?}",
        report.entries
    );
    assert_eq!(report.entries.len(), 2);
    assert!(report.entries.iter().all(|e| e.backup_path.is_some()));

    // 选中的那一份一个字节都不动
    assert_eq!(fs::read_to_string(&claude).unwrap(), CLAUDE);
    // 另两份与它一致：扫描看是一样的
    assert_eq!(state(&locations, "claude", "codex"), McpCellState::Equal);
    assert_eq!(state(&locations, "claude", "gemini"), McpCellState::Equal);

    // Codex：地址与请求头换成选中的那份，客户端字段（startup_timeout_sec）留着；别的服务、根上的键不动
    let text = fs::read_to_string(&codex).unwrap();
    let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
    let docs = &doc["mcp_servers"]["docs"];
    assert_eq!(docs["url"].as_str(), Some("https://docs.test/mcp"));
    assert_eq!(
        docs["http_headers"]["Authorization"].as_str(),
        Some("Bearer aaaa1111bbbb7f3a")
    );
    assert_eq!(docs["startup_timeout_sec"].as_integer(), Some(30));
    assert_eq!(doc["mcp_servers"]["other"]["command"].as_str(), Some("y"));
    assert_eq!(doc["model"].as_str(), Some("gpt-5"));
    assert!(text.starts_with("model = \"gpt-5\"\r\n"), "{text}");
    assert!(
        !text.replace("\r\n", "").contains('\n'),
        "换行跟随原文件：{text:?}"
    );

    // Gemini：Streamable HTTP 写成 httpUrl，请求头换过来；trust、timeout 留着；别的设置不动
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&gemini).unwrap()).unwrap();
    assert_eq!(
        written,
        json!({
            "theme": "dark",
            "mcpServers": {"docs": {
                "httpUrl": "https://docs.test/mcp",
                "headers": {"Authorization": "Bearer aaaa1111bbbb7f3a"},
                "trust": true,
                "timeout": 5000
            }}
        })
    );
    let gemini_text = fs::read_to_string(&gemini).unwrap();
    assert!(
        gemini_text.starts_with("{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"docs\": "),
        "原位换值，前面的字节不动：{gemini_text}"
    );
}

#[test]
fn one_undo_restores_every_rewritten_file_byte_for_byte() {
    let t = tempdir().unwrap();
    let (locations, [claude, codex, gemini]) = three(&t);
    let mut report = execute_keep(
        prepare_keep(
            &locations,
            "docs",
            "codex",
            &ids(&["claude", "codex", "gemini"]),
        ),
        backups(),
    );
    assert!(
        report.entries.iter().all(|e| e.outcome == "updated"),
        "{:?}",
        report.entries
    );
    assert_ne!(fs::read_to_string(&claude).unwrap(), CLAUDE);
    assert_ne!(fs::read_to_string(&gemini).unwrap(), GEMINI);
    // Claude Code 的 JSON 里没有 Codex 的客户端字段：只换连接字段
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&claude).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["docs"],
        json!({"type": "http", "url": "https://docs.test/v2/mcp",
               "headers": {"Authorization": "Bearer cccc2222dddd91c0"}})
    );
    assert_eq!(written["mcpServers"]["other"], json!({"command": "x"}));

    let undo = report.take_undo().expect("改写可撤销");
    assert_eq!(undo.target_paths().count(), 2);
    let undone = undo_write(&undo);
    assert_eq!(undone.outcome, "undone", "{undone:?}");
    assert_eq!(fs::read_to_string(&claude).unwrap(), CLAUDE);
    assert_eq!(fs::read_to_string(&codex).unwrap(), CODEX);
    assert_eq!(fs::read_to_string(&gemini).unwrap(), GEMINI);
}

/// 写到一半失败：已经写成的那一处退回原样，失败的那一处报出来，不给撤销
#[cfg(unix)]
#[test]
fn a_failed_write_leaves_every_file_untouched_and_is_reported() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempdir().unwrap();
    let dir = root(&t);
    // 按路径先后执行：a 先写成，z 那个目录只读、写不进去
    let ok_dir = dir.join("a");
    let ro_dir = dir.join("z");
    fs::create_dir_all(&ok_dir).unwrap();
    fs::create_dir_all(&ro_dir).unwrap();
    let source = dir.join("claude.json");
    let first = ok_dir.join("settings.json");
    let second = ro_dir.join("config.toml");
    fs::write(&source, CLAUDE).unwrap();
    fs::write(&first, GEMINI).unwrap();
    fs::write(&second, CODEX).unwrap();
    let locations = vec![
        loc("claude", &source, "claude-code", "global"),
        loc("gemini", &first, "gemini-cli", "global"),
        loc("codex", &second, "codex", "global"),
    ];
    let plan = prepare_keep(
        &locations,
        "docs",
        "claude",
        &ids(&["claude", "gemini", "codex"]),
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    fs::set_permissions(&ro_dir, fs::Permissions::from_mode(0o555)).unwrap();
    let mut report = execute_keep(plan, backups());
    fs::set_permissions(&ro_dir, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(fs::read_to_string(&source).unwrap(), CLAUDE);
    assert_eq!(
        fs::read_to_string(&first).unwrap(),
        GEMINI,
        "写成的那一处退回了"
    );
    assert_eq!(fs::read_to_string(&second).unwrap(), CODEX);
    let failed = report
        .entries
        .iter()
        .find(|e| e.target_id == "codex")
        .unwrap();
    assert_eq!(failed.outcome, "failed", "{:?}", report.entries);
    assert!(!failed.message.is_empty());
    let other = report
        .entries
        .iter()
        .find(|e| e.target_id == "gemini")
        .unwrap();
    assert_eq!(other.outcome, "skipped", "{:?}", report.entries);
    assert!(report.take_undo().is_none(), "什么都没改，不给撤销");
}

/// 某一处接不住选中的那份（Cursor 写不出 SSE）：整次不动，计划里说清是哪一处、为什么；
/// 差异里这一份的「保留这份」带着同一个原因
#[test]
fn a_target_that_cannot_take_the_copy_blocks_the_whole_keep() {
    let t = tempdir().unwrap();
    let dir = root(&t);
    let claude = dir.join("claude.json");
    let cursor = dir.join("mcp.json");
    let codex = dir.join("config.toml");
    let claude_text = r#"{"mcpServers":{"docs":{"type":"sse","url":"https://docs.test/sse"}}}"#;
    let cursor_text = r#"{"mcpServers":{"docs":{"url":"https://docs.test/mcp"}}}"#;
    fs::write(&claude, claude_text).unwrap();
    fs::write(&cursor, cursor_text).unwrap();
    fs::write(&codex, CODEX).unwrap();
    let locations = vec![
        loc("claude", &claude, "claude-code", "global"),
        loc("cursor", &cursor, "cursor", "global"),
        loc("codex", &codex, "codex", "global"),
    ];
    let all = ids(&["claude", "cursor", "codex"]);
    let plan = prepare_keep(&locations, "docs", "claude", &all);
    assert!(plan
        .issues
        .iter()
        .any(|issue| issue.location_id == "cursor" && issue.message.contains("SSE")));
    let report = execute_keep(plan, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome != "updated"),
        "{:?}",
        report.entries
    );
    assert_eq!(fs::read_to_string(&cursor).unwrap(), cursor_text);
    assert_eq!(fs::read_to_string(&codex).unwrap(), CODEX);

    let diff = diff_fields(&locations, "docs", &all);
    assert_eq!(diff.keep_blocked.len(), 3);
    let blocked = diff.keep_blocked[0].as_ref().expect("Claude 那份留不了");
    assert_eq!(blocked.location_id, "cursor");
    // 留 Cursor 那份：Claude Code、Codex 都接得住
    assert!(diff.keep_blocked[1].is_none(), "{:?}", diff.keep_blocked);
}

/// 项目级与用户级混在同一个文件里（~/.claude.json 的根与 projects.<路径>）：只改项目那一段，根上那份不动
#[test]
fn claude_local_scope_is_rewritten_without_touching_the_user_scope() {
    let t = tempdir().unwrap();
    let dir = root(&t);
    let claude = dir.join(".claude.json");
    let team = dir.join(".mcp.json");
    let project = dir.join("w").to_string_lossy().into_owned();
    let claude_text = format!(
        "{{\n  \"mcpServers\": {{\"docs\": {{\"command\": \"user-docs\"}}}},\n  \"projects\": {{\n    \"{project}\": {{\"mcpServers\": {{\"docs\": {{\"command\": \"old\", \"args\": [\"-v\"]}}}}}}\n  }}\n}}\n"
    );
    fs::write(&claude, &claude_text).unwrap();
    fs::write(
        &team,
        r#"{"mcpServers":{"docs":{"command":"npx","args":["-y","docs-mcp"],"env":{"TOKEN":"tok_1234567890abcd"}}}}"#,
    )
    .unwrap();
    let mut local = loc("local", &claude, "claude-code", "project:/w");
    local.selector = Some(project.clone());
    let locations = vec![loc("team", &team, "claude-code", "project:/w"), local];
    let mut report = execute_keep(
        prepare_keep(&locations, "docs", "team", &ids(&["team", "local"])),
        backups(),
    );
    assert_eq!(report.entries.len(), 1, "{:?}", report.entries);
    assert_eq!(report.entries[0].outcome, "updated");
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&claude).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["docs"],
        json!({"command": "user-docs"})
    );
    assert_eq!(
        written["projects"][project.as_str()]["mcpServers"]["docs"],
        json!({"type": "stdio", "command": "npx", "args": ["-y", "docs-mcp"],
               "env": {"TOKEN": "tok_1234567890abcd"}})
    );
    let undo = report.take_undo().unwrap();
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read_to_string(&claude).unwrap(), claude_text);
}

/// 已经一样的那一处不重写；只剩选中的那一处时没什么可改
#[test]
fn copies_that_already_match_are_left_alone() {
    let t = tempdir().unwrap();
    let (locations, [_, _, gemini]) = three(&t);
    let first = execute_keep(
        prepare_keep(&locations, "docs", "claude", &ids(&["claude", "gemini"])),
        backups(),
    );
    assert_eq!(first.entries.len(), 1);
    let after = fs::read(&gemini).unwrap();
    let again = prepare_keep(&locations, "docs", "claude", &ids(&["claude", "gemini"]));
    assert!(again.actions.is_empty() && again.issues.is_empty());
    let report = execute_keep(again, backups());
    assert!(report.entries.is_empty());
    assert_eq!(fs::read(&gemini).unwrap(), after);
}

/// Codex 的内联写法（根上一整张 `mcp_servers = { … }`，删不掉单行）：就地换掉那一段内联值，客户端字段留着
#[test]
fn codex_inline_servers_are_rewritten_in_place() {
    let t = tempdir().unwrap();
    let dir = root(&t);
    let claude = dir.join("claude.json");
    let codex = dir.join("config.toml");
    fs::write(&claude, CLAUDE).unwrap();
    let before = "model = \"gpt-5\"\nmcp_servers = { docs = { url = \"https://docs.test/v2/mcp\", startup_timeout_sec = 30 }, other = { command = \"y\" } }\n";
    fs::write(&codex, before).unwrap();
    let locations = vec![
        loc("claude", &claude, "claude-code", "global"),
        loc("codex", &codex, "codex", "global"),
    ];
    let mut report = execute_keep(
        prepare_keep(&locations, "docs", "claude", &ids(&["claude", "codex"])),
        backups(),
    );
    assert_eq!(report.entries[0].outcome, "updated", "{:?}", report.entries);
    let text = fs::read_to_string(&codex).unwrap();
    assert!(
        text.starts_with("model = \"gpt-5\"\nmcp_servers = { docs = {"),
        "{text}"
    );
    assert!(
        text.ends_with(", other = { command = \"y\" } }\n"),
        "{text}"
    );
    let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
    assert_eq!(
        doc["mcp_servers"]["docs"]["url"].as_str(),
        Some("https://docs.test/mcp")
    );
    assert_eq!(
        doc["mcp_servers"]["docs"]["startup_timeout_sec"].as_integer(),
        Some(30)
    );
    assert_eq!(state(&locations, "claude", "codex"), McpCellState::Equal);
    assert_eq!(undo_write(&report.take_undo().unwrap()).outcome, "undone");
    assert_eq!(fs::read_to_string(&codex).unwrap(), before);
}

/// 体检之后选中的那一份又被改了：照旧的定义去改别处会对不上，一处都不动
#[test]
fn a_kept_copy_changed_after_planning_blocks_the_keep() {
    let t = tempdir().unwrap();
    let (locations, [claude, codex, gemini]) = three(&t);
    let plan = prepare_keep(
        &locations,
        "docs",
        "claude",
        &ids(&["claude", "codex", "gemini"]),
    );
    assert!(plan.issues.is_empty());
    fs::write(&claude, CLAUDE.replace("docs.test/mcp", "docs.test/v3")).unwrap();
    let report = execute_keep(plan, backups());
    let failed = report
        .entries
        .iter()
        .find(|e| e.outcome == "failed")
        .unwrap();
    assert_eq!(failed.target_id, "claude");
    assert!(report.entries.iter().all(|e| e.outcome != "updated"));
    assert_eq!(fs::read_to_string(&codex).unwrap(), CODEX);
    assert_eq!(fs::read_to_string(&gemini).unwrap(), GEMINI);
}

/// Gemini 的 `cwd`、`oauth` 属于定义：跟着选中的那份走（同一家），别家接不住时整次不改；
/// `trust` 这类与定义无关的留目标自己的
#[test]
fn gemini_cwd_follows_the_kept_copy_and_blocks_other_agents() {
    let t = tempdir().unwrap();
    let dir = root(&t);
    fs::create_dir_all(dir.join("p")).unwrap();
    let user = dir.join("settings.json");
    let project = dir.join("p").join("settings.json");
    let claude = dir.join("claude.json");
    fs::write(
        &user,
        r#"{"mcpServers":{"docs":{"command":"node","args":["server.js"],"cwd":"/srv/mcp"}}}"#,
    )
    .unwrap();
    fs::write(
        &project,
        r#"{"mcpServers":{"docs":{"command":"node","args":["old.js"],"trust":true}}}"#,
    )
    .unwrap();
    let claude_text = r#"{"mcpServers":{"docs":{"command":"node","args":["other.js"]}}}"#;
    fs::write(&claude, claude_text).unwrap();
    let locations = vec![
        loc("user", &user, "gemini-cli", "global"),
        loc("project", &project, "gemini-cli", "project:/p"),
        loc("claude", &claude, "claude-code", "global"),
    ];
    // 带 cwd 的写不进 Claude Code：整次不改
    let blocked = prepare_keep(
        &locations,
        "docs",
        "user",
        &ids(&["user", "project", "claude"]),
    );
    assert!(
        blocked
            .issues
            .iter()
            .any(|i| i.location_id == "claude" && i.message.contains("cwd")),
        "{:?}",
        blocked.issues
    );
    // 同一家：cwd 跟过去，trust 留着
    let report = execute_keep(
        prepare_keep(&locations, "docs", "user", &ids(&["user", "project"])),
        backups(),
    );
    assert_eq!(report.entries[0].outcome, "updated", "{:?}", report.entries);
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["docs"],
        json!({"command": "node", "args": ["server.js"], "cwd": "/srv/mcp", "trust": true})
    );
    assert_eq!(fs::read_to_string(&claude).unwrap(), claude_text);
}

/// 确认时带回差异表的指纹：用户看过之后谁被改了，一处都不动；没变照常改
#[test]
fn keep_is_bound_to_the_copies_the_user_saw() {
    let t = tempdir().unwrap();
    let (locations, [claude, codex, gemini]) = three(&t);
    let all = ids(&["claude", "codex", "gemini"]);
    let seen = diff_fields(&locations, "docs", &all).revision;
    assert_eq!(seen, keep_revision(&locations, "docs", &all));
    // 文件别处变了不算（~/.claude.json 随时在变）
    fs::write(&claude, CLAUDE.replace("1.50", "2.50")).unwrap();
    assert_eq!(keep_revision(&locations, "docs", &all), seen);
    // 选中的那份变了：不动
    fs::write(&claude, CLAUDE.replace("docs.test/mcp", "docs.test/v3")).unwrap();
    let report = execute_keep(
        prepare_keep_seen(&locations, "docs", "claude", &all, &seen),
        backups(),
    );
    assert!(report.entries.iter().all(|e| e.outcome != "updated"));
    assert!(report
        .entries
        .iter()
        .any(|e| e.outcome == "failed" && e.target_id == "claude"));
    assert_eq!(fs::read_to_string(&codex).unwrap(), CODEX);
    assert_eq!(fs::read_to_string(&gemini).unwrap(), GEMINI);
    // 重新看过（新指纹）就照常改
    let fresh = diff_fields(&locations, "docs", &all).revision;
    let report = execute_keep(
        prepare_keep_seen(&locations, "docs", "claude", &all, &fresh),
        backups(),
    );
    assert!(
        report.entries.iter().all(|e| e.outcome == "updated"),
        "{:?}",
        report.entries
    );
}

/// 连接字段一样、只差 `cwd` 的那一处也要改：不能当作已经一样跳过
#[test]
fn a_copy_that_only_differs_in_cwd_is_rewritten() {
    let t = tempdir().unwrap();
    let dir = root(&t);
    let claude = dir.join("claude.json");
    let gemini = dir.join("settings.json");
    fs::write(
        &claude,
        r#"{"mcpServers":{"docs":{"command":"node","args":["server.js"]}}}"#,
    )
    .unwrap();
    fs::write(
        &gemini,
        r#"{"mcpServers":{"docs":{"command":"node","args":["server.js"],"cwd":"/old","trust":true}}}"#,
    )
    .unwrap();
    let locations = vec![
        loc("claude", &claude, "claude-code", "global"),
        loc("gemini", &gemini, "gemini-cli", "global"),
    ];
    // 差异表里看得到要改的 cwd
    let diff = diff_fields(&locations, "docs", &ids(&["claude", "gemini"]));
    assert_eq!(
        diff.fields
            .iter()
            .map(|f| f.field.as_str())
            .collect::<Vec<_>>(),
        ["cwd"]
    );
    let report = execute_keep(
        prepare_keep(&locations, "docs", "claude", &ids(&["claude", "gemini"])),
        backups(),
    );
    assert_eq!(report.entries.len(), 1, "{:?}", report.entries);
    let written: serde_json::Value = serde_json::from_slice(&fs::read(&gemini).unwrap()).unwrap();
    assert_eq!(
        written["mcpServers"]["docs"],
        json!({"command": "node", "args": ["server.js"], "trust": true})
    );
}

/// 分不出原因的失败（#306 复审）：没成的那一处 `message` 是兜底句、系统原文另给（`detail`），
/// 前端提示条只写失败句。备份目录的上一级是个文件：建不出备份目录，不是没权限、磁盘满、只读
#[test]
fn an_unclassified_failure_carries_the_raw_text_apart() {
    let t = tempdir().unwrap();
    let (locations, paths) = three(&t);
    let blocker = root(&t).join("not-a-dir");
    fs::write(&blocker, b"x").unwrap();
    let plan = prepare_keep(
        &locations,
        "docs",
        "claude",
        &ids(&["claude", "codex", "gemini"]),
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute_keep(plan, &blocker.join("backups"));
    let failed = report
        .entries
        .iter()
        .find(|e| e.outcome == "failed")
        .unwrap_or_else(|| panic!("{:?}", report.entries));
    assert_eq!(failed.message, "备份失败，未改动");
    assert!(
        failed.detail.as_deref().is_some_and(|d| !d.is_empty()),
        "{failed:?}"
    );
    assert_eq!(fs::read_to_string(&paths[1]).unwrap(), CODEX);
    assert_eq!(fs::read_to_string(&paths[2]).unwrap(), GEMINI);
}

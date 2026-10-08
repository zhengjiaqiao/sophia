//! DeepSeek Harness 的 MCP（#258）：桌面版补丁文件 `cordis.patch.yml` 里一条服务一行 `- insert:`，
//! 只增删 Sophia 自己的行（id `sophia-mcp-<名字>`）。全部在临时目录里搭真实文件，不碰本机配置
use super::*;
use crate::test_support::{backups, TempTree};

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

#[test]
fn location_is_the_desktop_profile_patch_without_a_project_level() {
    let t = TempTree::new();
    let home = t.root();
    let project = t.dir("work/app");
    let dsh = [harness("deepseek-harness", "DeepSeek Harness")];

    let found = locations(&env(&home, &[]), &dsh, std::slice::from_ref(&project));
    assert_eq!(found.len(), 1, "没有项目级：只有用户级一处");
    assert_eq!(found[0].id, "deepseek-harness");
    assert_eq!(found[0].label, "DeepSeek Harness");
    assert_eq!(
        found[0].path,
        home.join(".dsh/profiles/desktop/cordis.patch.yml")
    );

    // `$DSH_HOME` 换的是整个 `~/.dsh`
    let other = t.dir("elsewhere/dsh");
    let found = locations(
        &env(&home, &[("DSH_HOME", other.to_str().unwrap())]),
        &dsh,
        &[],
    );
    assert_eq!(
        found[0].path,
        other.join("profiles/desktop/cordis.patch.yml")
    );
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

/// 用户自己写的补丁：注释、改别的插件的一项、三个 MCP 服务器（一个用了 `!!js` 表达式）、一个别的插件
const USER_PATCH: &str = "\
# 我的补丁
- replace:
    id: llm-pi-ai
    config:
      providers: {}
- insert:
    - id: memory-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-memory']
        env: { MEMORY_FILE_PATH: /tmp/memory.json }
    - id: some-plugin
      name: '@someone/other-plugin'
      config: { a: 1 }
- insert:
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web
        transport: streamable-http
        url: http://localhost:3000/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
    - id: mcp-docs
      name: '@deepseek-ai/dsh-mcp-client'
      config: {serverName: docs, transport: streamable-http, url: 'https://docs.example/mcp'}
";

/// 补丁文件放在 `~/.dsh/profiles/desktop/` 下（桌面版那个 profile 已经建好）
fn dsh_tree(t: &TempTree, text: Option<&str>) -> McpLocation {
    let dir = t.dir(".dsh/profiles/desktop");
    let path = dir.join("cordis.patch.yml");
    if let Some(text) = text {
        fs::write(&path, text).unwrap();
    }
    location("dsh", "deepseek-harness", path)
}

#[test]
fn scan_reads_mcp_client_entries_by_server_name() {
    let t = TempTree::new();
    let dsh = dsh_tree(&t, Some(USER_PATCH));
    let overview = scan(std::slice::from_ref(&dsh));
    assert!(overview.issues.is_empty(), "{:?}", overview.issues);
    let names: Vec<(&str, &str, bool)> = overview
        .entries
        .iter()
        .map(|e| (e.name.as_str(), e.transport.as_str(), e.reason.is_some()))
        .collect();
    // 别的插件那一项不算 MCP；用了 `!!js` 的读得出、但搬不走
    assert_eq!(
        names,
        vec![
            ("docs", "http", false),
            ("memory", "stdio", false),
            ("web", "http", true),
        ]
    );
}

const SOURCE: &str = r#"{"mcpServers":{
  "fetch": {"command": "uvx", "args": ["mcp-server-fetch", "--ua=a b"], "env": {"A": "1"}},
  "remote": {"url": "https://mcp.example/v1?x=1#y", "headers": {"X-Key": "v\"q"}},
  "events": {"type": "sse", "url": "https://sse.example/mcp"},
  "bad.name": {"command": "x"},
  "memory": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], "env": {"MEMORY_FILE_PATH": "/tmp/memory.json"}}
}}"#;

/// 一个 Claude Code 的来源 + DeepSeek Harness 的补丁文件
fn with_source(t: &TempTree, patch: Option<&str>) -> Vec<McpLocation> {
    let source = t.root().join("claude.json");
    fs::write(&source, SOURCE).unwrap();
    vec![
        location("claude", "claude-code", source),
        dsh_tree(t, patch),
    ]
}

fn sel(name: &str) -> McpSelection {
    McpSelection {
        source_id: "claude".into(),
        name: name.into(),
        target_id: "dsh".into(),
    }
}

fn write(locations: &[McpLocation], names: &[&str]) -> McpReport {
    let selections: Vec<_> = names.iter().map(|n| sel(n)).collect();
    let plan = prepare(locations, &selections);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute(plan, false, backups());
    for entry in &report.entries {
        assert_eq!(entry.outcome, "created", "{:?}", report.entries);
    }
    report
}

#[test]
fn writing_appends_one_own_line_per_server_and_keeps_user_bytes() {
    let t = TempTree::new();
    let locations = with_source(&t, Some(USER_PATCH));
    let report = write(&locations, &["fetch", "remote"]);

    let after = fs::read_to_string(&locations[1].path).unwrap();
    assert_eq!(
        after,
        format!(
            "{USER_PATCH}{}\n{}\n",
            r#"- insert: [{"id": "sophia-mcp-fetch", "name": "@deepseek-ai/dsh-mcp-client", "config": {"serverName": "fetch", "transport": "stdio", "command": "uvx", "args": ["mcp-server-fetch", "--ua=a b"], "env": {"A": "1"}}}]"#,
            r#"- insert: [{"id": "sophia-mcp-remote", "name": "@deepseek-ai/dsh-mcp-client", "config": {"serverName": "remote", "transport": "streamable-http", "url": "https://mcp.example/v1?x=1#y", "headers": {"X-Key": "v\"q"}}}]"#,
        )
    );
    // 写前备份：就是写之前的原样
    let backup = report.entries[0].backup_path.clone().expect("有备份");
    assert_eq!(fs::read_to_string(backup).unwrap(), USER_PATCH);
    // 读回来：两项都在、与来源一样
    let overview = scan(&locations);
    for name in ["fetch", "remote"] {
        let entry = overview
            .entries
            .iter()
            .find(|e| e.source_id == "claude" && e.name == name)
            .unwrap();
        let cell = entry.cells.iter().find(|c| c.target_id == "dsh").unwrap();
        assert_eq!(cell.state, McpCellState::Equal, "{name}");
    }
}

const FETCH_LINE: &str = r#"- insert: [{"id": "sophia-mcp-fetch", "name": "@deepseek-ai/dsh-mcp-client", "config": {"serverName": "fetch", "transport": "stdio", "command": "uvx", "args": ["mcp-server-fetch", "--ua=a b"], "env": {"A": "1"}}}]"#;

#[test]
fn placeholder_and_comment_only_files_take_the_first_line() {
    let cases = [
        // 它初始化时写的占位：那一行换成新加的
        ("[]\n", format!("{FETCH_LINE}\n")),
        (
            "# 关掉这一层\n[]  # 占位\n",
            format!("# 关掉这一层\n{FETCH_LINE}\n"),
        ),
        // CRLF 跟随原文；末行没有换行的先补一个
        (
            "# a\r\n- replace: {id: x}",
            format!("# a\r\n- replace: {{id: x}}\r\n{FETCH_LINE}\r\n"),
        ),
    ];
    for (before, expected) in cases {
        let t = TempTree::new();
        let locations = with_source(&t, Some(before));
        write(&locations, &["fetch"]);
        assert_eq!(
            fs::read_to_string(&locations[1].path).unwrap(),
            expected,
            "{before:?}"
        );
    }
}

#[test]
fn missing_patch_file_is_not_created() {
    let t = TempTree::new();
    let locations = with_source(&t, None);
    let plan = prepare(&locations, &[sel("fetch")]);
    // 计划阶段就拒绝（评审 #16）；写的时候 `patch::merge` 还会再挡一次
    assert!(
        plan.issues[0].message.contains("DeepSeek Harness"),
        "{:?}",
        plan.issues
    );
    execute(plan, false, backups());
    assert!(
        !locations[1].path.exists(),
        "桌面版没打开过：不替它建补丁文件"
    );
}

/// 评审 #16（#258）：补丁文件还不存在（桌面版没打开过）时，格子当场就是 ⊘、说先打开一次，不等写的时候才失败；
/// 计划阶段也照这一句拒绝
#[test]
fn missing_patch_file_blocks_the_cells_up_front() {
    let t = TempTree::new();
    let locations = with_source(&t, None);
    let overview = scan(&locations);
    let cell = overview
        .entries
        .iter()
        .find(|e| e.name == "fetch")
        .unwrap()
        .cells
        .iter()
        .find(|c| c.target_id == "dsh")
        .unwrap()
        .clone();
    assert_eq!(cell.state, McpCellState::Unsupported);
    assert_eq!(cell.reason_kind, Some(McpReasonKind::TargetNotReady));
    assert!(cell
        .reason
        .as_deref()
        .unwrap()
        .contains("先打开一次 DeepSeek Harness"));
    let plan = prepare(&locations, &[sel("fetch")]);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.issues[0].message, cell.reason.unwrap());
}

#[test]
fn sse_and_bad_names_are_refused_with_a_reason() {
    let t = TempTree::new();
    let locations = with_source(&t, Some("[]\n"));
    let overview = scan(&locations);
    let cell = |name: &str| {
        overview
            .entries
            .iter()
            .find(|e| e.name == name)
            .unwrap()
            .cells
            .iter()
            .find(|c| c.target_id == "dsh")
            .unwrap()
            .clone()
    };
    let sse = cell("events");
    assert_eq!(sse.state, McpCellState::Unsupported);
    assert_eq!(sse.reason_kind, Some(McpReasonKind::SseUnsupported));
    let bad = cell("bad.name");
    assert_eq!(bad.state, McpCellState::Unsupported);
    assert_eq!(bad.reason_kind, Some(McpReasonKind::ServerNameInvalid));
    assert!(bad.reason.as_deref().unwrap().contains("bad.name"));

    // 写的时候同样拒绝，文件一个字节没动
    let plan = prepare(&locations, &[sel("events"), sel("bad.name")]);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.issues.len(), 2);
    assert_eq!(plan.issues[1].message, bad.reason.unwrap());
    execute(plan, false, backups());
    assert_eq!(fs::read_to_string(&locations[1].path).unwrap(), "[]\n");
}

fn remove_item(name: &str) -> McpRemoveItem {
    McpRemoveItem {
        location_id: "dsh".into(),
        name: name.into(),
    }
}

#[test]
fn removal_cuts_only_own_lines() {
    let t = TempTree::new();
    let locations = with_source(&t, Some(USER_PATCH));
    write(&locations, &["fetch", "remote"]);
    let written = fs::read_to_string(&locations[1].path).unwrap();
    let remote_line = written.lines().last().unwrap().to_owned();

    let report = execute_removal(
        prepare_original_removal(&locations, &[remove_item("fetch")]),
        backups(),
    );
    assert_eq!(report.entries[0].outcome, "removed", "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(&locations[1].path).unwrap(),
        format!("{USER_PATCH}{remote_line}\n")
    );

    // 用户自己写的那一项：不是 Sophia 的行，不删，文件不动
    let plan = prepare_original_removal(&locations, &[remove_item("memory")]);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.issues[0].message, crate::t!("mcp.report.cannotCut"));
    execute_removal(plan, backups());
    assert_eq!(
        fs::read_to_string(&locations[1].path).unwrap(),
        format!("{USER_PATCH}{remote_line}\n")
    );
}

#[test]
fn removing_the_last_entry_writes_a_placeholder() {
    // 删完只剩注释或什么都没有：它启动不了，写回 `[]`
    for before in ["[]\n", "# 关掉这一层\n[]\n", "# 关掉这一层\r\n[]\r\n"] {
        let t = TempTree::new();
        let locations = with_source(&t, Some(before));
        write(&locations, &["fetch"]);
        let report = execute_removal(
            prepare_original_removal(&locations, &[remove_item("fetch")]),
            backups(),
        );
        assert_eq!(report.entries[0].outcome, "removed", "{:?}", report.entries);
        assert_eq!(
            fs::read_to_string(&locations[1].path).unwrap(),
            before,
            "{before:?}"
        );
    }
}

#[test]
fn undo_restores_the_patch_byte_for_byte() {
    let t = TempTree::new();
    let locations = with_source(&t, Some(USER_PATCH));
    let mut report = write(&locations, &["fetch"]);
    let undo = report.take_undo().expect("有撤销记录");
    let result = undo_write(&undo);
    assert_eq!(result.outcome, "undone", "{:?}", result.files);
    assert_eq!(fs::read_to_string(&locations[1].path).unwrap(), USER_PATCH);
}

/// 两处不一样时「保留这份」：DeepSeek Harness 里 Sophia 写的那一行换成选中的那份；用户自己写的那项换不了
#[test]
fn keep_rewrites_own_lines_only() {
    let t = TempTree::new();
    let old_fetch = FETCH_LINE.replace("--ua=a b", "--old");
    let old_memory = USER_PATCH.replace("/tmp/memory.json", "/tmp/old.json");
    let locations = with_source(&t, Some(&format!("{old_memory}{old_fetch}\n")));
    let ids = ["claude".to_owned(), "dsh".to_owned()];

    let report = execute_keep(prepare_keep(&locations, "fetch", "claude", &ids), backups());
    assert_eq!(report.entries[0].outcome, "updated", "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(&locations[1].path).unwrap(),
        format!("{old_memory}{FETCH_LINE}\n")
    );

    let plan = prepare_keep(&locations, "memory", "claude", &ids);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.issues.len(), 1, "{:?}", plan.issues);
}

/// 来源管理页移除一个来源：它写进补丁的那一行拿掉，用户的内容原样
#[test]
fn removing_a_source_takes_its_line_out_of_the_patch() {
    let t = TempTree::new();
    let mut locations = with_source(&t, Some(USER_PATCH));
    write(&locations, &["fetch"]);
    locations[0].domain = "project:/elsewhere".into();

    // 用户自己写的 memory 与来源那份一样，也列出来；移除时拿不掉、如实跳过
    let plan = sources::plan_remove("global", "claude", &locations).unwrap();
    assert_eq!(plan.items.len(), 2, "{:?}", plan.items);
    let report = sources::remove(
        "global",
        "claude",
        &plan.items,
        &locations,
        &mut sources::McpSubscriptions::new(),
        &mut Vec::new(),
        backups(),
    )
    .unwrap();
    let outcome = |name: &str| {
        report
            .entries
            .iter()
            .find(|e| e.name == name)
            .map(|e| e.outcome.clone())
    };
    assert_eq!(
        outcome("fetch").as_deref(),
        Some("removed"),
        "{:?}",
        report.entries
    );
    assert_eq!(outcome("memory").as_deref(), Some("skipped"));
    assert_eq!(fs::read_to_string(&locations[1].path).unwrap(), USER_PATCH);
}

/// 本机还有全机补丁 `~/.dsh/cordis.patch.yml` 时，写成之后说明以哪一个为准（它后应用、优先级更高），
/// Sophia 只改桌面版那份、不碰它
#[test]
fn writing_explains_the_machine_wide_patch_when_there_is_one() {
    let t = TempTree::new();
    let locations = with_source(&t, Some("[]\n"));
    let report = write(&locations, &["fetch"]);
    assert_eq!(report.entries[0].note, None, "没有全机补丁时不说");

    let global = t.root().join(".dsh/cordis.patch.yml");
    fs::write(&global, "[]\n").unwrap();
    let report = write(&locations, &["remote"]);
    let note = report.entries[0].note.clone().expect("说明以哪一个为准");
    assert_eq!(
        note,
        crate::t!(
            "mcp.report.dshGlobalPatch",
            agent = "DeepSeek Harness",
            path = global.display().to_string()
        )
    );
    assert_eq!(fs::read_to_string(&global).unwrap(), "[]\n", "全机那份不动");
}

/// 读不懂的补丁（不是 YAML、根不是列表、几份文档）：这一列算读不出，不往里写
#[test]
fn unreadable_patches_are_left_alone() {
    for (text, message) in [
        ("- insert: [unclosed\n", crate::t!("mcp.read.yamlInvalid")),
        ("insert: []\n", crate::t!("mcp.read.patchNotList")),
        ("[]\n---\n[]\n", crate::t!("mcp.read.patchNotList")),
    ] {
        let t = TempTree::new();
        let locations = with_source(&t, Some(text));
        let overview = scan(&locations);
        let issue = overview.issues.iter().find(|i| i.location_id == "dsh");
        assert_eq!(issue.map(|i| i.message.clone()), Some(message), "{text:?}");
        let plan = prepare(&locations, &[sel("fetch")]);
        assert!(plan.actions.is_empty(), "{text:?}");
        assert_eq!(fs::read_to_string(&locations[1].path).unwrap(), text);
    }
}

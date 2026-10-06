//! Claude 桌面应用第三方模式下 MCP 写两份（spec 2026-10-05-mcp-claude-3p）：`Claude-3p/` 存在时
//! 「Claude Desktop」这一列的添加、移除同时写 `Claude/` 与 `Claude-3p/` 两份，撤销一起还原，
//! 第二份写不成只并进主条目的说明。全部在临时目录里搭真实文件，不碰本机配置
use super::sources::remove_json_server;
use super::*;
use crate::test_support::{backups, TempTree};
use serde_json::json;

fn harness(id: &str, name: &str) -> Harness {
    Harness {
        id: id.into(),
        display_name: name.into(),
        project_dir: None,
        global_dir: None,
        universal: false,
        agent_dirs: Vec::new(),
        managed_global_dir: false,
        agent_labels: None,
    }
}

fn env(home: &Path) -> Env {
    Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    }
}

fn location(id: &str, harness_id: &str, path: PathBuf, mirrors: Vec<PathBuf>) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: if harness_id == "claude-desktop" {
            "Claude Desktop".into()
        } else {
            id.into()
        },
        harness_id: harness_id.into(),
        domain: "global".into(),
        path,
        selector: None,
        matrix_hidden: false,
        mirrors,
    }
}

fn sel(source_id: &str, name: &str, target_id: &str) -> McpSelection {
    McpSelection {
        source_id: source_id.into(),
        name: name.into(),
        target_id: target_id.into(),
    }
}

const SOURCE: &str =
    r#"{"mcpServers":{"docs":{"command":"npx","args":["-y","docs"],"env":{"K":"v"}}}}"#;
/// 两份各自的原文：写法、缩进、别的字段都不一样，写后各自只多 `docs` 这一段
const MAIN_BEFORE: &str =
    "{\n  \"mcpServers\": {\n    \"mine\": {\"command\": \"mine\"}\n  },\n  \"x\": 1\n}\n";
const MIRROR_BEFORE: &str = "{\"other\":true,\"mcpServers\":{}}";

/// `.claude.json`（来源）+ `Claude/` 与 `Claude-3p/` 两份桌面应用设置；返回（位置表，主文件，镜像文件）
fn desktop_pair(t: &TempTree, mirror_before: &str) -> (Vec<McpLocation>, PathBuf, PathBuf) {
    let root = t.root();
    let source = root.join(".claude.json");
    fs::write(&source, SOURCE).unwrap();
    let main = t
        .dir("Library/Application Support/Claude")
        .join("claude_desktop_config.json");
    fs::write(&main, MAIN_BEFORE).unwrap();
    let mirror = t
        .dir("Library/Application Support/Claude-3p")
        .join("claude_desktop_config.json");
    fs::write(&mirror, mirror_before).unwrap();
    let locations = vec![
        location("claude", "claude-code", source, Vec::new()),
        location(
            "claude-desktop",
            "claude-desktop",
            main.clone(),
            vec![mirror.clone()],
        ),
    ];
    (locations, main, mirror)
}

fn add_docs(locations: &[McpLocation]) -> McpReport {
    let plan = prepare(locations, &[sel("claude", "docs", "claude-desktop")]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    // 预览里仍只有一条「Claude Desktop」，镜像不另列
    assert_eq!(plan.actions.len(), 1, "{:?}", plan.actions);
    execute(plan, false, backups())
}

fn desktop_entries(report: &McpReport) -> Vec<&McpReportEntry> {
    report
        .entries
        .iter()
        .filter(|entry| entry.target_id == "claude-desktop")
        .collect()
}

fn has_docs(location: &McpLocation) -> bool {
    let parsed = parse(location);
    parsed.issue.is_none() && parsed.values.contains_key("docs")
}

fn at(path: &Path) -> McpLocation {
    location("probe", "claude-desktop", path.to_path_buf(), Vec::new())
}

// ===== 位置发现（R1） =====

/// macOS 上 `Claude-3p/` 是目录才算；没有、或是软链接都不算
#[test]
fn claude_3p_directory_becomes_a_mirror_of_the_desktop_location() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let harnesses = [harness("claude-desktop", "Claude Desktop")];
    let desktop_of = |home: &Path| {
        locations(&env(home), &harnesses, &[])
            .into_iter()
            .find(|l| l.id == "claude-desktop")
            .expect("有 Claude Desktop 位置")
    };

    // 没有 Claude-3p/：和以前一样只有一份（AC2）
    let t = TempTree::new();
    t.dir("Library/Application Support/Claude");
    assert!(desktop_of(&t.root()).mirrors.is_empty());

    // 有目录：镜像是它下面的 claude_desktop_config.json
    let t = TempTree::new();
    let three = t.dir("Library/Application Support/Claude-3p");
    let desktop = desktop_of(&t.root());
    assert_eq!(
        desktop.mirrors,
        vec![three.join("claude_desktop_config.json")]
    );
    assert_eq!(
        desktop.path,
        t.root()
            .join("Library/Application Support/Claude/claude_desktop_config.json")
    );

    // 软链接的 Claude-3p 不算
    let t = TempTree::new();
    let real = t.dir("elsewhere/real-3p");
    let support = t.dir("Library/Application Support");
    t.link(&support.join("Claude-3p"), &real);
    assert!(desktop_of(&t.root()).mirrors.is_empty());
}

/// 位置序列化：没有镜像时不出现这个键，有时是 camelCase 的 `mirrors`
#[test]
fn mirrors_serialize_only_when_present() {
    let plain = location("d", "claude-desktop", PathBuf::from("/a.json"), Vec::new());
    assert!(!serde_json::to_string(&plain).unwrap().contains("mirrors"));
    let with = location(
        "d",
        "claude-desktop",
        PathBuf::from("/a.json"),
        vec![PathBuf::from("/b.json")],
    );
    let value: Value = serde_json::to_value(&with).unwrap();
    assert_eq!(value["mirrors"], json!(["/b.json"]));
    let back: McpLocation = serde_json::from_value(value).unwrap();
    assert_eq!(back, with);
    // 老数据没有这个键也读得出
    let old: McpLocation = serde_json::from_str(
        r#"{"id":"d","label":"d","harnessId":"claude-desktop","domain":"global","path":"/a.json"}"#,
    )
    .unwrap();
    assert!(old.mirrors.is_empty());
}

// ===== 添加（AC1、AC2、AC3） =====

#[test]
fn adding_writes_both_copies_and_each_only_gains_that_one_member() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    let mut report = add_docs(&locations);

    let entries = desktop_entries(&report);
    assert_eq!(
        entries.len(),
        1,
        "镜像成功时不单独出现：{:?}",
        report.entries
    );
    assert_eq!(entries[0].outcome, "created", "{}", entries[0].message);
    assert_eq!(entries[0].message, crate::t!("mcp.report.created"));
    assert_eq!(entries[0].mirror_failed, None);
    assert!(!serde_json::to_string(entries[0])
        .unwrap()
        .contains("mirrorFailed"));
    assert!(entries[0].backup_path.is_some());

    // 两份都有了，各自只多这一段，其余逐字节不变
    for (path, before) in [(&main, MAIN_BEFORE), (&mirror, MIRROR_BEFORE)] {
        assert!(has_docs(&at(path)), "{}", path.display());
        let after = fs::read(path).unwrap();
        assert_eq!(
            remove_json_server(&after, None, "docs"),
            Some(before.as_bytes().to_vec()),
            "{}",
            path.display()
        );
    }

    // 撤销：两份都回到写前（AC3）
    let undo = report.take_undo().expect("可撤销");
    let paths: BTreeSet<_> = undo.target_paths().map(Path::to_path_buf).collect();
    assert_eq!(paths, BTreeSet::from([main.clone(), mirror.clone()]));
    let result = undo_write(&undo);
    assert_eq!(result.outcome, "undone", "{:?}", result.files);
    assert_eq!(fs::read_to_string(&main).unwrap(), MAIN_BEFORE);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);
}

/// 镜像文件还不存在（切过第三方模式但从没存过设置）：新建它；撤销把新建的删掉
#[test]
fn missing_mirror_file_is_created_and_undo_removes_it() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    fs::remove_file(&mirror).unwrap();
    let mut report = add_docs(&locations);
    assert_eq!(desktop_entries(&report)[0].outcome, "created");
    assert!(has_docs(&at(&main)));
    assert!(has_docs(&at(&mirror)));
    let undo = report.take_undo().expect("可撤销");
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read_to_string(&main).unwrap(), MAIN_BEFORE);
    assert!(matches!(
        crate::fs::entry_kind(&mirror),
        crate::fs::EntryKind::Missing
    ));
}

/// 没有镜像的位置照旧只写一份（AC2）
#[test]
fn location_without_mirrors_writes_one_file() {
    let t = TempTree::new();
    let (mut locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    locations[1].mirrors.clear();
    let report = add_docs(&locations);
    assert_eq!(desktop_entries(&report)[0].outcome, "created");
    assert!(has_docs(&at(&main)));
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);
}

// ===== 第二份写不成（AC4，R3） =====

#[test]
fn broken_mirror_does_not_block_the_main_copy_and_is_explained_in_its_entry() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, "{ not json");
    let mut report = add_docs(&locations);

    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "created", "{}", entries[0].message);
    // 主条目状态与说明不变，第二份没写成的整句原因在 `mirror_failed`（前端在成功条目下显示）
    assert_eq!(entries[0].message, crate::t!("mcp.report.created"));
    assert_eq!(
        entries[0].mirror_failed,
        Some(crate::t!(
            "mcp.report.mirrorFailed",
            reason = crate::t!("mcp.reason.targetUnreadable")
        ))
    );
    assert!(has_docs(&at(&main)));
    assert_eq!(fs::read_to_string(&mirror).unwrap(), "{ not json");

    // 只有主文件可撤销，撤销还原它
    let undo = report.take_undo().expect("主文件可撤销");
    assert_eq!(
        undo.target_paths().collect::<Vec<_>>(),
        vec![main.as_path()]
    );
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read_to_string(&main).unwrap(), MAIN_BEFORE);
}

/// 第二份里已有同名但不同的定义：第一份照写，第二份不动、说明冲突
#[test]
fn conflicting_definition_in_the_mirror_is_reported_not_overwritten() {
    let t = TempTree::new();
    let before = r#"{"mcpServers":{"docs":{"command":"other"}}}"#;
    let (locations, main, mirror) = desktop_pair(&t, before);
    let report = add_docs(&locations);
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "created");
    assert_eq!(
        entries[0].mirror_failed,
        Some(crate::t!(
            "mcp.report.mirrorFailed",
            reason = crate::t!("mcp.issue.targetConflict")
        ))
    );
    assert!(has_docs(&at(&main)));
    assert_eq!(fs::read_to_string(&mirror).unwrap(), before);
}

/// 第二份里已有一样的定义：不算失败，也不重写
#[test]
fn identical_definition_in_the_mirror_is_left_alone() {
    let t = TempTree::new();
    let before =
        r#"{"mcpServers":{"docs":{"command":"npx","args":["-y","docs"],"env":{"K":"v"}}}}"#;
    let (locations, main, mirror) = desktop_pair(&t, before);
    let report = add_docs(&locations);
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].message, crate::t!("mcp.report.created"));
    assert_eq!(entries[0].mirror_failed, None);
    assert!(has_docs(&at(&main)));
    assert_eq!(fs::read_to_string(&mirror).unwrap(), before);
}

// ===== 移除（AC5） =====

#[test]
fn removing_cuts_the_member_from_both_copies_and_undo_restores_both() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    add_docs(&locations);
    let main_with = fs::read_to_string(&main).unwrap();
    let mirror_with = fs::read_to_string(&mirror).unwrap();

    let plan = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: "claude-desktop".into(),
            name: "docs".into(),
        }],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(plan.actions.len(), 1, "{:?}", plan.actions);
    let mut report = execute_removal(plan, backups());
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "removed", "{}", entries[0].message);
    assert_eq!(entries[0].message, crate::t!("mcp.report.removed"));
    // 两份都没有了，而且回到了添加前的原文
    assert_eq!(fs::read_to_string(&main).unwrap(), MAIN_BEFORE);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);

    let undo = report.take_undo().expect("可撤销");
    let paths: BTreeSet<_> = undo.target_paths().map(Path::to_path_buf).collect();
    assert_eq!(paths, BTreeSet::from([main.clone(), mirror.clone()]));
    assert_eq!(undo_write(&undo).outcome, "undone");
    assert_eq!(fs::read_to_string(&main).unwrap(), main_with);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), mirror_with);
}

/// 第二份里本来就没有这一项：只删第一份，不算失败
#[test]
fn removing_skips_a_mirror_that_never_had_the_member() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    fs::write(
        &main,
        r#"{"mcpServers":{"docs":{"command":"npx"},"mine":{"command":"mine"}}}"#,
    )
    .unwrap();
    let plan = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: "claude-desktop".into(),
            name: "docs".into(),
        }],
    );
    let report = execute_removal(plan, backups());
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "removed");
    assert_eq!(entries[0].message, crate::t!("mcp.report.removed"));
    assert!(!has_docs(&at(&main)));
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);
}

/// 第二份是坏 JSON：第一份照删，主条目说明第二份没写成
#[test]
fn removing_with_a_broken_mirror_explains_it_in_the_main_entry() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, "{ not json");
    fs::write(&main, r#"{"mcpServers":{"docs":{"command":"npx"}}}"#).unwrap();
    let plan = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: "claude-desktop".into(),
            name: "docs".into(),
        }],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute_removal(plan, backups());
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "removed", "{}", entries[0].message);
    assert_eq!(entries[0].message, crate::t!("mcp.report.removed"));
    assert_eq!(
        entries[0].mirror_failed,
        Some(crate::t!(
            "mcp.report.mirrorFailed",
            reason = crate::t!("mcp.reason.targetUnreadable")
        ))
    );
    assert!(!has_docs(&at(&main)));
    assert_eq!(fs::read_to_string(&mirror).unwrap(), "{ not json");
}

/// 从导入对话框写定义（`write_definitions`）走同一条：两份都写
#[test]
fn write_definitions_also_writes_the_mirror() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let t = TempTree::new();
    let (_, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    let harnesses = [harness("claude-desktop", "Claude Desktop")];
    let parsed =
        parse_mcp_text(r#"{"mcpServers":{"docs":{"command":"npx","args":["-y","docs"]}}}"#);
    assert_eq!(parsed.error, None);
    let request = crate::market::McpInstallRequest {
        definitions: parsed.servers,
        location: "global".into(),
        harness_ids: vec!["claude-desktop".into()],
        values: BTreeMap::new(),
        claude_code_scope: None,
        add_to_gitignore: false,
    };
    let report = write_definitions(&env(&t.root()), &harnesses, &request, backups());
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "created", "{}", entries[0].message);
    assert!(has_docs(&at(&main)));
    assert!(has_docs(&at(&mirror)));
}

// ===== 主文件没成，镜像不动（Codex 复审 P2-2） =====

/// 两份都有、预览后主文件被外部改了：主失败、镜像一个字节不动、报告只一条 failed、没有撤销
#[test]
fn mirror_is_left_alone_when_the_main_write_fails() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    let plan = prepare(&locations, &[sel("claude", "docs", "claude-desktop")]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let edited = "{\"mcpServers\":{},\"edited\":true}";
    fs::write(&main, edited).unwrap();
    let mut report = execute(plan, false, backups());
    assert_eq!(report.entries.len(), 1, "{:?}", report.entries);
    assert_eq!(report.entries[0].outcome, "failed");
    assert_eq!(report.entries[0].target_id, "claude-desktop");
    assert_eq!(report.entries[0].mirror_failed, None);
    assert_eq!(fs::read_to_string(&main).unwrap(), edited);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);
    assert!(report.take_undo().is_none(), "一份都没写，没有可撤销的");
}

/// 移除同样：主文件删不成（预览后被改），镜像里的那一项留着、不出条目、没有撤销
#[test]
fn mirror_removal_is_skipped_when_the_main_removal_fails() {
    let t = TempTree::new();
    let (locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    add_docs(&locations);
    let mirror_with = fs::read_to_string(&mirror).unwrap();
    let plan = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: "claude-desktop".into(),
            name: "docs".into(),
        }],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let edited = r#"{"mcpServers":{"docs":{"command":"npx"}},"edited":true}"#;
    fs::write(&main, edited).unwrap();
    let mut report = execute_removal(plan, backups());
    assert_eq!(report.entries.len(), 1, "{:?}", report.entries);
    assert_eq!(report.entries[0].outcome, "failed");
    assert_eq!(report.entries[0].mirror_failed, None);
    assert_eq!(fs::read_to_string(&main).unwrap(), edited);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), mirror_with);
    assert!(report.take_undo().is_none());
}

// ===== 主文件解析后就是镜像文件（Codex 复审 P2-3） =====

/// 主配置是指向 `Claude-3p/` 那份的软链接：`resolve_symlinks` 把主路径换成了真实路径，与镜像是同一个文件，
/// 只写一次（写两次会被「追加后核对」拒绝、报成镜像没写成）；移除同理
#[test]
fn mirror_that_is_the_same_file_as_the_main_path_is_not_written_twice() {
    let t = TempTree::new();
    let (mut locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    fs::remove_file(&main).unwrap();
    t.link(&main, &mirror);
    // 位置发现会把主路径解析成真实文件；这里照它的结果给（镜像仍是 Claude-3p 那份）
    locations[1].path = mirror.clone();
    let plan = prepare(&locations, &[sel("claude", "docs", "claude-desktop")]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(plan.actions.len(), 1);
    let mut report = execute(plan, false, backups());
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "created", "{}", entries[0].message);
    assert_eq!(entries[0].mirror_failed, None);
    let after = fs::read(&mirror).unwrap();
    assert_eq!(
        remove_json_server(&after, None, "docs"),
        Some(MIRROR_BEFORE.as_bytes().to_vec())
    );
    let undo = report.take_undo().expect("可撤销");
    assert_eq!(
        undo.target_paths().collect::<Vec<_>>(),
        vec![mirror.as_path()]
    );

    let plan = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: "claude-desktop".into(),
            name: "docs".into(),
        }],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute_removal(plan, backups());
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "removed", "{}", entries[0].message);
    assert_eq!(entries[0].mirror_failed, None);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);
}

/// 从位置发现走一遍（macOS）：软链接的主配置解析到 `Claude-3p/` 那份，镜像也是它，照样只写一次
#[test]
fn discovered_symlinked_desktop_config_writes_once() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let t = TempTree::new();
    let (mut locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    fs::remove_file(&main).unwrap();
    t.link(&main, &mirror);
    let desktop = self::locations(
        &env(&t.root()),
        &[harness("claude-desktop", "Claude Desktop")],
        &[],
    )
    .into_iter()
    .find(|l| l.id == "claude-desktop")
    .expect("有 Claude Desktop 位置");
    assert_eq!(desktop.path, mirror);
    assert_eq!(desktop.mirrors, vec![mirror.clone()]);
    locations[1] = desktop;
    let report = add_docs(&locations);
    let entries = desktop_entries(&report);
    assert_eq!(entries.len(), 1, "{:?}", report.entries);
    assert_eq!(entries[0].outcome, "created", "{}", entries[0].message);
    assert_eq!(entries[0].mirror_failed, None);
    assert_eq!(
        remove_json_server(&fs::read(&mirror).unwrap(), None, "docs"),
        Some(MIRROR_BEFORE.as_bytes().to_vec())
    );
}

// ===== 别的 agent 的配置链到了镜像文件（Codex 第二轮 P2-2） =====

/// Cursor 的 mcp.json 是指向 `Claude-3p/claude_desktop_config.json` 的软链接（错配），同一批给 Claude Desktop 与
/// Cursor 各加一条：镜像那条与 Cursor 那条落在同一个文件组，镜像不写、Claude Desktop 的主条目说第三方那份没同步；
/// 两份主文件照写；位置发现会把软链接解析成真实路径，这里照它的结果给 Cursor 的路径
#[test]
fn mirror_sharing_a_file_with_another_location_is_not_written() {
    let t = TempTree::new();
    let (mut locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    let cursor_link = t.dir(".cursor").join("mcp.json");
    t.link(&cursor_link, &mirror);
    locations.push(location("cursor", "cursor", mirror.clone(), Vec::new()));
    let plan = prepare(
        &locations,
        &[
            sel("claude", "docs", "claude-desktop"),
            sel("claude", "docs", "cursor"),
        ],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(plan.actions.len(), 2, "{:?}", plan.actions);
    let mut report = execute(plan, false, backups());
    let desktop = desktop_entries(&report);
    assert_eq!(desktop.len(), 1, "{:?}", report.entries);
    assert_eq!(desktop[0].outcome, "created", "{}", desktop[0].message);
    assert_eq!(
        desktop[0].mirror_failed,
        Some(crate::t!(
            "mcp.report.mirrorFailed",
            reason = crate::t!("mcp.reason.mirrorSharedFile")
        ))
    );
    let cursor = report
        .entries
        .iter()
        .find(|e| e.target_id == "cursor")
        .expect("Cursor 有条目");
    assert_eq!(cursor.outcome, "created", "{}", cursor.message);
    assert_eq!(cursor.mirror_failed, None);
    assert!(has_docs(&at(&main)));
    // 共用的那个文件只被 Cursor 那条写了一次：切掉它就是原文
    assert_eq!(
        remove_json_server(&fs::read(&mirror).unwrap(), None, "docs"),
        Some(MIRROR_BEFORE.as_bytes().to_vec())
    );
    let undo = report.take_undo().expect("可撤销");
    let paths: BTreeSet<_> = undo.target_paths().map(Path::to_path_buf).collect();
    assert_eq!(paths, BTreeSet::from([main.clone(), mirror.clone()]));
}

/// 移除同理：两处各删一条，镜像那条不删、主条目说没同步；共用的文件只被 Cursor 那条切一次
#[test]
fn mirror_removal_sharing_a_file_with_another_location_is_skipped() {
    let t = TempTree::new();
    let (mut locations, main, mirror) = desktop_pair(&t, MIRROR_BEFORE);
    add_docs(&locations);
    let cursor_link = t.dir(".cursor").join("mcp.json");
    t.link(&cursor_link, &mirror);
    locations.push(location("cursor", "cursor", mirror.clone(), Vec::new()));
    let plan = prepare_original_removal(
        &locations,
        &[
            McpRemoveItem {
                location_id: "claude-desktop".into(),
                name: "docs".into(),
            },
            McpRemoveItem {
                location_id: "cursor".into(),
                name: "docs".into(),
            },
        ],
    );
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(plan.actions.len(), 2, "{:?}", plan.actions);
    let report = execute_removal(plan, backups());
    let desktop = desktop_entries(&report);
    assert_eq!(desktop.len(), 1, "{:?}", report.entries);
    assert_eq!(desktop[0].outcome, "removed", "{}", desktop[0].message);
    assert_eq!(
        desktop[0].mirror_failed,
        Some(crate::t!(
            "mcp.report.mirrorFailed",
            reason = crate::t!("mcp.reason.mirrorSharedFile")
        ))
    );
    let cursor = report
        .entries
        .iter()
        .find(|e| e.target_id == "cursor")
        .expect("Cursor 有条目");
    assert_eq!(cursor.outcome, "removed", "{}", cursor.message);
    assert_eq!(fs::read_to_string(&main).unwrap(), MAIN_BEFORE);
    assert_eq!(fs::read_to_string(&mirror).unwrap(), MIRROR_BEFORE);
}

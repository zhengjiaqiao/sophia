//! 密钥提醒接到移动 / 复制与自动同步规则（spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」，issue #113）：
//! 来源是原位置文件（规则的来源文件），目标是写进的项目文件。在临时目录里搭真实项目（`git init`、提交、`.gitignore`）
use super::*;
use crate::keyhint::KeyHint;
use crate::test_support::{backups, TempTree};
use serde_json::json;
use std::process::Command;

const TOKEN: &str = "ghp_S3cretValue0123456789";

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

fn harnesses() -> Vec<Harness> {
    vec![
        harness("claude-code", "Claude Code"),
        harness("cursor", "Cursor"),
    ]
}

/// 在 `dir` 里跑 git（不读本机的全局与系统配置）；没有 git 时为 None
fn git(dir: &Path, args: &[&str]) -> Option<()> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.test")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.test")
        .output()
        .ok()?;
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Some(())
}

/// 一台假电脑：主目录 + 两个 git 项目（路径带空格）。没有 git 时为 None
struct World {
    _t: TempTree,
    home: PathBuf,
    a: PathBuf,
    b: PathBuf,
}

impl World {
    fn new() -> Option<Self> {
        let t = TempTree::new();
        let home = t.dir("home");
        let a = t.dir("proj a");
        let b = t.dir("proj b");
        git(&a, &["init", "-q"])?;
        git(&b, &["init", "-q"])?;
        Some(Self { _t: t, home, a, b })
    }

    fn locations(&self) -> Vec<McpLocation> {
        let env = Env {
            apps: Vec::new(),
            home: self.home.clone(),
            vars: Default::default(),
        };
        discover_locations(&env, &harnesses(), &[self.a.clone(), self.b.clone()]).locations
    }

    /// 位置 id：用户级是 harness id，项目的是 `project:<路径>::<harness>`
    fn id(project: &Path, harness: &str) -> String {
        format!("project:{}::{harness}", project.display())
    }
}

fn servers(value: serde_json::Value) -> String {
    serde_json::to_string_pretty(&json!({ "mcpServers": value })).unwrap()
}

/// 带一个明文密钥的服务
fn keyed() -> String {
    servers(json!({"github": {"command": "srv", "env": {"GITHUB_TOKEN": TOKEN}}}))
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn select(source: &str, name: &str, target: &str) -> McpSelection {
    McpSelection {
        source_id: source.into(),
        name: name.into(),
        target_id: target.into(),
    }
}

fn hint_of(hints: &[McpKeyHint], target: &str) -> KeyHint {
    hints
        .iter()
        .find(|h| h.target_id == target)
        .map_or(KeyHint::Quiet, |h| h.hint)
}

fn created(report: &McpReport) -> usize {
    report
        .entries
        .iter()
        .filter(|e| e.outcome == "created")
        .count()
}

/// 撤掉这次写进配置的那几份（复制的撤销；移动是从目标里删掉，效果一样）
fn undo_config(report: &mut McpReport) {
    let undo = report.take_undo().expect("配置的撤销");
    assert_eq!(undo_write(&undo).outcome, "undone");
}

// ===== 移动 / 复制 =====

#[cfg(unix)]
#[test]
fn user_level_into_a_project_reminds_and_appends_only_when_asked() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    let locations = w.locations();
    let to_a = World::id(&w.a, "cursor");
    let sel = [select("cursor", "github", &to_a)];

    // 确认框问一次：用户级的来源不在仓库里，项目是 git 仓库 → 提醒，给出那一行与项目根
    let hints = key_hints(&prepare(&locations, &sel));
    assert_eq!(hints.len(), 1, "{hints:?}");
    assert_eq!(hints[0].hint, KeyHint::Remind);
    assert_eq!(hints[0].gitignore_line, ".cursor/mcp.json");
    assert_eq!(hints[0].project, w.a);

    // 没勾：照常写，不碰 .gitignore；报告记下密钥进了仓库
    let mut report = execute_minding_keys(prepare(&locations, &sel), true, false, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(!w.a.join(".gitignore").exists());
    assert!(report.key_exposed);
    assert!(!report.auto_ignored);
    assert!(report.take_gitignore_undo().is_none());

    // 勾了：写成之后追加；不算「自动加的」，也不算密钥进了仓库
    let to_b = World::id(&w.b, "cursor");
    let mut report = execute_minding_keys(
        prepare(&locations, &[select("cursor", "github", &to_b)]),
        true,
        true,
        backups(),
    );
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
    assert!(!report.key_exposed);
    assert!(!report.auto_ignored);
    assert_eq!(report.gitignore_failed, None);
    // 撤销：先撤配置（界面上同一个顺序），再撤 .gitignore——新建的删掉
    let ignore = report.take_gitignore_undo().expect("追加进撤销链");
    undo_config(&mut report);
    assert_eq!(undo_write(&ignore).outcome, "undone");
    assert!(!w.b.join(".gitignore").exists());
}

#[cfg(unix)]
#[test]
fn committed_project_file_into_another_project_stays_quiet() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // A 的团队共享配置连密钥一起提交过了
    write(&w.a.join(".mcp.json"), &keyed());
    git(&w.a, &["add", ".mcp.json"]);
    git(&w.a, &["commit", "-q", "-m", "init"]);
    let locations = w.locations();
    let to_b = World::id(&w.b, "cursor");
    let sel = [select(&World::id(&w.a, "claude-code"), "github", &to_b)];

    let hints = key_hints(&prepare(&locations, &sel));
    assert_eq!(hint_of(&hints, &to_b), KeyHint::SourceCommitted);

    // 就算勾了（确认框不会出勾选，这里防后端多做）：不加 .gitignore，也不说
    let mut report = execute_minding_keys(prepare(&locations, &sel), true, true, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(!w.b.join(".gitignore").exists());
    assert!(!report.key_exposed);
    assert!(!report.auto_ignored);
    assert!(report.take_gitignore_undo().is_none());
}

#[cfg(unix)]
#[test]
fn ignored_source_is_ignored_in_every_target_and_undone_together() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // A 把 Cursor 的配置忽略了：用户在来源那边的选择照搬过去
    write(&w.a.join(".gitignore"), ".cursor/mcp.json\n");
    write(&w.a.join(".cursor/mcp.json"), &keyed());
    // B 已有 .gitignore：追加在末尾，撤销还原成原样
    write(&w.b.join(".gitignore"), "node_modules/\n");
    let locations = w.locations();
    let from = World::id(&w.a, "cursor");
    let to_cursor = World::id(&w.b, "cursor");
    let to_team = World::id(&w.b, "claude-code");
    let sel = [
        select(&from, "github", &to_cursor),
        select(&from, "github", &to_team),
    ];

    let hints = key_hints(&prepare(&locations, &sel));
    assert_eq!(hint_of(&hints, &to_cursor), KeyHint::AutoIgnore);
    assert_eq!(hint_of(&hints, &to_team), KeyHint::AutoIgnore);

    // 没勾也加（勾选只管第一次暴露）；两个目标共用 B 的一个 .gitignore
    let mut report = execute_minding_keys(prepare(&locations, &sel), true, false, backups());
    assert_eq!(created(&report), 2, "{:?}", report.entries);
    let text = fs::read_to_string(w.b.join(".gitignore")).unwrap();
    assert!(text.starts_with("node_modules/\n"), "{text}");
    assert!(text.contains("\n.cursor/mcp.json\n"), "{text}");
    assert!(text.contains("\n/.mcp.json\n"), "{text}");
    assert!(report.auto_ignored, "提示条要说「已加进 .gitignore」");
    assert!(!report.key_exposed);
    // 撤销一次，两行一起退回
    let ignore = report.take_gitignore_undo().expect("追加进撤销链");
    undo_config(&mut report);
    assert_eq!(undo_write(&ignore).outcome, "undone");
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        "node_modules/\n"
    );
}

#[cfg(unix)]
#[test]
fn quiet_when_target_is_ignored_has_no_keys_or_is_not_a_project_file() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(
        &w.home.join(".cursor/mcp.json"),
        &servers(json!({
            "github": {"command": "srv", "env": {"GITHUB_TOKEN": TOKEN}},
            "brave": {"command": "npx", "env": {"BRAVE_API_KEY": "${BRAVE_API_KEY}"}}
        })),
    );
    // B 已把 Cursor 的配置忽略了：不会进仓库
    write(&w.b.join(".gitignore"), ".cursor/mcp.json\n");
    let locations = w.locations();
    let to_a = World::id(&w.a, "cursor");
    let to_b = World::id(&w.b, "cursor");
    let local_a = World::id(&w.a, "claude-code:local");
    let hints = key_hints(&prepare(
        &locations,
        &[
            select("cursor", "github", &to_b),
            // 占位不算密钥
            select("cursor", "brave", &to_a),
            // Claude Code 仅自己写的是 ~/.claude.json，不进仓库
            select("cursor", "github", &local_a),
        ],
    ));
    assert_eq!(hint_of(&hints, &to_b), KeyHint::Quiet);
    assert_eq!(hint_of(&hints, &to_a), KeyHint::Quiet);
    assert!(hints.iter().all(|h| h.target_id != local_a), "{hints:?}");
}

// ===== 自动同步规则 =====

/// 建一条规则（建的那一刻来源里已有的不补），再往来源里加带密钥的服务，跑一轮
fn run_rule(w: &World, source_id: &str, source_path: &Path, target_id: &str) -> McpReport {
    let locations = w.locations();
    let overview = scan(&locations);
    let source = locations.iter().find(|l| l.id == source_id).unwrap();
    let target = locations.iter().find(|l| l.id == target_id).unwrap();
    let mut rules = Vec::new();
    upsert_auto_import(
        &mut rules,
        &overview,
        source,
        target.domain.clone(),
        vec![location_ref(target)],
        true,
    )
    .unwrap();
    write(source_path, &keyed());
    let overview = scan(&locations);
    let selections = auto_selections(&overview, &rules);
    assert_eq!(selections.len(), 1, "{selections:?}");
    // 规则上没有勾选：按「没勾」跑
    execute_minding_keys(prepare(&locations, &selections), true, false, backups())
}

#[cfg(unix)]
#[test]
fn rule_writing_a_first_exposure_writes_without_gitignore_and_says_so() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    let source = w.home.join(".cursor/mcp.json");
    write(&source, &servers(json!({})));
    let mut report = run_rule(&w, "cursor", &source, &World::id(&w.a, "cursor"));
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(!w.a.join(".gitignore").exists(), "Remind：照常写，不加");
    assert!(report.key_exposed, "提示条的原因位置要说密钥会随仓库提交");
    assert!(!report.auto_ignored);
    assert!(report.take_gitignore_undo().is_none());
}

#[cfg(unix)]
#[test]
fn rule_from_an_ignored_source_ignores_the_target_too() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(&w.a.join(".gitignore"), ".cursor/mcp.json\n");
    let source = w.a.join(".cursor/mcp.json");
    write(&source, &servers(json!({})));
    let to_b = World::id(&w.b, "claude-code");
    let mut report = run_rule(&w, &World::id(&w.a, "cursor"), &source, &to_b);
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        "/.mcp.json\n"
    );
    assert!(report.auto_ignored);
    assert!(!report.key_exposed);
    let ignore = report.take_gitignore_undo().expect("追加进撤销链");
    undo_config(&mut report);
    assert_eq!(undo_write(&ignore).outcome, "undone");
    assert!(!w.b.join(".gitignore").exists());
}

#[cfg(unix)]
#[test]
fn rule_from_a_committed_source_stays_quiet() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    let source = w.a.join(".mcp.json");
    write(&source, &servers(json!({})));
    let locations = w.locations();
    let overview = scan(&locations);
    let from = locations
        .iter()
        .find(|l| l.id == World::id(&w.a, "claude-code"))
        .unwrap();
    let target = locations
        .iter()
        .find(|l| l.id == World::id(&w.b, "cursor"))
        .unwrap();
    let mut rules = Vec::new();
    upsert_auto_import(
        &mut rules,
        &overview,
        from,
        target.domain.clone(),
        vec![location_ref(target)],
        true,
    )
    .unwrap();
    // 来源里新加的那一条连密钥一起提交了
    write(&source, &keyed());
    git(&w.a, &["add", ".mcp.json"]);
    git(&w.a, &["commit", "-q", "-m", "add"]);
    let selections = auto_selections(&scan(&locations), &rules);
    let mut report = execute_minding_keys(prepare(&locations, &selections), true, false, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(!w.b.join(".gitignore").exists());
    assert!(!report.key_exposed);
    assert!(!report.auto_ignored);
    assert!(report.take_gitignore_undo().is_none());
}

// ===== 撤销与边界 =====

#[cfg(unix)]
#[test]
fn gitignore_undo_refuses_when_another_key_was_written_since() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(
        &w.home.join(".cursor/mcp.json"),
        &servers(json!({
            "github": {"command": "srv", "env": {"GITHUB_TOKEN": TOKEN}},
            "linear": {"command": "srv", "env": {"LINEAR_API_KEY": "lin_api_0123456789abcdef"}}
        })),
    );
    let locations = w.locations();
    let to_a = World::id(&w.a, "cursor");
    // 复制 github 并勾了「同时加进 .gitignore」
    let mut report = execute_minding_keys(
        prepare(&locations, &[select("cursor", "github", &to_a)]),
        true,
        true,
        backups(),
    );
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    let ignore = report.take_gitignore_undo().expect("追加进撤销链");
    // 之后规则又往同一个文件写了一个带密钥的（目标已被忽略，没有提醒）
    let later = execute_minding_keys(
        prepare(&locations, &[select("cursor", "linear", &to_a)]),
        true,
        false,
        backups(),
    );
    assert_eq!(created(&later), 1, "{:?}", later.entries);
    assert!(!later.key_exposed, "目标已被忽略：不提醒");
    // 撤销复制：github 拿掉了，linear 还在——忽略那一行不能撤
    let removal = prepare_original_removal(
        &locations,
        &[McpRemoveItem {
            location_id: to_a.clone(),
            name: "github".into(),
        }],
    );
    let removed = execute_removal(removal, backups());
    assert!(
        removed.entries.iter().all(|e| e.outcome == "removed"),
        "{:?}",
        removed.entries
    );
    let back = undo_write(&ignore);
    assert_eq!(back.outcome, "changed", "{back:?}");
    assert_eq!(
        fs::read_to_string(w.a.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_project_root_is_judged_by_its_real_path() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 项目记录里是软链接 alias → proj a；设置文件按真实路径读写
    let alias = w.home.parent().unwrap().join("alias");
    std::os::unix::fs::symlink(&w.a, &alias).unwrap();
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    let env = Env {
        apps: Vec::new(),
        home: w.home.clone(),
        vars: Default::default(),
    };
    let locations = discover_locations(&env, &harnesses(), std::slice::from_ref(&alias)).locations;
    let to = World::id(&alias, "cursor");
    let sel = [select("cursor", "github", &to)];
    let hints = key_hints(&prepare(&locations, &sel));
    assert_eq!(hint_of(&hints, &to), KeyHint::Remind, "{hints:?}");
    let report = execute_minding_keys(prepare(&locations, &sel), true, true, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(w.a.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
}

#[cfg(unix)]
#[test]
fn tracked_target_never_gets_a_gitignore_line_and_says_so() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    write(&w.a.join(".gitignore"), ".cursor/mcp.json\n");
    write(&w.a.join(".cursor/mcp.json"), &keyed());
    // B 的团队共享配置已经提交过（里面没有密钥）：.gitignore 管不住它（产品负责人 2026-10-06：不出勾选、不追加）
    write(&w.b.join(".mcp.json"), &servers(json!({})));
    git(&w.b, &["add", ".mcp.json"]);
    git(&w.b, &["commit", "-q", "-m", "init"]);
    let locations = w.locations();
    let to_team = World::id(&w.b, "claude-code");
    // 用户级（原本第一次暴露）与被忽略的项目文件（原本照搬忽略）都一样
    for source in ["cursor".to_string(), World::id(&w.a, "cursor")] {
        let sel = [select(&source, "github", &to_team)];
        let hints = key_hints(&prepare(&locations, &sel));
        assert_eq!(hint_of(&hints, &to_team), KeyHint::Tracked, "{source}");
        assert_eq!(
            hints[0].gitignore_line, "/.mcp.json",
            "说明里要列出是哪个文件"
        );
    }
    // 确认框里就算勾了（几个去处里别的要提醒）也不追加；报告里记 `key_tracked`，没有可补加的
    let sel = [select("cursor", "github", &to_team)];
    let report = execute_minding_keys(prepare(&locations, &sel), true, true, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(!w.b.join(".gitignore").exists());
    assert!(report.key_tracked);
    assert!(!report.key_exposed);
    assert!(!report.auto_ignored);
    assert!(report.ignorable.is_empty());
    // 后补也不加（点格子写入的「加进 .gitignore」只给可补加的，这里兜底）
    let mut added = ignore_targets(&w.locations(), std::slice::from_ref(&to_team), backups());
    assert!(!w.b.join(".gitignore").exists());
    assert!(added.take_gitignore_undo().is_none());
    assert!(added.key_tracked, "照实说，不说「已加进」");
}

#[cfg(unix)]
#[test]
fn tracked_after_the_check_is_reported_per_target_and_not_appended() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // issue #155：确认框里对 B 的团队共享出过「同时加进 .gitignore」（Remind），确认前它被 `git add` 了——
    // 写入时按 Tracked 跳过追加，报告记下是哪个目标，提示条才能按目标比对说那一句
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    write(&w.b.join(".mcp.json"), &servers(json!({})));
    let locations = w.locations();
    let to_team = World::id(&w.b, "claude-code");
    let sel = [select("cursor", "github", &to_team)];
    let hints = key_hints(&prepare(&locations, &sel));
    assert_eq!(hint_of(&hints, &to_team), KeyHint::Remind, "{hints:?}");
    git(&w.b, &["add", ".mcp.json"]);
    let report = execute_minding_keys(prepare(&locations, &sel), true, true, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(!w.b.join(".gitignore").exists());
    assert!(report.key_tracked);
    assert_eq!(report.tracked_targets, vec![to_team], "提示条按目标比对");
    assert!(!report.key_exposed && !report.auto_ignored);
    assert!(report.ignorable.is_empty());
}

// ===== 点格子写入（产品负责人 2026-10-06） =====

#[cfg(unix)]
#[test]
fn grid_write_reports_what_can_be_ignored_and_adds_it_on_request() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    let locations = w.locations();
    let to_a = World::id(&w.a, "cursor");
    let sel = [select("cursor", "github", &to_a)];
    // 格子写入没有勾选：照常写、不加；报告里给出写成后可以补加进 .gitignore 的目标
    let mut report = execute_minding_keys(prepare(&locations, &sel), true, false, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(report.key_exposed);
    assert_eq!(report.ignorable, vec![to_a.clone()]);
    assert!(!w.a.join(".gitignore").exists());
    // 点提示条上的「加进 .gitignore」
    let mut added = ignore_targets(&w.locations(), &report.ignorable, backups());
    assert_eq!(added.gitignore_failed, None);
    assert_eq!(
        fs::read_to_string(w.a.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
    // 和这次写入同一次撤销：先撤配置，再撤那一行（新建的 .gitignore 删掉）
    let ignore = added.take_gitignore_undo().expect("追加进撤销链");
    undo_config(&mut report);
    assert_eq!(undo_write(&ignore).outcome, "undone");
    assert!(!w.a.join(".gitignore").exists());
    // 不认识的位置、用户级的位置：什么都不做
    let mut none = ignore_targets(
        &w.locations(),
        &["nope".to_string(), "cursor".to_string()],
        backups(),
    );
    assert!(none.take_gitignore_undo().is_none());
    assert_eq!(none.gitignore_failed, None);
}

#[cfg(unix)]
#[test]
fn grid_write_from_an_ignored_source_ignores_the_target_by_itself() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(&w.a.join(".gitignore"), ".cursor/mcp.json\n");
    write(&w.a.join(".cursor/mcp.json"), &keyed());
    let locations = w.locations();
    let to_b = World::id(&w.b, "cursor");
    let sel = [select(&World::id(&w.a, "cursor"), "github", &to_b)];
    let report = execute_minding_keys(prepare(&locations, &sel), true, false, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(report.auto_ignored);
    assert!(!report.key_exposed);
    assert!(report.ignorable.is_empty(), "已经加了，不给键");
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
}

#[cfg(unix)]
#[test]
fn merged_duplicate_sources_keep_the_ignored_one() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 用户级与 A（被忽略）里有一模一样的一份，同时写进 B：合并成一条，仍照搬 A 的忽略
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    write(&w.a.join(".gitignore"), ".cursor/mcp.json\n");
    write(&w.a.join(".cursor/mcp.json"), &keyed());
    let locations = w.locations();
    let to_b = World::id(&w.b, "cursor");
    let sel = [
        select("cursor", "github", &to_b),
        select(&World::id(&w.a, "cursor"), "github", &to_b),
    ];
    assert_eq!(
        hint_of(&key_hints(&prepare(&locations, &sel)), &to_b),
        KeyHint::AutoIgnore
    );
    let report = execute_minding_keys(prepare(&locations, &sel), true, false, backups());
    assert_eq!(created(&report), 1, "{:?}", report.entries);
    assert!(report.auto_ignored);
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
}

#[cfg(unix)]
#[test]
fn merged_duplicate_sources_with_a_committed_one_stay_quiet() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 同一份带密钥的定义：A 里提交过，用户级里也有一份；一起写进 B——密钥早在仓库里了，不提醒
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    write(&w.a.join(".cursor/mcp.json"), &keyed());
    git(&w.a, &["add", ".cursor/mcp.json"]);
    git(&w.a, &["commit", "-q", "-m", "init"]);
    let locations = w.locations();
    let to_b = World::id(&w.b, "cursor");
    let sel = [
        select("cursor", "github", &to_b),
        select(&World::id(&w.a, "cursor"), "github", &to_b),
    ];
    assert_eq!(
        hint_of(&key_hints(&prepare(&locations, &sel)), &to_b),
        KeyHint::SourceCommitted
    );
}

// ===== 「保留这份」（issue #147）：来源＝选中那一份所在的文件，目标＝要改写的其他几处 =====

/// 没有密钥的旧定义：目标那几处原来的样子
fn plain() -> String {
    servers(json!({"github": {"command": "old"}}))
}

/// 这几处的位置 id 都参与「保留这份」：选中 `keep`，其余的改成它
fn keep_plan(locations: &[McpLocation], keep: &str, ids: &[&str]) -> McpKeepPlan {
    let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
    prepare_keep(locations, "github", keep, &ids)
}

fn updated(report: &McpReport) -> usize {
    report
        .entries
        .iter()
        .filter(|e| e.outcome == "updated")
        .count()
}

#[cfg(unix)]
#[test]
fn keep_user_level_reminds_for_project_files_and_appends_only_when_asked() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 选中用户级 Cursor 那一份（带密钥）；其余几处：用户级 Claude Code（不进仓库）、A 的 Cursor 与团队共享
    // （共用 A 的一个 .gitignore，还没有）、B 的 Cursor（B 已有 .gitignore）
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    write(&w.home.join(".claude.json"), &plain());
    write(&w.a.join(".cursor/mcp.json"), &plain());
    write(&w.a.join(".mcp.json"), &plain());
    write(&w.b.join(".cursor/mcp.json"), &plain());
    write(&w.b.join(".gitignore"), "node_modules/\n");
    let locations = w.locations();
    let a_cursor = World::id(&w.a, "cursor");
    let a_team = World::id(&w.a, "claude-code");
    let b_cursor = World::id(&w.b, "cursor");
    let ids = ["cursor", "claude-code", &a_cursor, &a_team, &b_cursor];
    let files = [
        w.home.join(".claude.json"),
        w.a.join(".cursor/mcp.json"),
        w.a.join(".mcp.json"),
        w.b.join(".cursor/mcp.json"),
    ];
    let before: Vec<Vec<u8>> = files.iter().map(|f| fs::read(f).unwrap()).collect();

    // 确认框问一次：只有写进 git 仓库里的项目文件的给，用户级不给
    let hints = keep_key_hints(&keep_plan(&locations, "cursor", &ids));
    assert_eq!(hints.len(), 3, "{hints:?}");
    for id in [&a_cursor, &a_team, &b_cursor] {
        assert_eq!(hint_of(&hints, id), KeyHint::Remind, "{id}");
    }
    let team = hints.iter().find(|h| h.target_id == a_team).unwrap();
    assert_eq!(team.gitignore_line, "/.mcp.json");
    assert_eq!(team.project, w.a);

    // 没勾：照常改，不碰 .gitignore；报告记下密钥进了仓库（确认框出过勾选的，提示条不再说）
    let mut report =
        execute_keep_minding_keys(keep_plan(&locations, "cursor", &ids), false, backups());
    assert_eq!(updated(&report), 4, "{:?}", report.entries);
    assert!(!w.a.join(".gitignore").exists());
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        "node_modules/\n"
    );
    assert!(report.key_exposed);
    assert_eq!(
        report.ignorable.len(),
        3,
        "提示条按目标比对：{:?}",
        report.ignorable
    );
    assert!(!report.auto_ignored);
    assert!(report.take_gitignore_undo().is_none());
    undo_config(&mut report);
    for (file, bytes) in files.iter().zip(&before) {
        assert_eq!(&fs::read(file).unwrap(), bytes, "{}", file.display());
    }

    // 勾了：改完追加，A 的两个文件进同一个新建的 .gitignore，B 的追加在末尾
    let mut report =
        execute_keep_minding_keys(keep_plan(&locations, "cursor", &ids), true, backups());
    assert_eq!(updated(&report), 4, "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(w.a.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n/.mcp.json\n"
    );
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        "node_modules/\n.cursor/mcp.json\n"
    );
    assert!(!report.key_exposed);
    assert!(!report.auto_ignored);
    assert_eq!(report.gitignore_failed, None);
    // 和「保留这份」同一次撤销：不另给 .gitignore 的撤销号，撤一次配置与 .gitignore 一起退回
    assert!(report.take_gitignore_undo().is_none());
    undo_config(&mut report);
    for (file, bytes) in files.iter().zip(&before) {
        assert_eq!(&fs::read(file).unwrap(), bytes, "{}", file.display());
    }
    assert!(!w.a.join(".gitignore").exists(), "新建的 .gitignore 删掉");
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        "node_modules/\n"
    );
}

#[cfg(unix)]
#[test]
fn keep_an_ignored_project_file_ignores_the_targets_by_itself() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 选中 A 里被忽略的那一份：照搬到 B 的两个文件（共用 B 的一个 .gitignore）；用户级那一处不进仓库
    write(&w.a.join(".gitignore"), ".cursor/mcp.json\n");
    write(&w.a.join(".cursor/mcp.json"), &keyed());
    write(&w.home.join(".cursor/mcp.json"), &plain());
    write(&w.b.join(".cursor/mcp.json"), &plain());
    write(&w.b.join(".mcp.json"), &plain());
    let locations = w.locations();
    let keep = World::id(&w.a, "cursor");
    let b_cursor = World::id(&w.b, "cursor");
    let b_team = World::id(&w.b, "claude-code");
    let ids = [keep.as_str(), "cursor", &b_cursor, &b_team];

    let hints = keep_key_hints(&keep_plan(&locations, &keep, &ids));
    assert_eq!(hint_of(&hints, &b_cursor), KeyHint::AutoIgnore);
    assert_eq!(hint_of(&hints, &b_team), KeyHint::AutoIgnore);
    assert!(hints.iter().all(|h| h.target_id != "cursor"), "{hints:?}");

    // 没勾也加（勾选只管第一次暴露）；提示条说「已加进 .gitignore」
    let mut report =
        execute_keep_minding_keys(keep_plan(&locations, &keep, &ids), false, backups());
    assert_eq!(updated(&report), 3, "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n/.mcp.json\n"
    );
    assert!(report.auto_ignored);
    assert!(!report.key_exposed);
    // 撤销一次全部退回，两行一起
    undo_config(&mut report);
    assert!(!w.b.join(".gitignore").exists());
    assert_eq!(fs::read_to_string(w.b.join(".mcp.json")).unwrap(), plain());
}

#[cfg(unix)]
#[test]
fn keep_into_tracked_or_from_committed_never_appends() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 选中 A 里提交过的那一份（密钥早在仓库里）：B 的 Cursor 来源已提交、什么都不说；
    // B 的团队共享已被跟踪：.gitignore 管不住，只说一句
    write(&w.a.join(".mcp.json"), &keyed());
    git(&w.a, &["add", ".mcp.json"]);
    git(&w.a, &["commit", "-q", "-m", "init"]);
    write(&w.b.join(".mcp.json"), &plain());
    git(&w.b, &["add", ".mcp.json"]);
    git(&w.b, &["commit", "-q", "-m", "init"]);
    write(&w.b.join(".cursor/mcp.json"), &plain());
    let locations = w.locations();
    let keep = World::id(&w.a, "claude-code");
    let b_cursor = World::id(&w.b, "cursor");
    let b_team = World::id(&w.b, "claude-code");
    let ids = [keep.as_str(), &b_cursor, &b_team];

    let hints = keep_key_hints(&keep_plan(&locations, &keep, &ids));
    assert_eq!(hint_of(&hints, &b_cursor), KeyHint::SourceCommitted);
    assert_eq!(hint_of(&hints, &b_team), KeyHint::Tracked);

    // 就算勾了（确认框不会出勾选，这里防后端多做）也不加
    let report = execute_keep_minding_keys(keep_plan(&locations, &keep, &ids), true, backups());
    assert_eq!(updated(&report), 2, "{:?}", report.entries);
    assert!(!w.b.join(".gitignore").exists());
    assert!(report.key_tracked);
    assert_eq!(
        report.tracked_targets,
        vec![b_team.clone()],
        "提示条按目标比对"
    );
    assert!(!report.key_exposed);
    assert!(!report.auto_ignored);

    // 选中的用户级那一份（与 B 里此刻的不一样）第一次进 B，但 B 的目标已被跟踪：仍是只说一句
    write(
        &w.home.join(".cursor/mcp.json"),
        &servers(json!({"github": {"command": "other", "env": {"GITHUB_TOKEN": TOKEN}}})),
    );
    let locations = w.locations();
    let hints = keep_key_hints(&keep_plan(&locations, "cursor", &["cursor", &b_team]));
    assert_eq!(hint_of(&hints, &b_team), KeyHint::Tracked);
}

#[cfg(unix)]
#[test]
fn keep_stays_quiet_without_keys_or_when_targets_are_ignored() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 占位不算密钥
    write(
        &w.home.join(".cursor/mcp.json"),
        &servers(json!({"github": {"command": "srv", "env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}}})),
    );
    write(&w.a.join(".cursor/mcp.json"), &plain());
    // B 的目标已被忽略：不会进仓库
    write(&w.b.join(".gitignore"), ".cursor/\n");
    write(&w.b.join(".cursor/mcp.json"), &plain());
    let locations = w.locations();
    let a_cursor = World::id(&w.a, "cursor");
    let b_cursor = World::id(&w.b, "cursor");
    let hints = keep_key_hints(&keep_plan(&locations, "cursor", &["cursor", &a_cursor]));
    assert_eq!(hint_of(&hints, &a_cursor), KeyHint::Quiet);

    write(&w.home.join(".cursor/mcp.json"), &keyed());
    let locations = w.locations();
    let hints = keep_key_hints(&keep_plan(&locations, "cursor", &["cursor", &b_cursor]));
    assert_eq!(hint_of(&hints, &b_cursor), KeyHint::Quiet);
    let report = execute_keep_minding_keys(
        keep_plan(&locations, "cursor", &["cursor", &b_cursor]),
        true,
        backups(),
    );
    assert_eq!(updated(&report), 1, "{:?}", report.entries);
    assert_eq!(
        fs::read_to_string(w.b.join(".gitignore")).unwrap(),
        ".cursor/\n"
    );
    assert!(!report.key_exposed && !report.auto_ignored && !report.key_tracked);
}

#[cfg(unix)]
#[test]
fn keep_that_does_not_go_through_appends_nothing() {
    let Some(w) = World::new() else {
        eprintln!("没有 git，跳过");
        return;
    };
    write(&w.home.join(".cursor/mcp.json"), &keyed());
    write(&w.a.join(".cursor/mcp.json"), &plain());
    let locations = w.locations();
    let a_cursor = World::id(&w.a, "cursor");
    let ids = vec!["cursor".to_string(), a_cursor.clone()];
    // 用户看过表之后这几份又被改过：整次不动，勾了也不加
    let plan = prepare_keep_seen(&locations, "github", "cursor", &ids, "stale");
    let report = execute_keep_minding_keys(plan, true, backups());
    assert_eq!(updated(&report), 0, "{:?}", report.entries);
    assert!(!w.a.join(".gitignore").exists());
    assert!(!report.key_exposed);
}

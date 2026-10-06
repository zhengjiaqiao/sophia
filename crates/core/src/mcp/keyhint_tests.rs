//! 密钥提醒接到 MCP 上（spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」，issue #112）：
//! 「像密钥的值」的判断、安装页每个目标的提醒、勾了「同时加进 .gitignore」之后写入时追加。
//! 在临时目录里搭真实项目（`git init`），不碰本机配置
use super::*;
use crate::keyhint::KeyHint;
use crate::market::{McpDefinitionInput, McpInstallRequest};
use crate::test_support::{backups, TempTree};
use serde_json::json;
use std::process::Command;

// ===== 像密钥的值 =====

fn canon(value: Value) -> Canonical {
    canon_json(&value, Some("headersHelper"))
}

#[test]
fn literal_values_under_key_names_are_keys() {
    let keyed = [
        json!({"command": "npx", "env": {"BRAVE_API_KEY": "BSA123"}}),
        json!({"command": "npx", "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "abc"}}),
        json!({"url": "https://x.test/mcp", "headers": {"Authorization": "Bearer abc"}}),
        json!({"url": "https://x.test/mcp", "headers": {"X-Api-Key": "abc"}}),
        json!({"command": "srv", "args": ["--api-key", "abc"]}),
        json!({"command": "srv", "args": ["--token=abc"]}),
        json!({"command": "srv", "args": ["-H", "Authorization: Bearer abc"]}),
        json!({"command": "srv", "args": ["PASSWORD=hunter2"]}),
        json!({"url": "https://x.test/mcp?api_key=abc"}),
        json!({"url": "https://x.test/mcp#access_token=abc"}),
        json!({"url": "https://user:pw@x.test/mcp"}),
        // 名字不像，值本身有已知的密钥前缀
        json!({"command": "srv", "env": {"OPENAI": "sk-proj-0123456789abcdefghij"}}),
        json!({"command": "srv", "args": ["ghp_0123456789abcdefghijklmn"]}),
    ];
    for value in keyed {
        assert!(has_key_values(&canon(value.clone())), "应算密钥：{value}");
    }
}

#[test]
fn placeholders_and_plain_values_are_not_keys() {
    let plain = [
        json!({"command": "npx", "args": ["-y", "@modelcontextprotocol/server-brave-search"],
               "env": {"BRAVE_API_KEY": "${BRAVE_API_KEY}"}}),
        json!({"url": "https://x.test/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"}}),
        json!({"command": "srv", "args": ["--api-key", "${API_KEY}"]}),
        json!({"command": "srv", "args": ["--token=${TOKEN}"]}),
        json!({"url": "https://x.test/mcp?api_key=${KEY}"}),
        json!({"url": "https://x.test/mcp?page=2&lang=en"}),
        json!({"command": "npx", "args": ["-y", "pkg", "/tmp"], "env": {"DEBUG": "1"}}),
        // 名字像密钥、值是空的：没有东西可泄露
        json!({"command": "npx", "env": {"API_KEY": ""}}),
        // 用命令生成请求头：命令本身不是密钥
        json!({"url": "https://x.test/mcp", "headersHelper": "get-token.sh"}),
    ];
    for value in plain {
        assert!(
            !has_key_values(&canon(value.clone())),
            "不应算密钥：{value}"
        );
    }
}

// ===== 安装页：每个目标的提醒 =====

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

fn harnesses() -> Vec<Harness> {
    vec![
        harness("claude-code", "Claude Code"),
        harness("cursor", "Cursor"),
    ]
}

fn env(home: &Path) -> Env {
    Env {
        home: home.to_path_buf(),
        vars: Default::default(),
    }
}

/// 精选里的 brave-search：要填的密钥在 env 里
fn brave() -> McpDefinitionInput {
    serde_json::from_value(json!({
        "name": "brave-search",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "env": {"BRAVE_API_KEY": "${BRAVE_API_KEY}"}
    }))
    .unwrap()
}

/// 没有任何密钥的
fn fetch() -> McpDefinitionInput {
    serde_json::from_value(json!({
        "name": "fetch",
        "transport": "stdio",
        "command": "uvx",
        "args": ["mcp-server-fetch"]
    }))
    .unwrap()
}

fn request(
    def: McpDefinitionInput,
    project: &Path,
    ids: &[&str],
    scope: Option<&str>,
) -> McpInstallRequest {
    McpInstallRequest {
        definitions: vec![def],
        location: format!("project:{}", project.display()),
        harness_ids: ids.iter().map(|id| id.to_string()).collect(),
        values: [("BRAVE_API_KEY".to_string(), "BSA-real-key".to_string())].into(),
        claude_code_scope: scope.map(Into::into),
        add_to_gitignore: false,
    }
}

fn hint(checks: &[crate::market::McpTargetCheck], id: &str) -> KeyHint {
    checks
        .iter()
        .find(|c| c.harness_id == id)
        .unwrap_or_else(|| panic!("没有 {id}：{checks:?}"))
        .key_hint
}

fn line(checks: &[crate::market::McpTargetCheck], id: &str) -> Option<String> {
    checks
        .iter()
        .find(|c| c.harness_id == id)
        .unwrap()
        .gitignore_line
        .clone()
}

/// `git init` 一个项目；没有 git 时为 None
fn git_project(t: &TempTree, name: &str) -> Option<PathBuf> {
    let project = t.dir(name);
    let ok = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&project)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .ok()?
        .success();
    assert!(ok, "git init");
    Some(project)
}

#[cfg(unix)]
#[test]
fn check_reminds_only_for_keys_written_into_a_git_project() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo project") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let env = env(&home);
    let ids = ["claude-code", "cursor"];

    // Claude Code 仅自己写 ~/.claude.json，不进仓库；Cursor 写 .cursor/mcp.json
    let checks = check_targets(&env, &harnesses(), &request(brave(), &project, &ids, None));
    assert_eq!(hint(&checks, "claude-code"), KeyHint::Quiet);
    assert_eq!(hint(&checks, "cursor"), KeyHint::Remind);
    // 提示框要说加哪一行：只有要提醒的目标给
    assert_eq!(line(&checks, "cursor").as_deref(), Some(".cursor/mcp.json"));
    assert_eq!(line(&checks, "claude-code"), None);

    // 团队共享：写项目的 .mcp.json
    let team = check_targets(
        &env,
        &harnesses(),
        &request(brave(), &project, &ids, Some("team")),
    );
    assert_eq!(hint(&team, "claude-code"), KeyHint::Remind);
    assert_eq!(line(&team, "claude-code").as_deref(), Some("/.mcp.json"));

    // 没有像密钥的值：都不提醒
    let plain = check_targets(
        &env,
        &harnesses(),
        &request(fetch(), &project, &ids, Some("team")),
    );
    assert_eq!(hint(&plain, "claude-code"), KeyHint::Quiet);
    assert_eq!(hint(&plain, "cursor"), KeyHint::Quiet);

    // 用户级：不是项目文件
    let mut global = request(brave(), &project, &ids, None);
    global.location = "global".into();
    let checks = check_targets(&env, &harnesses(), &global);
    assert_eq!(hint(&checks, "cursor"), KeyHint::Quiet);
}

#[cfg(unix)]
#[test]
fn check_is_quiet_when_the_project_is_not_a_git_repo() {
    let t = TempTree::new();
    let home = t.dir("home");
    let project = t.dir("plain");
    if crate::keyhint::in_repo(&project) {
        eprintln!("临时目录在 git 仓库里，跳过");
        return;
    }
    let checks = check_targets(
        &env(&home),
        &harnesses(),
        &request(brave(), &project, &["claude-code", "cursor"], Some("team")),
    );
    assert_eq!(hint(&checks, "claude-code"), KeyHint::Quiet);
    assert_eq!(hint(&checks, "cursor"), KeyHint::Quiet);
}

// ===== 写入后追加 .gitignore =====

#[cfg(unix)]
#[test]
fn write_appends_gitignore_only_when_asked() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let env = env(&home);

    // 没勾：只写配置，不碰 .gitignore
    let report = write_definitions(
        &env,
        &harnesses(),
        &request(brave(), &project, &["cursor"], None),
        backups(),
    );
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert!(!project.join(".gitignore").exists());

    // 勾了：写进去之后 .gitignore 末尾多一行（原有内容不动）
    fs::write(project.join(".gitignore"), "node_modules/\n").unwrap();
    let mut asked = request(brave(), &project, &["claude-code"], Some("team"));
    asked.add_to_gitignore = true;
    let report = write_definitions(&env, &harnesses(), &asked, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert_eq!(report.gitignore_failed, None);
    assert_eq!(
        fs::read_to_string(project.join(".gitignore")).unwrap(),
        "node_modules/\n/.mcp.json\n"
    );
}

#[cfg(unix)]
#[test]
fn write_leaves_gitignore_alone_for_files_outside_the_repo_or_without_keys() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let env = env(&home);
    // Claude Code 仅自己：写的是 ~/.claude.json
    let mut own = request(brave(), &project, &["claude-code"], None);
    own.add_to_gitignore = true;
    let report = write_definitions(&env, &harnesses(), &own, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    // 没有密钥
    let mut plain = request(fetch(), &project, &["cursor"], None);
    plain.add_to_gitignore = true;
    let report = write_definitions(&env, &harnesses(), &plain, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert!(!project.join(".gitignore").exists());
}

#[cfg(unix)]
#[test]
fn gitignore_failure_is_reported_but_the_write_stands() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    // `.gitignore` 是个文件夹：追加不了
    fs::create_dir(project.join(".gitignore")).unwrap();
    let mut asked = request(brave(), &project, &["cursor"], None);
    asked.add_to_gitignore = true;
    let report = write_definitions(&env(&home), &harnesses(), &asked, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    let reason = report.gitignore_failed.expect("应当说 .gitignore 没写成");
    assert!(reason.starts_with("没能加进 .gitignore："), "{reason}");
    assert!(project.join(".cursor/mcp.json").is_file());
}

/// 要填的占位名字像密钥、所在的位置名字不像（裸参数、`OPENAI=${OPENAI_API_KEY}`）：填进去的就是密钥。
/// 检查时值还没给后端，按占位名判断；写的时候同一套判断，勾了就照样追加
#[cfg(unix)]
#[test]
fn key_named_placeholders_count_before_and_after_filling() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let env = env(&home);
    let def: McpDefinitionInput = serde_json::from_value(json!({
        "name": "llm",
        "transport": "stdio",
        "command": "llm-mcp",
        "args": ["--model", "gpt", "${OPENAI_API_KEY}"],
        "env": {"OPENAI": "${OPENAI_API_KEY}"}
    }))
    .unwrap();
    let mut asked = request(def, &project, &["cursor"], None);
    let checks = check_targets(
        &env,
        &harnesses(),
        &McpInstallRequest {
            values: Default::default(),
            ..asked.clone()
        },
    );
    assert_eq!(hint(&checks, "cursor"), KeyHint::Remind);
    asked.values = [("OPENAI_API_KEY".to_string(), "abc123".to_string())].into();
    asked.add_to_gitignore = true;
    let report = write_definitions(&env, &harnesses(), &asked, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert_eq!(
        fs::read_to_string(project.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
}

/// 名字像密钥的占位是选填、没填：那一项整项不写，写进去的没有密钥，勾了也不追加
#[cfg(unix)]
#[test]
fn optional_key_left_empty_does_not_touch_gitignore() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let def: McpDefinitionInput = serde_json::from_value(json!({
        "name": "llm",
        "transport": "stdio",
        "command": "llm-mcp",
        "env": {"OPENAI": "${OPENAI_API_KEY}"}
    }))
    .unwrap();
    let mut asked = request(def, &project, &["cursor"], None);
    asked.values = Default::default();
    asked.add_to_gitignore = true;
    let report = write_definitions(&env(&home), &harnesses(), &asked, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert!(!project.join(".gitignore").exists());
}

/// 目标文件已经被现有规则忽略（`.cursor/`）：不会进仓库，不提醒，勾了也不再追加
#[cfg(unix)]
#[test]
fn target_already_ignored_is_quiet() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let env = env(&home);
    let before = ".cursor/\n";
    fs::write(project.join(".gitignore"), before).unwrap();
    let mut asked = request(brave(), &project, &["claude-code", "cursor"], Some("team"));
    let checks = check_targets(&env, &harnesses(), &asked);
    assert_eq!(hint(&checks, "cursor"), KeyHint::Quiet);
    // .mcp.json 没被忽略：照旧提醒
    assert_eq!(hint(&checks, "claude-code"), KeyHint::Remind);
    asked.harness_ids = vec!["cursor".into()];
    asked.add_to_gitignore = true;
    let report = write_definitions(&env, &harnesses(), &asked, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert_eq!(
        fs::read_to_string(project.join(".gitignore")).unwrap(),
        before
    );
}

/// 撤销这次安装：配置还原，这次追加进 .gitignore 的那一行也撤回；新建的 .gitignore 删掉。
/// 两个目标往同一个 .gitignore 各加一行，撤销一次全退回
#[cfg(unix)]
#[test]
fn undo_takes_back_the_gitignore_lines() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo") else {
        eprintln!("没有 git，跳过");
        return;
    };
    let env = env(&home);
    let gitignore = project.join(".gitignore");

    // 原来没有 .gitignore：两个目标都追加，撤销后整个删掉
    let mut asked = request(brave(), &project, &["claude-code", "cursor"], Some("team"));
    asked.add_to_gitignore = true;
    let mut report = write_definitions(&env, &harnesses(), &asked, backups());
    assert_eq!(
        fs::read_to_string(&gitignore).unwrap(),
        "/.mcp.json\n.cursor/mcp.json\n"
    );
    let undo = report.take_undo().expect("应当能撤销");
    assert!(undo.target_paths().any(|p| p == gitignore));
    let undone = undo_write(&undo);
    assert_eq!(undone.outcome, "undone", "{:?}", undone.files);
    assert!(!gitignore.exists(), "新建的 .gitignore 删掉");
    assert!(!project.join(".mcp.json").exists());
    assert!(!project.join(".cursor/mcp.json").exists());

    // 原来有：退回原样
    let before = "node_modules/\r\n";
    fs::write(&gitignore, before).unwrap();
    let mut report = write_definitions(&env, &harnesses(), &asked, backups());
    assert_eq!(
        fs::read_to_string(&gitignore).unwrap(),
        "node_modules/\r\n/.mcp.json\r\n.cursor/mcp.json\r\n"
    );
    let undone = undo_write(&report.take_undo().unwrap());
    assert_eq!(undone.outcome, "undone", "{:?}", undone.files);
    assert_eq!(fs::read_to_string(&gitignore).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn tracked_target_is_noted_and_never_gets_a_gitignore_line() {
    let t = TempTree::new();
    let home = t.dir("home");
    let Some(project) = git_project(&t, "repo project") else {
        eprintln!("没有 git，跳过");
        return;
    };
    // 团队共享的 .mcp.json 已经提交过（里面没有密钥）
    fs::write(project.join(".mcp.json"), "{\"mcpServers\": {}}\n").unwrap();
    for args in [
        &["add", ".mcp.json"][..],
        &["commit", "-q", "-m", "init"][..],
    ] {
        let ok = Command::new("git")
            .args(args)
            .current_dir(&project)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.test")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }
    let env = env(&home);
    let ids = ["claude-code", "cursor"];
    let checks = check_targets(
        &env,
        &harnesses(),
        &request(brave(), &project, &ids, Some("team")),
    );
    // 已被跟踪的出说明（要列出是哪个文件），没跟踪的照旧提醒
    assert_eq!(hint(&checks, "claude-code"), KeyHint::Tracked);
    assert_eq!(line(&checks, "claude-code").as_deref(), Some("/.mcp.json"));
    assert_eq!(hint(&checks, "cursor"), KeyHint::Remind);
    // 勾了「同时加进 .gitignore」（为 Cursor 那一份）：只加没被跟踪的那一行
    let mut asked = request(brave(), &project, &ids, Some("team"));
    asked.add_to_gitignore = true;
    let report = write_definitions(&env, &harnesses(), &asked, backups());
    assert!(
        report.entries.iter().all(|e| e.outcome == "created"),
        "{:?}",
        report.entries
    );
    assert_eq!(
        fs::read_to_string(project.join(".gitignore")).unwrap(),
        ".cursor/mcp.json\n"
    );
}

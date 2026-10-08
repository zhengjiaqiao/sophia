//! WorkBuddy 的 MCP（#256，spec #247「一」「MCP 写入」）：只接用户级 `~/.workbuddy/mcp.json`，通用的
//! `mcpServers` 写法；它自己写的 `.mcp.json`（连接器代理）与 `mcp-approvals.json`（信任记录）一个字节都不碰。
//! 全部在临时目录里搭真实文件，不碰本机配置
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

fn two() -> Vec<Harness> {
    vec![
        harness("claude-code", "Claude Code"),
        harness("workbuddy", "WorkBuddy"),
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

fn sel(source_id: &str, name: &str, target_id: &str) -> McpSelection {
    McpSelection {
        source_id: source_id.into(),
        name: name.into(),
        target_id: target_id.into(),
    }
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

/// WorkBuddy 自己的两份文件：连接器代理与信任记录（真机上的样子）
const PROXY: &str =
    "{\"mcpServers\":{\"connector-proxy\":{\"url\":\"http://127.0.0.1:52011/mcp\"}}}";
const APPROVALS: &str = "{\"a1b2\":true}\n";

#[test]
fn workbuddy_has_only_a_user_level_mcp_json() {
    let t = TempTree::new();
    let home = t.root();
    let project = t.dir("work/app");
    let found = locations(&env(&home, &[]), &two(), std::slice::from_ref(&project));
    let wb: Vec<_> = found
        .iter()
        .filter(|l| l.harness_id == "workbuddy")
        .collect();
    assert_eq!(wb.len(), 1, "只有用户级：{found:?}");
    assert_eq!(wb[0].id, "workbuddy");
    assert_eq!(wb[0].domain, "global");
    assert_eq!(wb[0].label, "WorkBuddy");
    assert_eq!(wb[0].path, home.join(".workbuddy/mcp.json"));
    assert!(supports("workbuddy"));

    // 它的配置目录可被 WORKBUDDY_CONFIG_DIR 换掉（与 skill 目录同一个变量）；空白等于没设
    let moved = t.dir("elsewhere/wb");
    let found = locations(
        &env(&home, &[("WORKBUDDY_CONFIG_DIR", moved.to_str().unwrap())]),
        &two(),
        &[],
    );
    let path = |found: &[McpLocation]| {
        found
            .iter()
            .find(|l| l.id == "workbuddy")
            .unwrap()
            .path
            .clone()
    };
    assert_eq!(path(&found), moved.join("mcp.json"));
    let blank = locations(&env(&home, &[("WORKBUDDY_CONFIG_DIR", " ")]), &two(), &[]);
    assert_eq!(path(&blank), home.join(".workbuddy/mcp.json"));
}

#[test]
fn writing_to_workbuddy_only_inserts_one_member_and_leaves_its_own_files_alone() {
    let t = TempTree::new();
    let home = t.root();
    let wb = t.dir(".workbuddy");
    // 用户在 WorkBuddy 里自己加的一条（带它认的 disabled），排版照它自己的
    let before = "{\n  \"mcpServers\": {\n    \"mine\": {\n      \"command\": \"uvx\",\n      \"args\": [\"mine-mcp\"],\n      \"disabled\": true\n    }\n  }\n}\n";
    fs::write(wb.join("mcp.json"), before).unwrap();
    fs::write(wb.join(".mcp.json"), PROXY).unwrap();
    fs::write(wb.join("mcp-approvals.json"), APPROVALS).unwrap();
    fs::write(
        home.join(".claude.json"),
        json!({"mcpServers": {
            "playwright": {"type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"], "env": {"DEBUG": "1"}},
            "remote": {"type": "http", "url": "https://mcp.example.test/mcp", "headers": {"X-Team": "a"}},
        }})
        .to_string(),
    )
    .unwrap();
    let found = locations(&env(&home, &[]), &two(), &[]);

    let plan = prepare(&found, &[sel("claude-code", "playwright", "workbuddy")]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    let report = execute(plan, false, backups());
    assert_eq!(report.entries[0].outcome, "created", "{:?}", report.entries);

    let after = fs::read(wb.join("mcp.json")).unwrap();
    let inserted = only_inserted(before.as_bytes(), &after);
    let member: Value =
        serde_json::from_str(&format!("{{{}}}", inserted.trim().trim_start_matches(','))).unwrap();
    assert_eq!(
        member,
        json!({"playwright": {"type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"], "env": {"DEBUG": "1"}}})
    );
    // 用户自己那条原样在
    let all: Value = serde_json::from_slice(&after).unwrap();
    assert_eq!(
        all["mcpServers"]["mine"],
        json!({"command": "uvx", "args": ["mine-mcp"], "disabled": true})
    );

    // 远程服务器（Streamable HTTP）也写得进
    let plan = prepare(&found, &[sel("claude-code", "remote", "workbuddy")]);
    assert!(plan.issues.is_empty(), "{:?}", plan.issues);
    assert_eq!(
        execute(plan, false, backups()).entries[0].outcome,
        "created"
    );
    let all: Value = serde_json::from_slice(&fs::read(wb.join("mcp.json")).unwrap()).unwrap();
    assert_eq!(
        all["mcpServers"]["remote"],
        json!({"type": "http", "url": "https://mcp.example.test/mcp", "headers": {"X-Team": "a"}})
    );

    // 它自己的两份一个字节没动
    assert_eq!(fs::read_to_string(wb.join(".mcp.json")).unwrap(), PROXY);
    assert_eq!(
        fs::read_to_string(wb.join("mcp-approvals.json")).unwrap(),
        APPROVALS
    );
}

#[test]
fn workbuddy_mcp_json_is_created_when_missing() {
    let t = TempTree::new();
    let home = t.root();
    let wb = t.dir(".workbuddy");
    fs::write(wb.join(".mcp.json"), PROXY).unwrap();
    fs::write(
        home.join(".claude.json"),
        json!({"mcpServers": {"playwright": {"type": "stdio", "command": "npx"}}}).to_string(),
    )
    .unwrap();
    let found = locations(&env(&home, &[]), &two(), &[]);
    let plan = prepare(&found, &[sel("claude-code", "playwright", "workbuddy")]);
    assert_eq!(
        execute(plan, false, backups()).entries[0].outcome,
        "created"
    );
    let all: Value = serde_json::from_slice(&fs::read(wb.join("mcp.json")).unwrap()).unwrap();
    assert_eq!(
        all,
        json!({"mcpServers": {"playwright": {"type": "stdio", "command": "npx"}}})
    );
    assert_eq!(fs::read_to_string(wb.join(".mcp.json")).unwrap(), PROXY);
    assert!(!wb.join("mcp-approvals.json").exists());
}

#[test]
fn workbuddy_entries_are_read_back_as_the_same_service() {
    let t = TempTree::new();
    let home = t.root();
    let wb = t.dir(".workbuddy");
    fs::write(
        wb.join("mcp.json"),
        json!({"mcpServers": {"playwright": {"command": "npx", "args": ["@playwright/mcp@latest"]}}})
            .to_string(),
    )
    .unwrap();
    fs::write(
        home.join(".claude.json"),
        json!({"mcpServers": {"playwright": {"type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"]}}})
            .to_string(),
    )
    .unwrap();
    let found = locations(&env(&home, &[]), &two(), &[]);
    let overview = scan(&found);
    let entry = overview
        .entries
        .iter()
        .find(|e| e.source_id == "claude-code" && e.name == "playwright")
        .unwrap();
    let wb_cell = entry
        .cells
        .iter()
        .find(|c| c.target_id == "workbuddy")
        .unwrap();
    // 它自己写的（没有 type）与 Claude Code 那份连接一致
    assert_eq!(wb_cell.state, McpCellState::Equal, "{wb_cell:?}");
}

/// 安装页（市场 · 粘贴）勾 WorkBuddy 时那一行的小字：写进去以后要在它里面点「信任」才会连上
#[test]
fn install_page_notes_that_workbuddy_needs_trust() {
    use crate::market::McpInstallRequest;
    let t = TempTree::new();
    let home = t.root();
    t.dir(".workbuddy");
    let pasted = parse_mcp_text(
        r#"{"mcpServers": {"playwright": {"command": "npx", "args": ["@playwright/mcp@latest"]}}}"#,
    );
    assert_eq!(pasted.error, None);
    let request = McpInstallRequest {
        definitions: pasted.servers,
        location: "global".into(),
        harness_ids: vec!["claude-code".into(), "workbuddy".into()],
        values: Default::default(),
        claude_code_scope: None,
        add_to_gitignore: false,
    };
    let checks = check_targets(&env(&home, &[]), &two(), &request);
    let note = |id: &str| {
        checks
            .iter()
            .find(|c| c.harness_id == id)
            .unwrap()
            .note
            .clone()
    };
    assert_eq!(
        note("workbuddy").as_deref(),
        Some("加上后需在 WorkBuddy 里点一下「信任」才会连上")
    );
    assert_eq!(note("claude-code"), None);
}

/// 评审 #17（#261）：安装页勾的 agent 这台电脑上找不到时，小字写产品名（`没有找到 Gemini CLI`），不写 id
#[test]
fn install_page_names_a_missing_agent_by_its_product_name() {
    use crate::market::McpInstallRequest;
    let t = TempTree::new();
    let pasted = parse_mcp_text(r#"{"mcpServers": {"playwright": {"command": "npx"}}}"#);
    let request = McpInstallRequest {
        definitions: pasted.servers,
        location: "global".into(),
        harness_ids: vec!["gemini-cli".into()],
        values: Default::default(),
        claude_code_scope: None,
        add_to_gitignore: false,
    };
    let checks = check_targets(&env(&t.root(), &[]), &two(), &request);
    assert_eq!(checks[0].reason.as_deref(), Some("没有找到 Gemini CLI"));
}

/// 要点「信任」的只有 WorkBuddy（MCP agent 表里一个字段）：给它的应用标识，别家没有
#[test]
fn only_workbuddy_needs_trust_after_writing() {
    assert_eq!(
        crate::mcp::trust_app("workbuddy"),
        Some("com.workbuddy.workbuddy")
    );
    for id in [
        "claude-code",
        "codex",
        "kimi-cli",
        "deepseek-harness",
        "nope",
    ] {
        assert_eq!(crate::mcp::trust_app(id), None, "{id}");
    }
}

/// 评审 #15（#256）：WorkBuddy 自己的字段（`disabled`、`disabledTools`、`description`）认得：「保留这份」改写
/// WorkBuddy 那一项时换定义、留下它们；带着它们写进别家照跨家规则拒绝、说是 WorkBuddy 专属的设置
#[test]
fn workbuddy_own_fields_stay_on_rewrite_and_block_moving_elsewhere() {
    let t = TempTree::new();
    let home = t.root();
    let wb = t.dir(".workbuddy");
    fs::write(
        wb.join("mcp.json"),
        json!({"mcpServers": {
            "fetch": {"command": "uvx", "args": ["old"], "disabled": true, "disabledTools": ["x"], "description": "抓网页"},
            "only": {"command": "uvx", "args": ["only"], "disabledTools": ["y"]},
        }})
        .to_string(),
    )
    .unwrap();
    fs::write(
        home.join(".claude.json"),
        json!({"mcpServers": {"fetch": {"type": "stdio", "command": "uvx", "args": ["new"]}}})
            .to_string(),
    )
    .unwrap();
    let found = locations(&env(&home, &[]), &two(), &[]);

    // 带着它专属的设置写进 Claude Code：拒绝，说是 WorkBuddy 专属的
    let plan = prepare(&found, &[sel("workbuddy", "only", "claude-code")]);
    assert_eq!(plan.issues.len(), 1, "{:?}", plan.issues);
    assert!(
        plan.issues[0].message.contains("WorkBuddy")
            && plan.issues[0].message.contains("disabledTools"),
        "{:?}",
        plan.issues
    );

    // 选 Claude Code 那份改写 WorkBuddy：定义换掉，它自己的字段留着
    let ids = ["claude-code".to_owned(), "workbuddy".to_owned()];
    let report = execute_keep(
        prepare_keep(&found, "fetch", "claude-code", &ids),
        backups(),
    );
    assert_eq!(report.entries[0].outcome, "updated", "{:?}", report.entries);
    let all: Value = serde_json::from_slice(&fs::read(wb.join("mcp.json")).unwrap()).unwrap();
    let fetch = &all["mcpServers"]["fetch"];
    assert_eq!(fetch["args"], json!(["new"]));
    assert_eq!(fetch["disabled"], json!(true));
    assert_eq!(fetch["disabledTools"], json!(["x"]));
    assert_eq!(fetch["description"], json!("抓网页"));
}

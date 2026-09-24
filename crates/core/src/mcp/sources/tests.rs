use super::*;
use crate::mcp::{auto_selections, location_ref, scan, upsert_auto_import, McpCellState};
use crate::store::Store;
use crate::test_support::TempTree;
use serde_json::json;
use std::fs;

fn loc(id: &str, label: &str, harness: &str, domain: &str, path: &Path) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: label.into(),
        harness_id: harness.into(),
        domain: domain.into(),
        path: path.to_path_buf(),
        selector: None,
        matrix_hidden: false,
    }
}

fn write_json(path: &Path, value: serde_json::Value) {
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

/// 全局 Claude Code（~/.claude.json）与 Codex，一个项目 proj（.mcp.json、.codex/config.toml、
/// Claude Local），另一个项目 other（.mcp.json）
struct Fixture {
    tree: TempTree,
    claude_json: PathBuf,
    codex_toml: PathBuf,
    proj: PathBuf,
    other: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tree = TempTree::new();
        let home = tree.dir("home");
        tree.dir("home/.codex");
        let proj = tree.dir("proj");
        tree.dir("proj/.codex");
        let other = tree.dir("other");
        Fixture {
            claude_json: home.join(".claude.json"),
            codex_toml: home.join(".codex/config.toml"),
            tree,
            proj,
            other,
        }
    }
    fn pkey(&self) -> String {
        format!("project:{}", self.proj.display())
    }
    fn okey(&self) -> String {
        format!("project:{}", self.other.display())
    }
    fn locations(&self) -> Vec<McpLocation> {
        let p = self.pkey();
        let o = self.okey();
        let mut local = loc(
            &format!("{p}::claude-code:local"),
            "Claude Code · Local MCPs",
            "claude-code",
            &p,
            &self.claude_json,
        );
        local.selector = Some(self.proj.display().to_string());
        vec![
            loc(
                "claude-code",
                "Claude Code · User MCPs",
                "claude-code",
                "global",
                &self.claude_json,
            ),
            local,
            loc(
                &format!("{p}::claude-code"),
                "Claude Code · Project MCPs",
                "claude-code",
                &p,
                &self.proj.join(".mcp.json"),
            ),
            loc(
                &format!("{o}::claude-code"),
                "Claude Code · Project MCPs",
                "claude-code",
                &o,
                &self.other.join(".mcp.json"),
            ),
            loc("codex", "Codex", "codex", "global", &self.codex_toml),
            loc(
                &format!("{p}::codex"),
                "Codex",
                "codex",
                &p,
                &self.proj.join(".codex/config.toml"),
            ),
        ]
    }
    fn id(&self, which: &str) -> String {
        match which {
            "user" => "claude-code".into(),
            "local" => format!("{}::claude-code:local", self.pkey()),
            "proj" => format!("{}::claude-code", self.pkey()),
            "proj-codex" => format!("{}::codex", self.pkey()),
            "other" => format!("{}::claude-code", self.okey()),
            "codex" => "codex".into(),
            _ => unreachable!(),
        }
    }
    fn location(&self, which: &str) -> McpLocation {
        let id = self.id(which);
        self.locations().into_iter().find(|l| l.id == id).unwrap()
    }
}

fn ids(v: &[&str]) -> BTreeSet<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// 旧 settings.json（没有 mcpSubscriptions）照常读；扫描后认领老数据并写回：
/// 项目里已经有一份与全局一样的 → 订阅全局那处；开着规则往这里写的来源也算。
/// 全局不因项目里抄了一份就订阅项目，两个项目之间也不互相认领；自己的位置不进记录。
/// 再认领一次没有改动
#[test]
fn old_data_is_adopted_on_scan_and_written_back() {
    let f = Fixture::new();
    write_json(
        &f.claude_json,
        json!({"mcpServers": {"docs": {"command": "docs"}, "search": {"command": "search"}}}),
    );
    fs::write(&f.codex_toml, "[mcp_servers.lint]\ncommand = \"lint\"\n").unwrap();
    write_json(
        &f.proj.join(".mcp.json"),
        json!({"mcpServers": {"docs": {"command": "docs"}, "mine": {"command": "mine"}}}),
    );
    // other 也抄了 docs（与全局、与 proj 都一样），另有自己的 x
    write_json(
        &f.other.join(".mcp.json"),
        json!({"mcpServers": {"docs": {"command": "docs"}, "x": {"command": "x"}}}),
    );
    let locations = f.locations();
    let overview = scan(&locations);

    let dir = f.tree.dir("data/SymSync");
    fs::write(
        dir.join("settings.json"),
        json!({"disabledHarnesses": [], "mcpAutoImports": [{
            "source": location_ref(&f.location("codex")),
            "targetDomain": f.okey(),
            "targets": [location_ref(&f.location("other"))],
            "allowCrossDomain": true,
            "baseline": ["lint"]
        }]})
        .to_string(),
    )
    .unwrap();
    let store = Store::new(dir);
    assert!(store.load_settings().unwrap().mcp_subscriptions.is_empty());

    let settings = store
        .load_settings_adopting_mcp_subscriptions(&overview)
        .unwrap();
    let expect: McpSubscriptions = [
        ("global".to_string(), BTreeSet::new()),
        (f.pkey(), ids(&["claude-code"])),
        (f.okey(), ids(&["claude-code", "codex"])),
    ]
    .into_iter()
    .collect();
    assert_eq!(settings.mcp_subscriptions, expect);
    // 写回了
    assert_eq!(store.load_settings().unwrap().mcp_subscriptions, expect);

    // 此后由记录决定：再认领一次没有改动
    let mut subs = expect.clone();
    assert!(!adopt(&mut subs, &overview, &settings.mcp_auto_imports));
    assert_eq!(subs, expect);
}

/// 已订阅来源的全部服务进主视图：没写进的格是 Missing；来源管理页列出自己的（有服务的）
/// 与订阅的；自己那些空着的、主视图藏起来的不列
#[test]
fn unwritten_services_of_a_subscribed_source_are_rows_with_missing_cells() {
    let f = Fixture::new();
    write_json(
        &f.claude_json,
        json!({"mcpServers": {"docs": {"command": "docs"}, "search": {"command": "search"}}}),
    );
    write_json(
        &f.proj.join(".mcp.json"),
        json!({"mcpServers": {"docs": {"command": "docs"}}}),
    );
    let mut locations = f.locations();
    // Local 还空着：主视图藏起来
    locations[1].matrix_hidden = true;
    let mut overview = scan(&locations);
    let mut subs = McpSubscriptions::new();
    adopt(&mut subs, &overview, &[]);
    attach(&mut overview, &subs);

    assert_eq!(
        overview.subscribed.get(&f.pkey()),
        Some(&vec![f.id("user")])
    );
    assert!(!overview.subscribed.contains_key("global"));
    let search = overview
        .entries
        .iter()
        .find(|e| e.source_id == "claude-code" && e.name == "search")
        .unwrap();
    let state = |target: &str| {
        search
            .cells
            .iter()
            .find(|c| c.target_id == f.id(target))
            .unwrap()
            .state
    };
    assert_eq!(state("proj"), McpCellState::Missing);
    assert_eq!(state("proj-codex"), McpCellState::Missing);

    let page = list(&f.pkey(), &overview, &subs, &[]);
    let rows: Vec<(&str, bool, Vec<&str>)> = page
        .subscribed
        .iter()
        .map(|s| {
            (
                s.source.label.as_str(),
                s.own,
                s.source.services.iter().map(|x| x.name.as_str()).collect(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Claude Code · Project", true, vec!["docs"]),
            ("Claude Code · User", false, vec!["docs", "search"]),
        ]
    );
    assert_eq!(page.subscribed[1].source.place, "全局");
    assert_eq!(page.subscribed[0].source.place, "proj");
}

/// 刚订阅、一项都没写进的来源也在：进记录、进主视图、列在已订阅里；
/// 订阅自己的位置什么都不记；别的位置订阅着的进「其他项目在用的」，注明在哪用
#[test]
fn a_fresh_subscription_with_nothing_written_is_listed() {
    let f = Fixture::new();
    fs::write(&f.codex_toml, "[mcp_servers.lint]\ncommand = \"lint\"\n").unwrap();
    write_json(
        &f.other.join(".mcp.json"),
        json!({"mcpServers": {"x": {"command": "x"}}}),
    );
    write_json(
        &f.proj.join(".mcp.json"),
        json!({"mcpServers": {"p": {"command": "p"}}}),
    );
    let locations = f.locations();
    let mut overview = scan(&locations);
    let mut subs = McpSubscriptions::new();
    adopt(&mut subs, &overview, &[]);
    subs.entry(f.okey()).or_default().insert(f.id("codex"));

    subscribe(&mut subs, &f.pkey(), "codex", &overview).unwrap();
    subscribe(&mut subs, &f.pkey(), &f.id("proj"), &overview).unwrap();
    assert_eq!(subs[&f.pkey()], ids(&["codex"]));
    assert!(subscribe(&mut subs, &f.pkey(), "nowhere", &overview).is_err());
    assert!(subscribe(&mut subs, "project:/gone", "codex", &overview).is_err());

    attach(&mut overview, &subs);
    assert_eq!(overview.subscribed[&f.pkey()], vec!["codex".to_string()]);

    let page = list(&f.pkey(), &overview, &subs, &[]);
    let labels: Vec<&str> = page
        .subscribed
        .iter()
        .map(|s| s.source.label.as_str())
        .collect();
    assert_eq!(labels, vec!["Claude Code · Project", "Codex · User"]);
    assert_eq!(page.subscribed[1].source.services[0].name, "lint");
    assert!(page.subscribed[1].source.services[0].portable);

    // 全局那处 codex 已订阅，不在候选里；other 的 .mcp.json 没人订阅 → 检测到的
    assert!(page.elsewhere.is_empty());
    assert_eq!(page.detected.len(), 1);
    assert_eq!(page.detected[0].source.id, f.id("other"));
    assert_eq!(page.detected[0].source.place, "other");

    // 从 other 看：proj 的 .mcp.json 没人订阅 → 检测到的；全局 codex 已订阅
    let from_other = list(&f.okey(), &overview, &subs, &[]);
    assert_eq!(from_other.subscribed[1].source.id, "codex");
    assert_eq!(from_other.detected[0].source.id, f.id("proj"));
    // 从全局看：codex 是自己的；proj 与 other 的都是检测到的
    let from_global = list("global", &overview, &subs, &[]);
    assert!(from_global.subscribed.iter().all(|s| s.own));
    assert_eq!(from_global.detected.len(), 2);

    // 另一个项目订阅着的：进「其他项目在用的」
    let fresh = f.tree.dir("fresh");
    let fkey = format!("project:{}", fresh.display());
    let mut more = locations.clone();
    more.push(loc(
        &format!("{fkey}::claude-code"),
        "Claude Code · Project MCPs",
        "claude-code",
        &fkey,
        &fresh.join(".mcp.json"),
    ));
    let overview = scan(&more);
    let page = list(&fkey, &overview, &subs, &[]);
    assert_eq!(page.elsewhere.len(), 1);
    assert_eq!(page.elsewhere[0].source.id, "codex");
    let used: Vec<&str> = page.elsewhere[0]
        .used_in
        .iter()
        .map(|d| d.label.as_str())
        .collect();
    assert_eq!(used, vec!["other", "proj"]);
}

/// 移除：只拿掉仍与来源一致的那几项（JSON、TOML、同一个 .claude.json 里的 Local 各一处），
/// 确认之后被改过的跳过并如实报告；别的服务、注释、换行、根上的其余字段逐字节不动；
/// 记录与往这里写的规则一起撤，往别处写的规则不动
#[test]
fn remove_takes_out_only_copies_still_equal_to_the_source() {
    let f = Fixture::new();
    let project = f.proj.display().to_string();
    write_json(
        &f.claude_json,
        json!({
            "numStartups": 3,
            "mcpServers": {
                "docs": {"command": "docs", "args": ["-v"]},
                "search": {"command": "search"},
                "web": {"type": "http", "url": "https://web.example"}
            },
            "projects": {
                project.clone(): {"allowedTools": [], "mcpServers": {"docs": {"command": "docs", "args": ["-v"]}}}
            }
        }),
    );
    let mcp_json = f.proj.join(".mcp.json");
    let mcp_before = "{\n  \"mcpServers\": {\n    \"docs\": {\"command\": \"docs\", \"args\": [\"-v\"]},\n    \"mine\": {\"command\": \"mine\"},\n    \"search\": {\"command\": \"search\"}\n  }\n}\n";
    fs::write(&mcp_json, mcp_before).unwrap();
    let codex = f.proj.join(".codex/config.toml");
    let codex_before = "\u{feff}model = \"gpt-5\"\r\n\r\n[mcp_servers.docs]\r\ncommand = \"docs\"\r\nargs = [\"-v\"]\r\n\r\n# 我自己的\r\n[mcp_servers.mine]\r\ncommand = \"mine\"\r\n";
    fs::write(&codex, codex_before).unwrap();

    let locations = f.locations();
    let overview = scan(&locations);
    let mut subs = McpSubscriptions::new();
    adopt(&mut subs, &overview, &[]);
    assert_eq!(subs[&f.pkey()], ids(&["claude-code"]));
    let mut rules = Vec::new();
    for (domain, target) in [(f.pkey(), "proj"), (f.okey(), "other")] {
        upsert_auto_import(
            &mut rules,
            &overview,
            &f.location("user"),
            domain,
            vec![location_ref(&f.location(target))],
            true,
        )
        .unwrap();
    }

    let plan = plan_remove(&f.pkey(), "claude-code", &locations).unwrap();
    let got: Vec<(&str, String)> = plan
        .items
        .iter()
        .map(|i| (i.name.as_str(), i.target_id.clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("docs", f.id("local")),
            ("docs", f.id("proj")),
            ("search", f.id("proj")),
            ("docs", f.id("proj-codex")),
        ]
    );
    assert_eq!(plan.items[1].location, "Claude Code · Project MCPs");
    // 只读：什么都没动
    assert_eq!(fs::read_to_string(&mcp_json).unwrap(), mcp_before);

    // 确认之后，用户改了 .mcp.json 里的 search
    let edited = mcp_before.replace("{\"command\": \"search\"}", "{\"command\": \"search2\"}");
    fs::write(&mcp_json, &edited).unwrap();

    let report = remove(
        &f.pkey(),
        "claude-code",
        &plan.items,
        &locations,
        &mut subs,
        &mut rules,
    )
    .unwrap();
    let outcomes: Vec<(&str, &str, &str)> = report
        .entries
        .iter()
        .map(|e| (e.name.as_str(), e.outcome.as_str(), e.message.as_str()))
        .collect();
    assert_eq!(
        outcomes.iter().filter(|o| o.1 == "removed").count(),
        3,
        "{outcomes:?}"
    );
    assert!(outcomes.contains(&("search", "skipped", "和来源那份不一样了，没动")));

    // .mcp.json：只少了 docs，改过的 search 与 mine 原样
    assert_eq!(
        fs::read_to_string(&mcp_json).unwrap(),
        "{\n  \"mcpServers\": {\n    \"mine\": {\"command\": \"mine\"},\n    \"search\": {\"command\": \"search2\"}\n  }\n}\n"
    );
    // config.toml：BOM、CRLF、注释、别的表逐字节不动
    assert_eq!(
        fs::read_to_string(&codex).unwrap(),
        "\u{feff}model = \"gpt-5\"\r\n\r\n# 我自己的\r\n[mcp_servers.mine]\r\ncommand = \"mine\"\r\n"
    );
    // .claude.json：Local 里的 docs 没了，User 的（来源本身）与其余字段都在
    let claude: serde_json::Value =
        serde_json::from_slice(&fs::read(&f.claude_json).unwrap()).unwrap();
    assert_eq!(claude["numStartups"], 3);
    assert_eq!(claude["mcpServers"].as_object().unwrap().len(), 3);
    assert_eq!(claude["projects"][&project]["mcpServers"], json!({}));
    assert_eq!(claude["projects"][&project]["allowedTools"], json!([]));
    // 写之前留了备份
    assert!(report
        .entries
        .iter()
        .filter(|e| e.outcome == "removed")
        .all(|e| e.backup_path.as_ref().is_some_and(|p| p.exists())));

    // 记录与往 proj 写的规则撤了，往 other 写的留着
    assert!(subs[&f.pkey()].is_empty());
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].target_domain, f.okey());
}

/// 位置自己的配置不能移除：清单与执行都拒绝，什么都不动
#[test]
fn own_locations_cannot_be_removed() {
    let f = Fixture::new();
    let before = "{\"mcpServers\":{\"p\":{\"command\":\"p\"}}}";
    fs::write(f.proj.join(".mcp.json"), before).unwrap();
    let locations = f.locations();
    let mut subs = McpSubscriptions::new();
    let mut rules = Vec::new();
    let err = plan_remove(&f.pkey(), &f.id("proj"), &locations).unwrap_err();
    assert!(err.contains("自己的配置"), "{err}");
    let item = McpRemovalItem {
        name: "p".into(),
        target_id: f.id("proj-codex"),
        location: String::new(),
    };
    assert!(remove(
        &f.pkey(),
        &f.id("proj"),
        &[item],
        &locations,
        &mut subs,
        &mut rules
    )
    .is_err());
    assert!(plan_remove("global", "codex", &locations).is_err());
    assert_eq!(
        fs::read_to_string(f.proj.join(".mcp.json")).unwrap(),
        before
    );
}

/// 订阅来源上的「以后新出现的自动写进」只管以后：打开时已有的不补，之后新出现的才写
#[test]
fn rule_on_a_subscribed_source_only_takes_later_services() {
    let f = Fixture::new();
    fs::write(&f.codex_toml, "[mcp_servers.lint]\ncommand = \"lint\"\n").unwrap();
    let locations = f.locations();
    let overview = scan(&locations);
    let mut subs = McpSubscriptions::new();
    subscribe(&mut subs, &f.pkey(), "codex", &overview).unwrap();
    let mut rules = Vec::new();
    upsert_auto_import(
        &mut rules,
        &overview,
        &f.location("codex"),
        f.pkey(),
        vec![location_ref(&f.location("proj"))],
        true,
    )
    .unwrap();
    assert!(auto_selections(&scan(&locations), &rules).is_empty());

    fs::write(
        &f.codex_toml,
        "[mcp_servers.lint]\ncommand = \"lint\"\n\n[mcp_servers.fmt]\ncommand = \"fmt\"\n",
    )
    .unwrap();
    let picked: Vec<(String, String)> = auto_selections(&scan(&locations), &rules)
        .into_iter()
        .map(|s| (s.name, s.target_id))
        .collect();
    assert_eq!(picked, vec![("fmt".to_string(), f.id("proj"))]);
    // 开着的规则也是订阅的证据
    let page = list(&f.pkey(), &scan(&locations), &subs, &rules);
    assert_eq!(page.subscribed[0].auto_targets, vec![f.id("proj")]);
}

#[test]
fn json_member_cut_keeps_the_rest_byte_for_byte() {
    let cut = |text: &str, name: &str| {
        let bytes = text.as_bytes();
        let (_, _, root) = raw_object_members(bytes).unwrap();
        let servers = root["mcpServers"];
        String::from_utf8(cut_member(bytes, servers, name).unwrap()).unwrap()
    };
    let text = "{\"mcpServers\": {\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}}";
    assert_eq!(
        cut(text, "a"),
        "{\"mcpServers\": {\n  \"b\": 2,\n  \"c\": 3\n}}"
    );
    assert_eq!(
        cut(text, "b"),
        "{\"mcpServers\": {\n  \"a\": 1,\n  \"c\": 3\n}}"
    );
    assert_eq!(
        cut(text, "c"),
        "{\"mcpServers\": {\n  \"a\": 1,\n  \"b\": 2\n}}"
    );
    assert_eq!(
        cut("{\"mcpServers\": { \"a\": 1 }}", "a"),
        "{\"mcpServers\": {}}"
    );
    // 键里带转义的也认得
    let text = r#"{"mcpServers":{"x\"y":1,"z":2}}"#;
    assert_eq!(cut(text, "x\"y"), r#"{"mcpServers":{"z":2}}"#);
    // 顶层 JSON 不认识的写法（重复键）直接放弃
    assert!(remove_json_server(br#"{"mcpServers":{"a":1,"a":2}}"#, None, "a").is_none());
}

#[test]
fn toml_removal_handles_the_usual_shapes_and_refuses_the_rest() {
    let remove = |text: &str, name: &str| {
        remove_toml_server(text.as_bytes(), name).map(|b| String::from_utf8(b).unwrap())
    };
    // 子表一起走；紧挨下一个表头的注释留下
    assert_eq!(
        remove(
            "[mcp_servers.a]\ncommand = \"a\"\n\n[mcp_servers.a.env]\nK = \"v\"\n\n# b 的说明\n[mcp_servers.b]\ncommand = \"b\"\n",
            "a"
        )
        .as_deref(),
        Some("# b 的说明\n[mcp_servers.b]\ncommand = \"b\"\n")
    );
    // [mcp_servers] 表里的单行
    assert_eq!(
        remove(
            "[mcp_servers]\na = { command = \"a\" }\nb = { command = \"b\" }\n",
            "a"
        )
        .as_deref(),
        Some("[mcp_servers]\nb = { command = \"b\" }\n")
    );
    // 根上的点号键
    assert_eq!(
        remove("mcp_servers.a.command = \"a\"\nmodel = \"x\"\n", "a").as_deref(),
        Some("model = \"x\"\n")
    );
    // 最后一个：整张 mcp_servers 表只剩表头时也算一样
    assert_eq!(
        remove("model = \"x\"\n\n[mcp_servers.a]\ncommand = \"a\"\n", "a").as_deref(),
        Some("model = \"x\"\n\n")
    );
    // 多行的内联写法单独拿不掉：放弃，不写
    assert_eq!(
        remove(
            "[mcp_servers]\na = { command = \"a\", args = [\n  \"x\",\n] }\n",
            "a"
        ),
        None
    );
    // 根上一整张内联表：拿不掉单个成员，放弃
    assert_eq!(
        remove(
            "mcp_servers = { a = { command = \"a\" }, b = { command = \"b\" } }\n",
            "a"
        ),
        None
    );
    // 没有它
    assert_eq!(remove("[mcp_servers.b]\ncommand = \"b\"\n", "a"), None);
}

#[test]
fn source_list_serializes_flat_and_camel_case() {
    let entry = McpSubscribedSource {
        source: McpSourceSummary {
            id: "codex".into(),
            label: "Codex · User".into(),
            harness_id: "codex".into(),
            domain: "global".into(),
            place: "全局".into(),
            path: PathBuf::from("/h/.codex/config.toml"),
            unreadable: false,
            services: vec![McpService {
                name: "lint".into(),
                portable: false,
                only_harnesses: None,
            }],
        },
        own: false,
        auto_targets: Vec::new(),
        last_auto: None,
    };
    assert_eq!(
        serde_json::to_value(&entry).unwrap(),
        json!({
            "id": "codex", "label": "Codex · User", "harnessId": "codex", "domain": "global",
            "place": "全局", "path": "/h/.codex/config.toml", "unreadable": false,
            "services": [{"name": "lint", "portable": false}], "own": false, "autoTargets": [],
            "lastAuto": null
        })
    );
    let ran = McpSubscribedSource {
        last_auto: Some(crate::models::AutoRun { at: 7, added: 2 }),
        ..entry
    };
    assert_eq!(
        serde_json::to_value(&ran).unwrap()["lastAuto"],
        json!({"at": 7, "added": 2})
    );
    let item: McpRemovalItem =
        serde_json::from_value(json!({"name": "a", "targetId": "codex"})).unwrap();
    assert_eq!(item.location, "");
}

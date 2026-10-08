//! 家 workbuddy（#266）：打开写 models.json、改选跟上、关掉与退出时拿掉、打开 Sophia 时写回。
//! 只看对外行为：WorkBuddy 的 models.json 原文、路由起没起、状态里写的是什么
use super::tests::{code, fixture, Fixture};
use super::*;
use sophia_core::codex_models::catalog::Model;
use sophia_core::model_providers::ModelRef;

/// 用户自己在 WorkBuddy 里加的一个模型（WorkBuddy 保存成的样子）
const USER_FILE: &str = "[\n  {\n    \"id\": \"my-glm\",\n    \"name\": \"My GLM\",\n    \"url\": \"https://open.bigmodel.cn/api/paas/v4/chat/completions\",\n    \"apiKey\": \"sk-user\"\n  }\n]\n";

impl Fixture {
    fn models_json(&self) -> PathBuf {
        self.root.join("workbuddy").join("models.json")
    }
    fn read_models_json(&self) -> String {
        std::fs::read_to_string(self.models_json()).unwrap_or_default()
    }
    fn models_entries(&self) -> Vec<serde_json::Value> {
        let text = self.read_models_json();
        if text.is_empty() {
            return Vec::new();
        }
        serde_json::from_str::<Vec<serde_json::Value>>(&text).unwrap()
    }
    /// 装了 WorkBuddy、WorkBuddy 里已有一个用户模型；加一家 Kimi，启用两个模型，选进 WorkBuddy
    fn workbuddy_ready(&self) -> (String, Vec<ModelRef>) {
        {
            let mut w = self.world.lock().unwrap();
            w.workbuddy_installed = true;
            w.token = Some("sophia-router-token".into());
        }
        std::fs::create_dir_all(self.models_json().parent().unwrap()).unwrap();
        std::fs::write(self.models_json(), USER_FILE).unwrap();
        let kimi = self.add_provider(
            "Kimi",
            "https://api.moonshot.cn/v1",
            Some("sk-kimi"),
            &[],
            "",
        );
        let refs = self.enable_models(
            &kimi,
            &[
                Model {
                    id: "kimi-k2.6".into(),
                    context_window: Some(256_000),
                    ..Default::default()
                },
                Model::from("kimi-for-coding"),
            ],
        );
        for r in &refs {
            self.app.pick(Agent::WorkBuddy, r, true).unwrap();
        }
        (kimi, refs)
    }
    fn workbuddy_view(&self) -> AgentGatewayView {
        self.app.state().agent(Agent::WorkBuddy).cloned().unwrap()
    }
}

fn ids(entries: &[serde_json::Value]) -> Vec<&str> {
    entries.iter().map(|e| e["id"].as_str().unwrap()).collect()
}

/// 打开：models.json 里用户的条目原样留着，Sophia 的条目按「已选」顺序追加在后面，指向本机路由、带路由令牌；
/// 提供商的密钥不进 WorkBuddy 的文件；路由起来、WorkBuddy 的路由清单写好；状态里说开着、写着
#[test]
fn enabling_writes_entries_pointing_at_the_router_after_the_users_own() {
    let f = fixture();
    f.workbuddy_ready();
    f.app.enable_workbuddy().unwrap();

    let text = f.read_models_json();
    assert!(
        text.starts_with(USER_FILE.trim_end_matches("\n]\n")),
        "{text}"
    );
    let entries = f.models_entries();
    assert_eq!(ids(&entries), ["my-glm", "kimi-k2.6", "kimi-for-coding"]);
    assert_eq!(
        entries[1]["url"],
        "http://127.0.0.1:47328/workbuddy/v1/chat/completions"
    );
    assert_eq!(entries[1]["apiKey"], "sophia-router-token");
    assert_eq!(entries[1]["vendor"], "Kimi");
    // WorkBuddy 菜单里名字与 id 不同时显示成「名字:id」：id 就用显示名，菜单里只出模型名（走查第 9 条）
    assert_eq!(entries[1]["name"], "kimi-k2.6");
    assert_eq!(entries[1]["maxInputTokens"], 256_000);
    assert!(!text.contains("sk-kimi"), "提供商密钥只在 Sophia");
    assert!(!text.contains("availableModels"));
    assert_eq!(f.router(), Some(47328));

    let routing: serde_json::Value = serde_json::from_slice(
        &std::fs::read(workbuddy_routing_file(&f.root.join("data"))).unwrap(),
    )
    .unwrap();
    assert_eq!(routing["models"][0]["slug"], "kimi-k2.6");
    assert_eq!(routing["models"][0]["upstream_model"], "kimi-k2.6");
    assert_eq!(
        routing["providers"][0]["base_url"],
        "https://api.moonshot.cn/v1"
    );

    let view = f.workbuddy_view();
    assert!(view.installed && view.enabled);
    assert!(view.workbuddy.as_ref().unwrap().written);
    assert_eq!(view.models.picked.len(), 2);
    assert!(f.app.quit_preview().workbuddy);
}

/// 菜单里只出模型名（走查 2026-10-07 第 9 条）：WorkBuddy 把名字与 id 不同的自定义模型显示成「名字:id」，
/// 所以条目的 id 就是显示名；两家撞名时带「 · 提供商名」，id 也一样。显示名撞上用户自己条目的 id 时退回内部标识
#[test]
fn entry_ids_are_the_shown_names_so_the_menu_shows_no_internal_id() {
    let f = fixture();
    let (_, refs) = f.workbuddy_ready();
    let relay = f.add_provider("Relay", "https://relay.example/v1", Some("sk-r"), &[], "");
    let more = f.enable_models(&relay, &[Model::from("kimi-k2.6"), Model::from("my-glm")]);
    for r in &more {
        f.app.pick(Agent::WorkBuddy, r, true).unwrap();
    }
    f.app.enable_workbuddy().unwrap();

    let entries = f.models_entries();
    assert_eq!(
        ids(&entries),
        [
            "my-glm",
            "kimi-k2.6 · Kimi",
            "kimi-for-coding",
            "kimi-k2.6 · Relay",
            "relay-my-glm"
        ]
    );
    assert_eq!(entries[1]["name"], "kimi-k2.6 · Kimi");
    let routing: serde_json::Value = serde_json::from_slice(
        &std::fs::read(workbuddy_routing_file(&f.root.join("data"))).unwrap(),
    )
    .unwrap();
    let slugs: Vec<&str> = routing["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap())
        .collect();
    assert_eq!(
        slugs,
        [
            "kimi-k2.6 · kimi",
            "kimi-for-coding",
            "kimi-k2.6 · relay",
            "relay-my-glm"
        ]
    );
    let _ = refs;
}

/// 一个模型都没选时打不开；没装 WorkBuddy 时模型页不列它
#[test]
fn nothing_picked_cannot_be_enabled_and_uninstalled_is_not_listed() {
    let f = fixture();
    f.world.lock().unwrap().workbuddy_installed = true;
    assert_eq!(code(f.app.enable_workbuddy()), "invalid");
    assert!(!f.workbuddy_view().enabled);

    let g = fixture();
    assert!(!g.workbuddy_view().installed);
}

/// 开着时改选当场跟上（不用重启）；取消最后一个＝关掉这一家、条目拿掉
#[test]
fn picks_follow_while_on_and_the_last_unpick_turns_it_off() {
    let f = fixture();
    let (_, refs) = f.workbuddy_ready();
    f.app.enable_workbuddy().unwrap();

    let warnings = f.app.pick(Agent::WorkBuddy, &refs[0], false).unwrap();
    assert!(warnings.is_empty());
    assert_eq!(ids(&f.models_entries()), ["my-glm", "kimi-for-coding"]);

    // 排序：Sophia 的条目按新顺序
    f.app.pick(Agent::WorkBuddy, &refs[0], true).unwrap();
    assert_eq!(
        ids(&f.models_entries()),
        ["my-glm", "kimi-for-coding", "kimi-k2.6"]
    );
    // 恢复默认顺序（按启用先后）、排序（#265）：Sophia 的条目当场按新顺序重写
    f.app.restore_order(Agent::WorkBuddy).unwrap();
    assert_eq!(
        ids(&f.models_entries()),
        ["my-glm", "kimi-k2.6", "kimi-for-coding"]
    );
    f.app
        .reorder_picks(Agent::WorkBuddy, vec![refs[1].clone(), refs[0].clone()])
        .unwrap();
    assert_eq!(
        ids(&f.models_entries()),
        ["my-glm", "kimi-for-coding", "kimi-k2.6"]
    );

    f.app.pick(Agent::WorkBuddy, &refs[0], false).unwrap();
    f.app.pick(Agent::WorkBuddy, &refs[1], false).unwrap();
    assert_eq!(f.read_models_json(), USER_FILE);
    assert!(!f.workbuddy_view().enabled);
    assert_eq!(f.router(), None, "没有别家开着：路由停了");
}

/// 关掉：只拿掉 Sophia 的条目；用户在 WorkBuddy 里加的、改过的都不动。用户把 Sophia 的一条关掉、调了思考强度，
/// 再改选时这些改动还在
#[test]
fn the_users_changes_survive_rewrites_and_turning_off_leaves_their_entries() {
    let f = fixture();
    let (kimi, refs) = f.workbuddy_ready();
    f.app.enable_workbuddy().unwrap();
    // WorkBuddy 里关掉第一条、思考强度改成 high（WorkBuddy 自己保存：整份写成数组）
    let mut entries = f.models_entries();
    entries[1]["disabled"] = true.into();
    entries[1]["reasoning"] = serde_json::json!({"defaultEffort": "high"});
    std::fs::write(
        f.models_json(),
        serde_json::to_string_pretty(&entries).unwrap(),
    )
    .unwrap();

    let more = f.enable_models(
        &kimi,
        &[
            Model::from("kimi-k2.6"),
            Model::from("kimi-for-coding"),
            Model::from("kimi-k2.6-turbo"),
        ],
    );
    f.app.pick(Agent::WorkBuddy, &more[2], true).unwrap();
    let after = f.models_entries();
    assert_eq!(
        ids(&after),
        ["my-glm", "kimi-k2.6", "kimi-for-coding", "kimi-k2.6-turbo"]
    );
    assert_eq!(after[1]["disabled"], true);
    assert_eq!(after[1]["reasoning"]["defaultEffort"], "high");

    f.app.restore_workbuddy().unwrap();
    assert_eq!(ids(&f.models_entries()), ["my-glm"]);
    assert!(!f.workbuddy_view().enabled);
    // 「已选」留着，再打开就回来
    assert_eq!(f.workbuddy_view().models.picked.len(), 3);
    let _ = refs;
}

/// 退出：拿掉条目、停路由，「开着」不变；下次打开 Sophia 时写回。关机时同样拿掉
#[test]
fn quitting_takes_the_entries_out_and_opening_puts_them_back() {
    let f = fixture();
    f.workbuddy_ready();
    f.app.enable_workbuddy().unwrap();

    let failures = f.app.detach_for_quit(|| (), |_| {});
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(f.read_models_json(), USER_FILE);
    assert_eq!(f.router(), None);
    assert!(f.workbuddy_view().enabled, "「开着」不变");
    assert!(!f.app.quit_preview().workbuddy);

    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(
        ids(&f.models_entries()),
        ["my-glm", "kimi-k2.6", "kimi-for-coding"]
    );
    assert_eq!(f.router(), Some(47328));

    f.app.exit_sync();
    assert_eq!(f.read_models_json(), USER_FILE);
}

/// 上次崩溃留下了条目、之后又关掉了：打开 Sophia 时把留下的拿掉，不起路由
#[test]
fn leftovers_from_a_crash_are_removed_when_turned_off() {
    let f = fixture();
    f.workbuddy_ready();
    f.app.enable_workbuddy().unwrap();
    f.world.lock().unwrap().workbuddy.enabled = false;
    f.world.lock().unwrap().router = None;

    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{report:?}");
    assert_eq!(f.read_models_json(), USER_FILE);
    assert_eq!(f.router(), None);
}

/// 路由各家共用：关掉 Codex 时 WorkBuddy 还开着，路由留着
#[test]
fn the_router_stays_up_while_workbuddy_is_on() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.workbuddy_ready();
    f.app.enable_workbuddy().unwrap();

    f.app.restore().unwrap();
    assert_eq!(f.router(), Some(47328));
    f.app.restore_workbuddy().unwrap();
    assert_eq!(f.router(), None);
}

/// models.json 读不懂：不动它、说清楚；状态里写着原因
#[test]
fn an_unreadable_models_file_is_left_alone() {
    let f = fixture();
    f.workbuddy_ready();
    std::fs::write(f.models_json(), "{ not json").unwrap();
    assert_eq!(code(f.app.enable_workbuddy()), "invalid");
    assert_eq!(f.read_models_json(), "{ not json");
    assert!(!f.workbuddy_view().enabled);
    assert!(!f.workbuddy_view().conflict.is_empty());
}

/// 读完 models.json 到写回之间 WorkBuddy 自己又改了它（它会改这个文件）：报 `changed`、不覆盖它的改动
/// （同 Codex 设置），不当成 Sophia 自己的错
#[test]
fn a_models_file_changed_while_writing_is_left_alone_and_reported_as_changed() {
    let f = fixture();
    f.workbuddy_ready();
    let state = f.app.read_workbuddy_models().unwrap();
    std::fs::write(f.models_json(), "[]\n").unwrap();
    assert_eq!(
        code(f.app.put_workbuddy_models(&state, b"[{\"id\":\"x\"}]\n")),
        "changed"
    );
    assert_eq!(f.read_models_json(), "[]\n");
}

/// 评审 #19（#266）：令牌是几家共用的本机路由令牌，WorkBuddy 读不出它时不说「Claude 网关令牌」
#[test]
fn a_token_failure_on_workbuddy_does_not_talk_about_claude() {
    let f = fixture();
    f.workbuddy_ready();
    f.world.lock().unwrap().token_error = Some("secrets.json is broken".into());
    let error = f.app.enable_workbuddy().unwrap_err();
    assert!(
        error.message.contains("secrets.json is broken"),
        "{}",
        error.message
    );
    assert!(!error.message.contains("Claude"), "{}", error.message);
}

/// 评审 #19（#266）：用户的 models.json 自带可用模型名单、Sophia 加的不在里面：状态里说出来（行下提示），
/// 不替用户改名单
#[test]
fn the_view_tells_when_the_users_allow_list_hides_sophias_models() {
    let f = fixture();
    f.workbuddy_ready();
    std::fs::write(
        f.models_json(),
        "{\"models\": [], \"availableModels\": [\"my-glm\"]}\n",
    )
    .unwrap();
    f.app.enable_workbuddy().unwrap();
    let hidden = |f: &Fixture| f.workbuddy_view().workbuddy.unwrap().hidden_by_allow_list;
    assert!(hidden(&f));
    assert!(f
        .read_models_json()
        .contains("\"availableModels\": [\"my-glm\"]"));
    std::fs::write(f.models_json(), "[]\n").unwrap();
    assert!(!hidden(&f));
}

//! 家 claude 的编排测试（spec AC2、AC4、AC6–AC9、AC29、AC33–AC37、AC40、AC41、AC48、AC50、AC51 的 app 部分）。
//! 桌面应用的两个数据目录是临时目录（已 canonicalize）；进程、打开、退出、钥匙串都是假的。
use super::tests::{agents_manager_setup, code, fixture, Fixture};
use super::*;
use sophia_core::claude_models::desktop::{DesktopFile, SOPHIA_PROFILE_ID};
use sophia_core::claude_models::settings::{ClaudeGatewaySettings, Phase};
use sophia_core::codex_models::catalog::Model;
use sophia_core::model_providers::{ModelRef, Provider, ProviderModel};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const TOKEN: &str = "sophia-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACCOUNT_1P: &str = "{\n  \"mcpServers\": {\n    \"fs\": {\"command\": \"npx\"}\n  },\n  \"deploymentMode\": \"1p\"\n}\n";
const ACCOUNT_3P: &str = "{\"deploymentMode\":\"1p\"}";
const CC_ID: &str = "00000000-0000-4000-8000-000000157210";
const CC_PROFILE: &str = "{\n  \"inferenceProvider\": \"gateway\",\n  \"inferenceGatewayBaseUrl\": \"http://127.0.0.1:15721/claude-desktop\",\n  \"inferenceGatewayApiKey\": \"ccs-1\"\n}\n";
const CC_META: &str = "{\n  \"entries\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000157210\",\n      \"name\": \"Other Tool\"\n    }\n  ],\n  \"appliedId\": \"00000000-0000-4000-8000-000000157210\"\n}";

/// 全局名单里的一家 ap（名称 AP），三个模型
fn ap_provider() -> Provider {
    Provider {
        id: "ap".into(),
        name: "AP".into(),
        base_url: "https://ap.example".into(),
        api_base: Some("https://ap.example/v1".into()),
        models: ["kimi-k3", "glm-lite", "unused"]
            .into_iter()
            .map(|id| ProviderModel {
                model: Model {
                    id: id.into(),
                    display_name: (id == "kimi-k3").then(|| "Kimi K3".to_owned()),
                    ..Default::default()
                },
                enabled: None,
            })
            .collect(),
        ..Provider::default()
    }
}

/// 「ap 这一家的完整勾选」：启用这些、Claude 的已选里 ap 的换成它们（别家的不动），经 `App::set_picks` 跟上
fn set_claude_models(
    f: &Fixture,
    provider: &str,
    selected: Vec<Model>,
) -> Result<Vec<String>, AppError> {
    let refs = f.enable_models(provider, &selected);
    let mut picks: Vec<ModelRef> = f
        .world
        .lock()
        .unwrap()
        .models
        .picked("claude")
        .iter()
        .filter(|r| r.provider != provider)
        .cloned()
        .collect();
    picks.extend(refs);
    f.app.set_picks(Agent::Claude, picks)
}

/// Codex 那套 fixture，外加：全局名单里有一家 ap 与它的密钥，Claude 选了它的两个模型；桌面应用处于账号模式
fn claude_fixture() -> Fixture {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.models.providers.push(ap_provider());
        w.keys.insert("ap".into(), "sk-claude-ap-123456".into());
    }
    f.enable_models(
        "ap",
        &[model("kimi-k3", Some("Kimi K3")), model("glm-lite", None)],
    );
    f.world.lock().unwrap().models.picks.insert(
        "claude".into(),
        sophia_core::model_providers::picks::AgentPicks {
            picked: vec![
                ModelRef::new("ap", "kimi-k3"),
                ModelRef::new("ap", "glm-lite"),
            ],
            official_seen: Vec::new(),
        },
    );
    put(&f, DesktopFile::ClaudeConfig, ACCOUNT_1P);
    put(&f, DesktopFile::Claude3pConfig, ACCOUNT_3P);
    f
}

fn app_support(f: &Fixture) -> PathBuf {
    f.root.join("appsupport")
}

fn path(f: &Fixture, file: DesktopFile) -> PathBuf {
    sophia_core::claude_models::desktop::DesktopDirs::new(&app_support(f)).path(file)
}

fn put(f: &Fixture, file: DesktopFile, text: &str) {
    let path = path(f, file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn put_cc(f: &Fixture) {
    put(f, DesktopFile::Meta, CC_META);
    let profile = app_support(f)
        .join("Claude-3p/configLibrary")
        .join(format!("{CC_ID}.json"));
    std::fs::write(profile, CC_PROFILE).unwrap();
    put(f, DesktopFile::ClaudeConfig, "{\"deploymentMode\":\"3p\"}");
    put(
        f,
        DesktopFile::Claude3pConfig,
        "{\"deploymentMode\":\"3p\"}",
    );
}

fn cc_profile(f: &Fixture) -> String {
    std::fs::read_to_string(
        app_support(f)
            .join("Claude-3p/configLibrary")
            .join(format!("{CC_ID}.json")),
    )
    .unwrap()
}

fn text(f: &Fixture, file: DesktopFile) -> Option<String> {
    std::fs::read_to_string(path(f, file)).ok()
}

fn json_of(f: &Fixture, file: DesktopFile) -> serde_json::Value {
    serde_json::from_str(&text(f, file).expect("文件在")).unwrap()
}

/// 桌面应用两个数据目录下全部文件（相对路径 → 内容），用来断言「逐字节不变、没有备份」
fn tree(f: &Fixture) -> BTreeMap<String, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().display().to_string(),
                    std::fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    let root = app_support(f);
    walk(&root, &root, &mut out);
    out
}

/// 备份进 Sophia 的数据目录，不落在桌面应用的目录里：这里断言文件树里没有备份，原样返回
fn no_backups_beside(tree: BTreeMap<String, Vec<u8>>) -> BTreeMap<String, Vec<u8>> {
    assert!(
        !tree.keys().any(|name| name.ends_with(".bak")),
        "备份不该出现在原文件旁边：{:?}",
        tree.keys().collect::<Vec<_>>()
    );
    tree
}

fn claude_state(f: &Fixture) -> AgentGatewayView {
    f.app
        .state()
        .agents
        .into_iter()
        .find(|a| a.agent == Agent::Claude)
        .unwrap()
}

fn desktop_state(f: &Fixture) -> DesktopView {
    claude_state(f).claude.unwrap().desktop
}

fn claude_routing(f: &Fixture) -> Option<serde_json::Value> {
    std::fs::read(f.root.join("data/gateway/claude-routing.json"))
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
}

fn settings_of(f: &Fixture) -> ClaudeGatewaySettings {
    f.world.lock().unwrap().claude.clone()
}

fn set_hook(f: &Fixture, hook: impl Fn(DesktopFile) -> Result<(), String> + Send + 'static) {
    *f.app
        .step_hook
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Box::new(hook));
}

fn fail_at(f: &Fixture, target: DesktopFile) {
    set_hook(f, move |file| {
        if file == target {
            Err(format!("模拟 {} 写失败", file.label()))
        } else {
            Ok(())
        }
    });
}

fn clear_hook(f: &Fixture) {
    *f.app
        .step_hook
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// 本进程里的路由停下了（两家都关了，R8）
fn router_stopped(f: &Fixture) -> bool {
    f.router().is_none()
}

// ---------- 打开与令牌（R5、R29） ----------

/// AC4：第一次打开生成令牌、写进 profile（0600）；设置里没有令牌；切回再打开令牌不变
#[test]
fn ac4_token_is_generated_once_and_only_written_to_the_profile() {
    let f = claude_fixture();
    assert!(f.app.enable_claude().unwrap().is_empty());
    let token = f.world.lock().unwrap().token.clone().unwrap();
    assert_eq!(token, TOKEN);
    assert!(token.starts_with("sophia-") && token.len() == 50);
    let profile = json_of(&f, DesktopFile::Profile);
    assert_eq!(profile["inferenceGatewayApiKey"], TOKEN);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path(&f, DesktopFile::Profile))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let stored = serde_json::to_string(&settings_of(&f)).unwrap();
    assert!(!stored.contains(TOKEN), "令牌不进 settings.json：{stored}");
    let routing = std::fs::read_to_string(f.root.join("data/gateway/claude-routing.json")).unwrap();
    assert!(!routing.contains(TOKEN) && !routing.contains("sk-claude"));

    f.app.restore_claude().unwrap();
    f.world.lock().unwrap().next_token = "sophia-should-not-be-used".into();
    f.app.enable_claude().unwrap();
    assert_eq!(f.world.lock().unwrap().token.as_deref(), Some(TOKEN));
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceGatewayApiKey"],
        TOKEN
    );
}

/// AC30 / R37 / R29（2026-09-30）：profile 的键；已选两个按顺序写 `claude-sonnet-5`、`claude-haiku-4-5`，
/// `labelOverride` 是模型片上的名字；Claude 清单逐项对应到上游模型；两处 deploymentMode
#[test]
fn opening_writes_profile_meta_modes_and_the_claude_routing() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let profile = json_of(&f, DesktopFile::Profile);
    assert_eq!(
        profile,
        serde_json::json!({
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": "http://127.0.0.1:47328/claude",
            "inferenceGatewayApiKey": TOKEN,
            "inferenceGatewayAuthScheme": "bearer",
            "inferenceModels": [
                {"name": "claude-sonnet-5", "labelOverride": "Kimi K3"},
                {"name": "claude-haiku-4-5", "labelOverride": "glm-lite"}
            ],
            "chatTabEnabled": true
        })
    );
    assert_eq!(
        json_of(&f, DesktopFile::Meta)["appliedId"],
        SOPHIA_PROFILE_ID
    );
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "3p"
    );
    assert_eq!(
        json_of(&f, DesktopFile::Claude3pConfig)["deploymentMode"],
        "3p"
    );
    assert_eq!(
        claude_routing(&f).unwrap(),
        serde_json::json!({
            "agent": "claude",
            "providers": [{"id": "ap", "name": "AP", "base_url": "https://ap.example/v1", "protocol": "chat"}],
            "models": [
                {"slug": "claude-sonnet-5", "upstream_model": "kimi-k3", "provider": "ap", "label": "Kimi K3"},
                {"slug": "claude-haiku-4-5", "upstream_model": "glm-lite", "provider": "ap", "label": "glm-lite"}
            ],
            "retired": []
        })
    );
    let s = settings_of(&f);
    assert!(s.enabled);
    assert_eq!(s.applied.as_ref().unwrap().phase, Phase::Done);
    let desktop = desktop_state(&f);
    assert!(desktop.applied && !desktop.pending && !desktop.drift && !desktop.needs_restart);
}

/// AC34：账户模式下打开紧接着切回，四个文件与原文逐字节相同，Sophia 的 profile 被删
#[test]
fn ac34_open_then_restore_returns_every_byte() {
    let f = claude_fixture();
    let before = tree(&f);
    f.app.enable_claude().unwrap();
    assert_ne!(no_backups_beside(tree(&f)), before);
    let warnings = f.app.restore_claude().unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(no_backups_beside(tree(&f)), before);
    assert!(settings_of(&f).applied.is_none());
    assert!(!settings_of(&f).enabled);
    assert!(claude_routing(&f).is_none());
    assert!(router_stopped(&f), "Codex 也关着：停路由");
}

// ---------- 路由服务（R7–R9） ----------

/// AC6：Codex 开着时 Claude 打开 / 切回，路由不重起、不停
#[test]
fn ac6_claude_toggles_leave_the_service_alone_while_codex_is_on() {
    let f = claude_fixture();
    f.configure();
    f.app.enable().unwrap();
    f.app.enable_claude().unwrap();
    f.app.restore_claude().unwrap();
    assert_eq!(f.router_events(), ["start 47328"], "路由不随开关重起");
    assert!(!router_stopped(&f));
    assert!(f.codex_state().enabled);
}

/// AC7：两家都开，关 Codex：服务在、Codex 清单无生效模型且停用名单含原标识；再切回 Claude：全卸
#[test]
fn ac7_service_is_kept_while_either_family_is_on() {
    let f = claude_fixture();
    f.configure();
    f.app.enable().unwrap();
    f.app.enable_claude().unwrap();
    f.app.restore().unwrap();
    assert!(!router_stopped(&f), "Claude 还开着");
    let routing = f.routing();
    assert_eq!(routing["models"], serde_json::json!([]));
    assert_eq!(
        routing["retired"],
        serde_json::json!(["gw.example-weibo-glm-5"])
    );
    assert!(!f.codex().join("sophia-models.json").exists());
    assert!(claude_routing(&f).is_some(), "Claude 请求照常");

    f.app.restore_claude().unwrap();
    assert!(router_stopped(&f));
    assert!(claude_routing(&f).is_none());
    let leftovers: Vec<_> = std::fs::read_dir(f.codex())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(OWN_FILE_PREFIX))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// Claude 在运行时拨开（等重启生效，桌面应用里还没写）再关 Codex：路由服务留着，否则重启后 Claude 连不上
#[test]
fn closing_codex_keeps_the_service_for_a_pending_claude() {
    let f = claude_fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    assert!(!desktop_state(&f).applied, "还没写进桌面应用");
    f.app.restore().unwrap();
    assert!(!router_stopped(&f), "Claude 等重启生效，路由要留着");
}

/// 开着、等重启生效时桌面应用的配置文件坏了：切回照样关得掉（认领读不成就当没有可认领的）
#[test]
fn switching_off_works_even_when_the_desktop_config_is_unreadable() {
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    put(&f, DesktopFile::Meta, "{ not json");
    f.app.restore_claude().unwrap();
    assert!(!settings_of(&f).enabled);
}

/// AC8：Claude 开着时 Codex 接管 agents-manager 失败回滚，服务仍在
#[test]
fn ac8_codex_takeover_rollback_keeps_the_service_for_claude() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    agents_manager_setup(&f);
    // 路由已经因为 Claude 在跑；接管在写密钥时失败，要撤回本功能的痕迹
    f.world.lock().unwrap().key_write_fails_for = Some("wecode".into());
    assert_eq!(code(f.app.takeover()), "invalid");
    assert!(!router_stopped(&f));
    assert!(claude_routing(&f).is_some());
}

// ---------- 什么时候写（R28、R49） ----------

/// AC29：桌面应用在运行 → 不写，待生效；文件不合法 → 拒绝、一个字节不写、没有清单
#[test]
fn ac29_running_app_or_invalid_files_are_not_written() {
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    let before = tree(&f);
    f.app.enable_claude().unwrap();
    assert_eq!(tree(&f), before);
    assert!(claude_routing(&f).is_none());
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart && !desktop.applied);
    // 路由现在就装好（2026-10-01：开着却没路由，页面会报「路由没在跑」叠在 `重启生效` 旁）
    assert_eq!(f.router(), Some(47328), "拨开时就起路由");
    // 重启生效之前又拨关：桌面应用里什么都没写过，路由随之卸掉（Codex 也关着）
    f.app.restore_claude().unwrap();
    assert!(router_stopped(&f), "拨关时停掉刚起的路由");
    assert_eq!(tree(&f), before);

    let f = claude_fixture();
    put(&f, DesktopFile::Meta, "{\"entries\": {}}");
    let before = tree(&f);
    let error = f.app.enable_claude().unwrap_err();
    assert_eq!(error.code, "invalid");
    assert_eq!(tree(&f), before, "没有备份、没有改动");
    assert!(claude_routing(&f).is_none());
    assert!(!settings_of(&f).enabled);
    assert!(!claude_state(&f).conflict.is_empty());

    #[cfg(unix)]
    {
        let f = claude_fixture();
        let real = f.root.join("elsewhere.json");
        std::fs::write(&real, ACCOUNT_3P).unwrap();
        std::fs::remove_file(path(&f, DesktopFile::Claude3pConfig)).unwrap();
        std::os::unix::fs::symlink(&real, path(&f, DesktopFile::Claude3pConfig)).unwrap();
        let before = tree(&f);
        assert_eq!(code(f.app.enable_claude()), "invalid");
        assert_eq!(tree(&f), before);
        assert_eq!(std::fs::read_to_string(&real).unwrap(), ACCOUNT_3P);
    }
}

/// R41：没装、受管、版本太旧时打开被拒（desktop_unavailable），什么都不写
#[test]
fn unavailable_desktop_refuses_to_open() {
    for setup in 0..3 {
        let f = claude_fixture();
        match setup {
            0 => f.world.lock().unwrap().desktop_installed = false,
            1 => {
                std::fs::create_dir_all(f.root.join("managed")).unwrap();
                std::fs::write(f.root.join("managed/machine.plist"), "").unwrap();
            }
            _ => f.world.lock().unwrap().desktop_version = Some("1.9659.2".into()),
        }
        let before = tree(&f);
        assert_eq!(
            code(f.app.enable_claude()),
            "desktop_unavailable",
            "{setup}"
        );
        assert_eq!(tree(&f), before);
        assert!(!settings_of(&f).enabled);
    }
    let f = claude_fixture();
    f.world.lock().unwrap().models.picks.clear();
    assert_eq!(code(f.app.enable_claude()), "invalid");
}

// ---------- 写入顺序、撤回、前滚（R32） ----------

/// AC33：打开时在 ⑤⑥⑦ 各一步失败 → 同一动作里撤回：四个文件逐字节相同、applied 清空、enabled 关
#[test]
fn ac33_failed_open_is_undone_in_the_same_action() {
    for target in [
        DesktopFile::Meta,
        DesktopFile::Claude3pConfig,
        DesktopFile::ClaudeConfig,
    ] {
        let f = claude_fixture();
        let before = tree(&f);
        fail_at(&f, target);
        let error = f.app.enable_claude().unwrap_err();
        assert!(error.message.contains("模拟"), "{}", error.message);
        assert_eq!(no_backups_beside(tree(&f)), before, "{target:?}");
        let s = settings_of(&f);
        assert!(s.applied.is_none() && !s.enabled, "{target:?}");
        assert!(claude_routing(&f).is_none());
        assert!(router_stopped(&f));
    }
}

/// AC33：进程在 ⑤ 之后死掉 → 两处 deploymentMode 仍是原值、drift；重新写入补完，结果与一次成功的打开逐字节相同
#[test]
fn ac33_crash_after_meta_is_rolled_forward_by_rewrite() {
    let reference = claude_fixture();
    reference.app.enable_claude().unwrap();
    let expected = no_backups_beside(tree(&reference));

    let f = claude_fixture();
    set_hook(&f, |file| {
        if file == DesktopFile::Claude3pConfig {
            panic!("进程在写 Claude-3p 之前没了");
        }
        Ok(())
    });
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.app.enable_claude()));
    assert!(crashed.is_err());
    clear_hook(&f);
    let s = settings_of(&f);
    assert_eq!(s.applied.as_ref().unwrap().phase, Phase::Writing);
    let originals_before = s.applied.as_ref().unwrap().originals.clone();
    assert!(text(&f, DesktopFile::Profile).is_some());
    assert_eq!(
        text(&f, DesktopFile::ClaudeConfig).as_deref(),
        Some(ACCOUNT_1P)
    );
    assert_eq!(
        text(&f, DesktopFile::Claude3pConfig).as_deref(),
        Some(ACCOUNT_3P)
    );
    assert!(desktop_state(&f).drift);

    f.app.enable_claude().unwrap();
    assert_eq!(no_backups_beside(tree(&f)), expected);
    let s = settings_of(&f);
    assert_eq!(s.applied.as_ref().unwrap().phase, Phase::Done);
    assert_eq!(s.applied.as_ref().unwrap().originals, originals_before);
    assert!(!desktop_state(&f).drift);
}

/// AC33：崩溃之后有人改了 `_meta.json` → 前滚不覆盖，报 changed，phase 保持
#[test]
fn ac33_roll_forward_refuses_to_overwrite_outside_changes() {
    let f = claude_fixture();
    set_hook(&f, |file| {
        if file == DesktopFile::Claude3pConfig {
            panic!("crash");
        }
        Ok(())
    });
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.app.enable_claude()));
    clear_hook(&f);
    put(
        &f,
        DesktopFile::Meta,
        "{\"entries\":[],\"appliedId\":\"someone-else\"}",
    );
    assert_eq!(code(f.app.enable_claude()), "changed");
    assert_eq!(
        settings_of(&f).applied.as_ref().unwrap().phase,
        Phase::Writing
    );
    assert_eq!(
        text(&f, DesktopFile::Meta).unwrap(),
        "{\"entries\":[],\"appliedId\":\"someone-else\"}"
    );
}

/// AC33：切回时在 ②③ 失败 → 两处 deploymentMode 已是原值、restoreUnfinished；再试一次做完
#[test]
fn ac33_failed_restore_is_finished_by_trying_again() {
    for target in [DesktopFile::Meta, DesktopFile::Profile] {
        let f = claude_fixture();
        let before = tree(&f);
        f.app.enable_claude().unwrap();
        fail_at(&f, target);
        assert!(f.app.restore_claude().is_err());
        assert_eq!(
            text(&f, DesktopFile::ClaudeConfig).as_deref(),
            Some(ACCOUNT_1P)
        );
        assert_eq!(
            text(&f, DesktopFile::Claude3pConfig).as_deref(),
            Some(ACCOUNT_3P)
        );
        let s = settings_of(&f);
        assert!(!s.enabled);
        assert_eq!(s.applied.as_ref().unwrap().phase, Phase::Restoring);
        assert!(desktop_state(&f).restore_unfinished);
        assert!(!router_stopped(&f), "没做完之前路由留着");

        clear_hook(&f);
        f.app.restore_claude().unwrap();
        assert_eq!(no_backups_beside(tree(&f)), before, "{target:?}");
        assert!(settings_of(&f).applied.is_none());
        assert!(!desktop_state(&f).restore_unfinished);
    }
}

// ---------- 状态（R34） ----------

/// AC35：状态字段逐条
#[test]
fn ac35_state_fields() {
    // 没装 / 版本太旧 / 受管 / 在运行
    let f = claude_fixture();
    f.world.lock().unwrap().desktop_installed = false;
    assert!(!claude_state(&f).installed);
    let f = claude_fixture();
    f.world.lock().unwrap().desktop_version = Some("1.12603.0".into());
    let view = claude_state(&f);
    assert!(view.installed && view.claude.as_ref().unwrap().desktop.too_old);
    assert_eq!(
        view.claude.unwrap().desktop.version.as_deref(),
        Some("1.12603.0")
    );
    let f = claude_fixture();
    std::fs::create_dir_all(f.root.join("managed")).unwrap();
    std::fs::write(f.root.join("managed/user.plist"), "").unwrap();
    assert!(desktop_state(&f).managed);
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    assert!(desktop_state(&f).running);

    // 别家配置：条目有名字、没名字，都只报 id
    let f = claude_fixture();
    put_cc(&f);
    assert_eq!(desktop_state(&f).foreign.unwrap().id, CC_ID);
    put(
        &f,
        DesktopFile::Meta,
        &format!("{{\"entries\":[],\"appliedId\":\"{CC_ID}\"}}"),
    );
    assert_eq!(desktop_state(&f).foreign.unwrap().id, CC_ID);

    // drift：profile 令牌被改、appliedId 被改、一处 deploymentMode 变 1p、profile 被删
    type Mutation = Box<dyn Fn(&Fixture)>;
    let mutations: Vec<(&str, Mutation)> = vec![
        (
            "token",
            Box::new(|f| {
                let profile = text(f, DesktopFile::Profile)
                    .unwrap()
                    .replace(TOKEN, "sophia-changed");
                put(f, DesktopFile::Profile, &profile);
            }),
        ),
        (
            "appliedId",
            Box::new(|f| {
                let meta = text(f, DesktopFile::Meta)
                    .unwrap()
                    .replace(SOPHIA_PROFILE_ID, "someone");
                put(f, DesktopFile::Meta, &meta);
            }),
        ),
        (
            "mode",
            Box::new(|f| put(f, DesktopFile::ClaudeConfig, "{\"deploymentMode\":\"1p\"}")),
        ),
        (
            "profile gone",
            Box::new(|f| std::fs::remove_file(path(f, DesktopFile::Profile)).unwrap()),
        ),
    ];
    for (name, mutate) in mutations {
        let f = claude_fixture();
        f.app.enable_claude().unwrap();
        assert!(!desktop_state(&f).drift, "{name}");
        mutate(&f);
        assert!(desktop_state(&f).drift, "{name}");
    }

    // pending / needsRestart：在运行时拨开关、改已选
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = true;
    set_claude_models(&f, "ap", vec![model("glm-lite", None)]).unwrap();
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart);
    f.app.restore_claude().unwrap();
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart && desktop.applied);
    assert!(!claude_state(&f).enabled);

    // Sophia 的设置丢了、文件是我们的 → 视为写着 Sophia 的；切回按「原来没有」写 1p、删 appliedId
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().claude = ClaudeGatewaySettings::default();
    let desktop = desktop_state(&f);
    assert!(desktop.applied && desktop.pending);
    f.app.restore_claude().unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "1p"
    );
    assert_eq!(
        json_of(&f, DesktopFile::Claude3pConfig)["deploymentMode"],
        "1p"
    );
    assert!(json_of(&f, DesktopFile::Meta).get("appliedId").is_none());
    assert!(text(&f, DesktopFile::Profile).is_none());
}

/// 浮层的官方组：只在开着第三方模型时说「用不了，关掉开关就回来」；关着时官方模型就是 Claude 自己在用的，
/// 说它自己管、在这里改不了（spec #247：开着第三方时官方模型用不了，置灰）
#[test]
fn the_official_group_is_unavailable_only_while_third_party_is_on() {
    use sophia_core::model_providers::picks::Blocked;
    let f = claude_fixture();
    let official =
        |f: &Fixture| f.app.state().agent(Agent::Claude).unwrap().models.groups[0].blocked;
    assert_eq!(official(&f), Some(Blocked::ReadOnly));
    f.app.enable_claude().unwrap();
    assert_eq!(official(&f), Some(Blocked::OfficialUnavailable));
    f.app.restore_claude().unwrap();
    assert_eq!(official(&f), Some(Blocked::ReadOnly));
}

// ---------- 接管与重新写入（R35、R36） ----------

/// AC36：别家配置生效 → 打开被拒；接管 → Sophia 生效；切回 → 回到别家；它的 profile 全程不变
#[test]
fn ac36_takeover_and_give_back_a_foreign_config() {
    let f = claude_fixture();
    put_cc(&f);
    let before = tree(&f);
    let error = f.app.enable_claude().unwrap_err();
    assert_eq!(error.code, "foreign_config");
    assert!(error.message.contains("别的第三方配置"));
    assert!(!error.message.contains("Other Tool"));
    assert_eq!(tree(&f), before);
    assert!(!settings_of(&f).enabled);

    f.app.takeover_claude().unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Meta)["appliedId"],
        SOPHIA_PROFILE_ID
    );
    assert!(desktop_state(&f).foreign.is_none());
    assert!(settings_of(&f).takeover);
    assert_eq!(cc_profile(&f), CC_PROFILE);

    f.app.restore_claude().unwrap();
    assert_eq!(json_of(&f, DesktopFile::Meta)["appliedId"], CC_ID);
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "3p"
    );
    assert_eq!(
        json_of(&f, DesktopFile::Claude3pConfig)["deploymentMode"],
        "3p"
    );
    assert_eq!(no_backups_beside(tree(&f)), before);
    assert!(!settings_of(&f).takeover);

    // 接管之后别家那份被删了（工具卸载）：换不回去，两处 deploymentMode 回到 1p，回到 Claude 账号
    let f = claude_fixture();
    put_cc(&f);
    f.app.takeover_claude().unwrap();
    std::fs::remove_file(
        app_support(&f)
            .join("Claude-3p/configLibrary")
            .join(format!("{CC_ID}.json")),
    )
    .unwrap();
    f.app.restore_claude().unwrap();
    assert!(json_of(&f, DesktopFile::Meta).get("appliedId").is_none());
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "1p"
    );
    assert_eq!(
        json_of(&f, DesktopFile::Claude3pConfig)["deploymentMode"],
        "1p"
    );

    // 没选模型时拒绝接管
    let f = claude_fixture();
    put_cc(&f);
    f.world.lock().unwrap().models.picks.clear();
    let error = f.app.takeover_claude().unwrap_err();
    assert_eq!(error.message, "先选好模型再接管");
}

/// AC37：被改了令牌 → drift；重新写入补回、原值不变；在运行时重新写入走重启生效
#[test]
fn ac37_rewrite_repairs_drift() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let originals = settings_of(&f).applied.unwrap().originals;
    let profile = text(&f, DesktopFile::Profile)
        .unwrap()
        .replace(TOKEN, "sophia-changed");
    put(&f, DesktopFile::Profile, &profile);
    assert!(desktop_state(&f).drift);
    f.app.enable_claude().unwrap();
    assert!(!desktop_state(&f).drift);
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceGatewayApiKey"],
        TOKEN
    );
    assert_eq!(settings_of(&f).applied.unwrap().originals, originals);

    // 在运行：重新写入＝重启生效
    put(&f, DesktopFile::Profile, &profile);
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    assert!(desktop_state(&f).drift, "在运行时拨开关不写");
    f.app.restart_claude(|| ()).unwrap();
    assert!(!desktop_state(&f).drift);
}

// ---------- 开着时改选（R37、R49） ----------

/// AC48：在运行时改已选 → 不写、needsRestart；退出后打开 Claude → 一并更新再打开；不在运行时改 → 当场更新
#[test]
fn ac48_changes_while_running_wait_for_a_restart() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let profile = text(&f, DesktopFile::Profile).unwrap();
    let routing = claude_routing(&f).unwrap();
    f.world.lock().unwrap().running = true;
    set_claude_models(&f, "ap", vec![model("glm-lite", None)]).unwrap();
    assert_eq!(text(&f, DesktopFile::Profile).unwrap(), profile);
    assert_eq!(claude_routing(&f).unwrap(), routing);
    assert!(desktop_state(&f).needs_restart);

    f.world.lock().unwrap().running = false;
    let desktop = desktop_state(&f);
    assert!(desktop.pending && !desktop.needs_restart);
    f.world.lock().unwrap().events.clear();
    f.app.launch_claude(|| ()).unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"],
        serde_json::json!([{"name": "claude-sonnet-5", "labelOverride": "glm-lite"}])
    );
    assert_eq!(
        claude_routing(&f).unwrap()["models"],
        serde_json::json!([
            {"slug": "claude-sonnet-5", "upstream_model": "glm-lite", "provider": "ap", "label": "glm-lite"}
        ])
    );
    let events = f.world.lock().unwrap().events.clone();
    assert_eq!(
        events.last().map(String::as_str),
        Some("open"),
        "{events:?}"
    );
    assert!(events.iter().any(|e| e == "save:done"), "{events:?}");
    assert!(!desktop_state(&f).pending);

    f.world.lock().unwrap().running = false;
    set_claude_models(
        &f,
        "ap",
        vec![model("kimi-k3", Some("Kimi K3")), model("glm-lite", None)],
    )
    .unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"][1]["labelOverride"],
        "glm-lite"
    );
    assert!(!desktop_state(&f).pending);
}

fn model(id: &str, name: Option<&str>) -> Model {
    Model {
        id: id.into(),
        display_name: name.map(str::to_owned),
        ..Default::default()
    }
}

/// 排序（#265）：在「已选」里换了顺序，`inferenceModels` 按新顺序重写，第一个是切过去时先用的；
/// 恢复默认顺序＝按启用先后
#[test]
fn reordering_rewrites_inference_models_and_the_first_is_the_initial_default() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let labels = |f: &Fixture| -> Vec<String> {
        json_of(f, DesktopFile::Profile)["inferenceModels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["labelOverride"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(labels(&f), ["Kimi K3", "glm-lite"]);

    f.app
        .reorder_picks(
            Agent::Claude,
            vec![
                ModelRef::new("ap", "glm-lite"),
                ModelRef::new("ap", "kimi-k3"),
            ],
        )
        .unwrap();
    assert_eq!(labels(&f), ["glm-lite", "Kimi K3"]);
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"][0]["name"],
        "claude-sonnet-5",
        "第一个是初始默认"
    );

    f.app.restore_order(Agent::Claude).unwrap();
    assert_eq!(labels(&f), ["Kimi K3", "glm-lite"]);
}

/// R29（2026-09-30）：已选全部写进 `inferenceModels`，不设上限——第一个 `claude-sonnet-5`、中间 `-r2`、`-r3`……、
/// 最后一个 `claude-haiku-4-5`；按「已选」顺序（#259 起来自全局名单），撞名的 `labelOverride` 带提供商名；
/// Claude 清单逐项对应到各自提供商的上游模型。只剩一个时只写一项 `claude-sonnet-5`；
/// 开着时取消最后一个＝关掉这一家
#[test]
fn every_selected_model_is_written_in_order() {
    let f = claude_fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.models.providers.push(Provider {
            id: "or".into(),
            name: "openrouter".into(),
            base_url: "https://or.example".into(),
            api_base: Some("https://or.example/api/v1".into()),
            ..Provider::default()
        });
        w.keys.insert("or".into(), "sk-claude-or-123456".into());
    }
    f.enable_models(
        "ap",
        &[
            model("kimi-k3", None),
            model("glm-lite", None),
            model("unused", None),
        ],
    );
    f.enable_models("or", &[model("moonshot/kimi-k3", Some("Kimi K3"))]);
    f.world.lock().unwrap().models.picks.insert(
        "claude".into(),
        sophia_core::model_providers::picks::AgentPicks {
            picked: vec![
                ModelRef::new("ap", "kimi-k3"),
                ModelRef::new("ap", "glm-lite"),
                ModelRef::new("ap", "unused"),
                ModelRef::new("or", "moonshot/kimi-k3"),
            ],
            official_seen: Vec::new(),
        },
    );
    f.app.enable_claude().unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"],
        serde_json::json!([
            {"name": "claude-sonnet-5", "labelOverride": "Kimi K3 · AP"},
            {"name": "claude-sonnet-5-r2", "labelOverride": "glm-lite"},
            {"name": "claude-sonnet-5-r3", "labelOverride": "unused"},
            {"name": "claude-haiku-4-5", "labelOverride": "Kimi K3 · openrouter"}
        ])
    );
    let routing = claude_routing(&f).unwrap();
    assert_eq!(
        routing["models"],
        serde_json::json!([
            {"slug": "claude-sonnet-5", "upstream_model": "kimi-k3", "provider": "ap", "label": "Kimi K3 · AP"},
            {"slug": "claude-sonnet-5-r2", "upstream_model": "glm-lite", "provider": "ap", "label": "glm-lite"},
            {"slug": "claude-sonnet-5-r3", "upstream_model": "unused", "provider": "ap", "label": "unused"},
            {"slug": "claude-haiku-4-5", "upstream_model": "moonshot/kimi-k3", "provider": "or", "label": "Kimi K3 · openrouter"}
        ])
    );
    assert_eq!(
        routing["providers"],
        serde_json::json!([
            {"id": "ap", "name": "AP", "base_url": "https://ap.example/v1", "protocol": "chat"},
            {"id": "or", "name": "openrouter", "base_url": "https://or.example/api/v1", "protocol": "chat"}
        ])
    );
    // 状态里带上 profile 里实际写着的模型清单（命令行 status 用它核对）
    let view = claude_state(&f).claude.unwrap();
    let listed: Vec<(String, String)> = view
        .profile_models
        .iter()
        .map(|m| (m.id.clone(), m.label_override.clone()))
        .collect();
    assert_eq!(
        listed,
        [
            ("claude-sonnet-5".to_owned(), "Kimi K3 · AP".to_owned()),
            ("claude-sonnet-5-r2".to_owned(), "glm-lite".to_owned()),
            ("claude-sonnet-5-r3".to_owned(), "unused".to_owned()),
            (
                "claude-haiku-4-5".to_owned(),
                "Kimi K3 · openrouter".to_owned()
            )
        ]
    );

    // 在提供商页删掉 openrouter 那家：不在运行时当场重写，最后一个换成 ap 的最后一个
    f.world.lock().unwrap().models.remove("or").unwrap();
    assert!(f.app.models_changed().is_empty());
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"],
        serde_json::json!([
            {"name": "claude-sonnet-5", "labelOverride": "Kimi K3"},
            {"name": "claude-sonnet-5-r2", "labelOverride": "glm-lite"},
            {"name": "claude-haiku-4-5", "labelOverride": "unused"}
        ])
    );

    set_claude_models(&f, "ap", vec![model("kimi-k3", Some("Kimi K3"))]).unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"],
        serde_json::json!([{"name": "claude-sonnet-5", "labelOverride": "Kimi K3"}]),
        "只有一个时只写一项"
    );
    // 取消最后一个：关掉这一家（不在运行时当场切回）
    f.app
        .pick(Agent::Claude, &ModelRef::new("ap", "kimi-k3"), false)
        .unwrap();
    assert!(!settings_of(&f).enabled);
    assert!(settings_of(&f).applied.is_none());
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "1p"
    );
}

/// 在提供商页改了地址：已写进 Claude 清单的上游立刻换成新地址（路由每个请求重读），角色不动
#[test]
fn changing_a_gateway_address_updates_the_claude_routing_at_once() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = true;
    f.world
        .lock()
        .unwrap()
        .models
        .edit("ap", None, "https://ap2.example")
        .unwrap();
    f.app.models_changed();
    let routing = claude_routing(&f).unwrap();
    assert_eq!(routing["providers"][0]["base_url"], "https://ap2.example");
    assert_eq!(routing["models"][0]["slug"], "claude-sonnet-5");
}

// ---------- 打开 Claude 与重启生效（R49、R50） ----------

/// 记下取锁 / 放锁的时刻
struct Held(Arc<Mutex<World>>);
impl Drop for Held {
    fn drop(&mut self) {
        self.0.lock().unwrap().events.push("unlock".into());
    }
}
fn lock_of(f: &Fixture) -> impl FnOnce() -> Held {
    let world = f.world.clone();
    move || {
        world.lock().unwrap().events.push("lock".into());
        Held(world)
    }
}

use super::tests::World;

/// AC50：不在运行、有待生效 → 先写后打开；打开失败报原话；写失败不打开
#[test]
fn ac50_launch_writes_before_opening() {
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = false;
    f.world.lock().unwrap().events.clear();
    f.app.launch_claude(lock_of(&f)).unwrap();
    let events = f.world.lock().unwrap().events.clone();
    assert_eq!(
        events,
        ["lock", "save:writing", "save:done", "unlock", "open"],
        "{events:?}"
    );
    assert!(settings_of(&f).applied.is_some());

    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().open_error = Some("LSOpenURLsWithRole() failed".into());
    let error = f.app.launch_claude(|| ()).unwrap_err();
    assert!(
        error.message.contains("LSOpenURLsWithRole() failed"),
        "{}",
        error.message
    );

    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = false;
    fail_at(&f, DesktopFile::Profile);
    f.world.lock().unwrap().events.clear();
    assert!(f.app.launch_claude(|| ()).is_err());
    assert!(!f.world.lock().unwrap().events.contains(&"open".to_owned()));
}

/// AC51：在运行、有待生效 → 退出 → 写 → 打开，等待时不持锁；退不掉 → desktop_busy、不写不开；写失败 → 仍打开
#[test]
fn ac51_restart_quits_writes_then_opens() {
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().events.clear();
    f.app.restart_claude(lock_of(&f)).unwrap();
    let events = f.world.lock().unwrap().events.clone();
    assert_eq!(
        events,
        [
            "quit",
            "lock",
            "save:writing",
            "save:done",
            "unlock",
            "open"
        ],
        "{events:?}"
    );
    assert!(f.world.lock().unwrap().running);
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "3p"
    );

    // 切回方向同样
    f.app.restore_claude().unwrap();
    f.world.lock().unwrap().events.clear();
    f.app.restart_claude(lock_of(&f)).unwrap();
    let events = f.world.lock().unwrap().events.clone();
    assert_eq!(events.first().map(String::as_str), Some("quit"));
    assert_eq!(events.last().map(String::as_str), Some("open"));
    assert_eq!(
        json_of(&f, DesktopFile::ClaudeConfig)["deploymentMode"],
        "1p"
    );

    // 15 秒不退
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().quit_error = Some(std::io::ErrorKind::TimedOut);
    let before = tree(&f);
    f.world.lock().unwrap().events.clear();
    let error = f.app.restart_claude(lock_of(&f)).unwrap_err();
    assert_eq!(error.code, "desktop_busy");
    assert_eq!(error.message, crate::claude_desktop::busy_message());
    assert_eq!(tree(&f), before);
    assert_eq!(f.world.lock().unwrap().events, ["quit"]);

    // 写失败：仍打开，报「没写成」
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    fail_at(&f, DesktopFile::Meta);
    let before = tree(&f);
    let error = f.app.restart_claude(|| ()).unwrap_err();
    assert!(
        error
            .message
            .starts_with("配置没写成，Claude 按原来的样子打开了"),
        "{}",
        error.message
    );
    assert!(f.world.lock().unwrap().running, "仍然打开了");
    assert_eq!(no_backups_beside(tree(&f)), before, "新打开没写成：撤回");

    // 不在运行 → 等同打开 Claude
    let f = claude_fixture();
    f.world.lock().unwrap().running = true;
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = false;
    f.world.lock().unwrap().events.clear();
    f.app.restart_claude(|| ()).unwrap();
    let events = f.world.lock().unwrap().events.clone();
    assert!(!events.contains(&"quit".to_owned()));
    assert_eq!(events.last().map(String::as_str), Some("open"));
}

// ---------- 按家的网关与同步（R2、R4、R40） ----------

/// R3：各家的状态各自独立（#266 起 WorkBuddy 排第三）
#[test]
fn state_has_both_families_in_order() {
    let f = claude_fixture();
    f.configure();
    let state = f.app.state();
    let agents: Vec<Agent> = state.agents.iter().map(|a| a.agent).collect();
    assert_eq!(agents, [Agent::Codex, Agent::Claude, Agent::WorkBuddy]);
    let codex = &state.agents[0];
    assert_eq!(codex.models.picked.len(), 2, "官方 1 + 第三方 1");
    assert!(codex.codex.is_some() && codex.claude.is_none());
    let claude = &state.agents[1];
    let picked: Vec<&str> = claude
        .models
        .picked
        .iter()
        .map(|m| m.model_ref.model.as_str())
        .collect();
    assert_eq!(picked, ["kimi-k3", "glm-lite"]);
    let view = claude.claude.as_ref().unwrap();
    assert!(view.profile_models.is_empty(), "还没打开，profile 不存在");
    let json = serde_json::to_value(&state).unwrap();
    // 2026-09-30 起 Sophia 不设默认模型：Claude 那一份只有 desktop 与 profileModels
    let mut claude_keys: Vec<&str> = json["agents"][1]["claude"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    claude_keys.sort_unstable();
    assert_eq!(claude_keys, ["desktop", "profileModels"]);
    assert_eq!(json["agents"][1]["agent"], "claude");
    assert!(json["agents"][1]["claude"]["desktop"]["needsRestart"].is_boolean());
    assert!(json["agents"][0].get("claude").is_none());
    // R39：顶层只剩 supported、router、portNotice（2026-10-03 网关并入进程）、agents，不留 Codex 的旧字段
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["agents", "portNotice", "router", "supported"]);
    assert!(json["router"].get("protocol").is_none());
}

#[test]
fn version_threshold() {
    assert!(claude::version_too_old("1.9659.2"));
    assert!(claude::version_too_old("1.12603.0"));
    assert!(!claude::version_too_old("1.12603.1"));
    assert!(!claude::version_too_old("2.9939.4"));
    assert!(!claude::version_too_old("garbage"));
}

/// R8：Codex 的设置还（哪怕只剩一半）指向路由时，关掉 Claude 不卸服务
#[test]
fn restoring_claude_keeps_the_service_while_codex_still_points_at_it() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.write_config("openai_base_url = \"http://127.0.0.1:47328/v1\"\n");
    f.app.restore_claude().unwrap();
    assert!(!router_stopped(&f));
    assert!(claude_routing(&f).is_none());
}

/// R4：Claude 选了的那一家的密钥读不出（密钥文件损坏）时，打开报「不可用：原因」，不说「还没有密钥」，什么都不写
#[test]
fn enabling_claude_with_an_unreadable_key_names_the_reason() {
    let f = claude_fixture();
    let reason = sophia_core::t!("models.secrets.corrupt");
    f.world
        .lock()
        .unwrap()
        .key_errors
        .insert("ap".into(), reason.clone());
    let error = f.app.enable_claude().unwrap_err();
    assert_eq!(error.code, "invalid");
    assert!(error.message.contains(&reason), "{}", error.message);
    assert!(f.world.lock().unwrap().claude.applied.is_none());
}

// ---------- 网关并入 Sophia 进程（spec 2026-10-03-gateway-in-app） ----------

/// 模拟 Sophia 退出后再打开：路由不在了，记录清空
fn relaunch(f: &Fixture) {
    let mut w = f.world.lock().unwrap();
    w.router = None;
    w.router_events.clear();
    w.events.clear();
}

/// AC9：Claude 在第三方模式且在运行，确认退出：退出 → 切回官方 → 重新打开；「开着」不变，路由停下
#[test]
fn ac9_detach_switches_a_running_claude_back_and_keeps_the_choice() {
    let f = claude_fixture();
    let before = tree(&f);
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = true;
    f.world.lock().unwrap().events.clear();
    assert!(f.app.quit_preview().claude);
    let steps = Mutex::new(Vec::new());
    let failures = f
        .app
        .detach_for_quit(|| (), |step| steps.lock().unwrap().push(step));
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(steps.into_inner().unwrap(), [QuitStep::RestartingClaude]);
    assert_eq!(no_backups_beside(tree(&f)), before);
    let events = f.world.lock().unwrap().events.clone();
    assert_eq!(events.first().map(String::as_str), Some("quit"));
    assert_eq!(events.last().map(String::as_str), Some("open"));
    let s = settings_of(&f);
    assert!(s.enabled, "开着是用户的选择，退出不改");
    assert!(s.applied.is_none());
    assert!(router_stopped(&f));
}

/// 升级后第一次打开（#259）：Claude 开着、桌面应用还写着 Sophia 的，全局名单里却一个都没选——
/// 悄悄切回官方、记成没开着（桌面应用不在运行时当场写回），不报错
#[test]
fn attach_switches_claude_back_quietly_when_nothing_is_picked() {
    let f = claude_fixture();
    let before = tree(&f);
    f.app.enable_claude().unwrap();
    relaunch(&f);
    f.world.lock().unwrap().models = Default::default();
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let s = settings_of(&f);
    assert!(!s.enabled && s.applied.is_none());
    assert_eq!(no_backups_beside(tree(&f)), before);
    assert_eq!(f.router(), None);
}

/// Claude 没在运行：直接切回，不替用户打开它
#[test]
fn detach_writes_a_closed_claude_without_opening_it() {
    let f = claude_fixture();
    let before = tree(&f);
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().events.clear();
    assert!(f.app.detach_for_quit(|| (), |_| {}).is_empty());
    assert_eq!(no_backups_beside(tree(&f)), before);
    assert!(!f.world.lock().unwrap().events.contains(&"open".to_owned()));
    assert!(settings_of(&f).enabled);
}

/// AC10：Claude 15 秒内没退出：报 desktop_busy、Claude 留在第三方模式；Codex 照样改回并重启
#[test]
fn ac10_claude_that_will_not_quit_is_reported_and_codex_still_detaches() {
    let f = claude_fixture();
    f.configure();
    f.app.enable().unwrap();
    f.app.enable_claude().unwrap();
    {
        let mut w = f.world.lock().unwrap();
        w.running = true;
        w.quit_error = Some(std::io::ErrorKind::TimedOut);
        w.codex_app_running = true;
    }
    let failures = f.app.detach_for_quit(|| (), |_| {});
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].agent, Agent::Claude);
    assert_eq!(failures[0].code, "desktop_busy");
    assert_eq!(f.read_config(), super::tests::ORIGINAL);
    assert_eq!(f.world.lock().unwrap().codex_events, ["quit", "open"]);
    assert!(settings_of(&f).applied.is_some(), "Claude 还在第三方模式");
    assert!(router_stopped(&f));
}

/// AC11（Claude）：退出时切回了；再打开 Sophia、Claude 没在运行：当场写回第三方模式
#[test]
fn attach_rewrites_claude_after_quitting() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let profile = json_of(&f, DesktopFile::Profile);
    f.app.detach_for_quit(|| (), |_| {});
    relaunch(&f);
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(f.router(), Some(47328));
    assert_eq!(json_of(&f, DesktopFile::Profile), profile);
    assert_eq!(settings_of(&f).applied.unwrap().phase, Phase::Done);

    // Claude 在运行：写不了，记为待生效（重启生效）
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.app.detach_for_quit(|| (), |_| {});
    relaunch(&f);
    f.world.lock().unwrap().running = true;
    f.app.attach();
    assert_eq!(f.router(), Some(47328), "路由先起来");
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart && !desktop.applied);
}

/// AC15（Claude）：被强制结束时 Claude 在第三方模式：再打开只起路由，桌面应用的文件不动
#[test]
fn attach_after_a_crash_leaves_claude_files_alone() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let files = tree(&f);
    relaunch(&f);
    f.app.attach();
    assert_eq!(f.router(), Some(47328));
    assert_eq!(tree(&f), files);
}

/// R13：换了端口：Claude 没在运行就按新端口重写；在运行就待生效
#[test]
fn a_port_move_rewrites_claude_for_the_new_port() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    relaunch(&f);
    f.world
        .lock()
        .unwrap()
        .occupied
        .insert(47328, Occupant::Other);
    f.app.attach();
    assert_eq!(f.router(), Some(47329));
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceGatewayBaseUrl"],
        "http://127.0.0.1:47329/claude"
    );

    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    relaunch(&f);
    {
        let mut w = f.world.lock().unwrap();
        w.occupied.insert(47328, Occupant::Other);
        w.running = true;
    }
    f.app.attach();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceGatewayBaseUrl"],
        "http://127.0.0.1:47328/claude",
        "在运行时不写"
    );
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart);
}

/// R10：关机时不动 Claude
#[test]
fn exit_sync_leaves_claude_alone() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    let files = tree(&f);
    f.app.exit_sync();
    assert_eq!(tree(&f), files);
    assert!(settings_of(&f).applied.is_some());
}

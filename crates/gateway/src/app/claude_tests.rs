//! 家 claude 的编排测试（spec AC2、AC4、AC6–AC9、AC29、AC33–AC37、AC40、AC41、AC48、AC50、AC51 的 app 部分）。
//! 桌面应用的两个数据目录是临时目录（已 canonicalize）；进程、打开、退出、钥匙串都是假的。
use super::tests::{agents_manager_setup, code, fixture, key_slot, Fixture};
use super::*;
use sophia_core::claude_models::desktop::{DesktopFile, SOPHIA_PROFILE_ID};
use sophia_core::claude_models::settings::{ClaudeGatewaySettings, Phase};
use sophia_core::codex_models::catalog::Model;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

const TOKEN: &str = "sophia-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACCOUNT_1P: &str = "{\n  \"mcpServers\": {\n    \"fs\": {\"command\": \"npx\"}\n  },\n  \"deploymentMode\": \"1p\"\n}\n";
const ACCOUNT_3P: &str = "{\"deploymentMode\":\"1p\"}";
const CC_ID: &str = "00000000-0000-4000-8000-000000157210";
const CC_PROFILE: &str = "{\n  \"inferenceProvider\": \"gateway\",\n  \"inferenceGatewayBaseUrl\": \"http://127.0.0.1:15721/claude-desktop\",\n  \"inferenceGatewayApiKey\": \"ccs-1\"\n}\n";
const CC_META: &str = "{\n  \"entries\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000157210\",\n      \"name\": \"Other Tool\"\n    }\n  ],\n  \"appliedId\": \"00000000-0000-4000-8000-000000157210\"\n}";

fn saved(id: &str, name: Option<&str>, selected: bool) -> SavedModel {
    SavedModel {
        model: Model {
            id: id.into(),
            display_name: name.map(str::to_owned),
            ..Default::default()
        },
        selected,
    }
}

fn ap_provider() -> ProviderSettings {
    ProviderSettings {
        id: "ap".into(),
        name: "AP".into(),
        base_url: "https://ap.example".into(),
        api_base: Some("https://ap.example/v1".into()),
        models: vec![
            saved("kimi-k3", Some("Kimi K3"), true),
            saved("glm-lite", None, true),
            saved("unused", None, false),
        ],
        ..ProviderSettings::default()
    }
}

/// Codex 那套 fixture，外加：Claude 有一家网关 ap（已选两个模型）与它的密钥；桌面应用处于账号模式
fn claude_fixture() -> Fixture {
    let f = fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.claude = ClaudeGatewaySettings {
            providers: vec![ap_provider()],
            ..ClaudeGatewaySettings::default()
        };
        w.keys
            .insert(key_slot(Agent::Claude, "ap"), "sk-claude-ap-123456".into());
    }
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

fn without_backups(tree: BTreeMap<String, Vec<u8>>) -> BTreeMap<String, Vec<u8>> {
    tree.into_iter()
        .filter(|(name, _)| !name.contains(".sophia-models"))
        .collect()
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

fn our_service_uninstalled(f: &Fixture) -> bool {
    f.world
        .lock()
        .unwrap()
        .service_calls
        .contains(&format!("uninstall {SERVICE_LABEL}"))
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
    assert!(f.args().contains(&format!(
        "--claude-routing {}",
        f.root.join("data/gateway/claude-routing.json").display()
    )));
    let desktop = desktop_state(&f);
    assert!(desktop.applied && !desktop.pending && !desktop.drift && !desktop.needs_restart);
}

/// AC34：账户模式下打开紧接着切回，四个文件与原文逐字节相同，Sophia 的 profile 被删
#[test]
fn ac34_open_then_restore_returns_every_byte() {
    let f = claude_fixture();
    let before = tree(&f);
    f.app.enable_claude().unwrap();
    assert_ne!(without_backups(tree(&f)), before);
    let warnings = f.app.restore_claude().unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(without_backups(tree(&f)), before);
    assert!(settings_of(&f).applied.is_none());
    assert!(!settings_of(&f).enabled);
    assert!(claude_routing(&f).is_none());
    assert!(our_service_uninstalled(&f), "Codex 也关着：卸服务");
}

// ---------- 路由服务（R7–R9） ----------

/// AC6：Codex 开着时 Claude 打开 / 切回，plist 参数不变、服务不被卸
#[test]
fn ac6_claude_toggles_leave_the_service_alone_while_codex_is_on() {
    let f = claude_fixture();
    f.configure();
    f.app.enable().unwrap();
    let args = f.args();
    f.app.enable_claude().unwrap();
    f.app.restore_claude().unwrap();
    assert_eq!(f.args(), args, "plist 参数不随开关变");
    assert!(!our_service_uninstalled(&f));
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
    assert!(!our_service_uninstalled(&f), "Claude 还开着");
    let routing = f.routing();
    assert_eq!(routing["models"], serde_json::json!([]));
    assert_eq!(
        routing["retired"],
        serde_json::json!(["gw.example-weibo-glm-5"])
    );
    assert!(!f.codex().join("sophia-models.json").exists());
    assert!(claude_routing(&f).is_some(), "Claude 请求照常");

    f.app.restore_claude().unwrap();
    assert!(our_service_uninstalled(&f));
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
    assert!(
        !our_service_uninstalled(&f),
        "Claude 等重启生效，路由要留着"
    );
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
    f.world.lock().unwrap().healthy = false;
    assert_eq!(code(f.app.takeover()), "router_down");
    assert!(!our_service_uninstalled(&f));
    assert!(claude_routing(&f).is_some());
}

/// AC9：旧版路由在跑、重启后仍不认家 claude → router_down，四个文件逐字节未变、没有 Claude 清单
#[test]
fn ac9_old_router_blocks_writing_the_desktop_config() {
    let f = claude_fixture();
    let before = tree(&f);
    {
        let mut w = f.world.lock().unwrap();
        w.features = vec![];
        w.features_after_restart = Some(vec![]);
    }
    let error = f.app.enable_claude().unwrap_err();
    assert_eq!(error.code, "router_down");
    assert!(error.message.contains("路由版本过旧"), "{}", error.message);
    assert_eq!(tree(&f), before);
    assert!(claude_routing(&f).is_none());
    assert!(!settings_of(&f).enabled, "开关滑回");
    assert!(settings_of(&f).applied.is_none());
    assert!(f
        .world
        .lock()
        .unwrap()
        .service_calls
        .contains(&"restart".to_owned()));

    // 重启后换上了新版本：照常写
    f.world.lock().unwrap().features_after_restart = Some(vec!["claude".into()]);
    f.app.enable_claude().unwrap();
    assert!(settings_of(&f).applied.is_some());
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
    assert!(
        f.world.lock().unwrap().installed.is_some(),
        "拨开时就装路由"
    );
    // 重启生效之前又拨关：桌面应用里什么都没写过，路由随之卸掉（Codex 也关着）
    f.app.restore_claude().unwrap();
    assert!(
        f.world.lock().unwrap().installed.is_none(),
        "拨关时卸掉刚装的路由"
    );
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
    f.world.lock().unwrap().claude.providers[0]
        .models
        .iter_mut()
        .for_each(|m| m.selected = false);
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
        assert_eq!(without_backups(tree(&f)), before, "{target:?}");
        let s = settings_of(&f);
        assert!(s.applied.is_none() && !s.enabled, "{target:?}");
        assert!(claude_routing(&f).is_none());
        assert!(our_service_uninstalled(&f));
    }
}

/// AC33：进程在 ⑤ 之后死掉 → 两处 deploymentMode 仍是原值、drift；重新写入补完，结果与一次成功的打开逐字节相同
#[test]
fn ac33_crash_after_meta_is_rolled_forward_by_rewrite() {
    let reference = claude_fixture();
    reference.app.enable_claude().unwrap();
    let expected = without_backups(tree(&reference));

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
    assert_eq!(without_backups(tree(&f)), expected);
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
        assert!(!our_service_uninstalled(&f), "没做完之前路由留着");

        clear_hook(&f);
        f.app.restore_claude().unwrap();
        assert_eq!(without_backups(tree(&f)), before, "{target:?}");
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
    f.app
        .set_models_in(Agent::Claude, "ap", vec![model("glm-lite", None)])
        .unwrap();
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart);
    f.app.restore_claude().unwrap();
    let desktop = desktop_state(&f);
    assert!(desktop.pending && desktop.needs_restart && desktop.applied);
    assert!(!claude_state(&f).enabled);

    // Sophia 的设置丢了、文件是我们的 → 视为写着 Sophia 的；切回按「原来没有」写 1p、删 appliedId
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().claude = ClaudeGatewaySettings {
        providers: vec![ap_provider()],
        ..ClaudeGatewaySettings::default()
    };
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
    assert_eq!(without_backups(tree(&f)), before);
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
    f.world.lock().unwrap().claude.providers[0]
        .models
        .iter_mut()
        .for_each(|m| m.selected = false);
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
    f.app
        .set_models_in(Agent::Claude, "ap", vec![model("glm-lite", None)])
        .unwrap();
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
    f.app
        .set_models_in(
            Agent::Claude,
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

/// R29（2026-09-30）：已选全部写进 `inferenceModels`，不设上限——第一个 `claude-sonnet-5`、中间 `-r2`、`-r3`……、
/// 最后一个 `claude-haiku-4-5`；跨网关按已选顺序（网关顺序、再按各自列表顺序），撞名的 `labelOverride` 带网关短名；
/// Claude 清单逐项对应到各自网关的上游模型。只剩一个时只写一项 `claude-sonnet-5`；开着时已选不能变空
#[test]
fn every_selected_model_is_written_in_order() {
    let f = claude_fixture();
    {
        let mut w = f.world.lock().unwrap();
        w.claude.providers[0].models[2].selected = true;
        w.claude.providers.push(ProviderSettings {
            id: "or".into(),
            name: "openrouter".into(),
            base_url: "https://or.example".into(),
            api_base: Some("https://or.example/api/v1".into()),
            models: vec![saved("moonshot/kimi-k3", Some("Kimi K3"), true)],
            ..ProviderSettings::default()
        });
        w.keys
            .insert(key_slot(Agent::Claude, "or"), "sk-claude-or-123456".into());
    }
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

    // 删掉 openrouter 那家：不在运行时当场重写，最后一个换成 ap 的最后一个
    f.app
        .remove_provider_in(Agent::Claude, "or", false)
        .unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"],
        serde_json::json!([
            {"name": "claude-sonnet-5", "labelOverride": "Kimi K3"},
            {"name": "claude-sonnet-5-r2", "labelOverride": "glm-lite"},
            {"name": "claude-haiku-4-5", "labelOverride": "unused"}
        ])
    );

    f.app
        .set_models_in(Agent::Claude, "ap", vec![model("kimi-k3", Some("Kimi K3"))])
        .unwrap();
    assert_eq!(
        json_of(&f, DesktopFile::Profile)["inferenceModels"],
        serde_json::json!([{"name": "claude-sonnet-5", "labelOverride": "Kimi K3"}]),
        "只有一个时只写一项，Haiku 档由路由回落到它"
    );
    assert_eq!(
        code(f.app.set_models_in(Agent::Claude, "ap", vec![])),
        "invalid"
    );
}

/// 改了网关地址：已写进 Claude 清单的上游立刻换成新地址（路由每个请求重读），角色不动
#[test]
fn changing_a_gateway_address_updates_the_claude_routing_at_once() {
    let f = claude_fixture();
    f.app.enable_claude().unwrap();
    f.world.lock().unwrap().running = true;
    f.app
        .upsert_provider_in(
            Agent::Claude,
            Some("ap"),
            None,
            "https://ap2.example",
            false,
        )
        .unwrap();
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
    assert_eq!(without_backups(tree(&f)), before, "新打开没写成：撤回");

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

/// AC2（app 部分）：两家各有 id 为 wecode 的网关，密钥各在各的账户；删 Codex 的只删 Codex 的密钥
#[test]
fn ac2_same_id_in_both_families_uses_separate_accounts() {
    let f = claude_fixture();
    let codex = f
        .app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("wecode"),
            "https://codex.example",
            "sk-codex-wecode-1",
            vec!["m".into()],
            "",
            false,
        )
        .unwrap();
    let claude = f
        .app
        .commit_verified_provider_in(
            Agent::Claude,
            None,
            Some("wecode"),
            "https://claude.example",
            "sk-claude-wecode-1",
            vec!["m".into()],
            "",
            false,
        )
        .unwrap();
    assert_eq!(codex.provider_id, "wecode");
    assert_eq!(claude.provider_id, "wecode");
    {
        let w = f.world.lock().unwrap();
        assert_eq!(
            w.keys.get("wecode").map(String::as_str),
            Some("sk-codex-wecode-1")
        );
        assert_eq!(
            w.keys.get("claude:wecode").map(String::as_str),
            Some("sk-claude-wecode-1")
        );
    }
    f.app
        .remove_provider_in(Agent::Codex, "wecode", false)
        .unwrap();
    let w = f.world.lock().unwrap();
    assert_eq!(w.deleted_keys, ["wecode"]);
    assert!(w.keys.contains_key("claude:wecode"));
    assert!(w.claude.providers.iter().any(|p| p.id == "wecode"));
}

/// AC40：Claude 页新增同地址网关（sync）只出现一份；同步删除带走 Codex 那一份与密钥，Codex 已选变空且开着则随之关掉
#[test]
fn ac40_sync_add_and_remove_across_families() {
    let f = fixture();
    f.configure(); // Codex：gw.example，已选 1 个
    f.app.enable().unwrap();
    let saved = f
        .app
        .commit_verified_provider_in(
            Agent::Claude,
            None,
            Some("GW"),
            "https://GW.example/openai/",
            "sk-claude-gw-123456",
            vec!["weibo/glm-5".into()],
            "",
            true,
        )
        .unwrap();
    assert_eq!(saved.other_provider_id.as_deref(), Some("gw.example"));
    assert_eq!(
        f.world.lock().unwrap().settings.providers.len(),
        1,
        "同一地址不加第二份"
    );
    assert_eq!(f.world.lock().unwrap().claude.providers.len(), 1);

    // 不勾「同时删掉」：Codex 不受影响
    let g = fixture();
    g.configure();
    g.app
        .commit_verified_provider_in(
            Agent::Claude,
            None,
            None,
            "https://gw.example/openai",
            "sk-claude-gw-123456",
            vec![],
            "",
            false,
        )
        .unwrap();
    let id = g.world.lock().unwrap().claude.providers[0].id.clone();
    g.app.remove_provider_in(Agent::Claude, &id, false).unwrap();
    assert_eq!(g.world.lock().unwrap().settings.providers.len(), 1);

    // 勾上：Codex 的 gw.example 连同密钥被删；它是 Codex 唯一在发布的网关且 Codex 开着 → Codex 先关掉
    f.app
        .remove_provider_in(Agent::Claude, &saved.provider_id, true)
        .unwrap();
    let w = f.world.lock().unwrap();
    assert!(w.settings.providers.is_empty());
    assert!(w.deleted_keys.contains(&"gw.example".to_owned()));
    assert!(w
        .deleted_keys
        .contains(&key_slot(Agent::Claude, &saved.provider_id)));
    drop(w);
    assert!(!f.codex_state().enabled, "Codex 随之关掉");
    assert_eq!(
        f.read_config(),
        "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"high\"\n\n[mcp_servers]\n\n[mcp_servers.node_repl]\ncommand = \"/x/node_repl\"\n"
    );
}

/// R40：改网关带同步：按改之前的地址找到另一家那一份，地址与密钥一起改
#[test]
fn sync_edit_follows_the_old_address() {
    let f = claude_fixture();
    f.app
        .commit_verified_provider_in(
            Agent::Codex,
            None,
            Some("AP"),
            "https://ap.example",
            "sk-codex-ap-123456",
            vec!["kimi-k3".into()],
            "",
            false,
        )
        .unwrap();
    let saved = f
        .app
        .commit_verified_provider_in(
            Agent::Claude,
            Some("ap"),
            None,
            "https://ap-new.example",
            "sk-new-key-123456",
            vec!["kimi-k3".into(), "new-model".into()],
            "https://ap-new.example/v1",
            true,
        )
        .unwrap();
    assert_eq!(saved.other_provider_id.as_deref(), Some("ap"));
    let w = f.world.lock().unwrap();
    let codex = &w.settings.providers[0];
    assert_eq!(codex.base_url, "https://ap-new.example");
    assert_eq!(codex.api_base.as_deref(), Some("https://ap-new.example/v1"));
    assert!(codex.models.iter().any(|m| m.model.id == "new-model"));
    assert_eq!(
        w.keys.get("ap").map(String::as_str),
        Some("sk-new-key-123456")
    );
    assert_eq!(
        w.keys.get("claude:ap").map(String::as_str),
        Some("sk-new-key-123456")
    );
}

/// AC41：带过来——Codex 有 2 家、Claude 没有：Claude 出现 2 家、模型全未选、有密钥，Codex 不变
#[test]
fn ac41_copy_providers_from_the_other_family() {
    let f = fixture();
    for (name, url, key) in [
        ("WeCode", "https://wecode.example", "sk-wecode-123456"),
        ("Other", "https://other.example", "sk-other-1234567"),
    ] {
        let id = f
            .app
            .commit_verified_provider_in(
                Agent::Codex,
                None,
                Some(name),
                url,
                key,
                vec!["m1".into(), "m2".into()],
                "",
                false,
            )
            .map(|saved| saved.provider_id)
            .unwrap();
        f.app
            .set_models_in(
                Agent::Codex,
                &id,
                vec![Model {
                    id: "m1".into(),
                    ..Default::default()
                }],
            )
            .unwrap();
    }
    let codex_before = f.world.lock().unwrap().settings.clone();
    f.app.copy_providers(Agent::Claude, Agent::Codex).unwrap();
    let view = claude_state(&f);
    assert_eq!(view.providers.len(), 2);
    for provider in &view.providers {
        assert!(provider.has_key, "{}", provider.name);
        assert!(provider.models.iter().all(|m| !m.selected));
        assert_eq!(provider.models.len(), 2);
    }
    assert_eq!(f.world.lock().unwrap().settings, codex_before);
    // 再带一次不重复
    f.app.copy_providers(Agent::Claude, Agent::Codex).unwrap();
    assert_eq!(claude_state(&f).providers.len(), 2);
}

/// R3：两家的状态各自独立
#[test]
fn state_has_both_families_in_order() {
    let f = claude_fixture();
    f.configure();
    let state = f.app.state();
    let agents: Vec<Agent> = state.agents.iter().map(|a| a.agent).collect();
    assert_eq!(agents, [Agent::Codex, Agent::Claude]);
    let codex = &state.agents[0];
    assert_eq!(codex.providers.len(), 1);
    assert!(codex.codex.is_some() && codex.claude.is_none());
    let claude = &state.agents[1];
    assert_eq!(claude.providers[0].id, "ap");
    assert!(claude.providers[0].has_key);
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
    // R39：顶层只剩 supported、router、agents，不留 Codex 的旧字段
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["agents", "router", "supported"]);
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
    assert!(!our_service_uninstalled(&f));
    assert!(claude_routing(&f).is_none());
}

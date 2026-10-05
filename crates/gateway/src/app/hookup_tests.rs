//! Codex 接法按登录状态自动选（spec 2026-10-03-codex-hookup-auto）：没登录 → 独立服务商；
//! 其余 → 借用内置服务商。只在打开开关、改选模型、打开 Sophia 接上时判断（R4）。
use super::tests::{fixture, our_keys, our_lines, Fixture, ORIGINAL};
use super::*;
use sophia_core::codex_models::login::ModeReason;
use sophia_core::codex_models::settings::HookupMode;

const CHATGPT_AUTH: &str = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"x"}}"#;

fn sign_out(f: &Fixture) {
    std::fs::remove_file(f.codex().join("auth.json")).unwrap();
}

fn sign_in(f: &Fixture) {
    std::fs::write(f.codex().join("auth.json"), CHATGPT_AUTH).unwrap();
}

/// 独立服务商形态写进去的全部内容：三个根键（相邻）与文件末尾的那张表
/// 独立服务商接法的根部四行：注释加三个根键
fn provider_lines(f: &Fixture) -> String {
    format!(
        "{}\n{}model_provider = \"sophia\"\n",
        sophia_core::codex_models::config::COMMENT_PROVIDER,
        our_keys(f)
    )
}

const TABLE: &str = "\n[model_providers.sophia]\nname = \"Sophia\"\nbase_url = \"http://127.0.0.1:47328/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n";

fn provider_config(f: &Fixture) -> String {
    format!(
        "{}{TABLE}",
        ORIGINAL.replacen(
            "model_reasoning_effort = \"high\"\n",
            &format!("model_reasoning_effort = \"high\"\n{}", provider_lines(f)),
            1,
        )
    )
}

fn catalog_slugs(f: &Fixture) -> Vec<String> {
    let combined: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.codex().join("sophia-models.json")).unwrap())
            .unwrap();
    combined["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap().to_owned())
        .collect()
}

fn codex_view(f: &Fixture) -> CodexAgentView {
    f.app
        .state()
        .agent(Agent::Codex)
        .and_then(|view| view.codex.clone())
        .unwrap()
}

/// AC4：ChatGPT 登录 → 借用内置服务商：只多两个根键，目录里官方与第三方都在
#[test]
fn ac4_chatgpt_signed_in_borrows_the_builtin_provider() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    assert_eq!(f.read_config().replacen(&our_lines(&f), "", 1), ORIGINAL);
    assert_eq!(catalog_slugs(&f), ["gpt-5.6-sol", "gw.example-weibo-glm-5"]);
    let view = codex_view(&f);
    assert_eq!(view.mode, HookupMode::Builtin);
    assert_eq!(view.mode_reason, Some(ModeReason::SignedIn));
}

/// AC6：API key 登录 → 借用内置服务商
#[test]
fn ac6_api_key_borrows_the_builtin_provider() {
    let f = fixture();
    std::fs::write(
        f.codex().join("auth.json"),
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}"#,
    )
    .unwrap();
    f.configure();
    f.app.enable().unwrap();
    assert_eq!(f.read_config().replacen(&our_lines(&f), "", 1), ORIGINAL);
    assert_eq!(codex_view(&f).mode_reason, Some(ModeReason::ApiKey));
}

/// AC3（写入部分）、AC9、AC10：没登录 → 独立服务商；目录只有第三方；关闭后逐字节还原
#[test]
fn signed_out_uses_the_standalone_provider_and_restores_exactly() {
    let f = fixture();
    sign_out(&f);
    f.configure();
    f.app.enable().unwrap();
    assert_eq!(f.read_config(), provider_config(&f));
    assert_eq!(catalog_slugs(&f), ["gw.example-weibo-glm-5"]);
    let state = f.app.state();
    let codex = state.agent(Agent::Codex).unwrap();
    assert!(codex.enabled, "{}", codex.conflict);
    let view = codex.codex.clone().unwrap();
    assert_eq!(view.mode, HookupMode::Provider);
    assert_eq!(view.mode_reason, Some(ModeReason::SignedOut));
    // 再点一次启用：什么都不变
    f.app.enable().unwrap();
    assert_eq!(f.read_config(), provider_config(&f));
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 显式写着 `model_provider = "openai"`、又没登录：独立服务商要改这一行，Sophia 不改别人写的值，
/// 也不悄悄借用内置（那样 Codex 会停在登录页）——明确拒绝并说清下一步；登录后照常借用内置
#[test]
fn an_explicit_openai_provider_while_signed_out_is_refused_with_a_reason() {
    let f = fixture();
    sign_out(&f);
    let original = format!("model_provider = \"openai\"\n{ORIGINAL}");
    f.write_config(&original);
    f.configure();
    let error = f.app.enable().unwrap_err();
    assert_eq!(error.code, "conflict", "{}", error.message);
    assert!(error.message.contains("没有登录"), "{}", error.message);
    assert_eq!(f.read_config(), original);
    sign_in(&f);
    f.app.enable().unwrap();
    assert!(!f.read_config().contains("[model_providers.sophia]"));
    assert_eq!(codex_view(&f).mode, HookupMode::Builtin);
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), original);
}

/// AC8：上次借用内置、Sophia 没来得及改回就退了；现在已退出登录 → 打开 Sophia 接上时改独立并提示重启
#[test]
fn ac8_attach_after_signing_out_switches_and_asks_for_a_restart() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060);
    assert!(!codex_view(&f).needs_restart);
    // Sophia 被强制结束：路由不在了，Codex 设置还指着它
    f.world.lock().unwrap().router = None;
    sign_out(&f);
    f.world.lock().unwrap().now = 2_000_000_600;
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(f.read_config(), provider_config(&f));
    assert_eq!(catalog_slugs(&f), ["gw.example-weibo-glm-5"]);
    let view = codex_view(&f);
    assert_eq!(view.mode, HookupMode::Provider);
    assert!(view.needs_restart, "换了接法要重启 Codex 才生效");
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 退出时改回了，下次打开 Sophia 时已退出登录：按独立服务商写上
#[test]
fn attach_after_a_clean_quit_writes_the_form_for_the_login_now() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.app.detach_for_quit(|| (), |_| {});
    assert_eq!(f.read_config(), ORIGINAL);
    sign_out(&f);
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(f.read_config(), provider_config(&f));
}

/// 改选模型时重新判断：登录状态变了就换形态并提示重启
#[test]
fn picking_models_again_redecides_the_form() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_060);
    sign_out(&f);
    f.world.lock().unwrap().now = 2_000_000_600;
    f.set_models(vec![
        Model {
            id: "weibo/glm-5".into(),
            display_name: Some("Weibo GLM-5".into()),
            ..Default::default()
        },
        Model {
            id: "kimi-k3".into(),
            ..Default::default()
        },
    ])
    .unwrap();
    assert!(f.read_config().contains("model_provider = \"sophia\""));
    assert_eq!(
        catalog_slugs(&f),
        ["gw.example-weibo-glm-5", "gw.example-kimi-k3"]
    );
    assert!(codex_view(&f).needs_restart);
    // 又登录回来，再改选：换回借用内置
    sign_in(&f);
    f.set_models(vec![Model {
        id: "weibo/glm-5".into(),
        display_name: Some("Weibo GLM-5".into()),
        ..Default::default()
    }])
    .unwrap();
    assert_eq!(f.read_config().replacen(&our_lines(&f), "", 1), ORIGINAL);
    assert_eq!(codex_view(&f).mode, HookupMode::Builtin);
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 运行中不另起判断（R4）：看状态、改网关名字都不改写 Codex 设置
#[test]
fn nothing_else_redecides_the_form() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    let written = f.read_config();
    sign_out(&f);
    let _ = f.app.state();
    let id = f.app.load().unwrap().providers[0].id.clone();
    f.app
        .upsert_provider_in(
            Agent::Codex,
            Some(&id),
            Some("Renamed"),
            "https://gw.example/openai/",
            false,
        )
        .unwrap();
    assert_eq!(f.read_config(), written);
    assert_eq!(codex_view(&f).mode, HookupMode::Builtin);
}

/// 只改网关地址（不是改选模型）也不重新判断接法：R4 只有打开开关、改选模型、打开 Sophia 接上三个时刻
#[test]
fn changing_the_gateway_address_does_not_redecide_the_form() {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    sign_out(&f);
    let id = f.app.load().unwrap().providers[0].id.clone();
    f.app
        .upsert_provider_in(
            Agent::Codex,
            Some(&id),
            None,
            "https://gw2.example/openai/",
            false,
        )
        .unwrap();
    assert!(!f.read_config().contains("[model_providers.sophia]"));
    assert_eq!(codex_view(&f).mode, HookupMode::Builtin);
}

/// 崩溃留下的独立服务商形态，现在已登录：打开开关时换成借用内置，关掉后逐字节还原
#[test]
fn a_crash_leftover_of_the_other_form_is_replaced() {
    let f = fixture();
    sign_out(&f);
    f.configure();
    f.app.enable().unwrap();
    f.world.lock().unwrap().router = None;
    sign_in(&f);
    f.app.enable().unwrap();
    assert_eq!(f.read_config().replacen(&our_lines(&f), "", 1), ORIGINAL);
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 关机时同步改回：独立服务商形态也逐字节改回
#[test]
fn exit_sync_restores_the_standalone_form() {
    let f = fixture();
    sign_out(&f);
    f.configure();
    f.app.enable().unwrap();
    f.app.exit_sync();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 换端口时独立服务商表里的地址一起换，之后关掉仍逐字节还原
#[test]
fn a_port_move_retargets_the_standalone_table() {
    let f = fixture();
    sign_out(&f);
    f.configure();
    f.app.enable().unwrap();
    {
        let mut w = f.world.lock().unwrap();
        w.router = None;
        w.occupied.insert(47328, Occupant::Other);
    }
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        f.read_config(),
        provider_config(&f).replace(":47328/", ":47329/")
    );
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// AC2：判断登录状态不把 auth.json 的任何值带进状态或错误
#[test]
fn ac2_state_never_carries_auth_values() {
    let f = fixture();
    std::fs::write(
        f.codex().join("auth.json"),
        r#"{"auth_mode":"chatgpt","tokens":{"access_token":"tok-SECRET-123"}}"#,
    )
    .unwrap();
    f.configure();
    f.app.enable().unwrap();
    let shown = serde_json::to_string(&f.app.state()).unwrap();
    assert!(!shown.contains("SECRET"), "{shown}");
    let settings = serde_json::to_string(&f.app.load().unwrap()).unwrap();
    assert!(!settings.contains("SECRET"), "{settings}");
}

//! 网关并入 Sophia 进程（spec 2026-10-03-gateway-in-app）：打开时接上（R12、R13、R4）、退出前的预览与收尾（R5–R9）、
//! 关机时同步改回（R10）、旧版 launchd 服务的迁移（R14）。路由是假的：端口被谁占着由 `World::occupied` 决定。
use super::tests::{code, fixture, our_lines, Fixture, ORIGINAL};
use super::*;

/// Codex 开着（第三方模型已启用），路由在 47328
fn codex_on() -> Fixture {
    let f = fixture();
    f.configure();
    f.app.enable().unwrap();
    f
}

/// 模拟 Sophia 退出后再打开（或被强制结束）：路由不在了，记录清空
fn relaunch(f: &Fixture) {
    let mut w = f.world.lock().unwrap();
    w.router = None;
    w.router_events.clear();
    w.codex_events.clear();
}

fn lines_on(f: &Fixture, port: u16) -> String {
    our_lines(f).replace(":47328/", &format!(":{port}/"))
}

fn notice(f: &Fixture) -> Option<PortNotice> {
    f.app.state().port_notice
}

// ---------- 打开 Sophia 时接上（R12、R13、R4） ----------

/// AC1：Codex 开着，打开 Sophia：路由在本进程里起在 47328，不装服务、不复制程序；Codex 设置不变
#[test]
fn ac1_attach_starts_the_router_in_process() {
    let f = codex_on();
    let config = f.read_config();
    relaunch(&f);
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(f.router(), Some(47328));
    assert_eq!(f.router_events(), ["start 47328"]);
    assert_eq!(f.read_config(), config);
    assert!(f.world.lock().unwrap().service_calls.is_empty());
    assert!(!f.root.join("data/bin").exists());
    assert!(f.codex_state().router.running);
    assert_eq!(notice(&f), None);
}

/// AC2：两家都关着：不起路由
#[test]
fn ac2_attach_does_nothing_when_both_are_off() {
    let f = fixture();
    f.configure();
    let report = f.app.attach();
    assert!(report.errors.is_empty() && report.notice.is_none());
    assert_eq!(f.router(), None);
    assert!(f.router_events().is_empty());
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 已经接上时再接一次什么都不做
#[test]
fn attach_twice_is_a_no_op() {
    let f = codex_on();
    let config = f.read_config();
    f.app.attach();
    assert_eq!(f.router_events(), ["start 47328"]);
    assert_eq!(f.read_config(), config);
}

/// AC4：别的程序占着 47328：换到 47329 并记住，Codex 设置按新端口重写（原位换值），
/// 正在运行的 Codex 要重启；之后再打开仍用 47329
#[test]
fn ac4_a_busy_port_moves_the_router_to_the_next_free_one() {
    let f = codex_on();
    let before = f.read_config();
    {
        let mut w = f.world.lock().unwrap();
        w.codex_started_at = Some(2_000_000_100); // Codex 在启用之后启动，加载的是 47328
        w.now = 2_000_000_200;
    }
    relaunch(&f);
    f.world
        .lock()
        .unwrap()
        .occupied
        .insert(47328, Occupant::Other);
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        report.notice,
        Some(PortNotice::PortMoved {
            from: 47328,
            to: 47329
        })
    );
    assert_eq!(f.router(), Some(47329));
    assert_eq!(f.world.lock().unwrap().settings.port, 47329);
    assert_eq!(f.read_config(), before.replace(":47328/", ":47329/"));
    let state = f.codex_state();
    assert!(state.enabled && state.router.running);
    assert_eq!(state.router.port, 47329);
    assert!(state.needs_codex_restart, "正在运行的 Codex 还指着 47328");
    assert_eq!(notice(&f), report.notice);

    // 再次打开：直接用记住的 47329，不再去碰 47328
    relaunch(&f);
    f.world.lock().unwrap().occupied.clear();
    let report = f.app.attach();
    assert_eq!(report.notice, None);
    assert_eq!(f.router_events(), ["start 47329"]);
}

/// AC4 的 Codex 设置：只把路由地址换成新端口，其余逐字节不动；关掉时仍逐字节还原（AC5b）
#[test]
fn ac4_moved_config_keeps_every_other_byte_and_restores_exactly() {
    let f = codex_on();
    let before = f.read_config();
    relaunch(&f);
    f.world
        .lock()
        .unwrap()
        .occupied
        .insert(47328, Occupant::Other);
    f.app.attach();
    assert_eq!(f.read_config(), before.replace(":47328/", ":47329/"));
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

/// AC5：占着端口的是另一个 Sophia：不换端口，Codex 设置改回原样，说明另一个 Sophia 在运行；「开着」不变
#[test]
fn ac5_another_sophia_on_the_port_restores_codex_without_moving() {
    let f = codex_on();
    relaunch(&f);
    f.world
        .lock()
        .unwrap()
        .occupied
        .insert(47328, Occupant::Sophia);
    let report = f.app.attach();
    assert_eq!(
        report.notice,
        Some(PortNotice::AnotherSophia { port: 47328 })
    );
    assert_eq!(f.router(), None);
    assert_eq!(f.read_config(), ORIGINAL);
    let w = f.world.lock().unwrap();
    assert_eq!(w.settings.port, 47328, "不换端口");
    assert_eq!(w.settings.enabled, Some(true), "开着是用户的选择");
    drop(w);
    let state = f.app.state();
    assert_eq!(
        state.port_notice,
        Some(PortNotice::AnotherSophia { port: 47328 })
    );
    let codex = state.agent(Agent::Codex).unwrap();
    assert!(codex.codex.as_ref().unwrap().wanted);
}

/// AC5a：47328–47339 都被别的程序占着：Codex 设置逐字节改回，说明端口都被占用
#[test]
fn ac5a_all_ports_busy_restores_codex() {
    let f = codex_on();
    relaunch(&f);
    {
        let mut w = f.world.lock().unwrap();
        for port in sophia_core::codex_models::settings::PORT_RANGE {
            w.occupied.insert(port, Occupant::Other);
        }
    }
    let report = f.app.attach();
    assert_eq!(report.notice, Some(PortNotice::PortsBusy));
    assert_eq!(f.router(), None);
    assert_eq!(f.read_config(), ORIGINAL);
    assert_eq!(f.world.lock().unwrap().settings.port, 47328);
    let state = f.app.state();
    assert_eq!(state.port_notice, Some(PortNotice::PortsBusy));
    assert!(!state.router.running);
}

/// 换端口时跳过另一个 Sophia 占着的端口
#[test]
fn moving_skips_ports_held_by_another_sophia() {
    let f = codex_on();
    relaunch(&f);
    {
        let mut w = f.world.lock().unwrap();
        w.occupied.insert(47328, Occupant::Other);
        w.occupied.insert(47329, Occupant::Sophia);
    }
    f.app.attach();
    assert_eq!(f.router(), Some(47330));
}

/// AC15：被强制结束时 Codex 开着：再打开，路由回到同一端口，设置不动，正在运行的 Codex 不用重启
#[test]
fn ac15_attach_after_a_crash_needs_no_restart() {
    let f = codex_on();
    let config = f.read_config();
    f.world.lock().unwrap().codex_started_at = Some(2_000_000_100);
    relaunch(&f);
    f.world.lock().unwrap().now = 2_000_000_200;
    f.app.attach();
    assert_eq!(f.router(), Some(47328));
    assert_eq!(f.read_config(), config);
    assert!(!f.codex_state().needs_codex_restart);
}

/// 旧版本留下的设置没有「开着」：第一次打开按 Codex 设置现在指不指着路由补上
#[test]
fn legacy_settings_fill_the_choice_from_the_config() {
    let f = codex_on();
    relaunch(&f);
    f.world.lock().unwrap().settings.enabled = None;
    f.app.attach();
    assert_eq!(f.world.lock().unwrap().settings.enabled, Some(true));
    assert_eq!(f.router(), Some(47328));

    let f = fixture();
    f.configure();
    f.world.lock().unwrap().settings.enabled = None;
    f.app.attach();
    assert_eq!(f.world.lock().unwrap().settings.enabled, Some(false));
    assert_eq!(f.router(), None);
}

/// 用户在模型页关掉：「开着」变 false，两家都关了路由停下；下次打开不接上
#[test]
fn turning_codex_off_is_remembered() {
    let f = codex_on();
    f.app.restore().unwrap();
    assert_eq!(f.world.lock().unwrap().settings.enabled, Some(false));
    assert_eq!(f.router(), None);
    relaunch(&f);
    f.app.attach();
    assert_eq!(f.router(), None);
    assert_eq!(f.read_config(), ORIGINAL);
}

// ---------- 退出前的预览（R5、R6） ----------

#[test]
fn quit_preview_reports_what_quitting_would_touch() {
    let f = fixture();
    let preview = f.app.quit_preview();
    assert!(!preview.codex && !preview.claude && !preview.codex_terminal);

    let f = codex_on();
    {
        let mut w = f.world.lock().unwrap();
        w.codex_app_running = true;
        w.processes = vec![
            process::ProcessInfo {
                pid: 10,
                command: "/Applications/ChatGPT.app/Contents/Resources/codex app-server".into(),
            },
            process::ProcessInfo {
                pid: 11,
                command: "/opt/homebrew/bin/codex exec fix the bug".into(),
            },
        ];
    }
    let preview = f.app.quit_preview();
    assert!(preview.codex && preview.codex_app_running && !preview.codex_terminal);
    f.world
        .lock()
        .unwrap()
        .processes
        .push(process::ProcessInfo {
            pid: 12,
            command: "/opt/homebrew/bin/codex --model gpt-5.6-sol".into(),
        });
    assert!(f.app.quit_preview().codex_terminal);
}

// ---------- 用户主动退出（R7–R9） ----------

/// AC8：确认退出：Codex 设置逐字节改回、Codex 被重启、路由停下；「开着」与启用前默认模型的记录不变
#[test]
fn ac8_detach_restores_codex_restarts_it_and_keeps_the_choice() {
    let f = codex_on();
    f.world.lock().unwrap().codex_app_running = true;
    let prev = f.world.lock().unwrap().settings.prev_model.clone();
    let steps = std::sync::Mutex::new(Vec::new());
    let failures = f
        .app
        .detach_for_quit(|| (), |step| steps.lock().unwrap().push(step));
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(f.read_config(), ORIGINAL);
    assert_eq!(f.router(), None);
    assert_eq!(steps.into_inner().unwrap(), [QuitStep::RestartingCodex]);
    let w = f.world.lock().unwrap();
    assert_eq!(w.codex_events, ["quit", "open"]);
    assert_eq!(w.settings.enabled, Some(true));
    assert_eq!(w.settings.prev_model, prev);
}

/// AC10：Codex 15 秒内没退出：报 desktop_busy，但设置已改回、路由照样停下
#[test]
fn ac10_codex_that_will_not_quit_is_reported_and_quitting_continues() {
    let f = codex_on();
    {
        let mut w = f.world.lock().unwrap();
        w.codex_app_running = true;
        w.codex_app_stuck = true;
    }
    let failures = f.app.detach_for_quit(|| (), |_| {});
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].agent, Agent::Codex);
    assert_eq!(failures[0].code, "desktop_busy");
    assert_eq!(f.read_config(), ORIGINAL);
    assert_eq!(f.router(), None);
}

/// 两家都没开：退出什么都不动
#[test]
fn detach_with_nothing_on_touches_nothing() {
    let f = fixture();
    f.world.lock().unwrap().codex_app_running = true;
    assert!(f.app.detach_for_quit(|| (), |_| {}).is_empty());
    assert!(f.world.lock().unwrap().codex_events.is_empty());
    assert_eq!(f.read_config(), ORIGINAL);
}

/// AC11：退出时 Codex 开着，再打开 Sophia：不用任何操作就接上
#[test]
fn ac11_attach_after_quitting_brings_codex_back() {
    let f = codex_on();
    let config = f.read_config();
    f.app.detach_for_quit(|| (), |_| {});
    assert_eq!(f.read_config(), ORIGINAL);
    relaunch(&f);
    let report = f.app.attach();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(f.read_config(), config);
    assert_eq!(f.router(), Some(47328));
    assert!(f.codex().join("sophia-models.json").exists());
    assert!(f.codex_state().enabled);
}

// ---------- 关机、注销、Dock 退出（R10） ----------

/// R10：只同步改回 Codex 设置，不起子进程、不动「开着」；做两次也一样；再打开时接上
#[test]
fn exit_sync_restores_codex_only_and_is_idempotent() {
    let f = codex_on();
    let config = f.read_config();
    f.world.lock().unwrap().codex_app_running = true;
    f.app.exit_sync();
    assert_eq!(f.read_config(), ORIGINAL);
    {
        let w = f.world.lock().unwrap();
        assert!(w.codex_events.is_empty(), "关机时不重启 Codex");
        assert_eq!(w.settings.enabled, Some(true));
    }
    f.app.exit_sync();
    assert_eq!(f.read_config(), ORIGINAL);

    relaunch(&f);
    f.app.attach();
    assert_eq!(f.read_config(), config);
}

/// 关机前 Codex 在跑：它加载的是第三方配置；关机改回之后再接上，开机后新起的 Codex 读的是官方配置，要提示重启
#[test]
fn exit_sync_is_recorded_so_a_codex_started_meanwhile_is_asked_to_restart() {
    let f = codex_on();
    f.world.lock().unwrap().now = 2_000_000_100;
    f.app.exit_sync();
    relaunch(&f);
    {
        let mut w = f.world.lock().unwrap();
        w.codex_started_at = Some(2_000_000_150); // 开机后、打开 Sophia 前启动的 Codex
        w.now = 2_000_000_200;
    }
    f.app.attach();
    assert!(f.codex_state().needs_codex_restart);
}

// ---------- 旧版 launchd 服务（R14） ----------

/// AC16：旧版留下的 plist 与 bin/ 副本：卸服务、删 plist 和 bin/，只做一次
#[test]
fn ac16_legacy_service_is_migrated_once() {
    let f = fixture();
    std::fs::create_dir_all(f.legacy_plist().parent().unwrap()).unwrap();
    std::fs::write(f.legacy_plist(), "<plist/>").unwrap();
    let bin = f.root.join("data/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("Sophia"), "old").unwrap();
    std::fs::write(bin.join("Sophia.meta"), "1:2 abc").unwrap();

    assert!(f.app.migrate_legacy_service().unwrap());
    assert_eq!(
        f.world.lock().unwrap().service_calls,
        [format!("uninstall {SERVICE_LABEL}")]
    );
    assert!(!f.legacy_plist().exists());
    assert!(!bin.exists());
    assert!(f.root.join("data").exists(), "数据目录里的别的东西不碰");

    assert!(!f.app.migrate_legacy_service().unwrap());
    assert_eq!(f.world.lock().unwrap().service_calls.len(), 1);
}

/// 只剩 bin/ 副本（plist 早被删了）：删副本，不调 launchctl
#[test]
fn a_leftover_binary_copy_is_removed_without_touching_launchd() {
    let f = fixture();
    let bin = f.root.join("data/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("Sophia"), "old").unwrap();
    assert!(f.app.migrate_legacy_service().unwrap());
    assert!(!bin.exists());
    assert!(f.world.lock().unwrap().service_calls.is_empty());
}

/// 路由起不来（不是端口被占）：启用报 router_down，Codex 设置不动
#[test]
fn enable_reports_a_router_that_cannot_start() {
    let f = fixture();
    f.configure();
    f.world.lock().unwrap().healthy = false;
    assert_eq!(code(f.app.enable()), "router_down");
    assert_eq!(f.read_config(), ORIGINAL);
}

/// 启用时端口被另一个 Sophia 占着：不换端口、不写设置，说明原因
#[test]
fn enable_with_another_sophia_on_the_port_is_refused() {
    let f = fixture();
    f.configure();
    f.world
        .lock()
        .unwrap()
        .occupied
        .insert(47328, Occupant::Sophia);
    let error = f.app.enable().unwrap_err();
    assert_eq!(error.code, "router_down");
    assert_eq!(f.read_config(), ORIGINAL);
    assert_eq!(notice(&f), Some(PortNotice::AnotherSophia { port: 47328 }));
}

/// 启用时端口被别的程序占着：换端口后照常启用，写的是新端口
#[test]
fn enable_on_a_busy_port_moves_and_writes_the_new_port() {
    let f = fixture();
    f.configure();
    f.world
        .lock()
        .unwrap()
        .occupied
        .insert(47328, Occupant::Other);
    f.app.enable().unwrap();
    assert_eq!(f.router(), Some(47329));
    assert!(f.read_config().contains(&lines_on(&f, 47329)));
    f.app.restore().unwrap();
    assert_eq!(f.read_config(), ORIGINAL);
}

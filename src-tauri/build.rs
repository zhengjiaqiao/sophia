fn main() {
    guard_diag_faults();
    // 自动上报的接收服务地址由正式发版流水线注入（`option_env!`，src/report.rs）；变了要重编
    println!("cargo:rerun-if-env-changed=SOPHIA_REPORT_URL");
    tauri_build::build()
}

/// 故意出错的入口（`diag-faults`）不能随正式包发出去（spec 2026-10-04-local-diagnostics 风险 2）：
/// release 构建开了它就停下，除非构建时显式设 `SOPHIA_ALLOW_DIAG_FAULTS=1`（只给本机验证崩溃记录用，
/// 见 packaging/README.md「验证崩溃记录」）
fn guard_diag_faults() {
    println!("cargo:rerun-if-env-changed=SOPHIA_ALLOW_DIAG_FAULTS");
    let release = std::env::var("PROFILE").is_ok_and(|p| p == "release");
    let faults = std::env::var_os("CARGO_FEATURE_DIAG_FAULTS").is_some();
    let allowed = std::env::var("SOPHIA_ALLOW_DIAG_FAULTS").is_ok_and(|v| v == "1");
    if release && faults && !allowed {
        panic!(
            "release 构建开了 diag-faults（故意出错的入口），不能发出去。\
             只是本机验证崩溃记录的话，构建时加 SOPHIA_ALLOW_DIAG_FAULTS=1"
        );
    }
}

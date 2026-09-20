// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 只有第一个参数恰好是 gateway 才走无界面模式，其余一律进界面，不解析、不报错。
    // macOS 从 Finder 双击启动时系统会传 -psn_… 参数；用通用解析库严格解析会让应用打不开，
    // 而 tauri dev 下复现不了。
    if std::env::args().nth(1).as_deref() == Some("gateway") {
        std::process::exit(symsync_lib::gateway_cli(std::env::args().skip(2).collect()));
    }
    symsync_lib::run()
}

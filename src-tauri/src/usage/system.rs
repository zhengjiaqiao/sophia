//! 调度要看的系统状态（spec R6）：屏幕睡没睡、低电量模式、发热、是否在用电池。
//!
//! 现查，不订阅通知：
//! - 屏幕睡着：`CGDisplayIsAsleep(CGMainDisplayID())`，睡着时整个不跑；由睡着变醒算一次「唤醒」补刷。
//! - 整机睡眠：由调度循环自己比较单调时钟与墙上时钟发现（`sophia_gateway::usage::scheduler::woke_from_sleep`）。
//! - 低电量、发热：`NSProcessInfo.isLowPowerModeEnabled` / `thermalState`（serious 及以上算发热）。
//! - 电池：`/usr/bin/pmset -g ps` 的第一行写着「Now drawing from 'Battery Power'」或「'AC Power'」。
//!   只在做调度决定时查一次（几分钟一次），开销可以忽略；查不出按接电处理（不翻倍）。
use objc2_core_graphics::{CGDisplayIsAsleep, CGMainDisplayID};
use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};
use sophia_gateway::usage::scheduler::SystemState;
use std::process::Command;

/// 主屏幕是否睡着。调度循环在后台每分钟查一次，很便宜
pub fn display_asleep() -> bool {
    CGDisplayIsAsleep(CGMainDisplayID())
}

/// 电池、低电量、发热（serious 及以上算发热）。只在要做调度决定时查（几分钟一次）
pub fn read() -> SystemState {
    let info = NSProcessInfo::processInfo();
    let thermal = info.thermalState();
    SystemState {
        on_battery: on_battery(),
        constrained: info.isLowPowerModeEnabled()
            || thermal == NSProcessInfoThermalState::Serious
            || thermal == NSProcessInfoThermalState::Critical,
    }
}

fn on_battery() -> bool {
    Command::new("/usr/bin/pmset")
        .args(["-g", "ps"])
        .output()
        .ok()
        .map(|o| parse_pmset_power_source(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}

/// `pmset -g ps` 第一行：`Now drawing from 'Battery Power'` / `Now drawing from 'AC Power'`
pub fn parse_pmset_power_source(out: &str) -> bool {
    out.lines()
        .next()
        .is_some_and(|l| l.contains("'Battery Power'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmset_battery_and_ac() {
        assert!(parse_pmset_power_source(
            "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging\n"
        ));
        assert!(!parse_pmset_power_source(
            "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged\n"
        ));
        assert!(!parse_pmset_power_source(""));
    }
}

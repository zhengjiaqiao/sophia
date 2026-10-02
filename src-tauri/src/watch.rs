//! 文件系统监视：每次扫描后按新的目录集合重建监视，变化时向前端 emit `fs-changed`
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 去抖窗口：本工具自己的写操作也会触发事件，多扫一次可接受
const DEBOUNCE: Duration = Duration::from_millis(500);

/// 去抖器 + 它当前监视的目录集合；丢弃即停止监视
pub struct Watcher {
    paths: BTreeSet<PathBuf>,
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// 按新的目录集合重建监视；集合未变则不动。监视失败只记日志，不报错到界面
pub fn resync(slot: &mut Option<Watcher>, app: &AppHandle, paths: BTreeSet<PathBuf>) {
    if slot.as_ref().is_some_and(|w| w.paths == paths) {
        return;
    }
    // 先丢弃旧的，避免同一目录被两个去抖器同时监视
    *slot = None;
    let app = app.clone();
    let mut debouncer = match new_debouncer(DEBOUNCE, move |_| {
        let _ = app.emit("fs-changed", ());
    }) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("创建文件系统监视失败：{e}");
            return;
        }
    };
    for path in &paths {
        // skill 是这些目录的直接子项，非递归即可覆盖建链、删链、删本体目录
        if let Err(e) = debouncer.watcher().watch(path, RecursiveMode::NonRecursive) {
            eprintln!("监视 {} 失败：{e}", path.display());
        }
    }
    *slot = Some(Watcher {
        paths,
        _debouncer: debouncer,
    });
}

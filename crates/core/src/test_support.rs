//! 在系统临时目录下搭真实文件树；root 已 canonicalize，避免 macOS 的 /var 与 /private/var 差异
use std::path::{Path, PathBuf};

pub struct TempTree {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl TempTree {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize");
        Self { _dir: dir, root }
    }

    /// 后续任务的测试用；allow 而非 expect，被用上后不必回来删属性
    #[allow(dead_code)]
    pub fn root(&self) -> PathBuf {
        self.root.clone()
    }

    /// 相对 root 创建目录（可多级）
    pub fn dir(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(&p).expect("create_dir_all");
        p
    }

    /// 在目录下创建小文件
    pub fn file(&self, dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "x").expect("write");
        p
    }

    /// 建软链 at -> to（绝对路径）
    pub fn link(&self, at: &Path, to: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(to, at).expect("symlink");
        #[cfg(windows)]
        junction::create(to, at).expect("junction");
    }
}

//! 文件系统原语：lstat 语义的条目判定、realpath、路径标准化、建链/删链
use crate::models::LinkStyle;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryKind {
    Missing,
    /// 链接目标，已解析为标准化的绝对路径（不解析软链）
    Symlink(PathBuf),
    File,
    Dir,
}

/// 基于 symlink_metadata（lstat），坏软链也识别为 Symlink
pub fn entry_kind(path: &Path) -> EntryKind {
    match std::fs::symlink_metadata(path) {
        Err(_) => EntryKind::Missing,
        Ok(meta) if meta.file_type().is_symlink() => {
            let raw = std::fs::read_link(path).unwrap_or_default();
            let abs = if raw.is_absolute() {
                raw
            } else {
                path.parent().unwrap_or(Path::new("")).join(raw)
            };
            EntryKind::Symlink(normalize(&abs))
        }
        Ok(meta) if meta.is_dir() => EntryKind::Dir,
        Ok(_) => EntryKind::File,
    }
}

/// canonicalize；目标不存在（坏链）时为 None
pub fn real_path(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// 两个路径解析后是否同一处
pub fn same_real(a: &Path, b: &Path) -> bool {
    matches!((real_path(a), real_path(b)), (Some(x), Some(y)) if x == y)
}

/// 去掉 `.`、`..`、尾斜杠，不解析软链
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                // 空，或末尾已是 ..：相对路径保留 ..；绝对路径不会走到这里
                None | Some(Component::ParentDir) => {
                    if !path.is_absolute() {
                        out.push("..");
                    }
                }
                // 已在根或盘符：忽略，不能越过根
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => {
                    out.pop();
                }
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 建链。Unix 按 style 写绝对或相对目标；Windows 一律 junction + 绝对路径
pub fn create_link(target: &Path, link: &Path, style: LinkStyle) -> io::Result<()> {
    #[cfg(unix)]
    {
        let link_target = match style {
            LinkStyle::Absolute => target.to_path_buf(),
            LinkStyle::Relative => {
                // 相对路径要基于链接所在目录的真实位置计算，父目录本身是软链时才不会算错
                let parent = link.parent().unwrap_or(Path::new("."));
                let real_parent = real_path(parent).unwrap_or_else(|| parent.to_path_buf());
                let real_target = real_path(target).unwrap_or_else(|| target.to_path_buf());
                pathdiff::diff_paths(&real_target, &real_parent)
                    .unwrap_or_else(|| target.to_path_buf())
            }
        };
        std::os::unix::fs::symlink(link_target, link)
    }
    #[cfg(windows)]
    {
        let _ = style;
        junction::create(target, link)
    }
}

/// `create_link` 的失败是不是「这里建不了链接」（spec #194 / #204）：文件系统不支持软链
/// （exFAT、部分网络盘），或 Windows 上建不了 junction（FAT32 / exFAT 报「Incorrect function」）。
/// 只对建链这一步的错误有意义：同样的错误码出在别的写入上不是这个意思。
/// 错误码按平台写死（core 不依赖 libc，同 `atomicfile::write_failure`）：
/// - macOS：ENOTSUP 45、EOPNOTSUPP 102、ENOSYS 78
/// - Linux：EOPNOTSUPP 95、ENOSYS 38、EPERM 1（symlink(2)：「文件系统不支持建软链」，权限不够是 EACCES）
/// - Windows：ERROR_INVALID_FUNCTION 1、ERROR_NOT_SUPPORTED 50、ERROR_PRIVILEGE_NOT_HELD 1314、
///   ERROR_NOT_A_REPARSE_POINT 4390（Windows 部分没有实机核对）
pub fn link_unsupported(e: &io::Error) -> bool {
    #[cfg(target_os = "macos")]
    const CODES: &[i32] = &[45, 102, 78];
    #[cfg(target_os = "linux")]
    const CODES: &[i32] = &[95, 38, 1];
    #[cfg(windows)]
    const CODES: &[i32] = &[1, 50, 1314, 4390];
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    const CODES: &[i32] = &[];
    e.kind() == io::ErrorKind::Unsupported || e.raw_os_error().is_some_and(|c| CODES.contains(&c))
}

/// 改名跨了卷（EXDEV；Windows 是 ERROR_NOT_SAME_DEVICE 17）：两处不在同一个文件系统上，
/// `rename` 做不了，要复制再删。错误码按平台写死（同 `link_unsupported`）
pub fn crosses_volume(e: &io::Error) -> bool {
    #[cfg(unix)]
    const CODE: i32 = 18;
    #[cfg(windows)]
    const CODE: i32 = 17;
    #[cfg(not(any(unix, windows)))]
    const CODE: i32 = -1;
    e.kind() == io::ErrorKind::CrossesDevices || e.raw_os_error() == Some(CODE)
}

/// 只删链接本身。Unix 软链是文件，Windows junction 是目录
pub fn remove_link(link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::remove_file(link)
    }
    #[cfg(windows)]
    {
        std::fs::remove_dir(link)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LinkStyle;
    use crate::test_support::TempTree;
    use std::path::Path;

    #[test]
    fn normalize_removes_dots_and_parent_refs() {
        assert_eq!(normalize(Path::new("/a/b/../c/")), Path::new("/a/c"));
        assert_eq!(normalize(Path::new("/a/./b")), Path::new("/a/b"));
        assert_eq!(normalize(Path::new("/..")), Path::new("/"));
        assert_eq!(normalize(Path::new("../../a")), Path::new("../../a"));
        assert_eq!(normalize(Path::new("../..")), Path::new("../.."));
        assert_eq!(normalize(Path::new("a/../../b")), Path::new("../b"));
    }

    #[test]
    fn entry_kind_distinguishes_missing_file_dir_symlink() {
        let t = TempTree::new();
        let d = t.dir("d");
        let f = t.file(&d, "f");
        let l = d.join("l");
        t.link(&l, &f);
        assert_eq!(entry_kind(&d.join("nope")), EntryKind::Missing);
        assert_eq!(entry_kind(&f), EntryKind::File);
        assert_eq!(entry_kind(&d), EntryKind::Dir);
        assert_eq!(entry_kind(&l), EntryKind::Symlink(f.clone()));
    }

    #[test]
    fn broken_symlink_is_still_symlink() {
        let t = TempTree::new();
        let d = t.dir("d");
        let gone = d.join("gone");
        let l = d.join("l");
        t.link(&l, &gone);
        assert_eq!(entry_kind(&l), EntryKind::Symlink(gone.clone()));
        assert!(!l.exists());
        assert_eq!(real_path(&l), None);
    }

    #[cfg(unix)]
    #[test]
    fn relative_symlink_destination_is_resolved_against_its_directory() {
        let t = TempTree::new();
        let d = t.dir("d");
        let f = t.file(&d, "f");
        let l = d.join("l");
        std::os::unix::fs::symlink("f", &l).unwrap();
        assert_eq!(entry_kind(&l), EntryKind::Symlink(f.clone()));
        assert!(same_real(&l, &f));
    }

    #[cfg(unix)]
    #[test]
    fn create_link_absolute_and_relative() {
        let t = TempTree::new();
        let src = t.dir("src/a");
        let dst = t.dir("dst");
        create_link(&src, &dst.join("abs"), LinkStyle::Absolute).unwrap();
        create_link(&src, &dst.join("rel"), LinkStyle::Relative).unwrap();
        assert_eq!(std::fs::read_link(dst.join("abs")).unwrap(), src);
        assert_eq!(
            std::fs::read_link(dst.join("rel")).unwrap(),
            Path::new("../src/a")
        );
        assert!(same_real(&dst.join("rel"), &src));
    }

    #[test]
    fn remove_link_removes_only_the_link() {
        let t = TempTree::new();
        let d = t.dir("d");
        let f = t.file(&d, "f");
        let l = d.join("l");
        t.link(&l, &f);
        remove_link(&l).unwrap();
        assert_eq!(entry_kind(&l), EntryKind::Missing);
        assert!(f.exists());
    }
}

//! 配置文件的安全写入原语：快照、指纹比对、备份、原子替换、父目录检查。
//!
//! MCP 同步与 Codex 模型网关会写同一个物理文件（`~/.codex/config.toml`），
//! 两边必须共用这一份实现，避免各写各的导致竞态保护不一致。
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

/// 读取时刻的文件元数据指纹；与字节内容一起判断"预览之后有没有被别人动过"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    mode: u32,
}

/// 某一时刻的文件内容与指纹。指纹只能由 `read_state` 产生，调用方无法伪造。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub bytes: Vec<u8>,
    fingerprint: Fingerprint,
}

/// 可写目标的两种合法状态；不可读、软链接等情况由 `ReadError` 表达，一律不可写。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileState {
    Missing,
    Present(Snapshot),
}

/// `read_state` 拒绝读取的原因。调用方据此生成各自领域的提示文案。
#[derive(Debug)]
pub enum ReadError {
    /// 路径本身是软链接（lstat 判定，不跟随）
    Symlink,
    /// 路径存在但不是普通文件
    NotRegularFile,
    /// lstat 或读取失败（NotFound 除外，那是 `FileState::Missing`）
    Io(io::Error),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Symlink => f.write_str("symlink"),
            Self::NotRegularFile => f.write_str("not a regular file"),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ReadError {}

/// 读取文件并生成快照。用 `symlink_metadata`（lstat）判断类型，软链接直接拒绝。
pub fn read_state(path: &Path) -> Result<FileState, ReadError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => return Err(ReadError::Symlink),
        Ok(metadata) if !metadata.is_file() => return Err(ReadError::NotRegularFile),
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(FileState::Missing),
        Err(error) => return Err(ReadError::Io(error)),
    };
    match fs::read(path) {
        Ok(bytes) => Ok(FileState::Present(Snapshot {
            bytes,
            fingerprint: fingerprint(&metadata),
        })),
        Err(error) => Err(ReadError::Io(error)),
    }
}

fn fingerprint(metadata: &fs::Metadata) -> Fingerprint {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Fingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            dev: metadata.dev(),
            ino: metadata.ino(),
            mode: metadata.mode(),
        }
    }
    #[cfg(not(unix))]
    {
        Fingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

/// 磁盘上的当前状态是否仍与 `expected` 完全一致（内容 + 指纹）。读不了一律算不一致。
pub fn same(path: &Path, expected: &FileState) -> bool {
    match (expected, read_state(path)) {
        (FileState::Missing, Ok(FileState::Missing)) => true,
        (FileState::Present(expected), Ok(FileState::Present(actual))) => expected == &actual,
        _ => false,
    }
}

/// 把快照内容备份到同目录。文件名用 `with_extension` 生成，即**替换**原扩展名：
/// `config.toml` + 后缀 `mcp` → `config.mcp.bak`，被占用则 `config.mcp.1.bak`、`config.mcp.2.bak`……
/// 只用 `create_new`，绝不覆盖已有备份。
pub fn backup(path: &Path, snap: &Snapshot, suffix: &str) -> io::Result<PathBuf> {
    safe_parent(path)?;
    for n in 0..1000 {
        let candidate = if n == 0 {
            path.with_extension(format!("{suffix}.bak"))
        } else {
            path.with_extension(format!("{suffix}.{n}.bak"))
        };
        let mut opt = OpenOptions::new();
        opt.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opt.mode(snap.fingerprint.mode & 0o777);
        }
        match opt.open(&candidate) {
            Ok(mut file) => {
                file.write_all(&snap.bytes)?;
                file.sync_all()?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "backup"))
}

/// 原子替换：同目录临时文件 → 沿用原权限 → fsync → rename。
/// 写临时文件前后各校验一次目标仍与 `expected` 一致；预期不存在时用 `persist_noclobber`，
/// 两次校验之后才冒出来的文件也不会被覆盖。
pub fn atomic_write(path: &Path, bytes: &[u8], expected: &FileState) -> io::Result<()> {
    write_with(path, bytes, expected, |_| {})
}

/// `write_with` 回调的时机。生产路径传空回调；测试借此在确定的时刻注入并发改动。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// 临时文件已写完，第二次校验之前
    BeforeRecheck,
    /// 第二次校验已通过，rename 之前
    BeforePersist,
}

fn write_with(
    path: &Path,
    bytes: &[u8],
    expected: &FileState,
    mut probe: impl FnMut(Step),
) -> io::Result<()> {
    safe_parent(path)?;
    if !same(path, expected) {
        return Err(io::Error::other("changed"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "parent"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    if let FileState::Present(snap) = expected {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(snap.fingerprint.mode & 0o777))?;
    }
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    probe(Step::BeforeRecheck);
    if !same(path, expected) {
        return Err(io::Error::other("changed"));
    }
    probe(Step::BeforePersist);
    match expected {
        FileState::Missing => file
            .persist_noclobber(path)
            .map(|_| ())
            .map_err(|error| error.error),
        FileState::Present(_) => file.persist(path).map(|_| ()).map_err(|error| error.error),
    }
}

/// 逐级检查父目录：出现 `..`、软链接或非目录分量即拒绝；缺失的目录会被创建。
pub fn safe_parent(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "parent"))?;
    let mut current = PathBuf::new();
    for part in parent.components() {
        match part {
            Component::RootDir | Component::Prefix(_) => current.push(part.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "parent traversal",
                ))
            }
            Component::Normal(part) => {
                current.push(part);
                match fs::symlink_metadata(&current) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "symlink parent",
                        ))
                    }
                    Ok(meta) if !meta.is_dir() => {
                        return Err(io::Error::new(io::ErrorKind::NotADirectory, "parent"))
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        fs::create_dir(&current)?
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}

/// 预览只检查，不创建目标目录；执行前的 `safe_parent` 会再次检查并创建缺失目录。
pub fn unsafe_parent(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return true;
    };
    let mut current = PathBuf::new();
    for part in parent.components() {
        match part {
            Component::RootDir | Component::Prefix(_) => current.push(part.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => return true,
            Component::Normal(part) => {
                current.push(part);
                match fs::symlink_metadata(&current) {
                    Ok(meta) if meta.file_type().is_symlink() => return true,
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return false,
                    Err(_) => return true,
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    fn snapshot(path: &Path) -> Snapshot {
        match read_state(path).expect("read_state") {
            FileState::Present(snapshot) => snapshot,
            FileState::Missing => panic!("文件应当存在"),
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("read_dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    #[test]
    fn read_state_distinguishes_missing_present_and_refused() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        assert_eq!(read_state(&path).expect("missing"), FileState::Missing);

        fs::write(&path, b"a = 1\n").expect("write");
        assert_eq!(snapshot(&path).bytes, b"a = 1\n");

        let link = dir.join("link.toml");
        tree.link(&link, &path);
        #[cfg(unix)]
        assert!(matches!(read_state(&link), Err(ReadError::Symlink)));
        assert!(matches!(read_state(&dir), Err(ReadError::NotRegularFile)));
    }

    #[test]
    fn backup_replaces_extension_and_numbers_on_collision() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"original").expect("write");
        let snap = snapshot(&path);

        let first = backup(&path, &snap, "mcp").expect("first");
        let second = backup(&path, &snap, "mcp").expect("second");
        let third = backup(&path, &snap, "mcp").expect("third");
        let models = backup(&path, &snap, "models").expect("models");

        assert_eq!(first, dir.join("config.mcp.bak"));
        assert_eq!(second, dir.join("config.mcp.1.bak"));
        assert_eq!(third, dir.join("config.mcp.2.bak"));
        assert_eq!(models, dir.join("config.models.bak"));
        assert_eq!(
            backup(&path, &snap, "models").expect("models again"),
            dir.join("config.models.1.bak")
        );
        for copy in [&first, &second, &third, &models] {
            assert_eq!(fs::read(copy).expect("read backup"), b"original");
        }
        assert_eq!(fs::read(&path).expect("read"), b"original");
    }

    #[test]
    fn backup_without_extension_appends_suffix() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("settings");
        fs::write(&path, b"x").expect("write");
        let copy = backup(&path, &snapshot(&path), "mcp").expect("backup");
        assert_eq!(copy, dir.join("settings.mcp.bak"));
    }

    #[test]
    fn backup_never_overwrites_an_existing_backup() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"new").expect("write");
        fs::write(dir.join("config.mcp.bak"), b"older backup").expect("write");

        let copy = backup(&path, &snapshot(&path), "mcp").expect("backup");

        assert_eq!(copy, dir.join("config.mcp.1.bak"));
        assert_eq!(
            fs::read(dir.join("config.mcp.bak")).expect("read"),
            b"older backup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn backup_and_write_preserve_mode() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"secret").expect("write");
        set_mode(&path, 0o600);
        let state = read_state(&path).expect("read_state");
        let FileState::Present(snap) = &state else {
            panic!("文件应当存在");
        };

        let copy = backup(&path, snap, "mcp").expect("backup");
        atomic_write(&path, b"updated", &state).expect("write");

        assert_eq!(mode(&copy), 0o600);
        assert_eq!(mode(&path), 0o600);
        assert_eq!(fs::read(&path).expect("read"), b"updated");

        // 另一种权限也原样保留，证明不是临时文件默认的 0600 碰巧相同
        set_mode(&path, 0o644);
        let state = read_state(&path).expect("read_state");
        atomic_write(&path, b"again", &state).expect("write");
        assert_eq!(mode(&path), 0o644);
    }

    #[test]
    fn atomic_write_replaces_present_and_creates_missing() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");

        atomic_write(&path, b"first", &FileState::Missing).expect("create");
        assert_eq!(fs::read(&path).expect("read"), b"first");

        let state = read_state(&path).expect("read_state");
        atomic_write(&path, b"second", &state).expect("replace");
        assert_eq!(fs::read(&path).expect("read"), b"second");
        assert_eq!(names(&dir), ["config.toml"]);
    }

    #[test]
    fn atomic_write_creates_missing_parent_directories() {
        let tree = TempTree::new();
        let path = tree.root().join("a/b/config.toml");
        atomic_write(&path, b"x", &FileState::Missing).expect("create");
        assert_eq!(fs::read(&path).expect("read"), b"x");
    }

    #[test]
    fn atomic_write_refuses_when_file_changed_after_snapshot() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"before").expect("write");
        let state = read_state(&path).expect("read_state");
        fs::write(&path, b"edited by someone else").expect("write");

        let error = atomic_write(&path, b"ours", &state).expect_err("must refuse");

        assert_eq!(error.to_string(), "changed");
        assert_eq!(fs::read(&path).expect("read"), b"edited by someone else");
        assert_eq!(names(&dir), ["config.toml"]);
    }

    #[test]
    fn atomic_write_refuses_when_file_vanished_after_snapshot() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"before").expect("write");
        let state = read_state(&path).expect("read_state");
        fs::remove_file(&path).expect("remove");

        assert!(atomic_write(&path, b"ours", &state).is_err());
        assert!(names(&dir).is_empty());
    }

    #[test]
    fn atomic_write_refuses_when_file_changes_before_persist() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"before").expect("write");
        let state = read_state(&path).expect("read_state");

        // 第一次校验通过、临时文件写完之后才被别人改动：第二次校验必须拦下
        let error = write_with(&path, b"ours", &state, |step| {
            if step == Step::BeforeRecheck {
                fs::write(&path, b"raced edit").expect("write");
            }
        })
        .expect_err("must refuse");

        assert_eq!(error.to_string(), "changed");
        assert_eq!(fs::read(&path).expect("read"), b"raced edit");
        assert_eq!(names(&dir), ["config.toml"]);
    }

    #[test]
    fn atomic_write_refuses_when_missing_target_appeared_before_call() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        fs::write(&path, b"appeared").expect("write");

        let error = atomic_write(&path, b"ours", &FileState::Missing).expect_err("must refuse");

        assert_eq!(error.to_string(), "changed");
        assert_eq!(fs::read(&path).expect("read"), b"appeared");
    }

    #[test]
    fn atomic_write_does_not_clobber_file_appearing_after_recheck() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");

        // 两次校验都通过之后目标才出现：只能靠 persist_noclobber 兜底
        let error = write_with(&path, b"ours", &FileState::Missing, |step| {
            if step == Step::BeforePersist {
                fs::write(&path, b"appeared").expect("write");
            }
        })
        .expect_err("must refuse");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).expect("read"), b"appeared");
        assert_eq!(names(&dir), ["config.toml"]);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_refuses_symlinked_target() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let real = dir.join("real.toml");
        fs::write(&real, b"real").expect("write");
        let state = read_state(&real).expect("read_state");
        let link = dir.join("config.toml");
        tree.link(&link, &real);

        assert!(atomic_write(&link, b"ours", &state).is_err());
        assert_eq!(fs::read(&real).expect("read"), b"real");
    }

    #[cfg(unix)]
    #[test]
    fn safe_parent_rejects_symlinked_component() {
        let tree = TempTree::new();
        let real = tree.dir("real/nested");
        let link = tree.root().join("link");
        tree.link(&link, &tree.root().join("real"));
        let path = link.join("nested/config.toml");

        let error = safe_parent(&path).expect_err("must refuse");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(unsafe_parent(&path));
        let other = tree.file(&tree.root(), "other.toml");
        assert!(backup(&path, &snapshot(&other), "mcp").is_err());
        assert!(atomic_write(&path, b"x", &FileState::Missing).is_err());
        assert!(names(&real).is_empty());
    }

    #[test]
    fn safe_parent_rejects_parent_traversal() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("../escape/config.toml");

        let error = safe_parent(&path).expect_err("must refuse");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(unsafe_parent(&path));
        assert!(!tree.root().join("escape").exists());
    }

    #[test]
    fn safe_parent_rejects_file_component_and_creates_missing_directories() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let file = tree.file(&dir, "plain");
        assert!(safe_parent(&file.join("config.toml")).is_err());

        let path = dir.join("x/y/config.toml");
        assert!(!unsafe_parent(&path));
        assert!(!dir.join("x").exists(), "预览检查不得创建目录");
        safe_parent(&path).expect("safe");
        assert!(dir.join("x/y").is_dir());
    }
}

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

/// Sophia 数据目录下放备份的子目录名：`<数据目录>/backups/`
pub const BACKUPS_DIR: &str = "backups";

/// 每个原文件最多留几份备份；新备份写成之后删掉更早的
pub const BACKUP_KEEP: usize = 10;

/// 某个原文件的备份放在哪个目录：`<root>/<原文件名>-<完整路径 SHA-1 前 12 位>/`。
///
/// 原文件名去掉开头的点（`.mcp.json` → `mcp.json`，免得在访达里隐身），其余非
/// `[A-Za-z0-9._-]` 的字符换成 `_`，最长 64 个字符；哈希区分同名的不同文件。
/// 路径先把父目录 canonicalize（同一个文件的不同写法落到同一个目录），做不到就按原样。
pub fn backup_dir(root: &Path, path: &Path) -> PathBuf {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(identity(path).to_string_lossy().as_bytes());
    let hash: String = hasher
        .finalize()
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let name: String = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .trim_start_matches('.')
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let name = if name.is_empty() { "file".into() } else { name };
    root.join(format!("{name}-{hash}"))
}

/// 认原文件用的完整路径：父目录 canonicalize 后接文件名；做不到就按原样
fn identity(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// 把快照内容备份到 Sophia 自己的备份目录 `root`（`<数据目录>/backups`），原文件旁边不留任何东西：
/// 原文件常在用户的项目仓库里（`<项目>/.mcp.json`），备份里有明文密钥，放旁边容易被顺手提交。
///
/// 布局见 `backup_dir`：每个原文件一个目录，里面 `source` 记原文件完整路径，备份按序号命名
/// `000001-<suffix>.bak`、`000002-<suffix>.bak`……（`suffix` 标明是谁写的：`mcp`、`models`……）。
/// 目录 0700、文件 0600（unix）。只用 `create_new`，绝不覆盖已有备份；写成之后只留最近
/// `BACKUP_KEEP` 份，删不掉的不算失败。备份目录本身是软链则拒绝。
pub fn backup(path: &Path, snap: &Snapshot, suffix: &str, root: &Path) -> io::Result<PathBuf> {
    safe_parent(path)?;
    let dir = backup_dir(root, path);
    private_dir(root)?;
    private_dir(&dir)?;
    write_source(&dir, path)?;
    let mut next = backups_in(&dir)?
        .last()
        .map_or(1, |(seq, _)| seq.saturating_add(1));
    for _ in 0..1000 {
        let candidate = dir.join(format!("{next:06}-{suffix}.bak"));
        match private_file(&candidate) {
            Ok(mut file) => {
                file.write_all(&snap.bytes)?;
                file.sync_all()?;
                prune(&dir, &candidate);
                return Ok(candidate);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => next += 1,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "backup"))
}

/// 建（或确认）一个只有自己能进的目录：不能是软链，unix 上收紧到 0700
fn private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if meta.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "symlink backup dir",
        ));
    }
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotADirectory, "backup dir"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// 新建一个只有自己能读写的文件；已存在返回 `AlreadyExists`
fn private_file(path: &Path) -> io::Result<fs::File> {
    let mut opt = OpenOptions::new();
    opt.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opt.mode(0o600);
    }
    opt.open(path)
}

/// 目录里的 `source` 记原文件完整路径（一行），人和程序都能据此认出是谁的备份。已有就不动
fn write_source(dir: &Path, path: &Path) -> io::Result<()> {
    match private_file(&dir.join("source")) {
        Ok(mut file) => {
            file.write_all(format!("{}\n", identity(path).display()).as_bytes())?;
            file.sync_all()
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

/// 目录里按序号排好的备份（`<数字>-<任意>.bak` 的普通文件），序号从小到大
fn backups_in(dir: &Path) -> io::Result<Vec<(u64, PathBuf)>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(seq) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".bak"))
            .and_then(|stem| stem.split_once('-'))
            .and_then(|(seq, _)| seq.parse::<u64>().ok())
        else {
            continue;
        };
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            found.push((seq, entry.path()));
        }
    }
    found.sort();
    Ok(found)
}

/// 只留最近 `BACKUP_KEEP` 份；刚写的那份无论如何不删。尽力而为：列目录或删除失败都不影响这次写入
fn prune(dir: &Path, keep: &Path) {
    let Ok(found) = backups_in(dir) else { return };
    let excess = found.len().saturating_sub(BACKUP_KEEP);
    for (_, old) in found.into_iter().take(excess) {
        if old != keep {
            let _ = fs::remove_file(old);
        }
    }
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
    let staged = stage(path, bytes, expected)?;
    probe(Step::BeforeRecheck);
    staged.commit_with(|| probe(Step::BeforePersist))
}

/// 已写好、还没换上去的一份新内容（`stage` 的结果）。几个文件要一起改时先把每个都 `stage` 好——
/// 占磁盘的那一步（写临时文件、fsync）全在这里做完，磁盘满、没权限都在换掉任何一个之前暴露——
/// 再逐个 `commit`（只剩 rename）。不 `commit` 就丢掉时临时文件随之删除，目标不动
#[derive(Debug)]
pub struct Staged {
    path: PathBuf,
    expected: FileState,
    file: tempfile::NamedTempFile,
}

/// 原子替换的前一半：校验目标仍与 `expected` 一致，在同目录写好临时文件（沿用原权限、fsync）
pub fn stage(path: &Path, bytes: &[u8], expected: &FileState) -> io::Result<Staged> {
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
    Ok(Staged {
        path: path.to_path_buf(),
        expected: expected.clone(),
        file,
    })
}

impl Staged {
    /// 原子替换的后一半：再校验一次目标没变，rename 换上去（预期不存在时不覆盖冒出来的文件）
    pub fn commit(self) -> io::Result<()> {
        self.commit_with(|| {})
    }

    fn commit_with(self, before_persist: impl FnOnce()) -> io::Result<()> {
        if !same(&self.path, &self.expected) {
            return Err(io::Error::other("changed"));
        }
        before_persist();
        match self.expected {
            FileState::Missing => self
                .file
                .persist_noclobber(&self.path)
                .map(|_| ())
                .map_err(|error| error.error),
            FileState::Present(_) => self
                .file
                .persist(&self.path)
                .map(|_| ())
                .map_err(|error| error.error),
        }
    }
}

/// 写配置文件没写成的种类（spec 2026-10-04-local-diagnostics R12）：给用户的原因按它说，
/// 原文（`Permission denied (os error 13)`）只进日志与详情
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteFailure {
    /// 写之前、或写临时文件之后发现目标被别人改过（`atomic_write` 的 `"changed"`、冒出来的文件）
    Changed,
    /// 磁盘满了（ENOSPC）
    DiskFull,
    /// 没有写入权限（EACCES、EPERM）
    NoPermission,
    /// 所在的卷是只读的（EROFS）
    ReadOnly,
    /// 别的原因（父目录是软链、IO 错误……）：调用处照旧说自己的那一句
    Other,
}

/// macOS 与 Linux 上同号的几个 errno（core 不依赖 libc）
const ENOSPC: i32 = 28;
const EACCES: i32 = 13;
const EPERM: i32 = 1;
const EROFS: i32 = 30;

/// 一次写入失败是哪一种（见 [`WriteFailure`]）
pub fn write_failure(e: &io::Error) -> WriteFailure {
    if e.kind() == io::ErrorKind::AlreadyExists
        || (e.kind() == io::ErrorKind::Other && e.to_string() == "changed")
    {
        return WriteFailure::Changed;
    }
    match e.raw_os_error() {
        Some(ENOSPC) => return WriteFailure::DiskFull,
        Some(EACCES | EPERM) => return WriteFailure::NoPermission,
        Some(EROFS) => return WriteFailure::ReadOnly,
        _ => {}
    }
    match e.kind() {
        io::ErrorKind::StorageFull => WriteFailure::DiskFull,
        io::ErrorKind::PermissionDenied => WriteFailure::NoPermission,
        io::ErrorKind::ReadOnlyFilesystem => WriteFailure::ReadOnly,
        _ => WriteFailure::Other,
    }
}

impl WriteFailure {
    /// 给用户的一句（当前语言，「…，未改动」）；`Other` 为 None，由调用处说它自己的那一句
    pub fn untouched(self) -> Option<String> {
        match self {
            WriteFailure::Changed => Some(crate::t!("common.write.changed")),
            WriteFailure::DiskFull => Some(crate::t!("common.write.diskFull")),
            WriteFailure::NoPermission => Some(crate::t!("common.write.noPermission")),
            WriteFailure::ReadOnly => Some(crate::t!("common.write.readOnly")),
            WriteFailure::Other => None,
        }
    }
}

/// 写 `path` 没写成时给用户的原因：四种说人话（[`WriteFailure::untouched`]）；分不出原因的为 None，
/// 由调用处只说它自己的失败句，不把系统原文当原因（spec #239「出错的时候」）。原文进日志并计数，
/// 界面有「!」的由调用处另把去隐私的原文放进去
pub fn write_failure_reason(path: &Path, e: &io::Error) -> Option<String> {
    log::warn!("write {} failed: {e}", path.display());
    crate::report::count_write_failure(e);
    write_failure(e).untouched()
}

/// 同 [`write_failure_reason`]，只是分不出原因时原样返回原文。只剩模型那几处在用
/// （`claude_models::desktop`、`gateway::app`，随 #271 改），新代码用 [`write_failure_reason`]
pub fn write_error_text(path: &Path, e: &io::Error) -> String {
    write_failure_reason(path, e).unwrap_or_else(|| e.to_string())
}

/// 备份 `path` 没做成时的原因：磁盘满、没权限、只读说「备份时…，未改动」；别的（含序号用尽的「已存在」）为 None，
/// 由调用处说它自己的那一句。原文进日志
pub fn backup_failure_text(path: &Path, e: &io::Error) -> Option<String> {
    log::warn!("备份 {} 失败：{e}", path.display());
    crate::report::count_write_failure(e);
    match write_failure(e) {
        WriteFailure::Changed | WriteFailure::Other => None,
        failure => failure
            .untouched()
            .map(|reason| crate::t!("common.write.whileBackingUp", reason = reason)),
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

    /// 某个原文件的备份目录里的 `.bak`，按名字排序（序号定宽，名字序即先后）
    fn baks(root: &Path, original: &Path) -> Vec<PathBuf> {
        let dir = backup_dir(root, original);
        let mut baks: Vec<PathBuf> = fs::read_dir(&dir)
            .expect("read_dir")
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "bak"))
            .collect();
        baks.sort();
        baks
    }

    #[test]
    fn backup_goes_to_the_backup_root_not_next_to_the_original() {
        let tree = TempTree::new();
        let project = tree.dir("project");
        let root = tree.root().join("data/backups");
        let path = project.join(".mcp.json");
        fs::write(&path, b"{\"secret\":1}").expect("write");

        let copy = backup(&path, &snapshot(&path), "mcp", &root).expect("backup");

        assert_eq!(names(&project), vec![".mcp.json"], "原文件旁边不留任何东西");
        assert!(copy.starts_with(&root));
        assert_eq!(copy.parent(), Some(backup_dir(&root, &path).as_path()));
        assert_eq!(fs::read(&copy).expect("read backup"), b"{\"secret\":1}");
        // 目录名带原文件名，便于人认；`source` 记着原文件的完整路径
        let folder = backup_dir(&root, &path);
        let folder_name = folder.file_name().unwrap().to_string_lossy().into_owned();
        assert!(folder_name.starts_with("mcp.json-"), "{folder_name}");
        assert_eq!(
            fs::read_to_string(folder.join("source")).expect("source"),
            format!("{}\n", path.display())
        );
        assert_eq!(fs::read(&path).expect("read"), b"{\"secret\":1}");
    }

    #[test]
    fn backups_of_same_named_files_do_not_collide() {
        let tree = TempTree::new();
        let root = tree.root().join("backups");
        let a = tree.dir("a").join(".mcp.json");
        let b = tree.dir("b").join(".mcp.json");
        fs::write(&a, b"a").expect("write");
        fs::write(&b, b"b").expect("write");

        let copy_a = backup(&a, &snapshot(&a), "mcp", &root).expect("a");
        let copy_b = backup(&b, &snapshot(&b), "mcp", &root).expect("b");

        assert_ne!(backup_dir(&root, &a), backup_dir(&root, &b));
        assert_eq!(fs::read(copy_a).expect("read"), b"a");
        assert_eq!(fs::read(copy_b).expect("read"), b"b");
        assert_eq!(baks(&root, &a).len(), 1);
        assert_eq!(baks(&root, &b).len(), 1);
    }

    #[test]
    fn backup_keeps_only_the_latest_ten_per_file() {
        let tree = TempTree::new();
        let root = tree.root().join("backups");
        let path = tree.dir("home").join("config.toml");
        let mut copies = Vec::new();
        for n in 0..12 {
            fs::write(&path, format!("v{n}")).expect("write");
            let suffix = if n % 2 == 0 { "mcp" } else { "models" };
            copies.push(backup(&path, &snapshot(&path), suffix, &root).expect("backup"));
        }

        let kept = baks(&root, &path);
        assert_eq!(kept.len(), BACKUP_KEEP);
        assert_eq!(kept, copies[2..].to_vec(), "删的是最早的两份");
        assert_eq!(fs::read(&copies[11]).expect("newest"), b"v11");
        assert_eq!(fs::read(&copies[2]).expect("oldest kept"), b"v2");
        assert!(!copies[0].exists() && !copies[1].exists());
    }

    #[test]
    fn backup_never_overwrites_an_existing_backup() {
        let tree = TempTree::new();
        let root = tree.root().join("backups");
        let path = tree.dir("home").join("config.toml");
        fs::write(&path, b"new").expect("write");
        let folder = backup_dir(&root, &path);
        fs::create_dir_all(&folder).expect("mkdir");
        fs::write(folder.join("000001-mcp.bak"), b"older backup").expect("write");

        let copy = backup(&path, &snapshot(&path), "mcp", &root).expect("backup");

        assert_eq!(copy, folder.join("000002-mcp.bak"));
        assert_eq!(
            fs::read(folder.join("000001-mcp.bak")).expect("read"),
            b"older backup"
        );
    }

    #[cfg(unix)]
    #[test]
    fn backups_are_private_and_writes_preserve_mode() {
        let tree = TempTree::new();
        let root = tree.root().join("data/backups");
        let path = tree.dir("home").join("config.toml");
        fs::write(&path, b"secret").expect("write");
        // 原文件对所有人可读，备份也只给自己读
        set_mode(&path, 0o644);
        let state = read_state(&path).expect("read_state");
        let FileState::Present(snap) = &state else {
            panic!("文件应当存在");
        };

        let copy = backup(&path, snap, "mcp", &root).expect("backup");
        atomic_write(&path, b"updated", &state).expect("write");

        assert_eq!(mode(&copy), 0o600);
        assert_eq!(mode(&backup_dir(&root, &path).join("source")), 0o600);
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&backup_dir(&root, &path)), 0o700);
        assert_eq!(mode(&path), 0o644);
        assert_eq!(fs::read(&path).expect("read"), b"updated");

        // 另一种权限也原样保留，证明不是临时文件默认的 0600 碰巧相同
        set_mode(&path, 0o600);
        let state = read_state(&path).expect("read_state");
        atomic_write(&path, b"again", &state).expect("write");
        assert_eq!(mode(&path), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn backup_refuses_a_symlinked_backup_folder() {
        let tree = TempTree::new();
        let root = tree.root().join("backups");
        let path = tree.dir("home").join("config.toml");
        fs::write(&path, b"x").expect("write");
        let elsewhere = tree.dir("elsewhere");
        fs::create_dir_all(&root).expect("mkdir");
        tree.link(&backup_dir(&root, &path), &elsewhere);

        assert!(backup(&path, &snapshot(&path), "mcp", &root).is_err());
        assert!(names(&elsewhere).is_empty());
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
        assert!(backup(
            &path,
            &snapshot(&other),
            "mcp",
            &tree.root().join("backups")
        )
        .is_err());
        assert!(atomic_write(&path, b"x", &FileState::Missing).is_err());
        assert!(names(&real).is_empty());
    }

    /// spec 2026-10-04-local-diagnostics R12：写失败按种类说原因，「被改过」与磁盘满、没权限、只读分开
    #[test]
    fn write_failure_tells_changed_from_disk_full_permission_and_read_only() {
        assert_eq!(
            write_failure(&io::Error::other("changed")),
            WriteFailure::Changed
        );
        // 预期不存在、两次校验之后才冒出来的文件：persist_noclobber 报 AlreadyExists，也是被别人改过
        assert_eq!(
            write_failure(&io::Error::from(io::ErrorKind::AlreadyExists)),
            WriteFailure::Changed
        );
        assert_eq!(
            write_failure(&io::Error::from_raw_os_error(28)),
            WriteFailure::DiskFull
        );
        assert_eq!(
            write_failure(&io::Error::from(io::ErrorKind::StorageFull)),
            WriteFailure::DiskFull
        );
        assert_eq!(
            write_failure(&io::Error::from_raw_os_error(13)),
            WriteFailure::NoPermission
        );
        assert_eq!(
            write_failure(&io::Error::from_raw_os_error(1)),
            WriteFailure::NoPermission
        );
        assert_eq!(
            write_failure(&io::Error::from_raw_os_error(30)),
            WriteFailure::ReadOnly
        );
        assert_eq!(
            write_failure(&io::Error::new(io::ErrorKind::InvalidInput, "symlink")),
            WriteFailure::Other
        );

        assert_eq!(
            WriteFailure::DiskFull.untouched().as_deref(),
            Some("磁盘已满，未改动")
        );
        assert_eq!(
            WriteFailure::NoPermission.untouched().as_deref(),
            Some("没有写入权限，未改动")
        );
        assert_eq!(
            WriteFailure::ReadOnly.untouched().as_deref(),
            Some("所在的磁盘是只读的，未改动")
        );
        assert_eq!(
            WriteFailure::Changed.untouched().as_deref(),
            Some("可能刚被别的程序改过，未改动")
        );
        assert_eq!(WriteFailure::Other.untouched(), None, "其他原因由调用处说");
    }

    /// #302：分不出原因时不把系统原文当原因交出去，由调用处说它自己的失败句
    #[test]
    fn 写入失败分不出原因时不交出原文() {
        let path = Path::new("/tmp/x.json");
        assert_eq!(
            write_failure_reason(path, &io::Error::from_raw_os_error(28)).as_deref(),
            Some("磁盘已满，未改动")
        );
        assert_eq!(
            write_failure_reason(path, &io::Error::other("symlink parent")),
            None
        );
    }

    /// 真的写不进去：目录只读时 atomic_write 的错误认得出是没权限（以 root 运行时权限不拦，跳过）
    #[cfg(unix)]
    #[test]
    fn write_into_read_only_directory_is_no_permission() {
        let tree = TempTree::new();
        let dir = tree.dir("home");
        let path = dir.join("config.toml");
        set_mode(&dir, 0o555);
        let probe = fs::write(dir.join("probe"), b"x");
        if probe.is_ok() {
            set_mode(&dir, 0o755);
            return;
        }
        let error = atomic_write(&path, b"a = 1\n", &FileState::Missing).expect_err("只读目录");
        set_mode(&dir, 0o755);
        assert_eq!(write_failure(&error), WriteFailure::NoPermission, "{error}");
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

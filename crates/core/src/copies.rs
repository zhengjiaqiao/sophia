//! Sophia 放进各 agent 的副本（spec #194，#201 / #203 / #204）。
//!
//! 给 agent 加 skill 一律建软链；只有这里建不了链接（文件系统不支持软链、Windows 建不了 junction，
//! `FailKind::LinkUnsupported`）时，`sync::execute` 自动改放一份原件的副本（`ActionKind::PlaceCopy`），
//! 结果与正常加上相同（产品负责人 2026-10-07：不按 agent 名单改用复制，同竞品）。Sophia 只认自己记下的副本：
//! 每份记进数据目录下的 `copies.json`（`CopyRecord`：在哪、对应哪份原件、放入时两边的内容指纹）；
//! 不往副本文件夹里放标记文件。认不出来的真实文件夹一律当作用户（agent）自己的，不碰。
//!
//! - 扫描判定：目标处是真实文件夹、且在记录里 → `CellState::Copied`（对用户和已链一样，前端按已链画）；
//!   发现阶段把记录在案的副本从「agent 自己的原件」里拿掉（`drop_copies`），不让它多成一行。
//! - 每次扫描前先对一遍账（`reconcile`）：副本不在了 / 不再是真实文件夹 → 删记录；副本被用户改过
//!   （现算指纹 ≠ 放入时的）→ 删记录、不再管理，此后它就是那个 agent 自己的 skill，按现有同名处理；
//!   副本没改、原件变了 → 用原件更新副本（`ActionKind::UpdateCopy`）。
//! - 放 / 更新都先复制到目标旁的临时目录，再改名到位；更新、移除时旧副本挪到它旁边暂存
//!   （`hold_beside`，同一个卷上一次改名；不进数据目录的暂存处——跨卷改名报 EXDEV），
//!   供撤销（`undo_update`、`restore`）与排障，用不着了由 `sweep_held` 移进废纸篓。
//! - 内容指纹复用市场的 `treehash::content_sha`：`.DS_Store`、`__pycache__` 这些杂项不算改动；
//!   复制时也不带上它们。
//!
//! - 移除（`remove`）：点格子取消、撤销安装、移除来源都走 `sync::execute` 的 Unlink，认出记录在案的副本后
//!   重校验没被改过，挪进暂存、删记录；被改过的不移除、删记录，交还给 agent。
//! - 删原件（`sync::delete_source_holding`）：它的副本默认一起挪进暂存（别处有同名的改成那一份的副本），
//!   同一次撤销；不一起删的删记录、交还给 agent。订阅推断与移除来源把副本与软链同样算（`skills::links_to`）。
//! - 共用文件夹（几个 agent 的目录是同一处）里的副本：记录按路径一条，扫描按路径认，共用它的各列都是 Copied。
use crate::fs::{entry_kind, normalize, real_path, same_real, EntryKind};
use crate::market::treehash::{content_sha, is_ignored};
use crate::models::*;
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

/// 一份 Sophia 放的副本
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyRecord {
    /// 副本所在：目标目录下的 `<skill>`
    pub path: PathBuf,
    /// 对应的原件（放入时原件的路径）
    pub source: PathBuf,
    /// 所在的目标目录（agent 的 skill 目录，认得出是哪个位置的哪个 agent）
    pub target: PathBuf,
    /// 放入（或最近一次更新）时原件的内容指纹；现算的不等于它＝原件变了
    pub source_sha: String,
    /// 放入（或最近一次更新）时副本自己的内容指纹；现算的不等于它＝副本被改过
    pub copy_sha: String,
    /// 放入（或最近一次更新）的时刻，Unix 毫秒
    pub placed_at: u64,
}

/// 读进来的副本记录，按副本的真实路径查
#[derive(Debug, Clone, Default)]
pub struct Copies {
    records: Vec<CopyRecord>,
    /// `key(record.path)` → 下标
    at: BTreeMap<PathBuf, usize>,
}

/// 查找键：副本在时用真实路径（两侧同源，macOS 的 /var 与 /private/var 不会错开），不在时退回标准化路径
fn key(path: &Path) -> PathBuf {
    real_path(path).unwrap_or_else(|| normalize(path))
}

impl Copies {
    pub fn new(records: Vec<CopyRecord>) -> Self {
        let at = records
            .iter()
            .enumerate()
            .map(|(i, r)| (key(&r.path), i))
            .collect();
        Copies { records, at }
    }

    /// 读 `copies.json`；没有这个文件是空的
    pub fn load(store: &Store) -> io::Result<Self> {
        store.load_copies().map(Self::new)
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn records(&self) -> &[CopyRecord] {
        &self.records
    }

    /// 记录在案、此刻仍是真实文件夹的 `original` 的副本（按路径排序）
    pub fn of(&self, original: &Path) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = self
            .records
            .iter()
            .filter(|r| entry_kind(&r.path) == EntryKind::Dir && same_real(&r.source, original))
            .map(|r| r.path.clone())
            .collect();
        out.sort();
        out
    }

    /// `path` 此刻是真实文件夹、且是记录在案的副本时，给出那条记录
    pub fn at(&self, path: &Path) -> Option<&CopyRecord> {
        if self.records.is_empty() || entry_kind(path) != EntryKind::Dir {
            return None;
        }
        self.at.get(&key(path)).map(|&i| &self.records[i])
    }
}

/// 发现阶段：记录在案的副本不是 agent 自己的原件。从各位置的 skill 里拿掉它们，拿空了的位置不再产出
/// （与 `discovery::sources` 一样：一个 skill 都没有的位置不出）。要在 `discovery::targets` 之前调
pub fn drop_copies(sources: &mut Vec<Source>, copies: &Copies) {
    if copies.is_empty() {
        return;
    }
    for source in sources.iter_mut() {
        source.skills.retain(|s| copies.at(&s.path).is_none());
    }
    sources.retain(|s| !s.skills.is_empty());
}

/// 放 / 更新副本没做成：io 失败（交给 `sync::io_failed` 分类说人话），或一句现成的原因
#[derive(Debug)]
pub(crate) enum CopyFail {
    Io {
        what: &'static str,
        path: PathBuf,
        error: io::Error,
    },
    Reason(String),
}

fn io_err(what: &'static str, path: &Path) -> impl FnOnce(io::Error) -> CopyFail {
    let path = path.to_path_buf();
    move |error| CopyFail::Io { what, path, error }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 读、改、写 `copies.json`，全程拿着写锁；没改就不写盘
fn edit<T>(store: &Store, f: impl FnOnce(&mut Vec<CopyRecord>) -> T) -> io::Result<T> {
    let _guard = store.lock_copies();
    let mut records = store.load_copies()?;
    let before = records.clone();
    let out = f(&mut records);
    if records != before {
        store.save_copies(&records)?;
    }
    Ok(out)
}

/// 记一条（同一处已有的替换掉）
fn put(store: &Store, record: CopyRecord) -> io::Result<()> {
    let k = key(&record.path);
    edit(store, |records| {
        records.retain(|r| key(&r.path) != k);
        records.push(record);
    })
}

/// 不再管理这一处：删掉它的记录（文件夹本身不动）
pub(crate) fn forget(store: &Store, path: &Path) -> io::Result<()> {
    let k = key(path);
    edit(store, |records| records.retain(|r| key(&r.path) != k))
}

/// 把 `from` 复制进 `to`（`to` 不存在，复制时建出来）：保留文件的权限位、文件夹里的软链照原样建
/// （Windows 上建不了就跟随着复制内容）；杂项（`treehash::is_ignored`：`.git`、`.DS_Store`、
/// `__pycache__`…）不带
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_ignored(&name.to_string_lossy()) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            copy_link(&src, &dst)?;
        } else if ty.is_dir() {
            copy_tree(&src, &dst)?;
        } else if ty.is_file() {
            std::fs::copy(&src, &dst)?;
        }
        // 其余（FIFO、套接字、设备）不是 skill 的内容，不复制（内容指纹也不算它们）
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
}

#[cfg(windows)]
fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    if src.is_dir() {
        copy_tree(src, dst)
    } else if src.is_file() {
        std::fs::copy(src, dst).map(|_| ())
    } else {
        // 坏链：没有内容可复制
        Ok(())
    }
}

/// 把原件复制到 `dest` 旁的临时目录（同一目录下，改名到位是一次改名），返回临时目录。
/// 以点开头：扫描与发现都不看隐藏项；复制失败时删掉临时目录（这是刚建的，删它不会碰到别的）
fn stage(source: &Path, dest: &Path) -> Result<PathBuf, CopyFail> {
    let parent = dest.parent().unwrap_or(Path::new("."));
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let tmp = parent.join(format!(".sophia-copy-{stamp}-{name}"));
    if let Err(e) = copy_tree(source, &tmp) {
        discard(&tmp);
        return Err(io_err("stage-copy", dest)(e));
    }
    Ok(tmp)
}

/// 暂存副本的名字前缀：`<副本所在目录>/.sophia-held-<纳秒时间戳>-<名字>`。
/// 放在副本旁边（同一目录＝同一个卷，挪过去是一次改名），不进数据目录的暂存处：
/// 副本可能在外置盘、网络盘上，跨卷改名报 EXDEV。以点开头，扫描与发现都不看；
/// 用不着了由 `sweep_held` 移进废纸篓
pub(crate) const HELD_PREFIX: &str = ".sophia-held-";

/// 把 `dest` 这份副本挪到它旁边暂存（`HELD_PREFIX`），返回暂存处。先重校验仍是真实文件夹
fn hold_beside(dest: &Path) -> io::Result<PathBuf> {
    if entry_kind(dest) != EntryKind::Dir {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            crate::t!("skills.sync.holdNotDir", path = dest.display()),
        ));
    }
    let parent = dest.parent().unwrap_or(Path::new("."));
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let held = parent.join(format!("{HELD_PREFIX}{stamp}-{name}"));
    // 改名会顶掉同名的空目录：已有东西就不挪
    if entry_kind(&held) != EntryKind::Missing {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(dest, &held)?;
    Ok(held)
}

/// 删掉自己刚建的临时目录或刚放到位的副本；只删真实文件夹
fn discard(path: &Path) {
    if entry_kind(path) == EntryKind::Dir {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// 给 `dest` 放一份 `source` 的副本并记下。`dest` 已有任何东西（文件夹、链接、断链）都不动；
/// 目标目录由调用方先建好（`sync::execute` 与建链同一步）。记不进记录就把刚放的副本删掉：
/// 没有记录的副本会被当成 agent 自己的，宁可这一格没做成
pub(crate) fn place(
    source: &Path,
    dest: &Path,
    target: &Path,
    store: &Store,
) -> Result<(), CopyFail> {
    if entry_kind(dest) != EntryKind::Missing {
        return Err(CopyFail::Reason(crate::t!("skills.sync.spotTaken")));
    }
    // 原件是真实文件夹（外部位置的原件路径已是解析后的真实路径）；不在了就不放。
    // 这里有意用跟随软链的 `is_dir()`：问的是原件的内容在不在，原件位置里的条目本身可以是链到别处的
    // 链接，复制、算指纹的都是它指到的内容（`copy_tree` 读根目录也跟随）。判断「这一处是什么」才用 lstat
    if !source.is_dir() {
        return Err(CopyFail::Reason(crate::t!("skills.sync.gone")));
    }
    let source_sha = content_sha(source).map_err(io_err("hash-source", source))?;
    let tmp = stage(source, dest)?;
    let copy_sha = match content_sha(&tmp) {
        Ok(sha) => sha,
        Err(e) => {
            discard(&tmp);
            return Err(io_err("hash-copy", dest)(e));
        }
    };
    if let Err(e) = std::fs::rename(&tmp, dest) {
        discard(&tmp);
        return Err(io_err("place-copy", dest)(e));
    }
    let record = CopyRecord {
        path: dest.to_path_buf(),
        source: source.to_path_buf(),
        target: target.to_path_buf(),
        source_sha,
        copy_sha,
        placed_at: now_ms(),
    };
    if let Err(e) = put(store, record) {
        discard(dest);
        return Err(io_err("record-copy", dest)(e));
    }
    log::info!(
        "放了一份副本：{}",
        crate::redact::redact(&dest.display().to_string())
    );
    Ok(())
}

/// 更新一份副本的撤销记录：换下来的旧副本暂存在哪、换之前的那条记录。
/// 由 `update` 产生；`undo_update` 用它把旧副本换回去
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyUndo {
    pub(crate) path: PathBuf,
    pub(crate) held: PathBuf,
    pub(crate) before: CopyRecord,
}

impl CopyUndo {
    /// 被更新的那份副本
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// `update` 做了什么
#[derive(Debug)]
pub(crate) enum Updated {
    /// 换成了原件此刻的内容
    Replaced(CopyUndo),
    /// 原件没变，不用换
    UpToDate,
    /// 副本被改过：删了记录，不再管理它（此后是那个 agent 自己的 skill）
    Released,
}

/// 用原件此刻的内容更新 `dest` 这份副本：必须仍在记录里、仍是真实文件夹、没被改过。
/// 先复制到旁边的临时目录，旧副本挪到旁边暂存（`hold_beside`），再把新的改名到位、改记录；
/// 后两步任一步失败都把旧副本放回原处
pub(crate) fn update(dest: &Path, store: &Store) -> Result<Updated, CopyFail> {
    replace(dest, None, store)
}

/// 删原件时别处有同名的另一份（`DeleteSourcePlan.relink_to`）：把 `dest` 这份副本换成 `to` 的内容、
/// 记录改为对应 `to`——与链接改指过去是同一件事。前提与做法同 `update`，旧副本进暂存，`undo_update` 换回
pub(crate) fn repoint(dest: &Path, to: &Path, store: &Store) -> Result<Updated, CopyFail> {
    replace(dest, Some(to), store)
}

/// `update` 与 `repoint` 的共同部分：`to` 为 None 时用记录里的原件，原件没变就不换
fn replace(dest: &Path, to: Option<&Path>, store: &Store) -> Result<Updated, CopyFail> {
    let records = store.load_copies().map_err(io_err("read-copies", dest))?;
    let k = key(dest);
    let Some(before) = records.into_iter().find(|r| key(&r.path) == k) else {
        return Err(CopyFail::Reason(crate::t!("skills.sync.notRecordedCopy")));
    };
    if entry_kind(dest) != EntryKind::Dir {
        return Err(CopyFail::Reason(crate::t!("skills.sync.gone")));
    }
    let current = content_sha(dest).map_err(io_err("hash-copy", dest))?;
    if current != before.copy_sha {
        forget(store, dest).map_err(io_err("record-copy", dest))?;
        log::info!(
            "副本被改过，不再管理：{}",
            crate::redact::redact(&dest.display().to_string())
        );
        return Ok(Updated::Released);
    }
    let source = to.unwrap_or(&before.source);
    // 有意跟随软链：问的是原件内容在不在，同 `place`
    if !source.is_dir() {
        return Err(CopyFail::Reason(crate::t!("skills.sync.gone")));
    }
    let source_sha = content_sha(source).map_err(io_err("hash-source", source))?;
    if to.is_none() && source_sha == before.source_sha {
        return Ok(Updated::UpToDate);
    }
    let tmp = stage(source, dest)?;
    let copy_sha = match content_sha(&tmp) {
        Ok(sha) => sha,
        Err(e) => {
            discard(&tmp);
            return Err(io_err("hash-copy", dest)(e));
        }
    };
    let held = match hold_beside(dest) {
        Ok(held) => held,
        Err(e) => {
            discard(&tmp);
            return Err(io_err("hold-copy", dest)(e));
        }
    };
    let put_old_back = |tmp: &Path| {
        discard(tmp);
        if entry_kind(dest) == EntryKind::Missing {
            let _ = std::fs::rename(&held, dest);
        }
    };
    if let Err(e) = std::fs::rename(&tmp, dest) {
        put_old_back(&tmp);
        return Err(io_err("place-copy", dest)(e));
    }
    let record = CopyRecord {
        source: source.to_path_buf(),
        source_sha,
        copy_sha,
        placed_at: now_ms(),
        ..before.clone()
    };
    if let Err(e) = put(store, record) {
        // 新的挪回临时目录再丢掉，旧的放回：记录没改，与旧副本对得上
        if std::fs::rename(dest, &tmp).is_ok() {
            put_old_back(&tmp);
        }
        return Err(io_err("record-copy", dest)(e));
    }
    log::info!(
        "原件变了，更新了副本：{}",
        crate::redact::redact(&dest.display().to_string())
    );
    Ok(Updated::Replaced(CopyUndo {
        path: dest.to_path_buf(),
        held,
        before,
    }))
}

/// `remove` 做了什么
#[derive(Debug)]
pub(crate) enum Removed {
    /// 挪到旁边暂存、删了记录（`restore` 放回）
    Held(CopyUndo),
    /// 副本被改过：没移除，删了记录，交还给 agent（不是失败）
    Released,
}

/// 移除 `dest` 这份副本：挪到它旁边暂存（`hold_beside`），删掉它的记录，返回撤销记录（`restore` 放回）。
/// 先重校验：仍在记录里、仍是真实文件夹、（给了 `original` 时）记录里对应的仍是这份原件；
/// 被改过（现算指纹 ≠ 放入时的）的不移除，删掉记录、不再管理——此后它是那个 agent 自己的 skill
/// （spec #194 修订：改过的按现有同名处理）
pub(crate) fn remove(
    dest: &Path,
    original: Option<&Path>,
    store: &Store,
) -> Result<Removed, CopyFail> {
    let not_ours = || CopyFail::Reason(crate::t!("skills.sync.notBodyLink"));
    let records = store.load_copies().map_err(io_err("read-copies", dest))?;
    let k = key(dest);
    let Some(before) = records.into_iter().find(|r| key(&r.path) == k) else {
        return Err(not_ours());
    };
    if entry_kind(dest) != EntryKind::Dir {
        return Err(CopyFail::Reason(crate::t!("skills.sync.gone")));
    }
    if original.is_some_and(|o| !same_real(&before.source, o)) {
        return Err(not_ours());
    }
    let current = content_sha(dest).map_err(io_err("hash-copy", dest))?;
    if current != before.copy_sha {
        forget(store, dest).map_err(io_err("record-copy", dest))?;
        log::info!(
            "副本被改过，不移除、不再管理：{}",
            crate::redact::redact(&dest.display().to_string())
        );
        return Ok(Removed::Released);
    }
    let held = hold_beside(dest).map_err(io_err("hold-copy", dest))?;
    if let Err(e) = forget(store, dest) {
        // 记录没删掉：放回原处，与记录对得上
        let _ = std::fs::rename(&held, dest);
        return Err(io_err("record-copy", dest)(e));
    }
    log::info!(
        "移除了一份副本：{}",
        crate::redact::redact(&dest.display().to_string())
    );
    Ok(Removed::Held(CopyUndo {
        path: dest.to_path_buf(),
        held,
        before,
    }))
}

/// 撤销「不再管理」：这一处仍是真实文件夹、内容与那条记录放入时一致、也没有别的记录时，把记录放回。
/// 不一致（这期间被改过）就不放回，它仍是 agent 自己的
pub(crate) fn readopt(record: &CopyRecord, store: &Store) {
    let unchanged = entry_kind(&record.path) == EntryKind::Dir
        && content_sha(&record.path).is_ok_and(|sha| sha == record.copy_sha);
    if !unchanged {
        return;
    }
    let k = key(&record.path);
    let done = edit(store, |records| {
        if !records.iter().any(|r| key(&r.path) == k) {
            records.push(record.clone());
        }
    });
    if let Err(e) = done {
        log::warn!("副本记录没放回：{e}");
    }
}

/// 撤销一次移除：把暂存的副本放回原处、记录恢复。原处已被占、暂存的不在了就不动、如实上报
pub(crate) fn restore(undo: &CopyUndo, store: &Store) -> Result<(), CopyFail> {
    if entry_kind(&undo.path) != EntryKind::Missing {
        return Err(CopyFail::Reason(crate::t!("skills.sync.linkSpotTaken")));
    }
    if entry_kind(&undo.held) != EntryKind::Dir {
        return Err(CopyFail::Reason(crate::t!("skills.sync.gone")));
    }
    std::fs::rename(&undo.held, &undo.path).map_err(io_err("put-back-copy", &undo.path))?;
    if let Err(e) = put(store, undo.before.clone()) {
        // 记不回去：没有记录的副本会被当成 agent 自己的，挪回暂存
        let _ = std::fs::rename(&undo.path, &undo.held);
        return Err(io_err("record-copy", &undo.path)(e));
    }
    Ok(())
}

/// 撤销一次副本更新：把换下来的旧副本放回原处、记录恢复成更新前那条。现场变了（副本之后又被改过、
/// 不在了，暂存的旧副本不在了）就不动、如实上报。换下来的新副本进暂存。
/// 原件若仍是新内容，下一次扫描对账还会再更新——撤销是给排障、手滑改了原件又改回来时用的
pub fn undo_update(undo: &CopyUndo, store: &Store) -> ReportEntry {
    let action = PlannedAction {
        kind: ActionKind::UpdateCopy,
        item_name: undo
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        source_path: undo.held.clone(),
        target_path: undo.path.clone(),
        target: undo.before.target.clone(),
    };
    let mut fail_kind = None;
    let mut detail = None;
    let outcome = match undo_update_inner(undo, store) {
        Ok(()) => Outcome::Created,
        Err(fail) => fail.into_outcome(&mut fail_kind, &mut detail),
    };
    ReportEntry {
        action,
        outcome,
        fail_kind,
        detail,
    }
}

fn undo_update_inner(undo: &CopyUndo, store: &Store) -> Result<(), CopyFail> {
    if entry_kind(&undo.held) != EntryKind::Dir {
        return Err(CopyFail::Reason(crate::t!("skills.sync.heldGone")));
    }
    let k = key(&undo.path);
    let now = store
        .load_copies()
        .map_err(io_err("read-copies", &undo.path))?
        .into_iter()
        .find(|r| key(&r.path) == k);
    let unchanged = now.is_some_and(|r| {
        entry_kind(&undo.path) == EntryKind::Dir
            && content_sha(&undo.path).is_ok_and(|sha| sha == r.copy_sha)
    });
    if !unchanged {
        return Err(CopyFail::Reason(crate::t!("skills.sync.changedSince")));
    }
    let newer = hold_beside(&undo.path).map_err(io_err("hold-copy", &undo.path))?;
    if let Err(e) = std::fs::rename(&undo.held, &undo.path) {
        let _ = std::fs::rename(&newer, &undo.path);
        return Err(io_err("put-back-copy", &undo.path)(e));
    }
    put(store, undo.before.clone()).map_err(io_err("record-copy", &undo.path))
}

/// 暂存的副本多久没人要就收走（`sweep_held`）。取消副本格、对账更新换下的那份都不给撤销，
/// 删原件的撤销记着的那份由调用方放进 `keep`；这段时间只是给排障和正在进行的回滚留余地
pub const HELD_GRACE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// 扫描收尾：`dirs`（各列的目录）里暂存的副本（`HELD_PREFIX`），暂存超过 `older_than` 的、
/// 不在 `keep` 里的移进废纸篓（先放回原名的位置再移，同 `sync::release_held`：访达的「放回原处」
/// 才回得去，隐藏的名字在废纸篓里也看不见）。同一个目录只看一遍。返回没收成的（如实上报）
pub fn sweep_held(
    dirs: &[PathBuf],
    keep: &[PathBuf],
    older_than: std::time::Duration,
) -> Vec<(PathBuf, String)> {
    sweep_held_with(dirs, keep, older_than, &crate::sync::trash)
}

/// 同 `sweep_held`，移进废纸篓这一步可替换（测试不碰系统废纸篓）
pub(crate) fn sweep_held_with(
    dirs: &[PathBuf],
    keep: &[PathBuf],
    older_than: std::time::Duration,
    trash: &dyn Fn(&Path) -> io::Result<()>,
) -> Vec<(PathBuf, String)> {
    let cutoff = std::time::SystemTime::now()
        .checked_sub(older_than)
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let keep: BTreeSet<PathBuf> = keep.iter().map(|p| key(p)).collect();
    let mut seen = BTreeSet::new();
    let mut failed = Vec::new();
    for dir in dirs {
        if !seen.insert(key(dir)) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        for item in rd.flatten().map(|e| e.path()) {
            let Some((stamp, name)) = item
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix(HELD_PREFIX))
                .and_then(|rest| rest.split_once('-'))
                .and_then(|(stamp, name)| Some((stamp.parse::<u128>().ok()?, name.to_string())))
            else {
                continue;
            };
            if stamp > cutoff || entry_kind(&item) != EntryKind::Dir || keep.contains(&key(&item)) {
                continue;
            }
            if let Err(e) = crate::sync::release_one(&item, Some(&dir.join(&name)), trash) {
                let reason = crate::sync::io_fail("release-held-copy", &item, &e).reason;
                failed.push((item, reason));
            }
        }
    }
    failed
}

impl CopyFail {
    /// 变成执行报告里的结果：io 失败按类别说人话、记下原文（`sync::io_failed`），原因句原样
    pub(crate) fn into_outcome(
        self,
        fail_kind: &mut Option<FailKind>,
        detail: &mut Option<String>,
    ) -> Outcome {
        match self {
            CopyFail::Io { what, path, error } => {
                crate::sync::io_failed(what, &path, &error, fail_kind, detail)
            }
            CopyFail::Reason(reason) => Outcome::Failed(reason),
        }
    }
}

/// 一次对账的结果：更新了哪些副本（`UpdateCopy` 的逐项报告）与它们的撤销记录、不再管理的副本
#[derive(Debug, Default)]
pub struct Reconciled {
    pub report: SyncReport,
    pub undos: Vec<CopyUndo>,
    /// 删掉了记录的副本：不在了、不再是真实文件夹，或被用户改过（此后是 agent 自己的）
    pub released: Vec<PathBuf>,
}

/// 每次扫描前对一遍账（只动记录在案的副本，别的一概不碰）：
/// - 副本不在了、不再是真实文件夹 → 删记录；
/// - 副本被改过（现算指纹 ≠ 放入时的）→ 删记录，不再管理（不覆盖用户的改动）；
/// - 副本没改、原件变了 → 用原件更新副本（旧副本进暂存，可 `undo_update`）；
/// - 原件不在了 → 先不动（经 Sophia 删原件时副本已一并处理，见 `sync::delete_source_holding`）。
///
/// 读不了记录文件时报错；单份副本算不出指纹（读不了）跳过它，不拦别的
pub fn reconcile(store: &Store) -> io::Result<Reconciled> {
    let records = store.load_copies()?;
    let mut out = Reconciled::default();
    let mut stale = Vec::new();
    let mut changed = Vec::new();
    for r in &records {
        if entry_kind(&r.path) != EntryKind::Dir {
            stale.push(r.path.clone());
            continue;
        }
        match content_sha(&r.path) {
            Ok(sha) if sha != r.copy_sha => {
                stale.push(r.path.clone());
                continue;
            }
            Ok(_) => {}
            Err(_) => continue,
        }
        // 有意跟随软链：问的是原件内容在不在，同 `place`
        if r.source.is_dir() && content_sha(&r.source).is_ok_and(|sha| sha != r.source_sha) {
            changed.push(r.clone());
        }
    }
    if !stale.is_empty() {
        let keys: Vec<PathBuf> = stale.iter().map(|p| key(p)).collect();
        edit(store, |records| {
            records.retain(|r| !keys.contains(&key(&r.path)))
        })?;
        for path in &stale {
            log::info!(
                "副本不在了或被改过，不再管理：{}",
                crate::redact::redact(&path.display().to_string())
            );
        }
        out.released = stale;
    }
    for r in changed {
        let action = PlannedAction {
            kind: ActionKind::UpdateCopy,
            item_name: r
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            source_path: r.source.clone(),
            target_path: r.path.clone(),
            target: r.target.clone(),
        };
        let mut fail_kind = None;
        let mut detail = None;
        let outcome = match update(&r.path, store) {
            Ok(Updated::Replaced(undo)) => {
                out.undos.push(undo);
                Outcome::Created
            }
            Ok(Updated::UpToDate) => Outcome::Skipped,
            Ok(Updated::Released) => {
                out.released.push(r.path.clone());
                Outcome::Skipped
            }
            Err(fail) => fail.into_outcome(&mut fail_kind, &mut detail),
        };
        out.report.entries.push(ReportEntry {
            action,
            outcome,
            fail_kind,
            detail,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{self, Env};
    use crate::skills::{self, auto_link_cells, propose_links, propose_unlinks, scan};
    use crate::subscriptions::Subscriptions;
    use crate::sync;
    use crate::test_support::TempTree;
    use std::collections::{BTreeSet, HashMap};

    /// 临时 HOME：通用仓库 `~/.agents/skills` 里一个原件 `a`（带一个脚本），
    /// 装着 Claude Code 与 Continue；数据目录在 `data`。副本由 `place` 放：Continue 的目录建不了链接
    /// （模拟文件系统回「不支持」）
    struct Lab {
        t: TempTree,
        home: PathBuf,
        store: Store,
    }

    impl Lab {
        fn new() -> Self {
            let t = TempTree::new();
            let home = t.dir("home");
            let a = t.skill("home/.agents/skills/a");
            std::fs::write(a.join("run.sh"), "echo v1\n").unwrap();
            t.dir("home/.claude/skills");
            t.dir("home/.continue/skills");
            let store = Store::new(t.dir("data"));
            Lab { t, home, store }
        }

        fn env(&self) -> Env {
            Env {
                apps: Vec::new(),
                home: self.home.clone(),
                vars: HashMap::new(),
            }
        }

        fn original(&self, name: &str) -> PathBuf {
            self.home.join(".agents/skills").join(name)
        }

        fn copy(&self, name: &str) -> PathBuf {
            self.home.join(".continue/skills").join(name)
        }

        /// 与命令层 `discover` 同一条路：发现原件位置 → 拿掉记录在案的副本 → 目标
        fn discover(&self) -> (Vec<Source>, Vec<Target>) {
            let env = self.env();
            let hs: Vec<Harness> = discovery::all_harnesses(&env)
                .into_iter()
                .filter(|h| ["claude-code", "continue"].contains(&h.id.as_str()))
                .collect();
            let mut sources = discovery::sources(&env, &hs, &[], &[]);
            drop_copies(&mut sources, &self.copies());
            let targets = discovery::targets(&env, &hs, &[], &sources);
            (sources, targets)
        }

        fn copies(&self) -> Copies {
            Copies::load(&self.store).unwrap()
        }

        fn overview(&self) -> Overview {
            let (sources, targets) = self.discover();
            scan(&sources, &targets, &Subscriptions::new(), &self.copies())
        }

        /// 点格子：这一格的动作出计划、执行（与命令层 `apply_all` 同一个执行器、同一份记录）
        fn click(&self, skill: &str, target_id: &str) -> SyncReport {
            self.click_with(skill, target_id, &crate::fs::create_link)
        }

        /// 点格子，但这里建不了链接：执行器自动改放副本
        fn place(&self, skill: &str, target_id: &str) -> SyncReport {
            self.click_with(skill, target_id, &unsupported)
        }

        /// 点格子，建链这一步换成 `link`（模拟文件系统的回应）
        fn click_with(
            &self,
            skill: &str,
            target_id: &str,
            link: &dyn Fn(&Path, &Path, LinkStyle) -> io::Result<()>,
        ) -> SyncReport {
            let (sources, targets) = self.discover();
            let source = sources
                .iter()
                .find(|s| s.kind == SourceKind::Universal)
                .unwrap();
            let cell = CellRef {
                source_id: source.id.clone(),
                skill: skill.into(),
                target_id: target_id.into(),
            };
            let actions = propose_links(&sources, &targets, &[cell]);
            sync::execute_with(
                &actions,
                false,
                LinkStyle::Absolute,
                Some(&self.store),
                link,
            )
        }

        /// 点已加上的格取消：出撤链动作（与命令层 `propose_unlinks` 同一份副本记录）
        fn unlink_actions(&self, skill: &str, target_id: &str) -> Vec<PlannedAction> {
            let (sources, targets) = self.discover();
            let source = sources
                .iter()
                .find(|s| s.kind == SourceKind::Universal)
                .unwrap();
            let cell = CellRef {
                source_id: source.id.clone(),
                skill: skill.into(),
                target_id: target_id.into(),
            };
            let actions = propose_unlinks(&sources, &targets, &[cell], &self.copies());
            assert_eq!(actions.len(), 1);
            actions
        }

        fn unclick(&self, skill: &str, target_id: &str) -> SyncReport {
            let actions = self.unlink_actions(skill, target_id);
            sync::execute(&actions, false, LinkStyle::Absolute, Some(&self.store))
        }

        fn cell(&self, skill: &str, target_id: &str) -> Cell {
            let ov = self.overview();
            ov.domains[0]
                .rows
                .iter()
                .find(|r| r.skill == skill && r.source_id.ends_with(".agents/skills"))
                .unwrap()
                .cells
                .iter()
                .find(|c| c.target_id == target_id)
                .unwrap()
                .clone()
        }

        fn rows_named(&self, skill: &str) -> usize {
            self.overview().domains[0]
                .rows
                .iter()
                .filter(|r| r.skill == skill)
                .count()
        }
    }

    /// 文件系统回「不支持」的建链：这里建不了链接
    fn unsupported(_: &Path, _: &Path, _: LinkStyle) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    /// `dir` 里暂存的副本（`.sophia-held-*`）
    fn held_beside(dir: &Path) -> Vec<PathBuf> {
        let mut held: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(".sophia-held-"))
            })
            .collect();
        held.sort();
        held
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    /// 不按 agent 名单改用复制（产品负责人 2026-10-07）：曾核实读不到软链的四家照样建软链，不放副本、不记
    #[test]
    fn 四家也建软链_只有建不了链接才放副本() {
        let lab = Lab::new();
        let report = lab.click("a", "continue");
        assert_eq!(report.entries[0].action.kind, ActionKind::Create);
        assert_eq!(report.entries[0].outcome, Outcome::Created);
        assert!(matches!(entry_kind(&lab.copy("a")), EntryKind::Symlink(_)));
        assert!(lab.store.load_copies().unwrap().is_empty());
        assert_eq!(lab.cell("a", "continue").state, CellState::Linked);
        // 共用文件夹里的 Antigravity 出的也是建链动作
        let s = Shared::new();
        assert_eq!(s.propose(&["antigravity"])[0].kind, ActionKind::Create);
    }

    /// 给 Continue 加、它的目录建不了链接：磁盘上是真实文件夹（内容同原件），记录里一条；
    /// 给 Claude Code 加照旧是软链
    #[test]
    fn 建不了链接时放真实文件夹并记一条() {
        let lab = Lab::new();
        let report = lab.place("a", "continue");
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].action.kind, ActionKind::PlaceCopy);
        assert_eq!(report.entries[0].outcome, Outcome::Created);

        let copy = lab.copy("a");
        assert_eq!(entry_kind(&copy), EntryKind::Dir);
        assert_eq!(read(&copy.join("run.sh")), "echo v1\n");
        assert!(copy.join("SKILL.md").is_file());
        let records = lab.store.load_copies().unwrap();
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.path, copy);
        assert_eq!(r.source, lab.original("a"));
        assert_eq!(r.target, lab.home.join(".continue/skills"));
        assert_eq!(r.source_sha, content_sha(&lab.original("a")).unwrap());
        assert_eq!(r.copy_sha, content_sha(&copy).unwrap());
        assert!(r.placed_at > 0);
        // 目标旁的临时目录不留下
        let left: Vec<String> = std::fs::read_dir(lab.home.join(".continue/skills"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["a".to_string()]);

        let linked = lab.click("a", "claude-code");
        assert_eq!(linked.entries[0].action.kind, ActionKind::Create);
        assert!(matches!(
            entry_kind(&lab.home.join(".claude/skills/a")),
            EntryKind::Symlink(_)
        ));
        assert_eq!(lab.store.load_copies().unwrap().len(), 1);
    }

    /// 扫描：记录在案的副本是 Copied（落点是原件），不在 Continue 名下多成一行，也不进「agent 自己的」；
    /// 不在记录里的真实文件夹照旧是同名占位
    #[test]
    fn 扫描认出副本_不多一行_不在记录的真目录仍是同名占位() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let cell = lab.cell("a", "continue");
        assert_eq!(cell.state, CellState::Copied);
        assert_eq!(cell.points_to, real_path(&lab.original("a")));
        assert_eq!(lab.rows_named("a"), 1, "副本不该在 Continue 名下多成一行");
        let ov = lab.overview();
        assert!(ov.domains[0].agent_copies.is_empty());
        assert!(!ov
            .sources
            .iter()
            .any(|s| s.skills.iter().any(|k| k.path == lab.copy("a"))));

        // 用户自己放进 Continue 的同名文件夹：不认，照旧
        lab.t.skill("home/.agents/skills/b");
        lab.t.skill("home/.continue/skills/b");
        assert_eq!(lab.cell("b", "continue").state, CellState::Duplicate);
        assert_eq!(lab.rows_named("b"), 2);
    }

    /// 别的原件同名的那一行：这里放的是 a 那份的副本，和软链指向别处一样是 Foreign，落点说得出是哪份
    #[test]
    fn 别的原件那一行上_副本格是指向别处() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let other = lab.t.skill("elsewhere/a");
        let (mut sources, targets) = lab.discover();
        sources.push(Source {
            id: other.parent().unwrap().display().to_string(),
            path: other.parent().unwrap().to_path_buf(),
            kind: SourceKind::Manual,
            label: "elsewhere".into(),
            skills: vec![Skill {
                name: "a".into(),
                path: other.clone(),
                description: None,
            }],
        });
        let subs = Subscriptions::from([(
            skills::domain_key(&targets[0].scope),
            BTreeSet::from([other.parent().unwrap().to_path_buf()]),
        )]);
        let ov = scan(&sources, &targets, &subs, &lab.copies());
        let row = ov.domains[0]
            .rows
            .iter()
            .find(|r| r.skill == "a" && r.source_id.ends_with("elsewhere"))
            .unwrap();
        let cell = row
            .cells
            .iter()
            .find(|c| c.target_id == "continue")
            .unwrap();
        assert_eq!(cell.state, CellState::Foreign);
        assert_eq!(cell.points_to, real_path(&lab.original("a")));
    }

    /// 原件改了、副本没动：对账时用原件更新副本，旧副本进暂存；撤销换回旧的、记录复原
    #[test]
    fn 原件改了_对账自动更新副本_可撤销() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let before = lab.store.load_copies().unwrap()[0].clone();
        std::fs::write(lab.original("a").join("run.sh"), "echo v2\n").unwrap();

        let done = reconcile(&lab.store).unwrap();
        assert_eq!(done.report.entries.len(), 1);
        assert_eq!(done.report.entries[0].action.kind, ActionKind::UpdateCopy);
        assert_eq!(done.report.entries[0].outcome, Outcome::Created);
        assert!(done.released.is_empty());
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo v2\n");
        let after = lab.store.load_copies().unwrap()[0].clone();
        assert_eq!(after.source_sha, content_sha(&lab.original("a")).unwrap());
        assert_eq!(after.copy_sha, content_sha(&lab.copy("a")).unwrap());
        assert_ne!(after.copy_sha, before.copy_sha);
        // 旧副本在暂存处
        let undo = &done.undos[0];
        assert_eq!(undo.path(), lab.copy("a"));
        assert_eq!(undo.held.parent(), lab.copy("a").parent());
        assert_eq!(read(&undo.held.join("run.sh")), "echo v1\n");
        assert_eq!(lab.cell("a", "continue").state, CellState::Copied);

        // 再对一次账：没有可做的
        assert!(reconcile(&lab.store).unwrap().report.entries.is_empty());

        let back = undo_update(undo, &lab.store);
        assert_eq!(back.outcome, Outcome::Created);
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo v1\n");
        assert_eq!(lab.store.load_copies().unwrap(), vec![before]);
        assert_eq!(entry_kind(&undo.held), EntryKind::Missing);
        // 撤销用过一次就没了：暂存的旧副本已经放回去
        assert_eq!(undo_update(undo, &lab.store).outcome, {
            Outcome::Failed(crate::t!("skills.sync.heldGone"))
        });
    }

    /// 副本被用户改过：对账时不覆盖、删掉记录，此后它是 Continue 自己的——多出一行，原件那一行的格是同名占位
    #[test]
    fn 副本被改过_删记录不覆盖_变成agent自己的() {
        let lab = Lab::new();
        lab.place("a", "continue");
        std::fs::write(lab.copy("a").join("run.sh"), "echo mine\n").unwrap();
        std::fs::write(lab.original("a").join("run.sh"), "echo v2\n").unwrap();

        let done = reconcile(&lab.store).unwrap();
        assert!(done.report.entries.is_empty(), "改过的副本不更新");
        assert_eq!(done.released, vec![lab.copy("a")]);
        assert!(lab.store.load_copies().unwrap().is_empty());
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo mine\n");

        assert_eq!(lab.cell("a", "continue").state, CellState::Duplicate);
        assert_eq!(lab.rows_named("a"), 2, "Continue 自己的那份成了一行");
    }

    /// 杂项（`.DS_Store`、`__pycache__`）出现在副本或原件里都不算改动；复制时也不带上原件里的杂项
    #[test]
    fn 杂项文件不算改动() {
        let lab = Lab::new();
        std::fs::write(lab.original("a").join(".DS_Store"), "finder").unwrap();
        lab.t.dir("home/.agents/skills/a/__pycache__");
        std::fs::write(lab.original("a").join("__pycache__/x.pyc"), "bytes").unwrap();
        lab.place("a", "continue");
        assert_eq!(
            entry_kind(&lab.copy("a").join(".DS_Store")),
            EntryKind::Missing
        );
        assert_eq!(
            entry_kind(&lab.copy("a").join("__pycache__")),
            EntryKind::Missing
        );
        let before = lab.store.load_copies().unwrap();

        std::fs::write(lab.copy("a").join(".DS_Store"), "finder").unwrap();
        lab.t.dir("home/.continue/skills/a/__pycache__");
        std::fs::write(lab.copy("a").join("__pycache__/y.pyc"), "bytes").unwrap();
        std::fs::write(lab.original("a").join("__pycache__/z.pyc"), "more").unwrap();

        let done = reconcile(&lab.store).unwrap();
        assert!(done.report.entries.is_empty());
        assert!(done.released.is_empty());
        assert_eq!(lab.store.load_copies().unwrap(), before);
        assert_eq!(lab.cell("a", "continue").state, CellState::Copied);
    }

    /// 副本被删掉、或换成了别的东西（链接）：删记录；那一格回到没加 / 指向别处
    #[test]
    fn 副本不在了_删记录() {
        let lab = Lab::new();
        lab.place("a", "continue");
        std::fs::remove_dir_all(lab.copy("a")).unwrap();
        let done = reconcile(&lab.store).unwrap();
        assert_eq!(done.released, vec![lab.copy("a")]);
        assert!(lab.store.load_copies().unwrap().is_empty());
        assert_eq!(lab.cell("a", "continue").state, CellState::Missing);
    }

    /// 自动同步（订阅规则补新 skill）一律出建链动作；Continue 那里建不了链接时同样改放副本、记一条，
    /// 最近一次自动执行照样算上它
    #[test]
    fn 自动同步碰上建不了链接也放副本() {
        let lab = Lab::new();
        let (sources, targets) = lab.discover();
        let rule = AutoLink {
            source: normalize(&lab.home.join(".agents/skills")),
            targets: vec!["continue".into(), "claude-code".into()],
            target_excluded: Default::default(),
            baseline: Some(BTreeSet::new()),
            target_baselines: Default::default(),
            last_auto: Default::default(),
        };
        let mut rules = vec![rule];
        let cells = auto_link_cells(&sources, &targets, &rules);
        let actions = propose_links(&sources, &targets, &cells);
        assert!(actions.iter().all(|a| a.kind == ActionKind::Create));
        let continue_dir = lab.home.join(".continue/skills");
        let link = |src: &Path, at: &Path, style: LinkStyle| {
            if at.starts_with(&continue_dir) {
                unsupported(src, at, style)
            } else {
                crate::fs::create_link(src, at, style)
            }
        };
        let report = sync::execute_with(
            &actions,
            false,
            LinkStyle::Absolute,
            Some(&lab.store),
            &link,
        );
        assert!(report.entries.iter().all(|e| e.outcome == Outcome::Created));
        assert_eq!(entry_kind(&lab.copy("a")), EntryKind::Dir);
        assert_eq!(lab.store.load_copies().unwrap().len(), 1);
        assert!(skills::record_auto_runs(
            &mut rules, &sources, &targets, &report, 7
        ));
        assert_eq!(rules[0].last_auto.get("global").map(|r| r.added), Some(2));
    }

    /// 取消副本格：出 Unlink，执行时副本挪进暂存、记录删掉，格子回到没加；
    /// 撤销（再点一下＝再放一份）照常放回，内容同原件
    #[test]
    fn 取消副本格_挪进暂存_可再放回() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let report = lab.unclick("a", "continue");
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].outcome, Outcome::Removed);
        assert_eq!(entry_kind(&lab.copy("a")), EntryKind::Missing);
        assert!(lab.store.load_copies().unwrap().is_empty());
        // 暂存在副本旁边（同一个卷，一次改名；跨卷挪进数据目录会报 EXDEV），数据目录的暂存处不用
        let held = held_beside(&lab.home.join(".continue/skills"));
        assert_eq!(held.len(), 1);
        assert!(!lab.store.held_dir().exists());
        assert_eq!(read(&held[0].join("run.sh")), "echo v1\n");
        assert_eq!(lab.cell("a", "continue").state, CellState::Missing);

        let back = lab.place("a", "continue");
        assert_eq!(back.entries[0].outcome, Outcome::Created);
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo v1\n");
        assert_eq!(lab.cell("a", "continue").state, CellState::Copied);
    }

    /// 假的废纸篓：移进 `bin` 下，记下移的时候它在哪（测试不碰系统废纸篓）
    fn fake_bin(bin: &Path) -> impl Fn(&Path) -> io::Result<()> + '_ {
        let n = std::cell::Cell::new(0);
        move |p: &Path| {
            n.set(n.get() + 1);
            let to = bin.join(n.get().to_string());
            std::fs::create_dir_all(&to)?;
            std::fs::write(to.join("from"), p.to_string_lossy().as_bytes())?;
            std::fs::rename(p, to.join("item"))
        }
    }

    /// 暂存在副本旁边的那份没人要了（取消副本格没有撤销、对账更新的撤销不往外给）：扫描收尾时
    /// 超过一段时间的移进废纸篓——先放回原名的位置再移，废纸篓里看得见、「放回原处」回得去；
    /// 还没到时间的、删原件的撤销还用得着的（`keep`）不动
    #[test]
    fn 暂存的副本过时移进废纸篓_撤销用得着的不动() {
        let lab = Lab::new();
        let dir = lab.home.join(".continue/skills");
        lab.place("a", "continue");
        lab.unclick("a", "continue");
        let held = held_beside(&dir);
        assert_eq!(held.len(), 1);
        let bin = lab.t.dir("bin");
        let trash = fake_bin(&bin);

        // 没到时间：不动
        let hour = std::time::Duration::from_secs(3600);
        assert!(sweep_held_with(std::slice::from_ref(&dir), &[], hour, &trash).is_empty());
        assert_eq!(held_beside(&dir), held);
        // 撤销用得着：不动
        let zero = std::time::Duration::ZERO;
        assert!(sweep_held_with(std::slice::from_ref(&dir), &held, zero, &trash).is_empty());
        assert_eq!(held_beside(&dir), held);
        // 过时：放回原名的位置再移进废纸篓
        assert!(sweep_held_with(std::slice::from_ref(&dir), &[], zero, &trash).is_empty());
        assert!(held_beside(&dir).is_empty());
        assert_eq!(entry_kind(&lab.copy("a")), EntryKind::Missing);
        assert_eq!(
            read(&bin.join("1/from")),
            lab.copy("a").display().to_string()
        );
        assert_eq!(read(&bin.join("1/item/run.sh")), "echo v1\n");

        // 删原件的撤销记着的那份副本：`held_copies` 交出来，扫描收尾不动它
        lab.place("a", "continue");
        let plan = plan_delete(&lab, &[]);
        let hold = lab.t.dir("app-held");
        let (_, undo) = sync::delete_source_holding(&plan, Some(&hold), Some(&lab.store));
        let undo = undo.unwrap();
        assert_eq!(undo.held_copies(), held_beside(&dir));
        assert!(sweep_held_with(
            std::slice::from_ref(&dir),
            &undo.held_copies(),
            zero,
            &trash
        )
        .is_empty());
        let back = sync::undo_delete(&undo, Some(&lab.store));
        assert!(
            back.entries.iter().all(|e| e.outcome == Outcome::Created),
            "{back:?}"
        );
    }

    /// 出计划之后副本被用户改过：不移除、删掉记录（此后它是 Continue 自己的，下次扫描多出一行）。
    /// 这不是失败（交还给 agent 了），结果是跳过、不带失败类别，不出失败提示
    #[test]
    fn 取消前副本被改过_不移除_变成agent自己的() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let actions = lab.unlink_actions("a", "continue");
        std::fs::write(lab.copy("a").join("run.sh"), "echo mine\n").unwrap();
        let report = sync::execute(&actions, false, LinkStyle::Absolute, Some(&lab.store));
        assert_eq!(report.entries[0].outcome, Outcome::Skipped);
        assert_eq!(report.entries[0].fail_kind, None);
        assert!(held_beside(&lab.home.join(".continue/skills")).is_empty());
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo mine\n");
        assert!(lab.store.load_copies().unwrap().is_empty());
        assert_eq!(lab.cell("a", "continue").state, CellState::Duplicate);
        assert_eq!(lab.rows_named("a"), 2);
    }

    /// 删原件的体检：这份原件记录在案的副本列进计划
    fn plan_delete(lab: &Lab, extra: &[Source]) -> DeleteSourcePlan {
        let (mut sources, targets) = lab.discover();
        sources.extend_from_slice(extra);
        let skill = sources
            .iter()
            .find(|s| s.kind == SourceKind::Universal)
            .unwrap()
            .skills[0]
            .clone();
        skills::plan_delete_source(&skill, &sources, &targets, &lab.copies())
    }

    /// 删原件：计划列出副本，默认一起挪进暂存、记录删掉；一次撤销把原件、链接、副本与记录都放回
    #[test]
    fn 删原件_副本一起删_同一次撤销放回() {
        let lab = Lab::new();
        lab.place("a", "continue");
        lab.click("a", "claude-code");
        let before = lab.store.load_copies().unwrap();
        let plan = plan_delete(&lab, &[]);
        assert_eq!(plan.copies, vec![lab.copy("a")]);
        assert_eq!(plan.affected.len(), 1);

        let hold = lab.store.held_dir();
        let (report, undo) = sync::delete_source_holding(&plan, Some(&hold), Some(&lab.store));
        assert!(
            report.entries.iter().all(|e| e.outcome == Outcome::Removed),
            "{report:?}"
        );
        assert!(report
            .entries
            .iter()
            .any(|e| e.action.target_path == lab.copy("a")));
        assert_eq!(entry_kind(&lab.original("a")), EntryKind::Missing);
        assert_eq!(entry_kind(&lab.copy("a")), EntryKind::Missing);
        assert_eq!(
            entry_kind(&lab.home.join(".claude/skills/a")),
            EntryKind::Missing
        );
        assert!(lab.store.load_copies().unwrap().is_empty());
        // 副本暂存在它旁边，不跟原件进数据目录的暂存处（那可能在另一个卷上）
        assert_eq!(held_beside(&lab.home.join(".continue/skills")).len(), 1);
        let in_hold: Vec<PathBuf> = std::fs::read_dir(&hold)
            .unwrap()
            .flatten()
            .flat_map(|slot| std::fs::read_dir(slot.path()).unwrap().flatten())
            .map(|e| e.path())
            .filter(|p| entry_kind(p) == EntryKind::Dir)
            .collect();
        assert_eq!(in_hold.len(), 1, "{in_hold:?}");

        let back = sync::undo_delete(&undo.expect("挪进了暂存，给撤销"), Some(&lab.store));
        assert!(
            back.entries.iter().all(|e| e.outcome == Outcome::Created),
            "{back:?}"
        );
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo v1\n");
        assert_eq!(lab.store.load_copies().unwrap(), before);
        assert_eq!(lab.cell("a", "continue").state, CellState::Copied);
        assert_eq!(lab.cell("a", "claude-code").state, CellState::Linked);
        assert!(held_beside(&lab.home.join(".continue/skills")).is_empty());
    }

    /// 只删原件（计划里的副本清单清空）：副本留着、记录删掉，此后它是 Continue 自己的一行；
    /// 撤销时副本没动过，记录也回来
    #[test]
    fn 只删原件_副本留下变成agent自己的_撤销后记录回来() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let before = lab.store.load_copies().unwrap();
        let mut plan = plan_delete(&lab, &[]);
        plan.copies.clear();

        let hold = lab.store.held_dir();
        let (report, undo) = sync::delete_source_holding(&plan, Some(&hold), Some(&lab.store));
        assert_eq!(report.entries.len(), 1, "{report:?}");
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo v1\n");
        assert!(lab.store.load_copies().unwrap().is_empty());
        let (sources, _) = lab.discover();
        assert!(
            sources
                .iter()
                .any(|s| s.skills.iter().any(|k| k.path == lab.copy("a"))),
            "成了 Continue 自己的原件"
        );

        sync::undo_delete(&undo.unwrap(), Some(&lab.store));
        assert_eq!(lab.store.load_copies().unwrap(), before);
        assert_eq!(lab.cell("a", "continue").state, CellState::Copied);
        assert_eq!(lab.rows_named("a"), 1);
    }

    /// 别处有同名原件：链接改指过去，副本也换成那一份的内容、记录改对应它；撤销换回
    #[test]
    fn 删原件有别处同名_副本改对应那一份_撤销换回() {
        let lab = Lab::new();
        lab.place("a", "continue");
        let before = lab.store.load_copies().unwrap();
        let other = lab.t.skill("elsewhere/a");
        std::fs::write(other.join("run.sh"), "echo other\n").unwrap();
        let elsewhere = Source {
            id: other.parent().unwrap().display().to_string(),
            path: other.parent().unwrap().to_path_buf(),
            kind: SourceKind::Manual,
            label: "elsewhere".into(),
            skills: vec![Skill {
                name: "a".into(),
                path: other.clone(),
                description: None,
            }],
        };
        let plan = plan_delete(&lab, &[elsewhere]);
        assert_eq!(plan.relink_to.as_deref(), Some(other.as_path()));
        assert_eq!(plan.copies, vec![lab.copy("a")]);

        let hold = lab.store.held_dir();
        let (report, undo) = sync::delete_source_holding(&plan, Some(&hold), Some(&lab.store));
        assert!(
            report
                .entries
                .iter()
                .all(|e| matches!(e.outcome, Outcome::Removed | Outcome::Created)),
            "{report:?}"
        );
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo other\n");
        let now = lab.store.load_copies().unwrap();
        assert_eq!(now.len(), 1);
        assert_eq!(now[0].source, other);
        assert_eq!(now[0].copy_sha, content_sha(&lab.copy("a")).unwrap());
        // 对账不再动它：内容与记录对得上
        assert!(reconcile(&lab.store).unwrap().report.entries.is_empty());

        let back = sync::undo_delete(&undo.unwrap(), Some(&lab.store));
        assert!(
            back.entries.iter().all(|e| e.outcome == Outcome::Created),
            "{back:?}"
        );
        assert_eq!(read(&lab.copy("a").join("run.sh")), "echo v1\n");
        assert_eq!(lab.store.load_copies().unwrap(), before);
    }

    /// 订阅：别处的来源只在 Continue 里有一份副本——算「这个位置用了这个来源」：认领进记录、成行；
    /// 移除来源时清单列出它，执行时一起移除
    #[test]
    fn 副本算作用了这个来源_移除来源时一起移除() {
        let lab = Lab::new();
        let x = lab.t.skill("team/x");
        let team = Source {
            id: x.parent().unwrap().display().to_string(),
            path: x.parent().unwrap().to_path_buf(),
            kind: SourceKind::Manual,
            label: "team".into(),
            skills: vec![Skill {
                name: "x".into(),
                path: x.clone(),
                description: None,
            }],
        };
        let (mut sources, targets) = lab.discover();
        sources.push(team.clone());
        let cell = CellRef {
            source_id: team.id.clone(),
            skill: "x".into(),
            target_id: "continue".into(),
        };
        let actions = propose_links(&sources, &targets, &[cell]);
        sync::execute_with(
            &actions,
            false,
            LinkStyle::Absolute,
            Some(&lab.store),
            &unsupported,
        );
        let copy = lab.copy("x");
        assert_eq!(entry_kind(&copy), EntryKind::Dir);
        let (mut sources, targets) = lab.discover();
        sources.push(team.clone());

        // 没有记录也成行（此刻在用），认领时写进记录
        let ov = scan(&sources, &targets, &Subscriptions::new(), &lab.copies());
        assert!(ov.domains[0]
            .rows
            .iter()
            .any(|r| r.source_id == team.id && r.skill == "x"));
        let mut subs = Subscriptions::new();
        crate::subscriptions::adopt(&mut subs, &sources, &targets, &[], &lab.copies());
        assert!(subs["global"].contains(&normalize(&team.path)));

        let plan = crate::subscriptions::plan_remove(
            "global",
            &team.id,
            &sources,
            &targets,
            &lab.copies(),
        )
        .unwrap();
        assert_eq!(plan.links.len(), 1);
        assert_eq!(plan.links[0].skill.as_deref(), Some("x"));
        assert_eq!(plan.links[0].target_id, "continue");

        let mut rules = Vec::new();
        let report = crate::subscriptions::remove(
            "global",
            &team.id,
            &sources,
            &targets,
            &mut subs,
            &mut rules,
            Some(&lab.store),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].outcome, Outcome::Removed);
        assert_eq!(entry_kind(&copy), EntryKind::Missing);
        assert!(lab.store.load_copies().unwrap().is_empty());
        assert!(!subs["global"].contains(&normalize(&team.path)));
    }

    /// 整个 agent 目录是链到别的原件位置的链接（`linked_whole_to`，如项目里 `.continue/skills` 整个链到
    /// 团队仓库）：那一列按「整目录已链」，不出动作（不往别人的目录里放东西）
    #[test]
    fn 整目录已链的agent不放副本() {
        let lab = Lab::new();
        let (sources, _) = lab.discover();
        let universal = sources
            .iter()
            .find(|s| s.kind == SourceKind::Universal)
            .unwrap()
            .clone();
        let team = lab.t.skill("team/b");
        let target = Target {
            id: "project:p::continue".into(),
            label: "Continue".into(),
            path: lab.home.join(".continue/skills"),
            scope: TargetScope::Project {
                project: lab.home.clone(),
                harness_id: "continue".into(),
                project_label: None,
            },
            exists: true,
            linked_whole_to: Some(team.parent().unwrap().display().to_string()),
        };
        let cell = CellRef {
            source_id: universal.id.clone(),
            skill: "a".into(),
            target_id: target.id.clone(),
        };
        let actions = propose_links(
            std::slice::from_ref(&universal),
            std::slice::from_ref(&target),
            &[cell],
        );
        assert!(actions.is_empty(), "{actions:?}");
    }

    /// 建不了链接、放的那一刻那里已经有东西（出计划到执行之间别人放的）：不动、不记
    #[test]
    fn 那里已有东西_不放() {
        let lab = Lab::new();
        let (sources, targets) = lab.discover();
        let source = sources
            .iter()
            .find(|s| s.kind == SourceKind::Universal)
            .unwrap();
        let cell = CellRef {
            source_id: source.id.clone(),
            skill: "a".into(),
            target_id: "continue".into(),
        };
        let actions = propose_links(&sources, &targets, &[cell]);
        std::fs::write(lab.copy("a"), "someone else's").unwrap();
        let taken = sync::execute_with(
            &actions,
            false,
            LinkStyle::Absolute,
            Some(&lab.store),
            &unsupported,
        );
        assert_eq!(
            taken.entries[0].outcome,
            Outcome::Failed(crate::t!("skills.sync.spotTaken"))
        );
        assert_eq!(read(&lab.copy("a")), "someone else's");
        assert!(lab.store.load_copies().unwrap().is_empty());
    }

    /// 给 Claude Code 加：出的是建链动作；执行时建链这一步换成 `link`（模拟文件系统的回应）
    fn click_linking_with(
        lab: &Lab,
        link: &dyn Fn(&Path, &Path, LinkStyle) -> io::Result<()>,
    ) -> (Vec<PlannedAction>, SyncReport) {
        let (sources, targets) = lab.discover();
        let source = sources
            .iter()
            .find(|s| s.kind == SourceKind::Universal)
            .unwrap();
        let cell = CellRef {
            source_id: source.id.clone(),
            skill: "a".into(),
            target_id: "claude-code".into(),
        };
        let actions = propose_links(&sources, &targets, &[cell]);
        assert_eq!(actions[0].kind, ActionKind::Create);
        let report =
            sync::execute_with(&actions, false, LinkStyle::Absolute, Some(&lab.store), link);
        (actions, report)
    }

    /// #204：建链时文件系统回「不支持」——自动改放副本并记下；结果与正常加上相同（做成了、不带失败类别），
    /// 报告里这一条是放副本（撤销安装据此移除副本）；那一格对用户是已加上
    #[test]
    fn 建不了链接_自动改放副本_结果与正常加上相同() {
        let lab = Lab::new();
        let (_, report) = click_linking_with(&lab, &|_, _, _| {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        });
        assert_eq!(report.entries.len(), 1);
        let entry = &report.entries[0];
        assert_eq!(entry.outcome, Outcome::Created);
        assert_eq!(entry.fail_kind, None);
        assert_eq!(entry.detail, None);
        assert_eq!(entry.action.kind, ActionKind::PlaceCopy);

        let placed = lab.home.join(".claude/skills/a");
        assert_eq!(entry_kind(&placed), EntryKind::Dir);
        assert_eq!(read(&placed.join("run.sh")), "echo v1\n");
        let records = lab.store.load_copies().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].path, placed);
        assert_eq!(records[0].source, lab.original("a"));
        assert_eq!(lab.cell("a", "claude-code").state, CellState::Copied);
        assert_eq!(lab.rows_named("a"), 1);
    }

    /// Windows 建 junction 先建一个空目录、再设重解析点，设不上时空目录留在原处（junction 2.0.0）：
    /// 那里原本没东西、现在是个空的真实目录，就先删掉它（不递归）再放副本，不报「已有同名」
    #[test]
    fn 建链失败留下空目录_删掉再放副本() {
        let lab = Lab::new();
        let (_, report) = click_linking_with(&lab, &|_, link, _| {
            std::fs::create_dir(link)?;
            Err(io::Error::from(io::ErrorKind::Unsupported))
        });
        let entry = &report.entries[0];
        assert_eq!(entry.outcome, Outcome::Created, "{entry:?}");
        assert_eq!(entry.action.kind, ActionKind::PlaceCopy);
        let placed = lab.home.join(".claude/skills/a");
        assert_eq!(read(&placed.join("run.sh")), "echo v1\n");
        assert_eq!(lab.store.load_copies().unwrap().len(), 1);
        assert_eq!(lab.cell("a", "claude-code").state, CellState::Copied);
    }

    /// 建链失败后那里有东西且不是空目录（别人在这期间放了东西）：不删，照旧不放
    #[test]
    fn 建链失败后那里有东西_不删不放() {
        let lab = Lab::new();
        let (_, report) = click_linking_with(&lab, &|_, link, _| {
            std::fs::create_dir(link)?;
            std::fs::write(link.join("SKILL.md"), "mine")?;
            Err(io::Error::from(io::ErrorKind::Unsupported))
        });
        assert!(matches!(report.entries[0].outcome, Outcome::Failed(_)));
        let spot = lab.home.join(".claude/skills/a");
        assert_eq!(read(&spot.join("SKILL.md")), "mine");
        assert!(lab.store.load_copies().unwrap().is_empty());
    }

    /// 没有写权限、磁盘满：照旧按原分类报失败，不改放副本
    #[test]
    fn 建链没权限或磁盘满_照旧报原分类_不放副本() {
        for (e, want) in [
            (io::ErrorKind::PermissionDenied, FailKind::NoWrite),
            (io::ErrorKind::StorageFull, FailKind::DiskFull),
        ] {
            let lab = Lab::new();
            let (_, report) = click_linking_with(&lab, &|_, _, _| Err(io::Error::from(e)));
            let entry = &report.entries[0];
            assert!(matches!(entry.outcome, Outcome::Failed(_)), "{entry:?}");
            assert_eq!(entry.fail_kind, Some(want));
            assert_eq!(entry.action.kind, ActionKind::Create);
            assert_eq!(
                entry_kind(&lab.home.join(".claude/skills/a")),
                EntryKind::Missing
            );
            assert!(lab.store.load_copies().unwrap().is_empty());
        }
    }

    /// 建不了链接、又没给副本记录处（只撤链的调用方不会出建链动作，防御）：报失败，类别是「建不了链接」——
    /// 外部原因，不按 Sophia 自身异常上报
    #[test]
    fn 建不了链接又没有记录处_报建不了链接这一类() {
        let lab = Lab::new();
        let (actions, _) = click_linking_with(&lab, &|_, _, _| Ok(()));
        std::fs::remove_dir_all(lab.home.join(".claude/skills")).ok();
        let report = sync::execute_with(&actions, false, LinkStyle::Absolute, None, &|_, _, _| {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        });
        assert!(matches!(report.entries[0].outcome, Outcome::Failed(_)));
        assert_eq!(report.entries[0].fail_kind, Some(FailKind::LinkUnsupported));
        assert!(lab.store.load_copies().unwrap().is_empty());
    }

    /// 共用文件夹：项目 `p` 里 Codex 与 Antigravity 的项目级目录是同一个 `.agents/skills`
    struct Shared {
        lab: Lab,
        project: PathBuf,
    }

    impl Shared {
        fn new() -> Self {
            let lab = Lab::new();
            let project = lab.t.dir("p");
            Shared { lab, project }
        }

        fn folder(&self) -> PathBuf {
            self.project.join(".agents/skills")
        }

        fn target_id(&self, harness: &str) -> String {
            format!("project:{}::{harness}", normalize(&self.project).display())
        }

        fn discover(&self) -> (Vec<Source>, Vec<Target>) {
            let env = self.lab.env();
            let hs: Vec<Harness> = discovery::all_harnesses(&env)
                .into_iter()
                .filter(|h| ["codex", "antigravity"].contains(&h.id.as_str()))
                .collect();
            let projects = [self.project.clone()];
            let mut sources = discovery::sources(&env, &hs, &projects, &[]);
            drop_copies(&mut sources, &self.lab.copies());
            let targets = discovery::targets(&env, &hs, &projects, &sources);
            (sources, targets)
        }

        fn cells(&self, harnesses: &[&str]) -> Vec<CellRef> {
            let (sources, _) = self.discover();
            let source = sources
                .iter()
                .find(|s| s.kind == SourceKind::Universal)
                .unwrap();
            harnesses
                .iter()
                .map(|h| CellRef {
                    source_id: source.id.clone(),
                    skill: "a".into(),
                    target_id: self.target_id(h),
                })
                .collect()
        }

        fn propose(&self, harnesses: &[&str]) -> Vec<PlannedAction> {
            let (sources, targets) = self.discover();
            propose_links(&sources, &targets, &self.cells(harnesses))
        }

        fn state(&self, harness: &str) -> CellState {
            let (sources, targets) = self.discover();
            let ov = scan(
                &sources,
                &targets,
                &Subscriptions::new(),
                &self.lab.copies(),
            );
            let id = self.target_id(harness);
            ov.domains
                .iter()
                .flat_map(|d| &d.rows)
                .filter(|r| r.skill == "a" && r.source_id.ends_with(".agents/skills"))
                .flat_map(|r| &r.cells)
                .find(|c| c.target_id == id)
                .unwrap()
                .state
        }
    }

    /// 共用文件夹：只点 Codex 那一列，建链；那里建不了链接就放一份副本、记一条。
    /// 扫描时这份副本对共用它的两列都算已加上，再点 Antigravity 那一格没有动作
    #[test]
    fn 共用文件夹建不了链接_放一份副本_两列都算已加上() {
        let s = Shared::new();
        let actions = s.propose(&["codex"]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::Create);
        let report = sync::execute_with(
            &actions,
            false,
            LinkStyle::Absolute,
            Some(&s.lab.store),
            &unsupported,
        );
        assert_eq!(report.entries[0].outcome, Outcome::Created);
        assert_eq!(report.entries[0].action.kind, ActionKind::PlaceCopy);
        assert_eq!(entry_kind(&s.folder().join("a")), EntryKind::Dir);
        assert_eq!(s.lab.store.load_copies().unwrap().len(), 1);
        assert_eq!(s.state("codex"), CellState::Copied);
        assert_eq!(s.state("antigravity"), CellState::Copied);
        assert!(s.propose(&["antigravity"]).is_empty());
    }

    /// 两列一起点：同一个文件夹只建一处，两列都是已链
    #[test]
    fn 共用文件夹两列一起加_只建一处() {
        let s = Shared::new();
        let actions = s.propose(&["codex", "antigravity"]);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::Create);
        sync::execute(&actions, false, LinkStyle::Absolute, Some(&s.lab.store));
        assert!(matches!(
            entry_kind(&s.folder().join("a")),
            EntryKind::Symlink(_)
        ));
        assert!(s.lab.store.load_copies().unwrap().is_empty());
        assert_eq!(s.state("codex"), CellState::Linked);
        assert_eq!(s.state("antigravity"), CellState::Linked);
    }

    /// 移除来源：共用文件夹里的同一份副本，清单上两家都列（两家都会失去它），执行时只撤一次——
    /// 不出第二条必然失败的
    #[test]
    fn 共用文件夹移除来源_同一处只撤一次() {
        let s = Shared::new();
        let actions = s.propose(&["codex", "antigravity"]);
        sync::execute_with(
            &actions,
            false,
            LinkStyle::Absolute,
            Some(&s.lab.store),
            &unsupported,
        );
        let (sources, targets) = s.discover();
        let universal = sources
            .iter()
            .find(|x| x.kind == SourceKind::Universal)
            .unwrap();
        let codex = s.target_id("codex");
        let key = scan(&sources, &targets, &Subscriptions::new(), &s.lab.copies())
            .domains
            .into_iter()
            .find(|d| d.targets.iter().any(|t| t.id == codex))
            .unwrap()
            .key;
        let plan = crate::subscriptions::plan_remove(
            &key,
            &universal.id,
            &sources,
            &targets,
            &s.lab.copies(),
        )
        .unwrap();
        assert_eq!(plan.links.len(), 2, "{plan:?}");

        let mut subs = Subscriptions::new();
        let report = crate::subscriptions::remove(
            &key,
            &universal.id,
            &sources,
            &targets,
            &mut subs,
            &mut Vec::new(),
            Some(&s.lab.store),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1, "{report:?}");
        assert_eq!(report.entries[0].outcome, Outcome::Removed);
        assert_eq!(entry_kind(&s.folder().join("a")), EntryKind::Missing);
    }

    /// 拆开整目录链接一律逐个建软链（Continue 也是），不放副本
    #[test]
    fn 拆开整目录链接_一律建软链() {
        let lab = Lab::new();
        lab.t.skill("home/.agents/skills/b");
        let (sources, _) = lab.discover();
        let universal = sources
            .iter()
            .find(|s| s.kind == SourceKind::Universal)
            .unwrap()
            .clone();
        let project = lab.t.dir("p");
        lab.t.dir("p/.continue");
        let dir = project.join(".continue/skills");
        lab.t.link(&dir, &universal.path);
        let target = Target {
            id: "project:p::continue".into(),
            label: "Continue".into(),
            path: dir.clone(),
            scope: TargetScope::Project {
                project: project.clone(),
                harness_id: "continue".into(),
                project_label: None,
            },
            exists: true,
            linked_whole_to: Some(universal.id.clone()),
        };

        let report = skills::split_whole_link(&target, &universal, Some(&lab.store));
        assert_eq!(report.entries.len(), 3, "{report:?}");
        assert_eq!(report.entries[0].outcome, Outcome::Removed);
        assert!(report.entries[1..]
            .iter()
            .all(|e| e.action.kind == ActionKind::Create && e.outcome == Outcome::Created));
        assert_eq!(entry_kind(&dir), EntryKind::Dir);
        for name in ["a", "b"] {
            assert!(
                matches!(entry_kind(&dir.join(name)), EntryKind::Symlink(_)),
                "{name}"
            );
        }
        assert!(lab.store.load_copies().unwrap().is_empty());
    }

    /// 原件里的软链照原样复制成软链，可执行位保留：副本与原件的内容指纹一致
    #[cfg(unix)]
    #[test]
    fn 原件里的软链与可执行位照原样复制() {
        use std::os::unix::fs::PermissionsExt;
        let lab = Lab::new();
        let script = lab.original("a").join("run.sh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("run.sh", lab.original("a").join("alias.sh")).unwrap();
        lab.place("a", "continue");
        let copy = lab.copy("a");
        assert_eq!(
            std::fs::read_link(copy.join("alias.sh")).unwrap(),
            PathBuf::from("run.sh")
        );
        let mode = std::fs::metadata(copy.join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o100, 0o100);
        assert_eq!(
            content_sha(&copy).unwrap(),
            content_sha(&lab.original("a")).unwrap()
        );
    }
}

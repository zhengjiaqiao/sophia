//! 执行动作：逐项独立，每条动作自己成败，互不影响
use crate::fs::{create_link, entry_kind, real_path, remove_link, same_real, EntryKind};
use crate::models::*;
use std::io;
use std::path::{Path, PathBuf};

/// 只对 Create 建链（目标目录不存在就先建出来）；BrokenLink 仅在 clean_broken 时删除，
/// 删前重校验仍是软链。Unlink 与 BrokenLink 都不创建任何目录。
/// Unlink 不受 clean_broken 影响（确认在前端做）
pub fn execute(actions: &[PlannedAction], clean_broken: bool, style: LinkStyle) -> SyncReport {
    SyncReport {
        entries: actions
            .iter()
            .map(|a| {
                let mut fail_kind = None;
                let outcome = outcome_for(a, clean_broken, style, &mut fail_kind);
                ReportEntry {
                    action: a.clone(),
                    outcome,
                    fail_kind,
                }
            })
            .collect(),
    }
}

/// io 错误属于哪一类失败：权限不够（EACCES、Windows 的拒绝访问）与只读文件系统都算「无法写入」，
/// 前端据此说人话，不去认操作系统的英文错误串
pub(crate) fn fail_kind_of(e: &io::Error) -> Option<FailKind> {
    matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
    )
    .then_some(FailKind::NoWrite)
}

/// io 错误变失败结果，同时记下失败类别
pub(crate) fn io_failed(e: &io::Error, fail_kind: &mut Option<FailKind>) -> Outcome {
    *fail_kind = fail_kind_of(e);
    Outcome::Failed(e.to_string())
}

fn outcome_for(
    action: &PlannedAction,
    clean_broken: bool,
    style: LinkStyle,
    fail_kind: &mut Option<FailKind>,
) -> Outcome {
    match action.kind {
        ActionKind::Create => {
            // 目标目录不存在就地创建：从零开辟一个 harness 的 skill 目录是正常路径，不是错误。
            // 是否存在要跟随软链判断（is_dir），整目录软链也算已存在
            if !action.target.is_dir() {
                if let Err(e) = std::fs::create_dir_all(&action.target) {
                    *fail_kind = fail_kind_of(&e);
                    return Outcome::Failed(crate::t!("skills.sync.mkTargetFailed", error = e));
                }
            }
            match create_link(&action.source_path, &action.target_path, style) {
                Ok(()) => Outcome::Created,
                Err(e) => io_failed(&e, fail_kind),
            }
        }
        ActionKind::Unlink => {
            // 预览到确认之间可能已被换掉：必须仍是软链，且仍指向该本体位置
            if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_))
                || !same_real(&action.target_path, &action.source_path)
            {
                return Outcome::Failed(crate::t!("skills.sync.notBodyLink"));
            }
            match remove_link(&action.target_path) {
                Ok(()) => Outcome::Removed,
                Err(e) => io_failed(&e, fail_kind),
            }
        }
        ActionKind::BrokenLink if clean_broken => {
            // 预览到确认之间路径可能已被换成真实文件
            if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_)) {
                return Outcome::Failed(crate::t!("skills.sync.notLink"));
            }
            match remove_link(&action.target_path) {
                Ok(()) => Outcome::Removed,
                Err(e) => io_failed(&e, fail_kind),
            }
        }
        ActionKind::BrokenLink => Outcome::Skipped,
        // 删本体不走逐项执行，它有自己的前置检查，见 `delete_source`
        ActionKind::DeleteSource => Outcome::Skipped,
    }
}

/// 移入系统废纸篓（可从访达恢复），不是彻底删除。
/// 删前用 lstat 重校验仍是真实目录：软链要走 `remove_link`，绝不能顺着它删到本体里
pub fn trash(path: &Path) -> io::Result<()> {
    if entry_kind(path) != EntryKind::Dir {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            crate::t!("skills.sync.trashNotDir", path = path.display()),
        ));
    }
    ::trash::delete(path).map_err(io::Error::other)
}

/// 删本体：目录移进废纸篓，再把指向它的链接逐条改指到 `plan.relink_to`。
/// 本体在 git 仓库内时什么都不动，只回一条失败；
/// 没有 `relink_to` 时受影响的链接一起清掉（DESIGN「删除原件」：不留一排断链给用户收尾），
/// 删前逐条重校验仍是软链、仍指进被删的原件；每条结果逐条如实上报，不偷偷跳过
pub fn delete_source(plan: &DeleteSourcePlan) -> SyncReport {
    delete_source_holding(plan, None).0
}

/// 删原件的撤销记录（DESIGN「删除原件」撤销怎么做到）：原件暂存在哪、原处在哪、
/// 每条链接原来指向哪里。只记真的动成了的链接。撤销机会过去后由调用方 `release_held` 收尾
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteUndo {
    held: PathBuf,
    body: PathBuf,
    links: Vec<LinkUndo>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkUndo {
    path: PathBuf,
    /// 删之前它指向的地方（绝对路径，可能在原件内部）
    dest: PathBuf,
    style: LinkStyle,
    /// 改指到了哪里；None 表示是清掉的
    relinked_to: Option<PathBuf>,
}

/// 同 `delete_source`，但给了 `hold_root` 时原件不直接进废纸篓，先挪进 `hold_root` 下
/// （同一磁盘上是一次改名），返回撤销记录。挪不过去（跨磁盘等）就退回直接进废纸篓、不给撤销
pub fn delete_source_holding(
    plan: &DeleteSourcePlan,
    hold_root: Option<&Path>,
) -> (SyncReport, Option<DeleteUndo>) {
    delete_source_holding_with(plan, hold_root, &trash)
}

/// 同 `delete_source_holding`，移进废纸篓这一步可替换（测试不碰系统废纸篓）
pub(crate) fn delete_source_holding_with(
    plan: &DeleteSourcePlan,
    hold_root: Option<&Path>,
    trash: &dyn Fn(&Path) -> io::Result<()>,
) -> (SyncReport, Option<DeleteUndo>) {
    let delete = PlannedAction {
        kind: ActionKind::DeleteSource,
        item_name: file_name(&plan.path),
        source_path: plan.path.clone(),
        target_path: plan.path.clone(),
        target: parent_of(&plan.path),
    };
    let one = |outcome: Outcome| {
        let report = SyncReport {
            entries: vec![ReportEntry {
                action: delete.clone(),
                outcome,
                fail_kind: None,
            }],
        };
        (report, None)
    };
    if let Some(repo) = &plan.in_git {
        return one(Outcome::Failed(crate::t!(
            "skills.sync.inGit",
            path = repo.display()
        )));
    }
    // 原件在某个应用包（`xxx.app`）里：那是应用自己带的文件，删了会破坏它的签名，放回去 macOS 也不让
    // （2026-09-30 真机：删掉了 ego lite.app 里旧版本的 ego-browser，撤销 Operation not permitted）
    if let Some(app) = app_bundle(&plan.path) {
        return one(Outcome::Failed(crate::t!(
            "skills.sync.inApp",
            app = app
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        )));
    }
    // 撤销要把链接指回原处：删之前记下每条链接此刻指向哪里（绝对路径）
    let dests: Vec<Option<PathBuf>> = plan
        .affected
        .iter()
        .map(|link| match entry_kind(&link.path) {
            EntryKind::Symlink(dest) => Some(dest),
            _ => None,
        })
        .collect();
    // 原件进了废纸篓之后就无从判断链接指不指进它：删之前先记下每条链接此刻指向哪里、是否指进原件
    let before: Vec<Option<PathBuf>> = match (&plan.relink_to, real_path(&plan.path)) {
        (None, Some(body)) => plan
            .affected
            .iter()
            .map(|link| pointing_into(&link.path, &body))
            .collect(),
        _ => Vec::new(),
    };
    let held = match hold_root.map(|root| hold(&plan.path, root)) {
        Some(Ok(held)) => Some(held),
        // 挪不进暂存处（跨磁盘等）或没给暂存处：直接进废纸篓，不给撤销
        _ => {
            if let Err(e) = trash(&plan.path) {
                return one(Outcome::Failed(e.to_string()));
            }
            None
        }
    };
    let mut entries = vec![ReportEntry {
        action: delete,
        outcome: Outcome::Removed,
        fail_kind: None,
    }];
    let mut links = Vec::new();
    for (i, link) in plan.affected.iter().enumerate() {
        let entry = match plan.relink_to.as_deref() {
            Some(to) => relink(link, to),
            None => clear(&link.path, before.get(i).cloned().flatten()),
        };
        let done = matches!(entry.outcome, Outcome::Created | Outcome::Removed);
        if let (true, Some(dest)) = (done, dests[i].clone()) {
            links.push(LinkUndo {
                path: link.path.clone(),
                dest,
                style: link.style,
                relinked_to: plan.relink_to.clone(),
            });
        }
        entries.push(entry);
    }
    let undo = held.map(|held| DeleteUndo {
        held,
        body: plan.path.clone(),
        links,
    });
    (SyncReport { entries }, undo)
}

/// 路径所在的应用包（名字以 `.app` 结尾的那一级目录）；不在应用包里为 None
pub fn app_bundle(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| {
            dir.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
        })
        .map(Path::to_path_buf)
}

/// 暂存格里记原处的文件：`release_held` 要先把原件放回原处再移进废纸篓，访达的「放回原处」才找得到家。
/// 普通文件，与暂存的原件（真实目录）分得开；以点开头
const HOLD_ORIGIN: &str = ".sophia-origin";

/// 访达往目录里写的显示设置文件。从暂存格把原件移进废纸篓时，访达偶尔在暂存格里留下一个
/// （2026-10-05 实测：6 路并行 18 次里 2 次），它不是暂存的原件
const FINDER_METADATA: &str = ".DS_Store";

/// 把原件挪进 `root/<时间戳>/<名字>`，同一格里记下原处（`HOLD_ORIGIN`）。
/// 先重校验仍是真实目录（软链不能顺着挪到本体里）。
/// 装 skill 的撤销与更新（`market::install`）也用它，`release_held` 一并收尾
pub(crate) fn hold(body: &Path, root: &Path) -> io::Result<PathBuf> {
    if entry_kind(body) != EntryKind::Dir {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            crate::t!("skills.sync.holdNotDir", path = body.display()),
        ));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let slot = root.join(stamp.to_string());
    std::fs::create_dir_all(&slot)?;
    // 记不下原处（非 UTF-8 路径、写失败）不拦删除：收尾时退回从暂存格直接移进废纸篓
    if let Some(origin) = body.to_str() {
        let _ = std::fs::write(slot.join(HOLD_ORIGIN), origin);
    }
    let held = slot.join(file_name(body));
    if let Err(e) = std::fs::rename(body, &held) {
        drop_slot(&slot);
        return Err(e);
    }
    Ok(held)
}

/// 暂存格里只剩杂物（原处记录、访达留下的 `.DS_Store`）或已空时删掉这一格；
/// 还有东西（没收成的原件）就留着，杂物也留着
pub(crate) fn drop_slot(slot: &Path) {
    let Ok(entries) = std::fs::read_dir(slot) else {
        return;
    };
    let entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    if entries.iter().all(|p| is_slot_litter(p)) {
        for litter in &entries {
            let _ = std::fs::remove_file(litter);
        }
        let _ = std::fs::remove_dir(slot);
    }
}

/// 撤销删原件：原件放回原处，清掉的链接重建，改指过的链接指回去。每一步先看现场：原处已经被占、
/// 链接又被改过，就不动它、如实上报哪一步没回来。原件没放回时链接一律不动（指回去也是断链）
pub fn undo_delete(undo: &DeleteUndo) -> SyncReport {
    let restore = PlannedAction {
        kind: ActionKind::Create,
        item_name: file_name(&undo.body),
        source_path: undo.held.clone(),
        target_path: undo.body.clone(),
        target: parent_of(&undo.body),
    };
    let body = if entry_kind(&undo.body) != EntryKind::Missing {
        Outcome::Failed(crate::t!("skills.sync.origOccupied"))
    } else if entry_kind(&undo.held) != EntryKind::Dir {
        Outcome::Failed(crate::t!("skills.sync.heldGone"))
    } else {
        match std::fs::rename(&undo.held, &undo.body) {
            Ok(()) => Outcome::Created,
            Err(e) => Outcome::Failed(e.to_string()),
        }
    };
    let back = matches!(body, Outcome::Created);
    if back {
        if let Some(slot) = undo.held.parent() {
            drop_slot(slot);
        }
    }
    let mut entries = vec![ReportEntry {
        action: restore,
        outcome: body,
        fail_kind: None,
    }];
    entries.extend(undo.links.iter().map(|link| {
        let action = PlannedAction {
            kind: ActionKind::Create,
            item_name: file_name(&link.path),
            source_path: link.dest.clone(),
            target_path: link.path.clone(),
            target: parent_of(&link.path),
        };
        let outcome = if !back {
            Outcome::Failed(crate::t!("skills.sync.linkNotRestoredBodyMissing"))
        } else {
            restore_link(link)
        };
        ReportEntry {
            action,
            outcome,
            fail_kind: None,
        }
    }));
    SyncReport { entries }
}

fn restore_link(link: &LinkUndo) -> Outcome {
    let kind = entry_kind(&link.path);
    match &link.relinked_to {
        // 清掉的：那里仍空着才重建
        None if kind == EntryKind::Missing => {}
        None => return Outcome::Failed(crate::t!("skills.sync.linkSpotTaken")),
        // 改指过的：仍指着改指的那一份才指回去
        Some(to) => {
            if !matches!(kind, EntryKind::Symlink(_)) || !same_real(&link.path, to) {
                return Outcome::Failed(crate::t!("skills.sync.linkChanged"));
            }
            if let Err(e) = remove_link(&link.path) {
                return Outcome::Failed(e.to_string());
            }
        }
    }
    match create_link(&link.dest, &link.path, link.style) {
        Ok(()) => Outcome::Created,
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// 撤销机会过去：`hold_root` 下暂存的原件逐个移进废纸篓（访达里照样找得回），空了的暂存格删掉。
/// 返回没收成的（逐个如实上报，不偷偷留下）
pub fn release_held(hold_root: &Path) -> Vec<(PathBuf, String)> {
    release_held_with(hold_root, &trash)
}

/// 同 `release_held`，移进废纸篓这一步可替换（测试不碰系统废纸篓）
pub(crate) fn release_held_with(
    hold_root: &Path,
    trash: &dyn Fn(&Path) -> io::Result<()>,
) -> Vec<(PathBuf, String)> {
    let mut failed = Vec::new();
    let Ok(slots) = std::fs::read_dir(hold_root) else {
        return failed;
    };
    for slot in slots.flatten().map(|e| e.path()) {
        let origin = std::fs::read_to_string(slot.join(HOLD_ORIGIN))
            .ok()
            .map(PathBuf::from);
        if let Ok(items) = std::fs::read_dir(&slot) {
            for item in items.flatten().map(|e| e.path()) {
                if is_slot_litter(&item) {
                    continue;
                }
                // 原处记录只认同名的那一件（旧版本留下的暂存格没有记录）
                let orig = origin
                    .as_deref()
                    .filter(|o| o.file_name() == item.file_name());
                if let Err(e) = release_one(&item, orig, trash) {
                    failed.push((item, e.to_string()));
                }
            }
        }
        drop_slot(&slot);
    }
    failed
}

/// 暂存格里的杂物：原处记录、访达留下的 `.DS_Store`。只认普通文件，暂存的原件是真实目录
fn is_slot_litter(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|n| n == HOLD_ORIGIN || n == FINDER_METADATA)
        && entry_kind(path) == EntryKind::File
}

/// 暂存的一件移进废纸篓。访达的「放回原处」记的是移进废纸篓那一刻的位置，所以先放回原处再移
/// （2026-09-30 真机：从暂存格直接移，「放回原处」报暂存格「doesn't exist anymore」）。
/// 放回原处的前提：记着原处、原处空着、上一级目录还在、不在应用包里、一次改名挪得回去（不跨盘拷贝）。
/// 缺一条就从暂存格直接移进废纸篓：「放回原处」用不了，但什么都不覆盖、不丢。
/// 放回原处之后移不进废纸篓：挪回暂存格，下次再收——删掉的东西不能悄悄回到原处
fn release_one(
    item: &Path,
    orig: Option<&Path>,
    trash: &dyn Fn(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let returnable = |orig: &Path| {
        orig.is_absolute()
            && entry_kind(item) == EntryKind::Dir
            && entry_kind(orig) == EntryKind::Missing
            // 上一级目录是否还在要跟随软链（`~/.claude/skills` 本身可能是软链）
            && orig.parent().is_some_and(Path::is_dir)
            && app_bundle(orig).is_none()
    };
    let Some(orig) = orig.filter(|o| returnable(o)) else {
        return trash(item);
    };
    if std::fs::rename(item, orig).is_err() {
        return trash(item);
    }
    trash(orig).inspect_err(|_| {
        if entry_kind(orig) == EntryKind::Dir && entry_kind(item) == EntryKind::Missing {
            let _ = std::fs::rename(orig, item);
        }
    })
}

/// 链接此刻指进 `body`（real_path 之后按路径分量比较，两侧同源）时，返回它写着的目标
fn pointing_into(link: &Path, body: &Path) -> Option<PathBuf> {
    let EntryKind::Symlink(dest) = entry_kind(link) else {
        return None;
    };
    real_path(link)
        .is_some_and(|real| real.starts_with(body))
        .then_some(dest)
}

/// 没有别处可改指：清掉这条链接。`before` 是删原件之前它指进原件时写着的目标；
/// 删前重校验：仍是软链、目标没被改写、且已指不到东西（原件刚进了废纸篓），才删
fn clear(link: &Path, before: Option<PathBuf>) -> ReportEntry {
    let kind = entry_kind(link);
    let dest = match &kind {
        EntryKind::Symlink(dest) => dest.clone(),
        _ => link.to_path_buf(),
    };
    let action = PlannedAction {
        kind: ActionKind::Unlink,
        item_name: file_name(link),
        source_path: before.clone().unwrap_or_else(|| dest.clone()),
        target_path: link.to_path_buf(),
        target: parent_of(link),
    };
    let still = matches!(kind, EntryKind::Symlink(_))
        && before.as_ref() == Some(&dest)
        && real_path(link).is_none();
    let outcome = if !still {
        Outcome::Failed(crate::t!("skills.sync.notOrigLink"))
    } else {
        match remove_link(link) {
            Ok(()) => Outcome::Removed,
            Err(e) => Outcome::Failed(e.to_string()),
        }
    };
    ReportEntry {
        action,
        outcome,
        fail_kind: None,
    }
}

/// 一条受影响的链接：改指到别处的同名本体。
/// 写法用体检时记下的 `link.style`，项目内的相对链接改指后仍是相对的，不因改指丢掉可移植性
fn relink(affected: &AffectedLink, to: &Path) -> ReportEntry {
    let link = affected.path.as_path();
    let kind = entry_kind(link);
    let create = PlannedAction {
        kind: ActionKind::Create,
        item_name: file_name(link),
        source_path: to.to_path_buf(),
        target_path: link.to_path_buf(),
        target: parent_of(link),
    };
    // 体检到执行之间可能已被换掉：必须仍是软链才动它
    if !matches!(kind, EntryKind::Symlink(_)) {
        return ReportEntry {
            action: create,
            outcome: Outcome::Failed(crate::t!("skills.sync.notLink")),
            fail_kind: None,
        };
    }
    let outcome = match remove_link(link) {
        Err(e) => Outcome::Failed(e.to_string()),
        Ok(()) => match create_link(to, link, affected.style) {
            Ok(()) => Outcome::Created,
            Err(e) => Outcome::Failed(e.to_string()),
        },
    };
    ReportEntry {
        action: create,
        outcome,
        fail_kind: None,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn parent_of(path: &Path) -> PathBuf {
    path.parent().map(Path::to_path_buf).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{entry_kind, EntryKind};
    use crate::test_support::TempTree;
    use std::path::{Path, PathBuf};

    fn outcomes(r: &SyncReport) -> Vec<Outcome> {
        r.entries.iter().map(|e| e.outcome.clone()).collect()
    }

    /// 删本体的测试要现成的本体位置与目标，不借用 skills 的测试脚手架
    fn source_at(path: &Path, skills: &[&str]) -> Source {
        Source {
            id: path.to_string_lossy().into_owned(),
            path: path.to_path_buf(),
            kind: SourceKind::Universal,
            label: "本体".into(),
            skills: skills
                .iter()
                .map(|n| Skill {
                    name: n.to_string(),
                    path: path.join(n),
                    description: None,
                })
                .collect(),
        }
    }

    /// 项目域的目标：本体在同一项目内时 `link_style` 要求写相对路径
    fn project_target_at(id: &str, project: &Path, path: &Path) -> Target {
        Target {
            scope: TargetScope::Project {
                project: project.to_path_buf(),
                harness_id: id.into(),
                project_label: None,
            },
            ..target_at(id, path)
        }
    }

    fn absolute(path: &Path) -> AffectedLink {
        AffectedLink {
            path: path.to_path_buf(),
            style: LinkStyle::Absolute,
        }
    }

    fn target_at(id: &str, path: &Path) -> Target {
        Target {
            id: id.into(),
            label: id.into(),
            path: path.to_path_buf(),
            scope: TargetScope::Global {
                harness_id: id.into(),
            },
            exists: true,
            linked_whole_to: None,
        }
    }

    fn action(kind: ActionKind, source: &Path, link: &Path) -> PlannedAction {
        PlannedAction {
            kind,
            item_name: link.file_name().unwrap().to_string_lossy().into_owned(),
            source_path: source.to_path_buf(),
            target_path: link.to_path_buf(),
            target: link.parent().unwrap().to_path_buf(),
        }
    }

    #[test]
    fn 失败类别_权限与只读文件系统是无法写入_别的失败不带类别() {
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::ReadOnlyFilesystem,
        ] {
            assert_eq!(
                fail_kind_of(&io::Error::from(kind)),
                Some(FailKind::NoWrite)
            );
        }
        assert_eq!(
            fail_kind_of(&io::Error::from(io::ErrorKind::NotFound)),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn 目标目录不可写时_建链失败带无法写入类别_成功与别的失败不带() {
        use std::os::unix::fs::PermissionsExt;
        let tree = TempTree::new();
        let src = tree.dir("src/x");
        let locked = tree.dir("locked");
        let open = tree.dir("open");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let report = execute(
            &[
                action(ActionKind::Create, &src, &locked.join("x")),
                action(ActionKind::Create, &src, &open.join("x")),
                action(ActionKind::Unlink, &src, &open.join("gone")),
            ],
            false,
            LinkStyle::Absolute,
        );
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // root 不受权限位约束：那种环境下这条断言没有意义
        if matches!(report.entries[0].outcome, Outcome::Failed(_)) {
            assert_eq!(report.entries[0].fail_kind, Some(FailKind::NoWrite));
        }
        assert_eq!(report.entries[1].fail_kind, None);
        assert!(matches!(report.entries[2].outcome, Outcome::Failed(_)));
        assert_eq!(report.entries[2].fail_kind, None);
    }

    #[test]
    fn unlink_removes_only_a_link_that_still_points_at_the_source() {
        let tree = TempTree::new();
        let src = tree.dir("src/x");
        let other = tree.dir("other/x");
        let t = tree.dir("t");
        tree.link(&t.join("good"), &src);
        tree.link(&t.join("elsewhere"), &other);
        tree.dir("t/real");
        let actions = vec![
            action(ActionKind::Unlink, &src, &t.join("good")),
            action(ActionKind::Unlink, &src, &t.join("elsewhere")),
            action(ActionKind::Unlink, &src, &t.join("real")),
        ];
        let report = execute(&actions, false, LinkStyle::Absolute);
        assert_eq!(report.entries[0].outcome, Outcome::Removed);
        assert_eq!(entry_kind(&t.join("good")), EntryKind::Missing);
        assert!(matches!(report.entries[1].outcome, Outcome::Failed(_)));
        assert!(matches!(
            entry_kind(&t.join("elsewhere")),
            EntryKind::Symlink(_)
        ));
        assert!(matches!(report.entries[2].outcome, Outcome::Failed(_)));
        assert_eq!(entry_kind(&t.join("real")), EntryKind::Dir);
    }

    #[test]
    fn execute_creates_absolute_links() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        let a = t.file(&src, "a.md");
        let r = execute(
            &[action(ActionKind::Create, &a, &dst.join("a.md"))],
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(std::fs::read_link(dst.join("a.md")).unwrap(), a);
    }

    #[cfg(unix)]
    #[test]
    fn execute_relative_style_writes_relative_target() {
        let t = TempTree::new();
        let src = t.dir("proj/.agents/skills");
        let dst = t.dir("proj/.claude/skills");
        let x = t.dir("proj/.agents/skills/x");
        let r = execute(
            &[action(ActionKind::Create, &x, &dst.join("x"))],
            false,
            LinkStyle::Relative,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(
            std::fs::read_link(dst.join("x")).unwrap(),
            PathBuf::from("../../.agents/skills/x")
        );
        assert_eq!(entry_kind(&src.join("x")), EntryKind::Dir);
    }

    /// AC3：目标目录不存在就地创建（含多级父目录）；整目录软链算已存在，不重复创建
    #[test]
    fn create_makes_the_missing_target_dir_including_parents() {
        let t = TempTree::new();
        let src = t.dir("src");
        let a = t.file(&src, "a.md");
        let missing = t.root().join("proj/.agents/skills");
        let r = execute(
            &[action(ActionKind::Create, &a, &missing.join("a.md"))],
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(entry_kind(&missing), EntryKind::Dir);
        assert!(matches!(
            entry_kind(&missing.join("a.md")),
            EntryKind::Symlink(_)
        ));

        let real = t.dir("real");
        let via = t.root().join("via");
        t.link(&via, &real);
        let r2 = execute(
            &[action(ActionKind::Create, &a, &via.join("a.md"))],
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r2), vec![Outcome::Created]);
        assert!(matches!(
            entry_kind(&real.join("a.md")),
            EntryKind::Symlink(_)
        ));
        // 软链没有被换成真实目录
        assert!(matches!(entry_kind(&via), EntryKind::Symlink(_)));
    }

    /// AC4：建不出目标目录按失败上报，同批其他动作不受影响。
    /// 这里用"父路径是一个普通文件"构造必然失败：只读父目录在 root（CI 常见）下仍可写入，结果不确定
    #[test]
    fn create_reports_failure_when_the_target_dir_cannot_be_made() {
        let t = TempTree::new();
        let src = t.dir("src");
        let a = t.file(&src, "a.md");
        let blocker = t.file(&t.root(), "blocker");
        let ok = t.root().join("ok/skills");
        let r = execute(
            &[
                action(ActionKind::Create, &a, &blocker.join("skills/a.md")),
                action(ActionKind::Create, &a, &ok.join("a.md")),
            ],
            false,
            LinkStyle::Absolute,
        );
        match &r.entries[0].outcome {
            Outcome::Failed(msg) => assert!(
                msg.starts_with("建不出目标目录：") && msg.len() > "建不出目标目录：".len(),
                "失败消息要带上原因：{msg}"
            ),
            other => panic!("应当失败，实际 {other:?}"),
        }
        assert_eq!(entry_kind(&blocker), EntryKind::File);
        // 同批的另一条照常成功
        assert_eq!(r.entries[1].outcome, Outcome::Created);
        assert_eq!(entry_kind(&ok), EntryKind::Dir);
    }

    /// AC5：Unlink 与 BrokenLink 一律不创建目录
    #[test]
    fn unlink_and_broken_link_never_create_directories() {
        let t = TempTree::new();
        let gone = t.root().join("gone/skills");
        let src = t.root().join("src/x");
        let r = execute(
            &[
                action(ActionKind::Unlink, &src, &gone.join("x")),
                action(ActionKind::BrokenLink, &src, &gone.join("y")),
            ],
            true,
            LinkStyle::Absolute,
        );
        assert!(matches!(r.entries[0].outcome, Outcome::Failed(_)));
        assert!(matches!(r.entries[1].outcome, Outcome::Failed(_)));
        assert_eq!(entry_kind(&gone), EntryKind::Missing);
        assert_eq!(entry_kind(&t.root().join("gone")), EntryKind::Missing);
    }

    /// AC14 的护栏：软链、普通文件、不存在的路径一律不进废纸篓，只有真实目录才删
    #[test]
    fn trash_refuses_anything_that_is_not_a_real_directory() {
        let t = TempTree::new();
        let real = t.dir("real");
        let f = t.file(&t.root(), "f");
        let link = t.root().join("link");
        t.link(&link, &real);

        for p in [&link, &f, &t.root().join("gone")] {
            let e = trash(p).expect_err("只有真实目录才允许移入废纸篓");
            assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
            assert!(e.to_string().contains("不是真实目录"), "{e}");
        }
        assert!(matches!(entry_kind(&link), EntryKind::Symlink(_)));
        assert_eq!(entry_kind(&real), EntryKind::Dir);
        assert_eq!(entry_kind(&f), EntryKind::File);
    }

    /// 原件在应用包（`xxx.app`）里一律不代删：目录原样在，如实上报原因（2026-09-30 真机 ego lite.app）
    #[test]
    fn delete_refuses_bodies_inside_an_app_bundle() {
        let t = TempTree::new();
        let body = t.dir("Applications/ego lite.app/Contents/Resources/ego-skills/ego-browser");
        t.file(&body, "SKILL.md");
        let plan = DeleteSourcePlan {
            path: body.clone(),
            entries: 1,
            bytes: 0,
            affected: Vec::new(),
            in_git: None,
            relink_to: None,
            modified: None,
        };
        let hold = t.dir("app/held");
        let (report, undo) = delete_source_holding(&plan, Some(&hold));
        assert!(undo.is_none());
        match &report.entries[0].outcome {
            Outcome::Failed(why) => assert!(why.contains("ego lite.app"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(entry_kind(&body), EntryKind::Dir);
        assert_eq!(app_bundle(Path::new("/Users/me/.agents/skills/pdf")), None);
    }

    /// AC15：本体在 git 仓库内一律不代删，目录与受影响的链接都不动
    #[test]
    fn delete_source_refuses_a_body_inside_a_git_repo() {
        let t = TempTree::new();
        let repo = t.dir("repo");
        t.dir("repo/.git");
        let body = t.dir("repo/.agents/skills/a");
        let dst = t.dir("dst");
        let link = dst.join("a");
        t.link(&link, &body);
        let plan = DeleteSourcePlan {
            path: body.clone(),
            entries: 0,
            bytes: 0,
            affected: vec![absolute(&link)],
            in_git: Some(repo.clone()),
            relink_to: Some(t.dir("other/a")),
            modified: None,
        };
        let r = delete_source(&plan);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].action.kind, ActionKind::DeleteSource);
        match &r.entries[0].outcome {
            Outcome::Failed(msg) => assert!(
                msg.contains("git") && msg.contains(&repo.display().to_string()),
                "失败消息要给出仓库根：{msg}"
            ),
            other => panic!("应当拒绝，实际 {other:?}"),
        }
        // 什么都没动
        assert_eq!(entry_kind(&body), EntryKind::Dir);
        assert!(same_real(&link, &body));
    }

    /// AC16：删完之后，原本指向被删本体的链接全部改指到留下的那个，且都不是断链。
    /// 删原件的这几条走替身废纸篓（`FakeBin`）：真的系统废纸篓经访达移，整套并行跑时偶发失败，
    /// 也不该往用户废纸篓里塞东西；真进废纸篓（AC14）靠真机核对
    #[test]
    fn delete_source_trashes_the_body_and_repoints_links_to_the_remaining_one() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/sophia-test-repoint");
        t.file(&body, "SKILL.md");
        let other = t.dir("other");
        let kept = t.dir("other/sophia-test-repoint");
        let claude = t.dir("home/.claude/skills");
        let codex = t.dir("home/.codex/skills");
        t.link(&claude.join("sophia-test-repoint"), &body);
        t.link(&codex.join("sophia-test-repoint"), &body);
        t.link(&claude.join("untouched"), &kept);

        let sources = vec![
            source_at(&store, &["sophia-test-repoint"]),
            source_at(&other, &["sophia-test-repoint"]),
        ];
        let targets = vec![
            target_at("claude-code", &claude),
            target_at("codex", &codex),
        ];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        assert_eq!(plan.relink_to.as_deref(), Some(kept.as_path()));
        assert_eq!(
            plan.affected,
            vec![
                absolute(&claude.join("sophia-test-repoint")),
                absolute(&codex.join("sophia-test-repoint")),
            ]
        );

        let bin = FakeBin::new(&t);
        let r = delete_source_holding_with(&plan, None, &|p| bin.trash(p)).0;
        assert_eq!(bin.from(), vec![body.clone()], "原件交给了废纸篓");
        assert_eq!(r.entries[0].action.kind, ActionKind::DeleteSource);
        assert_eq!(r.entries[0].outcome, Outcome::Removed);
        assert_eq!(entry_kind(&body), EntryKind::Missing);
        assert_eq!(outcomes(&r)[1..], [Outcome::Created, Outcome::Created]);
        for link in plan.affected.iter().map(|a| a.path.as_path()) {
            assert!(
                matches!(entry_kind(link), EntryKind::Symlink(_)),
                "{link:?} 仍要是软链"
            );
            assert!(same_real(link, &kept), "{link:?} 要改指到留下的本体");
        }
        // 本来就指向别处的链接不受影响；留下的本体原样在
        assert!(same_real(&claude.join("untouched"), &kept));
        assert_eq!(entry_kind(&kept), EntryKind::Dir);
    }

    /// 改指不许把相对链接写成绝对：项目内的链接是随 git 走到别的机器上的，写法必须保住。
    /// 判相对/绝对读 `read_link` 的原始值——`real_path` 会把两种写法解析成同一个绝对路径，
    /// 拿它断言的话这条性质坏掉了测试也不会红。
    #[cfg(unix)]
    #[test]
    fn relinking_keeps_the_project_local_link_relative_and_the_global_one_absolute() {
        let t = TempTree::new();
        let proj = t.dir("proj");
        let store = t.dir("proj/.agents/skills"); // 项目内、要删的本体位置
        let body = t.dir("proj/.agents/skills/sophia-test-relative");
        let vendor = t.dir("proj/vendor/skills"); // 项目内、留下的同名本体
        let kept = t.dir("proj/vendor/skills/sophia-test-relative");
        let claude = t.dir("proj/.claude/skills"); // 项目目标
        let home = t.dir("home/.claude/skills"); // 全局目标
        let in_proj = claude.join("sophia-test-relative");
        let global_link = home.join("sophia-test-relative");
        // 项目内的链接按 link_style 本来就是相对的
        create_link(&body, &in_proj, LinkStyle::Relative).unwrap();
        t.link(&global_link, &body);
        assert!(std::fs::read_link(&in_proj).unwrap().is_relative());

        let sources = vec![
            source_at(&store, &["sophia-test-relative"]),
            source_at(&vendor, &["sophia-test-relative"]),
        ];
        let targets = vec![
            project_target_at("claude-code", &proj, &claude),
            target_at("claude-code-global", &home),
        ];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        assert_eq!(plan.relink_to.as_deref(), Some(kept.as_path()));
        let style_of = |p: &Path| {
            plan.affected
                .iter()
                .find(|a| a.path == p)
                .unwrap_or_else(|| panic!("{p:?} 应当在受影响的链接里"))
                .style
        };
        // 留下的本体也在项目内 → 项目目标仍写相对；全局目标一律绝对
        assert_eq!(style_of(&in_proj), LinkStyle::Relative);
        assert_eq!(style_of(&global_link), LinkStyle::Absolute);

        let bin = FakeBin::new(&t);
        let r = delete_source_holding_with(&plan, None, &|p| bin.trash(p)).0;
        assert_eq!(bin.from(), vec![body.clone()], "原件交给了废纸篓");
        assert_eq!(
            outcomes(&r),
            vec![Outcome::Removed, Outcome::Created, Outcome::Created]
        );
        assert_eq!(
            std::fs::read_link(&in_proj).unwrap(),
            PathBuf::from("../../vendor/skills/sophia-test-relative"),
            "项目内的链接改指后仍要是相对写法"
        );
        assert_eq!(std::fs::read_link(&global_link).unwrap(), kept);
        assert!(same_real(&in_proj, &kept) && same_real(&global_link, &kept));
    }

    /// 没有别处的同名本体时，指向它的链接一起清掉，不留断链（DESIGN「删除原件」），逐条上报。
    #[test]
    fn delete_source_clears_links_when_no_other_body_remains() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/sophia-test-clear");
        t.file(&body, "SKILL.md");
        let claude = t.dir("home/.claude/skills");
        let cursor = t.dir("home/.cursor/skills");
        let link = claude.join("sophia-test-clear");
        // 指进原件内部的链接同样算受影响
        let inner = cursor.join("sophia-test-clear");
        t.link(&link, &body);
        t.link(&inner, &body.join("SKILL.md"));

        let sources = vec![source_at(&store, &["sophia-test-clear"])];
        let targets = vec![
            target_at("claude-code", &claude),
            target_at("cursor", &cursor),
        ];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        assert_eq!(plan.relink_to, None);
        assert_eq!(plan.affected, vec![absolute(&link), absolute(&inner)]);

        let bin = FakeBin::new(&t);
        let r = delete_source_holding_with(&plan, None, &|p| bin.trash(p)).0;
        assert_eq!(bin.from(), vec![body.clone()], "原件交给了废纸篓");
        assert_eq!(
            outcomes(&r),
            vec![Outcome::Removed, Outcome::Removed, Outcome::Removed]
        );
        assert_eq!(r.entries[1].action.kind, ActionKind::Unlink);
        assert_eq!(r.entries[1].action.target_path, link);
        assert_eq!(r.entries[1].action.source_path, body);
        assert_eq!(r.entries[2].action.target_path, inner);
        assert_eq!(entry_kind(&link), EntryKind::Missing);
        assert_eq!(entry_kind(&inner), EntryKind::Missing);
        assert_eq!(entry_kind(&body), EntryKind::Missing);
        // 目标目录本身不动
        assert_eq!(entry_kind(&claude), EntryKind::Dir);
    }

    /// 给了暂存处：原件挪进暂存处（不进废纸篓），链接照常清掉；撤销放回原件、原样重建链接
    /// （指进原件内部的那条也指回原来的文件）
    #[test]
    fn held_delete_can_be_undone_with_cleared_links_restored() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/held");
        t.file(&body, "SKILL.md");
        let hold_root = t.dir("app/held");
        let claude = t.dir("home/.claude/skills");
        let cursor = t.dir("home/.cursor/skills");
        let link = claude.join("held");
        let inner = cursor.join("held");
        t.link(&link, &body);
        t.link(&inner, &body.join("SKILL.md"));
        let sources = vec![source_at(&store, &["held"])];
        let targets = vec![
            target_at("claude-code", &claude),
            target_at("cursor", &cursor),
        ];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);

        let (r, undo) = delete_source_holding(&plan, Some(&hold_root));
        assert_eq!(outcomes(&r), vec![Outcome::Removed; 3]);
        assert_eq!(entry_kind(&body), EntryKind::Missing);
        assert_eq!(entry_kind(&link), EntryKind::Missing);
        let undo = undo.expect("同一磁盘上挪得进暂存处，要给撤销");
        assert!(undo.held.starts_with(&hold_root));
        assert_eq!(entry_kind(&undo.held), EntryKind::Dir);

        let back = undo_delete(&undo);
        assert_eq!(outcomes(&back), vec![Outcome::Created; 3]);
        assert_eq!(entry_kind(&body), EntryKind::Dir);
        assert!(body.join("SKILL.md").is_file());
        assert!(same_real(&link, &body));
        assert!(same_real(&inner, &body.join("SKILL.md")));
        // 暂存格收干净了
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
    }

    /// 改指过的链接撤销时指回原来那一份；之后又被改过的不动、如实上报
    #[test]
    fn undo_points_relinked_links_back_and_leaves_changed_ones() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/twin");
        t.file(&body, "SKILL.md");
        let other = t.dir("other");
        let kept = t.dir("other/twin");
        let hold_root = t.dir("app/held");
        let claude = t.dir("home/.claude/skills");
        let codex = t.dir("home/.codex/skills");
        t.link(&claude.join("twin"), &body);
        t.link(&codex.join("twin"), &body);
        let sources = vec![source_at(&store, &["twin"]), source_at(&other, &["twin"])];
        let targets = vec![
            target_at("claude-code", &claude),
            target_at("codex", &codex),
        ];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        let (_, undo) = delete_source_holding(&plan, Some(&hold_root));
        let undo = undo.expect("有撤销");
        assert!(
            same_real(&claude.join("twin"), &kept),
            "删的时候改指到留下的那份"
        );
        // 用户之后手动把 Codex 那条换成了真实目录
        std::fs::remove_file(codex.join("twin")).unwrap();
        t.dir("home/.codex/skills/twin");

        let back = undo_delete(&undo);
        assert_eq!(
            outcomes(&back)[..2],
            [Outcome::Created, Outcome::Created],
            "原件放回、Claude Code 那条指回去"
        );
        assert!(matches!(outcomes(&back)[2], Outcome::Failed(_)));
        assert!(same_real(&claude.join("twin"), &body));
        assert_eq!(
            entry_kind(&codex.join("twin")),
            EntryKind::Dir,
            "改过的不动"
        );
    }

    /// 原处之后又放了同名的东西：原件不放回、链接一律不动，如实上报
    #[test]
    fn undo_refuses_when_the_original_spot_is_taken() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/taken");
        let hold_root = t.dir("app/held");
        let claude = t.dir("home/.claude/skills");
        t.link(&claude.join("taken"), &body);
        let sources = vec![source_at(&store, &["taken"])];
        let targets = vec![target_at("claude-code", &claude)];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        let (_, undo) = delete_source_holding(&plan, Some(&hold_root));
        let undo = undo.expect("有撤销");
        t.dir("store/taken");

        let back = undo_delete(&undo);
        assert!(back
            .entries
            .iter()
            .all(|e| matches!(e.outcome, Outcome::Failed(_))));
        assert_eq!(entry_kind(&claude.join("taken")), EntryKind::Missing);
        assert_eq!(
            entry_kind(&undo.held),
            EntryKind::Dir,
            "暂存的原件留着，没丢"
        );
    }

    /// 撤销机会过去：暂存的原件移进废纸篓，暂存格删掉。走替身废纸篓：真的系统废纸篓经访达移，
    /// 并行跑整套测试时暂存格偶尔删不掉（2026-10-05 `make test` 六次挂三次），也不该往用户废纸篓里塞东西
    #[test]
    fn release_held_moves_held_bodies_to_the_trash() {
        let t = TempTree::new();
        let hold_root = t.dir("app/held");
        let item = t.dir("app/held/123/pdf");
        t.file(&item, "SKILL.md");
        let bin = FakeBin::new(&t);
        assert!(release_held_with(&hold_root, &|p| bin.trash(p)).is_empty());
        assert_eq!(bin.from(), vec![item]);
        assert!(bin.bin.join("1/SKILL.md").is_file(), "内容整份进了废纸篓");
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
        // 暂存目录不存在：什么都不做（读不到目录就返回，碰不到废纸篓）
        assert!(release_held(&t.root().join("nope")).is_empty());
    }

    /// 访达从暂存格移走原件时偶尔在格里留下 `.DS_Store`：它不是原件，不交给废纸篓、不算失败，
    /// 暂存格照样删掉；以前积下的、只剩原处记录和 `.DS_Store` 的格子，下次收尾一并删掉
    #[test]
    fn release_held_drops_slots_finder_left_a_ds_store_in() {
        let t = TempTree::new();
        let hold_root = t.dir("app/held");
        // 旧版本留下的暂存格没有原处记录：从暂存格直接移，访达就在这一格里留下 .DS_Store
        let item = t.dir("app/held/2/pdf");
        t.file(&item, "SKILL.md");
        let leftover = t.dir("app/held/1");
        t.file(&leftover, ".sophia-origin");
        t.file(&leftover, ".DS_Store");
        let bin = FakeBin::new(&t);
        let finder = |p: &Path| {
            bin.trash(p)?;
            std::fs::write(p.parent().unwrap().join(".DS_Store"), "")
        };
        assert!(release_held_with(&hold_root, &finder).is_empty());
        assert_eq!(bin.from(), vec![item], ".DS_Store 不交给废纸篓");
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
    }

    /// 替身废纸篓：记下每次从哪里移、把东西挪进 `bin/<序号>`，不碰系统废纸篓。
    /// `fail` 为真时什么都不动、只报错（模拟访达拒绝）
    struct FakeBin {
        bin: PathBuf,
        from: std::cell::RefCell<Vec<PathBuf>>,
        fail: bool,
    }

    impl FakeBin {
        fn new(t: &TempTree) -> Self {
            FakeBin {
                bin: t.dir("bin"),
                from: Default::default(),
                fail: false,
            }
        }

        fn trash(&self, path: &Path) -> io::Result<()> {
            self.from.borrow_mut().push(path.to_path_buf());
            if self.fail {
                return Err(io::Error::other("访达拒绝"));
            }
            let n = self.from.borrow().len();
            std::fs::rename(path, self.bin.join(n.to_string()))
        }

        fn from(&self) -> Vec<PathBuf> {
            self.from.borrow().clone()
        }
    }

    /// 删原件：原件挪进暂存格，撤销机会过去后先放回原处、再从原处移进废纸篓——
    /// 访达「放回原处」记的是移进那一刻的位置（2026-09-30 真机：从暂存格移，放回时暂存格已经没了）
    #[test]
    fn release_held_trashes_from_the_original_spot() {
        let t = TempTree::new();
        let store = t.dir("home/.agents/skills");
        let body = t.dir("home/.agents/skills/gone");
        t.file(&body, "SKILL.md");
        let hold_root = t.dir("app/held");
        let claude = t.dir("home/.claude/skills");
        t.link(&claude.join("gone"), &body);
        let sources = vec![source_at(&store, &["gone"])];
        let targets = vec![target_at("claude-code", &claude)];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        let (_, undo) = delete_source_holding(&plan, Some(&hold_root));
        let undo = undo.expect("有撤销");
        assert_eq!(entry_kind(&body), EntryKind::Missing);
        assert_eq!(entry_kind(&undo.held), EntryKind::Dir);

        let bin = FakeBin::new(&t);
        assert!(release_held_with(&hold_root, &|p| bin.trash(p)).is_empty());
        assert_eq!(bin.from(), vec![body.clone()], "从原处移进废纸篓");
        assert_eq!(entry_kind(&body), EntryKind::Missing, "原处没留下东西");
        assert!(bin.bin.join("1/SKILL.md").is_file(), "内容整份进了废纸篓");
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
        assert_eq!(entry_kind(&claude.join("gone")), EntryKind::Missing);
    }

    /// 装 skill 撤销与更新走同一个 `hold`：旧版的原处已被新版占着时不覆盖，从暂存格直接移；
    /// 原处空着的（撤销掉的新装）照样先放回原处
    #[test]
    fn release_held_never_overwrites_a_taken_original_spot() {
        let t = TempTree::new();
        let hold_root = t.dir("app/held");
        let old = t.dir("home/.agents/skills/pdf");
        t.file(&old, "v1");
        let held_old = hold(&old, &hold_root).unwrap();
        let fresh = t.dir("home/.agents/skills/pdf");
        t.file(&fresh, "v2");
        let undone = t.dir("home/.agents/skills/docx");
        let held_undone = hold(&undone, &hold_root).unwrap();

        let bin = FakeBin::new(&t);
        assert!(release_held_with(&hold_root, &|p| bin.trash(p)).is_empty());
        let from = bin.from();
        assert_eq!(from.len(), 2);
        assert!(from.contains(&held_old), "原处被占：从暂存格移 {from:?}");
        assert!(from.contains(&undone), "原处空着：从原处移 {from:?}");
        assert!(fresh.join("v2").is_file(), "占着原处的新版原样留着");
        assert_eq!(entry_kind(&fresh.join("v1")), EntryKind::Missing);
        assert_eq!(entry_kind(&held_undone), EntryKind::Missing);
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
    }

    /// 原处的上一级目录没了、原处在应用包里、原处是一条软链（哪怕是断链）、旧版本留下的没有原处记录：
    /// 都不放回原处（不建目录、不往应用包里写、不顺着软链），从暂存格直接移
    #[test]
    fn release_held_trashes_from_the_slot_when_the_original_spot_is_unusable() {
        let t = TempTree::new();
        let hold_root = t.dir("app/held");
        let orphan = t.dir("gone/skills/a");
        let held_orphan = hold(&orphan, &hold_root).unwrap();
        std::fs::remove_dir(t.root().join("gone/skills")).unwrap();
        let in_app = t.dir("Tool.app/Contents/skills/b");
        let held_in_app = hold(&in_app, &hold_root).unwrap();
        let linked = t.dir("home/skills/c");
        let held_linked = hold(&linked, &hold_root).unwrap();
        t.link(&linked, &t.root().join("nowhere"));
        let legacy = t.dir("app/held/1/d");

        let bin = FakeBin::new(&t);
        assert!(release_held_with(&hold_root, &|p| bin.trash(p)).is_empty());
        let mut from = bin.from();
        from.sort();
        let mut want = vec![held_orphan, held_in_app, held_linked, legacy];
        want.sort();
        assert_eq!(from, want);
        assert_eq!(
            entry_kind(&t.root().join("gone/skills")),
            EntryKind::Missing
        );
        assert_eq!(entry_kind(&in_app), EntryKind::Missing);
        assert!(matches!(entry_kind(&linked), EntryKind::Symlink(_)));
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
    }

    /// 放回原处之后移不进废纸篓：挪回暂存格（原处记录也留着），不让删掉的东西悄悄回到原处；
    /// 下次收尾照样从原处移
    #[test]
    fn release_held_moves_back_into_the_slot_when_trashing_fails() {
        let t = TempTree::new();
        let hold_root = t.dir("app/held");
        let body = t.dir("home/.agents/skills/stuck");
        t.file(&body, "SKILL.md");
        let held = hold(&body, &hold_root).unwrap();

        let mut bin = FakeBin::new(&t);
        bin.fail = true;
        let failed = release_held_with(&hold_root, &|p| bin.trash(p));
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, held);
        assert_eq!(bin.from(), vec![body.clone()]);
        assert_eq!(entry_kind(&body), EntryKind::Missing, "没回到原处");
        assert!(held.join("SKILL.md").is_file(), "还在暂存格里");

        bin.fail = false;
        assert!(release_held_with(&hold_root, &|p| bin.trash(p)).is_empty());
        assert_eq!(bin.from().last(), Some(&body));
        assert_eq!(std::fs::read_dir(&hold_root).unwrap().count(), 0);
    }

    /// 体检之后链接被换掉（改指到别处、换成真实目录）：删前重校验不过，跳过并如实上报，不误删。
    #[test]
    fn delete_source_skips_links_that_changed_since_the_plan() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/sophia-test-changed");
        let elsewhere = t.dir("elsewhere/sophia-test-changed");
        let claude = t.dir("home/.claude/skills");
        let codex = t.dir("home/.codex/skills");
        let moved = claude.join("sophia-test-changed");
        let replaced = codex.join("sophia-test-changed");
        t.link(&moved, &body);
        t.link(&replaced, &body);

        let sources = vec![source_at(&store, &["sophia-test-changed"])];
        let targets = vec![
            target_at("claude-code", &claude),
            target_at("codex", &codex),
        ];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        assert_eq!(plan.affected.len(), 2);
        std::fs::remove_file(&moved).unwrap();
        t.link(&moved, &elsewhere);
        std::fs::remove_file(&replaced).unwrap();
        std::fs::create_dir(&replaced).unwrap();

        let bin = FakeBin::new(&t);
        let r = delete_source_holding_with(&plan, None, &|p| bin.trash(p)).0;
        assert_eq!(bin.from(), vec![body.clone()], "原件交给了废纸篓");
        assert_eq!(r.entries[0].outcome, Outcome::Removed);
        for entry in &r.entries[1..] {
            assert_eq!(
                entry.outcome,
                Outcome::Failed("不再是指向该原件的软链接，已跳过".into())
            );
        }
        assert!(same_real(&moved, &elsewhere));
        assert_eq!(entry_kind(&replaced), EntryKind::Dir);
    }

    #[test]
    fn broken_links_kept_unless_clean_requested_and_recheck_before_delete() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        let gone = dst.join("gone.md");
        t.link(&gone, &src.join("gone.md"));
        let broken = || action(ActionKind::BrokenLink, &src.join("gone.md"), &gone);
        let kept = execute(&[broken()], false, LinkStyle::Absolute);
        assert_eq!(outcomes(&kept), vec![Outcome::Skipped]);
        assert!(matches!(entry_kind(&gone), EntryKind::Symlink(_)));
        std::fs::remove_file(&gone).unwrap();
        std::fs::write(&gone, "real").unwrap();
        let guarded = execute(&[broken()], true, LinkStyle::Absolute);
        assert_eq!(
            outcomes(&guarded),
            vec![Outcome::Failed("不再是软链接，已跳过".into())]
        );
        assert_eq!(std::fs::read_to_string(&gone).unwrap(), "real");
        std::fs::remove_file(&gone).unwrap();
        t.link(&gone, &src.join("gone.md"));
        let cleaned = execute(&[broken()], true, LinkStyle::Absolute);
        assert_eq!(outcomes(&cleaned), vec![Outcome::Removed]);
        assert_eq!(entry_kind(&gone), EntryKind::Missing);
    }
}

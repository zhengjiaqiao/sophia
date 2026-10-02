//! 安装记录与查更新的比较（R12–R15，T3 负责）：
//! - `installs.json` 记录的增删查（读写盘在 `store::Store::load_installs` / `save_installs`）；
//! - 把 Sophia 的记录与 `.skill-lock.json` 的条目合成「可查更新的 skill」，按仓库合并出要问 GitHub 的清单；
//! - 拿远端各文件夹的 tree SHA 与记下的比，出 `UpdateInfo`（顺带算本地改没改）；
//! - 「已关掉的一批」：提示条按 × 记下此刻各个新版本的 tree SHA，之后有不同的新版本才再出；
//! - 发现列表的 `✓ 已安装` 与介绍页的 `装在 用户级、CardBox`。
use super::lock::LockEntry;
use super::treehash::{self, FileHashes};
use super::{install, InstallRecord, UpdateInfo, UpdateOrigin};
use crate::fs::{entry_kind, EntryKind};
use crate::skills::GLOBAL_KEY;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

/// 一个可查更新的 skill（来自 `installs.json` 或 lock）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCandidate {
    pub name: String,
    /// 域 key；lock 里的都是 `global`
    pub location: String,
    pub dir: PathBuf,
    /// `owner/repo`
    pub repo: String,
    /// lock 不记分支：None，网络层取默认分支
    pub branch: Option<String>,
    pub path: String,
    pub recorded_tree_sha: String,
    pub origin: UpdateOrigin,
}

/// 一个仓库某分支此刻的 trees（`GET /repos/{o}/{r}/git/trees/{分支}?recursive=1`）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteTree {
    /// 实际的分支名（请求时没给分支就是默认分支）
    pub branch: String,
    /// 仓库内文件夹路径 → tree SHA（仓库根用空串）
    pub folders: BTreeMap<String, String>,
}

/// 远端结果：(`owner/repo`, 请求的分支) → trees
pub type RemoteTrees = BTreeMap<(String, Option<String>), RemoteTree>;

/// 合成可查更新的 skill：先 Sophia 的记录（按记录先后），再 lock 里的（按 lock 先后）。
/// 同一个文件夹两边都有时以 Sophia 的记录为准——从 lock 认出来的更新过一次之后，Sophia 记下的才是
/// 那个文件夹此刻的版本，lock 里的已经过时。认不出位置的记录跳过
pub fn candidates(
    records: &[InstallRecord],
    lock: &[LockEntry],
    home: &Path,
) -> Vec<UpdateCandidate> {
    let mut out: Vec<UpdateCandidate> = records
        .iter()
        .filter_map(|r| {
            let dir = install::store_dir(home, &r.location)?.join(&r.name);
            Some(UpdateCandidate {
                name: r.name.clone(),
                location: r.location.clone(),
                dir,
                repo: r.repo.clone(),
                branch: Some(r.branch.clone()),
                path: r.path.clone(),
                recorded_tree_sha: r.tree_sha.clone(),
                origin: UpdateOrigin::Sophia,
            })
        })
        .collect();
    let store = home.join(".agents").join("skills");
    for entry in lock {
        let dir = store.join(&entry.name);
        if out.iter().any(|c| c.dir == dir) {
            continue;
        }
        out.push(UpdateCandidate {
            name: entry.name.clone(),
            location: GLOBAL_KEY.to_string(),
            dir,
            repo: entry.repo.clone(),
            branch: None,
            path: entry.path.clone(),
            recorded_tree_sha: entry.folder_hash.clone(),
            origin: UpdateOrigin::SkillLock,
        });
    }
    out
}

/// 要问 GitHub 的仓库：按 (`owner/repo`, 分支) 去重，一个仓库一次请求；按首次出现的先后
pub fn repos_to_query(candidates: &[UpdateCandidate]) -> Vec<(String, Option<String>)> {
    let mut seen = BTreeSet::new();
    candidates
        .iter()
        .map(|c| (c.repo.clone(), c.branch.clone()))
        .filter(|key| seen.insert(key.clone()))
        .collect()
}

/// 与远端比较，出有新版本的。不算有更新的：
/// - 这个仓库没查到、远端没有这个文件夹（删了、改名了）；
/// - 远端与记下的相同；
/// - 本地文件夹不在了（被删、被换成链接）：那里已经没装着它；
/// - 本地此刻已经就是远端那一版（别的工具更新过）。
///
/// 本地改没改按 tree SHA 比：算不出（读不了）按改过处理，更新前要确认，宁可多问一句。
/// `changed_files` 在这里总是空的：比较只有 tree SHA，没有记下那一版的逐文件 SHA；
/// 网络层取到后用 `fill_changed_files` 补上
pub fn compare(candidates: &[UpdateCandidate], remote: &RemoteTrees) -> Vec<UpdateInfo> {
    compare_with(candidates, remote, &treehash::tree_sha)
}

pub(crate) fn compare_with(
    candidates: &[UpdateCandidate],
    remote: &RemoteTrees,
    tree_sha: &dyn Fn(&Path) -> io::Result<String>,
) -> Vec<UpdateInfo> {
    let mut out = Vec::new();
    for c in candidates {
        let Some(tree) = remote.get(&(c.repo.clone(), c.branch.clone())) else {
            continue;
        };
        let Some(remote_sha) = tree.folders.get(&c.path) else {
            continue;
        };
        if *remote_sha == c.recorded_tree_sha || entry_kind(&c.dir) != EntryKind::Dir {
            continue;
        }
        let local = tree_sha(&c.dir).ok();
        if local.as_deref() == Some(remote_sha.as_str()) {
            continue;
        }
        out.push(UpdateInfo {
            name: c.name.clone(),
            location: c.location.clone(),
            dir: c.dir.clone(),
            repo: c.repo.clone(),
            branch: tree.branch.clone(),
            path: c.path.clone(),
            origin: c.origin,
            locally_modified: local.as_deref() != Some(c.recorded_tree_sha.as_str()),
            local_tree_sha: local,
            recorded_tree_sha: c.recorded_tree_sha.clone(),
            remote_tree_sha: remote_sha.clone(),
            changed_files: Vec::new(),
        });
    }
    out
}

/// 补上「改过的文件」：`recorded` 是记下那一版的逐文件 blob SHA（网络层按记下的 tree SHA 取）。
/// 没改过的不动；本地读不了时留空
pub fn fill_changed_files(update: &mut UpdateInfo, recorded: &FileHashes) {
    if !update.locally_modified {
        return;
    }
    if let Ok(local) = treehash::file_hashes(&update.dir) {
        update.changed_files = treehash::changed_files(&local, recorded);
    }
}

/// 提示条该不该出：有任何一个新版本的 tree SHA 不在已关掉的那一批里。
/// 没有新版本时不出；调用方先按当前位置筛好 `updates`
pub fn strip_visible(updates: &[UpdateInfo], dismissed: &[String]) -> bool {
    updates
        .iter()
        .any(|u| !dismissed.contains(&u.remote_tree_sha))
}

/// 按 × 时要记下的：此刻各个新版本的 tree SHA（整批替换 `Settings::dismissed_update_shas`），
/// 去重、排序，同一批怎么排都记成一样的
pub fn dismissed_batch(updates: &[UpdateInfo]) -> Vec<String> {
    updates
        .iter()
        .map(|u| u.remote_tree_sha.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 记一条安装记录；同位置同名的旧记录被替换（留在原来的位置上）
pub fn upsert(records: &mut Vec<InstallRecord>, record: InstallRecord) {
    match records
        .iter_mut()
        .find(|r| r.location == record.location && r.name == record.name)
    {
        Some(slot) => *slot = record,
        None => records.push(record),
    }
}

/// 去掉一条安装记录，返回被去掉的
pub fn remove(
    records: &mut Vec<InstallRecord>,
    location: &str,
    name: &str,
) -> Option<InstallRecord> {
    let at = records
        .iter()
        .position(|r| r.location == location && r.name == name)?;
    Some(records.remove(at))
}

/// 这个仓库文件夹装在了哪些位置（域 key，按记录先后、去重）：Sophia 的记录与 lock 都算，
/// lock 里的都在 `global`。路径两侧去掉首尾 `/` 再比
pub fn installed_locations(
    records: &[InstallRecord],
    lock: &[LockEntry],
    repo: &str,
    path: &str,
) -> Vec<String> {
    let path = path.trim_matches('/');
    let same = |r: &str, p: &str| r.eq_ignore_ascii_case(repo) && p.trim_matches('/') == path;
    let mut out: Vec<String> = Vec::new();
    let found = records
        .iter()
        .filter(|r| same(&r.repo, &r.path))
        .map(|r| r.location.clone())
        .chain(
            lock.iter()
                .filter(|e| same(&e.repo, &e.path))
                .map(|_| GLOBAL_KEY.to_string()),
        );
    for location in found {
        if !out.contains(&location) {
            out.push(location);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::install::testkit::fake_tree_sha;
    use crate::skills::project_key;
    use crate::test_support::TempTree;

    fn record(name: &str, location: &str, repo: &str, path: &str, sha: &str) -> InstallRecord {
        InstallRecord {
            name: name.into(),
            location: location.into(),
            repo: repo.into(),
            branch: "main".into(),
            path: path.into(),
            tree_sha: sha.into(),
            commit_sha: "c".into(),
            installed_at: 1,
        }
    }

    fn lock_entry(name: &str, repo: &str, path: &str, sha: &str) -> LockEntry {
        LockEntry {
            name: name.into(),
            repo: repo.into(),
            path: path.into(),
            folder_hash: sha.into(),
        }
    }

    fn info(name: &str, remote: &str) -> UpdateInfo {
        UpdateInfo {
            name: name.into(),
            location: "global".into(),
            dir: PathBuf::from("/x").join(name),
            repo: "o/r".into(),
            branch: "main".into(),
            path: name.into(),
            origin: UpdateOrigin::Sophia,
            local_tree_sha: None,
            recorded_tree_sha: "old".into(),
            remote_tree_sha: remote.into(),
            locally_modified: false,
            changed_files: Vec::new(),
        }
    }

    /// Sophia 的记录与 lock 合并：同一个文件夹以 Sophia 为准；lock 的没有分支、都在用户级
    #[test]
    fn candidates_merge_sophia_over_lock() {
        let home = Path::new("/h");
        let project = Path::new("/w/CardBox");
        let records = vec![
            record("pdf", "global", "anthropics/skills", "skills/pdf", "s-pdf"),
            record(
                "pdf",
                &project_key(project),
                "anthropics/skills",
                "skills/pdf",
                "p-pdf",
            ),
            record("bad", "全部", "o/r", "bad", "x"),
        ];
        let lock = vec![
            lock_entry("pdf", "anthropics/skills", "skills/pdf", "lock-pdf"),
            lock_entry(
                "find-skills",
                "vercel-labs/skills",
                "skills/find-skills",
                "lock-fs",
            ),
        ];
        let c = candidates(&records, &lock, home);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0].dir, PathBuf::from("/h/.agents/skills/pdf"));
        assert_eq!(c[0].recorded_tree_sha, "s-pdf");
        assert_eq!(c[0].origin, UpdateOrigin::Sophia);
        assert_eq!(c[0].branch.as_deref(), Some("main"));
        assert_eq!(c[1].dir, PathBuf::from("/w/CardBox/.agents/skills/pdf"));
        assert_eq!(c[2].name, "find-skills");
        assert_eq!(c[2].location, "global");
        assert_eq!(c[2].branch, None);
        assert_eq!(c[2].origin, UpdateOrigin::SkillLock);
        assert_eq!(c[2].recorded_tree_sha, "lock-fs");

        // 一个仓库一次请求：按 (仓库, 分支) 去重
        assert_eq!(
            repos_to_query(&c),
            vec![
                ("anthropics/skills".to_string(), Some("main".to_string())),
                ("vercel-labs/skills".to_string(), None),
            ]
        );
    }

    /// AC14 / AC15 的比较：远端不同才算；本地改过按 tree SHA 认出；远端没这个文件夹、本地已是新版、
    /// 本地没了的都不算
    #[test]
    fn compare_against_remote() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let pdf = tree.skill("home/.agents/skills/pdf");
        let docx = tree.skill("home/.agents/skills/docx");
        let same = tree.skill("home/.agents/skills/same");
        let gone_name = "gone";
        let pdf_sha = fake_tree_sha(&pdf).unwrap();
        let same_sha = fake_tree_sha(&same).unwrap();
        let docx_recorded = fake_tree_sha(&docx).unwrap();
        std::fs::write(docx.join("SKILL.md"), "我改过").unwrap();

        let records = vec![
            record("pdf", "global", "o/r", "skills/pdf", &pdf_sha),
            record("docx", "global", "o/r", "skills/docx", &docx_recorded),
            record("same", "global", "o/r", "skills/same", "old-same"),
            record(gone_name, "global", "o/r", "skills/gone", "old-gone"),
            record("moved", "global", "o/r", "skills/moved", "old-moved"),
        ];
        let lock = vec![lock_entry("lockd", "l/r", "", "old-lockd")];
        tree.skill("home/.agents/skills/lockd");
        let c = candidates(&records, &lock, &home);
        let remote: RemoteTrees = BTreeMap::from([
            (
                ("o/r".to_string(), Some("main".to_string())),
                RemoteTree {
                    branch: "main".into(),
                    folders: BTreeMap::from([
                        ("skills/pdf".to_string(), "new-pdf".to_string()),
                        ("skills/docx".to_string(), "new-docx".to_string()),
                        // 本地已经是远端这一版
                        ("skills/same".to_string(), same_sha.clone()),
                        ("skills/gone".to_string(), "new-gone".to_string()),
                    ]),
                },
            ),
            (
                ("l/r".to_string(), None),
                RemoteTree {
                    branch: "trunk".into(),
                    folders: BTreeMap::from([(String::new(), "new-lockd".to_string())]),
                },
            ),
        ]);
        let updates = compare_with(&c, &remote, &fake_tree_sha);
        let names: Vec<&str> = updates.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(names, vec!["pdf", "docx", "lockd"]);

        let pdf_u = &updates[0];
        assert!(!pdf_u.locally_modified);
        assert_eq!(pdf_u.local_tree_sha.as_deref(), Some(pdf_sha.as_str()));
        assert_eq!(pdf_u.remote_tree_sha, "new-pdf");
        assert!(pdf_u.changed_files.is_empty());

        let docx_u = &updates[1];
        assert!(docx_u.locally_modified);
        assert_ne!(
            docx_u.local_tree_sha.as_deref(),
            Some(docx_recorded.as_str())
        );

        // lock 的：分支取远端实际的默认分支
        let lockd = &updates[2];
        assert_eq!(lockd.branch, "trunk");
        assert_eq!(lockd.origin, UpdateOrigin::SkillLock);
        assert_eq!(lockd.location, "global");
    }

    /// AC14：按 × 记下这一批 → 提示条不出；有一个出了不同的新版本 → 再出
    #[test]
    fn dismissed_batch_hides_strip_until_new_version() {
        let batch = vec![info("pdf", "p2"), info("docx", "d2"), info("dup", "p2")];
        assert!(strip_visible(&batch, &[]));
        let dismissed = dismissed_batch(&batch);
        assert_eq!(dismissed, vec!["d2".to_string(), "p2".to_string()]);
        assert!(!strip_visible(&batch, &dismissed));
        // 顺序无关
        let reversed: Vec<UpdateInfo> = batch.iter().rev().cloned().collect();
        assert_eq!(dismissed_batch(&reversed), dismissed);
        // 其中一个更新了一次
        let next = vec![info("pdf", "p3"), info("docx", "d2")];
        assert!(strip_visible(&next, &dismissed));
        // 已更新掉一个、剩下的仍是关掉的那一批
        assert!(!strip_visible(&[info("docx", "d2")], &dismissed));
        // 没有更新
        assert!(!strip_visible(&[], &dismissed));
        assert!(!strip_visible(&[], &[]));
    }

    #[test]
    fn upsert_remove_and_installed_locations() {
        let project = project_key(Path::new("/w/CardBox"));
        let mut records = vec![record(
            "pdf",
            "global",
            "anthropics/skills",
            "skills/pdf",
            "a",
        )];
        upsert(
            &mut records,
            record("pdf", &project, "anthropics/skills", "skills/pdf", "b"),
        );
        upsert(
            &mut records,
            record("pdf", "global", "anthropics/skills", "skills/pdf", "c"),
        );
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].tree_sha, "c", "替换留在原位");

        let lock = vec![
            lock_entry("pdf", "anthropics/skills", "skills/pdf", "l"),
            lock_entry("xlsx", "anthropics/skills", "skills/xlsx", "l"),
        ];
        assert_eq!(
            installed_locations(&records, &lock, "anthropics/skills", "/skills/pdf/"),
            vec!["global".to_string(), project.clone()]
        );
        assert_eq!(
            installed_locations(&records, &lock, "anthropics/skills", "skills/xlsx"),
            vec!["global".to_string()]
        );
        assert!(installed_locations(&records, &lock, "o/r", "skills/pdf").is_empty());

        let removed = remove(&mut records, "global", "pdf").unwrap();
        assert_eq!(removed.tree_sha, "c");
        assert_eq!(records.len(), 1);
        assert!(remove(&mut records, "global", "pdf").is_none());
    }
}

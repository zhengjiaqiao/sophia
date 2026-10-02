//! 装 skill 与更新的计划和执行（R9 / R11 / R15，T3 负责）：
//! - 装：落点（位置的通用仓库 `.agents/skills`）、同名拒绝、目录不存在就建并记成这个位置的来源
//!   （复用 `subscriptions`）、给勾选的 agent 建链接（复用 `skills::propose_links` 出动作、
//!   `sync::execute` 执行，直接读 `.agents/skills` 的跳过）、产出安装记录；
//! - 撤销：删掉建的链接（`sync::execute` 的 Unlink，删前重校验仍是指向落点的软链），
//!   新建的文件夹移进暂存（与「删除原件」同一套暂存 `sync::hold`，`sync::release_held` 收尾）；
//! - 更新：本地改没改（tree SHA 比对）、新版先解到落点旁的临时目录、旧版移进暂存、新版改名到原处、
//!   链接不动；撤销＝新版移进暂存、旧版放回。
//!
//! 下载在网络层；这里拿到的是整包字节（`archive::extract` 解包）。
//!
//! 撤销时通用仓库若是这次装时新建的、撤完空了，**留着不删**：空目录无害，扫描里没有 skill 的位置
//! 本来就不出；删它反而要判断「是不是别的工具在这期间也往里放过东西」。
use super::archive::{self, Pick};
use super::{
    installs, treehash, InstallItem, InstallOutcome, InstallPlan, InstallRecord, MarketResult,
    SkillInstallRequest, UpdateInfo,
};
use crate::discovery::{self, Env};
use crate::fs::{entry_kind, normalize, same_real, EntryKind};
use crate::models::*;
use crate::skills::{self, dir_name, project_key, GLOBAL_KEY};
use crate::subscriptions::{self, Subscriptions};
use crate::sync;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

/// 撤销里的一个 skill：这次真正动了盘的
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UndoItem {
    /// 域 key
    pub(crate) location: String,
    pub(crate) name: String,
    /// 这次放到位的文件夹（撤销时移进暂存）
    pub(crate) placed: PathBuf,
    /// 更新时旧版在暂存处的位置（撤销时放回 `placed`）；装时为 None
    pub(crate) held_old: Option<PathBuf>,
    /// 装 / 更新之前的安装记录：新装的、从 lock 认出来的为 None（撤销时去掉这条记录）
    pub(crate) record_before: Option<InstallRecord>,
}

/// 一次装或更新的撤销记录。只能由这里的 `execute_*` 产生；命令层存在内存里，前端只拿 id
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InstallUndo {
    pub(crate) items: Vec<UndoItem>,
    /// 这次建的链接：链接 → 它指向的落点
    pub(crate) links: Vec<(PathBuf, PathBuf)>,
}

impl InstallUndo {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.links.is_empty()
    }
}

/// 解析后的位置
#[derive(Debug, Clone, PartialEq, Eq)]
enum Location {
    Global,
    Project(PathBuf),
}

/// 域 key → 位置。`全部` 之类认不出的为 None；项目路径必须是绝对路径
fn parse_location(key: &str) -> Option<Location> {
    if key == GLOBAL_KEY {
        return Some(Location::Global);
    }
    let path = PathBuf::from(key.strip_prefix("project:")?);
    path.is_absolute()
        .then(|| Location::Project(normalize(&path)))
}

impl Location {
    fn key(&self) -> String {
        match self {
            Location::Global => GLOBAL_KEY.to_string(),
            Location::Project(p) => project_key(p),
        }
    }

    fn store(&self, home: &Path) -> PathBuf {
        let root = match self {
            Location::Global => home,
            Location::Project(p) => p.as_path(),
        };
        root.join(".agents").join("skills")
    }

    /// 同名拒绝那句的开头：`用户级的通用仓库…` / `CardBox 的通用仓库…`
    fn store_phrase(&self) -> String {
        match self {
            Location::Global => crate::t!("market.store.phraseUser"),
            Location::Project(p) => crate::t!("market.store.phraseProject", name = dir_name(p)),
        }
    }

    /// 通用仓库作为来源的样子（与 `discovery::sources` 读进来的同一种类别）
    fn store_source(&self, store: &Path, skills: Vec<Skill>) -> Source {
        let (kind, label) = match self {
            Location::Global => (SourceKind::Universal, crate::t!("sources.name.universal")),
            Location::Project(p) => (
                SourceKind::ProjectStore {
                    project: p.clone(),
                    project_label: None,
                },
                crate::t!("sources.name.projectStore", name = dir_name(p)),
            ),
        };
        Source {
            id: normalize(store).to_string_lossy().into_owned(),
            path: store.to_path_buf(),
            kind,
            label,
            skills,
        }
    }

    /// 链接写法：项目里的通用仓库随项目走（相对），用户级用绝对（同 `skills::link_style`）
    fn link_style(&self) -> LinkStyle {
        match self {
            Location::Global => LinkStyle::Absolute,
            Location::Project(_) => LinkStyle::Relative,
        }
    }
}

/// 写法相同，或解析后相同
fn same_place(a: &Path, b: &Path) -> bool {
    normalize(a) == normalize(b) || same_real(a, b)
}

/// 某个位置的通用仓库：`global` → `<home>/.agents/skills`，`project:<p>` → `<p>/.agents/skills`；
/// 认不出的 key 为 None
pub fn store_dir(home: &Path, location: &str) -> Option<PathBuf> {
    parse_location(location).map(|l| l.store(home))
}

/// 这个位置上本来就直接读通用仓库的 agent（harness 表里的事实）：
/// 用户级只有全局目录就是 `~/.agents/skills` 的（Cline）；项目里是项目目录为 `.agents/skills` 的
fn reads_store_directly(h: &Harness, loc: &Location, store: &Path) -> bool {
    match loc {
        Location::Global => h
            .global_dir
            .as_deref()
            .is_some_and(|d| same_place(d, store)),
        Location::Project(p) => {
            h.universal
                || h.project_dir
                    .as_deref()
                    .is_some_and(|d| same_place(&p.join(d), store))
        }
    }
}

fn harness_of(target: &Target) -> &str {
    match &target.scope {
        TargetScope::Global { harness_id } | TargetScope::Project { harness_id, .. } => harness_id,
    }
}

/// 能当文件夹名：非空、不是 `.` / `..`、不以 `.` 开头（隐藏目录扫描不认）、不含分隔符
fn usable_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\'])
}

/// 装 skill 的计划（安装页据此摆）。只读，不动盘。`harnesses` 是已安装的 agent 表。
///
/// - `direct_readers` 列出 `harnesses` 里所有在这个位置直接读通用仓库的（安装页给每个勾选行写
///   `直接读取，不用链接`，勾没勾都算），外加勾选的 agent 里目录整个链到通用仓库的；
/// - `links` 只给勾选的、其余的 agent 建；那一格已经有东西（别的链接、同名文件夹）的不出动作；
/// - 被拒的 skill 不出链接。
pub fn plan(
    env: &Env,
    harnesses: &[Harness],
    request: &SkillInstallRequest,
) -> MarketResult<InstallPlan> {
    let loc = parse_location(&request.location).ok_or_else(|| {
        crate::t!(
            "market.install.unknownLocation",
            location = request.location
        )
    })?;
    let location = loc.key();
    let store = loc.store(&env.home);
    let store_kind = entry_kind(&store);
    // 判断「目录是否存在」跟随软链：通用仓库本身可以是链到别处的目录
    let creates_store = !store.is_dir();
    let store_taken = creates_store && store_kind != EntryKind::Missing;

    let repo_name = request
        .repo
        .rsplit('/')
        .next()
        .unwrap_or(&request.repo)
        .to_string();
    let mut names = BTreeSet::new();
    let items: Vec<InstallItem> = request
        .paths
        .iter()
        .map(|raw| {
            let path = raw.trim_matches('/').to_string();
            let name = path
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&repo_name)
                .to_string();
            let dest = store.join(&name);
            let blocked = if !usable_name(&name) {
                Some(crate::t!("market.install.badName", name = name))
            } else if store_taken {
                Some(crate::t!(
                    "market.install.storeTaken",
                    store = loc.store_phrase()
                ))
            } else if !names.insert(name.clone()) {
                Some(crate::t!("market.install.dupInBatch", name = name))
            } else if entry_kind(&dest) != EntryKind::Missing {
                Some(crate::t!(
                    "market.install.alreadyThere",
                    store = loc.store_phrase(),
                    name = name
                ))
            } else {
                None
            };
            InstallItem {
                name,
                path,
                dest,
                blocked,
            }
        })
        .collect();

    let ready: Vec<Skill> = items
        .iter()
        .filter(|i| i.blocked.is_none())
        .map(|i| Skill {
            name: i.name.clone(),
            path: i.dest.clone(),
            description: None,
        })
        .collect();
    let source = loc.store_source(&store, ready);

    let chosen: Vec<Harness> = harnesses
        .iter()
        .filter(|h| request.harness_ids.contains(&h.id))
        .cloned()
        .collect();
    let projects: Vec<PathBuf> = match &loc {
        Location::Global => Vec::new(),
        Location::Project(p) => vec![p.clone()],
    };
    let targets: Vec<Target> =
        discovery::targets(env, &chosen, &projects, std::slice::from_ref(&source))
            .into_iter()
            .filter(|t| skills::domain_key(&t.scope) == location)
            .collect();

    let mut direct: BTreeSet<String> = harnesses
        .iter()
        .filter(|h| reads_store_directly(h, &loc, &store))
        .map(|h| h.id.clone())
        .collect();
    // 勾选的 agent 的目录整个就是通用仓库（写法相同、解析后相同、或整目录链过去）：也是直接读
    let mut link_targets = Vec::new();
    for t in targets {
        let id = harness_of(&t).to_string();
        if direct.contains(&id)
            || same_place(&t.path, &store)
            || t.linked_whole_to.as_deref() == Some(source.id.as_str())
        {
            direct.insert(id);
        } else {
            link_targets.push(t);
        }
    }
    let direct_readers: Vec<String> = harnesses
        .iter()
        .filter(|h| direct.contains(&h.id))
        .map(|h| h.id.clone())
        .collect();

    let cells: Vec<CellRef> = link_targets
        .iter()
        .flat_map(|t| {
            source.skills.iter().map(|s| CellRef {
                source_id: source.id.clone(),
                skill: s.name.clone(),
                target_id: t.id.clone(),
            })
        })
        .collect();
    let links = skills::propose_links(std::slice::from_ref(&source), &link_targets, &cells);

    Ok(InstallPlan {
        location,
        store_dir: store,
        creates_store,
        items,
        direct_readers,
        links,
    })
}

/// `archive::extract` 的形状
type ExtractFn = dyn Fn(&[u8], &[Pick]) -> Vec<MarketResult<()>>;

/// 解包、算 tree SHA、读提交 SHA：生产用 T1 / T2 的实现，测试换成不依赖它们的替身
pub(crate) struct Ops<'a> {
    pub(crate) extract: &'a ExtractFn,
    pub(crate) tree_sha: &'a dyn Fn(&Path) -> io::Result<String>,
    pub(crate) commit_sha: &'a dyn Fn(&[u8]) -> MarketResult<String>,
}

fn real_ops() -> Ops<'static> {
    Ops {
        extract: &archive::extract,
        tree_sha: &treehash::tree_sha,
        commit_sha: &archive::commit_sha,
    }
}

/// 按计划装：解包到落点、需要时把通用仓库记进 `subs`、建链接、产出 `records`。
/// `commit_sha` 由调用方先用 `archive::commit_sha` 读出，`now` 是 unix 秒。
///
/// - 计划里被拒的、执行这一刻落点已经有东西的，进 `failed`，不动；
/// - 通用仓库是这个位置自己的来源（`subscriptions::is_own`）：永远算已订阅，按订阅的约定不进
///   记录；扫描时 `discovery::sources` 把它读进来，来源下拉里就有它。只有它不算自己的来源时才记；
/// - 链接只给真正放到位的 skill 建；
/// - 放到位但算不出 tree SHA 的（解包后又被动了、读不了）照样算装好，只是不写安装记录：
///   没有记下的版本就无从比较更新。
pub fn execute(
    plan: &InstallPlan,
    archive: &[u8],
    commit_sha: &str,
    repo: &str,
    branch: &str,
    now: u64,
    subs: &mut Subscriptions,
) -> InstallOutcome {
    let source = Provenance {
        archive,
        commit_sha,
        repo,
        branch,
        now,
    };
    execute_with(plan, &source, subs, &real_ops())
}

/// 这次装的包与它的来历
pub(crate) struct Provenance<'a> {
    pub(crate) archive: &'a [u8],
    pub(crate) commit_sha: &'a str,
    pub(crate) repo: &'a str,
    pub(crate) branch: &'a str,
    pub(crate) now: u64,
}

pub(crate) fn execute_with(
    plan: &InstallPlan,
    from: &Provenance,
    subs: &mut Subscriptions,
    ops: &Ops,
) -> InstallOutcome {
    let mut out = InstallOutcome::default();
    let Some(loc) = parse_location(&plan.location) else {
        for item in &plan.items {
            out.failed.insert(
                item.name.clone(),
                crate::t!("market.install.unknownLocation", location = plan.location),
            );
        }
        return out;
    };
    let mut ready: Vec<&InstallItem> = Vec::new();
    for item in &plan.items {
        if let Some(reason) = &item.blocked {
            out.failed.insert(item.name.clone(), reason.clone());
        } else if entry_kind(&item.dest) != EntryKind::Missing {
            // 出计划到按下安装之间，别的工具可能已经放了同名的：不覆盖
            out.failed.insert(
                item.name.clone(),
                crate::t!(
                    "market.install.alreadyThere",
                    store = loc.store_phrase(),
                    name = item.name
                ),
            );
        } else {
            ready.push(item);
        }
    }
    if ready.is_empty() {
        return out;
    }

    if !plan.store_dir.is_dir() {
        if let Err(e) = std::fs::create_dir_all(&plan.store_dir) {
            for item in ready {
                out.failed.insert(
                    item.name.clone(),
                    crate::t!("market.install.mkStoreFailed", error = e),
                );
            }
            return out;
        }
    }
    subscribe_store(subs, &loc, &plan.store_dir);

    let picks: Vec<Pick> = ready
        .iter()
        .map(|i| Pick {
            path: i.path.clone(),
            dest: i.dest.clone(),
        })
        .collect();
    let mut results = (ops.extract)(from.archive, &picks).into_iter();
    let mut placed: Vec<&InstallItem> = Vec::new();
    for item in ready {
        match results.next() {
            Some(Ok(())) if entry_kind(&item.dest) == EntryKind::Dir => placed.push(item),
            Some(Ok(())) => {
                out.failed.insert(
                    item.name.clone(),
                    crate::t!("market.install.notDirAfterExtract"),
                );
            }
            Some(Err(e)) => {
                out.failed.insert(item.name.clone(), e);
            }
            None => {
                out.failed.insert(
                    item.name.clone(),
                    crate::t!("market.install.noExtractResult"),
                );
            }
        }
    }

    let dests: BTreeSet<&Path> = placed.iter().map(|i| i.dest.as_path()).collect();
    let actions: Vec<PlannedAction> = plan
        .links
        .iter()
        .filter(|a| a.kind == ActionKind::Create && dests.contains(a.source_path.as_path()))
        .cloned()
        .collect();
    out.links = sync::execute(&actions, false, loc.link_style());
    out.undo.links = out
        .links
        .entries
        .iter()
        .filter(|e| e.outcome == Outcome::Created)
        .map(|e| (e.action.target_path.clone(), e.action.source_path.clone()))
        .collect();

    for item in placed {
        out.installed.push(item.name.clone());
        if let Ok(tree_sha) = (ops.tree_sha)(&item.dest) {
            out.records.push(InstallRecord {
                name: item.name.clone(),
                location: plan.location.clone(),
                repo: from.repo.to_string(),
                branch: from.branch.to_string(),
                path: item.path.clone(),
                tree_sha,
                commit_sha: from.commit_sha.to_string(),
                installed_at: from.now,
            });
        }
        out.undo.items.push(UndoItem {
            location: plan.location.clone(),
            name: item.name.clone(),
            placed: item.dest.clone(),
            held_old: None,
            record_before: None,
        });
    }
    out
}

/// 通用仓库成为这个位置的来源：它是这个位置自己的来源时（用户级的 `~/.agents/skills`、
/// 项目的 `<项目>/.agents/skills` 都是）天然已订阅，不进记录；否则记下
fn subscribe_store(subs: &mut Subscriptions, loc: &Location, store: &Path) {
    let key = loc.key();
    let source = loc.store_source(store, Vec::new());
    if subscriptions::is_own(&source, &key, &[]) {
        return;
    }
    subs.entry(key).or_default().insert(normalize(store));
}

/// 更新这些 skill。`archives`：(`owner/repo`, 分支) → 整包字节；`records` 是此刻的 `installs.json`
/// （撤销时要把更新前的那条放回去）。
/// 本地改过的只有 `overwrite_modified` 为真才覆盖，否则记进 `failed`。旧版挪进 `hold_root`。
/// 改没改在这一刻重算（查更新之后用户可能又动过），算不出按改过处理。
/// 更新后的记录进 `records`，从 lock 认出来的也记一条 Sophia 的：以后以它为准
pub fn execute_update(
    updates: &[UpdateInfo],
    records: &[InstallRecord],
    archives: &BTreeMap<(String, String), Vec<u8>>,
    overwrite_modified: bool,
    hold_root: &Path,
    now: u64,
) -> InstallOutcome {
    let batch = UpdateBatch {
        records,
        archives,
        overwrite_modified,
        hold_root,
        now,
    };
    execute_update_with(updates, &batch, &real_ops())
}

pub(crate) struct UpdateBatch<'a> {
    pub(crate) records: &'a [InstallRecord],
    pub(crate) archives: &'a BTreeMap<(String, String), Vec<u8>>,
    pub(crate) overwrite_modified: bool,
    pub(crate) hold_root: &'a Path,
    pub(crate) now: u64,
}

pub(crate) fn execute_update_with(
    updates: &[UpdateInfo],
    batch: &UpdateBatch,
    ops: &Ops,
) -> InstallOutcome {
    let mut out = InstallOutcome::default();
    for u in updates {
        match update_one(u, batch, ops) {
            Ok((record, item)) => {
                out.installed.push(u.name.clone());
                out.records.extend(record);
                out.undo.items.push(item);
            }
            Err(reason) => {
                out.failed.insert(u.name.clone(), reason);
            }
        }
    }
    out
}

fn update_one(
    u: &UpdateInfo,
    batch: &UpdateBatch,
    ops: &Ops,
) -> Result<(Option<InstallRecord>, UndoItem), String> {
    let Some(bytes) = batch.archives.get(&(u.repo.clone(), u.branch.clone())) else {
        return Err(crate::t!("market.update.noDownload"));
    };
    // 落点本身是链接时不顺着它去改别处的原件
    if entry_kind(&u.dir) != EntryKind::Dir {
        return Err(crate::t!("market.update.localGone"));
    }
    let local = (ops.tree_sha)(&u.dir).ok();
    let modified = local.as_deref() != Some(u.recorded_tree_sha.as_str());
    if modified && !batch.overwrite_modified {
        return Err(crate::t!("market.update.localModified", name = u.name));
    }
    let parent = u
        .dir
        .parent()
        .ok_or_else(|| crate::t!("market.update.noParent"))?;

    // 新版先解到落点旁边的临时目录（同盘，放到位是一次改名）；点开头，扫描不认
    let temp = parent.join(format!(".sophia-update-{}", stamp()));
    let fresh = temp.join(&u.name);
    let pick = Pick {
        path: u.path.clone(),
        dest: fresh.clone(),
    };
    let extracted = (ops.extract)(bytes, std::slice::from_ref(&pick))
        .into_iter()
        .next()
        .unwrap_or_else(|| Err(crate::t!("market.install.noExtractResult")));
    let cleanup = || {
        if entry_kind(&temp) == EntryKind::Dir {
            let _ = std::fs::remove_dir_all(&temp);
        }
    };
    if let Err(e) = extracted {
        cleanup();
        return Err(e);
    }
    if entry_kind(&fresh) != EntryKind::Dir {
        cleanup();
        return Err(crate::t!("market.update.freshNotDir"));
    }

    let held = match sync::hold(&u.dir, batch.hold_root) {
        Ok(held) => held,
        Err(e) => {
            cleanup();
            return Err(crate::t!("market.update.holdFailed", error = e));
        }
    };
    if let Err(e) = std::fs::rename(&fresh, &u.dir) {
        // 新版放不到位：旧版放回原处
        let _ = std::fs::rename(&held, &u.dir);
        if let Some(slot) = held.parent() {
            sync::drop_slot(slot);
        }
        cleanup();
        return Err(crate::t!("market.update.placeFailed", error = e));
    }
    let _ = std::fs::remove_dir(&temp);

    let record_before = batch
        .records
        .iter()
        .find(|r| r.location == u.location && r.name == u.name)
        .cloned();
    let record = (ops.tree_sha)(&u.dir).ok().map(|tree_sha| InstallRecord {
        name: u.name.clone(),
        location: u.location.clone(),
        repo: u.repo.clone(),
        branch: u.branch.clone(),
        path: u.path.clone(),
        tree_sha,
        commit_sha: (ops.commit_sha)(bytes).unwrap_or_default(),
        installed_at: batch.now,
    });
    let item = UndoItem {
        location: u.location.clone(),
        name: u.name.clone(),
        placed: u.dir.clone(),
        held_old: Some(held),
        record_before,
    };
    Ok((record, item))
}

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn parent_of(path: &Path) -> PathBuf {
    path.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// 撤销一次装或更新：链接删掉、放到位的移进 `hold_root`、旧版放回，`records` 还原。
/// 每一步先看现场，被改过的不动、如实上报：
/// - 链接仍是指向落点的软链才删（`sync::execute` 的 Unlink 删前重校验），先于挪文件夹做；
/// - 放到位的仍是真实文件夹才挪；挪不进暂存处（跨磁盘等）退回移进废纸篓；
/// - 旧版只在新版已挪走、原处空着时放回；
/// - 文件夹这一步成了，才还原它的安装记录（新装的去掉，更新的放回更新前那条；
///   新版挪走了而旧版没放回的也去掉——那里已经没有东西）。
///
/// 通用仓库是这次新建的、撤完空了，也留着（见模块说明）
pub fn undo(undo: &InstallUndo, hold_root: &Path, records: &mut Vec<InstallRecord>) -> SyncReport {
    let unlinks: Vec<PlannedAction> = undo
        .links
        .iter()
        .map(|(link, dest)| PlannedAction {
            kind: ActionKind::Unlink,
            item_name: file_name(link),
            source_path: dest.clone(),
            target_path: link.clone(),
            target: parent_of(link),
        })
        .collect();
    let mut entries = sync::execute(&unlinks, false, LinkStyle::Absolute).entries;

    for item in &undo.items {
        let away = move_away(&item.placed, hold_root);
        let moved = away.outcome == Outcome::Removed;
        entries.push(away);
        let mut restored = item.held_old.is_none();
        if let Some(held) = &item.held_old {
            let back = put_back(held, &item.placed, moved);
            restored = back.outcome == Outcome::Created;
            entries.push(back);
        }
        if moved {
            installs::remove(records, &item.location, &item.name);
            if let (true, Some(before)) = (restored, &item.record_before) {
                installs::upsert(records, before.clone());
            }
        }
    }
    SyncReport { entries }
}

/// 放到位的文件夹移进暂存；挪不过去退回废纸篓（`sync::trash` 同样先重校验是真实目录）
fn move_away(placed: &Path, hold_root: &Path) -> ReportEntry {
    let action = PlannedAction {
        kind: ActionKind::DeleteSource,
        item_name: file_name(placed),
        source_path: placed.to_path_buf(),
        target_path: placed.to_path_buf(),
        target: parent_of(placed),
    };
    let outcome = if entry_kind(placed) != EntryKind::Dir {
        Outcome::Failed(crate::t!("market.undo.placedGone"))
    } else {
        match sync::hold(placed, hold_root)
            .map(|_| ())
            .or_else(|_| sync::trash(placed))
        {
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

/// 更新前的旧版从暂存处放回原处
fn put_back(held: &Path, orig: &Path, new_moved: bool) -> ReportEntry {
    let action = PlannedAction {
        kind: ActionKind::Create,
        item_name: file_name(orig),
        source_path: held.to_path_buf(),
        target_path: orig.to_path_buf(),
        target: parent_of(orig),
    };
    let outcome = if !new_moved {
        Outcome::Failed(crate::t!("market.undo.freshNotMoved"))
    } else if entry_kind(orig) != EntryKind::Missing {
        Outcome::Failed(crate::t!("market.undo.origOccupied"))
    } else if entry_kind(held) != EntryKind::Dir {
        Outcome::Failed(crate::t!("market.undo.heldGone"))
    } else {
        match std::fs::rename(held, orig) {
            Ok(()) => {
                if let Some(slot) = held.parent() {
                    sync::drop_slot(slot);
                }
                Outcome::Created
            }
            Err(e) => Outcome::Failed(e.to_string()),
        }
    };
    ReportEntry {
        action,
        outcome,
        fail_kind: None,
    }
}

/// 测试用的替身：不依赖 T1 / T2 的实现。包字节就是 `SKILL.md` 的正文，不同字节＝不同版本
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use sha1::{Digest, Sha1};

    pub(crate) fn fake_extract(archive: &[u8], picks: &[Pick]) -> Vec<MarketResult<()>> {
        picks
            .iter()
            .map(|p| {
                if entry_kind(&p.dest) != EntryKind::Missing {
                    return Err("落点已经有东西".to_string());
                }
                std::fs::create_dir_all(&p.dest).map_err(|e| e.to_string())?;
                let name = file_name(&p.dest);
                let body = String::from_utf8_lossy(archive);
                std::fs::write(
                    p.dest.join("SKILL.md"),
                    format!("---\nname: {name}\n---\n{body}"),
                )
                .map_err(|e| e.to_string())
            })
            .collect()
    }

    /// 按相对路径排序后把路径与内容一起算 SHA-1：只求「内容一样 ⇔ 指纹一样」，不是 git 的算法
    pub(crate) fn fake_tree_sha(dir: &Path) -> io::Result<String> {
        if entry_kind(dir) != EntryKind::Dir {
            return Err(io::Error::other("不是文件夹"));
        }
        let mut files = Vec::new();
        walk(dir, dir, &mut files)?;
        files.sort();
        let mut hasher = Sha1::new();
        for (rel, bytes) in files {
            hasher.update(rel.as_bytes());
            hasher.update([0]);
            hasher.update(&bytes);
            hasher.update([0]);
        }
        Ok(hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }

    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> io::Result<()> {
        for e in std::fs::read_dir(dir)? {
            let path = e?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, std::fs::read(&path)?));
            }
        }
        Ok(())
    }

    pub(crate) fn fake_commit(_: &[u8]) -> MarketResult<String> {
        Ok("c".repeat(40))
    }

    pub(crate) fn ops() -> Ops<'static> {
        Ops {
            extract: &fake_extract,
            tree_sha: &fake_tree_sha,
            commit_sha: &fake_commit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::market::UpdateOrigin;
    use crate::test_support::TempTree;
    use std::collections::HashMap;

    fn env_at(home: &Path) -> Env {
        Env {
            home: home.to_path_buf(),
            vars: HashMap::new(),
        }
    }

    /// harness 表里的真实条目（路径按临时 HOME 解析）
    fn harnesses(env: &Env, ids: &[&str]) -> Vec<Harness> {
        discovery::all_harnesses(env)
            .into_iter()
            .filter(|h| ids.contains(&h.id.as_str()))
            .collect()
    }

    fn request(location: &str, paths: &[&str], ids: &[&str]) -> SkillInstallRequest {
        SkillInstallRequest {
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            location: location.into(),
            harness_ids: ids.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn provenance(archive: &[u8]) -> Provenance<'_> {
        Provenance {
            archive,
            commit_sha: "abc123",
            repo: "anthropics/skills",
            branch: "main",
            now: 1_700_000_000,
        }
    }

    /// 整棵树的样子：相对路径 → 类别与内容（文件读内容，软链读写着的目标）
    fn snapshot(root: &Path) -> BTreeMap<String, String> {
        fn go(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let path = e.path();
                let rel = path.strip_prefix(root).unwrap().display().to_string();
                match entry_kind(&path) {
                    EntryKind::Symlink(to) => {
                        out.insert(rel, format!("link {}", to.display()));
                    }
                    EntryKind::Dir => {
                        out.insert(rel, "dir".into());
                        go(root, &path, out);
                    }
                    _ => {
                        out.insert(rel, std::fs::read_to_string(&path).unwrap_or_default());
                    }
                }
            }
        }
        let mut out = BTreeMap::new();
        go(root, root, &mut out);
        out
    }

    #[test]
    fn store_dir_by_location() {
        let home = Path::new("/h");
        assert_eq!(
            store_dir(home, "global"),
            Some(PathBuf::from("/h/.agents/skills"))
        );
        assert_eq!(
            store_dir(home, "project:/p/CardBox"),
            Some(PathBuf::from("/p/CardBox/.agents/skills"))
        );
        assert_eq!(store_dir(home, "all"), None);
        assert_eq!(store_dir(home, "project:relative"), None);
    }

    /// AC8 计划：用户级、通用仓库不存在 → 会创建；Cline 直接读，只给 Claude Code 与 Codex 建链接
    #[test]
    fn plan_user_level_creates_store_and_links_the_rest() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        tree.dir("home/.claude/skills");
        let env = env_at(&home);
        let hs = harnesses(&env, &["claude-code", "codex", "cline"]);
        let plan = plan(
            &env,
            &hs,
            &request(
                "global",
                &["skills/pdf"],
                &["claude-code", "codex", "cline"],
            ),
        )
        .unwrap();
        assert_eq!(plan.location, "global");
        assert_eq!(plan.store_dir, home.join(".agents/skills"));
        assert!(plan.creates_store);
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].name, "pdf");
        assert_eq!(plan.items[0].path, "skills/pdf");
        assert_eq!(plan.items[0].dest, home.join(".agents/skills/pdf"));
        assert_eq!(plan.items[0].blocked, None);
        assert_eq!(plan.direct_readers, vec!["cline".to_string()]);
        let links: BTreeSet<PathBuf> = plan.links.iter().map(|a| a.target_path.clone()).collect();
        assert_eq!(
            links,
            BTreeSet::from([
                home.join(".claude/skills/pdf"),
                home.join(".codex/skills/pdf")
            ])
        );
        assert!(plan
            .links
            .iter()
            .all(|a| a.kind == ActionKind::Create && a.source_path == plan.items[0].dest));
    }

    /// AC10：装到项目，直接读 `.agents/skills` 的 agent（harness 表里 9 家）不建链接
    #[test]
    fn plan_project_level_direct_readers() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let project = tree.dir("work/CardBox");
        tree.dir("work/CardBox/.agents/skills");
        let env = env_at(&home);
        let all = discovery::all_harnesses(&env);
        let location = project_key(&project);
        let plan = plan(
            &env,
            &all,
            &request(
                &location,
                &["skills/pdf"],
                &["claude-code", "codex", "cursor"],
            ),
        )
        .unwrap();
        assert!(!plan.creates_store);
        assert_eq!(plan.store_dir, project.join(".agents/skills"));
        let expected: Vec<String> = all
            .iter()
            .filter(|h| h.project_dir.as_deref() == Some(".agents/skills"))
            .map(|h| h.id.clone())
            .collect();
        assert_eq!(plan.direct_readers, expected);
        assert!(plan.direct_readers.contains(&"codex".to_string()));
        assert!(plan.direct_readers.contains(&"cursor".to_string()));
        assert!(!plan.direct_readers.contains(&"claude-code".to_string()));
        assert_eq!(plan.links.len(), 1);
        assert_eq!(
            plan.links[0].target_path,
            project.join(".claude/skills/pdf")
        );
    }

    /// AC9：通用仓库里已有同名的 → 拒绝、不出链接；项目的那句带项目名
    #[test]
    fn plan_blocks_existing_names() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        tree.skill("home/.agents/skills/pdf");
        let project = tree.dir("work/CardBox");
        tree.skill("work/CardBox/.agents/skills/pdf");
        let env = env_at(&home);
        let hs = harnesses(&env, &["claude-code"]);

        let user = plan(
            &env,
            &hs,
            &request("global", &["skills/pdf", "skills/docx"], &["claude-code"]),
        )
        .unwrap();
        assert_eq!(
            user.items[0].blocked.as_deref(),
            Some("~/.agents 里已经有 pdf")
        );
        assert_eq!(user.items[1].blocked, None);
        assert_eq!(user.links.len(), 1);
        assert_eq!(user.links[0].item_name, "docx");

        let proj = plan(
            &env,
            &hs,
            &request(&project_key(&project), &["skills/pdf"], &["claude-code"]),
        )
        .unwrap();
        assert_eq!(
            proj.items[0].blocked.as_deref(),
            Some("CardBox/.agents 里已经有 pdf")
        );
        assert!(proj.links.is_empty());

        // 执行时照样不动：文件不变、进 failed
        let before = snapshot(&tree.root());
        let mut subs = Subscriptions::new();
        let out = execute_with(&proj, &provenance(b"v1"), &mut subs, &ops());
        assert!(out.installed.is_empty());
        assert_eq!(
            out.failed.get("pdf").map(String::as_str),
            Some("CardBox/.agents 里已经有 pdf")
        );
        assert_eq!(snapshot(&tree.root()), before);
    }

    #[test]
    fn plan_names_repo_root_and_duplicates() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let env = env_at(&home);
        let plan = plan(
            &env,
            &[],
            &request("global", &["", "a/skills", "b/skills"], &[]),
        )
        .unwrap();
        // 仓库根取仓库名
        assert_eq!(plan.items[0].name, "skills");
        assert_eq!(
            plan.items[1].blocked.as_deref(),
            Some("这次要装的里已经有一个 skills")
        );
        assert!(plan.items[2].blocked.is_some());
        assert!(plan_err("全部"));
    }

    fn plan_err(location: &str) -> bool {
        let env = env_at(Path::new("/nonexistent"));
        plan(&env, &[], &request(location, &["x"], &[])).is_err()
    }

    /// AC8 + AC13：装完落点有 SKILL.md、链接指向它、记下来历；撤销后链接删掉、文件夹进暂存、
    /// 树回到装之前的样子
    #[test]
    fn execute_then_undo_round_trip() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        tree.dir("home/.claude/skills");
        tree.dir("home/.codex/skills");
        tree.dir("home/.agents/skills");
        let hold_root = tree.dir("hold");
        let env = env_at(&home);
        let hs = harnesses(&env, &["claude-code", "codex"]);
        let plan = plan(
            &env,
            &hs,
            &request("global", &["skills/pdf"], &["claude-code", "codex"]),
        )
        .unwrap();
        let before = snapshot(&home);

        let mut subs = Subscriptions::new();
        let mut out = execute_with(&plan, &provenance(b"v1"), &mut subs, &ops());
        assert_eq!(out.installed, vec!["pdf".to_string()]);
        assert!(out.failed.is_empty());
        let dest = home.join(".agents/skills/pdf");
        assert!(dest.join("SKILL.md").is_file());
        for dir in [".claude/skills/pdf", ".codex/skills/pdf"] {
            let link = home.join(dir);
            assert!(matches!(entry_kind(&link), EntryKind::Symlink(_)));
            assert!(same_real(&link, &dest));
        }
        assert!(out
            .links
            .entries
            .iter()
            .all(|e| e.outcome == Outcome::Created));
        // 用户级的通用仓库是自己的来源：不进订阅记录
        assert!(subs.is_empty());
        assert_eq!(out.records.len(), 1);
        let rec = &out.records[0];
        assert_eq!(
            (rec.name.as_str(), rec.location.as_str(), rec.repo.as_str()),
            ("pdf", "global", "anthropics/skills")
        );
        assert_eq!(
            (rec.branch.as_str(), rec.path.as_str()),
            ("main", "skills/pdf")
        );
        assert_eq!(rec.tree_sha, fake_tree_sha(&dest).unwrap());
        assert_eq!(rec.commit_sha, "abc123");
        assert_eq!(rec.installed_at, 1_700_000_000);

        let mut records = out.records.clone();
        let undo_rec = out.take_undo().expect("有撤销记录");
        let report = undo(&undo_rec, &hold_root, &mut records);
        assert!(
            report
                .entries
                .iter()
                .all(|e| matches!(e.outcome, Outcome::Removed)),
            "{report:?}"
        );
        assert!(records.is_empty());
        assert_eq!(snapshot(&home), before);
        // 文件夹在暂存处，不是删了
        let held: Vec<_> = snapshot(&hold_root)
            .into_keys()
            .filter(|k| k.ends_with("pdf/SKILL.md"))
            .collect();
        assert_eq!(held.len(), 1);
    }

    /// 通用仓库不存在时建出来；撤销后留着这个空目录（见模块说明），其余不变
    #[test]
    fn execute_creates_store_and_undo_leaves_it() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        tree.dir("home/.claude/skills");
        let hold_root = tree.dir("hold");
        let env = env_at(&home);
        let hs = harnesses(&env, &["claude-code"]);
        let plan = plan(
            &env,
            &hs,
            &request("global", &["skills/pdf"], &["claude-code"]),
        )
        .unwrap();
        assert!(plan.creates_store);
        let before = snapshot(&home);
        let mut subs = Subscriptions::new();
        let mut out = execute_with(&plan, &provenance(b"v1"), &mut subs, &ops());
        assert_eq!(out.installed, vec!["pdf".to_string()]);
        assert!(home.join(".agents/skills/pdf/SKILL.md").is_file());
        let mut records = out.records.clone();
        undo(&out.take_undo().unwrap(), &hold_root, &mut records);
        let mut after = snapshot(&home);
        assert_eq!(after.remove(".agents/skills").as_deref(), Some("dir"));
        assert_eq!(after.remove(".agents").as_deref(), Some("dir"));
        assert_eq!(after, before);
    }

    /// 撤销前链接被换成了别处：不删它、如实上报；文件夹照样进暂存
    #[test]
    fn undo_skips_replaced_links() {
        let tree = TempTree::new();
        let home = tree.dir("home");
        tree.dir("home/.claude/skills");
        tree.dir("home/.agents/skills");
        let other = tree.skill("elsewhere/pdf");
        let hold_root = tree.dir("hold");
        let env = env_at(&home);
        let hs = harnesses(&env, &["claude-code"]);
        let plan = plan(
            &env,
            &hs,
            &request("global", &["skills/pdf"], &["claude-code"]),
        )
        .unwrap();
        let mut subs = Subscriptions::new();
        let mut out = execute_with(&plan, &provenance(b"v1"), &mut subs, &ops());
        let link = home.join(".claude/skills/pdf");
        std::fs::remove_file(&link).unwrap();
        tree.link(&link, &other);

        let mut records = out.records.clone();
        let report = undo(&out.take_undo().unwrap(), &hold_root, &mut records);
        assert!(matches!(report.entries[0].outcome, Outcome::Failed(_)));
        assert!(same_real(&link, &other), "别处的链接原样留着");
        assert_eq!(
            entry_kind(&home.join(".agents/skills/pdf")),
            EntryKind::Missing
        );
        assert!(records.is_empty());
    }

    /// 已经装着的一个 skill：v1 的文件夹 + 一条链接 + 一条安装记录
    struct Installed {
        tree: TempTree,
        dir: PathBuf,
        link: PathBuf,
        hold_root: PathBuf,
        record: InstallRecord,
    }

    fn installed_v1() -> Installed {
        let tree = TempTree::new();
        let home = tree.dir("home");
        let hold_root = tree.dir("hold");
        let dir = home.join(".agents/skills/pdf");
        fake_extract(
            b"v1",
            &[Pick {
                path: "skills/pdf".into(),
                dest: dir.clone(),
            }],
        );
        std::fs::write(dir.join("helper.py"), "print(1)\n").unwrap();
        tree.dir("home/.claude/skills");
        let link = home.join(".claude/skills/pdf");
        tree.link(&link, &dir);
        let record = InstallRecord {
            name: "pdf".into(),
            location: "global".into(),
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            path: "skills/pdf".into(),
            tree_sha: fake_tree_sha(&dir).unwrap(),
            commit_sha: "old".into(),
            installed_at: 1,
        };
        Installed {
            tree,
            dir,
            link,
            hold_root,
            record,
        }
    }

    fn update_info(s: &Installed) -> UpdateInfo {
        let local = fake_tree_sha(&s.dir).unwrap();
        UpdateInfo {
            name: "pdf".into(),
            location: "global".into(),
            dir: s.dir.clone(),
            repo: "anthropics/skills".into(),
            branch: "main".into(),
            path: "skills/pdf".into(),
            origin: UpdateOrigin::Sophia,
            locally_modified: local != s.record.tree_sha,
            local_tree_sha: Some(local),
            recorded_tree_sha: s.record.tree_sha.clone(),
            remote_tree_sha: "remote-v2".into(),
            changed_files: Vec::new(),
        }
    }

    fn archives_v2() -> BTreeMap<(String, String), Vec<u8>> {
        BTreeMap::from([(
            ("anthropics/skills".to_string(), "main".to_string()),
            b"v2".to_vec(),
        )])
    }

    /// AC15：没改过 → 直接更新，链接不动，记录更新；撤销 → 旧版逐字节放回、记录还原
    #[test]
    fn update_unmodified_then_undo_restores_old_bytes() {
        let s = installed_v1();
        let before = snapshot(&s.tree.root().join("home"));
        let records = vec![s.record.clone()];
        let archives = archives_v2();
        let batch = UpdateBatch {
            records: &records,
            archives: &archives,
            overwrite_modified: false,
            hold_root: &s.hold_root,
            now: 99,
        };
        let mut out = execute_update_with(&[update_info(&s)], &batch, &ops());
        assert_eq!(out.installed, vec!["pdf".to_string()]);
        assert!(out.failed.is_empty());
        let text = std::fs::read_to_string(s.dir.join("SKILL.md")).unwrap();
        assert!(text.ends_with("v2"));
        assert_eq!(
            entry_kind(&s.dir.join("helper.py")),
            EntryKind::Missing,
            "新版整个换上，旧文件不留"
        );
        assert!(same_real(&s.link, &s.dir), "链接不动");
        // 落点旁的临时目录不留
        let leftovers: Vec<_> = std::fs::read_dir(s.dir.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["pdf".to_string()]);
        let rec = &out.records[0];
        assert_eq!(rec.tree_sha, fake_tree_sha(&s.dir).unwrap());
        assert_eq!(rec.installed_at, 99);
        assert_eq!(rec.commit_sha, "c".repeat(40));

        let mut current = records.clone();
        installs::upsert(&mut current, rec.clone());
        let report = undo(&out.take_undo().unwrap(), &s.hold_root, &mut current);
        assert!(
            report
                .entries
                .iter()
                .all(|e| matches!(e.outcome, Outcome::Removed | Outcome::Created)),
            "{report:?}"
        );
        assert_eq!(snapshot(&s.tree.root().join("home")), before);
        assert_eq!(current, vec![s.record.clone()]);
    }

    /// AC15：本地改过 → 不带 overwrite 就跳过、文件不变；带了才覆盖
    #[test]
    fn update_locally_modified_needs_overwrite() {
        let s = installed_v1();
        std::fs::write(s.dir.join("SKILL.md"), "我改过").unwrap();
        let info = update_info(&s);
        assert!(info.locally_modified);
        let before = snapshot(&s.tree.root());
        let records = vec![s.record.clone()];
        let archives = archives_v2();
        let mut batch = UpdateBatch {
            records: &records,
            archives: &archives,
            overwrite_modified: false,
            hold_root: &s.hold_root,
            now: 99,
        };
        let out = execute_update_with(std::slice::from_ref(&info), &batch, &ops());
        assert!(out.installed.is_empty());
        assert_eq!(
            out.failed.get("pdf").map(String::as_str),
            Some("pdf 本地改过，没有覆盖")
        );
        assert!(out.undo.is_empty());
        assert_eq!(snapshot(&s.tree.root()), before);

        batch.overwrite_modified = true;
        let mut out = execute_update_with(&[info], &batch, &ops());
        assert_eq!(out.installed, vec!["pdf".to_string()]);
        assert!(std::fs::read_to_string(s.dir.join("SKILL.md"))
            .unwrap()
            .ends_with("v2"));
        // 撤销放回的是改过的那一版
        let mut current = out.records.clone();
        undo(&out.take_undo().unwrap(), &s.hold_root, &mut current);
        assert_eq!(
            std::fs::read_to_string(s.dir.join("SKILL.md")).unwrap(),
            "我改过"
        );
    }

    /// 查更新之后本地又被改了：执行这一刻重算，照样拦下
    #[test]
    fn update_rechecks_local_changes() {
        let s = installed_v1();
        let info = update_info(&s);
        assert!(!info.locally_modified);
        std::fs::write(s.dir.join("helper.py"), "print(2)\n").unwrap();
        let records = vec![s.record.clone()];
        let archives = archives_v2();
        let batch = UpdateBatch {
            records: &records,
            archives: &archives,
            overwrite_modified: false,
            hold_root: &s.hold_root,
            now: 99,
        };
        let out = execute_update_with(&[info], &batch, &ops());
        assert!(out.failed.contains_key("pdf"));
    }

    /// 从 lock 认出来的：更新后记一条 Sophia 的；撤销时去掉它（更新前没有 Sophia 的记录）
    #[test]
    fn update_lock_skill_records_then_undo_removes() {
        let s = installed_v1();
        let mut info = update_info(&s);
        info.origin = UpdateOrigin::SkillLock;
        let archives = archives_v2();
        let batch = UpdateBatch {
            records: &[],
            archives: &archives,
            overwrite_modified: false,
            hold_root: &s.hold_root,
            now: 99,
        };
        let mut out = execute_update_with(&[info], &batch, &ops());
        assert_eq!(out.records.len(), 1);
        let mut current = out.records.clone();
        undo(&out.take_undo().unwrap(), &s.hold_root, &mut current);
        assert!(current.is_empty());
    }

    #[test]
    fn update_without_archive_or_folder_fails() {
        let s = installed_v1();
        let info = update_info(&s);
        let empty = BTreeMap::new();
        let batch = UpdateBatch {
            records: &[],
            archives: &empty,
            overwrite_modified: true,
            hold_root: &s.hold_root,
            now: 1,
        };
        let out = execute_update_with(std::slice::from_ref(&info), &batch, &ops());
        assert_eq!(
            out.failed.get("pdf").map(String::as_str),
            Some("没有下载到新版")
        );

        let archives = archives_v2();
        let batch = UpdateBatch {
            archives: &archives,
            ..batch
        };
        std::fs::remove_dir_all(&s.dir).unwrap();
        let out = execute_update_with(&[info], &batch, &ops());
        assert_eq!(
            out.failed.get("pdf").map(String::as_str),
            Some("本地的 skill 文件夹不在了")
        );
    }
}

//! 来源订阅：每个位置（全局或某个项目，即域）订阅了哪些来源。
//!
//! 来源是订阅的单位：订阅了的来源，它的**全部** skill 都进这个位置的列表，没链的格是 Missing。
//! 什么算已订阅（`subscribed`）：
//! - 这个位置自己的来源（原件就在这里，`is_own`）：永远算，不进记录，也不能移除；
//! - 订阅记录（`Settings.subscriptions`）里的：来源管理页添加过的，一条都没链也算；
//! - 此刻在这个位置有软链（含整目录链接）的：老数据就是这样认订阅的，不用迁移。
//!
//! 老数据在**第一次扫描**时由 `adopt` 写进记录，此后由记录决定成不成行——所以点掉最后一条
//! 软链，这些行也不会从列表里消失。之后别的工具或自动规则在这里新建的软链同样当场记下：
//! 不记的话，点掉它最后一条链时整组行会跟着消失，与「订阅」对不上。
//!
//! 订阅只动记录与软链，不碰原件；执行撤链走 `sync::execute` 的安全路径（删前重校验仍是软链）。
use crate::discovery::folder_label;
use crate::fs::{entry_kind, normalize, same_real, EntryKind};
use crate::models::*;
use crate::skills::{
    dir_name, group_domains, links_to, project_key, propose_unlinks, remove_auto_link_targets,
    GLOBAL_KEY, WHOLE_LINK_ITEM,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

/// 每个位置订阅了哪些来源：域 key（`global` / `project:<路径>`）→ 来源路径（`normalize` 后）。
/// 某个域的 key 在表里（哪怕集合为空）就说明它已经做过第一次扫描的老数据认领
pub type Subscriptions = BTreeMap<String, BTreeSet<PathBuf>>;

/// 来源管理页一行的共同部分
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    /// 与 `Source.id` 相同；记录里有、这次没发现的来源用记录的路径
    pub id: String,
    /// 完整路径，给提示框
    pub path: PathBuf,
    /// 来源名
    pub label: String,
    /// 同名来源的区分片段（路径里能区分它们的那一级）；不重名、或片段就是名字本身时为空串
    pub segment: String,
    /// 主目录写成 `~` 的路径
    pub short_path: String,
    /// 按名排序
    pub skills: Vec<String>,
    pub skill_count: usize,
}

/// 这个位置已订阅的一个来源
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedSource {
    #[serde(flatten)]
    pub source: SourceSummary,
    /// 原件就在这个位置里：永远算已订阅，不能移除
    pub own: bool,
    /// 能不能开「以后新出现的自动添加」：外部位置由软链合成，不会有新出现的，规则展开时也跳过它
    pub can_auto_link: bool,
    /// 规则在这个位置开着（有这个位置的目标）
    pub auto_link: bool,
    /// 规则在这个位置的目标 id（`Target.id`）
    pub auto_targets: Vec<String>,
}

/// 一个位置的 key 与显示名
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainName {
    pub key: String,
    pub label: String,
}

/// `+ 来源` 里的一个候选
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSource {
    #[serde(flatten)]
    pub source: SourceSummary,
    /// 在哪些位置订阅着（只有「其他项目在用的」有）
    pub used_in: Vec<DomainName>,
}

/// 来源管理页的全部数据
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceList {
    /// 这个位置已订阅的来源：自己的在前，其余按名
    pub subscribed: Vec<SubscribedSource>,
    /// 别的位置订阅过、这里还没有的
    pub elsewhere: Vec<CandidateSource>,
    /// 检测到的其余来源（各 agent 全局目录、WeiboAP 各 agent 的目录、别的项目的仓库等）
    pub detected: Vec<CandidateSource>,
}

/// 移除来源时会撤掉的一条软链
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalLink {
    /// 哪个 skill；None 表示这个 agent 的整个 skill 目录就是指向该来源的一条软链
    pub skill: Option<String>,
    pub target_id: String,
    /// agent 名（`Target.label`）
    pub agent: String,
}

/// 移除来源前给确认框的清单
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRemoval {
    pub source_id: String,
    /// 按目标先后、再按 skill 名；为空表示一条都没链
    pub links: Vec<RemovalLink>,
}

/// 两个路径是否同一处：写法相同，或解析后相同
fn same_place(a: &Path, b: &Path) -> bool {
    normalize(a) == normalize(b) || same_real(a, b)
}

fn domain_targets(targets: &[Target], key: &str) -> Vec<Target> {
    targets
        .iter()
        .filter(|t| crate::skills::domain_key(&t.scope) == key)
        .cloned()
        .collect()
}

/// 来源的原件就在这个位置里：全局＝通用仓库与各 agent 全局目录；项目＝它自己的仓库。
/// 目标目录就是来源本身（如某 agent 的项目目录即是仓库）也算。手动与外部位置从来不是
pub fn is_own(source: &Source, key: &str, d_targets: &[Target]) -> bool {
    let home = match &source.kind {
        SourceKind::Universal | SourceKind::HarnessGlobal { .. } => key == GLOBAL_KEY,
        SourceKind::ProjectStore { project, .. } => project_key(project) == key,
        SourceKind::Manual | SourceKind::External => false,
    };
    // 整目录链接的目标解析后也落在来源上，但它是链接，不是原件
    home || d_targets
        .iter()
        .any(|t| t.linked_whole_to.is_none() && same_real(&t.path, &source.path))
}

/// 记录里写的就是 `normalize` 后的来源路径，先按写法比；对不上再按解析后比（扫描里每个
/// 位置 × 来源都要问一次，canonicalize 是 IO，能省则省）
fn recorded(subs: &Subscriptions, key: &str, source: &Source) -> bool {
    subs.get(key).is_some_and(|set| {
        set.contains(&normalize(&source.path)) || set.iter().any(|p| same_real(p, &source.path))
    })
}

/// 此刻在这个位置的目标里有指向它的软链（逐个 skill，或整目录）
fn linked_here(source: &Source, d_targets: &[Target]) -> bool {
    d_targets.iter().any(|t| {
        t.linked_whole_to.as_deref() == Some(source.id.as_str())
            || source.skills.iter().any(|k| links_to(t, k))
    })
}

/// 来源在这个位置算不算已订阅：自己的 ∪ 记录里的 ∪ 此刻有链的（见模块说明）
pub fn subscribed(source: &Source, key: &str, d_targets: &[Target], subs: &Subscriptions) -> bool {
    is_own(source, key, d_targets) || recorded(subs, key, source) || linked_here(source, d_targets)
}

/// 把此刻有链的来源写进各位置的订阅记录；返回是否改动过。
///
/// 某个位置第一次扫描（记录里还没有它的 key）时认领老数据：有软链的来源；全局另认领
/// `legacy_manual`（旧版手动添加的位置，旧版把它们的 skill 全部列在全局）。此后由记录决定，
/// 点掉最后一条软链行也还在。之后新出现的软链照样记下（见模块说明）。自己的来源不进记录
pub fn adopt(
    subs: &mut Subscriptions,
    sources: &[Source],
    targets: &[Target],
    legacy_manual: &[PathBuf],
) -> bool {
    let mut changed = false;
    for (key, _, d_targets) in group_domains(targets) {
        let first = !subs.contains_key(&key);
        let mut found: Vec<PathBuf> = Vec::new();
        for s in sources {
            if is_own(s, &key, &d_targets) || recorded(subs, &key, s) {
                continue;
            }
            let legacy = first
                && key == GLOBAL_KEY
                && s.kind == SourceKind::Manual
                && legacy_manual.iter().any(|p| same_place(p, &s.path));
            if legacy || linked_here(s, &d_targets) {
                found.push(normalize(&s.path));
            }
        }
        changed |= first || !found.is_empty();
        subs.entry(key).or_default().extend(found);
    }
    changed
}

/// 记录里的全部路径：常规发现找不到的（用户在来源管理页选的文件夹）要靠它读进来
pub fn recorded_dirs(subs: &Subscriptions) -> BTreeSet<PathBuf> {
    subs.values().flatten().cloned().collect()
}

/// 在这个位置订阅一个来源：`path` 可以是候选的路径，也可以是用户选的文件夹。
/// 与已发现的来源同一处时记那个来源的路径；是这个位置自己的来源时什么都不用记
pub fn subscribe(
    subs: &mut Subscriptions,
    key: &str,
    path: &Path,
    sources: &[Source],
    targets: &[Target],
) -> Result<(), String> {
    let d_targets = domain_targets(targets, key);
    if d_targets.is_empty() {
        return Err("这个位置已经不在了，请刷新".into());
    }
    let record = match sources.iter().find(|s| same_place(&s.path, path)) {
        Some(s) if is_own(s, key, &d_targets) => return Ok(()),
        Some(s) => normalize(&s.path),
        None => {
            // 判断"目录是否存在"要跟随软链：选的文件夹本身可以是软链
            if !path.is_dir() {
                return Err("这个文件夹不在了".into());
            }
            if path.join("SKILL.md").is_file() {
                return Err("这是一个 skill，要选放着 skill 的那一层文件夹".into());
            }
            normalize(path)
        }
    };
    subs.entry(key.to_string()).or_default().insert(record);
    Ok(())
}

/// 位置显示名：当前有目标的位置取扫描时的名字，已经不在的按 key 推
fn domain_names(targets: &[Target]) -> BTreeMap<String, String> {
    group_domains(targets)
        .into_iter()
        .map(|(key, label, _)| (key, label))
        .collect()
}

fn domain_label(key: &str, names: &BTreeMap<String, String>) -> String {
    if let Some(label) = names.get(key) {
        return label.clone();
    }
    match key.strip_prefix("project:") {
        Some(path) => dir_name(Path::new(path)),
        None => "全局".to_string(),
    }
}

/// 主目录写成 `~`；按路径分量比较，不用字符串前缀
fn short_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => Path::new("~").join(rest).display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

fn summary(source: &Source, home: &Path) -> SourceSummary {
    SourceSummary {
        id: source.id.clone(),
        path: source.path.clone(),
        label: source.label.clone(),
        segment: String::new(),
        short_path: short_path(&source.path, home),
        skills: source.skills.iter().map(|k| k.name.clone()).collect(),
        skill_count: source.skills.len(),
    }
}

/// 记录里有、这次没发现的来源（文件夹不在了，或里面一个 skill 都没有）：照样列出来，好让用户移除
fn missing_summary(path: &Path, home: &Path) -> SourceSummary {
    SourceSummary {
        id: path.to_string_lossy().into_owned(),
        path: path.to_path_buf(),
        label: folder_label(path),
        segment: String::new(),
        short_path: short_path(path, home),
        skills: Vec::new(),
        skill_count: 0,
    }
}

/// 同名来源分不清时，挑出每条路径里能区分它的那一级（与前端 `distinguishingSegments` 同一算法）：
/// 从结尾往前找第一个「别的路径在同一位置（从结尾数）上都不是它」的分量；找不到退回整条路径。
/// 只有一条时返回空串
pub(crate) fn distinguishing_segments(paths: &[&Path]) -> Vec<String> {
    if paths.len() < 2 {
        return vec![String::new(); paths.len()];
    }
    let parts: Vec<Vec<String>> = paths
        .iter()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect()
        })
        .collect();
    let at = |ps: &[String], k: usize| ps.len().checked_sub(k + 1).map(|i| ps[i].clone());
    parts
        .iter()
        .enumerate()
        .map(|(i, mine)| {
            (0..mine.len())
                .map(|k| (k, at(mine, k)))
                .find(|(k, c)| {
                    parts
                        .iter()
                        .enumerate()
                        .all(|(j, other)| j == i || at(other, *k) != *c)
                })
                .and_then(|(_, c)| c)
                .unwrap_or_else(|| paths[i].display().to_string())
        })
        .collect()
}

/// 给页面上出现的全部来源填区分片段：同名的一组各取能区分它的那一级
fn fill_segments(all: &mut [&mut SourceSummary]) {
    let mut by_label: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, s) in all.iter().enumerate() {
        by_label.entry(s.label.clone()).or_default().push(i);
    }
    for (label, group) in by_label {
        let paths: Vec<PathBuf> = group.iter().map(|&i| all[i].path.clone()).collect();
        let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
        for (&i, seg) in group.iter().zip(distinguishing_segments(&refs)) {
            all[i].segment = if seg == label { String::new() } else { seg };
        }
    }
}

/// 来源管理页：这个位置已订阅的来源，以及 `+ 来源` 的两组候选。只读。
/// `rules` 是全部 skill 自动添加规则；`home` 是主目录，短路径里写成 `~`
pub fn list(
    key: &str,
    sources: &[Source],
    targets: &[Target],
    subs: &Subscriptions,
    rules: &[AutoLink],
    home: &Path,
) -> SourceList {
    let d_targets = domain_targets(targets, key);
    let names = domain_names(targets);
    let target_ids: Vec<&str> = d_targets.iter().map(|t| t.id.as_str()).collect();

    let mut subscribed_list: Vec<SubscribedSource> = sources
        .iter()
        .filter(|s| subscribed(s, key, &d_targets, subs))
        .map(|s| {
            let path = normalize(&s.path);
            let auto_targets: Vec<String> = rules
                .iter()
                .find(|r| r.source == path)
                .map(|r| {
                    r.targets
                        .iter()
                        .filter(|t| target_ids.contains(&t.as_str()))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            SubscribedSource {
                source: summary(s, home),
                own: is_own(s, key, &d_targets),
                can_auto_link: s.kind != SourceKind::External,
                auto_link: !auto_targets.is_empty(),
                auto_targets,
            }
        })
        .collect();
    // 记录里有、这次没发现的
    for path in subs.get(key).into_iter().flatten() {
        if !sources.iter().any(|s| same_place(&s.path, path)) {
            subscribed_list.push(SubscribedSource {
                source: missing_summary(path, home),
                own: false,
                can_auto_link: true,
                auto_link: false,
                auto_targets: Vec::new(),
            });
        }
    }

    // 别的位置订阅着的：只看记录（自己的来源不算「订阅」），只列这次发现得到的
    let mut used: BTreeMap<String, Vec<DomainName>> = BTreeMap::new();
    for (other, paths) in subs.iter().filter(|(k, _)| k.as_str() != key) {
        for path in paths {
            let Some(s) = sources.iter().find(|s| same_place(&s.path, path)) else {
                continue;
            };
            if subscribed(s, key, &d_targets, subs) {
                continue;
            }
            let entry = used.entry(s.id.clone()).or_default();
            if !entry.iter().any(|d| &d.key == other) {
                entry.push(DomainName {
                    key: other.clone(),
                    label: domain_label(other, &names),
                });
            }
        }
    }
    let mut elsewhere = Vec::new();
    let mut detected = Vec::new();
    for s in sources
        .iter()
        .filter(|s| !subscribed(s, key, &d_targets, subs))
    {
        match used.remove(&s.id) {
            Some(used_in) => elsewhere.push(CandidateSource {
                source: summary(s, home),
                used_in,
            }),
            None => detected.push(CandidateSource {
                source: summary(s, home),
                used_in: Vec::new(),
            }),
        }
    }

    subscribed_list.sort_by(|a, b| {
        (!a.own, &a.source.label, &a.source.path).cmp(&(!b.own, &b.source.label, &b.source.path))
    });
    let by_name = |a: &CandidateSource, b: &CandidateSource| {
        (&a.source.label, &a.source.path).cmp(&(&b.source.label, &b.source.path))
    };
    elsewhere.sort_by(by_name);
    detected.sort_by(by_name);

    let mut all: Vec<&mut SourceSummary> = subscribed_list
        .iter_mut()
        .map(|s| &mut s.source)
        .chain(elsewhere.iter_mut().map(|c| &mut c.source))
        .chain(detected.iter_mut().map(|c| &mut c.source))
        .collect();
    fill_segments(&mut all);

    SourceList {
        subscribed: subscribed_list,
        elsewhere,
        detected,
    }
}

/// 找到要移除的来源（这次没发现的为 None），连同本位置的目标；自己的来源拒绝
fn removable<'a>(
    key: &str,
    source_id: &str,
    sources: &'a [Source],
    targets: &[Target],
) -> Result<(Option<&'a Source>, Vec<Target>), String> {
    let d_targets = domain_targets(targets, key);
    if d_targets.is_empty() {
        return Err("这个位置已经不在了，请刷新".into());
    }
    let source = sources
        .iter()
        .find(|s| s.id == source_id || same_place(&s.path, Path::new(source_id)));
    if let Some(s) = source {
        if is_own(s, key, &d_targets) {
            let label = domain_label(key, &domain_names(targets));
            return Err(format!("它的原件就在{label}里，删掉原件才会消失"));
        }
    }
    Ok((source, d_targets))
}

/// 这个来源在本位置的全部软链 → 撤链动作。逐个 skill 的软链交给 `propose_unlinks`
/// （只挑 Linked 格）；整目录链到它的目标撤那一条目录级软链
fn removal_actions(source: &Source, d_targets: &[Target]) -> Vec<(RemovalLink, PlannedAction)> {
    let mut out = Vec::new();
    for t in d_targets {
        if t.linked_whole_to.as_deref() == Some(source.id.as_str()) {
            if matches!(entry_kind(&t.path), EntryKind::Symlink(_)) {
                out.push((
                    RemovalLink {
                        skill: None,
                        target_id: t.id.clone(),
                        agent: t.label.clone(),
                    },
                    PlannedAction {
                        kind: ActionKind::Unlink,
                        item_name: WHOLE_LINK_ITEM.to_string(),
                        source_path: source.path.clone(),
                        target_path: t.path.clone(),
                        target: t.path.parent().map(Path::to_path_buf).unwrap_or_default(),
                    },
                ));
            }
            continue;
        }
        let cells: Vec<CellRef> = source
            .skills
            .iter()
            .map(|k| CellRef {
                source_id: source.id.clone(),
                skill: k.name.clone(),
                target_id: t.id.clone(),
            })
            .collect();
        let actions = propose_unlinks(
            std::slice::from_ref(source),
            std::slice::from_ref(t),
            &cells,
        );
        for a in actions {
            out.push((
                RemovalLink {
                    skill: Some(a.item_name.clone()),
                    target_id: t.id.clone(),
                    agent: t.label.clone(),
                },
                a,
            ));
        }
    }
    out
}

/// 移除之前的只读清单：会撤掉哪些软链（skill × agent）。自己的来源返回拒绝的原因
pub fn plan_remove(
    key: &str,
    source_id: &str,
    sources: &[Source],
    targets: &[Target],
) -> Result<SourceRemoval, String> {
    let (source, d_targets) = removable(key, source_id, sources, targets)?;
    Ok(SourceRemoval {
        source_id: source_id.to_string(),
        links: source
            .map(|s| removal_actions(s, &d_targets))
            .unwrap_or_default()
            .into_iter()
            .map(|(link, _)| link)
            .collect(),
    })
}

/// 从这个位置移除一个来源：先撤掉它在本位置的全部软链（`sync::execute`，删前重校验仍是
/// 指向该来源的软链），再从订阅记录里删掉，并撤掉自动添加规则里本位置的目标。
/// 原件一概不动。有软链没撤掉时记录照样删，下次扫描它会因那条链重新算订阅——如实反映
pub fn remove(
    key: &str,
    source_id: &str,
    sources: &[Source],
    targets: &[Target],
    subs: &mut Subscriptions,
    rules: &mut Vec<AutoLink>,
) -> Result<SyncReport, String> {
    let (source, d_targets) = removable(key, source_id, sources, targets)?;
    let actions: Vec<PlannedAction> = source
        .map(|s| removal_actions(s, &d_targets))
        .unwrap_or_default()
        .into_iter()
        .map(|(_, a)| a)
        .collect();
    // 撤链不看写法
    let report = crate::sync::execute(&actions, false, LinkStyle::Absolute);
    let path = source.map_or_else(|| PathBuf::from(source_id), |s| s.path.clone());
    if let Some(set) = subs.get_mut(key) {
        set.retain(|p| !same_place(p, &path));
    }
    let ids: Vec<String> = d_targets.iter().map(|t| t.id.clone()).collect();
    remove_auto_link_targets(rules, &path, &ids);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{scan, upsert_auto_link};
    use crate::store::Store;
    use crate::test_support::TempTree;

    /// 从磁盘读一个来源：直接子目录都算 skill
    fn src(path: &Path, kind: SourceKind, label: &str) -> Source {
        let mut names: Vec<String> = std::fs::read_dir(path)
            .unwrap()
            .flatten()
            .filter(|e| entry_kind(&e.path()) == EntryKind::Dir)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let path = normalize(path);
        Source {
            id: path.to_string_lossy().into_owned(),
            label: label.into(),
            kind,
            skills: names
                .into_iter()
                .map(|name| Skill {
                    path: path.join(&name),
                    name,
                    description: None,
                })
                .collect(),
            path,
        }
    }

    fn store_of(project: &Path) -> SourceKind {
        SourceKind::ProjectStore {
            project: normalize(project),
            project_label: None,
        }
    }

    fn global(harness: &str, path: &Path) -> Target {
        Target {
            id: harness.into(),
            label: harness.into(),
            path: normalize(path),
            scope: TargetScope::Global {
                harness_id: harness.into(),
            },
            exists: path.is_dir(),
            linked_whole_to: None,
        }
    }

    fn project(root: &Path, harness: &str, path: &Path) -> Target {
        let root = normalize(root);
        Target {
            id: format!("project:{}::{harness}", root.display()),
            label: harness.into(),
            path: normalize(path),
            scope: TargetScope::Project {
                project: root,
                harness_id: harness.into(),
                project_label: None,
            },
            exists: path.is_dir(),
            linked_whole_to: None,
        }
    }

    fn pkey(root: &Path) -> String {
        project_key(root)
    }

    /// 某个位置的行：(来源 id, skill, 第一列的格状态)
    fn rows_of(ov: &Overview, key: &str) -> Vec<(String, String, CellState)> {
        ov.domains
            .iter()
            .find(|d| d.key == key)
            .unwrap()
            .rows
            .iter()
            .map(|r| (r.source_id.clone(), r.skill.clone(), r.cells[0].state))
            .collect()
    }

    /// 一个通用仓库（a、b）+ 一个项目（claude、codex 两列）
    struct Fixture {
        tree: TempTree,
        universal: PathBuf,
        proj: PathBuf,
        claude: PathBuf,
        codex: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let tree = TempTree::new();
            let universal = tree.dir("home/.agents/skills");
            tree.dir("home/.agents/skills/a");
            tree.dir("home/.agents/skills/b");
            let proj = tree.dir("proj");
            let claude = tree.dir("proj/.claude/skills");
            let codex = tree.dir("proj/.codex/skills");
            Fixture {
                tree,
                universal,
                proj,
                claude,
                codex,
            }
        }
        fn universal(&self) -> Source {
            src(&self.universal, SourceKind::Universal, "通用仓库")
        }
        fn targets(&self) -> Vec<Target> {
            vec![
                global("claude-code", &self.tree.dir("home/.claude/skills")),
                project(&self.proj, "claude-code", &self.claude),
                project(&self.proj, "codex", &self.codex),
            ]
        }
        fn key(&self) -> String {
            pkey(&self.proj)
        }
    }

    /// 旧 settings.json（没有 subscriptions 字段）照常读；第一次扫描认领老数据并写回：
    /// 项目里有软链的来源、全局里旧版手动添加的位置；自己的来源不进记录。再扫一次不再写盘
    #[test]
    fn old_data_is_adopted_on_first_scan_and_written_to_the_record() {
        let f = Fixture::new();
        let manual = f.tree.dir("my-skills");
        f.tree.dir("my-skills/m");
        let lonely = f.tree.dir("lonely");
        f.tree.dir("lonely/z");
        f.tree.link(&f.claude.join("a"), &f.universal.join("a"));
        let sources = vec![
            f.universal(),
            src(&manual, SourceKind::Manual, "my-skills"),
            src(&lonely, SourceKind::External, "lonely"),
        ];
        let targets = f.targets();

        let dir = f.tree.dir("data/SymSync");
        let old = serde_json::json!({"disabledHarnesses": [], "manualSources": [manual]});
        std::fs::write(dir.join("settings.json"), old.to_string()).unwrap();
        let store = Store::new(dir.clone());
        assert!(store.load_settings().unwrap().subscriptions.is_empty());

        let settings = store
            .load_settings_adopting_subscriptions(&sources, &targets)
            .unwrap();
        let expect: Subscriptions = [
            ("global".to_string(), BTreeSet::from([normalize(&manual)])),
            (f.key(), BTreeSet::from([normalize(&f.universal)])),
        ]
        .into_iter()
        .collect();
        assert_eq!(settings.subscriptions, expect);
        // 写回了
        assert_eq!(store.load_settings().unwrap().subscriptions, expect);

        // 此后由记录决定：再认领一次没有改动，也不再认领旧版手动位置
        let mut subs = expect.clone();
        assert!(!adopt(&mut subs, &sources, &targets, &[normalize(&manual)]));
        assert_eq!(subs, expect);
    }

    /// 已订阅来源里没链的 skill 进列表，格是 Missing；自己的来源不用记录也在
    #[test]
    fn unlinked_skills_of_a_subscribed_source_are_missing_rows() {
        let f = Fixture::new();
        let own = f.tree.dir("proj/.agents/skills");
        f.tree.dir("proj/.agents/skills/p");
        let sources = vec![f.universal(), src(&own, store_of(&f.proj), "proj")];
        let targets = f.targets();
        let subs: Subscriptions = [(f.key(), BTreeSet::from([normalize(&f.universal)]))].into();

        let ov = scan(&sources, &targets, &subs);
        let u = sources[0].id.clone();
        assert_eq!(
            rows_of(&ov, &f.key()),
            vec![
                (u.clone(), "a".into(), CellState::Missing),
                (u, "b".into(), CellState::Missing),
                (sources[1].id.clone(), "p".into(), CellState::Missing),
            ]
        );
    }

    /// 刚订阅的文件夹（常规发现找不到、一条都没链）也在：进发现、成行、列在已订阅里
    #[test]
    fn a_fresh_subscription_with_no_links_is_listed() {
        let f = Fixture::new();
        let picked = f.tree.dir("Downloads/team-skills");
        let x = f.tree.dir("Downloads/team-skills/x");
        f.tree.file(&x, "SKILL.md");
        // 没有 SKILL.md 的子目录不是 skill
        f.tree.dir("Downloads/team-skills/node_modules");
        let targets = f.targets();
        let mut subs = Subscriptions::new();
        let base = vec![f.universal()];

        // 选中一个 skill 本身：拒绝
        assert!(subscribe(&mut subs, &f.key(), &x, &base, &targets).is_err());
        subscribe(&mut subs, &f.key(), &picked, &base, &targets).unwrap();
        assert_eq!(subs[&f.key()], BTreeSet::from([normalize(&picked)]));

        let mut sources = base.clone();
        sources.extend(crate::discovery::subscribed_sources(
            &recorded_dirs(&subs),
            &base,
        ));
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[1].label, "team-skills");
        let ov = scan(&sources, &targets, &subs);
        assert_eq!(
            rows_of(&ov, &f.key()),
            vec![(sources[1].id.clone(), "x".into(), CellState::Missing)]
        );
        let home = f.tree.root().join("home");
        let page = list(&f.key(), &sources, &targets, &subs, &[], &home);
        assert_eq!(page.subscribed.len(), 1);
        assert_eq!(page.subscribed[0].source.skills, vec!["x".to_string()]);
        assert_eq!(page.subscribed[0].source.skill_count, 1);
        assert!(!page.subscribed[0].own);

        // 文件夹后来空了：记录还在，照样列出来（0 个 skill），好让用户移除
        std::fs::remove_dir_all(&x).unwrap();
        let again = crate::discovery::subscribed_sources(&recorded_dirs(&subs), &base);
        assert!(again.is_empty());
        let page = list(&f.key(), &base, &targets, &subs, &[], &home);
        assert_eq!(page.subscribed.len(), 1);
        assert_eq!(page.subscribed[0].source.skill_count, 0);
        assert_eq!(page.subscribed[0].source.path, normalize(&picked));
    }

    /// 点掉最后一条软链后，行仍在（记录在认领时已写下）；没有记录的话才会消失
    #[test]
    fn rows_survive_unlinking_the_last_link() {
        let f = Fixture::new();
        f.tree.link(&f.claude.join("a"), &f.universal.join("a"));
        let sources = vec![f.universal()];
        let targets = f.targets();
        let mut subs = Subscriptions::new();
        adopt(&mut subs, &sources, &targets, &[]);

        std::fs::remove_file(f.claude.join("a")).unwrap();
        let names = |subs: &Subscriptions| -> Vec<String> {
            rows_of(&scan(&sources, &targets, subs), &f.key())
                .into_iter()
                .map(|r| r.1)
                .collect()
        };
        assert_eq!(names(&subs), vec!["a", "b"]);
        assert!(names(&Subscriptions::new()).is_empty());
    }

    /// 清单：逐个 skill × agent 列出指向这个来源的软链；指向别处的、真实目录不算；
    /// 整目录链到它的 agent 列成一条（skill 为 None）
    #[test]
    fn plan_remove_lists_exactly_the_links_into_the_source() {
        let f = Fixture::new();
        let other = f.tree.dir("other");
        let elsewhere = f.tree.dir("other/b");
        f.tree.link(&f.claude.join("a"), &f.universal.join("a"));
        f.tree.link(&f.claude.join("b"), &elsewhere); // 指向别处
        f.tree.link(&f.codex.join("a"), &f.universal.join("a"));
        f.tree.link(&f.codex.join("b"), &f.universal.join("b"));
        // 第三个 agent 的整个目录链到通用仓库
        let cursor = f.proj.join(".cursor/skills");
        f.tree.dir("proj/.cursor");
        f.tree.link(&cursor, &f.universal);
        let u = f.universal();
        let mut targets = f.targets();
        let mut whole = project(&f.proj, "cursor", &cursor);
        whole.linked_whole_to = Some(u.id.clone());
        targets.push(whole.clone());
        let idle = f.tree.dir("idle");
        f.tree.dir("idle/z");
        let sources = vec![
            u.clone(),
            src(&other, SourceKind::Manual, "other"),
            src(&idle, SourceKind::Manual, "idle"),
        ];

        let plan = plan_remove(&f.key(), &u.id, &sources, &targets).unwrap();
        let link = |skill: Option<&str>, t: &Target| RemovalLink {
            skill: skill.map(String::from),
            target_id: t.id.clone(),
            agent: t.label.clone(),
        };
        assert_eq!(
            plan.links,
            vec![
                link(Some("a"), &targets[1]),
                link(Some("a"), &targets[2]),
                link(Some("b"), &targets[2]),
                link(None, &whole),
            ]
        );
        // 只读：什么都没动
        assert!(matches!(
            entry_kind(&f.codex.join("b")),
            EntryKind::Symlink(_)
        ));
        assert!(matches!(entry_kind(&cursor), EntryKind::Symlink(_)));

        // 指向别处的那条链属于 other
        let plan = plan_remove(&f.key(), &sources[1].id, &sources, &targets).unwrap();
        assert_eq!(plan.links, vec![link(Some("b"), &targets[1])]);
        // 一条都没链的来源：清单为空
        let plan = plan_remove(&f.key(), &sources[2].id, &sources, &targets).unwrap();
        assert!(plan.links.is_empty());
    }

    /// 移除：撤掉本位置指向它的软链（原件与别处的链不动）、删记录、撤规则里本位置的目标；
    /// 自己的来源拒绝并说原因
    #[test]
    fn remove_unlinks_forgets_and_refuses_own_sources() {
        let f = Fixture::new();
        let global_claude = f.tree.dir("home/.claude/skills");
        f.tree.link(&f.claude.join("a"), &f.universal.join("a"));
        f.tree.link(&f.codex.join("b"), &f.universal.join("b"));
        f.tree
            .link(&global_claude.join("a"), &f.universal.join("a"));
        let own = f.tree.dir("proj/.agents/skills");
        f.tree.dir("proj/.agents/skills/p");
        let sources = vec![f.universal(), src(&own, store_of(&f.proj), "proj")];
        let targets = f.targets();
        let mut subs = Subscriptions::new();
        adopt(&mut subs, &sources, &targets, &[]);
        let mut rules = Vec::new();
        upsert_auto_link(
            &mut rules,
            &sources,
            &f.universal,
            &[targets[0].id.clone(), targets[2].id.clone()],
        );

        let report = remove(
            &f.key(),
            &sources[0].id,
            &sources,
            &targets,
            &mut subs,
            &mut rules,
        )
        .unwrap();
        assert_eq!(report.entries.len(), 2);
        assert!(report.entries.iter().all(|e| e.outcome == Outcome::Removed));
        assert_eq!(entry_kind(&f.claude.join("a")), EntryKind::Missing);
        assert_eq!(entry_kind(&f.codex.join("b")), EntryKind::Missing);
        // 原件与全局的链不动
        assert_eq!(entry_kind(&f.universal.join("a")), EntryKind::Dir);
        assert!(matches!(
            entry_kind(&global_claude.join("a")),
            EntryKind::Symlink(_)
        ));
        assert!(subs[&f.key()].is_empty());
        assert_eq!(rules[0].targets, vec![targets[0].id.clone()]);
        // 行也没了
        let ov = scan(&sources, &targets, &subs);
        assert!(rows_of(&ov, &f.key()).iter().all(|r| r.0 != sources[0].id));

        // 项目自己的来源：拒绝，什么都不动
        let err = remove(
            &f.key(),
            &sources[1].id,
            &sources,
            &targets,
            &mut subs,
            &mut rules,
        )
        .unwrap_err();
        assert_eq!(err, "它的原件就在proj里，删掉原件才会消失");
        assert!(plan_remove(&f.key(), &sources[1].id, &sources, &targets).is_err());
        // 全局里的通用仓库同理
        assert!(plan_remove("global", &sources[0].id, &sources, &targets).is_err());
    }

    /// 候选分两组：别的位置订阅着的（注明在哪用），其余检测到的；已订阅与自己的不在候选里。
    /// 同名来源带区分片段，短路径把主目录写成 ~；规则只报本位置的目标
    #[test]
    fn candidates_are_grouped_and_names_are_disambiguated() {
        let f = Fixture::new();
        let home = f.tree.root().join("home");
        let own = f.tree.dir("proj/.agents/skills");
        f.tree.dir("proj/.agents/skills/p");
        let other = f.tree.dir("other");
        let other_claude = f.tree.dir("other/.claude/skills");
        let shared = f.tree.dir("home/team/alpha/skills");
        f.tree.dir("home/team/alpha/skills/s");
        let twin = f.tree.dir("home/team/beta/skills");
        f.tree.dir("home/team/beta/skills/t");
        let ext = f.tree.dir("opt/ego/skills");
        f.tree.dir("opt/ego/skills/e");

        let sources = vec![
            f.universal(),
            src(&own, store_of(&f.proj), "proj"),
            src(&shared, SourceKind::Manual, "team"),
            src(&twin, SourceKind::Manual, "team"),
            src(&ext, SourceKind::External, "ego"),
        ];
        let mut targets = f.targets();
        targets.push(project(&other, "claude-code", &other_claude));
        let subs: Subscriptions = [
            (f.key(), BTreeSet::from([normalize(&ext)])),
            (pkey(&other), BTreeSet::from([normalize(&shared)])),
            ("global".to_string(), BTreeSet::from([normalize(&shared)])),
        ]
        .into();
        let mut rules = Vec::new();
        upsert_auto_link(
            &mut rules,
            &sources,
            &ext,
            &[targets[0].id.clone(), targets[1].id.clone()],
        );

        let page = list(&f.key(), &sources, &targets, &subs, &rules, &home);
        let ids = |v: Vec<&SourceSummary>| v.into_iter().map(|s| s.id.clone()).collect::<Vec<_>>();
        // 自己的在前
        assert_eq!(
            ids(page.subscribed.iter().map(|s| &s.source).collect()),
            vec![sources[1].id.clone(), sources[4].id.clone()]
        );
        assert!(page.subscribed[0].own);
        let ego = &page.subscribed[1];
        assert!(!ego.own);
        // 外部位置不能开规则；规则只报本位置的目标
        assert!(!ego.can_auto_link);
        assert!(ego.auto_link);
        assert_eq!(ego.auto_targets, vec![targets[1].id.clone()]);

        assert_eq!(
            ids(page.elsewhere.iter().map(|c| &c.source).collect()),
            vec![sources[2].id.clone()]
        );
        assert_eq!(
            page.elsewhere[0].used_in,
            vec![
                DomainName {
                    key: "global".into(),
                    label: "全局".into()
                },
                DomainName {
                    key: pkey(&other),
                    label: "other".into()
                },
            ]
        );
        assert_eq!(
            ids(page.detected.iter().map(|c| &c.source).collect()),
            vec![sources[3].id.clone(), sources[0].id.clone()]
        );

        // 同名的两个 team 各取能区分的那一级；不重名的为空
        assert_eq!(page.elsewhere[0].source.segment, "alpha");
        assert_eq!(page.detected[0].source.segment, "beta");
        assert_eq!(page.detected[1].source.segment, "");
        assert_eq!(page.detected[0].source.short_path, "~/team/beta/skills");
        assert_eq!(page.detected[1].source.short_path, "~/.agents/skills");
        assert_eq!(ego.source.short_path, normalize(&ext).display().to_string());
    }

    #[test]
    fn source_list_serializes_flat_and_camel_case() {
        let entry = SubscribedSource {
            source: SourceSummary {
                id: "/a".into(),
                path: PathBuf::from("/a"),
                label: "a".into(),
                segment: String::new(),
                short_path: "/a".into(),
                skills: vec!["x".into()],
                skill_count: 1,
            },
            own: false,
            can_auto_link: true,
            auto_link: false,
            auto_targets: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "id": "/a", "path": "/a", "label": "a", "segment": "", "shortPath": "/a",
                "skills": ["x"], "skillCount": 1, "own": false, "canAutoLink": true,
                "autoLink": false, "autoTargets": []
            })
        );
        assert_eq!(
            serde_json::to_value(RemovalLink {
                skill: None,
                target_id: "codex".into(),
                agent: "Codex".into()
            })
            .unwrap(),
            serde_json::json!({"skill": null, "targetId": "codex", "agent": "Codex"})
        );
    }
}

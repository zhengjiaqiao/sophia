//! 按域（全局 / 每个项目）组织的扫描：行的三类来源、格状态、同步集选择、动作生成、整目录链接拆分
use crate::fs::{create_link, entry_kind, normalize, real_path, remove_link, same_real, EntryKind};
use crate::models::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 拆分报告里代表那条目录级软链的条目名
const WHOLE_LINK_ITEM: &str = "<整目录链接>";

/// 全局域的 key
const GLOBAL_KEY: &str = "global";

/// 域 key：全局固定，项目为 `"project:<归一化路径>"`
pub fn domain_key(scope: &TargetScope) -> String {
    match scope {
        TargetScope::Global { .. } => GLOBAL_KEY.to_string(),
        TargetScope::Project { project, .. } => project_key(project),
    }
}

/// 域名：全局固定，项目优先用 `project_label`（harness 的 agent 目录带这个），否则路径末段
pub fn domain_label(scope: &TargetScope) -> String {
    match scope {
        TargetScope::Global { .. } => "全局".to_string(),
        TargetScope::Project {
            project,
            project_label,
            ..
        } => project_label.clone().unwrap_or_else(|| dir_name(project)),
    }
}

fn project_key(project: &Path) -> String {
    format!("project:{}", normalize(project).display())
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// 本体位置属于哪个域：项目仓库归它自己的项目，其余（通用仓库、harness 全局、手动）归全局
fn source_domain(kind: &SourceKind) -> String {
    match kind {
        SourceKind::ProjectStore { project, .. } => project_key(project),
        _ => GLOBAL_KEY.to_string(),
    }
}

/// 按域分组目标：全局在前，项目按 `targets` 里的首现顺序
fn group_domains(targets: &[Target]) -> Vec<(String, String, Vec<Target>)> {
    let mut out: Vec<(String, String, Vec<Target>)> = Vec::new();
    for t in targets {
        let key = domain_key(&t.scope);
        match out.iter_mut().find(|d| d.0 == key) {
            Some(d) => d.2.push(t.clone()),
            None => out.push((key, domain_label(&t.scope), vec![t.clone()])),
        }
    }
    // 稳定排序：全局排到最前，其余保持首现顺序
    out.sort_by_key(|d| d.0 != GLOBAL_KEY);
    out
}

/// `t/name` 是解析到 `s/name` 的软链
fn links_to(target: &Target, source: &Source, skill: &str) -> bool {
    let path = target.path.join(skill);
    matches!(entry_kind(&path), EntryKind::Symlink(_)) && same_real(&path, &source.path.join(skill))
}

/// 只读扫描，按域组织。自有本体位置在本域目标上补默认 `All`，
/// 补过的同步集随 `Overview.sync_set` 返回，由命令层负责保存
pub fn scan(sources: &[Source], targets: &[Target], sync_set: &SyncSet) -> Overview {
    let mut sync_set = sync_set.clone();
    let by_id: BTreeMap<&str, &Source> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut domains = Vec::new();
    for (key, label, d_targets) in group_domains(targets) {
        let ids: Vec<String> = d_targets.iter().map(|t| t.id.clone()).collect();
        // 自有本体位置默认已引入：只补本域目标，缺哪个补哪个
        for s in sources.iter().filter(|s| source_domain(&s.kind) == key) {
            for id in &ids {
                sync_set
                    .picks
                    .entry(id.clone())
                    .or_default()
                    .entry(s.id.clone())
                    .or_insert(Pick::All);
            }
        }
        let picks: BTreeMap<&str, Option<Pick>> = sources
            .iter()
            .map(|s| (s.id.as_str(), merged_pick(&sync_set, &ids, &s.id)))
            .collect();
        let picked = |source_id: &str, skill: &str| match picks.get(source_id) {
            Some(Some(Pick::All)) => true,
            Some(Some(Pick::Only(names))) => names.contains(skill),
            _ => false,
        };

        // 行 = 自有全部 ∪ 已链接的那些 ∪ 已引入的那些；(skill, 本体位置 label, 本体位置 id) 排序去重
        let mut keys: BTreeSet<(String, String, String)> = BTreeSet::new();
        for s in sources {
            let own = source_domain(&s.kind) == key;
            for skill in &s.skills {
                let linked = || d_targets.iter().any(|t| links_to(t, s, skill));
                if own || picked(&s.id, skill) || linked() {
                    keys.insert((skill.clone(), s.label.clone(), s.id.clone()));
                }
            }
        }

        let rows: Vec<DomainRow> = keys
            .into_iter()
            .filter_map(|(skill, _, source_id)| {
                let source = by_id.get(source_id.as_str())?;
                let cells: Vec<Cell> = d_targets
                    .iter()
                    .map(|t| {
                        let path = t.path.join(&skill);
                        Cell {
                            source_id: source_id.clone(),
                            skill: skill.clone(),
                            target_id: t.id.clone(),
                            state: cell_state(source, &skill, t, &path),
                            path,
                        }
                    })
                    .collect();
                Some(DomainRow {
                    imported: matches!(picks.get(source_id.as_str()), Some(Some(_))),
                    enabled: picked(&source_id, &skill),
                    linked: cells.iter().any(|c| c.state == CellState::Linked),
                    source_id,
                    skill,
                    cells,
                })
            })
            .collect();

        let pending_missing = rows
            .iter()
            .filter(|r| r.imported && r.enabled)
            .flat_map(|r| &r.cells)
            .filter(|c| c.state == CellState::Missing)
            .count();
        let imported = sources
            .iter()
            .filter_map(|s| {
                Some(ImportedSource {
                    source_id: s.id.clone(),
                    pick: picks.get(s.id.as_str())?.clone()?,
                })
            })
            .collect();
        // 整目录链接的目标读进去就是本体位置，坏链清理不能删到本体位置里
        let broken = d_targets
            .iter()
            .filter(|t| t.linked_whole_to.is_none())
            .flat_map(|t| broken_links(&t.path))
            .collect();
        domains.push(DomainPage {
            key,
            label,
            targets: d_targets,
            imported,
            rows,
            broken,
            pending_missing,
        });
    }
    Overview {
        domains,
        sources: sources.to_vec(),
        sync_set,
    }
}

/// 已引入且启用的行的 Missing → Create，加各域坏链清理。Create 按目标路径去重
pub fn propose(overview: &Overview) -> Vec<PlannedAction> {
    let by_id: BTreeMap<&str, &Source> = overview
        .sources
        .iter()
        .map(|s| (s.id.as_str(), s))
        .collect();
    let mut seen: BTreeSet<&Path> = BTreeSet::new();
    let mut actions = Vec::new();
    for d in &overview.domains {
        for row in d.rows.iter().filter(|r| r.imported && r.enabled) {
            let Some(source) = by_id.get(row.source_id.as_str()) else {
                continue;
            };
            for cell in row.cells.iter().filter(|c| c.state == CellState::Missing) {
                if !seen.insert(cell.path.as_path()) {
                    continue;
                }
                actions.push(PlannedAction {
                    kind: ActionKind::Create,
                    item_name: row.skill.clone(),
                    source_path: source.path.join(&row.skill),
                    target_path: cell.path.clone(),
                    target: cell
                        .path
                        .parent()
                        .map(Path::to_path_buf)
                        .unwrap_or_default(),
                });
            }
        }
        actions.extend(d.broken.iter().cloned());
    }
    actions
}

/// 本域各目标的选择合并：都没有条目 → 未引入；任一 `All` → `All`；否则名单并集
pub fn merged_pick(sync_set: &SyncSet, target_ids: &[String], source_id: &str) -> Option<Pick> {
    let mut names = BTreeSet::new();
    let mut found = false;
    for id in target_ids {
        match sync_set.picks.get(id).and_then(|m| m.get(source_id)) {
            None => {}
            Some(Pick::All) => return Some(Pick::All),
            Some(Pick::Only(only)) => {
                found = true;
                names.extend(only.iter().cloned());
            }
        }
    }
    found.then_some(Pick::Only(names))
}

/// 行首勾选：`All` 取消某项 → `Only(全部 − 它)`；`Only` 增删名单；未引入时勾选 → `Only({它})`。
/// 名单空掉等于未引入，删除条目
pub fn set_pick(
    sync_set: &mut SyncSet,
    target_ids: &[String],
    source_id: &str,
    skill: &str,
    enabled: bool,
    all_skills: &[String],
) {
    for id in target_ids {
        let current = sync_set.picks.get(id).and_then(|m| m.get(source_id));
        let next = match (current, enabled) {
            // 已在 All 里；或本来就没引入还要取消：都无事可做
            (Some(Pick::All), true) | (None, false) => continue,
            (Some(Pick::All), false) => Pick::Only(
                all_skills
                    .iter()
                    .filter(|s| s.as_str() != skill)
                    .cloned()
                    .collect(),
            ),
            (Some(Pick::Only(names)), _) => {
                let mut names = names.clone();
                if enabled {
                    names.insert(skill.to_string());
                } else {
                    names.remove(skill);
                }
                Pick::Only(names)
            }
            (None, true) => Pick::Only([skill.to_string()].into_iter().collect()),
        };
        put(sync_set, id, source_id, Some(next));
    }
}

/// 引入整个本体位置：本域每个目标都记上这个选择
pub fn import_source(sync_set: &mut SyncSet, target_ids: &[String], source_id: &str, pick: Pick) {
    for id in target_ids {
        put(sync_set, id, source_id, Some(pick.clone()));
    }
}

/// 移除引入：本域每个目标都删掉条目
pub fn remove_source(sync_set: &mut SyncSet, target_ids: &[String], source_id: &str) {
    for id in target_ids {
        put(sync_set, id, source_id, None);
    }
}

/// 写入一个条目；`None` 或空名单表示未引入，删除条目，目标映射空了也一并删掉
fn put(sync_set: &mut SyncSet, target_id: &str, source_id: &str, pick: Option<Pick>) {
    let pick = pick.filter(|p| !matches!(p, Pick::Only(names) if names.is_empty()));
    match pick {
        Some(pick) => {
            sync_set
                .picks
                .entry(target_id.to_string())
                .or_default()
                .insert(source_id.to_string(), pick);
        }
        None => {
            let Some(map) = sync_set.picks.get_mut(target_id) else {
                return;
            };
            map.remove(source_id);
            if map.is_empty() {
                sync_set.picks.remove(target_id);
            }
        }
    }
}

fn cell_state(source: &Source, skill: &str, target: &Target, path: &Path) -> CellState {
    match target.linked_whole_to.as_deref() {
        Some(id) if id == source.id => return CellState::Linked,
        Some(_) => return CellState::Unwritable,
        None => {}
    }
    // 目标就是本体位置本身（如 WeiboAP 的 custom 目录既是本体位置又是目标）：内容天然到位
    if same_real(&target.path, &source.path) {
        return CellState::Linked;
    }
    match entry_kind(path) {
        EntryKind::Missing => CellState::Missing,
        EntryKind::Dir | EntryKind::File => CellState::Duplicate,
        EntryKind::Symlink(_) if real_path(path).is_none() => CellState::Broken,
        EntryKind::Symlink(_) if same_real(path, &source.path.join(skill)) => CellState::Linked,
        EntryKind::Symlink(_) => CellState::Foreign,
    }
}

/// 目标目录里所有解析不到的软链
fn broken_links(dir: &Path) -> Vec<PlannedAction> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|name| {
            let path = dir.join(&name);
            let EntryKind::Symlink(dest) = entry_kind(&path) else {
                return None;
            };
            if real_path(&path).is_some() {
                return None;
            }
            Some(PlannedAction {
                kind: ActionKind::BrokenLink,
                item_name: name,
                source_path: dest,
                target_path: path,
                target: dir.to_path_buf(),
            })
        })
        .collect()
}

/// 目标属于某项目且本体位置在该项目内 → 相对路径（随 git 走），否则绝对路径
pub fn link_style(source: &Source, target: &Target) -> LinkStyle {
    match &target.scope {
        TargetScope::Project { project, .. }
            if normalize(&source.path).starts_with(normalize(project)) =>
        {
            LinkStyle::Relative
        }
        _ => LinkStyle::Absolute,
    }
}

/// 把"目标目录整体是一条指向本体位置的软链"拆成逐项链接：删软链 → 建真实目录 → 逐个 skill 建链。
/// 前置检查不过或任一步失败即停止，已建的链接保留
pub fn split_whole_link(target: &Target, source: &Source) -> SyncReport {
    let parent = target
        .path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let action =
        |kind: ActionKind, item: &str, source_path: PathBuf, target_path: PathBuf| PlannedAction {
            kind,
            item_name: item.to_string(),
            source_path,
            target_path,
            target: parent.clone(),
        };
    let remove = action(
        ActionKind::BrokenLink,
        WHOLE_LINK_ITEM,
        source.path.clone(),
        target.path.clone(),
    );
    let mut entries = Vec::new();
    let is_whole_link = matches!(entry_kind(&target.path), EntryKind::Symlink(_))
        && same_real(&target.path, &source.path);
    if !is_whole_link {
        return report(vec![ReportEntry {
            action: remove,
            outcome: Outcome::Failed("目标不是指向该本体位置的整目录链接".into()),
        }]);
    }
    if let Err(e) = remove_link(&target.path) {
        return report(vec![ReportEntry {
            action: remove,
            outcome: Outcome::Failed(e.to_string()),
        }]);
    }
    entries.push(ReportEntry {
        action: remove,
        outcome: Outcome::Removed,
    });
    if let Err(e) = std::fs::create_dir(&target.path) {
        entries.push(ReportEntry {
            action: action(
                ActionKind::Create,
                WHOLE_LINK_ITEM,
                source.path.clone(),
                target.path.clone(),
            ),
            outcome: Outcome::Failed(e.to_string()),
        });
        return report(entries);
    }
    let style = link_style(source, target);
    for skill in &source.skills {
        let source_path = source.path.join(skill);
        let target_path = target.path.join(skill);
        let outcome = match create_link(&source_path, &target_path, style) {
            Ok(()) => Outcome::Created,
            Err(e) => Outcome::Failed(e.to_string()),
        };
        let failed = matches!(outcome, Outcome::Failed(_));
        entries.push(ReportEntry {
            action: PlannedAction {
                kind: ActionKind::Create,
                item_name: skill.clone(),
                source_path,
                target_path,
                target: target.path.clone(),
            },
            outcome,
        });
        if failed {
            break;
        }
    }
    report(entries)
}

fn report(entries: Vec<ReportEntry>) -> SyncReport {
    SyncReport { entries }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    fn make_source(path: &Path, label: &str, kind: SourceKind, skills: &[&str]) -> Source {
        let path = normalize(path);
        Source {
            id: path.to_string_lossy().into_owned(),
            label: label.into(),
            kind,
            skills: skills.iter().map(|s| s.to_string()).collect(),
            path,
        }
    }

    fn source(path: &Path, skills: &[&str]) -> Source {
        make_source(path, "本体", SourceKind::Universal, skills)
    }

    /// 某项目的本体仓库（属于该项目的域）
    fn store_source(path: &Path, label: &str, project: &Path, skills: &[&str]) -> Source {
        make_source(
            path,
            label,
            SourceKind::ProjectStore {
                project: normalize(project),
                project_label: None,
            },
            skills,
        )
    }

    fn only(names: &[&str]) -> Pick {
        Pick::Only(names.iter().map(|s| s.to_string()).collect())
    }

    fn ids(targets: &[&Target]) -> Vec<String> {
        targets.iter().map(|t| t.id.clone()).collect()
    }

    /// 行的 (本体位置 id, skill, imported, enabled, linked)
    fn rows(page: &DomainPage) -> Vec<(String, String, bool, bool, bool)> {
        page.rows
            .iter()
            .map(|r| {
                (
                    r.source_id.clone(),
                    r.skill.clone(),
                    r.imported,
                    r.enabled,
                    r.linked,
                )
            })
            .collect()
    }

    fn global(harness: &str, path: &Path) -> Target {
        Target {
            id: harness.to_string(),
            label: harness.to_string(),
            path: normalize(path),
            scope: TargetScope::Global {
                harness_id: harness.to_string(),
            },
            linked_whole_to: None,
        }
    }

    fn project(project: &Path, harness: &str, path: &Path) -> Target {
        let project = normalize(project);
        Target {
            id: format!("project:{}::{}", project.display(), harness),
            label: harness.to_string(),
            path: normalize(path),
            scope: TargetScope::Project {
                project,
                harness_id: harness.to_string(),
                project_label: None,
            },
            linked_whole_to: None,
        }
    }

    #[test]
    fn rows_are_the_union_of_own_linked_and_imported() {
        let t = TempTree::new();
        let g = t.dir("global");
        let own = t.dir("own");
        t.dir("own/a1");
        t.dir("own/a2");
        let proj_a = t.dir("projA");
        let store_a = t.dir("projA/.agents/skills");
        t.dir("projA/.agents/skills/b1");
        t.dir("projA/.agents/skills/b2");
        let proj_b = t.dir("projB");
        let store_b = t.dir("projB/.agents/skills");
        t.dir("projB/.agents/skills/c1");
        t.dir("projB/.agents/skills/c2");
        // 全局目标里只链了 A 的 b1
        t.link(&g.join("b1"), &store_a.join("b1"));

        let s_own = make_source(&own, "自有", SourceKind::Universal, &["a1", "a2"]);
        let s_a = store_source(&store_a, "A", &proj_a, &["b1", "b2"]);
        let s_b = store_source(&store_b, "B", &proj_b, &["c1", "c2"]);
        let gt = global("claude-code", &g);
        let mut sync = SyncSet::default();
        import_source(&mut sync, &ids(&[&gt]), &s_b.id, only(&["c1"]));

        let o = scan(
            &[s_own.clone(), s_a.clone(), s_b.clone()],
            std::slice::from_ref(&gt),
            &sync,
        );
        assert_eq!(o.domains.len(), 1);
        let page = &o.domains[0];
        assert_eq!(
            rows(page),
            vec![
                // 自有：全部 skill，默认已引入
                (s_own.id.clone(), "a1".into(), true, true, false),
                (s_own.id.clone(), "a2".into(), true, true, false),
                // 已链接：只这一个，不带入同源的 b2
                (s_a.id.clone(), "b1".into(), false, false, true),
                // 已引入：名单里的 c1，不带入 c2
                (s_b.id.clone(), "c1".into(), true, true, false),
            ]
        );
        assert_eq!(
            page.imported,
            vec![
                ImportedSource {
                    source_id: s_own.id.clone(),
                    pick: Pick::All
                },
                ImportedSource {
                    source_id: s_b.id.clone(),
                    pick: only(&["c1"])
                },
            ]
        );
        // 已链接的行不写同步集
        assert!(!o.sync_set.picks[&gt.id].contains_key(&s_a.id));
    }

    #[test]
    fn own_sources_default_to_all_only_on_their_own_domain_targets() {
        let t = TempTree::new();
        let g = t.dir("global");
        let proj = t.dir("proj");
        let proj_target = t.dir("proj/.claude/skills");
        let store = t.dir("proj/.agents/skills");
        t.dir("proj/.agents/skills/p1");
        let own = t.dir("own");
        t.dir("own/a1");

        let s_own = make_source(&own, "手动", SourceKind::Manual, &["a1"]);
        let s_p = store_source(&store, "proj 仓库", &proj, &["p1"]);
        let gt = global("claude-code", &g);
        let pt = project(&proj, "claude-code", &proj_target);
        // 项目目标排在前面，域顺序仍是全局在先
        let o = scan(
            &[s_own.clone(), s_p.clone()],
            &[pt.clone(), gt.clone()],
            &SyncSet::default(),
        );

        assert_eq!(
            o.domains
                .iter()
                .map(|d| (d.key.clone(), d.label.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("global".to_string(), "全局".to_string()),
                (project_key(&proj), "proj".to_string()),
            ]
        );
        assert_eq!(
            o.sync_set.picks[&gt.id],
            [(s_own.id.clone(), Pick::All)].into_iter().collect()
        );
        assert_eq!(
            o.sync_set.picks[&pt.id],
            [(s_p.id.clone(), Pick::All)].into_iter().collect()
        );
    }

    #[test]
    fn propose_creates_only_for_imported_and_enabled_rows() {
        let t = TempTree::new();
        let g = t.dir("global");
        let own = t.dir("own");
        t.dir("own/a1");
        t.dir("own/a2");
        let proj = t.dir("proj");
        let store = t.dir("proj/.agents/skills");
        t.dir("proj/.agents/skills/b1");
        t.link(&g.join("b1"), &store.join("b1"));

        let s_own = make_source(&own, "自有", SourceKind::Universal, &["a1", "a2"]);
        let s_p = store_source(&store, "P", &proj, &["b1"]);
        let gt = global("claude-code", &g);
        let mut sync = SyncSet::default();
        // 自有位置被取消了 a2
        import_source(&mut sync, &ids(&[&gt]), &s_own.id, only(&["a1"]));

        let o = scan(
            &[s_own.clone(), s_p.clone()],
            std::slice::from_ref(&gt),
            &sync,
        );
        let page = &o.domains[0];
        assert_eq!(
            rows(page),
            vec![
                (s_own.id.clone(), "a1".into(), true, true, false),
                (s_own.id.clone(), "a2".into(), true, false, false),
                (s_p.id.clone(), "b1".into(), false, false, true),
            ]
        );
        assert_eq!(page.pending_missing, 1);

        let actions = propose(&o);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::Create);
        assert_eq!(actions[0].item_name, "a1");
        assert_eq!(actions[0].source_path, own.join("a1"));
        assert_eq!(actions[0].target_path, g.join("a1"));
        assert_eq!(actions[0].target, g);
    }

    #[test]
    fn pending_missing_counts_every_missing_cell_of_enabled_rows() {
        let t = TempTree::new();
        let g1 = t.dir("g1");
        let g2 = t.dir("g2");
        let own = t.dir("own");
        t.dir("own/a1");
        t.dir("own/a2");
        t.link(&g1.join("a1"), &own.join("a1"));

        let s = make_source(&own, "自有", SourceKind::Universal, &["a1", "a2"]);
        let t1 = global("h1", &g1);
        let t2 = global("h2", &g2);
        let o = scan(std::slice::from_ref(&s), &[t1, t2], &SyncSet::default());
        let page = &o.domains[0];
        // 两个全局目标同属一个域：a1 缺 g2，a2 两处都缺
        assert_eq!(page.targets.len(), 2);
        assert!(page.rows[0].linked);
        assert_eq!(page.pending_missing, 3);
        assert_eq!(propose(&o).len(), 3);
    }

    #[test]
    fn broken_links_are_skipped_inside_whole_linked_targets() {
        let t = TempTree::new();
        let gone = t.root().join("gone");
        let store = t.dir("store");
        t.dir("store/a1");
        t.link(&store.join("rotten"), &gone);
        let g = t.dir("global");
        t.link(&g.join("dead"), &gone);
        let proj = t.dir("proj");
        t.dir("proj/.claude");
        let proj_target = proj.join(".claude/skills");
        t.link(&proj_target, &store);

        let s = make_source(&store, "自有", SourceKind::Universal, &["a1"]);
        let gt = global("claude-code", &g);
        let mut pt = project(&proj, "claude-code", &proj_target);
        pt.linked_whole_to = Some(s.id.clone());
        let o = scan(std::slice::from_ref(&s), &[gt, pt], &SyncSet::default());

        assert_eq!(
            o.domains[0]
                .broken
                .iter()
                .map(|a| a.item_name.clone())
                .collect::<Vec<_>>(),
            vec!["dead".to_string()]
        );
        // 整目录链接的目标读进去就是本体位置，清理会删到本体位置里
        assert!(o.domains[1].broken.is_empty());
        let names: Vec<String> = propose(&o).into_iter().map(|a| a.item_name).collect();
        assert!(names.contains(&"dead".to_string()));
        assert!(!names.contains(&"rotten".to_string()));
    }

    #[test]
    fn merged_pick_takes_any_all_then_unions_the_lists() {
        let one = |i: usize| vec![format!("t{i}")];
        let all: Vec<String> = (1..=3).map(|i| format!("t{i}")).collect();
        let mut sync = SyncSet::default();
        assert_eq!(merged_pick(&sync, &all, "s"), None);
        import_source(&mut sync, &one(1), "s", only(&["a"]));
        import_source(&mut sync, &one(2), "s", only(&["b"]));
        // t3 没有条目，不影响并集
        assert_eq!(merged_pick(&sync, &all, "s"), Some(only(&["a", "b"])));
        import_source(&mut sync, &one(3), "s", Pick::All);
        assert_eq!(merged_pick(&sync, &all, "s"), Some(Pick::All));
        assert_eq!(merged_pick(&sync, &all, "other"), None);
    }

    #[test]
    fn set_pick_converts_all_to_a_list_and_drops_empty_ones() {
        let both = vec!["t1".to_string(), "t2".to_string()];
        let all: Vec<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let mut sync = SyncSet::default();

        // 未引入时取消：不留空壳
        set_pick(&mut sync, &both, "s", "a", false, &all);
        assert_eq!(sync, SyncSet::default());
        // 未引入时勾选 → 只这一个，两个目标都写
        set_pick(&mut sync, &both, "s", "a", true, &all);
        assert_eq!(sync.picks["t1"]["s"], only(&["a"]));
        assert_eq!(sync.picks["t2"]["s"], only(&["a"]));
        set_pick(&mut sync, &both, "s", "b", true, &all);
        assert_eq!(sync.picks["t1"]["s"], only(&["a", "b"]));
        // 名单删空 → 条目与目标映射一起消失
        set_pick(&mut sync, &both, "s", "a", false, &all);
        set_pick(&mut sync, &both, "s", "b", false, &all);
        assert_eq!(sync, SyncSet::default());

        import_source(&mut sync, &both, "s", Pick::All);
        set_pick(&mut sync, &both, "s", "a", true, &all);
        assert_eq!(sync.picks["t1"]["s"], Pick::All);
        set_pick(&mut sync, &both, "s", "a", false, &all);
        assert_eq!(sync.picks["t1"]["s"], only(&["b"]));
        assert_eq!(sync.picks["t2"]["s"], only(&["b"]));
    }

    #[test]
    fn import_and_remove_source_apply_to_every_target() {
        let both = vec!["t1".to_string(), "t2".to_string()];
        let mut sync = SyncSet::default();
        import_source(&mut sync, &both, "s", only(&["a"]));
        assert_eq!(sync.picks.len(), 2);
        assert_eq!(merged_pick(&sync, &both, "s"), Some(only(&["a"])));
        import_source(&mut sync, &both, "s", Pick::All);
        assert_eq!(merged_pick(&sync, &both, "s"), Some(Pick::All));
        // 空名单等于未引入
        import_source(&mut sync, &both, "s", Pick::Only(BTreeSet::new()));
        assert_eq!(sync, SyncSet::default());

        import_source(&mut sync, &both, "s", Pick::All);
        import_source(&mut sync, &both, "other", Pick::All);
        remove_source(&mut sync, &both, "s");
        assert_eq!(merged_pick(&sync, &both, "s"), None);
        assert_eq!(merged_pick(&sync, &both, "other"), Some(Pick::All));
        remove_source(&mut sync, &both, "other");
        assert_eq!(sync, SyncSet::default());
    }

    #[test]
    fn link_style_is_relative_only_inside_the_target_project() {
        let t = TempTree::new();
        let proj = t.dir("proj");
        let inside = source(&t.dir("proj/.agents/skills"), &[]);
        let outside = source(&t.dir("store"), &[]);
        let p = project(&proj, "claude-code", &t.dir("proj/.claude/skills"));
        let g = global("claude-code", &t.dir("g"));
        assert_eq!(link_style(&inside, &p), LinkStyle::Relative);
        assert_eq!(link_style(&outside, &p), LinkStyle::Absolute);
        assert_eq!(link_style(&inside, &g), LinkStyle::Absolute);
        assert_eq!(link_style(&outside, &g), LinkStyle::Absolute);
    }

    #[cfg(unix)]
    #[test]
    fn split_whole_link_replaces_directory_link_with_per_skill_links() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let b = t.dir("store/b");
        t.file(&b, "SKILL.md");
        let proj = t.dir("proj");
        t.dir("proj/.claude");
        let tgt = proj.join(".claude/skills");
        t.link(&tgt, &store);
        let s = source(&store, &["a", "b"]);
        let mut target = project(&proj, "claude-code", &tgt);
        target.linked_whole_to = Some(s.id.clone());
        let r = split_whole_link(&target, &s);
        assert_eq!(r.entries.len(), 3);
        assert_eq!(r.entries[0].action.kind, ActionKind::BrokenLink);
        assert_eq!(r.entries[0].action.item_name, WHOLE_LINK_ITEM);
        assert_eq!(r.entries[0].outcome, Outcome::Removed);
        assert!(r.entries[1..]
            .iter()
            .all(|e| e.action.kind == ActionKind::Create && e.outcome == Outcome::Created));
        assert_eq!(entry_kind(&tgt), EntryKind::Dir);
        assert_eq!(
            entry_kind(&tgt.join("a")),
            EntryKind::Symlink(store.join("a"))
        );
        assert!(same_real(&tgt.join("b"), &b));
        // 本体位置内容不变
        assert_eq!(entry_kind(&store.join("a")), EntryKind::Dir);
        assert!(store.join("b/SKILL.md").is_file());
        assert_eq!(std::fs::read_dir(&store).unwrap().count(), 2);
    }

    #[test]
    fn split_whole_link_refuses_real_directory() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let tgt = t.dir("tgt");
        let s = source(&store, &["a"]);
        let target = global("claude-code", &tgt);
        let r = split_whole_link(&target, &s);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(
            r.entries[0].outcome,
            Outcome::Failed("目标不是指向该本体位置的整目录链接".into())
        );
        assert_eq!(entry_kind(&tgt), EntryKind::Dir);
        assert_eq!(std::fs::read_dir(&tgt).unwrap().count(), 0);
    }

    #[test]
    fn split_whole_link_refuses_link_to_another_place() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let elsewhere = t.dir("elsewhere");
        let tgt = t.root().join("tgt");
        t.link(&tgt, &elsewhere);
        let r = split_whole_link(&global("claude-code", &tgt), &source(&store, &["a"]));
        assert_eq!(r.entries.len(), 1);
        assert_eq!(
            r.entries[0].outcome,
            Outcome::Failed("目标不是指向该本体位置的整目录链接".into())
        );
        assert!(matches!(entry_kind(&tgt), EntryKind::Symlink(_)));
    }
}

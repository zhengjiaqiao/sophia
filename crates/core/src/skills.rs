//! 本体位置 → 目标：格状态扫描、同步集默认值、动作生成、整目录链接拆分
use crate::fs::{create_link, entry_kind, normalize, real_path, remove_link, same_real, EntryKind};
use crate::models::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 拆分报告里代表那条目录级软链的条目名
const WHOLE_LINK_ITEM: &str = "<整目录链接>";

/// 只读扫描。返回的 `sync_set` 已补上新本体位置的默认值，由命令层负责保存
pub fn scan(sources: &[Source], targets: &[Target], sync_set: &SyncSet) -> Overview {
    let cells = sources
        .iter()
        .flat_map(|source| {
            source.skills.iter().flat_map(move |skill| {
                targets.iter().map(move |target| {
                    let path = target.path.join(skill);
                    Cell {
                        source_id: source.id.clone(),
                        skill: skill.clone(),
                        target_id: target.id.clone(),
                        state: cell_state(source, skill, target, &path),
                        path,
                    }
                })
            })
        })
        .collect();
    let mut overview = Overview {
        sources: sources.to_vec(),
        targets: targets.to_vec(),
        cells,
        sync_set: with_defaults(sync_set, sources, targets),
        summary: Summary::default(),
    };
    // 摘要与 propose 同源，前端"同步（N）/清理坏链（N）"才对得上
    let actions = propose(&overview);
    overview.summary = Summary {
        sources: sources.len(),
        pending_missing: count(&actions, ActionKind::Create),
        broken: count(&actions, ActionKind::BrokenLink),
    };
    overview
}

fn count(actions: &[PlannedAction], kind: ActionKind) -> usize {
    actions.iter().filter(|a| a.kind == kind).count()
}

fn cell_state(source: &Source, skill: &str, target: &Target, path: &Path) -> CellState {
    match target.linked_whole_to.as_deref() {
        Some(id) if id == source.id => return CellState::Linked,
        Some(_) => return CellState::Unwritable,
        None => {}
    }
    match entry_kind(path) {
        EntryKind::Missing => CellState::Missing,
        EntryKind::Dir | EntryKind::File => CellState::Duplicate,
        EntryKind::Symlink(_) if real_path(path).is_none() => CellState::Broken,
        EntryKind::Symlink(_) if same_real(path, &source.path.join(skill)) => CellState::Linked,
        EntryKind::Symlink(_) => CellState::Foreign,
    }
}

/// 未登记的本体位置默认勾选全部 Global 目标；已登记的原样保留
fn with_defaults(sync_set: &SyncSet, sources: &[Source], targets: &[Target]) -> SyncSet {
    let globals: std::collections::BTreeSet<String> = targets
        .iter()
        .filter(|t| matches!(t.scope, TargetScope::Global { .. }))
        .map(|t| t.id.clone())
        .collect();
    let mut out = sync_set.clone();
    for source in sources {
        out.sources.entry(source.id.clone()).or_insert(SourceSync {
            targets: globals.clone(),
            disabled_skills: Default::default(),
        });
    }
    out
}

/// Create：勾选目标 × 启用 skill 的 Missing 格；BrokenLink：非整目录链接的目标目录里的所有坏链（不限本体位置）
pub fn propose(overview: &Overview) -> Vec<PlannedAction> {
    let sources: HashMap<&str, &Source> = overview
        .sources
        .iter()
        .map(|s| (s.id.as_str(), s))
        .collect();
    let targets: HashMap<&str, &Target> = overview
        .targets
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();
    let mut actions: Vec<PlannedAction> = overview
        .cells
        .iter()
        .filter(|c| c.state == CellState::Missing)
        .filter_map(|c| {
            let source = sources.get(c.source_id.as_str())?;
            let target = targets.get(c.target_id.as_str())?;
            let picked = overview.sync_set.sources.get(&c.source_id)?;
            if !picked.targets.contains(&c.target_id) || picked.disabled_skills.contains(&c.skill) {
                return None;
            }
            Some(PlannedAction {
                kind: ActionKind::Create,
                item_name: c.skill.clone(),
                source_path: source.path.join(&c.skill),
                target_path: c.path.clone(),
                target: target.path.clone(),
            })
        })
        .collect();
    for target in &overview.targets {
        // 整目录链接的目标读进去就是本体位置，坏链清理不能删到本体位置里
        if target.linked_whole_to.is_none() {
            actions.extend(broken_links(&target.path));
        }
    }
    actions
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
    use std::collections::BTreeSet;

    fn source(path: &Path, skills: &[&str]) -> Source {
        let path = normalize(path);
        Source {
            id: path.to_string_lossy().into_owned(),
            label: "本体".into(),
            kind: SourceKind::Universal,
            skills: skills.iter().map(|s| s.to_string()).collect(),
            path,
        }
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
            },
            linked_whole_to: None,
        }
    }

    fn ids(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn state(o: &Overview, source: &Source, skill: &str, target: &Target) -> CellState {
        o.cells
            .iter()
            .find(|c| c.source_id == source.id && c.skill == skill && c.target_id == target.id)
            .expect("cell")
            .state
            .clone()
    }

    #[test]
    fn six_cell_states() {
        let t = TempTree::new();
        let store = t.dir("store");
        for s in ["linked", "missing", "broken", "foreign", "dup"] {
            t.dir(&format!("store/{s}"));
        }
        let tgt = t.dir("tgt");
        t.link(&tgt.join("linked"), &store.join("linked"));
        t.link(&tgt.join("broken"), &t.root().join("nowhere"));
        t.link(&tgt.join("foreign"), &t.dir("elsewhere/foreign"));
        t.dir("tgt/dup");
        // Unwritable：另一个目标整体链到别的本体位置
        let other = t.dir("other");
        let whole = t.root().join("whole");
        t.link(&whole, &other);
        let s = source(&store, &["linked", "missing", "broken", "foreign", "dup"]);
        let other_source = source(&other, &[]);
        let mut w = global("whole", &whole);
        w.linked_whole_to = Some(other_source.id.clone());
        let g = global("claude-code", &tgt);
        let o = scan(
            std::slice::from_ref(&s),
            &[g.clone(), w.clone()],
            &SyncSet::default(),
        );
        assert_eq!(state(&o, &s, "linked", &g), CellState::Linked);
        assert_eq!(state(&o, &s, "missing", &g), CellState::Missing);
        assert_eq!(state(&o, &s, "broken", &g), CellState::Broken);
        assert_eq!(state(&o, &s, "foreign", &g), CellState::Foreign);
        assert_eq!(state(&o, &s, "dup", &g), CellState::Duplicate);
        assert_eq!(state(&o, &s, "linked", &w), CellState::Unwritable);
    }

    #[test]
    fn whole_link_makes_its_own_source_linked_and_others_unwritable() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        t.dir("store/b");
        let elsewhere = t.dir("elsewhere");
        t.dir("elsewhere/a");
        let tgt = t.root().join("tgt");
        t.link(&tgt, &store);
        let s = source(&store, &["a", "b"]);
        let other = source(&elsewhere, &["a"]);
        let mut g = global("claude-code", &tgt);
        g.linked_whole_to = Some(s.id.clone());
        let o = scan(
            &[s.clone(), other.clone()],
            &[g.clone()],
            &SyncSet::default(),
        );
        assert_eq!(state(&o, &s, "a", &g), CellState::Linked);
        assert_eq!(state(&o, &s, "b", &g), CellState::Linked);
        assert_eq!(state(&o, &other, "a", &g), CellState::Unwritable);
        assert!(propose(&o).is_empty());
    }

    #[test]
    fn new_source_defaults_to_all_global_targets_and_registered_one_is_kept() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let known = t.dir("known");
        t.dir("known/a");
        let proj = t.dir("proj");
        let g1 = global("claude-code", &t.dir("g1"));
        let g2 = global("codex", &t.dir("g2"));
        let p = project(&proj, "claude-code", &t.dir("proj/.claude/skills"));
        let fresh = source(&store, &["a"]);
        let registered = source(&known, &["a"]);
        let mut given = SyncSet::default();
        given.sources.insert(
            registered.id.clone(),
            SourceSync {
                targets: ids(&["codex"]),
                disabled_skills: ids(&["a"]),
            },
        );
        let o = scan(&[fresh.clone(), registered.clone()], &[g1, g2, p], &given);
        assert_eq!(
            o.sync_set.sources[&fresh.id],
            SourceSync {
                targets: ids(&["claude-code", "codex"]),
                disabled_skills: BTreeSet::new(),
            }
        );
        assert_eq!(
            o.sync_set.sources[&registered.id],
            given.sources[&registered.id]
        );
    }

    #[test]
    fn propose_only_covers_picked_targets_and_enabled_skills() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        t.dir("store/b");
        let picked = t.dir("picked");
        let unpicked = t.dir("unpicked");
        let s = source(&store, &["a", "b"]);
        let g1 = global("claude-code", &picked);
        let g2 = global("codex", &unpicked);
        let mut given = SyncSet::default();
        given.sources.insert(
            s.id.clone(),
            SourceSync {
                targets: ids(&["claude-code"]),
                disabled_skills: ids(&["b"]),
            },
        );
        let o = scan(std::slice::from_ref(&s), &[g1, g2], &given);
        let actions = propose(&o);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::Create);
        assert_eq!(actions[0].item_name, "a");
        assert_eq!(actions[0].source_path, store.join("a"));
        assert_eq!(actions[0].target_path, picked.join("a"));
        assert_eq!(actions[0].target, picked);
        assert_eq!(o.summary.pending_missing, 1);
    }

    #[test]
    fn broken_links_are_proposed_regardless_of_source() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let tgt = t.dir("tgt");
        t.link(&tgt.join("a"), &store.join("a"));
        // 与任何本体位置无关的坏链
        t.link(&tgt.join("zzz"), &t.root().join("gone"));
        let s = source(&store, &["a"]);
        let g = global("claude-code", &tgt);
        let o = scan(&[s], &[g], &SyncSet::default());
        let actions = propose(&o);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::BrokenLink);
        assert_eq!(actions[0].item_name, "zzz");
        assert_eq!(actions[0].target_path, tgt.join("zzz"));
        assert_eq!(actions[0].target, tgt);
        assert_eq!(o.summary.broken, 1);
    }

    #[test]
    fn broken_links_inside_whole_linked_target_are_not_proposed() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        // 本体位置内部的坏链，透过整目录链接读得到，但不该被清理
        t.link(&store.join("rotten"), &t.root().join("gone"));
        let tgt = t.root().join("tgt");
        t.link(&tgt, &store);
        let s = source(&store, &["a"]);
        let mut g = global("claude-code", &tgt);
        g.linked_whole_to = Some(s.id.clone());
        let o = scan(
            std::slice::from_ref(&s),
            std::slice::from_ref(&g),
            &SyncSet::default(),
        );
        assert!(propose(&o).is_empty());
        assert_eq!(o.summary.broken, 0);
        assert!(matches!(
            entry_kind(&store.join("rotten")),
            EntryKind::Symlink(_)
        ));
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

    #[test]
    fn summary_counts_sources_pending_and_broken() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        t.dir("store/b");
        let other = t.dir("other");
        t.dir("other/c");
        let tgt = t.dir("tgt");
        t.link(&tgt.join("gone"), &t.root().join("nope"));
        let s1 = source(&store, &["a", "b"]);
        let s2 = source(&other, &["c"]);
        let o = scan(
            &[s1, s2],
            &[global("claude-code", &tgt)],
            &SyncSet::default(),
        );
        assert_eq!(
            o.summary,
            Summary {
                sources: 2,
                pending_missing: 3,
                broken: 1,
            }
        );
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

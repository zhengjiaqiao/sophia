//! 本体位置 → 目标：格状态扫描、同步集默认值、动作生成、整目录链接拆分
use crate::fs::{create_link, entry_kind, normalize, real_path, remove_link, same_real, EntryKind};
use crate::models::*;
use std::path::{Path, PathBuf};

/// 拆分报告里代表那条目录级软链的条目名
const WHOLE_LINK_ITEM: &str = "<整目录链接>";

/// 只读扫描，按域组织。待 A2 重写
pub fn scan(_sources: &[Source], _targets: &[Target], _sync_set: &SyncSet) -> Overview {
    unimplemented!()
}

/// 已引入且启用的行的 Missing → Create，加坏链清理。待 A2 重写
pub fn propose(_overview: &Overview) -> Vec<PlannedAction> {
    unimplemented!()
}

/// A2 重写 scan 时用
#[allow(dead_code)]
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

/// 目标目录里所有解析不到的软链。A2 重写 propose 时用
#[allow(dead_code)]
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
                project_label: None,
            },
            linked_whole_to: None,
        }
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

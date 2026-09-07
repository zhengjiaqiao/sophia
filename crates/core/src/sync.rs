//! 通用同步：源目录子项 → 多个目标目录的软链。plan 只读，execute 逐项独立
use crate::fs::{create_link, entry_kind, normalize, remove_link, same_real, EntryKind};
use crate::models::*;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PlanError {
    #[error("源目录不可读：{0}")]
    SourceUnreadable(PathBuf),
}

/// 只读规划。两种 selection 都先确认源目录可列举
pub fn plan(rule: &SyncRule) -> Result<Vec<PlannedAction>, PlanError> {
    let source = normalize(&rule.source);
    let entries = list_dir(&source).ok_or_else(|| PlanError::SourceUnreadable(source.clone()))?;
    let names: Vec<String> = match &rule.selection {
        Selection::All => {
            let mut v: Vec<String> = entries
                .into_iter()
                .filter(|n| !n.starts_with('.'))
                .collect();
            v.sort();
            v
        }
        Selection::Items(items) => items.clone(),
    };
    let mut actions = Vec::new();
    for target in &rule.targets {
        let target_dir = normalize(target);
        for name in &names {
            actions.push(action_for(name, &source, &target_dir));
        }
        actions.extend(broken_links(&target_dir, &source));
    }
    Ok(actions)
}

fn list_dir(dir: &Path) -> Option<Vec<String>> {
    let rd = std::fs::read_dir(dir).ok()?;
    Some(
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
    )
}

fn action_for(name: &str, source: &Path, target_dir: &Path) -> PlannedAction {
    let source_path = source.join(name);
    let target_path = target_dir.join(name);
    let kind = if entry_kind(&source_path) == EntryKind::Missing {
        ActionKind::SourceMissing
    } else {
        match entry_kind(&target_path) {
            EntryKind::Missing => ActionKind::Create,
            EntryKind::Symlink(dest)
                if dest == source_path || same_real(&target_path, &source_path) =>
            {
                ActionKind::AlreadyLinked
            }
            _ => ActionKind::Conflict,
        }
    };
    PlannedAction {
        kind,
        item_name: name.to_string(),
        source_path,
        target_path,
        target: target_dir.to_path_buf(),
    }
}

/// 目标目录里指向 source/ 之下、但源已不存在的软链
fn broken_links(target_dir: &Path, source: &Path) -> Vec<PlannedAction> {
    let Some(mut entries) = list_dir(target_dir) else {
        return Vec::new();
    };
    entries.sort();
    entries
        .into_iter()
        .filter_map(|name| {
            let path = target_dir.join(&name);
            let EntryKind::Symlink(dest) = entry_kind(&path) else {
                return None;
            };
            if dest.as_path() == source || !dest.starts_with(source) || dest.exists() {
                return None;
            }
            Some(PlannedAction {
                kind: ActionKind::BrokenLink,
                item_name: name,
                source_path: dest,
                target_path: path,
                target: target_dir.to_path_buf(),
            })
        })
        .collect()
}

/// 只对 Create 建链；BrokenLink 仅在 clean_broken 时删除，删前重校验仍是软链。
/// Unlink 不受 clean_broken 影响（确认在前端做）
pub fn execute(actions: &[PlannedAction], clean_broken: bool, style: LinkStyle) -> SyncReport {
    SyncReport {
        entries: actions
            .iter()
            .map(|a| ReportEntry {
                action: a.clone(),
                outcome: outcome_for(a, clean_broken, style),
            })
            .collect(),
    }
}

fn outcome_for(action: &PlannedAction, clean_broken: bool, style: LinkStyle) -> Outcome {
    match action.kind {
        ActionKind::Create => {
            // 目标目录是否存在要跟随软链判断（目标目录本身可能是软链）
            if !action.target.is_dir() {
                return Outcome::Failed("目标目录不存在".into());
            }
            match create_link(&action.source_path, &action.target_path, style) {
                Ok(()) => Outcome::Created,
                Err(e) => Outcome::Failed(e.to_string()),
            }
        }
        ActionKind::Unlink => {
            // 预览到确认之间可能已被换掉：必须仍是软链，且仍指向该本体位置
            if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_))
                || !same_real(&action.target_path, &action.source_path)
            {
                return Outcome::Failed("不再是指向该本体位置的软链接，已跳过".into());
            }
            match remove_link(&action.target_path) {
                Ok(()) => Outcome::Removed,
                Err(e) => Outcome::Failed(e.to_string()),
            }
        }
        ActionKind::BrokenLink if clean_broken => {
            // 预览到确认之间路径可能已被换成真实文件
            if !matches!(entry_kind(&action.target_path), EntryKind::Symlink(_)) {
                return Outcome::Failed("不再是软链接，已跳过".into());
            }
            match remove_link(&action.target_path) {
                Ok(()) => Outcome::Removed,
                Err(e) => Outcome::Failed(e.to_string()),
            }
        }
        _ => Outcome::Skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{entry_kind, EntryKind};
    use crate::test_support::TempTree;
    use std::path::{Path, PathBuf};

    fn rule(src: &Path, targets: &[&Path], selection: Selection) -> SyncRule {
        SyncRule {
            id: uuid::Uuid::new_v4(),
            name: "r".into(),
            source: src.to_path_buf(),
            selection,
            targets: targets.iter().map(|p| p.to_path_buf()).collect(),
            last_run_at: None,
        }
    }
    fn kinds(a: &[PlannedAction]) -> Vec<ActionKind> {
        a.iter().map(|x| x.kind).collect()
    }
    fn outcomes(r: &SyncReport) -> Vec<Outcome> {
        r.entries.iter().map(|e| e.outcome.clone()).collect()
    }

    fn unlink(link: &Path, source: &Path) -> PlannedAction {
        PlannedAction {
            kind: ActionKind::Unlink,
            item_name: "x".into(),
            source_path: source.to_path_buf(),
            target_path: link.to_path_buf(),
            target: link.parent().unwrap().to_path_buf(),
        }
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
            unlink(&t.join("good"), &src),
            unlink(&t.join("elsewhere"), &src),
            unlink(&t.join("real"), &src),
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
    fn fresh_target_plans_create_for_each_item_sorted() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        t.file(&src, "b.md");
        t.dir("src/a");
        let actions = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        assert_eq!(
            actions
                .iter()
                .map(|a| a.item_name.clone())
                .collect::<Vec<_>>(),
            vec!["a", "b.md"]
        );
        assert!(actions.iter().all(|a| a.kind == ActionKind::Create));
        assert_eq!(actions[0].source_path, src.join("a"));
        assert_eq!(actions[0].target_path, dst.join("a"));
        assert_eq!(actions[0].target, dst);
    }

    #[test]
    fn existing_correct_link_is_already_linked() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        let a = t.file(&src, "a.md");
        t.link(&dst.join("a.md"), &a);
        assert_eq!(
            kinds(&plan(&rule(&src, &[&dst], Selection::All)).unwrap()),
            vec![ActionKind::AlreadyLinked]
        );
    }

    #[test]
    fn real_file_and_foreign_link_are_conflicts() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        let other = t.dir("other");
        t.file(&src, "a.md");
        t.file(&src, "b.md");
        t.file(&dst, "a.md");
        let ob = t.file(&other, "b.md");
        t.link(&dst.join("b.md"), &ob);
        assert_eq!(
            kinds(&plan(&rule(&src, &[&dst], Selection::All)).unwrap()),
            vec![ActionKind::Conflict, ActionKind::Conflict]
        );
    }

    #[test]
    fn unreadable_source_throws_for_both_selections() {
        let t = TempTree::new();
        let dst = t.dir("dst");
        let src = t.root().join("missing");
        assert_eq!(
            plan(&rule(&src, &[&dst], Selection::All)),
            Err(PlanError::SourceUnreadable(src.clone()))
        );
        assert_eq!(
            plan(&rule(&src, &[&dst], Selection::Items(vec!["a".into()]))),
            Err(PlanError::SourceUnreadable(src.clone()))
        );
    }

    #[test]
    fn items_selection_reports_missing_names_and_skips_hidden_in_all() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        t.file(&src, "a.md");
        t.file(&src, ".DS_Store");
        let items = plan(&rule(
            &src,
            &[&dst],
            Selection::Items(vec!["a.md".into(), "zzz".into()]),
        ))
        .unwrap();
        assert_eq!(
            kinds(&items),
            vec![ActionKind::Create, ActionKind::SourceMissing]
        );
        let all = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        assert_eq!(
            all.iter().map(|a| a.item_name.clone()).collect::<Vec<_>>(),
            vec!["a.md"]
        );
    }

    #[test]
    fn multiple_targets_are_independent() {
        let t = TempTree::new();
        let src = t.dir("src");
        let d1 = t.dir("d1");
        let d2 = t.dir("d2");
        let a = t.file(&src, "a.md");
        t.link(&d1.join("a.md"), &a);
        let actions = plan(&rule(&src, &[&d1, &d2], Selection::All)).unwrap();
        assert_eq!(
            kinds(&actions),
            vec![ActionKind::AlreadyLinked, ActionKind::Create]
        );
        assert_eq!(
            actions.iter().map(|a| a.target.clone()).collect::<Vec<_>>(),
            vec![d1, d2]
        );
    }

    #[test]
    fn broken_links_under_source_reported_others_ignored() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        t.file(&src, "keep.md");
        t.link(&dst.join("gone.md"), &src.join("gone.md"));
        t.link(&dst.join("foreign"), &t.root().join("elsewhere/x"));
        let actions = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        assert_eq!(
            kinds(&actions),
            vec![ActionKind::Create, ActionKind::BrokenLink]
        );
        assert_eq!(actions[1].item_name, "gone.md");
        assert_eq!(actions[1].source_path, src.join("gone.md"));
        assert_eq!(actions[1].target_path, dst.join("gone.md"));
    }

    #[test]
    fn execute_creates_absolute_links_and_second_run_skips() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        let a = t.file(&src, "a.md");
        let r = execute(
            &plan(&rule(&src, &[&dst], Selection::All)).unwrap(),
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(std::fs::read_link(dst.join("a.md")).unwrap(), a);
        let r2 = execute(
            &plan(&rule(&src, &[&dst], Selection::All)).unwrap(),
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(
            kinds(
                &r2.entries
                    .iter()
                    .map(|e| e.action.clone())
                    .collect::<Vec<_>>()
            ),
            vec![ActionKind::AlreadyLinked]
        );
        assert_eq!(outcomes(&r2), vec![Outcome::Skipped]);
    }

    #[cfg(unix)]
    #[test]
    fn execute_relative_style_writes_relative_target() {
        let t = TempTree::new();
        let src = t.dir("proj/.agents/skills");
        let dst = t.dir("proj/.claude/skills");
        t.dir("proj/.agents/skills/x");
        let r = execute(
            &plan(&rule(&src, &[&dst], Selection::All)).unwrap(),
            false,
            LinkStyle::Relative,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Created]);
        assert_eq!(
            std::fs::read_link(dst.join("x")).unwrap(),
            PathBuf::from("../../.agents/skills/x")
        );
    }

    #[test]
    fn conflict_is_skipped_and_real_file_untouched() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        t.file(&src, "a.md");
        std::fs::write(dst.join("a.md"), "original").unwrap();
        let r = execute(
            &plan(&rule(&src, &[&dst], Selection::All)).unwrap(),
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Skipped]);
        assert_eq!(
            std::fs::read_to_string(dst.join("a.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn missing_target_dir_fails_without_creating_it_but_symlinked_dir_works() {
        let t = TempTree::new();
        let src = t.dir("src");
        t.file(&src, "a.md");
        let missing = t.root().join("nope");
        let r = execute(
            &plan(&rule(&src, &[&missing], Selection::All)).unwrap(),
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r), vec![Outcome::Failed("目标目录不存在".into())]);
        assert_eq!(entry_kind(&missing), EntryKind::Missing);
        let real = t.dir("real");
        let via = t.root().join("via");
        t.link(&via, &real);
        let r2 = execute(
            &plan(&rule(&src, &[&via], Selection::All)).unwrap(),
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&r2), vec![Outcome::Created]);
        assert!(matches!(
            entry_kind(&real.join("a.md")),
            EntryKind::Symlink(_)
        ));
    }

    #[test]
    fn broken_links_kept_unless_clean_requested_and_recheck_before_delete() {
        let t = TempTree::new();
        let src = t.dir("src");
        let dst = t.dir("dst");
        let gone = dst.join("gone.md");
        t.link(&gone, &src.join("gone.md"));
        let foreign = dst.join("foreign");
        t.link(&foreign, &t.root().join("elsewhere"));
        let kept = execute(
            &plan(&rule(&src, &[&dst], Selection::All)).unwrap(),
            false,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&kept), vec![Outcome::Skipped]);
        assert!(matches!(entry_kind(&gone), EntryKind::Symlink(_)));
        let planned = plan(&rule(&src, &[&dst], Selection::All)).unwrap();
        std::fs::remove_file(&gone).unwrap();
        std::fs::write(&gone, "real").unwrap();
        let guarded = execute(&planned, true, LinkStyle::Absolute);
        assert_eq!(
            outcomes(&guarded),
            vec![Outcome::Failed("不再是软链接，已跳过".into())]
        );
        assert_eq!(std::fs::read_to_string(&gone).unwrap(), "real");
        std::fs::remove_file(&gone).unwrap();
        t.link(&gone, &src.join("gone.md"));
        let cleaned = execute(
            &plan(&rule(&src, &[&dst], Selection::All)).unwrap(),
            true,
            LinkStyle::Absolute,
        );
        assert_eq!(outcomes(&cleaned), vec![Outcome::Removed]);
        assert_eq!(entry_kind(&gone), EntryKind::Missing);
        assert!(matches!(entry_kind(&foreign), EntryKind::Symlink(_)));
    }
}

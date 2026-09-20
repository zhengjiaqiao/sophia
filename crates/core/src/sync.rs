//! 执行动作：逐项独立，每条动作自己成败，互不影响
use crate::fs::{create_link, entry_kind, remove_link, same_real, EntryKind};
use crate::models::*;

/// 只对 Create 建链（目标目录不存在就先建出来）；BrokenLink 仅在 clean_broken 时删除，
/// 删前重校验仍是软链。Unlink 与 BrokenLink 都不创建任何目录。
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
            // 目标目录不存在就地创建：从零开辟一个 harness 的 skill 目录是正常路径，不是错误。
            // 是否存在要跟随软链判断（is_dir），整目录软链也算已存在
            if !action.target.is_dir() {
                if let Err(e) = std::fs::create_dir_all(&action.target) {
                    return Outcome::Failed(format!("建不出目标目录：{e}"));
                }
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
        ActionKind::BrokenLink => Outcome::Skipped,
    }
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

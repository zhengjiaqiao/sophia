//! 执行动作：逐项独立，每条动作自己成败，互不影响
use crate::fs::{create_link, entry_kind, remove_link, same_real, EntryKind};
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
            format!("不是真实目录，没有移入废纸篓：{}", path.display()),
        ));
    }
    ::trash::delete(path).map_err(io::Error::other)
}

/// 删本体：目录移进废纸篓，再把指向它的链接逐条改指到 `plan.relink_to`。
/// 本体在 git 仓库内时什么都不动，只回一条失败；
/// 没有 `relink_to` 时受影响的链接原样留下——它们就此成为断链，逐条如实上报，不偷偷跳过
pub fn delete_source(plan: &DeleteSourcePlan) -> SyncReport {
    let delete = PlannedAction {
        kind: ActionKind::DeleteSource,
        item_name: file_name(&plan.path),
        source_path: plan.path.clone(),
        target_path: plan.path.clone(),
        target: parent_of(&plan.path),
    };
    let one = |outcome: Outcome| SyncReport {
        entries: vec![ReportEntry {
            action: delete.clone(),
            outcome,
        }],
    };
    if let Some(repo) = &plan.in_git {
        return one(Outcome::Failed(format!(
            "本体在 git 仓库内，不代删：{}",
            repo.display()
        )));
    }
    if let Err(e) = trash(&plan.path) {
        return one(Outcome::Failed(e.to_string()));
    }
    let mut entries = vec![ReportEntry {
        action: delete,
        outcome: Outcome::Removed,
    }];
    entries.extend(
        plan.affected
            .iter()
            .map(|link| relink(link, plan.relink_to.as_deref())),
    );
    SyncReport { entries }
}

/// 一条受影响的链接：有别处的同名本体就改指过去，没有就原样留下（已是断链）。
/// 写法用体检时记下的 `link.style`，项目内的相对链接改指后仍是相对的，不因改指丢掉可移植性
fn relink(affected: &AffectedLink, to: Option<&Path>) -> ReportEntry {
    let link = affected.path.as_path();
    let kind = entry_kind(link);
    let dest = match &kind {
        EntryKind::Symlink(dest) => dest.clone(),
        _ => link.to_path_buf(),
    };
    let action = |action_kind: ActionKind, source_path: PathBuf| PlannedAction {
        kind: action_kind,
        item_name: file_name(link),
        source_path,
        target_path: link.to_path_buf(),
        target: parent_of(link),
    };
    let Some(to) = to else {
        return ReportEntry {
            action: action(ActionKind::BrokenLink, dest),
            outcome: Outcome::Skipped,
        };
    };
    let create = action(ActionKind::Create, to.to_path_buf());
    // 体检到执行之间可能已被换掉：必须仍是软链才动它
    if !matches!(kind, EntryKind::Symlink(_)) {
        return ReportEntry {
            action: create,
            outcome: Outcome::Failed("不再是软链接，已跳过".into()),
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
    /// 这条测试会真的往系统废纸篓里放一个目录
    #[test]
    // 这几条测试会真的往系统废纸篓放目录（AC14 的语义就是这个）。
    // 名字必须各不相同：整套并行跑时两条同时往废纸篓扔同名目录，废纸篓要改名去重，
    // 曾在 make test 里偶发挂掉一条，单独跑或串行跑都过
    fn delete_source_trashes_the_body_and_repoints_links_to_the_remaining_one() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/symsync-test-repoint");
        t.file(&body, "SKILL.md");
        let other = t.dir("other");
        let kept = t.dir("other/symsync-test-repoint");
        let claude = t.dir("home/.claude/skills");
        let codex = t.dir("home/.codex/skills");
        t.link(&claude.join("symsync-test-repoint"), &body);
        t.link(&codex.join("symsync-test-repoint"), &body);
        t.link(&claude.join("untouched"), &kept);

        let sources = vec![
            source_at(&store, &["symsync-test-repoint"]),
            source_at(&other, &["symsync-test-repoint"]),
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
                absolute(&claude.join("symsync-test-repoint")),
                absolute(&codex.join("symsync-test-repoint")),
            ]
        );

        let r = delete_source(&plan);
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
    /// 这条测试会真的往系统废纸篓里放一个目录
    #[cfg(unix)]
    #[test]
    fn relinking_keeps_the_project_local_link_relative_and_the_global_one_absolute() {
        let t = TempTree::new();
        let proj = t.dir("proj");
        let store = t.dir("proj/.agents/skills"); // 项目内、要删的本体位置
        let body = t.dir("proj/.agents/skills/symsync-test-relative");
        let vendor = t.dir("proj/vendor/skills"); // 项目内、留下的同名本体
        let kept = t.dir("proj/vendor/skills/symsync-test-relative");
        let claude = t.dir("proj/.claude/skills"); // 项目目标
        let home = t.dir("home/.claude/skills"); // 全局目标
        let in_proj = claude.join("symsync-test-relative");
        let global_link = home.join("symsync-test-relative");
        // 项目内的链接按 link_style 本来就是相对的
        create_link(&body, &in_proj, LinkStyle::Relative).unwrap();
        t.link(&global_link, &body);
        assert!(std::fs::read_link(&in_proj).unwrap().is_relative());

        let sources = vec![
            source_at(&store, &["symsync-test-relative"]),
            source_at(&vendor, &["symsync-test-relative"]),
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

        let r = delete_source(&plan);
        assert_eq!(
            outcomes(&r),
            vec![Outcome::Removed, Outcome::Created, Outcome::Created]
        );
        assert_eq!(
            std::fs::read_link(&in_proj).unwrap(),
            PathBuf::from("../../vendor/skills/symsync-test-relative"),
            "项目内的链接改指后仍要是相对写法"
        );
        assert_eq!(std::fs::read_link(&global_link).unwrap(), kept);
        assert!(same_real(&in_proj, &kept) && same_real(&global_link, &kept));
    }

    /// 没有别处的同名本体时，受影响的链接就此成为断链：原样留下并逐条上报，不偷偷跳过。
    /// 这条测试会真的往系统废纸篓里放一个目录
    #[test]
    fn delete_source_leaves_links_broken_when_no_other_body_remains() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/symsync-test-broken");
        let claude = t.dir("home/.claude/skills");
        let link = claude.join("symsync-test-broken");
        t.link(&link, &body);

        let sources = vec![source_at(&store, &["symsync-test-broken"])];
        let targets = vec![target_at("claude-code", &claude)];
        let plan =
            crate::skills::plan_delete_source(&sources[0].skills[0].clone(), &sources, &targets);
        assert_eq!(plan.relink_to, None);
        assert_eq!(plan.affected, vec![absolute(&link)]);

        let r = delete_source(&plan);
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].outcome, Outcome::Removed);
        // 如实记成一条断链，链接没被动过
        assert_eq!(r.entries[1].action.kind, ActionKind::BrokenLink);
        assert_eq!(r.entries[1].action.target_path, link);
        assert_eq!(r.entries[1].action.source_path, body);
        assert_eq!(r.entries[1].outcome, Outcome::Skipped);
        assert!(matches!(entry_kind(&link), EntryKind::Symlink(_)));
        assert_eq!(crate::fs::real_path(&link), None);
        assert_eq!(entry_kind(&body), EntryKind::Missing);
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

//! 按域（全局 / 每个项目）组织的扫描：行的两类来源、格状态、按选中行生成建链 / 删链动作、整目录链接拆分
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

pub(crate) fn project_key(project: &Path) -> String {
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

/// 只读扫描，按域组织。只产出事实，不作任何选择
pub fn scan(sources: &[Source], targets: &[Target]) -> Overview {
    let by_id: BTreeMap<&str, &Source> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut domains = Vec::new();
    for (key, label, d_targets) in group_domains(targets) {
        // 行 = 自有全部 ∪ 已链接的那些；(skill, 本体位置 label, 本体位置 id) 排序去重
        let mut keys: BTreeSet<(String, String, String)> = BTreeSet::new();
        for s in sources {
            let own = source_domain(&s.kind) == key;
            for skill in &s.skills {
                let linked = || d_targets.iter().any(|t| links_to(t, s, skill));
                if own || linked() {
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
                    source_id,
                    skill,
                    cells,
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
            rows,
            broken,
        });
    }
    Overview {
        domains,
        sources: sources.to_vec(),
    }
}

/// 选中行在其域各目标上的 Missing 格 → Create。域 / 本体位置 / skill 对不上的行忽略；按 target_path 去重
pub fn propose_links(
    sources: &[Source],
    targets: &[Target],
    rows: &[RowRef],
) -> Vec<PlannedAction> {
    propose_by(
        sources,
        targets,
        rows,
        |state, _| state == CellState::Missing,
        ActionKind::Create,
    )
}

/// 选中行在其域各目标上的 Linked 格（目标非整目录链接）→ Unlink。规则同上
pub fn propose_unlinks(
    sources: &[Source],
    targets: &[Target],
    rows: &[RowRef],
) -> Vec<PlannedAction> {
    propose_by(
        sources,
        targets,
        rows,
        |state, target| state == CellState::Linked && target.linked_whole_to.is_none(),
        ActionKind::Unlink,
    )
}

fn propose_by(
    sources: &[Source],
    targets: &[Target],
    rows: &[RowRef],
    wanted: impl Fn(CellState, &Target) -> bool,
    kind: ActionKind,
) -> Vec<PlannedAction> {
    let by_id: BTreeMap<&str, &Source> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let mut out = Vec::new();
    for row in rows {
        let Some(source) = by_id.get(row.source_id.as_str()) else {
            continue;
        };
        if !source.skills.iter().any(|s| s == &row.skill) {
            continue;
        }
        for target in targets
            .iter()
            .filter(|t| domain_key(&t.scope) == row.domain)
        {
            let path = target.path.join(&row.skill);
            if !wanted(cell_state(source, &row.skill, target, &path), target) {
                continue;
            }
            if !seen.insert(path.clone()) {
                continue;
            }
            out.push(PlannedAction {
                kind,
                item_name: row.skill.clone(),
                source_path: source.path.join(&row.skill),
                target_path: path,
                target: target.path.clone(),
            });
        }
    }
    out
}

fn cell_state(source: &Source, skill: &str, target: &Target, path: &Path) -> CellState {
    match target.linked_whole_to.as_deref() {
        Some(id) if id == source.id => return CellState::Linked,
        Some(_) => return CellState::Unwritable,
        None => {}
    }
    // 目标就是本体位置本身（如 WeiboAP 的 custom 目录既是本体位置又是目标）：内容天然到位
    if same_real(&target.path, &source.path) {
        return CellState::Own;
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

    /// 行的 (本体位置 id, skill)
    fn rows(page: &DomainPage) -> Vec<(String, String)> {
        page.rows
            .iter()
            .map(|r| (r.source_id.clone(), r.skill.clone()))
            .collect()
    }

    fn row_ref(domain: &str, source: &Source, skill: &str) -> RowRef {
        RowRef {
            domain: domain.into(),
            source_id: source.id.clone(),
            skill: skill.into(),
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
    fn rows_are_own_skills_plus_linked_ones_only() {
        let tree = TempTree::new();
        let universal = tree.dir("universal"); // 全局自有：a, b
        let proj_root = tree.dir("proj");
        let store = tree.dir("proj/.agents/skills"); // 项目自有：c, d
        for s in ["a", "b"] {
            tree.dir(&format!("universal/{s}"));
        }
        for s in ["c", "d"] {
            tree.dir(&format!("proj/.agents/skills/{s}"));
        }
        let claude_global = tree.dir("home/.claude/skills");
        let claude_proj = tree.dir("proj/.claude/skills");
        // 项目目标里只链了 universal 的 a
        tree.link(&claude_proj.join("a"), &universal.join("a"));
        let sources = vec![
            source(&universal, &["a", "b"]),
            store_source(&store, "proj", &proj_root, &["c", "d"]),
        ];
        let targets = vec![
            global("claude-code", &claude_global),
            project(&proj_root, "claude-code", &claude_proj),
        ];
        let ov = scan(&sources, &targets);
        let glob = &ov.domains[0];
        assert_eq!(
            rows(glob),
            vec![
                (sources[0].id.clone(), "a".into()),
                (sources[0].id.clone(), "b".into())
            ]
        );
        let proj = &ov.domains[1];
        // 项目域：自有 c、d 全部成行；universal 只有被链的 a，不带入 b
        assert_eq!(
            rows(proj),
            vec![
                (sources[0].id.clone(), "a".into()),
                (sources[1].id.clone(), "c".into()),
                (sources[1].id.clone(), "d".into()),
            ]
        );
        assert_eq!(proj.rows[0].cells[0].state, CellState::Linked);
    }

    #[test]
    fn target_that_is_the_source_itself_is_own() {
        let tree = TempTree::new();
        let custom = tree.dir("ap/custom");
        tree.dir("ap/custom/x");
        let sources = vec![source(&custom, &["x"])];
        let targets = vec![global("weiboap", &custom)];
        let ov = scan(&sources, &targets);
        assert_eq!(ov.domains[0].rows[0].cells[0].state, CellState::Own);
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
        let o = scan(std::slice::from_ref(&s), &[gt, pt]);

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
    }

    #[test]
    fn propose_links_creates_only_missing_cells_even_for_rows_not_in_the_page() {
        let tree = TempTree::new();
        let universal = tree.dir("universal");
        for s in ["a", "b", "c", "d"] {
            tree.dir(&format!("universal/{s}"));
        }
        let claude = tree.dir("home/.claude/skills");
        let codex = tree.dir("home/.codex/skills");
        tree.dir("home/.claude/skills/b"); // Duplicate
        tree.link(&claude.join("c"), &tree.dir("elsewhere")); // Foreign
        let proj_root = tree.dir("proj");
        let proj_store = tree.dir("proj/.agents/skills");
        tree.dir("proj/.agents/skills/p");
        let proj_claude = tree.dir("proj/.claude/skills");
        let sources = vec![
            source(&universal, &["a", "b", "c", "d"]),
            store_source(&proj_store, "proj", &proj_root, &["p"]),
        ];
        let targets = vec![
            global("claude-code", &claude),
            global("codex", &codex),
            project(&proj_root, "claude-code", &proj_claude),
        ];
        let proj_key = project_key(&proj_root);
        let rows = vec![
            row_ref("global", &sources[0], "a"),
            row_ref("global", &sources[0], "b"),
            row_ref("global", &sources[0], "c"),
            row_ref("global", &sources[0], "a"),   // 重复行：去重
            row_ref(&proj_key, &sources[0], "d"),  // 引入场景：universal 的 d 不在项目页里
            row_ref("global", &sources[0], "zzz"), // skill 不存在：忽略
            row_ref("nope", &sources[0], "a"),     // 域不存在：忽略
        ];
        let mut paths: Vec<PathBuf> = propose_links(&sources, &targets, &rows)
            .into_iter()
            .inspect(|a| assert_eq!(a.kind, ActionKind::Create))
            .map(|a| a.target_path)
            .collect();
        paths.sort();
        let mut expect = vec![
            claude.join("a"),
            codex.join("a"),
            codex.join("b"),
            codex.join("c"),
            proj_claude.join("d"),
        ];
        expect.sort();
        assert_eq!(paths, expect);
    }

    #[test]
    fn propose_unlinks_targets_only_real_links_outside_whole_linked_dirs() {
        let tree = TempTree::new();
        let universal = tree.dir("universal");
        for s in ["a", "b"] {
            tree.dir(&format!("universal/{s}"));
        }
        let claude = tree.dir("home/.claude/skills");
        tree.link(&claude.join("a"), &universal.join("a")); // Linked
                                                            // b 缺失
        let whole = tree.dir("home/.cursor").join("skills");
        tree.link(&whole, &universal); // 整目录链接
        let sources = vec![source(&universal, &["a", "b"])];
        let mut whole_t = global("cursor", &whole);
        whole_t.linked_whole_to = Some(sources[0].id.clone());
        let own_t = global("weiboap", &universal); // Own
        let targets = vec![global("claude-code", &claude), whole_t, own_t];
        let rows = vec![
            row_ref("global", &sources[0], "a"),
            row_ref("global", &sources[0], "b"),
        ];
        let acts = propose_unlinks(&sources, &targets, &rows);
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].kind, ActionKind::Unlink);
        assert_eq!(acts[0].target_path, claude.join("a"));
        assert_eq!(acts[0].source_path, universal.join("a"));
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

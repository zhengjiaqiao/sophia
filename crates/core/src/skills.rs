//! 按域（全局 / 每个项目）组织的扫描：行的两类来源、格状态、按选中格生成建链 / 删链动作、整目录链接拆分
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
                    own: source_domain(&source.kind) == key,
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

/// 选中格里的 Missing 格 → Create。本体位置 / skill / 目标 id 对不上的格忽略；按 target_path 去重
pub fn propose_links(
    sources: &[Source],
    targets: &[Target],
    cells: &[CellRef],
) -> Vec<PlannedAction> {
    propose_by(
        sources,
        targets,
        cells,
        |state, _| state == CellState::Missing,
        ActionKind::Create,
    )
}

/// 选中格里的 Linked 格（目标非整目录链接）→ Unlink。规则同上
pub fn propose_unlinks(
    sources: &[Source],
    targets: &[Target],
    cells: &[CellRef],
) -> Vec<PlannedAction> {
    propose_by(
        sources,
        targets,
        cells,
        |state, target| state == CellState::Linked && target.linked_whole_to.is_none(),
        ActionKind::Unlink,
    )
}

fn propose_by(
    sources: &[Source],
    targets: &[Target],
    cells: &[CellRef],
    wanted: impl Fn(CellState, &Target) -> bool,
    kind: ActionKind,
) -> Vec<PlannedAction> {
    let by_id: BTreeMap<&str, &Source> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let mut out = Vec::new();
    for cell in cells {
        let Some(source) = by_id.get(cell.source_id.as_str()) else {
            continue;
        };
        if !source.skills.iter().any(|s| s == &cell.skill) {
            continue;
        }
        let Some(target) = targets.iter().find(|t| t.id == cell.target_id) else {
            continue;
        };
        let path = target.path.join(&cell.skill);
        if !wanted(cell_state(source, &cell.skill, target, &path), target) {
            continue;
        }
        if !seen.insert(path.clone()) {
            continue;
        }
        out.push(PlannedAction {
            kind,
            item_name: cell.skill.clone(),
            source_path: source.path.join(&cell.skill),
            target_path: path,
            target: target.path.clone(),
        });
    }
    out
}

/// 自动同步规则展开成格：本体位置找不到 / 目标找不到 → 跳过；skill 在排除名单里 → 跳过。
/// 随后交给 `propose_links`，只对 Missing 建链
pub fn auto_link_cells(sources: &[Source], targets: &[Target], rules: &[AutoLink]) -> Vec<CellRef> {
    let mut out = Vec::new();
    for rule in rules {
        let Some(source) = find_source(sources, &rule.source) else {
            continue;
        };
        for target_id in &rule.targets {
            if !targets.iter().any(|t| &t.id == target_id) {
                continue;
            }
            for skill in &source.skills {
                if rule.excluded.contains(skill) {
                    continue;
                }
                out.push(CellRef {
                    source_id: source.id.clone(),
                    skill: skill.clone(),
                    target_id: target_id.clone(),
                });
            }
        }
    }
    out
}

/// 新建或合并一条规则：同一本体位置已有规则则并入目标（排除名单不动，解除排除走 `include`）
pub fn upsert_auto_link(rules: &mut Vec<AutoLink>, source: &Path, targets: &[String]) {
    let source = normalize(source);
    let rule = match rules.iter().position(|r| r.source == source) {
        Some(i) => &mut rules[i],
        None => {
            rules.push(AutoLink {
                source,
                targets: Vec::new(),
                excluded: BTreeSet::new(),
            });
            rules.last_mut().expect("刚 push 过")
        }
    };
    for t in targets {
        if !rule.targets.contains(t) {
            rule.targets.push(t.clone());
        }
    }
}

pub fn remove_auto_link(rules: &mut Vec<AutoLink>, source: &Path) {
    let source = normalize(source);
    rules.retain(|r| r.source != source);
}

/// 从该本体位置的规则里去掉这些目标（域页的 × 只撤本域的部分）；目标去空则整条删除
pub fn remove_auto_link_targets(rules: &mut Vec<AutoLink>, source: &Path, targets: &[String]) {
    let source = normalize(source);
    let Some(i) = rules.iter().position(|r| r.source == source) else {
        return;
    };
    rules[i].targets.retain(|t| !targets.contains(t));
    if rules[i].targets.is_empty() {
        rules.remove(i);
    }
}

/// 该 skill 不再自动链接（手动清除软链时调用）
pub fn exclude(rules: &mut [AutoLink], source: &Path, skill: &str) {
    if let Some(rule) = find_rule_mut(rules, source) {
        rule.excluded.insert(skill.to_string());
    }
}

/// 解除排除，该 skill 重新纳入自动链接
pub fn include(rules: &mut [AutoLink], source: &Path, skill: &str) {
    if let Some(rule) = find_rule_mut(rules, source) {
        rule.excluded.remove(skill);
    }
}

/// 该 (本体位置, skill) 是否在某条规则的范围内（被排除的不算）
pub fn covering<'a>(rules: &'a [AutoLink], source_id: &str, skill: &str) -> Option<&'a AutoLink> {
    rules
        .iter()
        .find(|r| r.source.to_string_lossy() == source_id && !r.excluded.contains(skill))
}

/// 规则里的 source 与 `Source.path` 都是 normalize 过的绝对路径
fn find_source<'a>(sources: &'a [Source], source: &Path) -> Option<&'a Source> {
    let source = normalize(source);
    sources.iter().find(|s| s.path == source)
}

fn find_rule_mut<'a>(rules: &'a mut [AutoLink], source: &Path) -> Option<&'a mut AutoLink> {
    let source = normalize(source);
    rules.iter_mut().find(|r| r.source == source)
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

    /// 行的 (本体位置 id, skill, own)
    fn rows(page: &DomainPage) -> Vec<(String, String, bool)> {
        page.rows
            .iter()
            .map(|r| (r.source_id.clone(), r.skill.clone(), r.own))
            .collect()
    }

    fn cell(source: &Source, skill: &str, target: &Target) -> CellRef {
        CellRef {
            source_id: source.id.clone(),
            skill: skill.into(),
            target_id: target.id.clone(),
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
                (sources[0].id.clone(), "a".into(), true),
                (sources[0].id.clone(), "b".into(), true)
            ]
        );
        let proj = &ov.domains[1];
        // 项目域：自有 c、d 全部成行；universal 只有被链的 a，不带入 b（本体位置不属于本域）
        assert_eq!(
            rows(proj),
            vec![
                (sources[0].id.clone(), "a".into(), false),
                (sources[1].id.clone(), "c".into(), true),
                (sources[1].id.clone(), "d".into(), true),
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
        let cells = vec![
            cell(&sources[0], "a", &targets[0]),   // Missing → Create
            cell(&sources[0], "a", &targets[1]),   // Missing → Create
            cell(&sources[0], "b", &targets[0]),   // Duplicate：忽略
            cell(&sources[0], "b", &targets[1]),   // Missing → Create
            cell(&sources[0], "c", &targets[0]),   // Foreign：忽略
            cell(&sources[0], "a", &targets[0]),   // 重复格：去重
            cell(&sources[0], "d", &targets[2]),   // 引入场景：项目页里没有这行
            cell(&sources[0], "zzz", &targets[0]), // skill 不存在：忽略
            CellRef {
                source_id: sources[0].id.clone(),
                skill: "a".into(),
                target_id: "nope".into(),
            }, // 目标不存在：忽略
        ];
        let mut paths: Vec<PathBuf> = propose_links(&sources, &targets, &cells)
            .into_iter()
            .inspect(|a| assert_eq!(a.kind, ActionKind::Create))
            .map(|a| a.target_path)
            .collect();
        paths.sort();
        let mut expect = vec![
            claude.join("a"),
            codex.join("a"),
            codex.join("b"),
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
        // a、b 在三个目标上的全部 6 格
        let mut cells: Vec<CellRef> = Vec::new();
        for skill in ["a", "b"] {
            for t in &targets {
                cells.push(cell(&sources[0], skill, t));
            }
        }
        let acts = propose_unlinks(&sources, &targets, &cells);
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].kind, ActionKind::Unlink);
        assert_eq!(acts[0].target_path, claude.join("a"));
        assert_eq!(acts[0].source_path, universal.join("a"));
    }

    #[test]
    fn auto_link_cells_expands_rules_and_skips_excluded_missing_source_or_target() {
        let tree = TempTree::new();
        let universal = tree.dir("universal");
        for s in ["a", "b", "c"] {
            tree.dir(&format!("universal/{s}"));
        }
        let claude = tree.dir("home/.claude/skills");
        let codex = tree.dir("home/.codex/skills");
        let sources = vec![source(&universal, &["a", "b", "c"])];
        let targets = vec![global("claude-code", &claude), global("codex", &codex)];
        let rules = vec![
            AutoLink {
                source: normalize(&universal),
                // "nope" 目标不存在：跳过
                targets: vec!["claude-code".into(), "nope".into()],
                excluded: ["b".to_string()].into_iter().collect(),
            },
            // 本体位置不存在：整条跳过
            AutoLink {
                source: tree.root().join("gone"),
                targets: vec!["codex".into()],
                excluded: BTreeSet::new(),
            },
        ];
        let cells = auto_link_cells(&sources, &targets, &rules);
        assert_eq!(
            cells,
            vec![
                cell(&sources[0], "a", &targets[0]),
                cell(&sources[0], "c", &targets[0]),
            ]
        );
        // 只对缺失的格建链
        tree.link(&claude.join("a"), &universal.join("a"));
        let acts = propose_links(&sources, &targets, &cells);
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].target_path, claude.join("c"));
    }

    #[test]
    fn rule_maintenance_upserts_removes_and_toggles_exclusions() {
        let mut rules: Vec<AutoLink> = Vec::new();
        let source = PathBuf::from("/a/skills");
        let dotted = PathBuf::from("/a/./skills/"); // 同一处的非归一化写法
        upsert_auto_link(&mut rules, &source, &["claude-code".into()]);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].source, source);
        // 同 source 合并目标，不重复
        upsert_auto_link(&mut rules, &dotted, &["claude-code".into(), "codex".into()]);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].targets, vec!["claude-code", "codex"]);

        exclude(&mut rules, &dotted, "x");
        assert!(rules[0].excluded.contains("x"));
        // upsert 不动排除名单
        upsert_auto_link(&mut rules, &source, &["cursor".into()]);
        assert!(rules[0].excluded.contains("x"));
        assert!(covering(&rules, "/a/skills", "x").is_none());
        assert!(covering(&rules, "/a/skills", "y").is_some());
        assert!(covering(&rules, "/other", "y").is_none());

        include(&mut rules, &dotted, "x");
        assert!(rules[0].excluded.is_empty());
        assert!(covering(&rules, "/a/skills", "x").is_some());

        // 别的 source 不受影响
        exclude(&mut rules, Path::new("/other"), "x");
        assert!(rules[0].excluded.is_empty());
        remove_auto_link(&mut rules, Path::new("/other"));
        assert_eq!(rules.len(), 1);
        remove_auto_link(&mut rules, &dotted);
        assert!(rules.is_empty());
    }

    #[test]
    fn remove_auto_link_targets_trims_and_drops_the_emptied_rule() {
        let mut rules: Vec<AutoLink> = Vec::new();
        let source = PathBuf::from("/a/skills");
        let dotted = PathBuf::from("/a/./skills/"); // 同一处的非归一化写法
        upsert_auto_link(
            &mut rules,
            &source,
            &["claude-code".into(), "codex".into(), "cursor".into()],
        );

        // source 不匹配：无事发生
        remove_auto_link_targets(&mut rules, Path::new("/other"), &["codex".into()]);
        assert_eq!(rules[0].targets, vec!["claude-code", "codex", "cursor"]);

        // 只去掉本次给的目标，其余保留
        remove_auto_link_targets(&mut rules, &dotted, &["codex".into(), "none".into()]);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].targets, vec!["claude-code", "cursor"]);

        // 去空 → 整条规则删除
        remove_auto_link_targets(
            &mut rules,
            &source,
            &["claude-code".into(), "cursor".into()],
        );
        assert!(rules.is_empty());
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

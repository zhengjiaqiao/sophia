//! 按域（全局 / 每个项目）组织的扫描：行的两类来源、格状态、按选中格生成建链 / 删链动作、整目录链接拆分
use crate::fs::{create_link, entry_kind, normalize, real_path, remove_link, same_real, EntryKind};
use crate::models::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 拆分报告里代表那条目录级软链的条目名
const WHOLE_LINK_ITEM: &str = "<整目录链接>";

/// 全局域的 key
const GLOBAL_KEY: &str = "global";

/// 外部位置不属于任何域，用一个不会与域 key 相等的值占位
const EXTERNAL_KEY: &str = "external";

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

/// 本体位置属于哪个域：项目仓库归它自己的项目，通用仓库 / harness 全局 / 手动归全局。
/// 外部位置不属于任何域，返回一个不会等于任何域 key 的值
fn source_domain(kind: &SourceKind) -> String {
    match kind {
        SourceKind::ProjectStore { project, .. } => project_key(project),
        SourceKind::External => EXTERNAL_KEY.to_string(),
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

/// 该列的任一目录下都有一条解析到该 skill 本体路径的软链
fn links_to(target: &Target, skill: &Skill) -> bool {
    target.dirs.iter().any(|dir| {
        let path = dir.join(&skill.name);
        matches!(entry_kind(&path), EntryKind::Symlink(_)) && same_real(&path, &skill.path)
    })
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
                let linked = || d_targets.iter().any(|t| links_to(t, skill));
                if own || linked() {
                    keys.insert((skill.name.clone(), s.label.clone(), s.id.clone()));
                }
            }
        }

        let rows: Vec<DomainRow> = keys
            .into_iter()
            .filter_map(|(skill, _, source_id)| {
                let source = by_id.get(source_id.as_str())?;
                let skill_path = source.skill_path(&skill)?.to_path_buf();
                let cells: Vec<Cell> = d_targets
                    .iter()
                    .map(|t| cell_for(source, &skill, &skill_path, t))
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
            .flat_map(|t| t.dirs.iter())
            .flat_map(|dir| broken_links(dir))
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
        let Some(skill_path) = source.skill_path(&cell.skill) else {
            continue;
        };
        let Some(target) = targets.iter().find(|t| t.id == cell.target_id) else {
            continue;
        };
        // 多目录列逐个目录判定，只对命中谓词的目录生成动作
        for dir in &target.dirs {
            let path = dir.join(&cell.skill);
            if !wanted(slot_state(source, skill_path, target, dir, &path), target) {
                continue;
            }
            if !seen.insert(path.clone()) {
                continue;
            }
            out.push(PlannedAction {
                kind,
                item_name: cell.skill.clone(),
                source_path: skill_path.to_path_buf(),
                target_path: path,
                target: dir.clone(),
            });
        }
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
        // 外部位置由 harness 目录里的软链合成，规则不该指向它
        if source.kind == SourceKind::External {
            continue;
        }
        for target_id in &rule.targets {
            if !targets.iter().any(|t| &t.id == target_id) {
                continue;
            }
            for skill in &source.skills {
                if rule.excluded.contains(&skill.name) {
                    continue;
                }
                out.push(CellRef {
                    source_id: source.id.clone(),
                    skill: skill.name.clone(),
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

/// 从该本体位置的规则里去掉这些目标（域页的 × 只撤本域的部分）；
/// 目标与排除名单都空了才整条删除——只剩排除名单的规则仍要保住排除效果
pub fn remove_auto_link_targets(rules: &mut Vec<AutoLink>, source: &Path, targets: &[String]) {
    let source = normalize(source);
    let Some(i) = rules.iter().position(|r| r.source == source) else {
        return;
    };
    rules[i].targets.retain(|t| !targets.contains(t));
    if rules[i].targets.is_empty() && rules[i].excluded.is_empty() {
        rules.remove(i);
    }
}

/// 该 skill 不再自动链接（手动清除软链时调用）。
/// 该本体位置还没有规则时新建一条只有排除名单的规则：多目录列的自动扇出
/// 不靠规则驱动，排除也必须能独立于规则存在
pub fn exclude(rules: &mut Vec<AutoLink>, source: &Path, skill: &str) {
    let source = normalize(source);
    match rules.iter().position(|r| r.source == source) {
        Some(i) => {
            rules[i].excluded.insert(skill.to_string());
        }
        None => rules.push(AutoLink {
            source,
            targets: Vec::new(),
            excluded: BTreeSet::from([skill.to_string()]),
        }),
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

/// 该 (本体位置, skill) 是否被某条规则明确排除过。
/// 与 `covering` 不同：这里问的是"是否被排除"，不要求该规则真的覆盖到某个目标
fn is_excluded(rules: &[AutoLink], source: &Path, skill: &str) -> bool {
    let source = normalize(source);
    rules
        .iter()
        .any(|r| r.source == source && r.excluded.contains(skill))
}

/// 规则里的 source 与 `Source.path` 都是 normalize 过的绝对路径
fn find_source<'a>(sources: &'a [Source], source: &Path) -> Option<&'a Source> {
    let source = normalize(source);
    sources.iter().find(|s| normalize(&s.path) == source)
}

fn find_rule_mut<'a>(rules: &'a mut [AutoLink], source: &Path) -> Option<&'a mut AutoLink> {
    let source = normalize(source);
    rules.iter_mut().find(|r| r.source == source)
}

/// 列上单个目录的状态。`skill_path` 是该 skill 在本体位置里的真实路径，
/// `dir` 是这一个目标目录，`path` 是它在该目录下的位置
fn slot_state(
    source: &Source,
    skill_path: &Path,
    target: &Target,
    dir: &Path,
    path: &Path,
) -> CellState {
    match target.linked_whole_to.as_deref() {
        Some(id) if id == source.id => return CellState::Linked,
        Some(_) => return CellState::Unwritable,
        None => {}
    }
    // 目标就是本体位置本身（如 WeiboAP 的 custom 目录既是本体位置又是目标）：内容天然到位
    if same_real(dir, &source.path) {
        return CellState::Own;
    }
    match entry_kind(path) {
        EntryKind::Missing => CellState::Missing,
        EntryKind::Dir | EntryKind::File => CellState::Duplicate,
        EntryKind::Symlink(_) if real_path(path).is_none() => CellState::Broken,
        EntryKind::Symlink(_) if same_real(path, skill_path) => CellState::Linked,
        EntryKind::Symlink(_) => CellState::Foreign,
    }
}

/// 列上每个目录各自求状态，再聚合成一格。异常优先，不被"部分成功"掩盖
fn cell_for(source: &Source, skill: &str, skill_path: &Path, target: &Target) -> Cell {
    let slots = slot_states(source, skill, skill_path, target);
    let total = slots.len();
    let linked = slots
        .iter()
        .filter(|(_, s)| matches!(s, CellState::Own | CellState::Linked))
        .count();
    let abnormal = |want: &[CellState]| {
        slots
            .iter()
            .find(|(_, s)| want.contains(s))
            .map(|(_, s)| *s)
    };
    let state = if let Some(bad) = abnormal(&[CellState::Broken]) {
        bad
    } else if let Some(bad) = abnormal(&[
        CellState::Foreign,
        CellState::Duplicate,
        CellState::Unwritable,
    ]) {
        bad
    } else if linked == total {
        if slots.iter().all(|(_, s)| *s == CellState::Own) {
            CellState::Own
        } else {
            CellState::Linked
        }
    } else if linked == 0 {
        CellState::Missing
    } else {
        CellState::Partial
    };
    Cell {
        source_id: source.id.clone(),
        skill: skill.to_string(),
        target_id: target.id.clone(),
        path: target.main_dir().join(skill),
        state,
        linked,
        total,
    }
}

fn slot_states(
    source: &Source,
    skill: &str,
    skill_path: &Path,
    target: &Target,
) -> Vec<(PathBuf, CellState)> {
    target
        .dirs
        .iter()
        .map(|dir| {
            let path = dir.join(skill);
            let state = slot_state(source, skill_path, target, dir, &path);
            (path, state)
        })
        .collect()
}

/// 多目录列上，缺失的目录全是空目录（新建助手）且已有目录全部到位 → 自动补齐。
/// 空目录判据无需任何持久状态：新建助手的 skills 目录初始为空，
/// 用户单独同步过的助手目录非空，不会被误补。
/// 被任一规则排除的 (本体位置, skill) 一律跳过：用户手动清除过的软链不能被下一轮扫描补回
pub fn fan_out_cells(sources: &[Source], targets: &[Target], rules: &[AutoLink]) -> Vec<CellRef> {
    let mut out = Vec::new();
    for target in targets.iter().filter(|t| t.dirs.len() > 1) {
        for source in sources {
            // 外部位置由 harness 目录里的软链合成，与 auto_link_cells 一致不做扇出
            if source.kind == SourceKind::External {
                continue;
            }
            for skill in &source.skills {
                if is_excluded(rules, &source.path, &skill.name) {
                    continue;
                }
                let slots = slot_states(source, &skill.name, &skill.path, target);
                let present = slots
                    .iter()
                    .filter(|(_, s)| matches!(s, CellState::Own | CellState::Linked))
                    .count();
                if present == 0 {
                    continue;
                }
                let fillable = slots.iter().all(|(path, state)| match state {
                    CellState::Own | CellState::Linked => true,
                    CellState::Missing => path.parent().is_some_and(is_empty_dir),
                    _ => false,
                });
                if !fillable {
                    continue;
                }
                out.push(CellRef {
                    source_id: source.id.clone(),
                    skill: skill.name.clone(),
                    target_id: target.id.clone(),
                });
            }
        }
    }
    out
}

fn is_empty_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
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

/// 目标属于某项目且 skill 本体在该项目内 → 相对路径（随 git 走），否则绝对路径
pub fn link_style(skill_path: &Path, target: &Target) -> LinkStyle {
    match &target.scope {
        TargetScope::Project { project, .. }
            if normalize(skill_path).starts_with(normalize(project)) =>
        {
            LinkStyle::Relative
        }
        _ => LinkStyle::Absolute,
    }
}

/// 把"目标目录整体是一条指向本体位置的软链"拆成逐项链接：删软链 → 建真实目录 → 逐个 skill 建链。
/// 前置检查不过或任一步失败即停止，已建的链接保留
pub fn split_whole_link(target: &Target, source: &Source) -> SyncReport {
    let dir = target.dirs.first().cloned().unwrap_or_default();
    let parent = dir.parent().map(Path::to_path_buf).unwrap_or_default();
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
        dir.clone(),
    );
    // 扇出列的目录由 harness 自己创建，没有"整目录链接"可拆
    if target.dirs.len() != 1 {
        return report(vec![ReportEntry {
            action: remove,
            outcome: Outcome::Failed("多目录列不支持拆分".into()),
        }]);
    }
    let mut entries = Vec::new();
    let is_whole_link =
        matches!(entry_kind(&dir), EntryKind::Symlink(_)) && same_real(&dir, &source.path);
    if !is_whole_link {
        return report(vec![ReportEntry {
            action: remove,
            outcome: Outcome::Failed("目标不是指向该本体位置的整目录链接".into()),
        }]);
    }
    if let Err(e) = remove_link(&dir) {
        return report(vec![ReportEntry {
            action: remove,
            outcome: Outcome::Failed(e.to_string()),
        }]);
    }
    entries.push(ReportEntry {
        action: remove,
        outcome: Outcome::Removed,
    });
    if let Err(e) = std::fs::create_dir(&dir) {
        entries.push(ReportEntry {
            action: action(
                ActionKind::Create,
                WHOLE_LINK_ITEM,
                source.path.clone(),
                dir.clone(),
            ),
            outcome: Outcome::Failed(e.to_string()),
        });
        return report(entries);
    }
    for skill in &source.skills {
        let source_path = skill.path.clone();
        let target_path = dir.join(&skill.name);
        let style = link_style(&source_path, target);
        let outcome = match create_link(&source_path, &target_path, style) {
            Ok(()) => Outcome::Created,
            Err(e) => Outcome::Failed(e.to_string()),
        };
        let failed = matches!(outcome, Outcome::Failed(_));
        entries.push(ReportEntry {
            action: PlannedAction {
                kind: ActionKind::Create,
                item_name: skill.name.clone(),
                source_path,
                target_path,
                target: dir.clone(),
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
            skills: skills
                .iter()
                .map(|s| Skill {
                    name: s.to_string(),
                    path: path.join(s),
                })
                .collect(),
            path,
        }
    }

    fn source(path: &Path, skills: &[&str]) -> Source {
        make_source(path, "本体", SourceKind::Universal, skills)
    }

    /// 外部位置：由 harness 目录里指向它的软链合成
    fn external_source(path: &Path, skills: &[&str]) -> Source {
        make_source(path, "外部", SourceKind::External, skills)
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
        multi(harness, &[path])
    }

    /// 多目录的全局列（WeiboAP 扇出列）
    fn multi(harness: &str, dirs: &[&Path]) -> Target {
        Target {
            id: harness.to_string(),
            label: harness.to_string(),
            dirs: dirs.iter().map(|d| normalize(d)).collect(),
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
            dirs: vec![normalize(path)],
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

    /// 多目录列：a 已链接、b 缺失 → partial 1/2
    #[test]
    fn partial_cell_counts_linked_dirs() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let a = t.dir("a");
        let b = t.dir("b");
        t.link(&a.join("x"), &store.join("x"));
        let s = source(&store, &["x"]);
        let tgt = multi("weiboap", &[&a, &b]);
        let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
        let c = &o.domains[0].rows[0].cells[0];
        assert_eq!(c.state, CellState::Partial);
        assert_eq!((c.linked, c.total), (1, 2));
        assert_eq!(c.path, a.join("x")); // 代表路径取 main_dir
                                         // 补齐只针对缺失的那个目录
        let acts = propose_links(
            std::slice::from_ref(&s),
            std::slice::from_ref(&tgt),
            &[cell(&s, "x", &tgt)],
        );
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].target_path, b.join("x"));
        assert_eq!(acts[0].target, b);
    }

    /// 全缺失的多目录列：一格补齐生成每个目录一条 Create
    #[test]
    fn missing_cell_fans_out_one_action_per_dir() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let dirs: Vec<PathBuf> = ["a", "b", "c", "d"].iter().map(|d| t.dir(d)).collect();
        let s = source(&store, &["x"]);
        let tgt = multi(
            "weiboap",
            &dirs.iter().map(|d| d.as_path()).collect::<Vec<_>>(),
        );
        let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
        let c = &o.domains[0].rows[0].cells[0];
        assert_eq!(c.state, CellState::Missing);
        assert_eq!((c.linked, c.total), (0, 4));
        let paths: Vec<PathBuf> = propose_links(
            std::slice::from_ref(&s),
            std::slice::from_ref(&tgt),
            &[cell(&s, "x", &tgt)],
        )
        .into_iter()
        .map(|a| a.target_path)
        .collect();
        assert_eq!(
            paths,
            dirs.iter().map(|d| d.join("x")).collect::<Vec<PathBuf>>()
        );
    }

    /// Own 与 Linked 混合 → 全部到位
    #[test]
    fn own_dir_counts_as_linked_in_aggregate() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let b = t.dir("b");
        t.link(&b.join("x"), &store.join("x"));
        let s = source(&store, &["x"]);
        let tgt = multi("weiboap", &[&store, &b]); // 第一个目录就是本体位置本身
        let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
        let c = &o.domains[0].rows[0].cells[0];
        assert_eq!(c.state, CellState::Linked);
        assert_eq!((c.linked, c.total), (2, 2));
        assert!(propose_links(
            std::slice::from_ref(&s),
            std::slice::from_ref(&tgt),
            &[cell(&s, "x", &tgt)]
        )
        .is_empty());
    }

    /// 异常不被部分成功掩盖
    #[test]
    fn broken_dir_wins_over_partial() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let a = t.dir("a");
        let b = t.dir("b");
        let c = t.dir("c");
        t.link(&a.join("x"), &store.join("x"));
        t.link(&b.join("x"), &t.root().join("gone")); // 坏链
        let s = source(&store, &["x"]);
        let tgt = multi("weiboap", &[&a, &b, &c]);
        let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
        assert_eq!(o.domains[0].rows[0].cells[0].state, CellState::Broken);
    }

    /// 无 Broken 时 Foreign / Duplicate 同样优先于 Partial
    #[test]
    fn foreign_dir_wins_over_partial() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let a = t.dir("a");
        let b = t.dir("b");
        t.link(&a.join("x"), &store.join("x"));
        t.link(&b.join("x"), &t.dir("elsewhere")); // 指向别处
        let s = source(&store, &["x"]);
        let tgt = multi("weiboap", &[&a, &b]);
        let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
        assert_eq!(o.domains[0].rows[0].cells[0].state, CellState::Foreign);
    }

    /// AC10：已有目录全部到位、新目录为空 → 自动补齐
    #[test]
    fn fan_out_fills_a_brand_new_empty_agent_dir() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        t.dir("store/y");
        let dirs: Vec<PathBuf> = ["a", "b", "c", "d"].iter().map(|d| t.dir(d)).collect();
        for d in &dirs[..3] {
            t.link(&d.join("x"), &store.join("x"));
        }
        // y 只在 a 上有 → 不自动补齐；同时让 a 非空
        t.link(&dirs[0].join("y"), &store.join("y"));
        let s = source(&store, &["x", "y"]);
        let tgt = multi(
            "weiboap",
            &dirs.iter().map(|d| d.as_path()).collect::<Vec<_>>(),
        );
        let sources = [s.clone()];
        let targets = [tgt.clone()];
        assert_eq!(
            fan_out_cells(&sources, &targets, &[]),
            vec![cell(&s, "x", &tgt)]
        );
        let acts = propose_links(&sources, &targets, &fan_out_cells(&sources, &targets, &[]));
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].target_path, dirs[3].join("x"));
    }

    /// AC11：缺失目录非空（用户自己维护过）→ 不自动补齐，仍是 partial
    #[test]
    fn fan_out_skips_dirs_that_are_not_empty() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let dirs: Vec<PathBuf> = ["a", "b", "c", "d"].iter().map(|d| t.dir(d)).collect();
        t.link(&dirs[0].join("x"), &store.join("x"));
        for d in &dirs[1..] {
            t.file(d, "keep.md"); // 非空但缺 x
        }
        let s = source(&store, &["x"]);
        let tgt = multi(
            "weiboap",
            &dirs.iter().map(|d| d.as_path()).collect::<Vec<_>>(),
        );
        assert!(
            fan_out_cells(std::slice::from_ref(&s), std::slice::from_ref(&tgt), &[]).is_empty()
        );
        let o = scan(std::slice::from_ref(&s), std::slice::from_ref(&tgt));
        assert_eq!(o.domains[0].rows[0].cells[0].state, CellState::Partial);
    }

    /// 单目录列与一个都没到位的多目录列都不自动补齐
    #[test]
    fn fan_out_needs_a_multi_dir_column_with_something_already_in_place() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let a = t.dir("a");
        let b = t.dir("b");
        let s = source(&store, &["x"]);
        // 单目录列：空目录也不补
        let single = global("claude-code", &a);
        assert!(
            fan_out_cells(std::slice::from_ref(&s), std::slice::from_ref(&single), &[]).is_empty()
        );
        // 多目录列但一处都没有：不是"新助手"，不补
        let tgt = multi("weiboap", &[&a, &b]);
        assert!(
            fan_out_cells(std::slice::from_ref(&s), std::slice::from_ref(&tgt), &[]).is_empty()
        );
    }

    /// 手动清除过的 skill 不能被下一轮扇出补回，即使缺失目录全是空目录；
    /// 外部本体位置也不做扇出（与 auto_link_cells 一致）
    #[test]
    fn fan_out_skips_excluded_skills_and_external_sources() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let a = t.dir("a");
        let b = t.dir("b"); // 空目录，本来会被自动补齐
        t.link(&a.join("x"), &store.join("x"));
        let s = source(&store, &["x"]);
        let tgt = multi("weiboap", &[&a, &b]);
        let sources = [s.clone()];
        let targets = [tgt.clone()];
        assert_eq!(
            fan_out_cells(&sources, &targets, &[]),
            vec![cell(&s, "x", &tgt)]
        );

        // 只有排除名单、没有任何目标的规则同样能挡住扇出
        let mut rules: Vec<AutoLink> = Vec::new();
        exclude(&mut rules, &store, "x");
        assert!(rules[0].targets.is_empty());
        assert!(fan_out_cells(&sources, &targets, &rules).is_empty());

        // 解除排除后恢复自动补齐
        include(&mut rules, &store, "x");
        assert_eq!(
            fan_out_cells(&sources, &targets, &rules),
            vec![cell(&s, "x", &tgt)]
        );

        // 别的本体位置的排除名单管不着这一处
        let mut other: Vec<AutoLink> = Vec::new();
        exclude(&mut other, Path::new("/elsewhere"), "x");
        assert_eq!(
            fan_out_cells(&sources, &targets, &other),
            vec![cell(&s, "x", &tgt)]
        );

        // 外部本体位置不做扇出
        let ext = [external_source(&store, &["x"])];
        assert!(fan_out_cells(&ext, &targets, &[]).is_empty());
    }

    /// AC9：助手自己的域是单目录列，补齐只写它自己
    #[test]
    fn per_agent_column_writes_only_its_own_dir() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/x");
        let root_a = t.dir("agents/a");
        let a = t.dir("agents/a/skills");
        let b = t.dir("agents/b/skills");
        let s = source(&store, &["x"]);
        let only_a = project(&root_a, "weiboap", &a);
        let acts = propose_links(
            std::slice::from_ref(&s),
            std::slice::from_ref(&only_a),
            &[cell(&s, "x", &only_a)],
        );
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].target_path, a.join("x"));
        assert!(!b.join("x").exists());
    }

    /// 多目录列没有整目录链接可拆
    #[test]
    fn split_whole_link_refuses_multi_dir_columns() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let x = t.dir("x");
        let y = t.dir("y");
        let r = split_whole_link(&multi("weiboap", &[&x, &y]), &source(&store, &["a"]));
        assert_eq!(r.entries.len(), 1);
        assert_eq!(
            r.entries[0].outcome,
            Outcome::Failed("多目录列不支持拆分".into())
        );
        assert_eq!(entry_kind(&x), EntryKind::Dir);
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

        // 别的 source 不受影响；它没有规则，exclude 会新建一条只有排除名单的
        exclude(&mut rules, Path::new("/other"), "x");
        assert!(rules[0].excluded.is_empty());
        assert_eq!(rules.len(), 2);
        assert!(rules[1].targets.is_empty());
        assert!(rules[1].excluded.contains("x"));
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

    /// 排除名单非空时，目标去空也要保住整条规则，否则扇出会把清除过的软链补回来
    #[test]
    fn remove_auto_link_targets_keeps_a_rule_that_still_excludes_something() {
        let mut rules: Vec<AutoLink> = Vec::new();
        let source = PathBuf::from("/a/skills");
        upsert_auto_link(&mut rules, &source, &["codex".into()]);
        exclude(&mut rules, &source, "x");

        remove_auto_link_targets(&mut rules, &source, &["codex".into()]);
        assert_eq!(rules.len(), 1);
        assert!(rules[0].targets.is_empty());
        assert!(rules[0].excluded.contains("x"));

        // 排除名单也清空后才真正删除
        include(&mut rules, &source, "x");
        remove_auto_link_targets(&mut rules, &source, &["codex".into()]);
        assert!(rules.is_empty());
    }

    #[test]
    fn link_style_is_relative_only_for_skills_inside_the_target_project() {
        let t = TempTree::new();
        let proj = t.dir("proj");
        let inside = source(&t.dir("proj/.agents/skills"), &["a"]);
        let outside = source(&t.dir("store"), &["a"]);
        let p = project(&proj, "claude-code", &t.dir("proj/.claude/skills"));
        let g = global("claude-code", &t.dir("g"));
        let at = |s: &Source| s.skill_path("a").unwrap().to_path_buf();
        assert_eq!(link_style(&at(&inside), &p), LinkStyle::Relative);
        assert_eq!(link_style(&at(&outside), &p), LinkStyle::Absolute);
        assert_eq!(link_style(&at(&inside), &g), LinkStyle::Absolute);
        assert_eq!(link_style(&at(&outside), &g), LinkStyle::Absolute);
    }

    #[test]
    fn external_sources_link_from_their_real_path_and_own_no_domain() {
        let t = TempTree::new();
        let ego = t.dir("opt/ego-skills");
        let browser = t.dir("opt/ego-skills/ego-browser");
        let writer = t.dir("opt/ego-skills/ego-writer");
        let claude = t.dir("home/.claude/skills");
        t.link(&claude.join("ego-browser"), &browser); // Linked
                                                       // ego-writer 目标里没有 → Missing
        let s = external_source(&ego, &["ego-browser", "ego-writer"]);
        let tg = global("claude-code", &claude);
        let sources = vec![s.clone()];
        let targets = vec![tg.clone()];

        let ov = scan(&sources, &targets);
        // 外部位置不属于任何域：只有被链接的那行成行，own 恒为 false
        assert_eq!(
            rows(&ov.domains[0]),
            vec![(s.id.clone(), "ego-browser".into(), false)]
        );
        assert_eq!(ov.domains[0].rows[0].cells[0].state, CellState::Linked);

        // 未成行的 ego-writer 也能建链，链接指向真实路径而非 位置/名字 的拼接
        let acts = propose_links(&sources, &targets, &[cell(&s, "ego-writer", &tg)]);
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].source_path, writer);
        assert_eq!(acts[0].target_path, claude.join("ego-writer"));

        // 自动同步不接受外部位置
        let rules = vec![AutoLink {
            source: normalize(&ego),
            targets: vec![tg.id.clone()],
            excluded: BTreeSet::new(),
        }];
        assert!(auto_link_cells(&sources, &targets, &rules).is_empty());
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

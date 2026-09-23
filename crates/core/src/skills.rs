//! 按域（全局 / 每个项目）组织的扫描：行的两类来源、格状态、按选中格生成建链 / 删链动作、整目录链接拆分
use crate::fs::{create_link, entry_kind, normalize, real_path, remove_link, same_real, EntryKind};
use crate::models::*;
use crate::subscriptions::{subscribed, Subscriptions};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 拆分报告里代表那条目录级软链的条目名
pub(crate) const WHOLE_LINK_ITEM: &str = "<整目录链接>";

/// 全局域的 key
pub(crate) const GLOBAL_KEY: &str = "global";

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

pub(crate) fn dir_name(path: &Path) -> String {
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
pub(crate) fn group_domains(targets: &[Target]) -> Vec<(String, String, Vec<Target>)> {
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

/// `t/name` 是解析到该 skill 本体路径的软链
pub(crate) fn links_to(target: &Target, skill: &Skill) -> bool {
    let path = target.path.join(&skill.name);
    matches!(entry_kind(&path), EntryKind::Symlink(_)) && same_real(&path, &skill.path)
}

/// 只读扫描，按域组织。只产出事实，不作任何选择。
/// 行 = 这个域已订阅的来源（见 `subscriptions::subscribed`）的**全部** skill，没链的格是 Missing
pub fn scan(sources: &[Source], targets: &[Target], subs: &Subscriptions) -> Overview {
    let by_id: BTreeMap<&str, &Source> = sources.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut domains = Vec::new();
    // 目录尚不存在的目标照常成列：格状态自然全是 Missing，补齐时由 `sync::execute` 建目录
    for (key, label, d_targets) in group_domains(targets) {
        // 行 = 已订阅来源的全部 skill；(skill, 本体位置 label, 本体位置 id) 排序去重
        let mut keys: BTreeSet<(String, String, String)> = BTreeSet::new();
        for s in sources {
            if !subscribed(s, &key, &d_targets, subs) {
                continue;
            }
            for skill in &s.skills {
                keys.insert((skill.name.clone(), s.label.clone(), s.id.clone()));
            }
        }

        let rows: Vec<DomainRow> = keys
            .into_iter()
            .filter_map(|(skill, _, source_id)| {
                let source = by_id.get(source_id.as_str())?;
                let skill_path = source.skill_path(&skill)?.to_path_buf();
                let cells: Vec<Cell> = d_targets
                    .iter()
                    .map(|t| {
                        let path = t.path.join(&skill);
                        let (state, points_to) = cell_facts(source, &skill_path, t, &path);
                        Cell {
                            source_id: source_id.clone(),
                            skill: skill.clone(),
                            target_id: t.id.clone(),
                            state,
                            points_to,
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

        // 整目录链接的目标读进去就是本体位置，坏链清理不能删到本体位置里；
        // 目录还不存在的目标里没有东西可读，`read_dir` 是无谓 IO
        let broken = d_targets
            .iter()
            .filter(|t| t.exists && t.linked_whole_to.is_none())
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

/// 选中格里的 Missing 格 → Create。本体位置 / skill / 目标 id 对不上的格忽略；按 target_path 去重。
/// 目录尚不存在的目标照常产出 Create，目录由 `sync::execute` 就地创建
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

/// 选中格里的 Linked 格（目标非整目录链接）→ Unlink。规则同上。
/// 目录还不存在的目标里没有可删的东西，一律不产出动作
pub fn propose_unlinks(
    sources: &[Source],
    targets: &[Target],
    cells: &[CellRef],
) -> Vec<PlannedAction> {
    propose_by(
        sources,
        targets,
        cells,
        |state, target| {
            target.exists && state == CellState::Linked && target.linked_whole_to.is_none()
        },
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
        let path = target.path.join(&cell.skill);
        if !wanted(cell_state(source, skill_path, target, &path), target) {
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
            target: target.path.clone(),
        });
    }
    out
}

/// 自动同步规则展开成格：本体位置找不到 / 目标找不到 → 跳过；skill 在排除名单或
/// 这个目标的 baseline（目标加进规则时已有的）里 → 跳过；还没有 baseline 的旧规则整条跳过。
/// 随后交给 `propose_links`，只对 Missing 建链
pub fn auto_link_cells(sources: &[Source], targets: &[Target], rules: &[AutoLink]) -> Vec<CellRef> {
    let mut out = Vec::new();
    for rule in rules {
        // 规则只管以后新出现的：没有 baseline 就分不清哪些是新的，宁可不建
        let Some(baseline) = &rule.baseline else {
            continue;
        };
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
            let baseline = rule.target_baselines.get(target_id).unwrap_or(baseline);
            for skill in &source.skills {
                if rule.excluded.contains(&skill.name) || baseline.contains(&skill.name) {
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

/// 新建或合并一条规则：同一本体位置已有规则则并入目标（排除名单不动，解除排除走 `include`）。
/// 规则从无到有（新建，或原先只剩排除名单、没有目标）时拍 baseline：`sources` 里该位置
/// 当前的全部 skill 名；位置不在 `sources` 里即一个都没有。已生效的规则并入新目标时，
/// 整条的 baseline 不动，只给新目标单独拍一份（`target_baselines`）：新目标同样只管以后新出现的，
/// 不把建规则之后出现过的补建过去——来源管理页在另一个位置打开开关就是这种情况
pub fn upsert_auto_link(
    rules: &mut Vec<AutoLink>,
    sources: &[Source],
    source: &Path,
    targets: &[String],
) {
    let source = normalize(source);
    let snapshot = || source_names(sources, &source).unwrap_or_default();
    let rule = match rules.iter().position(|r| r.source == source) {
        Some(i) => &mut rules[i],
        None => {
            rules.push(AutoLink {
                source: source.clone(),
                targets: Vec::new(),
                excluded: BTreeSet::new(),
                baseline: None,
                target_baselines: BTreeMap::new(),
            });
            rules.last_mut().expect("刚 push 过")
        }
    };
    if rule.targets.is_empty() {
        rule.baseline = Some(snapshot());
        rule.target_baselines.clear();
        for t in targets {
            if !rule.targets.contains(t) {
                rule.targets.push(t.clone());
            }
        }
        return;
    }
    for t in targets {
        if !rule.targets.contains(t) {
            rule.targets.push(t.clone());
            rule.target_baselines.insert(t.clone(), snapshot());
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
    rules[i]
        .target_baselines
        .retain(|t, _| !targets.contains(t));
    if rules[i].targets.is_empty() && rules[i].excluded.is_empty() {
        rules.remove(i);
    }
}

/// 该 skill 不再自动链接（手动清除软链时调用）。
/// 该本体位置还没有规则时新建一条只有排除名单的规则：排除要能独立于规则存在，
/// 否则手动清除过的软链会被之后新建的规则补回来
pub fn exclude(rules: &mut Vec<AutoLink>, source: &Path, skill: &str) {
    let source = normalize(source);
    match rules.iter().position(|r| r.source == source) {
        Some(i) => {
            rules[i].excluded.insert(skill.to_string());
        }
        // 没有目标的规则不建任何链；baseline 等 `upsert_auto_link` 加目标时再拍
        None => rules.push(AutoLink {
            source,
            targets: Vec::new(),
            excluded: BTreeSet::from([skill.to_string()]),
            baseline: Some(BTreeSet::new()),
            target_baselines: BTreeMap::new(),
        }),
    }
}

/// 升级迁移：给没有 baseline 的旧规则补上本体位置当前的全部 skill 名，
/// 于是旧规则从这一刻起也只管以后新出现的。本体位置这次没扫到的先不补（可能只是暂时
/// 不在，补成空集会在它回来时把现有的全部补建），规则继续整条跳过。返回是否改动过
pub fn migrate_baselines(rules: &mut [AutoLink], sources: &[Source]) -> bool {
    let mut changed = false;
    for rule in rules.iter_mut().filter(|r| r.baseline.is_none()) {
        if let Some(names) = source_names(sources, &rule.source) {
            rule.baseline = Some(names);
            changed = true;
        }
    }
    changed
}

/// 该本体位置当前的全部 skill 名；位置不在 `sources` 里 → None
fn source_names(sources: &[Source], source: &Path) -> Option<BTreeSet<String>> {
    find_source(sources, source).map(|s| s.skills.iter().map(|k| k.name.clone()).collect())
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
    sources.iter().find(|s| normalize(&s.path) == source)
}

fn find_rule_mut<'a>(rules: &'a mut [AutoLink], source: &Path) -> Option<&'a mut AutoLink> {
    let source = normalize(source);
    rules.iter_mut().find(|r| r.source == source)
}

/// `skill_path` 是该 skill 在本体位置里的真实路径，`path` 是它在目标目录下的位置
fn cell_state(source: &Source, skill_path: &Path, target: &Target, path: &Path) -> CellState {
    cell_facts(source, skill_path, target, path).0
}

/// 一格的两件事实：状态，以及这一格上的软链解析后落在哪。
/// 落点在判 Foreign 的同一刻就现成，丢掉的话前端只能把提示条写成含糊的「指向别处」
fn cell_facts(
    source: &Source,
    skill_path: &Path,
    target: &Target,
    path: &Path,
) -> (CellState, Option<PathBuf>) {
    match target.linked_whole_to.as_deref() {
        // 整目录链到本体位置自己：内容经由那条目录级软链落到本体上
        Some(id) if id == source.id => return (CellState::Linked, real_path(path)),
        Some(_) => return (CellState::WholeLinked, None),
        None => {}
    }
    // 目标就是本体位置本身（如 WeiboAP 的 custom 目录既是本体位置又是目标）：内容天然到位
    if same_real(&target.path, &source.path) {
        return (CellState::Own, None);
    }
    match entry_kind(path) {
        EntryKind::Missing => (CellState::Missing, None),
        EntryKind::Dir | EntryKind::File => (CellState::Duplicate, None),
        // 断链：real_path 解析不到，本来也没有落点
        EntryKind::Symlink(_) => match real_path(path) {
            None => (CellState::Broken, None),
            // 比较是否同一处两侧都走 real_path：macOS 上 /var 会变成 /private/var
            Some(dest) => {
                let same = real_path(skill_path).is_some_and(|body| body == dest);
                let state = if same {
                    CellState::Linked
                } else {
                    CellState::Foreign
                };
                (state, Some(dest))
            }
        },
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
    for skill in &source.skills {
        let source_path = skill.path.clone();
        let target_path = target.path.join(&skill.name);
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

/// 删一个 skill 本体前的只读体检：体量、受影响的链接、是否在 git 仓库内、删完改指到哪。
/// 只产出事实，不动文件系统；`sources` 给全部已知本体位置，`relink_to` 从里面找同名的另一处
pub fn plan_delete_source(
    skill: &Skill,
    sources: &[Source],
    targets: &[Target],
) -> DeleteSourcePlan {
    let path = normalize(&skill.path);
    let (entries, bytes, modified) = dir_size(&path);
    let relink_to = same_name_elsewhere(&skill.name, sources, &path);
    // 比较"是否同一处"两侧都要走 real_path：macOS 上 /var 会变成 /private/var
    let real = real_path(&path);
    DeleteSourcePlan {
        entries,
        bytes,
        affected: match &real {
            // 改指后链接指向的是 relink_to，写法按它算；没有可改指的地方时链接不会被重写，
            // 拿本体自己的写法占位
            Some(real) => links_into(real, targets, relink_to.as_deref().unwrap_or(&path)),
            None => Vec::new(),
        },
        in_git: git_root(&path),
        relink_to,
        modified,
        path,
    }
}

/// 读原件目录下 `SKILL.md` 的 YAML frontmatter 里的 `description`，只读。
///
/// 不引 yaml 依赖，逐行解析够用：frontmatter 是开头 `---` 与下一个 `---` 之间；
/// 顶格的 `description:` 一行，值支持单行（可带引号）、`|` 字面块（保留换行）、
/// `>` 折叠块（换行折成空格，空行成段）以及缩进续行的朴素多行。
/// 没有文件、没有 frontmatter、没有这个键或值为空时返回 None
pub fn read_description(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    parse_description(&text)
}

fn parse_description(text: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let front: Vec<&str> = lines.take_while(|l| l.trim_end() != "---").collect();
    let at = front.iter().position(|l| l.starts_with("description:"))?;
    let head = front[at]["description:".len()..].trim();
    // 这个键之后、下一个顶格键之前的缩进行（空行也算进块里）
    let body: Vec<&str> = front[at + 1..]
        .iter()
        .take_while(|l| l.trim().is_empty() || l.starts_with([' ', '\t']))
        .copied()
        .collect();
    let indent = body
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let body: Vec<&str> = body
        .iter()
        .map(|l| {
            if l.trim().is_empty() {
                ""
            } else {
                &l[indent..]
            }
        })
        .collect();
    let value = if head.starts_with('|') {
        body.join("\n")
    } else if head.starts_with('>') || head.is_empty() {
        fold(&body)
    } else {
        let first = unquote(head);
        let rest = fold(&body);
        if rest.is_empty() {
            first.to_string()
        } else {
            format!("{first} {rest}")
        }
    };
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// 折叠：相邻非空行用空格接，空行成段
fn fold(lines: &[&str]) -> String {
    let mut out = String::new();
    let mut blank = false;
    for line in lines {
        if line.trim().is_empty() {
            blank = true;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank { "\n" } else { " " });
        }
        out.push_str(line.trim());
        blank = false;
    }
    out
}

fn unquote(s: &str) -> &str {
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// 递归统计条目数（不含自身）、普通文件字节数，以及普通文件最新的修改时间（Unix 毫秒）。
/// 软链只当作一个条目，不跟随、不计字节、不计时间；目录自身的 mtime 不算（增删条目就会变，
/// 说的不是「内容改于何时」）。一个文件都没有、或时间读不出来时为 None
fn dir_size(path: &Path) -> (usize, u64, Option<u64>) {
    let Ok(rd) = std::fs::read_dir(path) else {
        return (0, 0, None);
    };
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut modified: Option<u64> = None;
    for e in rd.flatten() {
        entries += 1;
        let child = e.path();
        match entry_kind(&child) {
            EntryKind::Dir => {
                let (n, b, m) = dir_size(&child);
                entries += n;
                bytes += b;
                modified = modified.max(m);
            }
            EntryKind::File => {
                if let Ok(meta) = std::fs::symlink_metadata(&child) {
                    bytes += meta.len();
                    let ms = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64);
                    modified = modified.max(ms);
                }
            }
            _ => {}
        }
    }
    (entries, bytes, modified)
}

/// 各目标目录里解析后落在 `real`（本体的真实路径）之内、含它自身的软链。
/// 整目录链接的目标读进去就是本体位置本身，里面没有指向它的链接可改，跳过。
/// 每条链接的写法按「改指后要指向的本体 `dest` 与该链接所属目标」当场算：
/// 项目内的链接要保住相对写法，它随 git 走到别的机器上才仍然成立
fn links_into(real: &Path, targets: &[Target], dest: &Path) -> Vec<AffectedLink> {
    let mut out: BTreeMap<PathBuf, LinkStyle> = BTreeMap::new();
    for t in targets.iter().filter(|t| t.linked_whole_to.is_none()) {
        let Ok(rd) = std::fs::read_dir(&t.path) else {
            continue;
        };
        for e in rd.flatten() {
            let link = e.path();
            if !matches!(entry_kind(&link), EntryKind::Symlink(_)) {
                continue;
            }
            // starts_with 按路径分量比较；两侧都是 real_path 的结果，同源
            if real_path(&link).is_some_and(|d| d.starts_with(real)) {
                out.insert(link, link_style(dest, t));
            }
        }
    }
    out.into_iter()
        .map(|(path, style)| AffectedLink { path, style })
        .collect()
}

/// 自下而上找 `.git`（工作树与子模块里它是文件，不是目录）。
/// `ancestors` 按路径分量逐级上走，不做字符串前缀比较
fn git_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| !matches!(entry_kind(&dir.join(".git")), EntryKind::Missing))
        .map(Path::to_path_buf)
}

/// 别处同名、且真实存在的另一个本体；多处时取 `sources` 里的第一处
fn same_name_elsewhere(name: &str, sources: &[Source], path: &Path) -> Option<PathBuf> {
    sources
        .iter()
        .flat_map(|s| &s.skills)
        .filter(|s| s.name == name)
        .map(|s| normalize(&s.path))
        .find(|p| real_path(p).is_some() && !same_real(p, path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    /// 还没有订阅记录时的扫描：自己的来源与此刻有链的来源成行
    fn scan(sources: &[Source], targets: &[Target]) -> Overview {
        super::scan(sources, targets, &Subscriptions::new())
    }

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
                    description: None,
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
        Target {
            id: harness.to_string(),
            label: harness.to_string(),
            path: normalize(path),
            scope: TargetScope::Global {
                harness_id: harness.to_string(),
            },
            exists: true,
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
            exists: true,
            linked_whole_to: None,
        }
    }

    /// 目录尚不存在的项目目标（列头标「将新建目录」的那种）
    fn absent_target(project_root: &Path, harness: &str, path: &Path) -> Target {
        Target {
            exists: false,
            ..project(project_root, harness, path)
        }
    }

    /// 来源是订阅单位：有一条链就算订阅，它的全部 skill 成行，没链的是 Missing
    #[test]
    fn rows_are_own_skills_plus_every_skill_of_linked_sources() {
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
        // 项目域：自有 c、d 全部成行；universal 链了 a 就算订阅，没链的 b 也成行
        assert_eq!(
            rows(proj),
            vec![
                (sources[0].id.clone(), "a".into(), false),
                (sources[0].id.clone(), "b".into(), false),
                (sources[1].id.clone(), "c".into(), true),
                (sources[1].id.clone(), "d".into(), true),
            ]
        );
        assert_eq!(proj.rows[0].cells[0].state, CellState::Linked);
        assert_eq!(proj.rows[1].cells[0].state, CellState::Missing);
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

    /// AC9：在助手自己的域里补齐，只写它自己的目录
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

    /// AC1 / AC6：目录不存在的目标照常成列，其格为 Missing；坏链只扫已存在的目标；
    /// 目录建出来后同一列的链接状态照常
    #[test]
    fn scan_lists_targets_whose_dir_is_absent_as_missing_columns() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let proj = t.dir("proj");
        let claude = t.dir("proj/.claude/skills");
        t.link(&claude.join("rotten"), &t.root().join("gone"));
        let absent = proj.join(".agents/skills");

        let s = store_source(&store, "proj", &proj, &["a"]);
        let here = project(&proj, "claude-code", &claude);
        let not_yet = absent_target(&proj, "codex", &absent);
        let ids = |ts: &[Target]| ts.iter().map(|t| t.id.clone()).collect::<Vec<_>>();

        let ov = scan(std::slice::from_ref(&s), &[here.clone(), not_yet.clone()]);
        assert_eq!(ov.domains.len(), 1);
        let page = &ov.domains[0];
        // 两个目标都成列
        assert_eq!(
            ids(&page.targets),
            vec![here.id.clone(), not_yet.id.clone()]
        );
        assert_eq!(page.rows.len(), 1);
        assert_eq!(
            page.rows[0]
                .cells
                .iter()
                .map(|c| c.target_id.clone())
                .collect::<Vec<_>>(),
            vec![here.id.clone(), not_yet.id.clone()]
        );
        // 目录不存在的那格自然是 Missing
        assert_eq!(page.rows[0].cells[0].state, CellState::Missing);
        assert_eq!(page.rows[0].cells[1].state, CellState::Missing);
        // 坏链只扫已存在的目标
        assert_eq!(
            page.broken
                .iter()
                .map(|a| a.item_name.clone())
                .collect::<Vec<_>>(),
            vec!["rotten".to_string()]
        );
        // 扫描不许把目录建出来
        assert_eq!(entry_kind(&absent), EntryKind::Missing);

        // 补齐后目录已建：下一轮同一列的链接状态照常
        std::fs::create_dir_all(&absent).unwrap();
        t.link(&absent.join("a"), &store.join("a"));
        let ov = scan(
            std::slice::from_ref(&s),
            &[here.clone(), project(&proj, "codex", &absent)],
        );
        let page = &ov.domains[0];
        assert_eq!(
            ids(&page.targets),
            vec![here.id.clone(), not_yet.id.clone()]
        );
        assert_eq!(page.rows[0].cells[1].state, CellState::Linked);
    }

    /// R3 / 设计 §1：目录不存在的目标也能生成 Create；`exists == false` 的目标不产出 Unlink
    #[test]
    fn propose_links_covers_absent_dirs_while_unlinks_skip_them() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let proj = t.dir("proj");
        let absent = proj.join(".agents/skills");
        let s = store_source(&store, "proj", &proj, &["a"]);
        let not_yet = absent_target(&proj, "codex", &absent);

        // 选中一个目录尚不存在的格 → 照常生成 Create
        let acts = propose_links(
            std::slice::from_ref(&s),
            std::slice::from_ref(&not_yet),
            &[cell(&s, "a", &not_yet)],
        );
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].kind, ActionKind::Create);
        assert_eq!(acts[0].target, absent);
        assert_eq!(acts[0].target_path, absent.join("a"));
        assert_eq!(entry_kind(&absent), EntryKind::Missing);

        // 目录在两次扫描之间被建了出来、里面已有链接：过期的 exists == false 仍不产出删链动作
        std::fs::create_dir_all(&absent).unwrap();
        t.link(&absent.join("a"), &store.join("a"));
        assert!(propose_unlinks(
            std::slice::from_ref(&s),
            std::slice::from_ref(&not_yet),
            &[cell(&s, "a", &not_yet)],
        )
        .is_empty());
        // 同一个目标标成已存在就照常产出
        let now = project(&proj, "codex", &absent);
        let acts = propose_unlinks(
            std::slice::from_ref(&s),
            std::slice::from_ref(&now),
            &[cell(&s, "a", &now)],
        );
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].kind, ActionKind::Unlink);
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
                baseline: Some(BTreeSet::new()),
                target_baselines: BTreeMap::new(),
            },
            // 本体位置不存在：整条跳过
            AutoLink {
                source: tree.root().join("gone"),
                targets: vec!["codex".into()],
                excluded: BTreeSet::new(),
                baseline: Some(BTreeSet::new()),
                target_baselines: BTreeMap::new(),
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
        upsert_auto_link(&mut rules, &[], &source, &["claude-code".into()]);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].source, source);
        // 同 source 合并目标，不重复
        upsert_auto_link(
            &mut rules,
            &[],
            &dotted,
            &["claude-code".into(), "codex".into()],
        );
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].targets, vec!["claude-code", "codex"]);

        exclude(&mut rules, &dotted, "x");
        assert!(rules[0].excluded.contains("x"));
        // upsert 不动排除名单
        upsert_auto_link(&mut rules, &[], &source, &["cursor".into()]);
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
            &[],
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

    /// 排除名单非空时，目标去空也要保住整条规则，否则排除记录会一起丢掉
    #[test]
    fn remove_auto_link_targets_keeps_a_rule_that_still_excludes_something() {
        let mut rules: Vec<AutoLink> = Vec::new();
        let source = PathBuf::from("/a/skills");
        upsert_auto_link(&mut rules, &[], &source, &["codex".into()]);
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

    /// 真实目录里读本体位置（手动添加的位置），与界面上扫描走同一条 `discovery::sources`
    fn scan_sources(tree: &TempTree, dir: &Path) -> Vec<Source> {
        let env = crate::discovery::Env {
            home: tree.dir("home"),
            vars: Default::default(),
        };
        crate::discovery::sources(&env, &[], &[], &[dir.to_path_buf()])
    }

    /// 本轮会真的建的链：规则展开 → 只对 Missing 建链
    fn auto_actions(tree: &TempTree, dir: &Path, t: &Target, rules: &[AutoLink]) -> Vec<String> {
        let sources = scan_sources(tree, dir);
        let targets = vec![t.clone()];
        let cells = auto_link_cells(&sources, &targets, rules);
        propose_links(&sources, &targets, &cells)
            .into_iter()
            .map(|a| a.item_name)
            .collect()
    }

    /// 规则只管以后新出现的：建规则时已有的不补建；新增的建；排除照旧；删了重建会重拍 baseline
    #[test]
    fn auto_link_rule_only_covers_skills_that_appear_after_it() {
        let tree = TempTree::new();
        let store = tree.dir("store");
        tree.dir("store/a");
        tree.dir("store/b");
        let claude = tree.dir("home/.claude/skills");
        let t = global("claude-code", &claude);
        let mut rules: Vec<AutoLink> = Vec::new();

        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            std::slice::from_ref(&t.id),
        );
        assert_eq!(
            rules[0].baseline,
            Some(BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
        // 已有的 a、b 不建链
        assert!(auto_actions(&tree, &store, &t, &rules).is_empty());

        // 新出现的 c 建，且只建它
        tree.dir("store/c");
        let acts = auto_actions(&tree, &store, &t, &rules);
        assert_eq!(acts, vec!["c"]);
        tree.link(&claude.join("c"), &store.join("c"));

        // 并入目标不重拍 baseline
        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            &["codex".into()],
        );
        assert!(!rules[0].baseline.as_ref().unwrap().contains("c"));

        // 排除名单照旧生效
        tree.dir("store/d");
        exclude(&mut rules, &store, "d");
        assert!(auto_actions(&tree, &store, &t, &rules).is_empty());

        // 删掉规则再建：baseline 重拍成此刻的全部
        remove_auto_link(&mut rules, &store);
        tree.dir("store/e");
        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            std::slice::from_ref(&t.id),
        );
        assert_eq!(
            rules[0].baseline,
            Some(["a", "b", "c", "d", "e"].map(String::from).into())
        );
        assert!(auto_actions(&tree, &store, &t, &rules).is_empty());
        tree.dir("store/f");
        assert_eq!(auto_actions(&tree, &store, &t, &rules), vec!["f"]);
    }

    /// 只剩排除名单的规则（exclude 先于规则建出来的）加上目标时才算建规则，这时拍 baseline
    #[test]
    fn exclude_only_rule_snapshots_baseline_when_it_gains_targets() {
        let tree = TempTree::new();
        let store = tree.dir("store");
        tree.dir("store/a");
        let claude = tree.dir("home/.claude/skills");
        let t = global("claude-code", &claude);
        let mut rules: Vec<AutoLink> = Vec::new();
        exclude(&mut rules, &store, "x");
        tree.dir("store/b");
        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            std::slice::from_ref(&t.id),
        );
        assert_eq!(
            rules[0].baseline,
            Some(BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
        assert!(rules[0].excluded.contains("x"));
        assert!(auto_actions(&tree, &store, &t, &rules).is_empty());
    }

    /// 规则已生效后再加的目标（另一个位置打开开关、或多勾一个 agent）也只管从那一刻起新出现的：
    /// 建规则之后出现、已经补到老目标上的 skill 不补到新目标
    #[test]
    fn target_added_to_a_live_rule_only_covers_skills_after_it_joined() {
        let tree = TempTree::new();
        let store = tree.dir("store");
        tree.dir("store/a");
        let claude = tree.dir("home/.claude/skills");
        let proj = tree.dir("proj");
        let proj_claude = tree.dir("proj/.claude/skills");
        let g = global("claude-code", &claude);
        let p = project(&proj, "claude-code", &proj_claude);
        let both = vec![g.clone(), p.clone()];
        let run = |rules: &[AutoLink]| {
            let sources = scan_sources(&tree, &store);
            let cells = auto_link_cells(&sources, &both, rules);
            let mut out: Vec<(String, PathBuf)> = propose_links(&sources, &both, &cells)
                .into_iter()
                .map(|a| (a.item_name, a.target))
                .collect();
            out.sort();
            out
        };
        let mut rules: Vec<AutoLink> = Vec::new();
        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            std::slice::from_ref(&g.id),
        );
        // 建规则之后出现的 b：补到全局
        tree.dir("store/b");
        assert_eq!(run(&rules), vec![("b".to_string(), claude.clone())]);
        tree.link(&claude.join("b"), &store.join("b"));

        // 项目里打开开关：b 不补过去，整条的 baseline 不动
        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            std::slice::from_ref(&p.id),
        );
        assert_eq!(rules[0].baseline, Some(BTreeSet::from(["a".to_string()])));
        assert!(run(&rules).is_empty());

        // 之后新出现的 c：两处都加
        tree.dir("store/c");
        assert_eq!(
            run(&rules),
            vec![
                ("c".to_string(), claude.clone()),
                ("c".to_string(), proj_claude.clone())
            ]
        );

        // 撤掉项目的目标，它那份 baseline 一并丢掉；再打开时重拍
        remove_auto_link_targets(&mut rules, &store, std::slice::from_ref(&p.id));
        assert!(rules[0].target_baselines.is_empty());
        tree.link(&claude.join("c"), &store.join("c"));
        upsert_auto_link(
            &mut rules,
            &scan_sources(&tree, &store),
            &store,
            std::slice::from_ref(&p.id),
        );
        assert!(run(&rules).is_empty());
    }

    /// 升级前持久化的规则没有 baseline：迁移前整条不建，迁移取当前全部名字，此后只建新的
    #[test]
    fn legacy_rule_without_baseline_migrates_to_current_skills() {
        let tree = TempTree::new();
        let store = tree.dir("store");
        tree.dir("store/a");
        tree.dir("store/b");
        let claude = tree.dir("home/.claude/skills");
        let t = global("claude-code", &claude);
        let json = format!(
            r#"[{{"source":{:?},"targets":["claude-code"],"excluded":[]}}]"#,
            normalize(&store).to_string_lossy()
        );
        let mut rules: Vec<AutoLink> = serde_json::from_str(&json).unwrap();
        assert_eq!(rules[0].baseline, None);
        // 迁移前：旧规则不再补建
        assert!(auto_actions(&tree, &store, &t, &rules).is_empty());

        // 本体位置这次没扫到：不迁移
        assert!(!migrate_baselines(&mut rules, &[]));
        assert_eq!(rules[0].baseline, None);

        assert!(migrate_baselines(&mut rules, &scan_sources(&tree, &store)));
        assert_eq!(
            rules[0].baseline,
            Some(BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
        // 迁移只做一次
        assert!(!migrate_baselines(&mut rules, &scan_sources(&tree, &store)));
        assert!(auto_actions(&tree, &store, &t, &rules).is_empty());
        tree.dir("store/c");
        assert_eq!(auto_actions(&tree, &store, &t, &rules), vec!["c"]);
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
        // 外部位置不属于任何域（own 恒为 false）；有一条链就算订阅，它的 skill 全部成行
        assert_eq!(
            rows(&ov.domains[0]),
            vec![
                (s.id.clone(), "ego-browser".into(), false),
                (s.id.clone(), "ego-writer".into(), false)
            ]
        );
        assert_eq!(ov.domains[0].rows[0].cells[0].state, CellState::Linked);

        // 没链的 ego-writer 能建链，链接指向真实路径而非 位置/名字 的拼接
        let acts = propose_links(&sources, &targets, &[cell(&s, "ego-writer", &tg)]);
        assert_eq!(acts.len(), 1);
        assert_eq!(acts[0].source_path, writer);
        assert_eq!(acts[0].target_path, claude.join("ego-writer"));

        // 自动同步不接受外部位置
        let rules = vec![AutoLink {
            source: normalize(&ego),
            targets: vec![tg.id.clone()],
            excluded: BTreeSet::new(),
            baseline: Some(BTreeSet::new()),
            target_baselines: BTreeMap::new(),
        }];
        assert!(auto_link_cells(&sources, &targets, &rules).is_empty());
    }

    /// 整目录链到别的本体位置的目标，格是 WholeLinked（原 Unwritable，不是"目录只读"）；
    /// 链到本体位置自己的那个目标照常算 Linked
    #[test]
    fn cells_of_a_whole_linked_target_are_whole_linked() {
        let t = TempTree::new();
        let store = t.dir("store");
        t.dir("store/a");
        let other = t.dir("other");
        t.dir("other/a");
        let mine = t.root().join("mine");
        t.link(&mine, &store);
        let theirs = t.root().join("theirs");
        t.link(&theirs, &other);

        let s = source(&store, &["a"]);
        let mut mine_t = global("cursor", &mine);
        mine_t.linked_whole_to = Some(s.id.clone());
        let mut theirs_t = global("codex", &theirs);
        theirs_t.linked_whole_to = Some(normalize(&other).to_string_lossy().into_owned());
        let ov = scan(std::slice::from_ref(&s), &[mine_t, theirs_t]);
        let cells = &ov.domains[0].rows[0].cells;
        assert_eq!(cells[0].state, CellState::Linked);
        // 内容经由目录级软链落到本体上
        assert_eq!(cells[0].points_to, Some(store.join("a")));
        assert_eq!(cells[1].state, CellState::WholeLinked);
        // 链到别处的整目录：这一格根本没有指向本体的链接
        assert_eq!(cells[1].points_to, None);
        // 扫描永远不产出 ReadOnly：判定它要实际试写
        assert!(ov.domains[0]
            .rows
            .iter()
            .flat_map(|r| &r.cells)
            .all(|c| c.state != CellState::ReadOnly));
    }

    /// 提示条要说出「指向哪个本体」：Linked / Foreign 带出落点，其余状态没有落点。
    /// Broken 特别注意——`real_path` 对断链返回 None，正好没有落点可言
    #[test]
    fn cells_carry_where_the_link_resolves_to_for_linked_and_foreign_only() {
        let t = TempTree::new();
        let store = t.dir("store");
        let names = ["broken", "dup", "foreign", "linked", "missing"];
        for n in names {
            t.dir(&format!("store/{n}"));
        }
        let other_body = t.dir("other/foreign"); // 别的本体位置里的同名 skill
        let claude = t.dir("home/.claude/skills");
        t.link(&claude.join("linked"), &store.join("linked"));
        t.link(&claude.join("foreign"), &other_body); // 指向别的本体
        t.link(&claude.join("broken"), &t.root().join("gone"));
        t.dir("home/.claude/skills/dup"); // 真实目录
                                          // missing 目标里没有

        let s = source(&store, &names);
        let ov = scan(std::slice::from_ref(&s), &[global("claude-code", &claude)]);
        let at = |skill: &str| {
            let row = ov.domains[0]
                .rows
                .iter()
                .find(|r| r.skill == skill)
                .expect("行应当在");
            (row.cells[0].state, row.cells[0].points_to.clone())
        };
        assert_eq!(
            at("linked"),
            (CellState::Linked, Some(store.join("linked")))
        );
        assert_eq!(at("foreign"), (CellState::Foreign, Some(other_body)));
        assert_eq!(at("broken"), (CellState::Broken, None));
        assert_eq!(at("dup"), (CellState::Duplicate, None));
        assert_eq!(at("missing"), (CellState::Missing, None));
    }

    /// 体检只报事实：体量、指向它的链接、别处的同名本体
    #[test]
    fn plan_delete_source_counts_the_body_and_collects_links_pointing_into_it() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/a");
        t.file(&body, "SKILL.md"); // 1 字节
        let sub = t.dir("store/a/refs");
        t.file(&sub, "note.md"); // 1 字节
        let other = t.dir("other");
        let other_body = t.dir("other/a");
        let claude = t.dir("home/.claude/skills");
        let codex = t.dir("home/.codex/skills");
        t.link(&claude.join("a"), &body); // 指向本体
        t.link(&claude.join("a-copy"), &body); // 换了名字，仍指向本体
        t.link(&claude.join("deep"), &sub); // 指向本体内部
        t.link(&claude.join("elsewhere"), &other_body); // 指向别处：不算
        t.dir("home/.codex/skills/a"); // 真实目录：不算

        let sources = vec![source(&store, &["a"]), source(&other, &["a"])];
        let targets = vec![global("claude-code", &claude), global("codex", &codex)];
        let skill = sources[0].skills[0].clone();
        let plan = plan_delete_source(&skill, &sources, &targets);

        assert_eq!(plan.path, body);
        // SKILL.md + refs + refs/note.md
        assert_eq!(plan.entries, 3);
        assert_eq!(plan.bytes, 2);
        assert_eq!(
            plan.affected,
            vec![claude.join("a"), claude.join("a-copy"), claude.join("deep")]
                .into_iter()
                .map(|path| AffectedLink {
                    path,
                    // 全局目标：改指后写绝对路径
                    style: LinkStyle::Absolute,
                })
                .collect::<Vec<_>>()
        );
        assert_eq!(plan.in_git, None);
        assert_eq!(plan.relink_to, Some(other_body));
    }

    #[test]
    fn read_description_takes_the_frontmatter_field_in_single_and_block_forms() {
        let t = TempTree::new();
        let write = |name: &str, body: &str| {
            let dir = t.dir(name);
            std::fs::write(dir.join("SKILL.md"), body).unwrap();
            dir
        };
        let single = write(
            "single",
            "---\nname: a\ndescription: Turns a codebase into an HTML course.\n---\n# body\n",
        );
        assert_eq!(
            read_description(&single).as_deref(),
            Some("Turns a codebase into an HTML course.")
        );
        let quoted = write("quoted", "---\ndescription: \"Say: hi\"\n---\n");
        assert_eq!(read_description(&quoted).as_deref(), Some("Say: hi"));
        let folded = write(
            "folded",
            "---\nname: b\ndescription: >\n  first line\n  second line\n\n  new para\nlicense: MIT\n---\n",
        );
        assert_eq!(
            read_description(&folded).as_deref(),
            Some("first line second line\nnew para")
        );
        let literal = write(
            "literal",
            "---\ndescription: |\n  line one\n  line two\n---\n",
        );
        assert_eq!(
            read_description(&literal).as_deref(),
            Some("line one\nline two")
        );
        let continued = write(
            "continued",
            "---\ndescription: starts here\n  and goes on\n---\n",
        );
        assert_eq!(
            read_description(&continued).as_deref(),
            Some("starts here and goes on")
        );
    }

    #[test]
    fn read_description_is_none_without_file_frontmatter_or_field() {
        let t = TempTree::new();
        assert_eq!(read_description(&t.dir("missing")), None);
        let no_front = t.dir("nofront");
        std::fs::write(
            no_front.join("SKILL.md"),
            "description: not in frontmatter\n",
        )
        .unwrap();
        assert_eq!(read_description(&no_front), None);
        let no_field = t.dir("nofield");
        std::fs::write(
            no_field.join("SKILL.md"),
            "---\nname: x\n---\ndescription: body\n",
        )
        .unwrap();
        assert_eq!(read_description(&no_field), None);
        let empty = t.dir("empty");
        std::fs::write(empty.join("SKILL.md"), "---\ndescription:\n---\n").unwrap();
        assert_eq!(read_description(&empty), None);
    }

    #[test]
    fn plan_delete_source_reports_the_newest_file_mtime_inside_the_body() {
        use std::time::{Duration, UNIX_EPOCH};
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/a");
        t.file(&body, "SKILL.md");
        let sub = t.dir("store/a/refs");
        t.file(&sub, "note.md");
        let set = |p: &Path, ms: u64| {
            std::fs::File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(ms))
                .unwrap();
        };
        set(&body.join("SKILL.md"), 1_700_000_000_000);
        // 子目录里的文件更新：取它
        set(&sub.join("note.md"), 1_758_326_400_000);
        let empty = t.dir("store/b");

        let sources = vec![source(&store, &["a", "b"])];
        let plan = plan_delete_source(&sources[0].skills[0], &sources, &[]);
        assert_eq!(plan.modified, Some(1_758_326_400_000));
        // 目录自身的时间不算：一个文件都没有就是 None
        assert_eq!(empty, sources[0].skills[1].path);
        let plan = plan_delete_source(&sources[0].skills[1], &sources, &[]);
        assert_eq!(plan.modified, None);
    }

    /// 只有一处本体时没有可改指的目标，如实为 None
    #[test]
    fn plan_delete_source_has_no_relink_target_when_the_name_exists_nowhere_else() {
        let t = TempTree::new();
        let store = t.dir("store");
        let body = t.dir("store/a");
        let other = t.dir("other");
        t.dir("other/b"); // 同一位置里的别的名字不算
        let gone = t.dir("gone");
        let sources = vec![
            source(&store, &["a"]),
            source(&other, &["b"]),
            // 同名但本体已不在磁盘上：不能改指过去
            source(&gone, &["a"]),
        ];
        std::fs::remove_dir_all(&gone).unwrap();
        let plan = plan_delete_source(&sources[0].skills[0].clone(), &sources, &[]);
        assert_eq!(plan.path, body);
        assert_eq!(plan.relink_to, None);
        assert!(plan.affected.is_empty());
    }

    /// git 仓库内的本体要报出仓库根：`.git` 是目录（常规仓库）或文件（工作树 / 子模块）都算
    #[test]
    fn plan_delete_source_finds_the_git_root_above_the_body() {
        let t = TempTree::new();
        let repo = t.dir("repo");
        t.dir("repo/.git");
        let store = t.dir("repo/.agents/skills");
        t.dir("repo/.agents/skills/a");
        let wt = t.dir("wt");
        t.file(&wt, ".git"); // 工作树里 .git 是文件
        let wt_store = t.dir("wt/skills");
        t.dir("wt/skills/a");
        let loose = t.dir("loose");
        t.dir("loose/a");

        let inside = source(&store, &["a"]);
        let worktree = source(&wt_store, &["a"]);
        let outside = source(&loose, &["a"]);
        let plan = |s: &Source| plan_delete_source(&s.skills[0].clone(), &[], &[]);
        assert_eq!(plan(&inside).in_git, Some(repo));
        assert_eq!(plan(&worktree).in_git, Some(wt));
        assert_eq!(plan(&outside).in_git, None);
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

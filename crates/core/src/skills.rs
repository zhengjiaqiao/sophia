//! skill × harness 矩阵：域内本体判定、格状态、建议动作
use crate::fs::{entry_kind, normalize, real_path, EntryKind};
use crate::models::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    /// 真实目录，本体在此
    Home,
    /// 链接解析后等于本域本体
    Linked,
    Missing,
    /// 链接目标不存在
    Broken,
    /// 链接指向本域本体之外
    Foreign,
    /// 真实目录，但本域另有本体（或多本体冲突）
    DuplicateHome,
    /// 整列目录不可读
    Inaccessible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub universal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub column_id: String,
    pub path: PathBuf,
    pub state: CellState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub name: String,
    pub home: Option<PathBuf>,
    pub external_home: bool,
    pub cells: Vec<Cell>,
    pub ambiguous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub skills: usize,
    pub missing: usize,
    pub broken: usize,
    pub ambiguous: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    pub domain: Domain,
    pub columns: Vec<Column>,
    pub rows: Vec<SkillRow>,
    pub summary: Summary,
}

pub const UNIVERSAL_ID: &str = "universal";

/// 全局域绝对路径，项目域相对路径（随 git 走）
pub fn link_style(domain: &Domain) -> LinkStyle {
    match domain {
        Domain::Global => LinkStyle::Absolute,
        Domain::Project { .. } => LinkStyle::Relative,
    }
}

fn universal_path(domain: &Domain, home: &Path) -> PathBuf {
    match domain {
        Domain::Global => home.join(".agents").join("skills"),
        Domain::Project { path } => path.join(".agents").join("skills"),
    }
}

/// 域内实际存在的 harness 目录，通用仓库列在前；按真实路径去重，同一目录的 harness 合并标签
pub fn columns(domain: &Domain, harnesses: &[Harness], home: &Path) -> Vec<Column> {
    let mut cols: Vec<Column> = Vec::new();
    let mut keys: Vec<PathBuf> = Vec::new();
    let mut push = |id: &str, label: &str, path: PathBuf, universal: bool| {
        if !path.is_dir() {
            return;
        }
        let key = real_path(&path).unwrap_or_else(|| normalize(&path));
        if let Some(i) = keys.iter().position(|k| k == &key) {
            cols[i].label = format!("{} / {}", cols[i].label, label);
            cols[i].universal |= universal;
        } else {
            keys.push(key);
            cols.push(Column {
                id: id.to_string(),
                label: label.to_string(),
                path,
                universal,
            });
        }
    };
    push(UNIVERSAL_ID, "通用仓库", universal_path(domain, home), true);
    for h in harnesses {
        let path = match domain {
            Domain::Global => h.global_dir.clone(),
            Domain::Project { path } => h.project_dir.as_ref().map(|d| path.join(d)),
        };
        if let Some(p) = path {
            push(&h.id, &h.display_name, p, h.universal);
        }
    }
    cols
}

/// 只读扫描，产出矩阵
pub fn scan(domain: &Domain, harnesses: &[Harness], home: &Path) -> Matrix {
    let columns = columns(domain, harnesses, home);
    let mut names = BTreeSet::new();
    let mut inaccessible = HashSet::new();
    for c in &columns {
        match std::fs::read_dir(&c.path) {
            Ok(rd) => {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().into_owned();
                    if !n.starts_with('.') {
                        names.insert(n);
                    }
                }
            }
            Err(_) => {
                inaccessible.insert(c.id.clone());
            }
        }
    }
    let rows: Vec<SkillRow> = names
        .iter()
        .map(|n| build_row(n, &columns, &inaccessible))
        .collect();
    // 摘要只统计会产生动作的格子，与 propose 保持一致
    let summary = Summary {
        skills: rows.len(),
        missing: rows
            .iter()
            .filter(|r| !r.ambiguous)
            .flat_map(|r| &r.cells)
            .filter(|c| c.state == CellState::Missing)
            .count(),
        broken: rows
            .iter()
            .filter(|r| !r.ambiguous)
            .flat_map(|r| &r.cells)
            .filter(|c| c.state == CellState::Broken)
            .count(),
        ambiguous: rows.iter().filter(|r| r.ambiguous).count(),
    };
    Matrix {
        domain: domain.clone(),
        columns,
        rows,
        summary,
    }
}

struct Entry<'a> {
    col: &'a Column,
    path: PathBuf,
    kind: EntryKind,
    real: Option<PathBuf>,
}

/// 本体判定：通用仓库真实目录 > 域内唯一真实目录 > 所有链接指向同一域外目录 > 多本体
fn build_row(name: &str, columns: &[Column], inaccessible: &HashSet<String>) -> SkillRow {
    let entries: Vec<Entry> = columns
        .iter()
        .map(|c| {
            let path = c.path.join(name);
            Entry {
                col: c,
                kind: entry_kind(&path),
                real: real_path(&path),
                path,
            }
        })
        .collect();
    let real_dirs: Vec<&Entry> = entries
        .iter()
        .filter(|e| e.kind == EntryKind::Dir)
        .collect();
    let live_targets: BTreeSet<PathBuf> = entries
        .iter()
        .filter(|e| matches!(e.kind, EntryKind::Symlink(_)))
        .filter_map(|e| e.real.clone())
        .filter(|p| p.is_dir())
        .collect();
    let mut external_home = false;
    let home: Option<PathBuf> = if let Some(e) = real_dirs.iter().find(|e| e.col.id == UNIVERSAL_ID)
    {
        e.real.clone()
    } else if real_dirs.len() == 1 {
        real_dirs[0].real.clone()
    } else if real_dirs.is_empty() && live_targets.len() == 1 {
        external_home = true;
        live_targets.iter().next().cloned()
    } else {
        None
    };
    let ambiguous = home.is_none() && (real_dirs.len() > 1 || live_targets.len() > 1);
    let cells = entries
        .iter()
        .map(|e| {
            let state = if inaccessible.contains(&e.col.id) {
                CellState::Inaccessible
            } else {
                match &e.kind {
                    EntryKind::Missing => CellState::Missing,
                    EntryKind::Dir | EntryKind::File => {
                        if e.real.is_some() && e.real == home {
                            CellState::Home
                        } else {
                            CellState::DuplicateHome
                        }
                    }
                    EntryKind::Symlink(_) => match &e.real {
                        None => CellState::Broken,
                        Some(r) if Some(r) == home.as_ref() => CellState::Linked,
                        Some(_) => CellState::Foreign,
                    },
                }
            };
            Cell {
                column_id: e.col.id.clone(),
                path: e.path.clone(),
                state,
            }
        })
        .collect();
    SkillRow {
        name: name.to_string(),
        home,
        external_home,
        cells,
        ambiguous,
    }
}

/// Missing → 建链指向本体；Broken → 删链。其余状态只报告；多本体行不生成动作
pub fn propose(matrix: &Matrix) -> Vec<PlannedAction> {
    matrix
        .rows
        .iter()
        .filter(|r| !r.ambiguous)
        .flat_map(|row| {
            row.cells.iter().filter_map(move |cell| {
                let target = cell
                    .path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default();
                match cell.state {
                    CellState::Missing => row.home.as_ref().map(|h| PlannedAction {
                        kind: ActionKind::Create,
                        item_name: row.name.clone(),
                        source_path: h.clone(),
                        target_path: cell.path.clone(),
                        target,
                    }),
                    CellState::Broken => {
                        let dest = match entry_kind(&cell.path) {
                            EntryKind::Symlink(d) => d,
                            _ => cell.path.clone(),
                        };
                        Some(PlannedAction {
                            kind: ActionKind::BrokenLink,
                            item_name: row.name.clone(),
                            source_path: dest,
                            target_path: cell.path.clone(),
                            target,
                        })
                    }
                    _ => None,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::entry_kind;
    use crate::fs::EntryKind;
    use crate::sync::execute;
    use crate::test_support::TempTree;
    use std::path::{Path, PathBuf};

    fn harnesses(home: &Path) -> Vec<Harness> {
        let h = |id: &str, name: &str, project: &str, global: PathBuf, universal: bool| Harness {
            id: id.into(),
            display_name: name.into(),
            project_dir: Some(project.into()),
            global_dir: Some(global),
            universal,
        };
        vec![
            h(
                "claude-code",
                "Claude Code",
                ".claude/skills",
                home.join(".claude/skills"),
                false,
            ),
            h(
                "codex",
                "Codex",
                ".agents/skills",
                home.join(".codex/skills"),
                true,
            ),
            h(
                "cline",
                "Cline",
                ".agents/skills",
                home.join(".agents/skills"),
                true,
            ),
        ]
    }
    fn states(row: &SkillRow) -> Vec<(String, CellState)> {
        row.cells
            .iter()
            .map(|c| (c.column_id.clone(), c.state))
            .collect()
    }
    fn row<'a>(m: &'a Matrix, name: &str) -> &'a SkillRow {
        m.rows.iter().find(|r| r.name == name).expect("row")
    }

    #[test]
    fn columns_put_universal_first_dedupe_by_real_path_and_skip_missing_dirs() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills");
        t.dir(".claude/skills");
        let cols = columns(&Domain::Global, &harnesses(&home), &home);
        assert_eq!(
            cols.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec![UNIVERSAL_ID, "claude-code"]
        );
        assert_eq!(cols[0].label, "通用仓库 / Cline");
        assert!(cols[0].universal);
    }

    #[test]
    fn fully_linked_skill_has_no_actions() {
        let t = TempTree::new();
        let home = t.root();
        let uni = t.dir(".agents/skills");
        let cl = t.dir(".claude/skills");
        let cx = t.dir(".codex/skills");
        let a = t.dir(".agents/skills/a");
        t.link(&cl.join("a"), &a);
        t.link(&cx.join("a"), &a);
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert_eq!(r.home, Some(a.clone()));
        assert!(!r.external_home && !r.ambiguous);
        assert_eq!(
            states(r),
            vec![
                (UNIVERSAL_ID.into(), CellState::Home),
                ("claude-code".into(), CellState::Linked),
                ("codex".into(), CellState::Linked)
            ]
        );
        assert_eq!(
            m.summary,
            Summary {
                skills: 1,
                missing: 0,
                broken: 0,
                ambiguous: 0
            }
        );
        assert!(propose(&m).is_empty());
        let _ = uni;
    }

    #[test]
    fn missing_cell_proposes_create_to_home() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills");
        let cl = t.dir(".claude/skills");
        let cx = t.dir(".codex/skills");
        let a = t.dir(".agents/skills/a");
        t.link(&cl.join("a"), &a);
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        assert_eq!(row(&m, "a").cells[2].state, CellState::Missing);
        let actions = propose(&m);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::Create);
        assert_eq!(actions[0].source_path, a);
        assert_eq!(actions[0].target_path, cx.join("a"));
        assert_eq!(actions[0].target, cx);
        assert_eq!(m.summary.missing, 1);
    }

    #[test]
    fn broken_link_row_without_home_proposes_removal_only() {
        let t = TempTree::new();
        let home = t.root();
        let uni = t.dir(".agents/skills");
        let cl = t.dir(".claude/skills");
        t.link(&cl.join("gone"), &uni.join("gone"));
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "gone");
        assert_eq!(r.home, None);
        assert!(!r.ambiguous);
        assert_eq!(r.cells[1].state, CellState::Broken);
        let actions = propose(&m);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind, ActionKind::BrokenLink);
        assert_eq!(actions[0].target_path, cl.join("gone"));
        assert_eq!(m.summary.broken, 1);
    }

    #[test]
    fn foreign_link_is_reported_not_acted_on() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills");
        let cl = t.dir(".claude/skills");
        t.dir(".agents/skills/a");
        let elsewhere = t.dir("elsewhere/a");
        t.link(&cl.join("a"), &elsewhere);
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert!(!r.ambiguous);
        assert_eq!(r.cells[1].state, CellState::Foreign);
        assert!(propose(&m).is_empty());
    }

    #[test]
    fn universal_store_wins_and_other_real_dir_is_duplicate() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills");
        let cl = t.dir(".claude/skills");
        t.dir(".codex/skills");
        let a = t.dir(".agents/skills/a");
        t.dir(".codex/skills/a");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert_eq!(r.home, Some(a.clone()));
        assert_eq!(
            states(r),
            vec![
                (UNIVERSAL_ID.into(), CellState::Home),
                ("claude-code".into(), CellState::Missing),
                ("codex".into(), CellState::DuplicateHome)
            ]
        );
        let actions = propose(&m);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].target_path, cl.join("a"));
        assert_eq!(actions[0].source_path, a);
    }

    #[test]
    fn single_real_dir_outside_store_becomes_home() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills");
        t.dir(".claude/skills");
        t.dir(".codex/skills");
        let pet = t.dir(".codex/skills/hatch-pet");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "hatch-pet");
        assert_eq!(r.home, Some(pet.clone()));
        assert_eq!(
            states(r),
            vec![
                (UNIVERSAL_ID.into(), CellState::Missing),
                ("claude-code".into(), CellState::Missing),
                ("codex".into(), CellState::Home)
            ]
        );
        assert_eq!(propose(&m).len(), 2);
    }

    #[test]
    fn links_to_one_external_dir_make_external_home() {
        let t = TempTree::new();
        let home = t.root();
        let uni = t.dir(".agents/skills");
        let cl = t.dir(".claude/skills");
        let ext = t.dir("local/ego-skills");
        t.link(&uni.join("ego"), &ext);
        t.link(&cl.join("ego"), &uni.join("ego"));
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "ego");
        assert_eq!(r.home, Some(ext.clone()));
        assert!(r.external_home && !r.ambiguous);
        assert_eq!(
            states(r),
            vec![
                (UNIVERSAL_ID.into(), CellState::Linked),
                ("claude-code".into(), CellState::Linked)
            ]
        );
        assert!(propose(&m).is_empty());
    }

    #[test]
    fn two_real_dirs_without_store_are_ambiguous() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".claude/skills/a");
        t.dir(".codex/skills/a");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert!(r.ambiguous);
        assert_eq!(r.home, None);
        assert!(r.cells.iter().all(|c| c.state == CellState::DuplicateHome));
        assert!(propose(&m).is_empty());
        assert_eq!(m.summary.ambiguous, 1);
        assert_eq!(m.summary.missing, 0);
        assert_eq!(m.summary.broken, 0);
    }

    #[cfg(unix)]
    #[test]
    fn project_domain_uses_relative_links() {
        let t = TempTree::new();
        let home = t.root();
        let proj = t.dir("proj");
        let x = t.dir("proj/.agents/skills/x");
        let cl = t.dir("proj/.claude/skills");
        let domain = Domain::Project { path: proj.clone() };
        let m = scan(&domain, &harnesses(&home), &home);
        assert_eq!(
            m.columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec![UNIVERSAL_ID, "claude-code"]
        );
        assert_eq!(row(&m, "x").cells[1].state, CellState::Missing);
        let report = execute(&propose(&m), false, link_style(&domain));
        assert_eq!(report.entries[0].outcome, Outcome::Created);
        assert_eq!(
            std::fs::read_link(cl.join("x")).unwrap(),
            PathBuf::from("../../.agents/skills/x")
        );
        assert_eq!(entry_kind(&cl.join("x")), EntryKind::Symlink(x.clone()));
        assert_eq!(
            row(&scan(&domain, &harnesses(&home), &home), "x").cells[1].state,
            CellState::Linked
        );
    }

    #[test]
    fn broken_cell_in_ambiguous_row_is_not_counted_or_proposed() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".claude/skills/a");
        t.dir(".codex/skills/a");
        let uni = t.dir(".agents/skills");
        t.link(&uni.join("a"), &t.root().join("gone/a"));
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        let r = row(&m, "a");
        assert!(r.ambiguous);
        assert_eq!(r.cells[0].state, CellState::Broken);
        assert_eq!(m.summary.broken, 0);
        assert!(propose(&m).is_empty());
    }

    #[test]
    fn hidden_entries_are_skipped() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".codex/skills/.system");
        t.dir(".codex/skills/real");
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        assert_eq!(
            m.rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["real"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_column_is_inaccessible_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills/a");
        let cl = t.dir(".claude/skills");
        std::fs::set_permissions(&cl, std::fs::Permissions::from_mode(0o000)).unwrap();
        let m = scan(&Domain::Global, &harnesses(&home), &home);
        std::fs::set_permissions(&cl, std::fs::Permissions::from_mode(0o755)).unwrap();
        if nix_is_root() {
            return;
        }
        assert_eq!(row(&m, "a").cells[1].state, CellState::Inaccessible);
        assert!(propose(&m).is_empty());
    }
    fn nix_is_root() -> bool {
        std::env::var("USER").map(|u| u == "root").unwrap_or(false)
    }
}

//! 内置 harness 表、已安装判定、项目候选、本体位置与目标发现
use crate::fs::{entry_kind, normalize, real_path, EntryKind};
use crate::models::{AgentLabels, Harness, Skill, Source, SourceKind, Target, TargetScope};
use crate::store::Settings;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

const HARNESSES_JSON: &str = include_str!("../data/harnesses.json");

#[derive(Debug, Deserialize)]
struct HarnessSpec {
    id: String,
    display_name: String,
    #[serde(default)]
    project_dir: Option<String>,
    #[serde(default)]
    global_dir: Vec<String>,
    #[serde(default)]
    detect_dir: Vec<String>,
    #[serde(default)]
    universal: bool,
    /// 每个 agent 一个项目的 skill 目录模板，允许单个路径分量为 `*`
    #[serde(default)]
    agent_dirs: Vec<String>,
    /// `global_dir` 由 harness 自己装配：仍是本体位置，但不生成可写列
    #[serde(default)]
    managed_global_dir: bool,
    /// agent 目录名 → 显示名的查表方式
    #[serde(default)]
    agent_labels: Option<AgentLabels>,
}

#[derive(Debug, Deserialize)]
struct HarnessFile {
    harnesses: Vec<HarnessSpec>,
}

/// 模板解析所需的环境：主目录与环境变量（测试时可伪造）
pub struct Env {
    pub home: PathBuf,
    pub vars: HashMap<String, String>,
}

impl Env {
    pub fn from_system() -> Self {
        Env {
            home: dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
            vars: std::env::vars().collect(),
        }
    }
}

/// 候选依次尝试："~/x" 用主目录，"$VAR/x" 用环境变量（未设置或空白则跳过），其余原样
pub fn resolve_template(candidates: &[String], env: &Env) -> Option<PathBuf> {
    candidates.iter().find_map(|t| resolve_one(t, env))
}

/// 解析后的路径存在就换成 `real_path`。环境变量可能指到一层软链
/// （Orca 的 `$CODEX_HOME/skills -> ~/.codex/skills`），不归一的话同一个目录
/// 会既当本体位置又当"整目录软链"的目标。不存在的候选保持原样
fn canonical_if_exists(path: PathBuf) -> PathBuf {
    real_path(&path).unwrap_or(path)
}

fn resolve_one(template: &str, env: &Env) -> Option<PathBuf> {
    substitute_one(template, env).map(canonical_if_exists)
}

fn substitute_one(template: &str, env: &Env) -> Option<PathBuf> {
    if template == "~" {
        return Some(env.home.clone());
    }
    if let Some(rest) = template.strip_prefix("~/") {
        return Some(env.home.join(rest));
    }
    if let Some(rest) = template.strip_prefix('$') {
        let (var, tail) = match rest.split_once('/') {
            Some((v, r)) => (v, Some(r)),
            None => (rest, None),
        };
        let value = env
            .vars
            .get(var)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())?;
        let base = PathBuf::from(value);
        return Some(match tail {
            Some(r) => base.join(r),
            None => base,
        });
    }
    Some(PathBuf::from(template))
}

fn specs() -> Vec<HarnessSpec> {
    serde_json::from_str::<HarnessFile>(HARNESSES_JSON)
        .expect("harnesses.json 内置数据必须合法")
        .harnesses
}

fn resolve(spec: &HarnessSpec, env: &Env) -> (Harness, Option<PathBuf>) {
    let harness = Harness {
        id: spec.id.clone(),
        display_name: spec.display_name.clone(),
        project_dir: spec.project_dir.clone(),
        global_dir: resolve_template(&spec.global_dir, env),
        universal: spec.universal,
        agent_dirs: expand_template_glob(&spec.agent_dirs, env),
        managed_global_dir: spec.managed_global_dir,
        agent_labels: spec.agent_labels.clone(),
    };
    (harness, resolve_template(&spec.detect_dir, env))
}

/// 逐个模板展开单层 `*`，返回存在的目录，按路径排序去重
pub fn expand_template_glob(candidates: &[String], env: &Env) -> Vec<PathBuf> {
    glob_matches(candidates, env)
        .into_iter()
        .map(|m| m.1)
        .collect()
}

/// 展开结果配上通配层匹配到的目录（无通配时就是目录自身），按目录排序
fn glob_matches(candidates: &[String], env: &Env) -> Vec<(PathBuf, PathBuf)> {
    let mut found: BTreeMap<PathBuf, PathBuf> = BTreeMap::new();
    for template in candidates {
        let Some(path) = resolve_one(template, env) else {
            continue;
        };
        for (root, dir) in expand_one_glob(&path) {
            found.entry(dir).or_insert(root);
        }
    }
    found.into_iter().map(|(dir, root)| (root, dir)).collect()
}

/// 只认第一个 `*` 分量：列出该层的目录，拼回剩下的路径，留下确实存在的
fn expand_one_glob(path: &Path) -> Vec<(PathBuf, PathBuf)> {
    let parts: Vec<Component> = path.components().collect();
    let Some(star) = parts.iter().position(|c| c.as_os_str() == "*") else {
        return if path.is_dir() {
            vec![(path.to_path_buf(), path.to_path_buf())]
        } else {
            Vec::new()
        };
    };
    let base: PathBuf = parts[..star].iter().collect();
    let tail: PathBuf = parts[star + 1..].iter().collect();
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let dir = e.path().join(&tail);
            dir.is_dir()
                .then(|| (canonical_if_exists(e.path()), canonical_if_exists(dir)))
        })
        .collect()
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// 位置里的 skill：直接子项中非隐藏的真实目录，按名排序。
/// 软链一律不算——它是指向别处本体的链接，不是这个位置自己的 skill
fn skills_in(dir: &Path) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = BTreeSet::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') && entry_kind(&e.path()) == EntryKind::Dir {
            names.insert(name);
        }
    }
    names
        .into_iter()
        .map(|name| Skill {
            path: dir.join(&name),
            name,
        })
        .collect()
}

/// harness 表里配了 per-agent 目录的条目：id → 模板
fn agent_dir_templates() -> HashMap<String, Vec<String>> {
    specs()
        .into_iter()
        .filter(|s| !s.agent_dirs.is_empty())
        .map(|s| (s.id, s.agent_dirs))
        .collect()
}

/// 标识符必须是 `[A-Za-z_][A-Za-z0-9_]*`，否则不拼进 SQL
fn safe_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 只读打开 harness 自己的数据库，取 agent id → 显示名。任何失败都返回空表
fn agent_label_map(spec: &AgentLabels, env: &Env) -> HashMap<String, String> {
    if !(safe_identifier(&spec.table)
        && safe_identifier(&spec.id_column)
        && safe_identifier(&spec.name_column))
    {
        return HashMap::new();
    }
    let Some(path) = resolve_template(std::slice::from_ref(&spec.path), env) else {
        return HashMap::new();
    };
    // immutable=1：不加锁、不碰 WAL，与运行中的宿主应用互不干扰
    let uri = format!("file:{}?mode=ro&immutable=1", path.display());
    let conn = match rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("打不开 {}：{e}", path.display());
            return HashMap::new();
        }
    };
    let sql = format!(
        "SELECT {}, {} FROM {}",
        spec.id_column, spec.name_column, spec.table
    );
    let mut out = HashMap::new();
    match conn.prepare(&sql).and_then(|mut st| {
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.flatten().collect::<Vec<_>>())
    }) {
        Ok(pairs) => out.extend(pairs),
        Err(e) => eprintln!("读 {} 失败：{e}", spec.table),
    }
    out
}

/// harness 的 per-agent 目录：agent 根当项目，标签为「harness 名 · 助手名」，
/// 助手名取自 harness 自己的数据库，查不到时降级为 agent 目录名。
/// `Harness.agent_dirs` 已经展开，看不出是哪一层匹配的 `*`，
/// 只能回表按模板重新展开一次（同样的模板、同样的 env，结果一致）
fn agent_projects(env: &Env, harnesses: &[Harness]) -> Vec<AgentProject> {
    let templates = agent_dir_templates();
    harnesses
        .iter()
        .filter_map(|h| Some((h, templates.get(&h.id)?)))
        .flat_map(|(h, t)| {
            // 每个 harness 只查一次数据库
            let names = h
                .agent_labels
                .as_ref()
                .map(|spec| agent_label_map(spec, env))
                .unwrap_or_default();
            glob_matches(t, env)
                .into_iter()
                .map(move |(root, dir)| {
                    let key = dir_name(&root);
                    let name = names.get(&key).cloned().unwrap_or(key);
                    AgentProject {
                        harness_id: h.id.clone(),
                        display_name: h.display_name.clone(),
                        label: format!("{} · {}", h.display_name, name),
                        root,
                        dir,
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// 一个 agent 项目：`root` 是通配层匹配到的 agent 目录，`dir` 是它的 skill 目录
struct AgentProject {
    harness_id: String,
    /// harness 名，用作目标列名
    display_name: String,
    /// 「harness 名 · agent 目录名」，用作本体位置名与域名
    label: String,
    root: PathBuf,
    dir: PathBuf,
}

/// 所有本体位置：通用仓库、harness 全局目录、harness 的 per-agent 项目、项目通用仓库、手动添加。
/// 一个 skill 都没有的位置不产出；按 `real_path` 去重，先到先得
pub fn sources(
    env: &Env,
    harnesses: &[Harness],
    projects: &[PathBuf],
    manual: &[PathBuf],
) -> Vec<Source> {
    let mut out: Vec<Source> = Vec::new();
    let mut keys: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf, kind: SourceKind, label: String| {
        let skills = skills_in(&path);
        if skills.is_empty() {
            return;
        }
        let key = real_path(&path).unwrap_or_else(|| normalize(&path));
        if keys.contains(&key) {
            return;
        }
        keys.push(key);
        out.push(Source {
            id: normalize(&path).to_string_lossy().into_owned(),
            path,
            kind,
            label,
            skills,
        });
    };

    push(
        env.home.join(".agents").join("skills"),
        SourceKind::Universal,
        "通用仓库".to_string(),
    );
    for h in harnesses {
        if let Some(dir) = h.global_dir.clone() {
            push(
                dir,
                SourceKind::HarnessGlobal {
                    harness_id: h.id.clone(),
                },
                h.display_name.clone(),
            );
        }
    }
    for a in agent_projects(env, harnesses) {
        push(
            a.dir,
            SourceKind::ProjectStore {
                project: a.root,
                project_label: Some(a.label.clone()),
            },
            a.label,
        );
    }
    for p in projects {
        push(
            p.join(".agents").join("skills"),
            SourceKind::ProjectStore {
                project: p.clone(),
                project_label: None,
            },
            format!("{} · 通用仓库", dir_name(p)),
        );
    }
    for p in manual {
        push(p.clone(), SourceKind::Manual, dir_name(p));
    }

    out
}

/// 目标目录里指向"任何已知本体位置之外"的软链，按真实父目录合成为外部本体位置。
/// 整目录链接的目标读进去就是本体位置，跳过。
/// 同一父目录下同名不同真实路径的取首个
pub fn external_sources(env: &Env, targets: &[Target], known: &[Source]) -> Vec<Source> {
    let inside: Vec<PathBuf> = known.iter().filter_map(|s| real_path(&s.path)).collect();
    let mut groups: BTreeMap<PathBuf, BTreeMap<String, PathBuf>> = BTreeMap::new();
    for dir in targets
        .iter()
        .filter(|t| t.linked_whole_to.is_none())
        .flat_map(|t| t.dirs.iter())
    {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        for name in names {
            let path = dir.join(&name);
            if !matches!(entry_kind(&path), EntryKind::Symlink(_)) {
                continue;
            }
            // 坏链解析不出真实路径，指向文件的也不是 skill
            let Some(real) = real_path(&path).filter(|r| r.is_dir()) else {
                continue;
            };
            if inside.iter().any(|k| real.starts_with(k)) {
                continue;
            }
            let Some(parent) = real.parent().map(Path::to_path_buf) else {
                continue;
            };
            groups
                .entry(parent)
                .or_default()
                .entry(name)
                .or_insert(real);
        }
    }
    groups
        .into_iter()
        .map(|(path, skills)| Source {
            id: normalize(&path).to_string_lossy().into_owned(),
            label: abbreviate(&path, &env.home),
            kind: SourceKind::External,
            skills: skills
                .into_iter()
                .map(|(name, path)| Skill { name, path })
                .collect(),
            path,
        })
        .collect()
}

/// 主目录下的路径显示成 `~/…`，其余原样
fn abbreviate(path: &Path, home: &Path) -> String {
    let home = real_path(home).unwrap_or_else(|| home.to_path_buf());
    match path.strip_prefix(&home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// 所有可写目标：每个启用 harness 各自一列——全局目录、per-agent 目录、每个项目的项目目录。
/// 列名就是 harness 名；多个 harness 共用同一个目录时各自成列，不合并。
/// 目录不存在（`is_dir()` 跟随软链，整目录软链也算存在）则不成列；
/// 目标目录整个是指向某本体位置的软链时填 `linked_whole_to`
pub fn targets(
    env: &Env,
    harnesses: &[Harness],
    projects: &[PathBuf],
    sources: &[Source],
) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    // is_dir 跟随软链：整目录软链也算目标。一个目录都不存在的列不产出
    let mut push = |id: String, label: String, dirs: Vec<PathBuf>, scope: TargetScope| {
        let dirs: Vec<PathBuf> = dirs.into_iter().filter(|d| d.is_dir()).collect();
        if dirs.is_empty() {
            return;
        }
        out.push(Target {
            id,
            label,
            dirs,
            scope,
            linked_whole_to: None,
        });
    };

    for h in harnesses {
        // 托管目录由 harness 自己装配，不给可写列
        if h.managed_global_dir {
            continue;
        }
        if let Some(dir) = h.global_dir.clone() {
            push(
                h.id.clone(),
                h.display_name.clone(),
                vec![dir],
                TargetScope::Global {
                    harness_id: h.id.clone(),
                },
            );
        }
    }
    let agents = agent_projects(env, harnesses);
    for a in &agents {
        let key = normalize(&a.root).to_string_lossy().into_owned();
        push(
            format!("project:{key}::{}", a.harness_id),
            a.display_name.clone(),
            vec![a.dir.clone()],
            TargetScope::Project {
                project: a.root.clone(),
                harness_id: a.harness_id.clone(),
                project_label: Some(a.label.clone()),
            },
        );
    }
    // 全局域里每个 harness 一列，扇出到它展开出的全部 agent 目录。
    // 这里与上面的 global_dir 列共用 `h.id` 作 target id，两者不能同时出现，
    // 由 `no_harness_combines_a_writable_global_dir_with_agent_dirs` 锁住
    for h in harnesses {
        let dirs: Vec<PathBuf> = agents
            .iter()
            .filter(|a| a.harness_id == h.id)
            .map(|a| a.dir.clone())
            .collect();
        if dirs.is_empty() {
            continue;
        }
        push(
            h.id.clone(),
            h.display_name.clone(),
            dirs,
            TargetScope::Global {
                harness_id: h.id.clone(),
            },
        );
    }
    for p in projects {
        let key = normalize(p).to_string_lossy().into_owned();
        for h in harnesses {
            let Some(dir) = h.project_dir.as_ref().map(|d| p.join(d)) else {
                continue;
            };
            push(
                format!("project:{key}::{}", h.id),
                h.display_name.clone(),
                vec![dir],
                TargetScope::Project {
                    project: p.clone(),
                    harness_id: h.id.clone(),
                    project_label: None,
                },
            );
        }
    }

    for t in &mut out {
        // 多目录列由 harness 自己创建各目录，不会是整目录软链
        if t.dirs.len() != 1 {
            continue;
        }
        let dir = t.main_dir().to_path_buf();
        if !matches!(entry_kind(&dir), EntryKind::Symlink(_)) {
            continue;
        }
        let Some(real) = real_path(&dir) else {
            continue;
        };
        t.linked_whole_to = sources
            .iter()
            .find(|s| real_path(&s.path).is_some_and(|r| r == real))
            .map(|s| s.id.clone());
    }
    out
}

/// 全部 harness，路径已按当前环境解析
pub fn all_harnesses(env: &Env) -> Vec<Harness> {
    specs().iter().map(|s| resolve(s, env).0).collect()
}

/// 探测目录（detect_dir，缺省 global_dir）存在，且不是只装着通往 skills 的空壳
pub fn installed(env: &Env) -> Vec<Harness> {
    specs()
        .iter()
        .filter_map(|s| {
            let (h, detect) = resolve(s, env);
            let probe = detect.or_else(|| h.global_dir.clone())?;
            looks_installed(&probe, h.global_dir.as_deref()).then_some(h)
        })
        .collect()
}

/// 去掉被用户关掉的 harness，顺序不变
pub fn enabled(installed: Vec<Harness>, settings: &Settings) -> Vec<Harness> {
    installed
        .into_iter()
        .filter(|h| !settings.disabled_harnesses.contains(&h.id))
        .collect()
}

/// 探测目录里至少要有一个条目不在通往 `global_dir` 的路径上。
/// `npx skills add --agent '*'` 会给未安装的工具也建出 `~/.xxx/skills`，
/// 这类只含 skills 路径的目录不算已安装。没有 global_dir 时存在即可
fn looks_installed(probe: &Path, global_dir: Option<&Path>) -> bool {
    let Some(global) = global_dir else {
        return probe.exists();
    };
    let Ok(entries) = std::fs::read_dir(probe) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| !global.starts_with(e.path().as_path()))
}

/// 项目目录里是否有任一 harness 的项目级 skill 目录。
/// 只认以 `.` 开头的 project_dir：裸 `skills`（OpenClaw）太常见，不足以判定是项目
pub fn has_project_skill_dir(project: &Path, harnesses: &[Harness]) -> bool {
    project.join(".agents").join("skills").is_dir()
        || harnesses
            .iter()
            .filter_map(|h| h.project_dir.as_deref())
            .filter(|d| d.starts_with('.'))
            .any(|d| project.join(d).is_dir())
}

/// Claude Code 记录的项目 ∪ 手动添加；只保留仍存在的，排除主目录与根目录。
/// 记录的项目还要求含 skill 目录（去噪）；手动添加是用户明示，即便还没建目录也保留
pub fn project_candidates(env: &Env, manual: &[PathBuf], harnesses: &[Harness]) -> Vec<PathBuf> {
    let manual: BTreeSet<PathBuf> = manual.iter().cloned().collect();
    let mut set = manual.clone();
    set.extend(claude_recorded_projects(&env.home));
    set.into_iter()
        .filter(|p| p != &env.home && p.parent().is_some() && p.is_dir())
        .filter(|p| manual.contains(p) || !is_hidden_home_dir(&env.home, p))
        .filter(|p| manual.contains(p) || has_project_skill_dir(p, harnesses))
        .collect()
}

/// 主目录下的隐藏目录（如 ~/.claude、~/.agents）是工具配置，不是项目
fn is_hidden_home_dir(home: &Path, path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.') && path == home.join(n))
}

/// ~/.claude.json 的 projects 键。格式非公开约定，任何解析失败都视为空
fn claude_recorded_projects(home: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(home.join(".claude.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .get("projects")
        .and_then(|p| p.as_object())
        .map(|o| o.keys().map(PathBuf::from).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use std::collections::HashMap;

    fn env(home: &Path, vars: &[(&str, &str)]) -> Env {
        Env {
            home: home.to_path_buf(),
            vars: vars
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<HashMap<_, _>>(),
        }
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn resolve_template_handles_tilde_vars_and_fallback_order() {
        let e = env(
            Path::new("/home/u"),
            &[("CODEX_HOME", "/opt/codex"), ("EMPTY", "  ")],
        );
        assert_eq!(
            resolve_template(&s(&["~/.claude/skills"]), &e),
            Some(PathBuf::from("/home/u/.claude/skills"))
        );
        assert_eq!(
            resolve_template(&s(&["$CODEX_HOME/skills", "~/.codex/skills"]), &e),
            Some(PathBuf::from("/opt/codex/skills"))
        );
        assert_eq!(
            resolve_template(&s(&["$MISSING/x", "$EMPTY/x", "~/.config/x"]), &e),
            Some(PathBuf::from("/home/u/.config/x"))
        );
        assert_eq!(
            resolve_template(&s(&["$CODEX_HOME"]), &e),
            Some(PathBuf::from("/opt/codex"))
        );
        assert_eq!(resolve_template(&s(&["$MISSING"]), &e), None);
    }

    #[test]
    fn table_loads_and_claude_config_dir_overrides() {
        let e = env(Path::new("/home/u"), &[]);
        let all = all_harnesses(&e);
        assert!(all.len() >= 41);
        let claude = all.iter().find(|h| h.id == "claude-code").unwrap();
        assert_eq!(
            claude.global_dir,
            Some(PathBuf::from("/home/u/.claude/skills"))
        );
        assert_eq!(claude.project_dir.as_deref(), Some(".claude/skills"));
        assert!(!claude.universal);
        assert!(all.iter().find(|h| h.id == "codex").unwrap().universal);
        let e2 = env(
            Path::new("/home/u"),
            &[("CLAUDE_CONFIG_DIR", "/cfg/claude")],
        );
        let claude2 = all_harnesses(&e2)
            .into_iter()
            .find(|h| h.id == "claude-code")
            .unwrap();
        assert_eq!(
            claude2.global_dir,
            Some(PathBuf::from("/cfg/claude/skills"))
        );
    }

    #[test]
    fn weiboap_entry_resolves_on_macos() {
        let e = env(Path::new("/home/u"), &[]);
        let h = all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "weiboap")
            .expect("harness 表里应有 weiboap");
        assert_eq!(
            h.global_dir,
            Some(Path::new("/home/u").join(
                "Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom"
            ))
        );
        assert_eq!(h.project_dir, None);
    }

    #[test]
    fn enabled_filters_disabled_ids_keeping_order() {
        let e = env(Path::new("/home/u"), &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        let installed = vec![pick("claude-code"), pick("codex"), pick("cursor")];
        let settings = Settings {
            disabled_harnesses: vec!["codex".into()],
            ..Default::default()
        };
        let ids: Vec<String> = enabled(installed, &settings)
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(ids, vec!["claude-code".to_string(), "cursor".to_string()]);
    }

    #[test]
    fn installed_filters_by_detect_dir() {
        let t = TempTree::new();
        let home = t.root();
        let claude = t.dir(".claude");
        t.file(&claude, "settings.json");
        let codex = t.dir(".codex/skills");
        t.file(codex.parent().unwrap(), "config.toml");
        let e = env(&home, &[]);
        let ids: Vec<String> = installed(&e).into_iter().map(|h| h.id).collect();
        assert!(ids.contains(&"claude-code".to_string()));
        assert!(ids.contains(&"codex".to_string()));
        assert!(!ids.contains(&"cursor".to_string()));
    }

    #[test]
    fn installed_ignores_config_dirs_that_only_hold_the_skills_path() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".kiro/skills"); // 只有 skills，npx 留下的空壳 → 未安装
        t.dir(".pi/agent/skills"); // 只有通往 skills 的路径 → 未安装
        t.dir(".cursor/skills");
        t.file(&home.join(".cursor"), "hooks.json"); // 有真实配置 → 已安装
        t.dir(".codex/skills");
        t.file(&home.join(".codex"), "config.toml");
        t.dir(".claude"); // 空目录（用户刚装、还没 skills）→ 未安装
        let e = env(&home, &[]);
        let ids: Vec<String> = installed(&e).into_iter().map(|h| h.id).collect();
        assert!(ids.contains(&"cursor".to_string()));
        assert!(ids.contains(&"codex".to_string()));
        assert!(!ids.contains(&"kiro-cli".to_string()));
        assert!(!ids.contains(&"pi".to_string()));
        assert!(!ids.contains(&"claude-code".to_string()));
    }

    #[test]
    fn project_candidates_merge_claude_json_and_manual_then_filter() {
        let t = TempTree::new();
        let home = t.root();
        let good = t.dir("Project/good");
        t.dir("Project/good/.claude/skills");
        let uni = t.dir("Project/uni");
        t.dir("Project/uni/.agents/skills");
        let bare = t.dir("Project/bare");
        let manual = t.dir("Elsewhere/m");
        t.dir("Elsewhere/m/.codex/skills");
        t.dir(".claude/skills");
        let json = format!(
            "{{\"projects\":{{\"{}\":{{}},\"{}\":{{}},\"{}\":{{}},\"{}\":{{}},\"{}\":{{}}}}}}",
            good.display(),
            uni.display(),
            bare.display(),
            home.display(),
            home.join("nope").display()
        );
        std::fs::write(home.join(".claude.json"), json).unwrap();
        let e = env(&home, &[]);
        let harnesses = all_harnesses(&e);
        let got = project_candidates(&e, std::slice::from_ref(&manual), &harnesses);
        let mut want = vec![good, uni, manual];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn bare_skills_dir_and_hidden_home_dirs_are_not_projects() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".claude/skills"); // ~/.claude 有 skills/，不是项目
        let plain = t.dir("Project/plain");
        t.dir("Project/plain/skills"); // 只有裸 skills/ → 不是项目
        let real = t.dir("Project/real");
        t.dir("Project/real/.agents/skills");
        let json = format!(
            "{{\"projects\":{{\"{}\":{{}},\"{}\":{{}},\"{}\":{{}}}}}}",
            home.join(".claude").display(),
            plain.display(),
            real.display()
        );
        std::fs::write(home.join(".claude.json"), json).unwrap();
        let e = env(&home, &[]);
        assert_eq!(project_candidates(&e, &[], &all_harnesses(&e)), vec![real]);
    }

    #[test]
    fn expand_template_glob_lists_dirs_at_the_star_level() {
        let t = TempTree::new();
        let home = t.root();
        let agents = t.dir("Data/agents");
        t.dir("Data/agents/agent_1/.internal-plugins/skills");
        t.dir("Data/agents/agent_2/.internal-plugins/skills");
        t.dir("Data/agents/agent_3"); // 缺后半段 → 忽略
        t.file(&agents, "index.json"); // 非目录 → 忽略
        let e = env(&home, &[]);
        assert_eq!(
            expand_template_glob(&s(&["~/Data/agents/*/.internal-plugins/skills"]), &e),
            vec![
                home.join("Data/agents/agent_1/.internal-plugins/skills"),
                home.join("Data/agents/agent_2/.internal-plugins/skills"),
            ]
        );
        // 无通配的模板：目录存在才返回
        assert_eq!(
            expand_template_glob(&s(&["~/Data/agents", "~/Data/nope"]), &e),
            vec![agents]
        );
        // 通配层匹配到的目录就是项目根
        assert_eq!(
            glob_matches(&s(&["~/Data/agents/*/.internal-plugins/skills"]), &e),
            vec![
                (
                    home.join("Data/agents/agent_1"),
                    home.join("Data/agents/agent_1/.internal-plugins/skills"),
                ),
                (
                    home.join("Data/agents/agent_2"),
                    home.join("Data/agents/agent_2/.internal-plugins/skills"),
                ),
            ]
        );
    }

    #[test]
    fn agent_dirs_become_one_project_target_each() {
        let t = TempTree::new();
        let home = t.root();
        let weiboap = "Library/Application Support/WeiboAP";
        let root1 = t.dir(&format!("{weiboap}/Data/agents/agent_1"));
        let dir1 = t.dir(&format!(
            "{weiboap}/Data/agents/agent_1/.internal-plugins/skills"
        ));
        let root2 = t.dir(&format!("{weiboap}/Data/agents/agent_2"));
        let dir2 = t.dir(&format!(
            "{weiboap}/Data/agents/agent_2/.internal-plugins/skills"
        ));
        // agent 根下的 .claude/skills 不该被当成普通项目目标
        t.dir(&format!("{weiboap}/Data/agents/agent_1/.claude/skills"));

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        let hs = vec![pick("claude-code"), pick("weiboap")];
        assert!(project_candidates(&e, &[], &hs).is_empty());

        let got: Vec<(String, String, Vec<PathBuf>, TargetScope)> = targets(&e, &hs, &[], &[])
            .into_iter()
            .map(|x| (x.id, x.label, x.dirs, x.scope))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    format!("project:{}::weiboap", root1.display()),
                    "WeiboAP".to_string(),
                    vec![dir1.clone()],
                    TargetScope::Project {
                        project: root1,
                        harness_id: "weiboap".into(),
                        project_label: Some("WeiboAP · agent_1".to_string()),
                    },
                ),
                (
                    format!("project:{}::weiboap", root2.display()),
                    "WeiboAP".to_string(),
                    vec![dir2.clone()],
                    TargetScope::Project {
                        project: root2,
                        harness_id: "weiboap".into(),
                        project_label: Some("WeiboAP · agent_2".to_string()),
                    },
                ),
                // 全局域的扇出列：两个助手目录合成一列
                (
                    "weiboap".to_string(),
                    "WeiboAP".to_string(),
                    vec![dir1, dir2],
                    TargetScope::Global {
                        harness_id: "weiboap".into()
                    },
                ),
            ]
        );
    }

    #[test]
    fn managed_global_dir_is_a_source_but_never_a_target() {
        let t = TempTree::new();
        let home = t.root();
        // weiboap 的托管目录：有真实 skill
        let custom =
            t.dir("Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom");
        t.dir("Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom/official-a");
        let e = env(&home, &[]);
        let hs = vec![all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "weiboap")
            .unwrap()];
        let srcs = sources(&e, &hs, &[], &[]);
        assert!(
            srcs.iter().any(|s| s.path == custom),
            "托管目录仍是本体位置"
        );
        let tgts = targets(&e, &hs, &[], &srcs);
        assert!(
            tgts.iter().all(|x| !x.dirs.contains(&custom)),
            "托管目录不得成为目标"
        );
    }

    #[test]
    fn agent_dirs_fan_out_into_one_global_column_and_stay_per_agent_domains() {
        let t = TempTree::new();
        let home = t.root();
        let a1 = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_a/.internal-plugins/skills",
        );
        let a2 = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_b/.internal-plugins/skills",
        );
        let e = env(&home, &[]);
        let hs = vec![all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "weiboap")
            .unwrap()];
        let tgts = targets(&e, &hs, &[], &sources(&e, &hs, &[], &[]));
        let global = tgts.iter().find(|x| x.id == "weiboap").expect("全局扇出列");
        assert_eq!(global.label, "WeiboAP");
        assert_eq!(global.dirs, vec![a1.clone(), a2.clone()]);
        assert!(matches!(global.scope, TargetScope::Global { .. }));
        // 每个助手仍有自己的域
        let per_agent: Vec<&Target> = tgts
            .iter()
            .filter(|x| x.id.starts_with("project:"))
            .collect();
        assert_eq!(per_agent.len(), 2);
        assert!(per_agent.iter().all(|x| x.dirs.len() == 1));
    }

    /// AC12：能读到 agents.db 时域名与本体位置名用助手名
    #[test]
    fn agent_names_come_from_the_harness_own_database() {
        let t = TempTree::new();
        let home = t.root();
        let wap = t.dir("Library/Application Support/WeiboAP");
        let dir = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1776/.internal-plugins/skills",
        );
        t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1776/.internal-plugins/skills/x",
        );
        // 另一个助手不在库里 → 降级为目录名
        t.dir("Library/Application Support/WeiboAP/Data/agents/agent_zzz/.internal-plugins/skills");
        let db = rusqlite::Connection::open(wap.join("agents.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
             INSERT INTO agents VALUES ('agent_1776', '办公助手');",
        )
        .unwrap();
        drop(db);

        let e = env(&home, &[]);
        let hs = vec![all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "weiboap")
            .unwrap()];
        let srcs = sources(&e, &hs, &[], &[]);
        assert_eq!(srcs.len(), 1);
        assert_eq!(srcs[0].path, dir);
        assert_eq!(srcs[0].label, "WeiboAP · 办公助手");
        let labels: Vec<Option<String>> = targets(&e, &hs, &[], &srcs)
            .into_iter()
            .filter_map(|x| match x.scope {
                TargetScope::Project { project_label, .. } => Some(project_label),
                TargetScope::Global { .. } => None,
            })
            .collect();
        assert_eq!(
            labels,
            vec![
                Some("WeiboAP · 办公助手".to_string()),
                Some("WeiboAP · agent_zzz".to_string()),
            ]
        );
    }

    /// AC13：库不存在 / 表名不符 / 文件损坏都降级为目录名，不报错
    #[test]
    fn missing_or_broken_agent_database_falls_back_to_the_directory_name() {
        let t = TempTree::new();
        let home = t.root();
        let wap = t.dir("Library/Application Support/WeiboAP");
        t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills");
        t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills/x");
        let e = env(&home, &[]);
        let hs = vec![all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "weiboap")
            .unwrap()];
        let label = |e: &Env| sources(e, &hs, &[], &[])[0].label.clone();
        // 库不存在
        assert_eq!(label(&e), "WeiboAP · agent_1");
        // 文件存在但不是 SQLite
        std::fs::write(wap.join("agents.db"), b"not a database").unwrap();
        assert_eq!(label(&e), "WeiboAP · agent_1");
        // 是库但没有 agents 表
        std::fs::remove_file(wap.join("agents.db")).unwrap();
        let db = rusqlite::Connection::open(wap.join("agents.db")).unwrap();
        db.execute_batch("CREATE TABLE other (id TEXT);").unwrap();
        drop(db);
        assert_eq!(label(&e), "WeiboAP · agent_1");
    }

    #[test]
    fn unsafe_identifiers_never_reach_the_sql_string() {
        assert!(safe_identifier("agents") && safe_identifier("_id2"));
        assert!(!safe_identifier("") && !safe_identifier("2id"));
        assert!(!safe_identifier("agents; DROP TABLE x") && !safe_identifier("a-b"));
        let t = TempTree::new();
        let e = env(&t.root(), &[]);
        let spec = AgentLabels {
            path: "~/agents.db".into(),
            table: "agents; DROP TABLE agents".into(),
            id_column: "id".into(),
            name_column: "name".into(),
        };
        assert!(agent_label_map(&spec, &e).is_empty());
    }

    #[test]
    fn no_agent_dirs_means_no_global_fan_out_column() {
        let t = TempTree::new();
        let home = t.root();
        t.dir("Library/Application Support/WeiboAP"); // 只有 detect_dir
        let e = env(&home, &[]);
        let hs = vec![all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "weiboap")
            .unwrap()];
        let tgts = targets(&e, &hs, &[], &[]);
        assert!(tgts.iter().all(|x| x.id != "weiboap"));
    }

    /// `targets()` 里非托管 `global_dir` 列与 agent 扇出列都拿 `h.id` 当 target id，
    /// 一个 harness 两者兼有就会产出两个同 id 的列，`find(|t| t.id == ..)` 会取错目录。
    /// 锁住数据表这条不变式，比按目录造树断言更稳、也不会随 harness 增减过时
    #[test]
    fn no_harness_combines_a_writable_global_dir_with_agent_dirs() {
        let file: HarnessFile =
            serde_json::from_str(HARNESSES_JSON).expect("内置 harness 表应当可解析");
        for spec in &file.harnesses {
            assert!(
                spec.managed_global_dir || spec.global_dir.is_empty() || spec.agent_dirs.is_empty(),
                "harness {} 同时配了非托管 global_dir 与 agent_dirs，\
                 targets() 会产出两个 id 都是 {} 的全局列",
                spec.id,
                spec.id
            );
        }
    }

    #[test]
    fn sources_cover_every_kind_and_skip_empty_locations() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills/uni-skill");
        t.dir(".claude/skills/claude-skill");
        t.dir(".codex/skills"); // 没有 skill → 不产出
        let agent_root = t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1");
        let agent_dir = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills",
        );
        t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills/agent-skill");
        let project = t.dir("Project/app");
        t.dir("Project/app/.agents/skills/proj-skill");
        let manual = t.dir("Manual/box");
        t.dir("Manual/box/manual-skill");
        t.dir("Manual/box/.hidden"); // 隐藏目录不是 skill
        t.file(&manual, "README.md"); // 文件不是 skill

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        let hs = vec![pick("claude-code"), pick("codex"), pick("weiboap")];
        let got = sources(
            &e,
            &hs,
            std::slice::from_ref(&project),
            std::slice::from_ref(&manual),
        );

        let names = |s: &Source| s.skills.iter().map(|k| k.name.clone()).collect::<Vec<_>>();
        // 每个 skill 的 path 就是 位置/名字
        for s in &got {
            for k in &s.skills {
                assert_eq!(k.path, s.path.join(&k.name));
            }
        }
        let got: Vec<(String, PathBuf, SourceKind, String, Vec<String>)> = got
            .iter()
            .map(|s| {
                (
                    s.id.clone(),
                    s.path.clone(),
                    s.kind.clone(),
                    s.label.clone(),
                    names(s),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    home.join(".agents/skills").display().to_string(),
                    home.join(".agents/skills"),
                    SourceKind::Universal,
                    "通用仓库".to_string(),
                    vec!["uni-skill".to_string()],
                ),
                (
                    home.join(".claude/skills").display().to_string(),
                    home.join(".claude/skills"),
                    SourceKind::HarnessGlobal {
                        harness_id: "claude-code".into()
                    },
                    "Claude Code".to_string(),
                    vec!["claude-skill".to_string()],
                ),
                (
                    agent_dir.display().to_string(),
                    agent_dir.clone(),
                    SourceKind::ProjectStore {
                        project: agent_root.clone(),
                        project_label: Some("WeiboAP · agent_1".to_string())
                    },
                    "WeiboAP · agent_1".to_string(),
                    vec!["agent-skill".to_string()],
                ),
                (
                    project.join(".agents/skills").display().to_string(),
                    project.join(".agents/skills"),
                    SourceKind::ProjectStore {
                        project: project.clone(),
                        project_label: None
                    },
                    "app · 通用仓库".to_string(),
                    vec!["proj-skill".to_string()],
                ),
                (
                    manual.display().to_string(),
                    manual.clone(),
                    SourceKind::Manual,
                    "box".to_string(),
                    vec!["manual-skill".to_string()],
                ),
            ]
        );
    }

    #[test]
    fn sources_count_only_real_directories_as_skills() {
        let t = TempTree::new();
        let home = t.root();
        let outside = t.dir("Applications/ego-skills/ego-browser");
        let store = t.dir(".agents/skills");
        t.dir(".agents/skills/real-skill");
        t.link(&store.join("ego-browser"), &outside); // 软链不是自己的 skill
        t.link(&store.join("rotten"), &home.join("gone"));
        // harness 全局目录满是软链（消费目录），一个真实目录都没有 → 不是本体位置
        t.dir(".claude/skills");
        t.link(&home.join(".claude/skills/ego-browser"), &outside);
        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let hs = vec![all.iter().find(|h| h.id == "claude-code").unwrap().clone()];
        let got = sources(&e, &hs, &[], &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, SourceKind::Universal);
        assert_eq!(
            got[0].skills,
            vec![Skill {
                name: "real-skill".into(),
                path: store.join("real-skill"),
            }]
        );
    }

    #[test]
    fn store_sources_never_count_links_as_their_own_skills() {
        let t = TempTree::new();
        let home = t.root();
        let agent_dir = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills",
        );
        let agent_skill = t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills/agent-skill");
        let outside = t.dir("Applications/ego-skills/ego-browser");
        let project = t.dir("Project/app");
        let store = t.dir("Project/app/.agents/skills");
        t.dir("Project/app/.agents/skills/own");
        t.link(&store.join("from-agent"), &agent_skill); // 指向别的本体位置
        t.link(&store.join("external"), &outside); // 指向外部目录

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let hs = vec![all.iter().find(|h| h.id == "weiboap").unwrap().clone()];
        let got = sources(&e, &hs, std::slice::from_ref(&project), &[]);

        let names = |p: &Path| {
            got.iter()
                .find(|s| s.path == p)
                .unwrap_or_else(|| panic!("没发现本体位置 {}", p.display()))
                .skills
                .iter()
                .map(|k| k.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&agent_dir), vec!["agent-skill".to_string()]);
        // 两条软链都不算，只剩真实目录 own
        assert_eq!(names(&store), vec!["own".to_string()]);
    }

    #[test]
    fn external_sources_group_outside_links_by_their_real_parent() {
        let t = TempTree::new();
        let home = t.dir("h");
        // 不在 home 下 → label 用完整路径；两条链接同父目录 → 合并成一处
        let ego = t.dir("opt/ego-skills");
        let browser = t.dir("opt/ego-skills/ego-browser");
        let writer = t.dir("opt/ego-skills/ego-writer");
        // home 下 → label 用 ~ 缩写
        let pack = t.dir("h/Applications/pack");
        let far = t.dir("h/Applications/pack/far-skill");
        let store = t.dir("h/.agents/skills");
        let own = t.dir("h/.agents/skills/own");

        let claude = t.dir("h/.claude/skills");
        t.link(&claude.join("ego-browser"), &browser);
        t.link(&claude.join("ego-writer"), &writer);
        t.link(&claude.join("far-skill"), &far);
        t.link(&claude.join("own"), &own); // 指向已知本体位置 → 不合成
        t.link(&claude.join("rotten"), &home.join("gone")); // 坏链 → 不合成
        t.file(&claude, "notes.md"); // 真实文件 → 不合成

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let hs = vec![all.iter().find(|h| h.id == "claude-code").unwrap().clone()];
        let known = sources(&e, &hs, &[], &[]);
        assert_eq!(known.len(), 1);
        assert_eq!(known[0].path, store);
        let tgts = targets(&e, &hs, &[], &known);
        let got = external_sources(&e, &tgts, &known);

        assert_eq!(
            got,
            vec![
                Source {
                    id: pack.display().to_string(),
                    path: pack.clone(),
                    kind: SourceKind::External,
                    label: "~/Applications/pack".to_string(),
                    skills: vec![Skill {
                        name: "far-skill".into(),
                        path: far,
                    }],
                },
                Source {
                    id: ego.display().to_string(),
                    path: ego.clone(),
                    kind: SourceKind::External,
                    label: ego.display().to_string(),
                    skills: vec![
                        Skill {
                            name: "ego-browser".into(),
                            path: browser,
                        },
                        Skill {
                            name: "ego-writer".into(),
                            path: writer,
                        },
                    ],
                },
            ]
        );
    }

    #[test]
    fn external_sources_skip_whole_linked_targets() {
        let t = TempTree::new();
        let home = t.dir("h");
        let ego = t.dir("opt/ego-skills");
        t.dir("opt/ego-skills/ego-browser");
        let outside = t.dir("opt/other/far-skill");
        t.link(&ego.join("far-skill"), &outside); // ego 里还链着更外面的目录
                                                  // 项目的 .claude/skills 整个是指向 ego 的软链：读进去就是本体位置
        let proj = t.dir("h/proj");
        t.dir("h/proj/.claude");
        t.link(&proj.join(".claude/skills"), &ego);

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let hs = vec![all.iter().find(|h| h.id == "claude-code").unwrap().clone()];
        let known = sources(
            &e,
            &hs,
            std::slice::from_ref(&proj),
            std::slice::from_ref(&ego),
        );
        let tgts = targets(&e, &hs, std::slice::from_ref(&proj), &known);
        assert_eq!(tgts.len(), 1);
        assert!(tgts[0].linked_whole_to.is_some());
        // 整目录链接的目标不扫，far-skill 不会被合成
        assert!(external_sources(&e, &tgts, &known).is_empty());
        assert_eq!(known[0].path, ego);
    }

    #[test]
    fn sources_dedupe_by_real_path_keeping_the_first() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills/uni-skill");
        let alias = t.root().join("alias");
        t.link(&alias, &home.join(".agents/skills"));
        let e = env(&home, &[]);
        let got = sources(&e, &[], &[], &[alias]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, SourceKind::Universal);
    }

    #[test]
    fn targets_give_every_enabled_harness_its_own_column() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills/uni-skill"); // cline 的 global_dir，成一列 Cline
        t.dir(".claude/skills");
        t.dir(".cursor"); // 只有配置目录，没有 skills → 不成列
        let project = t.dir("Project/app");
        t.dir("Project/app/.claude/skills");
        t.dir("Project/app/.agents/skills");
        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        // cline 的 global_dir 就是 ~/.agents/skills；codex、cursor、cline 项目级都读 .agents/skills
        let hs = vec![
            pick("claude-code"),
            pick("codex"),
            pick("cursor"),
            pick("cline"),
        ];
        let got = targets(&e, &hs, std::slice::from_ref(&project), &[]);
        let key = project.display();
        let got: Vec<(String, String, Vec<PathBuf>, TargetScope)> = got
            .into_iter()
            .map(|x| (x.id, x.label, x.dirs, x.scope))
            .collect();
        let proj = |harness_id: &str| TargetScope::Project {
            project: project.clone(),
            harness_id: harness_id.into(),
            project_label: None,
        };
        assert_eq!(
            got,
            vec![
                (
                    "claude-code".to_string(),
                    "Claude Code".to_string(),
                    vec![home.join(".claude/skills")],
                    TargetScope::Global {
                        harness_id: "claude-code".into()
                    },
                ),
                (
                    "cline".to_string(),
                    "Cline".to_string(),
                    vec![home.join(".agents/skills")],
                    TargetScope::Global {
                        harness_id: "cline".into()
                    },
                ),
                (
                    format!("project:{key}::claude-code"),
                    "Claude Code".to_string(),
                    vec![project.join(".claude/skills")],
                    proj("claude-code"),
                ),
                (
                    format!("project:{key}::codex"),
                    "Codex".to_string(),
                    vec![project.join(".agents/skills")],
                    proj("codex"),
                ),
                (
                    format!("project:{key}::cursor"),
                    "Cursor".to_string(),
                    vec![project.join(".agents/skills")],
                    proj("cursor"),
                ),
                (
                    format!("project:{key}::cline"),
                    "Cline".to_string(),
                    vec![project.join(".agents/skills")],
                    proj("cline"),
                ),
            ]
        );
    }

    #[test]
    fn target_that_is_a_whole_dir_symlink_points_back_at_the_source() {
        let t = TempTree::new();
        let home = t.root();
        let store = t.dir("Store/skills");
        t.dir("Store/skills/a-skill");
        let project = t.dir("Project/app");
        t.dir("Project/app/.claude"); // .claude/skills 整个是软链
        t.link(&project.join(".claude/skills"), &store);
        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let hs = vec![
            all.iter().find(|h| h.id == "claude-code").unwrap().clone(),
            all.iter().find(|h| h.id == "codex").unwrap().clone(),
        ];
        let srcs = sources(&e, &hs, &[], std::slice::from_ref(&store));
        let got = targets(&e, &hs, std::slice::from_ref(&project), &srcs);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
        // 普通目录目标不带整目录链接标记
        t.dir("Project/app/.agents/skills");
        let got = targets(&e, &hs, &[project], &srcs);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
        assert!(got[1].id.ends_with("::codex"));
        assert_eq!(got[1].linked_whole_to, None);
    }

    #[test]
    fn two_harnesses_sharing_one_dir_get_one_column_each() {
        let t = TempTree::new();
        let home = t.root();
        let store = t.dir("Store/skills");
        t.dir("Store/skills/a-skill");
        // 项目的 .agents/skills 整个是指向 store 的软链，codex 与 cursor 共用它
        let project = t.dir("Project/app");
        t.dir("Project/app/.agents");
        t.link(&project.join(".agents/skills"), &store);

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        let hs = vec![pick("codex"), pick("cursor")];
        let srcs = sources(&e, &hs, &[], std::slice::from_ref(&store));
        assert_eq!(srcs.len(), 1);

        let got = targets(&e, &hs, std::slice::from_ref(&project), &srcs);
        let key = project.display();
        assert_eq!(got.len(), 2);
        // 同一个目录两列，id 与列名各自属于自己的 harness，标签不合并
        assert_eq!(got[0].id, format!("project:{key}::codex"));
        assert_eq!(got[0].label, "Codex");
        assert_eq!(got[1].id, format!("project:{key}::cursor"));
        assert_eq!(got[1].label, "Cursor");
        // 两列都指向同一个目录，各自都算整目录链接
        for x in &got {
            assert_eq!(x.dirs, vec![project.join(".agents/skills")]);
            assert_eq!(x.linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
        }
    }

    #[test]
    fn agent_dir_and_the_project_symlink_pointing_at_it_stay_two_columns() {
        let t = TempTree::new();
        let home = t.root();
        let weiboap = "Library/Application Support/WeiboAP";
        let agent_root = t.dir(&format!("{weiboap}/Data/agents/agent_1"));
        let agent_dir = t.dir(&format!(
            "{weiboap}/Data/agents/agent_1/.internal-plugins/skills"
        ));
        t.dir(&format!(
            "{weiboap}/Data/agents/agent_1/.internal-plugins/skills/a-skill"
        ));
        // 项目的 .claude/skills 整个是指向那个 agent 目录的软链
        let project = t.dir("Project/weibo_assistant");
        t.dir("Project/weibo_assistant/.claude");
        t.link(&project.join(".claude/skills"), &agent_dir);

        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        let hs = vec![pick("claude-code"), pick("weiboap")];
        let srcs = sources(&e, &hs, &[], &[]);
        assert_eq!(srcs.len(), 1);
        assert_eq!(srcs[0].path, agent_dir);

        let got = targets(&e, &hs, std::slice::from_ref(&project), &srcs);
        assert_eq!(got.len(), 3);
        // agent 目标：本体所在，不是整目录链接
        assert_eq!(
            got[0].id,
            format!("project:{}::weiboap", agent_root.display())
        );
        assert_eq!(got[0].label, "WeiboAP");
        assert_eq!(got[0].dirs, vec![agent_dir.clone()]);
        assert_eq!(got[0].linked_whole_to, None);
        // 全局扇出列：同一个 agent 目录，独立成列
        assert_eq!(got[1].id, "weiboap");
        assert_eq!(got[1].dirs, vec![agent_dir.clone()]);
        assert_eq!(got[1].linked_whole_to, None);
        // 项目那一列独立留下，指回 agent 本体位置，"拆成逐项链接"才有入口
        assert_eq!(
            got[2].id,
            format!("project:{}::claude-code", project.display())
        );
        assert_eq!(got[2].label, "Claude Code");
        assert_eq!(got[2].dirs, vec![project.join(".claude/skills")]);
        assert_eq!(got[2].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
    }

    #[test]
    fn resolved_harness_dirs_take_the_real_path_when_they_exist() {
        let t = TempTree::new();
        let home = t.root();
        let real = t.dir(".codex/skills");
        t.file(&home.join(".codex"), "config.toml");
        // Orca 那样的运行时家目录：$CODEX_HOME/skills 是指向 ~/.codex/skills 的软链
        let runtime = t.dir("Library/Application Support/orca/codex-runtime-home/home");
        t.link(&runtime.join("skills"), &real);
        let e = env(&home, &[("CODEX_HOME", runtime.to_str().unwrap())]);
        let codex = |hs: Vec<Harness>| hs.into_iter().find(|h| h.id == "codex").unwrap();
        assert_eq!(codex(all_harnesses(&e)).global_dir, Some(real.clone()));
        assert_eq!(codex(installed(&e)).global_dir, Some(real.clone()));
        // 不存在的候选保留原样，不做解析
        let gone = home.join("nope");
        let e2 = env(&home, &[("CODEX_HOME", gone.to_str().unwrap())]);
        assert_eq!(
            codex(all_harnesses(&e2)).global_dir,
            Some(gone.join("skills"))
        );
    }

    #[test]
    fn env_override_pointing_at_a_symlink_yields_one_plain_target() {
        let t = TempTree::new();
        let home = t.root();
        let real = t.dir(".codex/skills");
        t.dir(".codex/skills/a-skill");
        let runtime = t.dir("orca-home");
        t.link(&runtime.join("skills"), &real);
        let e = env(&home, &[("CODEX_HOME", runtime.to_str().unwrap())]);
        let hs = vec![all_harnesses(&e)
            .into_iter()
            .find(|h| h.id == "codex")
            .unwrap()];
        let srcs = sources(&e, &hs, &[], &[]);
        let got = targets(&e, &hs, &[], &srcs);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].dirs, vec![real]);
        assert_eq!(got[0].linked_whole_to, None);
    }

    #[test]
    fn glob_expanded_dirs_take_the_real_path_too() {
        let t = TempTree::new();
        let home = t.root();
        let real = t.dir("Real/skills");
        t.dir("Glob");
        t.link(&home.join("Glob/a"), &home.join("Real"));
        let e = env(&home, &[]);
        assert_eq!(
            expand_template_glob(&s(&["~/Glob/*/skills"]), &e),
            vec![real]
        );
    }

    #[test]
    fn broken_claude_json_only_drops_recorded_projects() {
        let t = TempTree::new();
        let home = t.root();
        std::fs::write(home.join(".claude.json"), "{not json").unwrap();
        let manual = t.dir("m");
        t.dir("m/.claude/skills");
        let e = env(&home, &[]);
        assert_eq!(
            project_candidates(&e, std::slice::from_ref(&manual), &all_harnesses(&e)),
            vec![manual]
        );
    }
}

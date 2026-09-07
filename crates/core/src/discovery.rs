//! 内置 harness 表、已安装判定、项目候选、本体位置与目标发现
use crate::fs::{entry_kind, normalize, real_path, EntryKind};
use crate::models::{Harness, Source, SourceKind, Target, TargetScope};
use crate::store::Settings;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

/// 通用仓库 `.agents/skills` 不属于某个 harness，目标列用这个 id
pub const UNIVERSAL_ID: &str = "universal";

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

/// 位置里的 skill：直接子项中非隐藏的真实目录，排序。
/// `link_through` 为真时，`real_path` 解析到目录的软链也算（坏链始终不算）
fn skills_in(dir: &Path, link_through: bool) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = BTreeSet::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') && is_skill(&e.path(), link_through) {
            names.insert(name);
        }
    }
    names.into_iter().collect()
}

fn is_skill(path: &Path, link_through: bool) -> bool {
    match entry_kind(path) {
        EntryKind::Dir => true,
        EntryKind::Symlink(_) => link_through && real_path(path).is_some_and(|r| r.is_dir()),
        _ => false,
    }
}

/// 仓库型位置（通用仓库、项目仓库、手动添加）里软链到目录的条目也算 skill：
/// 用户会把外部目录链进仓库。harness 目录只认真实目录，
/// 否则满是软链的消费目录会反过来被当成本体位置
fn links_count_as_skills(kind: &SourceKind) -> bool {
    matches!(
        kind,
        SourceKind::Universal | SourceKind::ProjectStore { .. } | SourceKind::Manual
    )
}

/// harness 表里配了 per-agent 目录的条目：id → 模板
fn agent_dir_templates() -> HashMap<String, Vec<String>> {
    specs()
        .into_iter()
        .filter(|s| !s.agent_dirs.is_empty())
        .map(|s| (s.id, s.agent_dirs))
        .collect()
}

/// harness 的 per-agent 目录：agent 根当项目，标签为「harness 名 · agent 目录名」。
/// `Harness.agent_dirs` 已经展开，看不出是哪一层匹配的 `*`，
/// 只能回表按模板重新展开一次（同样的模板、同样的 env，结果一致）
fn agent_projects(env: &Env, harnesses: &[Harness]) -> Vec<AgentProject> {
    let templates = agent_dir_templates();
    harnesses
        .iter()
        .filter_map(|h| Some((h, templates.get(&h.id)?)))
        .flat_map(|(h, t)| {
            glob_matches(t, env)
                .into_iter()
                .map(move |(root, dir)| AgentProject {
                    harness_id: h.id.clone(),
                    display_name: h.display_name.clone(),
                    label: format!("{} · {}", h.display_name, dir_name(&root)),
                    root,
                    dir,
                })
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
        let skills = skills_in(&path, links_count_as_skills(&kind));
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

/// 所有可写目标：存在的 harness 全局目录 + 每个项目里存在的 harness 目录。
/// 项目的 `.agents/skills` 只出一列；全局通用仓库是本体位置，不是目标。
/// 按 `real_path` 去重并合并 label；目标目录整个是指向某本体位置的软链时填 `linked_whole_to`
pub fn targets(
    env: &Env,
    harnesses: &[Harness],
    projects: &[PathBuf],
    sources: &[Source],
) -> Vec<Target> {
    let store = env.home.join(".agents").join("skills");
    let store_key = real_path(&store).unwrap_or_else(|| normalize(&store));
    let mut out: Vec<Target> = Vec::new();
    // 与 out 一一对应；目录本身是软链的目标记 None，不参与去重
    let mut keys: Vec<Option<PathBuf>> = Vec::new();
    let mut push = |id: String, label: String, path: PathBuf, scope: TargetScope| {
        // is_dir 跟随软链：整目录软链也算目标
        if !path.is_dir() {
            return;
        }
        let real = real_path(&path).unwrap_or_else(|| normalize(&path));
        if real == store_key {
            return;
        }
        // 目录本身就是软链时，它和它指向的那个目标是两码事：一个是"整目录链接"、
        // 一个是本体所在。合并进去会让这一列连同"拆成逐项链接"的入口一起消失
        let key = (!matches!(entry_kind(&path), EntryKind::Symlink(_))).then_some(real);
        if let Some(k) = &key {
            if let Some(i) = keys.iter().position(|x| x.as_ref() == Some(k)) {
                out[i].label = format!("{} / {}", out[i].label, label);
                return;
            }
        }
        keys.push(key);
        out.push(Target {
            id,
            label,
            path,
            scope,
            linked_whole_to: None,
        });
    };

    for h in harnesses {
        if let Some(dir) = h.global_dir.clone() {
            push(
                h.id.clone(),
                h.display_name.clone(),
                dir,
                TargetScope::Global {
                    harness_id: h.id.clone(),
                },
            );
        }
    }
    for a in agent_projects(env, harnesses) {
        let key = normalize(&a.root).to_string_lossy().into_owned();
        push(
            format!("project:{key}::{}", a.harness_id),
            a.display_name,
            a.dir,
            TargetScope::Project {
                project: a.root,
                harness_id: a.harness_id,
                project_label: Some(a.label),
            },
        );
    }
    for p in projects {
        let key = normalize(p).to_string_lossy().into_owned();
        let universal = p.join(".agents").join("skills");
        push(
            format!("project:{key}::{UNIVERSAL_ID}"),
            "通用仓库".to_string(),
            universal.clone(),
            TargetScope::Project {
                project: p.clone(),
                harness_id: UNIVERSAL_ID.to_string(),
                project_label: None,
            },
        );
        for h in harnesses {
            let Some(dir) = h.project_dir.as_ref().map(|d| p.join(d)) else {
                continue;
            };
            if dir == universal {
                continue;
            }
            push(
                format!("project:{key}::{}", h.id),
                h.display_name.clone(),
                dir,
                TargetScope::Project {
                    project: p.clone(),
                    harness_id: h.id.clone(),
                    project_label: None,
                },
            );
        }
    }

    for t in &mut out {
        if !matches!(entry_kind(&t.path), EntryKind::Symlink(_)) {
            continue;
        }
        let Some(real) = real_path(&t.path) else {
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

        let got: Vec<(String, String, PathBuf, TargetScope)> = targets(&e, &hs, &[], &[])
            .into_iter()
            .map(|x| (x.id, x.label, x.path, x.scope))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    format!("project:{}::weiboap", root1.display()),
                    "WeiboAP".to_string(),
                    dir1,
                    TargetScope::Project {
                        project: root1,
                        harness_id: "weiboap".into(),
                        project_label: Some("WeiboAP · agent_1".to_string()),
                    },
                ),
                (
                    format!("project:{}::weiboap", root2.display()),
                    "WeiboAP".to_string(),
                    dir2,
                    TargetScope::Project {
                        project: root2,
                        harness_id: "weiboap".into(),
                        project_label: Some("WeiboAP · agent_2".to_string()),
                    },
                ),
            ]
        );
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

        let got: Vec<(String, PathBuf, SourceKind, String, Vec<String>)> = got
            .into_iter()
            .map(|s| (s.id, s.path, s.kind, s.label, s.skills))
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
    fn store_sources_link_through_but_harness_dirs_only_count_real_dirs() {
        let t = TempTree::new();
        let home = t.root();
        let outside = t.dir("Applications/ego-skills/ego-browser");
        t.dir(".agents/skills/real-skill");
        t.link(&home.join(".agents/skills/ego-browser"), &outside);
        t.link(&home.join(".agents/skills/rotten"), &home.join("gone")); // 坏链不算
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
            vec!["ego-browser".to_string(), "real-skill".to_string()]
        );
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
    fn targets_list_globals_projects_and_one_universal_column() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".agents/skills/uni-skill"); // 全局通用仓库是本体位置，不是目标
        t.dir(".claude/skills");
        let project = t.dir("Project/app");
        t.dir("Project/app/.claude/skills");
        t.dir("Project/app/.agents/skills");
        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        // cline 的 global_dir 就是 ~/.agents/skills；codex、cursor 项目级都读 .agents/skills
        let hs = vec![
            pick("claude-code"),
            pick("codex"),
            pick("cursor"),
            pick("cline"),
        ];
        let got = targets(&e, &hs, std::slice::from_ref(&project), &[]);
        let key = project.display();
        let got: Vec<(String, String, PathBuf, TargetScope)> = got
            .into_iter()
            .map(|x| (x.id, x.label, x.path, x.scope))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "claude-code".to_string(),
                    "Claude Code".to_string(),
                    home.join(".claude/skills"),
                    TargetScope::Global {
                        harness_id: "claude-code".into()
                    },
                ),
                (
                    format!("project:{key}::universal"),
                    "通用仓库".to_string(),
                    project.join(".agents/skills"),
                    TargetScope::Project {
                        project: project.clone(),
                        harness_id: "universal".into(),
                        project_label: None
                    },
                ),
                (
                    format!("project:{key}::claude-code"),
                    "Claude Code".to_string(),
                    project.join(".claude/skills"),
                    TargetScope::Project {
                        project: project.clone(),
                        harness_id: "claude-code".into(),
                        project_label: None
                    },
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
        let hs = vec![all.iter().find(|h| h.id == "claude-code").unwrap().clone()];
        let srcs = sources(&e, &hs, &[], std::slice::from_ref(&store));
        let got = targets(&e, &hs, std::slice::from_ref(&project), &srcs);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
        // 普通目录目标不带整目录链接标记
        t.dir("Project/app/.agents/skills");
        let got = targets(&e, &hs, &[project], &srcs);
        assert_eq!(got.len(), 2);
        assert!(got[0].id.ends_with("::universal"));
        assert_eq!(got[0].linked_whole_to, None);
        assert_eq!(got[1].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
    }

    #[test]
    fn symlinked_target_dir_is_never_merged_into_the_dir_it_points_to() {
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
        assert_eq!(got.len(), 2);
        // agent 目标不受影响：标签没被合并，也不是整目录链接
        assert_eq!(
            got[0].id,
            format!("project:{}::weiboap", agent_root.display())
        );
        assert_eq!(got[0].label, "WeiboAP");
        assert_eq!(got[0].path, agent_dir);
        assert_eq!(got[0].linked_whole_to, None);
        // 项目那一列独立留下，指回 agent 本体位置，"拆成逐项链接"才有入口
        assert_eq!(
            got[1].id,
            format!("project:{}::claude-code", project.display())
        );
        assert_eq!(got[1].label, "Claude Code");
        assert_eq!(got[1].path, project.join(".claude/skills"));
        assert_eq!(got[1].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
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
        assert_eq!(got[0].path, real);
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

//! 内置 harness 表、已安装判定、项目候选
use crate::models::Harness;
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

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

fn resolve_one(template: &str, env: &Env) -> Option<PathBuf> {
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
    };
    (harness, resolve_template(&spec.detect_dir, env))
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
        assert!(all.len() >= 40);
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

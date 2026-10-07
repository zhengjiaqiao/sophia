//! 内置 harness 表、已安装判定、项目候选、本体位置与目标发现
use crate::fs::{entry_kind, normalize, real_path, EntryKind};
use crate::models::{AgentLabels, Harness, Skill, Source, SourceKind, Target, TargetScope};
use crate::skills::read_description;
use crate::store::Settings;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

const HARNESSES_JSON: &str = include_str!("../data/harnesses.json");

/// 内部版增量表。`include_str!` 会把整份 JSON 原样嵌进二进制，运行时过滤删不掉
/// 字符串常量，所以内部条目必须单独成文件、由 cfg 决定要不要 include。
#[cfg(feature = "weiboap")]
const WEIBOAP_HARNESSES_JSON: &str = include_str!("../data/harnesses.weiboap.json");

#[derive(Debug, Deserialize)]
struct HarnessSpec {
    id: String,
    display_name: String,
    #[serde(default)]
    project_dir: Option<String>,
    /// 先新后旧：第一个能解析的是这个 agent 的列；后面的是它还认、但不再往里写的旧位置，
    /// 只用来认出探测目录里的 skills 空壳（见 `looks_installed`）
    #[serde(default)]
    global_dir: Vec<String>,
    /// 先新后旧：任一个看起来装过就算已安装
    #[serde(default)]
    detect_dir: Vec<String>,
    /// 同品牌的桌面应用（macOS）：装了任一个也算已安装。只用来判定，不改各页的列
    #[serde(default)]
    detect_app: Vec<AppSpec>,
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
    /// 只有 MCP 的 agent（Claude Desktop）：没有 skill 目录，SKILLS 页与设置的名单都不出现它，
    /// 只由 `mcp_columns` 带进 MCP 页
    #[serde(default)]
    mcp_only: bool,
    /// 只在这些系统上登记（`std::env::consts::OS`：`macos` / `windows` / `linux`）；空＝全部
    #[serde(default)]
    platforms: Vec<String>,
}

/// 应用包：放应用的文件夹里叫 `name` 的包，`Info.plist` 的 `CFBundleIdentifier` 是 `bundle_id`
/// （同名的别家应用不算）
#[derive(Debug, Deserialize)]
struct AppSpec {
    name: String,
    bundle_id: String,
}

#[derive(Debug, Deserialize)]
struct HarnessFile {
    harnesses: Vec<HarnessSpec>,
}

/// 模板解析所需的环境：主目录、环境变量、放应用的文件夹（测试时可伪造）
pub struct Env {
    pub home: PathBuf,
    pub vars: HashMap<String, String>,
    /// 按 `detect_app` 找应用包的文件夹：macOS 是 `/Applications` 与 `~/Applications`，别的系统为空
    pub apps: Vec<PathBuf>,
}

impl Env {
    pub fn from_system() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let apps = if cfg!(target_os = "macos") {
            vec![PathBuf::from("/Applications"), home.join("Applications")]
        } else {
            Vec::new()
        };
        Env {
            home,
            vars: std::env::vars().collect(),
            apps,
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

/// 本机系统上登记的全部条目（含只有 MCP 的）
fn specs() -> Vec<HarnessSpec> {
    let mut specs = parse_specs(HARNESSES_JSON);
    specs.extend(extra_specs());
    specs.retain(|s| {
        s.platforms.is_empty() || s.platforms.iter().any(|p| p == std::env::consts::OS)
    });
    specs
}

/// 有 skill 目录的条目：SKILLS 页与设置的名单只看它们
fn skill_specs() -> Vec<HarnessSpec> {
    specs().into_iter().filter(|s| !s.mcp_only).collect()
}

fn parse_specs(json: &str) -> Vec<HarnessSpec> {
    serde_json::from_str::<HarnessFile>(json)
        .expect("harnesses.json 内置数据必须合法")
        .harnesses
}

#[cfg(feature = "weiboap")]
fn extra_specs() -> Vec<HarnessSpec> {
    parse_specs(WEIBOAP_HARNESSES_JSON)
}

#[cfg(not(feature = "weiboap"))]
fn extra_specs() -> Vec<HarnessSpec> {
    Vec::new()
}

fn resolve(spec: &HarnessSpec, env: &Env) -> Harness {
    Harness {
        id: spec.id.clone(),
        display_name: spec.display_name.clone(),
        project_dir: spec.project_dir.clone(),
        global_dir: resolve_template(&spec.global_dir, env),
        universal: spec.universal,
        agent_dirs: expand_template_glob(&spec.agent_dirs, env),
        managed_global_dir: spec.managed_global_dir,
        agent_labels: spec.agent_labels.clone(),
    }
}

/// 每个候选各自解析，跳过未设置的环境变量
fn resolve_all(candidates: &[String], env: &Env) -> Vec<PathBuf> {
    candidates
        .iter()
        .filter_map(|t| resolve_one(t, env))
        .collect()
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

/// 位置里的 skill：直接子项中非隐藏、**带 `SKILL.md`** 的真实目录，按名排序。
/// 不带 `SKILL.md` 的目录不是 skill（agent 不会加载它）——同步工具、备份留下的文件夹（如
/// `~/.claude/skills/synced`）不该出现在表里；与订阅来源「只认带 `SKILL.md` 的子目录」同一条规则。
/// 软链一律不算——它是指向别处本体的链接，不是这个位置自己的 skill
fn skills_in(dir: &Path) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = BTreeSet::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if !name.starts_with('.')
            && entry_kind(&path) == EntryKind::Dir
            && path.join("SKILL.md").is_file()
        {
            names.insert(name);
        }
    }
    names
        .into_iter()
        .map(|name| Skill {
            description: read_description(&dir.join(&name)),
            path: dir.join(&name),
            name,
        })
        .collect()
}

/// harness 表里配了 per-agent 目录的条目：id → 模板
fn agent_dir_templates() -> HashMap<String, Vec<String>> {
    skill_specs()
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
            log::warn!("打不开 {}：{e}", path.display());
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
        Err(e) => log::warn!("读 {} 失败：{e}", spec.table),
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
        crate::t!("sources.name.universal"),
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
            crate::t!("sources.name.projectStore", name = dir_name(p)),
        );
    }
    for p in manual {
        push(p.clone(), SourceKind::Manual, dir_name(p));
    }

    out
}

/// 目标目录里指向"任何已知本体位置之外"的软链，按真实父目录合成为外部本体位置。
/// 目录还不存在的目标没什么可读，跳过；整目录链接的目标读进去就是本体位置，也跳过。
/// 同一父目录下同名不同真实路径的取首个
pub fn external_sources(_env: &Env, targets: &[Target], known: &[Source]) -> Vec<Source> {
    let inside: Vec<PathBuf> = known.iter().filter_map(|s| real_path(&s.path)).collect();
    let mut groups: BTreeMap<PathBuf, BTreeMap<String, PathBuf>> = BTreeMap::new();
    for t in targets
        .iter()
        .filter(|t| t.exists && t.linked_whole_to.is_none())
    {
        let Ok(entries) = std::fs::read_dir(&t.path) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        for name in names {
            let path = t.path.join(&name);
            if !matches!(entry_kind(&path), EntryKind::Symlink(_)) {
                continue;
            }
            // 坏链解析不出真实路径；指向文件的、指向不带 `SKILL.md` 的目录的都不是 skill
            // （与 `skills_in` 同一条规则：位置里的 skill 只认带 `SKILL.md` 的目录）
            let Some(real) = real_path(&path).filter(|r| r.join("SKILL.md").is_file()) else {
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
            label: external_label(&path),
            kind: SourceKind::External,
            skills: skills
                .into_iter()
                .map(|(name, path)| Skill {
                    description: read_description(&path),
                    name,
                    path,
                })
                .collect(),
            path,
        })
        .collect()
}

/// 订阅记录里、常规发现没找到的文件夹（用户在来源管理页选的，或外部位置的软链都撤了之后
/// 记录里还留着的）：按手动位置读进来，名字与外部位置同一套取法（`folder_label`）。
/// 这些文件夹是任意位置，里面未必都是 skill（外部位置的父目录可能就是 `~/Project`），
/// 所以只认带 `SKILL.md` 的子目录。不在了、一个 skill 都没有、或与已知位置同一处（按
/// `real_path`）的不产出。要在 `targets` 之前调用，整目录链接与外部位置才认得出它们
pub fn subscribed_sources<'a>(
    dirs: impl IntoIterator<Item = &'a PathBuf>,
    known: &[Source],
) -> Vec<Source> {
    let mut keys: Vec<PathBuf> = known
        .iter()
        .map(|s| real_path(&s.path).unwrap_or_else(|| normalize(&s.path)))
        .collect();
    let mut out = Vec::new();
    for dir in dirs {
        let Some(key) = real_path(dir) else {
            continue;
        };
        if keys.contains(&key) || known.iter().any(|s| normalize(&s.path) == normalize(dir)) {
            continue;
        }
        let skills: Vec<Skill> = skills_in(dir);
        if skills.is_empty() {
            continue;
        }
        keys.push(key);
        out.push(Source {
            id: normalize(dir).to_string_lossy().into_owned(),
            path: normalize(dir),
            kind: SourceKind::Manual,
            label: folder_label(dir),
            skills,
        });
    }
    out
}

/// 任意文件夹的来源名：与外部位置同一套（应用名、跳过 `skills` 这类泛称）
pub(crate) fn folder_label(path: &Path) -> String {
    external_label(path)
}

/// 外部本体位置的标签是**用户认得的名字**，不是路径（DESIGN.md「来源的名字」）：
/// 路径里任一祖先是应用包（`.app`）→ 取那一级去掉后缀的应用名，其余取最后一级目录名。
/// 逐路径分量判断：字符串 `contains(".app")` 会被 `my.application` 骗到。
/// 路径本身留在 `id` 和 `path` 字段里，界面放 `title`
fn external_label(path: &Path) -> String {
    let names: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    // 应用包：取最外层那个 .app（嵌套时它才是用户装的那个应用）
    if let Some(app) = names
        .iter()
        .find_map(|n| n.strip_suffix(".app").filter(|a| !a.is_empty()))
    {
        return app.to_owned();
    }
    // macOS 应用数据目录：`~/Library/Application Support/<应用>/…` 里的东西归那个应用
    if let Some(i) = names.iter().position(|n| n == "Application Support") {
        if let Some(app) = names.get(i + 1) {
            return app.clone();
        }
    }
    // 其余：从末尾往上找第一个不是「skills」这类泛称的分量。`~/.local/share/ego/skills`
    // 该叫 ego 不该叫 skills——末尾一级几乎总是泛称，光取它三个来源会撞成一个名字
    names
        .iter()
        .rev()
        .find(|n| !is_generic_dir_name(n))
        .cloned()
        .unwrap_or_else(|| dir_name(path))
}

/// 目录名里没有信息量的那几个：标签跳过它们往上取
fn is_generic_dir_name(name: &str) -> bool {
    matches!(
        name.trim_start_matches('.').to_ascii_lowercase().as_str(),
        "skills" | "skill" | "plugins" | "internal-plugins" | "resources" | "share" | "data"
    )
}

/// 所有可写目标：每个启用 harness 各自一列——全局目录、per-agent 目录、每个项目的项目目录。
/// 列名就是 harness 名；多个 harness 共用同一个目录时各自成列，不合并。
/// 目录不存在的目标照常产出，只标 `exists == false`：它不成列，但引入弹层可选，建链时就地创建。
/// 目标目录整个是指向某本体位置的软链时填 `linked_whole_to`，这只对已存在的目录求值
pub fn targets(
    env: &Env,
    harnesses: &[Harness],
    projects: &[PathBuf],
    sources: &[Source],
) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    let mut push = |id: String, label: String, path: PathBuf, scope: TargetScope| {
        // 判断"目标目录是否存在"要跟随软链：整目录软链也算已存在
        let exists = path.is_dir();
        out.push(Target {
            id,
            label,
            path,
            scope,
            exists,
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
        for h in harnesses {
            let Some(dir) = h.project_dir.as_ref().map(|d| p.join(d)) else {
                continue;
            };
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

    // 目录不存在的目标不做任何 IO
    for t in out.iter_mut().filter(|t| t.exists) {
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

/// 全部 harness（有 skill 目录的；只有 MCP 的不在里面），路径已按当前环境解析
pub fn all_harnesses(env: &Env) -> Vec<Harness> {
    skill_specs().iter().map(|s| resolve(s, env)).collect()
}

/// 任一探测目录（detect_dir，缺省 global_dir）存在，且不是只装着通往 skills 的空壳；
/// 或者装了同品牌的桌面应用（detect_app）。只有 MCP 的 agent 不在里面（见 `mcp_columns`）
pub fn installed(env: &Env) -> Vec<Harness> {
    installed_in(skill_specs(), env)
}

fn installed_in(specs: Vec<HarnessSpec>, env: &Env) -> Vec<Harness> {
    specs
        .iter()
        .filter_map(|s| {
            let h = resolve(s, env);
            let mut probes = resolve_all(&s.detect_dir, env);
            if probes.is_empty() {
                probes.extend(h.global_dir.clone());
            }
            let skill_dirs = resolve_all(&s.global_dir, env);
            (probes.iter().any(|p| looks_installed(p, &skill_dirs))
                || s.detect_app.iter().any(|app| app_installed(app, env)))
            .then_some(h)
        })
        .collect()
}

/// MCP 页的列（spec 2026-09-27-mcp-batch1 R7、skill-mcp-market R17）：两页共用一份名单，
/// `shown` 是名单里正显示的（`enabled` 之后，agent 表先后），这里只留支持 MCP 的；
/// 再加上 Claude Desktop——它不进名单、不占名额，装了且 Claude Code 在列时紧跟在 Claude Code 后面
/// （列头与 Claude Code 合成一组）。只看某个项目时它整列都空，由前端按位置不出
pub fn mcp_columns(env: &Env, shown: &[Harness]) -> Vec<Harness> {
    let mut out: Vec<Harness> = shown
        .iter()
        .filter(|h| crate::mcp::supports(&h.id))
        .cloned()
        .collect();
    if let Some(at) = out.iter().position(|h| h.id == "claude-code") {
        let desktop = specs()
            .into_iter()
            .filter(|s| s.id == "claude-desktop")
            .collect();
        if let Some(desktop) = installed_in(desktop, env).into_iter().next() {
            out.insert(at + 1, desktop);
        }
    }
    out
}

/// 去掉被用户关掉的 harness，顺序不变
pub fn enabled(installed: Vec<Harness>, settings: &Settings) -> Vec<Harness> {
    installed
        .into_iter()
        .filter(|h| !settings.disabled_harnesses.contains(&h.id))
        .collect()
}

/// 列表里最多显示几个 agent（DESIGN「设置页 › 最多 4 个」）：矩阵、工具行、添加页底部都按
/// 4 个排版，再多就挤出窗口。唯一定义处，前端经 `list_harnesses` 拿到，不另写一个 4
pub const MAX_SHOWN: usize = 4;

/// 显示中的 agent 数：已安装且不在不显示名单里
fn shown_count(installed: &[String], settings: &Settings) -> usize {
    installed
        .iter()
        .filter(|id| !settings.disabled_harnesses.contains(id))
        .count()
}

/// 按上限整理显示名单，返回是否改动。`installed` 按 agent 表的先后。
/// - 新装的（不在 `known_installed` 里、也不在不显示名单里）：显示不满 `MAX_SHOWN` 个时照常出现，
///   已满就记进不显示名单——不挤掉用户已经在看的
/// - 新用户与升级上来的老数据 `known_installed` 为空，已安装的全算新装，于是按表先后留前 4 个
/// - 兜底：仍超出（比如文件被手改过）就按表先后留前 4 个
/// - 不显示名单只记已安装的：未安装的先清出去（勾选与否只对已安装的有意义），装回时按新装算
///
/// 最后把 `known_installed` 换成这次的已安装集合：卸载了的从中移除，重装时再按新装算
pub fn reconcile_shown(installed: &[String], settings: &mut Settings) -> bool {
    let before = (
        settings.disabled_harnesses.clone(),
        settings.known_installed.clone(),
    );
    settings
        .disabled_harnesses
        .retain(|id| installed.contains(id));
    let mut shown = installed
        .iter()
        .filter(|id| {
            settings.known_installed.contains(id) && !settings.disabled_harnesses.contains(id)
        })
        .count();
    for id in installed {
        if settings.known_installed.contains(id) || settings.disabled_harnesses.contains(id) {
            continue;
        }
        if shown < MAX_SHOWN {
            shown += 1;
        } else {
            settings.disabled_harnesses.push(id.clone());
        }
    }
    let mut kept = 0;
    for id in installed {
        if settings.disabled_harnesses.contains(id) {
            continue;
        }
        kept += 1;
        if kept > MAX_SHOWN {
            settings.disabled_harnesses.push(id.clone());
        }
    }
    settings.known_installed = installed.to_vec();
    before.0 != settings.disabled_harnesses || before.1 != settings.known_installed
}

/// 已显示满 `MAX_SHOWN` 个时再勾一个已安装的
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShownLimitReached;

impl std::fmt::Display for ShownLimitReached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            crate::t!("sources.error.shownLimit", max = MAX_SHOWN)
        )
    }
}

impl std::error::Error for ShownLimitReached {}

/// 设置页勾选 / 取消勾选一个 agent。勾上已安装的而显示已满时拒绝，名单不动。
/// 设置页只给已安装的勾选框；未安装的不在名单里（见 `reconcile_shown`）
pub fn set_shown(
    installed: &[String],
    settings: &mut Settings,
    id: &str,
    shown: bool,
) -> Result<(), ShownLimitReached> {
    let hidden = settings.disabled_harnesses.iter().any(|x| x == id);
    if shown
        && hidden
        && installed.iter().any(|x| x == id)
        && shown_count(installed, settings) >= MAX_SHOWN
    {
        return Err(ShownLimitReached);
    }
    settings.disabled_harnesses.retain(|x| x != id);
    if !shown {
        settings.disabled_harnesses.push(id.to_string());
    }
    Ok(())
}

fn app_installed(app: &AppSpec, env: &Env) -> bool {
    env.apps.iter().any(|dir| {
        let plist = dir.join(&app.name).join("Contents/Info.plist");
        plist::Value::from_file(plist).is_ok_and(|value| {
            value
                .as_dictionary()
                .and_then(|d| d.get("CFBundleIdentifier"))
                .and_then(plist::Value::as_string)
                == Some(app.bundle_id.as_str())
        })
    })
}

/// 探测目录里至少要有一个条目不在通往 `global_dir` 任一候选（含旧位置）的路径上、也不是别的工具
/// 代写的扩展点。`npx skills add --agent '*'` 会给未安装的工具也建出 `~/.xxx/skills`（agent 改过
/// 目录后它可能还在建旧的）；Orca 这类状态栏工具会给一长串 agent 都写上 hooks / plugins
/// （连同 `.bak` 备份）——这些都不说明 agent 本身装过。没有 global_dir 时存在即可
fn looks_installed(probe: &Path, skill_dirs: &[PathBuf]) -> bool {
    if skill_dirs.is_empty() {
        return probe.exists();
    }
    let Ok(entries) = std::fs::read_dir(probe) else {
        return false;
    };
    entries.flatten().any(|e| {
        let path = e.path();
        !skill_dirs.iter().any(|d| d.starts_with(path.as_path())) && !written_by_others(&path, 0)
    })
}

/// 别的工具往 agent 目录里代写的东西：hooks、plugins、备份，只含 hooks / plugin 键的 JSON / TOML 配置，
/// 撤掉改动后只剩空内容的配置，以及只装着这些的子目录（Gemini 的 `config/hooks.json`）
fn written_by_others(path: &Path, depth: usize) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if matches!(name, "hooks" | "hooks.json" | "plugins") || name.ends_with(".bak") {
        return true;
    }
    match entry_kind(path) {
        EntryKind::Dir if depth < 2 => std::fs::read_dir(path).is_ok_and(|entries| {
            let mut entries = entries.flatten().peekable();
            entries.peek().is_some() && entries.all(|e| written_by_others(&e.path(), depth + 1))
        }),
        EntryKind::File => emptied_beside_backup(path, name) || hooks_only(path, name),
        _ => false,
    }
}

/// 按 `name` 的后缀认格式（`.bak` 传原文件名），JSON / TOML 之外的都不算
fn hooks_only(path: &Path, name: &str) -> bool {
    if name.ends_with(".json") {
        hooks_only_json(path)
    } else if name.ends_with(".toml") {
        hooks_only_toml(path)
    } else {
        false
    }
}

/// 顶层只有 hooks / plugin 一类的键（`{}` 不算：空配置可能是 agent 自己建的）
fn hooks_only_json(path: &Path) -> bool {
    let Some(serde_json::Value::Object(map)) =
        small_text(path).and_then(|text| serde_json::from_str(&text).ok())
    else {
        return false;
    };
    only_hook_keys(map.keys().map(String::as_str))
}

/// TOML 版的 `hooks_only_json`：Orca 给 Kimi Code 写的是 `[[hooks]]`
fn hooks_only_toml(path: &Path) -> bool {
    let Some(document) =
        small_text(path).and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
    else {
        return false;
    };
    only_hook_keys(document.iter().map(|(key, _)| key))
}

fn only_hook_keys<'a>(keys: impl Iterator<Item = &'a str>) -> bool {
    const KEYS: [&str; 4] = ["hooks", "plugin", "plugins", "$schema"];
    let mut keys = keys.peekable();
    keys.peek().is_some() && keys.all(|k| KEYS.contains(&k))
}

/// 自己只剩空白或 `{}`、旁边的 `<名>.bak` 也只有 hooks 一类的键：别的工具撤掉自己写的 hooks 时
/// 留了备份，把原本没有的配置改回了空（Orca 撤 Kimi Code 的 hooks 后的 `config.toml`）。
/// 没有备份、或备份里有别的设置的空配置，仍算 agent 自己的
fn emptied_beside_backup(path: &Path, name: &str) -> bool {
    hooks_only(&path.with_file_name(format!("{name}.bak")), name)
        && small_text(path).is_some_and(|text| {
            let text = text.trim();
            text.is_empty()
                || serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text)
                    .is_ok_and(|map| map.is_empty())
        })
}

/// 256 KiB 以内的文本文件原文；更大的不像配置，不读
fn small_text(path: &Path) -> Option<String> {
    let small = std::fs::metadata(path).is_ok_and(|m| m.len() <= 256 * 1024);
    small.then(|| std::fs::read_to_string(path).ok()).flatten()
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

/// 自动检测的项目：Claude Code 与 Codex 记录的项目合并（spec 2026-10-05-skill-mcp-batch2「项目来源」），
/// 其中是绝对路径、仍存在、不是主目录 / 根目录 / 主目录下的隐藏目录、且含 skill 目录（去噪）的那些，
/// 按 `real_path` 去重（留先读到的写法，Claude Code 在前）后排序。
/// 手动选的项目（`projects.json`）不在这里并入，见 `projects`
pub fn project_candidates(env: &Env, harnesses: &[Harness]) -> Vec<PathBuf> {
    let home = real_path(&env.home).unwrap_or_else(|| env.home.clone());
    let mut seen = BTreeSet::new();
    let mut found: Vec<PathBuf> = claude_recorded_projects(&env.home)
        .into_iter()
        .chain(codex_recorded_projects(env))
        // 判断目标目录是否存在，要跟随软链
        .filter(|p| p.is_absolute() && p.is_dir())
        // 记录的写法和解析后的真实路径都要过隐藏目录这关：`~/.tool` 可能是指向别处的软链
        .filter(|p| !is_hidden_home_dir(&env.home, p))
        .filter(|p| {
            real_path(p).is_some_and(|real| {
                real != home
                    && real.parent().is_some()
                    && !is_hidden_home_dir(&home, &real)
                    && seen.insert(real)
            })
        })
        .filter(|p| has_project_skill_dir(p, harnesses))
        .collect();
    found.sort();
    found
}

/// 全部项目：自动检测的（`project_candidates`）加手动选的（`projects.json`）。手动选的**不受「含 skill 目录」去噪**
/// ——空文件夹也是一格，好从零开始装——但仍要是绝对路径、此刻存在、不是主目录或根目录；不存在了就不列。
/// 按 `real_path` 去重：自动检测到的写法在前，手动的按加入先后；结果按路径排序。
/// 设置「生效范围」列的就是这一份；扫描与筛选行只用其中勾着的（`shown_projects`）
pub fn projects(env: &Env, harnesses: &[Harness], manual: &[PathBuf]) -> Vec<PathBuf> {
    let home = real_path(&env.home).unwrap_or_else(|| env.home.clone());
    let auto = project_candidates(env, harnesses);
    let mut seen: BTreeSet<PathBuf> = auto.iter().filter_map(|p| real_path(p)).collect();
    let mut found = auto;
    for p in manual {
        // 判断目标目录是否存在，要跟随软链
        if !(p.is_absolute() && p.is_dir()) {
            continue;
        }
        let Some(real) = real_path(p) else {
            continue;
        };
        if real == home || real.parent().is_none() || !seen.insert(real) {
            continue;
        }
        found.push(normalize(p));
    }
    found.sort();
    found
}

/// 去掉设置「生效范围」里取消勾的项目（`Settings.hidden_projects`），按 `real_path` 认同一处；
/// 记录里的文件夹已经不在的，什么都不去掉。一个都不勾时为空：筛选行只剩用户级
pub fn shown_projects(projects: Vec<PathBuf>, hidden: &[PathBuf]) -> Vec<PathBuf> {
    let is_hidden = hidden_test(hidden);
    projects.into_iter().filter(|p| !is_hidden(p)).collect()
}

/// 判断一个项目是否取消勾了：记录先解析一次真实路径，之后逐个比
fn hidden_test(hidden: &[PathBuf]) -> impl Fn(&Path) -> bool {
    let hidden: Vec<PathBuf> = hidden.iter().filter_map(|h| real_path(h)).collect();
    move |p| real_path(p).is_some_and(|real| hidden.contains(&real))
}

/// 设置「生效范围」里的一格项目（用户级那一格不在这里，它一直勾着）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScope {
    /// 项目文件夹（与扫描结果里 `project:<路径>` 的路径同一个写法）；停上去的提示框给它
    pub path: PathBuf,
    /// 格子上的名字：文件夹名
    pub name: String,
    /// 勾着没有：勾着的才出现在筛选行与「切换项目…」浮层里
    pub shown: bool,
}

/// 「生效范围」一节的全部项目格，先后同 `projects`
pub fn project_scopes(projects: Vec<PathBuf>, hidden: &[PathBuf]) -> Vec<ProjectScope> {
    let is_hidden = hidden_test(hidden);
    projects
        .into_iter()
        .map(|path| ProjectScope {
            name: dir_name(&path),
            shown: !is_hidden(&path),
            path,
        })
        .collect()
}

/// 两个写法是否同一处：规范化后相同，或都存在且解析到同一个真实路径
fn same_place(a: &Path, b: &Path) -> bool {
    normalize(a) == normalize(b) || crate::fs::same_real(a, b)
}

/// 设置「生效范围」里勾上 / 取消勾一个项目：取消勾记进 `hidden_projects`，同一处不重复记。记的是**真实路径**
/// （文件夹此刻不在时退回规范化后的写法）：经软链写法取消勾的，软链以后删了、改了，记录照样认得这个文件夹。
/// 勾上把指向同一处的记录都清掉。返回是否改动过
pub fn set_project_shown(settings: &mut Settings, path: &Path, shown: bool) -> bool {
    let hidden = &mut settings.hidden_projects;
    if shown {
        let before = hidden.len();
        hidden.retain(|h| !same_place(h, path));
        hidden.len() != before
    } else if hidden.iter().any(|h| same_place(h, path)) {
        false
    } else {
        hidden.push(real_path(path).unwrap_or_else(|| normalize(path)));
        true
    }
}

/// 手动选的文件夹当不了项目的原因（给用户看的一句）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualProjectError {
    /// 不是一个此刻存在的文件夹（或不是绝对路径）
    NotFolder,
    /// 主目录或根目录：里面是整台电脑的配置，不是一个项目
    Home,
}

impl std::fmt::Display for ManualProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&match self {
            ManualProjectError::NotFolder => crate::t!("settings.scope.notFolder"),
            ManualProjectError::Home => crate::t!("settings.scope.isHome"),
        })
    }
}

impl std::error::Error for ManualProjectError {}

/// 手动加一个项目（`+ 项目` / 应用菜单「添加项目…」）：选的文件夹就是一格，默认勾上——记进 `manual`
/// （`projects.json`；同一处已记过就不重复记），并清掉它在「生效范围」里取消勾的记录（自动检测到、
/// 先前取消勾过的也算重新选上）。返回记下的写法（规范化后）
pub fn add_manual_project(
    env: &Env,
    manual: &mut Vec<PathBuf>,
    settings: &mut Settings,
    path: &Path,
) -> Result<PathBuf, ManualProjectError> {
    if !(path.is_absolute() && path.is_dir()) {
        return Err(ManualProjectError::NotFolder);
    }
    let real = real_path(path).ok_or(ManualProjectError::NotFolder)?;
    let home = real_path(&env.home).unwrap_or_else(|| env.home.clone());
    if real == home || real.parent().is_none() {
        return Err(ManualProjectError::Home);
    }
    let path = normalize(path);
    if !manual.iter().any(|m| same_place(m, &path)) {
        manual.push(path.clone());
    }
    set_project_shown(settings, &path, true);
    Ok(path)
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

/// Codex 设置文件（`$CODEX_HOME/config.toml`，未设置时 `~/.codex/config.toml`）里
/// `[projects."路径"]` 里 `trust_level = "trusted"` 的那些键：在 Codex 里信任过的项目。
/// `untrusted` 是用户明确拒绝过的，没有 `trust_level` 的也不算。
/// 只读值不写；文件不存在或解析失败都视为空
fn codex_recorded_projects(env: &Env) -> Vec<PathBuf> {
    let candidates = [
        "$CODEX_HOME/config.toml".to_string(),
        "~/.codex/config.toml".to_string(),
    ];
    let Some(file) = resolve_template(&candidates, env) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        return Vec::new();
    };
    document
        .get("projects")
        .and_then(|p| p.as_table_like())
        .map(|t| {
            t.iter()
                .filter(|(_, entry)| {
                    entry
                        .as_table_like()
                        .and_then(|e| e.get("trust_level"))
                        .and_then(|level| level.as_str())
                        == Some("trusted")
                })
                .map(|(key, _)| PathBuf::from(key))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use std::collections::HashMap;

    fn env(home: &Path, vars: &[(&str, &str)]) -> Env {
        Env {
            apps: Vec::new(),
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
    /// 目录已存在的那批目标（表格的列）
    fn existing(ts: Vec<Target>) -> Vec<Target> {
        ts.into_iter().filter(|t| t.exists).collect()
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
        // 公开表的条数；内部版还会多出增量表里的条目
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

    #[cfg(feature = "weiboap")]
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

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn shown(installed: &[String], settings: &Settings) -> Vec<String> {
        installed
            .iter()
            .filter(|id| !settings.disabled_harnesses.contains(id))
            .cloned()
            .collect()
    }

    #[test]
    fn new_user_shows_first_four_installed_in_table_order() {
        let installed = ids(&[
            "claude-code",
            "codex",
            "cursor",
            "cline",
            "gemini-cli",
            "amp",
        ]);
        let mut settings = Settings::default();
        assert!(reconcile_shown(&installed, &mut settings));
        assert_eq!(
            shown(&installed, &settings),
            ids(&["claude-code", "codex", "cursor", "cline"])
        );
        assert_eq!(settings.disabled_harnesses, ids(&["gemini-cli", "amp"]));
        assert_eq!(settings.known_installed, installed);
        // 再整理一次不动
        assert!(!reconcile_shown(&installed, &mut settings));
    }

    #[test]
    fn old_data_over_four_keeps_first_four_and_hides_the_rest() {
        // 升级上来：没有 known_installed，已显示 6 个，其中 codex 早被用户关掉
        let installed = ids(&[
            "claude-code",
            "codex",
            "cursor",
            "cline",
            "gemini-cli",
            "github-copilot",
            "amp",
        ]);
        let mut settings = Settings {
            disabled_harnesses: ids(&["codex"]),
            ..Default::default()
        };
        assert!(reconcile_shown(&installed, &mut settings));
        assert_eq!(
            shown(&installed, &settings),
            ids(&["claude-code", "cursor", "cline", "gemini-cli"])
        );
        assert_eq!(
            settings.disabled_harnesses,
            ids(&["codex", "github-copilot", "amp"])
        );
    }

    #[test]
    fn old_data_within_four_is_left_alone() {
        let installed = ids(&["claude-code", "codex", "cursor", "cline"]);
        let mut settings = Settings {
            disabled_harnesses: ids(&["cline"]),
            ..Default::default()
        };
        reconcile_shown(&installed, &mut settings);
        assert_eq!(
            shown(&installed, &settings),
            ids(&["claude-code", "codex", "cursor"])
        );
        assert_eq!(settings.disabled_harnesses, ids(&["cline"]));
    }

    #[test]
    fn newly_installed_appears_only_while_under_four() {
        let mut settings = Settings::default();
        let three = ids(&["claude-code", "codex", "cline"]);
        reconcile_shown(&three, &mut settings);
        // 不满 4 个：新装的 cursor 自动出现
        let four = ids(&["claude-code", "codex", "cursor", "cline"]);
        assert!(reconcile_shown(&four, &mut settings));
        assert_eq!(shown(&four, &settings), four);
        // 已满：新装的 amp 排在表的前面也不挤掉已显示的，记进不显示名单
        let five = ids(&["claude-code", "codex", "cursor", "amp", "cline"]);
        assert!(reconcile_shown(&five, &mut settings));
        assert_eq!(shown(&five, &settings), four);
        assert_eq!(settings.disabled_harnesses, ids(&["amp"]));
    }

    #[test]
    fn uninstalled_then_reinstalled_counts_as_new() {
        let mut settings = Settings::default();
        let four = ids(&["claude-code", "codex", "cursor", "cline"]);
        reconcile_shown(&four, &mut settings);
        // 卸掉 cursor：不再算已知
        let three = ids(&["claude-code", "codex", "cline"]);
        reconcile_shown(&three, &mut settings);
        assert_eq!(settings.known_installed, three);
        // 这期间用户勾上了 gemini-cli，满 4 个
        let with_gemini = ids(&["claude-code", "codex", "cline", "gemini-cli"]);
        reconcile_shown(&with_gemini, &mut settings);
        // cursor 重装：已满，不自动出现
        let all = ids(&["claude-code", "codex", "cursor", "cline", "gemini-cli"]);
        reconcile_shown(&all, &mut settings);
        assert_eq!(shown(&all, &settings), with_gemini);
    }

    /// 2026-10-07：不显示名单只对已安装的有意义。早先误判成已安装、因超上限被记进名单的
    /// （Orca 写的 hooks，#173 已修），判回未安装后要清出名单，不留「装上后也不显示」
    #[test]
    fn uninstalled_ids_are_cleared_from_the_hidden_list() {
        let installed = ids(&["claude-code", "codex", "cursor", "cline", "amp"]);
        let mut settings = Settings::default();
        reconcile_shown(&installed, &mut settings);
        assert_eq!(settings.disabled_harnesses, ids(&["amp"]));
        // 误判纠正：amp 其实没装
        let real = ids(&["claude-code", "codex", "cursor", "cline"]);
        assert!(reconcile_shown(&real, &mut settings));
        assert!(settings.disabled_harnesses.is_empty());
        assert!(!reconcile_shown(&real, &mut settings));
    }

    #[test]
    fn unchecked_installed_agent_stays_hidden() {
        let installed = ids(&["claude-code", "codex", "cursor"]);
        let mut settings = Settings::default();
        reconcile_shown(&installed, &mut settings);
        set_shown(&installed, &mut settings, "codex", false).unwrap();
        assert!(!reconcile_shown(&installed, &mut settings));
        assert_eq!(settings.disabled_harnesses, ids(&["codex"]));
    }

    #[test]
    fn hand_edited_known_list_over_four_is_trimmed_in_table_order() {
        let installed = ids(&["claude-code", "codex", "cursor", "cline", "amp"]);
        let mut settings = Settings {
            known_installed: installed.clone(),
            ..Default::default()
        };
        assert!(reconcile_shown(&installed, &mut settings));
        assert_eq!(shown(&installed, &settings).len(), MAX_SHOWN);
        assert_eq!(settings.disabled_harnesses, ids(&["amp"]));
    }

    #[test]
    fn set_shown_refuses_a_fifth_and_allows_after_unchecking_one() {
        let installed = ids(&["claude-code", "codex", "cursor", "cline", "amp"]);
        let mut settings = Settings::default();
        reconcile_shown(&installed, &mut settings);
        let before = settings.clone();
        let refused = set_shown(&installed, &mut settings, "amp", true);
        assert_eq!(refused, Err(ShownLimitReached));
        assert_eq!(
            refused.unwrap_err().to_string(),
            "最多显示 4 个，先取消一个"
        );
        assert_eq!(settings, before);
        // 勾一个已显示的：不算加一个
        set_shown(&installed, &mut settings, "codex", true).unwrap();
        assert_eq!(settings, before);
        // 取消一个再勾
        set_shown(&installed, &mut settings, "codex", false).unwrap();
        set_shown(&installed, &mut settings, "amp", true).unwrap();
        assert_eq!(
            shown(&installed, &settings),
            ids(&["claude-code", "cursor", "cline", "amp"])
        );
    }

    /// 取消勾选后卸载、再装回：名单里已经没有它，按新装算——显示不满上限就出现
    #[test]
    fn hidden_then_uninstalled_then_reinstalled_appears_while_under_four() {
        let installed = ids(&["claude-code", "codex", "cursor"]);
        let mut settings = Settings::default();
        reconcile_shown(&installed, &mut settings);
        set_shown(&installed, &mut settings, "cursor", false).unwrap();
        let without = ids(&["claude-code", "codex"]);
        reconcile_shown(&without, &mut settings);
        assert!(settings.disabled_harnesses.is_empty());
        reconcile_shown(&installed, &mut settings);
        assert_eq!(shown(&installed, &settings), installed);
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
        t.file(&home.join(".cursor"), "argv.json"); // agent 自己的文件 → 已安装
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

    /// Orca 一类工具给没装的 agent 也写 hooks / plugins（2026-10-06 真机：9 个里 7 个是这样来的）
    #[test]
    fn installed_ignores_hooks_and_plugins_written_by_other_tools() {
        let t = TempTree::new();
        let home = t.root();
        let write = |rel: &str, text: &str| {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let hooks = r#"{"hooks":{"stop":[]}}"#;
        write(".cursor/hooks.json", hooks);
        write(".cursor/hooks.json.bak", hooks);
        t.dir(".cursor/skills");
        write(".factory/settings.json", hooks);
        write(".factory/settings.json.bak", hooks);
        write(".gemini/config/hooks.json", hooks);
        write(".gemini/settings.json", hooks);
        write(".copilot/hooks/orca.json", hooks);
        write(".config/amp/plugins/status.ts", "x");
        write(".config/opencode/plugins/status.js", "x");
        write(
            ".config/opencode/tui.json",
            r#"{"plugin":["file:///x/tui.js"]}"#,
        );
        // 真装过的：agent 自己的配置里除了 hooks 还有别的、或有自己的文件
        write(".commandcode/settings.json", r#"{"hooks":{},"model":"m"}"#);
        write(".kiro/settings/cli.json", "{}");
        let e = env(&home, &[]);
        let ids: Vec<String> = installed(&e).into_iter().map(|h| h.id).collect();
        assert_eq!(ids, s(&["command-code", "kiro-cli"]));
    }

    /// Orca 给 Kimi Code 写的是 TOML 的 `[[hooks]]`；撤掉时留下 `.bak`、把原文件改回空
    /// （2026-10-07 真机：`~/.kimi-code` 只有 0 字节的 `config.toml` 与 `config.toml.bak`）
    #[test]
    fn installed_ignores_toml_hooks_and_files_emptied_beside_a_backup() {
        let t = TempTree::new();
        let home = t.root();
        let write = |rel: &str, text: &str| {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        let hooks = "[[hooks]]\nevent = \"Stop\"\ncommand = \"orca-hook\"\n";
        write(".kimi-code/config.toml", "");
        write(".kimi-code/config.toml.bak", hooks);
        write(".kimi/config.toml", hooks);
        write(".factory/settings.json", "{}\n");
        write(".factory/settings.json.bak", r#"{"hooks":{"stop":[]}}"#);
        let e = env(&home, &[]);
        assert_eq!(installed_ids(&e), Vec::<String>::new());

        // 真装过的：TOML 里除了 hooks 还有自己的设置；空配置旁边没有备份；备份里有 agent 自己的设置
        write(
            ".kimi/config.toml",
            &format!("default_model = \"k2\"\n{hooks}"),
        );
        write(".kiro/settings/cli.json", "{}");
        write(".qwen/settings.json", "");
        write(".continue/config.json", "{}");
        write(".continue/config.json.bak", r#"{"models":[]}"#);
        assert_eq!(
            installed_ids(&e),
            s(&["kimi-cli", "continue", "kiro-cli", "qwen-code"])
        );
    }

    fn installed_ids(e: &Env) -> Vec<String> {
        installed(e).into_iter().map(|h| h.id).collect()
    }

    /// 改过目录的 agent（2026-10-06 核对）：列落在新目录上，项目级跟着走
    #[test]
    fn moved_agents_resolve_to_their_current_dirs() {
        let home = Path::new("/home/u");
        let all = all_harnesses(&env(home, &[]));
        let get = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        // Antigravity 官方文档：全局 ~/.gemini/config/skills，项目 .agents/skills
        let ag = get("antigravity");
        assert_eq!(ag.global_dir, Some(home.join(".gemini/config/skills")));
        assert_eq!(ag.project_dir.as_deref(), Some(".agents/skills"));
        assert!(ag.universal);
        // Zencoder 文档与 Kimi Code CLI 2.x 都读 ~/.agents/skills，和 Cline 一样直接读通用仓库
        for id in ["zencoder", "kimi-cli"] {
            let h = get(id);
            assert_eq!(h.global_dir, Some(home.join(".agents/skills")), "{id}");
            assert_eq!(h.project_dir.as_deref(), Some(".agents/skills"), "{id}");
            assert!(h.universal, "{id}");
        }
        // Mux 改名 Xum：项目元数据以 .xum 为准，.mux 只是读的兜底
        assert_eq!(get("mux").project_dir.as_deref(), Some(".xum/skills"));
        let rooted = all_harnesses(&env(home, &[("XUM_ROOT", "/x"), ("MUX_ROOT", "/m")]));
        let mux = rooted.iter().find(|h| h.id == "mux").unwrap();
        assert_eq!(mux.global_dir, Some(PathBuf::from("/x/skills")));
    }

    /// Xum 启动时把 ~/.mux 搬到 ~/.xum、原处留软链（新装也建）；没升级的老 Mux 只有 ~/.mux。
    /// 全局列写 ~/.mux/skills，两种人都落在各自真正在用的目录，不会凭空建出 ~/.xum
    /// 让老 Mux 升级后把它当成主目录
    #[test]
    fn mux_dir_follows_the_xum_alias_and_old_installs_alike() {
        let t = TempTree::new();
        let home = t.root();
        let xum = t.dir(".xum/skills");
        t.file(&home.join(".xum"), "config.json");
        t.link(&home.join(".mux"), &home.join(".xum"));
        let e = env(&home, &[]);
        let mux = installed(&e).into_iter().find(|h| h.id == "mux");
        assert_eq!(mux.and_then(|h| h.global_dir), Some(xum));

        let t = TempTree::new();
        let home = t.root();
        t.dir(".mux");
        t.file(&home.join(".mux"), "config.json");
        let e = env(&home, &[]);
        let mux = installed(&e).into_iter().find(|h| h.id == "mux");
        assert_eq!(
            mux.and_then(|h| h.global_dir),
            Some(home.join(".mux/skills"))
        );
    }

    /// 探测目录任一个像装过就算：Kimi Code CLI 新装只有 ~/.kimi-code，老 Python 版只有 ~/.kimi
    #[test]
    fn any_detect_candidate_counts_as_installed() {
        for dir in [".kimi-code", ".kimi"] {
            let t = TempTree::new();
            let home = t.root();
            t.file(&t.dir(dir), "config.toml");
            assert!(
                installed_ids(&env(&home, &[])).contains(&"kimi-cli".to_string()),
                "{dir}"
            );
        }
        // KIMI_CODE_HOME 指到别处也认
        let t = TempTree::new();
        let home = t.root();
        let custom = t.dir("elsewhere/kimi");
        t.file(&custom, "config.toml");
        let e = env(&home, &[("KIMI_CODE_HOME", custom.to_str().unwrap())]);
        assert!(installed_ids(&e).contains(&"kimi-cli".to_string()));
        // 都没有：未安装
        let t = TempTree::new();
        assert!(!installed_ids(&env(&t.root(), &[])).contains(&"kimi-cli".to_string()));
    }

    /// 只装 Kimi 桌面版的人没有 ~/.kimi-code：放应用的文件夹里有 Kimi.app（com.moonshot.kimichat）也算装了 Kimi；
    /// 同名但 bundle id 不对的不算
    #[test]
    fn kimi_desktop_app_counts_as_installed() {
        let t = TempTree::new();
        let home = t.root();
        let apps = t.dir("Applications");
        let contents = t.dir("Applications/Kimi.app/Contents");
        let plist = |id: &str| {
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{id}</string></dict></plist>"#
            )
        };
        let e = Env {
            apps: vec![apps],
            ..env(&home, &[])
        };
        std::fs::write(contents.join("Info.plist"), plist("com.example.kimi")).unwrap();
        assert!(!installed_ids(&e).contains(&"kimi-cli".to_string()));
        std::fs::write(contents.join("Info.plist"), plist("com.moonshot.kimichat")).unwrap();
        assert_eq!(installed_ids(&e), s(&["kimi-cli"]));
        let kimi = all_harnesses(&e).into_iter().find(|h| h.id == "kimi-cli");
        assert_eq!(kimi.map(|h| h.display_name), Some("Kimi".to_string()));
    }

    /// npx skills 还在往旧目录建空壳（~/.gemini/antigravity/skills、~/.zencoder/skills）：
    /// 旧目录留在 global_dir 的候选里，这样的空壳仍不算装过
    #[test]
    fn shells_at_old_skill_dirs_do_not_count_as_installed() {
        let t = TempTree::new();
        let home = t.root();
        t.dir(".gemini/antigravity/skills/pdf");
        t.dir(".zencoder/skills/pdf");
        let e = env(&home, &[]);
        let ids = installed_ids(&e);
        assert!(!ids.contains(&"antigravity".to_string()));
        assert!(!ids.contains(&"zencoder".to_string()));

        t.file(&t.dir(".gemini/antigravity/brain"), "task.md");
        t.file(&home.join(".zencoder"), "settings.json");
        let ids = installed_ids(&e);
        assert!(ids.contains(&"antigravity".to_string()));
        assert!(ids.contains(&"zencoder".to_string()));
    }

    #[test]
    fn project_candidates_from_claude_json_then_filter() {
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
        let got = project_candidates(&e, &harnesses);
        // 自动检测只读 agent 的记录：手动选的目录（projects.json 里的）由 `projects` 并入，不在这里
        assert!(!got.contains(&manual));
        let mut want = vec![good, uni];
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
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![real]);
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

    #[cfg(feature = "weiboap")]
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
        assert!(project_candidates(&e, &hs).is_empty());

        let got: Vec<(String, String, PathBuf, TargetScope)> = existing(targets(&e, &hs, &[], &[]))
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

    #[cfg(feature = "weiboap")]
    #[test]
    fn managed_global_dir_is_a_source_but_never_a_target() {
        let t = TempTree::new();
        let home = t.root();
        // weiboap 的托管目录：有真实 skill
        let custom =
            t.dir("Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom");
        t.skill("Library/Application Support/WeiboAP/claude-code-plugins-custom/skills/custom/official-a");
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
        let tgts = existing(targets(&e, &hs, &[], &srcs));
        assert!(
            tgts.iter().all(|x| x.path != custom),
            "托管目录不得成为目标"
        );
    }

    /// AC12：能读到 agents.db 时域名与本体位置名用助手名
    #[cfg(feature = "weiboap")]
    #[test]
    fn agent_names_come_from_the_harness_own_database() {
        let t = TempTree::new();
        let home = t.root();
        let wap = t.dir("Library/Application Support/WeiboAP");
        let dir = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1776/.internal-plugins/skills",
        );
        t.skill(
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
        let labels: Vec<Option<String>> = existing(targets(&e, &hs, &[], &srcs))
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
    #[cfg(feature = "weiboap")]
    #[test]
    fn missing_or_broken_agent_database_falls_back_to_the_directory_name() {
        let t = TempTree::new();
        let home = t.root();
        let wap = t.dir("Library/Application Support/WeiboAP");
        t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills");
        t.skill(
            "Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills/x",
        );
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

    // 用 weiboap 的 agent_dirs 做夹具，跟着内部版 feature 走
    #[cfg(feature = "weiboap")]
    #[test]
    fn sources_cover_every_kind_and_skip_empty_locations() {
        let t = TempTree::new();
        let home = t.root();
        t.skill(".agents/skills/uni-skill");
        t.skill(".claude/skills/claude-skill");
        t.dir(".codex/skills"); // 没有 skill → 不产出
        let agent_root = t.dir("Library/Application Support/WeiboAP/Data/agents/agent_1");
        let agent_dir = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills",
        );
        t.skill("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills/agent-skill");
        let project = t.dir("Project/app");
        t.skill("Project/app/.agents/skills/proj-skill");
        let manual = t.dir("Manual/box");
        t.skill("Manual/box/manual-skill");
        t.skill("Manual/box/.hidden"); // 隐藏目录不是 skill
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
                    "~/.agents".to_string(),
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
                    "app/.agents".to_string(),
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
        let outside = t.skill("Applications/ego-skills/ego-browser");
        let store = t.dir(".agents/skills");
        t.skill(".agents/skills/real-skill");
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
                description: None,
            }]
        );
    }

    // 用 weiboap 的 agent_dirs 做夹具，跟着内部版 feature 走
    #[cfg(feature = "weiboap")]
    #[test]
    fn store_sources_never_count_links_as_their_own_skills() {
        let t = TempTree::new();
        let home = t.root();
        let agent_dir = t.dir(
            "Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills",
        );
        let agent_skill = t.skill("Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills/agent-skill");
        let outside = t.skill("Applications/ego-skills/ego-browser");
        let project = t.dir("Project/app");
        let store = t.dir("Project/app/.agents/skills");
        t.skill("Project/app/.agents/skills/own");
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

    /// 外部来源的标签是用户认得的名字：应用包取应用名，其余取最后一级目录名
    #[test]
    fn external_label_prefers_the_app_bundle_name() {
        let cases = [
            (
                "/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.5.0.32/Resources/ego-skills",
                "ego lite",
            ),
            ("/Applications/Foo.app/Contents/Resources/skills", "Foo"),
            ("/Users/me/.local/share/ego/ego-skills", "ego-skills"),
            // 末尾是「skills」这类泛称时往上取：三个外部目录都叫 skills 就分不清了
            ("/Users/me/.local/share/ego/skills", "ego"),
            (
                "/Users/me/Library/Application Support/WeiboAP/Data/agents/agent_1/.internal-plugins/skills",
                "WeiboAP",
            ),
            // `.application` 不是应用包，不能被字符串匹配骗到；末尾泛称往上取到 my.application
            ("/x/my.application/skills", "my.application"),
        ];
        for (path, want) in cases {
            assert_eq!(external_label(Path::new(path)), want, "{path}");
        }
    }

    #[test]
    fn location_counts_only_directories_with_skill_md_as_skills() {
        let t = TempTree::new();
        let home = t.root();
        let claude = t.dir(".claude/skills");
        let mine = t.skill(".claude/skills/mine");
        // 同步工具留下的文件夹：有内容，但没有 SKILL.md → 不是 skill
        let synced = t.dir(".claude/skills/synced");
        t.file(&synced, "state.json");
        t.skill(".claude/skills/synced/nested");
        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let hs = vec![all.iter().find(|h| h.id == "claude-code").unwrap().clone()];
        let got = sources(&e, &hs, &[], &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, claude);
        assert_eq!(
            got[0].skills,
            vec![Skill {
                name: "mine".into(),
                path: mine,
                description: None,
            }]
        );
    }

    #[test]
    fn external_sources_group_outside_links_by_their_real_parent() {
        let t = TempTree::new();
        let home = t.dir("h");
        // 不在应用包里 → label 用最后一级目录名；两条链接同父目录 → 合并成一处
        let ego = t.dir("opt/ego-skills");
        let browser = t.skill("opt/ego-skills/ego-browser");
        let writer = t.skill("opt/ego-skills/ego-writer");
        // home 下也一样取目录名，不用 ~ 缩写
        let pack = t.dir("h/Applications/pack");
        let far = t.skill("h/Applications/pack/far-skill");
        let store = t.dir("h/.agents/skills");
        let own = t.skill("h/.agents/skills/own");

        let claude = t.dir("h/.claude/skills");
        t.link(&claude.join("ego-browser"), &browser);
        t.link(&claude.join("ego-writer"), &writer);
        t.link(&claude.join("far-skill"), &far);
        t.link(&claude.join("own"), &own); // 指向已知本体位置 → 不合成
        t.link(&claude.join("rotten"), &home.join("gone")); // 坏链 → 不合成
        t.file(&claude, "notes.md"); // 真实文件 → 不合成
                                     // 指向不带 SKILL.md 的目录（同步工具的文件夹之类）→ 不是 skill，不合成
        let not_skill = t.dir("opt/sync-bucket");
        t.link(&claude.join("synced"), &not_skill);

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
                    label: "pack".to_string(),
                    skills: vec![Skill {
                        name: "far-skill".into(),
                        path: far,
                        description: None,
                    }],
                },
                Source {
                    id: ego.display().to_string(),
                    path: ego.clone(),
                    kind: SourceKind::External,
                    label: "ego-skills".to_string(),
                    skills: vec![
                        Skill {
                            name: "ego-browser".into(),
                            path: browser,
                            description: None,
                        },
                        Skill {
                            name: "ego-writer".into(),
                            path: writer,
                            description: None,
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
        t.skill("opt/ego-skills/ego-browser");
        let outside = t.skill("opt/other/far-skill");
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
        let tgts = existing(targets(&e, &hs, std::slice::from_ref(&proj), &known));
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
        t.skill(".agents/skills/uni-skill");
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
        let all_targets = targets(&e, &hs, std::slice::from_ref(&project), &[]);
        // Cursor 的全局目录不存在：仍在返回集合里，只是 exists == false，不成列
        assert!(all_targets
            .iter()
            .any(|x| x.id == "cursor" && !x.exists && x.path == home.join(".cursor/skills")));
        let key = project.display();
        let got: Vec<(String, String, PathBuf, TargetScope)> = existing(all_targets)
            .into_iter()
            .map(|x| (x.id, x.label, x.path, x.scope))
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
                    home.join(".claude/skills"),
                    TargetScope::Global {
                        harness_id: "claude-code".into()
                    },
                ),
                (
                    "cline".to_string(),
                    "Cline".to_string(),
                    home.join(".agents/skills"),
                    TargetScope::Global {
                        harness_id: "cline".into()
                    },
                ),
                (
                    format!("project:{key}::claude-code"),
                    "Claude Code".to_string(),
                    project.join(".claude/skills"),
                    proj("claude-code"),
                ),
                (
                    format!("project:{key}::codex"),
                    "Codex".to_string(),
                    project.join(".agents/skills"),
                    proj("codex"),
                ),
                (
                    format!("project:{key}::cursor"),
                    "Cursor".to_string(),
                    project.join(".agents/skills"),
                    proj("cursor"),
                ),
                (
                    format!("project:{key}::cline"),
                    "Cline".to_string(),
                    project.join(".agents/skills"),
                    proj("cline"),
                ),
            ]
        );
    }

    /// AC1 / AC6：目录不存在的目标照常产出，只标 `exists == false`；目录建出来后下一轮正常成列
    #[test]
    fn targets_keep_dirs_that_do_not_exist_yet_and_pick_them_up_once_created() {
        let t = TempTree::new();
        let home = t.root();
        let project = t.dir("Project/app");
        t.dir("Project/app/.claude/skills"); // 只有 Claude Code 的项目目录
        let e = env(&home, &[]);
        let all = all_harnesses(&e);
        let pick = |id: &str| all.iter().find(|h| h.id == id).unwrap().clone();
        let hs = vec![pick("claude-code"), pick("codex")];
        let key = project.display();
        let find = |ts: &[Target], id: &str| {
            ts.iter()
                .find(|x| x.id == id)
                .unwrap_or_else(|| panic!("没有目标 {id}"))
                .clone()
        };

        let got = targets(&e, &hs, std::slice::from_ref(&project), &[]);
        assert!(find(&got, &format!("project:{key}::claude-code")).exists);
        let codex = find(&got, &format!("project:{key}::codex"));
        assert!(!codex.exists, "项目里没有 .agents/skills");
        assert_eq!(codex.path, project.join(".agents/skills"));
        assert_eq!(codex.linked_whole_to, None);
        // 全局目录不存在同理
        assert!(!find(&got, "claude-code").exists);
        assert!(!find(&got, "codex").exists);
        // 判存不许把目录建出来
        assert_eq!(
            entry_kind(&project.join(".agents/skills")),
            EntryKind::Missing
        );

        // 目录建出来 → 下一轮成为正常的列
        t.dir("Project/app/.agents/skills");
        let got = targets(&e, &hs, std::slice::from_ref(&project), &[]);
        assert!(find(&got, &format!("project:{key}::codex")).exists);
        assert!(existing(got)
            .iter()
            .any(|x| x.path == project.join(".agents/skills")));
    }

    #[test]
    fn target_that_is_a_whole_dir_symlink_points_back_at_the_source() {
        let t = TempTree::new();
        let home = t.root();
        let store = t.dir("Store/skills");
        t.skill("Store/skills/a-skill");
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
        let got = existing(targets(&e, &hs, std::slice::from_ref(&project), &srcs));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
        // 普通目录目标不带整目录链接标记
        t.dir("Project/app/.agents/skills");
        let got = existing(targets(&e, &hs, &[project], &srcs));
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
        t.skill("Store/skills/a-skill");
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

        let got = existing(targets(&e, &hs, std::slice::from_ref(&project), &srcs));
        let key = project.display();
        assert_eq!(got.len(), 2);
        // 同一个目录两列，id 与列名各自属于自己的 harness，标签不合并
        assert_eq!(got[0].id, format!("project:{key}::codex"));
        assert_eq!(got[0].label, "Codex");
        assert_eq!(got[1].id, format!("project:{key}::cursor"));
        assert_eq!(got[1].label, "Cursor");
        // 两列都指向同一个目录，各自都算整目录链接
        for x in &got {
            assert_eq!(x.path, project.join(".agents/skills"));
            assert_eq!(x.linked_whole_to.as_deref(), Some(srcs[0].id.as_str()));
        }
    }

    // 用 weiboap 的 agent_dirs 做夹具，跟着内部版 feature 走
    #[cfg(feature = "weiboap")]
    #[test]
    fn agent_dir_and_the_project_symlink_pointing_at_it_stay_two_columns() {
        let t = TempTree::new();
        let home = t.root();
        let weiboap = "Library/Application Support/WeiboAP";
        let agent_root = t.dir(&format!("{weiboap}/Data/agents/agent_1"));
        let agent_dir = t.dir(&format!(
            "{weiboap}/Data/agents/agent_1/.internal-plugins/skills"
        ));
        t.skill(&format!(
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

        let got = existing(targets(&e, &hs, std::slice::from_ref(&project), &srcs));
        assert_eq!(got.len(), 2);
        // agent 目标：本体所在，不是整目录链接
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
        let got = existing(targets(&e, &hs, &[], &srcs));
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
    fn broken_claude_json_gives_no_projects() {
        let t = TempTree::new();
        let home = t.root();
        std::fs::write(home.join(".claude.json"), "{not json").unwrap();
        t.dir("m/.claude/skills");
        let e = env(&home, &[]);
        assert!(project_candidates(&e, &all_harnesses(&e)).is_empty());
    }

    // ===== 项目来源：Codex 的信任项目（spec 2026-10-05-skill-mcp-batch2「项目来源」，ADR 0001）=====

    /// 写 `<dir>/config.toml`，`[projects.*]` 的键用字面量字符串（单引号，不转义）
    fn codex_config(dir: &Path, projects: &[&Path]) {
        std::fs::create_dir_all(dir).unwrap();
        let mut text = String::from("model = \"gpt-5\"\n");
        for p in projects {
            text.push_str(&format!(
                "\n[projects.'{}']\ntrust_level = \"trusted\"\n",
                p.display()
            ));
        }
        std::fs::write(dir.join("config.toml"), text).unwrap();
    }

    #[test]
    fn codex_trusted_projects_alone_are_projects() {
        let t = TempTree::new();
        let home = t.root();
        let a = t.dir("Code/a");
        t.dir("Code/a/.agents/skills");
        let b = t.dir("Code/b b"); // 路径带空格
        t.dir("Code/b b/.claude/skills");
        codex_config(&home.join(".codex"), &[&a, &b]);
        // 没有 ~/.claude.json
        let e = env(&home, &[]);
        let mut want = vec![a, b];
        want.sort();
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), want);
    }

    #[test]
    fn codex_home_overrides_where_the_config_is_read() {
        let t = TempTree::new();
        let home = t.root();
        let a = t.dir("Code/a");
        t.dir("Code/a/.agents/skills");
        let other = t.dir("Code/other");
        t.dir("Code/other/.agents/skills");
        codex_config(&home.join("runtime"), &[&a]);
        codex_config(&home.join(".codex"), &[&other]); // 设了 CODEX_HOME 就不读这份
        let runtime = home.join("runtime");
        let e = env(&home, &[("CODEX_HOME", runtime.to_str().unwrap())]);
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![a]);
    }

    #[test]
    fn same_dir_recorded_by_both_appears_once() {
        let t = TempTree::new();
        let home = t.root();
        let a = t.dir("Code/a");
        t.dir("Code/a/.agents/skills");
        let b = t.dir("Code/b");
        t.dir("Code/b/.claude/skills");
        // b 经软链记进 Codex：解析后同一处，仍只出一次，留 Claude Code 记的那个写法
        t.dir("Links");
        let link = home.join("Links/b");
        t.link(&link, &b);
        let json = format!(
            "{{\"projects\":{{\"{}\":{{}},\"{}\":{{}}}}}}",
            a.display(),
            b.display()
        );
        std::fs::write(home.join(".claude.json"), json).unwrap();
        // 同一个 a 再带一个尾斜杠
        let a_slash = PathBuf::from(format!("{}/", a.display()));
        codex_config(&home.join(".codex"), &[&a, &a_slash, &link]);
        let e = env(&home, &[]);
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![a, b]);
    }

    #[test]
    fn codex_records_go_through_the_same_noise_filter() {
        let t = TempTree::new();
        let home = t.root();
        let good = t.dir("Code/good");
        t.dir("Code/good/.agents/skills");
        let bare = t.dir("Code/bare"); // 没有 skill 目录
        let gone = home.join("Code/gone"); // 不存在
        t.dir(".codex/skills"); // 主目录下的隐藏目录
        let hidden = home.join(".codex");
        let root = PathBuf::from("/");
        let relative = PathBuf::from("Code/good"); // 相对路径不算
                                                   // 主目录下的隐藏软链指向别处的真目录：照样是工具配置，不是项目
        let tool_data = t.dir("Volumes/ToolData");
        t.dir("Volumes/ToolData/.agents/skills");
        let hidden_link = home.join(".tool");
        t.link(&hidden_link, &tool_data);
        std::fs::create_dir_all(home.join(".agents/skills")).unwrap(); // 让主目录本身也像项目
        codex_config(
            &home.join(".codex"),
            &[
                &good,
                &bare,
                &gone,
                &hidden,
                &home,
                &root,
                &relative,
                &hidden_link,
            ],
        );
        let e = env(&home, &[]);
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![good]);
    }

    #[test]
    fn codex_keys_in_every_toml_spelling_are_read() {
        let t = TempTree::new();
        let home = t.root();
        // Windows 的文件名不能含双引号，那里只验反斜杠的转义
        let basic = t.dir(if cfg!(windows) {
            "Code/basic"
        } else {
            "Code/q\"uote"
        });
        std::fs::create_dir_all(basic.join(".agents/skills")).unwrap();
        let inline = t.dir("Code/inline");
        t.dir("Code/inline/.agents/skills");
        // 基本字符串里的引号、反斜杠要转义；`[projects]` 下也可以逐行写内联表
        let text = format!(
            "[projects]\n\"{}\" = {{ trust_level = \"trusted\" }}\n'{}' = {{ trust_level = \"trusted\" }}\n",
            basic
                .display()
                .to_string()
                .replace('\\', "\\\\")
                .replace('"', "\\\""),
            inline.display()
        );
        t.dir(".codex");
        std::fs::write(home.join(".codex/config.toml"), text).unwrap();
        let e = env(&home, &[]);
        let mut want = vec![basic, inline];
        want.sort();
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), want);
    }

    #[test]
    fn only_codex_projects_marked_trusted_count() {
        let t = TempTree::new();
        let home = t.root();
        let mut dirs = Vec::new();
        for name in ["trusted", "untrusted", "missing"] {
            let d = t.dir(&format!("Code/{name}"));
            t.dir(&format!("Code/{name}/.agents/skills"));
            dirs.push(d);
        }
        // untrusted 是用户明确拒绝过的；没有 trust_level 的也不算信任过
        let text = format!(
            "[projects.'{}']\ntrust_level = \"trusted\"\n\n[projects.'{}']\ntrust_level = \"untrusted\"\n\n[projects.'{}']\nnote = \"x\"\n",
            dirs[0].display(),
            dirs[1].display(),
            dirs[2].display()
        );
        t.dir(".codex");
        std::fs::write(home.join(".codex/config.toml"), text).unwrap();
        let e = env(&home, &[]);
        assert_eq!(
            project_candidates(&e, &all_harnesses(&e)),
            vec![dirs[0].clone()]
        );
    }

    #[test]
    fn missing_or_broken_codex_config_leaves_claude_records_alone() {
        let t = TempTree::new();
        let home = t.root();
        let a = t.dir("Code/a");
        t.dir("Code/a/.claude/skills");
        std::fs::write(
            home.join(".claude.json"),
            format!("{{\"projects\":{{\"{}\":{{}}}}}}", a.display()),
        )
        .unwrap();
        let e = env(&home, &[]);
        // config.toml 不存在
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![a.clone()]);
        // config.toml 损坏
        t.dir(".codex");
        std::fs::write(
            home.join(".codex/config.toml"),
            "[projects.\"/x\"\nbroken = ",
        )
        .unwrap();
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![a.clone()]);
        // projects 不是表
        std::fs::write(home.join(".codex/config.toml"), "projects = 3\n").unwrap();
        assert_eq!(project_candidates(&e, &all_harnesses(&e)), vec![a]);
    }

    // ===== 项目来源：手动选的项目与设置「生效范围」（spec 2026-10-05-skill-mcp-batch2「项目来源」，ADR 0001）=====

    /// 在 `~/.claude.json` 里记几个项目
    fn claude_json(home: &Path, projects: &[&Path]) {
        let keys: Vec<String> = projects
            .iter()
            .map(|p| format!("\"{}\":{{}}", p.display()))
            .collect();
        std::fs::write(
            home.join(".claude.json"),
            format!("{{\"projects\":{{{}}}}}", keys.join(",")),
        )
        .unwrap();
    }

    #[test]
    fn manual_projects_join_even_without_a_skill_dir() {
        let t = TempTree::new();
        let home = t.dir("home");
        let auto = t.dir("home/Code/auto");
        t.dir("home/Code/auto/.claude/skills");
        claude_json(&home, &[&auto]);
        // 手动选的空文件夹：没有任何 agent 的 skill 目录，照样是一格
        let empty = t.dir("home/Code/empty");
        // 主目录下的隐藏目录、主目录外的文件夹：手动选的不过这几道去噪
        let hidden = t.dir("home/.work");
        let outside = t.dir("elsewhere/x");
        let e = env(&home, &[]);
        let got = projects(
            &e,
            &all_harnesses(&e),
            &[empty.clone(), hidden.clone(), outside.clone()],
        );
        let mut want = vec![auto, empty, hidden, outside];
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn manual_projects_must_still_exist_and_not_be_home() {
        let t = TempTree::new();
        let home = t.dir("home");
        let kept = t.dir("home/Code/kept");
        let gone = home.join("Code/gone");
        let file = t.file(&home, "notes.txt");
        let e = env(&home, &[]);
        let manual = vec![
            kept.clone(),
            gone,
            file,
            home.clone(),
            PathBuf::from(format!("{}/", home.display())),
            PathBuf::from("/"),
            PathBuf::from("Code/kept"), // 相对路径不算
        ];
        assert_eq!(
            projects(&e, &all_harnesses(&e), &manual),
            vec![kept.clone()]
        );
        // 文件夹删掉了：不再列，也不报错
        std::fs::remove_dir(&kept).unwrap();
        assert!(projects(&e, &all_harnesses(&e), &manual).is_empty());
    }

    #[test]
    fn same_folder_detected_and_added_by_hand_is_one_cell() {
        let t = TempTree::new();
        let home = t.dir("home");
        let a = t.dir("home/Code/a");
        t.dir("home/Code/a/.agents/skills");
        claude_json(&home, &[&a]);
        // 手动又经软链、带尾斜杠各加了一次：解析后同一处，只出一格，留自动检测到的写法
        t.dir("home/Links");
        let link = home.join("Links/a");
        t.link(&link, &a);
        let slash = PathBuf::from(format!("{}/", a.display()));
        let e = env(&home, &[]);
        assert_eq!(
            projects(&e, &all_harnesses(&e), &[link.clone(), slash, a.clone()]),
            vec![a.clone()]
        );
        // 两个手动写法指向同一处：留先加的那个写法
        let b = t.dir("elsewhere/b");
        let b_link = home.join("Links/b");
        t.link(&b_link, &b);
        assert_eq!(
            projects(&e, &all_harnesses(&e), &[b_link.clone(), b.clone()]),
            vec![a, b_link]
        );
    }

    #[test]
    fn unchecked_projects_leave_the_list_by_real_path() {
        let t = TempTree::new();
        let home = t.dir("home");
        let a = t.dir("home/Code/a");
        let b = t.dir("home/Code/b");
        let c = t.dir("home/Code/c");
        t.dir("home/Links");
        let b_link = home.join("Links/b");
        t.link(&b_link, &b);
        let all = vec![a.clone(), b.clone(), c.clone()];
        // 取消勾记的是另一个写法（软链）：照样认得是同一处
        let hidden = vec![b_link, home.join("Code/gone")];
        assert_eq!(
            shown_projects(all.clone(), &hidden),
            vec![a.clone(), c.clone()]
        );
        // 一个都不勾：只剩用户级（项目列表为空）
        assert!(shown_projects(all.clone(), &[a, b, c]).is_empty());
        assert_eq!(shown_projects(all.clone(), &[]), all);
    }

    #[test]
    fn scope_cells_carry_name_path_and_whether_checked() {
        let t = TempTree::new();
        let a = t.dir("Code/a");
        let b = t.dir("Code/b");
        assert_eq!(
            project_scopes(vec![a.clone(), b.clone()], std::slice::from_ref(&b)),
            vec![
                ProjectScope {
                    path: a,
                    name: "a".into(),
                    shown: true
                },
                ProjectScope {
                    path: b,
                    name: "b".into(),
                    shown: false
                },
            ]
        );
    }

    #[test]
    fn checking_and_unchecking_a_project_is_recorded_once() {
        let t = TempTree::new();
        let a = t.dir("Code/a");
        t.dir("Links");
        let link = t.root().join("Links/a");
        t.link(&link, &a);
        let mut settings = Settings::default();
        // 经软链写法取消勾：记的是真实路径，软链以后删了、改了，取消勾照样认得这个文件夹
        assert!(set_project_shown(&mut settings, &link, false));
        assert_eq!(settings.hidden_projects, vec![a.clone()], "记真实路径");
        // 同一处换个写法再取消一次：不重复记
        let slash = PathBuf::from(format!("{}/", a.display()));
        assert!(!set_project_shown(&mut settings, &slash, false));
        assert_eq!(settings.hidden_projects.len(), 1);
        std::fs::remove_file(&link).unwrap();
        assert!(shown_projects(vec![a.clone()], &settings.hidden_projects).is_empty());
        // 勾回来：经哪种写法都认得
        assert!(set_project_shown(&mut settings, &slash, true));
        assert!(settings.hidden_projects.is_empty());
        assert!(!set_project_shown(&mut settings, &a, true));
    }

    #[test]
    fn checking_back_clears_stale_spellings_of_a_gone_folder_too() {
        // 文件夹没了，取消勾的记录还在：同一个写法勾回来照样清掉（比 normalize）
        let mut settings = Settings {
            hidden_projects: vec![PathBuf::from("/nowhere/x")],
            ..Settings::default()
        };
        assert!(set_project_shown(
            &mut settings,
            Path::new("/nowhere/./x/"),
            true
        ));
        assert!(settings.hidden_projects.is_empty());
    }

    #[test]
    fn adding_a_project_checks_it_and_remembers_it_once() {
        let t = TempTree::new();
        let home = t.dir("home");
        let a = t.dir("home/Code/a");
        let e = env(&home, &[]);
        let mut list = Vec::new();
        let mut settings = Settings {
            hidden_projects: vec![a.clone()],
            ..Settings::default()
        };
        let added = add_manual_project(&e, &mut list, &mut settings, &a.join(".")).unwrap();
        assert_eq!(added, a);
        assert_eq!(list, vec![a.clone()]);
        assert!(settings.hidden_projects.is_empty(), "选进来的默认勾上");
        // 再加一次（换写法）：不重复记
        t.dir("home/Links");
        let link = home.join("Links/a");
        t.link(&link, &a);
        add_manual_project(&e, &mut list, &mut settings, &link).unwrap();
        assert_eq!(list, vec![a]);
    }

    #[test]
    fn adding_home_root_or_a_missing_folder_is_refused() {
        let t = TempTree::new();
        let home = t.dir("home");
        let file = t.file(&home, "notes.txt");
        let e = env(&home, &[]);
        let mut list = Vec::new();
        let mut settings = Settings::default();
        for (path, want) in [
            (home.clone(), ManualProjectError::Home),
            (PathBuf::from("/"), ManualProjectError::Home),
            (home.join("gone"), ManualProjectError::NotFolder),
            (file, ManualProjectError::NotFolder),
            (PathBuf::from("Code/a"), ManualProjectError::NotFolder),
        ] {
            assert_eq!(
                add_manual_project(&e, &mut list, &mut settings, &path),
                Err(want),
                "{}",
                path.display()
            );
        }
        assert!(list.is_empty());
        // 原因是给用户看的一句
        assert!(!ManualProjectError::Home.to_string().is_empty());
        assert!(!ManualProjectError::NotFolder.to_string().is_empty());
    }

    // ===== MCP 页的列（spec 2026-09-27-mcp-batch1 R5 R7，skill-mcp-market R17）=====

    /// 在测试 HOME 里把这几家「装上」（探测目录里放一个普通文件，不是只有 skills 的空壳）
    fn install(t: &TempTree, dirs: &[&str]) {
        for dir in dirs {
            t.dir(dir);
            std::fs::write(t.root().join(dir).join("config"), "x").unwrap();
        }
    }

    fn id_list(harnesses: Vec<Harness>) -> Vec<String> {
        harnesses.into_iter().map(|h| h.id).collect()
    }

    /// 只有 macOS 上的测试用它（Linux CI 上不用会报 dead_code）
    #[cfg(target_os = "macos")]
    const DESKTOP_DIR: &str = "Library/Application Support/Claude";

    /// Claude Desktop 只有 MCP：SKILLS 的 agent 表、已安装、设置的名单里都没有它
    #[cfg(target_os = "macos")]
    #[test]
    fn claude_desktop_is_mcp_only() {
        let t = TempTree::new();
        install(&t, &[".claude", ".codex", DESKTOP_DIR]);
        let e = env(&t.root(), &[]);
        assert!(!all_harnesses(&e).iter().any(|h| h.id == "claude-desktop"));
        assert!(!installed(&e).iter().any(|h| h.id == "claude-desktop"));
        let desktop = mcp_columns(&e, &installed(&e))
            .into_iter()
            .find(|h| h.id == "claude-desktop")
            .unwrap();
        assert_eq!(desktop.display_name, "Claude Desktop");
        assert_eq!(desktop.global_dir, None);
        assert_eq!(desktop.project_dir, None);
    }

    /// AC10 AC11：一份名单两页共用——MCP 页的列＝名单里支持 MCP 的（OpenCode 不出），
    /// 再加装了的 Claude Desktop，紧跟 Claude Code、不占名额
    #[cfg(target_os = "macos")]
    #[test]
    fn mcp_columns_are_the_shared_list_with_mcp_plus_claude_desktop() {
        let t = TempTree::new();
        install(
            &t,
            &[
                ".claude",
                ".codex",
                ".cursor",
                ".gemini",
                ".config/opencode",
                DESKTOP_DIR,
            ],
        );
        let e = env(&t.root(), &[]);
        let installed = installed(&e);
        let all = id_list(installed.clone());
        assert_eq!(
            all,
            s(&["claude-code", "codex", "cursor", "opencode", "gemini-cli"])
        );
        // 新用户：名单按表先后取前 4 个（Claude Desktop 不在里面，不占名额）
        let mut settings = Settings::default();
        reconcile_shown(&all, &mut settings);
        assert_eq!(settings.disabled_harnesses, s(&["gemini-cli"]));
        let shown = enabled(installed.clone(), &settings);
        assert_eq!(
            id_list(mcp_columns(&e, &shown)),
            s(&["claude-code", "claude-desktop", "codex", "cursor"])
        );
        // 名单换成 Claude Code、Codex、Cursor、Gemini CLI：MCP 页五格
        set_shown(&all, &mut settings, "opencode", false).unwrap();
        set_shown(&all, &mut settings, "gemini-cli", true).unwrap();
        let shown = enabled(installed.clone(), &settings);
        assert_eq!(
            id_list(mcp_columns(&e, &shown)),
            s(&[
                "claude-code",
                "claude-desktop",
                "codex",
                "cursor",
                "gemini-cli"
            ])
        );
        // 勾满 4 个再勾被拒，名单不动
        let before = settings.clone();
        assert_eq!(
            set_shown(&all, &mut settings, "opencode", true),
            Err(ShownLimitReached)
        );
        assert_eq!(settings, before);
        // Claude Code 不在名单里：Claude Desktop 跟着它，也不出
        set_shown(&all, &mut settings, "claude-code", false).unwrap();
        let shown = enabled(installed, &settings);
        assert_eq!(
            id_list(mcp_columns(&e, &shown)),
            s(&["codex", "cursor", "gemini-cli"])
        );
    }

    /// 没装 Claude Desktop：MCP 页就是名单里支持 MCP 的，与 SKILLS 页同一批
    #[test]
    fn without_claude_desktop_mcp_columns_follow_the_list() {
        let t = TempTree::new();
        install(&t, &[".claude", ".codex", ".cline"]);
        let e = env(&t.root(), &[]);
        let shown = installed(&e);
        assert_eq!(
            id_list(mcp_columns(&e, &shown)),
            s(&["claude-code", "codex"])
        );
    }

    /// `GEMINI_CLI_HOME` / `COPILOT_HOME` 挪了位置，照样算已安装
    #[test]
    fn env_overridden_gemini_and_copilot_count_as_installed() {
        let t = TempTree::new();
        let home = t.dir("home");
        let gemini = t.dir("g/.gemini");
        std::fs::write(gemini.join("settings.json"), "{}").unwrap();
        let copilot = t.dir("c");
        std::fs::write(copilot.join("mcp-config.json"), "{}").unwrap();
        let e = env(
            &home,
            &[
                ("GEMINI_CLI_HOME", t.root().join("g").to_str().unwrap()),
                ("COPILOT_HOME", copilot.to_str().unwrap()),
            ],
        );
        assert_eq!(
            id_list(mcp_columns(&e, &installed(&e))),
            s(&["gemini-cli", "github-copilot"])
        );
    }
}

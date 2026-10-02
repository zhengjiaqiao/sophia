//! 侧栏排序用的项目时间：最近活跃、最近创建。只读文件元数据，每个目录只看一层，不递归
use crate::fs::{normalize, real_path};
use crate::models::Harness;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 一个项目的两种时间，毫秒时间戳；取不到时为 None
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTimes {
    pub path: PathBuf,
    /// 最近一次有 agent 在这个项目里干活：Claude Code 会话记录与项目里各 agent 目录取较晚的；
    /// 都没有时用项目文件夹本身的修改时间
    pub last_active: Option<u64>,
    /// 项目文件夹的创建时间；取不到时用加入 Sophia 的时间，再没有用文件夹修改时间
    pub created: Option<u64>,
}

/// Claude Code 目录名的长度上限：超过时它截到这么长，后面接 `-` 和整条路径的哈希
const CLAUDE_NAME_MAX: usize = 200;

/// MCP 项目配置所在、却不在 `project_dir` 里的 agent 目录（见 `mcp::discover_locations`）
const MCP_AGENT_DIRS: [&str; 2] = [".codex", ".cursor"];

/// Claude Code 在 `~/.claude/projects/` 下给一个项目起的目录名：ASCII 字母数字以外的字符都换成 `-`。
/// 它在 JS 里按 UTF-16 码元替换，所以 BMP 以外的字符（emoji）占两个 `-`。
/// 超过 200 的名字它会截断再接哈希，这里只返回未截断的全名，截断的情形由调用方按前缀找
pub fn claude_dir_name(project: &Path) -> String {
    let mut out = String::new();
    for c in project.to_string_lossy().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

/// 项目在 Claude Code 会话目录下对应的目录（可能不止一个：软链路径与真实路径各算一次；
/// 名字过长被截断时按前 200 个字符找，哈希算法不在我们这边）
pub fn claude_session_dirs(claude_projects: &Path, project: &Path) -> Vec<PathBuf> {
    let mut names = vec![claude_dir_name(&normalize(project))];
    if let Some(real) = real_path(project) {
        let name = claude_dir_name(&real);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let mut out = Vec::new();
    for name in names {
        if name.len() <= CLAUDE_NAME_MAX {
            out.push(claude_projects.join(name));
            continue;
        }
        let prefix = format!("{}-", &name[..CLAUDE_NAME_MAX]);
        let Ok(entries) = std::fs::read_dir(claude_projects) else {
            continue;
        };
        out.extend(
            entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
                .map(|e| e.path()),
        );
    }
    out
}

/// 项目里的 agent 目录名：各 harness `project_dir` 的第一段（`.claude/skills` → `.claude`），
/// 再加上 MCP 用到的 `.codex` `.cursor`；去重，保持先后
pub fn agent_dir_names(harnesses: &[Harness]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let firsts = harnesses.iter().filter_map(|h| {
        let dir = h.project_dir.as_deref()?;
        match Path::new(dir).components().next()? {
            Component::Normal(first) => Some(first.to_string_lossy().into_owned()),
            _ => None,
        }
    });
    for name in firsts.chain(MCP_AGENT_DIRS.iter().map(|s| s.to_string())) {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

fn millis(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// 目录下（一层）最新的**文件**修改时间；子目录与软链不算
fn newest_file(dir: &Path) -> Option<SystemTime> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let meta = std::fs::symlink_metadata(e.path()).ok()?;
            meta.is_file().then(|| meta.modified().ok()).flatten()
        })
        .max()
}

/// 目录自身与它下面一层各条目（不跟随软链）里最新的修改时间；目录不存在为 None
fn newest_in(dir: &Path) -> Option<SystemTime> {
    // 目录本身可以是软链：判断「目标目录是否存在」要跟随软链
    let own = std::fs::metadata(dir)
        .ok()
        .filter(|m| m.is_dir())?
        .modified()
        .ok();
    let children = std::fs::read_dir(dir).ok().into_iter().flat_map(|entries| {
        entries
            .flatten()
            .filter_map(|e| std::fs::symlink_metadata(e.path()).ok()?.modified().ok())
    });
    own.into_iter().chain(children).max()
}

/// 算一个项目的两种时间。`claude_projects` 是 Claude Code 的会话目录（`~/.claude/projects`），
/// `agent_dirs` 见 `agent_dir_names`，`added_at` 是它加入 Sophia 的时间（毫秒，没记录为 None）
pub fn project_times(
    project: &Path,
    claude_projects: &Path,
    agent_dirs: &[String],
    added_at: Option<u64>,
) -> ProjectTimes {
    let folder = std::fs::metadata(project).ok();
    let folder_modified = folder
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(millis);
    let sessions = claude_session_dirs(claude_projects, project)
        .iter()
        .filter_map(|d| newest_file(d))
        .max();
    let agents = agent_dirs
        .iter()
        .filter_map(|name| newest_in(&project.join(name)))
        .max();
    let last_active = sessions.max(agents).and_then(millis).or(folder_modified);
    let created = folder
        .as_ref()
        .and_then(|m| m.created().ok())
        .and_then(millis)
        .or(added_at)
        .or(folder_modified);
    ProjectTimes {
        path: project.to_path_buf(),
        last_active,
        created,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use std::time::Duration;

    /// 把文件或目录的修改时间设成纪元后 `secs` 秒
    fn touch(path: &Path, secs: u64) {
        let file = std::fs::File::open(path).expect("open");
        file.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
            .expect("set_modified");
    }

    fn harness(project_dir: Option<&str>) -> Harness {
        Harness {
            id: "x".into(),
            display_name: "X".into(),
            project_dir: project_dir.map(str::to_string),
            global_dir: None,
            universal: false,
            agent_dirs: Vec::new(),
            managed_global_dir: false,
            agent_labels: None,
        }
    }

    #[test]
    fn dir_name_replaces_every_non_alphanumeric() {
        // 实测 ~/.claude/projects：`.` `_` 空格 `~` 都变 `-`，汉字每个一个 `-`
        assert_eq!(
            claude_dir_name(Path::new("/Users/me/Project/weibo_assistant")),
            "-Users-me-Project-weibo-assistant"
        );
        assert_eq!(
            claude_dir_name(Path::new("/Users/me/.agents/skills")),
            "-Users-me--agents-skills"
        );
        assert_eq!(
            claude_dir_name(Path::new("/a/Mobile Documents/iCloud~md~obsidian")),
            "-a-Mobile-Documents-iCloud-md-obsidian"
        );
        assert_eq!(claude_dir_name(Path::new("/p/项目")), "-p---");
        // BMP 以外按 UTF-16 码元算，占两个
        assert_eq!(claude_dir_name(Path::new("/p/😀")), "-p---");
    }

    #[test]
    fn agent_dirs_take_first_component_and_mcp_dirs() {
        let hs = [
            harness(Some(".claude/skills")),
            harness(Some(".agents/skills")),
            harness(Some(".agents/skills")),
            harness(Some("skills")),
            harness(None),
        ];
        assert_eq!(
            agent_dir_names(&hs),
            [".claude", ".agents", "skills", ".codex", ".cursor"]
        );
    }

    #[test]
    fn last_active_is_later_of_session_and_agent_dirs() {
        let t = TempTree::new();
        let project = t.dir("work/app");
        let claude = t.dir("home/.claude/projects");
        let session = t.dir(&format!(
            "home/.claude/projects/{}",
            claude_dir_name(&project)
        ));
        let f = t.file(&session, "a.jsonl");
        touch(&f, 3_000);
        let old = t.file(&session, "b.jsonl");
        touch(&old, 1_000);
        // 子目录不算「文件」
        let sub = t.dir(&format!(
            "home/.claude/projects/{}/sub",
            claude_dir_name(&project)
        ));
        touch(&sub, 9_000);

        let agents = t.dir("work/app/.claude");
        let settings = t.file(&agents, "settings.json");
        touch(&settings, 2_000);
        touch(&agents, 1_500);
        let dirs = vec![".claude".to_string(), ".codex".to_string()];

        let times = project_times(&project, &claude, &dirs, None);
        assert_eq!(times.last_active, Some(3_000_000));

        // agent 目录里的更晚
        touch(&settings, 5_000);
        let times = project_times(&project, &claude, &dirs, None);
        assert_eq!(times.last_active, Some(5_000_000));
    }

    #[test]
    fn agent_dirs_are_not_scanned_recursively() {
        let t = TempTree::new();
        let project = t.dir("app");
        let claude = t.dir("claude-projects");
        let skills = t.dir("app/.claude/skills");
        let deep = t.file(&skills, "deep.md");
        touch(&deep, 9_000);
        touch(&skills, 2_000);
        touch(&t.root().join("app/.claude"), 1_000);
        let times = project_times(&project, &claude, &[".claude".into()], None);
        assert_eq!(times.last_active, Some(2_000_000));
    }

    #[test]
    fn falls_back_to_folder_mtime_when_no_agent_trace() {
        let t = TempTree::new();
        let project = t.dir("app");
        let claude = t.dir("claude-projects");
        touch(&project, 4_000);
        let times = project_times(&project, &claude, &[".claude".into()], None);
        assert_eq!(times.last_active, Some(4_000_000));
    }

    #[test]
    fn created_prefers_birthtime_then_added_then_mtime() {
        let t = TempTree::new();
        let project = t.dir("app");
        let claude = t.dir("claude-projects");
        let meta = std::fs::metadata(&project).unwrap();
        let times = project_times(&project, &claude, &[], Some(7));
        match meta.created() {
            // 文件系统给得出创建时间（macOS APFS）：用它，不用加入时间
            Ok(born) => assert_eq!(times.created, millis(born)),
            Err(_) => assert_eq!(times.created, Some(7)),
        }
        // 文件夹不见了：只剩加入时间
        let gone = t.root().join("gone");
        assert_eq!(project_times(&gone, &claude, &[], Some(7)).created, Some(7));
        assert_eq!(project_times(&gone, &claude, &[], None).created, None);
        assert_eq!(project_times(&gone, &claude, &[], None).last_active, None);
    }

    #[test]
    fn long_names_match_by_truncated_prefix() {
        let t = TempTree::new();
        let claude = t.dir("claude-projects");
        let long = format!("/p/{}", "a".repeat(250));
        let name = claude_dir_name(Path::new(&long));
        let hashed = t.dir(&format!(
            "claude-projects/{}-abc123",
            &name[..CLAUDE_NAME_MAX]
        ));
        t.dir("claude-projects/unrelated");
        assert_eq!(claude_session_dirs(&claude, Path::new(&long)), vec![hashed]);
    }
}

//! 密钥提醒（spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」）：往项目文件写带密钥的 MCP 时，
//! 只在「密钥第一次暴露进仓库」的情况下打扰用户。
//!
//! - `decide`：纯判断，不碰磁盘。git 事实由调用方探测后传入
//! - `probe` / `in_repo`：在项目目录里问 git（同步子进程）。没装 git、不是仓库都按「不是 git 仓库」
//! - `add_to_gitignore`：目标项目根的 `.gitignore` 末尾追加一行，走 `atomicfile`（备份、原子替换）
//!
//! 四个入口共用：安装页（来源＝市场，按「不在仓库里」：`GitFacts::default()`）、移动 / 复制、MCP 页点格子写入、
//! 来源管理页的自动同步规则
use crate::atomicfile::{self, FileState};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// 一个文件在它所在仓库里的 git 事实。市场、粘贴来的定义不在任何仓库里：`GitFacts::default()`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GitFacts {
    /// 所在目录在 git 工作区里
    pub in_repo: bool,
    /// 文件被跟踪（在索引里，提交过或已暂存）
    pub tracked: bool,
    /// 文件被 `.gitignore` 等规则忽略（被跟踪的文件不算忽略）
    pub ignored: bool,
}

/// 判断的五种结果（spec「密钥提醒（S19）」）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyHint {
    /// 不处理：没有像密钥的值，或目标不是 git 仓库
    #[default]
    Quiet,
    /// 不处理（来源已提交过）：密钥早就在仓库里了，再提醒也收不回，不重复打扰
    SourceCommitted,
    /// 目标加进 `.gitignore` 并在提示条里说：来源被忽略，照搬用户在来源那边的选择
    AutoIgnore,
    /// 灰字提醒「会随仓库提交」加默认不勾的「同时加进 .gitignore」：密钥第一次暴露进仓库
    Remind,
    /// 目标文件已被 git 跟踪：加进 `.gitignore` 也挡不住，不出勾选、不追加，只说一句「已在仓库里，密钥会随下一次
    /// 提交上去」（产品负责人 2026-10-06）
    Tracked,
}

/// 纯判断：`has_key` 定义里有没有像密钥的值（`mcp` 的 `has_key_values`）；`source` 来源文件的 git 事实；
/// `target` 目标文件的 git 事实（`probe` 目标文件）。顺序：目标不在 git 仓库里、或已被现有规则忽略——不会进仓库，
/// 不处理；目标已被跟踪——忽略规则管不住它，不论来源；再往下才看来源
pub fn decide(has_key: bool, source: GitFacts, target: GitFacts) -> KeyHint {
    if !has_key || !target.in_repo || target.ignored {
        KeyHint::Quiet
    } else if target.tracked {
        KeyHint::Tracked
    } else if source.tracked {
        KeyHint::SourceCommitted
    } else if source.ignored {
        KeyHint::AutoIgnore
    } else {
        KeyHint::Remind
    }
}

/// 在 `file` 所在的项目里问 git：是不是仓库、文件是否被跟踪、是否被忽略。`file` 可以还不存在（要写的目标）。
/// 没装 git、不是仓库、git 出错都给 `GitFacts::default()`
pub fn probe(file: &Path) -> GitFacts {
    Git::system().map_or_else(GitFacts::default, |git| git.probe(file))
}

/// 目录 `dir` 在不在 git 工作区里（目标项目是不是 git 仓库）；没装 git 为 false
pub fn in_repo(dir: &Path) -> bool {
    Git::system().is_some_and(|git| git.in_repo(dir))
}

/// 跑哪个 git、要不要隔开本机配置（只有测试隔开）
struct Git {
    program: OsString,
    isolated: bool,
}

impl Git {
    /// 本机的 git。macOS 上 `/usr/bin/git` 只是个壳：没装命令行工具时一跑就弹「安装开发者工具」的系统对话框，
    /// 这时按没装 git（`xcode-select -p` 不弹框）
    fn system() -> Option<Self> {
        #[cfg(target_os = "macos")]
        if !macos_git_usable() {
            return None;
        }
        Some(Self {
            program: "git".into(),
            isolated: false,
        })
    }

    /// 在 `dir` 里跑一次 git；起不来（没装）为 None
    fn run(&self, dir: &Path, args: &[&OsStr]) -> Option<std::process::Output> {
        let mut cmd = Command::new(&self.program);
        cmd.args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .env("GIT_OPTIONAL_LOCKS", "0");
        // 从 git 钩子里拉起时会带着这些，指向别的仓库
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_PREFIX",
        ] {
            cmd.env_remove(var);
        }
        if self.isolated {
            cmd.env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：图形界面里跑子进程不闪黑窗
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output().ok()
    }

    fn in_repo(&self, dir: &Path) -> bool {
        dir.is_dir()
            && self
                .run(
                    dir,
                    &["rev-parse".as_ref(), "--is-inside-work-tree".as_ref()],
                )
                .is_some_and(|out| out.status.success() && out.stdout.trim_ascii() == b"true")
    }

    fn probe(&self, file: &Path) -> GitFacts {
        let Some((dir, rel)) = nearest_dir(file) else {
            return GitFacts::default();
        };
        if !self.in_repo(dir) {
            return GitFacts::default();
        }
        let ok = |args: &[&OsStr]| self.run(dir, args).is_some_and(|out| out.status.success());
        let rel = rel.as_os_str();
        let tracked = ok(&[
            // 路径照字面认，不当通配（文件名里的 `*`、`[`）。`check-ignore` 不收这个选项，它本来就按路径认
            "--literal-pathspecs".as_ref(),
            "ls-files".as_ref(),
            "--error-unmatch".as_ref(),
            "--".as_ref(),
            rel,
        ]);
        // 被跟踪的文件不受忽略规则管（`check-ignore` 默认也不报它们）
        let ignored = !tracked && ok(&["check-ignore".as_ref(), "-q".as_ref(), "--".as_ref(), rel]);
        GitFacts {
            in_repo: true,
            tracked,
            ignored,
        }
    }
}

/// `file` 最近的已有上级目录与 `file` 相对它的路径：要写的目标常在还没建出来的 `.cursor/` 里
fn nearest_dir(file: &Path) -> Option<(&Path, &Path)> {
    file.ancestors()
        .skip(1)
        .find(|dir| dir.is_dir())
        .and_then(|dir| Some((dir, file.strip_prefix(dir).ok()?)))
}

#[cfg(target_os = "macos")]
fn macos_git_usable() -> bool {
    // PATH 里先找到的不是 /usr/bin/git（Homebrew 等）：直接用
    let found = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("git"))
            .find(|git| git.is_file())
    });
    match found {
        None => false,
        Some(git) if git != Path::new("/usr/bin/git") => true,
        Some(_) => Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())
            .is_some_and(|out| {
                let dir = String::from_utf8_lossy(&out.stdout);
                Path::new(dir.trim()).join("usr/bin/git").is_file()
            }),
    }
}

/// `file` 在项目根 `root` 的 `.gitignore` 里写成哪一行，锚在项目根：只有文件名的开头加 `/`（`/.mcp.json`），
/// 不然 git 会连子目录里的同名文件一起忽略；中间已带 `/` 的（`.cursor/mcp.json`）git 本来就按 `.gitignore`
/// 所在目录锚定，保持原样——两种写法效果一样，原样的那种不动用户已经见过、写过的行。
/// 不在 `root` 下、带 `..` 的为 None。确认框与安装页的提示框里列的就是它
pub fn gitignore_line(root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for part in rel.components() {
        match part {
            Component::Normal(name) => parts.push(name.to_string_lossy()),
            _ => return None,
        }
    }
    match parts.len() {
        0 => None,
        1 => Some(format!("/{}", parts[0])),
        _ => Some(parts.join("/")),
    }
}

/// `file` 是不是项目 `root` 里的文件：是就给 `.gitignore` 所在的项目根与那一行。项目根本身是软链接时，
/// 设置文件已换成真实路径（`mcp::resolve_symlinks`），按项目根的真实路径再认一次
pub fn project_line(root: &Path, file: &Path) -> Option<(PathBuf, String)> {
    if let Some(line) = gitignore_line(root, file) {
        return Some((root.to_path_buf(), line));
    }
    let real = crate::fs::real_path(root)?;
    let line = gitignore_line(&real, file)?;
    Some((real, line))
}

/// 一次 `.gitignore` 追加：撤销要用的写前状态、备份与写后状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitignoreEdit {
    pub path: PathBuf,
    /// 写前：`Missing` 表示这次新建了 `.gitignore`，撤销即删掉
    pub before: FileState,
    pub backup: Option<PathBuf>,
    /// 写后立刻读回的状态；读回的不是刚写的（写后瞬间又被别人改了）为 None，这时不给撤销
    pub written: Option<FileState>,
}

/// 在项目根 `root` 的 `.gitignore` 末尾追加 `file` 的那一行（`gitignore_line`）：已有同一行（它后面没有 `!` 行）就不动，
/// 返回 None——开头有没有 `/` 算同一行（`.mcp.json` 与 `/.mcp.json` 都管得住项目根下的那个文件）。
/// 跟随原文件的换行（有 CRLF 的仍用 CRLF），原文件末尾没有换行先补一个；改已有文件前备份进 `backups`。
/// 新建的 `.gitignore` 是 0644：它要提交、给别人看，不用 atomicfile 新文件的 0600；已有的保持原权限
pub fn add_to_gitignore(
    root: &Path,
    file: &Path,
    backups: &Path,
) -> io::Result<Option<GitignoreEdit>> {
    let line = gitignore_line(root, file)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not under project root"))?;
    let path = root.join(".gitignore");
    let state = atomicfile::read_state(&path).map_err(|e| match e {
        atomicfile::ReadError::Io(e) => e,
        other => io::Error::other(other.to_string()),
    })?;
    let old: &[u8] = match &state {
        FileState::Missing => &[],
        FileState::Present(snap) => &snap.bytes,
    };
    let text = String::from_utf8_lossy(old);
    // 已有这一行、而且它后面没有任何 `!` 行（`!` 可能用通配取消了它，不去猜：多一行无害，少一行密钥就进了仓库）
    let listed = text
        .split('\n')
        .rev()
        .map(|l| l.trim_start_matches('\u{feff}').trim_end())
        .take_while(|l| !l.starts_with('!'))
        .any(|l| l.strip_prefix('/').unwrap_or(l) == line.strip_prefix('/').unwrap_or(&line));
    if listed {
        return Ok(None);
    }
    let eol: &[u8] = if old.windows(2).any(|w| w == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut bytes = old.to_vec();
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        bytes.extend_from_slice(eol);
    }
    bytes.extend_from_slice(line.as_bytes());
    bytes.extend_from_slice(eol);
    let backup = match &state {
        FileState::Present(snap) => Some(atomicfile::backup(&path, snap, "gitignore", backups)?),
        FileState::Missing => None,
    };
    atomicfile::atomic_write(&path, &bytes, &state)?;
    #[cfg(unix)]
    if state == FileState::Missing {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
    }
    let written = match atomicfile::read_state(&path) {
        Ok(FileState::Present(snap)) if snap.bytes == bytes => Some(FileState::Present(snap)),
        _ => None,
    };
    Ok(Some(GitignoreEdit {
        path,
        before: state,
        backup,
        written,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{backups, TempTree};
    use std::fs;

    // ===== 纯判断 =====

    const OUTSIDE: GitFacts = GitFacts {
        in_repo: false,
        tracked: false,
        ignored: false,
    };
    const TRACKED: GitFacts = GitFacts {
        in_repo: true,
        tracked: true,
        ignored: false,
    };
    const IGNORED: GitFacts = GitFacts {
        in_repo: true,
        tracked: false,
        ignored: true,
    };
    const UNTRACKED: GitFacts = GitFacts {
        in_repo: true,
        tracked: false,
        ignored: false,
    };

    #[test]
    fn decide_covers_every_combination() {
        // 来源的四种事实 × 目标的四种事实 × 有没有密钥
        for source in [OUTSIDE, TRACKED, IGNORED, UNTRACKED] {
            for target in [OUTSIDE, TRACKED, IGNORED, UNTRACKED] {
                assert_eq!(
                    decide(false, source, target),
                    KeyHint::Quiet,
                    "没有像密钥的值：什么都不说 {source:?} {target:?}"
                );
            }
            assert_eq!(
                decide(true, source, OUTSIDE),
                KeyHint::Quiet,
                "目标不是 git 仓库：什么都不说 {source:?}"
            );
            assert_eq!(
                decide(true, source, IGNORED),
                KeyHint::Quiet,
                "目标已被忽略、不会进仓库：什么都不说 {source:?}"
            );
        }
        // 目标已被跟踪：.gitignore 管不住，不论来源（产品负责人 2026-10-06）——不出勾选、不追加，只说一声
        for source in [OUTSIDE, TRACKED, IGNORED, UNTRACKED] {
            assert_eq!(
                decide(true, source, TRACKED),
                KeyHint::Tracked,
                "{source:?}"
            );
        }
        // 目标在仓库里、没被跟踪也没被忽略：再看来源
        assert_eq!(decide(true, TRACKED, UNTRACKED), KeyHint::SourceCommitted);
        assert_eq!(decide(true, IGNORED, UNTRACKED), KeyHint::AutoIgnore);
        // 来源不在仓库里（市场、粘贴），或在仓库里但没被跟踪也没被忽略：第一次暴露
        assert_eq!(decide(true, OUTSIDE, UNTRACKED), KeyHint::Remind);
        assert_eq!(decide(true, UNTRACKED, UNTRACKED), KeyHint::Remind);
        assert_eq!(
            decide(true, GitFacts::default(), UNTRACKED),
            KeyHint::Remind
        );
    }

    #[test]
    fn key_hint_serializes_camel_case() {
        let names: Vec<String> = [
            KeyHint::Quiet,
            KeyHint::SourceCommitted,
            KeyHint::AutoIgnore,
            KeyHint::Remind,
        ]
        .iter()
        .map(|h| serde_json::to_string(h).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "\"quiet\"",
                "\"sourceCommitted\"",
                "\"autoIgnore\"",
                "\"remind\""
            ]
        );
    }

    // ===== git 探测 =====

    /// 测试里跑 git 只认临时仓库：不读本机的全局与系统配置（全局的 excludesFile 可能恰好忽略 `.mcp.json`）
    fn isolated() -> Git {
        Git {
            program: "git".into(),
            isolated: true,
        }
    }

    /// 在 `dir` 里跑 git 搭临时仓库；没有 git 时为 None
    fn git(dir: &Path, args: &[&str]) -> Option<()> {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.test")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.test")
            .output()
            .ok()?;
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        Some(())
    }

    #[test]
    fn gitignore_line_anchors_bare_file_names_to_the_root() {
        let root = Path::new("/p/my project");
        assert_eq!(
            gitignore_line(root, &root.join(".mcp.json")).as_deref(),
            Some("/.mcp.json")
        );
        assert_eq!(
            gitignore_line(root, &root.join(".cursor/mcp.json")).as_deref(),
            Some(".cursor/mcp.json")
        );
        assert_eq!(gitignore_line(root, root), None);
        assert_eq!(
            gitignore_line(root, Path::new("/elsewhere/.mcp.json")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn appended_root_line_leaves_same_named_files_in_subdirectories_alone() {
        let t = TempTree::new();
        let Some(repo) = repo(&t) else {
            eprintln!("没有 git，跳过");
            return;
        };
        fs::create_dir_all(repo.join(".cursor")).unwrap();
        fs::create_dir_all(repo.join("child/.cursor")).unwrap();
        assert!(appended(&repo, &repo.join(".mcp.json"), backups()));
        assert!(appended(&repo, &repo.join(".cursor/mcp.json"), backups()));
        for (rel, ignored) in [
            (".mcp.json", true),
            ("child/.mcp.json", false),
            (".cursor/mcp.json", true),
            ("child/.cursor/mcp.json", false),
        ] {
            let file = repo.join(rel);
            fs::write(&file, "{}").unwrap();
            assert_eq!(probe(&file).ignored, ignored, "{rel}");
        }
    }

    /// 一个临时仓库（路径带空格）：`tracked.json` 提交过，`.gitignore` 忽略 `ignored.json` 与 `cache/`，
    /// `loose.json` 在工作区里但没跟踪。没有 git 时为 None
    fn repo(t: &TempTree) -> Option<PathBuf> {
        let repo = t.dir("my project");
        git(&repo, &["init", "-q"])?;
        fs::write(repo.join(".gitignore"), "ignored.json\ncache/\n").unwrap();
        fs::write(repo.join("tracked.json"), "{}").unwrap();
        fs::write(repo.join("loose.json"), "{}").unwrap();
        git(&repo, &["add", ".gitignore", "tracked.json"])?;
        git(&repo, &["commit", "-q", "-m", "init"])?;
        Some(repo)
    }

    #[cfg(unix)]
    #[test]
    fn probe_reads_tracked_ignored_and_plain_files() {
        let t = TempTree::new();
        let Some(repo) = repo(&t) else {
            eprintln!("没有 git，跳过");
            return;
        };
        let git = isolated();
        assert_eq!(git.probe(&repo.join("tracked.json")), TRACKED);
        // 被忽略的文件还不存在也认得出（要写的目标）
        assert_eq!(git.probe(&repo.join("ignored.json")), IGNORED);
        // 目录还不存在：从最近的已有目录问
        assert_eq!(git.probe(&repo.join("cache/deep/x.json")), IGNORED);
        assert_eq!(git.probe(&repo.join("loose.json")), UNTRACKED);
        assert_eq!(git.probe(&repo.join(".cursor/mcp.json")), UNTRACKED);
        // 被跟踪的文件即使名字匹配忽略规则也算跟踪、不算忽略
        fs::write(repo.join("ignored.json"), "{}").unwrap();
        git_add_force(&repo, "ignored.json");
        assert_eq!(git.probe(&repo.join("ignored.json")), TRACKED);
        assert!(git.in_repo(&repo));
    }

    fn git_add_force(repo: &Path, name: &str) {
        git(repo, &["add", "-f", name]).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn probe_outside_a_repo_is_all_false() {
        let t = TempTree::new();
        let plain = t.dir("plain");
        let git = isolated();
        // 临时目录的上级不会是仓库；万一是（比如在仓库里设了 TMPDIR）就跳过
        if git.in_repo(&t.root()) {
            eprintln!("临时目录在 git 仓库里，跳过");
            return;
        }
        assert!(!git.in_repo(&plain));
        assert_eq!(git.probe(&plain.join(".mcp.json")), OUTSIDE);
        assert_eq!(git.probe(&t.root().join("gone/.mcp.json")), OUTSIDE);
    }

    #[test]
    fn probe_without_git_is_not_a_repo() {
        let t = TempTree::new();
        let dir = t.dir("p");
        let missing = Git {
            program: t.root().join("no-such-git").into_os_string(),
            isolated: true,
        };
        assert!(!missing.in_repo(&dir));
        assert_eq!(missing.probe(&dir.join(".mcp.json")), OUTSIDE);
    }

    // ===== .gitignore 追加 =====

    fn appended(root: &Path, file: &Path, backups: &Path) -> bool {
        add_to_gitignore(root, file, backups).unwrap().is_some()
    }

    /// 新建的 `.gitignore` 是要提交、给别人看的普通文件：0644，不是 atomicfile 新文件的 0600
    #[cfg(unix)]
    #[test]
    fn new_gitignore_is_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempTree::new();
        let root = t.dir("proj");
        let edit = add_to_gitignore(&root, &root.join(".mcp.json"), backups())
            .unwrap()
            .unwrap();
        let mode = fs::metadata(root.join(".gitignore"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o644);
        assert_eq!(edit.before, FileState::Missing);
        // 写后状态是改了权限之后读回的：撤销时拿它核对
        assert!(atomicfile::same(
            &root.join(".gitignore"),
            edit.written.as_ref().unwrap()
        ));
        // 已有的文件保持原权限
        fs::set_permissions(root.join(".gitignore"), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(appended(&root, &root.join(".cursor/mcp.json"), backups()));
        let mode = fs::metadata(root.join(".gitignore"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn gitignore_created_when_missing() {
        let t = TempTree::new();
        let root = t.dir("proj");
        assert!(appended(&root, &root.join(".cursor/mcp.json"), backups()));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            ".cursor/mcp.json\n"
        );
    }

    #[test]
    fn gitignore_appends_after_missing_newline_and_does_not_repeat() {
        let t = TempTree::new();
        let root = t.dir("proj");
        fs::write(root.join(".gitignore"), "node_modules/\ntarget").unwrap();
        assert!(appended(&root, &root.join(".mcp.json"), backups()));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "node_modules/\ntarget\n/.mcp.json\n"
        );
        // 已有同一行（开头带不带 `/`、行尾空白）：不重复
        assert!(!appended(&root, &root.join(".mcp.json"), backups()));
        for existing in ["/.mcp.json  \n", ".mcp.json\n", "/.cursor/mcp.json\n"] {
            fs::write(root.join(".gitignore"), existing).unwrap();
            let file = if existing.contains(".cursor") {
                root.join(".cursor/mcp.json")
            } else {
                root.join(".mcp.json")
            };
            assert!(!appended(&root, &file, backups()), "{existing:?}");
            assert_eq!(
                fs::read_to_string(root.join(".gitignore")).unwrap(),
                existing
            );
        }
        // 后面又被 `!` 取消了：照样追加，追加的那一行在最后，生效
        fs::write(root.join(".gitignore"), ".mcp.json\n!/.mcp.json\n").unwrap();
        assert!(appended(&root, &root.join(".mcp.json"), backups()));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            ".mcp.json\n!/.mcp.json\n/.mcp.json\n"
        );
        // 后面有通配的 `!`（可能取消了它）：也照样追加
        fs::write(root.join(".gitignore"), ".mcp.json\n!*.json\n").unwrap();
        assert!(appended(&root, &root.join(".mcp.json"), backups()));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            ".mcp.json\n!*.json\n/.mcp.json\n"
        );
    }

    #[test]
    fn gitignore_keeps_crlf() {
        let t = TempTree::new();
        let root = t.dir("proj");
        fs::write(root.join(".gitignore"), "\u{feff}dist\r\n.env\r\n").unwrap();
        assert!(appended(&root, &root.join(".vscode/mcp.json"), backups()));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "\u{feff}dist\r\n.env\r\n.vscode/mcp.json\r\n"
        );
        // 末尾没有换行的 CRLF 文件：补的也是 CRLF
        fs::write(root.join(".gitignore"), "dist\r\n.env").unwrap();
        assert!(appended(&root, &root.join(".mcp.json"), backups()));
        assert_eq!(
            fs::read_to_string(root.join(".gitignore")).unwrap(),
            "dist\r\n.env\r\n/.mcp.json\r\n"
        );
    }

    #[test]
    fn gitignore_refuses_files_outside_the_project() {
        let t = TempTree::new();
        let root = t.dir("proj");
        let home = t.dir("home");
        assert!(add_to_gitignore(&root, &home.join(".claude.json"), backups()).is_err());
        assert!(add_to_gitignore(&root, &root.join("../x.json"), backups()).is_err());
        assert!(!root.join(".gitignore").exists());
    }
}

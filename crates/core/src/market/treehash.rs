//! 按 git 规则算文件夹的 tree SHA（R12 / R15，T2 负责），与 GitHub trees 接口、
//! `.skill-lock.json` 的 `skillFolderHash` 同一种：文件 `100644` / 可执行 `100755`、
//! 软链接 `120000`（内容是链接目标）、子目录 `40000`、空目录不记，条目按 git 的排序。
//! 测试里对同一目录跑 `git` 对照。另算逐文件 blob SHA，供「改过的文件」清单比对。
//!
//! 「本地改没改」另看排除杂项（`IGNORED_NAMES` / `IGNORED_SUFFIXES`）后的指纹（`content_sha`、
//! `LocalSha`）：同样的算法，Finder、跑脚本留下的东西不算改动（#108）。记进安装记录、与远端比的
//! 仍是 git 原样的 tree SHA，与 GitHub 给的一致。
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

/// 相对 skill 文件夹的路径（`/` 分隔）→ blob SHA
pub type FileHashes = BTreeMap<String, String>;

/// 不算进内容的杂项：名字恰为其一的条目（文件、目录、软链接都算；目录连同整个子树）跳过。
/// 照 skills-manager 的排除名单：版本库自身（`.git`，含子模块那种文件 `.git`）、Finder 的 `.DS_Store`、
/// 资源管理器的 `Thumbs.db`、`.gitignore`、Python 跑脚本留下的 `__pycache__`。不分大小写
const IGNORED_NAMES: [&str; 5] = [
    ".git",
    ".DS_Store",
    "Thumbs.db",
    ".gitignore",
    "__pycache__",
];

/// 同上，按后缀认的：Python 的字节码 `*.pyc`、`*.pyo`。不分大小写
const IGNORED_SUFFIXES: [&str; 2] = [".pyc", ".pyo"];

/// 这个名字（单个条目名，不是路径）是不是杂项
pub(crate) fn is_ignored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORED_NAMES.iter().any(|n| n.eq_ignore_ascii_case(name))
        || IGNORED_SUFFIXES.iter().any(|s| lower.ends_with(s))
}

/// 相对路径（`/` 分隔）里有任何一段是杂项
fn path_is_ignored(path: &str) -> bool {
    path.split('/').any(is_ignored)
}

/// 算 tree SHA 时跳过哪些条目（`.git` 永远跳过：它不进 git 的树）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Skip {
    /// 只跳 `.git`：git 原样
    GitDir,
    /// 杂项全跳
    Ignored,
    /// 杂项里留下 `.gitignore`：名单上只有它常被提交进仓库
    IgnoredButGitignore,
}

impl Skip {
    fn skips(self, name: &str) -> bool {
        match self {
            Skip::GitDir => name == ".git",
            Skip::Ignored => name == ".git" || is_ignored(name),
            Skip::IgnoredButGitignore => {
                name == ".git" || (is_ignored(name) && !name.eq_ignore_ascii_case(".gitignore"))
            }
        }
    }
}

/// 本地文件夹的几种指纹，用来认「本地是不是某一版」
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSha {
    /// 按 git 原样算的 tree SHA：记进安装记录，与 GitHub 给的同一种。
    /// 读不了（如杂项目录没权限、遍历时缓存被删）时为 None，不影响下面两种
    pub git: Option<String>,
    /// 杂项全部排除后的（`content_sha`）
    pub content: String,
    /// 杂项里只留下 `.gitignore` 的；`.gitignore` 读不了时为 None
    pub content_with_gitignore: Option<String>,
}

impl LocalSha {
    /// 本地是不是 `sha`（记下的、远端的，都是 git 原样的 tree SHA）那一版：几种指纹对上一个就算。
    /// - 那一版没有杂项（绝大多数）：杂项全排除后就等于它，本地多出来的杂项、`.gitignore` 都不算改动；
    /// - 那一版提交了 `.gitignore`（整个仓库就是一个 skill 时常见）：只留 `.gitignore` 的对上；
    /// - 那一版还提交了别的杂项：靠 git 原样的对上（这时本地再多出杂项就认不出，按改过处理）。
    ///
    /// 记录格式不变，升级前记下的、`npx skills` 的 lock 里的照样能比
    pub fn is(&self, sha: &str) -> bool {
        self.git.as_deref() == Some(sha)
            || self.content == sha
            || self.content_with_gitignore.as_deref() == Some(sha)
    }

    /// 本地自记下那一版以来没改过。记录带着排除杂项的指纹（`content`，装时算的）时对上它就算，
    /// 那一版自己带的杂项之后变了、删了也不管；否则（升级前的记录、lock 里的）按 `is` 认
    pub fn unchanged_since(&self, tree_sha: &str, content: Option<&str>) -> bool {
        content == Some(self.content.as_str()) || self.is(tree_sha)
    }
}

/// 文件夹的 git tree SHA（40 位小写十六进制）
pub fn tree_sha(dir: &Path) -> io::Result<String> {
    tree_sha_by(dir, Skip::GitDir)
}

/// 内容指纹：排除杂项后的 tree SHA。没有杂项时与 `tree_sha` 相同
pub fn content_sha(dir: &Path) -> io::Result<String> {
    tree_sha_by(dir, Skip::Ignored)
}

/// 几种指纹一起算。杂项全排除的那种算不出（正文读不了）才算失败；另两种算不出记 None
pub fn local_sha(dir: &Path) -> io::Result<LocalSha> {
    Ok(LocalSha {
        content: content_sha(dir)?,
        content_with_gitignore: tree_sha_by(dir, Skip::IgnoredButGitignore).ok(),
        git: tree_sha(dir).ok(),
    })
}

fn tree_sha_by(dir: &Path, skip: Skip) -> io::Result<String> {
    let mut files = FileHashes::new();
    // 根目录没有任何文件时 git 记的是空树（`4b825dc…`），不是「不记」
    let sha = hash_dir(dir, "", skip, &mut files)?.unwrap_or_else(|| hash_object("tree", &[]));
    Ok(hex(&sha))
}

/// 文件夹里每个文件（含软链接）的 blob SHA，按 git 原样（杂项也在里面，比较时由 `changed_files` 跳过）
pub fn file_hashes(dir: &Path) -> io::Result<FileHashes> {
    let mut files = FileHashes::new();
    hash_dir(dir, "", Skip::GitDir, &mut files)?;
    Ok(files)
}

/// 本地与记下那一版不同的文件：内容变了、新增的、删掉的，按路径排序。两边的杂项都不算
pub fn changed_files(local: &FileHashes, recorded: &FileHashes) -> Vec<String> {
    let mut changed: Vec<String> = local
        .iter()
        .filter(|(path, sha)| recorded.get(*path) != Some(*sha))
        .map(|(path, _)| path.clone())
        .chain(
            recorded
                .keys()
                .filter(|path| !local.contains_key(*path))
                .cloned(),
        )
        .filter(|path| !path_is_ignored(path))
        .collect();
    changed.sort();
    changed
}

/// git 对象的 SHA-1：`<类型> <长度>\0<内容>`
fn hash_object(kind: &str, content: &[u8]) -> [u8; 20] {
    let mut hasher = Sha1::new();
    hasher.update(format!("{kind} {}\0", content.len()).as_bytes());
    hasher.update(content);
    let out = hasher.finalize();
    let mut sha = [0u8; 20];
    sha.copy_from_slice(&out);
    sha
}

fn hex(sha: &[u8; 20]) -> String {
    sha.iter().map(|b| format!("{b:02x}")).collect()
}

/// tree 里的一条
struct TreeEntry {
    /// git 写进 tree 对象的模式串（子目录是 `40000`，没有前导 0）
    mode: &'static str,
    name: Vec<u8>,
    sha: [u8; 20],
}

impl TreeEntry {
    /// git 的排序键：子目录按「名字 + `/`」比，所以 `foo.txt` 排在目录 `foo` 前面
    fn sort_key(&self) -> Vec<u8> {
        let mut key = self.name.clone();
        if self.mode == "40000" {
            key.push(b'/');
        }
        key
    }
}

/// 算一个目录的 tree SHA，顺手把其下文件的 blob SHA 记进 `files`（键带 `prefix`）。
/// 目录里（递归地）一个文件都没有时返回 None：git 不记空目录。`skip` 跳过的条目不算
/// （只剩杂项的子目录因此也不记）。
/// 不跟随软链接：条目类型取自 `read_dir` 的 `file_type`（lstat 语义）
fn hash_dir(
    dir: &Path,
    prefix: &str,
    skip: Skip,
    files: &mut FileHashes,
) -> io::Result<Option<[u8; 20]>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip.skips(&name.to_string_lossy()) {
            continue;
        }
        let name_bytes = os_bytes(&name);
        let name_str = name.to_string_lossy();
        let rel = format!("{prefix}{name_str}");
        let path = entry.path();
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            let target = fs::read_link(&path)?;
            let sha = hash_object("blob", &link_bytes(&target));
            files.insert(rel, hex(&sha));
            entries.push(TreeEntry {
                mode: "120000",
                name: name_bytes,
                sha,
            });
        } else if ty.is_dir() {
            if let Some(sha) = hash_dir(&path, &format!("{rel}/"), skip, files)? {
                entries.push(TreeEntry {
                    mode: "40000",
                    name: name_bytes,
                    sha,
                });
            }
        } else if ty.is_file() {
            let content = fs::read(&path)?;
            let sha = hash_object("blob", &content);
            files.insert(rel, hex(&sha));
            let mode = if is_executable(&entry.metadata()?) {
                "100755"
            } else {
                "100644"
            };
            entries.push(TreeEntry {
                mode,
                name: name_bytes,
                sha,
            });
        }
        // 其余（FIFO、套接字、设备）git add 也不收
    }
    if entries.is_empty() {
        return Ok(None);
    }
    entries.sort_by_cached_key(TreeEntry::sort_key);
    let mut body = Vec::new();
    for e in &entries {
        body.extend_from_slice(e.mode.as_bytes());
        body.push(b' ');
        body.extend_from_slice(&e.name);
        body.push(0);
        body.extend_from_slice(&e.sha);
    }
    Ok(Some(hash_object("tree", &body)))
}

/// 与 git 一样只看属主的执行位（`st_mode & S_IXUSR`）；Windows 上一律当普通文件
#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}

/// 文件名的原始字节：Unix 上逐字节，与 git 一致；其他平台按 UTF-8
#[cfg(unix)]
fn os_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    name.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn os_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    name.to_string_lossy().into_owned().into_bytes()
}

/// 软链接的目标原样当内容（git 存的就是 readlink 的结果）；非 Unix 上把 `\` 换成 `/`
#[cfg(unix)]
fn link_bytes(target: &Path) -> Vec<u8> {
    os_bytes(target.as_os_str())
}

#[cfg(not(unix))]
fn link_bytes(target: &Path) -> Vec<u8> {
    target.to_string_lossy().replace('\\', "/").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    #[test]
    fn empty_folder_is_the_empty_tree() {
        let t = TempTree::new();
        let d = t.dir("empty");
        assert_eq!(tree_sha(&d).unwrap(), EMPTY_TREE);
        // 只有空目录的文件夹也是空树
        t.dir("empty/a/b");
        assert_eq!(tree_sha(&d).unwrap(), EMPTY_TREE);
        assert!(file_hashes(&d).unwrap().is_empty());
    }

    #[test]
    fn blob_sha_matches_git_hash_object() {
        let t = TempTree::new();
        let d = t.dir("s");
        std::fs::write(d.join("hello.txt"), "hello\n").unwrap();
        let files = file_hashes(&d).unwrap();
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(
            files.get("hello.txt").map(String::as_str),
            Some("ce013625030ba8dba906f756967f9e9ca394464a")
        );
    }

    #[test]
    fn missing_folder_is_an_error() {
        let t = TempTree::new();
        assert!(tree_sha(&t.root().join("nope")).is_err());
        assert!(file_hashes(&t.root().join("nope")).is_err());
    }

    #[test]
    fn file_hashes_are_keyed_by_relative_slash_path() {
        let t = TempTree::new();
        let d = t.dir("s");
        t.dir("s/docs/deep");
        std::fs::write(d.join("SKILL.md"), "a").unwrap();
        std::fs::write(d.join("docs/deep/b.txt"), "b").unwrap();
        let keys: Vec<_> = file_hashes(&d).unwrap().into_keys().collect();
        assert_eq!(keys, vec!["SKILL.md", "docs/deep/b.txt"]);
    }

    #[test]
    fn changed_files_lists_added_removed_modified_sorted() {
        let map = |pairs: &[(&str, &str)]| -> FileHashes {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let recorded = map(&[("SKILL.md", "1"), ("b.md", "2"), ("gone.txt", "3")]);
        let local = map(&[("SKILL.md", "1"), ("b.md", "9"), ("a-new.txt", "4")]);
        assert_eq!(
            changed_files(&local, &recorded),
            vec!["a-new.txt", "b.md", "gone.txt"]
        );
        assert!(changed_files(&recorded, &recorded).is_empty());
    }

    /// 排除名单（#108）：Finder 留下的 `.DS_Store`、脚本跑出来的 `__pycache__` / `*.pyc`、嵌套的 `.git`
    /// 等加上去，内容指纹不变，且就等于加之前按 git 原样算的 tree SHA（记下的、远端的都是这一种）；
    /// 大小写不论；只剩杂项的子目录整个不记；名字只是像的照算；改正文才变
    #[test]
    fn content_sha_ignores_junk() {
        let t = TempTree::new();
        let d = t.dir("s");
        t.dir("s/scripts");
        std::fs::write(d.join("SKILL.md"), "---\nname: s\n---\nbody\n").unwrap();
        std::fs::write(d.join("scripts/run.py"), "print(1)\n").unwrap();
        let before = tree_sha(&d).unwrap();
        assert_eq!(content_sha(&d).unwrap(), before);

        std::fs::write(d.join(".DS_Store"), "finder").unwrap();
        std::fs::write(d.join("scripts/.DS_Store"), "finder").unwrap();
        std::fs::write(d.join("Thumbs.db"), "explorer").unwrap();
        std::fs::write(d.join(".gitignore"), "*.pyc\n").unwrap();
        t.dir("s/__pycache__");
        std::fs::write(d.join("__pycache__/x.cpython-312.pyc"), "bytecode").unwrap();
        t.dir("s/scripts/__pycache__");
        std::fs::write(d.join("scripts/__pycache__/run.pyc"), "bytecode").unwrap();
        std::fs::write(d.join("scripts/run.pyc"), "bytecode").unwrap();
        std::fs::write(d.join("scripts/run.pyo"), "bytecode").unwrap();
        // 大小写不同的写法（Windows、不分大小写的盘上都可能出现）
        t.dir("s/upper");
        std::fs::write(d.join("upper/THUMBS.DB"), "explorer").unwrap();
        std::fs::write(d.join("upper/Run.PYC"), "bytecode").unwrap();
        // 嵌套的仓库：目录 `.git` 与子模块那种文件 `.git`
        t.dir("s/docs/.git/objects");
        std::fs::write(d.join("docs/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        t.dir("s/vendor");
        std::fs::write(d.join("vendor/.git"), "gitdir: ../.git/modules/vendor\n").unwrap();
        // 只剩缓存的子目录：排除后是空目录，git 不记
        t.dir("s/lib/__pycache__");
        std::fs::write(d.join("lib/__pycache__/a.pyc"), "bytecode").unwrap();

        assert_ne!(tree_sha(&d).unwrap(), before, "git 原样算的会变");
        assert_eq!(content_sha(&d).unwrap(), before);
        // `.gitignore` 有无不影响
        std::fs::remove_file(d.join(".gitignore")).unwrap();
        assert_eq!(content_sha(&d).unwrap(), before);

        // 名字只是像的不排除
        std::fs::write(d.join("notes.pyc.md"), "real").unwrap();
        assert_ne!(content_sha(&d).unwrap(), before);
        std::fs::remove_file(d.join("notes.pyc.md")).unwrap();
        t.dir("s/.github");
        std::fs::write(d.join(".github/ci.yml"), "on: push\n").unwrap();
        assert_ne!(content_sha(&d).unwrap(), before);
        std::fs::remove_dir_all(d.join(".github")).unwrap();
        assert_eq!(content_sha(&d).unwrap(), before);

        // 改正文：变
        std::fs::write(d.join("scripts/run.py"), "print(2)\n").unwrap();
        assert_ne!(content_sha(&d).unwrap(), before);
    }

    /// 本地是不是某一版：几种指纹有一个对上就算。那一版没有杂项、本地多了 `.DS_Store`、`.gitignore`
    /// 时靠全排除的对上；那一版提交了 `.gitignore`、本地又多了 `.DS_Store` 时靠只留 `.gitignore` 的对上；
    /// 改了正文哪种都对不上
    #[test]
    fn local_sha_is_a_version_despite_junk() {
        let t = TempTree::new();
        let d = t.dir("s");
        std::fs::write(d.join("SKILL.md"), "a").unwrap();
        let plain = tree_sha(&d).unwrap();
        std::fs::write(d.join(".gitignore"), "node_modules\n").unwrap();
        let with_gitignore = tree_sha(&d).unwrap();
        let local = local_sha(&d).unwrap();
        assert_eq!(local.git.as_deref(), Some(with_gitignore.as_str()));
        assert!(local.is(&with_gitignore));
        assert!(local.is(&plain), "本地加的 `.gitignore` 不算改动");

        std::fs::write(d.join(".DS_Store"), "finder").unwrap();
        t.dir("s/__pycache__");
        std::fs::write(d.join("__pycache__/a.pyc"), "bytecode").unwrap();
        let local = local_sha(&d).unwrap();
        assert!(
            local.is(&with_gitignore),
            "那一版带 `.gitignore`，本地又多了杂项"
        );
        assert!(local.is(&plain));

        std::fs::write(d.join("SKILL.md"), "b").unwrap();
        let local = local_sha(&d).unwrap();
        assert!(!local.is(&with_gitignore));
        assert!(!local.is(&plain));
    }

    /// 杂项目录读不了（没权限、遍历时被删）：git 原样的算不出，排除杂项的照样算，不因此当成改过
    #[cfg(unix)]
    #[test]
    fn unreadable_junk_does_not_hide_content() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempTree::new();
        let d = t.dir("s");
        std::fs::write(d.join("SKILL.md"), "a").unwrap();
        let before = tree_sha(&d).unwrap();
        let cache = t.dir("s/__pycache__");
        std::fs::write(cache.join("a.pyc"), "bytecode").unwrap();
        std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o000)).unwrap();
        let local = local_sha(&d);
        std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o755)).unwrap();
        let local = local.unwrap();
        assert_eq!(local.git, None);
        assert!(local.is(&before));
    }

    /// 本地新加的 `.gitignore` 读不了：只留 `.gitignore` 的那种算不出，另外两种照样认
    #[cfg(unix)]
    #[test]
    fn unreadable_gitignore_does_not_hide_content() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempTree::new();
        let d = t.dir("s");
        std::fs::write(d.join("SKILL.md"), "a").unwrap();
        let before = tree_sha(&d).unwrap();
        let ignore = d.join(".gitignore");
        std::fs::write(&ignore, "*.pyc\n").unwrap();
        std::fs::set_permissions(&ignore, std::fs::Permissions::from_mode(0o000)).unwrap();
        let local = local_sha(&d);
        std::fs::set_permissions(&ignore, std::fs::Permissions::from_mode(0o644)).unwrap();
        let local = local.unwrap();
        assert_eq!(local.content_with_gitignore, None);
        assert!(local.is(&before));
    }

    /// 改过的文件清单不列杂项：本地多出的 `.DS_Store`、缓存，记下那一版里的 `.gitignore` 都不算
    #[test]
    fn changed_files_skips_junk() {
        let map = |pairs: &[(&str, &str)]| -> FileHashes {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let recorded = map(&[("SKILL.md", "1"), (".gitignore", "2"), ("a.py", "3")]);
        let local = map(&[
            ("SKILL.md", "1"),
            ("a.py", "9"),
            (".DS_Store", "4"),
            ("__pycache__/a.cpython-312.pyc", "5"),
            ("sub/.git/HEAD", "6"),
            ("sub/b.PYO", "7"),
        ]);
        assert_eq!(changed_files(&local, &recorded), vec!["a.py"]);
    }

    /// 与本机 `git` 对照：嵌套目录、可执行文件、软链接（指向文件、目录、不存在处）、空目录、
    /// `foo` / `foo.txt` 这种 git 排序与字典序不同的名字。没有 git 就跳过
    #[cfg(unix)]
    #[test]
    fn tree_sha_matches_git() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::process::Command;

        let t = TempTree::new();
        let repo = t.dir("repo");
        let git = |args: &[&str]| -> Option<String> {
            let out = Command::new("git")
                .args(["-c", "core.fileMode=true", "-c", "core.symlinks=true"])
                .args([
                    "-c",
                    "core.autocrlf=false",
                    "-c",
                    "core.excludesFile=/dev/null",
                ])
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .ok()?;
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            Some(String::from_utf8(out.stdout).unwrap().trim().to_string())
        };
        if git(&["--version"]).is_none() {
            eprintln!("没有 git，跳过对照");
            return;
        }

        let skill = t.dir("repo/skills/pdf");
        std::fs::write(skill.join("SKILL.md"), "---\nname: pdf\n---\r\nbody\n").unwrap();
        let script = skill.join("run.sh");
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        // 只有组 / 其他人可执行：git 仍记 100644
        let half = skill.join("half.sh");
        std::fs::write(&half, "x").unwrap();
        std::fs::set_permissions(&half, std::fs::Permissions::from_mode(0o654)).unwrap();
        t.dir("repo/skills/pdf/foo");
        std::fs::write(skill.join("foo/inner.md"), "inner").unwrap();
        std::fs::write(skill.join("foo.txt"), "dot").unwrap();
        std::fs::write(skill.join("foo-bar"), "dash").unwrap();
        t.dir("repo/skills/pdf/docs/deep");
        std::fs::write(skill.join("docs/deep/b.txt"), "b").unwrap();
        std::fs::write(skill.join("docs/a.md"), "").unwrap();
        t.dir("repo/skills/pdf/empty");
        t.dir("repo/skills/pdf/nested-empty/inner");
        symlink("SKILL.md", skill.join("link.md")).unwrap();
        symlink("docs", skill.join("docs-link")).unwrap();
        symlink("../nowhere", skill.join("broken")).unwrap();
        std::fs::write(repo.join("README.md"), "root").unwrap();

        git(&["init", "-q"]).unwrap();
        git(&["add", "-A"]).unwrap();
        let root_tree = git(&["write-tree"]).unwrap();
        let sub_tree = git(&["write-tree", "--prefix=skills/pdf/"]).unwrap();
        let docs_tree = git(&["write-tree", "--prefix=skills/pdf/docs/"]).unwrap();

        // 根目录里的 `.git` 不计入
        assert_eq!(tree_sha(&repo).unwrap(), root_tree);
        assert_eq!(tree_sha(&skill).unwrap(), sub_tree);
        assert_eq!(tree_sha(&skill.join("docs")).unwrap(), docs_tree);

        // 逐文件 blob SHA 与 git 索引里的一致
        let listed = git(&["ls-files", "-s", "--", "skills/pdf"]).unwrap();
        let from_git: FileHashes = listed
            .lines()
            .map(|line| {
                let (meta, path) = line.split_once('\t').unwrap();
                let sha = meta.split_whitespace().nth(1).unwrap();
                (
                    path.strip_prefix("skills/pdf/").unwrap().to_string(),
                    sha.to_string(),
                )
            })
            .collect();
        assert_eq!(file_hashes(&skill).unwrap(), from_git);

        // 改一个文件：tree SHA 变，清单里只有它
        let before = file_hashes(&skill).unwrap();
        std::fs::write(skill.join("docs/a.md"), "changed").unwrap();
        assert_ne!(tree_sha(&skill).unwrap(), sub_tree);
        assert_eq!(
            changed_files(&file_hashes(&skill).unwrap(), &before),
            vec!["docs/a.md"]
        );
    }
}

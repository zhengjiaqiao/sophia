//! 按 git 规则算文件夹的 tree SHA（R12 / R15，T2 负责），与 GitHub trees 接口、
//! `.skill-lock.json` 的 `skillFolderHash` 同一种：文件 `100644` / 可执行 `100755`、
//! 软链接 `120000`（内容是链接目标）、子目录 `40000`、空目录不记，条目按 git 的排序。
//! 测试里对同一目录跑 `git` 对照。另算逐文件 blob SHA，供「改过的文件」清单比对。
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

/// 相对 skill 文件夹的路径（`/` 分隔）→ blob SHA
pub type FileHashes = BTreeMap<String, String>;

/// 文件夹的 git tree SHA（40 位小写十六进制）
pub fn tree_sha(dir: &Path) -> io::Result<String> {
    let mut files = FileHashes::new();
    // 根目录没有任何文件时 git 记的是空树（`4b825dc…`），不是「不记」
    let sha = hash_dir(dir, "", &mut files)?.unwrap_or_else(|| hash_object("tree", &[]));
    Ok(hex(&sha))
}

/// 文件夹里每个文件（含软链接）的 blob SHA
pub fn file_hashes(dir: &Path) -> io::Result<FileHashes> {
    let mut files = FileHashes::new();
    hash_dir(dir, "", &mut files)?;
    Ok(files)
}

/// 本地与记下那一版不同的文件：内容变了、新增的、删掉的，按路径排序
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
/// 目录里（递归地）一个文件都没有时返回 None：git 不记空目录。
/// 不跟随软链接：条目类型取自 `read_dir` 的 `file_type`（lstat 语义）
fn hash_dir(dir: &Path, prefix: &str, files: &mut FileHashes) -> io::Result<Option<[u8; 20]>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        // `.git` 永远不进 git 的树
        if name == ".git" {
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
            if let Some(sha) = hash_dir(&path, &format!("{rel}/"), files)? {
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

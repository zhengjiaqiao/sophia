//! codeload tar.gz 的安全解包（非功能「解包安全」，T1 负责）：
//! 拒绝包内的绝对路径、`..`、软链接、设备文件；只取指定路径下的文件；在落点同盘的临时目录里解好、
//! 校验有 `SKILL.md` 后整目录改名到位，失败时落点不留任何文件；选中的每个文件夹解出的文件不超过
//! `MAX_SKILL_BYTES`，整包解压流不超过 `MAX_UNPACKED_BYTES`（挡压缩炸弹）。
//! 另从 `pax_global_header` 读提交 SHA（R12），列出包里所有 skill 文件夹（R6 一个仓库多个 skill）。
//!
//! 三个入口各自从头解压一遍，都按同一套规则走包：
//! - 解压后的字节流（含 tar 头）总量超过 `MAX_UNPACKED_BYTES` 即停：网络层只数了压缩后的大小，压缩炸弹在这里拦；
//!   仓库里别处的大文件只流过、不读进内存，不占 skill 的额度；
//! - 包里任何一条的路径是绝对路径或含 `..`，整个包都不认——codeload 不会产出这种包；
//! - 软链接、硬链接、设备文件只在落进要取的文件夹时才拒绝（拒绝那一个），别处的不碰也不管。
use super::{MarketResult, MAX_SKILL_BYTES, MAX_UNPACKED_BYTES};
use flate2::read::GzDecoder;
use std::cell::Cell;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use tar::EntryType;

/// 从包里取一个文件夹放到哪
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    /// 仓库内路径，不带首尾 `/`（包里还有一层 `<repo>-<分支>/` 顶层目录，由这里去掉）；空串＝仓库根
    pub path: String,
    /// 落点，如 `~/.agents/skills/pdf`。必须还不存在；父目录不存在时创建
    pub dest: PathBuf,
}

/// `pax_global_header` 里 `comment` 记的提交 SHA（40 位十六进制）
pub fn commit_sha(archive: &[u8]) -> MarketResult<String> {
    let mut found = None;
    walk(archive, MAX_UNPACKED_BYTES, |entry, member| {
        if !member.kind.is_pax_global_extensions() {
            return Ok(Flow::Continue);
        }
        if let Some(exts) = entry.pax_extensions()? {
            for ext in exts.flatten() {
                if ext.key_bytes() == b"comment" {
                    let value = String::from_utf8_lossy(ext.value_bytes())
                        .trim()
                        .to_string();
                    if value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
                        found = Some(value.to_ascii_lowercase());
                        return Ok(Flow::Stop);
                    }
                }
            }
        }
        Ok(Flow::Continue)
    })?;
    found.ok_or_else(|| crate::t!("market.archive.noSha"))
}

/// 包里所有含 `SKILL.md` 的文件夹（仓库内路径，按路径排序）
pub fn skill_dirs(archive: &[u8]) -> MarketResult<Vec<String>> {
    let mut dirs = Vec::new();
    walk(archive, MAX_UNPACKED_BYTES, |_, member| {
        let is_file = matches!(member.kind, EntryType::Regular | EntryType::Continuous);
        if let Some((name, parent)) = member.rel.split_last() {
            if is_file && name == "SKILL.md" {
                // 路径不是 UTF-8 的文件夹无法用字符串交回去取，不列
                if let Some(parts) = parent
                    .iter()
                    .map(|p| p.to_str())
                    .collect::<Option<Vec<_>>>()
                {
                    dirs.push(parts.join("/"));
                }
            }
        }
        Ok(Flow::Continue)
    })?;
    dirs.sort();
    dirs.dedup();
    Ok(dirs)
}

/// 把每个 `Pick` 解到它的落点；结果与 `picks` 同序，一个失败不影响其余
pub fn extract(archive: &[u8], picks: &[Pick]) -> Vec<MarketResult<()>> {
    extract_capped(archive, picks, MAX_UNPACKED_BYTES, MAX_SKILL_BYTES)
}

/// `extract` 的本体，上限可调（测试用小上限造「超量」）：`limit` 整包解压流，`per_pick` 每个选中的文件夹
fn extract_capped(
    archive: &[u8],
    picks: &[Pick],
    limit: u64,
    per_pick: u64,
) -> Vec<MarketResult<()>> {
    // 先逐个备好临时目录；备不好的（路径不合法、落点已有）直接记错，不参与解包
    let mut created_parents = Vec::new();
    let mut slots: Vec<Result<Slot, String>> = picks
        .iter()
        .map(|pick| Slot::prepare(pick, &mut created_parents))
        .collect();

    // 走一遍包，把每条分给要它的文件夹
    let walked = walk(archive, limit, |entry, member| {
        if member.kind.is_pax_global_extensions() || member.rel.is_empty() {
            return Ok(Flow::Continue);
        }
        let is_file = matches!(member.kind, EntryType::Regular | EntryType::Continuous);
        let size = if is_file { entry.size() } else { 0 };
        let mut wanted = Vec::new();
        for (i, s) in slots.iter_mut().enumerate() {
            let Ok(slot) = s else { continue };
            if !member.rel.starts_with(&slot.comps) {
                continue;
            }
            // 先按条目头里的大小记账：超了这个文件夹就不要了，数据不读进内存
            slot.bytes = slot.bytes.saturating_add(size);
            if slot.bytes > per_pick {
                *s = Err(crate::t!(
                    "market.archive.skillTooBig",
                    mb = per_pick / (1024 * 1024)
                ));
            } else {
                wanted.push(i);
            }
        }
        if wanted.is_empty() {
            return Ok(Flow::Continue);
        }
        // 两个 pick 可能重叠（仓库根与其中一个文件夹），数据只能读一遍，先读进内存。
        // 每个要它的文件夹都还在自己的额度里，读进来的量受 `per_pick` 约束
        let mut data = Vec::new();
        if is_file {
            entry.read_to_end(&mut data)?;
        }
        let executable = entry.header().mode().is_ok_and(|m| m & 0o111 != 0);
        for i in wanted {
            let Ok(slot) = &mut slots[i] else { continue };
            if let Err(e) = slot.accept(member, &data, executable) {
                slots[i] = Err(e);
            }
        }
        Ok(Flow::Continue)
    });

    let results = slots
        .into_iter()
        .zip(picks)
        .map(|(slot, pick)| {
            let slot = slot?;
            walked.clone()?;
            slot.finish(pick)
        })
        .collect();
    // 失败的临时目录已随 `TempDir` 删掉；这里再把为它们新建、现在空着的父目录收回
    for dir in created_parents {
        let _ = fs::remove_dir(dir);
    }
    results
}

/// 一个 pick 的解包进度：临时目录与仓库内路径分段
struct Slot {
    comps: Vec<OsString>,
    tmp: tempfile::TempDir,
    /// 包里有这个文件夹下的条目
    matched: bool,
    /// 落进这个文件夹的文件一共多大（条目头里的大小）
    bytes: u64,
}

impl Slot {
    /// 校验仓库内路径与落点，建父目录（新建的记进 `created_parents`，深的在前），
    /// 在父目录里建临时目录——与落点同盘，最后一步 `rename` 才是原子的
    fn prepare(pick: &Pick, created_parents: &mut Vec<PathBuf>) -> MarketResult<Slot> {
        let comps = pick_components(&pick.path)?;
        let (Some(parent), Some(_)) = (pick.dest.parent(), pick.dest.file_name()) else {
            return Err(crate::t!(
                "market.archive.badDest",
                path = pick.dest.display()
            ));
        };
        if !pick.dest.is_absolute() {
            return Err(crate::t!(
                "market.archive.badDest",
                path = pick.dest.display()
            ));
        }
        if fs::symlink_metadata(&pick.dest).is_ok() {
            return Err(crate::t!(
                "market.archive.destTaken",
                path = pick.dest.display()
            ));
        }
        let mut missing = Vec::new();
        let mut cur = parent;
        while fs::symlink_metadata(cur).is_err() {
            missing.push(cur.to_path_buf());
            match cur.parent() {
                Some(p) if !p.as_os_str().is_empty() => cur = p,
                _ => break,
            }
        }
        let made = fs::create_dir_all(parent);
        // 先登记再看结果：create_dir_all 半途失败时已建的那几层也要收回
        created_parents.extend(missing);
        created_parents.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        made.map_err(|e| {
            crate::t!(
                "market.archive.mkParentFailed",
                path = parent.display(),
                error = e
            )
        })?;
        let tmp = tempfile::Builder::new()
            .prefix(".sophia-extract-")
            .tempdir_in(parent)
            .map_err(|e| crate::t!("market.archive.mkTempFailed", error = e))?;
        Ok(Slot {
            comps,
            tmp,
            matched: false,
            bytes: 0,
        })
    }

    /// 收下一条落在这个文件夹里的条目
    fn accept(&mut self, member: &Member, data: &[u8], executable: bool) -> MarketResult<()> {
        self.matched = true;
        let sub = &member.rel[self.comps.len()..];
        let shown = member.display();
        match member.kind {
            EntryType::Directory => {
                if !sub.is_empty() {
                    let dir = self.tmp.path().join(join(sub));
                    fs::create_dir_all(&dir).map_err(|e| write_err(&shown, e))?;
                }
                Ok(())
            }
            EntryType::Regular | EntryType::Continuous => {
                if sub.is_empty() {
                    return Err(crate::t!("market.archive.notFolder", shown = shown));
                }
                let file = self.tmp.path().join(join(sub));
                write_file(&file, data, executable).map_err(|e| write_err(&shown, e))
            }
            EntryType::Symlink => Err(crate::t!("market.archive.symlink", shown = shown)),
            EntryType::Link => Err(crate::t!("market.archive.hardlink", shown = shown)),
            EntryType::Char | EntryType::Block | EntryType::Fifo => {
                Err(crate::t!("market.archive.device", shown = shown))
            }
            _ => Err(crate::t!("market.archive.unknownType", shown = shown)),
        }
    }

    /// 校验有 `SKILL.md`，整目录改名到落点
    fn finish(self, pick: &Pick) -> MarketResult<()> {
        let shown = if pick.path.is_empty() {
            crate::t!("market.archive.repoRoot")
        } else {
            pick.path.clone()
        };
        if !self.matched {
            return Err(crate::t!("market.archive.noFolder", shown = shown));
        }
        let skill_md = fs::symlink_metadata(self.tmp.path().join("SKILL.md"));
        if !skill_md.is_ok_and(|m| m.is_file()) {
            return Err(crate::t!("market.archive.noSkillMd", shown = shown));
        }
        // 临时目录建出来是 0700，放到位前改成普通文件夹的权限
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.tmp.path(), fs::Permissions::from_mode(0o755))
                .map_err(|e| crate::t!("market.archive.chmodFailed", error = e))?;
        }
        // 解包期间落点可能被别处占了；rename 会盖掉空目录，这里再看一次
        if fs::symlink_metadata(&pick.dest).is_ok() {
            return Err(crate::t!(
                "market.archive.destTaken",
                path = pick.dest.display()
            ));
        }
        fs::rename(self.tmp.path(), &pick.dest).map_err(|e| {
            crate::t!(
                "market.archive.placeFailed",
                path = pick.dest.display(),
                error = e
            )
        })?;
        let _ = self.tmp.keep();
        Ok(())
    }
}

/// 仓库内路径 → 分段；`.`、`..`、`\`、空段都不认。空串＝仓库根
fn pick_components(path: &str) -> MarketResult<Vec<OsString>> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Ok(Vec::new());
    }
    path.split('/')
        .map(|seg| {
            let bad = seg.is_empty() || seg == "." || seg == ".." || seg.contains(['\\', '\0']);
            if bad {
                Err(crate::t!("market.archive.badPath", path = path))
            } else {
                Ok(OsString::from(seg))
            }
        })
        .collect()
}

fn join(parts: &[OsString]) -> PathBuf {
    parts.iter().collect()
}

fn write_err(shown: &str, e: io::Error) -> String {
    crate::t!("market.archive.writeFailed", shown = shown, error = e)
}

/// 新建文件写入；同名已存在（包里重复的条目）即报错，不覆盖
fn write_file(path: &Path, data: &[u8], executable: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create_new(path)?;
    file.write_all(data)?;
    // git 只记可执行位；只保留这一位，别的（setuid 之类）一概不要
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

/// 包里的一条，路径已去掉顶层 `<repo>-<分支>/` 并校验过
struct Member {
    kind: EntryType,
    /// 仓库内路径分段；pax 全局头与顶层目录本身为空
    rel: Vec<OsString>,
}

impl Member {
    fn display(&self) -> String {
        join(&self.rel).to_string_lossy().replace('\\', "/")
    }
}

enum Flow {
    Continue,
    Stop,
}

/// 从头解压走一遍包。解压总量超过 `limit`、路径不安全、包本身坏了都是整包的错
fn walk<F>(archive: &[u8], limit: u64, mut visit: F) -> MarketResult<()>
where
    F: FnMut(&mut tar::Entry<'_, Capped<GzDecoder<&[u8]>>>, &Member) -> io::Result<Flow>,
{
    let over = Rc::new(Cell::new(false));
    let reader = Capped {
        inner: GzDecoder::new(archive),
        left: limit,
        over: over.clone(),
    };
    let mut tar = tar::Archive::new(reader);
    let io_err = |e: io::Error| {
        if over.get() {
            crate::t!("market.archive.repoTooBig", mb = limit / (1024 * 1024))
        } else {
            crate::t!("market.archive.unpackFailed", error = e)
        }
    };
    for entry in tar.entries().map_err(io_err)? {
        let mut entry = entry.map_err(io_err)?;
        let kind = entry.header().entry_type();
        let rel = if kind.is_pax_global_extensions() {
            Vec::new()
        } else {
            let path = entry.path().map_err(io_err)?.into_owned();
            safe_components(&path)
                .ok_or_else(|| crate::t!("market.archive.unsafePath", path = path.display()))?
        };
        let member = Member { kind, rel };
        match visit(&mut entry, &member).map_err(io_err)? {
            Flow::Continue => {}
            Flow::Stop => break,
        }
    }
    Ok(())
}

/// 包内路径 → 去掉顶层目录后的分段。绝对路径、`..`、盘符都返回 None；`.` 忽略
fn safe_components(path: &Path) -> Option<Vec<OsString>> {
    let mut parts = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Normal(p) => parts.push(p.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    // 反斜杠在 Windows 上是分隔符；在别处它只是文件名的一部分，但包里出现就不认
    if parts.iter().any(|p| contains_backslash(p)) {
        return None;
    }
    if !parts.is_empty() {
        parts.remove(0);
    }
    Some(parts)
}

fn contains_backslash(p: &OsStr) -> bool {
    p.as_encoded_bytes().contains(&b'\\')
}

/// 数着解压出的字节，超过上限就报错并立旗
struct Capped<R> {
    inner: R,
    left: u64,
    over: Rc<Cell<bool>>,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // 多读 1 字节才知道是不是恰好在上限处结束
        let want = (buf.len() as u64).min(self.left.saturating_add(1)) as usize;
        let n = self.inner.read(&mut buf[..want])?;
        if n as u64 > self.left {
            self.over.set(true);
            return Err(io::Error::other("超过上限")); // i18n-exempt: 内部信号，io_err 见 over 旗就换成「仓库解开后超过」那句，这句不会显示
        }
        self.left -= n as u64;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use flate2::{write::GzEncoder, Compression};

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    /// 造包用的一条。路径原样写进 tar 头，不经 `tar` crate 的校验——恶意包才造得出来
    enum E<'a> {
        Pax(&'a str),
        Dir(&'a str),
        File(&'a str, &'a str),
        Exec(&'a str, &'a str),
        Symlink(&'a str, &'a str),
        Hardlink(&'a str, &'a str),
        Char(&'a str),
        Fifo(&'a str),
        Zeros(&'a str, usize),
    }

    fn raw_header(path: &str, kind: EntryType, size: usize, mode: u32, link: &str) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        let gnu = h.as_gnu_mut().unwrap();
        gnu.name[..path.len()].copy_from_slice(path.as_bytes());
        gnu.linkname[..link.len()].copy_from_slice(link.as_bytes());
        h.set_entry_type(kind);
        h.set_size(size as u64);
        h.set_mode(mode);
        h.set_mtime(0);
        h.set_cksum();
        h
    }

    /// 一条 pax 记录：`<总长> <键>=<值>\n`，总长把自己的位数也算进去
    fn pax_record(key: &str, value: &str) -> String {
        let body = format!(" {key}={value}\n");
        let mut len = body.len() + 1;
        while format!("{len}{body}").len() != len {
            len += 1;
        }
        format!("{len}{body}")
    }

    fn tgz(entries: &[E]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for e in entries {
            let (path, kind, data, mode, link): (&str, EntryType, Vec<u8>, u32, &str) = match e {
                E::Pax(sha) => (
                    "pax_global_header",
                    EntryType::XGlobalHeader,
                    pax_record("comment", sha).into_bytes(),
                    0o666,
                    "",
                ),
                E::Dir(p) => (p, EntryType::Directory, vec![], 0o775, ""),
                E::File(p, s) => (p, EntryType::Regular, s.as_bytes().to_vec(), 0o664, ""),
                E::Exec(p, s) => (p, EntryType::Regular, s.as_bytes().to_vec(), 0o775, ""),
                E::Symlink(p, to) => (p, EntryType::Symlink, vec![], 0o777, to),
                E::Hardlink(p, to) => (p, EntryType::Link, vec![], 0o664, to),
                E::Char(p) => (p, EntryType::Char, vec![], 0o666, ""),
                E::Fifo(p) => (p, EntryType::Fifo, vec![], 0o666, ""),
                E::Zeros(p, n) => (p, EntryType::Regular, vec![0; *n], 0o664, ""),
            };
            let h = raw_header(path, kind, data.len(), mode, link);
            b.append(&h, data.as_slice()).unwrap();
        }
        let tar = b.into_inner().unwrap();
        let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    /// 像 codeload 那样：pax 全局头 + 顶层 `skills-main/` + 两个 skill 与一些别的
    fn sample() -> Vec<u8> {
        tgz(&[
            E::Pax(SHA),
            E::Dir("skills-main/"),
            E::File("skills-main/README.md", "readme"),
            E::Dir("skills-main/skills/"),
            E::Dir("skills-main/skills/pdf/"),
            E::File("skills-main/skills/pdf/SKILL.md", "---\nname: pdf\n---\n"),
            E::Dir("skills-main/skills/pdf/scripts/"),
            E::Exec("skills-main/skills/pdf/scripts/run.sh", "#!/bin/sh\n"),
            E::File("skills-main/skills/pdf/scripts/lib.py", "x = 1\n"),
            E::Dir("skills-main/skills/docx/"),
            E::File("skills-main/skills/docx/SKILL.md", "---\nname: docx\n---\n"),
            // 名字像 skill 但不是文件夹里的 SKILL.md
            E::Dir("skills-main/skills/fake/"),
            E::Dir("skills-main/skills/fake/SKILL.md/"),
            E::Symlink("skills-main/skills/linked/SKILL.md", "../pdf/SKILL.md"),
            // 同名前缀但不同文件夹，不能被 `skills/pdf` 带进去
            E::File(
                "skills-main/skills/pdf-extra/SKILL.md",
                "---\nname: x\n---\n",
            ),
        ])
    }

    /// 落点父目录里除了这些名字外什么都没有（没留临时目录）
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    fn pick(path: &str, dest: PathBuf) -> Pick {
        Pick {
            path: path.into(),
            dest,
        }
    }

    #[test]
    fn commit_sha_from_pax_global_header() {
        assert_eq!(commit_sha(&sample()), Ok(SHA.to_string()));
        let upper = tgz(&[E::Pax(&SHA.to_uppercase()), E::Dir("r-main/")]);
        assert_eq!(commit_sha(&upper), Ok(SHA.to_string()));
    }

    #[test]
    fn commit_sha_missing_or_malformed() {
        let none = tgz(&[E::Dir("r-main/"), E::File("r-main/SKILL.md", "x")]);
        assert!(commit_sha(&none).is_err());
        let short = tgz(&[E::Pax("abc123"), E::Dir("r-main/")]);
        assert!(commit_sha(&short).is_err());
        let not_hex = tgz(&[E::Pax(&"z".repeat(40)), E::Dir("r-main/")]);
        assert!(commit_sha(&not_hex).is_err());
        assert!(commit_sha(b"not a gzip").is_err());
    }

    #[test]
    fn lists_skill_dirs() {
        assert_eq!(
            skill_dirs(&sample()),
            Ok(vec![
                "skills/docx".to_string(),
                "skills/pdf".to_string(),
                "skills/pdf-extra".to_string(),
            ])
        );
        // skill 就在仓库根：空串
        let root = tgz(&[
            E::Pax(SHA),
            E::Dir("r-main/"),
            E::File("r-main/SKILL.md", "x"),
            E::File("r-main/a/b/SKILL.md", "x"),
        ]);
        assert_eq!(
            skill_dirs(&root),
            Ok(vec!["".to_string(), "a/b".to_string()])
        );
    }

    #[test]
    fn skill_dirs_rejects_unsafe_archive() {
        let evil = tgz(&[E::Dir("r-main/"), E::File("r-main/../x/SKILL.md", "x")]);
        assert!(skill_dirs(&evil).unwrap_err().contains("不安全的路径"));
    }

    #[test]
    fn extracts_picks_into_place() {
        let t = TempTree::new();
        // 父目录还不存在：会被建出来
        let store = t.root().join(".agents/skills");
        let results = extract(
            &sample(),
            &[
                pick("skills/pdf", store.join("pdf")),
                pick("skills/docx/", store.join("docx")),
            ],
        );
        assert_eq!(results, vec![Ok(()), Ok(())]);
        assert_eq!(names(&store), vec!["docx", "pdf"]);
        let pdf = store.join("pdf");
        assert_eq!(names(&pdf), vec!["SKILL.md", "scripts"]);
        assert_eq!(names(&pdf.join("scripts")), vec!["lib.py", "run.sh"]);
        assert_eq!(
            fs::read_to_string(pdf.join("SKILL.md")).unwrap(),
            "---\nname: pdf\n---\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&pdf.join("scripts/run.sh")) & 0o111, 0o111);
            assert_eq!(mode(&pdf.join("scripts/lib.py")) & 0o111, 0);
            assert_eq!(mode(&pdf), 0o755);
        }
    }

    #[test]
    fn extracts_repo_root() {
        let t = TempTree::new();
        let archive = tgz(&[
            E::Pax(SHA),
            E::Dir("one-main/"),
            E::File("one-main/SKILL.md", "---\nname: one\n---\n"),
            E::File("one-main/ref/a.md", "a"),
        ]);
        let dest = t.root().join("one");
        assert_eq!(extract(&archive, &[pick("", dest.clone())]), vec![Ok(())]);
        assert_eq!(names(&dest), vec!["SKILL.md", "ref"]);
    }

    #[test]
    fn never_overwrites_existing_dest() {
        let t = TempTree::new();
        let store = t.dir("store");
        let existing = t.skill("store/pdf");
        let results = extract(&sample(), &[pick("skills/pdf", existing.clone())]);
        assert!(results[0].as_ref().unwrap_err().contains("已经有同名"));
        assert_eq!(names(&existing), vec!["SKILL.md"]);
        assert_eq!(names(&store), vec!["pdf"]);

        // 两个 pick 落到同一处：先到的放下，后一个报错
        let dest = store.join("docx");
        let results = extract(
            &sample(),
            &[
                pick("skills/docx", dest.clone()),
                pick("skills/pdf", dest.clone()),
            ],
        );
        assert_eq!(results[0], Ok(()));
        assert!(results[1].as_ref().unwrap_err().contains("已经有同名"));
        assert_eq!(
            fs::read_to_string(dest.join("SKILL.md")).unwrap(),
            "---\nname: docx\n---\n"
        );
        assert_eq!(names(&store), vec!["docx", "pdf"]);
    }

    #[test]
    fn missing_folder_or_skill_md_leaves_nothing() {
        let t = TempTree::new();
        let store = t.root().join("new/store");
        let results = extract(
            &sample(),
            &[
                pick("skills/nope", store.join("nope")),
                // SKILL.md 是个文件夹，不算
                pick("skills/fake", store.join("fake")),
                pick("README.md", store.join("readme")),
            ],
        );
        assert!(results[0]
            .as_ref()
            .unwrap_err()
            .contains("没有 skills/nope"));
        assert!(results[1].as_ref().unwrap_err().contains("没有 SKILL.md"));
        assert!(results[2].as_ref().unwrap_err().contains("不是文件夹"));
        // 为这次建的父目录也收回了
        assert!(fs::symlink_metadata(t.root().join("new")).is_err());
        assert!(names(&t.root()).is_empty());
    }

    #[test]
    fn rejects_bad_pick_paths() {
        let t = TempTree::new();
        for bad in [
            "../skills/pdf",
            "skills/../pdf",
            "skills//pdf",
            "./skills",
            "a\\b",
        ] {
            let results = extract(&sample(), &[pick(bad, t.root().join("x"))]);
            assert!(results[0].as_ref().unwrap_err().contains("不合法"), "{bad}");
        }
        let results = extract(&sample(), &[pick("skills/pdf", PathBuf::from("pdf"))]);
        assert!(results[0].as_ref().unwrap_err().contains("落点不合法"));
        assert!(names(&t.root()).is_empty());
    }

    /// AC18：含 `../x` 与软链接的恶意包，拒绝解包，落点不留任何文件
    #[test]
    fn rejects_parent_dir_entries_anywhere() {
        let t = TempTree::new();
        let store = t.dir("a/b/store");
        let archive = tgz(&[
            E::Pax(SHA),
            E::Dir("r-main/"),
            E::File("r-main/skills/pdf/SKILL.md", "x"),
            E::Symlink("r-main/skills/pdf/evil", "/etc/passwd"),
            // 不在要取的文件夹里也不行：整包不认
            E::File("r-main/../../x", "pwned"),
        ]);
        let results = extract(&archive, &[pick("skills/pdf", store.join("pdf"))]);
        assert!(results[0].is_err());
        assert!(names(&store).is_empty());
        assert!(fs::symlink_metadata(t.root().join("a/x")).is_err());
        assert!(fs::symlink_metadata(t.root().join("a/b/x")).is_err());

        let sneaky = tgz(&[
            E::Dir("r-main/"),
            E::File("r-main/skills/pdf/SKILL.md", "x"),
            E::File("r-main/skills/pdf/../../../x", "pwned"),
        ]);
        let results = extract(&sneaky, &[pick("skills/pdf", store.join("pdf"))]);
        assert!(results[0].as_ref().unwrap_err().contains("不安全的路径"));
        assert!(names(&store).is_empty());
        assert_eq!(names(&t.root()), vec!["a"]);
    }

    #[test]
    fn rejects_absolute_entries() {
        let t = TempTree::new();
        let target = t.root().join("pwned");
        let abs = format!("{}", target.display());
        let archive = tgz(&[
            E::Dir("r-main/"),
            E::File("r-main/SKILL.md", "x"),
            E::File(&abs, "pwned"),
        ]);
        let dest = t.root().join("skill");
        let results = extract(&archive, &[pick("", dest.clone())]);
        assert!(results[0].as_ref().unwrap_err().contains("不安全的路径"));
        assert!(fs::symlink_metadata(&target).is_err());
        assert!(fs::symlink_metadata(&dest).is_err());
        assert!(names(&t.root()).is_empty());
    }

    /// 软链接、硬链接、设备文件落进要取的文件夹就拒绝那一个；别处的不碰
    #[test]
    fn rejects_links_and_devices_inside_pick() {
        let t = TempTree::new();
        let store = t.dir("store");
        let archive = tgz(&[
            E::Pax(SHA),
            E::Dir("r-main/"),
            E::File("r-main/sym/SKILL.md", "x"),
            E::Symlink("r-main/sym/data", "/etc/passwd"),
            E::File("r-main/hard/SKILL.md", "x"),
            E::Hardlink("r-main/hard/data", "r-main/hard/SKILL.md"),
            E::File("r-main/dev/SKILL.md", "x"),
            E::Char("r-main/dev/tty"),
            E::File("r-main/fifo/SKILL.md", "x"),
            E::Fifo("r-main/fifo/pipe"),
            E::File("r-main/ok/SKILL.md", "x"),
            // 不在任何 pick 里的软链接：不影响
            E::Symlink("r-main/elsewhere", "/etc"),
        ]);
        let results = extract(
            &archive,
            &["sym", "hard", "dev", "fifo", "ok"].map(|p| pick(p, store.join(p))),
        );
        assert!(results[0].as_ref().unwrap_err().contains("软链接"));
        assert!(results[1].as_ref().unwrap_err().contains("硬链接"));
        assert!(results[2].as_ref().unwrap_err().contains("设备文件"));
        assert!(results[3].as_ref().unwrap_err().contains("设备文件"));
        assert_eq!(results[4], Ok(()));
        assert_eq!(names(&store), vec!["ok"]);
    }

    #[test]
    fn rejects_oversize_archive() {
        let t = TempTree::new();
        let archive = tgz(&[
            E::Dir("r-main/"),
            E::File("r-main/SKILL.md", "x"),
            E::Zeros("r-main/big.bin", 64 * 1024),
        ]);
        let dest = t.root().join("big");
        let results = extract_capped(
            &archive,
            &[pick("", dest.clone())],
            32 * 1024,
            MAX_SKILL_BYTES,
        );
        assert!(results[0].as_ref().unwrap_err().contains("超过"));
        assert!(names(&t.root()).is_empty());
        // 上限够大时照常放下
        let results = extract_capped(
            &archive,
            &[pick("", dest.clone())],
            1024 * 1024,
            MAX_SKILL_BYTES,
        );
        assert_eq!(results, vec![Ok(())]);
    }

    /// 选中的文件夹解开后超过 50MB：拒绝，落点不留东西；同一包里别的小文件夹照装
    #[test]
    fn picked_folder_over_max_skill_bytes_is_refused() {
        let t = TempTree::new();
        let archive = tgz(&[
            E::Dir("r-main/"),
            E::File("r-main/big/SKILL.md", "x"),
            E::Zeros("r-main/big/zeros", MAX_SKILL_BYTES as usize + 1),
            E::File("r-main/small/SKILL.md", "x"),
        ]);
        let results = extract(
            &archive,
            &[
                pick("big", t.root().join("big")),
                pick("small", t.root().join("small")),
            ],
        );
        assert_eq!(
            results[0].as_ref().unwrap_err(),
            "这个 skill 解开后超过 50MB"
        );
        assert_eq!(results[1], Ok(()));
        assert_eq!(names(&t.root()), ["small"]);
    }

    /// 仓库大、选中的 skill 小（2026-09-29 真机：orca-cli）：仓库别处 60MB，选中的文件夹照装；
    /// 列 skill 与读提交 SHA 也不因仓库大而失败
    #[test]
    fn big_repo_with_small_picked_skill_installs() {
        let t = TempTree::new();
        let archive = tgz(&[
            E::Dir("r-main/"),
            E::Zeros("r-main/assets/video.bin", 60 * 1024 * 1024),
            E::File("r-main/skills/orca/SKILL.md", "x"),
        ]);
        let results = extract(&archive, &[pick("skills/orca", t.root().join("orca"))]);
        assert_eq!(results, vec![Ok(())]);
        assert_eq!(skill_dirs(&archive).unwrap(), ["skills/orca"]);
    }

    /// 整包解压流超过上限（压缩炸弹）：三个入口都拒绝。用小上限造，真实上限 1GB 只是兜底
    #[test]
    fn unpacked_stream_over_limit_is_refused() {
        let t = TempTree::new();
        let bomb = tgz(&[
            E::Dir("r-main/"),
            E::File("r-main/SKILL.md", "x"),
            E::Zeros("r-main/elsewhere/zeros", 256 * 1024),
        ]);
        let results = extract_capped(
            &bomb,
            &[pick("", t.root().join("bomb"))],
            64 * 1024,
            MAX_SKILL_BYTES,
        );
        assert!(results[0].as_ref().unwrap_err().contains("仓库解开后超过"));
        assert!(names(&t.root()).is_empty());
    }

    #[test]
    fn corrupt_archive_fails_every_pick() {
        let t = TempTree::new();
        let mut broken = sample();
        broken.truncate(broken.len() / 2);
        let results = extract(
            &broken,
            &[
                pick("skills/pdf", t.root().join("pdf")),
                pick("skills/docx", t.root().join("docx")),
            ],
        );
        assert!(results.iter().all(|r| r.is_err()));
        assert!(extract(b"garbage", &[pick("", t.root().join("g"))])[0].is_err());
        assert!(names(&t.root()).is_empty());
    }
}

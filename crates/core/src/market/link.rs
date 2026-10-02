//! GitHub 链接解析（R6，T1 负责）：`owner/repo`、`https://github.com/owner/repo`、
//! `…/tree/<分支>/<路径>`、指向某个 `SKILL.md` 的 `…/blob/…` 四种写法 → `GithubRef`；
//! 认不出即报 `unrecognized()`，不发请求。另有由 `GithubRef` 拼出各处网址的纯函数，网络层与前端离开键共用。
//!
//! 分支名里带 `/`（如 `feature/x`）时，`…/tree/feature/x/skills/pdf` 光看链接分不清哪几段是分支：
//! 这里一律取 `tree` / `blob` 后的第一段当分支、其余当路径。网络层按这个分支取不到时，
//! 可以把路径的前几段依次挪进分支再试。
use super::{GithubRef, MarketResult};

/// 认不出的链接：输入框下一行原样显示这一句
pub fn unrecognized() -> String {
    crate::t!("market.link.unrecognized")
}

/// 解析用户贴进来的链接或 `owner/repo`。前后空白忽略
///
/// 认的写法（`http` / `https`、带不带 `www.`、带不带协议头、末尾有没有 `/`、`?` 与 `#` 之后都不管）：
/// - `owner/repo`、`owner/repo.git`
/// - `https://github.com/owner/repo`、`….git`
/// - `https://github.com/owner/repo/tree/<分支>`、`…/tree/<分支>/<路径>`
/// - `https://github.com/owner/repo/blob/<分支>/<路径>/SKILL.md` → 路径取 `SKILL.md` 所在的文件夹
pub fn parse(input: &str) -> MarketResult<GithubRef> {
    parse_inner(input.trim()).ok_or_else(unrecognized)
}

fn parse_inner(s: &str) -> Option<GithubRef> {
    if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    // 协议头：只认 http / https
    let (rest, has_scheme) = match s.find("://") {
        Some(i) => {
            let scheme = &s[..i];
            if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") {
                return None;
            }
            (&s[i + 3..], true)
        }
        None => (s, false),
    };
    // `?` 与 `#` 之后是查询串和锚点，与仓库位置无关
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let mut raw: Vec<&str> = rest.split('/').collect();

    // 有协议头时第一段必须是 GitHub；没协议头时第一段是 GitHub 也照认（`github.com/o/r`）
    let first_is_host = raw.first().is_some_and(|h| is_github_host(h));
    if has_scheme && !first_is_host {
        return None;
    }
    let bare = !first_is_host;
    if first_is_host {
        raw.remove(0);
    }
    // 多余的 `/`（末尾的、重复的）不算一段
    let segs: Vec<&str> = raw.into_iter().filter(|p| !p.is_empty()).collect();
    if segs.len() < 2 || (bare && segs.len() != 2) {
        return None;
    }

    let owner = segs[0];
    let repo = segs[1].strip_suffix(".git").unwrap_or(segs[1]);
    if !valid_owner(owner) || !valid_repo(repo) {
        return None;
    }
    let (branch, path) = match (segs.len(), segs.get(2).copied()) {
        (2, _) => (None, None),
        // `tree/<分支>[/<路径>]`：分支取第一段（见模块说明）
        (n, Some("tree")) if n >= 4 => (Some(decode_segment(segs[3])?), join_path(&segs[4..])?),
        // `blob/<分支>[/<路径>]/SKILL.md`：路径取它所在的文件夹
        (n, Some("blob")) if n >= 5 && segs[n - 1].eq_ignore_ascii_case("SKILL.md") => {
            (Some(decode_segment(segs[3])?), join_path(&segs[4..n - 1])?)
        }
        _ => return None,
    };
    Some(GithubRef {
        owner: owner.to_string(),
        repo: repo.to_string(),
        branch,
        path,
    })
}

fn is_github_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("github.com") || host.eq_ignore_ascii_case("www.github.com")
}

/// GitHub 用户名 / 组织名：字母数字与 `-`，不以 `-` 开头，最长 39
fn valid_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner.len() <= 39
        && !owner.starts_with('-')
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 仓库名：字母数字与 `-` `_` `.`，不能是 `.` / `..`，最长 100
fn valid_repo(repo: &str) -> bool {
    !repo.is_empty()
        && repo.len() <= 100
        && repo != "."
        && repo != ".."
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 路径各段解码后用 `/` 连起来；没有段时为 None（仓库根）
fn join_path(segs: &[&str]) -> Option<Option<String>> {
    if segs.is_empty() {
        return Some(None);
    }
    let parts = segs
        .iter()
        .map(|s| decode_segment(s))
        .collect::<Option<Vec<_>>>()?;
    Some(Some(parts.join("/")))
}

/// 一段路径或分支名：按 URL 百分号编码解码；解出 `.`、`..`、`/`、`\`、控制字符都不认，
/// 这些之后会拿去当包里的路径
fn decode_segment(seg: &str) -> Option<String> {
    let bytes = seg.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let text = String::from_utf8(out).ok()?;
    let bad = text.is_empty()
        || text == "."
        || text == ".."
        || text
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control());
    (!bad).then_some(text)
}

/// 整个仓库某分支的 tar.gz：`https://codeload.github.com/{repo}/tar.gz/refs/heads/{branch}`
pub fn codeload_url(repo: &str, branch: &str) -> String {
    format!("https://codeload.github.com/{repo}/tar.gz/refs/heads/{branch}")
}

/// 介绍页正文（R5B）：`https://raw.githubusercontent.com/{repo}/{branch}/{path}/SKILL.md`，
/// 不占 GitHub 接口次数。`path` 为空（skill 在仓库根）时没有中间那一段
pub fn raw_skill_md_url(repo: &str, branch: &str, path: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{repo}/{branch}/{}SKILL.md",
        dir_prefix(path)
    )
}

/// `在 GitHub 打开 ↗`：`https://github.com/{repo}/tree/{branch}/{path}`（路径空时到仓库首页）
pub fn tree_page_url(repo: &str, branch: &str, path: &str) -> String {
    if path.is_empty() {
        format!("https://github.com/{repo}")
    } else {
        format!("https://github.com/{repo}/tree/{branch}/{path}")
    }
}

/// `看改动 ↗`（R15）：`https://github.com/{repo}/commits/{branch}/{path}`
pub fn commits_page_url(repo: &str, branch: &str, path: &str) -> String {
    format!("https://github.com/{repo}/commits/{branch}/{path}")
        .trim_end_matches('/')
        .to_string()
}

/// 非空路径后面补一个 `/`
fn dir_prefix(path: &str) -> String {
    if path.is_empty() {
        String::new()
    } else {
        format!("{path}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gref(owner: &str, repo: &str, branch: Option<&str>, path: Option<&str>) -> GithubRef {
        GithubRef {
            owner: owner.into(),
            repo: repo.into(),
            branch: branch.map(Into::into),
            path: path.map(Into::into),
        }
    }

    #[test]
    fn parses_owner_repo_shorthand() {
        let want = gref("anthropics", "skills", None, None);
        for input in [
            "anthropics/skills",
            "  anthropics/skills \n",
            "anthropics/skills/",
            "anthropics/skills.git",
        ] {
            assert_eq!(parse(input), Ok(want.clone()), "{input:?}");
        }
        assert_eq!(
            parse("my-org/repo_name.js"),
            Ok(gref("my-org", "repo_name.js", None, None))
        );
    }

    #[test]
    fn parses_repo_home_links() {
        let want = gref("anthropics", "skills", None, None);
        for input in [
            "https://github.com/anthropics/skills",
            "https://github.com/anthropics/skills/",
            "https://github.com/anthropics/skills//",
            "https://github.com/anthropics/skills.git",
            "http://github.com/anthropics/skills",
            "https://www.github.com/anthropics/skills",
            "HTTPS://GitHub.com/anthropics/skills",
            "github.com/anthropics/skills",
            "www.github.com/anthropics/skills/",
            "https://github.com/anthropics/skills?tab=readme-ov-file#readme",
            "https://github.com/anthropics/skills#skills",
        ] {
            assert_eq!(parse(input), Ok(want.clone()), "{input:?}");
        }
    }

    #[test]
    fn parses_tree_links() {
        assert_eq!(
            parse("https://github.com/anthropics/skills/tree/main/skills/pdf"),
            Ok(gref(
                "anthropics",
                "skills",
                Some("main"),
                Some("skills/pdf")
            ))
        );
        assert_eq!(
            parse("https://github.com/anthropics/skills/tree/main/skills/pdf/"),
            Ok(gref(
                "anthropics",
                "skills",
                Some("main"),
                Some("skills/pdf")
            ))
        );
        assert_eq!(
            parse("http://www.github.com/o/r/tree/dev"),
            Ok(gref("o", "r", Some("dev"), None))
        );
        assert_eq!(
            parse("https://github.com/o/r/tree/v1.2.0/"),
            Ok(gref("o", "r", Some("v1.2.0"), None))
        );
        // 百分号编码按段解开
        assert_eq!(
            parse("https://github.com/o/r/tree/main/my%20skills/%E4%B8%AD%E6%96%87"),
            Ok(gref("o", "r", Some("main"), Some("my skills/中文")))
        );
    }

    /// 分支名带 `/` 时分不清：第一段当分支，其余当路径（模块说明里写明，网络层可重试）
    #[test]
    fn slash_branch_takes_first_segment() {
        assert_eq!(
            parse("https://github.com/o/r/tree/feature/x/skills/pdf"),
            Ok(gref("o", "r", Some("feature"), Some("x/skills/pdf")))
        );
    }

    #[test]
    fn parses_blob_skill_md_links() {
        assert_eq!(
            parse("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"),
            Ok(gref(
                "anthropics",
                "skills",
                Some("main"),
                Some("skills/pdf")
            ))
        );
        // skill 在仓库根
        assert_eq!(
            parse("https://github.com/o/r/blob/main/SKILL.md"),
            Ok(gref("o", "r", Some("main"), None))
        );
        assert_eq!(
            parse("github.com/o/r/blob/dev/a/b/skill.md?plain=1#L3"),
            Ok(gref("o", "r", Some("dev"), Some("a/b")))
        );
    }

    #[test]
    fn rejects_everything_else() {
        for input in [
            "",
            "   ",
            "https://example.com",
            "https://example.com/owner/repo",
            "https://gitlab.com/o/r",
            "https://github.com",
            "https://github.com/",
            "https://github.com/anthropics",
            "anthropics",
            "o/r/tree/main/x",
            "o/r/extra",
            "ftp://github.com/o/r",
            "ssh://git@github.com/o/r.git",
            "git@github.com:o/r.git",
            "https://user@github.com/o/r",
            "https://github.com:443/o/r",
            "https://gist.github.com/o/abc",
            "https://raw.githubusercontent.com/o/r/main/SKILL.md",
            "https://github.com/o/r/issues/1",
            "https://github.com/o/r/pulls",
            "https://github.com/o/r/tree",
            "https://github.com/o/r/tree/",
            "https://github.com/o/r/blob/main/README.md",
            "https://github.com/o/r/blob/main",
            "https://github.com/o/r/blob/SKILL.md",
            "https://github.com/o/r/tree/main/../etc",
            "https://github.com/o/r/tree/main/a/%2E%2E/b",
            "https://github.com/o/r/tree/main/a%2Fb",
            "https://github.com/o/r/tree/main/a%5Cb",
            "https://github.com/o/r/tree/main/bad%zz",
            "https://github.com/o/r/tree/main/%FF",
            "https://github.com/o/r/tree/../x",
            "o r/skills",
            "-o/r",
            "o/..",
            "o/.git",
            "o_o/r",
            "o/r;rm",
            "https://github.com/o/r\tree",
        ] {
            assert_eq!(parse(input), Err(unrecognized()), "{input:?}");
        }
    }

    #[test]
    fn page_urls() {
        assert_eq!(
            raw_skill_md_url("anthropics/skills", "main", "skills/pdf"),
            "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md"
        );
        assert_eq!(
            raw_skill_md_url("o/r", "main", ""),
            "https://raw.githubusercontent.com/o/r/main/SKILL.md"
        );
        assert_eq!(tree_page_url("o/r", "main", ""), "https://github.com/o/r");
        assert_eq!(
            commits_page_url("o/r", "dev", "a/b"),
            "https://github.com/o/r/commits/dev/a/b"
        );
        assert_eq!(
            codeload_url("o/r", "main"),
            "https://codeload.github.com/o/r/tar.gz/refs/heads/main"
        );
    }
}

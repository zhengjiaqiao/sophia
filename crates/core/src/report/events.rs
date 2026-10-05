//! 自动上报第二段（spec 2026-10-04-reporting-feedback R8）：Sophia 自身的错误与崩溃各传一条事件——去隐私后的原文
//! 与调用栈，按「出错位置」的签名合并。外部原因（网络、第三方服务、用户自己的配置）只计数，从不进这里。
//!
//! 接入点经 [`super::capture`] / [`super::capture_internal`]：上报开着才收，按出事时的本地日期记在内存里
//! （与次数同在 [`Pending`] 的锁里，同一套开关与代次判定），同一签名当天只收一次、最多 30 条。应用侧的
//! [`super::Reporter`] 定时把它并进 `report-events.json`，再逐条发 `POST /v1/event`。
//! 崩溃时进程马上就没了：崩溃钩子把已去隐私的崩溃记录追加到 `report-crash.log`，下次启动读进队列再删掉。
use super::{day_number, local_day, unix_now, Kind, Pending, Retry, MAX_AGE_DAYS};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::Ordering;

/// 数据目录下没发出去的事件与当天已收过的签名
pub const EVENTS_FILE: &str = "report-events.json";
/// 崩溃钩子追加已去隐私的崩溃记录的旁文件（数据目录下），下次启动读进队列后删掉
pub const CRASH_FILE: &str = "report-crash.log";
/// 队列（内存里、文件里各自）最多这么多条；满了丢新的
pub const MAX_QUEUED: usize = 30;
/// 一条事件正文的上限（字节，按 UTF-8 字符边界截）。接收服务收 32 KB，留足余量
pub const BODY_MAX_BYTES: usize = 24 * 1024;

/// 崩溃记录每一段的开头（`diagnostics::crash_report` 的格式）
const CRASH_HEADER: &str = "==== panic ====";

/// 一条要上传的事件
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// 出事那一刻的本地日期 `YYYY-MM-DD`（本地去重用；接收服务按自己收到时的 UTC 日记）
    pub day: String,
    pub kind: Kind,
    /// `<类别>:<12 位十六进制>`，见 [`signature`]
    pub signature: String,
    /// 去隐私、限长后的原文与调用栈
    pub body: String,
    /// 出事时的应用版本（崩溃取崩溃记录里的 `version:`）；空的发送时用当时的
    #[serde(default)]
    pub version: String,
    /// 出事时的系统大版本（`macOS 15`）；空的发送时用当时的
    #[serde(default)]
    pub os: String,
}

impl Event {
    /// `location` 是出错位置（崩溃、内部错误用 `文件:行`；网页侧为空），`text` 是原文
    pub fn new(kind: Kind, location: &str, text: &str, day: String) -> Self {
        Self {
            day,
            kind,
            signature: signature(kind, location, text),
            body: body(text),
            version: String::new(),
            os: String::new(),
        }
    }

    fn same(&self, other: &Event) -> bool {
        self.day == other.day && self.signature == other.signature
    }
}

/// 签名：`<类别>:<12 位十六进制>`，哈希输入是类别、出错位置与 [`normalize`] 过的原文。
/// 同一处的同一个错误换了路径、数字、引号里的值，签名不变
pub fn signature(kind: Kind, location: &str, text: &str) -> String {
    use sha1::{Digest, Sha1};
    // 只看开头：区分错误靠消息与栈顶，整段超长的原文不必全算
    let normalized = normalize(head(text, SIGNATURE_INPUT_BYTES));
    let mut hasher = Sha1::new();
    for part in [kind.name(), location, normalized.as_str()] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let hash: String = hasher
        .finalize()
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}:{hash}", kind.name())
}

/// 算签名时原文最多看这么多字节
const SIGNATURE_INPUT_BYTES: usize = 8 * 1024;

/// 签名用的归一化：先去隐私，再把引号里的内容、网址与路径、长十六进制、数字串换成占位，空白并成一个空格
pub fn normalize(text: &str) -> String {
    let text = quoted(&crate::redact::redact_full(text));
    text.split_whitespace()
        .map(word)
        .collect::<Vec<_>>()
        .join(" ")
}

/// 一行里成对的 `"…"` 与 `'…'` 换成 `"_"`。单引号前面紧挨着字母数字的是撇号（`can't`），不算
fn quoted(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let opens = c == '"' || (c == '\'' && (i == 0 || !chars[i - 1].is_alphanumeric()));
        if opens {
            if let Some(len) = chars[i + 1..]
                .iter()
                .take_while(|&&x| x != '\n')
                .position(|&x| x == c)
            {
                out.push(c);
                out.push('_');
                out.push(c);
                i += len + 2;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 一个词：带 `://` 的是网址，带 `/` 或 `\` 的是路径，整个换成占位（两头的括号、标点留着）；
/// 别的词里的长十六进制与数字串换成占位
fn word(w: &str) -> String {
    let edge = |c: char| "()[]{}<>,;:\"'`".contains(c);
    let core = w.trim_matches(edge);
    if !core.is_empty() && (core.contains('/') || core.contains('\\')) {
        let start = w.find(core).unwrap_or(0);
        let masked = match core.find("://") {
            // 网址（WebKit 栈帧 `函数@tauri://localhost/assets/index-<哈希>.js:行:列`）：前面的函数名留着，
            // 地址只留去掉内容哈希、行列号的文件名（复审 P2：不同函数的错误不能并成一个签名）
            Some(at) => {
                let scheme = core[..at]
                    .char_indices()
                    .rfind(|&(_, c)| !(c.is_ascii_alphanumeric() || "+.-".contains(c)))
                    .map_or(0, |(i, c)| i + c.len_utf8());
                format!(
                    "{}<url:{}>",
                    numbers(&core[..scheme]),
                    url_file(&core[scheme..])
                )
            }
            None => "<path>".to_owned(),
        };
        return format!("{}{masked}{}", &w[..start], &w[start + core.len()..]);
    }
    numbers(w)
}

/// 网址的文件名：去掉查询与片段、`:行:列`、文件名里的内容哈希（`index-B3xK9a1Z.js` → `index.js`），数字换占位
fn url_file(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let mut leaf = path.rsplit('/').next().unwrap_or("");
    for _ in 0..2 {
        match leaf.rsplit_once(':') {
            Some((head, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
                leaf = head
            }
            _ => break,
        }
    }
    numbers(&without_content_hash(leaf))
}

/// `名字-<哈希>.扩展名` → `名字.扩展名`。哈希：6 位以上的 `[A-Za-z0-9_]`，带数字或大写字母
/// （`markdown-renderer.js` 的 `renderer` 不算）
fn without_content_hash(leaf: &str) -> String {
    let (stem, ext) = leaf.rsplit_once('.').unwrap_or((leaf, ""));
    let Some((name, hash)) = stem.rsplit_once('-') else {
        return leaf.to_owned();
    };
    let hashlike = hash.len() >= 6
        && hash.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && hash
            .bytes()
            .any(|b| b.is_ascii_digit() || b.is_ascii_uppercase());
    match (hashlike, ext.is_empty()) {
        (false, _) => leaf.to_owned(),
        (true, true) => name.to_owned(),
        (true, false) => format!("{name}.{ext}"),
    }
}

/// `0x…` 与 8 位以上、两头不连着字母数字的十六进制串 → `<hex>`；其余的数字串 → `#`
fn numbers(w: &str) -> String {
    let chars: Vec<char> = w.chars().collect();
    let mut out = String::with_capacity(w.len());
    let mut i = 0;
    while i < chars.len() {
        let before_ok = i == 0 || !chars[i - 1].is_ascii_alphanumeric();
        let run = |from: usize| {
            chars[from..]
                .iter()
                .take_while(|c| c.is_ascii_hexdigit())
                .count()
        };
        if before_ok && chars[i] == '0' && matches!(chars.get(i + 1), Some('x' | 'X')) {
            let n = run(i + 2);
            if n > 0 {
                out.push_str("<hex>");
                i += 2 + n;
                continue;
            }
        }
        if before_ok && chars[i].is_ascii_hexdigit() {
            let n = run(i);
            let after_ok = chars.get(i + n).is_none_or(|c| !c.is_ascii_alphanumeric());
            if n >= 8 && after_ok && chars[i..i + n].iter().any(char::is_ascii_digit) {
                out.push_str("<hex>");
                i += n;
                continue;
            }
        }
        if chars[i].is_ascii_digit() {
            out.push('#');
            while chars.get(i).is_some_and(char::is_ascii_digit) {
                i += 1;
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 事件正文：去隐私、绝对路径与 `~` 开头的路径只留文件名（[`file_names_only`]），再按 UTF-8 字符边界截到
/// [`BODY_MAX_BYTES`]（截过的末尾补一行 `…`）
pub fn body(text: &str) -> String {
    // 先粗截一刀免得超长文本白算（同 `redact::redact`），留足余量免得把跨界的密钥切成认不出的半截
    let clean = file_names_only(&crate::redact::redact_full(head(text, BODY_MAX_BYTES * 4)));
    if clean.len() <= BODY_MAX_BYTES {
        return clean;
    }
    const MORE: &str = "\n…";
    format!("{}{MORE}", head(&clean, BODY_MAX_BYTES - MORE.len()))
}

/// 事件正文里的路径（复审 P1 隐私：项目名、目录名不发）。先还原 JSON 转义的 `\/` 与 URL 编码（`%25` 最多三层，
/// 再 `%2F`、`%7E`），再找路径——不看前一个字符是什么（第二轮复审：`error:~/x`、`file://主机/…` 曾绕过）：
/// - `file://…` 整个地址；`~/` 与用户机器上常见的绝对路径前缀（[`USER_PATH_PREFIXES`]）出现在任何位置；
///   Windows 盘符 `C:\`；反斜杠与斜杠一样算分隔（第三轮）；
/// - 其余以 `/` 开头、前面不连着路径字符的（`:` 之后也算，只有 `://` 不算，网址的路径部分本来就连着主机名）。
///
/// 路径到哪结束（第四轮复审：偏保守的一条规则，见 [`path_len`]）：吞到换行、与路径前紧挨着的开引号相配的闭引号、
/// `: ` / `, ` / `; `（标点后跟空白）或文本结尾；空格、括号、组合音标与其他字符都算路径的一部分。末尾的空白与
/// 单个 `:`、`.` 留在外面。以分隔符结尾的是目录，整个写成 `…`；否则末段整体是「名字.扩展名」且扩展名在
/// [`FILE_EXTENSIONS`] 里的写成 `…/末段`（行列号跟着），别的写成 `…`。
/// 照留：标准库与依赖、工具链（[`KEPT_PATHS`]，不含 `..` 时），编译期的相对源码路径（`src-tauri/…`、`./…`），
/// 网页侧的地址（`tauri://localhost/assets/…`）。处理过的正文再处理一遍不变。只用在事件正文上，
/// 日志的去隐私（`redact`）不变
fn file_names_only(text: &str) -> String {
    let text = unescape_slashes(text);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(c) = text[i..].chars().next() {
        let tail = &text[i..];
        let file_url = tail
            .get(..7)
            .is_some_and(|head| head.eq_ignore_ascii_case("file://"));
        if !file_url && !path_starts(&text[..i], tail) {
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let end = i + path_len(&text[..i], tail);
        let path = &text[i..end];
        if file_url {
            out.push_str(&path[..7]);
            out.push_str(&shorten(&path[7..]));
        } else if KEPT_PATHS.iter().any(|kept| path.starts_with(kept)) && !path.contains("..") {
            out.push_str(path);
        } else {
            out.push_str(&shorten(path));
        }
        i = end;
    }
    out
}

/// 用户机器上的绝对路径前缀：在正文任何位置出现都当路径（反斜杠写法也算）
const USER_PATH_PREFIXES: [&str; 13] = [
    "/Users/",
    "/Volumes/",
    "/private/",
    "/var/",
    "/tmp/",
    "/home/",
    "/opt/",
    "/Applications/",
    "/Library/",
    "/System/",
    "/root/",
    "/mnt/",
    "/media/",
];

/// 照留的路径前缀：标准库、依赖与工具链（构建机上的，不是用户的）；含 `..` 的不算
const KEPT_PATHS: [&str; 3] = ["/rustc/", "~/.cargo/registry/", "~/.rustup/toolchains/"];

/// 末段的扩展名在这里面才当文件名留下（不分大小写），别的（`Acme.co`、`Secret.Project`）当目录名，整个不要。
/// `app` 留着：应用包虽是目录，名字是应用名（`Xcode.app`），不是用户的项目名，排查时有用
const FILE_EXTENSIONS: [&str; 46] = [
    "json", "jsonl", "toml", "yaml", "yml", "md", "txt", "log", "plist", "js", "mjs", "cjs", "ts",
    "tsx", "jsx", "rs", "py", "sh", "zsh", "html", "css", "csv", "xml", "sqlite", "db", "zip",
    "png", "jpg", "jpeg", "gif", "svg", "pdf", "conf", "cfg", "ini", "env", "lock", "dmg", "app",
    "tmp", "bak", "gz", "tar", "pem", "exe", "dll",
];

/// `\/` → `/`；`%25` → `%`（最多三层），再 `%2F` / `%2f` → `/`，`%7E` / `%7e` → `~`
fn unescape_slashes(text: &str) -> String {
    let mut text = text.replace("\\/", "/");
    for _ in 0..3 {
        if !text.contains("%25") {
            break;
        }
        text = text.replace("%25", "%");
    }
    text.replace("%2F", "/")
        .replace("%2f", "/")
        .replace("%7E", "~")
        .replace("%7e", "~")
}

/// 这里是不是一段路径的开头（前缀表、`~/`、盘符不看前面；兜底的 `/…` 看前面）
fn path_starts(before: &str, tail: &str) -> bool {
    // 开头几个字符里的反斜杠当斜杠看
    let head: String = tail
        .chars()
        .take(16)
        .map(|c| if c == '\\' { '/' } else { c })
        .collect();
    head.starts_with("~/")
        || USER_PATH_PREFIXES.iter().any(|p| head.starts_with(p))
        || drive_letter(before, &head, tail)
        || (tail.starts_with('/') && path_may_start_after(before, tail))
}

/// Windows 盘符 `C:\…`、`C:\\…`（JSON 转义）、`C:/…`（前面不连着字母数字；字面的 `c://` 是网址，不算）
fn drive_letter(before: &str, head: &str, tail: &str) -> bool {
    let b = head.as_bytes();
    b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && b[2] == b'/'
        && tail.get(2..4) != Some("//")
        && before
            .chars()
            .next_back()
            .is_none_or(|p| !p.is_ascii_alphanumeric())
}

/// 不在前缀表里的 `/…`：前面不连着路径字符才算路径开头（`a/b`、`./x` 是相对路径）；`://` 是网址，不算；
/// 只有一个 `/` 的不算
fn path_may_start_after(before: &str, tail: &str) -> bool {
    let second = tail[1..].chars().next();
    if tail.starts_with("//") || second.is_none_or(|c| !(c.is_alphanumeric() || "._-~".contains(c)))
    {
        return false;
    }
    before.chars().next_back().is_none_or(|p| !joins_path(p))
}

/// 从开头起这段路径有多长（第五、六轮复审），只看这一行：
/// - 路径前紧挨着开引号（`"`、`'`、`` ` ``）：到这一行里最后一个相配的闭引号为止（中间的撇号、逗号、空格都算
///   路径）；这一行没有相配的闭引号就到行尾。
/// - 没有引号：最后一个 `/` 或 `\` 之前的一律算路径；末段到 `: `（冒号加空白，或冒号在行尾）或行尾为止——
///   `, `、`; ` 不算终点（文件夹名里常有逗号）。同一行后面再有别的文字一并遮掉，宁可多遮。
///
/// 末尾的空白与单个 `:`、`.` 留在外面
fn path_len(before: &str, tail: &str) -> usize {
    let line_end = tail.find(['\n', '\r']).unwrap_or(tail.len());
    let line = &tail[..line_end];
    let quote = before.chars().next_back().filter(|c| "\"'`".contains(*c));
    let mut end = match quote {
        Some(q) => line
            .char_indices()
            .skip(1)
            .filter(|&(_, c)| c == q)
            .last()
            .map_or(line_end, |(j, _)| j),
        None => {
            let leaf_start = line.rfind(['/', '\\']).map_or(0, |k| k + 1);
            let leaf = &line[leaf_start..];
            let mut chars = leaf.char_indices().peekable();
            let mut end = line_end;
            while let Some((j, c)) = chars.next() {
                if c == ':' && chars.peek().is_none_or(|&(_, next)| next.is_whitespace()) {
                    end = leaf_start + j;
                    break;
                }
            }
            end
        }
    };
    end = tail[..end].trim_end().len();
    if end > 1 && tail[..end].ends_with([':', '.']) {
        end -= 1;
    }
    end
}

/// 连在 `/` 前面就说明这不是路径的开头：字母数字与常见的文件名字符，以及 `…`（处理过的 `…/文件名` 再处理不变）
fn joins_path(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._-~/\\@%+…".contains(c)
}

/// 一段路径 → `…/末段`（末段整体是「名字.扩展名」、扩展名在 [`FILE_EXTENSIONS`] 里；行列号跟着）或 `…`。
/// 以分隔符结尾的是目录，`…`。斜杠反斜杠都算分隔
fn shorten(path: &str) -> String {
    if path.ends_with(['/', '\\']) {
        return "…".to_owned();
    }
    let leaf = path.rsplit(['/', '\\']).next().unwrap_or(path);
    // 末尾的 `:行:列` 先拿掉再判断
    let mut name = leaf;
    for _ in 0..2 {
        match name.rsplit_once(':') {
            Some((head, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
                name = head
            }
            _ => break,
        }
    }
    let file_like = name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty() && FILE_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))
    });
    if file_like {
        format!("…/{leaf}")
    } else {
        "…".to_owned()
    }
}

/// 前 `max` 个字节，往前退到字符边界
pub(super) fn head(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// 崩溃旁文件（一段或几段 `crash_report`）→ 崩溃事件，记在 `day`。签名用每段的 `location`（去掉列号）与 `message`
pub fn crash_events(text: &str, day: &str) -> Vec<Event> {
    text.split(CRASH_HEADER)
        .filter(|block| !block.trim().is_empty())
        .take(MAX_QUEUED)
        .map(|block| {
            let field = |name: &str| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix(name))
                    .unwrap_or("")
                    .trim()
            };
            let location = without_column(field("location:"));
            let message = field("message:");
            Event {
                day: day.to_owned(),
                kind: Kind::Panic,
                signature: signature(Kind::Panic, location, message),
                body: body(&format!("{CRASH_HEADER}{}", block.trim_end())),
                version: field("version:").to_owned(),
                os: os_major(field("os:")),
            }
        })
        .collect()
}

/// 崩溃记录里的系统描述（`macOS Version 15.1 (Build 24B83) aarch64`）→ 大版本 `macOS 15`；认不出为空
/// （发送时用当时的）
fn os_major(described: &str) -> String {
    let Some(rest) = described.strip_prefix("macOS ") else {
        return String::new();
    };
    let digits: String = rest
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        String::new()
    } else {
        format!("macOS {digits}")
    }
}

/// `文件:行:列` → `文件:行`（同一行上不同列的同一个错误算一处）；不是这个形状原样
fn without_column(location: &str) -> &str {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match location.rsplit_once(':') {
        Some((head, col))
            if digits(col) && head.rsplit_once(':').is_some_and(|(_, l)| digits(l)) =>
        {
            head
        }
        _ => location,
    }
}

/// 队列里加一条：同日同签名已有、或满了就不加
fn push_unique(queue: &mut Vec<Event>, event: Event) -> bool {
    if queue.len() >= MAX_QUEUED || queue.iter().any(|e| e.same(&event)) {
        return false;
    }
    queue.push(event);
    true
}

impl Pending {
    /// 应用侧启动时交来应用版本与系统大版本（`macOS 15`），之后收的事件记下它们
    pub fn set_app_info(&self, version: &str, os: &str) {
        let mut state = self.state();
        state.app_version = version.to_owned();
        state.app_os = os.to_owned();
    }

    /// 记一次异常并收一条事件（只收 Sophia 自身的四类；外部原因只计数）。上报关着时什么都不做
    pub fn capture(&self, kind: Kind, location: &str, text: &str) {
        self.capture_at(kind, location, text, unix_now());
    }

    /// 记在 `unix_secs` 那一刻的本地日期上
    pub fn capture_at(&self, kind: Kind, location: &str, text: &str, unix_secs: u64) {
        self.capture_at_with(kind, location, text, unix_secs, || {}, || {});
    }

    /// 与 [`Pending::count_at_with`] 同一套判定：第一件事读开关代次；拿到锁时开关已关、或代次变了，丢掉。
    /// 计数与入队在同一把锁里、按同一次代次判定（复审 P1：分两步判定，中间关掉又打开，旧原文会进新的一段）。
    /// 签名与正文（去隐私）在拿锁之前算。`first` / `between` 是测试插入开关切换的口子
    pub(super) fn capture_at_with(
        &self,
        kind: Kind,
        location: &str,
        text: &str,
        unix_secs: u64,
        first: impl FnOnce(),
        between: impl FnOnce(),
    ) {
        let generation = self.generation.load(Ordering::SeqCst);
        first();
        if !self.enabled() {
            return;
        }
        let day = local_day(unix_secs, self.offset_secs.load(Ordering::Relaxed));
        let event = kind
            .is_own()
            .then(|| Event::new(kind, location, text, day.clone()));
        between();
        {
            let mut state = self.state();
            if !state.enabled || state.generation != generation {
                return;
            }
            state.days.entry(day).or_default().add(kind, 1);
            if let Some(mut event) = event {
                event.version = state.app_version.clone();
                event.os = state.app_os.clone();
                push_unique(&mut state.events, event);
            }
        }
        super::mark_scope();
    }

    /// 取出并清空内存里的事件
    pub fn take_events(&self) -> Vec<Event> {
        std::mem::take(&mut self.state().events)
    }

    /// 落盘没成：放回去（排在这期间新收的前面），下次再落。这期间关掉了就不放回
    pub fn restore_events(&self, events: Vec<Event>) {
        let mut state = self.state();
        if !state.enabled {
            return;
        }
        let newer = std::mem::take(&mut state.events);
        for event in events.into_iter().chain(newer) {
            push_unique(&mut state.events, event);
        }
    }
}

/// `report-events.json`：没发出去的事件、当天（与前一天）已收过的签名、发失败后的等待
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventsFile {
    pub queue: Vec<Event>,
    /// 本地日期 → 那天已经收过的签名（发完、丢掉之后也留着，同一天不再收）
    pub seen: BTreeMap<String, BTreeSet<String>>,
    pub retry: Retry,
}

impl EventsFile {
    /// 并进来：同日同签名只收一次（跨进程也算），满 [`MAX_QUEUED`] 条丢新的。顺手丢掉过期的
    pub fn absorb(&mut self, today: &str, events: Vec<Event>) {
        self.prune(today);
        for event in events {
            if day_number(&event.day).is_none() || self.queue.len() >= MAX_QUEUED {
                continue;
            }
            let seen = self.seen.entry(event.day.clone()).or_default();
            if seen.insert(event.signature.clone()) {
                self.queue.push(event);
            }
        }
    }

    /// 已收过的签名只留今天与昨天（午夜前出事、午夜后才落盘的那条仍按昨天去重）；队列里丢掉 30 天前的
    fn prune(&mut self, today: &str) {
        let Some(today_n) = day_number(today) else {
            return;
        };
        self.seen
            .retain(|day, _| day_number(day).is_some_and(|n| n >= today_n - 1));
        self.queue
            .retain(|e| day_number(&e.day).is_some_and(|n| today_n - n <= MAX_AGE_DAYS));
    }

    /// 这次该发的（从旧到新）：发失败后还在等就一条不发
    pub fn due(&self, now: u64) -> Vec<Event> {
        if self.retry.waiting(now) {
            return Vec::new();
        }
        self.queue.clone()
    }

    /// 接收服务处理完了（收下、满了不收、或者说这条不合格）：移出队列，失败的等待清零
    pub fn record_done(&mut self, event: &Event) {
        self.queue.retain(|e| !e.same(event));
        self.retry = Retry::default();
    }

    /// 没发出去（连不上、限流、5xx）：留在队列里，按连续失败的次数往后等
    pub fn record_failure(&mut self, now: u64) {
        self.retry.fail(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: &str = "2026-10-04";
    // 2026-10-04T15:59:50Z ＝ 东八区 23:59:50
    const BEFORE_MIDNIGHT: u64 = 1_791_129_590;
    const LOC: &str = "src-tauri/src/gateway.rs:47";

    fn pending_on() -> Pending {
        let p = Pending::new();
        p.set_local_offset(8 * 3600);
        p.set_enabled(true);
        p
    }

    fn event(signature: &str, day: &str) -> Event {
        Event {
            day: day.into(),
            kind: Kind::Internal,
            signature: signature.into(),
            body: "b".into(),
            version: String::new(),
            os: String::new(),
        }
    }

    /// 复审 P1：一次错误的计数与入队用同一次代次判定。读代次之后、拿锁之前关掉又打开，次数和事件都不落进新的一段
    #[test]
    fn a_count_and_its_event_share_one_generation() {
        let p = pending_on();
        let toggle = || {
            p.set_enabled(false);
            p.set_enabled(true);
        };
        p.capture_at_with(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT, || {}, toggle);
        assert!(p.take().is_empty(), "次数不该进新的一段");
        assert!(p.take_events().is_empty(), "事件不该进新的一段");
        p.capture_at_with(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT, toggle, || {});
        assert!(p.take().is_empty());
        assert!(p.take_events().is_empty());
        // 期间没动：一次计数、一条事件
        p.capture_at(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT);
        let days = p.take();
        assert_eq!(days.values().map(|c| c.get(Kind::Internal)).sum::<u32>(), 1);
        assert_eq!(p.take_events().len(), 1);
        // 外部原因：只计数
        p.capture_at(Kind::Network, LOC, "x", BEFORE_MIDNIGHT);
        assert_eq!(
            p.take().values().map(|c| c.get(Kind::Network)).sum::<u32>(),
            1
        );
        assert!(p.take_events().is_empty());
    }

    /// 第二轮复审 P1：绕过路径去除的写法（冒号紧跟、URL 编码、JSON 转义、`file://主机`、像文件名的目录、
    /// 白名单前缀里夹 `..`）都只剩 `…` 或 `…/文件名`
    #[test]
    fn path_stripping_is_not_bypassed() {
        for (input, want) in [
            ("error:~/work/Secret/x", "error:…"),
            ("error:/Volumes/Disk/Secret/x", "error:…"),
            ("e=%2FUsers%2Fa%2FSecret%2Fx", "e=…"),
            ("e=%2fUsers%2fa%2fSecret%2fnotes.md", "e=…/notes.md"),
            ("p %7E%2Fwork%2FSecret%2Fy.txt", "p …/y.txt"),
            (r#"{"path":"\/Users\/a\/Secret\/x"}"#, r#"{"path":"…"}"#),
            ("file://localhost/Users/a/Secret/x.html", "file://…/x.html"),
            ("file:///srv/Secret/x.html", "file://…/x.html"),
            ("/Volumes/Disk/Secret.Project", "…"),
            ("~/.codex", "…"),
            ("~/.cargo/../work/Secret/x.txt", "…/x.txt"),
            ("~/.rustup/../Secret/y.rs", "…/y.rs"),
            ("x/tmp/Secret/z.json", "x…/z.json"),
            ("at /srv/Secret/app.log:3:4", "at …/app.log:3:4"),
            ("Foo@/home/a/Secret/x.js:1:2", "Foo@…/x.js:1:2"),
            // 第三轮：路径里带空格——空格后的词还含分隔符就算同一路径
            (
                r#""/Users/alice/Work Projects/Secret/x.txt""#,
                r#""…/x.txt""#,
            ),
            (
                "open /Users/alice/Work Projects/Secret/x.txt now",
                // 第四轮：路径吞到行尾，后面的词一起遮掉（多遮可接受）
                "open …",
            ),
            // 第四轮：多个空格、括号、组合音标都算路径的一部分；以分隔符结尾的是目录
            (
                r#""/Users/alice/Work Client Projects/Secret/x.txt""#,
                r#""…/x.txt""#,
            ),
            (
                r#""/Users/alice/Work (Client)/Secret/x.txt""#,
                r#""…/x.txt""#,
            ),
            ("/Users/alice/Cafe\u{301}Client/Secret/x.txt", "…/x.txt"),
            ("/Users/alice/Work/ClientPortal.js/", "…"),
            (r"C:\Users\alice\Work\ClientPortal.js\", "…"),
            // 第四轮：常见的 Rust 错误形态
            (
                "读取 /Users/a/x.json 失败: Permission denied (os error 13)",
                "读取 …: Permission denied (os error 13)",
            ),
            (
                "No such file or directory (os error 2): /Users/a/b/c.toml",
                "No such file or directory (os error 2): …/c.toml",
            ),
            // 第六轮：没有引号时 `, ` 不算终点，末段吞到行尾（多遮可接受）
            ("open /Users/a/Work/x.txt, retrying", "open …"),
            (
                "'/Users/alice/Work Client/Secret/x.txt' missing",
                "'…/x.txt' missing",
            ),
            // 第五轮：文件夹名里的撇号与「, 」（Node 的 ENOENT 原样）；同一行最后一个分隔符之前都算路径
            (
                "ENOENT: no such file or directory, open '/Users/alice/Client's Project/Secret/x.txt'",
                "ENOENT: no such file or directory, open '…/x.txt'",
            ),
            (
                "ENOENT: no such file or directory, open '/Users/alice/Client, Inc/Secret/x.txt'",
                "ENOENT: no such file or directory, open '…/x.txt'",
            ),
            (
                "open /Users/alice/Client; Inc/Secret/x.txt: denied\nnext line",
                "open …/x.txt: denied\nnext line",
            ),
            // 第六轮：末段里的撇号、逗号（引号里到这一行最后一个相配的闭引号为止）
            (
                "ENOENT: no such file or directory, open '/Users/alice/Client's Project'",
                "ENOENT: no such file or directory, open '…'",
            ),
            (
                "ENOENT: no such file or directory, open '/Users/alice/Client, Inc'",
                "ENOENT: no such file or directory, open '…'",
            ),
            ("open '/Users/a/x.txt' failed", "open '…/x.txt' failed"),
            ("read /Users/a/Client, Inc/x.json: denied", "read …/x.json: denied"),
            (
                "failed to open /Users/alice/x.txt: permission denied",
                "failed to open …/x.txt: permission denied",
            ),
            ("see /Users/alice/Secret/x.txt.", "see …/x.txt."),
            // 第三轮：多层 URL 编码、反斜杠
            ("e=%252FUsers%252Falice%252FSecret%252Fx.txt", "e=…/x.txt"),
            (
                "e=%25252FUsers%25252Falice%25252FSecret%25252Fx.txt",
                "e=…/x.txt",
            ),
            ("e=%257E%252FWork%252FSecret%252Fx.txt", "e=…/x.txt"),
            (r"C:\Users\alice\Secret\x.txt", "…/x.txt"),
            (
                r#"{"p":"C:\\Users\\alice\\Secret\\x.txt"}"#,
                r#"{"p":"…/x.txt"}"#,
            ),
            (r"/Users/alice\Secret\x.txt", "…/x.txt"),
            (r"at ~\Work\Secret\y.json", "at …/y.json"),
            // 第三轮：末段只有常见文件扩展名才留
            ("/Volumes/Data/Acme.co", "…"),
            ("/Volumes/Data/Acme.Project.v2", "…"),
            ("/Users/alice/Work/Secret/Acme.TOML", "…/Acme.TOML"),
            ("/Applications/AcmeTool.app", "…/AcmeTool.app"),
        ] {
            let b = body(input);
            assert_eq!(b, want, "输入 {input}");
            // 应用包名是应用名、不是项目名，留着（见 `FILE_EXTENSIONS`）
            if input.ends_with(".app") || input.ends_with(".TOML") {
                continue;
            }
            for gone in [
                "Secret", "a/", "Disk", "Users", "Volumes", "srv", "alice", "Projects", "Acme",
                "Data", "Work", "Client", "Portal", "Project", "Inc",
            ] {
                assert!(!b.contains(gone), "{gone} 还在：{input} → {b}");
            }
        }
        // 照留：相对源码路径、标准库、依赖与工具链、网页侧的地址
        for kept in [
            "at ./src-tauri/src/lib.rs:12:5",
            "at src-tauri/src/gateway.rs:47",
            "at ./crates/core/src/report/mod.rs:3",
            "at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs:665:5",
            "at ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.47.1/src/a.rs:1",
            "at ~/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/src/rust/library/core/src/option.rs:2",
            "Foo@tauri://localhost/assets/index-B3xK9a1Z.js:10:20",
            "at http://tauri.localhost/assets/index.js:1:2",
            "   3: sophia_lib::gateway::blocking\n             at ./src-tauri/src/gateway.rs:339:21\n",
            "   9: std::panicking::begin_panic\n             at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs:665:5\n  10: main",
        ] {
            assert_eq!(body(kept), kept);
        }
    }

    /// 正文处理幂等：发送前对排着的旧事件再过一遍，结果不变
    #[test]
    fn body_is_idempotent() {
        for text in [
            r#""/Users/alice/Work Projects/Secret/x.txt" C:\Users\a\b.json %252Fx%252Fy.md"#,
            "读 /Users/alice/work/Secret/config.toml 失败 token=abc sk-abcdefghijklmnopqrstuvwx",
            "error:~/work/Secret/x e=%2FUsers%2Fa%2Fb.txt",
            "at /rustc/abc/library/std/src/panicking.rs:1 Foo@tauri://localhost/assets/x.js:1:2",
            &"错".repeat(20_000),
        ] {
            let once = body(text);
            assert_eq!(body(&once), once, "{text}");
        }
    }

    /// 复审 P1 隐私：正文里的绝对路径与 `~` 开头的路径只留文件名（目录名、项目名不发）；编译期的相对源码路径、
    /// 工具链路径、网页侧的地址照留
    #[test]
    fn body_keeps_only_file_names_of_absolute_and_home_paths() {
        let b = body(
            "读 /Users/alice/work/SecretProject/config.toml 失败\n\
             ~/work/SecretProject/a.json:3:4\n\
             打开 /Volumes/Data/ClientX/notes.md（只读）\n\
             tmp /private/var/folders/ab/cd1234/T/sophia-x.tmp\n\
             dir ~/work/SecretProject\n\
             失败：/opt/Hidden/bin/tool\n\
             url file:///Users/alice/Hidden/x.html\n\
             at ./src-tauri/src/lib.rs:12:5\n\
             at src-tauri/src/gateway.rs:47\n\
             at crates/core/src/report/mod.rs:3\n\
             at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs:665:5\n\
             at ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.47.1/src/runtime/park.rs:1\n\
             Foo@tauri://localhost/assets/index-B3xK9a1Z.js:10:20",
        );
        for gone in [
            "alice",
            "SecretProject",
            "ClientX",
            "folders",
            "Hidden",
            "/opt",
        ] {
            assert!(!b.contains(gone), "{gone} 还在：\n{b}");
        }
        for kept in [
            // 第四轮：路径吞到行尾，后面没有 `: ` 之类的就一起遮掉
            "读 …\n",
            "…/a.json:3:4",
            "打开 …\n",
            "…/sophia-x.tmp",
            "dir …\n",
            "失败：…\n",
            "…/x.html",
            "./src-tauri/src/lib.rs:12:5",
            "src-tauri/src/gateway.rs:47",
            "crates/core/src/report/mod.rs:3",
            "/rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs:665:5",
            "~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.47.1/src/runtime/park.rs:1",
            "Foo@tauri://localhost/assets/index-B3xK9a1Z.js:10:20",
        ] {
            assert!(b.contains(kept), "缺 {kept}：\n{b}");
        }
    }

    /// 复审 P2：WebKit 栈帧 `函数@地址:行:列` 归一化时留函数名与去掉内容哈希的文件名：不同函数不同签名，
    /// 同一函数换了哈希、行列号还是同一个
    #[test]
    fn webkit_frames_keep_function_and_file_names() {
        let sig = |frame: &str| signature(Kind::Uncaught, "", &format!("TypeError: x\n{frame}"));
        let foo = sig("Foo@tauri://localhost/assets/index-B3xK9a1Z.js:10:20");
        assert_eq!(
            foo,
            sig("Foo@tauri://localhost/assets/index-Zq8Lm2pW.js:99:1")
        );
        assert_eq!(
            foo,
            sig("Foo@http://tauri.localhost/assets/index-C0dE5x9Y.js:1:2")
        );
        assert_ne!(
            foo,
            sig("Bar@tauri://localhost/assets/index-B3xK9a1Z.js:10:20")
        );
        assert_ne!(
            foo,
            sig("Foo@tauri://localhost/assets/vendor-B3xK9a1Z.js:10:20")
        );
        let n = normalize("at Foo (tauri://localhost/assets/markdown-renderer.js:3:4)");
        assert!(
            n.contains("Foo") && n.contains("markdown-renderer.js"),
            "{n}"
        );
        assert!(!n.contains(":3"), "{n}");
    }

    /// 复审 P2：事件记下出事时的应用版本与系统大版本；崩溃事件取崩溃记录里的版本与系统
    #[test]
    fn events_record_version_and_os_at_capture_time() {
        let p = pending_on();
        p.capture_at(Kind::Internal, LOC, "before", BEFORE_MIDNIGHT);
        p.set_app_info("0.3.0", "macOS 15");
        p.capture_at(Kind::Internal, LOC, "after", BEFORE_MIDNIGHT);
        let events = p.take_events();
        assert_eq!(
            (events[0].version.as_str(), events[0].os.as_str()),
            ("", "")
        );
        assert_eq!(
            (events[1].version.as_str(), events[1].os.as_str()),
            ("0.3.0", "macOS 15")
        );

        let report = crate::diagnostics::crash_report(&crate::diagnostics::CrashInfo {
            unix_secs: 1,
            version: "0.2.9",
            os: "macOS Version 14.6.1 (Build 23G93) aarch64",
            thread: "main",
            location: Some("a.rs:1:2"),
            message: "m",
            backtrace: "",
        });
        let crash = &crash_events(&report, DAY)[0];
        assert_eq!(crash.version, "0.2.9");
        assert_eq!(crash.os, "macOS 14");
        // 旧文件里的事件没有这两项：读成空
        let old: Event = serde_json::from_str(
            r#"{"day":"2026-10-04","kind":"panic","signature":"panic:0","body":"b"}"#,
        )
        .unwrap();
        assert_eq!((old.version.as_str(), old.os.as_str()), ("", ""));
    }

    fn is_hex12(s: &str) -> bool {
        s.len() == 12
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }

    /// 同一处的同一个错误：换了用户名 / 路径 / 数字 / 引号里的值 / 地址，签名不变（AC4）
    #[test]
    fn signature_is_stable_across_paths_numbers_and_quoted_values() {
        let a = signature(
            Kind::Internal,
            LOC,
            "读 /Users/alice/.codex/config.toml 失败：os error 2，第 3 次，id \"abc\"，0x7ffd12345678，https://a.example/v1?k=1",
        );
        let b = signature(
            Kind::Internal,
            LOC,
            "读 /Users/bob/work/x/config.toml 失败：os error 13，第 15 次，id \"zzz-9\"，0x1000deadbeef，https://b.example/v2",
        );
        assert_eq!(a, b);
        let hex = a.strip_prefix("internal:").expect(&a);
        assert!(is_hex12(hex), "{a}");
        // 接收服务：可打印 ASCII、≤ 128 字节
        assert!(a.len() <= 128 && a.bytes().all(|b| (0x20..0x7f).contains(&b)));
    }

    /// 位置不同、类别不同、说的不是一回事：签名不同
    #[test]
    fn different_locations_kinds_or_messages_give_different_signatures() {
        let base = signature(Kind::Internal, LOC, "uid 读不到");
        assert_ne!(
            base,
            signature(Kind::Internal, "src-tauri/src/gateway.rs:125", "uid 读不到")
        );
        assert_ne!(base, signature(Kind::Uncaught, LOC, "uid 读不到"));
        assert_ne!(base, signature(Kind::Internal, LOC, "打不开文件"));
        assert!(signature(Kind::PageFault, "", "x").starts_with("pageFault:"));
        assert!(signature(Kind::Panic, "a.rs:1", "x").starts_with("panic:"));
    }

    #[test]
    fn normalize_masks_variable_parts() {
        let n = normalize(
            "failed at C:\\Users\\me\\a.txt and ~/x/y.rs:12:5 \"quoted 7\" 'single' can't 42 ms deadbeef1234 sk-abcdefghijklmnopqrstuvwx",
        );
        assert!(!n.chars().any(|c| c.is_ascii_digit()), "{n}");
        for gone in [
            "Users", "a.txt", "y.rs", "quoted", "single", "deadbeef", "sk-abc",
        ] {
            assert!(!n.contains(gone), "{gone} 还在：{n}");
        }
        // 撇号不是引号；一般的词留着
        assert!(n.contains("can't"), "{n}");
        assert!(n.contains("failed at"), "{n}");
        // 空白并成一个
        assert_eq!(normalize("a \n\t b"), "a b");
    }

    /// 正文去隐私（用户名、密钥都不在），超长按 UTF-8 字符边界截到上限（AC4）
    #[test]
    fn body_is_redacted_and_capped_on_a_char_boundary() {
        let b = body(
            "读 /Users/alice/x.json: 失败，key sk-abcdefghijklmnopqrstuvwx1234 Bearer abc.def",
        );
        assert!(!b.contains("/Users/alice"), "{b}");
        assert!(!b.contains("alice"), "{b}");
        assert!(!b.contains("sk-abcdefghijklmnopqrstuvwx1234"), "{b}");
        // 路径只留文件名（复审 P1），`: ` 之后的文字照留
        assert!(b.starts_with("读 …/x.json: 失败，key …"), "{b}");

        let long = "错".repeat(20_000);
        let b = body(&long);
        assert!(b.len() <= BODY_MAX_BYTES, "{}", b.len());
        assert!(b.len() > BODY_MAX_BYTES - 16);
        assert!(b.starts_with("错错"));
        // 短的原样（除去隐私）
        assert_eq!(body("plain"), "plain");
    }

    /// 关着不收；关掉时清掉还没落盘的（与次数同）
    #[test]
    fn capture_while_off_is_dropped_and_turning_off_clears() {
        let p = Pending::new();
        p.capture_at(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT);
        assert!(p.take_events().is_empty());
        p.set_enabled(true);
        p.capture_at(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT);
        p.set_enabled(false);
        p.set_enabled(true);
        assert!(p.take_events().is_empty());
    }

    /// 外部原因从不进事件队列（AC6）
    #[test]
    fn external_kinds_are_never_queued() {
        let p = pending_on();
        for kind in [
            Kind::Network,
            Kind::Upstream,
            Kind::WriteFailure,
            Kind::Auth,
        ] {
            p.capture_at(kind, LOC, "connection refused", BEFORE_MIDNIGHT);
        }
        assert!(p.take_events().is_empty());
        for kind in [Kind::Panic, Kind::PageFault, Kind::Uncaught, Kind::Internal] {
            p.capture_at(kind, LOC, "x", BEFORE_MIDNIGHT);
        }
        assert_eq!(p.take_events().len(), 4);
    }

    /// 同一签名同一天只收一次；第二天再出算新的一条；按出事那一刻的本地日期记
    #[test]
    fn same_signature_once_per_local_day() {
        let p = pending_on();
        p.capture_at(Kind::Internal, LOC, "读 /Users/a/1 失败", BEFORE_MIDNIGHT);
        p.capture_at(
            Kind::Internal,
            LOC,
            "读 /Users/b/2 失败",
            BEFORE_MIDNIGHT + 5,
        );
        p.capture_at(
            Kind::Internal,
            LOC,
            "读 /Users/c/3 失败",
            BEFORE_MIDNIGHT + 20,
        );
        let events = p.take_events();
        let days: Vec<&str> = events.iter().map(|e| e.day.as_str()).collect();
        assert_eq!(days, ["2026-10-04", "2026-10-05"]);
        assert_eq!(events[0].signature, events[1].signature);
        assert_eq!(events[0].kind, Kind::Internal);
        assert!(events[0].body.starts_with("读 …"), "{}", events[0].body);
    }

    /// 内存里最多 30 条，满了丢新的
    #[test]
    fn memory_queue_caps_at_thirty_dropping_new() {
        let p = pending_on();
        for i in 0..40 {
            p.capture_at(Kind::Internal, &format!("a.rs:{i}"), "x", BEFORE_MIDNIGHT);
        }
        let events = p.take_events();
        assert_eq!(events.len(), MAX_QUEUED);
        assert_eq!(
            events[0].signature,
            signature(Kind::Internal, "a.rs:0", "x")
        );
        assert_eq!(
            events[29].signature,
            signature(Kind::Internal, "a.rs:29", "x")
        );
    }

    /// 关掉又打开期间的一次落不进新的一段：出事那一刻先记下代次，拿到锁时不同就丢（与次数同一套）
    #[test]
    fn a_capture_racing_with_off_then_on_lands_nowhere() {
        let p = pending_on();
        let toggle = || {
            p.set_enabled(false);
            p.set_enabled(true);
        };
        p.capture_at_with(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT, toggle, || {});
        assert!(p.take_events().is_empty());
        p.capture_at_with(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT, || {}, toggle);
        assert!(p.take_events().is_empty());
        p.capture_at_with(
            Kind::Internal,
            LOC,
            "x",
            BEFORE_MIDNIGHT,
            || {},
            || p.set_enabled(false),
        );
        p.set_enabled(true);
        assert!(p.take_events().is_empty());
        p.capture_at_with(Kind::Internal, LOC, "x", BEFORE_MIDNIGHT, || {}, || {});
        assert_eq!(p.take_events().len(), 1);
    }

    /// 放回去的排在这期间新收的前面、照样去重；这期间关掉了就不放回
    #[test]
    fn restore_puts_events_back_unless_switched_off() {
        let p = pending_on();
        p.capture_at(Kind::Internal, "a.rs:1", "x", BEFORE_MIDNIGHT);
        let taken = p.take_events();
        p.capture_at(Kind::Internal, "a.rs:2", "x", BEFORE_MIDNIGHT);
        p.capture_at(Kind::Internal, "a.rs:1", "x", BEFORE_MIDNIGHT);
        p.restore_events(taken.clone());
        let back = p.take_events();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0], taken[0]);
        p.set_enabled(false);
        p.restore_events(taken);
        p.set_enabled(true);
        assert!(p.take_events().is_empty());
    }

    /// 文件里：同日同签名只收一次——发完之后也算（跨进程的「当天只传一次」）；第二天再收
    #[test]
    fn file_dedupes_per_day_even_after_sending() {
        let mut file = EventsFile::default();
        file.absorb(DAY, vec![event("internal:aaaaaaaaaaaa", DAY)]);
        file.absorb(DAY, vec![event("internal:aaaaaaaaaaaa", DAY)]);
        assert_eq!(file.queue.len(), 1);
        let sent = file.queue[0].clone();
        file.record_done(&sent);
        assert!(file.queue.is_empty());
        file.absorb(DAY, vec![event("internal:aaaaaaaaaaaa", DAY)]);
        assert!(file.queue.is_empty(), "当天发过的不再收");
        file.absorb(
            "2026-10-05",
            vec![event("internal:aaaaaaaaaaaa", "2026-10-05")],
        );
        assert_eq!(file.queue.len(), 1);
        // 前天的已收记录丢掉，昨天的留着（午夜前出事、午夜后落盘的那条仍按昨天去重）
        file.absorb("2026-10-06", vec![]);
        let days: Vec<&str> = file.seen.keys().map(String::as_str).collect();
        assert_eq!(days, ["2026-10-05"]);
    }

    /// 文件里最多 30 条，满了丢新的（也不记成已收，腾出地方后还能收）
    #[test]
    fn file_queue_caps_at_thirty() {
        let mut file = EventsFile::default();
        let many: Vec<Event> = (0..35)
            .map(|i| event(&format!("internal:{i:012x}"), DAY))
            .collect();
        file.absorb(DAY, many.clone());
        assert_eq!(file.queue.len(), MAX_QUEUED);
        assert_eq!(file.queue.last().unwrap(), &many[29]);
        file.record_done(&many[0]);
        file.absorb(DAY, vec![many[34].clone()]);
        assert_eq!(file.queue.last().unwrap(), &many[34]);
    }

    /// 发失败按 1 / 3 / 6 / 24 小时往后等；处理完一条清零；认不出的日期不收
    #[test]
    fn failures_back_off_and_done_resets() {
        let mut file = EventsFile::default();
        file.absorb(
            DAY,
            vec![event("internal:aaaaaaaaaaaa", DAY), event("x", "bad")],
        );
        assert_eq!(file.due(0).len(), 1);
        let t0 = 1_000_000;
        file.record_failure(t0);
        assert!(file.due(t0 + 3599).is_empty());
        assert_eq!(file.due(t0 + 3600).len(), 1);
        file.record_failure(t0 + 3600);
        assert!(file.due(t0 + 3600 + 3 * 3600 - 1).is_empty());
        let e = file.queue[0].clone();
        file.record_done(&e);
        assert_eq!(file.retry, Retry::default());
    }

    #[test]
    fn events_file_round_trips() {
        let mut file = EventsFile::default();
        file.absorb(DAY, vec![event("internal:aaaaaaaaaaaa", DAY)]);
        file.record_failure(5);
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["queue"][0]["kind"], serde_json::json!("internal"));
        assert_eq!(serde_json::from_value::<EventsFile>(json).unwrap(), file);
        assert_eq!(
            serde_json::from_str::<EventsFile>("{}").unwrap(),
            EventsFile::default()
        );
    }

    /// 崩溃旁文件：每段一条崩溃事件；签名按位置（去掉列号）与消息，时间、路径不同的两次崩溃同签名
    #[test]
    fn crash_file_blocks_become_panic_events() {
        use crate::diagnostics::{crash_report, CrashInfo};
        let report = |secs: u64, col: &str, path: &str| {
            crash_report(&CrashInfo {
                unix_secs: secs,
                version: "0.3.0",
                os: "macos 15",
                thread: "main",
                location: Some(&format!("src-tauri/src/lib.rs:12:{col}")),
                message: &format!("读 {path} 失败"),
                backtrace: "   0: sophia_lib::run\n   1: main\n",
            })
        };
        let text = format!(
            "{}{}",
            report(1, "5", "/Users/alice/a.json"),
            report(99_999, "9", "/Users/bob/b.json")
        );
        let events = crash_events(&text, DAY);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.kind == Kind::Panic && e.day == DAY));
        assert_eq!(events[0].signature, events[1].signature);
        assert_eq!(
            events[0].signature,
            signature(Kind::Panic, "src-tauri/src/lib.rs:12", "读 ~/a.json 失败")
        );
        assert!(
            events[0].body.starts_with("==== panic ===="),
            "{}",
            events[0].body
        );
        assert!(events[0].body.contains("sophia_lib::run"));
        assert!(!events[1].body.contains("alice"));
        // 空文件、垃圾：没有事件
        assert!(crash_events("", DAY).is_empty());
        assert!(crash_events("\n\n", DAY).is_empty());
    }
}

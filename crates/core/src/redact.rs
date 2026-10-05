//! 写进日志、复制给别人之前的去隐私（spec 2026-10-04-local-diagnostics R3、R13）。
//!
//! 规则是「按已知形状删」：家目录与 `/Users/<名>` → `~`；网址去掉查询参数、片段与账号；
//! 认证头、名字像密钥 / 令牌 / 密码的字段（`名=值`、`名: 值`、JSON `"名": "值"`）的值换成 `…`；
//! 长得像密钥的串（`sk-…`、JWT `eyJ…` 等）换成 `…`。单条限长。

/// 单条日志的上限（按字符计）
pub const MAX_CHARS: usize = 4000;

/// 去隐私并限长：写日志、复制详情都走它
pub fn redact(text: &str) -> String {
    // 先粗截一刀免得超长文本白算：截掉的部分本来就会被限长丢掉，留足余量免得把跨界的密钥切成认不出的半截
    cap(redact_full(truncate(text, MAX_CHARS * 4)), MAX_CHARS)
}

/// 只去隐私、不限长：崩溃记录带完整调用栈，按条限长会截掉大半
pub fn redact_full(text: &str) -> String {
    let text = urls(text);
    let text = home_paths(&text);
    let text = named_values(&text);
    let text = bearer_tokens(&text);
    key_shaped(&text)
}

const MASK: &str = "…";

/// 名字像凭据：MCP 详情与日志共用一份
pub(crate) fn secretish(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    [
        "key", "token", "secret", "password", "auth", "bearer", "cookie",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// URL 里的凭据：查询串与 `#` 片段里的值换成 `…`、键留着（`?api_key=…`、`#access_token=…`）；
/// 地址里的账号密码（`https://user:pass@host`）整段换成 `…:…@`，账号本身也可能是令牌，一并不给。
/// MCP 详情用它（键留着好认）；日志更严，查询串整段不要（见 `clean_url`）
pub(crate) fn url_without_secrets(url: &str) -> String {
    let (url, fragment) = match url.split_once('#') {
        Some((url, fragment)) => (url, Some(fragment)),
        None => (url, None),
    };
    let (base, query) = match url.split_once('?') {
        Some((base, query)) => (base, Some(query)),
        None => (url, None),
    };
    let mut out = match base.split_once("://") {
        Some((scheme, rest)) => {
            let end = rest.find('/').unwrap_or(rest.len());
            match rest[..end].rsplit_once('@') {
                Some((userinfo, host)) => {
                    let masked = if userinfo.contains(':') {
                        "…:…"
                    } else {
                        "…"
                    };
                    format!("{scheme}://{masked}@{host}{}", &rest[end..])
                }
                None => base.to_owned(),
            }
        }
        None => base.to_owned(),
    };
    let mask_pairs = |part: &str| {
        part.split('&')
            .map(|pair| match pair.split_once('=') {
                Some((key, _)) => format!("{key}=…"),
                None => pair.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("&")
    };
    if let Some(query) = query {
        out = format!("{out}?{}", mask_pairs(query));
    }
    if let Some(fragment) = fragment {
        out = format!("{out}#{}", mask_pairs(fragment));
    }
    out
}

/// 日志里的网址：账号密码按 `url_without_secrets` 换掉，查询串与片段整段不要，只留一个 `…` 表示删过
fn clean_url(url: &str) -> String {
    let (url, fragment) = match url.split_once('#') {
        Some((url, _)) => (url, true),
        None => (url, false),
    };
    let (base, query) = match url.split_once('?') {
        Some((base, _)) => (base, true),
        None => (url, false),
    };
    let mut out = url_without_secrets(base);
    if query {
        out.push_str("?…");
    }
    if fragment {
        out.push_str("#…");
    }
    out
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

/// 按字符限长，截过的末尾补 `…`
fn cap(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}{MASK}", &text[..i]),
        None => text,
    }
}

/// 文本里的 `scheme://…`：到空白或引号、尖括号为止算一个网址
/// 网址（`://` 之后从 `from` 起）到空白或引号、尖括号为止
fn url_end(text: &str, from: usize) -> usize {
    text[from..]
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`'))
        .map_or(text.len(), |n| from + n)
}

fn urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("://") {
        let scheme_len = rest[..pos]
            .bytes()
            .rev()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
            .count();
        let start = pos - scheme_len;
        let end = url_end(rest, pos + 3);
        out.push_str(&rest[..start]);
        if scheme_len == 0 {
            out.push_str(&rest[start..end]);
        } else {
            out.push_str(&clean_url(&rest[start..end]));
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// 路径里一段名字的字符：除了分隔符、空白、引号括号与标点都算。用户名可以是中文、全角英数字、
/// 半角片假名；CJK 符号区与全半角区里只有标点（不是字母数字的）当分隔
fn path_name_char(c: char) -> bool {
    let cjk_punct =
        matches!(c, '\u{3000}'..='\u{303f}' | '\u{ff00}'..='\u{ffef}') && !c.is_alphanumeric();
    !(c.is_whitespace()
        || c.is_control()
        || cjk_punct
        || matches!(
            c,
            '/' | '\\'
                | '"'
                | '\''
                | '`'
                | '<'
                | '>'
                | ':'
                | ','
                | ';'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
        ))
}

/// 行内空白：空格与制表符（换行不算，免得把下一行吃进值里）
fn inline_space(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

/// 家目录前缀与任意 `/Users/<名>` 换成 `~`（`/Users/Shared` 不是用户名，留着）
fn home_paths(text: &str) -> String {
    let mut text = text.to_owned();
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy();
        if home.len() > 1 {
            text = replace_at_boundary(&text, home.trim_end_matches('/'), "~");
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(pos) = rest.find("/Users/") {
        let after = &rest[pos + "/Users/".len()..];
        let name_len = after
            .find(|c: char| !path_name_char(c))
            .unwrap_or(after.len());
        let name = &after[..name_len];
        out.push_str(&rest[..pos]);
        if name.is_empty() || name == "Shared" {
            out.push_str("/Users/");
            rest = after;
        } else {
            out.push('~');
            rest = &after[name_len..];
        }
    }
    out.push_str(rest);
    out
}

/// `needle` 出现、且后面不是还连着名字（`/Users/al` 不吃掉 `/Users/alice` 的前半）的地方换掉
fn replace_at_boundary(text: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(needle) {
        let end = pos + needle.len();
        out.push_str(&rest[..pos]);
        if rest[end..].chars().next().is_some_and(path_name_char) {
            out.push_str(needle);
        } else {
            out.push_str(with);
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn field_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
}

/// 分隔符（`=` / `:`）前面的字段名：JSON 的 `"名"`，或一串名字字符（与分隔符之间可以隔着空格、制表符）。
/// 宁可多遮：一句话里像凭据的词后面跟冒号，冒号后的词也当值遮掉
/// 返回名字与它是不是带引号的 JSON 键（带引号的，值可以在下一行）
fn name_before(text: &str, delim: usize) -> Option<(&str, bool)> {
    let bytes = text.as_bytes();
    // 带引号的 JSON 键与冒号之间可以隔着换行
    let mut end = delim;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    if end > 0 && bytes[end - 1] == b'"' {
        let open = text[..end - 1].rfind('"')?;
        return Some((&text[open + 1..end - 1], true));
    }
    let mut end = delim;
    while end > 0 && inline_space(bytes[end - 1]) {
        end -= 1;
    }
    if end > 0 && bytes[end - 1] == b'"' {
        let open = text[..end - 1].rfind('"')?;
        return Some((&text[open + 1..end - 1], true));
    }
    let len = text[..end]
        .bytes()
        .rev()
        .take_while(|&b| field_name_byte(b))
        .count();
    (len > 0).then(|| (&text[end - len..end], false))
}

const AUTH_SCHEMES: &[&str] = &["bearer", "basic", "token", "digest"];

fn bare_value_end(text: &str, from: usize) -> usize {
    text[from..]
        .find(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    ',' | ';' | '&' | '"' | '\'' | ')' | ']' | '}' | '<' | '>'
                )
        })
        .map_or(text.len(), |n| from + n)
}

/// 从 `start` 的引号起找收尾引号：返回收尾引号的位置与是否找到。双引号里认反斜杠转义；
/// 单引号是 TOML 字面量字符串，没有转义。字符串不跨行：碰到换行就算没收尾，停在换行处
fn string_end(bytes: &[u8], start: usize) -> (usize, bool) {
    let quote = bytes[start];
    let mut i = start + 1;
    while i < bytes.len() && bytes[i] != b'\n' {
        if bytes[i] == quote {
            return (i, true);
        }
        let escaped = quote == b'"' && bytes[i] == b'\\' && bytes.get(i + 1) != Some(&b'\n');
        i += if escaped { 2 } else { 1 };
    }
    (i.min(bytes.len()), false)
}

/// 对象 / 数组值的结尾（含收尾括号）：按括号配对，跳过字符串里的括号（见 `string_end`）。可以跨行
/// （排版过的 JSON）。配不上（被截断）就一直遮到末尾：宁可多遮。崩溃记录按段去隐私、日志按条限长，
/// 多遮也只到这一段为止。紧跟在字母数字后面的引号（`can't`）是撇号，不当字符串开头
fn bracket_end(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0usize;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' if !bytes[i - 1].is_ascii_alphanumeric() => i = string_end(bytes, i).0,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

/// 值的范围（字符串不含引号；对象 / 数组含括号，整个换掉）。值是空的不动；值在下一行时，
/// 只有 `multiline`（带引号的 JSON 键，排版成多行）才往下找，不带引号的 `名: 值` 只认同一行
fn value_span(text: &str, from: usize, multiline: bool) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut start = from;
    while start < bytes.len()
        && (inline_space(bytes[start]) || (multiline && matches!(bytes[start], b'\n' | b'\r')))
    {
        start += 1;
    }
    let first = *bytes.get(start)?;
    match first {
        b'\n' | b'\r' => None,
        b'{' | b'[' => Some((start, bracket_end(bytes, start))),
        b'"' | b'\'' => {
            // 没有收尾引号（被截断）：一直遮到末尾
            let end = match string_end(bytes, start) {
                (end, true) => end,
                (_, false) => bytes.len(),
            };
            (end > start + 1).then_some((start + 1, end))
        }
        _ => {
            let mut end = bare_value_end(text, start);
            if end == start {
                return None;
            }
            // `Authorization: Bearer xxx`：认证方式后面那一截也是值
            if AUTH_SCHEMES.contains(&text[start..end].to_ascii_lowercase().as_str()) {
                let mut token = end;
                while token < bytes.len() && inline_space(bytes[token]) {
                    token += 1;
                }
                let next = bare_value_end(text, token);
                if token > end && next > token {
                    end = next;
                }
            }
            Some((start, end))
        }
    }
}

/// 名字像凭据的 `名=值`、`名: 值`、JSON `"名": "值"`：值换成 `…`
fn named_values(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        // 跳过网址的主机那一段（账号@主机:端口）：`主机:端口` 不是 `名: 值`，账号 `urls` 已经处理过。
        // 路径照常扫，`/api_key=x` 这样的照样遮
        if bytes[i..].starts_with(b"://") {
            let end = url_end(text, i + 3);
            i = text[i + 3..end]
                .find(['/', '?', '#'])
                .map_or(end, |n| i + 3 + n);
            continue;
        }
        let b = bytes[i];
        let delim = match b {
            // Rust 路径 `a::b`、网址 `x:/`、比较 `==` 都不是字段
            b':' => {
                !(bytes.get(i + 1).is_some_and(|&n| n == b':' || n == b'/')
                    || (i > 0 && bytes[i - 1] == b':'))
            }
            b'=' => {
                !(bytes.get(i + 1) == Some(&b'=')
                    || (i > 0 && matches!(bytes[i - 1], b'=' | b'!' | b'<' | b'>')))
            }
            _ => false,
        };
        let named = delim
            .then(|| name_before(text, i))
            .flatten()
            .filter(|(name, _)| secretish(name));
        if let Some((_, quoted)) = named {
            if let Some((start, end)) = value_span(text, i + 1, quoted) {
                out.push_str(&text[copied..start]);
                out.push_str(MASK);
                copied = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// 不带名字的 `Bearer xxx`
fn bearer_tokens(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    let bytes = text.as_bytes();
    while let Some(n) = lower[from..].find("bearer") {
        let pos = from + n;
        let mut token_start = pos + "bearer".len();
        from = token_start;
        let boundary = pos == 0 || !bytes[pos - 1].is_ascii_alphanumeric();
        let spaced = bytes.get(token_start).copied().is_some_and(inline_space);
        while token_start < bytes.len() && inline_space(bytes[token_start]) {
            token_start += 1;
        }
        let end = bare_value_end(text, token_start);
        if !boundary || !spaced || end == token_start || &text[token_start..end] == MASK {
            continue;
        }
        out.push_str(&text[copied..token_start]);
        out.push_str(MASK);
        copied = end;
        from = end;
    }
    out.push_str(&text[copied..]);
    out
}

const KEY_PREFIXES: &[&str] = &[
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "AIza",
];

/// 长得像密钥的一串（服务商常见前缀，或 JWT）
fn key_like(token: &str) -> bool {
    token.len() >= 20
        && (KEY_PREFIXES.iter().any(|p| token.starts_with(p))
            || (token.starts_with("eyJ") && token.contains('.')))
}

fn key_shaped(text: &str) -> String {
    let token_byte = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.');
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !token_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && token_byte(bytes[i]) {
            i += 1;
        }
        if key_like(&text[start..i]) {
            out.push_str(&text[copied..start]);
            out.push_str(MASK);
            copied = i;
        }
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> String {
        dirs::home_dir().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn home_dir_prefix_becomes_tilde() {
        let text = format!("打不开 {}/.codex/config.toml：拒绝", home());
        assert_eq!(redact(&text), "打不开 ~/.codex/config.toml：拒绝");
    }

    #[test]
    fn any_users_dir_becomes_tilde() {
        assert_eq!(
            redact("读 /Users/alice/Library/x.json 失败；又见 \"/Users/bob\""),
            "读 ~/Library/x.json 失败；又见 \"~\""
        );
        // 系统共享目录不是用户名
        assert_eq!(redact("/Users/Shared/a"), "/Users/Shared/a");
        // Codex 复审的复现串：用户名含非 ASCII 字符
        assert_eq!(redact("/Users/张三/project/a.json"), "~/project/a.json");
        assert_eq!(redact("/Users/alice张/project/a.json"), "~/project/a.json");
        assert_eq!(redact("打不开 '/Users/bob.smith'：x"), "打不开 '~'：x");
        // Codex 复审第二轮：全角英数字、半角片假名也是用户名的一部分；全角标点照样是分隔
        assert_eq!(redact("/Users/Ａlice/project"), "~/project");
        assert_eq!(redact("/Users/aliceＡ/project"), "~/project");
        assert_eq!(redact("/Users/ｱﾘｽ１/project"), "~/project");
        assert_eq!(redact("读 /Users/bob：失败"), "读 ~：失败");
    }

    #[test]
    fn url_query_fragment_and_userinfo_are_dropped() {
        assert_eq!(
            redact("GET https://api.example.com/v1/models?token=abc&x=1 → 401"),
            "GET https://api.example.com/v1/models?… → 401"
        );
        assert_eq!(
            redact("打开 https://user:pass@host.example/cb#access_token=zzz 了"),
            "打开 https://…:…@host.example/cb#… 了"
        );
        assert_eq!(
            redact("见 http://127.0.0.1:8080/v1"),
            "见 http://127.0.0.1:8080/v1"
        );
    }

    #[test]
    fn authorization_header_and_bearer_are_removed() {
        assert_eq!(
            redact("Authorization: Bearer abc.def.ghi"),
            "Authorization: …"
        );
        assert_eq!(
            redact("authorization: Basic dXNlcjpwYXNz"),
            "authorization: …"
        );
        assert_eq!(redact("带上 Bearer xyz123 去请求"), "带上 Bearer … 去请求");
    }

    #[test]
    fn secretish_name_value_pairs_are_masked() {
        assert_eq!(
            redact("OPENAI_API_KEY=abc123 PATH=/bin"),
            "OPENAI_API_KEY=… PATH=/bin"
        );
        assert_eq!(redact("--token=abc --verbose"), "--token=… --verbose");
        assert_eq!(
            redact("password: hunter2, user: bob"),
            "password: …, user: bob"
        );
        assert_eq!(redact("x-api-key:abc"), "x-api-key:…");
        assert_eq!(redact("secret='a b c' next"), "secret='…' next");
        assert_eq!(
            redact("api_key = \"abc\"\nmodel = \"gpt\""),
            "api_key = \"…\"\nmodel = \"gpt\""
        );
    }

    #[test]
    fn json_secret_values_are_masked() {
        assert_eq!(
            redact(r#"{"api_key": "sk-1", "model": "gpt", "token":"t", "n": 3}"#),
            r#"{"api_key": "…", "model": "gpt", "token":"…", "n": 3}"#
        );
        assert_eq!(
            redact(r#"{"password": "a \"quoted\" pw", "ok": true}"#),
            r#"{"password": "…", "ok": true}"#
        );
        // 名字像凭据、值是对象或数组：整个值换掉（里面的字段名未必像凭据）
        assert_eq!(
            redact(r#"{"auth": {"type": "x", "secret": "s"}, "n": 1}"#),
            r#"{"auth": …, "n": 1}"#
        );
    }

    /// Codex 复审（2026-10-04）的复现串：认证方式与分隔符前后的空白不止一个空格
    #[test]
    fn whitespace_variants_around_separators() {
        assert_eq!(
            redact("Authorization: Bearer  opaqueCredential987654321"),
            "Authorization: …"
        );
        assert_eq!(
            redact("Authorization:\tBearer\topaqueCredential987654321 next"),
            "Authorization:\t… next"
        );
        assert_eq!(
            redact("{\"api_key\":\t\"opaqueCredential987654321\"}"),
            "{\"api_key\":\t\"…\"}"
        );
        assert_eq!(redact("token  =  abc123 rest"), "token  =  … rest");
        assert_eq!(redact("password :\thunter2"), "password :\t…");
        assert_eq!(
            redact("用了 bearer\t\topaque123 去请求"),
            "用了 bearer\t\t… 去请求"
        );
    }

    /// Codex 复审第二轮：JSON 排版成多行时，值在下一行
    #[test]
    fn json_values_on_the_next_line_are_masked() {
        assert_eq!(
            redact("{\"api_key\":\n\"opaqueCredential987654321\"}"),
            "{\"api_key\":\n\"…\"}"
        );
        assert_eq!(
            redact("{\"authorization\":\n{\"value\":\"opaqueCredential987654321\"}}"),
            "{\"authorization\":\n…}"
        );
        assert_eq!(
            redact("{\n  \"token\" :\r\n    [\"opaqueCredential987654321\"],\n  \"n\": 1\n}"),
            "{\n  \"token\" :\r\n    …,\n  \"n\": 1\n}"
        );
        // 不带引号的 `名: 值` 仍只认同一行，免得把下一行的话吞掉
        assert_eq!(redact("token:\nnext line"), "token:\nnext line");
    }

    /// Codex 复审第三轮：键和冒号之间也可以换行
    #[test]
    fn json_key_and_colon_on_different_lines() {
        assert_eq!(
            redact("{\"api_key\"\n:\n\"opaqueCredential987654321\"}"),
            "{\"api_key\"\n:\n\"…\"}"
        );
    }

    /// Codex 复审第三轮：单引号是 TOML 字面量字符串，里面的反斜杠不是转义；配不上对时只遮到行尾
    #[test]
    fn toml_literal_strings_and_unclosed_values_stop_at_line_end() {
        assert_eq!(
            redact("api_keys=['C:\\', 'x]opaqueCredential987654321']"),
            "api_keys=…"
        );
        assert_eq!(
            redact("api_keys=['C:\\']\n连接失败：超时"),
            "api_keys=…\n连接失败：超时"
        );
        assert_eq!(
            redact("auth: [can't parse]\n连接失败：超时"),
            "auth: …\n连接失败：超时"
        );
    }

    /// Codex 复审第四轮：凭据字段的值没收尾（被截断）时宁可多遮，一直遮到末尾
    #[test]
    fn unclosed_secret_values_are_masked_to_the_end() {
        assert_eq!(
            redact("{\"authorization\": {\n  \"value\": \"opaqueCredential987654321\""),
            "{\"authorization\": …"
        );
        assert_eq!(
            redact("{\"api_keys\": [\n  \"a\",\n  \"opaqueCredential987654321\""),
            "{\"api_keys\": …"
        );
        assert_eq!(
            redact("token = \"unterminated\nopaqueCredential987654321"),
            "token = \"…"
        );
        assert_eq!(redact("secret: {never closed\nmore"), "secret: …");
    }

    /// Codex 复审第三轮：网址里的 `主机:端口` 不是 `名: 值`
    #[test]
    fn url_host_port_is_not_a_field() {
        assert_eq!(
            redact("GET https://auth.example.com:8443/v1/models"),
            "GET https://auth.example.com:8443/v1/models"
        );
        assert_eq!(
            redact("GET https://token.example.com:443/x?key=1 失败"),
            "GET https://token.example.com:443/x?… 失败"
        );
        assert_eq!(
            redact("打开 https://user:pass@auth.example.com:8443/cb"),
            "打开 https://…:…@auth.example.com:8443/cb"
        );
        // 只跳过主机那一段：路径里名字像凭据的 `名=值` 照样遮（Codex 复审第四轮）
        assert_eq!(
            redact("https://example.com/api_key=opaqueCredential987654321"),
            "https://example.com/api_key=…"
        );
        assert_eq!(
            redact("https://auth.example.com:8443/x/token=abc/next 失败"),
            "https://auth.example.com:8443/x/token=… 失败"
        );
    }

    /// Codex 复审第二轮：单引号字符串里的括号不算数组结尾（TOML）
    #[test]
    fn single_quoted_strings_inside_arrays() {
        assert_eq!(
            redact("api_keys=['x]opaqueCredential987654321'] next"),
            "api_keys=… next"
        );
    }

    /// Codex 复审的复现串：值是数组或对象
    #[test]
    fn secret_object_and_array_values_are_masked_whole() {
        assert_eq!(
            redact(r#"{"api_keys":["opaqueCredential987654321"]}"#),
            r#"{"api_keys":…}"#
        );
        assert_eq!(
            redact(r#"{"authorization":{"value":"opaqueCredential987654321"}}"#),
            r#"{"authorization":…}"#
        );
        // 值里的字符串带括号、转义引号也不打乱配对
        assert_eq!(
            redact(r#"{"tokens": ["a]\"}", {"b": "}"}], "model": "gpt"}"#),
            r#"{"tokens": …, "model": "gpt"}"#
        );
        // 被截断、配不上对：一直遮到末尾
        assert_eq!(
            redact(r#"{"secret": {"value": "opaqueCredential9876"#),
            r#"{"secret": …"#
        );
    }

    #[test]
    fn rust_paths_and_plain_words_are_left_alone() {
        let text = "sophia_core::keystore 读失败：Permission denied (os error 13)；时间 12:30";
        assert_eq!(redact(text), text);
        assert_eq!(redact("monkey business"), "monkey business");
    }

    #[test]
    fn key_shaped_tokens_are_masked() {
        assert_eq!(
            redact("用了 sk-ant-api03-abcdefghijklmnopqrstuv 调用"),
            "用了 … 调用"
        );
        assert_eq!(
            redact("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl 过期"),
            "jwt … 过期"
        );
        assert_eq!(redact("ghp_0123456789abcdefghijABCDEFGHIJ"), "…");
        // 短的 sk- 不像密钥（例如命令行选项、普通词）
        assert_eq!(redact("sk-learn 与 sk-1"), "sk-learn 与 sk-1");
    }

    #[test]
    fn long_text_is_capped_char_safely() {
        let text = "汉".repeat(MAX_CHARS + 10);
        let out = redact(&text);
        assert_eq!(out.chars().count(), MAX_CHARS + 1);
        assert!(out.ends_with('…'));
        assert_eq!(redact_full(&text), text);
    }

    #[test]
    fn ac3_all_shapes_in_one_line() {
        let text = format!(
            "请求 https://x.example/v1?token=t1 失败；文件 {}/a.json；Authorization: Bearer zz；api_key=k1",
            home()
        );
        let out = redact(&text);
        assert!(!out.contains("t1"), "{out}");
        assert!(!out.contains(&home()), "{out}");
        assert!(!out.contains("zz"), "{out}");
        assert!(!out.contains("k1"), "{out}");
        assert!(out.contains("~/a.json"), "{out}");
    }
}

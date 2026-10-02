//! 后端文案进目录的把关（spec 2026-09-30-language-and-theme R8）：返回给界面的句子都经 `t!` / `tn!`
//! 从 `locales/` 取，生产代码里不再直接写中文字面量。
//!
//! 扫 `crates/*/src` 与 `src-tauri/src` 下的 `.rs`，逐字切出字符串与字符字面量（注释不算），这几类放过：
//! - 测试：`*tests.rs` 文件、`#[cfg(test)] mod x;` 声明的文件、`#[cfg(test)] mod x { … }` 块——测试断言的就是中文文案
//! - 日志与终端输出：`eprintln!` / `println!` / `eprint!` / `print!` 与 `log` 的几个宏——写给看日志、
//!   看命令行的开发者，不是界面（网关命令行 `Sophia gateway …` 由 launchd 拉起，输出进日志）
//! - 程序员的断言与崩溃消息：`panic!` / `unreachable!` / `todo!` / `assert*!` / `.expect(…)`——不该发生的事，
//!   出现了也是给修代码的人看
//!
//! - 逐行豁免：同一行写 `// i18n-exempt: 理由`（理由必填），给不是界面文案、却只能写中文的少数几处
//!   （例如发给模型的协议文字）。靠它绕过规则的，评审时要看理由站不站得住
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const ALLOWED_CALLS: &[&str] = &[
    "eprintln!",
    "println!",
    "eprint!",
    "print!",
    "log!",
    "trace!",
    "debug!",
    "info!",
    "warn!",
    "error!",
    "panic!",
    "unreachable!",
    "todo!",
    "unimplemented!",
    "assert!",
    "assert_eq!",
    "assert_ne!",
    "debug_assert!",
    "debug_assert_eq!",
    "debug_assert_ne!",
    "expect",
    "expect_err",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3000}'..='\u{303f}' | '\u{4e00}'..='\u{9fff}' | '\u{ff00}'..='\u{ffef}')
}

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

struct Literal {
    at: usize,
    line: usize,
    text: String,
}

/// 逐字切：注释与字面量内容换成空格（换行保留），另收一份字面量
fn scan(src: &str) -> (Vec<char>, Vec<Literal>) {
    let s: Vec<char> = src.chars().collect();
    let n = s.len();
    let mut code = s.clone();
    let mut lits = Vec::new();
    let mut line = 1;
    let mut i = 0;
    let blank = |code: &mut Vec<char>, from: usize, to: usize| {
        for c in &mut code[from..to] {
            if *c != '\n' {
                *c = ' ';
            }
        }
    };
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    while i < n {
        let c = s[i];
        let next = s.get(i + 1).copied();
        if c == '\n' {
            line += 1;
            i += 1;
        } else if c == '/' && next == Some('/') {
            let end = (i..n).find(|&k| s[k] == '\n').unwrap_or(n);
            blank(&mut code, i, end);
            i = end;
        } else if c == '/' && next == Some('*') {
            let (mut depth, mut k) = (1, i + 2);
            while k < n && depth > 0 {
                if s[k] == '/' && s.get(k + 1) == Some(&'*') {
                    depth += 1;
                    k += 2;
                } else if s[k] == '*' && s.get(k + 1) == Some(&'/') {
                    depth -= 1;
                    k += 2;
                } else {
                    k += 1;
                }
            }
            line += s[i..k].iter().filter(|&&c| c == '\n').count();
            blank(&mut code, i, k);
            i = k;
        } else if (c == 'r' || (c == 'b' && next == Some('r'))) && (i == 0 || !ident(s[i - 1])) && {
            let mut k = i + if c == 'b' { 2 } else { 1 };
            while k < n && s[k] == '#' {
                k += 1;
            }
            k < n && s[k] == '"'
        } {
            // 原始字符串 r"…" / r#"…"#
            let mut k = i + if c == 'b' { 2 } else { 1 };
            let hashes = (k..n).take_while(|&j| s[j] == '#').count();
            k += hashes + 1;
            let start = k;
            loop {
                if k >= n {
                    break;
                }
                if s[k] == '"' && (k + 1..k + 1 + hashes).all(|j| s.get(j) == Some(&'#')) {
                    break;
                }
                k += 1;
            }
            let text: String = s[start..k.min(n)].iter().collect();
            lits.push(Literal {
                at: i,
                line,
                text: text.clone(),
            });
            line += text.matches('\n').count();
            let end = (k + 1 + hashes).min(n);
            blank(&mut code, start, k.min(n));
            i = end;
        } else if c == '"' {
            let mut k = i + 1;
            while k < n && s[k] != '"' {
                k += if s[k] == '\\' { 2 } else { 1 };
            }
            let text: String = s[i + 1..k.min(n)].iter().collect();
            lits.push(Literal {
                at: i,
                line,
                text: text.clone(),
            });
            line += text.matches('\n').count();
            blank(&mut code, i + 1, k.min(n));
            i = k + 1;
        } else if c == '\'' {
            // 字符字面量 '中' / '\n'；否则是生命周期 'a
            let len = if next == Some('\\') {
                (i + 2..n.min(i + 12))
                    .find(|&k| s[k] == '\'')
                    .map(|k| k - i + 1)
            } else if s.get(i + 2) == Some(&'\'') {
                Some(3)
            } else {
                None
            };
            match len {
                Some(len) => {
                    let text: String = s[i + 1..i + len - 1].iter().collect();
                    lits.push(Literal { at: i, line, text });
                    blank(&mut code, i + 1, i + len - 1);
                    i += len;
                }
                None => i += 1,
            }
        } else {
            i += 1;
        }
    }
    (code, lits)
}

/// `#[cfg(test)] mod x { … }` 块的范围（按去掉注释与字面量内容后的代码找）
fn test_blocks(code: &[char]) -> Vec<(usize, usize)> {
    let text: String = code.iter().collect();
    let byte_to_char: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
    let char_at = |b: usize| byte_to_char.partition_point(|&x| x < b);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = text[from..].find("#[cfg(test)]") {
        let start = from + pos;
        from = start + 1;
        let rest = &text[start + "#[cfg(test)]".len()..];
        // 跳过其后的属性与可见性，要的是 `mod 名字 {`
        let mut r = rest.trim_start();
        while r.starts_with("#[") {
            r = r[r.find(']').map_or(r.len(), |k| k + 1)..].trim_start();
        }
        if let Some(stripped) = r.strip_prefix("pub") {
            r = stripped.trim_start();
            if r.starts_with('(') {
                r = r[r.find(')').map_or(r.len(), |k| k + 1)..].trim_start();
            }
        }
        let Some(after_mod) = r.strip_prefix("mod ") else {
            continue;
        };
        let name_len = after_mod
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .unwrap_or(0);
        let tail = after_mod[name_len..].trim_start();
        if !tail.starts_with('{') {
            continue;
        }
        let open = char_at(text.len() - tail.len());
        let mut depth = 0;
        let mut k = open;
        while k < code.len() {
            match code[k] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        out.push((char_at(start), k));
    }
    out
}

/// 字面量所在的各层调用名（最里层在后）：`eprintln!(format!("…"))` 里的字面量得到 [eprintln!, format!]
fn enclosing_calls(code: &[char], at: usize) -> Vec<String> {
    let mut stack: Vec<String> = Vec::new();
    for i in 0..at {
        match code[i] {
            '(' | '[' | '{' => {
                let mut k = i;
                while k > 0 && code[k - 1].is_whitespace() {
                    k -= 1;
                }
                let bang = k > 0 && code[k - 1] == '!';
                if bang {
                    k -= 1;
                }
                let end = k;
                while k > 0 && (code[k - 1].is_alphanumeric() || code[k - 1] == '_') {
                    k -= 1;
                }
                let mut name: String = code[k..end].iter().collect();
                if bang {
                    name.push('!');
                }
                stack.push(name);
            }
            ')' | ']' | '}' => {
                stack.pop();
            }
            _ => {}
        }
    }
    stack
}

/// 一个文件里不该有的中文字面量：`行号: 片段`
fn violations(src: &str) -> Vec<String> {
    let (code, lits) = scan(src);
    let blocks = test_blocks(&code);
    let lines: Vec<&str> = src.lines().collect();
    let exempt = |line: usize| {
        lines
            .get(line - 1)
            .and_then(|l| l.split_once("// i18n-exempt:"))
            .is_some_and(|(_, why)| !why.trim().is_empty())
    };
    lits.into_iter()
        .filter(|l| l.text.chars().any(is_cjk))
        .filter(|l| !exempt(l.line))
        .filter(|l| !blocks.iter().any(|&(a, b)| l.at >= a && l.at < b))
        .filter(|l| {
            !enclosing_calls(&code, l.at)
                .iter()
                .any(|c| ALLOWED_CALLS.contains(&c.as_str()))
        })
        .map(|l| {
            format!(
                "{}: {}",
                l.line,
                l.text.chars().take(30).collect::<String>()
            )
        })
        .collect()
}

/// 只供测试的文件：`*tests.rs`，以及被 `#[cfg(test)] mod x;` 声明的 `x.rs` / `x/mod.rs`
fn test_only_files(files: &[PathBuf]) -> BTreeSet<PathBuf> {
    let mut out: BTreeSet<PathBuf> = files
        .iter()
        .filter(|p| p.to_string_lossy().ends_with("tests.rs"))
        .cloned()
        .collect();
    for f in files {
        let src = fs::read_to_string(f).unwrap();
        let (code, _) = scan(&src);
        let text: String = code.iter().collect();
        let dir = match f.file_name().and_then(|n| n.to_str()) {
            Some("lib.rs" | "mod.rs" | "main.rs") => f.parent().unwrap().to_path_buf(),
            _ => f.with_extension(""),
        };
        for (pos, _) in text.match_indices("#[cfg(test)]") {
            let rest = text[pos + "#[cfg(test)]".len()..].trim_start();
            let rest = rest
                .strip_prefix("pub(crate) ")
                .or(rest.strip_prefix("pub "))
                .unwrap_or(rest);
            let Some(decl) = rest.strip_prefix("mod ") else {
                continue;
            };
            let name: String = decl
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if decl[name.len()..].trim_start().starts_with(';') {
                out.insert(dir.join(format!("{name}.rs")));
                out.insert(dir.join(&name).join("mod.rs"));
            }
        }
    }
    out
}

#[test]
fn 返回给界面的句子都从目录取_生产代码里没有中文字面量() {
    let root = repo_root();
    let mut files = Vec::new();
    for entry in fs::read_dir(root.join("crates")).unwrap().flatten() {
        rs_files(&entry.path().join("src"), &mut files);
    }
    rs_files(&root.join("src-tauri/src"), &mut files);
    files.sort();
    assert!(files.len() > 50, "没扫到文件：{}", root.display());

    let tests_only = test_only_files(&files);
    let mut problems = Vec::new();
    for f in &files {
        if tests_only.contains(f) {
            continue;
        }
        let rel = f
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for v in violations(&fs::read_to_string(f).unwrap()) {
            problems.push(format!("{rel}:{v}"));
        }
    }
    assert!(
        problems.is_empty(),
        "生产代码里的中文字面量（改成 t!/tn! 取目录）：\n{}",
        problems.join("\n")
    );
}

#[test]
fn 扫描器_注释不算_日志与断言放过_测试块放过_写明理由的豁免放过_其余都报() {
    let src = r##"
// 注释里的中文不算
/* 块注释 /* 嵌套 */ 也不算 */
fn a() -> String { format!("{} 个 skill", 3) }
fn b() { eprintln!("日志：{}", format!("嵌套 {}", 1)); }
fn c() { let _ = x.expect("不会发生"); panic!("崩溃"); }
fn d() -> char { '、' }
fn e<'a>(s: &'a str) -> &'a str { s }
fn f() -> &'static str { r#"原始字符串"# }
#[cfg(test)]
mod tests {
    fn g() { assert_eq!(t(), "测试里的中文"); let _ = "测试块里的"; }
}
fn h() -> String { "块后面的".into() }
fn i() -> &'static str { "协议文字" } // i18n-exempt: 发给模型的，不是界面
fn j() -> &'static str { "没写理由" } // i18n-exempt:
"##;
    let found = violations(src);
    let texts: Vec<&str> = found
        .iter()
        .map(|v| v.split_once(": ").unwrap().1)
        .collect();
    assert_eq!(
        texts,
        ["{} 个 skill", "、", "原始字符串", "块后面的", "没写理由"],
        "{found:?}"
    );
}

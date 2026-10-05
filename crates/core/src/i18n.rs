//! 界面文案目录的后端入口（spec 2026-09-30-language-and-theme R6、R7、R12、R13）。
//!
//! 与前端（`src/i18n.ts`）读同一批文件：仓库根 `locales/<语言>/<区块>.json`，语言有 `zh-Hans`、
//! `zh-Hant`、`en` 三种。值是整句，参数写成 `{name}` 占位符；按数量变的写成 `{"one": …, "other": …}`。
//!
//! 后端返回给界面的原因句、读数句都经这里取，用 `t!("usage.tray.updatedAgo", n = 3)` /
//! `tn!("usage.minutesAgo", n)`，键只能写字面量（宏本身就只收字面量）。调试日志、`expect` 的消息、
//! 网关命令行的终端输出不进目录，照旧写中文（`tests/i18n_literals.rs` 把关，放过的类别写在那里）。
//!
//! 当前语言是进程级的一份（`set_locale` / `locale`），壳在启动时按设置写入、改设置时换掉；
//! 后台路由（`Sophia gateway run`）是另一个进程，每个请求按 settings.json 重设一次
//! （`sophia_gateway::runtime::saved_locale`）。按当前语言查，这种语言里没有的键退回简体
use crate::store::Language;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Display;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

/// 一条文案：整句，或按数量分的几种写法（英文的单复数；中文只写 `other` 或直接写字符串）
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Text(String),
    Forms { one: Option<String>, other: String },
}

/// 界面实际用的语言（设置里的「跟随系统」解析之后）。序列化成目录文件夹名，也是前端 `html lang` 的值
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Lang {
    #[serde(rename = "zh-Hans")]
    ZhHans,
    #[serde(rename = "zh-Hant")]
    ZhHant,
    #[serde(rename = "en")]
    En,
}

impl Lang {
    const ALL: [Lang; 3] = [Lang::ZhHans, Lang::ZhHant, Lang::En];

    /// 语言标签：`zh-Hans` / `zh-Hant` / `en`（与 `locales/` 下的文件夹同名）
    pub fn tag(self) -> &'static str {
        match self {
            Lang::ZhHans => "zh-Hans",
            Lang::ZhHant => "zh-Hant",
            Lang::En => "en",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// 系统首选语言列表 → 界面语言（R13）：逐个看，取第一个认得出的。`zh-Hant*`、`zh-TW`、`zh-HK`、`zh-MO`
/// 是繁体，其余中文是简体（文字写明了 `Hans` 就按文字，不看地区），`en*` 是英文；别的语言跳过，
/// 都认不出或列表是空的用英文
pub fn resolve_system<S: AsRef<str>>(tags: &[S]) -> Lang {
    for tag in tags {
        let tag = tag.as_ref().to_ascii_lowercase().replace('_', "-");
        let mut parts = tag.split('-');
        match parts.next() {
            Some("en") => return Lang::En,
            Some("zh") => {
                let rest: Vec<&str> = parts.collect();
                if rest.contains(&"hant") {
                    return Lang::ZhHant;
                }
                if rest.contains(&"hans") {
                    return Lang::ZhHans;
                }
                if rest.iter().any(|r| matches!(*r, "tw" | "hk" | "mo")) {
                    return Lang::ZhHant;
                }
                return Lang::ZhHans;
            }
            _ => {}
        }
    }
    Lang::En
}

/// 设置里的界面语言 → 实际语言。只有「跟随系统」才去读系统语言（`system` 惰性调用）
pub fn resolve(setting: Language, system: impl FnOnce() -> Vec<String>) -> Lang {
    match setting {
        Language::System => resolve_system(&system()),
        Language::ZhHans => Lang::ZhHans,
        Language::ZhHant => Lang::ZhHant,
        Language::En => Lang::En,
    }
}

/// 存当前语言的格子：起始是简体（壳写入之前、以及测试里）
pub struct LocaleCell(AtomicU8);

impl LocaleCell {
    pub const fn new() -> Self {
        Self(AtomicU8::new(Lang::ZhHans as u8))
    }

    pub fn get(&self) -> Lang {
        Lang::ALL
            .get(self.0.load(Ordering::Relaxed) as usize)
            .copied()
            .unwrap_or(Lang::ZhHans)
    }

    pub fn set(&self, lang: Lang) {
        self.0.store(lang as u8, Ordering::Relaxed);
    }
}

impl Default for LocaleCell {
    fn default() -> Self {
        Self::new()
    }
}

static CURRENT: LocaleCell = LocaleCell::new();

/// 当前界面语言
pub fn locale() -> Lang {
    CURRENT.get()
}

/// 换当前界面语言：之后取的每一句都按它（已经算好交出去的句子不变，由调用方重取）
pub fn set_locale(lang: Lang) {
    CURRENT.set(lang);
}

/// 区块清单：每种语言一份，与 `locales/<语言>/` 下的文件一一对应（`tests/i18n-catalog.test.ts` 核对），
/// 前端 `src/i18n/catalog.ts` 另有一份 import 清单读同一批文件。三份的次序与 `Lang::ALL` 相同
const AREAS_ZH_HANS: &[&str] = &[
    include_str!("../../../locales/zh-Hans/common.json"),
    include_str!("../../../locales/zh-Hans/hints.json"),
    include_str!("../../../locales/zh-Hans/market.json"),
    include_str!("../../../locales/zh-Hans/mcp.json"),
    include_str!("../../../locales/zh-Hans/models.json"),
    include_str!("../../../locales/zh-Hans/settings.json"),
    include_str!("../../../locales/zh-Hans/shell.json"),
    include_str!("../../../locales/zh-Hans/skills.json"),
    include_str!("../../../locales/zh-Hans/sources.json"),
    include_str!("../../../locales/zh-Hans/time.json"),
    include_str!("../../../locales/zh-Hans/toast.json"),
    include_str!("../../../locales/zh-Hans/tray.json"),
    include_str!("../../../locales/zh-Hans/usage.json"),
];
const AREAS_ZH_HANT: &[&str] = &[
    include_str!("../../../locales/zh-Hant/common.json"),
    include_str!("../../../locales/zh-Hant/hints.json"),
    include_str!("../../../locales/zh-Hant/market.json"),
    include_str!("../../../locales/zh-Hant/mcp.json"),
    include_str!("../../../locales/zh-Hant/models.json"),
    include_str!("../../../locales/zh-Hant/settings.json"),
    include_str!("../../../locales/zh-Hant/shell.json"),
    include_str!("../../../locales/zh-Hant/skills.json"),
    include_str!("../../../locales/zh-Hant/sources.json"),
    include_str!("../../../locales/zh-Hant/time.json"),
    include_str!("../../../locales/zh-Hant/toast.json"),
    include_str!("../../../locales/zh-Hant/tray.json"),
    include_str!("../../../locales/zh-Hant/usage.json"),
];
const AREAS_EN: &[&str] = &[
    include_str!("../../../locales/en/common.json"),
    include_str!("../../../locales/en/hints.json"),
    include_str!("../../../locales/en/market.json"),
    include_str!("../../../locales/en/mcp.json"),
    include_str!("../../../locales/en/models.json"),
    include_str!("../../../locales/en/settings.json"),
    include_str!("../../../locales/en/shell.json"),
    include_str!("../../../locales/en/skills.json"),
    include_str!("../../../locales/en/sources.json"),
    include_str!("../../../locales/en/time.json"),
    include_str!("../../../locales/en/toast.json"),
    include_str!("../../../locales/en/tray.json"),
    include_str!("../../../locales/en/usage.json"),
];

/// 内部版专用的句子单放一份：只在 weiboap feature 下编进二进制，公开版产物里没有它的字节。次序同上
#[cfg(feature = "weiboap")]
const WEIBOAP: [&str; 3] = [
    include_str!("../../../locales/zh-Hans/weiboap.json"),
    include_str!("../../../locales/zh-Hant/weiboap.json"),
    include_str!("../../../locales/en/weiboap.json"),
];

type Catalog = HashMap<String, Message>;

fn parse(lang: Lang, files: &[&str]) -> Catalog {
    let mut all = HashMap::new();
    for text in files {
        let part: Catalog = serde_json::from_str(text).unwrap_or_else(|e| {
            panic!(
                "locales/{} 下的目录文件不是键到文案的 JSON 对象：{e}",
                lang.tag()
            )
        });
        all.extend(part);
    }
    all
}

/// 三种语言的目录，下标是 `Lang::index`
fn catalogs() -> &'static [Catalog; 3] {
    static CATALOGS: OnceLock<[Catalog; 3]> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        let areas = [AREAS_ZH_HANS, AREAS_ZH_HANT, AREAS_EN];
        Lang::ALL.map(|lang| {
            #[allow(unused_mut)]
            let mut files = areas[lang.index()].to_vec();
            #[cfg(feature = "weiboap")]
            files.push(WEIBOAP[lang.index()]);
            parse(lang, &files)
        })
    })
}

/// 按数量选写法：英文 1 取 one、其余取 other；缺了哪种退回 other。中文只有一种写法
pub fn select_form<'a>(message: &'a Message, count: u64, locale: &str) -> &'a str {
    match message {
        Message::Text(text) => text,
        Message::Forms { one, other } => match one {
            Some(one) if count == 1 && locale.starts_with("en") => one,
            _ => other,
        },
    }
}

/// 占位符换成参数。缺参数的占位符原样留着：界面上看得见，测试也抓得到
pub fn format(template: &str, params: &[(&str, &dyn Display)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}');
        let name = close.map(|c| &after[..c]);
        match name.filter(|n| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '_')) {
            Some(name) => {
                match params.iter().find(|(k, _)| *k == name) {
                    Some((_, value)) => out.push_str(&value.to_string()),
                    None => out.push_str(&rest[open..open + name.len() + 2]),
                }
                rest = &after[name.len() + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 在某种语言的目录里找一条；没有退回简体
fn find<'a>(cats: &'a [Catalog; 3], lang: Lang, key: &str) -> Option<&'a Message> {
    cats[lang.index()]
        .get(key)
        .or_else(|| cats[Lang::ZhHans.index()].get(key))
}

/// 按某种语言取一句并带入参数：`count` 为 Some 时按数量选写法、`{count}` 自动带入；
/// 目录里（连简体也）没有这个键时是 None
fn render_in(
    cats: &[Catalog; 3],
    lang: Lang,
    key: &str,
    count: Option<u64>,
    params: &[(&str, &dyn Display)],
) -> Option<String> {
    let message = find(cats, lang, key)?;
    Some(match count {
        None => format(select_form(message, 1, lang.tag()), params),
        Some(count) => {
            let mut all: Vec<(&str, &dyn Display)> = vec![("count", &count)];
            all.extend_from_slice(params);
            format(select_form(message, count, lang.tag()), &all)
        }
    })
}

fn render(key: &str, count: Option<u64>, params: &[(&str, &dyn Display)]) -> String {
    let found = render_in(catalogs(), locale(), key, count, params);
    debug_assert!(found.is_some(), "文案目录里没有 {key}");
    found.unwrap_or_else(|| key.to_string())
}

/// 取一句文案（宏 `t!` 的落点）。目录里没有这个键时 debug 构建直接 panic，release 返回键名
pub fn t(key: &str, params: &[(&str, &dyn Display)]) -> String {
    render(key, None, params)
}

/// 取一句按数量变的文案，`{count}` 自动带入（宏 `tn!` 的落点）
pub fn tn(key: &str, count: u64, params: &[(&str, &dyn Display)]) -> String {
    render(key, Some(count), params)
}

/// 列表的连接方式：`Enum` 并列（中文「、」）、`And` 两样并举（中文「 和 」）、`Semicolon` 几条原因（中文「；」）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListStyle {
    Enum,
    And,
    Semicolon,
}

/// 连接一组名字或原因（纯函数，测试用）：中文用目录里的连接符，与原来逐字相同；其他语言的并列写成
/// `A, B, and C` / `A and B`（与前端 `Intl.ListFormat` 一致），分号各语言自写。`seps` 依次是 并列 / 和 / 分号
pub fn join_list<S: AsRef<str>>(
    items: &[S],
    style: ListStyle,
    lang: &str,
    seps: [&str; 3],
) -> String {
    let parts: Vec<&str> = items.iter().map(AsRef::as_ref).collect();
    let sep = match style {
        ListStyle::Enum => seps[0],
        ListStyle::And => seps[1],
        ListStyle::Semicolon => seps[2],
    };
    if style == ListStyle::Semicolon || lang.starts_with("zh") {
        return parts.join(sep);
    }
    match parts.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [a, b] => format!("{a} and {b}"),
        [head @ .., last] => format!("{}, and {last}", head.join(", ")),
    }
}

/// 按当前语言连接列表
pub fn list_text<S: AsRef<str>>(items: &[S], style: ListStyle) -> String {
    let seps = [
        crate::t!("common.list.enum"),
        crate::t!("common.list.and"),
        crate::t!("common.list.semicolon"),
    ];
    join_list(items, style, locale().tag(), [&seps[0], &seps[1], &seps[2]])
}

/// `t!("skills.cell.addTo", agent = label)`：键只收字面量，参数取 `Display`
#[macro_export]
macro_rules! t {
    ($key:literal $(, $name:ident = $value:expr)* $(,)?) => {
        $crate::i18n::t($key, &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),*])
    };
}

/// `tn!("usage.minutesAgo", n)`、`tn!("mcp.fields", n, name = x)`：按数量选写法，`{count}` 自动带入
#[macro_export]
macro_rules! tn {
    ($key:literal, $count:expr $(, $name:ident = $value:expr)* $(,)?) => {
        $crate::i18n::tn(
            $key,
            ($count) as u64,
            &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),*],
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 占位符换成参数_缺参数的原样留着_不是占位符的花括号照写() {
        assert_eq!(format("加到 {agent}", &[("agent", &"Codex")]), "加到 Codex");
        assert_eq!(format("{n} 个 skill", &[("n", &3)]), "3 个 skill");
        assert_eq!(format("{a} 和 {a}", &[("a", &"x")]), "x 和 x");
        assert_eq!(format("加到 {agent}", &[]), "加到 {agent}");
        assert_eq!(
            format("JSON 写成 {} 或 { \"a\": 1 }", &[]),
            "JSON 写成 {} 或 { \"a\": 1 }"
        );
        assert_eq!(format("结尾一个 {", &[]), "结尾一个 {");
    }

    #[test]
    fn 按数量选写法_英文1取one_其余取other_中文只有一种() {
        let en = Message::Forms {
            one: Some("{count} skill".into()),
            other: "{count} skills".into(),
        };
        assert_eq!(select_form(&en, 1, "en"), "{count} skill");
        assert_eq!(select_form(&en, 0, "en"), "{count} skills");
        assert_eq!(select_form(&en, 2, "en"), "{count} skills");
        let zh = Message::Forms {
            one: None,
            other: "{count} 个".into(),
        };
        assert_eq!(select_form(&zh, 1, "zh-Hans"), "{count} 个");
        assert_eq!(
            select_form(&Message::Text("{count} 个".into()), 1, "zh-Hans"),
            "{count} 个"
        );
        // 缺 one 时退回 other
        let partial = Message::Forms {
            one: None,
            other: "{count} items".into(),
        };
        assert_eq!(select_form(&partial, 1, "en"), "{count} items");
    }

    #[test]
    fn 列表_中文照旧用目录里的连接符_英文写成_a_b_and_c_分号各语言自写() {
        let zh = ["、", " 和 ", "；"];
        assert_eq!(
            join_list(&["A", "B", "C"], ListStyle::Enum, "zh-Hans", zh),
            "A、B、C"
        );
        assert_eq!(
            join_list(&["A", "B"], ListStyle::And, "zh-Hans", zh),
            "A 和 B"
        );
        assert_eq!(
            join_list(&["一", "二"], ListStyle::Semicolon, "zh-Hans", zh),
            "一；二"
        );
        let en = ["", "", "; "];
        assert_eq!(
            join_list(&["A", "B", "C"], ListStyle::Enum, "en", en),
            "A, B, and C"
        );
        assert_eq!(join_list(&["A", "B"], ListStyle::And, "en", en), "A and B");
        assert_eq!(join_list(&["A"], ListStyle::Enum, "en", en), "A");
        assert_eq!(join_list::<&str>(&[], ListStyle::Enum, "en", en), "");
        assert_eq!(
            join_list(&["x", "y"], ListStyle::Semicolon, "en", en),
            "x; y"
        );
        // 当前语言（简体）下经目录取连接符
        assert_eq!(list_text(&["A", "B"], ListStyle::Enum), "A、B");
    }

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// AC15：系统首选语言 → 界面语言。繁体（zh-Hant、zh-TW、zh-HK、zh-MO）用繁体，其余中文用简体，
    /// 英文用 English；认不出的跳过看下一个，都认不出或空用 English
    #[test]
    fn 系统语言按列表里第一个认得出的定_繁简按文字或地区分_都认不出用英文() {
        let one = |t: &str| resolve_system(&tags(&[t]));
        assert_eq!(one("zh-Hant-TW"), Lang::ZhHant);
        assert_eq!(one("zh-Hant"), Lang::ZhHant);
        assert_eq!(one("zh-TW"), Lang::ZhHant);
        assert_eq!(one("zh-HK"), Lang::ZhHant);
        assert_eq!(one("zh-MO"), Lang::ZhHant);
        assert_eq!(one("zh-Hans-CN"), Lang::ZhHans);
        assert_eq!(one("zh-Hans"), Lang::ZhHans);
        assert_eq!(one("zh-CN"), Lang::ZhHans);
        assert_eq!(one("zh-SG"), Lang::ZhHans);
        assert_eq!(one("zh"), Lang::ZhHans);
        // 文字写明了简体，地区是香港也是简体
        assert_eq!(one("zh-Hans-HK"), Lang::ZhHans);
        assert_eq!(one("en-GB"), Lang::En);
        assert_eq!(one("en"), Lang::En);
        assert_eq!(one("ja-JP"), Lang::En);
        assert_eq!(resolve_system::<String>(&[]), Lang::En);
        // 认不出的跳过，取第一个认得出的
        assert_eq!(
            resolve_system(&tags(&["ja-JP", "zh-Hant-TW"])),
            Lang::ZhHant
        );
        assert_eq!(
            resolve_system(&tags(&["fr-FR", "en-US", "zh-Hans-CN"])),
            Lang::En
        );
        assert_eq!(resolve_system(&tags(&["ja-JP", "ko-KR"])), Lang::En);
        // 大小写、下划线写法也认
        assert_eq!(one("zh_TW"), Lang::ZhHant);
        assert_eq!(one("ZH-hant"), Lang::ZhHant);
    }

    /// 设置里的界面语言 → 实际语言：跟随系统才去读系统语言
    #[test]
    fn 设置选了哪种就是哪种_跟随系统才读系统语言() {
        use crate::store::Language;
        let never = || -> Vec<String> { panic!("选定了语言就不该读系统语言") };
        assert_eq!(resolve(Language::ZhHans, never), Lang::ZhHans);
        assert_eq!(resolve(Language::ZhHant, never), Lang::ZhHant);
        assert_eq!(resolve(Language::En, never), Lang::En);
        assert_eq!(resolve(Language::System, || tags(&["zh-HK"])), Lang::ZhHant);
        assert_eq!(resolve(Language::System, Vec::new), Lang::En);
    }

    #[test]
    fn 语言标签与目录文件夹同名() {
        assert_eq!(Lang::ZhHans.tag(), "zh-Hans");
        assert_eq!(Lang::ZhHant.tag(), "zh-Hant");
        assert_eq!(Lang::En.tag(), "en");
        assert_eq!(serde_json::to_value(Lang::ZhHant).unwrap(), "zh-Hant");
    }

    /// 当前语言：起始是简体（壳在启动时写入真正的语言之前），写进去什么读出来什么
    #[test]
    fn 当前语言起始是简体_写入后读回() {
        let cell = LocaleCell::new();
        assert_eq!(cell.get(), Lang::ZhHans);
        for lang in [Lang::En, Lang::ZhHant, Lang::ZhHans] {
            cell.set(lang);
            assert_eq!(cell.get(), lang);
        }
        // 进程级那一份起始也是简体（测试里不改它：别的测试按简体断言）
        assert_eq!(locale(), Lang::ZhHans);
    }

    fn sample_catalogs() -> [HashMap<String, Message>; 3] {
        let parse = |s: &str| serde_json::from_str::<HashMap<String, Message>>(s).unwrap();
        let mut cats = [HashMap::new(), HashMap::new(), HashMap::new()];
        cats[Lang::ZhHans.index()] =
            parse(r#"{"x.hi":"你好 {name}","x.only":"只有简体","x.n":"{count} 个 skill"}"#);
        cats[Lang::ZhHant.index()] = parse(r#"{"x.hi":"妳好 {name}","x.n":"{count} 個 skill"}"#);
        cats[Lang::En.index()] =
            parse(r#"{"x.hi":"Hi {name}","x.n":{"one":"{count} skill","other":"{count} skills"}}"#);
        cats
    }

    /// 按当前语言查；这种语言里没有的键退回简体，简体也没有就是 None
    #[test]
    fn 按语言查_找不到的键退回简体() {
        let cats = sample_catalogs();
        let hi = |lang| render_in(&cats, lang, "x.hi", None, &[("name", &"Ann")]);
        assert_eq!(hi(Lang::ZhHans).as_deref(), Some("你好 Ann"));
        assert_eq!(hi(Lang::ZhHant).as_deref(), Some("妳好 Ann"));
        assert_eq!(hi(Lang::En).as_deref(), Some("Hi Ann"));
        for lang in [Lang::ZhHant, Lang::En] {
            assert_eq!(
                render_in(&cats, lang, "x.only", None, &[]).as_deref(),
                Some("只有简体")
            );
        }
        assert_eq!(render_in(&cats, Lang::En, "x.none", None, &[]), None);
    }

    /// 单复数按语言选：英文 1 取 one，中文只有一种写法；`{count}` 自动带入
    #[test]
    fn 按数量变的句子按语言选单复数() {
        let cats = sample_catalogs();
        let n = |lang, count| render_in(&cats, lang, "x.n", Some(count), &[]);
        assert_eq!(n(Lang::En, 1).as_deref(), Some("1 skill"));
        assert_eq!(n(Lang::En, 2).as_deref(), Some("2 skills"));
        assert_eq!(n(Lang::ZhHant, 1).as_deref(), Some("1 個 skill"));
        assert_eq!(n(Lang::ZhHans, 2).as_deref(), Some("2 个 skill"));
    }

    /// 三种语言的目录都编进来了，键一样多（翻译前两份新目录是简体的副本，键必然一致；
    /// 键与占位符的逐条对照在 tests/i18n-catalog.test.ts）
    #[test]
    fn 三种语言的目录都能解析_键一致() {
        let cats = catalogs();
        let keys = |lang: Lang| {
            let mut k: Vec<&String> = cats[lang.index()].keys().collect();
            k.sort();
            k
        };
        assert!(!keys(Lang::ZhHans).is_empty());
        assert_eq!(keys(Lang::ZhHant), keys(Lang::ZhHans));
        assert_eq!(keys(Lang::En), keys(Lang::ZhHans));
    }

    #[test]
    fn 目录文件都能解析成键到文案() {
        // 各区块文件都是合法的 JSON 对象（空目录也算）；解析失败会在这里 panic
        let _ = catalogs();
    }

    #[test]
    #[should_panic(expected = "文案目录里没有")]
    #[cfg(debug_assertions)]
    fn 目录里没有的键在debug构建里直接报出来() {
        let _ = t("skills.noSuchKey", &[]);
    }

    #[test]
    #[should_panic(expected = "文案目录里没有 skills.noSuchKey")]
    #[cfg(debug_assertions)]
    fn t宏展开到t_参数按名字打包() {
        let label = "Codex";
        let _ = crate::t!("skills.noSuchKey", agent = label, n = 3);
    }

    #[test]
    #[should_panic(expected = "文案目录里没有 usage.noSuchKey")]
    #[cfg(debug_assertions)]
    fn tn宏展开到tn() {
        let _ = crate::tn!("usage.noSuchKey", 2usize, name = "x");
    }
}

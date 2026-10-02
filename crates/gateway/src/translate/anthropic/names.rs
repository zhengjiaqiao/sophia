//! R18：工具名与工具调用 id 的规整。
//!
//! 目的：会话记录里留下的名字与 id 切回官方后仍合法（官方要求 `^[a-zA-Z0-9_-]+$`，名字 ≤ 64）。

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// 上游（OpenAI 兼容）对函数名的长度上限。
pub const MAX_TOOL_NAME_LEN: usize = 64;
/// 短名里保留的原名前缀长度：`<前缀>_<8 位哈希>` 恰好 64。
const SHORT_PREFIX_LEN: usize = MAX_TOOL_NAME_LEN - 1 - 8;

/// 发给上游的短名 → Claude Code 的原名。只登记被改过名的工具。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolNameMap(HashMap<String, String>);

impl ToolNameMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// 按 R18 求上游名并登记，返回上游名。
    pub fn register(&mut self, original: &str) -> String {
        let upstream = upstream_tool_name(original);
        if upstream != original {
            self.0.insert(upstream.clone(), original.to_string());
        }
        upstream
    }

    /// 上游回来的名字 → 原名；没登记过的原样返回。
    pub fn original<'a>(&'a self, upstream: &'a str) -> &'a str {
        self.0.get(upstream).map_or(upstream, String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn is_valid_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// 工具名规整：合法（≤ 64 且只含 `[A-Za-z0-9_-]`）则原样；否则非法字符换成 `_`、
/// 截到 55 字符，再接 `_` 与原名 SHA-256 的前 8 位十六进制。确定性：同名总得同一短名。
pub fn upstream_tool_name(original: &str) -> String {
    if !original.is_empty()
        && original.len() <= MAX_TOOL_NAME_LEN
        && original.chars().all(is_valid_char)
    {
        return original.to_string();
    }
    let digest = Sha256::digest(original.as_bytes());
    let hash: String = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let prefix: String = original
        .chars()
        .map(|c| if is_valid_char(c) { c } else { '_' })
        .take(SHORT_PREFIX_LEN)
        .collect();
    format!("{prefix}_{hash}")
}

/// 上游给的工具调用 id：非法字符换成 `_`；为空时生成 `toolu_` + 24 位随机字母数字。
pub fn sanitize_tool_id(id: &str) -> String {
    if id.is_empty() {
        return format!("toolu_{}", random_alnum(24));
    }
    id.chars()
        .map(|c| if is_valid_char(c) { c } else { '_' })
        .collect()
}

/// 随机字母数字串。只用标准库：`RandomState` 的种子来自操作系统随机源，再混入时间与计数器。
pub(super) fn random_alnum(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos()),
        );
        let mut value = hasher.finish();
        // 每个 u64 取 10 个字符（62^10 < 2^64），够用且不追求均匀到极致
        for _ in 0..10 {
            if out.len() == len {
                break;
            }
            out.push(ALPHABET[(value % ALPHABET.len() as u64) as usize] as char);
            value /= ALPHABET.len() as u64;
        }
    }
    out
}

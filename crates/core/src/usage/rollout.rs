//! Codex 本机会话记录的末尾读取（R3①、R13）：按修改时间取最新的 rollout，从末尾往前读，
//! 找到最后一条额度记录就停，最多读 2 MB。由 T2 实现。
//!
//! 目录结构是 `<codex_home>/sessions/YYYY/MM/DD/rollout-*.jsonl`（Codex 自己写的，无官方文档，
//! 见 spec 外部契约）。不解析成 `Reading`：这里只找文件、找到匹配的那一行原文，交给
//! `parse::parse_rollout_line`（另一位同事在做）去归一。

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 一次块读取的大小
const CHUNK_SIZE: usize = 64 * 1024;

/// 从末尾往前最多读这么多字节就停（R13）
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// 回溯扫描的日期目录数量上限。
///
/// 选最新文件本该按 mtime 在全部 rollout 文件里找最大值，但用户机器上有 300+ 个文件，
/// 逐个 `stat` 会扫整棵树。Codex 的 rollout 文件只在对应 session 存活期间被追加；一个
/// session 跨自然日继续写的情况存在（深夜没关的会话），但极少见连续跨两个自然日以上，
/// 所以只看「最新的几个日期目录」（今天、昨天、前天）、在它们里面比较真实 mtime，
/// 而不是简单地「取今天那个目录」——后者遇到「今天目录是空的/没更新，昨天目录的会话
/// 还在写」时会选错。这个数字定得越大，正确性更强、但要扫的目录也更多，取 3 做折中；
/// 需要更强的保证时调大它即可。
const ROLLOUT_DAY_SCAN_LIMIT: usize = 3;

/// 在最新的几个日期目录里，按修改时间找最新的一个 `rollout-*.jsonl`。
///
/// `sessions` 目录不存在、或最新的几个日期目录里没有任何 rollout 文件时，返回 `None`
/// （不是错误：全新安装、还没跑过 Codex 都会走到这里）。
pub fn latest_rollout(codex_home: &Path) -> Option<PathBuf> {
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.is_dir() {
        return None;
    }

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for day_dir in latest_day_dirs(&sessions_dir, ROLLOUT_DAY_SCAN_LIMIT) {
        let Ok(entries) = fs::read_dir(&day_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(modified) = metadata.modified() else {
                continue;
            };
            let path = entry.path();
            let better = match &best {
                None => true,
                Some((best_modified, best_path)) => {
                    modified > *best_modified || (modified == *best_modified && path > *best_path)
                }
            };
            if better {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// 按目录名降序取最新的 `limit` 个日期目录（可能跨月、跨年）。
///
/// `sessions/YYYY/MM/DD` 三层都是定宽数字命名，字符串降序等价于数值降序，不需要解析成数字。
fn latest_day_dirs(sessions_dir: &Path, limit: usize) -> Vec<PathBuf> {
    let mut days = Vec::new();
    'years: for year in sorted_subdirs_desc(sessions_dir) {
        for month in sorted_subdirs_desc(&year) {
            for day in sorted_subdirs_desc(&month) {
                days.push(day);
                if days.len() >= limit {
                    break 'years;
                }
            }
        }
    }
    days
}

/// 子目录按目录名降序排列；不是目录的条目（包括坏软链）忽略
fn sorted_subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    names.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    names
}

/// `read_last_rate_limits_line` 的结果
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TailRead {
    /// 命中的那一行原文（未解析）；没找到就是 `None`
    pub line: Option<String>,
    /// 实际从文件末尾往前读了多少字节（用于验收 R13 的「最多 2 MB」）
    pub bytes_read: u64,
}

/// 从文件末尾往前按 64 KiB 一块读，找最后一条 `payload.type == "token_count"` 且
/// `payload.rate_limits` 是非 null 对象的行，找到就停；最多读 `MAX_READ_BYTES`。
///
/// 文件末尾如果没有换行符，说明最后一行还没写完（写入进程可能正在追加），这一段永远不当候选，
/// 不论它本身是否恰好能解析成合法 JSON。
pub fn read_last_rate_limits_line(path: &Path) -> io::Result<TailRead> {
    let mut file = fs::File::open(path)?;
    let file_len = file.metadata()?.len();

    if file_len == 0 {
        return Ok(TailRead::default());
    }

    let ends_with_newline = {
        let mut last_byte = [0u8; 1];
        file.seek(SeekFrom::Start(file_len - 1))?;
        file.read_exact(&mut last_byte)?;
        last_byte[0] == b'\n'
    };

    let mut pos = file_len;
    let mut total_read: u64 = 0;
    let mut tail: Vec<u8> = Vec::new();

    loop {
        if pos == 0 || total_read >= MAX_READ_BYTES {
            break;
        }
        let remaining_budget = MAX_READ_BYTES - total_read;
        let chunk_len = CHUNK_SIZE.min(pos as usize).min(remaining_budget as usize) as u64;
        if chunk_len == 0 {
            break;
        }
        pos -= chunk_len;
        file.seek(SeekFrom::Start(pos))?;
        let mut chunk = vec![0u8; chunk_len as usize];
        file.read_exact(&mut chunk)?;
        total_read += chunk_len;

        chunk.extend_from_slice(&tail);
        tail = chunk;

        if let Some(line) = find_last_matching_line(&tail, pos == 0, ends_with_newline) {
            return Ok(TailRead {
                line: Some(line),
                bytes_read: total_read,
            });
        }
    }

    Ok(TailRead {
        line: None,
        bytes_read: total_read,
    })
}

/// 把已读到的这段末尾字节按行拆开，从最后一行往前找第一条匹配的额度记录。
///
/// - `buf_reaches_file_start`：这段字节是否已经读到文件开头；不是的话，最左边那一段可能是
///   被截断的半行（真正的开头还没读进来），本轮不当候选。
/// - `file_ends_with_newline`：整个文件是否以换行结尾；不是的话，最右边那一段是没写完的半行，
///   永远不当候选。
fn find_last_matching_line(
    buf: &[u8],
    buf_reaches_file_start: bool,
    file_ends_with_newline: bool,
) -> Option<String> {
    let mut lines: Vec<&[u8]> = buf.split(|&b| b == b'\n').collect();

    if file_ends_with_newline {
        // 最后一个 '\n' 之后到 buf 末尾之间没有内容，split 会多出一个空段
        if lines.last().is_some_and(|s| s.is_empty()) {
            lines.pop();
        }
    } else {
        // 末尾没有换行：最后一段是还没写完的半行，永远不当候选
        lines.pop();
    }

    if !buf_reaches_file_start && !lines.is_empty() {
        // 开头那一段可能是从中间截断的半行，等读到更早的数据、这段完整了再当候选
        lines.remove(0);
    }

    lines
        .iter()
        .rev()
        .find(|line| is_rate_limits_line(line))
        .map(|line| String::from_utf8_lossy(line).into_owned())
}

/// 判断一行是不是带非 null `rate_limits` 的 `token_count` 事件。
/// 先做子串预过滤，避免给每一行都做一次 JSON 反序列化。
fn is_rate_limits_line(line: &[u8]) -> bool {
    if !contains_subslice(line, b"rate_limits") {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
        return false;
    };
    let payload = &value["payload"];
    payload.get("type").and_then(|t| t.as_str()) == Some("token_count")
        && payload.get("rate_limits").is_some_and(|rl| rl.is_object())
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return needle.is_empty();
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;
    use std::time::Duration;

    /// 一条真实带 `rate_limits` 的 token_count 事件（脱敏后的结构，字段与 testdata 一致）
    fn matching_line() -> String {
        r#"{"timestamp":"2026-09-25T17:02:55.988Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":57.0,"window_minutes":10080,"resets_at":1790578639}}}}"#.to_string()
    }

    fn null_rate_limits_line() -> String {
        r#"{"timestamp":"2026-09-25T17:02:55.988Z","type":"event_msg","payload":{"type":"token_count","rate_limits":null}}"#.to_string()
    }

    /// 100 字节一行的填充行（不含 "rate_limits" 子串），用来精确控制文件里某一行到
    /// 文件末尾的距离
    fn filler_line() -> Vec<u8> {
        let mut line = vec![b'-'; 99];
        line.push(b'\n');
        line
    }

    fn filler_bytes(total_len: usize) -> Vec<u8> {
        assert_eq!(total_len % 100, 0, "测试里的填充长度要是 100 的整数倍");
        filler_line().repeat(total_len / 100)
    }

    // ---------------- AC5：latest_rollout ----------------

    #[test]
    fn ac5_latest_rollout_none_when_sessions_dir_missing() {
        let tree = TempTree::new();
        // 连 sessions 目录都没建：全新安装 / 没跑过 Codex
        assert_eq!(latest_rollout(&tree.root()), None);
    }

    #[test]
    fn ac5_latest_rollout_none_when_sessions_dir_empty() {
        let tree = TempTree::new();
        tree.dir("sessions");
        assert_eq!(latest_rollout(&tree.root()), None);
    }

    #[test]
    fn ac5_latest_rollout_picks_newest_mtime_even_in_older_day_dir() {
        let tree = TempTree::new();
        let today = tree.dir("sessions/2026/09/26");
        let yesterday = tree.dir("sessions/2026/09/25");

        let older_path = today.join("rollout-2026-09-26T08-00-00-aaa.jsonl");
        std::fs::write(&older_path, "old").unwrap();

        // 昨天开始的会话睡醒后还在写：它的真实 mtime 比“今天”目录里的文件更新
        std::thread::sleep(Duration::from_millis(20));
        let newer_path = yesterday.join("rollout-2026-09-25T23-50-00-bbb.jsonl");
        std::fs::write(&newer_path, "new").unwrap();

        assert_eq!(latest_rollout(&tree.root()), Some(newer_path));
    }

    #[test]
    fn ac5_latest_rollout_ignores_non_rollout_files() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        std::fs::write(day.join("notes.txt"), "x").unwrap();
        assert_eq!(latest_rollout(&tree.root()), None);
    }

    // ---------------- AC5：read_last_rate_limits_line ----------------

    #[test]
    fn ac5_tail_read_matches_line_at_very_end() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        let mut content = filler_bytes(500);
        content.extend_from_slice(matching_line().as_bytes());
        content.push(b'\n');
        std::fs::write(&path, &content).unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result.line, Some(matching_line()));
        assert!(result.bytes_read <= 2 * 1024 * 1024);
    }

    #[test]
    fn ac5_tail_read_matches_line_at_1_9mb_from_end() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        let mut content = filler_bytes(500); // 再垫一点头部，避免整份文件恰好等于 1.9MB
        content.extend_from_slice(matching_line().as_bytes());
        content.push(b'\n');
        content.extend_from_slice(&filler_bytes(1_900_000)); // 命中行之后还有 1.9MB
        std::fs::write(&path, &content).unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result.line, Some(matching_line()));
        assert!(
            result.bytes_read <= 2 * 1024 * 1024,
            "bytes_read={}",
            result.bytes_read
        );
    }

    #[test]
    fn ac5_tail_read_does_not_find_line_at_2_1mb_from_end() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        let mut content = filler_bytes(500);
        content.extend_from_slice(matching_line().as_bytes());
        content.push(b'\n');
        content.extend_from_slice(&filler_bytes(2_100_000)); // 命中行之后有 2.1MB，超出 2MB 上限
        std::fs::write(&path, &content).unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result.line, None);
        assert!(
            result.bytes_read <= 2 * 1024 * 1024,
            "bytes_read={}",
            result.bytes_read
        );
    }

    #[test]
    fn ac5_tail_read_ignores_trailing_incomplete_line() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        let mut content = filler_bytes(200);
        // 唯一一条匹配的记录被写在最后，但没有结尾换行——正在被追加，当半行处理
        content.extend_from_slice(matching_line().as_bytes());
        std::fs::write(&path, &content).unwrap(); // 注意：不追加 \n

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result.line, None);
    }

    #[test]
    fn ac5_tail_read_ignores_null_rate_limits() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        let mut content = null_rate_limits_line().into_bytes();
        content.push(b'\n');
        std::fs::write(&path, &content).unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result.line, None);
    }

    #[test]
    fn ac5_tail_read_falls_back_past_null_line_to_earlier_match() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        let mut content = matching_line().into_bytes();
        content.push(b'\n');
        content.extend_from_slice(null_rate_limits_line().as_bytes());
        content.push(b'\n');
        std::fs::write(&path, &content).unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result.line, Some(matching_line()));
    }

    #[test]
    fn ac5_tail_read_empty_file_returns_none_without_error() {
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/26");
        let path = day.join("rollout-x.jsonl");
        std::fs::write(&path, b"").unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert_eq!(result, TailRead::default());
    }

    #[test]
    fn ac5_tail_read_matches_real_sample_from_testdata() {
        // 用真实（脱敏后）的样本再核对一次，确保不是只对着测试自己构造的行才成立
        let sample = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/usage/testdata/rollout_token_count.jsonl"
        ))
        .unwrap();
        let tree = TempTree::new();
        let day = tree.dir("sessions/2026/09/25");
        let path = day.join("rollout-x.jsonl");
        std::fs::write(&path, &sample).unwrap();

        let result = read_last_rate_limits_line(&path).unwrap();
        assert!(result.line.is_some());
        assert!(is_rate_limits_line(result.line.unwrap().as_bytes()));
    }
}

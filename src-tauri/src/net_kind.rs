//! 网络出错分四类（spec #248「网络出错说人话」，issue #253）：连不上 / 太慢超时 / 被限流 / 别的。
//! 检查更新、下载更新、下载 skill 共用这一份分类；给用户看的主句与出口由前端按场景出（`src/netFailure.ts`），
//! 原文（`detail`）进主句前面的「!」。纯函数，不发请求。
//! 交给前端走命令错误的老约定 `[类] 一句\n[detail] 原文`（`NetProblem::command_error`，前端 `parseBackendError` 拆）。

/// 一次联网失败归哪一类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetKind {
    /// 连不上：DNS、拒绝连接、TLS 握手被断、连到一半被重置
    Unreachable,
    /// 太慢超时：连接、等响应或读响应体超时
    Timeout,
    /// 被限流：429，或 403 带限流信号
    RateLimited,
    /// 别的：其他状态码、内容不对、本机原因
    Other,
}

impl NetKind {
    /// 命令错误前缀里的类名（`[rate_limited]`），前端 `src/netFailure.ts` 按它认
    fn code(self) -> &'static str {
        match self {
            NetKind::Unreachable => "unreachable",
            NetKind::Timeout => "timeout",
            NetKind::RateLimited => "rate_limited",
            NetKind::Other => "other",
        }
    }
}

/// 一次失败：哪一类 + 原文（调用方已去隐私）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetProblem {
    pub kind: NetKind,
    pub detail: String,
}

impl NetProblem {
    /// 每条线路都失败了（更新器先找 GitHub、最后找国内线路，`tried` 按试的先后）：按最后一条（国内线路）归类——
    /// 原因不一样时，国内线路的才是国内用户此刻的处境（GitHub 不通在国内是常态）；原文每条都留，按先后接起来
    pub fn across_lines(tried: Vec<NetProblem>) -> NetProblem {
        NetProblem {
            kind: tried.last().map_or(NetKind::Other, |last| last.kind),
            detail: tried
                .into_iter()
                .map(|p| p.detail)
                .collect::<Vec<_>>()
                .join("\n\n"),
        }
    }

    /// 交给前端的命令错误（CODING_STANDARDS「错误给人看的一句与技术原文分开」）：`[类] 一句`，
    /// 有原文时另起一行 `[detail] 原文`。`message` 不能为空——前缀后的空白连同换行会被前端一起吃掉
    pub fn command_error(&self, message: &str) -> String {
        let head = format!("[{}] {message}", self.kind.code());
        if self.detail.is_empty() {
            head
        } else {
            format!("{head}{}{}", sophia_gateway::app::DETAIL_MARK, self.detail)
        }
    }
}

/// 一个底层错误归哪一类：沿源错误链找超时与连不上的痕迹，超时优先（超时常包在连接错误里）
pub fn of_error(error: &(dyn std::error::Error + 'static)) -> NetKind {
    let mut kind = NetKind::Other;
    for_each_cause(error, &mut |cause| {
        if kind == NetKind::Timeout {
            return;
        }
        if let Some(found) = of_cause(cause) {
            kind = found;
        }
    });
    kind
}

/// 一个失败的 HTTP 状态归哪一类；`remaining` 是 `x-ratelimit-remaining`，`retry_after` 是 `retry-after`
pub fn of_status(status: u16, remaining: Option<&str>, retry_after: Option<&str>) -> NetKind {
    match status {
        429 => NetKind::RateLimited,
        // 单纯 403 是没权限；GitHub 的限流是 403 + 剩余 0（匿名每小时 60 次）或 403 + retry-after（次级限流）
        403 if remaining.map(str::trim) == Some("0") || retry_after.is_some() => {
            NetKind::RateLimited
        }
        // 408 对方等请求等超时；504 中间的网关等上游超时
        408 | 504 => NetKind::Timeout,
        _ => NetKind::Other,
    }
}

/// 错误链上的一环说明了什么；说明不了为 None
fn of_cause(cause: &(dyn std::error::Error + 'static)) -> Option<NetKind> {
    if let Some(e) = cause.downcast_ref::<reqwest::Error>() {
        if e.is_timeout() {
            return Some(NetKind::Timeout);
        }
        if e.is_connect() {
            return Some(NetKind::Unreachable);
        }
        return None;
    }
    use std::io::ErrorKind as K;
    match cause.downcast_ref::<std::io::Error>()?.kind() {
        K::TimedOut => Some(NetKind::Timeout),
        K::ConnectionRefused
        | K::ConnectionReset
        | K::ConnectionAborted
        | K::NotConnected
        | K::AddrNotAvailable
        | K::NetworkUnreachable
        | K::HostUnreachable
        | K::NetworkDown
        | K::BrokenPipe
        | K::UnexpectedEof => Some(NetKind::Unreachable),
        _ => None,
    }
}

/// 错误链上每一环的原文，按先后、去掉重复的（透明包装的那一环与它包着的同一句）
pub fn chain_parts(error: &(dyn std::error::Error + 'static)) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for_each_cause(error, &mut |cause| {
        let text = cause.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
    });
    parts
}

/// 沿源错误链走：`io::Error::source()` 会跳过它包着的那个错误，要另看 `get_ref()`
pub fn for_each_cause(
    error: &(dyn std::error::Error + 'static),
    visit: &mut impl FnMut(&(dyn std::error::Error + 'static)),
) {
    visit(error);
    match error
        .downcast_ref::<std::io::Error>()
        .and_then(|io| io.get_ref())
    {
        Some(inner) => for_each_cause(inner, visit),
        None => {
            if let Some(next) = error.source() {
                for_each_cause(next, visit);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn refused_connection_is_unreachable() {
        let e = io::Error::from(io::ErrorKind::ConnectionRefused);
        assert_eq!(of_error(&e), NetKind::Unreachable);
    }

    #[test]
    fn a_timeout_deep_in_the_chain_wins_over_a_reset() {
        // 外层是连接被重置，里面包着超时：按超时说（超时才是用户该知道的原因）
        let inner = io::Error::from(io::ErrorKind::TimedOut);
        let e = io::Error::new(io::ErrorKind::ConnectionReset, inner);
        assert_eq!(of_error(&e), NetKind::Timeout);
    }

    #[test]
    fn local_causes_are_other() {
        let e = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(of_error(&e), NetKind::Other);
        let e = io::Error::other("invalid update manifest");
        assert_eq!(of_error(&e), NetKind::Other);
    }

    #[test]
    fn status_codes() {
        assert_eq!(of_status(429, None, None), NetKind::RateLimited);
        // GitHub 的匿名限流回 403 + 剩余 0；次级限流回 403 + retry-after
        assert_eq!(of_status(403, Some(" 0 "), None), NetKind::RateLimited);
        assert_eq!(of_status(403, None, Some("60")), NetKind::RateLimited);
        // 单纯 403 是没权限，不能当限流
        assert_eq!(of_status(403, Some("12"), None), NetKind::Other);
        assert_eq!(of_status(403, None, None), NetKind::Other);
        assert_eq!(of_status(408, None, None), NetKind::Timeout);
        assert_eq!(of_status(504, None, None), NetKind::Timeout);
        assert_eq!(of_status(404, None, None), NetKind::Other);
        assert_eq!(of_status(502, None, None), NetKind::Other);
    }

    #[test]
    fn two_lines_take_the_domestic_kind() {
        let line = |kind, detail: &str| NetProblem {
            kind,
            detail: detail.to_string(),
        };
        let both = NetProblem::across_lines(vec![
            line(NetKind::Unreachable, "GitHub: connection refused"),
            line(NetKind::Timeout, "COS: timed out"),
        ]);
        assert_eq!(both.kind, NetKind::Timeout);
        assert_eq!(both.detail, "GitHub: connection refused\n\nCOS: timed out");
        // GitHub 被限流、国内线路连不上：照样按国内线路说
        let both = NetProblem::across_lines(vec![
            line(NetKind::RateLimited, "a"),
            line(NetKind::Unreachable, "b"),
        ]);
        assert_eq!(both.kind, NetKind::Unreachable);
    }

    #[test]
    fn command_error_follows_the_backend_error_protocol() {
        let p = |kind, detail: &str| NetProblem {
            kind,
            detail: detail.to_string(),
        };
        assert_eq!(
            p(NetKind::RateLimited, "GET x → 429").command_error("GitHub limited"),
            "[rate_limited] GitHub limited\n[detail] GET x → 429"
        );
        assert_eq!(
            p(NetKind::Unreachable, "").command_error("no route"),
            "[unreachable] no route"
        );
    }

    fn client() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_millis(300))
            .build()
            .unwrap()
    }

    fn send(url: String) -> reqwest::Error {
        tauri::async_runtime::block_on(async { client().get(url).send().await })
            .expect_err("应当失败")
    }

    #[test]
    fn real_request_errors() {
        // 端口没人听：连不上
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        assert_eq!(
            of_error(&send(format!("http://127.0.0.1:{port}/"))),
            NetKind::Unreachable
        );

        // 连上了但一直不回：超时
        let stalled = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", stalled.local_addr().unwrap());
        std::thread::spawn(move || {
            let held = stalled.accept();
            std::thread::sleep(std::time::Duration::from_secs(2));
            drop(held);
        });
        assert_eq!(of_error(&send(url)), NetKind::Timeout);
    }
}

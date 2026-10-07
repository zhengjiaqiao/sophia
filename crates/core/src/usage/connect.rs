//! 「连接 Claude 用量」（spec #195「修订」「画板定稿」，票 #208）的纯逻辑：连接过程处在哪一步、
//! 失败分成哪几种、各种失败对应的话与出口。起进程、计时、取消在 `sophia-gateway::usage::connect`；
//! 这里只看退出码与输出原文下判断，不读令牌、不碰账号。
//!
//! 判断依据是 #218 的真机核对（`docs/research/2026-10-06-claude-connect.md`）：Claude Code 与官方安装脚本的
//! 输出都不是公开契约，匹配不到的一律落到「安装失败 / 连接失败 + 原文」，不猜。
use super::model::{AgentId, FailReason, UsageState, UsageStatus};

/// 等浏览器里授权的上限（分钟）：`claude auth login` 自己不超时（#218 实测 11.5 分钟仍在等），由 Sophia 计
pub const LOGIN_TIMEOUT_MINUTES: u64 = 10;

/// 安装脚本的上限（分钟）：脚本里的 curl 不设超时，网络卡住会一直挂；从 Dock 启动时最小 PATH 下找不到
/// `zstd`，要下约 233 MB 未压缩的程序（#218），按慢网留足
pub const INSTALL_TIMEOUT_MINUTES: u64 = 15;

/// 安装失败（与 Claude Code 版本太旧）时「手动安装 ↗」打开的官方安装页（https://code.claude.com/docs/en/setup，
/// 也写了怎么更新）。全应用只这一处，前端经 `ConnectAction::Failed.manual_install` 拿
pub const MANUAL_INSTALL_URL: &str = "https://code.claude.com/docs/en/setup";

/// 失败的种类：决定原因行写哪句、给不给「手动安装 ↗」、「!」详情里补不补 PAC 那一句。
/// 「再试一次」所有失败都给（画板定稿：安装失败都给再试一次）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// 下载安装脚本或程序时无法访问（curl 的连接、解析、超时、TLS 错；安装脚本那句
    /// `unreachable or not available in your region` 分不出是网络还是地区，也算这一种）
    InstallNetwork,
    /// 磁盘满
    InstallNoSpace,
    /// 主目录写不进去
    InstallPermission,
    /// 其余安装失败（校验不过、另一个安装在进行、装完找不到程序……）
    Install,
    /// 授权页带着「取消 / 拒绝」回到本机，或没拿到授权码
    LoginDenied,
    /// 10 分钟内没有完成授权（Sophia 计时）
    LoginTimeout,
    /// 授权之后换令牌时连不上
    LoginNetwork,
    /// 找到的 Claude Code 太旧，没有 `auth login`
    LoginOutdated,
    /// 其余登录失败（服务端拒绝、账号暂停、组织不允许、起不来程序……）
    Login,
}

impl FailureKind {
    /// 原因行那一句（当前语言）
    pub fn text(self) -> String {
        match self {
            FailureKind::InstallNetwork => crate::t!("usage.connect.failInstallNetwork"),
            FailureKind::InstallNoSpace => crate::t!("usage.connect.failInstallNoSpace"),
            FailureKind::InstallPermission => crate::t!("usage.connect.failInstallPermission"),
            FailureKind::Install => crate::t!("usage.connect.failInstall"),
            FailureKind::LoginDenied => crate::t!("usage.connect.failDenied"),
            FailureKind::LoginTimeout => {
                crate::tn!("usage.connect.failTimeout", LOGIN_TIMEOUT_MINUTES)
            }
            FailureKind::LoginNetwork => crate::t!("usage.connect.failNetwork"),
            FailureKind::LoginOutdated => crate::t!("usage.connect.failOutdated"),
            FailureKind::Login => crate::t!("usage.connect.fail"),
        }
    }

    /// 句后给「手动安装 ↗」：安装这一步失败的（重试也不行时的出路），以及 Claude Code 太旧（官方安装页也讲怎么更新）
    pub fn manual_install(self) -> bool {
        matches!(
            self,
            FailureKind::InstallNetwork
                | FailureKind::InstallNoSpace
                | FailureKind::InstallPermission
                | FailureKind::Install
                | FailureKind::LoginOutdated
        )
    }

    /// 无法访问 Claude 的服务器（安装或登录）：「!」详情里在系统原文后补一句 PAC 的说明
    /// （#208 评论 10-07：VPN 用自动代理时 Sophia 读不到代理）
    pub fn network(self) -> bool {
        matches!(
            self,
            FailureKind::InstallNetwork | FailureKind::LoginNetwork
        )
    }
}

/// 一次失败：种类 + 技术原文（挂在句子前的「!」上，停上去看、可复制；复制前照例去隐私）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectFailure {
    pub kind: FailureKind,
    pub detail: Option<String>,
}

impl ConnectFailure {
    /// 带一句技术原文的失败（Sophia 自己判出来的，不是子进程说的）
    pub fn with_detail(kind: FailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: Some(detail.into()),
        }
    }
}

/// 连接过程此刻在哪：托盘与用量页共用一份（同一时刻只有一个连接在跑）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ConnectState {
    /// 没在连接：命令行不可用时原因行右端是「连接 Claude 用量」
    #[default]
    Idle,
    /// 后台运行官方安装脚本（不可取消）
    Installing,
    /// `claude auth login` 在等浏览器里授权；`reopen`＝拿到了授权页地址，可以「再打开 ↗」
    Waiting { reopen: bool },
    /// 登录成功，在取首轮用量（有上限）：不可取消，取完回到 Idle
    Finishing,
    /// 失败：留到下一次点、或连上为止
    Failed(ConnectFailure),
}

impl ConnectState {
    /// 正在装、正在等授权、或在取首轮用量
    pub fn in_flight(&self) -> bool {
        matches!(
            self,
            ConnectState::Installing | ConnectState::Waiting { .. } | ConnectState::Finishing
        )
    }
}

/// 点「连接 Claude 用量」时要不要不看登录记录、直接登录：Claude「需要重新登录」（登录记录还在、令牌失效）
pub fn force_login(state: &UsageState) -> bool {
    state
        .agents
        .iter()
        .any(|a| a.agent == AgentId::ClaudeCode && auth_required(&a.status))
}

/// 取数判出「需要重新登录」
pub(crate) fn auth_required(status: &UsageStatus) -> bool {
    matches!(
        status,
        UsageStatus::Failing {
            reason: FailReason::AuthRequired
        }
    )
}

/// curl 连不上的退出码：解析不了代理 / 主机（5、6）、连不上（7）、超时（28）、TLS 握手（35）、
/// 收发失败（55、56）
const CURL_NETWORK_CODES: [i32; 7] = [5, 6, 7, 28, 35, 55, 56];

/// 去掉原文前后空白；空的就是没有
fn detail_of(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// 安装失败分到哪一种（#218「失败分类」）：看退出码与 stderr。`exit` 为 `None` 是被 Sophia 结束（超时），
/// 算网络卡住
pub fn classify_install(exit: Option<i32>, stderr: &str) -> ConnectFailure {
    let lower = stderr.to_ascii_lowercase();
    let kind = if lower.contains("not available in your region") {
        // 脚本那句是「unreachable or not available in your region」，分不出网络与地区：并进网络失败
        FailureKind::InstallNetwork
    } else if lower.contains("no space left on device") {
        FailureKind::InstallNoSpace
    } else if lower.contains("permission denied") || lower.contains("read-only file system") {
        FailureKind::InstallPermission
    } else if exit.is_none()
        || exit.is_some_and(|code| CURL_NETWORK_CODES.contains(&code))
        || lower.trim_start().starts_with("curl: (")
    {
        FailureKind::InstallNetwork
    } else {
        FailureKind::Install
    };
    ConnectFailure {
        kind,
        detail: detail_of(stderr),
    }
}

/// `claude auth login` 结束后：成功＝退出码 0 且 stdout 有 `Login successful.`（#218）；
/// 是否真的写下了登录记录由调用方再看 `oauthAccount` 复核
pub fn login_succeeded(exit: Option<i32>, stdout: &str) -> bool {
    exit == Some(0) && stdout.contains("Login successful.")
}

/// 本机连不上的系统错误码（Node 的 `err.code`，原样出现在 `Login failed: connect ECONNREFUSED …` 里）
/// 与 Node 的那一句 `socket hang up`。不认泛泛的 `network`：服务端的话里也会有它
const LOGIN_NETWORK_MARKERS: [&str; 9] = [
    "econnrefused",
    "enotfound",
    "etimedout",
    "econnreset",
    "eai_again",
    "ehostunreach",
    "enetunreach",
    "econnaborted",
    "socket hang up",
];

/// 旧版 Claude Code 没有 `auth` 子命令时的几种说法【推断，未真机验证】：命令行解析器报未知命令或多余参数；
/// 或者把 `auth login` 当成提示词进了交互界面，没有终端时 Ink 报 raw mode 不支持
const LOGIN_OUTDATED_MARKERS: [&str; 3] = [
    "unknown command",
    "too many arguments",
    "raw mode is not supported",
];

/// 登录失败分到哪一种（#218「失败分类」）：看 stderr，stderr 是空的就看 stdout（有的错误只写在 stdout）；
/// 两边都空时原文写退出码
pub fn classify_login(exit: Option<i32>, stdout: &str, stderr: &str) -> ConnectFailure {
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let lower = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    let kind = if has(&[
        "no authorization code received",
        "access_denied",
        "canceled",
        "cancelled",
    ]) {
        FailureKind::LoginDenied
    } else if has(&LOGIN_NETWORK_MARKERS) {
        FailureKind::LoginNetwork
    } else if has(&LOGIN_OUTDATED_MARKERS) {
        FailureKind::LoginOutdated
    } else {
        FailureKind::Login
    };
    let detail = detail_of(text).or_else(|| {
        Some(format!(
            "claude auth login exited with {}",
            exit.map_or_else(|| "a signal".to_string(), |c| format!("code {c}"))
        ))
    });
    ConnectFailure { kind, detail }
}

/// 10 分钟到点（Sophia 结束了登录进程）
pub fn login_timed_out() -> ConnectFailure {
    ConnectFailure {
        kind: FailureKind::LoginTimeout,
        detail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #218 实测：网络不通时脚本立即以 curl 的退出码结束，stderr 只有 curl 的一行
    #[test]
    fn 安装_网络不通按curl的退出码与原文认() {
        let refused = classify_install(
            Some(7),
            "curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server\n",
        );
        assert_eq!(refused.kind, FailureKind::InstallNetwork);
        assert_eq!(
            refused.detail.as_deref(),
            Some("curl: (7) Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server")
        );
        assert_eq!(
            classify_install(Some(5), "curl: (5) Could not resolve proxy: proxy.invalid").kind,
            FailureKind::InstallNetwork
        );
        assert_eq!(
            classify_install(Some(6), "").kind,
            FailureKind::InstallNetwork,
            "解析不了主机，没有原文也认"
        );
        assert_eq!(
            classify_install(Some(1), "curl: (22) The requested URL returned error: 503").kind,
            FailureKind::InstallNetwork,
            "以 curl: ( 开头的一行"
        );
        assert_eq!(
            classify_install(None, "").kind,
            FailureKind::InstallNetwork,
            "到点被结束：网络卡住"
        );
    }

    #[test]
    fn 安装_地区并入网络_磁盘满_写不进主目录_其余() {
        let region = classify_install(
            Some(1),
            "The download service is unreachable or not available in your region.",
        );
        assert_eq!(
            region.kind,
            FailureKind::InstallNetwork,
            "脚本分不出网络与地区：并进网络失败"
        );
        assert_eq!(
            region.detail.as_deref(),
            Some("The download service is unreachable or not available in your region."),
            "原文照留"
        );
        assert_eq!(
            classify_install(Some(1), "mkdir: /Users/u/.local: No space left on device").kind,
            FailureKind::InstallNoSpace
        );
        assert_eq!(
            classify_install(Some(1), "cp: /Users/u/.local/bin/claude: Permission denied").kind,
            FailureKind::InstallPermission
        );
        let other = classify_install(Some(1), "Checksum verification failed");
        assert_eq!(other.kind, FailureKind::Install);
        assert_eq!(
            other.detail.as_deref(),
            Some("Checksum verification failed")
        );
        assert_eq!(
            classify_install(Some(1), "  \n").detail,
            None,
            "空白不算原文"
        );
    }

    /// 画板 #206 第 12 条：安装失败都给「手动安装 ↗」与「再试一次」（磁盘满、主目录写不进也给，保留各自的原因句）；
    /// 网络失败在「!」详情里补 PAC 那一句（#208 评论 10-07）
    #[test]
    fn 出口_按种类给() {
        use FailureKind::*;
        let cases = [
            // (种类, 手动安装, 网络失败)
            (InstallNetwork, true, true),
            (InstallNoSpace, true, false),
            (InstallPermission, true, false),
            (Install, true, false),
            (LoginDenied, false, false),
            (LoginTimeout, false, false),
            (LoginNetwork, false, true),
            (LoginOutdated, true, false),
            (Login, false, false),
        ];
        for (kind, manual, network) in cases {
            assert_eq!(kind.manual_install(), manual, "{kind:?}");
            assert_eq!(kind.network(), network, "{kind:?}");
        }
    }

    /// 网络失败的句子照 #208 评论（2026-10-07 产品负责人定）
    #[test]
    fn 原因句_照画板() {
        assert_eq!(
            FailureKind::InstallNetwork.text(),
            "Claude Code 安装失败 · 无法访问 Claude 的服务器 · 检查网络或 VPN 后再试"
        );
        assert_eq!(
            FailureKind::LoginDenied.text(),
            "连接失败 · 浏览器里取消了授权"
        );
        assert_eq!(
            FailureKind::LoginTimeout.text(),
            "连接失败 · 10 分钟内没有完成授权"
        );
        assert_eq!(
            FailureKind::LoginNetwork.text(),
            "连接失败 · 无法访问 Claude 的服务器 · 检查网络或 VPN 后再试"
        );
        assert_eq!(
            FailureKind::LoginOutdated.text(),
            "连接失败 · Claude Code 版本太旧 · 更新后再试"
        );
    }

    /// #218：成功＝退出码 0 + `Login successful.`；失败也会跳到 Anthropic 的「成功」页，只认进程自己的结果
    #[test]
    fn 登录_成功只认退出码0与那一句() {
        assert!(login_succeeded(
            Some(0),
            "Opening browser to sign in…\nLogin successful.\n"
        ));
        assert!(!login_succeeded(Some(0), "Opening browser to sign in…\n"));
        assert!(!login_succeeded(Some(1), "Login successful.\n"));
        assert!(
            !login_succeeded(None, "Login successful.\n"),
            "被结束的不算"
        );
    }

    /// #218 实测的几种 stderr
    #[test]
    fn 登录_失败分类() {
        let denied = classify_login(
            Some(1),
            "",
            "Login failed: No authorization code received\n",
        );
        assert_eq!(denied.kind, FailureKind::LoginDenied);
        assert_eq!(
            denied.detail.as_deref(),
            Some("Login failed: No authorization code received")
        );
        assert_eq!(
            classify_login(Some(1), "", "Login failed: access_denied: The user denied").kind,
            FailureKind::LoginDenied
        );
        assert_eq!(
            classify_login(
                Some(1),
                "",
                "Login failed: connect ECONNREFUSED 127.0.0.1:9"
            )
            .kind,
            FailureKind::LoginNetwork
        );
        assert_eq!(
            classify_login(
                Some(1),
                "",
                "Login failed: getaddrinfo ENOTFOUND platform.claude.com"
            )
            .kind,
            FailureKind::LoginNetwork
        );
        assert_eq!(
            classify_login(
                Some(1),
                "",
                "Login failed: connect EHOSTUNREACH 160.79.104.10:443"
            )
            .kind,
            FailureKind::LoginNetwork
        );
        assert_eq!(
            classify_login(
                Some(1),
                "",
                "Login failed: Request failed with status code 400"
            )
            .kind,
            FailureKind::Login
        );
        assert_eq!(
            classify_login(Some(1), "", "Login failed: Invalid state parameter").kind,
            FailureKind::Login
        );
        assert_eq!(login_timed_out().kind, FailureKind::LoginTimeout);
    }

    /// 「network」这个词太宽：服务端说的话里带它（组织的网络策略之类）不是本机连不上
    #[test]
    fn 登录_network这个词不算网络失败() {
        assert_eq!(
            classify_login(
                Some(1),
                "",
                "Login failed: Your organization's network policy does not allow this sign-in"
            )
            .kind,
            FailureKind::Login
        );
    }

    /// 错误只写在 stdout、stderr 为空：照 stdout 分类，原文也取 stdout；两边都空才写退出码
    #[test]
    fn 登录_stderr为空时看stdout() {
        let f = classify_login(
            Some(1),
            "Opening browser to sign in…\nLogin failed: connect ETIMEDOUT 160.79.104.10:443\n",
            "  \n",
        );
        assert_eq!(f.kind, FailureKind::LoginNetwork);
        assert!(f.detail.unwrap().contains("ETIMEDOUT"));
        let silent = classify_login(Some(3), "", "");
        assert_eq!(silent.kind, FailureKind::Login);
        assert_eq!(
            silent.detail.as_deref(),
            Some("claude auth login exited with code 3")
        );
        assert_eq!(
            classify_login(None, "", "").detail.as_deref(),
            Some("claude auth login exited with a signal")
        );
    }

    /// 旧版 Claude Code 没有 `auth login`（命令行解析器报未知命令 / 多余参数，或把它当提示词进了交互界面、
    /// 在没有终端时报 raw mode）：给「版本太旧，更新后再试」
    #[test]
    fn 登录_旧版没有auth_login() {
        for out in [
            "error: unknown command 'auth'",
            "error: too many arguments. Expected 1 argument but got 2.",
            "Error: Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.",
        ] {
            assert_eq!(
                classify_login(Some(1), "", out).kind,
                FailureKind::LoginOutdated,
                "{out}"
            );
        }
    }

    /// 「需要重新登录」：登录记录还在也要走登录（命令层一行调这里）
    #[test]
    fn 需要重新登录才强制登录() {
        use crate::usage::{AgentId, AgentUsage, FailReason, UsageState, UsageStatus};
        let state = |agent, status| UsageState {
            agents: vec![AgentUsage {
                agent,
                status,
                reading: None,
                attempted_at: None,
                desktop_app: false,
            }],
        };
        let auth = UsageStatus::Failing {
            reason: FailReason::AuthRequired,
        };
        assert!(force_login(&state(AgentId::ClaudeCode, auth.clone())));
        assert!(!force_login(&state(
            AgentId::ClaudeCode,
            UsageStatus::NotSignedIn
        )));
        assert!(!force_login(&state(AgentId::Codex, auth)));
    }

    /// 取完首轮用量那一段也算在连接里（键不露出来），但不能再取消（见 `Finishing`）
    #[test]
    fn 取首轮用量时也在连接中() {
        assert!(ConnectState::Finishing.in_flight());
    }
}

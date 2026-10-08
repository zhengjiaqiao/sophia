//! 国产编程套餐（Kimi、智谱、Z.ai、MiniMax）额度的纯逻辑：认出提供商、给出请求的写法、解析返回。
//! 不发请求（请求在 `sophia-gateway`）。
//!
//! 四家接口全部「未实测」（unverified）：形态取自竞品与官方命令行的源码，
//! 出处见 `docs/research/2026-10-08-cn-plan-quota.md` 与各测试夹具的注释。
use super::model::{Severity, Window, WindowKind};
use super::parse::{duration_key_and_kind, parse_rfc3339, severity_from_percent};
use serde_json::Value;

// ---------------- 认出 ----------------

/// 有额度接口的编程套餐提供商
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlanProvider {
    Kimi,
    /// 智谱（open.bigmodel.cn）
    Zhipu,
    /// Z.ai（api.z.ai，智谱国际站）
    Zai,
    MiniMax,
}

/// 鉴权头的写法
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStyle {
    /// `Authorization: Bearer <key>`
    Bearer,
    /// `Authorization: <key>`，不加 Bearer（智谱、Z.ai）
    Raw,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanMethod {
    Get,
    Post,
}

/// 一个候选请求
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanRequest {
    pub method: PlanMethod,
    pub url: String,
}

/// 认出的编程套餐：调用方按 `candidates` 的顺序依次试，第一个能解出结果的为准
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanSource {
    pub provider: PlanProvider,
    pub candidates: Vec<PlanRequest>,
    pub auth: AuthStyle,
}

impl PlanSource {
    /// `Authorization` 头的值
    pub fn authorization(&self, key: &str) -> String {
        match self.auth {
            AuthStyle::Bearer => format!("Bearer {key}"),
            AuthStyle::Raw => key.to_string(),
        }
    }
}

/// 拆出 http(s) 地址的主机（小写、去端口与用户信息）和路径。不是 http(s) 或主机可疑返回 None
fn host_and_path(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains(['\\', ' ', '\t']) {
        return None;
    }
    // 用户信息之后才是主机（`api.kimi.com@evil.com` 的主机是 evil.com）
    let host_port = authority.rsplit('@').next()?;
    let host = match host_port.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host_port,
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let path = tail.split(['?', '#']).next().unwrap_or("").to_string();
    Some((host, path))
}

fn get(url: String) -> PlanRequest {
    PlanRequest {
        method: PlanMethod::Get,
        url,
    }
}

/// 由提供商的基址认出编程套餐；不是四家之一（或 Kimi 的路径里没有 `/coding`）返回 None。
/// 请求地址一律 https，不带用户填的端口与用户信息（密钥只发往这四家的官方域名）。
/// 未实测（unverified）。
pub fn detect_plan_source(base_url: &str) -> Option<PlanSource> {
    let (host, path) = host_and_path(base_url)?;
    match host.as_str() {
        "api.kimi.com" | "api.kimi.ai" => {
            // 路径里要有 `coding` 段；取到它为止再接 `/v1/usages`（参照 magpie 的 kimiCodeBase，
            // 无论用户填的是 `/coding` 还是 `/coding/v1`）
            let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            let idx = segments.iter().position(|s| *s == "coding")?;
            let base = segments[..=idx].join("/");
            Some(PlanSource {
                provider: PlanProvider::Kimi,
                candidates: vec![get(format!("https://{host}/{base}/v1/usages"))],
                auth: AuthStyle::Bearer,
            })
        }
        "open.bigmodel.cn" => Some(PlanSource {
            provider: PlanProvider::Zhipu,
            candidates: vec![get(format!("https://{host}/api/monitor/usage/quota/limit"))],
            auth: AuthStyle::Raw,
        }),
        "api.z.ai" => Some(PlanSource {
            provider: PlanProvider::Zai,
            candidates: vec![get(format!("https://{host}/api/monitor/usage/quota/limit"))],
            auth: AuthStyle::Raw,
        }),
        "api.minimaxi.com" | "api.minimax.io" | "api.minimax.cn" => {
            let mut candidates = vec![get(format!("https://{host}/v1/token_plan/remains"))];
            // 官方 FAQ 写的是 POST www.minimax.cn；国际站（.io）的密钥不发往国内域名
            if host != "api.minimax.io" {
                candidates.push(PlanRequest {
                    method: PlanMethod::Post,
                    url: "https://www.minimax.cn/v1/token_plan/remains".to_string(),
                });
            }
            Some(PlanSource {
                provider: PlanProvider::MiniMax,
                candidates,
                auth: AuthStyle::Bearer,
            })
        }
        _ => None,
    }
}

// ---------------- 解析 ----------------

/// 一个套餐窗口：通用的 [`Window`]，外加来源给了绝对数时的已用与上限（Kimi），给托盘写小字
#[derive(Debug, Clone, PartialEq)]
pub struct PlanWindow {
    pub window: Window,
    pub used: Option<f64>,
    pub limit: Option<f64>,
}

/// 一次读额度的结果分类
#[derive(Debug, Clone, PartialEq)]
pub enum PlanOutcome {
    /// 有窗口
    Windows(Vec<PlanWindow>),
    /// 没有套餐额度（按量付费、团队版等，返回里没有窗口）
    NoPlanQuota,
    /// 密钥被拒
    KeyRejected,
    /// 套餐过期
    PlanExpired,
    /// 解析失败或服务端报了别的错；`reason` 是英文原因，进日志，不直接给用户看
    ParseFailed { reason: String },
}

fn failed(reason: impl Into<String>) -> PlanOutcome {
    PlanOutcome::ParseFailed {
        reason: reason.into(),
    }
}

/// 数字，或写成字符串的数字
fn num(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// 毫秒或秒的时间戳换成 Unix 秒（≥1e12 当毫秒）；非正数当没给
fn epoch_secs(n: f64) -> Option<i64> {
    if n <= 0.0 {
        None
    } else if n >= 1e12 {
        Some((n / 1000.0) as i64)
    } else {
        Some(n as i64)
    }
}

fn make_window(
    minutes: Option<u32>,
    key_fallback: &str,
    used_percent: f64,
    resets_at: Option<i64>,
) -> Window {
    let used_percent = used_percent.clamp(0.0, 100.0);
    let (key, kind) = match minutes {
        Some(m) => duration_key_and_kind(m),
        None => (
            key_fallback.to_string(),
            WindowKind::Legacy {
                label: key_fallback.to_string(),
            },
        ),
    };
    Window {
        key,
        kind,
        used_percent,
        resets_at,
        window_minutes: minutes,
        severity: severity_from_percent(used_percent),
        active: false,
    }
}

/// 同一个键只留第一个（Kimi 的 `limits[]` 与周额度可能撞上同一时长）
fn push_unique(out: &mut Vec<PlanWindow>, w: PlanWindow) {
    if !out.iter().any(|x| x.window.key == w.window.key) {
        out.push(w);
    }
}

fn finish(windows: Vec<PlanWindow>, had_entries: bool) -> PlanOutcome {
    if !windows.is_empty() {
        PlanOutcome::Windows(windows)
    } else if had_entries {
        failed("no usable window in the reply")
    } else {
        PlanOutcome::NoPlanQuota
    }
}

/// 服务端报错（HTTP 200 里的错误码与文字）归类。码值取自各家的错误约定，未实测
fn classify_error(code: Option<i64>, msg: &str, auth_codes: &[i64]) -> PlanOutcome {
    let lower = msg.to_ascii_lowercase();
    if code.is_some_and(|c| auth_codes.contains(&c))
        || lower.contains("api key")
        || lower.contains("apikey")
        || lower.contains("unauthorized")
        || lower.contains("invalid token")
        || lower.contains("login fail")
    {
        PlanOutcome::KeyRejected
    } else if lower.contains("expire") {
        PlanOutcome::PlanExpired
    } else {
        let code = code.map_or_else(|| "none".to_string(), |c| c.to_string());
        failed(format!("server error, code {code}: {msg}"))
    }
}

/// 解析一家的额度返回。`status` 是 HTTP 状态码，`body` 是 JSON（非 JSON 时传 `Value::Null`），
/// `now` 是当前 Unix 秒（只在 Kimi 给「多少秒后重置」时用）。未实测（unverified）。
pub fn parse_plan_response(
    provider: PlanProvider,
    status: u16,
    body: &Value,
    now: i64,
) -> PlanOutcome {
    if status == 401 || status == 403 {
        return PlanOutcome::KeyRejected;
    }
    if !(200..300).contains(&status) {
        return failed(format!("http status {status}"));
    }
    match provider {
        PlanProvider::Kimi => parse_kimi(body, now),
        PlanProvider::Zhipu | PlanProvider::Zai => parse_zhipu(body),
        PlanProvider::MiniMax => parse_minimax(body),
    }
}

// ---- Kimi ----

/// 重置时刻：`resetTime` 等四种写法（RFC3339 字符串），或「多少秒后」的 `reset_in` / `resetIn` / `ttl`
fn kimi_reset(d: &Value, now: i64) -> Option<i64> {
    for k in ["resetTime", "resetAt", "reset_at", "reset_time"] {
        if let Some(s) = d.get(k).and_then(Value::as_str) {
            if let Some(t) = parse_rfc3339(s) {
                return Some(t);
            }
        }
    }
    for k in ["reset_in", "resetIn", "ttl"] {
        if let Some(secs) = d.get(k).and_then(num).filter(|s| *s > 0.0) {
            return Some(now + secs as i64);
        }
    }
    None
}

/// 一项（`usage` 或 `limits[].detail`）：上限、已用（或剩余）→ 窗口
fn kimi_item(d: &Value, minutes: u32, now: i64) -> Option<PlanWindow> {
    let limit = d.get("limit").and_then(num).filter(|l| *l > 0.0)?;
    let used = match d.get("used").and_then(num) {
        Some(u) => u,
        None => limit - d.get("remaining").and_then(num)?,
    };
    let used = used.clamp(0.0, limit);
    Some(PlanWindow {
        window: make_window(Some(minutes), "", used / limit * 100.0, kimi_reset(d, now)),
        used: Some(used),
        limit: Some(limit),
    })
}

/// `window.duration` + `window.timeUnit`（如 `TIME_UNIT_MINUTE`）换成分钟
fn kimi_minutes(item: &Value) -> Option<u32> {
    let w = item.get("window").unwrap_or(item);
    let n = w.get("duration").and_then(num).filter(|n| *n > 0.0)?;
    let unit = w
        .get("timeUnit")
        .and_then(Value::as_str)?
        .to_ascii_uppercase();
    let minutes = if unit.contains("MINUTE") {
        n
    } else if unit.contains("HOUR") {
        n * 60.0
    } else if unit.contains("DAY") {
        n * 1440.0
    } else if unit.contains("SECOND") {
        (n / 60.0).round()
    } else {
        return None;
    };
    (minutes >= 1.0 && minutes <= f64::from(u32::MAX)).then_some(minutes as u32)
}

fn parse_kimi(body: &Value, now: i64) -> PlanOutcome {
    if !body.is_object() {
        return failed("reply is not a JSON object");
    }
    let usage = body.get("usage");
    let limits = body.get("limits");
    if usage.is_none() && limits.is_none() {
        return failed("no usage or limits in the reply");
    }
    let mut out = Vec::new();
    let mut had_entries = false;
    if let Some(items) = limits.and_then(Value::as_array) {
        for item in items {
            had_entries = true;
            let detail = item.get("detail").filter(|d| d.is_object()).unwrap_or(item);
            if let Some(w) = kimi_minutes(item).and_then(|m| kimi_item(detail, m, now)) {
                push_unique(&mut out, w);
            }
        }
    }
    if let Some(u) = usage.filter(|u| u.as_object().is_some_and(|o| !o.is_empty())) {
        had_entries = true;
        // `usage` 是周额度
        if let Some(w) = kimi_item(u, 10080, now) {
            push_unique(&mut out, w);
        }
    }
    finish(out, had_entries)
}

// ---- 智谱 / Z.ai ----

fn parse_zhipu(body: &Value) -> PlanOutcome {
    if !body.is_object() {
        return failed("reply is not a JSON object");
    }
    let code = body.get("code").and_then(num).map(|c| c as i64);
    let msg = body.get("msg").and_then(Value::as_str).unwrap_or("");
    let success = body.get("success").and_then(Value::as_bool);
    let data = body.get("data").filter(|d| d.is_object());
    if success == Some(false) || code.is_some_and(|c| c != 200) || data.is_none() {
        // 1000–1004 是智谱的鉴权类错误码
        return match (success, code, data) {
            (None, None, None) => failed("no data in the reply"),
            _ => classify_error(code, msg, &[1000, 1001, 1002, 1003, 1004]),
        };
    }
    let mut out = Vec::new();
    let mut had_entries = false;
    let limits = data
        .and_then(|d| d.get("limits"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for l in limits {
        // 只取 token 额度；TIME_LIMIT 是每月 MCP 次数，不拦模型
        if !l
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| t.eq_ignore_ascii_case("TOKENS_LIMIT"))
        {
            continue;
        }
        had_entries = true;
        // 只认 unit（3 小时、6 周）；number 不可靠
        let minutes = match l.get("unit").and_then(num).map(|u| u as i64) {
            Some(3) => 300,
            Some(6) => 10080,
            _ => continue,
        };
        let Some(percent) = l.get("percentage").and_then(num) else {
            continue;
        };
        let resets_at = l.get("nextResetTime").and_then(num).and_then(epoch_secs);
        push_unique(
            &mut out,
            PlanWindow {
                window: make_window(Some(minutes), "", percent, resets_at),
                used: None,
                limit: None,
            },
        );
    }
    finish(out, had_entries)
}

// ---- MiniMax ----

/// 一个窗口（5 小时或每周）：只告诉剩余百分比；状态 2 是用尽，3 是不限
fn minimax_window(
    b: &Value,
    prefix: &str,
    time_prefix: &str,
    default_minutes: u32,
) -> Option<PlanWindow> {
    let f = |suffix: &str| b.get(format!("{prefix}{suffix}"));
    let status = f("status").and_then(num).map(|s| s as i64);
    if status == Some(3) {
        return None;
    }
    let used_percent = if status == Some(2) {
        100.0
    } else {
        100.0 - f("remaining_percent").and_then(num)?
    };
    let start = b
        .get(format!("{time_prefix}start_time"))
        .and_then(num)
        .and_then(epoch_secs);
    let end = b
        .get(format!("{time_prefix}end_time"))
        .and_then(num)
        .and_then(epoch_secs);
    let minutes = match (start, end) {
        (Some(s), Some(e)) if e > s => u32::try_from(((e - s) as f64 / 60.0).round() as i64).ok(),
        _ => None,
    }
    .unwrap_or(default_minutes);
    Some(PlanWindow {
        window: make_window(Some(minutes), "", used_percent, end),
        used: None,
        limit: None,
    })
}

fn parse_minimax(body: &Value) -> PlanOutcome {
    if !body.is_object() {
        return failed("reply is not a JSON object");
    }
    // 被拒的密钥也回 HTTP 200，错误在 base_resp 里
    let Some(base) = body.get("base_resp").filter(|b| b.is_object()) else {
        return failed("no base_resp in the reply");
    };
    let code = base.get("status_code").and_then(num).map(|c| c as i64);
    if code != Some(0) {
        let msg = base.get("status_msg").and_then(Value::as_str).unwrap_or("");
        // 1004（登录失败）、2049（无效密钥）
        return classify_error(code, msg, &[1004, 2049]);
    }
    let Some(remains) = body.get("model_remains").and_then(Value::as_array) else {
        return failed("no model_remains in the reply");
    };
    let mut out = Vec::new();
    let mut had_entries = false;
    // 只取编程模型 general；video 等另计，不拦编程
    for b in remains.iter().filter(|b| {
        b.get("model_name")
            .and_then(Value::as_str)
            .is_some_and(|n| n.trim().eq_ignore_ascii_case("general"))
    }) {
        had_entries = true;
        for (prefix, time_prefix, minutes) in [
            ("current_interval_", "", 300),
            ("current_weekly_", "weekly_", 10080),
        ] {
            if let Some(w) = minimax_window(b, prefix, time_prefix, minutes) {
                push_unique(&mut out, w);
            }
        }
    }
    if !had_entries {
        return PlanOutcome::NoPlanQuota;
    }
    // general 在，但两个窗口都不限：套餐里没有这项额度
    if out.is_empty() {
        let all_unlimited = remains.iter().all(|b| {
            [
                b.get("current_interval_status"),
                b.get("current_weekly_status"),
            ]
            .iter()
            .all(|s| s.and_then(num) == Some(3.0))
        });
        return if all_unlimited {
            PlanOutcome::NoPlanQuota
        } else {
            failed("no usable window in the reply")
        };
    }
    PlanOutcome::Windows(out)
}

/// 严重程度的便捷读取（供测试与调用方不必再引 `Severity`）
impl PlanWindow {
    pub fn severity(&self) -> Severity {
        self.window.severity
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000;

    fn windows(o: PlanOutcome) -> Vec<PlanWindow> {
        match o {
            PlanOutcome::Windows(w) => w,
            other => panic!("expected windows, got {other:?}"),
        }
    }

    // ---------------- 认出（unverified：规则取自竞品，未对真实套餐实测） ----------------

    fn det(url: &str) -> Option<PlanSource> {
        detect_plan_source(url)
    }

    #[test]
    fn detect_kimi_unverified() {
        // magpie `planquota.go` 第 41–44 行（Kimi Code 认 api.kimi.com / api.kimi.ai 且路径含 /coding）、
        // kimiCodeBase（第 284–290 行，`/coding` 补成 `/coding/v1`）
        for (input, want) in [
            (
                "https://api.kimi.com/coding/",
                "https://api.kimi.com/coding/v1/usages",
            ),
            (
                "https://api.kimi.com/coding",
                "https://api.kimi.com/coding/v1/usages",
            ),
            (
                "https://api.kimi.com/coding/v1",
                "https://api.kimi.com/coding/v1/usages",
            ),
            (
                "https://api.kimi.ai/coding/v1/",
                "https://api.kimi.ai/coding/v1/usages",
            ),
            (
                "HTTPS://API.KIMI.COM:443/coding/v1",
                "https://api.kimi.com/coding/v1/usages",
            ),
        ] {
            let s = det(input).unwrap_or_else(|| panic!("{input}"));
            assert_eq!(s.provider, PlanProvider::Kimi);
            assert_eq!(s.auth, AuthStyle::Bearer);
            assert_eq!(
                s.candidates,
                vec![PlanRequest {
                    method: PlanMethod::Get,
                    url: want.to_string()
                }]
            );
        }
        assert_eq!(
            det("https://api.kimi.com/coding/v1")
                .unwrap()
                .authorization("k"),
            "Bearer k"
        );
    }

    #[test]
    fn detect_kimi_without_coding_path_is_none_unverified() {
        assert!(det("https://api.kimi.com/v1").is_none());
        assert!(det("https://api.kimi.com").is_none());
        assert!(det("https://api.kimi.com/codingx/v1").is_none());
    }

    #[test]
    fn detect_zhipu_and_zai_unverified() {
        // magpie `planquota.go` 第 37–40 行；cc-switch `coding_plan.rs` 第 351 行：智谱不加 Bearer
        let z = det("https://open.bigmodel.cn/api/anthropic").unwrap();
        assert_eq!(z.provider, PlanProvider::Zhipu);
        assert_eq!(z.auth, AuthStyle::Raw);
        assert_eq!(z.authorization("abc.def"), "abc.def");
        assert_eq!(
            z.candidates[0].url,
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
        );
        // 改过路径的地址照样认
        assert_eq!(
            det("https://open.bigmodel.cn/api/coding/paas/v4")
                .unwrap()
                .provider,
            PlanProvider::Zhipu
        );
        let z = det("https://api.z.ai/api/anthropic").unwrap();
        assert_eq!(z.provider, PlanProvider::Zai);
        assert_eq!(z.auth, AuthStyle::Raw);
        assert_eq!(
            z.candidates[0].url,
            "https://api.z.ai/api/monitor/usage/quota/limit"
        );
    }

    #[test]
    fn detect_minimax_gives_both_candidates_unverified() {
        // magpie 第 50–53 行（GET /v1/token_plan/remains）；官方 FAQ 另写 POST www.minimax.cn
        let s = det("https://api.minimaxi.com/anthropic").unwrap();
        assert_eq!(s.provider, PlanProvider::MiniMax);
        assert_eq!(s.auth, AuthStyle::Bearer);
        assert_eq!(
            s.candidates,
            vec![
                PlanRequest {
                    method: PlanMethod::Get,
                    url: "https://api.minimaxi.com/v1/token_plan/remains".into()
                },
                PlanRequest {
                    method: PlanMethod::Post,
                    url: "https://www.minimax.cn/v1/token_plan/remains".into()
                },
            ]
        );
        assert_eq!(
            det("https://api.minimax.cn/v1").unwrap().candidates.len(),
            2
        );
        // 国际站只试自己的域名，密钥不发往国内
        let io = det("https://api.minimax.io/v1").unwrap();
        assert_eq!(io.candidates.len(), 1);
        assert_eq!(
            io.candidates[0].url,
            "https://api.minimax.io/v1/token_plan/remains"
        );
    }

    #[test]
    fn detect_ignores_unrelated_and_lookalike_hosts_unverified() {
        for url in [
            "https://api.openai.com/v1",
            "https://api.moonshot.cn/v1",
            "https://api.kimi.com.evil.com/coding/v1",
            "https://evil.com/api.kimi.com/coding",
            "https://api.kimi.com@evil.com/coding/v1",
            "https://notopen.bigmodel.cn/api",
            "https://open.bigmodel.cn.evil.com/api",
            "http://localhost:8080/coding",
            "ftp://api.z.ai/x",
            "api.z.ai/x",
            "",
        ] {
            assert!(det(url).is_none(), "{url}");
        }
        // 用户信息在前、主机在后仍按真正的主机认
        assert!(det("https://user:pw@api.z.ai/x").is_some());
    }

    // ---------------- Kimi（unverified） ----------------
    // 形态出处：magpie `internal/provider/planquota.go` 第 311–324 行的注释（readKimiCode）、
    // kimi-cli `src/kimi_cli/ui/shell/usage.py` 第 107–199 行（提交 9ab1286）

    fn kimi_fixture() -> Value {
        json!({
            "usage": {"limit": "100", "used": "12", "resetTime": "2026-09-30T05:24:18.44Z"},
            "limits": [{
                "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                "detail": {"limit": "100", "remaining": "88", "resetTime": "2026-09-27T05:24:18.44Z"}
            }]
        })
    }

    #[test]
    fn kimi_normal_unverified() {
        let w = windows(parse_plan_response(
            PlanProvider::Kimi,
            200,
            &kimi_fixture(),
            NOW,
        ));
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].window.key, "session");
        assert_eq!(w[0].window.kind, WindowKind::Session);
        assert_eq!(w[0].window.window_minutes, Some(300));
        assert_eq!(w[0].window.used_percent, 12.0);
        assert_eq!(w[0].used, Some(12.0));
        assert_eq!(w[0].limit, Some(100.0));
        assert_eq!(
            w[0].window.resets_at,
            parse_rfc3339("2026-09-27T05:24:18.44Z")
        );
        assert_eq!(w[1].window.kind, WindowKind::Weekly);
        assert_eq!(w[1].window.window_minutes, Some(10080));
        assert_eq!(w[1].window.used_percent, 12.0);
        assert_eq!(
            w[1].window.resets_at,
            parse_rfc3339("2026-09-30T05:24:18.44Z")
        );
    }

    #[test]
    fn kimi_string_and_number_values_unverified() {
        // 数值可能是字符串也可能是数字；used 与 remaining 二选一（kimi-cli usage.py 第 124–131 行）
        let body = json!({
            "usage": {"limit": 200, "remaining": 50, "reset_at": "2026-09-30T00:00:00Z"},
            "limits": [{
                "window": {"duration": "5", "timeUnit": "TIME_UNIT_HOUR"},
                "detail": {"limit": 40, "used": "10"}
            }]
        });
        let w = windows(parse_plan_response(PlanProvider::Kimi, 200, &body, NOW));
        assert_eq!(w[0].window.window_minutes, Some(300));
        assert_eq!(w[0].window.used_percent, 25.0);
        assert_eq!(w[0].window.resets_at, None);
        assert_eq!(w[1].window.used_percent, 75.0);
        assert_eq!(w[1].used, Some(150.0));
        assert_eq!(w[1].window.resets_at, parse_rfc3339("2026-09-30T00:00:00Z"));
    }

    #[test]
    fn kimi_reset_in_seconds_unverified() {
        // kimi-cli usage.py 第 189–199 行：reset_in / resetIn / ttl 是多少秒后
        let body = json!({"usage": {"limit": 10, "used": 1, "resetIn": 3600}});
        let w = windows(parse_plan_response(PlanProvider::Kimi, 200, &body, NOW));
        assert_eq!(w[0].window.resets_at, Some(NOW + 3600));
    }

    #[test]
    fn kimi_other_duration_unverified() {
        let body = json!({"limits": [{
            "window": {"duration": 1, "timeUnit": "TIME_UNIT_DAY"},
            "detail": {"limit": "10", "used": "10"}
        }]});
        let w = windows(parse_plan_response(PlanProvider::Kimi, 200, &body, NOW));
        assert_eq!(w[0].window.key, "minutes:1440");
        assert_eq!(w[0].window.used_percent, 100.0);
        assert_eq!(w[0].severity(), Severity::Critical);
    }

    #[test]
    fn kimi_no_windows_unverified() {
        let body = json!({"usage": {}, "limits": []});
        assert_eq!(
            parse_plan_response(PlanProvider::Kimi, 200, &body, NOW),
            PlanOutcome::NoPlanQuota
        );
    }

    #[test]
    fn kimi_key_rejected_unverified() {
        // kimi-cli 对非 2xx 抛错（raise_for_status）；401 = 密钥无效
        assert_eq!(
            parse_plan_response(
                PlanProvider::Kimi,
                401,
                &json!({"error": "unauthorized"}),
                NOW
            ),
            PlanOutcome::KeyRejected
        );
        assert_eq!(
            parse_plan_response(PlanProvider::Kimi, 403, &Value::Null, NOW),
            PlanOutcome::KeyRejected
        );
    }

    #[test]
    fn kimi_missing_fields_unverified() {
        // 没有 usage 也没有 limits
        assert!(matches!(
            parse_plan_response(PlanProvider::Kimi, 200, &json!({"foo": 1}), NOW),
            PlanOutcome::ParseFailed { .. }
        ));
        // 有条目但缺 limit、缺 used/remaining、缺时长单位：解不出窗口
        let body = json!({
            "usage": {"used": "3"},
            "limits": [
                {"window": {"duration": 300}, "detail": {"limit": "10", "used": "1"}},
                {"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"}, "detail": {"limit": "10"}}
            ]
        });
        assert!(matches!(
            parse_plan_response(PlanProvider::Kimi, 200, &body, NOW),
            PlanOutcome::ParseFailed { .. }
        ));
        assert!(matches!(
            parse_plan_response(PlanProvider::Kimi, 200, &json!([1]), NOW),
            PlanOutcome::ParseFailed { .. }
        ));
        assert!(matches!(
            parse_plan_response(PlanProvider::Kimi, 500, &Value::Null, NOW),
            PlanOutcome::ParseFailed { .. }
        ));
    }

    #[test]
    fn kimi_part_usable_keeps_the_usable_one_unverified() {
        let body = json!({
            "usage": {"limit": "100", "used": "x"},
            "limits": [{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {"limit": "100", "remaining": "40"}}]
        });
        let w = windows(parse_plan_response(PlanProvider::Kimi, 200, &body, NOW));
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].window.used_percent, 60.0);
    }

    // ---------------- 智谱 / Z.ai（unverified） ----------------
    // 形态出处：magpie `planquota.go` 第 63–72 行的注释（readZhipuPlan）；
    // cc-switch `src-tauri/src/services/coding_plan.rs` 第 248–265 行（周窗 number 既有 1 也有 7，只认 unit）

    fn zhipu_fixture() -> Value {
        json!({"success": true, "data": {"level": "pro", "limits": [
            {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 12, "nextResetTime": 1758800000000_i64},
            {"type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 40, "nextResetTime": 1759300000000_i64},
            {"type": "TIME_LIMIT", "unit": 5, "number": 1, "percentage": 3, "nextResetTime": 1759900000000_i64}
        ]}})
    }

    #[test]
    fn zhipu_normal_skips_time_limit_unverified() {
        for p in [PlanProvider::Zhipu, PlanProvider::Zai] {
            let w = windows(parse_plan_response(p, 200, &zhipu_fixture(), NOW));
            assert_eq!(w.len(), 2);
            assert_eq!(w[0].window.kind, WindowKind::Session);
            assert_eq!(w[0].window.used_percent, 12.0);
            assert_eq!(w[0].window.resets_at, Some(1_758_800_000));
            assert_eq!(w[0].used, None);
            assert_eq!(w[1].window.kind, WindowKind::Weekly);
            assert_eq!(w[1].window.window_minutes, Some(10080));
            assert_eq!(w[1].window.used_percent, 40.0);
        }
    }

    #[test]
    fn zhipu_only_unit_counts_not_number_unverified() {
        let body = json!({"success": true, "data": {"limits": [
            {"type": "TOKENS_LIMIT", "unit": 6, "number": 7, "percentage": "55.5", "nextResetTime": "1759300000000"},
            {"type": "TOKENS_LIMIT", "unit": 3, "percentage": 100}
        ]}});
        let w = windows(parse_plan_response(PlanProvider::Zhipu, 200, &body, NOW));
        let weekly = w.iter().find(|x| x.window.key == "weekly").unwrap();
        assert_eq!(weekly.window.used_percent, 55.5);
        assert_eq!(weekly.window.resets_at, Some(1_759_300_000));
        let session = w.iter().find(|x| x.window.key == "session").unwrap();
        assert_eq!(session.window.window_minutes, Some(300));
        assert_eq!(session.window.resets_at, None);
        assert_eq!(session.severity(), Severity::Critical);
    }

    #[test]
    fn zhipu_no_token_limit_means_no_quota_unverified() {
        let body = json!({"success": true, "data": {"level": "lite", "limits": [
            {"type": "TIME_LIMIT", "unit": 5, "number": 1, "percentage": 3}
        ]}});
        assert_eq!(
            parse_plan_response(PlanProvider::Zhipu, 200, &body, NOW),
            PlanOutcome::NoPlanQuota
        );
        let empty = json!({"success": true, "data": {"limits": []}});
        assert_eq!(
            parse_plan_response(PlanProvider::Zai, 200, &empty, NOW),
            PlanOutcome::NoPlanQuota
        );
    }

    #[test]
    fn zhipu_key_rejected_unverified() {
        // HTTP 401，或 200 里 success=false 带鉴权类错误码（码值为推测，未实测）
        assert_eq!(
            parse_plan_response(PlanProvider::Zhipu, 401, &Value::Null, NOW),
            PlanOutcome::KeyRejected
        );
        let body = json!({"code": 1002, "msg": "Authorization Token invalid", "success": false});
        assert_eq!(
            parse_plan_response(PlanProvider::Zhipu, 200, &body, NOW),
            PlanOutcome::KeyRejected
        );
    }

    #[test]
    fn zhipu_other_errors_and_missing_fields_unverified() {
        let body = json!({"success": false, "msg": "busy"});
        match parse_plan_response(PlanProvider::Zai, 200, &body, NOW) {
            PlanOutcome::ParseFailed { reason } => assert!(reason.contains("busy")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse_plan_response(PlanProvider::Zai, 200, &json!({}), NOW),
            PlanOutcome::ParseFailed { .. }
        ));
        // 缺 percentage / 未知 unit：解不出窗口
        let body = json!({"success": true, "data": {"limits": [
            {"type": "TOKENS_LIMIT", "unit": 3},
            {"type": "TOKENS_LIMIT", "unit": 9, "percentage": 1}
        ]}});
        assert!(matches!(
            parse_plan_response(PlanProvider::Zai, 200, &body, NOW),
            PlanOutcome::ParseFailed { .. }
        ));
    }

    #[test]
    fn zhipu_expired_by_message_unverified() {
        let body = json!({"success": false, "code": 1308, "msg": "Plan expired"});
        assert_eq!(
            parse_plan_response(PlanProvider::Zhipu, 200, &body, NOW),
            PlanOutcome::PlanExpired
        );
    }

    // ---------------- MiniMax（unverified） ----------------
    // 形态出处：magpie `planquota.go` 第 177–192 行的注释（readMiniMaxPlan，含 base_resp 与 status 1/2/3）；
    // cc-switch `coding_plan.rs` 第 679–752 行（只取 general）

    fn minimax_fixture() -> Value {
        json!({"model_remains": [
            {"model_name": "general",
             "start_time": 1758780000000_i64, "end_time": 1758798000000_i64,
             "current_interval_remaining_percent": 88, "current_interval_status": 1,
             "current_interval_total_count": 0,
             "weekly_start_time": 1758240000000_i64, "weekly_end_time": 1758844800000_i64,
             "current_weekly_remaining_percent": 60.5, "current_weekly_status": 1,
             "current_weekly_total_count": 0},
            {"model_name": "video",
             "current_interval_remaining_percent": 0, "current_interval_status": 2,
             "current_weekly_remaining_percent": 0, "current_weekly_status": 2}
        ], "base_resp": {"status_code": 0, "status_msg": "success"}})
    }

    #[test]
    fn minimax_normal_converts_remaining_to_used_unverified() {
        let w = windows(parse_plan_response(
            PlanProvider::MiniMax,
            200,
            &minimax_fixture(),
            NOW,
        ));
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].window.kind, WindowKind::Session);
        assert_eq!(w[0].window.window_minutes, Some(300));
        assert_eq!(w[0].window.used_percent, 12.0);
        assert_eq!(w[0].window.resets_at, Some(1_758_798_000));
        assert_eq!(w[1].window.kind, WindowKind::Weekly);
        assert_eq!(w[1].window.window_minutes, Some(10080));
        assert_eq!(w[1].window.used_percent, 39.5);
        assert_eq!(w[1].window.resets_at, Some(1_758_844_800));
    }

    #[test]
    fn minimax_exhausted_and_unlimited_unverified() {
        // status 2 = 用尽（不管百分比），status 3 = 不限（不出窗口）
        let body = json!({"model_remains": [{"model_name": "general",
            "current_interval_remaining_percent": 30, "current_interval_status": 2,
            "current_weekly_remaining_percent": 100, "current_weekly_status": 3}],
            "base_resp": {"status_code": 0}});
        let w = windows(parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW));
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].window.used_percent, 100.0);
        assert_eq!(w[0].window.window_minutes, Some(300));
        assert_eq!(w[0].window.resets_at, None);
    }

    #[test]
    fn minimax_string_numbers_and_seconds_unverified() {
        let body = json!({"model_remains": [{"model_name": "general",
            "start_time": "1758780000", "end_time": "1758798000",
            "current_interval_remaining_percent": "75", "current_interval_status": "1"}],
            "base_resp": {"status_code": "0"}});
        // base_resp.status_code 写成字符串时同样认
        let w = windows(parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW));
        assert_eq!(w[0].window.used_percent, 25.0);
        assert_eq!(w[0].window.resets_at, Some(1_758_798_000));
        assert_eq!(w[0].window.window_minutes, Some(300));
    }

    #[test]
    fn minimax_200_with_base_resp_error_unverified() {
        // 被拒的密钥也回 HTTP 200，错误在 base_resp 里（magpie 第 189–191 行注释）
        for (code, msg) in [(1004, "login fail"), (2049, "invalid api key")] {
            let body = json!({"base_resp": {"status_code": code, "status_msg": msg}});
            assert_eq!(
                parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW),
                PlanOutcome::KeyRejected,
                "{code}"
            );
        }
        let body = json!({"base_resp": {"status_code": 1002, "status_msg": "rate limit"}});
        match parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW) {
            PlanOutcome::ParseFailed { reason } => assert!(reason.contains("1002")),
            other => panic!("{other:?}"),
        }
        let body = json!({"base_resp": {"status_code": 1008, "status_msg": "plan expired"}});
        assert_eq!(
            parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW),
            PlanOutcome::PlanExpired
        );
    }

    #[test]
    fn minimax_no_plan_and_missing_fields_unverified() {
        // 按量 Key 没有 general 窗口：无套餐额度
        let body = json!({"model_remains": [], "base_resp": {"status_code": 0}});
        assert_eq!(
            parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW),
            PlanOutcome::NoPlanQuota
        );
        // general 的两个窗口都不限
        let body = json!({"model_remains": [{"model_name": "general",
            "current_interval_status": 3, "current_weekly_status": 3}],
            "base_resp": {"status_code": 0}});
        assert_eq!(
            parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW),
            PlanOutcome::NoPlanQuota
        );
        // 缺 base_resp
        assert!(matches!(
            parse_plan_response(
                PlanProvider::MiniMax,
                200,
                &json!({"model_remains": []}),
                NOW
            ),
            PlanOutcome::ParseFailed { .. }
        ));
        // 缺 model_remains
        assert!(matches!(
            parse_plan_response(
                PlanProvider::MiniMax,
                200,
                &json!({"base_resp": {"status_code": 0}}),
                NOW
            ),
            PlanOutcome::ParseFailed { .. }
        ));
        // general 缺百分比
        let body = json!({"model_remains": [{"model_name": "general",
            "current_interval_status": 1}], "base_resp": {"status_code": 0}});
        assert!(matches!(
            parse_plan_response(PlanProvider::MiniMax, 200, &body, NOW),
            PlanOutcome::ParseFailed { .. }
        ));
    }

    #[test]
    fn minimax_http_401_unverified() {
        assert_eq!(
            parse_plan_response(PlanProvider::MiniMax, 401, &Value::Null, NOW),
            PlanOutcome::KeyRejected
        );
    }
}

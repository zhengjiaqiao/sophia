//! 三种来源的解析与窗口归一（R4）：`get_usage` 控制请求回复、`codex app-server` 结果、Codex 会话记录的一行。
//! 只认带语义的字段，认不得的一律忽略；样本见 `testdata/`。由 T1 实现。
//!
//! 三个入口：
//! - [`parse_get_usage`]：Claude Code 的 `control_response` 整行。
//! - [`parse_app_server`]：`codex app-server` 的整条 JSON-RPC 回复（`id` + `result`/`error`）。
//! - [`parse_rollout_line`]：会话记录里的一行（`rollout-*.jsonl`），只有 `token_count` 且带
//!   `rate_limits` 的行才归一成 [`Reading`]，其余（半行、别的事件类型）返回 `None`，不当错误处理。

use super::model::{AgentId, ParseFailure, Reading, Severity, Source, Window, WindowKind};
use serde_json::Value;

// ---------------- 轻重程度 ----------------

/// Codex 没有服务端 `severity` 时的门槛（设计第 3 节「轻重程度」）：已用 ≥ 90% 算 warning。
/// 这个阈值是先定的，实测后可能调整（spec 待决问题）。
pub const FALLBACK_WARNING_THRESHOLD: f64 = 90.0;

/// 用尽（100%）算 critical：spec 本身只定义了 warning 门槛，critical 是本实现的延伸——
/// AC21「用尽后显示倒计时」需要一个比 warning 更重的状态，且和服务端 `severity` 之外
/// 「非 normal/warning 的值一律算 critical」的规则保持同一形状。
pub const FALLBACK_CRITICAL_THRESHOLD: f64 = 100.0;

/// 没有服务端 `severity` 字段时，按已用百分比给（见上面两个常量）
fn severity_from_percent(used_percent: f64) -> Severity {
    if used_percent >= FALLBACK_CRITICAL_THRESHOLD {
        Severity::Critical
    } else if used_percent >= FALLBACK_WARNING_THRESHOLD {
        Severity::Warning
    } else {
        Severity::Normal
    }
}

/// 服务端给的 `severity` 字符串：`normal` / `warning` 认得，别的（未来服务端新增的更重等级）
/// 一律当 critical——宁可显示得更醒目，也不要因为认不得新值而按 normal 处理
fn severity_from_server_field(s: &str) -> Severity {
    match s {
        "normal" => Severity::Normal,
        "warning" => Severity::Warning,
        _ => Severity::Critical,
    }
}

// ---------------- 命名（R4：键与显示名种类） ----------------

/// 按窗口时长生成键与显示名种类（设计第 3 节，AC8）。
///
/// 300 分钟固定叫「5 小时」、10080 分钟固定叫「本周」（键分别是 `session` / `weekly`）；
/// 其余时长：整除 1440（一天的分钟数）就叫「N 天」，否则四舍五入到最近的小时数叫「N 小时」——
/// 源头理论上给到分钟级精度，但对用户来说只需要大致时长，四舍五入足够
/// （例如 90 分钟 → 「2 小时」而不是「1.5 小时」）。其余情况的键统一是 `minutes:<N>`。
/// 名字本身不在这里生成（[`WindowKind::label`] 显示时按当前语言现算）。
pub fn duration_key_and_kind(minutes: u32) -> (String, WindowKind) {
    match minutes {
        300 => ("session".to_string(), WindowKind::Session),
        10080 => ("weekly".to_string(), WindowKind::Weekly),
        m => (format!("minutes:{m}"), WindowKind::Minutes { minutes: m }),
    }
}

/// 模型限定窗口的键与显示名种类：`get_usage` 的 `weekly_scoped`（`scope.model.display_name`）、
/// Codex 里 `limit_id` 不是 `codex` 的那些（名字取 `limit_name`，如 Spark）
pub fn model_scoped_key_and_kind(display_name: &str) -> (String, WindowKind) {
    (
        format!("model:{display_name}"),
        WindowKind::Model {
            name: display_name.to_string(),
        },
    )
}

// ---------------- 自实现的 RFC3339 解析（不引入新依赖） ----------------

/// 把 RFC3339 时刻字符串换算成 Unix 秒。支持小数秒（截断，不四舍五入）和 `Z` / `±HH:MM` 偏移。
/// 格式对不上就返回 `None`（调用方把它当「这个字段没给」处理，不当错误）。
fn parse_rfc3339(s: &str) -> Option<i64> {
    let s = s.trim();
    let t_pos = s.find(['T', 't'])?;
    let date = &s[..t_pos];
    let rest = &s[t_pos + 1..];

    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() {
        return None;
    }

    // 时区偏移：结尾是 Z/z 就是 UTC；否则在 HH:MM:SS（固定 8 个字符，跳过它和小数部分）
    // 之后找 +/-。偏移量按「东偏为正」记，最后从本地时间里减掉换成 UTC。
    let (time_and_frac, offset_east_minutes): (&str, i64) =
        if let Some(stripped) = rest.strip_suffix(['Z', 'z']) {
            (stripped, 0)
        } else {
            if rest.len() < 8 {
                return None;
            }
            let sign_pos = rest[8..].find(['+', '-']).map(|p| p + 8)?;
            let sign = rest.as_bytes()[sign_pos];
            let offset_str = &rest[sign_pos + 1..];
            let mut offset_parts = offset_str.split(':');
            let oh: i64 = offset_parts.next()?.parse().ok()?;
            let om: i64 = offset_parts.next().unwrap_or("0").parse().ok()?;
            let magnitude = oh * 60 + om;
            let signed = if sign == b'-' { -magnitude } else { magnitude };
            (&rest[..sign_pos], signed)
        };

    let mut hms_and_frac = time_and_frac.splitn(2, '.');
    let hms = hms_and_frac.next()?;
    let mut hms_parts = hms.split(':');
    let hour: i64 = hms_parts.next()?.parse().ok()?;
    let minute: i64 = hms_parts.next()?.parse().ok()?;
    let second: i64 = hms_parts.next()?.parse().ok()?;
    if hms_parts.next().is_some() {
        return None;
    }

    let days = days_from_civil(year, month, day)?;
    let local_seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    Some(local_seconds - offset_east_minutes * 60)
}

/// 公历日期 → 自 1970-01-01 起的天数（Howard Hinnant 的通用算法，正确处理格里高利历闰年）
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // [0, 11]：3 月为 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146097 + doe - 719468)
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn f64_field(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn resets_at_rfc3339(v: &Value, key: &str) -> Option<i64> {
    str_field(v, key).and_then(parse_rfc3339)
}

// ---------------- get_usage（Claude Code） ----------------

/// 解析 Claude Code 程序化模式 `get_usage` 控制请求的整行回复（`msg` = 整个
/// `{"type":"control_response","response":{...}}` 对象）。
///
/// - `response.subtype == "error"` → 按 `error` 的文字分类，见 [`classify_get_usage_error`]。
/// - `rate_limits_available == false` → [`ParseFailure::NoPlanLimits`]（R5）。
/// - `rate_limits_available == true` 但 `rate_limits` 缺失/为 `null` → [`ParseFailure::RateLimited`]
///   （不带截止时刻）：实测是用量接口被限流时的样子。
/// - `rate_limits.limits[]` 存在就优先用它；缺失时退回 `five_hour` / `seven_day` 的
///   `utilization` + `resets_at`，外加 `model_scoped[]`（模型限定的周窗口，如 Fable）。
pub fn parse_get_usage(msg: &Value, fetched_at: i64) -> Result<Reading, ParseFailure> {
    let response = msg
        .get("response")
        .ok_or_else(|| ParseFailure::Malformed("get_usage 回复缺少 response".to_string()))?; // i18n-exempt: 诊断信息，界面只显示 reason()

    if str_field(response, "subtype") == Some("error") {
        return Err(classify_get_usage_error(response));
    }

    let inner = response.get("response").ok_or_else(|| {
        let why = "get_usage 回复缺少 response.response"; // i18n-exempt: 诊断信息，界面只显示 reason()
        ParseFailure::Malformed(why.to_string())
    })?;

    // 只有明确的 false 才算没有订阅额度（之后不再重试）；字段缺失或类型不对是「认不出来」，
    // 保留上一次读数、按失败处理——这是实验性接口，改名不能让它永久停取
    match inner.get("rate_limits_available").and_then(Value::as_bool) {
        Some(false) => return Err(ParseFailure::NoPlanLimits),
        Some(true) => {}
        None => {
            return Err(ParseFailure::Malformed(
                "get_usage 回复缺少 rate_limits_available".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
            ));
        }
    }

    // 有额度但这次没带回来：用量接口被限流时就是这样（实测），按限流退避、保留上次读数
    let rate_limits = match inner.get("rate_limits") {
        Some(v) if !v.is_null() => v,
        _ => return Err(ParseFailure::RateLimited { until: None }),
    };

    let plan = str_field(inner, "subscription_type").map(str::to_string);

    let mut windows = Vec::new();
    match rate_limits.get("limits").filter(|v| !v.is_null()) {
        Some(Value::Array(limits)) => {
            for item in limits {
                if let Some(w) = window_from_get_usage_limit(item) {
                    windows.push(w);
                }
            }
        }
        _ => {
            if let Some(w) = window_from_utilization(
                rate_limits.get("five_hour"),
                "session",
                WindowKind::Session,
            ) {
                windows.push(w);
            }
            if let Some(w) =
                window_from_utilization(rate_limits.get("seven_day"), "weekly", WindowKind::Weekly)
            {
                windows.push(w);
            }
            if let Some(Value::Array(scoped)) = rate_limits.get("model_scoped") {
                for item in scoped {
                    if let Some(name) = str_field(item, "display_name") {
                        if let Some(w) = window_from_model_scoped_utilization(item, name) {
                            windows.push(w);
                        }
                    }
                }
            }
        }
    }

    if windows.is_empty() {
        return Err(ParseFailure::Malformed(
            "get_usage 回复里没有认得的窗口字段".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
        ));
    }

    Ok(Reading {
        agent: AgentId::ClaudeCode,
        source: Source::GetUsage,
        observed_at: fetched_at,
        windows,
        plan,
    })
}

/// `get_usage` 回了 `subtype: "error"`：按 `response.error`（字符串，SDK 的 `ControlErrorResponse`）分类。
/// 没有公开的错误码，只能按文字认，认不出的一律 [`ParseFailure::Malformed`]：
/// - 程序不认这个请求 → [`ParseFailure::Unsupported`]。没有 `get_usage` 的旧版 Claude Code 对认不得的
///   控制请求回 `Unsupported control request subtype: get_usage`（取自程序化模式的源码，未在真机上复现）；
/// - 要重新登录（凭据过期、未授权、让人跑 `/login`）→ [`ParseFailure::AuthRequired`]。这几种说法是推测，
///   没有真实样本；宁可窄一点，认不出就按「认不出来」报
fn classify_get_usage_error(response: &Value) -> ParseFailure {
    let error = str_field(response, "error").unwrap_or("");
    let lower = error.to_lowercase();
    // 「unknown」单独出现太宽（「Unknown error」），要么连着「request subtype」，要么点名 get_usage
    let unsupported = lower.contains("request subtype")
        || (["unsupported", "not supported"]
            .iter()
            .any(|kw| lower.contains(kw))
            && lower.contains("get_usage"));
    if unsupported {
        return ParseFailure::Unsupported;
    }
    let auth = [
        "/login",
        "not logged in",
        "log in",
        "login",
        "unauthorized",
        "401",
        "authentication",
        "oauth token",
        "token has expired",
        "token expired",
    ]
    .iter()
    .any(|kw| lower.contains(kw));
    if auth {
        return ParseFailure::AuthRequired;
    }
    ParseFailure::Malformed(format!("get_usage 控制请求回复了 error：{error}")) // i18n-exempt: 诊断信息，界面只显示 reason()
}

/// `rate_limits.limits[]` 里的一项：`kind`、`percent`、`resets_at`、`severity`、`is_active`、
/// `scope.model.display_name`（仅 `weekly_scoped` 有）。认不得的 `kind` 忽略这一项，不报错。
fn window_from_get_usage_limit(item: &Value) -> Option<Window> {
    let kind = str_field(item, "kind")?;
    let used_percent = f64_field(item, "percent")?;
    let (key, name) = match kind {
        "session" => ("session".to_string(), WindowKind::Session),
        "weekly_all" => ("weekly".to_string(), WindowKind::Weekly),
        "weekly_scoped" => {
            let name = item
                .get("scope")?
                .get("model")?
                .get("display_name")?
                .as_str()?;
            model_scoped_key_and_kind(name)
        }
        _ => return None,
    };
    let severity = match str_field(item, "severity") {
        Some(s) => severity_from_server_field(s),
        None => severity_from_percent(used_percent),
    };
    let active = item
        .get("is_active")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(Window {
        key,
        kind: name,
        used_percent,
        resets_at: resets_at_rfc3339(item, "resets_at"),
        window_minutes: None,
        severity,
        active,
    })
}

/// 退回路径里 `five_hour` / `seven_day` 的一项：`utilization`（0–100）+ `resets_at`，
/// 没有 `severity` 也没有 `is_active`
fn window_from_utilization(item: Option<&Value>, key: &str, kind: WindowKind) -> Option<Window> {
    let item = item.filter(|v| !v.is_null())?;
    let used_percent = f64_field(item, "utilization")?;
    Some(Window {
        key: key.to_string(),
        kind,
        used_percent,
        resets_at: resets_at_rfc3339(item, "resets_at"),
        window_minutes: None,
        severity: severity_from_percent(used_percent),
        active: false,
    })
}

/// 退回路径里 `model_scoped[]` 的一项：同上，键名按模型显示名生成
fn window_from_model_scoped_utilization(item: &Value, display_name: &str) -> Option<Window> {
    let used_percent = f64_field(item, "utilization")?;
    let (key, kind) = model_scoped_key_and_kind(display_name);
    Some(Window {
        key,
        kind,
        used_percent,
        resets_at: resets_at_rfc3339(item, "resets_at"),
        window_minutes: None,
        severity: severity_from_percent(used_percent),
        active: false,
    })
}

// ---------------- Codex：app-server 与会话记录共用的窗口构造 ----------------

/// Codex 一个窗口槛位（`primary` / `secondary`）算键和名字种类：`limit_id` 不是 `codex` 的，
/// 名字按 `limit_name` 生成模型限定窗口；否则按窗口时长生成（AC8）
fn codex_window_key_and_kind(
    limit_id: &str,
    limit_name: Option<&str>,
    window_minutes: Option<u32>,
) -> Option<(String, WindowKind)> {
    if limit_id != "codex" {
        let name = limit_name.unwrap_or(limit_id);
        // 本周（或没给时长）是 `model:<名>`「本周 · <名>」；别的时长带上时长，两个窗口不重名
        return Some(match window_minutes {
            None | Some(10080) => model_scoped_key_and_kind(name),
            Some(m) => (
                format!("model:{name}:{m}"),
                WindowKind::ModelDuration {
                    name: name.to_string(),
                    minutes: m,
                },
            ),
        });
    }
    window_minutes.map(duration_key_and_kind)
}

// ---------------- app-server（Codex，camelCase） ----------------

/// 解析 `codex app-server` 的 `account/rateLimits/read` 整条 JSON-RPC 回复
/// （`msg` = 带 `id` 和 `result`/`error` 的整个对象）。
///
/// JSON-RPC 的 `error` 没有为这个私有接口定义语义化的错误码（未公开文档），只能按 `message`
/// 文字猜：含 auth / unauthorized / login / token 之类的算需要重新登录；含 rate limit /
/// too many requests / 429 算限流；其余一律 [`ParseFailure::Malformed`]。
pub fn parse_app_server(msg: &Value, fetched_at: i64) -> Result<Reading, ParseFailure> {
    if let Some(err) = msg.get("error") {
        return Err(classify_json_rpc_error(err));
    }

    let result = msg
        .get("result")
        .ok_or_else(|| ParseFailure::Malformed("app-server 回复缺少 result".to_string()))?; // i18n-exempt: 诊断信息，界面只显示 reason()

    let by_limit_id = match result.get("rateLimitsByLimitId") {
        Some(Value::Object(map)) => map,
        _ => {
            return Err(ParseFailure::Malformed(
                "app-server 回复缺少 rateLimitsByLimitId".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
            ));
        }
    };
    if by_limit_id.is_empty() {
        return Err(ParseFailure::NoPlanLimits);
    }

    let mut windows = Vec::new();
    let mut plan = None;
    for (limit_id, entry) in by_limit_id {
        let limit_name = str_field(entry, "limitName");
        if plan.is_none() {
            plan = str_field(entry, "planType").map(str::to_string);
        }
        if let Some(w) = window_from_codex_slot(
            entry.get("primary"),
            limit_id,
            limit_name,
            "usedPercent",
            "windowDurationMins",
            "resetsAt",
        ) {
            windows.push(w);
        }
        if let Some(w) = window_from_codex_slot(
            entry.get("secondary"),
            limit_id,
            limit_name,
            "usedPercent",
            "windowDurationMins",
            "resetsAt",
        ) {
            windows.push(w);
        }
    }

    if windows.is_empty() {
        return Err(ParseFailure::Malformed(
            "app-server 回复里没有认得的窗口字段".to_string(), // i18n-exempt: 诊断信息，界面只显示 reason()
        ));
    }

    Ok(Reading {
        agent: AgentId::Codex,
        source: Source::AppServer,
        observed_at: fetched_at,
        windows,
        plan,
    })
}

/// JSON-RPC `error` 分类的启发式：见 [`parse_app_server`] 的文档注释
fn classify_json_rpc_error(err: &Value) -> ParseFailure {
    let code = err.get("code").and_then(Value::as_i64);
    let message = str_field(err, "message").unwrap_or("").to_lowercase();

    // 限流先判：「token rate limit」这类说法里带 token，不能被当成要重新登录
    let looks_like_rate_limited = code == Some(429)
        || ["rate limit", "too many requests", "429"]
            .iter()
            .any(|kw| message.contains(kw));
    if looks_like_rate_limited {
        return ParseFailure::RateLimited { until: None };
    }

    let looks_like_auth = ["auth", "unauthorized", "401", "log in", "login", "token"]
        .iter()
        .any(|kw| message.contains(kw));
    if looks_like_auth {
        return ParseFailure::AuthRequired;
    }

    ParseFailure::Malformed(format!("app-server 返回错误：{message}")) // i18n-exempt: 诊断信息，界面只显示 reason()
}

// ---------------- 会话记录（Codex，snake_case，Unix 秒） ----------------

/// 解析会话记录（`rollout-*.jsonl`）里的一行原文。只有 `type == "event_msg"` 且
/// `payload.type == "token_count"` 且 `payload.rate_limits` 非空的行才归一成 [`Reading`]；
/// 其余（半行写坏的 JSON、别的事件类型、`rate_limits` 是 `null`）一律返回 `None`，不当错误——
/// 调用方（`rollout::read_last_rate_limits_line`）已经只把「看起来带额度」的行原文交过来，
/// 这里是双重确认，别的事件类型混进来时安静跳过。
pub fn parse_rollout_line(line: &str) -> Option<Reading> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let msg: Value = serde_json::from_str(line).ok()?;

    let payload = msg.get("payload")?;
    if str_field(payload, "type") != Some("token_count") {
        return None;
    }

    let timestamp = str_field(&msg, "timestamp")?;
    let observed_at = parse_rfc3339(timestamp)?;

    let rate_limits = match payload.get("rate_limits") {
        Some(v) if !v.is_null() => v,
        _ => return None,
    };

    let limit_id = str_field(rate_limits, "limit_id").unwrap_or("codex");
    // 会话记录只带当次会话所用额度的窗口；模型限定额度（Spark 等）不当成 Codex 的读数，
    // 免得替换掉主额度的窗口——它们由 app-server 取
    if limit_id != "codex" {
        return None;
    }
    let limit_name = str_field(rate_limits, "limit_name");
    let plan = str_field(rate_limits, "plan_type").map(str::to_string);

    let mut windows = Vec::new();
    if let Some(w) = window_from_codex_slot(
        rate_limits.get("primary"),
        limit_id,
        limit_name,
        "used_percent",
        "window_minutes",
        "resets_at",
    ) {
        windows.push(w);
    }
    if let Some(w) = window_from_codex_slot(
        rate_limits.get("secondary"),
        limit_id,
        limit_name,
        "used_percent",
        "window_minutes",
        "resets_at",
    ) {
        windows.push(w);
    }

    if windows.is_empty() {
        return None;
    }

    Some(Reading {
        agent: AgentId::Codex,
        source: Source::Rollout,
        observed_at,
        windows,
        plan,
    })
}

/// Codex 一个窗口槛位（`primary`/`secondary`）：字段名在 app-server（camelCase）和会话记录
/// （snake_case）之间不同，字段名通过参数传入，逻辑共用一份。`resets_at` 两边都是 Unix 秒整数，
/// 不用 RFC3339 解析。
fn window_from_codex_slot(
    slot: Option<&Value>,
    limit_id: &str,
    limit_name: Option<&str>,
    used_percent_key: &str,
    window_minutes_key: &str,
    resets_at_key: &str,
) -> Option<Window> {
    let slot = slot.filter(|v| !v.is_null())?;
    let used_percent = f64_field(slot, used_percent_key)?;
    let window_minutes = slot
        .get(window_minutes_key)
        .and_then(Value::as_u64)
        .map(|v| v as u32);
    let resets_at = slot.get(resets_at_key).and_then(Value::as_i64);
    let (key, kind) = codex_window_key_and_kind(limit_id, limit_name, window_minutes)?;
    Some(Window {
        key,
        kind,
        used_percent,
        resets_at,
        window_minutes,
        severity: severity_from_percent(used_percent),
        active: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::model::Severity;

    const GET_USAGE_WITH_LIMITS: &str = include_str!("testdata/get_usage_max_with_limits.json");
    const GET_USAGE_LIMITS_NULL: &str = include_str!("testdata/get_usage_max_limits_null.json");
    const APP_SERVER_PROLITE: &str = include_str!("testdata/app_server_prolite.json");
    const ROLLOUT_TOKEN_COUNT: &str = include_str!("testdata/rollout_token_count.jsonl");

    fn window<'a>(windows: &'a [Window], key: &str) -> &'a Window {
        windows
            .iter()
            .find(|w| w.key == key)
            .unwrap_or_else(|| panic!("没找到窗口 {key}，实际窗口：{windows:?}"))
    }

    // ---------------- RFC3339 解析 ----------------

    #[test]
    fn rfc3339_with_microseconds_and_utc_offset() {
        assert_eq!(
            parse_rfc3339("2026-09-26T13:19:59.715569+00:00"),
            Some(1790428799)
        );
    }

    #[test]
    fn rfc3339_without_fraction() {
        assert_eq!(parse_rfc3339("2026-11-05T07:59:00+00:00"), Some(1793865540));
    }

    #[test]
    fn rfc3339_with_z_suffix_and_milliseconds() {
        assert_eq!(parse_rfc3339("2026-09-25T17:02:55.988Z"), Some(1790355775));
    }

    #[test]
    fn rfc3339_with_positive_and_negative_offsets() {
        assert_eq!(parse_rfc3339("2026-01-01T00:00:00+05:00"), Some(1767207600));
        assert_eq!(parse_rfc3339("2026-01-01T00:00:00-05:00"), Some(1767243600));
    }

    #[test]
    fn rfc3339_malformed_returns_none() {
        assert_eq!(parse_rfc3339("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339("2026-09-26 13:19:59+00:00"), None);
    }

    // ---------------- 时长命名（AC8） ----------------

    /// 键与「现算出来的名字」，断言用（生产代码只传种类）
    fn duration_key_and_label(minutes: u32) -> (String, String) {
        let (key, kind) = duration_key_and_kind(minutes);
        (key, kind.label())
    }

    fn model_scoped_key_and_label(display_name: &str) -> (String, String) {
        let (key, kind) = model_scoped_key_and_kind(display_name);
        (key, kind.label())
    }

    #[test]
    fn ac8_duration_naming_300_is_session_five_hours() {
        assert_eq!(
            duration_key_and_label(300),
            ("session".to_string(), "5 小时".to_string())
        );
    }

    #[test]
    fn ac8_duration_naming_10080_is_weekly() {
        assert_eq!(
            duration_key_and_label(10080),
            ("weekly".to_string(), "本周".to_string())
        );
    }

    #[test]
    fn ac8_duration_naming_1440_is_one_day() {
        assert_eq!(
            duration_key_and_label(1440),
            ("minutes:1440".to_string(), "1 天".to_string())
        );
    }

    #[test]
    fn ac8_duration_naming_720_is_twelve_hours() {
        assert_eq!(
            duration_key_and_label(720),
            ("minutes:720".to_string(), "12 小时".to_string())
        );
    }

    #[test]
    fn model_scoped_naming() {
        assert_eq!(
            model_scoped_key_and_label("Fable"),
            ("model:Fable".to_string(), "本周 · Fable".to_string())
        );
    }

    // ---------------- get_usage：limits[] 存在（AC8、AC9） ----------------

    #[test]
    fn ac8_get_usage_with_limits_has_session_weekly_and_model_fable() {
        let msg: Value = serde_json::from_str(GET_USAGE_WITH_LIMITS).unwrap();
        let reading = parse_get_usage(&msg, 1_000).unwrap();
        assert_eq!(reading.agent, AgentId::ClaudeCode);
        assert_eq!(reading.source, Source::GetUsage);
        assert_eq!(reading.observed_at, 1_000);
        assert_eq!(reading.plan, Some("max".to_string()));
        assert_eq!(reading.windows.len(), 3, "{:?}", reading.windows);

        let session = window(&reading.windows, "session");
        assert_eq!(session.label(), "5 小时");
        assert_eq!(session.used_percent, 5.0);
        assert_eq!(session.severity, Severity::Normal);
        assert!(!session.active);

        // 本周：severity=warning、is_active=true（真实样本里就是这样，覆盖 AC24 用的场景）
        let weekly = window(&reading.windows, "weekly");
        assert_eq!(weekly.label(), "本周");
        assert_eq!(weekly.used_percent, 87.0);
        assert_eq!(weekly.severity, Severity::Warning);
        assert!(weekly.active);

        let fable = window(&reading.windows, "model:Fable");
        assert_eq!(fable.label(), "本周 · Fable");
        assert_eq!(fable.used_percent, 0.0);
        assert_eq!(fable.severity, Severity::Normal);
    }

    /// AC9：回复里混着一堆认不得的字段（`iguana_necktie`、`tangelo`……真实样本本来就有），
    /// 不影响解析出的窗口数量和内容
    #[test]
    fn ac9_unknown_fields_are_ignored() {
        let msg: Value = serde_json::from_str(GET_USAGE_WITH_LIMITS).unwrap();
        assert!(msg["response"]["response"]["rate_limits"]
            .get("iguana_necktie")
            .is_some());
        let reading = parse_get_usage(&msg, 1_000).unwrap();
        assert_eq!(reading.windows.len(), 3);
    }

    // ---------------- get_usage：limits[] 缺失，退回 five_hour/seven_day（AC2） ----------------

    #[test]
    fn ac2_get_usage_falls_back_to_five_hour_and_seven_day() {
        let msg: Value = serde_json::from_str(GET_USAGE_LIMITS_NULL).unwrap();
        assert!(msg["response"]["response"]["rate_limits"]
            .get("limits")
            .is_none());
        let reading = parse_get_usage(&msg, 2_000).unwrap();
        assert_eq!(reading.windows.len(), 3, "{:?}", reading.windows);

        let session = window(&reading.windows, "session");
        assert_eq!(session.label(), "5 小时");
        assert_eq!(session.used_percent, 7.0);
        // 退回字段没有 severity：按阈值算，7% 远低于 90%
        assert_eq!(session.severity, Severity::Normal);

        let weekly = window(&reading.windows, "weekly");
        assert_eq!(weekly.label(), "本周");
        assert_eq!(weekly.used_percent, 90.0);
        // 90% 达到 warning 门槛
        assert_eq!(weekly.severity, Severity::Warning);

        let fable = window(&reading.windows, "model:Fable");
        assert_eq!(fable.label(), "本周 · Fable");
        assert_eq!(fable.used_percent, 0.0);
    }

    // ---------------- get_usage：失败路径 ----------------

    fn get_usage_error(error: Value) -> Value {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "usage-1",
                "error": error
            }
        })
    }

    /// 认不出的 error 照旧算「认不出来」，诊断里带上原话
    #[test]
    fn subtype_error_is_malformed() {
        assert_eq!(
            parse_get_usage(&get_usage_error("boom".into()), 0),
            Err(ParseFailure::Malformed(
                "get_usage 控制请求回复了 error：boom".to_string()
            ))
        );
        // 没有 error 字段、不是字符串
        let msg = serde_json::json!({
            "type": "control_response",
            "response": {"subtype": "error", "request_id": "usage-1"}
        });
        assert!(matches!(
            parse_get_usage(&msg, 0),
            Err(ParseFailure::Malformed(_))
        ));
        assert!(matches!(
            parse_get_usage(&get_usage_error(serde_json::json!({"x": 1})), 0),
            Err(ParseFailure::Malformed(_))
        ));
        // 只说 unknown、没点名请求的，不当成旧版
        assert!(matches!(
            parse_get_usage(&get_usage_error("Unknown error".into()), 0),
            Err(ParseFailure::Malformed(_))
        ));
    }

    /// 没有 `get_usage` 的旧版 Claude Code：程序化模式对认不得的控制请求回
    /// `Unsupported control request subtype: <subtype>`（M17）
    #[test]
    fn subtype_error_unsupported_request_is_unsupported() {
        for error in [
            "Unsupported control request subtype: get_usage",
            "Unknown control request subtype: get_usage",
            "unsupported request: get_usage",
        ] {
            assert_eq!(
                parse_get_usage(&get_usage_error(error.into()), 0),
                Err(ParseFailure::Unsupported),
                "{error}"
            );
        }
    }

    /// 要重新登录的说法：凭据过期、未授权、让人跑 `/login`（M17）
    #[test]
    fn subtype_error_auth_is_auth_required() {
        for error in [
            "OAuth token has expired. Please obtain a new token or refresh your existing token.",
            "Invalid API key · Please run /login",
            "Not logged in",
            "401 Unauthorized",
            "authentication_error",
        ] {
            assert_eq!(
                parse_get_usage(&get_usage_error(error.into()), 0),
                Err(ParseFailure::AuthRequired),
                "{error}"
            );
        }
    }

    #[test]
    fn ac11_rate_limits_available_false_is_no_plan_limits() {
        let msg = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "usage-1",
                "response": {
                    "subscription_type": null,
                    "rate_limits_available": false,
                    "rate_limits": null
                }
            }
        });
        assert_eq!(parse_get_usage(&msg, 0), Err(ParseFailure::NoPlanLimits));
    }

    /// 独立验证 2026-09-29：接口是实验性的，字段改名、缺失时不能当成「没有订阅额度」（那会永不重试）；
    /// 只有明确的 `false` 才算
    #[test]
    fn missing_rate_limits_available_is_malformed_not_no_plan() {
        let msg = serde_json::json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": "usage-1", "response": {"subscription_type": "max"}}
        });
        assert!(matches!(
            parse_get_usage(&msg, 0),
            Err(ParseFailure::Malformed(_))
        ));
    }

    /// 实测（2026-09-27，Max 账号，同一天连续探测十余次之后）：`rate_limits_available: true`
    /// 而 `rate_limits: null`，同时 Claude Code 自己的用量缓存已 95 分钟没更新。
    /// 这是「这次取不到」（用量接口被限流），不是「没有订阅额度」：按限流退避，保留上次读数
    #[test]
    fn rate_limits_null_with_available_true_is_rate_limited() {
        let msg = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "usage-1",
                "response": {
                    "subscription_type": "max",
                    "rate_limits_available": true,
                    "rate_limits": null
                }
            }
        });
        assert_eq!(
            parse_get_usage(&msg, 0),
            Err(ParseFailure::RateLimited { until: None })
        );
    }

    // ---------------- app-server（AC8：只有本周、plan prolite） ----------------

    #[test]
    fn ac8_codex_weekly_only_label() {
        let msg: Value = serde_json::from_str(APP_SERVER_PROLITE).unwrap();
        let reading = parse_app_server(&msg, 3_000).unwrap();
        assert_eq!(reading.agent, AgentId::Codex);
        assert_eq!(reading.source, Source::AppServer);
        assert_eq!(reading.plan, Some("prolite".to_string()));
        // 只有 primary（10080 分钟 → 本周），没有 secondary，没有「5 小时」
        assert_eq!(reading.windows.len(), 1, "{:?}", reading.windows);
        let weekly = &reading.windows[0];
        assert_eq!(weekly.key, "weekly");
        assert_eq!(weekly.label(), "本周");
        assert_eq!(weekly.used_percent, 57.0);
        assert_eq!(weekly.resets_at, Some(1790578639));
        assert_eq!(weekly.window_minutes, Some(10080));
        assert_eq!(weekly.severity, Severity::Normal);
    }

    /// 认不得的字段（`accountId`、`rateLimitResetCredits`、`credits`……真实样本本来就有）不影响解析
    #[test]
    fn app_server_unknown_fields_are_ignored() {
        let msg: Value = serde_json::from_str(APP_SERVER_PROLITE).unwrap();
        assert!(msg["result"].get("accountId").is_some());
        let reading = parse_app_server(&msg, 0).unwrap();
        assert_eq!(reading.windows.len(), 1);
    }

    #[test]
    fn app_server_rate_limits_available_false_equivalent_is_no_plan_limits() {
        let msg = serde_json::json!({"id": 2, "result": {"rateLimitsByLimitId": {}}});
        assert_eq!(parse_app_server(&msg, 0), Err(ParseFailure::NoPlanLimits));
    }

    #[test]
    fn app_server_json_rpc_error_with_auth_wording_is_auth_required() {
        let msg = serde_json::json!({
            "id": 2,
            "error": {"code": -32000, "message": "Unauthorized: please log in again"}
        });
        assert_eq!(parse_app_server(&msg, 0), Err(ParseFailure::AuthRequired));
    }

    #[test]
    fn app_server_json_rpc_error_with_rate_limit_wording_is_rate_limited() {
        let msg = serde_json::json!({
            "id": 2,
            "error": {"code": -32000, "message": "Rate limit exceeded, try later"}
        });
        assert_eq!(
            parse_app_server(&msg, 0),
            Err(ParseFailure::RateLimited { until: None })
        );
    }

    #[test]
    fn app_server_json_rpc_error_generic_is_malformed() {
        let msg = serde_json::json!({
            "id": 2,
            "error": {"code": -32601, "message": "method not found"}
        });
        assert_eq!(
            parse_app_server(&msg, 0),
            Err(ParseFailure::Malformed(
                "app-server 返回错误：method not found".to_string()
            ))
        );
    }

    // ---------------- 会话记录一行 ----------------

    #[test]
    fn rollout_line_parses_codex_weekly_window() {
        let line = ROLLOUT_TOKEN_COUNT.lines().next().unwrap();
        let reading = parse_rollout_line(line).unwrap();
        assert_eq!(reading.agent, AgentId::Codex);
        assert_eq!(reading.source, Source::Rollout);
        // 这一行的 timestamp 是 2026-09-25T17:02:55.988Z
        assert_eq!(reading.observed_at, 1790355775);
        assert_eq!(reading.plan, Some("prolite".to_string()));
        assert_eq!(reading.windows.len(), 1);
        let weekly = &reading.windows[0];
        assert_eq!(weekly.key, "weekly");
        assert_eq!(weekly.label(), "本周");
        assert_eq!(weekly.used_percent, 57.0);
        assert_eq!(weekly.resets_at, Some(1790578639));
    }

    #[test]
    fn rollout_line_non_token_count_returns_none() {
        let line = r#"{"timestamp":"2026-09-25T17:02:55.988Z","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}"#;
        assert_eq!(parse_rollout_line(line), None);
    }

    #[test]
    fn rollout_line_truncated_half_line_returns_none() {
        let line = r#"{"timestamp":"2026-09-25T17:02:55.988Z","type":"event_msg","payload":{"type":"token_count","info":{"total_"#;
        assert_eq!(parse_rollout_line(line), None);
    }

    #[test]
    fn rollout_line_null_rate_limits_returns_none() {
        let line = r#"{"timestamp":"2026-09-25T17:02:55.988Z","type":"event_msg","payload":{"type":"token_count","rate_limits":null}}"#;
        assert_eq!(parse_rollout_line(line), None);
    }

    #[test]
    fn rollout_line_empty_returns_none() {
        assert_eq!(parse_rollout_line(""), None);
        assert_eq!(parse_rollout_line("   \n"), None);
    }

    /// Codex 模型限定额度（`limit_id` 不是 `codex`，如 Spark）的命名：名字取 `limit_name`；
    /// 本周窗口是 `model:Spark`「本周 · Spark」，别的时长带上时长，两个窗口不重名（2026-09-29 代码评审）
    #[test]
    fn codex_model_scoped_limit_windows_are_distinct() {
        let msg = serde_json::json!({"id": 2, "result": {"rateLimitsByLimitId": {"spark": {
            "limitId": "spark", "limitName": "Spark",
            "primary": {"usedPercent": 10, "windowDurationMins": 300, "resetsAt": 1790578639},
            "secondary": {"usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1790578639}
        }}}});
        let reading = parse_app_server(&msg, 0).unwrap();
        let keys: Vec<_> = reading
            .windows
            .iter()
            .map(|w| (w.key.clone(), w.label()))
            .collect();
        let keys: Vec<_> = keys.iter().map(|(k, l)| (k.as_str(), l.as_str())).collect();
        assert_eq!(
            keys,
            vec![
                ("model:Spark:300", "5 小时 · Spark"),
                ("model:Spark", "本周 · Spark")
            ]
        );
    }

    /// 会话记录只带当次会话所用额度的窗口：不是主额度（`codex`）的那种不当成 Codex 的读数，
    /// 免得把主额度的窗口整份替换掉（2026-09-29 代码评审）
    #[test]
    fn rollout_with_non_codex_limit_is_ignored() {
        let line = r#"{"timestamp":"2026-09-25T17:02:55.988Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"spark","limit_name":"Spark","primary":{"used_percent":42.0,"window_minutes":10080,"resets_at":1790578639},"secondary":null,"plan_type":"prolite"}}}"#;
        assert_eq!(parse_rollout_line(line), None);
    }

    /// 限流先于鉴权判断：「token rate limit」是限流，不是要重新登录
    #[test]
    fn app_server_token_rate_limit_is_rate_limited_not_auth() {
        let msg = serde_json::json!({"id": 2, "error": {"code": 429, "message": "Too many requests: token rate limit exceeded"}});
        assert_eq!(
            parse_app_server(&msg, 0),
            Err(ParseFailure::RateLimited { until: None })
        );
    }
}

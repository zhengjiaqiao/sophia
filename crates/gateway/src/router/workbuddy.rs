//! WorkBuddy 命名空间（spec #247「路由」、#266）。
//!
//! Sophia 往 `~/.workbuddy/models.json` 写的条目指向 `http://127.0.0.1:<port>/workbuddy/v1/chat/completions`，
//! `apiKey` 是路由令牌（与家 `claude` 共用一个）。WorkBuddy 讲 OpenAI Chat，请求原样转发，
//! 只换三样——鉴权换成那一家提供商的密钥、模型名换成上游的、地址换成上游的 `/chat/completions`。
//! 名单里标着讲 Responses 的提供商同时也有 Chat 接口，同样转到它的 `/chat/completions`。
//! 任何情况下都不进入 Codex 的分流与官方转发。
use super::parse::{load_routing_catalog, model_key, replace_request_model, top_level_model};
use super::{
    decode_zstd, describe, header_str, is_key_rejection, json_error, key_off_thread, key_rejected,
    log_safe, passthrough, path_is_safe, read_limited, rejection_detail, resolve_target,
    send_with_connect_retry, Agent, Body, KeyVerdict, LoggedEntry, Route, Router,
};
use bytes::Bytes;
use hyper::{Method, Response, StatusCode};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

/// 家 `workbuddy` 的路径前缀
pub const PREFIX: &str = "/workbuddy";
/// WorkBuddy 给自定义模型的 id 加的前缀（#249 真机日志）；请求里带着它也认
const CUSTOM_LOCAL: &str = "custom-local:";

/// 路径落在 WorkBuddy 命名空间（大小写不敏感）
pub(super) fn in_namespace(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower == PREFIX || lower.starts_with("/workbuddy/")
}

/// WorkBuddy 命名空间的一个请求。来源校验已在 `screen` 做过
pub(super) async fn handle(
    router: Arc<Router>,
    parts: hyper::http::request::Parts,
    raw_body: Bytes,
) -> Response<Body> {
    let started = Instant::now();
    let path = parts.uri.path().to_owned();
    let method = parts.method.clone();
    let reject = |model: &str, status: StatusCode, result: &str, message: &str| {
        router.log.write(
            started,
            Agent::WorkBuddy.as_str(),
            method.as_str(),
            &path,
            model,
            Route::WorkBuddy,
            status.as_u16(),
            result,
            "",
            None,
        );
        if status.is_server_error() {
            router.counters.upstream_error();
        }
        json_error(status, message)
    };

    let sub = path_is_safe(&path).then(|| path[PREFIX.len()..].to_ascii_lowercase());
    let endpoint = matches!(
        sub.as_deref(),
        Some("/v1/chat/completions" | "/chat/completions")
    );
    if method != Method::POST || !endpoint {
        return reject(
            "",
            StatusCode::NOT_FOUND,
            "not_found",
            "Sophia only serves POST /workbuddy/v1/chat/completions here",
        );
    }
    // 比对令牌可能要读密钥文件（且持锁）：放到阻塞线程池里做
    let accepted = {
        let router = Arc::clone(&router);
        let headers = parts.headers.clone();
        tokio::task::spawn_blocking(move || router.token.accepts(&headers))
            .await
            .unwrap_or(false)
    };
    if !accepted {
        return reject(
            "",
            StatusCode::UNAUTHORIZED,
            "auth_error",
            "the API key of this model does not match Sophia's; turn WorkBuddy's third-party models off and on again in Sophia",
        );
    }

    let encoding = header_str(&parts.headers, "content-encoding")
        .trim()
        .to_ascii_lowercase();
    if raw_body.len() > router.max_body_bytes {
        return reject(
            "",
            StatusCode::BAD_REQUEST,
            "request_error",
            "request body too large",
        );
    }
    let body: Bytes = match encoding.as_str() {
        "" | "identity" => raw_body,
        "zstd" => match decode_zstd(&raw_body, router.max_body_bytes) {
            Ok(decoded) => decoded.into(),
            Err(e) => {
                return reject(
                    "",
                    StatusCode::BAD_REQUEST,
                    "request_error",
                    &format!("decompress zstd request body: {e}"),
                )
            }
        },
        _ => {
            return reject(
                "",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "request_error",
                "unsupported Content-Encoding",
            )
        }
    };
    let model = match top_level_model(&body, true) {
        Ok(Some(model)) if !model.trim().is_empty() => model,
        Ok(_) => {
            return reject(
                "",
                StatusCode::BAD_REQUEST,
                "request_error",
                "the request names no model",
            )
        }
        Err(e) => {
            return reject(
                "",
                StatusCode::BAD_REQUEST,
                "request_error",
                &format!("cannot determine the model of this request: {e}"),
            )
        }
    };
    let trimmed = model.trim();
    let named = trimmed
        .get(..CUSTOM_LOCAL.len())
        .filter(|head| head.eq_ignore_ascii_case(CUSTOM_LOCAL))
        .map_or(trimmed, |_| &trimmed[CUSTOM_LOCAL.len()..]);

    let catalog = match router.workbuddy_routing_path.clone() {
        None => None,
        Some(file) => match tokio::task::spawn_blocking(move || {
            if file.exists() {
                load_routing_catalog(&file).map(Some)
            } else {
                Ok(None)
            }
        })
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
        {
            Ok(catalog) => catalog,
            Err(e) => {
                return reject(
                    &model,
                    StatusCode::SERVICE_UNAVAILABLE,
                    "catalog_error",
                    &format!("read WorkBuddy routing list: {e}"),
                )
            }
        },
    };
    let Some(catalog) = catalog else {
        return reject(
            &model,
            StatusCode::NOT_FOUND,
            "no_catalog",
            "WorkBuddy's third-party models are turned off in Sophia",
        );
    };
    let Some(target) = catalog.active.get(&model_key(named)).cloned() else {
        return reject(
            &model,
            StatusCode::NOT_FOUND,
            "unknown_model",
            "this model is not picked for WorkBuddy in Sophia",
        );
    };
    let upstream = match router.upstream_for(&target, &catalog) {
        Ok(upstream) => upstream,
        Err(why) => return reject(&model, StatusCode::FORBIDDEN, "provider_error", &why),
    };
    let key = match key_off_thread(&router.third_party_key, Agent::WorkBuddy, &upstream.provider)
        .await
    {
        Ok(key) if !key.trim().is_empty() => key,
        failed => {
            return reject(
                &model,
                StatusCode::FORBIDDEN,
                "key_error",
                &format!(
                    "Sophia could not get the API key for third-party gateway {:?} ({}); check this provider in Sophia",
                    log_safe(&upstream.provider),
                    failed.err().unwrap_or_default()
                ),
            )
        }
    };
    let upstream_model = if target.upstream_model.trim().is_empty() {
        named.to_owned()
    } else {
        target.upstream_model.trim().to_owned()
    };
    let body = if upstream_model != model {
        match replace_request_model(&body, &upstream_model) {
            Ok(body) => body,
            Err(e) => {
                return reject(
                    &model,
                    StatusCode::BAD_REQUEST,
                    "request_error",
                    &format!("prepare request for third party: {e}"),
                )
            }
        }
    } else {
        body.to_vec()
    };

    // 从空请求头开始：只带内容协商与客户端标识，绝不转发路由令牌
    let target_url = resolve_target(&upstream.url, "/chat/completions", "");
    let mut request = router.third_party.post(target_url.as_str());
    for name in ["accept", "content-type", "user-agent"] {
        for value in parts.headers.get_all(name) {
            request = request.header(name, value);
        }
    }
    let request = request
        .header("authorization", format!("Bearer {key}"))
        .body(body);
    let response = match send_with_connect_retry(request).await {
        Ok(response) => response,
        Err(e) => {
            return reject(
                &model,
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                &format!("upstream unreachable: {}", describe(&e)),
            )
        }
    };
    let status = response.status();
    if status.is_redirection() {
        return reject(
            &model,
            StatusCode::BAD_GATEWAY,
            "upstream_error",
            "third-party gateway answered with a redirect, which is not followed",
        );
    }
    let result = if status.is_success() {
        router.report_key(
            Agent::WorkBuddy,
            &upstream.provider,
            &key,
            KeyVerdict::Accepted,
        );
        router.counters.third_party.fetch_add(1, Ordering::Relaxed);
        passthrough(response, true)
    } else {
        // 网关常在错误信息里把收到的 Authorization 原样吐回来，不能转给本机客户端
        let error_body = read_limited(response, 1 << 20).await;
        if is_key_rejection(status) {
            let detail = rejection_detail("POST", &target_url, status, &error_body, &key);
            router.report_key(
                Agent::WorkBuddy,
                &upstream.provider,
                &key,
                KeyVerdict::Rejected { detail },
            );
            key_rejected(&upstream.provider, status, &error_body, &key)
        } else {
            let scrubbed = String::from_utf8_lossy(&error_body).replace(&key, "***");
            super::fixed_response(status, "application/json", scrubbed.into_bytes())
        }
    };
    let status = result.status();
    if status.is_server_error() {
        router.counters.upstream_error();
    }
    *router.counters.last.lock().unwrap() = (
        model.clone(),
        Route::WorkBuddy.name().to_owned(),
        status.as_u16(),
    );
    let logged = LoggedEntry {
        log: router.log.clone(),
        counters: router.counters.clone(),
        started,
        method: method.to_string(),
        path,
        model,
        route: Route::WorkBuddy,
        status: status.as_u16(),
        extra: String::new(),
    };
    result.map(|body| logged.wrap(body))
}

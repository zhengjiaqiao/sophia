//! 转换层的验收测试：黄金文件（P0 真实抓包喂进去、断言输出）与 spec 各条的表驱动用例。

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::*;
use crate::translate::SseEvent;

// ---------- 公共小工具 ----------

fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/claude-code")
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(data_dir().join(name)).unwrap_or_else(|err| panic!("读 {name}: {err}"))
}

fn sample_body(name: &str) -> Vec<u8> {
    let doc: Value = serde_json::from_slice(&read(name)).unwrap();
    serde_json::to_vec(&doc["body"]).unwrap()
}

fn chat_of(body: &[u8]) -> (UpstreamRequest, Value) {
    let converted = to_chat(body, "weibo/kimi-k2.5", &UpstreamOptions::default()).unwrap();
    let value = serde_json::from_slice(&converted.body).unwrap();
    (converted, value)
}

fn chat_json(request: Value) -> Value {
    chat_with(request, &UpstreamOptions::default())
}

fn chat_with(request: Value, options: &UpstreamOptions) -> Value {
    let converted = to_chat(&serde_json::to_vec(&request).unwrap(), "up/model", options).unwrap();
    serde_json::from_slice(&converted.body).unwrap()
}

/// 事件转成 `{"event","data"}`，并把随机的消息 id 与思考块签名换成占位，便于与黄金序列逐条比较。
fn normalize(events: &[SseEvent]) -> Vec<Value> {
    events
        .iter()
        .map(|event| {
            let mut data = event.data.clone();
            if let Some(id) = data.pointer_mut("/message/id") {
                assert!(id.as_str().unwrap().starts_with("msg_"), "消息 id：{id}");
                *id = json!("<msg-id>");
            }
            if let Some(signature) = data.pointer_mut("/delta/signature") {
                let text = signature.as_str().unwrap();
                let random = text
                    .strip_prefix(THINKING_SIGNATURE_PREFIX)
                    .unwrap_or_else(|| panic!("签名要带本工具的前缀：{text}"));
                assert!(
                    random.len() >= 16 && random.chars().all(|c| c.is_ascii_alphanumeric()),
                    "签名的随机部分：{text}"
                );
                *signature = json!("<signature>");
            }
            json!({ "event": event.name, "data": data })
        })
        .collect()
}

fn names(events: &[SseEvent]) -> Vec<String> {
    events.iter().map(|event| event.name.clone()).collect()
}

/// 以任意切法把上游字节喂进去，跑完整条流。
fn run_chat(
    upstream: &[u8],
    step: usize,
    model: &str,
    estimate: u64,
    tools: ToolNameMap,
) -> Vec<SseEvent> {
    let mut parser = ChatEvents::new();
    let mut emitter = AnthropicEmitter::new(model, estimate, tools);
    let mut out = emitter.start();
    for piece in upstream.chunks(step.max(1)) {
        for event in parser.feed_bytes(piece) {
            out.extend(emitter.on_event(event));
        }
    }
    for event in parser.finish() {
        out.extend(emitter.on_event(event));
    }
    out.extend(emitter.finish());
    out
}

fn sse(chunks: &[Value]) -> Vec<u8> {
    let mut text = String::new();
    for chunk in chunks {
        text.push_str(&format!("data: {chunk}\n\n"));
    }
    text.into_bytes()
}

fn sse_done(chunks: &[Value]) -> Vec<u8> {
    let mut bytes = sse(chunks);
    bytes.extend_from_slice(b"data: [DONE]\n\n");
    bytes
}

fn delta(delta: Value) -> Value {
    json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": null }] })
}

fn finish(reason: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": reason }] })
}

/// 检查 R21 的结构性约束：成对、连续、不乱序、以 message_delta + message_stop 收尾。
fn assert_well_formed(events: &[SseEvent]) {
    assert_eq!(events[0].name, "message_start");
    let mut open: Option<u64> = None;
    let mut next = 0;
    let mut tail = Vec::new();
    for event in &events[1..] {
        match event.name.as_str() {
            "content_block_start" => {
                assert!(open.is_none(), "同一时刻只开一个块");
                assert_eq!(event.data["index"], json!(next));
                open = Some(next);
                next += 1;
            }
            "content_block_delta" => assert_eq!(Some(event.data["index"].as_u64().unwrap()), open),
            "content_block_stop" => {
                assert_eq!(Some(event.data["index"].as_u64().unwrap()), open);
                open = None;
            }
            "message_delta" | "message_stop" => {
                assert!(open.is_none());
                tail.push(event.name.clone());
            }
            "ping" => {}
            other => panic!("意外事件 {other}"),
        }
    }
    assert_eq!(tail, ["message_delta", "message_stop"]);
}

// ---------- 请求方向：黄金文件（AC17 / AC18） ----------

#[test]
fn ac17_golden_requests_from_real_captures() {
    let cases = [
        (
            "cc-messages-sdk-tool-result.json",
            "golden/messages-sdk-tool-result.chat.json",
        ),
        (
            "cc-messages-interactive-tool-loop.json",
            "golden/messages-interactive-tool-loop.chat.json",
        ),
        (
            "cc-messages-interactive-first-turn.json",
            "golden/messages-interactive-first-turn.chat.json",
        ),
        ("cc-messages-title.json", "golden/messages-title.chat.json"),
        (
            "cc-messages-tool-search.json",
            "golden/messages-tool-search.chat.json",
        ),
    ];
    for (sample, golden) in cases {
        let golden: Value = serde_json::from_slice(&read(golden)).unwrap();
        let (converted, chat) = chat_of(&sample_body(sample));
        // 这些抓包都带 `output_config.effort: "high"`：要了思考（adaptive）的黄金文件里有 `reasoning_effort: "high"`
        // （2026-09-30 重录：网关转推理强度），没要思考的（起标题）没有
        let body: Value = serde_json::from_slice(&sample_body(sample)).unwrap();
        assert_eq!(
            converted.reasoning_effort_sent,
            body["thinking"].is_object(),
            "{sample}"
        );
        assert_eq!(chat, golden["chat"], "{sample} 与黄金文件不一致");
        assert_eq!(
            converted.input_estimate,
            golden["estimate"].as_u64().unwrap(),
            "{sample} 的估算"
        );
        assert!(converted.stream, "{sample}：客户端要流式");
    }
}

/// 中途 `role: system`：并入前一条 user（或新开一条 user），包成 system-reminder；上游只见到开头一条 system。
#[test]
fn mid_conversation_system_messages_are_kept_as_user_text() {
    let (_, chat) = chat_of(&sample_body("cc-messages-sdk-tool-result.json"));
    let messages = chat["messages"].as_array().unwrap();
    let roles: Vec<&str> = messages
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["system", "user", "assistant", "tool", "user"]);
    let first_user = messages[1]["content"].as_str().unwrap();
    assert!(first_user.contains("列出当前目录的 txt 文件"));
    assert!(first_user.contains("<system-reminder>\n# Environment"));
    assert_eq!(
        messages[4]["content"],
        json!("<system-reminder>\n<total_tokens>14999895 tokens left</total_tokens>\n</system-reminder>")
    );
}

/// R16：中途 system 的三种位置——数组开头并入顶层 system；前一条是 user 就并入它；
/// 否则并入后一条 user（排在 tool 消息之后、用户文本之前）；前后都没有 user 时单独成一条。
#[test]
fn mid_conversation_system_positions() {
    let chat = chat_json(json!({
        "model": "m", "max_tokens": 5,
        "system": "Top",
        "messages": [
            { "role": "system", "content": "lead" },
            { "role": "user", "content": "q1" },
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": {} }] },
            { "role": "system", "content": [{ "type": "text", "text": "between" }] },
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "r" },
                { "type": "text", "text": "q2" }
            ] },
            { "role": "assistant", "content": "a2" },
            { "role": "system", "content": "alone" },
            { "role": "assistant", "content": "a3" }
        ]
    }));
    let reminder = |text: &str| format!("<system-reminder>\n{text}\n</system-reminder>");
    assert_eq!(
        chat["messages"],
        json!([
            { "role": "system", "content": "Top\n\nlead" },
            { "role": "user", "content": "q1" },
            { "role": "assistant", "content": "", "tool_calls": [
                { "id": "t1", "type": "function", "function": { "name": "Read", "arguments": "{}" } }
            ] },
            { "role": "tool", "tool_call_id": "t1", "content": "r" },
            { "role": "user", "content": format!("{}\n\nq2", reminder("between")) },
            { "role": "assistant", "content": "a2" },
            { "role": "user", "content": reminder("alone") },
            { "role": "assistant", "content": "a3" }
        ])
    );
    // 没有顶层 system 时，开头的中途 system 自己成为顶层 system
    let chat = chat_json(json!({
        "model": "m", "max_tokens": 5,
        "messages": [{ "role": "system", "content": "lead" }, { "role": "user", "content": "q" }]
    }));
    assert_eq!(
        chat["messages"][0],
        json!({ "role": "system", "content": "lead" })
    );
}

/// R16：确定性——同一输入两次转换逐字节相同（上游前缀缓存要靠它）。
#[test]
fn conversion_is_deterministic() {
    for sample in ["cc-messages-sdk-tool-result.json", "cc-messages-title.json"] {
        let body = sample_body(sample);
        let first = to_chat(&body, "x", &UpstreamOptions::default())
            .unwrap()
            .body;
        let second = to_chat(&body, "x", &UpstreamOptions::default())
            .unwrap()
            .body;
        assert_eq!(first, second, "{sample}");
        let first = to_responses(&body, "x", &UpstreamOptions::default())
            .unwrap()
            .body;
        let second = to_responses(&body, "x", &UpstreamOptions::default())
            .unwrap()
            .body;
        assert_eq!(first, second, "{sample}");
    }
}

/// R18：Responses 的 max_output_tokens 至少 16（桌面应用的可用性探测发 max_tokens: 1）。
#[test]
fn responses_max_output_tokens_floor() {
    let probe =
        json!({ "model": "m", "max_tokens": 1, "messages": [{ "role": "user", "content": "hi" }] });
    let converted = to_responses(
        &serde_json::to_vec(&probe).unwrap(),
        "x",
        &UpstreamOptions::default(),
    )
    .unwrap();
    let body: Value = serde_json::from_slice(&converted.body).unwrap();
    assert_eq!(body["max_output_tokens"], json!(16));
    // Chat 不抬：Chat 上游没有这个下限
    assert_eq!(chat_json(probe)["max_tokens"], json!(1));
}

/// 所有真实抓包都能转，且出站体里没有 R17 要剥的东西。
#[test]
fn ac18_every_captured_request_is_stripped() {
    let samples = [
        "cc-messages-compact.json",
        "cc-messages-interactive-first-turn.json",
        "cc-messages-interactive-tool-loop.json",
        "cc-messages-sdk-first-turn.json",
        "cc-messages-sdk-tool-result.json",
        "cc-messages-subagent-explore.json",
        "cc-messages-title.json",
        "cc-messages-tool-search.json",
        "cc-messages-webfetch-summary.json",
        "cc-prefix-messages.json",
    ];
    for sample in samples {
        let (_, chat) = chat_of(&sample_body(sample));
        let text = chat.to_string();
        // 这些在请求里任何位置都不该出现
        for banned in [
            "context_management",
            "output_config",
            "safeguards",
            "cache_control",
            "defer_loading",
            "x-anthropic-billing-header",
            "DeferredToolPlaceholder",
        ] {
            assert!(!text.contains(banned), "{sample} 出站体里还有 {banned}");
        }
        // 这些字段名在工具的 input_schema 里可能是合法的属性名（如 metadata），只查顶层
        let top: Vec<&String> = chat.as_object().unwrap().keys().collect();
        for banned in ["thinking", "metadata", "top_k", "effort", "system"] {
            assert!(
                !top.iter().any(|key| *key == banned),
                "{sample} 顶层还有 {banned}"
            );
        }
        let messages = chat["messages"].as_array().unwrap();
        for (index, message) in messages.iter().enumerate() {
            let role = message["role"].as_str().unwrap();
            assert!(
                role != "system" || index == 0,
                "{sample}：system 只能在开头"
            );
            assert!(["system", "user", "assistant", "tool"].contains(&role));
        }
        assert_eq!(chat["stream"], json!(true));
        assert_eq!(chat["stream_options"], json!({ "include_usage": true }));
        assert_eq!(chat["model"], json!("weibo/kimi-k2.5"));
    }
}

#[test]
fn ac18_synthetic_request_strips_everything_listed() {
    let request = json!({
        "model": "m",
        "max_tokens": 1000,
        "top_k": 5,
        "temperature": 0.3,
        "top_p": 0.9,
        "stop_sequences": ["END"],
        "metadata": { "user_id": "u" },
        "thinking": { "type": "adaptive" },
        "context_management": { "edits": [] },
        "output_config": { "effort": "high" },
        "container": "c",
        "mcp_servers": [],
        "service_tier": "auto",
        "betas": ["x"],
        "safeguards": [{ "type": "dangerous_tool_use", "classifier_context": { "home_dir": "/Users/secret" } }],
        "system": [
            { "type": "text", "text": "x-anthropic-billing-header: cc_version=1; cc_entrypoint=cli;" },
            { "type": "text", "text": "Be brief.", "cache_control": { "type": "ephemeral" } }
        ],
        "tools": [
            { "name": "Read", "description": "read", "input_schema": { "type": "object" }, "strict": true,
              "cache_control": { "type": "ephemeral" }, "input_examples": [{}] },
            { "name": "Lazy", "description": "d", "input_schema": { "type": "object" }, "defer_loading": true },
            { "type": "web_search_20250305", "name": "web_search", "max_uses": 3 },
            { "type": "tool_search_tool_regex_20251119", "name": "tool_search" }
        ],
        "tool_choice": { "type": "tool", "name": "web_search" },
        "messages": [
            { "role": "user", "content": [{ "type": "text", "text": "hi", "cache_control": { "type": "ephemeral" } }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "hmm", "signature": "sig" },
                { "type": "redacted_thinking", "data": "xx" },
                { "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": { "query": "q" } },
                { "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [] },
                { "type": "text", "text": "found" },
                { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": { "file_path": "a" } }
            ] },
            { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": [
                    { "type": "text", "text": "file body" },
                    { "type": "tool_reference", "tool_name": "Lazy" }
                ] }
            ] }
        ]
    });
    let chat = chat_json(request);
    assert_eq!(
        chat,
        json!({
            "model": "up/model",
            "stream": true,
            "stream_options": { "include_usage": true },
            "tools": [{ "type": "function", "function": { "name": "Read", "description": "read", "parameters": { "type": "object" } } }],
            "tool_choice": "auto",
            "messages": [
                { "role": "system", "content": "Be brief." },
                { "role": "user", "content": "hi" },
                // 2026-10-05 起（reasoning-passback R3）：thinking 块的文字带回成 reasoning_content，
                // redacted_thinking 仍丢弃
                { "role": "assistant", "content": "found", "reasoning_content": "hmm", "tool_calls": [
                    { "id": "toolu_1", "type": "function", "function": { "name": "Read", "arguments": "{\"file_path\":\"a\"}" } }
                ] },
                { "role": "tool", "tool_call_id": "toolu_1", "content": "file body" }
            ],
            "max_tokens": 1000,
            "temperature": 0.3,
            "top_p": 0.9,
            "stop": ["END"],
            // output_config 本身照剥；要了思考（adaptive）时其中的 effort 折成 reasoning_effort 转给上游
            "reasoning_effort": "high"
        })
    );
}

// ---------- 思考内容带回（reasoning-passback R3） ----------

/// AC3：历史 assistant 的 thinking 块（不论签名是谁的）按顺序拼成 reasoning_content；
/// redacted_thinking 不进；没有 thinking 的 assistant 不加这个字段；只有 thinking 的 assistant 照旧丢弃。
#[test]
fn ac3_history_thinking_is_passed_back_as_reasoning_content() {
    let request = json!({
        "model": "m", "max_tokens": 100,
        "tools": [{ "name": "Read", "input_schema": { "type": "object" } }],
        "messages": [
            { "role": "user", "content": "看看 a" },
            { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "先读 a", "signature": "sophia-thinking-v1:abc" },
                { "type": "redacted_thinking", "data": "secret-blob" },
                { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": { "file_path": "a" } }
            ] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "内容" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "甲", "signature": "official-sig" },
                { "type": "text", "text": "读完了" },
                { "type": "thinking", "thinking": "乙", "signature": "x" }
            ] },
            { "role": "user", "content": "再说一遍" },
            { "role": "assistant", "content": [{ "type": "thinking", "thinking": "只有思考", "signature": "s" }] },
            { "role": "assistant", "content": "好" },
            { "role": "user", "content": "谢谢" }
        ]
    });
    let body = serde_json::to_vec(&request).unwrap();
    let converted = to_chat(&body, "up", &UpstreamOptions::default()).unwrap();
    assert!(converted.reasoning_content_sent);
    let chat: Value = serde_json::from_slice(&converted.body).unwrap();
    let messages = chat["messages"].as_array().unwrap();
    assert_eq!(
        messages[1]["reasoning_content"],
        json!("先读 a"),
        "{}",
        messages[1]
    );
    assert!(messages[1]["tool_calls"].is_array());
    assert_eq!(
        messages[3]["reasoning_content"],
        json!("甲\n\n乙"),
        "{}",
        messages[3]
    );
    assert_eq!(messages[5], json!({ "role": "assistant", "content": "好" }));
    assert_eq!(
        messages.len(),
        7,
        "只有思考的 assistant 不凭空造消息：{messages:?}"
    );
    let text = String::from_utf8_lossy(&converted.body);
    assert!(
        !text.contains("secret-blob") && !text.contains("只有思考"),
        "{text}"
    );

    // 重试用的开关：去掉全部 reasoning_content，与历史里没有 thinking 块时逐字节相同
    let omit = UpstreamOptions {
        omit_reasoning_content: true,
        ..Default::default()
    };
    let omitted = to_chat(&body, "up", &omit).unwrap();
    assert!(!omitted.reasoning_content_sent);
    let mut plain = request.clone();
    for message in plain["messages"].as_array_mut().unwrap() {
        if let Some(blocks) = message["content"].as_array_mut() {
            blocks.retain(|b| b["type"] != "thinking");
        }
    }
    let plain = to_chat(
        &serde_json::to_vec(&plain).unwrap(),
        "up",
        &UpstreamOptions::default(),
    )
    .unwrap();
    assert!(!plain.reasoning_content_sent);
    assert_eq!(omitted.body, plain.body);

    // 输入估算按实际发出的请求算：带回了思考才计入，去掉后、Responses 出口都不计
    assert_eq!(converted.input_estimate, estimate_tokens(&request));
    assert!(converted.input_estimate > plain.input_estimate);
    assert_eq!(omitted.input_estimate, plain.input_estimate);

    // Responses 出口（R20）照旧不带
    let responses = to_responses(&body, "up", &UpstreamOptions::default()).unwrap();
    assert!(!responses.reasoning_content_sent);
    assert_eq!(responses.input_estimate, plain.input_estimate);
    assert!(!String::from_utf8_lossy(&responses.body).contains("先读 a"));
}

// ---------- 请求方向：映射细节（R16） ----------

#[test]
fn ac17_images_and_tool_result_images() {
    let request = json!({
        "model": "m",
        "max_tokens": 10,
        "messages": [
            { "role": "user", "content": [
                { "type": "text", "text": "看图" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } },
                { "type": "image", "source": { "type": "url", "url": "https://example.com/a.jpg" } }
            ] },
            { "role": "assistant", "content": [
                { "type": "tool_use", "id": "toolu_a", "name": "Shot", "input": {} },
                { "type": "tool_use", "id": "toolu_b", "name": "Bash", "input": { "command": "false" } }
            ] },
            { "role": "user", "content": [
                { "type": "text", "text": "两个都跑完了" },
                { "type": "tool_result", "tool_use_id": "toolu_a", "content": [
                    { "type": "text", "text": "截图如下" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "BBBB" } }
                ] },
                { "type": "tool_result", "tool_use_id": "toolu_b", "content": "exit 1", "is_error": true }
            ] }
        ]
    });
    let chat = chat_json(request);
    assert_eq!(
        chat["messages"],
        json!([
            { "role": "user", "content": [
                { "type": "text", "text": "看图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                { "type": "image_url", "image_url": { "url": "https://example.com/a.jpg" } }
            ] },
            { "role": "assistant", "content": "", "tool_calls": [
                { "id": "toolu_a", "type": "function", "function": { "name": "Shot", "arguments": "{}" } },
                { "id": "toolu_b", "type": "function", "function": { "name": "Bash", "arguments": "{\"command\":\"false\"}" } }
            ] },
            { "role": "tool", "tool_call_id": "toolu_a", "content": "截图如下" },
            { "role": "tool", "tool_call_id": "toolu_b", "content": "Error: exit 1" },
            { "role": "user", "content": [
                { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,BBBB" } },
                { "type": "text", "text": "两个都跑完了" }
            ] }
        ])
    );
}

#[test]
fn tool_choice_and_parallel_mapping() {
    let base = |choice: Value| {
        json!({
            "model": "m", "max_tokens": 5,
            "tools": [{ "name": "Read", "input_schema": { "type": "object" } }],
            "tool_choice": choice,
            "messages": [{ "role": "user", "content": "hi" }]
        })
    };
    let cases = [
        (json!({ "type": "auto" }), json!("auto")),
        (json!({ "type": "any" }), json!("required")),
        (json!({ "type": "none" }), json!("none")),
        (
            json!({ "type": "tool", "name": "Read" }),
            json!({ "type": "function", "function": { "name": "Read" } }),
        ),
        (json!({ "type": "tool", "name": "Gone" }), json!("auto")),
    ];
    for (choice, expected) in cases {
        let chat = chat_json(base(choice.clone()));
        assert_eq!(chat["tool_choice"], expected, "{choice}");
        assert!(chat.get("parallel_tool_calls").is_none());
    }
    let chat = chat_json(base(
        json!({ "type": "auto", "disable_parallel_tool_use": true }),
    ));
    assert_eq!(chat["parallel_tool_calls"], json!(false));

    // 没有可用工具时 tool_choice 与 parallel_tool_calls 都不发（否则上游 400）
    let chat = chat_json(json!({
        "model": "m", "max_tokens": 5, "tools": [],
        "tool_choice": { "type": "any", "disable_parallel_tool_use": true },
        "messages": [{ "role": "user", "content": "hi" }]
    }));
    assert!(chat.get("tools").is_none() && chat.get("tool_choice").is_none());
    assert!(chat.get("parallel_tool_calls").is_none());
}

#[test]
fn r21_unmappable_blocks_become_placeholders() {
    let chat = chat_json(json!({
        "model": "m", "max_tokens": 5,
        "messages": [{ "role": "user", "content": [
            { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "JVBER" } },
            { "type": "search_result", "source": "https://s", "title": "T", "content": [
                { "type": "text", "text": "第一段" }, { "type": "text", "text": "第二段" }
            ] },
            { "type": "some_future_block", "x": 1 },
            { "type": "text", "text": "总结一下" }
        ] }]
    }));
    assert_eq!(
        chat["messages"],
        json!([{ "role": "user", "content": format!(
            "{ATTACHMENT_PLACEHOLDER}\n\n第一段\n\n第二段\n\n{ATTACHMENT_PLACEHOLDER}\n\n总结一下"
        ) }])
    );
}

#[test]
fn structured_output_prompt_only_and_thinking_off_knobs() {
    let title = sample_body("cc-messages-title.json");
    let options = UpstreamOptions {
        structured_output: StructuredOutput::PromptOnly,
        ..Default::default()
    };
    let chat: Value =
        serde_json::from_slice(&to_chat(&title, "x", &options).unwrap().body).unwrap();
    assert!(chat.get("response_format").is_none());
    assert!(chat["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("JSON Schema:\n{\"type\":\"object\""));

    // 请求明说不要思考 → 按上游能力显式关；没带 thinking（起标题的真实抓包）→ 什么都不加
    //（2026-09-30 产品负责人：不替客户端决定推理）
    let knob = |off: ThinkingOff, body: &[u8]| -> Value {
        let options = UpstreamOptions {
            thinking_off: off,
            ..Default::default()
        };
        serde_json::from_slice(&to_chat(body, "x", &options).unwrap().body).unwrap()
    };
    let untouched = knob(ThinkingOff::ReasoningDisabled, &title);
    assert!(untouched.get("reasoning").is_none() && untouched.get("thinking").is_none());
    let mut disabled: Value = serde_json::from_slice(&title).unwrap();
    disabled["thinking"] = json!({ "type": "disabled" });
    let title = serde_json::to_vec(&disabled).unwrap();
    let chat = knob(ThinkingOff::ReasoningDisabled, &title);
    assert_eq!(chat["reasoning"], json!({ "enabled": false }));
    // 路由据 thinking_off_sent 决定要不要因「推理不能关」重发：明说不要才算发了，Omit 不算
    let sent = |off: ThinkingOff, body: &[u8]| {
        let options = UpstreamOptions {
            thinking_off: off,
            ..Default::default()
        };
        to_chat(body, "x", &options).unwrap().thinking_off_sent
    };
    assert!(sent(ThinkingOff::ReasoningDisabled, &title));
    assert!(!sent(ThinkingOff::Omit, &title));
    assert!(!sent(
        ThinkingOff::ReasoningDisabled,
        &sample_body("cc-messages-title.json")
    ));
    let chat = knob(ThinkingOff::ThinkingDisabled, &title);
    assert_eq!(chat["thinking"], json!({ "type": "disabled" }));
    let chat = knob(ThinkingOff::ChatTemplateKwargs, &title);
    assert_eq!(
        chat["chat_template_kwargs"],
        json!({ "enable_thinking": false, "thinking": false })
    );
    let chat = knob(ThinkingOff::Omit, &title);
    assert!(chat.get("reasoning").is_none() && chat.get("thinking").is_none());

    // 主会话要了思考（adaptive）→ 什么都不加，让上游按默认想
    let main = sample_body("cc-messages-sdk-first-turn.json");
    let chat = knob(ThinkingOff::ReasoningDisabled, &main);
    assert!(chat.get("reasoning").is_none());
    // 明确 disabled 也算「没要」
    let disabled = serde_json::to_vec(&json!({
        "model": "m", "max_tokens": 5, "thinking": { "type": "disabled" },
        "messages": [{ "role": "user", "content": "hi" }]
    }))
    .unwrap();
    assert_eq!(
        knob(ThinkingOff::ReasoningDisabled, &disabled)["reasoning"],
        json!({ "enabled": false })
    );

    assert_eq!(
        ThinkingOff::detect("https://openrouter.ai/api/v1"),
        ThinkingOff::ReasoningDisabled
    );
    assert_eq!(
        ThinkingOff::detect("https://ap-gateway.example.com/v1"),
        ThinkingOff::Omit
    );
    assert_eq!(ThinkingOff::detect("not a url"), ThinkingOff::Omit);
}

// ---------- 推理强度 → reasoning_effort ----------

fn effort_request(thinking: Value, effort: Option<&str>) -> Value {
    let mut request = json!({
        "model": "m", "max_tokens": 5,
        "messages": [{ "role": "user", "content": "hi" }]
    });
    if !thinking.is_null() {
        request["thinking"] = thinking;
    }
    if let Some(effort) = effort {
        request["output_config"] = json!({ "effort": effort });
    }
    request
}

fn effort_of(request: &Value, options: &UpstreamOptions) -> (Option<String>, bool) {
    let converted = to_chat(&serde_json::to_vec(request).unwrap(), "up/model", options).unwrap();
    let chat: Value = serde_json::from_slice(&converted.body).unwrap();
    (
        chat.get("reasoning_effort")
            .and_then(Value::as_str)
            .map(str::to_owned),
        converted.reasoning_effort_sent,
    )
}

/// 要了思考（adaptive）：`output_config.effort` 折成三档；没带 effort 就什么都不加。
#[test]
fn adaptive_thinking_forwards_output_config_effort() {
    let adaptive = json!({ "type": "adaptive", "display": "omitted" });
    for (effort, want) in [
        (Some("low"), Some("low")),
        (Some("medium"), Some("medium")),
        (Some("high"), Some("high")),
        (Some("xhigh"), Some("high")),
        (Some("max"), Some("high")),
        (Some("turbo"), None),
        (None, None),
    ] {
        let (got, sent) = effort_of(
            &effort_request(adaptive.clone(), effort),
            &UpstreamOptions::default(),
        );
        assert_eq!(got.as_deref(), want, "effort = {effort:?}");
        assert_eq!(sent, want.is_some(), "effort = {effort:?}");
    }
    // 非字符串的 effort 读不懂，不加
    let mut request = effort_request(adaptive, None);
    request["output_config"] = json!({ "effort": 3 });
    assert_eq!(
        effort_of(&request, &UpstreamOptions::default()),
        (None, false)
    );
}

/// `thinking: {type: enabled, budget_tokens}`：没有 `output_config.effort` 时按预算分档。
#[test]
fn enabled_thinking_budget_maps_to_effort() {
    for (budget, want) in [
        (json!(1024), Some("low")),
        (json!(4095), Some("low")),
        (json!(4096), Some("medium")),
        (json!(16383), Some("medium")),
        (json!(16384), Some("high")),
        (json!(64000), Some("high")),
        (json!("lots"), None),
        (json!(-1), None),
    ] {
        let thinking = json!({ "type": "enabled", "budget_tokens": budget });
        let (got, _) = effort_of(&effort_request(thinking, None), &UpstreamOptions::default());
        assert_eq!(got.as_deref(), want, "budget = {budget}");
    }
    let (got, _) = effort_of(
        &effort_request(json!({ "type": "enabled" }), None),
        &UpstreamOptions::default(),
    );
    assert_eq!(got, None, "没有预算就不加");
}

/// `output_config.effort` 优先于预算；带了 effort 就不再看预算（读不懂的 effort 也不退回预算）。
#[test]
fn output_config_effort_wins_over_budget() {
    let thinking = json!({ "type": "enabled", "budget_tokens": 32000 });
    let (got, _) = effort_of(
        &effort_request(thinking.clone(), Some("low")),
        &UpstreamOptions::default(),
    );
    assert_eq!(got.as_deref(), Some("low"));
    let (got, _) = effort_of(
        &effort_request(thinking.clone(), Some("turbo")),
        &UpstreamOptions::default(),
    );
    assert_eq!(got, None);
    // effort 为 null 当没带：用预算
    let mut request = effort_request(thinking, None);
    request["output_config"] = json!({ "effort": null });
    let (got, _) = effort_of(&request, &UpstreamOptions::default());
    assert_eq!(got.as_deref(), Some("high"));
}

/// 没要思考（缺省或 disabled）：不加 reasoning_effort——出站体与请求里没有 effort 时逐字节相同；
/// 只有明说 disabled 才按 ThinkingOff 显式关，缺省什么都不加（2026-09-30 产品负责人）。
#[test]
fn no_thinking_means_no_effort_and_thinking_off_unchanged() {
    for off in [
        ThinkingOff::Omit,
        ThinkingOff::ThinkingDisabled,
        ThinkingOff::ReasoningDisabled,
        ThinkingOff::ChatTemplateKwargs,
    ] {
        let options = UpstreamOptions {
            thinking_off: off,
            ..Default::default()
        };
        for thinking in [Value::Null, json!({ "type": "disabled" })] {
            let with_effort = effort_request(thinking.clone(), Some("high"));
            let without = effort_request(thinking.clone(), None);
            let a = to_chat(&serde_json::to_vec(&with_effort).unwrap(), "x", &options).unwrap();
            let b = to_chat(&serde_json::to_vec(&without).unwrap(), "x", &options).unwrap();
            assert_eq!(a.body, b.body, "{off:?} {thinking}");
            assert!(!a.reasoning_effort_sent);
            assert!(!String::from_utf8_lossy(&a.body).contains("reasoning_effort"));
        }
    }
    // 起标题的真实抓包：带 effort high、没带 thinking → 既不发强度也不关推理
    let title = sample_body("cc-messages-title.json");
    let options = UpstreamOptions {
        thinking_off: ThinkingOff::ReasoningDisabled,
        ..Default::default()
    };
    let chat: Value =
        serde_json::from_slice(&to_chat(&title, "x", &options).unwrap().body).unwrap();
    assert!(chat.get("reasoning_effort").is_none());
    assert!(chat.get("reasoning").is_none());
}

/// 要了思考时不调 ThinkingOff；reasoning_effort 排在最后，同样输入逐字节相同。
#[test]
fn effort_position_is_fixed_and_thinking_off_is_not_applied() {
    let options = UpstreamOptions {
        thinking_off: ThinkingOff::ReasoningDisabled,
        ..Default::default()
    };
    let mut request = effort_request(json!({ "type": "adaptive" }), Some("medium"));
    request["temperature"] = json!(1);
    request["output_config"]["format"] =
        json!({ "type": "json_schema", "schema": { "type": "object" } });
    let body = serde_json::to_vec(&request).unwrap();
    let first = to_chat(&body, "x", &options).unwrap().body;
    let text = String::from_utf8(first.clone()).unwrap();
    assert!(text.ends_with(r#""reasoning_effort":"medium"}"#), "{text}");
    assert!(!text.contains(r#""reasoning":"#), "{text}");
    assert_eq!(first, to_chat(&body, "x", &options).unwrap().body);
}

/// 重试用的开关：去掉 reasoning_effort，其余与请求本来没带 effort 时逐字节相同。
#[test]
fn omit_reasoning_effort_option() {
    let omit = UpstreamOptions {
        omit_reasoning_effort: true,
        ..Default::default()
    };
    let adaptive = json!({ "type": "adaptive" });
    let body = serde_json::to_vec(&effort_request(adaptive.clone(), Some("high"))).unwrap();
    let plain = serde_json::to_vec(&effort_request(adaptive, None)).unwrap();
    let omitted = to_chat(&body, "x", &omit).unwrap();
    assert!(!omitted.reasoning_effort_sent);
    assert_eq!(
        omitted.body,
        to_chat(&plain, "x", &UpstreamOptions::default())
            .unwrap()
            .body
    );
    // Responses 出口本次不发推理强度
    let responses = to_responses(&body, "x", &UpstreamOptions::default()).unwrap();
    assert!(!responses.reasoning_effort_sent);
    assert!(!String::from_utf8_lossy(&responses.body).contains("effort"));
}

#[test]
fn invalid_requests_are_rejected() {
    let err = |body: &[u8]| to_chat(body, "x", &UpstreamOptions::default()).unwrap_err();
    assert!(matches!(err(b"not json"), RequestError::Parse(_)));
    assert!(matches!(err(b"[]"), RequestError::NotObject));
    assert!(matches!(
        err(br#"{"messages":[]}"#),
        RequestError::MissingModel
    ));
    assert!(matches!(
        err(br#"{"model":"m"}"#),
        RequestError::MissingMessages
    ));
    assert!(matches!(
        err(br#"{"model":"m","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"x"}]}]}"#),
        RequestError::NoMessages
    ));
    assert_eq!(
        request_model(br#"{"model":"kimi","messages":[]}"#).unwrap(),
        "kimi"
    );
    assert!(matches!(
        request_model(br#"{"model":""}"#),
        Err(RequestError::MissingModel)
    ));
    // stream 缺省或为假 → 客户端要非流式（R25）
    let converted = to_chat(
        br#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#,
        "x",
        &UpstreamOptions::default(),
    )
    .unwrap();
    assert!(!converted.stream);
    let chat: Value = serde_json::from_slice(&converted.body).unwrap();
    assert_eq!(chat["stream"], json!(true), "对上游仍然要流式");
}

// ---------- 工具名与 id（R18 / AC19） ----------

#[test]
fn ac19_long_tool_names_round_trip_and_ids_are_sanitized() {
    let long = format!("mcp__{}__search", "x".repeat(57));
    assert_eq!(long.len(), 70);
    let short = upstream_tool_name(&long);
    assert!(short.len() <= MAX_TOOL_NAME_LEN);
    assert!(short
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    assert_eq!(short, upstream_tool_name(&long), "确定性");
    assert_ne!(
        short,
        upstream_tool_name(&format!("mcp__{}__searcX", "x".repeat(57)))
    );
    assert_eq!(upstream_tool_name("Bash"), "Bash");
    let dotted = upstream_tool_name("mcp.server:tool");
    assert!(dotted.starts_with("mcp_server_tool_") && dotted.len() == "mcp_server_tool_".len() + 8);

    // 请求里登记、历史里的 tool_use 用同一规则
    let request = json!({
        "model": "m", "max_tokens": 5,
        "tools": [{ "name": long, "input_schema": { "type": "object" } }],
        "messages": [
            { "role": "user", "content": "go" },
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "functions_Bash_0", "name": long, "input": {} }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "functions_Bash_0", "content": "ok" }] }
        ]
    });
    let converted = to_chat(
        &serde_json::to_vec(&request).unwrap(),
        "x",
        &UpstreamOptions::default(),
    )
    .unwrap();
    let chat: Value = serde_json::from_slice(&converted.body).unwrap();
    assert_eq!(chat["tools"][0]["function"]["name"], json!(short));
    assert_eq!(
        chat["messages"][1]["tool_calls"][0]["function"]["name"],
        json!(short)
    );
    assert_eq!(
        chat["messages"][1]["tool_calls"][0]["id"],
        json!("functions_Bash_0"),
        "历史 id 原样"
    );
    assert_eq!(converted.tools.original(&short), long);

    // 回程：上游用短名、带 . 和 : 的 id → Claude Code 收到原名与规整后的 id
    let upstream = sse_done(&[
        delta(
            json!({ "tool_calls": [{ "index": 0, "id": "functions.Bash:0", "type": "function",
            "function": { "name": short, "arguments": "{}" } }] }),
        ),
        finish("tool_calls"),
    ]);
    let events = run_chat(&upstream, 7, "m", 1, converted.tools);
    let block = &events[1].data["content_block"];
    assert_eq!(block["name"], json!(long));
    assert_eq!(block["id"], json!("functions_Bash_0"));

    assert_eq!(sanitize_tool_id("functions.Bash:0"), "functions_Bash_0");
    let generated = sanitize_tool_id("");
    assert!(generated.starts_with("toolu_") && generated.len() == 6 + 24);
    assert!(generated
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_'));
    assert_ne!(generated, sanitize_tool_id(""));
}

// ---------- count_tokens（R14 / AC15） ----------

#[test]
fn ac15_fixed_request_estimate() {
    let request = json!({
        "model": "m",
        "system": "You are helpful.",
        "tools": [{ "name": "Read", "description": "读文件", "input_schema": { "type": "object" } }],
        "messages": [
            { "role": "user", "content": [
                { "type": "text", "text": "你好 world" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }
            ] },
            { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "要计入" },
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "path": "a.txt" } }
            ] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] }
        ]
    });
    // ASCII：16 + 6 + 16 + 2 + 4 + 17 = 61 → 16；非 ASCII：2 + 3 + 3（思考，2026-10-05 起带回上游）= 8；图片 1600
    assert_eq!(estimate_tokens(&request), 1624);
    let response: Value = serde_json::from_slice(
        &count_tokens_response(&serde_json::to_vec(&request).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(response, json!({ "input_tokens": 1624 }));
}

/// 估算跟发送规则走（reasoning-passback R3）：assistant 里带文字或工具调用的那条，thinking 文字计入；
/// redacted_thinking、只有思考的 assistant、user 侧的 thinking 块都不发，不计。
#[test]
fn thinking_is_counted_only_where_it_is_sent() {
    let estimate =
        |messages: Value| estimate_tokens(&json!({ "model": "m", "messages": messages }));
    let user = json!({ "role": "user", "content": "q" });
    let base = estimate(
        json!([user, { "role": "assistant", "content": [{ "type": "text", "text": "答" }] }]),
    );
    let with_thinking = estimate(json!([user, { "role": "assistant", "content": [
        { "type": "thinking", "thinking": "思考十个字思考十个字", "signature": "s" },
        { "type": "redacted_thinking", "data": "很长很长很长很长很长很长很长" },
        { "type": "text", "text": "答" }
    ] }]));
    assert_eq!(with_thinking, base + 10);
    let thinking_only = estimate(json!([user, { "role": "assistant", "content": [
        { "type": "thinking", "thinking": "思考十个字思考十个字" }
    ] }]));
    assert_eq!(thinking_only, estimate(json!([user])));
    let user_side = estimate(json!([{ "role": "user", "content": [
        { "type": "text", "text": "q" },
        { "type": "thinking", "thinking": "思考十个字思考十个字" }
    ] }]));
    assert_eq!(user_side, estimate(json!([user])));
}

#[test]
fn count_tokens_real_captures() {
    // 真实 count_tokens 请求没有 system、只有 model/messages/tools，不能报错
    let tools: Value = serde_json::from_slice(&sample_body("cc-count-tokens-tools.json")).unwrap();
    assert_eq!(estimate_tokens(&tools), 3771);
    let section = sample_body("cc-count-tokens-system-section.json");
    let response: Value =
        serde_json::from_slice(&count_tokens_response(&section).unwrap()).unwrap();
    assert_eq!(response, json!({ "input_tokens": 110 }));
    assert!(matches!(
        count_tokens_response(b"{}"),
        Err(RequestError::MissingMessages)
    ));
}

// ---------- 回程：黄金流（AC21 / AC23 / AC25） ----------

fn golden_events(name: &str) -> Vec<Value> {
    String::from_utf8(read(name))
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn golden_ap_gateway_stream() {
    // ap-gateway：finish_reason 平时是 ""、每块都带累计 usage、tool_calls: []、id 带 . 和 :
    let upstream = read("upstream-ap-gateway-kimi-k2.5-tool-stream.sse");
    let expected =
        golden_events("golden/upstream-ap-gateway-kimi-k2.5-tool-stream.anthropic.jsonl");
    for step in [1, 3, 17, 256, upstream.len()] {
        let events = run_chat(
            &upstream,
            step,
            "default-weibo-kimi-k2.5",
            100,
            ToolNameMap::new(),
        );
        assert_well_formed(&events);
        assert_eq!(normalize(&events), expected, "切片长度 {step}");
    }
}

#[test]
fn golden_openrouter_stream() {
    // openrouter：reasoning / reasoning_details 只取一份转成 thinking 块；finish_reason 出现两次只算一次；usage 在最后
    let upstream = read("upstream-openrouter-deepseek-flash-tool-stream.sse");
    let expected =
        golden_events("golden/upstream-openrouter-deepseek-flash-tool-stream.anthropic.jsonl");
    for step in [1, 5, 64, upstream.len()] {
        let events = run_chat(
            &upstream,
            step,
            "openrouter-deepseek-flash",
            100,
            ToolNameMap::new(),
        );
        assert_well_formed(&events);
        assert_eq!(normalize(&events), expected, "切片长度 {step}");
    }
}

#[test]
fn ac21_interleaved_parallel_tool_calls() {
    let upstream = sse_done(&[
        delta(json!({ "role": "assistant", "content": "先查两个文件。" })),
        delta(
            json!({ "tool_calls": [{ "index": 0, "id": "call_a", "type": "function", "function": { "name": "Read", "arguments": "" } }] }),
        ),
        delta(
            json!({ "tool_calls": [{ "index": 1, "id": "call_b", "type": "function", "function": { "name": "Grep", "arguments": "{\"pat" } }] }),
        ),
        delta(
            json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{\"file_path\":" } }] }),
        ),
        delta(
            json!({ "tool_calls": [{ "index": 1, "function": { "arguments": "tern\":\"x\"}" } }] }),
        ),
        delta(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "\"a.txt\"}" } }] })),
        delta(json!({ "content": "（顺便说一句）" })),
        finish("tool_calls"),
        json!({ "choices": [], "usage": { "prompt_tokens": 1000, "completion_tokens": 20, "prompt_tokens_details": { "cached_tokens": 600 } } }),
    ]);
    let events = run_chat(&upstream, 11, "m", 7, ToolNameMap::new());
    assert_well_formed(&events);
    let text_block = json!({ "type": "text", "text": "" });
    let expected = vec![
        json!({ "event": "message_start", "data": { "type": "message_start", "message": {
            "id": "<msg-id>", "type": "message", "role": "assistant", "model": "m", "content": [],
            "stop_reason": null, "stop_sequence": null, "usage": { "input_tokens": 7, "output_tokens": 0 } } } }),
        json!({ "event": "content_block_start", "data": { "type": "content_block_start", "index": 0, "content_block": text_block } }),
        json!({ "event": "content_block_delta", "data": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "先查两个文件。" } } }),
        json!({ "event": "content_block_stop", "data": { "type": "content_block_stop", "index": 0 } }),
        json!({ "event": "content_block_start", "data": { "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "call_a", "name": "Read", "input": {} } } }),
        json!({ "event": "content_block_delta", "data": { "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":" } } }),
        json!({ "event": "content_block_delta", "data": { "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "\"a.txt\"}" } } }),
        json!({ "event": "content_block_stop", "data": { "type": "content_block_stop", "index": 1 } }),
        json!({ "event": "content_block_start", "data": { "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "call_b", "name": "Grep", "input": {} } } }),
        json!({ "event": "content_block_delta", "data": { "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"pattern\":\"x\"}" } } }),
        json!({ "event": "content_block_stop", "data": { "type": "content_block_stop", "index": 2 } }),
        json!({ "event": "content_block_start", "data": { "type": "content_block_start", "index": 3, "content_block": text_block } }),
        json!({ "event": "content_block_delta", "data": { "type": "content_block_delta", "index": 3, "delta": { "type": "text_delta", "text": "（顺便说一句）" } } }),
        json!({ "event": "content_block_stop", "data": { "type": "content_block_stop", "index": 3 } }),
        json!({ "event": "message_delta", "data": { "type": "message_delta",
            "delta": { "stop_reason": "tool_use", "stop_sequence": null },
            "usage": { "input_tokens": 400, "output_tokens": 20, "cache_read_input_tokens": 600, "cache_creation_input_tokens": 0 } } }),
        json!({ "event": "message_stop", "data": { "type": "message_stop" } }),
    ];
    assert_eq!(normalize(&events), expected);
}

/// 个别上游先给 id、名字在后一块才到；参数也可能先于名字到。都不能丢。
#[test]
fn tool_name_arriving_after_id_is_kept() {
    let upstream = sse_done(&[
        delta(
            json!({ "tool_calls": [{ "index": 0, "id": "call_x", "function": { "arguments": "" } }] }),
        ),
        delta(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{\"a\"" } }] })),
        delta(
            json!({ "tool_calls": [{ "index": 0, "function": { "name": "Read", "arguments": ":1}" } }] }),
        ),
        finish("tool_calls"),
    ]);
    let events = run_chat(&upstream, 6, "m", 1, ToolNameMap::new());
    assert_well_formed(&events);
    let data: Vec<Value> = events.iter().map(|e| e.data.clone()).collect();
    assert_eq!(
        data[1]["content_block"],
        json!({ "type": "tool_use", "id": "call_x", "name": "Read", "input": {} })
    );
    assert_eq!(data[2]["delta"]["partial_json"], json!("{\"a\""));
    assert_eq!(data[3]["delta"]["partial_json"], json!(":1}"));
}

/// AC2（reasoning-passback R2）：上游先吐 30 段 reasoning_content 再吐文本与工具调用 →
/// 一个 thinking 块（逐段 thinking_delta、收尾一个 signature_delta）、文本块、tool_use 块，index 连续。
#[test]
fn ac2_reasoning_becomes_a_thinking_block_first() {
    let mut chunks: Vec<Value> = (0..30)
        .map(|i| delta(json!({ "content": "", "reasoning_content": format!("想{i}") })))
        .collect();
    chunks.push(delta(json!({ "content": "答案" })));
    chunks.push(delta(
        json!({ "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "Read", "arguments": "{}" } }] }),
    ));
    chunks.push(finish("tool_calls"));
    let events = run_chat(&sse_done(&chunks), 13, "m", 1, ToolNameMap::new());
    assert_well_formed(&events);
    let got = normalize(&events);
    assert_eq!(
        got[1]["data"],
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } })
    );
    for i in 0..30 {
        assert_eq!(
            got[2 + i]["data"],
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": format!("想{i}") } }),
            "第 {i} 段思考"
        );
    }
    assert_eq!(
        got[32]["data"],
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "<signature>" } })
    );
    assert_eq!(
        got[33]["data"],
        json!({ "type": "content_block_stop", "index": 0 })
    );
    assert_eq!(got[34]["data"]["content_block"]["type"], json!("text"));
    assert_eq!(got[34]["data"]["index"], json!(1));
    assert_eq!(got[37]["data"]["content_block"]["type"], json!("tool_use"));
    assert_eq!(got[37]["data"]["index"], json!(2));
    assert_eq!(
        names(&events)[34..],
        [
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]
    );
}

/// openrouter 同一块里的 reasoning 与 reasoning_details 内容相同，只取一份；只有加密内容的 details、
/// 正文开始之后才到的思考都不产出字节（不回头插入，同 Codex 路径）；没有思考内容时不发 thinking 块。
#[test]
fn reasoning_sources_and_late_reasoning() {
    let upstream = sse_done(&[
        delta(
            json!({ "reasoning": "r1", "reasoning_details": [{ "type": "reasoning.text", "text": "r1" }] }),
        ),
        delta(json!({ "reasoning_details": [{ "type": "reasoning.summary", "summary": "s2" }] })),
        delta(
            json!({ "reasoning_details": [{ "type": "reasoning.encrypted", "data": "opaque" }] }),
        ),
        delta(json!({ "content": "答" })),
        delta(json!({ "reasoning_content": "晚到的思考" })),
        finish("stop"),
    ]);
    let events = run_chat(&upstream, 7, "m", 1, ToolNameMap::new());
    assert_well_formed(&events);
    let thinking: String = events
        .iter()
        .filter_map(|e| e.data.pointer("/delta/thinking").and_then(Value::as_str))
        .collect();
    assert_eq!(thinking, "r1s2");
    let text = serde_json::to_string(&normalize(&events)).unwrap();
    assert!(
        !text.contains("晚到的思考") && !text.contains("opaque"),
        "{text}"
    );
    assert_eq!(text.matches("signature_delta").count(), 1);

    let plain = run_chat(
        &sse_done(&[delta(json!({ "content": "hi" })), finish("stop")]),
        64,
        "m",
        1,
        ToolNameMap::new(),
    );
    let text = serde_json::to_string(&normalize(&plain)).unwrap();
    assert!(
        !text.contains("thinking") && !text.contains("signature"),
        "{text}"
    );
}

#[test]
fn ac25_stop_reasons_and_usage() {
    let run = |chunks: Vec<Value>| -> Value {
        let events = run_chat(&sse_done(&chunks), 9, "m", 42, ToolNameMap::new());
        assert_well_formed(&events);
        events
            .iter()
            .find(|e| e.name == "message_delta")
            .unwrap()
            .data
            .clone()
    };
    let text_then = |reason: Option<&str>| {
        let mut chunks = vec![delta(json!({ "content": "hello" }))];
        if let Some(reason) = reason {
            chunks.push(finish(reason));
        }
        chunks
    };
    for (reason, expected) in [
        (Some("stop"), "end_turn"),
        (Some("length"), "max_tokens"),
        (Some("tool_calls"), "tool_use"),
        (Some("function_call"), "tool_use"),
        (Some("content_filter"), "refusal"),
        (Some("something_new"), "end_turn"),
        (None, "end_turn"),
    ] {
        assert_eq!(
            run(text_then(reason))["delta"]["stop_reason"],
            json!(expected),
            "{reason:?}"
        );
    }
    // 已发出工具调用而上游报 stop → tool_use
    let with_tool = vec![
        delta(
            json!({ "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "Read", "arguments": "{}" } }] }),
        ),
        finish("stop"),
    ];
    assert_eq!(run(with_tool)["delta"]["stop_reason"], json!("tool_use"));

    // 无用量 → 输入用估算，输出按已转发文本估算（"hello" 5 个 ASCII → 2）
    assert_eq!(
        run(text_then(Some("stop")))["usage"],
        json!({ "input_tokens": 42, "output_tokens": 2, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 })
    );
    // 有缓存命中
    let mut chunks = text_then(Some("stop"));
    chunks.push(json!({ "choices": [], "usage": { "prompt_tokens": 1000, "completion_tokens": 9, "prompt_tokens_details": { "cached_tokens": 600 } } }));
    assert_eq!(
        run(chunks)["usage"],
        json!({ "input_tokens": 400, "output_tokens": 9, "cache_read_input_tokens": 600, "cache_creation_input_tokens": 0 })
    );
}

#[test]
fn empty_and_whitespace_deltas() {
    // 空串不开块；只有空白的文本照样转发
    let events = run_chat(
        &sse_done(&[
            delta(json!({ "content": "" })),
            delta(json!({ "content": " \n" })),
            finish("stop"),
        ]),
        4,
        "m",
        1,
        ToolNameMap::new(),
    );
    assert_well_formed(&events);
    assert_eq!(events[2].data["delta"]["text"], json!(" \n"));

    // 什么内容都没有也要完整收尾
    let events = run_chat(&sse_done(&[finish("stop")]), 4, "m", 1, ToolNameMap::new());
    assert_eq!(
        names(&events),
        ["message_start", "message_delta", "message_stop"]
    );
}

// ---------- 回程：错误与断流（R26 流中部分） ----------

#[test]
fn upstream_error_chunk_ends_with_error_event() {
    let upstream = sse(&[
        delta(json!({ "content": "半句" })),
        json!({ "error": { "message": "boom", "code": 500 } }),
        delta(json!({ "content": "不该出现" })),
    ]);
    let events = run_chat(&upstream, 5, "m", 1, ToolNameMap::new());
    let last = events.last().unwrap();
    assert_eq!(last.name, "error");
    assert_eq!(
        last.data,
        json!({ "type": "error", "error": { "type": "api_error", "message": "boom" } })
    );
    assert!(!names(&events)
        .iter()
        .any(|n| n == "message_stop" || n == "message_delta"));
    assert!(!serde_json::to_string(&normalize(&events))
        .unwrap()
        .contains("不该出现"));

    let overloaded = sse(&[json!({ "error": { "message": "Model is overloaded, try later" } })]);
    let events = run_chat(&overloaded, 64, "m", 1, ToolNameMap::new());
    assert_eq!(
        events.last().unwrap().data["error"]["type"],
        json!("overloaded_error")
    );
}

#[test]
fn stream_closed_without_end_marker_is_an_error() {
    let upstream = sse(&[delta(json!({ "content": "截断的回" }))]);
    let events = run_chat(&upstream, 64, "m", 1, ToolNameMap::new());
    assert_eq!(events.last().unwrap().name, "error");
    assert!(!names(&events).iter().any(|n| n == "message_stop"));

    // 有 finish_reason 但没有 [DONE] 就关了：算正常结束
    let events = run_chat(
        &sse(&[delta(json!({ "content": "完整" })), finish("stop")]),
        64,
        "m",
        1,
        ToolNameMap::new(),
    );
    assert_well_formed(&events);

    // 路由侧的连接错误：fail 之后什么都不再产出
    let mut emitter = AnthropicEmitter::new("m", 1, ToolNameMap::new());
    emitter.start();
    emitter.on_event(UpstreamEvent::Text("a".into()));
    let failed = emitter.fail("connection reset", false);
    assert_eq!(names(&failed), ["error"]);
    assert!(emitter.is_finished());
    assert!(emitter.finish().is_empty());
    assert!(emitter.on_event(UpstreamEvent::Text("b".into())).is_empty());
}

#[test]
fn overlong_line_is_capped() {
    let mut parser = ChatEvents::new();
    let events = parser.feed_bytes(&vec![b'x'; (8 << 20) + 1]);
    assert!(matches!(events.as_slice(), [UpstreamEvent::Error(_)]));
    assert!(
        parser.feed_bytes(b"data: [DONE]\n").is_empty(),
        "出错后不再解析"
    );
}

// ---------- 保活 ping（R23） ----------

#[test]
fn keepalive_pings_only_after_silence() {
    let start = Instant::now();
    let interval = Duration::from_millis(100);
    let mut keepalive = Keepalive::new(interval, start);
    assert_eq!(keepalive.remaining(start), interval);
    assert!(keepalive.poll(start + Duration::from_millis(50)).is_none());
    assert_eq!(
        keepalive.remaining(start + Duration::from_millis(50)),
        Duration::from_millis(50)
    );
    let ping = keepalive
        .poll(start + Duration::from_millis(100))
        .expect("静默满一个间隔要 ping");
    assert_eq!(
        ping.to_sse_string(),
        "event: ping\ndata: {\"type\":\"ping\"}\n\n"
    );
    assert!(
        keepalive.poll(start + Duration::from_millis(150)).is_none(),
        "ping 本身算写出"
    );
    assert!(keepalive.poll(start + Duration::from_millis(200)).is_some());
    keepalive.record_write(start + Duration::from_millis(250));
    assert!(keepalive.poll(start + Duration::from_millis(340)).is_none());
    assert_eq!(
        keepalive.remaining(start + Duration::from_millis(400)),
        Duration::ZERO
    );
    assert_eq!(DEFAULT_KEEPALIVE_INTERVAL, Duration::from_secs(15));
    assert_eq!(ping_event(), ping);

    // 没有文字的推理信号（Responses 上游、只有加密内容）不产出任何字节，所以路由会照样 ping；
    // 正文开始之后才到的思考也一样
    let mut emitter = AnthropicEmitter::new("m", 1, ToolNameMap::new());
    emitter.start();
    assert!(emitter
        .on_event(UpstreamEvent::Reasoning(String::new()))
        .is_empty());
    assert!(emitter.is_streaming());
    assert!(!emitter
        .on_event(UpstreamEvent::Text("答".to_string()))
        .is_empty());
    assert!(emitter
        .on_event(UpstreamEvent::Reasoning("晚了".to_string()))
        .is_empty());
}

// ---------- 非流式（R25） ----------

#[test]
fn r26_aggregated_message_matches_stream() {
    let upstream = read("upstream-ap-gateway-kimi-k2.5-tool-stream.sse");
    let events = run_chat(
        &upstream,
        64,
        "default-weibo-kimi-k2.5",
        100,
        ToolNameMap::new(),
    );
    let mut aggregator = MessageAggregator::new();
    for event in &events {
        aggregator.push(event);
    }
    let message = aggregator.finish().unwrap();
    let id = message["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("msg_"));
    // R2：非流式同样带 thinking 块，排在最前；文字与流式时拼起来的相同
    let streamed: String = events
        .iter()
        .filter_map(|e| e.data.pointer("/delta/thinking").and_then(Value::as_str))
        .collect();
    let thinking = message["content"][0]["thinking"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(thinking.starts_with("用户想知道北京的"), "{thinking}");
    assert_eq!(thinking, streamed);
    let signature = message["content"][0]["signature"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(
        signature.starts_with(THINKING_SIGNATURE_PREFIX),
        "{signature}"
    );
    assert_eq!(
        message,
        json!({
            "id": id, "type": "message", "role": "assistant", "model": "default-weibo-kimi-k2.5",
            "content": [
                { "type": "thinking", "thinking": thinking, "signature": signature },
                { "type": "text", "text": "我来为您查询一下北京当前的天气情况。" },
                { "type": "tool_use", "id": "functions_get_weather_0", "name": "get_weather", "input": { "city": "北京" } }
            ],
            "stop_reason": "tool_use", "stop_sequence": null,
            "usage": { "input_tokens": 81, "output_tokens": 59, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 }
        })
    );

    // 流中出错 → 聚合结果是错误
    let broken = run_chat(
        &sse(&[delta(json!({ "content": "x" }))]),
        64,
        "m",
        1,
        ToolNameMap::new(),
    );
    let mut aggregator = MessageAggregator::new();
    for event in &broken {
        aggregator.push(event);
    }
    let error = aggregator.finish().unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(error.error_type, "api_error");

    // 工具参数不是合法 JSON（被截断）时，input 退回空对象而不是整条失败
    let truncated = run_chat(
        &sse_done(&[
            delta(
                json!({ "tool_calls": [{ "index": 0, "id": "c", "function": { "name": "Read", "arguments": "{\"a\":" } }] }),
            ),
            finish("length"),
        ]),
        64,
        "m",
        1,
        ToolNameMap::new(),
    );
    let mut aggregator = MessageAggregator::new();
    for event in &truncated {
        aggregator.push(event);
    }
    let message = aggregator.finish().unwrap();
    assert_eq!(message["content"][0]["input"], json!({}));
    assert_eq!(message["stop_reason"], json!("max_tokens"));
}

// ---------- Responses（R19，实验性 / AC20） ----------

#[test]
fn ac20_to_responses_shape() {
    let request = json!({
        "model": "m", "max_tokens": 100, "temperature": 0.5, "stream": true,
        "thinking": { "type": "adaptive" },
        "system": [{ "type": "text", "text": "x-anthropic-billing-header: a;" }, { "type": "text", "text": "Sys" }],
        "tools": [{ "name": "Read", "description": "r", "input_schema": { "type": "object" } },
                  { "type": "web_search_20250305", "name": "web_search" }],
        "tool_choice": { "type": "any", "disable_parallel_tool_use": true },
        "output_config": { "format": { "type": "json_schema", "schema": { "type": "object" } } },
        "messages": [
            { "role": "user", "content": [{ "type": "text", "text": "hi" },
                { "type": "image", "source": { "type": "url", "url": "https://i/x.png" } }] },
            { "role": "system", "content": "env" },
            { "role": "assistant", "content": [{ "type": "text", "text": "ok" },
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "p": 1 } }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": [
                { "type": "text", "text": "out" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "QQ" } }] }] }
        ]
    });
    let converted = to_responses(
        &serde_json::to_vec(&request).unwrap(),
        "gpt-x",
        &UpstreamOptions::default(),
    )
    .unwrap();
    let body: Value = serde_json::from_slice(&converted.body).unwrap();
    let schema_hint = "Sys\n\nRespond with only a JSON object that matches the following JSON Schema. Do not wrap it in Markdown code fences and do not add any other text.\n\nJSON Schema:\n{\"type\":\"object\"}";
    assert_eq!(
        body,
        json!({
            "model": "gpt-x",
            "stream": true,
            "store": false,
            "instructions": schema_hint,
            "tools": [{ "type": "function", "name": "Read", "description": "r", "parameters": { "type": "object" } }],
            "tool_choice": "required",
            "parallel_tool_calls": false,
            "input": [
                { "type": "message", "role": "user", "content": [
                    { "type": "input_text", "text": "hi" },
                    { "type": "input_image", "image_url": "https://i/x.png" },
                    { "type": "input_text", "text": "<system-reminder>\nenv\n</system-reminder>" }
                ] },
                { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "ok" }] },
                { "type": "function_call", "call_id": "t1", "name": "Read", "arguments": "{\"p\":1}" },
                { "type": "function_call_output", "call_id": "t1", "output": "out" },
                { "type": "message", "role": "user", "content": [
                    { "type": "input_image", "image_url": "data:image/png;base64,QQ" }
                ] }
            ],
            "max_output_tokens": 100,
            "temperature": 0.5,
            "text": { "format": { "type": "json_schema", "name": "output", "schema": { "type": "object" }, "strict": true } }
        })
    );
    assert!(converted.stream);
}

fn run_responses(upstream: &str, tools: ToolNameMap) -> Vec<SseEvent> {
    let mut parser = ResponsesEvents::new();
    let mut emitter = AnthropicEmitter::new("m", 5, tools);
    let mut out = emitter.start();
    for piece in upstream.as_bytes().chunks(9) {
        for event in parser.feed_bytes(piece) {
            out.extend(emitter.on_event(event));
        }
    }
    for event in parser.finish() {
        out.extend(emitter.on_event(event));
    }
    out.extend(emitter.finish());
    out
}

#[test]
fn ac20_responses_stream_events() {
    let upstream = [
        r#"event: response.created"#,
        r#"data: {"type":"response.created","response":{"id":"r"}}"#,
        "",
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs"}}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"想"}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":1,"delta":"Hi"}"#,
        r#"data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"call.1","name":"Read","arguments":""}}"#,
        r#"data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\"a\":1}"}"#,
        r#"data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","call_id":"call.1","name":"Read","arguments":"{\"a\":1}"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":3,"item":{"type":"function_call","call_id":"call_2","name":"Grep","arguments":""}}"#,
        r#"data: {"type":"response.output_item.done","output_index":3,"item":{"type":"function_call","call_id":"call_2","name":"Grep","arguments":"{\"b\":2}"}}"#,
        r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":10},"output_tokens":7}}}"#,
        "",
    ]
    .join("\n");
    let events = run_responses(&upstream, ToolNameMap::new());
    assert_well_formed(&events);
    let summary: Vec<Value> = normalize(&events)[1..]
        .iter()
        .map(|e| e["data"].clone())
        .collect();
    assert_eq!(
        summary,
        vec![
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hi" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "call_1", "name": "Read", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"a\":1}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "call_2", "name": "Grep", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"b\":2}" } }),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use", "stop_sequence": null },
                "usage": { "input_tokens": 40, "output_tokens": 7, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 0 } }),
            json!({ "type": "message_stop" }),
        ]
    );

    let incomplete = "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"Hi\"}\n\ndata: {\"type\":\"response.incomplete\",\"response\":{\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n";
    let events = run_responses(incomplete, ToolNameMap::new());
    assert_well_formed(&events);
    let message_delta = events.iter().find(|e| e.name == "message_delta").unwrap();
    assert_eq!(
        message_delta.data["delta"]["stop_reason"],
        json!("max_tokens")
    );

    let failed =
        "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"nope\"}}}\n\n";
    let events = run_responses(failed, ToolNameMap::new());
    assert_eq!(
        events.last().unwrap().data,
        json!({ "type": "error", "error": { "type": "api_error", "message": "nope" } })
    );
}

// ---------- 错误映射（R26 / AC27） ----------

fn failure(status: u16, body: &[u8]) -> UpstreamFailure<'_> {
    UpstreamFailure {
        status,
        body,
        retry_after: None,
        retry_after_ms: None,
    }
}

fn at(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs)
}

#[test]
fn ac27_context_overflow_from_real_gateways() {
    let now = at(0);
    for (sample, starts) in [
        (
            "upstream-ap-gateway-kimi-k2.5-context-overflow.json",
            "prompt is too long: The input (300020 tokens) is longer than the model's context length (163840 tokens).",
        ),
        (
            "upstream-openrouter-lfm-2.5-context-overflow.json",
            "prompt is too long: This endpoint's maximum context length is 65536 tokens.",
        ),
    ] {
        let body = read(sample);
        let error = map_upstream_error(&failure(400, &body), "ap", "sk-secret", now);
        assert_eq!((error.status, error.error_type), (400, "invalid_request_error"), "{sample}");
        assert!(error.message.starts_with(starts), "{sample}: {}", error.message);
        let wire: Value = serde_json::from_slice(&error.body()).unwrap();
        assert_eq!(wire["type"], json!("error"));
        assert_eq!(wire["error"]["type"], json!("invalid_request_error"));
    }
    let not_found = map_upstream_error(
        &failure(404, &read("upstream-ap-gateway-glm-5-404.json")),
        "ap",
        "k",
        now,
    );
    assert_eq!(
        (not_found.status, not_found.error_type),
        (404, "not_found_error")
    );
    assert!(not_found.message.contains("404 Not Found"));
}

#[test]
fn ac27_context_overflow_keywords() {
    for text in [
        "context_length_exceeded",
        "This model's maximum context length is 8192 tokens",
        "The input is longer than the model's context length",
        "exceeds the context window",
        "Too many tokens in request",
        "Prompt is too long",
        "input is too long for requested model",
        "Please reduce the length of the messages",
        "请求超出模型上下文长度",
        "您的输入或输出内容超出了模型的处理上限",
    ] {
        assert!(is_context_overflow(text), "{text}");
        let body = json!({ "error": { "message": text } }).to_string();
        let error = map_upstream_error(&failure(400, body.as_bytes()), "g", "k", at(0));
        assert!(error.message.starts_with("prompt is too long"), "{text}");
    }
    for text in ["invalid tool schema", "model not found", "rate limited"] {
        assert!(!is_context_overflow(text), "{text}");
    }
    assert!(CONTEXT_OVERFLOW_PATTERNS.contains(&"context length"));
}

#[test]
fn ac27_status_table() {
    let now = at(1_000);
    let body = br#"{"error":{"message":"bad key sk-live-123 rejected"}}"#;
    let map = |status: u16| {
        map_upstream_error(&failure(status, body), "openrouter.ai", "sk-live-123", now)
    };

    let e = map(400);
    assert_eq!((e.status, e.error_type), (400, "invalid_request_error"));
    assert_eq!(e.message, "bad key *** rejected", "密钥打码");
    assert_eq!(map(422).status, 400);
    for status in [401, 403] {
        let e = map(status);
        assert_eq!((e.status, e.error_type), (403, "permission_error"));
        assert_eq!(
            e.message,
            "openrouter.ai 拒绝了 Sophia 保存的密钥：bad key *** rejected"
        );
        assert_eq!(e.should_retry, Some(false));
        assert!(e
            .headers()
            .contains(&("x-should-retry", "false".to_string())));
    }
    assert_eq!(
        (map(404).status, map(404).error_type),
        (404, "not_found_error")
    );
    assert_eq!(
        (map(413).status, map(413).error_type),
        (413, "request_too_large")
    );
    assert_eq!(
        (map(429).status, map(429).error_type),
        (429, "rate_limit_error")
    );
    for status in [502, 503, 504] {
        assert_eq!(
            (map(status).status, map(status).error_type),
            (529, "overloaded_error")
        );
    }
    for status in [500, 501, 599] {
        assert_eq!(
            (map(status).status, map(status).error_type),
            (500, "api_error")
        );
    }
    assert_eq!(
        (map(402).status, map(402).error_type),
        (400, "invalid_request_error")
    );

    // 密钥为空时不做替换（否则会在每个字符之间插入 ***）
    let e = map_upstream_error(&failure(400, body), "g", "", now);
    assert_eq!(e.message, "bad key sk-live-123 rejected");
    // 非 JSON 原文
    let e = map_upstream_error(&failure(500, b"  upstream exploded  "), "g", "k", now);
    assert_eq!(e.message, "upstream exploded");
}

#[test]
fn ac27_retry_after() {
    // HTTP 日期：Wed, 21 Oct 2026 07:28:00 GMT = 1792567680
    let date = 1_792_567_680;
    assert_eq!(
        retry_after_seconds(Some("Wed, 21 Oct 2026 07:28:00 GMT"), None, at(date - 30)),
        Some(30)
    );
    assert_eq!(
        retry_after_seconds(Some("Wed, 21 Oct 2026 07:28:00 GMT"), None, at(date + 5)),
        Some(0)
    );
    assert_eq!(retry_after_seconds(Some("12"), None, at(0)), Some(12));
    assert_eq!(retry_after_seconds(Some("1.2"), None, at(0)), Some(2));
    assert_eq!(retry_after_seconds(None, Some("1500"), at(0)), Some(2));
    assert_eq!(
        retry_after_seconds(Some("30"), Some("1500"), at(0)),
        Some(2),
        "ms 更精确，优先"
    );
    assert_eq!(retry_after_seconds(Some("soon"), None, at(0)), None);
    assert_eq!(retry_after_seconds(None, None, at(0)), None);
    // 畸形日期：越界的年月日时分秒一律读不出，不 panic、不回绕（Codex 复审 4/7）
    for bad in [
        "Thu, 01 Jan -9223372036854775808 00:00:00 GMT",
        "Thu, 01 Jan 9223372036854775807 00:00:00 GMT",
        "Thu, 99 Jan 2026 00:00:00 GMT",
        "Thu, 01 Jan 2026 25:00:00 GMT",
        "Thu, 01 Jan 2026 00:61:00 GMT",
        "Thu, 01 Jan 2026 00:00:99 GMT",
        "Thu, 00 Jan 2026 00:00:00 GMT",
        "Thu, 01 Jan 1969 00:00:00 GMT",
    ] {
        assert_eq!(retry_after_seconds(Some(bad), None, at(0)), None, "{bad}");
    }
    // 秒数太大或是负数：取不到（不回绕成小数）
    assert_eq!(retry_after_seconds(Some("-5"), None, at(0)), None);
    assert_eq!(retry_after_seconds(Some("1e400"), None, at(0)), None);

    let limited = UpstreamFailure {
        status: 429,
        body: b"{}",
        retry_after: Some("Wed, 21 Oct 2026 07:28:00 GMT"),
        retry_after_ms: None,
    };
    let e = map_upstream_error(&limited, "g", "k", at(date - 7));
    assert_eq!(e.retry_after, Some(7));
    assert!(e.headers().contains(&("retry-after", "7".to_string())));
}

#[test]
fn local_error_constructors() {
    let e = AnthropicError::bad_token();
    assert_eq!(
        (e.status, e.error_type, e.should_retry),
        (401, "authentication_error", Some(false))
    );
    assert_eq!(
        e.message,
        "Sophia 本机转接的令牌不对：打开 Sophia 的模型页，按提示重新写入"
    );
    let e = AnthropicError::model_not_selected("kimi");
    assert_eq!(
        (e.status, e.error_type, e.should_retry),
        (404, "not_found_error", Some(false))
    );
    assert_eq!(e.message, "模型 kimi 不在 Sophia 为 Claude 选的模型里");
    let e = AnthropicError::gateway_unavailable();
    assert_eq!(
        (e.status, e.error_type, e.should_retry),
        (500, "api_error", Some(false))
    );
    assert_eq!(
        e.message,
        "Sophia 里这家模型提供商已删掉或没有密钥：在 Sophia 里重启 Claude 让改动生效"
    );
    let e = AnthropicError::upstream_unreachable("timed out");
    assert_eq!((e.status, e.error_type), (502, "api_error"));
    let e = AnthropicError::internal("keychain");
    assert_eq!(
        (e.status, e.error_type, e.should_retry),
        (500, "api_error", Some(false))
    );
    let e = AnthropicError::invalid_request("bad");
    assert_eq!((e.status, e.error_type), (400, "invalid_request_error"));
    assert_eq!(
        serde_json::from_slice::<Value>(&e.body()).unwrap(),
        json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "bad" } })
    );
    assert_eq!(e.to_event().name, "error");
}

/// 上游不许关推理（2026-09-30 真机：OpenRouter 的 z-ai/glm-5.3）：认出来，路由去掉「关推理」重发；
/// 别的 400、以及说推理强度不支持的，不算
#[test]
fn rejects_thinking_off_recognises_mandatory_reasoning() {
    use super::rejects_thinking_off;
    let body = br#"{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400}}"#;
    assert!(rejects_thinking_off(400, body));
    assert!(rejects_thinking_off(400, "思考模式不能关闭".as_bytes()));
    assert!(!rejects_thinking_off(500, body), "只认 400");
    assert!(!rejects_thinking_off(
        400,
        br#"{"error":{"message":"messages: too many images"}}"#
    ));
    assert!(!rejects_thinking_off(
        400,
        br#"{"error":{"message":"reasoning_effort is not supported"}}"#
    ));
}

//! WorkBuddy 的 models.json 改写（spec #247「四」、#266）：只增删 Sophia 的条目，保留用户的条目与用户对 Sophia 条目的改动
use super::*;

const TOKEN: &str = "sophia-token-1";

fn entry(id: &str, plain: &str, vendor: &str) -> Entry {
    Entry {
        id: id.to_owned(),
        name: plain.to_owned(),
        plain_name: plain.to_owned(),
        vendor: vendor.to_owned(),
        max_input_tokens: Some(256_000),
        supports_images: false,
    }
}

fn kimi() -> Entry {
    entry("kimi-kimi-k2.6", "kimi-k2.6", "Kimi")
}

fn deepseek() -> Entry {
    Entry {
        max_input_tokens: None,
        supports_images: true,
        ..entry("deepseek-deepseek-v4", "deepseek-v4", "DeepSeek")
    }
}

fn run(current: Option<&str>, entries: &[Entry], port: u16, token: &str) -> Option<String> {
    plan(current.map(str::as_bytes), entries, port, token)
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
}

/// WorkBuddy 自己保存时的样子（`JSON.stringify(models, null, 2)`）里的一条 Sophia 条目
fn sophia_block(id: &str, name: &str, vendor: &str, port: u16, token: &str) -> String {
    format!(
        "  {{\n    \"id\": \"{id}\",\n    \"name\": \"{name}\",\n    \"vendor\": \"{vendor}\",\n    \"url\": \"http://127.0.0.1:{port}/workbuddy/v1/chat/completions\",\n    \"apiKey\": \"{token}\",\n    \"maxInputTokens\": 256000,\n    \"supportsToolCall\": true,\n    \"supportsImages\": false\n  }}"
    )
}

const USER: &str = "  {\n    \"id\": \"my-glm\",\n    \"name\": \"My GLM\",\n    \"url\": \"https://open.bigmodel.cn/api/paas/v4/chat/completions\",\n    \"apiKey\": \"sk-user\"\n  }";

#[test]
fn missing_file_gets_a_list_of_sophia_entries_pointing_at_the_router() {
    let out = run(None, &[kimi(), deepseek()], 47328, TOKEN).unwrap();
    assert_eq!(
        out,
        format!(
            "[\n{},\n  {{\n    \"id\": \"deepseek-deepseek-v4\",\n    \"name\": \"deepseek-v4\",\n    \"vendor\": \"DeepSeek\",\n    \"url\": \"http://127.0.0.1:47328/workbuddy/v1/chat/completions\",\n    \"apiKey\": \"sophia-token-1\",\n    \"supportsToolCall\": true,\n    \"supportsImages\": true\n  }}\n]\n",
            sophia_block("kimi-kimi-k2.6", "kimi-k2.6", "Kimi", 47328, TOKEN)
        )
    );
    // 不写 availableModels：写了会整份替换 WorkBuddy 的可用模型列表
    assert!(!out.contains("availableModels"));
    // 没有要写的、文件也不在：不建文件
    assert_eq!(run(None, &[], 47328, TOKEN), None);
    assert_eq!(
        sophia_ids(out.as_bytes()).unwrap(),
        ["kimi-kimi-k2.6", "deepseek-deepseek-v4"]
    );
}

#[test]
fn appends_after_the_users_entries_and_follows_the_file() {
    // WorkBuddy 里一个自定义模型都没加过时，它的文件就是 `[]`
    let out = run(Some("[]"), &[kimi()], 47328, TOKEN).unwrap();
    assert_eq!(
        out,
        format!(
            "[\n{}\n]",
            sophia_block("kimi-kimi-k2.6", "kimi-k2.6", "Kimi", 47328, TOKEN)
        )
    );

    // 对象写法：BOM、CRLF、用户条目与 availableModels 原样不动，追加在 models 末尾
    let text = "\u{feff}{\r\n  \"models\": [\r\n    {\"id\": \"my-glm\", \"url\": \"https://x.example/v1/chat/completions\"}\r\n  ],\r\n  \"availableModels\": [\"my-glm\"]\r\n}\r\n";
    let out = run(Some(text), &[kimi()], 47328, TOKEN).unwrap();
    assert!(out.starts_with("\u{feff}{\r\n  \"models\": [\r\n    {\"id\": \"my-glm\", \"url\": \"https://x.example/v1/chat/completions\"},\r\n    {\r\n      \"id\": \"kimi-kimi-k2.6\",\r\n"), "{out}");
    assert!(
        out.ends_with("    }\r\n  ],\r\n  \"availableModels\": [\"my-glm\"]\r\n}\r\n"),
        "{out}"
    );
    assert!(!out.replace("\r\n", "").contains('\n'));

    // 对象里还没有 models：补上
    let out = run(Some("{}"), &[kimi()], 47328, TOKEN).unwrap();
    assert_eq!(sophia_ids(out.as_bytes()).unwrap(), ["kimi-kimi-k2.6"]);
}

#[test]
fn removing_takes_out_only_sophia_entries_even_after_the_user_changed_them() {
    // 用户在 WorkBuddy 里关掉了一条、改了思考强度与名字（WorkBuddy 保存时把整份写成数组）
    let changed = "  {\n    \"id\": \"deepseek-deepseek-v4\",\n    \"name\": \"我的 DeepSeek\",\n    \"vendor\": \"DeepSeek\",\n    \"url\": \"http://127.0.0.1:47331/workbuddy/v1/chat/completions\",\n    \"apiKey\": \"old-token\",\n    \"supportsReasoning\": true,\n    \"reasoning\": {\n      \"defaultEffort\": \"high\"\n    },\n    \"disabled\": true\n  }";
    let text = format!(
        "[\n{},\n{USER},\n{changed}\n]",
        sophia_block("kimi-kimi-k2.6", "kimi-k2.6", "Kimi", 47328, TOKEN)
    );
    assert_eq!(
        sophia_ids(text.as_bytes()).unwrap(),
        ["kimi-kimi-k2.6", "deepseek-deepseek-v4"]
    );
    assert_eq!(
        run(Some(&text), &[], 47328, TOKEN).unwrap(),
        format!("[\n{USER}\n]")
    );
    // 只拿掉不再选的那一条
    assert_eq!(
        run(Some(&text), &[deepseek()], 47331, "old-token").unwrap(),
        format!("[\n{USER},\n{changed}\n]")
    );
}

#[test]
fn rewriting_keeps_the_users_changes_and_only_fixes_address_token_and_our_names() {
    let changed = "  {\n    \"id\": \"deepseek-deepseek-v4\",\n    \"name\": \"我的 DeepSeek\",\n    \"url\": \"http://127.0.0.1:47328/workbuddy/v1/chat/completions\",\n    \"apiKey\": \"old-token\",\n    \"reasoning\": {\n      \"defaultEffort\": \"high\"\n    },\n    \"disabled\": true\n  }";
    let text = format!(
        "[\n{},\n{changed}\n]\n",
        sophia_block("kimi-kimi-k2.6", "kimi-k2.6", "Kimi", 47328, "old-token")
    );
    // 端口换了、令牌换了、Kimi 撞名要加后缀
    let suffixed = Entry {
        name: "kimi-k2.6 · Kimi".to_owned(),
        ..kimi()
    };
    let out = run(Some(&text), &[suffixed, deepseek()], 47330, TOKEN).unwrap();
    assert_eq!(
        out,
        format!(
            "[\n{},\n{}\n]\n",
            sophia_block("kimi-kimi-k2.6", "kimi-k2.6 · Kimi", "Kimi", 47330, TOKEN),
            changed
                .replace("47328", "47330")
                .replace("old-token", TOKEN)
        )
    );
    // 没有要改的：不写
    assert_eq!(
        run(
            Some(&out),
            &[
                Entry {
                    name: "kimi-k2.6 · Kimi".to_owned(),
                    ..kimi()
                },
                deepseek()
            ],
            47330,
            TOKEN
        ),
        None
    );
}

#[test]
fn a_missing_api_key_is_put_back() {
    let text = "[{\"id\":\"kimi-kimi-k2.6\",\"url\":\"http://127.0.0.1:47328/workbuddy/v1/chat/completions\"}]";
    let out = run(Some(text), &[kimi()], 47328, TOKEN).unwrap();
    assert_eq!(
        out,
        "[{\"id\":\"kimi-kimi-k2.6\",\"url\":\"http://127.0.0.1:47328/workbuddy/v1/chat/completions\",\"apiKey\":\"sophia-token-1\"}]"
    );
}

#[test]
fn sophia_entries_follow_the_picked_order_in_their_own_slots() {
    let text = format!(
        "[\n{},\n{USER},\n{}\n]",
        sophia_block("b", "b", "P", 47328, TOKEN),
        sophia_block("a", "a", "P", 47328, TOKEN)
    );
    let out = run(
        Some(&text),
        &[entry("a", "a", "P"), entry("b", "b", "P")],
        47328,
        TOKEN,
    )
    .unwrap();
    assert_eq!(
        out,
        format!(
            "[\n{},\n{USER},\n{}\n]",
            sophia_block("a", "a", "P", 47328, TOKEN),
            sophia_block("b", "b", "P", 47328, TOKEN)
        )
    );
    // 新选的排在 Sophia 条目的末尾
    let out = run(
        Some(&text),
        &[
            entry("c", "c", "P"),
            entry("b", "b", "P"),
            entry("a", "a", "P"),
        ],
        47328,
        TOKEN,
    )
    .unwrap();
    assert_eq!(sophia_ids(out.as_bytes()).unwrap(), ["c", "b", "a"]);
    assert!(out.contains(USER));
}

#[test]
fn an_id_the_user_already_uses_is_left_to_the_user() {
    let user = "  {\n    \"id\": \"kimi-kimi-k2.6\",\n    \"url\": \"https://api.moonshot.cn/v1/chat/completions\"\n  }";
    let text = format!("[\n{user}\n]");
    assert_eq!(run(Some(&text), &[kimi()], 47328, TOKEN), None);
}

#[test]
fn files_it_cannot_read_are_not_touched() {
    for bad in [
        "{",
        "\"x\"",
        "[1,]",
        "{\"models\": {}}",
        "{\"a\":1,\"a\":2}",
    ] {
        assert!(
            plan(Some(bad.as_bytes()), &[kimi()], 47328, TOKEN).is_err(),
            "{bad}"
        );
    }
    // 空文件当没有
    assert!(run(Some("  \n"), &[kimi()], 47328, TOKEN).is_some());
}

#[test]
fn router_address_is_recognized_on_any_port_of_the_range() {
    assert!(is_router_url(
        "http://127.0.0.1:47339/workbuddy/v1/chat/completions"
    ));
    assert!(is_router_url(
        "http://localhost:47328/workbuddy/v1/chat/completions"
    ));
    assert!(!is_router_url(
        "http://127.0.0.1:47340/workbuddy/v1/chat/completions"
    ));
    assert!(!is_router_url("http://127.0.0.1:47328/v1/chat/completions"));
    assert!(!is_router_url(
        "https://127.0.0.1:47328/workbuddy/v1/chat/completions"
    ));
    assert_eq!(
        router_url(47330),
        "http://127.0.0.1:47330/workbuddy/v1/chat/completions"
    );
}

/// 评审 #19（#266）：用户的 models.json 自带可用模型名单（`availableModels`）时，名单外的模型 WorkBuddy 不列出来。
/// Sophia 不替用户改名单，只认出「Sophia 的条目有不在名单里的」好在行下说一声
#[test]
fn sophia_entries_outside_the_users_allow_list_are_spotted() {
    let written = run(
        Some("{\"models\": [], \"availableModels\": [\"my-glm\"]}"),
        &[kimi()],
        47328,
        TOKEN,
    )
    .unwrap();
    assert_eq!(hidden_by_allow_list(written.as_bytes()), Ok(true));
    let listed = written.replace("[\"my-glm\"]", "[\"my-glm\", \"kimi-kimi-k2.6\"]");
    assert_eq!(hidden_by_allow_list(listed.as_bytes()), Ok(false));
    // 没有名单（裸数组、对象里没写）：都看得到
    let bare = run(None, &[kimi()], 47328, TOKEN).unwrap();
    assert_eq!(hidden_by_allow_list(bare.as_bytes()), Ok(false));
    assert_eq!(hidden_by_allow_list(b"{\"models\": []}"), Ok(false));
}

/// 走查 2026-10-08 第 7 条：两家提供商名只差在中文部分（「QA 全开」「QA 撞名」）时，两条都用显示名作 id，
/// 不退回内部标识；真的同名（只差大小写、空白）才退回
#[test]
fn entry_ids_tell_names_apart_by_their_non_ascii_part() {
    let wanted = [
        ("fake-a · QA 全开".to_owned(), "qa-1-fake-a".to_owned()),
        ("fake-a · QA 撞名".to_owned(), "qa-3-fake-a".to_owned()),
        ("FAKE-A · QA  撞名".to_owned(), "qa-4-fake-a".to_owned()),
    ];
    assert_eq!(
        entry_ids(&wanted, &[]),
        ["fake-a · QA 全开", "fake-a · QA 撞名", "qa-4-fake-a"]
    );
}

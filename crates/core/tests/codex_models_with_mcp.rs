//! 模型网关与 MCP 同步写的是同一份 `~/.codex/config.toml`：先后操作互不破坏（spec 的 AC15、AC16）。
use std::fs;
use std::path::{Path, PathBuf};
use symsync_core::atomicfile::{self, FileState};
use symsync_core::codex_models::config::{self, Managed};
use symsync_core::mcp::{execute, prepare, McpLocation, McpSelection};
use tempfile::tempdir;

fn managed(dir: &Path) -> Managed {
    Managed {
        catalog_path: dir
            .join("symsync-models.json")
            .to_string_lossy()
            .into_owned(),
        base_url: "http://127.0.0.1:47328/v1".into(),
    }
}

fn location(id: &str, path: &Path) -> McpLocation {
    McpLocation {
        id: id.into(),
        label: id.into(),
        harness_id: "codex".into(),
        domain: "global".into(),
        path: path.to_path_buf(),
        selector: None,
        matrix_hidden: false,
    }
}

fn selection() -> Vec<McpSelection> {
    vec![McpSelection {
        source_id: "source".into(),
        name: "docs".into(),
        target_id: "target".into(),
    }]
}

/// 模型页写设置的方式：快照 → 文本级写入 → 备份 → 原子替换
fn gateway_write(path: &Path, edit: impl Fn(&str) -> String) {
    let state = atomicfile::read_state(path).unwrap();
    let text = match &state {
        FileState::Missing => String::new(),
        FileState::Present(snapshot) => String::from_utf8(snapshot.bytes.clone()).unwrap(),
    };
    if let FileState::Present(snapshot) = &state {
        atomicfile::backup(path, snapshot, "models").unwrap();
    }
    atomicfile::atomic_write(path, edit(&text).as_bytes(), &state).unwrap();
}

struct Tree {
    _dir: tempfile::TempDir,
    root: PathBuf,
    source: PathBuf,
    target: PathBuf,
}

fn tree() -> Tree {
    let dir = tempdir().unwrap();
    // macOS 上 /var 是软链；安全写入会拒绝父路径里的软链，两侧必须同源
    let root = fs::canonicalize(dir.path()).unwrap();
    let (source, target) = (root.join("source.toml"), root.join("config.toml"));
    fs::write(&source, "[mcp_servers.docs]\ncommand = \"docs\"\n").unwrap();
    fs::write(
        &target,
        "model = \"gpt-5.6-sol\"\n\n[mcp_servers.existing]\ncommand = \"x\"\n",
    )
    .unwrap();
    Tree {
        _dir: dir,
        root,
        source,
        target,
    }
}

/// AC15：模型页已启用，再用 MCP 同步一个服务器；两个根键仍在，MCP 也成功。之后恢复，MCP 配置仍在
#[test]
fn ac15_mcp_sync_after_gateway_enable_keeps_both() {
    let t = tree();
    let managed = managed(&t.root);
    gateway_write(&t.target, |text| {
        config::apply(text, &managed).unwrap().text
    });

    let locations = vec![location("source", &t.source), location("target", &t.target)];
    let report = execute(prepare(&locations, &selection()), false);
    assert_eq!(report.entries[0].outcome, "created");

    let text = fs::read_to_string(&t.target).unwrap();
    assert!(config::inspect(&text, &managed).unwrap().enabled, "{text}");
    assert!(text.contains("[mcp_servers.docs]"));

    gateway_write(&t.target, |text| {
        config::remove(text, &managed, false).unwrap().text
    });
    let text = fs::read_to_string(&t.target).unwrap();
    assert!(!text.contains("openai_base_url") && !text.contains("model_catalog_json"));
    assert!(text.contains("[mcp_servers.docs]") && text.contains("[mcp_servers.existing]"));
    // 两种备份各用各的名字，互不覆盖
    assert!(t.root.join("config.mcp.bak").exists() && t.root.join("config.models.bak").exists());
}

/// AC15 反向：先 MCP 同步，再启用模型页
#[test]
fn ac15_gateway_enable_after_mcp_sync_keeps_both() {
    let t = tree();
    let locations = vec![location("source", &t.source), location("target", &t.target)];
    assert_eq!(
        execute(prepare(&locations, &selection()), false).entries[0].outcome,
        "created"
    );
    let managed = managed(&t.root);
    gateway_write(&t.target, |text| {
        config::apply(text, &managed).unwrap().text
    });
    let text = fs::read_to_string(&t.target).unwrap();
    assert!(config::inspect(&text, &managed).unwrap().enabled);
    assert!(text.contains("[mcp_servers.docs]"));
}

/// AC16：MCP 预览之后模型页写了设置 → 应用该预览失败且不覆盖；重新预览后成功
#[test]
fn ac16_stale_mcp_preview_fails_without_overwriting_gateway_keys() {
    let t = tree();
    let locations = vec![location("source", &t.source), location("target", &t.target)];
    let stale = prepare(&locations, &selection());

    let managed = managed(&t.root);
    gateway_write(&t.target, |text| {
        config::apply(text, &managed).unwrap().text
    });
    let after_gateway = fs::read_to_string(&t.target).unwrap();

    let report = execute(stale, false);
    assert_eq!(report.entries[0].outcome, "failed");
    assert_eq!(
        fs::read_to_string(&t.target).unwrap(),
        after_gateway,
        "过期的预览不能覆盖模型页写入的内容"
    );

    let report = execute(prepare(&locations, &selection()), false);
    assert_eq!(report.entries[0].outcome, "created");
    let text = fs::read_to_string(&t.target).unwrap();
    assert!(
        config::inspect(&text, &managed).unwrap().enabled && text.contains("[mcp_servers.docs]")
    );
}

/// AC16 反向：模型页拿着旧快照去写，而 MCP 已经改过文件 → 拒绝，不覆盖
#[test]
fn ac16_stale_gateway_snapshot_is_refused() {
    let t = tree();
    let stale = atomicfile::read_state(&t.target).unwrap();
    let locations = vec![location("source", &t.source), location("target", &t.target)];
    assert_eq!(
        execute(prepare(&locations, &selection()), false).entries[0].outcome,
        "created"
    );
    let after_mcp = fs::read_to_string(&t.target).unwrap();
    let error =
        atomicfile::atomic_write(&t.target, b"model = \"clobbered\"\n", &stale).unwrap_err();
    assert_eq!(error.to_string(), "changed");
    assert_eq!(fs::read_to_string(&t.target).unwrap(), after_mcp);
}

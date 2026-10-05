//! Claude 桌面应用配置读写（spec 2026-09-29-claude-third-party-models R28–R34，AC29–AC32、AC34、
//! AC35 的 core 部分）：在临时目录里搭真实的 `Claude/`、`Claude-3p/` 文件树，走 读 → 算计划 → 按步写。
use serde_json::{json, Value};
use sophia_core::claude_models::desktop::{
    self, Desired, DesktopDirs, DesktopError, DesktopFile, DesktopFiles, DriftItem, Ours, Plan,
    RoleModel, FIRST_ROLE, HAIKU_ROLE, SOPHIA_PROFILE_ID,
};
use sophia_core::claude_models::settings::{Applied, Original, Phase};
use std::fs;
use std::path::{Path, PathBuf};

const TOKEN: &str = "sophia-test-token-0123456789abcdefghijklmnopqrstu";
const BASE_URL: &str = "http://127.0.0.1:47328/claude";
const CC_ID: &str = "00000000-0000-4000-8000-000000157210";
const CC_PROFILE: &str = "{\n  \"inferenceProvider\": \"gateway\",\n  \"inferenceGatewayBaseUrl\": \"http://127.0.0.1:15721/claude-desktop\",\n  \"inferenceGatewayApiKey\": \"ccs-1\",\n  \"disableDeploymentModeChooser\": true\n}\n";
const CC_META: &str = "{\n  \"entries\": [\n    {\n      \"id\": \"00000000-0000-4000-8000-000000157210\",\n      \"name\": \"Other Tool\"\n    }\n  ],\n  \"appliedId\": \"00000000-0000-4000-8000-000000157210\"\n}";

fn golden(name: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/data/claude-desktop")
            .join(name),
    )
    .unwrap()
}

/// `~/Library/Application Support` 的替身：临时目录，已 canonicalize
struct Lab {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    dirs: DesktopDirs,
    /// Sophia 的备份目录替身：另一个临时目录，不混进 `root` 的文件树
    _backups_tmp: tempfile::TempDir,
    backups: PathBuf,
}

impl Lab {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let dirs = DesktopDirs::new(&root);
        let backups_tmp = tempfile::tempdir().unwrap();
        let backups = fs::canonicalize(backups_tmp.path())
            .unwrap()
            .join("backups");
        Self {
            _tmp: tmp,
            root,
            dirs,
            _backups_tmp: backups_tmp,
            backups,
        }
    }

    fn path(&self, file: DesktopFile) -> PathBuf {
        self.dirs.path(file)
    }

    /// 这个文件在备份目录里的全部备份（按序号先后）；没有备份过为空
    fn backups_of(&self, path: &Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(sophia_core::atomicfile::backup_dir(&self.backups, path))
        else {
            return Vec::new();
        };
        let mut baks: Vec<PathBuf> = entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "bak"))
            .collect();
        baks.sort();
        baks
    }

    fn put(&self, file: DesktopFile, bytes: &[u8]) {
        let path = self.path(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn put_profile(&self, id: &str, bytes: &str) {
        let path = self
            .root
            .join("Claude-3p/configLibrary")
            .join(format!("{id}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn profile_of(&self, id: &str) -> Option<Vec<u8>> {
        fs::read(
            self.root
                .join("Claude-3p/configLibrary")
                .join(format!("{id}.json")),
        )
        .ok()
    }

    fn get(&self, file: DesktopFile) -> Option<Vec<u8>> {
        fs::read(self.path(file)).ok()
    }

    fn text(&self, file: DesktopFile) -> String {
        String::from_utf8(self.get(file).expect("file exists")).unwrap()
    }

    fn json(&self, file: DesktopFile) -> Value {
        serde_json::from_slice(&self.get(file).expect("file exists")).unwrap()
    }

    /// 四个文件现在的字节（不存在为 None）
    fn four(&self) -> Vec<Option<Vec<u8>>> {
        DesktopFile::ALL.iter().map(|f| self.get(*f)).collect()
    }

    /// 整棵树里的文件（相对路径 → 字节），用来断言「什么都没写、没留备份」
    fn tree(&self) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let path = entry.unwrap().path();
                let meta = fs::symlink_metadata(&path).unwrap();
                if meta.is_dir() {
                    walk(&path, root, out);
                } else {
                    let rel = path.strip_prefix(root).unwrap().display().to_string();
                    out.push((rel, fs::read(&path).unwrap_or_default()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &self.root, &mut out);
        out.sort();
        out
    }

    fn files(&self, record: Option<&Applied>) -> DesktopFiles {
        desktop::read(&self.dirs, record).unwrap().files().clone()
    }

    /// 打开方向：读 → 算 → 全部写完，记录的 phase 改为 done
    fn open(&self, desired: &Desired, previous: Option<&Applied>) -> Applied {
        let snapshot = desktop::read(&self.dirs, previous).unwrap();
        let plan = desktop::plan_apply(snapshot.files(), desired, previous).unwrap();
        desktop::execute(&self.dirs, &snapshot, &plan, &self.backups).unwrap();
        Applied {
            phase: Phase::Done,
            ..plan.record
        }
    }

    /// 切回方向：读 → 算 → 全部写完，返回计划（看提示）
    fn close(&self, record: &Applied) -> Plan {
        let snapshot = desktop::read(&self.dirs, Some(record)).unwrap();
        let plan = desktop::plan_restore(snapshot.files(), record, TOKEN).unwrap();
        desktop::execute(&self.dirs, &snapshot, &plan, &self.backups).unwrap();
        plan
    }

    fn inspect(&self, record: Option<&Applied>) -> desktop::Inspection {
        let files = self.files(record);
        desktop::inspect(
            &files,
            &Ours {
                token: TOKEN,
                base_url: BASE_URL,
                record,
            },
        )
        .unwrap()
    }
}

fn model(slug: &str, label: &str) -> RoleModel {
    RoleModel {
        slug: slug.into(),
        label: label.into(),
    }
}

/// 已选两个（按选择顺序）：第一个写 `claude-sonnet-5`，最后一个写 `claude-haiku-4-5`
fn desired() -> Desired {
    Desired {
        base_url: BASE_URL.into(),
        token: TOKEN.into(),
        models: vec![
            model("ap-kimi-k3", "Kimi K3"),
            model("ap-glm-5", "glm-5 · AP"),
        ],
        takeover: false,
    }
}

fn takeover() -> Desired {
    Desired {
        takeover: true,
        ..desired()
    }
}

fn mode(lab: &Lab, file: DesktopFile) -> Value {
    lab.json(file)["deploymentMode"].clone()
}

fn account_mode(lab: &Lab) {
    lab.put(DesktopFile::Meta, b"{\"entries\": []}");
    lab.put(
        DesktopFile::Claude3pConfig,
        b"{\n  \"enterpriseConfig\": {},\n  \"deploymentMode\": \"1p\"\n}\n",
    );
    lab.put(
        DesktopFile::ClaudeConfig,
        b"{\n  \"mcpServers\": {},\n  \"deploymentMode\":  \"1p\",\n  \"preferences\": {\"a\": 1}\n}\n",
    );
}

fn other_config(lab: &Lab) {
    lab.put(DesktopFile::Meta, CC_META.as_bytes());
    lab.put_profile(CC_ID, CC_PROFILE);
    lab.put(
        DesktopFile::Claude3pConfig,
        b"{\"deploymentMode\":\"3p\",\"preferences\":{}}",
    );
    lab.put(
        DesktopFile::ClaudeConfig,
        b"{\n  \"deploymentMode\": \"3p\"\n}\n",
    );
}

// ───────────────────────── 打开：四个文件写成什么（AC30–AC32） ─────────────────────────

/// AC30：profile 不存在时新建为恰好六个键、0600；`inferenceModels` 按已选顺序逐项、名字；不写 disableDeploymentModeChooser
#[test]
fn opening_on_a_bare_machine_creates_all_four_files() {
    let lab = Lab::new();
    let record = lab.open(&desired(), None);

    assert_eq!(
        lab.get(DesktopFile::Profile).unwrap(),
        golden("profile-new.json")
    );
    let profile = lab.json(DesktopFile::Profile);
    assert_eq!(profile.as_object().unwrap().len(), 6);
    assert!(profile.get("disableDeploymentModeChooser").is_none());
    assert_eq!(
        profile["inferenceModels"],
        desktop::inference_models(&["Kimi K3", "glm-5 · AP"])
    );
    let names: Vec<&str> = profile["inferenceModels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, [FIRST_ROLE, HAIKU_ROLE]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(lab.path(DesktopFile::Profile))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir = fs::metadata(lab.root.join("Claude-3p/configLibrary"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(dir & 0o777, 0o700);
    }

    assert_eq!(
        lab.text(DesktopFile::Meta),
        format!(
            "{{\"entries\":[{{\"id\":\"{SOPHIA_PROFILE_ID}\",\"name\":\"Sophia\"}}],\"appliedId\":\"{SOPHIA_PROFILE_ID}\"}}"
        )
    );
    assert_eq!(
        lab.text(DesktopFile::Claude3pConfig),
        "{\"deploymentMode\":\"3p\"}"
    );
    assert_eq!(
        lab.text(DesktopFile::ClaudeConfig),
        "{\"deploymentMode\":\"3p\"}"
    );

    assert_eq!(record.originals.applied_id, Original::FileAbsent);
    assert_eq!(record.originals.entries, Original::FileAbsent);
    assert_eq!(record.originals.claude_3p_mode, Original::FileAbsent);
    assert_eq!(record.originals.claude_mode, Original::FileAbsent);
    assert!(record.profile_created && record.entry_added && record.written.chat_tab_written);
    assert_eq!(record.written.base_url, BASE_URL);
    assert_eq!(record.written.models, desired().models());
    // 令牌不进记录：profile 里存占位
    assert_eq!(record.written.profile["inferenceGatewayApiKey"], "<token>");
    assert!(!serde_json::to_string(&record).unwrap().contains(TOKEN));
    // 新建的文件没有可备份的原文；原文件旁边也不留备份
    assert!(!lab.tree().iter().any(|(name, _)| name.ends_with(".bak")));
    assert!(!lab.backups.exists());
}

/// AC30：profile 已存在且被用户在配置窗口里加了键、关了 Chat：改已选后重写只动 inferenceModels
#[test]
fn rewriting_an_existing_profile_touches_only_sophias_keys() {
    let lab = Lab::new();
    let record = lab.open(&desired(), None);
    let edited = lab.text(DesktopFile::Profile).replace(
        "\"chatTabEnabled\": true\n}",
        "\"chatTabEnabled\": false,\n  \"managedMcpServers\": [{\"name\": \"docs\", \"url\": \"https://mcp.example/docs\"}]\n}",
    );
    lab.put(DesktopFile::Profile, edited.as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            lab.path(DesktopFile::Profile),
            fs::Permissions::from_mode(0o640),
        )
        .unwrap();
    }

    let changed = Desired {
        models: vec![
            model("or-deepseek-v4", "DeepSeek V4"),
            model("ap-glm-5", "glm-5 · AP"),
        ],
        ..desired()
    };
    let record = lab.open(&changed, Some(&record));

    let expected = edited.replace(
        "[{\"name\": \"claude-sonnet-5\", \"labelOverride\": \"Kimi K3\"}",
        "[{\"name\": \"claude-sonnet-5\", \"labelOverride\": \"DeepSeek V4\"}",
    );
    assert_eq!(lab.text(DesktopFile::Profile), expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(lab.path(DesktopFile::Profile))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o640, "改写保持原权限");
    }
    // 用户关掉的 Chat 不改回；记录里仍认 chatTabEnabled 是 Sophia 补上过的
    assert!(record.written.chat_tab_written);
    assert_eq!(record.written.profile["chatTabEnabled"], false);
    assert_eq!(record.written.models, changed.models());
    // 原值沿用第一次记下的
    assert_eq!(record.originals.applied_id, Original::FileAbsent);
    // 改 Sophia 自己的 profile 不留备份（内含令牌）
    assert!(lab.backups_of(&lab.path(DesktopFile::Profile)).is_empty());
    assert!(!lab.tree().iter().any(|(name, _)| name.ends_with(".bak")));
}

/// profile 已存在（例如上次留下的）且缺几个键：补在末尾，缩进跟随原文；已有 chatTabEnabled 不动
#[test]
fn missing_managed_keys_are_appended_following_the_files_indent() {
    let lab = Lab::new();
    lab.put(
        DesktopFile::Profile,
        b"{\n    \"inferenceProvider\": \"bedrock\",\n    \"chatTabEnabled\": false\n}\n",
    );
    let record = lab.open(&desired(), None);
    let text = lab.text(DesktopFile::Profile);
    assert!(text.starts_with("{\n    \"inferenceProvider\": \"gateway\",\n    \"chatTabEnabled\": false,\n    \"inferenceGatewayBaseUrl\": "), "{text}");
    assert_eq!(lab.json(DesktopFile::Profile)["chatTabEnabled"], false);
    assert!(!record.profile_created);
    assert!(!record.written.chat_tab_written);
}

/// AC31：`_meta.json` 不存在 / 空 entries / 别家配置生效（接管）：Sophia 条目恰一条、appliedId 是 Sophia，
/// 别家的条目与 profile 逐字节不变
#[test]
fn meta_gets_exactly_one_sophia_entry_and_points_at_it() {
    for initial in [None, Some("{\"entries\":[]}"), Some(CC_META)] {
        let lab = Lab::new();
        if let Some(meta) = initial {
            lab.put(DesktopFile::Meta, meta.as_bytes());
        }
        lab.put_profile(CC_ID, CC_PROFILE);
        lab.open(&takeover(), None);
        let meta = lab.json(DesktopFile::Meta);
        let sophia: Vec<&Value> = meta["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["id"] == SOPHIA_PROFILE_ID)
            .collect();
        assert_eq!(
            sophia,
            [&json!({"id": SOPHIA_PROFILE_ID, "name": "Sophia"})],
            "{initial:?}"
        );
        assert_eq!(meta["appliedId"], SOPHIA_PROFILE_ID);
        assert_eq!(lab.profile_of(CC_ID).unwrap(), CC_PROFILE.as_bytes());
        if initial == Some(CC_META) {
            assert_eq!(
                meta["entries"][0],
                json!({"id": CC_ID, "name": "Other Tool"})
            );
        }
    }
}

/// 已有 Sophia 条目（名字被改过）：不再加一条、不改名字
#[test]
fn an_existing_sophia_entry_is_left_as_is() {
    let lab = Lab::new();
    let meta =
        format!("{{\"entries\":[{{\"id\":\"{SOPHIA_PROFILE_ID}\",\"name\":\"我的网关\"}}]}}");
    lab.put(DesktopFile::Meta, meta.as_bytes());
    let record = lab.open(&desired(), None);
    assert!(!record.entry_added);
    assert_eq!(
        lab.text(DesktopFile::Meta),
        format!("{{\"entries\":[{{\"id\":\"{SOPHIA_PROFILE_ID}\",\"name\":\"我的网关\"}}],\"appliedId\":\"{SOPHIA_PROFILE_ID}\"}}")
    );
}

/// AC32：一份含 mcpServers 与 preferences、4 空格缩进、CRLF，一份不存在：两处都是 "3p"，其余字节不变，
/// 新成员的缩进与换行跟随原文，不存在的那份被建出；改写前的原文留一份备份
#[test]
fn deployment_mode_is_written_in_both_places_following_each_files_layout() {
    let lab = Lab::new();
    lab.put(
        DesktopFile::ClaudeConfig,
        &golden("claude-config-crlf.json"),
    );
    lab.open(&desired(), None);
    assert_eq!(
        lab.get(DesktopFile::ClaudeConfig).unwrap(),
        golden("claude-config-crlf.3p.json")
    );
    assert_eq!(
        lab.text(DesktopFile::Claude3pConfig),
        "{\"deploymentMode\":\"3p\"}"
    );
    // 备份在 Sophia 的备份目录里，原文件旁边没有
    let baks = lab.backups_of(&lab.path(DesktopFile::ClaudeConfig));
    assert_eq!(baks.len(), 1, "{baks:?}");
    assert!(baks[0].to_string_lossy().ends_with("-sophia-models.bak"));
    assert_eq!(
        fs::read(&baks[0]).unwrap(),
        golden("claude-config-crlf.json")
    );
    assert!(!lab.tree().iter().any(|(name, _)| name.ends_with(".bak")));
}

/// 文件开头的 BOM 原样保留
#[test]
fn a_byte_order_mark_is_kept() {
    let lab = Lab::new();
    lab.put(
        DesktopFile::ClaudeConfig,
        b"\xEF\xBB\xBF{\"deploymentMode\": \"1p\"}",
    );
    let record = lab.open(&desired(), None);
    assert_eq!(
        lab.get(DesktopFile::ClaudeConfig).unwrap(),
        b"\xEF\xBB\xBF{\"deploymentMode\": \"3p\"}"
    );
    lab.close(&record);
    assert_eq!(
        lab.get(DesktopFile::ClaudeConfig).unwrap(),
        b"\xEF\xBB\xBF{\"deploymentMode\": \"1p\"}"
    );
}

/// 已经是目标内容的文件不写（没有步骤，也不留备份）
#[test]
fn opening_twice_writes_nothing_the_second_time() {
    let lab = Lab::new();
    account_mode(&lab);
    let record = lab.open(&desired(), None);
    let before = lab.tree();
    let files = lab.files(Some(&record));
    let plan = desktop::plan_apply(&files, &desired(), Some(&record)).unwrap();
    assert!(plan.steps.is_empty(), "{:?}", plan.steps);
    assert_eq!(plan.record.originals, record.originals);
    assert_eq!(lab.tree(), before);
}

/// R32：打开方向的顺序是 profile → _meta.json → Claude-3p → Claude；切回反过来
#[test]
fn steps_are_ordered_so_deployment_mode_is_last_in_and_first_out() {
    let lab = Lab::new();
    account_mode(&lab);
    let files = lab.files(None);
    let plan = desktop::plan_apply(&files, &desired(), None).unwrap();
    let order: Vec<DesktopFile> = plan.steps.iter().map(|s| s.file).collect();
    assert_eq!(
        order,
        [
            DesktopFile::Profile,
            DesktopFile::Meta,
            DesktopFile::Claude3pConfig,
            DesktopFile::ClaudeConfig
        ]
    );
    assert_eq!(plan.record.phase, Phase::Writing);

    let record = lab.open(&desired(), None);
    let files = lab.files(Some(&record));
    let plan = desktop::plan_restore(&files, &record, TOKEN).unwrap();
    let order: Vec<DesktopFile> = plan.steps.iter().map(|s| s.file).collect();
    assert_eq!(
        order,
        [
            DesktopFile::ClaudeConfig,
            DesktopFile::Claude3pConfig,
            DesktopFile::Meta,
            DesktopFile::Profile
        ]
    );
    assert_eq!(plan.record.phase, Phase::Restoring);
    assert!(plan.steps[3].after.is_none(), "profile 被删");
}

// ───────────────────────── 切回：按原值还原（AC34） ─────────────────────────

/// 账户模式（两处 "1p"、无 appliedId）：打开紧接着切回，四个文件与原文逐字节相同，profile 被删
#[test]
fn account_mode_round_trips_byte_for_byte() {
    let lab = Lab::new();
    account_mode(&lab);
    let before = lab.four();
    let record = lab.open(&desired(), None);
    assert_eq!(record.originals.applied_id, Original::Absent);
    assert_eq!(record.originals.claude_mode, Original::Raw("\"1p\"".into()));
    let plan = lab.close(&record);
    assert!(plan.warnings.is_empty());
    assert_eq!(lab.four(), before);
    assert!(lab.get(DesktopFile::Profile).is_none());
}

/// 两处都没有 deploymentMode：切回写 "1p"（不删键），其余字节同原文
#[test]
fn a_missing_deployment_mode_is_restored_as_1p() {
    let lab = Lab::new();
    lab.put(DesktopFile::Meta, b"{\"entries\": []}");
    lab.put(
        DesktopFile::Claude3pConfig,
        b"{\n  \"enterpriseConfig\": {}\n}\n",
    );
    lab.put(
        DesktopFile::ClaudeConfig,
        &golden("claude-config-crlf.json"),
    );
    let record = lab.open(&desired(), None);
    assert_eq!(record.originals.claude_3p_mode, Original::Absent);
    lab.close(&record);
    assert_eq!(
        lab.text(DesktopFile::Claude3pConfig),
        "{\n  \"enterpriseConfig\": {},\n  \"deploymentMode\": \"1p\"\n}\n"
    );
    assert_eq!(
        lab.get(DesktopFile::ClaudeConfig).unwrap(),
        golden("claude-config-crlf.1p.json")
    );
    assert_eq!(lab.text(DesktopFile::Meta), "{\"entries\": []}");
}

/// 四个文件原来都没有：切回后两处 config 是 "1p"，Sophia 建的 _meta.json 与 profile 都删掉
#[test]
fn files_that_did_not_exist_come_back_as_1p_configs_only() {
    let lab = Lab::new();
    let record = lab.open(&desired(), None);
    lab.close(&record);
    assert!(lab.get(DesktopFile::Profile).is_none());
    assert!(lab.get(DesktopFile::Meta).is_none());
    assert_eq!(mode(&lab, DesktopFile::Claude3pConfig), "1p");
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "1p");
}

/// 别家配置生效（两处 "3p"、appliedId 是它）：接管再切回，两处仍 "3p"、appliedId 回到它，
/// 它的 profile 全程逐字节不变
#[test]
fn taking_over_and_switching_back_hands_control_back_to_the_other_tool() {
    let lab = Lab::new();
    other_config(&lab);
    let before = lab.four();
    let record = lab.open(&takeover(), None);
    assert_eq!(lab.json(DesktopFile::Meta)["appliedId"], SOPHIA_PROFILE_ID);
    assert_eq!(
        record.originals.applied_id,
        Original::Raw(format!("\"{CC_ID}\""))
    );
    lab.close(&record);
    assert_eq!(lab.four(), before);
    assert_eq!(lab.profile_of(CC_ID).unwrap(), CC_PROFILE.as_bytes());
}

/// 原来指向的那份 profile 已被删：切回不改指它，删掉 appliedId
#[test]
fn applied_id_is_removed_when_the_original_profile_is_gone() {
    let lab = Lab::new();
    other_config(&lab);
    let record = lab.open(&takeover(), None);
    fs::remove_file(
        lab.root
            .join(format!("Claude-3p/configLibrary/{CC_ID}.json")),
    )
    .unwrap();
    lab.close(&record);
    let meta = lab.json(DesktopFile::Meta);
    assert!(meta.get("appliedId").is_none(), "{meta}");
    assert_eq!(
        meta["entries"],
        json!([{"id": CC_ID, "name": "Other Tool"}])
    );
}

/// 开着时用户在配置窗口里改了 profile：切回时 profile 与条目保留，appliedId 照样还原，带一条提示
#[test]
fn a_profile_changed_by_the_user_is_kept_on_switch_back() {
    let lab = Lab::new();
    account_mode(&lab);
    let meta_before = lab.get(DesktopFile::Meta);
    let record = lab.open(&desired(), None);
    let edited = lab
        .text(DesktopFile::Profile)
        .replace("Kimi K3", "我自己的名字");
    lab.put(DesktopFile::Profile, edited.as_bytes());

    let plan = lab.close(&record);
    assert_eq!(lab.text(DesktopFile::Profile), edited);
    let meta = lab.json(DesktopFile::Meta);
    assert!(meta.get("appliedId").is_none());
    assert_eq!(
        meta["entries"],
        json!([{"id": SOPHIA_PROFILE_ID, "name": "Sophia"}])
    );
    assert_ne!(lab.get(DesktopFile::Meta), meta_before);
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "1p");
    assert_eq!(plan.warnings.len(), 1);
    assert!(plan.warnings[0].contains("被改过"), "{:?}", plan.warnings);
}

/// 开着时别家把 appliedId 改成了它的：切回时两处 deploymentMode 与 appliedId 都不动，
/// 只删仍是 Sophia 写的 profile 并摘掉条目
#[test]
fn when_another_tool_took_over_meanwhile_only_sophias_profile_goes() {
    let lab = Lab::new();
    account_mode(&lab);
    let record = lab.open(&desired(), None);
    lab.put_profile(CC_ID, CC_PROFILE);
    let meta = format!(
        "{{\"entries\":[{{\"id\":\"{SOPHIA_PROFILE_ID}\",\"name\":\"Sophia\"}},{{\"id\":\"{CC_ID}\",\"name\":\"Other Tool\"}}],\"appliedId\":\"{CC_ID}\"}}"
    );
    lab.put(DesktopFile::Meta, meta.as_bytes());

    lab.close(&record);
    assert_eq!(mode(&lab, DesktopFile::Claude3pConfig), "3p");
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "3p");
    assert!(lab.get(DesktopFile::Profile).is_none());
    assert_eq!(
        lab.json(DesktopFile::Meta),
        json!({"entries": [{"id": CC_ID, "name": "Other Tool"}], "appliedId": CC_ID})
    );
    assert_eq!(lab.profile_of(CC_ID).unwrap(), CC_PROFILE.as_bytes());
}

// ───────────────────────── 中途失败、崩溃与重入（R32） ─────────────────────────

/// 打开时在第 2、3、4 步失败：同一动作里按切回撤回，四个文件与原文逐字节相同
#[test]
fn a_failed_open_is_undone_in_the_same_action() {
    for written in 1..4 {
        let lab = Lab::new();
        account_mode(&lab);
        let before = lab.four();
        let snapshot = desktop::read(&lab.dirs, None).unwrap();
        let plan = desktop::plan_apply(snapshot.files(), &desired(), None).unwrap();
        for step in &plan.steps[..written] {
            desktop::apply_step(&lab.dirs, &snapshot, step, &lab.backups).unwrap();
        }
        // 第 written+1 步失败：Sophia 还活着，用记下的原值撤回
        lab.close(&plan.record);
        assert_eq!(lab.four(), before, "failed after {written} steps");
    }
}

/// 进程在写完 _meta.json 后没了：两处 deploymentMode 仍是原值，状态显出 drift；
/// 再执行一次打开补完，结果与一次成功的打开逐字节相同，原值仍是第一次采集的
#[test]
fn a_crash_midway_is_rolled_forward_to_the_same_result() {
    let lab = Lab::new();
    account_mode(&lab);
    let snapshot = desktop::read(&lab.dirs, None).unwrap();
    let plan = desktop::plan_apply(snapshot.files(), &desired(), None).unwrap();
    for step in &plan.steps[..2] {
        desktop::apply_step(&lab.dirs, &snapshot, step, &lab.backups).unwrap();
    }
    let crashed = plan.record;
    assert_eq!(crashed.phase, Phase::Writing);
    assert_eq!(mode(&lab, DesktopFile::Claude3pConfig), "1p");
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "1p");
    let seen = lab.inspect(Some(&crashed));
    assert_eq!(
        seen.drift,
        [
            DriftItem::Mode(DesktopFile::Claude3pConfig),
            DriftItem::Mode(DesktopFile::ClaudeConfig)
        ]
    );

    let record = lab.open(&desired(), Some(&crashed));
    assert_eq!(record.originals, crashed.originals);

    let clean = Lab::new();
    account_mode(&clean);
    let clean_record = clean.open(&desired(), None);
    assert_eq!(lab.four(), clean.four());
    assert_eq!(record, clean_record);
}

/// 崩溃后、前滚前有人改了 _meta.json：不覆盖，报 changed
#[test]
fn rolling_forward_refuses_to_overwrite_a_file_changed_by_someone_else() {
    let lab = Lab::new();
    account_mode(&lab);
    let snapshot = desktop::read(&lab.dirs, None).unwrap();
    let plan = desktop::plan_apply(snapshot.files(), &desired(), None).unwrap();
    for step in &plan.steps[..2] {
        desktop::apply_step(&lab.dirs, &snapshot, step, &lab.backups).unwrap();
    }
    lab.put_profile(CC_ID, CC_PROFILE);
    let meta = format!(
        "{{\"entries\":[{{\"id\":\"{CC_ID}\",\"name\":\"Other Tool\"}}],\"appliedId\":\"{CC_ID}\"}}"
    );
    lab.put(DesktopFile::Meta, meta.as_bytes());
    let before = lab.four();

    let files = lab.files(Some(&plan.record));
    let error = desktop::plan_apply(&files, &takeover(), Some(&plan.record)).unwrap_err();
    assert!(
        matches!(
            error,
            DesktopError::Changed {
                file: DesktopFile::Meta
            }
        ),
        "{error:?}"
    );
    assert_eq!(error.code(), "changed");
    assert_eq!(lab.four(), before);
}

/// 同一动作里读完快照之后文件被别人改了：这一步不覆盖，报 changed
#[test]
fn a_file_changed_after_the_snapshot_is_not_overwritten() {
    let lab = Lab::new();
    account_mode(&lab);
    let snapshot = desktop::read(&lab.dirs, None).unwrap();
    let plan = desktop::plan_apply(snapshot.files(), &desired(), None).unwrap();
    lab.put(DesktopFile::Meta, b"{\"entries\": [], \"other\": 1}");
    let error = desktop::execute(&lab.dirs, &snapshot, &plan, &lab.backups).unwrap_err();
    assert!(
        matches!(
            error,
            DesktopError::Changed {
                file: DesktopFile::Meta
            }
        ),
        "{error:?}"
    );
    assert_eq!(
        lab.text(DesktopFile::Meta),
        "{\"entries\": [], \"other\": 1}"
    );
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "1p");
}

/// 切回做到一半（只写了第一处 deploymentMode）：再做一次切回补完，结果与一次做完相同
#[test]
fn an_interrupted_switch_back_is_finished_by_running_it_again() {
    let lab = Lab::new();
    account_mode(&lab);
    let before = lab.four();
    let record = lab.open(&desired(), None);
    let snapshot = desktop::read(&lab.dirs, Some(&record)).unwrap();
    let plan = desktop::plan_restore(snapshot.files(), &record, TOKEN).unwrap();
    desktop::apply_step(&lab.dirs, &snapshot, &plan.steps[0], &lab.backups).unwrap();
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "1p");
    assert_eq!(mode(&lab, DesktopFile::Claude3pConfig), "3p");

    let restoring = plan.record;
    assert_eq!(restoring.phase, Phase::Restoring);
    lab.close(&restoring);
    assert_eq!(lab.four(), before);
    // 已经做完的切回再做一次什么都不写
    let files = lab.files(Some(&restoring));
    assert!(desktop::plan_restore(&files, &restoring, TOKEN)
        .unwrap()
        .steps
        .is_empty());
}

// ───────────────────────── 别家配置在生效（R35） ─────────────────────────

/// AC36 的 core 部分：别家生效且不允许接管 → foreign_config，带它的 id（不带名字），什么都不写
#[test]
fn another_tools_active_config_blocks_opening_without_takeover() {
    let lab = Lab::new();
    other_config(&lab);
    let before = lab.tree();
    let files = lab.files(None);
    let error = desktop::plan_apply(&files, &desired(), None).unwrap_err();
    match &error {
        DesktopError::Foreign(foreign) => {
            assert_eq!(foreign.id, CC_ID);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(error.code(), "foreign_config");
    assert_eq!(lab.tree(), before);
}

/// appliedId 指向的 profile 不存在、或里面没有 inferenceProvider：不算别家生效
#[test]
fn a_dangling_or_empty_applied_profile_is_not_foreign() {
    let lab = Lab::new();
    lab.put(
        DesktopFile::Meta,
        format!("{{\"appliedId\":\"{CC_ID}\"}}").as_bytes(),
    );
    assert!(lab.inspect(None).foreign.is_none());
    lab.put_profile(CC_ID, "{\"chatTabEnabled\": true}");
    assert!(lab.inspect(None).foreign.is_none());
    lab.put_profile(CC_ID, CC_PROFILE);
    let foreign = lab.inspect(None).foreign.unwrap();
    assert_eq!(foreign.id, CC_ID);
}

/// appliedId 不像文件名（带路径分隔符等）：不去读它
#[test]
fn an_applied_id_that_is_not_a_plain_name_is_never_read() {
    let lab = Lab::new();
    fs::create_dir_all(lab.root.join("Claude-3p")).unwrap();
    fs::write(lab.root.join("Claude-3p/evil.json"), CC_PROFILE).unwrap();
    lab.put(DesktopFile::Meta, b"{\"appliedId\":\"../evil\"}");
    assert!(lab.files(None).others.is_empty());
    assert!(lab.inspect(None).foreign.is_none());
}

/// 开着之后别家又把指向改走：再接管时原值沿用第一次记下的
#[test]
fn taking_over_again_keeps_the_first_originals() {
    let lab = Lab::new();
    account_mode(&lab);
    let record = lab.open(&desired(), None);
    other_config(&lab);
    let files = lab.files(Some(&record));
    assert!(matches!(
        desktop::plan_apply(&files, &desired(), Some(&record)),
        Err(DesktopError::Foreign(_))
    ));
    let again = lab.open(&takeover(), Some(&record));
    assert_eq!(again.originals, record.originals);
    assert_eq!(lab.json(DesktopFile::Meta)["appliedId"], SOPHIA_PROFILE_ID);
}

// ───────────────────────── 拒绝写（R28，AC29） ─────────────────────────

fn assert_invalid(lab: &Lab, file: DesktopFile) {
    let before = lab.tree();
    let error = match desktop::read(&lab.dirs, None) {
        Err(error) => error,
        Ok(snapshot) => desktop::plan_apply(snapshot.files(), &takeover(), None).unwrap_err(),
    };
    match &error {
        DesktopError::Invalid { file: at, .. } => assert_eq!(*at, file, "{error}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(error.code(), "invalid");
    assert_eq!(lab.tree(), before, "什么都没写、没有备份");
}

#[test]
fn malformed_files_are_refused_without_writing_anything() {
    let cases: &[(DesktopFile, &[u8])] = &[
        (DesktopFile::Meta, b"{\"entries\": [}"),
        (DesktopFile::Meta, b"\xFF\xFE{}"),
        (
            DesktopFile::Meta,
            b"{\"appliedId\": \"a\", \"appliedId\": \"b\"}",
        ),
        (DesktopFile::Meta, b"[]"),
        (DesktopFile::Meta, b"{\"entries\": {}}"),
        (DesktopFile::Meta, b"{\"appliedId\": 7}"),
        (DesktopFile::ClaudeConfig, b"{\"deploymentMode\": 3}"),
        (DesktopFile::Claude3pConfig, b"{\"deploymentMode\": null}"),
        (DesktopFile::Profile, b"not json"),
    ];
    for (file, bytes) in cases {
        let lab = Lab::new();
        account_mode(&lab);
        lab.put(*file, bytes);
        assert_invalid(&lab, *file);
    }
}

#[cfg(unix)]
#[test]
fn a_symlinked_file_or_directory_is_refused() {
    use std::os::unix::fs::symlink;
    // 文件本身是软链
    let lab = Lab::new();
    account_mode(&lab);
    let real = lab.root.join("elsewhere.json");
    fs::write(&real, "{\"deploymentMode\": \"1p\"}").unwrap();
    fs::remove_file(lab.path(DesktopFile::ClaudeConfig)).unwrap();
    symlink(&real, lab.path(DesktopFile::ClaudeConfig)).unwrap();
    assert_invalid(&lab, DesktopFile::ClaudeConfig);

    // 所在目录是软链（profile 与 _meta.json 都在它下面）
    let lab = Lab::new();
    let real = lab.root.join("real-3p");
    fs::create_dir_all(real.join("configLibrary")).unwrap();
    symlink(&real, lab.root.join("Claude-3p")).unwrap();
    assert_invalid(&lab, DesktopFile::Profile);

    // 路径是目录
    let lab = Lab::new();
    fs::create_dir_all(lab.path(DesktopFile::Meta)).unwrap();
    assert_invalid(&lab, DesktopFile::Meta);
}

/// 切回时文件不合法同样拒绝，什么都不写
#[test]
fn switching_back_over_a_malformed_file_is_refused() {
    let lab = Lab::new();
    account_mode(&lab);
    let record = lab.open(&desired(), None);
    lab.put(DesktopFile::ClaudeConfig, b"{\"deploymentMode\": \"3p\",}");
    let before = lab.tree();
    let files = lab.files(Some(&record));
    let error = desktop::plan_restore(&files, &record, TOKEN).unwrap_err();
    assert!(matches!(
        error,
        DesktopError::Invalid {
            file: DesktopFile::ClaudeConfig,
            ..
        }
    ));
    assert_eq!(lab.tree(), before);
}

// ───────────────────────── 状态判定（R34 的 core 部分） ─────────────────────────

#[test]
fn inspection_reports_what_is_ours_and_what_drifted() {
    let lab = Lab::new();
    account_mode(&lab);
    let seen = lab.inspect(None);
    assert_eq!(seen.applied_id, None);
    assert_eq!(seen.modes, [Some("1p".to_owned()), Some("1p".to_owned())]);
    assert!(seen.drift.is_empty() && !seen.unrecorded_ours && !seen.sophia_profile_matches);

    let record = lab.open(&desired(), None);
    let seen = lab.inspect(Some(&record));
    assert_eq!(seen.applied_id.as_deref(), Some(SOPHIA_PROFILE_ID));
    assert!(seen.foreign.is_none());
    assert!(seen.drift.is_empty(), "{:?}", seen.drift);
    assert!(seen.sophia_profile_matches);
    assert_eq!(seen.modes, [Some("3p".to_owned()), Some("3p".to_owned())]);

    // 令牌被改
    let original = lab.text(DesktopFile::Profile);
    lab.put(
        DesktopFile::Profile,
        original.replace(TOKEN, "sophia-other").as_bytes(),
    );
    let seen = lab.inspect(Some(&record));
    assert_eq!(
        seen.drift,
        [DriftItem::ProfileKey("inferenceGatewayApiKey")]
    );
    assert!(!seen.sophia_profile_matches);

    // profile 被删、appliedId 被改、一处 deploymentMode 变 "1p"
    fs::remove_file(lab.path(DesktopFile::Profile)).unwrap();
    lab.put(
        DesktopFile::Meta,
        b"{\"entries\":[],\"appliedId\":\"someone\"}",
    );
    let config = lab
        .text(DesktopFile::ClaudeConfig)
        .replace("\"3p\"", "\"1p\"");
    lab.put(DesktopFile::ClaudeConfig, config.as_bytes());
    let seen = lab.inspect(Some(&record));
    assert_eq!(
        seen.drift,
        [
            DriftItem::ProfileMissing,
            DriftItem::AppliedId,
            DriftItem::Mode(DesktopFile::ClaudeConfig)
        ]
    );
    // 用户在配置窗口里关掉 Chat 不算被改掉
    let lab = Lab::new();
    let record = lab.open(&desired(), None);
    let off = lab
        .text(DesktopFile::Profile)
        .replace("\"chatTabEnabled\": true", "\"chatTabEnabled\": false");
    lab.put(DesktopFile::Profile, off.as_bytes());
    assert!(lab.inspect(Some(&record)).drift.is_empty());
}

/// 换过端口：设置丢了时，Sophia 在 47328–47339 任一端口写下的文件都认得；范围外的不认
#[test]
fn files_written_for_another_port_in_the_range_are_still_ours() {
    for (port, ours) in [(47331, true), (47340, false)] {
        let lab = Lab::new();
        account_mode(&lab);
        lab.open(
            &Desired {
                base_url: desktop::base_url(port),
                ..desired()
            },
            None,
        );
        assert_eq!(lab.inspect(None).unrecorded_ours, ours, "port {port}");
    }
}

/// Sophia 设置丢了、但文件还是我们写的：认得出，切回按「原来没有」处理（写 "1p"、删 appliedId）
#[test]
fn files_written_by_sophia_are_recognized_without_a_record() {
    let lab = Lab::new();
    account_mode(&lab);
    lab.open(&desired(), None);
    let seen = lab.inspect(None);
    assert!(seen.unrecorded_ours);

    let other = Lab::new();
    other.open(
        &Desired {
            token: "sophia-someone-else".into(),
            ..desired()
        },
        None,
    );
    assert!(!other.inspect(None).unrecorded_ours);

    let record = lab.open(&desired(), None);
    assert_eq!(record.originals.applied_id, Original::Absent);
    assert_eq!(record.originals.claude_3p_mode, Original::Absent);
    assert_eq!(record.originals.claude_mode, Original::Absent);
    lab.close(&record);
    assert_eq!(mode(&lab, DesktopFile::Claude3pConfig), "1p");
    assert_eq!(mode(&lab, DesktopFile::ClaudeConfig), "1p");
    let meta = lab.json(DesktopFile::Meta);
    assert!(meta.get("appliedId").is_none());
    assert_eq!(meta["entries"], json!([]));
    assert!(lab.get(DesktopFile::Profile).is_none());
}

/// 待生效的配置部分：地址或 `inferenceModels` 各项对应的模型（含条数）变了才算
#[test]
fn needs_write_compares_the_written_address_and_models() {
    let lab = Lab::new();
    let record = lab.open(&desired(), None);
    assert!(!desktop::needs_write(&record, &desired()));
    let relabeled = Desired {
        models: vec![model("ap-kimi-k3", "Kimi K3"), model("ap-glm-5", "GLM 5")],
        ..desired()
    };
    assert!(desktop::needs_write(&record, &relabeled));
    // 多选了一个：菜单多一项，也算待生效
    let added = Desired {
        models: vec![
            model("ap-kimi-k3", "Kimi K3"),
            model("ap-qwen", "Qwen"),
            model("ap-glm-5", "glm-5 · AP"),
        ],
        ..desired()
    };
    assert!(desktop::needs_write(&record, &added));
    let moved = Desired {
        base_url: "http://127.0.0.1:47400/claude".into(),
        ..desired()
    };
    assert!(desktop::needs_write(&record, &moved));
}

/// R29（2026-09-30 改）：已选全部写进 `inferenceModels`、按选择顺序、不设上限。第一个 `claude-sonnet-5`
/// （Claude 把第一项当初始默认）；多于一个时最后一个 `claude-haiku-4-5`（Claude 用 Haiku 档起标题、跑子任务）；
/// 其余依次 `claude-sonnet-5-r2`、`-r3`……。只有一个时只写一项
#[test]
fn the_gateway_address_and_models_have_the_contract_shape() {
    assert_eq!(desktop::base_url(47328), BASE_URL);
    assert_eq!(FIRST_ROLE, "claude-sonnet-5");
    assert_eq!(HAIKU_ROLE, "claude-haiku-4-5");
    assert_eq!(desktop::role_ids(0), Vec::<String>::new());
    assert_eq!(desktop::role_ids(1), ["claude-sonnet-5"]);
    assert_eq!(
        desktop::role_ids(2),
        ["claude-sonnet-5", "claude-haiku-4-5"]
    );
    assert_eq!(
        desktop::role_ids(5),
        [
            "claude-sonnet-5",
            "claude-sonnet-5-r2",
            "claude-sonnet-5-r3",
            "claude-sonnet-5-r4",
            "claude-haiku-4-5"
        ]
    );
    // 都过得了桌面应用的校验：`claude-{sonnet|opus|haiku|fable}-` 之后还有东西
    for id in desktop::role_ids(12) {
        let tail = id.strip_prefix("claude-").unwrap();
        assert!(
            ["sonnet-", "haiku-"]
                .iter()
                .any(|p| tail.strip_prefix(p).is_some_and(|rest| !rest.is_empty())),
            "{id}"
        );
    }
    assert_eq!(
        desktop::inference_models(&["A"]),
        json!([{"name": "claude-sonnet-5", "labelOverride": "A"}])
    );
    assert_eq!(
        desktop::inference_models(&["A", "B", "C"]),
        json!([
            {"name": "claude-sonnet-5", "labelOverride": "A"},
            {"name": "claude-sonnet-5-r2", "labelOverride": "B"},
            {"name": "claude-haiku-4-5", "labelOverride": "C"}
        ])
    );
    let roles: Vec<(String, String, String)> = desired()
        .models()
        .into_iter()
        .map(|m| (m.role, m.slug, m.label))
        .collect();
    assert_eq!(
        roles,
        [
            (
                "claude-sonnet-5".to_owned(),
                "ap-kimi-k3".to_owned(),
                "Kimi K3".to_owned()
            ),
            (
                "claude-haiku-4-5".to_owned(),
                "ap-glm-5".to_owned(),
                "glm-5 · AP".to_owned()
            )
        ]
    );
    assert_eq!(SOPHIA_PROFILE_ID, "00000000-0000-4000-8000-736f70686961");
}

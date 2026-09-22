//! 共享类型。serde 统一 camelCase，前端 `src/types.ts` 与之对应。
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    /// 目标不存在，将建链
    Create,
    /// 目标里指向某本体位置之下、但本体已不存在的软链
    BrokenLink,
    /// 删除一条指向 `source_path` 的软链
    Unlink,
    /// 把一个 skill 本体目录移入废纸篓
    DeleteSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedAction {
    pub kind: ActionKind,
    pub item_name: String,
    /// 链接应指向的绝对路径
    pub source_path: PathBuf,
    /// 目标目录下的链接路径
    pub target_path: PathBuf,
    /// 所属目标目录
    pub target: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status", content = "reason")]
pub enum Outcome {
    Created,
    Skipped,
    Removed,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    pub action: PlannedAction,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub entries: Vec<ReportEntry>,
}

/// 新建软链的写法。Windows 忽略此项，一律 junction + 绝对路径
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkStyle {
    Absolute,
    Relative,
}

/// 从 harness 自己的数据库里取 agent 显示名
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLabels {
    /// 未展开的模板，含 `~` 与 `$VAR`
    pub path: String,
    pub table: String,
    pub id_column: String,
    pub name_column: String,
}

/// 一个 harness 的目录约定。路径已按当前机器解析
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    pub id: String,
    pub display_name: String,
    /// 相对项目根，如 ".claude/skills"
    pub project_dir: Option<String>,
    pub global_dir: Option<PathBuf>,
    /// 项目级直接读 .agents/skills
    pub universal: bool,
    /// 每个 agent 一个项目的 skill 目录，通配已展开
    #[serde(default)]
    pub agent_dirs: Vec<PathBuf>,
    /// `global_dir` 由 harness 自己装配：仍是本体位置，但不生成可写列
    #[serde(default)]
    pub managed_global_dir: bool,
    /// agent 目录名 → 显示名的查表方式
    #[serde(default)]
    pub agent_labels: Option<AgentLabels>,
}

/// 本体位置的来源类别
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SourceKind {
    /// 通用仓库 `~/.agents/skills`
    Universal,
    /// 某 harness 的全局 skill 目录
    HarnessGlobal { harness_id: String },
    /// 某项目的 skill 仓库；`project_label` 覆盖项目名的显示（harness 的 agent 目录用）
    ProjectStore {
        project: PathBuf,
        #[serde(default)]
        project_label: Option<String>,
    },
    /// 用户手工添加
    Manual,
    /// harness 目录里指向"任何已知本体位置之外"的软链合成出来的位置
    External,
}

/// 一个 skill 的本体：名字与它真实所在的路径
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    /// 本体真实路径；常规位置就是 `本体位置/name`
    pub path: PathBuf,
}

/// 一处本体位置：真实存放 skill 目录的地方
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// `normalize(path)` 的字符串
    pub id: String,
    pub path: PathBuf,
    pub kind: SourceKind,
    pub label: String,
    /// 按名排序
    pub skills: Vec<Skill>,
}

impl Source {
    /// 该 skill 在本位置里的本体路径；不在这里则 None
    pub fn skill_path(&self, name: &str) -> Option<&Path> {
        self.skills
            .iter()
            .find(|s| s.name == name)
            .map(|s| s.path.as_path())
    }
}

/// 目标目录所属的域
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TargetScope {
    Global {
        harness_id: String,
    },
    Project {
        project: PathBuf,
        harness_id: String,
        #[serde(default)]
        project_label: Option<String>,
    },
}

/// 一个可写入软链的目标目录
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Global → `<harness_id>`；Project → `project:<normalized path>::<harness_id>`
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub scope: TargetScope,
    /// 目录是否已存在（`is_dir()`，跟随软链）。false 的目标只在引入弹层可选，建链时就地创建
    pub exists: bool,
    /// 目标目录本身是软链且 real_path 等于某本体位置时，为该 Source 的 id
    pub linked_whole_to: Option<String>,
}

/// (本体位置, skill, 目标) 交叉点的状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    /// 目标目录就是本体位置本身，内容天然到位，不是链接
    Own,
    Linked,
    Missing,
    /// 链接目标不存在
    Broken,
    /// 链接指向别处
    Foreign,
    /// 目标处已有真实文件或目录
    Duplicate,
    /// 目标整个目录链接到别的本体位置，逐项写不进去
    WholeLinked,
    /// 目标目录存在但写不进去。**扫描不产出这个状态**：判定它要实际试写一次，
    /// 每轮扫描都试写代价太大。只在上层真的写失败之后由上层构造
    ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub source_id: String,
    pub skill: String,
    pub target_id: String,
    /// 目标目录下该 skill 的路径
    pub path: PathBuf,
    pub state: CellState,
    /// 这一格上的软链解析后落在哪（`real_path` 的结果）。只有 Linked / Foreign 有值，
    /// 其余状态是 None——Broken 的链接解析不到，本来也没有落点。
    /// Foreign 的提示条要靠它说出「指向哪个本体」，不带出来就只能写成含糊的「指向别处」
    pub points_to: Option<PathBuf>,
}

/// 域页表格的一行：一个 (本体位置, skill) 在本域各目标上的状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRow {
    pub source_id: String,
    pub skill: String,
    /// 该行的本体位置属于本域
    pub own: bool,
    pub cells: Vec<Cell>,
}

/// 前端选中的一格：本体位置 id + skill + 目标 id。目标决定域；格不必已出现在表里（引入弹层用）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRef {
    pub source_id: String,
    pub skill: String,
    pub target_id: String,
}

/// 一个域（全局或某项目）的整页数据
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainPage {
    /// `"global"` 或 `"project:<normalized path>"`
    pub key: String,
    pub label: String,
    /// 本域全部目标，即表格的列；目录尚不存在的也在其中（列头标「将新建目录」）
    pub targets: Vec<Target>,
    pub rows: Vec<DomainRow>,
    pub broken: Vec<PlannedAction>,
}

/// 一条自动同步规则：本体位置下的全部 skill（排除名单除外）持续补齐到这些目标
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLink {
    /// `normalize` 后的本体位置路径
    pub source: PathBuf,
    /// 目标 id（同一域内）
    pub targets: Vec<String>,
    /// 手动清除过、不再自动链接的 skill
    #[serde(default)]
    pub excluded: BTreeSet<String>,
    /// 建规则那一刻本体位置里已有的 skill：规则只管之后新出现的，这些不补建。
    /// `None` 只出现在升级前持久化的旧规则上——展开时整条跳过，
    /// 首次扫描由 `skills::migrate_baselines` 取当时的全部名字补上
    #[serde(default)]
    pub baseline: Option<BTreeSet<String>>,
}

/// 一条指向某本体的链接，以及改指时该怎么写。
/// style 在体检阶段就按 `skills::link_style` 算好：`sync::delete_source` 手里只有路径、
/// 拿不到 `Target`，事后补算不出来——算不出来就只能一律写绝对，项目内跟着 git 走的
/// 相对链接会被悄悄改成不可移植的绝对路径
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedLink {
    pub path: PathBuf,
    pub style: LinkStyle,
}

/// 删一个 skill 本体之前的全部事实，够 UI 渲染确认弹窗做决定。
/// 由 `skills::plan_delete_source` 产出，交给 `sync::delete_source` 执行
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSourcePlan {
    /// 要删的本体目录
    pub path: PathBuf,
    /// 目录里的条目总数（递归，不含目录自身）
    pub entries: usize,
    /// 目录里普通文件的字节数之和（软链不跟随）
    pub bytes: u64,
    /// 各目标目录里指向它（或它内部）的软链，连同改指时要写的形式
    pub affected: Vec<AffectedLink>,
    /// 所在 git 仓库的根；None 表示不在仓库里。非 None 时一律不代删
    pub in_git: Option<PathBuf>,
    /// 别处同名的另一个本体；删完把 `affected` 改指到它。None 表示没有别处可指
    pub relink_to: Option<PathBuf>,
}

/// 一次扫描的完整结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub domains: Vec<DomainPage>,
    /// 供引入弹层列出全部已发现的本体位置
    pub sources: Vec<Source>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_kind_serializes_with_type_tag() {
        let kind = SourceKind::ProjectStore {
            project: PathBuf::from("/Users/me/agents/agent_1788"),
            project_label: Some("WeiboAP · agent_1788".into()),
        };
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({
                "type": "projectStore",
                "project": "/Users/me/agents/agent_1788",
                "projectLabel": "WeiboAP · agent_1788"
            })
        );
    }

    #[test]
    fn target_scope_serializes_with_type_tag() {
        let scope = TargetScope::Project {
            project: PathBuf::from("/Users/me/proj"),
            harness_id: "claude-code".into(),
            project_label: None,
        };
        assert_eq!(
            serde_json::to_value(&scope).unwrap(),
            json!({
                "type": "project",
                "project": "/Users/me/proj",
                "harnessId": "claude-code",
                "projectLabel": null
            })
        );
    }

    #[test]
    fn cell_ref_and_new_variants_serialize_as_camel_case() {
        let cell = CellRef {
            source_id: "/a".into(),
            skill: "x".into(),
            target_id: "claude-code".into(),
        };
        assert_eq!(
            serde_json::to_value(&cell).unwrap(),
            json!({"sourceId": "/a", "skill": "x", "targetId": "claude-code"})
        );
        // 前端 `src/types.ts` 的 Cell 接口要有 pointsTo
        assert_eq!(
            serde_json::to_value(Cell {
                source_id: "/a".into(),
                skill: "x".into(),
                target_id: "claude-code".into(),
                path: PathBuf::from("/h/.claude/skills/x"),
                state: CellState::Foreign,
                points_to: Some(PathBuf::from("/b/skills/x")),
            })
            .unwrap(),
            json!({
                "sourceId": "/a",
                "skill": "x",
                "targetId": "claude-code",
                "path": "/h/.claude/skills/x",
                "state": "foreign",
                "pointsTo": "/b/skills/x"
            })
        );
        assert_eq!(serde_json::to_value(CellState::Own).unwrap(), json!("own"));
        assert_eq!(
            serde_json::to_value(ActionKind::Unlink).unwrap(),
            json!("unlink")
        );
    }

    /// 前端 `src/types.ts` 按这些字面量写，改名必须同步过去
    #[test]
    fn whole_linked_read_only_and_delete_plan_serialize_as_camel_case() {
        assert_eq!(
            serde_json::to_value(CellState::WholeLinked).unwrap(),
            json!("wholeLinked")
        );
        assert_eq!(
            serde_json::to_value(CellState::ReadOnly).unwrap(),
            json!("readOnly")
        );
        assert_eq!(
            serde_json::to_value(ActionKind::DeleteSource).unwrap(),
            json!("deleteSource")
        );
        let plan = DeleteSourcePlan {
            path: PathBuf::from("/a/skills/x"),
            entries: 3,
            bytes: 17,
            affected: vec![
                AffectedLink {
                    path: PathBuf::from("/h/.claude/skills/x"),
                    style: LinkStyle::Absolute,
                },
                AffectedLink {
                    path: PathBuf::from("/p/.claude/skills/x"),
                    style: LinkStyle::Relative,
                },
            ],
            in_git: None,
            relink_to: Some(PathBuf::from("/b/skills/x")),
        };
        assert_eq!(
            serde_json::to_value(&plan).unwrap(),
            json!({
                "path": "/a/skills/x",
                "entries": 3,
                "bytes": 17,
                "affected": [
                    {"path": "/h/.claude/skills/x", "style": "absolute"},
                    {"path": "/p/.claude/skills/x", "style": "relative"}
                ],
                "inGit": null,
                "relinkTo": "/b/skills/x"
            })
        );
    }

    #[test]
    fn harness_agent_labels_use_camel_case_and_default_to_absent() {
        let harness: Harness = serde_json::from_value(json!({
            "id": "weiboap",
            "displayName": "WeiboAP",
            "projectDir": null,
            "globalDir": "/g",
            "universal": false
        }))
        .unwrap();
        assert!(!harness.managed_global_dir);
        assert_eq!(harness.agent_labels, None);
        let labels = AgentLabels {
            path: "~/Library/Application Support/WeiboAP/agents.db".into(),
            table: "agents".into(),
            id_column: "id".into(),
            name_column: "name".into(),
        };
        assert_eq!(
            serde_json::to_value(&labels).unwrap(),
            json!({
                "path": "~/Library/Application Support/WeiboAP/agents.db",
                "table": "agents",
                "idColumn": "id",
                "nameColumn": "name"
            })
        );
    }

    #[test]
    fn skill_and_external_kind_serialize_as_camel_case() {
        let skill = Skill {
            name: "ego-browser".into(),
            path: PathBuf::from("/opt/ego-skills/ego-browser"),
        };
        assert_eq!(
            serde_json::to_value(&skill).unwrap(),
            json!({"name": "ego-browser", "path": "/opt/ego-skills/ego-browser"})
        );
        assert_eq!(
            serde_json::to_value(SourceKind::External).unwrap(),
            json!({"type": "external"})
        );
        let source = Source {
            id: "/opt/ego-skills".into(),
            path: PathBuf::from("/opt/ego-skills"),
            kind: SourceKind::External,
            label: "/opt/ego-skills".into(),
            skills: vec![skill],
        };
        assert_eq!(
            source.skill_path("ego-browser"),
            Some(Path::new("/opt/ego-skills/ego-browser"))
        );
        assert_eq!(source.skill_path("nope"), None);
    }

    #[test]
    fn auto_link_serializes_as_camel_case_and_excluded_defaults() {
        let rule = AutoLink {
            source: PathBuf::from("/a/skills"),
            targets: vec!["claude-code".into()],
            excluded: BTreeSet::from(["x".to_string()]),
            baseline: Some(BTreeSet::from(["y".to_string()])),
        };
        assert_eq!(
            serde_json::to_value(&rule).unwrap(),
            json!({"source": "/a/skills", "targets": ["claude-code"], "excluded": ["x"], "baseline": ["y"]})
        );
        let old: AutoLink =
            serde_json::from_value(json!({"source": "/a/skills", "targets": []})).unwrap();
        assert!(old.excluded.is_empty());
        // 升级前的规则没有 baseline：读成 None，等首次扫描迁移
        assert_eq!(old.baseline, None);
    }
}

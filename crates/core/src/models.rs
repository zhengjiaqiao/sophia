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
    /// 这一列写入的全部目录。绝大多数列只有一个；WeiboAP 全局列扇出到各助手目录
    pub dirs: Vec<PathBuf>,
    pub scope: TargetScope,
    /// 目标目录本身是软链且 real_path 等于某本体位置时，为该 Source 的 id。多目录列恒为 None
    pub linked_whole_to: Option<String>,
}

impl Target {
    /// 代表目录：列的主路径。`dirs` 由构造方保证非空
    pub fn main_dir(&self) -> &Path {
        &self.dirs[0]
    }
}

/// (本体位置, skill, 目标) 交叉点的状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    /// 目标目录就是本体位置本身，内容天然到位，不是链接
    Own,
    Linked,
    Missing,
    /// 多目录列上只有部分目录已到位
    Partial,
    /// 链接目标不存在
    Broken,
    /// 链接指向别处
    Foreign,
    /// 目标处已有真实文件或目录
    Duplicate,
    /// 目标整目录链接到别的本体位置
    Unwritable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub source_id: String,
    pub skill: String,
    pub target_id: String,
    /// 代表路径：`main_dir` 下该 skill 的路径
    pub path: PathBuf,
    pub state: CellState,
    /// 已到位的目录数 / 总目录数；单目录列为 1/1 或 0/1
    pub linked: usize,
    pub total: usize,
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
        assert_eq!(serde_json::to_value(CellState::Own).unwrap(), json!("own"));
        assert_eq!(
            serde_json::to_value(ActionKind::Unlink).unwrap(),
            json!("unlink")
        );
    }

    #[test]
    fn partial_state_and_multi_dir_target_serialize_for_the_front_end() {
        assert_eq!(
            serde_json::to_value(CellState::Partial).unwrap(),
            json!("partial")
        );
        let target = Target {
            id: "weiboap".into(),
            label: "WeiboAP".into(),
            dirs: vec![PathBuf::from("/a/skills"), PathBuf::from("/b/skills")],
            scope: TargetScope::Global {
                harness_id: "weiboap".into(),
            },
            linked_whole_to: None,
        };
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            json!({
                "id": "weiboap",
                "label": "WeiboAP",
                "dirs": ["/a/skills", "/b/skills"],
                "scope": {"type": "global", "harnessId": "weiboap"},
                "linkedWholeTo": null
            })
        );
        assert_eq!(target.main_dir(), Path::new("/a/skills"));
        let cell = Cell {
            source_id: "/a".into(),
            skill: "x".into(),
            target_id: "weiboap".into(),
            path: PathBuf::from("/a/skills/x"),
            state: CellState::Partial,
            linked: 1,
            total: 2,
        };
        assert_eq!(
            serde_json::to_value(&cell).unwrap(),
            json!({
                "sourceId": "/a",
                "skill": "x",
                "targetId": "weiboap",
                "path": "/a/skills/x",
                "state": "partial",
                "linked": 1,
                "total": 2
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
        };
        assert_eq!(
            serde_json::to_value(&rule).unwrap(),
            json!({"source": "/a/skills", "targets": ["claude-code"], "excluded": ["x"]})
        );
        let old: AutoLink =
            serde_json::from_value(json!({"source": "/a/skills", "targets": []})).unwrap();
        assert!(old.excluded.is_empty());
    }
}

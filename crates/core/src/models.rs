//! 共享类型。serde 统一 camelCase，前端 `src/types.ts` 与之对应。
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// 同步整目录，或只同步指定名字的子项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Selection {
    All,
    Items(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRule {
    pub id: uuid::Uuid,
    pub name: String,
    pub source: PathBuf,
    pub selection: Selection,
    pub targets: Vec<PathBuf>,
    pub last_run_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    /// 目标不存在，将建链
    Create,
    /// 已是指向正确源的软链，跳过
    AlreadyLinked,
    /// 目标存在真实文件/目录或指向他处的软链，跳过并报告
    Conflict,
    /// 指定子项在源里不存在
    SourceMissing,
    /// 目标里指向本源目录下、但源已不存在的软链
    BrokenLink,
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

impl PlannedAction {
    /// 同一 kind 与 target_path 唯一，前端表格与结果合并用
    pub fn id(&self) -> String {
        format!("{:?}|{}", self.kind, self.target_path.display())
    }
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Domain {
    Global,
    Project { path: PathBuf },
}

/// 本体位置的来源类别
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SourceKind {
    /// 通用仓库 `~/.agents/skills`
    Universal,
    /// 某 harness 的全局 skill 目录
    HarnessGlobal { harness_id: String },
    /// 某项目的 `.agents/skills`
    ProjectStore { project: PathBuf },
    /// harness 的额外位置（通配展开），label 为通配层匹配到的目录名
    HarnessExtra { harness_id: String, label: String },
    /// 用户手工添加
    Manual,
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
    /// 真实目录名，排序
    pub skills: Vec<String>,
}

/// 目标目录所属的域
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TargetScope {
    Global {
        harness_id: String,
    },
    Project {
        project: PathBuf,
        harness_id: String,
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
    /// 目标目录本身是软链且 real_path 等于某本体位置时，为该 Source 的 id
    pub linked_whole_to: Option<String>,
}

/// (本体位置, skill, 目标) 交叉点的状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellState {
    Linked,
    Missing,
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
    /// 目标目录下该 skill 的路径
    pub path: PathBuf,
    pub state: CellState,
}

/// 单个本体位置的同步选择
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceSync {
    pub targets: BTreeSet<String>,
    pub disabled_skills: BTreeSet<String>,
}

/// 持久化到 `syncset.json` 的两级勾选
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSet {
    pub sources: BTreeMap<String, SourceSync>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub sources: usize,
    pub pending_missing: usize,
    pub broken: usize,
}

/// 一次扫描的完整结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub sources: Vec<Source>,
    pub targets: Vec<Target>,
    pub cells: Vec<Cell>,
    pub sync_set: SyncSet,
    pub summary: Summary,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_kind_serializes_with_type_tag() {
        let kind = SourceKind::HarnessExtra {
            harness_id: "weiboap".into(),
            label: "agent_1788".into(),
        };
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({"type": "harnessExtra", "harnessId": "weiboap", "label": "agent_1788"})
        );
    }

    #[test]
    fn target_scope_serializes_with_type_tag() {
        let scope = TargetScope::Project {
            project: PathBuf::from("/Users/me/proj"),
            harness_id: "claude-code".into(),
        };
        assert_eq!(
            serde_json::to_value(&scope).unwrap(),
            json!({"type": "project", "project": "/Users/me/proj", "harnessId": "claude-code"})
        );
    }

    #[test]
    fn empty_sync_set_serializes_to_empty_map() {
        assert_eq!(
            serde_json::to_value(SyncSet::default()).unwrap(),
            json!({"sources": {}})
        );
    }
}

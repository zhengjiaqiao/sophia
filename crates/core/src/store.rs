//! JSON 持久化：rules.json、projects.json、settings.json、syncset.json，整文件原子写（先写 .tmp 再 rename）
use crate::models::{SyncRule, SyncSet};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// 应用设置：被用户关掉的 harness id，以及手动添加的本体位置
/// 容器级 `default` 让旧格式（缺字段）照样能读
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub disabled_harnesses: Vec<String>,
    pub manual_sources: Vec<PathBuf>,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 系统应用数据目录下的 SymSync
    pub fn default_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("SymSync")
    }

    pub fn load_rules(&self) -> io::Result<Vec<SyncRule>> {
        load_json(&self.dir.join("rules.json"))
    }

    pub fn save_rules(&self, rules: &[SyncRule]) -> io::Result<()> {
        save_json(&self.dir.join("rules.json"), &rules)
    }

    pub fn load_projects(&self) -> io::Result<Vec<PathBuf>> {
        load_json(&self.dir.join("projects.json"))
    }

    pub fn save_projects(&self, projects: &[PathBuf]) -> io::Result<()> {
        save_json(&self.dir.join("projects.json"), &projects)
    }

    pub fn load_settings(&self) -> io::Result<Settings> {
        load_json(&self.dir.join("settings.json"))
    }

    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        save_json(&self.dir.join("settings.json"), settings)
    }

    /// 两级勾选的同步集；文件缺失 → 空集
    pub fn load_sync_set(&self) -> io::Result<SyncSet> {
        load_json(&self.dir.join("syncset.json"))
    }

    pub fn save_sync_set(&self, sync_set: &SyncSet) -> io::Result<()> {
        save_json(&self.dir.join("syncset.json"), sync_set)
    }
}

/// 文件不存在 → 默认值；存在但损坏 → 报错，不静默清空
fn load_json<T: DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e),
    }
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Pick, Selection, SyncRule};
    use crate::test_support::TempTree;

    #[test]
    fn missing_files_load_as_empty() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        assert_eq!(s.load_rules().unwrap(), Vec::<SyncRule>::new());
        assert_eq!(s.load_projects().unwrap(), Vec::<PathBuf>::new());
    }

    #[test]
    fn rules_round_trip_and_overwrite_atomically() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        let rule = SyncRule {
            id: uuid::Uuid::new_v4(),
            name: "r".into(),
            source: PathBuf::from("/tmp/src"),
            selection: Selection::Items(vec!["a".into()]),
            targets: vec![PathBuf::from("/tmp/dst")],
            last_run_at: Some(chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap()),
        };
        s.save_rules(std::slice::from_ref(&rule)).unwrap();
        assert_eq!(s.load_rules().unwrap(), vec![rule.clone()]);
        s.save_rules(&[]).unwrap();
        assert_eq!(s.load_rules().unwrap(), vec![]);
        assert!(!dir.join("rules.json.tmp").exists());
    }

    #[test]
    fn projects_round_trip() {
        let t = TempTree::new();
        let s = Store::new(t.root().join("data/SymSync"));
        let p = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        s.save_projects(&p).unwrap();
        assert_eq!(s.load_projects().unwrap(), p);
    }

    #[test]
    fn settings_default_when_missing_and_round_trip() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        assert_eq!(s.load_settings().unwrap(), Settings::default());
        let settings = Settings {
            disabled_harnesses: vec!["a".into(), "b".into()],
            manual_sources: vec![PathBuf::from("/a/skills")],
        };
        s.save_settings(&settings).unwrap();
        assert_eq!(s.load_settings().unwrap(), settings);
        assert!(!dir.join("settings.json.tmp").exists());
    }

    #[test]
    fn sync_set_missing_is_empty_and_round_trips() {
        let t = TempTree::new();
        let dir = t.root().join("data/SymSync");
        let s = Store::new(dir.clone());
        assert_eq!(s.load_sync_set().unwrap(), SyncSet::default());

        let mut set = SyncSet::default();
        set.picks.insert(
            "claude-code".into(),
            [("/a/skills".to_string(), Pick::All)].into_iter().collect(),
        );
        set.picks.insert(
            "project:/p::claude-code".into(),
            [(
                "/b/skills".to_string(),
                Pick::Only(["noisy".to_string()].into_iter().collect()),
            )]
            .into_iter()
            .collect(),
        );
        s.save_sync_set(&set).unwrap();
        assert_eq!(s.load_sync_set().unwrap(), set);
        assert!(!dir.join("syncset.json.tmp").exists());
    }

    #[test]
    fn settings_without_manual_sources_still_loads() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(dir.join("settings.json"), r#"{"disabledHarnesses":[]}"#).unwrap();
        let loaded = Store::new(dir).load_settings().unwrap();
        assert_eq!(loaded.manual_sources, Vec::<PathBuf>::new());
    }

    #[test]
    fn corrupt_file_is_an_error_not_silent_reset() {
        let t = TempTree::new();
        let dir = t.dir("data/SymSync");
        std::fs::write(dir.join("rules.json"), "{oops").unwrap();
        assert!(Store::new(dir).load_rules().is_err());
    }
}

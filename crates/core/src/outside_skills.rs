//! 列表外的 skill：agent 自带的、插件带的。它们归 agent 管，Sophia 不同步，只报个数
//! （DESIGN「列头的悬停」）。
//!
//! 只读 harness 表里登记的文件夹（`system_skills_dir`、`plugin_cache_dir`），规则与位置里的 skill
//! 相同：带 `SKILL.md` 的子目录才算。插件开没开、agent 这一次加载了哪些是用户和 agent 的事，
//! 这里不读配置去判断。
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

use crate::discovery::{outside_dirs, Env};
use crate::models::Harness;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideSkills {
    pub harness_id: String,
    /// 自带目录里的 skill 数
    pub system: usize,
    /// 插件缓存里的 skill 数：同一个插件的几个版本里同名的算一个
    pub plugin: usize,
}

/// 已启用的 agent 里，登记了自带或插件目录、且数出来不是 0 的
pub fn count(env: &Env, harnesses: &[Harness]) -> Vec<OutsideSkills> {
    harnesses
        .iter()
        .filter_map(|h| {
            let (system_dir, plugin_dir) = outside_dirs(env, &h.id);
            let system = system_dir.map_or(0, |d| skill_names(&d).len());
            let plugin = plugin_dir.map_or(0, |d| plugin_skills(&d));
            (system + plugin > 0).then(|| OutsideSkills {
                harness_id: h.id.clone(),
                system,
                plugin,
            })
        })
        .collect()
}

/// 直接子项里非隐藏、带 `SKILL.md` 的目录名（跟随软链：插件缓存里的版本目录可能是链接）
fn skill_names(dir: &Path) -> BTreeSet<String> {
    subdirs(dir)
        .into_iter()
        .filter(|(_, p)| p.join("SKILL.md").is_file())
        .map(|(name, _)| name)
        .collect()
}

/// `<市场>/<插件>/<版本>/skills/<skill>/SKILL.md`：每个插件把各版本的名字并起来再数
fn plugin_skills(cache: &Path) -> usize {
    subdirs(cache)
        .into_iter()
        .flat_map(|(_, market)| subdirs(&market))
        .map(|(_, plugin)| {
            subdirs(&plugin)
                .into_iter()
                .flat_map(|(_, version)| skill_names(&version.join("skills")))
                .collect::<BTreeSet<_>>()
                .len()
        })
        .sum()
}

fn subdirs(dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            (!name.starts_with('.') && path.is_dir()).then_some((name, path))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempTree;

    #[test]
    fn counts_skill_md_dirs_in_system_dir_and_plugin_cache() {
        let t = TempTree::new();
        t.skill(".system/imagegen");
        t.skill(".system/skill-creator");
        t.dir(".system/notes"); // 没有 SKILL.md：不算
        assert_eq!(skill_names(&t.root().join(".system")).len(), 2);

        let cache = t.dir("cache");
        t.skill("cache/market-a/data/1.0.10/skills/build-report");
        t.skill("cache/market-a/data/1.0.11/skills/build-report"); // 同插件另一版本：同名算一个
        t.skill("cache/market-a/data/1.0.11/skills/validate-data");
        t.skill("cache/market-b/pdf/26.9/skills/pdf");
        t.dir("cache/market-b/hud/0.8.0/commands"); // 没有 skills 目录：0
        t.skill("cache/.tmp/x/1/skills/hidden"); // 隐藏目录不算
        assert_eq!(plugin_skills(&cache), 3);
    }

    #[test]
    fn missing_dirs_count_zero() {
        let t = TempTree::new();
        assert_eq!(skill_names(&t.root().join("nope")).len(), 0);
        assert_eq!(plugin_skills(&t.root().join("nope")), 0);
    }
}

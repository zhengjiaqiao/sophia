//! 密钥提醒接到移动 / 复制、点格子写入与自动同步规则（spec 2026-10-05-skill-mcp-batch2「密钥提醒（S19）」，issue #113）：
//! 来源是计划里每条写入的来源文件（移动 / 复制与格子的原位置、规则的来源），目标是写进的项目文件，判断照 `keyhint::decide`。
//! 「保留这份」（issue #147）的来源是选中那一份所在的文件，目标是要改写的其他几处（`keep.rs` 用这里的
//! `hint_for` 与 `ignore_written`）。安装页（来源＝市场）在 `define.rs`（`ProjectRepo`）
use super::{
    execute, has_key_values, keyed_names, Canonical, McpLocation, McpReport, Pending, PreparedPlan,
};
use crate::keyhint::{self, GitFacts, GitignoreEdit, KeyHint};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 一个写进项目文件的目标这次的密钥提醒（确认框据此出不出「同时加进 .gitignore」与提示框写什么）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpKeyHint {
    pub target_id: String,
    pub hint: KeyHint,
    /// 目标所在项目的根：`.gitignore` 加在这里
    pub project: PathBuf,
    /// 目标文件在项目根 `.gitignore` 里写成的那一行（`.cursor/mcp.json`）
    pub gitignore_line: String,
}

/// 计划里写进项目文件的每个目标一条（按位置 id，先后照计划）。这次要写进它的每条定义各判一次，取最要紧的：
/// 自动加 > 提醒 > 来源已提交 > 不处理（一条照搬了忽略，就整份加；有一条第一次暴露，就要提醒）
pub fn key_hints(plan: &PreparedPlan) -> Vec<McpKeyHint> {
    let mut git = Probes::default();
    let mut out = Vec::new();
    for pending in &plan.private {
        if let Some(hint) = hint_of(pending, &mut git) {
            merge(&mut out, hint);
        }
    }
    out
}

/// 执行计划，再按密钥提醒处理写成了的项目文件：`AutoIgnore` 总是加进项目根的 `.gitignore`（`auto_ignored`），
/// `Remind` 看 `add_to_gitignore`——确认框里勾了「同时加进 .gitignore」；自动同步规则与点格子写入上没有勾选，传 false，
/// 照常写、不加，报告里记 `key_exposed` 与可以补加的目标（`ignorable`）。`Tracked`（目标已被跟踪）从不追加，
/// 报告里记 `key_tracked`。追加记进 `gitignore_undo`（`take_gitignore_undo`）；没写成的记进
/// `gitignore_failed`，配置照样算写成。判断用执行前的 git 事实：移动时来源随后才删，目标此刻还没写
pub fn execute_minding_keys(
    plan: PreparedPlan,
    allow_cross_domain: bool,
    add_to_gitignore: bool,
    backups: &Path,
) -> McpReport {
    let mut git = Probes::default();
    let judged: Vec<(String, McpKeyHint, &Pending)> = plan
        .private
        .iter()
        .filter_map(|pending| {
            Some((
                pending.action.name.clone(),
                hint_of(pending, &mut git)?,
                pending,
            ))
        })
        .collect();
    // 撤 .gitignore 那几行之前要核对：目标里没有写前没有的、带密钥的服务（见 `McpUndo::guard_keys`）
    let mut before = BTreeMap::new();
    for (_, hint, pending) in &judged {
        if matches!(hint.hint, KeyHint::AutoIgnore | KeyHint::Remind) {
            let location = &pending.target_location;
            before
                .entry(hint.target_id.clone())
                .or_insert_with(|| (location.clone(), keyed_names(location)));
        }
    }
    let judged: Vec<(String, McpKeyHint, PathBuf)> = judged
        .into_iter()
        .map(|(name, hint, pending)| (name, hint, pending.target_location.path.clone()))
        .collect();
    let mut report = execute(plan, allow_cross_domain, backups);
    // 只算写成了的：同名已有、写失败的那几条没把密钥写进去
    let mut written: Vec<McpKeyHint> = Vec::new();
    let mut paths = BTreeMap::new();
    for (name, hint, path) in judged {
        let created = report
            .entries
            .iter()
            .any(|e| e.outcome == "created" && e.target_id == hint.target_id && e.name == name);
        if created {
            paths.insert(hint.target_id.clone(), path);
            merge(&mut written, hint);
        }
    }
    let written = written
        .into_iter()
        .filter_map(|hint| Some((paths.remove(&hint.target_id)?, hint)))
        .collect();
    ignore_written(
        &mut report,
        written,
        add_to_gitignore,
        backups,
        |report, edit, hint| {
            // 同一个 .gitignore 加了几行（几个目标在同一个项目里）合成一条，撤销一次全部退回
            report.gitignore_undo.record_edit(edit);
            if let Some((location, keyed)) = before.remove(&hint.target_id) {
                report.gitignore_undo.guard_keys(location, keyed);
            }
        },
    );
    report
}

/// 写成了的几个目标（文件与这次的提醒，每个目标一条）按提醒处理：`AutoIgnore` 总是加进项目根的 `.gitignore`
/// （`auto_ignored`），`Remind` 看 `add_to_gitignore`，没加的记 `key_exposed` 与可补加的目标（`ignorable`）；
/// `Tracked` 从不追加，记 `key_tracked` 与是哪几个（`tracked_targets`）。追加成了交给 `record`（记进哪一条撤销由入口定），没写成的记进 `gitignore_failed`
pub(super) fn ignore_written(
    report: &mut McpReport,
    written: Vec<(PathBuf, McpKeyHint)>,
    add_to_gitignore: bool,
    backups: &Path,
    mut record: impl FnMut(&mut McpReport, GitignoreEdit, &McpKeyHint),
) {
    for (path, hint) in written {
        match hint.hint {
            KeyHint::AutoIgnore => {}
            KeyHint::Remind if add_to_gitignore => {}
            KeyHint::Remind => {
                report.key_exposed = true;
                report.ignorable.push(hint.target_id.clone());
                continue;
            }
            KeyHint::Tracked => {
                report.key_tracked = true;
                report.tracked_targets.push(hint.target_id.clone());
                continue;
            }
            KeyHint::Quiet | KeyHint::SourceCommitted => continue,
        }
        match keyhint::add_to_gitignore(&hint.project, &path, backups) {
            Ok(Some(edit)) => {
                record(report, edit, &hint);
                report.auto_ignored |= hint.hint == KeyHint::AutoIgnore;
            }
            Ok(None) => {}
            Err(error) => {
                let gitignore = hint.project.join(".gitignore");
                report.gitignore_failed = Some(gitignore_failed(&gitignore, &error));
            }
        }
    }
}

/// 加入 `.gitignore` 失败的那一句（spec #239「出错的时候」）：磁盘满、没权限、只读说原因；分不出原因只写失败句，
/// 不把系统原文拼进提示条。原文进日志
pub(super) fn gitignore_failed(gitignore: &Path, error: &std::io::Error) -> String {
    log::warn!("gitignore-append {}: {error}", gitignore.display());
    crate::report::count_write_failure(error);
    match crate::atomicfile::write_failure(error).untouched() {
        Some(reason) => crate::t!("mcp.report.gitignoreFailed", reason = reason),
        None => crate::t!("mcp.report.gitignoreFailedPlain"),
    }
}

/// 点格子写入写成之后，提示条上的「加进 .gitignore」（产品负责人 2026-10-06）：把这几个位置（`McpReport::ignorable`）
/// 的文件加进各自项目根的 `.gitignore`。此刻再问一次 git：已被忽略的不必加；写成之后又被跟踪了的加了也挡不住，
/// 不加、报告里记 `key_tracked`（提示条照实说，不说「已加进」）；
/// 不认识的位置、不是项目文件的什么都不做。追加记进 `gitignore_undo`（`take_gitignore_undo`，和那次写入同一次撤销：
/// 先撤配置再撤它），撤之前核对配置里没有此刻之后才写进的带密钥服务（`guard_keys`）；没写成的记进 `gitignore_failed`
pub fn ignore_targets(
    locations: &[McpLocation],
    target_ids: &[String],
    backups: &Path,
) -> McpReport {
    let mut report = McpReport::default();
    for id in target_ids {
        let Some(location) = locations
            .iter()
            .find(|l| &l.id == id && l.selector.is_none())
        else {
            continue;
        };
        let Some((project, _)) = location
            .domain
            .strip_prefix("project:")
            .and_then(|root| keyhint::project_line(Path::new(root), &location.path))
        else {
            continue;
        };
        let facts = keyhint::probe(&location.path);
        if facts.tracked && !facts.ignored {
            report.key_tracked = true;
        }
        if !facts.in_repo || facts.ignored || facts.tracked {
            continue;
        }
        match keyhint::add_to_gitignore(&project, &location.path, backups) {
            Ok(Some(edit)) => {
                report.gitignore_undo.record_edit(edit);
                report
                    .gitignore_undo
                    .guard_keys(location.clone(), keyed_names(location));
            }
            Ok(None) => {}
            Err(error) => {
                let gitignore = project.join(".gitignore");
                report.gitignore_failed = Some(gitignore_failed(&gitignore, &error));
            }
        }
    }
    report
}

/// 一条写入的提醒：只对写进项目文件的（不是用户级、不是 Claude Code 仅自己的 `~/.claude.json`、不是第三方模式的
/// 镜像）给
fn hint_of(pending: &Pending, git: &mut Probes) -> Option<McpKeyHint> {
    if pending.mirror {
        return None;
    }
    let sources: Vec<&Path> = std::iter::once(pending.action.source_path.as_path())
        .chain(pending.also_from.iter().map(PathBuf::as_path))
        .collect();
    hint_for(
        &pending.target_location,
        &pending.definition,
        &pending.action.target_id,
        &sources,
        git,
    )
}

/// 把 `definition` 写进 `location`（位置 id `target_id`）这一次的提醒，来源是 `sources` 里的几个文件（合并进来的是
/// 同一份定义）。不是项目文件（用户级、Claude Code 仅自己）的为 None。没有像密钥的值就不必问 git；目标不在仓库里
/// 或已被忽略，也不必再问来源
pub(super) fn hint_for(
    location: &McpLocation,
    definition: &Canonical,
    target_id: &str,
    sources: &[&Path],
    git: &mut Probes,
) -> Option<McpKeyHint> {
    if location.selector.is_some() {
        return None;
    }
    // 不在项目根下（设置文件是指向项目外的软链接，已换成真实路径）为 None；项目根本身是软链接的按真实路径认
    let (project, line) = keyhint::project_line(
        Path::new(location.domain.strip_prefix("project:")?),
        &location.path,
    )?;
    let hint = if has_key_values(definition) {
        let target = git.facts(&location.path);
        let source = if target.in_repo && !target.ignored {
            // 合并进来的几个来源是同一份定义：事实合在一起再判一次——有一处提交过，这份密钥就早在仓库里了
            // （来源已提交优先于照搬忽略，同 `decide`）；有一处被忽略，就照搬
            sources
                .iter()
                .map(|path| git.facts(path))
                .fold(GitFacts::default(), |all, one| GitFacts {
                    in_repo: all.in_repo || one.in_repo,
                    tracked: all.tracked || one.tracked,
                    ignored: all.ignored || one.ignored,
                })
        } else {
            GitFacts::default()
        };
        keyhint::decide(true, source, target)
    } else {
        KeyHint::Quiet
    };
    Some(McpKeyHint {
        target_id: target_id.to_owned(),
        hint,
        project,
        gitignore_line: line,
    })
}

/// 几种提醒谁更要紧：自动加 > 提醒 > 已被跟踪 > 来源已提交 > 不处理。已被跟踪是目标的事实，同一个目标里
/// 带密钥的几条要么都是它、要么都不是，排在哪只影响与不处理、来源已提交相比
fn rank(hint: KeyHint) -> u8 {
    match hint {
        KeyHint::Quiet => 0,
        KeyHint::SourceCommitted => 1,
        KeyHint::Tracked => 2,
        KeyHint::Remind => 3,
        KeyHint::AutoIgnore => 4,
    }
}

/// 同一个目标的几条合成一条，取最要紧的
pub(super) fn merge(out: &mut Vec<McpKeyHint>, hint: McpKeyHint) {
    match out.iter_mut().find(|h| h.target_id == hint.target_id) {
        Some(old) if rank(hint.hint) > rank(old.hint) => old.hint = hint.hint,
        Some(_) => {}
        None => out.push(hint),
    }
}

/// 同一次里同一个文件只问一次 git（规则一轮可能往同一个项目写好几条）
#[derive(Default)]
pub(super) struct Probes(BTreeMap<PathBuf, GitFacts>);

impl Probes {
    fn facts(&mut self, file: &Path) -> GitFacts {
        *self
            .0
            .entry(file.to_path_buf())
            .or_insert_with(|| keyhint::probe(file))
    }
}

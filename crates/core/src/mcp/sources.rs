//! MCP 的来源订阅：每个位置（全局、某个项目、某个 WeiboAP agent，即域）订阅了哪些配置位置。
//!
//! 与 skill 的 `subscriptions` 同一套：来源是订阅的单位，订阅了的来源，它的**全部**服务都进这个
//! 位置的列表，没写进的格是 Missing。来源＝一处配置（`Claude Code · User`），用位置 id 记。
//! 什么算已订阅：
//! - 这个位置自己的配置（`domain` 就是它，`is_own`）：永远算，不进记录，也不能移除；
//! - 订阅记录（`Settings.mcp_subscriptions`）里的：来源管理页添加过的，一条都没写进也算；
//! - 老数据由 `adopt` 在扫描时写进记录（见它的说明），此后由记录决定。
//!
//! 移除＝撤掉这个来源写进这个位置的那些配置：先 `plan_remove` 列出（服务名 × 位置），确认后
//! `remove` 逐项重校验目标里那一项仍与来源一致，一致的才拿掉，写回只走 `atomicfile`。
//! 文件是文本级手术：JSON 只切掉那一个成员，TOML 只删属于它的那几行，写前按语义核对
//! 「除了拿掉的那一项，其余一模一样」，对不上整个文件不写。
use super::{
    backup, is_supported_transport, location_unreadable, parse_json, parse_toml, raw_json_ranges,
    raw_object_members, raw_object_members_at, read, skip, toml, Canonical, McpAutoImportRule,
    McpLocation, McpOverview, McpReport, McpReportEntry, NoDuplicates, Parsed, State,
};
use crate::atomicfile::{self, FileState};
use crate::fs::normalize;
use crate::subscriptions::{distinguishing_segments, DomainName};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 每个位置订阅了哪些 MCP 来源：域 key（`global` / `project:<路径>`）→ 来源位置 id。
/// 某个域的 key 在表里（哪怕集合为空）就说明它已经做过第一次扫描的老数据认领
pub type McpSubscriptions = BTreeMap<String, BTreeSet<String>>;

const GLOBAL: &str = "global";

/// 来源里的一个服务
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpService {
    pub name: String,
    /// 能不能写到别处；false＝搬不过去（用了只有来源认得的写法）
    pub portable: bool,
}

/// 来源管理页一行的共同部分
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceSummary {
    /// 位置 id（`McpLocation.id`）
    pub id: String,
    /// `Claude Code · User`、`Cursor · Project`
    pub label: String,
    pub harness_id: String,
    pub domain: String,
    /// 它在哪：`全局` / 项目文件夹名；同名同处的再带上路径里能区分它们的那一级
    pub place: String,
    /// 配置文件完整路径，给提示框
    pub path: PathBuf,
    /// 这次读不出来（整份配置）
    pub unreadable: bool,
    /// 按名排序
    pub services: Vec<McpService>,
}

/// 这个位置已订阅的一个来源
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSubscribedSource {
    #[serde(flatten)]
    pub source: McpSourceSummary,
    /// 这个位置自己的配置：永远算已订阅，不能移除
    pub own: bool,
    /// 「以后新出现的自动写进」在这个位置的目标 id；空＝关着
    pub auto_targets: Vec<String>,
}

/// `+ 来源` 里的一个候选
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCandidateSource {
    #[serde(flatten)]
    pub source: McpSourceSummary,
    /// 在哪些位置订阅着（只有「其他项目在用的」有）
    pub used_in: Vec<DomainName>,
}

/// MCP 来源管理页的全部数据
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceList {
    /// 自己的在前，其余按名
    pub subscribed: Vec<McpSubscribedSource>,
    /// 别的位置订阅过、这里还没有的
    pub elsewhere: Vec<McpCandidateSource>,
    /// 检测到的其余配置（有服务定义的）
    pub detected: Vec<McpCandidateSource>,
}

/// 移除来源时会拿掉的一项：哪个服务、从哪个位置
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRemovalItem {
    pub name: String,
    pub target_id: String,
    /// 位置名（`McpLocation.label`），给确认框
    #[serde(default)]
    pub location: String,
}

/// 移除来源前给确认框的清单
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceRemoval {
    pub source_id: String,
    /// 按位置先后、再按服务名；为空表示没有写进这里的配置要撤
    pub items: Vec<McpRemovalItem>,
}

pub fn is_own(location: &McpLocation, key: &str) -> bool {
    location.domain == key
}

fn domains(locations: &[McpLocation]) -> BTreeSet<&str> {
    locations.iter().map(|l| l.domain.as_str()).collect()
}

fn recorded(subs: &McpSubscriptions, key: &str, id: &str) -> bool {
    subs.get(key).is_some_and(|set| set.contains(id))
}

/// 来源在这个位置算不算已订阅：自己的 ∪ 记录里的
pub fn subscribed(location: &McpLocation, key: &str, subs: &McpSubscriptions) -> bool {
    is_own(location, key) || recorded(subs, key, &location.id)
}

/// 「已经写进这个位置」的证据：全局的一处配置，有服务在这个位置的某处有一份一样的。
///
/// 和 skill 的软链不同，MCP 的「一样」是对称的，分不出谁写给了谁，所以只认全局 → 项目
/// （与 WeiboAP agent）这个方向：全局不因为项目里抄了一份就订阅那个项目，项目之间也不互相
/// 认领——否则两个都从全局抄过同一个服务的项目会互相订阅，把对方的全部服务列成空格
fn written_into(location: &McpLocation, key: &str, overview: &McpOverview) -> bool {
    if location.domain != GLOBAL || key == GLOBAL {
        return false;
    }
    let here: BTreeSet<&str> = overview
        .locations
        .iter()
        .filter(|l| l.domain == key)
        .map(|l| l.id.as_str())
        .collect();
    overview
        .entries
        .iter()
        .filter(|e| e.source_id == location.id)
        .flat_map(|e| &e.cells)
        .any(|cell| {
            here.contains(cell.target_id.as_str())
                && matches!(
                    cell.state,
                    super::McpCellState::Equal | super::McpCellState::SameEndpoint
                )
        })
}

/// 开着的自动添加规则从它往这个位置写：用户明确要过它的服务
fn ruled_into(location: &McpLocation, key: &str, rules: &[McpAutoImportRule]) -> bool {
    rules
        .iter()
        .any(|r| r.source.id == location.id && r.target_domain == key && !r.targets.is_empty())
}

/// 把老数据与新证据写进各位置的订阅记录；返回是否改动过。
///
/// 认领的是：已经写进这个位置的全局配置（见 `written_into`），以及开着规则往这里写的来源。
/// 某个位置第一次扫描（记录里还没有它的 key）时写下 key，此后由记录决定成不成行——
/// 所以撤掉最后一份，那些行也不会从列表里消失。之后出现的新证据照样记下（与 skill 同理）。
/// 自己的位置不进记录
pub fn adopt(
    subs: &mut McpSubscriptions,
    overview: &McpOverview,
    rules: &[McpAutoImportRule],
) -> bool {
    let mut changed = false;
    for key in domains(&overview.locations) {
        let first = !subs.contains_key(key);
        let found: Vec<String> = overview
            .locations
            .iter()
            .filter(|l| !is_own(l, key) && !recorded(subs, key, &l.id))
            .filter(|l| written_into(l, key, overview) || ruled_into(l, key, rules))
            .map(|l| l.id.clone())
            .collect();
        changed |= first || !found.is_empty();
        subs.entry(key.to_string()).or_default().extend(found);
    }
    changed
}

/// 把订阅记录填进扫描结果（`McpOverview.subscribed`）：每个位置订阅着的、别的位置的来源 id。
/// 这次没发现的位置（项目移走了、agent 关掉了）不填，记录留着，回来了照旧成行
pub fn attach(overview: &mut McpOverview, subs: &McpSubscriptions) {
    let mut out = BTreeMap::new();
    for key in domains(&overview.locations) {
        let ids: Vec<String> = overview
            .locations
            .iter()
            .filter(|l| !is_own(l, key) && recorded(subs, key, &l.id))
            .map(|l| l.id.clone())
            .collect();
        if !ids.is_empty() {
            out.insert(key.to_string(), ids);
        }
    }
    overview.subscribed = out;
}

/// 在这个位置订阅一处配置。是这个位置自己的配置时什么都不用记
pub fn subscribe(
    subs: &mut McpSubscriptions,
    key: &str,
    source_id: &str,
    overview: &McpOverview,
) -> Result<(), String> {
    if !overview.locations.iter().any(|l| l.domain == key) {
        return Err("这个位置已经不在了，请刷新".into());
    }
    let source = overview
        .locations
        .iter()
        .find(|l| l.id == source_id)
        .ok_or("这处配置已经不在了，请刷新")?;
    if !is_own(source, key) {
        subs.entry(key.to_string())
            .or_default()
            .insert(source.id.clone());
    }
    Ok(())
}

/// 位置名写法 `Claude Code · User`：去掉 `MCPs` 这类泛称；只有 agent 名的补上作用域
/// （全局 `User`、项目 `Project`）。WeiboAP 一个 agent 只有一处，不补
pub fn source_label(location: &McpLocation) -> String {
    let base = location.label.trim_end_matches(" MCPs");
    if base.contains(" · ") || location.harness_id == "weiboap" {
        base.to_string()
    } else if location.domain == GLOBAL {
        format!("{base} · User")
    } else {
        format!("{base} · Project")
    }
}

/// 域的显示名：全局 / 项目（或 WeiboAP agent）文件夹名
pub fn domain_label(key: &str) -> String {
    match key.strip_prefix("project:") {
        Some(path) => Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string()),
        None => "全局".into(),
    }
}

fn summary(location: &McpLocation, overview: &McpOverview) -> McpSourceSummary {
    let mut services: Vec<McpService> = overview
        .entries
        .iter()
        .filter(|e| e.source_id == location.id)
        .map(|e| McpService {
            name: e.name.clone(),
            portable: e.reason.is_none() && is_supported_transport(&e.transport),
        })
        .collect();
    services.sort_by(|a, b| a.name.cmp(&b.name));
    McpSourceSummary {
        id: location.id.clone(),
        label: source_label(location),
        harness_id: location.harness_id.clone(),
        domain: location.domain.clone(),
        place: domain_label(&location.domain),
        path: location.path.clone(),
        unreadable: location_unreadable(overview, &location.id),
        services,
    }
}

/// 同名又同处的（两个同名文件夹的项目），`place` 再带上域路径里能区分它们的那一级
fn fill_places(all: &mut [&mut McpSourceSummary]) {
    let mut groups: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
    for (i, s) in all.iter().enumerate() {
        groups
            .entry((s.label.clone(), s.place.clone()))
            .or_default()
            .push(i);
    }
    for ((_, place), group) in groups.into_iter().filter(|(_, g)| g.len() > 1) {
        let paths: Vec<PathBuf> = group
            .iter()
            .map(|&i| {
                let domain = &all[i].domain;
                PathBuf::from(domain.strip_prefix("project:").unwrap_or(domain))
            })
            .collect();
        let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
        for (&i, seg) in group.iter().zip(distinguishing_segments(&refs)) {
            if !seg.is_empty() && seg != place {
                all[i].place = format!("{place} · {seg}");
            }
        }
    }
}

/// 来源管理页：这个位置已订阅的来源，以及 `+ 来源` 的两组候选。只读。
///
/// 自己的配置只列有服务定义的（或开着规则的）：空的那几处列出来只是一排「0 个 MCP」；
/// 主视图藏起来的位置（还没建的 `.mcp.json` 等）不当来源。候选同理只列有服务的
pub fn list(
    key: &str,
    overview: &McpOverview,
    subs: &McpSubscriptions,
    rules: &[McpAutoImportRule],
) -> McpSourceList {
    let here: Vec<&str> = overview
        .locations
        .iter()
        .filter(|l| l.domain == key)
        .map(|l| l.id.as_str())
        .collect();
    let has_services = |l: &McpLocation| overview.entries.iter().any(|e| e.source_id == l.id);
    let targets_of = |l: &McpLocation| -> Vec<String> {
        rules
            .iter()
            .find(|r| r.source.id == l.id && r.target_domain == key)
            .map(|r| {
                r.targets
                    .iter()
                    .filter(|t| t.id != l.id && here.contains(&t.id.as_str()))
                    .map(|t| t.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut subscribed_list: Vec<McpSubscribedSource> = overview
        .locations
        .iter()
        .filter(|l| subscribed(l, key, subs))
        .filter_map(|l| {
            let own = is_own(l, key);
            let auto_targets = targets_of(l);
            let listed = !own || (!l.matrix_hidden && has_services(l)) || !auto_targets.is_empty();
            listed.then(|| McpSubscribedSource {
                source: summary(l, overview),
                own,
                auto_targets,
            })
        })
        .collect();

    let mut used: BTreeMap<&str, Vec<DomainName>> = BTreeMap::new();
    for (other, ids) in subs.iter().filter(|(k, _)| k.as_str() != key) {
        for id in ids {
            let entry = used.entry(id.as_str()).or_default();
            if !entry.iter().any(|d| &d.key == other) {
                entry.push(DomainName {
                    key: other.clone(),
                    label: domain_label(other),
                });
            }
        }
    }
    let mut elsewhere = Vec::new();
    let mut detected = Vec::new();
    for l in overview
        .locations
        .iter()
        .filter(|l| !subscribed(l, key, subs) && !l.matrix_hidden && has_services(l))
    {
        match used.remove(l.id.as_str()) {
            Some(used_in) => elsewhere.push(McpCandidateSource {
                source: summary(l, overview),
                used_in,
            }),
            None => detected.push(McpCandidateSource {
                source: summary(l, overview),
                used_in: Vec::new(),
            }),
        }
    }

    // 全局的排在项目前面：候选里最常用的就是全局那几处
    let order = |s: &McpSourceSummary| {
        (
            s.domain != GLOBAL,
            s.place.clone(),
            s.label.clone(),
            s.id.clone(),
        )
    };
    subscribed_list.sort_by_key(|s| (!s.own, order(&s.source)));
    elsewhere.sort_by_key(|c| order(&c.source));
    detected.sort_by_key(|c| order(&c.source));

    let mut all: Vec<&mut McpSourceSummary> = subscribed_list
        .iter_mut()
        .map(|s| &mut s.source)
        .chain(elsewhere.iter_mut().map(|c| &mut c.source))
        .chain(detected.iter_mut().map(|c| &mut c.source))
        .collect();
    fill_places(&mut all);

    McpSourceList {
        subscribed: subscribed_list,
        elsewhere,
        detected,
    }
}

/// 找到要移除的来源与本位置的全部位置；自己的配置拒绝
fn removable<'a>(
    key: &str,
    source_id: &str,
    locations: &'a [McpLocation],
) -> Result<(Option<&'a McpLocation>, Vec<&'a McpLocation>), String> {
    let here: Vec<&McpLocation> = locations.iter().filter(|l| l.domain == key).collect();
    if here.is_empty() {
        return Err("这个位置已经不在了，请刷新".into());
    }
    let source = locations.iter().find(|l| l.id == source_id);
    if let Some(s) = source {
        if is_own(s, key) {
            return Err(format!(
                "它就是{}自己的配置，要拿掉里面的服务得去改它本身",
                domain_label(key)
            ));
        }
    }
    Ok((source, here))
}

/// 目标里这一份与来源那一份仍一致：连接字段一样；Codex 的客户端设置同 agent 时也要一样，
/// 跨 agent 时目标不能带（写的时候不会带过去）。带了不认识字段的定义本来就比不了，算不一致
pub(super) fn same_copy(
    source: &McpLocation,
    def: &Canonical,
    target: &McpLocation,
    copy: &Canonical,
) -> bool {
    def.connection_eq(copy)
        && if source.harness_id == target.harness_id {
            def.client_fields == copy.client_fields
        } else {
            copy.client_fields.is_empty()
        }
}

/// 移除之前的只读清单：这个来源的服务里，本位置哪几处有一份与它一致的（服务名 × 位置）。
/// WeiboAP 的数据库不在这里改，不列。自己的配置返回拒绝的原因
pub fn plan_remove(
    key: &str,
    source_id: &str,
    locations: &[McpLocation],
) -> Result<McpSourceRemoval, String> {
    let (source, here) = removable(key, source_id, locations)?;
    let mut items = Vec::new();
    if let Some(source) = source {
        let from = super::parse(source);
        for target in here.iter().filter(|t| t.harness_id != "weiboap") {
            let parsed = super::parse(target);
            if parsed.issue.is_some() {
                continue;
            }
            for (name, def) in &from.values {
                if parsed
                    .values
                    .get(name)
                    .is_some_and(|copy| same_copy(source, def, target, copy))
                {
                    items.push(McpRemovalItem {
                        name: name.clone(),
                        target_id: target.id.clone(),
                        location: target.label.clone(),
                    });
                }
            }
        }
    }
    Ok(McpSourceRemoval {
        source_id: source_id.to_string(),
        items,
    })
}

/// 从这个位置移除一个来源：确认过的 `items` 逐项重校验——目标里那一项仍与来源此刻那一份一致
/// 才拿掉，改过的、来源里已经没有的跳过并如实报告；同一个文件的几项一次备份、一次原子写。
/// 然后从订阅记录里删掉它，撤掉它往本位置写的自动添加规则。来源本身一概不动。
/// 有没拿掉的也照样删记录：下次扫描若还有一致的副本，它会被重新认领——如实反映
pub fn remove(
    key: &str,
    source_id: &str,
    items: &[McpRemovalItem],
    locations: &[McpLocation],
    subs: &mut McpSubscriptions,
    rules: &mut Vec<McpAutoImportRule>,
) -> Result<McpReport, String> {
    let (source, here) = removable(key, source_id, locations)?;
    let mut report = McpReport::default();
    let skip_all = |report: &mut McpReport, items: &[&McpRemovalItem], message: &str| {
        for item in items {
            report.entries.push(entry(item, "skipped", message, None));
        }
    };

    // 按目标文件分组：同一个 .claude.json 里的 User / Local 必须一次写完
    let mut groups: BTreeMap<PathBuf, Vec<(&McpRemovalItem, &McpLocation)>> = BTreeMap::new();
    for item in items {
        match here.iter().copied().find(|l| l.id == item.target_id) {
            Some(target) if target.harness_id == "weiboap" => {
                skip_all(&mut report, &[item], "WeiboAP 里的配置要到 WeiboAP 里删");
            }
            Some(target) => groups
                .entry(normalize(&target.path))
                .or_default()
                .push((item, target)),
            None => skip_all(&mut report, &[item], "这个位置已经不在了"),
        }
    }
    let from = source.map(super::parse);
    for (path, group) in groups {
        let (Some(source), Some(from)) = (source, from.as_ref()) else {
            let group: Vec<&McpRemovalItem> = group.iter().map(|(i, _)| *i).collect();
            skip_all(&mut report, &group, "来源已经不在了，没动");
            continue;
        };
        remove_group(&path, source, from, &group, &mut report);
    }

    if let Some(set) = subs.get_mut(key) {
        set.remove(source_id);
    }
    rules.retain(|r| r.source.id != source_id || r.target_domain != key);
    Ok(report)
}

fn entry(
    item: &McpRemovalItem,
    outcome: &str,
    message: &str,
    backup_path: Option<PathBuf>,
) -> McpReportEntry {
    McpReportEntry {
        name: item.name.clone(),
        target_id: item.target_id.clone(),
        outcome: outcome.into(),
        message: message.into(),
        backup_path,
        identical: None,
    }
}

/// 同一个文件里的几项：读一次、逐项校验、逐项切掉、核对、备份、原子写
fn remove_group(
    path: &Path,
    source: &McpLocation,
    from: &Parsed,
    group: &[(&McpRemovalItem, &McpLocation)],
    report: &mut McpReport,
) {
    let fail = |report: &mut McpReport, message: &str| {
        for (item, _) in group {
            report.entries.push(entry(item, "failed", message, None));
        }
    };
    let state = read(path);
    let State::Present(snap) = &state else {
        for (item, _) in group {
            report
                .entries
                .push(entry(item, "skipped", "这里已经没有它了", None));
        }
        return;
    };
    if atomicfile::safe_parent(path).is_err() {
        fail(report, "目标父目录是软链接，已拒绝写入");
        return;
    }
    let mut bytes = snap.bytes.clone();
    let mut removed: Vec<&McpRemovalItem> = Vec::new();
    for (item, target) in group {
        let parsed = if toml(path) {
            parse_toml(&snap.bytes, state.clone())
        } else {
            parse_json(&snap.bytes, state.clone(), target.selector.as_deref())
        };
        let skipped = |report: &mut McpReport, message: &str| {
            report.entries.push(entry(item, "skipped", message, None));
        };
        if parsed.issue.is_some() {
            skipped(report, "这里的配置读不出来，没动");
            continue;
        }
        let Some(copy) = parsed.values.get(&item.name) else {
            skipped(report, "这里已经没有它了");
            continue;
        };
        let Some(def) = from.values.get(&item.name) else {
            skipped(report, "来源里已经没有它了，没动");
            continue;
        };
        if !same_copy(source, def, target, copy) {
            skipped(report, "和来源那份不一样了，没动");
            continue;
        }
        let next = if toml(path) {
            remove_toml_server(&bytes, &item.name)
        } else {
            remove_json_server(&bytes, target.selector.as_deref(), &item.name)
        };
        match next {
            Some(next) => {
                bytes = next;
                removed.push(item);
            }
            None => skipped(report, "这一项的写法没法安全地单独拿掉，没动"),
        }
    }
    if removed.is_empty() {
        return;
    }
    let backup_path = match backup(path, snap) {
        Ok(p) => p,
        Err(_) => {
            for item in removed {
                report
                    .entries
                    .push(entry(item, "failed", "备份失败，没动", None));
            }
            return;
        }
    };
    if atomicfile::atomic_write(path, &bytes, &FileState::Present(snap.clone())).is_err() {
        for item in removed {
            report.entries.push(entry(
                item,
                "failed",
                "写回失败（可能刚被别的程序改过），没动",
                Some(backup_path.clone()),
            ));
        }
        return;
    }
    for item in removed {
        report
            .entries
            .push(entry(item, "removed", "已拿掉", Some(backup_path.clone())));
    }
}

// ===== JSON：只切掉那一个成员 =====

/// 从 `mcpServers`（`selector` 给了就是 `projects[selector].mcpServers`）里拿掉 `name` 这个成员，
/// 其余字节原样。结果与「原文件的值去掉这一项」不相等就放弃（返回 None）
pub(super) fn remove_json_server(
    bytes: &[u8],
    selector: Option<&str>,
    name: &str,
) -> Option<Vec<u8>> {
    serde_json::from_slice::<NoDuplicates>(bytes).ok()?;
    let servers = match selector {
        None => raw_json_ranges(bytes).ok()?.2?,
        Some(project) => {
            let (_, _, root) = raw_object_members(bytes).ok()?;
            let (_, _, projects) = raw_object_members_at(bytes, *root.get("projects")?).ok()?;
            let (_, _, local) = raw_object_members_at(bytes, *projects.get(project)?).ok()?;
            *local.get("mcpServers")?
        }
    };
    let next = cut_member(bytes, servers, name)?;

    // 核对：新值 == 旧值去掉这一项
    let mut expected: Value = serde_json::from_slice(bytes).ok()?;
    let container = match selector {
        None => expected.get_mut("mcpServers")?,
        Some(project) => expected
            .get_mut("projects")?
            .get_mut(project)?
            .get_mut("mcpServers")?,
    };
    container.as_object_mut()?.remove(name)?;
    serde_json::from_slice::<NoDuplicates>(&next).ok()?;
    let actual: Value = serde_json::from_slice(&next).ok()?;
    (actual == expected).then_some(next)
}

/// 在对象 `object`（`{` 到 `}` 的字节范围）里切掉成员 `name`：连同它前面（或后面）的逗号，
/// 其余成员与空白原样
fn cut_member(bytes: &[u8], object: (usize, usize), name: &str) -> Option<Vec<u8>> {
    let (start, end, members) = raw_object_members_at(bytes, object).ok()?;
    let mut values: Vec<(usize, usize)> = members.values().copied().collect();
    values.sort();
    let target = *members.get(name)?;
    let i = values.iter().position(|v| *v == target)?;
    let range = if values.len() == 1 {
        // 唯一的成员：留下 `{}`
        start + 1..end - 1
    } else if i > 0 {
        // 从上一个值的末尾（逗号之前）切到它的值末尾
        values[i - 1].1..target.1
    } else {
        // 第一个：从它的键切到下一个键，保留 `{` 后面的缩进
        let key = skip(bytes, start + 1);
        let comma = skip(bytes, target.1);
        if bytes.get(comma) != Some(&b',') {
            return None;
        }
        key..skip(bytes, comma + 1)
    };
    let mut out = bytes.to_vec();
    out.drain(range);
    Some(out)
}

// ===== TOML：只删属于它的那几行 =====

/// 一行作为独立 TOML 解析出来的键路径：表头 `[a.b]` → `[a, b]`（`header` 为真）；
/// 键值 `a.b = 1` → `[a, b]`。解析不了的（多行值的中间几行、注释、空行）返回 None
fn line_path(line: &str) -> Option<(bool, Vec<String>)> {
    let text = line.trim();
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let doc = text.parse::<toml_edit::DocumentMut>().ok()?;
    let header = text.starts_with('[');
    let mut path = Vec::new();
    let mut table: &dyn toml_edit::TableLike = doc.as_table();
    loop {
        let mut iter = table.iter();
        let Some((key, item)) = iter.next() else {
            break;
        };
        if iter.next().is_some() {
            return None;
        }
        path.push(key.to_string());
        match item {
            toml_edit::Item::Table(t) => table = t,
            toml_edit::Item::ArrayOfTables(a) => match a.iter().last() {
                Some(t) => table = t,
                None => break,
            },
            _ => break,
        }
    }
    (!path.is_empty()).then_some((header, path))
}

fn blank_or_comment(line: &str) -> bool {
    let text = line.trim();
    text.is_empty() || text.starts_with('#')
}

/// 从 Codex 的 config.toml 里删掉 `[mcp_servers.<name>]`（连同它的子表），或 `[mcp_servers]`
/// 表里 / 根上以它开头的单行键。其余行逐字节原样（换行、BOM、注释都不动）。
/// 删完按语义核对「与原文件去掉这一项一模一样」，对不上就放弃（返回 None）——
/// 不用 toml_edit 重新序列化整个文件（它会改换行、丢 BOM）
pub(super) fn remove_toml_server(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let (bom, body) = match text.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", text),
    };
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    let prefix = ["mcp_servers".to_string(), name.to_string()];
    let ours = |path: &[String]| path.len() >= 2 && path[..2] == prefix;

    // 分段：每个表头到下一个表头之前
    let mut sections: Vec<(Vec<String>, usize, usize)> = Vec::new();
    let mut current: (Vec<String>, usize) = (Vec::new(), 0);
    for (i, line) in lines.iter().enumerate() {
        if let Some((true, path)) = line_path(line) {
            sections.push((current.0, current.1, i));
            current = (path, i);
        }
    }
    sections.push((current.0, current.1, lines.len()));

    let mut drop = vec![false; lines.len()];
    for (path, start, end) in &sections {
        if ours(path) {
            // 整段删掉，但段尾紧挨着下一个表头的注释留下（多半是写给下一个表的）
            let body_end = (*start..*end)
                .rev()
                .find(|&i| !blank_or_comment(lines[i]))
                .map_or(*start + 1, |i| i + 1);
            let keep_from = (body_end..*end)
                .find(|&i| !lines[i].trim().is_empty())
                .unwrap_or(*end);
            for flag in &mut drop[*start..keep_from] {
                *flag = true;
            }
        } else if path.is_empty() || path.as_slice() == ["mcp_servers"] {
            let first = if path.is_empty() { *start } else { *start + 1 };
            for (i, line) in lines.iter().enumerate().take(*end).skip(first) {
                if let Some((false, keys)) = line_path(line) {
                    let full: Vec<String> = path.iter().cloned().chain(keys).collect();
                    if ours(&full) {
                        drop[i] = true;
                    }
                }
            }
        }
    }
    if !drop.contains(&true) {
        return None;
    }
    let mut out = String::from(bom);
    for (line, gone) in lines.iter().zip(&drop) {
        if !gone {
            out.push_str(line);
        }
    }

    // 核对：新文件的值 == 旧文件的值去掉这一项
    let mut expected = text.parse::<toml_edit::DocumentMut>().ok()?;
    expected
        .get_mut("mcp_servers")?
        .as_table_like_mut()?
        .remove(name)?;
    let actual = out.parse::<toml_edit::DocumentMut>().ok()?;
    let mut expected = plain_table(expected.as_table());
    let actual = plain_table(actual.as_table());
    // 只剩一个空的 mcp_servers 时，删了整张表头也算一样
    if expected.get("mcp_servers") == Some(&Value::Object(Default::default()))
        && actual.get("mcp_servers").is_none()
    {
        expected.remove("mcp_servers");
    }
    (expected == actual).then(|| out.into_bytes())
}

/// TOML 的值换成不带格式的 JSON 值，只为比较语义
pub(super) fn plain_table(table: &dyn toml_edit::TableLike) -> serde_json::Map<String, Value> {
    table
        .iter()
        .filter(|(_, item)| !item.is_none())
        .map(|(key, item)| (key.to_string(), plain_item(item)))
        .collect()
}

fn plain_item(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::None => Value::Null,
        toml_edit::Item::Value(v) => plain_value(v),
        toml_edit::Item::Table(t) => Value::Object(plain_table(t)),
        toml_edit::Item::ArrayOfTables(a) => {
            Value::Array(a.iter().map(|t| Value::Object(plain_table(t))).collect())
        }
    }
}

fn plain_value(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as V;
    match value {
        V::String(s) => Value::String(s.value().clone()),
        V::Integer(i) => Value::from(*i.value()),
        V::Float(f) => Value::String(format!("float:{:?}", f.value())),
        V::Boolean(b) => Value::Bool(*b.value()),
        V::Datetime(d) => Value::String(format!("datetime:{}", d.value())),
        V::Array(a) => Value::Array(a.iter().map(plain_value).collect()),
        V::InlineTable(t) => Value::Object(plain_table(t)),
    }
}

#[cfg(test)]
mod tests;

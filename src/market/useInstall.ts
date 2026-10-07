/// 安装类推入页的状态：位置、勾了哪些 agent、计划（落点、同名、直接读取 / 每个 agent 写不写得过去）、
/// 在装、做不成那一窗。skill（安装页、从链接安装）与 MCP（安装 MCP、从 JSON 添加）各一个钩子。
/// 文案与判断都在 installView.ts；这里只管什么时候调后端、结果放哪。
import { useEffect, useMemo, useRef, useState } from "react";
import { t, type MessageKey } from "../i18n.ts";
import type { Location } from "../shell/nav.ts";
import { projectName } from "../sidebarProjects.ts";
import type { ToastText } from "../toastText.ts";
import type {
  InstallOutcome,
  LocationKey,
  McpDefinitionInput,
  McpFieldSpec,
  McpReport,
  McpTargetCheck,
  ClaudeCodeScope,
  SkillInstallPreview,
} from "../types.ts";
import type { InstallFailure } from "./InstallParts.tsx";
import {
  agentRows,
  defaultChecked,
  defaultInstallLocation,
  mcpInstallBlock,
  mcpInstalledToast,
  keyHintTip,
  keyTrackedNote,
  mcpKeyHint,
  mcpTrackedFiles,
  mcpRowView,
  projectPathOf,
  skillHandleTarget,
  skillInstalledToast,
  withTakenSkipped,
  skillPlanPending,
  skillRowView,
  takenAgents,
  writableCount,
  type AgentRef,
  type InstallKind,
  type SkillHandle,
} from "./installView.ts";
import { skillDownloadFailure, type SkillDownloadFailure } from "../netFailure.ts";
import { errorText, type MarketService } from "./service.ts";

/// 输入停下 `ms` 之后的值（粘贴 JSON 的解析、链接的读取）
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/// 进页时读一次剪贴板：`accept` 认得出、输入框还空着才填（R6 R8）
export function useClipboardPrefill(
  service: MarketService,
  accept: (text: string) => Promise<boolean> | boolean,
  fill: (text: string) => void,
  empty: () => boolean,
) {
  const live = useRef({ accept, fill, empty });
  live.current = { accept, fill, empty };
  useEffect(() => {
    let alive = true;
    void (async () => {
      const text = (await service.readClipboard()).trim();
      if (!alive || text === "" || !live.current.empty()) return;
      if ((await live.current.accept(text)) && alive && live.current.empty())
        live.current.fill(text);
    })();
    return () => {
      alive = false;
    };
    // 只在进页时读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/// 勾选行：列哪些、勾了哪些（默认按设置里的名单）
function useAgentChoice(
  kind: InstallKind,
  agents: ReadonlyArray<AgentRef>,
  shown: ReadonlyArray<string>,
) {
  const agentsKey = agents.map((a) => `${a.id}\t${a.name}`).join("\n");
  const shownKey = shown.join("\n");
  const rows = useMemo(
    () => agentRows(kind, agents, shown),
    // 调用方每次渲染给新数组，按内容比
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, agentsKey, shownKey],
  );
  const [checked, setChecked] = useState<string[]>(() => defaultChecked(kind, rows, shown));
  const toggle = (id: string, on: boolean) =>
    setChecked((prev) =>
      on
        ? rows.map((a) => a.id).filter((x) => x === id || prev.includes(x))
        : prev.filter((x) => x !== id),
    );
  return { rows, checked, setChecked, toggle };
}

/// 做不成那一窗的文案（调用本身抛错时）
const cannot = (sentence: MessageKey, names: string[], reason: string): ToastText => ({
  tier: "notice",
  kind: "cannot",
  sentence,
  names,
  agents: [],
  reason,
});

// ───────────────────────── skill ─────────────────────────

export interface SkillInstallOptions {
  service: MarketService;
  repo: string;
  /// 不知道时为 null（取默认分支，由后端补）
  branch: string | null;
  /// 要出计划的仓库内路径（安装页一个；从链接安装是仓库里找到的全部——每一行都要知道能不能装）
  planPaths: ReadonlyArray<string>;
  mine: Location;
  agents: ReadonlyArray<AgentRef>;
  shown: ReadonlyArray<string>;
}

const trimPath = (p: string) => p.replace(/^\/+|\/+$/g, "");

export function useSkillInstall(opts: SkillInstallOptions) {
  const { service, repo, branch } = opts;
  const { rows, checked, toggle } = useAgentChoice("skill", opts.agents, opts.shown);
  const [location, setLocation] = useState<LocationKey>(() => defaultInstallLocation(opts.mine));
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  /// 出计划要下载整包：下载失败时这里是说法（网络那三类带「开着代理再试一次」）
  const [planError, setPlanError] = useState<SkillDownloadFailure | null>(null);
  /// 「开着代理再试一次」：加一就按同样的条件重新出计划
  const [planRetry, setPlanRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InstallFailure | null>(null);

  // 计划只看位置与要装的：直接读取的 agent、同名拒绝都与勾了谁无关。换了位置先清掉旧的（旧的同名判断不作数）
  const pathsKey = JSON.stringify(opts.planPaths);
  const seq = useRef(0);
  const rowIds = rows.map((a) => a.id).join("\n");
  /// 计划（或出错）是按哪一组条件出的：换了位置到旧的清掉之前隔着一次渲染，那一下旧计划不作数（M14 复审）
  const planKey = JSON.stringify([repo, branch, pathsKey, location, rowIds]);
  const [planFor, setPlanFor] = useState<string | null>(null);
  useEffect(() => {
    const n = ++seq.current;
    setPreview(null);
    setPlanError(null);
    setPlanFor(planKey);
    const paths = JSON.parse(pathsKey) as string[];
    if (repo === "" || paths.length === 0) return;
    service
      .planSkillInstall({
        repo,
        branch: branch ?? "",
        paths,
        location,
        harnessIds: [],
      })
      .then((next) => {
        if (n !== seq.current) return;
        setPreview(next);
      })
      .catch((error: unknown) => {
        if (n === seq.current) setPlanError(skillDownloadFailure(error));
      });
  }, [service, repo, branch, pathsKey, location, rowIds, planKey, planRetry]);

  /// 计划里对应的那一项。只要了一项、又是按名字要的（搜索结果不知道路径）时，回来的路径是后端补上的，就取那一项
  const itemFor = (path: string) => {
    const items = preview?.plan.items ?? [];
    return (
      items.find((i) => i.path === trimPath(path)) ?? (items.length === 1 ? items[0] : undefined)
    );
  };
  const directReaders = preview?.plan.directReaders ?? [];
  /// 真要交给后端的：用户勾的（只在「另外链接给」里勾）＋ 这个位置直接读取的。直接读取的不并进 `checked`——
  /// 否则切到项目（Codex、Cursor… 直接读取）再切回用户级，它们就像被勾上了一样（2026-09-27 产品负责人实机）
  const requested = [
    ...new Set([...checked.filter((id) => !directReaders.includes(id)), ...directReaders]),
  ];
  const agentDirs = preview?.plan.agentDirs;
  const checking = skillPlanPending(preview, planError, planFor !== planKey);
  /// 这几条路径在计划里的 skill 名（被拒的不算：它们不装，也就不链）
  const namesOf = (paths: ReadonlyArray<string>) =>
    paths
      .map((p) => itemFor(p))
      .filter((i): i is NonNullable<typeof i> => i !== undefined && i.blocked === null)
      .map((i) => i.name);
  /// 这次要装的 `names` 那里全都已有同名的 agent 不能勾（M14）：勾选行画成没勾，也不交给后端
  const requestedFor = (names: ReadonlyArray<string>) => {
    const taken = takenAgents(agentDirs, names);
    return requested.filter((id) => !taken.includes(id));
  };
  const viewFor = (names: ReadonlyArray<string>) => (id: string) =>
    skillRowView(agentDirs, id, names);

  /// 装。成了（至少装上一个）返回结果与那一窗的文案，并记下这次勾的 agent；做不成在主动作上方说原因、留在这一页
  const install = async (
    paths: ReadonlyArray<string>,
    names: ReadonlyArray<string>,
  ): Promise<{ outcome: InstallOutcome; toast: ToastText; handle: SkillHandle | null } | null> => {
    // 计划还没回来：不知道哪个 agent 那里已有同名的，先不交（`安装` 此时也是禁用的）
    if (checking) return null;
    setBusy(true);
    setFailure(null);
    try {
      const harnessIds = requestedFor(namesOf(paths));
      const reply = await service.installSkill({
        repo,
        branch: branch ?? "",
        paths: [...paths],
        location,
        harnessIds,
      });
      // 那里已有同名的、没能勾的 agent 也算没链上（issue #111）：装完那一窗说出来、给「去处理」
      const outcome = withTakenSkipped(
        reply,
        agentDirs,
        requested.filter((id) => !harnessIds.includes(id)),
      );
      const toast = skillInstalledToast(outcome, opts.agents);
      if (outcome.installed.length === 0) {
        setFailure({
          key: Date.now(),
          toast:
            Object.keys(outcome.failed).length > 0
              ? toast
              : cannot("market.toast.installCannot", [...names], t("market.install.noneInstalled")),
        });
        return null;
      }
      // 有没链上的：装完那一窗的「去处理」去这次装到的位置下的那一行（issue #111）
      return { outcome, toast, handle: skillHandleTarget(outcome, location) };
    } catch (error) {
      setFailure({
        key: Date.now(),
        toast: cannot(
          "market.toast.installCannot",
          [...names],
          skillDownloadFailure(error).message,
        ),
      });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return {
    rows,
    checked,
    toggle,
    location,
    setLocation,
    preview,
    planError,
    retryPlan: () => setPlanRetry((n) => n + 1),
    itemFor,
    directReaders,
    checking,
    namesOf,
    requestedFor,
    viewFor,
    busy,
    failure,
    dismissFailure: () => setFailure(null),
    install,
  };
}

// ───────────────────────── MCP ─────────────────────────

export interface McpInstallOptions {
  service: MarketService;
  /// 要写的定义（名字已补好）；从 JSON 添加时是勾上的那几个
  definitions: ReadonlyArray<McpDefinitionInput>;
  fields: ReadonlyArray<McpFieldSpec>;
  mine: Location;
  agents: ReadonlyArray<AgentRef>;
  shown: ReadonlyArray<string>;
}

export function useMcpInstall(opts: McpInstallOptions) {
  const { service, definitions, fields } = opts;
  const { rows, checked, toggle } = useAgentChoice("mcp", opts.agents, opts.shown);
  const [location, setLocation] = useState<LocationKey>(() => defaultInstallLocation(opts.mine));
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<McpTargetCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InstallFailure | null>(null);
  /// 项目里 Claude Code 写到哪一格：默认仅自己（同 `claude mcp add` 的默认；spec 2026-09-30-mcp-claude-self-team R8）
  const [claudeScope, setClaudeScope] = useState<ClaudeCodeScope>("self");
  /// 密钥提醒（S19）的「同时加进 .gitignore」：默认不勾
  const [addToGitignore, setAddToGitignore] = useState(false);

  // 每个 agent 写不写得过去：问一次后端（只看定义与位置；不带要填的值，那些不离开这一页）
  const defsKey = JSON.stringify(definitions);
  const settledDefs = useDebounced(defsKey, 150);
  const rowIds = rows.map((a) => a.id).join("\n");
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setChecks(null);
    const defs = JSON.parse(settledDefs) as McpDefinitionInput[];
    if (defs.length === 0 || defs.some((d) => d.name.trim() === "") || rowIds === "") return;
    service
      .planMcpInstall({
        definitions: defs,
        location,
        harnessIds: rowIds.split("\n"),
        values: {},
        claudeCodeScope: claudeScope,
      })
      .then((next) => {
        if (n === seq.current) setChecks(next);
      })
      .catch(() => {
        // 检查不了：行照常能勾，写的时候由后端再判一次
        if (n === seq.current) setChecks(null);
      });
  }, [service, settledDefs, location, rowIds, claudeScope]);

  const checkOf = (id: string) => checks?.find((c) => c.harnessId === id);
  const viewOf = (id: string) => mcpRowView(checkOf(id), checked.includes(id));
  /// 勾着、而且不是整个写不过去的
  const effective = checked.filter((id) => checkOf(id)?.status !== "blocked");
  const writable = checks
    ? effective.filter((id) => {
        const s = checkOf(id)?.status;
        return s === "ok" || s === "partial";
      })
    : effective;
  const names = definitions.map((d) => d.name);
  const block = mcpInstallBlock({ names, checked: effective, checks, fields, values });
  const files = writableCount(checks, effective);
  const keyHintFiles = mcpKeyHint(checks, writable);
  const keyHint =
    keyHintFiles.length > 0
      ? keyHintTip(keyHintFiles, projectName(projectPathOf(location) ?? ""))
      : null;
  const trackedFiles = mcpTrackedFiles(checks, writable);
  const keyTracked =
    trackedFiles.length > 0 ? keyTrackedNote(trackedFiles, keyHint !== null) : null;

  const install = async (): Promise<{ report: McpReport; toast: ToastText } | null> => {
    setBusy(true);
    setFailure(null);
    try {
      const report = await service.installMcp({
        definitions: [...definitions],
        location,
        harnessIds: writable,
        values: Object.fromEntries(fields.map((f) => [f.key, values[f.key] ?? ""])),
        claudeCodeScope: claudeScope,
        // 照用户勾的交：后端写的时候自己再判一次，只给该提醒的项目文件追加（检查还没回来时也不丢）
        addToGitignore,
      });
      const toast = mcpInstalledToast(report, checks ?? [], rows, location);
      const created = report.entries.some((e) => e.outcome === "created");
      if (!created && report.entries.some((e) => e.outcome === "failed")) {
        setFailure({ key: Date.now(), toast });
        return null;
      }
      return { report, toast };
    } catch (error) {
      setFailure({
        key: Date.now(),
        toast: cannot("market.toast.writeCannot", names, errorText(error)),
      });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return {
    rows,
    checked: effective,
    toggle,
    viewOf,
    location,
    setLocation,
    /// 项目位置里 Claude Code 写到哪一格；用户级不出选择
    claudeScope,
    setClaudeScope,
    values,
    setValue: (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value })),
    /// 密钥提醒（S19）：「同时加进 .gitignore」的提示框文字；不出这个勾选时为 null
    keyHint,
    /// 目标文件已被跟踪的那一句（在勾选的位置）；没有为 null
    keyTracked,
    addToGitignore,
    setAddToGitignore,
    checks,
    files,
    block,
    busy,
    failure,
    dismissFailure: () => setFailure(null),
    install,
  };
}

/// 安装类推入页的状态：位置、勾了哪些 agent、计划（落点、同名、直接读取 / 每个 agent 写不写得过去）、
/// 在装、做不成那一窗。skill（安装页、从链接安装）与 MCP（安装 MCP、从 JSON 添加）各一个钩子。
/// 文案与判断都在 installView.ts；这里只管什么时候调后端、结果放哪。
import { useEffect, useMemo, useRef, useState } from "react";
import { t, type MessageKey } from "../i18n.ts";
import type { Location } from "../shell/nav.ts";
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
  mcpRowView,
  skillInstalledToast,
  writableCount,
  type AgentRef,
  type InstallKind,
} from "./installView.ts";
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
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InstallFailure | null>(null);

  // 计划只看位置与要装的：直接读取的 agent、同名拒绝都与勾了谁无关。换了位置先清掉旧的（旧的同名判断不作数）
  const pathsKey = JSON.stringify(opts.planPaths);
  const seq = useRef(0);
  const rowIds = rows.map((a) => a.id).join("\n");
  useEffect(() => {
    const n = ++seq.current;
    setPreview(null);
    setPlanError(null);
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
        if (n === seq.current) setPlanError(errorText(error));
      });
  }, [service, repo, branch, pathsKey, location, rowIds]);

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

  /// 装。成了（至少装上一个）返回结果与那一窗的文案，并记下这次勾的 agent；做不成在主动作上方说原因、留在这一页
  const install = async (
    paths: ReadonlyArray<string>,
    names: ReadonlyArray<string>,
  ): Promise<{ outcome: InstallOutcome; toast: ToastText } | null> => {
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await service.installSkill({
        repo,
        branch: branch ?? "",
        paths: [...paths],
        location,
        harnessIds: requested,
      });
      const toast = skillInstalledToast(outcome);
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
      return { outcome, toast };
    } catch (error) {
      setFailure({
        key: Date.now(),
        toast: cannot("market.toast.installCannot", [...names], errorText(error)),
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
    itemFor,
    directReaders,
    requested,
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
    checks,
    files,
    block,
    busy,
    failure,
    dismissFailure: () => setFailure(null),
    install,
  };
}

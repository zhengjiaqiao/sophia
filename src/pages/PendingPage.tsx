import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { api, type IgnoredIssue } from "../api.ts";
import type { IssueKind, McpDiff, McpFieldValue, Overview, SyncReport } from "../types.ts";
import {
  Busy,
  Button,
  Chip,
  DupMark,
  Spinner,
  StateDot,
  SubPage,
  Toast,
  Tooltip,
  type Dot,
  type ToastAgent,
  type ToastKind,
} from "../ui/index.ts";
import {
  KIND_LABEL,
  collectIssues,
  joinWords,
  pathsOfKey,
  type DeleteChoice,
  type PendingIssue,
  type SentencePart,
} from "./pendingIssues.ts";
import type { ModelIssue } from "../modelsView.ts";
import { defer, type Deferred } from "../deferredCommit.ts";
import "./PendingPage.css";

/// 待处理页＝**全局收件箱**（DESIGN「材料与工艺 › 全局收件箱」）：一个页面，顶部分段片
/// `Skills N · MCP N · 模型 N`（选中段反色，与筛选片同形），从哪个页签进就落在哪段；
/// `已忽略 N` 在每段内、不计入数字、可恢复——不想看到，但能找到（⑫）。
///
/// 一行：左列 16px 记号（与格内异常同形，类别名进提示框）｜句子（对象墨色、连接词灰）｜
/// 动作列。**句子列按最长一句的实际宽度，动作成一列**，行线止于动作列右沿 + 24
/// （DESIGN「提示与反馈锚在触发它的控件上」：多行各有动作时动作成一列）。
///
/// 处理完一行，**提示条出现在这一行原来的位置**（DESIGN「提示条的位置」）：例行成功是一行
/// 墨字 + `撤销`；做不成、删到废纸篓是黑显示窗。
///
/// 「忽略」记的是这一条具体状况，不是这个 skill：key 由类别 + 涉及的全部位置拼成
/// （pendingIssues.ts 的 issueKey，与 core 两边钉死），位置一变 key 就变，自然重新提示。
/// 模型段的忽略不进 core 的忽略表（那边的 IssueKind 是跨语言契约），在本机记（localStorage）。

export type PendingSegment = "skills" | "mcp" | "models";

/// skill 段的一条：pendingIssues.ts 的 `collectIssues` / `readOnlyIssue` 产出
export type SkillIssue = PendingIssue;

/// MCP 段的一条。形状与 T1 的 `mcpView.ts › collectMcpIssues`（`McpPendingItem`）一致，
/// 这里按结构写一份，不从 mcpView 引类型：两边各自演进时编译器会指出对不上的字段
export interface McpIssue {
  kind: "differentCopies" | "invalidLocation";
  /// 与 core `IgnoredIssue::key_for` 同公式
  key: string;
  /// 一句完整的话（行视角），读屏与提示框用
  title: string;
  /// 已知不一样的字段名；缺省＝说不清是哪个字段
  detailFields?: string[];
  /// 涉及的位置，顺序即句子里出现的先后
  locations: { id: string; label: string; path: string }[];
  /// 服务名；位置整份读不出来时为 null
  name: string | null;
  /// 所在域 key，跳回对应页用
  domain: string;
  /// 原样传给 `api.ignoreIssue(kind, paths)`
  paths: string[];
}

/// 模型段的一条：以 T2 的 `modelsView.ts › modelIssues` 为准
export type { ModelIssue };

export interface PendingSegments {
  skills: SkillIssue[];
  mcp: McpIssue[];
  models: ModelIssue[];
}

export interface PendingPageProps {
  /// 三段各自的待处理（**含已忽略的**，页面自己按忽略表滤）。不给时从 `overview` 现算
  /// skill 段、另两段为空（T2 接线之前的兼容路径）
  segments?: PendingSegments;
  /// 从哪个页签进来就落在哪段；默认 skills
  initialSegment?: PendingSegment;
  /** @deprecated 兼容旧壳：没有 `segments` 时用它现算 skill 段。T2 接线后删 */
  overview?: Overview | null;
  onBack: () => void;
  /// 处理完重扫（skills 与 MCP 都要），让列表反映磁盘现状
  onRefresh: () => Promise<void>;
  /// 应用级故障交给壳去挂错误横幅
  onError: (message: string) => void;
  /// 跳回对应页签的对应行并让该行闪一下（⑦）。不给就不出跳转入口
  onJumpToRow?: (segment: PendingSegment, key: string) => void;
  /// 执行模型段一条的动作（接管 / 重新写入 / 再试一次）。失败时抛出原话
  onResolveModelIssue?: (issue: ModelIssue) => Promise<void>;
}

/// 处理完一行后留在原位的提示条
interface Done {
  key: string;
  /// 这一行原来排第几：提示条插回这个位置
  index: number;
  tier: "routine" | "notice";
  kind: ToastKind;
  verb: string;
  agents?: ToastAgent[];
  names?: string[];
  reason?: string;
  stats?: string;
  undo?: () => void;
  /// 提示条到期或被关掉时要做的事（挂起的删除在这时真正提交）
  onExpire?: () => void;
  /// 收起这条提示并执行 onExpire；由 settle 一次建好
  expire: () => void;
}

/// 模型段在本机记下的忽略
interface ModelIgnored {
  key: string;
  at: string;
  sentence: string;
}

const MODEL_IGNORE_STORE = "sophia.pending.ignoredModels";

/// localStorage 可能整个不可用（隐私模式、被清）：读不到就当没忽略过，写不进就只在这一程有效
function loadModelIgnored(): ModelIgnored[] {
  try {
    const raw = window.localStorage.getItem(MODEL_IGNORE_STORE);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ModelIgnored[]) : [];
  } catch {
    return [];
  }
}

/// 模型段已忽略的 key：壳数顶栏收件箱时用（已忽略的不计数）
export function loadModelIgnoredKeys(): string[] {
  return loadModelIgnored().map((entry) => entry.key);
}

function saveModelIgnored(list: ModelIgnored[]) {
  try {
    window.localStorage.setItem(MODEL_IGNORE_STORE, JSON.stringify(list));
  } catch {
    // 存不下就只在这一程有效，不打扰用户
  }
}

const SKILL_KINDS = new Set<IssueKind>([
  "duplicateSource",
  "brokenLink",
  "wholeLinkedTarget",
  "readOnlyTarget",
]);

const MODEL_LABEL: Record<ModelIssue["kind"], string> = {
  takeover: "由别的工具管理",
  configChanged: "配置被外部改过",
  unreachable: "网关连不上",
};

/// 报告里第一条失败的原因；全成功时为 null
function failureReason(report: SyncReport): string | null {
  for (const entry of report.entries) {
    if (entry.outcome.status === "failed") return entry.outcome.reason;
  }
  return null;
}

const countBy = (report: SyncReport, status: string) =>
  report.entries.filter((e) => e.outcome.status === status).length;

// ---------- 记号 ----------

/// 16px「!」环：模型段的接管 / 配置被改过（不是格内异常，StateDot 家族里没有它）
function AttentionRing({ label }: { label: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 4.6v4.2M8 11.2v.2" />
    </svg>
  );
}

/// 左列记号：与格内异常同形，类别名进提示框（可悬停不可点 → 点状下划线）
function Mark({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={label} focusable>
      <span className="pending-page__mark" aria-label={label}>
        {children}
      </span>
    </Tooltip>
  );
}

const SKILL_DOT: Record<string, Dot> = {
  brokenLink: "broken",
  wholeLinkedTarget: "wholeLinked",
  readOnlyTarget: "readOnly",
};

function skillMark(kind: IssueKind) {
  const label = KIND_LABEL[kind];
  if (kind === "duplicateSource")
    return (
      <Mark label={label}>
        <DupMark tone="strong" />
      </Mark>
    );
  return (
    <Mark label={label}>
      <StateDot dot={SKILL_DOT[kind] ?? "readOnly"} size={16} label={label} />
    </Mark>
  );
}

function mcpMark(kind: McpIssue["kind"]) {
  const label =
    kind === "differentCopies" ? "两份不一样：同名服务配置不同" : "位置无效：读不了这个配置文件";
  return (
    <Mark label={label}>
      <StateDot dot={kind === "differentCopies" ? "blocked" : "readOnly"} size={16} label={label} />
    </Mark>
  );
}

function modelMark(kind: ModelIssue["kind"]) {
  const label = MODEL_LABEL[kind];
  return (
    <Mark label={label}>
      {kind === "unreachable" ? (
        <StateDot dot="readOnly" size={16} label={label} />
      ) : (
        <AttentionRing label={label} />
      )}
    </Mark>
  );
}

// ---------- 句子 ----------

function Sentence({ parts, onJump }: { parts: SentencePart[]; onJump?: () => void }) {
  let jumped = false;
  return (
    <>
      {parts.map((part, i) => {
        if (!part.subject) {
          return (
            <span key={i} className="pending-page__connector">
              {part.text}
            </span>
          );
        }
        // 第一个对象名兼作跳转入口：点它回到对应页签的那一行
        if (onJump && !jumped) {
          jumped = true;
          return (
            <button
              key={i}
              type="button"
              className="pending-page__subject is-jump"
              title="跳到这一行"
              onClick={onJump}
            >
              {part.text}
            </button>
          );
        }
        return (
          <span key={i} className="pending-page__subject">
            {part.text}
          </span>
        );
      })}
    </>
  );
}

/// MCP 一条的句子：服务名墨色，位置名与连接词灰（画板 PendingMcp）
function mcpParts(issue: McpIssue): SentencePart[] {
  if (issue.kind === "differentCopies" && issue.name !== null) {
    const places = issue.locations.map((l) => l.label);
    const joined = places.length === 2 ? `${places[0]} 与 ${places[1]}` : places.join("、");
    return [
      { text: issue.name, subject: true },
      { text: ` · ${joined} ${places.length === 2 ? "两" : places.length}份不一样` },
    ];
  }
  const where = issue.locations[0]?.label;
  if (where !== undefined && issue.title.startsWith(where)) {
    return [{ text: where, subject: true }, { text: issue.title.slice(where.length) }];
  }
  return [{ text: issue.title }];
}

// ---------- 字段级差异（T3b） ----------

/// 几个值共同的前缀与后缀长度（不重叠）：不同的那一段加粗，不用反色（反色已是「刚变化」）
function commonEnds(texts: string[]): [number, number] {
  if (texts.length < 2) return [0, 0];
  const shortest = Math.min(...texts.map((t) => t.length));
  let pre = 0;
  while (pre < shortest && texts.every((t) => t[pre] === texts[0][pre])) pre += 1;
  let suf = 0;
  while (
    suf < shortest - pre &&
    texts.every((t) => t[t.length - 1 - suf] === texts[0][texts[0].length - 1 - suf])
  )
    suf += 1;
  return [pre, suf];
}

function FieldValue({ value, ends }: { value: McpFieldValue; ends: [number, number] }) {
  if (value.kind === "absent") {
    return <span className="pending-diff__absent">没有这一项</span>;
  }
  if (value.kind === "secret") {
    return (
      <Tooltip content="出于安全不显示原值" focusable>
        <span className="pending-diff__secret">
          不同
          {value.last4 !== null ? (
            <>
              {" · 末 4 位 "}
              <span className="pending-diff__mono">…{value.last4}</span>
            </>
          ) : null}
        </span>
      </Tooltip>
    );
  }
  const [pre, suf] = ends;
  const text = value.text;
  const mid = text.slice(pre, text.length - suf);
  return (
    <span className="pending-diff__mono">
      {text.slice(0, pre)}
      {mid ? <b>{mid}</b> : null}
      {text.slice(text.length - suf)}
    </span>
  );
}

function DiffPanel({ issue, diff }: { issue: McpIssue; diff: McpDiff | "loading" | Error }) {
  const reveal = issue.locations[0]?.path;
  const revealLink = reveal ? (
    <div className="pending-diff__foot">
      <Button variant="external" onClick={() => void api.revealInDir(reveal)}>
        在访达中显示
      </Button>
    </div>
  ) : null;
  if (diff === "loading") {
    return (
      <div className="pending-diff">
        <div className="pending-diff__note">
          <Spinner size={14} label="正在比对" />
          正在比对
        </div>
      </div>
    );
  }
  if (diff instanceof Error) {
    return (
      <div className="pending-diff">
        <div className="pending-diff__note">没比成：{diff.message}</div>
        {revealLink}
      </div>
    );
  }
  const labelOf = (id: string) => issue.locations.find((l) => l.id === id)?.label ?? id;
  const columns = `max-content repeat(${diff.locationIds.length}, max-content)`;
  return (
    <div className="pending-diff">
      {diff.fields.length > 0 ? (
        <div className="pending-diff__grid" style={{ gridTemplateColumns: columns }}>
          <span />
          {diff.locationIds.map((id) => (
            <span key={id} className="pending-diff__place">
              {labelOf(id)}
            </span>
          ))}
          {diff.fields.map((field) => {
            const plain = field.values.flatMap((v) => (v.kind === "plain" ? [v.text] : []));
            const ends =
              plain.length === field.values.length
                ? commonEnds(plain)
                : ([0, 0] as [number, number]);
            return (
              <div key={field.field} className="pending-diff__row">
                <span className="pending-diff__field">{field.field}</span>
                {field.values.map((value, i) => (
                  <span key={i} className="pending-diff__value">
                    <FieldValue value={value} ends={ends} />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ) : diff.dynamicAuth ? null : (
        <div className="pending-diff__note">
          连接字段逐项看都一样，不一样的是只有某个 agent 认得的写法
        </div>
      )}
      {diff.dynamicAuth ? (
        <div className="pending-diff__note">认证头要到运行时才生成，没法逐字比对</div>
      ) : null}
      {diff.unreadable.length > 0 ? (
        <div className="pending-diff__note">
          {diff.unreadable.map(labelOf).join("、")} 这次读不出来，没法比
        </div>
      ) : null}
      {revealLink}
    </div>
  );
}

// ---------- 页面 ----------

export function PendingPage({
  segments,
  initialSegment = "skills",
  overview = null,
  onBack,
  onRefresh,
  onError,
  onJumpToRow,
  onResolveModelIssue,
}: PendingPageProps) {
  const [segment, setSegment] = useState<PendingSegment>(initialSegment);
  const [showIgnored, setShowIgnored] = useState(false);
  /// null = 还没读回来
  const [ignored, setIgnored] = useState<IgnoredIssue[] | null>(null);
  const [modelIgnored, setModelIgnored] = useState<ModelIgnored[]>(loadModelIgnored);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done[]>([]);
  /// MCP 两份不一样：展开着的那几条与各自的比对结果
  const [diffs, setDiffs] = useState<Record<string, McpDiff | "loading" | Error>>({});
  /// 挂起的删除（只留 X 的）：提示条到期 / 关掉 / 换段 / 离开页面时提交，撤销则丢掉
  const deferred = useRef(new Map<string, Deferred>());
  const commitAll = () => {
    for (const d of deferred.current.values()) void d.commit().catch(() => {});
    deferred.current.clear();
  };
  // 离开页面：挂着的删除全部提交（窗口关闭另有 App 的 flushAll 兜底）
  useEffect(() => () => commitAll(), []);

  /// 句子列与动作列的宽度**只增不减，冻结到离开页面**：处理完一行后那一行换成提示条，
  /// 列宽若按剩下的行重算，整列会跳一下。每段各记各的
  const pageRef = useRef<HTMLDivElement>(null);
  const [frozen, setFrozen] = useState<Record<string, [number, number]>>({});

  const skills = useMemo(
    () => segments?.skills ?? collectIssues(overview),
    [segments?.skills, overview],
  );
  const mcp = segments?.mcp ?? [];
  const models = segments?.models ?? [];

  const reloadIgnored = useCallback(async () => {
    try {
      setIgnored(await api.listIgnored());
    } catch (e) {
      onError(String(e));
    }
  }, [onError]);

  useEffect(() => {
    void reloadIgnored();
  }, [reloadIgnored]);

  // 换段时收起已忽略、清掉上一段留下的提示条；上一段挂着的删除就此提交
  useEffect(() => {
    setShowIgnored(false);
    setDone([]);
    commitAll();
  }, [segment]);

  // 量出这一段当前的句子列 / 动作列宽度，只在变宽时更新（setState 后再量结果不变，不会循环）
  useLayoutEffect(() => {
    const grid = pageRef.current?.querySelector(".pending-page__grid");
    if (!grid) return;
    const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").map(parseFloat);
    if (tracks.length < 4 || tracks.some(Number.isNaN)) return;
    const [, sentence, actions] = tracks;
    const key = `${segment}${showIgnored ? ":ignored" : ""}`;
    const prev = frozen[key] ?? [0, 0];
    if (sentence > prev[0] + 0.5 || actions > prev[1] + 0.5) {
      setFrozen((f) => ({
        ...f,
        [key]: [Math.max(sentence, prev[0]), Math.max(actions, prev[1])],
      }));
    }
  });

  const ignoredKeys = new Set([
    ...(ignored ?? []).map((i) => i.key),
    ...modelIgnored.map((i) => i.key),
  ]);
  const live = {
    skills: skills.filter((i) => !ignoredKeys.has(i.key)),
    mcp: mcp.filter((i) => !ignoredKeys.has(i.key)),
    models: models.filter((i) => !ignoredKeys.has(i.key)),
  };
  const ignoredOf = {
    skills: (ignored ?? []).filter((i) => SKILL_KINDS.has(i.kind)),
    mcp: (ignored ?? []).filter((i) => !SKILL_KINDS.has(i.kind)),
    models: modelIgnored,
  };

  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    try {
      await act();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /// 这一行处理完：提示条插回它原来的位置
  /// 到期 / 关掉的回调在这里一次建好：传给提示条的函数身份不变，它的计时器才不会每次重渲染都重来
  const settle = (key: string, index: number, toast: Omit<Done, "key" | "index" | "expire">) => {
    const expire = () => {
      setDone((prev) => prev.filter((d) => d.key !== key));
      toast.onExpire?.();
    };
    setDone((prev) => [...prev.filter((d) => d.key !== key), { key, index, ...toast, expire }]);
  };

  const dismiss = (key: string) => setDone((prev) => prev.filter((d) => d.key !== key));

  // ----- 忽略与恢复（三段共用） -----

  const restore = (key: string) =>
    void run(async () => {
      if (modelIgnored.some((i) => i.key === key)) {
        const next = modelIgnored.filter((i) => i.key !== key);
        setModelIgnored(next);
        saveModelIgnored(next);
      } else {
        await api.unignoreIssue(key);
        await reloadIgnored();
      }
      dismiss(key);
    });

  const ignoreCore = (key: string, index: number, kind: IssueKind, paths: string[], name: string) =>
    void run(async () => {
      const stored = await api.ignoreIssue(kind, paths);
      await reloadIgnored();
      settle(key, index, {
        tier: "routine",
        kind: "success",
        verb: "忽略",
        names: [name],
        undo: () => restore(stored),
      });
    });

  const ignoreModel = (issue: ModelIssue, index: number) => {
    const next = [
      ...modelIgnored.filter((i) => i.key !== issue.key),
      { key: issue.key, at: new Date().toISOString(), sentence: issue.sentence },
    ];
    setModelIgnored(next);
    saveModelIgnored(next);
    settle(issue.key, index, {
      tier: "routine",
      kind: "success",
      verb: "忽略",
      names: [issue.parts.find((p) => p.subject)?.text ?? issue.sentence],
      undo: () => restore(issue.key),
    });
  };

  // ----- skill 段的动作 -----

  const agentsOf = (issue: SkillIssue): ToastAgent[] =>
    issue.agentId !== null && issue.agent !== null
      ? [{ id: issue.agentId, name: issue.agent }]
      : [];

  /// 清除失效链接：不确认。重建一条指向不存在位置的链接没有意义，所以也不给撤销
  const clear = (issue: SkillIssue, index: number) =>
    void run(async () => {
      if (issue.clear === null) return;
      const report = await api.applyAll([issue.clear], true);
      const reason = failureReason(report);
      const name = issue.subject ?? issue.clear.itemName;
      settle(
        issue.key,
        index,
        reason === null
          ? {
              tier: "routine",
              kind: "success",
              verb: "清除",
              agents: agentsOf(issue),
              names: [name],
            }
          : {
              tier: "notice",
              kind: "cannot",
              verb: "没清除",
              agents: agentsOf(issue),
              names: [name],
              reason,
            },
      );
      await onRefresh();
    });

  /// 拆开整个文件夹是链接的目录——`split_whole_link` 在界面里唯一的入口
  const split = (issue: SkillIssue, index: number) =>
    void run(async () => {
      if (issue.splitTargetId === null) return;
      const report = await api.splitWholeLink(issue.splitTargetId);
      const created = countBy(report, "created");
      const failed = countBy(report, "failed");
      const names = issue.agent === null ? [] : [issue.agent];
      settle(
        issue.key,
        index,
        failed === 0
          ? { tier: "routine", kind: "success", verb: "拆开", agents: agentsOf(issue), names }
          : {
              tier: "notice",
              kind: created === 0 ? "cannot" : "partial",
              verb: created === 0 ? "没拆开" : "拆开",
              agents: agentsOf(issue),
              names,
              reason: failureReason(report) ?? undefined,
            },
      );
      await onRefresh();
    });

  /// 目录写不进去：原样再写一次。权限是外面改的，这里只负责重试
  const retry = (issue: SkillIssue, index: number) =>
    void run(async () => {
      const acts = await api.proposeLinks(issue.retry);
      if (acts.length === 0) {
        settle(issue.key, index, {
          tier: "notice",
          kind: "cannot",
          verb: "没开启",
          agents: agentsOf(issue),
          reason: "现在没有要补的了",
        });
        await onRefresh();
        return;
      }
      const report = await api.applyAll(acts, false);
      const created = report.entries.filter((e) => e.outcome.status === "created");
      const failed = countBy(report, "failed");
      const names = created.map((e) => e.action.itemName);
      settle(
        issue.key,
        index,
        failed === 0
          ? { tier: "routine", kind: "success", verb: "开启", agents: agentsOf(issue), names }
          : {
              tier: "notice",
              kind: created.length === 0 ? "cannot" : "partial",
              verb: created.length === 0 ? "没开启" : "开启",
              agents: agentsOf(issue),
              names,
              reason: failureReason(report) ?? undefined,
            },
      );
      await onRefresh();
    });

  /// 同名两份：只留 `keep` 的，另外几份进废纸篓。**不确认，给撤销**（⑪）：删除先挂起
  /// （deferredCommit），界面上当它已经发生；提示条到期、被关掉、换段或离开页面时才真正删，
  /// 撤销就是什么都没发生。在 git 仓库里的不代删——先体检一次，挡住就不挂起；
  /// 提交时再体检一次（计划只在后端存一份，挂起期间可能被别的删除顶掉，也可能磁盘变了）
  const keepOnly = (issue: SkillIssue, keep: DeleteChoice | null, index: number) =>
    void run(async () => {
      const drop = issue.deletes.filter((d) => d !== keep);
      for (const choice of drop) {
        const planned = await api.planDeleteSource(choice.sourceId, choice.skill);
        if (planned.plan.inGit !== null) {
          settle(issue.key, index, {
            tier: "notice",
            kind: "cannot",
            verb: "没删掉",
            names: [`${choice.label} 的 ${choice.skill}`],
            reason: "它在 git 仓库里，交给 git 处理更稳妥",
            stats: planned.plan.inGit,
          });
          return;
        }
      }
      const d = defer(`keep:${issue.key}`, async () => {
        for (const choice of drop) {
          const planned = await api.planDeleteSource(choice.sourceId, choice.skill);
          if (planned.plan.inGit !== null) throw new Error("它在 git 仓库里，交给 git 处理更稳妥");
          const reason = failureReason(await api.deleteSource(planned.planId));
          if (reason !== null) throw new Error(reason);
        }
      });
      deferred.current.set(issue.key, d);
      const kept = keep ?? null;
      const commit = () => {
        deferred.current.delete(issue.key);
        void d
          .commit()
          .then(onRefresh)
          .catch((e) => {
            settle(issue.key, index, {
              tier: "notice",
              kind: "cannot",
              verb: "没删掉",
              names: drop.map((c) => `${c.label} 的 ${c.skill}`),
              reason: e instanceof Error ? e.message : String(e),
            });
            void onRefresh();
          });
      };
      settle(issue.key, index, {
        tier: "notice",
        kind: "success",
        verb: kept === null ? "删到废纸篓" : "只留",
        names: [
          kept === null
            ? `${drop[0]?.label ?? ""} 的 ${issue.subject ?? ""}`
            : `${kept.label} 的 ${issue.subject ?? kept.skill}`,
        ],
        undo: () => {
          d.undo();
          deferred.current.delete(issue.key);
          dismiss(issue.key);
        },
        onExpire: commit,
      });
    });

  // ----- MCP 段的动作 -----

  const toggleDiff = (issue: McpIssue) => {
    if (diffs[issue.key] !== undefined) {
      setDiffs((prev) => {
        const next = { ...prev };
        delete next[issue.key];
        return next;
      });
      return;
    }
    if (issue.name === null) return;
    const name = issue.name;
    setDiffs((prev) => ({ ...prev, [issue.key]: "loading" }));
    api
      .mcpFieldDiff(
        name,
        issue.locations.map((l) => l.id),
      )
      .then(
        (diff) =>
          setDiffs((prev) =>
            prev[issue.key] === undefined ? prev : { ...prev, [issue.key]: diff },
          ),
        (e) =>
          setDiffs((prev) =>
            prev[issue.key] === undefined ? prev : { ...prev, [issue.key]: new Error(String(e)) },
          ),
      );
  };

  // ----- 模型段的动作 -----

  const MODEL_VERB = { takeover: "接管", rewrite: "重新写入", retry: "再试一次" } as const;
  const MODEL_NOT_VERB = { takeover: "没接管", rewrite: "没写入", retry: "还是连不上" } as const;

  const resolveModel = (issue: ModelIssue, index: number) =>
    void (async () => {
      if (!onResolveModelIssue) return;
      setBusy(true);
      const subject = issue.parts.find((p) => p.subject)?.text ?? "";
      try {
        await onResolveModelIssue(issue);
        settle(issue.key, index, {
          tier: "routine",
          kind: "success",
          verb: MODEL_VERB[issue.action.kind],
          names: subject ? [subject] : [],
        });
      } catch (e) {
        settle(issue.key, index, {
          tier: "notice",
          kind: "cannot",
          verb: MODEL_NOT_VERB[issue.action.kind],
          names: subject ? [subject] : [],
          reason: String(e),
        });
      } finally {
        setBusy(false);
      }
    })();

  // ----- 渲染 -----

  const ignoreLink = (onClick: () => void) => (
    <Button variant="link" onClick={onClick}>
      忽略
    </Button>
  );

  const jump = (key: string) => (onJumpToRow ? () => onJumpToRow(segment, key) : undefined);

  const row = (
    key: string,
    mark: ReactNode,
    sentence: ReactNode,
    actions: ReactNode,
    extra?: ReactNode,
  ) => (
    <div className={`pending-page__row${extra ? " is-open" : ""}`} key={key}>
      <div className="pending-page__markcell">{mark}</div>
      <div className="pending-page__sentence">{sentence}</div>
      <div className="pending-page__actions">{actions}</div>
      {extra ? <div className="pending-page__extra">{extra}</div> : null}
    </div>
  );

  const doneRow = (d: Done) => (
    <div className={`pending-page__row is-done is-${d.tier}`} key={`done:${d.key}`}>
      <Toast
        tier={d.tier}
        kind={d.kind}
        verb={d.verb}
        agents={d.agents}
        names={d.names}
        reason={d.reason}
        stats={d.tier === "notice" ? d.stats : undefined}
        action={d.undo ? { label: "撤销", onClick: d.undo } : undefined}
        onDismiss={d.expire}
        onClose={d.tier === "notice" ? d.expire : undefined}
      />
    </div>
  );

  const skillActions = (issue: SkillIssue, index: number) => {
    const ignore = ignoreLink(() =>
      ignoreCore(
        issue.key,
        index,
        issue.kind,
        issue.paths,
        issue.subject ?? issue.agent ?? "这一条",
      ),
    );
    switch (issue.kind) {
      case "duplicateSource":
        return (
          <>
            <span className="pending-page__buttons">
              {issue.deletes.length > 1 ? (
                issue.deletes.map((choice) => (
                  <Button
                    key={choice.sourceId}
                    size="compact"
                    title="另一份进废纸篓"
                    onClick={() => keepOnly(issue, choice, index)}
                  >
                    {joinWords("只留", choice.label, "的")}
                  </Button>
                ))
              ) : (
                <Button
                  size="compact"
                  title="这一份进废纸篓"
                  onClick={() => keepOnly(issue, null, index)}
                >
                  {joinWords("删", issue.deletes[0]?.label ?? "", "的")}
                </Button>
              )}
            </span>
            {ignore}
          </>
        );
      case "brokenLink":
        return (
          <>
            <span className="pending-page__buttons">
              <Button size="compact" onClick={() => clear(issue, index)}>
                清除
              </Button>
            </span>
            {ignore}
          </>
        );
      case "wholeLinkedTarget":
        return (
          <>
            <span className="pending-page__buttons">
              <Button
                size="compact"
                title="把链接换成真文件夹，里面的内容原样复制过来"
                onClick={() => split(issue, index)}
              >
                拆开
              </Button>
            </span>
            {ignore}
          </>
        );
      default:
        return (
          <>
            <span className="pending-page__buttons">
              <Button size="compact" onClick={() => retry(issue, index)}>
                再试一次
              </Button>
            </span>
            {ignore}
          </>
        );
    }
  };

  /// 一段的行：待处理的行按原顺序，处理过的那几行原位换成提示条
  const withDone = (keys: string[], render: (index: number) => ReactNode): ReactNode[] => {
    const out: ReactNode[] = keys.map((key, index) => {
      const d = done.find((x) => x.key === key);
      return d ? doneRow(d) : render(index);
    });
    // 行已经从数据里消失（处理成功后重扫）：提示条按记下的位置插回去
    const gone = done.filter((d) => !keys.includes(d.key)).sort((x, y) => x.index - y.index);
    for (const d of gone) out.splice(Math.min(d.index, out.length), 0, doneRow(d));
    return out;
  };

  const skillRows = () =>
    withDone(
      live.skills.map((i) => i.key),
      (index) => {
        const issue = live.skills[index];
        return row(
          issue.key,
          skillMark(issue.kind),
          <Sentence parts={issue.parts} onJump={jump(issue.key)} />,
          skillActions(issue, index),
        );
      },
    );

  const mcpRows = () =>
    withDone(
      live.mcp.map((i) => i.key),
      (index) => {
        const issue = live.mcp[index];
        const open = diffs[issue.key];
        const ignore = ignoreLink(() =>
          ignoreCore(
            issue.key,
            index,
            issue.kind,
            issue.paths,
            issue.name ?? issue.locations[0]?.label ?? "这一条",
          ),
        );
        if (issue.kind === "differentCopies") {
          return row(
            issue.key,
            mcpMark(issue.kind),
            <>
              <Sentence parts={mcpParts(issue)} onJump={jump(issue.key)} />
              {issue.name !== null ? (
                <span className="pending-page__inline">
                  <Button variant="link" onClick={() => toggleDiff(issue)}>
                    {open === undefined ? "看两边差在哪" : "收起"}
                  </Button>
                </span>
              ) : null}
            </>,
            ignore,
            open === undefined ? undefined : <DiffPanel issue={issue} diff={open} />,
          );
        }
        const path = issue.locations[0]?.path;
        return row(
          issue.key,
          mcpMark(issue.kind),
          <Sentence parts={mcpParts(issue)} onJump={jump(issue.key)} />,
          <>
            {path ? (
              <Button variant="external" onClick={() => void api.revealInDir(path)}>
                打开文件
              </Button>
            ) : null}
            {ignore}
          </>,
        );
      },
    );

  const modelRows = () =>
    withDone(
      live.models.map((i) => i.key),
      (index) => {
        const issue = live.models[index];
        return row(
          issue.key,
          modelMark(issue.kind),
          <Sentence parts={issue.parts} onJump={jump(issue.key)} />,
          <>
            <span className="pending-page__buttons">
              {onResolveModelIssue ? (
                <Button size="compact" onClick={() => resolveModel(issue, index)}>
                  {issue.action.label}
                </Button>
              ) : (
                <Button size="compact" disabled disabledReason="到模型页里处理">
                  {issue.action.label}
                </Button>
              )}
            </span>
            {ignoreLink(() => ignoreModel(issue, index))}
          </>,
        );
      },
    );

  /// 已忽略：同一张列表的另一个视图，动作换成 `恢复提示`
  const ignoredRows = () => {
    const list = ignoredOf[segment];
    if (list.length === 0) return <div className="pending-page__empty">还没有忽略过什么</div>;
    return list.map((entry) => {
      const sentence = (() => {
        if (segment === "skills") {
          const found = skills.find((i) => i.key === entry.key);
          if (found) return <Sentence parts={found.parts} />;
        } else if (segment === "mcp") {
          const found = mcp.find((i) => i.key === entry.key);
          if (found) return <Sentence parts={mcpParts(found)} />;
        } else {
          const found = models.find((i) => i.key === entry.key);
          if (found) return <Sentence parts={found.parts} />;
          return (
            <span className="pending-page__connector">{(entry as ModelIgnored).sentence}</span>
          );
        }
        // 状况已经不在了：key 里留着可读的路径，照样摆出来
        return (
          <span className="pending-page__connector">
            已经不在了 · {pathsOfKey(entry.key).join(" · ")}
          </span>
        );
      })();
      const kind = "kind" in entry ? entry.kind : null;
      const mark =
        kind === null
          ? modelMark(models.find((i) => i.key === entry.key)?.kind ?? "configChanged")
          : SKILL_KINDS.has(kind)
            ? skillMark(kind)
            : mcpMark(kind === "differentCopies" ? "differentCopies" : "invalidLocation");
      return row(
        entry.key,
        mark,
        sentence,
        <span className="pending-page__buttons">
          <Button size="compact" onClick={() => restore(entry.key)}>
            恢复提示
          </Button>
        </span>,
      );
    });
  };

  const rows = () => {
    if (showIgnored) return ignoredRows();
    const out = segment === "skills" ? skillRows() : segment === "mcp" ? mcpRows() : modelRows();
    if (out.length === 0) return <div className="pending-page__empty">没有要你拿主意的事</div>;
    return out;
  };

  const counts = { skills: live.skills.length, mcp: live.mcp.length, models: live.models.length };
  const ignoredCount = ignoredOf[segment].length;

  return (
    <SubPage title="待处理" onBack={onBack}>
      <div
        className="pending-page"
        ref={pageRef}
        style={
          {
            "--pending-sentence-w": `${frozen[`${segment}${showIgnored ? ":ignored" : ""}`]?.[0] ?? 0}px`,
            "--pending-actions-w": `${frozen[`${segment}${showIgnored ? ":ignored" : ""}`]?.[1] ?? 0}px`,
          } as CSSProperties
        }
      >
        <Busy busy={busy} className="pending-page__grid">
          <div className="pending-page__segments">
            {(["skills", "mcp", "models"] as const).map((id) => (
              <Chip
                key={id}
                selected={segment === id}
                count={counts[id]}
                onClick={() => setSegment(id)}
              >
                {id === "skills" ? "Skills" : id === "mcp" ? "MCP" : "模型"}
              </Chip>
            ))}
            <span className="pending-page__ignored">
              {showIgnored ? (
                <Button variant="link" onClick={() => setShowIgnored(false)}>
                  {`待处理 ${counts[segment]}`}
                </Button>
              ) : ignoredCount > 0 ? (
                <Button variant="link" onClick={() => setShowIgnored(true)}>
                  {`已忽略 ${ignoredCount}`}
                </Button>
              ) : null}
            </span>
          </div>
          {rows()}
        </Busy>
      </div>
    </SubPage>
  );
}

export default PendingPage;

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, type IgnoredIssue } from "../api.ts";
import type { DeleteSourcePlan, Overview, SyncReport } from "../types.ts";
import { Busy, Button, Confirm, Empty, SubPage, Toast, type ToastKind } from "../ui/index.ts";
import {
  KIND_LABEL,
  collectIssues,
  formatBytes,
  pathsOfKey,
  type DeleteChoice,
  type PendingIssue,
} from "./pendingIssues.ts";
import "./PendingPage.css";

/// 待处理页（组件规范 §4.3、§4.6）：**还要你拿主意的事全在这儿**。
/// 提示条说刚做完什么，这一页说还没定的事，二者不重叠。
///
/// 四类问题各带自己的动作：同名本体 `删 X 的`、链接失效 `清除`、
/// 整目录链接 `拆开`、目录不可写 `再试一次`，加上共同的 `忽略`。
///
/// **`拆开` 是 `split_whole_link` 在新界面里唯一的入口**（§8 约束 4）：旧表头的
/// 「整目录链接」徽标和「拆成逐项链接」按钮都没了，这里不给入口，这个能力就永久触达不到。
///
/// 「忽略」记的是**这一条具体状况**，不是记这个 skill：key 由类别 + 涉及的全部位置拼成，
/// 位置一变 key 就变，界面自然重新提示一次（见 pendingIssues.ts）。

/// 提示条的一次内容。`undoKey` 非空时给「撤销」——目前只有忽略是可撤的
interface Note {
  kind: ToastKind;
  message: string;
  stats?: string;
  undoKey?: string;
}

/// 已经体检过、正等用户确认的一次删除。两次调用之间卡着确认，不能合成一次
interface Asking {
  planId: string;
  plan: DeleteSourcePlan;
  choice: DeleteChoice;
}

export interface PendingPageProps {
  /// 当前扫描结果；null = 还没扫回来
  overview: Overview | null;
  onBack: () => void;
  /// 处理完重扫，让列表反映磁盘现状
  onRefresh: () => Promise<void>;
  /// 应用级故障交给壳去挂错误横幅（§4.2）
  onError: (message: string) => void;
}

/// 报告里第一条失败的原因；全成功时为 null
function failureReason(report: SyncReport): string | null {
  for (const entry of report.entries) {
    if (entry.outcome.status === "failed") return entry.outcome.reason;
  }
  return null;
}

const countBy = (report: SyncReport, status: string) =>
  report.entries.filter((e) => e.outcome.status === status).length;

/// 忽略时间：后端给的是 RFC 3339 的 UTC，本地化到分钟就够——秒对这件事没有意义
function when(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/// 确认弹窗里那句「有多少条链接会因此失效」（§10 第 2 条）。
/// 删完会不会有别处接住它们，是用户这一刻最需要知道的
function affectedLine(plan: DeleteSourcePlan): string {
  const n = plan.affected.length;
  if (n === 0) return "没有链接指向它。";
  if (plan.relinkTo !== null) return `${n} 条链接指向它，删完自动改指到 ${plan.relinkTo}。`;
  return `${n} 条链接指向它，删完这些链接就指不到东西了。`;
}

export function PendingPage({ overview, onBack, onRefresh, onError }: PendingPageProps) {
  const [tab, setTab] = useState<"pending" | "ignored">("pending");
  /// null = 还没读回来
  const [ignored, setIgnored] = useState<IgnoredIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);

  const issues = useMemo(() => collectIssues(overview), [overview]);

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

  // Confirm 与 SubPage 都在 document 上听 Esc：不拦的话按一下既关弹窗、又退回主视图。
  // 在 window 的捕获阶段先截住，弹窗开着时 Esc 只作用于弹窗
  useEffect(() => {
    if (asking === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setAsking(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [asking]);

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

  /// 清除失效链接：**不确认、也不给撤销**（§5）。删掉零损失，条数和路径这一页已经摆在眼前；
  /// 重建一条指向不存在路径的链接也没有意义
  const clear = (issue: PendingIssue) =>
    void run(async () => {
      if (issue.clear === null) return;
      const report = await api.applyAll([issue.clear], true);
      const reason = failureReason(report);
      setNote(
        reason === null
          ? {
              kind: "success",
              message: `清掉了 ${issue.subject ?? "这"} 那条指向不存在位置的链接`,
              stats: issue.detail,
            }
          : { kind: "cannot", message: reason },
      );
      await onRefresh();
    });

  /// 拆开整目录链接——`split_whole_link` 在新界面里唯一的入口
  const split = (issue: PendingIssue) =>
    void run(async () => {
      if (issue.splitTargetId === null) return;
      const report = await api.splitWholeLink(issue.splitTargetId);
      const created = countBy(report, "created");
      const failed = countBy(report, "failed");
      const agent = issue.agent ?? "这个 agent";
      setNote(
        failed === 0
          ? {
              kind: "success",
              message: `拆开了 ${agent} 的 skills 目录，现在可以逐条开关`,
              stats: `新建了 ${created} 条链接`,
            }
          : {
              kind: "partial",
              message: `拆到一半停下了——${failureReason(report) ?? ""}`,
              stats: `新建了 ${created} 条链接`,
            },
      );
      await onRefresh();
    });

  /// 目录写不进去：原样再写一次。权限是外面改的，这里只负责重试
  const retry = (issue: PendingIssue) =>
    void run(async () => {
      const agent = issue.agent ?? "这个 agent";
      const acts = await api.proposeLinks(issue.retry);
      if (acts.length === 0) {
        setNote({ kind: "cannot", message: `${agent} 下现在没有要补的东西了` });
        await onRefresh();
        return;
      }
      const report = await api.applyAll(acts, false);
      const created = countBy(report, "created");
      const failed = countBy(report, "failed");
      setNote(
        failed === 0
          ? {
              kind: "success",
              message: `在 ${agent} 下开启了 ${created} 个 skill`,
              stats: `新建了 ${created} 条链接`,
            }
          : {
              kind: "partial",
              message: `${created} 个开启了，${failed} 个还是写不进去`,
              stats: failureReason(report) ?? undefined,
            },
      );
      await onRefresh();
    });

  /// 删本体第一步：只读体检，什么都不动。结果摆进确认弹窗（§10 第 2 条）
  const askDelete = (choice: DeleteChoice) =>
    void run(async () => {
      const planned = await api.planDeleteSource(choice.sourceId, choice.skill);
      setAsking({ planId: planned.planId, plan: planned.plan, choice });
    });

  /// 删本体第二步：用户确认之后才真的删。与体检分成两次调用，合并就等于无确认删除
  const confirmDelete = () => {
    if (asking === null) return;
    const { planId, plan, choice } = asking;
    setAsking(null);
    void run(async () => {
      const report = await api.deleteSource(planId);
      const reason = failureReason(report);
      const affected = plan.affected.length;
      setNote(
        reason === null
          ? {
              kind: "success",
              message: `把 ${choice.label} 里的 ${choice.skill} 移到了废纸篓`,
              stats:
                affected === 0
                  ? undefined
                  : plan.relinkTo !== null
                    ? `${affected} 条链接已改指到留下的那一处`
                    : `${affected} 条链接现在指不到东西了`,
            }
          : { kind: "cannot", message: reason },
      );
      await onRefresh();
    });
  };

  /// 忽略这一条具体状况。可撤，所以提示条给「撤销」
  const ignore = (issue: PendingIssue) =>
    void run(async () => {
      const key = await api.ignoreIssue(issue.kind, issue.paths);
      await reloadIgnored();
      setNote({
        kind: "success",
        message: "已忽略。涉及的位置变了会再提一次",
        undoKey: key,
      });
    });

  const restore = (key: string) =>
    void run(async () => {
      await api.unignoreIssue(key);
      await reloadIgnored();
      setNote({ kind: "success", message: "恢复提示了，这一条又回到待处理" });
    });

  const ignoredList = ignored ?? [];
  const ignoredKeys = new Set(ignoredList.map((i) => i.key));
  const pending = issues.filter((i) => !ignoredKeys.has(i.key));
  /// 已忽略那张表要借用还在的那条状况的说法，两张表说的是同一件事
  const byKey = new Map(issues.map((i) => [i.key, i]));

  const ignoreButton = (issue: PendingIssue) => (
    <Button variant="link" onClick={() => ignore(issue)}>
      忽略
    </Button>
  );

  /// 四类问题各自的动作（§4.3）。一类一种动作，不互相借用
  const actionsOf = (issue: PendingIssue) => {
    switch (issue.kind) {
      case "duplicateSource":
        return (
          <>
            {issue.deletes.map((choice) => (
              <Button key={choice.sourceId} size="compact" onClick={() => askDelete(choice)}>
                {`删 ${choice.label} 的`}
              </Button>
            ))}
            {ignoreButton(issue)}
          </>
        );
      case "brokenLink":
        return (
          <>
            <Button size="compact" onClick={() => clear(issue)}>
              清除
            </Button>
            {ignoreButton(issue)}
          </>
        );
      case "wholeLinkedTarget":
        return (
          <>
            <Button size="compact" onClick={() => split(issue)}>
              拆开
            </Button>
            {ignoreButton(issue)}
          </>
        );
      case "readOnlyTarget":
        return (
          <>
            <Button size="compact" onClick={() => retry(issue)}>
              再试一次
            </Button>
            {ignoreButton(issue)}
          </>
        );
    }
  };

  const row = (
    key: string,
    kindLabel: string,
    main: ReactNode,
    detail: string,
    actions: ReactNode,
  ) => (
    <div className="pending-page__row" key={key}>
      <span className="pending-page__kind">{kindLabel}</span>
      <div className="pending-page__what">
        <div className="pending-page__line">{main}</div>
        <div className="pending-page__detail">{detail}</div>
      </div>
      <div className="pending-page__actions">{actions}</div>
    </div>
  );

  const mainOf = (issue: PendingIssue) => (
    <>
      {/* skill 名用正文档、原样渲染：等宽只给路径与计数（§1.2） */}
      {issue.subject !== null ? <span className="pending-page__name">{issue.subject}</span> : null}
      {issue.text}
    </>
  );

  const pendingTab =
    overview === null ? (
      <Empty kind="scanning" />
    ) : pending.length === 0 ? (
      <Empty kind="noMatch" description="没有要你拿主意的事。" />
    ) : (
      <div className="pending-page__list">
        {pending.map((issue) =>
          row(issue.key, KIND_LABEL[issue.kind], mainOf(issue), issue.detail, actionsOf(issue)),
        )}
      </div>
    );

  /// 已忽略是同一张列表的另一个视图：右侧动作换成 `恢复提示`，副行补上忽略时间
  const ignoredTab =
    ignored === null ? (
      <Empty kind="scanning" description="读取中…" />
    ) : ignored.length === 0 ? (
      <Empty kind="noMatch" description="还没有忽略过什么。" />
    ) : (
      <div className="pending-page__list">
        {ignored.map((entry) => {
          const live = byKey.get(entry.key);
          // 状况已经不在了：key 里留着可读的路径，照样摆出来，并说清它已经不在
          const main = live ? mainOf(live) : "这一条已经不在了，恢复提示也不会再出现";
          const detail = `${live ? live.detail : pathsOfKey(entry.key).join(" · ")} · 忽略于 ${when(entry.at)}`;
          return row(
            entry.key,
            KIND_LABEL[entry.kind],
            main,
            detail,
            <Button size="compact" onClick={() => restore(entry.key)}>
              恢复提示
            </Button>,
          );
        })}
      </div>
    );

  const tabButton = (id: "pending" | "ignored", label: string, count: number) => (
    <button
      type="button"
      className={`pending-page__tab${tab === id ? " is-active" : ""}`}
      aria-pressed={tab === id}
      onClick={() => setTab(id)}
    >
      <span className="pending-page__tab-name">{label}</span>
      <span className="pending-page__tab-count">{count}</span>
    </button>
  );

  return (
    <SubPage title="待处理" onBack={onBack}>
      <div className="pending-page">
        <div className="pending-page__tabs">
          {tabButton("pending", "待处理", pending.length)}
          {tabButton("ignored", "已忽略", ignoredList.length)}
        </div>

        <Busy busy={busy}>{tab === "pending" ? pendingTab : ignoredTab}</Busy>

        <div className="pending-page__foot">
          忽略记的是这一条具体状况，不是记这个 skill：牵涉的位置变了会重新提一次。
        </div>
      </div>

      {asking !== null ? (
        <Confirm
          // 标题里嵌了 skill 名：整个标题不做大小写转换，名字本身走正文档（§1.2）
          title={
            <>
              删掉 {asking.choice.label} 里的{" "}
              <span className="pending-page__name">{asking.choice.skill}</span>
            </>
          }
          body="本体目录会移到系统废纸篓，不是彻底删除。"
          warning={
            <div className="pending-page__facts">
              <div className="pending-page__mono">{asking.plan.path}</div>
              <div>
                {asking.plan.entries} 个条目 · {formatBytes(asking.plan.bytes)}
              </div>
              <div>{affectedLine(asking.plan)}</div>
              {asking.plan.inGit !== null ? (
                <div>
                  它在 git 仓库 <span className="pending-page__mono">{asking.plan.inGit}</span>{" "}
                  里。仓库里的东西交给 git 处理更稳妥，这里不代删。
                </div>
              ) : null}
            </div>
          }
          confirmLabel="删到废纸篓"
          destructive
          onConfirm={confirmDelete}
          confirmDisabledReason={
            asking.plan.inGit === null
              ? undefined
              : `它在 git 仓库 ${asking.plan.inGit} 里，这里不代删`
          }
          cancelLabel={asking.plan.inGit === null ? "取消" : "知道了"}
          onCancel={() => setAsking(null)}
        />
      ) : null}

      {note !== null ? (
        <Toast
          kind={note.kind}
          message={note.message}
          stats={note.stats}
          action={
            note.undoKey === undefined
              ? undefined
              : { label: "撤销", onClick: () => restore(note.undoKey as string) }
          }
          onDismiss={() => setNote(null)}
          onClose={() => setNote(null)}
        />
      ) : null}
    </SubPage>
  );
}

export default PendingPage;

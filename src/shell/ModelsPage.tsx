import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { parseBackendError } from "../backendError.ts";
import { PORT_FIRST, routerTodo, routerUnavailable } from "../modelsView.ts";
import { PickModels } from "../PickModels.tsx";
import { pickButtonLabel, pickOptimistic, reorderOptimistic, unpicksLast } from "../pickView.ts";
import { agentGateway, withAgentGateway } from "../types.ts";
import type { GatewayAgent, GatewayState, GatewayUnreadable, ModelRef } from "../types.ts";
import { copyDetails } from "../diagnostics.ts";
import { HINTS, useHint } from "../hints.ts";
import {
  AgentIcon,
  Button,
  Empty,
  IconChevronDown,
  NoticePanel,
  PageHead,
  PageTitle,
} from "../ui/index.ts";
import { ProvidersPage } from "../ProvidersPage.tsx";
import {
  modelsNameOf,
  pageSections,
  type AgentEntry,
  type AgentSectionProps,
  type AgentState,
} from "./agentRegistry.ts";
import "./ModelsPage.css";

/// 模型页（#259，ADR 0003，画板 9UGdeLt4rvg2dm8SpStvHo 第 1、1′ 屏；DESIGN「### 模型」）：**一层**——一个 agent 一行，
/// 没有二级页。只列装了的、能接第三方模型的 agent（注册表的节级 `available`，不看设置）。
///
/// - 页面头：`模型`（与侧栏同名）+ 右端 `模型提供商`（推入全局提供商页）。读不到状态、路由没在跑、另一个 Sophia 在跑这类
///   影响每一家的灰面板挂在页面头下、列表之上
/// - 一行：16 图标 + 8 + 名字；第二行按提供商的计数（`官方 2 · Kimi 2 · DeepSeek 1`，注册表 `listRow.status`），
///   后面接一句灰字（开着时的代价、换了端口，`listRow.note`）；右端 `已选 N 个模型 ▾`（一个没选 `选模型 ▾`）打开
///   选模型浮层（PickModels），再后面是条件键（`重启生效` …）与开关（`listRow.Controls`）
/// - 行下：待办条（接管、重新写入，`listRow.Todos`）与没写成的灰面板（控件经 `onNotice` 交过来）
/// - 勾选与排序在浮层里：先画成做成之后的样子，写盘在后台；没成退回后端给的状态、行下说原因。
///   开着时取消最后一个第三方模型＝关掉这一家（同今天的规则，不确认）
///
/// 整页限宽 776、左沿＝机面内左沿（App.css `.agent-page`）。
/// `loading`：还没问出后端支不支持第三方模型（上次停在这一页、刚打开时）——出忙碌空态，不留一张只有标题的空页

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

// ===== 页面头下的灰面板 =====

/// 读不到第三方模型的状态（spec 2026-10-04-local-diagnostics R11，画板 AuPbAQHePv3L1U3g1PAtH8）：页面头下一块灰面板
/// `读不到第三方模型的状态 · <文件> <原因>`，键按种类给往前走的路，都带 `详情`（原文在浮层里）——
/// 没权限 `修复权限`（系统密码框，做成后自动重读）；格式有误 `打开文件 ↗` + `再试一次`；别的 `再试一次`。
/// 入口不因此消失（原来读不到就把侧栏「模型」藏掉）
function UnreadableNotice({
  issue,
  onGatewayState,
  onError,
}: {
  issue: GatewayUnreadable;
  onGatewayState: (state: GatewayState) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, job: () => Promise<GatewayState>) => {
    setBusy(label);
    try {
      onGatewayState(await job());
    } catch (error) {
      const parsed = parseBackendError(String(error));
      // 在系统密码框里点了取消：不是错，什么都不说
      if (parsed.code !== "cancelled") onError(parsed.message);
    } finally {
      setBusy(null);
    }
  };
  const retry = {
    label: t("models.gateway.retry"),
    onClick: () => void run(t("common.empty.busy"), api.gatewayState),
  };
  const action =
    issue.kind === "permission"
      ? {
          label: t("models.unreadable.fixOwner"),
          onClick: () =>
            void run(t("models.unreadable.fixing"), () => api.gatewayFixFileOwner(issue.path)),
        }
      : issue.kind === "format"
        ? {
            label: t("models.unreadable.openFile"),
            leave: true,
            onClick: () =>
              void api.gatewayOpenFile(issue.path).catch((e) => onError(describeError(e))),
          }
        : retry;
  return (
    <NoticePanel
      scope="section"
      message={t("models.unreadable.title")}
      reason={issue.reason || undefined}
      technical={issue.detail || undefined}
      onCopy={(text) => copyDetails(text)}
      action={action}
      secondary={issue.kind === "format" ? retry : undefined}
      busy={busy ?? undefined}
    />
  );
}

export function ModelsPage({
  entries,
  state,
  loading = false,
  ...props
}: {
  entries: ReadonlyArray<AgentEntry>;
  /// 与侧栏、托盘同一种只读状态：节级可用据它判断（行的现状句、开关也读它）
  state: AgentState;
  loading?: boolean;
} & AgentSectionProps) {
  const { onGatewayState } = props;
  /// 模型提供商页推入着没有（页面头 `模型提供商`）
  const [providersOpen, setProvidersOpen] = useState(false);
  const providersKey = useRef<HTMLSpanElement>(null);
  /// 选模型浮层开在哪一行、挂在哪颗键上
  const [picking, setPicking] = useState<{ id: string; trigger: HTMLElement } | null>(null);
  const pickKeys = useRef(new Map<string, HTMLSpanElement>());
  /// 各行下的行内灰面板（控件、勾选没写成）
  const [notices, setNotices] = useState<Record<string, ReactNode>>({});
  /// 启动时的自愈试过了没有：试过仍没起来才出「路由没在跑」
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  const [restartingRouter, setRestartingRouter] = useState(false);
  const mounted = useRef(true);
  /// 最新的模型状态：连着勾几下时，每一下都在上一下乐观更新之后的样子上改
  const latest = useRef(state.gateway);
  latest.current = state.gateway;

  // 挂载：路由没在跑就先自愈一次（重启路由），还不行才让待办条出来
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        let next = await api.gatewayState();
        if (routerUnavailable(next)) {
          try {
            next = await api.gatewayRestart();
          } catch (error) {
            if (mounted.current) setRouterFailure(describeError(error));
          }
        }
        if (mounted.current) onGatewayState(next);
      } catch {
        // 读不到：壳的轻查还会再读；待办条照状态出
      } finally {
        if (mounted.current) setHealed(true);
      }
    })();
    return () => {
      mounted.current = false;
    };
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setNotice = (id: string, next: ReactNode | null) =>
    setNotices((prev) => {
      const copy = { ...prev };
      if (next === null) delete copy[id];
      else copy[id] = next;
      return copy;
    });

  const restartRouter = async () => {
    setRestartingRouter(true);
    try {
      const next = await api.gatewayRestart();
      if (!mounted.current) return;
      onGatewayState(next);
      setRouterFailure(null);
    } catch (error) {
      if (mounted.current) setRouterFailure(describeError(error));
    } finally {
      if (mounted.current) setRestartingRouter(false);
    }
  };

  /// 浮层里勾上 / 取消一个：先画成做成之后的样子（开着时取消最后一个第三方模型，开关一并画成关），再写
  const pick = async (
    entry: AgentEntry,
    agent: GatewayAgent,
    ref: ModelRef,
    on: boolean,
    shown: { displayName: string; providerName: string },
  ) => {
    const gateway = latest.current;
    const view = gateway === null ? null : agentGateway(gateway, agent);
    if (gateway === null || view === null) return;
    setNotice(entry.id, null);
    const turnsOff = !on && view.enabled && unpicksLast(view.models, ref);
    const optimistic = withAgentGateway(gateway, {
      ...view,
      enabled: turnsOff ? false : view.enabled,
      models: pickOptimistic(view.models, ref, on, shown),
    });
    latest.current = optimistic;
    onGatewayState(optimistic);
    try {
      const next = await api.gatewayPick(agent, ref, on);
      if (mounted.current) onGatewayState(next);
    } catch (error) {
      try {
        const actual = await api.gatewayState();
        if (mounted.current) onGatewayState(actual);
      } catch {
        // 读不到就停在乐观的样子上；下一次轻查会改正
      }
      if (!mounted.current) return;
      setNotice(
        entry.id,
        <NoticePanel
          message={
            on
              ? t("models.pick.failed", { model: shown.displayName })
              : t("models.pick.unpickFailed", { model: shown.displayName })
          }
          reason={describeError(error)}
          action={{
            label: t("models.notice.retry"),
            onClick: () => void pick(entry, agent, ref, on, shown),
          }}
          onClose={() => setNotice(entry.id, null)}
        />,
      );
    }
  };

  /// 「已选」排序（#265）：`order` 给了就先画成新顺序再写（拖动、⌥↑ / ⌥↓）；不给是 `恢复默认顺序`，
  /// 默认顺序要按启用先后排、只有后端知道，等它回来再画。没成退回后端给的状态、行下说原因
  const reorder = async (entry: AgentEntry, agent: GatewayAgent, order: ModelRef[] | null) => {
    const gateway = latest.current;
    const view = gateway === null ? null : agentGateway(gateway, agent);
    if (gateway === null || view === null) return;
    setNotice(entry.id, null);
    if (order !== null) {
      const optimistic = withAgentGateway(gateway, {
        ...view,
        models: reorderOptimistic(view.models, order),
      });
      latest.current = optimistic;
      onGatewayState(optimistic);
    }
    try {
      const next =
        order === null
          ? await api.gatewayRestoreOrder(agent)
          : await api.gatewayReorderPicks(agent, order);
      if (mounted.current) onGatewayState(next);
    } catch (error) {
      try {
        const actual = await api.gatewayState();
        if (mounted.current) onGatewayState(actual);
      } catch {
        // 读不到就停在乐观的样子上；下一次轻查会改正
      }
      if (!mounted.current) return;
      setNotice(
        entry.id,
        <NoticePanel
          message={t("models.pick.reorderFailed")}
          reason={describeError(error)}
          action={{
            label: t("models.notice.retry"),
            onClick: () => void reorder(entry, agent, order),
          }}
          onClose={() => setNotice(entry.id, null)}
        />,
      );
    }
  };

  /// 进模型页的行（第三方模型那一节带 `listRow`）；没有 `listRow` 的节照旧铺成一节
  const listed = entries.flatMap((entry) =>
    pageSections(entry, state)
      .filter((section) => section.listRow !== undefined)
      .map((section) => ({ entry, section })),
  );
  const inline = entries.flatMap((entry) =>
    pageSections(entry, state)
      .filter((section) => section.listRow === undefined && section.Component !== undefined)
      .map((section) => ({ entry, section })),
  );

  const router = state.gateway === null ? null : routerTodo(state.gateway, healed, routerFailure);
  const unreadable = state.gateway?.unreadable ?? state.gatewayError ?? null;

  // 新手提示 `first-models`（DESIGN「新手提示条」）：列着任意一家、状态读回来（连同启动时的自愈）之后出，
  // 页面头下、列表之上。让位：壳的错误横幅、页面头下的灰面板、各行下的灰面板。打开过任意一家的第三方模型就算学会
  const modelsHint = useHint("first-models", {
    eligible: listed.length > 0 && healed,
    blocked:
      Boolean(props.banner) ||
      router !== null ||
      unreadable !== null ||
      Object.keys(notices).length > 0,
  });
  const gateway = state.gateway;
  const anyOn =
    gateway !== null &&
    listed.some(
      ({ entry }) => entry.gateway && agentGateway(gateway, entry.gateway)?.enabled === true,
    );
  const learnHint = modelsHint.learned;
  useEffect(() => {
    if (anyOn) learnHint();
    // learned 每次渲染是新函数，只看开没开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyOn]);
  const pickingRow = picking === null ? null : listed.find(({ entry }) => entry.id === picking.id);
  const pickingView =
    pickingRow && pickingRow.entry.gateway && state.gateway
      ? agentGateway(state.gateway, pickingRow.entry.gateway)
      : null;

  const openProviders = () => {
    setPicking(null);
    setProvidersOpen(true);
  };

  return (
    <div className="agent-page">
      <PageHead
        lead={<PageTitle>{t("models.page.title")}</PageTitle>}
        actions={
          // 全局模型提供商（ADR 0003）：所有 agent 共用一份，在推入的一页里加、改、启用模型
          <span ref={providersKey}>
            <Button onClick={() => setProvidersOpen(true)}>{t("models.providers.title")}</Button>
          </span>
        }
      >
        {loading ? <Empty description={t("models.page.loading")} busy art="scanning" /> : null}
        {unreadable ? (
          <div className="models-list__todo">
            <UnreadableNotice
              issue={unreadable}
              onGatewayState={onGatewayState}
              onError={props.onError}
            />
          </div>
        ) : null}
        {router ? (
          // 路由没在跑或没接上：影响每一家，挂在页面头下、列表之上；原因跟在主句后同一行
          <div className="models-list__todo">
            <NoticePanel
              scope="section"
              message={router.message}
              reason={router.reason ?? undefined}
              busy={restartingRouter ? router.busy : undefined}
              action={{
                label: router.label,
                onClick: () => void restartRouter(),
                disabledReason: restartingRouter ? t("models.control.busyPrev") : undefined,
              }}
            />
          </div>
        ) : null}
        <div className="models-list__hint">
          <NoticePanel
            scope="section"
            mark={false}
            open={modelsHint.visible}
            onClose={modelsHint.dismiss}
            flush
            message={HINTS["first-models"]({ agents: [], skills: 0 })}
          />
        </div>
        {!loading && state.gateway !== null && listed.length === 0 ? (
          <Empty description={t("models.row.empty")} />
        ) : null}
        {listed.length > 0 ? (
          <div className="models-list">
            {listed.map(({ entry, section }) => {
              const row = section.listRow!;
              const status = row.status(state);
              const note = row.note?.(state) ?? null;
              const Controls = row.Controls;
              const Todos = row.Todos;
              const notice = notices[entry.id];
              const name = modelsNameOf(entry);
              const view =
                entry.gateway && state.gateway ? agentGateway(state.gateway, entry.gateway) : null;
              const pickKey =
                view !== null ? (
                  <span
                    className="models-row__pick"
                    ref={(el) => {
                      if (el) pickKeys.current.set(entry.id, el);
                      else pickKeys.current.delete(entry.id);
                    }}
                  >
                    <Button
                      size="compact"
                      ariaExpanded={picking?.id === entry.id}
                      ariaHasPopup="dialog"
                      onClick={() => {
                        const trigger = pickKeys.current.get(entry.id);
                        if (trigger) setPicking({ id: entry.id, trigger });
                      }}
                    >
                      {pickButtonLabel(view.models)}
                      <IconChevronDown />
                    </Button>
                  </span>
                ) : null;
              const rowProps = {
                ...props,
                agent: entry.id,
                state,
                pick: pickKey,
                onNotice: (next: ReactNode | null) => setNotice(entry.id, next),
              };
              return (
                <div
                  key={`${entry.id}:${section.id}`}
                  className="models-row"
                  role="group"
                  aria-label={`${name} · ${section.title}`}
                >
                  <div className="models-row__main">
                    <span className="models-row__icon">
                      <AgentIcon id={entry.id} name={name} />
                    </span>
                    <span className="models-row__content">
                      <span className="models-row__name">{name}</span>
                      {status || note ? (
                        <span className="models-row__sub">
                          {status}
                          {note ? <span className="models-row__note">{note}</span> : null}
                        </span>
                      ) : null}
                    </span>
                    <span className="models-row__end">
                      <Controls {...rowProps} />
                    </span>
                  </div>
                  {Todos ? (
                    <div className="models-row__todos">
                      <Todos {...rowProps} />
                    </div>
                  ) : null}
                  {notice ? <div className="models-row__notice">{notice}</div> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {inline.map(({ entry, section }) => {
          const Component = section.Component!;
          return (
            <section
              key={`${entry.id}:${section.id}`}
              className="agent-page__section"
              aria-label={`${modelsNameOf(entry)} · ${section.title}`}
            >
              <Component {...props} />
            </section>
          );
        })}
      </PageHead>
      {picking !== null && pickingRow && pickingView !== null && pickingRow.entry.gateway ? (
        <PickModels
          agent={pickingRow.entry.gateway}
          name={modelsNameOf(pickingRow.entry)}
          models={pickingView.models}
          trigger={picking.trigger}
          onPick={(ref, on, shown) =>
            void pick(pickingRow.entry, pickingRow.entry.gateway!, ref, on, shown)
          }
          onReorder={(order) => void reorder(pickingRow.entry, pickingRow.entry.gateway!, order)}
          onRestoreOrder={() => void reorder(pickingRow.entry, pickingRow.entry.gateway!, null)}
          onManage={openProviders}
          onClose={() => setPicking(null)}
        />
      ) : null}
      {providersOpen ? (
        <ProvidersPage
          port={state.gateway?.router.port ?? PORT_FIRST}
          nameOf={(agent) => {
            const found = entries.find((e) => e.gateway === agent || e.id === agent);
            return found ? modelsNameOf(found) : agent;
          }}
          host={() => document.querySelector(".face")}
          covers={() => document.querySelector(".face__scroll")}
          onClose={() => {
            setProvidersOpen(false);
            providersKey.current?.querySelector("button")?.focus({ preventScroll: true });
            // 提供商页里的改动（取消启用、删一家、改地址）会改各家的「已选」：回来时重读一次
            void api
              .gatewayState()
              .then((next) => {
                if (mounted.current) onGatewayState(next);
              })
              .catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}

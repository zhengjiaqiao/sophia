import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { parseBackendError, routerTodo, routerUnavailable } from "../modelsView.ts";
import type { GatewayAgent, GatewayState, GatewayUnreadable } from "../types.ts";
import { copyDetails } from "../diagnostics.ts";
import {
  AgentIcon,
  Empty,
  NoticePanel,
  PageHead,
  PageTitle,
  PushedPage,
  Section,
  usePushedPage,
} from "../ui/index.ts";
import type { PushedPageState } from "../ui/index.ts";
import { requestLeave } from "./leaveGuard.ts";
import { useMenuFlag, usePageCommand } from "./menuBus.ts";
import {
  modelsNameOf,
  pageSections,
  type AgentEntry,
  type AgentSection,
  type AgentSectionProps,
  type AgentState,
} from "./agentRegistry.ts";
import "./ModelsPage.css";

/// 模型页（spec 2026-09-29 R41 R42；DESIGN「### 模型」）：两层——`模型` 是一张 agent 列表，点一行推入这一家的页。
///
/// **列表页**（这一页）：页面头只有页面名 `模型`（与侧栏同名）；「路由没在跑」挂在页面头下、列表之上（影响每一家，全局的事放全局）；
/// 一家一行：16 图标 + 8 + 名字，第二行一句现状（注册表 `listRow.status`），右端控件列（注册表 `listRow.Controls`：
/// 条件键 + 12 + 开关；拨了就写、不确认，禁用时按下即说原因）。**行尾不加 `›`**（那是网关行、表格行的拉手）；
/// 点整行（开关与键之外）推入这一家的页（`PushedPage`），返回时焦点还给这一行；推入状态只在这一页里，不进 `Nav`。
/// 控件没写成时，这一行下出行内灰面板（控件经 `onNotice` 交过来）。
///
/// **各家的页**（注册表节的 `Component`）：用这里导出的 `AgentPage` 画推入页的外框——页面头只有 `←` + 这一家的名字（Claude 是 `Claude Desktop`），
/// 下一行是能力行（能力名 + 12 + 开关 + 12 + 条件键）。
/// 哪个 agent、排什么顺序全由注册表给，这一页不认得具体 agent。
///
/// 没有 `listRow` 的页内节（以后别的能力）不进列表，照旧在这一页里铺成一节。
/// 整页限宽 776、左沿＝机面内左沿（App.css `.agent-page`）
/// `loading`：还没问出后端支不支持第三方模型（上次停在这一页、刚打开时）——出忙碌空态，不留一张只有标题的空页

// ===== 推入页的外框：各家的页用它（Codex：ModelsTab；Claude：ClaudeModelsPage） =====

interface AgentPageContextValue {
  /// 返回（`←`、Esc、⌘[ 同一条路；先经「离开前询问」，表单有没保存的改动时就地问完再走）
  page: PushedPageState;
  /// 挂到机面上、盖住列表页；不给（测试、样张）就地画
  host?: () => Element | null;
  covers?: () => Element | null;
  /// 注册表里某一家在模型页里的显示名（`Codex` / `Claude Desktop`）：网关区块写「也加到 Claude Desktop」用；那一家此刻不在列表里为 null
  nameOf: (agent: GatewayAgent) => string | null;
}

const STANDALONE: AgentPageContextValue = {
  page: { leaving: false, leave: () => undefined },
  nameOf: () => null,
};

const AgentPageContext = createContext<AgentPageContextValue>(STANDALONE);

/// 另一家的显示名（注册表给，组件不写死）：各家的页交给网关区块的 `otherName`
export function useAgentName(agent: GatewayAgent): string | null {
  return useContext(AgentPageContext).nameOf(agent);
}

export interface AgentPageProps {
  /// 页面名＝这一家在模型页里的名字，原样：`Codex`、`Claude Desktop`
  title: string;
  /// 页面头下能力行的名字：`第三方模型`（两家共用 modelsView `modelsCapability()`）。不给就没有能力行（读状态时）
  capability?: string;
  /// 能力行里紧跟能力名（12）的开关
  control?: ReactNode;
  /// 开关右边 12 的条件键（`重启生效` / `启动 Codex` / `打开 Claude` …，同一位一次只出一颗）
  actions?: ReactNode;
  /// 此刻 Esc 归不归这一页（确认框开着时给 false：Esc 只取消确认，不返回）
  escape?: boolean;
  /// 页面头下、能力行之上（Codex 的新手提示条：DESIGN「页面头下、「第三方模型」节上方」）
  lead?: ReactNode;
  children?: ReactNode;
}

/// 各家的页的推入页外框（DESIGN「每家的页（推入页，共同骨架）」，2026-09-30）：页面头只写是哪一家——`←`（图标键 28，
/// 等于 Esc）+ 10 + `Codex` / `Claude Desktop`（`title` 20 / 700），不放控件。页面头下 12 一行能力行，回到「节头」的排法、
/// 与托盘那一行同形：能力名（`head` 16 / 600）+ 12 + 开关 + 12 + 条件键（`Section` 的节头）；页里的内容接在它下面。
/// 内容在页面头下自己滚动、限宽 776。确认框要挂到 body 上（推入页带着 transform，见 ModelsGateways `bodyLayer`）
export function AgentPage({
  title,
  capability,
  control,
  actions,
  escape = true,
  lead,
  children,
}: AgentPageProps) {
  const { page, host, covers } = useContext(AgentPageContext);
  return (
    <PushedPage {...page} title={title} host={host} covers={covers} escape={escape}>
      <div className="models-agent">
        {lead}
        {capability !== undefined ? (
          <div className="models-agent__cap">
            <Section title={capability} control={control} actions={actions} />
          </div>
        ) : null}
        {children}
      </div>
    </PushedPage>
  );
}

/// 推入着的那一家：返回的计时、菜单「返回」、给各家的页的外框上下文
function PushedAgent({
  section,
  entries,
  onClose,
  props,
}: {
  section: AgentSection;
  entries: ReadonlyArray<AgentEntry>;
  onClose: () => void;
  props: AgentSectionProps;
}) {
  const pushed = usePushedPage(onClose);
  // 返回也是离开这一页：表单有没保存的改动时先就地问（leaveGuard），问完再滑回
  const leave = () => requestLeave(pushed.leave);
  usePageCommand("back", leave);
  useMenuFlag("back", !pushed.leaving);
  const value: AgentPageContextValue = {
    page: { leaving: pushed.leaving, leave },
    host: () => document.querySelector(".face"),
    covers: () => document.querySelector(".face__scroll"),
    nameOf: (agent) => {
      const found = entries.find((e) => e.gateway === agent);
      return found ? modelsNameOf(found) : null;
    },
  };
  const Component = section.Component!;
  return (
    <AgentPageContext.Provider value={value}>
      <Component {...props} />
    </AgentPageContext.Provider>
  );
}

// ===== 列表页 =====

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

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
  /// 与侧栏、托盘同一种只读状态：节级可用据它判断（列表行的现状句、开关也读它）
  state: AgentState;
  loading?: boolean;
} & AgentSectionProps) {
  const { onGatewayState } = props;
  /// 推入着的那一家（`entry.id`）；推入状态不进 Nav
  const [pushed, setPushed] = useState<string | null>(null);
  /// 各行下的行内灰面板（控件没写成）
  const [notices, setNotices] = useState<Record<string, ReactNode>>({});
  /// 启动时的自愈试过了没有：试过仍没起来才出「路由没在跑」
  const [healed, setHealed] = useState(false);
  const [routerFailure, setRouterFailure] = useState<string | null>(null);
  const [restartingRouter, setRestartingRouter] = useState(false);
  const opens = useRef(new Map<string, HTMLButtonElement>());
  const mounted = useRef(true);

  // 挂载：路由没在跑就先自愈一次（重启路由），还不行才让待办条出来（同各家的页）
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

  /// 有列表行的节进列表；没有的照旧铺在这一页里
  const listed = entries.flatMap((entry) =>
    pageSections(entry, state)
      .filter((section) => section.listRow !== undefined)
      .map((section) => ({ entry, section })),
  );
  const inline = entries.flatMap((entry) =>
    pageSections(entry, state)
      .filter((section) => section.listRow === undefined)
      .map((section) => ({ entry, section })),
  );
  const top = listed.find(({ entry }) => entry.id === pushed) ?? null;

  /// 点整行推入：先把焦点放在这一行的名字上，返回时推入页把焦点还给它（程序放的焦点不画框，见 inputModality）
  const push = (id: string) => {
    opens.current.get(id)?.focus({ preventScroll: true });
    setPushed(id);
  };

  const router = state.gateway === null ? null : routerTodo(state.gateway, healed, routerFailure);
  const unreadable = state.gateway?.unreadable ?? state.gatewayError ?? null;

  return (
    <div className="agent-page">
      <PageHead lead={<PageTitle>{t("models.page.title")}</PageTitle>}>
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
        {listed.length > 0 ? (
          <div className="models-list">
            {listed.map(({ entry, section }) => {
              const row = section.listRow!;
              const status = row.status(state);
              const Controls = row.Controls;
              const notice = notices[entry.id];
              return (
                <div
                  key={`${entry.id}:${section.id}`}
                  className="models-row"
                  role="group"
                  aria-label={`${modelsNameOf(entry)} · ${section.title}`}
                >
                  <div
                    className="models-row__main"
                    onClick={(event) => {
                      // 右端控件列里的点击各有各的事
                      if ((event.target as Element).closest(".models-row__end")) return;
                      push(entry.id);
                    }}
                  >
                    <span className="models-row__icon">
                      <AgentIcon id={entry.id} name={modelsNameOf(entry)} />
                    </span>
                    <span className="models-row__content">
                      <button
                        type="button"
                        className="models-row__open"
                        ref={(el) => {
                          if (el) opens.current.set(entry.id, el);
                          else opens.current.delete(entry.id);
                        }}
                      >
                        {modelsNameOf(entry)}
                      </button>
                      {status ? <span className="models-row__sub">{status}</span> : null}
                    </span>
                    <span className="models-row__end">
                      <Controls
                        {...props}
                        agent={entry.id}
                        state={state}
                        onNotice={(next) =>
                          setNotices((prev) => {
                            const copy = { ...prev };
                            if (next === null) delete copy[entry.id];
                            else copy[entry.id] = next;
                            return copy;
                          })
                        }
                      />
                    </span>
                  </div>
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
      {top ? (
        <PushedAgent
          key={top.entry.id}
          section={top.section}
          entries={entries}
          onClose={() => setPushed(null)}
          props={props}
        />
      ) : null}
    </div>
  );
}

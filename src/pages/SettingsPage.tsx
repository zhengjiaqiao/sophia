import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { locale, t, tn } from "../i18n.ts";
import type { AppFault } from "../backendError.ts";
import type {
  Appearance,
  HarnessList,
  HarnessStatus,
  LanguageSetting,
  ProjectScope,
} from "../types";
import {
  AgentIcon,
  BusySlot,
  Button,
  CheckRow,
  DrawerHandle,
  FloatingToast,
  Mono,
  Note,
  NoticePanel,
  PageHead,
  PageTitle,
  SectionLabel,
  Switch,
  Toast,
} from "../ui";
import { AbsentAgents } from "./AbsentAgents.tsx";
import { AppearanceRow } from "./AppearanceRow.tsx";
import { LanguageRow } from "./LanguageRow.tsx";
import { ScopeSection } from "./ScopeSection.tsx";
import { ISSUES_URL, PRIVACY_URL, ReportRow } from "./ReportRow.tsx";
import {
  FeedbackSentNote,
  openFeedback,
  setReportSettings,
  useReportSettings,
} from "../feedback.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { copyDetails } from "../diagnostics.ts";
import {
  netFailureText,
  netProblemOf,
  retryLabel,
  websiteDownloadUrl,
  type NetProblem,
  type UpdateScene,
} from "../netFailure.ts";
import { appUpdates, useAppUpdate } from "../useAppUpdate.ts";
import { autoCheckNote } from "../market/updateView.ts";
import { useSkillUpdates } from "../market/useSkillUpdates.ts";
import "./SettingsPage.css";

/// 设置页（DESIGN「产品裁决 › 设置」，画板 V4Layouts-settings）：侧栏底的 `设置`（或 `⌘,`）落到这里，
/// **只替换机面，侧栏不消失**（D6）。页面头 `设置`，右端没有动作。
/// 它只回答一个问题——**这个 agent 出不出现在列表里**。名单只有一份，SKILLS、MCP 两页共用
/// （2026-09-27 产品负责人：「这里感觉不用分开」）：MCP 页只显示其中支持 MCP 的，`显示的 agent` 的灰字说这件事。
/// Claude Desktop 不进名单、不占名额（它跟着 Claude Code 出现在 MCP 页，core 的 `mcp_columns`）。
///
/// 三节（2026-10-06 并节）：`通用`（界面语言、外观、开机启动）→ `Skills 和 MCP` → `关于`（版本｜`检查更新`，
/// 应用内查，不跳 GitHub；`使用统计和错误报告`｜开关，这份构建能上报才有）。
/// `Skills 和 MCP` 一节三块，每块是一条设置行，名单紧跟在行下，设置行连同名单是一块，块间一道行线：
/// - `显示的 agent` + 灰字「最多显示 4 个 · MCP 页只显示其中支持 MCP 的」：勾选框列表，三列等分、按行读，一行＝勾选行
///   `CheckRow`（14px 勾选框 + 10 + 16px 图标 + 10 + 名字），行高 36；默认只列已安装的，其余收在一行展开
///   「未安装的 N 个 ›」里（字在前、拉手在后）。**最多显示 4 个**（上限来自 core，`list_harnesses` 带回）：勾满时其余已安装项禁用，
///   按下即出「最多显示 4 个，先取消一个」。「取消勾选只是不在列表里显示，已建好的链接原样留着」不常驻——
///   **取消勾选那一刻浮在那一项正下方**，约 4 秒淡出。
/// - `生效范围`（项目勾不勾，`ScopeSection`），右端 `+ 项目`。
/// - `自动检查 skill 更新` + 灰字何时查与上次的时刻｜查到了的 `看 N 个更新`、`立即检查`、开关。
///   查 skill 更新的结果与 SKILLS 页同一份（`useSkillUpdates`）。
/// 每一行都是设置行（`SettingRow`，2026-10-04 画板 B，照 Claude 的设置页）：名字与一句灰字在左，
/// 控件在右端一列，行与行之间一条行线；节小标下不画线，节间 32；宽度同各页，随窗口变宽。
/// 应用菜单「关于 Sophia」「检查更新…」停在 `关于`（`aboutRequest`）。`开机启动`（spec 2026-10-03-gateway-in-app R15、R16）
/// 开没开以系统登录项为准、不另存。
///
/// 改一个生效一个，**没有「保存」按钮**。
///
/// 故意不做的事：
/// - **不展示路径**。用户要做的判断只有一个，路径是我们的实现细节。
/// - 不提「目录不存在，开启任一 skill 时会建出来」——那是开启 skill 那一刻的事。
/// - 不给「链接方式（相对 / 绝对）」开关：它按「本体是否在目标项目内」自动判，是正确性判断不是口味问题。
/// - **没有路由状态那一行**（D10）：它只转述 Codex 开关的状态、自己不能操作。

/// `list_harnesses` 返回全部 41 个，各自带 installed。默认只列已安装的，
/// 其余收在「未安装的 N 个 ›」展开里。
type AgentOption = HarnessStatus;

/// 检查或下载更新失败（spec #248，画板「国产 agent 与国内网络」第 7 屏）：主句按场景与四类说，
/// 原文从左端的 `!` 看（停上去出悬浮卡）；`到官网下载 ↗` 跟在句后（离开 Sophia 的退路，官网下载区对国内访客走国内线路），
/// 键区只放留在 Sophia 里的再试一次——连不上时写「开着代理再试一次」，限流与别的不给（再试也没用）
function UpdateFailure(props: {
  scene: UpdateScene;
  problem: NetProblem;
  onRetry: () => void;
  onClose?: () => void;
}) {
  const text = netFailureText(props.scene, props.problem.kind);
  return (
    <NoticePanel
      scope="section"
      message={
        <>
          {text.message}
          {" ·\u00a0"}
          <Button
            variant="quiet"
            inline
            onClick={() => void openUrl(websiteDownloadUrl(locale())).catch(() => undefined)}
          >
            {t("common.net.website")}
          </Button>
        </>
      }
      technical={props.problem.detail}
      onCopy={(detail) => copyDetails(detail)}
      action={text.retry ? { label: retryLabel(text.retry), onClick: props.onRetry } : undefined}
      onClose={props.onClose}
    />
  );
}

export interface SettingsPageProps {
  /// 出错交给窗口顶上的横幅。保存失败时另给该处的失败句与「再试一次」（`saveFailed`）
  onError: (message: string, more?: Omit<AppFault, "text">) => void;
  /// 壳接线（应用菜单「关于 Sophia」「检查更新…」，D15）：停在「关于」；`check` 时同时开始检查
  aboutRequest?: { at: number; check: boolean };
  /// SKILLS 页「装了 N 个 agent」灰面板的 `去设置`（issue #109）：停在 `Skills 和 MCP` 一节（第一块就是 `显示的 agent`）
  agentsRequest?: { at: number };
  /// `自动检查 skill 更新` 那一行的 `看 N 个更新`：到 SKILLS · 我的 · 全部，打开 `只看这些`
  onShowUpdates?: () => void;
  /// 壳每扫完一轮加一：应用菜单「添加项目…」加了项目、文件夹没了，`生效范围` 跟着重读
  refreshKey?: number;
}

export function SettingsPage({
  onError,
  aboutRequest,
  agentsRequest,
  onShowUpdates,
  refreshKey = 0,
}: SettingsPageProps) {
  /// null＝还没读回来，与「一个 agent 都没有」是两回事
  const [list, setList] = useState<HarnessList | null>(null);
  const agents: AgentOption[] | null = list?.harnesses ?? null;
  const [showAbsent, setShowAbsent] = useState(false);

  /// 任一项保存失败（spec #239「错误怎么分两层」）：横幅主句「设置保存失败」，系统原文进前面的「!」，
  /// `再试一次` 重做这一次保存；给人看的一句（显示已满、设置文件来自更新版本）原样说、不给 `再试一次`
  const saveFailed = (e: unknown, retry: () => void) =>
    onError(String(e), {
      fallback: t("settings.save.failed"),
      retry: { label: t("settings.save.retry"), onClick: retry },
    });

  const reload = async () => {
    try {
      setList(await api.listHarnesses());
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => {
    void reload();
    // 首次进入加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// 当前版本：从应用自己读，不从任何配置文件读——用户看的是正在跑的这一份
  const [current, setCurrent] = useState<string | null>(null);
  /// 新版本的处境与侧栏的更新键是同一份（壳在启动时和之后每 6 小时静默查，见 App.tsx）：
  /// 在侧栏点了下载，这里看到的是同一条进度；离开设置页下载照样继续。进设置不另查
  const { phase: update } = useAppUpdate();
  /// 「稍后」只在这一程有效，下次进来再问（与模型页的 later 同一套语义，§4.4）；只收起这里的待办条，
  /// 侧栏的更新键照旧在
  const [later, setLater] = useState(false);

  useEffect(() => {
    void getVersion().then(setCurrent, () => setCurrent(null));
  }, []);

  /// 要用户处理的三种处境各自一条行内待办条；下载中是同一条待办条，键位原地换成忙碌 + `正在下载 0.2.0 · 43%`
  const updateNotice = () => {
    if (later) return null;
    switch (update.kind) {
      case "none":
        if (checkFailed !== null)
          return (
            <UpdateFailure
              scene="checkUpdate"
              problem={checkFailed}
              onRetry={() => void checkUpdate()}
            />
          );
        return null;
      case "available":
      case "downloading": {
        const version = update.version;
        const busy =
          update.kind === "downloading"
            ? t("settings.update.downloading", { version }) +
              (update.percent === null ? "" : " · " + update.percent + "%")
            : undefined;
        return (
          <NoticePanel
            scope="section"
            message={t("settings.update.available", { version })}
            busy={busy}
            action={{
              label: t("settings.update.install"),
              onClick: () => void appUpdates.install(),
            }}
            secondary={{ label: t("settings.update.later"), onClick: () => setLater(true) }}
          />
        );
      }
      case "installed":
        return (
          <NoticePanel
            scope="section"
            message={t("settings.update.installed", { version: update.version })}
            action={{
              label: t("settings.update.restart"),
              onClick: () => void appUpdates.relaunch(),
            }}
            secondary={{ label: t("settings.update.later"), onClick: () => setLater(true) }}
          />
        );
      case "failed":
        // × 与「稍后」同义：只收起这一程的待办条，侧栏更新键照旧在（点它就是再试）
        return (
          <UpdateFailure
            scene="downloadUpdate"
            problem={{ kind: update.cause, detail: update.detail }}
            onRetry={() => void appUpdates.install()}
            onClose={() => setLater(true)}
          />
        );
    }
  };

  /// 点「检查更新」之后：正在检查（键原位忙碌）/ 已是最新（键下方浮起，约 4 秒淡出）/
  /// 检查失败（`UpdateFailure`）
  const [latest, setLatest] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState<NetProblem | null>(null);
  const dismissLatest = useCallback(() => setLatest(0), []);

  /// 刚取消勾选的那一项：它正下方浮起一句说明，约 4 秒淡出（`at` 让连着取消两次时计时从头来）
  const [unchecked, setUnchecked] = useState<{ id: string; at: number } | null>(null);
  const dismissUnchecked = useCallback(() => setUnchecked(null), []);

  /// 点一下切换，当场生效。写盘成功后重读一次，界面始终以落盘结果为准
  /// 勾选先画出来再写（同模型页「勾选不闪」）：写失败读回实际状态并说原因
  const toggle = async (id: string, enabled: boolean) => {
    setList((l) =>
      l ? { ...l, harnesses: l.harnesses.map((h) => (h.id === id ? { ...h, enabled } : h)) } : l,
    );
    try {
      await api.setHarnessEnabled(id, enabled);
      setUnchecked(enabled ? null : { id, at: Date.now() });
      await reload();
    } catch (e) {
      saveFailed(e, () => void toggle(id, enabled));
      await reload();
    }
  };

  // ── 生效范围（spec 2026-10-05-skill-mcp-batch2「项目来源」）──
  /// null＝还没读回来。勾选先画出来再写，写完重读一次，界面以落盘结果为准（同 agent 名单）
  const [projects, setProjects] = useState<ProjectScope[] | null>(null);
  /// 这一程在上面取消勾的：格子留在原处，下次进设置才折进「不显示的 N 个」
  const [keptProjects, setKeptProjects] = useState<ReadonlySet<string>>(new Set());
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);
  const [uncheckedProject, setUncheckedProject] = useState<{ path: string; at: number } | null>(
    null,
  );
  const dismissUncheckedProject = useCallback(() => setUncheckedProject(null), []);
  const [addNotice, setAddNotice] = useState<{ message: string; at: number } | null>(null);
  const dismissAddNotice = useCallback(() => setAddNotice(null), []);
  const reloadProjects = async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => {
    void reloadProjects();
    // 进来读一次；壳扫完一轮（菜单加了项目、文件夹没了）再读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const toggleProject = async (path: string, shown: boolean) => {
    setProjects((list) => list?.map((p) => (p.path === path ? { ...p, shown } : p)) ?? list);
    // 在上面取消勾的留在原处；从「不显示的」里勾回来的回到上面（勾着本来就在上面）
    if (!shown) setKeptProjects((kept) => new Set(kept).add(path));
    try {
      await api.setProjectShown(path, shown);
      setUncheckedProject(shown ? null : { path, at: Date.now() });
    } catch (e) {
      saveFailed(e, () => void toggleProject(path, shown));
    }
    await reloadProjects();
  };
  /// `+ 项目`：系统文件夹选择器，选的文件夹就是一格、默认勾上。当不了项目的（主目录、不是文件夹）在键下说原因
  const addProject = async () => {
    setAddNotice(null);
    let path: string | null;
    try {
      path = await api.pickDirectory(t("settings.scope.pickDialog"));
    } catch (e) {
      onError(String(e));
      return;
    }
    if (path === null) return;
    try {
      await api.addProject(path);
    } catch (e) {
      setAddNotice({ message: String(e), at: Date.now() });
    }
    await reloadProjects();
  };

  /// `检查更新`：在应用里查（产品负责人：跳到 GitHub 让用户手动下载太难用）。有新版出待办条
  /// （下载并安装 → 重启），没有就说「已是最新版本」，查不成按四类说并给出路（`UpdateFailure`）
  const checkUpdate = async () => {
    setLater(false);
    setLatest(0);
    setCheckFailed(null);
    setChecking(true);
    try {
      if (!(await appUpdates.checkNow())) setLatest(Date.now());
    } catch (e) {
      setCheckFailed(netProblemOf(e));
    } finally {
      setChecking(false);
    }
  };

  // 应用菜单「关于 Sophia」「检查更新…」：停在「关于」一节，检查更新时同时开始检查（同点 `检查更新`）
  const aboutRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aboutRequest) return;
    aboutRef.current?.scrollIntoView({ block: "start" });
    if (aboutRequest.check && !checking) void checkUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aboutRequest?.at]);

  // SKILLS 页的 `去设置`：停在 `Skills 和 MCP` 一节，第一块就是 `显示的 agent`（排在「关于」之后，两个都在时以它为准）
  const agentsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!agentsRequest) return;
    agentsRef.current?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsRequest?.at]);

  // ── 界面 · 界面语言（spec 2026-09-30-language-and-theme R1 R2，第三批画板 1A）──
  /// 同外观：读自 core（设置里存的那一项，「跟随系统」就是 system）；选了先画出来再写，core 写完当场换语言
  /// （后端发 locale-changed，整棵界面树按新语言重画）。写不成说原因、重读 core 的真值
  const [language, setLanguageState] = useState<LanguageSetting>("system");
  useEffect(() => {
    void api.uiLanguage().then(
      (v) => setLanguageState(v.setting),
      (e) => onError(String(e)),
    );
    // 首次进入读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeLanguage = async (next: LanguageSetting) => {
    setLanguageState(next);
    try {
      await api.setUiLanguage(next);
    } catch (e) {
      saveFailed(e, () => void changeLanguage(next));
      void api.uiLanguage().then(
        (v) => setLanguageState(v.setting),
        () => undefined,
      );
    }
  };

  // ── 界面 · 外观（spec 2026-09-30-language-and-theme R2）──
  /// 读自 core；选了先画出来再写，core 写完当场把外观设到所有窗口。写不成说原因、重读 core 的真值
  /// （不回到旧值：快速连点两项时，前一次失败不该盖掉后一次的选择）
  const [appearance, setAppearanceState] = useState<Appearance>("system");
  useEffect(() => {
    void api.appearance().then(setAppearanceState, (e) => onError(String(e)));
    // 首次进入读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeAppearance = async (next: Appearance) => {
    setAppearanceState(next);
    try {
      await api.setAppearance(next);
    } catch (e) {
      saveFailed(e, () => void changeAppearance(next));
      void api.appearance().then(setAppearanceState, () => undefined);
    }
  };

  // ── 自动检查 skill 更新（R14）──
  /// 开关与上次检查的时刻读自 core；「几个有更新」只在这一程拿到过查更新的结果时有（结果与 SKILLS 页同一份）。
  /// 进设置不查：什么时候查只有两处——打开 SKILLS 页（6 小时、开关归 core）与这里的 `立即检查`
  const skillUpdates = useSkillUpdates();
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  useEffect(() => {
    void api.skillUpdateSettings().then(
      (s) => {
        setAutoCheck(s.autoCheck);
        setLastCheck(s.lastCheck);
      },
      (e) => onError(String(e)),
    );
    // 首次进入读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /// 当场生效：先画出来再写，写不成读回原样并说原因
  const toggleAutoCheck = async (next: boolean) => {
    setAutoCheck(next);
    try {
      await api.setAutoCheckSkillUpdates(next);
    } catch (e) {
      setAutoCheck(!next);
      saveFailed(e, () => void toggleAutoCheck(next));
    }
  };
  // ── 使用统计和错误报告（spec 2026-10-04-reporting-feedback R6）──
  /// 读不回来（内部版没有这个命令）就当不能上报，整行不画、不报错。与出错页、意外退出提示共用一份
  /// （`useReportSettings`）：这里拨了开关，那两处给不给 `报告这个问题` 跟着变
  const report = useReportSettings();
  /// 当场生效：先画出来再写，写不成读回原样并说原因
  const toggleReport = async (next: boolean) => {
    setReportSettings((r) => (r ? { ...r, autoReport: next } : r));
    try {
      await api.setAutoReport(next);
    } catch (e) {
      setReportSettings((r) => (r ? { ...r, autoReport: !next } : r));
      saveFailed(e, () => void toggleReport(next));
    }
  };
  // ── 启动（spec 2026-10-03-gateway-in-app R15、R16）──
  /// 开机启动：以系统的登录项为准、不另存（用户在系统设置里关掉，这里跟着显示关）。读回来之前不画开关；
  /// 先画出来再写，写不成读回原样并说原因
  const [autostart, setAutostart] = useState<boolean | null>(null);
  /// 这个平台没有开机启动（非 macOS）：整节不画
  const [autostartSupported, setAutostartSupported] = useState(true);
  /// 正在改：系统要一两秒才回话，这期间再拨不发第二次（否则刚打开又被关掉）
  const autostartPending = useRef(false);
  useEffect(() => {
    const read = () => {
      if (autostartPending.current) return;
      void api.autostartGet().then(
        (on) => {
          if (on === null) setAutostartSupported(false);
          else if (!autostartPending.current) setAutostart(on);
        },
        (e) => onError(String(e)),
      );
    };
    // 进来读一次；窗口回到前台再读（用户可能刚在系统设置里改过，R16）；
    // 第一次打开时后台默认注册完成也再读（spec 2026-10-05-keep-running R1）
    read();
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((un) => (disposed ? un() : unlisteners.push(un)));
    keep(
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) read();
      }),
    );
    keep(listen("autostart-changed", () => read()));
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleAutostart = async (next: boolean) => {
    if (autostartPending.current) return;
    autostartPending.current = true;
    setAutostart(next);
    try {
      setAutostart(await api.autostartSet(next));
    } catch (e) {
      setAutostart(!next);
      saveFailed(e, () => void toggleAutostart(next));
    } finally {
      autostartPending.current = false;
    }
  };

  const checkingSkills = skillUpdates.checking === "settings";
  const skillNotice = skillUpdates.noticeFor("settings");
  /// 这一程拿到过的结果里有几个新版本；null＝还没拿到
  const updateCount = skillUpdates.loaded ? skillUpdates.updates.length : null;
  const autoCheckLine = autoCheckNote(skillUpdates.checkedAt ?? lastCheck, updateCount);

  /// 一格一个勾选行（`CheckRow size="grid"`，行高 36）：整行是命中区，方框只是记号。勾满上限时没勾的行禁用，
  /// 原因提示框悬停出、按下当即出（组件自己包 `ReasonTip`）
  const row = (agent: AgentOption) => {
    const blocked = full && !agent.enabled;
    return (
      <div key={agent.id} className="settings-page__cell">
        <CheckRow
          size="grid"
          checked={agent.enabled}
          onChange={(next) => void toggle(agent.id, next)}
          icon={<AgentIcon id={agent.id} name={agent.displayName} />}
          disabledReason={blocked ? fullReason : undefined}
          highlighted={unchecked?.id === agent.id}
        >
          {agent.displayName}
        </CheckRow>
        {unchecked?.id === agent.id ? (
          <FloatingToast key={unchecked.at} align="start">
            <Toast
              kind="success"
              sentence="settings.agents.unchecked"
              trail={[t("settings.agents.uncheckedTrail")]}
              onDismiss={dismissUnchecked}
            />
          </FloatingToast>
        ) : null}
      </div>
    );
  };

  /// 三列等分、按行读（与 agent 表的先后一致：默认显示的前 4 个就是第一行起的前 4 个）
  const grid = (items: AgentOption[]) => (
    <div className="settings-page__grid">{items.map(row)}</div>
  );

  const present = (agents ?? []).filter((a) => a.installed);
  const absent = (agents ?? []).filter((a) => !a.installed);
  const maxShown = list?.maxShown ?? 0;
  /// 已显示满上限：其余已安装项不能再勾
  const full = list !== null && present.filter((a) => a.enabled).length >= maxShown;
  const fullReason = t("settings.agents.fullReason", { max: maxShown });

  const notice = updateNotice();
  return (
    <PageHead lead={<PageTitle>{t("settings.title")}</PageTitle>}>
      <div className="settings-page">
        {/* 通用（页面头下 24，第一节）：界面语言、外观、开机启动三行（2026-10-04 画板 B 把原「界面」「启动」两节并成一节）。
            每一行是设置行：名字与灰字在左、控件在右端一列，行与行之间一条行线 */}
        <div className="settings-page__section">
          <SectionLabel>{t("settings.general.section")}</SectionLabel>
        </div>
        <LanguageRow value={language} onChange={(next) => void changeLanguage(next)} />
        <AppearanceRow value={appearance} onChange={(next) => void changeAppearance(next)} />
        {/* 开机启动（spec 2026-10-03-gateway-in-app R15、R16）：这个平台没有就不画这一行 */}
        {autostartSupported ? (
          <SettingRow
            label={t("settings.startup.autostart")}
            note={t("settings.startup.autostartNote")}
          >
            {autostart === null ? null : (
              <Switch
                checked={autostart}
                onChange={(next) => void toggleAutostart(next)}
                label={t("settings.startup.autostart")}
              />
            )}
          </SettingRow>
        ) : null}

        {/* Skills 和 MCP（节间 32，2026-10-06 由原来 agent 名单、生效范围、skill 更新三节并成）：三块，
            每块一条设置行、名单紧跟在行下，设置行连同名单是一块，块间一道行线 */}
        <div ref={agentsRef} className="settings-page__section settings-page__section--later">
          <SectionLabel>{t("settings.skillsMcp.section")}</SectionLabel>
        </div>

        {/* 显示的 agent：灰字说上限与 MCP 页只显示其中支持 MCP 的（上限读回来之前不写灰字）；右端没有控件 */}
        <div className="settings-page__block">
          <SettingRow
            label={t("settings.agents.label")}
            note={list ? t("settings.agents.note", { max: maxShown }) : undefined}
          />
          {/* 读回来之前什么都不画：本机读取很快，闪一下忙碌只是噪音（后台例行读取不显示忙碌） */}
          {agents === null ? null : agents.length === 0 ? (
            <Note>{t("settings.agents.none")}</Note>
          ) : (
            <>
              {grid(present)}
              {/* 没装的收在一行展开里：它不做事，只是在原地把列表拉开，所以是展开的样子（收起 › 拉开 ˅），
                  不是一颗键（2026-09-25 产品负责人真机：「感觉是个展开？」）。这是句末补充式的「还有 N 个」，
                  字在前、拉手在后（2026-10-06）：先读到是什么，再看到能展开；整句可点。
                  未安装的只是信息：勾选与否只对已安装的有意义（2026-10-07） */}
              {absent.length > 0 ? (
                <>
                  <div className="settings-page__more">
                    <span
                      className="settings-page__more-label"
                      onClick={() => setShowAbsent(!showAbsent)}
                    >
                      {tn("settings.agents.absentCount", absent.length)}
                    </span>
                    <DrawerHandle
                      always
                      open={showAbsent}
                      onToggle={() => setShowAbsent(!showAbsent)}
                      label={tn("settings.agents.absentCount", absent.length)}
                      controls="settings-absent"
                    />
                  </div>
                  {showAbsent ? (
                    <div id="settings-absent">
                      <AbsentAgents agents={absent} />
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>

        {/* 生效范围：用户级 + 各个项目，勾上的才出现在 SKILLS、MCP 页的筛选行里；行右端 `+ 项目` */}
        <ScopeSection
          projects={projects}
          kept={keptProjects}
          open={showHiddenProjects}
          onOpen={setShowHiddenProjects}
          onToggle={(path, shown) => void toggleProject(path, shown)}
          onAdd={() => void addProject()}
          unchecked={uncheckedProject}
          onDismissUnchecked={dismissUncheckedProject}
          addNotice={addNotice}
          onDismissAddNotice={dismissAddNotice}
        />

        {/* 自动检查 skill 更新（2026-10-06 由「自动检查」「上次检查」两行并成一行）：灰字何时查 · 上次的时刻
            （这一程查过且没有更新时接「，没有更新」）；右端一列依次是查到了才有的 `看 N 个更新`、`立即检查`、开关。
            页面头不放检查键——结果在 `我的` 的提示条上说 */}
        <SettingRow label={t("settings.skillUpdates.auto")} note={autoCheckLine}>
          {/* 查到了就给一条直达路：设置里看不到是哪几个（2026-09-27 产品负责人）；数量写在键上，灰字不写 */}
          {updateCount !== null && updateCount > 0 && onShowUpdates ? (
            <Button
              size="compact"
              onClick={() => {
                skillUpdates.showInList();
                onShowUpdates();
              }}
            >
              {tn("settings.skillUpdates.showUpdates", updateCount)}
            </Button>
          ) : null}
          <span className="settings-page__check">
            {/* 查的时候键锁住，过了 0.3 秒门槛原位换成刻度 + 正在检查 */}
            <BusySlot busy={checkingSkills} label={t("settings.checking")}>
              <Button size="compact" onClick={() => !checkingSkills && skillUpdates.refresh()}>
                {t("settings.skillUpdates.checkNow")}
              </Button>
            </BusySlot>
            {/* 限流、查不成：在按下的这颗键下浮起一句，不弹窗、不自动重试 */}
            {skillNotice !== null ? (
              <FloatingToast key={skillUpdates.notice?.at} align="end">
                <Toast kind="cannot" message={skillNotice} onDismiss={skillUpdates.clearNotice} />
              </FloatingToast>
            ) : null}
          </span>
          {autoCheck === null ? null : (
            <Switch
              checked={autoCheck}
              onChange={(next) => void toggleAutoCheck(next)}
              label={t("settings.skillUpdates.auto")}
            />
          )}
        </SettingRow>

        <div ref={aboutRef} className="settings-page__section settings-page__section--later">
          <SectionLabel>{t("settings.about.section")}</SectionLabel>
        </div>
        <SettingRow label={t("settings.about.version")} note={<Mono>{current ?? "…"}</Mono>}>
          <span className="settings-page__check">
            {update.kind === "downloading" ? (
              <Button size="compact" disabled disabledReason={t("settings.about.downloading")}>
                {t("settings.about.checkUpdate")}
              </Button>
            ) : (
              // 查的时候键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 正在检查
              <BusySlot busy={checking} label={t("settings.checking")}>
                <Button size="compact" onClick={() => !checking && void checkUpdate()}>
                  {t("settings.about.checkUpdate")}
                </Button>
              </BusySlot>
            )}
            {/* 键在右端：浮起的一句右对齐键，不越出内容右沿 */}
            {latest ? (
              <FloatingToast key={latest} align="end">
                <Toast kind="success" sentence="settings.about.latest" onDismiss={dismissLatest} />
              </FloatingToast>
            ) : null}
          </span>
        </SettingRow>
        {/* 检查更新的结果（待办条 / 查不成的一句）紧跟在 `检查更新` 那一行下（② 就近） */}
        {notice === null ? null : <div className="settings-page__update">{notice}</div>}
        <ReportRow
          settings={report}
          onChange={(next) => void toggleReport(next)}
          // 打不开浏览器就走页面的错误横幅（Codex 复审：兜底入口失败不能没声）
          onPrivacy={() => void openUrl(PRIVACY_URL).catch((e) => onError(String(e)))}
          onGithub={() => void openUrl(ISSUES_URL).catch((e) => onError(String(e)))}
          // 反馈问题（R12、R13）：小窗是应用级的一份；发出去时键还在就把提示条锚在键下（右对齐键，不越出内容右沿）
          onFeedback={() => openFeedback("settings")}
          feedbackNote={<FeedbackSentNote source="settings" align="end" />}
        />
      </div>
    </PageHead>
  );
}

export default SettingsPage;

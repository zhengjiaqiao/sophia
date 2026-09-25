import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { HarnessList, HarnessStatus } from "../types";
import {
  AgentIcon,
  BusySlot,
  DrawerHandle,
  NoticePanel,
  Button,
  FloatingToast,
  Toast,
  Tooltip,
} from "../ui";
import { AbsentAgents } from "./AbsentAgents.tsx";
import { CheckMark } from "./CheckMark.tsx";
import { updateCheckFailure } from "../updateText.ts";
import { ShellPage } from "../shell/PageHead.tsx";
import "./SettingsPage.css";

/// 设置页（DESIGN「产品裁决 › 设置」，画板 V4Layouts-settings）：侧栏底的 `设置`（或 `⌘,`）落到这里，
/// **只替换机面，侧栏不消失**（D6）。页面头 `设置`，右端没有动作。
/// 它只回答一个问题——**这个 agent 出不出现在列表里**。
///
/// `列表里的 agent · 最多 4 个`：勾选框列表，三列等分、按行读，一行＝16px 勾选框 + 10 + 16px 图标 + 10 + 名字，
/// 行高 36；默认只列已安装的，其余收在一行展开「› 未安装的 N 个」里。**最多显示 4 个**（上限来自 core，
/// `list_harnesses` 带回）：勾满时其余已安装项禁用，按下即出「最多显示 4 个，先取消一个」。
/// 「取消勾选只是不在列表里显示，已建好的链接原样留着」不常驻——**取消勾选那一刻浮在那一项正下方**，约 4 秒淡出。
/// 再往下 48：`关于`——版本（等宽 `ink-faint`）+ `检查更新`（默认键紧凑 24，应用内查，不跳 GitHub）。
/// 应用菜单「关于 Sophia」「检查更新…」停在这一节（`aboutRequest`）。
///
/// 改一个生效一个，**没有「保存」按钮**。
///
/// 故意不做的事：
/// - **不展示路径**。用户要做的判断只有一个，路径是我们的实现细节。
/// - 不提「目录不存在，开启任一 skill 时会建出来」——那是开启 skill 那一刻的事。
/// - 不给「链接方式（相对 / 绝对）」开关：它按「本体是否在目标项目内」自动判，是正确性判断不是口味问题。
/// - **没有后台服务那一行**（D10）：它只转述 Codex 开关的状态、自己不能操作；
///   后台服务残留时的 `卸下后台服务` 在 Codex 页「第三方模型」节头与托盘。

/// `list_harnesses` 返回全部 41 个，各自带 installed。默认只列已安装的，
/// 其余收在「› 未安装的 N 个」展开里。
type AgentOption = HarnessStatus;

/// 发布页：只在应用内查不成时作退路（`去发布页 ↗`，离开 Sophia 的浅键）
const RELEASES_URL = "https://github.com/zhengjiaqiao/sophia/releases/latest";

/// 更新这件事的五种处境。需要用户处理的三种（有新版、已安装等重启、安装失败）与下载中
/// 都在「关于」下的行内待办条（灰面板）里；查的过程只在 `检查更新` 键原位。
type UpdateState =
  | { kind: "quiet" }
  | { kind: "ready"; update: Update }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installed"; version: string }
  | { kind: "failed"; version: string; reason: string };

export interface SettingsPageProps {
  /// 旧整窗二级页的返回（已删）：侧栏目的地没有返回，壳仍可传，不用
  onBack?: () => void;
  /// 应用启动时查到的新版；`undefined` 表示壳没查过（比如测试里），页面自己再查一次。
  /// 查在启动时做而不是打开设置时做——用户不进设置也该有机会知道有新版
  initialUpdate?: Update | null;
  onError: (message: string) => void;
  /// 旧接线（V4 外壳过渡期区分整窗 / 机面）：整窗二级页已删，页面总在机面里，壳仍可传，不用
  inShell?: boolean;
  /// 壳接线（应用菜单「关于 Sophia」「检查更新…」，D15）：停在「关于」；`check` 时同时开始检查
  aboutRequest?: { at: number; check: boolean };
}

export function SettingsPage({ onError, initialUpdate, aboutRequest }: SettingsPageProps) {
  /// null＝还没读回来，与「一个 agent 都没有」是两回事
  const [list, setList] = useState<HarnessList | null>(null);
  const agents: AgentOption[] | null = list?.harnesses ?? null;
  const [showAbsent, setShowAbsent] = useState(false);

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
  const [update, setUpdate] = useState<UpdateState>({ kind: "quiet" });
  /// 「稍后」只在这一程有效，下次进来再问（与模型页的 later 同一套语义，§4.4）
  const [later, setLater] = useState(false);

  useEffect(() => {
    void getVersion().then(setCurrent, () => setCurrent(null));
    // 壳在启动时已经查过就直接用（见 App.tsx）；没查过才自己查一次。
    // 查不到（离线、还没配公钥、开发模式下跑）就当没新版：没查成不是用户此刻要
    // 处理的事，说了只是噪音（§4.1「一件事只在一个地方说」）。
    if (initialUpdate !== undefined) {
      if (initialUpdate) setUpdate({ kind: "ready", update: initialUpdate });
      return;
    }
    void check().then(
      (found) => {
        if (found) setUpdate({ kind: "ready", update: found });
      },
      () => {},
    );
  }, [initialUpdate]);

  /// 下载＋安装。用户点了才走到这里——不自动下载，流量和磁盘是他的
  const install = async (found: Update) => {
    setUpdate({ kind: "downloading", version: found.version, percent: null });
    let total = 0;
    let got = 0;
    try {
      await found.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          got += event.data.chunkLength;
          const percent = total > 0 ? Math.min(100, Math.round((got / total) * 100)) : null;
          setUpdate({ kind: "downloading", version: found.version, percent });
        }
      });
      setUpdate({ kind: "installed", version: found.version });
    } catch (e) {
      setUpdate({ kind: "failed", version: found.version, reason: String(e) });
    }
  };

  /// 要用户处理的三种处境各自一条行内待办条；下载中是同一条待办条，键位原地换成忙碌 + `正在下载 0.2.0 · 43%`
  const updateNotice = () => {
    if (later) return null;
    switch (update.kind) {
      case "quiet":
        // 检查失败：一行书面说明 + 外链 `去发布页 ↗`（离开 Sophia，唯一还会去 GitHub 的地方）
        if (checkFailed !== null)
          return (
            <div className="settings-page__note">
              {checkFailed}
              <Button variant="quiet" onClick={() => void openUrl(RELEASES_URL)}>
                去发布页
              </Button>
            </div>
          );
        return null;
      case "ready":
      case "downloading": {
        const version = update.kind === "ready" ? update.update.version : update.version;
        const busy =
          update.kind === "downloading"
            ? "正在下载 " + version + (update.percent === null ? "" : " · " + update.percent + "%")
            : undefined;
        return (
          <NoticePanel
            message={`有新版本：Sophia ${version}`}
            busy={busy}
            action={
              update.kind === "ready"
                ? { label: "下载并安装", onClick: () => void install(update.update) }
                : { label: "下载并安装", onClick: () => undefined }
            }
            link={{ label: "稍后", onClick: () => setLater(true) }}
          />
        );
      }
      case "installed":
        return (
          <NoticePanel
            message={`${update.version} 已安装，重启后生效`}
            action={{ label: "重启", onClick: () => void relaunch() }}
            link={{ label: "稍后", onClick: () => setLater(true) }}
          />
        );
      case "failed":
        return (
          <NoticePanel
            message={`${update.version} 安装失败：${update.reason}`}
            action={{
              label: "再试一次",
              onClick: () =>
                void check().then(
                  (found) => found && install(found),
                  () => {},
                ),
            }}
            link={{ label: "稍后", onClick: () => setLater(true) }}
          />
        );
    }
  };

  /// 点「检查更新」之后：正在检查（键原位忙碌）/ 已是最新（键下方浮起，约 4 秒淡出）/
  /// 检查失败（一行书面说明 + 去发布页的退路）
  const [latest, setLatest] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
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
      onError(String(e));
      await reload();
    }
  };

  /// `检查更新`：在应用里查（产品负责人：跳到 GitHub 让用户手动下载太难用）。有新版出待办条
  /// （下载并安装 → 重启），没有就说「已是最新版本」，查不成才给「去发布页 ↗」的退路
  const checkUpdate = async () => {
    setLater(false);
    setLatest(0);
    setCheckFailed(null);
    setChecking(true);
    try {
      const found = await check();
      if (found) setUpdate({ kind: "ready", update: found });
      else {
        setUpdate({ kind: "quiet" });
        setLatest(Date.now());
      }
    } catch (e) {
      setCheckFailed(updateCheckFailure(e instanceof Error ? e.message : String(e)));
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

  /// 整行是按钮：命中区是整行，方框只是记号。勾满上限时没勾的行禁用，
  /// 提示框说为什么点不了：悬停出、按下当即出（explain：禁用的行不吃指针，悬停与按下落在包层上）
  const row = (agent: AgentOption) => {
    const blocked = full && !agent.enabled;
    const button = (
      <button
        type="button"
        role="checkbox"
        aria-checked={agent.enabled}
        className={`settings-page__row${unchecked?.id === agent.id ? " is-noted" : ""}`}
        // 整行是命中区：悬停这一行方框就「手靠近」（禁用的行不回应）
        data-checkrow={blocked ? undefined : true}
        disabled={blocked}
        onClick={blocked ? undefined : () => void toggle(agent.id, !agent.enabled)}
      >
        <CheckMark on={agent.enabled} />
        <AgentIcon id={agent.id} name={agent.displayName} />
        <span className="settings-page__name">{agent.displayName}</span>
      </button>
    );
    return (
      <div key={agent.id} className="settings-page__cell">
        {blocked ? (
          <Tooltip content={fullReason} focusable explain>
            {button}
          </Tooltip>
        ) : (
          button
        )}
        {unchecked?.id === agent.id ? (
          <FloatingToast key={unchecked.at} align="start">
            <Toast
              kind="success"
              verb="不在列表里显示了"
              reason="已建好的链接原样留着"
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
  const fullReason = `最多显示 ${maxShown} 个，先取消一个`;

  const notice = updateNotice();
  return (
    <ShellPage title="设置">
      <div className="settings-page">
        {/* 区块小标：label Condensed 12 / 600 ink-mute，下 7 一条 hairline；句子里的 agent 是词不是结构词，不经 Cap */}
        <div className="settings-page__section">
          列表里的 agent{list ? ` · 最多 ${maxShown} 个` : ""}
        </div>

        {/* 读回来之前什么都不画：本机读取很快，闪一下忙碌只是噪音（后台例行读取不显示忙碌） */}
        {agents === null ? null : agents.length === 0 ? (
          <div className="settings-page__note">本机上还没有发现任何 agent</div>
        ) : (
          <>
            {grid(present)}
            {/* 没装的收在一行展开里：它不做事，只是在原地把列表拉开，所以是展开的样子（拉手在前、
                收起 › 拉开 ˅，与网关行同一种），不是一颗键（2026-09-25 产品负责人真机：「感觉是个展开？」）。
                列出来只是噪音，但要留入口——用户可能想预先恢复，装上之后就直接在列表里了 */}
            {absent.length > 0 ? (
              <>
                <div className="settings-page__more">
                  <DrawerHandle
                    always
                    open={showAbsent}
                    onToggle={() => setShowAbsent(!showAbsent)}
                    label={`未安装的 ${absent.length} 个`}
                    controls="settings-absent"
                  />
                  <span
                    className="settings-page__more-label"
                    onClick={() => setShowAbsent(!showAbsent)}
                  >
                    未安装的 {absent.length} 个
                  </span>
                </div>
                {showAbsent ? (
                  <div id="settings-absent">
                    <AbsentAgents agents={absent} onRestore={(id) => void toggle(id, true)} />
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}

        <div ref={aboutRef} className="settings-page__section settings-page__section--later">
          关于
        </div>
        <div className="settings-page__about">
          <span className="settings-page__label">版本</span>
          <span className="settings-page__version">{current ?? "…"}</span>
          <span className="settings-page__check">
            {update.kind === "downloading" ? (
              <Button size="compact" disabled disabledReason="正在下载">
                检查更新
              </Button>
            ) : (
              // 查的时候键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 正在检查
              <BusySlot busy={checking} label="正在检查">
                <Button size="compact" onClick={() => !checking && void checkUpdate()}>
                  检查更新
                </Button>
              </BusySlot>
            )}
            {latest ? (
              <FloatingToast key={latest} align="start">
                <Toast kind="success" verb="已是最新版本" onDismiss={dismissLatest} />
              </FloatingToast>
            ) : null}
          </span>
        </div>
        {/* 检查更新的结果（待办条 / 查不成的一句）紧跟在 `检查更新` 那一行下（② 就近） */}
        {notice === null ? null : <div className="settings-page__update">{notice}</div>}
      </div>
    </ShellPage>
  );
}

export default SettingsPage;

import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import type { GatewayState, HarnessList, HarnessStatus } from "../types";
import { parseBackendError, serviceLeftover } from "../modelsView.ts";
import { AgentIcon, NoticePanel, Button, Empty, Spinner, SubPage, Tooltip } from "../ui";
import { AbsentAgents } from "./AbsentAgents.tsx";
import { CheckMark } from "./CheckMark.tsx";
import "./SettingsPage.css";

/// 设置页（DESIGN「产品裁决 › 设置页」，画板 Settings）：占满整窗的二级页面，不渲染侧栏。
/// 它只回答一个问题——**这个 agent 出不出现在列表里**。
///
/// 复选框列表，三列「复选框 + 图标 + 名字」，行高 34；默认只列已安装的，其余收在
/// `显示未安装的 N 个` 后面。**最多显示 4 个**（上限来自 core，`list_harnesses` 带回）：
/// 勾满时其余已安装项禁用，提示框「最多显示 4 个，先取消一个」。「取消勾选只是不在列表里显示，已建好的链接原样留着」不常驻——
/// **取消勾选那一刻在该行旁出现**，4 秒后淡出（① 信息在对的时间出现）。
/// 再往下 48：`关于`——版本（等宽）+ `检查更新`（应用内查，不跳 GitHub）。
///
/// 改一个生效一个，返回即走，**没有「保存」按钮**；Esc 与 ← 都回主视图（SubPage 负责）。
///
/// 三件故意不做的事：
/// - **不展示路径**。用户要做的判断只有一个，路径是我们的实现细节（§13.1）。
/// - 不提「目录不存在，开启任一 skill 时会建出来」——那是开启 skill 那一刻的事，
///   写在设置里是提前解释一件用户还没做的事（§13.1）。
/// - 不给「链接方式（相对 / 绝对）」开关：它按「本体是否在目标项目内」自动判，
///   是正确性判断不是口味问题（§14）。

/// `list_harnesses` 返回全部 41 个，各自带 installed。默认只列已安装的，
/// 其余收在「显示未安装的 N 个」后面。
type AgentOption = HarnessStatus;

/// 取消勾选时行旁那句话停留多久
const UNCHECK_NOTE_MS = 4000;

/// 发布页：只在应用内查不成时作退路（`去发布页 ↗`，离开 Sophia 的文字链）
/// 「已是最新版本」停留多久（例行一行，约 4 秒淡出）
const LATEST_NOTE_MS = 4000;

const RELEASES_URL = "https://github.com/zhengjiaqiao/sophia/releases/latest";

/// 更新这件事的五种处境。只有需要用户拿主意的三种会长出行内待办条（灰面板）：
/// 有新版、装好了等重开、没装上。查的过程和下载的过程都不要用户决定什么。
type UpdateState =
  | { kind: "quiet" }
  | { kind: "ready"; update: Update }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "installed"; version: string }
  | { kind: "failed"; version: string; reason: string };

export interface SettingsPageProps {
  onBack: () => void;
  /// 应用启动时查到的新版；`undefined` 表示壳没查过（比如测试里），页面自己再查一次。
  /// 查在启动时做而不是打开设置时做——用户不进设置也该有机会知道有新版
  initialUpdate?: Update | null;
  onError: (message: string) => void;
}

export function SettingsPage({ onBack, onError, initialUpdate }: SettingsPageProps) {
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

  /// 三种要用户拿主意的处境各自一条行内待办条；查和下载的过程只是一行字
  const updateNotice = () => {
    if (later) return null;
    switch (update.kind) {
      case "quiet":
        if (checking)
          return (
            <div className="settings-page__note settings-page__checking">
              <Spinner size={14} label="正在检查" />
              正在检查
            </div>
          );
        if (checkFailed !== null)
          return (
            <div className="settings-page__note">
              没查成：{checkFailed}
              <span className="settings-page__fallback">
                <Button variant="external" onClick={() => void openUrl(RELEASES_URL)}>
                  去发布页
                </Button>
              </span>
            </div>
          );
        return latest ? <div className="settings-page__note">✓ 已是最新版本</div> : null;
      case "downloading":
        return (
          <div className="settings-page__note">
            正在下载 {update.version}
            {update.percent === null ? "" : ` · ${update.percent}%`}
          </div>
        );
      case "ready":
        return (
          <NoticePanel
            message={
              <>
                Sophia <span className="settings-page__version">{update.update.version}</span>{" "}
                出来了
              </>
            }
            action={{ label: "下载并安装", onClick: () => void install(update.update) }}
            link={{ label: "稍后", onClick: () => setLater(true) }}
          />
        );
      case "installed":
        return (
          <NoticePanel
            message={
              <>
                <span className="settings-page__version">{update.version}</span>{" "}
                装好了，重开一次就用上它
              </>
            }
            action={{ label: "重开", onClick: () => void relaunch() }}
            link={{ label: "稍后", onClick: () => setLater(true) }}
          />
        );
      case "failed":
        return (
          <NoticePanel
            message={`${update.version} 没装上：${update.reason}`}
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

  /// 点「检查更新」之后的三种一行字：正在检查 / 已是最新（约 4 秒淡出）/ 没查成（给去发布页的退路）
  const [latest, setLatest] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const latestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (latestTimer.current) clearTimeout(latestTimer.current);
    },
    [],
  );

  /// 后台服务（Codex 模型网关的路由服务）那一行：按状态写，不常驻「卸下」。
  /// null＝还没读到、或这台机器不支持（读不到就整行不显示，不打扰）
  const [gateway, setGateway] = useState<GatewayState | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  useEffect(() => {
    void api.gatewayState().then(
      (state) => setGateway(state.supported ? state : null),
      () => setGateway(null),
    );
  }, []);
  /// 停用了但服务还在（自动卸下失败或旧版遗留）。与 Codex 行「卸下后台服务」同一个判断
  const leftover = gateway !== null && serviceLeftover(gateway);
  const inUse = gateway !== null && gateway.enabled;

  /// 卸下：恢复 Codex 设置、卸载后台服务。完成后这一行随状态消失；失败就在这一行说原因
  const uninstall = async () => {
    setUninstalling(true);
    setUninstallError(null);
    try {
      setGateway(await api.gatewayRestore());
    } catch (e) {
      setUninstallError(parseBackendError(String(e)).message);
    } finally {
      setUninstalling(false);
    }
  };

  /// 刚取消勾选的那一行：行旁出一句说明，4 秒后淡出
  const [unchecked, setUnchecked] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

  /// 点一下切换，当场生效。写盘成功后重读一次，界面始终以落盘结果为准
  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.setHarnessEnabled(id, enabled);
      if (noteTimer.current) clearTimeout(noteTimer.current);
      if (enabled) setUnchecked(null);
      else {
        setUnchecked(id);
        noteTimer.current = setTimeout(() => setUnchecked(null), UNCHECK_NOTE_MS);
      }
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  /// `检查更新`：在应用里查（产品负责人：跳到 GitHub 让用户手动下载太难用）。有新版出待办条
  /// （下载并安装 → 重开），没有就说「已是最新版本」，查不成才给「去发布页 ↗」的退路
  const checkUpdate = async () => {
    if (latestTimer.current) clearTimeout(latestTimer.current);
    setLater(false);
    setLatest(false);
    setCheckFailed(null);
    setChecking(true);
    try {
      const found = await check();
      if (found) setUpdate({ kind: "ready", update: found });
      else {
        setUpdate({ kind: "quiet" });
        setLatest(true);
        latestTimer.current = setTimeout(() => setLatest(false), LATEST_NOTE_MS);
      }
    } catch (e) {
      setCheckFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  /// 整行是按钮：命中区是整行，方框只是记号。勾满上限时没勾的行禁用，
  /// 提示框说为什么点不了（禁用键接不到悬停，提示框挂在包层上）
  const row = (agent: AgentOption) => {
    const blocked = full && !agent.enabled;
    const button = (
      <button
        type="button"
        role="checkbox"
        aria-checked={agent.enabled}
        className={`settings-page__row${unchecked === agent.id ? " is-noted" : ""}`}
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
          <Tooltip content={fullReason} focusable>
            {button}
          </Tooltip>
        ) : (
          button
        )}
        {unchecked === agent.id ? (
          <span className="settings-page__rownote" role="status">
            不在列表里显示了，已建好的链接原样留着
          </span>
        ) : null}
      </div>
    );
  };

  /// 三列、按列读（字母序竖着看）：行数取总数的三分之一向上取整
  const grid = (items: AgentOption[]) => (
    <div
      className="settings-page__grid"
      style={{ gridTemplateRows: `repeat(${Math.max(1, Math.ceil(items.length / 3))}, auto)` }}
    >
      {items.map(row)}
    </div>
  );

  const present = (agents ?? []).filter((a) => a.installed);
  const absent = (agents ?? []).filter((a) => !a.installed);
  const maxShown = list?.maxShown ?? 0;
  /// 已显示满上限：其余已安装项不能再勾
  const full = list !== null && present.filter((a) => a.enabled).length >= maxShown;
  const fullReason = `最多显示 ${maxShown} 个，先取消一个`;

  return (
    <SubPage title="设置" onBack={onBack}>
      <div className="settings-page">
        {/* 区块小标：贴 1px ink 分组线下沿 6（DESIGN「刻字」）；句子里的 agent 不大写 */}
        <div className="settings-page__section">
          哪些 agent 出现在列表里{list ? ` · 最多 ${maxShown} 个` : ""}
        </div>

        {agents === null ? (
          <Empty kind="scanning" description="读取中" />
        ) : agents.length === 0 ? (
          <div className="settings-page__note">本机上还没有发现任何 agent。</div>
        ) : (
          <>
            {grid(present)}
            {/* 没装的收在一行文字链后面：列出来只是噪音，但要留入口——
                用户可能想预先开启，装上之后就直接在列表里了 */}
            {absent.length > 0 ? (
              <>
                <div className="settings-page__more">
                  <Button variant="link" onClick={() => setShowAbsent(!showAbsent)}>
                    {showAbsent
                      ? `收起未安装的 ${absent.length} 个`
                      : `显示未安装的 ${absent.length} 个`}
                  </Button>
                </div>
                {showAbsent ? (
                  <AbsentAgents agents={absent} onRestore={(id) => void toggle(id, true)} />
                ) : null}
              </>
            ) : null}
          </>
        )}

        <div className="settings-page__section settings-page__section--later">关于</div>
        <div className="settings-page__about">
          <span className="settings-page__name">版本</span>
          <span className="settings-page__version">{current ?? "…"}</span>
          <span className="settings-page__check">
            {checking || update.kind === "downloading" ? (
              <Button variant="link" disabled disabledReason={checking ? "正在检查" : "正在下载"}>
                检查更新
              </Button>
            ) : (
              <Button variant="link" onClick={() => void checkUpdate()}>
                检查更新
              </Button>
            )}
          </span>
        </div>
        <div className="settings-page__update">{updateNotice()}</div>
        {inUse ? (
          <div className="settings-page__service">
            <span className="settings-page__name">后台服务</span>
            <span className="settings-page__dot">·</span>
            <Tooltip content="要停用，请在模型页关掉 Codex 的开关" focusable>
              <span className="settings-page__state has-tip">使用中</span>
            </Tooltip>
          </div>
        ) : leftover ? (
          <>
            <div className="settings-page__service">
              <span className="settings-page__name">后台服务</span>
              <span className="settings-page__dot">·</span>
              <span className="settings-page__state">已停用但仍在运行</span>
              <span className="settings-page__dot">·</span>
              {uninstalling ? (
                <span className="settings-page__busy">
                  <Spinner size={14} label="正在卸下后台服务" />
                  正在卸下
                </span>
              ) : (
                <Button
                  variant="link"
                  title="恢复 Codex 设置、卸载后台服务，卸下后不再占用资源"
                  onClick={() => void uninstall()}
                >
                  卸下
                </Button>
              )}
            </div>
            {uninstallError !== null ? (
              <div className="settings-page__update">
                <NoticePanel message={`没卸下：${uninstallError}`} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </SubPage>
  );
}

export default SettingsPage;

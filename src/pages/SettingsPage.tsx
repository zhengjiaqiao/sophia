import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { api } from "../api";
import type { HarnessStatus } from "../types";
import { AgentIcon, Button, Chip, Empty, RowNotice, SubPage } from "../ui";
import "./SettingsPage.css";

/// 设置页（组件规范 §4.6、§13.1）：占满整窗的二级页面，不渲染侧栏。
/// 它只回答一个问题——**这个 agent 出不出现在矩阵里**。
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
/// 其余收在「显示未安装的 N 个」后面——没装的也能预先开启，所以要给入口。
type AgentOption = HarnessStatus;

/// 更新这件事的五种处境。只有需要用户拿主意的三种会长出行内待办条（§4.4）：
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
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [showAbsent, setShowAbsent] = useState(false);

  const reload = async () => {
    try {
      setAgents(await api.listHarnesses());
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
        return null;
      case "downloading":
        return (
          <div className="settings-page__note">
            正在取 {update.version}
            {update.percent === null ? "…" : `…${update.percent}%`}
          </div>
        );
      case "ready":
        return (
          <RowNotice
            message={
              <>
                Sophia <span className="settings-page__version">{update.update.version}</span>{" "}
                出来了。
              </>
            }
            actions={[{ label: "取回来装上", onClick: () => void install(update.update) }]}
            onLater={() => setLater(true)}
          />
        );
      case "installed":
        return (
          <RowNotice
            message={
              <>
                <span className="settings-page__version">{update.version}</span>{" "}
                装好了，重开一次就用上它。
              </>
            }
            actions={[{ label: "重开", onClick: () => void relaunch() }]}
            onLater={() => setLater(true)}
          />
        );
      case "failed":
        return (
          <RowNotice
            message={`${update.version} 没装上——${update.reason}`}
            actions={[
              {
                label: "再试一次",
                onClick: () =>
                  void check().then(
                    (found) => found && install(found),
                    () => {},
                  ),
              },
            ]}
            onLater={() => setLater(true)}
          />
        );
    }
  };

  /// 点一下切换。写盘成功后重读一次，界面始终以落盘结果为准
  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.setHarnessEnabled(id, enabled);
      await reload();
    } catch (e) {
      onError(String(e));
    }
  };

  const chip = (agent: AgentOption) => (
    <Chip
      key={agent.id}
      icon={<AgentIcon id={agent.id} name={agent.displayName} />}
      selected={agent.enabled}
      title={
        agent.enabled
          ? `点一下，矩阵里不再显示 ${agent.displayName}`
          : `点一下，让 ${agent.displayName} 出现在矩阵里`
      }
      onClick={() => void toggle(agent.id, !agent.enabled)}
    >
      {agent.displayName}
    </Chip>
  );

  const present = (agents ?? []).filter((a) => a.installed);
  const absent = (agents ?? []).filter((a) => !a.installed);

  return (
    <SubPage title="设置" onBack={onBack}>
      <div className="settings-page">
        {/* 版本一行摆在最前面：没有新版时它就是全部，有新版时提示条挂在它下面（§4.4）。
            不给「检查更新」按钮——进来就已经查过了，按钮只会让人怀疑它没在查。 */}
        <div className="settings-page__head">
          <span className="settings-page__label">版本</span>
          <span className="settings-page__version">{current ?? "…"}</span>
        </div>
        <div className="settings-page__update">{updateNotice()}</div>

        <div className="settings-page__head settings-page__head--later">
          <span className="settings-page__label">Agent</span>
          {/* 说明句不大写：被谈论的对象一律不大写（§1.2） */}
          <span className="settings-page__note">哪些 agent 出现在矩阵里</span>
        </div>

        {agents === null ? (
          <Empty kind="scanning" description="读取中…" />
        ) : agents.length === 0 ? (
          <div className="settings-page__note">本机上还没有发现任何 agent。</div>
        ) : (
          <>
            {/* 选择片网格，不是一行一个复选框（§13.1） */}
            <div className="settings-page__grid">{present.map(chip)}</div>

            {/* 没装的收在一行文字链后面：列出来只是噪音，但要留入口——
                用户可能想预先开启，装上之后就直接在矩阵里了 */}
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
                  <div className="settings-page__grid settings-page__grid--absent">
                    {absent.map(chip)}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}

        <div className="settings-page__foot">
          关掉一个 agent 只是不在矩阵里显示它，已经建好的链接原样留在磁盘上，不删，再打开就回来。
        </div>
      </div>
    </SubPage>
  );
}

export default SettingsPage;

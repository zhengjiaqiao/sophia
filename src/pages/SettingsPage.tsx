import { useEffect, useState } from "react";
import { api } from "../api";
import type { HarnessStatus } from "../types";
import { AgentIcon, Button, Chip, Empty, SubPage } from "../ui";
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

/// `list_harnesses` 今天只返回**已安装的**那几个（`src-tauri/src/lib.rs` 里调的是
/// `discovery::installed`），返回项里没有 installed 字段，也带不出没装的那 32 个。
/// 所以这里按「缺这个字段＝已安装」读：等命令把全部 41 个连同 installed 一起带出来，
/// 「显示未安装的 M 个」那一行自动就有了，这个文件不用再动。
type AgentOption = HarnessStatus & { installed?: boolean };

export interface SettingsPageProps {
  onBack: () => void;
  onError: (message: string) => void;
}

export function SettingsPage({ onBack, onError }: SettingsPageProps) {
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

  const present = (agents ?? []).filter((a) => a.installed !== false);
  const absent = (agents ?? []).filter((a) => a.installed === false);

  return (
    <SubPage title="设置" onBack={onBack}>
      <div className="settings-page">
        <div className="settings-page__head">
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

import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { parseBackendError } from "./backendError.ts";
import type { AgentListRowProps } from "./shell/agentRegistry.ts";
import type { GatewayState } from "./types.ts";
import { BusySlot, NoticePanel, Switch, Tooltip } from "./ui/index.ts";
import {
  workbuddyOf,
  workbuddySwitchReason,
  workbuddySwitchText,
  workbuddySwitchTip,
  workbuddyAllowListNote,
  workbuddyTodo,
} from "./workbuddyView.ts";
import "./workbuddyControls.css";

/// WorkBuddy 的第三方模型控件（#266；DESIGN「模型 › 一个 agent 一行」）：`已选 N 个模型 ▾` + 开关；行下的待办条。
/// WorkBuddy 自动重读 models.json，没有 `重启生效`。判断与文案在 workbuddyView

const describeError = (error: unknown): string => parseBackendError(String(error)).message;

/// 跑一个写 WorkBuddy 配置的动作：成了把后端给的状态报给壳；没成重读并返回原因。组件没了返回 undefined
function useAttempt(onGatewayState: (state: GatewayState) => void) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return async (act: () => Promise<GatewayState>): Promise<string | null | undefined> => {
    let reason: string | null = null;
    try {
      const next = await act();
      if (mounted.current) onGatewayState(next);
    } catch (error) {
      reason = describeError(error);
      try {
        const next = await api.gatewayState();
        if (mounted.current) onGatewayState(next);
      } catch {
        // 重读失败不打扰
      }
    }
    return mounted.current ? reason : undefined;
  };
}

/// 模型页里 WorkBuddy 那一行的右端控件列（注册表 `listRow.Controls`）：`已选 N 个模型 ▾`（`pick`）+ 12 + 开关。
/// 拨了就写、不确认、乐观翻转；按不动时按下即说原因。没写成：这一行下出灰面板 + `再试一次`（经 `onNotice`）
export function WorkBuddyListControls({
  state,
  onNotice,
  onGatewayState,
  pick,
}: AgentListRowProps) {
  const view = workbuddyOf(state);
  const [switching, setSwitching] = useState<boolean | null>(null);
  const attempt = useAttempt(onGatewayState);
  if (view === null) return null;
  const blocked = workbuddySwitchReason(view);
  const on = switching ?? view.enabled;
  const label = t("models.workbuddy.switchLabel");

  const toggle = async (next: boolean) => {
    onNotice(null);
    setSwitching(next);
    const reason = await attempt(() =>
      next ? api.gatewayEnable("workbuddy") : api.gatewayRestore("workbuddy"),
    );
    if (reason === undefined) return;
    setSwitching(null);
    if (reason !== null)
      onNotice(
        <NoticePanel
          message={workbuddySwitchText(next).failed}
          reason={reason}
          action={{ label: t("models.notice.retry"), onClick: () => void toggle(next) }}
          onClose={() => onNotice(null)}
        />,
      );
  };

  return (
    <>
      {pick}
      <span className="workbuddy-switch">
        {blocked !== null && switching === null ? (
          <Switch
            checked={false}
            onChange={() => undefined}
            label={label}
            disabledReason={blocked}
            tipPlacement="bottom"
          />
        ) : (
          <BusySlot busy={switching !== null} label={workbuddySwitchText(switching ?? true).busy}>
            <Tooltip content={workbuddySwitchTip(on)} placement="bottom">
              <Switch
                checked={on}
                onChange={(next) => void toggle(next)}
                label={label}
                disabledReason={switching !== null ? t("models.control.busyPrev") : undefined}
              />
            </Tooltip>
          </BusySlot>
        )}
      </span>
    </>
  );
}

/// 模型页里 WorkBuddy 那一行下的待办条（注册表 `listRow.Todos`）：开着、文件里却没有 Sophia 的条目了 + `重新写入`。
/// 做不成：行下灰面板 + `再试一次`。问题解决自动收起
export function WorkBuddyRowTodos({ state, onNotice, onGatewayState }: AgentListRowProps) {
  const view = workbuddyOf(state);
  const [busy, setBusy] = useState(false);
  const attempt = useAttempt(onGatewayState);
  if (view === null) return null;
  const todo = workbuddyTodo(view);
  if (todo === null) {
    const note = workbuddyAllowListNote(view);
    return note === null ? null : <NoticePanel message={note.message} reason={note.reason} />;
  }

  const rewrite = async () => {
    onNotice(null);
    setBusy(true);
    const reason = await attempt(() => api.gatewayEnable("workbuddy"));
    if (reason === undefined) return;
    setBusy(false);
    if (reason !== null)
      onNotice(
        <NoticePanel
          message={t("models.notice.rewriteFailed", { tool: "WorkBuddy" })}
          reason={reason}
          action={{ label: t("models.notice.retry"), onClick: () => void rewrite() }}
          onClose={() => onNotice(null)}
        />,
      );
  };

  return (
    <NoticePanel
      message={todo.message}
      reason={todo.reason ?? undefined}
      busy={busy ? todo.busy : undefined}
      action={{ label: todo.label, onClick: () => void rewrite() }}
    />
  );
}

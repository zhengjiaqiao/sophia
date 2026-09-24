import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import { parseBackendError } from "./modelsView.ts";
import { createSelectionWriter } from "./selectionWrites.ts";
import { AGENTS } from "./shell/agents.tsx";
import type { AgentState, TrayHost } from "./shell/agentRegistry.ts";
import { trayAgentState, trayBlocks, type TrayBlock } from "./trayView.ts";
import type { GatewayState } from "./types.ts";
import { AgentIcon } from "./ui/index.ts";
import "./TrayPanel.css";

/// 菜单栏面板（DESIGN「托盘面板」，画板 V4Layouts-tray）。宽 320、`paper` 底、1px `hairline`、12 圆角
/// （原生窗口是不激活应用的 NSPanel，圆角与位置在 tray.rs）。
///
/// **一个 agent 一块、一种能力一行**：块与行从外壳的 agent 注册表生成（与侧栏 `agent` 段、agent 页的节
/// 同一份名单与顺序）。块头只有 16px 图标 + 名字，不放控件；下面每种能力一行。**一条左沿**：块头图标、
/// 能力行的名字、菜单项的字都从面板内 16 起（2026-09-25，三条左沿就是乱）。不列在用的模型。
/// **每一行怎么画也在注册表里**（节的 `trayRow`，今天只有 `第三方模型` → TrayModelsRow.tsx）：以后的 `用量`
/// 在注册表里给那一节配一个 `trayRow`，面板就出这一行，这个文件不用改。
///
/// 面板只管面板级的事：读回状态（每次弹出都重读）、把后端给的新状态画上去并广播给主窗口、焦点落在面板本身、
/// Esc 收起、高度跟着内容走。分隔 1px `row-line` 之下是菜单两项 `打开 Sophia` `退出`。没有 `设置`
/// （D9，经 `打开 Sophia` 一步可达）；`退出` 后不写 `⌘Q`（面板不激活 Sophia，⌘Q 退出的是前台那个应用）。

/// 面板里的动作做不成：主窗口到前面、切到 Codex 页、把原话带过去（面板放不下一段解释）
const failOver = (error: unknown) =>
  void api.trayOpenMain("models", parseBackendError(String(error)).message);

export default function TrayPanel() {
  const [state, setState] = useState<GatewayState | null>(null);
  /// 第几次弹出：行据此收回上次没答的确认
  const [openedAt, setOpenedAt] = useState(0);
  const mounted = useRef(true);
  /// 后端给的状态一律经它：画上去、广播给主窗口（与 Codex 页同一个入口）
  const [writer] = useState(() =>
    createSelectionWriter<GatewayState>({
      paint: (next) => setState(next),
      report: () => void emit("gateway-changed"),
      reread: () => api.gatewayState(),
      onDone: () => undefined,
      onFail: (_message, error) => failOver(error),
      alive: () => mounted.current,
    }),
  );
  const applyState = writer.accept;
  const alive = useCallback(() => mounted.current, []);
  const idle = useCallback(() => writer.idle(), [writer]);

  const refresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch (error) {
      failOver(error);
    }
  }, [applyState]);

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // 每次弹出都重读：主窗口、命令行、别的程序都可能改过状态；外部重启 / 打开了 Codex，键要自己消失
    const pending = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      // 弹出时焦点落在面板本身，不落在任何控件上：否则 WebKit 把它交给第一个能聚焦的东西
      // （禁用开关的原因包层），一弹出就是焦点框 + 原因提示。Tab 仍从第一个控件开始
      // 窗口变成键窗口之后 WebKit 才挑初始焦点，所以下一帧再收一次
      rootRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
      setOpenedAt((n) => n + 1);
      void refresh();
    });
    return () => {
      mounted.current = false;
      void pending.then((un) => un());
    };
  }, [refresh]);

  // Esc 收起面板（行里有确认开着时，那一行在捕获阶段先接住、只收回那一问）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void api.trayHide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // 面板高度跟着内容走：确认、灰面板展开时高一点
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const report = () => void api.traySetHeight(Math.ceil(root.getBoundingClientRect().height));
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);

  const agentState = trayAgentState(state);
  const blocks = trayBlocks(AGENTS, agentState);
  const host: TrayHost = { applyGateway: applyState, idle, alive, openedAt, failOver };

  return (
    <div className={`tray${blocks.length === 0 ? " tray--bare" : ""}`} ref={rootRef} tabIndex={-1}>
      <TrayAgents blocks={blocks} state={agentState} host={host} />
      {blocks.length > 0 ? <hr className="tray__rule" /> : null}
      <ul className="tray__menu">
        <li>
          <button
            type="button"
            className="tray__item"
            onClick={() => void api.trayOpenMain(null, null)}
          >
            打开 Sophia
          </button>
        </li>
        <li>
          <button type="button" className="tray__item" onClick={() => void api.trayQuit()}>
            退出
          </button>
        </li>
      </ul>
    </div>
  );
}

/// 面板上半：一个 agent 一块（块头图标 + 名字），块里按注册表的先后画每一节的 `trayRow`
export function TrayAgents({
  blocks,
  state,
  host,
}: {
  blocks: TrayBlock[];
  state: AgentState;
  host: TrayHost;
}) {
  return (
    <>
      {blocks.map((block) => (
        <section key={block.id} className="tray__agent" aria-label={block.name}>
          <div className="tray__head">
            <AgentIcon id={block.id} name={block.name} size={16} />
            <span className="tray__name">{block.name}</span>
          </div>
          {block.rows.map((row) => (
            <row.Row key={row.id} title={row.title} state={state} tray={host} />
          ))}
        </section>
      ))}
    </>
  );
}

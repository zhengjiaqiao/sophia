import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import {
  CODEX,
  LAUNCH_POLL_MS,
  LAUNCH_TIMEOUT,
  LAUNCH_TIMEOUT_MS,
  gatewayConfirmText,
  gatewaySwitchText,
  parseBackendError,
  settleAfterRestart,
  switchGateway,
} from "./modelsView";
import { createSelectionWriter } from "./selectionWrites";
import { AGENTS } from "./shell/agents.tsx";
import {
  LAUNCH_TIP,
  MODEL_SEPARATOR,
  RESTART_CONSEQUENCE,
  RESTART_TIP,
  UNINSTALL_TIP,
  fitModelCount,
  trayAgentState,
  trayBlocks,
  trayModels,
  trayRow,
  type TrayModel,
} from "./trayView";
import type { GatewayState } from "./types";
import {
  AgentIcon,
  BusySlot,
  Button,
  FloatingToast,
  NoticePanel,
  Switch,
  Toast,
  Tooltip,
} from "./ui";
import "./TrayPanel.css";

/// 菜单栏面板（DESIGN「托盘面板」，画板 V4Layouts-tray）。宽 320、`paper` 底、1px `hairline`、12 圆角
/// （原生窗口是不激活应用的 NSPanel，圆角与位置在 tray.rs）。
///
/// **一个 agent 一块、一种能力一行**：块与行从外壳的 agent 注册表生成（与侧栏 `agent` 段、agent 页的节
/// 同一份名单与顺序）。块头只有 16px 图标 + 名字，不放控件；下面每种能力一行，左沿对齐名字。
/// 面板会画的能力行按节 id 登记在 `CAPABILITY_ROWS`：今天只有 `third-party-models`
/// （`第三方模型` + 右端开关 → 在用的模型 → 条件键位 → 当场展开的确认 / 灰面板）；以后的 `用量` 行
/// 在这里加一种画法，注册表里它排在前面，面板里就排在前面。
///
/// 分隔 1px `row-line` 之下是菜单两项 `打开 Sophia` `退出`。没有 `设置`（D9，经 `打开 Sophia` 一步可达）；
/// `退出` 后不写 `⌘Q`（面板不激活 Sophia，⌘Q 退出的是前台那个应用）。
///
/// `第三方模型` 与 Codex 页同一段逻辑（modelsView）：
/// - 开关不乐观翻转：Codex 在跑先在面板里确认（`重启并添加` / `重启并移除`），取消什么都不写；确认后开关
///   原位转圈 +「正在添加 / 正在移除」，成了落到新状态、开关下方浮起 `✓ 已添加到 Codex`；没成则连配置一起撤回，
///   键位原位灰面板 + `再试一次`
/// - 键位 `重启生效` / `启动 Codex` / `卸下后台服务` 占同一位（默认键紧凑），规则同 Codex 页
/// - 卸下后台服务做不成：把主窗口带到 Codex 页，由那里说原因——面板放不下一段解释
/// - 面板改了状态就广播 `gateway-changed`，主窗口跟着刷新

/// 面板会画的能力行（按注册表的节 id）
const CAPABILITY_ROWS = new Set(["third-party-models"]);

/// 面板里的动作做不成：主窗口到前面、切到 Codex 页、把原话带过去
const failOver = (error: unknown) =>
  api.trayOpenMain("models", parseBackendError(String(error)).message);

/// 键位那一处在做什么：重启生效的确认 / 重启中 / 已生效；启动中 / 已启动；
/// 拨开关的确认 / 写配置到 Codex 换上 / 成了那一窗
type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "restarting" }
  | { kind: "done" }
  | { kind: "launching" }
  | { kind: "launched" }
  | { kind: "confirmSwitch"; next: boolean }
  | { kind: "switching"; next: boolean }
  | { kind: "switched"; text: string };

/// 键位原位的灰面板：主句 + 原因 + `再试一次`。`for` 说它跟着哪颗键：那颗键消失（问题解决了）就一起走
interface TrayNotice {
  message: string;
  reason: string;
  retry: () => void;
  for: "restart" | "launch" | "switch";
}

export default function TrayPanel() {
  const [state, setState] = useState<GatewayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /// 重启 / 启动 / 拨开关没成（键位原位灰面板）：带下一步的失败不会自己走——关掉、再试一次、
  /// 或问题解决了（那颗键消失）才走，面板收起再弹出也还在
  const [notice, setNotice] = useState<TrayNotice | null>(null);
  const mounted = useRef(true);
  /// 此刻画在面板上的状态
  const shown = useRef<GatewayState | null>(null);
  /// 后端给的状态一律经它：画上去、广播给主窗口。开关不再乐观翻转、不经它的写队列
  /// （见 runSwitch），留着它是为了与 Codex 页同一个入口；写失败那一支面板用不到
  const [writer] = useState(() =>
    createSelectionWriter<GatewayState>({
      paint: (next) => {
        shown.current = next;
        setState(next);
      },
      report: () => void emit("gateway-changed"),
      reread: () => api.gatewayState(),
      onDone: () => undefined,
      onFail: (_message, error) => void failOver(error),
      alive: () => mounted.current,
    }),
  );
  const applyState = writer.accept;

  const refresh = useCallback(async () => {
    try {
      const next = await api.gatewayState();
      if (mounted.current) applyState(next);
    } catch (error) {
      void failOver(error);
    }
  }, [applyState]);

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
      // 收起时没答的确认作废；正在做的（重启、启动、拨开关）照常做完
      setPhase((p) =>
        p.kind === "restarting" || p.kind === "switching" || p.kind === "launching"
          ? p
          : { kind: "idle" },
      );
      void refresh();
    });
    return () => {
      mounted.current = false;
      void pending.then((un) => un());
    };
  }, [refresh]);

  // ✓ 已生效 / 已启动 / 已添加那一窗到点（停留、悬停停表、淡出都在 Toast 里）
  const dismissDone = useCallback(() => setPhase({ kind: "idle" }), []);

  /// 拨开关：Codex 在跑先在面板里确认（要重启，进行中的对话会中断）；没在跑直接写
  const toggle = (next: boolean) => {
    const current = shown.current;
    if (!current) return;
    setNotice(null);
    if (current.codex.running) setPhase({ kind: "confirmSwitch", next });
    else void runSwitch(next, false);
  };

  /// 写配置 →（在跑时）重启 Codex → 等它换上（最多 15 秒）；没成则撤回刚写的（同 Codex 页，switchGateway）
  const runSwitch = async (next: boolean, restart: boolean) => {
    setNotice(null);
    setPhase({ kind: "switching", next });
    setBusy(true);
    let reason: string | null | undefined;
    try {
      await writer.idle();
      reason = await switchGateway(next, restart, {
        write: (on) => (on ? api.gatewayEnable() : api.gatewayRestore()),
        restartCodex: api.gatewayRestartCodex,
        read: api.gatewayState,
        onState: applyState,
        alive: () => mounted.current,
        describe: (error) => parseBackendError(String(error)).message,
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (reason === undefined || !mounted.current) return;
    const text = gatewaySwitchText(next, restart);
    if (reason === null) {
      setPhase({ kind: "switched", text: text.done });
      return;
    }
    setPhase({ kind: "idle" });
    setNotice({ message: text.failed, reason, retry: () => toggle(next), for: "switch" });
  };

  /// 停用后服务仍在：卸下它。做不成就把主窗口带到 Codex 页说原因（面板放不下一段解释）
  const uninstall = async () => {
    setUninstalling(true);
    setBusy(true);
    try {
      // 排在还没写完的开关后面：都写 Codex 设置，先后要和点的顺序一致
      await writer.idle();
      const fresh = await api.gatewayRestore();
      if (mounted.current) applyState(fresh);
    } catch (error) {
      void failOver(error);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setUninstalling(false);
      }
    }
  };

  const restartCodex = async () => {
    setNotice(null);
    setPhase({ kind: "restarting" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await writer.idle();
      await api.gatewayRestartCodex();
      // 同 Codex 页：等旧进程退了才算成，上限 15 秒（发完信号立刻读会误判成没重启）
      const settled = await settleAfterRestart(api.gatewayState, applyState, () => mounted.current);
      if (settled === undefined) return;
      reason = settled;
    } catch (error) {
      reason = parseBackendError(String(error)).message;
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setNotice(
      reason === null
        ? null
        : {
            message: `没重启 ${CODEX.name}`,
            reason,
            retry: () => void restartCodex(),
            for: "restart",
          },
    );
    setPhase(reason === null ? { kind: "done" } : { kind: "idle" });
  };

  /// 启动 Codex（同 Codex 页）：不打断任何东西，不确认。键位原地忙碌 +「正在启动 Codex」，
  /// 轮询到它在跑（上限 15 秒）才算成；超时或打不开，键位原位灰面板说原因 + `再试一次`
  const launchCodex = async () => {
    setNotice(null);
    setPhase({ kind: "launching" });
    setBusy(true);
    let reason: string | null = null;
    try {
      await writer.idle();
      await api.gatewayLaunchCodex();
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      for (;;) {
        const fresh = await api.gatewayState();
        if (!mounted.current) return;
        applyState(fresh);
        if (fresh.codex.running) break;
        if (Date.now() >= deadline) {
          reason = LAUNCH_TIMEOUT;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
        if (!mounted.current) return;
      }
    } catch (error) {
      reason = parseBackendError(String(error)).message;
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setNotice(
      reason === null
        ? null
        : {
            message: `没启动 ${CODEX.name}`,
            reason,
            retry: () => void launchCodex(),
            for: "launch",
          },
    );
    setPhase(reason === null ? { kind: "launched" } : { kind: "idle" });
  };

  // Esc：确认开着先收回那一问，否则收起面板
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (phase.kind === "confirming" || phase.kind === "confirmSwitch") setPhase({ kind: "idle" });
      else void api.trayHide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [phase]);

  // 面板高度跟着内容走：确认、灰面板展开时高一点
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const report = () => void api.traySetHeight(Math.ceil(root.getBoundingClientRect().height));
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);

  const blocks = trayBlocks(AGENTS, trayAgentState(state), CAPABILITY_ROWS);

  /// 确认在面板里当场展开（一块凹面）：标题 + 一句后果 + `取消`（默认键）与主动作墨键，都紧凑
  const confirmPanel = (title: string, body: string, label: string, onConfirm: () => void) => (
    <div className="tray__confirm" role="dialog" aria-label={title}>
      <div className="tray__confirm-title">{title}</div>
      <div className="tray__confirm-body">{body}</div>
      <div className="tray__confirm-foot">
        <Button size="compact" onClick={() => setPhase({ kind: "idle" })}>
          取消
        </Button>
        <Button variant="primary" size="compact" onClick={onConfirm}>
          {label}
        </Button>
      </div>
    </div>
  );

  /// 键位：`重启生效` / `启动 Codex` / `卸下后台服务` 占同一位；做的时候原位忙碌，成了原位下方浮起一窗
  const keySlot = (current: GatewayState) => {
    const row = trayRow(current);
    // 拨开关写完配置到 Codex 换上之间，状态会说「要重启」「没在跑」：键不能跟着闪出来
    if (phase.kind === "switching") return null;
    if (phase.kind === "restarting" || phase.kind === "launching") {
      // 键锁住，过了 0.3 秒门槛原位换成忙碌指示 + 一句
      const restarting = phase.kind === "restarting";
      return (
        <BusySlot busy label={`${restarting ? "正在重启" : "正在启动"} ${CODEX.name}`}>
          <Button size="compact">{restarting ? "重启生效" : `启动 ${CODEX.name}`}</Button>
        </BusySlot>
      );
    }
    if (phase.kind === "done" || phase.kind === "launched") {
      // 键已消失：原位留一个不占高的锚，结果浮在它正下方 4
      return (
        <span className="tray__keys-anchor">
          <FloatingToast align="start">
            <Toast
              kind="success"
              verb={phase.kind === "done" ? "已生效" : "已启动"}
              onDismiss={dismissDone}
            />
          </FloatingToast>
        </span>
      );
    }
    const blocked = busy ? "正在处理上一步" : undefined;
    const key = (label: string, tip: string, onClick: () => void) => (
      <Tooltip content={tip} placement="bottom">
        {blocked ? (
          <Button size="compact" disabled disabledReason={blocked}>
            {label}
          </Button>
        ) : (
          <Button size="compact" onClick={onClick}>
            {label}
          </Button>
        )}
      </Tooltip>
    );
    if (row.showRestart)
      return key("重启生效", RESTART_TIP, () => {
        setNotice(null);
        setPhase({ kind: "confirming" });
      });
    if (row.showLaunch) return key(`启动 ${CODEX.name}`, LAUNCH_TIP, () => void launchCodex());
    if (row.showUninstall)
      return (
        <BusySlot busy={uninstalling} label="正在卸下后台服务">
          <Tooltip content={UNINSTALL_TIP} placement="bottom">
            {busy && !uninstalling ? (
              <Button size="compact" disabled disabledReason="正在处理上一步">
                卸下后台服务
              </Button>
            ) : (
              <Button size="compact" onClick={uninstalling ? undefined : () => void uninstall()}>
                卸下后台服务
              </Button>
            )}
          </Tooltip>
        </BusySlot>
      );
    return null;
  };

  /// `第三方模型` 一行：名字 + 右端开关（指示点在左）→ 在用的模型 → 键位 → 确认 / 灰面板
  const thirdPartyModels = (title: string, current: GatewayState) => {
    const row = trayRow(current);
    const switching = phase.kind === "switching" ? phase.next : null;
    const models = trayModels(current);
    // 灰面板跟着它那颗键：键消失（问题解决了）就一起走
    const noticeLive =
      notice !== null &&
      phase.kind === "idle" &&
      (notice.for === "switch" ||
        (notice.for === "restart" && row.showRestart) ||
        (notice.for === "launch" && row.showLaunch));
    const slot = noticeLive ? null : keySlot(current);
    const anchorOnly = phase.kind === "done" || phase.kind === "launched";
    return (
      <>
        <div className="tray__cap">
          <span className="tray__cap-title">{title}</span>
          {/* 开关不乐观翻转：等确认、等生效，成了才落到新状态，原位下方浮起一窗 */}
          <span className="tray__switch">
            {row.toggle.disabledReason !== null && switching === null ? (
              // 禁用的开关自带原因提示框：悬停出、按下当即出（同 Codex 页）
              <Switch
                checked={false}
                onChange={() => undefined}
                label={`启用 ${CODEX.name} 的${title}`}
                disabledReason={row.toggle.disabledReason}
                tipPlacement="bottom"
              />
            ) : (
              <BusySlot
                busy={switching !== null}
                label={gatewaySwitchText(switching ?? true, true).busy}
              >
                <Tooltip
                  content={
                    row.toggle.on
                      ? `关掉：${CODEX.name} 只剩官方模型`
                      : `打开：选好的模型进 ${CODEX.name} 的模型列表`
                  }
                  placement="bottom"
                >
                  <Switch
                    checked={row.toggle.on}
                    onChange={toggle}
                    label={`启用 ${CODEX.name} 的${title}`}
                    disabledReason={busy && switching === null ? "正在处理上一步" : undefined}
                  />
                </Tooltip>
              </BusySlot>
            )}
            {phase.kind === "switched" ? (
              <FloatingToast align="end">
                <Toast kind="success" verb={phase.text} onDismiss={dismissDone} />
              </FloatingToast>
            ) : null}
          </span>
        </div>
        {models.length > 0 ? <ModelsLine models={models} /> : null}
        {slot !== null ? (
          <div className={`tray__keys${anchorOnly ? " tray__keys--anchor" : ""}`}>{slot}</div>
        ) : null}
        {phase.kind === "confirming"
          ? confirmPanel(
              `重启 ${CODEX.name}？`,
              RESTART_CONSEQUENCE,
              "重启",
              () => void restartCodex(),
            )
          : null}
        {phase.kind === "confirmSwitch"
          ? (() => {
              const text = gatewayConfirmText(current, phase.next);
              const next = phase.next;
              return confirmPanel(
                text.title,
                text.body,
                text.confirmLabel,
                () => void runSwitch(next, true),
              );
            })()
          : null}
        {noticeLive && notice ? (
          // 带下一步的失败：键位原位灰面板，不会自己走（DESIGN「反馈的两种形态」）
          <div className="tray__notice">
            <NoticePanel
              message={notice.message}
              reason={notice.reason}
              action={{ label: "再试一次", onClick: notice.retry }}
              onClose={() => setNotice(null)}
            />
          </div>
        ) : null}
      </>
    );
  };

  /// 能力行的画法（按注册表的节 id）；state 没读回来时 blocks 为空，走不到这里
  const capability = (id: string, title: string) =>
    id === "third-party-models" && state ? thirdPartyModels(title, state) : null;

  return (
    <div className={`tray${blocks.length === 0 ? " tray--bare" : ""}`} ref={rootRef} tabIndex={-1}>
      {blocks.map((block) => (
        <section key={block.id} className="tray__agent" aria-label={block.name}>
          <div className="tray__head">
            <AgentIcon id={block.id} name={block.name} size={16} />
            <span className="tray__name">{block.name}</span>
          </div>
          {block.rows.map((row) => (
            <Fragment key={row.id}>{capability(row.id, row.title)}</Fragment>
          ))}
        </section>
      ))}
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

/// 在用的模型一行：名字之间 `、`，同名的后面 ` · 网关短名`；一行放不下末尾写 `+N`。
/// 先在一层看不见的量尺里量出每个名字、`、`、`+9` / `+99` 的宽，再按行宽算放得下几个（fitModelCount）
function ModelsLine({ models }: { models: TrayModel[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState(models.length);
  const signature = models.map((m) => `${m.key}\t${m.name}\t${m.gateway ?? ""}`).join("\n");

  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      const ruler = rulerRef.current;
      if (!box || !ruler) return;
      const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : 0);
      const items = [...ruler.querySelectorAll("[data-item]")].map(width);
      const sep = width(ruler.querySelector("[data-sep]"));
      const one = width(ruler.querySelector("[data-more='1']"));
      const two = width(ruler.querySelector("[data-more='2']"));
      setCount(fitModelCount(items, sep, (n) => (n < 10 ? one : two), box.clientWidth));
    };
    measure();
    // 字体晚到会改宽度：到了再量一次
    let alive = true;
    void document.fonts?.ready.then(() => alive && measure());
    return () => {
      alive = false;
    };
  }, [signature]);

  const name = (m: TrayModel) => (
    <>
      {m.name}
      {m.gateway ? <span className="tray__models-gw"> · {m.gateway}</span> : null}
    </>
  );
  const shown = models.slice(0, count);
  const rest = models.length - shown.length;
  return (
    <div className="tray__models">
      <div className="tray__models-box" ref={boxRef}>
        <span className="tray__models-text">
          {shown.map((m, i) => (
            <Fragment key={m.key}>
              {i > 0 ? MODEL_SEPARATOR : null}
              {name(m)}
            </Fragment>
          ))}
        </span>
        {rest > 0 ? <span className="tray__models-more">+{rest}</span> : null}
        <span className="tray__models-ruler" ref={rulerRef} aria-hidden="true">
          {models.map((m) => (
            <span key={m.key} data-item="">
              {name(m)}
            </span>
          ))}
          <span data-sep="">{MODEL_SEPARATOR}</span>
          <span className="tray__models-more" data-more="1">
            +9
          </span>
          <span className="tray__models-more" data-more="2">
            +99
          </span>
        </span>
      </div>
    </div>
  );
}

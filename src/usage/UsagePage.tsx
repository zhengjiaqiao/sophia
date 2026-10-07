import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import trayIcon from "../../src-tauri/icons/tray.png";
import { api } from "../api.ts";
import { t, tn, useOnLocaleChange } from "../i18n.ts";
import type {
  MenuBarView,
  StackedSize,
  UsageDisplayMode,
  UsageAgentId,
  UsageRefresh,
  UsageSettings,
  UsageView,
} from "../types.ts";
import {
  AgentIcon,
  Chip,
  ChipRow,
  PageHead,
  PageTitle,
  Section,
  SectionLabel,
  Switch,
  Tabs,
} from "../ui/index.ts";
import {
  MAX_MENU_BAR_AGENTS,
  agentChoices,
  agentDisplay,
  choosePrimary,
  menuBarAgents,
  primaryOptions,
  secondaryOptions,
  setAgentDisplay,
  toggleMenuBarAgent,
  usageAgentName,
  windowCount,
} from "./usageView.ts";
import {
  ConnectConfirm,
  UsageWindows,
  useClaudeConnect,
  useUsageRetry,
  type ConnectHandlers,
} from "./UsageWindows.tsx";
import "./UsagePage.css";

/// 用量页（侧栏「用量」⌘4；spec 2026-09-26-menubar-usage R11，线框 5A）：最上面是「当前用量」（与托盘同一种画法），
/// 下面配置菜单栏上显示什么。
/// 靠标题与留白分组、不用卡片：组间 48，组内行距 12，行与行之间不画线，行首标签列统一 92 对齐。
/// - 「菜单栏显示用量」一节：节头带总开关（同模型页的能力节），节里预览、数字（剩余 ｜ 已用）、刷新。
/// - 「显示哪些 agent」：选择片带 agent 标志；最多 3 个，选满后其余的点不了并说原因。
/// - 每个选中的 agent 一栏、左右并排：主窗口、第二窗口（紧凑滑槽，选项按它实际拿到的窗口生成，窗口名原样）；
///   选了第二窗口才有「两行叠放」，打开叠放才有「字号」。
/// 总开关关着时，节里的预览、数字、刷新调淡、点不了，节头下写一句「菜单栏没显示用量」（线框 5A 的注）。
/// 改了就存（`usage_set_settings`），调度与菜单栏立即生效；预览是后端按同一份格式化算好的「打开后的样子」

const modeItems = (): ReadonlyArray<{ id: UsageDisplayMode; label: string }> => [
  { id: "remaining", label: t("usage.mode.remaining") },
  { id: "used", label: t("usage.mode.used") },
];

const refreshItems = (): ReadonlyArray<{ id: UsageRefresh; label: string }> => [
  { id: "auto", label: t("usage.refresh.auto") },
  { id: "off", label: t("usage.refresh.off") },
  { id: "5", label: tn("usage.refresh.minutes", 5) },
  { id: "10", label: tn("usage.refresh.minutes", 10) },
  { id: "15", label: tn("usage.refresh.minutes", 15) },
];

const sizeItems = (): ReadonlyArray<{ id: StackedSize; label: string }> => [
  { id: "small", label: t("usage.size.small") },
  { id: "medium", label: t("usage.size.medium") },
  { id: "large", label: t("usage.size.large") },
];

/// 刷新行下的说明（线框 5A 原文，R6）
export const refreshHint = () => t("usage.refresh.hint");

/// 面板开着时倒计时与「N 分钟前更新」按分钟走：到点重读一次
const TICK_MS = 60_000;

export function UsagePage({ onError }: { onError: (message: string) => void }) {
  const [view, setView] = useState<UsageView | null>(null);
  const alive = useRef(true);

  const read = useCallback(
    async (opened: boolean) => {
      try {
        const next = await api.usageView(opened);
        if (alive.current) setView(next);
      } catch (error) {
        if (alive.current) onError(String(error));
      }
    },
    [onError],
  );

  // 换了界面语言：视图里的文字是后端按语言算好的，重读（不补取）
  useOnLocaleChange(() => void read(false));

  // 「当前用量」原因行的「再试一次」：跑完先重读（不补取）把新数画上，再收回「正在读取」
  const reread = useCallback(() => read(false), [read]);
  const { retry, retrying } = useUsageRetry(reread);
  // 「当前用量」Claude 一栏的「连接 Claude 用量」（票 #208）：要安装时先问一句（主窗口的确认一律居中）
  const connect = useClaudeConnect(reread, onError);

  useEffect(() => {
    alive.current = true;
    // 打开这一页：顺带补取一次（R6），新数经 usage-changed 到
    void read(true);
    const pending = listen("usage-changed", () => void read(false));
    const timer = window.setInterval(() => void read(false), TICK_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      void pending.then((un) => un());
    };
  }, [read]);

  /// 改了就存：先画上去，存完重读一次（预览、托盘的文字按新设置重算）
  const save = async (next: UsageSettings) => {
    setView((v) => (v ? { ...v, settings: next } : v));
    try {
      await api.usageSetSettings(next);
    } catch (error) {
      onError(String(error));
    }
    await read(false);
  };

  return (
    <div className="usage-page">
      <PageHead lead={<PageTitle>{t("usage.page.title")}</PageTitle>}>
        {view ? (
          <UsageBody
            view={view}
            onChange={(next) => void save(next)}
            onRetry={(agent) => void retry(agent)}
            retrying={retrying}
            connect={connect.handlers}
          />
        ) : null}
      </PageHead>
      {connect.confirming ? (
        <ConnectConfirm onConfirm={connect.confirm} onCancel={connect.dismiss} />
      ) : null}
    </div>
  );
}

/// 一行：92 宽的标签 + 控件；下面可带一行说明（12 ink-faint）
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="usage-page__row">
      <span className="usage-page__label">{label}</span>
      <div className="usage-page__control">
        {children}
        {hint ? <p className="usage-page__hint">{hint}</p> : null}
      </div>
    </div>
  );
}

/// 页的内容（取数与保存之外的全部，测试直接渲染它）。结构照线框 5A：
/// 「菜单栏显示用量」一节（节头 + 开关；节里预览、数字、刷新）→ 显示哪些 agent → 各 agent 左右并排两栏
export function UsageBody({
  view,
  onChange,
  onRetry,
  retrying = () => false,
  connect,
}: {
  view: UsageView;
  onChange: (next: UsageSettings) => void;
  /// 「当前用量」原因行右端的「再试一次」；不给就只写原因
  onRetry?: (agent: UsageAgentId) => void;
  /// 这个 agent 的「再试一次」正在跑
  retrying?: (agent: UsageAgentId) => boolean;
  /// Claude 一栏的「连接 Claude 用量」；不给就只写句子
  connect?: ConnectHandlers;
}) {
  const s = view.settings;
  const off = !s.menuBarEnabled;
  const choices = agentChoices(view);

  return (
    <>
      {/* 当前用量（产品负责人 2026-09-29：只有设置显得怪）：与托盘同一种画法，每个已登录的 agent 一栏 */}
      <div className="usage-page__now">
        <SectionLabel rule>{t("usage.now.title")}</SectionLabel>
        {view.tray.length === 0 ? (
          <p className="usage-page__hint">{t("usage.signedIn.none")}</p>
        ) : (
          <div className="usage-page__cols">
            {view.tray.map((tray) => {
              const name = usageAgentName(tray.agent);
              return (
                <div
                  key={tray.agent}
                  className="usage-page__now-col"
                  aria-label={t("usage.now.colLabel", { name })}
                >
                  <div className="usage-page__now-head">
                    <span className="usage-page__agent-name">
                      <AgentIcon id={tray.agent} name={name} size={16} />
                      {name}
                    </span>
                    {tray.updatedText ? (
                      <span className="usage-page__updated">{tray.updatedText}</span>
                    ) : null}
                  </div>
                  <UsageWindows
                    usage={tray}
                    retrying={retrying(tray.agent)}
                    onRetry={onRetry ? () => onRetry(tray.agent) : undefined}
                    connect={connect}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="usage-page__head">
        <Section
          title={t("usage.menubar.title")}
          control={
            <Switch
              checked={s.menuBarEnabled}
              label={t("usage.menubar.title")}
              onChange={(on) => onChange({ ...s, menuBarEnabled: on })}
            />
          }
        >
          {off ? <p className="usage-page__off">{t("usage.menubar.off")}</p> : null}
          {/* 节里的东西只为菜单栏：关着时整体调淡、点不了（原因就是上面那一句） */}
          <div className={`usage-page__menubar${off ? " is-off" : ""}`} inert={off}>
            <div className="usage-page__preview">
              <MenuBarPreview menuBar={view.menuBar} />
              <span className="usage-page__hint">{t("usage.menubar.previewNote")}</span>
            </div>
            <Row label={t("usage.number.label")} hint={t("usage.number.hint")}>
              <Tabs
                compact
                plain
                label={t("usage.number.label")}
                items={modeItems()}
                value={s.displayMode}
                onChange={(displayMode) => onChange({ ...s, displayMode })}
              />
            </Row>
            <Row label={t("usage.refresh.label")} hint={refreshHint()}>
              <Tabs
                compact
                plain
                label={t("usage.refresh.label")}
                items={refreshItems()}
                value={s.refresh}
                onChange={(refresh) => onChange({ ...s, refresh })}
              />
            </Row>
          </div>
        </Section>
      </div>

      <div className="usage-page__group">
        <SectionLabel rule>{t("usage.agents.title")}</SectionLabel>
        {choices.length === 0 ? (
          <p className="usage-page__hint">{t("usage.signedIn.none")}</p>
        ) : (
          <>
            <ChipRow listLabel={t("usage.agents.title")}>
              {choices.map((c) => {
                const label = (
                  <span className="usage-page__agent">
                    <AgentIcon id={c.id} name={c.name} size={14} />
                    {c.name}
                  </span>
                );
                return c.disabledReason ? (
                  <Chip key={c.id} disabled disabledReason={c.disabledReason}>
                    {label}
                  </Chip>
                ) : (
                  <Chip
                    key={c.id}
                    selected={c.selected}
                    onClick={() => onChange(toggleMenuBarAgent(s, view.signedIn, c.id))}
                  >
                    {label}
                  </Chip>
                );
              })}
            </ChipRow>
            <p className="usage-page__hint">{tn("usage.agents.max", MAX_MENU_BAR_AGENTS)}</p>
          </>
        )}
      </div>

      {/* 每个选中的 agent 一栏，左右并排各占一半（776 里各 376） */}
      <div className="usage-page__agents">
        {menuBarAgents(view).map((id) => {
          const d = agentDisplay(s, id);
          const name = usageAgentName(id);
          const set = (patch: Parameters<typeof setAgentDisplay>[2]) =>
            onChange(setAgentDisplay(s, id, patch));
          return (
            <div key={id} className="usage-page__agent-col" aria-label={name}>
              <SectionLabel rule>
                <span className="usage-page__agent">
                  <AgentIcon id={id} name={name} size={14} />
                  {name}
                </span>
              </SectionLabel>
              <Row label={t("usage.display.primary")}>
                <Tabs
                  compact
                  plain
                  label={t("usage.display.primaryLabel", { name })}
                  items={primaryOptions(view, id)}
                  value={d.primary ?? "auto"}
                  onChange={(v) => onChange(choosePrimary(s, id, v === "auto" ? null : v))}
                />
              </Row>
              {/* 只有一个窗口时没有「第二窗口」可选，这一行不出（以前选过的照旧列着，好改回「无」） */}
              {windowCount(view, id) > 1 || d.secondary !== null ? (
                <Row label={t("usage.display.secondary")}>
                  <Tabs
                    compact
                    plain
                    label={t("usage.display.secondaryLabel", { name })}
                    items={secondaryOptions(view, id)}
                    value={d.secondary ?? "none"}
                    onChange={(v) => set({ secondary: v === "none" ? null : v })}
                  />
                </Row>
              ) : null}
              {/* 选了第二窗口才有叠放，打开叠放才有字号 */}
              {d.secondary !== null ? (
                <Row label={t("usage.display.stacked")} hint={t("usage.display.stackedHint")}>
                  <Switch
                    checked={d.stacked}
                    label={t("usage.display.stackedLabel", { name })}
                    onChange={(stacked) => set({ stacked })}
                  />
                </Row>
              ) : null}
              {d.secondary !== null && d.stacked ? (
                <Row label={t("usage.display.size")}>
                  <Tabs
                    compact
                    plain
                    label={t("usage.display.sizeLabel", { name })}
                    items={sizeItems()}
                    value={d.stackedSize}
                    onChange={(stackedSize) => set({ stackedSize })}
                  />
                </Row>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

/// 菜单栏的样子（与真实菜单栏同一份文字，后端算好）：Sophia 图标 + 每个 agent 的标志与数字，
/// 两行叠放时上下两行；读数过期的那段变淡
export function MenuBarPreview({ menuBar }: { menuBar: MenuBarView }) {
  return (
    <span className="usage-preview">
      <img className="usage-preview__icon" src={trayIcon} alt="" />
      {menuBar.segments.map((seg) => (
        <span key={seg.agent} className={`usage-preview__seg${seg.stale ? " is-stale" : ""}`}>
          <AgentIcon id={seg.agent} name={usageAgentName(seg.agent)} size={12} />
          <span
            className={`usage-preview__nums${seg.lines.length > 1 ? ` is-stacked is-${seg.stackedSize}` : ""}`}
          >
            {seg.lines.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

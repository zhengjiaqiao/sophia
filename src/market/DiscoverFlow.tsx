/// `发现` 一面的接线（spec 2026-09-27-skill-mcp-market R4–R11；DESIGN「发现与安装」）：页面头（`DiscoverFrame`）、
/// 列表与介绍页（`DiscoverPane`）、安装类推入页、装完右下那一窗，SKILLS 与 MCP 共用这一份。
///
/// - 列表行尾的 `安装`：安装页（skill）/ 安装 MCP 页直接盖在列表上
/// - 介绍页的 `安装`：安装页叠在介绍页上（两层推入，同来源管理页上再推入添加来源页）——
///   `←` / Esc / ⌘[ 只归上面那一层，回到介绍页；装完两层一起滑回列表
/// - 页面头的 `粘贴链接` / `粘贴 JSON`：推入从链接安装 / 从 JSON 添加
/// - 装上了：右下 `✓ 已安装 pdf` + `撤销`（`InstalledToast`）；`我的` 重扫、列表重取（`✓ 已安装` 跟着变）。
///   撤销与 ⌘Z 是同一件事：交给页面的撤销栈（`onUndoable`），撤了那一窗直接消失，不另出「已撤销」
/// - 有 agent 没链上：那一窗 `撤销` 前多一颗 `去处理`（issue #111），交给页面带到 `我的` 里那一行（`onHandle`）
import { useCallback, useEffect, useRef, useState } from "react";
import { DiscoverFrame } from "../LocationFrame.tsx";
import { t } from "../i18n.ts";
import type { Location } from "../shell/nav.ts";
import { useMenuFlag, usePageCommand } from "../shell/menuBus.ts";
import type { McpRow, McpUndoReport, SkillRow, SyncReport } from "../types.ts";
import { CornerToast, Toast } from "../ui/index.ts";
import { DiscoverPane, type InstallFrom } from "./DiscoverPane.tsx";
import { InstallPage, type SkillTarget } from "./InstallPage.tsx";
import type { InstallPlaces } from "./InstallParts.tsx";
import { InstalledToast, type InstalledNotice } from "./InstalledToast.tsx";
import type { AgentRef, SkillHandle } from "./installView.ts";
import { JsonPage } from "./JsonPage.tsx";
import { LinkPage } from "./LinkPage.tsx";
import { McpInstallPage } from "./McpInstallPage.tsx";
import { errorText, marketService, type MarketService } from "./service.ts";

/// 安装类推入页要的、来自壳的那几样
export interface InstallContext {
  /// 当前 `我的` 的位置：默认装到这里，`全部` 时装到用户级
  mine: Location;
  places: InstallPlaces;
  /// 已安装的 agent（agent 表的先后；装了 Claude Desktop 时带上它，MCP 用）
  agents: ReadonlyArray<AgentRef>;
  /// 设置里 `列表里的 agent`
  shown: ReadonlyArray<string>;
}

/// 此刻推入的是哪一页
type Layer =
  | { kind: "skill"; item: SkillRow; from: InstallFrom }
  | { kind: "mcp"; item: McpRow; from: InstallFrom }
  | { kind: "paste" };

/// 叠在介绍页上时，安装页盖住的是介绍页（它也挂在机面上，不在 `.face__scroll` 里）：
/// 介绍页正文 `.intro` 所在的那一页（推入页是一个 region）
const INTRO_LAYER = () => document.querySelector(".intro")?.closest('[role="region"]') ?? null;

/// 发现列表里的一行 → 安装页要装的那个 skill（分支不知道，交给后端取默认分支）
export function skillTargetOf(row: SkillRow): SkillTarget {
  return {
    name: row.name,
    repo: row.repo,
    path: row.path,
    skillId: row.skillId,
    branch: null,
    description: null,
  };
}

export interface DiscoverFlowProps {
  domain: "skills" | "mcp";
  context: InstallContext;
  /// 装上 / 撤销之后，`我的` 重扫
  onChanged: () => void | Promise<void>;
  /// 最近一次可撤销的安装（⌘Z 与纸窗的 `撤销` 是同一件事）；撤过了交 null
  onUndoable?: (undo: (() => void) | null) => void;
  /// 已切回 `我的`（这一面卸下了）之后 ⌘Z 撤不成：交给壳的错误横幅
  onError?: (message: string) => void;
  /// 装完那一窗的 `去处理`：带到 `我的` 里那一行（SKILLS 给；不给就没有这颗键）
  onHandle?: (target: SkillHandle) => void;
  service?: MarketService;
}

export function DiscoverFlow({
  domain,
  context,
  onChanged,
  onUndoable,
  onError,
  onHandle,
  service = marketService,
}: DiscoverFlowProps) {
  const [layer, setLayer] = useState<Layer | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [introLeave, setIntroLeave] = useState(0);
  const [notice, setNotice] = useState<(InstalledNotice & { at: number }) | null>(null);
  const [undoFailed, setUndoFailed] = useState<{ reason: string; at: number } | null>(null);

  const live = useRef({ onChanged, onUndoable, onError });
  live.current = { onChanged, onUndoable, onError };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /// 装上、撤销之后：列表重取（`✓ 已安装`），`我的` 重扫
  const changed = useCallback(() => {
    setReloadKey((k) => k + 1);
    void live.current.onChanged();
  }, []);

  /// 撤过了（纸窗的 `撤销` 或 ⌘Z）：那一窗消失；撤不成的在右下说一句
  const undone = useCallback(
    (result: { report: SyncReport | McpUndoReport | null; error: string | null }) => {
      const report = result.report as McpUndoReport | null;
      const reason =
        result.error ??
        (report && "outcome" in report && report.outcome !== "undone" ? report.message : null);
      if (reason !== null) {
        if (mounted.current) setUndoFailed({ reason, at: Date.now() });
        else live.current.onError?.(t("market.undo.failed", { reason }));
      }
      changed();
    },
    [changed],
  );

  /// ⌘Z 撤最近这一次安装：与纸窗的 `撤销` 同一条路
  const undoRef = useRef<(() => void) | null>(null);
  const offerUndo = (next: InstalledNotice) => {
    const undoId = next.undoId;
    if (!undoId) {
      undoRef.current = null;
      live.current.onUndoable?.(null);
      return;
    }
    const run = () => {
      if (undoRef.current !== run) return;
      undoRef.current = null;
      live.current.onUndoable?.(null);
      setNotice((n) => (n?.undoId === undoId ? null : n));
      void (next.kind === "skill" ? service.undoSkill(undoId) : service.undoMcp(undoId)).then(
        (report) => undone({ report, error: null }),
        (error: unknown) => undone({ report: null, error: errorText(error) }),
      );
    };
    undoRef.current = run;
    live.current.onUndoable?.(run);
  };

  const done = (next: InstalledNotice, from: InstallFrom) => {
    setNotice({ ...next, at: Date.now() });
    setUndoFailed(null);
    offerUndo(next);
    // 从介绍页进来的：安装页滑回的同时介绍页也滑回，两层一起回到列表
    if (from === "intro") setIntroLeave((n) => n + 1);
    changed();
  };

  const close = useCallback(() => setLayer(null), []);
  const base = {
    mine: context.mine,
    places: context.places,
    agents: context.agents,
    shown: context.shown,
    onClose: close,
    service,
  };
  const over = layer !== null && layer.kind !== "paste" && layer.from === "intro";
  const covers = over ? INTRO_LAYER : undefined;

  let page = null;
  if (layer?.kind === "skill") {
    const from = layer.from;
    page = (
      <InstallPage
        {...base}
        skill={skillTargetOf(layer.item)}
        covers={covers}
        onDone={(_outcome, n) => done(n, from)}
      />
    );
  } else if (layer?.kind === "mcp") {
    const from = layer.from;
    page = (
      <McpInstallPage
        {...base}
        entry={layer.item}
        covers={covers}
        onDone={(_report, n) => done(n, from)}
      />
    );
  } else if (layer?.kind === "paste") {
    page =
      domain === "skills" ? (
        <LinkPage {...base} onDone={(_outcome, n) => done(n, "list")} />
      ) : (
        <JsonPage {...base} onDone={(_report, n) => done(n, "list")} />
      );
  }

  // 纸窗里的 `撤销` 撤完了：⌘Z 不再指着它
  const undoneByToast = (result: {
    report: SyncReport | McpUndoReport | null;
    error: string | null;
  }) => {
    undoRef.current = null;
    live.current.onUndoable?.(null);
    undone(result);
  };
  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismissFailed = useCallback(() => setUndoFailed(null), []);

  return (
    <>
      <DiscoverFrame domain={domain} onPaste={() => setLayer({ kind: "paste" })}>
        {(query) =>
          domain === "skills" ? (
            <DiscoverPane
              domain="skills"
              query={query}
              reloadKey={reloadKey}
              covered={over}
              introLeave={introLeave}
              onInstall={(item, from) => setLayer({ kind: "skill", item, from })}
            />
          ) : (
            <DiscoverPane
              domain="mcp"
              query={query}
              reloadKey={reloadKey}
              covered={over}
              introLeave={introLeave}
              onInstall={(item, from) => setLayer({ kind: "mcp", item, from })}
            />
          )
        }
      </DiscoverFrame>
      {page}
      {notice ? (
        <InstalledToast
          key={notice.at}
          notice={notice}
          service={service}
          onDismiss={dismissNotice}
          onUndone={undoneByToast}
          onHandle={onHandle}
        />
      ) : null}
      {undoFailed ? (
        <CornerToast>
          <Toast
            key={undoFailed.at}
            kind="cannot"
            sentence="market.toast.undoCannot"
            reason={undoFailed.reason}
            onDismiss={dismissFailed}
            onClose={dismissFailed}
          />
        </CornerToast>
      ) : null}
    </>
  );
}

/// 页面的撤销栈接到菜单「撤销」（⌘Z）：`我的` 由表格（Matrix）接；`发现` 一面没有表格，由这里接
export function PageUndo({ run, can }: { run: () => void; can: boolean }) {
  usePageCommand("undo", run);
  useMenuFlag("undo", can);
  return null;
}

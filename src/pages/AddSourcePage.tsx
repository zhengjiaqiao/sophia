import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconArrowLeft, IconButton, Toast } from "../ui";
import { holdInert } from "../ui/SubPage.tsx";
import { PageHead, PageTitle } from "../shell/PageHead.tsx";
import { useMenuFlag, usePageCommand } from "../shell/menuBus.ts";
import { AddSourcePanel } from "./AddSourcePanel.tsx";
import type { CandidateEntry } from "./addSourceView.ts";
import type { DomainRef } from "./sourcesView.ts";
import type { SourcesModel } from "./sourcesModel.ts";
import "./AddSourcePage.css";

/// 添加来源的**容器**（DESIGN「来源：订阅、来源行、添加来源 › 添加来源」）：**只替换机面**——侧栏留着、
/// 当前位置仍选中（⑨）；在机面里从右推入、返回滑回（200ms，reduced-motion 即时）。
/// 页面头：`←`（图标键 28，等于 Esc 与菜单「返回」⌘[）+ 10 + `添加来源到 CardBox`（title 20 / 700）。
/// 内容整个是 `AddSourcePanel`——换容器只换这一层，Panel 不动。
///
/// - 挂在机面（`.face`）上盖住位置页，位置页在它下面 `inert`（读屏、Tab 都进不去），不卸载——
///   滑回之后筛选、滚动、勾选都还在
/// - 勾的全加上后等调用方重扫完，自动滑回，开始滑回时交给调用方 `onAllAdded`：位置页筛到新来源并在
///   那几片下浮起 `✓ 已添加 …`（`AddedToast`）。有没加上的就留在这一页，由 Panel 说明

/// 转场时长，与 AddSourcePage.css 同值
const MOTION_MS = 200;

export interface AddSourcePageProps {
  model: SourcesModel;
  domain: DomainRef;
  /// 滑回播完：调用方卸掉这一页
  onClose: () => void;
  /// 加上了至少一个之后（滑回之前）：位置页重扫
  onAdded: () => Promise<void>;
  /// 勾的全加上了、重扫已完、开始滑回时：加上的那几个（按列表先后）
  onAllAdded?: (added: CandidateEntry[]) => void;
}

export function AddSourcePage({ model, domain, onClose, onAdded, onAllAdded }: AddSourcePageProps) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // 挂到机面上（盖住位置页，侧栏不动）；没有机面（测试、预览）时就地画
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHost(document.querySelector<HTMLElement>(".face")), []);

  // 位置页在这一页下面：读屏与 Tab 都进不去；滑回卸掉时放开。
  // 焦点：打开时落到这一页上，返回时还给进来之前拿着焦点的那颗键
  useEffect(() => {
    const under = document.querySelector<HTMLElement>(".face__scroll");
    const release = under ? holdInert(under) : undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pageRef.current?.focus({ preventScroll: true });
    return () => {
      release?.();
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [host]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    timer.current = setTimeout(onClose, reduced ? 0 : MOTION_MS);
  };
  const live = useRef(leave);
  live.current = leave;

  // 返回：`←`、Esc、菜单「返回」（⌘[）是同一条路；菜单「返回」只在这一页开着时亮
  usePageCommand("back", () => live.current());
  useMenuFlag("back", !leaving);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 浮层、确认框在捕获阶段先接走自己的 Esc；输入框里的 Esc 归输入框
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      live.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const page = (
    <div
      ref={pageRef}
      className={`add-src-page${leaving ? " is-leaving" : ""}`}
      role="region"
      aria-label={model.addTitle}
      // 只供程序放焦点的落点（打开时焦点落在这一页上）
      tabIndex={-1}
    >
      <PageHead
        lead={
          <span className="add-src-page__lead">
            <IconButton icon={<IconArrowLeft />} title="返回" onClick={leave} />
            <PageTitle>{model.addTitle}</PageTitle>
          </span>
        }
      >
        <div className="add-src-page__body">
          <AddSourcePanel
            model={model}
            domain={domain}
            onChanged={onAdded}
            onDone={async (added) => {
              onAllAdded?.(added);
              leave();
              // 滑回的这 200ms 里 Panel 保持「正在添加」，不闪回可点的主动作
              await new Promise((resolve) => setTimeout(resolve, MOTION_MS));
            }}
          />
        </div>
      </PageHead>
    </div>
  );
  return host ? createPortal(page, host) : page;
}

/// 加完来源滑回位置页时新来源那几片正下方浮起的一窗：`✓ 已添加 WeiboAP · 已筛选出它的 39 个 skill`
/// （段由 `addedParts` 给，说清楚列表为什么变少了），约 4 秒淡出，不带撤销（移除在来源行上）；
/// 提示走了，选中的筛选片照旧说明列表是筛过的。skill 与 MCP 共用
export function AddedToast({ parts, onDismiss }: { parts: string[]; onDismiss: () => void }) {
  return (
    <Toast
      tier="routine"
      kind="success"
      verb="已添加"
      reading={parts.flatMap((part, i) => [
        ...(i > 0
          ? [
              <span key={`sep${i}`} className="ss-toast__sep">
                ·
              </span>,
            ]
          : []),
        <span key={i}>{part}</span>,
      ])}
      onDismiss={onDismiss}
    />
  );
}

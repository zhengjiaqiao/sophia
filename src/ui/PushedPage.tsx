import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageHead, PageTitle } from "../shell/PageHead.tsx";
import { IconButton } from "./Button.tsx";
import { IconArrowLeft } from "./icons.tsx";
import { motionMs } from "./motion.ts";

/// 推入页（DESIGN「页面还是弹层」：有起止的多步任务**在机面里推入一页**；「壳」：侧栏留着、当前位置仍选中）。
/// 来源管理页、添加来源页用它。
///
/// - **只替换机面**：挂到机面上（`host`）盖住下面那一页，侧栏不动；下面那一页 `inert`（`covers`，读屏与 Tab 都
///   进不去）、不卸载——返回时筛选、滚动、抽屉、勾选都还在
/// - 从右推入、返回滑回，`--dur-push`（200ms）机械缓动；减少动效时即时
/// - 页面头＝壳的 `PageHead`：`←`（图标键 28）+ 10 + 页面名（`title` 20 / 700，原样），右端页面动作（`+ 来源`）
/// - 可选贴底一行（`footer`）：高 60、上 1px `hairline`、`face` 底、横贯机面，主动作右对齐到内容右沿 776；
///   内容区在它上面滚动（添加来源页的 `添加 N 个来源`）
/// - 焦点：打开时落到这一页上（只供程序放焦点的落点，不画框），返回时还给进来之前拿着焦点的那颗键（`管理来源`）
/// - 返回：`←`、Esc、菜单「返回」（⌘[）是同一条路。`←` 与 Esc 由这里接（浮层、确认框在捕获阶段先接走自己的 Esc，
///   输入框里的 Esc 归输入框；`escape={false}` 时这一页暂不接，比如移除确认开着）；菜单总线归页面：
///   页面用 `usePushedPage` 拿到 `leave`，自己接 `usePageCommand("back", leave)`
/// - 与抽屉的边界：能在一行里就地拉开完成的，用抽屉，不推入一页
///
/// 用法：
/// ```tsx
/// const page = usePushedPage(onClose);          // 滑回播完才叫 onClose（调用方卸掉这一页）
/// usePageCommand("back", page.leave);            // 菜单「返回」
/// <PushedPage {...page} title="CardBox 的来源" actions={<AddButton noun="来源" … />}
///   host={() => document.querySelector(".face")} covers={() => document.querySelector(".face__scroll")}>
///   …
/// </PushedPage>
/// ```

/// `inert` 能设在上面的最小接口（真 DOM 元素满足；测试用假对象）
export interface InertTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const holds = new WeakMap<InertTarget, number>();

/// 给背景加 inert，返回释放函数。同一个目标可以被几页同时持有（来源管理页上再推入添加来源页），最后一个释放才摘掉
export function holdInert(target: InertTarget): () => void {
  holds.set(target, (holds.get(target) ?? 0) + 1);
  target.setAttribute("inert", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(target) ?? 1) - 1;
    holds.set(target, left);
    if (left <= 0) target.removeAttribute("inert");
  };
}

export interface PushedPageState {
  /// 正在滑回（点了返回、还没播完）
  leaving: boolean;
  /// 返回：开始滑回，播完叫 `onClose`。重复叫只算一次
  leave: () => void;
}

/// 推入页的返回：滑回的状态与计时。滑回时长取 `--dur-push`（减少动效时是 0，立刻交回）
export function usePushedPage(onClose: () => void): PushedPageState {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(onClose);
  done.current = onClose;
  const left = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    setLeaving(true);
    timer.current = setTimeout(() => done.current(), motionMs("--dur-push"));
  }, []);
  return { leaving, leave };
}

export interface PushedPageProps extends PushedPageState {
  /// 页面名，原样（`CardBox 的来源` `添加来源到 CardBox`）
  title: ReactNode;
  /// 读屏名（这一页是一个 region）；`title` 是字符串时可以不给
  label?: string;
  /// 页面头右端的动作
  actions?: ReactNode;
  /// 挂到哪（机面）；不给或找不到就地画（测试、样张）
  host?: () => Element | null;
  /// 盖住的那一页（机面的滚动区）：打开期间 inert
  covers?: () => Element | null;
  /// 此刻 Esc 归不归这一页（移除确认开着时给 false）
  escape?: boolean;
  /// 页面头下的内容：铺满余下的高度，自己决定哪一块滚动
  children: ReactNode;
  /// 贴底一行（主动作，右对齐到内容右沿）；不给就没有
  footer?: ReactNode;
}

export function PushedPage({
  title,
  label,
  actions,
  leaving,
  leave,
  host: findHost,
  covers,
  escape = true,
  children,
  footer,
}: PushedPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<Element | null>(null);
  // 首帧就地画、挂上之后搬去机面（找不到机面就留在原地）
  const findHostRef = useRef(findHost);
  useLayoutEffect(() => setHost(findHostRef.current?.() ?? null), []);

  // 下面那一页 inert；焦点落到这一页上，返回时还给进来之前拿着焦点的那颗键
  const coversRef = useRef(covers);
  useEffect(() => {
    const under = coversRef.current?.();
    const release = under ? holdInert(under) : undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pageRef.current?.focus({ preventScroll: true });
    return () => {
      release?.();
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [host]);

  // Esc 等同返回：浮层、确认框在捕获阶段先接走自己的 Esc；输入框里的 Esc 归输入框
  const live = useRef({ leave, escape });
  live.current = { leave, escape };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !live.current.escape) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      live.current.leave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const page = (
    <div
      ref={pageRef}
      className={leaving ? "ss-pushed is-leaving" : "ss-pushed"}
      role="region"
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      // 只供程序放焦点的落点（打开时焦点落在这一页上）
      tabIndex={-1}
    >
      <PageHead
        lead={
          <span className="ss-pushed__lead">
            <IconButton icon={<IconArrowLeft />} title="返回" onClick={leave} />
            <PageTitle>{title}</PageTitle>
          </span>
        }
        actions={actions}
      >
        <div className="ss-pushed__body">{children}</div>
        {footer ? <div className="ss-pushed__foot">{footer}</div> : null}
      </PageHead>
    </div>
  );
  return host ? createPortal(page, host) : page;
}

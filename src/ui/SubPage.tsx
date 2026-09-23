import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button.tsx";
import { IconArrowLeft } from "./icons.tsx";

/// 二级页面（DESIGN「Layout › 壳」）：占满整窗，**不渲染侧栏**。
/// 头高 84 = 28（红绿灯那一排，只当拖动区）+ 56，底 hairline；56 里 `←` 图标按钮 28×28、
/// 间距 12、页面名 28/700 **不大写、字距 0**（`添加 skill 到「全局」` `Codex 的网关` 原样写）。
/// 返回即保存，没有「保存」按钮；Esc 等同返回。
///
/// **盖住主视图**：二级页挂到 `document.body` 上（portal），不留在主视图的 DOM 里——
/// 否则主视图里吸顶的工具行、列头（带正 z-index）会叠到二级页上面。打开期间主视图的根节点
/// `#root` 加 `inert`：读屏和 Tab 键都进不去（`holdInert`，多个二级页叠开时按引用计数）。
/// **叠开**（来源管理页里再进添加来源页）：下面那一页同样 inert，Esc 只归最上面那一页。

export interface SubPageProps {
  /// 页面名，原样写（专名不再需要 <Plain> 包：这一档本来就不大写）
  title: ReactNode;
  onBack: () => void;
  /// 头右侧的一句副标题，可选
  aside?: ReactNode;
  /// 额外的类名（网关页的推入 / 滑回转场挂在这里）
  className?: string;
  children: ReactNode;
}

/// **焦点**：打开时焦点移到页标题（tabIndex=-1）；返回时回到当初触发它的那颗按钮。
/// macOS WebKit 里点按钮并不会让按钮获得焦点，所以另记「最近一次被点的按钮」；
/// 主视图在二级页打开期间被卸载过（设置）时，按原来那颗键的读屏名 / 文字找回新挂上的同一颗。

/// 用来在主视图重挂之后认回「同一颗键」：读屏名优先，其次文字
export interface TriggerKey {
  label: string | null;
  text: string;
}

export interface TriggerLike {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

export function triggerKey(el: TriggerLike): TriggerKey {
  return { label: el.getAttribute("aria-label"), text: (el.textContent ?? "").trim() };
}

/// 在一组候选按钮里找回那颗键：读屏名相同优先，否则文字相同；都没有返回 -1
export function pickTrigger(candidates: TriggerLike[], key: TriggerKey): number {
  if (key.label) {
    const i = candidates.findIndex((c) => c.getAttribute("aria-label") === key.label);
    if (i >= 0) return i;
  }
  if (key.text === "") return -1;
  return candidates.findIndex((c) => (c.textContent ?? "").trim() === key.text);
}

/// 最近一次被点的按钮（捕获阶段记，不拦截）
let lastClicked: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target instanceof Element) {
        lastClicked = target.closest<HTMLElement>("button, [role='button'], a[href]");
      }
    },
    true,
  );
}

/// `inert` 能设在上面的最小接口（真 DOM 元素满足；测试用假对象）
export interface InertTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const holds = new WeakMap<InertTarget, number>();

/// 给背景加 inert，返回释放函数。同一个目标可以被多个二级页同时持有，最后一个释放才摘掉
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

export function SubPage({ title, onBack, aside, className, children }: SubPageProps) {
  // Esc 等同返回
  const pageRef = useRef<HTMLDivElement>(null);

  // Esc 等同返回；叠开时只归最上面那一页（后挂上的在 body 里排在后面）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const pages = document.querySelectorAll(".ss-subpage");
      if (pageRef.current && pages[pages.length - 1] !== pageRef.current) return;
      onBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  // 打开期间主视图（和叠在下面的二级页）inert：读屏与 Tab 键都进不去
  useEffect(() => {
    const root = document.getElementById("root");
    const below = Array.from(document.querySelectorAll<HTMLElement>(".ss-subpage")).filter(
      (el) => el !== pageRef.current,
    );
    const releases = [...(root ? [root] : []), ...below].map((el) => holdInert(el));
    return () => releases.forEach((release) => release());
  }, []);

  // 打开：焦点移到页标题；返回：焦点回到触发它的那颗按钮（它被重挂过就按读屏名 / 文字认回）
  const titleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    const trigger =
      active instanceof HTMLElement && active !== document.body && !active.closest(".ss-subpage")
        ? active
        : lastClicked;
    const key = trigger ? triggerKey(trigger) : null;
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      // 等主视图这一轮提交完（可能刚重挂）再找
      setTimeout(() => {
        if (trigger && trigger.isConnected && !trigger.closest("[inert]")) {
          trigger.focus({ preventScroll: true });
          return;
        }
        if (!key) return;
        const root = document.getElementById("root");
        const buttons = root
          ? Array.from(root.querySelectorAll<HTMLElement>("button, [role='button'], a[href]"))
          : [];
        const i = pickTrigger(buttons, key);
        if (i >= 0) buttons[i].focus({ preventScroll: true });
      }, 0);
    };
  }, []);

  const page = (
    <div ref={pageRef} className={className ? `ss-subpage ${className}` : "ss-subpage"}>
      <div className="ss-subpage__bar" data-tauri-drag-region>
        <IconButton icon={<IconArrowLeft />} title="返回" onClick={onBack} />
        <div className="ss-subpage__title" tabIndex={-1} ref={titleRef}>
          {title}
        </div>
        {aside ? <div className="ss-subpage__aside">{aside}</div> : null}
      </div>
      <div className="ss-subpage__body">{children}</div>
    </div>
  );
  // 服务端渲染（node:test 的静态渲染）没有 document，也不支持 portal：原地渲染
  return typeof document === "undefined" ? page : createPortal(page, document.body);
}

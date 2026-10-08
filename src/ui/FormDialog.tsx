import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { FadeViewport, useEdgeFades } from "./EdgeFade.tsx";
import { FOCUSABLE, cycleFocus } from "./FloatingLayer.tsx";
import { holdInert, type InertTarget } from "./PushedPage.tsx";

/// 填短表单的弹窗（DESIGN「页面还是弹层」弹层的第二种用途；DESIGN-components「填短表单的弹窗」）：
/// 反馈小窗、添加 / 编辑模型提供商。外形照确认框的宽档：窗口正中、遮罩整面压暗，纸浮层宽 480（`ss-confirm--wide`），
/// 标题 `head` 16 / 600。**不高过窗口**：最高＝窗口高减上下各 24（遮罩层的内边距），标题与键区钉住，中间内容
/// 在弹窗里滚动、上下沿 `--fade-edge` 渐隐（走查 2026-10-08：添加模型提供商的列表一长，标题与键区被切到窗口外）。
///
/// - **点遮罩不收起**：填了一半的东西不该因为点偏了就没了。Esc 交给 `onEscape`（不给＝此刻收不起，比如发送中）；
///   捕获阶段接走，页面不再把它当返回。搜索框里还有字时让给搜索框先清空
/// - 焦点：打开时表单里已有 `autoFocus` 的框就留在那里，否则落在键区（`.ss-confirm__foot`）第一颗键（`取消`）；
///   Tab 只在弹窗里转圈；收起时还给打开前的地方。程序放的焦点不画框（inputModality）
/// - 应用壳其余部分（`#root`）inert：菜单、快捷键放不进遮罩后面，读屏也只读弹窗。弹窗 portal 在 `#root` 外
/// - ⌘Q 退出时一律先收起（`dismissFormDialogs`，不分弹窗种类；有没保存的改动先经离开前那一问，见 `quitWithDialog`）：
///   每个弹窗给 `onDismiss`——收起、不问
///
/// 内容由调用方给（放进滚动的那一层）；键区给 `foot`（右对齐，`取消` 在前，钉在底下），键区左边一句给 `status`
/// （13 ink-mute：没保存时问的那句）。组件库不碰 api
export interface FormDialogProps {
  title: ReactNode;
  children: ReactNode;
  /// Esc 收起；不给就是此刻收不起
  onEscape?: () => void;
  /// 收起、不问（⌘Q 退出时由 `dismissFormDialogs` 调；发送中、保存中也收起，在路上的结果不再理会）
  onDismiss: () => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  /// 键区：确认框同一排法（高 32、间距 8、右对齐）
  foot?: ReactNode;
  /// 键区左边一句
  status?: ReactNode;
  /// 内容自己管滚动（添加模型提供商的预设名单）：中间那一层不滚，内容撑满余下的高，由内容里那一层滚——
  /// 弹窗里只留一层滚动（走查 2026-10-08）
  stretch?: boolean;
}

/// 此刻开着的填短表单的弹窗，各自怎么收起（应用菜单据此决定换不换页，见 `routeWithDialog`；⌘Q 先收起它们）
const openDialogs = new Set<{ current: () => void }>();

/// 有没有填短表单的弹窗开着（反馈小窗、添加 / 编辑模型提供商，不分种类）
export function formDialogOpen(): boolean {
  return openDialogs.size > 0;
}

/// 收起此刻开着的全部填短表单的弹窗、不问（⌘Q 退出前，见 `quitWithDialog`）
export function dismissFormDialogs(): void {
  [...openDialogs].forEach((dismiss) => dismiss.current());
}

/// 弹窗开着时应用壳的其余部分（`#root`）inert。与推入页共用 `holdInert` 的计数，返回放手函数
export function inertBehind(lookup: (id: string) => InertTarget | null): () => void {
  const root = lookup("root");
  return root ? holdInert(root) : () => undefined;
}

export function FormDialog({
  title,
  children,
  onEscape,
  onDismiss,
  onPaste,
  foot,
  status,
  stretch = false,
}: FormDialogProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(body);
  /// 打开前焦点在哪：在第一次渲染时记下（表单里的 autoFocus 在提交阶段就把焦点拿走了，effect 里再读已经晚了）
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);

  // 焦点：表单里 autoFocus 的框已经拿到了就不动，否则落在键区第一颗键；收起时还给打开前的地方（还在的话）
  useEffect(() => {
    const before = opener.current;
    const box = dialog.current;
    if (box && !box.contains(document.activeElement)) {
      box.querySelector<HTMLButtonElement>(".ss-confirm__foot button")?.focus();
    }
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      // 搜索框里还有字：这一下归它（先清空），不收弹窗
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.value !== "" &&
        target.closest(".ss-textfield--search")
      ) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      escape.current?.();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // 布局阶段挂上 / 摘掉：关窗时锚在入口键下的提示条量位置之前就摘掉
  useLayoutEffect(() => inertBehind((id) => document.getElementById(id)), []);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    openDialogs.add(dismiss);
    return () => void openDialogs.delete(dismiss);
  }, []);

  // Tab 在弹窗里转圈（同详情浮层），不走到后面的页面
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = cycleFocus(
      items.length,
      items.indexOf(document.activeElement as HTMLElement),
      event.shiftKey,
    );
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  };

  const layer = (
    <div className="ss-confirm-layer" role="presentation">
      <div className="ss-confirm-veil ss-confirm-veil--full" />
      <div
        ref={dialog}
        className="ss-confirm ss-confirm--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      >
        <div className="ss-confirm__title" id={titleId}>
          {title}
        </div>
        <FadeViewport fade={fade} className="ss-formdialog__viewport">
          <div
            className={`ss-formdialog__body${stretch ? " ss-formdialog__body--stretch" : ""}`}
            ref={body}
          >
            {children}
          </div>
        </FadeViewport>
        {foot !== undefined ? (
          <div className="ss-confirm__foot">
            {status ? (
              <span className="ss-confirm__status" role="status">
                {status}
              </span>
            ) : null}
            {foot}
          </div>
        ) : null}
      </div>
    </div>
  );
  return typeof document === "undefined" ? layer : createPortal(layer, document.body);
}

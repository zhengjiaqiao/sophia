import { useCallback, useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { Button } from "./Button.tsx";
import { FloatingLayer } from "./FloatingLayer.tsx";

/// 详情（spec 2026-10-04-local-diagnostics R13；DESIGN-components「详情 Details」）：出错提示上的技术原文
/// （请求、状态码、返回的错误、调用栈）。
///
/// 平时是一颗 `详情` 默认键（紧凑 24；出错页里与 `重新加载` 同高用 `regular`），**不在行里展开**
/// （2026-10-04 产品负责人：「长条提示，我倾向于不要再设计展开按钮，要嘛就是点击后弹窗展示，要嘛就是打开新的页面」）。
/// 点它弹出锚在键上的小浮层（`FloatingLayer`：`paper` + 1px `hairline` 边、`float` 12 圆角 + 浮层投影；
/// 宽 440、内边距 12），里面是等宽 12 的原文（可选中、太长在框里滚）和右下一颗 `复制详情`；点外面、Esc、
/// 再点一次 `详情` 都关，Esc 把焦点还给键。浮层开着时键保持按下（同锁键）。
///
/// 复制不在这里做：组件库不碰 api，`onCopy(text)` 交给调用方（它负责先去隐私再写剪贴板）。
/// 回调成功后键上的字换成 `已复制` 一会儿；回调拒绝（脱敏没做成时不能把原文放出去）就不换，也不抛。
export const COPIED_MS = 1600;

export interface DetailsProps {
  /// 技术原文，原样显示
  text: string;
  /// 点 `复制详情` 时调用；返回 Promise 的话等它成功再给「已复制」
  onCopy: (text: string) => void | Promise<void>;
  /// 键的尺寸：`compact`（默认，灰面板、行尾）/ `regular`（出错页，与 `重新加载` 同高）
  size?: "compact" | "regular";
  /// 浮层水平对齐键：`end`（默认，键多在行尾、面板右端）右沿对齐向左展开；`start` 左沿对齐
  align?: "start" | "end";
  /// 初始就弹开（样张用；服务端渲染没有锚点，不画浮层）
  defaultOpen?: boolean;
}

export function Details({
  text,
  onCopy,
  size = "compact",
  align = "end",
  defaultOpen = false,
}: DetailsProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /// 锚点：键本身（Esc 把焦点还给它）。Button 不转 ref，从包层里取
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const bodyId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    setTrigger(wrap.current?.querySelector("button") ?? null);
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const close = useCallback(() => setOpen(false), []);

  const copy = () => {
    void Promise.resolve()
      .then(() => onCopy(text))
      .then(
        () => {
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        },
        () => undefined,
      );
  };

  return (
    <span className="ss-details" ref={wrap}>
      <Button
        size={size === "regular" ? "regular" : "compact"}
        ariaHasPopup="dialog"
        ariaExpanded={open}
        ariaControls={open ? bodyId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {t("common.details.toggle")}
      </Button>
      {open && trigger ? (
        <FloatingLayer
          trigger={trigger}
          onClose={close}
          label={t("common.details.toggle")}
          role="dialog"
          align={align}
          className="ss-details__layer"
        >
          <DetailsBody id={bodyId} text={text} copied={copied} onCopy={copy} />
        </FloatingLayer>
      ) : null}
    </span>
  );
}

export interface DetailsBodyProps {
  text: string;
  /// 刚复制过：键上写 `已复制`
  copied: boolean;
  onCopy: () => void;
  id?: string;
}

/// 浮层里的内容：等宽原文（可选中，键盘可聚焦以便滚动）+ 右下 `复制详情`
export function DetailsBody({ text, copied, onCopy, id }: DetailsBodyProps) {
  return (
    <div className="ss-details__body" id={id}>
      <pre className="ss-details__text ss-selectable" tabIndex={0}>
        {text}
      </pre>
      <div className="ss-details__actions">
        <Button size="compact" onClick={onCopy}>
          {copied ? t("common.details.copied") : t("common.details.copy")}
        </Button>
      </div>
    </div>
  );
}

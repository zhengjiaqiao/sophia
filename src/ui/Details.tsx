import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { Button } from "./Button.tsx";
import { HoverCard } from "./HoverCard.tsx";
import { IconAttention } from "./icons.tsx";

/// 详情（spec 2026-10-04-local-diagnostics R13；DESIGN-components「详情 Details」）：出错提示上的技术原文
/// （请求、状态码、返回的错误、调用栈）。
///
/// **入口是错误前面的「!」**（2026-10-06 产品负责人，画板 5703fb83 方案 D：「这前面不是已经有图标了，相当于这个图标，
/// 即是按钮，点了也能出悬浮窗口，也能直接悬浮出」）：一颗图标键（`ss-markbtn`），手放上去出底色；停上去或点一下，
/// 在它下面浮起悬浮卡（`HoverCard`，宽 440、内边距 12），里面是等宽 12 的原文（可选中、太长在框里滚）和右下一颗
/// `复制详情`。原文不在行里、长条里展开；不是一颗 `详情` 字键，也不挂在一句普通文字上（看不出能停，规范 ⑧）。
///
/// 复制不在这里做：组件库不碰 api，`onCopy(text)` 交给调用方（它负责先去隐私再写剪贴板）。
/// 回调成功后键上的字换成 `已复制` 一会儿；回调拒绝（脱敏没做成时不能把原文放出去）就不换，也不抛。
export const COPIED_MS = 1600;

/// 「!」的大小：灰面板左端、出错页标题前 16（同静态记号；标题是 15 号字，18 显大、看着错位，2026-10-06 真机），
/// 网关行第二行 14
const MARK_SIZE = { panel: 16, row: 14, title: 16 } as const;

export interface DetailsProps {
  /// 技术原文，原样显示
  text: string;
  /// 点 `复制详情` 时调用；返回 Promise 的话等它成功再给「已复制」
  onCopy: (text: string) => void | Promise<void>;
  /// 「!」放在哪：灰面板（默认）/ 网关行 / 出错页标题
  size?: keyof typeof MARK_SIZE;
  /// 初始就钉住打开（样张用；服务端渲染没有锚点，不画卡）
  defaultOpen?: boolean;
}

export function Details({ text, onCopy, size = "panel", defaultOpen = false }: DetailsProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

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
    <HoverCard
      label={t("common.details.toggle")}
      triggerLabel={t("common.details.open")}
      className={`ss-markbtn ss-markbtn--${size}`}
      cardClassName="ss-details__layer"
      defaultOpen={defaultOpen}
      content={<DetailsBody text={text} copied={copied} onCopy={copy} />}
    >
      <IconAttention size={MARK_SIZE[size]} />
    </HoverCard>
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

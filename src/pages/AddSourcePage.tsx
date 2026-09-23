import { useEffect, useRef, useState } from "react";
import { SubPage } from "../ui";
import { AddSourcePanel } from "./AddSourcePanel.tsx";
import type { DomainRef } from "./sourcesView.ts";
import type { SourcesModel } from "./sourcesModel.ts";
import "./AddSourcePage.css";

/// 添加来源的**容器**：二级页 `添加来源到「CardBox」`（DESIGN「来源管理页 › 添加：二级页」）。
/// 只管外面这层：「← 标题」骨架、从右推入 / 滑回的转场、内容铺满页宽（左沿对齐页头标题，右边距同左）。
/// 内容整个是 `AddSourcePanel`——换容器只换这一层，Panel 不动。
///
/// - 入口两处进同一页：主视图工具行的 `+ 来源`、来源管理页页头的 `+ 来源`
/// - ←、Esc 是返回（没有 `取消`）：先播 200ms 滑回，再由调用方卸掉
/// - 勾的全加上后等调用方重扫 / 重读完，自动滑回进来的那一页；不另出成功提示
///   （新来源的 skill 以 ○ 行出现）。有没加上的就留在这一页，由 Panel 说明

/// 转场时长，与 AddSourcePage.css 同值
const MOTION_MS = 200;

export interface AddSourcePageProps {
  model: SourcesModel;
  domain: DomainRef;
  /// 滑回播完：调用方卸掉这一页
  onClose: () => void;
  /// 加上了至少一个之后（滑回之前）：主视图重扫 / 来源管理页重读
  onAdded: () => Promise<void>;
}

export function AddSourcePage({ model, domain, onClose, onAdded }: AddSourcePageProps) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  return (
    <SubPage
      className={`add-src-page${leaving ? " is-leaving" : ""}`}
      title={model.addTitle}
      onBack={leave}
    >
      <div className="add-src-page__body">
        <AddSourcePanel
          model={model}
          domain={domain}
          onChanged={onAdded}
          onDone={async () => {
            leave();
            // 滑回的这 200ms 里 Panel 保持「正在添加」，不闪回可点的主动作
            await new Promise((resolve) => setTimeout(resolve, MOTION_MS));
          }}
        />
      </div>
    </SubPage>
  );
}

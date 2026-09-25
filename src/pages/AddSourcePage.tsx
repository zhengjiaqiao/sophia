import { PushedPage, Toast, motionMs, usePushedPage } from "../ui";
import { useMenuFlag, usePageCommand } from "../shell/menuBus.ts";
import { AddSourcePanel } from "./AddSourcePanel.tsx";
import type { CandidateEntry } from "./addSourceView.ts";
import type { DomainRef } from "./sourcesView.ts";
import type { SourcesModel } from "./sourcesModel.ts";

/// 添加来源的**容器**（DESIGN「来源：订阅、来源行、添加来源 › 添加来源」）：推入页 `PushedPage`——**只替换机面**，
/// 侧栏留着、当前位置仍选中（⑨）；在机面里从右推入、返回滑回（`--dur-push`，reduced-motion 即时）。
/// 页面头：`←`（图标键 28，等于 Esc 与菜单「返回」⌘[）+ 10 + `添加来源到 CardBox`（title 20 / 700）。
/// 内容与贴底一行都是 `AddSourcePanel` 给的（它经 `frame` 把两块交给这一层）——换容器只换这一层，Panel 不动。
///
/// - 挂在机面（`.face`）上盖住位置页，位置页在它下面 `inert`（读屏、Tab 都进不去），不卸载——
///   滑回之后筛选、滚动、勾选都还在
/// - 勾的全加上后等调用方重扫完，自动滑回，开始滑回时交给调用方 `onAllAdded`：位置页筛到新来源并在
///   那几片下浮起 `✓ 已添加 …`（`AddedToast`）。有没加上的就留在这一页，由 Panel 说明

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
  // 返回：`←`、Esc 归 `PushedPage`；菜单「返回」（⌘[）归页面，只在这一页开着时亮
  const page = usePushedPage(onClose);
  usePageCommand("back", page.leave);
  useMenuFlag("back", !page.leaving);

  return (
    <AddSourcePanel
      model={model}
      domain={domain}
      onChanged={onAdded}
      onDone={async (added) => {
        onAllAdded?.(added);
        page.leave();
        // 滑回的这一段里 Panel 保持「正在添加」，不闪回可点的主动作
        await new Promise((resolve) => setTimeout(resolve, motionMs("--dur-push")));
      }}
      frame={(content, footer) => (
        <PushedPage
          {...page}
          title={model.addTitle}
          host={() => document.querySelector(".face")}
          covers={() => document.querySelector(".face__scroll")}
          footer={footer}
        >
          {content}
        </PushedPage>
      )}
    />
  );
}

/// 加完来源滑回位置页时新来源那几片正下方浮起的一窗：`✓ 已添加 WeiboAP · 已筛选出它的 39 个 skill`
/// （段由 `addedParts` 给，说清楚列表为什么变少了），约 4 秒淡出，不带撤销（移除在 `管理来源` 里）；
/// 提示走了，选中的筛选片照旧说明列表是筛过的。skill 与 MCP 共用。
/// 第一段是名字（一个来源的名字，或 `2 个来源`），其后各段接在组件画的 ` · ` 之后
export function AddedToast({ parts, onDismiss }: { parts: string[]; onDismiss: () => void }) {
  const [what, ...rest] = parts;
  return (
    <Toast
      tier="routine"
      kind="success"
      verb="已添加"
      names={what ? [what] : undefined}
      reason={rest.length > 0 ? rest.join(" · ") : undefined}
      onDismiss={onDismiss}
    />
  );
}

import { useState } from "react";
import { PushedPage, Toast, motionMs, usePushedPage } from "../ui";
import { PlaceBlock, type InstallPlaces } from "../market/InstallParts.tsx";
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
  /// 位置胶囊用的项目（同安装页）
  places: InstallPlaces;
  /// 进来时选在哪个位置（域 key）：调用方给表格 / 来源管理页的位置，`全部` 时用户级
  initial: string;
  /// 域 key → 那个位置的来源模型（调用方按 key 缓存）
  modelOf: (key: string) => SourcesModel;
  /// 域 key → 位置名（`用户级` / `CardBox`）：说「已经在 CardBox 的来源里」这类话用
  placeName: (key: string) => string;
  /// 滑回播完：调用方卸掉这一页
  onClose: () => void;
  /// 加上了至少一个之后（滑回之前）：位置页重扫
  onAdded: () => Promise<void>;
  /// 勾的全加上了、重扫已完、开始滑回时：加到的位置（域 key）与加上的那几个（按列表先后）
  onAllAdded?: (key: string, added: CandidateEntry[]) => void;
}

/// 页面最上面一块 `位置`（R8，2026-09-30：位置在页里选，不先弹「把来源加到哪个位置？」）：与安装页同一块
/// `PlaceBlock`（胶囊没有 `全部`）。位置决定下面列什么（「其他项目在用的」不列这个位置已经有的），
/// 所以换位置时候选按新位置重算、勾选清空（Panel 见到新模型自己清空重读，推入页不重挂）；页名跟着换（`添加来源到 CardBox`）
export function AddSourcePage({
  places,
  initial,
  modelOf,
  placeName,
  onClose,
  onAdded,
  onAllAdded,
}: AddSourcePageProps) {
  // 返回：`←`、Esc 归 `PushedPage`；菜单「返回」（⌘[）归页面，只在这一页开着时亮
  const page = usePushedPage(onClose);
  usePageCommand("back", page.leave);
  useMenuFlag("back", !page.leaving);
  const [at, setAt] = useState(initial);
  const model = modelOf(at);
  const domain: DomainRef = { key: at, label: placeName(at) };

  return (
    <AddSourcePanel
      model={model}
      domain={domain}
      onChanged={onAdded}
      onDone={async (added) => {
        onAllAdded?.(at, added);
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
          <div className="add-src__place">
            <PlaceBlock places={places} value={at} onChange={setAt} />
          </div>
          {content}
        </PushedPage>
      )}
    />
  );
}

/// 加完来源滑回位置页时右下角的一窗（CornerToast；2026-09-30 起，原来挂在 `+ 来源` 下）：`✓ 已添加 WeiboAP · 已筛选出它的 39 个 skill`
/// （段由 `addedParts` 给，说清楚列表为什么变少了），约 4 秒淡出，不带撤销（移除在 `管理来源` 里）；
/// 提示走了，选中的筛选片照旧说明列表是筛过的。skill 与 MCP 共用。
/// 第一段是名字（一个来源的名字，或 `2 个来源`），其后各段接在组件画的 ` · ` 之后
export function AddedToast({ parts, onDismiss }: { parts: string[]; onDismiss: () => void }) {
  const [what, ...rest] = parts;
  return (
    <Toast
      kind="success"
      sentence="sources.added.done"
      names={what ? [what] : undefined}
      trail={rest.length > 0 ? rest : undefined}
      onDismiss={onDismiss}
    />
  );
}

/// 安装 skill（spec R9，画板 06；DESIGN「发现与安装 › 安装页」）：推入页 + 贴底一行。
///
/// ```
/// ←  安装 pdf
/// 来自 anthropics · 在 GitHub 打开 ↗   （悬停 来自 anthropics：anthropics/skills · skills/pdf，等宽）
/// 读、写、合并、拆分 PDF，填表单、抽表格。
/// 生效范围 ─────────────────────────────────────────
/// [用户级] [CardBox] [weibo_assistant] [更多 ˅]
/// 所有项目都能用                          （项目：只在 CardBox 中能用）
/// ~/.agents/skills/pdf                    （等宽灰字，常显）
/// 给谁用 ───────────────────────────────────────────
/// 这些 agent 直接读取这个文件夹，无需选择
/// c Cline
/// 同时加到
/// ☑ ✳ Claude Code                ☑ ⎔ Codex
/// ═══════════════════════════════════════════════ 贴底
/// 从 GitHub 下载 · 2.1 MB                  [取消] [安装]   （悬停：codeload.github.com · 分支 main）
/// ```
///
/// 从列表的 `安装`、介绍页的 `安装` 进来（介绍页上再推一层：`←` 回介绍页，装完两层一起滑回由调用方收）。
/// 装上了：交 `onDone(outcome, notice)`，推入页滑回；调用方在右下挂 `InstalledToast`。
/// 做不成：留在这一页，主动作上方浮一窗说原因
import { useEffect, useState } from "react";
import { t } from "../i18n.ts";
import { Mono, PushedPage, usePushedPage } from "../ui/index.ts";
import { useMenuFlag, usePageCommand } from "../shell/menuBus.ts";
import type { Location } from "../shell/nav.ts";
import type { InstallOutcome } from "../types.ts";
import type { InstalledNotice } from "./InstalledToast.tsx";
import {
  DownloadFailure,
  DownloadTip,
  SkillAgents,
  InstallBlock,
  InstallFooter,
  InstallScroll,
  OriginLine,
  PlaceBlock,
  type InstallPlaces,
} from "./InstallParts.tsx";
import {
  downloadLine,
  githubTreeUrl,
  installLabel,
  skillInstallBlock,
  type InstallAgent,
} from "./installView.ts";
import { skillOrigin } from "./discoverView.ts";
import { marketService, type MarketService } from "./service.ts";
import { useSkillInstall } from "./useInstall.ts";

/// 安装类推入页共有的 props
export interface InstallPageBase {
  /// 当前 `我的` 的位置：默认装到这里，`全部` 时装到用户级
  mine: Location;
  /// 位置胶囊（与位置页筛选行同一份项目）
  places: InstallPlaces;
  /// 已安装的 agent（agent 表的先后）：勾选行从这里取
  agents: ReadonlyArray<InstallAgent>;
  /// 设置里 `显示的 agent`（harness id）：默认勾它们
  shown: ReadonlyArray<string>;
  /// 滑回播完：调用方卸掉这一页
  onClose: () => void;
  service?: MarketService;
  /// 挂到哪、盖住哪（默认机面 `.face` / `.face__scroll`，同来源管理页）
  host?: () => Element | null;
  covers?: () => Element | null;
  /// 此刻 Esc 归不归这一页（叠在介绍页上时下面那一层给 false）
  escape?: boolean;
}

/// 要装的那个 skill
export interface SkillTarget {
  name: string;
  /// `owner/repo`
  repo: string;
  /// 仓库内路径（仓库根是空串）；不知道（搜索结果）时为 null，按 `skillId` 或名字让后端去包里找
  path: string | null;
  /// skills.sh 的 id（搜索结果才有）
  skillId?: string | null;
  /// 不知道时为 null（后端取默认分支）
  branch: string | null;
  /// 一句说明（frontmatter 的 description）；没有就不写
  description?: string | null;
}

export interface InstallPageProps extends InstallPageBase {
  skill: SkillTarget;
  /// 装上了（至少一个）：结果 + 右下那一窗（`✓ 已安装 pdf` + `撤销`）
  onDone: (outcome: InstallOutcome, notice: InstalledNotice) => void;
}

/// 交给后端的路径：知道就写路径，不知道写 skill 的 id 或名字（后端按包里的文件夹补上）
export const planPathOf = (skill: SkillTarget) =>
  skill.path !== null ? skill.path : (skill.skillId ?? skill.name);

const FACE = () => document.querySelector(".face");
const FACE_SCROLL = () => document.querySelector(".face__scroll");

/// 推入页的外框：返回（`←`、Esc、菜单「返回」⌘[）与挂载位置
export function useInstallFrame(onClose: () => void) {
  const page = usePushedPage(onClose);
  usePageCommand("back", page.leave);
  useMenuFlag("back", !page.leaving);
  return page;
}

export function InstallPage(props: InstallPageProps) {
  const { skill, onDone } = props;
  const service = props.service ?? marketService;
  const page = useInstallFrame(props.onClose);
  const state = useSkillInstall({
    service,
    repo: skill.repo,
    branch: skill.branch,
    planPaths: [planPathOf(skill)],
    mine: props.mine,
    agents: props.agents,
    shown: props.shown,
  });
  const body = (
    <SkillInstallBody skill={skill} state={state} places={props.places} service={service} />
  );
  const item = state.itemFor(planPathOf(skill));
  const block = skillInstallBlock({
    items: item ? [item] : [],
    selected: 1,
    agents: state.requestedFor(state.namesOf([planPathOf(skill)])).length,
    checking: state.checking,
  });
  const submit = async () => {
    const done = await state.install([planPathOf(skill)], [skill.name]);
    if (!done) return;
    onDone(done.outcome, {
      kind: "skill",
      toast: done.toast,
      undoId: done.outcome.undoId,
      handle: done.handle,
    });
    page.leave();
  };
  return (
    <PushedPage
      {...page}
      title={t("market.install.title", { name: skill.name })}
      host={props.host ?? FACE}
      covers={props.covers ?? FACE_SCROLL}
      escape={props.escape}
      footer={
        <InstallFooter
          line={downloadLine(state.preview)}
          tip={<DownloadTip source={state.preview} branch={skill.branch} />}
          label={installLabel(1)}
          block={block}
          busy={state.busy}
          busyLabel={t("market.busy.installing")}
          failure={state.failure}
          onDismissFailure={state.dismissFailure}
          onCancel={page.leave}
          onSubmit={() => void submit()}
        />
      }
    >
      <InstallScroll>{body}</InstallScroll>
    </PushedPage>
  );
}

/// 安装页的正文：来历、一句说明、生效范围 + 落点、给谁用。从链接安装只认出一个 skill 时，那一页的正文也是它
export function SkillInstallBody({
  skill,
  state,
  places,
  service,
}: {
  skill: SkillTarget;
  state: ReturnType<typeof useSkillInstall>;
  places: InstallPlaces;
  service: MarketService;
}) {
  const item = state.itemFor(planPathOf(skill));
  // 搜索结果不知道路径：计划回来之后用后端在包里找到的
  const path = skill.path ?? item?.path ?? null;
  const branch = skill.branch ?? state.preview?.branch ?? null;
  const { from, exact } = skillOrigin(skill.repo, path);
  const origin = [{ text: from, tip: <Mono inherit>{exact}</Mono> }];
  // 从列表直接装时没有说明：自己去取一句（2026-09-27 真人测试 INS-1）
  const [fetched, setFetched] = useState<string | null>(null);
  useEffect(() => {
    if (skill.description || !service.skillDescription) return;
    let alive = true;
    void service
      .skillDescription(
        skill.repo,
        skill.branch ?? null,
        skill.path ?? null,
        skill.skillId ?? skill.name,
      )
      .then((d) => {
        if (alive) setFetched(d);
      });
    return () => {
      alive = false;
    };
  }, [service, skill.description, skill.repo, skill.branch, skill.path, skill.skillId, skill.name]);
  const description = skill.description ?? fetched;
  return (
    <>
      <OriginLine
        parts={origin}
        leave={{
          label: t("market.leave.github"),
          onClick: () => service.openUrl(githubTreeUrl(skill.repo, branch, path)),
        }}
      />
      {description ? <p className="install-lede">{description}</p> : null}
      <PlaceBlock
        places={places}
        value={state.location}
        onChange={state.setLocation}
        name={item?.name ?? skill.name}
        blocked={item?.blocked ? { reason: item.blocked, path: item.dest } : null}
        onReveal={service.reveal}
      />
      {state.planError ? (
        <DownloadFailure
          failure={state.planError}
          className="install-error"
          onRetry={state.retryPlan}
        />
      ) : null}
      <InstallBlock label={t("market.install.blockWho")}>
        <SkillAgents
          rows={state.rows}
          direct={state.directReaders}
          checked={state.checked}
          onToggle={state.toggle}
          viewOf={state.viewFor(state.namesOf([planPathOf(skill)]))}
        />
      </InstallBlock>
    </>
  );
}

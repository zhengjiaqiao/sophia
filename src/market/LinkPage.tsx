/// 从链接安装（spec R6，画板 07；DESIGN「发现与安装 › 从链接安装 · 从 JSON 添加」）：`粘贴链接` 推入这一页。
///
/// ```
/// ←  从链接安装
/// [https://github.com/anthropics/skills                                    ]
/// anthropics/skills · main · 找到 17 个 skill
/// 装哪几个 · 17 个里选了 3 ─────────────────────────
/// ☐ 全部可装的  16 个                      （钉在顶上；三态，同表头全选框）
/// ☑ docx     skills/docx
/// …（能装的在前，装过的沉底；自己滚，露 6 行半）
/// ☐ pdf      用户级的通用仓库里已经有 pdf  在访达中显示 ↗
/// 位置 ─── [用户级] [CardBox] [更多 ˅]
/// 装到 ~/.agents/skills/<名字> · 这里是用户级的通用仓库
/// 给谁用 ─ ☑ Claude Code  ☑ Codex …
/// ═══════════════════════════════════════════════ 贴底
/// 从 codeload.github.com 下载 · main                 [取消] [安装 3 个]
/// ```
///
/// - 进来时剪贴板里是 GitHub 链接就直接填好
/// - 认不出的链接当即说 `只认 GitHub 上的仓库或文件夹链接`，不发请求；认得出的停 400ms 再去读
/// - 只找到一个 skill：这一页就是它的安装页（标题换成 `安装 pdf`，正文同安装页，输入框留在上面可以改）
/// - 都在一页里选完：列表、位置、给谁用，贴底 `安装 M 个`
import { useEffect, useRef, useState } from "react";
import { t, tn } from "../i18n.ts";
import { Button, Mono, PushedPage, Spinner, TextField, useBusyShown } from "../ui/index.ts";
import type { ResolvedLink } from "../types.ts";
import type { InstalledNotice } from "./InstalledToast.tsx";
import type { InstallOutcome } from "../types.ts";
import {
  DownloadFailure,
  SkillAgents,
  InstallBlock,
  InstallFooter,
  InstallScroll,
  PickList,
  PickRow,
  PlaceBlock,
} from "./InstallParts.tsx";
import { SkillInstallBody, useInstallFrame, type InstallPageBase } from "./InstallPage.tsx";
import {
  linkUnrecognized,
  downloadLine,
  installLabel,
  linkState,
  looksLikeGithub,
  parseGithubLink,
  pickAllState,
  pickHeader,
  pickOrder,
  skillInstallBlock,
} from "./installView.ts";
import { skillDownloadFailure, type SkillDownloadFailure } from "../netFailure.ts";
import { marketService } from "./service.ts";
import { usePageCommand } from "../shell/menuBus.ts";
import { useClipboardPrefill, useDebounced, useSkillInstall } from "./useInstall.ts";

export interface LinkPageProps extends InstallPageBase {
  /// 装上了（至少一个）：结果 + 右下那一窗
  onDone: (outcome: InstallOutcome, notice: InstalledNotice) => void;
  /// 输入框里先放什么（样张、测试）；不给就看剪贴板
  initial?: string;
}

const FACE = () => document.querySelector(".face");
const FACE_SCROLL = () => document.querySelector(".face__scroll");

/// 读链接的结果，记着是哪一次输入读出来的（输入又变了就不算数）
type Resolution =
  { input: string; result: ResolvedLink } | { input: string; error: SkillDownloadFailure };

export const noLink = () => t("market.link.noLink");

export function LinkPage(props: LinkPageProps) {
  const service = props.service ?? marketService;
  const page = useInstallFrame(props.onClose);
  const [text, setText] = useState(props.initial ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  useClipboardPrefill(service, looksLikeGithub, setText, () => textRef.current.trim() === "");

  // 认得出才去读（停 400ms）；认不出不发请求
  const settled = useDebounced(text.trim(), 400);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  /// 「开着代理再试一次」：加一就把同一个链接再读一遍
  const [resolveRetry, setResolveRetry] = useState(0);
  useEffect(() => {
    if (!parseGithubLink(settled)) return;
    let alive = true;
    service
      .resolveLink(settled)
      .then((result) => alive && setResolution({ input: settled, result }))
      .catch(
        (error: unknown) =>
          alive && setResolution({ input: settled, error: skillDownloadFailure(error) }),
      );
    return () => {
      alive = false;
    };
  }, [settled, service, resolveRetry]);

  const local = linkState(text);
  const current = resolution && resolution.input === text.trim() ? resolution : null;
  const found = current && "result" in current ? current.result : null;
  const skills = found?.skills ?? [];
  const single = skills.length === 1 ? skills[0] : null;
  const reading = local.kind === "reading" && current === null;
  const showReading = useBusyShown(reading);

  const state = useSkillInstall({
    service,
    repo: found?.repo ?? "",
    branch: found?.branch ?? null,
    planPaths: skills.map((s) => s.path),
    mine: props.mine,
    agents: props.agents,
    shown: props.shown,
  });

  // 换了一个仓库：之前勾的不作数
  const foundKey = found
    ? `${found.repo}\t${found.branch}\t${skills.map((s) => s.path).join("\n")}`
    : "";
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected([]), [foundKey]);
  const blockedOf = (path: string) => state.itemFor(path)?.blocked ?? null;
  const picked = single ? [single.path] : selected.filter((p) => blockedOf(p) === null);
  // 能装的排前面、装过的沉底（能装的被挤到下面要往下翻）；全选只管能装的
  const ordered = pickOrder(skills, blockedOf);
  const installable = ordered.filter((s) => blockedOf(s.path) === null).map((s) => s.path);
  const allState = pickAllState(picked.length, installable.length);
  const setAll = (on: boolean) => setSelected(on ? installable : []);
  // ⌘A（应用菜单「全选」）：勾上能装的全部；输入框聚焦时壳把它交给文字，不会到这里
  usePageCommand("select-all", () => {
    if (!single && skills.length > 1 && installable.length > 0) setAll(true);
  });
  const pickedItems = picked
    .map((p) => state.itemFor(p))
    .filter((i): i is NonNullable<typeof i> => i !== undefined);
  const block = !found
    ? noLink()
    : skillInstallBlock({
        items: pickedItems,
        selected: picked.length,
        agents: state.requestedFor(state.namesOf(picked)).length,
        checking: state.checking,
      });

  const submit = async () => {
    if (!found) return;
    const names = picked.map((p) => skills.find((s) => s.path === p)?.name ?? p);
    const done = await state.install(picked, names);
    if (!done) return;
    props.onDone(done.outcome, {
      kind: "skill",
      toast: done.toast,
      undoId: done.outcome.undoId,
      handle: done.handle,
    });
    page.leave();
  };

  const status =
    local.kind === "unrecognized" ? (
      <p className="install-status is-error">{linkUnrecognized()}</p>
    ) : current && "error" in current ? (
      <DownloadFailure
        failure={current.error}
        className="install-status is-error"
        onRetry={() => {
          setResolution(null);
          setResolveRetry((n) => n + 1);
        }}
      />
    ) : single ? null : found ? (
      // 只认出一个时不写这一行：下面的来历一行已经说了仓库与路径
      <p className="install-status">
        <span className="install-status__repo">
          <Mono inherit>{found.repo}</Mono>
        </span>
        &nbsp;·&nbsp;{found.branch}&nbsp;·&nbsp;
        {skills.length === 0 ? t("market.link.none") : tn("market.link.found", skills.length)}
      </p>
    ) : reading && showReading ? (
      <p className="install-status is-reading" role="status">
        <Spinner size={14} label={t("market.busy.reading")} />
        <span>
          {t("market.link.reading", { repo: local.kind === "reading" ? local.link.repo : "" })}
        </span>
      </p>
    ) : (
      <p className="install-status" aria-hidden="true" />
    );

  const lead = (
    <>
      <div className="install-link">
        <TextField
          value={text}
          onChange={setText}
          label={t("market.link.inputLabel")}
          placeholder={t("market.link.inputPlaceholder")}
          mono
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {status}
    </>
  );

  return (
    <PushedPage
      {...page}
      title={single ? t("market.install.title", { name: single.name }) : t("market.link.title")}
      label={t("market.link.title")}
      host={props.host ?? FACE}
      covers={props.covers ?? FACE_SCROLL}
      escape={props.escape}
      footer={
        <InstallFooter
          line={found ? downloadLine(found, found.branch) : ""}
          label={installLabel(picked.length)}
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
      <InstallScroll>
        {/* 输入框一直在同一处：认出一个与认出几个之间切换时不重挂，打着的字、焦点都还在 */}
        {lead}
        {single && found ? (
          <SkillInstallBody
            skill={{ name: single.name, repo: found.repo, path: single.path, branch: found.branch }}
            state={state}
            places={props.places}
            service={service}
          />
        ) : (
          <>
            {found && skills.length > 1 ? (
              <>
                <InstallBlock label={pickHeader(skills.length, picked.length)}>
                  <PickList label={t("market.link.pickLabel")}>
                    <PickRow
                      pinned
                      label={t("market.link.pickAll")}
                      name={t("market.link.pickAll")}
                      checked={allState}
                      onChange={setAll}
                      detail={tn("market.link.pickAllCount", installable.length)}
                      blocked={installable.length === 0 ? t("market.link.pickAllNone") : null}
                    />
                    {ordered.map((s) => {
                      const item = state.itemFor(s.path);
                      const blocked = item?.blocked ?? null;
                      return (
                        <PickRow
                          key={s.path}
                          label={s.name}
                          name={s.name}
                          checked={selected.includes(s.path)}
                          onChange={(on) =>
                            setSelected((prev) =>
                              on ? [...prev, s.path] : prev.filter((p) => p !== s.path),
                            )
                          }
                          detail={<Mono inherit>{s.path}</Mono>}
                          blocked={blocked}
                          action={
                            blocked && item ? (
                              <Button variant="quiet" onClick={() => service.reveal(item.dest)}>
                                {t("market.install.reveal")}
                              </Button>
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </PickList>
                </InstallBlock>
                <PlaceBlock
                  places={props.places}
                  value={state.location}
                  onChange={state.setLocation}
                  name={null}
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
                    viewOf={state.viewFor(state.namesOf(picked))}
                  />
                </InstallBlock>
              </>
            ) : null}
          </>
        )}
      </InstallScroll>
    </PushedPage>
  );
}

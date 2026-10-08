/// 介绍页（spec 2026-09-27-skill-mcp-market R5B、R7；DESIGN「发现与安装 › 介绍页（推入页）」，画板 04B / 08B）。
///
/// - 骨架是 `PushedPage`（同来源管理页）：只替换机面、侧栏留着；`←` / Esc / ⌘[ 回到列表，列表的搜索词与滚动照旧
/// - 页面头右端是这一页的主动作：墨键 `安装`（按下交给 `onInstall`，由安装页再推入一层）；
///   装过的换成状态 `✓ 已安装`，来历行下多一句 `装在 用户级、CardBox`
/// - 来历一行（页面头下 10）：
///   skill：`来自 <作者>`（悬停出等宽的 `owner/repo · 仓库内路径`，#307）· 装过的人 + `在 GitHub 打开 ↗`
///   MCP：发布方 · `精选` / `官方目录` + 离开键 `查看说明 ↗`（包名进它的悬停，#276）
/// - MCP 来历下先列两行事实：`运行方式`（`本地运行` / `在线服务`，命令与地址进悬停）、`要填的`——决定要不要装的就这两件
/// - 其下 16 一条 hairline，再 16 起正文：渲染后的 SKILL.md / README，读宽 640，自己滚（边缘渐隐）；
///   frontmatter 去掉、其 description 作首段。取的时候 `正在取说明`；
///   skill 取不到写 `说明读取失败` + `在 GitHub 打开 ↗`；MCP 取不到只留两行事实
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { t } from "../i18n";
import { useMenuFlag, usePageCommand } from "../shell/menuBus";
import type { McpRow, SkillReadme, SkillRow } from "../types";
import {
  BusySlot,
  Button,
  FadeViewport,
  Mono,
  Note,
  PushedPage,
  Tag,
  Tooltip,
  useEdgeFades,
  usePushedPage,
} from "../ui";
import {
  rateLimited,
  errorText,
  githubUrl,
  installedLine,
  installsText,
  isInstalled,
  mcpConnection,
  mcpFieldFacts,
  mcpSourceLabel,
  skillOrigin,
} from "./discoverView";
import { InstalledMark } from "./InstalledMark";
import { mcpOrigin } from "./installView";
import { MarkdownBody } from "./markdown";
import { linkBase, stripFrontmatter } from "./markdownText";
import "./IntroPage.css";

export type IntroPageProps =
  | ({
      kind: "skill";
      item: SkillRow;
      onClose: () => void;
      onInstall?: (item: SkillRow) => void;
    } & IntroLayer)
  | ({
      kind: "mcp";
      item: McpRow;
      onClose: () => void;
      onInstall?: (item: McpRow) => void;
    } & IntroLayer);

/// 介绍页上再推入安装页时（两层推入，同来源管理页上再推入添加来源页）：
/// Esc 只归上面那一层；装完两层一起滑回
export interface IntroLayer {
  /// 此刻 Esc 归不归这一页（上面叠着安装页时给 false）
  escape?: boolean;
  /// 变了就滑回（装完：安装页滑回的同时这一页也滑回列表）
  leaveSignal?: number;
}

type Readme =
  | { status: "loading" }
  | { status: "ready"; text: string; pageUrl: string | null; path: string }
  | { status: "failed"; message: string }
  /// 没有地方可取（MCP 的主页不在 GitHub 上）
  | { status: "none" };

/// 取正文：推入时取一次；换了条目重取
function useReadme(load: (() => Promise<SkillReadme>) | null, key: string): Readme {
  const [readme, setReadme] = useState<Readme>(load ? { status: "loading" } : { status: "none" });
  const live = useRef(load);
  live.current = load;
  useEffect(() => {
    const fetch = live.current;
    if (!fetch) {
      setReadme({ status: "none" });
      return;
    }
    let alive = true;
    setReadme({ status: "loading" });
    fetch().then(
      (r) =>
        alive &&
        setReadme({ status: "ready", text: r.text, pageUrl: r.pageUrl || null, path: r.path }),
      (error: unknown) => {
        if (!alive) return;
        const text = errorText(error, "");
        setReadme({
          status: "failed",
          message: text === rateLimited() ? rateLimited() : t("market.error.intro"),
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return readme;
}

const open = (url: string) => void openUrl(url).catch(() => {});

export function IntroPage(props: IntroPageProps) {
  const { onClose } = props;
  const page = usePushedPage(onClose);
  // 装完：上面的安装页滑回时，这一页跟着一起滑回列表
  // 只认推入之后的变化：推入那一刻的值不算
  const leaveSignal = props.leaveSignal ?? 0;
  const leaveAtMount = useRef(leaveSignal);
  const { leave } = page;
  useEffect(() => {
    if (leaveSignal !== leaveAtMount.current) leave();
  }, [leaveSignal, leave]);
  // 菜单「返回」（⌘[）归这一页；⌘F 不落到被盖住的搜索框上
  usePageCommand("back", page.leave);
  usePageCommand("filter", () => {});
  useMenuFlag("back", !page.leaving);

  const installed = isInstalled(props.item);
  const placed = installedLine(props.item.installedIn);

  let load: (() => Promise<SkillReadme>) | null;
  let readmeKey: string;
  if (props.kind === "skill") {
    // 搜索结果没有路径：按 skills.sh 的 id（没有就用名字）找文件夹，取到的路径补进来历行
    const { repo, path, skillId, name } = props.item;
    load = () => api.marketSkillReadme(repo, null, path, skillId ?? name);
    readmeKey = `skill:${repo}:${path ?? ""}:${skillId ?? name}`;
  } else {
    // MCP：精选取仓库 README，官方目录取 Registry 给的仓库地址的 README；都没有就只留两行事实
    const { repository, homepage, id } = props.item;
    load = repository || homepage ? () => api.marketMcpReadme(repository, homepage ?? null) : null;
    readmeKey = `mcp:${id}`;
  }
  const readme = useReadme(load, readmeKey);

  // 仓库内路径：行上有就用行上的；搜索结果没有，取到正文后用后端找到的（仓库根为空串）
  const skillPath =
    props.kind === "skill"
      ? (props.item.path ?? (readme.status === "ready" && readme.path !== "" ? readme.path : null))
      : null;

  // 离开键的去处
  let leaveUrl: string | null;
  let leaveText: string;
  /// 离开键的悬停（MCP：包名；指向主页或源码仓库时是那个地址）
  let leaveTip: string | null = null;
  if (props.kind === "skill") {
    leaveUrl =
      readme.status === "ready" && readme.pageUrl
        ? readme.pageUrl
        : githubUrl(props.item.repo, skillPath);
    leaveText = t("market.leave.github");
  } else {
    // 与安装页同一条规则（mcpOrigin）：npm / PyPI 上的包指向包的说明页，其余指向主页；
    // 都没有才退到源码仓库（2026-09-27 真人测试 DMC-3）。离开键一律叫 `查看说明`（#276）
    const leave = mcpOrigin(props.item).leave;
    leaveUrl = leave?.url ?? props.item.repository ?? null;
    leaveText = t("market.leave.docs");
    leaveTip = leave?.tip ?? leaveUrl;
  }

  const action = installed ? (
    <InstalledMark />
  ) : (
    <Button
      variant="primary"
      onClick={() => {
        // 介绍页替搜索结果找到了路径：交给安装页时带上
        if (props.kind === "skill") props.onInstall?.({ ...props.item, path: skillPath });
        else props.onInstall?.(props.item);
      }}
    >
      {t("market.action.install")}
    </Button>
  );

  const origin =
    props.kind === "skill" ? (
      <>
        <SkillFrom repo={props.item.repo} path={skillPath} />
        <Dot />
        <span>{installsText(props.item.installs)}</span>
      </>
    ) : (
      <>
        <span>{props.item.publisher}</span>
        <Dot />
        <span>{mcpSourceLabel(props.item.source)}</span>
      </>
    );

  // 正文：skill 取不到要说；MCP 取不到只留两行事实（连 hairline 也不画）
  const showBody =
    props.kind === "skill" || readme.status === "loading" || readme.status === "ready";

  return (
    <PushedPage
      {...page}
      title={props.item.name}
      actions={action}
      escape={props.escape}
      host={() => document.querySelector(".face")}
      covers={() => document.querySelector(".face__scroll")}
    >
      <div className="intro">
        <div className="intro__origin">
          <span className="intro__facts-line">
            {origin}
            {/* 末尾的外链是这一行事实的最后一项：句后浅键，不垫底，与前面同样一个 · 隔开（2026-10-06） */}
            {leaveUrl ? (
              <>
                <Dot />
                <Tooltip content={leaveTip ? <Mono inherit>{leaveTip}</Mono> : null}>
                  <Button variant="quiet" inline onClick={() => open(leaveUrl)}>
                    {leaveText}
                  </Button>
                </Tooltip>
              </>
            ) : null}
          </span>
        </div>
        {placed ? <p className="intro__placed">{placed}</p> : null}
        {props.kind === "mcp" ? <McpFacts item={props.item} /> : null}
        {showBody ? (
          <>
            <div className="intro__rule" />
            <IntroBody
              readme={readme}
              leave={leaveUrl ? { label: leaveText, url: leaveUrl } : null}
            />
          </>
        ) : null}
      </div>
    </PushedPage>
  );
}

/// 来历行的 `来自 <作者>`：第一层只写作者，仓库与仓库内路径原样进悬停（#307）
function SkillFrom({ repo, path }: { repo: string; path: string | null }) {
  const { from, exact } = skillOrigin(repo, path);
  return (
    <Tooltip content={<Mono inherit>{exact}</Mono>} focusable>
      <span>{from}</span>
    </Tooltip>
  );
}

function Dot() {
  return (
    <span className="intro__dot" aria-hidden="true">
      ·
    </span>
  );
}

/// MCP 来历下的两行事实：`运行方式` 与 `要填的`（键 12 ink-faint 定宽 72，值 13）。
/// 运行方式只写 `本地运行` / `在线服务`，命令与地址进悬停（第二层，#276）
function McpFacts({ item }: { item: McpRow }) {
  const conn = mcpConnection(item.definition);
  const fields = mcpFieldFacts(item);
  return (
    <dl className="intro__facts">
      <div className="intro__fact">
        <dt>{t("market.intro.factConn")}</dt>
        <dd>
          <Tooltip content={conn.text ? <Mono inherit>{conn.text}</Mono> : null} focusable>
            <span>{conn.kind}</span>
          </Tooltip>
        </dd>
      </div>
      <div className="intro__fact">
        <dt>{t("market.install.blockFields")}</dt>
        <dd>
          {typeof fields === "string" ? (
            fields
          ) : (
            <span className="intro__fields">
              {fields.map((f) => (
                <span key={f.key} className="intro__field">
                  {/* 有说明用说明当名字、键名降成等宽小字；没有说明才写键名（#276） */}
                  {f.keyed ? <Mono inherit>{f.label}</Mono> : <span>{f.label}</span>}
                  {f.keyed ? null : <Mono>{f.key}</Mono>}
                  <Tag tone="weak">{f.note}</Tag>
                </span>
              ))}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

/// 正文区：自己滚、上下边缘渐隐（机面上从 face）
function IntroBody({
  readme,
  leave,
}: {
  readme: Readme;
  leave: { label: string; url: string } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(ref);
  let content;
  if (readme.status === "loading") {
    content = (
      <div className="intro__status">
        <BusySlot busy label={t("market.busy.readingIntro")}>
          <span />
        </BusySlot>
      </div>
    );
  } else if (readme.status === "ready") {
    const { body, description } = stripFrontmatter(readme.text);
    content = (
      <>
        {description ? <p className="intro__lede">{description}</p> : null}
        <MarkdownBody text={body} base={linkBase(readme.pageUrl)} onOpenLink={open} />
      </>
    );
  } else {
    const message = readme.status === "failed" ? readme.message : t("market.error.intro");
    content = (
      <div className="intro__status">
        <Note
          action={
            leave ? { label: leave.label, leave: true, onClick: () => open(leave.url) } : undefined
          }
        >
          {message}
        </Note>
      </div>
    );
  }
  return (
    <FadeViewport fade={fade} tone="face" className="intro__fade">
      <div ref={ref} className="intro__scroll">
        <div className="intro__read">{content}</div>
      </div>
    </FadeViewport>
  );
}

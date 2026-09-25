import type { CSSProperties, ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Spinner } from "./Spinner.tsx";
import scanning from "../assets/empty-scanning.png";
import noDirs from "../assets/empty-no-dirs.png";
import emptyFolder from "../assets/empty-folder.png";

/// 空态与忙碌态（DESIGN「空态与忙碌态」「转盘」）。
///
/// 空态里的动作都是默认键（表头下一句后的 `清除筛选` 给 `compact`，紧凑 24）；离开 Sophia 的
/// （`在访达中显示 ↗`）给 `leave`，画成浅键（末尾自动带 ↗）。
/// 动作已在页面头的（`+ 来源` `+ 网关`）空态里不重复。
/// 首次扫描（`busy`）：24 宽忙碌刻度居中 + 下面一句「忙什么」（还没有格子可亮，句子保留）。
///
/// 图像（DESIGN「图像」）：只用在没有数据、等待、刚开始的时刻；筛选无结果不放图。
/// 图在上、不带边框、底透明，直接落在机面上看不出方框；下面依次是现状一句、动作（间距 16 / 8 / 16），整体居中；图是装饰，
/// `alt=""` + `aria-hidden`。一种风格：品牌小黑猫配线稿文件夹，三张各对一个时刻（2x 资源，原样显示不裁切）。
/// 有图时首次扫描的忙碌指示跟在那句话前面

/// 空态图像，按时刻命名：
/// - `scanning` 扫描中：猫走在一排文件夹顶上（472×150）
/// - `noDirs` 没有 agent 目录：猫伸爪碰一个虚线文件夹——还不存在、添加时会建出来（250×110）
/// - `emptyFolder` 这里还没有东西：猫扒着空文件夹的沿往里看（250×110）
export type EmptyArt = "scanning" | "noDirs" | "emptyFolder";

const ART_SRC: Record<EmptyArt, string> = { scanning, noDirs, emptyFolder };

/// **已废弃，页面迁移后删**：旧的「哪种空」轴与 `art` 大量重合，只剩默认文案与要不要转圈两个作用——
/// 现在写 `description` 与 `busy`。暂留给还没迁完的页面，映射见 `KIND_DEFAULTS`
export type EmptyKind = "scanning" | "noAgentDirs" | "noMatch" | "noSkills";

const KIND_DEFAULTS: Record<EmptyKind, { description: string; busy: boolean }> = {
  scanning: { description: "正在读 skill 目录", busy: true },
  noAgentDirs: {
    description: "这个项目下还没有任何 agent 的 skill 目录。添加时会自动创建。",
    busy: false,
  },
  noMatch: { description: "没有匹配的 skill", busy: false },
  noSkills: { description: "这个来源里还没有 skill。", busy: false },
};

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /// 可选的图标。空态里文字是主角，图标只作陪
  icon?: ReactNode;
  /// 这一下会离开 Sophia（在访达中显示……）：画成浅键，末尾自动带 ↗；label 只写动词，不写 ↗
  leave?: boolean;
  /// 默认键紧凑 24（表头下一句后的 `清除筛选`）；浅键本来就是 24，不受它影响
  compact?: boolean;
}

export interface EmptyProps {
  /// 现状一句（要嵌路径、来源名时传节点）；`busy` 时它就是「忙什么」
  description?: ReactNode;
  /// 首次扫描中：句子前（有图时）或上（没图时 24 宽）出忙碌刻度
  busy?: boolean;
  /// **已废弃**：见 `EmptyKind`
  kind?: EmptyKind;
  /// 第二行次要说明
  hint?: ReactNode;
  /// 第一个动作（默认键；`leave` 时浅键）
  primary?: EmptyAction;
  /// 第二个动作（同上）
  secondary?: EmptyAction;
  /// 图在上（装饰）；不给就不放图
  art?: EmptyArt;
  /// 有图时：图的上沿按机面上沿量（DESIGN「位置页 › 空态」表：扫描中 190、没有 agent 目录 230、
  /// 来源里还没有 skill 270），这里给上面已被占掉的高度（px）。默认 50＝紧跟在页面头下；
  /// 落在表头下的给页面头 + 表头（+ 来源筛选）的高度，不再拿负外距去抵
  above?: number;
}

export function Empty({
  kind,
  description: given,
  busy: givenBusy,
  hint,
  primary,
  secondary,
  art,
  above,
}: EmptyProps) {
  const fallback = kind ? KIND_DEFAULTS[kind] : undefined;
  const description = given ?? fallback?.description;
  const busy = givenBusy ?? fallback?.busy ?? false;
  const busyLabel =
    typeof description === "string" ? description : KIND_DEFAULTS.scanning.description;
  const text = <div className="ss-empty__description">{description}</div>;
  const classes = ["ss-empty"];
  if (busy) classes.push("is-busy");
  if (art) classes.push("has-art");
  const style =
    art && above !== undefined ? ({ "--empty-above": `${above}px` } as CSSProperties) : undefined;
  return (
    <div className={classes.join(" ")} style={style}>
      {art ? (
        <img
          className={`ss-empty__art ss-empty__art--${art}`}
          src={ART_SRC[art]}
          alt=""
          aria-hidden="true"
        />
      ) : null}
      {busy && art ? (
        <div className="ss-empty__busy">
          <Spinner size={14} label={busyLabel} />
          {text}
        </div>
      ) : (
        <>
          {busy ? <Spinner size={24} label={busyLabel} /> : null}
          {text}
        </>
      )}
      {hint ? <div className="ss-empty__hint">{hint}</div> : null}
      {primary || secondary ? (
        <div className="ss-empty__actions">
          {primary ? <EmptyButton action={primary} /> : null}
          {secondary ? <EmptyButton action={secondary} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function EmptyButton({ action }: { action: EmptyAction }) {
  return (
    <Button
      variant={action.leave ? "quiet" : "default"}
      size={action.compact ? "compact" : "regular"}
      icon={action.icon}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}

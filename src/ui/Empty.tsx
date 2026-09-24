import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Spinner } from "./Spinner.tsx";
import scanning from "../assets/empty-scanning.png";
import noDirs from "../assets/empty-no-dirs.png";
import emptyFolder from "../assets/empty-folder.png";

/// 空态与忙碌态（DESIGN「空态与忙碌态」「转盘」）。
///
/// **空态里若有两个动作，只有一个是按钮**，另一个降为安静键。
/// 首次扫描：24px 忙碌指示居中 + 下面一句「忙什么」（还没有格子可亮，句子保留）。
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

export type EmptyKind =
  /// 首次扫描中：24px 忙碌指示 + 一句忙什么
  | "scanning"
  /// 这个域没有 agent 目录：agent 列照常显示，灯全为空心
  | "noAgentDirs"
  /// 筛选无结果：筛选行留在原位，一眼看出空是筛出来的
  | "noMatch"
  /// 一个 skill 都没有：先说清空的是哪个目录，再给补上的路
  | "noSkills";

const DEFAULT_DESCRIPTION: Record<EmptyKind, string> = {
  scanning: "正在读 skill 目录",
  noAgentDirs: "这个项目下还没有任何 agent 的 skill 目录。添加时会顺手建出来。",
  noMatch: "没有匹配的 skill",
  noSkills: "这个来源里还没有 skill。",
};

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /// 可选的图标。空态里文字是主角，图标只作陪
  icon?: ReactNode;
}

export interface EmptyProps {
  kind: EmptyKind;
  /// 覆盖默认说明。要嵌路径、来源名时传进来
  description?: ReactNode;
  /// 第二行次要说明
  hint?: ReactNode;
  /// 按钮动作，一个就够
  primary?: EmptyAction;
  /// 安静键动作
  secondary?: EmptyAction;
  /// 图在上（装饰）；不给就不放图
  art?: EmptyArt;
}

export function Empty({ kind, description, hint, primary, secondary, art }: EmptyProps) {
  const busyLabel = typeof description === "string" ? description : DEFAULT_DESCRIPTION.scanning;
  const text = (
    <div className="ss-empty__description">{description ?? DEFAULT_DESCRIPTION[kind]}</div>
  );
  return (
    <div className={`ss-empty ss-empty--${kind}${art ? " has-art" : ""}`} data-kind={kind}>
      {art ? (
        <img
          className={`ss-empty__art ss-empty__art--${art}`}
          src={ART_SRC[art]}
          alt=""
          aria-hidden="true"
        />
      ) : null}
      {kind === "scanning" && art ? (
        <div className="ss-empty__busy">
          <Spinner size={14} label={busyLabel} />
          {text}
        </div>
      ) : (
        <>
          {kind === "scanning" ? <Spinner size={24} label={busyLabel} /> : null}
          {text}
        </>
      )}
      {hint ? <div className="ss-empty__hint">{hint}</div> : null}
      {primary || secondary ? (
        <div className="ss-empty__actions">
          {primary ? (
            <Button icon={primary.icon} onClick={primary.onClick}>
              {primary.label}
            </Button>
          ) : null}
          {secondary ? (
            <Button variant="quiet" icon={secondary.icon} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

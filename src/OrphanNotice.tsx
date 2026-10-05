import { useRef } from "react";
import { t } from "./i18n.ts";
import { NoticePanel } from "./ui/index.ts";

/// 失效链接的常驻提示（2026-09-27 产品负责人：孤链散在表里没有提示；提示条能关掉就找不回入口）：
/// 当前范围里有原件已不在的失效链接时，表格上方一块灰面板：一句现状 + `只看这些` + `全部清除`。
/// **不能关**：它说的是眼下的问题，不是教一次就够的新手提示——让它消失的办法就是把链接清掉。
/// 与模型页「路由没在跑」同一种（2026-10-03 产品负责人，画板 HqfEseaJe9ti6mhk4wjLv4：不能关的提示全应用只有灰面板这一种；
/// 原来是落在机面上的一行灰字，与「内嵌就有底」的总规则冲突）。页面层组件：清除与筛选的状态归 SkillsTab

export interface OrphanNoticeProps {
  /// 原件已不在的 skill 个数（孤链行数）
  skills: number;
  /// 失效链接条数（一个 skill 在几个 agent 里各有一条）
  links: number;
  /// 表格此刻只列孤链行
  only: boolean;
  onToggleOnly: () => void;
  /// `at`：被按下的键（结果浮在它下面）
  onClearAll: (at: HTMLElement | null) => void;
}

export function OrphanNotice({ skills, links, only, onToggleOnly, onClearAll }: OrphanNoticeProps) {
  const box = useRef<HTMLDivElement>(null);
  /// `全部清除` 是面板里最后一颗键：结果锚在它下面
  const clearKey = () => {
    const keys = box.current?.querySelectorAll("button");
    return keys && keys.length > 0 ? keys[keys.length - 1] : null;
  };
  return (
    <div ref={box} className="mx-orphan-notice" role="status">
      <NoticePanel
        scope="section"
        message={t("skills.orphan.notice", { skills, links })}
        action={{
          label: only ? t("skills.orphan.showAll") : t("skills.orphan.onlyThese"),
          onClick: onToggleOnly,
        }}
        secondary={{ label: t("skills.orphan.clearAll"), onClick: () => onClearAll(clearKey()) }}
      />
    </div>
  );
}

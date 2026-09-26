/// 失效链接的常驻一句（2026-09-27 产品负责人：孤链散在表里没有提示；提示条能关掉就找不回入口）：
/// 当前范围里有原件已不在的失效链接时，表格上方写一句现状 + `只看这些` + `全部清除`。
/// **不能关**：它说的是眼下的问题，不是教一次就够的新手提示——让它消失的办法就是把链接清掉。
/// 灰字一行、两颗紧凑键，不画框（比新手提示条轻）。页面层组件：清除与筛选的状态归 SkillsTab
import { useRef } from "react";
import { Button } from "./ui/index.ts";

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
  const clearRef = useRef<HTMLSpanElement>(null);
  return (
    <p className="mx-orphans" role="status">
      <span className="mx-orphans__text">{`${skills} 个 skill 的原件已经不在了，留下 ${links} 条失效链接`}</span>
      <Button size="compact" onClick={onToggleOnly}>
        {only ? "显示全部" : "只看这些"}
      </Button>
      <span ref={clearRef} className="mx-orphans__key">
        <Button
          size="compact"
          onClick={() => onClearAll(clearRef.current?.querySelector("button") ?? null)}
        >
          全部清除
        </Button>
      </span>
    </p>
  );
}

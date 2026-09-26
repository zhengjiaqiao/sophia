import {
  AgentIcon,
  Cap,
  IconArrowLeft,
  IconAttention,
  IconCannot,
  IconChevronDown,
  IconClose,
  IconDash,
  IconEdit,
  IconLeave,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSortArrow,
  IconTick,
  IconTrash,
  Mono,
} from "../index.ts";
import type { ReactNode } from "react";
import { Block, Family, Specimen } from "./Gallery.tsx";

const ICONS: Array<[string, ReactNode]> = [
  ["IconSettings 设置", <IconSettings />],
  ["IconEdit 编辑", <IconEdit />],
  ["IconTrash 删掉", <IconTrash />],
  ["IconPlus 添加", <IconPlus />],
  ["IconClose 关掉", <IconClose />],
  ["IconArrowLeft 返回", <IconArrowLeft />],
  ["IconSearch 搜索", <IconSearch />],
  ["IconCannot 做不成", <IconCannot />],
  ["IconAttention 要你注意", <IconAttention />],
];

const MARKS: Array<[string, ReactNode]> = [
  ["IconTick 对勾", <IconTick />],
  ["IconChevronDown ˅", <IconChevronDown />],
  ["IconLeave ↗", <IconLeave />],
  ["IconSortArrow ↑", <IconSortArrow />],
  ["IconSortArrow ↓", <IconSortArrow desc />],
  ["IconDash 半选", <IconDash />],
];

const AGENTS: Array<[string, string]> = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["gemini-cli", "Gemini CLI"],
  ["windsurf", "Windsurf"],
];

/// 图标与排版原语
export function PrimitivesFamily() {
  return (
    <Family
      id="primitives"
      title="图标与排版原语"
      lead="词表里的图标一律 16 画布、1.4 描边、currentColor；小记号固定 10；agent 图标单色；大写只经 Cap；id 与路径只用等宽。"
    >
      <Block
        name="icons · 词表"
        guide="用户在别的软件里见过同一个图形做同一件事才用图标；词表外写字"
      >
        {ICONS.map(([label, icon]) => (
          <Specimen key={label} label={label}>
            {icon}
          </Specimen>
        ))}
        <Specimen label="同一枚按比例缩：+ 12 / × 12 / × 9">
          <span className="gallery-row">
            <IconPlus size={12} />
            <IconClose size={12} />
            <IconClose size={9} />
          </span>
        </Specimen>
      </Block>

      <Block
        name="icons · 小记号"
        guide="固定 10px 的状态与方向记号（对勾、展开、离开、排序、半选）"
      >
        {MARKS.map(([label, icon]) => (
          <Specimen key={label} label={label}>
            {icon}
          </Specimen>
        ))}
      </Block>

      <Block
        name="AgentIcon"
        guide="agent 身份的图形；取不到时降级成首字母方块，永远和名字一起出现"
      >
        {AGENTS.map(([id, name]) => (
          <Specimen key={id} label={`${name} · 16 / 24`}>
            <span className="gallery-row">
              <AgentIcon id={id} name={name} />
              <AgentIcon id={id} name={name} size={24} />
            </span>
          </Specimen>
        ))}
      </Block>

      <Block
        name="Cap"
        guide="纯拉丁结构词的大写（页签、区块小标、列头 agent 名）；汉字 run 原样、字距 0"
      >
        <Specimen label="nav · 页签">
          <span className="gallery-nav">
            <Cap tone="nav">skills</Cap>
          </span>
        </Specimen>
        <Specimen label="label · 区块小标">
          <span className="gallery-label">
            <Cap>agent</Cap>
          </span>
        </Specimen>
        <Specimen label="混排：只有拉丁 run 大写">
          <span className="gallery-label">
            <Cap>Claude Code 用户</Cap>
          </span>
        </Specimen>
      </Block>

      <Block name="Mono" guide="id、路径、版本号：等宽 12、可拖选、主目录写成 ~">
        <Specimen label="路径（任意处折行）" width={260}>
          <Mono path>
            /Users/me/Library/Application Support/WeiboAP/agent_1776847465710_a/skills
          </Mono>
        </Specimen>
        <Specimen label="句子里（inherit）">
          <span className="gallery-sentence">
            已写进{" "}
            <Mono inherit path>
              /Users/me/code/CardBox/.mcp.json
            </Mono>
          </span>
        </Specimen>
        <Specimen label="只能截断的一行" width={160}>
          <Mono truncate>anthropic/claude-opus-4-6</Mono>
        </Specimen>
      </Block>
    </Family>
  );
}

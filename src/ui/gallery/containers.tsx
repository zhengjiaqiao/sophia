import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AddButton,
  AgentIcon,
  Button,
  Cap,
  Checkbox,
  Chip,
  ChipRow,
  Drawer,
  DrawerHandle,
  Empty,
  FadeViewport,
  IconButton,
  IconEdit,
  IconTrash,
  ListRow,
  ModelChip,
  Note,
  PushedPage,
  Section,
  SectionLabel,
  Switch,
  Tag,
  useEdgeFades,
  usePushedPage,
} from "../index.ts";
import { Block, Family, Specimen } from "./Gallery.tsx";

const noop = () => {};

const SKILLS = [
  "brainstorming",
  "codebase-to-course",
  "data-analysis",
  "defuddle",
  "design-taste-frontend",
  "frontend-design",
  "obsidian-cli",
  "pdf",
  "skill-creator",
  "typesafe-ai",
  "xlsx",
];

/// 容器与层：推入页、能力节、区块小标、胶囊行、列表行、抽屉、滚动渐隐、空态、灰字一句
export function ContainersFamily() {
  return (
    <Family
      id="containers"
      title="容器与层"
      lead="推入页在机面里推一页；节是 agent 页的一种能力；区块小标给一组内容起头；列表行下挂抽屉；空态说现状和下一步，灰字一句只说一句。"
    >
      <Block
        name="PushedPage"
        guide="有起止的多步任务在机面里推入一页（来源管理、添加来源）｜ 能就地拉开完成的用抽屉"
      >
        <Specimen label="推入（只替换机面，←、Esc 返回）" frame="stage" width={720} height={260}>
          <PushedDemo />
        </Specimen>
      </Block>

      <Block
        name="Section"
        guide="agent 页里一种能力一节：节名 + 开关 + 条件键｜ 一组内容的小标题用 SectionLabel"
      >
        <Specimen label="节头 · 开关开着 · 待生效" width={640}>
          <Section
            title="第三方模型"
            control={<Switch checked onChange={noop} label="第三方模型" />}
            actions={
              <Button size="compact" onClick={noop}>
                重启生效
              </Button>
            }
          >
            <div className="gallery-note">节内容</div>
          </Section>
        </Specimen>
      </Block>

      <Block
        name="SectionLabel"
        guide="区块小标：Condensed 12 / 600 ink-mute，可选下 7 hairline、右端一颗键｜ 不是节标题、不是表格列头"
      >
        <Specimen label="只有字（设置 · 关于）" width={360}>
          <SectionLabel>关于</SectionLabel>
        </Specimen>
        <Specimen label="下线（列表里的 agent）" width={360}>
          <SectionLabel rule>列表里的 agent · 最多 4 个</SectionLabel>
        </Specimen>
        <Specimen label="下线 + 右端键（网关）" width={480}>
          <SectionLabel rule action={<AddButton noun="网关" onClick={noop} />}>
            网关
          </SectionLabel>
        </Specimen>
        <Specimen label="拉丁结构词经 Cap（侧栏）" width={180}>
          <SectionLabel action={<span className="gallery-sort">最近活跃</span>}>
            <Cap>agent</Cap>
          </SectionLabel>
        </Specimen>
      </Block>

      <Block name="ChipRow" guide="行首标签 + 一排折行的胶囊（来源筛选、在用的模型）">
        <Specimen label="来源筛选" width={560}>
          <ChipRow label="来源">
            <Chip selected onClick={noop}>
              全部
            </Chip>
            <Chip count={11} onClick={noop}>
              通用仓库
            </Chip>
            <Chip count={7} onClick={noop}>
              WeiboAP
            </Chip>
            <Chip count={1} onClick={noop}>
              ego lite
            </Chip>
          </ChipRow>
        </Specimen>
        <Specimen label="在用 · 折行" width={420}>
          <ChipRow label="在用" listLabel="在用的模型">
            <ModelChip name="Kimi K2" id="moonshotai/kimi-k2" onRemove={noop} />
            <ModelChip name="GLM-4.6" suffix="openrouter" id="z-ai/glm-4.6" onRemove={noop} />
            <ModelChip name="DeepSeek V3.2" id="deepseek/deepseek-v3.2" onRemove={noop} />
            <ModelChip name="GLM-4.6" suffix="zhipu" id="glm-4.6" onRemove={noop} />
          </ChipRow>
        </Specimen>
      </Block>

      <Block
        name="ListRow"
        guide="两行列表行，整行可点、下挂抽屉（网关、添加来源候选）｜ 表格行不是它"
      >
        <Specimen label="网关行：收起 · 拉开 · 无法连接（错误）" width={640}>
          <GatewayRows />
        </Specimen>
        <Specimen label="网关行 · 悬停（整行可点）" force="hover" width={640}>
          <div className="gallery-list">
            <ListRow
              title="siliconflow"
              sub="api.siliconflow.cn/v1 · 已连接 · 已选 0 / 88"
              actions={<IconButton icon={<IconEdit />} title="编辑" onClick={noop} />}
              onToggle={noop}
              drawerLabel="siliconflow 的模型"
              drawer={<div className="gallery-note">模型列表</div>}
            />
          </div>
        </Specimen>
        <Specimen label="候选行：勾选格 + 拉手悬停才出" width={640}>
          <CandidateRows />
        </Specimen>
      </Block>

      <Block
        name="Drawer · DrawerHandle"
        guide="一行的次要详情就地拉开（MCP 行详情）｜ 要离开当前上下文的流程用推入页"
      >
        <Specimen label="拉手：收起 ›、拉开 ˅、常显" width={360}>
          <DrawerDemo />
        </Specimen>
      </Block>

      <Block
        name="FadeViewport · useEdgeFades"
        guide="可滚动区域被裁掉的那一边 16px 渐隐（机面从 face、浮层从 paper）"
      >
        <Specimen label="滚到中间：上下都渐隐" width={240}>
          <FadeDemo />
        </Specimen>
      </Block>

      <Block name="Empty" guide="一块区域完全没有内容时说现状和下一步｜ 筛选无结果用 Note">
        <Specimen label="首次扫描（忙碌）" width={560}>
          <Empty busy description="正在读 skill 目录" art="scanning" />
        </Specimen>
        <Specimen label="没有 agent 目录" width={560}>
          <Empty
            description="CardBox 下还没有 agent 的 skill 目录"
            hint="加上第一个 skill 时会自动创建"
            art="noDirs"
          />
        </Specimen>
        <Specimen label="来源里还没有 skill · 离开的动作" width={560}>
          <Empty
            description="WeiboAP 里还没有 skill"
            art="emptyFolder"
            secondary={{ label: "在访达中显示", onClick: noop, leave: true }}
          />
        </Specimen>
      </Block>

      <Block
        name="Note"
        guide="一句 13 灰字，可带一颗紧凑键（筛选无结果、还没有网关）｜ 整块空了用 Empty"
      >
        <Specimen label="带键">
          <Note action={{ label: "清除筛选", onClick: noop }}>
            没有名字里带「defuddle」的 skill
          </Note>
        </Specimen>
        <Specimen label="只有一句">
          <Note>还没有网关，先加一家</Note>
        </Specimen>
        <Specimen label="离开的浅键">
          <Note action={{ label: "去发布页", onClick: noop, leave: true }}>下载没成</Note>
        </Specimen>
      </Block>
    </Family>
  );
}

function PushedDemo() {
  const [key, setKey] = useState(0);
  const page = usePushedPage(() => setKey((k) => k + 1));
  return (
    <PushedPage
      key={key}
      {...page}
      title="CardBox 的来源"
      actions={<AddButton noun="来源" onClick={noop} />}
    >
      <div className="gallery-note">来源 ｜ 位置 ｜ 以后新出现的自动加到（内容由页面给）</div>
    </PushedPage>
  );
}

function GatewayRows() {
  const [open, setOpen] = useState<Set<string>>(new Set(["zhipu"]));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const tools = (
    <>
      <IconButton icon={<IconEdit />} title="编辑" onClick={noop} />
      <IconButton icon={<IconTrash />} title="删掉" onClick={noop} />
    </>
  );
  const row = (id: string, sub: ReactNode, extra?: ReactNode) => (
    <ListRow
      key={id}
      title={id}
      sub={sub}
      actions={
        <>
          {extra}
          {tools}
        </>
      }
      open={open.has(id)}
      onToggle={() => toggle(id)}
      drawerLabel={`${id} 的模型`}
      drawer={<div className="gallery-note">限制说明与模型勾选列表</div>}
    />
  );
  return (
    <div className="gallery-list">
      {row("openrouter", "openrouter.ai/api/v1 · 已连接 · 已选 3 / 103")}
      {row("zhipu", "api.zhipu.example.com/v1 · 已连接 · 已选 1 / 12")}
      {row(
        "deepseek",
        <span>
          api.deepseek.com · <b className="gallery-strong">无法连接</b> · 连接超时：30 秒没有回应
        </span>,
        <Button size="compact" onClick={noop}>
          再试一次
        </Button>,
      )}
    </div>
  );
}

function CandidateRows() {
  const [checked, setChecked] = useState<Set<string>>(new Set(["WeiboAP"]));
  const [open, setOpen] = useState<string | null>(null);
  const row = (name: string, sub: string, items: string[]) => (
    <ListRow
      key={name}
      title={name}
      sub={sub}
      check={
        <Checkbox
          checked={checked.has(name)}
          label={name}
          onChange={(next) =>
            setChecked((prev) => {
              const s = new Set(prev);
              if (next) s.add(name);
              else s.delete(name);
              return s;
            })
          }
        />
      }
      open={open === name}
      onToggle={() => setOpen(open === name ? null : name)}
      drawerLabel={`${name} 里的 skill`}
      drawer={
        <span className="gallery-items">
          {items.map((item) => (
            <span key={item} className="gallery-item">
              {item}
              {item === "brainstorming" ? <Tag tone="weak">同名</Tag> : null}
            </span>
          ))}
        </span>
      }
    />
  );
  return (
    <div className="gallery-list">
      {row("WeiboAP", "~/Library/Application Support/WeiboAP · 8 个 skill · weibo-ppt、defuddle", [
        "weibo-ppt",
        "weibo-assistant",
        "defuddle",
        "notion",
      ])}
      {row("superpowers", "检测到的 · 6 个 skill · brainstorming、writing-plans", [
        "brainstorming",
        "writing-plans",
        "skill-creator",
      ])}
    </div>
  );
}

function DrawerDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="gallery-list">
      <div className="gallery-drawerrow" data-drawer-row="">
        <DrawerHandle open={open} onToggle={() => setOpen(!open)} label="context7 的详情" always />
        <span>context7</span>
      </div>
      <Drawer open={open} inset={24}>
        <div className="gallery-note">传输 stdio · 命令 npx -y @upstash/context7-mcp</div>
      </Drawer>
      <div className="gallery-drawerrow" data-drawer-row="">
        <DrawerHandle open={false} onToggle={noop} label="notion 的详情" always />
        <span>notion</span>
      </div>
    </div>
  );
}

function FadeDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(ref);
  return (
    <FadeViewport fade={fade} tone="face" className="gallery-fade">
      <div
        ref={(el) => {
          ref.current = el;
          // 样张一打开就停在中间：上下都还有内容
          if (el && el.scrollTop === 0) el.scrollTop = 60;
        }}
        className="gallery-fade__scroll"
      >
        {SKILLS.map((name) => (
          <div key={name} className="gallery-fade__item">
            <AgentIcon id="claude-code" name="Claude Code" size={14} />
            {name}
          </div>
        ))}
      </div>
    </FadeViewport>
  );
}

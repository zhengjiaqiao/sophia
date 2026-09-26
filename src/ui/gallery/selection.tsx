import { useState } from "react";
import {
  AgentIcon,
  CheckMark,
  CheckRow,
  Checkbox,
  Chip,
  FloatingLayer,
  IconChevronDown,
  Menu,
  MenuItem,
  ModelChip,
  Mono,
  Switch,
  Tabs,
} from "../index.ts";
import { Block, Family, Specimen } from "./Gallery.tsx";

const noop = () => {};

/// 选择：开关 / 勾选 / 页签 / 筛选片 / 模型片 / 菜单
export function SelectionFamily() {
  const [tab, setTab] = useState<"skills" | "mcp">("skills");
  const [on, setOn] = useState(true);
  return (
    <Family
      id="selection"
      title="选择"
      lead="开关＝它开着（当场生效）；勾选框＝我选了哪些；页签换视图；筛选片缩小范围；菜单是浮层里的一组选项。"
    >
      <Block
        name="Switch"
        guide="当场生效的布尔状态（第三方模型、自动加到）｜ 选择项目、要提交的设置不用它"
      >
        <Specimen label="开">
          <Switch checked={on} onChange={setOn} label="第三方模型" />
        </Specimen>
        <Specimen label="关">
          <Switch checked={false} onChange={noop} label="第三方模型" />
        </Specimen>
        <Specimen label="悬停" force="hover">
          <Switch checked onChange={noop} label="第三方模型" />
        </Specimen>
        <Specimen label="按下" force="active">
          <Switch checked={false} onChange={noop} label="第三方模型" />
        </Specimen>
        <Specimen label="禁用 · 正在处理上一步">
          <Switch checked onChange={noop} label="第三方模型" disabledReason="正在处理上一步" />
        </Specimen>
        <Specimen label="compact · 以后新出现的自动加到">
          <Switch size="compact" checked onChange={noop} label="以后新出现的自动加到" />
        </Specimen>
      </Block>

      <Block name="Checkbox" guide="多选里的一项（表格行首、全选）｜ 当场生效的开关不用它">
        <Specimen label="未勾">
          <Checkbox checked={false} onChange={noop} label="brainstorming" />
        </Specimen>
        <Specimen label="手靠近" force="hover">
          <Checkbox checked={false} onChange={noop} label="brainstorming" />
        </Specimen>
        <Specimen label="勾上">
          <Checkbox checked onChange={noop} label="brainstorming" />
        </Specimen>
        <Specimen label="半选">
          <Checkbox checked="mixed" onChange={noop} label="全选" />
        </Specimen>
        <Specimen label="不可选 · 已经在来源里">
          <Checkbox checked={false} label="defuddle" disabledReason="已经在来源里" />
        </Specimen>
        <Specimen label="CheckMark（只画状态）">
          <span className="gallery-row">
            <CheckMark on={false} />
            <CheckMark on />
            <CheckMark on="mixed" />
          </span>
        </Specimen>
      </Block>

      <Block
        name="CheckRow"
        guide="整行可点的勾选项（设置的 agent 列表、网关里的模型列表）｜ 浮层里的多选用 MenuItem check"
      >
        <Specimen label="grid · 勾上" width={240}>
          <CheckRow
            size="grid"
            checked
            onChange={noop}
            icon={<AgentIcon id="claude-code" name="Claude Code" />}
          >
            Claude Code
          </CheckRow>
        </Specimen>
        <Specimen label="grid · 悬停" force="hover" width={240}>
          <CheckRow
            size="grid"
            checked={false}
            onChange={noop}
            icon={<AgentIcon id="cursor" name="Cursor" />}
          >
            Cursor
          </CheckRow>
        </Specimen>
        <Specimen label="grid · 不可选 · 满了" width={240}>
          <CheckRow
            size="grid"
            checked={false}
            onChange={noop}
            icon={<AgentIcon id="gemini-cli" name="Gemini CLI" />}
            disabledReason="最多显示 4 个，先取消一个"
          >
            Gemini CLI
          </CheckRow>
        </Specimen>
        <Specimen label="list · 行尾 id" width={360}>
          <CheckRow checked onChange={noop} trailing={<Mono truncate>moonshotai/kimi-k2</Mono>}>
            Kimi K2
          </CheckRow>
        </Specimen>
        <Specimen label="list · 被点名（取消后浮起提示那一会儿）" width={360}>
          <CheckRow checked={false} onChange={noop} highlighted>
            GPT-4.1
          </CheckRow>
        </Specimen>
      </Block>

      <Block name="Tabs" guide="换一张表 / 一个视图（SKILLS ｜ MCP）｜ 页内筛选用筛选片">
        <Specimen label="选中 SKILLS">
          <Tabs
            items={[
              { id: "skills", label: "skills" },
              { id: "mcp", label: "mcp" },
            ]}
            value={tab}
            onChange={setTab}
            label="功能"
          />
        </Specimen>
        <Specimen label="悬停未选中那一格" force="hover">
          <Tabs
            items={[
              { id: "skills", label: "skills" },
              { id: "mcp", label: "mcp" },
            ]}
            value="skills"
            onChange={noop}
            label="功能"
          />
        </Specimen>
      </Block>

      <Block name="Chip" guide="单选筛选里的一项，缩小表格范围（来源筛选）｜ 已选的值用模型片">
        <Specimen label="选中 · 全部">
          <Chip selected onClick={noop}>
            全部
          </Chip>
        </Specimen>
        <Specimen label="静止 · 带计数">
          <Chip count={11} onClick={noop}>
            通用仓库
          </Chip>
        </Specimen>
        <Specimen label="悬停" force="hover">
          <Chip count={7} onClick={noop}>
            WeiboAP
          </Chip>
        </Specimen>
        <Specimen label="选中 · 带计数">
          <Chip selected count={7} onClick={noop}>
            WeiboAP
          </Chip>
        </Specimen>
        <Specimen label="不可选">
          <Chip disabled disabledReason="这个来源在 CardBox 里没有 skill">
            ego lite
          </Chip>
        </Specimen>
      </Block>

      <Block name="ModelChip" guide="已选、可移除的值（在用的模型）｜ 筛选用筛选片">
        <Specimen label="静止">
          <ModelChip name="Kimi K2" id="moonshotai/kimi-k2" onRemove={noop} />
        </Specimen>
        <Specimen label="两家网关同名 · 带网关后缀">
          <ModelChip name="GLM-4.6" suffix="openrouter" id="z-ai/glm-4.6" onRemove={noop} />
        </Specimen>
        <Specimen label="× 悬停" force="hover">
          <ModelChip name="DeepSeek V3.2" id="deepseek/deepseek-v3.2" onRemove={noop} />
        </Specimen>
        <Specimen label="不可移除">
          <ModelChip name="GPT-4.1" id="openai/gpt-4.1" />
        </Specimen>
      </Block>

      <Block
        name="Menu · MenuItem"
        guide="浮层里的一组选项：普通 / 单选打勾 / 多选勾选，项高 30、13 号字｜ 页面上常驻的列表用 CheckRow / ListRow"
      >
        <Specimen label="单选（项目排序）">
          <div className="gallery-layer">
            <Menu label="项目排序">
              <MenuItem kind="radio" checked>
                最近活跃
              </MenuItem>
              <MenuItem kind="radio">名称</MenuItem>
            </Menu>
          </div>
        </Specimen>
        <Specimen label="多选 · 一项悬停 · 一项点不了" force="hover">
          <div className="gallery-layer">
            <Menu label="目标 agent" maxWidth={280}>
              <MenuItem
                kind="check"
                checked
                icon={<AgentIcon id="claude-code" name="Claude Code" size={14} />}
              >
                Claude Code
              </MenuItem>
              <MenuItem kind="check" icon={<AgentIcon id="codex" name="Codex" size={14} />}>
                Codex
              </MenuItem>
              <MenuItem
                kind="check"
                icon={<AgentIcon id="cursor" name="Cursor" size={14} />}
                disabledReason="Cursor 不支持用命令生成请求头"
              >
                Cursor
              </MenuItem>
            </Menu>
          </div>
        </Specimen>
        <Specimen label="普通 · 带副行与标题（MCP 同名挑选）">
          <div className="gallery-layer">
            <Menu title="notion 有 2 份，写进哪一份？">
              <MenuItem sub="与另一份差在 url">Claude Code · Project MCPs</MenuItem>
              <MenuItem sub="与另一份差在 url">Codex · User MCPs</MenuItem>
            </Menu>
          </div>
        </Specimen>
        <Specimen label="面板里（托盘）" width={320}>
          <Menu context="panel" label="Sophia">
            <MenuItem>打开 Sophia</MenuItem>
            <MenuItem>退出</MenuItem>
          </Menu>
        </Specimen>
        <Specimen label="放进 FloatingLayer（锚在触发键上）" frame="stage" width={260} height={150}>
          <LayerDemo />
        </Specimen>
      </Block>
    </Family>
  );
}

/// 浮层真的锚在一颗键上：点外面、Esc、滚动都关；再点键打开
function LayerDemo() {
  const [open, setOpen] = useState(true);
  const [sort, setSort] = useState("recent");
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const pick = (next: string) => {
    setSort(next);
    setOpen(false);
  };
  return (
    <span className="gallery-row">
      <button
        ref={setButton}
        type="button"
        className="gallery-sort"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {sort === "recent" ? "最近活跃" : "名称"}
        <IconChevronDown />
      </button>
      {open && button ? (
        <FloatingLayer trigger={button} onClose={() => setOpen(false)} label="项目排序">
          <Menu>
            <MenuItem kind="radio" checked={sort === "recent"} onSelect={() => pick("recent")}>
              最近活跃
            </MenuItem>
            <MenuItem kind="radio" checked={sort === "name"} onSelect={() => pick("name")}>
              名称
            </MenuItem>
          </Menu>
        </FloatingLayer>
      ) : null}
    </span>
  );
}

import { DOT_LABEL, Indicator, StateDot, StateDotButton, Tag } from "../index.ts";
import type { Dot } from "../index.ts";
import { Block, Family, Specimen } from "./Gallery.tsx";

const DOTS: Dot[] = ["linked", "missing", "own", "none", "broken", "blocked", "wholeLinked"];

/// 状态记号：格子记号、标识、指示点
export function MarksFamily() {
  return (
    <Family
      id="marks"
      title="状态记号"
      lead="格子记号说「这个 agent 能不能用它」；标识是名字后不可点的纯文字；指示点只说「开着」，只在看不到开关的地方。"
    >
      <Block name="StateDot" guide="格子里能不能用、原件 / 链接（● ⦿ ○ ⊘）｜ 开没开用指示点">
        {DOTS.map((dot) => (
          <Specimen key={dot} label={`${dot} · ${DOT_LABEL[dot]}`}>
            <StateDot dot={dot} />
          </Specimen>
        ))}
        <Specimen label="可点（StateDotButton）· 悬停出光晕" force="hover">
          <StateDotButton aria-label="brainstorming · Codex：未加上">
            <StateDot dot="missing" hoverable title="" />
          </StateDotButton>
        </Specimen>
        <Specimen label="可点 · 键盘焦点" force="focus">
          <StateDotButton aria-label="brainstorming · Codex：已加上">
            <StateDot dot="linked" hoverable title="" />
          </StateDotButton>
        </Specimen>
        <Specimen label="surface 底上（选择行）· 光晕换 track" force="hover">
          <span className="gallery-surface">
            <StateDotButton aria-label="选中的都加到 Codex">
              <StateDot dot="missing" hoverable onSurface title="" />
            </StateDotButton>
          </span>
        </Specimen>
        <Specimen label="禁用（已选的都是原件）">
          <StateDot dot="own" muted />
        </Specimen>
      </Block>

      <Block name="Tag" guide="名字后的不可点纯文字标识（同名、Codex 不支持、×2）｜ 能点的动作用键">
        <Specimen label="strong">
          <Tag>同名</Tag>
        </Specimen>
        <Specimen label="weak · 带提示框">
          <Tag tone="weak" tip="notion 在 Claude Code 与 Codex 里的配置不一样">
            2 份不一样
          </Tag>
        </Specimen>
        <Specimen label="weak">
          <Tag tone="weak">Codex 不支持</Tag>
        </Specimen>
        <Specimen label="count ×2（同名）">
          <span className="gallery-row">
            defuddle{" "}
            <Tag tone="count" label="同名：有 2 份">
              ×2
            </Tag>
          </span>
        </Specimen>
      </Block>

      <Block
        name="Indicator"
        guide="开着 / 在生效，只在看不到开关的地方（侧栏 Codex 后）｜ 别的颜色含义不用橙"
      >
        <Specimen label="开着">
          <span className="gallery-row">
            Codex <Indicator label="有能力开着、在生效" />
          </span>
        </Specimen>
      </Block>
    </Family>
  );
}

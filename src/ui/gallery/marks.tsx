import { DOT_LABEL, DupMark, Indicator, StateDot, Tag } from "../index.ts";
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
        <Specimen label="可点 · 悬停出光晕" force="hover">
          <button type="button" className="ss-dot-btn">
            <StateDot dot="missing" hoverable title="" />
          </button>
        </Specimen>
        <Specimen label="可点 · 键盘焦点" force="focus">
          <button type="button" className="ss-dot-btn">
            <StateDot dot="linked" hoverable title="" />
          </button>
        </Specimen>
        <Specimen label="禁用（已选的都是原件）">
          <StateDot dot="own" muted />
        </Specimen>
      </Block>

      <Block
        name="Tag · DupMark"
        guide="名字后的不可点纯文字标识（同名、Codex 不支持、×2）｜ 能点的动作用键"
      >
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
        <Specimen label="DupMark ×2">
          <span className="gallery-row">
            defuddle <DupMark />
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

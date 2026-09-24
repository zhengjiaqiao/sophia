import type { ReactNode } from "react";

/// agent 图标（DESIGN「agent 图标 AgentMark」，画板 Marks「agent 图标」）。
///
/// 一律单色 inline SVG，`currentColor` 取色：常态主文字色，未启用 / 禁用退到弱文字色。
/// **不用品牌色**。实现时用各项目官方 SVG 转单色，不手画；**所有出现处走这一个定义**。
///
/// - Claude Code：放射星形。光学补偿——放射实线比同尺寸线性图标重，描边降到 1.2、视觉小 1px
/// - Codex：OpenAI 绳结（simple-icons 官方 path，单色填充）。识别特征是中心六边形空洞 +
///   六段逐段旋转 60° 的交织；第一版六瓣软轮廓在 16px 下读成云 / 齿轮，已换
/// - Cursor：立方体线稿；Gemini CLI：实心四角星
///
/// 其余降级成**首字母方块**（14px、4 圆角、1px `ctl-border` 边、11/600）。它是图标缺席时的占位，
/// **永远和名字一起出现**：已安装的 9 个里首字母就撞了 3 个 C、2 个 G。

const OPENAI_KNOT =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

type Drawn = { kind: "stroke" | "fill"; viewBox: string; body: ReactNode; star?: boolean };

const ICONS: Record<string, Drawn> = {
  "claude-code": {
    kind: "stroke",
    viewBox: "0 0 16 16",
    star: true,
    body: <path d="M8 1.3v13.4M4.3 13.1L11.7 2.9M2.5 9.8l11-3.6M2.5 6.2l11 3.6M4.3 2.9l7.4 10.2" />,
  },
  codex: { kind: "fill", viewBox: "0 0 24 24", body: <path d={OPENAI_KNOT} /> },
  cursor: {
    kind: "stroke",
    viewBox: "0 0 16 16",
    body: (
      <>
        <path d="M8 1.6l5.5 3.2v6.4L8 14.4 2.5 11.2V4.8Z" />
        <path d="M8 8v6.4M8 8l5.5-3.2M8 8L2.5 4.8" />
      </>
    ),
  },
  "gemini-cli": {
    kind: "fill",
    viewBox: "0 0 16 16",
    body: (
      <path d="M8 1.1C8.5 5.1 10.9 7.5 14.9 8C10.9 8.5 8.5 10.9 8 14.9C7.5 10.9 5.1 8.5 1.1 8C5.1 7.5 7.5 5.1 8 1.1Z" />
    ),
  },
};

/// 这个 agent 有没有画得出的图标
export function hasAgentIcon(id: string): boolean {
  return id in ICONS;
}

/// 名字的首字母，取不到就用问号占位
export function agentInitial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export interface AgentIconProps {
  id: string;
  /// 降级成首字母方块时要用它的首字母；读屏名也是它
  name: string;
  /// 格子尺寸（默认 16；图标键 14、模型页 24）。Claude 星形在格子里小 1px 居中
  size?: number;
  /// 旁边**没有**名字时给 true：图标自己带 `title` 与 `aria-label`（提示条里的图标组）
  labelled?: boolean;
}

/// 只有图标本身。旁边有名字时读屏跳过它（名字已说）；没有名字时给 `labelled`
export function AgentIcon({ id, name, size = 16, labelled }: AgentIconProps) {
  const a11y = labelled
    ? { role: "img" as const, "aria-label": name }
    : { "aria-hidden": true as const };
  const drawn = ICONS[id];

  if (!drawn) {
    // 降级：14px 首字母方块（首字母随专名原样取大写）
    return (
      <span className="ss-mark__box" title={labelled ? name : undefined} {...a11y}>
        {agentInitial(name)}
      </span>
    );
  }

  // 星形光学补偿：画在小 1px 的 svg 里，外层格子仍是 size，居中
  const drawSize = drawn.star ? size - 1 : size;
  const svg = (
    <svg
      width={drawSize}
      height={drawSize}
      viewBox={drawn.viewBox}
      fill={drawn.kind === "fill" ? "currentColor" : "none"}
      stroke={drawn.kind === "stroke" ? "currentColor" : undefined}
      strokeWidth={drawn.kind === "stroke" ? (drawn.star ? 1.2 : 1.4) * (16 / size) : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(labelled ? {} : { "aria-hidden": true as const })}
    >
      {labelled ? <title>{name}</title> : null}
      {drawn.body}
    </svg>
  );
  return (
    <span
      className="ss-mark__glyph"
      style={{ width: size, height: size }}
      {...(labelled ? { role: "img" as const, "aria-label": name } : {})}
    >
      {svg}
    </span>
  );
}

export interface AgentMarkProps {
  id: string;
  /// 显示名，原样写
  name: string;
  /// inline：图标 + 名字横排（设置页、句子里）；
  /// stacked：图标在上名字在下（旧列头）；
  /// header：表格列头三层——16px 图标 / 名字（`label` 12/500 `ink`）/ 计数（12 tabular `ink-faint`）。
  /// agent 名是专名，处处原样大小写（含列头）
  layout?: "inline" | "stacked" | "header";
  /// header 的第三层：这个 agent 下开着几个（只写分子、不零填充）
  count?: number;
  /// 没装这个 agent、或整行禁用：图标跟着名字一起退到 `ink-mute`，形状不变
  dim?: boolean;
  title?: string;
}

export function AgentMark({ id, name, layout = "inline", count, dim, title }: AgentMarkProps) {
  const classes = ["ss-mark", `ss-mark--${layout}`];
  if (dim) classes.push("is-dim");

  return (
    <span className={classes.join(" ")} title={title}>
      <span className="ss-mark__icon">
        <AgentIcon id={id} name={name} />
      </span>
      <span className="ss-mark__name">{name}</span>
      {layout === "header" && count !== undefined ? (
        <span className="ss-mark__count">{count}</span>
      ) : null}
    </span>
  );
}

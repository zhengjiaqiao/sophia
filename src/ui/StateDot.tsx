/// 状态点（组件规范 §2）：格回答两件事——填充＝这个 agent 能不能用它，
/// 外环＝它在这儿是本体还是一条软链。只有三种常驻形，外加一种无格态。

/// 圆点的四种形。`none` 是无格态：该 target 在这一行没有格。
export type Dot = "own" | "linked" | "missing" | "none";

export interface StateDotProps {
  dot: Dot;
  /// 选中行反色：实心与外环转白，空心描边转反色底上的弱色
  inverse?: boolean;
  /// 鼠标悬停说明。无格态必须给，说明「这个 agent 不在当前域」
  title?: string;
  /// 给了才渲染成可点的按钮；异常态与无格态不给
  onClick?: () => void;
  /// 无障碍名，默认用 title
  label?: string;
}

const CLASS: Record<Dot, string> = {
  own: "ss-dot ss-dot--own",
  linked: "ss-dot ss-dot--linked",
  missing: "ss-dot ss-dot--missing",
  none: "ss-dot ss-dot--none",
};

export function StateDot({ dot, inverse, title, onClick, label }: StateDotProps) {
  const className = `${CLASS[dot]}${inverse ? " is-inverse" : ""}`;
  const dotNode = <span className={className} data-dot={dot} aria-hidden="true" />;

  if (!onClick) {
    return (
      <span className="ss-dot-wrap" title={title} role="img" aria-label={label ?? title}>
        {dotNode}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="ss-dot-btn"
      title={title}
      aria-label={label ?? title}
      onClick={onClick}
    >
      {dotNode}
    </button>
  );
}

import type { Overview } from "./types";

export interface ViewProps {
  overview: Overview;
  busy: boolean;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}

/// 占位：按本体位置的卡片视图由 Task C1 实现
export default function SourceView(_props: ViewProps) {
  return <p>待实现</p>;
}

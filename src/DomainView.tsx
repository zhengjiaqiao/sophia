import type { Overview } from "./types";

export interface ViewProps {
  overview: Overview;
  busy: boolean;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}

/// 占位：按域分组的只读视图由 Task C2 实现
export default function DomainView(_props: ViewProps) {
  return <p>待实现</p>;
}

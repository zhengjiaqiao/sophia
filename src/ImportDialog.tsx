import type { DomainPage, Overview } from "./types";

export interface ImportDialogProps {
  overview: Overview;
  page: DomainPage;
  /// 从「编辑」进来时预选的本体位置 id
  initialSourceId?: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}

/// 引入来源弹层。占位，实现见 Task C1
export default function ImportDialog({ page, onClose }: ImportDialogProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <h2>引入来源到「{page.label}」</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        <p>待实现</p>
      </div>
    </div>
  );
}

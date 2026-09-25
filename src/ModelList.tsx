import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  MODEL_FILTER_THRESHOLD,
  frozenGroups,
  modelEntryKey,
  modelFilterPlaceholder,
  modelRowId,
  modelRowLabel,
  snapshotOrder,
} from "./modelsView.ts";
import type { ModelEntry } from "./modelsView.ts";
import type { GatewayProvider } from "./types.ts";
import { CheckRow, FadeViewport, Mono, Note, TextField, useEdgeFades } from "./ui/index.ts";
import "./ModelList.css";

/// 模型勾选列表：Codex 页网关行抽屉里的那一框（DESIGN「模型列表的写法」）。每个列表只列一家网关

export interface ModelListProps {
  /// 要列的模型：这一家网关的全部模型
  entries: ModelEntry[];
  onToggle: (provider: GatewayProvider, modelId: string) => void;
  /// 列表为空时的一句
  empty?: ReactNode;
}

export const entryKey = modelEntryKey;

/**
 * 默认一列名称，行上没有提示框；友好名与 id 明显不同时行尾才写 id（`modelRowId`）。
 * 按服务商分小组头 `azure · 12`，一家一个也有；行内去掉重复前缀；行尾不写网关短名（只列一家）。
 * 已选不在列表里另列一组：已选由节头 `在用` 一行的模型片表达。
 * 打开（挂载）时排一次序（组内已选在前），之后勾选 / 取消不挪位置，下次打开再重排。
 * 勾选当场写盘；超过约 8 行时框顶出筛选框（`筛选 40 个模型`），列表在框内滚动、底边渐隐。
 */
export function ModelList({ entries, onToggle, empty }: ModelListProps) {
  const [query, setQuery] = useState("");
  /// 打开那一刻的排序：之后勾选只改状态、不挪位置
  const [snap] = useState(() => snapshotOrder(entries));
  /// 滚动边缘渐隐：上面 / 下面还有被裁掉的行时，那一边出 16px 渐隐（DESIGN「渐变只用于功能」）
  const scrollRef = useRef<HTMLDivElement>(null);
  const fade = useEdgeFades(scrollRef);
  const withFilter = entries.length > MODEL_FILTER_THRESHOLD;
  const term = withFilter ? query : "";
  const groups = frozenGroups(entries, snap, term);

  /// 一行（勾选行 CheckRow）：整行是命中区，方框只画状态；组头已给出服务商，行内去掉重复前缀。
  /// 行上不放提示框也不设 title：挑模型时完整 id 没有意义，还会盖住正在看的那一行（真机反馈）
  const row = (entry: ModelEntry) => {
    const { provider, model } = entry;
    const id = modelRowId(model);
    const name = modelRowLabel(model);
    return (
      <CheckRow
        key={entryKey(entry)}
        label={name}
        checked={model.selected}
        onChange={() => onToggle(provider, model.id)}
        trailing={id !== null ? <Mono truncate>{id}</Mono> : undefined}
      >
        {name}
      </CheckRow>
    );
  };

  return (
    <div className="model-list">
      {withFilter ? (
        <div className="model-list__search">
          <TextField
            search
            label="筛选模型"
            placeholder={modelFilterPlaceholder(entries.length)}
            value={query}
            onChange={setQuery}
          />
        </div>
      ) : null}
      {entries.length === 0 ? (
        empty ? (
          <div className="model-list__empty">
            <Note>{empty}</Note>
          </div>
        ) : null
      ) : (
        <FadeViewport fade={fade}>
          <div ref={scrollRef} className="model-list__scroll" role="group" aria-label="模型">
            {groups.length === 0 ? (
              <div className="model-list__empty">
                <Note action={{ label: "清除筛选", onClick: () => setQuery("") }}>
                  没有匹配的模型
                </Note>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.vendor} className="model-list__group">
                  <div className="model-list__group-head">
                    <span className="model-list__vendor">{group.vendor}</span>
                    <span className="model-list__dot">·</span>
                    <span className="model-list__count">{group.entries.length}</span>
                  </div>
                  <div className="model-list__rows">{group.entries.map((entry) => row(entry))}</div>
                </div>
              ))
            )}
          </div>
        </FadeViewport>
      )}
    </div>
  );
}

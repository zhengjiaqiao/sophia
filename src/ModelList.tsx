import { useState } from "react";
import type { ReactNode } from "react";
import {
  MODEL_FILTER_THRESHOLD,
  modelGroups,
  modelRowId,
  modelRowLabel,
  providerLabel,
} from "./modelsView.ts";
import type { ModelEntry } from "./modelsView.ts";
import type { GatewayProvider } from "./types.ts";
import { Button, Tooltip } from "./ui/index.ts";
import "./ModelList.css";

/// 模型列表：模型下拉与网关页同一组件（DESIGN「模型列表的写法」）

export interface ModelListProps {
  /// 要列的模型：下拉是全部网关的全部模型，网关页只是本网关的
  entries: ModelEntry[];
  busy: boolean;
  onToggle: (provider: GatewayProvider, modelId: string) => void;
  /// 筛选框与列表之间的一段（下拉里的「第三方」组头）
  header?: ReactNode;
  /// 这几个各闪一次（`网关id|模型id`）：新拉到的模型
  flashKeys?: string[];
  /// 多于一家网关时，行的提示框带上是哪一家
  showGateway?: boolean;
  /// 列表为空时的一句
  empty?: ReactNode;
}

export const entryKey = (entry: ModelEntry) => `${entry.provider.id}|${entry.model.id}`;

/**
 * 默认一列名称，完整 id 进该行提示框；友好名与 id 明显不同时行尾才写 id（`modelRowId`）。
 * 按服务商分小组头 `azure · 12`，一家一个也有；行内去掉重复前缀。
 * 已选置顶、勾选当场写盘；超过约 8 行时出筛选框，列表在自身范围内滚动；底部 `已选 N 个模型`。
 */
export function ModelList({
  entries,
  busy,
  onToggle,
  header,
  flashKeys,
  showGateway,
  empty,
}: ModelListProps) {
  const [query, setQuery] = useState("");
  const withFilter = entries.length > MODEL_FILTER_THRESHOLD;
  const groups = modelGroups(entries, withFilter ? query : "");
  const flash = new Set(flashKeys ?? []);
  const selected = entries.filter((e) => e.model.selected).length;
  let order = 0;

  return (
    <div className="model-list">
      {withFilter ? (
        <div className="model-list__search">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" />
          </svg>
          {/* 不用 type="search"：WebKit 的搜索框会自己吃掉 Esc */}
          <input
            type="text"
            className="model-list__input"
            placeholder="筛选"
            aria-label="筛选模型"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {header}
      {entries.length === 0 ? (
        empty ? (
          <p className="model-list__empty">{empty}</p>
        ) : null
      ) : (
        <div
          className={`model-list__scroll${busy ? " ss-busy" : ""}`}
          role="listbox"
          aria-multiselectable="true"
        >
          {groups.length === 0 ? (
            <p className="model-list__empty">
              没有匹配的模型
              <Button variant="link" onClick={() => setQuery("")}>
                清除筛选
              </Button>
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.vendor} className="model-list__group">
                <div className="model-list__group-head">
                  <span className="model-list__vendor">{group.vendor}</span>
                  <span className="model-list__dot">·</span>
                  <span className="model-list__count">{group.entries.length}</span>
                </div>
                {group.entries.map((entry) => {
                  const { provider, model } = entry;
                  const key = entryKey(entry);
                  const flashing = flash.has(key);
                  const id = modelRowId(model);
                  const fullId = model.slug || model.id;
                  const i = order++;
                  return (
                    <Tooltip
                      key={key}
                      content={showGateway ? `${fullId} · ${providerLabel(provider)}` : fullId}
                    >
                      <div
                        className={`models-option${flashing ? " is-flash" : ""}`}
                        style={
                          flashing ? { animationDelay: `${Math.min(i, 12) * 60}ms` } : undefined
                        }
                        role="option"
                        aria-selected={model.selected}
                        tabIndex={0}
                        onClick={() => !busy && onToggle(provider, model.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            if (!busy) onToggle(provider, model.id);
                          }
                        }}
                      >
                        {/* 12px 方框只画状态（方＝我选的）；命中区是整行，读屏走 aria-selected */}
                        <span
                          className={`ss-checkbox models-option__check${model.selected ? " is-on" : ""}`}
                          aria-hidden="true"
                        >
                          {model.selected ? (
                            <svg
                              width="8"
                              height="8"
                              viewBox="0 0 8 8"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.4"
                            >
                              <path d="M1.2 4.2l1.9 1.9L6.8 1.9" />
                            </svg>
                          ) : null}
                        </span>
                        <span className="models-option__name">{modelRowLabel(model)}</span>
                        {id !== null ? <span className="models-option__id">{id}</span> : null}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
      <div className="model-list__foot">
        已选&nbsp;<span className="model-list__selected">{selected}</span>&nbsp;个模型
      </div>
    </div>
  );
}

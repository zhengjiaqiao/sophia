import { useId } from "react";
import { t } from "./i18n.ts";
import type { ProviderPreset } from "./types.ts";
import { filterPresets, firstPick, presetHost, presetSupported } from "./presetView.ts";
import { Tag, TextField, Tooltip } from "./ui/index.ts";

/// 加一家的第一步「选预设」（spec S1，画板 SvjEZCgBMgWqe666nJGXR7 第一张；2026-10-05 产品负责人：不分国内海外，
/// 一列到底；`自定义地址…` 固定在框底不随名单滚动）。旧的按 agent 的网关表单与全局模型提供商的添加表单共用，
/// 字由调用方给（旧表单说「服务商」，新的说「提供商」）。样式在 ModelsTab.css 的 `.gw-preset`
export function PresetPicker({
  presets,
  query,
  onQuery,
  onPick,
  onCustom,
  label,
  search,
  empty,
}: {
  presets: ProviderPreset[];
  query: string;
  onQuery: (next: string) => void;
  /// 选了一家能用的
  onPick: (preset: ProviderPreset) => void;
  /// `自定义地址…`
  onCustom: () => void;
  /// 字段标签（`服务商` / `提供商`）
  label: string;
  /// 搜索框占位
  search: string;
  /// 搜不到时的一句
  empty: string;
}) {
  const fieldId = useId();
  const shown = filterPresets(presets, query);
  return (
    <div className="gw-form__field">
      <label className="gw-form__label gw-form__label--top" id={`${fieldId}-preset-label`}>
        {label}
      </label>
      <div className="gw-preset">
        <TextField
          id={`${fieldId}-preset`}
          labelledBy={`${fieldId}-preset-label`}
          value={query}
          autoFocus
          search
          spellCheck={false}
          placeholder={search}
          onChange={onQuery}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const first = firstPick(shown);
            if (first !== null) onPick(first);
          }}
        />
        <div className="gw-preset__box">
          <div className="gw-preset__scroll" role="listbox" aria-label={t("models.preset.list")}>
            {shown.length === 0 ? (
              <p className="gw-preset__empty">{empty}</p>
            ) : (
              shown.map((p) => {
                const supported = presetSupported(p);
                const item = (
                  <button
                    type="button"
                    key={p.id}
                    role="option"
                    aria-selected={false}
                    aria-disabled={!supported}
                    className={
                      supported ? "gw-preset__item" : "gw-preset__item gw-preset__item--off"
                    }
                    onClick={() => supported && onPick(p)}
                  >
                    <span className="gw-preset__name">
                      {p.name}
                      <span className="gw-preset__host">
                        {presetHost(p)}
                        {p.note ? ` · ${p.note}` : null}
                      </span>
                    </span>
                    {supported ? null : <Tag tone="weak">{t("models.preset.unsupported")}</Tag>}
                  </button>
                );
                // 为什么不能选只在悬停时说（原来名单下常驻一句，2026-10-06 删了）；提示框挂在整行上，
                // 不在按钮里再嵌一个可聚焦的记号
                return supported ? (
                  item
                ) : (
                  <Tooltip key={p.id} content={t("models.preset.unsupportedTip")}>
                    {item}
                  </Tooltip>
                );
              })
            )}
          </div>
          {/* 固定在框底、不随名单滚动 */}
          <div className="gw-preset__foot">
            <button type="button" className="gw-preset__item" onClick={onCustom}>
              <span className="gw-preset__name">{t("models.preset.custom")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

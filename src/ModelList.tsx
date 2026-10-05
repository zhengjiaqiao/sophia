import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "./i18n.ts";
import {
  MODEL_FILTER_THRESHOLD,
  probingNote,
  contextLabel,
  frozenGroups,
  modelEntryKey,
  modelFilterPlaceholder,
  modelRowId,
  modelRowLabel,
  parseBackendError,
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
  /// 勾上之前先试调用一次（2026-09-30：网关列出来的不一定调得通）；抛出＝调不通，原话写在那一行，不勾。
  /// 不给就直接勾。取消勾选不试
  probe?: (provider: GatewayProvider, modelId: string) => Promise<unknown>;
  /// 列表为空时的一句
  empty?: ReactNode;
  /// 给了就不能勾新的（还没有密钥，试调不了）：没勾的行不可用、按下说这一句；已勾的照常能取消
  pickBlockedReason?: string;
}

export const entryKey = modelEntryKey;

/**
 * 默认一列名称，行上没有提示框；友好名与 id 明显不同时行尾才写 id（`modelRowId`）。
 * 按服务商分小组头 `azure · 12`，一家一个也有；行内去掉重复前缀；行尾不写网关短名（只列一家）。
 * 已选不在列表里另列一组：已选由节头 `在用` 一行的模型片表达。
 * 打开（挂载）时排一次序（组内已选在前），之后勾选 / 取消不挪位置，下次打开再重排。
 * 勾选当场写盘；超过约 8 行时框顶出筛选框（`筛选 40 个模型`），列表在框内滚动、底边渐隐。
 */
export function ModelList({ entries, onToggle, probe, empty, pickBlockedReason }: ModelListProps) {
  const [query, setQuery] = useState("");
  /// 正在试调用的行：再点不接（一次只试一回）
  const [probing, setProbing] = useState<ReadonlySet<string>>(() => new Set());
  /// 试过调不通的行 → 原因（再点就再试一次；取消勾选、试通了就去掉）
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const mounted = useRef(true);
  /// 最新一份模型列表：试调用回来时按它判断「此刻已经勾上了没有」（期间可能别处勾上了）
  const latest = useRef(entries);
  latest.current = entries;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  const settle = (key: string, reason: string | null) => {
    setProbing((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setFailed((prev) => {
      const next = new Map(prev);
      if (reason === null) next.delete(key);
      else next.set(key, reason);
      return next;
    });
  };

  /// 勾上：给了 `probe` 就先试调用，通了才勾；取消勾选直接写
  const toggle = async (entry: ModelEntry) => {
    const { provider, model } = entry;
    const key = entryKey(entry);
    if (probing.has(key)) return;
    if (model.selected || !probe) {
      if (failed.has(key)) settle(key, null);
      onToggle(provider, model.id);
      return;
    }
    setProbing((prev) => new Set(prev).add(key));
    try {
      await probe(provider, model.id);
    } catch (error) {
      if (mounted.current) settle(key, parseBackendError(String(error)).message);
      return;
    }
    // 通了：只在此刻仍没勾上时勾（onToggle 是翻转，别处已经勾上了再翻就成了取消）；
    // 先写再收起「正在试」，框不闪回未勾。列表这时已经收起（换了页、收了行）也照样写——
    // 用户点过勾，试通了就该存下
    const now = latest.current.find((e) => entryKey(e) === key)?.model.selected ?? false;
    if (!now) onToggle(provider, model.id);
    if (mounted.current) settle(key, null);
  };

  const row = (entry: ModelEntry) => {
    const { model } = entry;
    const key = entryKey(entry);
    const id = modelRowId(model);
    const name = modelRowLabel(model);
    const context = contextLabel(model.contextWindow);
    const note = probing.has(key) ? probingNote() : (failed.get(key) ?? undefined);
    return (
      <CheckRow
        key={key}
        label={name}
        checked={model.selected || probing.has(key)}
        onChange={() => void toggle(entry)}
        disabledReason={model.selected ? undefined : pickBlockedReason}
        note={note}
        trailing={
          context === null ? (
            id !== null ? (
              <Mono truncate>{id}</Mono>
            ) : undefined
          ) : (
            // 有读数时读数在前、不截，id 跟在后面
            <span className="model-list__trail">
              <span className="model-list__context">{context}</span>
              {id !== null ? <Mono truncate>{id}</Mono> : null}
            </span>
          )
        }
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
            label={t("models.list.filterLabel")}
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
          <div
            ref={scrollRef}
            className="model-list__scroll"
            role="group"
            aria-label={t("models.list.groupLabel")}
          >
            {groups.length === 0 ? (
              <div className="model-list__empty">
                <Note action={{ label: t("models.list.clearFilter"), onClick: () => setQuery("") }}>
                  {t("models.list.noMatch")}
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

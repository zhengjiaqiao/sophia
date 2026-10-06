import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { listText, t } from "./i18n.ts";
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
  prefixExample,
  resolveManual,
  snapshotOrder,
} from "./modelsView.ts";
import type { ModelEntry } from "./modelsView.ts";
import type { GatewayProvider } from "./types.ts";
import {
  BusySlot,
  Button,
  CheckRow,
  FadeViewport,
  FloatingToast,
  Mono,
  Note,
  Tag,
  TextField,
  Toast,
  useEdgeFades,
} from "./ui/index.ts";
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
  /// 手动添加模型（sophia-dev#117，画板 SvjEZCgBMgWqe666nJGXR7 第四张）：给了就在框底出一行输入 + `试一下再加`；
  /// 抛出＝试不通，原话写在输入框下，不加。列表只列一家，所以这一行就是这一家的。
  /// 填的 id 对上列表里已有的（完整 id，或去掉服务商前缀的那一截）：不另加，走勾选那条路（先试调）
  onAddManual?: (modelId: string) => Promise<unknown>;
}

/// 框底那一行（也给没有模型时的空态用）：输入 id → `试一下再加`（按下原位忙碌 `正在试调`）→ 通了清空输入框，
/// 不通原话写在下面。回车同按键
export function ManualModelRow({
  onAdd,
  blockedReason,
}: {
  /// 通了返回勾上的那个 id（可能是列表里已有的、补全了前缀的那一个），写进下面那句反馈
  onAdd: (modelId: string) => Promise<string | void>;
  /// 还没有密钥：不可用，按下说原因
  blockedReason?: string;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  /// 结果用提示条说（2026-10-06 产品负责人：写在输入框下面好几次都没看见），锚在 `试一下再加` 正下方、
  /// 轻量一行（DESIGN「Patterns › 反馈」：用户按的键出的结果锚在那颗键上，右下只给后台发生的事）：
  /// 勾上了（成功，约 3 秒）、试不通 / 几家同名（做不成，8 秒）。`seq` 让同一种结果再出一次时重新计时
  const [toast, setToast] = useState<{ seq: number; node: ReactNode } | null>(null);
  const seq = useRef(0);
  const dismiss = useCallback(() => setToast(null), []);
  const show = (node: ReactNode) => {
    seq.current += 1;
    setToast({ seq: seq.current, node });
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const id = value.trim();
  const add = async () => {
    if (id === "" || busy) return;
    setBusy(true);
    setToast(null);
    try {
      const added = await onAdd(id);
      if (mounted.current) {
        setValue("");
        const checked = typeof added === "string" ? added : id;
        show(
          <Toast
            kind="success"
            message={t("models.manual.checked", { model: checked })}
            onDismiss={dismiss}
          />,
        );
      }
    } catch (error) {
      // 几家同名那一句是前端自己抛的（`AmbiguousModel`），不带 `[code]` 前缀，直接用原句；后端的按 `[code] 一句` 拆
      const message =
        error instanceof ManualAddError ? error.message : parseBackendError(String(error)).message;
      if (mounted.current) show(<Toast kind="cannot" message={message} onDismiss={dismiss} />);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="model-list__manual">
      <div className="model-list__manual-row">
        <TextField
          mono
          label={t("models.manual.label")}
          placeholder={t("models.manual.placeholder")}
          value={value}
          spellCheck={false}
          onChange={setValue}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
        {/* 键与锚在它下面的提示条（FloatingToast 以这一层为锚） */}
        <span className="model-list__manual-key">
          <BusySlot busy={busy} label={t("models.manual.adding")}>
            {blockedReason !== undefined ? (
              <Button size="compact" disabled disabledReason={blockedReason}>
                {t("models.manual.add")}
              </Button>
            ) : id === "" ? (
              <Button size="compact" disabled disabledReason={t("models.manual.needId")}>
                {t("models.manual.add")}
              </Button>
            ) : (
              <Button size="compact" onClick={() => void add()}>
                {t("models.manual.add")}
              </Button>
            )}
          </BusySlot>
          {toast ? (
            <FloatingToast key={toast.seq} align="end">
              {toast.node}
            </FloatingToast>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/// 前端自己说的失败原因（几家同名、该带前缀）：句子已经写好，不按后端的 `[code] 一句` 拆
class ManualAddError extends Error {}

export const entryKey = modelEntryKey;

/**
 * 默认一列名称，行上没有提示框；友好名与 id 明显不同时行尾才写 id（`modelRowId`）。
 * 按服务商分小组头 `azure · 12`，一家一个也有；行内去掉重复前缀；行尾不写网关短名（只列一家）。
 * 已选不在列表里另列一组：已选由节头 `在用` 一行的模型片表达。
 * 打开（挂载）时排一次序（组内已选在前），之后勾选 / 取消不挪位置，下次打开再重排。
 * 勾选当场写盘；超过约 8 行时框顶出筛选框（`筛选 40 个模型`），列表在框内滚动、底边渐隐。
 */
export function ModelList({
  entries,
  onToggle,
  probe,
  empty,
  pickBlockedReason,
  onAddManual,
}: ModelListProps) {
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
  /// 刚由手动添加勾上的那一行：亮一会儿，让人找得到（#117）
  const [flash, setFlash] = useState<string | null>(null);
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

  /// 手动添加（#117）：先对一遍列表——对上已有的就按勾选的路走（没勾的先试调再勾，已勾的什么都不做）；
  /// 几家都有这个名字就说清让人填完整 id；对不上才真的加。完了把那一行亮起来、筛选框换成它，人一眼看到勾在哪
  const addManual = async (typed: string): Promise<string> => {
    const match = resolveManual(latest.current, typed);
    if (match.kind === "many") {
      throw new ManualAddError(t("models.manual.ambiguous", { ids: listText(match.ids) }));
    }
    let id = typed.trim();
    let key: string | null = null;
    if (match.kind === "one") {
      id = match.entry.model.id;
      key = entryKey(match.entry);
      if (!match.entry.model.selected) {
        if (probe) await probe(match.entry.provider, id);
        onToggle(match.entry.provider, id);
      }
    } else if (onAddManual) {
      try {
        await onAddManual(id);
      } catch (error) {
        // 没带服务商前缀、这家又都是带前缀的写法：多半是格式不对，给一个列表里的例子
        const example = prefixExample(latest.current, id);
        if (example === null) throw error;
        throw new ManualAddError(t("models.manual.needPrefix", { model: id, example }));
      }
    }
    if (mounted.current) {
      if (withFilter) setQuery(id);
      if (key !== null) {
        setFlash(key);
        window.setTimeout(
          () => mounted.current && setFlash((f) => (f === key ? null : f)),
          FLASH_MS,
        );
      }
    }
    return id;
  };

  const row = (entry: ModelEntry) => {
    const { model } = entry;
    const key = entryKey(entry);
    const id = modelRowId(model);
    const name = modelRowLabel(model);
    const context = contextLabel(model.contextWindow);
    const note = probing.has(key) ? probingNote() : (failed.get(key) ?? undefined);
    // 手动填的（#117）：行尾带弱记号 `手动`，在读数与 id 之前
    const manual = model.manual ? <Tag tone="weak">{t("models.manual.tag")}</Tag> : null;
    const trailing =
      manual === null && context === null ? (
        id !== null ? (
          <Mono truncate>{id}</Mono>
        ) : undefined
      ) : (
        // 有读数时读数在前、不截，id 跟在后面
        <span className="model-list__trail">
          {manual}
          {context !== null ? <span className="model-list__context">{context}</span> : null}
          {id !== null ? <Mono truncate>{id}</Mono> : null}
        </span>
      );
    return (
      <CheckRow
        key={key}
        label={name}
        checked={model.selected || probing.has(key)}
        onChange={() => void toggle(entry)}
        disabledReason={model.selected ? undefined : pickBlockedReason}
        highlighted={flash === key}
        note={note}
        trailing={trailing}
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
                {/* 清空就用筛选框自己右端的 ✕，不再多一颗「清除筛选」（2026-10-06 产品负责人：两个重复了） */}
                <Note>{t("models.list.noMatch")}</Note>
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
      {onAddManual ? <ManualModelRow onAdd={addManual} blockedReason={pickBlockedReason} /> : null}
    </div>
  );
}

/// 刚勾上的那一行亮多久
const FLASH_MS = 2500;

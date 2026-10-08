import { useEffect, useId, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { copyDetails } from "./diagnostics.ts";
import { parseBackendError } from "./backendError.ts";
import { contextLabel } from "./modelsView.ts";
import { ManualModelRow } from "./ManualModelRow.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { usePresets } from "./presets.ts";
import type { Proceed } from "./shell/leaveGuard.ts";
import { keysLink, pickedName, presetHost } from "./presetView.ts";
import {
  customNamePlaceholder,
  defaultNameFor,
  dialogRuleText,
  draftDirty,
  filterProviderModels,
  keyChecksNow,
  keyHintText,
  nameTakenText,
  previewKey,
  saveBlocked,
  saveErrorRepeats,
  searchPlaceholder,
  toggleChosen,
} from "./providersView.ts";
import type {
  PreviewModel,
  ProviderAdded,
  ProviderPreset,
  ProviderPreview,
  ProviderRow,
} from "./types.ts";
import {
  BusySlot,
  Button,
  CheckRow,
  FormDialog,
  Mono,
  Note,
  NoticePanel,
  SectionLabel,
  Spinner,
  TextField,
} from "./ui/index.ts";

/// 添加 / 编辑模型提供商的弹窗（画板 9UGdeLt4rvg2dm8SpStvHo 第 9 屏；DESIGN「页面还是弹层」填短表单、
/// 「模型提供商页 › 加一家」）。外壳是 `FormDialog`（宽 480、点遮罩不收起、Esc 与 `取消` 收起）。
///
/// - 添加：先在弹窗里选预设（或 `自定义地址…`），选了换成 `提供商 名字 主机名 · 换一家`（自定义写 `自定义地址`，
///   不带省略号）；名称、地址、密钥标签在上。填好密钥就用表单里的值拉模型列表（不落盘），下半出现「启用的模型」：
///   按默认规则先勾好、写明规则，可搜索、增减、框底手填 id（先试一次，结果写在那一行下面）。拉不到：灰面板 + `!` 原文，
///   仍可保存。保存一次加上并启用（交给后端的是勾定的列表）
/// - 密钥不像密钥（含空白、不到 8 位）：框下就地一句（粘贴当场说，手打等离开密钥框或停手 0.4 秒），不拉列表，
///   `保存` 禁用并说同一句（禁用照旧实时）
/// - 编辑：只有名称、地址、密钥（留空＝不改）；启用模型仍在行尾 `启用模型 ▾` 里改
/// - 有没保存的改动时 Esc / `取消`（或壳要换页，`ask`）先在键区左边问一句 `模型提供商还没保存`，键换成 `丢弃` 与 `保存`；
///   再按一次 Esc 或 `丢弃` 才收起
/// - 底部给以后的「高级设置」留一行位置，本次没有内容（#252）

const describe = (error: unknown) => parseBackendError(String(error));

/// 拉模型列表的进度：拉哪一份（`previewKey`）、拉到没有
export type PreviewState =
  | { status: "loading" }
  | { status: "ok"; preview: ProviderPreview }
  | { status: "failed"; message: string; detail?: string };

/// 粘贴、打字时等一会儿再拉，免得每敲一个字拉一次
const PREVIEW_DELAY_MS = 400;
/// 手打密钥时停手多久再判断形状（粘贴当场判断）
const KEY_CHECK_DELAY_MS = 400;

export interface ProviderDialogProps {
  /// 编辑的那一家；添加为 null
  row: ProviderRow | null;
  rows: ProviderRow[];
  onClose: () => void;
  onSaved: (rows: ProviderRow[], added?: ProviderAdded) => void;
  /// 有没保存的改动（页面据此登记换页前先问）
  onDirty?: (dirty: boolean) => void;
  /// 壳要换页、弹窗里有没保存的改动：问完（保存成了或丢弃了）之后继续走的那一下
  ask?: Proceed | null;
  /// 问出来后用户继续编辑、取消了待定的退出：页面把登记的那一下收掉（弹窗里的那一问由弹窗自己收起）
  onWithdraw?: () => void;
}

export function ProviderDialog({
  row,
  rows,
  onClose,
  onSaved,
  onDirty,
  ask = null,
  onWithdraw,
}: ProviderDialogProps) {
  const presets = usePresets();
  const fieldId = useId();
  const [preset, setPreset] = useState<ProviderPreset | "custom" | null>(
    row === null ? null : "custom",
  );
  const [presetQuery, setPresetQuery] = useState("");
  const [name, setName] = useState(row?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(row?.baseUrl ?? "");
  const [key, setKey] = useState("");
  /// 判断过形状的那一份密钥：粘贴当场记下，手打等离开密钥框或停手 0.4 秒（框下那一句不边打边报）
  const [keyChecked, setKeyChecked] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyChecked(key), KEY_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key]);
  const editKey = (next: string) => {
    edited();
    if (keyChecksNow(key, next)) setKeyChecked(next);
    setKey(next);
  };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  /// Esc / 取消时有没保存的改动：问过一次了
  const [asking, setAsking] = useState(false);
  const [preview, setPreview] = useState<{ key: string; state: PreviewState } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  /// 框底手填、试通了的 id（列表里没有的），排在列表后面
  const [extra, setExtra] = useState<PreviewModel[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  /// 「启用的模型」那一块：保存失败的原因它已经说了时，滚到它
  const modelsRef = useRef<HTMLDivElement>(null);
  /// 保存失败的原因与上面「拉不到模型列表」说的是同一句：不再另出一块，同一原因只说一处（走查 2026-10-08）
  const repeated = error !== null && saveErrorRepeats(preview?.state ?? null, error);
  useEffect(() => {
    if (error === null) return;
    (repeated ? modelsRef : errorRef).current?.scrollIntoView({ block: "nearest" });
  }, [error, repeated]);

  const adding = row === null;
  const dirty = draftDirty(row, preset, { name, baseUrl, key });
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  const askingNow = asking || ask !== null;
  /// 用户在弹窗里动了输入：问的是退出（`ask.cancel`）就取消这次退出、那一问收起；之后保存不再接着退出。换页那条路的不带 cancel，不受影响
  const edited = () => {
    if (!ask?.cancel) return;
    ask.cancel();
    onWithdraw?.();
    setAsking(false);
  };

  // 填好地址与密钥就拉列表（只在添加时）：等一会儿再拉；地址或密钥又变了，旧的那份回来也不用
  const presetId = preset !== null && preset !== "custom" ? preset.id : undefined;
  const draftKey = adding && preset !== null ? previewKey(baseUrl, key) : null;
  /// 拉哪一份：地址、密钥、预设（推荐模型跟着预设）任一变了就是另一份
  const wanted = draftKey === null ? null : `${draftKey}\n${presetId ?? ""}`;
  const current = useRef(wanted);
  current.current = wanted;
  useEffect(() => {
    if (wanted === null) {
      setPreview(null);
      return;
    }
    setPreview({ key: wanted, state: { status: "loading" } });
    const timer = window.setTimeout(() => {
      void api
        .providersPreview({ baseUrl: baseUrl.trim(), key: key.trim(), preset: presetId })
        .then(
          (data): PreviewState => ({ status: "ok", preview: data }),
          (e): PreviewState => {
            const parsed = describe(e);
            return { status: "failed", message: parsed.message, detail: parsed.detail };
          },
        )
        .then((state) => {
          if (current.current !== wanted) return;
          setPreview({ key: wanted, state });
          if (state.status === "ok") {
            setChosen(state.preview.enabled);
            setExtra([]);
          }
        });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
    // 只看拉哪一份：wanted 里已经有地址、密钥与预设
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const close = () => {
    onDirty?.(false);
    onClose();
  };
  /// Esc 与 `取消`：有改动先问一次，再按才收起
  const cancel = () => {
    if (saving) return;
    if (dirty && !askingNow) {
      setAsking(true);
      return;
    }
    close();
    ask?.();
  };

  const pick = (p: ProviderPreset) => {
    setPreset(p);
    setName(p.name);
    setBaseUrl(p.openai?.apiBase ?? "");
    setError(null);
  };
  /// `换一家`：回到预设名单，填过的清掉
  const change = () => {
    setPreset(null);
    setName("");
    setBaseUrl("");
    setKey("");
    setError(null);
    setAsking(false);
  };

  const title = adding
    ? t("models.providers.formTitle")
    : t("models.providers.editTitle", { name: row.name });

  if (preset === null) {
    return (
      <FormDialog
        title={title}
        onEscape={cancel}
        onDismiss={close}
        stretch
        foot={
          <Button size="row" onClick={close}>
            {t("models.form.cancel")}
          </Button>
        }
      >
        <div className="provider-dialog provider-dialog--stretch">
          <div className="provider-dialog__field">
            <PresetPicker
              presets={presets}
              query={presetQuery}
              onQuery={setPresetQuery}
              onPick={pick}
              onCustom={() => setPreset("custom")}
              label={t("models.providers.presetLabel")}
              search={t("models.providers.presetSearch")}
              empty={t("models.providers.presetEmpty")}
            />
          </div>
        </div>
      </FormDialog>
    );
  }

  const fromPreset = preset !== "custom";
  const taken = nameTakenText(rows, name, row?.id ?? null, baseUrl);
  const blocked = saveBlocked({ adding, baseUrl, key, taken });
  const keyShape = keyHintText(key, keyChecked);
  const keysUrl = fromPreset ? keysLink(preset) : null;
  const loaded = preview?.state.status === "ok" ? preview.state.preview : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (row === null) {
        const result = await api.providersAdd({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          key,
          preset: presetId,
          enabled: loaded ? chosen : undefined,
        });
        onDirty?.(false);
        onSaved(result.providers, result.added);
      } else {
        let next = await api.providersEdit({
          id: row.id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          key: key === "" ? undefined : key,
        });
        // 只改了地址、用已存的密钥：接着重拉一次
        if (key === "" && baseUrl.trim() !== row.baseUrl) next = await api.providersRefetch(row.id);
        onDirty?.(false);
        onSaved(next);
      }
      ask?.();
    } catch (e) {
      const parsed = describe(e);
      setError({ message: parsed.message, detail: parsed.detail });
      setSaving(false);
    }
  };

  const saveKey = saving ? (
    <BusySlot busy label={t("models.form.fetching")}>
      <Button variant="primary" size="row">
        {t("models.form.save")}
      </Button>
    </BusySlot>
  ) : blocked !== null ? (
    <Button variant="primary" size="row" disabled disabledReason={blocked}>
      {t("models.form.save")}
    </Button>
  ) : (
    <Button variant="primary" size="row" onClick={() => void save()}>
      {t("models.form.save")}
    </Button>
  );

  const asked = askingNow && !saving;
  return (
    <FormDialog
      title={title}
      onEscape={cancel}
      onDismiss={close}
      status={asked ? t("models.providers.unsaved") : undefined}
      foot={
        <>
          <Button size="row" onClick={cancel}>
            {asked ? t("models.form.discard") : t("models.form.cancel")}
          </Button>
          {saveKey}
        </>
      }
    >
      <div className="provider-dialog">
        {adding ? (
          <div className="provider-dialog__field">
            <span className="gw-form__label">{t("models.providers.presetLabel")}</span>
            <div className="gw-preset__picked">
              <span>
                {pickedName(preset)}
                {fromPreset ? <span className="gw-preset__host">{presetHost(preset)}</span> : null}
              </span>
              <span className="gw-preset__change">
                <Button size="compact" onClick={change}>
                  {t("models.providers.presetChange")}
                </Button>
              </span>
            </div>
          </div>
        ) : null}
        <div className="provider-dialog__field">
          <label
            className="gw-form__label"
            id={`${fieldId}-name-label`}
            htmlFor={`${fieldId}-name`}
          >
            {t("models.providers.nameLabel")}
          </label>
          <TextField
            id={`${fieldId}-name`}
            labelledBy={`${fieldId}-name-label`}
            value={name}
            spellCheck={false}
            placeholder={fromPreset ? undefined : customNamePlaceholder(baseUrl)}
            onChange={(v) => {
              edited();
              setName(v);
            }}
          />
          {/* 自定义的不再写「会显示在哪」：不复述界面上看得见的东西（走查 2026-10-08） */}
          {taken !== null || fromPreset ? (
            <p className="gw-form__hint" role={taken ? "status" : undefined}>
              {taken ?? t("models.providers.namePresetHint")}
            </p>
          ) : null}
        </div>
        <div className="provider-dialog__field">
          <label className="gw-form__label" id={`${fieldId}-url-label`} htmlFor={`${fieldId}-url`}>
            {t("models.form.urlLabel")}
          </label>
          <TextField
            id={`${fieldId}-url`}
            labelledBy={`${fieldId}-url-label`}
            value={baseUrl}
            spellCheck={false}
            autoFocus={!fromPreset && adding}
            placeholder="https://example.com/openai/v1"
            onChange={(v) => {
              edited();
              setBaseUrl(v);
            }}
          />
        </div>
        <div className="provider-dialog__field">
          <label className="gw-form__label" id={`${fieldId}-key-label`} htmlFor={`${fieldId}-key`}>
            {t("models.form.keyLabel")}
          </label>
          <TextField
            id={`${fieldId}-key`}
            labelledBy={`${fieldId}-key-label`}
            type="password"
            value={key}
            autoFocus={fromPreset}
            autoComplete="off"
            placeholder={row?.key === "set" ? t("models.form.keySaved") : t("models.form.keyNew")}
            onChange={editKey}
            onBlur={() => setKeyChecked(key)}
          />
          {/* 不像密钥：框下就地一句（同名称下的同名那一句），不拉列表，保存禁用并说同一句（禁用照旧实时）。
              这一句粘贴当场出，手打等离开密钥框或停手 0.4 秒，不边打边报（2026-10-08） */}
          {keyShape !== null ? (
            <p className="gw-form__hint" role="status">
              {keyShape}
            </p>
          ) : null}
        </div>
        {keysUrl !== null && fromPreset ? (
          <div>
            <Button variant="quiet" onClick={() => void openUrl(keysUrl)}>
              {t("models.preset.keys", { name: preset.name })}
            </Button>
          </div>
        ) : null}
        {adding && preview !== null ? (
          <div ref={modelsRef} className="provider-dialog__reveal">
            <DialogModels
              name={name.trim() || (fromPreset ? preset.name : (defaultNameFor(baseUrl) ?? ""))}
              state={preview.state}
              chosen={chosen}
              extra={extra}
              query={modelQuery}
              onQuery={setModelQuery}
              onToggle={(id, on) => {
                edited();
                setChosen((prev) => toggleChosen(prev, id, on));
              }}
              onTyped={async (model) => {
                const id = model.trim();
                await api.providersProbeDraft({
                  apiBase: loaded?.apiBase ?? baseUrl.trim(),
                  key: key.trim(),
                  preset: presetId,
                  model: id,
                });
                const listed = loaded?.models.some((m) => m.id === id) ?? false;
                edited();
                if (!listed)
                  setExtra((prev) => (prev.some((m) => m.id === id) ? prev : [...prev, { id }]));
                setChosen((prev) => toggleChosen(prev, id, true));
                return id;
              }}
            />
          </div>
        ) : null}
        {/* 以后的「高级设置」（请求头、单家代理、并发、价格倍率，默认收起）放在这一行；本次没有内容（#252） */}
        <div className="providers__advanced" data-slot="advanced" />
        {/* 保存失败：满弹窗内容宽、放不下折行（`section`；随内容宽的 row 档一句不折，曾伸出弹窗右沿，走查 2026-10-08），
            出现时滚到看得见的地方——它在滚动层的末尾，列表长时会在下沿外面。原因与上面「拉不到模型列表」那块一样时不出，
            滚到那一块（同一原因只说一处） */}
        {error !== null && !repeated ? (
          <div ref={errorRef} className="provider-dialog__reveal">
            <NoticePanel
              scope="section"
              message={error.message}
              technical={error.detail}
              onCopy={(text) => copyDetails(text)}
              onClose={() => setError(null)}
            />
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}

/// 添加弹窗下半「启用的模型」（画板第 9 屏 ②③④）：区块小标；正在拉——刻度 + `正在拉模型`；拉到——规则一句、搜索、
/// 勾选列表（不限高，跟着弹窗一起滚）、框底手填 id；拉不到——灰面板（原因 + `!` 原文）+ 一句仍可保存。只画，状态归弹窗
export function DialogModels({
  name,
  state,
  chosen,
  extra,
  query,
  onQuery,
  onToggle,
  onTyped,
}: {
  /// 提供商名（搜索框占位）
  name: string;
  state: PreviewState;
  chosen: readonly string[];
  /// 手填试通、列表里没有的
  extra: readonly PreviewModel[];
  query: string;
  onQuery: (next: string) => void;
  onToggle: (id: string, on: boolean) => void;
  /// 框底手填一个 id：试通了返回它（ManualModelRow 写在那一行下面），不通抛原因
  onTyped: (model: string) => Promise<string>;
}) {
  const all = state.status === "ok" ? [...state.preview.models, ...extra] : [];
  const shown = filterProviderModels(all, query);
  return (
    <div className="provider-dialog__models">
      <SectionLabel rule>{t("models.providers.dialogModels")}</SectionLabel>
      {state.status === "loading" ? (
        <Note>
          <span className="provider-dialog__busy" role="status">
            <Spinner size={14} label={t("models.form.fetching")} />
            {t("models.form.fetching")}
          </span>
        </Note>
      ) : state.status === "failed" ? (
        <>
          <NoticePanel
            scope="section"
            message={t("models.providers.dialogFetchFailed")}
            reason={state.message}
            technical={state.detail}
            onCopy={(text) => copyDetails(text)}
          />
          <p className="provider-dialog__rule">{t("models.providers.dialogFetchFailedNote")}</p>
        </>
      ) : (
        <>
          <p className="provider-dialog__rule">{dialogRuleText(state.preview, chosen)}</p>
          <TextField
            search
            label={searchPlaceholder({ name, total: all.length })}
            value={query}
            spellCheck={false}
            placeholder={searchPlaceholder({ name, total: all.length })}
            onChange={onQuery}
          />
          {/* 不限高、不自己滚：全部展开，跟着弹窗内容一起滚（弹窗里只留一层滚动，2026-10-08） */}
          <div className="provider-dialog__list">
            {all.length === 0 ? (
              <p className="provider-dialog__rule">{t("models.providers.noModels")}</p>
            ) : shown.length === 0 ? (
              <p className="provider-dialog__rule">{t("models.list.noMatch")}</p>
            ) : (
              shown.map((model) => {
                const context = contextLabel(model.contextWindow);
                return (
                  <CheckRow
                    key={model.id}
                    checked={chosen.includes(model.id)}
                    label={model.id}
                    trailing={context ? <Mono>{context}</Mono> : undefined}
                    onChange={(next) => onToggle(model.id, next)}
                  >
                    {model.displayName ?? model.id}
                  </CheckRow>
                );
              })
            )}
          </div>
          <div className="provider-dialog__manual">
            <ManualModelRow
              placeholder={t("models.providers.typedPlaceholder")}
              addLabel={t("models.providers.typedAdd")}
              doneText={(model) => t("models.providers.typedChecked", { model })}
              onAdd={onTyped}
              inline
            />
          </div>
        </>
      )}
    </div>
  );
}

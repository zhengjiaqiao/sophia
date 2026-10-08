import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "./i18n.ts";
import { parseBackendError } from "./backendError.ts";
import { BusySlot, Button, FloatingToast, TextField, Toast } from "./ui/index.ts";
import "./ManualModelRow.css";

/// 手填一个模型 id（sophia-dev#117；#252 起在模型提供商的「启用模型」浮层底部）：先试一下，通了才加

/// 框底那一行（也给没有模型时的空态用）：输入 id → `试一下再加`（按下原位忙碌 `正在试调`）→ 通了清空输入框，
/// 不通原话写在下面。回车同按键
export function ManualModelRow({
  onAdd,
  blockedReason,
  placeholder = t("models.manual.placeholder"),
  addLabel = t("models.manual.add"),
  doneText = (model) => t("models.manual.checked", { model }),
  inline = false,
}: {
  /// 通了返回勾上的那个 id（可能是列表里已有的、补全了前缀的那一个），写进下面那句反馈
  onAdd: (modelId: string) => Promise<string | void>;
  /// 还没有密钥：不可用，按下说原因
  blockedReason?: string;
  /// 输入框占位、键上的字、通了之后那一句：全局模型提供商的「启用模型」浮层说「启用」，旧网关说「勾上」
  placeholder?: string;
  addLabel?: string;
  doneText?: (model: string) => string;
  /// 结果写在这一行下面（12 ink-mute 一句，同表单里名称下的同名那一句），不用浮起的提示条：填短表单的弹窗里
  /// 提示条会伸出弹窗、盖住键区（走查 2026-10-08）。改输入框时那一句收起
  inline?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  /// 结果用提示条说（2026-10-06 产品负责人：写在输入框下面好几次都没看见），锚在 `试一下再加` 正下方、
  /// 轻量一行（DESIGN「Patterns › 反馈」：用户按的键出的结果锚在那颗键上，右下只给后台发生的事）：
  /// 勾上了（成功，约 3 秒）、试不通 / 几家同名（做不成，8 秒）。`seq` 让同一种结果再出一次时重新计时
  const [toast, setToast] = useState<{ seq: number; node: ReactNode } | null>(null);
  /// `inline` 时的那一句：通了是 status，试不通是 alert（同提示条的读屏紧急程度）
  const [said, setSaid] = useState<{ kind: "success" | "cannot"; message: string } | null>(null);
  const seq = useRef(0);
  /// `inline` 的那一句出现时滚到看得见（同保存失败的灰面板，走查 2026-10-08）：弹窗里列表滚到底时它在下沿外面，
  /// 通了还会被新加的那一行再往下挤
  const saidRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said !== null) saidRef.current?.scrollIntoView({ block: "nearest" });
  }, [said]);
  const dismiss = useCallback(() => setToast(null), []);
  const show = (kind: "success" | "cannot", message: string) => {
    if (inline) {
      setSaid({ kind, message });
      return;
    }
    seq.current += 1;
    setToast({
      seq: seq.current,
      node: <Toast kind={kind} message={message} onDismiss={dismiss} />,
    });
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
    setSaid(null);
    try {
      const added = await onAdd(id);
      if (mounted.current) {
        setValue("");
        const checked = typeof added === "string" ? added : id;
        show("success", doneText(checked));
      }
    } catch (error) {
      // 几家同名那一句是前端自己抛的（`AmbiguousModel`），不带 `[code]` 前缀，直接用原句；后端的按 `[code] 一句` 拆
      const message =
        error instanceof ManualAddError ? error.message : parseBackendError(String(error)).message;
      if (mounted.current) show("cannot", message);
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
          placeholder={placeholder}
          value={value}
          spellCheck={false}
          onChange={(next) => {
            setValue(next);
            setSaid(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
        />
        {/* 键与锚在它下面的提示条（FloatingToast 以这一层为锚） */}
        <span className="model-list__manual-key">
          <BusySlot busy={busy} label={t("models.manual.adding")}>
            {blockedReason !== undefined ? (
              <Button size="compact" disabled disabledReason={blockedReason}>
                {addLabel}
              </Button>
            ) : id === "" ? (
              <Button size="compact" disabled disabledReason={t("models.manual.needId")}>
                {addLabel}
              </Button>
            ) : (
              <Button size="compact" onClick={() => void add()}>
                {addLabel}
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
      {said ? (
        <p
          ref={saidRef}
          className="model-list__manual-said"
          role={said.kind === "success" ? "status" : "alert"}
          data-kind={said.kind}
        >
          {said.message}
        </p>
      ) : null}
    </div>
  );
}

/// 前端自己说的失败原因（几家同名、该带前缀）：句子已经写好，不按后端的 `[code] 一句` 拆
class ManualAddError extends Error {}

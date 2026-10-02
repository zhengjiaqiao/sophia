import { useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { t } from "../i18n.ts";
import { IconClose, IconEye, IconSearch } from "./icons.tsx";

/// 输入框（DESIGN「输入框」）：凹面——`recess` 底、1px `hairline` 边、`control` 7、高 28、左右 10、13 号字、
/// 占位 `ink-mute`；聚焦时边转 `ink-mute`（不再叠焦点外框）。不含标签与表单布局、不做校验。
///
/// **搜索形态**（`search`）：放大镜 16 在框内左侧（词表里的 `IconSearch`，全应用只有这一枚），
/// 框内右端空着时写熟练路径的快捷键提示（`⌘F`，12 tabular `ink-faint`，⑩ 看得见）、有字时换成 ✕ 清除
/// （12 的 `IconClose`，命中 24）；框里按 Esc 先清空文字（清空了才让给页面的 Esc）。
/// 快捷键本身（菜单「筛选」聚焦它）由页面接：组件只在 `inputRef` 上给出这个输入框。
///
/// **读屏名二选一**：框旁没有可见标签时给 `label`（`筛选`）；有可见标签时（网关表单的 `地址` `密钥`）
/// 页面写 `<label id=… htmlFor=…>`，这里给同一个 `id` 与 `labelledBy`——读屏读的就是看得见的那个字，
/// 点标签聚焦输入框
interface TextFieldBase {
  value: string;
  onChange: (text: string) => void;
  /// 输入框的 id：页面的 `<label htmlFor>` 指向它（点标签聚焦）
  id?: string;
  placeholder?: string;
  /// 搜索形态：放大镜、快捷键提示、清除
  search?: boolean;
  /// 搜索形态框内右端的快捷键提示（`⌘F`）；有字时换成清除键
  shortcut?: string;
  /// 密钥：`password`
  type?: "text" | "password";
  /// 密钥框右端一颗眼睛（24 命中区，同清除键）：按一下显示、再按遮住（DESIGN「安装页 › 要填的」）。
  /// 只对 `password` 起作用
  revealable?: boolean;
  /// 等宽字（链接、命令、键名）：Plex Mono 12
  mono?: boolean;
  /// 定宽（筛选框 200）；不给就占满容器宽
  width?: number;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /// 地址、路径、密钥：不查拼写
  spellCheck?: boolean;
  autoComplete?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/// 读屏名：没有可见标签给 `label`；有可见标签给它的 id（`labelledBy`）
type TextFieldName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

export type TextFieldProps = TextFieldBase & TextFieldName;

export function TextField({
  value,
  onChange,
  id,
  label,
  labelledBy,
  placeholder,
  search = false,
  shortcut,
  type = "text",
  revealable = false,
  mono = false,
  width,
  inputRef,
  autoFocus,
  spellCheck,
  autoComplete,
  onKeyDown,
}: TextFieldProps) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const [shown, setShown] = useState(false);
  const eye = revealable && type === "password";
  const classes = ["ss-textfield"];
  if (search) classes.push("ss-textfield--search");
  if (eye) classes.push("ss-textfield--reveal");
  if (mono) classes.push("ss-textfield--mono");
  return (
    <label className={classes.join(" ")} style={width === undefined ? undefined : { width }}>
      {search ? <IconSearch size={16} /> : null}
      {/* 不用 type="search"：WebKit 的搜索框会自己吃掉 Esc */}
      <input
        ref={ref}
        id={id}
        className="ss-textfield__input"
        type={eye && shown ? "text" : type}
        value={value}
        placeholder={placeholder}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        autoFocus={autoFocus}
        spellCheck={spellCheck}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (search && e.key === "Escape" && value !== "") {
            // 先清空文字；清空了的 Esc 才让给页面（返回、收起）
            e.stopPropagation();
            onChange("");
          }
          onKeyDown?.(e);
        }}
      />
      {search && value !== "" ? (
        <button
          type="button"
          className="ss-textfield__clear"
          title={t("common.textField.clear")}
          aria-label={t("common.textField.clear")}
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <IconClose size={12} />
        </button>
      ) : eye ? (
        <button
          type="button"
          className="ss-textfield__clear"
          title={shown ? t("common.textField.hide") : t("common.textField.show")}
          aria-label={shown ? t("common.textField.hide") : t("common.textField.show")}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          <IconEye size={14} shut={shown} />
        </button>
      ) : search && shortcut ? (
        <span className="ss-textfield__key" aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
    </label>
  );
}

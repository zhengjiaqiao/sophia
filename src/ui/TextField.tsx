import { useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { IconClose, IconSearch } from "./icons.tsx";

/// 输入框（DESIGN「输入框」）：凹面——`recess` 底、1px `hairline` 边、`control` 7、高 28、左右 10、13 号字、
/// 占位 `ink-mute`；聚焦时边转 `ink-mute`（不再叠焦点外框）。不含标签与表单布局、不做校验。
///
/// **搜索形态**（`search`）：放大镜 16 在框内左侧（词表里的 `IconSearch`，全应用只有这一枚），
/// 框内右端空着时写熟练路径的快捷键提示（`⌘F`，12 tabular `ink-faint`，⑩ 看得见）、有字时换成 ✕ 清除
/// （12 的 `IconClose`，命中 24）；框里按 Esc 先清空文字（清空了才让给页面的 Esc）。
/// 快捷键本身（菜单「筛选」聚焦它）由页面接：组件只在 `inputRef` 上给出这个输入框
export interface TextFieldProps {
  value: string;
  onChange: (text: string) => void;
  /// 读屏名，**必填**：框旁通常没有可见标签（`筛选` `地址`）
  label: string;
  placeholder?: string;
  /// 搜索形态：放大镜、快捷键提示、清除
  search?: boolean;
  /// 搜索形态框内右端的快捷键提示（`⌘F`）；有字时换成清除键
  shortcut?: string;
  /// 密钥：`password`
  type?: "text" | "password";
  /// 定宽（筛选框 200）；不给就占满容器宽
  width?: number;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /// 地址、路径、密钥：不查拼写
  spellCheck?: boolean;
  autoComplete?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function TextField({
  value,
  onChange,
  label,
  placeholder,
  search = false,
  shortcut,
  type = "text",
  width,
  inputRef,
  autoFocus,
  spellCheck,
  autoComplete,
  onKeyDown,
}: TextFieldProps) {
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  return (
    <label
      className={search ? "ss-textfield ss-textfield--search" : "ss-textfield"}
      style={width === undefined ? undefined : { width }}
    >
      {search ? <IconSearch size={16} /> : null}
      {/* 不用 type="search"：WebKit 的搜索框会自己吃掉 Esc */}
      <input
        ref={ref}
        className="ss-textfield__input"
        type={type}
        value={value}
        placeholder={placeholder}
        aria-label={label}
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
          title="清除筛选"
          aria-label="清除筛选"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <IconClose size={12} />
        </button>
      ) : search && shortcut ? (
        <span className="ss-textfield__key" aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
    </label>
  );
}

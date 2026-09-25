import { useState } from "react";
import { TextField } from "../index.ts";
import { Block, Family, Specimen } from "./Gallery.tsx";

const noop = () => {};

/// 输入：凹面输入框，含搜索形态
export function InputFamily() {
  const [filter, setFilter] = useState("brain");
  const [url, setUrl] = useState("https://openrouter.ai/api/v1");
  return (
    <Family
      id="input"
      title="输入"
      lead="凹面输入框：高 28、左右 10、13 号字；搜索形态带放大镜、快捷键提示与清除。"
    >
      <Block name="TextField" guide="网关地址与密钥、表单里的一格｜ 不含标签与表单布局、不做校验">
        <Specimen label="空 · 占位" width={360}>
          <TextField
            value=""
            onChange={noop}
            label="地址"
            placeholder="https://example.com/openai/v1"
          />
        </Specimen>
        <Specimen label="有字" width={360}>
          <TextField value={url} onChange={setUrl} label="地址" spellCheck={false} />
        </Specimen>
        <Specimen label="聚焦（边转 ink-mute）" force="focus" width={360}>
          <TextField value="https://openrouter.ai/api/v1" onChange={noop} label="地址" />
        </Specimen>
        <Specimen label="密钥" width={360}>
          <TextField
            value="sk-or-v1-000000"
            onChange={noop}
            label="密钥"
            type="password"
            autoComplete="off"
          />
        </Specimen>
      </Block>

      <Block name="TextField · search" guide="位置页筛选（⌘F）、模型筛选｜ 放大镜只有这一枚">
        <Specimen label="空 · 写快捷键提示">
          <TextField
            value=""
            onChange={noop}
            label="筛选"
            placeholder="筛选"
            search
            shortcut="⌘F"
            width={200}
          />
        </Specimen>
        <Specimen label="有字 · 换成清除">
          <TextField
            value={filter}
            onChange={setFilter}
            label="筛选"
            placeholder="筛选"
            search
            shortcut="⌘F"
            width={200}
          />
        </Specimen>
        <Specimen label="清除键悬停" force="hover">
          <TextField
            value="defuddle"
            onChange={noop}
            label="筛选"
            search
            shortcut="⌘F"
            width={200}
          />
        </Specimen>
        <Specimen label="聚焦" force="focus">
          <TextField
            value=""
            onChange={noop}
            label="筛选"
            placeholder="筛选"
            search
            shortcut="⌘F"
            width={200}
          />
        </Specimen>
        <Specimen label="模型列表里 · 占满宽" width={420}>
          <TextField
            value=""
            onChange={noop}
            label="筛选模型"
            placeholder="筛选 103 个模型"
            search
          />
        </Specimen>
      </Block>
    </Family>
  );
}

import { useEffect, useRef } from "react";
import wordmark from "../../assets/logo/wordmark.svg";
import wordmarkSvg from "../../assets/logo/wordmark.svg?raw";
import { GlassMark } from "./glassMark.ts";

/** 侧栏字标带里的字标 + 「黑猫与玻璃」动效（DESIGN「壳 › 字标在侧栏顶」「字标动效：黑猫与玻璃」）。
    字标是标志资产原样（颜色在资产里，不随界面 token 换色）。静止时就是 <img>；画布叠在字标带上、
    对读屏隐藏、不接指针事件，只在动效期间有内容。
    外层就是命中区（重影左沿到 `A` 右沿 + 4），悬停计时与敲击只在这块里算；它标了
    data-tauri-drag-region="false"：字标带其余空白能拖窗，字标本身不能（它有动效）。
    画布的范围由外面带 data-brand-band 的字标带决定（GlassMark.setup） */
export function AnimatedWordmark() {
  const host = useRef<HTMLSpanElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!host.current || !img.current || !canvas.current) return;
    const mark = new GlassMark(host.current, img.current, canvas.current, wordmarkSvg);
    return () => mark.destroy();
  }, []);

  return (
    <span ref={host} className="brandmark" data-tauri-drag-region="false">
      <img ref={img} src={wordmark} alt="Sophia" className="wordmark" draggable={false} />
      <canvas ref={canvas} className="brandmark__canvas" aria-hidden="true" />
    </span>
  );
}

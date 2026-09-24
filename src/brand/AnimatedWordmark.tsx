import { useEffect, useRef } from "react";
import wordmarkSvg from "../../assets/logo/wordmark.svg?raw";
import { GlassMark, tokenizeWordmark } from "./glassMark.ts";

/// 静止字标：资产 SVG 里写死的填色换成 token（重影 --ctl-border、主体 --ink、重合处 --ctl-edge），
/// 与动效画布同一套色，猫出现、画布接管的那一刻不跳色
const STILL = tokenizeWordmark(wordmarkSvg);

/** 侧栏字标带里的字标 + 「黑猫与玻璃」动效（DESIGN「壳 › 字标在侧栏顶」「字标动效：黑猫与玻璃」）。
    静止时就是内联的字标；画布叠在字标带上、对读屏隐藏、不接指针事件，只在动效期间有内容。
    外层就是命中区（字标框，含左上重影、右到末字母右沿 + 4），悬停计时与敲击只在这块里算；
    它标了 data-tauri-drag-region="false"：字标带其余空白能拖窗，字标本身不能（它有动效）。
    画布的范围由外面带 data-brand-band 的字标带决定（GlassMark.setup） */
export function AnimatedWordmark() {
  const host = useRef<HTMLSpanElement>(null);
  const img = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!host.current || !img.current || !canvas.current) return;
    const mark = new GlassMark(host.current, img.current, canvas.current, wordmarkSvg);
    return () => mark.destroy();
  }, []);

  return (
    <span ref={host} className="brandmark" data-tauri-drag-region="false">
      <span
        ref={img}
        className="wordmark"
        role="img"
        aria-label="Sophia"
        dangerouslySetInnerHTML={{ __html: STILL }}
      />
      <canvas ref={canvas} className="brandmark__canvas" aria-hidden="true" />
    </span>
  );
}

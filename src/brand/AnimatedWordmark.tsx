import { useEffect, useRef } from "react";
import wordmark from "../../assets/logo/wordmark.svg";
import wordmarkSvg from "../../assets/logo/wordmark.svg?raw";
import { GlassMark } from "./glassMark";

/** 顶栏字标 + 「黑猫与玻璃」动效（DESIGN「壳 → 字标动效：黑猫与玻璃」）。
    静止时就是原来的 <img>；画布叠在上面、对读屏隐藏、不接指针事件，只在动效期间有内容。
    外层的 data-tauri-drag-region="false"：顶栏整条是拖窗区，字标这一块不是，
    否则点击会变成拖窗口 */
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

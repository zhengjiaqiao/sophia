import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// DESIGN「刚点亮反色闪 120ms」：第一帧必须是完整反色（黑底 + 白色记号），
// 之前走查截到的灰是 60%→100% 的淡出帧。这里钉住关键帧，防止被改成渐变起步。
const css = readFileSync(new URL("../src/ui/ui.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

function keyframes(name: string): string {
  const m = css.match(new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `缺少 @keyframes ${name}`);
  return m[1];
}

test("ss-flash：0% 起就是完整反色，保持到 60% 才淡出", () => {
  const body = keyframes("ss-flash");
  const first = body.match(/0%,\s*60%\s*\{([^}]*)\}/);
  assert.ok(first, "首段必须是 0%, 60% 同一帧");
  assert.match(first[1], /background-color:\s*var\(--ink\)/);
  assert.match(first[1], /color:\s*var\(--canvas\)/);
});

test("ss-flash-dot：记号在同一段里转白（实心点与空心环都跟 currentColor）", () => {
  const body = keyframes("ss-flash-dot");
  assert.match(body, /0%,\s*60%\s*\{[^}]*color:\s*var\(--canvas\)/);
});

test("闪烁时长是 120ms 档", () => {
  assert.match(tokens, /--motion-fast:\s*120ms/);
});

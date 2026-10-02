/// 样张专用：把「悬停 / 按下 / 键盘焦点」钉住，静态地摆出来（给 /design-sync 生成预览、做视觉回归）。
///
/// 做法：页面上所有样式表里凡是带 `:hover` `:active` `:focus-visible` `:focus-within` 的规则，各复制一份，
/// 把伪类换成属性选择器 `[data-force~="hover"]` 等，插进一张样张自己的样式表。`Specimen force="hover"` 把这个属性
/// 挂在样张框里的**每一个元素**上——指针停在最里层元素上时，它的祖先也都在 :hover，所以每层都挂是对的；
/// 键盘焦点只挂在框里第一个能聚焦的元素上（`focus`），它的祖先挂 `focus-within`。
/// 组件的真样式一行不改；只在开发时的样张里生效。
/// `html[data-input="pointer"]` 那几条（指针操作时收掉焦点框）不复制：钉住的焦点就是要看键盘焦点的样子

const PSEUDO: Array<[RegExp, string]> = [
  [/:hover\b/g, '[data-force~="hover"]'],
  [/:active\b/g, '[data-force~="active"]'],
  [/:focus-visible\b/g, '[data-force~="focus"]'],
  [/:focus-within\b/g, '[data-force~="focus-within"]'],
];

function forcedSelector(selector: string): string | null {
  if (!/:(hover|active|focus-visible|focus-within)\b/.test(selector)) return null;
  if (/data-input="pointer"/.test(selector)) return null;
  let out = selector;
  for (const [re, attr] of PSEUDO) out = out.replace(re, attr);
  return out;
}

/// 一条规则（含 @media / @supports 里嵌的）→ 钉住版的 CSS 文本；没有要钉的返回空串
function forcedText(rule: CSSRule): string {
  if (rule instanceof CSSStyleRule) {
    const sel = forcedSelector(rule.selectorText);
    return sel ? `${sel} { ${rule.style.cssText} }` : "";
  }
  if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
    const inner = Array.from(rule.cssRules).map(forcedText).filter(Boolean).join("\n");
    if (!inner) return "";
    const head =
      rule instanceof CSSMediaRule
        ? `@media ${rule.conditionText}`
        : `@supports ${rule.conditionText}`;
    return `${head} {\n${inner}\n}`;
  }
  return "";
}

let installed: HTMLStyleElement | null = null;

/// 扫一遍此刻的样式表，装上钉住版（重复调用会换掉上一次的）
export function installForcedStates(): void {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode === installed) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 跨域样式表读不到，跳过
    }
    for (const rule of Array.from(rules)) {
      const text = forcedText(rule);
      if (text) parts.push(text);
    }
  }
  installed?.remove();
  installed = document.createElement("style");
  installed.dataset.gallery = "forced-states";
  installed.textContent = parts.join("\n");
  document.head.appendChild(installed);
}

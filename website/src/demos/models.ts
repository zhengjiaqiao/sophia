/// 模型区三步卡的纯逻辑（R9、AC7）：选一家服务商 → 贴上密钥 → 每个 agent 一个开关 → 结果句。
/// 不 import astro / DOM；组件里的脚本只管把状态画出来、把点击转成这里的函数。
import { fillTemplate } from "../lib/template.ts";

/// 示例的 6 家服务商（品牌名不翻译）。测试核对它们都在应用的预设里
export const DEMO_PROVIDERS = ["OpenRouter", "DeepSeek", "Kimi", "Mistral", "GLM", "Qwen"] as const;

/// 打码的示例密钥（演示用，不是任何真实密钥的形状）
export const DEMO_KEY_MASK = "sk-••••••••••••••••3f9a";

export interface DemoState {
  provider: string | null;
  /** 密钥是否已贴上 */
  key: boolean;
  /** 开着的 agent id，顺序同名单 */
  on: string[];
  /// 开关动过没有：动过又全关了才说「已改回官方模型」，没动过什么也不说
  touched: boolean;
}

export type Result =
  | { kind: "none" }
  | { kind: "off" }
  | { kind: "testing"; agents: string[] }
  | { kind: "done"; agents: string[] };

export const initialState = (): DemoState => ({ provider: null, key: false, on: [], touched: false });

/// 关 JS / 减少动效时直接给的终态：第一家服务商、密钥已填、名单里的 agent 全开
export const finalState = (agentIds: readonly string[]): DemoState => ({
  provider: DEMO_PROVIDERS[0],
  key: true,
  on: [...agentIds],
  touched: true,
});

export const pickProvider = (s: DemoState, provider: string): DemoState => ({ ...s, provider });
export const fillKey = (s: DemoState): DemoState => ({ ...s, key: true });

/// 点一下开关。`agentIds` 是 SITE.agents 的 id 名单（唯一来源，R17.1）；不在名单里的直接报错
export function toggleAgent(s: DemoState, id: string, agentIds: readonly string[]): DemoState {
  if (!agentIds.includes(id)) throw new Error(`agent ${id} 不在名单里`); // i18n-exempt: 开发期错误，不进页面
  const next = s.on.includes(id) ? s.on.filter((x) => x !== id) : [...s.on, id];
  return { ...s, on: agentIds.filter((x) => next.includes(x)), touched: true };
}

/// 当前亮到第几步（0 起）：有开关打开就是 3（做完），否则看密钥、服务商
export function stepOf(s: DemoState): 0 | 1 | 2 | 3 {
  if (s.on.length) return 3;
  if (s.key) return 2;
  return s.provider ? 1 : 0;
}

/// 结果句的种类。`settled`：开关打开后的「试了一次」阶段是否已过
export function resultOf(s: DemoState, settled: boolean): Result {
  if (!s.on.length) return s.touched ? { kind: "off" } : { kind: "none" };
  return { kind: settled ? "done" : "testing", agents: s.on };
}

export interface ResultTexts {
  ok: string;
  testing: string;
  restarted: string;
  off: string;
}

/// 结果句：`lead` 是要加粗的开头（「好了。」），`rest` 是其余。`nameOf` 把 id 换成显示名
export function resultText(
  r: Result,
  texts: ResultTexts,
  nameOf: (ids: string[]) => string[],
  sep: string,
): { lead: string; rest: string } {
  switch (r.kind) {
    case "none":
      return { lead: "", rest: "" };
    case "off":
      return { lead: "", rest: texts.off };
    case "testing":
      return { lead: "", rest: fillTemplate(texts.testing, { agent: nameOf(r.agents).join(sep) }) };
    case "done":
      return { lead: texts.ok, rest: fillTemplate(texts.restarted, { agent: nameOf(r.agents).join(sep) }) };
  }
}

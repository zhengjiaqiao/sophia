/// 设置「skill 和 MCP 页显示的 agent」一个品牌一个勾（#251，画板第 4 屏；GLOSSARY「品牌」「产品」）的纯逻辑：
/// 勾选行下那行小字列这个品牌已装的产品，图标取哪个产品的。不碰 api、不产 JSX，tests/settings-brands.test.ts 直接测
import { listText, t, type MessageKey } from "./i18n.ts";
import type { BrandStatus, HarnessStatus } from "./types.ts";

/// 产品名按界面语言写的那几个（桌面版在中文里叫「桌面应用」「桌面版」，GLOSSARY「产品」）；其余就是 core 给的名字
const LOCALIZED: Record<string, MessageKey> = {
  "claude-desktop": "settings.agents.product.claudeDesktop",
  "kimi-desktop": "settings.agents.product.kimiDesktop",
};

/// 产品在界面上的名字：中文里另有叫法的按界面语言写（`Kimi 桌面版`），其余就是 core 给的名字 `name`。
/// 设置、安装页勾选行、skill 页合成列的列头都经它，同一个产品处处同名
export const productLabel = (id: string, name: string): string => {
  const key = LOCALIZED[id];
  return key ? t(key) : name;
};

const productName = (id: string, products: ReadonlyArray<HarnessStatus>): string =>
  productLabel(id, products.find((p) => p.id === id)?.displayName ?? id);

/// 勾选行下的小字：`Claude Code、Claude 桌面应用`。只装了一个（或没装）时不写——名字就是那个产品
export function brandProductsLine(
  brand: BrandStatus,
  products: ReadonlyArray<HarnessStatus>,
): string | null {
  if (brand.installedProducts.length < 2) return null;
  return listText(brand.installedProducts.map((id) => productName(id, products)));
}

/// 品牌的图标：第一个已装的产品的（同品牌的产品同一个标志）；没装取表里第一个产品
export function brandIconId(brand: BrandStatus, products: ReadonlyArray<HarnessStatus>): string {
  return brand.installedProducts[0] ?? products.find((p) => p.brand === brand.id)?.id ?? brand.id;
}

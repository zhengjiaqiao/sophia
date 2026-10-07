/// 语言菜单选语言时写的 cookie（spec「语言跳转」）：名字 `lang`，值是页面的语言码（zh-Hans / zh-Hant / en），
/// 站内通用，记一年。功能性 cookie，不需要同意。首页的语言跳转（lib/homeRedirect.ts）读它：有它就按它跳，不再看浏览器语言。
import { isLang, LANG_COOKIE } from "./langs.ts";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

export function langCookie(code: string): string {
  if (!isLang(code)) throw new Error(`unknown lang code: ${code}`);
  return `${LANG_COOKIE}=${code}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax`;
}

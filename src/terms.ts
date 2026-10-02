/// 界面里几个概念叫什么（2026-09-30 产品负责人：「来源」「位置」难懂）；句子在 `locales/`，这里只管按领域挑词：
/// - 表格里一行在哪儿生效（用户级 / 某个项目）叫「生效范围」——原「位置」；Codex 叫 Skill Scope，Claude Code 中文文档把
///   MCP 的 scope 译作「范围」。单写「范围」嫌抽象（2026-09-30 产品负责人），加上「生效」说清是什么的范围
/// - skill 的原件放在哪个文件夹（通用仓库、WeiboAP……）叫「原件位置」——原「来源」
/// - MCP 服务写在哪个文件里叫「配置文件」——原「来源」；「管理来源」改叫「自动同步」，不再添加来源
///   （spec 2026-09-30-mcp-config-scope）
import { t } from "./i18n.ts";

export type TermsDomain = "skills" | "mcp";

/// 一行在哪儿生效（用户级 / 某个项目）
export const scopeWord = () => t("common.term.scope");

/// MCP：服务写在哪个配置文件里（表格那一列、自动同步页那一列）
export const mcpFileWord = () => t("common.term.mcpFile");

/// MCP 的自动同步页与页面头那颗键（原「管理来源」）
export const autoSyncWord = () => t("common.term.autoSync");

/// 管原件放在哪的那件事的名字：skill「原件位置」，MCP「配置文件」
export const sourceNoun = (domain: TermsDomain): string =>
  domain === "skills" ? t("common.term.skillOrigin") : mcpFileWord();

/// 安装类推入页（安装页、从链接安装、从 JSON 添加）要调的后端与系统能力，收成一个接口：
/// 页面组件只吃 props，默认用 `marketService`（经 api.ts 调 Tauri 命令）；测试、样张可以换一份假的。
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../api.ts";
import { stripFrontmatter } from "./markdownText.ts";
import type {
  InstallOutcome,
  McpInstallRequest,
  McpParseResult,
  McpReport,
  McpTargetCheck,
  McpUndoReport,
  ResolvedLink,
  SkillInstallPreview,
  SkillInstallRequest,
  SyncReport,
} from "../types.ts";

export interface MarketService {
  planSkillInstall(request: SkillInstallRequest): Promise<SkillInstallPreview>;
  installSkill(request: SkillInstallRequest): Promise<InstallOutcome>;
  /// 认不出、仓库读不到时抛一句给用户看的中文
  resolveLink(input: string): Promise<ResolvedLink>;
  planMcpInstall(request: McpInstallRequest): Promise<McpTargetCheck[]>;
  /// `values` 里的密钥只进这一次调用，不存、不打日志
  installMcp(request: McpInstallRequest): Promise<McpReport>;
  parseMcpJson(text: string): Promise<McpParseResult>;
  undoSkill(undoId: string): Promise<SyncReport>;
  undoMcp(undoId: string): Promise<McpUndoReport>;
  /// `在访达中显示 ↗`
  reveal(path: string): void;
  /// `在 GitHub 打开 ↗` `npm 上的说明 ↗`：系统浏览器
  openUrl(url: string): void;
  /// 进页时读剪贴板（认得出才填）；读不到给空串
  readClipboard(): Promise<string>;
  /// 安装页那一句说明：从列表直接装时列表里没有，取 SKILL.md 的 frontmatter `description`
  /// （走 raw，不占 GitHub 接口次数）；取不到给 null。可选：样张、测试不给就不写这一句
  skillDescription?(
    repo: string,
    branch: string | null,
    path: string | null,
    name: string,
  ): Promise<string | null>;
}

export const marketService: MarketService = {
  planSkillInstall: api.marketPlanSkillInstall,
  installSkill: api.marketInstallSkill,
  resolveLink: api.marketResolveLink,
  planMcpInstall: api.marketPlanMcpInstall,
  installMcp: api.marketInstallMcp,
  parseMcpJson: api.marketParseMcpJson,
  undoSkill: api.marketUndo,
  undoMcp: api.mcpUndoWrite,
  reveal: (path) => void api.revealInDir(path).catch(() => undefined),
  openUrl: (url) => void openUrl(url).catch(() => undefined),
  skillDescription: async (repo, branch, path, name) => {
    try {
      const readme = await api.marketSkillReadme(repo, branch, path, name);
      return stripFrontmatter(readme.text).description;
    } catch {
      return null;
    }
  },
  readClipboard: async () => {
    try {
      return (await readText()) ?? "";
    } catch {
      // 没给读剪贴板的权限、剪贴板里不是文字：当它是空的
      return "";
    }
  },
};

/// 调用失败时给用户看的一句：命令的 Err 本来就是中文句子
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

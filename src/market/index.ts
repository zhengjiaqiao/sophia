// 发现与安装（spec 2026-09-27-skill-mcp-market）的界面都放在 src/market/ 下：
// 发现列表、介绍页、安装页、从链接安装、从 JSON 添加、更新提示条（归属见
// docs/plans/2026-09-27-skill-mcp-market-plan.md）。
// ── 发现列表与介绍页（T7）──
export { DiscoverPane, SEARCH_DELAY_MS } from "./DiscoverPane";
export type { DiscoverPaneProps } from "./DiscoverPane";
export { IntroPage } from "./IntroPage";
export type { IntroPageProps } from "./IntroPage";

// ── 安装类推入页（T8）：只吃 props，由 T11 接进 SKILLS / MCP 页 ──
export { InstallPage, SkillInstallBody } from "./InstallPage.tsx";
export type { InstallPageBase, InstallPageProps, SkillTarget } from "./InstallPage.tsx";
export { McpInstallPage } from "./McpInstallPage.tsx";
export type { McpInstallPageProps } from "./McpInstallPage.tsx";
export { LinkPage } from "./LinkPage.tsx";
export type { LinkPageProps } from "./LinkPage.tsx";
export { JsonPage } from "./JsonPage.tsx";
export type { JsonPageProps } from "./JsonPage.tsx";
export { InstalledToast } from "./InstalledToast.tsx";
export type { InstalledNotice } from "./InstalledToast.tsx";
export type { InstallPlaces } from "./InstallParts.tsx";
export { marketService } from "./service.ts";
export type { MarketService } from "./service.ts";
export {
  mcpInstalledToast,
  skillInstalledToast,
  looksLikeGithub,
  type AgentRef,
} from "./installView.ts";

// ── 接线（T11）：发现一面的推入页与纸窗、⌘Z ──
export { DiscoverFlow, PageUndo, skillTargetOf } from "./DiscoverFlow.tsx";
export type { DiscoverFlowProps, InstallContext } from "./DiscoverFlow.tsx";
export type { InstallFrom } from "./DiscoverPane";

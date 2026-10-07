import { t, type Lang, type MessageKey } from "./i18n.ts";
import { parseBackendError } from "./backendError.ts";

/// 网络出错说人话（spec #248，issue #253；画板「国产 agent 与国内网络」第 7 屏）。
/// 后端把底层错误分成四类（`src-tauri/src/net_kind.rs`）：连不上 / 太慢超时 / 被限流 / 别的，按命令错误的老约定
/// `[类] 一句\n[detail] 原文` 抛过来（`parseBackendError` 拆）；
/// 这里按场景（检查更新、下载更新、下载 skill）出主句与出口。原文进主句前面的「!」，不进主句。纯逻辑，方便测试

export type NetKind = "unreachable" | "timeout" | "rateLimited" | "other";

/// 后端给的一次失败：哪一类 + 原文（已去隐私）
export interface NetProblem {
  kind: NetKind;
  detail: string;
}

/// 更新的两个场景：检查与下载分开说
export type UpdateScene = "checkUpdate" | "downloadUpdate";

/// 主句与出口。`retry`：留在 Sophia 里再试一次（`proxy` 时键上写「开着代理再试一次」，连不上时给）；
/// 句后的「到官网下载 ↗」四类都有，不在这里
export interface NetFailureText {
  message: string;
  retry: "plain" | "proxy" | null;
}

/// 命令错误前缀里的类名 → 类（后端 `NetKind::code`）
const KIND_OF_CODE = new Map<string, NetKind>([
  ["unreachable", "unreachable"],
  ["timeout", "timeout"],
  ["rate_limited", "rateLimited"],
  ["other", "other"],
]);

/// 抛出来的值 → 前缀拆开的一句、类与原文
function parsed(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const { code, message, detail } = parseBackendError(text);
  return { text, message, detail, kind: KIND_OF_CODE.get(code) ?? "other" };
}

const UPDATE_KEY: Record<UpdateScene, Record<NetKind, MessageKey>> = {
  checkUpdate: {
    unreachable: "common.net.checkUpdate.unreachable",
    timeout: "common.net.checkUpdate.timeout",
    rateLimited: "common.net.update.rateLimited",
    other: "common.net.checkUpdate.other",
  },
  downloadUpdate: {
    unreachable: "common.net.download.unreachable",
    timeout: "common.net.download.timeout",
    rateLimited: "common.net.update.rateLimited",
    other: "common.net.downloadUpdate.other",
  },
};

/// 下载 skill 只分三类说；别的（仓库不在、太大）用后端那一句
const SKILL_KEY: Record<Exclude<NetKind, "other">, MessageKey> = {
  unreachable: "common.net.download.unreachable",
  timeout: "common.net.download.timeout",
  rateLimited: "common.net.downloadSkill.rateLimited",
};

/// 更新失败的主句与出口（画板第 7 屏的表）：连不上给「开着代理再试一次」，超时给「再试一次」，
/// 限流与别的再试也没用、只给「到官网下载 ↗」
export function netFailureText(scene: UpdateScene, kind: NetKind): NetFailureText {
  return {
    message: t(UPDATE_KEY[scene][kind]),
    retry: kind === "unreachable" ? "proxy" : kind === "timeout" ? "plain" : null,
  };
}

/// 再试一次的键上写什么
export function retryLabel(retry: "plain" | "proxy"): string {
  return retry === "proxy" ? t("common.net.retryWithProxy") : t("common.net.retry");
}

/// 抛出来的值 → 一次失败。没有类前缀的（前端自己抛的）算「别的」，整段当原文
export function netProblemOf(error: unknown): NetProblem {
  const { text, detail, kind } = parsed(error);
  return { kind, detail: detail ?? text };
}

/// 下载 skill 失败给界面的样子：网络三类换成场景主句、给「开着代理再试一次」；别的照后端那一句。`detail` 进「!」
export interface SkillDownloadFailure {
  message: string;
  retryWithProxy: boolean;
  detail: string | null;
}

export function skillDownloadFailure(error: unknown): SkillDownloadFailure {
  const { message, detail, kind } = parsed(error);
  const key = kind === "other" ? undefined : SKILL_KEY[kind];
  return {
    message: key ? t(key) : message,
    retryWithProxy: key !== undefined,
    detail: detail ?? null,
  };
}

/// 官网的下载区（官网 spec R2 / R12：英文在 `/`，中文在 `/zh-hans/`、`/zh-hant/`，下载区锚点 `#install`）。
/// 官网的下载按钮对国内访客走国内线路（spec #248）
export function websiteDownloadUrl(lang: Lang): string {
  const path = lang === "en" ? "/" : `/${lang.toLowerCase()}/`;
  return `https://sophiakit.com${path}#install`;
}

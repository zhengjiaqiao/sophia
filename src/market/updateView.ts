/// 「有更新」（spec 2026-09-27-skill-mcp-market R14 R15；DESIGN「发现与安装 › 有更新」「设置 › `Skills 和 MCP`」）的纯逻辑：
/// 提示条那一句、哪些行挂 `有更新`、抽屉末行与 `看改动 ↗` 的地址、更新前要不要确认与确认框写什么、
/// 更新之后的纸窗、设置里 `自动检查 skill 更新` 那一行的灰字。不碰 api、不产 JSX，tests/market-update.test.ts 直接测。
/// 时刻一律是 unix 秒（与 core 一致）。

import { listText, t, tn, tSpaced, type MessageKey } from "../i18n.ts";
import type { InstallOutcome, LocationKey, MarketFallback, UpdateInfo } from "../types.ts";
import { shortDate } from "../dateText.ts";

/// GitHub 未登录每小时 60 次；被限流时在触发处说这一句，不弹窗、不自动重试（R16）
export const rateLimited = () => t("market.rateLimited");

/// 行上名字后的灰字（12 ink-mute，不是键）
export const updateMark = () => t("market.update.mark");

/// 一个 skill 在一个位置里的键：同名 skill 在不同位置各算各的
export function updateKey(u: { location: LocationKey; name: string }): string {
  return `${u.location}\u0000${u.name}`;
}

/// 当前位置里的新版本；`scope` 为 null＝`全部`
export function scopeUpdates(
  updates: readonly UpdateInfo[],
  scope: LocationKey | null,
): UpdateInfo[] {
  return scope === null ? [...updates] : updates.filter((u) => u.location === scope);
}

/// 提示条的说明句
export function stripSentence(count: number): string {
  return tn("market.update.strip", count);
}

/// 提示条出不出：core 说这一批没关掉（`stripVisible`），且当前位置里真有新版本
export function stripOpen(stripVisible: boolean, scoped: readonly UpdateInfo[]): boolean {
  return stripVisible && scoped.length > 0;
}

/// `只看这些` 按下后键换成 `显示全部`
export function onlyTheseLabel(onlyThese: boolean): string {
  return onlyThese ? t("market.update.showAll") : t("market.update.onlyThese");
}

/// 表格此刻只列有更新的行吗：按下了 `只看这些`、且当前位置里还有新版本（都更新完了就回到全部）
export function onlyTheseActive(onlyThese: boolean, scoped: readonly UpdateInfo[]): boolean {
  return onlyThese && scoped.length > 0;
}

/// 这一行有没有新版本（有就是那一条）。行给了原件路径时按路径认——同一个位置里同名的两份（×2）
/// 只有真正装自那个仓库的那一份挂 `有更新`；没给路径时按位置 + 名字认
export function updateForRow(
  updates: readonly UpdateInfo[],
  row: { location: LocationKey; name: string; path?: string },
): UpdateInfo | undefined {
  if (row.path !== undefined) return updates.find((u) => u.dir === row.path);
  return updates.find((u) => u.location === row.location && u.name === row.name);
}

/// `看改动 ↗`：这个文件夹在 GitHub 上的提交记录 `https://github.com/{o}/{r}/commits/{分支}/{路径}`。
/// 各段分别编码（分支、路径里的 `/` 保留）；仓库根上的 skill 没有路径段
export function commitsUrl(repo: string, branch: string, path: string): string {
  const seg = (s: string) =>
    s
      .split("/")
      .filter((p) => p !== "")
      .map(encodeURIComponent);
  return ["https://github.com", ...seg(repo), "commits", ...seg(branch), ...seg(path)].join("/");
}

/// 抽屉末行：`来自 anthropics/skills · 有新版本` + `更新` + `看改动 ↗`
export function drawerLine(u: UpdateInfo): { from: string; text: string; url: string } {
  return {
    from: t("market.update.from", { repo: u.repo }),
    text: t("market.update.fromNew", { repo: u.repo }),
    url: commitsUrl(u.repo, u.branch, u.path),
  };
}

/// 按 × 要记下的这一批：此刻全部新版本的 tree SHA，去重、排序。
/// 整批替换 core 里记的那一份，所以给全部位置的，不只当前位置的（只给当前位置的会把别处关掉的又放出来）
export function dismissBatch(updates: readonly UpdateInfo[]): string[] {
  return [...new Set(updates.map((u) => u.remoteTreeSha))].sort();
}

/// 要不要先确认：涉及的 skill 里有本地改过的（会覆盖你改过的文件）；都没改过就直接更新，给撤销
export function needsConfirm(targets: readonly UpdateInfo[]): boolean {
  return targets.some((u) => u.locallyModified);
}

/// 确认框（窗口正中，`Confirm`）
export interface UpdateConfirmModel {
  /// `更新 2 个 skill？` / 单个 `更新 pdf？`
  title: string;
  /// `pdf 里有 2 个文件你改过，更新会覆盖这些改动；skill-creator 没改过。`
  body: string;
  /// 改过的文件（`recess` 底 `mono`）；改过的不止一个 skill 时带上 skill 名 `pdf/SKILL.md`
  files: string[];
  /// 墨键：`全部更新`，单个时 `更新`
  confirmLabel: string;
}

export function confirmModel(targets: readonly UpdateInfo[]): UpdateConfirmModel {
  const single = targets.length === 1;
  const modified = targets.filter((u) => u.locallyModified);
  const cleanNames = targets.filter((u) => !u.locallyModified).map((u) => u.name);
  // 数得出改了哪些文件的，说几个文件；数不出的（只改了权限位，或取不到装时那一版的文件清单），
  // 只说本地改过——不猜是权限（2026-09-27 真人测试 UPD-7：取不到清单时被说成了「文件权限」）
  const withFiles = modified.filter((u) => u.changedFiles.length > 0);
  const unknown = modified.filter((u) => u.changedFiles.length === 0);
  // 两句接成一段：改过的一句，加上没改过的（有就用分号接上）。每种组合一个整句键，英文语序各自写
  const clean = cleanNames.length > 0 ? listText(cleanNames, "enum") : null;
  let body: string;
  if (withFiles.length === 0) {
    const names = listText(
      unknown.map((u) => u.name),
      "enum",
    );
    body = clean
      ? t("market.update.localOnlyClean", { names, clean })
      : t("market.update.localOnly", { names });
  } else {
    const parts = [
      ...withFiles.map((u) =>
        tn("market.update.fileCount", u.changedFiles.length, { name: u.name }),
      ),
      ...unknown.map((u) => u.name),
    ];
    const list = listText(parts, "enum");
    // 以名字（西文）收尾时与后面的汉字隔一个空格：`pdf 你改过`，`2 个文件你改过`（见 tSpaced）
    body = clean
      ? tSpaced("market.update.changedClean", { list, clean })
      : tSpaced("market.update.changed", { list });
  }
  const prefix = withFiles.length > 1;
  return {
    title: single
      ? t("market.update.confirmTitleOne", { name: targets[0].name })
      : tn("market.update.confirmTitleMany", targets.length),
    body,
    files: withFiles.flatMap((u) => u.changedFiles.map((f) => (prefix ? `${u.name}/${f}` : f))),
    confirmLabel: single ? t("market.update.confirmOne") : t("market.update.confirmAll"),
  };
}

/// 更新之后右下那一窗（`Toast` 的参数）
export interface UpdateToastModel {
  kind: "success" | "cannot" | "partial";
  /// 整句（目录键）：`{names}` 是名字，不止一个时是 `count` 的数量读数
  sentence: MessageKey;
  /// 一个时写名字
  names?: string[];
  /// 不止一个时写 `2 个 skill`
  count?: number;
  tally?: { done: number; failed: number };
  reason?: string;
  /// 给不给 `撤销`：有更新成了的、且 core 给了撤销 id
  undoable: boolean;
}

/// `✓ 已更新 2 个 skill` + `撤销`；单个 `✓ 已更新 pdf`；都没成 `⊘ pdf 更新失败 · 原因`；部分成 `! 已更新 1 ✓ · 1 ⊘ · docx：原因`
export function updatedToast(outcome: InstallOutcome): UpdateToastModel {
  const done = outcome.installed;
  const failed = Object.entries(outcome.failed);
  const who = (names: string[]) => (names.length === 1 ? { names } : { count: names.length });
  if (failed.length === 0) {
    return {
      kind: "success",
      sentence: "market.toast.updateDone",
      ...who(done),
      undoable: outcome.undoId !== null,
    };
  }
  const [firstName, firstReason] = failed[0];
  if (done.length === 0) {
    return {
      kind: "cannot",
      sentence: "market.toast.updateCannot",
      ...who(failed.map(([n]) => n)),
      reason: firstReason,
      undoable: false,
    };
  }
  return {
    kind: "partial",
    sentence: "market.toast.updatePartial",
    tally: { done: done.length, failed: failed.length },
    reason: t("market.toast.failedReason", { name: firstName, reason: firstReason }),
    undoable: outcome.undoId !== null,
  };
}

/// 更新成了的从列表里拿掉（按位置 + 名字，只拿这一次涉及的）；返回剩下的与拿掉的（撤销时放回）
export function afterUpdate(
  updates: readonly UpdateInfo[],
  targets: readonly UpdateInfo[],
  installed: readonly string[],
): { rest: UpdateInfo[]; removed: UpdateInfo[] } {
  const done = new Set(targets.filter((tg) => installed.includes(tg.name)).map(updateKey));
  return {
    rest: updates.filter((u) => !done.has(updateKey(u))),
    removed: updates.filter((u) => done.has(updateKey(u))),
  };
}

/// 撤销之后把拿掉的放回去（已经又在列表里的不重复放）
export function restoreUpdates(
  updates: readonly UpdateInfo[],
  removed: readonly UpdateInfo[],
): UpdateInfo[] {
  const have = new Set(updates.map(updateKey));
  return [...updates, ...removed.filter((u) => !have.has(updateKey(u)))];
}

/// 用户按下 `立即检查`（或更新）时，查的结果是降级来的：在触发处说哪一句。自动检查不说
export function fallbackNotice(fallback: MarketFallback | null): string | null {
  if (fallback === null) return null;
  if (fallback.rateLimited) return rateLimited();
  // 不是连不上（读不懂、断了、超时……）：按后端给的原因说（spec 2026-10-04-local-diagnostics R10）
  return fallback.reason || t("market.fallback.offline", { service: fallback.service });
}

const pad = (n: number) => String(n).padStart(2, "0");

/// 时刻读数：`今天 14:32`、`昨天 09:05`、`9月20日 14:32`，跨年 `2025年9月20日 14:32`（本地时区）
export function clockText(at: number, now: Date = new Date()): string {
  const d = new Date(at * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return t("market.clock.today", { time });
  if (days === 1) return t("market.clock.yesterday", { time });
  // 日期按界面语言排（`9月20日` / `Sep 20`，跨年带年份），与抽屉里的「改于」同一个写法
  return t("market.clock.date", { date: shortDate(d.getTime(), now), time });
}

/// 设置 `Skills 和 MCP` 一节 `自动检查 skill 更新` 那一行的灰字（2026-10-06 并成一行）：
/// `打开 Skills 页时检查，每 6 小时最多一次 · 上次：今天 12:21`。这一程查过且没有更新时接 `，没有更新`；
/// 有更新不写数量（数量写在右端的 `看 N 个更新` 上）；`count` 为 null＝这一程还没拿到结果（只写时刻）；
/// 从没查过写 `还没有检查过`
export function autoCheckNote(
  checkedAt: number | null,
  count: number | null,
  now: Date = new Date(),
): string {
  const when = t("settings.skillUpdates.autoNote");
  if (checkedAt === null) return `${when} · ${t("market.update.neverChecked")}`;
  const time = clockText(checkedAt, now);
  const last =
    count === 0
      ? t("settings.skillUpdates.lastNone", { time })
      : t("settings.skillUpdates.last", { time });
  return `${when} · ${last}`;
}

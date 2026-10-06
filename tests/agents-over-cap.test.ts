/// SKILLS 页「装了 N 个 agent，列表里最多显示 4 个」那块灰面板的规则（issue #109；src/agentsOverCap.ts）
import assert from "node:assert/strict";
import test from "node:test";
import { setLocale, t } from "../src/i18n.ts";
import {
  agentsOverCapOf,
  keepDismissed,
  overCapText,
  overCapWanted,
} from "../src/agentsOverCap.ts";
import type { HarnessList } from "../src/types.ts";

/// agent 表的先后：前面的先列
const TABLE: Array<[string, string]> = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["cline", "Cline"],
  ["gemini-cli", "Gemini CLI"],
  ["opencode", "OpenCode"],
  ["windsurf", "Windsurf"],
];

/// `installed`：装了哪些；`shown`：其中勾着的（不给就按表先后勾前 4 个，同 core 的 reconcile_shown）
function list(installed: string[], shown?: string[]): HarnessList {
  const on = new Set(shown ?? installed.slice(0, 4));
  return {
    maxShown: 4,
    harnesses: TABLE.map(([id, displayName]) => ({
      id,
      displayName,
      installed: installed.includes(id),
      enabled: !installed.includes(id) || on.has(id),
    })),
  };
}

const SIX = ["claude-code", "codex", "cursor", "cline", "gemini-cli", "opencode"];

test("装的多于上限才出：恰好 4 个、更少都不出；5 个、6 个出；名单还没读回来不出", () => {
  assert.equal(agentsOverCapOf(null), null);
  assert.equal(agentsOverCapOf(list([])), null);
  assert.equal(agentsOverCapOf(list(SIX.slice(0, 3))), null);
  assert.equal(agentsOverCapOf(list(SIX.slice(0, 4))), null);
  const five = agentsOverCapOf(list(SIX.slice(0, 5)));
  assert.ok(five);
  assert.equal(five.installed, 5);
  assert.deepEqual(five.hidden, ["Gemini CLI"]);
  const six = agentsOverCapOf(list(SIX));
  assert.ok(six);
  assert.equal(six.installed, 6);
  assert.equal(six.max, 4);
  assert.deepEqual(six.hidden, ["Gemini CLI", "OpenCode"]);
});

test("没显示的按 agent 表先后列出；用户自己又取消勾了几个，那几个也算没显示", () => {
  const cap = agentsOverCapOf(list(SIX, ["claude-code", "gemini-cli"]));
  assert.ok(cap);
  assert.equal(cap.installed, 6);
  assert.deepEqual(cap.hidden, ["Codex", "Cursor", "Cline", "OpenCode"]);
  // 装了 4 个、自己取消勾了 2 个：没超上限，不出（那是用户自己选的）
  assert.equal(agentsOverCapOf(list(SIX.slice(0, 4), ["codex", "cline"])), null);
});

test("文字里的数字与名字：简体、繁體、English", () => {
  const six = agentsOverCapOf(list(SIX));
  assert.ok(six);
  assert.deepEqual(overCapText(six), {
    message: "装了 6 个 agent，列表里最多显示 4 个",
    reason: "Gemini CLI、OpenCode 没显示",
  });
  const five = agentsOverCapOf(list(SIX.slice(0, 5)));
  assert.ok(five);
  assert.deepEqual(overCapText(five), {
    message: "装了 5 个 agent，列表里最多显示 4 个",
    reason: "Gemini CLI 没显示",
  });
  assert.equal(t("skills.agentsOverCap.dismiss"), "关闭，装的 agent 有变化时再提示");
  assert.equal(t("skills.agentsOverCap.settings"), "去设置");
  try {
    setLocale("zh-Hant");
    assert.deepEqual(overCapText(six), {
      message: "裝了 6 個 agent，清單裡最多顯示 4 個",
      reason: "Gemini CLI、OpenCode 沒顯示",
    });
    setLocale("en");
    assert.deepEqual(overCapText(six), {
      message: "6 agents installed; the list shows up to 4",
      reason: "Gemini CLI and OpenCode aren't shown",
    });
    assert.equal(overCapText(five).reason, "Gemini CLI isn't shown");
  } finally {
    setLocale("zh-Hans");
  }
});

test("× 关掉后同一批不再出；装的集合变了（多装一个、卸了一个）再出", () => {
  const six = agentsOverCapOf(list(SIX));
  assert.ok(six);
  assert.equal(overCapWanted(six, null), true);
  // 关掉＝记下这一批
  assert.equal(overCapWanted(six, six.key), false);
  // 只是换了勾哪几个（装的没变）：还是这一批
  const swapped = agentsOverCapOf(list(SIX, ["codex", "cursor", "cline", "gemini-cli"]));
  assert.ok(swapped);
  assert.equal(swapped.key, six.key);
  assert.equal(overCapWanted(swapped, six.key), false);
  // 又装了一个
  const seven = agentsOverCapOf(list([...SIX, "windsurf"]));
  assert.ok(seven);
  assert.equal(overCapWanted(seven, six.key), true);
  // 卸了一个（还剩 5 个，仍多于上限）
  const five = agentsOverCapOf(list(SIX.slice(0, 5)));
  assert.ok(five);
  assert.equal(overCapWanted(five, six.key), true);
  // 不多于上限时无论如何都不出
  assert.equal(overCapWanted(agentsOverCapOf(list(SIX.slice(0, 4))), null), false);
});

test("关掉的记录：装的集合一变就作废，卸了再装回同一个也再出", () => {
  const six = agentsOverCapOf(list(SIX));
  assert.ok(six);
  const dismissed = six.key;
  // 名单还没读回来：留着
  assert.equal(keepDismissed(null, dismissed), dismissed);
  // 没变：留着
  assert.equal(keepDismissed(list(SIX), dismissed), dismissed);
  // 没关过：照旧没有
  assert.equal(keepDismissed(list(SIX), null), null);
  assert.equal(
    keepDismissed(list(SIX, ["codex", "cursor", "cline", "gemini-cli"]), dismissed),
    dismissed,
  );
  // 卸了 OpenCode（剩 5 个）：作废；之后装回来，同一批也照样出
  const afterUninstall = keepDismissed(list(SIX.slice(0, 5)), dismissed);
  assert.equal(afterUninstall, null);
  assert.equal(overCapWanted(agentsOverCapOf(list(SIX)), afterUninstall), true);
  // 卸到 4 个（不再超上限）也作废
  assert.equal(keepDismissed(list(SIX.slice(0, 4)), dismissed), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultTargets, joinWords } from "../src/pages/importDefaults.ts";

test("按钮里的专名：汉字之间不加空格，中西文之间一个空格", () => {
  assert.equal(joinWords("只留", "通用仓库", "的"), "只留通用仓库的");
  assert.equal(joinWords("只留", "WeiboAP", "的"), "只留 WeiboAP 的");
  assert.equal(joinWords("删", "ego lite", "的"), "删 ego lite 的");
});

test("默认目标：上次用的（只留现在还在的），没有上次则前两个", () => {
  assert.deepEqual(defaultTargets(["cc", "codex", "cursor"], undefined), ["cc", "codex"]);
  assert.deepEqual(defaultTargets(["cc", "codex", "cursor"], ["cursor"]), ["cursor"]);
  assert.deepEqual(defaultTargets(["cc", "codex"], ["gone", "codex"]), ["codex"]);
  assert.deepEqual(defaultTargets(["cc", "codex"], ["gone"]), ["cc", "codex"]);
  assert.deepEqual(defaultTargets([], ["gone"]), []);
});

test("同名来源：只挑出路径里不同的那一级", async () => {
  const { distinguishingSegments } = await import("../src/pages/importDefaults.ts");
  const base = "/Users/me/Library/Application Support/WeiboAP";
  assert.deepEqual(
    distinguishingSegments([`${base}/alpha/skills`, `${base}/beta/skills`, `${base}/gamma/skills`]),
    ["alpha", "beta", "gamma"],
  );
  // 各自取第一个与别人在同一位置上都不同的那一级（只一级，不拼接）
  assert.deepEqual(distinguishingSegments(["/a/x/one/s", "/b/x/two/s", "/b/y/one/s"]), [
    "a",
    "two",
    "y",
  ]);
  // 真机的情形：一个项目里的 WeiboAP 和两个应用数据目录里的
  assert.deepEqual(distinguishingSegments(["/w", `${base}/alpha/skills`, `${base}/beta/skills`]), [
    "w",
    "alpha",
    "beta",
  ]);
  // 结尾不同就直接是结尾
  assert.deepEqual(distinguishingSegments(["/p/q/skills", "/p/q/skills-2"]), [
    "skills",
    "skills-2",
  ]);
  // 只有一条：不需要区分
  assert.deepEqual(distinguishingSegments(["/only/one"]), [""]);
  // 反斜杠也认
  assert.deepEqual(distinguishingSegments(["C:\\a\\one\\s", "C:\\a\\two\\s"]), ["one", "two"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addLabel,
  columnsOf,
  defaultTargets,
  joinWords,
  sameSet,
  selectAllState,
  toggleAll,
} from "../src/pages/importDefaults.ts";

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

test("同一组目标与顺序无关；按列切", () => {
  assert.ok(sameSet(["a", "b"], ["b", "a"]));
  assert.ok(!sameSet(["a"], ["a", "b"]));
  assert.deepEqual(columnsOf([1, 2, 3, 4, 5], 2), [
    [1, 2, 3],
    [4, 5],
  ]);
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

test("全选：连同名行一起勾上；三态照实算", () => {
  // 列表里 xlsx 是同名行：全选也把它勾上（产品负责人真机：单行能勾、全选却勾不上，读成坏了）
  const listed = ["docx", "pdf", "xlsx"];
  assert.deepEqual(toggleAll(listed, []), ["docx", "pdf", "xlsx"]);
  assert.equal(selectAllState(listed, ["docx", "pdf", "xlsx"]), true);
  // 只勾了同名行 / 只勾了普通行：都是半选
  assert.equal(selectAllState(listed, ["xlsx"]), "mixed");
  assert.equal(selectAllState(listed, ["docx"]), "mixed");
  assert.equal(selectAllState(listed, []), false);
  // 半选时按一下：补全，不重复
  assert.deepEqual(toggleAll(listed, ["pdf"]), ["pdf", "docx", "xlsx"]);
  // 全勾上时按一下：全部取消
  assert.deepEqual(toggleAll(listed, ["xlsx", "docx", "pdf"]), []);
  // 列表外的勾选（不在这一列表里的名字）不参与三态，全选也不动它
  assert.equal(selectAllState(listed, ["gone"]), false);
  assert.deepEqual(toggleAll(listed, ["gone", "docx", "pdf", "xlsx"]), ["gone"]);
  // 空列表：永远是不勾
  assert.equal(selectAllState([], ["docx"]), false);
});

test("主动作：含替换时写明替换几个，不含时照旧", () => {
  assert.equal(addLabel(3, 0), "添加 3 个");
  assert.equal(addLabel(0, 0), "添加 0 个");
  assert.equal(addLabel(38, 1), "添加 38 个（替换 1 个）");
  assert.equal(addLabel(2, 2), "添加 2 个（替换 2 个）");
});

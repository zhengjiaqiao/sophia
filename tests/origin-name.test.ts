import assert from "node:assert/strict";
import test from "node:test";
import { originFullNames, originNames, originText, shortSegments } from "../src/originName.ts";

const base = "/Users/jia/Library/Application Support/ego lite";

test("原件位置显示名：不重名只写来源名，区分片段为空", () => {
  const names = originNames(
    ["a", "b", "a"],
    [
      { id: "a", label: "通用仓库", path: "/Users/jia/.agents/skills" },
      { id: "b", label: "WeiboAP", path: "/Users/jia/WeiboAP/skills" },
    ],
  );
  assert.deepEqual(names.get("a"), { name: "通用仓库", seg: "" });
  assert.equal(originText(names.get("b")!), "WeiboAP");
});

test("原件位置显示名：同名来源拆成来源名 + 区分片段两段，整段写成「名 · 片段」", () => {
  const names = originNames(
    ["x", "y"],
    [
      { id: "x", label: "ego lite", path: `${base}/0.5.0.32/skills` },
      { id: "y", label: "ego lite", path: `${base}/0.5.1.11/skills` },
    ],
  );
  assert.deepEqual(names.get("x"), { name: "ego lite", seg: "0.5.0.32" });
  assert.deepEqual(names.get("y"), { name: "ego lite", seg: "0.5.1.11" });
  assert.equal(originText(names.get("x")!), "ego lite · 0.5.0.32");
});

test("区分片段：先去掉共有开头（退到分隔符之后），再截到能区分的最短一段、至少 4 个字符", () => {
  const names = originNames(
    ["a", "b"],
    [
      { id: "a", label: "WeiboAP", path: "/w/WeiboAP/agent_1776847465710_d5z6cowep/skills" },
      { id: "b", label: "WeiboAP", path: "/w/WeiboAP/agent_1787890675056_m9ac9h594/skills" },
    ],
  );
  assert.deepEqual(names.get("a"), { name: "WeiboAP", seg: "1776…" });
  assert.equal(originText(names.get("b")!), "WeiboAP · 1787…");
  // 前面几位都一样：截到分得开为止
  assert.deepEqual(shortSegments(["agent_1776847465710_x", "agent_1776999999999_y"]), [
    "17768…",
    "17769…",
  ]);
  // 去掉共有开头后够短的整段写；版本号的 `.` 不算分隔，整段读
  assert.deepEqual(shortSegments(["team_alpha", "team_beta"]), ["alpha", "beta"]);
  assert.deepEqual(shortSegments(["0.5.0.32", "0.5.1.11"]), ["0.5.0.32", "0.5.1.11"]);
  // 共有开头就是某一段的全部：不去掉，免得那段变成空的
  assert.deepEqual(shortSegments(["agent_", "agent_2"]), ["agent_", "agent_2"]);
  // 空串（片段就是名字本身）原样返回、不参与比较
  assert.deepEqual(shortSegments(["", "agent_1776847465710_d5z6cowep"]), ["", "agent_1776…"]);
});

test("原件位置显示名：区分片段就是名字本身时不重复写；只剩一段时截到 10 个字符", () => {
  const names = originNames(
    ["p", "q"],
    [
      { id: "p", label: "WeiboAP", path: "/w/WeiboAP/skills" },
      { id: "q", label: "WeiboAP", path: "/w/WeiboAP/agent_0123456789abcdef/skills" },
    ],
  );
  assert.deepEqual(names.get("p"), { name: "WeiboAP", seg: "" });
  assert.deepEqual(names.get("q"), { name: "WeiboAP", seg: "agent_0123…" });
});

test("原件位置显示名：查不到的来源 id 原样当名字", () => {
  assert.deepEqual(originNames(["ghost"], []).get("ghost"), { name: "ghost", seg: "" });
});

test("originFullNames：来源片提示框的完整名——同名一组带完整区分片段，不截短；不重名就是来源名", () => {
  const sources = [
    { id: "a", label: "WeiboAP", path: "/u/WeiboAP/agent_1776847465710_a/skills" },
    { id: "b", label: "WeiboAP", path: "/u/WeiboAP/agent_1787890675056_b/skills" },
    { id: "c", label: "通用仓库", path: "/u/.agents/skills" },
  ];
  const full = originFullNames(["a", "b", "c"], sources);
  assert.equal(full.get("a"), "WeiboAP · agent_1776847465710_a");
  assert.equal(full.get("b"), "WeiboAP · agent_1787890675056_b");
  assert.equal(full.get("c"), "通用仓库");
});

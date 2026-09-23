import { test } from "node:test";
import assert from "node:assert/strict";

import { issueKey, pathsOfKey } from "../src/pages/pendingIssues.ts";

/// 跨语言契约：这个串必须和 `crates/core/src/store.rs` 的
/// `key_format_is_pinned_for_the_frontend` 里那个期望值**逐字节相同**。
///
/// 「看过」表里的 key 由前端算好交给 core 落盘；升级前的「忽略」记录是 core 算的，
/// 读进来直接当看过用。两边同源才对得上：界面据此判断「这条是不是已经看过」。
/// 任一边悄悄改了格式，看过就会静默失效——用户看过的问题又冒出来，而不会
/// 有任何报错。所以两边各钉一条同输入同期望的测试。
/// 分隔符写成显式转义，不要直接嵌不可见字符——那样谁碰掉一个都看不出来。
const SEP = "\u001f";
const PINNED = `duplicateSource${SEP}/a/skills/defuddle${SEP}/b/skills/defuddle`;

test("key 的格式与 core 的 key_for 逐字节一致", () => {
  // 故意传入逆序，验证排序让顺序不影响结果
  const key = issueKey("duplicateSource", ["/b/skills/defuddle", "/a/skills/defuddle"]);
  assert.equal(key, PINNED, "格式变了就要同步改 store.rs 的 key_format_is_pinned_for_the_frontend");
});

test("顺序不同的同一组路径得到同一个 key", () => {
  const a = issueKey("brokenLink", ["/x/1", "/y/2"]);
  const b = issueKey("brokenLink", ["/y/2", "/x/1"]);
  assert.equal(a, b);
});

test("任一路径变化，key 就变", () => {
  const a = issueKey("brokenLink", ["/x/1", "/y/2"]);
  const b = issueKey("brokenLink", ["/x/1", "/y/3"]);
  assert.notEqual(a, b);
});

test("kind 不同、路径相同，key 也不同", () => {
  const paths = ["/x/1"];
  const keys = new Set([
    issueKey("duplicateSource", paths),
    issueKey("brokenLink", paths),
    issueKey("readOnlyTarget", paths),
    issueKey("wholeLinkedTarget", paths),
  ]);
  assert.equal(keys.size, 4, "四类问题在同一组路径上必须产出四个不同的 key");
});

test("pathsOfKey 能把位置取回来", () => {
  assert.deepEqual(pathsOfKey(PINNED), ["/a/skills/defuddle", "/b/skills/defuddle"]);
});

test("MCP 那两类的 key 也走同一个公式", () => {
  // 看过要能跨重启生效，前端算的 key 必须和 core 写盘那个一致。
  // 这两类的标识里带了 # 后缀（条目名 / 服务名）——光靠路径会让同一个文件、
  // 同一组位置上的不同条目撞成一个 key，看过一条就把另一条也吞了
  const a = issueKey("invalidLocation", ["/p/mcp.json#notion"]);
  const b = issueKey("invalidLocation", ["/p/mcp.json#figma"]);
  assert.notEqual(a, b, "同一个文件里两条不同名的问题必须是两个 key");

  const c = issueKey("differentCopies", ["/a/mcp.json", "/b/mcp.json", "#notion"]);
  const d = issueKey("differentCopies", ["/b/mcp.json", "/a/mcp.json", "#notion"]);
  assert.equal(c, d, "位置顺序不该影响 key");

  const e = issueKey("differentCopies", ["/a/mcp.json", "/b/mcp.json", "#figma"]);
  assert.notEqual(c, e, "同一组位置上的两个服务必须是两个 key");
});

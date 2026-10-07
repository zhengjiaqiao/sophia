/// scripts/lint-shell.mjs 的自测：变量名后紧跟中文该报，带花括号、后跟 ASCII、整行注释不该报。
import assert from "node:assert/strict";
import test from "node:test";

const { findBareVars } = await import("../scripts/lint-shell.mjs");

test("变量名后紧跟中文标点或汉字要报", () => {
  assert.deepEqual(findBareVars('echo "接上 -$COS_APPID）"\necho "pid $pid，ok"'), [
    { line: 1, name: "COS_APPID" },
    { line: 2, name: "pid" },
  ]);
});

test("花括号、后跟 ASCII、整行注释都不报", () => {
  const src = ['echo "-${COS_APPID}）"', 'echo "$HOME_DIR"', 'echo "$a b"', "  # 说明 $pid，不展开"].join("\n");
  assert.deepEqual(findBareVars(src), []);
});

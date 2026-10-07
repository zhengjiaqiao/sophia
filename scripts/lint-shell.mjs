#!/usr/bin/env node
// shell 脚本检查：变量名后面紧跟非 ASCII 字符（如 `$COS_APPID）`、`$pid，`）。
// macOS 自带的 bash 3.2 会把中文的字节读进变量名：开了 set -u 直接报 unbound variable 退出，
// 没开就静默展开成空串。shellcheck 不查这一条（2026-10-08 retro：COS 向导在产品负责人机器上中断）。
// 用法：node scripts/lint-shell.mjs，检查 git 跟踪的全部 *.sh。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BARE_VAR = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g;

/// 返回 [{ line, name }]；整行注释不算（不展开）
export function findBareVars(text) {
  const hits = [];
  text.split("\n").forEach((src, i) => {
    if (src.trimStart().startsWith("#")) return;
    for (const m of src.matchAll(BARE_VAR)) hits.push({ line: i + 1, name: m[1] });
  });
  return hits;
}

function main() {
  const files = execFileSync("git", ["ls-files", "*.sh"], { encoding: "utf8" }).split("\n").filter(Boolean);
  let errs = 0;
  for (const f of files) {
    for (const { line, name } of findBareVars(readFileSync(f, "utf8"))) {
      errs++;
      console.log(`\x1b[31m✗\x1b[0m ${f}:${line}  $${name} 后面紧跟非 ASCII 字符，改成 \${${name}}`);
    }
  }
  if (errs === 0) console.log(`\x1b[32m✓\x1b[0m shell 脚本：${files.length} 个文件零违规`);
  process.exit(errs ? 1 : 0);
}

// 被 import（tests/lint-shell.test.ts）时不跑
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

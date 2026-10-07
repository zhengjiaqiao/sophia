import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appFaultView, parseBackendError } from "../src/backendError.ts";

// 后端命令错误分两层的公共拆法（spec #239「错误怎么分两层」）：skill、MCP、设置、模型各处共用

test("parseBackendError 剥离 [code] 前缀，读不出前缀时整段当作 internal", () => {
  assert.deepEqual(parseBackendError("[auth] 鉴权失败"), { code: "auth", message: "鉴权失败" });
  assert.deepEqual(parseBackendError("[changed] 配置已变化，请重试"), {
    code: "changed",
    message: "配置已变化，请重试",
  });
  assert.deepEqual(parseBackendError("网络错误，无法解析"), {
    code: "internal",
    message: "网络错误，无法解析",
  });
});

// spec 2026-10-04-local-diagnostics R13：技术原文跟在一句话之后另起一行 `[detail] `，拆进 detail，只把一句话给人看
test("parseBackendError：`\\n[detail] ` 之后是技术原文，拆进 detail（可以多行）；没有就不带 detail", () => {
  assert.deepEqual(
    parseBackendError(
      '[network] 服务商限流了，约 30 秒后再试\n[detail] GET https://x/models → 429 Too Many Requests\n{"error":1}',
    ),
    {
      code: "network",
      message: "服务商限流了，约 30 秒后再试",
      detail: 'GET https://x/models → 429 Too Many Requests\n{"error":1}',
    },
  );
  assert.equal("detail" in parseBackendError("[auth] 鉴权失败"), false);
});

test("parseBackendError：没有前缀、给了该处的失败句时，一句用失败句，整段当原文", () => {
  assert.deepEqual(parseBackendError("Permission denied (os error 13)", "设置保存失败"), {
    code: "internal",
    message: "设置保存失败",
    detail: "Permission denied (os error 13)",
  });
});

test("parseBackendError：有前缀时不看失败句——一句与原文照后端分好的", () => {
  assert.deepEqual(
    parseBackendError(
      "[internal] 设置保存失败\n[detail] Permission denied (os error 13)",
      "别的句子",
    ),
    { code: "internal", message: "设置保存失败", detail: "Permission denied (os error 13)" },
  );
  // 已经是给人看的一句：原样作一句，不带原文
  assert.deepEqual(
    parseBackendError(
      "[invalid] 设置文件来自更新版本的 Sophia，这次的改动没有保存，请先更新 Sophia",
      "设置保存失败",
    ),
    {
      code: "invalid",
      message: "设置文件来自更新版本的 Sophia，这次的改动没有保存，请先更新 Sophia",
    },
  );
});

const retry = { label: "再试一次", onClick: () => {} };

test("设置保存失败：横幅主句是失败句，系统原文进「!」，带「再试一次」", () => {
  assert.deepEqual(
    appFaultView({
      text: "[internal] 设置保存失败\n[detail] Permission denied (os error 13)",
      fallback: "设置保存失败",
      retry,
    }),
    { message: "设置保存失败", technical: "Permission denied (os error 13)", retry },
  );
  // 后端没给前缀（例如命令本身没调起来）：照样说失败句，整段进「!」
  assert.deepEqual(
    appFaultView({ text: "command set_appearance not found", fallback: "设置保存失败", retry }),
    { message: "设置保存失败", technical: "command set_appearance not found", retry },
  );
});

test("给人看的一句原样显示，「!」不带原文，也不给「再试一次」（再点一次结果一样）", () => {
  assert.deepEqual(
    appFaultView({
      text: "[invalid] 最多显示 4 个 agent，先取消勾选一个",
      fallback: "设置保存失败",
      retry,
    }),
    { message: "最多显示 4 个 agent，先取消勾选一个" },
  );
});

test("别处的错误照旧：没有前缀、没给失败句时整段当一句，没有原文、没有键", () => {
  assert.deepEqual(appFaultView({ text: "网络错误，无法解析" }), { message: "网络错误，无法解析" });
  assert.deepEqual(appFaultView({ text: "[network] 连不上\n[detail] GET x → 502" }), {
    message: "连不上",
    technical: "GET x → 502",
  });
});

/// src 下所有 .ts / .tsx
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("拆分逻辑只有一份：`[detail]` 的分隔只在公共模块里写", () => {
  const holders = sources("src").filter((path) =>
    readFileSync(path, "utf8").includes('"\\n[detail] "'),
  );
  assert.deepEqual(holders, [join("src", "backendError.ts")]);
});

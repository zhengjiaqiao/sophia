// Claude 桌面应用第三方模式下 MCP 写两份（spec 2026-10-05-mcp-claude-3p）：主文件成了、第三方模式那一份没写成时，
// 成功的提示条下接那一句（`McpReportEntry.mirrorFailed`），用失败原因的元素与样式，不另造样式
import assert from "node:assert/strict";
import test from "node:test";
import { deletedMcpOriginalToast, toastFor } from "../src/toastText.ts";
import { mirrorFailedNote } from "../src/mcpView.ts";

const desktop = { id: "claude-desktop", name: "Claude Desktop" };
const NOTE = "第三方模式的那一份没写成：目标配置无法解析或不安全";

test("写成了但镜像没写成：仍是例行成功一行，那一句接在原因的位置", () => {
  const text = toastFor("write", { done: [{ name: "docs", agent: desktop, note: NOTE }] });
  assert.equal(text.tier, "routine");
  assert.equal(text.kind, "success");
  assert.equal(text.reason, NOTE);
  // 生效那一句照旧在前
  assert.deepEqual(text.trail, ["重启 Claude Desktop 后生效"]);
  // 单格省名字时同样带着
  const bare = toastFor("write", {
    done: [{ name: "docs", agent: desktop, note: NOTE }],
    omitNames: true,
  });
  assert.equal(bare.reason, NOTE);
  // 没有要交代的：不给 reason（成功档不借它）
  assert.equal(toastFor("write", { done: [{ name: "docs", agent: desktop }] }).reason, undefined);
  // 删除同理
  assert.equal(deletedMcpOriginalToast("docs", desktop, NOTE).reason, NOTE);
  assert.equal(deletedMcpOriginalToast("docs", desktop).reason, undefined);
});

test("几条里只有一条有要交代的：说那一条的；有失败的那一窗仍说失败的原因", () => {
  const text = toastFor("write", {
    done: [
      { name: "a", agent: desktop },
      { name: "b", agent: desktop, note: NOTE },
    ],
  });
  assert.equal(text.reason, NOTE);
  const partial = toastFor("write", {
    done: [{ name: "a", agent: desktop, note: NOTE }],
    failed: [{ name: "c", agent: desktop, reason: "读不出来" }],
  });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.reason, "读不出来");
});

test("渲染：成功条目下那一句用失败原因同一个元素（ss-toast__reason），✓ 记号不变", async () => {
  const { render } = await import("./ui-render.ts");
  const { Toast } = await import("../src/ui/Toast.tsx");
  const text = toastFor("write", {
    done: [{ name: "docs", agent: desktop, note: NOTE }],
    omitNames: true,
  });
  const html = render(Toast, { ...text, onDismiss: () => {} });
  assert.match(html, /role="status"/);
  assert.match(html, /class="ss-toast__mark" aria-hidden="true"/);
  assert.match(
    html,
    new RegExp(`<span class="ss-toast__sep">·</span><span class="ss-toast__reason">${NOTE}</span>`),
  );
  // 没有要交代的：没有这个元素
  const plain = render(Toast, {
    ...toastFor("write", { done: [{ name: "docs", agent: desktop }], omitNames: true }),
    onDismiss: () => {},
  });
  assert.doesNotMatch(plain, /ss-toast__reason/);
});

test("取词：成了的几条里第一条 mirrorFailed；失败条目上的不算、没有就是 undefined（范围迁移与后台提示用它）", () => {
  assert.equal(
    mirrorFailedNote([
      { outcome: "created" },
      { outcome: "created", mirrorFailed: NOTE },
      { outcome: "created", mirrorFailed: "另一句" },
    ]),
    NOTE,
  );
  assert.equal(mirrorFailedNote([{ outcome: "removed", mirrorFailed: NOTE }]), NOTE);
  assert.equal(mirrorFailedNote([{ outcome: "failed", mirrorFailed: NOTE }]), undefined);
  assert.equal(mirrorFailedNote([{ outcome: "created" }]), undefined);
  assert.equal(mirrorFailedNote([]), undefined);
});

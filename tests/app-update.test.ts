/// 应用更新（DESIGN「设置 › 检查更新」「壳：侧栏 › 更新键」）：src/appUpdate.ts 的 store 换假的后端，
/// 以及侧栏更新键 UpdateKey 的静态渲染
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import type { AppUpdateBackend, AppUpdateHandle } from "../src/appUpdate.ts";

const { createAppUpdateStore, RECHECK_MS } = await import("../src/appUpdate.ts");
const { UpdateKey, litTicks } = await import("../src/ui/UpdateKey.tsx");

function fakeBackend() {
  let clock = 1_000;
  let next: AppUpdateHandle | null | Error = null;
  let downloadResult: Error | null = null;
  const calls = { check: 0, relaunch: 0, download: 0 };
  const handle = (version: string): AppUpdateHandle => ({
    version,
    async download(onProgress) {
      calls.download += 1;
      onProgress(null);
      onProgress(43);
      if (downloadResult) throw downloadResult;
      onProgress(100);
    },
  });
  const backend: AppUpdateBackend = {
    async check() {
      calls.check += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async relaunch() {
      calls.relaunch += 1;
    },
    now: () => clock,
  };
  return {
    backend,
    calls,
    found: (version: string) => (next = handle(version)),
    nothing: () => (next = null),
    offline: () => (next = new Error("error sending request")),
    downloadFails: (e: Error | null) => (downloadResult = e),
    advance: (ms: number) => (clock += ms),
  };
}

test("后台查：查到新版 → 可下载；查不成一句不说、也不丢已有的处境", async () => {
  const f = fakeBackend();
  const store = createAppUpdateStore(f.backend);
  f.found("0.2.0");
  await store.checkQuietly();
  assert.deepEqual(store.get().phase, { kind: "available", version: "0.2.0" });
  assert.equal(store.get().lastCheckedAt, 1_000);

  f.offline();
  await store.checkQuietly();
  assert.deepEqual(store.get().phase, { kind: "available", version: "0.2.0" }, "没查成不冲掉");
});

test("定期查：距上次不到 6 小时不查，超过才查", async () => {
  const f = fakeBackend();
  const store = createAppUpdateStore(f.backend);
  await store.checkIfDue();
  assert.equal(f.calls.check, 1, "还没查过：查");
  f.advance(RECHECK_MS - 1);
  await store.checkIfDue();
  assert.equal(f.calls.check, 1);
  f.advance(1);
  f.found("0.2.0");
  await store.checkIfDue();
  assert.equal(f.calls.check, 2);
  assert.equal(store.get().phase.kind, "available");
});

test("手动查：有没有新版如实回；查不成抛给按下的那一处", async () => {
  const f = fakeBackend();
  const store = createAppUpdateStore(f.backend);
  assert.equal(await store.checkNow(), false);
  f.found("0.2.0");
  assert.equal(await store.checkNow(), true);
  f.offline();
  await assert.rejects(store.checkNow(), /error sending request/);
  f.nothing();
  assert.equal(await store.checkNow(), false);
  assert.deepEqual(store.get().phase, { kind: "none" }, "后来没有了就收起");
});

test("点了才下载：下载中带进度 → 装好等重启；重启只在装好之后", async () => {
  const f = fakeBackend();
  const store = createAppUpdateStore(f.backend);
  await store.relaunch();
  assert.equal(f.calls.relaunch, 0);
  f.found("0.2.0");
  await store.checkQuietly();
  assert.equal(f.calls.download, 0, "查到不自动下载");

  const seen: Array<number | null> = [];
  const off = store.subscribe(() => {
    const p = store.get().phase;
    if (p.kind === "downloading") seen.push(p.percent);
  });
  await store.install();
  off();
  assert.deepEqual(seen, [null, null, 43, 100]);
  assert.deepEqual(store.get().phase, { kind: "installed", version: "0.2.0" });

  f.found("0.3.0");
  await store.checkQuietly();
  assert.equal(await store.checkNow(), true);
  assert.deepEqual(
    store.get().phase,
    { kind: "installed", version: "0.2.0" },
    "装好的要重启才算数",
  );
  await store.relaunch();
  assert.equal(f.calls.relaunch, 1);
});

test("下载失败：记下原因；后台再查不冲掉原因，重试先重新查再下", async () => {
  const f = fakeBackend();
  const store = createAppUpdateStore(f.backend);
  f.found("0.2.0");
  await store.checkQuietly();
  f.downloadFails(new Error("disk full"));
  await store.install();
  assert.deepEqual(store.get().phase, {
    kind: "failed",
    version: "0.2.0",
    detail: "Error: disk full",
    reason: "原因见详情",
  });
  await store.checkQuietly();
  assert.equal(store.get().phase.kind, "failed");

  f.downloadFails(null);
  const before = f.calls.check;
  await store.install();
  assert.equal(f.calls.check, before + 1);
  assert.deepEqual(store.get().phase, { kind: "installed", version: "0.2.0" });
});

test("同一时刻只查一次：后台那次还没回来，手动按下就等那一次", async () => {
  const f = fakeBackend();
  const store = createAppUpdateStore(f.backend);
  f.found("0.2.0");
  const [, manual] = await Promise.all([store.checkQuietly(), store.checkNow()]);
  assert.equal(f.calls.check, 1);
  assert.equal(manual, true);
});

test("侧栏更新键：只有图标、不展开，字在提示框里；纸面键 = 下载，平贴 + 进度刻度 = 正在下载，墨键 = 重启", () => {
  const noop = () => undefined;
  const key = (phase: Parameters<typeof UpdateKey>[0]["phase"]) =>
    render(UpdateKey, { phase, onDownload: noop, onRestart: noop });

  const available = key({ kind: "available", version: "0.2.0" });
  assert.match(available, /ss-updatekey--paper/);
  assert.match(available, /aria-label="下载 0.2.0"/);
  assert.match(available, /role="tooltip"[^>]*>下载 0.2.0</, "字在提示框里");
  assert.doesNotMatch(available, /ss-updatekey__label/, "键上不再有展开的字");

  assert.match(
    key({ kind: "failed", version: "0.2.0", detail: "x", reason: "原因见详情" }),
    /ss-updatekey--paper/,
    "失败回到纸面键，再点就是重试",
  );

  const downloading = key({ kind: "downloading", version: "0.2.0", percent: 43 });
  assert.match(downloading, /ss-updatekey--busy/);
  assert.match(downloading, /aria-disabled="true"/);
  assert.match(downloading, /role="tooltip"[^>]*>正在下载 43%</);
  assert.equal((downloading.match(/class="is-lit"/g) ?? []).length, 3, "43% 点亮三根");

  const unknown = key({ kind: "downloading", version: "0.2.0", percent: null });
  assert.match(unknown, /ss-spinner/, "拿不到总大小：扫过的忙碌刻度");
  assert.match(unknown, /role="tooltip"[^>]*>正在下载</);

  const installed = key({ kind: "installed", version: "0.2.0" });
  assert.match(installed, /ss-updatekey--ink/);
  assert.match(installed, /role="tooltip"[^>]*>重启以更新到 0.2.0</);

  assert.equal(key({ kind: "none" }), "");
});

test("进度刻度：0–19% 一根，每 20% 多一根，80% 起五根", () => {
  assert.deepEqual([0, 19, 20, 43, 79, 80, 100].map(litTicks), [1, 1, 2, 3, 4, 5, 5]);
});

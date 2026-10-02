/// 应用更新（DESIGN「设置 › 检查更新」「壳：侧栏 › 更新键」）：src/appUpdate.ts 的 store 换假的后端，
/// 以及侧栏更新键 UpdateKey 的静态渲染
import assert from "node:assert/strict";
import test from "node:test";
import { render } from "./ui-render.ts";
import type { AppUpdateBackend, AppUpdateHandle } from "../src/appUpdate.ts";

const { createAppUpdateStore, RECHECK_MS } = await import("../src/appUpdate.ts");
const { UpdateKey } = await import("../src/ui/UpdateKey.tsx");

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
    reason: "Error: disk full",
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

test("侧栏更新键：可下载是纸面键 + 下载；下载中是忙碌、不能点；装好是墨键 + 重启", () => {
  const noop = () => undefined;
  const available = render(UpdateKey, {
    phase: { kind: "available", version: "0.2.0" },
    onDownload: noop,
    onRestart: noop,
  });
  assert.match(available, /ss-updatekey--paper/);
  assert.match(available, /aria-label="下载 0.2.0"/);
  assert.match(available, />下载 0.2.0</);

  const failed = render(UpdateKey, {
    phase: { kind: "failed", version: "0.2.0", reason: "x" },
    onDownload: noop,
    onRestart: noop,
  });
  assert.match(failed, /ss-updatekey--paper/, "失败回到纸面键，再点就是重试");

  const downloading = render(UpdateKey, {
    phase: { kind: "downloading", version: "0.2.0", percent: 43 },
    onDownload: noop,
    onRestart: noop,
  });
  assert.match(downloading, /ss-updatekey--busy/);
  assert.match(downloading, /aria-disabled="true"/);
  assert.match(downloading, /正在下载 43%/);
  assert.match(downloading, /ss-spinner/);

  const unknown = render(UpdateKey, {
    phase: { kind: "downloading", version: "0.2.0", percent: null },
    onDownload: noop,
    onRestart: noop,
  });
  assert.match(unknown, />正在下载</, "拿不到总大小时不写百分比");

  const installed = render(UpdateKey, {
    phase: { kind: "installed", version: "0.2.0" },
    onDownload: noop,
    onRestart: noop,
  });
  assert.match(installed, /ss-updatekey--ink/);
  assert.match(installed, /aria-label="重启以更新到 0.2.0"/);

  const none = render(UpdateKey, { phase: { kind: "none" }, onDownload: noop, onRestart: noop });
  assert.equal(none, "");
});

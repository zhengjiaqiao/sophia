import assert from "node:assert/strict";
import test from "node:test";
import { createSelectionWriter } from "../src/selectionWrites.ts";

/// 手动放行的一次写盘：测试决定它何时成功 / 失败
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(reread: () => Promise<string> = async () => "reread") {
  const painted: string[] = [];
  const reported: string[] = [];
  const failures: string[] = [];
  let done = 0;
  const writer = createSelectionWriter<string>({
    paint: (s) => painted.push(s),
    report: (s) => reported.push(s),
    reread,
    onDone: () => (done += 1),
    onFail: (message, error) => failures.push(`${message}|${String(error)}`),
    alive: () => true,
  });
  return { writer, painted, reported, failures, done: () => done };
}

test("勾选先画、写盘排队一次一个；还在写时别处读回来的状态不画，写完才画后端的", async () => {
  const h = harness();
  h.writer.accept("server-0");
  const first = deferred<string>();
  const second = deferred<string>();
  let secondStarted = false;
  h.writer.write("没加上 A", "optimistic-1", () => first.promise);
  h.writer.write("没加上 B", "optimistic-2", () => {
    secondStarted = true;
    return second.promise;
  });
  assert.deepEqual(h.painted, ["server-0", "optimistic-1", "optimistic-2"], "点下去当场画");
  await flush();
  assert.equal(secondStarted, false, "上一次没写完，下一次不开始");

  // 焦点重读 / 轮询在写的时候回来：只记下，不把片画回旧样子
  h.writer.accept("focus-read");
  assert.equal(h.painted.at(-1), "optimistic-2");

  first.resolve("server-1");
  await flush();
  assert.equal(secondStarted, true);
  assert.equal(h.painted.at(-1), "optimistic-2", "后面还有没写完的，不画中间态");

  second.resolve("server-2");
  await h.writer.idle();
  assert.equal(h.painted.at(-1), "server-2");
  assert.equal(h.done(), 2);
  assert.deepEqual(h.reported, ["server-0", "focus-read", "server-1", "server-2"]);
  assert.deepEqual(h.failures, []);
});

test("写失败：先回滚到后端上次给的状态、说原因，排在后面的作废，再以后端实际状态为准", async () => {
  const h = harness(async () => "actual");
  h.writer.accept("server-0");
  const first = deferred<string>();
  let followerCalled = false;
  h.writer.write("没移除 GPT 5", "optimistic-1", () => first.promise);
  h.writer.write("没移除 Claude", "optimistic-2", async () => {
    followerCalled = true;
    return "never";
  });
  first.reject("[invalid] 已启用时至少要保留一个模型");
  await h.writer.idle();
  await flush();
  assert.equal(followerCalled, false, "在已回滚的画面上点的那一下不写");
  assert.deepEqual(h.failures, ["没移除 GPT 5|[invalid] 已启用时至少要保留一个模型"]);
  assert.deepEqual(h.painted, ["server-0", "optimistic-1", "optimistic-2", "server-0", "actual"]);

  // 失败之后再点：新的一轮照常写
  h.writer.write("没加上 A", "optimistic-3", async () => "server-3");
  await h.writer.idle();
  assert.equal(h.painted.at(-1), "server-3");
});

test("idle：开关这类操作等排着的勾选写完再动", async () => {
  const h = harness();
  h.writer.accept("server-0");
  const first = deferred<string>();
  h.writer.write("没加上 A", "optimistic-1", () => first.promise);
  let idle = false;
  void h.writer.idle().then(() => (idle = true));
  await flush();
  assert.equal(idle, false);
  first.resolve("server-1");
  await flush();
  assert.equal(idle, true);
});

/// 模型状态的读与写的先后（走查连拍 fly/f08）：选模型浮层里勾上一个，乐观更新已经画上，后台轻查（`重启生效` /
/// `启动 Codex` 显示着时每 5 秒一次）在写之前发出、写之后才回来，拿到的旧状态把勾选与计数盖回去一帧。
/// 读要等手上的写都落地、且读的过程中没有新的写开始，才算数；被后一次写盖过的写，结果换成都落地之后重读的
import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayGate } from "../src/gatewayGate.ts";

/// 手动放行的一次调用
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("写之前发出、写之后才回来的读不算数：等写落地后重读（f08 那一帧）", async () => {
  const gate = createGatewayGate();
  const reads = [deferred<string>(), deferred<string>()];
  let readCalls = 0;
  const backend = () => reads[readCalls++].promise;

  const read = gate.read(backend);
  await flush();
  assert.equal(readCalls, 1);
  const write = deferred<string>();
  const written = gate.write(() => write.promise, backend);
  // 轻查先回来，带的是写之前的旧状态
  reads[0].resolve("旧：没勾");
  write.resolve("新：勾上");
  assert.equal(await written, "新：勾上");
  await flush();
  assert.equal(readCalls, 2, "写落地之后重读一次");
  reads[1].resolve("新：勾上");
  assert.equal(await read, "新：勾上");
});

test("写还没落地时发起的读，等写落地再去读", async () => {
  const gate = createGatewayGate();
  let readCalls = 0;
  const write = deferred<string>();
  const written = gate.write(
    () => write.promise,
    async () => "重读",
  );
  const read = gate.read(async () => {
    readCalls += 1;
    return "读到的";
  });
  await flush();
  assert.equal(readCalls, 0, "写在路上，先不读");
  write.resolve("写完");
  assert.equal(await written, "写完");
  assert.equal(await read, "读到的");
  assert.equal(readCalls, 1);
});

test("被后一次写盖过的写：不交出它那份旧结果，交出都落地之后重读的", async () => {
  const gate = createGatewayGate();
  const first = deferred<string>();
  const second = deferred<string>();
  const firstDone = gate.write(
    () => first.promise,
    async () => "两下都落地",
  );
  const secondDone = gate.write(
    () => second.promise,
    async () => "不该用到",
  );
  // 第一下先回来：那时第二下的乐观更新已经画上，它那份不含第二下
  first.resolve("只有第一下");
  await flush();
  second.resolve("两下都有");
  assert.equal(await secondDone, "两下都有");
  assert.equal(await firstDone, "两下都落地");
});

test("写失败照样抛出，且不挡后面的读", async () => {
  const gate = createGatewayGate();
  await assert.rejects(
    gate.write(
      () => Promise.reject(new Error("没写成")),
      async () => "重读",
    ),
    /没写成/,
  );
  assert.equal(await gate.read(async () => "读到的"), "读到的");
});

test("界面里读写模型状态的命令都经这一道（api.ts）", async () => {
  const { readFileSync } = await import("node:fs");
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  // 直接 invoke 拿 GatewayState 的只剩那一条原始读，别的都经 gate
  const direct = [...api.matchAll(/invoke<GatewayState>\("(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(direct, ["gateway_state"]);
  assert.match(api, /gatewayState: \(\) => gate\.read\(readGateway\)/);
  for (const command of [
    "gateway_fix_file_owner",
    "gateway_pick",
    "gateway_reorder_picks",
    "gateway_restore_order",
    "gateway_enable",
    "gateway_restore",
    "gateway_takeover",
    "gateway_launch_claude",
    "gateway_restart_claude",
    "gateway_restart",
  ]) {
    assert.match(api, new RegExp(`writeGateway\\("${command}"`), command);
  }
});

test("没有写的时候，读与写都原样交出", async () => {
  const gate = createGatewayGate();
  assert.equal(await gate.read(async () => "状态"), "状态");
  assert.equal(
    await gate.write(
      async () => "写后",
      async () => "重读",
    ),
    "写后",
  );
});

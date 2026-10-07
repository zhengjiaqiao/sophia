import assert from "node:assert/strict";
import test from "node:test";
import { appFaultView, type AppFault } from "../src/backendError.ts";
import { saveThenReload } from "../src/pages/settingsSave.ts";

// 设置页存一项再重读（#288 复审）：保存失败后的重读再失败，不能用没有失败句的原文盖掉「设置保存失败」横幅

/// 同 App 的横幅：后报的盖掉先报的
function banner() {
  let fault: AppFault | null = null;
  const onError = (text: string, more?: Omit<AppFault, "text">) => {
    fault = { ...more, text };
  };
  return { onError, current: () => fault };
}

const retry = { label: "再试一次", onClick: () => {} };

/// 设置页的接法：保存失败带失败句与「再试一次」，重读失败只报原文
function steps(
  shown: ReturnType<typeof banner>,
  save: () => Promise<void>,
  reload: () => Promise<void>,
) {
  return {
    save,
    reload,
    saveFailed: (e: unknown) => shown.onError(String(e), { fallback: "设置保存失败", retry }),
    reloadFailed: (e: unknown) => shown.onError(String(e)),
  };
}

test("保存失败后重读也失败：横幅仍是两层「设置保存失败」+ 原文 +「再试一次」", async () => {
  const shown = banner();
  let reloaded = 0;
  await saveThenReload(
    steps(
      shown,
      () => Promise.reject("[internal] 设置保存失败\n[detail] Permission denied (os error 13)"),
      () => {
        reloaded += 1;
        return Promise.reject("Permission denied (os error 13)");
      },
    ),
  );
  assert.equal(reloaded, 1, "保存失败也要重读一次，界面回到落盘的真值");
  assert.deepEqual(appFaultView(shown.current()!), {
    message: "设置保存失败",
    technical: "Permission denied (os error 13)",
    retry,
  });
});

test("保存失败、重读成功：横幅是保存失败那一条", async () => {
  const shown = banner();
  await saveThenReload(
    steps(
      shown,
      () => Promise.reject("Permission denied (os error 13)"),
      () => Promise.resolve(),
    ),
  );
  assert.deepEqual(appFaultView(shown.current()!), {
    message: "设置保存失败",
    technical: "Permission denied (os error 13)",
    retry,
  });
});

test("保存成功、重读失败：照常报重读的错；都成功不报", async () => {
  const shown = banner();
  await saveThenReload(
    steps(
      shown,
      () => Promise.resolve(),
      () => Promise.reject("读不出"),
    ),
  );
  assert.deepEqual(shown.current(), { text: "读不出" });

  const quiet = banner();
  await saveThenReload(
    steps(
      quiet,
      () => Promise.resolve(),
      () => Promise.resolve(),
    ),
  );
  assert.equal(quiet.current(), null);
});

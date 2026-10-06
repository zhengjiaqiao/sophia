import { test } from "node:test";
import assert from "node:assert/strict";

import { updateCheckFailure, updateInstallFailure } from "../src/updateText.ts";

test("检查更新失败：没有更新清单、网络不通、其他原因各给一句中文", () => {
  assert.equal(
    updateCheckFailure("Could not fetch a valid release JSON from the remote"),
    "暂时没有可用的更新信息",
  );
  assert.equal(
    updateCheckFailure("Error: error sending request for url"),
    "无法连接更新服务器，请检查网络",
  );
  assert.equal(updateCheckFailure("operation timed out"), "无法连接更新服务器，请检查网络");
  assert.equal(updateCheckFailure("Error: signature mismatch"), "检查更新失败：signature mismatch");
  assert.equal(updateCheckFailure(""), "检查更新失败");
});

test("安装更新失败：五类原文各得一句中文，认不出的落「原因见详情」", () => {
  const no = "没有权限替换 Sophia";
  assert.equal(updateInstallFailure("Error: Permission denied (os error 13)"), no);
  assert.equal(updateInstallFailure("Operation not permitted (os error 1)"), no);
  assert.equal(updateInstallFailure("EACCES: open '/Applications/Sophia.app'"), no);
  assert.equal(updateInstallFailure("os error 13"), no);
  const bad = "下载的安装包没通过校验";
  assert.equal(updateInstallFailure("Error: signature verification failed"), bad);
  assert.equal(updateInstallFailure("minisign: bad"), bad);
  assert.equal(updateInstallFailure("invalid public key"), bad);
  assert.equal(
    updateInstallFailure("error sending request for url (https://x)"),
    "无法连接下载服务器，请检查网络",
  );
  assert.equal(updateInstallFailure("operation timed out"), "无法连接下载服务器，请检查网络");
  assert.equal(updateInstallFailure("No space left on device (os error 28)"), "磁盘空间不够");
  assert.equal(updateInstallFailure("something odd"), "原因见详情");
  assert.equal(updateInstallFailure(""), "原因见详情");
  // 「os error 1」是整词：os error 13、os error 10 不算它
  assert.equal(updateInstallFailure("os error 10"), "原因见详情");
});

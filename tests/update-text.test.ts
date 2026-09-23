import { test } from "node:test";
import assert from "node:assert/strict";

import { updateCheckFailure } from "../src/updateText.ts";

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

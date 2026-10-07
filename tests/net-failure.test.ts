import { test } from "node:test";
import assert from "node:assert/strict";

import {
  netFailureText,
  netProblemOf,
  skillDownloadFailure,
  websiteDownloadUrl,
} from "../src/netFailure.ts";

// 期望值照画板第 7 屏「三类怎么说」那张表（spec #248，issue #253）

test("检查更新：四类各一句主句与出口", () => {
  assert.deepEqual(netFailureText("checkUpdate", "unreachable"), {
    message: "无法连接更新服务器，检查一下网络",
    retry: "proxy",
  });
  assert.deepEqual(netFailureText("checkUpdate", "timeout"), {
    message: "网络太慢，检查更新超时了",
    retry: "plain",
  });
  assert.deepEqual(netFailureText("checkUpdate", "rateLimited"), {
    message: "更新服务器暂时限制了访问，几分钟后再试",
    retry: null,
  });
  assert.deepEqual(netFailureText("checkUpdate", "other"), {
    message: "检查更新失败，稍后再试",
    retry: null,
  });
});

test("下载更新与检查更新分开说，限流同一句", () => {
  assert.equal(
    netFailureText("downloadUpdate", "unreachable").message,
    "无法连接下载服务器，检查一下网络",
  );
  assert.equal(netFailureText("downloadUpdate", "timeout").message, "网络太慢，下载超时了");
  assert.equal(
    netFailureText("downloadUpdate", "rateLimited").message,
    "更新服务器暂时限制了访问，几分钟后再试",
  );
  assert.equal(netFailureText("downloadUpdate", "other").message, "下载失败，稍后再试");
  assert.equal(netFailureText("downloadUpdate", "unreachable").retry, "proxy");
  assert.equal(netFailureText("downloadUpdate", "other").retry, null);
});

test("抛出来的值：后端 `[类] 一句\\n[detail] 原文` 认出类与原文，别的都算「别的」、整段当原文", () => {
  assert.deepEqual(netProblemOf("[timeout] error sending request\n[detail] operation timed out"), {
    kind: "timeout",
    detail: "operation timed out",
  });
  assert.deepEqual(netProblemOf("[rate_limited] x\n[detail] 429"), {
    kind: "rateLimited",
    detail: "429",
  });
  assert.deepEqual(netProblemOf("boom"), { kind: "other", detail: "boom" });
  assert.deepEqual(netProblemOf(new Error("boom")), { kind: "other", detail: "boom" });
  assert.equal(netProblemOf("[constructor] x\n[detail] y").kind, "other");
});

test("下载 skill：网络三类换成场景主句并给「开着代理再试一次」，别的照后端那一句", () => {
  assert.deepEqual(skillDownloadFailure("[unreachable] 无法连接 GitHub\n[detail] GET …"), {
    message: "无法连接下载服务器，检查一下网络",
    retryWithProxy: true,
    detail: "GET …",
  });
  assert.equal(skillDownloadFailure("[timeout] x").message, "网络太慢，下载超时了");
  assert.deepEqual(skillDownloadFailure("[rate_limited] x\n[detail] GET … → 429"), {
    message: "下载服务器暂时限制了访问，几分钟后再试",
    retryWithProxy: true,
    detail: "GET … → 429",
  });
  assert.deepEqual(skillDownloadFailure("[other] 仓库或分支不存在\n[detail] GET … → 404"), {
    message: "仓库或分支不存在",
    retryWithProxy: false,
    detail: "GET … → 404",
  });
  // 没有前缀的一句（链接认不出、包里没有 skill）
  assert.deepEqual(skillDownloadFailure("链接认不出"), {
    message: "链接认不出",
    retryWithProxy: false,
    detail: null,
  });
});

test("官网下载区按界面语言", () => {
  assert.equal(websiteDownloadUrl("en"), "https://sophiakit.com/#install");
  assert.equal(websiteDownloadUrl("zh-Hans"), "https://sophiakit.com/zh-hans/#install");
  assert.equal(websiteDownloadUrl("zh-Hant"), "https://sophiakit.com/zh-hant/#install");
});

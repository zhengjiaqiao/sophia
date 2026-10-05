import { describe, expect, it } from "vitest";
import { adminAuth, basicAuth, call, dailyBody, env, feedbackBody, jpeg, postJson, postShot, uploadShot, uuid } from "./helpers";

describe("/admin", () => {
  it.each([
    ["没有口令", {}],
    ["Bearer 口令错", adminAuth("wrong-token")],
    ["Basic 口令错", basicAuth("wrong-token")],
    ["Bearer 只差最后一位", adminAuth("test-admin-tokeN")],
    ["口令前缀", adminAuth("test-admin")],
    ["空 Bearer", { authorization: "Bearer " }],
    ["坏的 Basic", { authorization: "Basic %%%" }],
  ])("%s：401，带 Basic 质询，看不到数据", async (_n, headers) => {
    const res = await call("/admin", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Sophia"');
    const text = await res.text();
    expect(text).not.toContain("日活");
  });

  it("Bearer 与 Basic（任意用户名）都能进；页面不缓存、不加载外部资源", async () => {
    for (const headers of [adminAuth(), basicAuth("test-admin-token", "anyone")]) {
      const res = await call("/admin", { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain("日活");
      expect(html).not.toMatch(/<(script|link)\b/i);
    }
  });

  it("页面里转义用户写的内容", async () => {
    // 版本只收可打印 ASCII，尖括号也算，照样要转义
    await postJson("/v1/feedback", feedbackBody({ text: "<script>alert(1)</script> & \"quote\"", version: "<b>1</b>", diagnostics: "</details><script>y</script>" }));
    await postJson("/v1/event", {
      installId: uuid(),
      version: "1.4.0",
      os: "macos15",
      signature: "<img src=x onerror=alert(1)>",
      body: "</details><script>x</script>",
    });
    const html = await (await call("/admin", { headers: adminAuth() })).text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quote&quot;");
    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
  });

  it("页面 CSP 只放开本站图片：img-src 'self'", async () => {
    const res = await call("/admin", { headers: adminAuth() });
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).not.toMatch(/img-src[^;]*(\*|data:|https?:)/);
  });

  it("用户反馈一节读反馈库：时间、版本 / 系统 / 架构、安装 ID 前几位、文字、折叠的诊断内容、截图缩略图", async () => {
    const shots = [await uploadShot(), await uploadShot()];
    const body = feedbackBody({ text: `统计页能看到这条 ${uuid()}`, shots, version: "7.7.7", os: "macos-fb", arch: "arm-fb" });
    expect((await postJson("/v1/feedback", body)).status).toBe(200);
    const html = await (await call("/admin", { headers: adminAuth() })).text();
    expect(html).toContain(body.text);
    expect(html).toContain("7.7.7");
    expect(html).toContain("macos-fb");
    expect(html).toContain("arm-fb");
    expect(html).toContain(body.installId.slice(0, 8));
    expect(html).not.toContain(body.installId);
    expect(html).toMatch(/<details><summary>诊断内容<\/summary><pre>Sophia 1\.4\.0/);
    for (const s of shots) expect(html).toContain(`<img src="/admin/shot/${s}"`);
    // 没挂上反馈的截图不出现
    const loose = await uploadShot();
    expect(await (await call("/admin", { headers: adminAuth() })).text()).not.toContain(loose);
  });

  it("截图路由：同一口令；回 image/jpeg、不缓存、nosniff；没有的 404", async () => {
    const img = jpeg(3000);
    const { id } = await (await postShot(img)).json<{ id: string }>();
    expect((await postJson("/v1/feedback", feedbackBody({ shots: [id] }))).status).toBe(200);

    const no = await call(`/admin/shot/${id}`);
    expect(no.status).toBe(401);
    expect((await call(`/admin/shot/${id}`, { headers: adminAuth("wrong-token") })).status).toBe(401);

    for (const headers of [adminAuth(), basicAuth("test-admin-token")]) {
      const res = await call(`/admin/shot/${id}`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(img);
    }

    const missing = await call("/admin/shot/0123456789abcdef0123456789abcdef", { headers: adminAuth() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect((await call("/admin/shot/not-an-id", { headers: adminAuth() })).status).toBe(404);
    expect((await call(`/admin/shot/${id}`, { method: "POST", headers: adminAuth() })).status).toBe(405);
  });

  it.each([4, 5, 6, 1024 * 1024 - 1, 1024 * 1024])("截图路由把 base64 原文解回二进制：%i 字节（各种补齐）原样还回来", async (size) => {
    const img = jpeg(size);
    const { id } = await (await postShot(img)).json<{ id: string }>();
    const res = await call(`/admin/shot/${id}`, { headers: adminAuth() });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(img);
  });

  it("显示日活、月活、版本与系统分布、两层异常合计", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await postJson("/v1/daily", dailyBody({ version: "9.9.1", os: "macos-test-a" }));
    await postJson("/v1/daily", dailyBody({ version: "9.9.2", os: "macos-test-a" }));
    const html = await (await call("/admin", { headers: adminAuth() })).text();
    // 两台：Sophia 自身 (1+2)×2=6，外部原因 (3+1)×2=8
    expect(html).toContain(`<tr><td>${day}</td><td>2</td><td>6</td><td>8</td></tr>`);
    expect(html).toContain("月活");
    expect(html).toContain("9.9.1");
    expect(html).toContain("9.9.2");
    expect(html).toContain("macos-test-a");
    expect(html).toContain("Sophia 自身");
    expect(html).toContain("外部原因");
  });

  it("只认 GET：POST /admin 405", async () => {
    const res = await call("/admin", { method: "POST", headers: adminAuth() });
    expect(res.status).toBe(405);
  });
});

describe("路由", () => {
  it("未知路径 404，JSON 错误体", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("反馈接口只收 JSON：multipart 400 bad_json", async () => {
    const fd = new FormData();
    fd.set("text", "hi");
    const res = await call("/v1/feedback", { method: "POST", body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_json" });
  });

  it("接口用错方法 405，带 Allow", async () => {
    const res = await call("/v1/daily");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });
});

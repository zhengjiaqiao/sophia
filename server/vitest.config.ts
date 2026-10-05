import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 测试跑在本地 workerd 里：D1、限流绑定、cron 都是真的（miniflare），不 mock
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const fbMigrations = await readD1Migrations(path.join(import.meta.dirname, "migrations-feedback"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_FB_MIGRATIONS: fbMigrations, ADMIN_TOKEN: "test-admin-token" } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});

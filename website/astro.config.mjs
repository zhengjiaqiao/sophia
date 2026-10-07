import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// 静态输出：三个语言页在构建时生成（/、/zh-hans/、/zh-hant/），关掉 JS 也能读到全部文案与下载链接
export default defineConfig({
  site: "https://sophiakit.com",
  output: "static",
  trailingSlash: "always",
  build: { format: "directory" },
  vite: {
    resolve: {
      // 应用的 tokens.css（../src/tokens.css）里 @import 了 @fontsource 的 woff2 字体；
      // 它在 website/ 之外，解析不到 website/node_modules，这里指过来。字体随站发布，不走 CDN（R22）
      alias: { "@fontsource": fileURLToPath(new URL("./node_modules/@fontsource", import.meta.url)) },
    },
    server: { fs: { allow: [".."] } },
  },
});

#!/usr/bin/env node
// 热门 skill 快照（spec R5）：发布前跑一次，重写 crates/core/data/market/skills-popular.json。
// 用法：node scripts/market-snapshot.mjs [--out 路径] [--top 200]
//
// 取法（为什么这样取）：
// - skills.sh 唯一能匿名调用的接口是 `GET https://skills.sh/api/search?q=&limit=`，
//   与 `npx skills find` 同一个（vercel-labs/skills `src/find.ts`）。文档化的 `/api/v1/skills?view=all-time`
//   排行榜要 Vercel OIDC token，匿名请求 401；首页内嵌的 `initialSkills` 是页面结构，不从网页里抠。
//   见 docs/research/2026-09-27-market-sources.md §4。
// - `/api/search` 没有「不带词的热门榜」：`q` 至少 2 个字符，单次最多回几十条（实测 limit 再大也只有 ~80）。
//   所以用一批常见词逐个搜，把所有结果按 `id`（`owner/repo/skillId`，即仓库 + skill）去重、取装过人数最大的
//   那次，再按装过人数从高到低排，取前 N。
// - 第二轮补漏：对第一轮前 N 里出现过的每个仓库，再用仓库名和它的 owner 各搜一次，把同仓库里没被常见词
//   碰到的兄弟 skill 捞上来，然后重新排序取前 N。
// - 这是近似的「装过人数最多的 N 个」：一个装得很多、但名字不含任何常见词、所在仓库又不在前 N 里的 skill
//   会漏掉。脚本末尾打印第 N 名的装过人数作参考。
//
// 礼貌：请求逐个串行，间隔 DELAY_MS（全程约十来分钟）。429 与 5xx 是暂时的（实测偶发 504）：按 Retry-After
// 或 30 秒退避后重试，同一请求最多重试 2 次；其余 HTTP 错误、网络错误或重试用完即停下、不写文件、退出码非 0。
// 只用 Node 自带的 fetch，不加依赖。

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://skills.sh/api/search";
const LIMIT = 100;
/// 2026-09-27 实测：间隔 300ms 时第 31 个请求起返回 429（限流约每分钟 30 次，未公开文档），所以每次隔 2.5 秒
const DELAY_MS = 2500;
const RETRIES = 2;
const BACKOFF_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = argValue("--out", join(HERE, "..", "crates", "core", "data", "market", "skills-popular.json"));
const TOP = Number(argValue("--top", "200"));

/// 第一轮的常见词：覆盖语言、框架、文档格式、工作流、平台与常见动词。都 ≥ 2 个字符
const TERMS = [
  "skill", "creator", "code", "review", "test", "debug", "refactor", "plan", "brainstorm", "tdd",
  "git", "github", "commit", "pr", "worktree", "ci", "deploy", "docker", "kubernetes", "terraform",
  "web", "frontend", "backend", "design", "ui", "ux", "css", "tailwind", "shadcn", "animation",
  "react", "next", "vue", "svelte", "angular", "node", "bun", "typescript", "javascript", "python",
  "rust", "go", "java", "swift", "ios", "android", "expo", "react native", "flutter", "kotlin",
  "doc", "docs", "documentation", "pdf", "docx", "xlsx", "pptx", "excel", "slides", "markdown",
  "writing", "copywriting", "content", "blog", "seo", "marketing", "brand", "social", "email", "sales",
  "product", "research", "analysis", "data", "chart", "dashboard", "sql", "database", "postgres", "supabase",
  "api", "mcp", "agent", "ai", "llm", "prompt", "claude", "openai", "gemini", "rag",
  "browser", "playwright", "e2e", "scraping", "crawl", "search", "find", "fetch", "automation", "workflow",
  "security", "audit", "performance", "accessibility", "best practices", "architecture", "vercel", "cloudflare", "aws", "azure",
  "firebase", "stripe", "auth", "image", "video", "audio", "canvas", "remotion", "three", "game",
  "memory", "context", "superpowers", "shell", "cli", "terminal", "notion", "obsidian", "linear", "figma",
  "slack", "finance", "legal", "mobile", "i18n", "lint", "format", "monitoring", "logging", "sentry",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requests = 0;
async function search(q) {
  if (requests > 0) await sleep(DELAY_MS);
  requests += 1;
  const url = `${API}?q=${encodeURIComponent(q)}&limit=${LIMIT}`;
  let res;
  for (let attempt = 0; ; attempt += 1) {
    res = await fetch(url, { headers: { "user-agent": "sophia-market-snapshot" } });
    const transient = res.status === 429 || res.status >= 500;
    if (res.ok || !transient || attempt >= RETRIES) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS;
    console.error(`HTTP ${res.status}：${url}，${Math.round(wait / 1000)} 秒后重试`);
    await sleep(wait);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}：${url}`);
  }
  const body = await res.json();
  if (!Array.isArray(body.skills)) {
    throw new Error(`返回里没有 skills 数组：${url}`);
  }
  return body.skills;
}

/// id → { name, repo, installs }；同一个 skill 在不同词下出现时取装过人数大的那次
const seen = new Map();
function absorb(skills) {
  for (const s of skills) {
    if (typeof s.id !== "string" || typeof s.source !== "string" || !Number.isFinite(s.installs)) continue;
    // source 是 `owner/repo`；不是这个形状的（非 GitHub 来源）不收，Sophia 只从 GitHub 装
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.source)) continue;
    const name = s.skillId || s.name;
    if (!name) continue;
    const prev = seen.get(s.id);
    if (!prev || s.installs > prev.installs) {
      seen.set(s.id, { name, repo: s.source, installs: s.installs });
    }
  }
}

function ranked() {
  return [...seen.values()].sort(
    (a, b) => b.installs - a.installs || a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name),
  );
}

async function main() {
  for (const term of TERMS) {
    absorb(await search(term));
  }
  // 第二轮：前 N 里出现过的仓库与 owner
  const extra = new Set();
  for (const s of ranked().slice(0, TOP)) {
    const [owner, repo] = s.repo.split("/");
    for (const t of [repo, owner]) {
      if (t.length >= 2 && !TERMS.includes(t.toLowerCase())) extra.add(t.toLowerCase());
    }
  }
  for (const term of extra) {
    absorb(await search(term));
  }

  const top = ranked().slice(0, TOP);
  if (top.length < TOP) {
    throw new Error(`只凑到 ${top.length} 个，不足 ${TOP}，不写文件`);
  }
  const file = {
    note: "热门快照（spec R5）：scripts/market-snapshot.mjs 生成，勿手改。发布前重跑。",
    source:
      "skills.sh /api/search（与 npx skills find 同一接口）。没有匿名可用的排行榜接口，用一批常见词与前列仓库名逐个搜，按 owner/repo/skill 去重，按装过人数取前 " +
      TOP +
      "。近似值：名字不含任何搜索词、仓库又不在前列的 skill 可能漏掉。",
    generatedAt: new Date().toISOString(),
    skills: top.map(({ name, repo, installs }) => ({ name, repo, installs })),
  };
  writeFileSync(OUT, JSON.stringify(file, null, 2) + "\n");
  console.log(
    `${requests} 次请求，去重后 ${seen.size} 个 skill；写入前 ${top.length} 个到 ${OUT}；` +
      `第 1 名 ${top[0].installs}，第 ${TOP} 名 ${top[TOP - 1].installs}`,
  );
}

main().catch((err) => {
  console.error(`快照失败，未写文件：${err.message}`);
  process.exit(1);
});

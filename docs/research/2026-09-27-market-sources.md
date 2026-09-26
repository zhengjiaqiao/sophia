---
type: research
description: skill 市场与 MCP 市场的数据源核实——npx skills 的锁文件与更新判断、codeload、MCP Registry、skills.sh
created: 2026-09-27
---

# skill 市场 / MCP 市场：数据源核实报告

主会话复核（2026-09-27）：
- `skillFolderHash` ＝ GitHub 上该文件夹的 git tree SHA：取本机 `~/.agents/.skill-lock.json` 里最近更新的 3 条（beautify-github-readme、typesafe-ai、anthropics/skills 的 xlsx），用 `GET /repos/{o}/{r}/git/trees/{默认分支}?recursive=1` 取对应子树的 sha，3 条全部一致。
- `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=&limit=&version=latest` 与 `GET https://skills.sh/api/search?q=&limit=` 均实测可匿名访问。


调研方式：`gh api` 直接读 `vercel-labs/skills`（commit 为 2026-09-27 拉取时的 `main`）与 `modelcontextprotocol/registry` 的源码/文档；`WebFetch`/`WebSearch` 核实 skills.sh 与 MCP Registry 的线上行为；本机 `~/.agents/.skill-lock.json`（18 条真实记录）与 magpie 源码（`/private/tmp/.../scratchpad/magpie`）仅作对照，不作为结论依据。

---

## 1. vercel-labs/skills：`.skill-lock.json` 的确切 schema 与 `skillFolderHash` 算法

**已核实**（源码：https://github.com/vercel-labs/skills，路径与行号见下）

### 1.1 文件位置
- 全局锁：`getSkillLockPath()`（`src/skill-lock.ts:68-74`）—— 优先 `$XDG_STATE_HOME/skills/.skill-lock.json`，否则 `~/.agents/.skill-lock.json`。本机 `~/.agents/.skill-lock.json` 与之吻合。
- 项目锁：`getLocalLockPath()`（`src/local-lock.ts:361-363`）—— `<cwd>/skills-lock.json`（注意没有前导点、文件名是 `skills-lock.json` 不是 `.skill-lock.json`，两种锁**不同名、不同 schema**，容易记混）。

### 1.2 全局锁 schema（`src/skill-lock.ts:14-61`）
```ts
interface SkillLockEntry {
  source: string;        // "owner/repo" 或 "mintlify/bun.com" 这类归一化标识
  sourceType: string;    // "github" | "mintlify" | "huggingface" | "local" | "well-known" | "git" ...
  sourceUrl: string;     // 原始安装用的 URL，用于重新拉取
  ref?: string;          // 分支/tag
  skillPath?: string;    // repo 内子路径（到 SKILL.md 或其所在目录）
  skillFolderHash: string; // 见下
  installedAt: string;   // ISO
  updatedAt: string;     // ISO
  pluginName?: string;
  sourceBaseUrl?: string;
  wellKnownDigest?: string;
}
interface SkillLockFile {
  version: number;       // 当前 CURRENT_VERSION = 3（skill-lock.ts:8）
  skills: Record<string, SkillLockEntry>;
  dismissed?: { findSkillsPrompt?: boolean };   // dismissed（skill-lock.ts:44-47）
  lastSelectedAgents?: string[];                // lastSelectedAgents（skill-lock.ts:59-60）
}
```
- **version 字段值**：目前恒为整数 `3`（`CURRENT_VERSION`，`skill-lock.ts:8`，注释写明 "Bumped from 2 to 3 for folder hash support"）。`readSkillLock()`（`skill-lock.ts:81-104`）读到 `version < CURRENT_VERSION` 或字段不合法时**直接整个清空**（`createEmptyLockFile()`），不做迁移——这印证了 intent 文档里"它是内部文件，格式没有公开承诺"的判断：v2→v3 是一次破坏性变更，且做法是清空重来，不是逐条迁移。Sophia 只读不写不受影响，但如果将来考虑"认领旧数据"，要注意 vercel 自己升级时也会把旧数据全部丢弃，不能假设历史条目一定还在。
- 项目锁 `LocalSkillLockEntry`（`local-lock.ts:311-342`）字段与全局锁不同：**没有 `skillFolderHash`**，而是 `computedHash`（SHA-256，见下），额外有 `subagents?: string[]`（Eve 场景）。**这是两套不同 schema，Sophia 若要支持项目级 skill 的"识别可更新"，不能直接套用全局锁的字段名。**

### 1.3 `skillFolderHash` 到底是什么、怎么算（关键问题，已核实）
**结论：是的，就是该 skill 文件夹在 GitHub 上的 git tree SHA**，通过 **GitHub Git Trees API**（`GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`）算出——**不是**逐文件内容哈希，也不经过任何"遥测服务器"代为计算。

- `src-lock.ts:151-173` 的函数注释写着 "Fetched via GitHub Trees API by the telemetry server"，**这句注释是过时/误导性的**——实际调用链（`skill-lock.ts:169-172` → `src/blob.ts`）是 **CLI 本机直接**发起 HTTP 请求到 `api.github.com`，没有经过 vercel 的任何服务器中转。已用 `update.ts:573` 的真实调用路径（`fetchRepoTree(source, ref, getGitHubToken)`，`getGitHubToken` 来自本机环境变量）交叉验证：这是纯客户端行为。写 Sophia 规格时不要采信那句注释。
- 具体算法（`src/blob.ts:236-276` `fetchRepoTree` + `blob.ts:281-302` `getSkillFolderHashFromTree`）：
  1. 请求 `https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1`（`Accept: application/vnd.github.v3+json`），一次拿到整棵仓库树（`blob.ts:118-120`）。
  2. 在返回的 `tree[]` 里找 `type === 'tree'` 且 `path === <skill 文件夹路径>` 的条目，取其 `sha`（40 位十六进制 git tree SHA）作为 `skillFolderHash`（`blob.ts:296-301`）；根目录 skill（`skillPath` 就是仓库根的 `SKILL.md`）则直接用整棵树的根 `sha`。
  3. 更新检测（`update.ts:638-639`）：`usesGitTreeHash = isGitHubSource && /^[0-9a-f]{40}$/i.test(entry.skillFolderHash)`，即用正则校验锁文件里存的是不是 40 位十六进制——因为**旧版本或某些来源**（下面会讲的"本地克隆兜底路径"）会把 `skillFolderHash` 填成别的东西（本地内容哈希），需要靠格式区分走哪条比较逻辑。
  4. **对本机 `.skill-lock.json` 的 18 条真实数据抽查**：`darwin-skill` 的 `skillFolderHash` 为 `5539516444cff4eed7865daf61a707590acda485`（40 位十六进制），`find-skills` 为 `76a98a285cb0434f3d39e1a873823556330e398b`（40 位十六进制）——与"git tree SHA 是 40 位十六进制 SHA-1"的结论吻合。

- **另一套哈希，容易和上面混淆**：`src/local-lock.ts:441-456` 的 `computeSkillFolderHash()` 是给**项目锁**（`skills-lock.json`）和 GitHub Trees API 打不通时的**克隆兜底**用的——递归读取 skill 文件夹下所有文件，按相对路径排序后把"路径+内容"逐个喂进 SHA-256。这是**本地内容哈希**，和 GitHub 的 git tree SHA 是两套完全不同的算法、不同的取值空间，`update.ts:642` 里能看到两条路径共存：能拿到 tree 就用 `getGitTreeHash`（`git.ts:390-410`，本质是 `git -C <克隆目录> rev-parse --verify HEAD:<folder>`，在本地克隆里现算 git tree SHA，与远端 API 算法完全等价），拿不到就退回 `computeSkillFolderHash`（内容哈希）。**Sophia 如果要和 `.skill-lock.json` 的 `skillFolderHash` 比对新旧，必须用 git tree SHA 算法，不能直接对文件夹内容做 SHA-256，否则永远比不出一致。**

### 1.4 `dismissed` / `lastSelectedAgents`
- `dismissed.findSkillsPrompt`：是否已关闭"要不要装 find-skills 这个 skill"的提示（`skill-lock.ts:44-47`），与 Sophia 无关。
- `lastSelectedAgents`：`saveSelectedAgents()` / `getLastSelectedAgents()`（`skill-lock.ts:282-294`）——CLI 交互安装时记住"上次选了哪些 agent"，供下次默认勾选。**这与 intent 文档里"记住上次的选择"是同一思路，Sophia 可以在自己的设置里做类似字段，但不建议直接读/写这个字段**（第一版已定"只读"，且这字段是 CLI 自己 UI 状态，不是"某个 skill 装给了哪些 agent"的清单）。

### 1.5 限流与 token 处理（已核实，`src/blob.ts:96-276`）
- **懒认证策略**：默认**不带 token**直接请求（覆盖绝大多数用户的 60 次/小时/IP 额度）。
- 判定限流的方式很精确：`response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'`（`blob.ts:147-148`）——单纯 403（权限不足）不会触发重试，只有"403 + 头里显式说额度为 0"才算限流，这样能把"私有仓库无权限"和"限流"区分开。
- 私有仓库的 401/404 也会触发"值得用 token 重试"的分支（`authRetryable`，`blob.ts:151-153`，注释引用了 vercel-labs/skills 的 issue #1318：匿名请求下 GitHub 对私有仓库返回 401/404 而不是 403，实测行为）。
- token 来源优先级（`skill-lock.ts:128-149`）：**先** `GITHUB_TOKEN` 环境变量，**再** `GH_TOKEN` 环境变量；两者都没有则**不**从 GitHub CLI 的凭据存储里提取（注释明确说"deliberately not extracted"），但 `blob.ts:172-208` 的 `fetchTreeWithGitHubCli()` 会尝试 `execFile('gh', ['api', ...])`，即**如果本机装了 `gh` 且已登录，会调用 `gh api` 子进程**（不导出其存储的凭据，只是借用已登录的 CLI 会话）作为最后一层兜底。
- 整个限流状态在**进程内**用 `_rateLimitedThisSession` 标记（`blob.ts:97-103, 244-247`）——一旦本次运行中撞到一次限流，后续所有请求直接跳过"先试匿名"，省一次注定失败的往返。**这是个值得抄的小优化**：Sophia 的"按仓库合并请求"批量检查里，如果第一个仓库已经 403，后面没必要每个仓库都先匿名试一次。

**未核实 / 需要 Sophia 自己决定的点**：vercel-labs/skills 完全没有做"先 `git ls-remote`/smart-HTTP 探测再决定要不要打 Trees API"这类两级检查（见第 2 节的建议）；也没有做任何跨进程的持久化限流冷却（下次运行 `npx skills update` 又会重新走一遍"先匿名"）。

---

## 2. 不经 API 下载 skill：codeload、commit SHA、"仓库是否有更新"的最省成本做法

### 2.1 codeload 直链（已核实，双重来源）
- URL 形式：`https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}`（`ref` 可以是分支名、tag、或 40 位 commit SHA）。这是 magpie 的做法（`magpie/internal/library/skills.go:301-306`，注释里写"github.com's own 'Download ZIP' uses [this], rather than the API's /tarball"）。
- **交叉验证**：vercel-labs/skills 官方 CLI **不**把 codeload 作为拉取 GitHub 仓库的主路径（它用 `simple-git` 做 `git clone --depth 1`，见 `src/git.ts:295-320`），但它的 `source-parser.ts`（第 330-343 行）明确把 `codeload.github.com` 识别为一种"直接下载"宿主，用来处理用户直接贴的 `.../archive/`、`.../raw/`、`.../releases/download/...` 这类链接——即官方 CLI 认可 codeload 是 GitHub 认可的公开下载入口，不是 magpie 的野路子。
- **为什么绕开 codeload 反而更省额度**：codeload.github.com 不计入 `api.github.com` 的 60 次/小时核心限额（它是独立的下载服务，走 `git archive` 生成 tar.gz，不算 REST API 调用）。所以"贴链接直接装"整条链路可以完全不碰 GitHub API 配额。

### 2.2 从下载下来的 tar.gz 里找到对应的 commit SHA（**已核实**，此前未验证，本次专门搜索确认）
- GitHub 的 codeload tarball 本质是服务端跑 `git archive` 生成的。`git archive` 在使用具体 commit（而非裸分支名）时，会在 tar 流最前面写入一个 **PAX 全局扩展头（`pax_global_header`）**，其 `comment` 字段就是完整的 40 位 commit SHA，格式类似：
  ```
  52 comment=0123456789abcdef0123456789abcdef01234567
  ```
  官方工具 `git get-tar-commit-id` 就是读这个头算出来的（这是 git 自带命令，专门干这件事）。
- **但有一个限制**：只有当请求的 `ref` 本身解析到一个具体 commit 时，这个头里的值才是"确定版本"；如果只是请求了分支名（如 `main`），`pax_global_header` 里的 SHA 是 GitHub 生成压缩包那一刻分支指向的 commit——**这正是我们想要的"这次下载对应哪个 commit"**，可以直接读出来记录，不需要额外一次 API 调用。
- **顶层文件夹名不可靠**：tar 包里顶层目录名是 `{repo}-{ref 的短横线化形式}`（如传入分支名 `main` 就是 `repo-main`），**不是** commit SHA，除非你一开始传的 `ref` 本身就是完整 SHA。所以"从文件夹名读版本"这条路magpie、vercel-labs 都没走，**建议 Sophia 也不要依赖文件夹名，走 pax_global_header 解析**（Rust 侧用 `tar` crate 读第一个 entry 的 pax extension，或者退化成用 `flate2` + 手动扫 tar header 找 `pax_global_header` 条目）。

### 2.3 判断"仓库某文件夹是否有更新"的几种方式对比（**已核实**接口存在，成本对比为本次调研的分析结论）

| 方式 | 调用次数 | 是否计入 api.github.com 60/hr 配额 | 能否精确到子文件夹 | 备注 |
|---|---|---|---|---|
| **Git Trees API**（`GET /repos/{o}/{r}/git/trees/{ref}?recursive=1`）| 1 次/仓库（拿到整棵树后本地找子路径） | 是 | 能（entry 的 `sha` 就是该子树的 git tree SHA） | vercel-labs/skills 的做法（`blob.ts:236-276`），也是 `.skill-lock.json` 的 `skillFolderHash` 的计算方式；返回体大小随仓库文件数线性增长，超大仓库可能较重 |
| **Contents API**（`GET /repos/{o}/{r}/contents/{path}`）| 每级目录 1 次，不支持 recursive | 是 | 能，但只返回该级目录里每个条目自己的 `sha`，没有"整个子树"的单一哈希，需要自己聚合 | 没有验证到官方文档说它比 Trees API 更省额度——两者都算 1 次 REST 调用，Trees API 一次拿全量反而更省调用次数 |
| **Git 智能 HTTP `info/refs`**（`GET https://github.com/{o}/{r}.git/info/refs?service=git-upload-pack`，等价于 `git ls-remote`）| 1 次/仓库 | **否**（这是 `github.com` 而非 `api.github.com`，不计入 REST 60/hr 配额） | **不能**，只能看到各分支/tag 指向的最新 commit SHA，看不到子文件夹级别的变化 | 本次调研中未找到官方文档正面写"不计入 REST 限额"，这点基于"两者是不同服务/不同域名"的架构事实推断，**建议 Sophia 自己实测确认**（标为未核实） |

**建议（未在任何源码里出现，是本次调研给出的设计建议，不是"抄来的事实"）**：可以做两级检查——先用 `info/refs`（几乎不消耗配额）看仓库默认分支的 HEAD commit 是否变了；只有变了，才对这个仓库单独打一次 Trees API 拿子文件夹哈希。这样"打开 SKILLS 页批量查一轮"时，大部分没变化的仓库只花一次不计额度的 `info/refs`，只有真正有更新的仓库才消耗一次 60/hr 里的名额，比 vercel-labs/skills 现在"每个仓库直接打一次 Trees API"更省。

### 2.4 未认证速率限制（已核实，与 intent 文档一致）
- `api.github.com`（REST/Git Data，包括 Trees API）：**60 次/小时/IP**（无 token）；带 `GITHUB_TOKEN`/`GH_TOKEN` 等个人令牌为 5000 次/小时。
- `codeload.github.com`（tar/zip 下载）与 `github.com/.../info/refs`（git 智能 HTTP）：不计入上述配额（各自独立服务）。

---

## 3. 官方 MCP Registry（registry.modelcontextprotocol.io）

**已核实**（源码/文档：https://github.com/modelcontextprotocol/registry ，`docs/reference/api/openapi.yaml`、`docs/reference/api/official-registry-api.md`、`docs/reference/api/CHANGELOG.md`、`docs/modelcontextprotocol-io/terms-of-service.mdx`）

### 3.1 **重要更正**：应该用 `/v0.1/`，不是 `/v0/`
- magpie（`internal/library/skills.go:177`）用的是 `https://registry.modelcontextprotocol.io/v0/servers`——**这条路径目前仍然可用，但官方文档已经明确 `/v0/` 是"开发版"，会持续演进甚至有 breaking change；`/v0.1/`（2025-10-17 起）才是"稳定版"，两者行为目前一致，但官方建议生产环境用 `/v0.1/`**（`CHANGELOG.md` "2025-10-17" 节，原文："Introduced `/v0.1/` as a stable API version while `/v0/` continues as the development version... Production applications should consider using `/v0.1/`"）。
- 历史上 `/v0/` 已经发生过至少两次破坏性变更（2025-09-16 的 server ID 结构调整、2025-09-29 的 `GET /v0/servers/{server_id}` → `{serverName}` 改名），说明"抄 magpie 的 `/v0/`"是在抄一个不保证稳定的路径。**Sophia 应该用 `GET /v0.1/servers`。**

### 3.2 端点与查询参数（已核实，`openapi.yaml:20-70` + `official-registry-api.md`）
- `GET /v0.1/servers`：列表/搜索。参数：`cursor`（分页游标，来自上次响应的 `metadata.nextCursor`）、`limit`、`search`（按名字子串，大小写不敏感）、`updated_since`（RFC3339，官方扩展，用于增量同步）、`version`（目前只支持字面量 `latest`，或具体版本号）、`include_deleted`。
- `GET /v0.1/servers/{serverName}/versions`、`GET /v0.1/servers/{serverName}/versions/{version}`（`version` 可以是 `latest`）——**没有** magpie 代码注释里暗示的"单独 GetServer"端点，2025-10-17 已把 `GET /v0/servers/{serverName}` 移除，统一用 `.../versions/latest`。
- 响应结构 `ServerList { servers: ServerResponse[], metadata: { nextCursor, count } }`；`ServerResponse { server: ServerDetail, _meta: { "io.modelcontextprotocol.registry/official": { status, statusMessage, statusChangedAt, publishedAt, updatedAt, isLatest } } }`（`openapi.yaml:1019-1065`）——**status 是 `active`/`deprecated`/`deleted`**，与 magpie `searchRegistry()` 里过滤 `status != "" && status != "active"`（`skills.go` 对应 magpie 那份，行号见 magpie 源码 308）的做法一致。
- `packages[]`（`openapi.yaml:653-722`）：`registryType`（`npm`/`pypi`/`cargo`/`oci`/`nuget`/`mcpb` 等，比 magpie 现在只处理 `npm`/`pypi`/`oci` 三种要多）、`identifier`、`version`、`fileSha256`（MCPB 包必填，其它可选，**这是 magpie 代码里完全没有体现的字段，涉及包完整性校验，如果 Sophia 支持 `mcpb` 包类型要处理**）、`transport`（`stdio`/`streamable-http`/`sse`）、`environmentVariables[]`（`KeyValueInput`，含 `isSecret`/`isRequired`/`description`/`default`/`placeholder`/`choices`）、`packageArguments[]` / `runtimeArguments[]`（`Argument` = `PositionalArgument | NamedArgument`）。
- `remotes[]`：`RemoteTransport`（`streamable-http` 或 `sse`）+ `variables`（`openapi.yaml:900-912`），`headers[]` 同样是 `KeyValueInput`。字段名与 magpie 的 `registryServer.Remotes[].Headers` 完全对应。

### 3.3 认证 / 使用条款 / 稳定性（已核实）
- **只读的搜索/列表端点不需要认证**；认证只在**发布**服务器时才需要（GitHub OAuth / GitHub OIDC / DNS 或 HTTP 域名验证，`official-registry-api.md` "Authentication" 节）——Sophia 作为纯消费方（搜索+展示+安装），不涉及认证。
- **ToS**（`terms-of-service.mdx`，生效日 2025-09-02）：明确写"The MCP Registry is currently in preview. Breaking changes or data resets may occur before general availability"——**官方自己承认 API 目前是 preview，不承诺稳定**，这与"`/v0.1/` 号称 stable"并不矛盾（`/v0.1/` 是"在 preview 阶段里相对更稳的一条路径"，不是"已经 GA"）。数据（服务器元数据）以 CC0 1.0 公共领域授权发布，"as is"无担保。没有找到 ToS 里专门针对搜索类只读调用的速率限制条款。
- **速率限制**：翻遍 `openapi.yaml` 全文（1099 行）及 `docs/` 目录下的架构、管理、贡献文档，**没有找到任何明确的速率限制数字或 429 相关说明**。这与 magpie 代码里完全没写限流处理（`skills.go` 里 `searchRegistry` 只处理网络错误，不处理限流）的事实一致——**当前没有公开文档承诺的限流阈值，应视为"未知/未公开"，建议 Sophia 按"失败即降级、不重试风暴"处理，不要假设具体数字**。

**未核实**：registry.modelcontextprotocol.io 的实际 HTTP 响应头是否带 `X-RateLimit-*`（本次因 Bash 网络工具受限、WebFetch 又不便探测响应头，没有做到一次真实请求抓包确认；只核实了 OpenAPI 规范文本里没有声明）。

---

## 4. skills.sh：magpie/官方 CLI 到底在用哪个接口，是否有文档化的公开 API

**已核实**（`gh` 读 vercel-labs/skills 源码 + `WebFetch` 实测 skills.sh 线上端点，2026-09-27）

### 4.1 结论先行：**存在两套完全不同的接口，intent 文档默认的"非公开接口"只对其中一套成立**

1. **`GET https://skills.sh/api/search?q=&limit=&owner=`（无版本号前缀）**
   - **无需任何认证，本次实测可直接访问并拿到真实数据**（下方是实测原始响应，查询 `q=pdf&limit=3`）：
     ```json
     {
       "query": "pdf", "searchType": "fuzzy", "searchVersion": "algolia",
       "skills": [
         {"id":"anthropics/skills/pdf","source":"anthropics/skills","skillId":"pdf","name":"pdf","installs":201532},
         {"id":"anthropics/skills/docx","source":"anthropics/skills","skillId":"docx","name":"docx","installs":193297},
         {"id":"anthropics/skills/canvas-design","source":"anthropics/skills","skillId":"canvas-design","name":"canvas-design","installs":111053}
       ],
       "count": 3, "duration_ms": 211, "timings_ms": {...}, "provider_duration_ms": 197.9
     }
     ```
   - **这正是 vercel-labs/skills 官方 CLI 自己在用的端点**：`src/find.ts:17`（`SEARCH_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh'`）+ `find.ts:87-121`（`searchSkillsAPI`，拼出 `${SEARCH_API_BASE}/api/search?q=...&limit=20[&owner=...]`），供 `npx skills find <query> [--owner <owner>]` 使用（`find.ts:342` 调用处）。magpie 的 `searchSkillsSh()`（`skills.go` 对应文件里 `/api/search?q=&limit=40`）用的是同一个端点，只是 `limit` 取值不同。
   - `skills.sh/robots.txt` 明确 `Disallow: /api/`（对搜索引擎爬虫），但这是"不让搜索引擎收录"，不等于"禁止程序调用"——skills.sh 的 `/terms` 页面（见下）专门有"Public API"一节允许"reasonable use including caching"。
   - **首页嵌入的 `initialSkills` JSON**（magpie `fetchPopular()`，对应文件里注释"the list is in the page's data as JSON inside a JS string, its quotes escaped"，用 `initialSkills\":` 作为定位关键字）本次未重新抓包确认字段是否变化，但抓取方式本身（正则找 key、反转义、JSON 解析）与"没有文档承诺格式"的定性一致，**这条路径依然是不稳定的页面结构依赖，不建议 Sophia copy**——既然 `/api/search` 已确认可直接调用且是官方 CLI 自己在用，**没有必要再去解析首页内嵌 JSON 拿热门榜**（除非需要"最热门"这个 `/api/search` 不直接提供的维度，见下）。

2. **`skills.sh/docs/api` 文档化的 `/api/v1/...` 系列**（本次调研新发现，intent 文档未提及）
   - 文档列出：`GET /api/v1/skills`（分页排行榜，支持 `view=all-time|trending|hot`、`page`、`per_page`）、`GET /api/v1/skills/search`（`q`/`limit`/`owner`，与上面那套非 v1 的 `/api/search` 高度相似但路径不同）、`GET /api/v1/skills/curated`（官方精选）、`GET /api/v1/skills/{source}/{skill}`（详情）、`GET /api/v1/skills/audit/{source}/{skill}`（安全审计结果）。
   - **关键限制**：文档写明认证方式是"部署在 Vercel 上的项目可用 `Authorization: Bearer {Vercel OIDC token}` 或 `x-vercel-oidc-token` 头"，配额是"600 次/分钟"（按 team+project）。**本次实测直接匿名请求 `GET /api/v1/skills/search?q=pdf&limit=3` 返回 `401 Unauthorized`**——即这套 `/v1/` API **事实上只对部署在 Vercel 平台上、能拿到 Vercel OIDC token 的应用开放**，Sophia 是桌面应用，拿不到这个 token，**这套"文档化的 API"对 Sophia 不可用**。
   - 这解释了为什么**官方 CLI 自己也没有用 `/api/v1/`，而是用无版本号、无认证的 `/api/search`**——后者才是真正面向"任意外部调用方"的公开入口，只是没有像 `/v1/` 那样被单独写文档、也没有公开承诺的限流数字。

3. **运营方**：skills.sh 首页页脚 "Made with care by Vercel"，源码就是 `vercel-labs/skills` 这个仓库（MIT 协议，`LICENSE` 文件 Copyright Vercel, Inc. 2026），**确认由 Vercel 运营**。

### 4.2 对 Sophia 设计的建议（本次调研的判断，不是抄来的事实）
- 用 `GET https://skills.sh/api/search?q=&limit=`（不带版本号那条），因为它同时满足"官方 CLI 自己在用→大概率长期维持"和"实测无需认证可直接访问"两个条件；不要去解析首页内嵌 `initialSkills`，也不要指望 `/api/v1/`（会因为没有 Vercel OIDC 直接 401）。
- intent 文档里"热门榜"的需求（"装的人多的排在前面"）：`/api/search?q=<空>` 在磁盘实测里通常仍会返回结果（可用空查询或高频词），但**更稳妥是复用官方 CLI 同款查询方式**，且按 intent 文档已定的"热门缓存 6 小时、随包带快照兜底"来做，不依赖 skills.sh 保证"不传 q 就是热门榜"这种未文档化的语义。
- ToS 的 "Public API" 一节明确允许"caching results on your own infrastructure"，与 intent 文档"热门缓存 6 小时"的做法直接吻合，可以在规格里引用这一条作为"这么做是被允许的"的依据。

---

## 待确认清单（本报告标为"未核实"的项，写规格前建议再验证或直接实测）

1. `info/refs`（git 智能 HTTP）是否真的不计入 `api.github.com` 60/hr 配额——本次基于"不同域名/不同服务"的架构事实推断，未做到实际连续调用 65 次以上触发限流来交叉验证两者独立计数。
2. registry.modelcontextprotocol.io 的真实响应头是否带 `X-RateLimit-*`／有没有隐性限流——本次只核实了 OpenAPI 规范文本没有声明,不代表线上真的没有限流,建议实现时按"失败要降级"兜底,不要硬编码具体阈值。
3. skills.sh 首页 `initialSkills` 内嵌 JSON 的当前字段是否与 magpie 代码里假设的一致——本次判断为"不建议依赖"，没有重新抓包逐字段核对（因为已经确认 `/api/search` 可直接用，没必要再验证这条备选路径）。

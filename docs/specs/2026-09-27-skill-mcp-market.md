---
type: spec
description: SKILLS / MCP 两页加「我的 ｜ 发现」；筛选收成一行；从市场、GitHub 链接装 skill 并能更新；从市场、粘贴 JSON 加 MCP
created: 2026-09-27
---

# 发现与安装：skill 市场、MCP 市场 — Spec

依据：`docs/intent/2026-09-27-skill-mcp-market.md`（「已定」一节）。数据源事实：`docs/research/2026-09-27-market-sources.md`；参照实现：`docs/research/2026-09-27-magpie.md`。本版不含 MCP 新增 agent（见 `docs/specs/2026-09-27-mcp-batch1.md`），装 MCP 时可选的 agent 就是当时 MCP 页支持的那些。

## 需求

### 页面与筛选

- **R1 我的 ｜ 发现。** SKILLS、MCP 两页页面头左端是滑槽 `我的 ｜ 发现`，默认 `我的`。两页各记各的；切到别的页再回来，停在上次那一边。
- **R2 我的：筛选收成一行。** 表格上方只有一行：左边 `位置` 胶囊 `全部`、`用户级`、各项目（按最近活跃排）、`更多 ▾`；右端 `来源：全部 ▾` 下拉。取代范围滑槽、项目筛选片与来源胶囊行。
  - 位置单选：`全部`＝用户级 + 全部项目；`用户级`；某个项目＝只看这个项目。
  - 项目胶囊最多 6 个，放不下时提前收进 `更多`，这一行不折行。
  - 来源下拉只列当前位置里有的来源；换了位置、原来选的来源不在了，回到 `全部`。
  - 右端键不变：筛选框、`管理来源`、`+ 来源`。
- **R3 记忆迁移。** 旧导航状态迁到新位置：`全部`（未选项目）→ `全部`；`全部 + 项目 X` → X；`用户级` → `用户级`；`项目级`（未选）→ `全部`；`项目级 + X` → X；X 已不在 → `全部`。旧的来源筛选不迁，回到 `全部`。
- **R4 发现的页面头。** `发现` 下页面头右端是搜索框（占位 `搜索 skill` / `搜索 MCP`）与 `粘贴链接`（SKILLS）或 `粘贴 JSON`（MCP）；没有筛选行，不出 `管理来源`、`+ 来源`。

### 发现 · skill

- **R5 列表。** 没输入时列「热门」，输入时列搜索结果；一行一个 skill：名字、来源仓库（`anthropics/skills`）、装过的人数、`安装` 键。已装过的，`安装` 换成 `已安装`（悬停出装在哪些位置），仍可点，用来装到别的位置。
  - 热门：随版本发布的快照（发布时从 skills.sh 取装过人数最多的 200 个）。不从网页里抠。
  - 搜索：`GET https://skills.sh/api/search?q=&limit=`（与 `npx skills find` 同一个接口），输入停 300ms 后才查；结果缓存 6 小时（skills.sh 的使用条款允许缓存）。
  - 拉开一行，显示这个 skill 的说明（取仓库里 `SKILL.md` 的描述，走 `raw.githubusercontent.com`，不占 GitHub API 次数）。
- **R6 粘贴链接。** 接受：`owner/repo`、`https://github.com/owner/repo`、`…/tree/<分支>/<路径>`、指向某个 `SKILL.md` 的 `…/blob/…` 链接。解析出仓库、分支、路径后下载；里面只有一个 skill 就直接进安装面板，有好几个就先列出来勾选。认不出的链接当即说明 `只认 GitHub 上的仓库或文件夹链接`，不发请求。

### 发现 · MCP

- **R7 列表。** 没输入时列精选，输入时先列精选里匹配的，再列官方目录的搜索结果；一行：名字、发布方、一句说明、需要填什么（`需要 API key`、`需要登录`）、`安装` 键；已写进过的同 R5。
  - 精选：随版本发布的清单（起点参考 magpie 的精选条目，MIT，注明出处），每条写清连接方式与要填的项。
  - 官方目录：`GET https://registry.modelcontextprotocol.io/v0.1/servers?search=&limit=&version=latest`（用 `v0.1`，不用会做破坏性变更的 `v0`）；只列 `status` 为 `active` 的；包类型只收 `npm`、`pypi`、`oci` 与远程地址，其余不列。
- **R8 粘贴 JSON。** 认 `{"mcpServers": {…}}`、`{"servers": {…}}`、`{"context_servers": {…}}`、`{"mcp_servers": {…}}`（TOML 也行：`[mcp_servers.x]`）、单个服务器对象（要求填名字）。一次贴了好几个就列出来勾选。解析不了的说明哪一行错。

### 安装

- **R9 装 skill。** 安装面板里选：
  - **位置**：`用户级` 或某个项目，二选一；每项悬停显示落点完整路径（`~/.agents/skills/<名字>` / `<项目>/.agents/skills/<名字>`）。默认取当前 `我的` 的位置；是 `全部` 时默认 `用户级`。
  - **agent**：默认勾上「SKILLS 的列」里显示的 agent，并记住上次的选择。这个位置的 agent 本来就直接读 `.agents/skills` 的（项目里的 9 家），不需要建链接，勾选行上写 `直接读取，不用链接`。
  - 按下 `安装`：下载 → 解包到落点（目录不存在就创建，并成为这个位置的「通用仓库」来源）→ 给勾选的 agent 建链接 → 例行提示条 `✓ 已安装 pdf` + `撤销`。
  - 落点已有同名的：不覆盖，面板里说明 `用户级的通用仓库里已经有 pdf` + `打开 ↗`，`安装` 不可点。
  - 单个包上限 50MB；下载地址、落点在面板里写明。
- **R10 装 MCP。** 安装面板里选位置（同 R9）与 agent（默认「MCP 的列」，记住上次）；有需要填的项（环境变量、请求头、参数）逐项列出，标明哪些必填、哪些是密钥（输入框遮住）。某个 agent 写不过去时（传输方式不支持等），那一项不能勾，并说明原因。按下 `安装`：写进每个勾选的 agent → `✓ 已写进 [图标…] github` + `撤销`。
  - 目标里已有同名的：一样的跳过；不一样的不覆盖，那一项不能勾，说明 `Codex 里已经有一个不一样的 github`。
- **R11 撤销。** 装 skill 的撤销：删掉建的链接，落点里新建的文件夹移进暂存（与「删除原件」同一套暂存，下一次删除或重开时进废纸篓）。装 MCP 的撤销：沿用 MCP 写入的撤销。

### 更新

- **R12 记下装的是哪一版。** 装 skill 时记：仓库、分支、仓库内路径、那个文件夹的 git tree SHA（与 `.skill-lock.json` 的 `skillFolderHash` 同一种）、装的时刻。记在 Sophia 自己的存储里，不写 `.skill-lock.json`。
- **R13 认出别的工具装的。** 读 `~/.agents/.skill-lock.json`（只读）：`sourceType` 为 `github` 的条目，按它记的 `source`、`skillPath`、`skillFolderHash` 当作可更新的 skill。读不懂（版本不是 3、字段不对）就当没有，不报错。
- **R14 查更新。** 打开 SKILLS 页、距上次超过 6 小时时查一次。设置里有 `自动检查 skill 更新` 开关（默认开），旁边一颗 `立即检查`（不加页面头的键）。按仓库合并：一个仓库一次 `GET /repos/{o}/{r}/git/trees/{分支}?recursive=1`，取各个 skill 文件夹的 tree SHA 与记下的比较。
- **R15 显示与更新。** 有新版本的行，名字后挂纯文字记号 `有更新`；点它（或右键 `更新`）进确认：
  - 本地没改过：直接更新，例行提示条 `✓ 已更新 pdf` + `撤销`。
  - 本地改过（本地按 git 规则算出的 tree SHA 与记下的不同）：先确认，列出改过的文件，说明 `更新会覆盖这些改动`；确认后更新。
  - 更新：下载新版 → 旧版移进暂存 → 新版放到原处，链接不动。撤销＝新版移走、旧版放回。
- **R16 限流与失败。** GitHub 未登录每小时 60 次：被限流时在触发处说 `GitHub 暂时限流，稍后再试`，不弹窗、不自动重试。skills.sh、MCP 目录、下载任何一个失败，只影响对应那一块：`发现` 列表显示上次缓存（没有就是随包快照），并在列表上方一行灰面板说明 `现在连不上 skills.sh，显示的是上次的结果`；`我的` 不受影响。

## 非功能需求

- `crates/core` 不联网、不异步：下载、搜索、查更新的网络请求在 `src-tauri`；链接解析、tar 解包与校验、git tree SHA 计算、lock 文件读取、计划与执行放在 core，可在临时目录里测。
- 解包安全：拒绝包内的绝对路径、`..`、软链接、设备文件；只取指定路径下的文件；解包在落点同盘的临时目录完成，校验有 `SKILL.md` 后整目录改名到位。
- 写用户配置只走 `atomicfile`；建链接、删链接走现有 `sync` 的安全路径。
- 不读、不存任何 agent 的登录凭证；MCP 安装面板里用户填的密钥只写进目标配置文件，不进 Sophia 的设置、日志与诊断。
- 网络请求只在：打开 `发现`、搜索、安装、查更新时发生；不开后台常驻进程。

## 设计

### 1. 模块划分

| 层 | 新增 / 改动 |
|---|---|
| core | `market/link.rs`（GitHub 链接解析）、`market/archive.rs`（tar.gz 解包、读 `pax_global_header` 里的提交 SHA、安全检查）、`market/treehash.rs`（按 git 规则算文件夹的 tree SHA）、`market/lock.rs`（读 `.skill-lock.json`）、`market/install.rs`（装 skill、更新的计划与执行，复用 `sync` 的链接与暂存）、`installs` 记录（R12）；MCP：新增「用给定的定义写进这些位置」的入口（现在的写入只能从已有位置复制，`McpSelection.source_id`），检查、拒绝、撤销沿用现有 |
| src-tauri | `market.rs`：skills.sh 搜索、MCP Registry、codeload 下载、GitHub trees、raw 文件；缓存与节流（6 小时）；命令每个一行调 core |
| 前端 | 页面头 `我的 ｜ 发现`、筛选行（替换 `LocationFrame` 里的范围滑槽与项目筛选片、来源胶囊）、`发现` 列表、安装面板、`有更新` 记号与确认 |
| 数据 | `crates/core/data/market/skills-popular.json`（热门快照）、`crates/core/data/market/mcp-curated.json`（精选），发布前用脚本刷新 |

### 2. 安装面板

从右侧推入的二级页（组件库 `PushedPage`），不是弹窗：它要选位置、勾 agent、填若干项。skill 与 MCP 同一个骨架：标题 `安装 pdf`、来自哪里（仓库或发布方，悬停出下载地址）、`位置` 单选、`agent` 勾选行、（MCP）要填的项、底部 `安装` 墨键与 `取消`。

### 3. 与导航规格的关系

本规格改掉 `docs/specs/2026-09-26-object-first-navigation.md` 的 R3（范围滑槽）、R4（项目筛选片）；R6（多位置表格、`位置` 列）、R7（单一位置表格不变）保留：`全部` 时有 `位置` 列，选了 `用户级` 或某个项目时没有。

## 验收标准

凡是写文件或联网安装的操作，都在临时 HOME 上做（`HOME=<临时目录> make dev`）；网络请求可以打真实服务。

| 编号 | 需求 | Given / When / Then | 真实验证 | 代理验证 |
|---|---|---|---|---|
| AC1 | R1 R4 | When 在 SKILLS 切到 `发现`，Then 页面头右端是 `搜索 skill` 与 `粘贴链接`，没有筛选行、`管理来源`、`+ 来源`；切到 MCP 再回来仍在 `发现` | dev 窗口 | nav 状态单测 |
| AC2 | R2 | Given 8 个项目，Then 筛选行是 `全部` `用户级` + 6 个项目 + `更多 ▾`；项目名很长时收得更早且不折行；右端是 `来源：全部 ▾` | 测试 HOME | 筛选行计算单测 |
| AC3 | R2 | Given 选了来源 `WeiboAP`，When 换到一个没有它的项目，Then 来源回到 `全部`，表不为空 | 测试 HOME | 单测 |
| AC4 | R3 | Given 旧状态 `项目级 + CardBox`，When 升级后打开，Then 位置胶囊选中 CardBox；旧状态 `项目级`（未选）→ `全部` | 用旧设置启动 | 迁移单测 |
| AC5 | R5 | When 打开 `发现`（断网），Then 列出随包热门快照，上方灰面板说明连不上；联网后搜索 `pdf` 列出 skills.sh 的结果 | dev 窗口，开关网络 | 搜索解析单测 |
| AC6 | R6 | When 粘贴 `https://github.com/anthropics/skills/tree/main/skills/pdf`，Then 直接进安装面板；粘贴 `anthropics/skills`，Then 列出仓库里的全部 skill 供勾选；粘贴 `https://example.com`，Then 当即说明、不发请求 | 测试 HOME | 链接解析单测（各种写法） |
| AC7 | R9 R12 | When 装 `pdf` 到用户级、勾 Claude Code 与 Codex，Then `~/.agents/skills/pdf/SKILL.md` 存在、两家目录里是指向它的链接、Sophia 记下仓库、路径与 tree SHA；`~/.agents/skills` 原本不存在时被创建并出现在来源下拉里 | 测试 HOME 里 `ls -la` | 安装计划与执行单测 |
| AC8 | R9 | Given 通用仓库里已有 `pdf`，Then 面板说明已有、`安装` 不可点，文件不变 | 测试 HOME | 单测 |
| AC9 | R9 | Given 装到项目，Then 勾选行里 Codex、Cursor 等写 `直接读取，不用链接`，只给其余 agent 建链接 | 测试 HOME | 单测 |
| AC10 | R10 | When 从精选装 `github`（远程、要请求头），填入令牌、勾 Claude Code 与 Codex，Then 两家配置里各多一项，令牌只出现在这两个文件里，不在 Sophia 的设置与日志里 | 测试 HOME，`grep` 令牌 | 单测 + 日志扫描 |
| AC11 | R8 | When 粘贴一段含 2 个服务器的 `{"mcpServers": …}`，Then 列出两项供勾选；粘贴坏的 JSON，Then 说明哪一行错 | dev 窗口 | 解析单测（四种外层写法、TOML、单个对象） |
| AC12 | R11 | When 装完点 `撤销`，Then 链接删掉、新建的文件夹进暂存、来源下拉照旧；MCP 的撤销还原配置文件 | 测试 HOME | 单测 |
| AC13 | R13 R14 R15 | Given lock 里有一个 skill 记的 tree SHA 比 GitHub 上旧，When 打开 SKILLS 页，Then 它的名字后有 `有更新`；更新后记号消失，`撤销` 能放回旧版 | 测试 HOME 放一份造的 lock | 查更新比较单测 |
| AC14 | R15 | Given 本地改过 `SKILL.md`，When 点 `有更新`，Then 先确认并列出改过的文件；取消则文件不变 | 测试 HOME | tree SHA 计算单测（与 `git hash-object` / `git write-tree` 结果一致） |
| AC15 | R16 | Given GitHub 限流（打桩返回 403 + 限流头），Then 触发处说 `GitHub 暂时限流，稍后再试`，没有弹窗、没有重试 | 打桩 | 单测 |
| AC16 | 非功能 | Given 一个含 `../x` 与软链接的恶意压缩包，Then 拒绝解包，落点不留任何文件 | 测试 HOME | 解包安全单测 |

## 待核实（实现前）

- 本地按 git 规则算 tree SHA：文件权限位（`100644` / `100755`）、软链接（`120000`）、空目录（git 不记）要与 GitHub 一致；用 `git` 对同一目录算一次做对照测试。
- skills.sh 搜索的限流与返回头（未公开）；按「失败即降级」处理，不写死阈值。
- MCP Registry 的限流（未公开）；同上。
- 大仓库（如 `anthropics/skills`）从 codeload 整包下载的大小，决定 50MB 上限是否合适。

## 风险

- skills.sh 的 `/api/search` 没有版本号、没有公开的稳定承诺；它变了，`发现 · skill` 只剩快照与「粘贴链接」可用。
- `.skill-lock.json` 的格式由 `npx skills` 决定，它升版本时会整体清空旧记录；Sophia 只读，最坏情况是暂时认不出那些 skill 能更新。
- 通用仓库是共用目录：`npx skills` 删掉或改了 Sophia 装的 skill，Sophia 下次扫描如实显示，不修复、不回滚。

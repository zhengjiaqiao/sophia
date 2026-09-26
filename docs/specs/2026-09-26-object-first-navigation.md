---
type: spec
description: 侧栏按对象平铺（SKILLS / MCP / 模型 / 设置），范围改成页面头的滑槽加项目筛选片，默认「全部」
created: 2026-09-26
---

# 按对象组织的导航 — Spec

依据：`docs/intent/2026-09-26-object-first-navigation.md`；线框：Sophia 信息架构评审页第三版（https://claude.ai/artifact/Nqc2ABPjyxjmeHDuRbNQ4P ，屏 1–4 与「前后对照」「迁移对照」）。本版**不做用量**：侧栏不出现「用量」，只保证以后能加进来。

## 需求

- **R1 侧栏平铺。** 侧栏自上而下只列 `SKILLS`、`MCP`、`模型`，`设置` 贴底；不分组，不列项目。全栏只有一项选中。第三方模型开着时，`模型` 后有 6px 橙点。平台不支持第三方模型时（非 macOS，或读不出模型状态）不列 `模型`。
- **R2 目的地表是唯一来源。** 侧栏项、快捷键、应用菜单「显示」里的项由同一张表生成，快捷键按 id 固定、不随顺序重排：SKILLS ⌘1、MCP ⌘2、模型 ⌘3；⌘4（用量）、⌘5（会话）预留给以后，本版不占用。不列出的项，它的快捷键什么都不做，其他项的快捷键也不变。
- **R3 范围滑槽。** SKILLS 与 MCP 页面头左端是滑槽 `全部 ｜ 用户级 ｜ 项目级`，默认 `全部`；两页共用同一个范围，切页范围不变。模型页、设置页没有滑槽。界面上原来叫「全局」的地方一律改叫「用户级」。
- **R4 项目筛选片。** 在 `全部` 与 `项目级` 下，滑槽下方出现一行 `项目` 筛选片（在 `用户级` 下不出现）：`全部` 加上按最近活跃排的前 6 个项目，超出的收进 `更多 ▾`。
  - `全部` 下点某个项目，看的是「用户级 + 这个项目」。
  - `项目级` 下点某个项目，只看这个项目；选 `全部`，看的是所有项目。
- **R5 「更多」列表。** 点 `更多 ▾` 弹出一个浮层：搜索框，项目列表（名字 + 短路径，悬停显示完整路径），列表头右端是排序（沿用现在侧栏的排序方式与记忆），没有添加和移除。应用菜单加一项「切换项目… ⌘P」，直接打开这个浮层、焦点落在搜索框；方向键移动、回车选中、Esc 收起并把焦点还给触发处。
- **R6 多位置的表格。** 范围里不止一个位置时，表格在「名称」后多一列 `位置`；同一个 skill 或 MCP 服务装在两个位置，就是两行，不合并。每一格、每一行的操作只作用于那一行自己的位置。计数、全选、批量操作都按当前能看到的行来。MCP 的列按「agent + 是不是 Local 文件」归并：`Claude Code` 主列在用户级行上是 User、在项目行上是 Project（`.mcp.json`）；`Claude Code · LOCAL` 列只有项目才有，用户级的行在这一列上留空。
- **R7 单一位置的表格不变。** 范围里只有一个位置时（`用户级`，或选中了某个项目的 `项目级`），表格与现在完全一样，没有 `位置` 列。
- **R8 来源管理跟着位置走。** 范围里只有一个位置时，`管理来源`、`+ 来源`、菜单「添加来源…」照旧作用于它。有多个位置时，点它们先弹一个选位置的浮层（列出范围里的位置），选好再进原来的流程。
- **R9 去掉按来源筛选。** 不再有 `来源` 筛选片那一行。筛选框（⌘F）同时匹配名字和来源名（skill 的来源标签；MCP 行的来源名）。
- **R10 项目只来自自动检测。** 去掉「添加项目」与「从列表移除」的全部入口（按钮、右键菜单、撤销提示）。以前手动加进来、又没被自动检测到的项目不再列出；本机记录它们的文件不改、不删。
- **R11 模型页。** 原「Codex」agent 页改为「模型」页：页面头写 `模型`，节头写 `Codex · 第三方模型`，节里的内容与行为不变。托盘里做不成、要带到主窗口说明时，落到模型页。
- **R12 落点记忆与升级。**
  - 首次打开落在 `SKILLS · 全部`。之后记住上次的目的地和上次的范围，两者分开记：从模型页回到 SKILLS，范围仍是上次的。
  - 升级时读旧记忆：旧「全局」→ `用户级`；旧「某项目」→ `项目级` 并选中该项目（项目已不在 → `全部`）；旧停在 Codex 页 → 模型页（模型页不存在 → SKILLS）；读不懂 → 默认落点，不报错。
  - 记着的项目后来不在了 → 范围回到同一档的 `全部`（`全部` 下的项目不在 → 纯 `全部`；`项目级` 下的项目不在 → `项目级 · 全部`）。
- **R13 规范文档同步。** `docs/DESIGN.md` 里讲外壳、位置页、agent 页、快捷键与应用菜单、扩展预留的各节改成与本 spec 一致，并在 `docs/DESIGN-decisions.md` 顶部记一条决策。

非功能需求：
- 不增加任何网络请求与后台进程；扫描次数不因「全部」增加（沿用现在一次扫描返回全部位置的数据）。
- 在产品负责人本机的真实数据上（数十个项目），从任一范围切到 `全部`，表格在 300ms 内完成重绘（以开发者工具的 Performance 记录为准）。
- 键盘可达：滑槽、筛选片、「更多」浮层、选位置浮层都能只用键盘操作，焦点规则沿用 `src/inputModality.ts`。

## 设计

### 1. 目的地与范围（替换现在的 `Place`）

- 新的落点状态拆成两块、分开记：
  - `destination`：`skills | mcp | models | settings`（以后加 `usage`、`sessions`）。
  - `scope`：`{ level: "all" | "user" | "project", project: string | null }`。`project` 是现在的域 key（`project:<路径>`）；`level` 为 `user` 时恒为 `null`。
- 由 `scope` 算出「这一屏涉及的位置」：
  - `all`：用户级 + 全部项目；`all` 且选了 X：用户级 + X。
  - `user`：只有用户级。
  - `project`：全部项目；`project` 且选了 X：只有 X。
- 存到新的本机键（`sophia.shell.nav`）。旧键 `sophia.shell.place` 只在新键不存在时读一次、按 R12 迁移，之后不再读、也不删。`parse*` 逐项取认得的字段，不认得就落默认。
- 离开守卫（`leaveGuard.ts`）的「换页」判断从比较 `locationKey` 改为比较「目的地 + 位置集合」。

### 2. 目的地表（替换 `locationDomains.json` + agent 注册表里「决定侧栏」的那部分）

- 新表 `src/shell/destinations.json`：`{ id, label, shortcut, scoped }`，`scoped` 表示这一页有没有范围滑槽。本版三项：`skills`（⌘1，scoped）、`mcp`（⌘2，scoped）、`models`（⌘3）。`设置` 不进表，仍贴底、仍是 ⌘,。
- 侧栏、应用菜单「显示」、菜单命令（`dest-<id>`）都由这张表生成。`src-tauri/src/menu.rs` 继续用 `include_str!` 读同一个文件，快捷键取表里写死的值，不再按下标生成。
- 可用性：`models` 只在「后端支持第三方模型」时列出，判断沿用现在 agent 注册表的 `available`。橙点沿用 `indicator`。agent 注册表继续负责模型页里的节与托盘里的行，只是不再生成侧栏的 `AGENT` 段。
- 菜单新增 `switch-project`（「切换项目…」⌘P），只在当前目的地 `scoped` 时可用，发给页面去打开「更多」浮层。

### 3. 页面头与筛选片（SKILLS / MCP）

- 左端滑槽用组件库的 `Tabs`（占原来 `SKILLS ｜ MCP` 页签的位置），右端的筛选框、`管理来源`、`+ 来源` 不动。
- 项目筛选片用 `ChipRow` + `Chip`，放在原来 `来源` 筛选片那一行。`更多 ▾` 用 `Chip`，浮层用 `FloatingLayer` + `Menu`（`MenuItem kind="radio"`），搜索用 `TextField search`。选中的项目不在前 6 个里时，用它替换第 6 个位置显示，保证选中项始终看得见。
- 最近活跃沿用现在的 `api.projectTimes`，排序方式与记忆沿用 `sidebarProjects.ts` 的 `sortProjects` 与 `sophia.sidebar.sort`。
- 滑槽与筛选片是页面层组件（放在 `LocationFrame` 一侧），不进 `src/ui`：它们带业务状态。

### 4. 多位置表格（R6 R7 R8，本次改动最重的一块）

现状：两页都先取出一个位置的数据（SkillsTab `overview.domains.filter(d => d.key === selectedKey)`；McpTab `domains.find(...)`），整张表和它的全部状态都假定只有一个位置。

- **行**：行结构加上 `domainKey`。行 key 改为带位置前缀：skills 用 `domainKey|sourceId|skill`，MCP 用 `domainKey|name`。所有按行 key 存的状态（选中、隐藏、闪一下、格内提示、行提示、孤行幽灵、展开、焦点、`data-row` 查询）跟着换 key。
- **列**：列按 agent 归并（同一个 agent 在不同位置的目标，归到同一列）；每一格按「这一行的位置 + 这一列的 agent」找到具体目标，找不到就是空格。MCP 按「agent + 是不是 Local 文件」归并：`Claude Code` 主列在用户级行上对应 User MCPs、在项目行上对应 `.mcp.json`（Project）；`Claude Code · LOCAL` 列只有项目才有，用户级行留空（格子不可点）。列头第二行（`LOCAL` / `PROJECT`）只在同一个 agent 有两列、且这一列的位置同属一种作用域时写；混着 User 与 Project 的主列不写。
  - 实现记录（2026-09-26）：位置 id 与目标 id 本身带位置（用户级 `<harness>`，项目 `project:<路径>::<harness>`，Local 是 `::claude-code:local`），列 id 取末段即完成归并；写入 api 按每一格自己的目标 id 写，一批格可以跨位置，不需要前端按位置拆开调用。列数上限沿用设置里的「列表里的 agent · 最多 N 个」，MCP 的 Local / Project 拆列按现在的规则另算。
- **位置列**：只在位置集合大于 1 时出现，宽 72，来源列让到 80，面板宽仍 776（MCP 5 个 agent 列时名称列留 150）；显示「用户级」或项目名（同名项目靠短路径区分，规则同「更多」列表）。
- **操作**：格子点击、行动作、批量、撤销都带上这一行的 `domainKey`，按位置分组后分别调用现有的 api（现在的 api 都按单个位置接收参数，不需要改后端）。撤销记录按位置分组，一次撤销还原这一批里的全部位置。
- **来源管理**：`管理来源` / `+ 来源` / 菜单「添加来源…」在位置集合大于 1 时先弹选位置的 `Menu`，选完进入现在的 `SourcesPage` / `AddSourcePage`（它们仍只接收一个位置）。
- **空态与新手提示**：按位置集合判断。例如「这里还没有 skill」只在集合里所有位置都空时出现；原来判断 `selectedKey === "global"` 的地方改成判断集合是否只含用户级。
- **范围变化时的清理**：现在按 `selectedKey` 变化清空选中、筛选、撤销、浮层；改为按「位置集合」变化清空。

实现顺序（同一个版本里交付）：先做 §1–§3、§5–§7（导航，表格仍只显示单一位置，`全部` 暂时按用户级处理，不发布），再做 §4 把 `全部` 与 `项目级 · 全部` 接通。

### 5. 筛选框匹配来源（R9）

- skills：匹配 `row.skill` 或来源标签；MCP：匹配 `row.name` 或来源名。去掉 `SourceChips` 与两页的 `originFilter` 状态；`src/originFilter.ts` 不再使用则删除。

### 6. 项目只来自自动检测（R10）

- 前端：去掉 `+ 项目`、`×`、右键「从侧栏移除」、撤销提示，以及对 `listManualProjects` / `addProject` / `removeProject` / `pickDirectory`（仅用于添加项目的那一处）的调用。
- 后端：`discovery.rs` 的 `project_candidates` 不再并入手动列表；`add_project` / `remove_project` 命令删除。`store.rs` 读写 `projects.json` 的函数保留（文件不动，老版本回退时仍可用），只是本版不再调用。

### 7. 模型页与托盘（R11）

- 路由：`destination === "models"` 渲染现在的 `AgentPage`（Codex），页面头标题改为 `模型`，节标题改为 `Codex · 第三方模型`。
- 托盘 `tray-navigate("models")` 映射到 `destination: models`（现在映射到 `goAgent("codex")`）。

### 涉及模块

`src/shell/place.ts`（重写为 nav 状态）、`src/shell/domains.ts` + `locationDomains.json`（换成 `destinations.*`）、`src/shell/Sidebar.tsx`、`src/shell/agentRegistry.ts` / `agents.tsx`、`src/shell/menuCommands.ts`、`src/shell/leaveGuard.ts`、`src/App.tsx`、`src/LocationFrame.tsx`、`src/SkillsTab.tsx`、`src/McpTab.tsx`、`src/DomainView.tsx`、`src/Matrix.tsx`、`src/mcpView.ts`、`src/sidebarProjects.ts`、`src/originFilter.ts`、`src/TrayPanel.tsx`、`src-tauri/src/menu.rs`、`src-tauri/src/lib.rs`、`crates/core/src/discovery.rs`、`docs/DESIGN.md`、`docs/DESIGN-decisions.md`，以及对应的 `tests/*.test.ts` 与 Rust 测试。

## 验收标准

真实验证统一在 `make dev` 的开发窗口（macOS）里做。凡是会写文件的操作，都在临时 HOME 搭的测试数据上点（`HOME=<临时目录> make dev`），不在产品负责人的真实数据上点写入；只读的浏览、切换、筛选可以在真实数据上做。

| 编号 | 需求 | Given / When / Then | 真实验证 | 代理验证 |
|---|---|---|---|---|
| AC1 | R1 | Given macOS、第三方模型关着，When 打开应用，Then 侧栏自上而下只有 `SKILLS` `MCP` `模型`，`设置` 贴底，没有任何项目名与组小标，全栏只有一项选中 | dev 窗口截图 | 侧栏渲染单测 |
| AC2 | R1 | Given 第三方模型开着，Then `模型` 后有橙点；关掉后橙点消失 | dev 窗口里在测试 HOME 上拨开关 | agent 注册表单测 |
| AC3 | R1 R2 | Given 后端报告不支持第三方模型，Then 侧栏与菜单「显示」都没有 `模型`；按 ⌘3 什么都不发生；⌘1 ⌘2 仍分别到 SKILLS、MCP | 用构造的不支持状态启动（开发开关）看侧栏与菜单 | `shell-menu` / 目的地表单测 |
| AC4 | R2 | When 打开应用菜单「显示」，Then 依次是 `SKILLS ⌘1`、`MCP ⌘2`、`模型 ⌘3`、分隔、`切换项目… ⌘P`、`返回`，与侧栏一一对应 | dev 窗口看原生菜单 | `menu.rs` 测试 + 菜单命令一致性单测 |
| AC5 | R3 | Given 在 SKILLS · 项目级 · CardBox，When 按 ⌘2，Then 到 MCP，滑槽仍是 `项目级`，筛选片仍选中 CardBox | dev 窗口真实数据 | nav 状态单测 |
| AC6 | R3 | When 进入模型页或设置，Then 页面头没有滑槽；界面上不再出现「全局」二字 | dev 窗口；`grep` 界面文案 | 可见文案扫描（`lint-ui`） |
| AC7 | R4 | Given 共 6 个项目，When 在 `全部` 下，Then 筛选片是 `全部` + 6 个项目，没有 `更多`；Given 7 个项目，Then 前 6 个 + `更多 ▾`，浮层里有第 7 个 | 测试 HOME 分别造 6、7 个项目 | 筛选片计算单测（边界 6/7） |
| AC8 | R4 | Given 从 `更多` 里选了第 9 个项目，Then 筛选片上它替换第 6 个位置并显示为选中 | dev 窗口 | 单测 |
| AC9 | R4 R6 | Given `全部` 下点 CardBox，Then 表格只剩用户级与 CardBox 两个位置的行；Given `项目级` 下点 CardBox，Then 只剩 CardBox 的行且没有 `位置` 列 | dev 窗口真实数据 | 位置集合计算单测 |
| AC10 | R4 | Given 在 `用户级`，Then 没有项目筛选片那一行 | dev 窗口 | 单测 |
| AC11 | R5 | When 按 ⌘P，Then 「更多」浮层打开、焦点在搜索框；输入 `weibo` 只剩名字含 weibo 的项目；↓ 回车选中后浮层收起、表格切换；Esc 收起且焦点回到触发处 | dev 窗口纯键盘走一遍 | 浮层键盘行为单测 |
| AC12 | R5 | 悬停「更多」里的一行，Then 提示框显示完整路径；列表里没有添加与移除 | dev 窗口 | 渲染单测 |
| AC13 | R6 | Given defuddle 同时装在用户级与 CardBox，When 在 `全部`，Then 表里有两行 defuddle，`位置` 列分别是「用户级」「CardBox」 | 测试 HOME 造数据 | 行构造单测（行 key 不重复） |
| AC14 | R6 | Given `全部` 下，When 点 CardBox 那一行 Codex 格加上 defuddle，Then 只在 CardBox 的 Codex 目录下建链接，用户级那一行不变；撤销后恢复 | 测试 HOME，操作后在终端 `ls -la` 两处目录 | 按位置分组调用 api 的单测 |
| AC15 | R6 | Given `全部` 下勾选了分属两个位置的 3 行，When 批量加到 Codex，Then 两个位置各自按行建链接，计数与撤销覆盖全部 3 行 | 测试 HOME | 单测 |
| AC16 | R6 | Given MCP · `全部`，Then 用户级的行在 `CLAUDE CODE LOCAL` 列上是空格且不可点；`CLAUDE CODE` 主列在用户级行上是 User、在 CardBox 行上是 Project | 测试 HOME | MCP 列归并单测 |
| AC17 | R7 | Given `用户级`，Then 表格与改版前的「全局」页逐项相同（列、计数、空态、新手提示），没有 `位置` 列 | dev 窗口与改版前截图对照 | 现有 DomainView / Matrix 单测全部通过 |
| AC18 | R8 | Given `全部`，When 点 `+ 来源`，Then 先弹出位置列表（用户级与各项目），选 CardBox 后进入 CardBox 的添加来源页；Given `项目级 · CardBox`，Then 直接进入 | dev 窗口（进入页面即止，不在真实数据上提交） | 单测 |
| AC19 | R9 | Then 页面上没有 `来源` 筛选片；When 在筛选框输入「通用仓库」，Then 只剩来源是通用仓库的行 | dev 窗口真实数据 | 筛选匹配单测（名字 / 来源两种命中） |
| AC20 | R10 | Then 应用里找不到添加项目、从列表移除的入口；Given 本机 `projects.json` 里有一个未被自动检测到的手动项目，Then 它不出现在筛选片与「更多」里，`projects.json` 内容在使用前后逐字节相同 | 测试 HOME 放一个手动项目，前后 `shasum` | `discovery.rs` 测试改为不并入手动列表 |
| AC21 | R11 | When 点侧栏 `模型`，Then 页面头是 `模型`，节头是 `Codex · 第三方模型`，开关、网关、重启生效的行为与改版前一致 | dev 窗口（测试 HOME） | 现有模型页单测全部通过 |
| AC22 | R11 | Given 托盘里启用失败，Then 主窗口到前面并停在模型页显示原因 | dev 窗口（占用端口制造失败，同托盘 spec 的做法） | `tray-navigate` 映射单测 |
| AC23 | R12 | Given 全新安装（无记忆），Then 落在 `SKILLS · 全部` | 测试 HOME | 单测 |
| AC24 | R12 | Given 旧记忆分别为「全局 · mcp」「项目 CardBox · skills」「Codex 页」「一段读不懂的字符串」，When 升级后首次打开，Then 依次落在 `MCP · 用户级`、`SKILLS · 项目级 · CardBox`、模型页、`SKILLS · 全部`，都不报错 | 测试 HOME 预置旧 localStorage 后启动 | 迁移单测（四种输入各一条） |
| AC25 | R12 | Given 记着 `项目级 · CardBox`，When CardBox 不再被检测到后重启，Then 落在 `项目级 · 全部`；Given 记着 `全部 · CardBox`，Then 落在 `全部` | 测试 HOME 删掉 CardBox 的 agent 目录 | 单测 |
| AC26 | 非功能 | Given 产品负责人本机真实数据，When 从 `用户级` 切到 `全部`，Then 表格 300ms 内重绘完成 | dev 窗口开 Performance 记录 | — |
| AC27 | R13 | DESIGN.md 外壳、位置页、agent 页、快捷键与应用菜单各节的描述与本 spec 一致；DESIGN-decisions.md 顶部有本次决策 | 人工对照 | `make test` 里的文档一致性检查（若有） |

提交前：`make test` 全绿（core、gateway、web）、`make lint` 零警告、`make build-web` 通过。

## 风险

- **多位置表格是最大风险。** 行 key、选中、撤销、提示、焦点这些状态到处假定只有一个位置（`DomainView.tsx` 的 `skillRowKey` 注释写明「一页只显示一个域」）。漏改一处，就可能出现「点这一行、改到另一个位置」这种错误写入。对策：行 key 统一带位置前缀；所有写入都按行的 `domainKey` 分组后再调 api；AC14、AC15 在测试 HOME 上用 `ls -la` 核对磁盘结果。
- **列归并。** 现在的列是「目标」，每个位置各有一套；归并成「agent」后，同一个 agent 在不同位置的目标要对得上。MCP 的 Local / Project 拆列规则是按页判断的，归并后要重新定义。实现前先把列归并写成纯函数并单测。
- **表格宽度。** 面板宽按「最多 4 个 agent 列」固定；MCP 在 `全部` 下可能同时出现 Local / Project 拆列与 `位置` 列，超出 776。实现时若放不下，按现有规则压缩「名称」「来源」列并用省略号，不加宽面板。
- **去掉手动项目会让个别老用户少一个项目。** 只影响手动加过、又不满足自动检测条件的项目（没有 agent 的项目目录）。按已定的做法不迁移、不提示。
- **`⌘P` 与系统习惯。** macOS 上 ⌘P 通常是打印；Sophia 没有打印功能，不冲突，但要在菜单里写明「切换项目…」。

## 待决问题

- 还没做的「会话」要不要先在侧栏占一个灰着的位置？（产品负责人）—— 默认假设：不占，本版也不列「用量」。
- 非 macOS 上「模型」一项怎么办？（产品负责人）—— 默认假设：不列，⌘3 什么都不做，其他快捷键不变（AC3）。
- 旧版停在 Codex 页的用户升级后落到哪？—— 默认假设：模型页（AC24）。
- 「全部」下同一个 skill 装在两个位置怎么显示？（产品负责人）—— 默认假设：两行，不合并（AC13）。
- 「全部」下点「管理来源」「+ 来源」怎么办？（产品负责人）—— 默认假设：先选位置（AC18）。
- MCP「全部」下用户级行在项目专属列上怎么办？（产品负责人）—— 默认假设：留空（AC16）。
- 以前手动加、又没被自动检测到的项目？（产品负责人）—— 默认假设：不再列出，文件不动（AC20）。
- 「全部」下的新手提示与空态的具体文案。（产品负责人）—— 默认假设：沿用现有文案，只改判断条件；需要新句子时实现阶段再给候选。

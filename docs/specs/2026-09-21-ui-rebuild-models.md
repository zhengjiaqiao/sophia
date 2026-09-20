---
type: spec
description: 界面重构第三份——模型页
created: 2026-09-21
intent: docs/intent/2026-09-21-ui-rebuild.md
---

# 界面重构 · 模型页

**输入**：`docs/intent/2026-09-21-ui-rebuild.md`、`docs/specs/2026-09-21-ui-rebuild-models-notes.md`
**组件规范**：`docs/specs/2026-09-21-ui-components.md`（**实现以它为准**）
**设计稿**：画布「SymSync 界面重构」的 `Models.dc.html`
**前置**：第一份已完成，组件库与二级页面就位。这一份是三份里最小的——**几乎全是现有能力换皮**。

---

## 需求

### R1 一行一个 agent，当前选的模型就在行里

左：16px 图标 + 名字（**不大写**，agent 名是被谈论的对象）+ 一句人话副行 + 一行等宽事实。
中：已选模型用**反色片**列出，每片带 `×`。
右：三个动作——`配置`（跳二级页面）、开关、`重启路由`。

按「可以有多个 agent」设计，尽管现在只有 Codex。

### R2 三组状态词合成一句人话，不并排三个徽标

`enabled`（我们的写入在不在 Codex 配置里）、`router.installed` / `router.running`（launchd 后台路由）、`codex.version` 是**正交的三件事**，互不蕴含。

- 副行（Barlow 13）：`3 个模型已经在 Codex 的模型列表里，改动要重启 Codex 才生效`
- 事实行（等宽）：`Codex 0.43.0 · 路由 127.0.0.1:8765 运行中`

版本号与端口是计数类事实，走等宽（§1.2）。

### R3 模型选择器：搜索 + 勾选

点模型区域弹浮层。顶部搜索框（圆角 4px），placeholder 用现有的 `筛选模型（可能有 100+ 个）`；下面列表，已选的在前（沿用 `sortAndFilterModels`）；底部 `已选 N 个模型` + `关闭` + `保存选择`。

**已选的标记用 12px 方形复选框，不用圆点。** §2 的圆点有确定含义（填充＝能不能用、外环＝本体还是软链），在模型列表里两个维度都不成立，用圆点会让人以为能点出三态。由此界面得到一个干净的二分：**圆＝状态（只读事实），方＝选择（我选的）**。

两个空态都要有：`还没有可选模型，请先在上方保存网关并拉取模型列表。`（改写成说结果的句子）与 `没有匹配的模型。` + `清除筛选`。

### R4 开关用 ghost pill 两态

未启用＝默认 ghost pill `启用`；已启用＝**反色 pill** `已启用`（点一下停用＝`gateway_restore`）。

不用滑动开关（iOS 语言且必然带圆角，规范里没有这个形），不用复选框（那是多选记号，与 R3 的方框撞义）。它是会写盘的动作按钮，不是「从一组里挑几个」，所以不借 §3.0 选择片。

### R5 `配置` 是二级页面

`SubPage`（`←` + `Codex 网关`）。装：网关地址、API 密钥（placeholder 原样 `已保存，留空则不修改`）、`保存` + `拉取模型`、只读的 `本机路由 127.0.0.1:8765 · 协议 chat`、以及 `canRestore` 的边界态（未启用但服务还装着 → `后台服务还装着` + `彻底撤下`）。

返回即保存，没有第二道确认。

### R6 `重启路由`——按钮只做我们能做的事

**这是模型页唯一需要新增的后端出口。**

`crates/gateway/src/service.rs:289` 已经有 `restart(label)`（`launchctl kickstart -k`），只是没有 Tauri 命令暴露它。新增 `gateway_restart`。

**按钮叫 `重启路由`，不叫 `重启 Codex`。** Codex 是用户的编辑器 / CLI，我们没有权限重启它；把「改动要重启 Codex 才生效」这句说明和一个叫 `重启` 的按钮并排放，会让用户以为按了就替他重启了。说明归说明（副行文字），动作归动作（重启我们自己装的 launchd 服务）。

### R7 两条常驻待办用行内条

`drift`（版本升了要重新生成目录）与 `takeover`（可以接过来）既不是某次操作的结果、也不是应用级故障，而是**挂在某一行上的常驻待办**——用 `RowNotice`（§4.4），动作就在右边。

`needsCodexRestart` **并进副行**，右边的 `重启路由` 就是它的动作，不单起一条。

`routerUnavailable`（已启用但路由没跑）走**错误横幅**（§4.2）——官方模型也会受影响，是应用级故障。

### R8 限制说明常驻，不随操作消失

`使用第三方模型时，Codex 仍会用官方模型生成会话标题…` 这段是**事实**，不是某次操作的结果。常驻在页面上。

### R9 视觉与文案规范落地

零色彩、token 化、术语 agent。`ModelsTab.tsx` 从 lint 豁免名单里划掉。

---

## 设计

模型页**没有域的概念**，所以不渲染侧栏，顶栏之下直接通栏。

`protocol`（chat/responses）与 `port` 现在 UI 完全没暴露（`codex_models/settings.rs`）。**放进配置页作只读事实，不做成可改**——它们是正确性配置不是口味选项，改错了整条链路就不通，而用户没有判断依据。

---

## 验收标准

| # | 需求 | Given / When / Then | 真实验证 | 代理验证 |
|---|---|---|---|---|
| AC1 | R1 | Given Codex 已启用且选了 3 个模型，When 打开模型页，Then 行里有 3 个反色片、各带 `×`，右侧三个动作齐全 | `make dev` 目视 | 快照测试 |
| AC2 | R2 | Given 任意状态组合，When 看那一行，Then **没有三个并排的徽标**，只有一句人话副行 + 一行等宽事实 | 真机翻几种状态 | 快照测试 |
| AC3 | R3 | Given 模型列表有 100+ 条，When 在搜索框输入，Then 实时过滤；已选的排在前面 | 真机输入 | `sortAndFilterModels` 已有测试 |
| AC4 | R3 | Given 搜索无结果，When 看列表，Then `没有匹配的模型。` + `清除筛选` | 真机输入一个不存在的名字 | 快照测试 |
| AC5 | R4 | Given 未启用，When 看开关，Then 是默认 ghost pill `启用`；启用后变**反色** `已启用`，再点一下恢复 | 真机点两次，确认 `~/.codex/config.toml` 前后一致 | `gateway_enable`/`restore` 已有测试 |
| AC6 | R5 | Given 点 `配置`，When 页面渲染，Then 二级页面、左上 `←`、密钥框 placeholder 是 `已保存，留空则不修改`、端口与协议**只读** | 真机目视 | 快照测试 |
| AC7 | R6 | Given 路由正在运行，When 点 `重启路由`，Then launchd 服务确实重启（`launchctl print` 的 PID 变了），提示条说重启完成 | **真机必做**：点前点后各 `launchctl print gui/$UID/<label>` 比对 PID | `service::restart` 已有测试（假 run） |
| AC8 | R6 | Given 界面任意位置，When 搜索可见文案，Then **没有任何按钮叫「重启 Codex」**——我们无权重启用户的编辑器 | 真机逐页翻 | 静态检查 |
| AC9 | R7 | Given `drift` 为真，When 看那一行，Then 下面挂一条行内待办条 + `重新生成` / `稍后`，**不是提示条也不是横幅** | 真机造一次版本漂移 | 快照测试 |
| AC10 | R7 | Given 已启用但路由没跑，When 打开页面，Then 顶栏之下出现**反色错误横幅**，不自动消失 | 真机 `launchctl bootout` 之后打开 | 快照测试 |
| AC11 | R9 | Given `ModelsTab` 相关源码，When 跑 `make lint`，Then 零违规且它已从豁免名单划掉 | — | `make lint` |

---

## 外部契约

| 名称 | 来源 | 用到什么 | 确认状态 |
|---|---|---|---|
| `service::restart` | 本仓库 `crates/gateway/src/service.rs:289` | `launchctl kickstart -k gui/<uid>/<label>` | **已验证**——代码已在，有测试（注入假 `run`）。但 `gateway_restart` 这个 Tauri 出口是新增的，AC7 必须真机验 |
| `sortAndFilterModels` | 本仓库 `src/modelsView.ts` | 筛选与已选置顶 | **已验证**——有测试 |

## 风险

1. **`重启路由` 的真实行为只能真机验。** `service::restart` 的测试注入的是假 `run`，从不调用真的 `launchctl`——这是对的（单测不该动系统服务），但也意味着「`kickstart -k` 在这台机器上真的能重启」这件事没有任何自动化覆盖。AC7 必须点前点后比对 PID。
2. **模型页无法在没有 Codex 的机器上验。** 本机装了 Codex，但 CI 上这一页的真实行为完全没有覆盖。

## 待决问题

- **`protocol` / `port` 要不要做成可改**。默认假设：只读。
- **`重启路由` 失败时说什么**。默认假设：原样转述 `launchctl` 的错误，不编——那是运维信息，用户要拿它去查。

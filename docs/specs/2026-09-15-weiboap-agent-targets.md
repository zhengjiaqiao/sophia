---
type: spec
description: WeiboAP 的写入目标从服务端缓存目录改为各助手目录（全局域扇出、助手域单写），并用助手名替代目录 ID
created: 2026-09-15
---

# WeiboAP 同步落到助手目录，并显示助手名 — Spec

依据：`docs/intent/2026-09-15-weiboap-agent-targets.md`

## 需求

- **R1** harness 表可把某个 `global_dir` 标记为「托管目录」：它仍作为本体位置被发现，但不再生成可写列。WeiboAP 的 `claude-code-plugins-custom/skills/custom` 用此标记。
- **R2** 一个目标列可以对应多个目录。全局域的 WeiboAP 列对应当前展开的全部助手目录；点同步时链接落到每一个。
- **R3** 多目录列上，一个 skill 只在部分目录有链接时，该格显示为部分（`2/4`），点补齐补上其余；全部有则显示已链接。
- **R4** 在某个助手自己的域页面同步，只写该助手目录，不扇出。
- **R5** 新增助手目录时，**在原有助手上已全量覆盖**的 skill 自动补齐到新助手；只在部分助手上存在的不自动补。
- **R6** 助手在界面上显示 WeiboAP 中的名字（域名、本体位置名）。名字读不到时降级为目录 ID，不报错、不影响同步。
- **R7** 已建在托管目录里的两条无效软链被清除。

非功能需求：读取 WeiboAP 数据库必须只读且不阻塞其正常运行；任何读取失败只降级，不影响扫描与同步。

## 设计

### 1. 托管目录（R1）

`harnesses.json` 的条目加 `"managed_global_dir": true`（默认 false）。`discovery::sources` 不变（该目录照常成为 `HarnessGlobal` 本体位置，只认真实目录）；`discovery::targets` 跳过带此标记的 `global_dir`。

### 2. 目标携带多个目录（R2、R4）

`Target.path: PathBuf` 改为 `Target.dirs: Vec<PathBuf>`，并提供 `Target::main_dir() -> &Path`（取第一个，用于列的代表路径、`link_style` 判断、`split_whole_link`）。绝大多数列 `dirs.len() == 1`，行为与现在一致。

`targets()` 的生成规则调整：

| 列 | 归属域 | dirs |
|---|---|---|
| harness 全局目录（未标记托管） | 全局 | 该目录，1 个 |
| harness 的 agent 目录 | 该助手自己的域 | 该助手目录，1 个 |
| **harness 的 agent 目录（新增）** | **全局** | **全部展开的助手目录，N 个** |
| 项目目录 | 该项目 | 该目录，1 个 |

新增的那一列 id 取 `<harness_id>`（与全局其他列同规则，WeiboAP 原本没有全局列，不冲突），label 取 harness 名。助手域的列 id 仍是 `project:<agent 目录>::<harness_id>`，两者不同，互不影响。N = 0 时不生成该列。

`linked_whole_to` 只在 `dirs.len() == 1` 时判定，多目录列恒为 `None`（助手目录由 WeiboAP 创建，不会是整目录软链）。`DomainPage.broken` 遍历列的全部 dirs。

### 3. 格状态聚合（R3）

`CellState` 加一个变体 `Partial`。`Cell` 加两个计数字段：

```rust
pub struct Cell {
    source_id: String, skill: String, target_id: String,
    /// 代表路径：main_dir 下该 skill 的路径
    path: PathBuf,
    state: CellState,
    /// 已到位的目录数 / 总目录数；单目录列为 1/1 或 0/1
    linked: usize,
    total: usize,
}
```

`cell_state` 对每个 dir 单独求值得到 slot 状态，再聚合：

- 全部 slot 相同 → 该状态。
- slot 中同时有 `Own` 和 `Linked` → 视为都已到位，聚合为 `Linked`（`Own` 计入 `linked`）。
- 已到位（`Own`/`Linked`）数在 1..total 之间，其余为 `Missing` → `Partial`。
- 含任一 `Broken` → `Broken`；含任一 `Foreign`/`Duplicate` 且无 Broken → 取其中优先级最高者（沿用现有排序 `Broken > Foreign > Duplicate`），保证异常不被"部分成功"掩盖。

`propose_links` / `propose_unlinks` 改为遍历目标的全部 dirs：对每个 dir 各自算 slot 状态，`Missing` 的 dir 生成一条 Create，`Linked` 的 dir 生成一条 Unlink。仍按 `target_path` 去重。`Own` 的 dir 永不生成动作。

### 4. 新助手自动补齐（R5）

在 `scan` 已有的自动同步阶段（`scan_all` 扫描后执行 `auto_link_cells` → `propose_links` 的那一轮）增加一类内置来源：**多目录列上状态为 `Partial` 且 `linked == total - 新增目录数` 的格**——即"在此次扫描新出现的目录之外，其余目录全都有"的格。

实现上不需要记住"哪些是新目录"：等价判据是**该 skill 在所有非新目录上都已到位**。为避免持久化目录快照，采用简化判据：

> 多目录列上，若某 skill 的缺失目录**全部是空目录或新建目录**（目录内条目数为 0），则自动补齐。

新建助手的 skills 目录初始为空，符合此判据；用户单独同步过的助手目录非空，不会被误补。该判据无需任何持久状态。

自动补齐产生的动作与手动补齐走同一执行路径，结果照常进浮层。

### 5. 助手名（R6）

`harnesses.json` 条目加可选字段：

```json
"agent_labels": {
  "path": "~/Library/Application Support/WeiboAP/agents.db",
  "table": "agents",
  "id_column": "id",
  "name_column": "name"
}
```

`discovery` 新增一个只读查询：以 `file:<path>?mode=ro&immutable=1` 打开（不加锁、不写 WAL，与运行中的 WeiboAP 互不干扰），执行 `SELECT <id_column>, <name_column> FROM <table>`，得到 ID→名字映射。三个标识符在拼 SQL 前用 `[A-Za-z_][A-Za-z0-9_]*` 校验，不通过则放弃查询。

`agent_projects` 用助手目录名（= 数据库主键）查表：命中则 `label = "<harness 名> · <助手名>"`，未命中或任何一步失败（文件不存在、打不开、表结构不符）则沿用现在的 `"<harness 名> · <目录名>"`。失败只 `eprintln!`，不向上传播。

依赖：core 加 `rusqlite`（`bundled` feature，自带 SQLite，避免各平台系统库差异）。core 仍不依赖 tauri。

### 6. 清理残留（R7）

一次性动作，不进产品代码：删除 `claude-code-plugins-custom/skills/custom/` 下的 `sdlc-intent`、`sdlc-spec` 两条软链（只删链接，不动 `~/.agents/skills` 里的本体）。R1 生效后该目录不再可写，不会再产生同类残留。

### 7. 前端

- `types.ts`：`Target.dirs: string[]`（替换 `path`）；`CellState` 加 `"partial"`；`Cell` 加 `linked`、`total`。
- `DomainView`：格符号 `partial` 显示 `{linked}/{total}`（不是图标），沿用 missing 的橙色系；title 为「N 个助手中 M 个已链接，点补齐补上其余」。其他状态在多目录列上 title 追加「共 N 处」。
- 用到 `target.path` 的地方（坏链表的目标列匹配等）改用 `dirs`。
- 本体位置列与侧栏域名自动变成助手名（后端给出的 label 已变），前端无需改动。

## 验收标准

| 编号 | 需求 | Given / When / Then | 验证方式 |
|---|---|---|---|
| AC1 | R1 | Given harness 条目标了 `managed_global_dir` 且该目录存在且含真实 skill 目录，When 扫描，Then 该目录出现在本体位置列表中，且不出现在任何域的目标列中 | 单元（discovery） |
| AC2 | R1 | Given 未标记的 harness 全局目录，When 扫描，Then 行为与现在一致（既是本体位置也是列） | 单元（discovery） |
| AC3 | R2 | Given 展开到 4 个助手目录，When 扫描，Then 全局域出现一列 `WeiboAP`，其 `dirs` 恰为这 4 个目录；同时 4 个助手域各有一列，`dirs` 各为自己那一个 | 单元（discovery） |
| AC4 | R2 | Given 助手目录展开结果为空，When 扫描，Then 全局域不出现 WeiboAP 列 | 单元（discovery） |
| AC5 | R2 | Given 全局域 WeiboAP 列上某 skill 四个目录全缺失，When 对该格补齐，Then 生成 4 条 Create、4 个目录下各建一条软链 | 单元（skills）+ 人工 |
| AC6 | R3 | Given 4 个助手目录中 2 个已有该 skill 的链接、2 个缺失，When 扫描，Then 该格 state 为 `partial`、`linked=2`、`total=4`；When 补齐，Then 只对缺失的 2 个生成 Create | 单元（skills） |
| AC7 | R3 | Given 某 skill 在 1 个助手目录是本体（Own）、其余 3 个已链接，When 扫描，Then 该格为 `linked`、`linked=4`、`total=4`，补齐不生成任何动作 | 单元（skills） |
| AC8 | R3 | Given 4 个目录中 1 个是坏链、2 个已链接、1 个缺失，When 扫描，Then 该格为 `broken`（异常不被部分成功掩盖） | 单元（skills） |
| AC9 | R4 | Given 在某助手自己的域页面对一个 skill 补齐，When 执行，Then 只有该助手目录下新增软链，其余助手目录不变 | 单元（skills）+ 人工 |
| AC10 | R5 | Given 某 skill 在 3 个已有助手目录全部到位，且新出现第 4 个助手目录（其 skills 目录为空），When 扫描，Then 自动补齐到第 4 个 | 单元（skills） |
| AC11 | R5 | Given 某 skill 只在 1 个助手目录存在，其余 3 个目录非空且缺该 skill，When 扫描，Then 不自动补齐，该格保持 `partial` | 单元（skills） |
| AC12 | R6 | Given `agents.db` 可读且含目录名对应的行，When 扫描，Then 域名与本体位置名显示为「WeiboAP · 办公助手」 | 单元（discovery，用临时库）+ 人工 |
| AC13 | R6 | Given `agents.db` 不存在 / 表名不符 / 文件损坏，When 扫描，Then 名字降级为「WeiboAP · agent_1776847465710_d5z6cowep」，扫描其余部分正常完成、无错误弹窗 | 单元（discovery） |
| AC14 | R6 | Given WeiboAP 正在运行且持有该数据库，When 扫描，Then 读取成功且 WeiboAP 无异常（只读 immutable 打开不加锁） | 人工 |
| AC15 | R7 | Given 托管目录下有两条本工具建的残留软链，When 执行一次性清理，Then 两条链接消失、`~/.agents/skills` 下的本体目录仍在 | 人工（命令输出前后对比） |
| AC16 | 全部 | When 跑 `make test`，Then core 测试、clippy、前端构建全绿 | 集成 |

## 风险

- **最大风险在产品可行性，不在实现**：WeiboAP 是否会在下次装配时清掉我们放进助手目录的软链，尚未实测。若会清，R2–R5 全部失去意义。建议先实测再开工，或接受"实现完可能要回退"。
- `Target.path → dirs` 触及 `skills.rs` 约 14 处与 `lib.rs::style_for`，是本次最大的改动面。多数列 `dirs.len() == 1`，回归风险集中在聚合逻辑与 `split_whole_link`（它只对单目录列有意义，需显式守卫）。
- 引入 `rusqlite`（bundled）会增加编译时间与二进制体积（约 1–2 MB）。换来的是跨平台一致、不依赖系统 SQLite。若后续有第二个 harness 需要类似映射，这笔投入可摊薄。
- 读第三方应用的私有数据库属于紧耦合，WeiboAP 改表结构即失效；降级路径保证只退回目录名。
- 「空目录即新建助手」的判据（§4）在一种情况下会误判：用户手工清空了某个助手的 skills 目录，下次扫描会被当作新助手自动补齐。代价是多几条软链，可接受。

## 待决问题

- 往助手目录放软链，WeiboAP 下次装配会不会清掉？（作者实测）—— 默认假设：不会，依据是某助手目录中现存 12 个清单外 skill 未被清理。
- WeiboAP 的「项目」是否也落在 `Data/agents/` 下？（作者在 WeiboAP 里建一个项目后确认）—— 默认假设：与助手同构，`agents.db` 的同一张表即可覆盖，无需额外设计。
- 全局域的 WeiboAP 扇出列与 4 个助手域并存，信息有重复。是否要在侧栏折叠助手域？—— 默认假设：都保留，用户原话就是「全局扇出、单个助手单写」两个视角。

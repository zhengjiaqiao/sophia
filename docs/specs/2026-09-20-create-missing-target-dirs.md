---
type: spec
description: 目录还不存在的 harness 也能在引入弹层里选中，同步时自动创建目录
created: 2026-09-20
---

# 从零开辟一个 harness 目录 — Spec

依据：真机反馈（2026-09-20）。`/Users/jiaqiao/Project/weibo_mini_program` 下没有 `.agents/skills`，于是 Codex 在该项目域不成列；而要让目录存在就得先同步，要同步又得先有列——没有入口。用户只能自己 `mkdir`。

顺带查清的事实（本机 `codex-cli 0.154.0` 二进制）：项目级路径清单是 `.codex/config.toml`、`.codex/agents`、`.codex/hooks`、`.agents`、`.agents/skills`——**项目级只读 `.agents/skills`**；`.codex/skills` 只出现在全局语境（`$CODEX_HOME/skills`，已支持）。因此不为项目级 `.codex/skills` 做兼容，那条路径本就不生效。

## 需求

- **R1** 表格的列仍然只包含目录已存在的目标，避免每个项目铺满几十列。
- **R2** 引入弹层的 harness 一栏，列出该域下所有已启用且已安装的 harness，**包含目录尚不存在的**，后者标注「将新建目录」。
- **R3** 建链时目标目录不存在则先创建（含多级父目录），创建失败按失败上报。补齐、引入、自动同步共用这条路径。
- **R4** 目录被创建后，下一轮扫描该 harness 正常成列，其中的链接照常可管理。

非功能需求：只创建目录，不创建任何文件；创建失败不影响同批其他动作。

## 设计

### 1. 目标区分存在与否（R1、R2）

`discovery::targets` 里的 `push` 闭包不再用 `is_dir()` 丢弃不存在的目录，改为照常产出并记录 `Target.exists: bool`（`path.is_dir()`，跟随软链）。其余判定不变：`linked_whole_to` 只对已存在的目录求值；按 `real_path` 的去重只在 `exists` 时进行（不存在的目录没有 `real_path`）。

`skills::scan` 分流：

```rust
pub struct DomainPage {
    key, label,
    targets: Vec<Target>,     // exists == true，表格的列
    creatable: Vec<Target>,   // exists == false，只在引入弹层可选
    rows, broken,
}
```

行与格只针对 `targets` 计算，`creatable` 不参与扫描（目录都不存在，格状态必然全是 Missing，没有展示价值）。`DomainPage.broken` 只遍历 `targets`。

`propose_links` 仍按 `target_id` 查目标，查的是 `targets ∪ creatable`（命令层把两者一起交给 core），所以引入弹层里选中一个尚不存在的目录也能生成 Create。`propose_unlinks` 对 `exists == false` 的目标不产出任何动作。

### 2. 建链时创建目录（R3）

`sync::execute` 的 `Create` 分支：

```rust
ActionKind::Create => {
    // 目标目录不存在就地创建：从零开辟一个 harness 的 skill 目录是正常路径，
    // 不是错误。is_dir 跟随软链，整目录软链也算已存在
    if !action.target.is_dir() {
        if let Err(e) = std::fs::create_dir_all(&action.target) {
            return Outcome::Failed(format!("建不出目标目录：{e}"));
        }
    }
    ...
}
```

`Unlink` 与 `BrokenLink` 分支不创建任何目录。

### 3. 前端（R2）

- `types.ts`：`Target` 加 `exists: boolean`；`DomainPage` 加 `creatable: Target[]`。
- `ImportDialog` 右栏 harness 列表 = `page.targets` 后接 `page.creatable`；后者名字后加 `<span className="muted">将新建目录</span>`，title 为完整路径。默认勾选保持现状（只默认勾已存在的，避免一打开弹层就顺手建出一堆目录）。
- 其他位置不变：表格、坏链表、自动同步规则行都只认 `page.targets`。

## 验收标准

| 编号 | 需求 | Given / When / Then | 验证方式 |
|---|---|---|---|
| AC1 | R1 | Given 某项目没有 `.agents/skills`，When 扫描，Then 该项目域的 `targets` 不含 Codex，`creatable` 含 Codex | 单元（discovery + skills） |
| AC2 | R2 | Given 同上，When 打开引入弹层，Then harness 栏出现 Codex 并标注「将新建目录」，默认未勾选 | 人工 |
| AC3 | R3 | Given 目标目录不存在，When 执行一条 Create，Then 目录被创建、链接建立、结果为 Created | 单元（sync） |
| AC4 | R3 | Given 目标目录的父路径不可写，When 执行 Create，Then 结果为 Failed 且消息含原因，同批其他动作不受影响 | 单元（sync） |
| AC5 | R3 | Given 一条 Unlink 或 BrokenLink 的目标目录不存在，When 执行，Then 不创建任何目录 | 单元（sync） |
| AC6 | R4 | Given 引入后目录已建，When 下一轮扫描，Then 该 harness 出现在 `targets` 中，其中的链接状态正确 | 单元（discovery + skills） |
| AC7 | 全部 | When 跑 `make test`，Then core 测试、clippy、前端构建全绿 | 集成 |

## 风险

- `targets()` 不再过滤不存在的目录，返回集合变大；凡是遍历 targets 的地方（坏链扫描、格计算）都必须只用 `page.targets`，否则会对不存在的目录做无谓 IO。这是本次主要的回归面。
- 自动同步规则若指向一个后来被用户删掉的目录，现在会把目录重建出来。这符合"持续补齐"的语义，但与"用户删掉即表示不要了"的直觉相悖。缓解：用户可在引入弹层关掉该 harness 的自动同步，或把 skill 加入排除名单。
- 已有测试里断言「目标目录不存在 → Failed("目标目录不存在")」的那条需要改写为新行为。

## 待决问题

- 引入弹层里 `creatable` 的 harness 是否也该出现在「自动同步」的目标候选里？—— 默认假设：出现，与已存在的目标同等对待；首次自动补齐时一并建目录。

---

## 修订 v2（2026-09-20，真机反馈后纠正）

**R1 作废：目录不存在的目标也直接成列，不再藏进引入弹层。**

起因：真机上 `weibo_mini_program` 项目页仍看不到 Codex，用户指出「设置里勾了的 harness 就该在表格里看得见」。

R1 当初的理由是「避免每个项目铺满几十列」，这个理由建立在一个**错误估算**上：初次估算说已安装且未启用的 harness 有 30 个，但那是用「`detect_dir` 目录是否存在」做的粗近似。准确复现 `installed()`（含 `looks_installed` 的启发式）后，本机实际是 **installed = 10、未禁用 = 4**（Claude Code、Codex、Cline、WeiboAP）。那 30 个里绝大多数是 `npx skills add --agent '*'` 给未安装工具建出的空目录，判定本来就会滤掉。

列数既然是个位数，就没有任何理由把「这个项目还没给某个 harness 同步过」这个事实藏起来。

修改：

- `DomainPage.creatable` 删除；`scan` 把全部目标（无论 `exists`）都放进 `targets`，照常成列、参与行与格的计算。
- 目录不存在的列，其格自然全是 `Missing`（`entry_kind` 对不存在的路径返回 Missing），点补齐时由 §2 的 `create_dir_all` 建出目录。
- 坏链扫描、`linked_whole_to`、`real_path` 去重仍只对 `exists == true` 的目标做，避免对不存在的目录做无谓 IO。
- `Target.exists` 保留：它是上述守卫的依据，也是前端给列头加提示的依据。
- 引入弹层的 harness 栏回到 `page.targets`，不再拼接 creatable；「将新建目录」的标注改挂在**列头**（`exists == false` 时列名后加提示）。

保留不变：§2 建链时 `create_dir_all`（R3）、R4。AC1 与 AC2 按上述改写，AC3–AC7 不变。

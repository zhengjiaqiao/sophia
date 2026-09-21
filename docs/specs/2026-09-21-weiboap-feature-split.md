# 内部版 / 公开版双构建（`weiboap` feature）

> 2026-09-21。把微博内部专有的 WeiboAP 适配收进一个 Cargo feature，让同一份代码产出两个二进制：
> 公开版（默认构建）里不含任何内部标识，内部版显式开 feature。

## 1. 结论先行：这个 feature 只管二进制，管不了源码

**源码仓库已经公开**（`zhengjiaqiao/sophia`）。WeiboAP 的目录结构、`agents.db` 的表名列名、
`~/.weiboap/config/config.json` 的字段，此刻就在公开的 git 历史里。加 feature **不会**把它们收回去：

- 方案 A（本次实现）：**只切二进制**。公开版产物里查不到内部字符串，但公开仓库里还看得到源码。
  成本低，当天做完，不动历史，不影响协作。
  适用前提是「内部信息不适合随产品分发，但源码级别可以接受」。
- 方案 B：**源码层面隔离**。把 WeiboAP 适配拆成私有仓库 / 私有 crate（`symsync-weiboap`），
  公开仓库只留一个 trait 或注册表钩子；并且要 `git filter-repo` 重写历史、强推、让所有 fork 和
  clone 失效、GitHub 上已缓存的对象和 PR diff 也要联系 GitHub Support 清。
  成本高、破坏性大，而且**只要信息已经被人抓走过就仍然是公开的**。

选哪个取决于真实诉求：「别让外部用户在 App 里看到/用到内部东西」→ A 就够；
「公开仓库里不能出现内部信息」→ 必须 B，且要接受历史重写和已泄露不可逆。
本次交付 A，并把代码切成 B 容易接着做的形状（内部逻辑已全部集中在 `mcp/weiboap.rs`
和 `data/harnesses.weiboap.json` 两处，抽成私有 crate 时只需搬这两个文件 + 少量 cfg 行）。

## 2. feature 名与默认值

`weiboap`，**默认关闭**。

- 公开版 = 不加任何 feature 的默认构建：`cargo build`、`cargo test -p symsync-core`、CI 默认作业。
- 内部版 = 显式 `--features weiboap`（工作区范围写 `--features symsync-core/weiboap,symsync/weiboap`）。

为什么不是「内部默认开、公开 `--no-default-features`」：

1. **漏加 flag 的后果不对称**。忘了 `--features weiboap` → 内部版少一个 harness，打开就发现，重建即可；
   忘了 `--no-default-features` → 内部路径进了发出去的包，收不回来。让危险的那一侧需要动作。
2. **`--no-default-features` 是工作区级的粗粒度开关**。将来任何 crate 加 `default`
   （tauri 侧的 `custom-protocol` 这类很常见），公开版构建会连带被关掉，坏得无声无息。
   opt-in 永远只是多加一个 feature，不碰 `default`。
3. **默认被验证的那一个应该是要发出去的那一个**。CI 的默认作业跑的就是公开版。

## 3. harness 表：拆两份数据文件，不做运行时过滤

`discovery.rs` 用 `include_str!` 把 `data/harnesses.json` 整份嵌进二进制。
**解析后再按 feature 过滤是无效的**——字符串常量已经在产物里了，`strings` 一抓就有。
所以必须在编译期就不 include。

采用「公开全表 + 内部增量表」而不是两份全表：

- `data/harnesses.json`：40 条公开条目，不含 weiboap。
- `data/harnesses.weiboap.json`：只有 weiboap 一条，`#[cfg(feature = "weiboap")]` 才 `include_str!`。
- `specs()` = 公开表 ++ `extra_specs()`；`extra_specs()` 在关 feature 时是 `Vec::new()`。

两份全表会让 40 条公开条目双写，早晚漂移；增量表没有这个问题，新增公开 harness 只改一处。

## 4. 代码改动面

| 位置 | 做法 |
| --- | --- |
| `crates/core/Cargo.toml` | `[features] weiboap = ["rusqlite/backup"]`；`backup` 从 rusqlite 默认 features 里拿掉（只有 WeiboAP 的库备份用它） |
| `crates/core/src/discovery.rs` | 增量表的 `include_str!` + `extra_specs()`；依赖 weiboap 条目做夹具的 7 个单测跟着 feature 走 |
| `crates/core/src/mcp.rs` | `mod weiboap`、`State::Weibo` 变体、以及每一处 match 臂 / 分支加 `#[cfg]`；`State::readable` 改用 cfg 版 `is_weibo()`，避免关 feature 时 clippy 的 `match_like_matches_macro` |
| `crates/core/src/mcp/weiboap.rs` | 不改，整模块被 cfg 掉 |
| `crates/core/tests/mcp_weibo.rs`、`mcp_weibo_contract.rs` | 文件头 `#![cfg(feature = "weiboap")]` |
| `crates/core/tests/mcp_auto.rs` | 单个 weibo 用例与它的 helper、`rusqlite::Connection` import 加 cfg |
| `src-tauri/Cargo.toml` | `[features] weiboap = ["symsync-core/weiboap"]` |
| `src-tauri/src/lib.rs` | `discover_mcp` 里「未安装也强行把 weiboap 加进候选」的那段加 cfg（这是唯一一处 src-tauri 的内部字面量） |

`discovery.rs` 里 `agent_dirs` / `managed_global_dir` / `agent_labels`（读 harness 自带 SQLite 取显示名）
这套机制本身是通用的，**不跟 feature 走**：它不含任何内部信息，只是目前只有 WeiboAP 用。
代价是公开版里这套机制没有测试覆盖（用例都拿 weiboap 当夹具）；将来有第二个 harness 用到时，
应该把其中一两个用例改成合成 `Harness` 的通用夹具。

## 5. 验证

两种组合都必须编译、跑通、零 clippy 警告：

```
# 公开版
cargo test -p symsync-core
cargo clippy --workspace --all-targets -- -D warnings
# 内部版
cargo test -p symsync-core --features weiboap
cargo clippy --workspace --all-targets --features symsync-core/weiboap,symsync/weiboap -- -D warnings
```

`make test` 已经把两种组合都串进去（`test-core` / `test-app` 各跑两遍，`lint` 跑两遍 clippy）；
`make test-public` 只跑公开版组合，发布公开版前用。
`make dev` / `make build` 出公开版，`make dev-weiboap` / `make build-weiboap` 出内部版。

### 泄露抽查

对 `cargo build -p symsync` 与 `cargo build -p symsync --features weiboap` 各自产出的
`target/debug/symsync` 跑 `strings -a`（debug 产物比 release 保留更多符号，是更严格的检查）：

| 模式 | 公开版 | 内部版 |
| --- | --- | --- |
| `weibo`（不区分大小写）、`微博` | 0 | 64 |
| `WeiboAP` | 0 | 57 |
| `agents.db` | 0 | 3 |
| `Library/Application Support/WeiboAP` | 0 | 1 |
| `claude-code-plugins-custom` / `internal-plugins` | 0 | 1 / 1 |
| `UPDATE agents SET mcp_config` | 0 | 1 |
| `PRAGMA table_info(agents)` / `SELECT mcp_config FROM agents` | 0 | 1 / 1 |
| `appDataPath` / `pgEnabled` | 0 | 1 / 2 |

公开版里唯一还在的相关字符串是 `AgentLabels` / `table` / `idColumn` / `nameColumn`
——`AgentLabels` 类型自己的 serde 字段名，不含任何内部取值（表名 `agents`、列名不再出现在 SQL 字面量里）。
要连类型名都去掉，就得把 `AgentLabels` 也 cfg 掉，代价是 `Harness` 的 DTO 形状随 feature 变化、
前端 `src/types.ts` 要跟着分叉，不划算。

## 6. CI 需要补的命令

`.github/workflows/ci.yml` 由并行任务持有，本次未改。`core` job 现有的
`cargo test -p symsync-core` 和 clippy 跑的是**公开版**组合，继续有效；需要**新增**两条覆盖内部版：

```yaml
      - run: cargo test -p symsync-core --features weiboap
      - run: cargo clippy -p symsync-core -p symsync-gateway --all-targets --features symsync-core/weiboap -- -D warnings
```

`app` job（macOS）的 `cargo check --workspace` 同理可加一条
`cargo check --workspace --features symsync-core/weiboap,symsync/weiboap`。

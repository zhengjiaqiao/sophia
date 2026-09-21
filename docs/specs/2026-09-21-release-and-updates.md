# 发布到 GitHub、应用内更新、Homebrew 占位

> 依据：`docs/DESIGN.md`（提示条归属 §4.4）。操作手册在 `packaging/README.md`，这里只写为什么。

## 问题

Sophia 现在只能从源码 `make build` 出来。要让别人用上，缺三件事：一条从 tag 到安装包的路、
一条从旧版本到新版本的路、一条让人「听说过就能装上」的路（Homebrew）。

三件事咬在一起：更新要靠签名，签名要靠密钥，密钥不能进仓库；而 macOS 上没有 Apple 开发者
账号的话，安装包还会被 Gatekeeper 拦下来——这一条没法绕过去，只能明说代价。

## 需求

- **R1** 打 `v*` tag 触发发布：构建 macOS 两个架构的安装包，生成 GitHub Release 并附上产物。
- **R2** 版本号只有一个来源，其余位置对齐；对不上就让构建失败，而不是发出去两个版本号打架的包。
- **R3** 应用启动后台查更新；有新版给一条不打断的提示，**用户点了才下载**。不弹窗。
- **R4** 签名私钥不进仓库。没有密钥时流水线**明确失败并说清缺什么**，不静默跳过签名。
- **R5** 没有 Apple 开发者账号这件事，在 PR、Release 说明和 cask 里都写清代价和做法，不假装不存在。
- **R6** 仓库里带一份能用的 cask 与建 tap 的步骤，装得上、升得上去、版本号与 Release 对齐。
- **R7** release workflow 要能带 Cargo feature 参数产出多套产物（内部版 / 公开版），矩阵留好口子。

## 设计

### 1. 版本号的唯一来源（R2）

定在 **`src-tauri/tauri.conf.json` 的 `version`**。理由：只有它是 Tauri 真正用的那一个——
写进 `Info.plist`、决定安装包文件名、更新器比较的也是它。`src-tauri/Cargo.toml` 与
`package.json` 里的 `version` 对构建没有任何影响，但留着旧值会骗人。

`packaging/check-version.mjs` 校验三处一致（带 `--tag` 时连 tag 一起校）。它挂在两处：
CI 的 `app` job（每个 PR 都过一遍），和 release 的 `guard` job（打了 tag 再校一次，含 tag）。

**没有做「自动同步三处」**：改版本号是一年几次的事，自动改反而会在 review 时看不见。
脚本只负责报错，改由人来改。

### 2. 分架构，不做 universal（R1）

出 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` 两份，不出 universal 包。

更新清单 `latest.json` 本来就按 `darwin-aarch64` / `darwin-x86_64` 两个 key 分开列，分架构
出包让每台机器只下自己那一半；universal 要把同一个胖二进制挂在两个 key 下，等于让所有人
下双份。代价是编译两次，反正是发布时才跑。

两份都在 `macos-latest`（Apple 芯片）上编，x86_64 是交叉编译。这里能交叉是因为依赖栈干净：
`crates/gateway` 用 rustls + ring，整个 workspace 没有 `openssl-sys`（交叉编译 macOS 时
最常炸的就是它）。**以后如果引入了要链系统库的依赖，这个前提要重新验。**

矩阵 `max-parallel: 1`：两个架构都要往同一份 `latest.json` 上写，并行时后写的会盖掉先写的，
清单里只剩一个架构。那是发布一次才看得出来的错，不值得为省十分钟冒。

### 3. 草稿先行（R1）

`guard`（检查）→ `draft`（建草稿 Release 拿 id）→ `build`（两个架构挂产物）→ `publish`（转正）。

构建中途失败时草稿留着、对外不可见，不会出现一个只带一半产物的公开 Release。

`workflow_dispatch` 是排练：一样地构建、一样地签名，但不建 Release，产物落在 workflow
artifacts 里。它验得掉除了「Release 资产名和 latest.json 内容」之外的全部环节。

### 4. 更新产物只在发布那条路上做（R4）

`bundle.createUpdaterArtifacts` 打开之后，`tauri build` 没有签名私钥就会直接失败——
这正是 R4 要的「明确失败」。但本机 `make build` 出一个 debug 包不该为此去配密钥，
所以它不写进 `tauri.conf.json`，而是放在 `packaging/updater.conf.json`，
由 release workflow 用 `--config <绝对路径>` 合并进来。

用文件加绝对路径、不用内联 JSON 字符串：内联要穿过 YAML 和 action 的参数切分两道引号规则，
而这条路上出的错只有真发布一次才看得见。

### 5. macOS 签名：三档，不是两档（R5）

|  | 代价 | 用户体验 |
|---|---|---|
| ⓪ 完全不签 | 零 | **不可接受**。新版 macOS 判「已损坏」，连「仍要打开」都没得点 |
| ① 临时（ad-hoc）签名 | 零 | 被拦一次，跑一行 `xattr` 或去「系统设置 → 隐私与安全性」点「仍要打开」 |
| ② Developer ID 签名 + 公证 | 99 美元/年 | 双击就开 |

**默认走 ①。** 完全不签的包只带链接器给的那点痕迹、没有封好的资源签名，Gatekeeper 把它
当损坏文件；显式 `codesign -s -` 签一遍才保住「仍要打开」那条路。所以 workflow 里
`APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY || '-' }}` 的兜底不能删。

用环境变量给这个默认值，**不把 `signingIdentity: "-"` 写进 `tauri.conf.json`**：写进配置的话，
以后真买了证书，配置和 secret 谁压谁说不准，容易悄悄退回临时签名。`hardenedRuntime` 本来
就默认为 `true`，不用另配。

② 的接线位已经留好：七个 Apple 相关变量都挂在同名 secret 上，买了账号只填 secret，
workflow 一个字不用改。

### 6. 提示条挂在哪（R3）

按 §4.4，「处理它的动作就在那一行上」用行内待办条 `RowNotice`，不进待处理栏、不弹窗。
放在设置页「版本」那一行下面：更新是关于应用自己的一件事，版本号就是它的那一行。

三种要用户拿主意的处境各一条：**有新版**（`取回来装上`）、**装好了**（`重开`）、
**没装上**（`再试一次`），都带 `稍后`。查和下载的过程不需要用户决定什么，只是一行字，不占待办条。

**查不到更新时什么都不说**：离线、还没配公钥、开发模式下跑，都会让 `check()` 失败。
那不是用户此刻要处理的事，报出来只是噪音。

**没有「检查更新」按钮**：进页面就已经查过了，摆个按钮只会让人怀疑它没在查（§「什么时候才有按钮」）。

### 7. Homebrew 走自建 tap（R6）

官方 homebrew-cask 有知名度门槛，新仓库基本会被拒；而且从 2026-09 起它对未签名、未公证的
cask 已经开始下架。所以现实路径是自建 `zhengjiaqiao/homebrew-tap`。

`packaging/Casks/sophia.rb` 是渲染过一次的模板，committed 的那一份填的是占位值。
每次发版由 `packaging/render-cask.mjs` 把两个 dmg 下回来算 sha256 写回去——sha256 只能
从产物本身算，抄错了用户会在下载完之后才校验失败。脚本同时校验「cask 拼出来的 url 和
Release 上真实的资产名逐字相同」，对不上就停，免得 brew 去下一个 404。

**没有写 `auto_updates true`**：写了 `brew upgrade` 会跳过它（认为应用自管）。应用内更新
和 `brew upgrade` 两条路都留着，谁先跑到算谁的——重复一点，但都能走通。

### 8. 内部版的口子（R7）

`build` 的矩阵是 `target × variant`，`variant` 带 `features` 和 `publish` 两个字段：
`features` 空就不加 `--features`，`publish: false` 的变体只落在 workflow artifacts 里、
不往公开 Release 上挂。内部版那一条已经写好注释在矩阵里，feature 名定下来把注释去掉即可。

## 验收标准

- **AC1** `node packaging/check-version.mjs` 在三处一致时退 0，任一处不一致或 `--tag` 对不上时退 1 并指出是哪一处。
- **AC2** `actionlint .github/workflows/*.yml` 零告警。
- **AC3** `make test` 全绿；`cargo check --workspace` 过（含 updater / process 两个插件与新增的 capability 权限）。
- **AC4** `brew style --cask <tap>/sophia` 零 offense；`brew info --cask` 能渲染出 caveats。
- **AC5** 公钥为空或缺 `TAURI_SIGNING_PRIVATE_KEY` 时，release workflow 在 `guard` 这一步失败，并打出「去哪儿补」。
- **AC6** 设置页在没有新版时只显示版本号一行；有新版时下面多一条 `RowNotice`，点了才开始下载。

## 真发布一次才验得掉的

下面几条在没有密钥、没有 tag 的情况下**没有验过**，第一次发版要盯着：

1. `tauri-action` 生成的 dmg 实际文件名是否就是 `Sophia_<版本>_aarch64.dmg` / `_x64.dmg`。
   cask 的 url 模板按这个拼；`render-cask.mjs` 会当场校出来并报错，但要到那时才知道。
2. 两个架构串行写同一份 `latest.json`，合并结果是否真的两个 key 都在。
3. x86_64 交叉编译整个 workspace 是否真的过（本地只验了依赖栈里没有 openssl）。
4. 临时签名的包在 macOS 26 上是否真的还能走「仍要打开」。**CI 里把 .app 拷出来跑二进制
   碰不到 Gatekeeper，绿了也不代表用户装得上**——要验就得带着 quarantine 属性验。
5. 应用内更新的完整一轮（0.1.0 装着 → 发 0.2.0 → 设置页出条子 → 下载 → 重开）。

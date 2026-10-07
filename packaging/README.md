# 发布 Sophia

这一份是操作手册。

**两个仓库**：开发在私有的 `zhengjiaqiao/sophia-dev`，发布在公开的 `zhengjiaqiao/sophia`。
公开仓库只放代码快照（`scripts/publish-public.sh` 同步），更新地址、Homebrew、Release 都指向它（更新另有腾讯云 COS 上的国内线路，见第 5 件），
`release.yml` 也只在它那里运行。所以下面的 Secret、tag、排练都落在**公开仓库**；改代码永远在开发仓库，
不要直接往公开仓库提交——下一次同步会用开发仓库的快照把它盖掉。

## 只做一次的五件事

### 1. 生成更新签名密钥对

应用内更新靠这对密钥：私钥在 CI 里给安装包签名，公钥编进应用里验签。**私钥不要提交进仓库。**

```sh
npm run tauri signer generate -- -w ~/.tauri/sophia.key
```

会生成两个文件，并在终端打印公钥：

- `~/.tauri/sophia.key` —— 私钥。只进 GitHub Secret，不进 git，不进聊天记录。
- `~/.tauri/sophia.key.pub` —— 公钥。

把**公钥文件的内容**（不是路径）填进 `src-tauri/tauri.conf.json`：

```json
"plugins": { "updater": { "pubkey": "<这里>" } }
```

填之前流水线会红在 guard 这一步，并把这段话打出来。

### 2. 配两个 GitHub Secret

配在**公开仓库**（`zhengjiaqiao/sophia` → Settings → Secrets and variables → Actions），或者用命令行：

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY -R zhengjiaqiao/sophia < ~/.tauri/sophia.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R zhengjiaqiao/sophia   # 按提示输入
```


| Secret 名 | 填什么 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/sophia.key` 的**整个文件内容** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设的密码；没设就填空 |

名字必须逐字一致——这两个名字是 Tauri 认的环境变量名，不能改。

另有一个**仓库变量**（不是 Secret，同一页的 Variables 标签）：`SOPHIA_REPORT_URL`，接收服务的地址（如
`https://api.sophiakit.workers.dev`，部署见 `server/README.md`；guard 会检查它，空着就在编译前失败）。发版时编进公开版，用于自动上报
（spec 2026-10-04-reporting-feedback）；内部版不编。没设或为空，打出来的包就不上报、设置里也没有那一行：

```sh
gh variable set SOPHIA_REPORT_URL -R zhengjiaqiao/sophia --body 'https://api.sophiakit.workers.dev'
```

### 3. Apple 签名与公证

发出去的包带 Developer ID 签名并经过 Apple 公证，用户双击就能打开（spec 2026-10-05-signing-notarization）。
`release.yml` 的 guard 要求下面七个 secret **都在**（同样配在公开仓库），缺一个就在编译前失败、逐项说缺什么；
不再退回临时签名。

**证书**（账号持有人才能建，5 年到期，到期前按同样步骤重建、重设前三个 secret）：

1. Xcode → Settings → Accounts，登录开发者账号 → Manage Certificates → 左下角「+」→ **Developer ID Application**。
2. 「钥匙串访问」→ 登录 → 我的证书，找到 `Developer ID Application: …`，右键「导出」成 `.p12`，设一个密码。
3. `security find-identity -v -p codesigning` 里那一整串名字就是 `APPLE_SIGNING_IDENTITY`。

**公证**用 Apple ID 加 App 专用密码（account.apple.com →「登录与安全」→「App 专用密码」）。

**设 secret**：值只在自己的终端里输入或从文件读，不进仓库、不进聊天记录。

```sh
R=zhengjiaqiao/sophia
base64 -i ~/Desktop/sophia-developer-id.p12 | gh secret set APPLE_CERTIFICATE -R $R
gh secret set APPLE_CERTIFICATE_PASSWORD -R $R     # 按提示粘贴导出 .p12 时设的密码
gh secret set APPLE_SIGNING_IDENTITY -R $R --body "$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
openssl rand -base64 24 | gh secret set KEYCHAIN_PASSWORD -R $R   # CI 临时钥匙串的密码，随机即可
gh secret set APPLE_ID -R $R --body '开发者账号的 Apple ID 邮箱'
gh secret set APPLE_PASSWORD -R $R                 # 按提示粘贴 App 专用密码
gh secret set APPLE_TEAM_ID -R $R --body '10 位 Team ID（developer.apple.com/account 的 Membership details）'
```

设完 `.p12` 文件就可以删掉（证书本身还在钥匙串里）。

每个架构构建完，`packaging/verify-signature.sh` 核对三件事：签名完整、Gatekeeper 认它是
`Notarized Developer ID`、票据已钉上。CI 上的文件没有 quarantine 属性，绿了不等于用户打得开；
第一次发版前，用浏览器下一份排练产物（带 quarantine）在真机上双击验一次。

### 4. Homebrew tap 与推 tap 的令牌

官方 homebrew-cask 有知名度门槛（新仓库基本会被拒），而且从 2026-09 起它对未签名、未公证的 cask 已经开始下架。**现实路径是自建 tap。**
tap 仓库是公开的 `zhengjiaqiao/homebrew-tap`（仓库名必须叫 homebrew-tap，brew 才认 `zhengjiaqiao/tap` 这种短写法），
里面只有 `Casks/sophia.rb`。用户那边：

```sh
brew install --cask zhengjiaqiao/tap/sophia
# 以后
brew upgrade --cask sophia
```

每次发版由工作流把新的 cask 推进 tap（见下面「每次发版」），推送用公开仓库的 secret `HOMEBREW_TAP_TOKEN`：
一个 **fine-grained PAT，只授权 `zhengjiaqiao/homebrew-tap`，权限只有 Contents: Read and write**，泄露了也动不了别的仓库。
建令牌、写 secret 跑向导，它会打开预填好的创建页、试推一下确认权限对、再 `gh secret set`，令牌不落盘、不打印：

```sh
packaging/setup-tap-token.sh
```

**有效期**：向导预填 366 天；也可以选不过期，但那样只能靠自己记得撤销。到期前 GitHub 会发邮件。

**过期之后**：发版照常——Release 转正、应用内更新都不受影响，但工作流里的「homebrew / cask」那一步会红在第一步，
报 `secret HOMEBREW_TAP_TOKEN 认不出（HTTP 401）`，brew 用户就停在旧版。补救：重跑 `packaging/setup-tap-token.sh`
换一个新令牌，再按下面「Homebrew cask」的手动入口对这次的 tag 补推。令牌被撤销、建的时候没勾 tap 仓库（报 HTTP 403/404）同样处理。

### 5. 腾讯云 COS（更新与下载的国内线路）

应用更新有两条线路（`src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`，按先后试）：GitHub 在前，
腾讯云 COS 在后（`https://sophia-releases-1258113621.cos.ap-shanghai.myqcloud.com/latest.json`）。
官网给国内访客的 `.dmg` 下载也指向 COS（Cloudflare Pages 的环境变量 `COS_BASE_URL` 配成桶的默认域名，不带路径；随 #187 托管一起配）。
桶建在上海地域、公有读，设了流量告警与每月预算。建桶、建只能上传的子账号、把密钥写进公开仓库，跑向导：

```sh
scripts/setup-cos.sh
```

它写的是密钥 `COS_SECRET_ID`、`COS_SECRET_KEY`（子账号 `sophia-release-ci`，CAM 策略 `sophia-cos-releases-write`，
只能上传和查看、不能删除）与仓库变量 `COS_BUCKET`（带 `-APPID` 的完整桶名）、`COS_REGION`。
密钥泄露或要换账号，都重跑这一份。

## 每次发版

```sh
# 1. 在开发仓库改版本号。三处一起改成新版本：唯一来源是 src-tauri/tauri.conf.json，
#    另外两处（src-tauri/Cargo.toml、package.json）必须跟着改成一样的值。
node packaging/check-version.mjs        # 绿了再往下

# 2. 提交、开 PR、CI 过了合进 sophia-dev 的 main
git commit -am "chore: 0.2.0"

# 3. 合并后，在本地 main 上把快照同步到公开仓库，并在这次同步提交上打 tag
git switch main && git pull --ff-only
scripts/publish-public.sh                     # 先演练，看要同步哪些变化
scripts/publish-public.sh --push --tag v0.2.0

# 4. （可选）开发仓库也打同名 tag 留个记号；私有仓库里 release.yml 不会运行
git tag v0.2.0 && git push origin v0.2.0
```

tag 推到公开仓库之后，那边的 `.github/workflows/release.yml` 会：建草稿 Release → 依次构建
`aarch64-apple-darwin` 和 `x86_64-apple-darwin` → 挂上 dmg、`.app.tar.gz` 和签名 →
合并出 `latest.json` → 把草稿转正 → 同步到腾讯云 COS（见下面「腾讯云 COS（自动）」）、把 cask 推进 Homebrew tap（见下面「Homebrew cask」）。

更新包的签名要写着这一版的版本号：应用开了 `requireSignedVersion`（`tauri.conf.json`），签名里没有版本号或对不上，
已装的客户端会拒绝这次更新。版本号由 Tauri CLI 2.12 起在 `tauri build` 时写进签名的可信注释，所以 `package.json`
的 `@tauri-apps/cli` 不能低于 2.12；流水线在「更新包签名里写着版本号」这一步核对，缺了就红。

想先排练一遍而不真发布：先 `scripts/publish-public.sh --push` 把代码同步过去（不打 tag），
再在公开仓库跑一次 Release 工作流。一样地构建和签名，不建 Release、不推 tap，产物落在 workflow artifacts 里：

```sh
gh workflow run release.yml -R zhengjiaqiao/sophia
gh run list -R zhengjiaqiao/sophia --workflow release.yml --limit 1
```

### 留存符号文件（dSYM）

发布档是 `strip = "debuginfo"` + `split-debuginfo = "packed"`（根 `Cargo.toml`）：包里的程序只留函数名，
行号表另存在构建机的 `target/<架构>/release/sophia.dSYM`，**不随包发**。用户发来崩溃记录时要靠它对行号，
所以每次发版把两个架构的 dSYM 留下来，按版本号与架构存好（丢了就再也对不上这一版）：

```sh
# 每个架构一份；名字带版本与架构。target/…/sophia.dSYM 是指向 deps/sophia-<哈希>.dSYM 的软链，
# 用 cp -RL 取出实体并改成固定的名字（直接 ditto 软链会带着哈希名打包）
cp -RL target/aarch64-apple-darwin/release/sophia.dSYM sophia-0.2.0-aarch64.dSYM
cp -RL target/x86_64-apple-darwin/release/sophia.dSYM  sophia-0.2.0-x86_64.dSYM
ditto -c -k --keepParent sophia-0.2.0-aarch64.dSYM sophia-0.2.0-aarch64.dSYM.zip
ditto -c -k --keepParent sophia-0.2.0-x86_64.dSYM  sophia-0.2.0-x86_64.dSYM.zip
# 核对与包里的程序是同一次构建：两边的 UUID 要一致
dwarfdump --uuid sophia-0.2.0-aarch64.dSYM
dwarfdump --uuid Sophia.app/Contents/MacOS/Sophia   # 打包时程序改名成 Sophia，内容同一个
```

CI 发版时 Release 工作流已经按上面的办法取出 dSYM，每个架构存成一个 artifact
`sophia-dsym-<变体>-<架构>`（里面是 `sophia-<版本>-<架构>-<变体>.dSYM`）。artifact 只保留 90 天（公开仓库的上限），
**发版后一周内下回来另存**：

```sh
gh run list -R zhengjiaqiao/sophia --workflow release.yml --limit 1      # 找到这次发版的 run id
gh run download <run id> -R zhengjiaqiao/sophia --pattern 'sophia-dsym-*' -D dsym-0.2.0
```

对行号：`crash.log`（`~/Library/Logs/com.zhengjiaqiao.sophia/`）里有 panic 的文件:行与带函数名的调用栈，
其余各帧的行号用系统自己的崩溃报告（`~/Library/Logs/DiagnosticReports/Sophia-*.ips`，带每帧地址与镜像加载地址）
配合 dSYM 离线查：

```sh
atos -arch arm64 -o sophia-0.2.0-aarch64.dSYM -l <镜像加载地址> <帧地址…>
```

### 验证崩溃记录（故意出错的入口）

`src-tauri` 的 cargo feature `diag-faults` 带着开发者的故意出错入口（`SOPHIA_FAULT=panic` / `gateway-state` / `page:<页>`）。
调试版总是带着；**正式包不能带**：release 构建开了它，`src-tauri/build.rs` 会让构建直接失败。
只有本机验证崩溃记录（spec 2026-10-04-local-diagnostics AC4）时显式放行，打出来的包用完就删，不要发出去：

```sh
SOPHIA_ALLOW_DIAG_FAULTS=1 npm run tauri build -- --features diag-faults
# 直接跑包里的程序（open 不把环境变量带给应用）；约 2 秒后崩溃，看 ~/Library/Logs/com.zhengjiaqiao.sophia/crash.log
SOPHIA_FAULT=panic target/release/bundle/macos/Sophia.app/Contents/MacOS/Sophia
```

### Homebrew cask（自动）

Release 转正之后，`release.yml` 调 `.github/workflows/homebrew-cask.yml`，在 macOS runner 上：
核对 `HOMEBREW_TAP_TOKEN` 能推 tap → `node packaging/render-cask.mjs <tag>`（下回两个 dmg 现算 sha256，产物名对不上就停）→
放进 brew 自己 clone 的 tap → `brew style`、`brew audit --cask --strict --online --arch=all` →
`brew install --cask` 真装一次、核对装上的版本 → `brew uninstall --zap --cask` 卸一次、核对应用和 zap 路径都清掉 →
全过才在 tap 里提交「sophia <版本>」并推送。tap 里已经是这一版就不提交，日志里一句 notice。

这一步红了**不影响 Release**（它已经公开了），只是 brew 用户暂时还是旧版。看 job 日志的 `::error::` 那几行：
令牌的问题按上面「4. Homebrew tap 与推 tap 的令牌」换令牌；cask 检查没过就在开发仓库改模板或脚本、合并、
`scripts/publish-public.sh --push` 同步过去（不用重打 tag）。然后用手动入口补推：

```sh
gh workflow run homebrew-cask.yml -R zhengjiaqiao/sophia -f tag=v0.2.0
gh run list -R zhengjiaqiao/sophia --workflow homebrew-cask.yml --limit 1
```

手动入口用的是公开仓库 main 上最新的 cask 模板，version 与 sha256 取自填的那个 tag 的 Release；
对已经推过的 tag 再跑一次，等于只做一遍检查。

### 腾讯云 COS（自动）

Release 转正之后，`release.yml` 调 `.github/workflows/cos-sync.yml`，在 ubuntu runner 上：
核对 tag 是最新的正式版、COS 密钥与变量都在 → 从 Release 下回 `latest.json`、两个 `.app.tar.gz`、两个 `.dmg` →
`node packaging/cos-manifest.mjs <tag> <桶基址> dist` 改写清单（只换包地址，签名原样；版本号对不上、
地址不是这次 Release 的资产、dmg 名字官网拼不出，都停）→ 用腾讯云的 `coscli`（钉版本与 sha256）逐个上传，
每传一个就从公网 HEAD 一次、核对大小 → 最后才传 `latest.json` 并从公网取回逐字比对。

COS 上的布局照 GitHub 的下载地址：

```
<桶>/latest.json                       改写过地址的清单（只有一份，总是最新版）
<桶>/v0.2.0/Sophia_0.2.0_aarch64.app.tar.gz
<桶>/v0.2.0/Sophia_0.2.0_aarch64.dmg   官网下载函数拼的就是这个地址
…
```

这一步红了**不影响 Release**，GitHub 那条线路照常能更新，只是国内线路停在旧版。看 job 日志的 `::error::`：
权限错误（403、AccessDenied）就在 CAM 策略 `sophia-cos-releases-write` 里补上报错提到的操作；密钥失效就重跑
`scripts/setup-cos.sh`。然后用手动入口补传（也是单独排练这一段的办法，对最新的已发布 tag 跑，重传等于覆盖成同样的内容）：

```sh
gh workflow run cos-sync.yml -R zhengjiaqiao/sophia -f tag=v0.2.0
gh run list -R zhengjiaqiao/sophia --workflow cos-sync.yml --limit 1
```

只认最新的正式版：清单只有一份，传旧版会把国内线路倒回旧版本。

## 中途失败了怎么办

草稿 Release 会留在公开仓库（它对外不可见）。在开发仓库修完、合并之后，重打同一个 tag 之前
**先把公开仓库的草稿和 tag 删掉**，否则同步脚本推 tag 会失败，或者多出一个同 tag 的 Release：

```sh
gh release delete v0.2.0 -R zhengjiaqiao/sophia --yes --cleanup-tag
scripts/publish-public.sh --push --tag v0.2.0
```

开发仓库里如果也打了同名 tag，一起挪到新的提交上：

```sh
git push --delete origin v0.2.0 && git tag -f v0.2.0 && git push origin v0.2.0
```

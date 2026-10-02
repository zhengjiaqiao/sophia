# 发布 Sophia

这一份是操作手册。

**两个仓库**：开发在私有的 `zhengjiaqiao/sophia-dev`，发布在公开的 `zhengjiaqiao/sophia`。
公开仓库只放代码快照（`scripts/publish-public.sh` 同步），更新地址、Homebrew、Release 都指向它，
`release.yml` 也只在它那里运行。所以下面的 Secret、tag、排练都落在**公开仓库**；改代码永远在开发仓库，
不要直接往公开仓库提交——下一次同步会用开发仓库的快照把它盖掉。

## 只做一次的四件事

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

### 3. 决定要不要买 Apple 开发者账号

分三档，差别比「签不签名」这个二选一要大：

| | 代价 | 用户体验 |
|---|---|---|
| ⓪ 什么都不配，完全不签 | 零成本 | **不可接受**。新版 macOS 直接判「已损坏」，连「仍要打开」都没得点，只剩死胡同 |
| ① 临时（ad-hoc）签名，`codesign -s -` | 零成本 | 被拦一次，用户跑一行 `xattr`，或去「系统设置 → 隐私与安全性」点「仍要打开」 |
| ② 买开发者账号（99 美元/年），签名 + 公证 | 每年 99 美元；首次公证可能等几小时 | 双击就开，和任何正规 App 一样；cask 也干净 |

**现在默认走 ①**：workflow 里 `APPLE_SIGNING_IDENTITY` 没有 secret 时退到 `-`，
产物带临时签名。Release 说明和 cask 的 caveats 都写了怎么放行。

⓪ 和 ① 的区别不是程度问题：完全不签的包只带链接器给的那点 ad-hoc 痕迹、没有封好的
资源签名，Gatekeeper 把它当损坏文件；显式签一遍才保住「仍要打开」那条路。所以
**不要把 `APPLE_SIGNING_IDENTITY` 的那个 `|| '-'` 兜底删掉**。

②的接线已经留好（同样配在公开仓库）：`.github/workflows/release.yml` 里 tauri-action 那一步的 `env:` 已经把七个变量挂到同名 secret 上，**买了账号只需要把 secret 填上，workflow 一个字都不用改**（`APPLE_SIGNING_IDENTITY` 一旦有值就自动顶掉 `-`）：

`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`KEYCHAIN_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`

填上之后记得把 Release 说明和 cask caveats 里那段 `xattr` 删掉。

### 4. 建 tap 仓库

官方 homebrew-cask 有知名度门槛（新仓库基本会被拒），而且从 2026-09 起它对未签名、未公证的 cask 已经开始下架。**现实路径是自建 tap。**

```sh
# 本机生成一个 tap 骨架
brew tap-new zhengjiaqiao/tap

# 推到 GitHub（仓库名必须叫 homebrew-tap，brew 才认 zhengjiaqiao/tap 这种短写法）
gh repo create zhengjiaqiao/homebrew-tap --public --push \
  --source "$(brew --repository zhengjiaqiao/tap)"
```

用户那边：

```sh
brew tap zhengjiaqiao/tap
brew install --cask sophia
# 以后
brew upgrade --cask sophia
```

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
合并出 `latest.json` → 把草稿转正。

想先排练一遍而不真发布：先 `scripts/publish-public.sh --push` 把代码同步过去（不打 tag），
再在公开仓库跑一次 Release 工作流。一样地构建和签名，不建 Release，产物落在 workflow artifacts 里：

```sh
gh workflow run release.yml -R zhengjiaqiao/sophia
gh run list -R zhengjiaqiao/sophia --workflow release.yml --limit 1
```

发布完更新 cask：

```sh
node packaging/render-cask.mjs v0.2.0    # 下回产物算 sha256，写回 Casks/sophia.rb
brew style --cask zhengjiaqiao/tap/sophia

cp packaging/Casks/sophia.rb "$(brew --repository zhengjiaqiao/tap)/Casks/sophia.rb"
cd "$(brew --repository zhengjiaqiao/tap)" && git commit -am "sophia 0.2.0" && git push
```

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

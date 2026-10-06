# Sophia 的 Homebrew cask。
#
# 这一份是**模板加上一次渲染的结果**：version 与两个 sha256 由
# `node packaging/render-cask.mjs v<版本>` 从 GitHub Release 的真实产物算出来后写回。
# 手改 version 而不改 sha256，`brew install` 会在校验那一步失败。
#
# tap 仓库 zhengjiaqiao/homebrew-tap 已建，用户从 tap 装：`brew install --cask zhengjiaqiao/tap/sophia`。
# 每次发版 Release 转正后，公开仓库的 homebrew-cask.yml 工作流渲染这个文件、跑检查、真装真卸，
# 全过才把它推到 tap 仓库的 Casks/sophia.rb；不用手动复制。
# 工作流没跑通时手工补推：`gh workflow run homebrew-cask.yml -R zhengjiaqiao/sophia -f tag=vX.Y.Z`。
# 步骤见 packaging/README.md。
cask "sophia" do
  arch arm: "aarch64", intel: "x64"

  # 下面三行每次发版由 render-cask.mjs 重写，填的是该版 GitHub Release 产物的真实值
  version "0.1.1"
  sha256 arm:   "46b584a0bf709906cc8dcdb1c1b36f38df6b8fc37d4842c607539ade7dc83eaa",
         intel: "c971914881b5f113ff299cdb11b9f59e95ff5eb73678c7ccc494062ca6efaf32"

  url "https://github.com/zhengjiaqiao/sophia/releases/download/v#{version}/Sophia_#{version}_#{arch}.dmg"
  name "Sophia"
  desc "Links AI coding agent skills and MCP servers across harnesses"
  homepage "https://github.com/zhengjiaqiao/sophia"

  livecheck do
    url :url
    strategy :github_latest
  end

  # 没有写 auto_updates：应用自己也会查更新，但只有 brew upgrade 这条路
  # 能把 cask 记录的版本号一起带上去。两条路都留着，谁先跑到算谁的。
  #
  # 最低系统版本和 src-tauri/tauri.conf.json 的 bundle.macOS.minimumSystemVersion 写同一个值
  # （spec 2026-10-05-min-macos）：brew 在下载前就拦住老系统，.app 里的 LSMinimumSystemVersion
  # 是最后一道。两处改要一起改。
  depends_on macos: :sonoma

  app "Sophia.app"

  # 退出时 Sophia 自己把 Codex、Claude 桌面应用改回官方模型（网关跑在应用进程里，没有后台服务要卸）
  uninstall quit: "com.zhengjiaqiao.sophia"

  zap trash: [
    "~/Library/Application Support/Sophia",
    "~/Library/Caches/com.zhengjiaqiao.sophia",
    "~/Library/Logs/com.zhengjiaqiao.sophia",
    "~/Library/Preferences/com.zhengjiaqiao.sophia.plist",
    "~/Library/Saved Application State/com.zhengjiaqiao.sophia.savedState",
    "~/Library/WebKit/com.zhengjiaqiao.sophia",
  ]

  caveats <<~EOS
    卸载前先退出 Sophia（它会把 Codex 和 Claude 桌面应用改回官方模型）。
    brew 升级会先关掉 Sophia，正在运行的 Codex 要重启一次才会重新接上。
  EOS
end

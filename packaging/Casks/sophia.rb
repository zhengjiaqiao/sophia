# Sophia 的 Homebrew cask。
#
# 这一份是**模板加上一次渲染的结果**：version 与两个 sha256 由
# `node packaging/render-cask.mjs v<版本>` 从 GitHub Release 的真实产物算出来后写回。
# 手改 version 而不改 sha256，`brew install` 会在校验那一步失败。
#
# 用户不从这个仓库装，而是从 tap 仓库 zhengjiaqiao/homebrew-tap 装。
# 每次发版把渲染后的这个文件复制到 tap 仓库的 Casks/sophia.rb 再 push。
# 步骤见 packaging/README.md。
cask "sophia" do
  arch arm: "aarch64", intel: "x64"

  # 下面三行每次发版由 render-cask.mjs 重写；现在填的是占位值，装不上任何东西
  version "0.0.0"
  sha256 arm:   "000000000000000000000000000000000000000000000000000000000000000a",
         intel: "000000000000000000000000000000000000000000000000000000000000000b"

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
  # depends_on :macos 不带版本：Sophia 只有 macOS 版，而最低系统版本由 .app 里的
  # LSMinimumSystemVersion 说了算，在这儿再写一个数字只会有两个来源。
  depends_on :macos

  app "Sophia.app"

  # 模型网关是个 launchd 常驻服务，指着 .app 里的可执行文件。
  # 卸载时不把它卸掉，它会一直去拉一个已经不存在的程序。
  uninstall launchctl: "com.zhengjiaqiao.symsync.gateway",
            quit:      "com.zhengjiaqiao.symsync"

  zap trash: [
    "~/Library/Application Support/SymSync",
    "~/Library/Caches/com.zhengjiaqiao.symsync",
    "~/Library/Preferences/com.zhengjiaqiao.symsync.plist",
    "~/Library/Saved Application State/com.zhengjiaqiao.symsync.savedState",
    "~/Library/WebKit/com.zhengjiaqiao.symsync",
  ]

  caveats <<~EOS
    Sophia 还没有 Apple 开发者签名，macOS 第一次打开会拦一次。
    跑一次这条命令就好，只需要做一次：

      xattr -dr com.apple.quarantine #{appdir}/Sophia.app

    或者双击打开、被拦住之后去「系统设置 → 隐私与安全性」点「仍要打开」。

    Sophia 如果启用过模型网关，卸载前先在应用里「停用」一次：
    它往 ~/.codex/config.toml 写过东西，那部分只有应用自己能干净地撤回。
  EOS
end

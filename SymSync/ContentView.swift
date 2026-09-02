import AppKit
import SwiftUI

/// 一次性沙盒验证：在授权的目标目录里创建指向另一目录的软链。Task 13 会替换本文件。
struct ContentView: View {
  @State private var result = "未运行"

  var body: some View {
    VStack(spacing: 12) {
      Text("沙盒建链检查").font(.title2)
      Button("选择源目录与目标目录并建链") { run() }
      Text(result).textSelection(.enabled)
    }
    .padding(24)
    .frame(width: 480)
  }

  private func run() {
    guard let source = pick("选择源目录"), let target = pick("选择目标目录") else {
      result = "已取消"
      return
    }
    let link = target.appendingPathComponent("symsync-check")
    do {
      try FileManager.default.createSymbolicLink(
        atPath: link.path, withDestinationPath: source.path)
      result = "已创建 \(link.path) -> \(source.path)"
    } catch {
      result = "失败：\(error.localizedDescription)"
    }
  }

  private func pick(_ message: String) -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.message = message
    return panel.runModal() == .OK ? panel.url : nil
  }
}

import SwiftUI
import SymSyncCore

/// 路径文本框 + 选择按钮；输入未授权路径时提示先授权父目录。
struct DirectoryField: View {
  @Environment(RuleListModel.self) private var model
  let title: String
  @Binding var location: Location?
  @State private var text = ""
  @State private var unauthorizedPath: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        TextField(title, text: $text, prompt: Text("输入路径或点选择…"))
          .textFieldStyle(.roundedBorder)
          .onSubmit(commitTyped)
        Button("选择…") {
          if let chosen = model.chooseDirectory(message: title) {
            location = chosen
            text = chosen.url.path
            unauthorizedPath = nil
          }
        }
      }
      if let path = unauthorizedPath {
        Button {
          if let granted = model.grantParent(of: path) {
            location = granted
            unauthorizedPath = nil
          }
        } label: {
          Text("该路径未授权，点此授权父目录").font(.caption)
        }
        .buttonStyle(.link)
        .foregroundStyle(.red)
      }
    }
    .onAppear { text = location?.url.path ?? "" }
    .onChange(of: location) { _, new in
      text = new?.url.path ?? ""
      unauthorizedPath = nil
    }
  }

  private func commitTyped() {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    if let found = model.location(forTypedPath: trimmed) {
      location = found
      unauthorizedPath = nil
    } else {
      unauthorizedPath = trimmed
    }
  }
}

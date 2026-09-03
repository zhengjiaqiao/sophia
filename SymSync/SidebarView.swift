import SwiftUI
import SymSyncCore

struct SidebarView: View {
  @Environment(RuleListModel.self) private var model

  var body: some View {
    @Bindable var model = model
    List(selection: $model.selectedRuleID) {
      ForEach(model.rules) { rule in
        VStack(alignment: .leading, spacing: 2) {
          Text(rule.name)
          Text(rule.source.bookmark == nil ? "未设置源目录" : rule.source.url.path)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .tag(rule.id)
        .contextMenu {
          Button("删除", role: .destructive) { model.delete(rule.id) }
        }
      }
    }
    .navigationSplitViewColumnWidth(min: 200, ideal: 240)
    .toolbar {
      ToolbarItem {
        Button {
          _ = model.addRule()
        } label: {
          Label("新建", systemImage: "plus")
        }
      }
    }
  }
}

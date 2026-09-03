import SwiftUI
import SymSyncCore

struct ContentView: View {
  @Environment(RuleListModel.self) private var model

  var body: some View {
    NavigationSplitView {
      SidebarView()
    } detail: {
      if let rule = model.rules.first(where: { $0.id == model.selectedRuleID }) {
        RuleDetailView(rule: rule)
          .id(rule.id)
      } else {
        Text("选择或新建一条同步记录").foregroundStyle(.secondary)
      }
    }
    .frame(minWidth: 800, minHeight: 520)
    .alert(
      "出错了",
      isPresented: Binding(
        get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    ) {
      Button("好") {}
    } message: {
      Text(model.errorMessage ?? "")
    }
  }
}

import SwiftUI
import SymSyncCore

@main
struct SymSyncApp: App {
  @State private var model = RuleListModel(
    store: FileRuleStore(fileURL: AppPaths.rulesFile),
    grantStore: GrantStore(fileURL: AppPaths.grantsFile)
  )

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environment(model)
    }
  }
}

enum AppPaths {
  static var support: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("SymSync")
  }
  static var rulesFile: URL { support.appendingPathComponent("rules.json") }
  static var grantsFile: URL { support.appendingPathComponent("grants.json") }
}

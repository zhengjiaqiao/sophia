import SwiftUI

@main
struct SymSyncApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
    .windowResizability(.contentSize)
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

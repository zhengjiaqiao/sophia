import AppKit

enum DirectoryPicker {
  @MainActor
  static func pick(message: String, startingAt: URL? = nil) -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.message = message
    panel.directoryURL = startingAt
    return panel.runModal() == .OK ? panel.url : nil
  }
}

import Foundation

/// 执行规划结果：只对 create 建链；brokenLink 仅在 cleanBroken 时删除链接本身。逐项独立，单项失败不中断。
public struct Executor {
  private let fm: FileManager

  public init(fileManager: FileManager = .default) {
    self.fm = fileManager
  }

  public func run(_ actions: [PlannedAction], cleanBroken: Bool = false) -> SyncReport {
    SyncReport(
      entries: actions.map { action in
        SyncReport.Entry(action: action, outcome: outcome(for: action, cleanBroken: cleanBroken))
      })
  }

  private func outcome(for action: PlannedAction, cleanBroken: Bool) -> SyncReport.Outcome {
    switch action.kind {
    case .create:
      var isDirectory: ObjCBool = false
      guard fm.fileExists(atPath: action.target.path, isDirectory: &isDirectory),
        isDirectory.boolValue
      else {
        return .failed("目标目录不存在")
      }
      do {
        try fm.createSymbolicLink(
          atPath: action.targetPath.path, withDestinationPath: action.sourcePath.path)
        return .created
      } catch {
        return .failed(error.localizedDescription)
      }
    case .brokenLink where cleanBroken:
      // 预览到确认之间路径可能已被换成真实文件，删除前再确认仍是软链
      guard case .symlink = fm.entryKind(atPath: action.targetPath.path) else {
        return .failed("不再是软链接，已跳过")
      }
      do {
        try fm.removeItem(atPath: action.targetPath.path)
        return .removed
      } catch {
        return .failed(error.localizedDescription)
      }
    case .alreadyLinked, .conflict, .sourceMissing, .brokenLink:
      return .skipped
    }
  }
}

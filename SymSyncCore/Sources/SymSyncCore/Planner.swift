import Foundation

public enum PlannerError: Error, Equatable {
  case sourceUnreadable(String)
}

/// 只读规划：对每个目标目录 × 每个子项判定应执行的动作。不修改文件系统。
public struct Planner {
  private let fm: FileManager

  public init(fileManager: FileManager = .default) {
    self.fm = fileManager
  }

  public func plan(_ rule: SyncRule) throws -> [PlannedAction] {
    let source = normalizedPath(rule.source.url.path)
    let names = try itemNames(for: rule.selection, in: source)
    var actions: [PlannedAction] = []
    for target in rule.targets {
      let targetDir = normalizedPath(target.url.path)
      for name in names {
        actions.append(action(for: name, source: source, targetDir: targetDir))
      }
      actions += brokenLinks(in: targetDir, under: source)
    }
    return actions
  }

  private func itemNames(for selection: Selection, in source: String) throws -> [String] {
    switch selection {
    case .all:
      guard let entries = try? fm.contentsOfDirectory(atPath: source) else {
        throw PlannerError.sourceUnreadable(source)
      }
      return entries.filter { !$0.hasPrefix(".") }.sorted()
    case .items(let items):
      return items
    }
  }

  private func action(for name: String, source: String, targetDir: String) -> PlannedAction {
    let sourcePath = (source as NSString).appendingPathComponent(name)
    let targetPath = (targetDir as NSString).appendingPathComponent(name)
    let kind: ActionKind
    if fm.entryKind(atPath: sourcePath) == .missing {
      kind = .sourceMissing
    } else {
      switch fm.entryKind(atPath: targetPath) {
      case .missing:
        kind = .create
      case .symlink(let destination) where destination == sourcePath:
        kind = .alreadyLinked
      default:
        kind = .conflict
      }
    }
    return PlannedAction(
      kind: kind,
      itemName: name,
      sourcePath: URL(fileURLWithPath: sourcePath),
      targetPath: URL(fileURLWithPath: targetPath),
      target: URL(fileURLWithPath: targetDir)
    )
  }

  /// 目标目录里指向 source/ 之下、但源已不存在的软链。
  private func brokenLinks(in targetDir: String, under source: String) -> [PlannedAction] {
    guard let entries = try? fm.contentsOfDirectory(atPath: targetDir) else { return [] }
    let prefix = source + "/"
    return entries.sorted().compactMap { name in
      let path = (targetDir as NSString).appendingPathComponent(name)
      guard case .symlink(let destination) = fm.entryKind(atPath: path),
        destination.hasPrefix(prefix),
        !fm.fileExists(atPath: destination)
      else { return nil }
      return PlannedAction(
        kind: .brokenLink,
        itemName: name,
        sourcePath: URL(fileURLWithPath: destination),
        targetPath: URL(fileURLWithPath: path),
        target: URL(fileURLWithPath: targetDir)
      )
    }
  }
}
